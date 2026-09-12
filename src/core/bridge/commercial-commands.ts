// CENTRAL-C3E — Einkauf, Kommission und Auftrag von einem zweiten Rechner.
//
// Drei Module, fünf Operationen — und die Zahl fünf ist das Ergebnis eines Audits, nicht eines
// Wunsches. Was der Primary heute wirklich kann, steht in `handleSave` seiner drei Bildschirme;
// alles andere wäre hier erfunden worden:
//
//  • **Einkauf: nur Anlegen.** Es gibt im ganzen Haus keine Bearbeitung eines Einkaufs — kein
//    `updatePurchase`, kein `editPurchase`, keinen Bildschirm dafür. Ein Einkauf wird angelegt,
//    bezahlt, storniert oder zurückgegeben. Eine Fern-Bearbeitung zu bauen hieße, die Bewertung
//    von Ware (Lose, Einstandskosten, Verbindlichkeit) ein zweites Mal zu schreiben — genau das,
//    was hier nie passieren darf. Also nicht.
//  • **Kommission: Anlegen und Ändern — und das Ändern ist EIN Auftrag, obwohl es im Haus zwei
//    Verträge sind.** Der „Save"-Knopf am Primary ruft `updateConsignmentPayoutModel` (darf
//    scheitern) und danach `updateConsignment`. Das ist keine Bequemlichkeit, sondern die
//    Bedeutung: das Modell zuerst, weil eine Sperre es ablehnen kann, und dann erst der Rest —
//    sonst fände der Benutzer die Hälfte seiner Eingabe gespeichert. Hier laufen beide in EINER
//    Transaktion; damit ist der Fernweg an dieser Stelle sogar strenger als der Primary, wo ein
//    Fehler im zweiten Schritt den ersten stehen ließe.
//  • **Auftrag: Anlegen und Ändern.** Seit R5E JEDE Auftragsart — normal, Sonderanfertigung,
//    gemischt — über DIESELBE Vorbereitung wie die Maske des Primary (`core/orders/order-create`,
//    `order-edit`, Anschluss `order-house`): der Client schickt Eingaben, das Haus leitet Zeilen,
//    Summe, Steuer, Kopf, Marge, Rest und die Gold-Verbindlichkeit ab — in EINER Transaktion.
//    Beim Sonderauftrag zieht „Save" den Preis der Angebotszeile, nicht den Kopfpreis.
//  • R5E — **Einkauf** ebenso (`core/purchases/purchase-create`, Anschluss `purchase-house`): neue
//    Artikel über die Maske „New Item", Mitarbeiter, Herkunft aus Auftrag und Inbox-Foto.
//
// Was für alle fünf gilt:
//
//  1. **Es wird nichts nachgebaut.** Jede Operation ruft genau die Funktion, die auch der Mensch
//     am Primary auslöst — `createPurchase`, `createProduct` + `createConsignment`,
//     `updateConsignmentPayoutModel` + `updateConsignment`, `createOrder`, `updateOrder`. Lose,
//     Verbindlichkeiten, Buchungen, Belegnummern, Provisionsmodelle: alles bleibt dort.
//  2. **Die äußere Klammer kommt von hier.** Keine der fünf Domänenfunktionen öffnet selbst eine
//     Transaktion — sie schreiben und rufen `saveDatabase()`. Ohne die Klammer der C3A-Maschine
//     gäbe es zwischen Beleg und Nachweis ein Fenster, und eine Wiederholung buchte ein zweites
//     Mal. Mit ihr teilen Wirkung und Nachweis ein Schicksal.
//  3. **Der Client bestimmt keine Zahl, die das Haus ableitet.** Keine Belegnummer, keine Summe,
//     keine Marge, kein Reststand, keine SKU, kein Status, keine Kennung. Unbekannte Felder
//     werden abgewiesen, statt still ignoriert zu werden: ein ignoriertes Feld ist ein Vertrag,
//     den der Absender zu haben glaubt.
//  4. **Ändern braucht die gesehene FASSUNG.** `orders` und `consignments` hatten bisher gar keine
//     Absicherung — beide schreiben ihre Spalten bedingungslos. Mit einem zweiten Rechner ist das
//     verlorene Update kein Randfall mehr. Der Token ist derselbe wie bei der Rechnung: eine vom
//     Trigger geführte Ganzzahl, verglichen INNERHALB der Transaktion. Kein Zeitstempel.

import { getDatabase, saveDatabaseDurably } from '@/core/db/database';
import { query } from '@/core/db/helpers';
import {
  beginLedgerTransaction, commitLedgerTransaction, rollbackLedgerTransaction,
} from '@/core/ledger/posting';
import { useConsignmentStore } from '@/stores/consignmentStore';
import { useProductStore } from '@/stores/productStore';
import type { OrderStatus, Product } from '@/core/models/types';
import {
  GOLD_KARATS, ORDER_CREATE_STATUSES, ORDER_LINE_SCHEMES, ORDER_MATERIAL_KINDS, ORDER_PAYMENT_METHODS,
  ORDER_QUOTE_SCHEMES, ORDER_TYPES, OrderActionRejected, assertOrderCreateValues, type OrderCreateInput,
} from '@/core/orders/order-create';
import { ORDER_EDIT_FIELDS, type OrderEditInput } from '@/core/orders/order-edit';
import { createOrderInHouse, updateOrderInHouse } from '@/core/orders/order-house';
import {
  PURCHASE_PAYMENT_METHODS, PURCHASE_TAX_SCHEMES, PurchaseActionRejected, type PurchaseCreateInput,
} from '@/core/purchases/purchase-create';
import { createPurchaseInHouse } from '@/core/purchases/purchase-house';
import { EMBEDDED_PRODUCT_FIELDS, FINAL_PRODUCT_FIELDS, EmbeddedProductRejected } from '@/core/products/embedded-product';
import { payoutModelLock, PayoutPatchError } from '@/core/consignment/payout-edit';
import { rowToConsignment } from '@/stores/consignmentStore';
import { CommandRejected, runRemoteCommand, type CommandOutcome, type EngineDeps } from './mutation-engine';
import type { CommandIdentity } from './command-ledger';
import { BusinessError, registerCommand, type CommandActor } from './command-registry';
import { CommandNotEvaluated } from './mutation-engine';
import {
  invokeReadStaged, invokeDiscardStaged, assertHouseBranch, parseStagingIds, readStagedAsDataUrls,
  discardStagedAfterSuccess, stagingOwnerOf, type StagedMediaReader, type StagedMediaDiscard, type StagingOwner,
} from './remote-create-support';
import {
  createConsignmentWithProduct, houseConsignmentPort, ConsignmentCreateRejected, ConsignmentMediaIncomplete,
  type ConsignmentCreateInput,
} from '@/core/consignment/consignment-create';
import { CONSIGNMENT_PRODUCT_FIELDS } from '@/core/data/write-payloads';
// Die Schemata des Hauses — nicht die engere Einkaufsliste weiter unten (Einkauf kennt kein MARGIN).
import { TAX_SCHEMES as HOUSE_TAX_SCHEMES } from '@/core/models/types';

