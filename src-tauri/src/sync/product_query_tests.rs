// MOBILE-I1 — search, scope and media-key safety.
//
// The fixture mirrors the real stock: identifiers live inside the `attributes` JSON, most products
// have no SKU at all, and one product sits in a different branch so every query has something it
// must NOT return.

use super::*;

fn tmp_dir() -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!(
        "com.lataif.productquery-{}",
        uuid::Uuid::new_v4().as_simple()
    ));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn fixture(dir: &std::path::Path) -> std::path::PathBuf {
    let path = dir.join("lataif.db");
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(
        r#"
        CREATE TABLE tenants (id TEXT PRIMARY KEY);
        CREATE TABLE branches (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL);
        CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE products (
          id TEXT PRIMARY KEY, branch_id TEXT NOT NULL, category_id TEXT,
          brand TEXT, name TEXT, sku TEXT, condition TEXT, scope_of_delivery TEXT,
          storage_location TEXT, purchase_price REAL, planned_sale_price REAL,
          min_sale_price REAL, max_sale_price REAL, stock_status TEXT,
          images TEXT, attributes TEXT, quantity INTEGER, notes TEXT, source_type TEXT,
          updated_at TEXT
        );
        INSERT INTO tenants VALUES ('t-1');
        INSERT INTO branches VALUES ('b-1','t-1'), ('b-other','t-1');
        INSERT INTO categories VALUES ('cat-watch','Watches');

        INSERT INTO products (id,branch_id,category_id,brand,name,sku,stock_status,images,attributes,quantity,notes) VALUES
          ('p-dj41','b-1','cat-watch','Rolex','Datejust 41','RLX-DJ41-002','in_stock','[]',
           '{"serial_number":"785757575","reference_number":"126333"}',1,'Top drawer'),
          ('p-dj36','b-1','cat-watch','Rolex','Datejust 36','RLX-DJ36-002','in_stock','[]',
           '{"reference_number":"126233"}',1,NULL),
          ('p-sub','b-1','cat-watch','Rolex','Submariner','RLX-SUB-002','in_stock','[]',
           '{"model_number":"MOD-1267"}',2,NULL),
          ('p-bag','b-1',NULL,'Dior','Lady Dior Mini','DIO-LDY-002','in_stock','[]',
           '{"description":"Embroidered canvas"}',1,NULL),
          ('p-nosku','b-1','cat-watch','Ebel',NULL,NULL,'in_stock','[]','{}',1,'wrong shelf'),
          ('p-elsewhere','b-other','cat-watch','Rolex','Datejust 41','RLX-DJ41-999','in_stock','[]',
           '{"serial_number":"785757575"}',1,NULL);

        -- v0.8.48 — der reale Ausgangszustand: eigener, freier Bestand.
        UPDATE products SET source_type = 'OWN', updated_at = '2026-08-01T10:00:00.000Z';

        -- Die Relationen, an denen die Preissperre haengt, leer angelegt. Erst eine eingefuegte
        -- Zeile macht aus einem freien Artikel einen gebundenen — genau so entsteht die Sperre
        -- auch in der echten Datenbank.
        CREATE TABLE purchase_lines (id TEXT PRIMARY KEY, product_id TEXT);
        CREATE TABLE purchase_return_lines (id TEXT PRIMARY KEY, product_id TEXT);
        CREATE TABLE invoice_lines (id TEXT PRIMARY KEY, product_id TEXT);
        CREATE TABLE sales_return_lines (id TEXT PRIMARY KEY, product_id TEXT);
        CREATE TABLE offer_lines (id TEXT PRIMARY KEY, product_id TEXT);
        CREATE TABLE orders (id TEXT PRIMARY KEY, product_id TEXT);
        CREATE TABLE order_lines (id TEXT PRIMARY KEY, product_id TEXT);
        CREATE TABLE stock_lots (id TEXT PRIMARY KEY, product_id TEXT);
        CREATE TABLE consignments (id TEXT PRIMARY KEY, product_id TEXT);
        CREATE TABLE agent_transfers (id TEXT PRIMARY KEY, product_id TEXT);
        CREATE TABLE production_inputs (id TEXT PRIMARY KEY, product_id TEXT);
        CREATE TABLE production_outputs (id TEXT PRIMARY KEY, product_id TEXT);
        CREATE TABLE repairs (id TEXT PRIMARY KEY, product_id TEXT);
        "#,
    )
    .unwrap();
    path
}

