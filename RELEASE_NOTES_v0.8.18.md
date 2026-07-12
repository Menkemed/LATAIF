# LATAIF v0.8.18

A focused **bug-fix patch**: it makes editing an overpaid invoice safe against double customer
credit, and makes the mandatory edit-reason field on the invoice-edit screen actually visible.
Accounting logic, VAT, payments and the ledger are otherwise unchanged. This release performs
**no** data migration and touches **no** production data on its own.

## Credit / Overpayment Safety
- **No more double customer credit** when editing an invoice that was overpaid: a previously
  recorded overpayment credit is no longer counted a second time.
- **editInvoice books only the additional credit delta** on top of the existing (unused)
  overpayment credit — repeated edits of the same invoice stay **idempotent**.
- **Used overpayment credits block the edit** instead of being silently duplicated or reduced.
- **Credit shrink is blocked safely**: an edit that would shrink an existing (unused) overpayment
  credit below its amount is rejected rather than corrupting the ledger.
- **deleteCreditNote removes the unused customer-credit rows** it created, so no redeemable
  phantom credit is left behind after the ledger is reversed.
- **Used credit-note credits block the delete** (already-redeemed store credit is never lost).
- **Result:** no phantom accounts-receivable and no phantom customer credit after invoice edits
  or credit-note deletions.

## Invoice Edit — Reason Field
- The mandatory **"Reason for edit"** field is now **visible**, placed **after Notes and directly
  before the Summary / Save** area (previously it sat hidden inside the payment card, so the
  validation error appeared with no field in sight).
- The validation error is shown **inline, right at the field**, not isolated below the summary.
- **Notes** and **Edit Reason** remain **separate** fields — a note never satisfies the reason
  requirement, and an empty or whitespace-only reason still blocks saving.
- **New invoices are unaffected** — the edit-reason requirement applies only in edit mode.

## Not Included / Safety Notes
- **No** automatic sync-database migration.
- **No** real production database migration or compaction.
- **No** real production Excel import.
- v0.8.18 is a **bug-fix-only** patch on top of v0.8.17.
