# LATAIF v0.8.38

## AI on the mobile capture form

After you take a photo on `/mobile`, an **AI Identify** button appears. It reads the photo and fills
in what it recognises — brand, name, condition, description, scope of delivery, storage location and
notes — **before** anything is uploaded.

- Nothing is sent to the desktop until you press Upload, so you can correct or overwrite every value
  the AI proposed.
- **Quantity and prices are never touched by the AI.** They stay exactly as you typed them.
- If the AI cannot read the photo, the form keeps everything you already entered — you can simply
  upload without it.

## Check Item: search, not just scan

Next to the QR scanner there is now a **search box**. It looks across SKU, reference number, serial
number, model, brand, name and description, so you can find an item whose tag is missing or
unreadable.

Opening a search result shows the **same complete product view** the QR scanner opens — the same
fields, the same photos. There is no reduced "search version" of the item.

## Photos are visible on mobile again

Products whose photos were moved into the media store by the v0.8.37 storage migration now display
those photos correctly on `/mobile`.

## Stock Check

You can now record a physical check of an item — on **mobile and on the desktop**:

- **Available** or **Not Available**
- an optional **note**
- who checked it and when

Both surfaces write into **one shared history**: a check recorded on the phone appears on the
desktop product page, and a check recorded on the desktop appears on the phone.

**A stock check records what you saw. It does not change anything.** Quantities, stock levels and
product data are never modified by a check — the history is documentation of a physical inspection,
for example during an inventory count, and any correction is still made deliberately by you.

---

This release supports **one desktop installation** with `/mobile` capture. Synchronising a
collection between two desktop PCs is not part of this release.
