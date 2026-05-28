use crate::events::{from_raw, Event, RawHookPayload};
use axum::{
    extract::State,
    http::StatusCode,
    response::Json,
    routing::{get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot, Mutex};
use tower_http::cors::{Any, CorsLayer};

#[derive(Clone)]
pub struct AppState {
    pub event_tx: mpsc::UnboundedSender<Event>,
    pub pending_permissions: Arc<Mutex<HashMap<String, oneshot::Sender<PermissionDecision>>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PermissionDecision {
    pub behavior: String,
    pub remember: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update_permissions: Option<Value>,
}

#[derive(Debug, Serialize)]
struct ClaudeHookResponse {
    #[serde(rename = "hookSpecificOutput")]
    hook_specific_output: ClaudeHookOutput,
}

#[derive(Debug, Serialize)]
struct ClaudeHookOutput {
    #[serde(rename = "hookEventName")]
    hook_event_name: &'static str,
    decision: ClaudeDecision,
}

#[derive(Debug, Serialize)]
struct ClaudeDecision {
    behavior: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(rename = "updatedPermissions", skip_serializing_if = "Option::is_none")]
    updated_permissions: Option<Value>,
}

fn wrap_decision(decision: PermissionDecision) -> ClaudeHookResponse {
    let message = if decision.behavior == "deny" {
        Some("denied by code-crew widget".to_string())
    } else {
        None
    };
    ClaudeHookResponse {
        hook_specific_output: ClaudeHookOutput {
            hook_event_name: "PermissionRequest",
            decision: ClaudeDecision {
                behavior: decision.behavior,
                message,
                updated_permissions: decision.update_permissions,
            },
        },
    }
}

struct PermissionCleanup {
    state: AppState,
    request_id: String,
    completed: bool,
}

impl Drop for PermissionCleanup {
    fn drop(&mut self) {
        if self.completed {
            return;
        }
        let state = self.state.clone();
        let id = self.request_id.clone();
        tokio::spawn(async move {
            state.pending_permissions.lock().await.remove(&id);
            let _ = state.event_tx.send(Event::PermissionCancel { request_id: id });
        });
    }
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/event", post(post_event))
        .route("/permission", post(post_permission))
        .route("/permission-response/:id", post(post_permission_response))
        .with_state(state)
        .layer(CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any))
}

async fn post_event(
    State(s): State<AppState>,
    Json(raw): Json<RawHookPayload>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let agent_type = "claude";
    if let Some(ev) = from_raw(raw, agent_type, None) {
        let _ = s.event_tx.send(ev);
    }
    Ok(Json(serde_json::json!({"ok": true})))
}

async fn post_permission(
    State(s): State<AppState>,
    Json(raw): Json<RawHookPayload>,
) -> Result<Json<ClaudeHookResponse>, StatusCode> {
    let req_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    s.pending_permissions.lock().await.insert(req_id.clone(), tx);

    let mut cleanup = PermissionCleanup {
        state: s.clone(),
        request_id: req_id.clone(),
        completed: false,
    };

    let ev = Event::PermissionRequest {
        session_id: raw.session_id.clone(),
        cwd: raw.cwd.clone(),
        tool_name: raw.tool_name.clone().unwrap_or_default(),
        tool_input: raw.tool_input.clone().unwrap_or(Value::Null),
        request_id: req_id.clone(),
        suggestions: raw.permission_suggestions.clone().unwrap_or(Value::Null),
        agent_name: raw.agent_type.clone(),
    };
    let _ = s.event_tx.send(ev);
    match tokio::time::timeout(std::time::Duration::from_secs(600), rx).await {
        Ok(Ok(decision)) => {
            cleanup.completed = true;
            Ok(Json(wrap_decision(decision)))
        }
        _ => Ok(Json(wrap_decision(PermissionDecision {
            behavior: "deny".into(),
            remember: false,
            update_permissions: None,
        }))),
    }
}

async fn post_permission_response(
    State(s): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(decision): Json<PermissionDecision>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if let Some(tx) = s.pending_permissions.lock().await.remove(&id) {
        let _ = tx.send(decision);
        Ok(Json(serde_json::json!({"ok": true})))
    } else {
        Err(StatusCode::NOT_FOUND)
    }
}

fn write_port_file(port: u16) -> std::io::Result<()> {
    let path = crate::storage::port_file_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, port.to_string())?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

pub async fn serve(state: AppState) -> anyhow::Result<()> {
    let app = router(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    write_port_file(port)?;
    tracing::info!("code-crew server listening on port {}", port);
    axum::serve(listener, app).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    fn make_state() -> (AppState, mpsc::UnboundedReceiver<Event>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (
            AppState {
                event_tx: tx,
                pending_permissions: Arc::new(Mutex::new(HashMap::new())),
            },
            rx,
        )
    }

    #[tokio::test]
    async fn health_returns_ok() {
        let (s, _rx) = make_state();
        let app = router(s);
        let res = app
            .oneshot(Request::builder().uri("/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
    }

    #[tokio::test]
    async fn post_event_dispatches_to_channel() {
        let (s, mut rx) = make_state();
        let app = router(s);
        let body = serde_json::json!({
            "hook_event_name": "SessionStart",
            "session_id": "sX",
            "cwd": "/x",
        });
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/event")
                    .method("POST")
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let ev = rx.try_recv().unwrap();
        match ev {
            Event::SessionStart { session_id, .. } => assert_eq!(session_id, "sX"),
            _ => panic!("wrong event"),
        }
    }
}
