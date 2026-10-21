//! Backend control-token loading and validation shared by the proxies.

use std::ffi::OsString;
use std::fs::OpenOptions;
use std::io::Read;
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

use anyhow::{Context, Result};

const MIN_CONTROL_TOKEN_BYTES: usize = 32;
const MAX_CONTROL_TOKEN_BYTES: usize = 1024;

pub fn required_control_token(name: &str, file_name: &str) -> Result<String> {
    load_control_token(
        name,
        std::env::var_os(name),
        file_name,
        std::env::var_os(file_name).map(PathBuf::from),
    )
}

pub fn load_control_token(
    name: &str,
    direct: Option<OsString>,
    file_name: &str,
    file: Option<PathBuf>,
) -> Result<String> {
    match (direct, file) {
        (Some(_), Some(_)) => {
            anyhow::bail!("{name} and {file_name} are mutually exclusive")
        }
        (Some(token), None) => {
            let token = token
                .into_string()
                .map_err(|_| anyhow::anyhow!("{name} must be valid UTF-8"))?;
            validate_control_token(name, &token)?;
            Ok(token)
        }
        (None, Some(path)) => read_control_token_file(name, file_name, &path),
        (None, None) => anyhow::bail!("{name} or {file_name} is required"),
    }
}

pub fn read_control_token_file(name: &str, file_name: &str, path: &Path) -> Result<String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    let file = options
        .open(path)
        .with_context(|| format!("failed to open {file_name}"))?;
    let metadata = file
        .metadata()
        .with_context(|| format!("failed to inspect {file_name}"))?;
    if !metadata.is_file() {
        anyhow::bail!("{file_name} must reference a regular file");
    }
    #[cfg(unix)]
    {
        let mode = metadata.permissions().mode() & 0o777;
        if mode & 0o400 == 0 || mode & 0o077 != 0 || mode & 0o111 != 0 {
            anyhow::bail!(
                "{file_name} must be owner-readable, non-executable, and inaccessible to group/other"
            );
        }
    }
    if metadata.len() > MAX_CONTROL_TOKEN_BYTES as u64 {
        anyhow::bail!("{file_name} content is outside the allowed token size");
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_CONTROL_TOKEN_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .with_context(|| format!("failed to read {file_name}"))?;
    if bytes.len() > MAX_CONTROL_TOKEN_BYTES {
        anyhow::bail!("{file_name} content is outside the allowed token size");
    }
    let token = String::from_utf8(bytes)
        .map_err(|_| anyhow::anyhow!("{file_name} content must be valid UTF-8"))?;
    validate_control_token(name, &token)?;
    Ok(token)
}

pub fn validate_control_token(name: &str, token: &str) -> Result<()> {
    if !(MIN_CONTROL_TOKEN_BYTES..=MAX_CONTROL_TOKEN_BYTES).contains(&token.len()) {
        anyhow::bail!("{name} must be {MIN_CONTROL_TOKEN_BYTES}..={MAX_CONTROL_TOKEN_BYTES} bytes");
    }
    if !token
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        anyhow::bail!("{name} must use only ASCII letters, digits, '_' or '-'");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEST_FILE: AtomicU64 = AtomicU64::new(1);

    struct PrivateTestFile {
        path: PathBuf,
    }

    impl PrivateTestFile {
        fn new(contents: &[u8], mode: u32) -> Self {
            let id = NEXT_TEST_FILE.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "nyabase-proxy-common-secret-{}-{id}",
                std::process::id()
            ));
            let mut file = std::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&path)
                .unwrap();
            file.write_all(contents).unwrap();
            file.sync_all().unwrap();
            #[cfg(unix)]
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
            Self { path }
        }
    }

    impl Drop for PrivateTestFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.path);
        }
    }

    #[test]
    fn control_token_is_required_to_be_trim_exact_and_bounded() {
        assert!(validate_control_token("SSH_PROXY_TOKEN", &"a".repeat(32)).is_ok());
        assert!(validate_control_token("SSH_PROXY_TOKEN", &"a".repeat(1024)).is_ok());
        assert!(validate_control_token("SSH_PROXY_TOKEN", &"a".repeat(31)).is_err());
        assert!(validate_control_token("SSH_PROXY_TOKEN", &"a".repeat(1025)).is_err());
        assert!(
            validate_control_token("SSH_PROXY_TOKEN", &format!(" {}", "a".repeat(32))).is_err()
        );
        assert!(
            validate_control_token("SSH_PROXY_TOKEN", &format!("{}\n", "a".repeat(32))).is_err()
        );
        assert!(validate_control_token(
            "SSH_PROXY_TOKEN",
            &format!("{}\n{}", "a".repeat(16), "a".repeat(16)),
        )
        .is_err());
        assert!(
            validate_control_token("SSH_PROXY_TOKEN", &format!("{} internal", "a".repeat(32)),)
                .is_err()
        );
        assert!(
            validate_control_token("SSH_PROXY_TOKEN", &format!("é{}", "a".repeat(32))).is_err()
        );
    }

    #[test]
    fn control_token_file_is_mutually_exclusive_private_and_non_leaking() {
        let token = "a".repeat(32);
        let private = PrivateTestFile::new(token.as_bytes(), 0o600);
        assert_eq!(
            load_control_token(
                "SSH_PROXY_TOKEN",
                None,
                "SSH_PROXY_TOKEN_FILE",
                Some(private.path.clone()),
            )
            .unwrap(),
            token,
        );
        assert!(load_control_token(
            "SSH_PROXY_TOKEN",
            Some(OsString::from("b".repeat(32))),
            "SSH_PROXY_TOKEN_FILE",
            Some(private.path.clone()),
        )
        .unwrap_err()
        .to_string()
        .contains("mutually exclusive"));

        let public = PrivateTestFile::new(token.as_bytes(), 0o644);
        assert!(load_control_token(
            "SSH_PROXY_TOKEN",
            None,
            "SSH_PROXY_TOKEN_FILE",
            Some(public.path.clone()),
        )
        .is_err());

        let invalid_secret = format!("{}!", "s".repeat(31));
        let invalid = PrivateTestFile::new(invalid_secret.as_bytes(), 0o400);
        let error = load_control_token(
            "SSH_PROXY_TOKEN",
            None,
            "SSH_PROXY_TOKEN_FILE",
            Some(invalid.path.clone()),
        )
        .unwrap_err()
        .to_string();
        assert!(!error.contains(&invalid_secret));

        let newline = PrivateTestFile::new(format!("{token}\n").as_bytes(), 0o400);
        assert!(load_control_token(
            "SSH_PROXY_TOKEN",
            None,
            "SSH_PROXY_TOKEN_FILE",
            Some(newline.path.clone()),
        )
        .is_err());
        let empty = PrivateTestFile::new(b"", 0o400);
        assert!(load_control_token(
            "SSH_PROXY_TOKEN",
            None,
            "SSH_PROXY_TOKEN_FILE",
            Some(empty.path.clone()),
        )
        .is_err());
        let oversized = PrivateTestFile::new("a".repeat(1025).as_bytes(), 0o400);
        assert!(load_control_token(
            "SSH_PROXY_TOKEN",
            None,
            "SSH_PROXY_TOKEN_FILE",
            Some(oversized.path.clone()),
        )
        .is_err());
    }
}
