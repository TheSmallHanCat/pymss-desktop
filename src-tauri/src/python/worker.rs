use crate::error::{AppError, AppResult};
use crate::python::protocol::WorkerEnvelope;
use crate::session_log;
use crate::state::AppState;
use crate::storage;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashSet;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const PYTHON_TERMINAL_LOG_PREFIX: &str = "__PYMSS_STUDIO_TERMINAL_LOG__";

static PAYLOAD_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActiveRuntimeRecord {
    python_path: String,
    source: Option<String>,
}

fn worker_path(app: &AppHandle) -> AppResult<PathBuf> {
    if let Ok(resource) = app.path().resource_dir() {
        let candidates = [
            resource.join("python").join("worker.py"),
            resource.join("_up_").join("python").join("worker.py"),
            resource.join("resources").join("python").join("worker.py"),
            resource.join("worker.py"),
        ];
        for path in candidates {
            if path.exists() {
                return Ok(path);
            }
        }
    }

    let exe_dir = std::env::current_exe()?
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    let portable_worker = exe_dir.join("python").join("worker.py");
    if portable_worker.exists() {
        return Ok(portable_worker);
    }

    if storage::is_development_executable() {
        let path = dev_worker_path();
        if path.exists() {
            return Ok(path);
        }
        // Fallback: try cwd (for backward compatibility)
        let cwd = std::env::current_dir()?;
        Ok(cwd.join("python").join("worker.py"))
    } else {
        Ok(portable_worker)
    }
}

