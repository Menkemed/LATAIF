#![cfg(test)]
//! M6-B2C5 — the cross-host end-to-end proof.
//!
//! ## Why this exists next to `transfer.rs`'s own tests
//!
//! The T1–T24 suite in `transfer.rs` proves the state machine. It does so with in-memory
//! databases and two `Host` structs that live for the length of one test function — which
//! means it can prove *what the code decides* but not *what survives*. Two things stayed
//! unproven there, and both are the kind that only fail in a real shop:
//!
//! - **Restarts.** An in-memory DB cannot be reopened. Every "idempotent after a crash"
//!   assertion in T16 re-used a connection that never closed, so what it really proved was
//!   "calling the function twice is safe", not "the transfer survives the process dying".
//! - **Separation.** Two structs over two in-memory DBs are separate by convention. Nothing
//!   stopped a future edit from handing both hosts the same connection and still passing.
//!
//! So this harness is deliberately heavier: **files on disk**, one directory per host, a
//! real `sync_install_id.key` per host produced by the real `install_id` module, and a
//! `restart()` that drops the connection and opens the database again from the file.
//!
//! ## What "restart" means here
//!
//! `Host::restart()` drops the `Connection` and re-opens the same file. That is as close to
//! a process restart as an in-process test can get, and it is the part that matters: every
//! piece of state the transfer depends on must come back from disk — the DB rows, the sealed
//! secrets, the pending key, the install id. Anything a test still holds in a Rust variable
//! across the restart is state the real application would have lost.

use rusqlite::{params, Connection};

use crate::sync::primary::{self, Mode, State};
use crate::sync::transfer::{
    self, ActivateOutcome, CustodyState, ImportOutcome, TransferBundle, TransferRecord,
    TransferState, CONFIRMATION_LEVEL, TRANSFER_CONFIRMATION,
};
use crate::sync::trust_root::{self, TrustRootRecord};
use crate::sync::{authority, credentials, install_id};

const PW: &str = "correct horse battery staple";
const OWNER_PW: &str = "owner-password-1234";
const TENANT: &str = "tenant-1";
const BRANCH: &str = "branch-main";

/// A temp dir that removes itself on drop, panic included.
///
/// Not a nicety: these directories hold real Ed25519 tenant root keys and real transfer
/// packages. Cleanup written at the end of a test body does not run when an assertion
/// fails, so a red test would leave key material in the system temp dir — exactly what §15
/// forbids. `Drop` runs during unwinding; a trailing statement does not.
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

fn host_dir(tag: &str) -> TempDir {
    let d = std::env::temp_dir().join(format!(
        "com.lataif.m6b2c5test-{tag}-{}",
        uuid::Uuid::new_v4().as_simple()
    ));
    std::fs::create_dir_all(&d).unwrap();
    TempDir(d)
}

/// One host: its own AppData directory, its own database FILE, its own install-id file.
///
/// Field order is the cleanup mechanism, not a style choice. Fields drop in declaration
/// order, so `conn` closes before `dir` is removed. A `Drop` impl on `Host` would run
/// BEFORE its fields drop — with the database still open — and Windows refuses to delete an
/// open file, so the directory would silently survive the test.
struct Host {
    conn: Connection,
    dir: TempDir,
    install: String,
}

/// Open (or re-open) the database file. This is the whole point of the harness: everything
/// the transfer needs must come back from disk.
fn open_db(dir: &std::path::Path) -> Connection {
    let conn = Connection::open(dir.join("lataif_sync_server.db")).unwrap();
    conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
    conn
}

fn create_schema(conn: &Connection) {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL,
            slug TEXT NOT NULL UNIQUE, plan TEXT, active INTEGER, max_branches INTEGER,
            max_users INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS branches (id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL REFERENCES tenants(id), name TEXT NOT NULL, country TEXT,
            currency TEXT, address TEXT, active INTEGER, created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL REFERENCES tenants(id), email TEXT NOT NULL,
            password_hash TEXT NOT NULL, name TEXT NOT NULL, active INTEGER,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(tenant_id, email));
         CREATE TABLE IF NOT EXISTS user_branches (user_id TEXT NOT NULL REFERENCES users(id),
            branch_id TEXT NOT NULL REFERENCES branches(id), role TEXT NOT NULL,
            is_default INTEGER, created_at TEXT NOT NULL, PRIMARY KEY (user_id, branch_id));
         CREATE TABLE IF NOT EXISTS sync_changelog (id INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id TEXT NOT NULL, branch_id TEXT NOT NULL, table_name TEXT NOT NULL,
            record_id TEXT NOT NULL, action TEXT NOT NULL, data TEXT NOT NULL, user_id TEXT,
            created_at TEXT NOT NULL);
         INSERT OR IGNORE INTO tenants (id, name, slug, created_at, updated_at)
            VALUES ('tenant-1','T','t','n','n');
         INSERT OR IGNORE INTO branches (id, tenant_id, name, created_at, updated_at)
            VALUES ('branch-main','tenant-1','B','n','n');",
    )
    .unwrap();
    lataif_server::migrations::run_migrations(conn, crate::sync::migrations::EMBEDDED_MIGRATIONS)
        .unwrap();
}

