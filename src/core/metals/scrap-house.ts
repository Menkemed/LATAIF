// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6D — der Altgold-Schnellhandel am Haus: EINE Folge für die Maske des Primary
// und für den Fernbefehl von PC2.
//
// Vorher prüfte der Store nur „mindestens eine Zeile" und die Zahlungssummen; ob eine Zeile ein
// Gewicht, eine Feinheit und nicht-negative Preise hat, prüfte allein die Maske. Die Zeilen wurden
// einzeln geschrieben, die Buchung in einer eigenen Transaktion danach — und ohne Riegel in der
// Maske legte ein zweiter Klick ein zweites Geschäft an. Ändern verglich die Fassung aus dem
// Zwischenspeicher und drehte die Buchungen außerhalb einer Klammer um; Stornieren setzte den
// Status VOR den Umkehrbuchungen (scheiterte eine, blieb das Geschäft storniert, aber gebucht —
// und ein zweiter Versuch war nicht mehr möglich).
//
// Jetzt: jede Handlung läuft INNERHALB einer offenen Transaktion (die Klammer hält der Aufrufer),
// die Fassung wird gegen die Zeile selbst geprüft, und ein Nein ist ein `ScrapRejected` mit Code.
//
// Unverändert (Befund): die Altgold-Tabellen werden nicht synchronisiert und stehen nicht im
// Sync-Manifest; die Buchung kennt keinen Geschäftspartner (weder Verkäufer noch Käufer).
// ════════════════════════════════════════════════════════════════════════════
import { v4 as uuid } from 'uuid';
import { getDatabase } from '@/core/db/database';
import { query, currentUserId } from '@/core/db/helpers';
import { postScrapTrade, reverseTransaction } from '@/core/ledger/posting';
import type { ScrapPaymentMethod } from '@/core/models/types';
import { assertKeepsBooks } from './metal-house';

/** Ein fachliches Nein des Altgoldhandels. */
export class ScrapRejected extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ScrapRejected';
    this.code = code;
  }
}

// Input-Shape pro Line beim Create/Update (ohne IDs, Position, Timestamps — die füllt das Haus auf).
export interface ScrapTradeLineInput {
  weightGrams: number;
  karat: string;
  purchasePrice: number;
  salePrice: number;
  notes?: string;
  imagesPurchase?: string[];
  imagesSale?: string[];
}

export interface ScrapTradePaymentInput {
  method: ScrapPaymentMethod;
  amount: number;
}

export interface ScrapTradeInput {
  sellerName: string;
  sellerPhone?: string;
  sellerCustomerId?: string;
  buyerName: string;
  buyerPhone?: string;
  buyerSupplierId?: string;
  tradeDate: string;
  notes?: string;
  lines: ScrapTradeLineInput[];
  paymentsOut: ScrapTradePaymentInput[];   // Splits zum Seller
  paymentsIn: ScrapTradePaymentInput[];    // Splits vom Buyer
}

export const SCRAP_PAYMENT_METHODS: readonly ScrapPaymentMethod[] = ['cash', 'bank', 'benefit'];

/** Höchstens so viele Fotos je Zeile und Richtung — dieselbe Zahl wie `ImageUpload maxImages={3}` der Maske. */
export const SCRAP_MAX_PHOTOS = 3;

const EPSILON = 0.001;

export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function computeAggregates(lines: ScrapTradeLineInput[]): {
  weightGrams: number;
  karat: string;
  purchasePrice: number;
  salePrice: number;
  profit: number;
} {
  const weight = lines.reduce((s, l) => s + (Number(l.weightGrams) || 0), 0);
  const purchase = lines.reduce((s, l) => s + (Number(l.purchasePrice) || 0), 0);
  const sale = lines.reduce((s, l) => s + (Number(l.salePrice) || 0), 0);
  const uniqueKarats = Array.from(new Set(lines.map(l => l.karat).filter(Boolean)));
  const karat = uniqueKarats.length === 1 ? uniqueKarats[0] : 'mixed';
  return {
    weightGrams: round3(weight),
    karat,
    purchasePrice: round3(purchase),
    salePrice: round3(sale),
    profit: round3(sale - purchase),
  };
}

