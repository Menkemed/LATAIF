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

/// Domain separation for the public fingerprint. A label plus a NUL, so no other hash in the
/// house can ever be made to collide with this one by choosing its input.
const FINGERPRINT_DOMAIN: &[u8] = b"lataif/server-identity/v1\0";

/// The PUBLIC name of this server installation.
///
/// A client has to be able to ask "is this still the same server I recorded progress against?"
/// without the server handing out anything that identifies it further. The install id itself
/// must never leave the machine: it is not a key, but it is the device identity that custody,
/// authority and the primary-host binding compare against, and `redact()` is a truncation, so
/// it discloses part of the real value.
///
/// So the answer is a one-way name derived from it: SHA-256 over a domain label and the id,
/// rendered as 32 hex characters (128 bits). The id is a cryptographically random UUIDv4 with
/// 122 bits of entropy, so the digest cannot be walked back to it, and two different installs
/// cannot share a name by accident. It is stable for the life of the install — a new WLAN, a
/// new IP, a new URL do not touch it — and it changes exactly when the identity does: a fresh
/// install, or a different data root.
pub fn public_fingerprint(id: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(FINGERPRINT_DOMAIN);
    h.update(id.as_bytes());
    let d = h.finalize();
    d.iter().take(16).map(|b| format!("{b:02x}")).collect()
}

/// Short, log-safe form. The full id never belongs in ordinary logs — it is a stable
/// device identifier, so a leaked log line would make installs correlatable.
pub fn redact(id: &str) -> String {
    let head: String = id.chars().take(8).collect();
    format!("{head}…")
}

