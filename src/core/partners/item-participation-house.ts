// ════════════════════════════════════════════════════════════════════════════
// PARTNER-ITEMS — gemeinsamer Einkauf am Haus: Beteiligung anlegen, Geld zwischen Firma und Partner,
// Verkauf abrechnen und nachabrechnen, verrechnen, Lieferantenrückgabe, Übernahme durch LATAIF,
// Partnerwechsel, Storno, und was die Masken lesen.
//
// Entscheidungen (Nutzer, 26./27.09.2026):
//   - Beteiligt sind LATAIF und null, ein oder mehrere Partner des Partner-Moduls. LATAIF kauft beim
//     Lieferanten, bezahlt ihn EINMAL und verkauft wie immer; Einkauf, Lieferantenschuld, Lager,
//     Umsatz, VAT und Wareneinsatz bleiben unverändert.
//   - Alles Geld läuft über LATAIFs Kasse/Bank/Benefit und steht auf einem EIGENEN Ausgleichskonto
//     (PARTNER_ITEM_BALANCE), getrennt vom Gesellschafterkapital.
//   - Verteilt wird mit einer manuellen Schlussabrechnung; spätere Änderungen am Verkauf werden als
//     Nachabrechnung (nur die Differenz) gebucht, nie durch Löschen.
//   - Rückgabe an den Lieferanten: der bestehende Rückgabeweg bucht Lager, Lieferantenschuld,
//     Erstattung und Vorsteuer; hier nur der Partneranteil an (Erstattungswert − Einstand). Eine
//     Auszahlung wartet, solange eine Gutschrift aus der Rückgabe nicht vollständig verwendet ist.
//   - Übernahme durch LATAIF und Partnerwechsel nur für unverkaufte Stücke, nur zum aktuellen
//     Lager-Einstand, ohne Geldbewegung (Ansprüche/Verpflichtungen auf dem Ausgleichskonto; gezahlt
//     wird über „Beitrag"/„Auszahlung"). Kein Lagerzugang, kein Einkauf, keine Neubewertung.
//
// Beteiligungsabschnitte (Epochen): die Anteile einer Einkaufszeile gelten in einem Abschnitt. Eine
// Übernahme oder ein Wechsel beendet ihn (die unverkauften Stücke verlassen ihn zum aktuellen
// Einstand — Gewinnanteil 0) und beginnt ggf. einen neuen. Ein Verkauf gehört über die laufende
// Nummer seiner Rechnungszeile (invoice_lines.rowid) zu genau einem Abschnitt; Verkäufe, die LATAIF
// allein gehörten, haben keinen.
//
// Die Grundlage eines Verkaufs sind die Beträge des ERP für die Rechnungszeile: Netto (Zeilenbetrag −
// VAT) abzüglich wirksamer Retouren, Wareneinsatz aus dem Hauptbuch (COGS der Zeile abzüglich der
// Rückbuchung einer Retoure ins Lager), verkaufte Menge abzüglich der ins Lager zurückgekommenen
// Stücke. Storno oder gelöschte Zeile → alles 0.
//
// Jede Schreibfolge hier läuft in der Transaktion des Aufrufers (Maske: `runOnPrimary`, fern:
// `runRemoteCommand`) — beide exklusiv. Alle Prüfungen lesen INNERHALB dieser Transaktion.
// ════════════════════════════════════════════════════════════════════════════
import { v4 as uuid } from 'uuid';
import { getDatabase } from '@/core/db/database';
import { query } from '@/core/db/helpers';
import { isClientMode } from '@/core/bridge/client-mode';
import type { PurchaseLineParticipation } from '@/core/models/types';
import { hasLedgerEntries, hasReversalFor, postItemPartnerMovement, reverseSource } from '@/core/ledger/posting';
import {
  B, F, FULL_BP, PartnerItemRejected, itemMovementInput, itemOffsetInput, openBalanceF, owedCostF, ownershipChangeInput,
  planLineParticipation, profitShareF,
  PARTNER_ITEM_JOINT_BLOCKED, PARTNER_ITEM_NOT_FOUND, PARTNER_ITEM_OFFSET_INVALID, PARTNER_ITEM_OVERFUNDED,
  PARTNER_ITEM_PAYOUT_EXCEEDS_OPEN, PARTNER_ITEM_PRIMARY_ONLY, PARTNER_ITEM_PURCHASE_CANCELLED, PARTNER_MOVEMENT_CANCELLED,
  PARTNER_MOVEMENT_NOT_FOUND, PARTNER_NOT_ACTIVE, PARTNER_OWNERSHIP_BLOCKED, PARTNER_OWNERSHIP_UNCHANGED,
  PARTNER_OWNERSHIP_VALUE_MISMATCH, PARTNER_SALE_ALREADY_SETTLED, PARTNER_SALE_NEEDS_CORRECTION, PARTNER_SALE_NOT_FOUND,
  PARTNER_SALE_NOT_PAID, PARTNER_SALE_OUTSIDE_PARTNERSHIP, PARTNER_SALE_PENDING, PARTNER_SUPPLIER_REFUND_PENDING,
  type ItemMovementInput, type ItemOffsetInput, type OwnershipChangeInput, type PartnerShareInput,
} from './item-participation';

export type { PurchaseLineParticipation } from '@/core/models/types';

export interface PartnerItemCtx {
  readonly branchId: string;
  readonly userId: string;
  readonly now: string;
}

const nein = (code: string, message: string): PartnerItemRejected => new PartnerItemRejected(code, message);
const dayOf = (iso: string): string => iso.split('T')[0];
const bhd = (f: number): string => B(f).toFixed(3);
const EFFECTIVE_RETURN = "('APPROVED','REFUNDED','CLOSED')";
const EPOCH = 'COALESCE(epoch_id, purchase_line_id)';

/** Ein Rechner ohne Geschäftsdatenbank bucht hier nie — die Handlung geht über die Brücke. */
export function assertItemBooksHere(): void {
  if (isClientMode()) throw nein(PARTNER_ITEM_PRIMARY_ONLY, 'this is booked on the main computer — this window has no business database');
}

// ── Beteiligung beim Einkauf ────────────────────────────────────────────────

/** Die Partner, die eine NEUE Beteiligung bekommen dürfen: vorhanden, in dieser Filiale, aktiv. */
export function assertPartnersActive(partnerIds: readonly string[], branchId: string): void {
  for (const id of new Set(partnerIds)) {
    const r = query('SELECT active FROM partners WHERE id = ? AND branch_id = ?', [id, branchId])[0];
    if (!r || Number(r.active) !== 1) throw nein(PARTNER_NOT_ACTIVE, 'this partner is not an active partner of this branch');
  }
}

