// CENTRAL-UI-PARITY R1 — der Katalog der Store-Auskuenfte, ohne jede Nebenwirkung.
//
// Bewusst getrennt von `store-read-commands.ts`: dort werden die Operationen REGISTRIERT, und wer
// nur die Namen braucht (die Rechteabbildung, die Gates), soll das nicht ausloesen. Ein Import
// dieser Datei laedt keinen Store und meldet nichts an.
//
// R1 hat den Katalog ABSICHTLICH verkleinert. Der erste Wurf rief die Ladefunktionen der
// Primary-Stores auf — das schrieb in den Bildschirm des Menschen am Primary und las dessen
// Filiale statt der des Anfragenden. Beides ist bewiesen und behoben, aber nur fuer die
// Wege, die auf gemeinsame, zustandsfreie Ladefunktionen umgestellt sind. Alles andere ist hier
// entfernt statt „laeuft meistens" stehen zu lassen: was fehlt, existiert fuer das Netz nicht.

/** Die Namen der Auskuenfte, die auf einen gemeinsamen, zustandsfreien Loader umgestellt sind. */
export const OP_STORE_PRODUCTS_GET = 'store.products.get';
export const OP_STORE_CUSTOMERS_GET = 'store.customers.get';
export const OP_STORE_INVOICES_GET = 'store.invoices.get';
export const OP_ORDER_PAYMENTS_GET = 'order_payments.get';
/** Der Sitzungskontext: Filiale, Name, Waehrung — serverautoritativ statt aus dem Speicher geraten. */
export const OP_SESSION_CONTEXT_GET = 'session.context.get';

// CENTRAL-UI-PARITY R2A — die uebrigen Kernflaechen der normalen Oberflaeche. Jede steht fuer
// GENAU eine gemeinsame Ladefunktion mit demselben Schnitt wie oben.
export const OP_STORE_SUPPLIERS_GET = 'store.suppliers.get';
export const OP_STORE_SALES_RETURNS_GET = 'store.sales_returns.get';
export const OP_STORE_CREDIT_NOTES_GET = 'store.credit_notes.get';
export const OP_STORE_ORDERS_GET = 'store.orders.get';
export const OP_STORE_CONSIGNMENTS_GET = 'store.consignments.get';
export const OP_STORE_PURCHASES_GET = 'store.purchases.get';
export const OP_STORE_REPAIRS_GET = 'store.repairs.get';
export const OP_STORE_AGENTS_GET = 'store.agents.get';

// CENTRAL-UI-PARITY R2B — der Rest der Lesefläche: Finanzen und Betriebsfuehrung. Damit gibt es
// keine Flaeche mehr, die auf einem Rechner ohne Datenbank still leer bleibt, weil ihre
// Ladefunktion noch den alten Schnitt haette.
export const OP_STORE_EXPENSES_GET = 'store.expenses.get';
export const OP_STORE_RECURRING_EXPENSES_GET = 'store.recurring_expenses.get';
export const OP_STORE_BANKING_GET = 'store.banking.get';
export const OP_STORE_PAYABLES_GET = 'store.payables.get';
export const OP_STORE_DEBTS_GET = 'store.debts.get';
export const OP_STORE_GOLD_GET = 'store.gold.get';
export const OP_STORE_METALS_GET = 'store.metals.get';
export const OP_STORE_SCRAP_TRADES_GET = 'store.scrap_trades.get';
export const OP_STORE_EMPLOYEES_GET = 'store.employees.get';
export const OP_STORE_PARTNERS_GET = 'store.partners.get';
export const OP_STORE_TASKS_GET = 'store.tasks.get';
export const OP_STORE_DOCUMENTS_GET = 'store.documents.get';
export const OP_STORE_OFFERS_GET = 'store.offers.get';
export const OP_STORE_PRODUCTION_GET = 'store.production.get';

