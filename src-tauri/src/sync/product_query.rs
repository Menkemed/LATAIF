// ════════════════════════════════════════════════════════════════════════════
// MOBILE-I1 — read-only product lookup and search against the business database.
//
// Every product the mobile surface ever renders comes from `row_to_product_json` here — the QR
// scan, the search hit list and the detail view alike. That is deliberate: §32 requires a scanned
// product and a searched product to show the SAME details, and the cheapest way to guarantee it is
// to leave exactly one function that can produce a product.
//
// ## Read-only, always
//
// `lataif.db` belongs to sql.js in the renderer, which persists by writing its whole in-memory
// image over the file. This module therefore opens it with SQLITE_OPEN_READ_ONLY — not as a
// precaution but as a correctness requirement: a write here would be erased by the next renderer
// save, and worse, would look like it had worked.
//
// ## Injection
//
// Nothing user-supplied is ever concatenated into SQL. The search term is bound, and because it
// reaches a LIKE pattern, its `%` `_` and `\` are escaped first — otherwise a search for "50%"
// would silently become "match anything".
// ════════════════════════════════════════════════════════════════════════════

use rusqlite::{Connection, OpenFlags, OptionalExtension};

/// Longest search term we accept. A stock check is typed on a phone; beyond this it is not a query
/// any more, and an unbounded string reaching a LIKE scan is free CPU for anyone on the LAN.
pub const MAX_QUERY_LEN: usize = 64;
/// Hard ceiling on hits, whatever the caller asks for.
pub const MAX_SEARCH_RESULTS: u32 = 50;

/// The columns every product JSON is built from. One list, so the scan and the search cannot drift.
const PRODUCT_COLUMNS: &str = "p.id, p.brand, p.name, p.sku, p.condition, p.scope_of_delivery, \
     p.storage_location, p.purchase_price, p.planned_sale_price, p.min_sale_price, p.max_sale_price, \
     p.stock_status, p.images, p.attributes, p.category_id, p.quantity, p.notes, \
     p.updated_at";

fn col_num(r: &rusqlite::Row, idx: usize) -> Option<f64> {
    use rusqlite::types::ValueRef;
    match r.get_ref(idx) {
        Ok(ValueRef::Real(f)) => Some(f),
        Ok(ValueRef::Integer(i)) => Some(i as f64),
        Ok(ValueRef::Text(t)) => std::str::from_utf8(t).ok().and_then(|s| s.trim().parse::<f64>().ok()),
        _ => None,
    }
}

fn row_to_product_json(r: &rusqlite::Row<'_>) -> rusqlite::Result<serde_json::Value> {
    Ok(serde_json::json!({
        "id":                r.get::<_, Option<String>>(0)?,
        "brand":             r.get::<_, Option<String>>(1)?,
        "name":              r.get::<_, Option<String>>(2)?,
        "sku":               r.get::<_, Option<String>>(3)?,
        "condition":         r.get::<_, Option<String>>(4)?,
        "scope_of_delivery": r.get::<_, Option<String>>(5)?,
        "storage_location":  r.get::<_, Option<String>>(6)?,
        "purchase_price":    col_num(r, 7),
        "planned_sale_price": col_num(r, 8),
        "min_sale_price":    col_num(r, 9),
        "max_sale_price":    col_num(r, 10),
        "stock_status":      r.get::<_, Option<String>>(11)?,
        "images":            r.get::<_, Option<String>>(12)?,
        "attributes":        r.get::<_, Option<String>>(13)?,
        "category_id":       r.get::<_, Option<String>>(14)?,
        "quantity":          col_num(r, 15),
        "notes":             r.get::<_, Option<String>>(16)?,
        // v0.8.49 — der Zeitstempel gehoert in den Vertrag: nach einem Speichern erkennt die
        // Seite daran, DASS der Desktop den Auftrag angewandt hat, statt es zu vermuten oder
        // sich den neuen Zustand selbst zusammenzubauen.
        "updated_at":        r.get::<_, Option<String>>(17)?,
    }))
}

pub fn open_read_only(db_path: &std::path::Path) -> Option<Connection> {
    Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()
}

