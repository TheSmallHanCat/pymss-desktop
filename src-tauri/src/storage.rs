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

fn is_cargo_profile_executable(exe: &Path, target_dir: &Path) -> bool {
    let Some(profile_dir) = exe.parent() else {
        return false;
    };
    let profile = profile_dir.file_name().and_then(|value| value.to_str());
    if !matches!(profile, Some("debug" | "release")) {
        return false;
    }
    let Some(profile_parent) = profile_dir.parent() else {
        return false;
    };
    // Native builds live at target/{debug,release}; cross-compiled artifacts add exactly one
    // target-triple directory. Bundle contents are deeper and must use packaged semantics even
    // while CI is inspecting them in target/**/bundle.
    profile_parent == target_dir || profile_parent.parent() == Some(target_dir)
}

pub fn is_development_executable() -> bool {
    let target_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target");
    std::env::current_exe()
        .ok()
        .and_then(|path| std::fs::canonicalize(path).ok())
        .zip(std::fs::canonicalize(target_dir).ok())
        .map(|(exe, target)| is_cargo_profile_executable(&exe, &target))
        .unwrap_or(false)
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
        is_development_executable(),
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

pub fn runtime_root_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(resource) = app.path().resource_dir() {
        candidates.push(resource.join("python-runtime"));
        candidates.push(resource.join("_up_").join("python-runtime"));
        candidates.push(resource.join("resources").join("python-runtime"));
    }
    let exe_dir = std::env::current_exe()?
        .parent()
        .map(PathBuf::from)
        .ok_or_else(|| AppError::Worker("failed to resolve executable directory".into()))?;
    candidates.push(exe_dir.join("python-runtime"));
    Ok(candidates
        .into_iter()
        .find(|path| path.is_dir())
        .unwrap_or_else(|| exe_dir.join("python-runtime")))
}

pub fn runtime_envs_dir(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(runtime_root_dir(app)?.join("runtime-envs"))
}

pub fn active_runtime_file(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(runtime_envs_dir(app)?.join("active-runtime.json"))
}

/// pymss's registry of imported ("custom") models.
///
/// Kept under `settings/` rather than with the models themselves: the registry stores absolute
/// paths to files that usually live outside the model directory, so it is app state, not model
/// data, and must not be caught up in a model-directory migration.
pub fn user_models_file(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(settings_dir(app)?.join("user_models.json"))
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
        "workflow-state" => Ok("workflows.json"),
        "separate-state" => Ok("separate.json"),
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
    use super::{resolve_data_root, store_file_name};
    use std::path::PathBuf;

    fn path(name: &str) -> PathBuf {
        PathBuf::from(name)
    }

    #[test]
    fn separate_state_has_a_store_file() {
        assert_eq!(store_file_name("separate-state").unwrap(), "separate.json");
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
