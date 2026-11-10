// ════════════════════════════════════════════════════════════════════════════
// CUSTOMER ACCOUNT C — „Settle Balance" im Kundenkonto: mehrere Rechnungen gegen Store Credit und We Borrowed desselben
// Kunden, OHNE Geld, unter EINER Nummer STL-…, in EINER Transaktion (Primary: `runOnPrimary`; PC2: der Fernbefehl
// `customers.settle_balance` in `runRemoteCommand`, Wiederholung wirkt einmal). Alles oder nichts.
//
// Keine zweite Buchhaltung — jede Zuordnung läuft über den VORHANDENEN Weg ihrer Art:
//   • Store Credit → Rechnung: die vorhandene Anrechnung (`applyCreditToInvoice`, Zahlart 'credit', `credit_applications`,
//     Soll CUSTOMER_CREDIT / Haben AR) — mit GENAU dem gewählten Guthaben und dem Tag der Verrechnung;
//   • We Borrowed → Rechnung: die B1-Hausfolge (`createDebtOffsetInHouse`, Zahlart 'debt_offset', Soll LOAN_PAYABLE /
//     Haben AR, Rückzahlungszeile 'offset' am Darlehen ohne eigene Buchung).
// Status, Endnummer (Normal/Special je voll bezahlter Rechnung, höchstens einmal), VAT-Periodensperren und Exportmonat
// folgen unverändert der Regel jeder Zahlung. Jede Zuordnung ist eine Zeile in `party_offsets` (`STL-…/n`), alle tragen
// die gemeinsame `settlement_number`.
//
// Geprüft wird IN der Transaktion, gegen den frischen Stand: dieselbe Filiale, derselbe Kunde, der Fingerabdruck aller
// angebotenen Posten (sonst OPEN_ITEMS_CHANGED → die Maske rechnet neu), die Summe, die das Fenster gezeigt hat, der Tag,
// die Endnummernwahl. Rückgängig: eine Zuordnung auf der Rechnung („Remove offset") oder die ganze STL
// (`reverseSettlementInHouse`) — beides über `deletePayment` (Gegenbuchung; Guthaben bzw. Darlehen wieder offen).
// ════════════════════════════════════════════════════════════════════════════
import { v4 as uuid } from 'uuid';
import { getDatabase } from '@/core/db/database';
import { query, currentUserId, getNextDocumentNumber } from '@/core/db/helpers';
import { trackInsert } from '@/core/sync/track';
import { logAuditOrThrow } from '@/core/audit/audit-log';
import { hasLedgerEntries } from '@/core/ledger/posting';
import { runOnPrimary } from '@/core/data/primary-action';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { useDebtStore } from '@/stores/debtStore';
import { useCustomerStore } from '@/stores/customerStore';
import { useAuthStore } from '@/stores/authStore';
import { InvoiceActionRejected } from '@/core/invoices/invoice-cancel';
import { assertInvoiceHouse, localInvoiceBranch } from '@/core/invoices/invoice-house-guards';
import { businessDateIssue, businessTimestamp } from '@/core/utils/business-date';
import { OPENING_CUTOFF_DATE } from '@/core/parties/opening-balances';
import { OPEN_ITEMS_CHANGED, OPEN_STAMP_REQUIRED } from '@/core/finance/open-items-stamp';
import { roleMayRunOp } from '@/core/bridge/command-permissions';
import { createDebtOffsetInHouse } from './party-offsets';
import { createPurchaseOffsetInHouse } from './purchase-offsets';
import { OFFSET_PAYABLE_STORE_CREDIT, OffsetRestoreError, assertOffsetUndoSafe } from './party-offset-restore';
export { OFFSET_HAS_LATER_RETURN, assertOffsetUndoSafe } from './party-offset-restore';
import {
  OP_CUSTOMERS_SETTLE_BALANCE, OP_CUSTOMERS_SETTLEMENT_REVERSE, finalizingInvoices, planSettlementRows, settleBalanceFor,
  settlePairKey, type SettlePair, type SettleSourceKind,
} from './party-settlement-reads';

