//! M6-B2A4 — embedded-server owner provisioning and default-credential elimination.
//!
//! ## The defect this closes
//!
//! `db::init_database` seeded `admin@lataif.com` / `admin` as owner of
//! `tenant-1`/`branch-main` into **every** empty server DB, and nothing in the
//! application could change it: `/auth/login` only reads, `/auth/register` was removed in
//! B2A1, `sync_push` writes only `sync_changelog`, and `users` is not a synced table.
//!
//! Two things rested on that constant:
//!
//! - **`authorize_owner`** — so M6-B2A1's central claim ("the only boundary the renderer
//!   cannot cross is knowledge of the owner password") was false: the knowledge was
//!   printed in the source, identical on every installation. B2A2's confirmed adoption
//!   ceremony kept out accidents, not attackers.
//! - **`/auth/login`** — which is worse, because it is reachable over the LAN. The role
//!   comes from `user_branches`, so the default login returned an **owner JWT**, and that
//!   JWT unlocks every protected route including `/sync/push`. Anyone on the same Wi-Fi
//!   could push arbitrary sync data to the shop's primary.
//!
//! ## The rule now
//!
//! A login is usable only if `server_credentials.credential_state = 'active'`. A missing
//! row means `unprovisioned` — absence is fail-closed, so a user this module has never
//! seen is refused rather than trusted.
//!
//! ## The honest security contract of provisioning
//!
//! Before the first provisioning there is **no cryptographically established owner
//! identity** on this machine, and no way to create one out of nothing. The boundary is
//! therefore **local control of the operating system and the running Tauri app**: a local
//! command, no HTTP route, an explicit confirmation phrase. That is a real boundary — it
//! is not a remote-authenticated one, and this module does not pretend otherwise.

use rusqlite::{params, Connection, OptionalExtension};

/// The shipped legacy default. Used for **exactly one purpose**: recognising and
/// devaluing it. It is never an accepted login — `is_legacy_default` is only ever read to
/// decide that a credential must be `unprovisioned`.
const LEGACY_DEFAULT_EMAIL: &str = "admin@lataif.com";
const LEGACY_DEFAULT_PASSWORD: &str = "admin";
const LEGACY_TENANT: &str = "tenant-1";
const LEGACY_BRANCH: &str = "branch-main";

/// Not a bcrypt hash — `bcrypt::verify` errors on it and every caller does
/// `.unwrap_or(false)`, so no password can ever match. Same device as
/// `SYSTEM_PRINCIPAL_UNUSABLE_HASH`: a placeholder owner exists (lots of code depends on
/// the stable `user-owner` id) but has no password at all until someone provisions one.
pub const UNUSABLE_HASH: &str = "!";

/// bcrypt cost for real, provisioned passwords.
const BCRYPT_COST: u32 = 12;

/// §6 — the phrase the owner must type. It replaces no technical guarantee; it makes a
/// consequential act deliberate.
pub const PROVISION_CONFIRMATION: &str = "PROVISION_THIS_DEVICE_AS_SERVER_OWNER";

/// §6 — minimum length for a provisioned server password.
pub const MIN_PASSWORD_LEN: usize = 12;

// ── Error codes ─────────────────────────────────────────────────────────────
pub const ERR_PROVISIONING_REQUIRED: &str = "OWNER_PROVISIONING_REQUIRED";
pub const ERR_ALREADY_PROVISIONED: &str = "OWNER_ALREADY_PROVISIONED";
pub const ERR_NOT_CONFIRMED: &str = "PROVISION_CONFIRMATION_REQUIRED";
pub const ERR_PASSWORD_TOO_SHORT: &str = "PROVISION_PASSWORD_TOO_SHORT";
pub const ERR_PASSWORD_MISMATCH: &str = "PROVISION_PASSWORD_MISMATCH";
pub const ERR_OWNER_REQUIRED: &str = "OWNER_AUTHORIZATION_REQUIRED";

/// Lifecycle of one embedded-server login.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialState {
    /// No usable password. The default state, and the state a recognised legacy default
    /// is forced into.
    Unprovisioned,
    Active,
    Disabled,
    RecoveryRequired,
}

impl CredentialState {
    pub fn as_str(self) -> &'static str {
        match self {
            CredentialState::Unprovisioned => "unprovisioned",
            CredentialState::Active => "active",
            CredentialState::Disabled => "disabled",
            CredentialState::RecoveryRequired => "recovery_required",
        }
    }
    pub fn parse(s: &str) -> Option<CredentialState> {
        match s {
            "unprovisioned" => Some(CredentialState::Unprovisioned),
            "active" => Some(CredentialState::Active),
            "disabled" => Some(CredentialState::Disabled),
            "recovery_required" => Some(CredentialState::RecoveryRequired),
            _ => None,
        }
    }
    /// The one question every authentication path asks.
    pub fn may_authenticate(self) -> bool {
        matches!(self, CredentialState::Active)
    }
}

