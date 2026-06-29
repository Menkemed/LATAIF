//! B1 — `APPLY_SUPPLIER_CREDIT_TO_EXPENSES` authoritative operation (re-applied
//! on the B0 foundation).
//!
//! The first productive vertical slice. A single direct `match` on the pilot
//! `operationType` — no registry, no handler factory, no second type. It fixes
//! exactly one defect: two clients must not both apply the same supplier credit
//! to the same expenses.
//!
//! ## Authoritative model (B0-aligned)
//!
//! - **One credit, many expense allocations** per operation. The payload carries
//!   only IDs, desired allocation amounts, and the **expected per-aggregate
//!   revisions** (`expectedCreditRevision`, per-allocation
//!   `expectedExpenseRevision`). It is NEVER an authoritative source for credit
//!   total / `used_amount` / status, expense total / `paid_amount` / status,
//!   supplier or branch — those come exclusively from the B0 projections, or, on
//!   first touch, from the branch-isolated server `sync_changelog` (lazy cutover).
//! - **Per-aggregate revision CAS** on `SUPPLIER_CREDIT_BALANCE/creditId` and
//!   `EXPENSE_SETTLEMENT/expenseId` (the exact B0 projections). No global
//!   `supplier_settlement` aggregate. A mismatch is a final `conflict`.
//! - **Reuse, never duplicate.** Money via [`lataif_server::money`]; newest
//!   branch-isolated snapshots + credit-payment reconstruction via
//!   [`crate::authoritative_sync`]; projection build/write + revision access via
//!   [`crate::authoritative_sync::bridge`]. Deterministic IDs + ordinals via the
//!   A1b `protocol` module.
//! - **No second legacy guard.** After an accepted operation the projections are
//!   materialised, so the already-deployed B0 bridge protects the records
//!   (blocks direct legacy credit-payments / cancel / delete / supplier change)
//!   while still folding cash/bank/benefit and allowed metadata.
//!
//! Everything runs in one `BEGIN IMMEDIATE` transaction: idempotency is
//! re-checked, the cutover is read, the decision is taken, and either the full
//! accepted effect or just the final decision row is committed — or the whole
//! transaction rolls back (transient).

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::authoritative_sync::bridge::{
    build_credit_projection, build_expense_projection, bump_revision, credit_projection_json,
    expense_projection_json, proj_fils, read_revision, write_projection, BatchError,
};
use crate::authoritative_sync::{
    canonical_projection, latest_snapshot, sum_active_credit_payments,
};
use crate::models::Claims;
use lataif_server::money::bhd_value_to_fils;
use lataif_server::protocol::canonical::{canon, payload_hash_hex};
use lataif_server::protocol::identity::ChildId;
use lataif_server::protocol::operation_type::PILOT_OPERATION_TYPE;
use lataif_server::protocol::ordinal::{
    order_allocations, order_ledger_legs, Allocation, LedgerLeg,
};
use lataif_server::protocol::schema::validate_settlement_payload;

/// Per-aggregate revision aggregate types (the exact B0 projections).
const AGG_CREDIT: &str = "SUPPLIER_CREDIT_BALANCE";
const AGG_EXPENSE: &str = "EXPENSE_SETTLEMENT";
/// Ledger accounts (mirror the desktop posting for this flow).
const ACCOUNT_AP: &str = "ACCOUNTS_PAYABLE";
const ACCOUNT_SUPPLIER_CREDIT: &str = "SUPPLIER_CREDIT";
const COUNTERPARTY_SUPPLIER: &str = "SUPPLIER";
/// Frozen module tag for authoritative ledger rows of this slice.
const SOURCE_MODULE: &str = "B1_APPLY_SUPPLIER_CREDIT_TO_EXPENSES";

/// The decision returned by [`submit`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// A fresh authoritative accept.
    Accepted { server_sequence: i64, result: Value },
    /// A replay of an already-stored final decision (same id + same hash).
    Replay {
        status: String,
        error_code: Option<String>,
        result: Value,
    },
    /// Same `operationId`, different payload hash.
    OperationIdReused,
    /// A final, stored conflict (stale revision / changed economic state).
    Conflict { error_code: String, result: Value },
    /// A final, stored static-payload rejection.
    ValidationRejected { error_code: String, result: Value },
    /// A transient outcome — nothing stored; client retries the same id+hash.
    Transient { code: String },
}

impl Decision {
    /// True iff this is a transient outcome (nothing stored; client retries the
    /// same id+hash). Used by the HTTP layer to pick a retryable status code.
    pub fn is_transient(&self) -> bool {
        matches!(self, Decision::Transient { .. })
    }

