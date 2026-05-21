pub mod codex_monitor;
pub mod events;
pub mod hook_install;
pub mod project_key;
pub mod server;
pub mod storage;

use server::{AppState, PermissionDecision};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{Emitter, Manager, WindowEvent};
use tokio::sync::{mpsc, Mutex};

#[cfg(target_os = "windows")]
const HOOK_BINARY_NAME: &str = "code-crew-hook.exe";
#[cfg(not(target_os = "windows"))]
const HOOK_BINARY_NAME: &str = "code-crew-hook";

fn normalize_hook_path(s: String) -> String {
    // Tauri returns Windows resource paths in verbatim form (`\\?\C:\…`).
    // Claude Code runs hook commands through bash, which can't resolve the
    // verbatim prefix and consumes backslashes inside double-quoted strings
    // as escapes. Forward slashes under Git Bash avoid both problems.
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

#[tauri::command]
async fn install_hooks(app: tauri::AppHandle) -> Result<(), String> {
    let exe = app
        .path()
        .resolve(HOOK_BINARY_NAME, tauri::path::BaseDirectory::Resource)
        .map_err(|e| e.to_string())?;
    let path_str = normalize_hook_path(exe.to_string_lossy().into_owned());
    hook_install::install(&path_str).map_err(|e| e.to_string())
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

/// Debug-trace `focus_pid`/`focus_app` calls into a flat log so we can see,
/// in release builds, whether a double-click reached Rust and what osascript
/// returned. Best-effort — silent on I/O failure.
fn focus_log(msg: &str) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("/tmp/code-crew-focus.log")
    {
        let _ = writeln!(f, "[{}] {}", chrono::Local::now().format("%H:%M:%S%.3f"), msg);
    }
}

/// Bring the OS window owning the given Claude session (identified by its
/// terminal/IDE PID) to the foreground. On macOS we ask System Events to
/// activate the process with that `unix id`. Walks the chain in `pid_chain`
/// in order so an inner Helper PID falls back to its outer GUI app.
#[tauri::command]
fn focus_pid(pid_chain: Vec<u32>) -> Result<(), String> {
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
    #[cfg(not(target_os = "macos"))]
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
    #[cfg(not(target_os = "macos"))]
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

#[cfg(target_os = "windows")]
fn process_alive(pid: u32) -> bool {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let target = Pid::from_u32(pid);
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[target]),
        true,
        ProcessRefreshKind::nothing(),
    );
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

            if let Ok(exe) = app
                .path()
                .resolve(HOOK_BINARY_NAME, tauri::path::BaseDirectory::Resource)
            {
                let path_str = normalize_hook_path(exe.to_string_lossy().into_owned());
                if let Err(e) = hook_install::install(&path_str) {
                    tracing::warn!("hook auto-install failed: {}", e);
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
                    "quit" => app.exit(0),
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
