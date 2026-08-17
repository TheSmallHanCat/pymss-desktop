use crate::error::{AppError, AppResult};
use crate::storage;
use crate::terminal;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::AppHandle;

const SESSION_LOG_FILE_NAME: &str = "current-session.log";
const PERSISTENT_LOG_FILE_NAME: &str = "pymss-studio.log";
const DIAGNOSTIC_REPORT_FILE_NAME: &str = "latest-diagnostic-report.md";
const MAX_LINE_CHARS: usize = 8 * 1024;
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;
const MAX_PERSISTENT_LOG_BYTES: u64 = 10 * 1024 * 1024;
const PERSISTENT_LOG_BACKUPS: usize = 5;
const READ_TAIL_BYTES: u64 = 256 * 1024;
const REPORT_TAIL_BYTES: u64 = 96 * 1024;
const REPORT_THROTTLE_MS: u64 = 5_000;
const MAX_DIAGNOSTIC_VALUE_CHARS: usize = 4 * 1024;

static LOG_CAP_REACHED: AtomicBool = AtomicBool::new(false);
static DEVELOPER_MODE: AtomicBool = AtomicBool::new(false);
static LAST_REPORT_MS: AtomicU64 = AtomicU64::new(0);
static LOG_WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
static TORCH_DIAGNOSTICS: std::sync::Mutex<Option<TorchDiagnostics>> = std::sync::Mutex::new(None);

