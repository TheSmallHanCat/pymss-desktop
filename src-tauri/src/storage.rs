use crate::error::{AppError, AppResult};
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const DATA_ROOT_ENV: &str = "PYMSS_STUDIO_DATA_ROOT";
const DATA_ROOT_DIR_NAME: &str = ".pymss-studio";
const LOCAL_DATA_ROOT_DIR_NAME: &str = "data";
#[cfg(windows)]
const PORTABLE_MARKER_FILE_NAME: &str = "pymss-studio.portable";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPathsPayload {
    pub data_root: String,
    pub portable_data_root: String,
    pub data_root_is_portable: bool,
    pub can_migrate_data_root_to_portable: bool,
    pub settings_dir: String,
    pub models_dir: String,
    pub outputs_dir: String,
    pub editor_projects_dir: String,
    pub logs_dir: String,
    pub temp_dir: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataRootMigrationPayload {
    pub previous_data_root: String,
    pub target_data_root: String,
    pub file_count: usize,
    pub total_bytes: u64,
    pub cleanup_failed_paths: Vec<String>,
    pub paths: AppPathsPayload,
}

pub fn home_dir(app: &AppHandle) -> AppResult<PathBuf> {
    app.path()
        .home_dir()
        .map_err(|error| AppError::Worker(error.to_string()))
}

fn legacy_data_root_dir(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(home_dir(app)?.join(DATA_ROOT_DIR_NAME))
}

fn development_data_root_dir() -> AppResult<PathBuf> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let project_root = manifest_dir
        .parent()
        .ok_or_else(|| AppError::Worker("failed to resolve project root".into()))?;
    Ok(project_root.join(LOCAL_DATA_ROOT_DIR_NAME))
}

fn portable_data_root_dir() -> AppResult<Option<PathBuf>> {
    #[cfg(windows)]
    {
        let exe = std::env::current_exe()?;
        let exe_dir = exe
            .parent()
            .ok_or_else(|| AppError::Worker("failed to resolve executable directory".into()))?;
        if exe_dir.join(PORTABLE_MARKER_FILE_NAME).exists() {
            return Ok(Some(exe_dir.join(LOCAL_DATA_ROOT_DIR_NAME)));
        }
    }
    Ok(None)
}

fn resolve_data_root(
    env_root: Option<PathBuf>,
    development_root: PathBuf,
    portable_root: Option<PathBuf>,
    legacy_root: PathBuf,
    is_development: bool,
) -> PathBuf {
    if let Some(root) = env_root {
        return root;
    }
    if is_development {
        return development_root;
    }
    if let Some(root) = portable_root {
        return root;
    }
    legacy_root
}

pub fn data_root_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let env_root = std::env::var_os(DATA_ROOT_ENV)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    Ok(resolve_data_root(
        env_root,
        development_data_root_dir()?,
        portable_data_root_dir()?,
        legacy_data_root_dir(app)?,
        cfg!(debug_assertions),
    ))
}

pub fn settings_dir(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(data_root_dir(app)?.join("settings"))
}

pub fn models_dir(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(data_root_dir(app)?.join("models"))
}

pub fn outputs_dir(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(data_root_dir(app)?.join("outputs"))
}

pub fn editor_projects_dir(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(data_root_dir(app)?.join("editor-projects"))
}

pub fn logs_dir(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(data_root_dir(app)?.join("logs"))
}

pub fn temp_dir(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(data_root_dir(app)?.join("temp"))
}

pub fn ensure_app_directories(app: &AppHandle) -> AppResult<()> {
    for dir in [
        data_root_dir(app)?,
        settings_dir(app)?,
        models_dir(app)?,
        outputs_dir(app)?,
        editor_projects_dir(app)?,
        logs_dir(app)?,
        temp_dir(app)?,
    ] {
        std::fs::create_dir_all(dir)?;
    }
    Ok(())
}

pub fn app_paths_payload(app: &AppHandle) -> AppResult<AppPathsPayload> {
    ensure_app_directories(app)?;
    app_paths_payload_for_root(&data_root_dir(app)?)
}

