# LATAIF v0.8.20

A focused **order-conversion integrity patch**: converting an order into its final invoice is now
a single atomic operation (all-or-nothing), and a product that is physically out with an agent can
no longer be sold through the normal invoice paths. Stored invoices, VAT snapshots, the ledger and
the return/credit-note domain logic are **unchanged**. This release performs **no** data migration
and touches **no** production data on its own.

## Order → Invoice — Atomic Conversion
- **The whole conversion runs in one transaction**: billable-check → invoice creation → order-line
  marking → order link either fully succeeds or is **fully rolled back**.
- **A failure after the invoice is created discards everything** — the invoice, its ledger
  postings, the stock consumption and the line marking are all rolled back, so no half-finished
  invoice remains.
- **A retry creates exactly one invoice**, including for **lot-less line items** that the stock
  guard alone could not protect — this closes a double-invoice gap.
- **Both the modern (persisted-scheme) and legacy order-conversion paths** use the same atomic
  orchestration.

## With-Agent Stock Guard
- **A product that is out with an agent (`with_agent` / `given_to_agent`) can no longer be invoiced
  through the normal paths** — Direct Invoice, Order conversion (modern & legacy), Offer
  conversion and Invoice Edit all enforce the guard.
- **This prevents a double-sale**: the same piece being sold in the shop while it is still out with
  an agent.
- **The legitimate agent-settlement path is unaffected** — the canonical agent-transfer conversion
  remains the one path that may invoice a with-agent piece.
- **The guard only blocks; it makes no automatic status change** — an agent piece must first be
  returned through the existing agent-return process.

## Not Included / Safety Notes
- **No** database migration.
- **No** stored invoice or VAT schema change.
- **No** ledger posting rule change.
- **No** change to reports, the NBR export, returns, credit notes or repairs.
- v0.8.20 is an **order-conversion integrity patch** on top of v0.8.19.
