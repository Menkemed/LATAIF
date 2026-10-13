// ════════════════════════════════════════════════════════════════════════════
// F9 — PRODUCT-LIFECYCLE-INTEGRITY: Menge, Bestandsstatus und Herkunft eines Artikels folgen aus den Vorgängen
// (Einkauf, Verkauf, Retoure, Kommission, Agent, Produktion, Reparatur, Angebot, Auftrag) — nie aus der Artikelmaske.
//
// Vorher setzte „Edit" der Artikelseite (Primary) und `products.update` (PC2) diese Felder frei: ein verkauftes
// Stück wurde wieder „in stock", eine Menge ohne Einkauf erhöht, ein Stück beim Agenten verkaufbar, die Herkunft
// beliebig (auch Fantasiewerte). Jetzt weist das Haus (`editProductTextDurably` / `editProductWithMedia`, also
// Primary, PC2 und Handy gleich) jede ÄNDERUNG daran ab, bevor irgendetwas geschrieben wird. Ein unveränderter Wert
// (die Maske trägt das ganze Formular mit) ist keine Änderung.
//
// Die Geschäftsvorgänge schreiben diese Felder weiterhin selbst (eigene SQL-Pfade, nicht über diese Bearbeitung).
// ════════════════════════════════════════════════════════════════════════════

export const PRODUCT_LIFECYCLE_LOCKED = 'PRODUCT_LIFECYCLE_LOCKED';

/** Die Felder, die nur Vorgänge setzen — Name im Artikel-Objekt → Spalte → Wert, wenn die Spalte leer ist. */
const LIFECYCLE_FIELDS: ReadonlyArray<{ field: 'quantity' | 'stockStatus' | 'sourceType'; col: string; leer: string | number; was: string }> = [
  { field: 'quantity', col: 'quantity', leer: 1, was: 'The quantity follows purchases, sales and returns' },
  { field: 'stockStatus', col: 'stock_status', leer: 'in_stock', was: 'The stock status follows the business documents (sale, return, consignment, agent, repair, offer, order)' },
  { field: 'sourceType', col: 'source_type', leer: 'OWN', was: 'The source (own, consignment, agent) follows the consignment and agent records' },
];

const gleich = (a: unknown, b: unknown, zahl: boolean): boolean =>
  zahl ? Number(a) === Number(b) : String(a) === String(b);

/**
 * Will diese Bearbeitung Menge, Bestandsstatus oder Herkunft ÄNDERN? Dann die Begründung (→ abweisen), sonst `null`.
 * `cur` ist die Zeile aus der Datenbank (Spaltennamen), `data` die Bearbeitung (Feldnamen des Artikels).
 */
export function lifecycleEditRefusal(cur: Record<string, unknown> | undefined, data: Record<string, unknown>): string | null {
  for (const f of LIFECYCLE_FIELDS) {
    if (!(f.field in data)) continue;
    const neu = data[f.field];
    if (neu === undefined || neu === null) continue;
    const jetzt = cur?.[f.col] ?? f.leer;
    if (gleich(jetzt, neu, f.field === 'quantity')) continue;
    return `${f.was} — it cannot be changed in the item editor. Nothing was changed.`;
  }
  return null;
}
