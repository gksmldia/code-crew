pub mod codex_monitor;
pub mod events;
pub mod hook_install;
pub mod project_key;
pub mod server;
pub mod storage;
pub mod transcript;

use server::{AppState, PermissionDecision};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{Emitter, LogicalSize, Manager, WindowEvent};
use tokio::sync::{mpsc, Mutex};

#[cfg(target_os = "windows")]
const HOOK_BINARY_NAME: &str = "code-crew-hook.exe";
#[cfg(not(target_os = "windows"))]
const HOOK_BINARY_NAME: &str = "code-crew-hook";

fn normalize_hook_path(s: String) -> String {
    // Tauri returns Windows resource paths in verbatim form (`\\?\C:\…`).
    // Hook registration uses Claude Code's exec form, so the executable path
    // is passed as one value without shell parsing. Strip the verbatim prefix
    // and keep a stable forward-slash form that Windows accepts directly.
    #[cfg(target_os = "windows")]
    {
        let stripped = s.strip_prefix(r"\\?\").unwrap_or(&s);
        stripped.replace('\\', "/")
    }
    #[cfg(not(target_os = "windows"))]
    {
        s
    }
}

pub struct AppCtx {
    pub state: AppState,
    pub permission_decisions: Arc<Mutex<HashMap<String, PermissionDecision>>>,
}

fn append_hook_runtime_diagnostics(out: &mut String, exe: &std::path::Path) -> bool {
    use std::fmt::Write;
    use std::io::Write as IoWrite;

    let mut ok = true;
    let _ = writeln!(out);
    let _ = writeln!(out, "runtime diagnostics:");

    let port = std::fs::read_to_string(storage::port_file_path())
        .ok()
        .and_then(|s| s.trim().parse::<u16>().ok())
        .unwrap_or(19876);
    let health_url = format!("http://127.0.0.1:{}/health", port);
    let _ = writeln!(out, "health url: {}", health_url);
    match reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_millis(800))
        .build()
        .and_then(|client| client.get(&health_url).send())
    {
        Ok(resp) => {
            let status = resp.status();
            let body = resp.text().unwrap_or_default();
            let passed = status.is_success() && body.trim() == "ok";
            ok &= passed;
            let _ = writeln!(
                out,
                "health: {} status={} body={:?}",
                if passed { "ok" } else { "FAILED" },
                status,
                body.trim()
            );
        }
        Err(e) => {
            ok = false;
            let _ = writeln!(out, "health: FAILED — {}", e);
        }
    }

    let cwd = std::env::current_dir()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| String::new());
    let payload = serde_json::json!({
        "hook_event_name": "SessionStart",
        "session_id": format!("code-crew-hook-test-{}", chrono::Utc::now().timestamp_millis()),
        "cwd": cwd,
    })
    .to_string();

    let _ = writeln!(out, "direct hook command: {:?} event", exe);
    let _ = writeln!(out, "direct hook payload: {}", payload);
    let mut child = match std::process::Command::new(exe)
        .arg("event")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(e) => {
            let _ = writeln!(out, "direct hook: FAILED to spawn — {}", e);
            return false;
        }
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(payload.as_bytes());
    }
    match child.wait_with_output() {
        Ok(output) => {
            let passed = output.status.success();
            ok &= passed;
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let _ = writeln!(
                out,
                "direct hook: {} status={}",
                if passed { "ok" } else { "FAILED" },
                output.status
            );
            if !stdout.trim().is_empty() {
                let _ = writeln!(out, "direct hook stdout: {}", stdout.trim());
            }
            if !stderr.trim().is_empty() {
                let _ = writeln!(out, "direct hook stderr: {}", stderr.trim());
            }
        }
        Err(e) => {
            ok = false;
            let _ = writeln!(out, "direct hook: FAILED to wait — {}", e);
        }
    }

    ok
}

