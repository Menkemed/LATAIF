// MEDIA REACHABILITY — the two sets, and the parity that was missing.
//
// The bug these exist for was not a wrong query. Both queries were right; they just answered
// different questions and one caller used the wrong one. So the tests are written as questions:
// what can a user reach, what may never be deleted, and do backup and move agree.

use super::*;
use rusqlite::Connection;

/// Enough of the media schema for the joins to mean something. Deliberately hand-built: the point is
/// to control exactly which rows exist, including the shapes production produced by accident.
fn db() -> Connection {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch(
        "CREATE TABLE media_objects (tenant_id TEXT, media_id TEXT, master_blob_id TEXT, deleted_at TEXT);
         CREATE TABLE media_blobs (tenant_id TEXT, blob_id TEXT, blob_status TEXT, current_generation_no INTEGER, deleted_at TEXT);
         CREATE TABLE media_blob_generations (tenant_id TEXT, blob_id TEXT, generation_no INTEGER, storage_key TEXT,
             stored_blob_hash TEXT, byte_size INTEGER, extension TEXT, gen_status TEXT, deleted_at TEXT);
         CREATE TABLE media_variants (tenant_id TEXT, media_id TEXT, blob_id TEXT, variant_type TEXT, deleted_at TEXT);
         CREATE TABLE media_links (tenant_id TEXT, media_id TEXT, media_role TEXT, entity_id TEXT, deleted_at TEXT);",
    )
    .unwrap();
    c
}

const H1: &str = "aa11111111111111111111111111111111111111111111111111111111111111";
const H2: &str = "bb22222222222222222222222222222222222222222222222222222222222222";
const ORPH: &str = "cc33333333333333333333333333333333333333333333333333333333333333";

fn add_generation(c: &Connection, blob: &str, gen: i64, hash: &str, status: &str) {
    c.execute(
        "INSERT INTO media_blob_generations VALUES ('t1',?1,?2,?3,?4,100,'jpg',?5,NULL)",
        rusqlite::params![blob, gen, format!("t1/{}/{}.jpg", &hash[0..2], hash), hash, status],
    )
    .unwrap();
}

/// A product image: object → master blob → current available generation → a live link. Plus a
/// thumbnail variant, because a gallery shows that far more often than the master.
fn add_linked_media(c: &Connection) {
    c.execute("INSERT INTO media_objects VALUES ('t1','m1','b1',NULL)", []).unwrap();
    c.execute("INSERT INTO media_blobs VALUES ('t1','b1','present',1,NULL)", []).unwrap();
    add_generation(c, "b1", 1, H1, "available");
    c.execute("INSERT INTO media_blobs VALUES ('t1','bv','present',1,NULL)", []).unwrap();
    add_generation(c, "bv", 1, H2, "available");
    c.execute("INSERT INTO media_variants VALUES ('t1','m1','bv','thumbnail',NULL)", []).unwrap();
    c.execute("INSERT INTO media_links VALUES ('t1','m1','gallery','p1',NULL)", []).unwrap();
}

/// Exactly what production had: a completed ingest whose link never happened. Real rows, real files,
/// reachable by nothing.
fn add_orphan_generation(c: &Connection) {
    c.execute("INSERT INTO media_objects VALUES ('t1','m-orph','b-orph',NULL)", []).unwrap();
    c.execute("INSERT INTO media_blobs VALUES ('t1','b-orph','present',1,NULL)", []).unwrap();
    add_generation(c, "b-orph", 1, ORPH, "available");
}

fn key(h: &str) -> String {
    format!("t1/{}/{}.jpg", &h[0..2], h)
}

#[test]
fn required_is_what_a_business_consumer_can_reach() {
    let c = db();
    add_linked_media(&c);
    add_orphan_generation(&c);

    let req = required_keys(&c).unwrap();
    assert!(req.contains(&key(H1)), "the master of a linked media object is required");
    assert!(req.contains(&key(H2)), "and so is its thumbnail");
    assert!(!req.contains(&key(ORPH)), "an unlinked generation is reachable by nobody");
    assert_eq!(req.len(), 2);
}

