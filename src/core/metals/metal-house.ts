// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6D — Edelmetall am Haus: EINE Folge für die Maske des Primary und für den
// Fernbefehl von PC2.
//
// Vorher schrieb „Add Item" bis zu vier getrennte Commits (Zeile, Goldbewegung, Ausgabe samt
// A/P-Buchung, Verknüpfung) und schluckte jeden Fehler danach — ein Metall ohne Schuld beim
// Lieferanten, oder eine Schuld ohne Verknüpfung, war ein normaler Ausgang. „Sell"/„Melt" schrieben
// ohne jede Statusprüfung (ein verkauftes Stück ließ sich einschmelzen und ein zweites Mal
// verkaufen), und den Schmelzwert rechnete die Maske aus IHREM Spotpreis-Eingabefeld.
//
// Jetzt gilt:
//   • Die Funktionen hier laufen INNERHALB einer offenen Transaktion — sie öffnen, committen und
//     speichern nie. Die Klammer hält der Aufrufer (`runOnPrimary`, `runRemoteCommand`).
//   • Spotpreis und Schmelzwert leitet das Haus aus SEINER Einstellung ab, nie aus dem Client.
//   • Ein Nein ist ein `MetalRejected` mit festem Code — dieselbe Antwort an beiden Rechnern.
//
// Bewusst NICHT geändert (Befund, keine erfundene Buchhaltung): der Metallkauf wird als Aufwand
// gebucht, nicht aktiviert; ein Verkauf bucht weder Erlös noch Wareneinsatz; Verkauf und
// Einschmelzen schreiben keine Goldbewegung „out". Das steht so im Bestand und bleibt so.
// ════════════════════════════════════════════════════════════════════════════
import { v4 as uuid } from 'uuid';
import { getDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId } from '@/core/db/helpers';
import { trackInsert, trackUpdate } from '@/core/sync/track';
import {
  beginLedgerTransaction, commitLedgerTransaction, rollbackLedgerTransaction,
  hasLedgerEntries, watchLedgerPosts,
} from '@/core/ledger/posting';
import { readsFromPrimary } from '@/core/data/primary-source';
import type { BusinessReadContext } from '@/core/data/read-context';
import { useGoldStore } from '@/stores/goldStore';
import { useExpenseStore } from '@/stores/expenseStore';
import type { MetalKarat, MetalStatus, MetalType, PreciousMetal } from '@/core/models/types';

/** Ein fachliches Nein des Metallhauses — eingefroren, wenn es aus einem Fernauftrag kommt. */
export class MetalRejected extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'MetalRejected';
    this.code = code;
  }
}

export const METAL_TYPES: readonly MetalType[] = ['gold', 'silver', 'platinum'];

/** Die Feinheiten je Metall — genau die Auswahl der Maske, jetzt an EINER Stelle. */
export const METAL_KARATS: Record<MetalType, readonly MetalKarat[]> = {
  gold: ['24K', '22K', '21K', '18K', '14K', '9K'],
  silver: ['999', '925'],
  platinum: ['950', '999'],
};

export const METAL_PURITY: Record<string, number> = {
  '24K': 1.0, '22K': 0.916, '21K': 0.875, '18K': 0.75,
  '14K': 0.585, '9K': 0.375, '999': 0.999, '925': 0.925, '950': 0.95,
};

/** Dieselbe Formel wie bisher in der Maske: ohne Feinheit oder Spotpreis kein Schmelzwert. */
export function meltValueOf(weight: number, karat: string | undefined, spotPrice: number): number {
  if (!karat || !spotPrice) return 0;
  const purity = METAL_PURITY[karat] ?? 1;
  return weight * purity * spotPrice;
}

export type MetalRecord = PreciousMetal & { revision: number };