export const OP_PURCHASES_CREATE = 'purchases.create';
export const OP_CONSIGNMENTS_CREATE = 'consignments.create';
export const OP_CONSIGNMENTS_UPDATE = 'consignments.update';
export const OP_ORDERS_CREATE = 'orders.create';
export const OP_ORDERS_UPDATE = 'orders.update';

/** Die fünf Namen dieses Schnitts — dieselbe Liste kennt auch Rust. */
export const C3E_MUTATIONS = [
  OP_PURCHASES_CREATE,
  OP_CONSIGNMENTS_CREATE, OP_CONSIGNMENTS_UPDATE,
  OP_ORDERS_CREATE, OP_ORDERS_UPDATE,
] as const;

/** Höchstens so viele Positionen pro Beleg. Eine Grenze ist keine Fachregel, sondern ein Riegel
 *  gegen eine Nutzlast, die den Renderer für Minuten blockiert. */
export const MAX_DOC_LINES = 100;

/** Ein unbrauchbarer Rumpf. Kein Urteil der Domäne — es wurde nie etwas bewertet. */
export class CommercialPayloadError extends Error {
  readonly code = 'INVALID_PAYLOAD';
  constructor(message: string) {
    super(message);
    this.name = 'CommercialPayloadError';
  }
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function onlyKnownFields(raw: Record<string, unknown>, allowed: readonly string[]): void {
  for (const k of Object.keys(raw)) {
    if (!allowed.includes(k)) throw new CommercialPayloadError(`unknown field: ${k}`);
  }
}

function reqString(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new CommercialPayloadError(`${name} is required`);
  return v.trim();
}

function optString(v: unknown, name: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new CommercialPayloadError(`${name} must be a string`);
  const t = v.trim();
  return t === '' ? undefined : t;
}

function money(v: unknown, name: string, opts: { min?: number } = {}): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new CommercialPayloadError(`${name} must be a number`);
  const min = opts.min ?? 0;
  if (v < min) throw new CommercialPayloadError(`${name} must be at least ${min}`);
  return v;
}

function countOf(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    throw new CommercialPayloadError(`${name} must be a whole number greater than zero`);
  }
  return v;
}

/** Die zuvor GELESENE Fassung. Der Client darf sie nicht wählen, nur zurückreichen. */
function expectedRevisionOf(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw new CommercialPayloadError('expectedRevision is required — an edit must say which revision it saw');
  }
  return v;
}

/**
 * Der Vergleich der Fassung. Er läuft INNERHALB der Transaktion, gegen die Zeile selbst — nicht
 * gegen eine geladene Liste, die älter sein kann als die Datenbank.
 *
 * Der Ausgang ist ein eingefrorenes Urteil: diese Anfrage beschreibt einen Stand, den es nicht
 * mehr gibt, und sie wird nie wieder gültig. Wer trotzdem ändern will, liest neu und schickt einen
 * NEUEN Auftrag — mit neuer Kennung und neuer Entscheidung.
 */
function assertRevision(table: 'orders' | 'consignments', id: string, expected: number, notFound: string): number {
  const live = query(`SELECT revision FROM ${table} WHERE id = ?`, [id])[0];
  if (!live) throw new CommandRejected(notFound, 'no such record');
  const now = Number(live.revision ?? 0);
  if (now !== expected) {
    throw new CommandRejected(
      'RECORD_CHANGED',
      `this record changed since you opened it (you saw ${expected}, it is now ${now})`,
    );
  }
  return now;
}

export function commercialDeps(): EngineDeps {
  return {
    db: getDatabase() as never,
    begin: beginLedgerTransaction,
    commit: commitLedgerTransaction,
    rollback: rollbackLedgerTransaction,
    durableSave: saveDatabaseDurably,
    now: () => new Date().toISOString(),
  };
}

// ── Einkauf: anlegen ──────────────────────────────────────────────────────

/** Nur für Tests: wie der Primary an die abgelegten Bytes kommt und wie er aufräumt. */
export interface StagingExtras {
  readStaged?: StagedMediaReader;
  discardStaged?: StagedMediaDiscard;
}

/** Ein Nein der geteilten Regeln (Auftrag, Einkauf, Artikel-Entwurf) ist ein eingefrorenes Urteil. */
function urteil<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof OrderActionRejected || e instanceof PurchaseActionRejected || e instanceof EmbeddedProductRejected) {
      throw new CommandRejected(e.code, e.message);
    }
    throw e;
  }
}

const SPEC_TEXT = ['categoryId', 'brand', 'name', 'sku', 'condition', 'taxScheme', 'purchaseCurrency', 'storageLocation', 'notes'];

/**
 * Ein Artikel-Entwurf im Rumpf: GENAU die Felder der Maske „New Item" — und statt der Fotos ihre
 * Kennungen in der Zwischenablage. Einstand, Preise, Menge, Bestand, Herkunft stehen nicht darin.
 */
function parseSpec(raw: unknown, fields: readonly string[], what: string): { spec: Partial<Product>; stagingIds?: string[] } | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isPlain(raw)) throw new CommercialPayloadError(`${what} must be an object`);
  onlyKnownFields(raw, [...fields.filter((f) => f !== 'images'), 'stagingIds']);
  for (const k of SPEC_TEXT) {
    if (raw[k] !== undefined && raw[k] !== null && typeof raw[k] !== 'string') {
      throw new CommercialPayloadError(`${what}.${k} must be text`);
    }
  }
  if (raw.attributes !== undefined && raw.attributes !== null && !isPlain(raw.attributes)) {
    throw new CommercialPayloadError(`${what}.attributes must be an object`);
  }
  if (raw.scopeOfDelivery !== undefined && raw.scopeOfDelivery !== null
    && (!Array.isArray(raw.scopeOfDelivery) || raw.scopeOfDelivery.some((x) => typeof x !== 'string'))) {
    throw new CommercialPayloadError(`${what}.scopeOfDelivery must be a list of words`);
  }
  if (typeof raw.taxScheme === 'string' && !(HOUSE_TAX_SCHEMES as readonly string[]).includes(raw.taxScheme)) {
    throw new CommercialPayloadError(`unknown tax scheme: ${raw.taxScheme}`);
  }
  const { stagingIds, ...spec } = raw;
  return {
    spec: spec as Partial<Product>,
    stagingIds: stagingIds === undefined ? undefined : parseStagingIds(stagingIds, (m) => new CommercialPayloadError(m)),
  };
}

