// ════════════════════════════════════════════════════════════════════════════
// MEDIA REACHABILITY — the one place that answers "which media files matter?".
//
// Three subsystems asked that question and gave three different answers, which is fine right up
// until they have to agree about one folder:
//
//   • BACKUP selected the media a business record can actually show.
//   • MEDIA-GC protected every generation row it could find, deliberately over-broad.
//   • THE DATA-ROOT MOVE demanded a file for every generation row — the GC's set — and therefore
//     refused to move a data set that the backup considered complete.
//
// That contradiction was found live: a restored snapshot could not be moved, because two blobs from
// an abandoned upload in August were referenced by generation rows, linked to nothing, shown
// nowhere, and consequently never backed up. The backup was right and the move was wrong, but only
// because they were answering different questions with the same word.
//
// So there are two sets here, named for what they mean, and each subsystem says which one it needs:
//
//   REQUIRED   — reachable by a business consumer right now. A product's gallery resolves exactly
//                this, and so does the workbook export, the AI image source and the mobile page,
//                because they all go through the same link → object → current generation path.
//                A missing REQUIRED file is a visible hole in someone's data. Backup carries these;
//                the move refuses to proceed without them; a restore must reproduce them.
//
//   PRESERVED  — everything a generation row still points at, whatever its status. Strictly wider
//                than REQUIRED: an in-flight ingest, a superseded generation, an abandoned upload.
//                Nothing here may be DELETED (the GC's rule), but nothing here is required to
//                exist for the data set to be sound.
//
// The distinction is the whole point: "may I delete this?" and "must this exist?" are different
// questions, and the second one is the strict subset. The predicate for REQUIRED lives in exactly
// one place — the two SQL statements below — and the backup builds its manifest from the same text.
// ════════════════════════════════════════════════════════════════════════════

use std::collections::BTreeSet;

use rusqlite::{Connection, OpenFlags};

use super::MediaError;

/// The master image of every media object that is LINKED to a live business record, at its current
/// available generation. This is what a gallery, an export or the mobile page can resolve.
pub const REQUIRED_MASTER_SQL: &str = "SELECT l.tenant_id, l.media_id, l.media_role, g.stored_blob_hash, g.byte_size, g.generation_no, g.extension \
     FROM media_links l \
     JOIN media_objects o ON o.tenant_id=l.tenant_id AND o.media_id=l.media_id AND o.deleted_at IS NULL \
     JOIN media_blobs b ON b.tenant_id=o.tenant_id AND b.blob_id=o.master_blob_id AND b.blob_status='present' \
     JOIN media_blob_generations g ON g.tenant_id=b.tenant_id AND g.blob_id=b.blob_id AND g.generation_no=b.current_generation_no AND g.gen_status='available' \
     WHERE l.deleted_at IS NULL";

/// Every derived rendition (thumbnail, …) of those same linked media objects. A gallery shows the
/// thumbnail far more often than the master, so a "complete" set without variants is not complete.
///
/// Note the join on `media_objects`. Without it a DELETED media object still exported its
/// thumbnail, because a variant only knew about the link. The gallery resolver drops the whole
/// object when it is deleted — master and thumbnail alike — so requiring the thumbnail was a quiet
/// divergence from what a user can actually reach. The parity test found it, not production, which
/// is exactly what writing the two sets down in one place is for.
pub const REQUIRED_VARIANT_SQL: &str = "SELECT v.tenant_id, v.media_id, v.variant_type, g.stored_blob_hash, g.byte_size, g.generation_no, g.extension \
     FROM media_variants v \
     JOIN media_links l ON l.tenant_id=v.tenant_id AND l.media_id=v.media_id AND l.deleted_at IS NULL \
     JOIN media_objects o ON o.tenant_id=v.tenant_id AND o.media_id=v.media_id AND o.deleted_at IS NULL \
     JOIN media_blobs b ON b.tenant_id=v.tenant_id AND b.blob_id=v.blob_id AND b.blob_status='present' \
     JOIN media_blob_generations g ON g.tenant_id=b.tenant_id AND g.blob_id=b.blob_id AND g.generation_no=b.current_generation_no AND g.gen_status='available' \
     WHERE v.deleted_at IS NULL";

