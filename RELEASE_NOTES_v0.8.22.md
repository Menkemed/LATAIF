# LATAIF v0.8.22

A focused **persistence-hardening patch**: v0.8.22 hardens persistence when native Windows
reload shortcuts (F5 / Ctrl+R) are used. It bundles two internal reliability fixes and adds
**no** new business features. This release performs **no** data migration and changes **no**
stored invoice, VAT, ledger, order, repair, reporting or NBR-export logic.

## Safe Native Reload Shortcuts
- **F5 and Ctrl+R are intercepted on Windows via the native WebView2 bridge** — the immediate
  native reload is suppressed.
- **New sync runs are paused**, and **an already-running sync is awaited** before saving.
- **The database is durably saved**, and only **after** the save is confirmed does the app
  reload in a controlled way.
- **On a save error the app does not reload and stays open**, so an unsaved in-memory state is
  not lost to a refresh.
- **Ctrl+F, Ctrl+P and F12 are unchanged** — only the reload shortcuts are handled.

## English Persistence Messages
- **The save/close overlay text is shown in English** ("Saving data. Please wait …").
- **Reload and close errors use appropriate, separate hints.**

## Not Included / Safety Notes
- **No** database migration.
- **No** stored invoice, VAT or ledger schema/posting change.
- **No** change to reports, the NBR export, orders, returns, credit notes or repairs.
- The native reload bridge is **Windows-only**; other platforms are unchanged.
- v0.8.22 is a **persistence-hardening patch** on top of v0.8.21 (bundles the
  native-reload-shortcut and English-overlay changes).
