//! B0 tests for the operations-pull foundation and branch-isolated snapshot
//! reconstruction. Test data is inserted directly into the authoritative tables
//! (no B1 submit is required or available in B0).

use super::*;
use rusqlite::{params, Connection};
use serde_json::json;

const HASH64: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn setup(conn: &Connection) {
    conn.execute_batch(
        "PRAGMA foreign_keys=ON;
         CREATE TABLE tenants (id TEXT PRIMARY KEY);
         CREATE TABLE branches (id TEXT PRIMARY KEY, tenant_id TEXT);
         CREATE TABLE users (id TEXT PRIMARY KEY, tenant_id TEXT);
         CREATE TABLE sync_changelog (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id TEXT NOT NULL, branch_id TEXT NOT NULL,
            table_name TEXT NOT NULL, record_id TEXT NOT NULL,
            action TEXT NOT NULL, data TEXT NOT NULL,
            user_id TEXT, created_at TEXT NOT NULL);
         INSERT INTO tenants (id) VALUES ('t1'),('t2');
         INSERT INTO branches (id, tenant_id) VALUES ('b1','t1'),('b2','t1'),('b3','t2');
         INSERT INTO users (id, tenant_id) VALUES ('u1','t1'),('u2','t2');",
    )
    .unwrap();
    crate::migrations::run_migrations(conn, crate::migrations::ALL_MIGRATIONS).unwrap();
}

/// Seed one accepted operation + sequence + envelope; returns its serverSequence.
fn seed_envelope(conn: &Connection, tenant: &str, actor: &str, op_id: &str, branch: &str) -> i64 {
    conn.execute(
        "INSERT INTO operations
           (tenant_id, operation_id, branch_id, operation_type, protocol_version, actor_id,
            payload_hash, canonical_payload_json, status, result_json, created_at, committed_at)
         VALUES (?1,?2,?3,'APPLY_SUPPLIER_CREDIT_TO_EXPENSES',4,?4,?5,'{}','accepted','{}','t','t')",
        params![tenant, op_id, branch, actor, HASH64],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO operation_sequence (tenant_id, branch_id, operation_id, created_at)
         VALUES (?1,?2,?3,'t')",
        params![tenant, branch, op_id],
    )
    .unwrap();
    let seq = conn.last_insert_rowid();
    let env = json!({ "operationId": op_id, "serverSequence": seq.to_string(), "mutations": [] });
    conn.execute(
        "INSERT INTO operation_envelopes
           (tenant_id, branch_id, operation_id, server_sequence, envelope_json, byte_size, mutation_count, created_at)
         VALUES (?1,?2,?3,?4,?5,0,0,'t')",
        params![tenant, branch, op_id, seq, env.to_string()],
    )
    .unwrap();
    seq
}

#[test]
fn pull_delivers_each_envelope_once() {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    let seq = seed_envelope(&conn, "t1", "u1", "op-a", "b1");

    let r = pull_operations(&conn, "t1", "b1", 0, 100).unwrap();
    assert_eq!(r.operations.len(), 1);
    assert_eq!(r.operations[0].server_sequence, seq);
    assert_eq!(r.cursor, seq);
    assert!(!r.has_more);

    // re-pull from the returned cursor → no duplicate
    let r2 = pull_operations(&conn, "t1", "b1", r.cursor, 100).unwrap();
    assert_eq!(r2.operations.len(), 0);
    assert_eq!(r2.cursor, seq);
}

