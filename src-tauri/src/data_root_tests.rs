// DATA-ROOT-I1 / B1 — the resolver's contract, proved against real directories on disk.
//
// Every test builds its own temp tree; none of them can see AppData, a production identifier or a
// real database. The point of the suite is not that the happy path works — it is that each way the
// pair (locator, marker) can be broken ends in a REFUSAL, because the alternative to a refusal is
// an app that quietly opens the wrong months-old dataset and lets someone work in it.

use super::*;
use std::fs;
use std::path::PathBuf;

fn tmp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "lataif-dataroot-{tag}-{}",
        uuid::Uuid::new_v4().as_simple()
    ));
    fs::create_dir_all(&d).unwrap();
    d
}

/// A directory that looks like a real, pre-existing install.
fn with_dataset(dir: &Path) {
    fs::write(dir.join(BUSINESS_DB_FILENAME), b"not-a-real-sqlite-file").unwrap();
    fs::write(dir.join(SYNC_SERVER_DB_FILENAME), b"nor-is-this").unwrap();
    fs::create_dir_all(dir.join(MEDIA_DIRNAME)).unwrap();
}

// ── bootstrap ───────────────────────────────────────────────────────────────

#[test]
fn legacy_bootstrap_adopts_the_existing_folder_in_place_and_moves_nothing() {
    let dir = tmp("legacy");
    with_dataset(&dir);
    let before: Vec<_> = fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name()).collect();

    let root = resolve(&dir).unwrap();

    assert_eq!(root.path(), dir.as_path(), "the legacy folder itself is the data root");
    assert!(root.is_legacy_in_place());
    assert_eq!(root.business_db(), dir.join("lataif.db"), "the SAME database file as before");
    assert!(root.business_db().exists(), "and it is still there");
    // Only the two small files were added; nothing was moved or removed.
    let after: Vec<_> = fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name()).collect();
    // In the legacy case AppData IS the root, so both small files land here — and nothing else.
    assert_eq!(after.len(), before.len() + 2, "only the marker and the locator were added");
    assert!(dir.join(MARKER_FILENAME).exists());
    assert!(dir.join(LOCATOR_FILENAME).exists(), "locator lives next to it (legacy = same dir)");
    assert_eq!(fs::read(dir.join("lataif.db")).unwrap(), b"not-a-real-sqlite-file");
}

#[test]
fn bootstrap_records_that_a_business_db_is_expected() {
    let dir = tmp("expect");
    with_dataset(&dir);
    resolve(&dir).unwrap();
    let m = read_marker(&dir).unwrap().unwrap();
    assert!(m.business_db_expected);
    assert!(!m.bootstrap_pending, "a completed bootstrap leaves no pending flag");
}

// ── DATA-ROOT-B1: an empty control directory is a QUESTION, not a first start ───────────────
//
// It used to be answered on the spot: an empty folder became a new root with a new id and an empty
// database. For a machine that was reinstalled while the data sits on another drive that is the
// wrong answer, and it cannot be taken back — the real data is then orphaned beside a working,
// empty installation. So the resolver stops and asks.

#[test]
fn an_empty_control_directory_asks_instead_of_claiming_itself() {
    let dir = tmp("undecided");
    assert!(matches!(resolve_or_first_run(&dir).unwrap(), Resolution::FirstRunUndecided));
    // And it really asked: nothing at all was written.
    let entries: Vec<_> = fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert!(entries.is_empty(), "the resolver wrote something while it had no answer: {entries:?}");
    assert!(!dir.join(MARKER_FILENAME).exists(), "no marker");
    assert!(!dir.join(LOCATOR_FILENAME).exists(), "no locator");
    assert!(!dir.join(BUSINESS_DB_FILENAME).exists(), "no database");
    assert!(!dir.join(SYNC_SERVER_DB_FILENAME).exists(), "no server database");
    // Asking twice changes nothing either — a person who closes the window has mutated nothing.
    assert!(matches!(resolve_or_first_run(&dir).unwrap(), Resolution::FirstRunUndecided));
    assert!(fs::read_dir(&dir).unwrap().next().is_none(), "still empty after a second start");
}

