use crate::error::{AppError, AppResult};
use crate::model_dir_migration::{
    self, CancelModelDirMigrationRequest, ConfirmModelDirMigrationSwitchRequest,
    PrepareModelDirChangeRequest, RespondModelDirMigrationConflictRequest,
    StartModelDirMigrationRequest,
};
use crate::python::worker::{run_worker_once, run_worker_with_payload, spawn_worker_background};
use crate::state::AppState;
use crate::storage;
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
fn kill_process_tree(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(0x08000000)
        .status();
}

#[cfg(not(windows))]
fn kill_process_tree(pid: u32) {
    let _ = Command::new("pkill")
        .args(["-TERM", "-P", &pid.to_string()])
        .status();
}

#[tauri::command]
pub async fn worker_health(app: AppHandle) -> AppResult<Value> {
    run_worker_once(&app, "health")
}

#[tauri::command]
pub async fn get_env_info(app: AppHandle) -> AppResult<Value> {
    run_worker_once(&app, "env_info")
}

#[tauri::command]
pub async fn start_env_check(app: AppHandle) -> AppResult<Value> {
    let handle = app.clone();
    std::thread::spawn(move || {
        let result = run_worker_once(&handle, "env_info");
        match result {
            Ok(payload) => {
                let _ = handle.emit(
                    "pymss://worker-event",
                    serde_json::json!({
                        "type": "env_info",
                        "requestId": Value::Null,
                        "taskId": Value::Null,
                        "timestamp": Value::Null,
                        "payload": payload,
                    }),
                );
            }
            Err(error) => {
                let _ = handle.emit(
                    "pymss://worker-event",
                    serde_json::json!({
                        "type": "error",
                        "requestId": Value::Null,
                        "taskId": Value::Null,
                        "timestamp": Value::Null,
                        "payload": {
                            "code": "ENV_CHECK_FAILED",
                            "message": error.to_string(),
                            "recoverable": true,
                        },
                    }),
                );
            }
        }
    });

    Ok(serde_json::json!({ "started": true }))
}

#[tauri::command]
pub async fn list_models(app: AppHandle, payload: Option<Value>) -> AppResult<Value> {
    run_worker_with_payload(&app, "list_models", payload)
}

#[tauri::command]
pub async fn get_model_info(app: AppHandle, payload: Value) -> AppResult<Value> {
    run_worker_with_payload(&app, "model_info", Some(payload))
}

#[tauri::command]
pub async fn delete_model(app: AppHandle, payload: Value) -> AppResult<Value> {
    run_worker_with_payload(&app, "delete_model", Some(payload))
}

#[tauri::command]
pub async fn start_model_delete(
    app: AppHandle,
    state: State<'_, AppState>,
    payload: Value,
) -> AppResult<Value> {
    let model = payload
        .get("model")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Worker("missing model".into()))?;
    let task_id = payload
        .get("taskId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| {
            format!(
                "delete_{}_{}",
                model.replace(|c: char| !c.is_ascii_alphanumeric(), "_"),
                chrono_like_timestamp()
            )
        });
    let mut payload = payload;
    if let Some(object) = payload.as_object_mut() {
        object.insert("taskId".to_string(), Value::String(task_id.clone()));
    }
    spawn_worker_background(app, state, "delete_model", task_id.clone(), payload)?;
    Ok(serde_json::json!({ "taskId": task_id, "started": true }))
}

#[tauri::command]
pub async fn get_model_storage_summary(app: AppHandle, payload: Value) -> AppResult<Value> {
    run_worker_with_payload(&app, "model_storage_summary", Some(payload))
}

#[tauri::command]
pub async fn cleanup_model_residual_files(app: AppHandle, payload: Value) -> AppResult<Value> {
    run_worker_with_payload(&app, "cleanup_model_residual_files", Some(payload))
}

#[tauri::command]
pub async fn start_cleanup_model_residual_files(
    app: AppHandle,
    state: State<'_, AppState>,
    payload: Value,
) -> AppResult<Value> {
    let task_id = payload
        .get("taskId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("cleanup_residual_{}", chrono_like_timestamp()));
    let mut payload = payload;
    if let Some(object) = payload.as_object_mut() {
        object.insert("taskId".to_string(), Value::String(task_id.clone()));
    }
    spawn_worker_background(
        app,
        state,
        "cleanup_model_residual_files",
        task_id.clone(),
        payload,
    )?;
    Ok(serde_json::json!({ "taskId": task_id, "started": true }))
}

#[tauri::command]
pub async fn download_model(app: AppHandle, payload: Value) -> AppResult<Value> {
    run_worker_with_payload(&app, "download_model", Some(payload))
}

#[tauri::command]
pub async fn start_model_download(
    app: AppHandle,
    state: State<'_, AppState>,
    payload: Value,
) -> AppResult<Value> {
    let model = payload
        .get("model")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Worker("missing model".into()))?;
    let task_id = payload
        .get("taskId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| {
            format!(
                "download_{}_{}",
                model.replace(|c: char| !c.is_ascii_alphanumeric(), "_"),
                chrono_like_timestamp()
            )
        });
    let mut payload = payload;
    if let Some(object) = payload.as_object_mut() {
        object.insert("taskId".to_string(), Value::String(task_id.clone()));
    }
    spawn_worker_background(app, state, "download_model", task_id.clone(), payload)?;
    Ok(serde_json::json!({ "taskId": task_id, "started": true }))
}

fn chrono_like_timestamp() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or_default()
}

