// ════════════════════════════════════════════════════════════════════════════
// MOBILE-EDIT v0.8.48 — darf ein Artikel seine Preise vom Handy aus geaendert bekommen?
//
// Zwei Bedingungen, beide ueber ECHTE Relationen, keine aus SKU, Datum, Preis, Kategorie oder Name
// geratene Herkunft:
//
//   A — EIGENER, FREIER BESTAND. `products.source_type` ist eine echte Domaenen-Klassifikation, kein
//       geratenes Herkunftsmerkmal: `agentStore` setzt `AGENT`, wenn ein Stueck zu einem Agenten
//       geht, und `OWN` zurueck, wenn es zurueckkommt; `consignmentStore` setzt `CONSIGNMENT` und
//       ebenfalls `OWN` beim Teardown. `OWN` heisst also: der Laden fuehrt das Stueck als eigenen
//       Bestand, es gehoert niemandem sonst.
//
//       Ausdruecklich NICHT Teil dieser Bedingung: WIE der Artikel angelegt wurde. Ein am Desktop in
//       Collection erfasstes Stueck hat dieselben Preisrechte wie ein ueber das Handy erfasstes, und
//       ein alter, importierter oder migrierter Artikel wird nicht deshalb gesperrt, weil seine
//       technische Herkunft unbekannt ist. `mobile_upload_receipts` beweist nur "kam ueber den
//       mobilen Create" — das ist keine fachliche Berechtigung und darf keine sein.
//
//   B — KEINE GESCHAEFTLICHE VERKNUEPFUNG. Sobald der Artikel Teil eines Einkaufs, Verkaufs,
//       Angebots, Auftrags, einer Kommission, einer Uebergabe an einen Agenten, einer Retoure, einer
//       Produktion, einer Reparatur oder eines Bestands-Lots ist, sind die drei Preise gesperrt.
//       Das ist die eigentliche Sicherheitsgrenze.
//
// Was ABSICHTLICH nicht sperrt:
//   • `inventory_session_items` — eine Inventurzaehlung ist eine Beobachtung, kein Geschaeftsvorgang.
//     Wer seinen Bestand zaehlt, soll danach nicht ploetzlich keine Preise mehr korrigieren koennen.
//   • `mobile_upload_receipts` — eine technische Upload-Quittung fuer Replay und Idempotenz. Sie sagt
//     nichts ueber eine geschaeftliche Bindung aus, weder in die eine noch in die andere Richtung.
//
// Indirekte Bindungen sind mitgedeckt, ohne Sonderregel: Zahlungen, Gutschriften, Rechnungs-Edits,
// Einkaufs- und Verkaufsretouren haengen an einer Rechnung oder einem Einkauf, nie direkt am Produkt
// — und deren Zeilen (`invoice_lines`, `purchase_lines`, `sales_return_lines`,
// `purchase_return_lines`) tragen den Produktbezug und stehen unten in der Liste.
//
// Diese Datei ist die EINE Definition. Der Koordinator prueft sie INNERHALB der Schreib-Transaktion
// (verbindlich), die Verdrahtung nutzt sie fuer eine fruehe, freundliche Ablehnung, und der
// Lesevertrag in Rust spiegelt sie fuer die Anzeige. Verbindlich ist ausschliesslich die Pruefung in
// der Transaktion — alles andere ist Vorschau.
// ════════════════════════════════════════════════════════════════════════════

/** Die Produktspalten, um die es geht. Andere Felder sind von dieser Regel nicht betroffen. */
export const PRICE_COLUMNS: readonly string[] = ['purchase_price', 'planned_sale_price', 'min_sale_price'];

/**
 * Jede Tabelle, deren Existenz einer Zeile den Artikel zu einem Geschaeftsvorgang gehoeren laesst.
 * Abgeleitet aus dem realen Schema (jede Tabelle mit `product_id`), abzueglich der beiden oben
 * begruendeten Ausnahmen. Eine neue Tabelle mit Produktbezug gehoert hier ergaenzt.
 */
export const TRANSACTION_RELATIONS: readonly string[] = [
  'purchase_lines',
  'purchase_return_lines',
  'invoice_lines',
  'sales_return_lines',
  'offer_lines',
  'orders',
  'order_lines',
  'stock_lots',
  'consignments',
  'agent_transfers',
  'production_inputs',
  'production_outputs',
  'repairs',
];

/** Eine Zeilenabfrage — sql.js im Koordinator, `query()` in der Verdrahtung. */
export type CountFn = (sql: string, params: unknown[]) => number;

export type PriceEligibility =
  | { allowed: true }
  | { allowed: false; reason: 'not_own_stock' | 'has_transaction'; relation?: string };

/** Eine einzelne Textspalte lesen — fuer `source_type`. */
export type ValueFn = (sql: string, params: unknown[]) => string | null;

/**
 * Die Entscheidung. Fail closed in jeder Richtung: eine Abfrage, die nicht beantwortet werden kann,
 * gilt als "nicht berechtigt" — ein Preisfeld nicht anzubieten ist immer sicher, es faelschlich
 * freizugeben nicht.
 */
export function evaluatePriceEligibility(productId: string, count: CountFn): PriceEligibility {
  if (!productId) return { allowed: false, reason: 'not_own_stock' };

  // A — eigener, freier Bestand. Gezaehlt statt gelesen, damit dieselbe eine Abfrage-Funktion reicht:
  // genau eine Zeile mit `source_type='OWN'` heisst "existiert UND gehoert uns". Ein unbekanntes
  // Produkt liefert 0, ein Lesefehler -1 — beides sperrt.
  const own = safeCount(count, "SELECT COUNT(*) AS c FROM products WHERE id = ? AND source_type = 'OWN'", [productId]);
  if (own !== 1) return { allowed: false, reason: 'not_own_stock' };

  for (const table of TRANSACTION_RELATIONS) {
    const n = safeCount(count, `SELECT COUNT(*) AS c FROM ${table} WHERE product_id = ?`, [productId]);
    // `-1` heisst "konnte nicht gelesen werden" (Tabelle fehlt, Abfrage scheiterte). Auch das sperrt.
    if (n !== 0) return { allowed: false, reason: 'has_transaction', relation: table };
  }
  return { allowed: true };
}

function safeCount(count: CountFn, sql: string, params: unknown[]): number {
  try { return count(sql, params); } catch { return -1; }
}

/** Beruehrt dieser Spalten-Satz ueberhaupt einen Preis? */
export function touchesPriceColumns(set: ReadonlyArray<readonly [string, unknown]>): boolean {
  return set.some(([col]) => PRICE_COLUMNS.includes(col));
}