fn dev_workspace_root() -> PathBuf {
    // CARGO_MANIFEST_DIR is set at compile time to pymss-desktop/src-tauri.
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn dev_worker_path() -> PathBuf {
    dev_workspace_root().join("python").join("worker.py")
}

fn embedded_python_path(app: &AppHandle) -> AppResult<Option<PathBuf>> {
    let mut runtime_dirs = Vec::new();
    if let Ok(resource) = app.path().resource_dir() {
        runtime_dirs.push(resource.join("python-runtime"));
        runtime_dirs.push(resource.join("_up_").join("python-runtime"));
        runtime_dirs.push(resource.join("resources").join("python-runtime"));
    }
    let exe_dir = std::env::current_exe()?
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    runtime_dirs.push(exe_dir.join("python-runtime"));

    for runtime in runtime_dirs {
        let candidates = if cfg!(windows) {
            vec![
                runtime.join("python.exe"),
                runtime.join("Scripts").join("python.exe"),
            ]
        } else {
            vec![
                runtime.join("bin").join("python3"),
                runtime.join("bin").join("python"),
            ]
        };
        if let Some(path) = candidates.into_iter().find(|candidate| candidate.is_file()) {
            return Ok(Some(path));
        }
    }
    Ok(None)
}

fn bootstrap_python_path(app: &AppHandle) -> AppResult<String> {
    if let Ok(value) = std::env::var("PYMSS_STUDIO_PYTHON") {
        return Ok(value);
    }
    if let Some(embedded) = embedded_python_path(app)? {
        return Ok(embedded.to_string_lossy().to_string());
    }
    if cfg!(windows) {
        Ok("python".to_string())
    } else {
        Ok("python3".to_string())
    }
}

fn bundled_runtime_envs_dirs(app: &AppHandle) -> AppResult<Vec<PathBuf>> {
    let mut dirs = Vec::new();
    if let Ok(resource) = app.path().resource_dir() {
        dirs.push(resource.join("runtime-envs"));
        dirs.push(resource.join("_up_").join("runtime-envs"));
        dirs.push(resource.join("resources").join("runtime-envs"));
    }
    let exe_dir = std::env::current_exe()?
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    dirs.push(exe_dir.join("runtime-envs"));
    Ok(dirs.into_iter().filter(|dir| dir.is_dir()).collect())
}

fn try_resolve_active_runtime(file: &PathBuf) -> Option<String> {
    resolve_active_runtime_record(file).map(|(python, _source)| python)
}

fn resolve_active_runtime_record(file: &PathBuf) -> Option<(String, Option<String>)> {
    if !file.is_file() {
        return None;
    }
    let content = std::fs::read_to_string(file).ok()?;
    let record: ActiveRuntimeRecord = serde_json::from_str(&content).ok()?;
    let python = PathBuf::from(&record.python_path);
    // Absolute path – check directly
    if python.is_absolute() {
        return python
            .is_file()
            .then(|| (python.to_string_lossy().to_string(), record.source));
    }
    // Relative path – resolve against the directory containing the file
    let parent = file.parent()?;
    let resolved = parent.join(&python);
    resolved
        .is_file()
        .then(|| (resolved.to_string_lossy().to_string(), record.source))
}

fn materialize_bundled_runtime_env_templates(app: &AppHandle) -> AppResult<()> {
    if let Ok(dirs) = bundled_runtime_envs_dirs(app) {
        for envs_dir in dirs {
            if let Err(error) = remove_rocm_offload_arch_launcher(&envs_dir) {
                session_log::append(
                    app,
                    "WARNING",
                    "runtime.rocm_launcher_cleanup",
                    vec![
                        (
                            "path",
                            envs_dir
                                .join("rocm")
                                .join("Scripts")
                                .join("offload-arch.exe")
                                .to_string_lossy()
                                .to_string(),
                        ),
                        ("message", error.to_string()),
                    ],
                );
            }
            let Ok(entries) = std::fs::read_dir(envs_dir) else {
                continue;
            };
            for entry in entries {
                let Ok(entry) = entry else {
                    continue;
                };
                let env_dir = entry.path();
                if env_dir.is_dir() {
                    materialize_windows_venv_template(&env_dir)?;
                }
            }
        }
    }
    Ok(())
}

#[cfg(windows)]
fn materialize_windows_venv_template(env_dir: &PathBuf) -> AppResult<()> {
    let cfg = env_dir.join("pyvenv.cfg");
    if !cfg.is_file() {
        return Ok(());
    }
    let Some(runtime_envs_dir) = env_dir.parent() else {
        return Ok(());
    };
    let Some(package_dir) = runtime_envs_dir.parent() else {
        return Ok(());
    };
    let runtime_dir = package_dir.join("python-runtime");
    let runtime_python = runtime_dir.join("python.exe");
    if !runtime_python.is_file() {
        return Ok(());
    }

    let desired_home = format!("home = {}", runtime_dir.to_string_lossy());
    let desired_executable = format!("executable = {}", runtime_python.to_string_lossy());
    let content = format!(
        "{desired_home}\r\ninclude-system-site-packages = false\r\n{desired_executable}\r\ncommand = {} -m venv {}\r\n",
        runtime_python.to_string_lossy(),
        env_dir.to_string_lossy()
    );
    if std::fs::read_to_string(&cfg)
        .map(|existing| existing == content)
        .unwrap_or(false)
    {
        return Ok(());
    }
    std::fs::write(&cfg, content)?;
    Ok(())
}

#[cfg(windows)]
fn remove_rocm_offload_arch_launcher(runtime_envs_dir: &Path) -> std::io::Result<bool> {
    let launcher = runtime_envs_dir
        .join("rocm")
        .join("Scripts")
        .join("offload-arch.exe");
    if !launcher.is_file() {
        return Ok(false);
    }
    std::fs::remove_file(launcher).map(|()| true)
}

#[cfg(not(windows))]
fn remove_rocm_offload_arch_launcher(_runtime_envs_dir: &Path) -> std::io::Result<bool> {
    Ok(false)
}

#[cfg(not(windows))]
fn materialize_windows_venv_template(_env_dir: &PathBuf) -> AppResult<()> {
    Ok(())
}

fn active_runtime_python_path(app: &AppHandle) -> AppResult<Option<String>> {
    let user_file = storage::active_runtime_file(app)?;
    if let Some(result) = try_resolve_active_runtime(&user_file) {
        return Ok(Some(result));
    }
    for envs_dir in bundled_runtime_envs_dirs(app)? {
        let bundled_file = envs_dir.join("active-runtime.json");
        if let Some(result) = try_resolve_active_runtime(&bundled_file) {
            return Ok(Some(result));
        }
    }
    Ok(None)
}

fn bundled_bin_dirs(app: &AppHandle) -> AppResult<Vec<PathBuf>> {
    let mut dirs = Vec::new();
    if let Ok(resource) = app.path().resource_dir() {
        dirs.push(resource.join("bin"));
        dirs.push(resource.join("_up_").join("bin"));
        dirs.push(resource.join("resources").join("bin"));
    }
    let exe_dir = std::env::current_exe()?
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    dirs.push(exe_dir.join("bin"));
    #[cfg(target_os = "macos")]
    {
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
    }

    Ok(dirs.into_iter().filter(|dir| dir.is_dir()).collect())
}

#[cfg(windows)]
fn rocm_native_tool_dir(runtime_envs_dir: &Path) -> Option<PathBuf> {
    let site_packages = runtime_envs_dir.join("rocm").join("Lib").join("site-packages");
    let entries = std::fs::read_dir(site_packages).ok()?;
    entries
        .flatten()
        .map(|entry| entry.path())
        .find_map(|package_dir| {
            let name = package_dir.file_name()?.to_str()?;
            let tool_dir = package_dir.join("lib").join("llvm").join("bin");
            (name.starts_with("_rocm_sdk_core")
                && tool_dir.join("offload-arch.exe").is_file())
            .then_some(tool_dir)
        })
}

#[cfg(windows)]
fn rocm_native_tool_dirs(app: &AppHandle) -> AppResult<Vec<PathBuf>> {
    Ok(bundled_runtime_envs_dirs(app)?
        .iter()
        .filter_map(|dir| rocm_native_tool_dir(dir))
        .flat_map(|tool_dir| {
            let sdk_bin = tool_dir
                .parent()
                .and_then(|path| path.parent())
                .and_then(|path| path.parent())
                .map(|path| path.join("bin"));
            std::iter::once(tool_dir).chain(sdk_bin.filter(|dir| dir.is_dir()))
        })
        .collect())
}

#[cfg(not(windows))]
fn rocm_native_tool_dirs(_app: &AppHandle) -> AppResult<Vec<PathBuf>> {
    Ok(Vec::new())
}

#[cfg(target_os = "macos")]
fn bundled_openssl_env(app: &AppHandle) -> AppResult<Option<(PathBuf, PathBuf)>> {
    for bin_dir in bundled_bin_dirs(app)? {
        let openssl_dir = bin_dir.join("openssl");
        let openssl_conf = openssl_dir.join("openssl.cnf");
        let openssl_modules = openssl_dir.join("ossl-modules");
        if openssl_conf.is_file() && openssl_modules.is_dir() {
            return Ok(Some((openssl_conf, openssl_modules)));
        }
    }
    Ok(None)
}

fn path_separator() -> &'static str {
    if cfg!(windows) {
        ";"
    } else {
        ":"
    }
}

