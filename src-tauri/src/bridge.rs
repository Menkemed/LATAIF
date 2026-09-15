//! CENTRAL-C1 — die Brücke von einer Netzanfrage zur einen Geschäftsautorität.
//!
//! Der Ausgangspunkt ist eine Tatsache über diese Anwendung, nicht ein Entwurf: die
//! Geschäftsdatenbank gehört sql.js im Renderer, und es gibt **genau ein** Fenster. Rust hält
//! `lataif.db` ausdrücklich nur lesend. Ein zweiter Rechner kann also nicht selbst schreiben — er
//! muss den Primary bitten. Genau das ist hier gebaut:
//!
//! ```text
//!   Axum-Anfrage → op_id → Warteregister → Tauri-Ereignis → Renderer führt aus
//!                → Antwortkommando → oneshot → dieselbe HTTP-Antwort
//! ```
//!
//! Was diese Datei NICHT tut: sie führt nichts aus, sie kennt keine Geschäftsregel und sie nimmt
//! keinen Namen aus dem Netz an. Der Aufrufer nennt eine Operation aus einer festen Liste
//! (`REMOTE_OPS`); alles andere wird abgelehnt, bevor irgendetwas den Renderer erreicht. Es gibt
//! bewusst keinen allgemeinen „führe aus"-Endpunkt und keinen Weg, SQL zu übergeben.
//!
//! Die vier Lebenszyklusfälle sind der eigentliche Inhalt. Eine Zeitgrenze allein wäre eine
//! Ausrede: sie verwandelt jeden Fehler in dieselbe späte Enttäuschung. Deshalb:
//!
//!   • **Renderer nicht bereit** — vor der ersten Anmeldung einer Generation wird gar nicht
//!     gesendet (503). Ein Ereignis ins Leere zu schicken und dann 30 Sekunden zu warten wäre
//!     dasselbe Ergebnis mit 30 Sekunden Verzögerung und ohne Begründung.
//!   • **Neu geladen (F5)** — der alte Zuhörer ist weg. Der Renderer meldet beim Start eine NEUE
//!     Generation; damit scheitern alle offenen Aufträge der alten sofort und ausdrücklich. Sie
//!     dürfen nicht „weiterleben" und beim neuen Renderer landen: der weiß nichts von ihnen, und
//!     eine Geschäftsbuchung zweimal auszuführen wäre schlimmer als sie zu verlieren.
//!   • **Herunterfahren** — es werden keine neuen Aufträge angenommen, und die offenen scheitern
//!     kontrolliert, bevor das Fenster geht.
//!   • **Zeitgrenze** — begrenztes Warten, Eintrag wird entfernt, 504. Niemals unbegrenzt.
//!
//! Die Reihenfolge der Geschäftsschreibvorgänge wird NICHT hier hergestellt. Ein Mutex um sql.js
//! wäre eine zweite Autorität; die Serialisierung gehört in den Renderer, der die Datenbank hält.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

/// Der Ereignisname, unter dem ein Auftrag den Renderer erreicht. Muss exakt mit
/// `src/core/bridge/bridge-listener.ts` (BRIDGE_COMMAND_EVENT) uebereinstimmen.
pub const EVENT_COMMAND: &str = "central-c1-bridge-command";

/// Die eine Operation, die C1 freischaltet: eine Probe. Sie beweist den Weg von der Anfrage bis
/// zur Antwort und zurück und rührt keine Geschäftsdaten an. Produktive Schreibvorgänge
/// (Rechnung, Verkauf, Einkauf, Transfer, Kommission) kommen erst, wenn Reihenfolge,
/// Transaktionsgrenzen und Nummernkreise stehen.
pub const OP_PROBE: &str = "bridge.probe";

/// CENTRAL-C2 — die Lesevorgaenge, die ein zweiter Rechner ausloesen darf. Reine Auskunft: sie
/// veraendern nichts und laufen im Primary-Renderer auf der AKTUELLEN Datenbank, nicht auf der
/// Datei, die ihr hinterherhinkt.
pub const OP_PRODUCTS_LIST: &str = "products.list";
pub const OP_PRODUCTS_GET: &str = "products.get";
pub const OP_CUSTOMERS_LIST: &str = "customers.list";
pub const OP_CUSTOMERS_GET: &str = "customers.get";
pub const OP_INVOICES_LIST: &str = "invoices.list";
pub const OP_INVOICES_GET: &str = "invoices.get";

/// CENTRAL-C3B — die ERSTE veraendernde Fernoperation. Sie steht hier neben den Lesevorgaengen,
/// weil Rust dieselbe Liste ein zweites Mal prueft; die Entscheidung, ob eine Mutation ueberhaupt
/// registriert werden darf, faellt zusaetzlich im Renderer (Zulassungsliste, fail-closed).
pub const OP_INVOICES_CREATE: &str = "invoices.create";

/// CENTRAL-C3C — Stammdaten. Zwei Namen, nicht ein generisches "speichere irgendetwas": jede
/// veraendernde Operation steht einzeln hier und einzeln in der Zulassungsliste des Renderers.
pub const OP_CUSTOMERS_CREATE: &str = "customers.create";
pub const OP_CUSTOMERS_UPDATE: &str = "customers.update";
/// CENTRAL-C3C — ein Artikel von einem zweiten Rechner. Die Bilder kommen NICHT hier durch: sie
/// liegen vorher in der neutralen Zwischenablage (`/api/staging/media`), und der Auftrag nennt nur
/// ihre Inhaltskennungen.
pub const OP_PRODUCTS_CREATE: &str = "products.create";
pub const OP_PRODUCTS_UPDATE: &str = "products.update";
/// CENTRAL-C3D — eine Rechnung NACH dem Anlegen: aendern und bezahlen. Zwei Namen, weil es im
/// Haus zwei kanonische Wege sind (editInvoice / recordPayment) — kein generisches invoice.action.
pub const OP_INVOICES_UPDATE: &str = "invoices.update";
pub const OP_INVOICES_RECORD_PAYMENT: &str = "invoices.record_payment";

/// CENTRAL-C3E — Handelsbelege lesen: Lieferant, Einkauf, Kommission, Auftrag. Ohne diese
/// Auskuenfte koennte ein Client die drei Belege gar nicht anlegen — er haette keine Auswahl.
pub const OP_SUPPLIERS_LIST: &str = "suppliers.list";
pub const OP_CATEGORIES_LIST: &str = "categories.list";
pub const OP_PURCHASES_LIST: &str = "purchases.list";
pub const OP_PURCHASES_GET: &str = "purchases.get";
pub const OP_CONSIGNMENTS_LIST: &str = "consignments.list";
pub const OP_CONSIGNMENTS_GET: &str = "consignments.get";
pub const OP_ORDERS_LIST: &str = "orders.list";
pub const OP_ORDERS_GET: &str = "orders.get";

/// CENTRAL-C3E — und die fuenf veraendernden. Der Einkauf hat nur ein Anlegen, weil es im Haus
/// keine Bearbeitung eines Einkaufs GIBT; Kommission und Auftrag haben beides. Storno,
/// Rueckgabe, Verkauf, Auszahlung und die Umwandlung eines Auftrags in eine Rechnung stehen
/// ABSICHTLICH nicht hier: jede davon ist ein eigener Vorgang mit eigenen Beweisen.
pub const OP_PURCHASES_CREATE: &str = "purchases.create";
pub const OP_CONSIGNMENTS_CREATE: &str = "consignments.create";
pub const OP_CONSIGNMENTS_UPDATE: &str = "consignments.update";
pub const OP_ORDERS_CREATE: &str = "orders.create";
pub const OP_ORDERS_UPDATE: &str = "orders.update";

