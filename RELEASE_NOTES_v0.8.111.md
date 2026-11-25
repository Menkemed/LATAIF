# LATAIF v0.8.111

This version links supplier and client records more easily, and lets you buy a new **variant of an existing item** directly in a purchase. **Installing the update deletes nothing and changes no item, invoice, payment, booking or stock.**

## Supplier ↔ client

- **Link to Client / Link Supplier:** a supplier that was created without "Use existing customer" can now be linked to the existing client afterwards. Use the new button on the supplier page or the client page, or "Link to this client" / "Link this supplier" in the "Possible match" hint.
  - You can search for any client or supplier. Clients and suppliers that already have a link are shown but cannot be chosen.
  - Only the link is saved. Purchases, payables, invoices, payments and bookings stay exactly as they are. Both pages then show the balance of the other role, and the client account and "Settle Balance" include the linked supplier role as before.
- **Unlink:** a wrong link can be removed ("Unlink client" / "Unlink supplier"), with a required reason.
  - It is refused while a settlement (STL-…) between this client and supplier is active. The message names the settlement. Reverse the settlement first with the existing function; nothing is reversed automatically.
  - If the settlement cannot be reversed (for example, its VAT quarter is filed), the link stays.
  - Only the link is removed. The audit log records who did it, when, the previous client and the reason. Afterwards the supplier can be linked to another client.

## Purchase → "Variant of existing"

- In a purchase line, choose **"Variant of existing"**, pick the existing item (own stock only), and the normal "New Item" form opens with the shared details filled in: category, brand, model, condition, scope of delivery, item type, reference and description.
  - Enter the piece's own size, weight and sale price. **Karat & Color** is suggested from the original and must be confirmed. The **tax scheme** must be chosen every time; it is never copied from the original.
  - The SKU is assigned automatically. The purchase price comes only from the purchase line.
- **Model:** if the original already belongs to a model, the new piece joins it. If not, a model is created with the original and the new piece when the purchase is saved. Several variants of the same original in one purchase all join the same model. Different sizes, weights, karats and gold colours may be in one model. Own stock and consignment stay separate.
- **Booking:** the piece is created and booked exactly like a normal "New Item" line (stock lot, cost, input VAT, payable, payments). Purchase, item, SKU, stock lot, model assignment and photo link are saved in **one step**: either all of it happens or nothing does, also on the second computer.
- **Edit Purchase** has the same option: "Add variant of existing". The existing edit locks (owner only, filed VAT quarter, opening date, mixed input VAT) apply unchanged.
- **Photo:** you can use the photo of the original. No new file is created; the new piece only refers to the same stored photo.
  - If Karat & Color differs from the original, this is switched off by default and a warning is shown; you can still choose it.
  - "Merge photos" shows the same warning when the chosen pieces have different Karat & Color.
  - If the original's photo is still in the old format (stored inside the database), it cannot be referenced. The form says so instead of saving the piece without a photo.
- **Collections → Add variant** now also works for items that are not in a model yet (the model is created when saving), and asks to confirm Karat & Color.
- **Model cards** show size and Karat & Color, for example "16 · 18K WG ×2". The variant list has a "Karat & Color" column. The short form (YG/WG/RG/MIX) is the same as on the labels and is not stored; Karat & Color stays in the existing field.
- **Search** in Collections finds the short forms and combinations, for example "WG", "18K WG" or "Cartier Love WG". The item picker for "Variant of existing" works the same way.
- **Purchase lines** show a small detail line under the item name, for example "Bracelet · 16 · 18K White · 36.50 g" (watches: reference, size, material and year where available). It appears in New Purchase, Edit Purchase and Purchase Detail.
- "New Item", "Existing" and Collections → "New Item" work as before.

**Database:** no change. No new table or column; Karat & Color uses the existing field.

**Known limits:**
- **Second computer on v0.8.101.** Checked with a v0.8.101 second computer against this main computer: saving items, purchases (including edits and added lines), orders, consignment sales and the read-only views work as before. Until it is updated, it does not show:
  - "Link to Client", "Link Supplier" or "Unlink";
  - "Variant of existing" in purchases and Edit Purchase;
  - the new Karat & Color display, the combined search and the purchase detail line.
  Use these on the main computer, or update the second computer as well.
- **Photos of a new purchase item** are first saved in the old format and moved to the photo storage right after saving (as before). Until then, a variant of that item cannot take over its photo; the form says so.
- **Unchanged from v0.8.110:** all known limits listed there still apply.

**Before you update:**

1. Stop entering anything on the phone, and wait until every phone upload has been processed on the main computer.
2. Check **Unresolved saves** on the second computer. Clarify open entries; do not remove them blindly.
3. Close both computers.
4. Make a full archive copy of the data folder (both databases, the complete media folder, the staging folders and the key files) on E: and F:, and check it.

**Update** the main computer. The second computer can stay on v0.8.101 for now (see the known limits); to use the new functions there, update it as well.
