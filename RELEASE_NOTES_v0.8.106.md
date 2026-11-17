# LATAIF v0.8.106

This version adds an owner tool that makes the stored photos smaller. **Installing the update changes no photo.** Photos only change when the owner starts the tool. Bookings, payments, VAT, stock and items are not changed.

- **Make stored images smaller** (Settings → Data Repairs, owner only, main computer only):
  - **Count images** shows how many photo files are stored and how many can be made smaller.
  - **Dry run (changes nothing)** calculates every image and shows the total size before and after. Nothing is written.
  - **Start image migration** works only after the dry run, with a reason and the name of the verified full backup, and after a confirmation.
  - Size limits:
    - watches and repairs: at most 60 KB;
    - jewellery and accessories: at most 30 KB;
    - previews: at most 10 KB.

    ID documents are never changed. Images that are already small stay as they are.
  - A progress bar shows how far the run is. **Stop** ends the run after the current image; everything done so far is saved, and **Start** again continues where it stopped.
  - Each run writes a log file to the `maintenance-logs` folder in the data folder. It contains only numbers and IDs, no names.
  - Items, photo links and the order of the photos stay the same. The old image versions stay on the disk; nothing is deleted.
- **Maintenance mode while the tool runs:**
  - The second computer and the phone cannot save. They get the message "The main computer is running owner maintenance. Nothing was saved — please try again in a few minutes." The phone tries again by itself.
  - Viewing items and photos still works.
  - Maintenance mode ends when the run ends, is stopped or fails, and when the app is restarted.
- **Safe with normal work on the main computer:** the tool works in packages of 10 images and saves after each package. Entries on the main computer wait at most for one package, and the second computer never sees a half-finished image.

**Database:** no change (no new table or column). The update itself changes no photo, booking, payment, VAT, stock or item.

**Measured on a copy of the data from 16 November:**
- 869 of the 1,250 stored image files can be made smaller: 546 main images and 323 previews. 267 files are already small, and 2 belong to an ID document.
- The current image data shrinks from 64.4 MB to 33.1 MB. The media folder grows from 63.1 MB to 87.6 MB, because the old versions stay on the disk.
- Duration on the test copy: the dry run took about 10 minutes and the run about 14 minutes.

**Known limits:**
- **Old image versions stay on the disk.** Removing them is a separate step and is not part of this version.
- **Backups:** the automatic app backups contain only the current version of each photo. Keep the full backup made before the run permanently.
- **Image quality:** the smaller versions are made from the stored photos; the original camera photos are not stored. To reach the limit, the photos also get fewer pixels:
  - watches: for example 737×982 → 531×708;
  - jewellery: for example 900×1600 → 398×708;
  - accessories: for example 737×982 → 383×510.

  Fine text, such as on a price tag, can become hard to read. Check a sample visually before the first run.
- **Unchanged from v0.8.105:**
  - Remove (approval transfers) has no extra role check.
  - Older repairs book header costs at "Ready".
  - Supplier returns: a gain has no account; VAT on refunded added costs is not calculated.
  - Partners: production with a joint item and correcting a joint purchase line stay blocked.

**Before you update** (the main computer is on v0.8.105; the second computer is still on v0.8.101):

1. Stop entering anything on the phone, and wait until every phone upload has been processed on the main computer.
2. Check **Unresolved saves** on the second computer. Clarify open entries; do not remove them blindly.
3. Close both computers.
4. Make a full archive copy of the data folder (both databases, the complete media folder, the staging folders and the key files) on E: and F:, and check it.

**Update** the main computer. The image tool runs only on the main computer; the second computer can stay on its version. Mixed versions work.

**Before the first run of the image tool** (a separate owner decision, not part of the update):

1. Approve the visual sample check.
2. Close the second computer and keep the phone idle.
3. Make a fresh full backup on E: and F:, check it, and keep it permanently.
4. In Settings → Data Repairs: **Count images**, then **Dry run**, then **Start image migration**.
