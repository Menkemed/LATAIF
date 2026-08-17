// DATA-ROOT-I1 / B2 — the move's refusals and its crash windows, against real directories.
//
// The happy path gets one real-app E2E. Everything that can go WRONG gets tested here instead,
// because the interesting states of a move are states you cannot reach by clicking: a half-copied
// staging tree, a target that was finalised but never committed, a locator that was switched to a
// target that then would not open. Each is a file layout, so each is constructible.
//
// The invariant every test below is really checking is one sentence: at no point, in no failure, is
// the source root changed or the locator pointed at something unproven.

use super::*;
use crate::data_root;
use std::fs;

fn tmp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("lataif-move-{tag}-{}", uuid::Uuid::new_v4().as_simple()));
    fs::create_dir_all(&d).unwrap();
    d
}

/// A real sqlite business DB with a media table and one referenced blob — enough for the integrity,
/// foreign-key and media-reference checks to mean something.
fn make_source(dir: &Path, root_id: &str) {
    let db = dir.join(data_root::BUSINESS_DB_FILENAME);
    let conn = Connection::open(&db).unwrap();
    conn.execute_batch(
        "PRAGMA foreign_keys=ON;
         CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT);
         INSERT INTO products VALUES ('p1','Submariner');
         CREATE TABLE media_blob_generations (storage_key TEXT PRIMARY KEY);
         INSERT INTO media_blob_generations VALUES ('scope-a/ab/abcdef.jpg');",
    )
    .unwrap();
    drop(conn);
    let blob = dir.join(data_root::MEDIA_DIRNAME).join("scope-a").join("ab");
    fs::create_dir_all(&blob).unwrap();
    fs::write(blob.join("abcdef.jpg"), b"not-really-a-jpeg-but-bytes").unwrap();
    fs::create_dir_all(dir.join(data_root::MOBILE_STAGING_DIRNAME)).unwrap();
    fs::write(dir.join("sync_install_id.key"), b"install-id-bytes").unwrap();
    fs::write(dir.join("sync_jwt_secret.key"), b"secret-bytes").unwrap();
    data_root::write_marker(
        dir,
        &data_root::RootMarker {
            schema_version: data_root::MARKER_SCHEMA_VERSION,
            root_id: root_id.to_string(),
            created_at: "2026-01-01T00:00:00Z".into(),
            bootstrap_pending: false,
            business_db_expected: true,
        },
    )
    .unwrap();
}

/// An AppData directory whose locator points at `root`.
fn make_app_data(root: &Path, root_id: &str) -> PathBuf {
    let app = tmp("app");
    data_root::set_locator(&app, root, root_id).unwrap();
    app
}

fn root_of(app: &Path) -> DataRoot {
    data_root::resolve(app).unwrap()
}

fn plan_for(source: &DataRoot, target: &Path, backups: &Path) -> Result<MovePlan, MoveError> {
    preflight(source, &target.to_string_lossy(), backups, None)
}

// ── normalisation: fail closed, never a raw-string fallback ─────────────────

#[test]
fn a_relative_target_is_refused() {
    assert_eq!(normalize_for_compare(Path::new("data\\here")).unwrap_err(), MoveError::NotAbsolute);
}

#[test]
fn a_target_whose_volume_does_not_exist_cannot_be_normalised() {
    // No ancestor resolves, so there is nothing to compare against — and a comparison that cannot be
    // made must not be assumed to have passed.
    let err = normalize_for_compare(Path::new("Q:\\definitely\\not\\here")).unwrap_err();
    assert_eq!(err, MoveError::NotNormalizable);
}

#[test]
fn a_target_that_does_not_exist_yet_normalises_via_its_nearest_existing_parent() {
    let base = tmp("norm");
    let deep = base.join("LATAIF").join("Data");
    let n = normalize_for_compare(&deep).unwrap();
    assert!(n.ends_with("LATAIF\\Data") || n.ends_with("LATAIF/Data"), "{}", n.display());
    assert!(n.is_absolute());
}

