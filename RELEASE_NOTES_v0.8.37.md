# LATAIF v0.8.37

## Faster app, much smaller database

Older products stored their photo inside the database row itself. On a collection with a few hundred
photographed items that made the database very large and every refresh slow.

Settings → Danger Zone → **Storage Maintenance** now moves those photos into the media store:

- **Check what would change** first — a read-only summary of how many products and images are
  affected and how much can be freed. Nothing is touched by this step.
- The migration itself requires a **recent backup** and the **owner's credentials**, imports each
  photo, verifies it, and only then removes the original from the product row. A product whose image
  cannot be read is reported and left exactly as it was.
- **Reclaim free space** is a separate, owner-confirmed action: freeing rows alone does not shrink
  the file, so the space is reclaimed only when you ask for it and only when the disk has room.

Measured on a 200-item collection: database **345 MB → 1.2 MB**, refresh **1.1 s → 0.014 s**.

## Mobile upload: quantity

The mobile capture form now has a **Quantity** field. It defaults to 1, accepts whole numbers, and
the imported product carries exactly the number you entered — retries and double taps still create
one product, never two and never double the count.

## Selection fields can be cleared again

In the product create and edit dialogs, clicking the option that is **already selected** now removes
it, so a field can be returned to empty instead of being stuck on the first value you ever picked.
Fields that are required still have to be filled before saving.

## Three fields are no longer required

- Watch → **Case Diameter**
- Branded Gold Jewelry → **Size**
- Accessory → **Description**

They can still be filled in, and an existing value can now also be cleared and saved.

## AI Identify is safer when editing an existing item

Identifying an item you are editing now only fills in what it recognises:

- your **photos are left untouched**,
- **prices are never changed** — a purchase price of 0 is treated as a real value, not an empty one,
- a field the AI could not read keeps the value you already had.

Identifying while creating a new item is unchanged.

## Also in this release

Stability and safety work around backups, database maintenance and the mobile upload path.

---

This release supports **one desktop installation** with `/mobile` capture. Synchronising a
collection between two desktop PCs is not part of this release.