function insertEpoch(
  ctx: PartnerItemCtx, purchaseId: string, lineId: string, productId: string | null, epochId: string,
  valueF: number, quantity: number, unitCostF: number, fromRowid: number, partnerShares: readonly PartnerShareInput[],
): void {
  const plan = planLineParticipation(partnerShares, valueF);
  assertPartnersActive(plan.filter((p) => p.partnerId).map((p) => p.partnerId as string), ctx.branchId);
  const db = getDatabase();
  for (const p of plan) {
    db.run(
      `INSERT INTO item_participations (id, branch_id, purchase_id, purchase_line_id, product_id, party, partner_id,
         share_bp, cost_share, line_total, quantity, created_at, created_by, epoch_id, from_il_rowid, unit_cost)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuid(), ctx.branchId, purchaseId, lineId, productId, p.party, p.partnerId, p.shareBp, B(p.costShareF),
        B(valueF), quantity, ctx.now, ctx.userId || null, epochId, fromRowid, B(unitCostF)],
    );
  }
}

/**
 * Legt je beteiligter Einkaufszeile LATAIF + Partner mit Anteil und Kostenanteil an (erster Abschnitt).
 * Aufgerufen von `createPurchase` in derselben Transaktion wie Beleg, Zeilen und Lose. Zeilen ohne
 * Partner bleiben genau wie bisher — es entsteht keine Zeile.
 */
export function insertLineParticipations(
  ctx: PartnerItemCtx, purchaseId: string,
  lines: ReadonlyArray<{ lineId: string; productId: string | null; lineTotal: number; quantity: number; partnerShares?: readonly PartnerShareInput[] }>,
): number {
  let n = 0;
  for (const l of lines) {
    if (!l.partnerShares || l.partnerShares.length === 0) continue;
    const qty = Math.max(1, l.quantity || 1);
    insertEpoch(ctx, purchaseId, l.lineId, l.productId, l.lineId, F(l.lineTotal), qty, Math.round(F(l.lineTotal) / qty), 0, l.partnerShares);
    n++;
  }
  return n;
}

// ── Wächter: was ein gemeinsam gekauftes Stück ohne Verkauf aus der Beteiligung nähme ──────────

/** Ist diese Einkaufszeile (irgendwann) gemeinsam gekauft? */
export function isJointPurchaseLine(purchaseLineId: string | null | undefined): boolean {
  if (!purchaseLineId) return false;
  return !!query("SELECT 1 FROM item_participations WHERE purchase_line_id = ? AND party = 'PARTNER' LIMIT 1", [purchaseLineId])[0];
}

/** Gehört dieses Los zu einem Einkauf mit (früherer oder laufender) Partnerbeteiligung? */
export function isJointLot(lotId: string | null | undefined): boolean {
  if (!lotId) return false;
  const r = query('SELECT purchase_line_id FROM stock_lots WHERE id = ?', [lotId])[0];
  return isJointPurchaseLine(r?.purchase_line_id ? String(r.purchase_line_id) : null);
}

/** Die Texte der Sperren — die Hausfolgen werfen sie mit ihrem eigenen Fehlertyp und diesem Code. */
export const JOINT_BLOCK = {
  code: PARTNER_ITEM_JOINT_BLOCKED,
  production: 'this item was bought jointly with a partner — it cannot be used up in production (the partner share would be lost)',
  salesReturnDisposition: 'this item was bought jointly with a partner — "Under repair" would take it out of the partnership. Choose "In stock" (then send it to repair as own stock if needed) or "Write off" (the partner shares the loss).',
} as const;

/** Rechnungszeilen, deren Stück aus einem gemeinsam gekauften Los kam. */
export function jointInvoiceLines(invoiceLineIds: readonly string[]): string[] {
  const out: string[] = [];
  for (const id of invoiceLineIds) {
    const r = query('SELECT lot_id FROM invoice_lines WHERE id = ?', [id])[0];
    if (r && isJointLot(r.lot_id ? String(r.lot_id) : null)) out.push(id);
  }
  return out;
}

// ── Abschnitte ──────────────────────────────────────────────────────────────

interface EpochParty { partnerId: string; shareBp: number; costShareF: number }
interface Epoch {
  key: string;
  purchaseId: string;
  purchaseLineId: string;
  productId: string | null;
  qty: number;
  valueF: number;
  unitCostF: number;
  fromRowid: number;
  toRowid: number | null;
  endedAt: string | null;
  endedReason: string | null;
  houseBp: number;
  parties: EpochParty[];
}

function epochsOf(purchaseLineId: string, branchId: string): Epoch[] {
  const rows = query(
    `SELECT ip.*, ${EPOCH.replace(/epoch_id|purchase_line_id/g, (m) => 'ip.' + m)} AS ek, pl.unit_price
       FROM item_participations ip LEFT JOIN purchase_lines pl ON pl.id = ip.purchase_line_id
      WHERE ip.purchase_line_id = ? AND ip.branch_id = ?
      ORDER BY COALESCE(ip.from_il_rowid, 0), ip.created_at, ip.rowid`,
    [purchaseLineId, branchId],
  );
  const map = new Map<string, Epoch>();
  for (const r of rows) {
    const key = String(r.ek);
    if (!map.has(key)) {
      const qty = Number(r.quantity) || 1;
      map.set(key, {
        key, purchaseId: String(r.purchase_id), purchaseLineId, productId: r.product_id ? String(r.product_id) : null,
        qty, valueF: F(r.line_total),
        unitCostF: r.unit_cost !== null && r.unit_cost !== undefined ? F(r.unit_cost) : F(r.unit_price ?? (Number(r.line_total) / qty)),
        fromRowid: Number(r.from_il_rowid) || 0, toRowid: r.to_il_rowid === null || r.to_il_rowid === undefined ? null : Number(r.to_il_rowid),
        endedAt: r.ended_at ? String(r.ended_at) : null, endedReason: r.ended_reason ? String(r.ended_reason) : null,
        houseBp: 0, parties: [],
      });
    }
    const e = map.get(key)!;
    if (r.party === 'HOUSE') e.houseBp = Number(r.share_bp);
    else e.parties.push({ partnerId: String(r.partner_id), shareBp: Number(r.share_bp), costShareF: F(r.cost_share) });
  }
  return [...map.values()];
}

const maxInvoiceLineRowid = (): number => Number(query('SELECT COALESCE(MAX(rowid), 0) AS m FROM invoice_lines')[0]?.m) || 0;

function purchaseCancelled(purchaseId: string): boolean {
  return String(query('SELECT status FROM purchases WHERE id = ?', [purchaseId])[0]?.status ?? '') === 'CANCELLED';
}

/** Die Stücke der Einkaufszeile, die heute im Lager liegen, samt ihrem Einstand (FIFO über die Lose). */
function stockOf(purchaseLineId: string): Array<{ lotId: string; qty: number; unitCost: number }> {
  return query(
    `SELECT id, qty_remaining, unit_cost FROM stock_lots
      WHERE purchase_line_id = ? AND status != 'CANCELLED' AND qty_remaining > 0 ORDER BY acquired_at, id`,
    [purchaseLineId],
  ).map((r) => ({ lotId: String(r.id), qty: Number(r.qty_remaining) || 0, unitCost: Number(r.unit_cost) || 0 }));
}
const stockQty = (plId: string): number => stockOf(plId).reduce((a, l) => a + l.qty, 0);
/** Der aktuelle Lager-Einstand der ersten `qty` Stücke im Lager. */
function stockValueF(plId: string, qty: number): number {
  let left = qty;
  let f = 0;
  for (const l of stockOf(plId)) {
    const take = Math.min(left, l.qty);
    f += F(take * l.unitCost);
    left -= take;
    if (left <= 0) break;
  }
  return f;
}

// ── Die Grundlage eines Verkaufs ────────────────────────────────────────────

export interface SaleBasis {
  invoiceLineId: string;
  exists: boolean;
  rowid: number;
  invoiceId: string;
  invoiceNumber: string;
  invoiceStatus: string;
  issuedAt: string;
  purchaseLineId: string | null;
  /** Verkaufte Menge, die NICHT ins Lager zurückgekommen ist. */
  qty: number;
  netF: number;
  costF: number;
  profitF: number;
  /** Eine angelegte, noch nicht entschiedene Retoure (REQUESTED) auf der Zeile. */
  pendingReturn: boolean;
}

function ledgerCogsF(invoiceLineId: string, sourceModule: 'INVOICE' | 'SALES_RETURN_COGS', direction: 'DEBIT' | 'CREDIT'): { f: number; rows: number } {
  const r = query(
    `SELECT COALESCE(SUM(e1.amount), 0) AS t, COUNT(*) AS n FROM ledger_entries e1
      WHERE e1.source_module = ? AND e1.account = 'COGS' AND e1.direction = ? AND e1.source_line_id = ?
        AND e1.reverses_entry_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM ledger_entries e2 WHERE e2.reverses_entry_id = e1.id)`,
    [sourceModule, direction, invoiceLineId],
  )[0];
  return { f: F(r?.t), rows: Number(r?.n) || 0 };
}

/** Der Stand eines Verkaufs HEUTE, nach den Regeln des ERP. */
export function saleBasisOf(invoiceLineId: string, branchId: string): SaleBasis {
  const r = query(
    `SELECT il.rowid AS rid, il.id, il.invoice_id, il.line_total, il.vat_amount, il.purchase_price_snapshot, il.quantity,
            i.invoice_number, i.status, COALESCE(i.issued_at, i.created_at) AS issued_at, sl.purchase_line_id
       FROM invoice_lines il
       JOIN invoices i ON i.id = il.invoice_id
       LEFT JOIN stock_lots sl ON sl.id = il.lot_id
      WHERE il.id = ? AND i.branch_id = ?`,
    [invoiceLineId, branchId],
  )[0];
  const zero = { qty: 0, netF: 0, costF: 0, profitF: 0 };
  if (!r) {
    return { invoiceLineId, exists: false, rowid: 0, invoiceId: '', invoiceNumber: '', invoiceStatus: 'MISSING', issuedAt: '',
      purchaseLineId: null, pendingReturn: false, ...zero };
  }
  const base = {
    invoiceLineId, exists: true, rowid: Number(r.rid) || 0, invoiceId: String(r.invoice_id), invoiceNumber: String(r.invoice_number ?? ''),
    invoiceStatus: String(r.status ?? ''), issuedAt: String(r.issued_at ?? ''),
    purchaseLineId: r.purchase_line_id ? String(r.purchase_line_id) : null,
  };
  if (base.invoiceStatus === 'CANCELLED') return { ...base, pendingReturn: false, ...zero };
  const ret = query(
    `SELECT
        COALESCE(SUM(CASE WHEN sr.status != 'REJECTED' AND sr.product_disposition = 'IN_STOCK' THEN srl.quantity ELSE 0 END), 0) AS back_qty,
        COALESCE(SUM(CASE WHEN sr.status IN ${EFFECTIVE_RETURN} THEN srl.line_total - srl.vat_amount ELSE 0 END), 0) AS ret_net,
        COALESCE(SUM(CASE WHEN sr.status = 'REQUESTED' THEN 1 ELSE 0 END), 0) AS pending
       FROM sales_return_lines srl JOIN sales_returns sr ON sr.id = srl.return_id
      WHERE srl.invoice_line_id = ?`,
    [invoiceLineId],
  )[0];
  const lineQty = Math.max(1, Number(r.quantity) || 1);
  const qty = Math.max(0, lineQty - (Number(ret?.back_qty) || 0));
  const netF = F(r.line_total) - F(r.vat_amount) - F(ret?.ret_net);
  const inv = ledgerCogsF(invoiceLineId, 'INVOICE', 'DEBIT');
  const back = ledgerCogsF(invoiceLineId, 'SALES_RETURN_COGS', 'CREDIT');
  // Ohne Wareneinsatz im Hauptbuch (Altzeile) gilt der Einstand der Zeile für die verkaufte Menge.
  const costF = inv.rows > 0 ? inv.f - back.f : F((Number(r.purchase_price_snapshot) || 0) * qty);
  return { ...base, pendingReturn: Number(ret?.pending) > 0, qty, netF, costF, profitF: netF - costF };
}

interface BookedSale {
  bookedF: number;
  latest: { qty: number; netF: number; costF: number } | null;
}

/** Was für diesen Verkauf und Partner gebucht ist (Erstabrechnung + Nachabrechnungen). */
function bookedOf(invoiceLineId: string, partnerId: string): BookedSale {
  const rows = query(
    `SELECT amount, basis_json FROM item_partner_movements
      WHERE invoice_line_id = ? AND partner_id = ? AND kind IN ('PROFIT_SHARE','PROFIT_CORRECTION') AND cancelled_at IS NULL
      ORDER BY rowid`,
    [invoiceLineId, partnerId],
  );
  let bookedF = 0;
  let latest: BookedSale['latest'] = null;
  for (const r of rows) {
    bookedF += F(r.amount);
    try {
      const b = JSON.parse(String(r.basis_json || '{}'));
      latest = { qty: Number(b.qty) || 0, netF: F(b.net), costF: F(b.cost) };
    } catch { /* ohne Grundlage */ }
  }
  return { bookedF, latest: rows.length > 0 ? latest ?? { qty: 0, netF: 0, costF: 0 } : null };
}

const sameBasis = (a: { qty: number; netF: number; costF: number }, b: SaleBasis): boolean =>
  a.qty === b.qty && a.netF === b.netF && a.costF === b.costF;

/** Die Verkaufszeilen EINES Abschnitts — über Los und Zeilennummer, und abgerechnete, die es nicht mehr gibt. */
function saleLinesOfEpoch(e: Epoch, branchId: string): string[] {
  const ids = query(
    `SELECT il.id FROM invoice_lines il
       JOIN stock_lots sl ON sl.id = il.lot_id
       JOIN invoices i ON i.id = il.invoice_id
      WHERE sl.purchase_line_id = ? AND i.branch_id = ? AND il.rowid > ? ${e.toRowid === null ? '' : 'AND il.rowid <= ?'}
      ORDER BY il.rowid`,
    e.toRowid === null ? [e.purchaseLineId, branchId, e.fromRowid] : [e.purchaseLineId, branchId, e.fromRowid, e.toRowid],
  ).map((r) => String(r.id));
  for (const r of query(
    `SELECT DISTINCT invoice_line_id FROM item_partner_movements
      WHERE purchase_line_id = ? AND invoice_line_id IS NOT NULL AND cancelled_at IS NULL
        AND ${EPOCH} = ?`,
    [e.purchaseLineId, e.key],
  )) {
    const id = String(r.invoice_line_id);
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Der Abschnitt, zu dem eine Verkaufszeile gehört (null = LATAIF allein). */
function epochOfSale(basis: SaleBasis, branchId: string): Epoch | null {
  const booked = query(
    `SELECT ${EPOCH} AS ek, purchase_line_id FROM item_partner_movements
      WHERE invoice_line_id = ? AND kind IN ('PROFIT_SHARE','PROFIT_CORRECTION') LIMIT 1`,
    [basis.invoiceLineId],
  )[0];
  const plId = basis.purchaseLineId ?? (booked ? String(booked.purchase_line_id) : null);
  if (!plId) return null;
  const epochs = epochsOf(plId, branchId);
  if (booked) return epochs.find((e) => e.key === String(booked.ek)) ?? null;
  return epochs.find((e) => basis.rowid > e.fromRowid && (e.toRowid === null || basis.rowid <= e.toRowid)) ?? null;
}

type SaleState = 'UNSETTLED' | 'SETTLED' | 'NEEDS_CORRECTION';

/** Warum ein Verkauf (noch) nicht abgerechnet oder nachabgerechnet werden kann — null = er kann. */
function saleBlocker(basis: SaleBasis, settled: boolean): { code: string; message: string } | null {
  if (basis.pendingReturn) {
    return { code: PARTNER_SALE_PENDING, message: `invoice ${basis.invoiceNumber} has a return that is not decided yet — settle after it is approved or rejected` };
  }
  if (!settled) {
    if (!basis.exists || basis.invoiceStatus === 'CANCELLED') {
      return { code: PARTNER_SALE_NOT_FOUND, message: 'this sale no longer exists — there is nothing to settle' };
    }
    if (basis.invoiceStatus !== 'FINAL') {
      return { code: PARTNER_SALE_NOT_PAID, message: `invoice ${basis.invoiceNumber} is not fully paid (${basis.invoiceStatus}) — profit is shared only after full payment` };
    }
    return null;
  }
  if (!basis.exists || basis.invoiceStatus === 'CANCELLED' || basis.invoiceStatus === 'FINAL') return null;
  return { code: PARTNER_SALE_NOT_PAID, message: `invoice ${basis.invoiceNumber} changed and is not fully paid (${basis.invoiceStatus}) — the correction waits for full payment` };
}

// ── Stand eines Abschnitts ──────────────────────────────────────────────────

interface EpochState {
  /** Stücke, die der Abschnitt (für diesen Partner) abgegeben hat: Verkäufe, Lieferantenrückgaben, Übernahme. */
  settledQty: number;
  unsettledQty: number;
  /** Verkauft, aber noch nicht abgerechnet (Stückzahl). */
  unsettledSoldQty: number;
  soldUnsettledCostF: number;
  correctionPending: boolean;
  pendingReturn: boolean;
  refundPending: boolean;
}

/** Ist die Gutschrift aus dieser Lieferantenrückgabe noch nicht vollständig verwendet? */
function supplierRefundOpen(purchaseReturnId: string): boolean {
  return !!query(
    `SELECT 1 FROM supplier_credits WHERE source_return_id = ? AND COALESCE(used_amount, 0) < amount - 0.0005 LIMIT 1`,
    [purchaseReturnId],
  )[0];
}

function epochStateOf(e: Epoch, partnerId: string, branchId: string): EpochState {
  let settledQty = 0;
  let unsettledSoldQty = 0;
  let soldUnsettledCostF = 0;
  let correctionPending = false;
  let pendingReturn = false;
  for (const il of saleLinesOfEpoch(e, branchId)) {
    const basis = saleBasisOf(il, branchId);
    const booked = bookedOf(il, partnerId);
    if (booked.latest) {
      settledQty += booked.latest.qty;
      if (basis.pendingReturn || !sameBasis(booked.latest, basis)) correctionPending = true;
    } else if (basis.exists && basis.invoiceStatus !== 'CANCELLED' && basis.qty > 0) {
      unsettledSoldQty += basis.qty;
      soldUnsettledCostF += basis.costF;
      if (basis.pendingReturn) pendingReturn = true;
    }
  }
  let refundPending = false;
  for (const m of query(
    `SELECT kind, basis_json, purchase_return_id FROM item_partner_movements
      WHERE purchase_line_id = ? AND partner_id = ? AND kind IN ('SUPPLIER_RETURN','TAKEOVER') AND cancelled_at IS NULL AND ${EPOCH} = ?`,
    [e.purchaseLineId, partnerId, e.key],
  )) {
    let q = 0;
    try { q = Number(JSON.parse(String(m.basis_json || '{}')).qty) || 0; } catch { q = 0; }
    settledQty += q;
    if (m.kind === 'SUPPLIER_RETURN' && m.purchase_return_id && supplierRefundOpen(String(m.purchase_return_id))) refundPending = true;
  }
  return {
    settledQty, unsettledQty: Math.max(0, e.qty - settledQty), unsettledSoldQty, soldUnsettledCostF,
    correctionPending, pendingReturn, refundPending,
  };
}

export interface LineState {
  contributedF: number;
  paidOutF: number;
  profitShareF: number;
  offsetF: number;
  settledQty: number;
  /** Nachträglich aktivierte Kosten der noch nicht abgerechneten Stücke des laufenden Abschnitts (alle Beteiligten). */
  extraUnsettledF: number;
  extraCostShareF: number;
  openF: number;
  owedCostF: number;
  /** Ein abgerechneter Verkauf weicht vom heutigen Stand ab, eine Retoure ist offen, oder ein Stück kam nach einer Übernahme zurück. */
  correctionPending: boolean;
  /** Eine Lieferantengutschrift aus einer Rückgabe ist noch nicht vollständig verwendet. */
  refundPending: boolean;
  /** Ein Stück eines beendeten Abschnitts liegt wieder im Lager (Rückkehr nach Übernahme/Wechsel). */
  returnedAfterEnd: boolean;
}

/**
 * Der Stand EINES Partners an EINER Einkaufszeile über alle Abschnitte. Nachträgliche Kosten: das ERP
 * aktiviert Reparaturkosten eigener Ware im Los-Einstand (je verbleibendem Stück) und nur vor dem
 * Verkauf — was davon auf noch nicht abgerechnete Stücke des laufenden Abschnitts fällt, trägt der
 * Partner nach seinem Anteil mit.
 */
function lineStateOf(purchaseLineId: string, partnerId: string, branchId: string): LineState {
  const rows = query(
    `SELECT kind, amount FROM item_partner_movements WHERE purchase_line_id = ? AND partner_id = ? AND cancelled_at IS NULL`,
    [purchaseLineId, partnerId],
  );
  const s = { contributedF: 0, paidOutF: 0, profitShareF: 0, offsetF: 0 };
  for (const r of rows) {
    if (r.kind === 'CONTRIBUTION') s.contributedF += F(r.amount);
    else if (r.kind === 'PAYOUT') s.paidOutF += F(r.amount);
    else if (r.kind === 'PROFIT_SHARE' || r.kind === 'PROFIT_CORRECTION' || r.kind === 'SUPPLIER_RETURN') s.profitShareF += F(r.amount);
    else if (r.kind === 'OFFSET') s.offsetF += F(r.amount);
  }
  const epochs = epochsOf(purchaseLineId, branchId);
  let settledQty = 0;
  let owed = 0;
  let extraUnsettledF = 0;
  let extraCostShareF = 0;
  let correctionPending = false;
  let refundPending = false;
  let returnedAfterEnd = false;
  let cancelled = false;
  for (const e of epochs) {
    cancelled = cancelled || purchaseCancelled(e.purchaseId);
    const st = epochStateOf(e, partnerId, branchId);
    if (st.correctionPending) correctionPending = true;
    if (st.refundPending) refundPending = true;
    // Ein beendeter Abschnitt, dem wieder ein Stück gehört: kam nach der Übernahme zurück.
    const endedAgain = e.endedAt !== null && st.unsettledQty > 0 && st.unsettledSoldQty < st.unsettledQty;
    if (e.endedAt !== null && st.unsettledQty > 0) { returnedAfterEnd = returnedAfterEnd || endedAgain; correctionPending = correctionPending || endedAgain; }
    const party = e.parties.find((p) => p.partnerId === partnerId);
    if (!party) continue;
    settledQty += st.settledQty;
    if (cancelled) continue;
    owed += Math.round(party.costShareF * st.unsettledQty / Math.max(1, e.qty));
    if (e.endedAt === null) {
      // Laufender Abschnitt: aktivierte Kosten der Stücke im Lager und der verkauften, nicht abgerechneten.
      const inStock = Math.max(0, st.unsettledQty - st.unsettledSoldQty);
      let left = inStock;
      let extra = 0;
      for (const l of stockOf(purchaseLineId)) {
        const take = Math.min(left, l.qty);
        extra += F(take * l.unitCost) - e.unitCostF * take;
        left -= take;
        if (left <= 0) break;
      }
      extra += st.soldUnsettledCostF - e.unitCostF * st.unsettledSoldQty;
      extraUnsettledF += extra;
      extraCostShareF += Math.round(extra * party.shareBp / FULL_BP);
    }
  }
  const state = {
    costShareF: 0, quantity: 1, settledQty: 0, contributedF: s.contributedF, paidOutF: s.paidOutF,
    profitShareF: s.profitShareF, offsetF: s.offsetF, extraCostShareF: extraCostShareF + owed,
  };
  return {
    ...s, settledQty, extraUnsettledF, extraCostShareF, correctionPending, refundPending, returnedAfterEnd,
    openF: openBalanceF(state), owedCostF: owedCostF(state),
  };
}

function assertParticipates(purchaseLineId: string, partnerId: string, branchId: string): string {
  const r = query(
    `SELECT purchase_id FROM item_participations WHERE purchase_line_id = ? AND partner_id = ? AND branch_id = ? AND party = 'PARTNER' LIMIT 1`,
    [purchaseLineId, partnerId, branchId],
  )[0];
  if (!r) throw nein(PARTNER_ITEM_NOT_FOUND, 'this partner holds no share in this item');
  return String(r.purchase_id);
}

/** Offener Ausgleich eines Partners an einer Zeile in BHD (positiv = LATAIF schuldet dem Partner). */
export function partnerItemOpen(purchaseLineId: string, partnerId: string, branchId: string): number {
  assertParticipates(purchaseLineId, partnerId, branchId);
  return B(lineStateOf(purchaseLineId, partnerId, branchId).openF);
}

function insertMovement(ctx: PartnerItemCtx, m: {
  purchaseId: string; purchaseLineId: string; partnerId: string; kind: string; amountF: number; method?: string | null;
  occurredAt: string; invoiceId?: string | null; invoiceLineId?: string | null; basis?: unknown; groupId?: string | null; note?: string | null;
  epochId?: string | null; purchaseReturnId?: string | null;
}): string {
  const id = uuid();
  getDatabase().run(
    `INSERT INTO item_partner_movements (id, branch_id, purchase_id, purchase_line_id, partner_id, kind, amount, method,
       occurred_at, invoice_id, invoice_line_id, basis_json, group_id, note, created_at, created_by, epoch_id, purchase_return_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, ctx.branchId, m.purchaseId, m.purchaseLineId, m.partnerId, m.kind, B(m.amountF), m.method ?? null, m.occurredAt,
      m.invoiceId ?? null, m.invoiceLineId ?? null, m.basis === undefined ? null : JSON.stringify(m.basis), m.groupId ?? null,
      m.note ?? null, ctx.now, ctx.userId || null, m.epochId ?? null, m.purchaseReturnId ?? null],
  );
  return id;
}