#[test]
fn overlap_is_strict_in_both_directions_and_component_wise() {
    let base = tmp("ov");
    let data = base.join("Data");
    let backups = base.join("Backups");
    fs::create_dir_all(&data).unwrap();
    fs::create_dir_all(&backups).unwrap();
    assert!(overlaps_strict(&data, &data).unwrap(), "same dir");
    assert!(overlaps_strict(&base, &data).unwrap(), "parent contains child");
    assert!(overlaps_strict(&data, &base).unwrap(), "child inside parent");
    assert!(!overlaps_strict(&data, &backups).unwrap(), "siblings are fine");
    // A name that merely starts the same is not containment.
    let x = base.join("DataX");
    fs::create_dir_all(&x).unwrap();
    assert!(!overlaps_strict(&data, &x).unwrap());
    // And a target that cannot be normalised is an ERROR, never `false`.
    assert!(overlaps_strict(Path::new("Q:\\nope\\deep"), &data).is_err());
}

// ── preflight refusals ──────────────────────────────────────────────────────

#[test]
fn preflight_refuses_the_source_itself_and_anything_overlapping_it() {
    let src = tmp("p-src");
    make_source(&src, "id-1");
    let app = make_app_data(&src, "id-1");
    let root = root_of(&app);
    let backups = tmp("p-bk");

    assert_eq!(plan_for(&root, &src, &backups).unwrap_err(), MoveError::TargetIsSource);
    assert_eq!(plan_for(&root, &src.join("inside"), &backups).unwrap_err(), MoveError::OverlapsSource);
    let parent = src.parent().unwrap().to_path_buf();
    assert_eq!(plan_for(&root, &parent, &backups).unwrap_err(), MoveError::OverlapsSource);
}

#[test]
fn preflight_refuses_a_target_that_overlaps_the_backup_root_in_either_direction() {
    // The live shape: backups at a drive root, target proposed underneath it.
    let src = tmp("bk-src");
    make_source(&src, "id-1");
    let app = make_app_data(&src, "id-1");
    let root = root_of(&app);
    // The backup root gets its own private parent, so "the directory above it" contains the backups
    // and nothing else — otherwise the shared temp dir would trip the source check first and the
    // test would pass for the wrong reason.
    let bk_parent = tmp("bk-parent");
    let backups = bk_parent.join("Backups");
    fs::create_dir_all(&backups).unwrap();

    let inside = backups.join("LATAIF").join("Data");
    assert_eq!(plan_for(&root, &inside, &backups).unwrap_err(), MoveError::OverlapsBackupRoot);
    // …and the other way round: a target that would CONTAIN the backup root.
    assert_eq!(plan_for(&root, &bk_parent, &backups).unwrap_err(), MoveError::OverlapsBackupRoot);
}

#[test]
fn preflight_refuses_a_target_inside_the_application_folder() {
    let src = tmp("app-src");
    make_source(&src, "id-1");
    let app = make_app_data(&src, "id-1");
    let root = root_of(&app);
    let backups = tmp("app-bk");
    let install = tmp("app-install");
    let inside = install.join("Data");
    let err = preflight(&root, &inside.to_string_lossy(), &backups, Some(&install)).unwrap_err();
    assert_eq!(err, MoveError::OverlapsAppFolder);
}

#[test]
fn preflight_refuses_a_non_empty_target_and_never_overwrites_what_is_there() {
    let src = tmp("ne-src");
    make_source(&src, "id-1");
    let app = make_app_data(&src, "id-1");
    let root = root_of(&app);
    let backups = tmp("ne-bk");
    let target = tmp("ne-target");
    fs::write(target.join("someones-file.txt"), b"do not touch me").unwrap();

    assert_eq!(plan_for(&root, &target, &backups).unwrap_err(), MoveError::TargetNotEmpty);
    assert_eq!(fs::read(target.join("someones-file.txt")).unwrap(), b"do not touch me");
}

#[test]
fn preflight_refuses_a_target_that_already_holds_lataif_data() {
    let src = tmp("has-src");
    make_source(&src, "id-1");
    let app = make_app_data(&src, "id-1");
    let root = root_of(&app);
    let backups = tmp("has-bk");

    // A foreign root — different rootId, complete in its own right. Never merged, never adopted.
    let target = tmp("has-target");
    make_source(&target, "a-foreign-id");
    assert_eq!(plan_for(&root, &target, &backups).unwrap_err(), MoveError::TargetHasLataifData);
    // The foreign data set is untouched.
    assert_eq!(data_root::read_marker(&target).unwrap().unwrap().root_id, "a-foreign-id");
}

