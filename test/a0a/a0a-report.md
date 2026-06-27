# A0a — Cross-Client Double-Redemption Defect (today's behaviour, frozen)

node v24.15.0 · HEAD `9b32ffb0c0cdf6e66348b666ae13fd362576e5db` · server `lataif-server.exe` (real Rust/Axum, isolated DB, port 3001)
Business state is reported as canonical counts/shapes (random row UUIDs are omitted — the counts prove the rows are distinct). Re-runs are byte-stable.

## Real components (file:line)

- writer `supplierStore.applySupplierCreditsToExpenses` (src/stores/supplierStore.ts:540); ledger `postExpenseSupplierCreditPayment` (src/core/ledger/posting.ts:1420)
- sync `sync-service.syncNow` → pushChanges(97)/pullChanges(136)/applyUpsert(273); recon `counterpartyAudit.runCounterpartyAudit` (483) + queries.ts
- server real `/api/auth/register`,`/api/sync/push`,`/api/sync/pull`

> Seam: separate push/pull are not exported; the public `syncNow` is driven and both push orderings are covered. The real LWW merge (`applyUpsert`) runs on every pull.


---
## run1 — RACE, push-first: A

**Starting state (before any action):** content-identical A≡B: **true** (domainHash=a37362f1e66c2658, ledgerHash=ea05846fa63116eb); both changelogs empty: true; both cursors 0: true; server changelog empty: true; separate processes: true; shared sql.js/db-file/appDataDir: false/false/false.

**Barrier:** A redeemed ok=true, B redeemed ok=true; before any sync A_cursor=0 (unsynced 5), B_cursor=0 (unsynced 5). ⇒ both acted on the same old base.

**Sync cycles (real syncNow):** A-run1(pend=0,cur=5) → B-run1(pend=0,cur=10) → A-run1(pend=0,cur=10) → B-run1(pend=0,cur=10)

**Server changelog order:** 1:expense_payments/insert, 2:ledger_entries/insert, 3:ledger_entries/insert, 4:supplier_credits/update, 5:expenses/update, 6:expense_payments/insert, 7:ledger_entries/insert, 8:ledger_entries/insert, 9:supplier_credits/update, 10:expenses/update

**Final business state (clients converged identical: true):**
```
supplier_credits : [{"amount":100,"used_amount":100,"status":"USED"}]
expenses         : [{"amount":100,"paid_amount":0,"status":"PAID"}]
expense_payments : count=2 shapes=[{"amount":100,"method":"credit","reference":"cred-a0a","count":2}]
redemption ledger: transactions=2 legs=[{"account":"ACCOUNTS_PAYABLE","direction":"DEBIT","amount":100,"count":2},{"account":"SUPPLIER_CREDIT","direction":"CREDIT","amount":100,"count":2}]
```
**Reconciliation after:** {"globalImbalance":0,"supplierAP_ledger":-100,"supplierCredit_ledger":-100,"cpMismatches":1,"cpCreditErrors":0}
  - global ledger balanced: **YES (green)** · domain/ledger agree: **NO** · credit ledger balance: **-100** (NEGATIVE — over-drawn)
  - **part of defect invisible to GREEN global reconciliation: YES**

| Invariant | Expected (business) | Actual | Violated |
|---|---:|---:|:--:|
| Exactly one redemption succeeds (other blocked) | one ok / one blocked | A.ok=true B.ok=true | **yes** |
| Credit used exactly once (used_amount == Σ credit payments) | equal | used_amount=100, Σ=200 | **yes** |
| Exactly one credit expense_payment row | 1 | 2 | **yes** |
| Exactly one redemption ledger transaction | 1 | 2 | **yes** |
| Expense not over-settled (Σ credit settled <= amount) | <= 100 | 200 | **yes** |
| Supplier-credit ledger balance >= 0 | >= 0 | -100 | **yes** |
| Global ledger imbalance == 0 | 0 | 0 | no |
| Counterparty reconciliation green | 0 mismatch / 0 error | mismatch=1, creditErrors=0 | **yes** |

---
## run2 — RACE, push-first: B

**Starting state (before any action):** content-identical A≡B: **true** (domainHash=a37362f1e66c2658, ledgerHash=ea05846fa63116eb); both changelogs empty: true; both cursors 0: true; server changelog empty: true; separate processes: true; shared sql.js/db-file/appDataDir: false/false/false.

**Barrier:** A redeemed ok=true, B redeemed ok=true; before any sync A_cursor=0 (unsynced 5), B_cursor=0 (unsynced 5). ⇒ both acted on the same old base.

**Sync cycles (real syncNow):** B-run2(pend=0,cur=5) → A-run2(pend=0,cur=10) → B-run2(pend=0,cur=10) → A-run2(pend=0,cur=10)

**Server changelog order:** 1:expense_payments/insert, 2:ledger_entries/insert, 3:ledger_entries/insert, 4:supplier_credits/update, 5:expenses/update, 6:expense_payments/insert, 7:ledger_entries/insert, 8:ledger_entries/insert, 9:supplier_credits/update, 10:expenses/update