/// The credential state of a user. **A missing row is `Unprovisioned`** — absence must
/// never read as permission.
pub fn state_of(conn: &Connection, user_id: &str) -> CredentialState {
    conn.query_row(
        "SELECT credential_state FROM server_credentials WHERE user_id = ?1",
        params![user_id],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
    .and_then(|s| CredentialState::parse(&s))
    .unwrap_or(CredentialState::Unprovisioned)
}

/// Is the given owner row the shipped legacy default?
///
/// All five facts must line up. A shop that deliberately set its own password on
/// `admin@lataif.com` is NOT a legacy default and must keep working (§5, M4).
fn is_legacy_default(
    tenant_id: &str,
    branch_id: &str,
    email: &str,
    role: &str,
    password_hash: &str,
) -> bool {
    tenant_id == LEGACY_TENANT
        && branch_id == LEGACY_BRANCH
        && email == LEGACY_DEFAULT_EMAIL
        && role == "owner"
        && bcrypt::verify(LEGACY_DEFAULT_PASSWORD, password_hash).unwrap_or(false)
}

fn upsert_state(
    conn: &Connection,
    user_id: &str,
    state: CredentialState,
    password_changed_at: Option<&str>,
    provisioned_at: Option<&str>,
    provisioned_by: Option<&str>,
    reason: &str,
) -> rusqlite::Result<()> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO server_credentials
           (user_id, credential_state, password_changed_at, provisioned_at, provisioned_by,
            classified_reason, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
         ON CONFLICT (user_id) DO UPDATE SET
           credential_state = excluded.credential_state,
           password_changed_at = excluded.password_changed_at,
           provisioned_at = excluded.provisioned_at,
           provisioned_by = excluded.provisioned_by,
           classified_reason = excluded.classified_reason,
           updated_at = excluded.updated_at",
        params![user_id, state.as_str(), password_changed_at, provisioned_at, provisioned_by, reason, now],
    )?;
    Ok(())
}

/// §5 — classify every login exactly once, then never touch it again.
///
/// Runs on every `init_database`. Idempotent and transactional: a user that already has a
/// credential row is left strictly alone, so a later run cannot re-decide, and a
/// provisioned password cannot be reverted by restarting the app.
///
/// - recognised legacy default → `unprovisioned`, and the old hash is **replaced** with
///   the unusable sentinel. Leaving it in place would keep a working `admin` password one
///   forgotten check away from being accepted again; the point is to make the secret
///   *not exist*, not merely to gate it.
/// - system principal → `disabled` (it already has an unusable hash and `active = 0`)
/// - anything else with a real hash → `active`. A shop that set its own password must not
///   be locked out by a hardening release (§5, M4).
pub fn classify_existing(conn: &mut Connection) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;

    // Only users this module has never classified. An existing row is never re-decided —
    // that is what makes repeated runs (every app start) a true no-op.
    let rows: Vec<(String, String, String, String, String)> = {
        let mut stmt = tx.prepare(
            "SELECT u.id, u.tenant_id, u.email, u.password_hash,
                    COALESCE((SELECT ub.role FROM user_branches ub
                               WHERE ub.user_id = u.id AND ub.branch_id = ?1), '')
               FROM users u
              WHERE NOT EXISTS (SELECT 1 FROM server_credentials c WHERE c.user_id = u.id)",
        )?;
        let v = stmt
            .query_map(params![LEGACY_BRANCH], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })?
            .filter_map(|r| r.ok())
            .collect();
        v
    };

    let now = chrono::Utc::now().to_rfc3339();
    for (user_id, tenant_id, email, hash, role) in rows {
        if user_id == super::db::SYSTEM_PRINCIPAL_ID {
            upsert_state(&tx, &user_id, CredentialState::Disabled, None, None, None, "system-principal")?;
            continue;
        }
        if is_legacy_default(&tenant_id, LEGACY_BRANCH, &email, &role, &hash) {
            // Devalue the secret itself, not just the gate.
            tx.execute(
                "UPDATE users SET password_hash = ?2, updated_at = ?3 WHERE id = ?1",
                params![user_id, UNUSABLE_HASH, now],
            )?;
            upsert_state(
                &tx,
                &user_id,
                CredentialState::Unprovisioned,
                None,
                None,
                None,
                "legacy-default-devalued",
            )?;
            continue;
        }
        if hash == UNUSABLE_HASH || hash.is_empty() {
            upsert_state(&tx, &user_id, CredentialState::Unprovisioned, None, None, None, "no-usable-hash")?;
            continue;
        }
        // A real, non-default password that predates this migration. Keep it working.
        upsert_state(
            &tx,
            &user_id,
            CredentialState::Active,
            Some(&now),
            None,
            None,
            "pre-existing-non-default-password",
        )?;
    }

    tx.commit()?;
    Ok(())
}

/// Is there at least one owner who can actually authenticate?
///
/// Deliberately a SERVER-WIDE fact, not a per-user one: `/auth/login` answers with it
/// before looking any user up, so "this server is not provisioned" leaks nothing about
/// which accounts exist (§4, no user enumeration).
pub fn owner_credentials_ready(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT COUNT(*)
           FROM users u
           JOIN user_branches ub ON ub.user_id = u.id
           JOIN server_credentials c ON c.user_id = u.id
          WHERE ub.role = 'owner' AND u.active = 1 AND c.credential_state = 'active'",
        [],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n > 0)
    .unwrap_or(false)
}

