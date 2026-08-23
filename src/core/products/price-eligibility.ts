// ════════════════════════════════════════════════════════════════════════════
// MOBILE-EDIT v0.8.48 — darf ein Artikel seine Preise vom Handy aus geaendert bekommen?
//
// Zwei Bedingungen, beide ueber ECHTE Relationen, keine aus SKU, Datum, Preis, Kategorie oder Name
// geratene Herkunft:
//
//   A — HERKUNFT, positiv bewiesen. `mobile_upload_receipts` traegt genau dann eine Zeile fuer ein
//       Produkt, wenn es ueber die mobile Collection-Aufnahme entstanden ist: die Quittung wird
//       ausschliesslich von `createProductWithMedia` geschrieben, und zwar in DEMSELBEN durablen
//       Checkpoint wie die Produktzeile. Kein anderer Erzeugungsweg schreibt sie. Ein Produkt vom
//       Desktop, aus einem Import, aus einer Produktion oder aus einer Migration hat sie nicht — und
//       ist damit hier NICHT berechtigt. Das ist bewusst streng: fuer diese Wege gibt es keinen
//       Herkunftsbeweis im Schema, und Raten waere schlechter als Ablehnen.
//
//   B — KEINE GESCHAEFTLICHE VERKNUEPFUNG. Sobald der Artikel Teil eines Einkaufs, Verkaufs,
//       Angebots, Auftrags, einer Kommission, einer Uebergabe an einen Agenten, einer Retoure, einer
//       Produktion, einer Reparatur oder eines Bestands-Lots ist, sind die drei Preise gesperrt.
//
// Was ABSICHTLICH nicht sperrt:
//   • `inventory_session_items` — eine Inventurzaehlung ist eine Beobachtung, kein Geschaeftsvorgang.
//     Wer seinen Bestand zaehlt, soll danach nicht plotzlich keine Preise mehr korrigieren koennen.
//   • `mobile_upload_receipts` — das IST der Herkunftsnachweis aus A; er wuerde sonst jeden mobil
//     angelegten Artikel sofort selbst sperren.
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
  | { allowed: false; reason: 'not_collection_origin' | 'has_transaction'; relation?: string };

/**
 * Die Entscheidung. Fail closed in jeder Richtung: eine Abfrage, die nicht beantwortet werden kann,
 * gilt als "nicht berechtigt" — ein Preisfeld nicht anzubieten ist immer sicher, es faelschlich
 * freizugeben nicht.
 */
export function evaluatePriceEligibility(productId: string, count: CountFn): PriceEligibility {
  if (!productId) return { allowed: false, reason: 'not_collection_origin' };

  const receipts = safeCount(count, 'SELECT COUNT(*) AS c FROM mobile_upload_receipts WHERE product_id = ?', [productId]);
  if (receipts <= 0) return { allowed: false, reason: 'not_collection_origin' };

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