/** Die Zeile, wie Maske und Fernauskunft sie zeigen — samt Fassung für die nächste Änderung. */
export function metalFromRow(row: Record<string, unknown>): MetalRecord {
  return {
    id: row.id as string,
    metalType: row.metal_type as MetalType,
    karat: row.karat as MetalKarat | undefined,
    weightGrams: row.weight_grams as number,
    description: row.description as string | undefined,
    purchasePricePerGram: row.purchase_price_per_gram as number | undefined,
    purchaseTotal: row.purchase_total as number | undefined,
    spotPriceAtPurchase: row.spot_price_at_purchase as number | undefined,
    currentSpotPrice: row.current_spot_price as number | undefined,
    meltValue: row.melt_value as number | undefined,
    salePrice: row.sale_price as number | undefined,
    status: (row.status as MetalStatus) || 'in_stock',
    paidAmount: (row.paid_amount as number) || 0,
    paymentStatus: (row.payment_status as 'UNPAID' | 'PARTIALLY_PAID' | 'PAID') || 'UNPAID',
    supplierName: row.supplier_name as string | undefined,
    supplierId: row.supplier_id as string | undefined,
    linkedExpenseId: row.linked_expense_id as string | undefined,
    customerId: row.customer_id as string | undefined,
    notes: row.notes as string | undefined,
    images: JSON.parse((row.images as string) || '[]'),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    createdBy: row.created_by as string | undefined,
    revision: Number(row.revision ?? 1),
  };
}

// ── Die Klammer für die alten, synchronen Store-Einstiege ──────────────────
//
// `createMetal`/`createTrade` geben ihr Ergebnis synchron zurück (die Werkstatt-Selbstprüfung
// benutzt die Kennung sofort). Sie bekommen deshalb keine Warteschlange, aber dieselbe EINE
// Transaktion wie die Maske — kein Commit je Schritt mehr. Die Hausfunktionen selbst öffnen nie.
export function inOneTransaction<T>(work: () => T): T {
  beginLedgerTransaction();
  let out: T;
  try {
    out = work();
    commitLedgerTransaction();
  } catch (e) {
    rollbackLedgerTransaction();
    throw e;
  }
  return out;
}

/**
 * Ein Rechner ohne eigene Bücher (PC2) schreibt NIE in eine lokale Datenbank — seine Maske geht
 * über die Brücke. Erreicht ein Aufruf trotzdem das Haus, ist das ein Nein, kein stiller Griff.
 */
export function assertKeepsBooks(): void {
  if (readsFromPrimary()) {
    throw new MetalRejected('CLIENT_HAS_NO_BOOKS', 'this computer keeps no books — the action is sent to the main computer');
  }
}

/** Die Filiale der Maske am Primary. Ohne Sitzung kein stilles 'branch-main' mehr. */
export function localHouseBranch(): string {
  let b = '';
  try { b = currentBranchId(); } catch { b = ''; }
  if (!b) throw new MetalRejected('NO_BRANCH', 'no branch in the current session');
  return b;
}

function userOrNull(): string | null {
  try { return currentUserId() || null; } catch { return null; }
}

// ── Spotpreise ─────────────────────────────────────────────────────────────

const spotKey = (t: string): string => `spot_price.${t}`;

function assertMetalType(t: unknown): MetalType {
  if (typeof t !== 'string' || !(METAL_TYPES as readonly string[]).includes(t)) {
    throw new MetalRejected('METAL_TYPE_INVALID', `unknown metal type: ${String(t)}`);
  }
  return t as MetalType;
}

/** Der Spotpreis je Gramm dieser Filiale — dieselbe Lesart wie bisher (`parseFloat(…) || 0`). */
export function spotPriceOf(branchId: string, metalType: string): number {
  const r = query('SELECT value FROM settings WHERE branch_id = ? AND key = ?', [branchId, spotKey(metalType)])[0];
  return parseFloat(String(r?.value ?? '0')) || 0;
}

export interface SpotPrices { gold: number; silver: number; platinum: number }

/** Die drei Spotpreise der Filiale des Ausweises — für die Maske am Primary und für PC2. */
export function spotPricesFor(ctx: BusinessReadContext): SpotPrices {
  return {
    gold: spotPriceOf(ctx.branchId, 'gold'),
    silver: spotPriceOf(ctx.branchId, 'silver'),
    platinum: spotPriceOf(ctx.branchId, 'platinum'),
  };
}

