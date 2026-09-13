// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6F — der Lebenszyklus eines Einkaufs am Haus: „Return to Supplier",
// „Cancel" und „Inbox-Foto verwerfen" — EINE Folge für die Maske des Primary und für die
// Fernbefehle von PC2 (`purchases.return_to_supplier`, `purchases.cancel`, `purchases.dismiss_inbox`).
//
// Was vorher geschah (auditiert, nicht angenommen) — `purchaseStore`:
//
//   • „Confirm Return" rief `createReturn` und DANACH `confirmReturn`: zwei Schritte, zwei
//     Speichervorgänge, keine Klammer. Die Buchung lief über `safePost` — scheiterte sie, stand die
//     Retoure trotzdem (Bestand weg, Verbindlichkeit gesenkt, Hauptbuch unverändert).
//   • Beide lasen den Einkauf aus der GELADENEN Liste des Stores, ohne Filiale.
//   • Die Menge wurde still auf den Restbestand des Loses gekappt: eine schon verkaufte Ware ließ
//     sich „zurückgeben", INVENTORY wurde für Ware gutgeschrieben, die das Lager längst verlassen
//     hatte (Lager im Hauptbuch negativ), und der Einkauf verlor seine Verbindlichkeit dafür.
//   • Der Status danach kam nur aus dem Bargeld (`computeStatus(total, paid)`): ein mit
//     Lieferanten-Guthaben beglichener Einkauf stand nach der Retoure auf UNPAID — bei Rest 0.
//   • Eine Erstattung per Benefit wurde auf BANK gebucht (die Zahlung selbst geht auf BENEFIT).
//   • „Cancel" buchte Zahlungs- und Einkaufsstorno über `safePost` (verschluckt) und ließ eine
//     bestätigte Retoure stehen: nach dem Storno blieb deren INVENTORY-Gutschrift / AP-Lastschrift im
//     Hauptbuch — Lager negativ, Lieferant mit Phantom-Saldo, Retouren-Guthaben weiter einlösbar.
//   • „Dismiss" war ein blinder Status-Update — auch auf ein Foto, aus dem schon ein Einkauf wurde.
//
// Jetzt: prüfen (aus der DATENBANK, in der Filiale des Auftrags), dann dieselben Schritte wie
// bisher — alles INNERHALB der Transaktion des Aufrufers (`runOnPrimary` am Primary,
// `runRemoteCommand` für PC2). Diese Datei öffnet, schließt und rollt nie selbst zurück, speichert
// nie selbst; ein Nein ist ein geworfener `PurchaseLifecycleRejected` mit festem Code. Jede Buchung
// ist strikt: scheitert sie, gibt es auch die Handlung nicht. Sie importiert den Store NICHT —
// der Store ruft sie (umgekehrt wäre es ein Kreis).
// ════════════════════════════════════════════════════════════════════════════
import { v4 as uuid } from 'uuid';
import type { OrderLineStatus, OrderStatus, Purchase, PurchaseStatus } from '@/core/models/types';
import { deriveOrderStatusFromLines } from '@/core/models/types';
import { getDatabase } from '@/core/db/database';
import { query, getNextDocumentNumber } from '@/core/db/helpers';
import { isClientMode } from '@/core/bridge/client-mode';
import { trackInsert, trackUpdate, trackRefund, trackDelete } from '@/core/sync/track';
import { trackChange } from '@/core/sync/sync-service';
import {
  consumeLot, restoreLot, getAvailableStock, syncProductQuantity, trackLotRow, trackProductRow,
} from '@/core/lots/lot-queries';
import {
  postEntries, reverseSource, postPurchaseCancelled, hasLedgerEntries, hasReversalFor, getPurchaseLineInputSplit,
} from '@/core/ledger/posting';
import {
  assertSupplierOverpayMutable, reconcilePurchaseOverpayCredit, teardownSupplierOverpayCredit, OverpayCreditRedeemed,
} from '@/core/payables/purchase-overpay';
import { restoreSupplierCreditUsage } from '@/core/finance/supplierCreditRestore';
import { logAuditOrThrow } from '@/core/audit/audit-log';
import type { HouseCtx } from '@/core/payables/payables-house';

/** Die drei Buchungen dieses Bereichs — Maske (useSharedWrite) und Fernbefehl benutzen DIESE Namen. */
export const PURCHASE_LIFECYCLE_OP = {
  RETURN_TO_SUPPLIER: 'purchases.return_to_supplier',
  CANCEL: 'purchases.cancel',
  DISMISS_INBOX: 'purchases.dismiss_inbox',
} as const;

/** Ein fachliches Nein des Einkaufs-Lebenszyklus — am Primary eine Absage der Maske, fern ein eingefrorenes Urteil. */
export class PurchaseLifecycleRejected extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PurchaseLifecycleRejected';
    this.code = code;
  }
}
const nein = (code: string, message: string): PurchaseLifecycleRejected => new PurchaseLifecycleRejected(code, message);

export const PURCHASE_PRIMARY_ONLY = 'PURCHASE_PRIMARY_ONLY';

/** Die Erstattungswege der Maske „REFUND METHOD (if paid)" — dieselben vier, nicht mehr. */
export const REFUND_METHODS = ['cash', 'bank', 'benefit', 'credit'] as const;
export type RefundMethod = typeof REFUND_METHODS[number];
export const isRefundMethod = (v: unknown): v is RefundMethod => (REFUND_METHODS as readonly unknown[]).includes(v);

// BHD = 3 Dezimalstellen (Fils). Gerechnet und verglichen wird in Minor Units.
const F = (n: unknown): number => Math.round((Number(n) || 0) * 1000);
const B = (f: number): number => f / 1000;
const dayOf = (iso: string): string => iso.split('T')[0];

// Die Meldung, mit der der Store den Teardown schon immer abwies — derselbe Wortlaut für die Vorabprüfung.
const OVERPAY_REDEEMED_MSG =
  'Cannot cancel this purchase because the supplier credit from its overpayment has already been used. Reverse that credit usage first.';

/** Ein Rechner ohne Bücher (PC2) schreibt NIE in eine lokale Datenbank — die Handlung geht zum Primary. */
function assertBooks(): void {
  if (isClientMode()) {
    throw nein(PURCHASE_PRIMARY_ONLY, 'this happens on the main computer — this window has no business database');
  }
}