const lineTotalsF = (plId: string, branchId: string): number =>
  epochsOf(plId, branchId).reduce((a, e) => a + e.valueF, 0);

// ── Beitrag und Auszahlung ──────────────────────────────────────────────────

export interface ItemMovementRecorded {
  movementId: string;
  kind: 'CONTRIBUTION' | 'PAYOUT';
  amount: number;
  open: number;
}

function payoutBlocker(st: LineState): { code: string; message: string } | null {
  if (st.correctionPending) {
    return {
      code: PARTNER_SALE_NEEDS_CORRECTION,
      message: st.returnedAfterEnd
        ? 'a piece came back after the partnership on it ended — take it over or settle it first'
        : 'a settled sale of this item changed (return, cancellation or edit) or a return is undecided — correct the settlement before paying out',
    };
  }
  if (st.refundPending) {
    return { code: PARTNER_SUPPLIER_REFUND_PENDING, message: 'the supplier credit from the return of this item is not fully used yet — payouts wait until it is used or refunded' };
  }
  return null;
}

/**
 * „Beitrag erfassen" (Partner → Firma, auch Rückzahlung) oder „Auszahlen" (Firma → Partner). Ein
 * Beitrag darf die Zeile nicht über ihren Einstand hinaus finanzieren — außer er begleicht, was der
 * Partner LATAIF schuldet. Eine Auszahlung höchstens, was LATAIF an dieser Zeile schuldet, und nicht,
 * solange eine Nachabrechnung, eine Rückkehr nach Übernahme oder eine Lieferantengutschrift offen ist.
 */
