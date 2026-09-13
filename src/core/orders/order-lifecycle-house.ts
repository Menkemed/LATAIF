// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6F — der Lebenszyklus eines Auftrags am Haus: stornieren (mit Geld), eine
// Position weiterschalten, eine Position „beim Lieferanten bestellt" markieren, eine Position ändern.
//
// Was vorher am Primary geschah — und warum es nicht bleiben konnte:
//   • „Cancel Order" buchte die Rückzahlung/Gutschrift/den Verfall in einem `safePost` (Fehler nur
//     protokolliert) und legte das angefangene Sonderstück in einem `try/catch` an, das nur
//     protokollierte: der Auftrag war storniert, das Geld im Hauptbuch aber noch Anzahlung, bzw. die
//     Schuld beim Goldschmied offen und das Stück nirgends. Umgewandelte Anzahlungen (Geld schon auf
//     einer später stornierten Rechnung) wurden ein zweites Mal zurückgezahlt. Die Notiz der Maske
//     („Keep as credit") erreichte das Guthaben nie.
//   • Die Statusknöpfe einer Position buchten die Lieferanten-A/P der angekommenen Position in einem
//     `try/catch`: der Status stand, die Schuld fehlte.
//   • „Speichern" einer Position speicherte Menge und Preis, auch wenn der neue Artikel nicht angelegt
//     werden konnte; Rest und Marge des Auftrags blieben auf dem alten Preis stehen.
//
// Jetzt: `…InHouse` ist die EINE Folge (prüfen, dann schreiben, dann die Wirkung nachprüfen) in der
// Transaktion des Aufrufers — der Fernbefehl ruft sie in `runRemoteCommand`, die Maske des Primary
// über `…OnPrimary` in `runOnPrimary`. Schreiben tut weiterhin der Store (EINE Implementierung); die
// Hausfolge liefert die Regeln der Masken mit stabilem Code und macht jede abgefangene Buchung zum
// Abbruch der ganzen Handlung (`watchLedgerPosts`).
//
// Bewusst NICHT hier: „Delete Order" — Löschen bleibt am Primary (R6B, Klasse E).
// ════════════════════════════════════════════════════════════════════════════
import { query, currentBranchId } from '@/core/db/helpers';
import { getDatabase } from '@/core/db/database';
import { runOnPrimary } from '@/core/data/primary-action';
import { readsFromPrimary } from '@/core/data/primary-source';
import { watchLedgerPosts } from '@/core/ledger/posting';
import { trackUpdate } from '@/core/sync/track';
import { useOrderStore } from '@/stores/orderStore';
import { useProductStore } from '@/stores/productStore';
import { useGoldStore } from '@/stores/goldStore';
import { useExpenseStore } from '@/stores/expenseStore';
import { useCustomerStore } from '@/stores/customerStore';
import { reconcileOrderOverpayCredit } from '@/stores/orderPaymentStore';
import type { Product } from '@/core/models/types';
import {
  EMBEDDED_PRODUCT_FIELDS, EmbeddedProductRejected, checkEmbeddedProduct, pickProductSpec, stageSpecImages,
} from '@/core/products/embedded-product';
import { OrderActionRejected } from './order-create';
import { planOrderEdit } from './order-edit';
import { houseOrderPort } from './order-house';

const num = (v: unknown): number => Number(v ?? 0) || 0;
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const round3 = (v: number): number => Math.round(v * 1000) / 1000;
const nein = (code: string, message: string): never => { throw new OrderActionRejected(code, message); };

// ── Der Wortschatz der Masken ─────────────────────────────────────────────