#[test]
fn pull_is_branch_and_tenant_isolated_with_sequence_gaps() {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    // interleave branches → global sequence has per-branch gaps
    let a1 = seed_envelope(&conn, "t1", "u1", "op-a1", "b1");
    let b1 = seed_envelope(&conn, "t1", "u1", "op-b1", "b2");
    let a2 = seed_envelope(&conn, "t1", "u1", "op-a2", "b1");
    let b2 = seed_envelope(&conn, "t1", "u1", "op-b2", "b2");
    assert!(a1 < b1 && b1 < a2 && a2 < b2);

    let ra = pull_operations(&conn, "t1", "b1", 0, 100).unwrap();
    assert_eq!(
        ra.operations
            .iter()
            .map(|o| o.server_sequence)
            .collect::<Vec<_>>(),
        vec![a1, a2]
    );
    let rb = pull_operations(&conn, "t1", "b2", 0, 100).unwrap();
    assert_eq!(
        rb.operations
            .iter()
            .map(|o| o.server_sequence)
            .collect::<Vec<_>>(),
        vec![b1, b2]
    );
    // other branch's cursor never moved by this branch
    assert_eq!(ra.cursor, a2);
    assert_eq!(rb.cursor, b2);

    // wrong tenant / wrong branch sees nothing
    assert_eq!(
        pull_operations(&conn, "t2", "b1", 0, 100)
            .unwrap()
            .operations
            .len(),
        0
    );
    assert_eq!(
        pull_operations(&conn, "t1", "b3", 0, 100)
            .unwrap()
            .operations
            .len(),
        0
    );
}

#[test]
fn pull_limit_never_splits_an_envelope() {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    let s1 = seed_envelope(&conn, "t1", "u1", "op-1", "b1");
    let s2 = seed_envelope(&conn, "t1", "u1", "op-2", "b1");

    let r1 = pull_operations(&conn, "t1", "b1", 0, 1).unwrap();
    assert_eq!(r1.operations.len(), 1);
    assert_eq!(r1.operations[0].server_sequence, s1);
    assert!(r1.has_more);

    let r2 = pull_operations(&conn, "t1", "b1", r1.cursor, 1).unwrap();
    assert_eq!(r2.operations.len(), 1);
    assert_eq!(r2.operations[0].server_sequence, s2);
    assert!(!r2.has_more);

    let r3 = pull_operations(&conn, "t1", "b1", r2.cursor, 1).unwrap();
    assert_eq!(r3.operations.len(), 0);
    assert!(!r3.has_more);
}

#[test]
fn latest_snapshot_is_branch_isolated_and_delete_aware() {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    let put = |branch: &str, action: &str, amount: i64| {
        conn.execute(
            "INSERT INTO sync_changelog (tenant_id, branch_id, table_name, record_id, action, data, user_id, created_at)
             VALUES ('t1',?1,'supplier_credits','cred-1',?2,?3,'u1','t')",
            params![branch, action, json!({ "id": "cred-1", "amount": amount }).to_string()],
        )
        .unwrap();
    };
    // same record id in two branches → must not mix
    put("b1", "insert", 100);
    put("b2", "insert", 999);
    put("b1", "update", 50);
    assert_eq!(
        latest_snapshot(&conn, "t1", "b1", "supplier_credits", "cred-1")
            .unwrap()
            .unwrap()["amount"],
        json!(50)
    );
    assert_eq!(
        latest_snapshot(&conn, "t1", "b2", "supplier_credits", "cred-1")
            .unwrap()
            .unwrap()["amount"],
        json!(999)
    );
    // delete in b1 → gone for b1, untouched for b2; an older snapshot never reappears
    put("b1", "delete", 0);
    assert!(
        latest_snapshot(&conn, "t1", "b1", "supplier_credits", "cred-1")
            .unwrap()
            .is_none()
    );
    assert_eq!(
        latest_snapshot(&conn, "t1", "b2", "supplier_credits", "cred-1")
            .unwrap()
            .unwrap()["amount"],
        json!(999)
    );
    // unknown tenant sees nothing
    assert!(
        latest_snapshot(&conn, "t2", "b1", "supplier_credits", "cred-1")
            .unwrap()
            .is_none()
    );
}

// ───────────────────────── B0 bridge tests ─────────────────────────

use super::bridge::{process_sync_batch, BatchError};
use crate::models::SyncPushChange;

fn chg(table: &str, rid: &str, action: &str, data: Value) -> SyncPushChange {
    SyncPushChange {
        table_name: table.into(),
        record_id: rid.into(),
        action: action.into(),
        data: data.to_string(),
    }
}

fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |r| r.get(0)).unwrap()
}

