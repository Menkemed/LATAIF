# LATAIF v0.8.88

This update brings invoice payments with their own payment date, the debit card with its own fee, and several
payments when an invoice is created. It also contains the purchase corrections that were prepared as v0.8.87 and
never published — updating from v0.8.86 brings both.

## Invoice payments

- **Payment date:** when you create an invoice, each payment gets the invoice date as its payment date. You can
  change it per payment (not before the invoice date, not in the future). Payment lists, Banking, the booking and
  the card fee use this date; the time it was entered is kept for the audit trail. Payments that already exist
  are not changed.
- **Debit card:** a new card type next to Normal (Visa / MC) and Amex — on invoices, orders, repairs and customer
  settlement. It has its own fee in **Settings → Tax / VAT → Card Processing Fee**. There is no built-in debit
  rate and no fallback to the normal rate: until you enter one (0 % is allowed), a debit card payment is refused
  with a clear message and nothing is booked. Once set, the debit rate cannot be emptied again (enter 0 for no
  fee). The fee is calculated and stored with each payment; changing a rate later does not change fees already
  booked, and existing card payments stay as they were.
- **Several payments when creating an invoice:** **Add Payment** adds a row, each row can be removed. Every row
  has its method (cash, bank transfer, card Normal / Amex / Debit, Benefit), amount and payment date. Paid and
  remaining are shown live, the card fee per row. A partial payment is fine; paying more than the total is
  refused. The invoice and all its payments are saved together or not at all — a double click or saving again
  after a lost connection does not book anything twice.
- **Filed VAT quarters stay closed:** a payment completing an invoice in a filed (or paid) VAT quarter was
  already refused. Now also a **partial** payment dated in a filed quarter is refused — when creating an invoice
  and when changing the date of a payment (into or out of a filed quarter). Choose a payment date in an open
  quarter. The NBR export rules are unchanged: an invoice is reported in the month of its full payment.
- **Main computer and second computer:** everything works the same on both; a refusal (filed VAT quarter, debit
  fee not set) comes back as a final answer with its message.

## Purchase corrections (prepared as v0.8.87, first published with this update)

Purchases can now be corrected after they were recorded — also when they are paid or the goods are already
sold — without rewriting invoices, filed VAT returns or the booking history.

- **Edit a purchase:** Purchases → open a purchase → **Edit**. Correct the purchase date, the supplier, unit
  prices and quantities, notes and staff, and replace the supplier's ID photo (camera or file). Every edit needs
  a reason and is logged with the values before and after. Purchase number, documents, payments and history stay.
  The page shows what saving will do before you save, and why a field is locked.
- **Price corrections on sold items:** if a piece of the purchase is already sold, its invoice is **not**
  changed. A separate cost correction document (`CC-…`) corrects stock value and cost of goods sold. It is booked
  on the day of the correction; the profit report counts it in the month of the sale (no profit counted twice).
  A possible VAT effect is only marked **"VAT to review"** — nothing goes into a VAT return or the NBR export
  automatically, and filed VAT periods stay unchanged.
- **Reconciliation:** Reconciliation now lists the cost corrections per month — booked in the ledger versus
  attributed in the profit report; over all months the difference is zero. It covers the cost corrections only;
  it is not a full reconciliation of ledger and profit report.
- **Supplier corrected on a paid purchase:** you confirm that the recorded payments really went to the new
  supplier; the payable and the payments move with the purchase. The old supplier's details stay hidden with the
  purchase. If a correction brings the total below what was paid, the difference becomes supplier credit.
- **Void a wrong payment (owner):** a wrongly recorded purchase payment stays visible as voided, its booking is
  reversed on the day of the void, and a supplier credit it used is given back. Record the correct payment
  afterwards.
- **Items stay one record — in Collections too:** "Edit item" opens the same item as Collections — brand,
  model, attributes (weight, karat, stones), condition, notes and photos. Photos can be added from a file or the
  camera, removed, and now also **replaced in place** (a new main photo stays the main photo). The purchase price
  and purchase date of an item created by a purchase are corrected through the purchase only (locked on the item
  page); sale prices are never changed by a purchase correction. For an item bought more than once, only the
  stock lot of the corrected purchase changes.
- **Sold items keep their invoice text:** changing what an invoice prints (brand, model, description,
  attributes) of an item that is already on an invoice needs a reason; reprints of the invoice keep what was
  printed at the sale.
- **ID photo:** only the current photo is shown. The replaced photo is kept hidden as the original record (KYC
  record keeping) and stays in every backup. Other purchases keep their own photo; the person's own ID document
  changes only if you tick it.
- **Main computer and second computer:** everything works the same on both. An edit made in the meantime on the
  other computer is refused ("this purchase changed since you opened it") instead of being overwritten, and
  saving again after a lost answer does not apply anything twice. Price, quantity, date, supplier and payment
  voids: owner only. Notes, staff and the ID photo: anyone who works with purchases.
- **Fixes:** the input VAT of a re-booked purchase line was counted twice by a later supplier return; cancelling
  a purchase now checks every use of its stock (agent sale, production, stock adjustment, repair cost);
  consignment payout purchases keep their consignment link in its own field (existing ones are linked once from
  their note, only when the match is unique); a failed booking while recording a purchase is no longer skipped
  silently.

**Still locked until the accountant decides:**
- a later discount from the supplier (only "the price was entered wrongly" can be corrected);
- purchases and sales before the opening cut-off date 15.10.2026;
- purchases with 10% input VAT in an earlier or a filed VAT quarter;
- purchases with a supplier return, consignment purchases, partner (joint) purchase lines, bulk metal, and
  goods with an agent, in production or with a stock adjustment;
- the VAT treatment of corrections marked "VAT to review".

**After the update:** enter your debit card fee in Settings → Tax / VAT before the first debit card payment.

**Before you update:** make a fresh backup of the main computer and check it.

**Update** the main computer and the second computer together. The database gets two new tables (purchase edits,
cost corrections) and six new fields from the purchase corrections; the invoice payment changes need no new
table. Existing purchases, payments, items, photos and bookings are not changed. No ledger backfill is needed.