/** Die drei Wege der Storno-Maske für das bereits erhaltene Geld. */
export const ORDER_CANCEL_CHOICES = ['refund', 'credit', 'forfeit'] as const;
export type OrderCancelChoice = typeof ORDER_CANCEL_CHOICES[number];
/** „REFUND METHOD" der Maske — dieselben drei Konten, die `postOrderCancellationChoice` kennt. */
export const ORDER_REFUND_METHODS = ['cash', 'bank', 'benefit'] as const;
export type OrderRefundMethod = typeof ORDER_REFUND_METHODS[number];
/** Die Statusknöpfe einer Position (PENDING / ARRIVED / DELIVERED, „↺ Undo" ist PENDING). */
export const ORDER_LINE_STATUS_TARGETS = ['PENDING', 'ARRIVED', 'DELIVERED'] as const;
export type OrderLineStatusTarget = typeof ORDER_LINE_STATUS_TARGETS[number];

// ── Nachschlagen in der Filiale ───────────────────────────────────────────

function liveOrder(id: string, branchId: string): Record<string, unknown> {
  const o = query(
    'SELECT id, status, customer_id, agreed_price, deposit_amount, supplier_price, revision FROM orders WHERE id = ? AND branch_id = ?',
    [id, branchId],
  )[0];
  if (!o) nein('ORDER_NOT_FOUND', 'no such order in this branch');
  return o;
}

/** Die gesehene Fassung — verglichen gegen die Zeile selbst, INNERHALB der Transaktion. */
function assertSeen(o: Record<string, unknown>, expected: number | undefined): void {
  if (expected === undefined) return;
  const now = num(o.revision);
  if (now !== expected) nein('RECORD_CHANGED', `this record changed since you opened it (you saw ${expected}, it is now ${now})`);
}

function liveLine(orderId: string, lineId: string): Record<string, unknown> {
  const l = query('SELECT * FROM order_lines WHERE id = ?', [lineId])[0];
  if (!l) nein('LINE_NOT_FOUND', 'no such order line');
  if (str(l.order_id) !== orderId) nein('LINE_NOT_ON_ORDER', 'this line belongs to another order');
  return l;
}

/** Die Positionskarte „ORDER ITEMS" zeigt nur kundenseitige Zeilen — Kostenzeilen haben ihre eigenen Wege. */
function assertCustomerLine(l: Record<string, unknown>): void {
  const facing = l.is_customer_facing === null || l.is_customer_facing === undefined || num(l.is_customer_facing) === 1;
  if (!facing) nein('LINE_NOT_A_CUSTOMER_LINE', 'this is an internal cost line, not an order item');
}

/** Über einen aktiven (nicht stornierten) Einkauf beschafft? Dieselbe Abfrage wie der Store. */
function sourcedByActivePurchase(lineId: string): boolean {
  return query(
    `SELECT 1 FROM purchase_lines pl JOIN purchases p ON p.id = pl.purchase_id
      WHERE pl.source_order_line_id = ? AND p.status != 'CANCELLED' LIMIT 1`,
    [lineId],
  ).length > 0;
}

function nonConvertedPaid(orderId: string): number {
  return num(query(
    'SELECT COALESCE(SUM(amount), 0) AS t FROM order_payments WHERE order_id = ? AND COALESCE(converted_to_invoice, 0) = 0',
    [orderId],
  )[0]?.t);
}

function lineExpenseIds(orderId: string): Set<string> {
  return new Set(query('SELECT expense_id FROM order_lines WHERE order_id = ? AND expense_id IS NOT NULL', [orderId])
    .map((r) => str(r.expense_id)));
}

// ══ 1) „Cancel Order" ═════════════════════════════════════════════════════

export interface OrderCancelRequest {
  orderId: string;
  expectedRevision?: number;
  choice: OrderCancelChoice;
  refundMethod?: OrderRefundMethod;
  note?: string;
}

export interface OrderCancelResult {
  orderId: string;
  status: string;
  choice: OrderCancelChoice;
  refundMethod?: OrderRefundMethod;
  settledAmount: number;
  customerCreditId?: string;
  stockProductId?: string;
  freedProductId?: string;
  cancelledGoldPayableIds: string[];
  openExpenseIds: string[];
  revision: number;
}