#[test]
fn a_clean_target_produces_a_plan_with_real_numbers() {
    let src = tmp("ok-src");
    make_source(&src, "id-1");
    let app = make_app_data(&src, "id-1");
    let root = root_of(&app);
    let backups = tmp("ok-bk");
    let target = tmp("ok-parent").join("Data");

    let plan = plan_for(&root, &target, &backups).unwrap();
    assert_eq!(plan.root_id, root.root_id(), "a move never invents a new data identity");
    // business DB + marker + one media blob + two key files. (`mobile-upload-staging/` is empty here,
    // and the manifest lists files, not directories.)
    assert_eq!(plan.file_count, 5, "every real file in the root is in the manifest");
    assert!(plan.required_bytes > 0);
    assert!(plan.free_bytes >= plan.required_bytes);
    assert!(plan.staging_root.contains(STAGING_PREFIX));
    assert!(!Path::new(&plan.staging_root).exists(), "preflight copies nothing");
}

#[test]
fn insufficient_space_is_refused() {
    assert_eq!(check_space(1_000, 999).unwrap_err(), MoveError::InsufficientSpace);
    assert!(check_space(1_000, 1_000).is_ok());
    assert!(required_bytes(1_000) > 1_000, "headroom is added on top of the measured size");
}

#[test]
fn a_reparse_point_inside_the_source_stops_the_whole_move() {
    let src = tmp("rp-src");
    make_source(&src, "id-1");
    let elsewhere = tmp("rp-outside");
    fs::write(elsewhere.join("secret.txt"), b"outside the root").unwrap();
    // A junction is the realistic Windows case; if the environment refuses to create one, the test
    // still asserts the clean path rather than pretending it proved something.
    let link = src.join("linked");
    let made = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J", &link.to_string_lossy(), &elsewhere.to_string_lossy()])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if made {
        assert_eq!(scan_source(&src).unwrap_err(), MoveError::ReparsePointInSource);
    } else {
        assert!(scan_source(&src).is_ok());
    }
}

// ── verification ────────────────────────────────────────────────────────────

/// Run a real move to the point where the staging tree exists, then hand it back for tampering.
fn stage(src: &Path, root_id: &str) -> (PathBuf, BTreeMap<String, u64>) {
    let staging = tmp("stg").join(format!("{STAGING_PREFIX}{root_id}"));
    let manifest = scan_source(src).unwrap();
    copy_tree(src, &staging, &manifest).unwrap();
    (staging, manifest)
}

#[test]
fn a_faithful_copy_verifies() {
    let src = tmp("v-src");
    make_source(&src, "id-1");
    let (staging, manifest) = stage(&src, "id-1");
    verify(&src, &staging, &manifest, "id-1").unwrap();
}

#[test]
fn a_changed_byte_is_caught_by_the_hash_even_when_the_size_matches() {
    let src = tmp("v-hash");
    make_source(&src, "id-1");
    let (staging, manifest) = stage(&src, "id-1");
    // Same length, different content — a size-only check would sail straight past this.
    let blob = staging.join("media").join("scope-a").join("ab").join("abcdef.jpg");
    let mut bytes = fs::read(&blob).unwrap();
    bytes[0] ^= 0xFF;
    fs::write(&blob, &bytes).unwrap();
    assert_eq!(verify(&src, &staging, &manifest, "id-1").unwrap_err(), MoveError::HashMismatch);
}

#[test]
fn a_missing_or_extra_file_is_caught_by_the_manifest() {
    let src = tmp("v-man");
    make_source(&src, "id-1");
    let (staging, manifest) = stage(&src, "id-1");
    fs::remove_file(staging.join("sync_jwt_secret.key")).unwrap();
    assert_eq!(verify(&src, &staging, &manifest, "id-1").unwrap_err(), MoveError::ManifestMismatch);

    let (staging2, manifest2) = stage(&src, "id-1b");
    fs::write(staging2.join("stowaway.txt"), b"extra").unwrap();
    assert_eq!(verify(&src, &staging2, &manifest2, "id-1").unwrap_err(), MoveError::ManifestMismatch);
}

