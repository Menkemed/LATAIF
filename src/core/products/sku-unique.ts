// ═════════════════════════════════════════════════════════════════
// SKU-UNIQUE — die EINE Prüfung, ob eine SKU schon an einem Artikel steht.
//
// Vorher prüfte jeder Weg gegen die Artikelliste im SPEICHER (`isSkuTaken` → `get().products`), und nur VOR dem
// Schreiben, getrennt davon durch Wartepunkte (Bilder bereitstellen, Auftrag einreihen). Die Datenbank selbst kennt
// keine Eindeutigkeit (`products.sku` ohne UNIQUE). Ein Artikel, der auf einem anderen Weg in die Datenbank kam
// (Handy, PC2, Einkauf, Import), stand nicht in der Liste — und der Handy-Upload mit eingetippter SKU prüfte gar nicht.
//
// Jetzt: gegen die DATENBANK, mit derselben Gleichheit wie überall (getrimmt, Groß/Klein egal), und an der Stelle,
// an der geschrieben wird — im selben synchronen Schritt wie das INSERT/UPDATE. Der Primary schreibt in EINEM
// JavaScript-Thread; zwischen Prüfung und Schreiben liegt kein Wartepunkt, also auch kein zweiter Schreiber.
// ═════════════════════════════════════════════════════════════════

export const SKU_TAKEN = 'SKU_TAKEN';

/** Die Gleichheit einer SKU: getrimmt, Groß/Klein egal — „ rlx-001 " und „RLX-001" sind dieselbe Nummer. */
export const skuKey = (sku: unknown): string => (typeof sku === 'string' ? sku.trim().toUpperCase() : '');

/** Liest Zeilen (der Aufrufer bringt seinen Datenbankzugang mit: Store-`query` oder die Transaktion des Koordinators). */
export type SkuRows = (sql: string, params: unknown[]) => Array<Record<string, unknown>>;

/** Die Id des Artikels, der diese SKU schon trägt (ohne `excludeId`), sonst `null`. Leere SKU → `null`. */
export function skuTakenBy(rows: SkuRows, sku: unknown, excludeId?: string | null): string | null {
  const key = skuKey(sku);
  if (!key) return null;
  for (const r of rows(`SELECT id, sku FROM products WHERE sku IS NOT NULL AND TRIM(sku) <> ''`, [])) {
    if (String(r.id) !== (excludeId ?? '') && skuKey(r.sku) === key) return String(r.id);
  }
  return null;
}

export const skuTakenMessage = (sku: unknown): string => `The SKU / reference ${String(sku ?? '').trim()} is already in use.`;

export class SkuTakenError extends Error {
  readonly code = SKU_TAKEN;
  readonly sku: string;
  constructor(sku: string) {
    super(skuTakenMessage(sku));
    this.name = 'SkuTakenError';
    this.sku = sku;
  }
}

/** Wirft `SkuTakenError`, wenn die SKU schon an einem anderen Artikel steht. Leere SKU ist immer frei. */
export function assertSkuFree(rows: SkuRows, sku: unknown, excludeId?: string | null): void {
  if (skuTakenBy(rows, sku, excludeId)) throw new SkuTakenError(String(sku));
}

/** Erkennt die Ablehnung auch dann, wenn sie unterwegs zu einer Meldung geworden ist. */
export const isSkuTaken = (e: unknown): boolean =>
  (e as { code?: unknown })?.code === SKU_TAKEN || /\bSKU \/ reference .* is already in use\b/.test(String((e as { message?: unknown })?.message ?? e));