/**
 * Die Wahl der Maske — dieselbe Regel auf beiden Seiten. Die Maske schickt den Zahlweg nur zur
 * Rückzahlung und die Notiz nur zum Guthaben; mehr gibt es dort nicht zu wählen.
 */
export function assertOrderCancelChoice(req: Pick<OrderCancelRequest, 'choice' | 'refundMethod' | 'note'>): void {
  if (!(ORDER_CANCEL_CHOICES as readonly string[]).includes(req.choice)) {
    nein('CANCEL_CHOICE_INVALID', `the paid amount is refunded, kept as credit or forfeited (got ${String(req.choice)})`);
  }
  if (req.choice === 'refund') {
    if (!req.refundMethod) nein('REFUND_METHOD_REQUIRED', 'a refund needs a payment method (cash / bank / benefit)');
    if (!(ORDER_REFUND_METHODS as readonly string[]).includes(String(req.refundMethod))) {
      nein('REFUND_METHOD_INVALID', `unknown refund method: ${String(req.refundMethod)}`);
    }
  } else if (req.refundMethod !== undefined) {
    nein('CANCEL_FIELD_NOT_APPLICABLE', 'a refund method belongs to a refund');
  }
  if (req.note !== undefined && req.choice !== 'credit') nein('CANCEL_FIELD_NOT_APPLICABLE', 'the note belongs to a store credit');
}

/**
 * „Cancel Order": das erhaltene Geld nach Wahl (Rückzahlung / Guthaben / Verfall), die Überzahlungs-
 * Gutschrift abgebaut, offene Gold-Verbindlichkeiten storniert, der Lieferanten-Marker entfernt, ein
 * reservierter Artikel wieder frei, ein angefangenes Sonderstück als Lagerartikel, Positionen und
 * Auftrag CANCELLED — alles in EINER Klammer. Beträge rechnet der Store selbst; die Maske wählt nur.
 */
export function cancelOrderInHouse(req: OrderCancelRequest, branchId: string): OrderCancelResult {
  const o = liveOrder(req.orderId, branchId);
  assertSeen(o, req.expectedRevision);
  const status = str(o.status);
  if (status === 'cancelled') nein('ORDER_ALREADY_CANCELLED', 'this order is already cancelled');
  // Die Maske bietet „Cancel Order" nur für einen laufenden Auftrag an (nicht storniert, nicht abgeschlossen).
  if (status === 'completed') nein('ORDER_NOT_CANCELLABLE', 'a completed order is not cancelled');
  assertOrderCancelChoice(req);
  if (num(query('SELECT COUNT(*) AS n FROM order_lines WHERE order_id = ? AND invoice_id IS NOT NULL', [req.orderId])[0]?.n) > 0) {
    nein('ORDER_LINES_INVOICED', 'at least one line is already on an invoice — cancel the invoice first');
  }
  // Slice 4a — dieselbe Sperre wie der Teardown im Store, nur VOR dem ersten Schreiben und mit Code.
  if (query("SELECT 1 FROM customer_credits WHERE source_type = 'order_overpayment' AND source_id = ? AND used_amount > 0.005 LIMIT 1", [req.orderId]).length > 0) {
    nein('ORDER_OVERPAY_CREDIT_USED',
      'Cannot cancel this order because the store credit from its overpayment has already been used. Reverse that credit usage first.');
  }
  const check = watchLedgerPosts('orders.cancel');
  const fx = useOrderStore.getState().cancelOrderWithMoney(req.orderId, req.choice, req.refundMethod, req.note);
  check();
  const after = liveOrder(req.orderId, branchId);
  if (str(after.status) !== 'cancelled') throw new Error('orders.cancel: the order is not cancelled');
  if (query("SELECT 1 FROM order_lines WHERE order_id = ? AND status != 'CANCELLED' LIMIT 1", [req.orderId]).length > 0) {
    throw new Error('orders.cancel: a line of the order is not cancelled');
  }
  return {
    orderId: req.orderId,
    status: str(after.status),
    choice: req.choice,
    ...(req.refundMethod ? { refundMethod: req.refundMethod } : {}),
    settledAmount: fx.settledAmount,
    ...(fx.customerCreditId ? { customerCreditId: fx.customerCreditId } : {}),
    ...(fx.stockProductId ? { stockProductId: fx.stockProductId } : {}),
    ...(fx.freedProductId ? { freedProductId: fx.freedProductId } : {}),
    cancelledGoldPayableIds: fx.cancelledGoldPayableIds,
    openExpenseIds: fx.openExpenseIds,
    revision: num(after.revision),
  };
}

