# LATAIF v0.8.21

A focused **persistence-hardening patch**: v0.8.21 hardens persistence around mobile sync,
application updates, and controlled application shutdown. It bundles three internal reliability
fixes and adds **no** new business features. This release performs **no** data migration and
changes **no** stored invoice, VAT, ledger, order, repair, reporting or NBR-export logic.

## Mobile Sync Persistence
- **Remote sync batches are applied atomically** — a pulled batch is applied as one unit.
- **A batch is rolled back on any apply error**, so a partial, non-durable state is never left behind.
- **The sync cursor only advances after the database has been durably persisted**, confirmed by the
  persistence layer.
- **Failed or not-yet-saved mobile changes are therefore not silently skipped** — the next pull
  re-delivers the same changes (applying them is idempotent).

## Updater Persistence
- **Before install and relaunch, the current database is durably saved** and the save is confirmed.
- **On a save error or an install error, the app does not relaunch** — the running application stays
  open and the error is shown.
- **Duplicate parallel update runs are prevented** — a single-flight barrier stops a second update
  chain from starting.

## Controlled Shutdown
- **New sync runs are paused when the window is closing.**
- **An already-running sync is awaited before the final flush**, so its writes are included.
- **The window only closes after a successful database flush.**
- **On a persistence error the app stays open and shows an error**, allowing another attempt; it is
  never force-terminated before the data is confirmed on disk.

## Not Included / Safety Notes
- **No** database migration.
- **No** stored invoice, VAT or ledger schema/posting change.
- **No** change to reports, the NBR export, orders, returns, credit notes or repairs.
- **No** change to mobile image capture or resizing.
- v0.8.21 is a **persistence-hardening patch** on top of v0.8.20 (bundles the mobile-sync,
  updater and shutdown reliability fixes).