fn push_snapshot(conn: &Connection, table: &str, record_id: &str, action: &str, data: &Value) {
    conn.execute(
        "INSERT INTO sync_changelog (tenant_id, branch_id, table_name, record_id, action, data, user_id, created_at)
         VALUES ('t1','b1',?1,?2,?3,?4,'u1','t')",
        params![table, record_id, action, data.to_string()],
    )
    .unwrap();
}

/// Seed a protected EXPENSE_SETTLEMENT projection (canonical_records + revision).
fn seed_exp_proj(
    conn: &Connection,
    eid: &str,
    supplier: &str,
    amount_f: i64,
    noncredit_f: i64,
    credit_f: i64,
    rev: i64,
) {
    let settled = noncredit_f + credit_f;
    let data = json!({
        "expenseId": eid, "tenantId": "t1", "branchId": "b1", "supplierId": supplier,
        "amountFils": amount_f, "nonCreditPaidFils": noncredit_f, "creditPaidFils": credit_f,
        "settledFils": settled, "openFils": amount_f - settled,
        "status": if settled >= amount_f { "PAID" } else { "PENDING" }
    });
    conn.execute(
        "INSERT INTO canonical_records (tenant_id,branch_id,table_name,record_id,record_revision,deleted,data_json,last_operation_id,updated_at)
         VALUES ('t1','b1','expenses',?1,?2,0,?3,'B1','t')",
        params![eid, rev, data.to_string()],
    ).unwrap();
    conn.execute(
        "INSERT INTO aggregate_revisions (tenant_id,branch_id,aggregate_type,aggregate_id,revision,updated_at)
         VALUES ('t1','b1','EXPENSE_SETTLEMENT',?1,?2,'t')",
        params![eid, rev],
    ).unwrap();
}

/// Seed a protected SUPPLIER_CREDIT_BALANCE projection.
fn seed_cred_proj(
    conn: &Connection,
    cid: &str,
    supplier: &str,
    amount_f: i64,
    used_f: i64,
    rev: i64,
) {
    let data = json!({
        "creditId": cid, "tenantId": "t1", "branchId": "b1", "supplierId": supplier,
        "amountFils": amount_f, "usedAmountFils": used_f, "availableAmountFils": amount_f - used_f,
        "status": if used_f >= amount_f { "USED" } else { "OPEN" }
    });
    conn.execute(
        "INSERT INTO canonical_records (tenant_id,branch_id,table_name,record_id,record_revision,deleted,data_json,last_operation_id,updated_at)
         VALUES ('t1','b1','supplier_credits',?1,?2,0,?3,'B1','t')",
        params![cid, rev, data.to_string()],
    ).unwrap();
    conn.execute(
        "INSERT INTO aggregate_revisions (tenant_id,branch_id,aggregate_type,aggregate_id,revision,updated_at)
         VALUES ('t1','b1','SUPPLIER_CREDIT_BALANCE',?1,?2,'t')",
        params![cid, rev],
    ).unwrap();
}

fn agg_rev(conn: &Connection, agg_type: &str, agg_id: &str) -> i64 {
    conn.query_row(
        "SELECT revision FROM aggregate_revisions WHERE aggregate_type=?1 AND aggregate_id=?2",
        params![agg_type, agg_id],
        |r| r.get(0),
    )
    .unwrap()
}

fn exp_proj(conn: &Connection, eid: &str) -> Value {
    let d: String = conn
        .query_row(
            "SELECT data_json FROM canonical_records WHERE table_name='expenses' AND record_id=?1",
            params![eid],
            |r| r.get(0),
        )
        .unwrap();
    serde_json::from_str(&d).unwrap()
}

fn cl_count(conn: &Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM sync_changelog", [], |r| r.get(0))
        .unwrap()
}

// ── unprotected fast path: legacy behaviour unchanged ──

#[test]
fn unprotected_batch_is_plain_relay() {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    let n = process_sync_batch(
        &conn,
        "t1",
        "b1",
        "u1",
        &[
            chg(
                "expenses",
                "e1",
                "update",
                json!({"id":"e1","paid_amount":5.0}),
            ),
            chg("products", "p1", "update", json!({"id":"p1","name":"x"})),
        ],
        "t",
    )
    .unwrap();
    assert_eq!(n, 2);
    assert_eq!(cl_count(&conn), 2);
    // no projection created
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM canonical_records"), 0);
}

