// MOBILE-I1 — the stock-check core under test.
//
// The headline test is `available_and_not_available_leave_every_product_field_untouched`: it
// snapshots the ENTIRE products row before and after both verdicts and compares it byte for byte.
// That is the guarantee the whole feature rests on — a physical check is an observation, never an
// inventory correction — and it is asserted against the real schema rather than by reading the
// code and believing it.

use super::*;
use rusqlite::Connection;

fn tmp_dir() -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!(
        "com.lataif.stockcheck-{}",
        uuid::Uuid::new_v4().as_simple()
    ));
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// A server DB with only what v0019 needs, applied exactly as production applies it.
fn server_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(crate::sync::migrations::V0019_STOCK_CHECKS.up_sql)
        .unwrap();
    conn
}

/// A business DB shaped like the real one for the columns this module reads, plus a few extra
/// business columns so the "nothing moved" snapshot has something meaningful to compare.
fn frontend_db(dir: &std::path::Path) -> std::path::PathBuf {
    let path = dir.join("lataif.db");
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TABLE tenants (id TEXT PRIMARY KEY);
         CREATE TABLE branches (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL);
         CREATE TABLE products (
            id TEXT PRIMARY KEY, branch_id TEXT NOT NULL, category_id TEXT,
            brand TEXT, name TEXT, sku TEXT, quantity INTEGER,
            purchase_price REAL, planned_sale_price REAL, min_sale_price REAL,
            stock_status TEXT, attributes TEXT, images TEXT, updated_at TEXT
         );
         INSERT INTO tenants (id) VALUES ('t-1');
         INSERT INTO branches (id, tenant_id) VALUES ('b-1','t-1'), ('b-other','t-1');
         INSERT INTO products VALUES
            ('p-1','b-1','cat-watch','Rolex','Datejust 41','RLX-DJ41-002',3,
             90000.0, 120000.0, 100000.0, 'in_stock',
             '{\"serial_number\":\"785757575\"}', '[]', '2026-08-11T00:00:00Z'),
            ('p-other','b-other','cat-watch','Ebel',NULL,NULL,1,
             0.0, NULL, NULL, 'in_stock', '{}', '[]', '2026-08-11T00:00:00Z');",
    )
    .unwrap();
    path
}

fn input<'a>(product_id: &'a str, status: StockStatus, notes: Option<&'a str>) -> NewStockCheck<'a> {
    NewStockCheck {
        tenant_id: "t-1",
        branch_id: "b-1",
        product_id,
        status,
        notes,
        checked_by: Some("user-owner"),
        checked_by_name: Some("Owner"),
        source: StockCheckSource::Mobile,
        request_id: None,
    }
}

/// Every column of the products row, rendered as text — so a change of ANY kind shows up.
fn product_snapshot(path: &std::path::Path, id: &str) -> Vec<String> {
    let conn = Connection::open(path).unwrap();
    let cols: Vec<String> = {
        let mut s = conn.prepare("SELECT name FROM pragma_table_info('products')").unwrap();
        let r = s.query_map([], |r| r.get::<_, String>(0)).unwrap();
        r.map(|x| x.unwrap()).collect()
    };
    let list = cols
        .iter()
        .map(|c| format!("CAST(COALESCE(\"{c}\",'∅') AS TEXT)"))
        .collect::<Vec<_>>()
        .join(", ");
    let mut stmt = conn
        .prepare(&format!("SELECT {list} FROM products WHERE id = ?1"))
        .unwrap();
    stmt.query_row(rusqlite::params![id], |r| {
        (0..cols.len()).map(|i| r.get::<_, String>(i)).collect::<rusqlite::Result<Vec<_>>>()
    })
    .unwrap()
}

// ── §30 / §5 — the core promise ─────────────────────────────────────────────
#[test]
fn available_and_not_available_leave_every_product_field_untouched() {
    let dir = tmp_dir();
    let fe = frontend_db(&dir);
    let conn = server_db();
    let before = product_snapshot(&fe, "p-1");

    record(&conn, &fe, input("p-1", StockStatus::NotAvailable, Some("Could not find")), "c-1".into(), "2026-08-11T10:00:00Z").unwrap();
    assert_eq!(product_snapshot(&fe, "p-1"), before, "not_available must not touch the product");

    record(&conn, &fe, input("p-1", StockStatus::Available, Some("Found in safe")), "c-2".into(), "2026-08-11T15:00:00Z").unwrap();
    assert_eq!(product_snapshot(&fe, "p-1"), before, "available must not touch the product either");

    // and the quantity specifically, because that is the field an inventory tool would "helpfully" zero
    let conn2 = Connection::open(&fe).unwrap();
    let qty: i64 = conn2.query_row("SELECT quantity FROM products WHERE id='p-1'", [], |r| r.get(0)).unwrap();
    assert_eq!(qty, 3, "quantity stays 3 regardless of the verdict");
}

