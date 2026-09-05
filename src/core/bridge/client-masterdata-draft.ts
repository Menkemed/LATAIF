// CENTRAL-C3C — was ein Client-Schreibformular wirklich entscheidet, ohne JSX drumherum.
//
// Zwei Regeln stecken hier drin, und beide sind zu wichtig, um in einer Komponente zu wohnen, die
// man nur im Browser laden kann:
//
//  1. **Nur der Unterschied wird geschickt.** Ein Formular, das alle Felder zurückschickt,
//     überschreibt beim Speichern auch das, was jemand anderes in der Zwischenzeit geändert hat —
//     mit dem Stand, den DIESER Rechner beim Laden gesehen hat. Genau daran ist im Haus schon
//     einmal der Kundenumsatz gestorben (M-01).
//  2. **Ein geleertes Zahlenfeld heißt „kein Wert", nicht 0.** Der Unterschied ist Geld: ein Budget
//     von 0 ist eine Aussage, ein fehlendes Budget ist keine.
//
// Die Feldlisten sind absichtlich kürzer als die des Primary-Formulars: sie enthalten genau das,
// was der zugehörige Lesebefehl auch ZURÜCKLIEFERT. Ein Eingabefeld für etwas, das dieser Rechner
// nicht lesen kann, stünde leer da — und ein Speichern würde den echten Wert löschen.

/** Kunde: genau die Felder, die `customers.get` zurückgibt. */
export const CLIENT_CUSTOMER_FIELDS = [
  'firstName', 'lastName', 'company', 'phone', 'whatsapp', 'email',
  'country', 'language', 'budgetMin', 'budgetMax', 'vipLevel',
  'customerType', 'salesStage', 'notes',
] as const;

/** Artikel: genau die Felder, die `products.get` zurückgibt UND ein Auftrag setzen darf. */
export const CLIENT_PRODUCT_FIELDS = [
  'brand', 'name', 'condition', 'storageLocation',
  'purchasePrice', 'plannedSalePrice', 'stockStatus', 'taxScheme', 'sourceType', 'notes',
] as const;

/** Welche davon Zahlen sind — sie gehen als Zahl raus, sonst weist der Primary sie ab. */
export const CUSTOMER_NUMERIC: readonly string[] = ['budgetMin', 'budgetMax', 'vipLevel'];
export const PRODUCT_NUMERIC: readonly string[] = ['purchasePrice', 'plannedSalePrice'];

export type Draft = Record<string, string>;

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

export function emptyDraft(fields: readonly string[]): Draft {
  const out: Draft = {};
  for (const f of fields) out[f] = '';
  return out;
}

/** Der geladene Datensatz als Formularstand — alles als Text, damit „unverändert" vergleichbar ist. */
export function draftFrom(fields: readonly string[], row: Record<string, unknown>): Draft {
  const out = emptyDraft(fields);
  for (const f of fields) out[f] = text(row[f]);
  return out;
}

/**
 * Der Rumpf: NUR die Felder, die sich gegen den geladenen Stand geändert haben. Ohne Kennung, ohne
 * Filiale, ohne Summen — die entscheidet der Primary, und er weist sie ab, stünden sie doch drin.
 */
export function diffDraft(fields: readonly string[], numeric: readonly string[], base: Draft, now: Draft): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if ((base[f] ?? '') === (now[f] ?? '')) continue;
    const raw = (now[f] ?? '').trim();
    if (numeric.includes(f)) {
      out[f] = raw === '' ? null : Number(raw);
      continue;
    }
    out[f] = raw === '' ? null : raw;
  }
  return out;
}
