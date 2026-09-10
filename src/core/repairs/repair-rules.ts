// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R5C — die Regeln einer Reparatur: EINE Stelle, ohne Datenbank.
//
// Anlegen, Ändern und Abrechnen einer Reparatur hatten ihre Regeln an mehreren Orten, und sie
// waren nicht gleich:
//
//   • die Pflichtfelder einer Kategorie standen nur in der Anlegemaske;
//   • die Reparatur an EIGENER Ware (OWN) kannte nur die Maske — der Fernbefehl legte fest
//     Kundenreparaturen an;
//   • Zahlwege, Kartenart, Kategorie, Merkmale und Fotos schrieb nur die Detailseite — der
//     Fernbefehl wies sie ab;
//   • „abrechenbar" stand dreimal da: die Liste (nur fertig), die Detailseite (jeder Status) und
//     der Fernbefehl (fertig, plus eigene Prüfungen).
//
// Jetzt fragen alle hier: die Masken am Primary (über `repair-house`, in EINER Klammer), die
// Fernbefehle INNERHALB ihrer Transaktion, und die Masken am zweiten Rechner, um den Auftrag zu
// bauen. Das Modul ist bewusst rein — keine Datenbank, kein Store —, damit es auch der Rechner
// ohne Datenbank lädt.
// ════════════════════════════════════════════════════════════════════════════
import {
  REPAIR_CUSTOMER_PAID_FROM, REPAIR_INTERNAL_PAID_FROM, REPAIR_TAX_SCHEMES, REPAIR_TYPES,
  type Repair, type RepairTaxScheme,
} from '@/core/models/types';
import { CARD_BRANDS } from '@/core/finance/card-fees';
import { REPAIR_FIELDS } from '@/core/models/repair-fields';
import { internalCostOnCreate, internalCostOnEdit, repairMargin } from './repair-cost';

/** Höchstens so viele Fotos je Reparatur — dieselbe Zahl, die die Bildauswahl beider Masken zeigt. */
export const REPAIR_MAX_PHOTOS = 6;

/** Ein fachliches Nein zu einer Reparatur — mit dem Code, den auch der Fernbefehl meldet. */
export class RepairActionRejected extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RepairActionRejected';
    this.code = code;
  }
}

type RepairKind = typeof REPAIR_TYPES[number];
type Attrs = Record<string, string | number | boolean>;

const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === 'string' && (list as readonly string[]).includes(v);

/** Text einer Eingabe: getrimmt; leer heißt „nichts". */
export function repairText(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t === '' ? undefined : t;
}

/** Ein Geldbetrag der Maske: leer heißt „kein Wert"; negativ oder keine Zahl ist ein Nein. */
function money(v: unknown, name: string): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) {
    throw new RepairActionRejected('INVALID_AMOUNT', `${name} must be a number of at least 0`);
  }
  return n;
}

/** Die Merkmale einer Kategorie: ein flaches Objekt aus Text, Zahl oder Ja/Nein — sonst nichts. */
function attributes(v: unknown): Attrs {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw new RepairActionRejected('INVALID_ITEM_ATTRIBUTES', 'item attributes must be an object');
  }
  const out: Attrs = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (k.length === 0 || k.length > 64) {
      throw new RepairActionRejected('INVALID_ITEM_ATTRIBUTES', 'an item attribute needs a short name');
    }
    if (typeof x === 'string' || typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x))) {
      out[k] = x;
    } else {
      throw new RepairActionRejected('INVALID_ITEM_ATTRIBUTES', `item attribute ${k} must be text, a number or yes/no`);
    }
  }
  return out;
}

function repairKind(v: unknown): RepairKind {
  if (v === undefined || v === null || v === '') return 'internal';
  if (!oneOf(REPAIR_TYPES, v)) throw new RepairActionRejected('INVALID_REPAIR_TYPE', `unknown repair type: ${String(v)}`);
  return v;
}