fn validate_new_password(password: &str, confirmation: &str) -> Result<(), &'static str> {
    if password.chars().count() < MIN_PASSWORD_LEN {
        return Err(ERR_PASSWORD_TOO_SHORT);
    }
    if password != confirmation {
        return Err(ERR_PASSWORD_MISMATCH);
    }
    Ok(())
}

/// The owner placeholder this server provisions.
fn owner_row(conn: &Connection) -> Option<(String, String)> {
    conn.query_row(
        "SELECT u.id, u.password_hash
           FROM users u
           JOIN user_branches ub ON ub.user_id = u.id AND ub.branch_id = ?2
          WHERE u.tenant_id = ?1 AND ub.role = 'owner' AND u.active = 1
          ORDER BY u.id LIMIT 1",
        params![LEGACY_TENANT, LEGACY_BRANCH],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
    .ok()
    .flatten()
}

/// §6 — first provisioning. Local Tauri command only; there is no HTTP route.
///
/// `provisioned_by` is the fixed constant `local-bootstrap`, not anything the caller
/// supplied: at this moment no verified identity exists to name, and accepting one from
/// the renderer would be recording a claim as if it were a fact.
pub fn provision_owner(
    conn: &Connection,
    password: &str,
    confirmation_password: &str,
    confirmation: &str,
) -> Result<String, &'static str> {
    if confirmation != PROVISION_CONFIRMATION {
        return Err(ERR_NOT_CONFIRMED);
    }
    validate_new_password(password, confirmation_password)?;

    let (user_id, _) = owner_row(conn).ok_or(ERR_PROVISIONING_REQUIRED)?;
    // §13 P5 — exactly once. A second provisioning would be a password reset without
    // knowing the current password, i.e. a local takeover of an already-owned server.
    if state_of(conn, &user_id) == CredentialState::Active {
        return Err(ERR_ALREADY_PROVISIONED);
    }

    let hash = bcrypt::hash(password, BCRYPT_COST).map_err(|_| ERR_PROVISIONING_REQUIRED)?;
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE users SET password_hash = ?2, updated_at = ?3 WHERE id = ?1",
        params![user_id, hash, now],
    )
    .map_err(|_| ERR_PROVISIONING_REQUIRED)?;
    upsert_state(
        conn,
        &user_id,
        CredentialState::Active,
        Some(&now),
        Some(&now),
        Some("local-bootstrap"),
        "local-provisioning",
    )
    .map_err(|_| ERR_PROVISIONING_REQUIRED)?;
    Ok(user_id)
}

