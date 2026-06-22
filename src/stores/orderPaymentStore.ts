import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId } from '@/core/db/helpers';
import { trackInsert, trackDelete, trackPayment } from '@/core/sync/track';
import { trackChange } from '@/core/sync/sync-service';   // sync-only (kein Audit) — orders-Summary + converted-Flag
import { useOrderStore } from '@/stores/orderStore';
import {
  postOrderPayment,
  postOrderPaymentReversed,
  postOrderOverpaymentCredit,
  reverseSource,
  beginLedgerTransaction,
  commitLedgerTransaction,
  rollbackLedgerTransaction,
  hasLedgerEntries,
  hasReversalFor,
} from '@/core/ledger/posting';
// Slice 4a — generische Ueberzahlungs-Credit-Teardown-Helfer (sourceType, sourceId),
// wiederverwendet aus invoiceStore (Slice 3a/3b) statt Duplikat. Keine Store-Kopplung:
// reine Funktionen, invoiceStore importiert orderStore/orderPaymentStore nicht zurueck.
import { assertGrantedCreditUnused, clawbackGrantedCredit } from '@/stores/invoiceStore';
import { bookCardFee, reverseCardFees } from '@/core/finance/card-fee-booking';
import { normalizeCardBrand, type CardBrand } from '@/core/finance/card-fees';

// ZIEL.md §3a — Posting-Service ist der einzige Schreibpfad für Finanzbuchungen.
function safePost(label: string, fn: () => void): void {
  try { fn(); } catch (err) {
    console.error(`[ledger] ${label} failed:`, err);
  }
}

// Plan §Order §Payment-Sync: Order-Summary (depositAmount/remaining/fullyPaid/status) immer
// aus der Summe der order_payments ableiten, damit OrderList/OrderDetail synchron sind.
function reconcileOrderFromPayments(orderId: string): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  // M-08 — converted Payments (Geld zur Invoice gewandert) zaehlen nicht mehr zum
  // Order-Saldo; deckt sich mit Banking/Analytics/Reconciliation.
  const sumRow = query(`SELECT COALESCE(SUM(amount), 0) AS t FROM order_payments WHERE order_id = ? AND COALESCE(converted_to_invoice, 0) = 0`, [orderId]);
  const totalPaid = Number(sumRow[0]?.t || 0);

  const orderRow = query(`SELECT agreed_price FROM orders WHERE id = ?`, [orderId]);
  if (orderRow.length === 0) return;
  const agreedPrice = (orderRow[0].agreed_price as number) || 0;

  const remaining = Math.max(0, agreedPrice - totalPaid);
  const fullyPaid = agreedPrice > 0 && totalPaid >= agreedPrice - 0.005;
  const depositPaid = totalPaid > 0;

  // Plan §Order: Order-Status ist orthogonal zum Zahlungsstand. Hier nur amounts/flags syncen.
  // Status-Wechsel (PENDING → ARRIVED → NOTIFIED → COMPLETED) erfolgt nur explizit per User.
  db.run(
    `UPDATE orders SET
       deposit_amount = ?,
       deposit_paid = ?,
       remaining_amount = ?,
       fully_paid = ?,
       deposit_date = COALESCE(deposit_date, CASE WHEN ? > 0 THEN ? ELSE NULL END),
       updated_at = ?
     WHERE id = ?`,
    [totalPaid, depositPaid ? 1 : 0, remaining, fullyPaid ? 1 : 0,
     totalPaid, now.split('T')[0], now, orderId]
  );
}

