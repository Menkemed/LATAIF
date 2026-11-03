// ════════════════════════════════════════════════════════════════════════════
// MIXED-INVOICE P1c — Kundenüberzahlung nach einer Rechnungskorrektur: Guthaben ODER Rückzahlung.
//
// Sinkt die Summe einer Rechnung unter das Bezahlte, schuldet LATAIF dem Kunden die Differenz. Der Mensch wählt
// beim Speichern ausdrücklich (Owner-Entscheidung, Pflichtwahl):
//   • Kundenguthaben — wie bisher: customer_credits status 'OPEN', beim nächsten Kauf einlösbar;
//   • Rückzahlung    — derselbe Anspruch (dieselbe Zeile, dieselbe Buchung DR AR / CR CUSTOMER_CREDIT, kein Geld),
//                      aber status 'REFUND_DUE': NICHT einlösbar, offen bis zur tatsächlichen Auszahlung.
// Für denselben Betrag entsteht nie beides — es ist EINE Zeile mit EINER Art.
//
// Geld fließt erst bei der Auszahlung (`payOutRefundClaim`): je Auszahlung ein Beleg (customer_credit_refunds) mit
// Betrag, Weg und Tag, DR CUSTOMER_CREDIT / CR CASH|BANK|BENEFIT, der Anspruch sinkt um genau diesen Betrag
// (used_amount), voll ausgezahlt → 'REFUNDED'. Spiegel der Lieferanten-Rückforderung (CONSIGNMENT D3,
// `recordSupplierCreditRefundInHouse`). Nie mehr als offen, nie vor dem Anspruch, nie in der Zukunft, nie in einer
// zugemachten Periode (eingereichtes/VAT-bezahltes Quartal, vor dem Eröffnungsstichtag).
//
// Der Anspruch hängt an der Korrektur (source_type 'invoice_edit'): ein späterer Edit holt ihn wie ein Guthaben
// zurück, solange nichts ausgezahlt ist; danach sperren Edit, Storno und Löschen (`assertGrantedCreditUnused`).
// ════════════════════════════════════════════════════════════════════════════
import { v4 as uuid } from 'uuid';
import { getDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId } from '@/core/db/helpers';
import { trackChange } from '@/core/sync/sync-service';
import { postCustomerCreditRefund } from '@/core/ledger/posting';
import { logAuditOrThrow } from '@/core/audit/audit-log';
import { assertCorrectionDates } from '@/core/ledger/correction-dates';
import { InvoiceActionRejected } from '@/core/invoices/invoice-cancel';
import { isClientMode } from '@/core/bridge/client-mode';
import { runOnPrimary } from '@/core/data/primary-action';

/** Die Art einer Überzahlung nach dem Edit. */
export type OverpayChoice = 'credit' | 'refund';
export const OVERPAY_CHOICES: readonly OverpayChoice[] = ['credit', 'refund'];

/** customer_credits.status eines offenen bzw. ausgezahlten Rückzahlungsanspruchs (nicht einlösbar). */
export const REFUND_DUE = 'REFUND_DUE';
export const REFUNDED = 'REFUNDED';
export const isRefundClaimStatus = (s: unknown): boolean => s === REFUND_DUE || s === REFUNDED;

/** Auszahlungswege — echtes Geld, wie bei der Lieferanten-Rückforderung. */
export const REFUND_PAYOUT_METHODS = ['cash', 'bank', 'benefit'] as const;
export type RefundPayoutMethod = typeof REFUND_PAYOUT_METHODS[number];

export const OVERPAY_CHOICE_REQUIRED = 'OVERPAY_CHOICE_REQUIRED';
export const REFUND_NOTHING_OWED = 'REFUND_NOTHING_OWED';
export const REFUND_CLAIM_NOT_FOUND = 'REFUND_CLAIM_NOT_FOUND';
export const REFUND_CLAIM_SETTLED = 'REFUND_CLAIM_SETTLED';
export const REFUND_EXCEEDS_OPEN = 'REFUND_EXCEEDS_OPEN';
export const REFUND_AMOUNT_INVALID = 'REFUND_AMOUNT_INVALID';
export const REFUND_METHOD_INVALID = 'REFUND_METHOD_INVALID';
export const REFUND_DATE_INVALID = 'REFUND_DATE_INVALID';
export const REFUND_DATE_BEFORE_CLAIM = 'REFUND_DATE_BEFORE_CLAIM';

/** Alle fachlichen Neins dieses Wegs (für die Urteilslisten der Fernaufträge). */
export const INVOICE_REFUND_VERDICTS: readonly string[] = [
  OVERPAY_CHOICE_REQUIRED, REFUND_NOTHING_OWED, REFUND_CLAIM_NOT_FOUND, REFUND_CLAIM_SETTLED, REFUND_EXCEEDS_OPEN,
  REFUND_AMOUNT_INVALID, REFUND_METHOD_INVALID, REFUND_DATE_INVALID, REFUND_DATE_BEFORE_CLAIM,
];