fn ids(hits: &[serde_json::Value]) -> Vec<String> {
    hits.iter().map(|h| h["id"].as_str().unwrap_or("").to_string()).collect()
}

fn find(db: &std::path::Path, q: &str) -> Vec<String> {
    ids(&search(db, "t-1", "b-1", q, 50))
}

// ── §13 — partial, case-insensitive, whitespace-normalised ──────────────────
#[test]
fn exact_sku_matches() {
    let d = tmp_dir();
    let db = fixture(&d);
    assert_eq!(find(&db, "RLX-DJ41-002"), vec!["p-dj41"]);
}

#[test]
fn search_is_case_insensitive_and_ignores_surrounding_whitespace() {
    let d = tmp_dir();
    let db = fixture(&d);
    assert_eq!(find(&db, "rlx-dj41-002"), vec!["p-dj41"]);
    assert_eq!(find(&db, "  RLX-DJ41-002  "), vec!["p-dj41"]);
    assert_eq!(find(&db, "rolex").len(), 3, "brand match is case-insensitive");
}

#[test]
fn a_partial_identifier_finds_the_item() {
    let d = tmp_dir();
    let db = fixture(&d);
    assert!(find(&db, "1267").contains(&"p-sub".to_string()), "partial model number");
    assert!(find(&db, "126233").contains(&"p-dj36".to_string()), "reference");
    assert!(find(&db, "7857").contains(&"p-dj41".to_string()), "partial serial");
    assert!(find(&db, "DJ41").contains(&"p-dj41".to_string()), "partial SKU");
}

#[test]
fn brand_and_name_together_narrow_the_result() {
    let d = tmp_dir();
    let db = fixture(&d);
    assert_eq!(find(&db, "Datejust 41"), vec!["p-dj41"]);
    assert_eq!(find(&db, "Submariner"), vec!["p-sub"]);
}

#[test]
fn description_and_notes_are_searchable() {
    let d = tmp_dir();
    let db = fixture(&d);
    assert_eq!(find(&db, "Embroidered"), vec!["p-bag"], "attributes.description");
    assert_eq!(find(&db, "wrong shelf"), vec!["p-nosku"], "notes");
}

#[test]
fn no_match_returns_nothing_rather_than_everything() {
    let d = tmp_dir();
    let db = fixture(&d);
    assert!(find(&db, "Patek Philippe").is_empty());
    assert!(find(&db, "").is_empty(), "an empty term must never scan the table");
    assert!(find(&db, "   ").is_empty());
}

// ── §14 — relevance ─────────────────────────────────────────────────────────
/// The exact SKU owner must come first even though the same digits appear in another product's
/// reference — otherwise scanning a tag and typing its number would disagree.
#[test]
fn an_exact_identifier_outranks_a_partial_match() {
    let d = tmp_dir();
    let db = fixture(&d);
    let conn = Connection::open(&db).unwrap();
    conn.execute(
        "INSERT INTO products (id,branch_id,brand,name,sku,stock_status,images,attributes,quantity,notes)
         VALUES ('p-decoy','b-1','Tudor','Black Bay','TUD-BB-001','in_stock','[]',
                 '{\"reference_number\":\"RLX-DJ41-002-x\"}',1,NULL)",
        [],
    )
    .unwrap();
    let hits = find(&db, "RLX-DJ41-002");
    assert_eq!(hits.first().map(String::as_str), Some("p-dj41"), "the exact SKU wins");
    assert!(hits.contains(&"p-decoy".to_string()), "the weaker match is still offered");
}

