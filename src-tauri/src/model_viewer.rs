use std::path::PathBuf;

#[cfg(windows)]
use std::{
    collections::HashSet,
    ffi::c_void,
    fs,
    io::Read,
    os::windows::process::CommandExt,
    path::Path,
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

use tauri::Emitter;

#[cfg(windows)]
use tauri::{AppHandle, Manager};

#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::{CloseHandle, GetLastError, SetLastError},
    System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    },
    UI::WindowsAndMessaging::{
        EnumWindows, GetWindowThreadProcessId, IsWindowVisible, PostMessageW, SetParent,
        SetWindowPos, ShowWindow, GWL_STYLE, HWND_TOP, SWP_FRAMECHANGED, SWP_NOACTIVATE,
        SWP_SHOWWINDOW, SW_HIDE, WM_CLOSE, WS_CAPTION, WS_CHILD, WS_MAXIMIZEBOX, WS_MINIMIZEBOX,
        WS_POPUP, WS_SYSMENU, WS_THICKFRAME,
    },
};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(windows)]
type Hwnd = *mut c_void;

#[cfg(windows)]
struct ViewerSession {
    child: Child,
    hwnd: isize,
}

#[derive(Default)]
pub struct ModelViewerState {
    #[cfg(windows)]
    transition: Mutex<()>,
    #[cfg(windows)]
    session: Mutex<Option<ViewerSession>>,
}

#[cfg(windows)]
impl Drop for ModelViewerState {
    fn drop(&mut self) {
        if let Ok(session) = self.session.get_mut() {
            if let Some(session) = session.take() {
                let _ = stop_session(session);
            }
        }
    }
}

#[cfg(windows)]
struct WindowSearch {
    process_ids: HashSet<u32>,
    hwnd: Hwnd,
}

#[cfg(windows)]
unsafe extern "system" fn find_process_window(hwnd: Hwnd, parameter: isize) -> i32 {
    let search = &mut *(parameter as *mut WindowSearch);
    if IsWindowVisible(hwnd) == 0 {
        return 1;
    }

    let mut process_id = 0;
    GetWindowThreadProcessId(hwnd, &mut process_id);
    if search.process_ids.contains(&process_id) {
        search.hwnd = hwnd;
        return 0;
    }

    1
}

#[cfg(windows)]
fn process_tree(root_process_id: u32) -> Result<HashSet<u32>, String> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot as isize == -1 {
        return Err(format!(
            "Could not inspect the model viewer process tree (Windows error {}).",
            unsafe { GetLastError() }
        ));
    }

    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut processes = Vec::new();
    if unsafe { Process32FirstW(snapshot, &mut entry) } == 0 {
        let error = unsafe { GetLastError() };
        unsafe {
            CloseHandle(snapshot);
        }
        return Err(format!(
            "Could not read the model viewer process tree (Windows error {error})."
        ));
    }

    loop {
        processes.push((entry.th32ProcessID, entry.th32ParentProcessID));
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if unsafe { Process32NextW(snapshot, &mut entry) } == 0 {
            break;
        }
    }
    unsafe {
        CloseHandle(snapshot);
    }

    let mut process_ids = HashSet::from([root_process_id]);
    loop {
        let count_before = process_ids.len();
        for (process_id, parent_process_id) in &processes {
            if process_ids.contains(parent_process_id) {
                process_ids.insert(*process_id);
            }
        }
        if process_ids.len() == count_before {
            break;
        }
    }

    Ok(process_ids)
}

#[cfg(windows)]
fn find_window_for_process_tree(root_process_id: u32) -> Result<Option<Hwnd>, String> {
    let process_ids = process_tree(root_process_id)?;
    let mut search = WindowSearch {
        process_ids,
        hwnd: std::ptr::null_mut(),
    };
    unsafe {
        EnumWindows(
            Some(find_process_window),
            &mut search as *mut WindowSearch as isize,
        );
    }
    Ok((!search.hwnd.is_null()).then_some(search.hwnd))
}

