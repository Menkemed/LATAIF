//! M6-B1 — Additive, INACTIVE migrations for the EMBEDDED sync server DB.
//!
//! ## Scope (inactive foundation only)
//!
//! This module owns the embedded server's migration list. The runner itself is
//! NOT reimplemented here — it is the shared core from the server library
//! (`lataif_server::migrations::run_migrations`), which takes the migration list
//! as a parameter. One implementation of the versioning / checksum / drift rules,
//! two independent lists.
//!
//! The migration is purely additive and everything it creates stays **empty and
//! unread**:
//! - `canonical_records` and `operations` are created but no production path
//!   reads or writes them; there is no CAS, no authority, no bootstrap.
//! - `sync_changelog` gains three NULLable columns; existing rows keep every
//!   value they had and are never backfilled with invented revisions.
//! - `tenants` / `branches` / `users` / `user_branches` are untouched.
//!
//! ## Why `up_sql != reference_sql` here
//!
//! The shared runner builds its structural drift reference by executing
//! `reference_sql` in a throwaway **empty** in-memory database. An
//! `ALTER TABLE sync_changelog …` cannot run there (the table does not exist),
//! and matching SQLite's rewritten `sqlite_master` text for an ALTERed table
//! would be brittle. So `reference_sql` declares only the two NEW tables — they
//! are the structures worth drift-checking — while `up_sql` additionally carries
//! the three additive column adds. The adds are still applied exactly once,
//! because `schema_migrations` gates the whole migration by version.
//!
//! ## Deliberately NOT in this migration
//!
//! - `authority_epoch` on `operations`: the authority contract is not settled
//!   (M6-A4 established that single-authority is not enforceable without a
//!   shared lease). Adding the column now would imply a guarantee that does not
//!   exist. M6-B2 adds it together with the mechanism that gives it meaning.
//! - Snapshot/bootstrap tables: M6-B4.
//! - Any row insert: a migration never seeds business data (the system principal
//!   is seeded separately and idempotently in `db.rs`).

use lataif_server::migrations::Migration;

/// The embedded server's migrations, strictly ascending. Independent from the
/// standalone server's `ALL_MIGRATIONS` — different deployment, different scope.
pub const EMBEDDED_MIGRATIONS: &[Migration] = &[
    V0001_SYNC_PROTOCOL_FOUNDATION,
    V0002_PRIMARY_HOST_CONFIG,
    V0003_SERVER_CREDENTIALS,
    V0004_TENANT_TRUST_ROOTS,
    V0005_AUTHORITY_CERTIFICATES,
    V0006_AUTHORITY_TRANSFER_AND_ROOT_CUSTODY,
];

/// M6-B2C4 — the two-phase authority transfer and the custody of the private root.
///
/// ## The gap this closes
///
/// Until now `issue_transfer` superseded the source certificate and inserted the target's
/// as active in one step, on the SOURCE machine. Two things were wrong with that. The
/// target got an authority it could not use, because the certificate is a *statement about*
/// the root key, not the key itself — the signing ability never moved. And the handover had
/// no point of no return: there was no state in which the source had stopped and the target
/// had not yet started, which is exactly the state a crash lands in.
///
/// So: custody of the private root becomes an explicit, tracked thing, and the transfer
/// becomes two phases with a commit in between.
///
/// ## Why `confirmation_level` is a column and not a boolean
///
/// The target proves it imported the package by returning an HMAC over the receipt secret
/// that came *inside* the package. That proves decryption and protocol-conforming import.
/// It does NOT prove a device identity — there is no device keypair in this slice, so the
/// only thing the target holds is a secret we handed it. Calling that "attested" would be a
/// lie told by a column name, so the only value this column may hold is
/// `locally_confirmed_not_device_attested`, and the CHECK constraint keeps it that way.
///
/// `up_sql == reference_sql` (only CREATEs).
pub const V0006_AUTHORITY_TRANSFER_AND_ROOT_CUSTODY: Migration = Migration {
    version: 6,
    name: "authority_transfer_and_root_custody",
    up_sql: V0006_SQL,
    reference_sql: V0006_SQL,
};