const nein = (code: string, msg: string): InvoiceActionRejected => new InvoiceActionRejected(code, msg);
const F = (v: unknown): number => Math.round((Number(v) || 0) * 1000);
const B = (f: number): number => f / 1000;
const fmt = (f: number): string => B(f).toFixed(3);

/** Der Kalendertag in Ortszeit (JJJJ-MM-TT). */
function localDay(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export interface RefundCtx { readonly branchId: string; readonly userId: string; readonly now: string }

export interface RefundPayoutInput {
  creditId: string;
  amount: number;
  method: string;
  /** Tag der Auszahlung (JJJJ-MM-TT); ohne Angabe heute. */
  paidDate?: string;
  reference?: string;
  note?: string;
}

export interface RefundPayoutResult {
  refundId: string;
  creditId: string;
  invoiceId: string;
  amount: number;
  method: RefundPayoutMethod;
  paidDate: string;
  /** Was danach noch offen ist (0 = voll ausgezahlt). */
  openAmount: number;
  status: typeof REFUND_DUE | typeof REFUNDED;
}

/** Wann der Anspruch gebucht wurde (lebende Buchung der Rechnung auf CUSTOMER_CREDIT), sonst seine Zeile. */
function claimDay(invoiceId: string, createdAt: string): string {
  const r = query(
    `SELECT MAX(le.occurred_at) AS d FROM ledger_entries le
      WHERE le.source_module = 'INVOICE' AND le.source_id = ? AND le.account = 'CUSTOMER_CREDIT' AND le.direction = 'CREDIT'
        AND le.reverses_entry_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM ledger_entries r WHERE r.reverses_entry_id = le.id)`,
    [invoiceId],
  )[0];
  const iso = String(r?.d ?? '') || createdAt;
  return iso ? localDay(iso) : '';
}

/**
 * Zahlt (einen Teil von) einem offenen Rückzahlungsanspruch tatsächlich aus. Öffnet KEINE eigene Transaktion: läuft im
 * Edit (Wahl „Paid out now") oder in der Klammer des Primary/Fernauftrags (`recordInvoiceRefundOnPrimary`).
 */
export function payOutRefundClaim(input: RefundPayoutInput, ctx: RefundCtx): RefundPayoutResult {
  if (isClientMode()) throw nein('CLIENT_HAS_NO_BOOKS', 'this computer keeps no books — the action is sent to the main computer');
  const amtF = F(input.amount);
  if (!Number.isFinite(Number(input.amount)) || amtF <= 0) throw nein(REFUND_AMOUNT_INVALID, 'the refund amount must be above 0');
  const method = String(input.method ?? '') as RefundPayoutMethod;
  if (!(REFUND_PAYOUT_METHODS as readonly string[]).includes(method)) {
    throw nein(REFUND_METHOD_INVALID, 'a refund is paid out in cash, by bank transfer or by Benefit');
  }
  const c = query(
    `SELECT id, branch_id, customer_id, source_type, source_id, amount, used_amount, status, created_at
       FROM customer_credits WHERE id = ?`,
    [input.creditId],
  )[0];
  if (!c || String(c.branch_id ?? '') !== ctx.branchId || String(c.source_type) !== 'invoice_edit') {
    throw nein(REFUND_CLAIM_NOT_FOUND, 'no such refund owed to a customer in this branch');
  }
  if (String(c.status) === REFUNDED) throw nein(REFUND_CLAIM_SETTLED, 'this refund is already paid out in full');
  if (String(c.status) !== REFUND_DUE) {
    throw nein(REFUND_CLAIM_NOT_FOUND, 'this overpayment was kept as customer credit — there is no refund to pay out');
  }
  const openF = F(c.amount) - F(c.used_amount);
  if (openF <= 0) throw nein(REFUND_CLAIM_SETTLED, 'this refund is already paid out in full');
  if (amtF > openF) throw nein(REFUND_EXCEEDS_OPEN, `the refund (${fmt(amtF)}) is more than what is still owed (${fmt(openF)})`);

  const today = localDay(ctx.now);
  const tag = input.paidDate === undefined || input.paidDate === '' ? today : String(input.paidDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tag) || Number.isNaN(new Date(`${tag}T12:00:00`).getTime())) {
    throw nein(REFUND_DATE_INVALID, 'the date of the refund must look like YYYY-MM-DD');
  }
  if (tag > today) throw nein(REFUND_DATE_INVALID, 'the refund cannot be dated in the future');
  const invoiceId = String(c.source_id ?? '');
  const ab = claimDay(invoiceId, String(c.created_at ?? ''));
  if (ab && tag < ab) throw nein(REFUND_DATE_BEFORE_CLAIM, `the refund cannot be paid out before it was owed (${ab})`);
  // Der Zeitpunkt: heute → jetzt; ein früherer Tag → dieser Tag (Kasse/Bank stehen am Tag der Auszahlung).
  const paidAt = tag === today ? ctx.now : `${tag}T12:00:00.000Z`;
  assertCorrectionDates(ctx.branchId, [{ iso: paidAt, what: 'the refund payout' }]);

  const refundId = uuid();
  const newUsedF = F(c.used_amount) + amtF;
  const status = newUsedF >= F(c.amount) ? REFUNDED : REFUND_DUE;
  const customerId = String(c.customer_id ?? '');
  const reference = input.reference?.trim() || null;
  const note = input.note?.trim() || null;
  const db = getDatabase();
  db.run(
    `INSERT INTO customer_credit_refunds (id, branch_id, customer_credit_id, customer_id, invoice_id, amount, method,
       paid_at, reference, note, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [refundId, ctx.branchId, input.creditId, customerId, invoiceId || null, B(amtF), method, paidAt, reference, note,
      ctx.now, ctx.userId || null],
  );
  db.run('UPDATE customer_credits SET used_amount = ?, status = ? WHERE id = ?', [B(newUsedF), status, input.creditId]);
  trackChange('customer_credits', input.creditId, 'update', {});
  postCustomerCreditRefund(refundId, customerId, B(amtF), method, paidAt, { creditId: input.creditId, invoiceId });
  logAuditOrThrow({
    module: 'Sales', entityType: 'customer_credits', entityId: input.creditId, action: 'REFUND', field: 'refund_paid_out',
    oldValue: { usedAmount: Number(c.used_amount ?? 0), status: String(c.status) },
    newValue: { refundId, invoiceId, amount: B(amtF), method, paidDate: tag, usedAmount: B(newUsedF), status, ...(reference ? { reference } : {}) },
    actor: { userId: ctx.userId || undefined, branchId: ctx.branchId },
  });
  return {
    refundId, creditId: input.creditId, invoiceId, amount: B(amtF), method, paidDate: tag,
    openAmount: B(F(c.amount) - newUsedF), status,
  };
}

/** Der offene (oder ausgezahlte) Rückzahlungsanspruch einer Rechnung — für Anzeige und Prüfung. */
export interface InvoiceRefundClaim {
  creditId: string;
  amount: number;
  paidOut: number;
  open: number;
  status: string;
  payouts: Array<{ id: string; amount: number; method: string; paidAt: string }>;
}

/** Die Rückzahlungsansprüche je Rechnung einer Filiale (eine Abfrage je Tabelle). */
export function refundClaimsByInvoice(branchId: string): Map<string, InvoiceRefundClaim> {
  const out = new Map<string, InvoiceRefundClaim>();
  const rows = query(
    `SELECT id, source_id, amount, used_amount, status FROM customer_credits
      WHERE branch_id = ? AND source_type = 'invoice_edit' AND status IN ('${REFUND_DUE}', '${REFUNDED}')`,
    [branchId],
  );
  if (rows.length === 0) return out;
  const byCredit = new Map<string, InvoiceRefundClaim>();
  for (const r of rows) {
    const claim: InvoiceRefundClaim = {
      creditId: String(r.id), amount: Number(r.amount) || 0, paidOut: Number(r.used_amount) || 0,
      open: B(Math.max(0, F(r.amount) - F(r.used_amount))), status: String(r.status), payouts: [],
    };
    out.set(String(r.source_id), claim);
    byCredit.set(claim.creditId, claim);
  }
  let payouts: Array<Record<string, unknown>> = [];
  try {
    payouts = query(
      `SELECT id, customer_credit_id, amount, method, paid_at FROM customer_credit_refunds WHERE branch_id = ? ORDER BY paid_at, id`,
      [branchId],
    );
  } catch { /* ältere Datenbank ohne die Tabelle: keine Auszahlungen */ }
  for (const p of payouts) {
    const claim = byCredit.get(String(p.customer_credit_id));
    if (claim) claim.payouts.push({ id: String(p.id), amount: Number(p.amount) || 0, method: String(p.method), paidAt: String(p.paid_at) });
  }
  return out;
}

/** „Record refund" am Primary: exklusiv, in EINER Transaktion, danach durabel gespeichert. */
export function recordInvoiceRefundOnPrimary(input: RefundPayoutInput, reload: () => void): Promise<RefundPayoutResult> {
  return runOnPrimary(() => {
    let branchId = ''; let userId = '';
    try { branchId = currentBranchId(); userId = currentUserId(); } catch { /* unten abgewiesen */ }
    if (!branchId) throw nein('NO_SESSION', 'no signed-in branch — nothing can be booked');
    return payOutRefundClaim(input, { branchId, userId, now: new Date().toISOString() });
  }, reload);
}
