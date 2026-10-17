# LATAIF v0.8.83

Stock corrections, opening balances and safer payments. Every new function records documents and quantities only —
opening bookings, debt waivers and the settlement of old advances stay locked until the accountant has confirmed the
rules.

- **Correct initial qty (Collection → item → Stock corrections, owner):** a quantity that was entered wrongly when the
  item was recorded (for example 5 instead of 3) can be corrected up or down. Only for an untouched own item: no sale,
  purchase, lot, offer, order, consignment, agent, repair, return, production or stock correction. Each correction is a
  numbered document with the quantity before and after, the reason, the owner and the time. Nothing is booked (no cash,
  no stock loss, no VAT). A correction is not cancelled — it is corrected again.
- **Remove from stock (owner):** lost, stolen, damaged or miscounted own pieces leave stock as a numbered document. An
  item with purchase lots books the stock loss from its lots; an item without lots changes only its quantity and is
  marked "accounting reconciliation pending". A removal can be cancelled with a reason.
- **Add old stock (owner):** more pieces of an item you already owned are recorded with their historical cost — a
  document, no money, no booking; the opening value waits for the accountant.
- **New Collection = old stock:** the desktop form no longer has "Paid from"; new items are stock you already own.
  Newly bought goods go through Purchase. The page "Old stock" shows a read-only opening preview.
- **Opening positions per customer and supplier (Customer Edit / Supplier Edit, owner):** old receivables, payables and
  advances from before 15.10.2026 are recorded as numbered opening documents (one old invoice with its reference or one
  summarised remainder). They are not booked, not part of the balances and not payable yet. LATAIF document numbers and
  double takeovers are refused.
- **Opening balance sheet (Settings → Opening Balances on the main computer; page "Opening balances" on both computers,
  owner only):** record the counted cash, bank and Benefit balance as of 15.10.2026, old loans, other assets and
  liabilities and opening VAT balances as drafts; see booked values next to recorded drafts, the provisional opening
  equity, a trial balance, a provisional balance sheet and every booking before the cutoff. Everything there is marked
  PROVISIONAL; nothing is booked. The old stock value shown is today's value, not verified for 15.10.2026.
- **Earlier opening in Settings:** the fields Opening Cash/Bank/Benefit (Tax / VAT) are now read-only. An opening that
  was already booked stays exactly as it is; the ledger backfill no longer books or changes it.
- **Receive Payment (customer):** one payment over the customer's open invoices, oldest first or allocated by hand,
  through the normal invoice payment (status, final number, card fee, VAT period lock).
- **Payment safety:** a double click pays once; a payment order is refused by the main computer if the open items
  changed since the window was opened (another payment, a second window or computer); a lost answer is retried with the
  same order and does not pay twice. Customer and supplier payments never overpay silently.
- **Second computer:** customer and supplier balances now come from the main computer (they showed 0.000 before); the
  owner can make stock corrections and record opening documents from the second computer as well.

Known limitations:

- Opening bookings, payments on opening positions, the settlement or refund of old advances, debt waivers, discounts and
  write-offs are not available yet — they wait for the accountant's answers.
- The old stock opening value is a preview. Card clearing has no recorded statement balance as of 15.10.2026 and is
  shown as an open point.

The update adds new tables only (stock corrections and opening documents); existing data is not changed. Make a backup
first, then update the main computer and right after it the second computer. While the versions differ, do not make
payments or stock changes: the main computer refuses the new commands of a newer second computer. No ledger backfill is
needed.
