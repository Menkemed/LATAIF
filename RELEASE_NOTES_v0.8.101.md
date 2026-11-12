# LATAIF v0.8.101

Items bought together with a partner: costs, VAT and repairs are shared by the agreed percentages. A partner can pay the workshop directly, and partner balances can be settled in Settle Balance. Supplier returns can include repair costs and book a loss when the supplier refunds less. A booked return can be cancelled, either as an entry error or after the refund was really paid back.

- **Items bought with a partner:**
  - **VAT_10 purchases:** the cost of a joint item is the net amount. A partner may pay his gross share; the VAT he paid in advance counts in his favour. On a supplier return he gets back what he actually paid.
  - **Repairs, polishing and workshop gold** on a joint item that is not sold yet are added to its cost and shared by the percentages.
  - **Partner paid directly:** a partner can pay the workshop in full or in part. It counts as his contribution; LATAIF books no money for it. A partial payment can be reversed.
  - **What a partner is owed** now always matches the books. Workshop lines of a running repair already count. Takeover, partner change and supplier return wait until the repair is Ready.
  - **Repairs:** a sold item cannot get an own repair. When own and joint pieces share a lot, the lot must be chosen.
  - **Partner money needs the payment right** (manager, accountant, owner/admin) on both computers. This covers contributions, repayments, payouts and their reversal, plus Invest, Withdraw and Profit Share.
- **Settle Balance with partners** (the partner must be linked to the client):
  - **A partner balance** that LATAIF owes can pay the client's open invoices.
  - **A booked partner debt** (the partner was paid too much) can be settled against the client's store credit, loans "We Borrowed" and open purchases of the linked supplier role.
    - Store credit can be used in part; the rest stays available.
    - Only booked amounts are offered, never a cost share that is only calculated.
  - Everything is booked under one settlement number (STL-…) and no money moves. Undo one line or the whole STL.
- **Supplier returns:**
  - **Return price:** at most the purchase price.
  - **Added costs refunded:** a new field for what the supplier pays back for repairs and other added costs on top of the return price. It is at most the added costs of the returned pieces, and no VAT is added.
  - **Loss:** what the supplier does not refund of the book value is booked as an inventory loss, so nothing is left as stock value. This also applies to returns below the purchase price.
  - **Refused:** a refund above the book value. Nothing is booked.
  - **Joint items:** the partner carries his share of the loss.
  - **Cancel return** (owner/admin): one booked return is cancelled; the purchase stays.
    - The items come back at the value they left with. A loss booked with the return is reversed, and partner shares and purchase amounts are restored.
    - **Entry error:** the return was recorded by mistake and the supplier refunded nothing. The booked refund is corrected and no money is paid. Banking shows neither the refund nor a repayment.
    - **Return undone:** the supplier really paid money back. It is repaid only with a confirmation and a reference (bank transfer or receipt). Banking shows the refund and the repayment.
    - Not possible, with the open amount shown, when:
      - credit from the return was already used;
      - a partner was paid or settled after the return;
      - the stock cost changed since;
      - the return belongs to a consignment;
      - today's VAT quarter is already filed.
- **Display:**
  - A purchase offset is no longer shown as a loan.
  - Counter documents and the payment way are shown clearly.
  - The printed invoice shows "Offset".

**Database:** the first start adds one new table (store credit settled against partner debts) with an index, and nine empty fields to supplier returns and their lines. Existing invoices, payments, purchases, returns, stock, bookings and media are not changed. Older returns of an item with repair costs cannot be cancelled automatically, because their value at the time of return was not recorded. Check them with the accountant.

**Known limits:**
- **Sales users and money:** a sales user can still record money in places that were already open before this version: a payment when creating an invoice, a refund when creating a return, loans, tax, banking transfers, scrap and metal trades, production costs, and the refund of a supplier return.
- **Supplier returns:**
  - A gain (a refund above the book value) has no account and is refused.
  - VAT on refunded added costs is not calculated.
  - When a return is cancelled, its unused supplier credit is removed; its bookings remain.
- **Partners:** production with a joint item and correcting a joint purchase line stay blocked.

**Before you update the main computer:**

1. Stop entering anything on the phone.
2. Close the main computer. Keep the second computer closed.
3. Make a full archive copy of both databases, the complete media folder (all files, no cleanup) and the key files, and check it.

**Update** the main computer (from v0.8.100). The second computer may stay on its older version (for example v0.8.97) as long as it is not used; keep it closed.

Before the second computer is used again:
- Check **Unresolved saves** on it. Clarify open entries; do not remove them blindly. Partner money that a sales user entered there is refused by v0.8.101.
- Then update it to v0.8.101.

Cancel return, Partner paid directly and Settle Balance with partners need v0.8.101 on both computers. A second computer on an older version does not offer them.