/// §8 — change the password of an already-active owner. Requires the CURRENT one.
pub fn change_owner_password(
    conn: &Connection,
    email: &str,
    current_password: &str,
    new_password: &str,
    confirmation_password: &str,
) -> Result<String, &'static str> {
    validate_new_password(new_password, confirmation_password)?;
    // Goes through the hardened `authorize_owner`, so state, role, tenant, branch and the
    // current password are all re-checked in one place.
    let owner = super::primary::authorize_owner(conn, LEGACY_TENANT, LEGACY_BRANCH, email, current_password)?;
    let hash = bcrypt::hash(new_password, BCRYPT_COST).map_err(|_| ERR_OWNER_REQUIRED)?;
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE users SET password_hash = ?2, updated_at = ?3 WHERE id = ?1",
        params![owner.user_id(), hash, now],
    )
    .map_err(|_| ERR_OWNER_REQUIRED)?;
    upsert_state(
        conn,
        owner.user_id(),
        CredentialState::Active,
        Some(&now),
        None,
        None,
        "password-changed",
    )
    .map_err(|_| ERR_OWNER_REQUIRED)?;
    Ok(owner.user_id().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::db;

    /// A server DB in the state the OLD `init_database` produced: admin/admin active.
    fn legacy_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
                plan TEXT, active INTEGER, max_branches INTEGER, max_users INTEGER,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
             CREATE TABLE branches (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
                name TEXT NOT NULL, country TEXT, currency TEXT, address TEXT, active INTEGER,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
             CREATE TABLE users (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
                email TEXT NOT NULL, password_hash TEXT NOT NULL, name TEXT NOT NULL, active INTEGER,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(tenant_id, email));
             CREATE TABLE user_branches (user_id TEXT NOT NULL REFERENCES users(id),
                branch_id TEXT NOT NULL REFERENCES branches(id), role TEXT NOT NULL,
                is_default INTEGER, created_at TEXT NOT NULL, PRIMARY KEY (user_id, branch_id));
             CREATE TABLE sync_changelog (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL,
                branch_id TEXT NOT NULL, table_name TEXT NOT NULL, record_id TEXT NOT NULL,
                action TEXT NOT NULL, data TEXT NOT NULL, user_id TEXT, created_at TEXT NOT NULL);
             INSERT INTO tenants (id, name, slug, created_at, updated_at) VALUES ('tenant-1','T','t','n','n');
             INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-main','tenant-1','B','n','n');",
        )
        .unwrap();
        let legacy_hash = bcrypt::hash("admin", 4).unwrap();
        conn.execute(
            "INSERT INTO users (id, tenant_id, email, password_hash, name, active, created_at, updated_at)
             VALUES ('user-owner','tenant-1','admin@lataif.com',?1,'Admin',1,'n','n')",
            params![legacy_hash],
        )
        .unwrap();
        conn.execute_batch(
            "INSERT INTO user_branches VALUES ('user-owner','branch-main','owner',1,'n');",
        )
        .unwrap();
        lataif_server::migrations::run_migrations(&conn, crate::sync::migrations::EMBEDDED_MIGRATIONS)
            .unwrap();
        conn
    }

    const GOOD_PW: &str = "a-real-owner-password";

    // ── M1/M2: the legacy default is recognised and devalued ─────────────────
    #[test]
    fn m1_m2_legacy_default_becomes_unprovisioned_and_stops_working() {
        let mut conn = legacy_db();
        // Precondition — the hole, shown at the layer it actually lived in: the stored
        // hash really is bcrypt("admin"), so every `bcrypt::verify` in the codebase
        // (`authorize_owner`, `/auth/login`) said yes to a constant printed in `db.rs`.
        // Asserted against the hash rather than through `authorize_owner`, because
        // `authorize_owner` now refuses one step earlier — which is the fix, not the hole.
        let before: String = conn
            .query_row("SELECT password_hash FROM users WHERE id='user-owner'", [], |r| r.get(0))
            .unwrap();
        assert!(
            bcrypt::verify("admin", &before).unwrap_or(false),
            "precondition: this is exactly the secret B2A4 destroys"
        );

        classify_existing(&mut conn).unwrap();

        // M1
        assert_eq!(state_of(&conn, "user-owner"), CredentialState::Unprovisioned);
        assert!(!owner_credentials_ready(&conn), "no usable owner remains");
        // M2 — and not merely gated: the secret itself is gone.
        let hash: String = conn
            .query_row("SELECT password_hash FROM users WHERE id='user-owner'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(hash, UNUSABLE_HASH, "the default hash must be REPLACED, not just refused");
        assert!(!bcrypt::verify("admin", &hash).unwrap_or(false));
    }

    // ── M3: idempotent ───────────────────────────────────────────────────────
    #[test]
    fn m3_classification_is_idempotent() {
        let mut conn = legacy_db();
        classify_existing(&mut conn).unwrap();
        // Provision a real password…
        provision_owner(&conn, GOOD_PW, GOOD_PW, PROVISION_CONFIRMATION).unwrap();
        let after: String = conn
            .query_row("SELECT password_hash FROM users WHERE id='user-owner'", [], |r| r.get(0))
            .unwrap();

        // …and run classification twice more, as every app start does.
        classify_existing(&mut conn).unwrap();
        classify_existing(&mut conn).unwrap();

        assert_eq!(state_of(&conn, "user-owner"), CredentialState::Active, "must not be re-decided");
        let now: String = conn
            .query_row("SELECT password_hash FROM users WHERE id='user-owner'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(now, after, "a restart must never touch a provisioned password");
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM server_credentials WHERE user_id='user-owner'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }

    // ── M4: a real non-default password is NOT devalued ──────────────────────
    #[test]
    fn m4_non_default_password_is_kept_active() {
        let mut conn = legacy_db();
        // The shop set its own password on the same account.
        let real = bcrypt::hash("their-own-password", 4).unwrap();
        conn.execute("UPDATE users SET password_hash = ?1 WHERE id='user-owner'", params![real])
            .unwrap();

        classify_existing(&mut conn).unwrap();

        assert_eq!(
            state_of(&conn, "user-owner"),
            CredentialState::Active,
            "a hardening release must not lock out a shop that already did the right thing"
        );
        assert!(owner_credentials_ready(&conn));
        assert!(crate::sync::primary::authorize_owner(
            &conn, "tenant-1", "branch-main", LEGACY_DEFAULT_EMAIL, "their-own-password"
        )
        .is_ok());
        // …and the default still does not work.
        assert!(crate::sync::primary::authorize_owner(
            &conn, "tenant-1", "branch-main", LEGACY_DEFAULT_EMAIL, "admin"
        )
        .is_err());
    }

    // ── M5: staff does not become owner ──────────────────────────────────────
    #[test]
    fn m5_staff_is_not_promoted() {
        let mut conn = legacy_db();
        let h = bcrypt::hash("staff-pw", 4).unwrap();
        conn.execute(
            "INSERT INTO users (id, tenant_id, email, password_hash, name, active, created_at, updated_at)
             VALUES ('user-staff','tenant-1','staff@x.com',?1,'S',1,'n','n')",
            params![h],
        )
        .unwrap();
        conn.execute_batch("INSERT INTO user_branches VALUES ('user-staff','branch-main','staff',0,'n');")
            .unwrap();

        classify_existing(&mut conn).unwrap();

        // Staff keeps a usable credential (they are a legitimate login)…
        assert_eq!(state_of(&conn, "user-staff"), CredentialState::Active);
        // …but is not an owner, so the server is still not provisioned…
        assert!(!owner_credentials_ready(&conn), "only an OWNER counts as provisioning");
        // …and cannot pass owner authorization.
        assert!(crate::sync::primary::authorize_owner(
            &conn, "tenant-1", "branch-main", "staff@x.com", "staff-pw"
        )
        .is_err());
    }

    // ── M6: wrong tenant/branch stays refused ────────────────────────────────
    #[test]
    fn m6_foreign_tenant_or_branch_is_still_refused() {
        let mut conn = legacy_db();
        classify_existing(&mut conn).unwrap();
        provision_owner(&conn, GOOD_PW, GOOD_PW, PROVISION_CONFIRMATION).unwrap();
        for (t, b) in [("tenant-FREMD", "branch-main"), ("tenant-1", "branch-FREMD")] {
            assert!(
                crate::sync::primary::authorize_owner(&conn, t, b, LEGACY_DEFAULT_EMAIL, GOOD_PW).is_err(),
                "{t}/{b} must stay refused"
            );
        }
    }

    // ── the legacy-default detector needs ALL five facts ──────────────────────
    #[test]
    fn legacy_detection_requires_every_fact() {
        let h = bcrypt::hash("admin", 4).unwrap();
        assert!(is_legacy_default("tenant-1", "branch-main", "admin@lataif.com", "owner", &h));
        // any one fact off → not the shipped default
        assert!(!is_legacy_default("tenant-2", "branch-main", "admin@lataif.com", "owner", &h));
        assert!(!is_legacy_default("tenant-1", "branch-two", "admin@lataif.com", "owner", &h));
        assert!(!is_legacy_default("tenant-1", "branch-main", "someone@else.com", "owner", &h));
        assert!(!is_legacy_default("tenant-1", "branch-main", "admin@lataif.com", "staff", &h));
        let other = bcrypt::hash("not-admin", 4).unwrap();
        assert!(!is_legacy_default("tenant-1", "branch-main", "admin@lataif.com", "owner", &other));
    }

    // ── P1/P8/P9/P10: first provisioning ─────────────────────────────────────
    #[test]
    fn p1_local_provisioning_works() {
        let mut conn = legacy_db();
        classify_existing(&mut conn).unwrap();
        assert!(!owner_credentials_ready(&conn));

        let user_id = provision_owner(&conn, GOOD_PW, GOOD_PW, PROVISION_CONFIRMATION).unwrap();
        assert_eq!(user_id, "user-owner");
        assert_eq!(state_of(&conn, "user-owner"), CredentialState::Active);
        assert!(owner_credentials_ready(&conn));

        // P7 — the new password authorizes.
        assert!(crate::sync::primary::authorize_owner(
            &conn, "tenant-1", "branch-main", LEGACY_DEFAULT_EMAIL, GOOD_PW
        )
        .is_ok());

        // P8 — the plaintext is nowhere in the DB.
        let (hash, state): (String, String) = conn
            .query_row(
                "SELECT u.password_hash, c.credential_state FROM users u
                   JOIN server_credentials c ON c.user_id = u.id WHERE u.id='user-owner'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert!(!hash.contains(GOOD_PW), "never store the plaintext");
        assert!(hash.starts_with("$2"), "a real bcrypt hash");
        assert!(bcrypt::verify(GOOD_PW, &hash).unwrap());
        assert_eq!(state, "active");

        // P10 — provisioned_by is a fixed constant; the caller never supplies it.
        let (by, at, changed): (Option<String>, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT provisioned_by, provisioned_at, password_changed_at
                   FROM server_credentials WHERE user_id='user-owner'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(by.as_deref(), Some("local-bootstrap"));
        assert!(at.is_some() && changed.is_some());
    }

    // ── P2/P3/P4/P5: provisioning refusals ───────────────────────────────────
    #[test]
    fn p2_p3_p4_p5_provisioning_refusals() {
        let mut conn = legacy_db();
        classify_existing(&mut conn).unwrap();

        // P2 — missing/wrong phrase
        for bad in ["", "yes", "PROVISION_THIS_DEVICE"] {
            assert_eq!(provision_owner(&conn, GOOD_PW, GOOD_PW, bad).unwrap_err(), ERR_NOT_CONFIRMED);
        }
        // P3 — too short (boundary checked both ways)
        let eleven = "a".repeat(MIN_PASSWORD_LEN - 1);
        assert_eq!(
            provision_owner(&conn, &eleven, &eleven, PROVISION_CONFIRMATION).unwrap_err(),
            ERR_PASSWORD_TOO_SHORT
        );
        // P4 — confirmation mismatch
        assert_eq!(
            provision_owner(&conn, GOOD_PW, "something-else", PROVISION_CONFIRMATION).unwrap_err(),
            ERR_PASSWORD_MISMATCH
        );
        // nothing was written by any refusal
        assert_eq!(state_of(&conn, "user-owner"), CredentialState::Unprovisioned);
        assert!(!owner_credentials_ready(&conn));

        // exactly at the boundary → accepted
        let twelve = "b".repeat(MIN_PASSWORD_LEN);
        assert!(provision_owner(&conn, &twelve, &twelve, PROVISION_CONFIRMATION).is_ok());

        // P5 — a second provisioning is refused
        assert_eq!(
            provision_owner(&conn, GOOD_PW, GOOD_PW, PROVISION_CONFIRMATION).unwrap_err(),
            ERR_ALREADY_PROVISIONED,
            "provisioning must not double as an unauthenticated password reset"
        );
        // and the first password still stands
        assert!(crate::sync::primary::authorize_owner(
            &conn, "tenant-1", "branch-main", LEGACY_DEFAULT_EMAIL, &twelve
        )
        .is_ok());
    }

    // ── C1–C5: password change ───────────────────────────────────────────────
    #[test]
    fn c1_to_c5_password_change() {
        let mut conn = legacy_db();
        classify_existing(&mut conn).unwrap();
        provision_owner(&conn, GOOD_PW, GOOD_PW, PROVISION_CONFIRMATION).unwrap();
        const NEW_PW: &str = "an-even-better-password";

        // C2 — wrong current password
        assert_eq!(
            change_owner_password(&conn, LEGACY_DEFAULT_EMAIL, "wrong", NEW_PW, NEW_PW).unwrap_err(),
            ERR_OWNER_REQUIRED
        );
        // and the devalued legacy default is not a way in either
        assert_eq!(
            change_owner_password(&conn, LEGACY_DEFAULT_EMAIL, "admin", NEW_PW, NEW_PW).unwrap_err(),
            ERR_OWNER_REQUIRED
        );

        // C1 — the active owner changes it
        change_owner_password(&conn, LEGACY_DEFAULT_EMAIL, GOOD_PW, NEW_PW, NEW_PW).unwrap();

        // C4 — the old password is dead
        assert!(crate::sync::primary::authorize_owner(
            &conn, "tenant-1", "branch-main", LEGACY_DEFAULT_EMAIL, GOOD_PW
        )
        .is_err());
        // C5 — the new one works
        assert!(crate::sync::primary::authorize_owner(
            &conn, "tenant-1", "branch-main", LEGACY_DEFAULT_EMAIL, NEW_PW
        )
        .is_ok());
        assert_eq!(state_of(&conn, "user-owner"), CredentialState::Active);
    }

    // ── C3: staff cannot change the owner password ───────────────────────────
    #[test]
    fn c3_staff_cannot_change_the_owner_password() {
        let mut conn = legacy_db();
        let h = bcrypt::hash("staff-pw", 4).unwrap();
        conn.execute(
            "INSERT INTO users (id, tenant_id, email, password_hash, name, active, created_at, updated_at)
             VALUES ('user-staff','tenant-1','staff@x.com',?1,'S',1,'n','n')",
            params![h],
        )
        .unwrap();
        conn.execute_batch("INSERT INTO user_branches VALUES ('user-staff','branch-main','staff',0,'n');")
            .unwrap();
        classify_existing(&mut conn).unwrap();
        provision_owner(&conn, GOOD_PW, GOOD_PW, PROVISION_CONFIRMATION).unwrap();

        assert_eq!(
            change_owner_password(&conn, "staff@x.com", "staff-pw", "new-staff-password", "new-staff-password")
                .unwrap_err(),
            ERR_OWNER_REQUIRED,
            "correct credentials, wrong role"
        );
        // the owner password is untouched
        assert!(crate::sync::primary::authorize_owner(
            &conn, "tenant-1", "branch-main", LEGACY_DEFAULT_EMAIL, GOOD_PW
        )
        .is_ok());
    }

    // ── O1–O10: the shipped default is dead everywhere ───────────────────────
    //
    // Driven through the REAL `init_database` on a real file, not a hand-built schema:
    // the claim is about what a fresh installation actually produces.
    mod default_credential {
        use super::*;
        use crate::sync::primary;

        /// A self-deleting temp dir. The guard lives in the FIELD, deliberately — a
        /// `Drop` on the container would not work: `Drop::drop(&mut self)` runs BEFORE
        /// the struct's fields are dropped, so it would try to delete the directory while
        /// its own `conn` still holds the server DB open, and Windows refuses that. With
        /// the guard as a field, fields drop in declaration order — `conn` closes first,
        /// then `dir` deletes — and it holds through a panicking test too (§18).
        struct TempDir(std::path::PathBuf);
        impl std::ops::Deref for TempDir {
            type Target = std::path::Path;
            fn deref(&self) -> &std::path::Path {
                &self.0
            }
        }
        impl Drop for TempDir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }

        fn tmp_dir() -> TempDir {
            let d = std::env::temp_dir()
                .join(format!("com.lataif.m6b2a4test-{}", uuid::Uuid::new_v4().as_simple()));
            std::fs::create_dir_all(&d).unwrap();
            TempDir(d)
        }

        /// NO `impl Drop for Fresh` — see `TempDir`. Field order is the mechanism.
        struct Fresh {
            conn: Connection,
            dir: TempDir,
        }
        fn fresh_install() -> Fresh {
            let dir = tmp_dir();
            let conn = db::init_database(&dir.join("lataif_sync_server.db")).unwrap();
            Fresh { conn, dir }
        }

        // ── O1: a fresh DB does not accept admin/admin ───────────────────────
        #[test]
        fn o1_fresh_db_rejects_the_default() {
            let f = fresh_install();

            // The account still exists — plenty of code depends on the stable ids…
            let (email, hash, active): (String, String, i64) = f
                .conn
                .query_row(
                    "SELECT email, password_hash, active FROM users WHERE id='user-owner'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .unwrap();
            assert_eq!(email, "admin@lataif.com");
            assert_eq!(active, 1);
            // …but there is no password to guess, not merely a gated one.
            assert_eq!(hash, UNUSABLE_HASH);
            assert!(!bcrypt::verify("admin", &hash).unwrap_or(false));
            assert!(!bcrypt::verify("", &hash).unwrap_or(false));
            assert_eq!(state_of(&f.conn, "user-owner"), CredentialState::Unprovisioned);
            assert!(!owner_credentials_ready(&f.conn));
        }

        // ── O3: authorize_owner refuses it ───────────────────────────────────
        #[test]
        fn o3_authorize_owner_rejects_the_default() {
            let f = fresh_install();
            for pw in ["admin", "", "Admin", "!"] {
                assert_eq!(
                    primary::authorize_owner(&f.conn, "tenant-1", "branch-main", "admin@lataif.com", pw)
                        .unwrap_err(),
                    primary::ERR_OWNER_PROVISIONING_REQUIRED,
                    "password {pw:?} must not authorize on an unprovisioned server"
                );
            }
        }

        // ── O4–O8: every owner-gated command inherits the refusal ────────────
        //
        // Checked at the ONE place they all funnel through. `primary_configure`,
        // `primary_adopt_legacy`, `sync_server_stop`, and the trust-root / authority
        // commands (B2BC, currently stashed) each begin with `authorize_owner`, so O3
        // covers all of them by construction — this test pins that structure so a future
        // command cannot quietly grow its own auth.
        #[test]
        fn o4_to_o8_every_owner_command_funnels_through_authorize_owner() {
            let src = include_str!("../lib.rs");
            let prod = &src[..src.find("#[cfg(test)]").unwrap_or(src.len())];

            for cmd in [
                "async fn primary_configure",
                "async fn primary_adopt_legacy",
                "async fn sync_server_stop",
                "async fn server_owner_change_password",
            ] {
                let start = prod.find(cmd).unwrap_or_else(|| panic!("{cmd} not found"));
                let rest = &prod[start..];
                let end = rest[1..].find("\n#[tauri::command]").map(|i| i + 1).unwrap_or(rest.len());
                let body = &rest[..end];
                assert!(
                    body.contains("authorize_owner") || body.contains("change_owner_password"),
                    "{cmd} must go through the central owner check"
                );
            }
            // …and the two commands that legitimately do NOT (there is no owner yet, or
            // the answer is not a secret) are exactly these:
            let provision_start = prod.find("async fn server_owner_provision").unwrap();
            let provision = &prod[provision_start..provision_start + 600];
            assert!(
                provision.contains("provision_owner"),
                "provisioning cannot require an owner — it creates the first one"
            );
        }

        // ── O2/O9: /auth/login issues no JWT before provisioning ─────────────
        #[test]
        fn o2_o9_login_is_refused_and_mints_no_owner_jwt() {
            let f = fresh_install();
            // The route's precondition, evaluated exactly as `login` evaluates it.
            assert!(
                !owner_credentials_ready(&f.conn),
                "O2: login must answer OWNER_PROVISIONING_REQUIRED in this state"
            );

            // O9 — and the check sits BEFORE the user lookup, so it cannot be used to
            // probe which e-mails exist.
            let src = include_str!("routes.rs");
            let start = src.find("async fn login").unwrap();
            // Bounded by the NEXT top-level fn, not by a fixed character count — a fixed
            // window silently measures the wrong code the moment the function grows.
            let rest = &src[start..];
            let end = ["\nasync fn ", "\nfn ", "\npub fn ", "\npub async fn "]
                .iter()
                .filter_map(|m| rest[1..].find(m).map(|i| i + 1))
                .min()
                .unwrap_or(rest.len());
            let body = &rest[..end];
            let ready_at = body.find("owner_credentials_ready").expect("login must gate on it");
            let lookup_at = body.find("FROM users u").expect("the user lookup");
            assert!(
                ready_at < lookup_at,
                "O9/§4: the provisioning check must precede the user lookup — otherwise it \
                 leaks which accounts exist"
            );
            // and the per-user state is checked before the password comparison
            let state_at = body.find("state_of(&db, &user_id)").expect("per-user credential check");
            let verify_at = body.find("bcrypt::verify").expect("the password check");
            assert!(state_at < verify_at);
        }

        // ── O10: no writing server before provisioning ───────────────────────
        #[test]
        fn o10_no_server_starts_before_provisioning() {
            let f = fresh_install();
            assert!(!owner_credentials_ready(&f.conn));

            // `SyncServer::start` refuses before binding a port — asserted at the source,
            // because starting a real server in a unit test would bind a real port.
            let src = include_str!("mod.rs");
            let start = src.find("pub async fn start").unwrap();
            let body = &src[start..];
            let gate_at = body.find("owner_credentials_ready").expect("start must gate on it");
            let bind_at = body.find("TcpListener::bind").unwrap_or(body.len());
            assert!(gate_at < bind_at, "the check must come BEFORE any port is bound");
        }

        // ── M7/M8: a copied B2A DB gets no free owner ────────────────────────
        #[test]
        fn m7_m8_copied_db_and_legacy_pending_stay_shut() {
            let f = fresh_install();
            let id = crate::sync::install_id::load_or_create_in_dir(&f.dir).unwrap();

            // M8 — a legacy hint still lands in legacy_pending (B2A2 holds)…
            f.conn
                .execute(
                    "INSERT INTO sync_changelog (tenant_id, branch_id, table_name, record_id, action, data, user_id, created_at)
                     VALUES ('tenant-1','branch-main','products','p1','update','{}','self-desktop','n')",
                    [],
                )
                .unwrap();
            let legacy = primary::LegacyLanConfig { mode: Some("server".into()), setup_done: true };
            assert_eq!(
                primary::migrate_once(&f.conn, "tenant-1", "branch-main", &legacy, &id).unwrap(),
                primary::Mode::LegacyPending
            );
            // …and now it cannot be adopted at all, because there is no owner to ask.
            assert_eq!(
                primary::authorize_owner(&f.conn, "tenant-1", "branch-main", "admin@lataif.com", "admin")
                    .unwrap_err(),
                primary::ERR_OWNER_PROVISIONING_REQUIRED,
                "M8: the B2A2 adoption ceremony is no longer satisfiable by a public constant"
            );

            // M7 — no automatic owner activation appeared from any of this.
            assert!(!owner_credentials_ready(&f.conn));
            assert_eq!(state_of(&f.conn, "user-owner"), CredentialState::Unprovisioned);
        }

        // ── C6: the state survives a restart ─────────────────────────────────
        #[test]
        fn c6_provisioned_state_survives_a_restart() {
            let dir = tmp_dir();
            let path = dir.join("lataif_sync_server.db");

            {
                let conn = db::init_database(&path).unwrap();
                provision_owner(&conn, GOOD_PW, GOOD_PW, PROVISION_CONFIRMATION).unwrap();
                assert!(owner_credentials_ready(&conn));
            } // connection closed — the app quits

            // …and starts again, re-running init_database + classify_existing.
            {
                let conn = db::init_database(&path).unwrap();
                assert!(
                    owner_credentials_ready(&conn),
                    "a restart must not un-provision the server"
                );
                assert!(primary::authorize_owner(
                    &conn, "tenant-1", "branch-main", "admin@lataif.com", GOOD_PW
                )
                .is_ok());
                assert_eq!(state_of(&conn, "user-owner"), CredentialState::Active);
            }

        }

        // ── P9: the plaintext never reaches a log or an error ────────────────
        #[test]
        fn p9_plaintext_never_appears_in_errors() {
            let f = fresh_install();
            let secret = "super-secret-owner-password";

            for e in [
                provision_owner(&f.conn, secret, "mismatch", PROVISION_CONFIRMATION).unwrap_err(),
                provision_owner(&f.conn, secret, secret, "wrong-phrase").unwrap_err(),
                change_owner_password(&f.conn, "admin@lataif.com", secret, secret, secret)
                    .unwrap_err(),
            ] {
                assert!(!e.contains(secret), "error {e:?} must not echo the password");
            }
            // The error codes are fixed constants — they cannot carry data by construction.
            for code in [ERR_NOT_CONFIRMED, ERR_PASSWORD_MISMATCH, ERR_PASSWORD_TOO_SHORT, ERR_OWNER_REQUIRED] {
                assert!(!code.contains(secret));
            }
        }
    }

    // ── the state machine itself ─────────────────────────────────────────────
    #[test]
    fn only_active_may_authenticate() {
        for s in [
            CredentialState::Unprovisioned,
            CredentialState::Disabled,
            CredentialState::RecoveryRequired,
        ] {
            assert!(!s.may_authenticate(), "{s:?} must not authenticate");
            assert_eq!(CredentialState::parse(s.as_str()), Some(s));
        }
        assert!(CredentialState::Active.may_authenticate());
        assert_eq!(CredentialState::parse("owner"), None);
    }

    /// The fail-closed default: a user this module has never classified is refused.
    #[test]
    fn a_user_without_a_credential_row_is_unprovisioned() {
        let conn = legacy_db();
        assert_eq!(
            state_of(&conn, "user-owner"),
            CredentialState::Unprovisioned,
            "absence must never read as permission"
        );
        assert_eq!(state_of(&conn, "nobody-at-all"), CredentialState::Unprovisioned);
        assert!(!owner_credentials_ready(&conn));
    }

    #[test]
    fn schema_rejects_active_without_a_password_moment() {
        let conn = legacy_db();
        assert!(
            conn.execute(
                "INSERT INTO server_credentials (user_id, credential_state, created_at, updated_at)
                 VALUES ('user-owner','active','n','n')",
                [],
            )
            .is_err(),
            "CHECK must forbid an 'active' credential with no password_changed_at"
        );
        assert!(
            conn.execute(
                "INSERT INTO server_credentials (user_id, credential_state, created_at, updated_at)
                 VALUES ('user-owner','wide-open','n','n')",
                [],
            )
            .is_err(),
            "CHECK must forbid an unknown state"
        );
    }

    // ── the system principal keeps its own guards ────────────────────────────
    #[test]
    fn system_principal_is_disabled_not_active() {
        let mut conn = legacy_db();
        db::seed_system_principal(&conn).unwrap();
        classify_existing(&mut conn).unwrap();
        assert_eq!(state_of(&conn, db::SYSTEM_PRINCIPAL_ID), CredentialState::Disabled);
        assert!(!state_of(&conn, db::SYSTEM_PRINCIPAL_ID).may_authenticate());
    }
}
