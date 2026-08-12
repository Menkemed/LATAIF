// ════════════════════════════════════════════════════════════════════════════
// MOBILE-I1 — the stock-check core. ONE implementation, every surface.
//
// A stock check answers exactly one question: at this moment, did a human physically find this
// item? Nothing more. It is not a correction, not a movement, not a write-off — and this module is
// built so it *cannot* become one: it opens the business database READ-ONLY (only to prove the
// product exists in the caller's scope) and writes solely to `stock_checks` in the server database.
// There is no code path here that can touch `products`.
//
// Both callers land in `record`:
//   • Mobile  → POST /api/stock-checks  (JWT → tenant/branch/user)
//   • Desktop → Tauri command           (session → tenant/branch/user)
// Same validation, same table, same history. A verdict entered on the phone is the same row the
// desktop reads back, because there is only one row.
// ════════════════════════════════════════════════════════════════════════════

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

/// Server-side cap, mirrored by the v0019 CHECK constraint. Notes are a shelf remark ("in safe",
/// "with customer"), not a document — and an unbounded text field reachable from an authenticated
/// LAN route is a storage-growth hole we already paid for once with inline images.
pub const MAX_NOTES_LEN: usize = 500;

/// The only two verdicts. Deliberately an enum rather than a free string: a third value would have
/// to be a deliberate code change here AND a migration, not a typo in a fetch call.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StockStatus {
    Available,
    NotAvailable,
}

impl StockStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            StockStatus::Available => "available",
            StockStatus::NotAvailable => "not_available",
        }
    }
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "available" => Some(StockStatus::Available),
            "not_available" => Some(StockStatus::NotAvailable),
            _ => None,
        }
    }
}

/// Which surface recorded the check. Audit only — it never changes behaviour, and both values go
/// through the identical path. Kept because "who looked" is worth knowing during an inventory.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StockCheckSource {
    Mobile,
    Desktop,
}

impl StockCheckSource {
    pub fn as_str(self) -> &'static str {
        match self {
            StockCheckSource::Mobile => "mobile",
            StockCheckSource::Desktop => "desktop",
        }
    }
    /// Present for symmetry with `StockStatus::parse` and asserted by the tests: it documents the
    /// two legal sources in code rather than only in the v0019 CHECK constraint. No production
    /// caller parses a source — both surfaces know which one they are — hence the allow.
    #[allow(dead_code)]
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "mobile" => Some(StockCheckSource::Mobile),
            "desktop" => Some(StockCheckSource::Desktop),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct StockCheck {
    pub check_id: String,
    pub product_id: String,
    pub status: String,
    pub notes: Option<String>,
    pub checked_at: String,
    pub checked_by: Option<String>,
    pub checked_by_name: Option<String>,
    pub source: String,
}

/// Everything the caller supplies. `tenant_id`/`branch_id`/`checked_by` come from the verified
/// session on BOTH surfaces — never from the request body, so a client cannot file a check against
/// another tenant by editing a payload.
pub struct NewStockCheck<'a> {
    pub tenant_id: &'a str,
    pub branch_id: &'a str,
    pub product_id: &'a str,
    pub status: StockStatus,
    pub notes: Option<&'a str>,
    pub checked_by: Option<&'a str>,
    pub checked_by_name: Option<&'a str>,
    pub source: StockCheckSource,
    pub request_id: Option<&'a str>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum StockCheckError {
    /// The status string was not one of the two allowed verdicts.
    InvalidStatus,
    /// Notes exceeded `MAX_NOTES_LEN` after normalisation.
    NotesTooLong,
    /// No product with this id exists in the caller's tenant/branch. Refused rather than stored:
    /// a check against a product nobody can open is an orphan row that quietly breaks any later
    /// "which items were never checked" report.
    ProductNotFound,
    /// The business database could not be opened read-only, so existence could not be proven.
    /// Fail-closed: an unverifiable precondition refuses the write instead of assuming it holds.
    ProductLookupUnavailable,
    Db(String),
}

impl StockCheckError {
    pub fn code(&self) -> &'static str {
        match self {
            StockCheckError::InvalidStatus => "STOCK_CHECK_INVALID_STATUS",
            StockCheckError::NotesTooLong => "STOCK_CHECK_NOTES_TOO_LONG",
            StockCheckError::ProductNotFound => "STOCK_CHECK_PRODUCT_NOT_FOUND",
            StockCheckError::ProductLookupUnavailable => "STOCK_CHECK_PRODUCT_LOOKUP_UNAVAILABLE",
            StockCheckError::Db(_) => "STOCK_CHECK_DB_ERROR",
        }
    }
}

impl std::fmt::Display for StockCheckError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}

/// Trim, collapse an empty remark to None, and enforce the length cap.
///
/// The cap is applied to CHARACTERS, matching SQLite's `LENGTH()` on text, so the constraint and
/// this check agree — a byte-based cap would reject a legitimate 400-character Arabic note that
/// the table would happily store.
pub fn normalise_notes(raw: Option<&str>) -> Result<Option<String>, StockCheckError> {
    let Some(text) = raw else { return Ok(None) };
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.chars().count() > MAX_NOTES_LEN {
        return Err(StockCheckError::NotesTooLong);
    }
    Ok(Some(trimmed.to_string()))
}

