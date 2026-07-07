//! Embedded-sync JWT secret resolution.
//!
//! Precedence: an explicit env override (fail-closed against the known dev default),
//! else a persisted per-install secret in the app data dir, else a freshly generated
//! high-entropy secret that is persisted for the next start. There is no silent
//! fallback to a hard-coded secret.

use std::path::Path;

/// The historical hard-coded development secret. Kept in one place only so it can be
/// *rejected* — it is never a runtime fallback.
pub const DEV_JWT_SECRET: &str = "lataif_secret_2026_change_in_production";

/// Persisted per-install secret file, stored beside the sync DB in the app data dir.
const SECRET_FILENAME: &str = "sync_jwt_secret.key";

/// Failure to obtain a usable secret. `Display` never contains a secret value.
#[derive(Debug, PartialEq, Eq)]
pub enum SyncSecretError {
    InsecureDevDefault,
    NoAppDataDir,
    Persist(String),
}

impl std::fmt::Display for SyncSecretError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SyncSecretError::InsecureDevDefault => write!(
                f,
                "Refusing the known development JWT secret for the embedded sync server. Unset it, set a unique LATAIF_SYNC_JWT_SECRET, or export LATAIF_ALLOW_DEV_JWT_SECRET=1 for local development only."
            ),
            SyncSecretError::NoAppDataDir => write!(
                f,
                "Could not determine the app data directory to persist the sync JWT secret."
            ),
            SyncSecretError::Persist(e) => {
                write!(f, "Could not persist the sync JWT secret: {e}")
            }
        }
    }
}

impl std::error::Error for SyncSecretError {}

/// Pure decision core for an env-provided secret (no env access). Returns:
/// - `Ok(Some(secret))` when a clean secret was supplied,
/// - `Ok(None)` when nothing usable was supplied (caller falls back to the file),
/// - `Err(InsecureDevDefault)` when the known dev default was supplied without opt-in.
fn resolve_env_secret(
    configured: Option<String>,
    allow_dev: bool,
) -> Result<Option<String>, SyncSecretError> {
    match configured {
        None => Ok(None),
        Some(s) if s.trim().is_empty() => Ok(None),
        Some(s) if s == DEV_JWT_SECRET && !allow_dev => Err(SyncSecretError::InsecureDevDefault),
        Some(s) => Ok(Some(s)),
    }
}

/// Read the env override — preferred `LATAIF_SYNC_JWT_SECRET`, then legacy
/// `LATAIF_JWT_SECRET` / `JWT_SECRET` — plus the dev opt-in flag.
fn env_secret() -> Result<Option<String>, SyncSecretError> {
    let configured = std::env::var("LATAIF_SYNC_JWT_SECRET")
        .ok()
        .or_else(|| std::env::var("LATAIF_JWT_SECRET").ok())
        .or_else(|| std::env::var("JWT_SECRET").ok());
    let allow_dev = std::env::var("LATAIF_ALLOW_DEV_JWT_SECRET")
        .map(|v| v == "1")
        .unwrap_or(false);
    resolve_env_secret(configured, allow_dev)
}

/// A persisted secret is usable only if it is non-blank and not the dev default.
fn is_usable_persisted(s: &str) -> bool {
    let t = s.trim();
    !t.is_empty() && t != DEV_JWT_SECRET
}

/// Generate a high-entropy secret from the OS CSPRNG. Three v4 UUIDs (each drawn from
/// `getrandom`) yield ~366 bits of entropy — comfortably over the 32-byte target —
/// with no extra dependency and no deterministic derivation.
fn generate_secret() -> String {
    format!(
        "{}{}{}",
        uuid::Uuid::new_v4().as_simple(),
        uuid::Uuid::new_v4().as_simple(),
        uuid::Uuid::new_v4().as_simple(),
    )
}