fn app_paths_payload_for_root(root: &Path) -> AppResult<AppPathsPayload> {
    let portable_root = portable_data_root_dir().ok().flatten();
    let data_root_is_portable = portable_root
        .as_ref()
        .map(|portable| path_eq(root, portable))
        .unwrap_or(false);
    Ok(AppPathsPayload {
        data_root: root.to_string_lossy().to_string(),
        portable_data_root: portable_root
            .as_ref()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_default(),
        data_root_is_portable,
        can_migrate_data_root_to_portable: cfg!(windows) && !data_root_is_portable,
        settings_dir: root.join("settings").to_string_lossy().to_string(),
        models_dir: root.join("models").to_string_lossy().to_string(),
        outputs_dir: root.join("outputs").to_string_lossy().to_string(),
        editor_projects_dir: root.join("editor-projects").to_string_lossy().to_string(),
        logs_dir: root.join("logs").to_string_lossy().to_string(),
        temp_dir: root.join("temp").to_string_lossy().to_string(),
    })
}

fn path_eq(left: &Path, right: &Path) -> bool {
    #[cfg(windows)]
    {
        left.to_string_lossy()
            .replace('/', "\\")
            .eq_ignore_ascii_case(&right.to_string_lossy().replace('/', "\\"))
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

fn display_path(path: &Path) -> String {
    let value = path.to_string_lossy().to_string();
    #[cfg(windows)]
    {
        if let Some(rest) = value.strip_prefix("\\\\?\\UNC\\") {
            return format!("\\\\{}", rest);
        }
        if let Some(rest) = value.strip_prefix("\\\\?\\") {
            return rest.to_string();
        }
    }
    value
}

fn collect_tree_stats(path: &Path) -> AppResult<(usize, u64)> {
    if !path.exists() {
        return Ok((0, 0));
    }
    let mut file_count = 0usize;
    let mut total_bytes = 0u64;
    for entry in std::fs::read_dir(path)? {
        let entry = entry?;
        let child = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            let (nested_count, nested_bytes) = collect_tree_stats(&child)?;
            file_count += nested_count;
            total_bytes = total_bytes.saturating_add(nested_bytes);
        } else if file_type.is_file() || file_type.is_symlink() {
            file_count += 1;
            total_bytes = total_bytes.saturating_add(std::fs::symlink_metadata(&child)?.len());
        }
    }
    Ok((file_count, total_bytes))
}

fn dir_has_entries(path: &Path) -> AppResult<bool> {
    if !path.exists() {
        return Ok(false);
    }
    if !path.is_dir() {
        return Err(AppError::Worker(format!(
            "portable data target is not a directory: {}",
            path.display()
        )));
    }
    Ok(std::fs::read_dir(path)?.next().is_some())
}

fn copy_tree(source: &Path, target: &Path) -> AppResult<()> {
    std::fs::create_dir_all(target)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            copy_tree(&source_path, &target_path)?;
            continue;
        }
        if let Some(parent) = target_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if target_path.exists() {
            let metadata = std::fs::symlink_metadata(&target_path)?;
            if metadata.is_dir() && !metadata.file_type().is_symlink() {
                std::fs::remove_dir_all(&target_path)?;
            } else {
                std::fs::remove_file(&target_path)?;
            }
        }
        std::fs::copy(&source_path, &target_path)?;
    }
    Ok(())
}

fn collect_remaining_paths(path: &Path, results: &mut Vec<String>) {
    if !path.exists() {
        return;
    }
    if path.is_file() {
        results.push(display_path(path));
        return;
    }
    let entries = match std::fs::read_dir(path) {
        Ok(entries) => entries,
        Err(_) => {
            results.push(display_path(path));
            return;
        }
    };
    let start_len = results.len();
    for entry in entries.flatten() {
        let child = entry.path();
        if child.is_dir() {
            collect_remaining_paths(&child, results);
        } else {
            results.push(display_path(&child));
        }
    }
    if results.len() == start_len {
        results.push(display_path(path));
    }
}

fn cleanup_source_tree(source_root: &Path) -> Vec<String> {
    if !source_root.exists() {
        return Vec::new();
    }
    if std::fs::remove_dir_all(source_root).is_ok() {
        return Vec::new();
    }
    let mut remaining = Vec::new();
    collect_remaining_paths(source_root, &mut remaining);
    remaining.sort();
    remaining.dedup();
    remaining
}

