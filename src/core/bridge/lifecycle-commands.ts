// CENTRAL-C3H — die zwölf Lebenszyklus-Aktionen, die den normalen Betrieb erst vollständig
// machen: Auftrag (3), Kommission (2), Reparatur (5), Agenten-Transfer → Rechnung (2).
//
// C3G hat sie ausdrücklich als `B_DEFERRED` klassifiziert und nicht halb gebaut. Der Befund
// dort war unangenehm konkret: **`orders.convert_to_invoice` war freigegeben, aber das Tor
// davor nicht.** Ein zweiter Rechner konnte einen Auftrag anlegen und ihn umwandeln — aber nicht
// auf „angekommen" setzen, und ohne das gibt es keine abrechenbare Position. Der freigegebene
// Weg endete in einer Sackgasse. Genau diese Sackgassen macht dieser Schnitt zu.
//
// Was für alle zwölf gilt — dieselben Zusagen wie in C3E/C3F/C3G:
//
//  1. **Es wird nichts nachgebaut.** Jede Operation ruft die Funktion, die auch der Mensch am
//     Primary auslöst. Lieferanten-Verbindlichkeiten, Kapitalisierung auf den Artikel,
//     Steuerschema, Nummernkreise, Bestandswirkung, Auszahlungsmodell, Guthaben aus
//     Überzahlung: alles bleibt dort.
//  2. **Kein freier Zielzustand.** Weder `orders.update_status` noch `repairs.update_status`
//     nimmt einen beliebigen Status entgegen. Beide fragen dieselbe geteilte Ableitung, die
//     auch die Bildschirme des Primary benutzen (`order-status-flow`, `repair-status-flow`) —
//     ein Sprung von „bestellt" direkt auf „abgeschlossen" überspränge die Stufe, an der die
//     Verbindlichkeiten gebucht werden.
//  3. **Der Store liest seine EIGENE Liste.** `updateStatus` (beide), `recordSale`,
//     `markReturned`, `createCombinedRepairInvoice`, `updateRepairLine`, `cancelRepairLine` und
//     beide Umwandlungen schlagen ihren Vorgang in der geladenen Liste ihres Stores nach. Ohne
//     ein `loadX()` davor täten sie STILL nichts. Dieselbe Fehlerklasse hat in C3G die
//     Forderung aus einem Agentenverkauf verschluckt; sie wird hier nicht wiederholt.
//  4. **Ändern braucht die gesehene FASSUNG**, verglichen INNERHALB der Transaktion.

import { query } from '@/core/db/helpers';
import { nextOrderStatus, isAllowedOrderAdvance } from '@/core/orders/order-status-flow';
import { allowedRepairStatusTargets } from '@/core/repairs/repair-status-flow';
import { useOrderStore } from '@/stores/orderStore';
import { useOrderPaymentStore } from '@/stores/orderPaymentStore';
import { useConsignmentStore } from '@/stores/consignmentStore';
import { useRepairStore } from '@/stores/repairStore';
import { useAgentStore } from '@/stores/agentStore';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { useProductStore } from '@/stores/productStore';
import { useCustomerStore } from '@/stores/customerStore';
import { useSupplierStore } from '@/stores/supplierStore';
import {
  CommandNotEvaluated, CommandRejected, runRemoteCommand, type CommandOutcome, type EngineDeps,
} from './mutation-engine';
import type { CommandIdentity } from './command-ledger';
import { registerCommand, type CommandActor } from './command-registry';
import {
  FinancialPayloadError, assertRevision, execFinancial, expectedRevisionOf,
  invoiceState, isPlain, onlyKnownFields, optString, positive, reqString,
} from './financial-commands';
import type { OrderStatus, RepairStatus } from '@/core/models/types';

export const OP_ORDERS_UPDATE_STATUS = 'orders.update_status';
export const OP_ORDERS_ADD_PAYMENT = 'orders.add_payment';
export const OP_ORDERS_DELETE_PAYMENT = 'orders.delete_payment';
export const OP_CONSIGNMENTS_RECORD_SALE = 'consignments.record_sale';
export const OP_CONSIGNMENTS_MARK_RETURNED = 'consignments.mark_returned';
export const OP_REPAIRS_UPDATE_STATUS = 'repairs.update_status';
export const OP_REPAIRS_CREATE_INVOICE = 'repairs.create_invoice';
export const OP_REPAIRS_ADD_LINE = 'repairs.add_line';
export const OP_REPAIRS_UPDATE_LINE = 'repairs.update_line';
export const OP_REPAIRS_CANCEL_LINE = 'repairs.cancel_line';
export const OP_TRANSFERS_CONVERT_TO_INVOICE = 'transfers.convert_to_invoice';
export const OP_TRANSFERS_CONVERT_MANY_TO_INVOICE = 'transfers.convert_many_to_invoice';

/** Die zwölf Namen dieses Schnitts — dieselbe Liste kennt auch Rust. */
export const C3H_LIFECYCLE_MUTATIONS = [
  OP_ORDERS_UPDATE_STATUS, OP_ORDERS_ADD_PAYMENT, OP_ORDERS_DELETE_PAYMENT,
  OP_CONSIGNMENTS_RECORD_SALE, OP_CONSIGNMENTS_MARK_RETURNED,
  OP_REPAIRS_UPDATE_STATUS, OP_REPAIRS_CREATE_INVOICE,
  OP_REPAIRS_ADD_LINE, OP_REPAIRS_UPDATE_LINE, OP_REPAIRS_CANCEL_LINE,
  OP_TRANSFERS_CONVERT_TO_INVOICE, OP_TRANSFERS_CONVERT_MANY_TO_INVOICE,
] as const;

const n = (v: unknown): number => Number(v ?? 0);
const s = (v: unknown): string => String(v ?? '');

// ══ AUFTRAG ═══════════════════════════════════════════════════════════════

/** Der Auftragszustand, wie ihn auch der Lesebefehl zeigt — vom Primary gerechnet. */
export function orderState(id: string): Record<string, unknown> {
  const r = query(
    'SELECT id, order_number, status, agreed_price, deposit_amount, remaining_amount, fully_paid, '
    + 'invoice_id, revision FROM orders WHERE id = ?', [id],
  )[0];
  const paid = query(
    'SELECT COALESCE(SUM(amount), 0) AS s FROM order_payments WHERE order_id = ? AND COALESCE(converted_to_invoice, 0) = 0',
    [id],
  )[0];
  return {
    orderId: id,
    orderNumber: s(r?.order_number),
    status: s(r?.status),
    agreedPrice: n(r?.agreed_price),
    depositAmount: n(r?.deposit_amount),
    remainingAmount: n(r?.remaining_amount),
    fullyPaid: Number(r?.fully_paid ?? 0) === 1,
    paidAmount: n(paid?.s),
    invoiceId: s(r?.invoice_id),
    // Was als nächstes ginge — dieselbe Ableitung, die auch der Bildschirm benutzt.
    nextStatus: nextOrderStatus(s(r?.status)) ?? '',
    revision: n(r?.revision),
  };
}

