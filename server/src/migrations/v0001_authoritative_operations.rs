//! Migration v0001 — authoritative-operation infrastructure (additive, empty).
//!
//! A1a scope: this migration ONLY creates the additive, INITIALLY EMPTY tables
//! and indexes for the future Authoritative-Operation-Commit (protocol v4). It
//! changes no existing table, inserts no rows, registers no handler, and is
//! never written to by any production path. See `mod.rs` for the runner.
//!
//! Frozen wire constants mirrored from the A0b protocol contract
//! (`test/a0b/protocol-spec.md`): `protocol_version = 4`, payload hash length
//! 64 (SHA-256 hex), envelope byte cap `1048576` (1 MiB), `mutation_count` /
//! `ordinal` bounded to `u32` (`4294967295`), final statuses
//! `accepted | conflict | validation_rejected`, ledger amounts integer fils,
//! direction `DEBIT | CREDIT`, currency `BHD`.

use super::Migration;

/// The v0001 migration. `up_sql == reference_sql` for every production
/// migration (enforced by a test); the separate `reference_sql` field exists
/// only so failure-injection tests can drive an apply that fails on the target
/// while still providing a valid structural reference.
pub const V0001: Migration = Migration {
    version: 1,
    name: "authoritative_operations",
    up_sql: SQL,
    reference_sql: SQL,
};

const SQL: &str = r#"
CREATE TABLE IF NOT EXISTS server_state (
    tenant_id                 TEXT NOT NULL,
    plane                     TEXT NOT NULL,
    finance_state             TEXT NOT NULL,
    required_protocol_version INTEGER NOT NULL DEFAULT 4,
    updated_at                TEXT NOT NULL,

    PRIMARY KEY (tenant_id, plane),

    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,

    CHECK (plane = 'finance'),
    CHECK (finance_state IN ('NOT_INITIALIZED', 'IMPORTING', 'READY', 'READ_ONLY')),
    CHECK (required_protocol_version = 4)
);

