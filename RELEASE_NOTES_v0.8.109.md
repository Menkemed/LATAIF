# LATAIF v0.8.109

This version lets every database set its own accounting opening date, adds an administrator correction for the date of a final invoice, books changes to repair costs on their original day, shows the invoice list in the order of the dates it shows, and makes "Reclaim free space" check its result before it is used. **Installing the update deletes nothing and changes no invoice, payment, booking or stock.**

- **Accounting opening date per database** (Settings → Accounting): the booking cut-off is no longer fixed to 15 October 2026. Each database stores its own date.
  - Without an entry, 15 October 2026 stays in force, so an existing installation behaves exactly as before.
  - Any administrator can change it, only on the main computer: choose the date, "Check", then "Save". Every change is recorded (user, time, old and new date).
  - Refused, with a clear reason and nothing changed: opening balances recorded on another day (cancel them first), a later date while bookings, invoices or purchases already lie in between, a future or invalid day.
  - All locks use this one date: invoice and purchase corrections, payment dates, offsets, settle balance, opening balances and repair cost dates. Filed or paid VAT quarters stay locked on their own.
- **Correct final invoice date** (administrators only): if the payment that completed an invoice was entered with a wrong day, the invoice page offers "Correct final date".
  - That payment and the final invoice date move together. The invoice number never changes, also across the year end.
  - A reason is required. The correction is recorded in the invoice history and the audit log.
  - Refused before anything is saved: a day before the invoice date or in the future, before the opening date, in a filed or paid VAT quarter, a completing payment that is not clear or is not money, or a later payment.
- **Invoice list in date order:** the list is sorted by the date each row shows, newest first — for a final invoice its final invoice date, otherwise the invoice date. Invoices with the same day keep a fixed order (the last entered first). This holds for every status filter, the client and staff filters and the search.
- **Repairs:**
  - Changing the amount of a booked cost line, or "Cancel line", now takes back the old booking on its own day, not today. Every day that still carries a booking must be open; otherwise nothing is written and the reason is shown.
  - "Delete repair" is only possible while the repair has no booked costs and no invoice. Costs that were really incurred stay as a company expense; costs that were not incurred are removed with "Cancel line".
  - A cost line that was 0.000 at the start and gets an amount later is now booked like any other cost line.
  - A fully booked in-house line no longer blocks new lines or "Sent to workshop" after its day has been locked.
- **VAT quarter overview:** uses the fixed final invoice date, like the NBR export.
- **Supplier returns:**
  - A return price above the purchase price (without added costs) is refused with a clear message: it would be a gain, which has no account.
  - With added costs, the message names the highest possible amount. The partner share uses the same 5-fils rounding as the return booking.
  - The return dialog explains that refunded added costs carry no VAT.
- **Reclaim free space** (Settings → storage): compacting no longer runs on the live database. It runs on a copy, and the copy replaces the database only if the integrity check, the schema and every table, row by row, are identical. Any difference: the copy is discarded and the database stays untouched.
- **Owner restore tool:** restoring a checked backup into a completely empty data folder now works. All safeguards stay.

**Database:** no change (no new table, column or migration). The opening date, if changed, is stored as one entry in the settings of that database.

**Not part of this version:** additional costs on a purchase (shipping, repair, polishing, spare parts, other) are still being reviewed and come in a later version.

**Known limits:**
- **Second computer on v0.8.101** (it stays on v0.8.101 for now). Checked with a v0.8.101 second computer against this main computer: reading, new invoices, payments, payment corrections, credit, clients, prices and repair status work, and "Unresolved saves" clarifies as before (nothing booked twice). All its saves are checked and booked on the main computer. Limits until it is updated:
  - It still shows the provisional date of a final invoice (list, invoice page, PDF), and its invoice list keeps the old order. Print final invoices on the main computer.
  - It has no "Correct final date" and no Settings → Accounting. Both are used on the main computer.
  - If the opening date on the main computer is set **earlier** than 15 October 2026, the second computer still refuses offsets in "Settle Balance" dated before 15 October 2026 — enter those on the main computer. A **later** opening date is enforced by the main computer; nothing wrong is booked.
  - It cannot choose a cost date for repair cost lines: the main computer uses the day the repair was received. If that day is locked (before the opening date or in a filed quarter), the line is refused with a message — enter it on the main computer.
  - Expense and supplier payments made on it are dated today (it has no payment date field).
  - Changed rules (repair cost corrections on their original day, delete only without booked costs, supplier return above the purchase price) apply to it as well; a refusal shows its reason there.
  - During owner maintenance it cannot save and says "Nothing was saved" (no open entry in Unresolved saves).
  - Functions added since v0.8.102 (for example payment dates, several items in one approval transfer, the photo card in the repair list) are only on the main computer.
- **"Reclaim free space"** compacts only the main database. The sync server database is compacted by the offline maintenance only.
- **Unchanged from v0.8.108 and earlier:**
  - Remove (approval transfers) has no extra role check.
  - Older repairs book header costs at "Ready".
  - Supplier returns: a gain has no account; VAT on refunded added costs is not calculated.
  - Partners: production with a joint item and correcting a joint purchase line stay blocked.

**Before you update** (the main computer is on v0.8.108; the second computer is on v0.8.101):

1. Stop entering anything on the phone, and wait until every phone upload has been processed on the main computer.
2. Check **Unresolved saves** on the second computer. Clarify open entries; do not remove them blindly.
3. Close both computers.
4. Make a full archive copy of the data folder (both databases, the complete media folder, the staging folders and the key files) on E: and F:, and check it.

**Update** the main computer only. The second computer stays on v0.8.101 for now (see the known limits).