// ══ 2) Eine Position weiterschalten ═══════════════════════════════════════

export interface OrderLineStatusRequest {
  orderId: string;
  lineId: string;
  status: OrderLineStatusTarget;
  expectedRevision?: number;
}

export interface OrderLineStatusResult {
  orderId: string;
  lineId: string;
  status: string;
  previousStatus: string;
  orderStatus: string;
  bookedExpenseIds: string[];
  revision: number;
}

/**
 * Ein Statusknopf der Positionskarte — EIN Übergang mit geprüftem Ziel. Bei ARRIVED/DELIVERED bucht
 * das Haus (`commitOrderLineExpenses`) die Lieferanten-A/P jeder angekommenen Position mit Kosten;
 * scheitert sie, gibt es auch den Status nicht. Der Auftragsstatus folgt aus den Positionen.
 */
export function setOrderLineStatusInHouse(req: OrderLineStatusRequest, branchId: string): OrderLineStatusResult {
  const o = liveOrder(req.orderId, branchId);
  assertSeen(o, req.expectedRevision);
  if (str(o.status) === 'cancelled') nein('ORDER_CANCELLED', 'this order is cancelled — its lines stay as they are');
  const line = liveLine(req.orderId, req.lineId);
  assertCustomerLine(line);
  if (!(ORDER_LINE_STATUS_TARGETS as readonly string[]).includes(req.status)) {
    nein('LINE_STATUS_INVALID', `a line goes to PENDING, ARRIVED or DELIVERED (got ${String(req.status)})`);
  }
  const current = str(line.status) || 'PENDING';
  // Eine stornierte Position hat in der Karte keine Knöpfe mehr.
  if (current === 'CANCELLED') nein('LINE_CANCELLED', 'this line is cancelled');
  if (current === req.status) nein('LINE_STATUS_UNCHANGED', `this line is already ${current}`);
  // v0.6.8 — eine beim Lieferanten bestellte Position kommt über den Wareneingang (Einkauf: Kosten,
  // Lager, A/P) an; die Karte bietet dort nur „↺ Undo" (zurück auf PENDING).
  if (current === 'ORDERED' && req.status !== 'PENDING') {
    nein('LINE_ORDERED_NEEDS_RECEIPT',
      'this line is ordered from the supplier — record the goods receipt (purchase) instead; a manual ARRIVED is locked');
  }
  const vorher = lineExpenseIds(req.orderId);
  const check = watchLedgerPosts('orders.update_line_status');
  useOrderStore.getState().updateOrderLineStatus(req.lineId, req.status);
  check();
  if (str(liveLine(req.orderId, req.lineId).status) !== req.status) {
    throw new Error('orders.update_line_status: the line status was not applied');
  }
  if (req.status === 'ARRIVED' || req.status === 'DELIVERED') {
    // Der Store fängt einen Fehler der A/P-Buchung ab und protokolliert nur. Hier ist er ein Abbruch:
    // eine angekommene Position mit Lieferantenkosten ohne Ausgabe wäre eine vergessene Schuld.
    const offen = query(
      `SELECT 1 FROM order_lines WHERE order_id = ? AND supplier_id IS NOT NULL AND expense_id IS NULL
          AND cost_amount > 0 AND status IN ('ARRIVED', 'DELIVERED') LIMIT 1`,
      [req.orderId],
    );
    if (offen.length > 0) throw new Error('orders.update_line_status: the supplier cost of an arrived line was not booked — the whole action is undone');
  }
  const after = liveOrder(req.orderId, branchId);
  return {
    orderId: req.orderId,
    lineId: req.lineId,
    status: req.status,
    previousStatus: current,
    orderStatus: str(after.status),
    bookedExpenseIds: [...lineExpenseIds(req.orderId)].filter((x) => !vorher.has(x)),
    revision: num(after.revision),
  };
}