// ── Slice 4a — Order-Ueberzahlung → Store-Guthaben ────────────────────────────
// Nicht-konvertierter Zahlungs-Saldo der Order (deckungsgleich mit reconcileOrderFromPayments).
function nonConvertedTotal(orderId: string): number {
  const r = query(`SELECT COALESCE(SUM(amount), 0) AS t FROM order_payments WHERE order_id = ? AND COALESCE(converted_to_invoice, 0) = 0`, [orderId]);
  return Number(r[0]?.t || 0);
}
function orderAgreedPrice(orderId: string): number {
  const r = query(`SELECT agreed_price FROM orders WHERE id = ?`, [orderId]);
  return r.length ? Number(r[0].agreed_price || 0) : 0;
}
function existingOrderOverpayCredit(orderId: string): { id: string; amount: number; used: number } | null {
  const r = query(`SELECT id, amount, used_amount FROM customer_credits WHERE source_type = 'order_overpayment' AND source_id = ?`, [orderId]);
  if (r.length === 0) return null;
  return { id: r[0].id as string, amount: Number(r[0].amount || 0), used: Number(r[0].used_amount || 0) };
}
// PRE-CHECK (vor jeder Order-Payment-Mutation): wuerde der neue Saldo den Ueberzahlungs-
// Betrag aendern, waehrend die bestehende order_overpayment-Gutschrift schon (teil-)
// eingeloest ist → BLOCK (Entscheidung 3: kein Reversal benutzter Credits, sicherere
// Variante). Faellt frueh, vor INSERT/DELETE — kein Partial-State.
function assertOrderOverpayMutable(orderId: string, prospectiveTotalPaid: number): void {
  const ex = existingOrderOverpayCredit(orderId);
  if (!ex || ex.used <= 0.005) return;
  const newOver = Math.max(0, Math.round((prospectiveTotalPaid - orderAgreedPrice(orderId)) * 1000) / 1000);
  if (Math.abs(newOver - ex.amount) > 0.005) {
    throw new Error('Cannot change this order payment: the store credit from its overpayment has already been (partially) redeemed. Reverse the credit usage first.');
  }
}
// CLAWBACK-THEN-REBOOK (nach der Mutation + reconcileOrderFromPayments): bringt die EINE
// order_overpayment-Gutschrift (source_id=orderId) auf den aktuellen Ueberschuss. No-op
// wenn unveraendert. Reklass-Bein (ORDER_OVERPAY) + customer_credits-Row + Reverse atomar
// in EINER beginLedgerTransaction (wirft → rollback). reverseSource ist multi-cycle-safe
// (per-Leg), daher Reverse-and-Repost unter derselben sourceId zulaessig (wie editInvoice 3b).
export function reconcileOrderOverpayCredit(orderId: string): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  const agreed = orderAgreedPrice(orderId);
  const totalPaid = nonConvertedTotal(orderId);
  const newOver = Math.max(0, Math.round((totalPaid - agreed) * 1000) / 1000);
  const ex = existingOrderOverpayCredit(orderId);
  const exAmt = ex ? ex.amount : 0;
  if (Math.abs(newOver - exAmt) <= 0.005) return;           // unveraendert → nichts tun
  if (ex && ex.used > 0.005) {
    // Defense-in-depth: der Pre-Check (assertOrderOverpayMutable) sollte das schon abgefangen
    // haben; hier nie still loeschen/ersetzen.
    throw new Error('order_overpayment credit already redeemed — cannot rebook.');
  }
  const orderRow = query(`SELECT customer_id FROM orders WHERE id = ?`, [orderId])[0];
  const customerId = orderRow?.customer_id as string | undefined;
  let branchId = 'branch-main';
  try { branchId = currentBranchId(); } catch { /* defaults */ }

  beginLedgerTransaction();
  try {
    // Altes Reklass-Bein zuruecknehmen (falls vorhanden) + alte Domain-Row weg.
    if (hasLedgerEntries('ORDER_OVERPAY', orderId)) reverseSource('ORDER_OVERPAY', orderId, now);
    clawbackGrantedCredit('order_overpayment', orderId);
    // Neu buchen, wenn weiterhin ein Ueberschuss existiert.
    if (newOver > 0.005 && customerId) {
      const creditId = uuid();
      db.run(
        `INSERT INTO customer_credits (id, branch_id, customer_id, amount, used_amount, status, source_type, source_id, note, created_at)
         VALUES (?, ?, ?, ?, 0, 'OPEN', 'order_overpayment', ?, ?, ?)`,
        [creditId, branchId, customerId, newOver, orderId, 'Ueberzahlung Order', now]
      );
      trackInsert('customer_credits', creditId, { customerId, amount: newOver, sourceOrderId: orderId });
      postOrderOverpaymentCredit(orderId, customerId, newOver, now);
    }
    commitLedgerTransaction();
  } catch (e) {
    rollbackLedgerTransaction();
    throw e;
  }
}
// Teardown fuer terminale Pfade (deleteOrder / cancelOrderWithMoney / markConvertedToInvoice):
// BLOCK bei eingeloester Gutschrift → Reklass-Bein reversen → Domain-Row weg. Kein Rebook
// (Order terminal/konvertiert). reverse in safePost-Manier ueber den Caller (hier direkt,
// guarded). Exportiert fuer orderStore.
export function teardownOrderOverpayCredit(orderId: string, blockMsg: string): void {
  assertGrantedCreditUnused('order_overpayment', orderId, blockMsg);
  if (hasLedgerEntries('ORDER_OVERPAY', orderId) && !hasReversalFor('ORDER_OVERPAY', orderId)) {
    reverseSource('ORDER_OVERPAY', orderId, new Date().toISOString());
  }
  clawbackGrantedCredit('order_overpayment', orderId);
}