/** Die Fotos eines Entwurfs — INNERHALB des Auftrags gelesen. Eine Wiederholung liest sie nie wieder. */
async function mitFotos(
  p: { spec: Partial<Product>; stagingIds?: string[] } | undefined, owner: StagingOwner, read: StagedMediaReader,
): Promise<Partial<Product> | undefined> {
  if (!p) return undefined;
  if (p.stagingIds === undefined) return { ...p.spec };
  const images = await readStagedAsDataUrls(p.stagingIds, owner, read, (m) => new CommercialPayloadError(m));
  return { ...p.spec, images };
}

function num0(v: unknown, name: string): number {
  if (v === undefined || v === null) return 0;
  return money(v, name);
}
function text0(v: unknown, name: string): string {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new CommercialPayloadError(`${name} must be text`);
  return v;
}
function oneOf<T extends string>(v: unknown, list: readonly T[], fallback: T, name: string): T {
  if (v === undefined || v === null) return fallback;
  const s = String(v);
  if (!(list as readonly string[]).includes(s)) throw new CommercialPayloadError(`unknown ${name}: ${s || '(none)'}`);
  return s as T;
}

export interface PurchaseCreateRequest extends PurchaseCreateInput {
  /** Je Zeile der Entwurf mit den Kennungen seiner Fotos. */
  specs: Array<{ spec: Partial<Product>; stagingIds?: string[] } | undefined>;
  /** Die Anzahlung, wie `createPurchase` sie kennt (auch der Name des alten Rumpfs). */
  initialPayment?: { amount: number; method: typeof PURCHASE_PAYMENT_METHODS[number] };
}

/**
 * Was ein Mensch am Einkaufsbildschirm eingibt — und nichts sonst. R5E: auch NEUE Artikel (die
 * Maske „New Item"), den Mitarbeiter, die Herkunft aus einem Auftrag (`sourceOrderId`, je Zeile die
 * Auftragsposition) und aus einem Inbox-Foto. Belegnummer, Lose, Menge, Status, Vorsteuer,
 * Verbindlichkeit und Buchung rechnet das Haus.
 */
export function parsePurchaseCreate(raw: unknown): PurchaseCreateRequest {
  if (!isPlain(raw)) throw new CommercialPayloadError('payload must be an object');
  onlyKnownFields(raw, [
    'supplierId', 'purchaseDate', 'taxScheme', 'lines', 'paymentAmount', 'paymentMethod',
    'initialPayment', 'notes', 'staffId', 'sourceOrderId', 'inboxId',
  ]);
  if (!Array.isArray(raw.lines) || raw.lines.length === 0) {
    throw new CommercialPayloadError('a purchase needs at least one line');
  }
  if (raw.lines.length > MAX_DOC_LINES) throw new CommercialPayloadError('too many lines');
  const specs: PurchaseCreateRequest['specs'] = [];
  const lines = raw.lines.map((l, i) => {
    if (!isPlain(l)) throw new CommercialPayloadError(`line ${i + 1} must be an object`);
    onlyKnownFields(l, ['mode', 'productId', 'newProduct', 'brand', 'name', 'sku', 'categoryId', 'quantity', 'unitPrice', 'sourceOrderLineId']);
    const productId = optString(l.productId, `line ${i + 1}: productId`);
    const spec = parseSpec(l.newProduct, EMBEDDED_PRODUCT_FIELDS, `line ${i + 1}: newProduct`);
    specs.push(spec);
    return {
      mode: oneOf(l.mode, ['existing', 'new'] as const, productId ? 'existing' : 'new', `line ${i + 1} mode`),
      productId,
      newProduct: spec?.spec,
      brand: text0(l.brand, `line ${i + 1}: brand`),
      name: text0(l.name, `line ${i + 1}: name`),
      sku: text0(l.sku, `line ${i + 1}: sku`),
      categoryId: text0(l.categoryId, `line ${i + 1}: categoryId`),
      quantity: countOf(l.quantity, `line ${i + 1}: quantity`),
      // Ein Einkaufspreis von 0 ist eine gültige Aussage (Geschenk, Beigabe) — negativ nicht.
      unitPrice: money(l.unitPrice, `line ${i + 1}: unitPrice`),
      sourceOrderLineId: optString(l.sourceOrderLineId, `line ${i + 1}: sourceOrderLineId`),
    };
  });
  // Die Anzahlung: der Rumpf der Maske (`paymentAmount`/`paymentMethod`) oder der alte (`initialPayment`).
  let paymentAmount = num0(raw.paymentAmount, 'paymentAmount');
  let paymentMethod = oneOf(raw.paymentMethod, PURCHASE_PAYMENT_METHODS, 'bank', 'payment method');
  if (raw.initialPayment !== undefined && raw.initialPayment !== null) {
    if (raw.paymentAmount !== undefined) throw new CommercialPayloadError('one payment, not two');
    if (!isPlain(raw.initialPayment)) throw new CommercialPayloadError('initialPayment must be an object');
    onlyKnownFields(raw.initialPayment, ['amount', 'method']);
    paymentAmount = money(raw.initialPayment.amount, 'initialPayment.amount', { min: 0.001 });
    paymentMethod = oneOf(raw.initialPayment.method, PURCHASE_PAYMENT_METHODS, 'bank', 'payment method');
  }
  const out: PurchaseCreateRequest = {
    supplierId: reqString(raw.supplierId, 'supplierId'),
    purchaseDate: optString(raw.purchaseDate, 'purchaseDate') ?? new Date().toISOString().split('T')[0],
    taxScheme: oneOf(raw.taxScheme, PURCHASE_TAX_SCHEMES, 'ZERO', 'tax scheme'),
    lines,
    paymentAmount,
    paymentMethod,
    notes: text0(raw.notes, 'notes'),
    staffId: text0(raw.staffId, 'staffId'),
    sourceOrderId: optString(raw.sourceOrderId, 'sourceOrderId'),
    inboxId: optString(raw.inboxId, 'inboxId'),
    specs,
  };
  if (paymentAmount > 0) out.initialPayment = { amount: paymentAmount, method: paymentMethod };
  return out;
}

export type CommercialResult = { readonly [k: string]: unknown };

export async function runPurchaseCreate(
  deps: EngineDeps, identity: CommandIdentity, raw: unknown, extras: StagingExtras = {},
): Promise<CommandOutcome> {
  const req = parsePurchaseCreate(raw);
  const owner = stagingOwnerOf(identity);
  const read = extras.readStaged ?? invokeReadStaged;
  const staged = req.specs.flatMap((s) => s?.stagingIds ?? []);
  const outcome = await runRemoteCommand(deps, identity, async () => {
    // R5E — in die Bücher DIESER Filiale, oder gar nicht.
    assertHouseBranch(identity);
    const lines: Array<(typeof req.lines)[number]> = [];
    for (let i = 0; i < req.lines.length; i++) {
      lines.push({ ...req.lines[i], newProduct: await mitFotos(req.specs[i], owner, read) });
    }
    // Dieselbe Folge wie „Save Purchase" am Primary (`createPurchaseOnPrimary`): Lieferant, Artikel,
    // Entwürfe, Mitarbeiter, Auftrag und Inbox geprüft — dann die Hausfunktion: Belegnummer aus dem
    // durablen Zähler, ein Los je Zeile mit dem TATSÄCHLICHEN Einstand, neue Artikel, Menge,
    // Statusregel, Vorsteuer, Verbindlichkeit, Buchung, Auftragspositionen auf „Arrived".
    const purchase = urteil(() => createPurchaseInHouse({ ...req, lines }, identity.branchId));
    const value: CommercialResult = {
      purchaseId: purchase.id,
      purchaseNumber: purchase.purchaseNumber,
      status: purchase.status,
      totalAmount: purchase.totalAmount,
      paidAmount: purchase.paidAmount,
      openAmount: Math.max(0, purchase.totalAmount - purchase.paidAmount),
    };
    return value as unknown as Record<string, unknown>;
  });
  if (outcome.kind === 'ok') await discardStagedAfterSuccess(staged, owner, extras.discardStaged ?? invokeDiscardStaged);
  return outcome;
}