#[tauri::command]
pub async fn start_separation(
    app: AppHandle,
    state: State<'_, AppState>,
    payload: Value,
) -> AppResult<Value> {
    let task_id = payload
        .get("taskId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Worker("missing taskId".into()))?
        .to_string();
    spawn_worker_background(app, state, "infer", task_id.clone(), payload)?;
    Ok(serde_json::json!({ "taskId": task_id, "started": true }))
}

#[tauri::command]
pub async fn start_workflow_inference(
    app: AppHandle,
    state: State<'_, AppState>,
    payload: Value,
) -> AppResult<Value> {
    let task_id = payload
        .get("taskId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Worker("missing taskId".into()))?
        .to_string();
    spawn_worker_background(app, state, "infer_workflow", task_id.clone(), payload)?;
    Ok(serde_json::json!({ "taskId": task_id, "started": true }))
}

#[tauri::command]
pub async fn get_app_paths(app: AppHandle) -> AppResult<storage::AppPathsPayload> {
    storage::app_paths_payload(&app)
}

#[tauri::command]
pub async fn load_app_store(app: AppHandle, name: String) -> AppResult<Value> {
    storage::read_app_store(&app, &name)
}

#[tauri::command]
pub async fn save_app_store(app: AppHandle, name: String, data: Value) -> AppResult<()> {
    storage::write_app_store(&app, &name, &data)
}

fn editor_projects_root(app: &AppHandle) -> AppResult<PathBuf> {
    storage::editor_projects_dir(app)
}

fn safe_file_name(value: &str) -> String {
    let name: String = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = name.trim_matches('_');
    if trimmed.is_empty() {
        "project".to_string()
    } else {
        trimmed.chars().take(96).collect()
    }
}

fn editor_project_dir(app: &AppHandle, project_id: &str) -> AppResult<PathBuf> {
    Ok(editor_projects_root(app)?.join(safe_file_name(project_id)))
}

fn editor_project_path(app: &AppHandle, project_id: &str) -> AppResult<PathBuf> {
    Ok(editor_project_dir(app, project_id)?.join("project.json"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorProjectSummary {
    id: String,
    name: String,
    source_task_id: Option<String>,
    source_result_dir: Option<String>,
    created_at: u64,
    updated_at: u64,
    #[serde(rename = "type")]
    project_type: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedEditorAsset {
    path: String,
    name: String,
    origin_kind: String,
    origin_root: Option<String>,
    relative_path: Option<String>,
    missing: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportEditorAssetsResult {
    pub files: Vec<LinkedEditorAsset>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelinkEditorSourcesResult {
    pub project: Value,
    pub relinked: usize,
    pub unresolved: Vec<String>,
}

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or_default()
}

fn file_name_from_path(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(path)
        .to_string()
}

fn stem_from_path(path: &str) -> String {
    if let Some(stem) = Path::new(path).file_stem().and_then(|value| value.to_str()) {
        stem.to_string()
    } else {
        file_name_from_path(path)
    }
}

fn summary_from_project_value(project: &Value, fallback_id: &str) -> EditorProjectSummary {
    let id = project
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(fallback_id)
        .to_string();
    let source_task_id = project
        .get("sourceTaskId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.trim().is_empty());
    let source_result_dir = project
        .get("sourceResultDir")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.trim().is_empty());
    let project_type = if source_task_id.is_some() || source_result_dir.is_some() {
        "task"
    } else {
        "blank"
    }
    .to_string();

    EditorProjectSummary {
        id: id.clone(),
        name: project
            .get("name")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("Untitled Project")
            .to_string(),
        source_task_id,
        source_result_dir,
        created_at: project
            .get("createdAt")
            .and_then(Value::as_u64)
            .unwrap_or_default(),
        updated_at: project
            .get("updatedAt")
            .and_then(Value::as_u64)
            .unwrap_or_default(),
        project_type,
    }
}

fn stem_rank(stem: &str) -> usize {
    let lower = stem.to_ascii_lowercase();
    if lower.contains("vocal") || lower.contains("voice") {
        0
    } else if lower.contains("instrument")
        || lower.contains("accompaniment")
        || lower.contains("karaoke")
    {
        1
    } else if lower.contains("drum") {
        2
    } else if lower.contains("bass") {
        3
    } else if lower.contains("other") {
        4
    } else {
        9
    }
}

fn display_stem_name(stem: &str) -> String {
    let lower = stem.to_ascii_lowercase();
    if lower.contains("vocal") || lower.contains("voice") {
        "人声".to_string()
    } else if lower.contains("instrument")
        || lower.contains("accompaniment")
        || lower.contains("karaoke")
    {
        "伴奏".to_string()
    } else if lower.contains("drum") {
        "鼓组".to_string()
    } else if lower.contains("bass") {
        "贝斯".to_string()
    } else if lower.contains("other") {
        "其他".to_string()
    } else {
        stem.to_string()
    }
}

fn write_editor_project(app: &AppHandle, project: &Value) -> AppResult<Value> {
    let project_id = project
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Worker("missing editor project id".into()))?;
    let dir = editor_project_dir(app, project_id)?;
    std::fs::create_dir_all(&dir)?;
    std::fs::write(
        dir.join("project.json"),
        serde_json::to_string_pretty(project)?,
    )?;
    Ok(project.clone())
}


#[tauri::command]
pub async fn close_current_window(window: tauri::WebviewWindow) -> AppResult<()> {
    let label = window.label().to_string();
    if label.starts_with("workflow-node-editor") {
        let _ = window.app_handle().emit(
            "pymss://workflow-node-editor-closed",
            serde_json::json!({ "label": label }),
        );
    }
    window.destroy().map_err(|error| AppError::Worker(error.to_string()))
}

#[tauri::command]
pub async fn minimize_current_window(window: tauri::WebviewWindow) -> AppResult<()> {
    window
        .minimize()
        .map_err(|error| AppError::Worker(error.to_string()))
}

#[tauri::command]
pub async fn toggle_maximize_current_window(window: tauri::WebviewWindow) -> AppResult<bool> {
    let maximized = window
        .is_maximized()
        .map_err(|error| AppError::Worker(error.to_string()))?;
    if maximized {
        window
            .unmaximize()
            .map_err(|error| AppError::Worker(error.to_string()))?;
        Ok(false)
    } else {
        window
            .maximize()
            .map_err(|error| AppError::Worker(error.to_string()))?;
        Ok(true)
    }
}

#[tauri::command]
pub async fn is_current_window_maximized(window: tauri::WebviewWindow) -> AppResult<bool> {
    window
        .is_maximized()
        .map_err(|error| AppError::Worker(error.to_string()))
}

#[tauri::command]
pub async fn start_drag_current_window(window: tauri::WebviewWindow) -> AppResult<()> {
    window
        .start_dragging()
        .map_err(|error| AppError::Worker(error.to_string()))
}

#[tauri::command]
pub async fn open_workflow_node_editor_window(app: AppHandle, payload: Value) -> AppResult<Value> {
    let workflow_id = payload
        .get("workflowId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let new_workflow = payload
        .get("newWorkflow")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let label = if workflow_id.trim().is_empty() {
        "workflow-node-editor-new".to_string()
    } else {
        format!("workflow-node-editor-{}", safe_file_name(&workflow_id))
    };
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.set_focus();
        return Ok(
            serde_json::json!({ "workflowId": workflow_id, "label": label, "opened": true, "reused": true }),
        );
    }

    let url = if workflow_id.trim().is_empty() {
        if new_workflow {
            "index.html#/workflow-node-editor?new=1".to_string()
        } else {
            "index.html#/workflow-node-editor".to_string()
        }
    } else {
        format!("index.html#/workflow-node-editor?workflowId={}", workflow_id)
    };
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title("Pymss Studio Workflow Node Editor")
        .inner_size(1440.0, 900.0)
        .min_inner_size(1180.0, 720.0)
        .resizable(true)
        .minimizable(true)
        .maximizable(true)
        .closable(true)
        .decorations(cfg!(target_os = "macos"))
        .visible(false)
        .focused(true)
        .on_page_load(|window, payload| {
            if payload.event() == PageLoadEvent::Finished {
                let _ = window.show();
                let _ = window.set_focus();
            }
        })
        .build()
        .map_err(|error| AppError::Worker(error.to_string()))?;
    Ok(
        serde_json::json!({ "workflowId": workflow_id, "label": label, "opened": true, "reused": false }),
    )
}

#[tauri::command]
pub async fn open_editor_window(app: AppHandle, payload: Value) -> AppResult<Value> {
    let project_id = payload
        .get("projectId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Worker("missing projectId".into()))?
        .to_string();
    let label = format!("editor-{}", safe_file_name(&project_id));
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.emit(
            "pymss://editor-open-project",
            serde_json::json!({ "projectId": project_id, "label": label }),
        );
        let _ = window.set_focus();
        return Ok(
            serde_json::json!({ "projectId": project_id, "label": label, "opened": true, "reused": true }),
        );
    }

    let url = format!(
        "index.html#/editor?projectId={}&windowLabel={}",
        project_id, label
    );
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title("Pymss Studio Editor")
        .inner_size(1440.0, 900.0)
        .min_inner_size(1180.0, 720.0)
        .resizable(true)
        .minimizable(true)
        .maximizable(true)
        .closable(true)
        .decorations(cfg!(target_os = "macos"))
        .visible(false)
        .focused(true)
        .on_page_load(|window, payload| {
            if payload.event() == PageLoadEvent::Finished {
                let _ = window.show();
                let _ = window.set_focus();
            }
        })
        .build()
        .map_err(|error| AppError::Worker(error.to_string()))?;
    Ok(
        serde_json::json!({ "projectId": project_id, "label": label, "opened": true, "reused": false }),
    )
}

#[tauri::command]
pub async fn create_editor_project_from_task(app: AppHandle, payload: Value) -> AppResult<Value> {
    let task_id = payload
        .get("taskId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Worker("missing taskId".into()))?;

    let input = payload
        .get("input")
        .and_then(Value::as_str)
        .unwrap_or("Untitled");
    let output_dir = payload
        .get("outputDir")
        .and_then(Value::as_str)
        .unwrap_or("");
    let outputs = payload
        .get("outputs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut paths: Vec<(String, String)> = outputs
        .iter()
        .filter_map(|item| {
            let path = item.get("path").and_then(Value::as_str)?;
            let stem = item
                .get("stem")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| stem_from_path(path));
            Some((stem, path.to_string()))
        })
        .collect();

    if paths.is_empty() && !output_dir.is_empty() {
        let scanned = scan_audio_paths(vec![output_dir.to_string()]).await?;
        paths = scanned
            .files
            .into_iter()
            .map(|path| (stem_from_path(&path), path))
            .collect();
    }
    paths.sort_by(|a, b| {
        stem_rank(&a.0)
            .cmp(&stem_rank(&b.0))
            .then_with(|| a.0.cmp(&b.0))
    });

    let project_id = format!("edit_{}", safe_file_name(task_id));
    let timestamp = now_millis();
    let output_root = if output_dir.trim().is_empty() {
        None
    } else {
        Some(PathBuf::from(output_dir))
    };

    let linked_paths: Vec<(String, LinkedEditorAsset)> = paths
        .into_iter()
        .map(|(stem, path)| {
            let source_path = PathBuf::from(&path);
            let relative = output_root
                .as_ref()
                .and_then(|root| source_path.strip_prefix(root).ok());
            (
                stem,
                linked_asset_from_path(
                    &source_path,
                    "task-result",
                    output_root.as_deref(),
                    relative,
                ),
            )
        })
        .collect();

    let sources: Vec<Value> = linked_paths
        .iter()
        .enumerate()
        .map(|(index, (stem, asset))| {
            serde_json::json!({
                "id": format!("source_{}_{}", index, safe_file_name(stem)),
                "role": "stem",
                "stemKey": stem,
                "path": asset.path,
                "name": asset.name,
                "duration": 0,
                "sampleRate": 0,
                "channels": 0,
                "peaksPath": Value::Null,
                "peaks": [],
                "originKind": asset.origin_kind,
                "originRoot": asset.origin_root,
                "relativePath": asset.relative_path,
                "missing": asset.missing,
            })
        })
        .collect();
    let tracks: Vec<Value> = linked_paths
        .iter()
        .enumerate()
        .map(|(index, (stem, _))| {
            serde_json::json!({
                "id": format!("track_{}", index),
                "sourceId": format!("source_{}_{}", index, safe_file_name(stem)),
                "role": "stem",
                "name": display_stem_name(stem),
                "color": Value::Null,
                "volume": 1,
                "muted": false,
                "solo": false,
                "fadeIn": 0,
                "fadeOut": 0
            })
        })
        .collect();

    let project = serde_json::json!({
        "version": 2,
        "id": project_id,
        "name": file_name_from_path(input),
        "sourceTaskId": task_id,
        "sourceResultDir": output_dir,
        "masterVolume": 1,
        "sources": sources,
        "tracks": tracks,
        "createdAt": timestamp,
        "updatedAt": timestamp
    });
    write_editor_project(&app, &project)
}

#[tauri::command]
pub async fn list_editor_projects(app: AppHandle) -> AppResult<Vec<EditorProjectSummary>> {
    let root = editor_projects_root(&app)?;
    std::fs::create_dir_all(&root)?;

    let mut items = Vec::new();
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }

        let fallback_id = entry.file_name().to_string_lossy().to_string();
        let project_path = entry.path().join("project.json");
        if !project_path.is_file() {
            continue;
        }

        let content = match std::fs::read_to_string(&project_path) {
            Ok(content) => content,
            Err(_) => continue,
        };
        let project: Value = match serde_json::from_str(&content) {
            Ok(project) => project,
            Err(_) => continue,
        };
        items.push(summary_from_project_value(&project, &fallback_id));
    }

    items.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| b.created_at.cmp(&a.created_at))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(items)
}

#[tauri::command]
pub async fn create_blank_editor_project(app: AppHandle, payload: Value) -> AppResult<Value> {
    let custom_name = payload
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let locale = payload
        .get("locale")
        .and_then(Value::as_str)
        .unwrap_or("zh-CN");
    let default_name = if locale == "en" {
        "Untitled Blank Project"
    } else {
        "未命名空工程"
    };
    let timestamp = now_millis() as u64;
    let project_id = format!("edit_blank_{}", timestamp);
    let project = serde_json::json!({
        "version": 2,
        "id": project_id,
        "name": custom_name.unwrap_or(default_name),
        "masterVolume": 1,
        "sources": [],
        "tracks": [],
        "createdAt": timestamp,
        "updatedAt": timestamp
    });
    write_editor_project(&app, &project)
}

#[tauri::command]
pub async fn delete_editor_project(app: AppHandle, project_id: String) -> AppResult<bool> {
    let label = format!("editor-{}", safe_file_name(&project_id));
    if app.get_webview_window(&label).is_some() {
        return Err(AppError::Worker("请先关闭该工程窗口后再删除".into()));
    }

    let project_dir = editor_project_dir(&app, &project_id)?;
    if !project_dir.exists() {
        return Ok(false);
    }

    std::fs::remove_dir_all(project_dir)?;
    Ok(true)
}

#[tauri::command]
pub async fn scan_editor_assets(paths: Vec<String>) -> AppResult<ScanAudioPathsResult> {
    scan_audio_paths(paths).await
}

#[tauri::command]
pub async fn import_editor_assets(
    _app: AppHandle,
    _project_id: String,
    paths: Vec<String>,
) -> AppResult<ImportEditorAssetsResult> {
    let mut imported = Vec::new();
    let mut warnings = Vec::new();
    for raw in paths {
        let target = PathBuf::from(&raw);
        if target.is_file() {
            if is_audio_file(&target) {
                let origin_root = target.parent().map(PathBuf::from);
                imported.push(linked_asset_from_path(
                    &target,
                    "external",
                    origin_root.as_deref(),
                    target.file_name().map(Path::new),
                ));
            } else {
                warnings.push(format!("unsupported file: {}", target.display()));
            }
            continue;
        }

        if target.is_dir() {
            let scanned = scan_audio_paths(vec![raw.clone()]).await?;
            warnings.extend(scanned.warnings);
            for file in scanned.files {
                let file_path = PathBuf::from(&file);
                let relative = file_path.strip_prefix(&target).ok();
                imported.push(linked_asset_from_path(
                    &file_path,
                    "external",
                    Some(target.as_path()),
                    relative,
                ));
            }
            continue;
        }

        warnings.push(format!("path not found: {}", raw));
    }
    imported.sort_by(|a, b| normalize_path_key(&a.path).cmp(&normalize_path_key(&b.path)));
    imported.dedup_by(|a, b| normalize_path_key(&a.path) == normalize_path_key(&b.path));
    Ok(ImportEditorAssetsResult { files: imported, warnings })
}

#[tauri::command]
pub async fn get_audio_metadata(app: AppHandle, payload: Value) -> AppResult<Value> {
    run_worker_with_payload(&app, "audio_metadata", Some(payload))
}

#[tauri::command]
pub async fn generate_waveform_peaks(app: AppHandle, payload: Value) -> AppResult<Value> {
    let mut payload = payload;
    if let Some(object) = payload.as_object_mut() {
        if !object.contains_key("cacheDir") {
            let project_id = object
                .get("projectId")
                .and_then(Value::as_str)
                .unwrap_or("shared");
            let cache_dir = editor_project_dir(&app, project_id)?.join("peaks");
            std::fs::create_dir_all(&cache_dir)?;
            object.insert(
                "cacheDir".into(),
                Value::String(cache_dir.to_string_lossy().to_string()),
            );
        }
    }
    run_worker_with_payload(&app, "waveform_peaks", Some(payload))
}

#[tauri::command]
pub async fn save_editor_project(app: AppHandle, project: Value) -> AppResult<Value> {
    let mut project = project;
    if let Some(object) = project.as_object_mut() {
        object.insert("updatedAt".into(), Value::from(now_millis() as u64));
    }
    write_editor_project(&app, &project)
}

#[tauri::command]
pub async fn load_editor_project(app: AppHandle, project_id: String) -> AppResult<Value> {
    let path = editor_project_path(&app, &project_id)?;
    let content = std::fs::read_to_string(path)?;
    let mut project: Value = serde_json::from_str(&content)?;
    if enrich_editor_project_sources(&mut project) {
        write_editor_project(&app, &project)?;
    }
    Ok(project)
}

#[tauri::command]
pub async fn relink_editor_sources(
    app: AppHandle,
    payload: Value,
) -> AppResult<RelinkEditorSourcesResult> {
    let project_id = payload
        .get("projectId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Worker("missing projectId".into()))?;
    let source_id = payload
        .get("sourceId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Worker("missing sourceId".into()))?;
    let picked_path = payload
        .get("pickedPath")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Worker("missing pickedPath".into()))?;

    let path = editor_project_path(&app, project_id)?;
    let content = std::fs::read_to_string(&path)?;
    let mut project: Value = serde_json::from_str(&content)?;
    enrich_editor_project_sources(&mut project);

    let sources = project
        .get_mut("sources")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| AppError::Worker("editor project has no sources".into()))?;
    let anchor_source = sources
        .iter()
        .find(|source| source.get("id").and_then(Value::as_str) == Some(source_id))
        .cloned()
        .ok_or_else(|| AppError::Worker("source not found".into()))?;

    let anchor_relative = anchor_source.get("relativePath").and_then(Value::as_str);
    let picked_path_buf = PathBuf::from(picked_path);
    if !picked_path_buf.is_file() {
        return Err(AppError::Worker("picked relink file does not exist".into()));
    }

    let relink_root = derive_relink_root(&picked_path_buf, anchor_relative)
        .or_else(|| picked_path_buf.parent().map(PathBuf::from))
        .ok_or_else(|| AppError::Worker("failed to resolve relink root".into()))?;
    let file_name_index = build_file_name_index(&relink_root);

    let mut relinked = 0usize;
    let mut unresolved = Vec::new();

    for source in sources.iter_mut() {
        let Some(source_object) = source.as_object_mut() else {
            continue;
        };
        // Only attempt to repoint sources that are actually missing.
        // Healthy sources must keep their existing path/originRoot untouched,
        // otherwise a bulk relink could silently steal them into the relink root.
        if !source_object
            .get("missing")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            continue;
        }
        let relative_path = source_object.get("relativePath").and_then(Value::as_str);
        let fallback_name = source_object
            .get("path")
            .and_then(Value::as_str)
            .and_then(|value| Path::new(value).file_name().and_then(|name| name.to_str()));
        let candidate = build_relink_candidate(&relink_root, relative_path, &file_name_index)
            .or_else(|| {
                let file_name = fallback_name?.to_ascii_lowercase();
                let candidates = file_name_index.get(&file_name)?;
                if candidates.len() == 1 {
                    candidates.first().cloned()
                } else {
                    preferred_match_by_relative_path(candidates, relative_path).cloned()
                }
            });

        let Some(next_path) = candidate else {
            if source_object.get("missing").and_then(Value::as_bool).unwrap_or(false) {
                unresolved.push(
                    source_object
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                );
            }
            continue;
        };

        let next_path_string = path_to_string(&next_path);
        let current_path = source_object
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let current_missing = source_object
            .get("missing")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        if current_path != next_path_string || current_missing {
            source_object.insert("path".into(), Value::String(next_path_string));
            source_object.insert("missing".into(), Value::Bool(false));
            relinked += 1;
        }

        source_object.insert(
            "originRoot".into(),
            Value::String(path_to_string(&relink_root)),
        );

        if source_object
            .get("originKind")
            .and_then(Value::as_str)
            .unwrap_or_default()
            == "legacy"
        {
            source_object.insert("originKind".into(), Value::String("external".into()));
        }

    }

    enrich_editor_project_sources(&mut project);
    let saved = write_editor_project(&app, &project)?;
    Ok(RelinkEditorSourcesResult {
        project: saved,
        relinked,
        unresolved,
    })
}

#[tauri::command]
pub async fn editor_project_exists(app: AppHandle, project_id: String) -> AppResult<bool> {
    let path = editor_project_path(&app, &project_id)?;
    Ok(path.exists())
}

#[tauri::command]
pub async fn export_editor_mix(app: AppHandle, payload: Value) -> AppResult<Value> {
    let mut payload = payload;
    if let Some(object) = payload.as_object_mut() {
        let project_id = object
            .get("project")
            .and_then(|project| project.get("id"))
            .and_then(Value::as_str)
            .unwrap_or("shared");
        if !object.contains_key("exportDir") {
            let export_dir = editor_project_dir(&app, project_id)?.join("exports");
            std::fs::create_dir_all(&export_dir)?;
            object.insert(
                "exportDir".into(),
                Value::String(export_dir.to_string_lossy().to_string()),
            );
        }
    }
    run_worker_with_payload(&app, "export_editor_mix", Some(payload))
}

#[tauri::command]
pub async fn cancel_task(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
) -> AppResult<bool> {
    let child = state
        .tasks
        .lock()
        .ok()
        .and_then(|mut tasks| tasks.remove(&task_id));
    if let Some(child) = child {
        let mut cancelled_task_ids = vec![task_id.clone()];
        if let Ok(mut tasks) = state.tasks.lock() {
            let linked_ids: Vec<String> = tasks
                .iter()
                .filter_map(|(id, registered)| {
                    if std::sync::Arc::ptr_eq(registered, &child) {
                        Some(id.clone())
                    } else {
                        None
                    }
                })
                .collect();
            for id in linked_ids {
                tasks.remove(&id);
                cancelled_task_ids.push(id);
            }
        }
        if let Ok(mut child) = child.lock() {
            let pid = child.id();
            kill_process_tree(pid);
            let _ = child.kill();
        }
        for cancelled_task_id in cancelled_task_ids {
            let _ = app.emit(
                "pymss://worker-event",
                serde_json::json!({
                    "type": "task_cancelled",
                    "taskId": cancelled_task_id,
                    "payload": { "message": "Cancelled" }
                }),
            );
        }
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
pub async fn pick_audio_files(app: AppHandle) -> AppResult<Vec<String>> {
    let files = app
        .dialog()
        .file()
        .add_filter(
            "Audio",
            &["wav", "mp3", "flac", "m4a", "aac", "ogg", "opus"],
        )
        .blocking_pick_files()
        .unwrap_or_default();
    Ok(files.into_iter().map(|p| p.to_string()).collect())
}

#[tauri::command]
pub async fn pick_single_audio_file(app: AppHandle) -> AppResult<Option<String>> {
    Ok(app
        .dialog()
        .file()
        .add_filter(
            "Audio",
            &["wav", "mp3", "flac", "m4a", "aac", "ogg", "opus"],
        )
        .blocking_pick_file()
        .map(|p| p.to_string()))
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn normalize_path_key(value: &str) -> String {
    value.replace('\\', "/").to_ascii_lowercase()
}

fn normalized_relative_path(path: &Path) -> Option<String> {
    let parts: Vec<String> = path
        .components()
        .filter_map(|component| match component {
            std::path::Component::Normal(value) => value.to_str().map(str::to_string),
            _ => None,
        })
        .filter(|part| !part.is_empty())
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

fn relative_path_from_root(root: &Path, target: &Path) -> Option<String> {
    target
        .strip_prefix(root)
        .ok()
        .and_then(normalized_relative_path)
}

fn linked_asset_from_path(
    path: &Path,
    origin_kind: &str,
    origin_root: Option<&Path>,
    relative_path: Option<&Path>,
) -> LinkedEditorAsset {
    let relative = relative_path
        .and_then(normalized_relative_path)
        .or_else(|| origin_root.and_then(|root| relative_path_from_root(root, path)))
        .or_else(|| path.file_name().and_then(|value| value.to_str()).map(str::to_string));
    LinkedEditorAsset {
        path: path_to_string(path),
        name: file_name_from_path(&path_to_string(path)),
        origin_kind: origin_kind.to_string(),
        origin_root: origin_root.map(path_to_string),
        relative_path: relative,
        missing: !path.is_file(),
    }
}

fn detect_editor_source_origin(project: &Value, source: &Value) -> (String, Option<String>, Option<String>) {
    let role = source.get("role").and_then(Value::as_str).unwrap_or("reference");
    let path = source.get("path").and_then(Value::as_str).unwrap_or_default();
    let source_path = PathBuf::from(path);

    let stored_kind = source
        .get("originKind")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.trim().is_empty());
    let stored_root = source
        .get("originRoot")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.trim().is_empty());
    let stored_relative = source
        .get("relativePath")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.trim().is_empty());

    if stored_kind.is_some() || stored_root.is_some() || stored_relative.is_some() {
        return (
            stored_kind.unwrap_or_else(|| if role == "stem" { "task-result" } else { "external" }.to_string()),
            stored_root,
            stored_relative.or_else(|| source_path.file_name().and_then(|value| value.to_str()).map(str::to_string)),
        );
    }

    if role == "stem" {
        if let Some(result_dir) = project
            .get("sourceResultDir")
            .and_then(Value::as_str)
            .map(PathBuf::from)
        {
            let relative = relative_path_from_root(&result_dir, &source_path)
                .or_else(|| source_path.file_name().and_then(|value| value.to_str()).map(str::to_string));
            return ("task-result".to_string(), Some(path_to_string(&result_dir)), relative);
        }
    }

    let parent = source_path.parent().map(path_to_string);
    let relative = source_path.file_name().and_then(|value| value.to_str()).map(str::to_string);
    ("legacy".to_string(), parent, relative)
}

fn enrich_editor_project_sources(project: &mut Value) -> bool {
    let project_snapshot = project.clone();
    let Some(sources) = project.get_mut("sources").and_then(Value::as_array_mut) else {
        return false;
    };

    let mut changed = false;
    for source in sources.iter_mut() {
        let Some(source_object) = source.as_object_mut() else {
            continue;
        };
        let path = source_object
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let source_path = PathBuf::from(&path);
        let missing = !source_path.is_file();
        if source_object.get("missing").and_then(Value::as_bool) != Some(missing) {
            source_object.insert("missing".into(), Value::Bool(missing));
            changed = true;
        }

        let source_value = Value::Object(source_object.clone());
        let (origin_kind, origin_root, relative_path) =
            detect_editor_source_origin(&project_snapshot, &source_value);

        if source_object
            .get("originKind")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .is_empty()
        {
            source_object.insert("originKind".into(), Value::String(origin_kind));
            changed = true;
        }

        if !source_object.contains_key("originRoot") {
            source_object.insert(
                "originRoot".into(),
                origin_root.map(Value::String).unwrap_or(Value::Null),
            );
            changed = true;
        }

        if !source_object.contains_key("relativePath") {
            source_object.insert(
                "relativePath".into(),
                relative_path.map(Value::String).unwrap_or(Value::Null),
            );
            changed = true;
        }
    }

    changed
}

fn source_relative_parts(relative_path: &str) -> Vec<String> {
    relative_path
        .split(['/', '\\'])
        .filter(|part| !part.trim().is_empty())
        .map(str::to_string)
        .collect()
}

fn path_tail_matches(path: &Path, relative_path: &str) -> bool {
    let rel_parts = source_relative_parts(relative_path);
    if rel_parts.is_empty() {
        return false;
    }
    let path_parts: Vec<String> = path
        .components()
        .filter_map(|component| match component {
            std::path::Component::Normal(value) => value.to_str().map(str::to_string),
            _ => None,
        })
        .collect();
    if path_parts.len() < rel_parts.len() {
        return false;
    }
    let tail = &path_parts[path_parts.len() - rel_parts.len()..];
    tail.iter()
        .map(|part| part.to_ascii_lowercase())
        .eq(rel_parts.iter().map(|part| part.to_ascii_lowercase()))
}

fn derive_relink_root(picked_path: &Path, relative_path: Option<&str>) -> Option<PathBuf> {
    let relative_path = relative_path?;
    if !path_tail_matches(picked_path, relative_path) {
        return None;
    }
    let component_count = source_relative_parts(relative_path).len();
    if component_count == 0 {
        return None;
    }
    let mut cursor = picked_path.to_path_buf();
    for _ in 0..component_count {
        cursor = cursor.parent()?.to_path_buf();
    }
    Some(cursor)
}

fn build_file_name_index(root: &Path) -> std::collections::HashMap<String, Vec<PathBuf>> {
    let mut files = Vec::new();
    let mut warnings = Vec::new();
    collect_audio_files(root, &mut files, &mut warnings);
    let mut index = std::collections::HashMap::<String, Vec<PathBuf>>::new();
    for file in files {
        let path = PathBuf::from(&file);
        if let Some(name) = path.file_name().and_then(|value| value.to_str()) {
            index.entry(name.to_ascii_lowercase()).or_default().push(path);
        }
    }
    index
}

fn preferred_match_by_relative_path<'a>(candidates: &'a [PathBuf], relative_path: Option<&str>) -> Option<&'a PathBuf> {
    let relative_path = relative_path?;
    let mut filtered = candidates.iter().filter(|path| path_tail_matches(path, relative_path));
    let first = filtered.next()?;
    if filtered.next().is_some() {
        None
    } else {
        Some(first)
    }
}

fn build_relink_candidate(
    relink_root: &Path,
    relative_path: Option<&str>,
    file_name_index: &std::collections::HashMap<String, Vec<PathBuf>>,
) -> Option<PathBuf> {
    if let Some(relative) = relative_path {
        // Join segment-by-segment so PathBuf inserts the platform separator,
        // instead of hardcoding a Windows backslash.
        let mut direct = relink_root.to_path_buf();
        for part in source_relative_parts(relative) {
            direct.push(part);
        }
        if direct.is_file() {
            return Some(direct);
        }
    }

    let file_name = relative_path
        .and_then(|value| source_relative_parts(value).last().cloned())
        .map(|value| value.to_ascii_lowercase())?;
    let candidates = file_name_index.get(&file_name)?;
    if let Some(preferred) = preferred_match_by_relative_path(candidates, relative_path) {
        return Some(preferred.clone());
    }
    if candidates.len() == 1 {
        return candidates.first().cloned();
    }
    None
}

#[tauri::command]
pub async fn pick_media_files(app: AppHandle) -> AppResult<Vec<String>> {
    let files = app
        .dialog()
        .file()
        .add_filter(
            "Media / 媒体",
            &[
                "wav", "mp3", "flac", "m4a", "aac", "ogg", "opus", "mp4", "mkv", "mov", "avi",
                "webm", "flv",
            ],
        )
        .blocking_pick_files()
        .unwrap_or_default();
    Ok(files.into_iter().map(|p| p.to_string()).collect())
}

#[tauri::command]
pub async fn pick_input_folder(app: AppHandle) -> AppResult<Option<String>> {
    Ok(app
        .dialog()
        .file()
        .blocking_pick_folder()
        .map(|p| p.to_string()))
}

#[tauri::command]
pub async fn pick_output_folder(app: AppHandle) -> AppResult<Option<String>> {
    Ok(app
        .dialog()
        .file()
        .blocking_pick_folder()
        .map(|p| p.to_string()))
}

/// Opens a "Save As" dialog seeded with `default_name` and writes `content` to
/// the chosen path. Returns the saved path, or `None` if the user cancelled.
#[tauri::command]
pub async fn save_text_file_dialog(
    app: AppHandle,
    default_name: String,
    content: String,
) -> AppResult<Option<String>> {
    let mut builder = app.dialog().file();
    if !default_name.trim().is_empty() {
        builder = builder.set_file_name(&default_name);
        if let Some(ext) = std::path::Path::new(&default_name)
            .extension()
            .and_then(|value| value.to_str())
        {
            builder = builder.add_filter(ext.to_uppercase(), &[ext]);
        }
    }
    let Some(path) = builder.blocking_save_file() else {
        return Ok(None);
    };
    let path_string = path.to_string();
    let path_buf = PathBuf::from(&path_string);
    if let Some(parent) = path_buf.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path_buf, content.as_bytes())?;
    Ok(Some(path_string))
}

#[tauri::command]
pub async fn prepare_model_dir_change(
    app: AppHandle,
    payload: PrepareModelDirChangeRequest,
) -> AppResult<model_dir_migration::PrepareModelDirChangePayload> {
    model_dir_migration::prepare_model_dir_change(&app, payload)
}

#[tauri::command]
pub async fn start_model_dir_migration(
    app: AppHandle,
    state: State<'_, AppState>,
    payload: StartModelDirMigrationRequest,
) -> AppResult<Value> {
    model_dir_migration::start_model_dir_migration(app, state, payload)
}

#[tauri::command]
pub async fn respond_model_dir_migration_conflict(
    state: State<'_, AppState>,
    payload: RespondModelDirMigrationConflictRequest,
) -> AppResult<Value> {
    model_dir_migration::respond_model_dir_migration_conflict(state, payload)
}

#[tauri::command]
pub async fn confirm_model_dir_migration_switch(
    app: AppHandle,
    state: State<'_, AppState>,
    payload: ConfirmModelDirMigrationSwitchRequest,
) -> AppResult<Value> {
    model_dir_migration::confirm_model_dir_migration_switch(app, state, payload)
}

#[tauri::command]
pub async fn cancel_model_dir_migration(
    state: State<'_, AppState>,
    payload: CancelModelDirMigrationRequest,
) -> AppResult<Value> {
    model_dir_migration::cancel_model_dir_migration(state, payload)
}

const AUDIO_EXTENSIONS: &[&str] = &["wav", "mp3", "flac", "m4a", "aac", "ogg", "opus"];
const VIDEO_EXTENSIONS: &[&str] = &["mp4", "mkv", "mov", "avi", "webm", "flv"];

#[derive(Debug, Serialize)]
pub struct ScanAudioPathsResult {
    pub files: Vec<String>,
    pub warnings: Vec<String>,
}

fn is_audio_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| AUDIO_EXTENSIONS.contains(&ext.to_lowercase().as_str()))
        .unwrap_or(false)
}

