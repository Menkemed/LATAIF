// ════════════════════════════════════════════════════════════════════════════
// BULK METAL V1 — die Hausfolge eines Bulk-Lots (Spec Kapitel 2, 4, 5, 6.5, 10, 13.6).
//
// Jede Änderung an Restgewicht, Restwert oder Lot-Gewicht ist GENAU EINE Bewegung in
// `bulk_lot_movements`; das Lot ist immer die Summe seiner Bewegungen. Die Funktionen laufen in der
// Transaktion des Aufrufers (runOnPrimary / runRemoteCommand / Store-Klammer), prüfen am Ende die
// Invarianten und werfen bei jedem Verstoß — die Klammer rollt dann alles zurück.
//
// Bulk-Lots stehen in `stock_lots` mit `unit = 'mg'` und `qty_total = qty_remaining = unit_cost = 0`:
// für alle Stückpfade sind sie damit immer leer. Bestand und Wert stehen nur in den mg/Fils-Spalten.
// ════════════════════════════════════════════════════════════════════════════
import { v4 as uuid } from 'uuid';
import { getDatabase } from '@/core/db/database';
import { query } from '@/core/db/helpers';
import { trackChange } from '@/core/sync/sync-service';
import { logAuditOrThrow } from '@/core/audit/audit-log';
import { canonicalRole } from '@/core/models/types';
import { businessDateIssue, businessTimestamp } from '@/core/utils/business-date';
import { postBulkWriteOff, reverseSource } from '@/core/ledger/posting';
import {
  BulkRejected, allocateFils, assertFils, assertWeightMg, checkComposition, compositionSumMg, filsOfStoredAmount,
  formatMg, payloadHash, type BulkSaleTaxScheme, type BulkType, type CompositionEntry,
} from './bulk-math';
import type { BulkMetal } from './bulk-product';

export type BulkLotStatus = 'ACTIVE' | 'EXHAUSTED' | 'CLOSED' | 'CANCELLED';
export type BulkMovementKind =
  | 'PURCHASE' | 'WEIGHT_CORRECTION' | 'PURCHASE_CANCEL'
  | 'SALE' | 'SALE_REVERSAL' | 'RETURN' | 'RETURN_CANCEL'
  | 'WRITE_OFF' | 'CLOSE' | 'ADJUSTMENT_REVERSAL';

export interface BulkLot {
  id: string;
  branchId: string;
  productId: string;
  purchaseId: string | null;
  purchaseLineId: string | null;
  lotNo: string;
  metal: BulkMetal;
  fineness: string;
  originalWeightMg: number;
  remainingWeightMg: number;
  originalValueFils: number;
  remainingValueFils: number;
  saleTaxScheme: BulkSaleTaxScheme;
  composition: CompositionEntry[];
  status: BulkLotStatus;
  closedAt: string | null;
  revision: number;
  acquiredAt: string;
  createdAt: string;
}

export interface BulkMovement {
  id: string;
  lotId: string;
  seq: number;
  kind: BulkMovementKind;
  weightMg: number;
  valueFils: number;
  weightAfterMg: number;
  valueAfterFils: number;
  sourceModule: string;
  sourceId: string;
  sourceLineId: string | null;
  actionId: string | null;
  reversesMovementId: string | null;
  bulkType: string | null;
  reason: string | null;
  businessDate: string;
  createdBy: string;
  createdAt: string;
}

/** Wer handelt, wo, wann — alle Hausfunktionen bekommen das vom Anschluss (nie aus dem Rumpf). */
export interface BulkCtx { branchId: string; userId: string; now: string; role?: string }

function int(v: unknown): number { return Number(v ?? 0) || 0; }

export function lotFromRow(r: Record<string, unknown>): BulkLot {
  let composition: CompositionEntry[] = [];
  try { composition = r.composition_json ? JSON.parse(String(r.composition_json)) as CompositionEntry[] : []; } catch { composition = []; }
  return {
    id: String(r.id),
    branchId: String(r.branch_id),
    productId: String(r.product_id),
    purchaseId: (r.purchase_id as string) || null,
    purchaseLineId: (r.purchase_line_id as string) || null,
    lotNo: String(r.lot_no ?? ''),
    metal: String(r.metal_type ?? '') as BulkMetal,
    fineness: String(r.fineness ?? ''),
    originalWeightMg: int(r.original_weight_mg),
    remainingWeightMg: int(r.remaining_weight_mg),
    originalValueFils: int(r.original_value_fils),
    remainingValueFils: int(r.remaining_value_fils),
    saleTaxScheme: String(r.sale_tax_scheme ?? 'MARGIN') as BulkSaleTaxScheme,
    composition,
    status: String(r.status ?? 'ACTIVE') as BulkLotStatus,
    closedAt: (r.closed_at as string) || null,
    revision: int(r.revision),
    acquiredAt: String(r.acquired_at ?? ''),
    createdAt: String(r.created_at ?? ''),
  };
}