export function recordItemMovementInHouse(raw: ItemMovementInput, ctx: PartnerItemCtx): ItemMovementRecorded {
  assertItemBooksHere();
  const v = itemMovementInput(raw as unknown as Record<string, unknown>);
  const purchaseId = assertParticipates(v.purchaseLineId, v.partnerId, ctx.branchId);
  const st = lineStateOf(v.purchaseLineId, v.partnerId, ctx.branchId);
  const amountF = F(v.amount);
  if (v.kind === 'CONTRIBUTION') {
    const funded = query(
      `SELECT COALESCE(SUM(CASE WHEN kind = 'CONTRIBUTION' THEN amount WHEN kind = 'PAYOUT' THEN -amount ELSE 0 END), 0) AS t
         FROM item_partner_movements WHERE purchase_line_id = ? AND cancelled_at IS NULL`,
      [v.purchaseLineId],
    )[0];
    const cancelled = purchaseCancelled(purchaseId);
    const baseF = lineTotalsF(v.purchaseLineId, ctx.branchId) + Math.max(0, st.extraUnsettledF);
    const capF = cancelled ? 0 : baseF - F(funded?.t);
    const allowedF = Math.max(capF, -st.openF);
    if (amountF > allowedF) {
      if (cancelled && st.openF >= 0) {
        throw nein(PARTNER_ITEM_PURCHASE_CANCELLED, 'this purchase is cancelled — no contribution can be booked on it');
      }
      throw nein(PARTNER_ITEM_OVERFUNDED, `at most ${bhd(Math.max(0, allowedF))} BHD can be contributed on this item (its cost is ${bhd(baseF)} BHD)`);
    }
  } else {
    const b = payoutBlocker(st);
    if (b) throw nein(b.code, b.message);
    if (amountF > st.openF) {
      throw nein(PARTNER_ITEM_PAYOUT_EXCEEDS_OPEN,
        st.openF > 0 ? `LATAIF owes this partner ${bhd(st.openF)} BHD on this item — pay out at most that` : 'LATAIF owes this partner nothing on this item');
    }
  }
  const id = insertMovement(ctx, {
    purchaseId, purchaseLineId: v.purchaseLineId, partnerId: v.partnerId, kind: v.kind, amountF,
    method: v.method, occurredAt: v.date, note: v.note ?? null,
  });
  postItemPartnerMovement({
    id, partnerId: v.partnerId, kind: v.kind, amount: B(amountF), method: v.method, occurredAt: v.date, purchaseLineId: v.purchaseLineId,
  });
  return { movementId: id, kind: v.kind, amount: B(amountF), open: B(lineStateOf(v.purchaseLineId, v.partnerId, ctx.branchId).openF) };
}

// ── Verrechnung zwischen zwei Artikeln ──────────────────────────────────────

export interface ItemOffsetRecorded { groupId: string; amount: number; openFrom: number; openTo: number }

/**
 * „Verrechnen": was LATAIF dem Partner an einem Artikel schuldet, gegen das, was der Partner an einem
 * anderen schuldet — ohne Geldfluss, als Paar nachvollziehbar. Höchstens beide offenen Beträge.
 */
export function offsetItemsInHouse(raw: ItemOffsetInput, ctx: PartnerItemCtx): ItemOffsetRecorded {
  assertItemBooksHere();
  const v = itemOffsetInput(raw as unknown as Record<string, unknown>);
  const fromPurchase = assertParticipates(v.fromPurchaseLineId, v.partnerId, ctx.branchId);
  const toPurchase = assertParticipates(v.toPurchaseLineId, v.partnerId, ctx.branchId);
  const sFrom = lineStateOf(v.fromPurchaseLineId, v.partnerId, ctx.branchId);
  const sTo = lineStateOf(v.toPurchaseLineId, v.partnerId, ctx.branchId);
  const b = payoutBlocker(sFrom) ?? (sTo.correctionPending ? payoutBlocker(sTo) : null);
  if (b) throw nein(b.code, b.message);
  const amountF = F(v.amount);
  if (amountF > sFrom.openF) throw nein(PARTNER_ITEM_OFFSET_INVALID, `LATAIF owes the partner at most ${bhd(Math.max(0, sFrom.openF))} BHD on the first item`);
  if (amountF > -sTo.openF) throw nein(PARTNER_ITEM_OFFSET_INVALID, `the partner owes at most ${bhd(Math.max(0, -sTo.openF))} BHD on the second item`);
  const groupId = uuid();
  insertMovement(ctx, {
    purchaseId: fromPurchase, purchaseLineId: v.fromPurchaseLineId, partnerId: v.partnerId, kind: 'OFFSET', amountF: -amountF,
    occurredAt: v.date, groupId, note: v.note ?? null, basis: { counterpartLineId: v.toPurchaseLineId },
  });
  insertMovement(ctx, {
    purchaseId: toPurchase, purchaseLineId: v.toPurchaseLineId, partnerId: v.partnerId, kind: 'OFFSET', amountF,
    occurredAt: v.date, groupId, note: v.note ?? null, basis: { counterpartLineId: v.fromPurchaseLineId },
  });
  return {
    groupId, amount: B(amountF),
    openFrom: B(lineStateOf(v.fromPurchaseLineId, v.partnerId, ctx.branchId).openF),
    openTo: B(lineStateOf(v.toPurchaseLineId, v.partnerId, ctx.branchId).openF),
  };
}