function liveOrder(id: string, branchId: string): Record<string, unknown> {
  const o = query('SELECT id, status, customer_id, invoice_id FROM orders WHERE id = ? AND branch_id = ?', [id, branchId])[0];
  if (!o) throw new CommandRejected('ORDER_NOT_FOUND', 'no such order in this branch');
  if (s(o.status) === 'cancelled') {
    throw new CommandRejected('ORDER_CANCELLED', 'a cancelled order takes no further action');
  }
  return o;
}

// ── 1) Den Auftrag weiterschalten ─────────────────────────────────────────

export interface UpdateOrderStatusRequest {
  orderId: string;
  status: OrderStatus;
  expectedRevision: number;
}

/**
 * Der Zielzustand ist ein WUNSCH, und er wird gegen den echten Weg geprüft — nicht gesetzt.
 * `cancelled` steht bewusst nicht auf der Liste: ein Auftrag wird nicht weitergeschaltet,
 * sondern storniert, und dabei geht Geld zurück oder verfällt. Das ist eine eigene Entscheidung
 * mit eigener Oberfläche (`cancelOrderWithMoney`), und sie bleibt am Primary.
 */
export function parseUpdateOrderStatus(raw: unknown): UpdateOrderStatusRequest {
  if (!isPlain(raw)) throw new FinancialPayloadError('payload must be an object');
  onlyKnownFields(raw, ['orderId', 'status', 'expectedRevision']);
  const status = s(raw.status);
  if (status === '') throw new FinancialPayloadError('status is required');
  if (status === 'cancelled') {
    throw new FinancialPayloadError(
      'cancelling an order moves money — it is done on the primary, not from here');
  }
  return {
    orderId: reqString(raw.orderId, 'orderId'),
    status: status as OrderStatus,
    expectedRevision: expectedRevisionOf(raw.expectedRevision),
  };
}

export function runUpdateOrderStatus(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseUpdateOrderStatus(raw);
  return runRemoteCommand(deps, identity, () => {
    const o = liveOrder(req.orderId, identity.branchId);
    if (!isAllowedOrderAdvance(s(o.status), req.status)) {
      throw new CommandRejected('ORDER_TRANSITION_NOT_ALLOWED',
        `an order at "${s(o.status)}" does not go to "${req.status}" — the next step is `
        + `"${nextOrderStatus(s(o.status)) ?? '(none)'}"`);
    }
    assertRevision('orders', req.orderId, req.expectedRevision, 'ORDER_NOT_FOUND');
    const os = useOrderStore.getState();
    os.loadOrders();
    // Der Weg des Hauses: Positionen mitziehen, Wareneingang datieren und — an genau dieser
    // Stufe — die Lieferanten-Verbindlichkeiten der angekommenen Positionen buchen.
    os.updateStatus(req.orderId, req.status);
    const after = orderState(req.orderId);
    if (s(after.status) !== req.status) {
      throw new CommandNotEvaluated('ORDER_STATUS_NOT_APPLIED', `status is ${s(after.status)}`);
    }
    useProductStore.getState().loadProducts();
    return after;
  });
}

// ── 2) Eine Anzahlung buchen ──────────────────────────────────────────────

const ORDER_PAYMENT_METHODS = ['cash', 'card', 'bank', 'benefit', 'other'] as const;

export interface AddOrderPaymentRequest {
  orderId: string;
  amount: number;
  method: typeof ORDER_PAYMENT_METHODS[number];
  expectedRevision: number;
  paidAt?: string;
  reference?: string;
  note?: string;
}

export function parseAddOrderPayment(raw: unknown): AddOrderPaymentRequest {
  if (!isPlain(raw)) throw new FinancialPayloadError('payload must be an object');
  onlyKnownFields(raw, ['orderId', 'amount', 'method', 'expectedRevision', 'paidAt', 'reference', 'note']);
  const method = s(raw.method);
  if (!(ORDER_PAYMENT_METHODS as readonly string[]).includes(method)) {
    throw new FinancialPayloadError(`unknown payment method: ${method || '(none)'}`);
  }
  const out: AddOrderPaymentRequest = {
    orderId: reqString(raw.orderId, 'orderId'),
    amount: positive(raw.amount, 'amount'),
    method: method as AddOrderPaymentRequest['method'],
    expectedRevision: expectedRevisionOf(raw.expectedRevision),
  };
  out.paidAt = optString(raw.paidAt, 'paidAt');
  out.reference = optString(raw.reference, 'reference');
  out.note = optString(raw.note, 'note');
  return out;
}

/** Die Urteile, die der Zahlungsweg eines Auftrags wirklich fällt. */
const ORDER_PAY_VERDICTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/already been \(partially\) redeemed|already redeemed/i, 'ORDER_CREDIT_ALREADY_USED'],
  [/positive number/i, 'INVALID_AMOUNT'],
];

function asVerdict(err: unknown, table: ReadonlyArray<readonly [RegExp, string]>): CommandRejected | null {
  const msg = err instanceof Error ? err.message : String(err);
  for (const [pattern, code] of table) if (pattern.test(msg)) return new CommandRejected(code, msg);
  return null;
}

export function runAddOrderPayment(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseAddOrderPayment(raw);
  return runRemoteCommand(deps, identity, () => {
    const o = liveOrder(req.orderId, identity.branchId);
    if (s(o.invoice_id) !== '') {
      // Nach der Umwandlung lebt das Geld in der Rechnung. Eine weitere Anzahlung hier wäre
      // ein zweiter Topf für denselben Vorgang.
      throw new CommandRejected('ORDER_ALREADY_INVOICED',
        'this order is already invoiced — payments go to the invoice now');
    }
    assertRevision('orders', req.orderId, req.expectedRevision, 'ORDER_NOT_FOUND');
    const before = n(orderState(req.orderId).paidAmount);
    const ops = useOrderPaymentStore.getState();
    ops.loadPayments(req.orderId);
    let created: { id: string };
    try {
      // Der Weg des Hauses: buchen, den Auftragssaldo neu ableiten, ins Buch stellen,
      // Kartengebühr rechnen und einen Überschuss über den vereinbarten Preis in Guthaben
      // umwidmen. Nichts davon wird hier gerechnet.
      created = ops.addPayment({
        orderId: req.orderId,
        amount: req.amount,
        method: req.method,
        paidAt: req.paidAt || new Date().toISOString().split('T')[0],
        reference: req.reference,
        note: req.note,
      });
    } catch (err) {
      const verdict = asVerdict(err, ORDER_PAY_VERDICTS);
      if (verdict) throw verdict;
      throw err;
    }
    const after = orderState(req.orderId);
    if (n(after.paidAmount) <= before) {
      throw new CommandNotEvaluated('ORDER_PAYMENT_NOT_APPLIED', 'nothing was booked');
    }
    useOrderStore.getState().loadOrders();
    return { ...after, paymentId: created.id, appliedAmount: n(after.paidAmount) - before };
  });
}