#[test]
fn an_exact_serial_outranks_a_prefix_and_a_substring() {
    let d = tmp_dir();
    let db = fixture(&d);
    let conn = Connection::open(&db).unwrap();
    conn.execute(
        "INSERT INTO products (id,branch_id,brand,name,sku,stock_status,images,attributes,quantity,notes)
         VALUES ('p-prefix','b-1','Omega','Speedmaster','SPD-1','in_stock','[]',
                 '{\"serial_number\":\"7857575759999\"}',1,NULL)",
        [],
    )
    .unwrap();
    let hits = find(&db, "785757575");
    assert_eq!(hits.first().map(String::as_str), Some("p-dj41"), "exact serial first");
}

// ── §27 — scope ─────────────────────────────────────────────────────────────
#[test]
fn search_never_crosses_the_branch_or_tenant_boundary() {
    let d = tmp_dir();
    let db = fixture(&d);
    let hits = find(&db, "785757575");
    assert!(!hits.contains(&"p-elsewhere".to_string()), "another branch is out of scope");
    assert!(search(&db, "t-other", "b-1", "Rolex", 50).is_empty(), "another tenant sees nothing");
}

#[test]
fn by_sku_and_by_id_are_scoped_too() {
    let d = tmp_dir();
    let db = fixture(&d);
    assert!(by_sku(&db, "t-1", "b-1", "RLX-DJ41-002").is_some());
    assert!(by_sku(&db, "t-1", "b-other", "RLX-DJ41-002").is_none());
    assert!(by_sku(&db, "t-other", "b-1", "RLX-DJ41-002").is_none());
    assert!(by_id(&db, "t-1", "b-1", "p-dj41").is_some());
    assert!(by_id(&db, "t-1", "b-1", "p-elsewhere").is_none());
}

/// §32 — a scanned product and a searched product must be the same object, field for field.
#[test]
fn scan_and_search_produce_identical_product_json() {
    let d = tmp_dir();
    let db = fixture(&d);
    let scanned = by_sku(&db, "t-1", "b-1", "RLX-DJ41-002").unwrap();
    let searched = search(&db, "t-1", "b-1", "RLX-DJ41-002", 50).into_iter().next().unwrap();
    assert_eq!(scanned, searched);
    assert_eq!(scanned["category_name"], serde_json::json!("Watches"));
    assert_eq!(scanned["quantity"], serde_json::json!(1.0));
}

// ── §28 — no wildcard or escape injection ───────────────────────────────────
#[test]
fn like_metacharacters_match_themselves_instead_of_becoming_wildcards() {
    let d = tmp_dir();
    let db = fixture(&d);
    assert!(find(&db, "%").is_empty(), "a bare % must not match every product");
    assert!(find(&db, "_").is_empty(), "a bare _ must not match every single character");
    assert!(find(&db, "%%%").is_empty());

    let conn = Connection::open(&db).unwrap();
    conn.execute(
        "INSERT INTO products (id,branch_id,brand,name,sku,stock_status,images,attributes,quantity,notes)
         VALUES ('p-pct','b-1','Sale','Item','50%-OFF','in_stock','[]','{}',1,NULL)",
        [],
    )
    .unwrap();
    assert_eq!(find(&db, "50%"), vec!["p-pct"], "a literal % is findable");
    assert_eq!(escape_like("50%_\\x"), "50\\%\\_\\\\x");
}

#[test]
fn an_overlong_term_is_capped_rather_than_scanned_in_full() {
    assert_eq!(normalise_query(&"x".repeat(MAX_QUERY_LEN + 40)).unwrap().chars().count(), MAX_QUERY_LEN);
    assert!(normalise_query("  ").is_none());
    assert_eq!(normalise_query("  RLX  ").unwrap(), "RLX");
}

#[test]
fn the_result_limit_is_bounded() {
    let d = tmp_dir();
    let db = fixture(&d);
    assert!(search(&db, "t-1", "b-1", "Rolex", 1).len() <= 1);
    assert!(search(&db, "t-1", "b-1", "Rolex", 9_999).len() <= MAX_SEARCH_RESULTS as usize);
}