fn prepend_path(existing: Option<String>, dirs: Vec<PathBuf>) -> Option<String> {
    if dirs.is_empty() {
        return existing;
    }

    let mut parts: Vec<String> = dirs
        .into_iter()
        .map(|dir| dir.to_string_lossy().to_string())
        .collect();

    if let Some(value) = existing {
        if !value.trim().is_empty() {
            parts.push(value);
        }
    }

    Some(parts.join(path_separator()))
}

fn default_output_dir(app: &AppHandle) -> AppResult<PathBuf> {
    storage::outputs_dir(app)
}

fn make_payload_file(command: &str, task_id: Option<&str>, payload: Value) -> AppResult<PathBuf> {
    let mut path = std::env::temp_dir();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or_default();
    let sequence = PAYLOAD_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    path.push(format!(
        "pymss-studio-payload-{}-{}-{}-{}-{}.json",
        command,
        task_id.unwrap_or("once"),
        std::process::id(),
        stamp,
        sequence
    ));
    let mut file = std::fs::File::create(&path)?;
    file.write_all(serde_json::to_string(&payload)?.as_bytes())?;
    Ok(path)
}

fn build_worker_command(
    app: &AppHandle,
    command: &str,
    payload_file: Option<&PathBuf>,
) -> AppResult<Command> {
    let worker = worker_path(app)?;
    let bootstrap_python = bootstrap_python_path(app)?;
    materialize_bundled_runtime_env_templates(app)?;
    // Runtime management must never run inside the environment it is managing: the bootstrap
    // interpreter is the only one guaranteed to exist while an environment is being built,
    // switched, or deleted.
    let python = if matches!(
        command,
        "runtime_info"
            | "runtime_env_sizes"
            | "install_runtime"
            | "activate_runtime"
            | "delete_runtime"
            | "update_runtime_core"
    ) {
        bootstrap_python.clone()
    } else {
        active_runtime_python_path(app)?.unwrap_or_else(|| bootstrap_python.clone())
    };
    let python_for_log = python.clone();
    let worker_for_log = worker.clone();
    let mut cmd = Command::new(python);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.arg(worker)
        .arg(command)
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env("PYTHONUTF8", "1")
        .env("PYMSS_STUDIO_BOOTSTRAP_PYTHON", bootstrap_python)
        .env(
            "PYMSS_STUDIO_DEFAULT_OUTPUT_DIR",
            default_output_dir(app)?.to_string_lossy().to_string(),
        );
    if let Some(path) = session_log::log_env_path(app) {
        cmd.env("PYMSS_STUDIO_SESSION_LOG", path)
            .env("PYMSS_STUDIO_DEBUG_LOG", "1");
    }
    if crate::terminal::is_attached() {
        cmd.env("PYMSS_STUDIO_TERMINAL_LOG", "1");
    }
    if let Some(path) = session_log::persistent_log_env_path(app) {
        cmd.env("PYMSS_STUDIO_PERSISTENT_LOG", path);
    }
    if let Ok(dir) = storage::runtime_envs_dir(app) {
        cmd.env("PYMSS_STUDIO_RUNTIME_ENVS_DIR", dir.to_string_lossy().to_string());
    }
    if let Ok(file) = storage::active_runtime_file(app) {
        cmd.env("PYMSS_STUDIO_ACTIVE_RUNTIME_FILE", file.to_string_lossy().to_string());
    }
    if let Ok(dirs) = bundled_runtime_envs_dirs(app) {
        if let Some(first) = dirs.first() {
            cmd.env("PYMSS_STUDIO_BUNDLED_RUNTIME_ENVS_DIR", first.to_string_lossy().to_string());
        }
    }
    apply_proxy_env(app, &mut cmd);
    let mut tool_dirs = rocm_native_tool_dirs(app)?;
    tool_dirs.extend(bundled_bin_dirs(app)?);
    if let Some(path) = prepend_path(std::env::var("PATH").ok(), tool_dirs) {
        cmd.env("PATH", path);
    }
    #[cfg(target_os = "macos")]
    if let Ok(Some(embedded)) = embedded_python_path(app) {
        if let Some(runtime_root) = embedded.parent().and_then(|path| path.parent()) {
            cmd.env("PYTHONHOME", runtime_root.to_string_lossy().to_string());
        }
    }
    #[cfg(target_os = "macos")]
    if let Some((openssl_conf, openssl_modules)) = bundled_openssl_env(app)? {
        cmd.env(
            "PYMSS_STUDIO_OPENSSL_CONF",
            openssl_conf.to_string_lossy().to_string(),
        );
        cmd.env(
            "PYMSS_STUDIO_OPENSSL_MODULES",
            openssl_modules.to_string_lossy().to_string(),
        );
    }
    if let Ok(models_dir) = storage::models_dir(app) {
        cmd.env("PYMSS_MODEL_DIR", models_dir.to_string_lossy().to_string());
    }
    // Keep the custom-model registry with the app's own state rather than in pymss's default
    // ~/.cache location, so a portable install carries its imported models with it.
    // pymss reads this at import time, which is why it has to be set before spawning.
    if let Ok(file) = storage::user_models_file(app) {
        cmd.env("PYMSS_USER_MODELS", file.to_string_lossy().to_string());
    }
    if let Ok(dir) = storage::data_root_dir(app).map(|root| root.join("debug")) {
        cmd.env("PYMSS_STUDIO_DEBUG_DIR", dir.to_string_lossy().to_string());
    }
    if let Some(path) = payload_file {
        cmd.arg("--payload").arg(path);
    }
    session_log::append(
        app,
        "INFO",
        "worker.command",
        vec![
            ("command", command.to_string()),
            ("python", python_for_log),
            ("worker", worker_for_log.to_string_lossy().to_string()),
            (
                "payloadFile",
                payload_file
                    .map(|path| path.to_string_lossy().to_string())
                    .unwrap_or_default(),
            ),
        ],
    );
    Ok(cmd)
}

