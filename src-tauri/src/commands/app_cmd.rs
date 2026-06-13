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
pub async fn get_model_storage_summary(app: AppHandle, payload: Value) -> AppResult<Value> {
    run_worker_with_payload(&app, "model_storage_summary", Some(payload))
}

#[tauri::command]
pub async fn cleanup_model_residual_files(app: AppHandle, payload: Value) -> AppResult<Value> {
    run_worker_with_payload(&app, "cleanup_model_residual_files", Some(payload))
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

fn safe_asset_file_name(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let trimmed = sanitized.trim().trim_matches('.').trim_matches('_');
    if trimmed.is_empty() {
        "audio".to_string()
    } else {
        trimmed.chars().take(180).collect()
    }
}

fn editor_project_dir(app: &AppHandle, project_id: &str) -> AppResult<PathBuf> {
    Ok(editor_projects_root(app)?.join(safe_file_name(project_id)))
}

fn editor_project_path(app: &AppHandle, project_id: &str) -> AppResult<PathBuf> {
    Ok(editor_project_dir(app, project_id)?.join("project.json"))
}

fn editor_project_assets_dir(app: &AppHandle, project_id: &str) -> AppResult<PathBuf> {
    Ok(editor_project_dir(app, project_id)?.join("assets"))
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

fn unique_path_for_file(dir: &Path, file_name: &str) -> PathBuf {
    let fallback_name = safe_asset_file_name(file_name);
    let fallback = if fallback_name.is_empty() {
        "audio".to_string()
    } else {
        fallback_name
    };
    let original = Path::new(&fallback);
    let stem = original
        .file_stem()
        .and_then(|value| value.to_str())
        .map(str::to_string)
        .unwrap_or_else(|| "audio".to_string());
    let extension = original
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_string);

    let mut candidate = dir.join(&fallback);
    let mut index = 1usize;
    while candidate.exists() {
        let name = match &extension {
            Some(ext) if !ext.is_empty() => format!("{stem}_{index}.{ext}"),
            _ => format!("{stem}_{index}"),
        };
        candidate = dir.join(name);
        index += 1;
    }
    candidate
}

fn import_audio_file_to_project(
    app: &AppHandle,
    project_id: &str,
    source_path: &Path,
    relative_path: Option<&Path>,
) -> AppResult<PathBuf> {
    if !source_path.is_file() {
        return Err(AppError::Worker(format!(
            "asset is not a file: {}",
            source_path.display()
        )));
    }

    let assets_dir = editor_project_assets_dir(app, project_id)?;
    std::fs::create_dir_all(&assets_dir)?;

    if let (Ok(source_canon), Ok(assets_canon)) =
        (source_path.canonicalize(), assets_dir.canonicalize())
    {
        if source_canon.starts_with(&assets_canon) {
            return Ok(source_path.to_path_buf());
        }
    }

    let destination = if let Some(relative) = relative_path {
        let safe_parts: Vec<String> = relative
            .components()
            .filter_map(|component| match component {
                std::path::Component::Normal(value) => value.to_str().map(safe_asset_file_name),
                _ => None,
            })
            .filter(|part| !part.is_empty())
            .collect();
        if safe_parts.is_empty() {
            unique_path_for_file(
                &assets_dir,
                &file_name_from_path(&source_path.to_string_lossy()),
            )
        } else {
            let mut target_dir = assets_dir.clone();
            for part in safe_parts.iter().take(safe_parts.len().saturating_sub(1)) {
                target_dir = target_dir.join(part);
            }
            std::fs::create_dir_all(&target_dir)?;
            unique_path_for_file(&target_dir, safe_parts.last().unwrap())
        }
    } else {
        unique_path_for_file(
            &assets_dir,
            &file_name_from_path(&source_path.to_string_lossy()),
        )
    };

    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::copy(source_path, &destination)?;
    Ok(destination)
}

fn migrate_editor_project_asset_paths(app: &AppHandle, project: &mut Value) -> AppResult<bool> {
    let Some(project_id) = project
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        return Ok(false);
    };

    let assets_dir = editor_project_assets_dir(app, &project_id)?;
    std::fs::create_dir_all(&assets_dir)?;
    let assets_canon = assets_dir.canonicalize().ok();

    let mut changed = false;
    let Some(sources) = project.get_mut("sources").and_then(Value::as_array_mut) else {
        return Ok(false);
    };

    for source in sources.iter_mut() {
        let Some(path_value) = source.get_mut("path") else {
            continue;
        };
        let Some(raw_path) = path_value.as_str() else {
            continue;
        };

        let source_path = PathBuf::from(raw_path);
        if !source_path.is_file() {
            continue;
        }

        let already_in_assets = match (&assets_canon, source_path.canonicalize().ok()) {
            (Some(assets), Some(source_canon)) => source_canon.starts_with(assets),
            _ => false,
        };
        if already_in_assets {
            continue;
        }

        let imported = import_audio_file_to_project(app, &project_id, &source_path, None)?;
        *path_value = Value::String(imported.to_string_lossy().to_string());
        changed = true;
    }

    Ok(changed)
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
        .decorations(false)
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
    let mut imported_paths: Vec<(String, String)> = Vec::with_capacity(paths.len());
    for (stem, path) in paths {
        let imported_path = {
            let source_path = PathBuf::from(&path);
            if source_path.is_file() {
                import_audio_file_to_project(&app, &project_id, &source_path, None)?
                    .to_string_lossy()
                    .to_string()
            } else {
                path.clone()
            }
        };
        imported_paths.push((stem, imported_path));
    }

    let sources: Vec<Value> = imported_paths
        .iter()
        .enumerate()
        .map(|(index, (stem, path))| {
            serde_json::json!({
                "id": format!("source_{}_{}", index, safe_file_name(stem)),
                "role": "stem",
                "stemKey": stem,
                "path": path,
                "name": file_name_from_path(path),
                "duration": 0,
                "sampleRate": 0,
                "channels": 0,
                "peaksPath": Value::Null,
                "peaks": [],
            })
        })
        .collect();
    let tracks: Vec<Value> = imported_paths
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
    app: AppHandle,
    project_id: String,
    paths: Vec<String>,
) -> AppResult<Vec<String>> {
    let assets_dir = editor_project_assets_dir(&app, &project_id)?;
    std::fs::create_dir_all(&assets_dir)?;

    let mut imported = Vec::new();
    for raw in paths {
        let target = PathBuf::from(&raw);
        if target.is_file() {
            if is_audio_file(&target) {
                imported.push(
                    import_audio_file_to_project(&app, &project_id, &target, None)?
                        .to_string_lossy()
                        .to_string(),
                );
            }
            continue;
        }

        if target.is_dir() {
            let scanned = scan_audio_paths(vec![raw.clone()]).await?;
            for file in scanned.files {
                let file_path = PathBuf::from(&file);
                let relative = file_path.strip_prefix(&target).ok();
                imported.push(
                    import_audio_file_to_project(&app, &project_id, &file_path, relative)?
                        .to_string_lossy()
                        .to_string(),
                );
            }
        }
    }
    imported.sort();
    imported.dedup();
    Ok(imported)
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
    if migrate_editor_project_asset_paths(&app, &mut project)? {
        write_editor_project(&app, &project)?;
    }
    Ok(project)
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
        if let Ok(mut child) = child.lock() {
            let _ = child.kill();
        }
        let _ = app.emit(
            "pymss://worker-event",
            serde_json::json!({
                "type": "task_cancelled",
                "taskId": task_id,
                "payload": { "message": "Cancelled" }
            }),
        );
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