// ── media key safety ────────────────────────────────────────────────────────
#[test]
fn only_a_well_formed_storage_key_resolves_to_a_path() {
    let root = std::path::Path::new("C:\\media");
    let good = format!("tenant-1/53/{}.jpg", "a".repeat(64));
    assert!(media_path_for_key(root, &good).is_some());

    for bad in [
        "../../../windows/system32/config/sam",
        "tenant-1/../../secret.jpg",
        "tenant-1/53/../../../evil.jpg",
        "/etc/passwd",
        "C:/Windows/win.ini",
        "\\\\server\\share\\x.jpg",
        "tenant-1/5/short.jpg",
        "tenant-1/53/nothex.jpg",
        "tenant-1/53/",
        "tenant-1/53",
        "",
    ] {
        assert!(media_path_for_key(root, bad).is_none(), "{bad} must be refused");
    }
    // a hex-shaped name with a disallowed extension is still refused
    assert!(media_path_for_key(root, &format!("tenant-1/53/{}.exe", "a".repeat(64))).is_none());
    // extra path segments are refused (no nesting beyond scope/shard/file)
    assert!(media_path_for_key(root, &format!("tenant-1/53/sub/{}.jpg", "a".repeat(64))).is_none());
}

#[test]
fn an_unknown_media_key_is_not_served() {
    let d = tmp_dir();
    let db = fixture(&d);
    let conn = Connection::open(&db).unwrap();
    conn.execute_batch(
        "CREATE TABLE media_blob_generations (tenant_id TEXT, storage_key TEXT, gen_status TEXT, deleted_at TEXT);
         INSERT INTO media_blob_generations VALUES ('t-1','tenant-1/53/known.jpg','available',NULL),
                                                   ('t-1','tenant-1/54/gone.jpg','deleted',NULL);",
    )
    .unwrap();
    assert!(media_key_is_known(&db, "t-1", "tenant-1/53/known.jpg"));
    assert!(!media_key_is_known(&db, "t-1", "tenant-1/54/gone.jpg"), "a deleted generation is not offered");
    assert!(!media_key_is_known(&db, "t-1", "tenant-1/99/never.jpg"));
    assert!(!media_key_is_known(&db, "t-other", "tenant-1/53/known.jpg"), "keys are tenant-scoped");
}

// ── MOBILE-EDIT-S3 §1 — ein Lesefehler ist keine leere Galerie ──────────────
//
// Die harte Vorbedingung fuer jeden Galerie-Save: die Seite darf niemals "hat keine Bilder" sehen,
// wenn in Wahrheit "konnte nicht gelesen werden" gilt. Beide Fehlerquellen werden geprueft — die
// gescheiterte Abfrage UND die einzelne unlesbare Zeile, die frueher still uebersprungen wurde.

/// Die Medien-Tabellen, die der Galerie-Read verbindet — nur die benutzten Spalten.
const MEDIA_DDL: &str = r#"
CREATE TABLE media_links (tenant_id TEXT, link_id TEXT, media_id TEXT, entity_type TEXT, entity_id TEXT,
                          is_primary INTEGER, sort_order INTEGER, deleted_at TEXT);
CREATE TABLE media_objects (tenant_id TEXT, media_id TEXT, master_blob_id TEXT, ingest_status TEXT, deleted_at TEXT);
CREATE TABLE media_blobs (tenant_id TEXT, blob_id TEXT, blob_status TEXT, current_generation_no INTEGER);
CREATE TABLE media_blob_generations (tenant_id TEXT, blob_id TEXT, generation_no INTEGER, storage_key TEXT,
                                     gen_status TEXT, deleted_at TEXT);
CREATE TABLE media_variants (tenant_id TEXT, media_id TEXT, variant_type TEXT, blob_id TEXT, deleted_at TEXT);
"#;

