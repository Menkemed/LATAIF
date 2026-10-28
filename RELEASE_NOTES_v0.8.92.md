# LATAIF v0.8.92

Consignment sales of several items, later consignor repayments, gallery photos for mobile repairs and a workshop-only
selection in repairs.

- **Consignment — several items in one sale:** select several consignment items (also from different consignors)
  and record ONE sale: one invoice with one line per item, the sale date as invoice date, and payments (cash, bank,
  Benefit, card — split and partial payments allowed) entered right away. Each consignor gets his own payout
  purchase as before. "+ New Client" is offered for the buyer on the consignment detail page too. Cancel Sale
  undoes the whole invoice.
- **Consignment — item returned after the consignor was paid:** you choose what happens with the payout:
  - **Received:** the consignor paid it back now (cash, bank or Benefit) — booked as real money received.
  - **Pending:** the amount stays open as a claim against the consignor (supplier credit). No money is invented.
- **Consignment — later repayments:** on the consignment page, **Record Repayment** books each amount the consignor
  actually pays back later — with date, method (cash, bank, Benefit) and an optional reference. Part payments are
  fine; the rest stays open until it is zero. The open claim can also be offset against a later payout. Every
  receipt is listed on the page. Main computer and second computer work the same.
- **Mobile repair — photos from the gallery:** next to **Take photo** there is **Choose from gallery** (several at
  once), also for the customer's ID photo. Same size and upload rules as before; a photo picked twice is added only
  once; up to 6 per repair; single photos can be removed before saving. Saved photos are never replaced. If the
  upload fails, nothing is saved and the photos stay for the next try.
- **Repair — workshop selection:**
  - New checkbox **Is Workshop** under Suppliers → Edit (and New Supplier). It only classifies the supplier;
    purchases, payments and bookings are not changed.
  - Repair → workshop (new repair, edit repair), **Add Work Line** (besides the own workshop) and **gold from the
    workshop** offer only active suppliers marked as workshop — on the main computer, the second computer and the
    phone. **Materials / spare parts** still offer all active suppliers.
  - A workshop already saved on a repair stays visible and assigned, even if it is unmarked or deactivated later.
  - "+ New Supplier" inside the workshop selection ticks **Is Workshop** by default (you can untick it).
  - The supplier list suggests suppliers that already worked as a workshop in earlier repairs. Nothing is marked
    automatically — after the update no supplier is a workshop until you mark your real workshops.

**Database:** the update adds one table (consignor repayment receipts) and one supplier column (Is Workshop). The
migration runs by itself at the first start; it does not change existing purchases, invoices, repairs, consignments,
payments or bookings, and no existing supplier is marked as workshop.

**Before you update:** make a fresh backup of the main computer and check it. In addition, keep a full archive copy
of both databases and the complete media folder (the app backup contains only photos that are still in use).

**Update** the main computer and the second computer together.
