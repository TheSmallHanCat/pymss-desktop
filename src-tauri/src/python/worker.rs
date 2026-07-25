use crate::error::{AppError, AppResult};
use crate::python::protocol::WorkerEnvelope;
use crate::state::AppState;
use crate::storage;
use serde_json::Value;
use std::collections::HashSet;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

static PAYLOAD_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

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

    if cfg!(debug_assertions) {
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

    Ok(dirs.into_iter().filter(|dir| dir.is_dir()).collect())
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
    let python = if let Ok(value) = std::env::var("PYMSS_STUDIO_PYTHON") {
        value
    } else if let Some(embedded) = embedded_python_path(app)? {
        embedded.to_string_lossy().to_string()
    } else if cfg!(debug_assertions) {
        "python".to_string()
    } else {
        "python3".to_string()
    };
    let mut cmd = Command::new(python);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.arg(worker)
        .arg(command)
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env("PYTHONUTF8", "1")
        .env(
            "PYMSS_STUDIO_DEFAULT_OUTPUT_DIR",
            default_output_dir(app)?.to_string_lossy().to_string(),
        );
    apply_proxy_env(app, &mut cmd);
    if let Some(path) = prepend_path(std::env::var("PATH").ok(), bundled_bin_dirs(app)?) {
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
    if let Some(path) = payload_file {
        cmd.arg("--payload").arg(path);
    }
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
    let _ = app.emit(
        "pymss://worker-event",
        serde_json::json!({
            "type": "worker_stderr",
            "payload": { "message": line }
        }),
    );
}

fn emit_task_log(app: &AppHandle, task_id: &str, level: &str, message: String) {
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

#[cfg(debug_assertions)]
fn debug_log_worker_stderr(command: &str, task_id: Option<&str>, line: &str) {
    if line.trim().is_empty() {
        return;
    }
    if let Some(task_id) = task_id {
        eprintln!("[pymss-worker:{command}:{task_id}:stderr] {line}");
    } else {
        eprintln!("[pymss-worker:{command}:stderr] {line}");
    }
}

#[cfg(debug_assertions)]
fn debug_log_worker_event(command: &str, envelope: &WorkerEnvelope) {
    let mut parts = vec![format!("[pymss-worker:{command}:{}]", envelope.event_type)];
    if let Some(task_id) = envelope.task_id.as_deref() {
        parts.push(format!("task={task_id}"));
    }
    if let Some(request_id) = envelope.request_id.as_deref() {
        parts.push(format!("request={request_id}"));
    }
    if let Some(message) = envelope.payload.get("message").and_then(Value::as_str) {
        parts.push(message.to_string());
    } else if let Some(stage) = envelope.payload.get("stage").and_then(Value::as_str) {
        parts.push(format!("stage={stage}"));
        if let Some(message) = envelope.payload.get("message").and_then(Value::as_str) {
            parts.push(message.to_string());
        }
    } else if matches!(envelope.event_type.as_str(), "error") {
        parts.push(envelope.payload.to_string());
    }
    eprintln!("{}", parts.join(" "));
}

#[cfg(debug_assertions)]
fn debug_log_worker_parse_error(
    command: &str,
    task_id: Option<&str>,
    err: &serde_json::Error,
    line: &str,
) {
    if let Some(task_id) = task_id {
        eprintln!(
            "[pymss-worker:{command}:{task_id}:stdout] invalid worker event: {err}; raw={line}"
        );
    } else {
        eprintln!("[pymss-worker:{command}:stdout] invalid worker event: {err}; raw={line}");
    }
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

pub fn run_worker_once(app: &AppHandle, command: &str) -> AppResult<Value> {
    run_worker_with_payload(app, command, None)
}

pub fn run_worker_with_payload(
    app: &AppHandle,
    command: &str,
    payload: Option<Value>,
) -> AppResult<Value> {
    let payload_file = match payload {
        Some(value) => Some(make_payload_file(command, None, value)?),
        None => None,
    };
    let mut cmd = build_worker_command(app, command, payload_file.as_ref())?;
    let mut child = cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Worker("missing worker stdout".into()))?;
    let stderr = child.stderr.take();
    let stderr_app = app.clone();
    #[cfg(debug_assertions)]
    let stderr_command = command.to_string();
    let stderr_lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let stderr_lines_for_thread = Arc::clone(&stderr_lines);
    let stderr_handle = stderr.map(|stderr| {
        std::thread::spawn(move || {
            read_lossy_lines(stderr, |line| {
                if let Ok(mut lines) = stderr_lines_for_thread.lock() {
                    lines.push(line.clone());
                    if lines.len() > 20 {
                        lines.remove(0);
                    }
                }
                #[cfg(debug_assertions)]
                debug_log_worker_stderr(&stderr_command, None, &line);
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
                #[cfg(debug_assertions)]
                debug_log_worker_event(command, &envelope);
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
                #[cfg(debug_assertions)]
                debug_log_worker_parse_error(command, None, &err, &line);
                worker_error = Some(AppError::Worker(format!(
                    "Invalid worker event: {err}; raw={line}"
                )));
            }
        }
    });
    if let Some(err) = worker_error {
        if let Some(path) = payload_file.as_ref() {
            let _ = std::fs::remove_file(path);
        }
        return Err(err);
    }

    let status = child.wait()?;
    if let Some(handle) = stderr_handle {
        let _ = handle.join();
    }
    if let Some(path) = payload_file.as_ref() {
        let _ = std::fs::remove_file(path);
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
    let payload_file = make_payload_file(command, Some(&task_id), payload)?;
    let mut cmd = build_worker_command(&app, command, Some(&payload_file))?;
    let mut child: Child = cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Worker("missing worker stdout".into()))?;
    let stderr = child.stderr.take();
    let stderr_app = app.clone();
    let stderr_task_ids = registered_task_ids.clone();
    #[cfg(debug_assertions)]
    let stderr_command = command_name.clone();
    let stderr_handle = stderr.map(|stderr| {
        std::thread::spawn(move || {
            read_lossy_lines(stderr, |line| {
                for stderr_task_id in &stderr_task_ids {
                    #[cfg(debug_assertions)]
                    debug_log_worker_stderr(&stderr_command, Some(stderr_task_id), &line);
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
                    #[cfg(debug_assertions)]
                    debug_log_worker_event(&command_name, &envelope);
                    let _ = app.emit("pymss://worker-event", &envelope);
                }
                Err(err) => {
                    #[cfg(debug_assertions)]
                    debug_log_worker_parse_error(&command_name, Some(&task_id), &err, &line);
                    emit_task_error_to_all(
                        &app,
                        &registered_task_ids,
                        format!("Invalid worker event: {err}"),
                    );
                    terminal_task_ids.extend(registered_task_ids.iter().cloned());
                }
            }
        });
        let exit_status = if let Ok(mut child) = shared_child.lock() {
            child.wait().ok()
        } else {
            None
        };
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
