use crate::events::Event;
use chrono::{Datelike, Utc};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::sync::mpsc::UnboundedSender;

pub fn codex_session_dir() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let now = Utc::now();
    Some(
        home.join(".codex")
            .join("sessions")
            .join(format!("{:04}", now.year()))
            .join(format!("{:02}", now.month()))
            .join(format!("{:02}", now.day())),
    )
}

pub async fn run(tx: UnboundedSender<Event>) {
    let mut offsets: HashMap<PathBuf, u64> = HashMap::new();
    let mut parent_map: HashMap<PathBuf, String> = HashMap::new();
    // call_ids of Codex permission requests we've surfaced to the UI but not
    // yet seen resolved. Persists across poll batches so a later batch's
    // function_call_output can close the matching card prompt.
    let mut seen_perm: HashSet<String> = HashSet::new();
    loop {
        if let Some(dir) = codex_session_dir() {
            if dir.exists() {
                if let Ok(entries) = fs::read_dir(&dir) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        let fname = match path.file_name().and_then(|s| s.to_str()) {
                            Some(s) => s.to_string(),
                            None => continue,
                        };
                        if !fname.starts_with("rollout-") || !fname.ends_with(".jsonl") {
                            continue;
                        }
                        let _ = poll_file(&path, &mut offsets, &mut parent_map, &mut seen_perm, &tx);
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(1500)).await;
    }
}

fn poll_file(
    path: &Path,
    offsets: &mut HashMap<PathBuf, u64>,
    parent_map: &mut HashMap<PathBuf, String>,
    seen_perm: &mut HashSet<String>,
    tx: &UnboundedSender<Event>,
) -> std::io::Result<()> {
    let bytes = fs::read(path)?;
    let last = offsets.get(path).copied().unwrap_or(0);
    if (bytes.len() as u64) <= last {
        return Ok(());
    }
    let session_pid = if !offsets.contains_key(path) {
        pid_holding_file(path)
    } else {
        None
    };
    let new_slice = &bytes[last as usize..];
    let session_id = derive_session_id(path);

    let parsed: Vec<Value> = new_slice
        .split(|b| *b == b'\n')
        .filter(|l| !l.is_empty())
        .filter_map(|l| std::str::from_utf8(l).ok())
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .collect();
    if last == 0 && last_task_event_is_complete(&parsed) {
        offsets.insert(path.to_path_buf(), bytes.len() as u64);
        return Ok(());
    }
    let resolved_outputs = collect_output_call_ids(&parsed);

    for v in &parsed {
        if let Some(ev) = map_codex_line(&session_id, path, v, parent_map, session_pid) {
            if let Event::PermissionRequest { request_id, .. } = &ev {
                if let Some(call_id) = request_id.strip_prefix("codex-") {
                    // Already resolved inside this same batch (typical on a
                    // catch-up read after restart) — never surface a prompt
                    // that's already been answered.
                    if resolved_outputs.contains(call_id) {
                        continue;
                    }
                    // Remember it so a later batch's output can close it.
                    seen_perm.insert(call_id.to_string());
                }
            }
            let _ = tx.send(ev);
        }
    }

    // Cross-batch resolution. Codex blocks on the user's keypress in its own
    // TUI, so a permission request and its result land in different poll
    // batches. When the function_call_output finally appears we cancel the
    // request we surfaced earlier — otherwise the card keeps piling up prompts
    // that were already answered in the terminal. Codex writes an output
    // whether the command was approved or denied, so both clear correctly.
    for call_id in &resolved_outputs {
        if seen_perm.remove(call_id) {
            let _ = tx.send(Event::PermissionCancel {
                request_id: format!("codex-{}", call_id),
            });
        }
    }

    offsets.insert(path.to_path_buf(), bytes.len() as u64);
    Ok(())
}

fn last_task_event_is_complete(items: &[Value]) -> bool {
    items
        .iter()
        .filter_map(|v| {
            if v.get("type").and_then(|x| x.as_str()) != Some("event_msg") {
                return None;
            }
            v.get("payload")
                .and_then(|p| p.get("type"))
                .and_then(|x| x.as_str())
                .filter(|kind| *kind == "task_started" || *kind == "task_complete")
        })
        .last()
        == Some("task_complete")
}

fn pid_holding_file(path: &Path) -> Option<u32> {
    let path_str = path.to_str()?;
    let output = std::process::Command::new("lsof")
        .args(["-t", path_str])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout.lines().next()?.trim().parse().ok()
}

fn collect_output_call_ids(items: &[Value]) -> std::collections::HashSet<String> {
    let mut out = std::collections::HashSet::new();
    for v in items {
        if v.get("type").and_then(|x| x.as_str()) != Some("response_item") {
            continue;
        }
        let p = match v.get("payload") {
            Some(p) => p,
            None => continue,
        };
        if !p
            .get("type")
            .and_then(|x| x.as_str())
            .map(is_tool_output)
            .unwrap_or(false)
        {
            continue;
        }
        if let Some(cid) = p.get("call_id").and_then(|x| x.as_str()) {
            out.insert(cid.to_string());
        }
    }
    out
}

fn is_tool_call(kind: &str) -> bool {
    kind.ends_with("_call")
}

fn is_tool_output(kind: &str) -> bool {
    kind.ends_with("_output")
}

fn parse_tool_args(p: &Value) -> Value {
    p.get("arguments")
        .or_else(|| p.get("input"))
        .and_then(|x| {
            x.as_str()
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
                .or_else(|| Some(x.clone()))
        })
        .unwrap_or(Value::Null)
}

fn tool_name_for_payload(kind: &str, p: &Value) -> String {
    p.get("name")
        .and_then(|x| x.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| kind.strip_suffix("_call").unwrap_or(kind).to_string())
}

fn codex_rate_limit_reached(payload: Option<&Value>) -> bool {
    payload
        .and_then(|p| p.get("rate_limits"))
        .and_then(|r| r.get("rate_limit_reached_type"))
        .map(|v| !v.is_null())
        .unwrap_or(false)
}

fn derive_session_id(path: &Path) -> String {
    let stem = path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("codex")
        .to_string();
    if stem.starts_with("rollout-") && stem.len() >= 36 {
        stem[stem.len() - 36..].to_string()
    } else {
        stem
    }
}

fn is_session_end_command(message: &str) -> bool {
    matches!(
        message.trim().to_ascii_lowercase().as_str(),
        "exit" | "/exit" | "clear" | "/clear"
    )
}

fn map_codex_line(
    session_id: &str,
    path: &Path,
    v: &Value,
    parent_map: &mut HashMap<PathBuf, String>,
    session_pid: Option<u32>,
) -> Option<Event> {
    let top_kind = v.get("type").and_then(|x| x.as_str())?;
    let payload = v.get("payload");
    let inner_kind = payload.and_then(|p| p.get("type")).and_then(|x| x.as_str());
    let fallback_cwd = String::new();
    let payload_cwd = payload
        .and_then(|p| p.get("cwd"))
        .and_then(|x| x.as_str())
        .map(str::to_string);

    let path_str = path.to_string_lossy().to_string();
    let parent_for_path = parent_map.get(path).cloned();
    let routed_session = parent_for_path
        .clone()
        .unwrap_or_else(|| session_id.to_string());
    let routed_transcript = if parent_for_path.is_some() {
        Some(path_str.clone())
    } else {
        None
    };

    match top_kind {
        "session_meta" => {
            // Detect Codex subagent (thread_spawn) and route to parent session.
            let thread_spawn = payload
                .and_then(|p| p.get("source"))
                .and_then(|s| s.get("subagent"))
                .and_then(|s| s.get("thread_spawn"));
            let parent_thread_id = thread_spawn
                .and_then(|t| t.get("parent_thread_id"))
                .and_then(|x| x.as_str())
                .map(str::to_string);
            if let Some(parent_id) = parent_thread_id {
                parent_map.insert(path.to_path_buf(), parent_id.clone());
                let nickname = payload
                    .and_then(|p| p.get("agent_nickname"))
                    .and_then(|x| x.as_str())
                    .or_else(|| {
                        thread_spawn
                            .and_then(|t| t.get("agent_nickname"))
                            .and_then(|x| x.as_str())
                    })
                    .map(str::to_string);
                let role = payload
                    .and_then(|p| p.get("agent_role"))
                    .and_then(|x| x.as_str())
                    .or_else(|| {
                        thread_spawn
                            .and_then(|t| t.get("agent_role"))
                            .and_then(|x| x.as_str())
                    })
                    .map(str::to_string);
                let label = nickname
                    .or(role)
                    .unwrap_or_else(|| "subagent".into());
                Some(Event::SubagentStart {
                    session_id: parent_id,
                    cwd: payload_cwd.or(Some(fallback_cwd)),
                    subagent_id: format!("codex-{}", session_id),
                    subagent_type: label,
                    transcript_path: Some(path_str),
                })
            } else {
                Some(Event::SessionStart {
                    session_id: session_id.to_string(),
                    cwd: payload_cwd.unwrap_or(fallback_cwd),
                    agent_type: "codex".into(),
                    source_pid: session_pid,
                    pid_chain: None,
                })
            }
        }
        "event_msg" => match inner_kind? {
            "task_started" => Some(Event::UserPromptSubmit {
                session_id: routed_session,
                cwd: payload_cwd.or(Some(fallback_cwd)),
                source_pid: None,
                pid_chain: None,
            }),
            "task_complete" => {
                if parent_for_path.is_some() {
                    Some(Event::SubagentStop {
                        session_id: routed_session,
                        cwd: payload_cwd.or(Some(fallback_cwd)),
                        subagent_id: format!("codex-{}", session_id),
                    })
                } else {
                    Some(Event::Stop {
                        session_id: routed_session,
                        cwd: payload_cwd.or(Some(fallback_cwd)),
                        source_pid: None,
                        pid_chain: None,
                    })
                }
            }
            "user_message" => {
                let msg = payload
                    .and_then(|p| p.get("message"))
                    .and_then(|x| x.as_str())?;
                if parent_for_path.is_none() && is_session_end_command(msg) {
                    Some(Event::SessionEnd {
                        session_id: routed_session,
                    })
                } else {
                    None
                }
            }
            "agent_message" => {
                let msg = payload
                    .and_then(|p| p.get("message"))
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                Some(Event::Notification {
                    session_id: routed_session,
                    cwd: payload_cwd.or(Some(fallback_cwd)),
                    message: msg,
                    source_pid: None,
                    pid_chain: None,
                })
            }
            "token_count" if codex_rate_limit_reached(payload) => Some(Event::Stop {
                session_id: routed_session,
                cwd: payload_cwd.or(Some(fallback_cwd)),
                source_pid: None,
                pid_chain: None,
            }),
            _ => None,
        },
        "response_item" => {
            let inner_kind = inner_kind?;
            if is_tool_call(inner_kind) {
                let p = payload?;
                let name = tool_name_for_payload(inner_kind, p);
                let args = parse_tool_args(p);
                let requires_permission = name == "shell_command"
                    || args
                        .get("sandbox_permissions")
                        .and_then(|x| x.as_str())
                        .map(|x| x == "require_escalated")
                        .unwrap_or(false);
                if requires_permission {
                    let request_id = p
                        .get("call_id")
                        .and_then(|x| x.as_str())
                        .map(|x| format!("codex-{}", x))
                        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                    return Some(Event::PermissionRequest {
                        session_id: routed_session,
                        cwd: payload_cwd.or(Some(fallback_cwd)),
                        tool_name: name,
                        tool_input: args,
                        request_id,
                        suggestions: Value::Null,
                        agent_name: None,
                        source_pid: None,
                        pid_chain: None,
                    });
                }
                return Some(Event::PreToolUse {
                    session_id: routed_session,
                    cwd: payload_cwd.or(Some(fallback_cwd)),
                    tool_name: name,
                    tool_input: args,
                    transcript_path: routed_transcript,
                    agent_name: None,
                    source_pid: None,
                    pid_chain: None,
                });
            }
            if is_tool_output(inner_kind) {
                let output = payload
                    .and_then(|p| p.get("output"))
                    .and_then(|x| x.as_str())
                    .unwrap_or("");
                let success = !output.contains("Process exited with code 1")
                    && !output.contains("Process exited with code 2")
                    && !output.contains("Process exited with code 127");
                return Some(Event::PostToolUse {
                    session_id: routed_session,
                    cwd: payload_cwd.or(Some(fallback_cwd)),
                    tool_name: inner_kind
                        .strip_suffix("_output")
                        .unwrap_or(inner_kind)
                        .to_string(),
                    success,
                    transcript_path: routed_transcript,
                    agent_name: None,
                    source_pid: None,
                    pid_chain: None,
                });
            }
            None
        },
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn maps_function_call() {
        let v = json!({
            "type": "response_item",
            "payload": {
                "type": "function_call",
                "name": "exec_command",
                "arguments": "{\"cmd\":\"ls\"}",
                "call_id": "c1"
            }
        });
        let mut pm = HashMap::new();
        let ev = map_codex_line("rollout-abc", Path::new("/x/rollout-abc.jsonl"), &v, &mut pm, None)
            .unwrap();
        match ev {
            Event::PreToolUse { tool_name, tool_input, .. } => {
                assert_eq!(tool_name, "exec_command");
                assert_eq!(tool_input["cmd"], "ls");
            }
            _ => panic!(),
        }
    }

    #[test]
    fn maps_custom_tool_call() {
        let v = json!({
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call",
                "name": "apply_patch",
                "input": "*** Begin Patch\n*** End Patch\n",
                "call_id": "c1"
            }
        });
        let mut pm = HashMap::new();
        let ev = map_codex_line("rollout-abc", Path::new("/x/rollout-abc.jsonl"), &v, &mut pm, None)
            .unwrap();
        match ev {
            Event::PreToolUse { tool_name, tool_input, .. } => {
                assert_eq!(tool_name, "apply_patch");
                assert_eq!(tool_input, "*** Begin Patch\n*** End Patch\n");
            }
            _ => panic!(),
        }
    }

    #[test]
    fn maps_session_meta() {
        let v = json!({
            "type": "session_meta",
            "payload": {"id": "s1", "cwd": "/tmp/proj"}
        });
        let mut pm = HashMap::new();
        let ev = map_codex_line("s1", Path::new("/x/r.jsonl"), &v, &mut pm, None).unwrap();
        match ev {
            Event::SessionStart { cwd, source_pid, .. } => {
                assert_eq!(cwd, "/tmp/proj");
                assert_eq!(source_pid, None);
            }
            _ => panic!(),
        }
    }

    #[test]
    fn session_meta_carries_session_pid() {
        let v = json!({
            "type": "session_meta",
            "payload": {"id": "s1", "cwd": "/tmp/proj"}
        });
        let mut pm = HashMap::new();
        let ev = map_codex_line("s1", Path::new("/x/r.jsonl"), &v, &mut pm, Some(4242)).unwrap();
        match ev {
            Event::SessionStart { source_pid, .. } => assert_eq!(source_pid, Some(4242)),
            _ => panic!("expected SessionStart"),
        }
    }

    #[test]
    fn maps_task_complete() {
        let v = json!({"type": "event_msg", "payload": {"type": "task_complete"}});
        let mut pm = HashMap::new();
        let ev = map_codex_line("s1", Path::new("/x/r.jsonl"), &v, &mut pm, None).unwrap();
        assert!(matches!(ev, Event::Stop { .. }));
    }

    #[test]
    fn maps_task_started_without_synthetic_tool_message() {
        let v = json!({"type": "event_msg", "payload": {"type": "task_started"}});
        let mut pm = HashMap::new();
        let ev = map_codex_line("s1", Path::new("/x/r.jsonl"), &v, &mut pm, None).unwrap();
        assert!(matches!(ev, Event::UserPromptSubmit { session_id, .. } if session_id == "s1"));
    }

    #[test]
    fn maps_codex_rate_limit_token_count_to_stop() {
        let v = json!({
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "rate_limits": {
                    "rate_limit_reached_type": "primary"
                }
            }
        });
        let mut pm = HashMap::new();
        let ev = map_codex_line("s1", Path::new("/x/r.jsonl"), &v, &mut pm, None).unwrap();
        assert!(matches!(ev, Event::Stop { session_id, .. } if session_id == "s1"));
    }

    #[test]
    fn ignores_codex_token_count_until_limit_is_reached() {
        let v = json!({
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "rate_limits": {
                    "rate_limit_reached_type": null
                }
            }
        });
        let mut pm = HashMap::new();
        assert!(map_codex_line("s1", Path::new("/x/r.jsonl"), &v, &mut pm, None).is_none());
    }

    #[test]
    fn exact_user_exit_command_ends_session() {
        let v = json!({
            "type": "event_msg",
            "payload": {"type": "user_message", "message": "exit\n"}
        });
        let mut pm = HashMap::new();
        let ev = map_codex_line("s1", Path::new("/x/r.jsonl"), &v, &mut pm, None)
            .unwrap();
        assert!(matches!(ev, Event::SessionEnd { session_id } if session_id == "s1"));
    }

    #[test]
    fn exact_user_clear_command_ends_session() {
        let v = json!({
            "type": "event_msg",
            "payload": {"type": "user_message", "message": "/clear"}
        });
        let mut pm = HashMap::new();
        let ev = map_codex_line("s1", Path::new("/x/r.jsonl"), &v, &mut pm, None)
            .unwrap();
        assert!(matches!(ev, Event::SessionEnd { session_id } if session_id == "s1"));
    }

    #[test]
    fn prose_mentions_of_exit_or_clear_do_not_end_session() {
        let v = json!({
            "type": "event_msg",
            "payload": {
                "type": "user_message",
                "message": "Does /clear behave like exit, or should I restart the project?"
            }
        });
        let mut pm = HashMap::new();
        assert!(map_codex_line("s1", Path::new("/x/r.jsonl"), &v, &mut pm, None).is_none());
    }

    #[test]
    fn unknown_returns_none() {
        let v = json!({"type":"random"});
        let mut pm = HashMap::new();
        assert!(map_codex_line("s", Path::new("/x/r.jsonl"), &v, &mut pm, None).is_none());
    }

    #[test]
    fn subagent_meta_routes_to_parent() {
        let v = json!({
            "type": "session_meta",
            "payload": {
                "id": "child-id",
                "cwd": "/tmp/proj",
                "source": {
                    "subagent": {
                        "thread_spawn": {
                            "parent_thread_id": "parent-id",
                            "agent_nickname": "Ohm",
                            "agent_role": "explorer"
                        }
                    }
                }
            }
        });
        let mut pm = HashMap::new();
        let p = Path::new("/x/rollout-child.jsonl");
        let ev = map_codex_line("child-id", p, &v, &mut pm, None).unwrap();
        match ev {
            Event::SubagentStart {
                session_id,
                subagent_type,
                transcript_path,
                ..
            } => {
                assert_eq!(session_id, "parent-id");
                assert_eq!(subagent_type, "Ohm");
                assert_eq!(transcript_path.as_deref(), Some("/x/rollout-child.jsonl"));
            }
            _ => panic!("expected SubagentStart"),
        }
        assert_eq!(pm.get(p).map(String::as_str), Some("parent-id"));
    }

    #[test]
    fn subagent_function_call_routes_to_parent_with_transcript() {
        let p = Path::new("/x/rollout-child.jsonl");
        let mut pm = HashMap::new();
        pm.insert(p.to_path_buf(), "parent-id".to_string());
        let v = json!({
            "type": "response_item",
            "payload": {
                "type": "function_call",
                "name": "exec_command",
                "arguments": "{\"cmd\":\"ls\"}"
            }
        });
        let ev = map_codex_line("child-id", p, &v, &mut pm, None).unwrap();
        match ev {
            Event::PreToolUse {
                session_id,
                tool_name,
                transcript_path,
                ..
            } => {
                assert_eq!(session_id, "parent-id");
                assert_eq!(tool_name, "exec_command");
                assert_eq!(transcript_path.as_deref(), Some("/x/rollout-child.jsonl"));
            }
            _ => panic!("expected PreToolUse"),
        }
    }

    #[test]
    fn collects_function_call_output_ids() {
        let items = vec![
            json!({"type":"response_item","payload":{"type":"function_call","name":"x","call_id":"c1"}}),
            json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":"ok"}}),
            json!({"type":"response_item","payload":{"type":"function_call","name":"x","call_id":"c2"}}),
            json!({"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"c3","output":"ok"}}),
            json!({"type":"event_msg","payload":{"type":"task_complete"}}),
        ];
        let set = collect_output_call_ids(&items);
        assert!(set.contains("c1"));
        assert!(set.contains("c3"));
        assert!(!set.contains("c2"));
        assert_eq!(set.len(), 2);
    }

    #[test]
    fn subagent_task_complete_emits_subagent_stop() {
        let p = Path::new("/x/rollout-child.jsonl");
        let mut pm = HashMap::new();
        pm.insert(p.to_path_buf(), "parent-id".to_string());
        let v = json!({"type": "event_msg", "payload": {"type": "task_complete"}});
        let ev = map_codex_line("child-id", p, &v, &mut pm, None).unwrap();
        match ev {
            Event::SubagentStop { session_id, subagent_id, .. } => {
                assert_eq!(session_id, "parent-id");
                assert_eq!(subagent_id, "codex-child-id");
            }
            _ => panic!("expected SubagentStop"),
        }
    }

    fn escalated_call_line(call_id: &str) -> String {
        let args = serde_json::to_string(&json!({
            "cmd": "rm x",
            "sandbox_permissions": "require_escalated"
        }))
        .unwrap();
        json!({
            "type": "response_item",
            "payload": {
                "type": "function_call",
                "name": "exec_command",
                "call_id": call_id,
                "arguments": args
            }
        })
        .to_string()
    }

    fn output_line(call_id: &str) -> String {
        json!({
            "type": "response_item",
            "payload": {"type": "function_call_output", "call_id": call_id, "output": "ok"}
        })
        .to_string()
    }

    fn temp_rollout() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cc-codex-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("rollout-2026-06-04T00-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl")
    }

    fn drain(rx: &mut tokio::sync::mpsc::UnboundedReceiver<Event>) -> Vec<Event> {
        std::iter::from_fn(|| rx.try_recv().ok()).collect()
    }

    // The bug: Codex blocks on the user's keypress in its own TUI, so the
    // permission request and its result land in different poll batches. The
    // card must clear when the output arrives in a *later* batch.
    #[test]
    fn output_in_later_batch_cancels_surfaced_permission() {
        use std::io::Write;
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let path = temp_rollout();
        let mut offsets = HashMap::new();
        let mut pm = HashMap::new();
        let mut seen = HashSet::new();

        // Batch 1: an escalated exec_command — surfaced, no output yet.
        std::fs::write(&path, format!("{}\n", escalated_call_line("call_1"))).unwrap();
        poll_file(&path, &mut offsets, &mut pm, &mut seen, &tx).unwrap();
        let b1 = drain(&mut rx);
        assert!(
            b1.iter().any(|e| matches!(e, Event::PermissionRequest { request_id, .. } if request_id == "codex-call_1")),
            "batch 1 must surface the permission request"
        );
        assert!(
            !b1.iter().any(|e| matches!(e, Event::PermissionCancel { .. })),
            "batch 1 must not cancel before any output exists"
        );
        assert!(seen.contains("call_1"));

        // Batch 2: the output lands later (user approved in the terminal).
        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(f, "{}", output_line("call_1")).unwrap();
        drop(f);
        poll_file(&path, &mut offsets, &mut pm, &mut seen, &tx).unwrap();
        let b2 = drain(&mut rx);
        assert!(
            b2.iter().any(|e| matches!(e, Event::PermissionCancel { request_id } if request_id == "codex-call_1")),
            "batch 2 must cancel the now-resolved permission request"
        );
        assert!(!seen.contains("call_1"), "seen set must be cleared after the cancel");

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn initial_completed_file_is_not_replayed_even_when_process_is_alive() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let path = temp_rollout();
        let mut offsets = HashMap::new();
        let mut pm = HashMap::new();
        let mut seen = HashSet::new();

        std::fs::write(
            &path,
            format!(
                "{}\n{}\n",
                json!({"type":"session_meta","payload":{"cwd":"/tmp/proj"}}),
                json!({"type":"event_msg","payload":{"type":"task_complete"}})
            ),
        )
        .unwrap();

        let current_pid = std::process::id();
        let session_id = derive_session_id(&path);
        let bytes = std::fs::read(&path).unwrap();
        let parsed: Vec<Value> = bytes
            .split(|b| *b == b'\n')
            .filter(|l| !l.is_empty())
            .filter_map(|l| std::str::from_utf8(l).ok())
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .collect();

        assert!(last_task_event_is_complete(&parsed));
        for v in &parsed {
            let _ = map_codex_line(&session_id, &path, v, &mut pm, Some(current_pid));
        }

        poll_file(&path, &mut offsets, &mut pm, &mut seen, &tx).unwrap();

        assert!(
            drain(&mut rx).is_empty(),
            "completed catch-up files must not recreate old cards"
        );
        assert_eq!(
            offsets.get(&path).copied(),
            Some(std::fs::metadata(&path).unwrap().len())
        );

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn initial_file_with_unfinished_latest_turn_is_replayed() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let path = temp_rollout();
        let mut offsets = HashMap::new();
        let mut pm = HashMap::new();
        let mut seen = HashSet::new();

        std::fs::write(
            &path,
            format!(
                "{}\n{}\n{}\n",
                json!({"type":"session_meta","payload":{"cwd":"/tmp/proj"}}),
                json!({"type":"event_msg","payload":{"type":"task_complete"}}),
                json!({"type":"event_msg","payload":{"type":"task_started"}})
            ),
        )
        .unwrap();

        poll_file(&path, &mut offsets, &mut pm, &mut seen, &tx).unwrap();

        assert!(
            drain(&mut rx).iter().any(|e| matches!(e, Event::UserPromptSubmit { .. })),
            "an unfinished latest turn must still appear in the UI"
        );

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    // Catch-up read on restart: request and output already both present. We
    // must neither surface a stale prompt nor emit a spurious cancel.
    #[test]
    fn request_and_output_same_batch_neither_surfaces_nor_cancels() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let path = temp_rollout();
        let mut offsets = HashMap::new();
        let mut pm = HashMap::new();
        let mut seen = HashSet::new();

        std::fs::write(
            &path,
            format!("{}\n{}\n", escalated_call_line("c9"), output_line("c9")),
        )
        .unwrap();
        poll_file(&path, &mut offsets, &mut pm, &mut seen, &tx).unwrap();
        let evs = drain(&mut rx);
        assert!(
            !evs.iter().any(|e| matches!(e, Event::PermissionRequest { .. })),
            "a request resolved within the same batch must be suppressed"
        );
        assert!(
            !evs.iter().any(|e| matches!(e, Event::PermissionCancel { .. })),
            "nothing to cancel when the request was never surfaced"
        );
        assert!(seen.is_empty());

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