// ── 3) Eine Anzahlung zurücknehmen ────────────────────────────────────────

export interface DeleteOrderPaymentRequest {
  orderId: string;
  paymentId: string;
  expectedRevision: number;
}

export function parseDeleteOrderPayment(raw: unknown): DeleteOrderPaymentRequest {
  if (!isPlain(raw)) throw new FinancialPayloadError('payload must be an object');
  onlyKnownFields(raw, ['orderId', 'paymentId', 'expectedRevision']);
  return {
    orderId: reqString(raw.orderId, 'orderId'),
    paymentId: reqString(raw.paymentId, 'paymentId'),
    expectedRevision: expectedRevisionOf(raw.expectedRevision),
  };
}

export function runDeleteOrderPayment(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseDeleteOrderPayment(raw);
  return runRemoteCommand(deps, identity, () => {
    liveOrder(req.orderId, identity.branchId);
    const p = query('SELECT id, order_id, converted_to_invoice FROM order_payments WHERE id = ?', [req.paymentId])[0];
    if (!p) throw new CommandRejected('PAYMENT_NOT_FOUND', 'no such order payment');
    if (s(p.order_id) !== req.orderId) {
      throw new CommandRejected('PAYMENT_NOT_ON_ORDER', 'this payment belongs to another order');
    }
    if (Number(p.converted_to_invoice ?? 0) === 1) {
      // Eine übergegangene Anzahlung gehört zur Rechnung. Sie hier zu löschen risse das Geld
      // aus einem Beleg, der es schon ausweist.
      throw new CommandRejected('PAYMENT_ALREADY_CONVERTED',
        'this deposit already moved to the invoice — correct it there');
    }
    assertRevision('orders', req.orderId, req.expectedRevision, 'ORDER_NOT_FOUND');
    const ops = useOrderPaymentStore.getState();
    ops.loadPayments(req.orderId);
    try {
      ops.deletePayment(req.paymentId, req.orderId);
    } catch (err) {
      const verdict = asVerdict(err, ORDER_PAY_VERDICTS);
      if (verdict) throw verdict;
      throw err;
    }
    if (query('SELECT id FROM order_payments WHERE id = ?', [req.paymentId])[0]) {
      throw new CommandNotEvaluated('PAYMENT_DELETE_INCOMPLETE', 'the payment is still there');
    }
    useOrderStore.getState().loadOrders();
    return { ...orderState(req.orderId), deletedPaymentId: req.paymentId };
  });
}

// ══ KOMMISSION ════════════════════════════════════════════════════════════

export function consignmentState(id: string): Record<string, unknown> {
  const r = query(
    'SELECT id, consignment_number, status, sale_price, commission_amount, payout_amount, '
    + 'payout_paid_amount, payout_status, invoice_id, product_id, revision FROM consignments WHERE id = ?', [id],
  )[0];
  const target = n(r?.payout_amount);
  const paid = n(r?.payout_paid_amount);
  return {
    consignmentId: id,
    consignmentNumber: s(r?.consignment_number),
    status: s(r?.status),
    salePrice: n(r?.sale_price),
    commissionAmount: n(r?.commission_amount),
    payoutAmount: target,
    payoutPaidAmount: paid,
    payoutOpenAmount: Math.max(0, target - paid),
    payoutStatus: s(r?.payout_status),
    invoiceId: s(r?.invoice_id),
    revision: n(r?.revision),
  };
}

// ── 4) Den Verkauf melden ─────────────────────────────────────────────────

export interface RecordSaleRequest {
  consignmentId: string;
  buyerId: string;
  salePrice: number;
  expectedRevision: number;
  saleDate?: string;
  notes?: string;
  acknowledgeShortfall?: boolean;
}

/**
 * `specialMark` fehlt mit Absicht. Es wählt bei der erzeugten Rechnung den Nummernkreis — ein
 * steuerlicher Marker, kein Kassenvorgang, und in C3G ausdrücklich als Klasse C am Primary
 * geblieben. Ein Fernverkauf bekommt den regulären Kreis.
 */
export function parseRecordSale(raw: unknown): RecordSaleRequest {
  if (!isPlain(raw)) throw new FinancialPayloadError('payload must be an object');
  onlyKnownFields(raw, ['consignmentId', 'buyerId', 'salePrice', 'expectedRevision', 'saleDate', 'notes', 'acknowledgeShortfall']);
  const out: RecordSaleRequest = {
    consignmentId: reqString(raw.consignmentId, 'consignmentId'),
    buyerId: reqString(raw.buyerId, 'buyerId'),
    salePrice: positive(raw.salePrice, 'salePrice'),
    expectedRevision: expectedRevisionOf(raw.expectedRevision),
  };
  out.saleDate = optString(raw.saleDate, 'saleDate');
  out.notes = optString(raw.notes, 'notes');
  // Dieselbe Bedeutung wie am Bildschirm: ein Verkauf unter dem Boden des Einlieferers
  // erzeugt einen Verlust und braucht eine ausdrückliche Bestätigung. Sie bestätigt genau das.
  out.acknowledgeShortfall = raw.acknowledgeShortfall === true;
  return out;
}

const SALE_VERDICTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/below consignor floor/i, 'SALE_BELOW_FLOOR'],
  [/Buyer cannot be the same as the consignor/i, 'BUYER_IS_CONSIGNOR'],
  [/Unsupported commission type/i, 'UNSUPPORTED_PAYOUT_MODEL'],
  [/cannot record sale/i, 'CONSIGNMENT_NOT_ACTIVE'],
];