export const SETTLE_NOTHING_TO_OFFSET = 'SETTLE_NOTHING_TO_OFFSET';
export const SETTLE_SELECTION_INVALID = 'SETTLE_SELECTION_INVALID';
export const SETTLE_TOTAL_CHANGED = 'SETTLE_TOTAL_CHANGED';
export const SETTLE_SOURCE_CHANGED = 'SETTLE_SOURCE_CHANGED';
export const FINAL_NUMBER_CHOICE_REQUIRED = 'FINAL_NUMBER_CHOICE_REQUIRED';
export const SETTLEMENT_NOT_FOUND = 'SETTLEMENT_NOT_FOUND';
export const SETTLEMENT_ALREADY_REVERSED = 'OFFSET_ALREADY_REVERSED';
export const SETTLE_PERMISSION_DENIED = 'PERMISSION_DENIED';
/** B2/B3 Nachbesserung — ein von Hand gesetzter Betrag ist keine gültige BHD-Zahl oder gehört zu keiner Zuordnung. */
export const SETTLE_AMOUNT_INVALID = 'SETTLE_AMOUNT_INVALID';
/** B2/B3 Nachbesserung — ein von Hand gesetzter Betrag übersteigt den offenen Rest der Rechnung oder des Gegenpostens. */
export const SETTLE_AMOUNT_TOO_HIGH = 'SETTLE_AMOUNT_TOO_HIGH';
/** Höchstzahl von Hand gesetzter Beträge in einem Auftrag. */
const MAX_HAND_AMOUNTS = 200;

const F = (n: unknown): number => Math.round((Number(n) || 0) * 1000);
const B = (f: number): number => f / 1000;
const nein = (code: string, msg: string): InvoiceActionRejected => new InvoiceActionRejected(code, `${msg} — nothing was offset`);
const todayLocal = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** Ein von Hand gesetzter Betrag einer Zuordnung (Gegenposten → Rechnung), BHD mit höchstens drei Nachkommastellen; 0 = ausgelassen. */
export interface SettleAmountLine { invoiceId: string; sourceId: string; amount: number }

export interface SettleBalanceRequest {
  customerId: string;
  /** Die angehakten Rechnungen und Gegenposten (Kennungen) — die Zuordnung rechnet das Haus mit derselben Regel neu. */
  invoiceIds: string[];
  sourceIds: string[];
  /** Geschäftstag der Verrechnung (JJJJ-MM-TT); fehlt er: heute. */
  settlementDate?: string;
  /** Pflicht: der Fingerabdruck, den das Fenster gezeigt hat (`stamp` der Auskunft). */
  expectedStamp?: string;
  /** Pflicht: die Gesamtsumme, die das Fenster gezeigt hat. */
  expectedTotal?: number;
  /** Je Rechnung, die dadurch VOLL bezahlt wird und noch keine Endnummer hat: 'normal' oder 'special'. */
  finalNumbers?: Record<string, 'normal' | 'special'>;
  /**
   * B2/B3 Nachbesserung (Owner 10.11.2026) — „Betrag ändern": je Zuordnung ein von Hand gesetzter Betrag (voll oder teilweise).
   * Fehlt er, gilt der Vorschlag (kleinerer Rest). Das Haus rechnet mit derselben Regel neu und prüft jede Obergrenze.
   */
  amounts?: SettleAmountLine[];
}

export interface SettlementBookedLine {
  offsetNumber: string; invoiceId: string; invoiceNumber: string; invoiceStatus: string; invoiceOpenAfter: number;
  sourceKind: SettleSourceKind; sourceId: string; sourceNumber: string; sourceOpenAfter: number; amount: number; paymentId: string;
}
export interface SettlementBooked {
  settlementNumber: string; customerId: string; settlementDate: string; total: number; lines: SettlementBookedLine[];
}

