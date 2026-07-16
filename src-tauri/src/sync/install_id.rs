//! M6-B2A — Stable per-install device identity.
//!
//! A cryptographically random UUIDv4 that identifies THIS INSTALLATION — not the user,
//! not the machine. It lives in its own file in the app data dir, beside
//! `sync_jwt_secret.key`, and deliberately **not** in the SQLite database: that is what
//! lets a copied or restored server DB be detected (its recorded `server_instance_id`
//! then no longer matches the file it was copied away from).
//!
//! ## Contract
//!
//! - stable across restarts and app updates (the file survives both),
//! - a new app-data dir (fresh install) yields a NEW id — a reinstall is deliberately a
//!   new device identity, never a resurrection of the old one,
//! - never derived from user, hostname, MAC or IP,
//! - separate from `actor_id` / `user_id`: this is the DEVICE (`client_id`), the actor
//!   stays the user or the `self-desktop` system principal.
//!
//! ## Why this is fail-closed, unlike `secret.rs`
//!
//! `secret.rs` regenerates a blank/corrupt JWT secret — safe, because that only ever
//! upgrades to a stronger secret and costs at most one re-login. An install id is an
//! IDENTITY: silently regenerating it would mint a new device out of a truncated write
//! or a half-restored backup, and a copied server DB would then look "consistent" again.
//! So a present-but-unreadable file is an error, never a reason to overwrite.

use std::path::Path;

/// Per-install identity file, stored beside the sync DB in the app data dir.
const INSTALL_ID_FILENAME: &str = "sync_install_id.key";

/// Failure to obtain a usable install id. `Display` never contains the full id.
#[derive(Debug, PartialEq, Eq)]
pub enum InstallIdError {
    NoAppDataDir,
    /// The file exists but does not hold a valid UUID. Deliberately NOT self-healing.
    Invalid { reason: String },
    Io(String),
}

impl std::fmt::Display for InstallIdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InstallIdError::NoAppDataDir => {
                write!(f, "Could not determine the app data directory for the install id.")
            }
            InstallIdError::Invalid { reason } => write!(
                f,
                "The install id file is present but unusable ({reason}). It is NOT replaced \
                 automatically — replacing it would silently create a new device identity. \
                 Restore the file from a backup or remove it deliberately to enrol anew."
            ),
            InstallIdError::Io(e) => write!(f, "Could not read or create the install id: {e}"),
        }
    }
}

impl std::error::Error for InstallIdError {}

/// Only a canonical, non-nil UUID counts. A nil UUID is rejected: it is what a zeroed or
/// partially written file most plausibly parses into, and it would collide across installs.
pub fn parse_install_id(raw: &str) -> Result<String, InstallIdError> {
    let t = raw.trim();
    if t.is_empty() {
        return Err(InstallIdError::Invalid { reason: "file is empty".into() });
    }
    let parsed = uuid::Uuid::parse_str(t)
        .map_err(|_| InstallIdError::Invalid { reason: "not a valid UUID".into() })?;
    if parsed.is_nil() {
        return Err(InstallIdError::Invalid { reason: "nil UUID".into() });
    }
    Ok(parsed.hyphenated().to_string())
}

/// Short, log-safe form. The full id never belongs in ordinary logs — it is a stable
/// device identifier, so a leaked log line would make installs correlatable.
pub fn redact(id: &str) -> String {
    let head: String = id.chars().take(8).collect();
    format!("{head}…")
}

/// Load the id, or create it exactly once.
///
/// Race-free by construction: creation uses `create_new(true)`, i.e. an atomic
/// O_EXCL/CREATE_NEW. If two processes start together, exactly one wins the create; the
/// loser gets `AlreadyExists` and reads the winner's id. Neither can clobber the other.
pub fn load_or_create_in_dir(app_data_dir: &Path) -> Result<String, InstallIdError> {
    use std::io::Write;

    let path = app_data_dir.join(INSTALL_ID_FILENAME);

    // Existing file: use it or fail — never overwrite.
    match std::fs::read_to_string(&path) {
        Ok(contents) => return parse_install_id(&contents),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(InstallIdError::Io(e.to_string())),
    }

    let fresh = uuid::Uuid::new_v4().hyphenated().to_string();
    match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(mut f) => {
            f.write_all(fresh.as_bytes()).map_err(|e| InstallIdError::Io(e.to_string()))?;
            f.sync_all().map_err(|e| InstallIdError::Io(e.to_string()))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
            }
            Ok(fresh)
        }
        // Lost the create race — the winner's id is authoritative.
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let contents =
                std::fs::read_to_string(&path).map_err(|e| InstallIdError::Io(e.to_string()))?;
            parse_install_id(&contents)
        }
        Err(e) => Err(InstallIdError::Io(e.to_string())),
    }
}