/// MEDIA-IDENTITY §7/§8 — the ONE historical reference the data set has: the ID-document version a
/// purchase froze at the moment of the purchase.
///
/// Every other REQUIRED row is reachable through a live LINK at its CURRENT generation. This one is
/// not, and that is the whole point of it: a supplier (or the linked customer) may replace the ID
/// document, or remove it altogether, and the old purchase must still show the version that was
/// used. So the join is on the EXACT generation the snapshot names — not the current one — and
/// there is deliberately no `l.deleted_at IS NULL` and no `o.deleted_at IS NULL` here: the evidence
/// of a past purchase does not disappear because somebody unlinked the document today.
///
/// The hash is required to match as well. If the snapshot's hash and the generation's hash disagree
/// the row is simply not selected — a mismatched pair is not the evidence this purchase recorded,
/// and silently substituting a different file would be worse than showing none.
///
/// PURCHASE-EDIT D10 — the second half: an ID photo that was REPLACED on the purchase (`$.identityRetired[]`).
/// It is never shown again (no visible history), but it is evidence that has to be kept — ID copies of a
/// purchase are retained for at least five years in Bahrain — so it is exactly as required as the current
/// one: same exact-generation join, same hash match, in every backup and every move.
pub const REQUIRED_PURCHASE_IDENTITY_SQL: &str = "SELECT o.tenant_id, o.media_id, 'identity_snapshot', g.stored_blob_hash, g.byte_size, g.generation_no, g.extension \
     FROM purchases p \
     JOIN media_objects o ON o.media_id = json_extract(p.supplier_snapshot, '$.identity.mediaId') \
     JOIN media_blobs b ON b.tenant_id=o.tenant_id AND b.blob_id=o.master_blob_id \
     JOIN media_blob_generations g ON g.tenant_id=b.tenant_id AND g.blob_id=b.blob_id \
                                  AND g.generation_no = json_extract(p.supplier_snapshot, '$.identity.generationNo') \
                                  AND g.stored_blob_hash = json_extract(p.supplier_snapshot, '$.identity.blobHash') \
     WHERE p.supplier_snapshot IS NOT NULL AND json_extract(p.supplier_snapshot, '$.identity.mediaId') IS NOT NULL \
     UNION ALL \
     SELECT o.tenant_id, o.media_id, 'identity_snapshot', g.stored_blob_hash, g.byte_size, g.generation_no, g.extension \
     FROM purchases p, json_each(p.supplier_snapshot, '$.identityRetired') r \
     JOIN media_objects o ON o.media_id = json_extract(r.value, '$.mediaId') \
     JOIN media_blobs b ON b.tenant_id=o.tenant_id AND b.blob_id=o.master_blob_id \
     JOIN media_blob_generations g ON g.tenant_id=b.tenant_id AND g.blob_id=b.blob_id \
                                  AND g.generation_no = json_extract(r.value, '$.generationNo') \
                                  AND g.stored_blob_hash = json_extract(r.value, '$.blobHash') \
     WHERE p.supplier_snapshot IS NOT NULL AND json_type(p.supplier_snapshot, '$.identityRetired') = 'array'";

/// Media-root-relative storage path, the same layout the store writes: `<scope>/<hh>/<hash>.<ext>`.
pub fn rel_path_for(scope: &str, hash: &str, ext: &str) -> Result<String, MediaError> {
    if hash.len() < 2 || !hash.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err(MediaError::PathOutsideRoot);
    }
    Ok(format!("{}/{}/{}.{}", scope, &hash[0..2], hash, ext))
}

fn open_ro(db: &std::path::Path) -> Result<Connection, MediaError> {
    Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| MediaError::Io(format!("open business db: {e}")))
}

/// Does this database have that table at all?
///
/// A media-only fixture, a very old data set, a database from before the purchases module: all of
/// them legitimately have no `purchases`. That is the answer "no purchase froze an ID document",
/// not a failure to read — but it has to be ASKED, because a bare query against a missing table
/// would abort the whole set and make every file look dispensable.
pub fn table_exists(conn: &Connection, name: &str) -> Result<bool, MediaError> {
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
            [name],
            |r| r.get(0),
        )
        .map_err(|e| MediaError::Io(format!("table probe: {e}")))?;
    Ok(n > 0)
}