// ── Kommission: anlegen ───────────────────────────────────────────────────

const PAYOUT_MODELS = ['percent', 'consignor_fixed', 'cost_split'] as const;

export interface ConsignmentCreateRequest {
  consignorId: string;
  product: {
    categoryId: string;
    brand?: string;
    name?: string;
    condition?: string;
    notes?: string;
    /** R5B — eine eingetippte SKU, wie an der Maske. Fehlt sie, vergibt der Primary eine. */
    sku?: string;
    attributes?: Record<string, unknown>;
    taxScheme?: string;
    storageLocation?: string;
    scopeOfDelivery?: string[];
  };
  agreedPrice: number;
  minimumPrice?: number;
  payout: { model: string; commissionRate?: unknown; excessSplitPct?: unknown };
  expiryDate?: string;
  notes?: string;
  /** R5B — wer den Artikel angenommen hat (die Mitarbeiterauswahl der Maske). */
  staffId?: string;
  /** R5B — die Bilder des Artikels, als Kennungen der Zwischenablage. Nie als Bytes im Auftrag. */
  stagingIds: string[];
  /** „Trotzdem anlegen" — die bewusste Antwort auf einen Duplikatsverdacht. */
  acknowledgeDuplicate?: boolean;
}

/**
 * Die Kommission legt IMMER auch ihren Artikel an — genau wie die Maske am Primary. R5B: beide
 * Seiten fahren dafür DENSELBEN Vorgang (`core/consignment/consignment-create`): dieselben
 * Prüfungen, derselbe Anlageweg mit Medienspeicher, dieselben festen Werte (`stockStatus:
 * 'consignment'`, `sourceType: 'CONSIGNMENT'`, Einstand 0, ein Stück), dieselbe Kommission — in
 * EINER Transaktion.
 *
 * Der Rumpf trägt deshalb, was die Maske erfasst: die Felder des Artikels (Attribute, Steuer,
 * Lagerort, Lieferumfang, eine eingetippte SKU), den Mitarbeiter, die Bildkennungen. Was die
 * Kommission FEST setzt — Einstand, Menge, Bestandsstatus, Herkunft — steht nicht darin.
 */
export function parseConsignmentCreate(raw: unknown): ConsignmentCreateRequest {
  if (!isPlain(raw)) throw new CommercialPayloadError('payload must be an object');
  onlyKnownFields(raw, [
    'consignorId', 'product', 'agreedPrice', 'minimumPrice', 'payout',
    'expiryDate', 'notes', 'staffId', 'stagingIds', 'acknowledgeDuplicate',
  ]);
  if (!isPlain(raw.product)) throw new CommercialPayloadError('product is required');
  onlyKnownFields(raw.product, [...CONSIGNMENT_PRODUCT_FIELDS, 'sku']);
  if (!isPlain(raw.payout)) throw new CommercialPayloadError('payout is required');
  onlyKnownFields(raw.payout, ['model', 'commissionRate', 'excessSplitPct']);
  const model = String(raw.payout.model ?? '');
  if (!(PAYOUT_MODELS as readonly string[]).includes(model)) {
    // Fail-closed und ausdrücklich: `fixed` ist ein Altmodell, das kein Bildschirm mehr anbietet.
    throw new CommercialPayloadError(`unknown payout model: ${model || '(none)'}`);
  }
  const p = raw.product;
  if (p.attributes !== undefined && p.attributes !== null && !isPlain(p.attributes)) {
    throw new CommercialPayloadError('product.attributes must be an object');
  }
  if (p.scopeOfDelivery !== undefined && p.scopeOfDelivery !== null
    && (!Array.isArray(p.scopeOfDelivery) || p.scopeOfDelivery.some((x) => typeof x !== 'string'))) {
    throw new CommercialPayloadError('product.scopeOfDelivery must be a list of words');
  }
  const taxScheme = optString(p.taxScheme, 'product.taxScheme');
  if (taxScheme !== undefined && !(HOUSE_TAX_SCHEMES as readonly string[]).includes(taxScheme)) {
    throw new CommercialPayloadError(`unknown tax scheme: ${taxScheme}`);
  }
  return {
    consignorId: reqString(raw.consignorId, 'consignorId'),
    product: {
      categoryId: reqString(p.categoryId, 'product.categoryId'),
      // Ob Marke und Name Pflicht sind, entscheidet die Pflichtfeldregel des Hauses — nicht der
      // Rumpf. Eine Goldkette ohne Marke ist an der Maske gültig, also auch hier.
      brand: optString(p.brand, 'product.brand'),
      name: optString(p.name, 'product.name'),
      condition: optString(p.condition, 'product.condition'),
      notes: optString(p.notes, 'product.notes'),
      sku: optString(p.sku, 'product.sku'),
      attributes: isPlain(p.attributes) ? p.attributes : undefined,
      taxScheme,
      storageLocation: optString(p.storageLocation, 'product.storageLocation'),
      scopeOfDelivery: Array.isArray(p.scopeOfDelivery) ? (p.scopeOfDelivery as string[]) : undefined,
    },
    // Dieselbe Pflicht wie am Bildschirm: ohne vereinbarten Preis gibt es keine Kommission.
    agreedPrice: money(raw.agreedPrice, 'agreedPrice', { min: 0.001 }),
    minimumPrice: raw.minimumPrice === undefined || raw.minimumPrice === null
      ? undefined : money(raw.minimumPrice, 'minimumPrice'),
    payout: { model, commissionRate: raw.payout.commissionRate, excessSplitPct: raw.payout.excessSplitPct },
    expiryDate: optString(raw.expiryDate, 'expiryDate'),
    notes: optString(raw.notes, 'notes'),
    staffId: optString(raw.staffId, 'staffId'),
    stagingIds: parseStagingIds(raw.stagingIds, (m) => new CommercialPayloadError(m)),
    acknowledgeDuplicate: raw.acknowledgeDuplicate === true,
  };
}