fn is_media_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            let ext = ext.to_lowercase();
            AUDIO_EXTENSIONS.contains(&ext.as_str()) || VIDEO_EXTENSIONS.contains(&ext.as_str())
        })
        .unwrap_or(false)
}

fn collect_audio_files(dir: &Path, results: &mut Vec<String>, warnings: &mut Vec<String>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) => {
            warnings.push(format!("{}: {}", dir.display(), error));
            return;
        }
    };
    for entry in entries {
        match entry {
            Ok(entry) => {
                let path = entry.path();
                if path.is_dir() {
                    collect_audio_files(&path, results, warnings);
                } else if path.is_file() && is_audio_file(&path) {
                    results.push(path.to_string_lossy().to_string());
                }
            }
            Err(error) => warnings.push(format!("{}: {}", dir.display(), error)),
        }
    }
}

fn collect_media_files(dir: &Path, results: &mut Vec<String>, warnings: &mut Vec<String>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) => {
            warnings.push(format!("{}: {}", dir.display(), error));
            return;
        }
    };
    for entry in entries {
        match entry {
            Ok(entry) => {
                let path = entry.path();
                if path.is_dir() {
                    collect_media_files(&path, results, warnings);
                } else if path.is_file() && is_media_file(&path) {
                    results.push(path.to_string_lossy().to_string());
                }
            }
            Err(error) => warnings.push(format!("{}: {}", dir.display(), error)),
        }
    }
}