// ── §20 / §22 — history, not overwrite ──────────────────────────────────────
#[test]
fn repeated_checks_accumulate_and_latest_is_the_newest() {
    let dir = tmp_dir();
    let fe = frontend_db(&dir);
    let conn = server_db();

    record(&conn, &fe, input("p-1", StockStatus::NotAvailable, Some("Could not find")), "c-1".into(), "2026-08-11T10:00:00Z").unwrap();
    record(&conn, &fe, input("p-1", StockStatus::Available, Some("Found in safe")), "c-2".into(), "2026-08-11T15:00:00Z").unwrap();

    let hist = history(&conn, "t-1", "b-1", "p-1", 50).unwrap();
    assert_eq!(hist.len(), 2, "both observations survive");
    assert_eq!(hist[0].check_id, "c-2", "newest first");
    assert_eq!(hist[1].notes.as_deref(), Some("Could not find"), "the older verdict is still readable");

    let latest = latest(&conn, "t-1", "b-1", "p-1").unwrap().unwrap();
    assert_eq!(latest.status, "available");
    assert_eq!(latest.notes.as_deref(), Some("Found in safe"));
}

#[test]
fn a_product_never_checked_has_no_latest() {
    let dir = tmp_dir();
    let fe = frontend_db(&dir);
    let conn = server_db();
    assert!(latest(&conn, "t-1", "b-1", "p-1").unwrap().is_none());
}

// ── §24 — the two surfaces are one path ─────────────────────────────────────
#[test]
fn mobile_and_desktop_write_into_the_same_history() {
    let dir = tmp_dir();
    let fe = frontend_db(&dir);
    let conn = server_db();

    let mut m = input("p-1", StockStatus::NotAvailable, Some("Could not find"));
    m.source = StockCheckSource::Mobile;
    record(&conn, &fe, m, "c-mobile".into(), "2026-08-11T10:00:00Z").unwrap();

    let mut d = input("p-1", StockStatus::Available, Some("Found in safe"));
    d.source = StockCheckSource::Desktop;
    record(&conn, &fe, d, "c-desktop".into(), "2026-08-11T13:00:00Z").unwrap();

    let hist = history(&conn, "t-1", "b-1", "p-1", 50).unwrap();
    assert_eq!(hist.len(), 2, "one shared history, not one per surface");
    assert_eq!(hist[0].source, "desktop");
    assert_eq!(hist[1].source, "mobile");
    assert_eq!(latest(&conn, "t-1", "b-1", "p-1").unwrap().unwrap().status, "available");
}

// ── §27 — scope is proven, never taken from the caller ──────────────────────
#[test]
fn a_product_outside_the_callers_branch_is_refused() {
    let dir = tmp_dir();
    let fe = frontend_db(&dir);
    let conn = server_db();
    let err = record(&conn, &fe, input("p-other", StockStatus::Available, None), "c-1".into(), "2026-08-11T10:00:00Z").unwrap_err();
    assert_eq!(err, StockCheckError::ProductNotFound);
    assert_eq!(err.code(), "STOCK_CHECK_PRODUCT_NOT_FOUND");
}

#[test]
fn an_unknown_product_is_refused() {
    let dir = tmp_dir();
    let fe = frontend_db(&dir);
    let conn = server_db();
    assert_eq!(
        record(&conn, &fe, input("does-not-exist", StockStatus::Available, None), "c-1".into(), "2026-08-11T10:00:00Z").unwrap_err(),
        StockCheckError::ProductNotFound
    );
}

/// Fail-closed: if existence cannot be proven, nothing is stored.
#[test]
fn an_unreadable_business_db_refuses_the_write() {
    let dir = tmp_dir();
    let missing = dir.join("nope.db");
    let conn = server_db();
    assert_eq!(
        record(&conn, &missing, input("p-1", StockStatus::Available, None), "c-1".into(), "2026-08-11T10:00:00Z").unwrap_err(),
        StockCheckError::ProductLookupUnavailable
    );
    let n: i64 = conn.query_row("SELECT COUNT(*) FROM stock_checks", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 0, "a refused check leaves no row");
}

// ── §29 / §21 — validation ──────────────────────────────────────────────────
#[test]
fn only_the_two_known_verdicts_parse() {
    assert_eq!(StockStatus::parse("available"), Some(StockStatus::Available));
    assert_eq!(StockStatus::parse("not_available"), Some(StockStatus::NotAvailable));
    for bad in ["", "Available", "AVAILABLE", "missing", "gone", "not-available", "0"] {
        assert!(StockStatus::parse(bad).is_none(), "{bad} must not parse");
    }
}

#[test]
fn only_the_two_known_surfaces_parse() {
    assert_eq!(StockCheckSource::parse("mobile"), Some(StockCheckSource::Mobile));
    assert_eq!(StockCheckSource::parse("desktop"), Some(StockCheckSource::Desktop));
    for bad in ["", "Mobile", "web", "api", "tablet"] {
        assert!(StockCheckSource::parse(bad).is_none(), "{bad} must not parse");
    }
}