// ══ 3) „⚠ Beim Supplier bestellen" ════════════════════════════════════════

export interface OrderLineOrderedRequest {
  orderId: string;
  lineId: string;
  /** Leer = „Supplier waehlen — oder leer lassen". */
  supplierId?: string;
  expectedRevision?: number;
}

export interface OrderLineOrderedResult {
  orderId: string;
  lineId: string;
  status: string;
  supplierId: string | null;
  orderStatus: string;
  revision: number;
}

/**
 * Ein reiner Marker (Back-to-Back): Status ORDERED und der geplante Lieferant, nach dem der Wareneingang
 * gruppiert. Kein Geld, kein Lager, keine Verbindlichkeit — die entstehen erst mit dem Einkauf. Die
 * Regeln sind die des Knopfs: eine offene Produktposition ohne Rechnung und ohne Beschaffung.
 */
export function markOrderLineOrderedInHouse(req: OrderLineOrderedRequest, branchId: string): OrderLineOrderedResult {
  const o = liveOrder(req.orderId, branchId);
  assertSeen(o, req.expectedRevision);
  if (str(o.status) === 'cancelled') nein('ORDER_CANCELLED', 'this order is cancelled — its lines stay as they are');
  const line = liveLine(req.orderId, req.lineId);
  assertCustomerLine(line);
  if (str(line.material_kind)) nein('LINE_NOT_A_PRODUCT_LINE', 'only an article line is ordered from a supplier');
  if (str(line.invoice_id)) nein('LINE_INVOICED', 'Diese Position ist bereits in einer Invoice.');
  if ((str(line.status) || 'PENDING') !== 'PENDING') nein('LINE_NOT_PENDING', `this line is ${str(line.status)} — only an open line is ordered`);
  if (sourcedByActivePurchase(req.lineId)) nein('LINE_ALREADY_SOURCED', 'this line is already sourced through a purchase');
  const supplierId = req.supplierId || undefined;
  // Die Auswahl der Maske zeigt nur aktive Lieferanten dieser Filiale.
  if (supplierId && !query('SELECT 1 FROM suppliers WHERE id = ? AND branch_id = ? AND COALESCE(active, 1) = 1', [supplierId, branchId])[0]) {
    nein('SUPPLIER_NOT_FOUND', 'no such active supplier in this branch');
  }
  useOrderStore.getState().markOrderLineOrdered(req.lineId, supplierId);
  const nach = liveLine(req.orderId, req.lineId);
  if (str(nach.status) !== 'ORDERED') throw new Error('orders.mark_line_ordered: the line is not ORDERED');
  const after = liveOrder(req.orderId, branchId);
  return {
    orderId: req.orderId, lineId: req.lineId, status: 'ORDERED',
    supplierId: str(nach.ordered_supplier_id) || null,
    orderStatus: str(after.status), revision: num(after.revision),
  };
}

// ══ 4) Eine Position ändern ═══════════════════════════════════════════════

export interface OrderLineEditRequest {
  orderId: string;
  lineId: string;
  expectedRevision?: number;
  description?: string;
  quantity?: number;
  unitPrice?: number;
  /** Ein vorhandener Artikel … */
  productId?: string;
  /** … oder ein neuer aus der Maske „New Product" (dieselben Felder wie beim Anlegen des Auftrags). */
  newProduct?: Partial<Product>;
}