function livePurchase(id: string, branchId: string): Record<string, unknown> {
  const r = query('SELECT * FROM purchases WHERE id = ? AND branch_id = ?', [id, branchId])[0];
  if (!r) throw nein('PURCHASE_NOT_FOUND', 'no such purchase in this branch');
  return r;
}

/** Die gesehene Fassung, INNERHALB der Transaktion gegen die Zeile selbst — vor jeder Regel. */
function assertSeen(purchaseId: string, expected: number | undefined): void {
  if (expected === undefined) return;
  const now = revisionOf(purchaseId);
  if (now !== expected) {
    throw nein('RECORD_CHANGED', `this purchase changed since you opened it (you saw ${expected}, it is now ${now}) — reload and try again`);
  }
}
const revisionOf = (purchaseId: string): number =>
  Number(query('SELECT revision FROM purchases WHERE id = ?', [purchaseId])[0]?.revision ?? 0);

/** Dieselbe Statusregel wie `computeStatus` im Store — nur auf dem BEGLICHENEN (Bargeld + Guthaben), in Fils. */
function statusOf(totalF: number, settledF: number): PurchaseStatus {
  if (totalF <= 0) return 'DRAFT';
  if (settledF <= 0) return 'UNPAID';
  if (settledF >= totalF) return 'PAID';
  return 'PARTIALLY_PAID';
}

const creditPaidF = (purchaseId: string): number =>
  F(query(`SELECT COALESCE(SUM(amount), 0) AS t FROM purchase_payments WHERE purchase_id = ? AND method = 'credit'`, [purchaseId])[0]?.t);

/** Das Nein der Overpay-Helfer (Slice 4b) wird ein Nein DIESES Hauses — mit demselben Code. */
function liveOrRedeemed<T>(fn: () => T): T {
  try { return fn(); } catch (e) {
    if (e instanceof OverpayCreditRedeemed) throw nein(e.code, e.message);
    throw e;
  }
}

// ── Auftrag (Back-to-Back): Zeilenstatus per Raw-SQL ───────────────────────
// Aus `purchaseStore` hierher gezogen (inhaltlich unverändert): der Storno braucht sie, und das
// Haus darf den Store nicht importieren. Der Store ruft `recomputeOrderStatusRaw` von hier.

type SqlDb = ReturnType<typeof getDatabase>;

export function recomputeOrderStatusRaw(db: SqlDb, orderId: string): void {
  const now = new Date().toISOString();
  const orderRows = query(`SELECT status FROM orders WHERE id = ?`, [orderId]);
  if (orderRows.length === 0) return;
  const currentStatus = (orderRows[0].status as OrderStatus) || 'pending';
  const lineRows = query(
    `SELECT status FROM order_lines WHERE order_id = ? AND COALESCE(is_customer_facing, 1) = 1`,
    [orderId]
  );
  if (lineRows.length === 0) return;
  const statuses = lineRows.map(r => ((r.status as string) || 'PENDING') as OrderLineStatus);
  const derived = deriveOrderStatusFromLines(statuses, currentStatus);
  if (derived !== currentStatus) {
    db.run(`UPDATE orders SET status = ?, updated_at = ? WHERE id = ?`, [derived, now, orderId]);
    trackUpdate('orders', orderId, { status: derived });
  }
}

// Nach dem Storno: verknuepfte ARRIVED-Zeilen zurueck auf PENDING (nur nicht-invoicte) — die
// Order kann dann neu beschafft werden. Liefert die Zahl der zurueckgesetzten Zeilen.
export function revertLinkedOrderLines(db: SqlDb, purchaseId: string): number {
  const linkRows = query(
    `SELECT DISTINCT source_order_line_id AS olid FROM purchase_lines
       WHERE purchase_id = ? AND source_order_line_id IS NOT NULL`,
    [purchaseId]
  );
  const affectedOrders = new Set<string>();
  let reverted = 0;
  for (const lr of linkRows) {
    const olid = lr.olid as string;
    const rows = query(`SELECT order_id, status, invoice_id FROM order_lines WHERE id = ?`, [olid]);
    if (rows.length === 0) continue;
    if (rows[0].invoice_id) continue;
    if ((rows[0].status as string) !== 'ARRIVED') continue;
    db.run(`UPDATE order_lines SET status = 'PENDING' WHERE id = ?`, [olid]);
    trackUpdate('order_lines', olid, { status: 'PENDING' });
    affectedOrders.add(rows[0].order_id as string);
    reverted++;
  }
  for (const oid of affectedOrders) recomputeOrderStatusRaw(db, oid);
  return reverted;
}

// ════════════════════════════════════════════════════════════════════════════
// „Return to Supplier"
// ════════════════════════════════════════════════════════════════════════════

/** Was die Rückgabe mit Verbindlichkeit, Erstattung und Status macht — EINE Rechnung für Prüfung und Wirkung. */
interface ReturnPlan {
  refundF: number;
  newTotalF: number;
  newPaidF: number;
  newRemainingF: number;
  status: PurchaseStatus;
}

// Plan §7 + §8: Payable reduzieren ODER Refund — erst aus dem offenen Rest, der Ueberschuss wird
// erstattet (Cash/Bank/Benefit ↑ oder Lieferanten-Guthaben). Unveraendert aus `confirmReturn`,
// nur in Fils. R6F — der Status kommt aus dem BEGLICHENEN (Summe − neuer Rest), nicht nur aus dem
// Bargeld: ohne Guthaben-Einloesung ist das exakt `computeStatus(newTotal, newPaid)`; mit ihr stand
// ein beglichener Einkauf vorher auf UNPAID.
function planReturn(p: Record<string, unknown>, totalRetF: number): ReturnPlan {
  const remainingF = F(p.remaining_amount);
  let newRemainingF: number;
  let refundF: number;
  if (remainingF >= totalRetF) {
    newRemainingF = remainingF - totalRetF;
    refundF = 0;
  } else {
    refundF = totalRetF - remainingF;
    newRemainingF = 0;
  }
  const newTotalF = Math.max(0, F(p.total_amount) - totalRetF);
  const newPaidF = Math.max(0, F(p.paid_amount) - refundF);
  const status: PurchaseStatus = String(p.status) === 'CANCELLED'
    ? 'CANCELLED'
    : statusOf(newTotalF, newTotalF - newRemainingF);
  return { refundF, newTotalF, newPaidF, newRemainingF, status };
}

