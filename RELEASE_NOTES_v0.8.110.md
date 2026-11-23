# LATAIF v0.8.110

This version adds **item variants**: several single items of the same model — for example one bracelet in sizes 16, 17 and 18 — can be grouped under one model, shown together in the Collection and share one photo. Every item keeps its own SKU, weight, price, status, stock and bookings. **Installing the update deletes nothing and changes no item, invoice, payment, booking or stock.**

- **Group items** (Collection → "Group items"): choose the items, check the preview, save. Only items that fit together can be grouped: same branch, category, brand and kind of stock. Own stock and consignment items are never mixed. Sold, used-up and written-off items and system items cannot be added. Nothing is grouped automatically.
  - Grouping changes no item: it only records which items belong to which model (and writes an audit entry).
  - The model name comes from the items themselves.
- **Collection:** "Grouped by model" shows one card per model with its sizes and how many of each are in stock. Sold items are listed but not counted as stock. "Single items" shows every item on its own, as before.
- **Item page:** a model section lists all variants with size, weight, price and status; a click opens the variant. "Edit group" removes single items from the model or ends the grouping; the items themselves stay unchanged.
- **Add variant** (own stock only): opens the normal "New Item" form, already filled with the model's data. The tax scheme must be chosen every time; nothing is set to Margin automatically. Saving creates the item and adds it to the model in **one step**: either both happen or nothing does (also on the second computer). Consignment items are entered as before and can be grouped afterwards.
- **Merge photos:** gives the chosen photo to the other variants of the model.
  - The same stored photo file is used. No new file is created and the photo is not re-encoded.
  - The item's previous photos are kept as additional photos (recommended) or detached from the item. Detached photos are not deleted. To free their space later, the owner uses the existing maintenance: Settings → Data Repairs → "Release old image versions" (dry run, full reference check, verified backup), then Backup & Restore → "Unused media cleanup" (quarantine, confirmation). A photo still used by another item, a sold item or an identity document is never released.
  - "Undo" restores the previous photos (not possible any more once the maintenance has freed a detached photo; the dialog says so).
  - Sold items keep their photos.
  - Items whose photos are still in the old format (stored inside the database) can take part: their photos first move to the photo storage with the existing conversion — the same photos in the same order, each stored once like any upload. The dialog says so beforehand. If the conversion fails, that item and its photos stay unchanged and nothing is merged.
  - Deleting a variant, or changing the photos of one variant, never removes the shared photo from the other variants.
  - The AI image data of a changed item is recalculated at the next start.
- **Open item forms keep your entries and never overwrite newer changes:**
  - If the item is changed elsewhere while its edit form is open (for example "Merge photos" on another computer, or a photo from the phone), the form shows the current data and keeps what you typed. Before, typed entries could be lost silently when the item reloaded.
  - Saving a form whose photos or data are no longer current changes nothing and says so. The form reloads the current data and photos, keeps your entries and lists each one with its current value. New photos you added are kept and placed after the current photos. Click Save again to apply them. Removed photos or a new photo order are not repeated; the form says so.
  - If the same field was also changed elsewhere, the list marks it, and only a second click on Save uses your entry.
  - VAT locks, permissions and the existing checks apply unchanged. The form on the second computer works the same way (from this version).
- **Gold-Diamond Jewellery** has a new optional field "Size". Existing items are not changed.
- **New Item** is unchanged (Margin preset, tax rules, stock and booking rules as before).
- **Photo fields:** choosing the same photo file again (for example after removing it) now adds it; before, nothing happened.

**Database:** one new table that stores the model of each grouped item (empty until items are grouped; added automatically at the first start). The category Gold-Diamond Jewellery gets the optional "Size" field. No other change; no existing item, invoice, payment, booking or stock row is changed. Photos in the old format are converted only when you merge photos for that item, never automatically for the whole database (the owner's storage maintenance can still convert all of them, with its own backup check).

**Known limits:**
- **Second computer on v0.8.101.** Checked with a v0.8.101 second computer against this main computer. It keeps working as before, and its saves are checked on the main computer: an item form that was opened before "Merge photos" changed the item is refused there with a message, and the shared photo stays. Until it is updated:
  - It does not show models, the model section, "Group items", "Merge photos" or "Add variant". Use them on the main computer.
  - Editing and selling single items work as before; the grouping is kept.
  - After a refused save it shows the refusal as before: open the item again and enter the change again (it does not keep the entries).
- **Phone app:** shows no models; its photos and items work as before.
- **Unchanged from v0.8.109:** all known limits listed there still apply.

**Before you update:**

1. Stop entering anything on the phone, and wait until every phone upload has been processed on the main computer.
2. Check **Unresolved saves** on the second computer. Clarify open entries; do not remove them blindly.
3. Close both computers.
4. Make a full archive copy of the data folder (both databases, the complete media folder, the staging folders and the key files) on E: and F:, and check it.

**Update** the main computer. The second computer can stay on v0.8.101 for now (see the known limits); to use the variants there, update it as well.