pub fn migrate_data_root_to_portable(app: &AppHandle) -> AppResult<DataRootMigrationPayload> {
    let previous_root = data_root_dir(app)?;
    let target_root = portable_data_root_dir()?.ok_or_else(|| {
        AppError::Worker(
            "portable data directory is not available on this platform or configuration".into(),
        )
    })?;
    if path_eq(&previous_root, &target_root) {
        ensure_app_directories(app)?;
        return Ok(DataRootMigrationPayload {
            previous_data_root: display_path(&previous_root),
            target_data_root: display_path(&target_root),
            file_count: 0,
            total_bytes: 0,
            cleanup_failed_paths: Vec::new(),
            paths: app_paths_payload_for_root(&target_root)?,
        });
    }
    if !previous_root.exists() {
        std::fs::create_dir_all(&target_root)?;
        return Ok(DataRootMigrationPayload {
            previous_data_root: display_path(&previous_root),
            target_data_root: display_path(&target_root),
            file_count: 0,
            total_bytes: 0,
            cleanup_failed_paths: Vec::new(),
            paths: app_paths_payload_for_root(&target_root)?,
        });
    }
    if !previous_root.is_dir() {
        return Err(AppError::Worker(format!(
            "data root is not a directory: {}",
            previous_root.display()
        )));
    }
    if dir_has_entries(&target_root)? {
        return Err(AppError::Worker(format!(
            "portable data target is not empty: {}",
            target_root.display()
        )));
    }

    let (file_count, total_bytes) = collect_tree_stats(&previous_root)?;
    copy_tree(&previous_root, &target_root)?;
    let cleanup_failed_paths = cleanup_source_tree(&previous_root);
    Ok(DataRootMigrationPayload {
        previous_data_root: display_path(&previous_root),
        target_data_root: display_path(&target_root),
        file_count,
        total_bytes,
        cleanup_failed_paths,
        paths: app_paths_payload_for_root(&target_root)?,
    })
}

fn store_file_name(name: &str) -> AppResult<&'static str> {
    match name {
        "app-settings" => Ok("app.json"),
        "task-history" => Ok("tasks.json"),
        "model-state" => Ok("model-cache.json"),
        "editor-ui" => Ok("editor-ui.json"),
        "workflow-state" => Ok("workflows.json"),
        _ => Err(AppError::Worker(format!("unknown app store: {name}"))),
    }
}

pub fn app_store_path(app: &AppHandle, name: &str) -> AppResult<PathBuf> {
    Ok(settings_dir(app)?.join(store_file_name(name)?))
}

pub fn read_app_store(app: &AppHandle, name: &str) -> AppResult<Value> {
    ensure_app_directories(app)?;
    let path = app_store_path(app, name)?;
    if !path.is_file() {
        return Ok(Value::Null);
    }
    let content = std::fs::read_to_string(path)?;
    Ok(serde_json::from_str(&content)?)
}

pub fn write_app_store(app: &AppHandle, name: &str, data: &Value) -> AppResult<()> {
    ensure_app_directories(app)?;
    let path = app_store_path(app, name)?;
    write_json_file(&path, data)
}

fn write_json_file(path: &Path, data: &Value) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, serde_json::to_string_pretty(data)?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::resolve_data_root;
    use std::path::PathBuf;

    fn path(name: &str) -> PathBuf {
        PathBuf::from(name)
    }

    #[test]
    fn env_root_has_highest_priority() {
        let root = resolve_data_root(
            Some(path("env-data")),
            path("dev-data"),
            Some(path("portable-data")),
            path("legacy-data"),
            true,
        );

        assert_eq!(root, path("env-data"));
    }

    #[test]
    fn development_uses_project_local_data() {
        let root = resolve_data_root(
            None,
            path("dev-data"),
            Some(path("portable-data")),
            path("legacy-data"),
            true,
        );

        assert_eq!(root, path("dev-data"));
    }

    #[test]
    fn release_portable_uses_portable_data() {
        let root = resolve_data_root(
            None,
            path("dev-data"),
            Some(path("portable-data")),
            path("legacy-data"),
            false,
        );

        assert_eq!(root, path("portable-data"));
    }

    #[test]
    fn release_without_portable_marker_uses_legacy_data() {
        let root = resolve_data_root(None, path("dev-data"), None, path("legacy-data"), false);

        assert_eq!(root, path("legacy-data"));
    }
}