/** Das Konto, auf das eine Erstattung fließt — dieselbe Zuordnung wie bei der Zahlung (`purchaseCashAccountFor`). */
function refundAccountFor(method: string | null): 'CASH' | 'BANK' | 'BENEFIT' | 'SUPPLIER_CREDIT' {
  switch (method) {
    case 'cash': return 'CASH';
    case 'bank': return 'BANK';
    // R6F — vorher fiel Benefit hier auf BANK: das Geld kam auf dem Benefit-Konto zurück, das
    // Hauptbuch zeigte es auf der Bank.
    case 'benefit': return 'BENEFIT';
    case 'credit': return 'SUPPLIER_CREDIT';
    default: return 'BANK';
  }
}

/** Die Anlage einer Retoure (Status DRAFT, noch ohne Wirkung) — auch der Weg des Store-Altaufrufs `createReturn`. */
export interface PurchaseReturnDraftInput {
  purchaseId: string;
  returnDate?: string;
  refundMethod?: RefundMethod;
  notes?: string;
  lines: Array<{ purchaseLineId: string; productId?: string; quantity: number; unitPrice: number }>;
}

export function createPurchaseReturnDraftInHouse(input: PurchaseReturnDraftInput, ctx: HouseCtx): { returnId: string; returnNumber: string } {
  assertBooks();
  const p = livePurchase(input.purchaseId, ctx.branchId);
  const db = getDatabase();
  const id = uuid();
  const returnNumber = getNextDocumentNumber('PRET');
  const returnDate = input.returnDate || dayOf(ctx.now);
  // Der Artikel einer Zeile ist der der EINKAUFSZEILE — nicht, was ein Aufrufer dazu nennt.
  const lines = input.lines.map((l) => {
    const pl = query('SELECT product_id FROM purchase_lines WHERE id = ? AND purchase_id = ?', [l.purchaseLineId, input.purchaseId])[0];
    return {
      id: uuid(),
      purchaseLineId: l.purchaseLineId,
      productId: (pl?.product_id as string | null) || l.productId || null,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      lineTotalF: F(l.quantity * l.unitPrice),
    };
  });
  const totalF = lines.reduce((s, l) => s + l.lineTotalF, 0);
  db.run(
    `INSERT INTO purchase_returns (id, branch_id, return_number, purchase_id, supplier_id, status, total_amount,
      return_date, refund_method, refund_amount, notes, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, 0, ?, ?, ?)`,
    [id, ctx.branchId, returnNumber, input.purchaseId, String(p.supplier_id ?? ''), B(totalF), returnDate,
     input.refundMethod || null, input.notes || null, ctx.now, ctx.userId || null]
  );
  for (const l of lines) {
    db.run(
      `INSERT INTO purchase_return_lines (id, return_id, purchase_line_id, product_id, quantity, unit_price, line_total)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [l.id, id, l.purchaseLineId, l.productId, l.quantity, l.unitPrice, B(l.lineTotalF)]
    );
  }
  trackInsert('purchase_returns', id, { returnNumber, purchaseId: input.purchaseId, total: B(totalF) });
  // LAN-Sync (Bug-5): purchase_return_lines NACH dem Header tracken (FK-Reihenfolge), sync-only.
  for (const l of lines) trackChange('purchase_return_lines', l.id, 'insert', {});
  return { returnId: id, returnNumber };
}

export interface PurchaseReturnConfirmed {
  returnId: string;
  status: 'CONFIRMED' | 'COMPLETED';
  refundAmount: number;
  supplierCreditId: string | null;
  purchaseStatus: PurchaseStatus;
  remainingAmount: number;
}

/**
 * Die Wirkung einer Retoure: Einkauf (Summe, Bezahltes, Rest, Status), Lose und Artikel, Status der
 * Retoure, Erstattung oder Lieferanten-Guthaben, Buchung, Overpay-Nachzug — auch der Weg des
 * Store-Altaufrufs `confirmReturn`. Strikt: die Buchung wirft, statt verschluckt zu werden.
 */
export function confirmPurchaseReturnInHouse(returnId: string, ctx: HouseCtx): PurchaseReturnConfirmed {
  assertBooks();
  const ret = query('SELECT * FROM purchase_returns WHERE id = ? AND branch_id = ?', [returnId, ctx.branchId])[0];
  if (!ret) throw nein('PURCHASE_RETURN_NOT_FOUND', 'no such supplier return in this branch');
  if (String(ret.status) !== 'DRAFT') throw nein('PURCHASE_RETURN_NOT_DRAFT', 'this supplier return is already confirmed');
  const purchaseId = String(ret.purchase_id ?? '');
  const p = livePurchase(purchaseId, ctx.branchId);
  const supplierId = String(p.supplier_id ?? '');
  const returnNumber = String(ret.return_number ?? '');
  const method = (ret.refund_method as string | null) || null;
  const lines = query('SELECT * FROM purchase_return_lines WHERE return_id = ?', [returnId]);
  const totalRetF = F(ret.total_amount);
  const plan = planReturn(p, totalRetF);
  // Slice 4b — Pre-Check VOR dem Total-UPDATE: der Return aendert total/paid → den Ueberschuss.
  // Ist die Overpay-Gutschrift schon eingeloest und wuerde sich aendern → BLOCK (fail-fast).
  liveOrRedeemed(() => assertSupplierOverpayMutable(purchaseId, B(plan.newPaidF), B(plan.newTotalF)));

  const db = getDatabase();
  const now = ctx.now;
  db.run(
    `UPDATE purchases SET total_amount = ?, paid_amount = ?, remaining_amount = ?, status = ?, updated_at = ? WHERE id = ?`,
    [B(plan.newTotalF), B(plan.newPaidF), B(plan.newRemainingF), plan.status, now, purchaseId]
  );
  // LAN-Sync (Gruppe 1): der Return-Confirm reduziert den Parent-Purchase-Header.
  trackChange('purchases', purchaseId, 'update', {});

  // H-07 — Rueckgabe an den Lieferanten: die Ware verlaesst unseren Bestand. Pro Return-Line das
  // Lot der Purchase-Line (1 Lot/Line) um die zurueckgegebene Menge senken, dann products.quantity
  // aus den ACTIVE-Lots ableiten. Der Haus-Weg hat vorher geprueft, dass die Menge da ist; der
  // Store-Altaufruf behaelt das Kappen (gekappt auf qty_remaining, nie negativ).
  const affected = new Set<string>();
  for (const line of lines) {
    const plId = (line.purchase_line_id as string | null) || null;
    if (plId) {
      const lotRow = query(
        `SELECT id, qty_remaining FROM stock_lots
           WHERE purchase_line_id = ? AND status != 'CANCELLED' AND qty_remaining > 0
           ORDER BY acquired_at ASC, id ASC LIMIT 1`,
        [plId]
      )[0];
      if (lotRow) {
        const reduce = Math.min(Math.max(0, Number(line.quantity) || 0), Number(lotRow.qty_remaining) || 0);
        if (reduce > 0) consumeLot(lotRow.id as string, reduce);
      }
    }
    const pid = (line.product_id as string | null) || null;
    if (pid) affected.add(pid);
  }
  for (const pid of affected) {
    syncProductQuantity(pid);
    // Bestand 0 → das Produkt hat unseren verfuegbaren Bestand verlassen: 'returned' (NICHT 'sold').
    if (getAvailableStock(pid) === 0) {
      db.run(`UPDATE products SET stock_status = 'returned', updated_at = ? WHERE id = ?`, [now, pid]);
      trackProductRow(pid);   // LAN-Sync Phase 1b
    }
  }

  // Plan §Purchase Returns §9: COMPLETED, wenn kein Refund noetig oder direkt Cash/Bank/Benefit;
  // CONFIRMED, wenn als Lieferanten-Guthaben (wird spaeter verrechnet).
  const finalStatus: 'CONFIRMED' | 'COMPLETED' =
    (plan.refundF === 0 || (method && method !== 'credit')) ? 'COMPLETED' : 'CONFIRMED';
  db.run(`UPDATE purchase_returns SET status = ?, refund_amount = ? WHERE id = ?`, [finalStatus, B(plan.refundF), returnId]);
  if (plan.refundF > 0 && method && method !== 'credit') trackRefund('purchase_returns', returnId, B(plan.refundF), method);

  // Plan §8 #3 — Erstattung als Guthaben beim Lieferanten (gegen kuenftige Kaeufe verrechenbar).
  let supplierCreditId: string | null = null;
  if (plan.refundF > 0 && method === 'credit' && supplierId) {
    supplierCreditId = uuid();
    db.run(
      `INSERT INTO supplier_credits (id, branch_id, supplier_id, source_return_id, source_purchase_id,
         amount, used_amount, status, note, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 0, 'OPEN', ?, ?, ?)`,
      [supplierCreditId, ctx.branchId, supplierId, returnId, purchaseId, B(plan.refundF),
       `Credit aus Return ${returnNumber || returnId.slice(0, 8)}`, now, ctx.userId || null]
    );
    trackInsert('supplier_credits', supplierCreditId, { supplierId, amount: B(plan.refundF) });
  }

  // Protokoll ATOMAR in derselben Transaktion (vorher `trackStatusChange` — ein verschluckter Fehler).
  logAuditOrThrow({
    module: 'Purchase', entityType: 'purchase_returns', entityId: returnId, action: 'STATUS_CHANGE', field: 'status',
    oldValue: 'DRAFT',
    newValue: { status: finalStatus, purchaseId, returnNumber, totalAmount: B(totalRetF), refundAmount: B(plan.refundF), refundMethod: method },
    actor: { userId: ctx.userId || undefined, branchId: ctx.branchId },
  });
  trackChange('purchase_returns', returnId, 'update', {});

  // Ledger: INVENTORY runter (netto + VAT_INPUT proportional zur Original-Buchung je Line, F-PRC-03),
  // A/P runter (Anteil ohne Refund), Cash/Bank/Benefit/SUPPLIER_CREDIT rauf (Refund-Anteil).
  // Idempotent ueber sourceModule='PURCHASE_RETURN' + sourceId. STRIKT — kein `safePost` mehr.
  if (!hasLedgerEntries('PURCHASE_RETURN', returnId)) {
    const entries: Parameters<typeof postEntries>[0] = [];
    const total = B(totalRetF);
    let totalVat = 0;
    for (const line of lines) {
      const plId = (line.purchase_line_id as string | null) || null;
      if (!plId) continue;
      const { net, vat } = getPurchaseLineInputSplit(plId);
      const origGross = net + vat;
      if (vat > 0 && origGross > 0) {
        const lineReturn = Math.max(0, Number(line.quantity) || 0) * (Number(line.unit_price) || 0);
        totalVat += Math.round(vat * Math.min(1, lineReturn / origGross) * 1000) / 1000;
      }
    }
    totalVat = Math.min(totalVat, total);
    const totalNet = Math.round((total - totalVat) * 1000) / 1000;
    const apReduction = B(totalRetF - plan.refundF);
    const refund = B(plan.refundF);
    const meta = { purchaseId, returnNumber };
    if (totalNet > 0.0005) {
      entries.push({ account: 'INVENTORY', direction: 'CREDIT', amount: totalNet, counterpartyType: 'SUPPLIER', counterpartyId: supplierId, metadata: { ...meta, side: 'inventory-net' } });
    }
    if (totalVat > 0.0005) {
      entries.push({ account: 'VAT_INPUT', direction: 'CREDIT', amount: totalVat, counterpartyType: 'SUPPLIER', counterpartyId: supplierId, metadata: { ...meta, side: 'vat-input' } });
    }
    if (apReduction > 0.0005) {
      entries.push({ account: 'ACCOUNTS_PAYABLE', direction: 'DEBIT', amount: apReduction, counterpartyType: 'SUPPLIER', counterpartyId: supplierId, metadata: { ...meta, side: 'ap-reduction' } });
    }
    if (refund > 0.0005) {
      entries.push({ account: refundAccountFor(method), direction: 'DEBIT', amount: refund, counterpartyType: 'SUPPLIER', counterpartyId: supplierId, metadata: { ...meta, refundMethod: method, side: 'refund-in' } });
    }
    if (entries.length > 0) {
      postEntries(entries, { occurredAt: now, sourceModule: 'PURCHASE_RETURN', sourceId: returnId });
    }
  }

  // Slice 4b — der Return hat total/paid geaendert → Overpay-Gutschrift nachziehen (clawback-then-rebook).
  liveOrRedeemed(() => reconcilePurchaseOverpayCredit(purchaseId));

  return {
    returnId, status: finalStatus, refundAmount: B(plan.refundF), supplierCreditId,
    purchaseStatus: plan.status, remainingAmount: B(plan.newRemainingF),
  };
}

/** Was die Maske „Return to Supplier (PRET)" meint — die Auswahl des Menschen, nicht das Ergebnis. */
export interface PurchaseReturnRequest {
  purchaseId: string;
  refundMethod: RefundMethod;
  notes?: string;
  lines: Array<{ purchaseLineId: string; quantity: number; unitPrice: number }>;
}

export interface PurchaseReturned {
  returnId: string;
  returnNumber: string;
  purchaseId: string;
  status: 'CONFIRMED' | 'COMPLETED';
  totalAmount: number;
  refundAmount: number;
  refundMethod: RefundMethod;
  supplierCreditId: string | null;
  purchaseStatus: PurchaseStatus;
  remainingAmount: number;
  revision: number;
}

/**
 * „Confirm Return": EINE Handlung — Retoure anlegen UND ihre Wirkung, in der Transaktion des
 * Aufrufers. Alle Regeln stehen VOR dem ersten Schreiben (ein Nein verbrennt keine Belegnummer):
 *
 *   • der Einkauf in DIESER Filiale, gegen die gesehene Fassung;
 *   • nicht storniert und noch keine wirksame Retoure (die Maske bietet „Return to Supplier" nur dann);
 *   • ein Erstattungsweg der Maske; mindestens eine Zeile, jede eine Zeile DIESES Einkaufs, keine doppelt;
 *   • Menge > 0 und ≤ Menge der Einkaufszeile (die Maske: max = Zeilenmenge), Preis ≥ 0;
 *   • die Menge liegt noch im Los dieser Zeile — Verkauftes geht nicht an den Lieferanten zurück
 *     (derselbe Vertrag wie `consumeLot` / `assertLotsConsumable`; vorher still gekappt);
 *   • Summe > 0 (der Knopf ist sonst gesperrt) und ≤ Summe des Einkaufs (vorher still auf 0
 *     gekappt, während das Hauptbuch den vollen Betrag buchte);
 *   • die Overpay-Gutschrift bleibt veränderbar (Slice 4b).
 */
export function returnToSupplierInHouse(req: PurchaseReturnRequest, ctx: HouseCtx, expectedRevision?: number): PurchaseReturned {
  assertBooks();
  const p = livePurchase(req.purchaseId, ctx.branchId);
  assertSeen(req.purchaseId, expectedRevision);
  if (String(p.status) === 'CANCELLED') throw nein('PURCHASE_CANCELLED', 'A cancelled purchase cannot be returned to the supplier.');
  if (query(`SELECT id FROM purchase_returns WHERE purchase_id = ? AND status != 'CANCELLED' LIMIT 1`, [req.purchaseId])[0]) {
    throw nein('PURCHASE_RETURN_EXISTS', 'This purchase already has a supplier return.');
  }
  if (!isRefundMethod(req.refundMethod)) {
    throw nein('PURCHASE_RETURN_METHOD_INVALID', `unknown refund method: ${String(req.refundMethod)}`);
  }
  if (!Array.isArray(req.lines) || req.lines.length === 0) {
    throw nein('PURCHASE_RETURN_NO_LINES', 'Select at least one item to return.');
  }
  const seen = new Set<string>();
  let totalF = 0;
  for (const l of req.lines) {
    if (seen.has(l.purchaseLineId)) throw nein('PURCHASE_RETURN_LINE_DUPLICATE', 'the same purchase line twice is not a return');
    seen.add(l.purchaseLineId);
    const pl = query('SELECT id, quantity FROM purchase_lines WHERE id = ? AND purchase_id = ?', [l.purchaseLineId, req.purchaseId])[0];
    if (!pl) throw nein('PURCHASE_RETURN_LINE_UNKNOWN', 'an item to return is not a line of this purchase');
    const lineQty = Number(pl.quantity) || 0;
    if (typeof l.quantity !== 'number' || !Number.isFinite(l.quantity) || l.quantity <= 0 || l.quantity > lineQty) {
      throw nein('PURCHASE_RETURN_QTY_INVALID', `the quantity to return must be more than 0 and at most ${lineQty}`);
    }
    if (typeof l.unitPrice !== 'number' || !Number.isFinite(l.unitPrice) || l.unitPrice < 0) {
      throw nein('PURCHASE_RETURN_PRICE_INVALID', 'the unit price of a returned item must be a number of at least 0');
    }
    // Hat diese Zeile ein Los (Einkäufe seit Phase 2), muss die Menge darin noch liegen. Zeilen ohne
    // Los-Historie (Altbestand vor den Losen) behalten den bisherigen Weg.
    const hatLos = Number(query('SELECT COUNT(*) AS c FROM stock_lots WHERE purchase_line_id = ?', [l.purchaseLineId])[0]?.c ?? 0) > 0;
    if (hatLos) {
      const lot = query(
        `SELECT qty_remaining FROM stock_lots
           WHERE purchase_line_id = ? AND status != 'CANCELLED' AND qty_remaining > 0
           ORDER BY acquired_at ASC, id ASC LIMIT 1`,
        [l.purchaseLineId],
      )[0];
      const vorhanden = Number(lot?.qty_remaining ?? 0) || 0;
      if (l.quantity > vorhanden) {
        throw nein('PURCHASE_RETURN_STOCK_UNAVAILABLE',
          `only ${vorhanden} of this item ${vorhanden === 1 ? 'is' : 'are'} still in stock from this purchase — sold or used pieces cannot go back to the supplier`);
      }
    }
    totalF += F(l.quantity * l.unitPrice);
  }
  if (totalF <= 0) throw nein('PURCHASE_RETURN_TOTAL_INVALID', 'The return total must be more than 0.');
  if (totalF > F(p.total_amount)) {
    throw nein('PURCHASE_RETURN_EXCEEDS_PURCHASE',
      `the return (${B(totalF).toFixed(3)}) is more than this purchase is worth (${B(F(p.total_amount)).toFixed(3)})`);
  }
  // Overpay-Vorabprüfung VOR dem ersten Schreiben — mit derselben Rechnung, die die Wirkung benutzt.
  const plan = planReturn(p, totalF);
  liveOrRedeemed(() => assertSupplierOverpayMutable(req.purchaseId, B(plan.newPaidF), B(plan.newTotalF)));

  const notes = typeof req.notes === 'string' && req.notes.trim() ? req.notes.trim() : undefined;
  const draft = createPurchaseReturnDraftInHouse({
    purchaseId: req.purchaseId, refundMethod: req.refundMethod, notes,
    lines: req.lines.map((l) => ({ purchaseLineId: l.purchaseLineId, quantity: l.quantity, unitPrice: l.unitPrice })),
  }, ctx);
  const done = confirmPurchaseReturnInHouse(draft.returnId, ctx);
  return {
    returnId: draft.returnId,
    returnNumber: draft.returnNumber,
    purchaseId: req.purchaseId,
    status: done.status,
    totalAmount: B(totalF),
    refundAmount: done.refundAmount,
    refundMethod: req.refundMethod,
    supplierCreditId: done.supplierCreditId,
    purchaseStatus: done.purchaseStatus,
    remainingAmount: done.remainingAmount,
    revision: revisionOf(req.purchaseId),
  };
}

// ── Eine bestätigte Retoure zurückdrehen (Slice 4a) ─────────────────────────

/**
 * Spiegelt die Wirkung einer CONFIRMED/COMPLETED-Retoure vollständig zurück — aus `purchaseStore`
 * hierher gezogen, jetzt strikt (die Stornobuchung wurde dort verschluckt). Reihenfolge wie bisher:
 * verbrauchtes Retouren-Guthaben blockiert → Ledger → Lose → Artikelstatus → Einkaufssummen →
 * ungenutztes Guthaben der Retoure entfernen → Overpay nachziehen. Der Aufrufer setzt den Status
 * der Retoure. Der Rest ist guthabenbewusst (dieselbe Formel wie die Zahlungsfolge des Hauses).
 *
 * Die ungenutzte Guthabenzeile der Retoure wird — wie bisher — GELÖSCHT: das ist der bestehende
 * Vertrag (`supplier_credits` kennt keinen Storno-Status, die Leser zählen jede Zeile); die
 * finanzielle Wahrheit bleibt die stornierte PURCHASE_RETURN-Buchung.
 */
export function reverseConfirmedPurchaseReturnInHouse(returnId: string, now: string): void {
  const ret = query('SELECT * FROM purchase_returns WHERE id = ?', [returnId])[0];
  if (!ret) return;
  const purchaseId = String(ret.purchase_id ?? '');
  const p = query('SELECT * FROM purchases WHERE id = ?', [purchaseId])[0];
  const db = getDatabase();

  // 1. Verbrauchten Supplier-Credit blockieren — sonst inkonsistenter Lieferanten-Saldo.
  const creditRows = query(`SELECT id, used_amount FROM supplier_credits WHERE source_return_id = ?`, [returnId]);
  for (const c of creditRows) {
    if (Number(c.used_amount || 0) > 0.005) {
      throw nein('PURCHASE_RETURN_CREDIT_USED',
        'This supplier return cannot be reversed: the supplier credit from it has already been (partly) used. Reverse that credit usage first.');
    }
  }

  // 2. Ledger-Storno (INVENTORY/AP/Cash der PURCHASE_RETURN-Buchung). Guarded + idempotent, STRIKT.
  if (hasLedgerEntries('PURCHASE_RETURN', returnId) && !hasReversalFor('PURCHASE_RETURN', returnId)) {
    reverseSource('PURCHASE_RETURN', returnId, now);
  }

  // 3. Lots zurueck: je Line die beim Confirm konsumierte Menge wieder freigeben (restoreLot cappt).
  const affected = new Set<string>();
  for (const line of query('SELECT * FROM purchase_return_lines WHERE return_id = ?', [returnId])) {
    const plId = (line.purchase_line_id as string | null) || null;
    if (plId) {
      const lotRow = query(
        `SELECT id FROM stock_lots
           WHERE purchase_line_id = ? AND status != 'CANCELLED'
           ORDER BY acquired_at ASC, id ASC LIMIT 1`,
        [plId]
      )[0];
      if (lotRow) restoreLot(lotRow.id as string, Math.max(0, Number(line.quantity) || 0));
    }
    const pid = (line.product_id as string | null) || null;
    if (pid) affected.add(pid);
  }

  // 4. Produkt-Status: Bestand wieder da → zurueck auf 'in_stock' (Confirm hatte bei 0 'returned' gesetzt).
  for (const pid of affected) {
    syncProductQuantity(pid);
    if (getAvailableStock(pid) > 0) {
      db.run(`UPDATE products SET stock_status = 'in_stock', updated_at = ? WHERE id = ?`, [now, pid]);
      trackProductRow(pid);   // LAN-Sync Phase 1b
    }
  }

  // 5. Einkaufssummen wiederherstellen (Spiegel zum Confirm: total += ret.total, paid += refund).
  if (p) {
    const restoredTotalF = F(p.total_amount) + F(ret.total_amount);
    const restoredPaidF = F(p.paid_amount) + F(ret.refund_amount);
    // Slice 4b — Pre-Check VOR dem Restore: BLOCK falls die Overpay-Gutschrift schon eingeloest ist.
    liveOrRedeemed(() => assertSupplierOverpayMutable(purchaseId, B(restoredPaidF), B(restoredTotalF)));
    const settledF = restoredPaidF + creditPaidF(purchaseId);
    const restoredRemainingF = Math.max(0, restoredTotalF - settledF);
    const restoredStatus: PurchaseStatus = String(p.status) === 'CANCELLED' ? 'CANCELLED' : statusOf(restoredTotalF, settledF);
    db.run(
      `UPDATE purchases SET total_amount = ?, paid_amount = ?, remaining_amount = ?, status = ?, updated_at = ? WHERE id = ?`,
      [B(restoredTotalF), B(restoredPaidF), B(restoredRemainingF), restoredStatus, now, purchaseId]
    );
    trackChange('purchases', purchaseId, 'update', {});
  }

  // 6. Ungenutzten Supplier-Credit dieser Return entfernen (source_return_id-gekeyt → die
  //    Overpay-Row mit source_return_id IS NULL bleibt unberuehrt).
  for (const c of creditRows) {
    db.run(`DELETE FROM supplier_credits WHERE id = ?`, [c.id as string]);
    trackDelete('supplier_credits', c.id as string);
  }

  // Slice 4b — Summen restauriert → Overpay-Gutschrift nachziehen (nach der Return-Credit-Entfernung).
  if (p) liveOrRedeemed(() => reconcilePurchaseOverpayCredit(purchaseId));
}

// ════════════════════════════════════════════════════════════════════════════
// „Cancel Purchase"
// ════════════════════════════════════════════════════════════════════════════

export interface PurchaseCancelOptions {
  /** Fern Pflicht: die gesehene Fassung des Einkaufs, INNERHALB der Transaktion verglichen. */
  expectedRevision?: number;
  /**
   * Die Regel der Maske: „Cancel" gibt es nur, solange der Einkauf nicht voll bezahlt ist
   * (`canCancel`). Der Store-Altaufruf (Kommission: Auto-Einkauf zurücknehmen) setzt sie nicht —
   * dort bleibt das bisherige Verhalten.
   */
  blockPaid?: boolean;
  now?: string;
}

export interface PurchaseCancelled {
  purchaseId: string;
  purchaseNumber: string;
  previousStatus: string;
  status: 'CANCELLED';
  revision: number;
  cancelledLots: number;
  reversedPayments: number;
  restoredSupplierCredits: number;
  revertedOrderLines: number;
  /** Nummern der Retouren, die mit dem Einkauf zurückgenommen wurden (sie bleiben als CANCELLED stehen). */
  cancelledReturns: string[];
}

/**
 * „Cancel Purchase" = vollständiger Rückbau (full-unwind, User-Entscheid 2026-06-11), jetzt als EINE
 * Hausfolge. Der Einkauf bleibt als CANCELLED stehen (Beleg, Zeilen, Zahlungen — Historie); nichts
 * wird gelöscht außer den Guthabenzeilen, deren Löschung schon der bestehende Vertrag ist
 * (Overpay-Teardown, ungenutztes Retouren-Guthaben — jeweils mit Stornobuchung).
 *
 *   1. Sperren VOR jedem Schreiben: eingelöste Overpay-Gutschrift, verbrauchtes Retouren-Guthaben.
 *   2. R6F — wirksame Retouren werden mit zurückgenommen (Slice-4a-Umkehr, Status CANCELLED): vorher
 *      blieb ihre Buchung stehen und das Lager stand nach dem Storno im Hauptbuch negativ.
 *   3. Overpay-Teardown, Einkauf CANCELLED, Lose soft-cancel, Menge/Status der Artikel.
 *   4. Back-to-Back: verknüpfte ARRIVED-Auftragszeilen zurück auf PENDING, Auftragsstatus neu.
 *   5. Hauptbuch STRIKT: jede Zahlung reversiert, dann das PURCHASE-Bein; eingelöstes Guthaben zurück.
 *   6. Protokoll atomar.
 *
 * Synchron und ohne eigene Klammer — auch der Kommissions-Storno (Auto-Einkauf) kann sie in SEINER
 * Transaktion rufen.
 */
export function cancelPurchaseInHouse(purchaseId: string, branchId: string, opts: PurchaseCancelOptions = {}): PurchaseCancelled {
  assertBooks();
  const p = livePurchase(purchaseId, branchId);
  assertSeen(purchaseId, opts.expectedRevision);
  const previousStatus = String(p.status ?? '');
  if (previousStatus === 'CANCELLED') throw nein('PURCHASE_ALREADY_CANCELLED', 'This purchase is already cancelled.');
  if (opts.blockPaid && previousStatus === 'PAID') {
    throw nein('PURCHASE_PAID_NOT_CANCELLABLE', 'A fully paid purchase cannot be cancelled.');
  }
  // Sperre 1 — die Overpay-Gutschrift ist schon eingeloest (Entscheidung 6: kein Auto-Reversal).
  const overpay = query(
    `SELECT used_amount FROM supplier_credits WHERE source_purchase_id = ? AND source_return_id IS NULL`, [purchaseId],
  )[0];
  if (overpay && Number(overpay.used_amount || 0) > 0.005) throw nein('PURCHASE_OVERPAY_CREDIT_REDEEMED', OVERPAY_REDEEMED_MSG);
  // Sperre 2 — das Guthaben einer wirksamen Retoure floss schon in einen anderen Einkauf.
  const retouren = query(
    `SELECT id, status, return_number FROM purchase_returns WHERE purchase_id = ? AND status != 'CANCELLED' ORDER BY created_at ASC, id ASC`,
    [purchaseId],
  );
  for (const r of retouren) {
    const st = String(r.status);
    if (st !== 'CONFIRMED' && st !== 'COMPLETED') continue;
    const used = query(`SELECT 1 FROM supplier_credits WHERE source_return_id = ? AND used_amount > 0.005 LIMIT 1`, [String(r.id)])[0];
    if (used) {
      throw nein('PURCHASE_RETURN_CREDIT_USED',
        'Cannot cancel this purchase: the supplier credit from its return has already been (partly) used. Reverse that credit usage first.');
    }
  }

  const db = getDatabase();
  const now = opts.now ?? new Date().toISOString();

  // 2. Wirksame Retouren mit zurücknehmen — Zeile und Positionen bleiben (CANCELLED, Historie).
  const cancelledReturns: string[] = [];
  for (const r of retouren) {
    const rid = String(r.id);
    const st = String(r.status);
    if (st === 'CONFIRMED' || st === 'COMPLETED') reverseConfirmedPurchaseReturnInHouse(rid, now);
    db.run(`UPDATE purchase_returns SET status = 'CANCELLED' WHERE id = ?`, [rid]);
    logAuditOrThrow({
      module: 'Purchase', entityType: 'purchase_returns', entityId: rid, action: 'STATUS_CHANGE', field: 'status',
      oldValue: st, newValue: { status: 'CANCELLED', reason: 'purchase cancelled', purchaseId },
      actor: { branchId },
    });
    trackChange('purchase_returns', rid, 'update', {});
    cancelledReturns.push(String(r.return_number ?? rid));
  }

  // 3a. Slice 4b — die Ueberzahlungs-Gutschrift abbauen (Reklass-Bein reversen + Domain-Row weg).
  liveOrRedeemed(() => teardownSupplierOverpayCredit(purchaseId, OVERPAY_REDEEMED_MSG));

  // 3b. Header CANCELLED, Lose soft-cancel (Audit-Trail bleibt; bereits verkaufte Pieces bleiben
  //     ueber invoice_lines.lot_id verknuepft), products.quantity aus den verbleibenden ACTIVE-Lots.
  const affectedProductIds = query(`SELECT DISTINCT product_id FROM stock_lots WHERE purchase_id = ?`, [purchaseId])
    .map(r => r.product_id as string);
  db.run(`UPDATE purchases SET status = 'CANCELLED', updated_at = ? WHERE id = ?`, [now, purchaseId]);
  const cancelledLotIds = query(`SELECT id FROM stock_lots WHERE purchase_id = ? AND status != 'CANCELLED'`, [purchaseId])
    .map(r => r.id as string);
  db.run(`UPDATE stock_lots SET status = 'CANCELLED' WHERE purchase_id = ?`, [purchaseId]);
  for (const lid of cancelledLotIds) trackLotRow(lid, 'update');
  for (const pid of affectedProductIds) {
    syncProductQuantity(pid);
    // F-PRC-01 — sonst bliebe stock_status='in_stock' bei 0 Lots stehen (Phantom). Nur in_stock
    // anfassen, damit sold/consumed/returned nicht ueberschrieben werden.
    if (getAvailableStock(pid) === 0) {
      db.run(`UPDATE products SET stock_status = 'returned', updated_at = ? WHERE id = ? AND stock_status = 'in_stock'`, [now, pid]);
      trackProductRow(pid);   // LAN-Sync Phase 1b
    }
  }

  // 4. Back-to-Back: verknuepfte ARRIVED-Order-Zeilen zurueck auf PENDING.
  const revertedOrderLines = p.source_order_id ? revertLinkedOrderLines(db, purchaseId) : 0;

  // 5. Ledger — erst JEDE geleistete Zahlung reversen (DR Kasse/Bank/Benefit/Guthaben zurueck / CR AP),
  //    dann das PURCHASE-Bein (spiegelt INVENTORY/VAT_INPUT/AP). F6: die JETZT frisch reversierten
  //    Guthaben-Einloesungen VOR den Reverses erfassen, danach ihr used_amount restaurieren.
  const creditPaysToRestore = query(
    `SELECT id, reference, amount FROM purchase_payments WHERE purchase_id = ? AND method = 'credit' AND reference IS NOT NULL`,
    [purchaseId]
  ).filter(pp => hasLedgerEntries('PURCHASE_PAYMENT', pp.id as string) && !hasReversalFor('PURCHASE_PAYMENT', pp.id as string));
  let reversedPayments = 0;
  for (const pp of query('SELECT id FROM purchase_payments WHERE purchase_id = ? ORDER BY created_at ASC, id ASC', [purchaseId])) {
    const payId = pp.id as string;
    if (!hasLedgerEntries('PURCHASE_PAYMENT', payId) || hasReversalFor('PURCHASE_PAYMENT', payId)) continue;
    reverseSource('PURCHASE_PAYMENT', payId, now);
    reversedPayments++;
  }
  if (hasLedgerEntries('PURCHASE', purchaseId) && !hasReversalFor('PURCHASE', purchaseId)) {
    postPurchaseCancelled({ id: purchaseId } as Purchase);
  }
  for (const cp of creditPaysToRestore) {
    restoreSupplierCreditUsage(cp.reference as string, Number(cp.amount) || 0);
  }

  // 6. Protokoll ATOMAR (vorher `trackStatusChange` — verschluckt) + EIN Full-Row-Snapshot für B.
  logAuditOrThrow({
    module: 'Purchase', entityType: 'purchases', entityId: purchaseId, action: 'STATUS_CHANGE', field: 'status',
    oldValue: previousStatus, newValue: 'CANCELLED', actor: { branchId },
  });
  trackChange('purchases', purchaseId, 'update', {});

  return {
    purchaseId,
    purchaseNumber: String(p.purchase_number ?? ''),
    previousStatus,
    status: 'CANCELLED',
    revision: revisionOf(purchaseId),
    cancelledLots: cancelledLotIds.length,
    reversedPayments,
    restoredSupplierCredits: creditPaysToRestore.length,
    revertedOrderLines,
    cancelledReturns,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// „Inbox-Foto verwerfen"
// ════════════════════════════════════════════════════════════════════════════

export interface PurchaseInboxDismissed { inboxId: string; status: 'dismissed' }

/**
 * Das Foto der Wareneingangs-Inbox verwerfen. Der auditierte Vertrag: die /mobile-Seite legt das
 * Foto als verkleinertes JPEG (data-URL) DIREKT in `purchase_inbox.images` — keine Datei im
 * Media-Root, kein `media_links`-Eintrag, kein GC-Verbraucher. „Verwerfen" ist deshalb, wie
 * bisher, der Übergang pending → dismissed: jeder Leser (`loadPurchaseInboxFor`) zeigt nur
 * `pending`, das Foto ist damit freigegeben. Gelöscht wird nichts — die Zeile hat im Abgleich gar
 * keinen Löschweg (`purchase_inbox`: insert/update).
 *
 * Neu: nur ein OFFENES Foto wird verworfen — vorher kippte der blinde Update auch ein Foto, aus
 * dem schon ein Einkauf entstand (`done`), zurück auf „verworfen". Die Zeile hat keine Fassung;
 * der einseitige Übergang aus `pending`, geprüft in der Transaktion, ist ihr Wächter.
 */
export function dismissPurchaseInboxInHouse(inboxId: string, branchId: string): PurchaseInboxDismissed {
  assertBooks();
  const r = query('SELECT id, status FROM purchase_inbox WHERE id = ? AND branch_id = ?', [inboxId, branchId])[0];
  if (!r) throw nein('INBOX_NOT_FOUND', 'no such inbox photo in this branch');
  const status = String(r.status ?? '');
  if (status !== 'pending') {
    throw nein('INBOX_NOT_PENDING', status === 'done'
      ? 'A purchase was already created from this photo.'
      : 'This photo was already dismissed.');
  }
  getDatabase().run(`UPDATE purchase_inbox SET status = 'dismissed' WHERE id = ?`, [inboxId]);
  logAuditOrThrow({
    module: 'Purchase', entityType: 'purchase_inbox', entityId: inboxId, action: 'STATUS_CHANGE', field: 'status',
    oldValue: 'pending', newValue: 'dismissed', actor: { branchId },
  });
  trackChange('purchase_inbox', inboxId, 'update', { status: 'dismissed' });
  return { inboxId, status: 'dismissed' };
}
