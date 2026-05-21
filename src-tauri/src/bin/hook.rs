use std::env;
use std::io::{self, Read, Write};
#[cfg(unix)]
use std::os::unix::process::parent_id;
#[cfg(unix)]
use std::process::Command;
use std::process::ExitCode;

const SERVER: &str = "http://127.0.0.1:19876";
const SAFE_TOOLS: &[&str] = &["Read", "Glob", "Grep", "LS", "WebSearch", "TodoWrite"];

/// Walk up the parent-process chain starting from `start_pid` (typically the
/// hook's PPID = the Claude Code node process). Returns up to `max_depth` PIDs
/// in order from `start_pid` outward. Uses `ps` so we don't pull in libc /
/// sysctl bindings.
#[cfg(unix)]
fn pid_chain(start_pid: u32, max_depth: usize) -> Vec<u32> {
    let mut chain = vec![start_pid];
    let mut cur = start_pid;
    for _ in 0..max_depth {
        let Ok(out) = Command::new("ps")
            .args(["-p", &cur.to_string(), "-o", "ppid="])
            .output()
        else {
            break;
        };
        let s = String::from_utf8_lossy(&out.stdout);
        let Ok(ppid) = s.trim().parse::<u32>() else { break };
        if ppid == 0 || ppid == 1 || ppid == cur {
            break;
        }
        chain.push(ppid);
        cur = ppid;
    }
    chain
}

/// Names of GUI host processes we'd want to activate. Matched against the
/// `comm` (basename of the executable) returned by `ps`.
/// Lowercase basenames of GUI host processes we want to activate. Matched
/// case-insensitively against the `comm` (basename of the executable) returned
/// by `ps`. Helper executables ("Code Helper", "Cursor Helper" …) are
/// deliberately excluded — they appear earlier in the PPID chain but don't
/// own user-visible windows, so `frontmost = true` against them is a no-op.
#[cfg(unix)]
const GUI_HOSTS: &[&str] = &[
    "iterm2", "iterm",
    "terminal",
    "hyper",
    "alacritty",
    "wezterm", "wezterm-gui",
    "kitty",
    "warp",
    "tabby",
    "ghostty",
    "code",
    "cursor",
    "windsurf",
    "vscodium",
    "code-insiders",
];

/// Look up `comm` (executable basename) for a PID via `ps`.
#[cfg(unix)]
fn comm_of(pid: u32) -> Option<String> {
    let out = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() { None } else {
        // `comm` from BSD ps is the full executable path; we only care about
        // the trailing component for matching.
        Some(
            std::path::Path::new(&s)
                .file_name()
                .and_then(|n| n.to_str())
                .map(str::to_string)
                .unwrap_or(s),
        )
    }
}

/// Pick the PID in the chain whose `comm` best identifies the host GUI app
/// the user wants brought forward. Helper executables ("Code Helper",
/// "Cursor Helper …") are skipped — they pattern-match the parent app name
/// ("Code Helper" contains "code") but don't own windows, so picking one
/// makes `frontmost = true` silently no-op. Falls back to the outermost
/// non-helper ancestor.
#[cfg(unix)]
fn pick_source_pid(chain: &[u32]) -> Option<u32> {
    let comms: Vec<(u32, String)> = chain
        .iter()
        .filter_map(|&p| comm_of(p).map(|c| (p, c.to_lowercase())))
        .filter(|(_, c)| !c.contains("helper"))
        .collect();

    for (p, comm) in &comms {
        if GUI_HOSTS.iter().any(|h| comm == h) {
            return Some(*p);
        }
    }
    // Fallback: outermost non-helper ancestor. Better than nothing — when the
    // host isn't in GUI_HOSTS (IntelliJ IDEA, custom terminals) System Events
    // can still raise the window via the bare PID.
    comms.last().map(|(p, _)| *p).or_else(|| chain.last().copied())
}

#[cfg(unix)]
fn enrich_with_pid_info(buf: &str) -> String {
    let ppid = parent_id();
    let chain = pid_chain(ppid, 8);
    let source = pick_source_pid(&chain).unwrap_or(ppid);
    let Ok(mut v) = serde_json::from_str::<serde_json::Value>(buf) else {
        return buf.to_string();
    };
    if let Some(obj) = v.as_object_mut() {
        obj.insert("source_pid".into(), serde_json::json!(source));
        obj.insert(
            "pid_chain".into(),
            serde_json::Value::Array(chain.iter().map(|p| serde_json::json!(p)).collect()),
        );
    }
    v.to_string()
}