fn persist_secret(path: &Path, secret: &str) -> Result<(), SyncSecretError> {
    std::fs::write(path, secret).map_err(|e| SyncSecretError::Persist(e.to_string()))?;
    // Best-effort restrictive permissions. On Windows the app data dir is already
    // per-user scoped; on Unix tighten to owner-only.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// File-backed load-or-create (no env access) — isolated for deterministic tests.
/// A blank / corrupt / dev-default file is treated as unusable and regenerated
/// (safe: it is our own file and this only ever upgrades to a stronger secret).
fn load_or_create_from_file(app_data_dir: &Path) -> Result<String, SyncSecretError> {
    let path = app_data_dir.join(SECRET_FILENAME);
    if let Ok(contents) = std::fs::read_to_string(&path) {
        if is_usable_persisted(&contents) {
            return Ok(contents.trim().to_string());
        }
    }
    let secret = generate_secret();
    persist_secret(&path, &secret)?;
    Ok(secret)
}

/// Obtain the embedded-sync JWT secret. Precedence:
/// 1. explicit env override (fail-closed against the known dev default),
/// 2. persisted per-install secret in the app data dir (parent of the sync DB path),
/// 3. a freshly generated secret, persisted for the next start.
pub fn load_or_create_sync_secret(sync_db_path: &Path) -> Result<String, SyncSecretError> {
    if let Some(s) = env_secret()? {
        return Ok(s);
    }
    let dir = sync_db_path.parent().ok_or(SyncSecretError::NoAppDataDir)?;
    load_or_create_from_file(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir() -> std::path::PathBuf {
        let d =
            std::env::temp_dir().join(format!("lataif-g2-{}", uuid::Uuid::new_v4().as_simple()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn env_none_or_blank_falls_through_to_file() {
        assert_eq!(resolve_env_secret(None, false), Ok(None));
        assert_eq!(resolve_env_secret(Some("   ".to_string()), false), Ok(None));
    }

    #[test]
    fn env_dev_default_rejected_without_optin() {
        assert_eq!(
            resolve_env_secret(Some(DEV_JWT_SECRET.to_string()), false),
            Err(SyncSecretError::InsecureDevDefault)
        );
    }

    #[test]
    fn env_dev_default_allowed_only_with_explicit_optin() {
        assert_eq!(
            resolve_env_secret(Some(DEV_JWT_SECRET.to_string()), true),
            Ok(Some(DEV_JWT_SECRET.to_string()))
        );
    }

    #[test]
    fn env_clean_secret_accepted() {
        assert_eq!(
            resolve_env_secret(Some("clean-env-secret".to_string()), false),
            Ok(Some("clean-env-secret".to_string()))
        );
    }

    #[test]
    fn first_load_creates_and_persists_then_reuses() {
        let dir = tmp_dir();
        let s1 = load_or_create_from_file(&dir).unwrap();
        assert!(dir.join(SECRET_FILENAME).exists());
        assert!(is_usable_persisted(&s1));
        // second load returns the identical persisted secret
        let s2 = load_or_create_from_file(&dir).unwrap();
        assert_eq!(s1, s2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn generated_secret_is_not_dev_default_and_high_entropy() {
        let s = generate_secret();
        assert_ne!(s, DEV_JWT_SECRET);
        // 3 × 32 hex chars = 96; well over a 32-byte (64 hex) target.
        assert!(s.len() >= 64, "expected >=64 hex chars, got {}", s.len());
        assert_ne!(generate_secret(), generate_secret());
    }

    #[test]
    fn blank_or_dev_default_file_is_regenerated_not_trusted() {
        let dir = tmp_dir();
        let path = dir.join(SECRET_FILENAME);
        // blank file → regenerate
        std::fs::write(&path, "   ").unwrap();
        let s = load_or_create_from_file(&dir).unwrap();
        assert!(is_usable_persisted(&s));
        // dev-default in file → not trusted, regenerated
        std::fs::write(&path, DEV_JWT_SECRET).unwrap();
        let s2 = load_or_create_from_file(&dir).unwrap();
        assert_ne!(s2.trim(), DEV_JWT_SECRET);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn is_usable_persisted_rules() {
        assert!(!is_usable_persisted(""));
        assert!(!is_usable_persisted("   "));
        assert!(!is_usable_persisted(DEV_JWT_SECRET));
        assert!(is_usable_persisted("a-real-secret"));
    }

    #[test]
    fn error_display_never_leaks_secret_value() {
        for e in [
            SyncSecretError::InsecureDevDefault,
            SyncSecretError::NoAppDataDir,
            SyncSecretError::Persist("io error".into()),
        ] {
            assert!(!format!("{e}").contains(DEV_JWT_SECRET));
        }
    }

    // Token roundtrip through the sync auth module: the owner self-token verifies
    // under the same secret and is rejected under a different one.
    #[test]
    fn self_token_roundtrip_same_secret_ok_wrong_rejected() {
        let t = super::super::auth::create_token(
            "self-desktop",
            "tenant-1",
            "branch-main",
            "owner",
            "secretA",
        )
        .unwrap();
        let claims = super::super::auth::verify_token(&t, "secretA").unwrap();
        assert_eq!(claims.tenant_id, "tenant-1");
        assert_eq!(claims.branch_id, "branch-main");
        assert_eq!(claims.role, "owner");
        assert!(super::super::auth::verify_token(&t, "secretB").is_err());
    }
}
