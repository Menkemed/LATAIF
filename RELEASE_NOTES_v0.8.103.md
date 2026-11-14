# LATAIF v0.8.103

Approval transfers: several items can be handed over in one New Transfer, and every transfer can be edited or removed afterwards — on the main computer and on the second computer alike.

- **New Transfer with several items** (Approval & Distribution):
  - Tick the items; the selection stays while you search. At most 50 items.
  - **Our Price per item**, prefilled with the planned sale price.
  - **Full / Our Price + Split** once for all items, and per item changeable (model and share).
  - Client, transfer date, return date, staff and notes once for all items.
  - **Each item becomes its own transfer** with its own TRF number, price, model and status. All items are saved together, or none.
  - One item works as before. Combined Invoice and the approval print list are unchanged.
- **Edit Transfer** (one window for the transfer list and the transfer page):
  - Our Price, Full / Split and share, client (only while the item is still out), transfer date, return date, staff and notes.
  - **After a sale** (no invoice, no settlement payment yet): the amount we receive is calculated again with the same rule. The booked receivable is reversed on the sale day and booked again with the new amount. A sale below the new Our Price needs a confirmation.
  - **Locked with a clear message:** after an invoice (price, model, client, date), after a settlement payment (price, model, client), and for a cancelled transfer.
- **Remove a wrong transfer** ("Remove this transfer…", a reason is required):
  - **Nothing booked yet:** the transfer is deleted and the item is back in stock. Its TRF number is not used again; the history keeps the reason.
  - **Sold:** the sale is cancelled with reversing entries on the sale day. The item is back in stock, and the transfer stays as "Cancelled" with nothing open.
  - **Invoiced or settlement payment recorded:** refused, with the way to correct it (undo the conversion while the invoice is unpaid, otherwise a return or credit note).
  - Other transfers of the same hand-over are not touched. If the item really came back from the client, use "Returned". For a replacement item, create a new transfer.
- **Rules for a booked sale:** changing its amount or cancelling it is not possible before the opening (15 Oct 2026) or in a VAT quarter that is already filed or paid — the same rule as every other correction.
- **Second computer:** the same functions as the main computer, including Remove. This is the only delete that the second computer may do; every other delete stays on the main computer. Sending the same request again never books twice.

**Database:** no change. A transfer can now have the status "Cancelled" (stored in the existing status field). Existing transfers, bookings, items and media are not changed.

**Known limits:**
- Remove has no extra role check, like all other transfer actions. Today all logins are owner/admin logins.
- **Unchanged from v0.8.102:**
  - Older repairs: header costs have no cost date and are booked at "Ready".
  - Sales users can still record money in the places listed for v0.8.101.
  - Supplier returns: a gain has no account; VAT on refunded added costs is not calculated.
  - Partners: production with a joint item and correcting a joint purchase line stay blocked.

**Before you update** (the main computer is on v0.8.102; the second computer is still on v0.8.101):

1. Stop entering anything on the phone.
2. Check **Unresolved saves** on the second computer. Clarify open entries; do not remove them blindly.
3. Close both computers.
4. Make a full archive copy of both databases, the complete media folder (all files, no cleanup) and the key files, and check it.

**Update** the main computer first, then the second computer.

Several items in one transfer, the new Edit fields and Remove need v0.8.103 on both computers. While the second computer is still on an older version:
- it can create single transfers and change price, return date and notes as before;
- it offers no Remove and no multi-item transfer.

If the second computer were updated before the main computer, these new actions are refused with a message and nothing is saved. Update the main computer first.