#[derive(Clone)]
struct TorchDiagnostics {
    available: bool,
    version: String,
    error: String,
    cuda_available: bool,
    cuda_available_error: String,
    device_count: u64,
    device_count_error: String,
    device_names: Vec<String>,
    device_names_error: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugLogInfo {
    path: String,
    logs_dir: String,
    exists: bool,
    size_bytes: u64,
    persistent_path: String,
    persistent_exists: bool,
    persistent_size_bytes: u64,
    max_bytes: u64,
    persistent_max_bytes: u64,
    report_path: String,
    report_exists: bool,
    report_size_bytes: u64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugLogContent {
    path: String,
    content: String,
    size_bytes: u64,
    truncated: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugLogReport {
    path: String,
    exists: bool,
    size_bytes: u64,
}

pub fn session_log_path(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(storage::logs_dir(app)?.join(SESSION_LOG_FILE_NAME))
}

pub fn persistent_log_path(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(storage::logs_dir(app)?.join(PERSISTENT_LOG_FILE_NAME))
}

pub fn diagnostic_report_path(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(storage::logs_dir(app)?.join(DIAGNOSTIC_REPORT_FILE_NAME))
}

pub fn init_session_log(app: &AppHandle) -> AppResult<()> {
    storage::ensure_app_directories(app)?;
    LOG_CAP_REACHED.store(false, Ordering::Relaxed);
    if let Ok(mut diagnostics) = TORCH_DIAGNOSTICS.lock() {
        *diagnostics = None;
    }
    let settings = storage::read_app_store(app, "app-settings").unwrap_or_default();
    set_developer_mode(
        settings
            .get("developerMode")
            .and_then(serde_json::Value::as_bool)
            == Some(true),
    );
    let path = session_log_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, "")?;
    rotate_persistent_log_if_needed(&persistent_log_path(app)?)?;
    append(
        app,
        "INFO",
        "app.start",
        vec![
            ("version", env!("CARGO_PKG_VERSION").to_string()),
            ("mode", app_mode().to_string()),
            ("target", option_env!("PYMSS_BUILD_TARGET").unwrap_or("dev").to_string()),
            ("variant", option_env!("PYMSS_BUILD_VARIANT").unwrap_or("development").to_string()),
        ],
    );
    if let Ok(exe) = std::env::current_exe() {
        append(app, "INFO", "app.exe", vec![("path", exe.to_string_lossy().to_string())]);
    }
    append(
        app,
        "INFO",
        "app.paths",
        vec![
            ("dataRoot", storage::data_root_dir(app)?.to_string_lossy().to_string()),
            ("logsDir", storage::logs_dir(app)?.to_string_lossy().to_string()),
        ],
    );
    Ok(())
}

pub fn append(app: &AppHandle, level: &str, event: &str, fields: Vec<(&str, String)>) {
    let line = {
        let Ok(_guard) = LOG_WRITE_LOCK.lock() else {
            return;
        };
        let field_text = fields
            .into_iter()
            .filter(|(_, value)| !value.is_empty())
            .map(|(key, value)| format!("{key}={}", sanitize_value(key, &value)))
            .collect::<Vec<_>>()
            .join(" ");
        let mut line = format!("{} {:<5} {}", timestamp(), level, event);
        if !field_text.is_empty() {
            line.push(' ');
            line.push_str(&field_text);
        }
        truncate_line(&mut line);
        line.push('\n');
        if let Ok(path) = session_log_path(app) {
            append_session_line(&path, &line);
        }
        if let Ok(path) = persistent_log_path(app) {
            append_persistent_line(&path, &line);
        }
        // Mirror while holding the same lock as the files so concurrent worker threads preserve
        // an identical line order in every destination.
        terminal::write(&line);
        line
    };
    if level.eq_ignore_ascii_case("ERROR") && should_refresh_report() {
        let _ = create_diagnostic_report_with_trigger(app, event, &line);
    }
}

pub fn set_developer_mode(enabled: bool) {
    DEVELOPER_MODE.store(enabled, Ordering::Relaxed);
}

pub fn record_torch_diagnostics(app: &AppHandle, payload: &serde_json::Value) {
    let diagnostics = torch_diagnostics_from_payload(payload);
    if let Ok(mut current) = TORCH_DIAGNOSTICS.lock() {
        *current = Some(diagnostics.clone());
    }
    append(
        app,
        "INFO",
        "runtime.torch",
        vec![
            ("torchVersion", diagnostics.version),
            ("torchAvailable", diagnostics.available.to_string()),
            ("torchError", diagnostics.error),
            ("cudaAvailable", diagnostics.cuda_available.to_string()),
            ("cudaAvailableError", diagnostics.cuda_available_error),
            ("cudaDeviceCount", diagnostics.device_count.to_string()),
            ("cudaDeviceCountError", diagnostics.device_count_error),
            ("cudaDeviceNames", diagnostics.device_names.join(" | ")),
            ("cudaDeviceNamesError", diagnostics.device_names_error),
        ],
    );
}

fn torch_diagnostics_from_payload(payload: &serde_json::Value) -> TorchDiagnostics {
    let device_names = payload
        .get("cudaDevices")
        .and_then(serde_json::Value::as_array)
        .map(|devices| {
            devices
                .iter()
                .filter_map(|device| device.get("name").and_then(serde_json::Value::as_str))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    TorchDiagnostics {
        available: payload
            .get("torchAvailable")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        version: payload
            .get("torchVersion")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string(),
        error: payload
            .get("torchError")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string(),
        cuda_available: payload
            .get("cudaAvailable")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        cuda_available_error: payload
            .get("cudaAvailableError")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string(),
        device_count: payload
            .get("cudaDeviceCount")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or_default(),
        device_count_error: payload
            .get("cudaDeviceCountError")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string(),
        device_names,
        device_names_error: payload
            .get("cudaDeviceNamesError")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string(),
    }
}

pub fn developer_mode_enabled() -> bool {
    DEVELOPER_MODE.load(Ordering::Relaxed)
}

pub fn info(app: &AppHandle) -> AppResult<DebugLogInfo> {
    let path = session_log_path(app)?;
    let persistent_path = persistent_log_path(app)?;
    let report_path = diagnostic_report_path(app)?;
    let meta = std::fs::metadata(&path).ok();
    let persistent_meta = std::fs::metadata(&persistent_path).ok();
    let report_meta = std::fs::metadata(&report_path).ok();
    Ok(DebugLogInfo {
        path: path.to_string_lossy().to_string(),
        logs_dir: storage::logs_dir(app)?.to_string_lossy().to_string(),
        exists: meta.is_some(),
        size_bytes: meta.map(|value| value.len()).unwrap_or(0),
        persistent_path: persistent_path.to_string_lossy().to_string(),
        persistent_exists: persistent_meta.is_some(),
        persistent_size_bytes: persistent_meta.map(|value| value.len()).unwrap_or(0),
        max_bytes: MAX_LOG_BYTES,
        persistent_max_bytes: MAX_PERSISTENT_LOG_BYTES,
        report_path: report_path.to_string_lossy().to_string(),
        report_exists: report_meta.is_some(),
        report_size_bytes: report_meta.map(|value| value.len()).unwrap_or(0),
    })
}

pub fn read_tail(app: &AppHandle) -> AppResult<DebugLogContent> {
    read_tail_path(persistent_log_path(app)?, READ_TAIL_BYTES)
}

fn read_tail_path(path: PathBuf, tail_bytes: u64) -> AppResult<DebugLogContent> {
    let meta = std::fs::metadata(&path).ok();
    let size_bytes = meta.as_ref().map(|value| value.len()).unwrap_or(0);
    if !path.is_file() {
        return Ok(DebugLogContent {
            path: path.to_string_lossy().to_string(),
            content: String::new(),
            size_bytes,
            truncated: false,
        });
    }
    let start = size_bytes.saturating_sub(tail_bytes);
    let mut file = std::fs::File::open(&path)?;
    use std::io::{Read, Seek, SeekFrom};
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    let mut content = String::from_utf8_lossy(&bytes).into_owned();
    if start > 0 {
        if let Some(index) = content.find('\n') {
            content = content[index + 1..].to_string();
        }
    }
    Ok(DebugLogContent {
        path: path.to_string_lossy().to_string(),
        content,
        size_bytes,
        truncated: start > 0,
    })
}

pub fn clear(app: &AppHandle) -> AppResult<DebugLogInfo> {
    let path = session_log_path(app)?;
    {
        let _guard = LOG_WRITE_LOCK
            .lock()
            .map_err(|_| AppError::Worker("session log lock poisoned".into()))?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, "")?;
        std::fs::write(persistent_log_path(app)?, "")?;
        let persistent_path = persistent_log_path(app)?;
        for index in 1..=PERSISTENT_LOG_BACKUPS {
            let _ = std::fs::remove_file(persistent_backup_path(&persistent_path, index));
        }
        let _ = std::fs::remove_file(diagnostic_report_path(app)?);
        LOG_CAP_REACHED.store(false, Ordering::Relaxed);
        LAST_REPORT_MS.store(0, Ordering::Relaxed);
        if let Ok(mut diagnostics) = TORCH_DIAGNOSTICS.lock() {
            *diagnostics = None;
        }
    }
    append(app, "INFO", "log.clear", Vec::new());
    info(app)
}

pub fn create_diagnostic_report(app: &AppHandle) -> AppResult<DebugLogReport> {
    create_diagnostic_report_with_trigger(app, "manual", "manual diagnostic report request")
}

pub fn log_env_path(app: &AppHandle) -> Option<String> {
    session_log_path(app).ok().map(|path| path.to_string_lossy().to_string())
}

pub fn persistent_log_env_path(app: &AppHandle) -> Option<String> {
    persistent_log_path(app).ok().map(|path| path.to_string_lossy().to_string())
}

fn append_session_line(path: &PathBuf, line: &str) {
    if LOG_CAP_REACHED.load(Ordering::Relaxed) {
        return;
    }
    if let Ok(meta) = std::fs::metadata(path) {
        if meta.len() >= MAX_LOG_BYTES {
            if !LOG_CAP_REACHED.swap(true, Ordering::Relaxed) {
                let _ = append_line(path, &format!("{} WARN  log.truncated maxBytes={MAX_LOG_BYTES}\n", timestamp()));
            }
            return;
        }
    }
    let _ = append_line(path, line);
}

fn append_persistent_line(path: &PathBuf, line: &str) {
    let _ = rotate_persistent_log_if_needed(path);
    let _ = append_line(path, line);
}

fn append_line(path: &PathBuf, line: &str) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(path)?;
    file.write_all(line.as_bytes())?;
    Ok(())
}

fn rotate_persistent_log_if_needed(path: &PathBuf) -> AppResult<()> {
    if std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0) < MAX_PERSISTENT_LOG_BYTES {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    for index in (1..=PERSISTENT_LOG_BACKUPS).rev() {
        let from = persistent_backup_path(path, index);
        let to = persistent_backup_path(path, index + 1);
        if index == PERSISTENT_LOG_BACKUPS {
            let _ = std::fs::remove_file(&from);
        } else if from.exists() {
            let _ = std::fs::rename(&from, &to);
        }
    }
    if path.exists() {
        let _ = std::fs::rename(path, persistent_backup_path(path, 1));
    }
    Ok(())
}

fn persistent_backup_path(path: &PathBuf, index: usize) -> PathBuf {
    path.with_file_name(format!("pymss-studio.{index}.log"))
}

fn create_diagnostic_report_with_trigger(app: &AppHandle, trigger: &str, trigger_line: &str) -> AppResult<DebugLogReport> {
    let path = diagnostic_report_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let info = info(app)?;
    let torch_diagnostics = torch_diagnostics_markdown();
    let session_tail = read_tail_path(session_log_path(app)?, REPORT_TAIL_BYTES)?.content;
    let persistent_tail = read_tail_path(persistent_log_path(app)?, REPORT_TAIL_BYTES)?.content;
    let content = format!(
        "# Pymss Studio Diagnostic Report\n\n\
Generated: {}\n\
Trigger: {}\n\
Build: {}\n\
Version: {}\n\
Target: {}\n\
Variant: {}\n\
OS: {}\n\
Arch: {}\n\n\
## Torch Diagnostics\n\n\
{}\n\
## Paths\n\n\
- Data root: `{}`\n\
- Logs dir: `{}`\n\
- Current session log: `{}` ({} bytes)\n\
- Persistent log: `{}` ({} bytes)\n\
- Report: `{}`\n\n\
## Trigger Line\n\n```text\n{}\n```\n\n\
## Recent Current Session Log\n\n```text\n{}\n```\n\n\
## Recent Persistent Log\n\n```text\n{}\n```\n",
        timestamp(),
        trigger,
        app_mode(),
        env!("CARGO_PKG_VERSION"),
        option_env!("PYMSS_BUILD_TARGET").unwrap_or("dev"),
        option_env!("PYMSS_BUILD_VARIANT").unwrap_or("development"),
        std::env::consts::OS,
        std::env::consts::ARCH,
        torch_diagnostics,
        storage::data_root_dir(app)?.to_string_lossy(),
        info.logs_dir,
        info.path,
        info.size_bytes,
        info.persistent_path,
        info.persistent_size_bytes,
        path.to_string_lossy(),
        trigger_line.trim_end(),
        session_tail.trim_end(),
        persistent_tail.trim_end(),
    );
    std::fs::write(&path, content)?;
    let meta = std::fs::metadata(&path).ok();
    Ok(DebugLogReport {
        path: path.to_string_lossy().to_string(),
        exists: meta.is_some(),
        size_bytes: meta.map(|value| value.len()).unwrap_or(0),
    })
}

fn torch_diagnostics_markdown() -> String {
    let diagnostics = TORCH_DIAGNOSTICS
        .lock()
        .ok()
        .and_then(|current| current.clone());
    torch_diagnostics_markdown_for(diagnostics.as_ref())
}

fn torch_diagnostics_markdown_for(diagnostics: Option<&TorchDiagnostics>) -> String {
    let Some(diagnostics) = diagnostics else {
        return "- Environment probe: not recorded in this session".to_string();
    };
    let device_names = if diagnostics.device_names.is_empty() {
        "None".to_string()
    } else {
        diagnostics.device_names.join(", ")
    };
    format!(
        "- Torch available: {}\n- Torch version: {}\n- Torch error: {}\n- CUDA/ROCm available: {}\n- CUDA/ROCm availability error: {}\n- Device count: {}\n- Device count error: {}\n- Device names: {}\n- Device names error: {}",
        diagnostics.available,
        diagnostic_value(&diagnostics.version, "Unknown"),
        diagnostic_value(&diagnostics.error, "None"),
        diagnostics.cuda_available,
        diagnostic_value(&diagnostics.cuda_available_error, "None"),
        diagnostics.device_count,
        diagnostic_value(&diagnostics.device_count_error, "None"),
        diagnostic_value(&device_names, "None"),
        diagnostic_value(&diagnostics.device_names_error, "None"),
    )
}

fn diagnostic_value(value: &str, fallback: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        return fallback.to_string();
    }
    let mut value = redact_sensitive_text(&value.replace(['\r', '\n'], " "));
    if value.chars().count() > MAX_DIAGNOSTIC_VALUE_CHARS {
        value = value
            .chars()
            .take(MAX_DIAGNOSTIC_VALUE_CHARS)
            .collect::<String>();
        value.push_str(" ...[truncated]");
    }
    value
}

fn timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let Ok(duration) = SystemTime::now().duration_since(UNIX_EPOCH) else {
        return "0".to_string();
    };
    format!("{}.{:03}Z", duration.as_secs(), duration.subsec_millis())
}

