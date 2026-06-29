//! B1 server-side tests for `APPLY_SUPPLIER_CREDIT_TO_EXPENSES`, re-aligned to
//! the B0 foundation: lazy cutover from the **branch-isolated** `sync_changelog`,
//! per-aggregate revision CAS (`SUPPLIER_CREDIT_BALANCE` / `EXPENSE_SETTLEMENT`),
//! atomic accept/conflict/validation, idempotency + reuse, exact-fils money,
//! balanced authoritative ledger, B0-bridge protection after cutover, legacy-vs-
//! B1 races, a real two-connection race, full-rollback failure injection, and
//! multi-expense distribution.

use super::*;
use crate::models::Claims;
use rusqlite::{params, Connection};
use serde_json::{json, Value};

const TS: &str = "2026-01-15T10:30:00.000Z";

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

fn claims(tenant: &str, branch: &str, user: &str) -> Claims {
    Claims {
        sub: user.to_string(),
        tenant_id: tenant.to_string(),
        branch_id: branch.to_string(),
        role: "owner".to_string(),
        exp: 9999999999,
    }
}

/// A valid canonical UUID that varies by `n` (the first hex group).
fn op_uuid(n: u32) -> String {
    format!("{:08x}-aaaa-5aaa-8aaa-aaaaaaaaaaaa", n)
}

/// Seed a legacy `supplier_credits` snapshot in the branch-isolated changelog.
fn seed_credit(
    conn: &Connection,
    tenant: &str,
    branch: &str,
    cid: &str,
    supplier: &str,
    amount: f64,
    used: f64,
) {
    push(
        conn,
        tenant,
        branch,
        "supplier_credits",
        cid,
        "insert",
        json!({"id": cid, "branch_id": branch, "supplier_id": supplier, "amount": amount, "used_amount": used, "status": "OPEN"}),
    );
}

/// Seed a legacy `expenses` snapshot (paid_amount is the non-credit total).
fn seed_expense(
    conn: &Connection,
    tenant: &str,
    branch: &str,
    eid: &str,
    supplier: &str,
    amount: f64,
    paid: f64,
) {
    push(
        conn,
        tenant,
        branch,
        "expenses",
        eid,
        "insert",
        json!({"id": eid, "branch_id": branch, "supplier_id": supplier, "amount": amount, "paid_amount": paid, "status": "PENDING"}),
    );
}

/// Seed a legacy method='credit' payment (counts toward cut-over credit_paid).
fn seed_credit_payment(
    conn: &Connection,
    tenant: &str,
    branch: &str,
    pid: &str,
    eid: &str,
    cid: &str,
    amount: f64,
) {
    push(
        conn,
        tenant,
        branch,
        "expense_payments",
        pid,
        "insert",
        json!({"id": pid, "expense_id": eid, "reference": cid, "amount": amount, "method": "credit"}),
    );
}

fn push(
    conn: &Connection,
    tenant: &str,
    branch: &str,
    table: &str,
    rid: &str,
    action: &str,
    data: Value,
) {
    conn.execute(
        "INSERT INTO sync_changelog (tenant_id, branch_id, table_name, record_id, action, data, user_id, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,'u1','t')",
        params![tenant, branch, table, rid, action, data.to_string()],
    )
    .unwrap();
}

/// Build a settlement payload (one credit, N allocations). Fils/Revision values
/// are canonical i64 strings (protocol v4 wire convention).
fn payload(
    op_id: &str,
    branch: &str,
    credit_id: &str,
    exp_credit_rev: i64,
    allocs: &[(&str, i64, i64)],
) -> Value {
    json!({
        "protocolVersion": 4,
        "operationType": "APPLY_SUPPLIER_CREDIT_TO_EXPENSES",
        "operationId": op_id,
        "businessTimestamp": TS,
        "branchId": branch,
        "creditId": credit_id,
        "expectedCreditRevision": exp_credit_rev.to_string(),
        "allocations": allocs.iter().map(|(eid, amt, erev)| json!({
            "expenseId": eid, "amountFils": amt.to_string(), "expectedExpenseRevision": erev.to_string()
        })).collect::<Vec<_>>(),
    })
}

fn agg_rev(conn: &Connection, agg_type: &str, agg_id: &str) -> i64 {
    conn.query_row(
        "SELECT revision FROM aggregate_revisions WHERE aggregate_type=?1 AND aggregate_id=?2",
        params![agg_type, agg_id],
        |r| r.get(0),
    )
    .unwrap()
}

fn proj(conn: &Connection, table: &str, rid: &str) -> Value {
    let d: String = conn
        .query_row(
            "SELECT data_json FROM canonical_records WHERE table_name=?1 AND record_id=?2",
            params![table, rid],
            |r| r.get(0),
        )
        .unwrap();
    serde_json::from_str(&d).unwrap()
}

fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |r| r.get(0)).unwrap()
}

/// Σ debit fils, Σ credit fils over the authoritative ledger.
fn ledger_balance(conn: &Connection) -> (i64, i64) {
    let d: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(amount_fils),0) FROM auth_ledger_entries WHERE direction='DEBIT'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let c: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(amount_fils),0) FROM auth_ledger_entries WHERE direction='CREDIT'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    (d, c)
}

// ────────────────────────────── accept paths ──────────────────────────────

#[test]
fn accept_single_expense_cutover_from_changelog() {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    seed_credit(&conn, "t1", "b1", "cred-1", "sup-1", 100.0, 0.0);
    seed_expense(&conn, "t1", "b1", "exp-1", "sup-1", 100.0, 0.0);

    let d = submit(
        &conn,
        &claims("t1", "b1", "u1"),
        &payload(&op_uuid(1), "b1", "cred-1", 0, &[("exp-1", 60_000, 0)]),
        TS,
    );
    assert!(matches!(d, Decision::Accepted { .. }), "{d:?}");

    // credit projection: used 60, available 40, OPEN, revision 1
    let cp = proj(&conn, "supplier_credits", "cred-1");
    assert_eq!(cp["usedAmountFils"], json!(60_000));
    assert_eq!(cp["availableAmountFils"], json!(40_000));
    assert_eq!(cp["status"], json!("OPEN"));
    assert_eq!(agg_rev(&conn, "SUPPLIER_CREDIT_BALANCE", "cred-1"), 1);

    // expense projection: creditPaid 60, settled 60, open 40, PENDING, revision 1
    let ep = proj(&conn, "expenses", "exp-1");
    assert_eq!(ep["creditPaidFils"], json!(60_000));
    assert_eq!(ep["settledFils"], json!(60_000));
    assert_eq!(ep["openFils"], json!(40_000));
    assert_eq!(ep["status"], json!("PENDING"));
    assert_eq!(agg_rev(&conn, "EXPENSE_SETTLEMENT", "exp-1"), 1);

    // balanced ledger DR AP 60 / CR SUPPLIER_CREDIT 60
    assert_eq!(ledger_balance(&conn), (60_000, 60_000));
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM operation_envelopes"), 1);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM operation_sequence"), 1);
    // 1 credit + 1 expense + 1 payment mutation = 3
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM operation_mutations"), 3);
}

#[test]
fn accept_full_settlement_marks_paid_and_used() {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    seed_credit(&conn, "t1", "b1", "cred-1", "sup-1", 60.0, 0.0);
    seed_expense(&conn, "t1", "b1", "exp-1", "sup-1", 60.0, 0.0);

    let d = submit(
        &conn,
        &claims("t1", "b1", "u1"),
        &payload(&op_uuid(1), "b1", "cred-1", 0, &[("exp-1", 60_000, 0)]),
        TS,
    );
    assert!(matches!(d, Decision::Accepted { .. }), "{d:?}");
    assert_eq!(proj(&conn, "expenses", "exp-1")["status"], json!("PAID"));
    assert_eq!(
        proj(&conn, "supplier_credits", "cred-1")["status"],
        json!("USED")
    );
}

#[test]
fn multi_expense_distribution_one_balanced_ledger() {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    seed_credit(&conn, "t1", "b1", "cred-1", "sup-1", 100.0, 0.0);
    seed_expense(&conn, "t1", "b1", "exp-1", "sup-1", 60.0, 0.0);
    seed_expense(&conn, "t1", "b1", "exp-2", "sup-1", 50.0, 0.0);

    let d = submit(
        &conn,
        &claims("t1", "b1", "u1"),
        &payload(
            &op_uuid(1),
            "b1",
            "cred-1",
            0,
            &[("exp-1", 60_000, 0), ("exp-2", 40_000, 0)],
        ),
        TS,
    );
    assert!(matches!(d, Decision::Accepted { .. }), "{d:?}");

    assert_eq!(
        proj(&conn, "supplier_credits", "cred-1")["usedAmountFils"],
        json!(100_000)
    );
    assert_eq!(agg_rev(&conn, "EXPENSE_SETTLEMENT", "exp-1"), 1);
    assert_eq!(agg_rev(&conn, "EXPENSE_SETTLEMENT", "exp-2"), 1);
    // total 100 across two legs, balanced
    assert_eq!(ledger_balance(&conn), (100_000, 100_000));
    // 1 credit + 2 expenses + 2 payments = 5 mutations
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM operation_mutations"), 5);
}

#[test]
fn cutover_sums_existing_credit_payments() {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    seed_credit(&conn, "t1", "b1", "cred-2", "sup-1", 100.0, 30.0);
    seed_expense(&conn, "t1", "b1", "exp-1", "sup-1", 100.0, 0.0);
    // a pre-existing legacy credit-payment of 30 already settled part of exp-1
    seed_credit_payment(&conn, "t1", "b1", "pay-old", "exp-1", "cred-2", 30.0);

    // open = 100 - (0 cash + 30 credit) = 70; apply 50 → ok
    let d = submit(
        &conn,
        &claims("t1", "b1", "u1"),
        &payload(&op_uuid(1), "b1", "cred-2", 0, &[("exp-1", 50_000, 0)]),
        TS,
    );
    assert!(matches!(d, Decision::Accepted { .. }), "{d:?}");
    let ep = proj(&conn, "expenses", "exp-1");
    assert_eq!(ep["creditPaidFils"], json!(80_000)); // 30 existing + 50 new
    assert_eq!(ep["settledFils"], json!(80_000));
    assert_eq!(ep["openFils"], json!(20_000));
}