fn collect_audio_files_shallow(dir: &Path, results: &mut Vec<String>, warnings: &mut Vec<String>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) => {
            warnings.push(format!("{}: {}", dir.display(), error));
            return;
        }
    };
    for entry in entries {
        match entry {
            Ok(entry) => {
                let path = entry.path();
                if path.is_file() && is_audio_file(&path) {
                    results.push(path.to_string_lossy().to_string());
                }
            }
            Err(error) => warnings.push(format!("{}: {}", dir.display(), error)),
        }
    }
}

fn stable_dedup(paths: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut deduped = Vec::with_capacity(paths.len());
    for path in paths {
        if seen.insert(path.clone()) {
            deduped.push(path);
        }
    }
    deduped
}

#[tauri::command]
pub async fn scan_audio_paths(paths: Vec<String>) -> AppResult<ScanAudioPathsResult> {
    let mut files = Vec::new();
    let mut warnings = Vec::new();
    for raw in paths {
        let target = Path::new(&raw);
        if target.is_file() {
            if is_audio_file(target) {
                files.push(target.to_string_lossy().to_string());
            } else {
                warnings.push(format!("unsupported file: {}", target.display()));
            }
        } else if target.is_dir() {
            collect_audio_files(target, &mut files, &mut warnings);
        } else {
            warnings.push(format!("path not found: {}", raw));
        }
    }
    files.sort();
    files.dedup();
    Ok(ScanAudioPathsResult { files, warnings })
}