#[test]
fn setting_up_a_new_installation_is_the_deliberate_answer() {
    let dir = tmp("newinstall");
    assert!(matches!(resolve_or_first_run(&dir).unwrap(), Resolution::FirstRunUndecided));

    let root = setup_new_installation(&dir).unwrap();
    assert_eq!(root.path(), dir.as_path(), "the chosen default root is the control directory");
    assert!(!root.root_id().trim().is_empty(), "one new id");
    let m = read_marker(&dir).unwrap().unwrap();
    assert_eq!(m.root_id, root.root_id(), "marker and root agree");
    assert!(!m.bootstrap_pending, "a completed bootstrap leaves no pending flag");
    assert!(!m.business_db_expected, "there was never a database here — do not demand one later");
    assert!(!root.business_db().exists(), "and none was created");
    let loc = read_locator(&dir).unwrap().unwrap();
    assert_eq!(loc.root_id, root.root_id(), "the locator commits to the same id");

    // From here on the normal resolver owns the directory, and the id never changes again.
    let again = resolve(&dir).unwrap();
    assert_eq!(again.root_id(), root.root_id());
}

#[test]
fn setting_up_a_new_installation_never_overwrites_an_existing_one() {
    let dir = tmp("newinstall-twice");
    let first = setup_new_installation(&dir).unwrap();
    // A second call must not mint a second identity into the same directory.
    let second = setup_new_installation(&dir).unwrap();
    assert_eq!(second.root_id(), first.root_id(), "the same installation, not a new one");
    // Nor may it walk over a legacy dataset that the normal resolver would adopt in place.
    let legacy = tmp("newinstall-legacy");
    with_dataset(&legacy);
    let adopted = setup_new_installation(&legacy).unwrap();
    assert_eq!(adopted.path(), legacy.as_path());
    assert_eq!(
        fs::read(legacy.join(BUSINESS_DB_FILENAME)).unwrap(),
        b"not-a-real-sqlite-file",
        "the existing database is untouched"
    );
}

#[test]
fn a_legacy_folder_with_data_is_still_adopted_in_place_and_never_asks() {
    // The upgrade path from before the locator contract: the data IS here, so there is nothing to
    // ask about. Only an EMPTY directory is a question.
    let dir = tmp("legacy-no-question");
    with_dataset(&dir);
    let root = resolve(&dir).unwrap();
    assert_eq!(root.path(), dir.as_path());
    assert!(root.is_legacy_in_place());
    assert!(read_marker(&dir).unwrap().unwrap().business_db_expected);
}

#[test]
fn bootstrap_is_idempotent_across_restarts() {
    let dir = tmp("idem");
    with_dataset(&dir);
    let first = resolve(&dir).unwrap();
    let loc1 = fs::read(dir.join(LOCATOR_FILENAME)).unwrap();
    let mk1 = fs::read(dir.join(MARKER_FILENAME)).unwrap();

    for _ in 0..3 {
        let again = resolve(&dir).unwrap();
        assert_eq!(again.root_id(), first.root_id(), "the id never changes");
        assert_eq!(again.path(), first.path());
    }
    assert_eq!(fs::read(dir.join(LOCATOR_FILENAME)).unwrap(), loc1, "locator untouched");
    assert_eq!(fs::read(dir.join(MARKER_FILENAME)).unwrap(), mk1, "marker untouched");
}

#[test]
fn an_interrupted_bootstrap_is_completed_with_the_same_id() {
    let dir = tmp("interrupted");
    with_dataset(&dir);
    // Exactly the on-disk state of a crash between the pending marker and the locator.
    let pending = RootMarker {
        schema_version: MARKER_SCHEMA_VERSION,
        root_id: "keep-me".into(),
        created_at: "2026-01-01T00:00:00Z".into(),
        bootstrap_pending: true,
        business_db_expected: true,
    };
    write_marker(&dir, &pending).unwrap();

    let root = resolve(&dir).unwrap();
    assert_eq!(root.root_id(), "keep-me", "the half-written id is kept, not replaced");
    assert!(!read_marker(&dir).unwrap().unwrap().bootstrap_pending);
    assert!(dir.join(LOCATOR_FILENAME).exists());
}