// ── Schlussabrechnung und Nachabrechnung eines Verkaufs ─────────────────────

export interface SaleSettled {
  invoiceLineId: string;
  invoiceNumber: string;
  /** 'SETTLEMENT' = Erstabrechnung, 'CORRECTION' = Nachabrechnung (nur die Differenz). */
  mode: 'SETTLEMENT' | 'CORRECTION';
  profit: number;
  quantity: number;
  shares: Array<{ partnerId: string; movementId: string; amount: number; total: number }>;
}

/**
 * „Verkauf abrechnen": der Gewinn des Verkaufs nach der Regel des ERP, je Partner des Abschnitts,
 * dem der Verkauf gehört, nach seinem Anteil auf sein Ausgleichskonto (Verlust negativ). LATAIFs
 * Anteil bleibt im Ergebnis der Firma. Ist der Verkauf schon abgerechnet und hat er sich geändert,
 * bucht dieselbe Handlung die DIFFERENZ als Nachabrechnung — alles Frühere bleibt stehen.
 */
export function settleSaleLineInHouse(invoiceLineId: string, ctx: PartnerItemCtx): SaleSettled {
  assertItemBooksHere();
  if (typeof invoiceLineId !== 'string' || !invoiceLineId) throw nein(PARTNER_SALE_NOT_FOUND, 'no sale line given');
  const basis = saleBasisOf(invoiceLineId, ctx.branchId);
  const e = epochOfSale(basis, ctx.branchId);
  if (!e || e.parties.length === 0) {
    throw nein(PARTNER_SALE_NOT_FOUND, 'no partner holds a share in this sale — the item was bought alone or LATAIF held it alone when it was sold');
  }
  const booked = e.parties.map((p) => bookedOf(invoiceLineId, p.partnerId));
  const settled = booked.some((b) => b.latest !== null);
  const blocker = saleBlocker(basis, settled);
  if (blocker) throw nein(blocker.code, blocker.message);
  if (!settled && basis.qty === 0 && basis.netF === 0 && basis.costF === 0) {
    throw nein(PARTNER_SALE_NOT_FOUND, `the sale on invoice ${basis.invoiceNumber} was fully returned — there is nothing to settle`);
  }
  if (settled && booked.every((b) => b.latest && sameBasis(b.latest, basis))) {
    throw nein(PARTNER_SALE_ALREADY_SETTLED, `the sale on invoice ${basis.invoiceNumber || '(deleted)'} is already settled and has not changed`);
  }
  if (!settled) {
    // Mehr Stücke abrechnen, als der Abschnitt hält, ginge auf Kosten von LATAIF-eigenen Stücken.
    const st = epochStateOf(e, e.parties[0].partnerId, ctx.branchId);
    if (st.settledQty + basis.qty > e.qty) {
      throw nein(PARTNER_SALE_OUTSIDE_PARTNERSHIP, 'this sale has more pieces than the partnership still holds — the rest belongs to LATAIF alone');
    }
  }
  const mode: SaleSettled['mode'] = settled ? 'CORRECTION' : 'SETTLEMENT';
  const occurredAt = dayOf(ctx.now);
  const groupId = uuid();
  const shares: SaleSettled['shares'] = [];
  e.parties.forEach((p, i) => {
    const targetF = profitShareF(basis.profitF, p.shareBp);
    const deltaF = targetF - booked[i].bookedF;
    const kind = mode === 'SETTLEMENT' ? 'PROFIT_SHARE' : 'PROFIT_CORRECTION';
    const id = insertMovement(ctx, {
      purchaseId: e.purchaseId, purchaseLineId: e.purchaseLineId, partnerId: p.partnerId, kind, amountF: deltaF, occurredAt,
      invoiceId: basis.invoiceId || null, invoiceLineId, groupId, epochId: e.key,
      basis: {
        invoiceNumber: basis.invoiceNumber, invoiceStatus: basis.invoiceStatus, qty: basis.qty, net: B(basis.netF),
        cost: B(basis.costF), profit: B(basis.profitF), shareBp: p.shareBp, target: B(targetF), previous: B(booked[i].bookedF),
      },
    });
    postItemPartnerMovement({ id, partnerId: p.partnerId, kind, amount: B(deltaF), occurredAt, purchaseLineId: e.purchaseLineId, invoiceLineId });
    shares.push({ partnerId: p.partnerId, movementId: id, amount: B(deltaF), total: B(targetF) });
  });
  return { invoiceLineId, invoiceNumber: basis.invoiceNumber, mode, profit: B(basis.profitF), quantity: basis.qty, shares };
}

// ── Rückgabe an den Lieferanten ─────────────────────────────────────────────

/**
 * Aufgerufen von der Einkaufsrückgabe (`confirmPurchaseReturnInHouse`) in DERSELBEN Transaktion, VOR
 * dem Lagerabgang: je zurückgegebener Zeile mit laufendem Abschnitt der Partneranteil an
 * (Erstattungswert − Einstand). Die Stücke verlassen den Abschnitt; die Auszahlung wartet, solange
 * eine Gutschrift aus der Rückgabe nicht vollständig verwendet ist. Keine Kundenrechnung, kein
 * Umsatz, keine VAT, keine Lieferantenzahlung. Wirft `PartnerItemRejected`, wenn es nicht eindeutig
 * geht — dann gibt es auch die Rückgabe nicht.
 */
export function settleSupplierReturnForPartners(
  returnId: string, returnNumber: string,
  lines: ReadonlyArray<{ purchaseLineId: string | null; quantity: number; unitPrice: number }>,
  ctx: PartnerItemCtx,
): number {
  let n = 0;
  for (const l of lines) {
    if (!l.purchaseLineId || !isJointPurchaseLine(l.purchaseLineId)) continue;
    const info = ownershipInfo(l.purchaseLineId, ctx.branchId);
    if (info.mode === 'RETURNED_AFTER_END') {
      throw nein(PARTNER_OWNERSHIP_BLOCKED, 'a piece of this item came back after the partnership on it ended — take it over first, then return it');
    }
    if (info.mode !== 'ACTIVE' || !info.epoch) continue;   // LATAIF hält die Stücke allein
    const e = info.epoch;
    const q = Math.max(0, Number(l.quantity) || 0);
    if (q <= 0) continue;
    const inStockOfEpoch = Math.max(0, info.qty - info.soldUnsettledQty);
    if (q > inStockOfEpoch) {
      throw nein(PARTNER_OWNERSHIP_BLOCKED, `only ${inStockOfEpoch} piece(s) of this item belong to the partnership and are in stock — return at most that`);
    }
    const valueF = F(q * (Number(l.unitPrice) || 0));
    const costF = stockValueF(l.purchaseLineId, q);
    const profitF = valueF - costF;
    const groupId = uuid();
    const occurredAt = dayOf(ctx.now);
    for (const p of e.parties) {
      const amountF = profitShareF(profitF, p.shareBp);
      const id = insertMovement(ctx, {
        purchaseId: e.purchaseId, purchaseLineId: e.purchaseLineId, partnerId: p.partnerId, kind: 'SUPPLIER_RETURN', amountF,
        occurredAt, groupId, epochId: e.key, purchaseReturnId: returnId,
        basis: { returnNumber, qty: q, value: B(valueF), cost: B(costF), profit: B(profitF), shareBp: p.shareBp },
      });
      postItemPartnerMovement({ id, partnerId: p.partnerId, kind: 'SUPPLIER_RETURN', amount: B(amountF), occurredAt, purchaseLineId: e.purchaseLineId });
      n++;
    }
  }
  return n;
}

/**
 * Aufgerufen, wenn eine bestätigte Lieferantenrückgabe zurückgenommen wird (Storno der Rückgabe
 * oder des Einkaufs): die Partnerbuchungen der Rückgabe werden gegengebucht. Wurde danach für
 * dieselbe Zeile und denselben Partner schon etwas gebucht, bleibt die Rückgabe stehen (Nein).
 */
export function reverseSupplierReturnForPartners(returnId: string, now: string): void {
  const rows = query(
    `SELECT rowid AS rid, id, purchase_line_id, partner_id FROM item_partner_movements
      WHERE purchase_return_id = ? AND kind = 'SUPPLIER_RETURN' AND cancelled_at IS NULL`,
    [returnId],
  );
  if (rows.length === 0) return;
  const ids = new Set(rows.map((r) => String(r.id)));
  for (const t of rows) {
    const later = query(
      `SELECT id FROM item_partner_movements WHERE purchase_line_id = ? AND partner_id = ? AND cancelled_at IS NULL AND rowid > ?`,
      [t.purchase_line_id, t.partner_id, t.rid],
    ).filter((x) => !ids.has(String(x.id)));
    if (later.length > 0) {
      throw nein(PARTNER_OWNERSHIP_BLOCKED, 'the partner settlement of this supplier return was followed by further partner bookings — it cannot be reversed');
    }
  }
  const db = getDatabase();
  for (const t of rows) {
    const id = String(t.id);
    db.run('UPDATE item_partner_movements SET cancelled_at = ? WHERE id = ?', [now, id]);
    if (hasLedgerEntries('PARTNER_ITEM', id) && !hasReversalFor('PARTNER_ITEM', id)) reverseSource('PARTNER_ITEM', id, now);
  }
}

