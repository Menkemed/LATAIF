// ════════════════════════════════════════════════════════════════════════════
// CUSTOM-ORDER K2 — die Anzahlung einer Order wird auf ihre Rechnung ANGERECHNET.
//
// Vorher drehte die Umwandlung die Anzahlung samt Kartengebühr im Hauptbuch zurück und buchte sie auf der
// Rechnung als neue Zahlung von HEUTE (neue Gebühr, Banking am Umwandlungstag). Nach einem Storno der
// Rechnung war sie nirgends mehr offen, und die erneute Umwandlung erfand eine Barzahlung.
//
// Jetzt bleibt der Geldeingang, wo er war (Order-Zahlung, ORDER_PAYMENT-Buchung, Kartengebühr, Banking —
// alles am Zahlungstag). Die Rechnung bekommt je angerechneter Order-Zahlung eine Zahlung der Art
// 'order_deposit' zum Rechnungstag: Soll CUSTOMER_DEPOSITS / Haben AR, keine Gebühr, kein Geld. Je
// Anrechnung eine Zeile in order_deposit_applications. Übersteigt die Anzahlung den vereinbarten Preis, wird
// der Überschuss — wie bisher — beim Anrechnen Kundenguthaben (Überzahlungs-Split der Zahlung). Ein Rest für
// eine spätere Teilrechnung bleibt OFFEN an seiner Order-Zahlung: Originaldatum, Zahlungsart, keine neue Gebühr.
//
// Eine Zahlung wird nur übernommen, wenn eine offene Order-Zahlung sie belegt. Ohne Anzahlung bleibt die
// Rechnung offen. Nur ein Altauftrag mit Kopf-Anzahlung, aber ohne jede Zahlungszeile, wird abgelehnt.
// Läuft immer in der Klammer der Umwandlung (Primary und PC2): ein Fehler rollt alles zurück.
// ════════════════════════════════════════════════════════════════════════════
import { v4 as uuid } from 'uuid';
import { getDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId } from '@/core/db/helpers';
import { trackInsert, trackUpdate } from '@/core/sync/track';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { teardownOrderOverpayCredit, refreshOrderPaymentSummary } from '@/stores/orderPaymentStore';
import { assertNotFinalizingIntoClosedVatQuarter } from '@/core/tax/vat-period-lock';
import { OrderActionRejected } from '@/core/orders/order-create';
import { ORDER_DEPOSIT_METHOD, openDepositSql } from './order-deposit-sql';

const r3 = (n: number): number => Math.round(n * 1000) / 1000;
const EPS = 0.0005;

export interface OpenDepositRow { id: string; open: number; method: string; cardBrand: string | null; paidAt: string }

/** Die offenen Order-Zahlungen in Zahlungsreihenfolge (ältester Tag zuerst). */
export function openDepositRows(orderId: string): OpenDepositRow[] {
  return query(
    `SELECT op.id, ${openDepositSql('op')} AS open, op.method, op.card_brand, op.paid_at
       FROM order_payments op WHERE op.order_id = ?
      ORDER BY op.paid_at ASC, op.created_at ASC`,
    [orderId],
  ).map((r) => ({ id: String(r.id), open: r3(Number(r.open) || 0), method: String(r.method ?? ''), cardBrand: (r.card_brand as string) || null, paidAt: String(r.paid_at ?? '') }))
    .filter((r) => r.open > EPS);
}

/** Wie viel die Umwandlung anrechnen würde — rein lesend (für die Prüfung vor dem ersten Schreiben). */
export function plannedDepositApplication(orderId: string, invoiceTotal: number): { pool: number; apply: number } {
  const pool = r3(openDepositRows(orderId).reduce((s, r) => s + r.open, 0));
  if (pool <= EPS) return { pool: 0, apply: 0 };
  const agreed = Number(query('SELECT agreed_price FROM orders WHERE id = ?', [orderId])[0]?.agreed_price ?? 0) || 0;
  const cap = Math.min(pool, invoiceTotal);
  // Der Teil über dem vereinbarten Preis ist Überzahlung — er geht beim Anrechnen ins Kundenguthaben (Split).
  const overpay = Math.max(0, r3(pool - Math.max(agreed, invoiceTotal)));
  return { pool, apply: r3(cap + overpay) };
}

/**
 * Darf die Anrechnung die Rechnung an diesem Tag voll bezahlt stellen? (VAT-Sperre — vor dem ersten Schreiben.)
 * Altauftrag mit Kopf-Anzahlung ohne jede Zahlungszeile: Nein — eine Zahlung ohne Beleg wird nicht erfunden.
 */
