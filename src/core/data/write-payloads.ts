// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R4B — WELCHE Felder eine Absicht mitbringt. Eine Liste, zwei Leser.
//
// Diese Listen standen bisher NUR im Fernbefehl (`customer-commands.ts`, `product-commands.ts`)
// als seine Prüfung. Damit die gemeinsame Oberfläche denselben Rumpf bauen kann, ohne die Liste
// abzuschreiben, wohnen sie jetzt hier — und der Befehl liest sie von hier. Eine zweite Liste
// wäre ein zweiter Vertrag: sie würde auseinanderlaufen, und der Unterschied fiele erst auf,
// wenn ein Feld still verschwindet.
//
// Was hier NICHT steht: eine Prüfung. Die Form der Werte prüft weiterhin der Primary, in seinem
// Befehl — dieses Modul wählt nur aus, was überhaupt mitfährt.
// ════════════════════════════════════════════════════════════════════════════

/** Kunde: was ein Mensch im Kundenformular eingibt, und nichts sonst. */
export const CUSTOMER_EDITABLE = [
  'firstName', 'lastName', 'company', 'phone', 'whatsapp', 'email',
  'country', 'language', 'budgetMin', 'budgetMax', 'vipLevel',
  'preferences', 'customerType', 'salesStage', 'notes',
  'vatAccountNumber', 'personalId',
] as const;

/** Artikel anlegen. */
export const PRODUCT_CREATE_FIELDS = [
  'categoryId', 'brand', 'name', 'quantity', 'condition', 'scopeOfDelivery',
  'storageLocation', 'purchaseDate', 'purchasePrice', 'purchaseCurrency',
  'plannedSalePrice', 'minSalePrice', 'maxSalePrice',
  'stockStatus', 'taxScheme', 'supplierName', 'purchaseSource', 'paidFrom',
  'sourceType', 'notes', 'attributes',
] as const;

/**
 * Artikel ändern — enger als das Anlegen: eine geänderte Kategorie zöge jedes Attribut auf eine
 * andere Definition um, und die Menge ist eine Bestandsaussage, kein Textfeld.
 */
export const PRODUCT_UPDATE_FIELDS = [
  'brand', 'name', 'condition', 'scopeOfDelivery', 'storageLocation',
  'purchaseDate', 'purchasePrice', 'plannedSalePrice', 'minSalePrice', 'maxSalePrice',
  'stockStatus', 'taxScheme', 'supplierName', 'purchaseSource', 'paidFrom',
  'sourceType', 'notes', 'attributes',
] as const;

const leer = (v: unknown) => v === undefined || v === null || v === '';

/**
 * Der Rumpf einer ANLEGE-Absicht: die erlaubten Felder, ohne die leeren.
 *
 * Leere Felder fliegen raus, weil ein leerer Text etwas anderes ist als „nicht gesagt": der
 * Primary setzt seine eigenen Standardwerte, und ein mitgeschicktes `''` würde sie überschreiben.
 */
export function createPayload(
  form: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = form[f];
    if (leer(v)) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[f] = v;
  }
  return out;
}

/**
 * Der Rumpf einer ÄNDERUNGS-Absicht: NUR das, was sich gegen den geladenen Stand geändert hat.
 *
 * Ein Formular, das alles zurückschickt, überschreibt beim Speichern auch das, was jemand anderes
 * inzwischen geändert hat — mit dem Stand, den DIESER Rechner beim Laden gesehen hat. Genau daran
 * ist im Haus schon einmal der Kundenumsatz gestorben (M-01).
 */
export function updatePayload(
  base: Record<string, unknown>,
  form: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const a = base[f];
    const b = form[f];
    if (gleich(a, b)) continue;
    // Ein geleertes Feld ist eine Aussage („weg damit"), und der Primary nimmt dafür `null`.
    out[f] = leer(b) ? null : b;
  }
  return out;
}

function gleich(a: unknown, b: unknown): boolean {
  if (leer(a) && leer(b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  return a === b;
}
