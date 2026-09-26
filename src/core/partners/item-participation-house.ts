// ════════════════════════════════════════════════════════════════════════════
// PARTNER-ITEMS — gemeinsamer Einkauf am Haus: Beteiligung anlegen, Geld zwischen Firma und Partner,
// Verkauf abrechnen und nachabrechnen, verrechnen, Storno, und was die Masken lesen.
//
// Entscheidungen (Nutzer, 26.09.2026):
//   - Beteiligt sind LATAIF und null, ein oder mehrere Partner des Partner-Moduls. LATAIF kauft beim
//     Lieferanten, bezahlt ihn EINMAL und verkauft wie immer; Einkauf, Lieferantenschuld, Lager,
//     Umsatz, VAT und Wareneinsatz bleiben unverändert.
//   - Alles Geld läuft über LATAIFs Kasse/Bank/Benefit und steht auf einem EIGENEN Ausgleichskonto
//     (PARTNER_ITEM_BALANCE), getrennt vom Gesellschafterkapital. Keine Direktzahlung eines Partners
//     an den Lieferanten, keine privaten Ausgleiche zwischen Partnern.
//   - Verteilt wird erst mit einer manuellen Schlussabrechnung (voll bezahlte Rechnung, keine offene
//     Retoure), je Verkauf und Partner einmal; spätere Änderungen am Verkauf werden als Nachabrechnung
//     (nur die Differenz) gebucht, nie durch Löschen.
//
// Die Grundlage eines Verkaufs sind die Beträge des ERP für die Rechnungszeile: Netto (Zeilenbetrag −
// VAT) abzüglich wirksamer Retouren, Wareneinsatz aus dem Hauptbuch (COGS der Zeile abzüglich der
// Rückbuchung einer Retoure ins Lager), verkaufte Menge abzüglich der ins Lager zurückgekommenen
// Stücke. Storno oder gelöschte Zeile → alles 0.
//
// Jede Schreibfolge hier läuft in der Transaktion des Aufrufers (Maske: `runOnPrimary`, fern:
// `runRemoteCommand`) — beide exklusiv. Alle Prüfungen lesen INNERHALB dieser Transaktion; zwei
// Handlungen können denselben offenen Betrag daher nie zweimal verbrauchen.
// ════════════════════════════════════════════════════════════════════════════
import { v4 as uuid } from 'uuid';
import { getDatabase } from '@/core/db/database';
import { query } from '@/core/db/helpers';
import { isClientMode } from '@/core/bridge/client-mode';
import type { PurchaseLineParticipation } from '@/core/models/types';
import { hasLedgerEntries, hasReversalFor, postItemPartnerMovement, reverseSource } from '@/core/ledger/posting';
import {
  B, F, FULL_BP, PartnerItemRejected, itemMovementInput, itemOffsetInput, openBalanceF, owedCostF, planLineParticipation,
  profitShareF,
  PARTNER_ITEM_JOINT_BLOCKED, PARTNER_ITEM_NOT_FOUND, PARTNER_ITEM_OFFSET_INVALID, PARTNER_ITEM_OVERFUNDED,
  PARTNER_ITEM_PAYOUT_EXCEEDS_OPEN, PARTNER_ITEM_PRIMARY_ONLY, PARTNER_ITEM_PURCHASE_CANCELLED, PARTNER_MOVEMENT_CANCELLED,
  PARTNER_MOVEMENT_NOT_FOUND, PARTNER_NOT_ACTIVE, PARTNER_SALE_ALREADY_SETTLED, PARTNER_SALE_NEEDS_CORRECTION,
  PARTNER_SALE_NOT_FOUND, PARTNER_SALE_NOT_PAID, PARTNER_SALE_PENDING,
  type ItemMovementInput, type ItemOffsetInput, type PartnerShareInput,
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

/**
 * Legt je beteiligter Einkaufszeile LATAIF + Partner mit Anteil und Kostenanteil an. Aufgerufen von
 * `createPurchase` in derselben Transaktion wie Beleg, Zeilen und Lose. Zeilen ohne Partner bleiben
 * genau wie bisher — es entsteht keine Zeile.
 */
export function insertLineParticipations(
  ctx: PartnerItemCtx, purchaseId: string,
  lines: ReadonlyArray<{ lineId: string; productId: string | null; lineTotal: number; quantity: number; partnerShares?: readonly PartnerShareInput[] }>,
): number {
  const db = getDatabase();
  let n = 0;
  for (const l of lines) {
    if (!l.partnerShares || l.partnerShares.length === 0) continue;
    const plan = planLineParticipation(l.partnerShares, F(l.lineTotal));
    assertPartnersActive(plan.filter((p) => p.partnerId).map((p) => p.partnerId as string), ctx.branchId);
    for (const p of plan) {
      db.run(
        `INSERT INTO item_participations (id, branch_id, purchase_id, purchase_line_id, product_id, party, partner_id,
           share_bp, cost_share, line_total, quantity, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuid(), ctx.branchId, purchaseId, l.lineId, l.productId, p.party, p.partnerId, p.shareBp, B(p.costShareF),
          l.lineTotal, l.quantity, ctx.now, ctx.userId || null],
      );
      n++;
    }
  }
  return n;
}

// ── Wächter: was ein gemeinsam gekauftes Stück ohne Verkauf aus der Beteiligung nähme ──────────

/** Ist diese Einkaufszeile gemeinsam gekauft? */
export function isJointPurchaseLine(purchaseLineId: string | null | undefined): boolean {
  if (!purchaseLineId) return false;
  return !!query("SELECT 1 FROM item_participations WHERE purchase_line_id = ? AND party = 'PARTNER' LIMIT 1", [purchaseLineId])[0];
}

/** Gehört dieses Los zu einem gemeinsam gekauften Einkauf? */
export function isJointLot(lotId: string | null | undefined): boolean {
  if (!lotId) return false;
  const r = query('SELECT purchase_line_id FROM stock_lots WHERE id = ?', [lotId])[0];
  return isJointPurchaseLine(r?.purchase_line_id ? String(r.purchase_line_id) : null);
}

/** Die Texte der Sperren — die Hausfolgen werfen sie mit ihrem eigenen Fehlertyp und diesem Code. */
export const JOINT_BLOCK = {
  code: PARTNER_ITEM_JOINT_BLOCKED,
  purchaseReturn: 'this item was bought jointly with a partner — a return to the supplier would change what the partner paid for; settle it with the partner first (not supported for jointly bought items)',
  production: 'this item was bought jointly with a partner — it cannot be used up in production (the partner share would be lost)',
  salesReturnDisposition: 'this item was bought jointly with a partner — a return must put it back in stock or write it off (then the partner shares the loss); other dispositions would take it out of the partnership',
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

// ── Die Grundlage eines Verkaufs ────────────────────────────────────────────

export interface SaleBasis {
  invoiceLineId: string;
  exists: boolean;
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
    `SELECT il.id, il.invoice_id, il.line_total, il.vat_amount, il.purchase_price_snapshot, il.quantity,
            i.invoice_number, i.status, COALESCE(i.issued_at, i.created_at) AS issued_at, sl.purchase_line_id
       FROM invoice_lines il
       JOIN invoices i ON i.id = il.invoice_id
       LEFT JOIN stock_lots sl ON sl.id = il.lot_id
      WHERE il.id = ? AND i.branch_id = ?`,
    [invoiceLineId, branchId],
  )[0];
  const zero = { qty: 0, netF: 0, costF: 0, profitF: 0 };
  if (!r) {
    return { invoiceLineId, exists: false, invoiceId: '', invoiceNumber: '', invoiceStatus: 'MISSING', issuedAt: '',
      purchaseLineId: null, pendingReturn: false, ...zero };
  }
  const base = {
    invoiceLineId, exists: true, invoiceId: String(r.invoice_id), invoiceNumber: String(r.invoice_number ?? ''),
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

/** Alle Verkaufszeilen einer beteiligten Einkaufszeile — über das Los, und abgerechnete, die es nicht mehr gibt. */
function saleLinesOf(purchaseLineId: string, branchId: string): string[] {
  const ids = query(
    `SELECT il.id FROM invoice_lines il
       JOIN stock_lots sl ON sl.id = il.lot_id
       JOIN invoices i ON i.id = il.invoice_id
      WHERE sl.purchase_line_id = ? AND i.branch_id = ?
      ORDER BY COALESCE(i.issued_at, i.created_at), il.id`,
    [purchaseLineId, branchId],
  ).map((r) => String(r.id));
  for (const r of query(
    `SELECT DISTINCT invoice_line_id FROM item_partner_movements
      WHERE purchase_line_id = ? AND invoice_line_id IS NOT NULL AND cancelled_at IS NULL`,
    [purchaseLineId],
  )) {
    const id = String(r.invoice_line_id);
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
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
  // Nachabrechnung: eine stornierte oder gelöschte Zeile geht immer (alles auf 0); eine geänderte
  // erst, wenn die Rechnung wieder voll bezahlt ist — sonst wäre ein Gewinn vorzeitig verteilt.
  if (!basis.exists || basis.invoiceStatus === 'CANCELLED' || basis.invoiceStatus === 'FINAL') return null;
  return { code: PARTNER_SALE_NOT_PAID, message: `invoice ${basis.invoiceNumber} changed and is not fully paid (${basis.invoiceStatus}) — the correction waits for full payment` };
}

// ── Stand je Partner und Zeile ──────────────────────────────────────────────

interface ParticipationRow {
  purchaseId: string;
  purchaseLineId: string;
  partnerId: string;
  shareBp: number;
  costShareF: number;
  lineTotalF: number;
  quantity: number;
  unitPriceF: number;
  purchaseStatus: string;
}

function participationOf(purchaseLineId: string, partnerId: string, branchId: string): ParticipationRow {
  const r = query(
    `SELECT ip.purchase_id, ip.purchase_line_id, ip.partner_id, ip.share_bp, ip.cost_share, ip.line_total, ip.quantity,
            pl.unit_price, COALESCE(p.status, '') AS purchase_status
       FROM item_participations ip
       LEFT JOIN purchases p ON p.id = ip.purchase_id
       LEFT JOIN purchase_lines pl ON pl.id = ip.purchase_line_id
      WHERE ip.purchase_line_id = ? AND ip.partner_id = ? AND ip.branch_id = ? AND ip.party = 'PARTNER'`,
    [purchaseLineId, partnerId, branchId],
  )[0];
  if (!r) throw nein(PARTNER_ITEM_NOT_FOUND, 'this partner holds no share in this item');
  return rowToParticipation(r);
}

function rowToParticipation(r: Record<string, unknown>): ParticipationRow {
  const quantity = Number(r.quantity) || 1;
  const lineTotalF = F(r.line_total);
  return {
    purchaseId: String(r.purchase_id), purchaseLineId: String(r.purchase_line_id), partnerId: String(r.partner_id),
    shareBp: Number(r.share_bp), costShareF: F(r.cost_share), lineTotalF, quantity,
    unitPriceF: r.unit_price !== undefined && r.unit_price !== null ? F(r.unit_price) : Math.round(lineTotalF / quantity),
    purchaseStatus: String(r.purchase_status ?? ''),
  };
}

export interface LineState {
  contributedF: number;
  paidOutF: number;
  profitShareF: number;
  offsetF: number;
  settledQty: number;
  /** Nachträglich aktivierte Kosten der noch nicht abgerechneten Stücke (alle Beteiligten). */
  extraUnsettledF: number;
  extraCostShareF: number;
  openF: number;
  owedCostF: number;
  /** Ein abgerechneter Verkauf dieser Zeile weicht vom heutigen Stand ab, oder eine Retoure ist offen. */
  correctionPending: boolean;
}

/**
 * Der Stand EINES Partners an EINER Zeile. Nachträgliche Kosten: das ERP aktiviert Reparaturkosten
 * eigener Ware im Los-Einstand (je verbleibendem Stück) und nur vor dem Verkauf — was davon auf noch
 * nicht abgerechnete Stücke fällt, trägt der Partner nach seinem Anteil mit.
 */
function lineStateOf(p: ParticipationRow, branchId: string): LineState {
  const rows = query(
    `SELECT kind, amount FROM item_partner_movements WHERE purchase_line_id = ? AND partner_id = ? AND cancelled_at IS NULL`,
    [p.purchaseLineId, p.partnerId],
  );
  const s = { contributedF: 0, paidOutF: 0, profitShareF: 0, offsetF: 0 };
  for (const r of rows) {
    if (r.kind === 'CONTRIBUTION') s.contributedF += F(r.amount);
    else if (r.kind === 'PAYOUT') s.paidOutF += F(r.amount);
    else if (r.kind === 'PROFIT_SHARE' || r.kind === 'PROFIT_CORRECTION') s.profitShareF += F(r.amount);
    else if (r.kind === 'OFFSET') s.offsetF += F(r.amount);
  }
  let settledQty = 0;
  let extraUnsettledF = 0;
  let correctionPending = false;
  for (const il of saleLinesOf(p.purchaseLineId, branchId)) {
    const basis = saleBasisOf(il, branchId);
    const booked = bookedOf(il, p.partnerId);
    if (booked.latest) {
      settledQty += booked.latest.qty;
      if (basis.pendingReturn || !sameBasis(booked.latest, basis)) correctionPending = true;
    } else if (basis.exists && basis.invoiceStatus !== 'CANCELLED' && basis.qty > 0) {
      // Verkauft, noch nicht abgerechnet: sein Einstand (inkl. aktivierter Kosten) steht noch aus.
      extraUnsettledF += basis.costF - p.unitPriceF * basis.qty;
    }
  }
  for (const l of query(
    `SELECT qty_remaining, unit_cost FROM stock_lots WHERE purchase_line_id = ? AND status != 'CANCELLED' AND qty_remaining > 0`,
    [p.purchaseLineId],
  )) {
    const q = Number(l.qty_remaining) || 0;
    extraUnsettledF += F(q * (Number(l.unit_cost) || 0)) - p.unitPriceF * q;
  }
  const cancelled = p.purchaseStatus === 'CANCELLED';
  const extraCostShareF = cancelled ? 0 : Math.round(extraUnsettledF * p.shareBp / FULL_BP);
  const state = {
    costShareF: p.costShareF, quantity: p.quantity, settledQty, contributedF: s.contributedF, paidOutF: s.paidOutF,
    profitShareF: s.profitShareF, offsetF: s.offsetF, extraCostShareF, purchaseCancelled: cancelled,
  };
  return {
    ...s, settledQty, extraUnsettledF, extraCostShareF, correctionPending,
    openF: openBalanceF(state), owedCostF: owedCostF(state),
  };
}

/** Offener Ausgleich eines Partners an einer Zeile in BHD (positiv = LATAIF schuldet dem Partner). */
export function partnerItemOpen(purchaseLineId: string, partnerId: string, branchId: string): number {
  return B(lineStateOf(participationOf(purchaseLineId, partnerId, branchId), branchId).openF);
}

function insertMovement(ctx: PartnerItemCtx, m: {
  purchaseId: string; purchaseLineId: string; partnerId: string; kind: string; amountF: number; method?: string | null;
  occurredAt: string; invoiceId?: string | null; invoiceLineId?: string | null; basis?: unknown; groupId?: string | null; note?: string | null;
}): string {
  const id = uuid();
  getDatabase().run(
    `INSERT INTO item_partner_movements (id, branch_id, purchase_id, purchase_line_id, partner_id, kind, amount, method,
       occurred_at, invoice_id, invoice_line_id, basis_json, group_id, note, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, ctx.branchId, m.purchaseId, m.purchaseLineId, m.partnerId, m.kind, B(m.amountF), m.method ?? null, m.occurredAt,
      m.invoiceId ?? null, m.invoiceLineId ?? null, m.basis === undefined ? null : JSON.stringify(m.basis), m.groupId ?? null,
      m.note ?? null, ctx.now, ctx.userId || null],
  );
  return id;
}

// ── Beitrag und Auszahlung ──────────────────────────────────────────────────

export interface ItemMovementRecorded {
  movementId: string;
  kind: 'CONTRIBUTION' | 'PAYOUT';
  amount: number;
  open: number;
}

/**
 * „Beitrag erfassen" (Partner → Firma, auch Rückzahlung einer Nachabrechnung) oder „Auszahlen"
 * (Firma → Partner). Ein Beitrag darf die Zeile nicht über ihren Einstand hinaus finanzieren — außer
 * er begleicht, was der Partner LATAIF schuldet. Eine Auszahlung höchstens, was LATAIF an dieser Zeile
 * schuldet, und nicht, solange ein abgerechneter Verkauf nachabgerechnet werden muss. Die
 * Lieferantenzahlung bleibt unberührt: das ist Geld zwischen Firma und Partner.
 */
export function recordItemMovementInHouse(raw: ItemMovementInput, ctx: PartnerItemCtx): ItemMovementRecorded {
  assertItemBooksHere();
  const v = itemMovementInput(raw as unknown as Record<string, unknown>);
  const p = participationOf(v.purchaseLineId, v.partnerId, ctx.branchId);
  const st = lineStateOf(p, ctx.branchId);
  const amountF = F(v.amount);
  if (v.kind === 'CONTRIBUTION') {
    const funded = query(
      `SELECT COALESCE(SUM(CASE WHEN kind = 'CONTRIBUTION' THEN amount WHEN kind = 'PAYOUT' THEN -amount ELSE 0 END), 0) AS t
         FROM item_partner_movements WHERE purchase_line_id = ? AND cancelled_at IS NULL`,
      [v.purchaseLineId],
    )[0];
    const capF = p.purchaseStatus === 'CANCELLED' ? 0 : p.lineTotalF + Math.max(0, st.extraUnsettledF) - F(funded?.t);
    const allowedF = Math.max(capF, -st.openF);
    if (amountF > allowedF) {
      if (p.purchaseStatus === 'CANCELLED' && st.openF >= 0) {
        throw nein(PARTNER_ITEM_PURCHASE_CANCELLED, 'this purchase is cancelled — no contribution can be booked on it');
      }
      throw nein(PARTNER_ITEM_OVERFUNDED,
        `at most ${bhd(Math.max(0, allowedF))} BHD can be contributed on this item (its cost is ${bhd(p.lineTotalF + Math.max(0, st.extraUnsettledF))} BHD)`);
    }
  } else {
    if (st.correctionPending) {
      throw nein(PARTNER_SALE_NEEDS_CORRECTION, 'a settled sale of this item changed (return, cancellation or edit) — correct the settlement before paying out');
    }
    if (amountF > st.openF) {
      throw nein(PARTNER_ITEM_PAYOUT_EXCEEDS_OPEN,
        st.openF > 0 ? `LATAIF owes this partner ${bhd(st.openF)} BHD on this item — pay out at most that` : 'LATAIF owes this partner nothing on this item');
    }
  }
  const id = insertMovement(ctx, {
    purchaseId: p.purchaseId, purchaseLineId: v.purchaseLineId, partnerId: v.partnerId, kind: v.kind, amountF,
    method: v.method, occurredAt: v.date, note: v.note ?? null,
  });
  postItemPartnerMovement({
    id, partnerId: v.partnerId, kind: v.kind, amount: B(amountF), method: v.method, occurredAt: v.date, purchaseLineId: v.purchaseLineId,
  });
  return { movementId: id, kind: v.kind, amount: B(amountF), open: B(lineStateOf(p, ctx.branchId).openF) };
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
  const from = participationOf(v.fromPurchaseLineId, v.partnerId, ctx.branchId);
  const to = participationOf(v.toPurchaseLineId, v.partnerId, ctx.branchId);
  const sFrom = lineStateOf(from, ctx.branchId);
  const sTo = lineStateOf(to, ctx.branchId);
  if (sFrom.correctionPending || sTo.correctionPending) {
    throw nein(PARTNER_SALE_NEEDS_CORRECTION, 'a settled sale of one of these items changed — correct the settlement first');
  }
  const amountF = F(v.amount);
  if (amountF > sFrom.openF) throw nein(PARTNER_ITEM_OFFSET_INVALID, `LATAIF owes the partner at most ${bhd(Math.max(0, sFrom.openF))} BHD on the first item`);
  if (amountF > -sTo.openF) throw nein(PARTNER_ITEM_OFFSET_INVALID, `the partner owes at most ${bhd(Math.max(0, -sTo.openF))} BHD on the second item`);
  const groupId = uuid();
  insertMovement(ctx, {
    purchaseId: from.purchaseId, purchaseLineId: from.purchaseLineId, partnerId: v.partnerId, kind: 'OFFSET', amountF: -amountF,
    occurredAt: v.date, groupId, note: v.note ?? null, basis: { counterpartLineId: to.purchaseLineId },
  });
  insertMovement(ctx, {
    purchaseId: to.purchaseId, purchaseLineId: to.purchaseLineId, partnerId: v.partnerId, kind: 'OFFSET', amountF,
    occurredAt: v.date, groupId, note: v.note ?? null, basis: { counterpartLineId: from.purchaseLineId },
  });
  return {
    groupId, amount: B(amountF),
    openFrom: B(lineStateOf(from, ctx.branchId).openF), openTo: B(lineStateOf(to, ctx.branchId).openF),
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
 * „Verkauf abrechnen": der Gewinn des Verkaufs nach der Regel des ERP, je Partner nach seinem Anteil
 * auf sein Ausgleichskonto (Verlust negativ). LATAIFs Anteil bleibt im Ergebnis der Firma.
 * Ist der Verkauf schon abgerechnet und hat er sich seither geändert (Retoure, Storno, zulässige
 * Änderung), bucht dieselbe Handlung die DIFFERENZ als Nachabrechnung am heutigen Tag — die
 * Erstabrechnung und alle Auszahlungen bleiben stehen. Was der Partner dadurch zurückschuldet, steht
 * als negativer offener Betrag da: Rückzahlung oder Verrechnung.
 */
export function settleSaleLineInHouse(invoiceLineId: string, ctx: PartnerItemCtx): SaleSettled {
  assertItemBooksHere();
  if (typeof invoiceLineId !== 'string' || !invoiceLineId) throw nein(PARTNER_SALE_NOT_FOUND, 'no sale line given');
  const basis = saleBasisOf(invoiceLineId, ctx.branchId);
  const purchaseLineId = basis.purchaseLineId ?? String(query(
    `SELECT purchase_line_id FROM item_partner_movements WHERE invoice_line_id = ? AND branch_id = ? LIMIT 1`,
    [invoiceLineId, ctx.branchId],
  )[0]?.purchase_line_id ?? '');
  if (!purchaseLineId) throw nein(PARTNER_SALE_NOT_FOUND, 'no sale of a jointly bought item with this line');
  const partners = query(
    `SELECT ip.purchase_id, ip.purchase_line_id, ip.partner_id, ip.share_bp, ip.cost_share, ip.line_total, ip.quantity,
            pl.unit_price, COALESCE(p.status, '') AS purchase_status
       FROM item_participations ip
       LEFT JOIN purchases p ON p.id = ip.purchase_id
       LEFT JOIN purchase_lines pl ON pl.id = ip.purchase_line_id
      WHERE ip.purchase_line_id = ? AND ip.branch_id = ? AND ip.party = 'PARTNER' ORDER BY ip.created_at, ip.partner_id`,
    [purchaseLineId, ctx.branchId],
  ).map(rowToParticipation);
  if (partners.length === 0) throw nein(PARTNER_SALE_NOT_FOUND, 'this item was not bought jointly');
  const booked = partners.map((p) => bookedOf(invoiceLineId, p.partnerId));
  const settled = booked.some((b) => b.latest !== null);
  const blocker = saleBlocker(basis, settled);
  if (blocker) throw nein(blocker.code, blocker.message);
  if (!settled && basis.qty === 0 && basis.netF === 0 && basis.costF === 0) {
    throw nein(PARTNER_SALE_NOT_FOUND, `the sale on invoice ${basis.invoiceNumber} was fully returned — there is nothing to settle`);
  }
  if (settled && booked.every((b) => b.latest && sameBasis(b.latest, basis))) {
    throw nein(PARTNER_SALE_ALREADY_SETTLED, `the sale on invoice ${basis.invoiceNumber || '(deleted)'} is already settled and has not changed`);
  }
  const mode: SaleSettled['mode'] = settled ? 'CORRECTION' : 'SETTLEMENT';
  const occurredAt = dayOf(ctx.now);
  const groupId = uuid();
  const shares: SaleSettled['shares'] = [];
  partners.forEach((p, i) => {
    const targetF = profitShareF(basis.profitF, p.shareBp);
    const deltaF = targetF - booked[i].bookedF;
    const kind = mode === 'SETTLEMENT' ? 'PROFIT_SHARE' : 'PROFIT_CORRECTION';
    const id = insertMovement(ctx, {
      purchaseId: p.purchaseId, purchaseLineId, partnerId: p.partnerId, kind, amountF: deltaF, occurredAt,
      invoiceId: basis.invoiceId || null, invoiceLineId, groupId,
      basis: {
        invoiceNumber: basis.invoiceNumber, invoiceStatus: basis.invoiceStatus, qty: basis.qty, net: B(basis.netF),
        cost: B(basis.costF), profit: B(basis.profitF), shareBp: p.shareBp, target: B(targetF), previous: B(booked[i].bookedF),
      },
    });
    postItemPartnerMovement({
      id, partnerId: p.partnerId, kind, amount: B(deltaF), occurredAt, purchaseLineId, invoiceLineId,
    });
    shares.push({ partnerId: p.partnerId, movementId: id, amount: B(deltaF), total: B(targetF) });
  });
  return { invoiceLineId, invoiceNumber: basis.invoiceNumber, mode, profit: B(basis.profitF), quantity: basis.qty, shares };
}

// ── Storno ──────────────────────────────────────────────────────────────────

/**
 * Eine Partnerbuchung zurücknehmen — gedacht für Erfassungsfehler: die Zeile bleibt als Verlauf,
 * die Buchung wird gegengebucht. Was EINE Handlung war (Abrechnung/Nachabrechnung aller Partner,
 * Verrechnungspaar), wird gemeinsam zurückgenommen; eine Erstabrechnung samt ihren Nachabrechnungen.
 * Nichts wird zurückgenommen, wonach für dieselbe Zeile und denselben Partner schon etwas gebucht
 * wurde — eine spätere Auszahlung bleibt wirksam, eine Änderung am Verkauf läuft über die
 * Nachabrechnung.
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

/** Die Beteiligungen eines Einkaufs, je Zeile (leer = allein gekauft). */
export function participationsOfPurchase(purchaseId: string, branchId: string): PurchaseLineParticipation[] {
  const rows = query(
    `SELECT ip.purchase_line_id, ip.party, ip.partner_id, ip.share_bp, ip.cost_share, pr.name, pr.active
       FROM item_participations ip LEFT JOIN partners pr ON pr.id = ip.partner_id
      WHERE ip.purchase_id = ? AND ip.branch_id = ?
      ORDER BY ip.purchase_line_id, CASE ip.party WHEN 'HOUSE' THEN 0 ELSE 1 END, pr.name`,
    [purchaseId, branchId],
  );
  const byLine = new Map<string, PurchaseLineParticipation>();
  for (const r of rows) {
    const key = String(r.purchase_line_id);
    if (!byLine.has(key)) byLine.set(key, { purchaseLineId: key, parties: [] });
    const house = r.party === 'HOUSE';
    byLine.get(key)!.parties.push({
      party: house ? 'HOUSE' : 'PARTNER', partnerId: house ? null : String(r.partner_id),
      name: house ? 'LATAIF' : String(r.name ?? r.partner_id), active: house || Number(r.active) === 1,
      sharePct: Number(r.share_bp) / 100, costShare: Number(r.cost_share) || 0,
    });
  }
  return [...byLine.values()];
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
  /** Kann jetzt abgerechnet (UNSETTLED) bzw. nachabgerechnet (NEEDS_CORRECTION) werden. */
  settleable: boolean;
  blocker?: string;
  /** Was sich seit der Abrechnung geändert hat. */
  changedAfterSettlement?: string;
}

export interface PartnerItemMovementView {
  id: string;
  kind: 'CONTRIBUTION' | 'PAYOUT' | 'PROFIT_SHARE' | 'PROFIT_CORRECTION' | 'OFFSET';
  amount: number;
  method: string | null;
  occurredAt: string;
  invoiceNumber?: string;
  note?: string;
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
  /** Nachträglich aktivierte Kosten auf noch nicht abgerechneten Stücken (alle Beteiligten) und der Partneranteil daran. */
  extraCosts: number;
  extraCostShare: number;
  contributed: number;
  paidOut: number;
  offsets: number;
  /** Rechnerischer Gewinnanteil aus voll bezahlten Verkäufen (heute). */
  profitComputed: number;
  /** Zur Abrechnung freigegeben (gebucht). */
  profitShare: number;
  settledQty: number;
  /** Noch geschuldeter Kostenanteil der nicht abgerechneten Stücke. */
  owedCost: number;
  /** Positiv: LATAIF schuldet dem Partner. Negativ: der Partner schuldet LATAIF. */
  open: number;
  correctionPending: boolean;
  sales: PartnerItemSale[];
  movements: PartnerItemMovementView[];
  warnings: string[];
}

export interface PartnerItemsOfPartner {
  partnerId: string;
  name: string;
  active: boolean;
  items: PartnerItemView[];
  /** Summe der offenen Ausgleiche über alle Artikel. */
  openTotal: number;
  owedToPartner: number;
  owedByPartner: number;
  profitComputed: number;
  profitReleased: number;
  paidOut: number;
  contributed: number;
}

/** Die Artikelbeteiligungen aller Partner einer Filiale — auch deaktivierter (historisch). */
export function partnerItemsOverview(branchId: string, onlyPartnerId?: string): PartnerItemsOfPartner[] {
  const parts = query(
    `SELECT ip.purchase_id, ip.purchase_line_id, ip.partner_id, ip.share_bp, ip.cost_share, ip.line_total, ip.quantity,
            ip.product_id, pl.unit_price, pr.name AS partner_name, pr.active AS partner_active,
            p.purchase_number, p.purchase_date, COALESCE(p.status, '') AS purchase_status,
            pd.brand, pd.name AS product_name, pd.sku
       FROM item_participations ip
       LEFT JOIN partners pr ON pr.id = ip.partner_id
       LEFT JOIN purchases p ON p.id = ip.purchase_id
       LEFT JOIN purchase_lines pl ON pl.id = ip.purchase_line_id
       LEFT JOIN products pd ON pd.id = ip.product_id
      WHERE ip.branch_id = ? AND ip.party = 'PARTNER' ${onlyPartnerId ? 'AND ip.partner_id = ?' : ''}
      ORDER BY pr.name, p.purchase_date DESC, p.purchase_number DESC`,
    onlyPartnerId ? [branchId, onlyPartnerId] : [branchId],
  );
  const byPartner = new Map<string, PartnerItemsOfPartner & { f: Record<string, number> }>();
  for (const r of parts) {
    const p = rowToParticipation(r);
    if (!byPartner.has(p.partnerId)) {
      byPartner.set(p.partnerId, {
        partnerId: p.partnerId, name: String(r.partner_name ?? p.partnerId), active: Number(r.partner_active) === 1, items: [],
        openTotal: 0, owedToPartner: 0, owedByPartner: 0, profitComputed: 0, profitReleased: 0, paidOut: 0, contributed: 0,
        f: { open: 0, to: 0, by: 0, computed: 0, released: 0, paid: 0, contributed: 0 },
      });
    }
    const st = lineStateOf(p, branchId);
    const sales = salesView(p, branchId);
    const computedF = sales.filter((s) => s.invoiceStatus === 'FINAL').reduce((a, s) => a + F(s.partnerShare), 0);
    const movements: PartnerItemMovementView[] = query(
      `SELECT m.id, m.kind, m.amount, m.method, m.occurred_at, m.note, m.cancelled_at, i.invoice_number, m.basis_json
         FROM item_partner_movements m LEFT JOIN invoices i ON i.id = m.invoice_id
        WHERE m.purchase_line_id = ? AND m.partner_id = ?
        ORDER BY m.rowid`,
      [p.purchaseLineId, p.partnerId],
    ).map((m) => {
      let invoiceNumber = m.invoice_number ? String(m.invoice_number) : undefined;
      if (!invoiceNumber && m.basis_json) { try { invoiceNumber = JSON.parse(String(m.basis_json)).invoiceNumber || undefined; } catch { /* - */ } }
      return {
        id: String(m.id), kind: m.kind as PartnerItemMovementView['kind'], amount: Number(m.amount) || 0,
        method: m.method ? String(m.method) : null, occurredAt: String(m.occurred_at ?? ''), invoiceNumber,
        note: m.note ? String(m.note) : undefined, cancelled: !!m.cancelled_at,
      };
    });
    const warnings: string[] = [];
    if (p.purchaseStatus === 'CANCELLED') warnings.push('Purchase cancelled — the cost share no longer applies; contributions can be paid back.');
    for (const s of sales) if (s.changedAfterSettlement) warnings.push(`${s.invoiceNumber || 'Sale'}: ${s.changedAfterSettlement}`);
    const item: PartnerItemView = {
      purchaseLineId: p.purchaseLineId, purchaseId: p.purchaseId, purchaseNumber: String(r.purchase_number ?? ''),
      purchaseDate: String(r.purchase_date ?? ''), purchaseStatus: p.purchaseStatus,
      productId: r.product_id ? String(r.product_id) : null,
      productLabel: [r.brand, r.product_name].filter(Boolean).join(' ') || 'Item',
      sku: String(r.sku ?? ''), quantity: p.quantity, lineTotal: B(p.lineTotalF), sharePct: p.shareBp / 100,
      costShare: B(p.costShareF), extraCosts: B(st.extraUnsettledF), extraCostShare: B(st.extraCostShareF),
      contributed: B(st.contributedF), paidOut: B(st.paidOutF), offsets: B(st.offsetF),
      profitComputed: B(computedF), profitShare: B(st.profitShareF), settledQty: st.settledQty, owedCost: B(st.owedCostF),
      open: B(st.openF), correctionPending: st.correctionPending, sales, movements, warnings,
    };
    const agg = byPartner.get(p.partnerId)!;
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

function salesView(p: ParticipationRow, branchId: string): PartnerItemSale[] {
  const out: PartnerItemSale[] = [];
  for (const il of saleLinesOf(p.purchaseLineId, branchId)) {
    const basis = saleBasisOf(il, branchId);
    const booked = bookedOf(il, p.partnerId);
    const settled = booked.latest !== null;
    const first = settled
      ? query(`SELECT id FROM item_partner_movements WHERE invoice_line_id = ? AND partner_id = ? AND kind = 'PROFIT_SHARE' AND cancelled_at IS NULL`,
        [il, p.partnerId])[0]
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
      partnerShare: B(profitShareF(basis.profitF, p.shareBp)), released: B(booked.bookedF),
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