// ── fold cash/bank/benefit; order-independent; no double count ──

#[test]
fn noncredit_payment_folds_no_double_count_order_independent() {
    for (order, method) in [(0, "cash"), (1, "cash"), (0, "bank"), (0, "benefit")] {
        let conn = Connection::open_in_memory().unwrap();
        setup(&conn);
        // amount 100, non-credit 0, credit 60 (already credit-settled → protected)
        seed_exp_proj(&conn, "exp-1", "sup-1", 100_000, 0, 60_000, 1);
        let ec = chg(
            "expenses",
            "exp-1",
            "update",
            json!({"id":"exp-1","paid_amount":40.0,"status":"PAID","description":"d"}),
        );
        let pc = chg(
            "expense_payments",
            "pay-1",
            "insert",
            json!({"id":"pay-1","expense_id":"exp-1","amount":40.0,"method":method}),
        );
        let batch = if order == 0 {
            vec![ec, pc]
        } else {
            vec![pc, ec]
        };
        process_sync_batch(&conn, "t1", "b1", "u1", &batch, "t").unwrap();
        let p = exp_proj(&conn, "exp-1");
        assert_eq!(p["nonCreditPaidFils"], json!(40_000), "{method}/{order}");
        assert_eq!(p["creditPaidFils"], json!(60_000)); // authoritative, untouched
        assert_eq!(p["settledFils"], json!(100_000)); // NOT 140_000 — no double count
        assert_eq!(p["status"], json!("PAID"));
        assert_eq!(agg_rev(&conn, "EXPENSE_SETTLEMENT", "exp-1"), 2); // +1
    }
}

#[test]
fn payment_delete_reduces_non_credit() {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    seed_exp_proj(&conn, "exp-1", "sup-1", 100_000, 40_000, 0, 1);
    push_snapshot(
        &conn,
        "expense_payments",
        "pay-1",
        "insert",
        &json!({"id":"pay-1","expense_id":"exp-1","amount":40.0,"method":"cash"}),
    );
    process_sync_batch(
        &conn,
        "t1",
        "b1",
        "u1",
        &[
            chg(
                "expenses",
                "exp-1",
                "update",
                json!({"id":"exp-1","paid_amount":0.0,"status":"PENDING"}),
            ),
            chg("expense_payments", "pay-1", "delete", json!({})),
        ],
        "t",
    )
    .unwrap();
    assert_eq!(exp_proj(&conn, "exp-1")["nonCreditPaidFils"], json!(0));
    assert_eq!(agg_rev(&conn, "EXPENSE_SETTLEMENT", "exp-1"), 2);
}

#[test]
fn incomplete_payment_batches_are_rejected() {
    // (a) payment delete without the matching expense paid_amount update
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    seed_exp_proj(&conn, "exp-1", "sup-1", 100_000, 40_000, 0, 1);
    push_snapshot(
        &conn,
        "expense_payments",
        "pay-1",
        "insert",
        &json!({"id":"pay-1","expense_id":"exp-1","amount":40.0,"method":"cash"}),
    );
    let r = process_sync_batch(
        &conn,
        "t1",
        "b1",
        "u1",
        &[chg("expense_payments", "pay-1", "delete", json!({}))],
        "t",
    );
    assert!(
        matches!(r, Err(BatchError::IncompletePaymentBatch(_))),
        "{:?}",
        r
    );
    assert_eq!(agg_rev(&conn, "EXPENSE_SETTLEMENT", "exp-1"), 1); // no bump

    // (b) expense paid_amount change without any payment flow
    let conn2 = Connection::open_in_memory().unwrap();
    setup(&conn2);
    seed_exp_proj(&conn2, "exp-1", "sup-1", 100_000, 0, 0, 1);
    let r2 = process_sync_batch(
        &conn2,
        "t1",
        "b1",
        "u1",
        &[chg(
            "expenses",
            "exp-1",
            "update",
            json!({"id":"exp-1","paid_amount":40.0}),
        )],
        "t",
    );
    assert!(
        matches!(r2, Err(BatchError::IncompletePaymentBatch(_))),
        "{:?}",
        r2
    );
}