fn seed_two_image_gallery(db: &std::path::Path, second_storage_key: Option<&str>) {
    let conn = Connection::open(db).unwrap();
    conn.execute_batch(MEDIA_DDL).unwrap();
    conn.execute_batch(
        r#"
        INSERT INTO media_links VALUES ('t-1','lnk-a','med-a','product','p-dj41',1,0,NULL),
                                       ('t-1','lnk-b','med-b','product','p-dj41',0,1,NULL);
        INSERT INTO media_objects VALUES ('t-1','med-a','blob-a','ready',NULL),
                                         ('t-1','med-b','blob-b','ready',NULL);
        INSERT INTO media_blobs VALUES ('t-1','blob-a','present',1), ('t-1','blob-b','present',1);
        "#,
    )
    .unwrap();
    conn.execute(
        "INSERT INTO media_blob_generations VALUES ('t-1','blob-a',1,'t-1/aa/a.jpg','available',NULL)",
        [],
    )
    .unwrap();
    // Die zweite Generation traegt den Storage-Key, den der Aufrufer vorgibt — `None` erzeugt genau
    // die Zeile, an der `r.get::<_, String>(..)` scheitert.
    conn.execute(
        "INSERT INTO media_blob_generations VALUES ('t-1','blob-b',1,?1,'available',NULL)",
        rusqlite::params![second_storage_key],
    )
    .unwrap();
}

#[test]
fn a_healthy_gallery_read_reports_ok_with_a_baseline() {
    let d = tmp_dir();
    let db = fixture(&d);
    seed_two_image_gallery(&db, Some("t-1/bb/b.jpg"));

    let p = by_id(&db, "t-1", "b-1", "p-dj41").unwrap();
    assert_eq!(p["gallery_ok"], serde_json::json!(true));
    let g = p["gallery"].as_array().expect("a successful read carries the gallery");
    assert_eq!(g.len(), 2);
    assert_eq!(g[0]["link_id"], serde_json::json!("lnk-a"));
    assert_eq!(g[0]["is_primary"], serde_json::json!(true));
    assert_eq!(g[1]["link_id"], serde_json::json!("lnk-b"));
    let base = p["gallery_baseline"].as_str().unwrap();
    assert_eq!(base.len(), 64, "the baseline is a sha-256 hex digest");
}

#[test]
fn a_failed_gallery_query_is_reported_not_flattened_to_empty() {
    let d = tmp_dir();
    let db = fixture(&d); // ohne Medien-Tabellen: die Abfrage scheitert real

    let p = by_id(&db, "t-1", "b-1", "p-dj41").unwrap();
    assert_eq!(p["gallery_ok"], serde_json::json!(false), "a read failure must be visible as such");
    assert!(p.get("gallery").is_none(), "no gallery list may be invented from a failure");
    assert!(
        p.get("gallery_baseline").is_none(),
        "and above all NO baseline — a fingerprint of nothing would authorise deleting everything"
    );
}

#[test]
fn one_unreadable_row_fails_the_whole_read_instead_of_vanishing() {
    let d = tmp_dir();
    let db = fixture(&d);
    seed_two_image_gallery(&db, None); // die zweite Zeile hat keinen Storage-Key

    let p = by_id(&db, "t-1", "b-1", "p-dj41").unwrap();
    assert_eq!(
        p["gallery_ok"],
        serde_json::json!(false),
        "a single unreadable row must not silently shrink the gallery to one image"
    );
    assert!(p.get("gallery").is_none());
    assert!(p.get("gallery_baseline").is_none());
}

