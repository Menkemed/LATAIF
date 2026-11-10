# LATAIF v0.8.100

One account per client: what the client owes LATAIF and what LATAIF owes the client, side by side, with a running statement. Open invoices can be settled against store credit, loans and open purchases of the same person in one step, without moving money. Payments now need the payment right everywhere they are booked.

- **Client account** (button **Account** on the client):
  - What the client owes us and what we owe the client, the net balance (free and tied), gold in grams separately, and a statement with a running balance and links to every document.
  - Only explicitly linked items count: the client's own invoices, loans and credits, the supplier role and the partner linked to this client. Same name or phone only gives a hint; the balance is then marked incomplete.
  - **Link to client** on a partner and on a loan (with confirmation). At most one partner per client and branch.
- **Settle Balance** (invoice, purchase and client account; one dialog, no money moves):
  - Left: the client's open invoices, oldest first. Right: what we owe, in this order: 1. store credit, 2. loans "We Borrowed", 3. open purchases of the linked supplier role (normal and consignment, marked).
  - The app proposes the amounts. Tick and untick items, or use **Change amount** on a line to offset a full or a partial amount (BHD, three decimals, never more than the open rest of either side). Every remaining amount is calculated again at once.
  - Opened from a purchase, only that purchase is selected; opened from an invoice, only that invoice.
  - Everything is booked together under one settlement number (STL-…). If anything changed in the meantime, nothing is booked and the proposal is shown again.
  - Each invoice, loan and purchase shows the offset with the counter document and "no cash". Undo one line on the invoice (**Remove offset**) or the whole STL in the client account.
  - Invoice status and final numbers follow the same rules as any payment. A purchase becomes Paid or Partially paid; the purchase receipt shows "Settled by offset" and "Remaining after offset".
  - While an offset is active, the linked documents cannot be changed in a way that would break it (cancel, return, supplier change, Cancel Sale, Return after sale, mixed-invoice correction). Remove the offset first.
- **Payments need the payment right** (manager, accountant, owner/admin; not sales):
  - Purchase and supplier payments, applying supplier credit, **Refund Credit** and **Record Repayment** from a supplier, expense payments, **Pay now** / **Partial payment** when creating an expense, a recurring expense that pays every month, and a payment entered when creating a purchase.
  - Without the right, the screens show no payment buttons; purchases and expenses are saved unpaid. The same rule applies on the second computer.
- **Fixes:**
  - **Removing the last payment** of an issued invoice no longer turns it into a draft; it stays open with its final number.
  - **Returns:** a return of a cancelled invoice cannot be cancelled; an invoice with a pending return cannot be cancelled; a credit note from a return is only removed through Cancel Return. Independent old credit notes: delete only as owner/admin.
  - **Return of an invoice paid with store credit:** "Store Credit" is suggested as the refund.
  - **Analytics:** loans given and taken are counted by their direction in both spellings.
  - **Unknown payment methods** are never booked as bank by accident: such a purchase, expense or new invoice payment is refused; old entries without a known method are reported, not booked, by the ledger repair tool. **Other** on an invoice is still booked to Bank and is now shown as "Other · booked to Bank".
  - **Record Repayment:** the latest date the screen offers (today in Bahrain after midnight) is no longer refused as "in the future".
  - **Changing the supplier of a repair** keeps each expense payment on the cash, bank or Benefit account it was booked to.

**Database:** the first start adds one empty field and an index to partners, and one new table for offsets with its indexes. Existing invoices, payments, purchases, stock, bookings and media are not changed.

**Known limits:** a sales user can still record money in places that were already open before this version (payment when creating an invoice, refund when creating a return, loans, partners, tax, banking transfers, scrap and metal trades, partner items, production costs). The owner decides separately whether these are restricted too.

**Before you update:**

1. Check that **Unresolved saves** on the second computer is empty. Clarify open entries; do not remove them blindly. Payments that a sales user entered there are refused after the update.
2. Stop entering anything on the phone.
3. Close the second computer, then the main computer.
4. Make a full archive copy of both databases, the complete media folder (all files, no cleanup) and the key files, and check it.

**Update** the main computer first and the second computer straight after it. Settle Balance and Change amount need v0.8.100 on both computers. A second computer that is still on an older version does not offer them and books nothing.