export function runRecordSale(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseRecordSale(raw);
  return runRemoteCommand(deps, identity, () => {
    const con = query('SELECT id, status, invoice_id FROM consignments WHERE id = ? AND branch_id = ?',
      [req.consignmentId, identity.branchId])[0];
    if (!con) throw new CommandRejected('CONSIGNMENT_NOT_FOUND', 'no such consignment in this branch');
    if (s(con.status) !== 'active') {
      throw new CommandRejected('CONSIGNMENT_NOT_ACTIVE',
        `this consignment is "${s(con.status)}" — only an active one is sold`);
    }
    if (s(con.invoice_id) !== '') {
      throw new CommandRejected('CONSIGNMENT_ALREADY_SOLD', 'this consignment already has an invoice');
    }
    if (!query('SELECT id FROM customers WHERE id = ? AND branch_id = ?', [req.buyerId, identity.branchId])[0]) {
      throw new CommandRejected('BUYER_NOT_FOUND', 'no such client in this branch');
    }
    assertRevision('consignments', req.consignmentId, req.expectedRevision, 'CONSIGNMENT_NOT_FOUND');
    // Der Store schlägt die Kommission in SEINER Liste nach — und ruft danach den Einkaufs-,
    // den Rechnungs- und ggf. den Ausgabenweg, die es ebenso tun.
    useConsignmentStore.getState().loadConsignments();
    useSupplierStore.getState().loadSuppliers();
    useCustomerStore.getState().loadCustomers();
    useProductStore.getState().loadProducts();
    useInvoiceStore.getState().loadInvoices();
    let result: { invoiceId: string; purchaseId: string; consignorPayout: number; ourCommission: number; consignorLossAmount: number };
    try {
      // Ein Zug des Hauses: Einkauf beim Einlieferer (damit ein Los entsteht), Rechnung an den
      // Käufer (die es verbraucht), bei Unterdeckung eine Verlust-Ausgabe, und der
      // Auszahlungsbetrag, gegen den später `consignments.record_payout` läuft.
      result = useConsignmentStore.getState().recordSale(req.consignmentId, {
        salePrice: req.salePrice,
        buyerId: req.buyerId,
        saleDate: req.saleDate,
        notes: req.notes,
        acknowledgeShortfall: req.acknowledgeShortfall,
      });
    } catch (err) {
      const verdict = asVerdict(err, SALE_VERDICTS);
      if (verdict) throw verdict;
      throw err;
    }
    const after = consignmentState(req.consignmentId);
    if (s(after.status) !== 'sold') {
      throw new CommandNotEvaluated('SALE_NOT_APPLIED', `status is ${s(after.status)}`);
    }
    useProductStore.getState().loadProducts();
    return {
      ...after,
      invoiceId: result.invoiceId,
      purchaseId: result.purchaseId,
      consignorLossAmount: result.consignorLossAmount,
      invoice: invoiceState(result.invoiceId),
    };
  });
}

// ── 5) Unverkauft zurück an den Einlieferer ───────────────────────────────

export interface MarkConsignmentReturnedRequest {
  consignmentId: string;
  expectedRevision: number;
}

export function parseMarkConsignmentReturned(raw: unknown): MarkConsignmentReturnedRequest {
  if (!isPlain(raw)) throw new FinancialPayloadError('payload must be an object');
  onlyKnownFields(raw, ['consignmentId', 'expectedRevision']);
  return {
    consignmentId: reqString(raw.consignmentId, 'consignmentId'),
    expectedRevision: expectedRevisionOf(raw.expectedRevision),
  };
}

export function runMarkConsignmentReturned(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseMarkConsignmentReturned(raw);
  return runRemoteCommand(deps, identity, () => {
    const con = query('SELECT id, status FROM consignments WHERE id = ? AND branch_id = ?',
      [req.consignmentId, identity.branchId])[0];
    if (!con) throw new CommandRejected('CONSIGNMENT_NOT_FOUND', 'no such consignment in this branch');
    // Nur die UNVERKAUFTE Ware geht so zurück. Eine Rückgabe NACH dem Verkauf ist ein anderer
    // Vorgang mit Gutschrift und Storno (`markReturnedAfterSale`) — in C3G als Klasse C am
    // Primary geblieben, und daran ändert dieser Schnitt nichts.
    if (s(con.status) !== 'active') {
      throw new CommandRejected('CONSIGNMENT_NOT_ACTIVE',
        `this consignment is "${s(con.status)}" — only an unsold one is handed back this way`);
    }
    assertRevision('consignments', req.consignmentId, req.expectedRevision, 'CONSIGNMENT_NOT_FOUND');
    useConsignmentStore.getState().loadConsignments();
    useConsignmentStore.getState().markReturned(req.consignmentId);
    const after = consignmentState(req.consignmentId);
    if (s(after.status) !== 'returned') {
      throw new CommandNotEvaluated('RETURN_NOT_APPLIED', `status is ${s(after.status)}`);
    }
    useProductStore.getState().loadProducts();
    const prod = query('SELECT stock_status FROM products WHERE id = ?',
      [s(query('SELECT product_id FROM consignments WHERE id = ?', [req.consignmentId])[0]?.product_id)])[0];
    return { ...after, productStockStatus: s(prod?.stock_status) };
  });
}

// ══ REPARATUR ═════════════════════════════════════════════════════════════

export function repairState(id: string): Record<string, unknown> {
  const r = query(
    'SELECT id, repair_number, status, repair_type, repair_scope, internal_cost, charge_to_customer, '
    + 'margin, invoice_id, tax_scheme, revision FROM repairs WHERE id = ?', [id],
  )[0];
  const lineTotal = query(
    "SELECT COALESCE(SUM(cost_amount), 0) AS t FROM repair_lines WHERE repair_id = ? AND status = 'OPEN'", [id],
  )[0];
  return {
    repairId: id,
    repairNumber: s(r?.repair_number),
    status: s(r?.status),
    repairType: s(r?.repair_type),
    repairScope: s(r?.repair_scope),
    internalCost: n(r?.internal_cost),
    openLineTotal: n(lineTotal?.t),
    chargeToCustomer: n(r?.charge_to_customer),
    margin: r?.margin === null || r?.margin === undefined ? null : n(r.margin),
    invoiceId: s(r?.invoice_id),
    taxScheme: s(r?.tax_scheme),
    // Welche Schritte von hier aus wirklich gingen — dieselbe Ableitung wie am Bildschirm.
    allowedStatusTargets: allowedRepairStatusTargets(s(r?.status), s(r?.repair_type), s(r?.repair_scope)),
    revision: n(r?.revision),
  };
}

function liveRepair(id: string, branchId: string): Record<string, unknown> {
  const r = query('SELECT id, status, repair_type, repair_scope, invoice_id, charge_to_customer, customer_id '
    + 'FROM repairs WHERE id = ? AND branch_id = ?', [id, branchId])[0];
  if (!r) throw new CommandRejected('REPAIR_NOT_FOUND', 'no such repair in this branch');
  return r;
}

// ── 6) Die Reparatur weiterschalten ───────────────────────────────────────

export interface UpdateRepairStatusRequest {
  repairId: string;
  status: RepairStatus;
  expectedRevision: number;
}