#[cfg(windows)]
fn find_viewer_executable(viewer_dir: &Path) -> Result<PathBuf, String> {
    if !viewer_dir.is_dir() {
        return Err(format!(
            "Model viewer is not installed at {}. Install the latest resources update first.",
            viewer_dir.display()
        ));
    }

    let mut executables = fs::read_dir(viewer_dir)
        .map_err(|error| error.to_string())?
        .map(|entry| {
            entry
                .map(|entry| entry.path())
                .map_err(|error| error.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter(|path| {
            path.is_file()
                && path
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
        })
        .collect::<Vec<_>>();
    executables.sort();

    if let Some(preferred) = executables.iter().find(|path| {
        path.file_stem()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.to_ascii_lowercase().starts_with("3dmigotomodviewer"))
    }) {
        return Ok(preferred.clone());
    }

    match executables.as_slice() {
        [only] => Ok(only.clone()),
        [] => Err(format!(
            "No model viewer executable was found directly inside {}.",
            viewer_dir.display()
        )),
        _ => Err(format!(
            "More than one executable was found in {}; expected 3DMigotoModViewer.",
            viewer_dir.display()
        )),
    }
}

#[cfg(windows)]
fn terminate_process_tree(process_id: u32) -> Result<(), String> {
    let system_root = std::env::var_os("SystemRoot")
        .ok_or_else(|| "Could not locate Windows taskkill.exe.".to_string())?;
    let taskkill = PathBuf::from(system_root)
        .join("System32")
        .join("taskkill.exe");
    let process_id = process_id.to_string();
    let status = Command::new(taskkill)
        .args(["/PID", &process_id, "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|error| format!("Could not stop the model viewer process tree: {error}"))?;

    if !status.success() {
        return Err(format!(
            "Could not stop the model viewer process tree (taskkill status {status})."
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn stop_session(mut session: ViewerSession) -> Result<(), String> {
    unsafe {
        ShowWindow(session.hwnd as Hwnd, SW_HIDE);
        PostMessageW(session.hwnd as Hwnd, WM_CLOSE, 0, 0);
    }

    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if session
            .child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_some()
        {
            return Ok(());
        }
        if Instant::now() >= deadline {
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }

    if let Err(kill_error) = terminate_process_tree(session.child.id()) {
        if session
            .child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_none()
        {
            return Err(kill_error);
        }
    }

    session
        .child
        .wait()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg(windows)]
fn scaled_coordinate(value: f64, scale_factor: f64) -> Result<i32, String> {
    if !value.is_finite() || !scale_factor.is_finite() || scale_factor <= 0.0 {
        return Err("Model viewer bounds are invalid.".to_string());
    }
    Ok((value * scale_factor).round() as i32)
}

#[cfg(windows)]
fn position_window(
    hwnd: Hwnd,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale_factor: f64,
) -> Result<(), String> {
    let x = scaled_coordinate(x, scale_factor)?;
    let y = scaled_coordinate(y, scale_factor)?;
    let width = scaled_coordinate(width, scale_factor)?.max(1);
    let height = scaled_coordinate(height, scale_factor)?.max(1);
    let positioned = unsafe {
        SetWindowPos(
            hwnd,
            HWND_TOP,
            x,
            y,
            width,
            height,
            SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_SHOWWINDOW,
        )
    };
    if positioned == 0 {
        return Err(format!(
            "Could not resize the embedded model viewer (Windows error {}).",
            unsafe { GetLastError() }
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn launch_viewer(
    app: AppHandle,
    start_directory: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale_factor: f64,
) -> Result<String, String> {
    let start_directory = PathBuf::from(start_directory.trim());
    if !start_directory.is_dir() {
        return Err(format!(
            "The selected game's mod folder does not exist: {}",
            start_directory.display()
        ));
    }

    let resources_dir = crate::resolve_resources_dir()?;
    let viewer_dir = resources_dir.join("model_viewer");
    let executable = find_viewer_executable(&viewer_dir)?;
    let main_window = app
        .get_webview_window("main")
        .ok_or_else(|| "The main app window could not be found.".to_string())?;
    let parent = main_window.hwnd().map_err(|error| error.to_string())?.0;

    let child = Command::new(&executable)
        .current_dir(&start_directory)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|error| format!("Could not launch the model viewer: {error}"))?;

    let process_id = child.id();
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut child = child;
    let viewer_hwnd = loop {
        match find_window_for_process_tree(process_id) {
            Ok(Some(hwnd)) => break hwnd,
            Ok(None) => {}
            Err(error) => {
                let _ = terminate_process_tree(process_id);
                let _ = child.wait();
                return Err(error);
            }
        }
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            return Err(format!(
                "The model viewer exited before its window was ready (status {status})."
            ));
        }
        if Instant::now() >= deadline {
            let _ = terminate_process_tree(process_id);
            let _ = child.wait();
            return Err("Timed out waiting for the model viewer window.".to_string());
        }
        thread::sleep(Duration::from_millis(100));
    };

    unsafe {
        let style =
            windows_sys::Win32::UI::WindowsAndMessaging::GetWindowLongPtrW(viewer_hwnd, GWL_STYLE);
        let remove_style =
            (WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX)
                as isize;
        windows_sys::Win32::UI::WindowsAndMessaging::SetWindowLongPtrW(
            viewer_hwnd,
            GWL_STYLE,
            (style & !remove_style) | WS_CHILD as isize,
        );

        SetLastError(0);
        let previous_parent = SetParent(viewer_hwnd, parent);
        if previous_parent.is_null() && GetLastError() != 0 {
            let error = GetLastError();
            let _ = terminate_process_tree(process_id);
            let _ = child.wait();
            return Err(format!(
                "Could not embed the model viewer (Windows error {error})."
            ));
        }
    }

    if let Err(error) = position_window(viewer_hwnd, x, y, width, height, scale_factor) {
        let _ = terminate_process_tree(process_id);
        let _ = child.wait();
        return Err(error);
    }

    let state = app.state::<ModelViewerState>();
    let mut session = state
        .session
        .lock()
        .map_err(|_| "Model viewer state is unavailable.".to_string())?;
    *session = Some(ViewerSession {
        child,
        hwnd: viewer_hwnd as isize,
    });

    Ok(executable.to_string_lossy().into_owned())
}

#[cfg(windows)]
pub(crate) fn executable_has_console_subsystem(executable: &Path) -> Result<bool, String> {
    let mut file = fs::File::open(executable).map_err(|error| error.to_string())?;
    let mut header = [0_u8; 4096];
    let bytes_read = file.read(&mut header).map_err(|error| error.to_string())?;
    let header = &header[..bytes_read];
    if header.len() < 64 || &header[..2] != b"MZ" {
        return Err("The fix executable has an invalid Windows header.".to_string());
    }

    let pe_offset = u32::from_le_bytes(
        header[0x3c..0x40]
            .try_into()
            .map_err(|_| "The fix executable header is incomplete.")?,
    ) as usize;
    let optional_header = pe_offset.saturating_add(24);
    let subsystem_offset = optional_header.saturating_add(68);
    if header.get(pe_offset..pe_offset.saturating_add(4)) != Some(&b"PE\0\0"[..])
        || header.len() < subsystem_offset.saturating_add(2)
    {
        return Err("The fix executable has an unsupported Windows header.".to_string());
    }

    let subsystem = u16::from_le_bytes(
        header[subsystem_offset..subsystem_offset + 2]
            .try_into()
            .map_err(|_| "The fix executable header is incomplete.")?,
    );
    match subsystem {
        2 => Ok(false),
        3 => Ok(true),
        _ => Err("The fix executable uses an unsupported Windows subsystem.".to_string()),
    }
}

#[cfg(windows)]
#[tauri::command]
pub async fn open_model_viewer(
    app: AppHandle,
    start_directory: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale_factor: f64,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<ModelViewerState>();
        let _transition = state
            .transition
            .lock()
            .map_err(|_| "Model viewer state is unavailable.".to_string())?;
        if let Some(session) = state
            .session
            .lock()
            .map_err(|_| "Model viewer state is unavailable.".to_string())?
            .take()
        {
            stop_session(session)?;
        }
        launch_viewer(
            app.clone(),
            start_directory,
            x,
            y,
            width,
            height,
            scale_factor,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(not(windows))]
#[tauri::command]
pub async fn open_model_viewer(
    _app: tauri::AppHandle,
    _start_directory: String,
    _x: f64,
    _y: f64,
    _width: f64,
    _height: f64,
    _scale_factor: f64,
) -> Result<String, String> {
    Err("The embedded model viewer is supported on Windows only.".to_string())
}

#[cfg(windows)]
#[tauri::command]
pub fn position_model_viewer(
    app: AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale_factor: f64,
) -> Result<(), String> {
    let state = app.state::<ModelViewerState>();
    let mut session = state
        .session
        .lock()
        .map_err(|_| "Model viewer state is unavailable.".to_string())?;
    let current = session
        .as_mut()
        .ok_or_else(|| "The model viewer is not running.".to_string())?;
    if current
        .child
        .try_wait()
        .map_err(|error| error.to_string())?
        .is_some()
    {
        *session = None;
        return Err("The model viewer process has exited.".to_string());
    }

    position_window(current.hwnd as Hwnd, x, y, width, height, scale_factor)
}

#[cfg(not(windows))]
#[tauri::command]
pub fn position_model_viewer(
    _app: tauri::AppHandle,
    _x: f64,
    _y: f64,
    _width: f64,
    _height: f64,
    _scale_factor: f64,
) -> Result<(), String> {
    Err("The embedded model viewer is supported on Windows only.".to_string())
}

#[cfg(windows)]
#[tauri::command]
pub fn close_model_viewer(app: AppHandle) -> Result<(), String> {
    let state = app.state::<ModelViewerState>();
    let _transition = state
        .transition
        .lock()
        .map_err(|_| "Model viewer state is unavailable.".to_string())?;
    if let Some(session) = state
        .session
        .lock()
        .map_err(|_| "Model viewer state is unavailable.".to_string())?
        .take()
    {
        stop_session(session)?;
    }
    app.emit("model-viewer-closed", ())
        .map_err(|error| error.to_string())
}

#[cfg(not(windows))]
#[tauri::command]
pub fn close_model_viewer(app: tauri::AppHandle) -> Result<(), String> {
    app.emit("model-viewer-closed", ())
        .map_err(|error| error.to_string())
}
