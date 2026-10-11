# LATAIF v0.8.80

Bulk metal by weight, a sync fix and two internal safety classifications.

- **Bulk Metal (gold and silver by weight):** buy loose metal as one lot by total weight and total cost
  (for example 500 g Silver 925). Each lot gets its own number per branch (BM-0001, BM-0002, …).
- **Selling by weight:** sell any weight from a lot on a normal invoice line. The cost of the sold weight
  is taken proportionally from the lot; the last sale takes exactly the remaining value. Weights are kept
  in milligrams and amounts in fils, so nothing is lost to rounding.
- **Bulk Metals page:** lots with remaining weight and value, cost per gram and live value per gram, the
  sales of each lot and what the metal was sold as. Write off a weight loss, close a lot, correct an
  unused lot and reverse the last write-off (admin only). Each action is recorded exactly once, even if
  the network repeats the request. Losses are booked as Inventory Loss.
- **Invoices, returns and reports:** editing, cancelling or deleting an invoice and returning a bulk line
  give back the exact weight and value. Stock value counts bulk metal once and never as pieces; profit
  reports show the inventory loss. The second computer uses the same functions through the main computer.
- **Sync fix:** fixed a sync queue blockage caused by legitimate `invoice_lines` updates (editing an
  invoice that keeps existing lines). Waiting sync changes continue normally after the update.
- **Safety classifications:** `get_pending_saves_root` is classified as first-run safe (the second
  computer needs it without a data folder), and `mobile_upload_retry` is classified as an internal,
  never-synchronised server table.

The update adds new database columns and tables for bulk metal; existing data is not changed. Update the
main computer first, then the second computer.