#[tauri::command]
pub async fn scan_audio_paths_with_options(
    paths: Vec<String>,
    recursive: Option<bool>,
    sort_files: Option<bool>,
) -> AppResult<ScanAudioPathsResult> {
    let recursive = recursive.unwrap_or(true);
    let sort_files = sort_files.unwrap_or(true);
    let mut files = Vec::new();
    let mut warnings = Vec::new();
    for raw in paths {
        let target = Path::new(&raw);
        if target.is_file() {
            if is_audio_file(target) {
                files.push(target.to_string_lossy().to_string());
            } else {
                warnings.push(format!("unsupported file: {}", target.display()));
            }
        } else if target.is_dir() {
            if recursive {
                collect_audio_files(target, &mut files, &mut warnings);
            } else {
                collect_audio_files_shallow(target, &mut files, &mut warnings);
            }
        } else {
            warnings.push(format!("path not found: {}", raw));
        }
    }
    if sort_files {
        files.sort();
        files.dedup();
    } else {
        files = stable_dedup(files);
    }
    Ok(ScanAudioPathsResult { files, warnings })
}

#[tauri::command]
pub async fn scan_media_paths(paths: Vec<String>) -> AppResult<ScanAudioPathsResult> {
    let mut files = Vec::new();
    let mut warnings = Vec::new();
    for raw in paths {
        let target = Path::new(&raw);
        if target.is_file() {
            if is_media_file(target) {
                files.push(target.to_string_lossy().to_string());
            } else {
                warnings.push(format!("unsupported file: {}", target.display()));
            }
        } else if target.is_dir() {
            collect_media_files(target, &mut files, &mut warnings);
        } else {
            warnings.push(format!("path not found: {}", raw));
        }
    }
    files.sort();
    files.dedup();
    Ok(ScanAudioPathsResult { files, warnings })
}

#[tauri::command]
pub async fn list_audio_files(path: String) -> AppResult<Vec<String>> {
    Ok(scan_audio_paths(vec![path]).await?.files)
}

#[tauri::command]
pub async fn reveal_path(path: String) -> AppResult<()> {
    let target = Path::new(&path);
    let reveal_target = if target.is_file() {
        target.parent().unwrap_or(target)
    } else {
        target
    };
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer").arg(reveal_target).spawn()?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg(reveal_target).spawn()?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open").arg(reveal_target).spawn()?;
    }
    Ok(())
}

#[derive(Serialize)]
pub struct TrashResult {
    pub trashed: Vec<String>,
    pub failed: Vec<String>,
}

#[tauri::command]
pub async fn move_paths_to_trash(paths: Vec<String>) -> AppResult<TrashResult> {
    let mut trashed = Vec::new();
    let mut failed = Vec::new();
    for path in paths {
        let target = Path::new(&path);
        // 已不存在的路径视为已删除，无需报错
        if !target.exists() {
            trashed.push(path);
            continue;
        }
        match trash::delete(target) {
            Ok(()) => trashed.push(path),
            Err(_) => failed.push(path),
        }
    }
    Ok(TrashResult { trashed, failed })
}
