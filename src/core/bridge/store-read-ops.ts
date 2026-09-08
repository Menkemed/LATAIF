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
];

// Noch NICHT hier — und damit fern nicht aufrufbar: Finanzen, Berichte und die uebrigen Flaechen. Sie laufen noch
// ueber ihre alten Ladefunktionen und wuerden den Bildschirm des Primary anfassen. Sie kommen
// zurueck, sobald ihre Ladefunktion denselben Schnitt hat wie die vier oben.