const V0006_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS authority_transfers (
    transfer_id            TEXT NOT NULL PRIMARY KEY,
    tenant_id              TEXT NOT NULL,
    branch_id              TEXT NOT NULL,

    source_authority_id    TEXT NOT NULL,
    target_authority_id    TEXT NOT NULL,
    source_install_id      TEXT NOT NULL,
    target_install_id      TEXT NOT NULL,

    root_key_id            TEXT NOT NULL,
    root_generation        INTEGER NOT NULL,

    -- The target's certificate, signed at issue time but NOT active anywhere until the
    -- target activates it. Kept verbatim so it can be re-verified from scratch.
    target_certificate     TEXT NOT NULL,
    target_certificate_hash TEXT NOT NULL,

    -- Commitments only. The secrets themselves never travel in the package.
    commit_secret_hash     TEXT NOT NULL,
    abort_secret_hash      TEXT NOT NULL,

    -- Sealed under a key derived from the tenant root, so a crash can resume but a stolen
    -- DB file cannot commit. NULL on the target, which never holds these.
    sealed_commit_secret   TEXT,
    sealed_commit_nonce    TEXT,
    sealed_abort_secret    TEXT,
    sealed_abort_nonce     TEXT,

    -- The TARGET's counterpart, sealed under the pending root seed it just imported. §11
    -- requires the receipt to survive a crash and be re-exportable; keeping the receipt
    -- secret only in memory would mean a target that crashed between import and receipt
    -- could never confirm, and the transfer would be stuck with no way forward but abort.
    -- NULL on the source, which never holds this.
    sealed_receipt_secret  TEXT,
    sealed_receipt_nonce   TEXT,

    state                  TEXT NOT NULL,
    confirmation_level     TEXT,

    created_at             TEXT NOT NULL,
    imported_at            TEXT,
    confirmed_at           TEXT,
    committed_at           TEXT,
    activated_at           TEXT,
    aborted_at             TEXT,

    created_by             TEXT,
    confirmed_by           TEXT,
    committed_by           TEXT,

    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
    FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT,

    CHECK (state IN ('issued_pending', 'target_imported', 'target_confirmed',
                     'committed', 'target_activated', 'aborted', 'invalid')),
    CHECK (root_generation >= 1),
    -- The one honest value. See the doc comment: a receipt made with a secret we shipped
    -- inside the package cannot attest a device, and a column must not claim it does.
    CHECK (confirmation_level IS NULL
           OR confirmation_level = 'locally_confirmed_not_device_attested'),
    -- Source and target must be different machines. A transfer to oneself would retire the
    -- only custody and hand it back to the same install — a no-op that ends in no signer.
    CHECK (source_install_id <> target_install_id),
    -- Every terminal state records when it happened.
    CHECK (state <> 'committed'        OR committed_at IS NOT NULL),
    CHECK (state <> 'target_activated' OR activated_at IS NOT NULL),
    CHECK (state <> 'aborted'          OR aborted_at   IS NOT NULL),
    -- A confirmed transfer must carry both the receipt's timestamp and its honest level.
    CHECK (state NOT IN ('target_confirmed', 'committed', 'target_activated')
           OR (confirmed_at IS NOT NULL AND confirmation_level IS NOT NULL))
);

-- At most ONE transfer in flight per tenant/branch. Two concurrent handovers would each
-- retire the source and each hand custody to a different target.
CREATE UNIQUE INDEX IF NOT EXISTS idx_transfer_one_in_flight
    ON authority_transfers (tenant_id, branch_id)
    WHERE state IN ('issued_pending', 'target_imported', 'target_confirmed', 'committed');

CREATE INDEX IF NOT EXISTS idx_transfer_target
    ON authority_transfers (target_install_id, state);

CREATE TABLE IF NOT EXISTS root_custody (
    tenant_id     TEXT NOT NULL,
    root_key_id   TEXT NOT NULL,
    root_generation INTEGER NOT NULL,
    install_id    TEXT NOT NULL,
    -- NULL for the founding custody, which no transfer created.
    transfer_id   TEXT,
    state         TEXT NOT NULL,

    created_at    TEXT NOT NULL,
    activated_at  TEXT,
    retired_at    TEXT,
    aborted_at    TEXT,

    PRIMARY KEY (tenant_id, root_key_id, install_id),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
    FOREIGN KEY (transfer_id) REFERENCES authority_transfers(transfer_id) ON DELETE RESTRICT,

    CHECK (state IN ('source_active', 'target_pending', 'target_active',
                     'source_retired', 'aborted', 'invalid')),
    CHECK (root_generation >= 1),
    CHECK (state NOT IN ('source_active', 'target_active') OR activated_at IS NOT NULL),
    CHECK (state <> 'source_retired' OR retired_at IS NOT NULL),
    CHECK (state <> 'aborted'        OR aborted_at IS NOT NULL),
    -- A pending or aborted target custody exists only because a transfer created it.
    CHECK (state NOT IN ('target_pending', 'target_active') OR transfer_id IS NOT NULL)
);

-- "Höchstens eine lokal aktive Custody pro Tenant", enforced by the DB rather than by a
-- function that a later refactor can quietly drop. Both signing states count: the whole
-- point of source_retired / target_pending is that they are NOT this.
CREATE UNIQUE INDEX IF NOT EXISTS idx_custody_one_active
    ON root_custody (tenant_id)
    WHERE state IN ('source_active', 'target_active');
"#;