impl Host {
    /// A5/B-side: a fresh machine. Nothing but an empty DB and its own install id.
    ///
    /// The install id comes from the REAL `install_id` module reading a REAL file in this
    /// host's own directory — not from a constant. That is what makes E2 ("different
    /// install ids") a fact about the system rather than about the test's imagination.
    fn fresh(tag: &str) -> Host {
        let dir = host_dir(tag);
        let conn = open_db(&dir);
        create_schema(&conn);
        let install = install_id::load_or_create_in_dir(&dir).unwrap();
        Host { conn, dir, install }
    }

    /// **The persistence boundary.** Drop the connection, open the file again.
    ///
    /// Everything below this line must come back from disk. The install id is re-read from
    /// its file too — if it did not survive, the host would be a different machine and
    /// every custody check would fail, which is itself worth proving.
    fn restart(self) -> Host {
        let Host { conn, dir, install } = self;
        drop(conn); // ← the real boundary: the file handle closes here
        let conn = open_db(&dir);
        let reloaded = install_id::load_or_create_in_dir(&dir).unwrap();
        assert_eq!(reloaded, install, "the install id must survive a restart");
        Host { conn, dir, install: reloaded }
    }

    /// A1 — provision the owner locally, the M6-B2A4 way.
    fn provision_owner(&self) -> primary::OwnerAuth {
        let hash = bcrypt::hash("placeholder", 4).unwrap();
        self.conn
            .execute(
                "INSERT INTO users (id, tenant_id, email, password_hash, name, active,
                    created_at, updated_at)
                 VALUES ('user-owner',?1,'owner@x.com',?2,'O',1,'n','n')",
                params![TENANT, hash],
            )
            .unwrap();
        self.conn
            .execute_batch(
                "INSERT INTO user_branches VALUES ('user-owner','branch-main','owner',1,'n');",
            )
            .unwrap();
        // The real provisioning path — not a hand-written credential row. This is what
        // M6-B2A4 made mandatory, and going around it here would test a server that cannot
        // exist.
        credentials::provision_owner(
            &self.conn,
            OWNER_PW,
            OWNER_PW,
            credentials::PROVISION_CONFIRMATION,
        )
        .unwrap();
        self.owner()
    }

    fn owner(&self) -> primary::OwnerAuth {
        primary::authorize_owner(&self.conn, TENANT, BRANCH, "owner@x.com", OWNER_PW).unwrap()
    }

    /// A2/B7 — configure THIS host as primary. Deliberately a separate, explicit step: the
    /// transfer never does this (E12).
    fn configure_primary(&self) {
        let owner = self.owner();
        primary::configure_as_owner(&self.conn, TENANT, BRANCH, Mode::Primary, &self.install, &owner)
            .unwrap();
    }

    /// The state the application would compute at startup — from the DB and the id file,
    /// never from a caller.
    fn state(&self) -> State {
        let cfg = primary::load_config(&self.conn, TENANT, BRANCH).unwrap();
        primary::resolve_state(cfg.as_ref(), &self.install)
    }

    fn root(&self) -> Option<TrustRootRecord> {
        trust_root::load_active_root(&self.conn, TENANT).unwrap()
    }

    fn custody(&self) -> Option<CustodyState> {
        transfer::custody_state(&self.conn, TENANT, &self.install).unwrap()
    }

    fn transfer_state(&self, id: &str) -> TransferState {
        transfer::load_transfer(&self.conn, id).unwrap().state
    }

    /// "Can this host sign an authority action?" — asked the way production asks it.
    fn may_sign(&self) -> Result<(), &'static str> {
        let root = self.root().ok_or(authority::ERR_NO_TRUST_ROOT)?;
        authority::require_signing_authority(&self.conn, TENANT, BRANCH, &self.install, self.state(), &root)
            .map(|_| ())
    }

    /// Actually sign something — the strongest form of "can sign". A gate that says yes
    /// while the key is gone would pass `may_sign` and fail here.
    fn really_signs(&self) -> bool {
        let Some(root) = self.root() else { return false };
        if self.may_sign().is_err() {
            return false;
        }
        let Ok(key) = trust_root::load_key(&self.dir, &root) else { return false };
        let Ok(current) = authority::require_signing_authority(
            &self.conn, TENANT, BRANCH, &self.install, self.state(), &root,
        ) else {
            return false;
        };
        let Ok(cert) = authority::sign_transfer_certificate(
            TENANT,
            BRANCH,
            &root,
            &key,
            current.authority_epoch + 1,
            "99999999-9999-4999-8999-999999999999",
            Some(current.authority_id),
        ) else {
            return false;
        };
        authority::verify_certificate(
            &cert,
            &authority::VerifyContext {
                tenant_id: TENANT,
                branch_id: BRANCH,
                root: &root,
                expect_instance: Some("99999999-9999-4999-8999-999999999999"),
            },
        )
        .is_ok()
    }

    fn active_root_file(&self) -> bool {
        trust_root::key_file_exists(&self.dir)
    }

    fn pending_file(&self, transfer_id: &str) -> bool {
        trust_root::pending_key_exists(&self.dir, transfer_id)
    }
}