// ── Pflichtfelder einer Kategorie ────────────────────────────────────────
//
// Wortgleich aus `RepairList.handleCreate` (v0.7.15) hierher gezogen: die rote Markierung war
// dort Pflicht, ein Fernauftrag hätte sie übergehen können.
export function missingRepairItemFields(
  form: Pick<Partial<Repair>, 'itemCategoryId' | 'itemAttributes' | 'itemBrand' | 'itemModel' | 'itemReference' | 'itemSerial'>,
): string[] {
  if (!form.itemCategoryId) return [];
  const missing: string[] = [];
  for (const f of REPAIR_FIELDS[form.itemCategoryId] || []) {
    if (!f.required) continue;
    // dependsOn beachten — wenn Parent nicht passt, Feld nicht required.
    if (f.dependsOn) {
      const dep = form.itemAttributes?.[f.dependsOn.key];
      if (!dep || !f.dependsOn.valueIncludes.includes(String(dep))) continue;
    }
    const v = f.coreField
      ? (form[f.coreField] as string | undefined) || ''
      : form.itemAttributes?.[f.key];
    if (f.type === 'number') {
      if (typeof v !== 'number' || isNaN(v) || v === 0) missing.push(f.label);
    } else if (f.type === 'boolean') {
      if (v === undefined || v === null) missing.push(f.label);
    } else if (!String(v ?? '').trim()) {
      missing.push(f.label);
    }
  }
  return missing;
}

// ── Eigene Ware ──────────────────────────────────────────────────────────

/** Welche Artikel die Maske als „Own Item" anbietet — und der Fernbefehl annimmt. */
export function isRepairableOwnProduct(p: { id: string; sourceType?: string | null }): boolean {
  return p.sourceType === 'OWN' && !p.id.startsWith('svc-repair-');
}

// ── Anlegen ──────────────────────────────────────────────────────────────

export interface RepairCreateInput {
  repairScope: 'CUSTOMER' | 'OWN';
  customerId?: string;
  productId?: string;
  lotId?: string;
  itemCategoryId?: string;
  itemAttributes: Attrs;
  itemBrand?: string;
  itemModel?: string;
  itemReference?: string;
  itemSerial?: string;
  itemDescription?: string;
  issueDescription: string;
  repairType: RepairKind;
  workshopSupplierId?: string;
  estimatedCost?: number;
  internalCost?: number;
  chargeToCustomer?: number;
  taxScheme: RepairTaxScheme;
  estimatedReady?: string;
  staffId?: string;
  notes?: string;
}

/**
 * Was die Anlegemaske wirklich anlegt — nach den Regeln, die sie SICHTBAR macht.
 *
 *  • Eigene Ware (OWN): kein Kunde, kein Preis, keine Steuerwahl (die Maske zeigt keine — es gilt
 *    die des Hauses), und die Artikelangaben kommen vom Artikel (`planRepairCreate`), nicht aus
 *    Feldern, die vom Umschalten liegen geblieben sind.
 *  • Kundenreparatur: kein Artikel, kein Los.
 *  • Arbeit im eigenen Haus (`internal`): keine Werkstatt — die Maske blendet die Auswahl dann aus.
 *  • Ein leeres Zahlenfeld und eine 0 sind in der Maske dasselbe („enter later").
 */
export function normalizeRepairCreate(form: Partial<Repair>): RepairCreateInput {
  const own = form.repairScope === 'OWN';
  const repairType = repairKind(form.repairType);
  let taxScheme: RepairTaxScheme = 'VAT_10';
  if (!own && form.taxScheme !== undefined && form.taxScheme !== null) {
    if (!oneOf(REPAIR_TAX_SCHEMES, form.taxScheme)) {
      throw new RepairActionRejected('INVALID_TAX_SCHEME', `unknown tax scheme: ${String(form.taxScheme)}`);
    }
    taxScheme = form.taxScheme;
  }
  const item = (v: unknown): string | undefined => (own ? undefined : repairText(v));
  return {
    repairScope: own ? 'OWN' : 'CUSTOMER',
    customerId: own ? undefined : repairText(form.customerId),
    productId: own ? repairText(form.productId) : undefined,
    lotId: own ? repairText(form.lotId) : undefined,
    itemCategoryId: item(form.itemCategoryId),
    itemAttributes: own ? {} : attributes(form.itemAttributes),
    itemBrand: item(form.itemBrand),
    itemModel: item(form.itemModel),
    itemReference: item(form.itemReference),
    itemSerial: item(form.itemSerial),
    itemDescription: item(form.itemDescription),
    issueDescription: repairText(form.issueDescription) ?? '',
    repairType,
    workshopSupplierId: repairType === 'internal' ? undefined : repairText(form.workshopSupplierId),
    estimatedCost: money(form.estimatedCost, 'estimatedCost') || undefined,
    internalCost: money(form.internalCost, 'internalCost') || undefined,
    chargeToCustomer: own ? undefined : (money(form.chargeToCustomer, 'chargeToCustomer') || undefined),
    taxScheme,
    estimatedReady: repairText(form.estimatedReady),
    staffId: repairText(form.staffId),
    notes: repairText(form.notes),
  };
}