export function parseUpdateRepairStatus(raw: unknown): UpdateRepairStatusRequest {
  if (!isPlain(raw)) throw new FinancialPayloadError('payload must be an object');
  onlyKnownFields(raw, ['repairId', 'status', 'expectedRevision']);
  const status = s(raw.status);
  if (status === '') throw new FinancialPayloadError('status is required');
  if (status === 'cancelled' || status === 'CANCELLED') {
    throw new FinancialPayloadError(
      'a repair is not cancelled from here — that path deletes records and stays on the primary');
  }
  return {
    repairId: reqString(raw.repairId, 'repairId'),
    status: status as RepairStatus,
    expectedRevision: expectedRevisionOf(raw.expectedRevision),
  };
}

export function runUpdateRepairStatus(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseUpdateRepairStatus(raw);
  return runRemoteCommand(deps, identity, () => {
    const r = liveRepair(req.repairId, identity.branchId);
    const allowed = allowedRepairStatusTargets(s(r.status), s(r.repair_type), s(r.repair_scope));
    if (!allowed.includes(req.status)) {
      throw new CommandRejected('REPAIR_TRANSITION_NOT_ALLOWED',
        `a repair at "${s(r.status)}" does not go to "${req.status}" — possible: `
        + `${allowed.length ? allowed.join(', ') : '(none, it is finished)'}`);
    }
    assertRevision('repairs', req.repairId, req.expectedRevision, 'REPAIR_NOT_FOUND');
    const rs = useRepairStore.getState();
    rs.loadRepairs();
    rs.loadRepairLines();
    // Der Weg des Hauses: je nach Stufe die Lieferanten-Forderungen der Arbeitszeilen buchen,
    // bei eigener Ware die Kosten auf den Artikel und sein Los kapitalisieren, die Marge
    // ableiten, den Artikel in den Bestand zurückgeben.
    rs.updateStatus(req.repairId, req.status);
    const after = repairState(req.repairId);
    if (s(after.status) !== req.status) {
      throw new CommandNotEvaluated('REPAIR_STATUS_NOT_APPLIED', `status is ${s(after.status)}`);
    }
    useProductStore.getState().loadProducts();
    return after;
  });
}

// ── 7) Die Reparaturrechnung ──────────────────────────────────────────────

export interface CreateRepairInvoiceRequest {
  repairId: string;
  expectedRevision: number;
}

/**
 * Kein Feld außer Kennung und Fassung. Weder Betrag noch Steuerschema noch Nummernkreis: den
 * Betrag trägt die Reparatur (`chargeToCustomer`), das Schema steht an ihr, und die Nummer zieht
 * das Haus. Ein Client, der etwas davon mitschickte, könnte eine Rechnung stellen, die zu einer
 * anderen Reparatur gehört als der, die er gesehen hat.
 */
export function parseCreateRepairInvoice(raw: unknown): CreateRepairInvoiceRequest {
  if (!isPlain(raw)) throw new FinancialPayloadError('payload must be an object');
  onlyKnownFields(raw, ['repairId', 'expectedRevision']);
  return {
    repairId: reqString(raw.repairId, 'repairId'),
    expectedRevision: expectedRevisionOf(raw.expectedRevision),
  };
}

const REPAIR_INVOICE_VERDICTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/already linked to an invoice/i, 'REPAIR_ALREADY_INVOICED'],
  [/is not READY/i, 'REPAIR_NOT_READY'],
  [/has no charge/i, 'REPAIR_HAS_NO_CHARGE'],
];

export function runCreateRepairInvoice(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseCreateRepairInvoice(raw);
  return runRemoteCommand(deps, identity, () => {
    const r = liveRepair(req.repairId, identity.branchId);
    if (s(r.invoice_id) !== '') {
      throw new CommandRejected('REPAIR_ALREADY_INVOICED', 'this repair already has an invoice');
    }
    if (s(r.repair_scope) === 'OWN') {
      // Eigene Ware wird nicht dem Kunden berechnet — ihre Kosten sind auf den Artikel
      // kapitalisiert. Es gibt hier nichts zu fakturieren.
      throw new CommandRejected('REPAIR_IS_OWN_STOCK', 'a repair on our own stock is not invoiced');
    }
    if (!(n(r.charge_to_customer) > 0)) {
      throw new CommandRejected('REPAIR_HAS_NO_CHARGE', 'this repair has no charge to the client');
    }
    if (s(r.customer_id) === '') {
      throw new CommandRejected('REPAIR_HAS_NO_CUSTOMER', 'this repair has no client');
    }
    assertRevision('repairs', req.repairId, req.expectedRevision, 'REPAIR_NOT_FOUND');
    const rs = useRepairStore.getState();
    rs.loadRepairs();
    rs.loadRepairLines();
    let created: { invoiceId: string };
    try {
      // GENAU der Weg des Hauses — mit EINEM Beleg für diese eine Reparatur. Der Einstand der
      // Zeile ist `internalCost + offene Arbeitszeilen`; genau diese Ableitung benutzt seit
      // C3H auch der Einzelweg am Primary, der vorher zu wenig auswies.
      created = rs.createCombinedRepairInvoice([req.repairId]);
    } catch (err) {
      const verdict = asVerdict(err, REPAIR_INVOICE_VERDICTS);
      if (verdict) throw verdict;
      throw err;
    }
    const after = repairState(req.repairId);
    if (s(after.invoiceId) === '') {
      throw new CommandNotEvaluated('REPAIR_INVOICE_NOT_LINKED', 'the repair carries no invoice');
    }
    useInvoiceStore.getState().loadInvoices();
    return { ...after, invoiceId: created.invoiceId, invoice: invoiceState(created.invoiceId) };
  });
}

// ── 8/9/10) Die Arbeitszeilen ─────────────────────────────────────────────

const WORK_TYPES = ['labor', 'polish', 'plating', 'stone', 'diamond', 'gold', 'parts', 'other', 'material'] as const;

export interface AddRepairLineRequest {
  repairId: string;
  costAmount: number;
  expectedRevision: number;
  supplierId?: string;
  workType?: string;
  description?: string;
  dueDate?: string;
  notes?: string;
}