fn install_hooks_report(
    app: &tauri::AppHandle,
    run_runtime_diagnostics: bool,
) -> Result<String, String> {
    use std::fmt::Write;
    let mut out = String::new();
    let _ = writeln!(out, "binary name: {}", HOOK_BINARY_NAME);
    // macOS: the hook ships next to the main exe as a Cargo [[bin]] output
    // (Contents/MacOS/), where the bundler preserves the exec bit. Earlier we
    // resolved via BaseDirectory::Resource, which silently dropped the +x and
    // every hook call EACCES'd. Windows still uses Resource because the NSIS
    // bundler doesn't place secondary [[bin]] outputs next to the main exe,
    // and Windows has no unix exec bit to lose.
    let resolved: Result<std::path::PathBuf, String>;
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        resolved = std::env::current_exe()
            .map_err(|e| format!("current_exe failed: {}", e))
            .and_then(|p| {
                p.parent()
                    .map(|d| d.join(HOOK_BINARY_NAME))
                    .ok_or_else(|| "current_exe has no parent".to_string())
            });
    }
    #[cfg(not(target_os = "macos"))]
    {
        resolved = app
            .path()
            .resolve(HOOK_BINARY_NAME, tauri::path::BaseDirectory::Resource)
            .map_err(|e| e.to_string());
    }
    let exe = match resolved {
        Ok(p) => {
            let _ = writeln!(out, "resolve: ok\nresolved: {}", p.display());
            p
        }
        Err(e) => {
            let _ = writeln!(out, "resolve: FAILED — {}", e);
            return Err(out);
        }
    };
    let metadata = match std::fs::metadata(&exe) {
        Ok(meta) => {
            let _ = writeln!(out, "exists: true");
            let _ = writeln!(out, "size: {} bytes", meta.len());
            meta
        }
        Err(e) => {
            let _ = writeln!(out, "exists: false");
            let _ = writeln!(out, "binary validation: FAILED — {}", e);
            return Err(out);
        }
    };
    if !metadata.is_file() || metadata.len() == 0 {
        let _ = writeln!(
            out,
            "binary validation: FAILED — hook binary is not a non-empty file"
        );
        return Err(out);
    }
    let _ = writeln!(out, "binary validation: ok");
    let path_str = normalize_hook_path(exe.to_string_lossy().into_owned());
    let _ = writeln!(out, "normalized: {}", path_str);
    let _ = writeln!(out, "settings: {:?}", hook_install::settings_path());
    let install_ok = match hook_install::install(&path_str) {
        Ok(()) => {
            let _ = writeln!(out, "install: ok");
            true
        }
        Err(e) => {
            let _ = writeln!(out, "install: FAILED — {}", e);
            false
        }
    };
    let diagnostics_ok =
        !run_runtime_diagnostics || append_hook_runtime_diagnostics(&mut out, &exe);
    if install_ok && diagnostics_ok {
        Ok(out)
    } else {
        Err(out)
    }
}

#[tauri::command]
async fn install_hooks(app: tauri::AppHandle) -> Result<String, String> {
    install_hooks_report(&app, true)
}

#[tauri::command]
async fn respond_permission(
    state: tauri::State<'_, AppCtx>,
    request_id: String,
    behavior: String,
    remember: bool,
    update_permissions: Option<serde_json::Value>,
) -> Result<(), String> {
    let decision = PermissionDecision { behavior, remember, update_permissions };
    if let Some(tx) = state.state.pending_permissions.lock().await.remove(&request_id) {
        if tx.send(decision).is_err() {
            tracing::debug!("permission decision for {} arrived after receiver dropped (likely timed out)", request_id);
        }
    }
    Ok(())
}

#[tauri::command]
async fn load_project_history(project_key: String) -> Result<Option<storage::ProjectFile>, String> {
    Ok(storage::load(&project_key))
}

#[tauri::command]
async fn append_project_message(
    project_key: String,
    display_name: String,
    msg: storage::StoredMessage,
) -> Result<(), String> {
    storage::append_message(&project_key, &display_name, msg).map_err(|e| e.to_string())
}

#[tauri::command]
fn derive_project_key(cwd: String) -> Result<String, String> {
    Ok(project_key::derive(std::path::Path::new(&cwd)))
}

#[tauri::command]
fn derive_display_name(cwd: String) -> Result<String, String> {
    Ok(project_key::display_name(std::path::Path::new(&cwd)))
}

