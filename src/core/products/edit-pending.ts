// ═════════════════════════════════════════════════════════════════
// ARTIKELVARIANTEN / Konflikt-Rückweg der Artikelmaske — „was hat der Benutzer in DIESER Maske geändert?"
//
// Die Maske merkt sich beim Öffnen ihren Ausgangsstand (`basis`). Ungespeichert ist, was der Benutzer gegenüber diesem
// Stand geändert hat — nicht mehr. Lädt der Artikel neu (ein anderer Rechner, „Merge photos", ein Konflikt), zeigt die
// Maske die AKTUELLEN Daten und legt nur diese Eingaben darüber; alles, was der Benutzer nicht angefasst hat, kommt frisch
// vom Artikel. Wo dasselbe Feld auch woanders geändert wurde, wird das ausdrücklich angezeigt — gespeichert wird nur auf
// einen erneuten Klick, über dieselben Prüfwege (VAT-Sperre, Rechte, Standprüfung) wie immer. Rein, ohne Zustand.
// ═════════════════════════════════════════════════════════════════

/** Die Stammdatenfelder der Maske (Bilder, Menge, Status und Herkunft gehören nicht dazu). */
export const EDIT_PENDING_FIELDS = [
  'categoryId', 'brand', 'name', 'sku', 'condition', 'scopeOfDelivery', 'storageLocation',
  'purchaseDate', 'purchasePrice', 'plannedSalePrice', 'minSalePrice', 'maxSalePrice',
  'taxScheme', 'supplierName', 'purchaseSource', 'paidFrom', 'notes',
] as const;

type Werte = Record<string, unknown>;

/** Leer ist leer: `undefined`, `null` und `''` gelten als gleich (die Maske schreibt alle drei). */
function norm(v: unknown): unknown {
  if (v === undefined || v === null || v === '') return null;
  if (Array.isArray(v)) return v.map(norm);
  if (typeof v === 'object') {
    const o = v as Werte;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, norm(o[k])]));
  }
  return v;
}
export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

export interface EditBasis { form: Werte; attrs: Werte }
export interface PendingEdits { fields: Werte; attrs: Werte }

/** Was der Benutzer gegenüber dem Ausgangsstand geändert hat (Felder und Merkmale getrennt). */
export function pendingEdits(form: Werte, attrs: Werte, basis: EditBasis): PendingEdits {
  const fields: Werte = {};
  for (const k of EDIT_PENDING_FIELDS) if (!sameValue(form[k], basis.form[k])) fields[k] = form[k];
  const out: Werte = {};
  for (const k of new Set([...Object.keys(attrs ?? {}), ...Object.keys(basis.attrs ?? {})])) {
    if (!sameValue(attrs?.[k], basis.attrs?.[k])) out[k] = attrs?.[k];
  }
  return { fields, attrs: out };
}

/** Aktuelle Artikeldaten + die ungespeicherten Eingaben darüber. Bilder und alles andere kommen vom Aufrufer. */
export function rebaseOnFresh(fresh: Werte, freshAttrs: Werte, pending: PendingEdits): { form: Werte; attrs: Werte } {
  const attrs: Werte = { ...(freshAttrs ?? {}) };
  for (const [k, v] of Object.entries(pending.attrs)) {
    if (v === undefined) delete attrs[k]; else attrs[k] = v;
  }
  return { form: { ...fresh, ...pending.fields }, attrs };
}

export interface PendingEntry {
  key: string;
  attr: boolean;
  /** die Eingabe des Benutzers (wird gespeichert) */
  mine: unknown;
  /** der Wert beim Öffnen der Maske */
  was: unknown;
  /** der Wert jetzt am Artikel */
  now: unknown;
  /** dasselbe Feld wurde auch woanders geändert — ausdrücklich anzeigen, nie still übergehen */
  changedElsewhere: boolean;
}

/** Die Liste für den Hinweis: jede ungespeicherte Eingabe mit Ausgangs- und aktuellem Wert. */
export function pendingList(pending: PendingEdits, basis: EditBasis, fresh: Werte, freshAttrs: Werte): PendingEntry[] {
  const out: PendingEntry[] = [];
  for (const [k, mine] of Object.entries(pending.fields)) {
    const was = basis.form[k], now = fresh[k];
    if (sameValue(mine, now)) continue;   // steht schon so am Artikel — nichts mehr offen
    out.push({ key: k, attr: false, mine, was, now, changedElsewhere: !sameValue(was, now) });
  }
  for (const [k, mine] of Object.entries(pending.attrs)) {
    const was = basis.attrs?.[k], now = freshAttrs?.[k];
    if (sameValue(mine, now)) continue;
    out.push({ key: k, attr: true, mine, was, now, changedElsewhere: !sameValue(was, now) });
  }
  return out;
}