fn now_millis() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or_default()
}

fn should_refresh_report() -> bool {
    let now = now_millis();
    let previous = LAST_REPORT_MS.load(Ordering::Relaxed);
    if now.saturating_sub(previous) < REPORT_THROTTLE_MS {
        return false;
    }
    LAST_REPORT_MS
        .compare_exchange(previous, now, Ordering::Relaxed, Ordering::Relaxed)
        .is_ok()
}

fn app_mode() -> &'static str {
    if storage::is_development_executable() {
        "development"
    } else {
        "packaged"
    }
}

fn sanitize_value(key: &str, value: &str) -> String {
    if is_sensitive_key(key) {
        return "<redacted>".to_string();
    }
    let value = redact_sensitive_text(&value.replace('\r', " ").replace('\n', " "));
    if value.contains(' ') || value.contains('=') || value.contains('"') {
        serde_json::to_string(&value).unwrap_or_else(|_| "\"<unserializable>\"".to_string())
    } else {
        value
    }
}

fn is_sensitive_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    [
        "password",
        "passwd",
        "token",
        "secret",
        "authorization",
        "api_key",
        "apikey",
        "proxy-pass",
        "proxy_pass",
    ]
        .iter()
        .any(|needle| lower.contains(needle))
}

fn redact_sensitive_text(value: &str) -> String {
    let mut text = redact_authorization_value(&redact_url_credentials(value));
    for marker in [
        "password",
        "passwd",
        "token",
        "secret",
        "api_key",
        "apikey",
        "proxy-pass",
        "proxy_pass",
    ] {
        text = redact_marker_value(&text, marker);
    }
    text
}