export interface OrderPayment {
  id: string;
  orderId: string;
  amount: number;
  paidAt: string;
  method?: string;
  cardBrand?: CardBrand;   // v0.7.26 — nur bei method === 'card'
  reference?: string;
  note?: string;
  createdAt: string;
  convertedToInvoice?: boolean;   // M-08 — true wenn beim Convert ans Invoice abgegeben
}

interface OrderPaymentStore {
  paymentsByOrder: Record<string, OrderPayment[]>;
  loadPayments: (orderId: string) => void;
  addPayment: (p: Omit<OrderPayment, 'id' | 'createdAt'>) => OrderPayment;
  deletePayment: (id: string, orderId: string) => void;
  totalPaid: (orderId: string) => number;
  // Plan §3a + §Order Convert: Beim Convert-to-Invoice werden alle Order-Payments
  // ans Ledger zurück-gespiegelt (Customer-Deposits → Cash-Reverse), damit die parallel
  // erzeugten invoice_payments nicht doppelt-Cash buchen. SQL-Flag converted_to_invoice=1
  // wird in derselben Operation gesetzt.
  markConvertedToInvoice: (orderId: string) => void;
}

function rowToPayment(r: Record<string, unknown>): OrderPayment {
  return {
    id: r.id as string,
    orderId: r.order_id as string,
    amount: (r.amount as number) || 0,
    paidAt: r.paid_at as string,
    method: r.method as string | undefined,
    cardBrand: (r.card_brand as CardBrand | null) || undefined,
    reference: r.reference as string | undefined,
    note: r.note as string | undefined,
    createdAt: r.created_at as string,
    convertedToInvoice: !!r.converted_to_invoice,
  };
}

