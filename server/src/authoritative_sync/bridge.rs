//! B0 — schema-oriented legacy bridge over an atomic `sync_push` batch.
//!
//! The whole batch is processed in ONE `BEGIN IMMEDIATE` transaction and is
//! **order-independent**: every change is first classified and merged into a
//! final planned state per affected aggregate, the final state is validated,
//! authoritative settlement projections are recomputed, server-cleaned snapshots
//! are written, and each affected aggregate revision is bumped **at most once**.
//! Any error rolls the entire batch back — no changelog row, no projection, no
//! revision, no partial relay.
//!
//! Protection is per aggregate: a record is server-authoritative iff it has a
//! `canonical_records` projection row (created by the B1 operation). Before
//! cutover nothing is protected and the batch is a plain atomic relay, so legacy
//! behaviour is unchanged.
//!
//! Settlement contract (unchanged): `settled = expenses.paid_amount` (the
//! non-credit cash/bank/benefit total) `+ Σ active method='credit' payments`.
//! Non-credit payment rows are identity/validation only — never summed a second
//! time on top of `paid_amount`.

use crate::models::SyncPushChange;
use lataif_server::money::bhd_value_to_fils;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

/// Stable B0 error contract (no raw SQL ever leaves the server).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BatchError {
    InvalidLegacySchema(String),
    UnknownField(String),
    IncompletePaymentBatch(String),
    ProtectedCreditPayment(String),
    ProtectedCreditDeleteRefund(String),
    ProtectedExpenseCancelDelete(String),
    SupplierChangeLocked(String),
    SettlementOverpayment(String),
    InvalidMoney(String),
    TenantBranchContradiction(String),
    Internal,
}

impl BatchError {
    pub fn code(&self) -> &'static str {
        match self {
            BatchError::InvalidLegacySchema(_) => "B0_INVALID_LEGACY_SCHEMA",
            BatchError::UnknownField(_) => "B0_UNKNOWN_FIELD",
            BatchError::IncompletePaymentBatch(_) => "B0_INCOMPLETE_PAYMENT_BATCH",
            BatchError::ProtectedCreditPayment(_) => "B0_PROTECTED_CREDIT_PAYMENT",
            BatchError::ProtectedCreditDeleteRefund(_) => "B0_PROTECTED_CREDIT_DELETE_REFUND",
            BatchError::ProtectedExpenseCancelDelete(_) => "B0_PROTECTED_EXPENSE_CANCEL_DELETE",
            BatchError::SupplierChangeLocked(_) => "B0_SUPPLIER_CHANGE_LOCKED",
            BatchError::SettlementOverpayment(_) => "B0_SETTLEMENT_OVERPAYMENT",
            BatchError::InvalidMoney(_) => "B0_INVALID_MONEY",
            BatchError::TenantBranchContradiction(_) => "B0_TENANT_BRANCH_CONTRADICTION",
            BatchError::Internal => "B0_INTERNAL",
        }
    }
}

// ── strict per-table allowlists (only what a legacy client may carry) ──
// Fields not listed are rejected. Settlement fields are server-authoritative
// (never trusted from the payload once protected); immutable fields are pinned
// from the prior server snapshot.

const EXPENSE_AUTHORITATIVE: &[&str] = &["amount", "paid_amount", "status"];
const EXPENSE_IMMUTABLE: &[&str] = &["id", "branch_id", "created_at", "created_by"];
const EXPENSE_METADATA: &[&str] = &[
    "category",
    "description",
    "payment_method",
    "expense_date",
    "related_module",
    "related_entity_id",
    "recurring_template_id",
    "employee_id",
    "expense_number",
    "supplier_id", // locked: must equal prior snapshot (validated, not freely changed)
    "employee_id",
];