/// A3/A4/A5 — a fully set-up source: owner, primary, root, founding custody, authority.
fn source_host() -> (Host, primary::OwnerAuth) {
    let h = Host::fresh("A");
    let owner = h.provision_owner();
    h.configure_primary();
    assert_eq!(h.state(), State::Primary, "A2");
    trust_root::initialize_root(&h.conn, &h.dir, TENANT, &h.install, h.state(), &owner).unwrap();
    // A4 — founding custody exists because initialize_root created it.
    assert_eq!(h.custody(), Some(CustodyState::SourceActive), "A4");
    let root = h.root().unwrap();
    let key = trust_root::load_key(&h.dir, &root).unwrap();
    authority::initialize_authority(&authority::IssueContext {
        conn: &h.conn,
        tenant_id: TENANT,
        branch_id: BRANCH,
        install_id: &h.install,
        primary_state: h.state(),
        root: &root,
        key: &key,
        owner: &owner,
    })
    .unwrap();
    drop(key);
    (h, owner)
}

/// A6 — issue a transfer from `src` to `target_install`.
fn issue(src: &Host, owner: &primary::OwnerAuth, target_install: &str) -> (TransferBundle, TransferRecord) {
    let root = src.root().unwrap();
    let key = trust_root::load_key(&src.dir, &root).unwrap();
    let req = transfer::IssueRequest {
        conn: &src.conn,
        tenant_id: TENANT,
        branch_id: BRANCH,
        install_id: &src.install,
        primary_state: src.state(),
        root: &root,
        key: &key,
        owner,
    };
    transfer::issue(&req, target_install, PW, PW, TRANSFER_CONFIRMATION).unwrap()
}

// ── E1/E2 — the two hosts really are two machines ────────────────────────────

#[test]
fn e1_e2_two_hosts_are_physically_separate() {
    let (a, _oa) = source_host();
    let b = Host::fresh("B");

    // E1 — different AppData paths, and neither is inside the other.
    assert_ne!(a.dir.to_path_buf(), b.dir.to_path_buf());
    assert!(!a.dir.starts_with(&*b.dir) && !b.dir.starts_with(&*a.dir));

    // E2 — different install ids, each from its own real key file.
    assert_ne!(a.install, b.install, "two machines, two identities");
    let id_a = std::fs::read_to_string(a.dir.join("sync_install_id.key")).unwrap();
    let id_b = std::fs::read_to_string(b.dir.join("sync_install_id.key")).unwrap();
    assert_ne!(id_a, id_b);
    assert!(id_a.contains(&a.install) && id_b.contains(&b.install));

    // Different database FILES, both real.
    let db_a = a.dir.join("lataif_sync_server.db");
    let db_b = b.dir.join("lataif_sync_server.db");
    assert!(db_a.exists() && db_b.exists());
    assert_ne!(db_a, db_b);

    // E11 — no shared state. A write on A is invisible on B, which is the property that
    // makes every "the target does not know yet" assertion in this file mean something.
    a.conn
        .execute(
            "INSERT INTO sync_changelog (tenant_id, branch_id, table_name, record_id, action,
                data, created_at) VALUES ('tenant-1','branch-main','probe','p1','insert','{}','n')",
            [],
        )
        .unwrap();
    let on_b: i64 = b
        .conn
        .query_row("SELECT COUNT(*) FROM sync_changelog WHERE table_name='probe'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(on_b, 0, "E11: the hosts must not share a database");

    // A has a root; B has none. Separate trust state, not a shared table.
    assert!(a.root().is_some());
    assert!(b.root().is_none());
    assert_eq!(b.custody(), None);
}