/// CENTRAL-C3F — Reparaturen und AGENTEN-Transfers. Der Transfer ist ausdruecklich KEIN
/// Filialtransfer: es gibt im Haus keine Quell-/Zielfiliale und keine Mengenbewegung, sondern
/// ein Stueck Ware bei einem Agenten. Statuswechsel am Artikel, kein Zwischenzustand.
pub const OP_REPAIRS_LIST: &str = "repairs.list";
pub const OP_REPAIRS_GET: &str = "repairs.get";
pub const OP_TRANSFERS_LIST: &str = "transfers.list";
pub const OP_TRANSFERS_GET: &str = "transfers.get";
pub const OP_REPAIRS_CREATE: &str = "repairs.create";
pub const OP_REPAIRS_UPDATE: &str = "repairs.update";
pub const OP_TRANSFERS_CREATE: &str = "transfers.create";
pub const OP_TRANSFERS_UPDATE: &str = "transfers.update";
/// Die Rueckgabe schliesst den normalen Kreislauf. Verkauf, Abrechnung, Rechnung und
/// Loeschen stehen ABSICHTLICH nicht hier: jedes ist ein eigener Geld- oder Zerstoerungsweg.
pub const OP_TRANSFERS_MARK_RETURNED: &str = "transfers.mark_returned";

/// CENTRAL-C3G — die Geldvorgaenge NACH dem Beleg. Sieben Namen aus einem Audit ueber
/// fuenfundzwanzig Aktionen; zerstoerende, administrative und Wiederherstellungs-Aktionen
/// (Beleg loeschen, Storno, Sondermarke, Undo) bleiben ABSICHTLICH Primary-only.
pub const OP_INVOICES_APPLY_CREDIT: &str = "invoices.apply_credit";
pub const OP_INVOICES_UPDATE_PAYMENT: &str = "invoices.update_payment";
pub const OP_INVOICES_DELETE_PAYMENT: &str = "invoices.delete_payment";
// CENTRAL-UI-PARITY R5F.1 — der Rechnungsstorno: die eine ausdruecklich freigegebene neue Buchung.
pub const OP_INVOICES_CANCEL: &str = "invoices.cancel";
pub const OP_ORDERS_CONVERT_TO_INVOICE: &str = "orders.convert_to_invoice";
pub const OP_CONSIGNMENTS_RECORD_PAYOUT: &str = "consignments.record_payout";
pub const OP_TRANSFERS_MARK_SOLD: &str = "transfers.mark_sold";
pub const OP_TRANSFERS_MARK_SETTLED: &str = "transfers.mark_settled";

/// CENTRAL-C3H — die sechzehn Aktionen, die C3G ausdruecklich als `B_DEFERRED` liegen liess:
/// die Rueckgabe-Kette (4), Auftragsstatus und Auftragszahlungen (3), Verkauf und Rueckgabe einer
/// Kommission (2), die Reparatur-Zustandsmaschine samt Rechnung und Arbeitszeilen (5) und die
/// beiden Wege vom Agenten-Transfer zur Rechnung (2). Keine Klasse-C-Aktion ist dabei:
/// Sondermarke, Beleg-Loeschung, Storno mit Geld, Verkaufs-Storno, Rueckgabe NACH dem Verkauf,
/// Reparatur-Loeschung und das Rueckgaengigmachen einer Transfer-Rechnung bleiben Primary-only.
pub const OP_RETURNS_CREATE: &str = "returns.create";
pub const OP_RETURNS_APPROVE: &str = "returns.approve";
pub const OP_RETURNS_REFUND: &str = "returns.refund";
pub const OP_RETURNS_RECORD_REFUND_PAYMENT: &str = "returns.record_refund_payment";
pub const OP_ORDERS_UPDATE_STATUS: &str = "orders.update_status";
pub const OP_ORDERS_ADD_PAYMENT: &str = "orders.add_payment";
pub const OP_ORDERS_DELETE_PAYMENT: &str = "orders.delete_payment";
pub const OP_CONSIGNMENTS_RECORD_SALE: &str = "consignments.record_sale";
pub const OP_CONSIGNMENTS_MARK_RETURNED: &str = "consignments.mark_returned";
pub const OP_REPAIRS_UPDATE_STATUS: &str = "repairs.update_status";
pub const OP_REPAIRS_CREATE_INVOICE: &str = "repairs.create_invoice";
pub const OP_REPAIRS_ADD_LINE: &str = "repairs.add_line";
pub const OP_REPAIRS_UPDATE_LINE: &str = "repairs.update_line";
pub const OP_REPAIRS_CANCEL_LINE: &str = "repairs.cancel_line";
pub const OP_TRANSFERS_CONVERT_TO_INVOICE: &str = "transfers.convert_to_invoice";
pub const OP_TRANSFERS_CONVERT_MANY_TO_INVOICE: &str = "transfers.convert_many_to_invoice";

// CENTRAL-UI-PARITY R1 — die Auskuenfte der gemeinsamen Oberflaeche. Der Client nennt einen
// dieser Namen, nie eine Abfrage; die Liste deckt sich Zeichen fuer Zeichen mit dem Renderer.
pub const OP_STORE_PRODUCTS_GET: &str = "store.products.get";
pub const OP_STORE_CUSTOMERS_GET: &str = "store.customers.get";
pub const OP_STORE_INVOICES_GET: &str = "store.invoices.get";
pub const OP_ORDER_PAYMENTS_GET: &str = "order_payments.get";
pub const OP_SESSION_CONTEXT_GET: &str = "session.context.get";
pub const OP_STORE_SUPPLIERS_GET: &str = "store.suppliers.get";
pub const OP_STORE_SALES_RETURNS_GET: &str = "store.sales_returns.get";
pub const OP_STORE_CREDIT_NOTES_GET: &str = "store.credit_notes.get";
pub const OP_STORE_ORDERS_GET: &str = "store.orders.get";
pub const OP_STORE_CONSIGNMENTS_GET: &str = "store.consignments.get";
pub const OP_STORE_PURCHASES_GET: &str = "store.purchases.get";
pub const OP_STORE_REPAIRS_GET: &str = "store.repairs.get";
pub const OP_STORE_AGENTS_GET: &str = "store.agents.get";

// CENTRAL-UI-PARITY R2B — der Rest der Lesefläche: Finanzen und Betriebsfuehrung.
pub const OP_STORE_EXPENSES_GET: &str = "store.expenses.get";
pub const OP_STORE_RECURRING_EXPENSES_GET: &str = "store.recurring_expenses.get";
pub const OP_STORE_BANKING_GET: &str = "store.banking.get";
pub const OP_STORE_PAYABLES_GET: &str = "store.payables.get";
pub const OP_STORE_DEBTS_GET: &str = "store.debts.get";
pub const OP_STORE_GOLD_GET: &str = "store.gold.get";
pub const OP_STORE_METALS_GET: &str = "store.metals.get";
pub const OP_STORE_SCRAP_TRADES_GET: &str = "store.scrap_trades.get";
pub const OP_STORE_EMPLOYEES_GET: &str = "store.employees.get";
pub const OP_STORE_PARTNERS_GET: &str = "store.partners.get";
pub const OP_STORE_TASKS_GET: &str = "store.tasks.get";
pub const OP_STORE_DOCUMENTS_GET: &str = "store.documents.get";
pub const OP_STORE_OFFERS_GET: &str = "store.offers.get";
pub const OP_STORE_PRODUCTION_GET: &str = "store.production.get";

// CENTRAL-UI-PARITY R2C — der Schluss der Lesefläche.
pub const OP_STORE_ANALYTICS_GET: &str = "store.analytics.get";
pub const OP_ANALYTICS_VAT_EXPORT_GET: &str = "analytics.vat_export.get";
pub const OP_DOCUMENTS_CONTENT_GET: &str = "documents.content.get";

