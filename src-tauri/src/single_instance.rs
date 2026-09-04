//! Keep the desktop application single-instance on Windows.
//!
//! The managed-update helper is started with a command-line mode and exits
//! before this check is reached, so it can still run while the main process is
//! shutting down. Only normal application launches acquire this mutex.

#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
#[cfg(windows)]
use std::path::Path;

#[cfg(windows)]
use windows_sys::core::BOOL;
#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE, HWND, LPARAM};
#[cfg(windows)]
use windows_sys::Win32::System::Threading::{
    CreateMutexW, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION, ReleaseMutex,
};
#[cfg(windows)]
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowThreadProcessId, IsWindowVisible, SetForegroundWindow, ShowWindow,
    SW_RESTORE,
};

#[cfg(windows)]
const INSTANCE_MUTEX_NAME: &str = "Local\\PymssStudioMainInstance";

#[cfg(windows)]
pub(crate) struct InstanceMutex(HANDLE);

#[cfg(windows)]
impl Drop for InstanceMutex {
    fn drop(&mut self) {
        unsafe {
            ReleaseMutex(self.0);
            CloseHandle(self.0);
        }
    }
}

/// Acquire the main-process mutex.
///
/// Returns a guard for the first instance. When another copy is already
/// running, it focuses that copy and returns `Ok(None)`, allowing the
/// duplicate process to exit before Tauri creates another WebView window.
#[cfg(windows)]
pub fn acquire_or_focus() -> Result<Option<InstanceMutex>, String> {
    let name = std::ffi::OsStr::new(INSTANCE_MUTEX_NAME)
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let handle = unsafe { CreateMutexW(std::ptr::null(), 1, name.as_ptr()) };
    if handle.is_null() {
        return Err(std::io::Error::last_os_error().to_string());
    }
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        unsafe {
            CloseHandle(handle);
        }
        focus_existing_instance();
        return Ok(None);
    }
    Ok(Some(InstanceMutex(handle)))
}

#[cfg(not(windows))]
pub fn acquire_or_focus() -> Result<Option<()>, String> {
    Ok(Some(()))
}

#[cfg(windows)]
struct WindowSearch {
    executable: String,
    hwnd: HWND,
}

#[cfg(windows)]
unsafe extern "system" fn find_window_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let search = &mut *(lparam as *mut WindowSearch);
    if !search.hwnd.is_null() || IsWindowVisible(hwnd) == 0 {
        return 1;
    }
    let mut pid = 0_u32;
    if GetWindowThreadProcessId(hwnd, &mut pid) == 0 {
        return 1;
    }
    if process_executable(pid).as_deref() == Some(search.executable.as_str()) {
        search.hwnd = hwnd;
        return 0;
    }
    1
}

#[cfg(windows)]
fn focus_existing_instance() {
    let Ok(executable) = std::env::current_exe() else {
        return;
    };
    let mut search = WindowSearch {
        executable: normalize_path(&executable),
        hwnd: std::ptr::null_mut(),
    };
    unsafe {
        EnumWindows(
            Some(find_window_callback),
            &mut search as *mut WindowSearch as LPARAM,
        );
        if !search.hwnd.is_null() {
            // Restore a minimized window before requesting foreground focus.
            ShowWindow(search.hwnd, SW_RESTORE);
            SetForegroundWindow(search.hwnd);
        }
    }
}

#[cfg(windows)]
fn process_executable(pid: u32) -> Option<String> {
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return None;
    }
    let mut buffer = vec![0_u16; 32_768];
    let mut length = buffer.len() as u32;
    let success = unsafe {
        QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            buffer.as_mut_ptr(),
            &mut length,
        )
    } != 0;
    unsafe {
        CloseHandle(process);
    }
    if !success {
        return None;
    }
    Some(normalize_path(Path::new(
        &String::from_utf16_lossy(&buffer[..length as usize]),
    )))
}

#[cfg(windows)]
fn normalize_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('/', "\\")
        .trim_start_matches(r"\\?\")
        .to_ascii_lowercase()
}