    /// The full JSON response body for the submit endpoint.
    pub fn to_response(&self, operation_id: &str, payload_hash: &str) -> Value {
        match self {
            Decision::Accepted {
                server_sequence,
                result,
            } => json!({
                "operationId": operation_id,
                "status": "accepted",
                "resultStatus": "accepted",
                "errorCode": Value::Null,
                "retryAction": Value::Null,
                "serverSequence": server_sequence.to_string(),
                "payloadHash": payload_hash,
                "result": result,
            }),
            Decision::Replay {
                status,
                error_code,
                result,
            } => json!({
                "operationId": operation_id,
                "status": status,
                "resultStatus": status,
                "errorCode": error_code,
                "retryAction": "REPLAY_STORED",
                "payloadHash": payload_hash,
                "result": result,
            }),
            Decision::OperationIdReused => json!({
                "operationId": operation_id,
                "status": "conflict",
                "resultStatus": "conflict",
                "errorCode": "OPERATION_ID_REUSED",
                "retryAction": "OPERATION_ID_REUSED",
                "payloadHash": payload_hash,
            }),
            Decision::Conflict { error_code, result } => json!({
                "operationId": operation_id,
                "status": "conflict",
                "resultStatus": "conflict",
                "errorCode": error_code,
                "retryAction": Value::Null,
                "payloadHash": payload_hash,
                "result": result,
            }),
            Decision::ValidationRejected { error_code, result } => json!({
                "operationId": operation_id,
                "status": "validation_rejected",
                "resultStatus": "validation_rejected",
                "errorCode": error_code,
                "retryAction": Value::Null,
                "payloadHash": payload_hash,
                "result": result,
            }),
            Decision::Transient { code } => json!({
                "operationId": operation_id,
                "status": "transient",
                "resultStatus": Value::Null,
                "errorCode": code,
                "retryAction": "UNKNOWN_COMMIT_STATUS",
                "payloadHash": payload_hash,
            }),
        }
    }
}

/// A transient failure inside the transaction → roll back, store nothing. The
/// payload is the stable transient code (`FINANCE_NOT_BOOTSTRAPPED`,
/// `INTERNAL_ERROR_BEFORE_COMMIT`, `DB_LOCKED`).
struct Transient(&'static str);

impl From<BatchError> for Transient {
    fn from(_: BatchError) -> Self {
        // A bridge-helper failure inside the tx is an internal/transient fault
        // (money faults during cut-over are mapped explicitly to NOT_BOOTSTRAPPED
        // before reaching a builder).
        Transient("INTERNAL_ERROR_BEFORE_COMMIT")
    }
}

/// Fire a test-only checkpoint inside the open transaction. A hook returning
/// `Err` (failure injection) becomes a transient that rolls the whole batch
/// back. Compiled out of the production binary.
#[cfg(test)]
fn checkpoint(cp: test_hooks::Checkpoint) -> Result<(), Transient> {
    test_hooks::fire(cp).map_err(|_| Transient("INTERNAL_ERROR_BEFORE_COMMIT"))
}

fn str_field<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(|x| x.as_str())
}

/// A canonical i64 string field (`…Fils` / `…Revision`).
fn i64_str(v: &Value, key: &str) -> Option<i64> {
    v.get(key).and_then(|x| x.as_str()).and_then(parse_i64)
}

/// Parse a canonical non-negative i64 decimal string (no sign, no leading zero
/// beyond a lone `0`).
fn parse_i64(s: &str) -> Option<i64> {
    if s.is_empty() || !s.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    if s.len() > 1 && s.as_bytes()[0] == b'0' {
        return None;
    }
    s.parse::<i64>().ok()
}

/// Authoritative state of a supplier credit at decision time.
struct CreditState {
    amount_fils: i64,
    used_fils: i64,
    supplier_id: String,
    current_revision: i64,
}

/// Authoritative state of an expense at decision time.
struct ExpenseState {
    amount_fils: i64,
    non_credit_fils: i64,
    credit_paid_fils: i64,
    supplier_id: String,
    current_revision: i64,
}

/// Materialise a supplier credit: prefer the adopted B0 projection, else
/// reconstruct (first cutover) from the branch-isolated `sync_changelog`.
fn materialize_credit(
    conn: &Connection,
    tenant: &str,
    branch: &str,
    credit_id: &str,
) -> Result<CreditState, Transient> {
    if let Some((_recrev, proj)) =
        canonical_projection(conn, tenant, branch, "supplier_credits", credit_id)
    {
        return Ok(CreditState {
            amount_fils: proj_fils(&proj, "amountFils"),
            used_fils: proj_fils(&proj, "usedAmountFils"),
            supplier_id: proj["supplierId"].as_str().unwrap_or("").to_string(),
            current_revision: read_revision(conn, tenant, branch, AGG_CREDIT, credit_id)
                .map_err(|_| Transient("INTERNAL_ERROR_BEFORE_COMMIT"))?,
        });
    }
    // lazy cutover from the server's own branch-isolated snapshot — never payload
    let snap = latest_snapshot(conn, tenant, branch, "supplier_credits", credit_id)
        .map_err(|_| Transient("INTERNAL_ERROR_BEFORE_COMMIT"))?
        .ok_or(Transient("FINANCE_NOT_BOOTSTRAPPED"))?;
    let amount = snap_fils(&snap, "amount").ok_or(Transient("FINANCE_NOT_BOOTSTRAPPED"))?;
    let used = snap_fils_opt(&snap, "used_amount")?.unwrap_or(0);
    let supplier_id =
        str_field(&snap, "supplier_id").ok_or(Transient("FINANCE_NOT_BOOTSTRAPPED"))?;
    Ok(CreditState {
        amount_fils: amount,
        used_fils: used,
        supplier_id: supplier_id.to_string(),
        current_revision: 0,
    })
}