/// Windows Win32 API FFI — used by focus_pid/focus_app to raise windows directly
/// from the Tauri process (which holds foreground permission after the click)
/// without spawning PowerShell. Spawning powershell.exe + Add-Type JIT takes
/// 1-3 s, long past the ~200 ms Windows foreground-lock window.
#[cfg(target_os = "windows")]
mod win_focus {
    #[link(name = "user32")]
    extern "system" {
        pub fn EnumWindows(
            lpEnumFunc: unsafe extern "system" fn(isize, isize) -> i32,
            lParam: isize,
        ) -> i32;
        pub fn GetWindowThreadProcessId(hWnd: isize, lpdwProcessId: *mut u32) -> u32;
        pub fn IsWindowVisible(hWnd: isize) -> i32;
        pub fn SetForegroundWindow(hWnd: isize) -> i32;
        pub fn ShowWindow(hWnd: isize, nCmdShow: i32) -> i32;
        pub fn GetForegroundWindow() -> isize;
        pub fn AttachThreadInput(idAttach: u32, idAttachTo: u32, fAttach: i32) -> i32;
        pub fn IsIconic(hWnd: isize) -> i32;
        pub fn GetWindowTextW(hWnd: isize, lpString: *mut u16, nMaxCount: i32) -> i32;
    }

    pub unsafe fn hwnd_title(hwnd: isize) -> String {
        let mut buf = [0u16; 512];
        let len = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        if len > 0 { String::from_utf16_lossy(&buf[..len as usize]) } else { String::new() }
    }

    pub struct CollectData {
        pub pids: std::collections::HashSet<u32>,
        /// pid → windows in Z-order (topmost first), each with title.
        /// Collecting ALL windows per PID lets us pick the correct one by
        /// title when a process owns multiple windows (VS Code, IntelliJ).
        pub windows: std::collections::HashMap<u32, Vec<(isize, String)>>,
    }

    pub unsafe extern "system" fn collect_windows_proc(hwnd: isize, lparam: isize) -> i32 {
        if IsWindowVisible(hwnd) == 0 {
            return 1;
        }
        let data = &mut *(lparam as *mut CollectData);
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if data.pids.contains(&pid) {
            data.windows.entry(pid).or_default().push((hwnd, hwnd_title(hwnd)));
        }
        1
    }

    /// EnumWindows callback for focus_app: first visible window whose title
    /// (lowercased) contains the search pattern.
    pub struct AppSearch {
        pub pattern: String,
        pub hwnd: isize,
    }

    pub unsafe extern "system" fn find_app_proc(hwnd: isize, lparam: isize) -> i32 {
        if IsWindowVisible(hwnd) == 0 {
            return 1;
        }
        let s = &mut *(lparam as *mut AppSearch);
        if s.hwnd != 0 {
            return 0;
        }
        if hwnd_title(hwnd).to_lowercase().contains(s.pattern.as_str()) {
            s.hwnd = hwnd;
            return 0;
        }
        1
    }
}

/// Debug-trace `focus_pid`/`focus_app` calls into a flat log so we can see,
/// in release builds, whether a double-click reached Rust and what the OS
/// returned. Best-effort — silent on I/O failure.
fn focus_log(msg: &str) {
    use std::io::Write;
    let path = if cfg!(target_os = "windows") {
        std::env::temp_dir().join("code-crew-focus.log")
    } else {
        std::path::PathBuf::from("/tmp/code-crew-focus.log")
    };
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(f, "[{}] {}", chrono::Local::now().format("%H:%M:%S%.3f"), msg);
    }
}