// ── credit-payment guard (insert/update/delete, evasion) ──

#[test]
fn credit_payment_blocked_even_with_stripped_fields() {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    seed_exp_proj(&conn, "exp-1", "sup-1", 100_000, 0, 60_000, 1);
    seed_cred_proj(&conn, "cred-1", "sup-1", 100_000, 60_000, 1);
    // direct credit insert
    assert!(matches!(
        process_sync_batch(
            &conn,
            "t1",
            "b1",
            "u1",
            &[chg(
                "expense_payments",
                "pay-c",
                "insert",
                json!({"id":"pay-c","expense_id":"exp-1","amount":60.0,"method":"credit","reference":"cred-1"})
            )],
            "t"
        ),
        Err(BatchError::ProtectedCreditPayment(_))
    ));
    // evasion: a prior credit payment, then an update that strips method/expense_id/reference
    push_snapshot(
        &conn,
        "expense_payments",
        "pay-c",
        "insert",
        &json!({"id":"pay-c","expense_id":"exp-1","amount":60.0,"method":"credit","reference":"cred-1"}),
    );
    assert!(matches!(
        process_sync_batch(
            &conn,
            "t1",
            "b1",
            "u1",
            &[chg(
                "expense_payments",
                "pay-c",
                "update",
                json!({"id":"pay-c","note":"x"})
            )],
            "t"
        ),
        Err(BatchError::ProtectedCreditPayment(_))
    ));
    // evasion: delete with empty data
    assert!(matches!(
        process_sync_batch(
            &conn,
            "t1",
            "b1",
            "u1",
            &[chg("expense_payments", "pay-c", "delete", json!({}))],
            "t"
        ),
        Err(BatchError::ProtectedCreditPayment(_))
    ));
}

// ── protected expense: cancel / delete / supplier-change blocked ──

#[test]
fn protected_expense_cancel_delete_supplier_blocked() {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    seed_exp_proj(&conn, "exp-1", "sup-1", 100_000, 0, 60_000, 1);
    assert!(matches!(
        process_sync_batch(
            &conn,
            "t1",
            "b1",
            "u1",
            &[chg(
                "expenses",
                "exp-1",
                "update",
                json!({"id":"exp-1","status":"CANCELLED"})
            )],
            "t"
        ),
        Err(BatchError::ProtectedExpenseCancelDelete(_))
    ));
    assert!(matches!(
        process_sync_batch(
            &conn,
            "t1",
            "b1",
            "u1",
            &[chg("expenses", "exp-1", "delete", json!({}))],
            "t"
        ),
        Err(BatchError::ProtectedExpenseCancelDelete(_))
    ));
    assert!(matches!(
        process_sync_batch(
            &conn,
            "t1",
            "b1",
            "u1",
            &[chg(
                "expenses",
                "exp-1",
                "update",
                json!({"id":"exp-1","supplier_id":"OTHER"})
            )],
            "t"
        ),
        Err(BatchError::SupplierChangeLocked(_))
    ));
}

// ── protected supplier credit: delete / consumption blocked, note allowed ──

#[test]
fn protected_credit_guards() {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    seed_cred_proj(&conn, "cred-1", "sup-1", 100_000, 60_000, 1);
    // delete/refund blocked
    assert!(matches!(
        process_sync_batch(
            &conn,
            "t1",
            "b1",
            "u1",
            &[chg("supplier_credits", "cred-1", "delete", json!({}))],
            "t"
        ),
        Err(BatchError::ProtectedCreditDeleteRefund(_))
    ));
    // used_amount change blocked
    assert!(matches!(
        process_sync_batch(
            &conn,
            "t1",
            "b1",
            "u1",
            &[chg(
                "supplier_credits",
                "cred-1",
                "update",
                json!({"id":"cred-1","used_amount":50.0})
            )],
            "t"
        ),
        Err(BatchError::ProtectedCreditPayment(_))
    ));
    // supplier change blocked
    assert!(matches!(
        process_sync_batch(
            &conn,
            "t1",
            "b1",
            "u1",
            &[chg(
                "supplier_credits",
                "cred-1",
                "update",
                json!({"id":"cred-1","supplier_id":"OTHER"})
            )],
            "t"
        ),
        Err(BatchError::SupplierChangeLocked(_))
    ));
    // note-only allowed, no revision bump
    process_sync_batch(
        &conn,
        "t1",
        "b1",
        "u1",
        &[chg(
            "supplier_credits",
            "cred-1",
            "update",
            json!({"id":"cred-1","note":"hello"}),
        )],
        "t",
    )
    .unwrap();
    assert_eq!(agg_rev(&conn, "SUPPLIER_CREDIT_BALANCE", "cred-1"), 1);
}

