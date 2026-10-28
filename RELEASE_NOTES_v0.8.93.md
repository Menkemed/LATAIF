# LATAIF v0.8.93

Consignment sales with a selectable tax scheme, one payout purchase per consignor, and a stricter VAT period lock.

- **Consignment — tax scheme per item:** in **Record Sale** each item has a **TAX SCHEME** choice (Margin, VAT 10 %,
  Zero-rated). It starts with the item's own scheme. The item itself is not changed.
- **Consignment — correcting the tax scheme later:** **Edit Invoice** on a consignment invoice now allows changing the
  tax scheme of the lines. Item, quantity, buyer, date and the price incl. VAT must stay as they are (for VAT 10 %
  enter the net price). VAT, revenue and the bookings are corrected automatically; payments are not touched.
- **Consignment — consignor purchase VAT is separate:** the VAT of the consignor's payout purchase is no longer
  copied from the sales invoice. Default is **No VAT** (private / not VAT-registered); **VAT 10 %** only when you
  choose it because the consignor issues a VAT invoice. The payout stays the amount incl. VAT, and Record Sale never
  pays out by itself.
- **Consignment — one purchase per consignor:** several items of the same consignor sold together go into ONE
  purchase with one line per item. Items of different consignors still get separate purchases. A return after the
  sale affects only that item's line; Cancel Sale undoes a shared purchase exactly once. Existing purchases are not
  regrouped.
- **VAT period lock:**
  - **New invoices** with an invoice date in a quarter that is already marked as VAT filed or VAT paid are refused
    (choose a date in an open quarter). This applies to every way an invoice is created: new invoice, offer, order,
    repair, agent and consignment sale — on the main computer and the second computer. Nothing is saved and no
    invoice number is used.
  - **Edit Invoice** on an invoice dated in a filed or VAT-paid quarter (but paid in full later) books the correction
    today, so the bookings of the closed quarter stay exactly as they were.
  - Existing invoices are not changed.

**Database:** the update adds one column to purchase lines (link to the consignment item). The migration runs by
itself at the first start and does not change existing purchases, invoices, consignments, payments or bookings.

**Before you update:** make a fresh backup of the main computer and check it. In addition, keep a full archive copy
of both databases and the complete media folder (the app backup contains only photos that are still in use).

**Update** the main computer and the second computer together.

**After the update:** a consignment invoice recorded with the wrong tax scheme can be corrected with **Edit Invoice**
→ tax scheme (the amount the buyer paid stays the same).
