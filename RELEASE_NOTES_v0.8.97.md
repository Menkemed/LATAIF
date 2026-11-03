# LATAIF v0.8.97

Corrected invoices stay right in every period, stock bought again for an item you already had adds up, repairs can be moved to the right client, and the phone picks the repair category.

- **Stock — buying an item you already have:** items recorded as old stock (New Collection, Excel import, "Add old stock") keep their quantity when the same item is bought again. Until v0.8.96 the first purchase replaced the old quantity (2 old + 4 bought showed 4). The old pieces now stay as their own lot with their old cost, the new ones get the purchase cost, and selling takes the old ones first. Nothing is booked for the old stock.
- **Invoice corrections:**
  - Changing the tax scheme of a line (VAT 10 %, Zero-rated, Margin) keeps the customer price including VAT.
  - If a correction leaves the client overpaid, you choose **customer credit** or **refund**. A refund is owed until it is paid out; **Record refund** pays it out later in cash, bank or Benefit, also partly.
  - A line with returned pieces: only the pieces not returned can be corrected; the returned ones keep their price and tax.
  - Corrections are booked on the day they belong to. In a closed VAT quarter and before the opening date only the note and the staff member can be changed.
  - Saving a correction is all or nothing: if any part fails, nothing is saved.
- **Repairs:**
  - **New Repair** starts with 0 % VAT; 10 % stays selectable.
  - The repair page shows the item photo large and the voucher code compact.
  - **Change customer** (owner and manager): moves a repair booked on the wrong client to the right one, with a reason. Number, details, photos, history and status stay. Not possible once the repair is invoiced, paid, or a gold credit came from it.
- **Phone — repair intake:** a **Category** field (Watch, Gold-Diamond Jewellery, Branded Gold Jewelry, …). **AI Identify** fills it only when it clearly recognises one of your categories; a category you chose yourself is never overwritten.
- **Consignment — one purchase for several items of the same consignor:** such purchases are no longer assigned to a single item when the app starts. Until v0.8.96 every start could attach the whole purchase to one of the items, so the other item lost its payout and repayment view.

**Database:** the update adds one table for refund payouts to clients. The start check that fills the consignment of older consignor purchases now only fills a purchase that belongs to exactly one consignment. Existing invoices, payments, purchases, stock lots, bookings, repairs and media are not changed.

**Known open points, not fixed in this version:**

- Items whose old stock was already replaced before this update keep their wrong quantity until they are corrected separately.
- One invoice with your own items and consignment items together is not available yet.
- Points listed as open in v0.8.96 stay open.

**Before you update:**

1. Check that **Unresolved saves** on the second computer is empty. Clarify open entries; do not remove them blindly.
2. Stop entering anything on the phone.
3. Close the second computer, then the main computer.
4. Make a full archive copy of both databases, the complete media folder (all files, no cleanup) and the key files, and check it.

**Update** the main computer first and the second computer straight after it. A new second computer cannot save the new invoice and repair fields to an old main computer, and an old second computer cannot finish an invoice correction that needs the new credit-or-refund choice. The phone gets the new repair page from the main computer.
