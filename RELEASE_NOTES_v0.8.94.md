# LATAIF v0.8.94

Repairs: reopen, quick edit, status from the list and the real pickup date. Purchases: correct the date of a payment.

- **Repair list — tax scheme when invoicing:** creating an invoice from the repair list (single repair or **Create
  Combined Invoice**) now asks for the tax scheme (0 % / VAT 10 %), preset with the repair's own scheme. When the
  selected repairs have different schemes, **As set on each repair** is offered and preset.
- **Repair — status from the list and Quick Edit:** **Quick Edit** in the repair list changes the status, the
  estimated and actual cost and the charge to the client, and adds or edits work and material lines — without
  opening the repair. Every status step is checked on the main computer and written to the audit log.
  - The charge of a repair that is already invoiced cannot be changed; the workshop of a booked cost line is locked.
- **Repair — real pickup date:** when marking a repair as picked up you can enter the day the customer actually
  collected it. The invoice created afterwards uses that day as its invoice date (several repairs with different
  pickup days ask for a date). Pickup in a quarter that is already VAT filed is recorded, but the invoice on that day
  is refused and the message says so.
- **Repair — Returned and Reopen:** a repair set to **Returned** remembers where it came from; **Reopen** brings it
  back to that status (with an invoice only to *ready*). Reopening and picking up again never creates a second
  invoice.
- **Mobile repair:** pickup date field, optional invoice date, **Reopen as …**, and **Returned** needs a second tap.
- **Purchase — Edit payment date (owner only):** each payment on a purchase has **Edit date**. It is the same
  payment with the correct day: the old booking is reversed today and booked again on the new day; paid amount,
  remaining amount and status stay the same. A reason is required and the change appears in the purchase history and
  the audit log. Not possible in a VAT filed or VAT-paid quarter, before the purchase date, in the future, for
  voided payments or supplier-credit applications, and on cancelled or consignment purchases.
- **Mobile purchase:** **Purchase date** is now the last section, right before **Book purchase**; the tax section is
  called **Input VAT**.

**Database:** the update adds three columns to repairs (pickup recorded at, returned from, returned at). The migration
runs by itself at the first start and does not change existing repairs, repair lines, invoices, payments, purchases,
bookings or media.

**Before you update:** make a fresh backup of the main computer and check it. In addition, keep a full archive copy
of both databases and the complete media folder (all files, no cleanup — the app backup contains only photos that are
still in use).

**Update** the main computer and the second computer together.