// CENTRAL-UI-PARITY R2D — die Flächen, die bisher selbst abfragten.
pub const OP_PAGE_DASHBOARD_GET: &str = "page.dashboard.get";
pub const OP_PAGE_INVOICE_LIST_GET: &str = "page.invoice_list.get";
pub const OP_PAGE_ORDER_LIST_GET: &str = "page.order_list.get";
pub const OP_PAGE_CUSTOMER_DETAIL_GET: &str = "page.customer_detail.get";
pub const OP_PAGE_ORDER_DETAIL_GET: &str = "page.order_detail.get";
pub const OP_PAGE_SUPPLIER_DETAIL_GET: &str = "page.supplier_detail.get";
pub const OP_PAGE_PRODUCT_DETAIL_GET: &str = "page.product_detail.get";
pub const OP_PAGE_PURCHASE_CREATE_GET: &str = "page.purchase_create.get";
pub const OP_REFS_NUMBERS_GET: &str = "refs.numbers.get";
pub const OP_METALS_STOCK_BY_KARAT_GET: &str = "metals.stock_by_karat.get";
pub const OP_SEARCH_GLOBAL_GET: &str = "search.global.get";
pub const OP_PAGE_RECONCILIATION_GET: &str = "page.reconciliation.get";

// CENTRAL-UI-PARITY R4A — die Kernauskuenfte hinter den Seiten.
pub const OP_LEDGER_BALANCES_GET: &str = "ledger.balances.get";
pub const OP_FINANCE_RECEIVABLES_GET: &str = "finance.receivables.get";
pub const OP_INVENTORY_LOT_AGGREGATES_GET: &str = "inventory.lot_aggregates.get";
pub const OP_PRODUCT_LOTS_GET: &str = "product.lots.get";
pub const OP_PRODUCT_LOTS_BATCH_GET: &str = "product.lots.batch.get";
pub const OP_EXPENSES_CREDIT_PAID_GET: &str = "expenses.credit_paid.get";

// CENTRAL-UI-PARITY R6C — Stammdaten und Inventur. Eine fachliche Aktion, ein Name: drei
// „+ New Supplier"-Knoepfe sind EIN `suppliers.create`, „Deactivate" ist `suppliers.update`.
// Die Inventur hat vier getrennte Absichten (beginnen, speichern, abschliessen, Einzel-Check) und
// zwei Auskuenfte; keine davon aendert Bestand oder Hauptbuch. Loeschen bleibt Primary-only.
pub const OP_SUPPLIERS_CREATE: &str = "suppliers.create";
pub const OP_SUPPLIERS_UPDATE: &str = "suppliers.update";
pub const OP_AGENTS_UPDATE: &str = "agents.update";
pub const OP_PARTNERS_CREATE: &str = "partners.create";
pub const OP_PARTNERS_UPDATE: &str = "partners.update";
pub const OP_EMPLOYEES_CREATE: &str = "employees.create";
pub const OP_EMPLOYEES_UPDATE: &str = "employees.update";
pub const OP_INVENTORY_START: &str = "inventory.start";
pub const OP_INVENTORY_SAVE: &str = "inventory.save";
pub const OP_INVENTORY_FINISH: &str = "inventory.finish";
pub const OP_INVENTORY_RECORD_CHECK: &str = "inventory.record_check";
pub const OP_INVENTORY_SESSION_GET: &str = "inventory.session.get";
pub const OP_INVENTORY_CHECKS_GET: &str = "inventory.checks.get";

// CENTRAL-UI-PARITY R6D — Steuer, Geld, Gold und Metall. Eine fachliche Absicht, ein Name: „Pay" an
// vier Stellen ist EIN `expenses.record_payment`, die fuenf Abrechnungsarten des Gold-Modals sind ZWEI
// Namen (je Gold-Topf einer), „Verkaufen"/„Schmelzen" ist ein Zustandswechsel. Loeschen bleibt
// Primary-only; die Nachbuchung (Backfill) bleibt Werkzeug des Primary.
pub const OP_TAX_RECORD_PAYMENT: &str = "tax.record_payment";
pub const OP_BANKING_TRANSFER: &str = "banking.transfer";
pub const OP_PARTNERS_RECORD_TX: &str = "partners.record_tx";
pub const OP_DEBTS_CREATE: &str = "debts.create";
pub const OP_DEBTS_UPDATE: &str = "debts.update";
pub const OP_DEBTS_RECORD_PAYMENT: &str = "debts.record_payment";
pub const OP_EXPENSES_CREATE: &str = "expenses.create";
pub const OP_EXPENSES_UPDATE: &str = "expenses.update";
pub const OP_EXPENSES_RECORD_PAYMENT: &str = "expenses.record_payment";
pub const OP_EXPENSES_TEMPLATE_CREATE: &str = "expenses.template_create";
pub const OP_EXPENSES_TEMPLATE_UPDATE: &str = "expenses.template_update";
pub const OP_PURCHASES_RECORD_PAYMENT: &str = "purchases.record_payment";
pub const OP_PURCHASES_APPLY_CREDIT: &str = "purchases.apply_credit";
pub const OP_SUPPLIERS_PAY: &str = "suppliers.pay";
pub const OP_SUPPLIERS_APPLY_CREDIT: &str = "suppliers.apply_credit";
pub const OP_SUPPLIERS_REFUND_CREDIT: &str = "suppliers.refund_credit";
pub const OP_GOLD_PAYABLES_SETTLE: &str = "gold.payables.settle";
pub const OP_GOLD_CUSTOMER_CREDITS_SETTLE: &str = "gold.customer_credits.settle";
pub const OP_REPAIRS_RECORD_GOLD_USAGE: &str = "repairs.record_gold_usage";
pub const OP_REPAIRS_ADD_MATERIAL: &str = "repairs.add_material";
pub const OP_ORDERS_ADD_COST: &str = "orders.add_cost";
pub const OP_ORDERS_REMOVE_COST: &str = "orders.remove_cost";
pub const OP_METALS_CREATE: &str = "metals.create";
pub const OP_METALS_UPDATE_STATUS: &str = "metals.update_status";
pub const OP_METALS_SET_SPOT_PRICE: &str = "metals.set_spot_price";
pub const OP_SCRAP_TRADES_CREATE: &str = "scrap_trades.create";
pub const OP_SCRAP_TRADES_UPDATE: &str = "scrap_trades.update";
pub const OP_SCRAP_TRADES_CANCEL: &str = "scrap_trades.cancel";
pub const OP_METALS_SPOT_PRICES_GET: &str = "metals.spot_prices.get";
pub const OP_DEBTS_PAYMENTS_GET: &str = "debts.payments.get";
pub const OP_SUPPLIERS_CREDITS_GET: &str = "suppliers.credits.get";
// CENTRAL-UI-PARITY R6E — Angebot, Rechnungs-Lebenszyklus, Nachrichtenprotokoll.
pub const OP_OFFERS_CREATE: &str = "offers.create";
pub const OP_OFFERS_UPDATE: &str = "offers.update";
pub const OP_OFFERS_SET_STATUS: &str = "offers.set_status";
pub const OP_OFFERS_CONVERT_TO_INVOICE: &str = "offers.convert_to_invoice";
pub const OP_INVOICES_SET_BUTTERFLY: &str = "invoices.set_butterfly";
pub const OP_RETURNS_CANCEL: &str = "returns.cancel";
pub const OP_TRANSFERS_UNDO_CONVERT: &str = "transfers.undo_convert";
pub const OP_CUSTOMERS_LOG_MESSAGE: &str = "customers.log_message";
// CENTRAL-UI-PARITY R6F — Einkauf, Auftrag, Kommission, Produktion, Aufgaben, Dokumente.
pub const OP_PURCHASES_RETURN_TO_SUPPLIER: &str = "purchases.return_to_supplier";
pub const OP_PURCHASES_CANCEL: &str = "purchases.cancel";
pub const OP_PURCHASES_DISMISS_INBOX: &str = "purchases.dismiss_inbox";
pub const OP_ORDERS_CANCEL: &str = "orders.cancel";
pub const OP_ORDERS_UPDATE_LINE_STATUS: &str = "orders.update_line_status";
pub const OP_ORDERS_MARK_LINE_ORDERED: &str = "orders.mark_line_ordered";
pub const OP_ORDERS_UPDATE_LINE: &str = "orders.update_line";
pub const OP_CONSIGNMENTS_RETURN_AFTER_SALE: &str = "consignments.return_after_sale";
pub const OP_CONSIGNMENTS_CANCEL_SALE: &str = "consignments.cancel_sale";
pub const OP_PRODUCTION_CREATE: &str = "production.create";
pub const OP_TASKS_CREATE: &str = "tasks.create";
pub const OP_TASKS_UPDATE: &str = "tasks.update";
pub const OP_DOCUMENTS_UPLOAD: &str = "documents.upload";
pub const OP_DOCUMENTS_SET_OCR: &str = "documents.set_ocr";
// POST-PARITY R7A (PP-2) — der Fertigungsabschluss (Arbeit + Gemeinkosten genau einmal gebucht).
pub const OP_PRODUCTION_COMPLETE: &str = "production.complete";