/** In der Transaktion des Aufrufers: die gewählten Posten verrechnen — alles unter einer STL-Nummer, oder nichts. */
export function settleBalanceInHouse(req: SettleBalanceRequest, ctx: { branchId: string; userId?: string }): SettlementBooked {
  assertInvoiceHouse(ctx.branchId);
  if (!isStr(req.customerId)) throw nein('CUSTOMER_REQUIRED', 'choose the client');
  if (!query("SELECT 1 FROM customers WHERE id = ? AND branch_id = ? AND id NOT LIKE 'sys-%'", [req.customerId, ctx.branchId])[0]) {
    throw nein('CUSTOMER_NOT_FOUND', 'no such client in this branch');
  }
  const ids = (v: unknown): string[] | null => (Array.isArray(v) && v.every(isStr) && new Set(v).size === v.length ? v : null);
  const invoiceIds = ids(req.invoiceIds);
  const sourceIds = ids(req.sourceIds);
  if (!invoiceIds || !sourceIds) throw nein(SETTLE_SELECTION_INVALID, 'the selection must name each invoice and counter item once');

  // ── Der frische Stand — nur gegen das, was das Fenster gezeigt hat.
  const read = settleBalanceFor(ctx, req.customerId);
  if (!isStr(req.expectedStamp)) throw nein(OPEN_STAMP_REQUIRED, 'the settlement must name the open items it was made for — reload the window');
  if (read.stamp !== req.expectedStamp) {
    throw nein(OPEN_ITEMS_CHANGED, 'the open items changed since this window was opened (a payment, offset or change) — the proposal is calculated again, check it and confirm again');
  }
  if (invoiceIds.some((id) => !read.invoices.some((i) => i.id === id)) || sourceIds.some((id) => !read.sources.some((s) => s.id === id))) {
    throw nein(SETTLE_SELECTION_INVALID, 'an item of the selection is not open for this client (or is not offered here)');
  }
  // ── Von Hand gesetzte Beträge: gültige BHD (≤ 3 Nachkommastellen, ≥ 0), je Zuordnung einmal, nur gewählte Posten.
  const handF: Record<string, number> = {};
  if (req.amounts !== undefined) {
    if (!Array.isArray(req.amounts) || req.amounts.length > MAX_HAND_AMOUNTS) throw nein(SETTLE_AMOUNT_INVALID, 'the changed amounts must be a list');
    for (const a of req.amounts) {
      const x = a as Partial<SettleAmountLine> | null;
      if (!x || !isStr(x.invoiceId) || !isStr(x.sourceId) || typeof x.amount !== 'number' || !Number.isFinite(x.amount) || x.amount < 0) {
        throw nein(SETTLE_AMOUNT_INVALID, 'a changed amount must name the invoice, the counter item and an amount of 0 or more');
      }
      const f = x.amount * 1000;
      if (Math.abs(f - Math.round(f)) > 1e-6) throw nein(SETTLE_AMOUNT_INVALID, 'an amount has at most three decimals (BHD)');
      if (!invoiceIds.includes(x.invoiceId) || !sourceIds.includes(x.sourceId)) {
        throw nein(SETTLE_AMOUNT_INVALID, 'a changed amount names an invoice or counter item that is not selected');
      }
      const k = settlePairKey(x.sourceId, x.invoiceId);
      if (k in handF) throw nein(SETTLE_AMOUNT_INVALID, 'each pairing may have one changed amount only');
      handF[k] = Math.round(f);
    }
  }
  const rows = planSettlementRows(read.invoices, read.sources, { invoiceIds, sourceIds, amounts: handF });
  const nummer = (id: string): string => read.invoices.find((i) => i.id === id)?.number ?? read.sources.find((s) => s.id === id)?.number ?? id;
  for (const [k, f] of Object.entries(handF)) {
    const row = rows.find((r) => settlePairKey(r.sourceId, r.invoiceId) === k);
    if (!row) {
      if (f > 0) throw nein(SETTLE_AMOUNT_INVALID, 'a changed amount belongs to a pairing that is not part of this proposal (an earlier line already settles it) — check the proposal');
      continue;
    }
    if (f > row.maxF) {
      throw nein(SETTLE_AMOUNT_TOO_HIGH, `${nummer(row.sourceId)} → ${nummer(row.invoiceId)}: at most ${B(row.maxF).toFixed(3)} can be offset here (the open rest of the invoice or of the counter item), not ${B(f).toFixed(3)}`);
    }
  }
  const pairs: SettlePair[] = rows.filter((r) => r.amountF > 0)
    .map(({ invoiceId, sourceKind, sourceId, amountF }) => ({ invoiceId, sourceKind, sourceId, amountF }));
  if (pairs.length === 0) throw nein(SETTLE_NOTHING_TO_OFFSET, 'nothing can be offset with this selection');
  // Unverrückbar: keine Rechnung und kein Gegenposten über seinen offenen Rest — auch nicht in Summe mehrerer Zuordnungen.
  for (const i of read.invoices) {
    if (pairs.filter((p) => p.invoiceId === i.id).reduce((s, p) => s + p.amountF, 0) > F(i.open)) {
      throw new OffsetRestoreError('SETTLE_OVER_OPEN', `${i.number}: the offsets exceed the open amount — nothing was offset`);
    }
  }
  for (const q of read.sources) {
    if (pairs.filter((p) => p.sourceId === q.id).reduce((s, p) => s + p.amountF, 0) > F(q.open)) {
      throw new OffsetRestoreError('SETTLE_OVER_OPEN', `${q.number}: the offsets exceed what is open — nothing was offset`);
    }
  }
  const totalF = pairs.reduce((s, p) => s + p.amountF, 0);
  if (typeof req.expectedTotal !== 'number' || F(req.expectedTotal) !== totalF) {
    throw nein(SETTLE_TOTAL_CHANGED, `the settlement total is ${B(totalF).toFixed(3)}, not what the window showed — check the proposal and confirm again`);
  }

  // ── Tag: gültig, nicht in der Zukunft, nicht vor einem der beteiligten Belege, nicht vor dem Eröffnungsstichtag.
  const tag = req.settlementDate ?? todayLocal();
  const issue = businessDateIssue(tag, 'Settlement date');
  if (issue || typeof tag !== 'string') throw nein('OFFSET_DATE_INVALID', issue || 'the settlement date is not valid');
  const beteiligt = [
    ...pairs.map((p) => read.invoices.find((i) => i.id === p.invoiceId)!.date),
    ...pairs.map((p) => read.sources.find((s) => s.id === p.sourceId)!.date),
    OPENING_CUTOFF_DATE,
  ].filter(Boolean).sort();
  const frueheste = beteiligt[beteiligt.length - 1];
  if (tag < frueheste) throw nein('OFFSET_DATE_TOO_EARLY', `the settlement date must be on or after ${frueheste} (the documents it settles and the opening cutoff)`);

  // ── Endnummer: jede Rechnung, die dadurch voll bezahlt wird und noch keine hat, braucht die ausdrückliche Wahl.
  const finalizing = finalizingInvoices(read.invoices, pairs);
  const wahl = (req.finalNumbers && typeof req.finalNumbers === 'object') ? req.finalNumbers : {};
  for (const i of finalizing) {
    if (i.finalized) continue;
    const w = wahl[i.id];
    if (w !== 'normal' && w !== 'special') {
      throw nein(FINAL_NUMBER_CHOICE_REQUIRED, `${i.number} becomes fully paid — choose its final number type (Normal or Special)`);
    }
  }
  const special = (invoiceId: string): boolean | undefined => {
    const w = wahl[invoiceId];
    return finalizing.some((i) => i.id === invoiceId && !i.finalized) ? w === 'special' : undefined;
  };

  let userId = ctx.userId ?? '';
  if (!userId) { try { userId = currentUserId(); } catch { userId = ''; } }
  const createdAt = new Date().toISOString();
  const receivedAt = businessTimestamp(tag, createdAt);
  const settlementNumber = getNextDocumentNumber('STL');
  const db = getDatabase();
  const lines: SettlementBookedLine[] = [];

  pairs.forEach((p, k) => {
    const line = k + 1;
    const offsetNumber = `${settlementNumber}/${line}`;
    const quelle = read.sources.find((s) => s.id === p.sourceId)!;
    useInvoiceStore.getState().loadInvoices();
    let paymentId: string;
    if (p.sourceKind === 'STORE_CREDIT') {
      // Die vorhandene Anrechnung — GENAU dieses Guthaben, dieser Betrag, dieser Tag, diese Zahlungskennung.
      paymentId = uuid();
      const applied = useInvoiceStore.getState().applyCreditToInvoice(
        p.invoiceId, B(p.amountF), `Offset ${offsetNumber} · ${quelle.number === 'Store credit' ? 'store credit' : `store credit ${quelle.number}`} (${quelle.label}) · no cash`,
        { creditIds: [p.sourceId], paymentId, specialMarkOnFinal: special(p.invoiceId), times: { receivedAt, createdAt } },
      );
      if (F(applied) !== p.amountF) throw nein(SETTLE_SOURCE_CHANGED, `the store credit ${quelle.number} could not be applied in full`);
      if (!hasLedgerEntries('PAYMENT', paymentId)) throw new OffsetRestoreError('OFFSET_NOT_BOOKED', 'the offset could not be booked — nothing was offset');
      const app = query('SELECT id FROM credit_applications WHERE payment_id = ? AND credit_id = ?', [paymentId, p.sourceId])[0];
      if (!app) throw new OffsetRestoreError('OFFSET_NOT_BOOKED', 'the store credit application is missing — nothing was offset');
      const offsetId = uuid();
      db.run(
        `INSERT INTO party_offsets (id, branch_id, offset_number, customer_id, receivable_type, receivable_id, receivable_payment_id,
           payable_type, payable_id, payable_payment_id, amount, offset_date, status, note, created_at, created_by, settlement_number)
         VALUES (?, ?, ?, ?, 'INVOICE', ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', NULL, ?, ?, ?)`,
        [offsetId, ctx.branchId, offsetNumber, req.customerId, p.invoiceId, paymentId, OFFSET_PAYABLE_STORE_CREDIT, p.sourceId, String(app.id),
          B(p.amountF), tag, createdAt, userId || null, settlementNumber],
      );
      trackInsert('party_offsets', offsetId, { offsetNumber, settlementNumber, invoiceId: p.invoiceId, creditId: p.sourceId, amount: B(p.amountF) });
      logAuditOrThrow({
        module: 'Finance', entityType: 'party_offsets', entityId: offsetId, action: 'CREATE',
        newValue: {
          offsetNumber, settlementNumber, customerId: req.customerId, invoiceId: p.invoiceId, paymentId, creditId: p.sourceId,
          creditApplicationId: String(app.id), amount: B(p.amountF), offsetDate: tag, booking: 'DR CUSTOMER_CREDIT / CR ACCOUNTS_RECEIVABLE',
        },
        actor: { userId: userId || undefined, branchId: ctx.branchId },
      });
    } else if (p.sourceKind === 'PURCHASE') {
      // B2/B3 — die Einkaufsverrechnung (normal und Kommission) — mit der gemeinsamen Nummer.
      const r = createPurchaseOffsetInHouse(
        { invoiceId: p.invoiceId, purchaseId: p.sourceId, amount: B(p.amountF), offsetDate: tag, specialMarkOnFinal: special(p.invoiceId) },
        { branchId: ctx.branchId, userId }, { settlementNumber, line },
      );
      paymentId = r.paymentId;
    } else {
      // Die B1-Hausfolge — mit der gemeinsamen Nummer.
      const r = createDebtOffsetInHouse(
        { invoiceId: p.invoiceId, debtId: p.sourceId, amount: B(p.amountF), offsetDate: tag, specialMarkOnFinal: special(p.invoiceId) },
        { branchId: ctx.branchId, userId }, { settlementNumber, line },
      );
      paymentId = r.paymentId;
    }
    lines.push({
      offsetNumber, invoiceId: p.invoiceId, invoiceNumber: '', invoiceStatus: '', invoiceOpenAfter: 0,
      sourceKind: p.sourceKind, sourceId: p.sourceId, sourceNumber: quelle.number, sourceOpenAfter: 0, amount: B(p.amountF), paymentId,
    });
  });

  // ── Nachher: Status und Rest beider Seiten; die vorhergesagten Vollzahlungen sind genau die eingetretenen.
  const nach = settleBalanceFor(ctx, req.customerId);
  for (const l of lines) {
    const inv = query('SELECT invoice_number, status, special_mark, number_finalized_at FROM invoices WHERE id = ?', [l.invoiceId])[0];
    l.invoiceStatus = String(inv?.status ?? '');
    l.invoiceNumber = String(inv?.invoice_number ?? '');
    l.invoiceOpenAfter = nach.invoices.find((i) => i.id === l.invoiceId)?.open ?? 0;
    l.sourceOpenAfter = nach.sources.find((s) => s.id === l.sourceId)?.open ?? 0;
  }
  for (const i of read.invoices.filter((x) => pairs.some((p) => p.invoiceId === x.id))) {
    const voll = String(query('SELECT status FROM invoices WHERE id = ?', [i.id])[0]?.status ?? '') === 'FINAL';
    if (voll !== finalizing.some((f) => f.id === i.id)) {
      throw new OffsetRestoreError('SETTLE_STATUS_MISMATCH', `${i.number}: the payment status after the settlement is not the expected one — nothing was offset`);
    }
  }
  logAuditOrThrow({
    module: 'Finance', entityType: 'party_settlements', entityId: settlementNumber, action: 'CREATE',
    newValue: {
      settlementNumber, customerId: req.customerId, settlementDate: tag, total: B(totalF),
      lines: lines.map((l) => ({ offsetNumber: l.offsetNumber, invoiceId: l.invoiceId, sourceKind: l.sourceKind, sourceId: l.sourceId, amount: l.amount })),
      ...(Object.keys(handF).length > 0 ? { changedAmounts: Object.entries(handF).map(([k, f]) => ({ pair: k, amount: B(f) })) } : {}),
      noCash: true,
    },
    actor: { userId: userId || undefined, branchId: ctx.branchId },
  });
  return { settlementNumber, customerId: req.customerId, settlementDate: tag, total: B(totalF), lines };
}