// ── The full cross-host transfer, A1 … B8, with real restarts ────────────────

#[test]
fn cross_host_full_transfer_with_restarts() {
    // ── A1…A5 (inside source_host) ───────────────────────────────────────────
    let (mut a, owner_a) = source_host();
    let mut b = Host::fresh("B");
    assert_ne!(a.install, b.install);

    // Source can sign BEFORE the commit — and not just "the gate says yes": it really
    // produces a certificate that verifies.
    assert!(a.may_sign().is_ok(), "source signs before the transfer");
    assert!(a.really_signs(), "…and the signature is real");

    // ── A6 — issue ───────────────────────────────────────────────────────────
    let (bundle, rec) = issue(&a, &owner_a, &b.install);
    let raw = bundle.to_json().unwrap();
    assert_eq!(a.transfer_state(&rec.transfer_id), TransferState::IssuedPending);
    assert_eq!(a.custody(), Some(CustodyState::SourceActive), "A6 changes nothing yet");

    // §6 — restart after T1. The package is a file the owner carries; everything else must
    // come back from disk.
    a = a.restart();
    assert_eq!(a.transfer_state(&rec.transfer_id), TransferState::IssuedPending, "survives restart");
    assert!(a.really_signs(), "the source still runs the shop after issuing");

    // ── B1/B2 — import on host B ─────────────────────────────────────────────
    // E7 — before the import B has nothing at all.
    assert!(b.may_sign().is_err());
    assert_eq!(
        transfer::import(&b.conn, &b.dir, &raw, &b.install, PW).unwrap(),
        ImportOutcome::Imported
    );
    assert_eq!(b.transfer_state(&rec.transfer_id), TransferState::TargetImported, "B1");
    assert_eq!(b.custody(), Some(CustodyState::TargetPending));

    // §8 before activation — pending key only, no active root file.
    assert!(b.pending_file(&rec.transfer_id), "B2: the pending key is on disk");
    assert!(!b.active_root_file(), "the active name must not exist yet");
    assert!(b.may_sign().is_err(), "E7: the target cannot sign before activation");
    assert!(!b.really_signs());

    // §6 — restart after the import. The pending key and the sealed receipt secret must
    // both survive, or B3 below is impossible.
    b = b.restart();
    assert_eq!(b.transfer_state(&rec.transfer_id), TransferState::TargetImported);
    assert_eq!(b.custody(), Some(CustodyState::TargetPending));

    // ── B3 — receipt ─────────────────────────────────────────────────────────
    let receipt = transfer::create_receipt(&b.conn, &b.dir, &rec.transfer_id, &b.install).unwrap();
    assert_eq!(receipt.confirmation_level, CONFIRMATION_LEVEL);
    let raw_receipt = receipt.to_json().unwrap();

    // §6 — restart after the receipt; it must be re-creatable, byte-identical.
    b = b.restart();
    let again = transfer::create_receipt(&b.conn, &b.dir, &rec.transfer_id, &b.install).unwrap();
    assert_eq!(again.mac, receipt.mac, "the receipt survives a restart");

    // ── A7 — confirm on host A ───────────────────────────────────────────────
    transfer::confirm_receipt(&a.conn, &a.dir, &raw_receipt, &a.install, &a.root().unwrap()).unwrap();
    assert_eq!(a.transfer_state(&rec.transfer_id), TransferState::TargetConfirmed);
    assert!(a.really_signs(), "still the authority: confirming is not committing");

    // §6 — restart after the confirmation.
    a = a.restart();
    assert_eq!(a.transfer_state(&rec.transfer_id), TransferState::TargetConfirmed);

    // ── A8 — the commit. THE POINT OF NO RETURN ──────────────────────────────
    transfer::commit(&a.conn, &rec.transfer_id, &a.install, &a.owner()).unwrap();
    assert_eq!(a.transfer_state(&rec.transfer_id), TransferState::Committed);
    assert_eq!(a.custody(), Some(CustodyState::SourceRetired));

    // ── A9 — restart the source, then E6: it must NOT sign ───────────────────
    a = a.restart();
    assert_eq!(a.custody(), Some(CustodyState::SourceRetired), "retirement survives a restart");
    assert_eq!(a.may_sign().unwrap_err(), transfer::ERR_CUSTODY_RETIRED, "E6");
    assert!(!a.really_signs(), "E6: and it really cannot produce a certificate");
    // The root key file is still there. That is deliberate — and it is exactly why the
    // gate asks the DB and not the filesystem.
    assert!(a.active_root_file(), "the key file survives; it is not the permission");
    assert_eq!(a.state(), State::Primary, "…and so does the primary role");

    // ── A10 — the commit token, exported AFTER a restart ─────────────────────
    let token =
        transfer::export_commit_token(&a.conn, &a.dir, &rec.transfer_id, &a.install).unwrap();
    let raw_token = token.to_json().unwrap();
    // E5 — and again after another restart, identical.
    a = a.restart();
    let token2 =
        transfer::export_commit_token(&a.conn, &a.dir, &rec.transfer_id, &a.install).unwrap();
    assert_eq!(token2.secret, token.secret, "E5: the token survives restarts");

    // ── B4 — restart the target before activating ────────────────────────────
    b = b.restart();
    assert_eq!(b.custody(), Some(CustodyState::TargetPending), "E4");
    assert!(b.may_sign().is_err(), "E7: still blocked between commit and activation");

    // Nobody can sign right now. That IS the correct state: the source has provably
    // stopped, the target has provably not started.
    assert!(!a.really_signs() && !b.really_signs(), "the gap is real and intended");

    // ── B5/B6 — import the token and activate ────────────────────────────────
    assert_eq!(
        transfer::activate(&b.conn, &b.dir, &raw_token, &b.install).unwrap(),
        ActivateOutcome::Activated
    );
    assert_eq!(b.custody(), Some(CustodyState::TargetActive), "B6");
    assert!(b.active_root_file(), "§8: the active root file now exists");
    // E9 — the pending artefact is cleaned up.
    assert!(!b.pending_file(&rec.transfer_id), "E9: pending key removed after success");

    // §6 — restart after activation.
    b = b.restart();
    assert_eq!(b.custody(), Some(CustodyState::TargetActive));

    // ── B7 — E12: the transfer did NOT make B a primary ──────────────────────
    assert_ne!(b.state(), State::Primary, "E12: no automatic primary role");
    assert_eq!(
        b.may_sign().unwrap_err(),
        authority::ERR_NOT_PRIMARY,
        "custody alone is not the role"
    );

    // …and configuring the role takes an OWNER — which host B does not have yet.
    //
    // This is worth stating plainly, because the first draft of this test tripped over it:
    // `users` is not a synced table, so a machine that has only ever received a transfer
    // package has no owner row for this tenant and `authorize_owner` refuses. The transfer
    // moves the tenant's *signing ability*; it does not move, and must not move, the
    // question of who may operate this particular server. That answer is provisioned
    // locally, per machine, per M6-B2A4.
    assert!(
        primary::authorize_owner(&b.conn, TENANT, BRANCH, "owner@x.com", OWNER_PW).is_err(),
        "a target that only imported a package has no owner of its own"
    );
    let _owner_b = b.provision_owner();
    b.configure_primary();
    assert_eq!(b.state(), State::Primary);

    // ── B8 — E8: the target signs, under the SAME tenant root ────────────────
    assert!(b.may_sign().is_ok(), "E8");
    assert!(b.really_signs(), "E8: a real, verifying certificate");
    assert_eq!(
        b.root().unwrap().public_key,
        a.root().unwrap().public_key,
        "the ability moved — same root, different machine"
    );
    assert_eq!(b.root().unwrap().root_key_id, a.root().unwrap().root_key_id);

    // Final state of the world: exactly one host can sign, and it is B.
    assert!(!a.really_signs() && b.really_signs());
}