// CENTRAL-UI-PARITY — die Store-Auskuenfte. Der zweite Rechner nennt einen STORE, keine
// Abfrage: die Liste hier ist die Erlaubnis, und sie deckt sich Zeichen fuer Zeichen mit
// `STORE_SOURCES` im Renderer. Ein Name, der hier fehlt, erreicht den Renderer nie.

/// Die Zulassungsliste. Ein Name, der hier nicht steht, erreicht den Renderer nie.
pub const REMOTE_OPS: &[&str] = &[
    OP_PROBE,
    OP_PRODUCTS_LIST,
    OP_PRODUCTS_GET,
    OP_CUSTOMERS_LIST,
    OP_CUSTOMERS_GET,
    OP_INVOICES_LIST,
    OP_INVOICES_GET,
    OP_INVOICES_CREATE,
    OP_CUSTOMERS_CREATE,
    OP_CUSTOMERS_UPDATE,
    OP_PRODUCTS_CREATE,
    OP_PRODUCTS_UPDATE,
    OP_INVOICES_UPDATE,
    OP_INVOICES_RECORD_PAYMENT,
    OP_SUPPLIERS_LIST,
    OP_CATEGORIES_LIST,
    OP_PURCHASES_LIST,
    OP_PURCHASES_GET,
    OP_CONSIGNMENTS_LIST,
    OP_CONSIGNMENTS_GET,
    OP_ORDERS_LIST,
    OP_ORDERS_GET,
    OP_PURCHASES_CREATE,
    OP_CONSIGNMENTS_CREATE,
    OP_CONSIGNMENTS_UPDATE,
    OP_ORDERS_CREATE,
    OP_ORDERS_UPDATE,
    OP_REPAIRS_LIST,
    OP_REPAIRS_GET,
    OP_TRANSFERS_LIST,
    OP_TRANSFERS_GET,
    OP_REPAIRS_CREATE,
    OP_REPAIRS_UPDATE,
    OP_TRANSFERS_CREATE,
    OP_TRANSFERS_UPDATE,
    OP_TRANSFERS_MARK_RETURNED,
    OP_INVOICES_APPLY_CREDIT,
    OP_INVOICES_UPDATE_PAYMENT,
    OP_INVOICES_DELETE_PAYMENT,
    OP_ORDERS_CONVERT_TO_INVOICE,
    OP_CONSIGNMENTS_RECORD_PAYOUT,
    OP_TRANSFERS_MARK_SOLD,
    OP_TRANSFERS_MARK_SETTLED,
    OP_RETURNS_CREATE,
    OP_RETURNS_APPROVE,
    OP_RETURNS_REFUND,
    OP_RETURNS_RECORD_REFUND_PAYMENT,
    OP_ORDERS_UPDATE_STATUS,
    OP_ORDERS_ADD_PAYMENT,
    OP_ORDERS_DELETE_PAYMENT,
    OP_CONSIGNMENTS_RECORD_SALE,
    OP_CONSIGNMENTS_MARK_RETURNED,
    OP_REPAIRS_UPDATE_STATUS,
    OP_REPAIRS_CREATE_INVOICE,
    OP_REPAIRS_ADD_LINE,
    OP_REPAIRS_UPDATE_LINE,
    OP_REPAIRS_CANCEL_LINE,
    OP_TRANSFERS_CONVERT_TO_INVOICE,
    OP_TRANSFERS_CONVERT_MANY_TO_INVOICE,
    OP_INVOICES_CANCEL,
    OP_STORE_PRODUCTS_GET,
    OP_STORE_CUSTOMERS_GET,
    OP_STORE_INVOICES_GET,
    OP_ORDER_PAYMENTS_GET,
    OP_SESSION_CONTEXT_GET,
    OP_STORE_SUPPLIERS_GET,
    OP_STORE_SALES_RETURNS_GET,
    OP_STORE_CREDIT_NOTES_GET,
    OP_STORE_ORDERS_GET,
    OP_STORE_CONSIGNMENTS_GET,
    OP_STORE_PURCHASES_GET,
    OP_STORE_REPAIRS_GET,
    OP_STORE_AGENTS_GET,
    OP_STORE_EXPENSES_GET,
    OP_STORE_RECURRING_EXPENSES_GET,
    OP_STORE_BANKING_GET,
    OP_STORE_PAYABLES_GET,
    OP_STORE_DEBTS_GET,
    OP_STORE_GOLD_GET,
    OP_STORE_METALS_GET,
    OP_STORE_SCRAP_TRADES_GET,
    OP_STORE_EMPLOYEES_GET,
    OP_STORE_PARTNERS_GET,
    OP_STORE_TASKS_GET,
    OP_STORE_DOCUMENTS_GET,
    OP_STORE_OFFERS_GET,
    OP_STORE_PRODUCTION_GET,
    OP_STORE_ANALYTICS_GET,
    OP_ANALYTICS_VAT_EXPORT_GET,
    OP_DOCUMENTS_CONTENT_GET,
    OP_PAGE_DASHBOARD_GET,
    OP_PAGE_INVOICE_LIST_GET,
    OP_PAGE_ORDER_LIST_GET,
    OP_PAGE_CUSTOMER_DETAIL_GET,
    OP_PAGE_ORDER_DETAIL_GET,
    OP_PAGE_SUPPLIER_DETAIL_GET,
    OP_PAGE_PRODUCT_DETAIL_GET,
    OP_PAGE_PURCHASE_CREATE_GET,
    OP_REFS_NUMBERS_GET,
    OP_METALS_STOCK_BY_KARAT_GET,
    OP_SEARCH_GLOBAL_GET,
    OP_PAGE_RECONCILIATION_GET,
    OP_LEDGER_BALANCES_GET,
    OP_FINANCE_RECEIVABLES_GET,
    OP_INVENTORY_LOT_AGGREGATES_GET,
    OP_PRODUCT_LOTS_GET,
    OP_PRODUCT_LOTS_BATCH_GET,
    OP_EXPENSES_CREDIT_PAID_GET,
    OP_SUPPLIERS_CREATE,
    OP_SUPPLIERS_UPDATE,
    OP_AGENTS_UPDATE,
    OP_PARTNERS_CREATE,
    OP_PARTNERS_UPDATE,
    OP_EMPLOYEES_CREATE,
    OP_EMPLOYEES_UPDATE,
    OP_INVENTORY_START,
    OP_INVENTORY_SAVE,
    OP_INVENTORY_FINISH,
    OP_INVENTORY_RECORD_CHECK,
    OP_INVENTORY_SESSION_GET,
    OP_INVENTORY_CHECKS_GET,
    OP_TAX_RECORD_PAYMENT,
    OP_BANKING_TRANSFER,
    OP_PARTNERS_RECORD_TX,
    OP_DEBTS_CREATE,
    OP_DEBTS_UPDATE,
    OP_DEBTS_RECORD_PAYMENT,
    OP_EXPENSES_CREATE,
    OP_EXPENSES_UPDATE,
    OP_EXPENSES_RECORD_PAYMENT,
    OP_EXPENSES_TEMPLATE_CREATE,
    OP_EXPENSES_TEMPLATE_UPDATE,
    OP_PURCHASES_RECORD_PAYMENT,
    OP_PURCHASES_APPLY_CREDIT,
    OP_SUPPLIERS_PAY,
    OP_SUPPLIERS_APPLY_CREDIT,
    OP_SUPPLIERS_REFUND_CREDIT,
    OP_GOLD_PAYABLES_SETTLE,
    OP_GOLD_CUSTOMER_CREDITS_SETTLE,
    OP_REPAIRS_RECORD_GOLD_USAGE,
    OP_REPAIRS_ADD_MATERIAL,
    OP_ORDERS_ADD_COST,
    OP_ORDERS_REMOVE_COST,
    OP_METALS_CREATE,
    OP_METALS_UPDATE_STATUS,
    OP_METALS_SET_SPOT_PRICE,
    OP_SCRAP_TRADES_CREATE,
    OP_SCRAP_TRADES_UPDATE,
    OP_SCRAP_TRADES_CANCEL,
    OP_METALS_SPOT_PRICES_GET,
    OP_DEBTS_PAYMENTS_GET,
    OP_SUPPLIERS_CREDITS_GET,
    OP_OFFERS_CREATE,
    OP_OFFERS_UPDATE,
    OP_OFFERS_SET_STATUS,
    OP_OFFERS_CONVERT_TO_INVOICE,
    OP_INVOICES_SET_BUTTERFLY,
    OP_RETURNS_CANCEL,
    OP_TRANSFERS_UNDO_CONVERT,
    OP_CUSTOMERS_LOG_MESSAGE,
    OP_PURCHASES_RETURN_TO_SUPPLIER,
    OP_PURCHASES_CANCEL,
    OP_PURCHASES_DISMISS_INBOX,
    OP_ORDERS_CANCEL,
    OP_ORDERS_UPDATE_LINE_STATUS,
    OP_ORDERS_MARK_LINE_ORDERED,
    OP_ORDERS_UPDATE_LINE,
    OP_CONSIGNMENTS_RETURN_AFTER_SALE,
    OP_CONSIGNMENTS_CANCEL_SALE,
    OP_PRODUCTION_CREATE,
    OP_TASKS_CREATE,
    OP_TASKS_UPDATE,
    OP_DOCUMENTS_UPLOAD,
    OP_DOCUMENTS_SET_OCR,
    OP_PRODUCTION_COMPLETE,
];

