use std::sync::atomic::{AtomicBool, Ordering};

static TERMINAL_ATTACHED: AtomicBool = AtomicBool::new(false);

/// Connect a release GUI application to the terminal that launched it, when one exists.
///
/// Unix processes inherit stdout/stderr naturally. Windows GUI-subsystem executables do not,
/// so they have to opt in to their parent's console. `AttachConsole` does not allocate a new
/// console, which is what keeps Explorer/Finder/desktop launches free of a debug window.
pub fn attach_parent() {
    #[cfg(windows)]
    {
        const ATTACH_PARENT_PROCESS: u32 = u32::MAX;

        #[link(name = "Kernel32")]
        extern "system" {
            fn AttachConsole(process_id: u32) -> i32;
            fn GetConsoleWindow() -> *mut core::ffi::c_void;
        }

        // SAFETY: Both calls take no pointers owned by Rust. Failure simply means the parent
        // has no console (the normal double-click case) or this process is already attached.
        let attached = unsafe {
            AttachConsole(ATTACH_PARENT_PROCESS) != 0 || !GetConsoleWindow().is_null()
        };
        TERMINAL_ATTACHED.store(attached, Ordering::Relaxed);
    }

    // Unix desktop launches normally inherit a sink for stderr, while shell launches may inherit
    // either a terminal, a pipe, or a redirected file. Always attempt the write so redirection
    // keeps standard command-line semantics; write failures (including a closed pipe) are ignored.
    #[cfg(not(windows))]
    TERMINAL_ATTACHED.store(true, Ordering::Relaxed);
}

pub fn write(line: &str) {
    if is_attached() {
        use std::io::Write;
        let formatted = format_line(line);
        let _ = std::io::stderr().lock().write_all(formatted.as_bytes());
    }
}

/// Keep the terminal readable without changing the machine-oriented log files.
/// Rust writes epoch timestamps while Python writes ISO timestamps; both become a compact
/// local clock value in the terminal, leaving the event payload untouched.
pub fn format_line(line: &str) -> String {
    let Some((timestamp, rest)) = line.split_once(' ') else {
        return line.to_string();
    };
    let Some(clock) = terminal_clock(timestamp) else {
        return line.to_string();
    };
    format!("{clock} {rest}")
}

fn terminal_clock(timestamp: &str) -> Option<String> {
    use chrono::{DateTime, Local, TimeZone};

    if timestamp.contains('T') {
        let parsed = DateTime::parse_from_rfc3339(timestamp).ok()?;
        return Some(parsed.with_timezone(&Local).format("%H:%M:%S%.3f").to_string());
    }
    let (seconds, millis) = timestamp.trim_end_matches('Z').split_once('.')?;
    let seconds = seconds.parse::<i64>().ok()?;
    let millis = millis.get(..3).unwrap_or(millis).parse::<i64>().ok()?;
    let timestamp_millis = seconds.checked_mul(1000)?.checked_add(millis)?;
    Local.timestamp_millis_opt(timestamp_millis).single()
        .map(|value| value.format("%H:%M:%S%.3f").to_string())
}

pub fn is_attached() -> bool {
    TERMINAL_ATTACHED.load(Ordering::Relaxed)
}