#[test]
fn the_baseline_changes_when_the_gallery_changes() {
    let d = tmp_dir();
    let db = fixture(&d);
    seed_two_image_gallery(&db, Some("t-1/bb/b.jpg"));
    let before = by_id(&db, "t-1", "b-1", "p-dj41").unwrap()["gallery_baseline"].as_str().unwrap().to_string();

    // Zweimal lesen ohne Aenderung: identisch.
    let again = by_id(&db, "t-1", "b-1", "p-dj41").unwrap()["gallery_baseline"].as_str().unwrap().to_string();
    assert_eq!(before, again, "the baseline is deterministic");

    // Nur die Reihenfolge tauschen — der Fingerabdruck MUSS sich unterscheiden.
    let conn = Connection::open(&db).unwrap();
    conn.execute("UPDATE media_links SET sort_order = 1, is_primary = 0 WHERE link_id = 'lnk-a'", []).unwrap();
    conn.execute("UPDATE media_links SET sort_order = 0, is_primary = 1 WHERE link_id = 'lnk-b'", []).unwrap();
    let after = by_id(&db, "t-1", "b-1", "p-dj41").unwrap()["gallery_baseline"].as_str().unwrap().to_string();
    assert_ne!(before, after, "a reorder must be visible in the baseline");
}

/// MOBILE-EDIT-S3 — DERSELBE Vektor steht in `test/mobile-gallery-edit/gallery-baseline.test.ts`.
/// Rust liest die Datei read-only, der Drain die laufende sql.js-Instanz; beide berechnen den
/// Fingerabdruck selbst. Laufen die Formeln auseinander, wuerde JEDER Galerie-Save faelschlich als
/// Konflikt enden — dieser Vektor haelt sie zusammen.
#[test]
fn the_shared_baseline_vector_is_stable() {
    let d = tmp_dir();
    let db = fixture(&d);
    seed_two_image_gallery(&db, Some("t-1/bb/b.jpg"));
    let p = by_id(&db, "t-1", "b-1", "p-dj41").unwrap();
    assert_eq!(
        p["gallery_baseline"].as_str().unwrap(),
        "4ede7717390d74cb4b3818fe48f6ddf7e20f3d956bfdbf5fbf1cac08f4f0b8e3",
        "canonical input: lnk-a:med-a:0:1|lnk-b:med-b:1:0"
    );
}

// ── v0.8.48 — die Preissperre erklaert sich selbst ─────────────────────────
//
// Die Seite zeigt die drei Preisfelder IMMER; gesperrt sind sie sichtbar gesperrt, mit dem Grund
// daneben. Damit dieser Grund stimmt, muss der Lesevertrag ihn liefern — und er darf ihn nur dann
// nennen, wenn er ihn sicher kennt. Verbindlich bleibt die Pruefung im Koordinator, INNERHALB der
// Schreib-Transaktion; hier steht ausschliesslich die Anzeige auf dem Pruefstand.

/// (freigegeben, Grund, Detail) — fehlende Felder werden zu leeren Zeichenketten, damit ein
/// vergessenes Feld nicht als "kein Grund" durchgeht, sondern sichtbar wird.
fn verdict(db: &std::path::Path, id: &str) -> (bool, String, String) {
    let p = by_id(db, "t-1", "b-1", id).expect("the item is readable");
    (
        p["price_editable"].as_bool().unwrap_or(false),
        p.get("price_lock_reason").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        p.get("price_lock_detail").and_then(|v| v.as_str()).unwrap_or("").to_string(),
    )
}

/// REGRESSION: die Auskunft wurde berechnet, aber nie mitgeschickt. Die Seite fragt
/// `p.price_editable === true` — ein Feld, das gar nicht existiert, ist nie wahr, also blieben die
/// Preisfelder selbst bei einem voellig freien Artikel unsichtbar. Der Vertrag muss sie tragen.
#[test]
fn the_read_contract_actually_carries_the_price_verdict() {
    let d = tmp_dir();
    let db = fixture(&d);
    let p = by_id(&db, "t-1", "b-1", "p-dj41").unwrap();
    assert!(
        p.get("price_editable").is_some(),
        "without this field the phone can never offer a price — it asks for exactly this key"
    );
    let mut hits = search(&db, "t-1", "b-1", "RLX-DJ41-002", 5);
    assert_eq!(hits.len(), 1);
    let hit = hits.remove(0);
    assert_eq!(
        hit["price_editable"], p["price_editable"],
        "search hit and detail read must agree — otherwise the screen changes its mind on open"
    );
}