/// M6-B2A4 — the credential state of every embedded-server login.
///
/// ## Why a table and not columns on `users`
///
/// §3 allows either. A separate table wins twice: adding columns to `users` would need
/// `ALTER TABLE`, which cannot run in the drift reference's empty in-memory DB (the
/// `up_sql != reference_sql` dance of v0001), and — more importantly — the ABSENCE of a
/// row here is a meaningful, fail-closed answer. A login with no credential row is
/// `unprovisioned`, so a user that predates this migration, or one inserted by a path we
/// forgot, is refused rather than silently trusted.
///
/// ## What it fixes
///
/// `init_database` seeded `admin@lataif.com` / `admin` as owner of tenant-1/branch-main
/// into every empty server DB, and nothing in the application could ever change it
/// (`/auth/login` only reads, `/auth/register` was removed in B2A1, `users` is not a
/// synced table). So the "owner authorization" of M6-B2A1/B2A2 — and `/auth/login`'s
/// owner JWT, which unlocks `/sync/push` for anyone on the Wi-Fi — rested on a constant
/// printed in the source. This table is where that stops being true.
///
/// `up_sql == reference_sql` (only CREATEs).
pub const V0003_SERVER_CREDENTIALS: Migration = Migration {
    version: 3,
    name: "server_credentials",
    up_sql: V0003_SQL,
    reference_sql: V0003_SQL,
};