// ───────────────────────── per-aggregate revision model ─────────────────────────

#[test]
fn same_credit_on_different_expenses_independent_revisions() {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    seed_credit(&conn, "t1", "b1", "cred-1", "sup-1", 100.0, 0.0);
    seed_expense(&conn, "t1", "b1", "exp-1", "sup-1", 100.0, 0.0);
    seed_expense(&conn, "t1", "b1", "exp-2", "sup-1", 100.0, 0.0);

    let c = claims("t1", "b1", "u1");
    assert!(matches!(
        submit(
            &conn,
            &c,
            &payload(&op_uuid(1), "b1", "cred-1", 0, &[("exp-1", 30_000, 0)]),
            TS
        ),
        Decision::Accepted { .. }
    ));
    // credit revision now 1 → op2 must expect 1; exp-2 still at 0
    assert!(matches!(
        submit(
            &conn,
            &c,
            &payload(&op_uuid(2), "b1", "cred-1", 1, &[("exp-2", 30_000, 0)]),
            TS
        ),
        Decision::Accepted { .. }
    ));

    assert_eq!(agg_rev(&conn, "SUPPLIER_CREDIT_BALANCE", "cred-1"), 2);
    assert_eq!(agg_rev(&conn, "EXPENSE_SETTLEMENT", "exp-1"), 1);
    assert_eq!(agg_rev(&conn, "EXPENSE_SETTLEMENT", "exp-2"), 1);
    assert_eq!(
        proj(&conn, "supplier_credits", "cred-1")["usedAmountFils"],
        json!(60_000)
    );
}

#[test]
fn different_credits_same_expense_independent_revisions() {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    seed_credit(&conn, "t1", "b1", "cred-1", "sup-1", 100.0, 0.0);
    seed_credit(&conn, "t1", "b1", "cred-2", "sup-1", 100.0, 0.0);
    seed_expense(&conn, "t1", "b1", "exp-1", "sup-1", 100.0, 0.0);

    let c = claims("t1", "b1", "u1");
    assert!(matches!(
        submit(
            &conn,
            &c,
            &payload(&op_uuid(1), "b1", "cred-1", 0, &[("exp-1", 30_000, 0)]),
            TS
        ),
        Decision::Accepted { .. }
    ));
    // expense revision now 1 → op2 (different credit) must expect 1
    assert!(matches!(
        submit(
            &conn,
            &c,
            &payload(&op_uuid(2), "b1", "cred-2", 0, &[("exp-1", 40_000, 1)]),
            TS
        ),
        Decision::Accepted { .. }
    ));

    assert_eq!(agg_rev(&conn, "EXPENSE_SETTLEMENT", "exp-1"), 2);
    assert_eq!(agg_rev(&conn, "SUPPLIER_CREDIT_BALANCE", "cred-1"), 1);
    assert_eq!(agg_rev(&conn, "SUPPLIER_CREDIT_BALANCE", "cred-2"), 1);
    assert_eq!(
        proj(&conn, "expenses", "exp-1")["creditPaidFils"],
        json!(70_000)
    );
}

#[test]
fn independent_credits_and_expenses_no_false_conflict() {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    seed_credit(&conn, "t1", "b1", "cred-1", "sup-1", 50.0, 0.0);
    seed_credit(&conn, "t1", "b1", "cred-2", "sup-1", 50.0, 0.0);
    seed_expense(&conn, "t1", "b1", "exp-1", "sup-1", 50.0, 0.0);
    seed_expense(&conn, "t1", "b1", "exp-2", "sup-1", 50.0, 0.0);

    let c = claims("t1", "b1", "u1");
    // two fully independent operations, both expecting fresh revisions 0/0
    assert!(matches!(
        submit(
            &conn,
            &c,
            &payload(&op_uuid(1), "b1", "cred-1", 0, &[("exp-1", 20_000, 0)]),
            TS
        ),
        Decision::Accepted { .. }
    ));
    assert!(matches!(
        submit(
            &conn,
            &c,
            &payload(&op_uuid(2), "b1", "cred-2", 0, &[("exp-2", 20_000, 0)]),
            TS
        ),
        Decision::Accepted { .. }
    ));
}

#[test]
fn partial_overlap_multi_expense_mixed_revisions() {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    seed_credit(&conn, "t1", "b1", "cred-1", "sup-1", 100.0, 0.0);
    for e in ["exp-1", "exp-2", "exp-3"] {
        seed_expense(&conn, "t1", "b1", e, "sup-1", 100.0, 0.0);
    }
    let c = claims("t1", "b1", "u1");
    // op1: {exp-1, exp-2} → both go to rev 1, credit rev 1
    assert!(matches!(
        submit(
            &conn,
            &c,
            &payload(
                &op_uuid(1),
                "b1",
                "cred-1",
                0,
                &[("exp-1", 10_000, 0), ("exp-2", 10_000, 0)]
            ),
            TS
        ),
        Decision::Accepted { .. }
    ));
    // op2: {exp-2 (rev 1 now), exp-3 (rev 0)}; credit rev 1
    assert!(matches!(
        submit(
            &conn,
            &c,
            &payload(
                &op_uuid(2),
                "b1",
                "cred-1",
                1,
                &[("exp-2", 10_000, 1), ("exp-3", 10_000, 0)]
            ),
            TS
        ),
        Decision::Accepted { .. }
    ));
    assert_eq!(agg_rev(&conn, "EXPENSE_SETTLEMENT", "exp-2"), 2);
    assert_eq!(agg_rev(&conn, "EXPENSE_SETTLEMENT", "exp-3"), 1);
    assert_eq!(agg_rev(&conn, "SUPPLIER_CREDIT_BALANCE", "cred-1"), 2);
}

// ───────────────────────────── conflicts ─────────────────────────────

#[test]
fn stale_credit_revision_is_conflict_no_writes() {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    seed_credit(&conn, "t1", "b1", "cred-1", "sup-1", 100.0, 0.0);
    seed_expense(&conn, "t1", "b1", "exp-1", "sup-1", 100.0, 0.0);

    let d = submit(
        &conn,
        &claims("t1", "b1", "u1"),
        &payload(&op_uuid(1), "b1", "cred-1", 5, &[("exp-1", 10_000, 0)]),
        TS,
    );
    match d {
        Decision::Conflict { error_code, result } => {
            assert_eq!(error_code, "STALE_REVISION");
            assert_eq!(result["aggregate"], json!("SUPPLIER_CREDIT_BALANCE"));
        }
        other => panic!("{other:?}"),
    }
    // no projection / revision / ledger created
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM canonical_records"), 0);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM aggregate_revisions"), 0);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM auth_ledger_entries"), 0);
    // exactly the stored conflict row, no sequence/envelope
    assert_eq!(
        count(
            &conn,
            "SELECT COUNT(*) FROM operations WHERE status='conflict'"
        ),
        1
    );
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM operation_sequence"), 0);
}

#[test]
fn stale_single_expense_revision_rolls_back_whole_op() {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    seed_credit(&conn, "t1", "b1", "cred-1", "sup-1", 100.0, 0.0);
    seed_expense(&conn, "t1", "b1", "exp-1", "sup-1", 100.0, 0.0);
    seed_expense(&conn, "t1", "b1", "exp-2", "sup-1", 100.0, 0.0);

    // exp-1 expects 0 (correct), exp-2 expects 7 (wrong) → whole op conflict
    let d = submit(
        &conn,
        &claims("t1", "b1", "u1"),
        &payload(
            &op_uuid(1),
            "b1",
            "cred-1",
            0,
            &[("exp-1", 10_000, 0), ("exp-2", 10_000, 7)],
        ),
        TS,
    );
    match d {
        Decision::Conflict { error_code, result } => {
            assert_eq!(error_code, "STALE_REVISION");
            assert_eq!(result["expenseId"], json!("exp-2"));
        }
        other => panic!("{other:?}"),
    }
    // nothing materialised — not even exp-1 (whole-op rollback)
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM canonical_records"), 0);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM aggregate_revisions"), 0);
}

#[test]
fn credit_overdrawn_is_conflict() {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    seed_credit(&conn, "t1", "b1", "cred-1", "sup-1", 50.0, 0.0);
    seed_expense(&conn, "t1", "b1", "exp-1", "sup-1", 100.0, 0.0);
    let d = submit(
        &conn,
        &claims("t1", "b1", "u1"),
        &payload(&op_uuid(1), "b1", "cred-1", 0, &[("exp-1", 60_000, 0)]),
        TS,
    );
    assert!(
        matches!(d, Decision::Conflict { ref error_code, .. } if error_code == "CREDIT_OVERDRAWN"),
        "{d:?}"
    );
}

#[test]
fn expense_overpaid_is_conflict() {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    seed_credit(&conn, "t1", "b1", "cred-1", "sup-1", 100.0, 0.0);
    seed_expense(&conn, "t1", "b1", "exp-1", "sup-1", 100.0, 70.0); // open 30
    let d = submit(
        &conn,
        &claims("t1", "b1", "u1"),
        &payload(&op_uuid(1), "b1", "cred-1", 0, &[("exp-1", 60_000, 0)]),
        TS,
    );
    assert!(
        matches!(d, Decision::Conflict { ref error_code, .. } if error_code == "EXPENSE_OVERPAID"),
        "{d:?}"
    );
}

#[test]
fn already_settled_expense_is_conflict() {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    seed_credit(&conn, "t1", "b1", "cred-1", "sup-1", 100.0, 0.0);
    seed_expense(&conn, "t1", "b1", "exp-1", "sup-1", 100.0, 100.0); // open 0
    let d = submit(
        &conn,
        &claims("t1", "b1", "u1"),
        &payload(&op_uuid(1), "b1", "cred-1", 0, &[("exp-1", 10_000, 0)]),
        TS,
    );
    assert!(
        matches!(d, Decision::Conflict { ref error_code, .. } if error_code == "EXPENSE_ALREADY_SETTLED"),
        "{d:?}"
    );
}