/**
 * Den Spotpreis einer Metallart setzen. Die Einstellung bleibt, was sie war: je Filiale, nicht
 * synchronisiert, ohne Protokollzeile (Befund). Neu ist nur, dass sie nicht mehr bei JEDEM
 * Tastendruck geschrieben wird — das entscheidet die Maske (Übernahme beim Verlassen/Enter).
 */
export function setSpotPriceInHouse(metalTypeRaw: unknown, priceRaw: unknown, branchId: string): { metalType: MetalType; price: number } {
  assertKeepsBooks();
  const metalType = assertMetalType(metalTypeRaw);
  if (typeof priceRaw !== 'number' || !Number.isFinite(priceRaw) || priceRaw < 0) {
    throw new MetalRejected('SPOT_PRICE_INVALID', 'a spot price is a number of at least 0');
  }
  const price = priceRaw;
  getDatabase().run(
    `INSERT INTO settings (branch_id, key, value, category, updated_at)
     VALUES (?, ?, ?, 'metals', ?)
     ON CONFLICT(branch_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [branchId, spotKey(metalType), String(price), new Date().toISOString()],
  );
  return { metalType, price };
}

// ── Anlegen ────────────────────────────────────────────────────────────────

export interface MetalCreateInput {
  metalType: MetalType;
  karat: MetalKarat;
  weightGrams: number;
  purchaseTotal?: number;
  purchasePricePerGram?: number;
  supplierId?: string;
  supplierName?: string;
  description?: string;
  notes?: string;
}

/** Was eine Anlage nennen darf. Alles andere (Spot, Schmelzwert, Status, Verknüpfung) rechnet das Haus. */
export const METAL_CREATE_FIELDS = [
  'metalType', 'karat', 'weightGrams', 'purchaseTotal', 'purchasePricePerGram',
  'supplierId', 'supplierName', 'description', 'notes',
] as const;

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

function optMoney(v: unknown, name: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    throw new MetalRejected('METAL_AMOUNT_INVALID', `${name} must be a number of at least 0`);
  }
  return v;
}

function optText(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const t = String(v);
  return t.trim() === '' ? undefined : t;
}

/**
 * Die Regeln einer Anlage — vorher nur „Typ und Gewicht gesetzt" in der Maske (ein negatives
 * Gewicht ging durch). Die Feinheit muss zur Metallart gehören, genau wie die Auswahl der Maske.
 */
export function normaliseMetalCreate(raw: Partial<Record<keyof MetalCreateInput, unknown>>): MetalCreateInput {
  const metalType = assertMetalType(raw.metalType);
  const karat = raw.karat;
  if (typeof karat !== 'string' || !(METAL_KARATS[metalType] as readonly string[]).includes(karat)) {
    throw new MetalRejected('METAL_KARAT_INVALID', `${String(karat)} is not a purity of ${metalType}`);
  }
  const w = raw.weightGrams;
  if (typeof w !== 'number' || !Number.isFinite(w) || w <= 0) {
    throw new MetalRejected('METAL_WEIGHT_INVALID', 'the weight must be more than 0 grams');
  }
  const supplierId = optText(raw.supplierId);
  return {
    metalType,
    karat: karat as MetalKarat,
    weightGrams: round3(w),
    purchaseTotal: optMoney(raw.purchaseTotal, 'purchaseTotal'),
    purchasePricePerGram: optMoney(raw.purchasePricePerGram, 'purchasePricePerGram'),
    supplierId,
    supplierName: optText(raw.supplierName),
    description: optText(raw.description),
    notes: optText(raw.notes),
  };
}

export interface MetalCreated {
  metal: MetalRecord;
  linkedExpenseId?: string;
}

/**
 * „Add Item": Zeile, Goldbewegung, Lieferantenschuld (Ausgabe + A/P-Buchung), Verknüpfung — EINE
 * Folge. Scheitert irgendein Schritt, gibt es keinen davon (vorher blieb, was bis dahin stand).
 */
export function createMetalInHouse(raw: Partial<Record<keyof MetalCreateInput, unknown>>, branchId: string): MetalCreated {
  assertKeepsBooks();
  const input = normaliseMetalCreate(raw);

  // Ein Lieferant ist ein Lieferant DIESER Filiale — ein fremder ist von hier aus nicht vorhanden.
  let supplierName = input.supplierName;
  if (input.supplierId) {
    const s = query('SELECT name FROM suppliers WHERE id = ? AND branch_id = ?', [input.supplierId, branchId])[0];
    if (!s) throw new MetalRejected('SUPPLIER_NOT_FOUND', 'no such supplier in this branch');
    // Der Name kommt aus dem Stammsatz — dieselbe Wahl, die die Maske beim Auswählen trifft.
    supplierName = String(s.name ?? '') || supplierName;
  }

  // Spot und Schmelzwert: aus der Einstellung des HAUSES. Ein unbekannter Spot (0) bleibt, wie
  // bisher, leer statt 0 in der Zeile.
  const spot = spotPriceOf(branchId, input.metalType);
  const melt = meltValueOf(input.weightGrams, input.karat, spot);

  const id = uuid();
  const now = new Date().toISOString();
  const db = getDatabase();
  db.run(
    `INSERT INTO precious_metals (id, branch_id, metal_type, karat, weight_grams, description,
      purchase_price_per_gram, purchase_total, spot_price_at_purchase, current_spot_price,
      melt_value, sale_price, status, supplier_name, supplier_id, customer_id, notes, images,
      created_at, updated_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, branchId, input.metalType, input.karat, input.weightGrams,
     input.description ?? null,
     // Eine eingegebene 0 bleibt 0 (vorher machte `|| null` daraus „nicht angegeben").
     input.purchasePricePerGram ?? null, input.purchaseTotal ?? null,
     spot || null, spot || null, melt || null,
     null, 'in_stock',
     supplierName ?? null, input.supplierId ?? null, null,
     input.notes ?? null, '[]', now, now, userOrNull()],
  );
  trackInsert('precious_metals', id, { metalType: input.metalType, karat: input.karat, weightGrams: input.weightGrams });

  // v0.1.46 — der Bestands-Inflow als Goldbewegung. Jetzt Teil der Handlung: ein Fehler hier nimmt
  // die Anlage zurück, statt nur eine Warnung in die Konsole zu schreiben.
  if (input.metalType === 'gold' && input.karat && input.weightGrams > 0) {
    useGoldStore.getState().recordExternalGoldInflow(branchId, input.karat, input.weightGrams, {
      supplierId: input.supplierId,
      metalId: id,
      notes: input.supplierId
        ? `Purchase: ${input.weightGrams}g ${input.karat} (metal ${id.slice(0, 8)})`
        : `Manual entry: ${input.weightGrams}g ${input.karat} (metal ${id.slice(0, 8)})`,
    });
  }

  // v0.1.46 — Lieferant + Kaufsumme → offene A/P-Schuld (payNow=false). Die Ausgabe legt die
  // vorhandene Funktion an; sie verschluckt einen Buchungsfehler — der Wächter macht daraus einen
  // Abbruch der GANZEN Handlung.
  let linkedExpenseId: string | undefined;
  if (input.supplierId && (input.purchaseTotal ?? 0) > 0) {
    const buchung = watchLedgerPosts('metal purchase');
    const exp = useExpenseStore.getState().createExpense({
      category: 'Inventory',
      amount: input.purchaseTotal,
      supplierId: input.supplierId,
      expenseDate: now.split('T')[0],
      description: `Metal purchase: ${input.weightGrams}g ${input.karat || ''} (${id.slice(0, 8)})`,
      relatedModule: 'metal',
      relatedEntityId: id,
      payNow: false, // A/P, Owner zahlt spaeter via Supplier-Detail
    });
    buchung();
    // Ohne Buchung wäre die Schuld beim Lieferanten nur eine Zeile — genau die Lücke, die dieser
    // Schritt schließen soll. Also: keine Buchung, keine Handlung.
    if (!hasLedgerEntries('EXPENSE', exp.id)) {
      throw new Error('metal purchase: the supplier payable was not posted — the whole action is undone');
    }
    db.run('UPDATE precious_metals SET linked_expense_id = ?, updated_at = ? WHERE id = ?', [exp.id, now, id]);
    trackUpdate('precious_metals', id, { linkedExpenseId: exp.id });
    linkedExpenseId = exp.id;
  }

  const row = query('SELECT * FROM precious_metals WHERE id = ?', [id])[0];
  return { metal: metalFromRow(row), linkedExpenseId };
}