const V0003_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS server_credentials (
    user_id             TEXT NOT NULL PRIMARY KEY,
    credential_state    TEXT NOT NULL,
    password_changed_at TEXT,
    provisioned_at      TEXT,
    provisioned_by      TEXT,
    -- Audit only: WHY this row was classified as it was. Never an authorization input.
    classified_reason   TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,

    CHECK (credential_state IN ('unprovisioned', 'active', 'disabled', 'recovery_required')),
    -- An active credential must record when its password was last set. A row claiming
    -- 'active' with no such moment is a row nobody deliberately created.
    CHECK (credential_state <> 'active' OR password_changed_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_server_credentials_state
    ON server_credentials (credential_state);
"#;

/// M6-B2B — the tenant's trust root: the PUBLIC half only.
///
/// The private Ed25519 key lives in `sync_tenant_root.key` in the primary's app data
/// dir and **never** enters this database. That separation is the whole point: a copied
/// or restored server DB carries every public record here and still cannot sign a single
/// certificate. It is the same reasoning as `sync_install_id.key` (M6-B2A), one level up
/// — install id proves *which machine*, the root key proves *which tenant authority*.
///
/// `up_sql == reference_sql` (only CREATEs).
pub const V0004_TENANT_TRUST_ROOTS: Migration = Migration {
    version: 4,
    name: "tenant_trust_roots",
    up_sql: V0004_SQL,
    reference_sql: V0004_SQL,
};

const V0004_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS tenant_trust_roots (
    tenant_id    TEXT NOT NULL,
    root_key_id  TEXT NOT NULL,
    public_key   TEXT NOT NULL,
    fingerprint  TEXT NOT NULL,
    generation   INTEGER NOT NULL,
    state        TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    activated_at TEXT,
    rotated_at   TEXT,
    revoked_at   TEXT,
    created_by   TEXT,

    PRIMARY KEY (tenant_id, root_key_id),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,

    CHECK (state IN ('active', 'rotated', 'revoked', 'lost', 'compromised')),
    CHECK (generation >= 1),
    -- An active root MUST have been activated; a revoked one MUST record when.
    CHECK (state <> 'active'  OR activated_at IS NOT NULL),
    CHECK (state <> 'revoked' OR revoked_at IS NOT NULL)
);

-- At most ONE active root per tenant. Enforced by the DB, not by code: "höchstens eine
-- aktive Root pro Tenant" is an invariant, and an invariant that only lives in a
-- function is one refactor away from being gone.
CREATE UNIQUE INDEX IF NOT EXISTS idx_trust_root_one_active
    ON tenant_trust_roots (tenant_id) WHERE state = 'active';

-- A generation is claimed once per tenant, whatever became of it later.
CREATE UNIQUE INDEX IF NOT EXISTS idx_trust_root_generation
    ON tenant_trust_roots (tenant_id, generation);
"#;

/// M6-B2C — authority certificates and their revocations.
///
/// A certificate is a statement signed by the tenant root: "installation X is the
/// authority for tenant/branch at epoch N". It is stored complete and verbatim so it can
/// be re-verified from scratch at any time — we never trust the parsed columns, they are
/// only an index over the signed blob.
///
/// Deliberately **no expiry**: the shop must keep working offline. A certificate ends by
/// being superseded or revoked, never by a clock.
///
/// `up_sql == reference_sql` (only CREATEs).
pub const V0005_AUTHORITY_CERTIFICATES: Migration = Migration {
    version: 5,
    name: "authority_certificates",
    up_sql: V0005_SQL,
    reference_sql: V0005_SQL,
};

const V0005_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS authority_certificates (
    certificate_serial   TEXT NOT NULL PRIMARY KEY,
    tenant_id            TEXT NOT NULL,
    branch_id            TEXT NOT NULL,
    root_key_id          TEXT NOT NULL,
    root_generation      INTEGER NOT NULL,

    authority_id         TEXT NOT NULL,
    authority_epoch      INTEGER NOT NULL,
    server_instance_id   TEXT NOT NULL,
    primary_host_id      TEXT NOT NULL,
    previous_authority_id TEXT,

    -- The complete signed certificate (payload + signature), verbatim.
    certificate          TEXT NOT NULL,
    payload_hash         TEXT NOT NULL,

    status               TEXT NOT NULL,
    issued_at            TEXT NOT NULL,
    issued_by            TEXT,
    created_at           TEXT NOT NULL,
    revoked_at           TEXT,

    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
    FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT,

    CHECK (status IN ('active', 'superseded', 'revoked', 'recovery_pending')),
    CHECK (authority_epoch >= 1),
    CHECK (root_generation >= 1),
    CHECK (status <> 'revoked' OR revoked_at IS NOT NULL)
);

-- At most ONE active authority per tenant/branch in THIS database. Note precisely what
-- this does and does not buy: it is a file-local constraint. Two partitioned servers
-- each hold their own DB and each can satisfy it (M6-A4 §1). It prevents local
-- contradiction, not distributed split-brain.
CREATE UNIQUE INDEX IF NOT EXISTS idx_authority_one_active
    ON authority_certificates (tenant_id, branch_id) WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS idx_authority_id_unique
    ON authority_certificates (authority_id);

CREATE INDEX IF NOT EXISTS idx_authority_epoch
    ON authority_certificates (tenant_id, branch_id, authority_epoch);

CREATE TABLE IF NOT EXISTS authority_revocations (
    authority_id  TEXT NOT NULL PRIMARY KEY,
    tenant_id     TEXT NOT NULL,
    branch_id     TEXT NOT NULL,
    reason        TEXT,
    revoked_at    TEXT NOT NULL,
    revoked_by    TEXT NOT NULL,

    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT
);
"#;

/// M6-B2A — records WHICH installation this server DB belongs to and what role it was
/// explicitly configured for. Deliberately NOT carrying `authority_epoch` or any
/// certificate: the authority contract is M6-B2C, and a column here would imply a
/// guarantee that does not exist yet (M6-A4: single-authority is not enforceable
/// without a shared lease).
///
/// `up_sql == reference_sql` here (unlike v0001) — it only creates a new table, so the
/// drift reference runs cleanly in an empty in-memory database.
pub const V0002_PRIMARY_HOST_CONFIG: Migration = Migration {
    version: 2,
    name: "primary_host_config",
    up_sql: V0002_SQL,
    reference_sql: V0002_SQL,
};

const V0002_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS primary_host_config (
    tenant_id          TEXT NOT NULL,
    branch_id          TEXT NOT NULL,
    primary_host_id    TEXT,
    server_instance_id TEXT,
    mode               TEXT NOT NULL,
    configured_at      TEXT NOT NULL,
    configured_by      TEXT,
    state              TEXT NOT NULL,

    -- M6-B2A2 — Audit des LEGACY-HINWEISES, der zu dieser Zeile fuehrte. Bewusst
    -- getrennt von der Rolle: der Hinweis stammt aus kopierbaren Quellen (localStorage,
    -- Changelog-Historie) und ist deshalb nie eine Autorisierung, nur eine Spur.
    legacy_mode        TEXT,
    legacy_setup_done  INTEGER,
    legacy_has_served  INTEGER,
    adopted_at         TEXT,
    adopted_by         TEXT,

    PRIMARY KEY (tenant_id, branch_id),

    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
    FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT,

    CHECK (mode IN ('unconfigured', 'primary', 'client', 'legacy_pending')),
    -- `state` spiegelt den zuletzt geschriebenen `mode`. Der EFFEKTIVE Zustand (inkl.
    -- read_only bei Instance-Mismatch) wird nie gespeichert, sondern bei jedem Start aus
    -- mode + Install-ID neu aufgeloest — eine gespeicherte Kopie waere sonst genau das,
    -- was man mitkopieren kann.
    CHECK (state IN ('unconfigured', 'primary', 'client', 'legacy_pending')),
    -- A primary MUST be bound to a concrete installation. Without that binding a copied
    -- DB could call itself primary purely on the strength of its own contents.
    CHECK (mode <> 'primary' OR server_instance_id IS NOT NULL),
    -- A pending legacy hint must NOT carry a binding — that is the whole point: it has
    -- not been adopted yet.
    CHECK (mode <> 'legacy_pending' OR server_instance_id IS NULL)
);
"#;

pub const V0001_SYNC_PROTOCOL_FOUNDATION: Migration = Migration {
    version: 1,
    name: "sync_protocol_foundation",
    up_sql: UP_SQL,
    reference_sql: REFERENCE_SQL,
};

/// Structural reference for drift detection: the two new tables only.
/// MUST stay byte-identical to the corresponding part of `UP_SQL` — asserted by
/// `tests::reference_sql_is_the_new_table_prefix_of_up_sql`.
const REFERENCE_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS canonical_records (
    tenant_id         TEXT NOT NULL,
    branch_id         TEXT NOT NULL,
    table_name        TEXT NOT NULL,
    record_id         TEXT NOT NULL,
    record_revision   INTEGER NOT NULL,
    deleted           INTEGER NOT NULL DEFAULT 0,
    data_json         TEXT NOT NULL,
    last_operation_id TEXT,
    updated_at        TEXT NOT NULL,

    PRIMARY KEY (tenant_id, branch_id, table_name, record_id),

    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
    FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT,

    CHECK (record_revision >= 1),
    CHECK (deleted IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_canonical_records_table
    ON canonical_records (tenant_id, branch_id, table_name);

CREATE TABLE IF NOT EXISTS operations (
    tenant_id        TEXT NOT NULL,
    operation_id     TEXT NOT NULL,
    branch_id        TEXT NOT NULL,
    client_id        TEXT,
    actor_id         TEXT NOT NULL,
    table_name       TEXT NOT NULL,
    record_id        TEXT NOT NULL,
    base_revision    INTEGER,
    payload_hash     TEXT NOT NULL,
    protocol_version INTEGER NOT NULL,
    status           TEXT NOT NULL,
    result_json      TEXT NOT NULL,
    created_at       TEXT NOT NULL,

    PRIMARY KEY (tenant_id, operation_id),

    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
    FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT,
    FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE RESTRICT,

    CHECK (length(payload_hash) = 64),
    CHECK (protocol_version >= 1),
    CHECK (base_revision IS NULL OR base_revision >= 0),
    CHECK (status IN ('accepted', 'conflict', 'validation_rejected'))
);

CREATE INDEX IF NOT EXISTS idx_operations_record
    ON operations (tenant_id, branch_id, table_name, record_id);
"#;

/// Applied SQL: the reference structures plus the three additive, NULLable
/// protocol columns on the existing changelog. No backfill, no default value —
/// every pre-existing row reads back exactly as before, with NULL in the new
/// columns.
const UP_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS canonical_records (
    tenant_id         TEXT NOT NULL,
    branch_id         TEXT NOT NULL,
    table_name        TEXT NOT NULL,
    record_id         TEXT NOT NULL,
    record_revision   INTEGER NOT NULL,
    deleted           INTEGER NOT NULL DEFAULT 0,
    data_json         TEXT NOT NULL,
    last_operation_id TEXT,
    updated_at        TEXT NOT NULL,

    PRIMARY KEY (tenant_id, branch_id, table_name, record_id),

    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
    FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT,

    CHECK (record_revision >= 1),
    CHECK (deleted IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_canonical_records_table
    ON canonical_records (tenant_id, branch_id, table_name);

CREATE TABLE IF NOT EXISTS operations (
    tenant_id        TEXT NOT NULL,
    operation_id     TEXT NOT NULL,
    branch_id        TEXT NOT NULL,
    client_id        TEXT,
    actor_id         TEXT NOT NULL,
    table_name       TEXT NOT NULL,
    record_id        TEXT NOT NULL,
    base_revision    INTEGER,
    payload_hash     TEXT NOT NULL,
    protocol_version INTEGER NOT NULL,
    status           TEXT NOT NULL,
    result_json      TEXT NOT NULL,
    created_at       TEXT NOT NULL,

    PRIMARY KEY (tenant_id, operation_id),

    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
    FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT,
    FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE RESTRICT,

    CHECK (length(payload_hash) = 64),
    CHECK (protocol_version >= 1),
    CHECK (base_revision IS NULL OR base_revision >= 0),
    CHECK (status IN ('accepted', 'conflict', 'validation_rejected'))
);

CREATE INDEX IF NOT EXISTS idx_operations_record
    ON operations (tenant_id, branch_id, table_name, record_id);

ALTER TABLE sync_changelog ADD COLUMN record_revision INTEGER;
ALTER TABLE sync_changelog ADD COLUMN operation_id TEXT;
ALTER TABLE sync_changelog ADD COLUMN protocol_version INTEGER;
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use lataif_server::migrations::run_migrations;
    use rusqlite::{params, Connection};

    /// Minimal stand-in for the pre-existing embedded schema the migration lands on.
    /// Mirrors `db.rs` (tenants/branches/users/user_branches/sync_changelog).
    fn base_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS tenants (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
                plan TEXT DEFAULT 'starter', active INTEGER DEFAULT 1,
                max_branches INTEGER DEFAULT 3, max_users INTEGER DEFAULT 10,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS branches (
                id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
                name TEXT NOT NULL, country TEXT DEFAULT 'BH', currency TEXT DEFAULT 'BHD',
                address TEXT, active INTEGER DEFAULT 1,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
                email TEXT NOT NULL, password_hash TEXT NOT NULL, name TEXT NOT NULL,
                active INTEGER DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                UNIQUE(tenant_id, email)
            );
            CREATE TABLE IF NOT EXISTS user_branches (
                user_id TEXT NOT NULL REFERENCES users(id),
                branch_id TEXT NOT NULL REFERENCES branches(id),
                role TEXT NOT NULL DEFAULT 'viewer', is_default INTEGER DEFAULT 0,
                created_at TEXT NOT NULL, PRIMARY KEY (user_id, branch_id)
            );
            CREATE TABLE IF NOT EXISTS sync_changelog (
                id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL,
                branch_id TEXT NOT NULL, table_name TEXT NOT NULL, record_id TEXT NOT NULL,
                action TEXT NOT NULL, data TEXT NOT NULL, user_id TEXT, created_at TEXT NOT NULL
            );
            INSERT INTO tenants (id, name, slug, created_at, updated_at)
                VALUES ('tenant-1', 'T', 't', 'now', 'now');
            INSERT INTO branches (id, tenant_id, name, created_at, updated_at)
                VALUES ('branch-main', 'tenant-1', 'B', 'now', 'now');
            INSERT INTO users (id, tenant_id, email, password_hash, name, created_at, updated_at)
                VALUES ('user-owner', 'tenant-1', 'a@b.c', 'h', 'Admin', 'now', 'now');
            ",
        )
        .unwrap();
        conn
    }

    fn legacy_row(conn: &Connection) {
        conn.execute(
            "INSERT INTO sync_changelog (tenant_id, branch_id, table_name, record_id, action, data, user_id, created_at)
             VALUES ('tenant-1','branch-main','products','p1','update','{\"brand\":\"X\"}','self-desktop','2026-01-01')",
            [],
        )
        .unwrap();
    }

    fn columns(conn: &Connection, table: &str) -> Vec<String> {
        let mut stmt = conn
            .prepare(&format!("SELECT name FROM pragma_table_info('{table}')"))
            .unwrap();
        let v: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        v
    }

    fn table_exists(conn: &Connection, name: &str) -> bool {
        conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
            [name],
            |r| r.get::<_, i64>(0),
        )
        .unwrap()
            > 0
    }

    // ── 1. Migration applies on a fresh embedded DB ──────────────────────────
    #[test]
    fn migration_applies_and_creates_the_two_new_tables() {
        let conn = base_db();
        let report = run_migrations(&conn, EMBEDDED_MIGRATIONS).unwrap();
        assert_eq!(report.applied, vec![1, 2, 3, 4, 5, 6]);
        assert!(report.already_current.is_empty());
        assert!(table_exists(&conn, "canonical_records"));
        assert!(table_exists(&conn, "operations"));
        // M6-B2A
        assert!(table_exists(&conn, "primary_host_config"));
        // M6-B2C4
        assert!(table_exists(&conn, "authority_transfers"));
        assert!(table_exists(&conn, "root_custody"));
    }

    // ── M6-B2C4 §3 — an existing DB picks up exactly what it is missing ──────
    //
    // The interesting property is not "a fresh DB gets everything" (test 1) but "a DB that
    // stopped at some earlier version gets the rest, and only the rest". A migration that
    // re-ran an already-applied version would be how a live shop loses data.
    #[test]
    fn a_partially_migrated_db_applies_only_the_missing_versions() {
        for stop_at in [3usize, 5usize] {
            let conn = base_db();
            let partial = &EMBEDDED_MIGRATIONS[..stop_at];
            let first = run_migrations(&conn, partial).unwrap();
            assert_eq!(first.applied, (1..=stop_at as i64).collect::<Vec<_>>());

            let rest = run_migrations(&conn, EMBEDDED_MIGRATIONS).unwrap();
            assert_eq!(
                rest.applied,
                ((stop_at as i64 + 1)..=6).collect::<Vec<_>>(),
                "a DB at v000{stop_at} must apply exactly the missing versions"
            );
            assert_eq!(rest.already_current, (1..=stop_at as i64).collect::<Vec<_>>());
            assert!(table_exists(&conn, "authority_transfers"));
            assert!(table_exists(&conn, "root_custody"));
        }
    }

    // ── M6-B2C4 §3 — every version number is claimed exactly once ────────────
    #[test]
    fn migration_versions_are_unique_and_ascending() {
        let versions: Vec<i64> = EMBEDDED_MIGRATIONS.iter().map(|m| m.version).collect();
        assert_eq!(versions, vec![1, 2, 3, 4, 5, 6]);
        let mut sorted = versions.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted, versions, "strictly ascending, no duplicates");
        // A duplicate version is the failure mode of merging two branches that each added
        // "the next" migration — it silently skips one of them.
        let names: std::collections::HashSet<&str> =
            EMBEDDED_MIGRATIONS.iter().map(|m| m.name).collect();
        assert_eq!(names.len(), EMBEDDED_MIGRATIONS.len(), "no duplicate names either");
    }

    // ── M6-B2C4 §3 — v0006 declares its structure exactly as it applies it ───
    #[test]
    fn v0006_reference_sql_equals_up_sql() {
        // v0006 only CREATEs, so the drift reference can execute it verbatim in an empty
        // in-memory DB. (v0001 cannot — see the module docs on `up_sql != reference_sql`.)
        assert_eq!(
            V0006_AUTHORITY_TRANSFER_AND_ROOT_CUSTODY.up_sql,
            V0006_AUTHORITY_TRANSFER_AND_ROOT_CUSTODY.reference_sql
        );
        assert!(!V0006_SQL.to_uppercase().contains("ALTER TABLE"));
        assert!(!V0006_SQL.to_uppercase().contains("DROP "));
        // A migration never seeds business data.
        assert!(!V0006_SQL.to_uppercase().contains("INSERT INTO"));
    }

    // ── M6-B2C4 §3 — the DB itself carries the state invariants ──────────────
    #[test]
    fn v0006_check_constraints_reject_invalid_states() {
        let conn = base_db();
        run_migrations(&conn, EMBEDDED_MIGRATIONS).unwrap();
        // `base_db` already seeds tenant-1 / branch-main; the FKs below need them to exist.

        let insert = |state: &str, level: &str| {
            conn.execute(
                "INSERT INTO authority_transfers
                   (transfer_id, tenant_id, branch_id, source_authority_id, target_authority_id,
                    source_install_id, target_install_id, root_key_id, root_generation,
                    target_certificate, target_certificate_hash, commit_secret_hash,
                    abort_secret_hash, state, confirmation_level, created_at, confirmed_at,
                    committed_at, activated_at, aborted_at)
                 VALUES (?1,'tenant-1','branch-main','a','b','src','tgt','rk',1,'{}','h','ch','ah',
                         ?2, ?3, 'n','n','n','n','n')",
                params![uuid::Uuid::new_v4().to_string(), state, level],
            )
        };
        // The honest level is the ONLY one the schema accepts. A column that could hold
        // "device_attested" would be a lie one UPDATE away.
        assert!(insert("committed", "locally_confirmed_not_device_attested").is_ok());
        assert!(insert("committed", "device_attested").is_err(), "no invented attestation level");
        assert!(insert("committed", "verified").is_err());
        // Unknown states are refused outright.
        assert!(insert("something_else", "locally_confirmed_not_device_attested").is_err());

        // source == target would retire the only custody and hand it back to the same box.
        assert!(
            conn.execute(
                "INSERT INTO authority_transfers
                   (transfer_id, tenant_id, branch_id, source_authority_id, target_authority_id,
                    source_install_id, target_install_id, root_key_id, root_generation,
                    target_certificate, target_certificate_hash, commit_secret_hash,
                    abort_secret_hash, state, created_at)
                 VALUES ('t-self','tenant-1','branch-main','a','b','same','same','rk',1,'{}','h',
                         'ch','ah','issued_pending','n')",
                [],
            )
            .is_err(),
            "a transfer to oneself must be impossible at the schema level"
        );

        // root_custody: unknown state
        assert!(
            conn.execute(
                "INSERT INTO root_custody
                   (tenant_id, root_key_id, root_generation, install_id, state, created_at)
                 VALUES ('tenant-1','rk',1,'i','nonsense','n')",
                [],
            )
            .is_err()
        );
        // …and a pending target custody without the transfer that created it
        assert!(
            conn.execute(
                "INSERT INTO root_custody
                   (tenant_id, root_key_id, root_generation, install_id, transfer_id, state,
                    created_at)
                 VALUES ('tenant-1','rk',1,'i',NULL,'target_pending','n')",
                [],
            )
            .is_err(),
            "target_pending exists only because a transfer created it"
        );
    }

    // ── 2. Idempotent: second run is a verified no-op ────────────────────────
    #[test]
    fn migration_is_idempotent() {
        let conn = base_db();
        run_migrations(&conn, EMBEDDED_MIGRATIONS).unwrap();
        let second = run_migrations(&conn, EMBEDDED_MIGRATIONS).unwrap();
        assert!(second.applied.is_empty(), "second run must apply nothing");
        assert_eq!(second.already_current, vec![1, 2, 3, 4, 5, 6]);
        // and a third, to be sure the ALTERs are not retried
        let third = run_migrations(&conn, EMBEDDED_MIGRATIONS).unwrap();
        assert!(third.applied.is_empty());
    }

    // ── 3. The five pre-existing tables survive untouched ────────────────────
    #[test]
    fn existing_five_tables_remain() {
        let conn = base_db();
        let before: Vec<Vec<String>> = ["tenants", "branches", "users", "user_branches"]
            .iter()
            .map(|t| columns(&conn, t))
            .collect();
        run_migrations(&conn, EMBEDDED_MIGRATIONS).unwrap();
        for t in ["tenants", "branches", "users", "user_branches", "sync_changelog"] {
            assert!(table_exists(&conn, t), "{t} must still exist");
        }
        let after: Vec<Vec<String>> = ["tenants", "branches", "users", "user_branches"]
            .iter()
            .map(|t| columns(&conn, t))
            .collect();
        assert_eq!(before, after, "untouched tables must keep their exact columns");
    }

    // ── 4. Existing changelog rows unchanged; new columns NULL ───────────────
    #[test]
    fn legacy_changelog_rows_are_unchanged_and_new_columns_are_null() {
        let conn = base_db();
        legacy_row(&conn);
        run_migrations(&conn, EMBEDDED_MIGRATIONS).unwrap();

        let (table, record, action, data, user, created): (String, String, String, String, String, String) = conn
            .query_row(
                "SELECT table_name, record_id, action, data, user_id, created_at FROM sync_changelog WHERE id=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            )
            .unwrap();
        assert_eq!(table, "products");
        assert_eq!(record, "p1");
        assert_eq!(action, "update");
        assert_eq!(data, "{\"brand\":\"X\"}");
        assert_eq!(user, "self-desktop");
        assert_eq!(created, "2026-01-01");

        let (rev, op, pv): (Option<i64>, Option<String>, Option<i64>) = conn
            .query_row(
                "SELECT record_revision, operation_id, protocol_version FROM sync_changelog WHERE id=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert!(rev.is_none(), "no invented revision backfill");
        assert!(op.is_none());
        assert!(pv.is_none());
    }

    // ── 5. The three additive columns exist, appended at the end ─────────────
    #[test]
    fn changelog_gains_exactly_three_nullable_columns() {
        let conn = base_db();
        let before = columns(&conn, "sync_changelog");
        run_migrations(&conn, EMBEDDED_MIGRATIONS).unwrap();
        let after = columns(&conn, "sync_changelog");
        assert_eq!(after.len(), before.len() + 3);
        assert_eq!(&after[..before.len()], &before[..], "existing columns keep position");
        assert_eq!(&after[before.len()..], &["record_revision", "operation_id", "protocol_version"]);
    }

    // ── 6. Nothing is auto-populated ─────────────────────────────────────────
    #[test]
    fn no_rows_are_created_in_the_new_tables() {
        let conn = base_db();
        legacy_row(&conn);
        run_migrations(&conn, EMBEDDED_MIGRATIONS).unwrap();
        for t in ["canonical_records", "operations"] {
            let n: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 0, "{t} must stay empty in M6-B1");
        }
    }

    // ── 7. The drift reference must describe exactly the new tables ──────────
    #[test]
    fn reference_sql_is_the_new_table_prefix_of_up_sql() {
        assert!(
            UP_SQL.starts_with(REFERENCE_SQL.trim_end()),
            "REFERENCE_SQL must be the verbatim leading part of UP_SQL — otherwise \
             drift detection would verify a structure that was never applied"
        );
        assert!(!REFERENCE_SQL.contains("ALTER TABLE"));
        assert_eq!(UP_SQL.matches("ALTER TABLE sync_changelog ADD COLUMN").count(), 3);
    }

    // ── 8. Drift detection actually guards the new tables ────────────────────
    #[test]
    fn tampering_with_a_new_table_is_detected_as_drift() {
        let conn = base_db();
        run_migrations(&conn, EMBEDDED_MIGRATIONS).unwrap();
        conn.execute_batch("ALTER TABLE canonical_records ADD COLUMN sneaky TEXT;")
            .unwrap();
        let err = run_migrations(&conn, EMBEDDED_MIGRATIONS).unwrap_err();
        assert!(
            format!("{err:?}").contains("SchemaDrift"),
            "post-hoc tampering must surface as drift, got: {err:?}"
        );
    }

    // ── 9. authority_epoch is deliberately absent (no false guarantee) ───────
    #[test]
    fn operations_has_no_authority_epoch_yet() {
        let conn = base_db();
        run_migrations(&conn, EMBEDDED_MIGRATIONS).unwrap();
        let cols = columns(&conn, "operations");
        assert!(
            !cols.iter().any(|c| c == "authority_epoch"),
            "M6-A4: the authority contract is not enforceable yet — the schema must \
             not imply it. M6-B2 adds the column with the mechanism."
        );
        for expected in [
            "tenant_id", "operation_id", "client_id", "actor_id", "table_name",
            "record_id", "base_revision", "payload_hash", "protocol_version",
            "status", "result_json", "created_at",
        ] {
            assert!(cols.iter().any(|c| c == expected), "operations must carry {expected}");
        }
    }
}