// ── schema strictness ──

#[test]
fn unknown_field_and_branch_contradiction_rejected() {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    seed_exp_proj(&conn, "exp-1", "sup-1", 100_000, 0, 60_000, 1);
    assert!(matches!(
        process_sync_batch(
            &conn,
            "t1",
            "b1",
            "u1",
            &[chg(
                "expenses",
                "exp-1",
                "update",
                json!({"id":"exp-1","totally_unknown":1})
            )],
            "t"
        ),
        Err(BatchError::UnknownField(_))
    ));
    assert!(matches!(
        process_sync_batch(
            &conn,
            "t1",
            "b1",
            "u1",
            &[chg(
                "expenses",
                "exp-1",
                "update",
                json!({"id":"exp-1","branch_id":"b2","paid_amount":0.0})
            )],
            "t"
        ),
        Err(BatchError::TenantBranchContradiction(_))
    ));
}

#[test]
fn settlement_overpayment_rejected() {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    seed_exp_proj(&conn, "exp-1", "sup-1", 100_000, 0, 60_000, 1);
    // cash 50 → settled 50+60 = 110 > 100
    let r = process_sync_batch(
        &conn,
        "t1",
        "b1",
        "u1",
        &[
            chg(
                "expenses",
                "exp-1",
                "update",
                json!({"id":"exp-1","paid_amount":50.0}),
            ),
            chg(
                "expense_payments",
                "pay-1",
                "insert",
                json!({"id":"pay-1","expense_id":"exp-1","amount":50.0,"method":"cash"}),
            ),
        ],
        "t",
    );
    assert!(
        matches!(r, Err(BatchError::SettlementOverpayment(_))),
        "{:?}",
        r
    );
}

// ── revision independence + atomic batch ──

#[test]
fn independent_aggregates_independent_revisions() {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    seed_exp_proj(&conn, "exp-1", "sup-1", 100_000, 0, 0, 1);
    seed_exp_proj(&conn, "exp-2", "sup-1", 100_000, 0, 0, 1);
    // fold a cash payment on exp-1 only
    process_sync_batch(
        &conn,
        "t1",
        "b1",
        "u1",
        &[
            chg(
                "expenses",
                "exp-1",
                "update",
                json!({"id":"exp-1","paid_amount":30.0}),
            ),
            chg(
                "expense_payments",
                "p1",
                "insert",
                json!({"id":"p1","expense_id":"exp-1","amount":30.0,"method":"cash"}),
            ),
        ],
        "t",
    )
    .unwrap();
    assert_eq!(agg_rev(&conn, "EXPENSE_SETTLEMENT", "exp-1"), 2);
    assert_eq!(agg_rev(&conn, "EXPENSE_SETTLEMENT", "exp-2"), 1); // untouched
}

#[test]
fn multiple_changes_same_expense_bump_once() {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    seed_exp_proj(&conn, "exp-1", "sup-1", 100_000, 0, 0, 1);
    process_sync_batch(
        &conn,
        "t1",
        "b1",
        "u1",
        &[
            chg(
                "expenses",
                "exp-1",
                "update",
                json!({"id":"exp-1","paid_amount":50.0}),
            ),
            chg(
                "expense_payments",
                "p1",
                "insert",
                json!({"id":"p1","expense_id":"exp-1","amount":30.0,"method":"cash"}),
            ),
            chg(
                "expense_payments",
                "p2",
                "insert",
                json!({"id":"p2","expense_id":"exp-1","amount":20.0,"method":"bank"}),
            ),
        ],
        "t",
    )
    .unwrap();
    assert_eq!(agg_rev(&conn, "EXPENSE_SETTLEMENT", "exp-1"), 2); // exactly +1
    assert_eq!(exp_proj(&conn, "exp-1")["nonCreditPaidFils"], json!(50_000));
}

