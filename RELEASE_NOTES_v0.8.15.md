# LATAIF v0.8.15

**Security hotfix release**

This release hardens JWT secret handling in both sync servers (G1 + G2). There is no
new feature surface — the focus is removing the known hard-coded development JWT
secret and giving the embedded sync server a persisted, high-entropy per-install
secret.

## Security
- The standalone `server/` no longer starts with a silent hard-coded JWT default — a
  configured secret is required (fail-closed).
- The embedded Tauri sync server now uses a **persisted, high-entropy per-install JWT
  secret** generated on first start (no known default).
- The known development default secret is rejected unless explicitly opted in via
  `LATAIF_ALLOW_DEV_JWT_SECRET=1` (local development only).
- The auth middleware verifies against the **same** secret source that mints tokens
  (login/register and the owner self-token) — no separate env re-read.
- No secret is stored in the repository or written to logs.
- The embedded owner self-token is signed with the persisted secret.

## Compatibility / Notes
- v0.8.15 contains G1 + G2; v0.8.14 remains the previous release.
- After updating, LAN sync **clients** may need a one-time re-login (the server secret
  changes from the old default to a persisted random value, invalidating old tokens);
  the server/single-desktop case is seamless.
- No general multi-writer protection.
- No general offline operation queue.
- No database migration.
- No operations-architecture refactor.

## Validation
```
src-tauri cargo fmt/check/test:  passed / passed / 10 tests
Server tests:                    157/0
A0b Node:                        122 cases / 261 assertions / 0 errors
A0b Rust:                        260 assertions / 0 errors + 3/3 tests
TypeScript:                      tsc -b and tsc --noEmit passed
B1 migration:                    10/10
B1 E2E harness:                  20/20
F1 hardening:                    18/18
npm run build:                   passed
NSIS installer:                  built and signed
```

## Notes / limitations
- No full multi-writer safety and no general offline queue (unchanged scope).
- The release process is manual (version bump + notes + signed NSIS installer); no new
  general release pipeline was introduced.
- No full GUI installer upgrade test was performed in this environment; upgrade safety
  is substantiated by the build, the migration tests, the absence of any schema change,
  and the embedded version stamp.