/** Was eine Anlage im Haus nachschlagen muss — am Primary gegen die Datenbank, im Test gestellt. */
export interface RepairHousePort {
  customerExists: (id: string) => boolean;
  product: (id: string) => {
    id: string; sourceType: string | null; brand?: string; name?: string; sku?: string; categoryId?: string;
  } | undefined;
  lotBelongs: (lotId: string, productId: string) => boolean;
  supplierExists: (id: string) => boolean;
  employeeExists: (id: string) => boolean;
  categoryExists: (id: string) => boolean;
}

/**
 * Die Anlage, wie das Haus sie schreibt: geprüft, und bei eigener Ware mit den Angaben DES
 * ARTIKELS. Belegnummer, Gutscheincode, Anfangsstatus, Bestandsstatus `in_repair` und der
 * Platzhalter-Kunde der eigenen Ware entstehen danach in `createRepair` — nie aus einer Eingabe.
 */
export function planRepairCreate(input: RepairCreateInput, port: RepairHousePort): Partial<Repair> {
  if (!input.issueDescription) {
    throw new RepairActionRejected('ISSUE_REQUIRED', 'describe the issue or the requested repair');
  }
  let item: Partial<Repair>;
  let customerId: string | undefined;
  if (input.repairScope === 'OWN') {
    if (!input.productId) throw new RepairActionRejected('PRODUCT_REQUIRED', 'an own-item repair needs the product from stock');
    const p = port.product(input.productId);
    if (!p) throw new RepairActionRejected('PRODUCT_NOT_FOUND', 'no such product in this branch');
    if (!isRepairableOwnProduct(p)) {
      throw new RepairActionRejected('PRODUCT_NOT_OWN', 'only an item of our own stock is repaired as an own item');
    }
    if (input.lotId && !port.lotBelongs(input.lotId, p.id)) {
      throw new RepairActionRejected('LOT_NOT_FOUND', 'this stock lot is not an active lot of the product');
    }
    // Dieselbe Übernahme wie beim Auswählen in der Maske — aber vom Artikel, wie er JETZT ist.
    item = {
      productId: p.id, lotId: input.lotId,
      itemBrand: p.brand || undefined, itemModel: p.name || undefined,
      itemReference: p.sku || undefined, itemCategoryId: p.categoryId || undefined,
      itemAttributes: {},
    };
  } else {
    if (!input.customerId || !port.customerExists(input.customerId)) {
      throw new RepairActionRejected('CUSTOMER_NOT_FOUND', 'no such client in this branch');
    }
    if (input.itemCategoryId && !port.categoryExists(input.itemCategoryId)) {
      throw new RepairActionRejected('CATEGORY_NOT_FOUND', 'no such item category');
    }
    const missing = missingRepairItemFields(input);
    if (missing.length > 0) {
      throw new RepairActionRejected('REQUIRED_FIELDS_MISSING', `Please fill in the required fields: ${missing.join(', ')}`);
    }
    customerId = input.customerId;
    item = {
      itemCategoryId: input.itemCategoryId, itemAttributes: input.itemAttributes,
      itemBrand: input.itemBrand, itemModel: input.itemModel, itemReference: input.itemReference,
      itemSerial: input.itemSerial, itemDescription: input.itemDescription,
    };
  }
  if (input.workshopSupplierId && !port.supplierExists(input.workshopSupplierId)) {
    throw new RepairActionRejected('SUPPLIER_NOT_FOUND', 'no such workshop supplier in this branch');
  }
  if (input.staffId && !port.employeeExists(input.staffId)) {
    throw new RepairActionRejected('EMPLOYEE_NOT_FOUND', 'no such active employee in this branch');
  }
  return {
    repairScope: input.repairScope,
    customerId,
    ...item,
    issueDescription: input.issueDescription,
    repairType: input.repairType,
    taxScheme: input.taxScheme,
    workshopSupplierId: input.workshopSupplierId,
    estimatedCost: input.estimatedCost,
    // CENTRAL-C3F FINAL — die eigenen Kosten bei der Aufnahme, aus der geteilten Ableitung.
    internalCost: internalCostOnCreate(input),
    chargeToCustomer: input.chargeToCustomer,
    estimatedReady: input.estimatedReady,
    staffId: input.staffId,
    notes: input.notes,
  };
}