export function parseAddRepairLine(raw: unknown): AddRepairLineRequest {
  if (!isPlain(raw)) throw new FinancialPayloadError('payload must be an object');
  onlyKnownFields(raw, ['repairId', 'costAmount', 'expectedRevision', 'supplierId', 'workType', 'description', 'dueDate', 'notes']);
  const out: AddRepairLineRequest = {
    repairId: reqString(raw.repairId, 'repairId'),
    costAmount: positive(raw.costAmount, 'costAmount'),
    expectedRevision: expectedRevisionOf(raw.expectedRevision),
  };
  out.supplierId = optString(raw.supplierId, 'supplierId');
  if (raw.workType !== undefined) {
    const w = s(raw.workType);
    if (!(WORK_TYPES as readonly string[]).includes(w)) throw new FinancialPayloadError(`unknown work type: ${w}`);
    out.workType = w;
  }
  out.description = optString(raw.description, 'description');
  out.dueDate = optString(raw.dueDate, 'dueDate');
  out.notes = optString(raw.notes, 'notes');
  // `materialDetails` fehlt mit Absicht: Gold- und Steinzeilen hängen an eigenen
  // Gegenkonten (`gold_payables`), die der Bildschirm des Primary mit füllt. Eine halbe
  // Materialzeile aus der Ferne wäre eine Verbindlichkeit ohne Gegenstück.
  return out;
}

function assertLineWritable(repairId: string, branchId: string, expectedRevision: number): void {
  const r = liveRepair(repairId, branchId);
  if (s(r.invoice_id) !== '') {
    throw new CommandRejected('REPAIR_ALREADY_INVOICED',
      'this repair is already invoiced — its cost lines are frozen');
  }
  assertRevision('repairs', repairId, expectedRevision, 'REPAIR_NOT_FOUND');
}

export function runAddRepairLine(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseAddRepairLine(raw);
  return runRemoteCommand(deps, identity, () => {
    assertLineWritable(req.repairId, identity.branchId, req.expectedRevision);
    if (req.supplierId && !query('SELECT id FROM suppliers WHERE id = ?', [req.supplierId])[0]) {
      throw new CommandRejected('SUPPLIER_NOT_FOUND', 'no such supplier');
    }
    const rs = useRepairStore.getState();
    rs.loadRepairs();
    rs.loadRepairLines();
    // Der Weg des Hauses: Zeile anlegen, Position vergeben, Summen der Reparatur neu ableiten
    // und — wenn die Arbeit schon läuft — die Lieferanten-Forderung sofort buchen.
    const line = rs.addRepairLine(req.repairId, {
      supplierId: req.supplierId,
      workType: req.workType as never,
      description: req.description,
      costAmount: req.costAmount,
      dueDate: req.dueDate,
      notes: req.notes,
    });
    return { ...repairState(req.repairId), lineId: line.id };
  });
}

export interface UpdateRepairLineRequest {
  repairId: string;
  lineId: string;
  expectedRevision: number;
  costAmount?: number;
  supplierId?: string;
  workType?: string;
  description?: string;
  dueDate?: string;
  notes?: string;
}

export function parseUpdateRepairLine(raw: unknown): UpdateRepairLineRequest {
  if (!isPlain(raw)) throw new FinancialPayloadError('payload must be an object');
  onlyKnownFields(raw, ['repairId', 'lineId', 'expectedRevision', 'costAmount', 'supplierId', 'workType', 'description', 'dueDate', 'notes']);
  const out: UpdateRepairLineRequest = {
    repairId: reqString(raw.repairId, 'repairId'),
    lineId: reqString(raw.lineId, 'lineId'),
    expectedRevision: expectedRevisionOf(raw.expectedRevision),
  };
  if (raw.costAmount !== undefined) out.costAmount = positive(raw.costAmount, 'costAmount');
  if (raw.supplierId !== undefined) out.supplierId = optString(raw.supplierId, 'supplierId') ?? '';
  if (raw.workType !== undefined) {
    const w = s(raw.workType);
    if (!(WORK_TYPES as readonly string[]).includes(w)) throw new FinancialPayloadError(`unknown work type: ${w}`);
    out.workType = w;
  }
  if (raw.description !== undefined) out.description = optString(raw.description, 'description') ?? '';
  if (raw.dueDate !== undefined) out.dueDate = optString(raw.dueDate, 'dueDate') ?? '';
  if (raw.notes !== undefined) out.notes = optString(raw.notes, 'notes') ?? '';
  // `status` fehlt mit Absicht: eine Zeile wird nicht per Feld storniert, sondern über
  // `repairs.cancel_line` — dort hängen Ausgabe und Buchung mit dran.
  const touched = ['costAmount', 'supplierId', 'workType', 'description', 'dueDate', 'notes']
    .filter((k) => (out as unknown as Record<string, unknown>)[k] !== undefined);
  if (touched.length === 0) throw new FinancialPayloadError('an edit must change something');
  return out;
}

const LINE_EDIT_VERDICTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Zahlung bereits gebucht|Cancel \+ Replace/i, 'LINE_PAYMENT_BOOKED'],
  [/nicht gefunden|not found/i, 'LINE_NOT_FOUND'],
];

function liveRepairLine(lineId: string, repairId: string): Record<string, unknown> {
  const l = query('SELECT id, repair_id, status FROM repair_lines WHERE id = ?', [lineId])[0];
  if (!l) throw new CommandRejected('LINE_NOT_FOUND', 'no such work line');
  if (s(l.repair_id) !== repairId) {
    throw new CommandRejected('LINE_NOT_ON_REPAIR', 'this work line belongs to another repair');
  }
  return l;
}

export function runUpdateRepairLine(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseUpdateRepairLine(raw);
  return runRemoteCommand(deps, identity, () => {
    assertLineWritable(req.repairId, identity.branchId, req.expectedRevision);
    const before = liveRepairLine(req.lineId, req.repairId);
    if (s(before.status) !== 'OPEN') {
      throw new CommandRejected('LINE_NOT_OPEN', `this work line is "${s(before.status)}"`);
    }
    if (req.supplierId && !query('SELECT id FROM suppliers WHERE id = ?', [req.supplierId])[0]) {
      throw new CommandRejected('SUPPLIER_NOT_FOUND', 'no such supplier');
    }
    const rs = useRepairStore.getState();
    rs.loadRepairs();
    // Ohne diese Zeile findet `updateRepairLine` die Zeile in SEINER Liste nicht und wirft —
    // ein Fernauftrag hat keinen Bildschirm, der sie geladen hat.
    rs.loadRepairLines();
    const patch: Record<string, unknown> = {};
    for (const k of ['costAmount', 'supplierId', 'workType', 'description', 'dueDate', 'notes'] as const) {
      if (req[k] !== undefined) patch[k] = req[k];
    }
    try {
      rs.updateRepairLine(req.lineId, patch as never);
    } catch (err) {
      const verdict = asVerdict(err, LINE_EDIT_VERDICTS);
      if (verdict) throw verdict;
      throw err;
    }
    return { ...repairState(req.repairId), lineId: req.lineId };
  });
}

export interface CancelRepairLineRequest {
  repairId: string;
  lineId: string;
  expectedRevision: number;
  notes?: string;
}

