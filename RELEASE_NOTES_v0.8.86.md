# LATAIF v0.8.86

A safety release: restoring a backup no longer makes data disappear without a trace.

- **Your current data is kept when you restore:** until now a restore replaced the databases and the photo
  folder and then deleted the previous state — photos removed from a gallery, photos of deleted items and
  everything entered since the backup were gone for good. Now the complete previous state (both databases and
  all photos) is kept as a pre-restore archive in the data folder (`restore-archive`). Nothing is deleted
  automatically.
- **Missing photos are taken over, checked:** a photo file that the restored data knows but the backup does
  not contain is copied back from the current folder — only when its name, size and content prove it is the
  same file. Which photos are visible in the galleries is decided by the backup alone; nothing is re-linked.
- **See what changes before you confirm:** Settings → Danger Zone → Backup & Restore → Restore now has
  "Show what changes": records added since the backup that would be gone, records that come back, gallery
  photos that come back or leave, files taken over, the size of the archive and the free disk space.
  Whatever is not compared (changes inside existing records) is shown as "not determined", never as a number.
  "Confirm restore" is available only after this preview.
- **Emergency restore:** if the preview cannot be made (for example because the current data is damaged), a
  restore is still possible, but only after an extra, deliberate confirmation that the effects are unknown.
  The owner password is checked by the server in every case.
- **Safer on errors:** a restore checks the free disk space before it touches anything and refuses when there
  is not enough (or it cannot be determined). If a restore is interrupted, the next start finishes it or rolls
  it back — and never deletes the previous state on the way. Every restore is recorded in
  `restore-history.jsonl` in the data folder (dates, backup, archive, result — no personal data).

**Before you update:** make a fresh backup of the main computer and check it.

**Update** the main computer and the second computer together. The database structure does not change, no
ledger backfill is needed, and stock values, bookings, VAT and invoices are not affected. Restore archives
contain the same sensitive data as backups (customer data, ID photos) and take as much space as the data
folder; they stay until you remove them.