// ── §7 — what a retired source may and may not do, after a restart ───────────

#[test]
fn retired_source_keeps_only_the_narrow_token_path() {
    let (mut a, owner_a) = source_host();
    let mut b = Host::fresh("B");
    let (bundle, rec) = issue(&a, &owner_a, &b.install);

    transfer::import(&b.conn, &b.dir, &bundle.to_json().unwrap(), &b.install, PW).unwrap();
    let receipt = transfer::create_receipt(&b.conn, &b.dir, &rec.transfer_id, &b.install).unwrap();
    transfer::confirm_receipt(
        &a.conn,
        &a.dir,
        &receipt.to_json().unwrap(),
        &a.install,
        &a.root().unwrap(),
    )
    .unwrap();
    transfer::commit(&a.conn, &rec.transfer_id, &a.install, &a.owner()).unwrap();

    // The full restart is the point: none of what follows may depend on live objects.
    a = a.restart();
    b = b.restart();

    // The other half of "the source has retired": B has NOT taken over. Between the commit
    // and the activation the tenant has no signer at all, and both halves of that must be
    // asserted — otherwise "the source cannot sign" would also pass in a world where the
    // target silently could.
    assert_eq!(b.custody(), Some(CustodyState::TargetPending));
    assert!(!b.really_signs(), "the target has not started either");

    // 1. normal signing → AUTHORITY_CUSTODY_RETIRED
    assert_eq!(a.may_sign().unwrap_err(), transfer::ERR_CUSTODY_RETIRED);

    // 2. the commit token export → still possible
    let token = transfer::export_commit_token(&a.conn, &a.dir, &rec.transfer_id, &a.install);
    assert!(token.is_ok(), "the narrow path must survive the retirement");

    // 3. signing an authority certificate → impossible
    assert!(!a.really_signs());

    // 4. issuing a new transfer → impossible
    let root = a.root().unwrap();
    let key = trust_root::load_key(&a.dir, &root).unwrap();
    let req = transfer::IssueRequest {
        conn: &a.conn,
        tenant_id: TENANT,
        branch_id: BRANCH,
        install_id: &a.install,
        primary_state: a.state(),
        root: &root,
        key: &key,
        owner: &owner_a,
    };
    assert_eq!(
        transfer::issue(&req, "44444444-4444-4444-8444-444444444444", PW, PW, TRANSFER_CONFIRMATION)
            .unwrap_err(),
        transfer::ERR_CUSTODY_RETIRED
    );
    drop(key);

    // 5. abort → ALREADY_COMMITTED
    assert_eq!(
        transfer::abort(&a.conn, &a.dir, &rec.transfer_id, &a.install, &a.root().unwrap())
            .unwrap_err(),
        transfer::ERR_TRANSFER_ALREADY_COMMITTED
    );

    // The narrow path returns a TOKEN and nothing else. Its return type is the guarantee:
    // it cannot hand back a key or a certificate because it cannot construct one — and the
    // secret it does reveal opens exactly one commitment, on one transfer.
    let t = token.unwrap();
    assert_eq!(t.purpose, transfer::PURPOSE_COMMIT);
    assert_eq!(t.transfer_id, rec.transfer_id);
    // It is not a root key: the seed does not appear in it.
    let seed_b64 = {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(trust_root::load_key(&a.dir, &a.root().unwrap()).unwrap().seed())
    };
    let raw = t.to_json().unwrap();
    assert!(!raw.contains(&seed_b64), "the token must never carry the root seed");
    // And it still cannot sign, having exported it.
    assert!(!a.really_signs());
}