#[test]
fn supplier_mismatch_is_conflict() {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    seed_credit(&conn, "t1", "b1", "cred-1", "sup-1", 100.0, 0.0);
    seed_expense(&conn, "t1", "b1", "exp-1", "sup-2", 100.0, 0.0); // different supplier
    let d = submit(
        &conn,
        &claims("t1", "b1", "u1"),
        &payload(&op_uuid(1), "b1", "cred-1", 0, &[("exp-1", 10_000, 0)]),
        TS,
    );
    assert!(
        matches!(d, Decision::Conflict { ref error_code, .. } if error_code == "SUPPLIER_OR_BRANCH_MISMATCH"),
        "{d:?}"
    );
}

// ───────────────────────── static validation ─────────────────────────

#[test]
fn branch_mismatch_is_validation_rejected() {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    // claims branch b1, payload branch b2
    let d = submit(
        &conn,
        &claims("t1", "b1", "u1"),
        &payload(&op_uuid(1), "b2", "cred-1", 0, &[("exp-1", 10_000, 0)]),
        TS,
    );
    assert!(
        matches!(d, Decision::ValidationRejected { ref error_code, .. } if error_code == "BRANCH_MISMATCH"),
        "{d:?}"
    );
}

#[test]
fn non_positive_amount_is_validation_rejected() {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    let d = submit(
        &conn,
        &claims("t1", "b1", "u1"),
        &payload(&op_uuid(1), "b1", "cred-1", 0, &[("exp-1", 0, 0)]),
        TS,
    );
    assert!(
        matches!(d, Decision::ValidationRejected { ref error_code, .. } if error_code == "INVALID_AMOUNT"),
        "{d:?}"
    );
}

#[test]
fn duplicate_allocation_is_validation_rejected() {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    seed_credit(&conn, "t1", "b1", "cred-1", "sup-1", 100.0, 0.0);
    seed_expense(&conn, "t1", "b1", "exp-1", "sup-1", 100.0, 0.0);
    let d = submit(
        &conn,
        &claims("t1", "b1", "u1"),
        &payload(
            &op_uuid(1),
            "b1",
            "cred-1",
            0,
            &[("exp-1", 10_000, 0), ("exp-1", 20_000, 0)],
        ),
        TS,
    );
    assert!(
        matches!(d, Decision::ValidationRejected { ref error_code, .. } if error_code == "DUPLICATE_ALLOCATION_KEY"),
        "{d:?}"
    );
}

#[test]
fn malformed_wire_payload_is_validation_rejected() {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    // amountFils as a JSON number (not the required i64 string) → wire rejection
    let mut p = payload(&op_uuid(1), "b1", "cred-1", 0, &[("exp-1", 10_000, 0)]);
    p["allocations"][0]["amountFils"] = json!(10000);
    let d = submit(&conn, &claims("t1", "b1", "u1"), &p, TS);
    assert!(matches!(d, Decision::ValidationRejected { .. }), "{d:?}");
}

#[test]
fn finance_not_bootstrapped_when_no_snapshot() {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    // no credit / expense snapshot seeded
    let d = submit(
        &conn,
        &claims("t1", "b1", "u1"),
        &payload(&op_uuid(1), "b1", "cred-1", 0, &[("exp-1", 10_000, 0)]),
        TS,
    );
    assert!(
        matches!(d, Decision::Transient { ref code } if code == "FINANCE_NOT_BOOTSTRAPPED"),
        "{d:?}"
    );
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM operations"), 0);
}

// ───────────────────────── idempotency & reuse ─────────────────────────

#[test]
fn idempotent_replay_same_id_and_hash_no_new_writes() {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    seed_credit(&conn, "t1", "b1", "cred-1", "sup-1", 100.0, 0.0);
    seed_expense(&conn, "t1", "b1", "exp-1", "sup-1", 100.0, 0.0);
    let c = claims("t1", "b1", "u1");
    let p = payload(&op_uuid(1), "b1", "cred-1", 0, &[("exp-1", 60_000, 0)]);
    assert!(matches!(
        submit(&conn, &c, &p, TS),
        Decision::Accepted { .. }
    ));

    let before_ops = count(&conn, "SELECT COUNT(*) FROM operations");
    let before_seq = count(&conn, "SELECT COUNT(*) FROM operation_sequence");
    let before_led = count(&conn, "SELECT COUNT(*) FROM auth_ledger_entries");
    let before_mut = count(&conn, "SELECT COUNT(*) FROM operation_mutations");

    let d2 = submit(&conn, &c, &p, TS);
    match d2 {
        Decision::Replay { status, .. } => assert_eq!(status, "accepted"),
        other => panic!("{other:?}"),
    }
    // no new writes; credit consumed exactly once
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM operations"), before_ops);
    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM operation_sequence"),
        before_seq
    );
    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM auth_ledger_entries"),
        before_led
    );
    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM operation_mutations"),
        before_mut
    );
    assert_eq!(
        proj(&conn, "supplier_credits", "cred-1")["usedAmountFils"],
        json!(60_000)
    );
    assert_eq!(agg_rev(&conn, "SUPPLIER_CREDIT_BALANCE", "cred-1"), 1);
}

#[test]
fn same_id_different_hash_is_operation_id_reused() {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    seed_credit(&conn, "t1", "b1", "cred-1", "sup-1", 100.0, 0.0);
    seed_expense(&conn, "t1", "b1", "exp-1", "sup-1", 100.0, 0.0);
    let c = claims("t1", "b1", "u1");
    assert!(matches!(
        submit(
            &conn,
            &c,
            &payload(&op_uuid(1), "b1", "cred-1", 0, &[("exp-1", 60_000, 0)]),
            TS
        ),
        Decision::Accepted { .. }
    ));
    // same operationId, different allocation amount → different hash
    let d2 = submit(
        &conn,
        &c,
        &payload(&op_uuid(1), "b1", "cred-1", 0, &[("exp-1", 10_000, 0)]),
        TS,
    );
    assert!(matches!(d2, Decision::OperationIdReused), "{d2:?}");
    assert_eq!(
        proj(&conn, "supplier_credits", "cred-1")["usedAmountFils"],
        json!(60_000)
    ); // unchanged
}

// ───────────────────────── isolation & status ─────────────────────────

#[test]
fn status_unknown_and_tenant_and_branch_isolated() {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    seed_credit(&conn, "t1", "b1", "cred-1", "sup-1", 100.0, 0.0);
    seed_expense(&conn, "t1", "b1", "exp-1", "sup-1", 100.0, 0.0);
    let op = op_uuid(1);
    assert!(matches!(
        submit(
            &conn,
            &claims("t1", "b1", "u1"),
            &payload(&op, "b1", "cred-1", 0, &[("exp-1", 60_000, 0)]),
            TS
        ),
        Decision::Accepted { .. }
    ));
    // unknown id → unknown
    assert_eq!(
        get_status(&conn, "t1", "b1", &op_uuid(9)).unwrap()["status"],
        json!("unknown")
    );
    // wrong tenant → unknown
    assert_eq!(
        get_status(&conn, "t2", "b3", &op).unwrap()["status"],
        json!("unknown")
    );
    // wrong branch, same tenant → unknown (branch-isolated)
    assert_eq!(
        get_status(&conn, "t1", "b2", &op).unwrap()["status"],
        json!("unknown")
    );
    // own tenant+branch → the full accepted status
    let s = get_status(&conn, "t1", "b1", &op).unwrap();
    assert_eq!(s["status"], json!("accepted"));
    assert!(s["serverSequence"].is_string());
    assert!(s["envelope"]["mutations"].is_array());
}

#[test]
fn status_reports_conflict_and_validation() {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    seed_credit(&conn, "t1", "b1", "cred-1", "sup-1", 100.0, 0.0);
    seed_expense(&conn, "t1", "b1", "exp-1", "sup-1", 100.0, 0.0);
    let c = claims("t1", "b1", "u1");

    let oc = op_uuid(2);
    assert!(matches!(
        submit(
            &conn,
            &c,
            &payload(&oc, "b1", "cred-1", 9, &[("exp-1", 10_000, 0)]),
            TS
        ),
        Decision::Conflict { .. }
    ));
    assert_eq!(
        get_status(&conn, "t1", "b1", &oc).unwrap()["status"],
        json!("conflict")
    );

    // an in-tx static rejection (amount 0) is stored → replayable / queryable
    let ov = op_uuid(3);
    assert!(matches!(
        submit(
            &conn,
            &c,
            &payload(&ov, "b1", "cred-1", 0, &[("exp-1", 0, 0)]),
            TS
        ),
        Decision::ValidationRejected { .. }
    ));
    assert_eq!(
        get_status(&conn, "t1", "b1", &ov).unwrap()["status"],
        json!("validation_rejected")
    );
}