#[test]
fn a_corrupted_database_copy_is_caught_before_any_switch() {
    let src = tmp("v-db");
    make_source(&src, "id-1");
    let (staging, mut manifest) = stage(&src, "id-1");
    // Overwrite the copied DB with garbage of its own recorded size, then re-record size+manifest so
    // ONLY the integrity check can catch it.
    let db = staging.join(data_root::BUSINESS_DB_FILENAME);
    let n = fs::metadata(&db).unwrap().len() as usize;
    fs::write(&db, vec![0x41u8; n]).unwrap();
    // Make the manifest agree with the corrupted copy so the hash step passes it through.
    let key = data_root::BUSINESS_DB_FILENAME.to_string();
    manifest.insert(key.clone(), n as u64);
    fs::copy(&db, src.join(data_root::BUSINESS_DB_FILENAME)).unwrap();
    assert_eq!(verify(&src, &staging, &manifest, "id-1").unwrap_err(), MoveError::DbIntegrityFailed);
}

#[test]
fn a_referenced_media_file_that_did_not_arrive_is_caught() {
    let src = tmp("v-media");
    make_source(&src, "id-1");
    let (staging, mut manifest) = stage(&src, "id-1");
    let blob = staging.join("media").join("scope-a").join("ab").join("abcdef.jpg");
    fs::remove_file(&blob).unwrap();
    manifest.remove("media/scope-a/ab/abcdef.jpg");
    fs::remove_file(src.join("media").join("scope-a").join("ab").join("abcdef.jpg")).unwrap();
    assert_eq!(verify(&src, &staging, &manifest, "id-1").unwrap_err(), MoveError::MediaReferenceMissing);
}

#[test]
fn a_marker_naming_a_different_data_set_is_caught() {
    let src = tmp("v-id");
    make_source(&src, "id-1");
    let (staging, manifest) = stage(&src, "id-1");
    assert_eq!(verify(&src, &staging, &manifest, "a-different-id").unwrap_err(), MoveError::RootIdMismatch);
}

// ── the state machine, one crash window per test ────────────────────────────

struct Fixture {
    app: PathBuf,
    src: PathBuf,
    target: PathBuf,
    plan: MovePlan,
}

fn fixture(tag: &str) -> Fixture {
    let src = tmp(&format!("{tag}-src"));
    make_source(&src, "id-move");
    let app = make_app_data(&src, "id-move");
    let root = root_of(&app);
    let backups = tmp(&format!("{tag}-bk"));
    let target = tmp(&format!("{tag}-parent")).join("Data");
    let plan = plan_for(&root, &target, &backups).unwrap();
    schedule(&app, &root, &plan).unwrap();
    Fixture { app, src, target, plan }
}

fn set_phase(app: &Path, phase: MovePhase) {
    let mut i = read_intent(app).unwrap();
    i.phase = phase;
    let bytes = serde_json::to_vec_pretty(&i).unwrap();
    fs::write(intent_path(app), bytes).unwrap();
}

fn active_root(app: &Path) -> PathBuf {
    data_root::read_locator(app).unwrap().unwrap().data_root.into()
}

#[test]
fn a_scheduled_move_runs_at_the_next_boot_and_switches_exactly_once() {
    let f = fixture("run");
    let src_before = scan_source(&f.src).unwrap();

    let (root, outcome) = resolve_with_pending_move(&f.app).unwrap();
    assert_eq!(outcome, MoveOutcome::Switched);
    assert_eq!(root.path(), f.target.as_path());
    assert_eq!(root.root_id(), "id-move", "the data identity is unchanged by the move");
    assert!(read_intent(&f.app).is_none(), "the intent is consumed");
    // The source is still complete — B2 never deletes it.
    assert_eq!(scan_source(&f.src).unwrap(), src_before);
    assert!(f.src.join(data_root::BUSINESS_DB_FILENAME).exists());
    // No staging tree survives.
    assert!(!Path::new(&f.plan.staging_root).exists());

    // A second boot is a plain resolve: still the target, nothing rewritten.
    let (again, outcome2) = resolve_with_pending_move(&f.app).unwrap();
    assert_eq!(outcome2, MoveOutcome::None);
    assert_eq!(again.path(), f.target.as_path());
}

#[test]
fn a_second_move_cannot_be_scheduled_while_one_is_pending() {
    let f = fixture("dup");
    let root = data_root::validated(f.src.clone(), "id-move".into(), &f.app);
    assert_eq!(schedule(&f.app, &root, &f.plan).unwrap_err(), MoveError::MoveAlreadyPending);
}