fn normalize_proxy_url(url: &str) -> String {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.contains("://") {
        return trimmed.to_string();
    }
    format!("http://{}", trimmed)
}

fn apply_proxy_env(app: &AppHandle, cmd: &mut Command) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let Ok(proxy) = state.proxy_settings.lock() else {
        return;
    };
    let config = serde_json::json!({
        "mode": proxy.mode,
        "url": proxy.url,
        "bypass": proxy.bypass,
    });
    cmd.env("PYMSS_STUDIO_PROXY_CONFIG", config.to_string());
    match proxy.mode.as_str() {
        "none" => {
            cmd.env("PYMSS_STUDIO_PROXY_MODE", "none")
                .env("NO_PROXY", "*")
                .env("HTTP_PROXY", "")
                .env("HTTPS_PROXY", "")
                .env("http_proxy", "")
                .env("https_proxy", "");
        }
        "custom" => {
            let url = normalize_proxy_url(proxy.url.trim());
            if !url.is_empty() {
                cmd.env("HTTP_PROXY", &url)
                    .env("HTTPS_PROXY", &url)
                    .env("http_proxy", &url)
                    .env("https_proxy", &url)
                    .env("PYMSS_STUDIO_PROXY_MODE", "custom");
            }
            let bypass = proxy.bypass.trim();
            if !bypass.is_empty() {
                cmd.env("NO_PROXY", bypass).env("no_proxy", bypass);
            }
        }
        "system" => {
            cmd.env("PYMSS_STUDIO_PROXY_MODE", "system");
        }
        _ => {
            cmd.env("PYMSS_STUDIO_PROXY_MODE", "system");
        }
    }
}

fn emit_worker_stderr(app: &AppHandle, line: String) {
    session_log::append(
        app,
        "WARN",
        "worker.stderr",
        vec![("message", line.clone())],
    );
    let _ = app.emit(
        "pymss://worker-event",
        serde_json::json!({
            "type": "worker_stderr",
            "payload": { "message": line }
        }),
    );
}

fn forward_python_terminal_log(line: &str) -> bool {
    let Some(line) = line.strip_prefix(PYTHON_TERMINAL_LOG_PREFIX) else {
        return false;
    };
    crate::terminal::write(&format!("{line}\n"));
    true
}

fn emit_task_log(app: &AppHandle, task_id: &str, level: &str, message: String) {
    session_log::append(
        app,
        if level.eq_ignore_ascii_case("error") { "ERROR" } else { "WARN" },
        "worker.stderr",
        vec![("taskId", task_id.to_string()), ("message", message.clone())],
    );
    let _ = app.emit(
        "pymss://worker-event",
        serde_json::json!({
            "type": "task_log",
            "taskId": task_id,
            "payload": { "level": level, "message": message }
        }),
    );
}

fn emit_task_error(app: &AppHandle, task_id: &str, message: String) {
    let _ = app.emit(
        "pymss://worker-event",
        serde_json::json!({
            "type": "error",
            "taskId": task_id,
            "payload": { "message": message }
        }),
    );
}
fn emit_task_error_to_all(app: &AppHandle, task_ids: &[String], message: String) {
    for task_id in task_ids {
        emit_task_error(app, task_id, message.clone());
    }
}
fn worker_error_message(envelope: &WorkerEnvelope) -> String {
    envelope
        .payload
        .get("message")
        .and_then(Value::as_str)
        .filter(|message| !message.trim().is_empty())
        .unwrap_or("Worker failed")
        .to_string()
}

fn log_worker_event(app: &AppHandle, command: &str, envelope: &WorkerEnvelope) {
    let level = if envelope.event_type == "error" {
        "ERROR"
    } else if is_noisy_worker_event(&envelope.event_type) {
        "DEBUG"
    } else {
        "INFO"
    };
    if level == "DEBUG" && !session_log::developer_mode_enabled() {
        return;
    }
    let payload = &envelope.payload;
    session_log::append(
        app,
        level,
        "worker.event",
        vec![
            ("command", command.to_string()),
            ("type", envelope.event_type.clone()),
            ("taskId", envelope.task_id.clone().unwrap_or_default()),
            ("requestId", envelope.request_id.clone().unwrap_or_default()),
            ("code", payload.get("code").and_then(Value::as_str).unwrap_or_default().to_string()),
            ("stage", payload.get("stage").and_then(Value::as_str).unwrap_or_default().to_string()),
            ("message", payload.get("message").and_then(Value::as_str).unwrap_or_default().to_string()),
            ("detail", payload.get("detail").and_then(Value::as_str).unwrap_or_default().to_string()),
            ("logPath", payload.get("logPath").and_then(Value::as_str).unwrap_or_default().to_string()),
        ],
    );
}