/** Nur für Tests: wie der Primary an die abgelegten Bytes kommt und wie er aufräumt. */
export interface ConsignmentEngineExtras {
  readStaged?: StagedMediaReader;
  discardStaged?: StagedMediaDiscard;
}

export async function runConsignmentCreate(
  deps: EngineDeps, identity: CommandIdentity, raw: unknown, extras: ConsignmentEngineExtras = {},
): Promise<CommandOutcome> {
  const req = parseConsignmentCreate(raw);
  const owner = stagingOwnerOf(identity);
  const outcome = await runRemoteCommand(deps, identity, async () => {
    // R5B — in die Bücher DIESER Filiale, oder gar nicht.
    assertHouseBranch(identity);
    // Die Bytes INNERHALB des Auftrags — eine Wiederholung derselben Kennung liest sie nie wieder.
    const images = await readStagedAsDataUrls(
      req.stagingIds, owner, extras.readStaged ?? invokeReadStaged, (m) => new CommercialPayloadError(m),
    );
    const port = houseConsignmentPort(identity.branchId);
    if (!port.consignorExists(req.consignorId)) {
      throw new CommandRejected('CONSIGNOR_NOT_FOUND', 'no such client in this branch');
    }

    // Die Duplikatserkennung des Hauses, mit derselben Bedeutung wie am Bildschirm: sie BLOCKIERT
    // nicht, sie FRAGT. Am Primary heißt die Antwort „Create anyway"; hier heißt sie
    // `acknowledgeDuplicate`. Verglichen wird gegen den FRISCH geladenen Bestand (der Port lädt).
    if (!req.acknowledgeDuplicate) {
      const hits = useProductStore.getState().findPossibleDuplicates({
        brand: req.product.brand, name: req.product.name, categoryId: req.product.categoryId,
        sku: req.product.sku, attributes: req.product.attributes,
      } as never);
      if (hits.length > 0) {
        throw new CommandRejected(
          'POSSIBLE_DUPLICATE',
          `this looks like an item we already have: ${hits.slice(0, 3)
            .map((h) => `${h.product.brand} ${h.product.name} (${h.product.sku || h.product.id})`).join(', ')}`,
        );
      }
    }

    const input: ConsignmentCreateInput = {
      consignorId: req.consignorId,
      product: { ...req.product } as never,
      agreedPrice: req.agreedPrice,
      minimumPrice: req.minimumPrice,
      payout: req.payout,
      expiryDate: req.expiryDate,
      notes: req.notes,
      staffId: req.staffId,
    };
    let made;
    try {
      // DERSELBE Vorgang wie an der Maske des Primary — die Klammer hält hier der Auftrag.
      made = await createConsignmentWithProduct(input, { kind: 'data_urls', images }, port);
    } catch (e) {
      if (e instanceof ConsignmentCreateRejected) throw new CommandRejected(e.code, e.message);
      // Ein unvollständiger Bilderweg ist kein Urteil: nichts bleibt, dieselbe Kennung darf es
      // erneut versuchen.
      if (e instanceof ConsignmentMediaIncomplete) throw new CommandNotEvaluated(e.code, e.message);
      throw e;
    }
    const created = made.consignment;

    const value: CommercialResult = {
      consignmentId: created.id,
      consignmentNumber: created.consignmentNumber,
      productId: made.productId,
      sku: made.sku,
      payoutModel: created.commissionType,
      commissionRate: created.commissionRate,
      excessSplitPct: created.excessSplitPct ?? null,
      agreedPrice: created.agreedPrice,
      status: created.status,
      imageCount: images.length,
      revision: Number(query('SELECT revision FROM consignments WHERE id = ?', [created.id])[0]?.revision ?? 1),
    };
    return value as unknown as Record<string, unknown>;
  });
  if (outcome.kind === 'ok') {
    await discardStagedAfterSuccess(req.stagingIds, owner, extras.discardStaged ?? invokeDiscardStaged);
  }
  return outcome;
}

// ── Kommission: ändern ────────────────────────────────────────────────────

export interface ConsignmentUpdateRequest {
  id: string;
  expectedRevision: number;
  agreedPrice?: number;
  minimumPrice?: number | null;
  expiryDate?: string | null;
  notes?: string | null;
  payout?: { model: string; commissionRate?: unknown; excessSplitPct?: unknown };
}

/**
 * Genau die Felder, die der „Save"-Knopf am Primary schreibt — und keins mehr.
 *
 * `updateConsignment` ist im Haus ein GENERISCHER Feldsetzer: über seine Abbildung ließen sich
 * auch Verkaufspreis, Provisionsbetrag, Auszahlungsstand, Rechnungsverknüpfung und Status setzen.
 * Nichts davon ist eine Eingabe; alles davon entsteht aus einem Vorgang (`recordSale`,
 * `markPaidOut`). Diese Liste ist deshalb der eigentliche Riegel — nicht die Domänenfunktion.
 */
export function parseConsignmentUpdate(raw: unknown): ConsignmentUpdateRequest {
  if (!isPlain(raw)) throw new CommercialPayloadError('payload must be an object');
  onlyKnownFields(raw, ['id', 'expectedRevision', 'agreedPrice', 'minimumPrice', 'expiryDate', 'notes', 'payout']);
  const out: ConsignmentUpdateRequest = {
    id: reqString(raw.id, 'id'),
    expectedRevision: expectedRevisionOf(raw.expectedRevision),
  };
  if (raw.agreedPrice !== undefined) out.agreedPrice = money(raw.agreedPrice, 'agreedPrice', { min: 0.001 });
  if (raw.minimumPrice !== undefined) {
    out.minimumPrice = raw.minimumPrice === null ? null : money(raw.minimumPrice, 'minimumPrice');
  }
  if (raw.expiryDate !== undefined) out.expiryDate = raw.expiryDate === null ? null : reqString(raw.expiryDate, 'expiryDate');
  if (raw.notes !== undefined) out.notes = raw.notes === null ? null : String(raw.notes);
  if (raw.payout !== undefined && raw.payout !== null) {
    if (!isPlain(raw.payout)) throw new CommercialPayloadError('payout must be an object');
    onlyKnownFields(raw.payout, ['model', 'commissionRate', 'excessSplitPct']);
    const model = String(raw.payout.model ?? '');
    if (!(PAYOUT_MODELS as readonly string[]).includes(model)) {
      throw new CommercialPayloadError(`unknown payout model: ${model || '(none)'}`);
    }
    out.payout = { model, commissionRate: raw.payout.commissionRate, excessSplitPct: raw.payout.excessSplitPct };
  }
  if (out.agreedPrice === undefined && out.minimumPrice === undefined
    && out.expiryDate === undefined && out.notes === undefined && out.payout === undefined) {
    throw new CommercialPayloadError('an edit must change something');
  }
  return out;
}