// ── Übernahme durch LATAIF und Partnerwechsel ───────────────────────────────

export interface OwnershipInfo {
  /** ACTIVE: laufender Abschnitt · RETURNED_AFTER_END: ein beendeter Abschnitt hält wieder Stücke ·
   *  LATAIF_ONLY: LATAIF hält die Stücke im Lager allein · NONE: nichts übernehmbar. */
  mode: 'ACTIVE' | 'RETURNED_AFTER_END' | 'LATAIF_ONLY' | 'NONE';
  epoch: Epoch | null;
  /** Stücke, die die Handlung betrifft (Abschnitt: alle nicht abgegebenen; LATAIF allein: alle im Lager). */
  qty: number;
  soldUnsettledQty: number;
  /** Aktueller Lager-Einstand dieser Stücke. */
  valueF: number;
  blocker: string | null;
}

/** Was „Take over" / „Change partners" an dieser Einkaufszeile heute beträfe — und ob es geht. */
export function ownershipInfo(purchaseLineId: string, branchId: string): OwnershipInfo {
  const epochs = epochsOf(purchaseLineId, branchId);
  const stock = stockQty(purchaseLineId);
  const purchaseId = String(query('SELECT purchase_id FROM purchase_lines WHERE id = ?', [purchaseLineId])[0]?.purchase_id ?? '');
  if (purchaseId && purchaseCancelled(purchaseId)) {
    return { mode: 'NONE', epoch: null, qty: 0, soldUnsettledQty: 0, valueF: 0, blocker: 'the purchase is cancelled' };
  }
  const probe = (e: Epoch) => epochStateOf(e, e.parties[0]?.partnerId ?? '', branchId);
  const blockerOf = (e: Epoch, st: EpochState): string | null => {
    if (st.correctionPending) return 'a settled sale of this item changed — correct the settlement first';
    if (st.pendingReturn) return 'a return on a sale of this item is not decided yet';
    if (st.unsettledSoldQty > 0) return 'a sale of this item is not settled yet — settle it first';
    if (st.refundPending) return 'the supplier credit from a return of this item is not fully used yet';
    if (st.unsettledQty > stock) return 'not all pieces of the partnership are in stock';
    if (e.parties.length === 0) return 'no partner holds a share';
    return null;
  };
  for (const e of epochs) {
    if (e.endedAt === null || e.parties.length === 0) continue;
    const st = probe(e);
    if (st.unsettledQty > 0 && st.unsettledSoldQty < st.unsettledQty) {
      const qty = st.unsettledQty - st.unsettledSoldQty;
      return { mode: 'RETURNED_AFTER_END', epoch: e, qty, soldUnsettledQty: 0, valueF: stockValueF(purchaseLineId, qty), blocker: blockerOf(e, st) };
    }
  }
  const active = epochs.find((e) => e.endedAt === null && e.parties.length > 0) ?? null;
  if (active) {
    const st = probe(active);
    if (st.unsettledQty <= 0) return { mode: 'NONE', epoch: active, qty: 0, soldUnsettledQty: 0, valueF: 0, blocker: 'all pieces are sold or returned' };
    return {
      mode: 'ACTIVE', epoch: active, qty: st.unsettledQty, soldUnsettledQty: st.unsettledSoldQty,
      valueF: stockValueF(purchaseLineId, Math.max(0, st.unsettledQty - st.unsettledSoldQty)), blocker: blockerOf(active, st),
    };
  }
  if (stock > 0) return { mode: 'LATAIF_ONLY', epoch: null, qty: stock, soldUnsettledQty: 0, valueF: stockValueF(purchaseLineId, stock), blocker: null };
  return { mode: 'NONE', epoch: null, qty: 0, soldUnsettledQty: 0, valueF: 0, blocker: 'no unsold pieces in stock' };
}

export interface OwnershipChanged {
  purchaseLineId: string;
  mode: 'TAKEOVER' | 'CHANGE';
  qty: number;
  value: number;
  epochId: string | null;
  released: Array<{ partnerId: string; open: number }>;
}

function assertValueConfirmed(info: OwnershipInfo, expectedValue: number): void {
  if (F(expectedValue) !== info.valueF) {
    throw nein(PARTNER_OWNERSHIP_VALUE_MISMATCH,
      `the unsold pieces are taken at their current stock cost of ${bhd(info.valueF)} BHD only — a different value is not supported (shown: ${bhd(F(expectedValue))} BHD); reload and confirm again`);
  }
}

/** Die Stücke verlassen den Abschnitt zum aktuellen Einstand — Gewinnanteil 0, keine Buchung. */
function releaseEpoch(e: Epoch, qty: number, valueF: number, reason: 'TAKEOVER' | 'CHANGE', ctx: PartnerItemCtx, endIt: boolean): void {
  const groupId = uuid();
  for (const p of e.parties) {
    insertMovement(ctx, {
      purchaseId: e.purchaseId, purchaseLineId: e.purchaseLineId, partnerId: p.partnerId, kind: 'TAKEOVER', amountF: 0,
      occurredAt: dayOf(ctx.now), groupId, epochId: e.key, basis: { qty, value: B(valueF), reason, shareBp: p.shareBp },
    });
  }
  if (endIt) {
    getDatabase().run(
      `UPDATE item_participations SET ended_at = ?, ended_reason = ?, to_il_rowid = ?
        WHERE purchase_line_id = ? AND ${EPOCH} = ? AND ended_at IS NULL`,
      [ctx.now, reason, maxInvoiceLineRowid(), e.purchaseLineId, e.key],
    );
  }
}

/**
 * „Take over (LATAIF alone)": LATAIF übernimmt alle unverkauften Stücke der Zeile zum aktuellen
 * Lager-Einstand. Die Partner des Abschnitts geben sie ab (Gewinnanteil 0), ihr Kostenanteil entfällt,
 * ihr Anspruch (Beiträge − Auszahlungen + Gewinnanteile) bleibt auf dem Ausgleichskonto; gezahlt wird
 * über „Pay out". Kein Lagerzugang, kein Einkauf, keine Neubewertung.
 */
export function takeOverInHouse(raw: OwnershipChangeInput, ctx: PartnerItemCtx): OwnershipChanged {
  assertItemBooksHere();
  const v = ownershipChangeInput(raw as unknown as Record<string, unknown>, false);
  const info = ownershipInfo(v.purchaseLineId, ctx.branchId);
  if (info.mode === 'LATAIF_ONLY' || info.mode === 'NONE' || !info.epoch) {
    throw nein(PARTNER_OWNERSHIP_UNCHANGED, info.mode === 'LATAIF_ONLY' ? 'LATAIF already holds these pieces alone' : info.blocker ?? 'nothing to take over');
  }
  if (info.blocker) throw nein(PARTNER_OWNERSHIP_BLOCKED, info.blocker);
  assertValueConfirmed(info, v.expectedValue);
  releaseEpoch(info.epoch, info.qty, info.valueF, 'TAKEOVER', ctx, info.mode === 'ACTIVE');
  return {
    purchaseLineId: v.purchaseLineId, mode: 'TAKEOVER', qty: info.qty, value: B(info.valueF), epochId: null,
    released: info.epoch.parties.map((p) => ({ partnerId: p.partnerId, open: B(lineStateOf(v.purchaseLineId, p.partnerId, ctx.branchId).openF) })),
  };
}

/**
 * „Change partners": neue Anteile für alle unverkauften Stücke der Zeile, zum aktuellen Lager-Einstand
 * (auch für einen allein gekauften Artikel). Der laufende Abschnitt endet (Gewinnanteil 0), ein neuer
 * beginnt; die Kostenanteile folgen dem neuen Wert. Keine Geldbewegung — gezahlt wird über
 * „Beitrag"/„Auszahlung". Abgerechnete Verkäufe bleiben unverändert.
 */
export function changePartnersInHouse(raw: OwnershipChangeInput, ctx: PartnerItemCtx): OwnershipChanged {
  assertItemBooksHere();
  const v = ownershipChangeInput(raw as unknown as Record<string, unknown>, true);
  const shares = v.partnerShares ?? [];
  const info = ownershipInfo(v.purchaseLineId, ctx.branchId);
  if (info.mode === 'NONE') throw nein(PARTNER_OWNERSHIP_BLOCKED, info.blocker ?? 'no unsold pieces in stock');
  if (info.mode === 'RETURNED_AFTER_END') {
    throw nein(PARTNER_OWNERSHIP_BLOCKED, 'a piece came back after the partnership on it ended — take it over by LATAIF first');
  }
  if (info.blocker) throw nein(PARTNER_OWNERSHIP_BLOCKED, info.blocker);
  if (shares.length === 0) throw nein(PARTNER_OWNERSHIP_UNCHANGED, 'no partner given — to hold the item alone use "Take over"');
  assertValueConfirmed(info, v.expectedValue);
  const qty = info.qty;
  if (info.epoch) {
    const cur = info.epoch.parties.map((p) => `${p.partnerId}:${p.shareBp}`).sort().join(',');
    const nxt = planLineParticipation(shares, info.valueF).filter((p) => p.partnerId).map((p) => `${p.partnerId}:${p.shareBp}`).sort().join(',');
    if (cur === nxt) throw nein(PARTNER_OWNERSHIP_UNCHANGED, 'these are the current partners and shares — nothing changes');
    releaseEpoch(info.epoch, qty, info.valueF, 'CHANGE', ctx, true);
  }
  const pl = query('SELECT purchase_id, product_id FROM purchase_lines WHERE id = ?', [v.purchaseLineId])[0];
  if (!pl) throw nein(PARTNER_ITEM_NOT_FOUND, 'no such purchase line');
  const branchOk = query('SELECT 1 FROM purchases WHERE id = ? AND branch_id = ?', [pl.purchase_id, ctx.branchId])[0];
  if (!branchOk) throw nein(PARTNER_ITEM_NOT_FOUND, 'no such purchase line in this branch');
  const epochId = uuid();
  insertEpoch(ctx, String(pl.purchase_id), v.purchaseLineId, pl.product_id ? String(pl.product_id) : null, epochId,
    info.valueF, qty, Math.round(info.valueF / Math.max(1, qty)), maxInvoiceLineRowid(), shares);
  return {
    purchaseLineId: v.purchaseLineId, mode: 'CHANGE', qty, value: B(info.valueF), epochId,
    released: (info.epoch?.parties ?? []).map((p) => ({ partnerId: p.partnerId, open: B(lineStateOf(v.purchaseLineId, p.partnerId, ctx.branchId).openF) })),
  };
}