export const useOrderPaymentStore = create<OrderPaymentStore>((set, get) => ({
  paymentsByOrder: {},

  loadPayments: (orderId) => {
    try {
      const rows = query(
        'SELECT * FROM order_payments WHERE order_id = ? ORDER BY paid_at ASC, created_at ASC',
        [orderId]
      );
      set(s => ({ paymentsByOrder: { ...s.paymentsByOrder, [orderId]: rows.map(rowToPayment) } }));
    } catch {
      set(s => ({ paymentsByOrder: { ...s.paymentsByOrder, [orderId]: [] } }));
    }
  },

  addPayment: (p) => {
    if (!Number.isFinite(p.amount) || p.amount <= 0) {
      throw new Error('Order payment amount must be a positive number.');
    }
    const db = getDatabase();
    const id = uuid();
    const now = new Date().toISOString();
    // Slice 4a — Pre-Check VOR jeder Mutation: wuerde diese Zahlung den Ueberzahlungs-Betrag
    // aendern, waehrend die bestehende order_overpayment-Gutschrift schon eingeloest ist → BLOCK.
    assertOrderOverpayMutable(p.orderId, nonConvertedTotal(p.orderId) + p.amount);
    // v0.7.26 — Karten-Brand nur bei method 'card'; steuert die Gebuehren-Rate.
    const brand: CardBrand | null = p.method === 'card' ? normalizeCardBrand(p.cardBrand) : null;
    db.run(
      `INSERT INTO order_payments (id, order_id, amount, paid_at, method, card_brand, reference, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, p.orderId, p.amount, p.paidAt, p.method || null, brand, p.reference || null, p.note || null, now]
    );
    reconcileOrderFromPayments(p.orderId);
    saveDatabase();
    trackInsert('order_payments', id, { orderId: p.orderId, amount: p.amount, method: p.method });
    trackPayment('orders', p.orderId, p.amount, p.method || 'cash');
    // LAN-Sync (Gruppe 3): orders-Summary (deposit/remaining/fully_paid) war nur audit-getrackt
    // (trackPayment) → B stale. Header-Snapshot nach dem reconcile-Recompute.
    trackChange('orders', p.orderId, 'update', {});
    get().loadPayments(p.orderId);
    useOrderStore.getState().loadOrders(); // Order-Summary in UI refreshen

    // ZIEL.md §3a — Order-Payment ans Ledger (DEBIT cash / CREDIT CUSTOMER_DEPOSITS).
    safePost(`postOrderPayment(${id})`, () => {
      if (hasLedgerEntries('ORDER_PAYMENT', id)) return;
      const orderRow = query('SELECT customer_id FROM orders WHERE id = ?', [p.orderId])[0];
      const customerId = orderRow?.customer_id as string | undefined;
      if (!customerId) return;
      postOrderPayment(
        { id, orderId: p.orderId, amount: p.amount, method: p.method, paidAt: p.paidAt },
        customerId
      );
    });

    // v0.7.26 — Karten-Gebuehr buchen (brand-genau). created_at = now matcht den
    // order_payments-Insert → bankingStore nettet die Order-Bank-Zeile netto.
    if (brand) {
      let branchId = 'branch-main', userId = 'user-owner';
      try { branchId = currentBranchId(); userId = currentUserId(); } catch { /* defaults */ }
      const orderNumber = (query('SELECT order_number FROM orders WHERE id = ?', [p.orderId])[0]?.order_number as string) || p.orderId.slice(0, 8);
      bookCardFee({ branchId, userId, amount: p.amount, brand, relatedModule: 'order', relatedEntityId: p.orderId, label: orderNumber, createdAt: now });
    }

    // Slice 4a — nach dem Producer-Post (CUSTOMER_DEPOSITS existiert) den Ueberschuss ueber
    // agreedPrice in Store-Guthaben reklassieren (clawback-then-rebook, idempotent).
    reconcileOrderOverpayCredit(p.orderId);
    get().loadPayments(p.orderId);
    useOrderStore.getState().loadOrders();

    return { id, createdAt: now, ...p };
  },

  deletePayment: (id, orderId) => {
    const db = getDatabase();
    // v0.7.26 — method + created_at merken (fuer evtl. CardFee-Reversal nach Delete).
    const before = query('SELECT method, created_at, amount FROM order_payments WHERE id = ?', [id])[0];
    // Slice 4a — Pre-Check VOR dem DELETE: senkt das Loeschen den Ueberzahlungs-Betrag,
    // waehrend die order_overpayment-Gutschrift schon eingeloest ist → BLOCK.
    const delAmt = before ? Number(before.amount || 0) : 0;
    assertOrderOverpayMutable(orderId, Math.max(0, nonConvertedTotal(orderId) - delAmt));
    db.run(`DELETE FROM order_payments WHERE id = ?`, [id]);
    reconcileOrderFromPayments(orderId);
    saveDatabase();
    trackDelete('order_payments', id);
    // LAN-Sync (Gruppe 3): orders-Summary nach dem reconcile-Recompute syncen (war ungetrackt).
    trackChange('orders', orderId, 'update', {});
    get().loadPayments(orderId);
    useOrderStore.getState().loadOrders();

    // ZIEL.md §3a — Reverse Ledger-Buchung beim Löschen.
    safePost(`postOrderPaymentReversed(${id}) [delete]`, () => {
      if (!hasLedgerEntries('ORDER_PAYMENT', id)) return;
      if (hasReversalFor('ORDER_PAYMENT', id)) return;
      postOrderPaymentReversed(id);
    });

    // Slice 4a — Ueberzahlungs-Gutschrift auf den neuen (niedrigeren) Ueberschuss
    // nachziehen (reverse+clawback, ggf. rebook). Nach dem Producer-Reverse.
    reconcileOrderOverpayCredit(orderId);
    get().loadPayments(orderId);
    useOrderStore.getState().loadOrders();

    // v0.7.26 — War es eine Karten-Zahlung, die zugehoerige CardFee mit-reversen.
    if (before && (before.method as string) === 'card' && before.created_at) {
      reverseCardFees('order', orderId, before.created_at as string);
    }
  },

  markConvertedToInvoice: (orderId) => {
    const db = getDatabase();
    // Slice 4a — VOR dem Order-Payment-Reverse die Ueberzahlungs-Gutschrift sauber abbauen:
    // BLOCK falls schon eingeloest; sonst Reklass-Bein (ORDER_OVERPAY) reversen + Domain-Row
    // weg. Danach traegt der Carry-Over den vollen Pool zur Invoice → der 3a-Overpay-Split
    // erzeugt GENAU EINE Invoice-Gutschrift fuer den Ueberschuss (kein Doppel-Credit).
    teardownOrderOverpayCredit(orderId,
      'Cannot convert this order to an invoice because the store credit from its overpayment has already been used. Reverse that credit usage first.');
    // Ledger zuerst reverse — bevor wir das converted_to_invoice-Flag setzen.
    // Das stellt sicher, dass die nachfolgenden invoice_payments (die im Carry-Over
    // erzeugt werden) auf nicht-doppelten Cash-Stand buchen.
    const rows = query('SELECT id FROM order_payments WHERE order_id = ?', [orderId]);
    for (const r of rows) {
      const opId = r.id as string;
      safePost(`postOrderPaymentReversed(${opId}) [convert]`, () => {
        if (!hasLedgerEntries('ORDER_PAYMENT', opId)) return;
        if (hasReversalFor('ORDER_PAYMENT', opId)) return;
        postOrderPaymentReversed(opId);
      });
    }
    // v0.7.26 — Order-CardFees reversen: die Gebuehr wandert beim Convert auf die
    // Invoice (carryOver ruft recordPayment(card, brand) → frische CardFee dort).
    // Keine Doppelbuchung; Banking-Netting bleibt korrekt.
    reverseCardFees('order', orderId);
    db.run(`UPDATE order_payments SET converted_to_invoice = 1 WHERE order_id = ?`, [orderId]);
    saveDatabase();
    // LAN-Sync (Gruppe 3): converted-Flag je betroffener order_payments-Row tracken (IDs aus `rows`
    // oben, vor der Mutation erfasst) — Bulk-WHERE order_id=? ist sonst nicht trackbar.
    for (const r of rows) trackChange('order_payments', r.id as string, 'update', {});
  },

  totalPaid: (orderId) => {
    const list = get().paymentsByOrder[orderId] || [];
    // M-08 — converted Payments ausschliessen (konsistent zu reconcileOrderFromPayments).
    return list.filter(p => !p.convertedToInvoice).reduce((sum, p) => sum + p.amount, 0);
  },
}));
