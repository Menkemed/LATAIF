# LATAIF v0.8.91

Purchases, SKUs and order deposits — and two safety fixes for undoing purchases.

- **New purchase — several payments:** a purchase can be paid in several parts right when it is saved (cash, bank,
  Benefit), each with its own payment date (it cannot be before the purchase date or in the future). "Pay full" and
  "Credit (later)" stay. Main computer and second computer work the same.
- **SKUs:**
  - **Find Next SKU** in the item editor for an item that has no SKU yet: the next number from the central counter
    is shown and only taken when you save — a cancelled or refused save uses no number. An existing SKU is never
    replaced; a SKU you type yourself wins.
  - The "Will be assigned" preview is the same in New Purchase, New Collection, Consignment and Production — also on
    the second computer (the number comes from the main computer).
  - Orders do not use up a SKU. An order item gets its SKU when it really comes into stock (the purchase that
    receives it, or a cancelled custom order kept as stock). Production outputs and imported stock items without a
    SKU get the next one; old items are not renumbered.
- **Edit purchase — add and remove items:**
  - **Add item:** add a forgotten existing item or a new item (the same "New Item" form with photos and SKU) to a
    saved purchase. Total, open amount, supplier account, stock and accounting are corrected together.
  - **Remove item:** only a line whose pieces are all still untouched in stock (not sold, reserved, returned, on
    consignment, in production, written off or moved), never the last line (use Cancel Purchase for that). The item
    itself is removed only if this line created it and nothing else refers to it; otherwise only the line goes and
    its stock lot is cancelled. Payments stay; an overpayment becomes supplier credit.
  - Owner only, with a reason; every change is logged. The existing locks (opening cut-off date, VAT quarter,
    consignment, bulk metal, supplier return, partner lines) stay.
- **Correct item status when a purchase is undone:** if a purchase brought a previously sold item back into stock
  and that purchase line is removed, or the purchase is cancelled, the item gets its earlier status back (for
  example "sold") instead of "returned". If the item was on consignment or with an agent before, its earlier
  ownership is not recorded — such a removal or cancellation is now refused with a clear message instead of guessing.
- **Customer page — Order Deposits:** shows the deposits a customer has paid on orders that are not invoiced yet —
  per order with payment date, method and amount, and the open total. Deposits that were invoiced, refunded,
  credited or forfeited are not counted. Receivables and store credit stay separate.

**Before you update:** make a fresh backup of the main computer and check it.

**Update** the main computer and the second computer together. No new database table and no migration of existing
data; existing bookings are not changed by the update.