fn collect_keys(conn: &Connection, sql: &str, out: &mut BTreeSet<String>) -> Result<(), MediaError> {
    let mut stmt = conn.prepare(sql).map_err(|e| MediaError::Io(format!("prepare: {e}")))?;
    let rows = stmt
        .query_map([], |r| {
            let scope: String = r.get(0)?;
            let hash: String = r.get(3)?;
            let ext: String = r.get(6)?;
            Ok((scope, hash, ext))
        })
        .map_err(|e| MediaError::Io(format!("query: {e}")))?;
    for row in rows {
        let (scope, hash, ext) = row.map_err(|e| MediaError::Io(format!("row: {e}")))?;
        out.insert(rel_path_for(&scope, &hash, &ext)?);
    }
    Ok(())
}

/// The files that MUST exist for this business database to be whole. Fail-closed: any read error is
/// an error, never an empty set — an empty set would silently declare every file dispensable.
pub fn required_keys(conn: &Connection) -> Result<BTreeSet<String>, MediaError> {
    let mut out = BTreeSet::new();
    collect_keys(conn, REQUIRED_MASTER_SQL, &mut out)?;
    collect_keys(conn, REQUIRED_VARIANT_SQL, &mut out)?;
    // MEDIA-IDENTITY §8 — a purchase snapshot is a REAL reference. Without this line a backup of a
    // shop whose supplier has since replaced his ID would restore into an installation where the
    // old purchases have lost their evidence — and nothing would report it.
    if table_exists(conn, "purchases")? {
        collect_keys(conn, REQUIRED_PURCHASE_IDENTITY_SQL, &mut out)?;
    }
    Ok(out)
}

/// Same, opening the database read-only. A database without the media schema yet (a very old data
/// set) has no required media rather than an error.
pub fn required_keys_from_db(db: &std::path::Path) -> Result<BTreeSet<String>, MediaError> {
    if !db.exists() {
        return Ok(BTreeSet::new());
    }
    let conn = open_ro(db)?;
    match required_keys(&conn) {
        Ok(k) => Ok(k),
        // `no such table` — the media schema was never applied. Nothing is reachable, and that is a
        // fact about the data set, not a failure to read it.
        Err(MediaError::Io(e)) if e.contains("no such table") => Ok(BTreeSet::new()),
        Err(e) => Err(e),
    }
}

/// The generation rows the preserved set is built from: every row EXCEPT one that reached the
/// terminal `deleted` state — unless a backup still pins exactly that generation.
///
/// BILDSPEICHER — before this, every row counted, whatever its status, so a superseded generation
/// (an old, larger rendition replaced by a migration) could never be freed: the GC would have kept
/// its file forever. `deleted` is reachable only through `superseded → gc_pending → deleted` (schema
/// trigger), never for the CURRENT generation (`trg_mbg_current_status_lock`), and only through the
/// owner-gated cleanup path. Rows are never removed; only their file becomes collectable. A file of a
/// deleted generation still goes through the normal GC run: dry run → boot-time quarantine → explicit
/// owner finalize, and reconcile moves it back if it became referenced again.
const PRESERVED_GENERATIONS_SQL: &str = "SELECT g.storage_key FROM media_blob_generations g WHERE g.gen_status <> 'deleted'";
/// A pinned generation stays protected whatever its own or its blob's state (a backup still names it).
const PRESERVED_PINNED_DELETED_SQL: &str = "SELECT g.storage_key FROM media_blob_generations g \
     JOIN media_backup_generation_pins p ON p.tenant_id=g.tenant_id AND p.blob_id=g.blob_id AND p.generation_no=g.generation_no";

