# LATAIF v0.8.81

Stock and data integrity release: starting the app no longer changes stock, plus fixes for consignment,
agent transfers, returns and production.

- **Startup no longer changes stock:** historical one-time data corrections ran again on every start and
  recalculated lots and quantities from invoice lines. They now run at most once per database. A start no
  longer brings back stock that left through an agent sale, a production or a return to the supplier, no
  longer double-counts kept returns, and no longer closes bulk metal lots that still have weight.
- **Single instance:** a second copy of the app on the same Windows user now exits before it opens any data,
  also when the first window cannot be found.
- **Consignment:** consignment items are sold only through Record Sale (no second sale through a normal
  invoice). The sale invoice of a consignment keeps its item, price, buyer and date; it is cancelled or
  returned through Cancel Sale or Buyer Returns. Return to Owner and Keep use the exact consignment of the
  sale and can be undone exactly.
- **Agent transfers:** consignment items are not handed to an agent. A transfer comes back only while it
  is still out. Deleting a transfer reverses the item, the sale, the receivable and the settlement payments
  in one step, or nothing at all. Converting transfers to an invoice is all-or-nothing as well.
- **Returns and stock:** Return to Owner and Keep only for consignment lines; partial returns keep the item
  sellable; piece goods are sold and returned in whole pieces only.
- **Production:** deleting a production restores the exact consumed lots and reverses its bookings in one
  step, or nothing at all.
- **Item hover card:** cost is shown from the open lots, as a sale would book it.
- **Sync:** settlement payment rows of a deleted or converted agent transfer and the new return snapshot
  fields are synchronised.

Known limitations:

- Stock already changed by earlier starts is not corrected automatically. It can be reviewed separately.
- Status and quantity can still be edited directly on the item page; this will be restricted in a later
  version.

The update adds database columns only; existing data is not changed. Update the main computer first, then
the second computer.