// ── the P1 case: a locator that disappears after registration ───────────────

#[test]
fn a_lost_locator_after_registration_fails_closed_instead_of_re_adopting_the_folder() {
    let dir = tmp("lost");
    with_dataset(&dir);
    resolve(&dir).unwrap(); // registered
    fs::remove_file(dir.join(LOCATOR_FILENAME)).unwrap();

    let err = resolve(&dir).unwrap_err();
    assert_eq!(err.code(), "DATA_ROOT_LOCATOR_MISSING");
    assert!(err.message(None).contains("already registered"));
}

#[test]
fn a_corrupt_locator_fails_closed_and_never_falls_back_to_app_data() {
    for junk in [&b"{"[..], &b""[..], &b"not json at all"[..], br#"{"schemaVersion":1}"#] {
        let dir = tmp("corrupt");
        with_dataset(&dir);
        fs::write(dir.join(LOCATOR_FILENAME), junk).unwrap();
        assert_eq!(resolve(&dir).unwrap_err().code(), "DATA_ROOT_LOCATOR_CORRUPT");
    }
}

#[test]
fn an_unknown_locator_schema_fails_closed() {
    let dir = tmp("schema");
    with_dataset(&dir);
    fs::write(
        dir.join(LOCATOR_FILENAME),
        br#"{"schemaVersion":99,"dataRoot":"C:\\x","rootId":"a","updatedAt":"x"}"#,
    )
    .unwrap();
    assert_eq!(resolve(&dir).unwrap_err().code(), "DATA_ROOT_LOCATOR_SCHEMA_UNSUPPORTED");
}

#[test]
fn a_relative_locator_path_is_refused() {
    let dir = tmp("relative");
    fs::write(
        dir.join(LOCATOR_FILENAME),
        br#"{"schemaVersion":1,"dataRoot":"data","rootId":"a","updatedAt":"x"}"#,
    )
    .unwrap();
    assert_eq!(resolve(&dir).unwrap_err().code(), "DATA_ROOT_LOCATOR_PATH_NOT_ABSOLUTE");
}

// ── the configured root itself ──────────────────────────────────────────────

#[test]
fn an_unreachable_root_fails_closed_and_creates_nothing() {
    let app = tmp("unreachable-app");
    let gone = tmp("unreachable-root");
    with_dataset(&gone);
    // Register the pair, then make the root disappear the way an unplugged drive does.
    let root = resolve_from_locator_for_test(&app, &gone);
    fs::remove_dir_all(&gone).unwrap();

    let err = resolve(&app).unwrap_err();
    assert_eq!(err.code(), "DATA_ROOT_UNREACHABLE");
    assert!(!gone.exists(), "a missing root is never re-created");
    assert!(err.message(Some(&gone)).contains("cannot be reached"));
    drop(root);
}

#[test]
fn a_root_without_a_marker_fails_closed() {
    let app = tmp("nomarker-app");
    let other = tmp("nomarker-root");
    with_dataset(&other);
    write_locator(
        &app,
        &Locator {
            schema_version: LOCATOR_SCHEMA_VERSION,
            data_root: other.to_string_lossy().to_string(),
            root_id: "some-id".into(),
            updated_at: now_iso(),
        },
    )
    .unwrap();
    assert_eq!(resolve(&app).unwrap_err().code(), "DATA_ROOT_MARKER_MISSING");
}