/** Der Auftrag vom zweiten Rechner: die Eingabe wie oben, statt der Fotos ihre Ablagekennungen. */
export function repairCreateBody(form: Partial<Repair>, stagingIds: readonly string[]): Record<string, unknown> {
  const i = normalizeRepairCreate(form);
  const body: Record<string, unknown> = {
    repairScope: i.repairScope, issueDescription: i.issueDescription, repairType: i.repairType,
  };
  if (i.repairScope === 'CUSTOMER') body.taxScheme = i.taxScheme;
  for (const k of [
    'customerId', 'productId', 'lotId', 'itemCategoryId', 'itemBrand', 'itemModel', 'itemReference',
    'itemSerial', 'itemDescription', 'workshopSupplierId', 'estimatedCost', 'internalCost',
    'chargeToCustomer', 'estimatedReady', 'staffId', 'notes',
  ] as const) {
    if (i[k] !== undefined) body[k] = i[k];
  }
  if (Object.keys(i.itemAttributes).length > 0) body.itemAttributes = i.itemAttributes;
  if (stagingIds.length > 0) body.photos = stagingIds.map((stagingId) => ({ stagingId }));
  return body;
}

// ── Ändern ───────────────────────────────────────────────────────────────

/**
 * Was die „Save"-Maske der Detailseite bearbeitet — und nur das. `externalVendor` und
 * `taxScheme` schickte sie bisher unverändert mit, ohne ein Feld dafür zu haben; sie sind keine
 * Eingabe dieser Handlung (die Steuer wählt der Rechnungsdialog).
 */
export const REPAIR_EDIT_INPUTS = [
  'diagnosis', 'estimatedCost', 'actualCost', 'internalCost', 'chargeToCustomer',
  'customerPaidFrom', 'customerCardBrand', 'internalPaidFrom',
  'repairType', 'workshopSupplierId', 'estimatedReady', 'notes',
  'itemCategoryId', 'itemAttributes', 'itemBrand', 'itemModel', 'itemReference', 'itemSerial',
  'itemDescription', 'issueDescription', 'images',
] as const;
export type RepairEditInput = typeof REPAIR_EDIT_INPUTS[number];

/** Die Kartenart gilt nur bei Kartenzahlung; ohne Angabe ist sie „normal" (v0.7.26). */
export function repairCardBrandFor(paidFrom: unknown, brand: unknown): 'normal' | 'amex' | null {
  if (paidFrom !== 'card') return null;
  if (brand === undefined || brand === null) return 'normal';
  if (!oneOf(CARD_BRANDS, brand)) throw new RepairActionRejected('INVALID_CARD_BRAND', `unknown card brand: ${String(brand)}`);
  return brand;
}