export function movementFromRow(r: Record<string, unknown>): BulkMovement {
  return {
    id: String(r.id), lotId: String(r.lot_id), seq: int(r.seq), kind: String(r.kind) as BulkMovementKind,
    weightMg: int(r.weight_mg), valueFils: int(r.value_fils), weightAfterMg: int(r.weight_after_mg), valueAfterFils: int(r.value_after_fils),
    sourceModule: String(r.source_module), sourceId: String(r.source_id), sourceLineId: (r.source_line_id as string) || null,
    actionId: (r.action_id as string) || null, reversesMovementId: (r.reverses_movement_id as string) || null,
    bulkType: (r.bulk_type as string) || null, reason: (r.reason as string) || null,
    businessDate: String(r.business_date ?? ''), createdBy: String(r.created_by ?? ''), createdAt: String(r.created_at ?? ''),
  };
}

/** Ein Bulk-Lot (nur `unit = 'mg'`). */
export function getBulkLot(lotId: string): BulkLot | null {
  const r = query(`SELECT * FROM stock_lots WHERE id = ? AND unit = 'mg'`, [lotId])[0];
  return r ? lotFromRow(r) : null;
}

export function isBulkLot(lotId: string | null | undefined): boolean {
  if (!lotId) return false;
  return !!query(`SELECT 1 FROM stock_lots WHERE id = ? AND unit = 'mg'`, [lotId])[0];
}

export function movementsOf(lotId: string): BulkMovement[] {
  return query('SELECT * FROM bulk_lot_movements WHERE lot_id = ? ORDER BY seq ASC', [lotId]).map(movementFromRow);
}

function lotInBranch(lotId: string, branchId: string): BulkLot {
  const lot = getBulkLot(lotId);
  if (!lot || lot.branchId !== branchId) throw new BulkRejected('BULK_LOT_NOT_FOUND', 'no such bulk lot in this branch');
  return lot;
}

// ── Lot-Nummer BM-0001 je Filiale (2.8) ─────────────────────────────────────

const LOT_NO = (n: number): string => `BM-${String(n).padStart(4, '0')}`;

/** In der Transaktion des Einkaufs: max(Zähler, größte vorhandene + 1), belegte überspringen. */
export function allocateBulkLotNo(branchId: string, now: string): string {
  const db = getDatabase();
  const n0 = int(query('SELECT next_number FROM bulk_lot_sequences WHERE branch_id = ?', [branchId])[0]?.next_number) || 1;
  const n1 = int(query(
    `SELECT MAX(CAST(SUBSTR(lot_no, 4) AS INTEGER)) AS m FROM stock_lots WHERE branch_id = ? AND lot_no LIKE 'BM-%'`,
    [branchId],
  )[0]?.m) + 1;
  let n = Math.max(n0, n1, 1);
  while (query('SELECT 1 FROM stock_lots WHERE branch_id = ? AND lot_no = ?', [branchId, LOT_NO(n)])[0]) n++;
  db.run(
    `INSERT INTO bulk_lot_sequences (branch_id, next_number, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(branch_id) DO UPDATE SET next_number = excluded.next_number, updated_at = excluded.updated_at`,
    [branchId, n + 1, now],
  );
  return LOT_NO(n);
}

// ── Bewegungen ──────────────────────────────────────────────────────────────

interface MovementInput {
  lot: BulkLot;
  kind: BulkMovementKind;
  weightMg: number;
  valueFils: number;
  weightAfterMg: number;
  valueAfterFils: number;
  sourceModule: string;
  sourceId: string;
  sourceLineId?: string | null;
  actionId?: string | null;
  payloadHash?: string | null;
  resultJson?: string | null;
  reversesMovementId?: string | null;
  bulkType?: string | null;
  reason?: string | null;
  businessDate: string;
  ctx: BulkCtx;
}

function nextSeq(lotId: string): number {
  return int(query('SELECT MAX(seq) AS m FROM bulk_lot_movements WHERE lot_id = ?', [lotId])[0]?.m) + 1;
}

