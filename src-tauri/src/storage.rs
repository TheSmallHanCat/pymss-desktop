use crate::error::{AppError, AppResult};
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const DATA_ROOT_DIR_NAME: &str = ".pymss-studio";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPathsPayload {
    pub data_root: String,
    pub settings_dir: String,
    pub models_dir: String,
    pub outputs_dir: String,
    pub editor_projects_dir: String,
    pub logs_dir: String,
    pub temp_dir: String,
}

pub fn home_dir(app: &AppHandle) -> AppResult<PathBuf> {
    app.path()
        .home_dir()
        .map_err(|error| AppError::Worker(error.to_string()))
}

pub fn data_root_dir(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(home_dir(app)?.join(DATA_ROOT_DIR_NAME))
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
    Ok(AppPathsPayload {
        data_root: data_root_dir(app)?.to_string_lossy().to_string(),
        settings_dir: settings_dir(app)?.to_string_lossy().to_string(),
        models_dir: models_dir(app)?.to_string_lossy().to_string(),
        outputs_dir: outputs_dir(app)?.to_string_lossy().to_string(),
        editor_projects_dir: editor_projects_dir(app)?.to_string_lossy().to_string(),
        logs_dir: logs_dir(app)?.to_string_lossy().to_string(),
        temp_dir: temp_dir(app)?.to_string_lossy().to_string(),
    })
}

fn store_file_name(name: &str) -> AppResult<&'static str> {
    match name {
        "app-settings" => Ok("app.json"),
        "task-history" => Ok("tasks.json"),
        "model-state" => Ok("model-cache.json"),
        "editor-ui" => Ok("editor-ui.json"),
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
