# LATAIF v0.8.17

Hardened sync-safety tooling and a safer product import. This release ships **tools and UI only** —
it performs **no** automatic data migration and touches **no** production data on its own.

## Sync Safety Tooling
- **D4-B — Pure changelog logic**: replay / corrective-baseline / synthetic-tombstone / compaction
  planning as a pure, injectable module (no DB/Tauri), fully unit-tested.
- **D4-C — Dry-run report tool**: read-only analysis of a `sync_changelog` copy — coverage,
  compaction potential, orphan tombstones. Never writes; refuses live originals; no raw data in reports.
- **D4-D — Backup-first migration tool**: gated corrective baseline / tombstone / compaction migration.
  Dry-run by default; writes **only** with the full explicit flag set
  (`--execute --i-understand-this-writes-to-sync-db --backup-dir`), backup-first, single-transaction
  archive → append → prune → verify.
- **Important:** D4-D is a **gated tool**. There is **no** automatic live migration — nothing runs
  against a real sync database without an explicit, manual, fully-flagged invocation on a copy.

## Safe Product Import
- **Backup-first import**: a full database backup is created **before** the first product is written.
  If the backup fails, the import does not start.
- **Duplicate detection** against existing products, blocked by default:
  - SKU
  - Serial number
  - Brand + Reference
  - file-internal duplicates (same file, repeated key)
- **VAT scheme selectable & validated** — no more silent `MARGIN` default:
  - `VAT_10`
  - `ZERO`
  - `MARGIN`

  A default scheme must be selected; a per-row VAT column overrides it; unrecognized values are rejected.
- **Robust number parser** for US / EU / currency formats (e.g. `1,234.50`, `1.234,50`, `BD 1,234.500`).
  Ambiguous values are flagged, never silently mis-parsed.
- **Invalid and duplicate rows are blocked** before import; only clean, new rows are written.
- **Import warning**: the import runs row-by-row and is **not** a single transaction. If an unexpected
  error occurs partway, some rows may already be saved — the pre-import backup is your rollback point.
- **Verified**: the S1 smoke test ran the full import end-to-end on a **throwaway copy** of the
  database (duplicate blocked, invalid blocked, EU number parsed correctly, VAT applied, backup created);
  the **live database remained byte-for-byte unchanged**.

## Not Included / Safety Notes
- **No** automatic sync-database migration.
- **No** real production database migration.
- **No** real production Excel import.
- v0.8.17 ships **only** the hardened tools and UI.
