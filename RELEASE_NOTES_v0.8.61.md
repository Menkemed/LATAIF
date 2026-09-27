# LATAIF v0.8.61

This release lets LATAIF buy items together with partners. LATAIF always takes part; one or more
partners can hold a share of a purchase line. Buying, paying the supplier, stock, selling, VAT and
cost of goods work exactly as before — the partner part is kept on its own account next to it.

## Buying together with partners

- **Optional per purchase line.** When active partners exist, a new purchase has a closed
  "Add partner" section. Shares are set per line, together exactly 100 %, and can be applied to
  selected lines. LATAIF keeps the rest. Without partners nothing changes.
- **Purchase VAT is unchanged.** The supplier invoice, input VAT, supplier debt and stock are booked
  as for any purchase. LATAIF pays the supplier once; partners do not pay the supplier directly.
- **Partner money runs only through LATAIF's cash, bank or benefit.** It is booked on its own
  account (partner item balance), separate from partner equity.

## Contributions, payouts and profit shares

- **Contribution / repayment** (partner → LATAIF) and **payout** (LATAIF → partner) per item. A
  payout can be at most what LATAIF owes the partner on that item.
- **Settle sale** — manually, once the sale is fully paid. The basis is the invoice line after
  returns and the cost of goods from the ledger; the partner gets their share of the profit or
  loss. Repair cost added to the item before the sale counts towards the partner's cost share.
- **Offset with another item** of the same partner, without cash.
- The Partners page shows per item and per partner what was contributed, released, paid out and
  what is still open.

## Returns, corrections and claims back

- A customer return, a cancellation or a permitted invoice edit after a sale was settled is booked
  as a **settlement correction** of the difference only. Earlier settlements and payouts stay as
  they were. Payouts on that item wait until the correction is booked.
- If the partner received too much, the open balance becomes negative: the partner repays it or it
  is offset against another item.

## Return to supplier and supplier credit

- Jointly bought items can be returned to the supplier through the existing return-to-supplier
  flow. Stock, supplier debt, refund and input VAT stay in that flow; in the same step each partner
  gets their share of the difference between refund value and stock cost.
- If the supplier gives a credit instead of money, payouts on that item wait until the credit is
  fully used. Nothing is paid out automatically.
- Reversing the supplier return reverses the partner bookings — refused once something was booked
  for the partner after it.

## Take over (LATAIF alone) and change partners

- For all **unsold** pieces of a purchase line, LATAIF can take over alone, or the partners and
  shares can be changed. Partners can also be added to unsold pieces of an item bought alone.
- **Only at the current stock cost** (including capitalised repair cost). The value is shown before
  confirming; any other value is refused. There is no cash movement, no stock entry, no new purchase
  and no revaluation — what each side owes stays on the partner item balance and is paid through
  contribution or payout.
- Pieces already sold and settled keep their shares. Sales after a take-over belong to LATAIF alone.
- Not possible while a settlement correction, an undecided customer return, an unsettled sale or a
  supplier credit on the item is open.

## Second computer (PC2)

Contributions, payouts, settlements, offsets, reversals, take-over and change of partners can be
booked from the second computer. They are booked on the main computer in one step, with the same
checks as there; a repeated send after a lost connection does not book twice.

## Reports

The profit report shows jointly bought items in their own block: item profit, partner shares and
LATAIF's share. "Total Profit" keeps its meaning; the partner shares are shown once in that block.

## Known limitations

- **"Under Repair" is not available as a return option for jointly bought items.** Choose "Back to
  Stock" and send the item to repair as own stock if needed, or "Write Off" (the partner shares the
  loss). The return screen shows this hint.
- Jointly bought items cannot be used in production.
- Shares are agreed when the purchase is created. Later they change only through take-over or
  change of partners, at the current stock cost.
- A piece that comes back from a customer after the partnership on it ended stays blocked for
  payouts, changes and supplier returns until LATAIF takes it over.
- Settlement and payouts are always manual.
- There is no separate permission for partner item actions. As with the existing partner
  transactions, every logged-in user who can open the Partners page or a purchase can record
  contributions and payouts, settle, offset, take over or change partners — on the main computer and
  on the second computer.

## Before you update

Create a backup in Settings → Backup & Restore (owner login) and wait until it shows as complete.
Update the main computer first, then the second computer. The new tables are created
automatically on the first start; existing data is not changed.
