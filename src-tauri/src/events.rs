use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum Event {
    SessionStart {
        session_id: String,
        cwd: String,
        agent_type: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source_pid: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pid_chain: Option<Vec<u32>>,
    },
    SessionEnd {
        session_id: String,
    },
    /// Fires when the user submits a prompt — Claude is about to start
    /// generating a response (which may or may not invoke tools). Without
    /// this signal the pet stays "idle" between Stop and the first
    /// PreToolUse, and never leaves idle at all for pure-text responses.
    UserPromptSubmit {
        session_id: String,
        cwd: Option<String>,
    },
    PreToolUse {
        session_id: String,
        cwd: Option<String>,
        tool_name: String,
        tool_input: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        transcript_path: Option<String>,
        /// Subagent display name when the hook fires inside a subagent;
        /// `None` for the main agent.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent_name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source_pid: Option<u32>,
    },
    PostToolUse {
        session_id: String,
        cwd: Option<String>,
        tool_name: String,
        success: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        transcript_path: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent_name: Option<String>,
    },
    SubagentStart {
        session_id: String,
        cwd: Option<String>,
        subagent_id: String,
        subagent_type: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        transcript_path: Option<String>,
    },
    SubagentStop {
        session_id: String,
        cwd: Option<String>,
        subagent_id: String,
    },
    PermissionRequest {
        session_id: String,
        cwd: Option<String>,
        tool_name: String,
        tool_input: Value,
        request_id: String,
        #[serde(default, skip_serializing_if = "Value::is_null")]
        suggestions: Value,
    },
    PermissionCancel {
        request_id: String,
    },
    Stop {
        session_id: String,
        cwd: Option<String>,
    },
    Notification {
        session_id: String,
        cwd: Option<String>,
        message: String,
    },
}

#[derive(Debug, Clone, Deserialize)]
pub struct RawHookPayload {
    pub hook_event_name: String,
    pub session_id: String,
    pub cwd: Option<String>,
    pub tool_name: Option<String>,
    pub tool_input: Option<Value>,
    pub tool_response: Option<Value>,
    pub message: Option<String>,
    #[serde(default)]
    pub transcript_path: Option<String>,
    #[serde(default)]
    pub permission_suggestions: Option<Value>,
    /// Claude Code includes `agent_id` on hook events fired by a subagent
    /// (PreToolUse, PostToolUse, SubagentStart, SubagentStop). Absent on the
    /// main agent's events.
    #[serde(default)]
    pub agent_id: Option<String>,
    /// `agent_type` on the same events carries the subagent's display name,
    /// e.g. "Charles - Team Leader" or "superpowers:code-reviewer".
    #[serde(default)]
    pub agent_type: Option<String>,
    /// Process ID of the host terminal/IDE window the hook should map back to.
    /// Captured by `code-crew-hook` walking up its own PPID chain.
    #[serde(default)]
    pub source_pid: Option<u32>,
    #[serde(default)]
    pub pid_chain: Option<Vec<u32>>,
}