fn redact_authorization_value(value: &str) -> String {
    redact_marker_value_until(value, "authorization", |ch| matches!(ch, ',' | ';' | '&'))
}

fn redact_marker_value(value: &str, marker: &str) -> String {
    redact_marker_value_until(value, marker, |ch| ch.is_whitespace() || matches!(ch, ',' | ';' | '&'))
}

fn redact_marker_value_until(value: &str, marker: &str, is_end: impl Fn(char) -> bool) -> String {
    let lower = value.to_ascii_lowercase();
    let mut output = String::with_capacity(value.len());
    let mut cursor = 0;
    while let Some(relative) = lower[cursor..].find(marker) {
        let start = cursor + relative;
        let after_marker = start + marker.len();
        let separator_start = value[after_marker..]
            .find(|ch: char| !ch.is_whitespace())
            .map(|index| after_marker + index)
            .unwrap_or(after_marker);
        let Some(separator) = value[separator_start..].chars().next() else {
            break;
        };
        if !matches!(separator, '=' | ':') {
            output.push_str(&value[cursor..after_marker]);
            cursor = after_marker;
            continue;
        }
        let value_start = separator_start + separator.len_utf8();
        let value_start = value[value_start..]
            .find(|ch: char| !ch.is_whitespace())
            .map(|index| value_start + index)
            .unwrap_or(value_start);
        output.push_str(&value[cursor..value_start]);
        output.push_str("<redacted>");
        let rest = &value[value_start..];
        let value_end = rest
            .find(|ch: char| is_end(ch))
            .map(|index| value_start + index)
            .unwrap_or(value.len());
        cursor = value_end;
    }
    output.push_str(&value[cursor..]);
    output
}