export interface SettlementReverseRequest {
  /** Die gemeinsame Nummer (STL-…) — oder die Nummer einer Einzelverrechnung (B1). */
  settlementNumber: string;
  reason?: string;
  /** Wie viele Zuordnungen das Fenster noch als wirksam gezeigt hat — geändert = Nein (zwei Rechner gewinnen nicht beide). */
  expectedActiveLines?: number;
}
export interface SettlementReversed { settlementNumber: string; reversedLines: number; amount: number }

/** Eine ganze Verrechnung (alle noch wirksamen Zuordnungen einer STL) in der Transaktion des Aufrufers aufheben. */
export function reverseSettlementInHouse(req: SettlementReverseRequest, ctx: { branchId: string }): SettlementReversed {
  assertInvoiceHouse(ctx.branchId);
  const nr = typeof req.settlementNumber === 'string' ? req.settlementNumber.trim() : '';
  if (!nr) throw new InvoiceActionRejected(SETTLEMENT_NOT_FOUND, 'name the settlement (STL-…)');
  const rows = query(
    `SELECT * FROM party_offsets WHERE branch_id = ? AND (settlement_number = ? OR (settlement_number IS NULL AND offset_number = ?))
      ORDER BY offset_number`,
    [ctx.branchId, nr, nr],
  );
  if (rows.length === 0) throw new InvoiceActionRejected(SETTLEMENT_NOT_FOUND, `no settlement ${nr} in this branch`);
  const aktiv = rows.filter((o) => String(o.status) === 'ACTIVE');
  if (aktiv.length === 0) throw new InvoiceActionRejected(SETTLEMENT_ALREADY_REVERSED, `${nr} is already reversed`);
  if (req.expectedActiveLines !== undefined && aktiv.length !== req.expectedActiveLines) {
    throw new InvoiceActionRejected('RECORD_CHANGED', `${nr} changed since you opened it (you saw ${req.expectedActiveLines} active offsets, there are ${aktiv.length}) — reload`);
  }
  for (const o of aktiv) assertOffsetUndoSafe(o);
  const reason = (req.reason ?? '').trim().slice(0, 500) || `settlement ${nr} undone`;
  let amountF = 0;
  for (const o of aktiv) {
    const paymentId = String(o.receivable_payment_id);
    if (!query('SELECT 1 FROM payments WHERE id = ?', [paymentId])[0]) {
      throw new InvoiceActionRejected('OFFSET_NOT_FOUND', `the invoice payment of ${String(o.offset_number)} is gone — nothing was changed`);
    }
    useInvoiceStore.getState().loadInvoices();
    useInvoiceStore.getState().deletePayment(paymentId, String(o.receivable_id), { offsetReason: reason });
    amountF += F(o.amount);
  }
  const offen = query(`SELECT COUNT(*) AS n FROM party_offsets WHERE id IN (${aktiv.map(() => '?').join(',')}) AND status = 'ACTIVE'`, aktiv.map((o) => String(o.id)))[0];
  if (Number(offen?.n ?? 0) !== 0) throw new OffsetRestoreError('OFFSET_NOT_REVERSED', `${nr} could not be reversed completely — nothing was changed`);
  logAuditOrThrow({
    module: 'Finance', entityType: 'party_settlements', entityId: nr, action: 'STATUS_CHANGE', field: 'status',
    oldValue: 'ACTIVE', newValue: { status: 'REVERSED', settlementNumber: nr, reversedLines: aktiv.length, amount: B(amountF), reason },
    actor: { branchId: ctx.branchId },
  });
  return { settlementNumber: nr, reversedLines: aktiv.length, amount: B(amountF) };
}