#[test]
fn a_root_id_mismatch_fails_closed() {
    let app = tmp("mismatch-app");
    let other = tmp("mismatch-root");
    with_dataset(&other);
    write_marker(
        &other,
        &RootMarker {
            schema_version: MARKER_SCHEMA_VERSION,
            root_id: "root-says-A".into(),
            created_at: now_iso(),
            bootstrap_pending: false,
            business_db_expected: true,
        },
    )
    .unwrap();
    write_locator(
        &app,
        &Locator {
            schema_version: LOCATOR_SCHEMA_VERSION,
            data_root: other.to_string_lossy().to_string(),
            root_id: "locator-says-B".into(),
            updated_at: now_iso(),
        },
    )
    .unwrap();
    let err = resolve(&app).unwrap_err();
    assert_eq!(err.code(), "DATA_ROOT_ID_MISMATCH");
    assert!(err.message(Some(&other)).contains("different data set"));
}

#[test]
fn a_corrupt_marker_fails_closed() {
    let dir = tmp("badmarker");
    with_dataset(&dir);
    resolve(&dir).unwrap();
    fs::write(dir.join(MARKER_FILENAME), b"{oops").unwrap();
    assert_eq!(resolve(&dir).unwrap_err().code(), "DATA_ROOT_MARKER_CORRUPT");
}

#[test]
fn a_business_db_that_vanished_from_an_adopted_root_fails_closed() {
    let dir = tmp("dbgone");
    with_dataset(&dir);
    resolve(&dir).unwrap();
    fs::remove_file(dir.join(BUSINESS_DB_FILENAME)).unwrap();

    let err = resolve(&dir).unwrap_err();
    assert_eq!(err.code(), "DATA_ROOT_BUSINESS_DB_MISSING");
    assert!(!dir.join(BUSINESS_DB_FILENAME).exists(), "and no empty database was put in its place");
}

#[test]
fn two_valid_roots_are_decided_by_the_locator_alone() {
    let app = tmp("two-app");
    let a = tmp("two-a");
    let b = tmp("two-b");
    with_dataset(&a);
    with_dataset(&b);
    // Both are complete, registerable roots; b is "newer" in every heuristic sense.
    let ra = resolve_from_locator_for_test(&app, &a);
    let id_a = ra.root_id().to_string();
    fs::write(b.join(BUSINESS_DB_FILENAME), vec![0u8; 4096]).unwrap();

    let again = resolve(&app).unwrap();
    assert_eq!(again.path(), a.as_path(), "size/mtime/alphabet decide nothing — the locator does");
    assert_eq!(again.root_id(), id_a);
}

#[test]
fn unicode_and_spaces_in_the_path_resolve_unchanged() {
    let base = tmp("unicode");
    let dir = base.join("LATAIF Daten — Filiale münchen (١)");
    fs::create_dir_all(&dir).unwrap();
    with_dataset(&dir);

    let root = resolve(&dir).unwrap();
    assert_eq!(root.path(), dir.as_path());
    assert_eq!(root.business_db(), dir.join("lataif.db"));
    assert!(root.business_db().exists());
    // and it survives a restart through the JSON round-trip
    assert_eq!(resolve(&dir).unwrap().path(), dir.as_path());
}

// ── derived runtime paths ───────────────────────────────────────────────────

#[test]
fn every_runtime_path_comes_from_the_one_root() {
    let dir = tmp("derived");
    with_dataset(&dir);
    let r = resolve(&dir).unwrap();
    assert_eq!(r.business_db(), dir.join("lataif.db"));
    assert_eq!(r.sync_server_db(), dir.join("lataif_sync_server.db"));
    assert_eq!(r.media_root(), dir.join("media"));
    assert_eq!(r.mobile_staging_root(), dir.join("mobile-upload-staging"));
    assert_eq!(r.openai_key(), dir.join("openai.key"));
}

#[test]
fn a_custom_root_moves_all_four_paths_together() {
    let app = tmp("custom-app");
    let custom = tmp("custom-root");
    with_dataset(&custom);
    let r = resolve_from_locator_for_test(&app, &custom);
    assert_eq!(r.business_db(), custom.join("lataif.db"));
    assert_eq!(r.sync_server_db(), custom.join("lataif_sync_server.db"));
    assert_eq!(r.media_root(), custom.join("media"));
    assert_eq!(r.mobile_staging_root(), custom.join("mobile-upload-staging"));
    assert!(!r.is_legacy_in_place());
    // nothing derived points back into the AppData directory
    for p in [r.business_db(), r.sync_server_db(), r.media_root(), r.mobile_staging_root()] {
        assert!(!p.starts_with(&app), "{} escaped into AppData", p.display());
    }
}

