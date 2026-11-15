# LATAIF v0.8.104

Collections is faster and loads much less image data, new photos are stored smaller, and a one-time maintenance step can close two old, unfinished phone photo edits.

- **Collections loads faster** (main computer and second computer):
  - Card images stay in memory while you work. After opening an item and going back, or after switching the category, the images are there at once and are not loaded again.
  - A card loads its image only when it is visible or about to be.
  - Cards show the small preview image (at most 256 px) instead of the full photo. **Item details still show the full photo.**
  - The second computer no longer asks the main computer about every single card.
  - Measured with 90 items:

    | | Main computer | Second computer |
    |---|---|---|
    | Opening Collections | 88 KB instead of 2.9 MB | 89 KB instead of 502 KB |
    | Scrolling through all items | 0.8 MB instead of 26.6 MB | 0.8 MB instead of 4.5 MB |
    | Card images in memory | about 0.8 MB instead of 4.9 MB | about 0.8 MB instead of 4.9 MB |

- **Smaller files for new photos.** This applies to every new upload on the main computer, the second computer and the phone:

  | | Main photo | Preview |
  |---|---|---|
  | Watches and anything without a category | up to 60 KB | up to 10 KB |
  | Jewellery (gold, branded, original) and accessories | up to 30 KB | up to 10 KB |
  | Identity documents | unchanged: 100 KB | unchanged: 20 KB |

  - Repairs, orders, scrap gold and the purchase inbox follow the item category: jewellery and accessories 30 KB, everything else 60 KB.
  - As before, every photo is encoded again (location data removed) at the best quality that fits.
  - **Existing photos are not changed.**
- **One-time maintenance: two old phone photo edits** (Settings → Data Repairs; owner only; main computer only):
  - Two edits sent from the phone never finished and were replaced by a later edit that did:
    - TAG-WCH-004, 25 Aug 2026;
    - CAR-OGJ-001, 3 Oct 2026.
  - They are still marked as open, which keeps both items out of image matching.
  - The card appears only while these two edits are open. It changes nothing on its own.
  - **Check now** checks both edits against the current data. **Close superseded edits** needs a reason, the name of a verified backup and a confirmation.
  - If anything changed since the check, nothing is written.
  - Closing only marks the two old requests as superseded. Prices, photos, photo links and sync stay exactly as they are.
  - After the next start, image matching runs for the two items. The card disappears once both are done.
  - Use it only after a full backup, and only when you decide to.

- **Approval transfers, small fix:** when one item of a multi-item transfer is refused, the message names an item without brand and model by its details (for example "Ring · 18K White Gold · 3.10 g") instead of its internal ID. Amounts, statuses and permissions are unchanged.

**Database:** no change (no new table or column). The update itself does not change any photo, photo link, booking or item.

**Known limits:**
- **Existing photos:**
  - Stored photos keep their current size. Making existing photos smaller is prepared, but it is not part of this version.
  - Old photo versions are never deleted.
- **Preview images:** at most 256 px. On very high-resolution screens a card can look slightly softer; item details are unchanged.
- **Second computer:** a photo changed elsewhere shows on a card once the item list is loaded again (opening Collections or an item).
- **Unchanged from v0.8.103:**
  - Remove (approval transfers) has no extra role check, like all other transfer actions.
  - Older repairs: header costs have no cost date and are booked at "Ready".
  - Sales users can still record money in the places listed for v0.8.101.
  - Supplier returns: a gain has no account; VAT on refunded added costs is not calculated.
  - Partners: production with a joint item and correcting a joint purchase line stay blocked.

**Before you update** (the main computer is on v0.8.103; the second computer is still on v0.8.101):

1. Stop entering anything on the phone, and wait until every phone upload has been processed on the main computer. An upload that is only half processed during the update may have to be sent again.
2. Check **Unresolved saves** on the second computer. Clarify open entries; do not remove them blindly.
3. Close both computers.
4. Make a full archive copy of the data folder (both databases, the complete media folder, the staging folders and the key files) on E: and F:, and check it.

**Update** the main computer first, then the second computer.

Mixed versions work, just without the savings:
- A second computer on an older version shows cards the previous way, with the full photo for each card.
- A second computer on v0.8.104 with an older main computer does the same.