/// Prove the product exists in this tenant/branch, READ-ONLY, against the business database.
///
/// `products` carries no `tenant_id`, so tenancy is the join onto `branches` — the identical shape
/// the legacy-media planner uses, so the two can never disagree about which products are in scope.
pub fn product_exists_in_scope(
    frontend_db_path: &std::path::Path,
    tenant_id: &str,
    branch_id: &str,
    product_id: &str,
) -> Result<bool, StockCheckError> {
    use rusqlite::OpenFlags;
    let conn = Connection::open_with_flags(
        frontend_db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| StockCheckError::ProductLookupUnavailable)?;

    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM products p
               JOIN branches b ON b.id = p.branch_id AND b.tenant_id = ?1
              WHERE p.id = ?2 AND p.branch_id = ?3
              LIMIT 1",
            rusqlite::params![tenant_id, product_id, branch_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| StockCheckError::ProductLookupUnavailable)?;

    Ok(found.is_some())
}

/// Record ONE check. Returns the stored row — the new one, or, when `request_id` has already been
/// seen, the existing one unchanged.
///
/// The idempotency is deliberately a READ of the prior row rather than an upsert: re-sending a
/// request must return what was actually stored the first time, not silently rewrite a verdict a
/// colleague recorded. A genuinely new observation carries a new `request_id` (or none) and always
/// becomes its own row.
pub fn record(
    conn: &Connection,
    frontend_db_path: &std::path::Path,
    input: NewStockCheck<'_>,
    check_id: String,
    now: &str,
) -> Result<StockCheck, StockCheckError> {
    let notes = normalise_notes(input.notes)?;

    // Idempotency first: a retry must not even reach the product lookup, so a check stays
    // returnable when the business database is momentarily busy.
    if let Some(req) = input.request_id.filter(|r| !r.trim().is_empty()) {
        if let Some(existing) = find_by_request(conn, input.tenant_id, req)? {
            return Ok(existing);
        }
    }

    if !product_exists_in_scope(frontend_db_path, input.tenant_id, input.branch_id, input.product_id)? {
        return Err(StockCheckError::ProductNotFound);
    }

    conn.execute(
        "INSERT INTO stock_checks
           (check_id, tenant_id, branch_id, product_id, status, notes,
            checked_at, checked_by, checked_by_name, source, request_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?7)",
        rusqlite::params![
            check_id,
            input.tenant_id,
            input.branch_id,
            input.product_id,
            input.status.as_str(),
            notes,
            now,
            input.checked_by,
            input.checked_by_name,
            input.source.as_str(),
            input.request_id.filter(|r| !r.trim().is_empty()),
        ],
    )
    .map_err(|e| StockCheckError::Db(e.to_string()))?;

    Ok(StockCheck {
        check_id,
        product_id: input.product_id.to_string(),
        status: input.status.as_str().to_string(),
        notes,
        checked_at: now.to_string(),
        checked_by: input.checked_by.map(str::to_string),
        checked_by_name: input.checked_by_name.map(str::to_string),
        source: input.source.as_str().to_string(),
    })
}

fn row_to_check(r: &rusqlite::Row<'_>) -> rusqlite::Result<StockCheck> {
    Ok(StockCheck {
        check_id: r.get(0)?,
        product_id: r.get(1)?,
        status: r.get(2)?,
        notes: r.get(3)?,
        checked_at: r.get(4)?,
        checked_by: r.get(5)?,
        checked_by_name: r.get(6)?,
        source: r.get(7)?,
    })
}

const SELECT_COLS: &str = "check_id, product_id, status, notes, checked_at, checked_by, checked_by_name, source";

fn find_by_request(
    conn: &Connection,
    tenant_id: &str,
    request_id: &str,
) -> Result<Option<StockCheck>, StockCheckError> {
    conn.query_row(
        &format!("SELECT {SELECT_COLS} FROM stock_checks WHERE tenant_id = ?1 AND request_id = ?2"),
        rusqlite::params![tenant_id, request_id],
        |r| row_to_check(r),
    )
    .optional()
    .map_err(|e| StockCheckError::Db(e.to_string()))
}

/// Full history for one product, newest first. `checked_at` is an RFC3339 string, so it sorts
/// lexicographically in the same order it sorts chronologically; `check_id` breaks ties so two
/// checks recorded in the same second still come back in a stable order.
pub fn history(
    conn: &Connection,
    tenant_id: &str,
    branch_id: &str,
    product_id: &str,
    limit: u32,
) -> Result<Vec<StockCheck>, StockCheckError> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {SELECT_COLS} FROM stock_checks
              WHERE tenant_id = ?1 AND branch_id = ?2 AND product_id = ?3
              ORDER BY checked_at DESC, check_id DESC
              LIMIT ?4"
        ))
        .map_err(|e| StockCheckError::Db(e.to_string()))?;
    let rows = stmt
        .query_map(rusqlite::params![tenant_id, branch_id, product_id, limit], |r| row_to_check(r))
        .map_err(|e| StockCheckError::Db(e.to_string()))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| StockCheckError::Db(e.to_string()))?);
    }
    Ok(out)
}

/// The newest check for one product, or None when it has never been checked.
///
/// Derived from the history rather than stored, so "latest" can never drift out of step with the
/// events it summarises.
pub fn latest(
    conn: &Connection,
    tenant_id: &str,
    branch_id: &str,
    product_id: &str,
) -> Result<Option<StockCheck>, StockCheckError> {
    Ok(history(conn, tenant_id, branch_id, product_id, 1)?.into_iter().next())
}

#[cfg(test)]
#[path = "stock_check_tests.rs"]
mod stock_check_tests;
