// ════════════════════════════════════════════════════════════════════════════
// CUSTOMER ACCOUNT B1 — eine Verrechnung Rechnung ↔ Darlehen wird aufgehoben, wenn ihre Rechnungszahlung ('debt_offset')
// verschwindet: „Remove offset" auf der Rechnung, Rechnungsstorno, Löschen der Rechnung. Der Aufrufer ist
// `invoiceStore.deletePayment` (wie `restoreCreditForPayment` / `restoreOrderDepositForPayment`) — damit gibt es EINEN Weg,
// gleich woher die Zahlung entfernt wird.
//
// Wirkung (in der Transaktion des Aufrufers):
//   • die Buchung der Rechnungszahlung (Soll LOAN_PAYABLE / Haben AR) hat `deletePayment` gegengebucht — geprüft, sonst Nein;
//   • am Darlehen steht eine GEGENZEILE (Rückzahlung, Quelle 'offset_reversal', negativer Betrag): `debt_payments` wird
//     nur eingefügt, nie gelöscht (Abgleichsvertrag), und der Verlauf bleibt sichtbar; der Status folgt der Summe;
//   • die Verrechnung steht auf REVERSED (nie gelöscht), mit Zeit, Person, Grund und der Gegenzeile; Protokoll.
// Eine schon aufgehobene Verrechnung wird nie ein zweites Mal aufgehoben.
//
// Keine Abhängigkeit zu Rechnungs- oder Geld-Speicher (sonst Kreis über `invoiceStore`).
// ════════════════════════════════════════════════════════════════════════════
import { v4 as uuid } from 'uuid';
import { getDatabase } from '@/core/db/database';
import { query, currentUserId } from '@/core/db/helpers';
import { trackInsert, trackUpdate } from '@/core/sync/track';
import { logAuditOrThrow } from '@/core/audit/audit-log';
import { hasLedgerEntries, hasReversalFor } from '@/core/ledger/posting';
import { paidFilsOfDebt, reconcileDebtStatus } from '@/core/finance/debt-status';
import { InvoiceActionRejected } from '@/core/invoices/invoice-cancel';

export const DEBT_OFFSET_METHOD = 'debt_offset';
export const DEBT_OFFSET_SOURCE = 'offset';
export const DEBT_OFFSET_REVERSAL_SOURCE = 'offset_reversal';
/** Rückzahlungsquellen eines Darlehens ohne Geld — Banking, Analytics und Nachbuchung lassen sie aus. */
export const NON_CASH_DEBT_SOURCES = [DEBT_OFFSET_SOURCE, DEBT_OFFSET_REVERSAL_SOURCE] as const;
/** SQL-Liste derselben Quellen (für `NOT IN (…)`). */
export const NON_CASH_DEBT_SOURCES_SQL = `('${DEBT_OFFSET_SOURCE}', '${DEBT_OFFSET_REVERSAL_SOURCE}')`;
/** Nein an einer Rechnung bzw. einem Darlehen mit wirksamer Verrechnung (Kundenwechsel, Überzahlung durch Korrektur, Löschen …). */
export const INVOICE_HAS_OFFSET = 'INVOICE_HAS_OFFSET';
export const DEBT_HAS_OFFSET = 'DEBT_HAS_OFFSET';

export class OffsetRestoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'OffsetRestoreError'; }
}

const F = (n: unknown): number => Math.round((Number(n) || 0) * 1000);

/**
 * CUSTOMER ACCOUNT C — die Arten einer Gegenposition in `party_offsets`: ein Darlehen „We Borrowed" (B1) und ein
 * Store-Guthaben (C). Ein Store-Guthaben wird über die VORHANDENE Anrechnung verrechnet (Zahlart 'credit',
 * `credit_applications`, Soll CUSTOMER_CREDIT / Haben AR); die Verrechnungszeile verbindet nur.
 */
export const OFFSET_PAYABLE_DEBT = 'DEBT';
export const OFFSET_PAYABLE_STORE_CREDIT = 'STORE_CREDIT';

/** Hat diese Rechnung eine wirksame Verrechnung? (Sperre für Kundenwechsel, Überzahlung durch Korrektur …) */
export function invoiceHasActiveOffsets(invoiceId: string): boolean {
  return query("SELECT 1 FROM party_offsets WHERE receivable_type = 'INVOICE' AND receivable_id = ? AND status = 'ACTIVE' LIMIT 1", [invoiceId]).length > 0;
}

