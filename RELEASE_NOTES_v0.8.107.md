# LATAIF v0.8.107

This version adds an owner tool that frees the disk space of photos nobody needs any more. **Installing the update deletes nothing and changes no photo.** Files are only removed after two separate owner steps and a final confirmation. Bookings, payments, VAT, stock and items are not changed.

- **Release old image versions** (Settings → Data Repairs, owner only, main computer only):
  - **Dry run (changes nothing)** shows two parts separately, with the number of files and MB for each:
    - **Old image versions:** the larger versions left on the disk after "Make stored images smaller". An old version is only released when its current, smaller version has been checked.
    - **Deleted photos:** photos of items that were deleted, and photos that were deleted from the gallery of an item or a repair.
  - Shown as "stay" and never released:
    - current images;
    - identity documents;
    - photos used by more than one record;
    - photos of orders and inbox entries that still exist;
    - photos of scrap gold, documents, customers and suppliers;
    - the media journal.
  - **Release old versions** works only after the dry run, with a reason and the name of the verified full backup, and after a confirmation.
    - While it runs, the second computer and the phone cannot save anything.
    - A progress bar is shown. **Stop** ends the run after the current image; everything done so far is saved, and a new dry run and start continue.
  - Each run writes a log file to the `maintenance-logs` folder in the data folder.
- **The files are removed by the existing unused media cleanup** (Settings → Backup & Restore → Unused media cleanup):
  1. **Scan** shows the released files.
  2. **Schedule** restarts the app and moves the files into a quarantine folder.
  3. **Confirm** deletes them permanently.

  Until the confirmation, the files are still in the quarantine.
- **A deleted photo can come back:** uploading exactly the same picture again later restores it. If it is still in the quarantine, it is moved back at the next start.
- **Old changes from the second computer or the phone** cannot silently bring back a released photo. Such a change is refused with a message.
- **Phone uploads for deleted items:** a late phone upload for an item that was deleted is refused and put into quarantine instead of creating the item again. This now also works when the deletion was not written to the change log.

**Database:** no change (no new table or column). The update itself deletes no file and changes no photo, booking, payment, VAT, stock or item.

**Measured on a copy of the data from 17 November:**

| Part | Files | Size |
|---|---|---|
| Old image versions | 869 | 55.7 MB |
| Photos of 42 deleted items | 84 | 4.5 MB |
| Photos deleted from a gallery | 6 | 0.3 MB |
| **Total** | **959** | **60.5 MB** |

**Known limits:**
- **Permanent:** after the final confirmation in the unused media cleanup, the files exist only in the full backups. Keep the full backup made before the first run permanently.
- **Photos that stay protected:** photos of deleted repairs, orders, customers, suppliers and scrap gold trades, and of dismissed inbox entries, stay on the disk. Their delete actions keep the photos linked, and a deleted repair or order can come back through an old sync.
- **Unchanged from v0.8.106:**
  - Remove (approval transfers) has no extra role check.
  - Older repairs book header costs at "Ready".
  - Supplier returns: a gain has no account; VAT on refunded added costs is not calculated.
  - Partners: production with a joint item and correcting a joint purchase line stay blocked.

**Before you update** (the main computer is on v0.8.106; the second computer is still on v0.8.101):

1. Stop entering anything on the phone, and wait until every phone upload has been processed on the main computer.
2. Check **Unresolved saves** on the second computer. Clarify open entries; do not remove them blindly.
3. Close both computers.
4. Make a full archive copy of the data folder (both databases, the complete media folder, the staging folders and the key files) on E: and F:, and check it.

**Update** the main computer. The tool runs only on the main computer; the second computer can stay on its version. Mixed versions work.

**Before the first run of the tool** (a separate owner decision, not part of the update):

1. Close the second computer and keep the phone idle.
2. Make a fresh full backup on E: and F:, check it, and keep it permanently.
3. In Settings → Data Repairs: enter a reason, run **Dry run**, check both parts, then **Release old versions**.
4. In Settings → Backup & Restore → Unused media cleanup: **Scan**, **Schedule** (restart), check the quarantine, then **Confirm**.