// CENTRAL-UI-PARITY R2C — der Schluss der Lesefläche. Drei Namen, und jeder steht für genau
// eine Sache: die Auswertung als EIN Ergebnis (statt fünfzig Abfragen über das Netz), der
// Steuerbericht auf Abruf, und der Inhalt genau eines Belegs.
export const OP_STORE_ANALYTICS_GET = 'store.analytics.get';
export const OP_ANALYTICS_VAT_EXPORT_GET = 'analytics.vat_export.get';
export const OP_DOCUMENTS_CONTENT_GET = 'documents.content.get';

// CENTRAL-UI-PARITY R2D — die Flächen, die ihre Abfrage bisher selbst stellten. Ein Name je
// Fläche oder Domäne, nicht einer je Abfrage: aus 41 direkten Zugriffen werden elf Auskünfte.
export const OP_PAGE_DASHBOARD_GET = 'page.dashboard.get';
export const OP_PAGE_INVOICE_LIST_GET = 'page.invoice_list.get';
export const OP_PAGE_ORDER_LIST_GET = 'page.order_list.get';
export const OP_PAGE_CUSTOMER_DETAIL_GET = 'page.customer_detail.get';
export const OP_PAGE_ORDER_DETAIL_GET = 'page.order_detail.get';
export const OP_PAGE_SUPPLIER_DETAIL_GET = 'page.supplier_detail.get';
export const OP_PAGE_PRODUCT_DETAIL_GET = 'page.product_detail.get';
export const OP_PAGE_PURCHASE_CREATE_GET = 'page.purchase_create.get';
export const OP_REFS_NUMBERS_GET = 'refs.numbers.get';
export const OP_METALS_STOCK_BY_KARAT_GET = 'metals.stock_by_karat.get';
export const OP_SEARCH_GLOBAL_GET = 'search.global.get';

// Die Abstimmung ist eine BUCHHALTERISCHE Auskunft, keine Maschinenfunktion — sie war nur
// deshalb an den Hauptrechner gebunden, weil sie ihre zwanzig Abfragen selbst stellte.
export const OP_PAGE_RECONCILIATION_GET = 'page.reconciliation.get';

// CENTRAL-UI-PARITY R4A — was eine Seite ueber eine KERNFUNKTION liest. Der erste Zwei-App-Lauf
// hat gezeigt, dass ein Scan ueber Dateien das nicht findet: die Uebersicht ruft `balanceOf`,
// die Forderungsseite `receivablesBreakdown`, die Sammlung `getStockAggregates`.
export const OP_LEDGER_BALANCES_GET = 'ledger.balances.get';
export const OP_FINANCE_RECEIVABLES_GET = 'finance.receivables.get';
export const OP_INVENTORY_LOT_AGGREGATES_GET = 'inventory.lot_aggregates.get';
export const OP_PRODUCT_LOTS_GET = 'product.lots.get';
export const OP_PRODUCT_LOTS_BATCH_GET = 'product.lots.batch.get';
export const OP_EXPENSES_CREDIT_PAID_GET = 'expenses.credit_paid.get';

/**
 * Die Liste IST die Erlaubnis. Ein Name, der hier fehlt, existiert fuer das Netz nicht — genau
 * wie bei den Buchungen. Dieselbe Liste kennt auch Rust.
 */
export const STORE_READ_OPS: readonly string[] = [
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
];

// Nicht hier — und damit fern nicht aufrufbar — sind nur noch drei Arten von Zugriffen, und keine
// davon ist eine Store-Auskunft: die Auswertungsseite, die ihre Zahlen selbst zusammenrechnet
// (eigener Schnitt, eigener Abschnitt), die abgeleiteten Einzelabfragen mancher Detailansichten,
// und alles, was zur MASCHINE gehoert — Einstellungen, Sicherung, Datenort, Wartung. Letzteres
// gehoert dorthin, wo die Datenbank steht, und wird auf einem Client ehrlich als solches gezeigt.
