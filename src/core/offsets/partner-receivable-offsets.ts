// ════════════════════════════════════════════════════════════════════════════
// v0.8.101 S5 (Owner E3, 11.11.2026) — eine GEBUCHTE Partnerforderung wird mit einer Verbindlichkeit von LATAIF gegenüber
// DERSELBEN Person verrechnet (Partner ausdrücklich mit dem Kunden verknüpft). Linke Seite in „Settle Balance".
//
// Was: nur der gebuchte Soll-Saldo des Partners an einem Artikel (Rückforderung nach Abrechnung, zu hohe Auszahlung …) —
// `partnerReceivableNow`. NIE: ein nur berechneter Kostenanteil, unrealisierter Gewinn, Gesellschafterkapital, gesperrte Beträge.
// Gegenposten (dieselbe Person):
//   • We Borrowed (Darlehen, das LATAIF von ihr hat):  Soll LOAN_PAYABLE (Kunde)        / Haben PARTNER_ITEM_BALANCE (Partner)
//     am Darlehen eine Rückzahlungszeile Quelle 'offset' OHNE eigene Buchung (wie B1); Rückgängig: Gegenzeile 'offset_reversal'.
//   • offener Einkauf (ihre Lieferantenrolle):         Soll ACCOUNTS_PAYABLE (Lieferant) / Haben PARTNER_ITEM_BALANCE (Partner)
//     am Einkauf eine Zeile 'offset' OHNE eigene Buchung (wie B2/B3); Rückgängig: die Zeile wird storniert (voided_at).
//   • freies Store Credit (Variante B):                Soll CUSTOMER_CREDIT (Kunde)     / Haben PARTNER_ITEM_BALANCE (Partner)
//     Verbrauchsbeleg in `customer_credit_offsets` (eigene Tabelle, Muster customer_credit_refunds) + used_amount — derselbe
//     Saldo wie jede Einlösung; `credit_applications` bleibt rechnungsgebunden; Audit zählt die Belege mit. Rückgängig: reversed_at.
// Gebucht EINMAL an der Partnerbewegung (CONTRIBUTION 'offset'). `party_offsets`: receivable_type 'PARTNER_ITEM'
// (receivable_id = Einkaufszeile, receivable_payment_id = Bewegung), payable_type 'DEBT' bzw. 'PURCHASE'.
// ════════════════════════════════════════════════════════════════════════════
import { v4 as uuid } from 'uuid';
import { getDatabase } from '@/core/db/database';
import { query, currentUserId, getNextDocumentNumber } from '@/core/db/helpers';
import { trackInsert, trackUpdate } from '@/core/sync/track';
import { logAuditOrThrow } from '@/core/audit/audit-log';
import { hasLedgerEntries } from '@/core/ledger/posting';
import { businessDateIssue, businessTimestamp } from '@/core/utils/business-date';
import { InvoiceActionRejected } from '@/core/invoices/invoice-cancel';
import { assertInvoiceHouse } from '@/core/invoices/invoice-house-guards';
import { OPENING_CUTOFF_DATE } from '@/core/parties/opening-balances';
import { paidFilsOfDebt, reconcileDebtStatus } from '@/core/finance/debt-status';
import { PURCHASE_OFFSET_METHOD, purchaseSettlementOf, refreshPurchaseSettlementRow } from '@/core/purchases/purchase-settled';
import { PartnerItemRejected } from '@/core/partners/item-participation';
import { cancelOffsetRepaymentInHouse, partnerReceivableNow, recordOffsetRepaymentInHouse } from '@/core/partners/item-participation-house';
import {
  DEBT_OFFSET_REVERSAL_SOURCE, DEBT_OFFSET_SOURCE, OFFSET_PAYABLE_DEBT, OFFSET_PAYABLE_PURCHASE, OFFSET_PAYABLE_STORE_CREDIT, OffsetRestoreError,
} from './party-offset-restore';
import { isBorrowedDirection, isDebtClosed } from './party-offset-reads';
import { linkedPartnerOf, OFFSET_PARTNER_NOT_LINKED } from './partner-offsets';
import type { OffsetSettlementLink } from './party-offsets';