fn is_noisy_worker_event(event_type: &str) -> bool {
    let lower = event_type.to_ascii_lowercase();
    lower.contains("progress") || lower.contains("chunk") || lower.contains("heartbeat")
}

fn summarize_payload(payload: &Value) -> String {
    let Some(object) = payload.as_object() else {
        return payload_type(payload).to_string();
    };
    let mut parts = Vec::new();
    parts.push(format!("keys={}", object.len()));
    for key in ["taskId", "model", "modelName", "backend", "device", "outputFormat", "saveMode"] {
        if let Some(value) = object.get(key).and_then(Value::as_str).filter(|value| !value.is_empty()) {
            parts.push(format!("{key}={value}"));
        }
    }
    for key in ["inputs", "tasks", "models"] {
        if let Some(count) = object.get(key).and_then(Value::as_array).map(|items| items.len()) {
            parts.push(format!("{key}Count={count}"));
        }
    }
    parts.join(" ")
}

fn payload_type(payload: &Value) -> &'static str {
    match payload {
        Value::Null => "null",
        Value::Bool(_) => "bool",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn log_worker_parse_error(
    app: &AppHandle,
    command: &str,
    task_id: Option<&str>,
    err: &serde_json::Error,
    line: &str,
) {
    session_log::append(
        app,
        "ERROR",
        "worker.invalid_stdout",
        vec![
            ("command", command.to_string()),
            ("taskId", task_id.unwrap_or_default().to_string()),
            ("error", err.to_string()),
            ("raw", line.to_string()),
        ],
    );
}

fn is_background_terminal_event(command: &str, event_type: &str) -> bool {
    match command {
        "delete_model" => matches!(
            event_type,
            "error" | "model_delete_done" | "model_delete_failed"
        ),
        "cleanup_model_residual_files" => matches!(
            event_type,
            "error" | "model_residual_cleanup_done" | "model_residual_cleanup_failed"
        ),
        "download_model" => matches!(event_type, "error" | "download_done" | "task_cancelled"),
        "install_runtime" => matches!(
            event_type,
            "error" | "runtime_install_finished" | "task_cancelled"
        ),
        "update_runtime_core" => matches!(
            event_type,
            "error" | "runtime_core_update_finished" | "task_cancelled"
        ),
        "import_custom_model" => matches!(
            event_type,
            "error" | "custom_model_import_finished" | "task_cancelled"
        ),
        "infer" | "infer_workflow" => {
            matches!(event_type, "error" | "task_done" | "task_cancelled")
        }
        _ => matches!(event_type, "error"),
    }
}

fn read_lossy_lines<R: Read>(reader: R, mut on_line: impl FnMut(String)) {
    let mut reader = BufReader::new(reader);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) => break,
            Ok(_) => {
                while matches!(buf.last(), Some(b'\n' | b'\r')) {
                    buf.pop();
                }
                on_line(String::from_utf8_lossy(&buf).into_owned());
            }
            Err(_) => break,
        }
    }
}

fn emit_worker_stdout(app: &AppHandle, line: String) {
    let _ = app.emit(
        "pymss://worker-event",
        serde_json::json!({
            "type": "worker_stdout",
            "payload": { "message": line }
        }),
    );
}

fn is_rocm_offload_arch_diagnostic(line: &str) -> bool {
    let message = line.trim();
    message.starts_with("Fatal error in launcher: Unable to create process using")
        || message.contains("offload-arch failed with return code")
        || message == "[stderr]"
        || message.starts_with("[rocm_sdk] offload-arch")
}

pub fn run_worker_once(app: &AppHandle, command: &str) -> AppResult<Value> {
    run_worker_with_payload(app, command, None)
}

