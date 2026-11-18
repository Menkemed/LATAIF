# LATAIF v0.8.108

This version brings a large photo card in the repair list, one date for every final invoice, much less database growth from now on, and a safer sync recovery. It also prepares a separate offline storage maintenance. **Installing the update deletes nothing and rewrites no history.** The storage maintenance is not part of the update: it is a separate step that has not been run on the real data yet and needs its own owner decision.

- **Repair list — large photo card:** pointing at a repair shows a card with the main photo of the item (about 280 × 280, the whole picture), brand, model, reference and serial number. A repair without its own photo shows the photo of its linked item; without any photo, a "No photo" placeholder. Missing details show "—"; nothing is guessed. The photo is only loaded when the card is shown.
- **One date for every final invoice:** an invoice gets its final number when it is first fully paid. From now on the same step records its date: the day of that full payment (the real payment date, not the day it was typed in). After that the date stays fixed — later payments, corrections or a fall-back to "partly paid" do not move it.
  - The invoice list, the invoice page, the A5 PDF, the receipt, both CSV exports, the NBR export and the VAT lock all use this one date.
  - Final invoices from before this version keep their date exactly as before (calculated from the payments).
  - A full payment dated into a filed VAT quarter is refused before anything is saved.
- **Less database growth from now on:** new entries in the sync change log and in the audit log no longer copy the AI image vector of an item (about 28 KB each time). The vector stays with the item, photo search works as before. Measured: about two thirds of the daily growth came from these copies. The audit log keeps a short proof instead (number of values and a checksum).
- **"Backfill Embeddings" fixed** (Settings): the button now really saves the AI vector of items that have none. Before, it only wrote an audit entry.
- **Sync and recovery:**
  - The main computer no longer takes an AI vector back from its own sync server.
  - If the sync position ever has to be rebuilt, an old change that would now clash with newer data (for example a repair line whose position was later reused) is set aside in the sync quarantine instead of stopping the whole sync. Before, the sync stopped there and later changes were not applied.
- **Offline storage maintenance (prepared, not run):** a separate tool for the owner, used only while LATAIF is closed on all computers and the phone is idle, after a checked full backup on E: and F:. It is not part of the app and is not started by the update, by a normal start or by a database migration. Each part is a separate owner decision:
  1. Remove the copied AI vectors from old sync change log entries.
  2. Replace the AI vectors in old audit entries by their short proof (user, time and type of change stay).
  3. Remove old inline photos from old sync change log entries. Every such photo is first written to a folder in the data folder, byte for byte. Items that still show inline photos today are not touched.
  4. Compact both databases (main database and sync server database).

  Every step checks both databases before and after, keeps a log in `maintenance-logs`, can be stopped and continued, and never puts a half-finished file in place. **While a maintenance is open, LATAIF does not start** and shows a message; the tool releases it when it is done.

  Measured on a copy of the data from 18 November: main database 98.8 MB → 30.1 MB, sync server database 62.2 MB → 8.0 MB.

**Database:** one new column for the recorded final invoice date (added automatically at the first start, empty for existing invoices — they are not changed). Nothing is deleted, no entry of the change log or the audit log is rewritten by the update.

**Known limits:**
- **Second computer on v0.8.101:** it still shows the provisional date of a final invoice in the list, on the invoice page and in the PDF, and has no photo card in the repair list. Its data is safe: all its changes run on the main computer. Print final invoices on the main computer, or update the second computer to this version.
- **No correction for a recorded final invoice date:** if the payment that completed an invoice was entered with a wrong date, changing that payment date later does not move the invoice date or its VAT quarter.
- **"Reclaim free space…" in the app** (storage maintenance) compacts only the main database and does not compare every table afterwards. Prefer the offline maintenance for compacting: it checks every table of both databases before a compacted file is put in place.
- **Unchanged from v0.8.107:**
  - Remove (approval transfers) has no extra role check.
  - Older repairs book header costs at "Ready".
  - Supplier returns: a gain has no account; VAT on refunded added costs is not calculated.
  - Partners: production with a joint item and correcting a joint purchase line stay blocked.

**Before you update** (the main computer is on v0.8.107; the second computer is still on v0.8.101):

1. Stop entering anything on the phone, and wait until every phone upload has been processed on the main computer.
2. Check **Unresolved saves** on the second computer. Clarify open entries; do not remove them blindly.
3. Close both computers.
4. Make a full archive copy of the data folder (both databases, the complete media folder, the staging folders and the key files) on E: and F:, and check it.

**Update** the main computer. The second computer can stay on its version for now (see the known limits). Mixed versions work.
