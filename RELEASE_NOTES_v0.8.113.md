# LATAIF v0.8.113

Fewer duplicate warnings, and a description per piece in a model. **Installing the update deletes nothing and changes no item, invoice, payment, booking or stock.**

## Duplicate warning

The duplicate warning came up far too often (checked against the real stock: for most items). It now follows clear rules — in Collections, Purchase ("New Item"), Consignment and on the second computer:

- **Same SKU:** saving stays blocked, as before.
- **Same serial number and same brand:** a warning when you **save**, with the side-by-side comparison.
- **Same brand + reference or model number, same name, a near-identical photo:** only a quiet line under the form — "2 similar items in stock — compare". A click shows the comparison (with "Close", never "Create anyway"); saving is not interrupted.
- **Different serial numbers:** two pieces — no warning (except an SKU conflict).
- **No pop-up while typing** or after "AI Identify" — the warning comes only when you save.
- **Answered once, not asked again:** after "Cancel" or "Create anyway", the same warning (same items, same reasons) does not come back when you save again. If the conflict changes, it asks again.

Unchanged: the duplicate groups in Settings, the photo check of phone uploads, and "Copy details" on the phone.

## Description in the model

For pieces of the same model that differ only in weight or stone colour (for example Van Cleef Alhambra in Malachite, Onyx, Carnelian):

- The model table on the item page has a **Description** column. Long texts are shortened; the full text shows when you move the mouse over it.
- The chips above the table include the description, for example **"18K YG · Malachite ×2"**, **"18K YG · Onyx ×1"**. The count is the number of pieces (quantity included); sold pieces are not counted as available.
- Write the stone colour as free text in the existing **Description** field. "Variant of existing" takes the description over from the original; change it if the new piece is different.

**Database:** no change. No new field.

**Known limits:**
- **Second computer on v0.8.101:** it still shows the old duplicate pop-up and no Description column. Its consignments are checked on the main computer with the new rules.
- **Unchanged from v0.8.112:** all known limits listed there still apply.

**Before you update:**

1. Stop entering anything on the phone, and wait until every phone upload has been processed on the main computer.
2. Check **Unresolved saves** on the second computer. Clarify open entries; do not remove them blindly.
3. Close both computers.
4. Make a full archive copy of the data folder (both databases, the complete media folder, the staging folders and the key files) on E: and F:, and check it.

**Update** the main computer. The second computer can stay on v0.8.101 for now.