// ── Anschlüsse am Primary: Recht der Sitzung, exklusiv, EINE Transaktion, danach durabel ─────────
function frischLesen(): void {
  useInvoiceStore.getState().loadInvoices();
  try { useDebtStore.getState().loadDebts(); } catch { /* noop */ }
  try { useCustomerStore.getState().loadCustomers(); } catch { /* noop */ }
}
function sitzungDarf(op: string): void {
  let role: string | undefined;
  try { role = useAuthStore.getState().role(); } catch { role = undefined; }
  if (!roleMayRunOp(role, op)) {
    throw new InvoiceActionRejected(SETTLE_PERMISSION_DENIED, 'your role may not record payments or offsets — nothing was offset');
  }
}

export function settleBalanceOnPrimary(req: SettleBalanceRequest): Promise<SettlementBooked> {
  try { sitzungDarf(OP_CUSTOMERS_SETTLE_BALANCE); } catch (e) { return Promise.reject(e); }
  const branchId = localInvoiceBranch();
  return runOnPrimary(() => settleBalanceInHouse(req, { branchId }), frischLesen);
}

export function reverseSettlementOnPrimary(req: SettlementReverseRequest): Promise<SettlementReversed> {
  try { sitzungDarf(OP_CUSTOMERS_SETTLEMENT_REVERSE); } catch (e) { return Promise.reject(e); }
  const branchId = localInvoiceBranch();
  return runOnPrimary(() => reverseSettlementInHouse(req, { branchId }), frischLesen);
}

/** Der Rumpf für PC2 — nur Absicht; Zuordnung, Buchung und Nummer rechnet der Primary. */
export function settleBalanceBody(req: SettleBalanceRequest): Record<string, unknown> {
  return {
    customerId: req.customerId, invoiceIds: [...req.invoiceIds], sourceIds: [...req.sourceIds],
    ...(req.settlementDate ? { settlementDate: req.settlementDate } : {}),
    expectedStamp: req.expectedStamp, expectedTotal: req.expectedTotal,
    ...(req.finalNumbers ? { finalNumbers: { ...req.finalNumbers } } : {}),
    ...(req.amounts && req.amounts.length > 0 ? { amounts: req.amounts.map((a) => ({ invoiceId: a.invoiceId, sourceId: a.sourceId, amount: a.amount })) } : {}),
  };
}
export function settlementReverseBody(req: SettlementReverseRequest): Record<string, unknown> {
  return {
    settlementNumber: req.settlementNumber,
    ...(req.reason ? { reason: req.reason } : {}),
    ...(req.expectedActiveLines !== undefined ? { expectedActiveLines: req.expectedActiveLines } : {}),
  };
}