/// Wie lange auf den Renderer gewartet wird, wenn niemand etwas anderes vorgibt.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(20);

// ── POST-PARITY R7B PP-12 — die Frist der Dokumentwege ──────────────────────────────────────────
//
// Normale Aufträge behalten `DEFAULT_TIMEOUT`. Genau drei Wege tragen eine ganze Datei durch den
// Primary und bekommen einen Zuschlag, abgeleitet aus ihrem GRÖSSTEN zulässigen Fall:
//
//   documents.upload       der Rumpf trägt die Datei (Data-URL) — Zuschlag nach ihrer Länge;
//   documents.content.get  die Antwort trägt sie; die Anfrage kennt ihre Länge nicht — die größte;
//   documents.set_ocr      die Erkennung liest sie; ihr Aufwand hängt an den Bildpunkten, die der
//                          Renderer vor der Erkennung auf `OCR_MAX_PIXELS` begrenzt (`ocr-service.ts`).
//
// Die Größe stammt aus dem Vertrag des Hauses: eine Dokumentzeile muss in eine Abgleich-Änderung
// passen (`sync-business-schema.json` `max_payload_bytes` = 32 MiB); daraus folgt die größte Datei
// (25 116 672 B, `DOCUMENT_MAX_FILE_BYTES`). Die Geschwindigkeiten sind UNTERGRENZEN; der
// Zwei-Rechner-Lauf misst die echten Zeiten des größten Falls und prüft den Abstand zur Frist.
// Eine abgelaufene Frist bleibt `unknown` (504), nie ein Erfolg; die Wiederholung mit derselben
// Kennung bleibt genau eine Wirkung (durabler Nachweis im Renderer).
//
// R7B-Review (PP-12, Befund): die beiden SCHREIBENDEN Dokumentwege antworten erst nach dem durablen
// Speichern — und das schreibt die GANZE Datenbank (sql.js-Export → Datei), nicht nur die neue
// Zeile. Gemessen stieg die Zeit des größten Uploads mit der Datenbank (69/136/203 MB → 17,9/23,0/
// 31,3 s), die Frist nicht. Deshalb bekommen `documents.upload` und `documents.set_ocr` einen zweiten
// Zuschlag: die Datenbankgröße, die der Primary auf der Platte sieht, plus das Wachstum durch den
// Upload (die Daten-URL steht in der Dokumentzeile UND in ihrer Abgleich-Zeile), zur Untergrenze
// `SAVE_FLOOR_BYTES_PER_SEC`. `documents.content.get` liest nur und speichert nichts.

/// Die größte Dokumentzeile (= größte Data-URL), die das Haus annimmt: 32 MiB.
pub const DOCUMENT_MAX_CONTENT_BYTES: u64 = 32 * 1024 * 1024;
/// So oft bewegt ein Upload seine Bytes am Primary: JSON lesen, Fingerabdruck, Übergabe ans
/// Fenster, Inhaltsprüfung, Zeile, Abgleich-Zeile, zwei Größenprüfungen, durables Abbild (2 Zeilen).
pub const DOCUMENT_UPLOAD_PASSES: u64 = 10;
/// So oft bewegt eine Inhaltsauskunft sie: Zeile lesen, Übergabe zurück, JSON, HTTP.
pub const DOCUMENT_CONTENT_PASSES: u64 = 4;
/// Untergrenze für das Bewegen von Dokumentbytes am Primary: 10 MB/s.
pub const DOCUMENT_FLOOR_BYTES_PER_SEC: u64 = 10_000_000;
/// Höchstens so viele Bildpunkte bekommt die Texterkennung (`ocr-service.ts` `OCR_MAX_PIXELS`).
pub const OCR_MAX_PIXELS: u64 = 12_000_000;
/// Untergrenze der Erkennung: 0,2 Megapixel je Sekunde.
pub const OCR_FLOOR_PIXELS_PER_SEC: u64 = 200_000;
/// Start der Erkennung (Worker, Kern, eng+ara laden) — einmal je Aufruf.
pub const OCR_WORKER_START: Duration = Duration::from_secs(10);

/// Untergrenze für das durable Speichern der ganzen Datenbank am Primary: 4 MB/s. Gemessen wurden
/// rund 10 MB/s (R7B-Review: +134 MB Datenbank → +13,4 s); die Untergrenze lässt das 2,5-Fache Luft.
pub const SAVE_FLOOR_BYTES_PER_SEC: u64 = 4_000_000;
/// Um so viele Kopien seiner Daten-URL wächst die Datenbank durch einen Upload: Dokumentzeile und
/// Abgleich-Zeile (`trackChange` hält die ganze Zeile).
pub const DOCUMENT_UPLOAD_GROWTH_COPIES: u64 = 2;

fn bytes_at_floor(bytes: u64) -> Duration {
    Duration::from_millis(bytes.saturating_mul(1000) / DOCUMENT_FLOOR_BYTES_PER_SEC)
}

fn save_at_floor(bytes: u64) -> Duration {
    Duration::from_millis(bytes.saturating_mul(1000) / SAVE_FLOOR_BYTES_PER_SEC)
}

