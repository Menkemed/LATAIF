# LATAIF v0.8.98

Custom orders become a stock item and an invoice in one step and stay correctable after the invoice, order costs can be changed even when they are already paid, bulk metal lines take any tax scheme with the exact customer amount, and lists remember search, filters and position when you go back.

- **Custom orders — cost of the piece:**
  - Labour and material from a workshop become the cost of the piece, booked once when the work arrives, against the open supplier debt.
  - Gold owed to a workshop is kept in grams and with its value. It can be settled in BHD at a price per gram, fully or partly, also from the second computer. The difference goes to the cost of the piece; if the piece is already sold, the invoice line follows.
  - Own work or own gold without a workshop is not booked as cost. Such an order cannot be turned into an invoice or a stock item; the form warns when you enter it.
  - **Order source**, **Gold source** and **Add Cost** list only suppliers marked as workshop. Repairs and stones keep all active suppliers.
  - **Return gold** is only offered for gold the supplier owes you.
- **Custom orders — Create Invoice:**
  - One dialog for invoice date, tax scheme per line and number type; the customer price stays.
  - The piece becomes a stock item with its own SKU in its category (for example ITM-GLD-…), never ITM-GEN. The category must exist, be active and have an SKU code; otherwise nothing is created.
  - The item page shows its origin order and all its invoices.
  - Deposits are applied to the invoice instead of being booked again; the rest stays open. Cancelling the invoice gives the deposit back to the order, and converting again creates no duplicate.
- **Custom orders — after the invoice:** as long as the invoice can still be corrected (VAT quarter not filed), costs, gold and client can be corrected through the order, also for final and fully paid invoices.
  - The invoice line follows with the new cost and, for margin lines, the new margin VAT.
  - **Change client** moves invoice, order and deposits.
  - **Correct dates** fixes order date and completion date after Completed.
- **Order costs already paid — Change Cost and delete:**
  - Nothing paid: the open supplier debt follows the new amount.
  - Partly paid: the open debt becomes the new amount minus what was paid.
  - More paid than the new amount: you choose **supplier credit** (used later with this supplier) or **claim back**. A claim is recorded on the supplier page with **Record Repayment**, also partly.
  - Payments already made stay as they were.
  - An order with paid costs can no longer be deleted.
- **Bulk metal invoice lines:** tax scheme Auto, VAT 10 %, Zero-rated or Margin, freely selectable. The amount you enter for the customer stays exact to the fils with every scheme.
- **Lists:** search, filters, sort order and scroll position are kept when you go back, on the main and the second computer.
  - Search fields show the active search and have an × to clear it.
  - After deleting an entry you return to the list as you left it.

**Database:** the update adds fields for the value of gold owed and for the origin order of an item, and two tables: deposits applied to invoices, and gold debts settled in BHD. Existing invoices, payments, purchases, stock, bookings and media are not changed.

**Known open points, not fixed in this version:**

- Settling an order's gold debt with shop gold, or with gold the workshop holds for you, is not available yet; use the BHD settlement.
- A claim back against a supplier is shown on the supplier page only.
- Points listed as open in v0.8.97 stay open.

**Before you update:**

1. Check that **Unresolved saves** on the second computer is empty. Clarify open entries; do not remove them blindly.
2. Stop entering anything on the phone.
3. Close the second computer, then the main computer.
4. Make a full archive copy of both databases, the complete media folder (all files, no cleanup) and the key files, and check it.

**Update** the main computer first and the second computer straight after it. The new order functions and the new tables need v0.8.98 on both computers.
