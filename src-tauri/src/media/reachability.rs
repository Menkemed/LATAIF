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

/// Everything any generation row still points at — including superseded, in-flight and unlinked
/// rows. Nothing in here may be deleted; nothing in here is required to exist.
pub fn preserved_keys(conn: &Connection) -> Result<BTreeSet<String>, MediaError> {
    let mut stmt = conn
        .prepare("SELECT storage_key FROM media_blob_generations")
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
