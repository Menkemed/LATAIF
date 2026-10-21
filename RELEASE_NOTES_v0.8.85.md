# LATAIF v0.8.85

Platinum jewellery, complete Original tags, safer Excel import, no new Pendant items, one SKU per item, deleted items
no longer weigh down your backups — and on the phone: purchase photos from the gallery, and country code and
Personal ID for a new client.

- **Platinum:** Gold-Diamond, Branded and Original Gold Jewellery have Platinum as a Karat & Color option — on the
  computer, on the phone (new item, edit, purchase, consignment) and in the AI suggestion. Existing karat and Silver
  options stay as they are; no item value changes.
- **Original Gold Jewellery tag:** the tag now shows the material next to the size, like Branded ("52 / PLATINUM").
  Size and material are never shortened. A tag that cannot be shown completely is not printed: the Print Tags dialog
  lists it with the reason and prints only the complete tags. All other tags print exactly as before.
- **Excel import:** "Platinum", "Platinum 950/999", "PT950" become Platinum and the given fineness is kept in the
  notes with a warning — "Platinum 999" is never imported as 24K any more. "Silver", "Silver 925", "Sterling", "925"
  and "Silver 999" become Silver the same way. Mixed values (gold with platinum or silver, plated) are not guessed;
  they are kept in the notes.
- **Pendant:** Pendant is no longer offered as an item type for Gold-Diamond, Branded and Original jewellery — use
  Necklace. Existing Pendant items keep their value, stay editable and print and invoice as before. A new item with
  Pendant is refused with a clear message (computer, second computer, phone, purchase, consignment, order,
  production). The Excel import turns Pendant into Necklace with a warning and keeps the original value in the notes.
- **One SKU per item:** a SKU that another item already has is refused when saving — the message names the SKU. This
  is checked in the database itself, on the computer, from the second computer, for purchases and for a phone upload
  with a typed SKU (that upload is set aside once instead of being retried forever). Items that already share a SKU
  stay as they are and stay editable.
- **Deleting an item:** the item's phone upload receipt is removed and its photos are marked as removed, exactly like
  removing a photo from the gallery. Photos of deleted items are no longer copied into every backup. The first start
  after the update does the same for items deleted earlier. The photo files themselves stay on disk; a photo that
  another item still uses stays in the backup. An old phone upload can never create a deleted item again. A backup
  made after the update restores completely (both databases, the photos still in use).
- **Phone purchase — photos from the gallery:** each new item offers "Take photo" and "Choose from gallery" (several
  at once, up to 8 photos per item). New photos are added after the existing ones, each can still be removed, and the
  same photo is not added twice. The ID photo of a new person can also come from the gallery. Booked purchases stay
  locked as before.
- **Phone — country code and Personal ID for a new client:** Purchase (new person), Repair (new customer) and
  Consignment (new client) now have the country code as a choice next to the phone number — the same list as on the
  computer, Bahrain preselected — and "Personal ID (CPR / passport)". The number is saved in international form
  exactly like on the computer ("+97336123456"); a number or ID that looks unusual only gets a hint, never a block.
  Empty fields save nothing. Existing clients are not changed.

**Before you update:** make a fresh backup of the main computer and check it. The first start after the update cleans
up the leftovers of earlier deleted items (on the main computer only); this takes a moment.

**Update** the main computer and the second computer together. The phone changes come with the main computer's update
(the phone page is served by the main computer) — reload the page on the phone afterwards. The database structure
does not change and no ledger backfill is needed. Stock values, bookings, VAT and invoices are not affected.