#[test]
fn status_unchanged_after_replay_and_reuse_no_reexecution() {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    seed_credit(&conn, "t1", "b1", "cred-1", "sup-1", 100.0, 0.0);
    seed_expense(&conn, "t1", "b1", "exp-1", "sup-1", 100.0, 0.0);
    let c = claims("t1", "b1", "u1");
    let op = op_uuid(1);
    assert!(matches!(
        submit(
            &conn,
            &c,
            &payload(&op, "b1", "cred-1", 0, &[("exp-1", 60_000, 0)]),
            TS
        ),
        Decision::Accepted { .. }
    ));
    // snapshot the stored final state + all authoritative counters
    let status0 = get_status(&conn, "t1", "b1", &op).unwrap();
    let seq0 = status0["serverSequence"].clone();
    let snap = |c: &Connection| {
        (
            count(c, "SELECT COUNT(*) FROM operations"),
            count(c, "SELECT COUNT(*) FROM operation_sequence"),
            count(c, "SELECT COUNT(*) FROM operation_envelopes"),
            count(c, "SELECT COUNT(*) FROM operation_mutations"),
            count(c, "SELECT COUNT(*) FROM auth_ledger_entries"),
            count(c, "SELECT COALESCE(SUM(revision),0) FROM aggregate_revisions"),
            count(c, "SELECT COALESCE(SUM(used_amount_fils),-1) FROM (SELECT json_extract(data_json,'$.usedAmountFils') AS used_amount_fils FROM canonical_records WHERE table_name='supplier_credits')"),
        )
    };
    let before = snap(&conn);

    // GET status repeatedly → never re-executes, never changes anything
    for _ in 0..3 {
        let s = get_status(&conn, "t1", "b1", &op).unwrap();
        assert_eq!(s["status"], json!("accepted"));
        assert_eq!(s["serverSequence"], seq0);
    }
    assert_eq!(snap(&conn), before, "GET re-executed / mutated state");

    // replay (same id+hash) is a submit decision; the stored status stays accepted
    assert!(matches!(
        submit(
            &conn,
            &c,
            &payload(&op, "b1", "cred-1", 0, &[("exp-1", 60_000, 0)]),
            TS
        ),
        Decision::Replay { .. }
    ));
    assert_eq!(
        get_status(&conn, "t1", "b1", &op).unwrap()["status"],
        json!("accepted")
    );
    assert_eq!(snap(&conn), before, "replay changed authoritative state");

    // reuse (same id, different hash) → OPERATION_ID_REUSED; stored status NOT overwritten
    assert!(matches!(
        submit(
            &conn,
            &c,
            &payload(&op, "b1", "cred-1", 0, &[("exp-1", 10_000, 0)]),
            TS
        ),
        Decision::OperationIdReused
    ));
    let s = get_status(&conn, "t1", "b1", &op).unwrap();
    assert_eq!(s["status"], json!("accepted")); // original final decision preserved
    assert_eq!(s["serverSequence"], seq0);
    assert_eq!(snap(&conn), before, "reuse overwrote the stored operation");
}

// ───────────────────────── B0 bridge after cutover (Section 14) ─────────────────────────

/// A legacy change tuple for the B0 bridge.
fn chg(table: &str, rid: &str, action: &str, data: Value) -> crate::models::SyncPushChange {
    crate::models::SyncPushChange {
        table_name: table.to_string(),
        record_id: rid.to_string(),
        action: action.to_string(),
        data: data.to_string(),
    }
}

fn accept_one(conn: &Connection) {
    seed_credit(conn, "t1", "b1", "cred-1", "sup-1", 100.0, 0.0);
    seed_expense(conn, "t1", "b1", "exp-1", "sup-1", 100.0, 0.0);
    assert!(matches!(
        submit(
            conn,
            &claims("t1", "b1", "u1"),
            &payload(&op_uuid(1), "b1", "cred-1", 0, &[("exp-1", 60_000, 0)]),
            TS
        ),
        Decision::Accepted { .. }
    ));
}

#[test]
fn bridge_blocks_legacy_credit_payment_after_accept() {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    accept_one(&conn);
    // a direct legacy credit-payment on the now-protected expense/credit → blocked
    let r = crate::authoritative_sync::bridge::process_sync_batch(
        &conn,
        "t1",
        "b1",
        "u1",
        &[chg(
            "expense_payments",
            "px",
            "insert",
            json!({"id":"px","expense_id":"exp-1","reference":"cred-1","amount":10.0,"method":"credit"}),
        )],
        "t",
    );
    assert_eq!(r.unwrap_err().code(), "B0_PROTECTED_CREDIT_PAYMENT");
}

#[test]
fn bridge_folds_cash_after_accept_no_double_count() {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    accept_one(&conn); // creditPaid 60, open 40, EXPENSE_SETTLEMENT rev 1
                       // a legacy cash payment of 40 folds into the protected expense
    let r = crate::authoritative_sync::bridge::process_sync_batch(
        &conn,
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
                "pc",
                "insert",
                json!({"id":"pc","expense_id":"exp-1","amount":40.0,"method":"cash"}),
            ),
        ],
        "t",
    );
    assert!(r.is_ok());
    let ep = proj(&conn, "expenses", "exp-1");
    // settled = 40 cash + 60 credit = 100 (NOT 140 — cash not double-counted), PAID
    assert_eq!(ep["nonCreditPaidFils"], json!(40_000));
    assert_eq!(ep["creditPaidFils"], json!(60_000));
    assert_eq!(ep["settledFils"], json!(100_000));
    assert_eq!(ep["status"], json!("PAID"));
    assert_eq!(agg_rev(&conn, "EXPENSE_SETTLEMENT", "exp-1"), 2); // fold bumped once
}

#[test]
fn bridge_allows_metadata_and_credit_note_after_accept() {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    accept_one(&conn);
    let exp_rev0 = agg_rev(&conn, "EXPENSE_SETTLEMENT", "exp-1");
    let cred_rev0 = agg_rev(&conn, "SUPPLIER_CREDIT_BALANCE", "cred-1");
    // expense metadata-only edit + credit note-only edit → allowed, no revision bump
    let r = crate::authoritative_sync::bridge::process_sync_batch(
        &conn,
        "t1",
        "b1",
        "u1",
        &[
            chg(
                "expenses",
                "exp-1",
                "update",
                json!({"id":"exp-1","description":"renamed"}),
            ),
            chg(
                "supplier_credits",
                "cred-1",
                "update",
                json!({"id":"cred-1","note":"memo"}),
            ),
        ],
        "t",
    );
    assert!(r.is_ok(), "{r:?}");
    assert_eq!(agg_rev(&conn, "EXPENSE_SETTLEMENT", "exp-1"), exp_rev0);
    assert_eq!(
        agg_rev(&conn, "SUPPLIER_CREDIT_BALANCE", "cred-1"),
        cred_rev0
    );
}

#[test]
fn bridge_blocks_expense_cancel_after_accept() {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    accept_one(&conn);
    let r = crate::authoritative_sync::bridge::process_sync_batch(
        &conn,
        "t1",
        "b1",
        "u1",
        &[chg(
            "expenses",
            "exp-1",
            "update",
            json!({"id":"exp-1","status":"CANCELLED"}),
        )],
        "t",
    );
    assert_eq!(r.unwrap_err().code(), "B0_PROTECTED_EXPENSE_CANCEL_DELETE");
}

// ───────────────────────── legacy-vs-B1 ordering (Section 15) ─────────────────────────

#[test]
fn legacy_cash_first_then_b1_reads_new_state() {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    seed_credit(&conn, "t1", "b1", "cred-1", "sup-1", 100.0, 0.0);
    seed_expense(&conn, "t1", "b1", "exp-1", "sup-1", 100.0, 0.0);
    // legacy cash fold BEFORE any cutover → plain relay into the changelog
    crate::authoritative_sync::bridge::process_sync_batch(
        &conn, "t1", "b1", "u1",
        &[
            chg("expenses", "exp-1", "update", json!({"id":"exp-1","branch_id":"b1","supplier_id":"sup-1","amount":100.0,"paid_amount":30.0})),
            chg("expense_payments", "pc", "insert", json!({"id":"pc","expense_id":"exp-1","amount":30.0,"method":"cash"})),
        ],
        "t",
    ).unwrap();
    // B1 now materialises non_credit = 30; open = 70; applying 60 succeeds
    let d = submit(
        &conn,
        &claims("t1", "b1", "u1"),
        &payload(&op_uuid(1), "b1", "cred-1", 0, &[("exp-1", 60_000, 0)]),
        TS,
    );
    assert!(matches!(d, Decision::Accepted { .. }), "{d:?}");
    let ep = proj(&conn, "expenses", "exp-1");
    assert_eq!(ep["nonCreditPaidFils"], json!(30_000));
    assert_eq!(ep["settledFils"], json!(90_000));
}

// ───────────────────────── controlled two-client race (deterministic) ─────────────────────────

/// Open a fresh shared file DB, seed credit+expense, return its path. Caller
/// must `cleanup(path)`.
fn file_db_with_seed(tag: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!("b1_{}_{}.sqlite", tag, std::process::id()));
    cleanup(&path);
    let c = Connection::open(&path).unwrap();
    c.execute_batch("PRAGMA journal_mode=WAL;").unwrap();
    setup(&c);
    seed_credit(&c, "t1", "b1", "cred-1", "sup-1", 100.0, 0.0);
    seed_expense(&c, "t1", "b1", "exp-1", "sup-1", 100.0, 0.0);
    path
}

fn open_conn(path: &std::path::Path) -> Connection {
    let c = Connection::open(path).unwrap();
    c.busy_timeout(std::time::Duration::from_secs(30)).unwrap();
    c.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
    c
}

fn cleanup(path: &std::path::Path) {
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
    let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
}

// ── genuinely concurrent coordination primitives ──

thread_local! {
    /// The loser's busy handler signals here the first time it blocks on the lock.
    static BUSY_TX: std::cell::RefCell<Option<std::sync::mpsc::Sender<()>>> =
        const { std::cell::RefCell::new(None) };
}

/// busy_handler: signal "I am blocked" (once per retry) then keep retrying — so a
/// controlled lock-wait never degrades to `DB_LOCKED`/transient.
fn busy_signal(_attempts: i32) -> bool {
    BUSY_TX.with(|s| {
        if let Some(tx) = s.borrow().as_ref() {
            let _ = tx.send(());
        }
    });
    std::thread::sleep(std::time::Duration::from_millis(2));
    true
}

/// A connection whose busy handler proves (via `tx`) that it waited on the lock.
fn open_conn_waiting(path: &std::path::Path, tx: std::sync::mpsc::Sender<()>) -> Connection {
    let c = Connection::open(path).unwrap();
    c.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
    BUSY_TX.with(|s| *s.borrow_mut() = Some(tx));
    c.busy_handler(Some(busy_signal)).unwrap();
    c
}

fn assert_loser_stale(d: &Decision) {
    match d {
        Decision::Conflict { error_code, result } => {
            assert_eq!(error_code, "STALE_REVISION");
            assert_eq!(result["currentRevision"], json!("1"));
        }
        other => panic!("loser must be a STALE_REVISION conflict (0 transient), got {other:?}"),
    }
}