/// Materialise an expense (with its existing credit-settled total) the same way.
fn materialize_expense(
    conn: &Connection,
    tenant: &str,
    branch: &str,
    expense_id: &str,
) -> Result<ExpenseState, Transient> {
    if let Some((_recrev, proj)) =
        canonical_projection(conn, tenant, branch, "expenses", expense_id)
    {
        return Ok(ExpenseState {
            amount_fils: proj_fils(&proj, "amountFils"),
            non_credit_fils: proj_fils(&proj, "nonCreditPaidFils"),
            credit_paid_fils: proj_fils(&proj, "creditPaidFils"),
            supplier_id: proj["supplierId"].as_str().unwrap_or("").to_string(),
            current_revision: read_revision(conn, tenant, branch, AGG_EXPENSE, expense_id)
                .map_err(|_| Transient("INTERNAL_ERROR_BEFORE_COMMIT"))?,
        });
    }
    let snap = latest_snapshot(conn, tenant, branch, "expenses", expense_id)
        .map_err(|_| Transient("INTERNAL_ERROR_BEFORE_COMMIT"))?
        .ok_or(Transient("FINANCE_NOT_BOOTSTRAPPED"))?;
    let amount = snap_fils(&snap, "amount").ok_or(Transient("FINANCE_NOT_BOOTSTRAPPED"))?;
    let non_credit = snap_fils_opt(&snap, "paid_amount")?.unwrap_or(0);
    let supplier_id =
        str_field(&snap, "supplier_id").ok_or(Transient("FINANCE_NOT_BOOTSTRAPPED"))?;
    let credit_paid = sum_active_credit_payments(conn, tenant, branch, expense_id)
        .map_err(|_| Transient("FINANCE_NOT_BOOTSTRAPPED"))?;
    Ok(ExpenseState {
        amount_fils: amount,
        non_credit_fils: non_credit,
        credit_paid_fils: credit_paid,
        supplier_id: supplier_id.to_string(),
        current_revision: 0,
    })
}

/// Required BHD field of a server snapshot → fils (a bad value fails cutover).
fn snap_fils(snap: &Value, key: &str) -> Option<i64> {
    snap.get(key).and_then(|v| bhd_value_to_fils(v).ok())
}

/// Optional BHD field → fils; present-but-invalid fails cutover (NOT_BOOTSTRAPPED).
fn snap_fils_opt(snap: &Value, key: &str) -> Result<Option<i64>, Transient> {
    match snap.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => bhd_value_to_fils(v)
            .map(Some)
            .map_err(|_| Transient("FINANCE_NOT_BOOTSTRAPPED")),
    }
}