// ── Verkaufen / Einschmelzen ───────────────────────────────────────────────

export interface MetalStatusChange {
  metalId: string;
  status: 'sold' | 'melted';
  /** Nur bei „sold": der Verkaufspreis, ≥ 0 (die Maske lässt 0 zu). */
  salePrice?: number;
  /** Die gesehene Fassung. Fern Pflicht; die Maske schickt sie ebenfalls mit. */
  expectedRevision?: number;
}

export interface MetalStatusResult {
  metalId: string;
  status: MetalStatus;
  revision: number;
  salePrice: number | null;
  currentSpotPrice: number | null;
  meltValue: number | null;
}

/** Die Fassung, gegen die Zeile selbst — innerhalb der Transaktion. */
export function assertMetalRevision(metalId: string, expected: number): void {
  const live = query('SELECT revision FROM precious_metals WHERE id = ?', [metalId])[0];
  const now = Number(live?.revision ?? 0);
  if (now !== expected) {
    throw new MetalRejected('RECORD_CHANGED', `this item changed since you opened it (you saw ${expected}, it is now ${now})`);
  }
}

/**
 * „Mark Sold" / „Confirm Melt". Nur ein Stück AM LAGER wechselt den Status — vorher ließ sich ein
 * verkauftes Stück einschmelzen und ein zweites Mal verkaufen. Ein Verkauf schreibt, wie bisher,
 * nur Status und Preis (keine Buchung — Befund, nicht erfunden); beim Einschmelzen friert das
 * Haus SEINEN Spotpreis ein.
 */