pub fn run_worker_with_payload(
    app: &AppHandle,
    command: &str,
    payload: Option<Value>,
) -> AppResult<Value> {
    let payload_summary = payload.as_ref().map(summarize_payload).unwrap_or_else(|| "none".to_string());
    session_log::append(
        app,
        "INFO",
        "worker.request",
        vec![("command", command.to_string()), ("payload", payload_summary)],
    );
    let payload_file = match payload {
        Some(value) => Some(make_payload_file(command, None, value)?),
        None => None,
    };
    let mut cmd = build_worker_command(app, command, payload_file.as_ref())?;
    let started_at = std::time::Instant::now();
    session_log::append(app, "INFO", "worker.spawn", vec![("command", command.to_string())]);
    let mut child = cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Worker("missing worker stdout".into()))?;
    let stderr = child.stderr.take();
    let stderr_app = app.clone();
    let stderr_lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let stderr_lines_for_thread = Arc::clone(&stderr_lines);
    let stderr_handle = stderr.map(|stderr| {
        std::thread::spawn(move || {
            read_lossy_lines(stderr, |line| {
                if forward_python_terminal_log(&line) {
                    return;
                }
                if let Ok(mut lines) = stderr_lines_for_thread.lock() {
                    lines.push(line.clone());
                    if lines.len() > 20 {
                        lines.remove(0);
                    }
                }
                emit_worker_stderr(&stderr_app, line);
            });
        })
    });
    let mut last_payload = Value::Null;
    let mut worker_error: Option<AppError> = None;
    read_lossy_lines(stdout, |line| {
        if line.trim().is_empty() || worker_error.is_some() {
            return;
        }
        match serde_json::from_str::<WorkerEnvelope>(&line) {
            Ok(envelope) => {
                last_payload = envelope.payload.clone();
                log_worker_event(app, command, &envelope);
                let _ = app.emit("pymss://worker-event", &envelope);
                if envelope.event_type == "error" {
                    worker_error = Some(AppError::Worker(
                        envelope
                            .payload
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("worker error")
                            .to_string(),
                    ));
                }
            }
            Err(err) => {
                log_worker_parse_error(app, command, None, &err, &line);
                if is_rocm_offload_arch_diagnostic(&line) {
                    emit_worker_stdout(app, line);
                } else {
                    worker_error = Some(AppError::Worker(format!(
                        "Invalid worker event: {err}; raw={line}"
                    )));
                }
            }
        }
    });
    let status = child.wait()?;
    session_log::append(
        app,
        if status.success() { "INFO" } else { "ERROR" },
        "worker.exit",
        vec![
            ("command", command.to_string()),
            ("status", status.to_string()),
            ("durationMs", started_at.elapsed().as_millis().to_string()),
        ],
    );
    if let Some(handle) = stderr_handle {
        let _ = handle.join();
    }
    if let Some(path) = payload_file.as_ref() {
        let _ = std::fs::remove_file(path);
    }
    if let Some(err) = worker_error {
        session_log::append(
            app,
            "ERROR",
            "worker.error",
            vec![("command", command.to_string()), ("message", err.to_string())],
        );
        return Err(err);
    }
    if !status.success() {
        let detail = stderr_lines
            .lock()
            .ok()
            .map(|lines| lines.join("\n"))
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| status.to_string());
        return Err(AppError::Worker(format!("worker exited with {detail}")));
    }
    Ok(last_payload)
}