/// Bring the OS window owning the given Claude session (identified by its
/// terminal/IDE PID) to the foreground. On macOS we ask System Events to
/// activate the process with that `unix id`. Walks the chain in `pid_chain`
/// in order so an inner Helper PID falls back to its outer GUI app.
#[tauri::command]
fn focus_pid(pid_chain: Vec<u32>, cwd: Option<String>) -> Result<(), String> {
    focus_log(&format!("focus_pid chain={:?}", pid_chain));
    if pid_chain.is_empty() {
        return Err("empty pid chain".into());
    }
    #[cfg(target_os = "macos")]
    {
        let pid_list = pid_chain
            .iter()
            .map(|p| p.to_string())
            .collect::<Vec<_>>()
            .join(", ");
        let script = format!(
            r#"tell application "System Events"
    repeat with targetPid in {{{pids}}}
        set pidValue to contents of targetPid
        set pList to every process whose unix id is pidValue
        if (count of pList) > 0 then
            set frontmost of item 1 of pList to true
            return (pidValue as string)
        end if
    end repeat
    return "no-match"
end tell"#,
            pids = pid_list
        );
        let out = std::process::Command::new("osascript")
            .args(["-e", &script])
            .output()
            .map_err(|e| e.to_string())?;
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        focus_log(&format!(
            "  → status={} stdout={:?} stderr={:?}",
            out.status, stdout, stderr,
        ));
        if !out.status.success() {
            return Err(if stderr.is_empty() {
                format!("osascript failed: {}", out.status)
            } else {
                stderr
            });
        }
        if stdout == "no-match" {
            return Err("no matching process in pid chain".into());
        }
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        use std::collections::{HashMap, HashSet};
        use win_focus::*;

        focus_log(&format!("focus_pid windows: chain={:?} cwd={:?}", pid_chain, cwd));

        let mut data = CollectData {
            pids: pid_chain.iter().copied().collect::<HashSet<_>>(),
            windows: HashMap::new(),
        };

        unsafe {
            EnumWindows(collect_windows_proc, &mut data as *mut CollectData as isize);
        }

        // Log all collected windows for diagnosis.
        for (pid, wins) in &data.windows {
            for (hwnd, title) in wins {
                focus_log(&format!("  pid={} hwnd=0x{:x} title={:?}", pid, hwnd, title));
            }
        }

        // Extract cwd folder name for window-title matching. VS Code and
        // IntelliJ show the workspace folder in their title bar, letting us
        // pick the correct window when the shared ptyHost PID is the same
        // across all windows of the same IDE instance.
        let folder = cwd.as_deref().map(|c| {
            let c = c.trim_end_matches(['/', '\\']);
            let i = c.rfind(['/', '\\']).map(|i| i + 1).unwrap_or(0);
            c[i..].to_lowercase()
        });
        focus_log(&format!("  matching folder={:?}", folder));

        // Try PIDs in chain order. For each PID prefer the window whose title
        // contains the project folder; fall back to the topmost (Z-order first).
        let hwnd = pid_chain.iter().find_map(|pid| {
            let wins = data.windows.get(pid)?;
            if let Some(ref f) = folder {
                if let Some((hwnd, _)) = wins.iter().find(|(_, t)| t.to_lowercase().contains(f.as_str())) {
                    return Some(*hwnd);
                }
            }
            wins.first().map(|(hwnd, _)| *hwnd)
        });

        let Some(hwnd) = hwnd else {
            focus_log("focus_pid windows: no matching window found");
            return Err("no focusable window found in pid chain".into());
        };

        focus_log(&format!("focus_pid windows: raising hwnd=0x{:x}", hwnd));

        unsafe {
            if IsIconic(hwnd) != 0 {
                ShowWindow(hwnd, 9); // SW_RESTORE
            }
            let fg_hwnd = GetForegroundWindow();
            let fg_tid = GetWindowThreadProcessId(fg_hwnd, std::ptr::null_mut());
            let tgt_tid = GetWindowThreadProcessId(hwnd, std::ptr::null_mut());
            if fg_tid != 0 && fg_tid != tgt_tid {
                AttachThreadInput(tgt_tid, fg_tid, 1);
                SetForegroundWindow(hwnd);
                AttachThreadInput(tgt_tid, fg_tid, 0);
            } else {
                SetForegroundWindow(hwnd);
            }
        }
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Err("focus_pid not implemented on this platform".into())
    }
}

