use std::path::Path;
use std::process::Command;

pub fn derive(cwd: &Path) -> String {
    if let Some(remote) = git_remote(cwd) {
        return remote;
    }
    if let Some(root) = git_root(cwd) {
        return root;
    }
    cwd.to_string_lossy().into_owned()
}

pub fn display_name(cwd: &Path) -> String {
    let path = git_root(cwd)
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| cwd.to_path_buf());
    path.file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

fn git_remote(cwd: &Path) -> Option<String> {
    let out = Command::new("git")
        .args(["config", "--get", "remote.origin.url"])
        .current_dir(cwd)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

fn git_root(cwd: &Path) -> Option<String> {
    let out = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(cwd)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

pub fn hash_short(key: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(key.as_bytes());
    let bytes = h.finalize();
    hex::encode(&bytes[..8])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn cwd_fallback_when_no_git() {
        let tmp = std::env::temp_dir().join(format!("code-crew-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let key = derive(&tmp);
        assert_eq!(key, tmp.to_string_lossy());
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn hash_short_is_16_chars() {
        let h = hash_short("git@github.com:dorothy/marine-homepage.git");
        assert_eq!(h.len(), 16);
    }

    #[test]
    fn hash_short_is_stable() {
        let a = hash_short("foo");
        let b = hash_short("foo");
        assert_eq!(a, b);
    }
}