export function parseCancelRepairLine(raw: unknown): CancelRepairLineRequest {
  if (!isPlain(raw)) throw new FinancialPayloadError('payload must be an object');
  onlyKnownFields(raw, ['repairId', 'lineId', 'expectedRevision', 'notes']);
  const out: CancelRepairLineRequest = {
    repairId: reqString(raw.repairId, 'repairId'),
    lineId: reqString(raw.lineId, 'lineId'),
    expectedRevision: expectedRevisionOf(raw.expectedRevision),
  };
  out.notes = optString(raw.notes, 'notes');
  return out;
}

export function runCancelRepairLine(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseCancelRepairLine(raw);
  return runRemoteCommand(deps, identity, () => {
    assertLineWritable(req.repairId, identity.branchId, req.expectedRevision);
    liveRepairLine(req.lineId, req.repairId);
    const rs = useRepairStore.getState();
    rs.loadRepairs();
    rs.loadRepairLines();
    try {
      // Der Weg des Hauses: die Zeile verschwindet, und mit ihr ihre Lieferanten-Ausgabe samt
      // Buchung. Das ist kein Löschen eines Belegs — die Reparatur bleibt, was sie war.
      rs.cancelRepairLine(req.lineId, req.notes);
    } catch (err) {
      const verdict = asVerdict(err, LINE_EDIT_VERDICTS);
      if (verdict) throw verdict;
      throw err;
    }
    if (query("SELECT id FROM repair_lines WHERE id = ? AND status = 'OPEN'", [req.lineId])[0]) {
      throw new CommandNotEvaluated('LINE_CANCEL_INCOMPLETE', 'the work line is still open');
    }
    return { ...repairState(req.repairId), cancelledLineId: req.lineId };
  });
}

// ══ AGENTEN-TRANSFER → RECHNUNG ═══════════════════════════════════════════

export function transferState(id: string): Record<string, unknown> {
  const r = query(
    'SELECT id, transfer_number, status, actual_sale_price, settlement_amount, settlement_paid_amount, '
    + 'settlement_status, invoice_id, agent_id, revision FROM agent_transfers WHERE id = ?', [id],
  )[0];
  const total = n(r?.settlement_amount);
  const paid = n(r?.settlement_paid_amount);
  return {
    transferId: id,
    transferNumber: s(r?.transfer_number),
    status: s(r?.status),
    actualSalePrice: n(r?.actual_sale_price),
    settlementAmount: total,
    settlementPaidAmount: paid,
    settlementOpenAmount: Math.max(0, total - paid),
    settlementStatus: s(r?.settlement_status),
    invoiceId: s(r?.invoice_id),
    agentId: s(r?.agent_id),
    revision: n(r?.revision),
  };
}

interface TransferRef { id: string; expectedRevision: number }

function parseTransferRefs(raw: Record<string, unknown>, field: string): TransferRef[] {
  const list = raw[field];
  if (!Array.isArray(list) || list.length === 0) {
    throw new FinancialPayloadError(`${field} must name at least one transfer`);
  }
  const seen = new Set<string>();
  return list.map((t, i) => {
    if (!isPlain(t)) throw new FinancialPayloadError(`${field}[${i}] must be an object`);
    onlyKnownFields(t, ['id', 'expectedRevision']);
    const id = reqString(t.id, `${field}[${i}].id`);
    if (seen.has(id)) throw new FinancialPayloadError(`${field} names ${id} twice`);
    seen.add(id);
    // JEDER Transfer nennt die Fassung, die dieser Client gesehen hat. Eine Sammelrechnung
    // über fünf Vorgänge, von denen sich einer bewegt hat, ist eine andere Rechnung.
    return { id, expectedRevision: expectedRevisionOf(t.expectedRevision) };
  });
}

export interface ConvertTransferRequest {
  transferId: string;
  customerId: string;
  expectedRevision: number;
}

export function parseConvertTransfer(raw: unknown): ConvertTransferRequest {
  if (!isPlain(raw)) throw new FinancialPayloadError('payload must be an object');
  onlyKnownFields(raw, ['transferId', 'customerId', 'expectedRevision']);
  return {
    transferId: reqString(raw.transferId, 'transferId'),
    customerId: reqString(raw.customerId, 'customerId'),
    expectedRevision: expectedRevisionOf(raw.expectedRevision),
  };
}

const CONVERT_VERDICTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/already converted|already was converted|was already converted/i, 'TRANSFER_ALREADY_INVOICED'],
  [/only possible for sold or settled|is not sold/i, 'TRANSFER_NOT_SOLD'],
  [/Settlement amount must be positive/i, 'TRANSFER_NO_SETTLEMENT'],
  [/must belong to the same/i, 'TRANSFERS_NOT_SAME_AGENT'],
];

/** Was für jeden der beiden Wege gleich gilt — geprüft, bevor irgendetwas läuft. */
function assertConvertible(t: TransferRef, branchId: string): Record<string, unknown> {
  const row = query(
    'SELECT id, status, invoice_id, settlement_amount, agent_id FROM agent_transfers WHERE id = ? AND branch_id = ?',
    [t.id, branchId],
  )[0];
  if (!row) throw new CommandRejected('TRANSFER_NOT_FOUND', 'no such transfer in this branch');
  if (s(row.invoice_id) !== '') {
    throw new CommandRejected('TRANSFER_ALREADY_INVOICED', 'this transfer already has an invoice');
  }
  if (s(row.status) !== 'sold' && s(row.status) !== 'settled') {
    throw new CommandRejected('TRANSFER_NOT_SOLD',
      `this transfer is "${s(row.status)}" — only a sold or settled one becomes an invoice`);
  }
  if (!(n(row.settlement_amount) > 0)) {
    throw new CommandRejected('TRANSFER_NO_SETTLEMENT',
      'there is nothing to invoice — the settlement amount is not set');
  }
  assertRevision('agent_transfers', t.id, t.expectedRevision, 'TRANSFER_NOT_FOUND');
  return row;
}

function loadAgentWorld(): void {
  // Beide Umwandlungen schlagen Transfer UND Agent in ihren eigenen Listen nach — der Agent,
  // um die Kundenverknüpfung zu merken. Dieselbe Fehlerklasse hat in C3G die Forderung aus
  // einem Agentenverkauf still verschluckt.
  useAgentStore.getState().loadAgents();
  useAgentStore.getState().loadTransfers();
  useCustomerStore.getState().loadCustomers();
  useInvoiceStore.getState().loadInvoices();
  useProductStore.getState().loadProducts();
}