/** Die Eingaben der Maske in ihrer gemeinsamen, vergleichbaren Form (leer = `null`). */
export function repairEditInputs(e: Partial<Repair>): Record<RepairEditInput, unknown> {
  const paid = e.customerPaidFrom ?? null;
  if (paid !== null && !oneOf(REPAIR_CUSTOMER_PAID_FROM, paid)) {
    throw new RepairActionRejected('INVALID_PAYMENT_METHOD', `unknown payment method: ${String(paid)}`);
  }
  const internalPaid = e.internalPaidFrom ?? null;
  if (internalPaid !== null && !oneOf(REPAIR_INTERNAL_PAID_FROM, internalPaid)) {
    throw new RepairActionRejected('INVALID_PAYMENT_METHOD', `unknown payment method: ${String(internalPaid)}`);
  }
  const t = (v: unknown): string | null => repairText(v) ?? null;
  return {
    diagnosis: t(e.diagnosis),
    estimatedCost: money(e.estimatedCost, 'estimatedCost') ?? null,
    actualCost: money(e.actualCost, 'actualCost') ?? null,
    internalCost: money(e.internalCost, 'internalCost') ?? 0,
    chargeToCustomer: money(e.chargeToCustomer, 'chargeToCustomer') ?? null,
    customerPaidFrom: paid,
    customerCardBrand: repairCardBrandFor(paid, e.customerCardBrand),
    internalPaidFrom: internalPaid,
    repairType: repairKind(e.repairType),
    workshopSupplierId: t(e.workshopSupplierId),
    estimatedReady: t(e.estimatedReady),
    notes: t(e.notes),
    itemCategoryId: t(e.itemCategoryId),
    itemAttributes: attributes(e.itemAttributes),
    itemBrand: t(e.itemBrand),
    itemModel: t(e.itemModel),
    itemReference: t(e.itemReference),
    itemSerial: t(e.itemSerial),
    itemDescription: t(e.itemDescription),
    // Die Spalte trägt kein NULL; die Maske lässt das Feld leeren — dann steht dort ''.
    issueDescription: typeof e.issueDescription === 'string' ? e.issueDescription.trim() : '',
    images: Array.isArray(e.images) ? e.images.filter((x): x is string => typeof x === 'string') : [],
  };
}

/**
 * Was „Save" schreibt — auf dem Primary aus der Maske, beim Fernbefehl aus dem Stand, der nach
 * der Änderung gilt (Zeile + Auftrag). Die abgeleiteten Werte (eigene Kosten, Marge, Kartenart)
 * rechnet in beiden Fällen DIESE Funktion; der Auftrag trägt sie nie.
 */
export function buildRepairEditPatch(e: Partial<Repair>): Partial<Repair> {
  const i = repairEditInputs(e);
  const u = <T>(v: unknown): T | undefined => (v === null ? undefined : v as T);
  const cost = {
    repairType: i.repairType as RepairKind,
    estimatedCost: i.estimatedCost as number | null,
    actualCost: i.actualCost as number | null,
    internalCost: i.internalCost as number,
    chargeToCustomer: i.chargeToCustomer as number | null,
  };
  return {
    diagnosis: u(i.diagnosis),
    estimatedCost: u(i.estimatedCost),
    actualCost: u(i.actualCost),
    internalCost: internalCostOnEdit(cost),
    chargeToCustomer: u(i.chargeToCustomer),
    customerPaidFrom: i.customerPaidFrom as Repair['customerPaidFrom'],
    customerCardBrand: i.customerCardBrand as Repair['customerCardBrand'],
    internalPaidFrom: i.internalPaidFrom as Repair['internalPaidFrom'],
    margin: repairMargin(cost) ?? undefined,
    repairType: cost.repairType,
    workshopSupplierId: u(i.workshopSupplierId),
    estimatedReady: u(i.estimatedReady),
    notes: u(i.notes),
    itemCategoryId: u(i.itemCategoryId),
    itemAttributes: i.itemAttributes as Attrs,
    itemBrand: u(i.itemBrand),
    itemModel: u(i.itemModel),
    itemReference: u(i.itemReference),
    itemSerial: u(i.itemSerial),
    itemDescription: u(i.itemDescription),
    issueDescription: i.issueDescription as string,
    images: i.images as string[],
  };
}