/// Die Frist eines Auftrags vom zweiten Rechner (s. o.). Alles außer den drei Dokumentwegen: 20 s.
/// `db_bytes` ist die Größe der Geschäftsdatenbank am Primary (die Datei, die das Speichern schreibt).
pub fn timeout_for(op: &str, payload: &serde_json::Value, db_bytes: u64) -> Duration {
    match op {
        OP_DOCUMENTS_UPLOAD => {
            let len = payload.get("content").and_then(|v| v.as_str()).map(|s| s.len() as u64).unwrap_or(0);
            let len = len.min(DOCUMENT_MAX_CONTENT_BYTES);
            DEFAULT_TIMEOUT
                + bytes_at_floor(len * DOCUMENT_UPLOAD_PASSES)
                + save_at_floor(db_bytes.saturating_add(len * DOCUMENT_UPLOAD_GROWTH_COPIES))
        }
        OP_DOCUMENTS_CONTENT_GET => {
            DEFAULT_TIMEOUT + bytes_at_floor(DOCUMENT_MAX_CONTENT_BYTES * DOCUMENT_CONTENT_PASSES)
        }
        OP_DOCUMENTS_SET_OCR => {
            DEFAULT_TIMEOUT
                + OCR_WORKER_START
                + Duration::from_secs(OCR_MAX_PIXELS / OCR_FLOOR_PIXELS_PER_SEC)
                + save_at_floor(db_bytes)
        }
        _ => DEFAULT_TIMEOUT,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BridgeError {
    /// Der Renderer hat noch keine Generation angemeldet — die Geschäftsmaschine läuft nicht.
    NotReady,
    /// Es wird heruntergefahren; neue Aufträge werden nicht mehr angenommen.
    ShuttingDown,
    /// Der Name steht nicht in `REMOTE_OPS`.
    OpNotAllowed,
    /// Der Renderer wurde neu geladen, während dieser Auftrag offen war.
    Reloaded,
    /// Der Renderer hat innerhalb der Frist nicht geantwortet.
    Timeout,
    /// Das Ereignis konnte nicht zugestellt werden (kein Fenster, Kanal tot).
    DeliveryFailed,
    /// Die mitgeschickte logische Kennung ist kein UUID.
    BadCommandId,
    /// Dieselbe Kennung wurde schon fuer etwas anderes benutzt (anderer Absender/Operation).
    CommandIdConflict,
}

impl BridgeError {
    pub fn code(&self) -> &'static str {
        match self {
            BridgeError::NotReady => "BRIDGE_RENDERER_NOT_READY",
            BridgeError::ShuttingDown => "BRIDGE_SHUTTING_DOWN",
            BridgeError::OpNotAllowed => "BRIDGE_OP_NOT_ALLOWED",
            BridgeError::Reloaded => "BRIDGE_RENDERER_RELOADED",
            BridgeError::Timeout => "BRIDGE_TIMEOUT",
            BridgeError::DeliveryFailed => "BRIDGE_DELIVERY_FAILED",
            BridgeError::BadCommandId => "BRIDGE_BAD_COMMAND_ID",
            BridgeError::CommandIdConflict => "BRIDGE_COMMAND_ID_CONFLICT",
        }
    }

    /// Sagt dieser Fehler etwas ueber die Ausfuehrung? Die Grenze ist die Zustellung: alles, was
    /// VOR dem Senden scheitert, ist sicher nicht passiert; alles danach ist offen.
    pub fn outcome(&self) -> Outcome {
        match self {
            // Nie gesendet.
            BridgeError::NotReady
            | BridgeError::ShuttingDown
            | BridgeError::OpNotAllowed
            | BridgeError::BadCommandId
            | BridgeError::CommandIdConflict
            | BridgeError::DeliveryFailed => Outcome::NotExecuted,
            // War unterwegs — der Renderer kann ihn ausgefuehrt haben.
            BridgeError::Timeout | BridgeError::Reloaded => Outcome::Unknown,
        }
    }

    /// Der Statuscode, den der Client sieht. 503 heißt „später nochmal", 504 „hat zu lange
    /// gedauert", 400 „so nicht" — jeder davon ist eine andere Handlungsanweisung, deshalb werden
    /// sie nicht zu einem gemeinsamen Fehler verschmolzen.
    pub fn http_status(&self) -> u16 {
        match self {
            BridgeError::OpNotAllowed | BridgeError::BadCommandId => 400,
            // Ein Widerspruch, kein Serverfehler: derselbe Name fuer zwei verschiedene Dinge.
            BridgeError::CommandIdConflict => 409,
            BridgeError::Timeout => 504,
            BridgeError::NotReady | BridgeError::ShuttingDown => 503,
            BridgeError::Reloaded | BridgeError::DeliveryFailed => 503,
        }
    }
}

/// Was ein Fehler über die AUSFÜHRUNG aussagt — und das ist etwas anderes als sein Code.
///
/// Der Unterschied ist der wichtigste in dieser Datei. „Zeitgrenze" hieß bisher stillschweigend
/// „nicht passiert". Das ist falsch: der Auftrag WAR beim Renderer, der kann ihn vollständig
/// ausgeführt und gespeichert haben, und nur die Antwort ging verloren. Ein Client, der daraufhin
/// wiederholt, bucht ein zweites Mal.
///
/// Deshalb zwei Klassen, und die Grenze liegt exakt bei der Zustellung:
///   • **NotExecuted** — es wurde gar nicht erst gesendet. Sicher nichts passiert, gefahrlos
///     wiederholbar.
///   • **Unknown** — es war unterwegs. Ob es lief, weiß niemand. Wiederholen NUR mit derselben
///     logischen Kennung und einem durablen Nachweis; den gibt es in C1 noch nicht.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    NotExecuted,
    Unknown,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::NotExecuted => "not_executed",
            Outcome::Unknown => "unknown",
        }
    }
}

/// Was an den Renderer geht. `generation` ist mitgeschickt, damit eine Antwort ihrem Auftrag
/// zugeordnet werden kann, ohne dem Renderer zu glauben.
#[derive(Debug, Clone, Serialize)]
pub struct Envelope {
    pub op_id: String,
    pub op: String,
    pub generation: u64,
    pub payload: serde_json::Value,
    /// CENTRAL-C3B — wer diesen Auftrag verantwortet. Fuer eine Auskunft ist das entbehrlich; fuer
    /// eine Buchung nicht: der durable Nachweis im Renderer wird auf genau diese Kennung
    /// geschluesselt. Sie kommt aus den geprueften Anmeldedaten, NIE aus dem Rumpf des Clients.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity: Option<EnvelopeIdentity>,
}

/// Die Identitaet, wie der Renderer sie sieht. `op` steht schon im Umschlag.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvelopeIdentity {
    pub command_id: String,
    pub tenant_id: String,
    pub branch_id: String,
    pub user_id: String,
    pub payload_hash: String,
    /// CENTRAL-C4 — die Rolle des Fragenden, aus DENSELBEN geprueften Anspruechen. Sie steht
    /// bewusst hier und NICHT in `CommandIdentity`: die Bindung des durablen Nachweises bleibt
    /// Kennung + Mandant + Filiale + Benutzer + Operation + Rumpf-Fingerabdruck. Die Rolle
    /// entscheidet nur, OB der Auftrag ueberhaupt laufen darf — das prueft der Renderer an
    /// derselben Tabelle, die auch seine Bildschirme fragen.
    pub role: String,
}

impl EnvelopeIdentity {
    fn from_identity(i: &CommandIdentity, role: &str) -> Self {
        Self {
            command_id: i.command_id.clone(),
            tenant_id: i.tenant_id.clone(),
            branch_id: i.branch_id.clone(),
            user_id: i.user_id.clone(),
            payload_hash: i.payload_hash.clone(),
            role: role.to_string(),
        }
    }
}

/// Was zurückkommt. Drei Ausgänge, ausdrücklich getrennt: ein Ergebnis, ein fachliches Nein (der
/// Bestand war weg, die Rechnung ist bezahlt) und eine Störung. Der Client muss die drei
/// unterscheiden können — ein fachliches Nein wiederholt man nicht, eine Störung schon.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Reply {
    Ok { value: serde_json::Value },
    BusinessError { code: String, message: String },
    InfrastructureError { code: String },
    /// POST-PARITY R7C R3 — nachweislich NICHT ausgeführt: der durable Nachweis des Renderers hält
    /// die Kennung für eine andere Anfrage. Nach außen genau wie `BridgeError::CommandIdConflict`
    /// (409, `outcome: not_executed`) — auch wenn der Kennungsspeicher sie verdrängt hat oder der
    /// Primary neu gestartet ist.
    NotExecuted { code: String, message: String },
}