// ── Storno ──────────────────────────────────────────────────────────────────

/**
 * Eine Partnerbuchung zurücknehmen — gedacht für Erfassungsfehler: die Zeile bleibt als Verlauf,
 * die Buchung wird gegengebucht. Was EINE Handlung war, wird gemeinsam zurückgenommen; eine
 * Erstabrechnung samt ihren Nachabrechnungen. Nichts wird zurückgenommen, wonach für dieselbe Zeile
 * und denselben Partner schon etwas gebucht wurde. Lieferantenrückgaben, Übernahmen und
 * Partnerwechsel werden nicht hier zurückgenommen (sie gehören zu ihrem eigenen Vorgang).
 */
export function cancelItemMovementInHouse(movementId: string, ctx: PartnerItemCtx): { cancelled: string[] } {
  assertItemBooksHere();
  const m = query(
    `SELECT rowid AS rid, id, kind, purchase_line_id, partner_id, invoice_line_id, group_id, cancelled_at
       FROM item_partner_movements WHERE id = ? AND branch_id = ?`,
    [movementId, ctx.branchId],
  )[0];
  if (!m) throw nein(PARTNER_MOVEMENT_NOT_FOUND, 'no such partner booking in this branch');
  if (m.cancelled_at) throw nein(PARTNER_MOVEMENT_CANCELLED, 'this partner booking is already cancelled');
  if (m.kind === 'SUPPLIER_RETURN' || m.kind === 'TAKEOVER') {
    throw nein(PARTNER_MOVEMENT_CANCELLED, 'this booking belongs to a supplier return or an ownership change — it is not reversed on its own');
  }
  const targets = m.kind === 'PROFIT_SHARE'
    ? query(
      `SELECT rowid AS rid, id, purchase_line_id, partner_id FROM item_partner_movements
        WHERE invoice_line_id = ? AND kind IN ('PROFIT_SHARE','PROFIT_CORRECTION') AND cancelled_at IS NULL AND branch_id = ?`,
      [m.invoice_line_id, ctx.branchId])
    : m.group_id
      ? query(`SELECT rowid AS rid, id, purchase_line_id, partner_id FROM item_partner_movements WHERE group_id = ? AND cancelled_at IS NULL`, [m.group_id])
      : [m];
  const ids = new Set(targets.map((t) => String(t.id)));
  for (const t of targets) {
    const later = query(
      `SELECT id FROM item_partner_movements
        WHERE purchase_line_id = ? AND partner_id = ? AND cancelled_at IS NULL AND rowid > ?`,
      [t.purchase_line_id, t.partner_id, t.rid],
    ).filter((x) => !ids.has(String(x.id)));
    if (later.length > 0) {
      throw nein(PARTNER_MOVEMENT_CANCELLED,
        'something was booked for this partner and item after this entry — it stays; changes to a settled sale are made with "Correct settlement"');
    }
  }
  const db = getDatabase();
  const out: string[] = [];
  for (const t of targets) {
    const id = String(t.id);
    db.run('UPDATE item_partner_movements SET cancelled_at = ?, cancelled_by = ? WHERE id = ?', [ctx.now, ctx.userId || null, id]);
    if (hasLedgerEntries('PARTNER_ITEM', id) && !hasReversalFor('PARTNER_ITEM', id)) reverseSource('PARTNER_ITEM', id, ctx.now);
    out.push(id);
  }
  return { cancelled: out };
}

// ── Lesen: Einkaufsbeleg ────────────────────────────────────────────────────

/** Die Beteiligungen eines Einkaufs, je Zeile: der laufende (oder letzte) Abschnitt, frühere als Verlauf. */
export function participationsOfPurchase(purchaseId: string, branchId: string): PurchaseLineParticipation[] {
  const lineIds = query('SELECT DISTINCT purchase_line_id FROM item_participations WHERE purchase_id = ? AND branch_id = ?', [purchaseId, branchId])
    .map((r) => String(r.purchase_line_id));
  const names = new Map(query('SELECT id, name, active FROM partners WHERE branch_id = ?', [branchId])
    .map((r) => [String(r.id), { name: String(r.name), active: Number(r.active) === 1 }]));
  const out: PurchaseLineParticipation[] = [];
  for (const lineId of lineIds) {
    const epochs = epochsOf(lineId, branchId);
    const current = epochs.find((e) => e.endedAt === null) ?? null;
    const shown = current ?? epochs[epochs.length - 1];
    const parties: PurchaseLineParticipation['parties'] = [];
    if (shown) {
      parties.push({ party: 'HOUSE', partnerId: null, name: 'LATAIF', active: true, sharePct: shown.houseBp / 100,
        costShare: B(shown.valueF - shown.parties.reduce((a, p) => a + p.costShareF, 0)) });
      for (const p of shown.parties) {
        const n = names.get(p.partnerId);
        parties.push({ party: 'PARTNER', partnerId: p.partnerId, name: n?.name ?? p.partnerId, active: n?.active ?? false,
          sharePct: p.shareBp / 100, costShare: B(p.costShareF) });
      }
    }
    out.push({
      purchaseLineId: lineId, parties,
      ended: current ? undefined : { at: shown?.endedAt ?? '', reason: shown?.endedReason ?? '' },
      history: epochs.filter((e) => e !== shown).map((e) => ({
        at: e.endedAt ?? '', reason: e.endedReason ?? '',
        parties: e.parties.map((p) => `${names.get(p.partnerId)?.name ?? p.partnerId} ${p.shareBp / 100} %`).join(' · '),
      })),
    });
  }
  return out;
}

/** Was die Maske für „Take over"/„Change partners" an einer Einkaufszeile zeigt (auch allein gekauft). */
export interface OwnershipView {
  purchaseLineId: string;
  mode: OwnershipInfo['mode'];
  qty: number;
  value: number;
  blocker: string | null;
  canTakeOver: boolean;
  canChange: boolean;
}

export function ownershipViewOf(purchaseLineId: string, branchId: string): OwnershipView {
  const i = ownershipInfo(purchaseLineId, branchId);
  return {
    purchaseLineId, mode: i.mode, qty: i.qty, value: B(i.valueF), blocker: i.blocker,
    canTakeOver: (i.mode === 'ACTIVE' || i.mode === 'RETURNED_AFTER_END') && !i.blocker && i.qty > 0,
    canChange: (i.mode === 'ACTIVE' || i.mode === 'LATAIF_ONLY') && !i.blocker && i.qty > 0,
  };
}

// ── Lesen: Partner-Modul und Berichte ───────────────────────────────────────

export interface PartnerItemSale {
  invoiceLineId: string;
  invoiceId: string;
  invoiceNumber: string;
  invoiceStatus: string;
  issuedAt: string;
  quantity: number;
  /** Gewinn des Verkaufs heute (ERP-Regel, nach Retouren). */
  profit: number;
  /** Rechnerischer Anteil DIESES Partners heute. */
  partnerShare: number;
  /** Zur Abrechnung freigegeben (gebucht: Abrechnung + Nachabrechnungen). */
  released: number;
  state: SaleState;
  settled: boolean;
  settlementId?: string;
  settleable: boolean;
  blocker?: string;
  changedAfterSettlement?: string;
}

export interface PartnerItemMovementView {
  id: string;
  kind: 'CONTRIBUTION' | 'PAYOUT' | 'PROFIT_SHARE' | 'PROFIT_CORRECTION' | 'OFFSET' | 'SUPPLIER_RETURN' | 'TAKEOVER';
  amount: number;
  method: string | null;
  occurredAt: string;
  invoiceNumber?: string;
  note?: string;
  detail?: string;
  cancelled: boolean;
}

export interface PartnerItemView {
  purchaseLineId: string;
  purchaseId: string;
  purchaseNumber: string;
  purchaseDate: string;
  purchaseStatus: string;
  productId: string | null;
  productLabel: string;
  sku: string;
  quantity: number;
  lineTotal: number;
  sharePct: number;
  costShare: number;
  /** Der Partner ist am laufenden Abschnitt beteiligt (sonst: früher beteiligt, Verlauf). */
  participating: boolean;
  /** Ende der letzten Beteiligung dieses Partners (Übernahme/Wechsel). */
  endedReason?: string;
  extraCosts: number;
  extraCostShare: number;
  contributed: number;
  paidOut: number;
  offsets: number;
  profitComputed: number;
  profitShare: number;
  settledQty: number;
  owedCost: number;
  open: number;
  correctionPending: boolean;
  refundPending: boolean;
  ownership: OwnershipView;
  sales: PartnerItemSale[];
  movements: PartnerItemMovementView[];
  warnings: string[];
}