/** Werkstatt und Kategorie, wenn sie sich ÄNDERN, müssen im Haus existieren. */
export function assertRepairEditRefs(
  patch: Partial<Repair>, seen: Partial<Repair>, port: Pick<RepairHousePort, 'supplierExists' | 'categoryExists'>,
): void {
  if (patch.workshopSupplierId && patch.workshopSupplierId !== seen.workshopSupplierId
    && !port.supplierExists(patch.workshopSupplierId)) {
    throw new RepairActionRejected('SUPPLIER_NOT_FOUND', 'no such workshop supplier in this branch');
  }
  if (patch.itemCategoryId && patch.itemCategoryId !== seen.itemCategoryId
    && !port.categoryExists(patch.itemCategoryId)) {
    throw new RepairActionRejected('CATEGORY_NOT_FOUND', 'no such item category');
  }
}

const vergleichbar = (v: unknown): string => {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return JSON.stringify(Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))));
  }
  return JSON.stringify(v ?? null);
};

/** Nur der Unterschied — Fotos ausgenommen, die reisen als Plan (`repairPhotoPlan`). */
export function repairEditChanges(seen: Partial<Repair>, now: Partial<Repair>): Record<string, unknown> {
  const a = repairEditInputs(seen);
  const b = repairEditInputs(now);
  const out: Record<string, unknown> = {};
  for (const k of REPAIR_EDIT_INPUTS) {
    if (k === 'images') continue;
    if (vergleichbar(a[k]) !== vergleichbar(b[k])) out[k] = b[k];
  }
  return out;
}

export function repairPhotosChanged(seen: Partial<Repair>, now: Partial<Repair>): boolean {
  return JSON.stringify(seen.images ?? []) !== JSON.stringify(now.images ?? []);
}

/** Gibt es überhaupt etwas zu schicken? Eine ungültige Eingabe zählt als „ja" — sie soll ihr Nein bekommen. */
export function repairEditHasChanges(seen: Partial<Repair>, now: Partial<Repair>): boolean {
  if (repairPhotosChanged(seen, now)) return true;
  try { return Object.keys(repairEditChanges(seen, now)).length > 0; } catch { return true; }
}

/**
 * Ein Foto im Auftrag: ein vorhandenes (seine Stelle in der GESEHENEN Liste — die Fassung sichert,
 * dass es dieselbe ist) oder ein neues (seine Kennung in der Zwischenablage). Nie Bytes.
 * Dieselbe Form wie die Galerie beim Artikel ändern.
 */
export type RepairPhotoSlot = { keep: number } | { stagingId: string };

export async function repairPhotoPlan(
  seen: readonly string[], now: readonly string[], stage: (urls: string[]) => Promise<string[]>,
): Promise<RepairPhotoSlot[]> {
  const fresh = now.filter((u) => !seen.includes(u));
  const ids = fresh.length > 0 ? await stage(fresh) : [];
  const idOf = new Map(fresh.map((u, i) => [u, ids[i]]));
  return now.map((u) => (seen.includes(u) ? { keep: seen.indexOf(u) } : { stagingId: String(idOf.get(u)) }));
}

export function repairEditBody(
  id: string, revision: number, seen: Partial<Repair>, now: Partial<Repair>, photos?: RepairPhotoSlot[],
): Record<string, unknown> {
  return { id, expectedRevision: revision, ...repairEditChanges(seen, now), ...(photos ? { photos } : {}) };
}

// ── Abrechnen ────────────────────────────────────────────────────────────

/**
 * Wann eine Reparatur abgerechnet wird — EINE Regel für Liste, Detailseite und Fernbefehl.
 *
 * Fertig oder abgeholt: vorher steht der Preis nicht fest (die Kosten kommen oft erst mit der
 * Werkstatt), und eine Rechnung lässt sich nicht nachziehen. „Abgeholt" gehört dazu — das
 * Rechnungskürzel der Liste stand dort ausdrücklich („nach Abholung trotzdem fakturierbar"), nur
 * der Store wies es ab, und die Detailseite fragte gar nicht nach dem Status.
 */
