# LATAIF v0.8.14

**Stability, sync, finance and inventory hardening release**

This release bundles the authoritative Supplier-Credit server path (B0 + B1-R + C1), finance
hardening (D1), a full ERP regression audit (E1) and inventory/order hardening (F1). No new
public feature surface — the focus is correctness, sync safety and stock/invoice integrity.

## Added
- Authoritative server-side settlement bridge
- Atomic Supplier Credit operation on the server
- Desktop Supplier Credit workflow through the atomic operation API
- Operation status and operation pull support
- B1 end-to-end harness
- F1 inventory/order hardening tests

## Improved
- Supplier Credit settlement is protected against duplicate redemption
- Desktop no longer writes Supplier Credit settlement locally before the server decision
- Operations envelopes are applied idempotently
- Credit-settled Expense amount edits are guarded
- Invoice stock consumption is checked before committing invoices
- Order-line conversion to invoice is hardened against duplicate conversion
- Cash/Bank/Benefit expense payments remain compatible after cutover
- Full ERP regression audit completed

## Validation
```
Server tests:      150/0
A0b Node:          122 cases / 261 assertions / 0 errors
A0b Rust:          260 assertions / 0 errors + 3/3 tests
TypeScript:        tsc -b and tsc --noEmit passed
B1 migration:      10/10
B1 E2E harness:    20/20
F1 hardening:      18/18
npm run build:     passed
```

## Notes / limitations
- v0.8.14 is ready for normal single-user production use.
- Multi-client Supplier Credit conflicts are protected through the server operation path.
- A general offline operation queue is **not** included.
- No new general operation registry.
- No second operation type beyond Supplier Credit.
- The dev-JWT default remains a separate, known security hardening task if still present.
- A full module-by-module runtime ERP harness is not yet available; E1 used automated gates
  plus code audit plus the production build (not an executable end-to-end run of every module).