// ── §8 — the crash between hard_link and the DB commit, across a restart ─────

#[test]
fn crash_between_key_publication_and_db_commit_survives_a_restart() {
    let (a, owner_a) = source_host();
    let mut b = Host::fresh("B");
    let (bundle, rec) = issue(&a, &owner_a, &b.install);

    transfer::import(&b.conn, &b.dir, &bundle.to_json().unwrap(), &b.install, PW).unwrap();
    let receipt = transfer::create_receipt(&b.conn, &b.dir, &rec.transfer_id, &b.install).unwrap();
    transfer::confirm_receipt(
        &a.conn,
        &a.dir,
        &receipt.to_json().unwrap(),
        &a.install,
        &a.root().unwrap(),
    )
    .unwrap();
    transfer::commit(&a.conn, &rec.transfer_id, &a.install, &a.owner()).unwrap();
    let token = transfer::export_commit_token(&a.conn, &a.dir, &rec.transfer_id, &a.install).unwrap();

    // Reproduce the crash window: the key file is published, the DB is not yet updated.
    // This is the state a power cut between the two leaves on disk.
    let seed = trust_root::load_pending_seed(&b.dir, &rec.transfer_id).unwrap();
    assert_eq!(
        trust_root::publish_pending_as_active(&b.dir, &rec.transfer_id, &seed).unwrap(),
        trust_root::PublishOutcome::Published
    );

    // …and now the process dies. Everything below comes back from disk.
    b = b.restart();

    // §8 — the active file exists, the DB still says pending, and signing stays blocked.
    // The payoff for the file-first order: a half-finished activation is inert, not armed.
    assert!(b.active_root_file(), "the active file may exist");
    assert_eq!(b.custody(), Some(CustodyState::TargetPending), "the DB stays pending");
    assert!(!b.really_signs(), "an active key file is not permission");

    // Two independent refusals stand between this half-state and a signature, and the test
    // says which is which rather than settling for "it errored".
    //
    // The FIRST one to fire is not the custody check: `tenant_trust_roots` has no row yet,
    // because `activate` inserts it in the same transaction it sets custody in. So the host
    // holds a real, loadable root key file whose public record it does not have — and the
    // signing path stops there.
    assert_eq!(
        b.may_sign().unwrap_err(),
        authority::ERR_NO_TRUST_ROOT,
        "no public root record yet — the DB transaction that would create it never ran"
    );
    // The custody gate is the second line, and it is the one that would refuse even if the
    // record existed. Asserted directly, because the first check masks it.
    assert_eq!(
        transfer::require_custody(&b.conn, TENANT, &b.install).unwrap_err(),
        transfer::ERR_CUSTODY_PENDING,
        "and custody says pending independently of the missing record"
    );

    // The retry recognises the identical file and finishes the DB half.
    assert_eq!(
        transfer::activate(&b.conn, &b.dir, &token.to_json().unwrap(), &b.install).unwrap(),
        ActivateOutcome::Activated
    );
    assert_eq!(b.custody(), Some(CustodyState::TargetActive));
    // …and the pending artefact is cleaned up afterwards.
    assert!(!b.pending_file(&rec.transfer_id), "§8: pending artefact cleaned up after the retry");

    // Survives one more restart, and the second activation is idempotent.
    b = b.restart();
    assert_eq!(b.custody(), Some(CustodyState::TargetActive));
    assert_eq!(
        transfer::activate(&b.conn, &b.dir, &token.to_json().unwrap(), &b.install).unwrap(),
        ActivateOutcome::AlreadyActive
    );
    // The role is a local, owner-made decision — see the note in the full-transfer test.
    let _owner_b = b.provision_owner();
    b.configure_primary();
    assert!(b.really_signs(), "and it works");
}