const CREDIT_AUTHORITATIVE: &[&str] = &["amount", "used_amount", "status"];
const CREDIT_IMMUTABLE: &[&str] = &[
    "id",
    "branch_id",
    "supplier_id",
    "source_return_id",
    "source_purchase_id",
    "created_at",
    "created_by",
];
const CREDIT_METADATA: &[&str] = &["note"];

const PAYMENT_FIELDS: &[&str] = &[
    "id",
    "expense_id",
    "amount",
    "method",
    "paid_at",
    "reference",
    "note",
    "created_at",
];

fn is_known_expense_field(f: &str) -> bool {
    EXPENSE_AUTHORITATIVE.contains(&f)
        || EXPENSE_IMMUTABLE.contains(&f)
        || EXPENSE_METADATA.contains(&f)
}
fn is_known_credit_field(f: &str) -> bool {
    CREDIT_AUTHORITATIVE.contains(&f)
        || CREDIT_IMMUTABLE.contains(&f)
        || CREDIT_METADATA.contains(&f)
}

/// Parse `change.data` as a JSON object.
fn data_obj(c: &SyncPushChange) -> Result<Map<String, Value>, BatchError> {
    if c.action == "delete" {
        return Ok(Map::new());
    }
    match serde_json::from_str::<Value>(&c.data) {
        Ok(Value::Object(m)) => Ok(m),
        _ => Err(BatchError::InvalidLegacySchema(format!(
            "{}/{} non-object data",
            c.table_name, c.record_id
        ))),
    }
}

/// The adopted projection `(revision, data)` for a record, if protected.
fn projection(
    conn: &Connection,
    tenant: &str,
    branch: &str,
    table: &str,
    record_id: &str,
) -> Option<(i64, Value)> {
    super::canonical_projection(conn, tenant, branch, table, record_id)
}

fn is_protected(
    conn: &Connection,
    tenant: &str,
    branch: &str,
    table: &str,
    record_id: &str,
) -> bool {
    projection(conn, tenant, branch, table, record_id).is_some()
}

/// Resolve a payment's `(method, expense_id, reference)` identity from the
/// incoming snapshot, else from the server's own last snapshot (so removing
/// fields on an update/delete cannot evade the credit-payment guard).
fn resolve_payment_identity(
    conn: &Connection,
    tenant: &str,
    branch: &str,
    c: &SyncPushChange,
) -> (Option<String>, Option<String>, Option<String>) {
    let from = |v: &Value| {
        (
            v.get("method").and_then(|x| x.as_str()).map(String::from),
            v.get("expense_id")
                .and_then(|x| x.as_str())
                .map(String::from),
            v.get("reference")
                .and_then(|x| x.as_str())
                .map(String::from),
        )
    };
    if c.action != "delete" {
        if let Ok(Value::Object(m)) = serde_json::from_str::<Value>(&c.data) {
            let v = Value::Object(m);
            let (me, ex, re) = from(&v);
            if me.is_some() || ex.is_some() || re.is_some() {
                // backfill any missing field from the prior server snapshot
                if me.is_some() && ex.is_some() {
                    return (me, ex, re);
                }
            }
        }
    }
    // fall back to the server's own last snapshot of this payment id
    if let Ok(Some(prev)) =
        super::latest_snapshot(conn, tenant, branch, "expense_payments", &c.record_id)
    {
        let (pme, pex, pre) = from(&prev);
        // incoming wins where present, server snapshot fills the rest
        let inc = serde_json::from_str::<Value>(&c.data).ok();
        let (ime, iex, ire) = inc.as_ref().map(from).unwrap_or((None, None, None));
        return (ime.or(pme), iex.or(pex), ire.or(pre));
    }
    if let Ok(Value::Object(m)) = serde_json::from_str::<Value>(&c.data) {
        return from(&Value::Object(m));
    }
    (None, None, None)
}