export function changeMetalStatusInHouse(req: MetalStatusChange, branchId: string): MetalStatusResult {
  assertKeepsBooks();
  if (req.status !== 'sold' && req.status !== 'melted') {
    throw new MetalRejected('METAL_STATUS_INVALID', 'an item is either sold or melted');
  }
  const live = query('SELECT id, status, metal_type, karat, weight_grams FROM precious_metals WHERE id = ? AND branch_id = ?',
    [req.metalId, branchId])[0];
  if (!live) throw new MetalRejected('METAL_NOT_FOUND', 'no such item in this branch');
  if (String(live.status || 'in_stock') !== 'in_stock') {
    throw new MetalRejected('METAL_NOT_IN_STOCK', `this item is already ${String(live.status).replace('_', ' ')}`);
  }
  if (req.expectedRevision !== undefined) assertMetalRevision(req.metalId, req.expectedRevision);

  const now = new Date().toISOString();
  const db = getDatabase();
  if (req.status === 'sold') {
    const p = req.salePrice;
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0) {
      throw new MetalRejected('METAL_SALE_PRICE_INVALID', 'a sale price is a number of at least 0');
    }
    db.run('UPDATE precious_metals SET status = ?, sale_price = ?, updated_at = ? WHERE id = ?', ['sold', p, now, req.metalId]);
    trackUpdate('precious_metals', req.metalId, { status: 'sold', salePrice: p });
  } else {
    if (req.salePrice !== undefined) {
      throw new MetalRejected('METAL_SALE_PRICE_INVALID', 'melting takes no sale price');
    }
    const spot = spotPriceOf(branchId, String(live.metal_type));
    const melt = meltValueOf(Number(live.weight_grams) || 0, (live.karat as string | null) ?? undefined, spot);
    db.run('UPDATE precious_metals SET status = ?, current_spot_price = ?, melt_value = ?, updated_at = ? WHERE id = ?',
      ['melted', spot, melt, now, req.metalId]);
    trackUpdate('precious_metals', req.metalId, { status: 'melted', currentSpotPrice: spot, meltValue: melt });
  }
  const after = query('SELECT status, revision, sale_price, current_spot_price, melt_value FROM precious_metals WHERE id = ?', [req.metalId])[0];
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return {
    metalId: req.metalId,
    status: String(after?.status) as MetalStatus,
    revision: Number(after?.revision ?? 0),
    salePrice: num(after?.sale_price),
    currentSpotPrice: num(after?.current_spot_price),
    meltValue: num(after?.melt_value),
  };
}
