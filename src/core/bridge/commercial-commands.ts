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
//  • **Auftrag: Anlegen und Ändern, aber nur der NORMALE.** Ein Sonderauftrag (`custom`/`mixed`)
//    trägt seinen Preis in einer Angebotszeile, und der Kopfpreis wird beim Ändern bewusst NICHT
//    geschrieben (`quoteLine`-Zweig am Primary). Diesen Doppelvertrag aus der Ferne zu bedienen
//    wäre geraten. Ein Auftrag mit Gold, Goldschmied oder Sonderanfertigung wird deshalb hier
//    abgelehnt statt halb unterstützt.
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
import { usePurchaseStore } from '@/stores/purchaseStore';
import { useConsignmentStore } from '@/stores/consignmentStore';
import { useOrderStore } from '@/stores/orderStore';
import { useProductStore } from '@/stores/productStore';
import { payoutModelLock, PayoutPatchError } from '@/core/consignment/payout-edit';
import { rowToConsignment } from '@/stores/consignmentStore';
import { CommandRejected, runRemoteCommand, type CommandOutcome, type EngineDeps } from './mutation-engine';
import type { CommandIdentity } from './command-ledger';
import { BusinessError, registerCommand, type CommandActor } from './command-registry';
import { CommandNotEvaluated } from './mutation-engine';
import {
  invokeReadStaged, invokeDiscardStaged, assertHouseBranch, parseStagingIds, readStagedAsDataUrls,
  discardStagedAfterSuccess, stagingOwnerOf, type StagedMediaReader, type StagedMediaDiscard,
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

const PURCHASE_METHODS = ['cash', 'bank', 'benefit'] as const;
const TAX_SCHEMES = ['ZERO', 'VAT_10'] as const;

export interface PurchaseCreateRequest {
  supplierId: string;
  purchaseDate?: string;
  notes?: string;
  taxScheme: typeof TAX_SCHEMES[number];
  lines: Array<{ productId: string; quantity: number; unitPrice: number; description?: string }>;
  initialPayment?: { amount: number; method: typeof PURCHASE_METHODS[number] };
}

/**
 * Was ein Mensch am Einkaufsbildschirm eingibt — und nichts sonst.
 *
 * Bewusst NICHT dabei: neue Produkte. Der Bildschirm am Primary kann in einer Zeile ein Produkt
 * mit anlegen; aus der Ferne wäre das ein ZWEITER Weg, auf dem ein Artikel entsteht — neben
 * `products.create`, das eigene Beweise mitbringt (SKU aus dem durablen Zähler, Medienweg,
 * eingefrorenes Urteil). Ein Client legt erst den Artikel an und kauft ihn dann ein.
 *
 * Ebenfalls nicht dabei: `sourceOrderId`. Die Verknüpfung mit einem Auftrag (Back-to-Back) rollt
 * Auftragszeilen auf „angekommen" — ein eigener Vorgang mit eigener Bedeutung, nicht ein Feld.
 */
export function parsePurchaseCreate(raw: unknown): PurchaseCreateRequest {
  if (!isPlain(raw)) throw new CommercialPayloadError('payload must be an object');
  onlyKnownFields(raw, ['supplierId', 'purchaseDate', 'notes', 'taxScheme', 'lines', 'initialPayment']);
  const supplierId = reqString(raw.supplierId, 'supplierId');
  const scheme = raw.taxScheme === undefined ? 'ZERO' : String(raw.taxScheme);
  if (!(TAX_SCHEMES as readonly string[]).includes(scheme)) {
    throw new CommercialPayloadError(`unknown tax scheme: ${scheme}`);
  }
  if (!Array.isArray(raw.lines) || raw.lines.length === 0) {
    throw new CommercialPayloadError('a purchase needs at least one line');
  }
  if (raw.lines.length > MAX_DOC_LINES) throw new CommercialPayloadError('too many lines');
  const lines = raw.lines.map((l, i) => {
    if (!isPlain(l)) throw new CommercialPayloadError(`line ${i + 1} must be an object`);
    onlyKnownFields(l, ['productId', 'quantity', 'unitPrice', 'description']);
    return {
      productId: reqString(l.productId, `line ${i + 1}: productId`),
      quantity: countOf(l.quantity, `line ${i + 1}: quantity`),
      // Ein Einkaufspreis von 0 ist eine gültige Aussage (Geschenk, Beigabe) — negativ nicht.
      unitPrice: money(l.unitPrice, `line ${i + 1}: unitPrice`),
      description: optString(l.description, `line ${i + 1}: description`),
    };
  });
  let initialPayment: PurchaseCreateRequest['initialPayment'];
  if (raw.initialPayment !== undefined && raw.initialPayment !== null) {
    if (!isPlain(raw.initialPayment)) throw new CommercialPayloadError('initialPayment must be an object');
    onlyKnownFields(raw.initialPayment, ['amount', 'method']);
    const method = String(raw.initialPayment.method ?? '');
    if (!(PURCHASE_METHODS as readonly string[]).includes(method)) {
      throw new CommercialPayloadError(`unknown payment method: ${method || '(none)'}`);
    }
    initialPayment = {
      amount: money(raw.initialPayment.amount, 'initialPayment.amount', { min: 0.001 }),
      method: method as typeof PURCHASE_METHODS[number],
    };
  }
  return {
    supplierId,
    purchaseDate: optString(raw.purchaseDate, 'purchaseDate'),
    notes: optString(raw.notes, 'notes'),
    taxScheme: scheme as typeof TAX_SCHEMES[number],
    lines,
    initialPayment,
  };
}

export type CommercialResult = { readonly [k: string]: unknown };

export function runPurchaseCreate(
  deps: EngineDeps, identity: CommandIdentity, raw: unknown,
): Promise<CommandOutcome> {
  const req = parsePurchaseCreate(raw);
  return runRemoteCommand(deps, identity, () => {
    const branch = identity.branchId;
    // Der Lieferant muss existieren UND zu dieser Filiale gehören. Ohne diese Prüfung entstünde
    // ein Beleg mit einer Verbindlichkeit gegenüber niemandem.
    const sup = query('SELECT id FROM suppliers WHERE id = ? AND branch_id = ?', [req.supplierId, branch])[0];
    if (!sup) throw new CommandRejected('SUPPLIER_NOT_FOUND', 'no such supplier in this branch');
    for (const l of req.lines) {
      const p = query('SELECT id FROM products WHERE id = ? AND branch_id = ?', [l.productId, branch])[0];
      if (!p) throw new CommandRejected('PRODUCT_NOT_FOUND', `no such product in this branch: ${l.productId}`);
    }
    // Dieselbe Regel wie am Bildschirm: eine Anzahlung, die über der Summe liegt, wird nicht
    // angenommen. `createPurchase` selbst prüft das nicht — es rechnete stillschweigend einen
    // negativen Rest, und daraus würde später eine Überzahlung, die niemand eingegeben hat.
    const total = req.lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
    if (req.initialPayment && req.initialPayment.amount > total + 1e-9) {
      throw new CommandRejected('PAYMENT_EXCEEDS_TOTAL',
        `the payment (${req.initialPayment.amount}) is more than the purchase (${total})`);
    }
    // Ab hier rechnet das Haus: Belegnummer aus dem durablen Zähler, ein Los je Zeile mit dem
    // TATSÄCHLICHEN Einstandspreis, Mengensynchronisierung, Statusregel für bestehende Artikel,
    // Vorsteuer aus dem Bruttobetrag, Verbindlichkeit und Buchung.
    const vatRate = req.taxScheme === 'VAT_10' ? 10 : 0;
    const purchase = usePurchaseStore.getState().createPurchase({
      supplierId: req.supplierId,
      purchaseDate: req.purchaseDate,
      notes: req.notes,
      lines: req.lines.map((l) => ({
        productId: l.productId,
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        taxScheme: req.taxScheme,
        vatRate,
      })),
      initialPayment: req.initialPayment,
    });
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

const ORDER_METHODS = ['cash', 'bank', 'card', 'benefit'] as const;
const ORDER_CARD_BRANDS = ['normal', 'amex'] as const;

export interface OrderCreateRequest {
  customerId: string;
  lines: Array<{ productId: string; quantity: number; unitPrice: number; description?: string }>;
  depositAmount?: number;
  paymentMethod?: typeof ORDER_METHODS[number];
  cardBrand?: typeof ORDER_CARD_BRANDS[number];
  expectedDelivery?: string;
  supplierName?: string;
  supplierPrice?: number;
  notes?: string;
}

/**
 * Ein NORMALER Auftrag: ein Kunde, Positionen auf bestehende Artikel, optional eine Anzahlung.
 *
 * Nicht dabei und mit Absicht: `agreedPrice` (die Summe rechnet der Primary aus den Positionen),
 * `taxAmount`, `status`, `remainingAmount`, `expectedMargin`, `fullyPaid`, `type`, `customMeta`,
 * `customProductSpec`, `goldsmithSupplierId`, `laborCost`, `extraGoldValue`. Die letzten fünf
 * gehören zum Sonderauftrag; `type` leitet das Haus ohnehin aus den Zeilen ab, und ein Feld, das
 * überschrieben wird, ist ein Versprechen, das nicht gilt.
 */
export function parseOrderCreate(raw: unknown): OrderCreateRequest {
  if (!isPlain(raw)) throw new CommercialPayloadError('payload must be an object');
  onlyKnownFields(raw, [
    'customerId', 'lines', 'depositAmount', 'paymentMethod', 'cardBrand',
    'expectedDelivery', 'supplierName', 'supplierPrice', 'notes',
  ]);
  if (!Array.isArray(raw.lines) || raw.lines.length === 0) {
    throw new CommercialPayloadError('an order needs at least one line');
  }
  if (raw.lines.length > MAX_DOC_LINES) throw new CommercialPayloadError('too many lines');
  const lines = raw.lines.map((l, i) => {
    if (!isPlain(l)) throw new CommercialPayloadError(`line ${i + 1} must be an object`);
    onlyKnownFields(l, ['productId', 'quantity', 'unitPrice', 'description']);
    return {
      productId: reqString(l.productId, `line ${i + 1}: productId`),
      quantity: countOf(l.quantity, `line ${i + 1}: quantity`),
      unitPrice: money(l.unitPrice, `line ${i + 1}: unitPrice`),
      description: optString(l.description, `line ${i + 1}: description`),
    };
  });
  const out: OrderCreateRequest = {
    customerId: reqString(raw.customerId, 'customerId'),
    lines,
    expectedDelivery: optString(raw.expectedDelivery, 'expectedDelivery'),
    supplierName: optString(raw.supplierName, 'supplierName'),
    notes: optString(raw.notes, 'notes'),
  };
  if (raw.supplierPrice !== undefined && raw.supplierPrice !== null) {
    out.supplierPrice = money(raw.supplierPrice, 'supplierPrice');
  }
  if (raw.depositAmount !== undefined && raw.depositAmount !== null) {
    out.depositAmount = money(raw.depositAmount, 'depositAmount');
  }
  if (raw.paymentMethod !== undefined) {
    const m = String(raw.paymentMethod);
    if (!(ORDER_METHODS as readonly string[]).includes(m)) {
      throw new CommercialPayloadError(`unknown payment method: ${m || '(none)'}`);
    }
    out.paymentMethod = m as typeof ORDER_METHODS[number];
  }
  if (raw.cardBrand !== undefined) {
    const b = String(raw.cardBrand);
    if (!(ORDER_CARD_BRANDS as readonly string[]).includes(b)) {
      throw new CommercialPayloadError('unknown card brand');
    }
    out.cardBrand = b as typeof ORDER_CARD_BRANDS[number];
  }
  if ((out.depositAmount ?? 0) > 0 && !out.paymentMethod) {
    throw new CommercialPayloadError('a deposit needs a payment method');
  }
  return out;
}

function orderState(id: string): CommercialResult {
  const r = query(
    'SELECT id, order_number, customer_id, status, type, agreed_price, deposit_amount, remaining_amount, '
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

export function runOrderCreate(
  deps: EngineDeps, identity: CommandIdentity, raw: unknown,
): Promise<CommandOutcome> {
  const req = parseOrderCreate(raw);
  return runRemoteCommand(deps, identity, () => {
    const branch = identity.branchId;
    const customer = query(
      "SELECT id FROM customers WHERE id = ? AND branch_id = ? AND id NOT LIKE 'sys-%'",
      [req.customerId, branch],
    )[0];
    if (!customer) throw new CommandRejected('CUSTOMER_NOT_FOUND', 'no such client in this branch');
    const products = req.lines.map((l) => {
      const p = query('SELECT id, brand, name, sku, category_id FROM products WHERE id = ? AND branch_id = ?',
        [l.productId, branch])[0];
      if (!p) throw new CommandRejected('PRODUCT_NOT_FOUND', `no such product in this branch: ${l.productId}`);
      return p;
    });
    // Die Summe rechnet der Primary aus den Positionen — dieselbe Ableitung, die `createOrder`
    // benutzt, wenn kein Preis mitgeschickt wird. Genau deshalb wird auch keiner mitgeschickt.
    const total = req.lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
    const deposit = req.depositAmount ?? 0;
    if (deposit > total + 1e-9) {
      throw new CommandRejected('DEPOSIT_EXCEEDS_TOTAL',
        `the deposit (${deposit}) is more than the order (${total})`);
    }
    const first = products[0];
    const order = useOrderStore.getState().createOrder({
      customerId: req.customerId,
      // Ohne `materialKind` sind das Produktzeilen — und damit ist der Auftrag `normal`. Der Typ
      // wird vom Haus abgeleitet, nicht von hier behauptet.
      lines: req.lines.map((l) => ({
        productId: l.productId,
        description: l.description ?? '',
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        isCustomerFacing: true,
      })) as never,
      // Die Kopffelder, die der Bildschirm aus dem ersten Artikel füllt.
      requestedBrand: String(first?.brand ?? ''),
      requestedModel: String(first?.name ?? ''),
      requestedReference: first?.sku ? String(first.sku) : undefined,
      categoryId: first?.category_id ? String(first.category_id) : undefined,
      existingProductId: String(first?.id ?? ''),
      depositAmount: deposit,
      depositPaid: deposit > 0,
      depositDate: deposit > 0 ? new Date().toISOString().split('T')[0] : undefined,
      paymentMethod: req.paymentMethod,
      cardBrand: req.cardBrand,
      supplierName: req.supplierName,
      supplierPrice: req.supplierPrice,
      expectedDelivery: req.expectedDelivery,
      notes: req.notes,
    } as never);
    if (String(order.type) !== 'normal') {
      // Kann heute nicht eintreten (keine Zeile trägt `materialKind`) — steht hier trotzdem, weil
      // der Ausgang eines Fernauftrags nie davon abhängen darf, dass eine Ableitung anderswo so
      // bleibt, wie sie heute ist.
      throw new CommandRejected('ORDER_NOT_NORMAL', 'this command only creates normal orders');
    }
    return orderState(order.id) as unknown as Record<string, unknown>;
  });
}

// ── Auftrag: ändern ───────────────────────────────────────────────────────

export interface OrderUpdateRequest {
  id: string;
  expectedRevision: number;
  agreedPrice?: number;
  depositAmount?: number;
  supplierName?: string | null;
  supplierPrice?: number | null;
  expectedDelivery?: string | null;
  notes?: string | null;
}

/**
 * Genau die Felder des „Save"-Knopfs auf der Auftragsseite — abzüglich der beiden, die dort
 * AUSGERECHNET werden: `expectedMargin` (Preis minus Einkauf) und `remainingAmount` (Preis minus
 * Anzahlung). Die schickt der Client nicht mit; der Primary leitet sie aus dem Stand ab, der nach
 * dieser Änderung wirklich gilt. Zwei Rechner, die je ein Feld ändern, kämen sonst zu zwei
 * verschiedenen Resten.
 */
export function parseOrderUpdate(raw: unknown): OrderUpdateRequest {
  if (!isPlain(raw)) throw new CommercialPayloadError('payload must be an object');
  onlyKnownFields(raw, [
    'id', 'expectedRevision', 'agreedPrice', 'depositAmount',
    'supplierName', 'supplierPrice', 'expectedDelivery', 'notes',
  ]);
  const out: OrderUpdateRequest = {
    id: reqString(raw.id, 'id'),
    expectedRevision: expectedRevisionOf(raw.expectedRevision),
  };
  if (raw.agreedPrice !== undefined) out.agreedPrice = money(raw.agreedPrice, 'agreedPrice');
  if (raw.depositAmount !== undefined) out.depositAmount = money(raw.depositAmount, 'depositAmount');
  if (raw.supplierName !== undefined) {
    out.supplierName = raw.supplierName === null ? null : reqString(raw.supplierName, 'supplierName');
  }
  if (raw.supplierPrice !== undefined) {
    out.supplierPrice = raw.supplierPrice === null ? null : money(raw.supplierPrice, 'supplierPrice');
  }
  if (raw.expectedDelivery !== undefined) {
    out.expectedDelivery = raw.expectedDelivery === null ? null : reqString(raw.expectedDelivery, 'expectedDelivery');
  }
  if (raw.notes !== undefined) out.notes = raw.notes === null ? null : String(raw.notes);
  if (out.agreedPrice === undefined && out.depositAmount === undefined && out.supplierName === undefined
    && out.supplierPrice === undefined && out.expectedDelivery === undefined && out.notes === undefined) {
    throw new CommercialPayloadError('an edit must change something');
  }
  return out;
}

export function runOrderUpdate(
  deps: EngineDeps, identity: CommandIdentity, raw: unknown,
): Promise<CommandOutcome> {
  const req = parseOrderUpdate(raw);
  return runRemoteCommand(deps, identity, () => {
    const live = query(
      'SELECT id, type, agreed_price, deposit_amount, supplier_price FROM orders WHERE id = ? AND branch_id = ?',
      [req.id, identity.branchId],
    )[0];
    if (!live) throw new CommandRejected('ORDER_NOT_FOUND', 'no such order in this branch');
    if (String(live.type ?? 'normal') !== 'normal') {
      // Beim Sonderauftrag trägt eine ANGEBOTSZEILE den Preis, und der Bildschirm am Primary
      // schreibt den Kopfpreis dann bewusst NICHT — er zieht stattdessen die Zeile mit. Diesen
      // doppelten Vertrag aus der Ferne zu bedienen hieße raten; also nein, und zwar deutlich.
      throw new CommandRejected('ORDER_NOT_NORMAL',
        'only a normal order can be edited from another machine — a custom order carries its price in a quote line');
    }
    assertRevision('orders', req.id, req.expectedRevision, 'ORDER_NOT_FOUND');

    // Der Stand, der NACH dieser Änderung gilt — Feld für Feld: was der Auftrag mitbringt, sonst
    // das, was in der Zeile steht. Nur so stimmen Marge und Rest auch bei einer Teiländerung.
    const agreed = req.agreedPrice ?? (live.agreed_price === null ? 0 : Number(live.agreed_price));
    const deposit = req.depositAmount ?? Number(live.deposit_amount ?? 0);
    const supplierPrice = req.supplierPrice !== undefined
      ? req.supplierPrice
      : (live.supplier_price === null || live.supplier_price === undefined ? null : Number(live.supplier_price));

    const patch: Record<string, unknown> = {};
    if (req.agreedPrice !== undefined) patch.agreedPrice = req.agreedPrice;
    if (req.depositAmount !== undefined) patch.depositAmount = req.depositAmount;
    if (req.supplierName !== undefined) patch.supplierName = req.supplierName;
    if (req.supplierPrice !== undefined) patch.supplierPrice = req.supplierPrice;
    if (req.expectedDelivery !== undefined) patch.expectedDelivery = req.expectedDelivery;
    if (req.notes !== undefined) patch.notes = req.notes;
    // Die beiden abgeleiteten Felder — wortgleich zur Ableitung des Bildschirms.
    if (req.agreedPrice !== undefined || req.depositAmount !== undefined) {
      patch.remainingAmount = agreed - deposit;
    }
    if (req.agreedPrice !== undefined || req.supplierPrice !== undefined) {
      patch.expectedMargin = agreed && supplierPrice ? agreed - supplierPrice : undefined;
    }
    useOrderStore.getState().updateOrder(req.id, patch as never);
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
