use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

const MAX_MESSAGES: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredMessage {
    pub id: String,
    pub agent_name: String,
    pub pet: String,
    pub tool_emoji: Option<String>,
    pub tool_name: Option<String>,
    pub text: String,
    pub kind: String,
    pub timestamp: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectFile {
    pub project_key: String,
    pub display_name: String,
    pub last_seen: DateTime<Utc>,
    pub messages: Vec<StoredMessage>,
}

pub fn data_dir() -> PathBuf {
    let home = dirs::home_dir().expect("home dir not found");
    home.join(".code-crew").join("projects")
}

pub fn port_file_path() -> PathBuf {
    let home = dirs::home_dir().expect("home dir not found");
    home.join(".code-crew").join("server.port")
}

/// 창 위치·크기. 단위는 **논리 픽셀**이다 — 물리 픽셀로 저장하면 배율이 다른
/// 모니터를 오갈 때 왕복이 깨져 창이 화면 밖으로 사라진다.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct WindowGeometry {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl WindowGeometry {
    // 손상된 파일 때문에 창이 0 크기나 NaN 좌표가 되지 않게 막는다.
    fn is_sane(&self) -> bool {
        self.x.is_finite()
            && self.y.is_finite()
            && self.width.is_finite()
            && self.height.is_finite()
            && self.width >= 1.0
            && self.height >= 1.0
    }
}

pub fn window_geometry_path() -> PathBuf {
    let home = dirs::home_dir().expect("home dir not found");
    home.join(".code-crew").join("window.json")
}

pub fn load_window_geometry() -> Option<WindowGeometry> {
    load_window_geometry_at(&window_geometry_path())
}

fn load_window_geometry_at(path: &Path) -> Option<WindowGeometry> {
    let bytes = fs::read(path).ok()?;
    let g: WindowGeometry = serde_json::from_slice(&bytes).ok()?;
    g.is_sane().then_some(g)
}

pub fn save_window_geometry(g: &WindowGeometry) -> std::io::Result<()> {
    save_window_geometry_at(&window_geometry_path(), g)
}

fn save_window_geometry_at(path: &Path, g: &WindowGeometry) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        ensure_data_dir_at(parent)?;
    }
    let json = serde_json::to_vec_pretty(g)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json)?;
    fs::rename(tmp, path)?;
    Ok(())
}

pub fn ensure_data_dir() -> std::io::Result<PathBuf> {
    let dir = data_dir();
    ensure_data_dir_at(&dir)?;
    Ok(dir)
}

fn ensure_data_dir_at(dir: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dir)
}

pub fn project_path(project_key: &str) -> PathBuf {
    project_path_at(&data_dir(), project_key)
}

fn project_path_at(dir: &Path, project_key: &str) -> PathBuf {
    let hash = crate::project_key::hash_short(project_key);
    dir.join(format!("{}.json", hash))
}

pub fn load(project_key: &str) -> Option<ProjectFile> {
    load_at(&data_dir(), project_key)
}