/// Activate a macOS app by its display name (e.g. "Codex"). Used for Codex
/// sessions where we never see a hook fire, so we have no PID — but the
/// agent always lives in a single GUI app.
#[tauri::command]
fn focus_app(app_name: String) -> Result<(), String> {
    focus_log(&format!("focus_app name={:?}", app_name));
    #[cfg(target_os = "macos")]
    {
        let script = format!(r#"tell application "{}" to activate"#, app_name.replace('"', ""));
        let out = std::process::Command::new("osascript")
            .args(["-e", &script])
            .output()
            .map_err(|e| e.to_string())?;
        focus_log(&format!(
            "  → status={} stderr={:?}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim(),
        ));
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        use std::collections::{HashMap, HashSet};
        use win_focus::*;

        let pattern = app_name.to_lowercase();
        focus_log(&format!("focus_app windows: searching pattern={:?}", pattern));

        // Step 1: find by window title (fast path — works when the app has its own window)
        let mut search = AppSearch { pattern: pattern.clone(), hwnd: 0 };
        unsafe { EnumWindows(find_app_proc, &mut search as *mut AppSearch as isize); }

        let hwnd = if search.hwnd != 0 {
            focus_log(&format!("focus_app windows: title match hwnd=0x{:x}", search.hwnd));
            Some(search.hwnd)
        } else {
            // Step 2: app has no own window (runs inside IntelliJ/VS Code/terminal).
            // Find a process whose exe/name contains the pattern, walk up to its
            // GUI host (IntelliJ, VS Code, Windows Terminal, …) and focus that.
            focus_log("focus_app windows: no title match, trying process-based lookup");
            'find: {
                use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
                let mut sys = System::new();
                sys.refresh_processes_specifics(
                    ProcessesToUpdate::All,
                    true,
                    ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet),
                );
                let app_pid = sys.processes().values()
                    .find(|p| {
                        let by_exe = p.exe()
                            .and_then(|e| e.file_stem())
                            .and_then(|s| s.to_str())
                            .map(|s| s.to_lowercase().contains(pattern.as_str()))
                            .unwrap_or(false);
                        let by_name = p.name().to_lowercase().contains(pattern.as_str());
                        by_exe || by_name
                    })
                    .map(|p| p.pid().as_u32());
                let Some(start_pid) = app_pid else {
                    focus_log("focus_app windows: no matching process found");
                    break 'find None;
                };
                focus_log(&format!("focus_app windows: found process pid={}", start_pid));
                let parent_of = |pid: u32| -> Option<u32> {
                    let ppid = sys.process(Pid::from_u32(pid))?.parent()?.as_u32();
                    if ppid == 0 || ppid == pid { None } else { Some(ppid) }
                };
                let mut chain = vec![start_pid];
                let mut cur = start_pid;
                for _ in 0..8 {
                    if let Some(ppid) = parent_of(cur) { chain.push(ppid); cur = ppid; } else { break; }
                }
                focus_log(&format!("focus_app windows: chain={:?}", chain));
                let mut data = CollectData {
                    pids: chain.iter().copied().collect::<HashSet<_>>(),
                    windows: HashMap::new(),
                };
                unsafe { EnumWindows(collect_windows_proc, &mut data as *mut CollectData as isize); }
                let result = chain.iter().find_map(|pid| data.windows.get(pid)?.first().map(|(h, _)| *h));
                if result.is_none() { focus_log("focus_app windows: process chain has no GUI window"); }
                result
            }
        };

        if let Some(h) = hwnd {
            focus_log(&format!("focus_app windows: raising hwnd=0x{:x}", h));
            unsafe {
                if IsIconic(h) != 0 { ShowWindow(h, 9); }
                let fg = GetForegroundWindow();
                let fg_tid = GetWindowThreadProcessId(fg, std::ptr::null_mut());
                let tgt_tid = GetWindowThreadProcessId(h, std::ptr::null_mut());
                if fg_tid != 0 && fg_tid != tgt_tid {
                    AttachThreadInput(tgt_tid, fg_tid, 1);
                    SetForegroundWindow(h);
                    AttachThreadInput(tgt_tid, fg_tid, 0);
                } else {
                    SetForegroundWindow(h);
                }
            }
        }
        return Ok(());
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = app_name;
        Err("focus_app not implemented on this platform".into())
    }
}

#[tauri::command]
fn is_process_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    process_alive(pid)
}

/// idle sweep이 working 세션의 transcript 활동을 판정할 때 사용.
/// 사고(Musing) 구간엔 hook 이벤트가 없어 mtime·중단 마커로 보완한다.
#[tauri::command]
fn transcript_status(path: String) -> transcript::TranscriptStatus {
    transcript::status(std::path::Path::new(&path))
}