export interface PartnerItemsOfPartner {
  partnerId: string;
  name: string;
  active: boolean;
  items: PartnerItemView[];
  openTotal: number;
  owedToPartner: number;
  owedByPartner: number;
  profitComputed: number;
  profitReleased: number;
  paidOut: number;
  contributed: number;
}

/** Die Artikelbeteiligungen aller Partner einer Filiale — auch deaktivierter und früherer (historisch). */
export function partnerItemsOverview(branchId: string, onlyPartnerId?: string): PartnerItemsOfPartner[] {
  const pairs = query(
    `SELECT DISTINCT ip.purchase_line_id, ip.partner_id, pr.name AS partner_name, pr.active AS partner_active,
            p.purchase_number, p.purchase_date, COALESCE(p.status, '') AS purchase_status, ip.purchase_id, ip.product_id,
            pd.brand, pd.name AS product_name, pd.sku
       FROM item_participations ip
       LEFT JOIN partners pr ON pr.id = ip.partner_id
       LEFT JOIN purchases p ON p.id = ip.purchase_id
       LEFT JOIN products pd ON pd.id = ip.product_id
      WHERE ip.branch_id = ? AND ip.party = 'PARTNER' ${onlyPartnerId ? 'AND ip.partner_id = ?' : ''}
      ORDER BY pr.name, p.purchase_date DESC, p.purchase_number DESC`,
    onlyPartnerId ? [branchId, onlyPartnerId] : [branchId],
  );
  const byPartner = new Map<string, PartnerItemsOfPartner & { f: Record<string, number> }>();
  const seen = new Set<string>();
  for (const r of pairs) {
    const partnerId = String(r.partner_id);
    const purchaseLineId = String(r.purchase_line_id);
    const key = `${partnerId}:${purchaseLineId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!byPartner.has(partnerId)) {
      byPartner.set(partnerId, {
        partnerId, name: String(r.partner_name ?? partnerId), active: Number(r.partner_active) === 1, items: [],
        openTotal: 0, owedToPartner: 0, owedByPartner: 0, profitComputed: 0, profitReleased: 0, paidOut: 0, contributed: 0,
        f: { open: 0, to: 0, by: 0, computed: 0, released: 0, paid: 0, contributed: 0 },
      });
    }
    const epochs = epochsOf(purchaseLineId, branchId);
    const mine = epochs.filter((e) => e.parties.some((p) => p.partnerId === partnerId));
    const current = mine.find((e) => e.endedAt === null) ?? null;
    const last = current ?? mine[mine.length - 1];
    const party = last?.parties.find((p) => p.partnerId === partnerId);
    const st = lineStateOf(purchaseLineId, partnerId, branchId);
    const sales = mine.flatMap((e) => salesView(e, partnerId, branchId));
    const computedF = sales.filter((s) => s.invoiceStatus === 'FINAL').reduce((a, s) => a + F(s.partnerShare), 0);
    const movements: PartnerItemMovementView[] = query(
      `SELECT m.id, m.kind, m.amount, m.method, m.occurred_at, m.note, m.cancelled_at, i.invoice_number, m.basis_json
         FROM item_partner_movements m LEFT JOIN invoices i ON i.id = m.invoice_id
        WHERE m.purchase_line_id = ? AND m.partner_id = ?
        ORDER BY m.rowid`,
      [purchaseLineId, partnerId],
    ).map((m) => {
      let basis: Record<string, unknown> = {};
      try { basis = JSON.parse(String(m.basis_json || '{}')); } catch { basis = {}; }
      const invoiceNumber = m.invoice_number ? String(m.invoice_number) : (basis.invoiceNumber ? String(basis.invoiceNumber) : undefined);
      let detail: string | undefined;
      if (m.kind === 'SUPPLIER_RETURN') detail = `${basis.returnNumber ?? ''} · ${basis.qty} pc · refund value ${Number(basis.value ?? 0).toFixed(3)} vs cost ${Number(basis.cost ?? 0).toFixed(3)}`;
      if (m.kind === 'TAKEOVER') detail = `${basis.reason === 'CHANGE' ? 'partners changed' : 'taken over by LATAIF'} · ${basis.qty} pc at stock cost ${Number(basis.value ?? 0).toFixed(3)}`;
      return {
        id: String(m.id), kind: m.kind as PartnerItemMovementView['kind'], amount: Number(m.amount) || 0,
        method: m.method ? String(m.method) : null, occurredAt: String(m.occurred_at ?? ''), invoiceNumber, detail,
        note: m.note ? String(m.note) : undefined, cancelled: !!m.cancelled_at,
      };
    });
    const warnings: string[] = [];
    if (String(r.purchase_status) === 'CANCELLED') warnings.push('Purchase cancelled — the cost share no longer applies; contributions can be paid back.');
    for (const s of sales) if (s.changedAfterSettlement) warnings.push(`${s.invoiceNumber || 'Sale'}: ${s.changedAfterSettlement}`);
    if (st.returnedAfterEnd) warnings.push('A piece came back after the partnership on it ended — take it over by LATAIF.');
    if (st.refundPending) warnings.push('Supplier credit from a return is not fully used yet — payouts wait.');
    const item: PartnerItemView = {
      purchaseLineId, purchaseId: String(r.purchase_id), purchaseNumber: String(r.purchase_number ?? ''),
      purchaseDate: String(r.purchase_date ?? ''), purchaseStatus: String(r.purchase_status ?? ''),
      productId: r.product_id ? String(r.product_id) : null,
      productLabel: [r.brand, r.product_name].filter(Boolean).join(' ') || 'Item',
      sku: String(r.sku ?? ''), quantity: last?.qty ?? 0, lineTotal: B(last?.valueF ?? 0), sharePct: (party?.shareBp ?? 0) / 100,
      costShare: B(party?.costShareF ?? 0), participating: !!current,
      endedReason: current ? undefined : (last?.endedReason ?? undefined),
      extraCosts: B(st.extraUnsettledF), extraCostShare: B(st.extraCostShareF),
      contributed: B(st.contributedF), paidOut: B(st.paidOutF), offsets: B(st.offsetF),
      profitComputed: B(computedF), profitShare: B(st.profitShareF), settledQty: st.settledQty, owedCost: B(st.owedCostF),
      open: B(st.openF), correctionPending: st.correctionPending, refundPending: st.refundPending,
      ownership: ownershipViewOf(purchaseLineId, branchId), sales, movements, warnings,
    };
    const agg = byPartner.get(partnerId)!;
    agg.items.push(item);
    agg.f.open += st.openF;
    if (st.openF > 0) agg.f.to += st.openF; else agg.f.by -= st.openF;
    agg.f.computed += computedF;
    agg.f.released += st.profitShareF;
    agg.f.paid += st.paidOutF;
    agg.f.contributed += st.contributedF;
  }
  return [...byPartner.values()].map(({ f, ...a }) => ({
    ...a, openTotal: B(f.open), owedToPartner: B(f.to), owedByPartner: B(f.by),
    profitComputed: B(f.computed), profitReleased: B(f.released), paidOut: B(f.paid), contributed: B(f.contributed),
  }));
}

function salesView(e: Epoch, partnerId: string, branchId: string): PartnerItemSale[] {
  const party = e.parties.find((p) => p.partnerId === partnerId);
  if (!party) return [];
  const out: PartnerItemSale[] = [];
  for (const il of saleLinesOfEpoch(e, branchId)) {
    const basis = saleBasisOf(il, branchId);
    const booked = bookedOf(il, partnerId);
    const settled = booked.latest !== null;
    const first = settled
      ? query(`SELECT id FROM item_partner_movements WHERE invoice_line_id = ? AND partner_id = ? AND kind = 'PROFIT_SHARE' AND cancelled_at IS NULL`,
        [il, partnerId])[0]
      : undefined;
    const changed = settled && (basis.pendingReturn || !sameBasis(booked.latest!, basis));
    const state: SaleState = !settled ? 'UNSETTLED' : changed ? 'NEEDS_CORRECTION' : 'SETTLED';
    const blocker = state === 'SETTLED' ? null : saleBlocker(basis, settled);
    let changedAfterSettlement: string | undefined;
    if (changed) {
      if (basis.pendingReturn) changedAfterSettlement = 'return after settlement awaiting decision — payouts wait';
      else if (!basis.exists) changedAfterSettlement = 'the invoice line no longer exists — correct the settlement';
      else if (basis.invoiceStatus === 'CANCELLED') changedAfterSettlement = 'invoice cancelled after settlement — correct the settlement';
      else changedAfterSettlement = 'sale changed after settlement (return or edit) — correct the settlement';
    }
    const unsettledNothing = !settled && basis.qty === 0 && basis.netF === 0 && basis.costF === 0;
    if (unsettledNothing && (!basis.exists || basis.invoiceStatus === 'CANCELLED')) continue;
    out.push({
      invoiceLineId: il, invoiceId: basis.invoiceId, invoiceNumber: basis.invoiceNumber, invoiceStatus: basis.invoiceStatus,
      issuedAt: basis.issuedAt, quantity: basis.qty, profit: B(basis.profitF),
      partnerShare: B(profitShareF(basis.profitF, party.shareBp)), released: B(booked.bookedF),
      state, settled, settlementId: first ? String(first.id) : undefined,
      settleable: state !== 'SETTLED' && !blocker && !unsettledNothing, blocker: blocker?.message, changedAfterSettlement,
    });
  }
  return out;
}

/** Summe der offenen Ausgleiche je Partner (für Listen/Kacheln). */
export function partnerItemOpenTotals(branchId: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of partnerItemsOverview(branchId)) out.set(p.partnerId, p.openTotal);
  return out;
}