// ── identifier isolation ────────────────────────────────────────────────────

#[test]
fn two_identifiers_never_share_a_locator() {
    let base = tmp("idents");
    let prod = base.join("com.lataif.app");
    let e2e = base.join("com.lataif.app.e2e");
    fs::create_dir_all(&prod).unwrap();
    fs::create_dir_all(&e2e).unwrap();
    with_dataset(&prod);
    with_dataset(&e2e);

    let p = resolve(&prod).unwrap();
    let t = resolve(&e2e).unwrap();
    assert_ne!(p.root_id(), t.root_id());
    assert_eq!(p.path(), prod.as_path());
    assert_eq!(t.path(), e2e.as_path());
    // The locator is found ONLY inside the identifier's own directory.
    assert!(prod.join(LOCATOR_FILENAME).exists());
    assert!(e2e.join(LOCATOR_FILENAME).exists());
    assert_ne!(
        fs::read(prod.join(LOCATOR_FILENAME)).unwrap(),
        fs::read(e2e.join(LOCATOR_FILENAME)).unwrap()
    );
}

// ── overlap validator (used by the backup location, and later by the move) ───

#[test]
fn overlap_is_detected_in_both_directions() {
    let base = tmp("overlap");
    let data = base.join("LATAIF").join("Data");
    let backups = base.join("LATAIF").join("Backups");
    let inside = data.join("Backups");
    for d in [&data, &backups, &inside] {
        fs::create_dir_all(d).unwrap();
    }
    assert!(paths_overlap(&data, &data), "same directory");
    assert!(paths_overlap(&base, &data), "parent contains child");
    assert!(paths_overlap(&data, &base), "child inside parent");
    assert!(paths_overlap(&data, &inside), "a backups folder inside the data root");
    assert!(!paths_overlap(&data, &backups), "siblings are fine");
}

#[test]
fn a_sibling_name_that_merely_starts_the_same_is_not_an_overlap() {
    let base = tmp("prefix");
    let a = base.join("LATAIF");
    let b = base.join("LATAIFX");
    fs::create_dir_all(&a).unwrap();
    fs::create_dir_all(&b).unwrap();
    assert!(!paths_overlap(&a, &b), "LATAIFX is not inside LATAIF");
}

#[test]
fn overlap_ignores_case_and_dot_segments_on_windows() {
    let base = tmp("normalise");
    let data = base.join("Data");
    fs::create_dir_all(&data).unwrap();
    let noisy = base.join("Data").join("..").join("Data");
    assert!(paths_overlap(&data, &noisy));
    #[cfg(windows)]
    {
        let upper = PathBuf::from(data.to_string_lossy().to_uppercase());
        assert!(paths_overlap(&data, &upper), "Windows paths are case-insensitive");
    }
}

// ── helper ──────────────────────────────────────────────────────────────────

/// Register `root` as the data root for the install whose AppData is `app`, the same way a future
/// move will: marker in the root, locator in AppData, one shared id.
fn resolve_from_locator_for_test(app: &Path, root: &Path) -> DataRoot {
    let id = uuid::Uuid::new_v4().to_string();
    write_marker(
        root,
        &RootMarker {
            schema_version: MARKER_SCHEMA_VERSION,
            root_id: id.clone(),
            created_at: now_iso(),
            bootstrap_pending: false,
            business_db_expected: root.join(BUSINESS_DB_FILENAME).exists(),
        },
    )
    .unwrap();
    write_locator(
        app,
        &Locator {
            schema_version: LOCATOR_SCHEMA_VERSION,
            data_root: root.to_string_lossy().to_string(),
            root_id: id,
            updated_at: now_iso(),
        },
    )
    .unwrap();
    resolve(app).unwrap()
}