export function runConvertTransfer(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseConvertTransfer(raw);
  return runRemoteCommand(deps, identity, () => {
    assertConvertible({ id: req.transferId, expectedRevision: req.expectedRevision }, identity.branchId);
    if (!query('SELECT id FROM customers WHERE id = ? AND branch_id = ?', [req.customerId, identity.branchId])[0]) {
      throw new CommandRejected('CUSTOMER_NOT_FOUND', 'no such client in this branch');
    }
    loadAgentWorld();
    let invoice: { id: string };
    try {
      // Der Weg des Hauses: eine Rechnung über den Abrechnungsbetrag, die alte Forderung aus
      // dem Verkauf zurückgenommen, bereits gezahlte Abrechnungsbeträge in die Rechnung
      // umgezogen — damit dasselbe Geld nicht zweimal steht.
      invoice = useAgentStore.getState().convertTransferToInvoice(req.transferId, req.customerId);
    } catch (err) {
      const verdict = asVerdict(err, CONVERT_VERDICTS);
      if (verdict) throw verdict;
      throw err;
    }
    const after = transferState(req.transferId);
    if (s(after.invoiceId) === '') {
      throw new CommandNotEvaluated('TRANSFER_INVOICE_NOT_LINKED', 'the transfer carries no invoice');
    }
    useInvoiceStore.getState().loadInvoices();
    return { ...after, invoiceId: invoice.id, invoice: invoiceState(invoice.id) };
  });
}

export interface ConvertTransfersRequest {
  transfers: TransferRef[];
  customerId: string;
}

export function parseConvertTransfers(raw: unknown): ConvertTransfersRequest {
  if (!isPlain(raw)) throw new FinancialPayloadError('payload must be an object');
  onlyKnownFields(raw, ['transfers', 'customerId']);
  return {
    transfers: parseTransferRefs(raw, 'transfers'),
    customerId: reqString(raw.customerId, 'customerId'),
  };
}

export function runConvertTransfers(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseConvertTransfers(raw);
  return runRemoteCommand(deps, identity, () => {
    // ALLE Voraussetzungen zuerst, für jeden Vorgang — der Store tut dasselbe, und beide Male
    // aus demselben Grund: eine halb gebaute Sammelrechnung wäre schlimmer als keine.
    const rows = req.transfers.map((t) => assertConvertible(t, identity.branchId));
    const agentIds = new Set(rows.map((r) => s(r.agent_id)));
    if (agentIds.size > 1) {
      throw new CommandRejected('TRANSFERS_NOT_SAME_AGENT',
        'a combined invoice covers transfers of ONE agent');
    }
    if (!query('SELECT id FROM customers WHERE id = ? AND branch_id = ?', [req.customerId, identity.branchId])[0]) {
      throw new CommandRejected('CUSTOMER_NOT_FOUND', 'no such client in this branch');
    }
    loadAgentWorld();
    let invoice: { id: string };
    try {
      invoice = useAgentStore.getState().convertTransfersToInvoice(
        req.transfers.map((t) => t.id), req.customerId,
      );
    } catch (err) {
      const verdict = asVerdict(err, CONVERT_VERDICTS);
      if (verdict) throw verdict;
      throw err;
    }
    const after = req.transfers.map((t) => transferState(t.id));
    if (after.some((a) => s(a.invoiceId) === '')) {
      throw new CommandNotEvaluated('TRANSFER_INVOICE_NOT_LINKED', 'not every transfer carries the invoice');
    }
    useInvoiceStore.getState().loadInvoices();
    return {
      invoiceId: invoice.id,
      transfers: after,
      transferCount: after.length,
      invoice: invoiceState(invoice.id),
    };
  });
}

// ── Die Anmeldung ─────────────────────────────────────────────────────────

registerCommand(OP_ORDERS_UPDATE_STATUS, {
  kind: 'mutation',
  handler: (p, a?: CommandActor) => execFinancial(runUpdateOrderStatus, OP_ORDERS_UPDATE_STATUS, p, a),
});
registerCommand(OP_ORDERS_ADD_PAYMENT, {
  kind: 'mutation',
  handler: (p, a?: CommandActor) => execFinancial(runAddOrderPayment, OP_ORDERS_ADD_PAYMENT, p, a),
});
registerCommand(OP_ORDERS_DELETE_PAYMENT, {
  kind: 'mutation',
  handler: (p, a?: CommandActor) => execFinancial(runDeleteOrderPayment, OP_ORDERS_DELETE_PAYMENT, p, a),
});
registerCommand(OP_CONSIGNMENTS_RECORD_SALE, {
  kind: 'mutation',
  handler: (p, a?: CommandActor) => execFinancial(runRecordSale, OP_CONSIGNMENTS_RECORD_SALE, p, a),
});
registerCommand(OP_CONSIGNMENTS_MARK_RETURNED, {
  kind: 'mutation',
  handler: (p, a?: CommandActor) => execFinancial(runMarkConsignmentReturned, OP_CONSIGNMENTS_MARK_RETURNED, p, a),
});
registerCommand(OP_REPAIRS_UPDATE_STATUS, {
  kind: 'mutation',
  handler: (p, a?: CommandActor) => execFinancial(runUpdateRepairStatus, OP_REPAIRS_UPDATE_STATUS, p, a),
});
registerCommand(OP_REPAIRS_CREATE_INVOICE, {
  kind: 'mutation',
  handler: (p, a?: CommandActor) => execFinancial(runCreateRepairInvoice, OP_REPAIRS_CREATE_INVOICE, p, a),
});
registerCommand(OP_REPAIRS_ADD_LINE, {
  kind: 'mutation',
  handler: (p, a?: CommandActor) => execFinancial(runAddRepairLine, OP_REPAIRS_ADD_LINE, p, a),
});
registerCommand(OP_REPAIRS_UPDATE_LINE, {
  kind: 'mutation',
  handler: (p, a?: CommandActor) => execFinancial(runUpdateRepairLine, OP_REPAIRS_UPDATE_LINE, p, a),
});
registerCommand(OP_REPAIRS_CANCEL_LINE, {
  kind: 'mutation',
  handler: (p, a?: CommandActor) => execFinancial(runCancelRepairLine, OP_REPAIRS_CANCEL_LINE, p, a),
});
registerCommand(OP_TRANSFERS_CONVERT_TO_INVOICE, {
  kind: 'mutation',
  handler: (p, a?: CommandActor) => execFinancial(runConvertTransfer, OP_TRANSFERS_CONVERT_TO_INVOICE, p, a),
});
registerCommand(OP_TRANSFERS_CONVERT_MANY_TO_INVOICE, {
  kind: 'mutation',
  handler: (p, a?: CommandActor) => execFinancial(runConvertTransfers, OP_TRANSFERS_CONVERT_MANY_TO_INVOICE, p, a),
});