/// The end state after exactly one of two same-credit/same-expense ops wins.
fn assert_single_accept_endstate(c: &Connection) {
    assert_eq!(
        proj(c, "supplier_credits", "cred-1")["usedAmountFils"],
        json!(60_000)
    ); // once
    assert_eq!(agg_rev(c, "SUPPLIER_CREDIT_BALANCE", "cred-1"), 1);
    assert_eq!(agg_rev(c, "EXPENSE_SETTLEMENT", "exp-1"), 1);
    assert_eq!(
        count(c, "SELECT COUNT(*) FROM operations WHERE status='accepted'"),
        1
    );
    assert_eq!(count(c, "SELECT COUNT(*) FROM operation_sequence"), 1);
    assert_eq!(count(c, "SELECT COUNT(*) FROM operation_envelopes"), 1);
    assert_eq!(
        count(
            c,
            "SELECT COUNT(*) FROM operation_mutations WHERE table_name='expense_payments'"
        ),
        1
    );
    assert_eq!(
        count(
            c,
            "SELECT COUNT(DISTINCT transaction_id) FROM auth_ledger_entries"
        ),
        1
    );
    assert_eq!(count(c, "SELECT COUNT(*) FROM auth_ledger_entries"), 2);
    assert_eq!(ledger_balance(c), (60_000, 60_000)); // imbalance 0
}

/// Run a genuinely concurrent two-B1 race: both threads start at a common
/// barrier; `winner_op` deterministically holds the write lock (paused at
/// `TxStarted` via the B1 hook) while `loser_op` is released only after and is
/// PROVEN to block on the same lock (its busy handler fires) before the winner
/// commits. Returns `(winner_decision, loser_decision, db_path)`.
fn concurrent_two_b1(
    tag: &str,
    winner_op: String,
    loser_op: String,
) -> (Decision, Decision, std::path::PathBuf) {
    let path = file_db_with_seed(tag);
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let (locked_tx, locked_rx) = std::sync::mpsc::channel::<()>();
    let (commit_tx, commit_rx) = std::sync::mpsc::channel::<()>();
    let (go_tx, go_rx) = std::sync::mpsc::channel::<()>();
    let (blocked_tx, blocked_rx) = std::sync::mpsc::channel::<()>();

    let pw = path.clone();
    let bw = barrier.clone();
    let winner = std::thread::spawn(move || {
        let c = open_conn(&pw);
        let pl = payload(&winner_op, "b1", "cred-1", 0, &[("exp-1", 60_000, 0)]);
        bw.wait();
        super::test_hooks::install(Box::new(move |cp| {
            if cp == super::test_hooks::Checkpoint::TxStarted {
                locked_tx.send(()).unwrap(); // winner holds the write lock
                commit_rx.recv().unwrap(); // wait until the loser is provably blocked
            }
            Ok(())
        }));
        let d = submit(&c, &claims("t1", "b1", "u1"), &pl, TS);
        super::test_hooks::clear();
        d
    });
    let pl_ = path.clone();
    let bl = barrier.clone();
    let loser = std::thread::spawn(move || {
        let c = open_conn_waiting(&pl_, blocked_tx);
        let pl = payload(&loser_op, "b1", "cred-1", 0, &[("exp-1", 60_000, 0)]);
        bl.wait();
        go_rx.recv().unwrap(); // attempt the lock only after the winner holds it
        submit(&c, &claims("t1", "b1", "u1"), &pl, TS)
    });

    locked_rx.recv().unwrap(); // winner holds the lock (paused)
    go_tx.send(()).unwrap(); // release the loser to attempt the lock
    blocked_rx.recv().unwrap(); // loser is PROVEN waiting on the lock
    commit_tx.send(()).unwrap(); // let the winner commit
    let dw = winner.join().unwrap();
    let dl = loser.join().unwrap();
    (dw, dl, path)
}

/// A genuinely concurrent race where op #101 deterministically wins.
#[test]
fn concurrent_two_b1_race_winner_a() {
    let (dw, dl, path) = concurrent_two_b1("conc_a", op_uuid(101), op_uuid(102));
    assert!(matches!(dw, Decision::Accepted { .. }), "winner: {dw:?}");
    assert_loser_stale(&dl); // 1 accepted, 1 conflict, 0 transient
    let v = open_conn(&path);
    assert_single_accept_endstate(&v);
    drop(v);
    cleanup(&path);
}

/// The same race with the OTHER writer winning.
#[test]
fn concurrent_two_b1_race_winner_b() {
    let (dw, dl, path) = concurrent_two_b1("conc_b", op_uuid(102), op_uuid(101));
    assert!(matches!(dw, Decision::Accepted { .. }), "winner: {dw:?}");
    assert_loser_stale(&dl);
    let v = open_conn(&path);
    assert_single_accept_endstate(&v);
    drop(v);
    cleanup(&path);
}

/// Genuine concurrency safety net: two threads, synchronised start, high
/// `busy_timeout`. Outcome is non-deterministic in WHO wins but invariant in the
/// end state — exactly one accept, the credit is never double-spent.
#[test]
fn parallel_two_b1_no_mixed_state() {
    let path = file_db_with_seed("par_race");
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let spawn = |p: std::path::PathBuf, b: std::sync::Arc<std::sync::Barrier>, n: u32| {
        std::thread::spawn(move || {
            let c = open_conn(&p);
            let pl = payload(&op_uuid(n), "b1", "cred-1", 0, &[("exp-1", 60_000, 0)]);
            b.wait(); // synchronised start
            submit(&c, &claims("t1", "b1", "u1"), &pl, TS)
        })
    };
    let t1 = spawn(path.clone(), barrier.clone(), 201);
    let t2 = spawn(path.clone(), barrier.clone(), 202);
    let r1 = t1.join().unwrap();
    let r2 = t2.join().unwrap();

    let accepts = [&r1, &r2]
        .iter()
        .filter(|d| matches!(d, Decision::Accepted { .. }))
        .count();
    assert_eq!(accepts, 1, "exactly one accept: {r1:?} / {r2:?}");
    // the loser is a safe non-accept (conflict, or a genuine SQLite lock → transient)
    assert!([&r1, &r2]
        .iter()
        .any(|d| !matches!(d, Decision::Accepted { .. })));

    let v = open_conn(&path);
    assert_eq!(
        proj(&v, "supplier_credits", "cred-1")["usedAmountFils"],
        json!(60_000)
    ); // never 120
    assert_eq!(
        count(
            &v,
            "SELECT COUNT(*) FROM operations WHERE status='accepted'"
        ),
        1
    );
    assert_eq!(ledger_balance(&v), (60_000, 60_000));
    drop(v);
    cleanup(&path);
}

// ───────────────────────── real legacy-sync-vs-B1 parallel races ─────────────────────────

/// Case A — a legitimate cash batch and a B1 submit race on the same expense.
/// The two `BEGIN IMMEDIATE` writers serialise either way, and BOTH orders lead
/// to the SAME consistent end state (settled = 30 cash + 60 credit = 90, no
/// partial legacy batch, no overpayment, no doubled settlement).
#[test]
fn parallel_legacy_cash_vs_b1_no_mixed_state() {
    let path = file_db_with_seed("cash_vs_b1");
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));

    let pc = path.clone();
    let bc = barrier.clone();
    let legacy = std::thread::spawn(move || {
        let c = open_conn(&pc);
        let batch = [
            chg(
                "expenses",
                "exp-1",
                "update",
                json!({"id":"exp-1","branch_id":"b1","supplier_id":"sup-1","amount":100.0,"paid_amount":30.0}),
            ),
            chg(
                "expense_payments",
                "pc",
                "insert",
                json!({"id":"pc","expense_id":"exp-1","amount":30.0,"method":"cash"}),
            ),
        ];
        bc.wait();
        crate::authoritative_sync::bridge::process_sync_batch(&c, "t1", "b1", "u1", &batch, "t")
    });
    let pb = path.clone();
    let bb = barrier.clone();
    let b1 = std::thread::spawn(move || {
        let c = open_conn(&pb);
        let pl = payload(&op_uuid(301), "b1", "cred-1", 0, &[("exp-1", 60_000, 0)]);
        bb.wait();
        submit(&c, &claims("t1", "b1", "u1"), &pl, TS)
    });
    let _ = legacy.join().unwrap();
    let b1_res = b1.join().unwrap();

    let v = open_conn(&path);
    // B1 either ran before the cash batch (then folded) or after it — either way:
    if matches!(b1_res, Decision::Accepted { .. }) {
        let ep = proj(&v, "expenses", "exp-1");
        // no doubled settlement, no overpayment beyond the 100 amount
        assert_eq!(
            ep["settledFils"],
            json!(90_000),
            "consistent settled in both orders"
        );
        assert_eq!(ep["nonCreditPaidFils"], json!(30_000));
        assert_eq!(ep["creditPaidFils"], json!(60_000));
        assert!(ep["settledFils"].as_i64().unwrap() <= ep["amountFils"].as_i64().unwrap());
        assert_eq!(
            proj(&v, "supplier_credits", "cred-1")["usedAmountFils"],
            json!(60_000)
        );
    } else {
        // a genuine lock made B1 transient — nothing of B1 persisted; retry would succeed
        assert!(
            b1_res.is_transient(),
            "non-accept must be transient: {b1_res:?}"
        );
    }
    // the legacy batch is never partially applied (its own atomicity)
    drop(v);
    cleanup(&path);
}

/// Case B — a legacy credit-payment that fully commits BEFORE any cutover is
/// later **summed** by B1 (never re-applied), so the credit is not double-spent.
#[test]
fn legacy_credit_payment_before_cutover_is_summed_not_double_spent() {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    // the legacy flow already consumed 40 of the credit on exp-1
    seed_credit(&conn, "t1", "b1", "cred-1", "sup-1", 100.0, 40.0);
    seed_expense(&conn, "t1", "b1", "exp-1", "sup-1", 100.0, 0.0);
    seed_credit_payment(&conn, "t1", "b1", "pay-legacy", "exp-1", "cred-1", 40.0);

    // B1 applies a further 60 → cutover reads used=40 / credit_paid=40; +60 = 100
    let d = submit(
        &conn,
        &claims("t1", "b1", "u1"),
        &payload(&op_uuid(1), "b1", "cred-1", 0, &[("exp-1", 60_000, 0)]),
        TS,
    );
    assert!(matches!(d, Decision::Accepted { .. }), "{d:?}");
    // the legacy 40 is counted once (not doubled): used 100, settled 100
    assert_eq!(
        proj(&conn, "supplier_credits", "cred-1")["usedAmountFils"],
        json!(100_000)
    );
    assert_eq!(
        proj(&conn, "expenses", "exp-1")["creditPaidFils"],
        json!(100_000)
    );
    // a further B1 op would now overdraw (open 0 / available 0)
    let d2 = submit(
        &conn,
        &claims("t1", "b1", "u1"),
        &payload(&op_uuid(2), "b1", "cred-1", 1, &[("exp-1", 10_000, 1)]),
        TS,
    );
    assert!(matches!(d2, Decision::Conflict { .. }), "{d2:?}");
}

