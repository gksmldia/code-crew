use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

const EVENT_NAMES: &[&str] = &[
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    // Claude Code fires PostToolUseFailure (not PostToolUse) when a tool call
    // fails — e.g. a Bash command exiting non-zero, a Read on a missing path.
    // Without this subscription the pet never enters the "error" state.
    "PostToolUseFailure",
    "SubagentStart",
    "SubagentStop",
    "Stop",
    "Notification",
];

pub fn settings_path() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".claude").join("settings.json"))
}

pub fn install(hook_binary_path: &str) -> std::io::Result<()> {
    let path = settings_path()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no home"))?;
    install_at(&path, hook_binary_path)
}

// Any settings entry whose `hooks[].command` references our binary is treated
// as ours — including stale subcommand forms (e.g. `code-crew-hook pretool`
// left over from older installs). We strip those on reinstall and re-push a
// fresh entry, so the user never has to hand-edit settings.json when we rename
// a subcommand or relocate the binary.
fn is_our_command_entry(entry: &Value) -> bool {
    entry
        .get("hooks")
        .and_then(|h| h.as_array())
        .map(|hs| {
            hs.iter().any(|h| {
                h.get("command")
                    .and_then(|c| c.as_str())
                    .map(|s| s.contains("code-crew-hook"))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

pub fn install_at(settings_path: &Path, hook_binary_path: &str) -> std::io::Result<()> {
    fs::create_dir_all(settings_path.parent().unwrap())?;
    let mut root: Value = if settings_path.exists() {
        let bytes = fs::read(settings_path)?;
        serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({}))
    } else {
        json!({})
    };
    let hooks = root
        .as_object_mut()
        .unwrap()
        .entry("hooks")
        .or_insert(json!({}));
    let hooks_obj = hooks.as_object_mut().unwrap();

    for ev in EVENT_NAMES {
        let arr = hooks_obj.entry(*ev).or_insert(json!([]));
        let arr = arr.as_array_mut().unwrap();
        // Drop any existing entry that points at our hook binary — regardless
        // of subcommand or binary path — then push a fresh one. Earlier code
        // used a contains-check that preserved stale entries: a
        // `code-crew-hook pretool` line survived every reinstall even though
        // the binary no longer understood that mode.
        arr.retain(|item| !is_our_command_entry(item));
        arr.push(json!({
            "matcher": "*",
            "hooks": [
                {
                    "type": "command",
                    "command": format!("\"{}\" event", hook_binary_path),
                }
            ]
        }));
    }

    // PermissionRequest is registered as `type: command` (not `type: http`) so
    // the hook binary can race the widget against a /dev/tty prompt — that's
    // what enables the Allow/Deny choice to appear in BOTH places with
    // whichever responds first winning. Earlier versions used `type: http`
    // (long-poll only); we strip those legacy entries here so reinstalls
    // upgrade cleanly.
    let perm_arr = hooks_obj
        .entry("PermissionRequest")
        .or_insert(json!([]));
    let perm_arr = perm_arr.as_array_mut().unwrap();
    perm_arr.retain(|item| {
        let legacy_http = item
            .get("hooks")
            .and_then(|h| h.as_array())
            .map(|hs| {
                hs.iter().any(|h| {
                    h.get("url")
                        .and_then(|u| u.as_str())
                        .map(|s| s.contains("19876"))
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false);
        !(legacy_http || is_our_command_entry(item))
    });
    perm_arr.push(json!({
        "matcher": "*",
        "hooks": [
            {
                "type": "command",
                "command": format!("\"{}\" permission", hook_binary_path),
            }
        ]
    }));

    let pretty = serde_json::to_vec_pretty(&root)?;
    let tmp = settings_path.with_extension("json.tmp");
    fs::write(&tmp, pretty)?;
    fs::rename(tmp, settings_path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    // Per-test isolated settings path. No HOME mutation — that's process-wide
    // state and breaks `cargo test` defaults (parallel threads stomp on each
    // other). install_at takes the path explicitly so tests can pass a tmp
    // path without touching env.
    fn tmp_settings() -> PathBuf {
        let dir = env::temp_dir().join(format!("code-crew-install-{}", uuid::Uuid::new_v4()));
        dir.join(".claude").join("settings.json")
    }

    #[test]
    fn creates_settings_with_all_events() {
        let path = tmp_settings();
        install_at(&path, "/path/to/code-crew-hook").unwrap();
        let v: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        for ev in EVENT_NAMES {
            assert!(v["hooks"][ev].is_array(), "missing {}", ev);
            assert_eq!(v["hooks"][ev].as_array().unwrap().len(), 1);
        }
        let perm = v["hooks"]["PermissionRequest"].as_array().unwrap();
        assert_eq!(perm.len(), 1);
        let inner = &perm[0]["hooks"][0];
        assert_eq!(inner["type"], "command");
        let cmd = inner["command"].as_str().unwrap();
        assert!(cmd.contains("code-crew-hook"), "command should reference binary: {}", cmd);
        assert!(cmd.ends_with(" permission"), "command should end in subcommand: {}", cmd);
    }

    #[test]
    fn idempotent_install() {
        let path = tmp_settings();
        install_at(&path, "/path/to/code-crew-hook").unwrap();
        install_at(&path, "/path/to/code-crew-hook").unwrap();
        let v: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        for ev in EVENT_NAMES {
            assert_eq!(v["hooks"][ev].as_array().unwrap().len(), 1, "duplicated {}", ev);
        }
        assert_eq!(
            v["hooks"]["PermissionRequest"].as_array().unwrap().len(),
            1,
            "duplicated PermissionRequest"
        );
    }

    #[test]
    fn migrates_legacy_http_permission_to_command() {
        // Earlier versions of code-crew registered the PermissionRequest hook
        // as `type: http` so the server could long-poll. The current design
        // needs `type: command` (so the hook binary can race the widget vs
        // /dev/tty). Reinstalls must strip the old HTTP entry, not stack
        // alongside it — otherwise Claude Code fires both forms.
        let path = tmp_settings();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r#"{"hooks":{"PermissionRequest":[{"matcher":"*","hooks":[{"type":"http","url":"http://127.0.0.1:19876/permission"}]}]}}"#,
        )
        .unwrap();
        install_at(&path, "/path/to/code-crew-hook").unwrap();
        let v: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let arr = v["hooks"]["PermissionRequest"].as_array().unwrap();
        assert_eq!(arr.len(), 1, "legacy http entry should have been removed");
        let inner = &arr[0]["hooks"][0];
        assert_eq!(inner["type"], "command");
        assert!(inner["command"].as_str().unwrap().contains("code-crew-hook"));
    }

    #[test]
    fn migrates_stale_pretool_subcommand_to_event() {
        // Earlier install code used `s.contains("code-crew-hook")` to decide
        // "already installed" with no check on the subcommand, so a stale
        // `code-crew-hook pretool` entry (from a renamed mode) survived
        // every reinstall forever. The user had to hand-edit settings.json
        // to fix it. Reinstall must now strip and rewrite our entry — even
        // when only the subcommand or binary path changed.
        let path = tmp_settings();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r#"{"hooks":{"PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"/old/path/code-crew-hook pretool"}]}]}}"#,
        )
        .unwrap();
        install_at(&path, "/new/path/code-crew-hook").unwrap();
        let v: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let arr = v["hooks"]["PreToolUse"].as_array().unwrap();
        assert_eq!(
            arr.len(),
            1,
            "stale subcommand entry should have been replaced, not stacked"
        );
        let cmd = arr[0]["hooks"][0]["command"].as_str().unwrap();
        assert_eq!(
            cmd, "\"/new/path/code-crew-hook\" event",
            "subcommand should be refreshed to `event` with the new binary path"
        );
    }

    #[test]
    fn preserves_other_settings() {
        let path = tmp_settings();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, r#"{"theme":"dark","hooks":{"PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"echo other"}]}]}}"#).unwrap();
        install_at(&path, "/path/to/code-crew-hook").unwrap();
        let v: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(v["theme"], "dark");
        let pre = v["hooks"]["PreToolUse"].as_array().unwrap();
        assert_eq!(pre.len(), 2);
    }
}
