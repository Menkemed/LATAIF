# LATAIF v0.8.23

A focused **shutdown-hardening patch**: v0.8.23 hardens application shutdown by moving final
process termination from the webview to the native Rust layer after durable database
persistence. It contains a single internal reliability fix and adds **no** new business
features. This release performs **no** data migration and changes **no** stored invoice, VAT,
ledger, order, repair, reporting or NBR-export logic.

## Reliable Native Shutdown
- **After a close, the app still waits for a running sync** before it saves.
- **The database is durably saved before the process is terminated.**
- **After a successful flush, a native Rust finalizer takes over.**
- **The embedded sync server is stopped in a controlled way.**
- **Port 3001 is released on a regular shutdown.**
- **The process is terminated via Tauri's native `AppHandle::exit(0)`.**
- **The previous `window.destroy()` / webview-timer finalization has been removed** — the final
  exit no longer depends on a timer running inside the webview.
- **On a persistence error the app stays open and allows a retry** — no termination without
  confirmed persistence.

## Not Included / Safety Notes
- **No** database migration.
- **No** stored invoice, VAT or ledger schema/posting change.
- **No** change to reports, the NBR export, orders, returns, credit notes or repairs.
- **No** change to the sync protocol, the updater flow or the native reload shortcuts.
- **Single-instance behaviour is unchanged** and remains outside the scope of this patch.
- v0.8.23 is a **shutdown-hardening patch** on top of v0.8.22 (bundles the native
  shutdown-finalization change only).
