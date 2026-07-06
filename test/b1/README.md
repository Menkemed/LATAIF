# B1 — Desktop end-to-end harness

Proves the cross-client supplier-credit defect is fixed **end to end** against the
real server and the real client apply.

- Spawns the real Rust server (`server/target/debug/lataif-server`) on an isolated
  `BIND_ADDR` with an isolated `DATABASE_PATH` per scenario.
- Bootstraps over the real HTTP API: `POST /api/auth/register` → tenant/branch/user
  + token; a second `POST /api/auth/login` → a second device token; seeds the
  supplier-credit + expense snapshots via `POST /api/sync/push` (the legacy relay
  the server cuts over from).
- Two clients, each a real `sql.js` database, apply the authoritative operation
  envelope through the **real** `src/core/operations/b1-protocol.ts` `applyEnvelope`
  (the same code the desktop runs) — no re-implementation.

Run:

```bash
node test/b1/harness.ts
```

Scenarios: A-wins, B-wins, genuinely concurrent exactly-once, idempotent replay,
operationId reuse, unknown-commit-status recovery, operations-pull convergence,
offline (no local mutation), and bootstrap (`FINANCE_NOT_BOOTSTRAPPED`). Each
asserts the business end-state (used 100, one payment, one balanced ledger txn,
revisions 1/1, exactly one accepted operation) and cross-client convergence.