fn load_at(dir: &Path, project_key: &str) -> Option<ProjectFile> {
    let path = project_path_at(dir, project_key);
    let bytes = fs::read(&path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub fn save(file: &ProjectFile) -> std::io::Result<()> {
    save_at(&data_dir(), file)
}

fn save_at(dir: &Path, file: &ProjectFile) -> std::io::Result<()> {
    ensure_data_dir_at(dir)?;
    let path = project_path_at(dir, &file.project_key);
    let mut to_write = file.clone();
    if to_write.messages.len() > MAX_MESSAGES {
        let drop = to_write.messages.len() - MAX_MESSAGES;
        to_write.messages.drain(0..drop);
    }
    let json = serde_json::to_vec_pretty(&to_write)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json)?;
    fs::rename(tmp, path)?;
    Ok(())
}

pub fn append_message(project_key: &str, display_name: &str, msg: StoredMessage) -> std::io::Result<()> {
    append_message_at(&data_dir(), project_key, display_name, msg)
}

fn append_message_at(
    dir: &Path,
    project_key: &str,
    display_name: &str,
    msg: StoredMessage,
) -> std::io::Result<()> {
    let mut file = load_at(dir, project_key).unwrap_or_else(|| ProjectFile {
        project_key: project_key.to_string(),
        display_name: display_name.to_string(),
        last_seen: Utc::now(),
        messages: vec![],
    });
    file.last_seen = Utc::now();
    file.messages.push(msg);
    save_at(dir, &file)
}

pub fn cleanup_old(threshold_days: i64) -> std::io::Result<usize> {
    cleanup_old_at(&data_dir(), threshold_days)
}

fn cleanup_old_at(dir: &Path, threshold_days: i64) -> std::io::Result<usize> {
    ensure_data_dir_at(dir)?;
    let now = Utc::now();
    let mut removed = 0usize;
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().map(|s| s != "json").unwrap_or(true) {
            continue;
        }
        let bytes = match fs::read(&path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let pf: ProjectFile = match serde_json::from_slice(&bytes) {
            Ok(p) => p,
            Err(_) => {
                let bak = path.with_extension("json.bak");
                let _ = fs::rename(&path, &bak);
                continue;
            }
        };
        let age = now.signed_duration_since(pf.last_seen).num_days();
        if age >= threshold_days {
            fs::remove_file(&path)?;
            removed += 1;
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    // Per-test isolated data dir. No HOME mutation — that's process-wide
    // state and breaks `cargo test` defaults (parallel threads stomp on each
    // other). Tests call the `_at` variants with this path explicitly.
    fn tmp_dir() -> PathBuf {
        let p = env::temp_dir().join(format!("code-crew-storage-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn msg(id: &str) -> StoredMessage {
        StoredMessage {
            id: id.into(),
            agent_name: "main".into(),
            pet: "dog".into(),
            tool_emoji: Some("✍️".into()),
            tool_name: Some("Edit".into()),
            text: "test".into(),
            kind: "tool".into(),
            timestamp: 0,
        }
    }

    #[test]
    fn roundtrip() {
        let dir = tmp_dir();
        let f = ProjectFile {
            project_key: "k1".into(),
            display_name: "p1".into(),
            last_seen: Utc::now(),
            messages: vec![msg("a"), msg("b")],
        };
        save_at(&dir, &f).unwrap();
        let got = load_at(&dir, "k1").unwrap();
        assert_eq!(got.messages.len(), 2);
        assert_eq!(got.messages[0].id, "a");
    }

    #[test]
    fn fifo_caps_at_200() {
        let dir = tmp_dir();
        let mut f = ProjectFile {
            project_key: "k2".into(),
            display_name: "p2".into(),
            last_seen: Utc::now(),
            messages: (0..250).map(|i| msg(&i.to_string())).collect(),
        };
        save_at(&dir, &f).unwrap();
        let got = load_at(&dir, "k2").unwrap();
        assert_eq!(got.messages.len(), 200);
        assert_eq!(got.messages[0].id, "50");
        f.messages.clear();
    }

    #[test]
    fn append_creates_file() {
        let dir = tmp_dir();
        append_message_at(&dir, "k3", "p3", msg("x")).unwrap();
        let got = load_at(&dir, "k3").unwrap();
        assert_eq!(got.messages.len(), 1);
        assert_eq!(got.display_name, "p3");
    }

    // 논리 좌표는 소수점이 나온다(화면 1/3 지점 등). f64로 그대로 왕복해야 한다.
    #[test]
    fn window_geometry_roundtrip() {
        let path = tmp_dir().join("window.json");
        let g = WindowGeometry {
            x: -1080.0,
            y: -326.5,
            width: 488.0,
            height: 300.0,
        };
        save_window_geometry_at(&path, &g).unwrap();
        assert_eq!(load_window_geometry_at(&path), Some(g));
    }

    #[test]
    fn window_geometry_rejects_broken_file() {
        let dir = tmp_dir();
        assert_eq!(load_window_geometry_at(&dir.join("none.json")), None);

        let garbage = dir.join("garbage.json");
        fs::write(&garbage, b"not json").unwrap();
        assert_eq!(load_window_geometry_at(&garbage), None);

        // 크기 0이면 창이 보이지 않는다. 저장값을 무시하고 기본값으로 떨어져야 한다.
        let zero = dir.join("zero.json");
        fs::write(&zero, br#"{"x":0,"y":0,"width":0,"height":0}"#).unwrap();
        assert_eq!(load_window_geometry_at(&zero), None);
    }

    #[test]
    fn cleanup_removes_old_files() {
        let dir = tmp_dir();
        let old = ProjectFile {
            project_key: "k_old".into(),
            display_name: "old".into(),
            last_seen: Utc::now() - chrono::Duration::days(40),
            messages: vec![msg("a")],
        };
        save_at(&dir, &old).unwrap();
        let removed = cleanup_old_at(&dir, 30).unwrap();
        assert_eq!(removed, 1);
        assert!(load_at(&dir, "k_old").is_none());
    }
}