function consignmentState(id: string): CommercialResult {
  const r = query(
    'SELECT id, consignment_number, agreed_price, minimum_price, commission_type, commission_rate, '
    + 'excess_split_pct, expiry_date, status, revision, updated_at FROM consignments WHERE id = ?', [id],
  )[0];
  return {
    consignmentId: id,
    consignmentNumber: String(r?.consignment_number ?? ''),
    agreedPrice: Number(r?.agreed_price ?? 0),
    minimumPrice: r?.minimum_price === null || r?.minimum_price === undefined ? null : Number(r.minimum_price),
    payoutModel: String(r?.commission_type ?? ''),
    commissionRate: Number(r?.commission_rate ?? 0),
    excessSplitPct: r?.excess_split_pct === null || r?.excess_split_pct === undefined ? null : Number(r.excess_split_pct),
    expiryDate: String(r?.expiry_date ?? ''),
    status: String(r?.status ?? ''),
    revision: Number(r?.revision ?? 0),
    updatedAt: String(r?.updated_at ?? ''),
  };
}

export function runConsignmentUpdate(
  deps: EngineDeps, identity: CommandIdentity, raw: unknown,
): Promise<CommandOutcome> {
  const req = parseConsignmentUpdate(raw);
  return runRemoteCommand(deps, identity, () => {
    const row = query('SELECT * FROM consignments WHERE id = ? AND branch_id = ?',
      [req.id, identity.branchId])[0];
    if (!row) throw new CommandRejected('CONSIGNMENT_NOT_FOUND', 'no such consignment in this branch');
    assertRevision('consignments', req.id, req.expectedRevision, 'CONSIGNMENT_NOT_FOUND');

    const store = useConsignmentStore.getState();
    // Die Reihenfolge des Bildschirms, aus demselben Grund: das Modell zuerst, weil es scheitern
    // DARF. Der Unterschied ist die Klammer — scheitert es hier, geht die ganze Transaktion
    // zurück, und es bleibt nicht die halbe Eingabe stehen.
    if (req.payout) {
      // Die Sperre wird zweimal gefragt: hier gegen die frische Zeile (für eine ehrliche
      // Begründung) und noch einmal IM Update der Domänenfunktion (als WHERE-Bedingung, gegen den
      // Zustand, auf den wirklich geschrieben wird). Beide Male dieselbe SSOT.
      const lock = payoutModelLock(rowToConsignment(row));
      if (lock.locked) {
        throw new CommandRejected('PAYOUT_MODEL_LOCKED', lock.reason ?? 'the payout model can no longer be changed');
      }
      try {
        store.updateConsignmentPayoutModel(req.id, req.payout);
      } catch (e) {
        if (e instanceof PayoutPatchError) throw new CommandRejected('PAYOUT_MODEL_LOCKED', e.message);
        throw e;
      }
    }

    const patch: Record<string, unknown> = {};
    if (req.agreedPrice !== undefined) patch.agreedPrice = req.agreedPrice;
    if (req.minimumPrice !== undefined) patch.minimumPrice = req.minimumPrice ?? undefined;
    if (req.expiryDate !== undefined) patch.expiryDate = req.expiryDate ?? undefined;
    if (req.notes !== undefined) patch.notes = req.notes ?? undefined;
    if (Object.keys(patch).length > 0) store.updateConsignment(req.id, patch);

    return consignmentState(req.id) as unknown as Record<string, unknown>;
  });
}

// ── Auftrag: anlegen ──────────────────────────────────────────────────────

const ORDER_MATERIAL_FIELDS = ['materialKind', 'description', 'quantity', 'caratPerPiece', 'weightGrams', 'karat', 'totalCost', 'customerPrice', 'supplierId'];

export interface OrderCreateRequest extends OrderCreateInput {
  /** Je Zeile der Entwurf eines neuen Artikels mit den Kennungen seiner Fotos. */
  specs: Array<{ spec: Partial<Product>; stagingIds?: string[] } | undefined>;
  /** Die Spec des fertigen Stücks eines Sonderauftrags, ebenso. */
  finalSpec?: { spec: Partial<Product>; stagingIds?: string[] };
}

/**
 * Was ein Mensch an „New Order" eingibt — R5E: JEDE Auftragsart. Normal (bestehende und NEUE
 * Artikel), Sonderanfertigung (Angebotspreis mit Steuerwahl, Final-Product-Spec mit Foto,
 * Kundenmaterial, Goldschmied, Extra-Gold samt Goldschmied, Diamanten/Steine), gemischt; Anzahlung
 * oder voll bezahlt, Zahlweg und Kartenart, Liefertermin, Anfangsstatus, Notiz.
 *
 * NICHT dabei: Summe, Steuer, Rest, Marge, Typ, Kopffelder, die Zeilen selbst, die Gold-
 * Verbindlichkeit — all das leitet das Haus aus den Eingaben ab (`planOrderCreate`).
 */