#[test]
fn preserved_is_wider_and_covers_the_orphan() {
    let c = db();
    add_linked_media(&c);
    add_orphan_generation(&c);

    let pres = preserved_keys(&c).unwrap();
    let req = required_keys(&c).unwrap();
    assert!(pres.contains(&key(ORPH)), "the GC must never delete a file a generation row points at");
    assert!(req.is_subset(&pres), "required is a strict subset of preserved");
    assert_eq!(pres.len(), 3);
    // The two questions are different, and this is the difference.
    assert_eq!(pres.difference(&req).cloned().collect::<Vec<_>>(), vec![key(ORPH)]);
}

#[test]
fn a_removed_link_makes_its_media_unrequired_but_still_preserved() {
    let c = db();
    add_linked_media(&c);
    c.execute("UPDATE media_links SET deleted_at='2026-01-01' WHERE media_id='m1'", []).unwrap();

    let req = required_keys(&c).unwrap();
    assert!(req.is_empty(), "nothing shows it any more");
    assert_eq!(preserved_keys(&c).unwrap().len(), 2, "but the files are still protected from the GC");
}

#[test]
fn a_superseded_generation_is_not_required() {
    let c = db();
    add_linked_media(&c);
    // The blob moved on to generation 2; generation 1 is history.
    add_generation(&c, "b1", 2, ORPH, "available");
    c.execute("UPDATE media_blobs SET current_generation_no=2 WHERE blob_id='b1'", []).unwrap();

    let req = required_keys(&c).unwrap();
    assert!(req.contains(&key(ORPH)), "the CURRENT generation is what a gallery resolves");
    assert!(!req.contains(&key(H1)), "the superseded one is not required any more");
    assert!(preserved_keys(&c).unwrap().contains(&key(H1)), "but must not be deleted either");
}

#[test]
fn a_deleted_object_or_an_absent_blob_requires_nothing() {
    let c = db();
    add_linked_media(&c);
    c.execute("UPDATE media_objects SET deleted_at='2026-01-01' WHERE media_id='m1'", []).unwrap();
    assert!(required_keys(&c).unwrap().is_empty());

    let c2 = db();
    add_linked_media(&c2);
    c2.execute("UPDATE media_blobs SET blob_status='missing'", []).unwrap();
    assert!(required_keys(&c2).unwrap().is_empty(), "a blob that is not present cannot be shown");
}

#[test]
fn a_generation_that_is_not_available_is_not_required() {
    let c = db();
    add_linked_media(&c);
    c.execute("UPDATE media_blob_generations SET gen_status='writing' WHERE blob_id='b1'", []).unwrap();
    let req = required_keys(&c).unwrap();
    assert!(!req.contains(&key(H1)), "an in-flight write is not something a user can open");
    assert!(preserved_keys(&c).unwrap().contains(&key(H1)), "and it certainly may not be deleted");
}

// ── the parity that was broken ──────────────────────────────────────────────

#[test]
fn the_backup_selects_exactly_the_required_set() {
    let c = db();
    add_linked_media(&c);
    add_orphan_generation(&c);

    let selected: std::collections::BTreeSet<String> = super::super::backup::collect_selection_from_db(&c)
        .unwrap()
        .into_iter()
        .map(|s| rel_path_for(&s.scope, &s.hash, &s.extension).unwrap())
        .collect();

    assert_eq!(selected, required_keys(&c).unwrap(), "what a backup carries IS what must exist");
}

#[test]
fn a_missing_required_file_is_never_excused_by_the_orphan_rule() {
    // The rule loosens exactly one thing. A picture somebody would open is still non-negotiable.
    let c = db();
    add_linked_media(&c);
    let req = required_keys(&c).unwrap();
    assert_eq!(req.len(), 2);
    assert!(req.contains(&key(H1)) && req.contains(&key(H2)));
}

#[test]
fn an_absent_media_schema_means_no_required_media_rather_than_an_error() {
    let dir = std::env::temp_dir().join(format!("lataif-reach-{}", uuid::Uuid::new_v4().as_simple()));
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join("lataif.db");
    Connection::open(&p).unwrap().execute_batch("CREATE TABLE products (id TEXT)").unwrap();
    assert!(required_keys_from_db(&p).unwrap().is_empty());
    // …and a database that is not there at all is not an error either.
    assert!(required_keys_from_db(&dir.join("nope.db")).unwrap().is_empty());
}