#[test]
fn notes_are_trimmed_blank_becomes_none_and_the_cap_is_enforced() {
    assert_eq!(normalise_notes(None).unwrap(), None);
    assert_eq!(normalise_notes(Some("   ")).unwrap(), None);
    assert_eq!(normalise_notes(Some("  In safe  ")).unwrap(), Some("In safe".into()));
    assert_eq!(normalise_notes(Some(&"x".repeat(MAX_NOTES_LEN))).unwrap(), Some("x".repeat(MAX_NOTES_LEN)));
    assert_eq!(normalise_notes(Some(&"x".repeat(MAX_NOTES_LEN + 1))).unwrap_err(), StockCheckError::NotesTooLong);
    // the cap counts characters, so a non-ASCII note of legal length is accepted
    assert!(normalise_notes(Some(&"ä".repeat(MAX_NOTES_LEN))).unwrap().is_some());
}

/// Notes are stored verbatim. Escaping belongs to the renderer (`esc()` on mobile, React on
/// desktop); mangling the text here would corrupt a legitimate remark like `a < b`.
#[test]
fn notes_are_stored_verbatim_including_markup_looking_text() {
    let dir = tmp_dir();
    let fe = frontend_db(&dir);
    let conn = server_db();
    let raw = "<script>alert(1)</script> & shelf < 3";
    record(&conn, &fe, input("p-1", StockStatus::Available, Some(raw)), "c-1".into(), "2026-08-11T10:00:00Z").unwrap();
    assert_eq!(latest(&conn, "t-1", "b-1", "p-1").unwrap().unwrap().notes.as_deref(), Some(raw));
}

// ── §35 — idempotency ───────────────────────────────────────────────────────
#[test]
fn the_same_request_id_returns_the_first_check_instead_of_a_second_one() {
    let dir = tmp_dir();
    let fe = frontend_db(&dir);
    let conn = server_db();

    let mut first = input("p-1", StockStatus::Available, Some("Found in safe"));
    first.request_id = Some("req-1");
    let a = record(&conn, &fe, first, "c-1".into(), "2026-08-11T10:00:00Z").unwrap();

    // Same request, different verdict and a different generated id: the stored row wins.
    let mut retry = input("p-1", StockStatus::NotAvailable, Some("something else"));
    retry.request_id = Some("req-1");
    let b = record(&conn, &fe, retry, "c-2".into(), "2026-08-11T10:00:05Z").unwrap();

    assert_eq!(a.check_id, b.check_id);
    assert_eq!(b.status, "available", "a retry never rewrites the recorded verdict");
    assert_eq!(b.notes.as_deref(), Some("Found in safe"));
    assert_eq!(history(&conn, "t-1", "b-1", "p-1", 50).unwrap().len(), 1);
}

#[test]
fn a_deliberate_new_check_still_creates_a_row() {
    let dir = tmp_dir();
    let fe = frontend_db(&dir);
    let conn = server_db();
    let mut a = input("p-1", StockStatus::Available, None);
    a.request_id = Some("req-1");
    record(&conn, &fe, a, "c-1".into(), "2026-08-11T10:00:00Z").unwrap();
    let mut b = input("p-1", StockStatus::NotAvailable, None);
    b.request_id = Some("req-2");
    record(&conn, &fe, b, "c-2".into(), "2026-08-11T11:00:00Z").unwrap();
    assert_eq!(history(&conn, "t-1", "b-1", "p-1", 50).unwrap().len(), 2);
}

/// A blank request id is not an identity — it must behave like none at all, or every client that
/// sends `""` would share one slot and silently overwrite each other's checks.
#[test]
fn a_blank_request_id_is_treated_as_absent() {
    let dir = tmp_dir();
    let fe = frontend_db(&dir);
    let conn = server_db();
    for (i, id) in ["c-1", "c-2"].iter().enumerate() {
        let mut n = input("p-1", StockStatus::Available, None);
        n.request_id = Some("   ");
        record(&conn, &fe, n, (*id).into(), &format!("2026-08-11T1{i}:00:00Z")).unwrap();
    }
    assert_eq!(history(&conn, "t-1", "b-1", "p-1", 50).unwrap().len(), 2);
}

#[test]
fn history_is_scoped_and_never_leaks_another_products_checks() {
    let dir = tmp_dir();
    let fe = frontend_db(&dir);
    let conn = server_db();
    record(&conn, &fe, input("p-1", StockStatus::Available, None), "c-1".into(), "2026-08-11T10:00:00Z").unwrap();
    assert!(history(&conn, "t-1", "b-1", "p-other", 50).unwrap().is_empty());
    assert!(history(&conn, "t-other", "b-1", "p-1", 50).unwrap().is_empty());
    assert!(history(&conn, "t-1", "b-other", "p-1", 50).unwrap().is_empty());
}