export function parseOrderCreate(raw: unknown): OrderCreateRequest {
  if (!isPlain(raw)) throw new CommercialPayloadError('payload must be an object');
  onlyKnownFields(raw, [
    'customerId', 'orderType', 'lines', 'quotedPrice', 'customTaxScheme', 'finalProductDescription',
    'customProductSpec', 'customerGoldGrams', 'customerGoldKarat', 'customerStones', 'goldsmithSupplierId',
    'laborCost', 'extraGoldGrams', 'extraGoldKarat', 'extraGoldCost', 'extraGoldSupplierId', 'materials',
    'depositAmount', 'paymentMethod', 'cardBrand', 'fullyPaid', 'expectedDelivery', 'status', 'notes',
  ]);
  if (!Array.isArray(raw.lines)) throw new CommercialPayloadError('lines must be a list');
  if (raw.lines.length > MAX_DOC_LINES) throw new CommercialPayloadError('too many lines');
  const specs: OrderCreateRequest['specs'] = [];
  const lines = raw.lines.map((l, i) => {
    if (!isPlain(l)) throw new CommercialPayloadError(`line ${i + 1} must be an object`);
    onlyKnownFields(l, ['mode', 'productId', 'newProduct', 'description', 'scheme', 'quantity', 'unitPrice']);
    const productId = optString(l.productId, `line ${i + 1}: productId`);
    const spec = parseSpec(l.newProduct, EMBEDDED_PRODUCT_FIELDS, `line ${i + 1}: newProduct`);
    specs.push(spec);
    return {
      mode: oneOf(l.mode, ['existing', 'new'] as const, spec ? 'new' : 'existing', `line ${i + 1} mode`),
      productId,
      newProduct: spec?.spec,
      description: text0(l.description, `line ${i + 1}: description`),
      scheme: oneOf(l.scheme, ORDER_LINE_SCHEMES, 'auto', `line ${i + 1} tax scheme`),
      quantity: countOf(l.quantity, `line ${i + 1}: quantity`),
      unitPrice: money(l.unitPrice, `line ${i + 1}: unitPrice`),
    };
  });
  const rawMaterials = raw.materials === undefined || raw.materials === null ? [] : raw.materials;
  if (!Array.isArray(rawMaterials)) throw new CommercialPayloadError('materials must be a list');
  if (rawMaterials.length > MAX_DOC_LINES) throw new CommercialPayloadError('too many materials');
  const materials = rawMaterials.map((m, i) => {
    if (!isPlain(m)) throw new CommercialPayloadError(`material ${i + 1} must be an object`);
    onlyKnownFields(m, ORDER_MATERIAL_FIELDS);
    const opt = (v: unknown, n: string): number | undefined => (v === undefined || v === null ? undefined : money(v, n));
    return {
      materialKind: oneOf(m.materialKind, ORDER_MATERIAL_KINDS, 'gold', `material ${i + 1} kind`),
      description: text0(m.description, `material ${i + 1}: description`),
      quantity: countOf(m.quantity, `material ${i + 1}: quantity`),
      caratPerPiece: opt(m.caratPerPiece, `material ${i + 1}: caratPerPiece`),
      weightGrams: opt(m.weightGrams, `material ${i + 1}: weightGrams`),
      karat: m.karat === undefined || m.karat === null ? undefined : text0(m.karat, `material ${i + 1}: karat`),
      totalCost: money(m.totalCost, `material ${i + 1}: totalCost`),
      customerPrice: opt(m.customerPrice, `material ${i + 1}: customerPrice`),
      supplierId: optString(m.supplierId, `material ${i + 1}: supplierId`),
    };
  });
  if (raw.fullyPaid !== undefined && typeof raw.fullyPaid !== 'boolean') {
    throw new CommercialPayloadError('fullyPaid is yes or no');
  }
  // Das alte Formular schickte ohne Anzahlung auch keine Zahlungsart — mit Anzahlung braucht es eine.
  if (num0(raw.depositAmount, 'depositAmount') > 0 && raw.paymentMethod === undefined) {
    throw new CommercialPayloadError('a deposit needs a payment method');
  }
  const finalSpec = parseSpec(raw.customProductSpec, FINAL_PRODUCT_FIELDS, 'customProductSpec');
  const req: OrderCreateRequest = {
    customerId: reqString(raw.customerId, 'customerId'),
    orderType: oneOf(raw.orderType, ORDER_TYPES, 'normal', 'order type'),
    lines,
    quotedPrice: num0(raw.quotedPrice, 'quotedPrice'),
    customTaxScheme: oneOf(raw.customTaxScheme, ORDER_QUOTE_SCHEMES, 'MARGIN', 'tax scheme'),
    finalProductDescription: text0(raw.finalProductDescription, 'finalProductDescription'),
    customProductSpec: finalSpec?.spec,
    customerGoldGrams: num0(raw.customerGoldGrams, 'customerGoldGrams'),
    customerGoldKarat: oneOf(raw.customerGoldKarat, GOLD_KARATS, '22K', 'karat'),
    customerStones: text0(raw.customerStones, 'customerStones'),
    goldsmithSupplierId: text0(raw.goldsmithSupplierId, 'goldsmithSupplierId'),
    laborCost: num0(raw.laborCost, 'laborCost'),
    extraGoldGrams: num0(raw.extraGoldGrams, 'extraGoldGrams'),
    extraGoldKarat: oneOf(raw.extraGoldKarat, GOLD_KARATS, '22K', 'karat'),
    extraGoldCost: num0(raw.extraGoldCost, 'extraGoldCost'),
    extraGoldSupplierId: text0(raw.extraGoldSupplierId, 'extraGoldSupplierId'),
    materials,
    depositAmount: num0(raw.depositAmount, 'depositAmount'),
    paymentMethod: oneOf(raw.paymentMethod, ORDER_PAYMENT_METHODS, 'cash', 'payment method'),
    cardBrand: oneOf(raw.cardBrand, ['normal', 'amex'] as const, 'normal', 'card brand'),
    fullyPaid: raw.fullyPaid === true,
    expectedDelivery: text0(raw.expectedDelivery, 'expectedDelivery'),
    status: oneOf(raw.status, ORDER_CREATE_STATUSES as readonly OrderStatus[], 'pending', 'initial status'),
    notes: text0(raw.notes, 'notes'),
    specs,
    finalSpec,
  };
  try {
    assertOrderCreateValues(req);
  } catch (e) {
    if (e instanceof OrderActionRejected) throw new CommercialPayloadError(e.message);
    throw e;
  }
  return req;
}

function orderState(id: string): CommercialResult {
  const r = query(
    'SELECT id, order_number, customer_id, status, type, agreed_price, tax_amount, deposit_amount, remaining_amount, '
    + 'supplier_name, supplier_price, expected_margin, expected_delivery, revision, updated_at '
    + 'FROM orders WHERE id = ?', [id],
  )[0];
  const paid = query('SELECT COALESCE(SUM(amount), 0) AS s FROM order_payments WHERE order_id = ?', [id])[0];
  return {
    orderId: id,
    orderNumber: String(r?.order_number ?? ''),
    customerId: String(r?.customer_id ?? ''),
    status: String(r?.status ?? ''),
    type: String(r?.type ?? ''),
    agreedPrice: r?.agreed_price === null || r?.agreed_price === undefined ? null : Number(r.agreed_price),
    taxAmount: Number(r?.tax_amount ?? 0),
    depositAmount: Number(r?.deposit_amount ?? 0),
    remainingAmount: Number(r?.remaining_amount ?? 0),
    supplierName: String(r?.supplier_name ?? ''),
    supplierPrice: r?.supplier_price === null || r?.supplier_price === undefined ? null : Number(r.supplier_price),
    expectedMargin: r?.expected_margin === null || r?.expected_margin === undefined ? null : Number(r.expected_margin),
    expectedDelivery: String(r?.expected_delivery ?? ''),
    paidAmount: Number(paid?.s ?? 0),
    revision: Number(r?.revision ?? 0),
    updatedAt: String(r?.updated_at ?? ''),
  };
}

export async function runOrderCreate(
  deps: EngineDeps, identity: CommandIdentity, raw: unknown, extras: StagingExtras = {},
): Promise<CommandOutcome> {
  const req = parseOrderCreate(raw);
  const owner = stagingOwnerOf(identity);
  const read = extras.readStaged ?? invokeReadStaged;
  const staged = [...req.specs.flatMap((s) => s?.stagingIds ?? []), ...(req.finalSpec?.stagingIds ?? [])];
  const outcome = await runRemoteCommand(deps, identity, async () => {
    // R5E — in die Bücher DIESER Filiale, oder gar nicht.
    assertHouseBranch(identity);
    const lines: Array<(typeof req.lines)[number]> = [];
    for (let i = 0; i < req.lines.length; i++) {
      lines.push({ ...req.lines[i], newProduct: await mitFotos(req.specs[i], owner, read) });
    }
    const input: OrderCreateInput = { ...req, lines, customProductSpec: await mitFotos(req.finalSpec, owner, read) };
    // Dieselbe Folge wie „Save Order" am Primary (`createOrderOnPrimary`): die Vorbereitung leitet
    // Zeilen, Summe, Steuer, Kopf und Kundenmaterial ab, die Hausfunktion legt Auftrag, neue
    // Artikel, Anzahlung, Buchung und Kartengebühr an — und die Gold-Verbindlichkeit beim
    // Goldschmied entsteht in DERSELBEN Transaktion.
    const made = urteil(() => createOrderInHouse(input, identity.branchId));
    return { ...orderState(made.order.id), goldPayableId: made.goldPayableId ?? null } as unknown as Record<string, unknown>;
  });
  if (outcome.kind === 'ok') await discardStagedAfterSuccess(staged, owner, extras.discardStaged ?? invokeDiscardStaged);
  return outcome;
}