export interface OrderLineEditResult {
  orderId: string;
  lineId: string;
  productId: string | null;
  createdProductId?: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  agreedPrice: number | null;
  remainingAmount: number | null;
  expectedMargin: number | null;
  revision: number;
}

/**
 * „Speichern" im Positionsdialog: Beschreibung, Menge, Preis und ggf. der Artikel (vorhanden oder neu).
 * Summe der Zeile, vereinbarter Preis, Rest und Marge rechnet das Haus — mit derselben Ableitung wie
 * „Save" der Auftragsseite (`planOrderEdit`); eine Überzahlung über den neuen Preis wird wie bei jeder
 * Zahlung Store-Guthaben (Slice 4a). Ein neuer Artikel entsteht in DERSELBEN Klammer.
 */
export function updateOrderLineInHouse(req: OrderLineEditRequest, branchId: string): OrderLineEditResult {
  const o = liveOrder(req.orderId, branchId);
  assertSeen(o, req.expectedRevision);
  if (str(o.status) === 'cancelled') nein('ORDER_CANCELLED', 'this order is cancelled — its lines stay as they are');
  const line = liveLine(req.orderId, req.lineId);
  assertCustomerLine(line);
  if (str(line.status) === 'CANCELLED') nein('LINE_CANCELLED', 'this line is cancelled');
  if (str(line.invoice_id)) nein('LINE_INVOICED', 'Diese Position ist bereits in einer Invoice — erst die Invoice stornieren.');
  if (req.quantity !== undefined && (!Number.isInteger(req.quantity) || req.quantity < 1)) {
    nein('LINE_QUANTITY_INVALID', 'the quantity is a whole number of at least 1');
  }
  if (req.unitPrice !== undefined && (typeof req.unitPrice !== 'number' || !Number.isFinite(req.unitPrice) || req.unitPrice < 0)) {
    nein('LINE_PRICE_INVALID', 'the price must be a number of at least 0');
  }
  if (req.description !== undefined && typeof req.description !== 'string') nein('LINE_DESCRIPTION_INVALID', 'the description is text');
  if (req.productId !== undefined && req.newProduct !== undefined) {
    nein('LINE_PRODUCT_AMBIGUOUS', 'an existing article OR a new one — not both');
  }
  if ([req.description, req.quantity, req.unitPrice, req.productId, req.newProduct].every((v) => v === undefined)) {
    nein('LINE_EDIT_EMPTY', 'an edit must change something');
  }
  const wantsProduct = req.productId !== undefined || req.newProduct !== undefined;
  if (wantsProduct && sourcedByActivePurchase(req.lineId)) {
    nein('LINE_ALREADY_SOURCED', 'Diese Position wurde bereits beim Supplier beschafft — Produkt erst nach Storno des Purchase aenderbar.');
  }
  const port = houseOrderPort(branchId);
  if (req.productId !== undefined && !port.product(req.productId)) nein('PRODUCT_NOT_FOUND', 'no such product in this branch');
  let newProduct: Partial<Product> | undefined;
  if (req.newProduct !== undefined) {
    try {
      newProduct = checkEmbeddedProduct(pickProductSpec(req.newProduct, EMBEDDED_PRODUCT_FIELDS) ?? {}, port);
    } catch (e) {
      if (e instanceof EmbeddedProductRejected) nein(e.code, e.message);
      throw e;
    }
  }

  // Der Preis, der NACH der Änderung gilt — dieselbe Summe, die der Store bildet (kundenseitige Zeilen).
  const qty = req.quantity ?? (num(line.quantity) || 1);
  const price = req.unitPrice ?? num(line.unit_price);
  const lineTotal = req.quantity !== undefined || req.unitPrice !== undefined ? Math.max(1, qty) * price : num(line.line_total);
  const others = num(query(
    'SELECT COALESCE(SUM(line_total), 0) AS t FROM order_lines WHERE order_id = ? AND id != ? AND COALESCE(is_customer_facing, 1) = 1',
    [req.orderId, req.lineId],
  )[0]?.t);
  const agreedAfter = round3(others + lineTotal);
  // Slice 4a — eine schon (teil-)eingelöste Überzahlungs-Gutschrift wird nie still umgebucht
  // (dieselbe Regel wie `assertOrderOverpayMutable` bei den Zahlungen, hier für den neuen Preis).
  const credit = query("SELECT amount, used_amount FROM customer_credits WHERE source_type = 'order_overpayment' AND source_id = ?", [req.orderId])[0];
  if (credit && num(credit.used_amount) > 0.005) {
    const newOver = Math.max(0, round3(nonConvertedPaid(req.orderId) - agreedAfter));
    if (Math.abs(newOver - num(credit.amount)) > 0.005) {
      nein('ORDER_OVERPAY_CREDIT_USED',
        'Cannot change this price: the store credit from the overpayment of this order has already been (partially) redeemed. Reverse the credit usage first.');
    }
  }

  const patch: { productId?: string; newProduct?: Partial<Product>; description?: string; quantity?: number; unitPrice?: number } = {};
  if (req.description !== undefined) patch.description = req.description;
  if (req.quantity !== undefined) patch.quantity = req.quantity;
  if (req.unitPrice !== undefined) patch.unitPrice = req.unitPrice;
  if (req.productId !== undefined) patch.productId = req.productId;
  if (newProduct) patch.newProduct = newProduct;

  const agreedBefore = o.agreed_price === null || o.agreed_price === undefined ? null : num(o.agreed_price);
  const check = watchLedgerPosts('orders.update_line');
  useOrderStore.getState().updateOrderLine(req.lineId, patch);
  const nach = liveLine(req.orderId, req.lineId);
  const head = liveOrder(req.orderId, branchId);
  const agreedNow = head.agreed_price === null || head.agreed_price === undefined ? null : num(head.agreed_price);
  let remainingAmount = query('SELECT remaining_amount FROM orders WHERE id = ?', [req.orderId])[0]?.remaining_amount as number | null;
  let expectedMargin = query('SELECT expected_margin FROM orders WHERE id = ?', [req.orderId])[0]?.expected_margin as number | null;
  if (agreedNow !== agreedBefore) {
    // Rest und Marge folgen dem neuen Preis — wortgleich zu „Save" (Preis − Anzahlung, Preis − Einkauf).
    const plan = planOrderEdit({
      agreedPrice: agreedNow,
      depositAmount: head.deposit_amount === null || head.deposit_amount === undefined ? null : num(head.deposit_amount),
      supplierPrice: head.supplier_price === null || head.supplier_price === undefined ? null : num(head.supplier_price),
      supplierName: null, expectedDelivery: null, notes: null,
    });
    remainingAmount = plan.patch.remainingAmount as number;
    expectedMargin = (plan.patch.expectedMargin as number | null) ?? null;
    getDatabase().run('UPDATE orders SET remaining_amount = ?, expected_margin = ? WHERE id = ?',
      [remainingAmount, expectedMargin, req.orderId]);
    trackUpdate('orders', req.orderId, { remainingAmount, expectedMargin });
    // Ein Überschuss über den neuen Preis wird Store-Guthaben (oder fällt weg) — derselbe Weg wie
    // nach jeder Zahlung.
    reconcileOrderOverpayCredit(req.orderId);
  }
  check();
  const productId = str(nach.product_id) || null;
  return {
    orderId: req.orderId,
    lineId: req.lineId,
    productId,
    ...(newProduct && productId ? { createdProductId: productId } : {}),
    quantity: num(nach.quantity),
    unitPrice: num(nach.unit_price),
    lineTotal: num(nach.line_total),
    agreedPrice: agreedNow,
    remainingAmount: remainingAmount === null || remainingAmount === undefined ? null : num(remainingAmount),
    expectedMargin: expectedMargin === null || expectedMargin === undefined ? null : num(expectedMargin),
    revision: num(liveOrder(req.orderId, branchId).revision),
  };
}

