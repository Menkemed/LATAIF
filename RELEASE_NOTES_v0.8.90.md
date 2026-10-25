# LATAIF v0.8.90

A fix for card fees, and a repair for card fees that were booked wrongly.

- **Editing a card fee:** changing the date or the amount of an automatic card fee in **Expenses → Edit** booked
  it as an open payable instead of against Card Clearing. The expense itself, the profit report and Banking were
  right, but the ledger showed a payable without a supplier and too much in Card Clearing. Now the fee is booked
  against Card Clearing again; a changed amount stays fully paid. The category and the payment method of an
  automatic card fee can no longer be changed, and a card fee is not dated into or out of a filed (or paid) VAT
  quarter. Other expenses are not affected.
- **Repair (Settings → Data Repairs → "Card fees booked as payables after an edit"):** lists only card fees where
  the app's own records prove the wrong booking. Cases the accountant has to decide (a filed VAT quarter, or a
  payment recorded against the payable) are shown with their reason and are not repaired. The repair is started
  only by the owner, with a reason and a confirmation; the wrong booking is reversed and the right one booked on
  the same day, everything is logged, nothing is deleted, and the expense itself does not change. Afterwards the
  reconciliation shows no difference for payables, and Banking matches the ledger.
- **Main computer and second computer:** the same fix on both; the repair runs on the main computer only.

**Before you update:** make a fresh backup of the main computer and check it.

**After the update:** open Settings → Data Repairs, check the list, enter a reason and press **Re-book card fees**
once. Until the update is installed, please do not edit automatic card fees.

**Update** the main computer and the second computer together. No new database table; existing bookings are not
changed by the update itself — only by the repair you start.