#[test]
fn a_free_own_item_is_released_and_names_no_reason() {
    let d = tmp_dir();
    let db = fixture(&d);
    let (editable, reason, detail) = verdict(&db, "p-dj41");
    assert!(editable, "own, unsold stock may still be priced");
    assert_eq!(reason, "", "nothing is locked, so nothing is explained away");
    assert_eq!(detail, "");
}

/// Jede einzelne Relation nennt sich selbst. Das ist der Kern der Anzeige: "gesperrt" allein hilft
/// niemandem, "linked to Invoice" schon.
#[test]
fn every_business_relation_names_itself_as_the_reason() {
    for (table, label) in PRICE_LOCK_RELATIONS {
        let d = tmp_dir();
        let db = fixture(&d);
        Connection::open(&db)
            .unwrap()
            .execute(&format!("INSERT INTO {table} (id, product_id) VALUES ('x-1', 'p-dj41')"), [])
            .unwrap();
        let (editable, reason, detail) = verdict(&db, "p-dj41");
        assert!(!editable, "{table} must lock the prices");
        assert_eq!(reason, "linked", "{table} is a business link");
        assert_eq!(detail, label, "{table} must be named as {label}");
    }
}

/// Und die vier, die der Nutzer tatsaechlich zu sehen bekommt, buchstabiert ausgeschrieben.
#[test]
fn the_common_reasons_read_the_way_the_screen_shows_them() {
    for (table, expected) in [
        ("invoice_lines", "Invoice"),
        ("purchase_lines", "Purchase"),
        ("stock_lots", "Stock lot"),
        ("consignments", "Consignment"),
    ] {
        let d = tmp_dir();
        let db = fixture(&d);
        Connection::open(&db)
            .unwrap()
            .execute(&format!("INSERT INTO {table} (id, product_id) VALUES ('x-1', 'p-dj41')"), [])
            .unwrap();
        assert_eq!(verdict(&db, "p-dj41"), (false, "linked".to_string(), expected.to_string()));
    }
}

/// Fremde Ware ist kein Vorgang, sondern eine Eigentumsfrage — und wird auch so benannt, statt ein
/// Dokument zu erfinden, das es nicht gibt.
#[test]
fn consignment_and_agent_stock_say_so_instead_of_naming_a_document() {
    for (source, label) in [("CONSIGNMENT", "Consignment"), ("AGENT", "Agent")] {
        let d = tmp_dir();
        let db = fixture(&d);
        Connection::open(&db)
            .unwrap()
            .execute("UPDATE products SET source_type = ?1 WHERE id = 'p-dj41'", rusqlite::params![source])
            .unwrap();
        let (editable, reason, detail) = verdict(&db, "p-dj41");
        assert!(!editable, "{source} is not our own free stock");
        assert_eq!(reason, "not_own_stock");
        assert_eq!(detail, label);
    }
}

/// Der wichtigste Fall: gesperrt, aber der Grund ist NICHT sicher. Dann wird keiner behauptet.
#[test]
fn an_unclear_state_locks_without_inventing_a_reason() {
    // (a) eine Klasse, die diese Anzeige nicht kennt
    let d = tmp_dir();
    let db = fixture(&d);
    Connection::open(&db)
        .unwrap()
        .execute("UPDATE products SET source_type = 'SOMETHING_NEW' WHERE id = 'p-dj41'", [])
        .unwrap();
    assert_eq!(verdict(&db, "p-dj41"), (false, "unknown".to_string(), String::new()));

    // (b) gar keine Klasse
    let d = tmp_dir();
    let db = fixture(&d);
    Connection::open(&db)
        .unwrap()
        .execute("UPDATE products SET source_type = NULL WHERE id = 'p-dj41'", [])
        .unwrap();
    assert_eq!(verdict(&db, "p-dj41"), (false, "unknown".to_string(), String::new()));

    // (c) eine Relation, die sich nicht lesen laesst. Das sperrt — aber es ist KEIN Beleg fuer eine
    // Verknuepfung und wird deshalb auch nicht als eine ausgegeben.
    let d = tmp_dir();
    let db = fixture(&d);
    Connection::open(&db).unwrap().execute("DROP TABLE stock_lots", []).unwrap();
    let (editable, reason, detail) = verdict(&db, "p-dj41");
    assert!(!editable, "an unreadable relation must fail closed");
    assert_eq!(reason, "unknown", "a failed read is not evidence of a link");
    assert_eq!(detail, "");
}