/// Look up a stored final decision for idempotency.
fn stored_decision(
    conn: &Connection,
    tenant: &str,
    operation_id: &str,
) -> rusqlite::Result<Option<(String, String, Option<String>, String)>> {
    conn.query_row(
        "SELECT status, payload_hash, error_code, result_json FROM operations
         WHERE tenant_id = ?1 AND operation_id = ?2",
        params![tenant, operation_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )
    .optional()
}

/// Map a stored row to a replay/reuse decision against the incoming hash.
fn replay_or_reuse(
    stored: (String, String, Option<String>, String),
    incoming_hash: &str,
) -> Decision {
    let (status, hash, error_code, result_json) = stored;
    if hash != incoming_hash {
        return Decision::OperationIdReused;
    }
    let result = serde_json::from_str(&result_json).unwrap_or(Value::Null);
    Decision::Replay {
        status,
        error_code,
        result,
    }
}

/// A parsed allocation line from the payload.
struct AllocLine {
    expense_id: String,
    amount_fils: i64,
    expected_expense_revision: i64,
}

/// Submit `APPLY_SUPPLIER_CREDIT_TO_EXPENSES`. `now` is the server timestamp
/// (passed in so the function stays deterministic/testable).
pub fn submit(conn: &Connection, claims: &Claims, payload: &Value, now: &str) -> Decision {
    // ── static payload validation (no DB, no tx) ──
    if let Err(e) = validate_settlement_payload(payload) {
        return Decision::ValidationRejected {
            error_code: e.code().to_string(),
            result: json!({ "reason": "static payload validation failed" }),
        };
    }
    if str_field(payload, "operationType") != Some(PILOT_OPERATION_TYPE) {
        return Decision::ValidationRejected {
            error_code: "UNSUPPORTED_OPERATION_TYPE".to_string(),
            result: json!({ "operationType": str_field(payload, "operationType") }),
        };
    }
    let operation_id = match str_field(payload, "operationId") {
        Some(s) => s.to_string(),
        None => {
            return Decision::ValidationRejected {
                error_code: "INVALID_OPERATION_ID".to_string(),
                result: Value::Null,
            }
        }
    };
    // Branch is authoritative from the JWT — the payload may not override it.
    if str_field(payload, "branchId") != Some(claims.branch_id.as_str()) {
        return Decision::ValidationRejected {
            error_code: "BRANCH_MISMATCH".to_string(),
            result: json!({ "reason": "payload branchId does not match authenticated branch" }),
        };
    }
    let payload_hash = match payload_hash_hex(payload) {
        Ok(h) => h,
        Err(e) => {
            return Decision::ValidationRejected {
                error_code: e.code().to_string(),
                result: Value::Null,
            }
        }
    };

    // ── pre-transaction idempotency (fast path) ──
    if let Ok(Some(stored)) = stored_decision(conn, &claims.tenant_id, &operation_id) {
        return replay_or_reuse(stored, &payload_hash);
    }

    // ── atomic transaction ──
    if conn.execute_batch("BEGIN IMMEDIATE").is_err() {
        return Decision::Transient {
            code: "DB_LOCKED".to_string(),
        };
    }
    match submit_in_tx(conn, claims, payload, &operation_id, &payload_hash, now) {
        Ok(decision) => {
            if conn.execute_batch("COMMIT").is_err() {
                let _ = conn.execute_batch("ROLLBACK");
                return Decision::Transient {
                    code: "INTERNAL_ERROR_BEFORE_COMMIT".to_string(),
                };
            }
            decision
        }
        Err(Transient(code)) => {
            let _ = conn.execute_batch("ROLLBACK");
            Decision::Transient {
                code: code.to_string(),
            }
        }
    }
}

/// The transactional core. Returns a final decision (its writes already done) or
/// a [`Transient`] to roll back.
fn submit_in_tx(
    conn: &Connection,
    claims: &Claims,
    payload: &Value,
    operation_id: &str,
    payload_hash: &str,
    now: &str,
) -> Result<Decision, Transient> {
    let tenant = &claims.tenant_id;
    let branch = &claims.branch_id;

    // Re-check idempotency inside the serialized transaction.
    if let Some(stored) = stored_decision(conn, tenant, operation_id)
        .map_err(|_| Transient("INTERNAL_ERROR_BEFORE_COMMIT"))?
    {
        return Ok(replay_or_reuse(stored, payload_hash));
    }

    // The write lock (BEGIN IMMEDIATE) is now held; a race test may pause here.
    #[cfg(test)]
    checkpoint(test_hooks::Checkpoint::TxStarted)?;

    // ── static business shape ──
    let credit_id = match str_field(payload, "creditId") {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => {
            return reject_validation(
                conn,
                claims,
                operation_id,
                payload,
                payload_hash,
                now,
                "INVALID_CREDIT_ID",
            )
        }
    };
    let expected_credit_rev = match i64_str(payload, "expectedCreditRevision") {
        Some(v) => v,
        None => {
            return reject_validation(
                conn,
                claims,
                operation_id,
                payload,
                payload_hash,
                now,
                "INVALID_EXPECTED_REVISION",
            )
        }
    };
    let allocs_json = match payload.get("allocations").and_then(|v| v.as_array()) {
        Some(a) if !a.is_empty() => a,
        _ => {
            return reject_validation(
                conn,
                claims,
                operation_id,
                payload,
                payload_hash,
                now,
                "NO_ALLOCATIONS",
            )
        }
    };
    let mut lines: Vec<AllocLine> = Vec::with_capacity(allocs_json.len());
    for a in allocs_json {
        let expense_id = match str_field(a, "expenseId") {
            Some(s) if !s.is_empty() => s.to_string(),
            _ => {
                return reject_validation(
                    conn,
                    claims,
                    operation_id,
                    payload,
                    payload_hash,
                    now,
                    "INVALID_ALLOCATION",
                )
            }
        };
        let amount = match i64_str(a, "amountFils") {
            Some(v) => v,
            None => {
                return reject_validation(
                    conn,
                    claims,
                    operation_id,
                    payload,
                    payload_hash,
                    now,
                    "INVALID_AMOUNT",
                )
            }
        };
        if amount <= 0 {
            return reject_validation(
                conn,
                claims,
                operation_id,
                payload,
                payload_hash,
                now,
                "INVALID_AMOUNT",
            );
        }
        let exp_rev = match i64_str(a, "expectedExpenseRevision") {
            Some(v) => v,
            None => {
                return reject_validation(
                    conn,
                    claims,
                    operation_id,
                    payload,
                    payload_hash,
                    now,
                    "INVALID_EXPECTED_REVISION",
                )
            }
        };
        lines.push(AllocLine {
            expense_id,
            amount_fils: amount,
            expected_expense_revision: exp_rev,
        });
    }

    // Deterministic order + duplicate-expense rejection (one credit per op).
    let alloc_items: Vec<Allocation> = lines
        .iter()
        .map(|l| Allocation {
            expense_id: l.expense_id.clone(),
            credit_id: credit_id.clone(),
        })
        .collect();
    let ordered = match order_allocations(&alloc_items) {
        Ok(o) => o,
        Err(e) => {
            return reject_validation(
                conn,
                claims,
                operation_id,
                payload,
                payload_hash,
                now,
                e.code(),
            )
        }
    };

    // ── materialise authoritative state (lazy cutover) ──
    let credit = materialize_credit(conn, tenant, branch, &credit_id)?;

    // Credit revision CAS.
    if expected_credit_rev != credit.current_revision {
        return store_conflict(
            conn,
            claims,
            operation_id,
            payload,
            payload_hash,
            now,
            "STALE_REVISION",
            json!({ "aggregate": AGG_CREDIT, "creditId": credit_id,
                    "expectedRevision": expected_credit_rev.to_string(),
                    "currentRevision": credit.current_revision.to_string() }),
        );
    }

    // Materialise each referenced expense once; check supplier + revision.
    let mut expenses: std::collections::BTreeMap<String, ExpenseState> =
        std::collections::BTreeMap::new();
    let mut expected_exp_rev: std::collections::BTreeMap<String, i64> =
        std::collections::BTreeMap::new();
    for l in &lines {
        expected_exp_rev.insert(l.expense_id.clone(), l.expected_expense_revision);
    }
    for expense_id in expected_exp_rev.keys() {
        let e = materialize_expense(conn, tenant, branch, expense_id)?;
        if e.supplier_id != credit.supplier_id {
            return store_conflict(
                conn,
                claims,
                operation_id,
                payload,
                payload_hash,
                now,
                "SUPPLIER_OR_BRANCH_MISMATCH",
                json!({ "expenseId": expense_id, "expenseSupplier": e.supplier_id,
                        "creditSupplier": credit.supplier_id }),
            );
        }
        let exp = expected_exp_rev[expense_id];
        if exp != e.current_revision {
            return store_conflict(
                conn,
                claims,
                operation_id,
                payload,
                payload_hash,
                now,
                "STALE_REVISION",
                json!({ "aggregate": AGG_EXPENSE, "expenseId": expense_id,
                        "expectedRevision": exp.to_string(),
                        "currentRevision": e.current_revision.to_string() }),
            );
        }
        expenses.insert(expense_id.clone(), e);
    }

    // ── economic validation against the materialised state (→ conflict) ──
    // Per-expense applied total (a single op never lists the same expense twice;
    // order_allocations already rejected duplicates).
    let mut applied_per_expense: std::collections::BTreeMap<String, i64> =
        std::collections::BTreeMap::new();
    let mut total: i64 = 0;
    for l in &lines {
        let entry = applied_per_expense.entry(l.expense_id.clone()).or_insert(0);
        *entry = entry
            .checked_add(l.amount_fils)
            .ok_or(Transient("INTERNAL_ERROR_BEFORE_COMMIT"))?;
        total = total
            .checked_add(l.amount_fils)
            .ok_or(Transient("INTERNAL_ERROR_BEFORE_COMMIT"))?;
    }

    let available = credit.amount_fils - credit.used_fils;
    if total > available {
        return store_conflict(
            conn,
            claims,
            operation_id,
            payload,
            payload_hash,
            now,
            "CREDIT_OVERDRAWN",
            json!({ "creditId": credit_id, "availableFils": available.to_string(),
                    "requestedFils": total.to_string() }),
        );
    }
    for (expense_id, applied) in &applied_per_expense {
        let e = &expenses[expense_id];
        let settled = e.non_credit_fils + e.credit_paid_fils;
        let open = e.amount_fils - settled;
        if open <= 0 {
            return store_conflict(
                conn,
                claims,
                operation_id,
                payload,
                payload_hash,
                now,
                "EXPENSE_ALREADY_SETTLED",
                json!({ "expenseId": expense_id }),
            );
        }
        if *applied > open {
            return store_conflict(
                conn,
                claims,
                operation_id,
                payload,
                payload_hash,
                now,
                "EXPENSE_OVERPAID",
                json!({ "expenseId": expense_id, "openFils": open.to_string(),
                        "appliedFils": applied.to_string() }),
            );
        }
    }

    // ── ACCEPTED: write the full authoritative effect ──
    #[cfg(test)]
    checkpoint(test_hooks::Checkpoint::AfterLazyMaterialization)?;

    let txn_id = ChildId::LedgerTransaction { operation_id }
        .derive()
        .map_err(|_| Transient("INTERNAL_ERROR_BEFORE_COMMIT"))?;

    // 1) operation row + serverSequence.
    conn.execute(
        "INSERT INTO operations
           (tenant_id, operation_id, branch_id, operation_type, protocol_version, client_id,
            actor_id, payload_hash, canonical_payload_json, status, result_json, error_code,
            ledger_transaction_id, created_at, committed_at)
         VALUES (?1,?2,?3,?4,4,NULL,?5,?6,?7,'accepted','{}',NULL,?8,?9,?9)",
        params![
            tenant,
            operation_id,
            branch,
            PILOT_OPERATION_TYPE,
            claims.sub,
            payload_hash,
            canon(payload).unwrap_or_else(|_| "{}".into()),
            txn_id,
            now
        ],
    )
    .map_err(|_| Transient("INTERNAL_ERROR_BEFORE_COMMIT"))?;
    conn.execute(
        "INSERT INTO operation_sequence (tenant_id, branch_id, operation_id, created_at)
         VALUES (?1,?2,?3,?4)",
        params![tenant, branch, operation_id, now],
    )
    .map_err(|_| Transient("INTERNAL_ERROR_BEFORE_COMMIT"))?;
    let server_sequence: i64 = conn.last_insert_rowid();
    #[cfg(test)]
    checkpoint(test_hooks::Checkpoint::AfterSequenceAssigned)?;

    // 2) authoritative ledger — one balanced transaction, DR AP / CR SUPPLIER_CREDIT.
    let legs = vec![
        LedgerLeg {
            leg_role: "AP_SETTLE".into(),
            source_id: operation_id.to_string(),
            account: ACCOUNT_AP.into(),
            direction: "DEBIT".into(),
            counterparty_type: COUNTERPARTY_SUPPLIER.into(),
            counterparty_id: credit.supplier_id.clone(),
            amount_fils: total.to_string(),
        },
        LedgerLeg {
            leg_role: "CREDIT_CONSUME".into(),
            source_id: operation_id.to_string(),
            account: ACCOUNT_SUPPLIER_CREDIT.into(),
            direction: "CREDIT".into(),
            counterparty_type: COUNTERPARTY_SUPPLIER.into(),
            counterparty_id: credit.supplier_id.clone(),
            amount_fils: total.to_string(),
        },
    ];
    let ordered_legs =
        order_ledger_legs(&legs).map_err(|_| Transient("INTERNAL_ERROR_BEFORE_COMMIT"))?;
    let mut ledger_entries_out: Vec<Value> = Vec::new();
    for ol in &ordered_legs {
        let entry_no = next_entry_no(conn, tenant, branch, now)?;
        let entry_id = ChildId::LedgerEntry {
            operation_id,
            ordinal: ol.ordinal,
            direction: &ol.direction,
            account: &ol.account,
        }
        .derive()
        .map_err(|_| Transient("INTERNAL_ERROR_BEFORE_COMMIT"))?;
        let leg_role = if ol.direction == "DEBIT" {
            "AP_SETTLE"
        } else {
            "CREDIT_CONSUME"
        };
        conn.execute(
            "INSERT INTO auth_ledger_entries
               (tenant_id, id, branch_id, entry_no, transaction_id, operation_id, occurred_at,
                recorded_at, account, direction, amount_fils, currency, counterparty_type,
                counterparty_id, source_module, source_id, leg_role, metadata_json, created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?7,?8,?9,?10,'BHD',?11,?12,?13,?6,?14,NULL,?7)",
            params![
                tenant,
                entry_id,
                branch,
                entry_no,
                txn_id,
                operation_id,
                now,
                ol.account,
                ol.direction,
                total,
                COUNTERPARTY_SUPPLIER,
                credit.supplier_id,
                SOURCE_MODULE,
                leg_role
            ],
        )
        .map_err(|_| Transient("INTERNAL_ERROR_BEFORE_COMMIT"))?;
        ledger_entries_out.push(json!({
            "id": entry_id, "entryNo": entry_no.to_string(), "account": ol.account,
            "direction": ol.direction, "amountFils": total.to_string(),
            "counterpartyType": COUNTERPARTY_SUPPLIER, "counterpartyId": credit.supplier_id,
        }));
    }

    #[cfg(test)]
    checkpoint(test_hooks::Checkpoint::AfterLedgerEffectsWritten)?;

    // 3) update the credit projection (used += total), bump its revision once.
    let new_used = credit.used_fils + total;
    let cp = build_credit_projection(&credit.supplier_id, credit.amount_fils, new_used)?;
    let new_credit_rev = bump_revision(conn, tenant, branch, AGG_CREDIT, &credit_id, now)?;
    #[cfg(test)]
    checkpoint(test_hooks::Checkpoint::AfterFirstRevisionBumped)?;
    let credit_proj_json = credit_projection_json(&credit_id, tenant, branch, &cp);
    write_projection(
        conn,
        tenant,
        branch,
        "supplier_credits",
        &credit_id,
        new_credit_rev,
        &credit_proj_json,
        now,
    )?;
    #[cfg(test)]
    checkpoint(test_hooks::Checkpoint::AfterCreditProjectionUpdated)?;

    // 4) update each expense projection (creditPaid += applied), bump once each.
    // mutation_specs: (table, recordId, recordRevision, wire payload).
    let mut mutation_specs: Vec<(String, String, i64, Value)> = Vec::new();
    mutation_specs.push((
        "supplier_credits".into(),
        credit_id.clone(),
        new_credit_rev,
        json!({
            "id": credit_id, "supplierId": credit.supplier_id,
            "amountFils": cp.amount_fils.to_string(), "usedAmountFils": cp.used_amount_fils.to_string(),
            "availableAmountFils": cp.available_amount_fils.to_string(), "status": cp.status,
        }),
    ));
    #[cfg(test)]
    let mut first_expense = true;
    for (expense_id, applied) in &applied_per_expense {
        let e = &expenses[expense_id];
        let new_credit_paid = e.credit_paid_fils + applied;
        let ep = build_expense_projection(
            &e.supplier_id,
            e.amount_fils,
            e.non_credit_fils,
            new_credit_paid,
        )?;
        let new_exp_rev = bump_revision(conn, tenant, branch, AGG_EXPENSE, expense_id, now)?;
        let exp_proj_json = expense_projection_json(expense_id, tenant, branch, &ep);
        write_projection(
            conn,
            tenant,
            branch,
            "expenses",
            expense_id,
            new_exp_rev,
            &exp_proj_json,
            now,
        )?;
        #[cfg(test)]
        if first_expense {
            checkpoint(test_hooks::Checkpoint::AfterFirstExpenseProjectionUpdated)?;
            first_expense = false;
        }
        mutation_specs.push((
            "expenses".into(),
            expense_id.clone(),
            new_exp_rev,
            json!({
                "id": expense_id, "supplierId": ep.supplier_id,
                "amountFils": ep.amount_fils.to_string(),
                "nonCreditPaidFils": ep.non_credit_paid_fils.to_string(),
                "creditPaidFils": ep.credit_paid_fils.to_string(),
                "settledFils": ep.settled_fils.to_string(), "openFils": ep.open_fils.to_string(),
                "status": ep.status,
            }),
        ));
    }

    // 5) deterministic expense_payment rows (delivered via the envelope/mutations).
    #[cfg(test)]
    let mut first_payment = true;
    for oa in &ordered {
        let amount = lines
            .iter()
            .find(|l| l.expense_id == oa.expense_id)
            .map(|l| l.amount_fils)
            .ok_or(Transient("INTERNAL_ERROR_BEFORE_COMMIT"))?;
        let payment_id = ChildId::ExpensePayment {
            operation_id,
            expense_id: &oa.expense_id,
            credit_id: &oa.credit_id,
            ordinal: oa.ordinal,
        }
        .derive()
        .map_err(|_| Transient("INTERNAL_ERROR_BEFORE_COMMIT"))?;
        mutation_specs.push((
            "expense_payments".into(),
            payment_id.clone(),
            1,
            json!({
                "id": payment_id, "expenseId": oa.expense_id, "creditId": oa.credit_id,
                "amountFils": amount.to_string(), "method": "credit", "operationId": operation_id,
            }),
        ));
        #[cfg(test)]
        if first_payment {
            checkpoint(test_hooks::Checkpoint::AfterFirstPaymentPrepared)?;
            first_payment = false;
        }
    }

    // 6) canonicalise mutation order by [table, recordId]; dense ordinals.
    mutation_specs.sort_by(|a, b| (a.0.as_str(), a.1.as_str()).cmp(&(b.0.as_str(), b.1.as_str())));
    let envelope_mutations: Vec<Value> = mutation_specs
        .iter()
        .enumerate()
        .map(|(i, (table, rid, rev, payload))| {
            json!({
                "ordinal": i as u64, "action": "upsert", "table": table,
                "recordId": rid, "recordRevision": rev.to_string(), "payload": payload,
            })
        })
        .collect();

    // 7) full operation envelope (FK target of operation_mutations → insert first).
    let envelope = json!({
        "operationId": operation_id,
        "serverSequence": server_sequence.to_string(),
        "operationType": PILOT_OPERATION_TYPE,
        "branchId": branch,
        "mutationCount": envelope_mutations.len() as u64,
        "mutations": envelope_mutations,
        "ledger": { "transactionId": txn_id, "entries": ledger_entries_out },
        "result": {
            "status": "accepted",
            "creditId": credit_id,
            "newCreditRevision": new_credit_rev.to_string(),
        },
    });
    let env_canonical = canon(&envelope).map_err(|_| Transient("INTERNAL_ERROR_BEFORE_COMMIT"))?;
    let env_bytes = env_canonical.as_bytes().len() as i64;
    conn.execute(
        "INSERT INTO operation_envelopes
           (tenant_id, branch_id, operation_id, server_sequence, envelope_json, byte_size, mutation_count, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![
            tenant,
            branch,
            operation_id,
            server_sequence,
            env_canonical,
            env_bytes,
            mutation_specs.len() as i64,
            now
        ],
    )
    .map_err(|_| Transient("INTERNAL_ERROR_BEFORE_COMMIT"))?;
    #[cfg(test)]
    checkpoint(test_hooks::Checkpoint::AfterEnvelopeWritten)?;

    // 8) the canonical-ordered mutation rows.
    for (ordinal, (table, rid, rev, payload)) in mutation_specs.iter().enumerate() {
        conn.execute(
            "INSERT INTO operation_mutations
               (tenant_id, operation_id, ordinal, branch_id, action, table_name, record_id, record_revision, payload_json, created_at)
             VALUES (?1,?2,?3,?4,'upsert',?5,?6,?7,?8,?9)",
            params![
                tenant,
                operation_id,
                ordinal as i64,
                branch,
                table,
                rid,
                (*rev).max(1),
                serde_json::to_string(payload).unwrap_or_else(|_| "{}".into()),
                now
            ],
        )
        .map_err(|_| Transient("INTERNAL_ERROR_BEFORE_COMMIT"))?;
        #[cfg(test)]
        if ordinal == 0 {
            checkpoint(test_hooks::Checkpoint::AfterFirstMutationWritten)?;
        }
    }

    // 9) finalise the operation result_json.
    let result = json!({
        "creditId": credit_id,
        "newCreditRevision": new_credit_rev.to_string(),
        "appliedFils": total.to_string(),
        "ledgerTransactionId": txn_id,
        "ledgerEntries": ledger_entries_out,
        "mutations": envelope.get("mutations").cloned().unwrap_or(Value::Null),
    });
    conn.execute(
        "UPDATE operations SET result_json = ?1 WHERE tenant_id = ?2 AND operation_id = ?3",
        params![
            serde_json::to_string(&result).unwrap_or_else(|_| "{}".into()),
            tenant,
            operation_id
        ],
    )
    .map_err(|_| Transient("INTERNAL_ERROR_BEFORE_COMMIT"))?;

    Ok(Decision::Accepted {
        server_sequence,
        result,
    })
}

/// Reserve the next per-branch ledger entry number.
fn next_entry_no(
    conn: &Connection,
    tenant: &str,
    branch: &str,
    now: &str,
) -> Result<i64, Transient> {
    conn.execute(
        "INSERT INTO ledger_sequence (tenant_id, branch_id, next_entry_no, updated_at)
         VALUES (?1,?2,1,?3) ON CONFLICT(tenant_id, branch_id) DO NOTHING",
        params![tenant, branch, now],
    )
    .map_err(|_| Transient("INTERNAL_ERROR_BEFORE_COMMIT"))?;
    let n: i64 = conn
        .query_row(
            "SELECT next_entry_no FROM ledger_sequence WHERE tenant_id=?1 AND branch_id=?2",
            params![tenant, branch],
            |r| r.get(0),
        )
        .map_err(|_| Transient("INTERNAL_ERROR_BEFORE_COMMIT"))?;
    conn.execute(
        "UPDATE ledger_sequence SET next_entry_no = ?3, updated_at = ?4 WHERE tenant_id=?1 AND branch_id=?2",
        params![tenant, branch, n + 1, now],
    )
    .map_err(|_| Transient("INTERNAL_ERROR_BEFORE_COMMIT"))?;
    Ok(n)
}

/// Persist a final `validation_rejected` decision (idempotent replay basis).
fn reject_validation(
    conn: &Connection,
    claims: &Claims,
    operation_id: &str,
    payload: &Value,
    payload_hash: &str,
    now: &str,
    error_code: &str,
) -> Result<Decision, Transient> {
    let result = json!({ "reason": error_code });
    store_final(
        conn,
        claims,
        operation_id,
        payload,
        payload_hash,
        now,
        "validation_rejected",
        error_code,
        &result,
    )?;
    Ok(Decision::ValidationRejected {
        error_code: error_code.to_string(),
        result,
    })
}

/// Persist a final `conflict` decision (idempotent replay basis).
fn store_conflict(
    conn: &Connection,
    claims: &Claims,
    operation_id: &str,
    payload: &Value,
    payload_hash: &str,
    now: &str,
    error_code: &str,
    detail: Value,
) -> Result<Decision, Transient> {
    store_final(
        conn,
        claims,
        operation_id,
        payload,
        payload_hash,
        now,
        "conflict",
        error_code,
        &detail,
    )?;
    Ok(Decision::Conflict {
        error_code: error_code.to_string(),
        result: detail,
    })
}

#[allow(clippy::too_many_arguments)]
fn store_final(
    conn: &Connection,
    claims: &Claims,
    operation_id: &str,
    payload: &Value,
    payload_hash: &str,
    now: &str,
    status: &str,
    error_code: &str,
    result: &Value,
) -> Result<(), Transient> {
    conn.execute(
        "INSERT INTO operations
           (tenant_id, operation_id, branch_id, operation_type, protocol_version, client_id,
            actor_id, payload_hash, canonical_payload_json, status, result_json, error_code,
            ledger_transaction_id, created_at, committed_at)
         VALUES (?1,?2,?3,?4,4,NULL,?5,?6,?7,?8,?9,?10,NULL,?11,?11)",
        params![
            claims.tenant_id,
            operation_id,
            claims.branch_id,
            PILOT_OPERATION_TYPE,
            claims.sub,
            payload_hash,
            canon(payload).unwrap_or_else(|_| "{}".into()),
            status,
            serde_json::to_string(result).unwrap_or_else(|_| "{}".into()),
            error_code,
            now
        ],
    )
    .map_err(|_| Transient("INTERNAL_ERROR_BEFORE_COMMIT"))?;
    Ok(())
}

/// Operation status (no re-execution). Tenant- AND branch-isolated; includes the
/// full envelope (and its revisions/mutations) for an accepted operation. A GET
/// never re-runs and never overwrites the stored final decision.
pub fn get_status(
    conn: &Connection,
    tenant: &str,
    branch: &str,
    operation_id: &str,
) -> Option<Value> {
    let stored: Option<(String, String, Option<String>, String)> = conn
        .query_row(
            "SELECT status, payload_hash, error_code, result_json FROM operations
             WHERE tenant_id = ?1 AND branch_id = ?2 AND operation_id = ?3",
            params![tenant, branch, operation_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .ok()
        .flatten();
    match stored {
        None => Some(json!({ "operationId": operation_id, "status": "unknown" })),
        Some((status, hash, error_code, result_json)) => {
            let row: Option<(i64, String)> = conn
                .query_row(
                    "SELECT e.server_sequence, e.envelope_json
                     FROM operation_envelopes e
                     WHERE e.tenant_id=?1 AND e.branch_id=?2 AND e.operation_id=?3",
                    params![tenant, branch, operation_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .ok()
                .flatten();
            let (server_sequence, envelope) = match row {
                Some((seq, env)) => (
                    Some(seq.to_string()),
                    serde_json::from_str::<Value>(&env).unwrap_or(Value::Null),
                ),
                None => (None, Value::Null),
            };
            Some(json!({
                "operationId": operation_id,
                "status": status,
                "payloadHash": hash,
                "errorCode": error_code,
                "serverSequence": server_sequence,
                "result": serde_json::from_str::<Value>(&result_json).unwrap_or(Value::Null),
                "envelope": envelope,
            }))
        }
    }
}

/// Test-only failure-injection + concurrency-coordination hook. It is compiled
/// out of the production binary entirely (`#[cfg(test)]`) — the production
/// `submit` contract is unchanged, there is no public flag, route or env switch.
/// A test installs a per-thread callback invoked at each named checkpoint inside
/// the OPEN transaction: returning `Err(())` injects a failure *after* that
/// phase (forcing the normal full rollback), and the callback may block to
/// coordinate a genuinely concurrent race (e.g. hold the write lock at
/// `TxStarted` until the other writer is provably blocked).
#[cfg(test)]
pub(crate) mod test_hooks {
    use std::cell::RefCell;

    #[derive(Clone, Copy, PartialEq, Eq, Debug)]
    pub(crate) enum Checkpoint {
        TxStarted,
        AfterLazyMaterialization,
        AfterSequenceAssigned,
        AfterLedgerEffectsWritten,
        AfterFirstRevisionBumped,
        AfterCreditProjectionUpdated,
        AfterFirstExpenseProjectionUpdated,
        AfterFirstPaymentPrepared,
        AfterEnvelopeWritten,
        AfterFirstMutationWritten,
    }

    type Hook = Box<dyn FnMut(Checkpoint) -> Result<(), ()> + Send>;
    thread_local! {
        static HOOK: RefCell<Option<Hook>> = const { RefCell::new(None) };
    }

    pub(crate) fn install(f: Hook) {
        HOOK.with(|h| *h.borrow_mut() = Some(f));
    }
    pub(crate) fn clear() {
        HOOK.with(|h| *h.borrow_mut() = None);
    }
    /// Invoke the installed hook (if any). The hook is taken out for the call so
    /// a blocking callback never holds the `RefCell` borrow. No hook → `Ok`.
    pub(crate) fn fire(cp: Checkpoint) -> Result<(), ()> {
        let hook = HOOK.with(|h| h.borrow_mut().take());
        match hook {
            Some(mut f) => {
                let r = f(cp);
                HOOK.with(|h| *h.borrow_mut() = Some(f));
                r
            }
            None => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests;