// ── Auftrag: ändern ───────────────────────────────────────────────────────

export interface OrderUpdateRequest extends Partial<OrderEditInput> {
  id: string;
  expectedRevision: number;
}

/**
 * Genau die sechs Eingaben des „Save"-Knopfs auf der Auftragsseite — ohne die beiden, die dort
 * AUSGERECHNET werden: `expectedMargin` und `remainingAmount`. Die leitet der Primary aus dem Stand
 * ab, der nach dieser Änderung wirklich gilt (`planOrderEdit`). Ein geleertes Feld ist `null`.
 * R5E: auch der Sonderauftrag — sein Preis steht in der Angebotszeile, und genau die zieht das Haus.
 */
export function parseOrderUpdate(raw: unknown): OrderUpdateRequest {
  if (!isPlain(raw)) throw new CommercialPayloadError('payload must be an object');
  onlyKnownFields(raw, ['id', 'expectedRevision', ...ORDER_EDIT_FIELDS]);
  const out: OrderUpdateRequest = {
    id: reqString(raw.id, 'id'),
    expectedRevision: expectedRevisionOf(raw.expectedRevision),
  };
  for (const k of ['agreedPrice', 'depositAmount', 'supplierPrice'] as const) {
    if (raw[k] !== undefined) out[k] = raw[k] === null ? null : money(raw[k], k);
  }
  for (const k of ['supplierName', 'expectedDelivery', 'notes'] as const) {
    if (raw[k] !== undefined) out[k] = raw[k] === null ? null : text0(raw[k], k);
  }
  if (!ORDER_EDIT_FIELDS.some((k) => out[k] !== undefined)) {
    throw new CommercialPayloadError('an edit must change something');
  }
  return out;
}

export function runOrderUpdate(
  deps: EngineDeps, identity: CommandIdentity, raw: unknown,
): Promise<CommandOutcome> {
  const req = parseOrderUpdate(raw);
  return runRemoteCommand(deps, identity, () => {
    assertHouseBranch(identity);
    const live = query(
      'SELECT agreed_price, deposit_amount, supplier_name, supplier_price, expected_delivery, notes '
      + 'FROM orders WHERE id = ? AND branch_id = ?', [req.id, identity.branchId],
    )[0];
    if (!live) throw new CommandRejected('ORDER_NOT_FOUND', 'no such order in this branch');
    assertRevision('orders', req.id, req.expectedRevision, 'ORDER_NOT_FOUND');
    // Der Stand, der NACH dieser Änderung gilt — Feld für Feld: was der Auftrag mitbringt, sonst das,
    // was in der Zeile steht. Nur so stimmen Marge und Rest auch bei einer Teiländerung.
    const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
    const t = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
    const effective: OrderEditInput = {
      agreedPrice: req.agreedPrice !== undefined ? req.agreedPrice : n(live.agreed_price),
      depositAmount: req.depositAmount !== undefined ? req.depositAmount : n(live.deposit_amount),
      supplierName: req.supplierName !== undefined ? req.supplierName : t(live.supplier_name),
      supplierPrice: req.supplierPrice !== undefined ? req.supplierPrice : n(live.supplier_price),
      expectedDelivery: req.expectedDelivery !== undefined ? req.expectedDelivery : t(live.expected_delivery),
      notes: req.notes !== undefined ? req.notes : t(live.notes),
    };
    // Dieselbe Folge wie „Save" am Primary (`updateOrderOnPrimary`).
    urteil(() => updateOrderInHouse(req.id, effective, identity.branchId));
    return orderState(req.id) as unknown as Record<string, unknown>;
  });
}

// ── Die Anmeldung ─────────────────────────────────────────────────────────

async function execute(
  run: (deps: EngineDeps, identity: CommandIdentity, raw: unknown) => Promise<CommandOutcome>,
  op: string,
  payload: unknown,
  actor?: CommandActor,
): Promise<CommercialResult & { replayed: boolean }> {
  if (!actor) throw new Error(`${op} needs an authenticated identity`);
  const body = (payload as { input?: unknown } | null)?.input ?? payload;
  let outcome: CommandOutcome;
  try {
    outcome = await run(commercialDeps(), { ...actor, op }, body);
  } catch (err) {
    // Ein unbrauchbarer Rumpf ist eine Antwort, keine Störung — und er wird NICHT eingefroren:
    // niemand hat etwas bewertet.
    if (err instanceof CommercialPayloadError) throw new BusinessError(err.code, err.message);
    throw err;
  }
  if (outcome.kind === 'rejected') {
    // Nur ein EINGEFRORENES Urteil ist ein fachliches Nein. Ein nicht eingefrorenes bedeutet: nie
    // bewertet — es als „abgelehnt" zu melden beendete den Versuch, obwohl nichts geschehen ist.
    if (!outcome.frozen) throw new CommandNotEvaluated(outcome.code, outcome.message);
    throw new BusinessError(outcome.code, outcome.message);
  }
  return { ...(outcome.value as CommercialResult), replayed: outcome.replayed };
}

registerCommand(OP_PURCHASES_CREATE, {
  kind: 'mutation',
  handler: (payload, actor?: CommandActor) => execute(runPurchaseCreate, OP_PURCHASES_CREATE, payload, actor),
});

registerCommand(OP_CONSIGNMENTS_CREATE, {
  kind: 'mutation',
  handler: (payload, actor?: CommandActor) => execute(runConsignmentCreate, OP_CONSIGNMENTS_CREATE, payload, actor),
});

registerCommand(OP_CONSIGNMENTS_UPDATE, {
  kind: 'mutation',
  handler: (payload, actor?: CommandActor) => execute(runConsignmentUpdate, OP_CONSIGNMENTS_UPDATE, payload, actor),
});

registerCommand(OP_ORDERS_CREATE, {
  kind: 'mutation',
  handler: (payload, actor?: CommandActor) => execute(runOrderCreate, OP_ORDERS_CREATE, payload, actor),
});

registerCommand(OP_ORDERS_UPDATE, {
  kind: 'mutation',
  handler: (payload, actor?: CommandActor) => execute(runOrderUpdate, OP_ORDERS_UPDATE, payload, actor),
});