export function assertDepositApplicationAllowed(orderId: string, invoiceTotal: number, appliedAtIso: string, branchId: string): void {
  const rows = Number(query('SELECT COUNT(*) AS n FROM order_payments WHERE order_id = ?', [orderId])[0]?.n ?? 0);
  if (rows === 0) {
    const head = query('SELECT deposit_amount, deposit_paid FROM orders WHERE id = ?', [orderId])[0];
    if (head && Number(head.deposit_paid ?? 0) === 1 && Number(head.deposit_amount ?? 0) > EPS) {
      throw new OrderActionRejected('ORDER_DEPOSIT_WITHOUT_PAYMENT',
        'this order shows a deposit but has no recorded payment — record the payment (amount, date, method) on the order first. Nothing was changed.');
    }
    return;
  }
  const plan = plannedDepositApplication(orderId, invoiceTotal);
  if (plan.apply > EPS && plan.apply >= invoiceTotal - EPS) assertNotFinalizingIntoClosedVatQuarter(branchId, appliedAtIso);
}

export interface DepositApplied { applied: number; paymentIds: string[]; applicationIds: string[] }

/** Rechnet die offenen Anzahlungen der Order auf die Rechnung an (FIFO). In der Klammer des Aufrufers. */
export function applyOrderDepositsToInvoice(args: {
  invoiceId: string; orderId: string; orderNumber: string; invoiceTotal: number; appliedAtIso: string;
}): DepositApplied {
  const { invoiceId, orderId, orderNumber, invoiceTotal, appliedAtIso } = args;
  let branchId = 'branch-main', userId = 'user-owner';
  try { branchId = currentBranchId(); userId = currentUserId(); } catch { /* Standard */ }
  assertDepositApplicationAllowed(orderId, invoiceTotal, appliedAtIso, branchId);
  const plan = plannedDepositApplication(orderId, invoiceTotal);
  const out: DepositApplied = { applied: 0, paymentIds: [], applicationIds: [] };
  if (plan.apply <= EPS) return out;

  // Die Überzahlungs-Gutschrift der Order (ORDER_OVERPAY) wird abgebaut; ihr Betrag geht mit der Anrechnung als
  // Überzahlungs-Split der Rechnungszahlung wieder ins Kundenguthaben — EINE Gutschrift, nicht zwei.
  teardownOrderOverpayCredit(orderId,
    'Cannot convert this order to an invoice because the store credit from its overpayment has already been used. Reverse that credit usage first.');

  const db = getDatabase();
  const nowIso = new Date().toISOString();
  let budget = plan.apply;
  for (const row of openDepositRows(orderId)) {
    if (budget <= EPS) break;
    const take = r3(Math.min(row.open, budget));
    if (take <= EPS) continue;
    const paymentId = uuid();
    const note = `Order deposit ${orderNumber} · ${row.method || 'payment'} · paid ${row.paidAt.slice(0, 10)}`;
    // Angerechnet wird frühestens, wenn das Geld da war: liegt der Rechnungstag VOR dem Zahltag der Anzahlung, gilt der
    // Zahltag (sonst stünde die Anzahlungsschuld zwischen beiden Tagen im Minus).
    const paidIso = /^\d{4}-\d{2}-\d{2}$/.test(row.paidAt) ? `${row.paidAt}T00:00:00.000Z` : row.paidAt;
    const when = paidIso && paidIso > appliedAtIso ? paidIso : appliedAtIso;
    useInvoiceStore.getState().recordPayment(invoiceId, take, ORDER_DEPOSIT_METHOD, note, undefined, undefined, paymentId, false,
      { receivedAt: when, createdAt: nowIso });
    const appId = uuid();
    db.run(
      `INSERT INTO order_deposit_applications (id, branch_id, order_id, order_payment_id, invoice_id, payment_id, amount, applied_at, status, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
      [appId, branchId, orderId, row.id, invoiceId, paymentId, take, when, nowIso, userId],
    );
    trackInsert('order_deposit_applications', appId, { orderId, orderPaymentId: row.id, invoiceId, paymentId, amount: take });
    if (row.open - take <= EPS) {
      db.run('UPDATE order_payments SET converted_to_invoice = 1 WHERE id = ?', [row.id]);
      trackUpdate('order_payments', row.id, { convertedToInvoice: true });
    }
    out.applied = r3(out.applied + take);
    out.paymentIds.push(paymentId);
    out.applicationIds.push(appId);
    budget = r3(budget - take);
  }
  refreshOrderPaymentSummary(orderId);
  return out;
}
