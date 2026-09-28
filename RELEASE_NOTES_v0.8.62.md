# LATAIF v0.8.62

A hotfix for confirmation prompts, plus three improvements from the first live use of jointly
bought items.

## Confirmation prompts work again

Buttons that ask "Are you sure …?" before acting did nothing in v0.8.60 and v0.8.61 — no window
appeared, and nothing was saved. This affected every such button, for example "Settle sale",
deleting a payment, deleting a partner or cancelling. The question now appears again as a window
with OK and Cancel. Cancel — or a window that cannot be shown — does nothing.

## Jointly bought items

- **Card fees count before the profit is shared.** When a sale is paid by card, the card fee of
  the invoice is deducted from the item's profit before the partner's share is calculated. With
  several items on one invoice, the fee is split by the items' value; the parts add up exactly to
  the fee. If the fee changes later (for example when it is recovered on a refund), the item asks
  for a settlement correction of the difference only.
- **LATAIF's share is shown on the Partners page.** Each sale shows net sale − cost − card fee =
  profit, the partner's share and LATAIF's share — also in the question before settling.
- **Partner share as an amount.** When buying, the partner's part can be entered in BHD as well as
  in percent. The amount refers to the selected items and is turned into a share rounded to
  0.01 %; after applying, each item shows the exact cost share.

The profit report calls the first figure "Item profit (100 %, after card fees)". "Total Profit"
keeps its meaning.

## Before you update

Update the main computer first, then the second computer. No data is changed by the update.
