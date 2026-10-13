# LATAIF v0.8.82

Stock integrity release: the quantity, stock status and source of an item now follow its business documents only.

- **Item editing:** quantity, stock status (in stock, sold, reserved, …) and source (own, consignment, agent) can no
  longer be changed in the item editor, on the main computer, from the second computer or from the phone. Purchases,
  sales, returns, consignment, agent transfers, production, offers and orders set them as before. Brand, name,
  condition, prices, notes, attributes and storage location stay editable. The item page shows quantity and status
  read-only.
- **Sold-out items:** an item without lots that is sold out now shows quantity 0. Saving a note no longer brings it
  back to 1.
- **Agent transfers:** an item is not sold to anyone else while its agent transfer is open, whatever its status shows.
- **Duplicates:** items with documents are not merged. A quantity is merged only from free own stock to free own stock
  (in stock, not consignment, not with an agent). A merge is complete or changes nothing, including photos, sync and
  history. "Merge all" and "Delete all except master" act only on the items shown, ask before merging and list the
  items that were refused.
- **Safety:** if the linked records of an item cannot be checked, deleting and merging are refused instead of going
  ahead.
- **Gold-Diamond Jewellery condition:** a start-up step no longer changes the condition "New" to "Pre-Owned" on every
  start.
- **Data Repairs (Settings, main computer, admin only):** repairs for damage left by the old start-up step (up to
  v0.8.80), shown only where the app's own records prove it and run only after a reason and a confirmation:
  - a bulk metal lot that was closed although it still had weight can be reopened. Only its status changes; weight,
    value and bookings stay as they are.
  - Gold-Diamond Jewellery items whose recorded condition "New" was changed to "Pre-Owned" can be set back to "New".

  Make a fresh backup before using it.

Known limitations:

- There is no stock correction function yet (found, lost or damaged items, counting errors). It needs decisions on
  valuation and accounting and will come in a later version. Until then stock changes only through purchases, sales,
  returns and the other business documents.
- "Reserved" and "Offered" can no longer be set by hand. Offers and orders still set them.
- Items that are imported or created by hand still get their starting quantity when they are created.

The update brings no new database structure. On the first start it records once that the gold condition fix is in
place. Existing silver/gold stock is not repaired automatically: the repairs run only when an admin starts them in
Data Repairs. Update the main computer first, then the second computer. Until the second computer is updated, a change
of status or source sent from it is refused by the main computer with a reason.