/// True iff this change targets (or relates to) a protected aggregate.
fn touches_protected(conn: &Connection, tenant: &str, branch: &str, c: &SyncPushChange) -> bool {
    match c.table_name.as_str() {
        "expenses" => is_protected(conn, tenant, branch, "expenses", &c.record_id),
        "supplier_credits" => is_protected(conn, tenant, branch, "supplier_credits", &c.record_id),
        "expense_payments" => {
            let (_m, ex, re) = resolve_payment_identity(conn, tenant, branch, c);
            ex.map(|e| is_protected(conn, tenant, branch, "expenses", &e))
                .unwrap_or(false)
                || re
                    .map(|r| is_protected(conn, tenant, branch, "supplier_credits", &r))
                    .unwrap_or(false)
        }
        _ => false,
    }
}

/// Relay one change verbatim into `sync_changelog` (normal LWW path).
fn relay(
    conn: &Connection,
    tenant: &str,
    branch: &str,
    actor: &str,
    c: &SyncPushChange,
    now: &str,
) -> Result<(), BatchError> {
    conn.execute(
        "INSERT INTO sync_changelog (tenant_id, branch_id, table_name, record_id, action, data, user_id, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![tenant, branch, c.table_name, c.record_id, c.action, c.data, actor, now],
    )
    .map_err(|_| BatchError::Internal)?;
    Ok(())
}

/// Write a server-cleaned full snapshot (not the unchecked input JSON).
fn write_clean_snapshot(
    conn: &Connection,
    tenant: &str,
    branch: &str,
    actor: &str,
    table: &str,
    record_id: &str,
    action: &str,
    data: &Value,
    now: &str,
) -> Result<(), BatchError> {
    conn.execute(
        "INSERT INTO sync_changelog (tenant_id, branch_id, table_name, record_id, action, data, user_id, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![tenant, branch, table, record_id, action, data.to_string(), actor, now],
    )
    .map_err(|_| BatchError::Internal)?;
    Ok(())
}

/// A finalised expense settlement projection (all fields in fils).
struct ExpenseProjection {
    supplier_id: String,
    amount_fils: i64,
    non_credit_paid_fils: i64,
    credit_paid_fils: i64,
    settled_fils: i64,
    open_fils: i64,
    status: String,
}

fn build_expense_projection(
    supplier_id: &str,
    amount_fils: i64,
    non_credit_paid_fils: i64,
    credit_paid_fils: i64,
) -> Result<ExpenseProjection, BatchError> {
    if amount_fils < 0 || non_credit_paid_fils < 0 || credit_paid_fils < 0 {
        return Err(BatchError::InvalidMoney(
            "negative expense component".into(),
        ));
    }
    let settled = non_credit_paid_fils
        .checked_add(credit_paid_fils)
        .ok_or(BatchError::Internal)?;
    if settled > amount_fils {
        return Err(BatchError::SettlementOverpayment(format!(
            "settled {} > amount {}",
            settled, amount_fils
        )));
    }
    Ok(ExpenseProjection {
        supplier_id: supplier_id.to_string(),
        amount_fils,
        non_credit_paid_fils,
        credit_paid_fils,
        settled_fils: settled,
        open_fils: amount_fils - settled,
        status: if settled >= amount_fils {
            "PAID"
        } else {
            "PENDING"
        }
        .to_string(),
    })
}

fn expense_projection_json(
    expense_id: &str,
    tenant: &str,
    branch: &str,
    p: &ExpenseProjection,
) -> Value {
    json!({
        "expenseId": expense_id,
        "tenantId": tenant,
        "branchId": branch,
        "supplierId": p.supplier_id,
        "amountFils": p.amount_fils,
        "nonCreditPaidFils": p.non_credit_paid_fils,
        "creditPaidFils": p.credit_paid_fils,
        "settledFils": p.settled_fils,
        "openFils": p.open_fils,
        "status": p.status,
    })
}

/// Read fils from a prior projection field.
fn proj_fils(p: &Value, key: &str) -> i64 {
    p.get(key).and_then(|v| v.as_i64()).unwrap_or(0)
}