function insertMovement(m: MovementInput, seq: number = nextSeq(m.lot.id)): string {
  const id = uuid();
  getDatabase().run(
    `INSERT INTO bulk_lot_movements (id, branch_id, lot_id, seq, kind, weight_mg, value_fils, weight_after_mg, value_after_fils,
       source_module, source_id, source_line_id, action_id, payload_hash, result_json, reverses_movement_id, bulk_type, reason,
       business_date, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, m.lot.branchId, m.lot.id, seq, m.kind, m.weightMg, m.valueFils, m.weightAfterMg, m.valueAfterFils,
      m.sourceModule, m.sourceId, m.sourceLineId ?? null, m.actionId ?? null, m.payloadHash ?? null, m.resultJson ?? null,
      m.reversesMovementId ?? null, m.bulkType ?? null, m.reason ?? null, m.businessDate, m.ctx.userId || 'system', m.ctx.now],
  );
  trackChange('bulk_lot_movements', id, 'insert', {});
  return id;
}

function writeLotState(lot: BulkLot, next: {
  remainingWeightMg: number; remainingValueFils: number; status: BulkLotStatus; closedAt: string | null;
  originalWeightMg?: number; composition?: CompositionEntry[];
}, now: string): void {
  getDatabase().run(
    `UPDATE stock_lots SET remaining_weight_mg = ?, remaining_value_fils = ?, status = ?, closed_at = ?,
       original_weight_mg = ?, composition_json = ?, updated_at = ? WHERE id = ?`,
    [next.remainingWeightMg, next.remainingValueFils, next.status, next.closedAt,
      next.originalWeightMg ?? lot.originalWeightMg, JSON.stringify(next.composition ?? lot.composition), now, lot.id],
  );
  trackChange('stock_lots', lot.id, 'update', {});
}

const todayOf = (now: string): string => now.slice(0, 10);

// ── Anlegen (Einkauf, 6.3) ──────────────────────────────────────────────────

export interface CreateBulkLotInput {
  productId: string;
  purchaseId: string;
  purchaseLineId: string;
  acquiredAt: string;
  metal: BulkMetal;
  fineness: string;
  weightMg: number;
  valueFils: number;
  saleTaxScheme: BulkSaleTaxScheme;
  composition: CompositionEntry[];
}

export function createBulkLotForPurchaseLine(input: CreateBulkLotInput, ctx: BulkCtx): string {
  assertWeightMg(input.weightMg);
  assertFils(input.valueFils, 'lot value');
  if (compositionSumMg(input.composition) > input.weightMg) {
    throw new BulkRejected('BULK_COMPOSITION_EXCEEDS_WEIGHT', 'composition exceeds the lot weight');
  }
  const id = uuid();
  const lotNo = allocateBulkLotNo(ctx.branchId, ctx.now);
  getDatabase().run(
    `INSERT INTO stock_lots (id, branch_id, product_id, purchase_id, purchase_line_id, unit_cost, qty_total, qty_remaining,
       status, acquired_at, created_at, unit, lot_no, metal_type, fineness, original_weight_mg, remaining_weight_mg,
       original_value_fils, remaining_value_fils, sale_tax_scheme, composition_json, closed_at, revision, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, 0, 0, 'ACTIVE', ?, ?, 'mg', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?)`,
    [id, ctx.branchId, input.productId, input.purchaseId, input.purchaseLineId, input.acquiredAt, ctx.now, lotNo,
      input.metal, input.fineness, input.weightMg, input.weightMg, input.valueFils, input.valueFils, input.saleTaxScheme,
      JSON.stringify(input.composition), ctx.now],
  );
  trackChange('stock_lots', id, 'insert', {});
  const lot = getBulkLot(id)!;
  insertMovement({
    lot, kind: 'PURCHASE', weightMg: input.weightMg, valueFils: input.valueFils,
    weightAfterMg: input.weightMg, valueAfterFils: input.valueFils,
    sourceModule: 'PURCHASE', sourceId: input.purchaseId, sourceLineId: input.purchaseLineId,
    businessDate: input.acquiredAt, ctx,
  }, 1);
  assertBulkLotInvariants(id);
  return id;
}

// ── Verkauf / Rückgabe / Wieder-Entnahme (7.3, 8, 9) ────────────────────────

export interface BulkSource { module: string; id: string; lineId: string }

/** Voraus-Rechnung für mehrere Entnahmen einer Rechnung (gleiches Lot nacheinander). */
export function planBulkTakes(takes: Array<{ lotId: string; weightMg: number }>, branchId: string): number[] {
  const state = new Map<string, { w: number; v: number }>();
  return takes.map((t) => {
    let s = state.get(t.lotId);
    if (!s) {
      const lot = lotInBranch(t.lotId, branchId);
      if (lot.status !== 'ACTIVE' || lot.remainingWeightMg <= 0) {
        throw new BulkRejected('BULK_LOT_NOT_ACTIVE', `bulk lot ${lot.lotNo} has no remaining weight`);
      }
      s = { w: lot.remainingWeightMg, v: lot.remainingValueFils };
      state.set(t.lotId, s);
    }
    assertWeightMg(t.weightMg);
    if (t.weightMg > s.w) throw new BulkRejected('BULK_WEIGHT_EXCEEDS_REMAINING', `only ${formatMg(s.w)} g left in this lot`);
    const cogs = allocateFils(s.v, s.w, t.weightMg);
    s.w -= t.weightMg; s.v -= cogs;
    return cogs;
  });
}

/** Entnahme für eine Rechnungszeile. `expectedCogsFils` = der schon auf der Zeile stehende Snapshot. */
export function consumeBulk(args: {
  lotId: string; weightMg: number; source: BulkSource; bulkType: BulkType; expectedCogsFils?: number; businessDate?: string;
}, ctx: BulkCtx): { cogsFils: number } {
  const lot = lotInBranch(args.lotId, ctx.branchId);
  assertWeightMg(args.weightMg);
  if (lot.status !== 'ACTIVE' || lot.remainingWeightMg <= 0) {
    throw new BulkRejected('BULK_LOT_NOT_ACTIVE', `bulk lot ${lot.lotNo} has no remaining weight`);
  }
  if (args.weightMg > lot.remainingWeightMg) {
    throw new BulkRejected('BULK_WEIGHT_EXCEEDS_REMAINING', `only ${formatMg(lot.remainingWeightMg)} g left in lot ${lot.lotNo}`);
  }
  const cogs = allocateFils(lot.remainingValueFils, lot.remainingWeightMg, args.weightMg);
  if (args.expectedCogsFils !== undefined && cogs !== args.expectedCogsFils) {
    throw new BulkRejected('BULK_INVARIANT_VIOLATED', `allocated COGS ${cogs} differs from the line snapshot ${args.expectedCogsFils}`);
  }
  const w = lot.remainingWeightMg - args.weightMg;
  const v = lot.remainingValueFils - cogs;
  writeLotState(lot, { remainingWeightMg: w, remainingValueFils: v, status: w === 0 ? 'EXHAUSTED' : 'ACTIVE', closedAt: null }, ctx.now);
  insertMovement({
    lot, kind: 'SALE', weightMg: -args.weightMg, valueFils: -cogs, weightAfterMg: w, valueAfterFils: v,
    sourceModule: args.source.module, sourceId: args.source.id, sourceLineId: args.source.lineId,
    bulkType: args.bulkType, businessDate: args.businessDate || todayOf(ctx.now), ctx,
  });
  assertBulkLotInvariants(lot.id);
  return { cogsFils: cogs };
}

/** Exakte Rückgabe der gespeicherten Werte einer Zeile (Entfernen, Storno, Löschen, Retoure). */
export function restoreBulk(args: {
  lotId: string; weightMg: number; valueFils: number; kind: 'SALE_REVERSAL' | 'RETURN'; source: BulkSource; bulkType?: string | null;
}, ctx: BulkCtx): void {
  const lot = getBulkLot(args.lotId);
  if (!lot) throw new BulkRejected('BULK_LOT_NOT_FOUND', 'the bulk lot of this line does not exist');
  if (lot.status === 'CANCELLED') throw new BulkRejected('BULK_INVARIANT_VIOLATED', `bulk lot ${lot.lotNo} is cancelled`);
  assertWeightMg(args.weightMg);
  assertFils(args.valueFils, 'line COGS', true);
  const w = lot.remainingWeightMg + args.weightMg;
  const v = lot.remainingValueFils + args.valueFils;
  writeLotState(lot, { remainingWeightMg: w, remainingValueFils: v, status: 'ACTIVE', closedAt: null }, ctx.now);
  insertMovement({
    lot, kind: args.kind, weightMg: args.weightMg, valueFils: args.valueFils, weightAfterMg: w, valueAfterFils: v,
    sourceModule: args.source.module, sourceId: args.source.id, sourceLineId: args.source.lineId,
    bulkType: args.bulkType ?? null, businessDate: todayOf(ctx.now), ctx,
  });
  assertBulkLotInvariants(lot.id);
}

/** Darf eine Retoure storniert werden? (4.4) — rein lesend, für die Vorprüfung. */
export function bulkRetakeIssue(lotId: string, weightMg: number, valueFils: number): string | null {
  const lot = getBulkLot(lotId);
  if (!lot || lot.status === 'CANCELLED') return 'the bulk lot is gone';
  const w = lot.remainingWeightMg - weightMg;
  const v = lot.remainingValueFils - valueFils;
  if (w < 0 || v < 0 || (w === 0 && v !== 0)) return `the returned ${formatMg(weightMg)} g were sold again from lot ${lot.lotNo}`;
  return null;
}

/** Retoure stornieren: exakt dieselben mg/Fils wieder heraus. */
export function retakeBulk(args: {
  lotId: string; weightMg: number; valueFils: number; source: BulkSource; bulkType?: string | null;
}, ctx: BulkCtx): void {
  const issue = bulkRetakeIssue(args.lotId, args.weightMg, args.valueFils);
  if (issue) throw new BulkRejected('RETURN_STOCK_RESOLD', issue);
  const lot = getBulkLot(args.lotId)!;
  const w = lot.remainingWeightMg - args.weightMg;
  const v = lot.remainingValueFils - args.valueFils;
  writeLotState(lot, { remainingWeightMg: w, remainingValueFils: v, status: w === 0 ? 'EXHAUSTED' : 'ACTIVE', closedAt: null }, ctx.now);
  insertMovement({
    lot, kind: 'RETURN_CANCEL', weightMg: -args.weightMg, valueFils: -args.valueFils, weightAfterMg: w, valueAfterFils: v,
    sourceModule: args.source.module, sourceId: args.source.id, sourceLineId: args.source.lineId,
    bulkType: args.bulkType ?? null, businessDate: todayOf(ctx.now), ctx,
  });
  assertBulkLotInvariants(lot.id);
}

// ── Einkauf stornieren (6.5) ────────────────────────────────────────────────

const UNUSED_KINDS: readonly string[] = ['PURCHASE', 'WEIGHT_CORRECTION'];

export function isBulkLotUnused(lotId: string): boolean {
  return movementsOf(lotId).every((m) => UNUSED_KINDS.includes(m.kind));
}

/** Vor dem Storno eines Einkaufs: jedes Bulk-Lot muss unbenutzt sein. */
export function assertBulkLotsOfPurchaseUnused(purchaseId: string): void {
  for (const r of query(`SELECT id, lot_no FROM stock_lots WHERE purchase_id = ? AND unit = 'mg' AND status != 'CANCELLED'`, [purchaseId])) {
    if (!isBulkLotUnused(String(r.id))) {
      throw new BulkRejected('BULK_LOT_IN_USE', `bulk lot ${String(r.lot_no)} has already been sold from or adjusted — the purchase cannot be cancelled`);
    }
  }
}

/** Einkauf storniert: Bewegung PURCHASE_CANCEL, Lot CANCELLED (Buchung macht `postPurchaseCancelled`). */
export function cancelBulkLotsOfPurchase(purchaseId: string, ctx: BulkCtx): void {
  assertBulkLotsOfPurchaseUnused(purchaseId);
  for (const r of query(`SELECT * FROM stock_lots WHERE purchase_id = ? AND unit = 'mg' AND status != 'CANCELLED'`, [purchaseId])) {
    const lot = lotFromRow(r);
    writeLotState(lot, { remainingWeightMg: 0, remainingValueFils: 0, status: 'CANCELLED', closedAt: null }, ctx.now);
    insertMovement({
      lot, kind: 'PURCHASE_CANCEL', weightMg: -lot.remainingWeightMg, valueFils: -lot.remainingValueFils,
      weightAfterMg: 0, valueAfterFils: 0, sourceModule: 'PURCHASE', sourceId: purchaseId, sourceLineId: lot.purchaseLineId,
      businessDate: todayOf(ctx.now), ctx,
    });
    assertBulkLotInvariants(lot.id);
  }
}

// ── Manuelle Aktionen mit action_id und Replay (13.6) ───────────────────────

export interface BulkActionResult {
  movementId: string;
  seq: number;
  kind: BulkMovementKind;
  weightMg: number;
  valueFils: number;
  lot: { id: string; lotNo: string; remainingWeightMg: number; remainingValueFils: number; status: BulkLotStatus; revision: number; originalWeightMg: number };
  compositionBefore?: CompositionEntry[];
  compositionAfter?: CompositionEntry[];
}

function assertActionId(v: unknown): string {
  if (typeof v !== 'string' || v.trim().length < 8 || v.length > 100) {
    throw new BulkRejected('BULK_ACTION_ID_REQUIRED', 'a stable action id is required for this action');
  }
  return v.trim();
}

function assertReason(v: unknown): string {
  const r = typeof v === 'string' ? v.trim() : '';
  if (!r) throw new BulkRejected('BULK_REASON_REQUIRED', 'please enter a reason');
  return r;
}

function assertRole(ctx: BulkCtx, need: 'adjust' | 'owner'): void {
  const role = canonicalRole(ctx.role);
  const ok = need === 'owner' ? role === 'ADMIN' : role === 'ADMIN' || role === 'MANAGER';
  if (!ok) throw new BulkRejected('PERMISSION_DENIED', need === 'owner' ? 'only the owner (admin) may do this' : 'only admin or manager may adjust bulk lots');
}

/** Schritt 2 des Replays: eine schon vorhandene Bewegung dieser action_id → dieselbe Antwort. */
function replayOf(ctx: BulkCtx, actionId: string, hash: string): BulkActionResult | null {
  const r = query('SELECT payload_hash, result_json FROM bulk_lot_movements WHERE branch_id = ? AND action_id = ?', [ctx.branchId, actionId])[0];
  if (!r) return null;
  if (String(r.payload_hash) !== hash) {
    throw new BulkRejected('BULK_ACTION_ID_CONFLICT', 'this action id was already used for a different input');
  }
  return JSON.parse(String(r.result_json)) as BulkActionResult;
}

function assertRevision(lot: BulkLot, expected: unknown): void {
  if (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected !== lot.revision) {
    throw new BulkRejected('BULK_LOT_REVISION_CHANGED', `bulk lot ${lot.lotNo} was changed meanwhile — reload and try again`);
  }
}

function businessDateOf(v: unknown, now: string): string {
  const d = v === undefined || v === null || v === '' ? todayOf(now) : v;
  const issue = businessDateIssue(d, 'Business date');
  if (issue) throw new BulkRejected('INVALID_DATE', issue);
  return String(d);
}

function resultFor(lotId: string, movementId: string, seq: number, kind: BulkMovementKind, weightMg: number, valueFils: number,
  extra: Partial<BulkActionResult> = {}): BulkActionResult {
  const lot = getBulkLot(lotId)!;
  return {
    movementId, seq, kind, weightMg, valueFils,
    lot: { id: lot.id, lotNo: lot.lotNo, remainingWeightMg: lot.remainingWeightMg, remainingValueFils: lot.remainingValueFils,
      status: lot.status, revision: lot.revision, originalWeightMg: lot.originalWeightMg },
    ...extra,
  };
}

/** Mutation einer manuellen Aktion: Lotstand, dann Bewegung mit eingefrorener Antwort. */
function recordManual(m: Omit<MovementInput, 'payloadHash' | 'resultJson'> & { hash: string; extra?: Partial<BulkActionResult> },
  state: Parameters<typeof writeLotState>[1]): BulkActionResult {
  writeLotState(m.lot, state, m.ctx.now);
  const seq = nextSeq(m.lot.id);
  const movementId = uuid();
  const result = resultFor(m.lot.id, movementId, seq, m.kind, m.weightMg, m.valueFils, m.extra);
  getDatabase().run(
    `INSERT INTO bulk_lot_movements (id, branch_id, lot_id, seq, kind, weight_mg, value_fils, weight_after_mg, value_after_fils,
       source_module, source_id, source_line_id, action_id, payload_hash, result_json, reverses_movement_id, bulk_type, reason,
       business_date, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'STOCK_ADJUST', ?, NULL, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    [movementId, m.lot.branchId, m.lot.id, seq, m.kind, m.weightMg, m.valueFils, m.weightAfterMg, m.valueAfterFils,
      m.actionId, m.actionId, m.hash, JSON.stringify(result), m.reversesMovementId ?? null, m.reason ?? null,
      m.businessDate, m.ctx.userId || 'system', m.ctx.now],
  );
  trackChange('bulk_lot_movements', movementId, 'insert', {});
  logAuditOrThrow({
    module: 'BulkMetals', entityType: 'stock_lots', entityId: m.lot.id,
    action: m.kind === 'WEIGHT_CORRECTION' ? 'UPDATE' : 'STATUS_CHANGE', field: m.kind.toLowerCase(),
    newValue: { kind: m.kind, lotNo: m.lot.lotNo, weightMg: m.weightMg, valueFils: m.valueFils, reason: m.reason, actionId: m.actionId,
      ...(m.reversesMovementId ? { reversesMovementId: m.reversesMovementId } : {}) },
    actor: { userId: m.ctx.userId, branchId: m.ctx.branchId },
  });
  return result;
}

export interface WriteOffInput { actionId: string; lotId: string; expectedRevision: number; weightMg: number; reason: string; businessDate?: string }
export interface CloseLotInput { actionId: string; lotId: string; expectedRevision: number; confirmWeightMg: number; confirmValueFils: number; reason: string; businessDate?: string }
export interface CorrectLotInput { actionId: string; lotId: string; expectedRevision: number; newWeightMg: number; composition: unknown; reason: string }
export interface ReverseAdjustmentInput { actionId: string; lotId: string; expectedRevision: number; movementId: string; reason: string }

function adjust(kind: 'WRITE_OFF' | 'CLOSE', lot: BulkLot, takeMg: number, value: number, actionId: string, hash: string,
  reason: string, businessDate: string, ctx: BulkCtx): BulkActionResult {
  const w = lot.remainingWeightMg - takeMg;
  const v = lot.remainingValueFils - value;
  const closing = kind === 'CLOSE';
  const result = recordManual({
    lot, kind, weightMg: -takeMg, valueFils: -value, weightAfterMg: w, valueAfterFils: v, sourceModule: 'STOCK_ADJUST',
    sourceId: actionId, actionId, hash, reason, businessDate, ctx,
  }, { remainingWeightMg: w, remainingValueFils: v, status: closing ? 'CLOSED' : 'ACTIVE', closedAt: closing ? ctx.now : null });
  if (value > 0) {
    postBulkWriteOff({
      actionId, lotId: lot.id, lotNo: lot.lotNo, weightMg: takeMg, valueFils: value, reason, kind,
      occurredAt: businessTimestamp(businessDate, ctx.now), branchId: ctx.branchId, userId: ctx.userId,
    });
  }
  assertBulkLotInvariants(lot.id);
  return result;
}

/** Write off X g (Teil-Schwund). X = Rest wird als Close ausgeführt. */
export function writeOffInHouse(raw: WriteOffInput, ctx: BulkCtx): BulkActionResult {
  const actionId = assertActionId(raw.actionId);
  const weightMg = assertWeightMg(raw.weightMg);
  const reason = assertReason(raw.reason);
  const businessDate = businessDateOf(raw.businessDate, ctx.now);
  const hash = payloadHash({ op: 'write_off', lotId: raw.lotId, weightMg, reason, businessDate });
  const replay = replayOf(ctx, actionId, hash);
  if (replay) return replay;
  assertRole(ctx, 'adjust');
  const lot = lotInBranch(raw.lotId, ctx.branchId);
  assertRevision(lot, raw.expectedRevision);
  if (lot.status !== 'ACTIVE' || lot.remainingWeightMg <= 0) throw new BulkRejected('BULK_LOT_NOT_ACTIVE', `bulk lot ${lot.lotNo} has no remaining weight`);
  if (weightMg > lot.remainingWeightMg) throw new BulkRejected('BULK_WEIGHT_EXCEEDS_REMAINING', `only ${formatMg(lot.remainingWeightMg)} g left in lot ${lot.lotNo}`);
  if (weightMg === lot.remainingWeightMg) {
    return adjust('CLOSE', lot, weightMg, lot.remainingValueFils, actionId, hash, reason, businessDate, ctx);
  }
  return adjust('WRITE_OFF', lot, weightMg, allocateFils(lot.remainingValueFils, lot.remainingWeightMg, weightMg), actionId, hash, reason, businessDate, ctx);
}

/** Close Lot / Write off remaining stock. */
export function closeLotInHouse(raw: CloseLotInput, ctx: BulkCtx): BulkActionResult {
  const actionId = assertActionId(raw.actionId);
  const reason = assertReason(raw.reason);
  const businessDate = businessDateOf(raw.businessDate, ctx.now);
  const confirmWeightMg = assertWeightMg(raw.confirmWeightMg, 'confirmed remaining weight');
  const confirmValueFils = assertFils(raw.confirmValueFils, 'confirmed remaining value', true);
  const hash = payloadHash({ op: 'close_lot', lotId: raw.lotId, confirmWeightMg, confirmValueFils, reason, businessDate });
  const replay = replayOf(ctx, actionId, hash);
  if (replay) return replay;
  assertRole(ctx, 'adjust');
  const lot = lotInBranch(raw.lotId, ctx.branchId);
  assertRevision(lot, raw.expectedRevision);
  if (lot.status !== 'ACTIVE' || lot.remainingWeightMg <= 0) throw new BulkRejected('BULK_LOT_NOT_ACTIVE', `bulk lot ${lot.lotNo} has no remaining weight`);
  if (confirmWeightMg !== lot.remainingWeightMg || confirmValueFils !== lot.remainingValueFils) {
    throw new BulkRejected('BULK_CLOSE_STALE', `the remaining stock of lot ${lot.lotNo} changed — reload before closing`);
  }
  return adjust('CLOSE', lot, lot.remainingWeightMg, lot.remainingValueFils, actionId, hash, reason, businessDate, ctx);
}

/** Lot korrigieren (Gewicht und/oder Composition) — nur unbenutzt, nie skalieren. */
export function correctLotInHouse(raw: CorrectLotInput, ctx: BulkCtx): BulkActionResult {
  const actionId = assertActionId(raw.actionId);
  const newWeightMg = assertWeightMg(raw.newWeightMg, 'new weight');
  const reason = assertReason(raw.reason);
  const composition = checkComposition(raw.composition, newWeightMg);
  const hash = payloadHash({ op: 'correct_weight', lotId: raw.lotId, newWeightMg, composition, reason });
  const replay = replayOf(ctx, actionId, hash);
  if (replay) return replay;
  assertRole(ctx, 'adjust');
  const lot = lotInBranch(raw.lotId, ctx.branchId);
  assertRevision(lot, raw.expectedRevision);
  if (lot.status !== 'ACTIVE' || !isBulkLotUnused(lot.id)) {
    throw new BulkRejected('BULK_LOT_IN_USE', `bulk lot ${lot.lotNo} has already been used — only a write-off can reduce it now`);
  }
  const delta = newWeightMg - lot.originalWeightMg;
  if (delta === 0 && JSON.stringify(composition) === JSON.stringify(lot.composition)) {
    throw new BulkRejected('BULK_NOTHING_TO_CORRECT', 'weight and composition are unchanged');
  }
  const result = recordManual({
    lot, kind: 'WEIGHT_CORRECTION', weightMg: delta, valueFils: 0, weightAfterMg: newWeightMg, valueAfterFils: lot.remainingValueFils,
    sourceModule: 'STOCK_ADJUST', sourceId: actionId, actionId, hash, reason, businessDate: todayOf(ctx.now), ctx,
    extra: { compositionBefore: lot.composition, compositionAfter: composition },
  }, { remainingWeightMg: newWeightMg, remainingValueFils: lot.remainingValueFils, status: 'ACTIVE', closedAt: null,
    originalWeightMg: newWeightMg, composition });
  assertBulkLotInvariants(lot.id);
  return result;
}

/** Abschreibung stornieren — nur ADMIN, nur die letzte Bewegung des Lots, nur WRITE_OFF oder CLOSE. */
export function reverseAdjustmentInHouse(raw: ReverseAdjustmentInput, ctx: BulkCtx): BulkActionResult {
  const actionId = assertActionId(raw.actionId);
  const reason = assertReason(raw.reason);
  if (typeof raw.movementId !== 'string' || !raw.movementId) throw new BulkRejected('BULK_REVERSAL_NOT_LAST', 'name the write-off to reverse');
  const hash = payloadHash({ op: 'reverse_adjustment', lotId: raw.lotId, movementId: raw.movementId, reason });
  const replay = replayOf(ctx, actionId, hash);
  if (replay) return replay;
  assertRole(ctx, 'owner');
  const lot = lotInBranch(raw.lotId, ctx.branchId);
  assertRevision(lot, raw.expectedRevision);
  const moves = movementsOf(lot.id);
  const last = moves[moves.length - 1];
  if (!last || last.id !== raw.movementId || (last.kind !== 'WRITE_OFF' && last.kind !== 'CLOSE')) {
    throw new BulkRejected('BULK_REVERSAL_NOT_LAST', 'only the latest movement of a lot can be reversed, and only a write-off or a close');
  }
  if (query('SELECT 1 FROM bulk_lot_movements WHERE reverses_movement_id = ?', [last.id])[0]) {
    throw new BulkRejected('BULK_REVERSAL_NOT_LAST', 'this write-off was already reversed');
  }
  const w = lot.remainingWeightMg - last.weightMg;   // weight_mg der Abschreibung ist negativ
  const v = lot.remainingValueFils - last.valueFils;
  const result = recordManual({
    lot, kind: 'ADJUSTMENT_REVERSAL', weightMg: -last.weightMg, valueFils: -last.valueFils, weightAfterMg: w, valueAfterFils: v,
    sourceModule: 'STOCK_ADJUST', sourceId: actionId, actionId, hash, reversesMovementId: last.id, reason,
    businessDate: todayOf(ctx.now), ctx,
  }, { remainingWeightMg: w, remainingValueFils: v, status: 'ACTIVE', closedAt: null });
  if (last.valueFils !== 0) reverseSource('STOCK_ADJUST', last.sourceId, ctx.now);
  assertBulkLotInvariants(lot.id);
  return result;
}

// ── Invarianten (Kapitel 5) ─────────────────────────────────────────────────

export function assertBulkLotInvariants(lotId: string): void {
  const fail = (what: string): never => { throw new BulkRejected('BULK_INVARIANT_VIOLATED', `bulk lot invariant: ${what}`); };
  const r = query('SELECT * FROM stock_lots WHERE id = ?', [lotId])[0];
  if (!r || String(r.unit) !== 'mg') fail('not a bulk lot');
  const lot = lotFromRow(r!);
  if (int(r!.qty_total) !== 0 || int(r!.qty_remaining) !== 0 || Number(r!.unit_cost) !== 0) fail('piece fields must stay 0');
  if (lot.remainingWeightMg < 0 || lot.remainingValueFils < 0) fail('negative remaining stock');
  if (lot.remainingWeightMg === 0 && lot.remainingValueFils !== 0) fail('weight 0 but value left');
  const moves = movementsOf(lotId);
  let w = 0, v = 0, corr = 0;
  moves.forEach((m, i) => {
    if (m.seq !== i + 1) fail('movement sequence has a gap');
    w += m.weightMg; v += m.valueFils;
    if (m.weightAfterMg !== w || m.valueAfterFils !== v) fail(`movement ${m.seq} does not add up`);
    if (m.kind === 'WEIGHT_CORRECTION') corr += m.weightMg;
  });
  if (w !== lot.remainingWeightMg || v !== lot.remainingValueFils) fail('lot is not the sum of its movements');
  const purchase = moves[0];
  if (!purchase || purchase.kind !== 'PURCHASE') fail('first movement must be the purchase');
  if (purchase!.valueFils !== lot.originalValueFils || purchase!.weightMg + corr !== lot.originalWeightMg) fail('original weight/value');
  if (lot.status === 'CANCELLED') { if (lot.remainingWeightMg !== 0) fail('cancelled lot with stock'); }
  else if ((lot.status === 'ACTIVE') !== (lot.remainingWeightMg > 0)) fail(`status ${lot.status} with ${lot.remainingWeightMg} mg`);
  if ((lot.closedAt !== null) !== (lot.status === 'CLOSED')) fail('closed_at and status disagree');
  if (compositionSumMg(lot.composition) > lot.originalWeightMg) fail('composition exceeds the lot weight');
  for (const l of query(
    `SELECT quantity, purchase_price_snapshot, bulk_cogs_fils, tax_scheme FROM invoice_lines WHERE lot_id = ? AND bulk_weight_mg IS NOT NULL`, [lotId])) {
    if (int(l.quantity) !== 1 || filsOfStoredAmount(Number(l.purchase_price_snapshot) || 0) !== int(l.bulk_cogs_fils)
      || String(l.tax_scheme) !== lot.saleTaxScheme) fail('a bulk invoice line does not match its lot');
  }
}