CREATE TABLE IF NOT EXISTS operations (
    tenant_id              TEXT NOT NULL,
    operation_id           TEXT NOT NULL,
    branch_id              TEXT NOT NULL,
    operation_type         TEXT NOT NULL,
    protocol_version       INTEGER NOT NULL,
    client_id              TEXT,
    actor_id               TEXT NOT NULL,
    payload_hash           TEXT NOT NULL,
    canonical_payload_json TEXT NOT NULL,
    status                 TEXT NOT NULL,
    result_json            TEXT NOT NULL,
    error_code             TEXT,
    ledger_transaction_id  TEXT,
    created_at             TEXT NOT NULL,
    committed_at           TEXT NOT NULL,

    PRIMARY KEY (tenant_id, operation_id),

    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
    FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT,
    FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE RESTRICT,

    CHECK (protocol_version = 4),
    CHECK (length(payload_hash) = 64),
    CHECK (status IN ('accepted', 'conflict', 'validation_rejected')),
    CHECK (
        (status = 'accepted' AND error_code IS NULL)
        OR
        (status <> 'accepted' AND error_code IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_operations_branch_committed
    ON operations (tenant_id, branch_id, committed_at);
CREATE INDEX IF NOT EXISTS idx_operations_type_committed
    ON operations (tenant_id, operation_type, committed_at);
CREATE INDEX IF NOT EXISTS idx_operations_actor_committed
    ON operations (tenant_id, actor_id, committed_at);

CREATE TABLE IF NOT EXISTS operation_sequence (
    sequence     INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id    TEXT NOT NULL,
    branch_id    TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    created_at   TEXT NOT NULL,

    UNIQUE (tenant_id, operation_id),

    FOREIGN KEY (tenant_id, operation_id)
        REFERENCES operations(tenant_id, operation_id) ON DELETE RESTRICT,
    FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_operation_sequence_branch_seq
    ON operation_sequence (tenant_id, branch_id, sequence);

CREATE TABLE IF NOT EXISTS aggregate_revisions (
    tenant_id         TEXT NOT NULL,
    branch_id         TEXT NOT NULL,
    aggregate_type    TEXT NOT NULL,
    aggregate_id      TEXT NOT NULL,
    revision          INTEGER NOT NULL DEFAULT 0,
    last_operation_id TEXT,
    updated_at        TEXT NOT NULL,

    PRIMARY KEY (tenant_id, branch_id, aggregate_type, aggregate_id),

    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
    FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT,

    CHECK (revision >= 0)
);

CREATE TABLE IF NOT EXISTS canonical_records (
    tenant_id         TEXT NOT NULL,
    branch_id         TEXT NOT NULL,
    table_name        TEXT NOT NULL,
    record_id         TEXT NOT NULL,
    record_revision   INTEGER NOT NULL,
    deleted           INTEGER NOT NULL DEFAULT 0,
    data_json         TEXT NOT NULL,
    last_operation_id TEXT NOT NULL,
    updated_at        TEXT NOT NULL,

    PRIMARY KEY (tenant_id, branch_id, table_name, record_id),

    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
    FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT,

    CHECK (record_revision >= 1),
    CHECK (deleted IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_canonical_records_table_updated
    ON canonical_records (tenant_id, branch_id, table_name, updated_at);
CREATE INDEX IF NOT EXISTS idx_canonical_records_last_op
    ON canonical_records (tenant_id, branch_id, last_operation_id);

CREATE TABLE IF NOT EXISTS operation_envelopes (
    tenant_id       TEXT NOT NULL,
    branch_id       TEXT NOT NULL,
    operation_id    TEXT NOT NULL,
    server_sequence INTEGER NOT NULL,
    envelope_json   TEXT NOT NULL,
    byte_size       INTEGER NOT NULL,
    mutation_count  INTEGER NOT NULL,
    created_at      TEXT NOT NULL,

    PRIMARY KEY (tenant_id, operation_id),

    UNIQUE (server_sequence),

    FOREIGN KEY (tenant_id, operation_id)
        REFERENCES operations(tenant_id, operation_id) ON DELETE RESTRICT,
    FOREIGN KEY (server_sequence)
        REFERENCES operation_sequence(sequence) ON DELETE RESTRICT,
    FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT,

    CHECK (byte_size >= 0),
    CHECK (byte_size <= 1048576),
    CHECK (mutation_count >= 0),
    CHECK (mutation_count <= 4294967295)
);

CREATE INDEX IF NOT EXISTS idx_operation_envelopes_branch_seq
    ON operation_envelopes (tenant_id, branch_id, server_sequence);

CREATE TABLE IF NOT EXISTS operation_mutations (
    tenant_id       TEXT NOT NULL,
    operation_id    TEXT NOT NULL,
    ordinal         INTEGER NOT NULL,
    branch_id       TEXT NOT NULL,
    action          TEXT NOT NULL,
    table_name      TEXT NOT NULL,
    record_id       TEXT NOT NULL,
    record_revision INTEGER NOT NULL,
    payload_json    TEXT NOT NULL,
    created_at      TEXT NOT NULL,

    PRIMARY KEY (tenant_id, operation_id, ordinal),

    FOREIGN KEY (tenant_id, operation_id)
        REFERENCES operation_envelopes(tenant_id, operation_id) ON DELETE RESTRICT,
    FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT,

    CHECK (ordinal >= 0),
    CHECK (ordinal <= 4294967295),
    CHECK (record_revision >= 1),
    CHECK (action IN ('upsert', 'delete'))
);

CREATE INDEX IF NOT EXISTS idx_operation_mutations_table_record
    ON operation_mutations (tenant_id, branch_id, table_name, record_id);
CREATE INDEX IF NOT EXISTS idx_operation_mutations_op_ordinal
    ON operation_mutations (tenant_id, operation_id, ordinal);

CREATE TABLE IF NOT EXISTS auth_ledger_entries (
    tenant_id         TEXT NOT NULL,
    id                TEXT NOT NULL,
    branch_id         TEXT NOT NULL,
    entry_no          INTEGER NOT NULL,
    transaction_id    TEXT NOT NULL,
    operation_id      TEXT NOT NULL,
    occurred_at       TEXT NOT NULL,
    recorded_at       TEXT NOT NULL,
    account           TEXT NOT NULL,
    direction         TEXT NOT NULL,
    amount_fils       INTEGER NOT NULL,
    currency          TEXT NOT NULL DEFAULT 'BHD',
    counterparty_type TEXT,
    counterparty_id   TEXT,
    source_module     TEXT NOT NULL,
    source_id         TEXT NOT NULL,
    leg_role          TEXT NOT NULL,
    metadata_json     TEXT,
    created_at        TEXT NOT NULL,

    PRIMARY KEY (tenant_id, id),

    UNIQUE (tenant_id, branch_id, entry_no),

    FOREIGN KEY (tenant_id, operation_id)
        REFERENCES operations(tenant_id, operation_id) ON DELETE RESTRICT,
    FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT,

    CHECK (entry_no >= 1),
    CHECK (direction IN ('DEBIT', 'CREDIT')),
    CHECK (amount_fils >= 0),
    CHECK (currency = 'BHD')
);

CREATE INDEX IF NOT EXISTS idx_auth_ledger_entries_txn
    ON auth_ledger_entries (tenant_id, branch_id, transaction_id);
CREATE INDEX IF NOT EXISTS idx_auth_ledger_entries_account
    ON auth_ledger_entries (tenant_id, branch_id, account, entry_no);
CREATE INDEX IF NOT EXISTS idx_auth_ledger_entries_counterparty
    ON auth_ledger_entries (tenant_id, branch_id, counterparty_type, counterparty_id);
CREATE INDEX IF NOT EXISTS idx_auth_ledger_entries_op
    ON auth_ledger_entries (tenant_id, operation_id);

CREATE TABLE IF NOT EXISTS ledger_sequence (
    tenant_id     TEXT NOT NULL,
    branch_id     TEXT NOT NULL,
    next_entry_no INTEGER NOT NULL DEFAULT 1,
    updated_at    TEXT NOT NULL,

    PRIMARY KEY (tenant_id, branch_id),

    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
    FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT,

    CHECK (next_entry_no >= 1)
);
"#;