/// BILDSPEICHER Phase 5B — a whole medium the owner released (photos of a permanently deleted item).
///
/// Its CURRENT generation can never leave `available` (`trg_mbg_current_status_lock`), and marking it
/// `deleted` would be wrong anyway: storage is content-addressed, so a later upload of exactly the same
/// picture must be able to use the same key again. So the release is on the BLOB: `blob_status =
/// 'gc_pending'`, reversible — the coordinator sets it back to `present` when the same bytes are uploaded
/// again. Its generations leave the preserved set only while NOTHING alive can reach the blob: no media
/// object that is not deleted uses it (as master or through a variant), and no identity-class object uses
/// it at all. Otherwise it stays protected, whatever the blob status says (fail-closed).
const RELEASED_BLOB_EXCLUSION: &str = " AND NOT EXISTS (SELECT 1 FROM media_blobs rb \
     WHERE rb.tenant_id=g.tenant_id AND rb.blob_id=g.blob_id AND rb.blob_status='gc_pending' \
       AND NOT EXISTS (SELECT 1 FROM media_objects ro WHERE ro.tenant_id=rb.tenant_id AND ro.master_blob_id=rb.blob_id \
                         AND (ro.deleted_at IS NULL OR ro.security_class NOT IN ('internal','public'))) \
       AND NOT EXISTS (SELECT 1 FROM media_variants rv JOIN media_objects ro ON ro.tenant_id=rv.tenant_id AND ro.media_id=rv.media_id \
                        WHERE rv.tenant_id=rb.tenant_id AND rv.blob_id=rb.blob_id \
                          AND (ro.deleted_at IS NULL OR ro.security_class NOT IN ('internal','public'))))";

fn table_has_columns(conn: &Connection, table: &str, cols: &[&str]) -> Result<bool, MediaError> {
    if !table_exists(conn, table)? {
        return Ok(false);
    }
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|e| MediaError::Io(format!("column probe: {e}")))?;
    let names: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|e| MediaError::Io(format!("column probe: {e}")))?
        .collect::<Result<_, _>>()
        .map_err(|e| MediaError::Io(format!("column probe: {e}")))?;
    Ok(cols.iter().all(|c| names.iter().any(|n| n == c)))
}

/// The released-blob rule needs the full shape; a hand-built fixture without it keeps the wider answer.
fn released_blob_rule_applies(conn: &Connection) -> Result<bool, MediaError> {
    Ok(table_has_columns(conn, "media_blobs", &["tenant_id", "blob_id", "blob_status"])?
        && table_has_columns(conn, "media_objects", &["tenant_id", "master_blob_id", "media_id", "deleted_at", "security_class"])?
        && table_has_columns(conn, "media_variants", &["tenant_id", "media_id", "blob_id"])?)
}

fn generations_have_status(conn: &Connection) -> Result<bool, MediaError> {
    let mut stmt = conn
        .prepare("PRAGMA table_info(media_blob_generations)")
        .map_err(|e| MediaError::Io(format!("column probe: {e}")))?;
    let names = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|e| MediaError::Io(format!("column probe: {e}")))?;
    for n in names {
        if n.map_err(|e| MediaError::Io(format!("column probe: {e}")))? == "gen_status" {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Everything any generation row still points at — including superseded, in-flight and unlinked
/// rows (but not `deleted` ones that no backup pins, see above). Nothing in here may be deleted;
/// nothing in here is required to exist.
pub fn preserved_keys(conn: &Connection) -> Result<BTreeSet<String>, MediaError> {
    // A hand-built table without a status column (old fixtures) keeps the old, widest answer.
    let sql = if !generations_have_status(conn)? {
        "SELECT storage_key FROM media_blob_generations".to_string()
    } else {
        let base = if released_blob_rule_applies(conn)? {
            format!("{PRESERVED_GENERATIONS_SQL}{RELEASED_BLOB_EXCLUSION}")
        } else {
            PRESERVED_GENERATIONS_SQL.to_string()
        };
        if table_exists(conn, "media_backup_generation_pins")? {
            format!("{base} UNION {PRESERVED_PINNED_DELETED_SQL}")
        } else {
            base
        }
    };
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| MediaError::Io(format!("prepare preserved: {e}")))?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| MediaError::Io(format!("query preserved: {e}")))?;
    let mut out = BTreeSet::new();
    for row in rows {
        out.insert(row.map_err(|e| MediaError::Io(format!("row preserved: {e}")))?.replace('\\', "/"));
    }
    Ok(out)
}

#[cfg(test)]
#[path = "reachability_tests.rs"]
mod reachability_tests;