/// Load the id, or create it exactly once.
///
/// ## The race this avoids — and why `create_new` alone did not
///
/// The first version used `OpenOptions::create_new(true)` and called itself "race-free by
/// construction". It is not. `create_new` is atomic and exclusive about the NAME, but it
/// publishes that name *before* the content is written, so a concurrent starter that
/// loses the create can read the file in the window before the winner's `write_all` and
/// find it **empty**. `parse_install_id` then fails closed — no wrong id is ever handed
/// out — but a legitimate second start dies with "install id unusable" for no reason.
/// `i3_concurrent_creation_yields_one_id` caught it as a flake.
///
/// So the content is written under a unique temporary name first and only then published
/// under the real one with an operation that fails if the name is taken (`hard_link`).
/// The final name therefore never exists half-written: a concurrent starter sees either
/// no file at all, or a complete one.
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
    let tmp = app_data_dir.join(format!(
        ".{INSTALL_ID_FILENAME}.{}.tmp",
        uuid::Uuid::new_v4().as_simple()
    ));

    // 1. Write the COMPLETE file under a name nobody else looks for.
    {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| InstallIdError::Io(e.to_string()))?;
        f.write_all(fresh.as_bytes()).map_err(|e| InstallIdError::Io(e.to_string()))?;
        f.sync_all().map_err(|e| InstallIdError::Io(e.to_string()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
        }
    }

    // 2. Publish it. `hard_link` fails if the destination exists — the create-new
    //    semantics we need, but applied to a file that is already complete. (`rename`
    //    would be wrong here: it silently OVERWRITES, which is exactly what an identity
    //    file must never allow.)
    let published = std::fs::hard_link(&tmp, &path);
    let _ = std::fs::remove_file(&tmp);

    match published {
        Ok(()) => Ok(fresh),
        // Lost the race — the winner's id is authoritative, and it is fully written.
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

    /// A temp dir that cleans itself up on drop — including on panic.
    ///
    /// These directories hold real install-id key material, and cleanup written at the
    /// END of a test body simply does not run when an assertion fails: `Drop` runs during
    /// unwinding, a trailing statement does not. A red test would otherwise leave key
    /// files in the system temp dir.
    pub struct TempDir(std::path::PathBuf);

    impl std::ops::Deref for TempDir {
        type Target = Path;
        fn deref(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    impl TempDir {
        /// Threads need an owned path; a clone of the PathBuf never cleans up on its own,
        /// only the guard does.
        fn path_buf(&self) -> std::path::PathBuf {
            self.0.clone()
        }
    }

    fn tmp_dir() -> TempDir {
        let d = std::env::temp_dir().join(format!(
            "com.lataif.m6b2atest20260716-{}",
            uuid::Uuid::new_v4().as_simple()
        ));
        std::fs::create_dir_all(&d).unwrap();
        TempDir(d)
    }

    // ── I1: fresh app data → exactly one new valid id ───────────────────────
    #[test]
    fn i1_fresh_appdata_creates_exactly_one_valid_id() {
        let d = tmp_dir();
        let id = load_or_create_in_dir(&d).unwrap();
        assert!(uuid::Uuid::parse_str(&id).is_ok(), "must be a valid UUID");
        assert!(!uuid::Uuid::parse_str(&id).unwrap().is_nil());
        assert_eq!(uuid::Uuid::parse_str(&id).unwrap().get_version_num(), 4, "UUIDv4 (CSPRNG)");
        let files: Vec<_> = std::fs::read_dir(&*d).unwrap().filter_map(|e| e.ok()).collect();
        assert_eq!(files.len(), 1, "exactly one file created");
        assert_eq!(files[0].file_name().to_str().unwrap(), INSTALL_ID_FILENAME);
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
    }

    // ── I3: concurrent first creation → exactly one valid file ──────────────
    /// Threads are released from a barrier so they collide inside the create window on
    /// purpose. Before the tmp+`hard_link` fix this failed intermittently with
    /// `Invalid { reason: "file is empty" }` — the loser read the winner's file after
    /// `create_new` had published the name but before `write_all` had filled it.
    #[test]
    fn i3_concurrent_creation_yields_one_id() {
        let d = tmp_dir();
        let mut handles = Vec::new();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(16));
        for _ in 0..16 {
            let dir = d.path_buf();
            let b = barrier.clone();
            handles.push(std::thread::spawn(move || {
                b.wait();
                load_or_create_in_dir(&dir)
            }));
        }
        let ids: Vec<String> = handles.into_iter().map(|h| h.join().unwrap().unwrap()).collect();
        let first = &ids[0];
        assert!(ids.iter().all(|i| i == first), "all threads must agree on one id: {ids:?}");
        let files: Vec<_> = std::fs::read_dir(&*d).unwrap().filter_map(|e| e.ok()).collect();
        assert_eq!(files.len(), 1, "create_new(true) must leave exactly one file");
        // and the file really holds the agreed id
        assert_eq!(
            parse_install_id(&std::fs::read_to_string(d.join(INSTALL_ID_FILENAME)).unwrap()).unwrap(),
            *first
        );
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
        }
    }

    // ── I7: a different app data dir → a different id ───────────────────────
    #[test]
    fn i7_new_appdata_yields_a_new_id() {
        let a = tmp_dir();
        let b = tmp_dir();
        assert_ne!(load_or_create_in_dir(&a).unwrap(), load_or_create_in_dir(&b).unwrap());
    }

    // ── I8: app update (binary changes, app data survives) → id survives ────
    #[test]
    fn i8_id_survives_an_app_update() {
        let d = tmp_dir();
        let before = load_or_create_in_dir(&d).unwrap();
        // An update replaces the binary; the app data dir — and this file — stay put.
        let after = load_or_create_in_dir(&d).unwrap();
        assert_eq!(before, after);
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

    // ── the public fingerprint ──────────────────────────────────────────────
    #[test]
    fn fingerprint_is_stable_and_never_carries_the_id() {
        let id = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
        let f = public_fingerprint(id);
        assert_eq!(f, public_fingerprint(id), "the same install always has the same name");
        assert_eq!(f.len(), 32, "128 bits, hex");
        assert!(f.chars().all(|c| c.is_ascii_hexdigit()));
        // Nothing of the id survives — not the whole, not the head `redact()` would show.
        assert!(!f.contains(id));
        assert!(!f.contains("3f2504e0"));
        for part in id.split('-') {
            assert!(!f.contains(part), "a chunk of the id leaked into the fingerprint: {part}");
        }
    }

    #[test]
    fn fingerprint_separates_two_installs() {
        let a = public_fingerprint(&uuid::Uuid::new_v4().hyphenated().to_string());
        let b = public_fingerprint(&uuid::Uuid::new_v4().hyphenated().to_string());
        assert_ne!(a, b, "two installs must not share a name");
    }

    #[test]
    fn fingerprint_is_domain_separated() {
        // The bare digest of the id must NOT be the fingerprint: a hash taken elsewhere in the
        // house over the same value may not be usable as this identity.
        let id = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
        use sha2::{Digest, Sha256};
        let bare: String = Sha256::digest(id.as_bytes()).iter().take(16).map(|b| format!("{b:02x}")).collect();
        assert_ne!(public_fingerprint(id), bare);
    }

    #[test]
    fn fingerprint_survives_a_restart_of_the_same_install() {
        // The identity lives in the data root, so the same directory yields the same name —
        // this is what makes an address change (new WLAN, new IP) invisible to a client.
        let d = tmp_dir();
        let first = public_fingerprint(&load_or_create_in_dir(&d).unwrap());
        let second = public_fingerprint(&load_or_create_in_dir(&d).unwrap());
        assert_eq!(first, second);
        // A different root is a different install and must be a different name.
        let other = public_fingerprint(&load_or_create_in_dir(&tmp_dir()).unwrap());
        assert_ne!(first, other);
    }

    // ── parse contract ──────────────────────────────────────────────────────
    #[test]
    fn parse_accepts_canonical_and_trims() {
        let id = uuid::Uuid::new_v4().hyphenated().to_string();
        assert_eq!(parse_install_id(&format!("  {id}\n")).unwrap(), id);
    }
}
