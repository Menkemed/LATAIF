# LATAIF v0.8.79

Foundation fixes for stock cost, item status, metal purity and live metal prices.

- **Cost of VAT purchases:** for purchases with recoverable input VAT, the stock lot and the cost of
  goods sold now use the same net inventory value as the ledger (the VAT is no longer part of the cost).
- **Production:** inputs that have stock lots use the actual cost of those lots.
- **Item status after sale or return:** after a sale, a return or a cancelled return, the item status
  now follows the stock that is really left (no more "sold" while pieces are still in stock).
- **Purity per metal:** gold, silver and platinum have separate purities; 24K = 0.999. Gold workflows
  reject silver or platinum purities.
- **Fine gold totals** count gold only.
- **One live price formula:** gold and silver live prices use one BHD per gram fine formula
  (USD/oz ÷ 31.1034768 × 0.376) on the dashboard, in Add Material and in orders.
- **Precious Metals:** the manual house price stays separate; the live value is shown next to it as
  "Live reference" only.

No existing data is changed. Update the main computer first, then the second computer.