/// Die erste gefundene Bindung gewinnt, und sie gewinnt vor jeder spaeteren — die Anzeige nennt
/// genau einen Grund, nicht eine Liste.
#[test]
fn the_first_binding_found_is_the_one_shown() {
    let d = tmp_dir();
    let db = fixture(&d);
    let conn = Connection::open(&db).unwrap();
    conn.execute("INSERT INTO invoice_lines (id, product_id) VALUES ('i-1','p-dj41')", []).unwrap();
    conn.execute("INSERT INTO repairs (id, product_id) VALUES ('r-1','p-dj41')", []).unwrap();
    let (_, reason, detail) = verdict(&db, "p-dj41");
    assert_eq!(reason, "linked");
    assert!(!detail.is_empty(), "one named reason, never an empty one");
}

/// ANTI-DRIFT: die Tabellen, ueber die die ANZEIGE entscheidet, muessen exakt die sein, ueber die
/// der Koordinator VERBINDLICH entscheidet. Liefen sie auseinander, wuerde die Seite ein Feld
/// freigeben, das der Desktop danach ablehnt — oder umgekehrt eines sperren, das erlaubt waere.
#[test]
fn the_displayed_lock_list_matches_the_authoritative_one() {
    let ts = include_str!("../../../src/core/products/price-eligibility.ts");
    let block = ts
        .split("TRANSACTION_RELATIONS: readonly string[] = [")
        .nth(1)
        .expect("the SSOT still declares TRANSACTION_RELATIONS")
        .split("];")
        .next()
        .unwrap();
    let mut from_ts: Vec<&str> = block.split('\'').skip(1).step_by(2).collect();
    let mut from_rust: Vec<&str> = PRICE_LOCK_RELATIONS.iter().map(|(t, _)| *t).collect();
    from_ts.sort_unstable();
    from_rust.sort_unstable();
    assert_eq!(from_ts, from_rust, "display and authority must lock on exactly the same relations");
    for (table, label) in PRICE_LOCK_RELATIONS {
        assert!(!label.is_empty(), "{table} needs a name a human can read");
    }
}

/// v0.8.49 — nach einem mobilen Speichern muss die Seite erkennen koennen, DASS der Desktop den
/// Auftrag angewandt hat. Ohne einen Zeitstempel im Vertrag bliebe ihr nur Raten oder ein selbst
/// zusammengebauter Zustand — beides waere eine Anzeige, die etwas behauptet.
#[test]
fn the_read_contract_carries_the_last_change_timestamp() {
    let d = tmp_dir();
    let db = fixture(&d);
    let p = by_id(&db, "t-1", "b-1", "p-dj41").unwrap();
    assert_eq!(p["updated_at"], serde_json::json!("2026-08-01T10:00:00.000Z"));

    // Suche und Detailabruf liefern denselben Zeitstempel — sonst haette die Seite zwei Wahrheiten.
    let hits = search(&db, "t-1", "b-1", "RLX-DJ41-002", 5);
    assert_eq!(hits[0]["updated_at"], p["updated_at"]);

    // Und er bewegt sich, wenn sich der Artikel bewegt.
    Connection::open(&db)
        .unwrap()
        .execute("UPDATE products SET updated_at = '2026-08-02T11:00:00.000Z' WHERE id = 'p-dj41'", [])
        .unwrap();
    let after = by_id(&db, "t-1", "b-1", "p-dj41").unwrap();
    assert_ne!(after["updated_at"], p["updated_at"], "a change must be visible in the contract");
}