/// Load-or-create beside the sync DB (its parent is the app data dir).
pub fn load_or_create(sync_db_path: &Path) -> Result<String, InstallIdError> {
    let dir = sync_db_path.parent().ok_or(InstallIdError::NoAppDataDir)?;
    load_or_create_in_dir(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "com.lataif.m6b2atest20260716-{}",
            uuid::Uuid::new_v4().as_simple()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    // ── I1: fresh app data → exactly one new valid id ───────────────────────
    #[test]
    fn i1_fresh_appdata_creates_exactly_one_valid_id() {
        let d = tmp_dir();
        let id = load_or_create_in_dir(&d).unwrap();
        assert!(uuid::Uuid::parse_str(&id).is_ok(), "must be a valid UUID");
        assert!(!uuid::Uuid::parse_str(&id).unwrap().is_nil());
        assert_eq!(uuid::Uuid::parse_str(&id).unwrap().get_version_num(), 4, "UUIDv4 (CSPRNG)");
        let files: Vec<_> = std::fs::read_dir(&d).unwrap().filter_map(|e| e.ok()).collect();
        assert_eq!(files.len(), 1, "exactly one file created");
        assert_eq!(files[0].file_name().to_str().unwrap(), INSTALL_ID_FILENAME);
        let _ = std::fs::remove_dir_all(&d);
    }

    // ── I2: second start → identical id ─────────────────────────────────────
    #[test]
    fn i2_second_start_returns_the_same_id() {
        let d = tmp_dir();
        let a = load_or_create_in_dir(&d).unwrap();
        let b = load_or_create_in_dir(&d).unwrap();
        let c = load_or_create_in_dir(&d).unwrap();
        assert_eq!(a, b);
        assert_eq!(b, c);
        let _ = std::fs::remove_dir_all(&d);
    }

    // ── I3: concurrent first creation → exactly one valid file ──────────────
    #[test]
    fn i3_concurrent_creation_yields_one_id() {
        let d = tmp_dir();
        let mut handles = Vec::new();
        for _ in 0..8 {
            let dir = d.clone();
            handles.push(std::thread::spawn(move || load_or_create_in_dir(&dir)));
        }
        let ids: Vec<String> = handles.into_iter().map(|h| h.join().unwrap().unwrap()).collect();
        let first = &ids[0];
        assert!(ids.iter().all(|i| i == first), "all threads must agree on one id: {ids:?}");
        let files: Vec<_> = std::fs::read_dir(&d).unwrap().filter_map(|e| e.ok()).collect();
        assert_eq!(files.len(), 1, "create_new(true) must leave exactly one file");
        // and the file really holds the agreed id
        assert_eq!(
            parse_install_id(&std::fs::read_to_string(d.join(INSTALL_ID_FILENAME)).unwrap()).unwrap(),
            *first
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    // ── I4: empty file → fail-closed, NOT replaced ──────────────────────────
    #[test]
    fn i4_empty_file_fails_closed_and_is_not_replaced() {
        let d = tmp_dir();
        let p = d.join(INSTALL_ID_FILENAME);
        std::fs::write(&p, "   \n").unwrap();
        let err = load_or_create_in_dir(&d).unwrap_err();
        assert!(matches!(err, InstallIdError::Invalid { .. }), "got {err:?}");
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "   \n", "file must stay untouched");
        let _ = std::fs::remove_dir_all(&d);
    }

    // ── I5: invalid UUID → fail-closed ──────────────────────────────────────
    #[test]
    fn i5_invalid_uuid_fails_closed() {
        for bad in ["not-a-uuid", "12345", "00000000-0000-0000-0000-000000000000"] {
            let d = tmp_dir();
            let p = d.join(INSTALL_ID_FILENAME);
            std::fs::write(&p, bad).unwrap();
            let err = load_or_create_in_dir(&d).unwrap_err();
            assert!(matches!(err, InstallIdError::Invalid { .. }), "{bad} → {err:?}");
            assert_eq!(std::fs::read_to_string(&p).unwrap(), bad, "must not be overwritten");
            let _ = std::fs::remove_dir_all(&d);
        }
    }

    // ── I7: a different app data dir → a different id ───────────────────────
    #[test]
    fn i7_new_appdata_yields_a_new_id() {
        let a = tmp_dir();
        let b = tmp_dir();
        assert_ne!(load_or_create_in_dir(&a).unwrap(), load_or_create_in_dir(&b).unwrap());
        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
    }

    // ── I8: app update (binary changes, app data survives) → id survives ────
    #[test]
    fn i8_id_survives_an_app_update() {
        let d = tmp_dir();
        let before = load_or_create_in_dir(&d).unwrap();
        // An update replaces the binary; the app data dir — and this file — stay put.
        let after = load_or_create_in_dir(&d).unwrap();
        assert_eq!(before, after);
        let _ = std::fs::remove_dir_all(&d);
    }

    // ── I9: the full id never appears in a log-safe rendering ───────────────
    #[test]
    fn i9_redacted_form_does_not_leak_the_id() {
        let id = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
        let r = redact(id);
        assert_eq!(r, "3f2504e0…");
        assert!(!r.contains(id));
        assert!(r.len() < id.len());
        // The error type must not carry the id either.
        let e = InstallIdError::Invalid { reason: "nil UUID".into() };
        assert!(!format!("{e}").contains(id));
    }

    // ── parse contract ──────────────────────────────────────────────────────
    #[test]
    fn parse_accepts_canonical_and_trims() {
        let id = uuid::Uuid::new_v4().hyphenated().to_string();
        assert_eq!(parse_install_id(&format!("  {id}\n")).unwrap(), id);
    }
}