pub fn from_raw(raw: RawHookPayload, agent_type: &str, request_id: Option<String>) -> Option<Event> {
    let sid = raw.session_id.clone();
    let cwd_opt = raw.cwd.clone();
    Some(match raw.hook_event_name.as_str() {
        "SessionStart" => Event::SessionStart {
            session_id: sid,
            cwd: raw.cwd.unwrap_or_default(),
            agent_type: agent_type.to_string(),
            source_pid: raw.source_pid,
            pid_chain: raw.pid_chain.clone(),
        },
        "SessionEnd" => Event::SessionEnd { session_id: sid },
        "UserPromptSubmit" => Event::UserPromptSubmit {
            session_id: sid,
            cwd: cwd_opt,
        },
        "PreToolUse" => Event::PreToolUse {
            session_id: sid,
            cwd: cwd_opt,
            tool_name: raw.tool_name?,
            tool_input: raw.tool_input.unwrap_or(Value::Null),
            transcript_path: raw.transcript_path.clone(),
            agent_name: raw.agent_type.clone(),
            source_pid: raw.source_pid,
        },
        "PostToolUse" => Event::PostToolUse {
            session_id: sid,
            cwd: cwd_opt,
            tool_name: raw.tool_name?,
            // Claude Code only fires PostToolUse on success — failures go to
            // PostToolUseFailure (handled below). The defensive `tool_response.success`
            // check is kept for tools that might surface partial-failure flags
            // inside an otherwise-successful response.
            success: raw
                .tool_response
                .and_then(|v| v.get("success").and_then(|x| x.as_bool()))
                .unwrap_or(true),
            transcript_path: raw.transcript_path.clone(),
            agent_name: raw.agent_type.clone(),
        },
        // PostToolUseFailure is structurally the same as PostToolUse but
        // signals a failed tool call. We collapse it into the existing
        // PostToolUse variant with `success: false` so the store has a single
        // code path for tool completion.
        "PostToolUseFailure" => Event::PostToolUse {
            session_id: sid,
            cwd: cwd_opt,
            tool_name: raw.tool_name?,
            success: false,
            transcript_path: raw.transcript_path.clone(),
            agent_name: raw.agent_type.clone(),
        },
        "SubagentStart" => {
            // Claude Code surfaces the subagent's display name as `agent_type`
            // at the top level of the hook payload; legacy fallbacks live
            // inside `tool_input.subagent_type`.
            let st = raw
                .agent_type
                .clone()
                .or_else(|| {
                    raw.tool_input
                        .as_ref()
                        .and_then(|v| v.get("subagent_type"))
                        .and_then(|v| v.as_str())
                        .map(str::to_string)
                })
                .unwrap_or_else(|| "subagent".into());
            let sub_id = raw
                .agent_id
                .clone()
                .unwrap_or_else(|| format!("sub-{}", uuid::Uuid::new_v4()));
            Event::SubagentStart {
                session_id: sid,
                cwd: cwd_opt,
                subagent_id: sub_id,
                subagent_type: st,
                transcript_path: raw.transcript_path.clone(),
            }
        }
        "SubagentStop" | "SubagentEnd" => Event::SubagentStop {
            session_id: sid,
            cwd: cwd_opt,
            subagent_id: raw
                .agent_id
                .clone()
                .or_else(|| {
                    raw.tool_input
                        .as_ref()
                        .and_then(|v| v.get("subagent_id"))
                        .and_then(|v| v.as_str())
                        .map(str::to_string)
                })
                .unwrap_or_default(),
        },
        "Permission" | "PermissionRequest" => Event::PermissionRequest {
            session_id: sid,
            cwd: cwd_opt,
            tool_name: raw.tool_name.unwrap_or_default(),
            tool_input: raw.tool_input.unwrap_or(Value::Null),
            request_id: request_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            suggestions: raw.permission_suggestions.unwrap_or(Value::Null),
        },
        "Stop" => Event::Stop { session_id: sid, cwd: cwd_opt },
        "Notification" => Event::Notification {
            session_id: sid,
            cwd: cwd_opt,
            message: raw.message.unwrap_or_default(),
        },
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn raw(name: &str, sid: &str) -> RawHookPayload {
        RawHookPayload {
            hook_event_name: name.into(),
            session_id: sid.into(),
            cwd: None,
            tool_name: None,
            tool_input: None,
            tool_response: None,
            message: None,
            transcript_path: None,
            permission_suggestions: None,
            agent_id: None,
            agent_type: None,
            source_pid: None,
            pid_chain: None,
        }
    }

    #[test]
    fn maps_session_start() {
        let mut r = raw("SessionStart", "s1");
        r.cwd = Some("/tmp".into());
        let e = from_raw(r, "claude", None).unwrap();
        match e {
            Event::SessionStart { session_id, cwd, agent_type, .. } => {
                assert_eq!(session_id, "s1");
                assert_eq!(cwd, "/tmp");
                assert_eq!(agent_type, "claude");
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn maps_pre_tool_use_with_input() {
        let mut r = raw("PreToolUse", "s2");
        r.tool_name = Some("Bash".into());
        r.tool_input = Some(json!({"command": "npm test"}));
        let e = from_raw(r, "claude", None).unwrap();
        match e {
            Event::PreToolUse { tool_name, tool_input, .. } => {
                assert_eq!(tool_name, "Bash");
                assert_eq!(tool_input["command"], "npm test");
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn unknown_event_returns_none() {
        let r = raw("UnknownThing", "sX");
        assert!(from_raw(r, "claude", None).is_none());
    }

    #[test]
    fn permission_carries_request_id() {
        let mut r = raw("Permission", "s3");
        r.tool_name = Some("Bash".into());
        let e = from_raw(r, "claude", Some("req-42".into())).unwrap();
        match e {
            Event::PermissionRequest { request_id, .. } => assert_eq!(request_id, "req-42"),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn pre_tool_use_carries_agent_name_from_subagent_payload() {
        let mut r = raw("PreToolUse", "s4");
        r.tool_name = Some("Read".into());
        r.tool_input = Some(json!({"file_path": "/tmp/x"}));
        r.agent_id = Some("a64fb73024a1b67ed".into());
        r.agent_type = Some("Charles - Team Leader".into());
        let e = from_raw(r, "claude", None).unwrap();
        match e {
            Event::PreToolUse { agent_name, .. } => {
                assert_eq!(agent_name.as_deref(), Some("Charles - Team Leader"));
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn pre_tool_use_main_agent_has_no_agent_name() {
        let mut r = raw("PreToolUse", "s5");
        r.tool_name = Some("Bash".into());
        let e = from_raw(r, "claude", None).unwrap();
        match e {
            Event::PreToolUse { agent_name, .. } => assert!(agent_name.is_none()),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn post_tool_use_failure_maps_to_unsuccessful_post_tool_use() {
        // Claude Code emits PostToolUseFailure (not PostToolUse) when a tool
        // fails. We collapse it into the existing PostToolUse variant so the
        // store's single `success: false` branch handles both legacy partial
        // failures and explicit failure events.
        let mut r = raw("PostToolUseFailure", "s7");
        r.tool_name = Some("Bash".into());
        r.tool_input = Some(json!({"command": "cat /tmp/no-such-file"}));
        let e = from_raw(r, "claude", None).unwrap();
        match e {
            Event::PostToolUse { tool_name, success, .. } => {
                assert_eq!(tool_name, "Bash");
                assert!(!success, "PostToolUseFailure must set success=false");
            }
            _ => panic!("PostToolUseFailure should map to Event::PostToolUse"),
        }
    }

    #[test]
    fn subagent_start_uses_top_level_agent_type() {
        let mut r = raw("SubagentStart", "s6");
        r.agent_id = Some("a64fb73024a1b67ed".into());
        r.agent_type = Some("Charles - Team Leader".into());
        let e = from_raw(r, "claude", None).unwrap();
        match e {
            Event::SubagentStart {
                subagent_id,
                subagent_type,
                ..
            } => {
                assert_eq!(subagent_id, "a64fb73024a1b67ed");
                assert_eq!(subagent_type, "Charles - Team Leader");
            }
            _ => panic!("wrong variant"),
        }
    }
}