pub fn spawn_worker_background(
    app: AppHandle,
    state: State<'_, AppState>,
    command: &str,
    task_id: String,
    payload: Value,
) -> AppResult<()> {
    let mut registered_task_ids = vec![task_id.clone()];
    if let Some(tasks) = payload.get("tasks").and_then(Value::as_array) {
        for item in tasks {
            if let Some(child_task_id) = item.get("taskId").and_then(Value::as_str) {
                if !registered_task_ids.iter().any(|id| id == child_task_id) {
                    registered_task_ids.push(child_task_id.to_string());
                }
            }
        }
    }
    {
        let tasks = state
            .tasks
            .lock()
            .map_err(|_| AppError::Worker("task registry lock poisoned".into()))?;
        if let Some(existing) = registered_task_ids
            .iter()
            .find(|id| tasks.contains_key(*id))
        {
            return Err(AppError::Worker(format!(
                "task already exists: {}",
                existing
            )));
        }
    }

    let command_name = command.to_string();
    let payload_summary = summarize_payload(&payload);
    session_log::append(
        &app,
        "INFO",
        "worker.request",
        vec![
            ("command", command.to_string()),
            ("taskId", task_id.clone()),
            ("payload", payload_summary),
        ],
    );
    let payload_file = make_payload_file(command, Some(&task_id), payload)?;
    let mut cmd = build_worker_command(&app, command, Some(&payload_file))?;
    let started_at = std::time::Instant::now();
    session_log::append(
        &app,
        "INFO",
        "worker.spawn",
        vec![("command", command.to_string()), ("taskId", task_id.clone())],
    );
    let mut child: Child = cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Worker("missing worker stdout".into()))?;
    let stderr = child.stderr.take();
    let stderr_app = app.clone();
    let stderr_task_ids = registered_task_ids.clone();
    let stderr_handle = stderr.map(|stderr| {
        std::thread::spawn(move || {
            read_lossy_lines(stderr, |line| {
                if forward_python_terminal_log(&line) {
                    return;
                }
                for stderr_task_id in &stderr_task_ids {
                    emit_task_log(&stderr_app, stderr_task_id, "warning", line.clone());
                }
            });
        })
    });
    let shared_child = Arc::new(Mutex::new(child));
    {
        let mut tasks = state
            .tasks
            .lock()
            .map_err(|_| AppError::Worker("task registry lock poisoned".into()))?;
        for registered_task_id in &registered_task_ids {
            tasks.insert(registered_task_id.clone(), shared_child.clone());
        }
    }
    std::thread::spawn(move || {
        let mut terminal_task_ids: HashSet<String> = HashSet::new();
        read_lossy_lines(stdout, |line| {
            if line.trim().is_empty() {
                return;
            }
            match serde_json::from_str::<WorkerEnvelope>(&line) {
                Ok(envelope) => {
                    if is_background_terminal_event(&command_name, envelope.event_type.as_str()) {
                        if let Some(envelope_task_id) = envelope.task_id.as_deref() {
                            if registered_task_ids.iter().any(|id| id == envelope_task_id) {
                                terminal_task_ids.insert(envelope_task_id.to_string());
                            }
                        } else if envelope.event_type == "error" {
                            let message = worker_error_message(&envelope);
                            emit_task_error_to_all(&app, &registered_task_ids, message);
                            terminal_task_ids.extend(registered_task_ids.iter().cloned());
                        } else {
                            terminal_task_ids.insert(task_id.clone());
                        }
                    }
                    log_worker_event(&app, &command_name, &envelope);
                    let _ = app.emit("pymss://worker-event", &envelope);
                }
                Err(err) => {
                    log_worker_parse_error(&app, &command_name, Some(&task_id), &err, &line);
                    if is_rocm_offload_arch_diagnostic(&line) {
                        for registered_task_id in &registered_task_ids {
                            emit_task_log(&app, registered_task_id, "warning", line.clone());
                        }
                    } else {
                        emit_task_error_to_all(
                            &app,
                            &registered_task_ids,
                            format!("Invalid worker event: {err}"),
                        );
                        terminal_task_ids.extend(registered_task_ids.iter().cloned());
                    }
                }
            }
        });
        let exit_status = if let Ok(mut child) = shared_child.lock() {
            child.wait().ok()
        } else {
            None
        };
        session_log::append(
            &app,
            match exit_status.as_ref() {
                Some(status) if status.success() => "INFO",
                _ => "ERROR",
            },
            "worker.exit",
            vec![
                ("command", command_name.clone()),
                ("taskId", task_id.clone()),
                (
                    "status",
                    exit_status
                        .as_ref()
                        .map(|status| status.to_string())
                        .unwrap_or_else(|| "missing".to_string()),
                ),
                ("durationMs", started_at.elapsed().as_millis().to_string()),
            ],
        );
        let missing_terminal_task_ids = registered_task_ids
            .iter()
            .filter(|task_id| !terminal_task_ids.contains(*task_id))
            .cloned()
            .collect::<Vec<_>>();
        if !missing_terminal_task_ids.is_empty() {
            match exit_status {
                Some(status) if !status.success() => {
                    emit_task_error_to_all(
                        &app,
                        &missing_terminal_task_ids,
                        format!("worker exited with {status}"),
                    );
                }
                None => {
                    emit_task_error_to_all(
                        &app,
                        &missing_terminal_task_ids,
                        "worker exited unexpectedly".to_string(),
                    );
                }
                _ => {}
            }
        }
        if let Some(handle) = stderr_handle {
            let _ = handle.join();
        }
        let _ = std::fs::remove_file(payload_file);
        let cleanup_state = app.state::<AppState>();
        if let Ok(mut tasks) = cleanup_state.tasks.lock() {
            for registered_task_id in registered_task_ids {
                if tasks
                    .get(&registered_task_id)
                    .map(|registered| Arc::ptr_eq(registered, &shared_child))
                    .unwrap_or(false)
                {
                    tasks.remove(&registered_task_id);
                }
            }
        };
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{materialize_windows_venv_template, resolve_active_runtime_record, try_resolve_active_runtime};
    use std::path::PathBuf;

    #[cfg(windows)]
    #[test]
    fn packaged_venv_template_materializes_to_current_package_dir() {
        let root = std::env::temp_dir().join(format!(
            "pymss-worker-template-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let env_dir = root.join("runtime-envs").join("cuda");
        let scripts_dir = env_dir.join("Scripts");
        let runtime_dir = root.join("python-runtime");
        std::fs::create_dir_all(&scripts_dir).unwrap();
        std::fs::create_dir_all(&runtime_dir).unwrap();
        std::fs::write(scripts_dir.join("python.exe"), "stub").unwrap();
        std::fs::write(runtime_dir.join("python.exe"), "stub").unwrap();
        std::fs::write(
            env_dir.join("pyvenv.cfg"),
            "home = __PYMSS_STUDIO_PYTHON_RUNTIME__\r\ninclude-system-site-packages = false\r\nexecutable = __PYMSS_STUDIO_PYTHON_RUNTIME__\\python.exe\r\ncommand = __PYMSS_STUDIO_PYTHON_RUNTIME__\\python.exe -m venv __PYMSS_STUDIO_RUNTIME_ENV__\r\n",
        )
        .unwrap();
        let active_file = root.join("runtime-envs").join("active-runtime.json");
        std::fs::write(
            &active_file,
            r#"{"pythonPath":"cuda\\Scripts\\python.exe"}"#,
        )
        .unwrap();

        materialize_windows_venv_template(&env_dir).unwrap();
        let resolved = try_resolve_active_runtime(&active_file).unwrap();
        let cfg = std::fs::read_to_string(env_dir.join("pyvenv.cfg")).unwrap();
        assert_eq!(PathBuf::from(resolved), scripts_dir.join("python.exe"));
        assert!(cfg.contains(&format!("home = {}", runtime_dir.to_string_lossy())));
        assert!(!cfg.contains("__PYMSS_STUDIO"));

        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn packaged_venv_with_ci_path_materializes_to_current_package_dir() {
        let root = std::env::temp_dir().join(format!(
            "pymss-worker-ci-path-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let package_root = root.join("installed-package");
        let leaked_root = root.join("ci-workspace").join("pymss-studio").join("release").join("Pymss-Studio-test-windows-x64-rocm");
        let env_dir = package_root.join("runtime-envs").join("rocm");
        let scripts_dir = env_dir.join("Scripts");
        let runtime_dir = package_root.join("python-runtime");
        std::fs::create_dir_all(&scripts_dir).unwrap();
        std::fs::create_dir_all(&runtime_dir).unwrap();
        std::fs::write(scripts_dir.join("python.exe"), "stub").unwrap();
        std::fs::write(runtime_dir.join("python.exe"), "stub").unwrap();
        std::fs::write(
            env_dir.join("pyvenv.cfg"),
            format!(
                "home = {}\r\ninclude-system-site-packages = false\r\nexecutable = {}\r\ncommand = {} -m venv {}\r\n",
                leaked_root.join("python-runtime").to_string_lossy(),
                leaked_root.join("python-runtime").join("python.exe").to_string_lossy(),
                leaked_root.join("python-runtime").join("python.exe").to_string_lossy(),
                env_dir.to_string_lossy()
            ),
        )
        .unwrap();

        materialize_windows_venv_template(&env_dir).unwrap();
        let cfg = std::fs::read_to_string(env_dir.join("pyvenv.cfg")).unwrap();
        assert!(cfg.contains(&format!("home = {}", runtime_dir.to_string_lossy())));
        assert!(cfg.contains(&format!(
            "command = {} -m venv {}",
            runtime_dir.join("python.exe").to_string_lossy(),
            env_dir.to_string_lossy()
        )));
        assert!(!cfg.contains(&leaked_root.to_string_lossy().to_string()));

        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn packaged_venv_with_current_path_does_not_need_write_access() {
        let root = std::env::temp_dir().join(format!(
            "pymss-worker-readonly-template-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let env_dir = root.join("runtime-envs").join("rocm");
        let runtime_dir = root.join("python-runtime");
        std::fs::create_dir_all(env_dir.join("Scripts")).unwrap();
        std::fs::create_dir_all(&runtime_dir).unwrap();
        std::fs::write(env_dir.join("Scripts").join("python.exe"), "stub").unwrap();
        std::fs::write(runtime_dir.join("python.exe"), "stub").unwrap();
        let cfg = env_dir.join("pyvenv.cfg");
        std::fs::write(
            &cfg,
            format!(
                "home = {}\r\ninclude-system-site-packages = false\r\nexecutable = {}\r\ncommand = {} -m venv {}\r\n",
                runtime_dir.to_string_lossy(),
                runtime_dir.join("python.exe").to_string_lossy(),
                runtime_dir.join("python.exe").to_string_lossy(),
                env_dir.to_string_lossy()
            ),
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&cfg).unwrap().permissions();
        permissions.set_readonly(true);
        std::fs::set_permissions(&cfg, permissions).unwrap();

        let result = materialize_windows_venv_template(&env_dir);

        let mut permissions = std::fs::metadata(&cfg).unwrap().permissions();
        permissions.set_readonly(false);
        std::fs::set_permissions(&cfg, permissions).unwrap();
        assert!(result.is_ok());
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn finds_rocm_native_offload_arch_tool() {
        let root = std::env::temp_dir().join(format!(
            "pymss-worker-rocm-tool-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let tool_dir = root
            .join("rocm")
            .join("Lib")
            .join("site-packages")
            .join("_rocm_sdk_core")
            .join("lib")
            .join("llvm")
            .join("bin");
        std::fs::create_dir_all(&tool_dir).unwrap();
        std::fs::write(tool_dir.join("offload-arch.exe"), "stub").unwrap();

        assert_eq!(super::rocm_native_tool_dir(&root), Some(tool_dir));

        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn removes_relocated_rocm_offload_arch_launcher() {
        let root = std::env::temp_dir().join(format!(
            "pymss-worker-rocm-launcher-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let launcher = root
            .join("rocm")
            .join("Scripts")
            .join("offload-arch.exe");
        std::fs::create_dir_all(launcher.parent().unwrap()).unwrap();
        std::fs::write(&launcher, "launcher stub").unwrap();

        assert!(super::remove_rocm_offload_arch_launcher(&root).unwrap());

        assert!(!launcher.exists());
        assert!(!super::remove_rocm_offload_arch_launcher(&root).unwrap());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn recognizes_only_known_rocm_offload_arch_diagnostics() {
        for line in [
            "Fatal error in launcher: Unable to create process using 'D:\\a\\python.exe'",
            "[WARNING] offload-arch failed with return code 1",
            "[stderr]",
            "[rocm_sdk] offload-arch not found",
        ] {
            assert!(super::is_rocm_offload_arch_diagnostic(line));
        }
        assert!(!super::is_rocm_offload_arch_diagnostic("unrelated Python traceback"));
    }

    #[test]
    fn active_runtime_record_reports_source() {
        let root = std::env::temp_dir().join(format!(
            "pymss-worker-active-runtime-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let scripts_dir = root.join("runtime-envs").join("cuda").join("Scripts");
        std::fs::create_dir_all(&scripts_dir).unwrap();
        std::fs::write(scripts_dir.join("python.exe"), "stub").unwrap();
        let active_file = root.join("runtime-envs").join("active-runtime.json");
        std::fs::write(
            &active_file,
            r#"{"pythonPath":"cuda\\Scripts\\python.exe","source":"preinstalled"}"#,
        )
        .unwrap();

        let (resolved, source) = resolve_active_runtime_record(&active_file).unwrap();
        assert_eq!(PathBuf::from(resolved), scripts_dir.join("python.exe"));
        assert_eq!(source.as_deref(), Some("preinstalled"));

        let _ = std::fs::remove_dir_all(root);
    }
}
