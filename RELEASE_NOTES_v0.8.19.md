# LATAIF v0.8.19

A focused **report & export correctness patch**: sales reports now recognize an effective
return as soon as it takes economic effect (not only once the refund is paid out), and the NBR
VAT export no longer understates the standard-rated net amount for line items with a quantity
greater than one. Stored invoices, VAT snapshots, the ledger and the return/credit-note domain
logic are **unchanged**. This release performs **no** data migration and touches **no**
production data on its own.

## Sales Metrics — Return Recognition
- **Effective returns are recognized before the refund is paid out**: a return counts as soon as
  its credit note exists (status **APPROVED**, **REFUNDED** or **CLOSED**), not only after the
  cash refund is settled.
- **The deduction uses the full return amount** (`totalAmount`), so revenue and profit are
  reduced by the amount actually owed back.
- **The later refund payment does not reduce revenue and profit a second time** — paying the
  refund is a cash settlement, not another sales reduction.
- **REQUESTED and REJECTED returns are excluded**: a request without a credit note, or a
  cancelled/reverted return, never reduces reported revenue.
- **Invoice-period semantics are retained**: an effective return restates the period of its
  **original invoice**, independent of the request, approval or refund-payment date.
- **Cross-period returns no longer vanish** from monthly reports — a return on a prior-month
  invoice is applied to that invoice's month instead of disappearing.

## NBR VAT Export — Quantity Net Totals
- **Fixes understated standard-rated net amounts for a quantity greater than one**: the exported
  net was previously the per-unit net while VAT and gross covered the whole line.
- **The net line amount now uses the persisted line gross minus the line VAT**
  (`Net Line Amount = lineTotal − vatAmount`), so quantity 2 or 3 is no longer exported like
  quantity 1.
- **Custom / rounded line totals remain canonical**: the export follows the stored, editable line
  total rather than recomputing from unit price × quantity.
- **The UI summary and the XLSX export use the same net basis**, so the on-screen total and the
  spreadsheet agree.
- **Zero-rated and margin-scheme logic are unchanged** — only the standard-rated net calculation
  was corrected.

## Not Included / Safety Notes
- **No** database migration.
- **No** stored invoice or VAT schema change.
- **No** ledger posting change.
- **No** return-domain change.
- v0.8.19 is a **report- and export-correctness patch** on top of v0.8.18.