#[cfg(windows)]
fn enrich_with_pid_info(buf: &str) -> String {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing(),
    );
    let parent_of = |pid: u32| -> Option<u32> {
        let proc = sys.process(Pid::from_u32(pid))?;
        let ppid = proc.parent()?.as_u32();
        if ppid == 0 || ppid == pid { None } else { Some(ppid) }
    };

    let current = std::process::id();
    let start = parent_of(current).unwrap_or(current);
    let mut chain = vec![start];
    let mut cur = start;
    for _ in 0..8 {
        let Some(ppid) = parent_of(cur) else { break };
        chain.push(ppid);
        cur = ppid;
    }
    let source = chain.first().copied().unwrap_or(start);

    let Ok(mut v) = serde_json::from_str::<serde_json::Value>(buf) else {
        return buf.to_string();
    };
    if let Some(obj) = v.as_object_mut() {
        obj.insert("source_pid".into(), serde_json::json!(source));
        obj.insert(
            "pid_chain".into(),
            serde_json::Value::Array(chain.iter().map(|p| serde_json::json!(p)).collect()),
        );
    }
    v.to_string()
}

#[cfg(not(any(unix, windows)))]
fn enrich_with_pid_info(buf: &str) -> String {
    buf.to_string()
}

/// Wrapped JSON the hook returns when nothing answered in time. Matches the
/// shape produced by `server.rs::wrap_decision`, so Claude Code sees identical
/// output whether the widget answered or the hook fell back here.
fn default_permission_deny() -> String {
    serde_json::json!({
        "hookSpecificOutput": {
            "hookEventName": "PermissionRequest",
            "decision": {
                "behavior": "deny",
                "message": "denied by code-crew (no response)",
            }
        }
    })
    .to_string()
}