**Final business state (clients converged identical: true):**
```
supplier_credits : [{"amount":100,"used_amount":100,"status":"USED"}]
expenses         : [{"amount":100,"paid_amount":0,"status":"PAID"}]
expense_payments : count=2 shapes=[{"amount":100,"method":"credit","reference":"cred-a0a","count":2}]
redemption ledger: transactions=2 legs=[{"account":"ACCOUNTS_PAYABLE","direction":"DEBIT","amount":100,"count":2},{"account":"SUPPLIER_CREDIT","direction":"CREDIT","amount":100,"count":2}]
```
**Reconciliation after:** {"globalImbalance":0,"supplierAP_ledger":-100,"supplierCredit_ledger":-100,"cpMismatches":1,"cpCreditErrors":0}
  - global ledger balanced: **YES (green)** · domain/ledger agree: **NO** · credit ledger balance: **-100** (NEGATIVE — over-drawn)
  - **part of defect invisible to GREEN global reconciliation: YES**

| Invariant | Expected (business) | Actual | Violated |
|---|---:|---:|:--:|
| Exactly one redemption succeeds (other blocked) | one ok / one blocked | A.ok=true B.ok=true | **yes** |
| Credit used exactly once (used_amount == Σ credit payments) | equal | used_amount=100, Σ=200 | **yes** |
| Exactly one credit expense_payment row | 1 | 2 | **yes** |
| Exactly one redemption ledger transaction | 1 | 2 | **yes** |
| Expense not over-settled (Σ credit settled <= amount) | <= 100 | 200 | **yes** |
| Supplier-credit ledger balance >= 0 | >= 0 | -100 | **yes** |
| Global ledger imbalance == 0 | 0 | 0 | no |
| Counterparty reconciliation green | 0 mismatch / 0 error | mismatch=1, creditErrors=0 | **yes** |

---
## control — B redeems only AFTER pulling A's result

**Starting state (before any action):** content-identical A≡B: **true** (domainHash=a37362f1e66c2658, ledgerHash=ea05846fa63116eb); both changelogs empty: true; both cursors 0: true; server changelog empty: true; separate processes: true; shared sql.js/db-file/appDataDir: false/false/false.

**Sequence:** A redeem ok=true → A/B sync to quiescence → B local view after pull: [{"amount":100,"used_amount":100,"status":"USED"}] (expense_payments=1) → B redeem attempt ok=false (Requested amount (100.000) exceeds the supplier's open expenses (0.000).)

**Final business state:**
```
supplier_credits : [{"amount":100,"used_amount":100,"status":"USED"}]
expenses         : [{"amount":100,"paid_amount":0,"status":"PAID"}]
expense_payments : count=1 shapes=[{"amount":100,"method":"credit","reference":"cred-a0a","count":1}]
redemption ledger: transactions=1 legs=[{"account":"ACCOUNTS_PAYABLE","direction":"DEBIT","amount":100,"count":1},{"account":"SUPPLIER_CREDIT","direction":"CREDIT","amount":100,"count":1}]
```
**Reconciliation after:** {"globalImbalance":0,"supplierAP_ledger":0,"supplierCredit_ledger":0,"cpMismatches":0,"cpCreditErrors":0} → global green: true, counterparty green: true
**Control healthy (single redemption, no violation): true** · additional defect: false

| Invariant | Expected (business) | Actual | Violated |
|---|---:|---:|:--:|
| Exactly one redemption succeeds (other blocked) | one ok / one blocked | A.ok=true B.ok=false | no |
| Credit used exactly once (used_amount == Σ credit payments) | equal | used_amount=100, Σ=100 | no |
| Exactly one credit expense_payment row | 1 | 1 | no |
| Exactly one redemption ledger transaction | 1 | 1 | no |
| Expense not over-settled (Σ credit settled <= amount) | <= 100 | 100 | no |
| Supplier-credit ledger balance >= 0 | >= 0 | 0 | no |
| Global ledger imbalance == 0 | 0 | 0 | no |
| Counterparty reconciliation green | 0 mismatch / 0 error | mismatch=0, creditErrors=0 | no |

> Causality: the control isolates the only difference from the race — B acts on **fresh-pulled** state instead of a **stale** base. The control is healthy (single redemption, all green) while both races violate invariants ⇒ the race barrier + stale local state are the cause, not the fixture or a baked assertion.


---
## Risks / limits

- Drives public `syncNow` (push+pull fused); separate push/pull not exported. Both push orderings covered (server-order axis).
- Headless boundary: window/localStorage shimmed, sql.js wasm `?url` redirected to a node path, isTauri()=false. DB engine, schema, migrations, writer, ledger posting, sync push/pull/applyUpsert and reconciliation are the unmodified production modules via Vite SSR.
- Base fixture built via direct SQL; the concurrent business action runs only through the real writer. Starting-state equality is proven by normalized content hashes (not raw SQLite bytes — internal page layout may legitimately differ).