export const OFFSET_RECEIVABLE_PARTNER_ITEM = 'PARTNER_ITEM';
export const OFFSET_PARTNER_NOT_RECEIVABLE = 'OFFSET_PARTNER_NOT_RECEIVABLE';
export const OFFSET_COUNTER_NOT_OPEN = 'OFFSET_COUNTER_NOT_OPEN';

const F = (n: unknown): number => Math.round((Number(n) || 0) * 1000);
const B = (f: number): number => f / 1000;
const nein = (code: string, msg: string): InvoiceActionRejected => new InvoiceActionRejected(code, `${msg} — nothing was offset`);
const todayLocal = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export interface PartnerReceivableOffsetInput {
  customerId: string;
  purchaseLineId: string;
  counterKind: 'LOAN_BORROWED' | 'PURCHASE' | 'STORE_CREDIT';
  counterId: string;
  amount: number;
  offsetDate?: string;
}
export interface PartnerReceivableOffsetCreated {
  offsetId: string; offsetNumber: string; partnerId: string; purchaseLineId: string; movementId: string;
  counterKind: 'LOAN_BORROWED' | 'PURCHASE' | 'STORE_CREDIT'; counterId: string; counterPaymentId: string; amount: number; offsetDate: string;
}

/** Eine gebuchte Partnerforderung mit EINEM Gegenposten verrechnen — in der Transaktion des Aufrufers (`settleBalanceInHouse`). */
export function createPartnerReceivableOffsetInHouse(
  input: PartnerReceivableOffsetInput, ctx: { branchId: string; userId?: string }, link?: OffsetSettlementLink,
): PartnerReceivableOffsetCreated {
  assertInvoiceHouse(ctx.branchId);
  const amountF = F(input.amount);
  if (typeof input.amount !== 'number' || !Number.isFinite(input.amount) || amountF <= 0 || Math.abs(input.amount * 1000 - amountF) > 1e-6) {
    throw nein('OFFSET_AMOUNT_INVALID', 'the amount must be above 0 with at most 3 decimals');
  }
  const partner = linkedPartnerOf(input.customerId, ctx.branchId);
  if (!partner) throw nein(OFFSET_PARTNER_NOT_LINKED, 'no partner is linked to this client — link the partner to the client first');
  const pl = query(
    `SELECT pl.id, p.purchase_number, p.purchase_date, p.created_at FROM purchase_lines pl JOIN purchases p ON p.id = pl.purchase_id
      WHERE pl.id = ? AND p.branch_id = ?`, [input.purchaseLineId, ctx.branchId],
  )[0];
  if (!pl) throw nein(OFFSET_PARTNER_NOT_RECEIVABLE, 'no such jointly bought item in this branch');
  // ── Partnerforderung: gebucht, nicht gesperrt.
  let receivableF = 0;
  try {
    const st = partnerReceivableNow(input.purchaseLineId, partner.id, ctx.branchId);
    if (st.blocker) throw nein(OFFSET_PARTNER_NOT_RECEIVABLE, `this partner amount is on hold (${st.blocker.message})`);
    receivableF = st.receivableF;
  } catch (e) {
    if (e instanceof PartnerItemRejected) throw nein(OFFSET_PARTNER_NOT_RECEIVABLE, e.message);
    throw e;
  }
  if (receivableF <= 5) throw nein(OFFSET_PARTNER_NOT_RECEIVABLE, 'the partner owes LATAIF nothing booked on this item (a calculated cost share is never offset)');
  if (amountF > receivableF) throw nein('OFFSET_EXCEEDS_PARTNER', `at most ${B(receivableF).toFixed(3)} is owed by the partner on this item`);

  // ── Gegenposten derselben Person: frisch, offen, mit Buchung.
  let counterDate = '';
  let counterLabel = '';
  let counter: { account: 'LOAN_PAYABLE' | 'ACCOUNTS_PAYABLE' | 'CUSTOMER_CREDIT'; counterpartyType: 'CUSTOMER' | 'SUPPLIER'; counterpartyId: string };
  let debtAmountF = 0;
  let creditRow: Record<string, unknown> | undefined;
  if (input.counterKind === 'STORE_CREDIT') {
    // Variante B — nur FREIES Store Credit dieses Kunden in dieser Filiale (OPEN, kein Eröffnungsguthaben, Betrag − verwendet):
    // dieselbe Menge, die „Settle Balance" für Rechnungen anbietet. Rückzahlungsansprüche (REFUND_DUE) sind kein Store Credit.
    creditRow = query(
      `SELECT id, amount, used_amount, status, source_type, created_at, customer_id FROM customer_credits WHERE id = ? AND branch_id = ?`,
      [input.counterId, ctx.branchId],
    )[0];
    if (!creditRow || String(creditRow.customer_id ?? '') !== input.customerId || String(creditRow.status) !== 'OPEN'
      || String(creditRow.source_type ?? '') === 'opening') {
      throw nein(OFFSET_COUNTER_NOT_OPEN, 'this is not free store credit of this client');
    }
    const freeF = F(creditRow.amount) - F(creditRow.used_amount);
    if (amountF > freeF) throw nein('OFFSET_EXCEEDS_CREDIT', `at most ${B(Math.max(0, freeF)).toFixed(3)} of this store credit is free`);
    counterDate = String(creditRow.created_at ?? '').slice(0, 10);
    counterLabel = 'store credit';
    counter = { account: 'CUSTOMER_CREDIT', counterpartyType: 'CUSTOMER', counterpartyId: input.customerId };
  } else if (input.counterKind === 'LOAN_BORROWED') {
    const d = query('SELECT id, loan_number, amount, status, direction, customer_id, created_at FROM debts WHERE id = ? AND branch_id = ?', [input.counterId, ctx.branchId])[0];
    if (!d || String(d.customer_id ?? '') !== input.customerId || !isBorrowedDirection(d.direction)) {
      throw nein(OFFSET_COUNTER_NOT_OPEN, 'this loan is not a "We Borrowed" loan of this client');
    }
    if (isDebtClosed(d.status)) throw nein(OFFSET_COUNTER_NOT_OPEN, `this loan is ${String(d.status).toLowerCase()}`);
    debtAmountF = F(d.amount);
    const openF = debtAmountF - paidFilsOfDebt(input.counterId);
    if (amountF > openF) throw nein('OFFSET_EXCEEDS_LOAN', `at most ${B(Math.max(0, openF)).toFixed(3)} is open on the loan`);
    counterDate = String(d.created_at ?? '').slice(0, 10);
    counterLabel = `loan ${String(d.loan_number ?? '') || input.counterId.slice(0, 8)}`;
    counter = { account: 'LOAN_PAYABLE', counterpartyType: 'CUSTOMER', counterpartyId: input.customerId };
  } else if (input.counterKind === 'PURCHASE') {
    const p = query(
      `SELECT p.id, p.purchase_number, p.purchase_date, p.created_at, p.status, p.supplier_id, s.linked_customer_id, s.branch_id AS s_branch
         FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = ? AND p.branch_id = ?`, [input.counterId, ctx.branchId],
    )[0];
    if (!p || String(p.linked_customer_id ?? '') !== input.customerId || String(p.s_branch) !== ctx.branchId) {
      throw nein(OFFSET_COUNTER_NOT_OPEN, 'this purchase is not from the supplier role linked to this client');
    }
    if (['CANCELLED', 'DRAFT'].includes(String(p.status))) throw nein(OFFSET_COUNTER_NOT_OPEN, `this purchase is ${String(p.status).toLowerCase()}`);
    if (!hasLedgerEntries('PURCHASE', input.counterId)) throw nein(OFFSET_COUNTER_NOT_OPEN, 'this purchase has no live accounting entry (no payable to offset)');
    const openF = purchaseSettlementOf(input.counterId).openF;
    if (amountF > openF) throw nein('OFFSET_EXCEEDS_PURCHASE', `at most ${B(Math.max(0, openF)).toFixed(3)} is open on the purchase`);
    counterDate = String(p.purchase_date || p.created_at || '').slice(0, 10);
    counterLabel = `purchase ${String(p.purchase_number ?? '') || input.counterId.slice(0, 8)}`;
    counter = { account: 'ACCOUNTS_PAYABLE', counterpartyType: 'SUPPLIER', counterpartyId: String(p.supplier_id) };
  } else {
    throw nein('SETTLE_SELECTION_INVALID', 'a partner receivable is offset only against store credit, "We Borrowed" or an open purchase');
  }
  // ── Tag: gültig, nicht in der Zukunft, nicht vor Einkauf des Artikels, Gegenposten oder Eröffnungsstichtag.
  const tag = input.offsetDate ?? todayLocal();
  const issue = businessDateIssue(tag, 'Offset date');
  if (issue || typeof tag !== 'string') throw nein('OFFSET_DATE_INVALID', issue || 'the offset date is not valid');
  const frueheste = [String(pl.purchase_date || pl.created_at || '').slice(0, 10), counterDate, OPENING_CUTOFF_DATE].filter(Boolean).sort().pop() as string;
  if (tag < frueheste) throw nein('OFFSET_DATE_TOO_EARLY', `the offset date must be on or after ${frueheste}`);

  let userId = ctx.userId ?? '';
  if (!userId) { try { userId = currentUserId(); } catch { userId = ''; } }
  const createdAt = new Date().toISOString();
  const offsetNumber = link ? `${link.settlementNumber}/${link.line}` : getNextDocumentNumber('STL');
  const itemLabel = `partner item ${String(pl.purchase_number ?? '') || input.purchaseLineId.slice(0, 8)}`;

  // ── 1. Partnerseite + EINE Buchung: Soll Gegenkonto / Haben PARTNER_ITEM_BALANCE.
  let movementId = '';
  try {
    movementId = recordOffsetRepaymentInHouse({
      purchaseLineId: input.purchaseLineId, partnerId: partner.id, amountF, date: tag, offsetNumber, counterLabel, counter,
    }, { branchId: ctx.branchId, userId, now: createdAt }).movementId;
  } catch (e) {
    if (e instanceof PartnerItemRejected) throw nein(OFFSET_PARTNER_NOT_RECEIVABLE, e.message);
    throw e;
  }
  if (!hasLedgerEntries('PARTNER_ITEM', movementId)) throw new OffsetRestoreError('OFFSET_NOT_BOOKED', 'the offset could not be booked — nothing was offset');

  // ── 2. Gegenposten-Zeile OHNE eigene Buchung.
  const db = getDatabase();
  const counterPaymentId = uuid();
  if (input.counterKind === 'STORE_CREDIT') {
    // Verbrauchsbeleg (eigene Tabelle) + derselbe Saldo wie jede Einlösung: used_amount steigt, USED bei vollem Verbrauch.
    db.run(`INSERT INTO customer_credit_offsets (id, branch_id, customer_credit_id, customer_id, amount, purchase_line_id, movement_id,
              offset_number, offset_date, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [counterPaymentId, ctx.branchId, input.counterId, input.customerId, B(amountF), input.purchaseLineId, movementId, offsetNumber, tag, createdAt, userId || null]);
    const usedF = F(creditRow?.used_amount) + amountF;
    const status = usedF >= F(creditRow?.amount) - 5 ? 'USED' : 'OPEN';
    db.run('UPDATE customer_credits SET used_amount = ?, status = ? WHERE id = ?', [B(usedF), status, input.counterId]);
    trackUpdate('customer_credits', input.counterId, { usedAmount: B(usedF), status, partnerOffset: offsetNumber });
  } else if (input.counterKind === 'LOAN_BORROWED') {
    db.run(`INSERT INTO debt_payments (id, debt_id, amount, source, paid_at, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [counterPaymentId, input.counterId, B(amountF), DEBT_OFFSET_SOURCE, businessTimestamp(tag, createdAt), `Offset ${offsetNumber} · ${itemLabel} (partner owed) · no cash`, createdAt]);
    trackInsert('debt_payments', counterPaymentId, { debtId: input.counterId, amount: B(amountF), source: DEBT_OFFSET_SOURCE });
    reconcileDebtStatus(input.counterId, debtAmountF, paidFilsOfDebt(input.counterId));
  } else {
    db.run(`INSERT INTO purchase_payments (id, purchase_id, amount, method, paid_at, reference, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [counterPaymentId, input.counterId, B(amountF), PURCHASE_OFFSET_METHOD, tag, offsetNumber, `Offset ${offsetNumber} · ${itemLabel} (partner owed) · no cash`, createdAt]);
    trackInsert('purchase_payments', counterPaymentId, { purchaseId: input.counterId, amount: B(amountF), method: PURCHASE_OFFSET_METHOD, reference: offsetNumber });
    refreshPurchaseSettlementRow(input.counterId, createdAt);
  }

  // ── 3. Die Verbindung beider Zeilen.
  const offsetId = uuid();
  db.run(
    `INSERT INTO party_offsets (id, branch_id, offset_number, customer_id, receivable_type, receivable_id, receivable_payment_id,
       payable_type, payable_id, payable_payment_id, amount, offset_date, status, note, created_at, created_by, settlement_number)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', NULL, ?, ?, ?)`,
    [offsetId, ctx.branchId, offsetNumber, input.customerId, OFFSET_RECEIVABLE_PARTNER_ITEM, input.purchaseLineId, movementId,
      input.counterKind === 'LOAN_BORROWED' ? OFFSET_PAYABLE_DEBT : input.counterKind === 'STORE_CREDIT' ? OFFSET_PAYABLE_STORE_CREDIT : OFFSET_PAYABLE_PURCHASE,
      input.counterId, counterPaymentId,
      B(amountF), tag, createdAt, userId || null, link?.settlementNumber ?? null],
  );
  trackInsert('party_offsets', offsetId, { offsetNumber, purchaseLineId: input.purchaseLineId, counterId: input.counterId, amount: B(amountF) });
  logAuditOrThrow({
    module: 'Finance', entityType: 'party_offsets', entityId: offsetId, action: 'CREATE',
    newValue: {
      offsetNumber, settlementNumber: link?.settlementNumber ?? null, customerId: input.customerId, partnerId: partner.id,
      purchaseLineId: input.purchaseLineId, movementId, counterKind: input.counterKind, counterId: input.counterId, counterPaymentId,
      amount: B(amountF), offsetDate: tag,
      booking: `DR ${counter.account} (${counter.counterpartyType.toLowerCase()}) / CR PARTNER_ITEM_BALANCE (partner)`, noCash: true,
    },
    actor: { userId: userId || undefined, branchId: ctx.branchId },
  });
  return { offsetId, offsetNumber, partnerId: partner.id, purchaseLineId: input.purchaseLineId, movementId, counterKind: input.counterKind,
    counterId: input.counterId, counterPaymentId, amount: B(amountF), offsetDate: tag };
}

/** Eine wirksame Verrechnung „Partnerforderung ↔ Gegenposten" aufheben (ganze STL oder einzeln), in der Transaktion des Aufrufers. */
export function reversePartnerReceivableOffsetInHouse(o: Record<string, unknown>, reason: string, ctx: { branchId: string; userId?: string }): void {
  if (String(o.receivable_type) !== OFFSET_RECEIVABLE_PARTNER_ITEM || String(o.status) !== 'ACTIVE') {
    throw new OffsetRestoreError('OFFSET_CHANGED', 'the offset changed meanwhile — nothing was changed');
  }
  const now = new Date().toISOString();
  let userId = ctx.userId ?? '';
  if (!userId) { try { userId = currentUserId(); } catch { userId = ''; } }
  const nummer = String(o.offset_number);
  const amountF = F(o.amount);
  try {
    cancelOffsetRepaymentInHouse(String(o.receivable_payment_id), now, userId || null);
  } catch {
    throw new OffsetRestoreError('OFFSET_PARTNER_LINE_CHANGED', 'the partner side of the offset changed meanwhile — nothing was changed');
  }
  const db = getDatabase();
  let reversalId: string | null = null;
  if (String(o.payable_type) === OFFSET_PAYABLE_STORE_CREDIT) {
    // Verbrauchsbeleg zurückgenommen (reversed_at, nie gelöscht); das Guthaben ist im selben Saldo wieder frei.
    const creditId = String(o.payable_id);
    db.run('UPDATE customer_credit_offsets SET reversed_at = ?, reversed_by = ? WHERE id = ? AND customer_credit_id = ? AND reversed_at IS NULL',
      [now, userId || null, String(o.payable_payment_id), creditId]);
    if (Number(query('SELECT changes() AS n')[0]?.n) !== 1) throw new OffsetRestoreError('OFFSET_CREDIT_LINE_CHANGED', 'the store credit line of the offset changed meanwhile — nothing was changed');
    const c = query('SELECT amount, used_amount FROM customer_credits WHERE id = ?', [creditId])[0];
    const usedF = F(c?.used_amount) - amountF;
    if (usedF < 0) throw new OffsetRestoreError('OFFSET_CREDIT_LINE_CHANGED', 'the store credit changed meanwhile — nothing was changed');
    const status = usedF >= F(c?.amount) - 5 ? 'USED' : 'OPEN';
    db.run('UPDATE customer_credits SET used_amount = ?, status = ? WHERE id = ?', [B(usedF), status, creditId]);
    trackUpdate('customer_credits', creditId, { usedAmount: B(usedF), status, partnerOffsetReversed: nummer });
  } else if (String(o.payable_type) === OFFSET_PAYABLE_DEBT) {
    const debtId = String(o.payable_id);
    reversalId = uuid();
    db.run(`INSERT INTO debt_payments (id, debt_id, amount, source, paid_at, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [reversalId, debtId, -amountF / 1000, DEBT_OFFSET_REVERSAL_SOURCE, now, `Offset ${nummer} reversed — loan open again · no cash`, now]);
    trackInsert('debt_payments', reversalId, { debtId, amount: -amountF / 1000, source: DEBT_OFFSET_REVERSAL_SOURCE });
    const d = query('SELECT amount FROM debts WHERE id = ?', [debtId])[0];
    reconcileDebtStatus(debtId, F(d?.amount), paidFilsOfDebt(debtId));
  } else {
    const purchaseId = String(o.payable_id);
    db.run(`UPDATE purchase_payments SET voided_at = ?, voided_by = ?, void_reason = ? WHERE id = ? AND purchase_id = ? AND method = ? AND voided_at IS NULL`,
      [now, userId || null, `Offset ${nummer} reversed — ${reason} · no cash`, String(o.payable_payment_id), purchaseId, PURCHASE_OFFSET_METHOD]);
    if (Number(query('SELECT changes() AS n')[0]?.n) !== 1) throw new OffsetRestoreError('OFFSET_PURCHASE_LINE_CHANGED', 'the purchase line of the offset changed meanwhile — nothing was changed');
    trackUpdate('purchase_payments', String(o.payable_payment_id), { voidedAt: now, voidReason: `Offset ${nummer} reversed` });
    refreshPurchaseSettlementRow(purchaseId, now);
  }
  db.run(
    `UPDATE party_offsets SET status = 'REVERSED', reversed_at = ?, reversed_by = ?, reversal_payment_id = ?, reverse_reason = ? WHERE id = ? AND status = 'ACTIVE'`,
    [now, userId || null, reversalId, reason, String(o.id)],
  );
  if (Number(query('SELECT changes() AS n')[0]?.n) !== 1) throw new OffsetRestoreError('OFFSET_CHANGED', 'the offset changed meanwhile — nothing was changed');
  trackUpdate('party_offsets', String(o.id), { status: 'REVERSED', reversedAt: now });
  logAuditOrThrow({
    module: 'Finance', entityType: 'party_offsets', entityId: String(o.id), action: 'STATUS_CHANGE', field: 'status',
    oldValue: 'ACTIVE', newValue: { status: 'REVERSED', offsetNumber: nummer, amount: amountF / 1000, purchaseLineId: o.receivable_id,
      movementId: o.receivable_payment_id, counterId: o.payable_id, reason, noCash: true },
    actor: { userId: userId || undefined, branchId: String(o.branch_id) },
  });
}