function sumPayments(splits: ScrapTradePaymentInput[]): number {
  return round3(splits.reduce((s, p) => s + (Number(p.amount) || 0), 0));
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Die Regeln eines Geschäfts — die der Maske (Namen, Datum, je Zeile Gewicht > 0, Feinheit,
 * Preise ≥ 0) jetzt auch im Haus, dazu die Zahlungsregeln, die der Store schon hatte (dieselben
 * Texte, dieselbe Toleranz). Liefert die bereinigte Eingabe; Fotos bleiben unangetastet.
 */
export function normaliseScrapInput(input: ScrapTradeInput): ScrapTradeInput {
  const sellerName = String(input.sellerName ?? '').trim();
  const buyerName = String(input.buyerName ?? '').trim();
  if (!sellerName) throw new ScrapRejected('SCRAP_PARTY_REQUIRED', 'Seller name is required');
  if (!buyerName) throw new ScrapRejected('SCRAP_PARTY_REQUIRED', 'Buyer name is required');
  // Die Maske liefert ein Datumsfeld (`type="date"`, JJJJ-MM-TT); die Buchung trägt dieses Datum.
  const tradeDate = String(input.tradeDate ?? '');
  if (!/^\d{4}-\d{2}-\d{2}/.test(tradeDate) || Number.isNaN(Date.parse(tradeDate.slice(0, 10)))) {
    throw new ScrapRejected('SCRAP_DATE_INVALID', 'Trade date is required');
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new ScrapRejected('SCRAP_LINES_REQUIRED', 'Scrap trade requires at least one item');
  }
  const lines = input.lines.map((l, i) => {
    const n = i + 1;
    if (!finite(l.weightGrams) || !(l.weightGrams > 0)) throw new ScrapRejected('SCRAP_LINE_INVALID', `Item ${n}: weight must be > 0`);
    const karat = typeof l.karat === 'string' ? l.karat.trim() : '';
    if (!karat) throw new ScrapRejected('SCRAP_LINE_INVALID', `Item ${n}: karat is required`);
    if (!finite(l.purchasePrice) || !(l.purchasePrice >= 0)) throw new ScrapRejected('SCRAP_LINE_INVALID', `Item ${n}: purchase price must be ≥ 0`);
    if (!finite(l.salePrice) || !(l.salePrice >= 0)) throw new ScrapRejected('SCRAP_LINE_INVALID', `Item ${n}: sale price must be ≥ 0`);
    for (const imgs of [l.imagesPurchase, l.imagesSale]) {
      if (imgs !== undefined && (!Array.isArray(imgs) || imgs.length > SCRAP_MAX_PHOTOS || imgs.some((x) => typeof x !== 'string'))) {
        throw new ScrapRejected('SCRAP_LINE_INVALID', `Item ${n}: at most ${SCRAP_MAX_PHOTOS} photos per side`);
      }
    }
    return { ...l, karat };
  });
  const paymentsOut = Array.isArray(input.paymentsOut) ? input.paymentsOut : [];
  const paymentsIn = Array.isArray(input.paymentsIn) ? input.paymentsIn : [];
  if (!paymentsOut.length) throw new ScrapRejected('SCRAP_PAYMENT_INVALID', 'At least one payment out is required');
  if (!paymentsIn.length) throw new ScrapRejected('SCRAP_PAYMENT_INVALID', 'At least one payment in is required');
  for (const p of [...paymentsOut, ...paymentsIn]) {
    if (!(SCRAP_PAYMENT_METHODS as readonly string[]).includes(p?.method as string)) {
      throw new ScrapRejected('SCRAP_PAYMENT_INVALID', `unknown payment method: ${String(p?.method)}`);
    }
    if (!finite(p.amount) || !(p.amount > 0)) throw new ScrapRejected('SCRAP_PAYMENT_INVALID', 'Each payment split must have amount > 0');
  }
  const agg = computeAggregates(lines);
  const sOut = sumPayments(paymentsOut);
  const sIn = sumPayments(paymentsIn);
  if (Math.abs(sOut - agg.purchasePrice) > EPSILON) {
    throw new ScrapRejected('SCRAP_PAYMENT_MISMATCH', `Payment OUT (${sOut.toFixed(3)}) must equal Total Purchase (${agg.purchasePrice.toFixed(3)})`);
  }
  if (Math.abs(sIn - agg.salePrice) > EPSILON) {
    throw new ScrapRejected('SCRAP_PAYMENT_MISMATCH', `Payment IN (${sIn.toFixed(3)}) must equal Total Sale (${agg.salePrice.toFixed(3)})`);
  }
  return {
    ...input,
    sellerName,
    buyerName,
    tradeDate,
    lines,
    paymentsOut: paymentsOut.map((p) => ({ method: p.method, amount: p.amount })),
    paymentsIn: paymentsIn.map((p) => ({ method: p.method, amount: p.amount })),
  };
}

/** Verknüpfter Kunde / Lieferant — nur einer DIESER Filiale; ein fremder ist nicht vorhanden. */
function assertLinks(input: ScrapTradeInput, branchId: string): void {
  if (input.sellerCustomerId && !query('SELECT id FROM customers WHERE id = ? AND branch_id = ?', [input.sellerCustomerId, branchId])[0]) {
    throw new ScrapRejected('CUSTOMER_NOT_FOUND', 'no such customer in this branch');
  }
  if (input.buyerSupplierId && !query('SELECT id FROM suppliers WHERE id = ? AND branch_id = ?', [input.buyerSupplierId, branchId])[0]) {
    throw new ScrapRejected('SUPPLIER_NOT_FOUND', 'no such supplier in this branch');
  }
}

export function nextTradeNumber(branchId: string): string {
  const rows = query(`SELECT trade_number FROM scrap_trades WHERE branch_id = ?`, [branchId]);
  let max = 0;
  for (const r of rows) {
    const n = parseInt(String(r.trade_number).replace(/\D/g, ''), 10);
    if (!isNaN(n) && n > max) max = n;
  }
  return `SGT-${String(max + 1).padStart(6, '0')}`;
}

// L-14: ALLE noch nicht reversierten Transaktionen eines Trades (ohne LIMIT).
// editTrade/cancelTrade muessen jede offene Buchungs-Transaktion zurueckdrehen,
// sonst bleiben aeltere unreversierte Transaktionen als Ledger-Leichen stehen.
export function allUnreversedTransactionsFor(tradeId: string): string[] {
  const rows = query(
    `SELECT le.transaction_id, MIN(le.recorded_at) AS ts
       FROM ledger_entries le
      WHERE le.source_module = 'SCRAP_TRADE'
        AND le.source_id = ?
        AND le.reverses_entry_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM ledger_entries r WHERE r.reverses_entry_id = le.id
        )
   GROUP BY le.transaction_id
   ORDER BY ts ASC`,
    [tradeId]
  );
  return rows.map(r => r.transaction_id as string);
}

function insertLines(tradeId: string, lines: ScrapTradeLineInput[], createdAt: string): void {
  const db = getDatabase();
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const purchase = round3(Number(l.purchasePrice) || 0);
    const sale = round3(Number(l.salePrice) || 0);
    db.run(
      `INSERT INTO scrap_trade_lines (
        id, scrap_trade_id, position, weight_grams, karat,
        purchase_price, sale_price, profit, notes,
        images_purchase, images_sale, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuid(), tradeId, i + 1,
        round3(Number(l.weightGrams) || 0), l.karat,
        purchase, sale, round3(sale - purchase),
        l.notes || null,
        JSON.stringify(l.imagesPurchase || []),
        JSON.stringify(l.imagesSale || []),
        createdAt,
      ]
    );
  }
}

function insertPayments(tradeId: string, paymentsOut: ScrapTradePaymentInput[], paymentsIn: ScrapTradePaymentInput[], createdAt: string): void {
  const db = getDatabase();
  const rows: Array<['OUT' | 'IN', ScrapTradePaymentInput, number]> = [
    ...paymentsOut.map((p, i) => ['OUT', p, i + 1] as ['OUT', ScrapTradePaymentInput, number]),
    ...paymentsIn.map((p, i) => ['IN', p, i + 1] as ['IN', ScrapTradePaymentInput, number]),
  ];
  for (const [direction, p, position] of rows) {
    db.run(
      `INSERT INTO scrap_trade_payments (id, scrap_trade_id, direction, method, amount, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [uuid(), tradeId, direction, p.method, round3(Number(p.amount) || 0), position, createdAt]
    );
  }
}

/** Die Buchung des Geschäfts — die vorhandene Funktion; ein Fehler wirft und nimmt alles zurück. */
function post(tradeId: string, input: ScrapTradeInput): void {
  postScrapTrade({ id: tradeId, tradeDate: input.tradeDate, paymentsOut: input.paymentsOut, paymentsIn: input.paymentsIn });
}

export interface ScrapTradeResult {
  tradeId: string;
  tradeNumber: string;
  status: 'completed' | 'cancelled';
  version: number;
  profit: number;
}

function resultOf(tradeId: string): ScrapTradeResult {
  const r = query('SELECT trade_number, status, version, profit FROM scrap_trades WHERE id = ?', [tradeId])[0];
  return {
    tradeId,
    tradeNumber: String(r?.trade_number ?? ''),
    status: (String(r?.status ?? 'completed') as 'completed' | 'cancelled'),
    version: Number(r?.version ?? 1),
    profit: Number(r?.profit ?? 0),
  };
}

/** Das lebende Geschäft dieser Filiale — sonst ein Nein. */
function liveTrade(tradeId: string, branchId: string): { status: string; version: number } {
  const r = query('SELECT status, version FROM scrap_trades WHERE id = ? AND branch_id = ?', [tradeId, branchId])[0];
  if (!r) throw new ScrapRejected('TRADE_NOT_FOUND', 'no such trade in this branch');
  return { status: String(r.status ?? 'completed'), version: Number(r.version ?? 1) };
}

/** Die gesehene Fassung gegen die Zeile selbst — innerhalb der Transaktion. */
function assertVersion(seen: number, now: number): void {
  if (seen !== now) {
    throw new ScrapRejected('RECORD_CHANGED', `this trade changed since you opened it (you saw ${seen}, it is now ${now})`);
  }
}

// ── Anlegen ────────────────────────────────────────────────────────────────

/**
 * „Save Trade": Kopf, Zeilen, Zahlungen und Buchung — EINE Folge. Nummer, Summen, Status und
 * Fassung bestimmt das Haus.
 */
export function createScrapTradeInHouse(raw: ScrapTradeInput, branchId: string): ScrapTradeResult {
  assertKeepsBooks();
  const input = normaliseScrapInput(raw);
  assertLinks(input, branchId);
  const agg = computeAggregates(input.lines);
  const id = uuid();
  const now = new Date().toISOString();
  let userId: string | null = null;
  try { userId = currentUserId() || null; } catch { userId = null; }

  // payment_method_purchase / payment_method_sale werden hier nur als
  // "primäre Methode" (erste Split) gespeichert, damit Banking-Reports
  // einen Default haben. SSOT sind die scrap_trade_payments-Rows.
  getDatabase().run(
    `INSERT INTO scrap_trades (
      id, branch_id, trade_number,
      seller_name, seller_phone, seller_customer_id,
      buyer_name, buyer_phone, buyer_supplier_id,
      weight_grams, karat,
      purchase_price, sale_price, profit,
      payment_method_purchase, payment_method_sale,
      trade_date, notes, images_purchase, images_sale, status,
      created_at, updated_at, created_by, version, sync_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', 'completed', ?, ?, ?, 1, 'pending')`,
    [
      id, branchId, nextTradeNumber(branchId),
      input.sellerName, input.sellerPhone || null, input.sellerCustomerId || null,
      input.buyerName, input.buyerPhone || null, input.buyerSupplierId || null,
      agg.weightGrams, agg.karat,
      agg.purchasePrice, agg.salePrice, agg.profit,
      input.paymentsOut[0]?.method || 'cash',
      input.paymentsIn[0]?.method || 'cash',
      input.tradeDate, input.notes || null,
      now, now, userId,
    ]
  );
  insertLines(id, input.lines, now);
  insertPayments(id, input.paymentsOut, input.paymentsIn, now);
  post(id, input);
  return resultOf(id);
}

// ── Ändern ─────────────────────────────────────────────────────────────────

/**
 * „Save Changes": die gesehene Fassung gegen die Zeile, dann Kopf, Zeilen und Zahlungen ersetzen,
 * JEDE offene Buchung umkehren (L-14) und neu buchen — in derselben Transaktion.
 */
export function updateScrapTradeInHouse(tradeId: string, expectedVersion: number, raw: ScrapTradeInput, branchId: string): ScrapTradeResult {
  assertKeepsBooks();
  const live = liveTrade(tradeId, branchId);
  if (live.status === 'cancelled') throw new ScrapRejected('TRADE_CANCELLED', 'Cannot edit a cancelled trade');
  assertVersion(expectedVersion, live.version);
  const input = normaliseScrapInput(raw);
  assertLinks(input, branchId);
  const agg = computeAggregates(input.lines);
  const now = new Date().toISOString();
  const db = getDatabase();
  db.run(
    `UPDATE scrap_trades SET
      seller_name = ?, seller_phone = ?, seller_customer_id = ?,
      buyer_name = ?, buyer_phone = ?, buyer_supplier_id = ?,
      weight_grams = ?, karat = ?,
      purchase_price = ?, sale_price = ?, profit = ?,
      payment_method_purchase = ?, payment_method_sale = ?,
      trade_date = ?, notes = ?,
      updated_at = ?, version = version + 1, sync_status = 'pending'
     WHERE id = ? AND version = ?`,
    [
      input.sellerName, input.sellerPhone || null, input.sellerCustomerId || null,
      input.buyerName, input.buyerPhone || null, input.buyerSupplierId || null,
      agg.weightGrams, agg.karat,
      agg.purchasePrice, agg.salePrice, agg.profit,
      input.paymentsOut[0]?.method || 'cash',
      input.paymentsIn[0]?.method || 'cash',
      input.tradeDate, input.notes || null,
      now, tradeId, expectedVersion,
    ]
  );

  // Lines + Payments komplett ersetzen
  db.run(`DELETE FROM scrap_trade_lines WHERE scrap_trade_id = ?`, [tradeId]);
  db.run(`DELETE FROM scrap_trade_payments WHERE scrap_trade_id = ?`, [tradeId]);
  insertLines(tradeId, input.lines, now);
  insertPayments(tradeId, input.paymentsOut, input.paymentsIn, now);

  // Ledger reverse + repost — alle offenen Transaktionen zurueckdrehen (L-14)
  for (const txId of allUnreversedTransactionsFor(tradeId)) reverseTransaction(txId, now);
  post(tradeId, input);
  return resultOf(tradeId);
}

// ── Stornieren ─────────────────────────────────────────────────────────────

/**
 * „Yes, Cancel Trade": ERST die Umkehrbuchungen, dann Status und Fassung — beides in derselben
 * Transaktion. Scheitert eine Umkehr, bleibt das Geschäft aktiv und kann erneut storniert werden.
 */
export function cancelScrapTradeInHouse(tradeId: string, expectedVersion: number, branchId: string): ScrapTradeResult {
  assertKeepsBooks();
  const live = liveTrade(tradeId, branchId);
  if (live.status === 'cancelled') throw new ScrapRejected('TRADE_CANCELLED', 'this trade is already cancelled');
  assertVersion(expectedVersion, live.version);
  const now = new Date().toISOString();
  for (const txId of allUnreversedTransactionsFor(tradeId)) reverseTransaction(txId, now);
  getDatabase().run(
    `UPDATE scrap_trades SET status = 'cancelled', updated_at = ?, version = version + 1, sync_status = 'pending' WHERE id = ? AND version = ?`,
    [now, tradeId, expectedVersion],
  );
  return resultOf(tradeId);
}