/** Hängt an diesem Darlehen eine wirksame Verrechnung? (Sperre für Löschen und Storno des Darlehens) */
export function debtHasActiveOffsets(debtId: string): boolean {
  return query("SELECT 1 FROM party_offsets WHERE payable_type = 'DEBT' AND payable_id = ? AND status = 'ACTIVE' LIMIT 1", [debtId]).length > 0;
}

export interface OffsetRestored { offsetId: string; offsetNumber: string; debtId: string; reversalPaymentId: string; amount: number }

/**
 * Hebt die wirksame Verrechnung dieser Rechnungszahlung auf. Ohne wirksame Verrechnung: nichts (idempotent — eine
 * gewöhnliche Zahlung, oder schon aufgehoben). `reason`/`userId` stehen in Verrechnung und Protokoll.
 */
export function restoreDebtOffsetForPayment(paymentId: string, opts: { reason?: string; userId?: string; now?: string } = {}): OffsetRestored | null {
  const o = query("SELECT * FROM party_offsets WHERE receivable_payment_id = ? AND status = 'ACTIVE'", [paymentId])[0];
  if (!o) return null;
  // Die Gegenbuchung der Rechnungszahlung MUSS stehen — sonst bliebe LOAN_PAYABLE gemindert, während das Darlehen wieder
  // offen ist. `deletePayment` bucht sie (vorher); fehlt sie, geht der ganze Vorgang zurück.
  if (hasLedgerEntries('PAYMENT', paymentId) && !hasReversalFor('PAYMENT', paymentId)) {
    throw new OffsetRestoreError('OFFSET_REVERSAL_NOT_BOOKED', 'the booking of the offset could not be reversed — nothing was changed');
  }
  const now = opts.now ?? new Date().toISOString();
  let userId = opts.userId ?? '';
  if (!userId) { try { userId = currentUserId(); } catch { userId = ''; } }
  const db = getDatabase();
  const debtId = String(o.payable_id);
  const amountF = F(o.amount);
  const nummer = String(o.offset_number);
  const reversalId = uuid();
  db.run(
    `INSERT INTO debt_payments (id, debt_id, amount, source, paid_at, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [reversalId, debtId, -amountF / 1000, DEBT_OFFSET_REVERSAL_SOURCE, now, `Offset ${nummer} reversed — loan open again · no cash`, now],
  );
  trackInsert('debt_payments', reversalId, { debtId, amount: -amountF / 1000, source: DEBT_OFFSET_REVERSAL_SOURCE, paidAt: now });
  const d = query('SELECT amount FROM debts WHERE id = ?', [debtId])[0];
  reconcileDebtStatus(debtId, F(d?.amount), paidFilsOfDebt(debtId));
  const reason = (opts.reason ?? '').trim() || 'invoice payment removed';
  db.run(
    `UPDATE party_offsets SET status = 'REVERSED', reversed_at = ?, reversed_by = ?, reversal_payment_id = ?, reverse_reason = ?
      WHERE id = ? AND status = 'ACTIVE'`,
    [now, userId || null, reversalId, reason, String(o.id)],
  );
  if (Number(query('SELECT changes() AS n')[0]?.n) !== 1) throw new OffsetRestoreError('OFFSET_CHANGED', 'the offset changed meanwhile — nothing was changed');
  trackUpdate('party_offsets', String(o.id), { status: 'REVERSED', reversedAt: now });
  logAuditOrThrow({
    module: 'Finance', entityType: 'party_offsets', entityId: String(o.id), action: 'STATUS_CHANGE', field: 'status',
    oldValue: 'ACTIVE', newValue: { status: 'REVERSED', offsetNumber: nummer, amount: amountF / 1000, invoiceId: o.receivable_id, debtId, reason },
    actor: { userId: userId || undefined, branchId: String(o.branch_id) },
  });
  return { offsetId: String(o.id), offsetNumber: nummer, debtId, reversalPaymentId: reversalId, amount: amountF / 1000 };
}

export interface StoreCreditOffsetRestored { offsetId: string; offsetNumber: string; creditId: string; amount: number }

/**
 * CUSTOMER ACCOUNT C — die Zuordnung „Store Credit → Rechnung" dieser Rechnungszahlung ('credit') aufheben, wenn die
 * Zahlung verschwindet ("Remove offset" auf der Rechnung, ganze STL rückgängig, Rechnungsstorno). Das Guthaben gibt der
 * vorhandene Weg zurück (`restoreCreditForPayment`, vorher aufgerufen); hier steht nur noch die Verrechnungszeile auf
 * REVERSED — nie gelöscht, mit Zeit, Person und Grund. Ohne wirksame Zuordnung: nichts (eine gewöhnliche Anrechnung,
 * oder schon aufgehoben). Die Gegenbuchung der Zahlung MUSS stehen, sonst geht der ganze Vorgang zurück.
 */
export function restoreStoreCreditOffsetForPayment(paymentId: string, opts: { reason?: string; userId?: string; now?: string } = {}): StoreCreditOffsetRestored | null {
  const o = query(
    `SELECT * FROM party_offsets WHERE receivable_payment_id = ? AND payable_type = '${OFFSET_PAYABLE_STORE_CREDIT}' AND status = 'ACTIVE'`,
    [paymentId],
  )[0];
  if (!o) return null;
  if (hasLedgerEntries('PAYMENT', paymentId) && !hasReversalFor('PAYMENT', paymentId)) {
    throw new OffsetRestoreError('OFFSET_REVERSAL_NOT_BOOKED', 'the booking of the offset could not be reversed — nothing was changed');
  }
  // Das Guthaben muss zurück sein: keine Anrechnungszeile dieser Zahlung mehr (der vorhandene Weg löscht sie).
  if (query('SELECT 1 FROM credit_applications WHERE payment_id = ? LIMIT 1', [paymentId]).length > 0) {
    throw new OffsetRestoreError('OFFSET_CREDIT_NOT_RESTORED', 'the store credit of the offset could not be restored — nothing was changed');
  }
  const now = opts.now ?? new Date().toISOString();
  let userId = opts.userId ?? '';
  if (!userId) { try { userId = currentUserId(); } catch { userId = ''; } }
  const db = getDatabase();
  const nummer = String(o.offset_number);
  const amountF = F(o.amount);
  const reason = (opts.reason ?? '').trim() || 'invoice payment removed';
  db.run(
    `UPDATE party_offsets SET status = 'REVERSED', reversed_at = ?, reversed_by = ?, reverse_reason = ? WHERE id = ? AND status = 'ACTIVE'`,
    [now, userId || null, reason, String(o.id)],
  );
  if (Number(query('SELECT changes() AS n')[0]?.n) !== 1) throw new OffsetRestoreError('OFFSET_CHANGED', 'the offset changed meanwhile — nothing was changed');
  trackUpdate('party_offsets', String(o.id), { status: 'REVERSED', reversedAt: now });
  logAuditOrThrow({
    module: 'Finance', entityType: 'party_offsets', entityId: String(o.id), action: 'STATUS_CHANGE', field: 'status',
    oldValue: 'ACTIVE', newValue: { status: 'REVERSED', offsetNumber: nummer, amount: amountF / 1000, invoiceId: o.receivable_id, creditId: o.payable_id, reason },
    actor: { userId: userId || undefined, branchId: String(o.branch_id) },
  });
  return { offsetId: String(o.id), offsetNumber: nummer, creditId: String(o.payable_id), amount: amountF / 1000 };
}

export const OFFSET_HAS_LATER_RETURN = 'OFFSET_HAS_LATER_RETURN';

/**
 * Eine Rückgabe/Gutschrift, die NACH der Verrechnung an der Rechnung entstand, hat ihre Erstattung schon nach dem damals
 * Bezahlten bemessen — die Verrechnung jetzt aufzuheben, gäbe dem Kunden denselben Betrag ein zweites Mal (Guthaben bzw.
 * Darlehen wieder offen). Erst die Rückgabe stornieren. (Der Rechnungsstorno nimmt Verrechnungen VOR seiner Rückgabe zurück.)
 */
export function assertOffsetUndoSafe(o: Record<string, unknown>): void {
  const seit = String(o.created_at ?? '');
  const spaeter = query(
    `SELECT (SELECT COUNT(*) FROM sales_returns WHERE invoice_id = ? AND status != 'REJECTED' AND created_at >= ?)
          + (SELECT COUNT(*) FROM credit_notes WHERE invoice_id = ? AND status != 'CANCELLED' AND created_at >= ?) AS n`,
    [String(o.receivable_id), seit, String(o.receivable_id), seit],
  )[0];
  if (Number(spaeter?.n ?? 0) > 0) {
    throw new InvoiceActionRejected(OFFSET_HAS_LATER_RETURN,
      `a return or credit note was recorded on this invoice after ${String(o.offset_number)} — cancel it first, then undo the offset (no double refund). Nothing was changed`);
  }
}
