use serde::Serialize;
use serde_json::Value;
use std::path::Path;

/// Claude Code transcript(JSONL)의 활동 상태. idle sweep이 working 세션의
/// "사고 중(hook 이벤트 공백)"과 "Esc로 중단됨(Stop 미발화)"을 구분하는 데 쓴다.
#[derive(Debug, Clone, Serialize)]
pub struct TranscriptStatus {
    /// 파일 mtime (epoch ms). 파일이 없거나 읽기 실패면 None.
    pub mtime_ms: Option<u64>,
    /// 마지막 유효 엔트리가 사용자 중단 마커인지.
    pub interrupted: bool,
}

/// Esc 중단 시 transcript에 남는 user 엔트리 텍스트의 접두사.
/// "[Request interrupted by user]"와 "... for tool use]" 변형을 함께 커버한다.
const INTERRUPT_MARKER: &str = "[Request interrupted by user";

/// 끝에서 이만큼만 읽는다 — sweep이 5초마다 호출하므로 큰 transcript를
/// 통째로 읽지 않기 위함. 마지막 엔트리 몇 개를 보기엔 충분한 크기.
const TAIL_BYTES: u64 = 64 * 1024;

pub fn status(path: &Path) -> TranscriptStatus {
    let Ok(meta) = std::fs::metadata(path) else {
        return TranscriptStatus { mtime_ms: None, interrupted: false };
    };
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
    TranscriptStatus {
        mtime_ms,
        interrupted: last_entry_is_interrupt(path, meta.len()),
    }
}

/// 마지막 유효 엔트리(메타데이터 라인 제외)가 중단 마커인 user 엔트리인지.
/// 판단 불가(파싱 실패·비-user 엔트리)면 false — 오판으로 작업 중인 펫을
/// 재우는 것보다 안전망(시간 상한)에 맡기는 쪽으로 기운다.
fn last_entry_is_interrupt(path: &Path, len: u64) -> bool {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = std::fs::File::open(path) else {
        return false;
    };
    let start = len.saturating_sub(TAIL_BYTES);
    if f.seek(SeekFrom::Start(start)).is_err() {
        return false;
    }
    let mut buf = Vec::new();
    if f.read_to_end(&mut buf).is_err() {
        return false;
    }
    for line in buf.split(|b| *b == b'\n').rev() {
        if line.is_empty() {
            continue;
        }
        // tail 절단으로 잘린 첫 라인이나 쓰다 만 마지막 라인은 파싱에
        // 실패한다 — 건너뛰고 그 앞의 온전한 라인으로 판단한다.
        let Ok(v) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        let kind = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        // user/assistant만 실제 대화 엔트리로 본다. 그 외는 중단 직후에도
        // 붙는 부속 라인이라 건너뛴다 — 실측(2026-08)으로 마커 뒤에서
        // file-history-snapshot·attachment·last-prompt·ai-title·mode·
        // permission-mode·queue-operation·system·file-history-delta가 관찰됨.
        if kind != "user" && kind != "assistant" {
            continue;
        }
        if kind != "user" {
            return false;
        }
        return user_text(&v)
            .map(|t| t.starts_with(INTERRUPT_MARKER))
            .unwrap_or(false);
    }
    false
}

fn user_text(v: &Value) -> Option<String> {
    let content = v.pointer("/message/content")?;
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }
    for item in content.as_array()? {
        if item.get("type").and_then(|x| x.as_str()) == Some("text") {
            if let Some(text) = item.get("text").and_then(|x| x.as_str()) {
                return Some(text.to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::path::PathBuf;

    fn temp_transcript(lines: &[Value]) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "code-crew-transcript-{}.jsonl",
            uuid::Uuid::new_v4()
        ));
        let body: String = lines.iter().map(|l| format!("{}\n", l)).collect();
        fs::write(&path, body).unwrap();
        path
    }

    fn interrupt_entry() -> Value {
        json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{"type": "text", "text": "[Request interrupted by user]"}]
            }
        })
    }

    #[test]
    fn missing_file_is_not_interrupted() {
        let st = status(Path::new("/nonexistent/code-crew-nope.jsonl"));
        assert_eq!(st.mtime_ms, None);
        assert!(!st.interrupted);
    }

    #[test]
    fn detects_interrupt_marker_as_last_entry() {
        let path = temp_transcript(&[
            json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "working..."}]}}),
            interrupt_entry(),
        ]);
        let st = status(&path);
        assert!(st.interrupted);
        assert!(st.mtime_ms.is_some());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn detects_interrupt_behind_trailing_metadata_lines() {
        let path = temp_transcript(&[
            interrupt_entry(),
            json!({"type": "last-prompt", "lastPrompt": "go"}),
            json!({"type": "mode", "mode": "normal"}),
        ]);
        assert!(status(&path).interrupted);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn detects_interrupt_behind_snapshot_and_attachment_lines() {
        // 실측: Esc 직후 file-history-snapshot/attachment/system 라인이
        // 마커 뒤에 붙는 케이스가 흔하다. 이들도 건너뛰고 감지해야 한다.
        let path = temp_transcript(&[
            interrupt_entry(),
            json!({"type": "file-history-snapshot", "snapshot": {}}),
            json!({"type": "system", "subtype": "hook"}),
            json!({"type": "attachment", "attachment": {}}),
        ]);
        assert!(status(&path).interrupted);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn detects_tool_use_interrupt_variant_with_string_content() {
        let path = temp_transcript(&[json!({
            "type": "user",
            "message": {"role": "user", "content": "[Request interrupted by user for tool use]"}
        })]);
        assert!(status(&path).interrupted);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn assistant_last_entry_is_not_interrupted() {
        let path = temp_transcript(&[
            interrupt_entry(),
            json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "thinking"}]}}),
        ]);
        assert!(!status(&path).interrupted);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn normal_user_prompt_is_not_interrupted() {
        let path = temp_transcript(&[json!({
            "type": "user",
            "message": {"role": "user", "content": "계속 진행해줘"}
        })]);
        assert!(!status(&path).interrupted);
        let _ = fs::remove_file(path);
    }
}