/// Wem eine logische Kennung gehört. Der Client vergibt sie EINMAL pro Speicherversuch und
/// benutzt sie bei jeder Wiederholung erneut — nur so kann ein späterer, durabler Nachweis
/// erkennen, dass zwei Anfragen dieselbe Absicht sind.
///
/// Übernommen wird sie nicht ungeprüft: sie muss ein UUID sein, und sie wird an den
/// AUTHENTIFIZIERTEN Absender und die Operation gebunden. Dieselbe Kennung mit anderem Mandanten,
/// anderer Filiale, anderem Benutzer oder anderer Operation ist ein Widerspruch und wird
/// abgewiesen — sonst könnte ein Client mit einer geratenen Kennung an einem fremden Vorgang
/// mitschreiben. Über den Inhalt einer Buchung entscheidet die Kennung nie; sie benennt nur.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandIdentity {
    pub command_id: String,
    pub tenant_id: String,
    pub branch_id: String,
    pub user_id: String,
    pub op: String,
    /// Der Fingerabdruck des semantischen Rumpfs. Ohne ihn waere eine Kennung nur ein Etikett:
    /// derselbe Name koennte zweimal etwas ANDERES bedeuten, und eine spaetere Wiederholung
    /// koennte eine fremde Buchung als "schon erledigt" ausgeben.
    pub payload_hash: String,
}

/// Der Fingerabdruck eines Rumpfs — deterministisch, unabhaengig von der Feldreihenfolge des
/// Clients:  haelt Objektschluessel sortiert (kein ), also ergibt
/// derselbe Inhalt immer denselben Text und damit denselben Hash. Kein neuer Kanonisierungsapparat;
/// es ist die Hash-Funktion, die das Haus ohnehin benutzt.
pub fn payload_fingerprint(payload: &serde_json::Value) -> String {
    crate::media::sha256_hex(serde_json::to_string(payload).unwrap_or_default().as_bytes())
}

/// Ein UUID in der kanonischen Schreibweise — nichts anderes wird angenommen. Damit kann die
/// Kennung kein Pfad, kein SQL-Fragment und kein Bezeichner sein.
pub fn is_valid_command_id(id: &str) -> bool {
    let b = id.as_bytes();
    if b.len() != 36 {
        return false;
    }
    for (i, c) in b.iter().enumerate() {
        let ok = match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit() && !c.is_ascii_uppercase(),
        };
        if !ok {
            return false;
        }
    }
    true
}

/// Wie ein Auftrag den Renderer erreicht. Als Merkmal ausgeführt, damit die Tests den echten
/// Registerablauf ohne Fenster fahren können — und damit diese Datei nichts von Tauri wissen muss.
pub trait CommandSink: Send + Sync {
    fn deliver(&self, envelope: &Envelope) -> Result<(), String>;
}

/// Wie viele kürzlich benutzte Kennungen behalten werden.
///
/// Der Zweck ist eng: eine versehentliche sofortige Wiederverwendung derselben Kennung für einen
/// ANDEREN Rumpf soll auffallen. Dafür reichen die letzten paar hundert; ein Client, der eine
/// Kennung nach tausend anderen Aufträgen mit neuem Inhalt erneut benutzt, ist kein Versehen mehr.
/// Bewusst begrenzt: eine Struktur, die nur wächst, ist in einem Programm, das monatelang läuft,
/// ein Leck — und dieser Schutz ist ohnehin nur prozessweit.
pub const IDENTITY_RETENTION: usize = 1024;

/// Eine gemerkte Kennung. `in_flight` zählt die Aufträge, die gerade darauf laufen: solange einer
/// offen ist, darf der Eintrag NICHT verdrängt werden, sonst könnte seine eigene Wiederholung
/// mitten im Lauf plötzlich als etwas Neues gelten.
struct IdentityEntry {
    identity: CommandIdentity,
    in_flight: usize,
}

/// Begrenzter Speicher mit Verdrängung in Ankunftsreihenfolge. Kein LRU-Apparat: der Zweck ist
/// „kürzlich", nicht „häufig", und die Reihenfolge der Ankunft beantwortet genau das.
struct IdentityStore {
    map: HashMap<String, IdentityEntry>,
    order: VecDeque<String>,
}

impl IdentityStore {
    fn new() -> Self {
        Self { map: HashMap::new(), order: VecDeque::new() }
    }

    /// Meldet einen Auftrag an. `Err` heißt: dieselbe Kennung steht schon für etwas anderes.
    fn begin(&mut self, identity: &CommandIdentity) -> Result<(), BridgeError> {
        match self.map.get_mut(&identity.command_id) {
            Some(e) if e.identity == *identity => {
                e.in_flight += 1;
                return Ok(());
            }
            Some(_) => return Err(BridgeError::CommandIdConflict),
            None => {}
        }
        self.map.insert(
            identity.command_id.clone(),
            IdentityEntry { identity: identity.clone(), in_flight: 1 },
        );
        self.order.push_back(identity.command_id.clone());
        self.evict();
        Ok(())
    }

    fn finish(&mut self, command_id: &str) {
        if let Some(e) = self.map.get_mut(command_id) {
            e.in_flight = e.in_flight.saturating_sub(1);
        }
        self.evict();
    }

    /// POST-PARITY R7C R3 — der durable Nachweis hat DIESE Anfrage abgewiesen (die Kennung gehört dort
    /// einem anderen Rumpf). Dann darf sie hier nicht als „die" Identität der Kennung stehen bleiben:
    /// sonst wiese dieser Speicher den rechtmäßigen ursprünglichen Auftrag ab (409), bis die Kennung
    /// verdrängt ist oder der Primary neu startet. Entfernt wird nur genau diese Identität, und nur,
    /// wenn nichts mehr darauf läuft.
    fn forget_refused(&mut self, identity: &CommandIdentity) {
        let drop = matches!(self.map.get(&identity.command_id), Some(e) if e.identity == *identity && e.in_flight == 0);
        if drop {
            self.map.remove(&identity.command_id);
            self.order.retain(|k| k != &identity.command_id);
        }
    }

    /// Verdrängt die ältesten, ÜBERSPRINGT aber alles, was gerade läuft. Die Schleife ist durch die
    /// Länge begrenzt: sind ausnahmsweise alle Einträge offen, wird nichts verdrängt und der
    /// Speicher wächst vorübergehend, statt einen laufenden Auftrag zu verlieren.
    fn evict(&mut self) {
        let mut checked = 0usize;
        while self.map.len() > IDENTITY_RETENTION && checked < self.order.len() {
            checked += 1;
            let Some(key) = self.order.pop_front() else { break };
            match self.map.get(&key) {
                Some(e) if e.in_flight > 0 => self.order.push_back(key), // laeuft noch — hinten anstellen
                Some(_) => { self.map.remove(&key); }
                None => {}
            }
        }
    }

    fn len(&self) -> usize {
        self.map.len()
    }
}

struct PendingEntry {
    generation: u64,
    tx: oneshot::Sender<Reply>,
}

pub struct Bridge {
    sink: Box<dyn CommandSink>,
    /// 0 = der Renderer hat sich noch nie gemeldet. Jede Anmeldung erhöht den Wert.
    generation: AtomicU64,
    accepting: AtomicBool,
    pending: Mutex<HashMap<String, PendingEntry>>,
    /// Welche logische Kennung zu wem gehoert. NUR prozessweit — der durable Nachweis fehlt und
    /// gehoert nach C3 in dieselbe Transaktion wie die Buchung.
    identities: Mutex<IdentityStore>,
}

