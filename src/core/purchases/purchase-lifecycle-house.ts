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
import { currentUserId } from '@/core/db/helpers';
// BULK METAL V1 — Bulk-Lots: Storno nur unbenutzt, keine Lieferantenrückgabe; der Systemartikel bleibt in_stock.
import { assertBulkLotsOfPurchaseUnused, cancelBulkLotsOfPurchase } from '@/core/bulk/bulk-lot-house';
import { isBulkMetalProduct } from '@/core/bulk/bulk-product';
const bulkActor = (): string => { try { return currentUserId(); } catch { return ''; } };
import { applyInboxGallery } from '@/core/purchases/inbox-media';
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
// PARTNER-ITEMS — die Rückgabe gemeinsam gekaufter Ware: der Partneranteil in derselben Transaktion.
import { reverseSupplierReturnForPartners, settleSupplierReturnForPartners } from '@/core/partners/item-participation-house';
import { PartnerItemRejected } from '@/core/partners/item-participation';

/** Ein Nein der Partnerabrechnung als Nein der Rückgabe (derselbe Code, dieselbe Meldung). */
function partnerUrteil<T>(fn: () => T): T {
  try { return fn(); } catch (e) {
    if (e instanceof PartnerItemRejected) throw new PurchaseLifecycleRejected(e.code, e.message);
    throw e;
  }
}
import { logAuditOrThrow } from '@/core/audit/audit-log';
import { PURCHASE_HAS_OFFSET, purchaseHasActiveOffsets, purchaseHasOffsetMessage } from './purchase-settled';
import type { HouseCtx } from '@/core/payables/payables-house';
import { purchaseCancelBlocker } from '@/core/purchases/purchase-consumption';
import { herkunftUnklar, statusOhneBestand } from '@/core/purchases/purchase-undo';
import { correctionDateIssue } from '@/core/ledger/correction-dates';
import { purchaseLotUnitCost } from '@/core/lots/lot-cost';

/** Die drei Buchungen dieses Bereichs — Maske (useSharedWrite) und Fernbefehl benutzen DIESE Namen. */
export const PURCHASE_LIFECYCLE_OP = {
  RETURN_TO_SUPPLIER: 'purchases.return_to_supplier',
  CANCEL: 'purchases.cancel',
  DISMISS_INBOX: 'purchases.dismiss_inbox',
  /** v0.8.101 (Owner 11.11.2026) — EINE gebuchte Lieferantenrückgabe zurücknehmen; der Einkauf bleibt. Nur Owner. */
  CANCEL_RETURN: 'purchases.cancel_return',
  /**
   * MEDIA-INBOX — das Telefon legt einen Posteingangs-Eintrag an.
   *
   * Vorher tat es das über den allgemeinen Abgleich-Push: eine Tabellenzeile mit einer Daten-URL
   * darin, an jeder Geschäftsregel vorbei. Ein Foto, das ein Mensch aufnimmt, ist eine HANDLUNG
   * des Hauses — sie bekommt einen Namen, einen geprüften Absender und eine Auftragskennung.
   */
  CREATE_INBOX: 'purchase_inbox.create',
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
  F(query(`SELECT COALESCE(SUM(amount), 0) AS t FROM purchase_payments WHERE purchase_id = ? AND method IN ('credit', 'offset') AND voided_at IS NULL`, [purchaseId])[0]?.t);

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
    // B2/B3 SICHERHEIT B — vorher still BANK (auch ohne gewählten Weg): eine Erstattung ohne bekannten Weg bucht nichts.
    default: throw nein('PURCHASE_RETURN_METHOD_INVALID', `the supplier refund needs a refund method (cash, bank, benefit or credit) — got ${String(method ?? 'none')}; nothing was changed`);
  }
}