#[test]
fn a_move_cannot_be_scheduled_while_another_boot_operation_is_queued() {
    let src = tmp("busy-src");
    make_source(&src, "id-1");
    let app = make_app_data(&src, "id-1");
    let root = root_of(&app);
    let backups = tmp("busy-bk");
    let target = tmp("busy-parent").join("Data");
    let plan = plan_for(&root, &target, &backups).unwrap();
    fs::write(src.join(".restore-intent"), b"pending").unwrap();
    assert_eq!(schedule(&app, &root, &plan).unwrap_err(), MoveError::OperationPending);
}

#[test]
fn a_crash_while_copying_leaves_the_source_active_and_does_not_pile_up_staging_trees() {
    let f = fixture("crash-copy");
    // Exactly the on-disk state of a crash mid-copy: a partial staging tree and phase=copying.
    let staging = PathBuf::from(&f.plan.staging_root);
    fs::create_dir_all(staging.join("media")).unwrap();
    fs::write(staging.join("half-a-file"), b"partial").unwrap();
    set_phase(&f.app, MovePhase::Copying);

    let (root, outcome) = resolve_with_pending_move(&f.app).unwrap();
    assert_eq!(outcome, MoveOutcome::Switched, "the partial copy is discarded and the move redone");
    assert_eq!(root.path(), f.target.as_path());
    assert!(!staging.exists(), "no orphaned staging tree is left behind");
    assert!(!f.target.join("half-a-file").exists(), "and nothing from the partial copy survived");
}

#[test]
fn a_crash_after_verification_but_before_the_switch_keeps_the_source_authoritative() {
    let f = fixture("crash-verified");
    set_phase(&f.app, MovePhase::Verified);
    // Before this boot runs, the locator still names the source. That is the invariant.
    assert_eq!(active_root(&f.app), f.src);
    let (root, _) = resolve_with_pending_move(&f.app).unwrap();
    assert_eq!(root.path(), f.target.as_path(), "the redo completes it");
    assert!(f.src.join(data_root::BUSINESS_DB_FILENAME).exists());
}

#[test]
fn a_crash_after_the_target_was_finalised_commits_on_the_next_boot() {
    let f = fixture("crash-final");
    // Simulate: the copy+verify+rename happened, the locator write did not.
    let staging = PathBuf::from(&f.plan.staging_root);
    let manifest = scan_source(&f.src).unwrap();
    copy_tree(&f.src, &staging, &manifest).unwrap();
    fs::create_dir_all(f.target.parent().unwrap()).unwrap();
    fs::rename(&staging, &f.target).unwrap();
    set_phase(&f.app, MovePhase::TargetFinalized);
    assert_eq!(active_root(&f.app), f.src, "before the boot the source is still live");

    let (root, outcome) = resolve_with_pending_move(&f.app).unwrap();
    assert_eq!(outcome, MoveOutcome::Switched);
    assert_eq!(root.path(), f.target.as_path());
    assert!(read_intent(&f.app).is_none());
}

#[test]
fn a_finalised_target_that_no_longer_validates_is_abandoned_and_the_source_stays() {
    let f = fixture("crash-final-bad");
    fs::create_dir_all(&f.target).unwrap();
    fs::write(f.target.join("junk"), b"not a data root").unwrap();
    set_phase(&f.app, MovePhase::TargetFinalized);

    let (root, outcome) = resolve_with_pending_move(&f.app).unwrap();
    assert!(matches!(outcome, MoveOutcome::Aborted(_)));
    assert_eq!(root.path(), f.src.as_path(), "the source is still the active root");
    assert!(read_intent(&f.app).is_none(), "and the dead intent is gone, so the app is not stuck");
}

#[test]
fn a_crash_after_the_switch_but_before_the_intent_was_cleared_just_completes() {
    let f = fixture("crash-after-switch");
    // Do the whole move, then put the intent back in its pre-clear state.
    let (_, outcome) = resolve_with_pending_move(&f.app).unwrap();
    assert_eq!(outcome, MoveOutcome::Switched);
    let mut i = f.plan.clone();
    i.root_id = "id-move".into();
    let intent = MoveIntent {
        schema_version: MOVE_INTENT_SCHEMA_VERSION,
        move_id: i.move_id,
        root_id: i.root_id,
        source_root: i.source_root,
        target_root: i.target_root,
        staging_root: i.staging_root,
        phase: MovePhase::LocatorSwitched,
        attempts: 1,
        created_at: "2026-01-01T00:00:00Z".into(),
    };
    fs::write(intent_path(&f.app), serde_json::to_vec_pretty(&intent).unwrap()).unwrap();

    let (root, outcome2) = resolve_with_pending_move(&f.app).unwrap();
    assert_eq!(outcome2, MoveOutcome::Switched);
    assert_eq!(root.path(), f.target.as_path());
    assert!(read_intent(&f.app).is_none());
}

