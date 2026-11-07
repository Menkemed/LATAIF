# LATAIF v0.8.99

One invoice can now carry own stock and consignment items together, invoices with consignment items can be corrected, a consignment can take in several identical pieces and sell them piece by piece, and the margin VAT is the same number on the invoice, in the ledger, in the NBR export and in the reports.

- **Mixed invoice (Direct Sale, section 2b; admin and manager):**
  - Own items and consignment items on one customer invoice. Each consignment item stays a full consignment sale: purchase from the consignor (one purchase per consignor), payout, commission and, below the floor, the consignor loss.
  - Tax scheme per consignment line: Margin, VAT 10 % or Zero-rated. The VAT of the consignor's purchase must be chosen for every consignor: No VAT or VAT 10 %. Nothing is preselected.
  - If VAT 10 % makes the LATAIF result of a consignment line negative, the sale is only booked after you confirm it on that line. This applies on the invoice, in Record Sale and on the phone, on both computers.
- **Correcting an invoice with consignment items:** change price and tax scheme, remove a line entered by mistake (the consignment goes back to Active), add a line.
  - The consignor's purchase follows.
  - If the consignor was already paid more than he is now owed, you choose **supplier credit** or **claim back**. The same choice applies to an overpaid consignor loss.
  - Payments already made stay as they were.
- **Consignment quantities:**
  - Take in 1–50 identical pieces as one group, with the agreed price and minimum per piece. Each piece gets its own SKU.
  - Sell any number of pieces (Record Sale, invoice, phone).
  - List and detail show the rest and the status of each piece.
- **Margin VAT, one rule:** margin VAT = (sale price − actual purchase) × 10/110, rounded to the fils. A negative margin gives 0.
  - **Consignment:** the payout to the consignor (the sale price if sold below the floor). Before, the cost estimated at intake was sometimes used: for example 36.364 instead of 21.818 on 1,200 with a payout of 960.
  - **Purchase with deductible 10 % input VAT:** the net purchase price. The input VAT is booked separately.
  - **Purchase without deductible VAT:** the price actually paid.
  - Invoice, ledger, NBR export, VAT overview and reports now show the same margin VAT for every line. Existing invoices are not changed.
- **Fixes:**
  - **Finance → Total VAT** counted the margin VAT twice.
  - **Edit invoice:** own items that are already sold show their name instead of "Pick product…".
  - **Second computer:** the **Unresolved saves** bar no longer covers buttons and can be collapsed. Open entries stay until they are clarified.

**Database:** the first start adds three empty fields and an index to the consignments, for the group of a piece. Existing invoices, payments, purchases, stock, bookings and media are not changed.

**Known limits:** LATAIF does not check whether an item may be sold under the margin scheme (NBR approval, precious metals, stones, pearls, jewellery). Choosing **Margin** is your decision.

**Before you update:**

1. Check that **Unresolved saves** on the second computer is empty. Clarify open entries; do not remove them blindly.
2. Stop entering anything on the phone.
3. Close the second computer, then the main computer.
4. Make a full archive copy of both databases, the complete media folder (all files, no cleanup) and the key files, and check it.

**Update** the main computer first and the second computer straight after it. Mixed invoices, consignment quantities and the new consignment fields need v0.8.99 on both computers. A second computer that is still on an older version gets a clear refusal for these sales, and nothing is booked.