// ── §8 — a contradicting active root file is fail-closed, across hosts ───────

#[test]
fn a_foreign_active_root_file_on_the_target_is_never_overwritten() {
    let (a, owner_a) = source_host();
    let mut b = Host::fresh("B");
    let (bundle, rec) = issue(&a, &owner_a, &b.install);
    transfer::import(&b.conn, &b.dir, &bundle.to_json().unwrap(), &b.install, PW).unwrap();
    let receipt = transfer::create_receipt(&b.conn, &b.dir, &rec.transfer_id, &b.install).unwrap();
    transfer::confirm_receipt(&a.conn, &a.dir, &receipt.to_json().unwrap(), &a.install, &a.root().unwrap())
        .unwrap();
    transfer::commit(&a.conn, &rec.transfer_id, &a.install, &a.owner()).unwrap();
    let token = transfer::export_commit_token(&a.conn, &a.dir, &rec.transfer_id, &a.install).unwrap();

    // A DIFFERENT tenant's root key lands under the active name on B — a restored backup,
    // a stray copy, a botched migration.
    let (foreign, _of) = source_host();
    std::fs::copy(
        foreign.dir.join("sync_tenant_root.key"),
        b.dir.join("sync_tenant_root.key"),
    )
    .unwrap();
    let before = std::fs::read_to_string(b.dir.join("sync_tenant_root.key")).unwrap();

    b = b.restart();
    assert_eq!(
        transfer::activate(&b.conn, &b.dir, &token.to_json().unwrap(), &b.install).unwrap_err(),
        trust_root::ERR_ROOT_KEY_ALREADY_EXISTS,
        "an existing, different root key must never be clobbered"
    );
    // We refuse; we do not "fix". Overwriting would destroy an authority that cannot be
    // reconstructed from anything else on the machine.
    assert_eq!(
        std::fs::read_to_string(b.dir.join("sync_tenant_root.key")).unwrap(),
        before,
        "the foreign key is untouched"
    );
    assert_eq!(b.custody(), Some(CustodyState::TargetPending));
    assert!(!b.really_signs());
}

// ── §9 — abort, scenario 1: after the issue, before the import ───────────────

#[test]
fn abort_after_issue_before_import_across_hosts() {
    let (mut a, owner_a) = source_host();
    let b = Host::fresh("B");
    let (_bundle, rec) = issue(&a, &owner_a, &b.install);

    let token = transfer::abort(&a.conn, &a.dir, &rec.transfer_id, &a.install, &a.root().unwrap())
        .unwrap();
    assert_eq!(token.purpose, transfer::PURPOSE_ABORT);

    a = a.restart();
    // §10 — the source keeps everything and keeps working.
    assert_eq!(a.transfer_state(&rec.transfer_id), TransferState::Aborted);
    assert_eq!(a.custody(), Some(CustodyState::SourceActive));
    assert!(a.really_signs(), "an aborted transfer costs the source nothing");

    // The target never heard of it: no custody, no key, nothing to clean up.
    assert_eq!(b.custody(), None);
    assert!(!b.active_root_file());
    assert!(!b.pending_file(&rec.transfer_id));

    // …and after an abort the source can issue a NEW transfer — the in-flight slot is free.
    let (_b2, rec2) = issue(&a, &owner_a, &b.install);
    assert_ne!(rec2.transfer_id, rec.transfer_id);
    assert_eq!(a.transfer_state(&rec2.transfer_id), TransferState::IssuedPending);
}