#[test]
fn a_target_that_cannot_be_opened_after_the_switch_rolls_back_to_the_bound_source() {
    let f = fixture("rollback");
    let (_, outcome) = resolve_with_pending_move(&f.app).unwrap();
    assert_eq!(outcome, MoveOutcome::Switched);
    // Now the target becomes unusable — a disconnected drive, a folder someone deleted.
    fs::remove_dir_all(&f.target).unwrap();
    let intent = MoveIntent {
        schema_version: MOVE_INTENT_SCHEMA_VERSION,
        move_id: f.plan.move_id.clone(),
        root_id: "id-move".into(),
        source_root: f.plan.source_root.clone(),
        target_root: f.plan.target_root.clone(),
        staging_root: f.plan.staging_root.clone(),
        phase: MovePhase::LocatorSwitched,
        attempts: 1,
        created_at: "2026-01-01T00:00:00Z".into(),
    };
    fs::write(intent_path(&f.app), serde_json::to_vec_pretty(&intent).unwrap()).unwrap();

    let (root, outcome2) = resolve_with_pending_move(&f.app).unwrap();
    assert_eq!(outcome2, MoveOutcome::RolledBack);
    assert_eq!(root.path(), f.src.as_path(), "back on the source the intent explicitly bound");
    assert_eq!(root.root_id(), "id-move", "with the same identity — no new data set was invented");
    assert!(read_intent(&f.app).is_none());
}

#[test]
fn without_a_move_intent_a_missing_target_is_never_silently_replaced_by_the_source() {
    // The rollback above is legal ONLY because an intent bound the source. Take the intent away and
    // the same situation must fail closed — this is the B1 contract, and B2 must not weaken it.
    let src = tmp("norollback-src");
    make_source(&src, "id-x");
    let app = make_app_data(&src, "id-x");
    let gone = tmp("norollback-target");
    make_source(&gone, "id-x");
    data_root::set_locator(&app, &gone, "id-x").unwrap();
    fs::remove_dir_all(&gone).unwrap();

    let err = resolve_with_pending_move(&app).unwrap_err();
    assert_eq!(err.code(), "DATA_ROOT_UNREACHABLE");
}

#[test]
fn a_move_that_keeps_failing_gives_up_instead_of_blocking_every_future_start() {
    let f = fixture("giveup");
    // A target path that can never be created: the parent is a FILE.
    let blocker = tmp("giveup-block").join("file-not-a-dir");
    fs::write(&blocker, b"x").unwrap();
    let mut i = read_intent(&f.app).unwrap();
    i.target_root = blocker.join("Data").to_string_lossy().to_string();
    i.staging_root = blocker.join(format!("{STAGING_PREFIX}x")).to_string_lossy().to_string();
    i.attempts = MAX_ATTEMPTS;
    fs::write(intent_path(&f.app), serde_json::to_vec_pretty(&i).unwrap()).unwrap();

    let (root, outcome) = resolve_with_pending_move(&f.app).unwrap();
    assert!(matches!(outcome, MoveOutcome::Aborted(_)));
    assert_eq!(root.path(), f.src.as_path());
    assert!(read_intent(&f.app).is_none(), "the app starts normally from now on");
}

// ── temp cleanup must not eat a live move ───────────────────────────────────

#[test]
fn cleanup_removes_only_our_own_leftovers_and_never_during_a_move() {
    let f = fixture("cleanup");
    fs::write(f.app.join("data-location.tmp-deadbeef"), b"orphan").unwrap();
    fs::write(f.app.join("someone-elses.tmp"), b"not ours").unwrap();
    assert_eq!(cleanup_own_temp_files(&f.app), 0, "a pending move suspends cleanup entirely");

    clear_intent(&f.app);
    assert_eq!(cleanup_own_temp_files(&f.app), 1);
    assert!(!f.app.join("data-location.tmp-deadbeef").exists());
    assert!(f.app.join("someone-elses.tmp").exists(), "foreign temp files are none of our business");
    assert!(f.app.join(data_root::LOCATOR_FILENAME).exists(), "and the locator is obviously kept");
}