// ───────────────────────── full-rollback failure injection (9 phases) ─────────────────────────

/// Install a BEFORE INSERT trigger that aborts the next insert into `table`,
/// optionally only when `when` (a SQL boolean over `NEW`) holds — so a failure
/// can be injected at the *second* projection / revision (the expense one).
fn inject_abort(conn: &Connection, table: &str, when: Option<&str>) {
    let guard = match when {
        Some(w) => format!("WHEN {w} "),
        None => String::new(),
    };
    conn.execute_batch(&format!(
        "CREATE TRIGGER inj_fail BEFORE INSERT ON {table} {guard}BEGIN SELECT RAISE(ABORT,'inject'); END;"
    ))
    .unwrap();
}

fn assert_nothing_persisted(conn: &Connection) {
    for sql in [
        "SELECT COUNT(*) FROM operations",
        "SELECT COUNT(*) FROM operation_sequence",
        "SELECT COUNT(*) FROM operation_envelopes",
        "SELECT COUNT(*) FROM operation_mutations",
        "SELECT COUNT(*) FROM auth_ledger_entries",
        "SELECT COUNT(*) FROM canonical_records",
        "SELECT COUNT(*) FROM aggregate_revisions",
    ] {
        assert_eq!(count(conn, sql), 0, "leaked rows: {sql}");
    }
}

/// Run one accept-path submit with an abort injected at the given phase; assert
/// a transient outcome and that the entire transaction rolled back.
fn inject_case(label: &str, table: &str, when: Option<&str>) {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    seed_credit(&conn, "t1", "b1", "cred-1", "sup-1", 100.0, 0.0);
    seed_expense(&conn, "t1", "b1", "exp-1", "sup-1", 100.0, 0.0);
    inject_abort(&conn, table, when);
    let d = submit(
        &conn,
        &claims("t1", "b1", "u1"),
        &payload(&op_uuid(1), "b1", "cred-1", 0, &[("exp-1", 60_000, 0)]),
        TS,
    );
    assert!(d.is_transient(), "[{label}] must be transient, got {d:?}");
    assert_nothing_persisted(&conn);
}

// The handler's accept-path write order is: operations → operation_sequence →
// auth_ledger_entries → aggregate_revisions(credit) → canonical_records(credit)
// → aggregate_revisions(expense) → canonical_records(expense) → operation_envelopes
// → operation_mutations. Each phase below proves a full rollback.

#[test]
fn rollback_phase1_first_business_write() {
    // after lazy materialisation, at the very first write (operations row)
    inject_case("phase1/operations", "operations", None);
}
#[test]
fn rollback_phase2_sequence() {
    inject_case("phase2/sequence", "operation_sequence", None);
}
#[test]
fn rollback_phase3_ledger() {
    inject_case("phase3/ledger", "auth_ledger_entries", None);
}
#[test]
fn rollback_phase4_first_revision_credit() {
    inject_case("phase4/credit-revision", "aggregate_revisions", None);
}
#[test]
fn rollback_phase5_credit_projection() {
    inject_case("phase5/credit-projection", "canonical_records", None);
}
#[test]
fn rollback_phase6_expense_revision_after_credit() {
    // credit revision already bumped → fail at the expense revision
    inject_case(
        "phase6/expense-revision",
        "aggregate_revisions",
        Some("NEW.aggregate_type='EXPENSE_SETTLEMENT'"),
    );
}
#[test]
fn rollback_phase7_expense_projection_after_credit() {
    // credit projection already written → fail at the expense projection
    inject_case(
        "phase7/expense-projection",
        "canonical_records",
        Some("NEW.table_name='expenses'"),
    );
}
#[test]
fn rollback_phase8_envelope() {
    inject_case("phase8/envelope", "operation_envelopes", None);
}
#[test]
fn rollback_phase9_first_mutation_payment() {
    // the first operation_mutations row is also the first delivered payment row
    inject_case("phase9/mutation", "operation_mutations", None);
}

/// A failure in a SECOND operation must leave the FIRST operation's already-
/// committed cutover projection + revisions byte/logically unchanged.
#[test]
fn rollback_preserves_preexisting_cutover_projection() {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    seed_credit(&conn, "t1", "b1", "cred-1", "sup-1", 100.0, 0.0);
    seed_expense(&conn, "t1", "b1", "exp-1", "sup-1", 100.0, 0.0);
    let c = claims("t1", "b1", "u1");
    // op1 accepts → projections at revision 1
    assert!(matches!(
        submit(
            &conn,
            &c,
            &payload(&op_uuid(1), "b1", "cred-1", 0, &[("exp-1", 30_000, 0)]),
            TS
        ),
        Decision::Accepted { .. }
    ));
    let cred_before = proj(&conn, "supplier_credits", "cred-1");
    let exp_before = proj(&conn, "expenses", "exp-1");
    let counts_before = (
        count(&conn, "SELECT COUNT(*) FROM operations"),
        count(&conn, "SELECT COUNT(*) FROM operation_envelopes"),
        count(&conn, "SELECT COUNT(*) FROM operation_mutations"),
        count(&conn, "SELECT COUNT(*) FROM auth_ledger_entries"),
    );

    // op2 fails mid-way (after the envelope of op2) → full rollback of op2 only
    inject_abort(&conn, "operation_mutations", None);
    let d2 = submit(
        &conn,
        &c,
        &payload(&op_uuid(2), "b1", "cred-1", 1, &[("exp-1", 20_000, 1)]),
        TS,
    );
    assert!(d2.is_transient(), "{d2:?}");

    // op1's authoritative state is untouched
    assert_eq!(proj(&conn, "supplier_credits", "cred-1"), cred_before);
    assert_eq!(proj(&conn, "expenses", "exp-1"), exp_before);
    assert_eq!(agg_rev(&conn, "SUPPLIER_CREDIT_BALANCE", "cred-1"), 1);
    assert_eq!(agg_rev(&conn, "EXPENSE_SETTLEMENT", "exp-1"), 1);
    assert_eq!(
        (
            count(&conn, "SELECT COUNT(*) FROM operations"),
            count(&conn, "SELECT COUNT(*) FROM operation_envelopes"),
            count(&conn, "SELECT COUNT(*) FROM operation_mutations"),
            count(&conn, "SELECT COUNT(*) FROM auth_ledger_entries"),
        ),
        counts_before,
        "op2 leaked rows into op1's committed state"
    );
}

// ───────────────────────── revision overlap → conflict ─────────────────────────

/// Two operations overlapping on an expense: the second, using the stale expense
/// revision, is a final conflict (no global supplier conflict — only the real
/// per-expense aggregate).
#[test]
fn overlapping_expense_with_stale_revision_conflicts() {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    seed_credit(&conn, "t1", "b1", "cred-1", "sup-1", 100.0, 0.0);
    seed_expense(&conn, "t1", "b1", "exp-1", "sup-1", 100.0, 0.0);
    seed_expense(&conn, "t1", "b1", "exp-2", "sup-1", 100.0, 0.0);
    let c = claims("t1", "b1", "u1");
    // op1 touches exp-1 + exp-2 → both at revision 1, credit at revision 1
    assert!(matches!(
        submit(
            &conn,
            &c,
            &payload(
                &op_uuid(1),
                "b1",
                "cred-1",
                0,
                &[("exp-1", 10_000, 0), ("exp-2", 10_000, 0)]
            ),
            TS
        ),
        Decision::Accepted { .. }
    ));
    // op2 overlaps on exp-2 but presents the STALE expense revision 0 → conflict
    let d = submit(
        &conn,
        &c,
        &payload(&op_uuid(2), "b1", "cred-1", 1, &[("exp-2", 10_000, 0)]),
        TS,
    );
    match d {
        Decision::Conflict { error_code, result } => {
            assert_eq!(error_code, "STALE_REVISION");
            assert_eq!(result["aggregate"], json!("EXPENSE_SETTLEMENT"));
            assert_eq!(result["expenseId"], json!("exp-2"));
        }
        other => panic!("{other:?}"),
    }
    // nothing from op2 applied; op1's revisions intact
    assert_eq!(agg_rev(&conn, "EXPENSE_SETTLEMENT", "exp-2"), 1);
    assert_eq!(agg_rev(&conn, "SUPPLIER_CREDIT_BALANCE", "cred-1"), 1);
}

// ───────────────────────── envelope known-answer test (via B0 pull) ─────────────────────────