/// Resolve the display category name, and — the part v0.8.37 broke — the gallery image.
///
/// Before the legacy-media migration every product carried its photo inline in `products.images`,
/// and the mobile page simply rendered `images[0]`. After the migration that column is `[]` for
/// every product, so the scan showed a product with no picture. The bytes now live in the media
/// store, reachable only through the link → object → blob → generation chain, and only the
/// CURRENT generation of a blob that is actually `present` may be offered.
fn enrich(conn: &Connection, tenant_id: &str, product: &mut serde_json::Value) {
    if let Some(cat_id) = product.get("category_id").and_then(|v| v.as_str()).map(str::to_string) {
        if let Ok(name) = conn.query_row(
            "SELECT name FROM categories WHERE id = ?1",
            rusqlite::params![cat_id],
            |r| r.get::<_, String>(0),
        ) {
            product["category_name"] = serde_json::Value::String(name);
        }
    }

    let Some(product_id) = product.get("id").and_then(|v| v.as_str()).map(str::to_string) else { return };

    // v0.8.48 — die Auskunft zur Preissperre gehoert an JEDES Produkt-JSON, das die Seite je zu
    // sehen bekommt. Ohne diesen Aufruf blieb `price_editable` schlicht aus: die Seite fragt
    // `p.price_editable === true`, und was nie mitgeschickt wird, ist nie wahr — die Preisfelder
    // erschienen damit auch bei einem voellig freien Artikel nicht. Verbindlich entscheidet
    // weiterhin der Koordinator INNERHALB der Schreib-Transaktion; das hier ist die Anzeige dazu.
    attach_price_verdict(conn, &product_id, product);

    // Primary first, then gallery order — the same ordering the desktop resolver uses, so the
    // photo on the phone is the photo on the desktop.
    let master: Option<String> = conn
        .query_row(
            "SELECT g.storage_key
               FROM media_links l
               JOIN media_objects o ON o.tenant_id = l.tenant_id AND o.media_id = l.media_id
               JOIN media_blobs b ON b.tenant_id = o.tenant_id AND b.blob_id = o.master_blob_id
               JOIN media_blob_generations g ON g.tenant_id = b.tenant_id AND g.blob_id = b.blob_id
                                            AND g.generation_no = b.current_generation_no
              WHERE l.tenant_id = ?1 AND l.entity_type = 'product' AND l.entity_id = ?2
                AND l.deleted_at IS NULL AND o.deleted_at IS NULL AND g.deleted_at IS NULL
                AND o.ingest_status = 'ready' AND b.blob_status = 'present' AND g.gen_status = 'available'
              ORDER BY l.is_primary DESC, l.sort_order ASC, l.link_id ASC
              LIMIT 1",
            rusqlite::params![tenant_id, product_id],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten();

    let thumb: Option<String> = conn
        .query_row(
            "SELECT g.storage_key
               FROM media_links l
               JOIN media_variants v ON v.tenant_id = l.tenant_id AND v.media_id = l.media_id
                                    AND v.variant_type = 'thumbnail' AND v.deleted_at IS NULL
               -- v0.8.44: the object join is not optional. Without it a DELETED media object still
               -- handed the phone a thumbnail key, while the desktop gallery showed nothing for it —
               -- and since the reachability contract (correctly) does not consider that file
               -- required, a backup would not carry it. Phone and desktop now resolve the same set.
               JOIN media_objects o ON o.tenant_id = v.tenant_id AND o.media_id = v.media_id
                                   AND o.deleted_at IS NULL
               JOIN media_blobs b ON b.tenant_id = v.tenant_id AND b.blob_id = v.blob_id
               JOIN media_blob_generations g ON g.tenant_id = b.tenant_id AND g.blob_id = b.blob_id
                                            AND g.generation_no = b.current_generation_no
              WHERE l.tenant_id = ?1 AND l.entity_type = 'product' AND l.entity_id = ?2
                AND l.deleted_at IS NULL AND b.blob_status = 'present' AND g.gen_status = 'available'
              ORDER BY l.is_primary DESC, l.sort_order ASC, l.link_id ASC
              LIMIT 1",
            rusqlite::params![tenant_id, product_id],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten();

    if let Some(k) = master {
        product["image_key"] = serde_json::Value::String(k);
    }
    if let Some(k) = thumb {
        product["thumb_key"] = serde_json::Value::String(k);
    }

    // ── MOBILE-EDIT-S1 — die VOLLSTAENDIGE geordnete Galerie, nicht nur das Titelbild ──
    //
    // Zum Bearbeiten reicht `image_key` nicht. Wer nur das erste Bild kennt, kann die anderen weder
    // zeigen noch bewusst behalten — und genau daraus entsteht die Fehlerklasse "Save loescht die
    // vier Bilder, die das Handy nie gesehen hat". Jede Zeile traegt deshalb ihre STABILE Identitaet
    // (`link_id`, `media_id`), ihre Position und ob sie das Titelbild ist. Sichtbarkeitsbedingung und
    // Sortierung sind exakt die der Abfragen oben, damit Handy und Desktop denselben Satz in
    // derselben Reihenfolge sehen. Read-only: diese Funktion mutiert nichts.
    //
    // MOBILE-EDIT-S3 §1 — HARTE VORBEDINGUNG: ein Lesefehler ist KEINE leere Galerie.
    // Frueher schluckte `unwrap_or_default()` den Query-Fehler und `filter_map(|r| r.ok())` jede
    // einzelne unlesbare Zeile — beides machte aus "konnte nicht gelesen werden" ein "hat keine
    // Bilder". Solange nur Text bearbeitet wurde, war das folgenlos. Sobald ein Save die Galerie
    // schreibt, waere es Datenverlust: die Seite haette nichts gesehen, was sie behalten koennte.
    // Deshalb wird hier strikt gesammelt und der Fehler nach oben gereicht.
    let gallery: Result<Vec<serde_json::Value>, rusqlite::Error> = conn
        .prepare(
            "SELECT l.link_id, l.media_id, l.is_primary, l.sort_order, g.storage_key, t.storage_key
               FROM media_links l
               JOIN media_objects o ON o.tenant_id = l.tenant_id AND o.media_id = l.media_id
               JOIN media_blobs b ON b.tenant_id = o.tenant_id AND b.blob_id = o.master_blob_id
               JOIN media_blob_generations g ON g.tenant_id = b.tenant_id AND g.blob_id = b.blob_id
                                            AND g.generation_no = b.current_generation_no
               LEFT JOIN media_variants v ON v.tenant_id = l.tenant_id AND v.media_id = l.media_id
                                         AND v.variant_type = 'thumbnail' AND v.deleted_at IS NULL
               LEFT JOIN media_blobs tb ON tb.tenant_id = v.tenant_id AND tb.blob_id = v.blob_id
               LEFT JOIN media_blob_generations t ON t.tenant_id = tb.tenant_id AND t.blob_id = tb.blob_id
                                                 AND t.generation_no = tb.current_generation_no
                                                 AND t.gen_status = 'available' AND t.deleted_at IS NULL
              WHERE l.tenant_id = ?1 AND l.entity_type = 'product' AND l.entity_id = ?2
                AND l.deleted_at IS NULL AND o.deleted_at IS NULL AND g.deleted_at IS NULL
                AND o.ingest_status = 'ready' AND b.blob_status = 'present' AND g.gen_status = 'available'
              ORDER BY l.is_primary DESC, l.sort_order ASC, l.link_id ASC",
        )
        .and_then(|mut st| {
            st.query_map(rusqlite::params![tenant_id, product_id], |r| {
                Ok(serde_json::json!({
                    "link_id":    r.get::<_, String>(0)?,
                    "media_id":   r.get::<_, String>(1)?,
                    "is_primary": r.get::<_, i64>(2)? != 0,
                    "sort_order": r.get::<_, i64>(3)?,
                    "image_key":  r.get::<_, String>(4)?,
                    "thumb_key":  r.get::<_, Option<String>>(5)?,
                }))
            })
            .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
        });

    // Fail closed: ohne vollstaendig gelesene Galerie gibt es weder eine Liste noch einen Baseline.
    // `gallery_ok:false` ist das einzige, was die Seite dann sieht — sie zeigt einen Fehler und
    // laesst keine Galerie-Bearbeitung zu, statt eine leere Galerie zu behaupten.
    let gallery = match gallery {
        Ok(g) => g,
        Err(_) => {
            product["gallery_ok"] = serde_json::Value::Bool(false);
            return;
        }
    };
    product["gallery_ok"] = serde_json::Value::Bool(true);

    // Der Baseline-Nachweis: ein Fingerabdruck GENAU der Galerie, die das Handy gerade bekommen hat
    // — Identitaet, Position und Titelbild-Flag jeder Zeile, in Reihenfolge. Ein spaeterer Save
    // schickt ihn zurueck; weicht er dann vom aktuellen Stand ab, hat sich die Galerie inzwischen
    // geaendert. Deterministisch aus genau diesem Zustand, sonst waere er als Waechter wertlos.
    let fingerprint = gallery
        .iter()
        .map(|g| {
            format!(
                "{}:{}:{}:{}",
                g["link_id"].as_str().unwrap_or(""),
                g["media_id"].as_str().unwrap_or(""),
                g["sort_order"].as_i64().unwrap_or(-1),
                i32::from(g["is_primary"].as_bool().unwrap_or(false))
            )
        })
        .collect::<Vec<_>>()
        .join("|");
    product["gallery"] = serde_json::Value::Array(gallery);
    product["gallery_baseline"] = serde_json::Value::String(sha256_hex(fingerprint.as_bytes()));
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// Tenancy: `products` has no tenant_id, so the binding is the join onto `branches` — identical to
/// the legacy-media planner and the stock-check scope proof, so all three agree on what is in scope.
const SCOPE_JOIN: &str = "FROM products p JOIN branches b ON b.id = p.branch_id AND b.tenant_id = ?1 \
     WHERE p.branch_id = ?2";

/// v0.8.48 — darf die Bedienoberflaeche die Preisfelder dieses Artikels FREIGEBEN, und wenn nicht: warum?
///
/// Das ist eine ANZEIGE-Auskunft, keine Freigabe: verbindlich entscheidet der Koordinator INNERHALB
/// der Schreib-Transaktion. Beide stellen dieselben zwei Fragen, und zwar ueber echte Relationen,
/// nicht ueber SKU, Datum oder Kategorie:
///
///   A — ist es eigener, freier Bestand? `products.source_type = 'OWN'` — eine echte
///       Domaenen-Klassifikation: Agenten- und Kommissionsware tragen `AGENT` bzw. `CONSIGNMENT`
///       und bekommen `OWN` erst zurueck, wenn sie zurueckkommen. WIE der Artikel angelegt wurde,
///       spielt ausdruecklich keine Rolle: Desktop-Collection, Handy-Collection, Import und
///       Altbestand sind gleichberechtigt.
///   B — haengt er an keinem Geschaeftsvorgang? Geprueft wird jede Tabelle mit Produktbezug.
///
/// Bewusst NICHT dabei: `inventory_session_items` (eine Zaehlung ist kein Vorgang) und
/// `mobile_upload_receipts` (eine technische Upload-Quittung, keine geschaeftliche Bindung).
/// Die Liste spiegelt `TRANSACTION_RELATIONS` in `src/core/products/price-eligibility.ts`.
/// Fehlschlaege sperren — ein Feld nicht freizugeben ist immer sicher. Sichtbar bleiben die Felder
/// trotzdem: der Nutzer sieht den Preis und daneben den Grund, warum er ihn hier nicht aendert.
const PRICE_LOCK_RELATIONS: [(&str, &str); 13] = [
    ("purchase_lines", "Purchase"),
    ("purchase_return_lines", "Purchase return"),
    ("invoice_lines", "Invoice"),
    ("sales_return_lines", "Sales return"),
    ("offer_lines", "Offer"),
    ("orders", "Order"),
    ("order_lines", "Order"),
    ("stock_lots", "Stock lot"),
    ("consignments", "Consignment"),
    ("agent_transfers", "Agent transfer"),
    ("production_inputs", "Production"),
    ("production_outputs", "Production"),
    ("repairs", "Repair"),
];

/// Das Ergebnis dieser Auskunft. `Unknown` ist ausdruecklich kein Sammelbecken, sondern eine eigene
/// Aussage: "gesperrt, aber der Grund ist NICHT sicher bekannt" — dann nennt die Seite auch keinen.
/// Einen falschen Grund zu behaupten waere schlimmer als gar keinen.
enum PriceVerdict {
    Editable,
    /// Haengt an einem Geschaeftsvorgang; der Wert ist dessen Anzeigename.
    Linked(&'static str),
    /// Gehoert nicht zum eigenen freien Bestand; der Wert ist die erkannte Klasse.
    NotOwnStock(&'static str),
    Unknown,
}

fn price_verdict(conn: &Connection, product_id: &str) -> PriceVerdict {
    // A — eigener, freier Bestand. Gelesen wird die echte Spalte. Ein fehlender Datensatz, ein
    // NULL-Wert oder eine Klasse, die diese Anzeige nicht kennt, sperrt OHNE Begruendung.
    match conn.query_row(
        "SELECT source_type FROM products WHERE id = ?1",
        rusqlite::params![product_id],
        |r| r.get::<_, Option<String>>(0),
    ) {
        Ok(Some(s)) if s == "OWN" => {}
        Ok(Some(s)) if s == "CONSIGNMENT" => return PriceVerdict::NotOwnStock("Consignment"),
        Ok(Some(s)) if s == "AGENT" => return PriceVerdict::NotOwnStock("Agent"),
        _ => return PriceVerdict::Unknown,
    }
    // B — keine einzige geschaeftliche Verknuepfung. `-1` heisst "nicht lesbar": das sperrt
    // ebenfalls, ist aber kein Beleg fuer eine Verknuepfung und wird deshalb auch nicht als einer
    // ausgegeben.
    for (table, label) in PRICE_LOCK_RELATIONS {
        match conn
            .query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE product_id = ?1"),
                rusqlite::params![product_id],
                |r| r.get::<_, i64>(0),
            )
            .unwrap_or(-1)
        {
            0 => {}
            n if n > 0 => return PriceVerdict::Linked(label),
            _ => return PriceVerdict::Unknown,
        }
    }
    PriceVerdict::Editable
}

/// Die Auskunft in das Produkt-JSON schreiben: immer genau ein `price_editable`, und einen Grund
/// nur dann, wenn er sicher ist. Die Seite zeigt die drei Preisfelder daraufhin sichtbar, aber
/// gesperrt, mit genau diesem Grund als Hinweis.
fn attach_price_verdict(conn: &Connection, product_id: &str, product: &mut serde_json::Value) {
    let (editable, reason, detail) = match price_verdict(conn, product_id) {
        PriceVerdict::Editable => (true, None, None),
        PriceVerdict::Linked(l) => (false, Some("linked"), Some(l)),
        PriceVerdict::NotOwnStock(l) => (false, Some("not_own_stock"), Some(l)),
        PriceVerdict::Unknown => (false, Some("unknown"), None),
    };
    product["price_editable"] = serde_json::Value::Bool(editable);
    if let Some(r) = reason {
        product["price_lock_reason"] = serde_json::Value::String(r.to_string());
    }
    if let Some(d) = detail {
        product["price_lock_detail"] = serde_json::Value::String(d.to_string());
    }
}

pub fn by_sku(
    db_path: &std::path::Path,
    tenant_id: &str,
    branch_id: &str,
    sku: &str,
) -> Option<serde_json::Value> {
    let conn = open_read_only(db_path)?;
    let mut product = conn
        .prepare(&format!("SELECT {PRODUCT_COLUMNS} {SCOPE_JOIN} AND p.sku = ?3 LIMIT 1"))
        .ok()?
        .query_row(rusqlite::params![tenant_id, branch_id, sku], |r| row_to_product_json(r))
        .optional()
        .ok()
        .flatten()?;
    enrich(&conn, tenant_id, &mut product);
    Some(product)
}

pub fn by_id(
    db_path: &std::path::Path,
    tenant_id: &str,
    branch_id: &str,
    product_id: &str,
) -> Option<serde_json::Value> {
    let conn = open_read_only(db_path)?;
    let mut product = conn
        .prepare(&format!("SELECT {PRODUCT_COLUMNS} {SCOPE_JOIN} AND p.id = ?3 LIMIT 1"))
        .ok()?
        .query_row(rusqlite::params![tenant_id, branch_id, product_id], |r| row_to_product_json(r))
        .optional()
        .ok()
        .flatten()?;
    enrich(&conn, tenant_id, &mut product);
    Some(product)
}

/// Trim, cap, and reject a term that cannot usefully match. Returns None when there is nothing to
/// search for — the caller answers with an empty result rather than scanning the whole table.
pub fn normalise_query(raw: &str) -> Option<String> {
    let t = raw.trim();
    if t.is_empty() {
        return None;
    }
    let capped: String = t.chars().take(MAX_QUERY_LEN).collect();
    Some(capped)
}

/// Escape the LIKE metacharacters so a typed `%`, `_` or `\` matches itself.
///
/// Without this, "50%" matches every product in the branch, and a search for an underscore in a
/// reference number silently becomes a single-character wildcard. Paired with `ESCAPE '\'` below.
pub fn escape_like(term: &str) -> String {
    let mut out = String::with_capacity(term.len() + 8);
    for c in term.chars() {
        if c == '\\' || c == '%' || c == '_' {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Relevance-ordered search across the fields a person actually reads off a tag.
///
/// The ranking is §14's: an exact identifier beats a prefix, a prefix beats a substring, and the
/// identifier fields (SKU, serial, reference) outrank the descriptive ones — typing a full serial
/// should put that watch first even if the digits also appear inside somebody's notes.
///
/// The score is computed in SQL rather than in Rust so ORDER BY can use it directly; every value it
/// compares against is a bound parameter.
pub fn search(
    db_path: &std::path::Path,
    tenant_id: &str,
    branch_id: &str,
    raw_query: &str,
    limit: u32,
) -> Vec<serde_json::Value> {
    let Some(term) = normalise_query(raw_query) else { return Vec::new() };
    let Some(conn) = open_read_only(db_path) else { return Vec::new() };

    let exact = term.to_lowercase();
    let esc = escape_like(&term);
    let prefix = format!("{esc}%");
    let contains = format!("%{esc}%");
    let limit = limit.clamp(1, MAX_SEARCH_RESULTS);

    // ?1 tenant, ?2 branch, ?3 exact(lower), ?4 prefix-pattern, ?5 contains-pattern, ?6 limit
    let sql = format!(
        r#"
        WITH scoped AS (
          SELECT {PRODUCT_COLUMNS},
                 LOWER(COALESCE(p.sku,''))                                            AS l_sku,
                 LOWER(COALESCE(json_extract(p.attributes,'$.serial_number'),''))      AS l_serial,
                 LOWER(COALESCE(json_extract(p.attributes,'$.reference_number'),''))   AS l_ref,
                 LOWER(COALESCE(json_extract(p.attributes,'$.model_number'),''))       AS l_model,
                 COALESCE(json_extract(p.attributes,'$.serial_number'),'')             AS serial_raw,
                 COALESCE(json_extract(p.attributes,'$.reference_number'),'')          AS ref_raw,
                 COALESCE(json_extract(p.attributes,'$.model_number'),'')              AS model_raw,
                 COALESCE(json_extract(p.attributes,'$.description'),'')               AS attr_desc
          {SCOPE_JOIN}
        )
        SELECT {PRODUCT_COLUMNS_BARE},
               CASE
                 WHEN l_sku    = ?3 THEN 100
                 WHEN l_serial = ?3 THEN 90
                 WHEN l_ref    = ?3 THEN 80
                 WHEN l_model  = ?3 THEN 70
                 WHEN sku LIKE ?4 ESCAPE '\' OR serial_raw LIKE ?4 ESCAPE '\'
                   OR ref_raw LIKE ?4 ESCAPE '\' OR model_raw LIKE ?4 ESCAPE '\' THEN 60
                 WHEN brand LIKE ?4 ESCAPE '\' OR name LIKE ?4 ESCAPE '\' THEN 50
                 ELSE 30
               END AS score
          FROM scoped
         WHERE l_sku = ?3 OR l_serial = ?3 OR l_ref = ?3 OR l_model = ?3
            OR COALESCE(sku,'')        LIKE ?5 ESCAPE '\'
            OR COALESCE(brand,'')      LIKE ?5 ESCAPE '\'
            OR COALESCE(name,'')       LIKE ?5 ESCAPE '\'
            OR serial_raw              LIKE ?5 ESCAPE '\'
            OR ref_raw                 LIKE ?5 ESCAPE '\'
            OR model_raw               LIKE ?5 ESCAPE '\'
            OR attr_desc               LIKE ?5 ESCAPE '\'
            OR COALESCE(notes,'')      LIKE ?5 ESCAPE '\'
         ORDER BY score DESC, COALESCE(brand,'') ASC, COALESCE(name,'') ASC, id ASC
         LIMIT ?6
        "#,
        PRODUCT_COLUMNS = PRODUCT_COLUMNS,
        PRODUCT_COLUMNS_BARE = PRODUCT_COLUMNS.replace("p.", ""),
        SCOPE_JOIN = SCOPE_JOIN,
    );

    let Ok(mut stmt) = conn.prepare(&sql) else { return Vec::new() };
    let rows = stmt.query_map(
        rusqlite::params![tenant_id, branch_id, exact, prefix, contains, limit],
        |r| row_to_product_json(r),
    );
    let Ok(rows) = rows else { return Vec::new() };

    let mut out = Vec::new();
    for row in rows.flatten() {
        let mut p = row;
        enrich(&conn, tenant_id, &mut p);
        out.push(p);
    }
    out
}

/// Turn a storage key into a path inside the media root — or refuse.
///
/// The key is NOT trusted as a path. It must be `<scope>/<2 hex>/<64 hex>.<ext>` with no separator
/// beyond those two, which makes `..`, absolute paths, drive letters and UNC prefixes structurally
/// unrepresentable rather than filtered. Callers additionally verify the key exists in
/// `media_blob_generations`, so only blobs the database knows about can ever be served.
pub fn media_path_for_key(media_root: &std::path::Path, key: &str) -> Option<std::path::PathBuf> {
    let parts: Vec<&str> = key.split('/').collect();
    if parts.len() != 3 {
        return None;
    }
    let (scope, shard, file) = (parts[0], parts[1], parts[2]);
    let scope_ok = !scope.is_empty()
        && scope.len() <= 64
        && scope.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    let shard_ok = shard.len() == 2 && shard.chars().all(|c| c.is_ascii_hexdigit());
    let (stem, ext) = file.rsplit_once('.')?;
    let file_ok = stem.len() == 64
        && stem.chars().all(|c| c.is_ascii_hexdigit())
        && crate::media::storage::stored_kind(ext).is_some();
    if !(scope_ok && shard_ok && file_ok) {
        return None;
    }
    Some(media_root.join(scope).join(shard).join(file))
}

/// MEDIA-IDENTITY §1 — die kanonische Rolle, fail-closed.
///
/// Dieselbe Abbildung wie `canonicalRole` in `src/core/models/types.ts`, mit EINEM bewussten
/// Unterschied: dort wird ein unbekannter Wert auf die schwächste Rolle abgebildet, damit eine
/// Oberfläche etwas anzeigen kann. Hier geht es um Dateibytes über das Netz — eine Rolle, die wir
/// nicht kennen, bekommt nichts.
fn canonical_role(role: &str) -> Option<&'static str> {
    match role.trim() {
        "owner" | "ADMIN" => Some("ADMIN"),
        "manager" | "MANAGER" => Some("MANAGER"),
        "sales" | "SALES" | "viewer" => Some("SALES"),
        "backoffice" | "ACCOUNTANT" => Some("ACCOUNTANT"),
        _ => None,
    }
}

/// Darf DIESE Rolle das Ausweisdokument DIESER Art sehen?
///
/// Die Antwort ist aus `ROLE_PERMISSIONS` abgeleitet und nicht erfunden: ein Ausweisdokument sieht,
/// wer den Datensatz selbst sehen darf. `customers.view` hat jede bekannte Rolle; `suppliers.view`
/// hat SALES nicht — also sieht der Verkauf den Lieferantenausweis auch nicht. Ein Parity-Test auf
/// der TypeScript-Seite hält die beiden Listen zusammen.
pub fn role_may_read_identity(role: &str, owner_type: &str) -> bool {
    let Some(c) = canonical_role(role) else { return false };
    match owner_type {
        "customer" => matches!(c, "ADMIN" | "MANAGER" | "SALES" | "ACCOUNTANT"),
        "supplier" => matches!(c, "ADMIN" | "MANAGER" | "ACCOUNTANT"),
        _ => false,
    }
}

/// MEDIA-S1 — what a verified read of one stored file may rely on: the content hash and size the
/// database holds for it, and its extension (which fixes MIME type and size limit).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaReadGrant {
    pub hash: String,
    pub byte_size: u64,
    pub ext: String,
}

/// MEDIA-S1 — may THIS caller read THIS stored file? A well-formed, existing key alone is no longer
/// enough (S0 finding: any authenticated client of the tenant could read any key it learned).
///
/// Everything comes from the verified token and the database, nothing from the request but the key:
///   • tenant  — the generation belongs to the caller's tenant;
///   • the file is the CURRENT, available generation of a present blob;
///   • it is the master or an active variant of an active media object;
///   • that object is linked (active link) to an OWNER the caller may see: today exactly a product
///     of the caller's branch that still exists — every other entity type is refused until its own
///     read rule is written (fail-closed, no silent widening);
///   • security class `public` or `internal` only — `sensitive` and `highly_sensitive` are never
///     served over this LAN route.
/// Any read error is a refusal.
pub fn media_read_grant(
    db_path: &std::path::Path,
    tenant_id: &str,
    branch_id: &str,
    role: &str,
    key: &str,
) -> Option<MediaReadGrant> {
    let conn = open_read_only(db_path)?;
    // MEDIA-IDENTITY §1 — die Rollenfrage wird HIER beantwortet, nicht in SQL: eine Rollentabelle
    // in einer WHERE-Klausel wäre eine zweite Rollenarchitektur neben `role-permissions.ts`.
    let may_customer = if role_may_read_identity(role, "customer") { 1i64 } else { 0 };
    let may_supplier = if role_may_read_identity(role, "supplier") { 1i64 } else { 0 };
    if let Some(g) = live_media_grant(&conn, tenant_id, branch_id, key, may_customer, may_supplier) {
        return Some(g);
    }
    // MEDIA-IDENTITY §7 — und erst dann die Geschichte: die Fassung, die ein Einkauf eingefroren
    // hat. Sie ist absichtlich NICHT mehr die aktuelle, also faellt sie durch die Regel oben.
    historical_identity_grant(&conn, tenant_id, branch_id, key, may_customer, may_supplier)
}

/// Die lebende Regel: ein Medium, das JETZT an einem Datensatz dieser Filiale haengt.
fn live_media_grant(
    conn: &rusqlite::Connection,
    tenant_id: &str,
    branch_id: &str,
    key: &str,
    may_customer: i64,
    may_supplier: i64,
) -> Option<MediaReadGrant> {
    conn.query_row(
        "SELECT g.stored_blob_hash, g.byte_size, g.extension
           FROM media_blob_generations g
           JOIN media_blobs b ON b.tenant_id = g.tenant_id AND b.blob_id = g.blob_id
                             AND b.current_generation_no = g.generation_no AND b.blob_status = 'present'
           JOIN media_objects o ON o.tenant_id = g.tenant_id AND o.deleted_at IS NULL
                               AND (o.master_blob_id = g.blob_id OR EXISTS (
                                     SELECT 1 FROM media_variants v
                                      WHERE v.tenant_id = o.tenant_id AND v.media_id = o.media_id
                                        AND v.blob_id = g.blob_id AND v.deleted_at IS NULL))
           JOIN media_links l ON l.tenant_id = o.tenant_id AND l.media_id = o.media_id AND l.deleted_at IS NULL
           JOIN branches br ON br.id = l.branch_id AND br.tenant_id = g.tenant_id
          WHERE g.tenant_id = ?1 AND g.storage_key = ?2 AND g.gen_status = 'available' AND g.deleted_at IS NULL
            AND l.scope_kind = 'branch' AND l.branch_id = ?3
            -- MEDIA-REPAIR / MEDIA-IDENTITY — jeder Besitzertyp mit SEINER Rolle, SEINER Tabelle UND
            -- SEINER Sicherheitsklasse: der Datensatz muss existieren und in genau dieser Filiale
            -- liegen. Die Klasse steht bewusst je Zweig und nicht mehr gemeinsam oben — ein
            -- Ausweisdokument ist `sensitive`, ein Artikelbild darf das nie sein. Ein Typ ohne Regel
            -- wird nicht bedient, `highly_sensitive` von keinem Zweig.
            AND (
              (o.security_class IN ('public', 'internal')
                 AND l.entity_type = 'product' AND l.media_role = 'stock_image'
                 AND EXISTS (SELECT 1 FROM products p WHERE p.id = l.entity_id AND p.branch_id = l.branch_id))
              OR
              (o.security_class IN ('public', 'internal')
                 AND l.entity_type = 'repair' AND l.media_role = 'gallery'
                 AND EXISTS (SELECT 1 FROM repairs r WHERE r.id = l.entity_id AND r.branch_id = l.branch_id))
              OR
              -- MEDIA-SCRAP — die Belegfotos EINER Position eines Altgold-Geschäfts. Die Kennung
              -- ist `line_key` und nicht `id`: die Zeile entsteht bei jedem Ändern neu, der
              -- Schlüssel bleibt. Zwei feste Rollen, eine Filiale, Klasse wie ein Belegfoto.
              (o.security_class IN ('public', 'internal')
                 AND l.entity_type = 'scrap_trade_line'
                 AND l.media_role IN ('purchase_photo', 'sale_photo')
                 AND EXISTS (SELECT 1 FROM scrap_trade_lines sl
                              WHERE sl.line_key = l.entity_id AND sl.branch_id = l.branch_id))
              OR
              -- MEDIA-INBOX — das Foto im Einkaufs-Posteingang. Der zweite Rechner zeigt diese
              -- Liste genauso, also muss er sie auch sehen duerfen. Eine Rolle, die Filiale des
              -- Eintrags, Klasse wie ein internes Arbeitsfoto — nie `sensitive`.
              (o.security_class IN ('public', 'internal')
                 AND l.entity_type = 'purchase_inbox' AND l.media_role = 'intake_photo'
                 AND EXISTS (SELECT 1 FROM purchase_inbox pi
                              WHERE pi.id = l.entity_id AND pi.branch_id = l.branch_id))
              OR
              -- MEDIA-DOCUMENTS — die hochgeladene Datei EINES Belegs der Dokumentenmappe. Der
              -- zweite Rechner zeigt dieselbe Mappe, also muss er sie auch oeffnen duerfen. Eine
              -- Rolle, die Filiale des Belegs, Klasse wie eine interne Unterlage — nie `sensitive`.
              (o.security_class IN ('public', 'internal')
                 AND l.entity_type = 'document' AND l.media_role = 'file'
                 AND EXISTS (SELECT 1 FROM documents dc
                              WHERE dc.id = l.entity_id AND dc.branch_id = l.branch_id))
              OR
              (o.security_class = 'sensitive' AND ?4 = 1
                 AND l.entity_type = 'customer' AND l.media_role = 'identity_document'
                 AND EXISTS (SELECT 1 FROM customers c WHERE c.id = l.entity_id AND c.branch_id = l.branch_id))
              OR
              (o.security_class = 'sensitive' AND ?5 = 1
                 AND l.entity_type = 'supplier' AND l.media_role = 'identity_document'
                 AND EXISTS (SELECT 1 FROM suppliers s WHERE s.id = l.entity_id AND s.branch_id = l.branch_id))
            )
          LIMIT 1",
        rusqlite::params![tenant_id, key, branch_id, may_customer, may_supplier],
        |r| Ok(MediaReadGrant {
            hash: r.get::<_, String>(0)?,
            byte_size: r.get::<_, i64>(1)? as u64,
            ext: r.get::<_, String>(2)?,
        }),
    )
    .optional()
    .ok()
    .flatten()
}

/// MEDIA-IDENTITY §7/§8 — die EINE historische Ausnahme: die Ausweisfassung, die ein Einkauf
/// dieser Filiale eingefroren hat.
///
/// Warum es sie braucht: ein alter Beleg muss die Fassung zeigen, die BEIM KAUF galt. Sobald der
/// Kunde sein Dokument austauscht, ist die damalige nicht mehr die aktuelle — die lebende Regel
/// oben weist sie also ab, und der zweite Rechner saehe bei einem alten Einkauf entweder nichts
/// oder, schlimmer, das NEUE Foto als vermeintlichen Nachweis.
///
/// Warum das kein Loch ist: es wird nicht nach dem Schluessel allein entschieden. Der Beleg muss
/// in der Filiale des Aufrufers liegen, er muss GENAU diese Fassung benennen (Schluessel, Hash und
/// Fassungsnummer zusammen), und die Rolle des Lesers muss zu dem passen, wessen Ausweis es war.
/// Die Verknuepfung wird hier bewusst NICHT verlangt — dass sie fehlt, ist der Normalfall eines
/// historischen Nachweises.
fn historical_identity_grant(
    conn: &rusqlite::Connection,
    tenant_id: &str,
    branch_id: &str,
    key: &str,
    may_customer: i64,
    may_supplier: i64,
) -> Option<MediaReadGrant> {
    conn.query_row(
        "SELECT g.stored_blob_hash, g.byte_size, g.extension
           FROM purchases p
           JOIN branches br ON br.id = p.branch_id AND br.tenant_id = ?1
           JOIN media_blob_generations g ON g.tenant_id = ?1 AND g.storage_key = ?2
                                        AND g.stored_blob_hash = json_extract(p.supplier_snapshot, '$.identity.blobHash')
                                        AND g.generation_no = json_extract(p.supplier_snapshot, '$.identity.generationNo')
          WHERE p.branch_id = ?3
            AND json_extract(p.supplier_snapshot, '$.identity.storageKey') = ?2
            AND (
              (json_extract(p.supplier_snapshot, '$.identity.ownerType') = 'customer' AND ?4 = 1)
              OR
              (json_extract(p.supplier_snapshot, '$.identity.ownerType') = 'supplier' AND ?5 = 1)
            )
          LIMIT 1",
        rusqlite::params![tenant_id, key, branch_id, may_customer, may_supplier],
        |r| Ok(MediaReadGrant {
            hash: r.get::<_, String>(0)?,
            byte_size: r.get::<_, i64>(1)? as u64,
            ext: r.get::<_, String>(2)?,
        }),
    )
    .optional()
    .ok()
    .flatten()
}

/// MEDIA-S1 — read the granted file and hand it out only if it is exactly what the database vouches
/// for: within its kind's size limit (checked before reading), the recorded size, the recorded hash.
pub fn read_granted_media(path: &std::path::Path, grant: &MediaReadGrant) -> Option<Vec<u8>> {
    let kind = crate::media::storage::stored_kind(&grant.ext)?;
    let md = std::fs::metadata(path).ok()?;
    if !md.is_file() || md.len() > kind.max_bytes || md.len() != grant.byte_size {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() as u64 != grant.byte_size || crate::media::storage::sha256_hex(&bytes) != grant.hash {
        return None;
    }
    Some(bytes)
}

#[cfg(test)]
#[path = "product_query_tests.rs"]
mod product_query_tests;
