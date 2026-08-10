# STORAGE-PERF — measured baseline and harnesses

Everything here is read-only against production. The measurement scripts build
their own isolated fixtures; the gates run against in-memory sql.js databases.
No script in this folder opens the production database for writing.

## Why this exists

Legacy products store their photo as a base64 `data:` URL **inside**
`products.images`. Measured on a real production database (27 products, 16 of
them legacy):

| where | bytes | share of file |
|---|---:|---:|
| `sync_changelog.data` | 20.5 MB | 40.8 % |
| `audit_log.new_value` | 14.6 MB | 29.1 % |
| `products.images` | 9.6 MB | 20.7 % |
| `repairs.images` | 1.5 MB | 3.0 % |
| `purchase_inbox.images` | 0.5 MB | 1.1 % |
| **file total** | **50.2 MB** | |

The same 7.2 MB of actual image data is stored **four times**: once in the row,
once in every changelog snapshot the row ever produced, once in the audit trail,
and once again in the sync-server database (39.6 MB of its 40.2 MB). Every save
of a legacy product writes the whole image again — it is a per-save cost, not a
one-off.

## Harnesses

### `measure-storage.mjs` — durable-save size scaling (§3/§19/§24)

Builds isolated fixtures from the real schema in two variants and measures the
exact F5 path (`sql.js load → db.export() → temp write → verify → rename →
reopen`). `--max-mb=N` bounds the largest fixture.

```
node --max-old-space-size=6144 test/storage-perf/measure-storage.mjs --max-mb=600
```

Measured (450 KB photos; variant B stores the normalised ≤100 KB rendition the
media contract enforces):

| products | inline size | gallery size | inline F5 | gallery F5 | inline RSS |
|---:|---:|---:|---:|---:|---:|
| 27 | 47.2 MB | 0.7 MB | 104 ms | 9 ms | +116 MB |
| 56 | 97.1 MB | 0.8 MB | 216 ms | 10 ms | +177 MB |
| 140 | 241.8 MB | 1.0 MB | 682 ms | 9 ms | +681 MB |
| **200** | **345.2 MB** | **1.2 MB** | **861 ms** | **9 ms** | **+1017 MB** |
| 280 | 483.1 MB | 1.5 MB | 1327 ms | 10 ms | +1387 MB |

`export()` and the reopen are real sql.js (WASM); file I/O is native Node, so a
real WebView2 install is at least this slow, never faster. The memory column is
the point: at 200 products the durable-save path transiently needs about a
gigabyte, on the UI thread, inside a 32-bit WASM heap.

### SINGLE-PC-STORAGE-I2 — re-measured on the final tree

Same harness, same machine, run as the push gate for the single-PC release
(`node --max-old-space-size=8192 measure-storage.mjs --max-mb=400`):

| products | before (inline) | after (gallery) | before F5 | after F5 | before RSS |
|---:|---:|---:|---:|---:|---:|
| 27 | 47.2 MB | 0.7 MB | 147.9 ms | 10.0 ms | +118 MB |
| 56 | 97.1 MB | 0.8 MB | 310.0 ms | 13.2 ms | +177 MB |
| 140 | 241.8 MB | 1.0 MB | 720.2 ms | 13.4 ms | +681 MB |
| **200** | **345.2 MB** | **1.2 MB** | **1091 ms** | **13.8 ms** | **+1012 MB** |

The 200-product row is the case that started this work: a colleague's install
with ~200 photographed items froze on F5. At that size the durable-save path
moves a 345 MB file and transiently allocates about a gigabyte on the UI thread;
after the migration it moves 1.2 MB and allocates 4 MB. Compaction is what turns
the freed rows into a smaller FILE — without it SQLite keeps the pages on its
freelist and the on-disk size does not move.

## Gates

| gate | asserts |
|---|---|
| `legacy-media-migration.test.ts` | planner classification, crash/retry idempotency, multi-image + corrupt fixtures, legacy-key preservation, independent verification |
| `compaction-crash-safety.test.ts` | a REAL process kill mid-persist and pre-rename, ENOSPC at the temp write, failure after VACUUM before persist, free-space preflight |
| `e2e-isolation-sweep.test.ts` | every E2E suite is statically proven unable to reach the production identifier, port, DB or media |
| `../e2e/storage-maintenance.e2e.mjs` | the real panel: non-owner refused, dry run read-only, backup gate, apply + independent verification, corrupt candidate kept, idempotent second run, compaction as a separate owner action |
| `audit-blob-free.test.ts` | new audit writes carry a descriptor, not the image; add/remove/replace still legible |
| `sync-payload-contract.test.ts` | a price-only save re-embeds the image on a legacy product and carries none on a migrated one |
| `changelog-retention.test.ts` | client retention safety predicates; server retention structurally absent |
| `database-compaction.test.ts` | VACUUM reclaims, refusals never touch the database, persist failures surface |
| `storage-panel-logic.test.ts` | backup freshness gate, operator messages never leak data and always state that originals survived |
