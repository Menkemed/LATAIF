# LATAIF v0.8.16

**Data integrity / safety release**

This release hardens how the app writes its local database and how the Settings
"Danger Zone" performs destructive actions. There is no new feature surface — the focus
is preventing partial/corrupt writes, preventing silent data loss on purge, and
preventing a local Factory Reset from later being "resurrected" by the sync server.

## Data integrity & safety
- **Atomic local database writes** — the database file is written to a temporary file,
  verified, then atomically renamed into place. A write that is interrupted can no
  longer leave a half-written or corrupt `lataif.db`.
- **Stale-write protection** — an older in-memory snapshot can no longer overwrite a
  newer on-disk state; a detected conflict is refused instead of clobbering the newer data.
- **Visible save/flush errors** — persistence failures are no longer silently swallowed;
  they are logged, queryable, and surfaced on app-close flush.
- **Safe destructive purge** — before any Settings purge, an **automatic local backup**
  of the database files is created; if the backup fails, the destructive action is aborted.
- **Tracked delete changes** — a Settings purge now writes a per-record sync `delete`
  change for every sync-tracked table it clears, so deletions propagate and are **not
  resurrected** by a later sync pull. There are no more silent direct `DELETE`s in the
  Danger Zone.
- **Factory Reset guard** — Factory Reset is **blocked while Sync/LAN is configured or
  active**, because a purely local reset could be re-populated with old data from the
  sync server. Disable sync deliberately (or use Safe Purge) instead.

## Compatibility / Notes
- v0.8.16 contains D2 (atomic persistence) + D3/D3b (safe purge + reset guard);
  v0.8.15 remains the previous release.
- **Existing data is not automatically modified** by this release — no migration, no
  repair, no cleanup runs against your data.
- **Server-side changelog compaction/tombstones (D4) is NOT included yet.** The unbounded
  server changelog growth and a retroactive cleanup path for an already-affected device
  remain a later slice.
- **For an already affected colleague/device:** a backup plus the read-only D1 recovery
  procedure is still required *before* any repair — this release prevents new occurrences
  but does not retroactively clean an already-bloated server changelog.

## Validation
```
D2 atomic-persistence tests:   40/40
D3 safe-purge tests:           54/54
TypeScript:                    tsc -b and tsc --noEmit passed
npm run build:                 passed
Direct DELETEs in Danger Zone: 0
No Rust source (.rs) changed; capabilities gained fs:allow-rename + fs:allow-stat
```

## Notes / limitations
- The new Tauri fs permissions (`fs:allow-rename`, `fs:allow-stat`) take effect with this
  build's native installer; there is no runtime gap because they ship together.
- The `all_data` purge remains a partial purge (it clears the same tables as before —
  purchases/expenses/stock-lots/ledger entries are not included); the "ALL DATA" label is
  optimistic and unchanged in scope.
- No server changelog baseline/tombstones/compaction (D4), no Excel export, and no
  LoginPage-reset backup follow-up are included — these remain later slices.
- The release process is manual (version bump + notes + signed NSIS installer); no new
  general release pipeline was introduced.
- Existing data is untouched; upgrade safety is substantiated by the build, the test
  suites, and the absence of any schema change.
