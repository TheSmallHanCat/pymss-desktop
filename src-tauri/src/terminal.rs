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
        let _ = std::io::stderr().lock().write_all(line.as_bytes());
    }
}

pub fn is_attached() -> bool {
    TERMINAL_ATTACHED.load(Ordering::Relaxed)
}