/// Submit one operation, pull its envelope via the B0 operations-pull, and verify
/// every field against the accepted authoritative state. A re-pull from the
/// returned cursor delivers nothing.
#[test]
fn envelope_known_answer_via_pull() {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    seed_credit(&conn, "t1", "b1", "cred-1", "sup-1", 100.0, 0.0);
    seed_expense(&conn, "t1", "b1", "exp-1", "sup-1", 100.0, 0.0);
    let op = op_uuid(1);
    assert!(matches!(
        submit(
            &conn,
            &claims("t1", "b1", "u1"),
            &payload(&op, "b1", "cred-1", 0, &[("exp-1", 60_000, 0)]),
            TS
        ),
        Decision::Accepted { .. }
    ));

    let pr = crate::authoritative_sync::pull_operations(&conn, "t1", "b1", 0, 100).unwrap();
    assert_eq!(pr.operations.len(), 1);
    let env = &pr.operations[0].envelope;

    // header: serverSequence equals the pull cursor
    assert_eq!(env["operationId"], json!(op));
    assert_eq!(env["serverSequence"], json!(pr.cursor.to_string()));
    assert_eq!(
        env["operationType"],
        json!("APPLY_SUPPLIER_CREDIT_TO_EXPENSES")
    );
    assert_eq!(env["branchId"], json!("b1"));
    assert_eq!(env["mutationCount"], json!(3));

    let muts = env["mutations"].as_array().unwrap();
    assert_eq!(muts.len(), 3);
    // dense ordinals 0,1,2 and canonical [table, recordId] order
    for (i, m) in muts.iter().enumerate() {
        assert_eq!(m["ordinal"], json!(i as u64));
        assert_eq!(m["action"], json!("upsert"));
    }
    assert_eq!(muts[0]["table"], json!("expense_payments"));
    assert_eq!(muts[1]["table"], json!("expenses"));
    assert_eq!(muts[2]["table"], json!("supplier_credits"));

    // deterministic payment id (recomputed) + full payment row
    let payment_id = lataif_server::protocol::identity::ChildId::ExpensePayment {
        operation_id: &op,
        expense_id: "exp-1",
        credit_id: "cred-1",
        ordinal: 0,
    }
    .derive()
    .unwrap();
    assert_eq!(muts[0]["recordId"], json!(payment_id));
    assert_eq!(muts[0]["payload"]["id"], json!(payment_id));
    assert_eq!(muts[0]["payload"]["amountFils"], json!("60000"));
    assert_eq!(muts[0]["payload"]["method"], json!("credit"));

    // full expense snapshot + revision
    assert_eq!(muts[1]["recordId"], json!("exp-1"));
    assert_eq!(muts[1]["recordRevision"], json!("1"));
    assert_eq!(muts[1]["payload"]["amountFils"], json!("100000"));
    assert_eq!(muts[1]["payload"]["nonCreditPaidFils"], json!("0"));
    assert_eq!(muts[1]["payload"]["creditPaidFils"], json!("60000"));
    assert_eq!(muts[1]["payload"]["settledFils"], json!("60000"));
    assert_eq!(muts[1]["payload"]["openFils"], json!("40000"));
    assert_eq!(muts[1]["payload"]["status"], json!("PENDING"));

    // full credit snapshot + revision
    assert_eq!(muts[2]["recordId"], json!("cred-1"));
    assert_eq!(muts[2]["recordRevision"], json!("1"));
    assert_eq!(muts[2]["payload"]["amountFils"], json!("100000"));
    assert_eq!(muts[2]["payload"]["usedAmountFils"], json!("60000"));
    assert_eq!(muts[2]["payload"]["availableAmountFils"], json!("40000"));
    assert_eq!(muts[2]["payload"]["status"], json!("OPEN"));

    // ledger: one transaction, two balanced legs DR AP / CR SUPPLIER_CREDIT, no bank/cash
    assert!(env["ledger"]["transactionId"].is_string());
    let entries = env["ledger"]["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    let debit = entries
        .iter()
        .find(|e| e["direction"] == json!("DEBIT"))
        .unwrap();
    let credit = entries
        .iter()
        .find(|e| e["direction"] == json!("CREDIT"))
        .unwrap();
    assert_eq!(debit["account"], json!("ACCOUNTS_PAYABLE"));
    assert_eq!(debit["amountFils"], json!("60000"));
    assert_eq!(debit["counterpartyType"], json!("SUPPLIER"));
    assert_eq!(debit["counterpartyId"], json!("sup-1"));
    assert_eq!(credit["account"], json!("SUPPLIER_CREDIT"));
    assert_eq!(credit["amountFils"], json!("60000"));
    assert!(!entries.iter().any(|e| {
        let a = e["account"].as_str().unwrap_or("");
        a.contains("BANK") || a.contains("CASH")
    }));

    // result block
    assert_eq!(env["result"]["status"], json!("accepted"));
    assert_eq!(env["result"]["creditId"], json!("cred-1"));
    assert_eq!(env["result"]["newCreditRevision"], json!("1"));

    // re-pull from the cursor delivers nothing
    let pr2 =
        crate::authoritative_sync::pull_operations(&conn, "t1", "b1", pr.cursor, 100).unwrap();
    assert_eq!(pr2.operations.len(), 0);
}

// ───────────────────────── genuinely concurrent legacy-vs-B1 races ─────────────────────────

/// Case 2B — B1 deterministically holds the lock and commits first; a legacy
/// credit-payment that was provably waiting then runs against the now-protected
/// records and is fully blocked. No legacy partial write, no second credit use.
#[test]
fn concurrent_b1_wins_then_legacy_credit_blocked() {
    let path = file_db_with_seed("b1_vs_legcred");
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let (locked_tx, locked_rx) = std::sync::mpsc::channel::<()>();
    let (commit_tx, commit_rx) = std::sync::mpsc::channel::<()>();
    let (go_tx, go_rx) = std::sync::mpsc::channel::<()>();
    let (blocked_tx, blocked_rx) = std::sync::mpsc::channel::<()>();

    let pw = path.clone();
    let bw = barrier.clone();
    let b1 = std::thread::spawn(move || {
        let c = open_conn(&pw);
        let pl = payload(&op_uuid(1), "b1", "cred-1", 0, &[("exp-1", 60_000, 0)]);
        bw.wait();
        super::test_hooks::install(Box::new(move |cp| {
            if cp == super::test_hooks::Checkpoint::TxStarted {
                locked_tx.send(()).unwrap();
                commit_rx.recv().unwrap();
            }
            Ok(())
        }));
        let d = submit(&c, &claims("t1", "b1", "u1"), &pl, TS);
        super::test_hooks::clear();
        d
    });
    let pl_ = path.clone();
    let bl = barrier.clone();
    let legacy = std::thread::spawn(move || {
        let c = open_conn_waiting(&pl_, blocked_tx);
        let batch = [chg(
            "expense_payments",
            "px",
            "insert",
            json!({"id":"px","expense_id":"exp-1","reference":"cred-1","amount":10.0,"method":"credit"}),
        )];
        bl.wait();
        go_rx.recv().unwrap();
        crate::authoritative_sync::bridge::process_sync_batch(&c, "t1", "b1", "u1", &batch, "t")
    });

    locked_rx.recv().unwrap();
    go_tx.send(()).unwrap();
    blocked_rx.recv().unwrap();
    commit_tx.send(()).unwrap();
    let d_b1 = b1.join().unwrap();
    let r_legacy = legacy.join().unwrap();

    assert!(matches!(d_b1, Decision::Accepted { .. }), "{d_b1:?}");
    assert_eq!(r_legacy.unwrap_err().code(), "B0_PROTECTED_CREDIT_PAYMENT");
    let v = open_conn(&path);
    assert_eq!(
        proj(&v, "supplier_credits", "cred-1")["usedAmountFils"],
        json!(60_000)
    ); // once
    assert_eq!(agg_rev(&v, "SUPPLIER_CREDIT_BALANCE", "cred-1"), 1); // no extra revision
                                                                     // the blocked legacy batch left nothing in the changelog
    assert_eq!(
        count(
            &v,
            "SELECT COUNT(*) FROM sync_changelog WHERE record_id='px'"
        ),
        0
    );
    drop(v);
    cleanup(&path);
}

/// Case 2A — a legacy credit-payment deterministically holds the lock (paused via
/// the bridge test hook) and commits first; B1, provably waiting, then runs and
/// SUMS the legacy consumption (never double-spends).
#[test]
fn concurrent_legacy_credit_wins_then_b1_summed() {
    let path = file_db_with_seed("legcred_vs_b1"); // credit used 0, expense paid 0
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let (locked_tx, locked_rx) = std::sync::mpsc::channel::<()>();
    let (commit_tx, commit_rx) = std::sync::mpsc::channel::<()>();
    let (go_tx, go_rx) = std::sync::mpsc::channel::<()>();
    let (blocked_tx, blocked_rx) = std::sync::mpsc::channel::<()>();

    let pleg = path.clone();
    let bleg = barrier.clone();
    let legacy = std::thread::spawn(move || {
        let c = open_conn(&pleg);
        // the legacy flow consumed 40 of the credit on exp-1 (pre-cutover relay)
        let batch = [
            chg(
                "supplier_credits",
                "cred-1",
                "update",
                json!({"id":"cred-1","branch_id":"b1","supplier_id":"sup-1","amount":100.0,"used_amount":40.0,"status":"OPEN"}),
            ),
            chg(
                "expense_payments",
                "pleg",
                "insert",
                json!({"id":"pleg","expense_id":"exp-1","reference":"cred-1","amount":40.0,"method":"credit"}),
            ),
        ];
        bleg.wait();
        crate::authoritative_sync::bridge::test_pause::install(Box::new(move || {
            locked_tx.send(()).unwrap();
            commit_rx.recv().unwrap();
        }));
        let r = crate::authoritative_sync::bridge::process_sync_batch(
            &c, "t1", "b1", "u1", &batch, "t",
        );
        crate::authoritative_sync::bridge::test_pause::clear();
        r
    });
    let pb1 = path.clone();
    let bb1 = barrier.clone();
    let b1 = std::thread::spawn(move || {
        let c = open_conn_waiting(&pb1, blocked_tx);
        let pl = payload(&op_uuid(1), "b1", "cred-1", 0, &[("exp-1", 60_000, 0)]);
        bb1.wait();
        go_rx.recv().unwrap();
        submit(&c, &claims("t1", "b1", "u1"), &pl, TS)
    });

    locked_rx.recv().unwrap();
    go_tx.send(()).unwrap();
    blocked_rx.recv().unwrap();
    commit_tx.send(()).unwrap();
    let r_legacy = legacy.join().unwrap();
    let d_b1 = b1.join().unwrap();

    assert!(r_legacy.is_ok(), "{r_legacy:?}");
    assert!(matches!(d_b1, Decision::Accepted { .. }), "{d_b1:?}");
    let v = open_conn(&path);
    // legacy 40 summed once + B1 60 = 100 (never doubled)
    assert_eq!(
        proj(&v, "supplier_credits", "cred-1")["usedAmountFils"],
        json!(100_000)
    );
    assert_eq!(
        proj(&v, "expenses", "exp-1")["creditPaidFils"],
        json!(100_000)
    );
    let ep = proj(&v, "expenses", "exp-1");
    assert!(ep["settledFils"].as_i64().unwrap() <= ep["amountFils"].as_i64().unwrap());
    drop(v);
    cleanup(&path);
}

/// Non-credit, B1 wins: B1 holds the lock and commits; the waiting cash batch
/// then folds into the now-protected expense (settled = 30 cash + 60 credit).
#[test]
fn concurrent_b1_wins_then_legacy_cash_fold() {
    let path = file_db_with_seed("b1_vs_legcash");
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let (locked_tx, locked_rx) = std::sync::mpsc::channel::<()>();
    let (commit_tx, commit_rx) = std::sync::mpsc::channel::<()>();
    let (go_tx, go_rx) = std::sync::mpsc::channel::<()>();
    let (blocked_tx, blocked_rx) = std::sync::mpsc::channel::<()>();

    let pw = path.clone();
    let bw = barrier.clone();
    let b1 = std::thread::spawn(move || {
        let c = open_conn(&pw);
        let pl = payload(&op_uuid(1), "b1", "cred-1", 0, &[("exp-1", 60_000, 0)]);
        bw.wait();
        super::test_hooks::install(Box::new(move |cp| {
            if cp == super::test_hooks::Checkpoint::TxStarted {
                locked_tx.send(()).unwrap();
                commit_rx.recv().unwrap();
            }
            Ok(())
        }));
        let d = submit(&c, &claims("t1", "b1", "u1"), &pl, TS);
        super::test_hooks::clear();
        d
    });
    let pl_ = path.clone();
    let bl = barrier.clone();
    let legacy = std::thread::spawn(move || {
        let c = open_conn_waiting(&pl_, blocked_tx);
        let batch = [
            chg(
                "expenses",
                "exp-1",
                "update",
                json!({"id":"exp-1","paid_amount":30.0}),
            ),
            chg(
                "expense_payments",
                "pc",
                "insert",
                json!({"id":"pc","expense_id":"exp-1","amount":30.0,"method":"cash"}),
            ),
        ];
        bl.wait();
        go_rx.recv().unwrap();
        crate::authoritative_sync::bridge::process_sync_batch(&c, "t1", "b1", "u1", &batch, "t")
    });

    locked_rx.recv().unwrap();
    go_tx.send(()).unwrap();
    blocked_rx.recv().unwrap();
    commit_tx.send(()).unwrap();
    let d_b1 = b1.join().unwrap();
    let r_legacy = legacy.join().unwrap();

    assert!(matches!(d_b1, Decision::Accepted { .. }), "{d_b1:?}");
    assert!(r_legacy.is_ok(), "{r_legacy:?}");
    let v = open_conn(&path);
    let ep = proj(&v, "expenses", "exp-1");
    assert_eq!(ep["nonCreditPaidFils"], json!(30_000));
    assert_eq!(ep["creditPaidFils"], json!(60_000));
    assert_eq!(ep["settledFils"], json!(90_000)); // no double count, settled <= amount
    assert_eq!(agg_rev(&v, "EXPENSE_SETTLEMENT", "exp-1"), 2); // B1 (1) + fold (1)
    drop(v);
    cleanup(&path);
}

/// Non-credit, legacy cash wins: the cash batch holds the lock (bridge pause) and
/// commits; B1, provably waiting, then reads the new paid_amount and applies the
/// credit on the remaining open amount (settled = 30 + 60).
#[test]
fn concurrent_legacy_cash_wins_then_b1() {
    let path = file_db_with_seed("legcash_vs_b1");
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let (locked_tx, locked_rx) = std::sync::mpsc::channel::<()>();
    let (commit_tx, commit_rx) = std::sync::mpsc::channel::<()>();
    let (go_tx, go_rx) = std::sync::mpsc::channel::<()>();
    let (blocked_tx, blocked_rx) = std::sync::mpsc::channel::<()>();

    let pleg = path.clone();
    let bleg = barrier.clone();
    let legacy = std::thread::spawn(move || {
        let c = open_conn(&pleg);
        let batch = [
            chg(
                "expenses",
                "exp-1",
                "update",
                json!({"id":"exp-1","branch_id":"b1","supplier_id":"sup-1","amount":100.0,"paid_amount":30.0}),
            ),
            chg(
                "expense_payments",
                "pc",
                "insert",
                json!({"id":"pc","expense_id":"exp-1","amount":30.0,"method":"cash"}),
            ),
        ];
        bleg.wait();
        crate::authoritative_sync::bridge::test_pause::install(Box::new(move || {
            locked_tx.send(()).unwrap();
            commit_rx.recv().unwrap();
        }));
        let r = crate::authoritative_sync::bridge::process_sync_batch(
            &c, "t1", "b1", "u1", &batch, "t",
        );
        crate::authoritative_sync::bridge::test_pause::clear();
        r
    });
    let pb1 = path.clone();
    let bb1 = barrier.clone();
    let b1 = std::thread::spawn(move || {
        let c = open_conn_waiting(&pb1, blocked_tx);
        let pl = payload(&op_uuid(1), "b1", "cred-1", 0, &[("exp-1", 60_000, 0)]);
        bb1.wait();
        go_rx.recv().unwrap();
        submit(&c, &claims("t1", "b1", "u1"), &pl, TS)
    });

    locked_rx.recv().unwrap();
    go_tx.send(()).unwrap();
    blocked_rx.recv().unwrap();
    commit_tx.send(()).unwrap();
    let r_legacy = legacy.join().unwrap();
    let d_b1 = b1.join().unwrap();

    assert!(r_legacy.is_ok(), "{r_legacy:?}");
    assert!(matches!(d_b1, Decision::Accepted { .. }), "{d_b1:?}");
    let v = open_conn(&path);
    let ep = proj(&v, "expenses", "exp-1");
    assert_eq!(ep["nonCreditPaidFils"], json!(30_000));
    assert_eq!(ep["creditPaidFils"], json!(60_000));
    assert_eq!(ep["settledFils"], json!(90_000));
    drop(v);
    cleanup(&path);
}

// ───────────────────────── hook-based rollback AFTER each phase ─────────────────────────

/// Install a hook that injects a failure exactly at `cp` (after that phase's
/// writes), run one accept-path submit, and assert a transient + full rollback.
fn inject_after_phase(cp: super::test_hooks::Checkpoint) {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    seed_credit(&conn, "t1", "b1", "cred-1", "sup-1", 100.0, 0.0);
    seed_expense(&conn, "t1", "b1", "exp-1", "sup-1", 100.0, 0.0);
    super::test_hooks::install(Box::new(move |c| if c == cp { Err(()) } else { Ok(()) }));
    let d = submit(
        &conn,
        &claims("t1", "b1", "u1"),
        &payload(&op_uuid(1), "b1", "cred-1", 0, &[("exp-1", 60_000, 0)]),
        TS,
    );
    super::test_hooks::clear();
    assert!(
        d.is_transient(),
        "after {cp:?} must be transient, got {d:?}"
    );
    assert_nothing_persisted(&conn);
}

#[test]
fn rollback_after_lazy_materialization() {
    inject_after_phase(super::test_hooks::Checkpoint::AfterLazyMaterialization);
}
#[test]
fn rollback_after_sequence_assigned() {
    inject_after_phase(super::test_hooks::Checkpoint::AfterSequenceAssigned);
}
#[test]
fn rollback_after_ledger_effects() {
    inject_after_phase(super::test_hooks::Checkpoint::AfterLedgerEffectsWritten);
}
#[test]
fn rollback_after_first_revision_bumped() {
    inject_after_phase(super::test_hooks::Checkpoint::AfterFirstRevisionBumped);
}
#[test]
fn rollback_after_credit_projection_updated() {
    inject_after_phase(super::test_hooks::Checkpoint::AfterCreditProjectionUpdated);
}
#[test]
fn rollback_after_first_expense_projection_updated() {
    inject_after_phase(super::test_hooks::Checkpoint::AfterFirstExpenseProjectionUpdated);
}
#[test]
fn rollback_after_first_payment_prepared() {
    inject_after_phase(super::test_hooks::Checkpoint::AfterFirstPaymentPrepared);
}
#[test]
fn rollback_after_envelope_written() {
    inject_after_phase(super::test_hooks::Checkpoint::AfterEnvelopeWritten);
}
#[test]
fn rollback_after_first_mutation_written() {
    inject_after_phase(super::test_hooks::Checkpoint::AfterFirstMutationWritten);
}

/// A failure AFTER any phase of a second op leaves the first op's committed
/// cutover projection + revisions logically unchanged (here: after the envelope).
#[test]
fn rollback_after_phase_preserves_preexisting_projection() {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    seed_credit(&conn, "t1", "b1", "cred-1", "sup-1", 100.0, 0.0);
    seed_expense(&conn, "t1", "b1", "exp-1", "sup-1", 100.0, 0.0);
    let c = claims("t1", "b1", "u1");
    assert!(matches!(
        submit(
            &conn,
            &c,
            &payload(&op_uuid(1), "b1", "cred-1", 0, &[("exp-1", 30_000, 0)]),
            TS
        ),
        Decision::Accepted { .. }
    ));
    let cred_before = proj(&conn, "supplier_credits", "cred-1");
    let exp_before = proj(&conn, "expenses", "exp-1");
    let ops_before = count(&conn, "SELECT COUNT(*) FROM operations");

    super::test_hooks::install(Box::new(|cp| {
        if cp == super::test_hooks::Checkpoint::AfterEnvelopeWritten {
            Err(())
        } else {
            Ok(())
        }
    }));
    let d2 = submit(
        &conn,
        &c,
        &payload(&op_uuid(2), "b1", "cred-1", 1, &[("exp-1", 20_000, 1)]),
        TS,
    );
    super::test_hooks::clear();
    assert!(d2.is_transient(), "{d2:?}");
    assert_eq!(proj(&conn, "supplier_credits", "cred-1"), cred_before);
    assert_eq!(proj(&conn, "expenses", "exp-1"), exp_before);
    assert_eq!(agg_rev(&conn, "SUPPLIER_CREDIT_BALANCE", "cred-1"), 1);
    assert_eq!(agg_rev(&conn, "EXPENSE_SETTLEMENT", "exp-1"), 1);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM operations"), ops_before);
}