#[cfg(target_os = "windows")]
fn process_alive(pid: u32) -> bool {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let target = Pid::from_u32(pid);
    let mut sys = System::new();
    let refreshed = sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing(),
    );
    if refreshed == 0 {
        return true;
    }
    sys.process(target).is_some()
}

#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .map(|s| s.success())
        .unwrap_or(true)
}

#[cfg(not(any(unix, target_os = "windows")))]
fn process_alive(_pid: u32) -> bool {
    true
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = tracing_subscriber::fmt::try_init();

    let (event_tx, mut event_rx) = mpsc::unbounded_channel();
    let app_state = AppState {
        event_tx,
        pending_permissions: Arc::new(Mutex::new(HashMap::new())),
    };
    let ctx = AppCtx {
        state: app_state.clone(),
        permission_decisions: Arc::new(Mutex::new(HashMap::new())),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::SIZE,
                )
                .build(),
        )
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(ctx)
        .invoke_handler(tauri::generate_handler![
            install_hooks,
            respond_permission,
            load_project_history,
            append_project_message,
            derive_project_key,
            derive_display_name,
            focus_pid,
            focus_app,
            is_process_alive,
            transcript_status,
        ])
        // Intercept window close so the app survives any code path that
        // calls `getCurrentWindow().close()` (header × button, devtools,
        // Cmd+W on macOS, …). Without this guard the single `main` window
        // is the only window, so its destruction triggers Tauri's default
        // ExitRequested → `app.exit(0)` — and the LaunchAgent treats a
        // clean exit as "user wanted to quit" and never relaunches.
        // True quit still happens via the tray menu (`app.exit(0)` below).
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(move |app| {
            let _ = storage::ensure_data_dir();
            let _ = storage::cleanup_old(30);

            let report = match install_hooks_report(app.handle(), false) {
                Ok(s) => format!("[ok] {}\n{}", chrono::Local::now(), s),
                Err(s) => format!("[FAIL] {}\n{}", chrono::Local::now(), s),
            };
            if let Ok(dir) = storage::ensure_data_dir() {
                let log_path = dir.parent().unwrap_or(&dir).join("hook-install.log");
                let _ = std::fs::write(&log_path, &report);
            }
            tracing::info!("hook auto-install report:\n{}", report);

            // Window must be ≥264px tall (card min-h 200 + header 40 + scroller p-3 24)
            // or the card overflows the overflow-y-hidden scroller and the pet clips.
            // set_min_size guards future user resizing; the size bump fixes a state restored
            // smaller by the window-state plugin.
            const MIN_W: f64 = 240.0;
            const MIN_H: f64 = 264.0;
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_min_size(Some(LogicalSize::new(MIN_W, MIN_H)));
                if let (Ok(size), Ok(scale)) = (win.inner_size(), win.scale_factor()) {
                    let logical = size.to_logical::<f64>(scale);
                    let new_w = logical.width.max(MIN_W);
                    let new_h = logical.height.max(MIN_H);
                    if (new_w - logical.width).abs() > 0.5 || (new_h - logical.height).abs() > 0.5 {
                        let _ = win.set_size(LogicalSize::new(new_w, new_h));
                    }
                }
            }

            use tauri::menu::{Menu, MenuItem};
            use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

            let show_item = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            let hide_item = MenuItem::with_id(app, "hide", "Hide", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &hide_item, &quit_item])?;
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") { let _ = w.show(); let _ = w.set_focus(); }
                    }
                    "hide" => {
                        if let Some(w) = app.get_webview_window("main") { let _ = w.hide(); }
                    }
                    "quit" => {
                        let _ = std::fs::remove_file(storage::port_file_path());
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let visible = w.is_visible().unwrap_or(false);
                            if visible {
                                let _ = w.hide();
                            } else {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            let handle = app.handle().clone();
            let state_clone = app_state.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = server::serve(state_clone).await {
                    tracing::error!("server failed: {}", e);
                }
            });

            let event_tx_codex = app_state.event_tx.clone();
            tauri::async_runtime::spawn(async move {
                codex_monitor::run(event_tx_codex).await;
            });

            tauri::async_runtime::spawn(async move {
                while let Some(ev) = event_rx.recv().await {
                    let _ = handle.emit("event", &ev);
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
