# A0a — Cross-Client Double-Redemption Defect Harness (read-only, freeze only)

Reproduces and **freezes today's** cross-client defect: two fully separate client
installations each redeem the **same** finite supplier credit against the **same**
expense on the **same** starting base. The current passive last-writer-wins sync
relay has **no** cross-client idempotency/CAS, so both succeed and several business
exactly-once invariants are violated. This harness only **observes** today's
behaviour — it fixes nothing and changes no production code.

## What is real vs. harness

Real (unmodified production code, exercised end-to-end):
- Rust/Axum sync server (`../../server`, in-repo), its real SQLite, `/api/auth/register`,
  `/api/sync/push`, `/api/sync/pull`.
- Client DB engine + schema + migrations (`src/core/db/database.ts`, sql.js).
- Redemption writer `supplierStore.applySupplierCreditsToExpenses` + ledger
  `postExpenseSupplierCreditPayment`.
- Sync engine `sync-service.syncNow` → `pushChanges`/`pullChanges`/`applyUpsert`.
- Reconciliation `counterpartyAudit.runCounterpartyAudit` + `queries.ts`.

Harness boundary only (no production change): browser globals (`window`,
`localStorage`) are shimmed; the sql.js wasm `?url` import is redirected to a
node-loadable path via a Vite plugin; `isTauri()` is false so Tauri paths are never
reached. Each client runs in its **own OS process** (own sql.js DB, own
localStorage) — two separate installations against one real server.

Seam note: `pushChanges`/`pullChanges` are not exported; only the public
`syncNow` (push-then-pull) is. The harness drives `syncNow` and covers **both**
server-changelog orderings (run1 = A pushes first, run2 = B pushes first). The real
LWW merge (`applyUpsert`) runs on every pull. The base fixture is built via direct
SQL (allowed); the concurrent business action runs only through the real writer.

## Prerequisites

- `node` (tested v24) and installed `desktop/node_modules` (sql.js, vite, …).
- The real server built: `cd ../../server && cargo build --release`
  (produces `server/target/release/lataif-server.exe`).
- TCP port **3001** free (the server bind is hardcoded to `0.0.0.0:3001`).

## Run

```bash
# from desktop/
node test/a0a/coordinator.mjs
```

The coordinator first checks that port 3001 is free and aborts with a clear message
if it is busy. It runs three flights:

- **race run1** — both clients redeem on the same base, A pushes first
- **race run2** — same, B pushes first (covers both server-changelog orderings)
- **control** — A redeems → A syncs → B **pulls** A's result → **then** B attempts the
  same redemption via the real writer (proves the race barrier + stale local state
  are causal — not the fixture or a baked assertion)

Transient server DBs + logs are written to an isolated `os.tmpdir()/lataif-a0a-*`
directory and **deleted** at the end. Committed artifacts (next to the harness) record
the business state as **canonical counts + shapes** (random row UUIDs, process IDs,
temp paths and timestamps are not persisted — the counts already prove rows are
distinct), so re-runs are byte-stable and do not churn the git diff.

- `a0a-run1.json`, `a0a-run2.json` — full machine-readable proof per race ordering
- `a0a-control.json` — the negative control flight
- `a0a-report.md` — human report (starting hashes, barrier, sync order, reconciliation, invariants, control)
- `a0a-observed-defect-signature.json` — structural defect signature OBSERVED after the
  runs (descriptive only; never read by the harness — it does not drive writer/sync/fixture)