/// Bump (or create) an aggregate revision exactly once; returns the new value.
fn bump_revision(
    conn: &Connection,
    tenant: &str,
    branch: &str,
    agg_type: &str,
    agg_id: &str,
    now: &str,
) -> Result<i64, BatchError> {
    let current: i64 = conn
        .query_row(
            "SELECT revision FROM aggregate_revisions
             WHERE tenant_id=?1 AND branch_id=?2 AND aggregate_type=?3 AND aggregate_id=?4",
            params![tenant, branch, agg_type, agg_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| BatchError::Internal)?
        .unwrap_or(0);
    let next = current + 1;
    conn.execute(
        "INSERT INTO aggregate_revisions (tenant_id, branch_id, aggregate_type, aggregate_id, revision, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6)
         ON CONFLICT(tenant_id, branch_id, aggregate_type, aggregate_id)
         DO UPDATE SET revision=?5, updated_at=?6",
        params![tenant, branch, agg_type, agg_id, next, now],
    )
    .map_err(|_| BatchError::Internal)?;
    Ok(next)
}

/// Upsert a canonical projection row.
fn write_projection(
    conn: &Connection,
    tenant: &str,
    branch: &str,
    table: &str,
    record_id: &str,
    revision: i64,
    data: &Value,
    now: &str,
) -> Result<(), BatchError> {
    conn.execute(
        "INSERT INTO canonical_records
           (tenant_id, branch_id, table_name, record_id, record_revision, deleted, data_json, last_operation_id, updated_at)
         VALUES (?1,?2,?3,?4,?5,0,?6,'B0_BRIDGE',?7)
         ON CONFLICT(tenant_id, branch_id, table_name, record_id)
         DO UPDATE SET record_revision=?5, data_json=?6, last_operation_id='B0_BRIDGE', updated_at=?7",
        params![tenant, branch, table, record_id, revision.max(1), data.to_string(), now],
    )
    .map_err(|_| BatchError::Internal)?;
    Ok(())
}

/// Entry point: process the whole batch atomically.
pub fn process_sync_batch(
    conn: &Connection,
    tenant: &str,
    branch: &str,
    actor: &str,
    changes: &[SyncPushChange],
    now: &str,
) -> Result<usize, BatchError> {
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|_| BatchError::Internal)?;
    match process_in_tx(conn, tenant, branch, actor, changes, now) {
        Ok(n) => {
            conn.execute_batch("COMMIT")
                .map_err(|_| BatchError::Internal)?;
            Ok(n)
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

fn process_in_tx(
    conn: &Connection,
    tenant: &str,
    branch: &str,
    actor: &str,
    changes: &[SyncPushChange],
    now: &str,
) -> Result<usize, BatchError> {
    // Fast path: nothing protected → plain atomic relay (legacy semantics).
    let any_protected = changes
        .iter()
        .any(|c| touches_protected(conn, tenant, branch, c));
    if !any_protected {
        for c in changes {
            relay(conn, tenant, branch, actor, c, now)?;
        }
        return Ok(changes.len());
    }

    // ── Bridge mode ──
    // Group changes; everything not touching a protected aggregate is relayed
    // verbatim, but still inside this same transaction.
    let mut normal: Vec<&SyncPushChange> = Vec::new();
    // expense_id → (expense_change?, [non-credit payment changes])
    let mut expense_groups: BTreeMap<String, (Option<&SyncPushChange>, Vec<&SyncPushChange>)> =
        BTreeMap::new();
    let mut credit_changes: Vec<&SyncPushChange> = Vec::new();

    for c in changes {
        match c.table_name.as_str() {
            "expenses" if is_protected(conn, tenant, branch, "expenses", &c.record_id) => {
                expense_groups.entry(c.record_id.clone()).or_default().0 = Some(c);
            }
            "supplier_credits"
                if is_protected(conn, tenant, branch, "supplier_credits", &c.record_id) =>
            {
                credit_changes.push(c);
            }
            "expense_payments" => {
                let (method, ex, re) = resolve_payment_identity(conn, tenant, branch, c);
                let credit = method.as_deref() == Some("credit");
                let prot_credit = re
                    .as_deref()
                    .map(|r| is_protected(conn, tenant, branch, "supplier_credits", r))
                    .unwrap_or(false);
                let prot_expense = ex
                    .as_deref()
                    .map(|e| is_protected(conn, tenant, branch, "expenses", e));
                if credit || prot_credit {
                    // Credit-payment on a protected case → blocked (insert/update/delete).
                    return Err(BatchError::ProtectedCreditPayment(format!(
                        "expense_payments/{} method=credit protected",
                        c.record_id
                    )));
                }
                if prot_expense == Some(true) {
                    let e = ex.unwrap();
                    expense_groups.entry(e).or_default().1.push(c);
                } else {
                    normal.push(c);
                }
            }
            _ => normal.push(c),
        }
    }

    // ── protected supplier_credits: only `note` may change; everything else blocked ──
    for c in &credit_changes {
        let (_rev, proj) = projection(conn, tenant, branch, "supplier_credits", &c.record_id)
            .ok_or(BatchError::Internal)?;
        if c.action == "delete" {
            return Err(BatchError::ProtectedCreditDeleteRefund(format!(
                "supplier_credits/{}",
                c.record_id
            )));
        }
        let obj = data_obj(c)?;
        for k in obj.keys() {
            if !is_known_credit_field(k) {
                return Err(BatchError::UnknownField(format!("supplier_credits.{}", k)));
            }
        }
        if let Some(b) = obj.get("branch_id").and_then(|x| x.as_str()) {
            if b != branch {
                return Err(BatchError::TenantBranchContradiction(format!(
                    "supplier_credits/{}",
                    c.record_id
                )));
            }
        }
        // immutable / supplier pin
        if let Some(v) = obj.get("supplier_id").and_then(|x| x.as_str()) {
            if v != proj["supplierId"].as_str().unwrap_or("") {
                return Err(BatchError::SupplierChangeLocked(format!(
                    "supplier_credits/{}",
                    c.record_id
                )));
            }
        }
        // any authoritative-field change vs the projection → credit-consumption change → blocked
        let amount_fils = proj_fils(&proj, "amountFils");
        let used_fils = proj_fils(&proj, "usedAmountFils");
        if let Some(a) = obj.get("amount") {
            if bhd_value_to_fils(a).map_err(|e| BatchError::InvalidMoney(e.code().into()))?
                != amount_fils
            {
                return Err(BatchError::ProtectedCreditPayment(format!(
                    "supplier_credits/{} amount change",
                    c.record_id
                )));
            }
        }
        if let Some(u) = obj.get("used_amount") {
            if bhd_value_to_fils(u).map_err(|e| BatchError::InvalidMoney(e.code().into()))?
                != used_fils
            {
                return Err(BatchError::ProtectedCreditPayment(format!(
                    "supplier_credits/{} used_amount change",
                    c.record_id
                )));
            }
        }
        // note-only (or no-op): re-write the authoritative cleaned snapshot; no revision bump.
        let cleaned = credit_clean_snapshot(&proj, &obj, &c.record_id, branch);
        write_clean_snapshot(
            conn,
            tenant,
            branch,
            actor,
            "supplier_credits",
            &c.record_id,
            "update",
            &cleaned,
            now,
        )?;
    }

    // ── protected expenses: fold non-credit payments + amount/metadata edits ──
    for (expense_id, (expense_change, payment_changes)) in &expense_groups {
        let (rev, proj) =
            projection(conn, tenant, branch, "expenses", expense_id).ok_or(BatchError::Internal)?;
        let supplier_id = proj["supplierId"].as_str().unwrap_or("").to_string();
        let amount0 = proj_fils(&proj, "amountFils");
        let non_credit0 = proj_fils(&proj, "nonCreditPaidFils");
        let credit_paid = proj_fils(&proj, "creditPaidFils");

        // Cancel / delete of a credit-settled expense → blocked.
        if let Some(ec) = expense_change {
            if ec.action == "delete" {
                return Err(BatchError::ProtectedExpenseCancelDelete(format!(
                    "expenses/{} delete",
                    expense_id
                )));
            }
            let obj = data_obj(ec)?;
            for k in obj.keys() {
                if !is_known_expense_field(k) {
                    return Err(BatchError::UnknownField(format!("expenses.{}", k)));
                }
            }
            if let Some(b) = obj.get("branch_id").and_then(|x| x.as_str()) {
                if b != branch {
                    return Err(BatchError::TenantBranchContradiction(format!(
                        "expenses/{}",
                        expense_id
                    )));
                }
            }
            if obj.get("status").and_then(|v| v.as_str()) == Some("CANCELLED") && credit_paid > 0 {
                return Err(BatchError::ProtectedExpenseCancelDelete(format!(
                    "expenses/{} cancel",
                    expense_id
                )));
            }
            if let Some(s) = obj.get("supplier_id").and_then(|v| v.as_str()) {
                if s != supplier_id {
                    return Err(BatchError::SupplierChangeLocked(format!(
                        "expenses/{}",
                        expense_id
                    )));
                }
            }
        }

        // Non-credit payment deltas in the batch.
        let mut delta: i64 = 0;
        for pc in payment_changes {
            if pc.action == "delete" {
                // amount comes from the server's prior snapshot of that payment
                let prev =
                    super::latest_snapshot(conn, tenant, branch, "expense_payments", &pc.record_id)
                        .map_err(|_| BatchError::Internal)?;
                if let Some(p) = prev {
                    delta -= bhd_value_to_fils(p.get("amount").unwrap_or(&Value::Null))
                        .map_err(|e| BatchError::InvalidMoney(e.code().into()))?;
                }
            } else {
                let obj = data_obj(pc)?;
                for k in obj.keys() {
                    if !PAYMENT_FIELDS.contains(&k.as_str()) {
                        return Err(BatchError::UnknownField(format!("expense_payments.{}", k)));
                    }
                }
                delta += bhd_value_to_fils(obj.get("amount").unwrap_or(&Value::Null))
                    .map_err(|e| BatchError::InvalidMoney(e.code().into()))?;
            }
        }
        let expected_non_credit = non_credit0.checked_add(delta).ok_or(BatchError::Internal)?;

        // Amount edit (only via the expense change).
        let mut new_amount = amount0;
        let mut declared_non_credit: Option<i64> = None;
        if let Some(ec) = expense_change {
            let obj = data_obj(ec)?;
            if let Some(a) = obj.get("amount") {
                new_amount =
                    bhd_value_to_fils(a).map_err(|e| BatchError::InvalidMoney(e.code().into()))?;
            }
            if let Some(p) = obj.get("paid_amount") {
                declared_non_credit = Some(
                    bhd_value_to_fils(p).map_err(|e| BatchError::InvalidMoney(e.code().into()))?,
                );
            }
        }

        // Consistency: the declared paid_amount must equal the payment-implied total.
        match (declared_non_credit, payment_changes.is_empty()) {
            (Some(d), _) => {
                if d != expected_non_credit {
                    return Err(BatchError::IncompletePaymentBatch(format!(
                        "expenses/{} paid_amount {} != payments-implied {}",
                        expense_id, d, expected_non_credit
                    )));
                }
            }
            (None, false) => {
                // payments changed but the expense paid_amount was not updated
                return Err(BatchError::IncompletePaymentBatch(format!(
                    "expenses/{} payments changed without paid_amount update",
                    expense_id
                )));
            }
            (None, true) => {
                // pure metadata edit (or no expense change) → settlement unchanged
            }
        }
        let final_non_credit = declared_non_credit.unwrap_or(expected_non_credit);

        let p = build_expense_projection(&supplier_id, new_amount, final_non_credit, credit_paid)?;
        let changed = new_amount != amount0 || final_non_credit != non_credit0;
        let new_rev = if changed {
            bump_revision(conn, tenant, branch, "EXPENSE_SETTLEMENT", expense_id, now)?
        } else {
            rev.max(1)
        };
        let proj_json = expense_projection_json(expense_id, tenant, branch, &p);
        write_projection(
            conn, tenant, branch, "expenses", expense_id, new_rev, &proj_json, now,
        )?;

        // server-cleaned expenses snapshot for the changelog (authoritative fields enforced)
        let cleaned =
            expense_clean_snapshot(&proj, expense_change.as_ref(), &p, expense_id, branch)?;
        write_clean_snapshot(
            conn, tenant, branch, actor, "expenses", expense_id, "update", &cleaned, now,
        )?;
        // relay the (cleaned, non-credit) payment rows for identity/traceability
        for pc in payment_changes {
            if pc.action == "delete" {
                write_clean_snapshot(
                    conn,
                    tenant,
                    branch,
                    actor,
                    "expense_payments",
                    &pc.record_id,
                    "delete",
                    &json!({}),
                    now,
                )?;
            } else {
                let obj = data_obj(pc)?;
                write_clean_snapshot(
                    conn,
                    tenant,
                    branch,
                    actor,
                    "expense_payments",
                    &pc.record_id,
                    &pc.action,
                    &Value::Object(obj),
                    now,
                )?;
            }
        }
    }

    // relay all non-protected changes (atomic with the bridged ones)
    for c in &normal {
        relay(conn, tenant, branch, actor, c, now)?;
    }
    Ok(changes.len())
}

/// Build the server-cleaned `supplier_credits` snapshot: authoritative balance
/// fields from the projection, allowed metadata from the incoming row.
fn credit_clean_snapshot(
    proj: &Value,
    incoming: &Map<String, Value>,
    id: &str,
    branch: &str,
) -> Value {
    let used = proj_fils(proj, "usedAmountFils");
    let amount = proj_fils(proj, "amountFils");
    let status = if used >= amount { "USED" } else { "OPEN" };
    json!({
        "id": id,
        "branch_id": branch,
        "supplier_id": proj["supplierId"].as_str().unwrap_or(""),
        "amount": (amount as f64) / 1000.0,
        "used_amount": (used as f64) / 1000.0,
        "status": status,
        "note": incoming.get("note").cloned().unwrap_or(Value::Null),
    })
}

/// Build the server-cleaned `expenses` snapshot: authoritative settlement fields
/// from the projection, allowed metadata from the incoming row, immutable fields
/// pinned. `paid_amount` is the non-credit total (the legacy column semantics).
fn expense_clean_snapshot(
    proj: &Value,
    incoming: Option<&&SyncPushChange>,
    p: &ExpenseProjection,
    id: &str,
    branch: &str,
) -> Result<Value, BatchError> {
    let mut out = Map::new();
    out.insert("id".into(), json!(id));
    out.insert("branch_id".into(), json!(branch));
    out.insert("supplier_id".into(), json!(p.supplier_id));
    out.insert("amount".into(), json!((p.amount_fils as f64) / 1000.0));
    out.insert(
        "paid_amount".into(),
        json!((p.non_credit_paid_fils as f64) / 1000.0),
    );
    out.insert("status".into(), json!(p.status));
    // carry forward allowed metadata from the incoming row, if present
    if let Some(ec) = incoming {
        let obj = data_obj(ec)?;
        for k in EXPENSE_METADATA {
            if *k == "supplier_id" {
                continue;
            }
            if let Some(v) = obj.get(*k) {
                out.insert((*k).to_string(), v.clone());
            }
        }
    } else {
        let _ = proj;
    }
    Ok(Value::Object(out))
}