// ── Die Rümpfe für PC2 — genau die Wahl der Masken ──────────────────────────

function compact(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

export function orderCancelBody(req: OrderCancelRequest): Record<string, unknown> {
  return compact({
    orderId: req.orderId, expectedRevision: req.expectedRevision, choice: req.choice,
    refundMethod: req.refundMethod, note: req.note,
  });
}

export function orderLineStatusBody(req: OrderLineStatusRequest): Record<string, unknown> {
  return compact({ orderId: req.orderId, lineId: req.lineId, status: req.status, expectedRevision: req.expectedRevision });
}

export function orderLineOrderedBody(req: OrderLineOrderedRequest): Record<string, unknown> {
  return compact({ orderId: req.orderId, lineId: req.lineId, supplierId: req.supplierId || undefined, expectedRevision: req.expectedRevision });
}

/** Der Rumpf von „Speichern" — die Fotos eines neuen Artikels reisen als Kennungen der Zwischenablage. */
export async function orderLineEditBody(
  req: OrderLineEditRequest, stage: (urls: readonly string[]) => Promise<string[]>,
): Promise<Record<string, unknown>> {
  const body = compact({
    orderId: req.orderId, lineId: req.lineId, expectedRevision: req.expectedRevision,
    description: req.description, quantity: req.quantity, unitPrice: req.unitPrice, productId: req.productId,
  });
  if (req.newProduct) body.newProduct = await stageSpecImages(pickProductSpec(req.newProduct, EMBEDDED_PRODUCT_FIELDS), stage);
  return body;
}

// ── Die Maske des Primary ─────────────────────────────────────────────────

/**
 * In wessen Büchern am Primary gehandelt wird. Auf einem verbundenen Client gibt es hier NICHTS
 * lokal zu tun — die Maske geht dort über den Fernbefehl; ein Aufruf ist ein Nein, bevor die
 * Datenbank gefragt wird.
 */
function primaryBranch(what: string): string {
  if (readsFromPrimary()) {
    nein('CLIENT_WRITE_UNSUPPORTED', `${what} runs on the primary — a connected client sends it as a command`);
  }
  const branchId = currentBranchId();
  if (!branchId) nein('BRANCH_MISSING', 'no branch in this session');
  return branchId;
}

/** Die Listen, die die Auftragsseite danach zeigt — auch nach einem Rollback. */
function frischLesen(): void {
  useOrderStore.getState().loadOrders();
  useProductStore.getState().loadProducts();
  useCustomerStore.getState().loadCustomers();
  try { useGoldStore.getState().loadGoldPayables(); } catch { /* kein Goldmodul geladen */ }
  try { useExpenseStore.getState().loadExpenses(); } catch { /* keine Ausgabenliste geladen */ }
}

export async function cancelOrderOnPrimary(req: OrderCancelRequest): Promise<OrderCancelResult> {
  const branchId = primaryBranch('cancelling an order');
  return runOnPrimary(() => cancelOrderInHouse(req, branchId), frischLesen);
}

export async function setOrderLineStatusOnPrimary(req: OrderLineStatusRequest): Promise<OrderLineStatusResult> {
  const branchId = primaryBranch('changing an order line status');
  return runOnPrimary(() => setOrderLineStatusInHouse(req, branchId), frischLesen);
}

export async function markOrderLineOrderedOnPrimary(req: OrderLineOrderedRequest): Promise<OrderLineOrderedResult> {
  const branchId = primaryBranch('marking an order line as ordered');
  return runOnPrimary(() => markOrderLineOrderedInHouse(req, branchId), frischLesen);
}

export async function updateOrderLineOnPrimary(req: OrderLineEditRequest): Promise<OrderLineEditResult> {
  const branchId = primaryBranch('editing an order line');
  return runOnPrimary(() => updateOrderLineInHouse(req, branchId), frischLesen);
}