/// Block on /dev/tty asking the user for permission, return the wrapped JSON.
/// Returns `None` if there's no controlling terminal (the widget thread will
/// carry the decision alone in that case).
///
/// Letter-only shortcuts: `y` / `n` / `a`. Arrow + Enter navigation was tried
/// and removed — Claude Code's native TUI prompt also reads /dev/tty for
/// ↑/↓/Enter, and two readers on the same TTY split each keystroke between
/// them (whoever is blocked in `read()` when the byte lands grabs it). The
/// letters are safe because Claude Code's "Yes/No" prompt doesn't bind y/n/a.
///
/// Single-byte `read` works in both raw and canonical modes; we don't touch
/// termios so the parent's terminal state stays intact whichever thread wins
/// the race. Incoming ESC sequences (arrows, mouse reports) are drained
/// silently so their tail bytes don't get treated as a key on the next read.
#[cfg(unix)]
fn cli_prompt_and_read(payload: &str) -> Option<String> {
    use std::io::Read;

    let v: serde_json::Value = serde_json::from_str(payload).ok()?;
    let tool = v
        .get("tool_name")
        .and_then(|x| x.as_str())
        .unwrap_or("?");

    let mut tty_w = std::fs::OpenOptions::new()
        .write(true)
        .open("/dev/tty")
        .ok()?;
    let mut tty_r = std::fs::OpenOptions::new()
        .read(true)
        .open("/dev/tty")
        .ok()?;

    // Read one byte from /dev/tty. Nested so callers don't need to thread
    // a scratch buffer through every match arm.
    fn read_byte(r: &mut std::fs::File) -> Option<u8> {
        let mut b = [0u8; 1];
        match r.read(&mut b).ok()? {
            0 => None,
            _ => Some(b[0]),
        }
    }

    write!(
        tty_w,
        "\r\n🐾 code-crew: '{}' 허용?  y=한번만 / n=거부 / a=항상  ",
        tool
    )
    .ok()?;
    tty_w.flush().ok()?;

    let key: u8 = loop {
        let b = read_byte(&mut tty_r)?;
        match b {
            b'y' | b'Y' => break b'y',
            b'n' | b'N' => break b'n',
            b'a' | b'A' => break b'a',
            0x1b => {
                // Drain the ESC sequence so its trailing bytes (e.g. `[` `A`
                // for ↑) can't get re-read as an `a` or any other letter on
                // the next iteration. We don't act on arrows or mouse —
                // Claude Code's native prompt owns those.
                let Some(b2) = read_byte(&mut tty_r) else { continue };
                match b2 {
                    b'[' => {
                        let Some(b3) = read_byte(&mut tty_r) else { continue };
                        match b3 {
                            b'M' => {
                                // X10 mouse: 3 trailing bytes (button, x, y).
                                let _ = read_byte(&mut tty_r);
                                let _ = read_byte(&mut tty_r);
                                let _ = read_byte(&mut tty_r);
                            }
                            b'<' => {
                                // SGR mouse: drain until terminator M or m.
                                while let Some(bx) = read_byte(&mut tty_r) {
                                    if bx == b'M' || bx == b'm' { break; }
                                }
                            }
                            _ => {
                                // Other CSI: drain until final byte (0x40-0x7E).
                                if !(0x40..=0x7E).contains(&b3) {
                                    while let Some(bx) = read_byte(&mut tty_r) {
                                        if (0x40..=0x7E).contains(&bx) { break; }
                                    }
                                }
                            }
                        }
                    }
                    b'O' => {
                        // SS3 (alt arrow form): one trailing byte.
                        let _ = read_byte(&mut tty_r);
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    };

    let json = match key {
        b'y' => serde_json::json!({
            "hookSpecificOutput": {
                "hookEventName": "PermissionRequest",
                "decision": { "behavior": "allow" }
            }
        }),
        // "a"/"always" adds a permanent allow rule for this tool. We mirror
        // the shape that the widget's `synthesizeRule` (PermissionInline.tsx)
        // produces so the two paths are byte-identical from Claude's view.
        b'a' => serde_json::json!({
            "hookSpecificOutput": {
                "hookEventName": "PermissionRequest",
                "decision": {
                    "behavior": "allow",
                    "updatedPermissions": [{
                        "type": "addRules",
                        "rules": [{"toolName": tool, "ruleContent": "*"}],
                        "destination": "localSettings",
                        "behavior": "allow",
                    }]
                }
            }
        }),
        _ => serde_json::json!({
            "hookSpecificOutput": {
                "hookEventName": "PermissionRequest",
                "decision": {
                    "behavior": "deny",
                    "message": "denied via code-crew CLI",
                }
            }
        }),
    };
    Some(json.to_string())
}

// Windows has no /dev/tty equivalent we can use the same way; skip the
// CLI prompt race entirely — the widget answers alone on Windows.
#[cfg(not(unix))]
fn cli_prompt_and_read(_payload: &str) -> Option<String> {
    None
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().collect();
    let mode = args.get(1).map(|s| s.as_str()).unwrap_or("event");

    let mut buf = String::new();
    if io::stdin().read_to_string(&mut buf).is_err() {
        return ExitCode::SUCCESS;
    }

    // If the code-crew widget isn't running, the hook MUST be invisible
    // to Claude Code. Earlier behavior fell through to
    // `default_permission_deny`, so every permission prompt during a
    // code-crew outage was silently denied before the user could even
    // see the widget pop up. Probe /health with a tight timeout (code-crew
    // is local, 300ms is more than enough) and exit silently if it
    // doesn't answer — Claude Code's default permission UI then takes
    // over, and event-mirror modes simply no-op.
    let widget_alive = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_millis(300))
        .build()
        .ok()
        .and_then(|c| c.get(format!("{}/health", SERVER)).send().ok())
        .map(|r| r.status().is_success())
        .unwrap_or(false);
    if !widget_alive {
        return ExitCode::SUCCESS;
    }

    // Inject `source_pid` + `pid_chain` so the widget can later raise the
    // owning terminal/IDE window. Capture must happen here — the hook's PPID
    // is Claude Code's node process; walking up from there reaches the GUI.
    let buf = enrich_with_pid_info(&buf);

    if std::env::var("CODE_CREW_DEBUG").is_ok() || std::path::Path::new("/tmp/code-crew-debug").exists() {
        use std::io::Write as _;
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open("/tmp/code-crew-hook.log")
        {
            let _ = writeln!(f, "=== mode={} ===\n{}", mode, buf);
        }
    }

    let Ok(client) = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(610))
        .build()
    else {
        if mode == "permission" {
            // Claude Code reads the full wrapped shape — emitting the legacy
            // bare `{"behavior":"deny"}` here used to look "fine" but Claude
            // ignored it and fell through to its default policy.
            let _ = io::stdout().write_all(default_permission_deny().as_bytes());
        } else if mode == "pretool" {
            let _ = io::stdout().write_all(b"{}");
        }
        return ExitCode::SUCCESS;
    };

    match mode {
        // PermissionRequest hook. We race two answers and let the first one
        // win:
        //   * widget thread — POSTs to our local server's /permission, which
        //     dispatches the event to the React UI and long-polls for the
        //     user's button click.
        //   * tty thread — opens /dev/tty and asks y / n / a directly.
        //
        // Whichever side answers first writes the decision to stdout (the
        // contract Claude Code reads). The other side is abandoned when the
        // process exits — and if the CLI won, the dropped HTTP request makes
        // the server fire a PermissionCancel event so the widget closes its
        // pending UI (see `server.rs::PermissionCleanup`).
        "permission" => {
            use std::sync::mpsc;
            enum Winner {
                Widget,
                Cli,
            }

            let (tx, rx) = mpsc::channel::<(String, Winner)>();

            {
                let tx = tx.clone();
                let body = buf.clone();
                let client = client.clone();
                std::thread::spawn(move || {
                    let resp = client
                        .post(format!("{}/permission", SERVER))
                        .header("content-type", "application/json")
                        .body(body)
                        .send();
                    let result = match resp {
                        Ok(r) => r.text().unwrap_or_else(|_| default_permission_deny()),
                        Err(_) => default_permission_deny(),
                    };
                    let _ = tx.send((result, Winner::Widget));
                });
            }

            {
                let tx = tx.clone();
                let body = buf.clone();
                std::thread::spawn(move || {
                    if let Some(answer) = cli_prompt_and_read(&body) {
                        let _ = tx.send((answer, Winner::Cli));
                    }
                });
            }
            drop(tx);

            let (decision, who) = rx
                .recv()
                .unwrap_or_else(|_| (default_permission_deny(), Winner::Widget));

            if matches!(who, Winner::Widget) {
                // The TTY thread is still parked on read_line with our prompt
                // visible. Wipe that line so Claude Code's next render isn't
                // shoved underneath a stale "허용?" prompt.
                if let Ok(mut tty) = std::fs::OpenOptions::new().write(true).open("/dev/tty") {
                    let _ = tty.write_all(b"\r\x1b[2K");
                }
            }

            let _ = io::stdout().write_all(decision.as_bytes());
            ExitCode::SUCCESS
        }
        "pretool" => {
            let v: serde_json::Value = serde_json::from_str(&buf).unwrap_or(serde_json::Value::Null);
            let tool = v.get("tool_name").and_then(|x| x.as_str()).unwrap_or("");

            let _ = client
                .post(format!("{}/event", SERVER))
                .header("content-type", "application/json")
                .body(buf.clone())
                .send();

            if SAFE_TOOLS.contains(&tool) {
                return ExitCode::SUCCESS;
            }

            let resp = client
                .post(format!("{}/permission", SERVER))
                .header("content-type", "application/json")
                .body(buf)
                .send();

            let decision = match resp {
                Ok(r) => r.text().unwrap_or_else(|_| "{\"behavior\":\"deny\"}".into()),
                Err(_) => "{\"behavior\":\"deny\"}".into(),
            };

            let parsed: serde_json::Value =
                serde_json::from_str(&decision).unwrap_or(serde_json::Value::Null);
            // Server wraps the decision per Claude Code's HTTP hook spec; the
            // legacy top-level `behavior` form is kept as a fallback.
            let behavior = parsed
                .pointer("/hookSpecificOutput/decision/behavior")
                .and_then(|x| x.as_str())
                .or_else(|| parsed.get("behavior").and_then(|x| x.as_str()))
                .unwrap_or("deny");

            let out = if behavior == "allow" {
                serde_json::json!({
                    "hookSpecificOutput": {
                        "hookEventName": "PreToolUse",
                        "permissionDecision": "allow",
                        "permissionDecisionReason": "approved via code-crew widget"
                    }
                })
            } else {
                serde_json::json!({
                    "hookSpecificOutput": {
                        "hookEventName": "PreToolUse",
                        "permissionDecision": "deny",
                        "permissionDecisionReason": "denied via code-crew widget"
                    }
                })
            };
            let _ = io::stdout().write_all(out.to_string().as_bytes());
            ExitCode::SUCCESS
        }
        _ => {
            let _ = client
                .post(format!("{}/event", SERVER))
                .header("content-type", "application/json")
                .body(buf)
                .send();
            ExitCode::SUCCESS
        }
    }
}
