# LATAIF v0.8.39

## Automatic SKU for items created on the phone

An item you create on `/mobile` now gets its SKU by itself, at the moment the desktop writes the
product — you no longer have to think about numbering while standing at the counter.

- The first item of a new SKU stem starts at **`-001`**. (It used to skip to `-002`.)
- Every following item continues `-002`, `-003`, and so on.
- **A retry or a repeated upload never produces a second item and never burns a number.** If the
  phone loses the connection and sends the same upload again, you keep exactly one product with
  exactly one SKU.
- **A number that has been handed out is never handed out again**, not even after the product that
  held it is deleted. The counter does not go backwards, and gaps are not filled.
- If you typed a SKU yourself on the phone, it is kept as you typed it — nothing overwrites it.

Note on the desktop: the SKU **suggestion** in the New Item dialog and in the SKU field still works
the way it always has — it proposes the next free number based on the items currently in the list.
That suggestion is unchanged in this release.

## Check Item: the result list gets out of the way

When you pick a search result on `/mobile`, the long list of hits now disappears completely and you
see only the product — no scrolling past twenty other rows to read the one you selected.

- **Back to search** brings the list back with the same query, the same results and the same scroll
  position, exactly where you left it.
- No new search is run on the way back, so the list cannot change under you.

## Inventory: check your stock from the desktop

Collection has a new **inventory view** for working through a shelf without picking up the phone.

- It takes exactly the products you are currently looking at — your filter and your search apply.
- Three columns: **To check**, **Available**, **Not available**. Move an item by clicking it.
- Hover a row for the same product preview you know from the rest of Collection.
- Write a **note** per item, and watch the progress counter as you work.
- **Nothing is written until you press Save.** Move an item back and forth as often as you like;
  only the final state is recorded, as one entry per product.
- Closing the view with unsaved work asks first.

The result lands in the **same history** that the mobile check writes to — a check you record on the
desktop is visible on the phone, and the other way round.

## Stock check: small UX fixes

- The **note field now sits above** the Available / Not available buttons, so you write the note
  before you decide, not after.
- The check history is laid out in readable rows and columns instead of a run-on line.

---

Stock checks record *what you observed*. They do not change an item's quantity, price or status.