// ── §9 — abort, scenario 2: after import and receipt, before the commit ──────

#[test]
fn abort_after_import_and_receipt_before_commit_across_hosts() {
    let (mut a, owner_a) = source_host();
    let mut b = Host::fresh("B");
    let (bundle, rec) = issue(&a, &owner_a, &b.install);

    transfer::import(&b.conn, &b.dir, &bundle.to_json().unwrap(), &b.install, PW).unwrap();
    let receipt = transfer::create_receipt(&b.conn, &b.dir, &rec.transfer_id, &b.install).unwrap();
    transfer::confirm_receipt(&a.conn, &a.dir, &receipt.to_json().unwrap(), &a.install, &a.root().unwrap())
        .unwrap();
    assert!(b.pending_file(&rec.transfer_id), "the target holds a pending key");

    // The owner changes their mind — still allowed, because the source has not committed.
    let token = transfer::abort(&a.conn, &a.dir, &rec.transfer_id, &a.install, &a.root().unwrap())
        .unwrap();

    a = a.restart();
    assert_eq!(a.custody(), Some(CustodyState::SourceActive), "§10: the source keeps custody");
    assert!(a.really_signs());

    // The target stands down.
    transfer::import_abort(&b.conn, &b.dir, &token.to_json().unwrap(), &b.install).unwrap();
    b = b.restart();

    assert_eq!(b.custody(), Some(CustodyState::Aborted), "§9");
    assert_eq!(b.transfer_state(&rec.transfer_id), TransferState::Aborted);
    // E10 — the pending key is gone…
    assert!(!b.pending_file(&rec.transfer_id), "E10: abort cleans up the pending key");
    // …and no active root file was ever created on the target.
    assert!(!b.active_root_file(), "§9: no active root file on an aborted target");
    assert!(!b.really_signs(), "§9: signing impossible");
    assert!(b.may_sign().is_err());

    // Idempotent across a restart.
    assert!(transfer::import_abort(&b.conn, &b.dir, &token.to_json().unwrap(), &b.install).is_ok());

    // After the commit, no abort is possible any more — proven on a fresh pair, because
    // this one is already aborted.
    let (a2, owner2) = source_host();
    let b2 = Host::fresh("B");
    let (bundle2, rec2) = issue(&a2, &owner2, &b2.install);
    transfer::import(&b2.conn, &b2.dir, &bundle2.to_json().unwrap(), &b2.install, PW).unwrap();
    let r2 = transfer::create_receipt(&b2.conn, &b2.dir, &rec2.transfer_id, &b2.install).unwrap();
    transfer::confirm_receipt(&a2.conn, &a2.dir, &r2.to_json().unwrap(), &a2.install, &a2.root().unwrap())
        .unwrap();
    transfer::commit(&a2.conn, &rec2.transfer_id, &a2.install, &a2.owner()).unwrap();
    let a2 = a2.restart();
    assert_eq!(
        transfer::abort(&a2.conn, &a2.dir, &rec2.transfer_id, &a2.install, &a2.root().unwrap())
            .unwrap_err(),
        transfer::ERR_TRANSFER_ALREADY_COMMITTED,
        "§9: after the commit the source has already stopped — undoing it could arm two authorities"
    );
}

// ── §15 — the harness cleans up after itself, red or green ───────────────────

#[test]
fn the_harness_leaves_nothing_behind() {
    let probe;
    {
        let (a, owner_a) = source_host();
        let b = Host::fresh("B");
        probe = (a.dir.to_path_buf(), b.dir.to_path_buf());
        let (bundle, rec) = issue(&a, &owner_a, &b.install);
        transfer::import(&b.conn, &b.dir, &bundle.to_json().unwrap(), &b.install, PW).unwrap();
        // Real key material exists at this point — that is the thing that must not survive.
        assert!(a.dir.join("sync_tenant_root.key").exists());
        assert!(b.pending_file(&rec.transfer_id));
        assert!(a.dir.join("lataif_sync_server.db").exists());
    } // ← both hosts drop here: connections close, then the directories go

    assert!(!probe.0.exists(), "host A left a directory behind");
    assert!(!probe.1.exists(), "host B left a directory behind");

    // The isolated identifier, so a stray directory is always attributable to this slice.
    let d = host_dir("probe");
    assert!(d.to_string_lossy().contains("com.lataif.m6b2c5test"));
    let s = d.to_string_lossy().to_lowercase();
    assert!(!s.contains("roaming\\com.lataif.app") && !s.contains("roaming/com.lataif.app"));
}