/** Die Anlage einer Retoure (Status DRAFT, noch ohne Wirkung) — auch der Weg des Store-Altaufrufs `createReturn`. */
export interface PurchaseReturnDraftInput {
  purchaseId: string;
  returnDate?: string;
  refundMethod?: RefundMethod;
  notes?: string;
  lines: Array<{ purchaseLineId: string; productId?: string; quantity: number; unitPrice: number; addedCostRefund?: number }>;
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
    if (isBulkMetalProduct(pl?.product_id as string | undefined)) {
      throw nein('BULK_NOT_SUPPORTED_HERE', 'bulk metal cannot be returned to the supplier in this version — write it off or cancel the unused purchase');
    }
    return {
      id: uuid(),
      purchaseLineId: l.purchaseLineId,
      productId: (pl?.product_id as string | null) || l.productId || null,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      lineTotalF: F(l.quantity * l.unitPrice),
      addedF: F(l.addedCostRefund ?? 0),
      // v0.8.101 — der Einstand je Stück, mit dem die Stücke gehen (die Bestätigung schreibt ihn noch einmal fest).
      unitCost: query(`SELECT unit_cost FROM stock_lots WHERE purchase_line_id = ? AND status != 'CANCELLED' AND qty_remaining > 0
                        ORDER BY acquired_at ASC, id ASC LIMIT 1`, [l.purchaseLineId])[0]?.unit_cost as number | undefined,
    };
  });
  const totalF = lines.reduce((s, l) => s + l.lineTotalF, 0);
  const addedTotalF = lines.reduce((s, l) => s + l.addedF, 0);
  db.run(
    `INSERT INTO purchase_returns (id, branch_id, return_number, purchase_id, supplier_id, status, total_amount,
      return_date, refund_method, refund_amount, notes, created_at, created_by, added_cost_refund)
     VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, 0, ?, ?, ?, ?)`,
    [id, ctx.branchId, returnNumber, input.purchaseId, String(p.supplier_id ?? ''), B(totalF), returnDate,
     input.refundMethod || null, input.notes || null, ctx.now, ctx.userId || null, B(addedTotalF)]
  );
  for (const l of lines) {
    db.run(
      `INSERT INTO purchase_return_lines (id, return_id, purchase_line_id, product_id, quantity, unit_price, line_total, added_cost_refund, unit_cost_at_return)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [l.id, id, l.purchaseLineId, l.productId, l.quantity, l.unitPrice, B(l.lineTotalF), B(l.addedF),
       l.unitCost === undefined || l.unitCost === null ? null : Number(l.unitCost)]
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
/** v0.8.101 — Rückgabe mit Zusatzkosten: nicht unterstützte Fälle (kein Los mit Buchwert, zu hohe Erstattung, Gewinn, Preis über Einkauf). */
export const PURCHASE_RETURN_HAS_ADDED_COSTS = 'PURCHASE_RETURN_HAS_ADDED_COSTS';
export const PURCHASE_RETURN_ADDED_REFUND_TOO_HIGH = 'PURCHASE_RETURN_ADDED_REFUND_TOO_HIGH';
export const PURCHASE_RETURN_GAIN_UNSUPPORTED = 'PURCHASE_RETURN_GAIN_UNSUPPORTED';
export const PURCHASE_RETURN_PRICE_ABOVE_PURCHASE = 'PURCHASE_RETURN_PRICE_ABOVE_PURCHASE';
/** Rundungsrest einer Rückgabe in Fils (0,005 BHD): darunter weder Verlust noch Gewinn. */
const RUNDUNG_F = 5;

export function confirmPurchaseReturnInHouse(returnId: string, ctx: HouseCtx): PurchaseReturnConfirmed {
  assertBooks();
  const ret = query('SELECT * FROM purchase_returns WHERE id = ? AND branch_id = ?', [returnId, ctx.branchId])[0];
  if (!ret) throw nein('PURCHASE_RETURN_NOT_FOUND', 'no such supplier return in this branch');
  if (String(ret.status) !== 'DRAFT') throw nein('PURCHASE_RETURN_NOT_DRAFT', 'this supplier return is already confirmed');
  const purchaseId = String(ret.purchase_id ?? '');
  const p = livePurchase(purchaseId, ctx.branchId);
  if (purchaseHasActiveOffsets(purchaseId)) throw nein(PURCHASE_HAS_OFFSET, purchaseHasOffsetMessage('A supplier return'));
  const supplierId = String(p.supplier_id ?? '');
  const returnNumber = String(ret.return_number ?? '');
  const method = (ret.refund_method as string | null) || null;
  const lines = query('SELECT * FROM purchase_return_lines WHERE return_id = ?', [returnId]);
  // v0.8.101 (Owner 11.11.2026) — Rückgabe auch mit aktivierten Zusatzkosten (Reparatur, Polieren, Werkstattgold …). Je Zeile:
  //   Buchwert der zurückgegebenen Stücke  = Menge × Einstand des Loses (was INVENTORY für sie trägt)
  //   Rücknahmepreis netto                 = Zeilenwert − anteilige Vorsteuer (dieselbe Rechnung wie die Rückgabebuchung)
  //   Erstattung der Zusatzkosten          = getrennt erfasst, höchstens die aktivierten Zusatzkosten der Stücke
  //   Verlust                              = Buchwert − Rücknahmepreis netto − Erstattung der Zusatzkosten (≥ 0)
  // Gebucht (unten, unter der Rückgabe): Soll Erstattungskonto / Haben INVENTORY (Zusatzkosten), Soll INVENTORY_LOSS / Haben
  // INVENTORY (Verlust) — danach steht kein Lagerwert der Stücke mehr. Ein GEWINN (Erstattung über dem Buchwert) hat kein
  // festgelegtes Konto: abgewiesen, nichts geschrieben.
  const bewertung = new Map<string, { carryingF: number; netF: number; addedF: number; addedCostsF: number; lossF: number; unitCost: number }>();
  let addedRefundF = 0;
  let lossF = 0;
  for (const line of lines) {
    const plId = (line.purchase_line_id as string | null) || null;
    if (!plId) continue;
    const lot = query(`SELECT unit_cost FROM stock_lots WHERE purchase_line_id = ? AND status != 'CANCELLED' AND qty_remaining > 0
                        ORDER BY acquired_at ASC, id ASC LIMIT 1`, [plId])[0];
    const pl = query('SELECT quantity, unit_price, line_total, vat_amount FROM purchase_lines WHERE id = ?', [plId])[0];
    const q = Math.max(0, Number(line.quantity) || 0);
    const lineAddedF = F(line.added_cost_refund ?? 0);
    if (!lot || !pl || q <= 0) {
      if (lineAddedF > 0) throw nein(PURCHASE_RETURN_HAS_ADDED_COSTS, 'this line has no stock lot with a known book value — an added-cost refund cannot be booked; nothing was returned');
      continue;
    }
    const plQty = Math.max(1, Number(pl.quantity) || 1);
    const split = getPurchaseLineInputSplit(plId);
    const origNetF = split.net > 0 ? Math.round(split.net * 1000) : Math.round((Number(pl.line_total) - Number(pl.vat_amount || 0)) * 1000);
    const carryingF = Math.round(q * (Number(lot.unit_cost) || 0) * 1000);
    const addedCostsF = Math.max(0, carryingF - Math.round(origNetF * q / plQty));
    const grossF = F(q * (Number(line.unit_price) || 0));
    const origGross = split.net + split.vat;
    const vatF = split.vat > 0 && origGross > 0 ? F(Math.round(split.vat * Math.min(1, B(grossF) / origGross) * 1000) / 1000) : 0;
    const netF = grossF - vatF;
    if (lineAddedF > addedCostsF) {
      throw nein(PURCHASE_RETURN_ADDED_REFUND_TOO_HIGH,
        `the supplier refunds ${B(lineAddedF).toFixed(3)} for added costs, but the returned pieces carry only ${B(addedCostsF).toFixed(3)} of added costs — nothing was returned`);
    }
    const residualF = carryingF - netF - lineAddedF;
    if (residualF < -RUNDUNG_F) {
      throw nein(PURCHASE_RETURN_GAIN_UNSUPPORTED,
        `the supplier refunds ${B(-residualF).toFixed(3)} more than the book value of the returned pieces (${B(carryingF).toFixed(3)}) — a gain on a supplier return has no agreed account yet; nothing was returned`);
    }
    // Ein Rest bis RUNDUNG_F stammt aus der Rundung (Vorsteuer-Anteil auf 3 Stellen, Einstand ungerundet) — kein Verlust,
    // keine 0,001-Buchung (so stand es auch vor v0.8.101).
    const lineLossF = residualF > RUNDUNG_F ? residualF : 0;
    bewertung.set(String(line.id), { carryingF, netF, addedF: lineAddedF, addedCostsF, lossF: lineLossF, unitCost: Number(lot.unit_cost) || 0 });
    addedRefundF += lineAddedF;
    lossF += lineLossF;
  }
  if (addedRefundF > 0 && (!method || !['cash', 'bank', 'benefit', 'credit'].includes(method))) {
    throw nein('PURCHASE_RETURN_METHOD_INVALID', 'the supplier refunds added costs — choose how the money comes back (cash, bank, benefit or credit); nothing was changed');
  }
  const totalRetF = F(ret.total_amount);
  const plan = planReturn(p, totalRetF);
  // Slice 4b — Pre-Check VOR dem Total-UPDATE: der Return aendert total/paid → den Ueberschuss.
  // Ist die Overpay-Gutschrift schon eingeloest und wuerde sich aendern → BLOCK (fail-fast).
  liveOrRedeemed(() => assertSupplierOverpayMutable(purchaseId, B(plan.newPaidF), B(plan.newTotalF)));

  // PARTNER-ITEMS — VOR dem Lagerabgang (der Einstand der Stücke gilt noch): je gemeinsam gekaufter
  // Zeile der Partneranteil an (Erstattungswert − Einstand). Scheitert das, gibt es die Rückgabe nicht.
  partnerUrteil(() => settleSupplierReturnForPartners(returnId, returnNumber, lines.map((l) => ({
    purchaseLineId: (l.purchase_line_id as string | null) || null,
    quantity: Number(l.quantity) || 0,
    unitPrice: Number(l.unit_price) || 0,
    addedCostRefund: Number(l.added_cost_refund) || 0,
  })), ctx));

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
  db.run(`UPDATE purchase_returns SET status = ?, refund_amount = ?, added_cost_refund = ? WHERE id = ?`, [finalStatus, B(plan.refundF), B(addedRefundF), returnId]);
  // v0.8.101 — der Einstand je zurückgegebenem Stück: ein späterer Storno bringt die Stücke genau zu diesem Wert zurück.
  for (const [lineId, v] of bewertung) db.run('UPDATE purchase_return_lines SET unit_cost_at_return = ? WHERE id = ?', [v.unitCost, lineId]);
  if (plan.refundF > 0 && method && method !== 'credit') trackRefund('purchase_returns', returnId, B(plan.refundF), method);

  // Plan §8 #3 — Erstattung als Guthaben beim Lieferanten (gegen kuenftige Kaeufe verrechenbar).
  let supplierCreditId: string | null = null;
  if ((plan.refundF > 0 || addedRefundF > 0) && method === 'credit' && supplierId) {
    supplierCreditId = uuid();
    db.run(
      `INSERT INTO supplier_credits (id, branch_id, supplier_id, source_return_id, source_purchase_id,
         amount, used_amount, status, note, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 0, 'OPEN', ?, ?, ?)`,
      [supplierCreditId, ctx.branchId, supplierId, returnId, purchaseId, B(plan.refundF + addedRefundF),
       `Credit aus Return ${returnNumber || returnId.slice(0, 8)}`, now, ctx.userId || null]
    );
    trackInsert('supplier_credits', supplierCreditId, { supplierId, amount: B(plan.refundF + addedRefundF) });
  }

  // Protokoll ATOMAR in derselben Transaktion (vorher `trackStatusChange` — ein verschluckter Fehler).
  logAuditOrThrow({
    module: 'Purchase', entityType: 'purchase_returns', entityId: returnId, action: 'STATUS_CHANGE', field: 'status',
    oldValue: 'DRAFT',
    newValue: { status: finalStatus, purchaseId, returnNumber, totalAmount: B(totalRetF), refundAmount: B(plan.refundF), refundMethod: method,
      addedCostRefund: B(addedRefundF), returnLoss: B(lossF),
      bookValue: [...bewertung.entries()].map(([lineId, v]) => ({ lineId, bookValue: B(v.carryingF), returnNet: B(v.netF), addedCosts: B(v.addedCostsF), addedRefund: B(v.addedF), loss: B(v.lossF) })) },
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
    // v0.8.101 — getrennt erstattete Zusatzkosten: Geld/Guthaben vom Lieferanten gegen den aktivierten Teil des Lagerwerts.
    if (addedRefundF > 0) {
      entries.push({ account: refundAccountFor(method), direction: 'DEBIT', amount: B(addedRefundF), counterpartyType: 'SUPPLIER', counterpartyId: supplierId, metadata: { ...meta, refundMethod: method, side: 'added-cost-refund' } });
      entries.push({ account: 'INVENTORY', direction: 'CREDIT', amount: B(addedRefundF), counterpartyType: 'SUPPLIER', counterpartyId: supplierId, metadata: { ...meta, side: 'added-cost-refund' } });
    }
    // v0.8.101 — was vom Buchwert nicht erstattet wird, ist ein Bestandsverlust (wie jede Abschreibung: INVENTORY_LOSS) — nie Lagerrest.
    if (lossF > 0) {
      entries.push({ account: 'INVENTORY_LOSS', direction: 'DEBIT', amount: B(lossF), counterpartyType: 'SUPPLIER', counterpartyId: supplierId, metadata: { ...meta, side: 'return-loss' } });
      entries.push({ account: 'INVENTORY', direction: 'CREDIT', amount: B(lossF), counterpartyType: 'SUPPLIER', counterpartyId: supplierId, metadata: { ...meta, side: 'return-loss' } });
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
  lines: Array<{ purchaseLineId: string; quantity: number; unitPrice: number; addedCostRefund?: number }>;
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
  if (purchaseHasActiveOffsets(req.purchaseId)) throw nein(PURCHASE_HAS_OFFSET, purchaseHasOffsetMessage('A supplier return'));
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
  let preisZuHoch: Error | null = null;
  for (const l of req.lines) {
    if (seen.has(l.purchaseLineId)) throw nein('PURCHASE_RETURN_LINE_DUPLICATE', 'the same purchase line twice is not a return');
    seen.add(l.purchaseLineId);
    const pl = query('SELECT id, quantity, product_id FROM purchase_lines WHERE id = ? AND purchase_id = ?', [l.purchaseLineId, req.purchaseId])[0];
    if (!pl) throw nein('PURCHASE_RETURN_LINE_UNKNOWN', 'an item to return is not a line of this purchase');
    if (isBulkMetalProduct(pl.product_id as string)) {
      throw nein('BULK_NOT_SUPPORTED_HERE', 'bulk metal cannot be returned to the supplier in this version — write it off or cancel the unused purchase');
    }
    const lineQty = Number(pl.quantity) || 0;
    if (typeof l.quantity !== 'number' || !Number.isFinite(l.quantity) || l.quantity <= 0 || l.quantity > lineQty) {
      throw nein('PURCHASE_RETURN_QTY_INVALID', `the quantity to return must be more than 0 and at most ${lineQty}`);
    }
    if (typeof l.unitPrice !== 'number' || !Number.isFinite(l.unitPrice) || l.unitPrice < 0) {
      throw nein('PURCHASE_RETURN_PRICE_INVALID', 'the unit price of a returned item must be a number of at least 0');
    }
    // v0.8.101 — der Rücknahmepreis mindert den Einkauf und ist höchstens der Einkaufspreis; was der Lieferant für Zusatzkosten
    // (Reparatur …) darüber hinaus erstattet, steht getrennt („added costs refunded") — nie im Rücknahmepreis versteckt.
    const plPrice = Number(query('SELECT unit_price FROM purchase_lines WHERE id = ?', [l.purchaseLineId])[0]?.unit_price ?? 0) || 0;
    if (F(l.unitPrice) > F(plPrice) && !preisZuHoch) {
      preisZuHoch = nein(PURCHASE_RETURN_PRICE_ABOVE_PURCHASE,
        `the return price per piece (${l.unitPrice.toFixed(3)}) is above the purchase price (${plPrice.toFixed(3)}) — enter what the supplier pays for added costs (repair …) under "added costs refunded"`);
    }
    if (l.addedCostRefund !== undefined && (typeof l.addedCostRefund !== 'number' || !Number.isFinite(l.addedCostRefund) || l.addedCostRefund < 0)) {
      throw nein('PURCHASE_RETURN_PRICE_INVALID', 'the refund of added costs must be a number of at least 0');
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
      `the return (${B(totalF).toFixed(3)}) is more than this purchase is worth (${B(F(p.total_amount)).toFixed(3)})`
      + (preisZuHoch ? ' — what the supplier pays for added costs (repair …) goes under "added costs refunded"' : ''));
  }
  if (preisZuHoch) throw preisZuHoch;
  // Overpay-Vorabprüfung VOR dem ersten Schreiben — mit derselben Rechnung, die die Wirkung benutzt.
  const plan = planReturn(p, totalF);
  liveOrRedeemed(() => assertSupplierOverpayMutable(req.purchaseId, B(plan.newPaidF), B(plan.newTotalF)));

  const notes = typeof req.notes === 'string' && req.notes.trim() ? req.notes.trim() : undefined;
  const draft = createPurchaseReturnDraftInHouse({
    purchaseId: req.purchaseId, refundMethod: req.refundMethod, notes,
    lines: req.lines.map((l) => ({ purchaseLineId: l.purchaseLineId, quantity: l.quantity, unitPrice: l.unitPrice, addedCostRefund: l.addedCostRefund })),
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
export function reverseConfirmedPurchaseReturnInHouse(returnId: string, now: string, ledgerMark?: Record<string, unknown>): void {
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

  // 1b. PARTNER-ITEMS — die Partnerbuchungen dieser Rückgabe gegenbuchen (Nein, wenn danach gebucht wurde).
  partnerUrteil(() => reverseSupplierReturnForPartners(returnId, now));

  // 2. Ledger-Storno (INVENTORY/AP/Cash der PURCHASE_RETURN-Buchung). Guarded + idempotent, STRIKT.
  if (hasLedgerEntries('PURCHASE_RETURN', returnId) && !hasReversalFor('PURCHASE_RETURN', returnId)) {
    // v0.8.101 — „Cancel return" kennzeichnet die Gegenbuchung (Erfassungsfehler oder echte Rückzahlung); der Einkaufs-Storno nicht.
    reverseSource('PURCHASE_RETURN', returnId, now, ledgerMark ? { metadata: ledgerMark } : {});
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
// v0.8.101 (Owner 11.11.2026) — „Cancel return": EINE gebuchte Lieferantenrückgabe zurücknehmen; der Einkauf bleibt.
//
// Die Umkehr selbst ist der bestehende Weg (`reverseConfirmedPurchaseReturnInHouse`, derselbe wie im Einkaufs-Storno):
// Partnerbuchungen der Rückgabe gegengebucht, die Rückgabebuchung storniert (Lagerwert inkl. Zusatzkosten, Verlust,
// Vorsteuer, A/P, Erstattung), die Stücke zurück ins Los, Einkaufssummen, ungenutztes Guthaben der Rückgabe entfernt.
// Diese Folge prüft VORHER — nichts wird geschrieben, solange etwas offen ist — und nennt den konkreten offenen Ausgleich:
//   • ZWEI ARTEN (Owner 11.11.2026), Pflichtangabe `kind`:
//     A `entry_error` — die Rückgabe wurde versehentlich erfasst, der Lieferant hat NICHTS erstattet. Die Gegenbuchung
//       korrigiert auch die falsch gebuchte Erstattung (Kasse/Bank/Benefit) — als Korrektur gekennzeichnet, KEINE Zahlung.
//       Banking blendet den falschen Eingang aus (wie eine stornierte Zahlung); Hauptbuch und Protokoll behalten beides.
//     B `reversed` — die Rückgabe war echt und wird rückgängig gemacht. Hat der Lieferant Geld gezahlt, geht es an ihn
//       zurück: eine ECHTE Zahlung, nur nachgewiesen (`refundRepaid` + Beleg `repaymentReference`), sonst Nein mit Betrag
//       und Weg. Die Rückgabe vermerkt sie (`refund_repaid_amount`, `refund_repaid_reference`, `cancelled_at`); Banking
//       zeigt den Eingang UND die Rückzahlung. Eine Rückzahlung wird genau einmal erfasst (Status, Auftragskennung).
//   • Ein Lieferantenguthaben aus der Rückgabe darf nicht verbraucht oder ausgezahlt sein (wo und wieviel, steht im Nein).
//   • Partnerbuchungen NACH der Rückgabe (Auszahlung, Verrechnung …) zuerst zurücknehmen — keine doppelte Auszahlung.
//   • Der Einstand des Loses muss derselbe sein wie bei der Rückgabe (sonst kämen die Stücke zum falschen Wert zurück).
//   • Rückgaben aus einer Kommission bleiben beim Kommissionsweg; die Gegenbuchung heute braucht ein offenes VAT-Quartal.
// Die Rückgabe bleibt als CANCELLED mit Nummer, Zeilen und Beträgen stehen (Historie); das Protokoll nennt alles.
// ════════════════════════════════════════════════════════════════════════════

export const PURCHASE_RETURN_NOT_FOUND = 'PURCHASE_RETURN_NOT_FOUND';
export const PURCHASE_RETURN_ALREADY_CANCELLED = 'PURCHASE_RETURN_ALREADY_CANCELLED';
export const PURCHASE_RETURN_NOT_BOOKED = 'PURCHASE_RETURN_NOT_BOOKED';
export const PURCHASE_RETURN_REASON_REQUIRED = 'PURCHASE_RETURN_REASON_REQUIRED';
export const PURCHASE_RETURN_REFUND_NOT_REPAID = 'PURCHASE_RETURN_REFUND_NOT_REPAID';
export const PURCHASE_RETURN_CREDIT_USED = 'PURCHASE_RETURN_CREDIT_USED';
export const PURCHASE_RETURN_PARTNER_LATER = 'PURCHASE_RETURN_PARTNER_LATER';
export const PURCHASE_RETURN_COST_CHANGED = 'PURCHASE_RETURN_COST_CHANGED';
export const PURCHASE_RETURN_COST_UNKNOWN = 'PURCHASE_RETURN_COST_UNKNOWN';
export const PURCHASE_RETURN_CONSIGNMENT = 'PURCHASE_RETURN_CONSIGNMENT';
export const PURCHASE_RETURN_STOCK_MISSING = 'PURCHASE_RETURN_STOCK_MISSING';
export const PURCHASE_RETURN_CANCEL_KIND_REQUIRED = 'PURCHASE_RETURN_CANCEL_KIND_REQUIRED';
export const PURCHASE_RETURN_KIND_CONFLICT = 'PURCHASE_RETURN_KIND_CONFLICT';
export const PURCHASE_RETURN_NOTHING_TO_REPAY = 'PURCHASE_RETURN_NOTHING_TO_REPAY';

/** Die zwei Arten eines Stornos (Owner 11.11.2026): versehentlich erfasst oder echte Rückgabe rückgängig. */
export const PURCHASE_RETURN_CANCEL_KINDS = ['entry_error', 'reversed'] as const;
export type PurchaseReturnCancelKind = typeof PURCHASE_RETURN_CANCEL_KINDS[number];
export const isPurchaseReturnCancelKind = (v: unknown): v is PurchaseReturnCancelKind =>
  (PURCHASE_RETURN_CANCEL_KINDS as readonly unknown[]).includes(v);

const GELD_WEGE = ['cash', 'bank', 'benefit'];
const wegName = (m: string): string => (m === 'benefit' ? 'Benefit' : m);
const bhd = (f: number): string => `${B(f).toFixed(3)} BHD`;

export interface PurchaseReturnCancelRequest {
  purchaseId: string;
  returnId: string;
  reason: string;
  /** A `entry_error`: versehentlich erfasst, nichts erstattet. B `reversed`: echte Rückgabe wird rückgängig gemacht. */
  kind: PurchaseReturnCancelKind;
  /** Nur B, nur wenn der Lieferant Geld gezahlt hat: es ging nachweislich an ihn zurück (echte Zahlung). */
  refundRepaid?: boolean;
  /** Nur B mit Geld: der Beleg der Rückzahlung (Überweisungsreferenz, Quittungsnummer). */
  repaymentReference?: string;
}

export interface PurchaseReturnCancelled {
  returnId: string;
  returnNumber: string;
  purchaseId: string;
  previousStatus: string;
  kind: PurchaseReturnCancelKind;
  /** Echte Rückzahlung an den Lieferanten (Kasse/Bank/Benefit) — nur B; 0, wenn kein Geld geflossen war. */
  moneyRepaid: number;
  /** A: die falsch gebuchte Erstattung, die korrigiert wurde (keine Zahlung) — 0 sonst. */
  entryErrorCorrected: number;
  repaidMethod: string | null;
  /** Ungenutztes Lieferantenguthaben der Rückgabe, das entfernt wurde. */
  supplierCreditRemoved: number;
  /** Buchwert der Stücke, die wieder im Lager stehen (Menge × Einstand). */
  restoredBookValue: number;
  /** Mit der Rückgabe gebuchter Verlust (INVENTORY_LOSS), jetzt gegengebucht. */
  reversedLoss: number;
  partnerMovementsReversed: number;
  purchaseStatus: PurchaseStatus;
  remainingAmount: number;
}

/** Wo ein Lieferantenguthaben aus der Rückgabe schon steckt — für den Satz an den Menschen. */
function guthabenVerwendung(creditId: string): string[] {
  const out: string[] = [];
  for (const r of query(
    `SELECT p.purchase_number, pp.amount FROM purchase_payments pp JOIN purchases p ON p.id = pp.purchase_id
      WHERE pp.method = 'credit' AND pp.reference = ? AND pp.voided_at IS NULL`, [creditId],
  )) out.push(`${bhd(F(r.amount))} applied to ${String(r.purchase_number ?? 'a purchase')}`);
  for (const r of query(
    `SELECT e.expense_number, ep.amount FROM expense_payments ep JOIN expenses e ON e.id = ep.expense_id
      WHERE ep.method = 'credit' AND ep.reference = ?`, [creditId],
  )) out.push(`${bhd(F(r.amount))} applied to ${String(r.expense_number ?? 'an expense')}`);
  for (const r of query('SELECT amount, method, received_at FROM supplier_credit_refunds WHERE supplier_credit_id = ?', [creditId])) {
    out.push(`${bhd(F(r.amount))} paid out by the supplier (${wegName(String(r.method ?? ''))}, ${String(r.received_at ?? '').slice(0, 10)})`);
  }
  return out;
}

/**
 * „Cancel return" — prüft alles, dann die bestehende Umkehr, dann Status/Vermerk/Protokoll. Läuft in der Transaktion des
 * Aufrufers (`runOnPrimary` am Primary, `runRemoteCommand` für PC2); ein Nein ist ein `PurchaseLifecycleRejected`.
 */
export function cancelPurchaseReturnInHouse(
  req: PurchaseReturnCancelRequest, ctx: HouseCtx, expectedRevision?: number,
): PurchaseReturnCancelled {
  assertBooks();
  const p = livePurchase(req.purchaseId, ctx.branchId);
  assertSeen(req.purchaseId, expectedRevision);
  const ret = query('SELECT * FROM purchase_returns WHERE id = ? AND purchase_id = ? AND branch_id = ?',
    [req.returnId, req.purchaseId, ctx.branchId])[0];
  if (!ret) throw nein(PURCHASE_RETURN_NOT_FOUND, 'no such supplier return on this purchase in this branch');
  const returnId = String(ret.id);
  const nummer = String(ret.return_number ?? '') || returnId.slice(0, 8);
  const vorher = String(ret.status ?? '');
  if (vorher === 'CANCELLED') throw nein(PURCHASE_RETURN_ALREADY_CANCELLED, `${nummer} is already cancelled — nothing was changed`);
  if (vorher !== 'CONFIRMED' && vorher !== 'COMPLETED') {
    throw nein(PURCHASE_RETURN_NOT_BOOKED, `${nummer} was never booked (${vorher || 'no status'}) — there is nothing to undo`);
  }
  if (String(p.status) === 'CANCELLED') throw nein('PURCHASE_CANCELLED', 'this purchase is cancelled — its returns were undone with it');
  const grund = typeof req.reason === 'string' ? req.reason.trim() : '';
  if (!grund) throw nein(PURCHASE_RETURN_REASON_REQUIRED, 'A reason is required to cancel a supplier return.');
  if (!isPurchaseReturnCancelKind(req.kind)) {
    throw nein(PURCHASE_RETURN_CANCEL_KIND_REQUIRED,
      'say what happened: "entry error" (the return was recorded by mistake, the supplier refunded nothing) or "reversed" (a real return is undone). Nothing was changed.');
  }
  if (purchaseHasActiveOffsets(req.purchaseId)) throw nein(PURCHASE_HAS_OFFSET, purchaseHasOffsetMessage('Cancelling a supplier return'));
  const kommission = !!p.source_consignment_id || /^Consignor payout/.test(String(p.notes ?? ''))
    || query(`SELECT 1 FROM purchase_return_lines prl JOIN purchase_lines pl ON pl.id = prl.purchase_line_id
               WHERE prl.return_id = ? AND pl.source_consignment_id IS NOT NULL LIMIT 1`, [returnId]).length > 0;
  if (kommission) {
    throw nein(PURCHASE_RETURN_CONSIGNMENT,
      `${nummer} belongs to a consignment — undo it from the consignment, not here; nothing was changed`);
  }
  // Die Gegenbuchung steht HEUTE (die ursprüngliche VAT-Korrektur bleibt in ihrem Quartal) — heute muss offen sein.
  const tagNein = correctionDateIssue(ctx.branchId, [{ iso: ctx.now, what: 'the cancellation of this supplier return' }]);
  if (tagNein) throw nein(tagNein.code, tagNein.message);

  // 1. Geld (Kasse/Bank/Benefit), das mit der Rückgabe als erstattet gebucht wurde:
  //    A — war nie da: die Gegenbuchung korrigiert die falsche Buchung, keine Zahlung, kein Rückzahlungsvermerk.
  //    B — kam wirklich: es geht an den Lieferanten zurück — nur nachgewiesen (Bestätigung + Beleg), keine fiktive Zahlung.
  const weg = (ret.refund_method as string | null) || null;
  const refundF = F(ret.refund_amount);
  const addedF = F(ret.added_cost_refund);
  const geldF = weg && GELD_WEGE.includes(weg) ? refundF + addedF : 0;
  const beleg = typeof req.repaymentReference === 'string' ? req.repaymentReference.trim() : '';
  if (req.kind === 'entry_error' && (req.refundRepaid === true || beleg)) {
    throw nein(PURCHASE_RETURN_KIND_CONFLICT,
      'an entry error has no repayment — the supplier refunded nothing, so nothing goes back. Choose "reversed" if money really came and went back. Nothing was changed.');
  }
  if (req.kind === 'reversed' && geldF === 0 && (req.refundRepaid === true || beleg)) {
    throw nein(PURCHASE_RETURN_NOTHING_TO_REPAY,
      `with ${nummer} the supplier paid no money (${weg === 'credit' ? 'the refund was a supplier credit' : 'the return only reduced what we owed'}) — there is no repayment to record. Nothing was changed.`);
  }
  if (req.kind === 'reversed' && geldF > 0 && (req.refundRepaid !== true || !beleg)) {
    throw nein(PURCHASE_RETURN_REFUND_NOT_REPAID,
      `with ${nummer} the supplier paid ${bhd(geldF)} back by ${wegName(weg!)}`
      + (addedF > 0 ? ` (refund ${bhd(refundF)} + added costs ${bhd(addedF)})` : '')
      + `. Undoing the return sends this money back to the supplier — repay ${bhd(geldF)} by ${wegName(weg!)}, then confirm the repayment with its reference`
      + (req.refundRepaid === true && !beleg ? ' (the reference is missing)' : '')
      + '. If the supplier never paid this money, cancel it as an entry error instead. Nothing was changed.');
  }
  const rueckzahlungF = req.kind === 'reversed' ? geldF : 0;
  const korrekturF = req.kind === 'entry_error' ? geldF : 0;
  // 2. Guthaben aus der Rückgabe: unbenutzt (sonst wo und wieviel).
  let guthabenF = 0;
  const guthabenZeilen: Array<Record<string, unknown>> = [];
  for (const c of query('SELECT id, amount, used_amount, status, created_at, note FROM supplier_credits WHERE source_return_id = ?', [returnId])) {
    const usedF = F(c.used_amount);
    if (usedF > 5) {
      const wo = guthabenVerwendung(String(c.id));
      throw nein(PURCHASE_RETURN_CREDIT_USED,
        `the supplier credit from ${nummer} (${bhd(F(c.amount))}) is already used: ${wo.length ? wo.join(', ') : bhd(usedF)}. `
        + 'Undo that first, then cancel the return. Nothing was changed.');
    }
    guthabenF += F(c.amount);
    // Die bestehende Umkehr entfernt die UNGENUTZTE Guthabenzeile (bestehender Vertrag, `supplier_credits` kennt keinen
    // Storno-Status); die Buchung dazu bleibt mit ihrer Gegenbuchung im Hauptbuch. Das Protokoll hält die Zeile vollständig fest.
    guthabenZeilen.push({ id: String(c.id), amount: Number(c.amount) || 0, usedAmount: Number(c.used_amount) || 0,
      status: String(c.status ?? ''), createdAt: String(c.created_at ?? ''), note: c.note ?? null });
  }
  // 3. Partner: keine Partnerbuchung NACH der Rückgabe (sonst würde eine Auszahlung/Verrechnung doppelt).
  const partnerZeilen = query(
    `SELECT rowid AS rid, id, purchase_line_id, partner_id FROM item_partner_movements
      WHERE purchase_return_id = ? AND kind = 'SUPPLIER_RETURN' AND cancelled_at IS NULL`, [returnId]);
  const eigene = new Set(partnerZeilen.map((r) => String(r.id)));
  for (const t of partnerZeilen) {
    const spaeter = query(
      `SELECT m.id, m.kind, m.amount, m.occurred_at, COALESCE(pa.name, m.partner_id) AS name FROM item_partner_movements m
         LEFT JOIN partners pa ON pa.id = m.partner_id
        WHERE m.purchase_line_id = ? AND m.partner_id = ? AND m.cancelled_at IS NULL AND m.rowid > ?`,
      [t.purchase_line_id, t.partner_id, t.rid]).filter((x) => !eigene.has(String(x.id)));
    if (spaeter.length > 0) {
      throw nein(PURCHASE_RETURN_PARTNER_LATER,
        `after ${nummer} the partner share of this item was settled further: `
        + spaeter.map((x) => `${String(x.name)} ${String(x.kind).toLowerCase()} ${bhd(F(x.amount))} (${String(x.occurred_at ?? '').slice(0, 10)})`).join(', ')
        + ' — reverse that first, so nothing is paid out twice. Nothing was changed.');
    }
  }
  // 4. Stücke und Einstand: jedes zurückgegebene Stück kommt zu dem Wert zurück, mit dem es ging.
  let buchwertF = 0;
  for (const line of query('SELECT * FROM purchase_return_lines WHERE return_id = ?', [returnId])) {
    const plId = (line.purchase_line_id as string | null) || null;
    const q = Math.max(0, Number(line.quantity) || 0);
    if (q <= 0) continue;
    const lot = plId ? query(
      `SELECT id, product_id, unit_cost, qty_total, qty_remaining FROM stock_lots
        WHERE purchase_line_id = ? AND status != 'CANCELLED' ORDER BY acquired_at ASC, id ASC LIMIT 1`, [plId])[0] : undefined;
    if (!lot || !query('SELECT 1 FROM products WHERE id = ?', [lot.product_id]).length) {
      throw nein(PURCHASE_RETURN_STOCK_MISSING,
        `a returned item of ${nummer} has no stock lot to come back to (an old entry or a removed item) — its value cannot be put back exactly; nothing was changed`);
    }
    if (Number(lot.qty_remaining) + q > Number(lot.qty_total) + 1e-9) {
      throw nein(PURCHASE_RETURN_STOCK_MISSING,
        `the stock lot of a returned item of ${nummer} cannot take ${q} piece(s) back (${Number(lot.qty_remaining)} of ${Number(lot.qty_total)} in stock); nothing was changed`);
    }
    const jetzt = Number(lot.unit_cost) || 0;
    const damals = line.unit_cost_at_return === null || line.unit_cost_at_return === undefined ? null : Number(line.unit_cost_at_return);
    if (damals !== null) {
      if (Math.abs(jetzt - damals) > 0.0005) {
        throw nein(PURCHASE_RETURN_COST_CHANGED,
          `the remaining pieces of this item changed cost after ${nummer} (then ${damals.toFixed(3)}, now ${jetzt.toFixed(3)} per piece, e.g. a repair) — `
          + 'the returned pieces would come back at the wrong value. Reverse that cost change first. Nothing was changed.');
      }
    } else {
      // Ältere Rückgabe ohne festgehaltenen Einstand: nur sicher, wenn das Los noch genau den Einkaufseinstand trägt.
      const pl = query('SELECT quantity, unit_price, line_total, vat_amount FROM purchase_lines WHERE id = ?', [plId])[0];
      const einkauf = pl ? purchaseLotUnitCost({ qty: Math.max(1, Number(pl.quantity) || 1), unitPrice: Number(pl.unit_price) || 0,
        lineTotal: Number(pl.line_total) || 0, vatAmount: Number(pl.vat_amount) || 0 }) : jetzt;
      if (Math.abs(jetzt - einkauf) > 0.0005 && Math.abs(jetzt - (Number(pl?.unit_price) || 0)) > 0.0005) {
        throw nein(PURCHASE_RETURN_COST_UNKNOWN,
          `${nummer} was booked before the book value of returned pieces was recorded, and this item now carries ${jetzt.toFixed(3)} per piece `
          + `instead of the purchase cost ${einkauf.toFixed(3)} — what the returned pieces were worth cannot be proven. Please check it with the accountant. Nothing was changed.`);
      }
    }
    buchwertF += Math.round(q * jetzt * 1000);
  }
  const verlustF = F(query(
    `SELECT COALESCE(SUM(amount), 0) AS t FROM ledger_entries
      WHERE source_module = 'PURCHASE_RETURN' AND source_id = ? AND account = 'INVENTORY_LOSS' AND direction = 'DEBIT'`, [returnId])[0]?.t);
  const vorherEinkauf = { total: Number(p.total_amount) || 0, paid: Number(p.paid_amount) || 0, remaining: Number(p.remaining_amount) || 0, status: String(p.status) };

  // 5. Die bestehende Umkehr (Partner, Hauptbuch, Lose, Artikelstatus, Einkaufssummen, Guthaben, Overpay).
  const kennung = req.kind === 'entry_error' ? 'ENTRY_ERROR' : 'REVERSED';
  reverseConfirmedPurchaseReturnInHouse(returnId, ctx.now, {
    purchaseReturnCancel: kennung, returnNumber: nummer,
    // Die Gegenbuchung der Geldzeile ist bei A eine KORREKTUR (nie geflossen), bei B die ECHTE Rückzahlung.
    ...(geldF > 0 ? { money: req.kind === 'entry_error' ? 'entry-error-correction' : 'repaid-to-supplier', moneyAmount: B(geldF), moneyMethod: weg } : {}),
    ...(rueckzahlungF > 0 ? { repaymentReference: beleg } : {}),
  });

  const db = getDatabase();
  db.run(
    `UPDATE purchase_returns SET status = 'CANCELLED', cancelled_at = ?, cancelled_by = ?, cancel_reason = ?, refund_repaid_amount = ?,
       cancel_kind = ?, refund_repaid_reference = ? WHERE id = ?`,
    [ctx.now, ctx.userId || null, grund, B(rueckzahlungF), kennung, rueckzahlungF > 0 ? beleg : null, returnId],
  );
  trackChange('purchase_returns', returnId, 'update', {});
  const nachher = query('SELECT status, total_amount, paid_amount, remaining_amount FROM purchases WHERE id = ?', [req.purchaseId])[0] ?? {};
  logAuditOrThrow({
    module: 'Purchase', entityType: 'purchase_returns', entityId: returnId, action: 'STATUS_CHANGE', field: 'status',
    oldValue: vorher,
    newValue: {
      status: 'CANCELLED', kind: kennung, reason: grund, purchaseId: req.purchaseId, returnNumber: nummer,
      // Echte Geldbewegung (B, nachgewiesen) getrennt von der Korrektur einer falsch gebuchten Erstattung (A) und den
      // buchhalterischen Gegenbuchungen:
      moneyRepaid: rueckzahlungF > 0 ? { amount: B(rueckzahlungF), method: weg, reference: beleg, refund: B(refundF), addedCosts: B(addedF) } : null,
      entryErrorCorrected: korrekturF > 0 ? { amount: B(korrekturF), method: weg, refund: B(refundF), addedCosts: B(addedF), note: 'booked refund never received — corrected, no payment' } : null,
      supplierCreditRemoved: B(guthabenF), supplierCreditRows: guthabenZeilen,
      restoredBookValue: B(buchwertF), reversedLoss: B(verlustF), reversedAddedCostRefund: B(addedF),
      partnerMovementsReversed: partnerZeilen.length,
      purchaseBefore: vorherEinkauf,
      purchaseAfter: { total: Number(nachher.total_amount) || 0, paid: Number(nachher.paid_amount) || 0,
        remaining: Number(nachher.remaining_amount) || 0, status: String(nachher.status ?? '') },
    },
    actor: { userId: ctx.userId || undefined, branchId: ctx.branchId },
  });
  return {
    returnId, returnNumber: nummer, purchaseId: req.purchaseId, previousStatus: vorher, kind: req.kind,
    moneyRepaid: B(rueckzahlungF), repaidMethod: rueckzahlungF > 0 ? weg : null, entryErrorCorrected: B(korrekturF), supplierCreditRemoved: B(guthabenF),
    restoredBookValue: B(buchwertF), reversedLoss: B(verlustF), partnerMovementsReversed: partnerZeilen.length,
    purchaseStatus: String(nachher.status ?? '') as PurchaseStatus, remainingAmount: Number(nachher.remaining_amount) || 0,
  };
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
  /**
   * MIXED-INVOICE P4 (E11) — nur die Korrekturfolge einer Kommissionsrechnung, nur für einen UNBEZAHLTEN Auto-Einkauf: der
   * Einkauf war eine Fehlerfassung, seine Buchung wird auf ihrem eigenen Tag gespiegelt (wie die Gegenbuchung der Rechnung),
   * nicht heute — sonst stünde zwischen Einkaufstag und heute ein Lager ohne Verkauf.
   */
  mirrorOriginalDates?: boolean;
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
  // B2/B3 — eine wirksame Verrechnung mit einer Kundenrechnung zuerst aufheben (sonst würde sie zu Geld oder zerrisse).
  if (purchaseHasActiveOffsets(purchaseId)) throw nein(PURCHASE_HAS_OFFSET, purchaseHasOffsetMessage('Cancelling this purchase'));
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

  // Sperre 3 — Ware aus diesem Einkauf steht schon auf einer wirksamen Rechnung. Der Storno
  // setzte alle Lose CANCELLED und reversierte den vollen Lagerzugang, obwohl ein Teil schon
  // als COGS abgeflossen ist; ein späterer Kunden-Rückläufer fände kein Los mehr (restoreLot
  // → false). Erst die Rechnung klären (Retoure/Storno), dann den Einkauf.
  //    Eine schon zurückgenommene Zeile (wirksame Kunden-Retoure) zählt nicht — z. B. „Return to
  //    Owner" einer Kommission storniert danach genau diesen Auto-Einkauf.
  const verkauft = query(
    `SELECT 1 FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id
      WHERE i.status != 'CANCELLED'
        AND il.lot_id IN (SELECT id FROM stock_lots WHERE purchase_id = ?)
        AND COALESCE(il.quantity, 1) - COALESCE((
              SELECT SUM(srl.quantity) FROM sales_return_lines srl
                JOIN sales_returns r ON r.id = srl.return_id
               WHERE srl.invoice_line_id = il.id AND r.status != 'REJECTED'), 0) > 0.0005
      LIMIT 1`,
    [purchaseId],
  )[0];
  if (verkauft) {
    throw nein('PURCHASE_STOCK_SOLD',
      'Cannot cancel this purchase: items from it are already on an invoice. Return or cancel that sale first.');
  }
  // Sperre 4 — PURCHASE-EDIT B5: die übrigen Wege, auf denen ein Stück das Los verließ oder seinen
  // Einstand änderte (Agentenverkauf, Produktion, Bestandsabgang, aktivierte Reparaturkosten). Vorher
  // reversierte der Storno auch dann den vollen Lagerzugang, und INVENTORY passte nicht mehr zu den Losen.
  const verbraucht = purchaseCancelBlocker(purchaseId);
  if (verbraucht) throw nein(verbraucht.code, verbraucht.message);
  // BULK METAL V1 — ein Bulk-Lot darf nur unbenutzt mit dem Einkauf storniert werden (6.5).
  assertBulkLotsOfPurchaseUnused(purchaseId);
  // Sperre 5 — v0.8.91: brachte DIESER Einkauf einen früheren Kommissions-/Agentenartikel auf „eigen" (und hält seinen
  // ganzen Bestand), ist die Herkunft davor nicht festgehalten — nicht raten, sperren. Der Auto-Einkauf einer
  // Kommission ist ausgenommen: dort bleibt der Artikel Kommissionsware, und die Umkehr der Kommission setzt sie selbst.
  const kommissionsEinkauf = !!p.source_consignment_id || /^Consignor payout/.test(String(p.notes ?? ''))
    // CONSIGNOR-JOINT-PURCHASE — der gemeinsame Einkauf nennt die Kommission an seinen Zeilen.
    || query('SELECT 1 FROM purchase_lines WHERE purchase_id = ? AND source_consignment_id IS NOT NULL LIMIT 1', [purchaseId]).length > 0;
  if (!kommissionsEinkauf) {
    const loseJeArtikel = new Map<string, string[]>();
    for (const l of query(`SELECT id, product_id FROM stock_lots WHERE purchase_id = ? AND status != 'CANCELLED'`, [purchaseId])) {
      const pid = String(l.product_id ?? '');
      if (!pid || isBulkMetalProduct(pid)) continue;
      loseJeArtikel.set(pid, [...(loseJeArtikel.get(pid) ?? []), String(l.id)]);
    }
    for (const [pid, lose] of loseJeArtikel) {
      if (herkunftUnklar(pid, lose)) {
        throw nein('PURCHASE_OWNERSHIP_UNCLEAR',
          'Cannot cancel this purchase: an item from it was on consignment or with an agent before. Its earlier ownership is not recorded, so it is not undone automatically — please check it with the accountant.');
      }
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
  // BULK METAL V1 — Bulk-Lots: Bewegung PURCHASE_CANCEL, Rest 0, CANCELLED (die Buchung spiegelt unten postPurchaseCancelled).
  cancelBulkLotsOfPurchase(purchaseId, { branchId, userId: bulkActor(), now });
  const cancelledLotIds = query(`SELECT id FROM stock_lots WHERE purchase_id = ? AND status != 'CANCELLED'`, [purchaseId])
    .map(r => r.id as string);
  db.run(`UPDATE stock_lots SET status = 'CANCELLED' WHERE purchase_id = ?`, [purchaseId]);
  for (const lid of cancelledLotIds) trackLotRow(lid, 'update');
  for (const pid of affectedProductIds) {
    if (isBulkMetalProduct(pid)) continue;   // BULK METAL V1 — der Systemartikel bleibt in_stock
    syncProductQuantity(pid);
    // F-PRC-01 — sonst bliebe stock_status='in_stock' bei 0 Lots stehen (Phantom). Nur in_stock
    // anfassen, damit sold/consumed/returned nicht ueberschrieben werden. v0.8.91 — nicht pauschal 'returned':
    // der Zustand von VOR diesem Einkauf (ein verkaufter Artikel ist wieder 'sold'), ohne Vorgeschichte wie bisher.
    if (getAvailableStock(pid) === 0) {
      db.run(`UPDATE products SET stock_status = ?, updated_at = ? WHERE id = ? AND stock_status = 'in_stock'`, [statusOhneBestand(pid), now, pid]);
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
    if (opts.mirrorOriginalDates) {
      if (reversedPayments > 0) throw nein('PURCHASE_PAID_NOT_CANCELLABLE', 'only an unpaid purchase is cancelled on its own date');
      reverseSource('PURCHASE', purchaseId, now, { mirrorOriginalDates: true });
    } else {
      postPurchaseCancelled({ id: purchaseId } as Purchase);
    }
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
/** Was beim Anlegen eines Posteingangs-Eintrags herauskommt. */
export interface PurchaseInboxCreated { inboxId: string; status: 'pending'; photoCount: number }

/**
 * MEDIA-INBOX §3 — einen Posteingangs-Eintrag anlegen und sein Foto in DERSELBEN Klammer anhängen.
 *
 * Die Bytes sind vorher schon ein geprüftes, veröffentlichtes Medium geworden (der Ingest hat seine
 * eigenen durablen Haltepunkte und gehört nicht in eine offene Geschäftstransaktion). Hier entsteht
 * nur noch die Zeile — ohne Bilderliste — und die Verknüpfung. Scheitert eines von beiden, nimmt
 * die Klammer beides zurück: kein halber Eintrag, keine halbe Verknüpfung.
 */
export function createPurchaseInboxInHouse(
  input: { note?: string; mediaIds: readonly string[] },
  branchId: string,
  now: string,
): PurchaseInboxCreated {
  assertBooks();
  if (input.mediaIds.length === 0) throw nein('INBOX_PHOTO_REQUIRED', 'an inbox entry is a photo — there is nothing to file without one');
  const inboxId = uuid();
  let userId: string | null = null;
  try { userId = currentUserId() || null; } catch { userId = null; }
  getDatabase().run(
    `INSERT INTO purchase_inbox (id, branch_id, images, note, status, created_at, created_by)
     VALUES (?, ?, '[]', ?, 'pending', ?, ?)`,
    [inboxId, branchId, input.note || null, now, userId],
  );
  applyInboxGallery(inboxId, input.mediaIds);
  logAuditOrThrow({
    module: 'Purchase', entityType: 'purchase_inbox', entityId: inboxId, action: 'CREATE', field: 'status',
    oldValue: '', newValue: 'pending', actor: { branchId },
  });
  // Die Zeile reist über den normalen Abgleich — OHNE Bildbytes; das Foto ist ein Medium.
  trackChange('purchase_inbox', inboxId, 'insert', {
    id: inboxId, branch_id: branchId, images: '[]', note: input.note || null,
    status: 'pending', created_at: now, created_by: userId,
  });
  return { inboxId, status: 'pending', photoCount: input.mediaIds.length };
}

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