fn redact_url_credentials(value: &str) -> String {
    let mut output = value.to_string();
    let mut cursor = 0;
    while let Some(relative) = output[cursor..].find("://") {
        let authority_start = cursor + relative + 3;
        let authority_end = output[authority_start..]
            .find(|ch: char| matches!(ch, '/' | '?' | '#' | ' ' | '"' | '\'' | '\\'))
            .map(|index| authority_start + index)
            .unwrap_or(output.len());
        if let Some(at_relative) = output[authority_start..authority_end].rfind('@') {
            let at = authority_start + at_relative;
            output.replace_range(authority_start..=at, "");
            cursor = authority_start;
        } else {
            cursor = authority_end;
        }
    }
    output
}

fn truncate_line(line: &mut String) {
    if line.chars().count() <= MAX_LINE_CHARS {
        return;
    }
    let mut truncated = line.chars().take(MAX_LINE_CHARS).collect::<String>();
    truncated.push_str(" ...[truncated]");
    *line = truncated;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn torch_diagnostics_preserve_probe_errors_for_logs_and_reports() {
        let diagnostics = torch_diagnostics_from_payload(&json!({
            "torchAvailable": true,
            "torchVersion": "2.9.1+rocm",
            "cudaAvailable": false,
            "cudaAvailableError": "availability query failed",
            "cudaDeviceCount": 2,
            "cudaDeviceCountError": "count query failed",
            "cudaDevices": [{"id": 1, "name": "AMD GPU"}],
            "cudaDeviceNamesError": "device 0: name query failed"
        }));

        let report = torch_diagnostics_markdown_for(Some(&diagnostics));

        assert!(report.contains("Torch version: 2.9.1+rocm"));
        assert!(report.contains("availability query failed"));
        assert!(report.contains("count query failed"));
        assert!(report.contains("Device names: AMD GPU"));
        assert!(report.contains("device 0: name query failed"));
    }

    #[test]
    fn torch_diagnostics_redact_and_flatten_error_text() {
        let diagnostics = TorchDiagnostics {
            available: false,
            version: String::new(),
            error: "token=secret-value\nsecond line".to_string(),
            cuda_available: false,
            cuda_available_error: String::new(),
            device_count: 0,
            device_count_error: String::new(),
            device_names: Vec::new(),
            device_names_error: String::new(),
        };

        let report = torch_diagnostics_markdown_for(Some(&diagnostics));

        assert!(report.contains("Torch error: token=<redacted> second line"));
        assert!(!report.contains("secret-value"));
    }

    #[test]
    fn torch_diagnostics_sanitize_and_bound_device_names() {
        let diagnostics = TorchDiagnostics {
            available: true,
            version: "test".to_string(),
            error: String::new(),
            cuda_available: true,
            cuda_available_error: String::new(),
            device_count: 1,
            device_count_error: String::new(),
            device_names: vec![format!("token=device-secret\n{}", "x".repeat(MAX_DIAGNOSTIC_VALUE_CHARS))],
            device_names_error: String::new(),
        };

        let report = torch_diagnostics_markdown_for(Some(&diagnostics));

        assert!(report.contains("Device names: token=<redacted>"));
        assert!(!report.contains("device-secret"));
        assert!(report.contains("...[truncated]"));
        assert!(!report.contains("\nxxxxxxxx"));
    }
}