#[test]
fn forbidden_change_rolls_back_whole_batch() {
    for order in [0, 1] {
        let conn = Connection::open_in_memory().unwrap();
        setup(&conn);
        seed_exp_proj(&conn, "exp-1", "sup-1", 100_000, 0, 60_000, 1);
        let normal = chg("products", "p1", "update", json!({"id":"p1","name":"x"}));
        let forbidden = chg("expenses", "exp-1", "delete", json!({}));
        let batch = if order == 0 {
            vec![normal, forbidden]
        } else {
            vec![forbidden, normal]
        };
        let r = process_sync_batch(&conn, "t1", "b1", "u1", &batch, "t");
        assert!(r.is_err(), "order {order}");
        // nothing committed: no changelog row at all, revision unchanged
        assert_eq!(cl_count(&conn), 0, "order {order}");
        assert_eq!(
            agg_rev(&conn, "EXPENSE_SETTLEMENT", "exp-1"),
            1,
            "order {order}"
        );
    }
}

// ── real two-connection parallelism: no mixed state ──

#[test]
fn parallel_batches_no_mixed_state() {
    let dir = std::env::temp_dir();
    let path = dir.join(format!("b0_batch_{}.sqlite", std::process::id()));
    let _ = std::fs::remove_file(&path);
    {
        let c = Connection::open(&path).unwrap();
        c.execute_batch("PRAGMA journal_mode=WAL;").unwrap();
        setup(&c);
        seed_exp_proj(&c, "exp-1", "sup-1", 100_000, 0, 0, 1);
    }
    let mk = || {
        let c = Connection::open(&path).unwrap();
        c.busy_timeout(std::time::Duration::from_secs(10)).unwrap();
        c.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        c
    };
    let p1 = path.clone();
    let p2 = path.clone();
    let t1 = std::thread::spawn(move || {
        let c = Connection::open(&p1).unwrap();
        c.busy_timeout(std::time::Duration::from_secs(10)).unwrap();
        c.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        process_sync_batch(
            &c,
            "t1",
            "b1",
            "u1",
            &[
                chg(
                    "expenses",
                    "exp-1",
                    "update",
                    json!({"id":"exp-1","paid_amount":40.0}),
                ),
                chg(
                    "expense_payments",
                    "pa",
                    "insert",
                    json!({"id":"pa","expense_id":"exp-1","amount":40.0,"method":"cash"}),
                ),
            ],
            "t",
        )
    });
    let t2 = std::thread::spawn(move || {
        let c = Connection::open(&p2).unwrap();
        c.busy_timeout(std::time::Duration::from_secs(10)).unwrap();
        c.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        process_sync_batch(
            &c,
            "t1",
            "b1",
            "u1",
            &[
                chg(
                    "expenses",
                    "exp-1",
                    "update",
                    json!({"id":"exp-1","paid_amount":30.0}),
                ),
                chg(
                    "expense_payments",
                    "pb",
                    "insert",
                    json!({"id":"pb","expense_id":"exp-1","amount":30.0,"method":"cash"}),
                ),
            ],
            "t",
        )
    });
    let _ = t1.join().unwrap();
    let _ = t2.join().unwrap();
    let verify = mk();
    // exactly one of the two batches won; the projection equals its own consistent state
    let p = exp_proj(&verify, "exp-1");
    let ncp = p["nonCreditPaidFils"].as_i64().unwrap();
    assert!(ncp == 40_000 || ncp == 30_000, "mixed state: {ncp}");
    // the changelog holds exactly that winner's expense + payment (2 rows)
    assert_eq!(cl_count(&verify), 2);
    drop(verify);
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
    let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
}