export const REPAIR_INVOICEABLE_STATUSES: readonly string[] = ['ready', 'READY', 'picked_up', 'DELIVERED'];

export interface RepairInvoiceCandidate {
  repairNumber?: string;
  status?: string;
  invoiceId?: string | null;
  chargeToCustomer?: number | null;
  repairScope?: string | null;
  customerId?: string | null;
}

export function repairInvoiceBlocker(r: RepairInvoiceCandidate): { code: string; message: string } | null {
  const nr = r.repairNumber || 'this repair';
  if (r.invoiceId) return { code: 'REPAIR_ALREADY_INVOICED', message: `Repair ${nr} is already linked to an invoice.` };
  // Eigene Ware wird nicht dem Kunden berechnet — ihre Kosten gehen auf den Artikel.
  if (r.repairScope === 'OWN') return { code: 'REPAIR_IS_OWN_STOCK', message: `Repair ${nr} is on our own stock — it is not invoiced.` };
  if (!(Number(r.chargeToCustomer) > 0)) return { code: 'REPAIR_HAS_NO_CHARGE', message: `Repair ${nr} has no charge — nothing to invoice.` };
  if (!r.customerId || r.customerId.startsWith('sys-')) {
    return { code: 'REPAIR_HAS_NO_CUSTOMER', message: `Repair ${nr} has no client.` };
  }
  if (!REPAIR_INVOICEABLE_STATUSES.includes(String(r.status ?? ''))) {
    return { code: 'REPAIR_NOT_READY', message: `Repair ${nr} is not READY — only ready or picked-up repairs are invoiced.` };
  }
  return null;
}

export function isRepairTaxScheme(v: unknown): v is RepairTaxScheme {
  return oneOf(REPAIR_TAX_SCHEMES, v);
}

export function canInvoiceRepair(r: RepairInvoiceCandidate): boolean {
  return repairInvoiceBlocker(r) === null;
}

/**
 * Die Wahl der beiden Dialoge der Detailseite (Steuer, Nummernart). Es gibt sie NUR dort, und die
 * Detailseite rechnet genau EINE Reparatur ab; die Liste (Auswahl und Kürzel) fragt nicht.
 */
export interface RepairInvoiceOptions {
  taxScheme?: RepairTaxScheme;
  specialMark?: boolean;
}

/**
 * R5C FINAL — der Vermerk auf der Rechnung, je Handlung genau der, den das Haus vor R5C schrieb:
 *
 *  • Detailseite (Einzelrechnung über die Dialoge): `Repair Service · Nr · Problem`;
 *  • Liste — die Auswahl UND das Kürzel je Zeile, beide ohne Dialog: `Combined Repair Service · Nr, …`,
 *    auch bei einer einzigen Reparatur (das Kürzel rief schon immer die Sammelfunktion).
 */
export function repairInvoiceNotes(
  reps: ReadonlyArray<{ repairNumber: string; issueDescription?: string }>, ausDemDialog: boolean,
): string {
  if (ausDemDialog) {
    const r = reps[0];
    return `Repair Service · ${r.repairNumber}${r.issueDescription ? ' · ' + r.issueDescription : ''}`;
  }
  return `Combined Repair Service · ${reps.map((r) => r.repairNumber).join(', ')}`;
}

/** Der Auftrag vom zweiten Rechner: welche Reparaturen, in welcher gesehenen Fassung, welche Wahl. */
export function repairInvoiceBody(
  repairs: ReadonlyArray<{ id: string; revision?: number }>, opts: RepairInvoiceOptions = {},
): Record<string, unknown> {
  const ohne = repairs.filter((r) => !r.revision);
  if (ohne.length > 0) {
    throw new RepairActionRejected('CLIENT_WRITE_UNSUPPORTED', 'invoicing a repair is not possible here (no revision loaded)');
  }
  const body: Record<string, unknown> = {
    repairs: repairs.map((r) => ({ repairId: r.id, expectedRevision: r.revision })),
  };
  if (opts.taxScheme) body.taxScheme = opts.taxScheme;
  if (opts.specialMark === true) body.specialMark = true;
  return body;
}