impl Bridge {
    pub fn new(sink: Box<dyn CommandSink>) -> Self {
        Self {
            sink,
            generation: AtomicU64::new(0),
            accepting: AtomicBool::new(true),
            pending: Mutex::new(HashMap::new()),
            identities: Mutex::new(IdentityStore::new()),
        }
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    /// Der Renderer meldet sich als bereit. Alles, was noch von einer FRÜHEREN Generation offen
    /// ist, scheitert hier und jetzt — der Renderer, der es ausführen sollte, existiert nicht mehr.
    pub fn announce_generation(&self) -> u64 {
        let next = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.fail_pending_before(next);
        next
    }

    /// Ab hier keine neuen Aufträge, und die offenen werden aufgelöst. Wird vor dem Ende des
    /// Fensters gerufen, damit kein Client auf eine Antwort wartet, die niemand mehr geben kann.
    pub fn stop_accepting(&self) {
        self.accepting.store(false, Ordering::SeqCst);
        self.fail_pending_before(u64::MAX);
    }

    fn fail_pending_before(&self, generation: u64) {
        let mut map = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        let stale: Vec<String> = map
            .iter()
            .filter(|(_, e)| e.generation < generation)
            .map(|(k, _)| k.clone())
            .collect();
        for key in stale {
            if let Some(entry) = map.remove(&key) {
                // Der Empfänger wandelt ein geschlossenes Kanalende in `Reloaded` um; ein
                // ausdrücklicher Fehlerwert wäre eine zweite Wahrheit für denselben Zustand.
                drop(entry.tx);
            }
        }
    }

    pub async fn submit(&self, op: &str, payload: serde_json::Value) -> Result<Reply, BridgeError> {
        self.submit_with_timeout(op, payload, DEFAULT_TIMEOUT).await
    }

    /// Wie `submit`, aber mit der logischen Kennung des Clients. Die Bindung ist in C1 bewusst nur
    /// prozessweit: sie beweist die REGEL (dieselbe Kennung heißt dieselbe Absicht), ersetzt aber
    /// keinen durablen Nachweis. Genau deshalb ist in C1 auch keine verändernde Operation
    /// registrierbar — ohne Ledger in derselben Transaktion wie die Buchung wäre jede
    /// „genau einmal"-Behauptung unbelegt.
    pub async fn submit_as(
        &self,
        identity: &CommandIdentity,
        // CENTRAL-C4 — die Rolle aus den geprueften Anspruechen, als EIGENES Argument. Sie geht
        // bewusst nicht durch `CommandIdentity`: dort wuerde sie die Gleichheit veraendern, an
        // der die prozessweite Kennungsbindung haengt.
        role: &str,
        payload: serde_json::Value,
        timeout: Duration,
    ) -> Result<Reply, BridgeError> {
        if !is_valid_command_id(&identity.command_id) {
            return Err(BridgeError::BadCommandId);
        }
        {
            let mut store = self.identities.lock().unwrap_or_else(|e| e.into_inner());
            store.begin(identity)?;
        }
        // Der Eintrag bleibt geschuetzt, bis DIESER Auftrag durch ist — auch wenn er scheitert.
        let out = self
            .dispatch(
                &identity.op,
                payload,
                Some(EnvelopeIdentity::from_identity(identity, role)),
                timeout,
            )
            .await;
        {
            let mut store = self.identities.lock().unwrap_or_else(|e| e.into_inner());
            store.finish(&identity.command_id);
            // R7C R3 — vom durablen Nachweis abgewiesen: diese Identität nicht als Besitzer merken.
            if matches!(out, Ok(Reply::NotExecuted { .. })) {
                store.forget_refused(identity);
            }
        }
        out
    }

    /// Nur zur Pruefung: wie viele Kennungen gerade gemerkt sind.
    pub fn remembered_identities(&self) -> usize {
        self.identities.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    pub async fn submit_with_timeout(
        &self,
        op: &str,
        payload: serde_json::Value,
        timeout: Duration,
    ) -> Result<Reply, BridgeError> {
        self.dispatch(op, payload, None, timeout).await
    }

    /// Der gemeinsame Weg. Die Identitaet ist optional, weil eine Auskunft keine braucht — eine
    /// Buchung schon, und der Renderer weist eine Mutation ohne Identitaet ab.
    async fn dispatch(
        &self,
        op: &str,
        payload: serde_json::Value,
        identity: Option<EnvelopeIdentity>,
        timeout: Duration,
    ) -> Result<Reply, BridgeError> {
        // Reihenfolge der Prüfungen ist Absicht: erst der Name (der darf nie zum Renderer),
        // dann der Zustand (der entscheidet, ob überhaupt gesendet wird).
        if !REMOTE_OPS.contains(&op) {
            return Err(BridgeError::OpNotAllowed);
        }
        if !self.accepting.load(Ordering::SeqCst) {
            return Err(BridgeError::ShuttingDown);
        }
        let generation = self.generation();
        if generation == 0 {
            return Err(BridgeError::NotReady);
        }

        let op_id = uuid::Uuid::new_v4().to_string();
        let envelope = Envelope {
            op_id: op_id.clone(),
            op: op.to_string(),
            generation,
            payload,
            identity,
        };

        let rx = {
            let (tx, rx) = oneshot::channel::<Reply>();
            let mut map = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            map.insert(op_id.clone(), PendingEntry { generation, tx });
            rx
        };

        if let Err(_e) = self.sink.deliver(&envelope) {
            self.take_pending(&op_id);
            return Err(BridgeError::DeliveryFailed);
        }

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(reply)) => Ok(reply),
            // Kanal zu, ohne Antwort: der Eintrag wurde verworfen — Neuladen oder Ende.
            Ok(Err(_recv_error)) => Err(BridgeError::Reloaded),
            Err(_elapsed) => {
                self.take_pending(&op_id);
                Err(BridgeError::Timeout)
            }
        }
    }

    /// Die Antwort des Renderers. Eine Antwort aus einer anderen Generation wird verworfen: sie
    /// gehört zu einem Fenster, das es nicht mehr gibt.
    pub fn reply(&self, op_id: &str, generation: u64, reply: Reply) -> Result<(), BridgeError> {
        if generation != self.generation() {
            return Err(BridgeError::Reloaded);
        }
        // Eine zweite Antwort auf dieselbe `op_id` findet keinen Eintrag mehr und ist ein No-op.
        // Verwechseln kann sie nichts: die Kennung kommt aus `Uuid::new_v4()` und wird nie erneut
        // vergeben — deshalb braucht es hier keine Liste erledigter Auftraege, die nur waechst.
        match self.take_pending(op_id) {
            Some(entry) if entry.generation == generation => {
                let _ = entry.tx.send(reply);
                Ok(())
            }
            Some(_) => Err(BridgeError::Reloaded),
            None => Ok(()), // Zeitgrenze war schneller; niemand wartet mehr.
        }
    }

    fn take_pending(&self, op_id: &str) -> Option<PendingEntry> {
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(op_id)
    }

    pub fn pending_count(&self) -> usize {
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .len()
    }
}

// ── Die eine Brücke des Prozesses ─────────────────────────────────────────
//
// Prozessweit, weil sie es tatsächlich ist: eine Anwendung, ein Fenster, eine Geschäftsdatenbank.
// Die Axum-Route hat keinen Zugriff auf den Tauri-Handle, und ihn durch `AppState` zu fädeln würde
// fünf Konstruktoren (darunter Testrouter ohne Tauri) um ein Feld erweitern, das sie nie füllen.

static BRIDGE: OnceLock<Bridge> = OnceLock::new();

/// Einmalig beim Start gesetzt, sobald es ein Fenster gibt. Ein zweiter Aufruf ändert nichts.
pub fn install(bridge: Bridge) -> bool {
    BRIDGE.set(bridge).is_ok()
}

/// `None`, solange keine Brücke steht — dann gibt es keinen Renderer, den man fragen könnte.
pub fn global() -> Option<&'static Bridge> {
    BRIDGE.get()
}
