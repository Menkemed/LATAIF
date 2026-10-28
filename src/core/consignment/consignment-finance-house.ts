// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R5F — Verkauf und Auszahlung einer Kommission am Haus: EINE Klammer.
//
// „Record Sale" schrieb am Primary Einkauf beim Einlieferer, Rechnung an den Käufer, ggf. die
// Verlust-Ausgabe, den Status und die Menge — nacheinander, ohne Klammer. „Pay Out Consignor" schrieb
// Status und Buchung ebenso getrennt. Jetzt je EINE Folge (`…InHouse`) für den Fernbefehl und die
// Maske des Primary (`…OnPrimary`, exklusiv, EINE Transaktion). Die Ökonomie bleibt, wo sie ist:
// `recordSale` (computeConsignmentSale) und `recordPartialPayout` des Stores.
// ════════════════════════════════════════════════════════════════════════════
import { query, currentBranchId } from '@/core/db/helpers';
import { runOnPrimary } from '@/core/data/primary-action';
import { watchLedgerPosts } from '@/core/ledger/posting';
import { ConsignorSupplierError, useConsignmentStore } from '@/stores/consignmentStore';
import { useSupplierStore } from '@/stores/supplierStore';
import { useCustomerStore } from '@/stores/customerStore';
import { useProductStore } from '@/stores/productStore';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { usePurchaseStore } from '@/stores/purchaseStore';
import { useExpenseStore } from '@/stores/expenseStore';
import {
  ACCEPTED_PAYOUT_METHODS, ConsignmentActionRejected, MAX_SALE_ITEMS, isConsignmentSaleTaxScheme, isConsignorPurchaseTaxScheme, payoutOpenAmount,
  type ConsignmentMultiSaleInput, type ConsignmentPayoutInput, type ConsignmentSaleInput,
} from './consignment-finance';
import { InvoiceActionRejected } from '@/core/invoices/invoice-cancel';
import { invoiceCreatePayments, type InvoiceCreatePayment } from '@/core/invoices/invoice-create-house';
import { businessDateIssue } from '@/core/utils/business-date';
// R6F — die Rücknahmen nach dem Verkauf: dieselbe Klammer, dieselben Listen danach.
import { isClientMode } from '@/core/bridge/client-mode';
import { CONSIGNMENT_PRIMARY_ONLY, type ConsignmentReturnAfterSaleInput, type ConsignorRefundChoice } from './consignment-reversal';
import {
  cancelConsignmentSaleInHouse, localConsignmentActor, returnConsignmentAfterSaleInHouse,
  type ConsignmentReturnedAfterSale, type ConsignmentSaleCancelled,
} from './consignment-reversal-house';

const SALE_VERDICTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/below consignor floor/i, 'SALE_BELOW_FLOOR'],
  [/Buyer cannot be the same as the consignor/i, 'BUYER_IS_CONSIGNOR'],
  [/Unsupported commission type/i, 'UNSUPPORTED_PAYOUT_MODEL'],
  [/cannot record sale/i, 'CONSIGNMENT_NOT_ACTIVE'],
  [/selected twice/i, 'DUPLICATE_ITEM'],
  [/same item cannot be sold twice/i, 'DUPLICATE_PRODUCT'],
];

function alsUrteil(e: unknown, table: ReadonlyArray<readonly [RegExp, string]>): never {
  if (e instanceof ConsignmentActionRejected) throw e;
  const msg = e instanceof Error ? e.message : String(e);
  for (const [pattern, code] of table) if (pattern.test(msg)) throw new ConsignmentActionRejected(code, msg);
  throw e;
}

export interface ConsignmentSold {
  invoiceId: string;
  purchaseId: string;
  expenseId?: string;
  consignorLossAmount: number;
  consignorPayout: number;
  ourCommission: number;
}

/**
 * „Record Sale" (nach dem Nummerndialog): Einkauf beim Einlieferer (damit ein Los entsteht),
 * Rechnung an den Käufer im gewählten Kreis, bei Unterdeckung die Verlust-Ausgabe, Status, Menge.
 * CONSIGNMENT MULTI-SALE — derselbe Weg wie der gemeinsame Verkauf, mit EINEM Artikel.
 */
export function recordConsignmentSaleInHouse(
  id: string, input: ConsignmentSaleInput, branchId: string, beforeWrite?: () => void,
): ConsignmentSold {
  const out = recordConsignmentSalesInHouse({
    items: [{ consignmentId: id, salePrice: input.salePrice, acknowledgeShortfall: input.acknowledgeShortfall }],
    buyerId: input.buyerId, saleDate: input.saleDate, notes: input.notes, specialMark: input.specialMark,
  }, branchId, beforeWrite);
  const it = out.items[0];
  return {
    invoiceId: it.invoiceId, purchaseId: it.purchaseId, expenseId: it.expenseId,
    consignorLossAmount: it.consignorLossAmount, consignorPayout: it.consignorPayout, ourCommission: it.ourCommission,
  };
}

export interface ConsignmentsSold {
  invoiceId: string;
  items: Array<ConsignmentSold & { consignmentId: string }>;
  paymentIds: string[];
}

/**
 * CONSIGNMENT MULTI-SALE — EIN Verkauf an EINEN Käufer: eine Rechnung mit einer Zeile je Artikel (datiert auf den
 * Verkaufstag), je Artikel ein Einkauf beim Einlieferer, ggf. Verlust-Ausgaben, die Zahlungen wie bei „Save
 * Invoice" — zusammen oder gar nicht. Geprüft wird aus der DATENBANK, in der Filiale des Auftrags, JEDER Artikel
 * vor dem ersten Schreiben; `beforeWrite` ist der letzte Wächter (fern: die gesehene Fassung jeder Kommission).
 */
export function recordConsignmentSalesInHouse(
  input: ConsignmentMultiSaleInput, branchId: string, beforeWrite?: () => void,
): ConsignmentsSold {
  const nein = (code: string, message: string): never => { throw new ConsignmentActionRejected(code, message); };
  if (!Array.isArray(input.items) || input.items.length === 0) nein('NO_ITEMS', 'select at least one consignment to sell');
  if (input.items.length > MAX_SALE_ITEMS) nein('TOO_MANY_ITEMS', `at most ${MAX_SALE_ITEMS} items in one sale`);
  const ids = new Set<string>();
  for (const it of input.items) {
    if (!Number.isFinite(it.salePrice) || it.salePrice <= 0) nein('INVALID_AMOUNT', 'the sale price must be a positive number');
    if (it.taxScheme !== undefined && !isConsignmentSaleTaxScheme(it.taxScheme)) {
      nein('INVALID_TAX_SCHEME', `unknown tax scheme: ${String(it.taxScheme)} — Margin scheme, VAT 10 % or Zero-rated`);
    }
    if (it.consignorTaxScheme !== undefined && !isConsignorPurchaseTaxScheme(it.consignorTaxScheme)) {
      nein('INVALID_TAX_SCHEME', `unknown VAT for the consignor's purchase: ${String(it.consignorTaxScheme)} — no VAT or VAT 10 %`);
    }
    if (ids.has(it.consignmentId)) nein('DUPLICATE_ITEM', 'the same consignment is selected twice — each item is sold once');
    ids.add(it.consignmentId);
  }
  if (!input.buyerId) nein('BUYER_REQUIRED', 'a sale needs a buyer (the invoice needs a client)');
  const tag = businessDateIssue(input.saleDate, 'Sale date');
  if (tag) nein('INVALID_DATE', tag);
  for (const it of input.items) {
    const con = query('SELECT id, status, invoice_id, consignment_number FROM consignments WHERE id = ? AND branch_id = ?', [it.consignmentId, branchId])[0];
    if (!con) nein('CONSIGNMENT_NOT_FOUND', 'no such consignment in this branch');
    const nr = String(con.consignment_number ?? '');
    if (String(con.status) !== 'active') {
      nein('CONSIGNMENT_NOT_ACTIVE', `${input.items.length > 1 ? `${nr}: ` : ''}this consignment is "${String(con.status)}" — only an active one is sold`);
    }
    if (String(con.invoice_id ?? '') !== '') {
      nein('CONSIGNMENT_ALREADY_SOLD', `${input.items.length > 1 ? `${nr}: ` : ''}this consignment already has an invoice`);
    }
  }
  if (!query('SELECT id FROM customers WHERE id = ? AND branch_id = ?', [input.buyerId, branchId])[0]) {
    nein('BUYER_NOT_FOUND', 'no such client in this branch');
  }
  // Die Zahlungen nach derselben Regel wie „Save Invoice" — rein, vor dem ersten Schreiben.
  let payments: InvoiceCreatePayment[] = [];
  try {
    payments = invoiceCreatePayments({ payments: input.payments });
  } catch (e) {
    if (e instanceof InvoiceActionRejected) nein(e.code, e.message);
    throw e;
  }
  beforeWrite?.();

  // Der Store schlägt die Kommission in SEINER Liste nach — und ruft danach Einkaufs-, Rechnungs-
  // und Ausgabenweg, die es ebenso tun.
  useConsignmentStore.getState().loadConsignments();
  useSupplierStore.getState().loadSuppliers();
  useCustomerStore.getState().loadCustomers();
  useProductStore.getState().loadProducts();
  useInvoiceStore.getState().loadInvoices();
  const buchung = watchLedgerPosts('consignment sale');
  let out: ConsignmentsSold | undefined;
  try {
    out = useConsignmentStore.getState().recordSales({
      items: input.items.map((it) => ({
        consignmentId: it.consignmentId, salePrice: it.salePrice, acknowledgeShortfall: it.acknowledgeShortfall,
        ...(it.taxScheme ? { taxScheme: it.taxScheme } : {}),
        ...(it.consignorTaxScheme ? { consignorTaxScheme: it.consignorTaxScheme } : {}),
      })),
      buyerId: input.buyerId,
      saleDate: input.saleDate,
      notes: input.notes,
      specialMark: input.specialMark,
      payments,
    });
  } catch (e) {
    // Ein fachliches Nein der Rechnung (Zahlung, VAT-Quartal …) oder der Lieferanten-Rolle bleibt ein fachliches Nein.
    if (e instanceof InvoiceActionRejected || e instanceof ConsignorSupplierError) nein(e.code, e.message);
    alsUrteil(e, SALE_VERDICTS);
  }
  buchung();
  return out!;
}

/**
 * Eine Auszahlung an den Eigentümer. Die Maske zahlt den ganzen offenen Rest; ein kleinerer Betrag
 * bleibt ein Teil (Status bleibt „sold"), erst der Rest auf null schließt („paid_out"). Nur für einen
 * Verkauf OHNE Rechnung — mit Rechnung zahlt der Einkauf beim Einlieferer die Schuld.
 */
export function payOutConsignmentInHouse(
  id: string, input: ConsignmentPayoutInput, branchId: string, beforeWrite?: () => void,
): { appliedAmount: number } {
  if (!ACCEPTED_PAYOUT_METHODS.includes(input.method)) {
    throw new ConsignmentActionRejected('INVALID_INPUT', `unknown payout method: ${input.method || '(none)'}`);
  }
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw new ConsignmentActionRejected('INVALID_AMOUNT', 'a payout must be a positive number');
  }
  const con = query(
    'SELECT id, status, invoice_id, payout_amount, payout_paid_amount FROM consignments WHERE id = ? AND branch_id = ?',
    [id, branchId],
  )[0];
  if (!con) throw new ConsignmentActionRejected('CONSIGNMENT_NOT_FOUND', 'no such consignment in this branch');
  const target = Number(con.payout_amount ?? 0);
  if (!(target > 0)) {
    throw new ConsignmentActionRejected('NOTHING_TO_PAY_OUT', 'this consignment has no payout amount yet — it is set when the item is sold');
  }
  const paid = Number(con.payout_paid_amount ?? 0);
  const open = payoutOpenAmount({ payoutAmount: target, payoutPaidAmount: paid });
  if (open <= 0.005) throw new ConsignmentActionRejected('ALREADY_PAID_OUT', 'this consignment is already paid out in full');
  if (String(con.status) !== 'sold') {
    throw new ConsignmentActionRejected('CONSIGNMENT_NOT_SOLD', `this consignment is "${String(con.status)}" — only a sold one is paid out`);
  }
  // Die Masken bieten „Pay Out" nur ohne Rechnung an: mit Rechnung steht die Schuld als Einkauf beim
  // Einlieferer offen — eine zweite Auszahlung hier zahlte ihn doppelt.
  if (String(con.invoice_id ?? '') !== '') {
    throw new ConsignmentActionRejected('PAYOUT_VIA_PURCHASE', 'this sale pays the consignor through its purchase — not here');
  }
  if (input.amount > open + 0.0005) {
    throw new ConsignmentActionRejected('PAYOUT_EXCEEDS_OPEN', `the payout (${input.amount}) is more than what is still open (${open})`);
  }
  beforeWrite?.();
  // Der ganze Rest ist genau der offene Betrag — ohne Rundungsrest.
  const amount = Math.abs(input.amount - open) <= 0.0005 ? target - paid : input.amount;
  useConsignmentStore.getState().loadConsignments();
  const buchung = watchLedgerPosts('consignment payout');
  useConsignmentStore.getState().recordPartialPayout(id, amount, input.method, input.reference);
  buchung();
  return { appliedAmount: amount };
}

/** Die Listen, die die Seiten danach zeigen — auch nach einem Rollback. */
function frischLesen(): void {
  useConsignmentStore.getState().loadConsignments();
  useInvoiceStore.getState().loadInvoices();
  usePurchaseStore.getState().loadPurchases();
  usePurchaseStore.getState().loadReturns();
  useExpenseStore.getState().loadExpenses();
  useProductStore.getState().loadProducts();
  useCustomerStore.getState().loadCustomers();
  useSupplierStore.getState().loadSuppliers();
}

/** „Record Sale" am Primary. */
export function recordConsignmentSaleOnPrimary(id: string, input: ConsignmentSaleInput): Promise<ConsignmentSold> {
  return runOnPrimary(() => recordConsignmentSaleInHouse(id, input, currentBranchId()), frischLesen);
}

/** CONSIGNMENT MULTI-SALE — der gemeinsame „Record Sale" am Primary (ein oder mehrere Artikel). */
export function recordConsignmentSalesOnPrimary(input: ConsignmentMultiSaleInput): Promise<ConsignmentsSold> {
  return runOnPrimary(() => recordConsignmentSalesInHouse(input, currentBranchId()), frischLesen);
}

/** „Pay Out Consignor" am Primary. */
export function payOutConsignmentOnPrimary(id: string, input: ConsignmentPayoutInput): Promise<{ appliedAmount: number }> {
  return runOnPrimary(() => payOutConsignmentInHouse(id, input, currentBranchId()), frischLesen);
}

/**
 * R6F — „Buyer Returns the Item" am Primary: dieselbe Hausfolge wie `consignments.return_after_sale`,
 * exklusiv, in EINER Transaktion, erst danach durabel. Ohne Datenbank (PC2) kein lokaler Versuch.
 */
export function returnConsignmentAfterSaleOnPrimary(
  id: string, input: ConsignmentReturnAfterSaleInput,
): Promise<ConsignmentReturnedAfterSale> {
  if (isClientMode()) {
    return Promise.reject(new ConsignmentActionRejected(CONSIGNMENT_PRIMARY_ONLY,
      'a post-sale return is booked on the main computer — this window has no business database'));
  }
  return runOnPrimary(() => returnConsignmentAfterSaleInHouse(id, input, currentBranchId()), frischLesen);
}

/**
 * R6F — „Cancel Sale" am Primary: dieselbe Hausfolge wie `consignments.cancel_sale`. Verantwortlich ist
 * die Sitzung — ihre Rolle entscheidet über den Storno einer eigenen Rückgabe nach dem Verkauf (Owner).
 */
export function cancelConsignmentSaleOnPrimary(
  id: string, consignorRefunds?: Readonly<Record<string, ConsignorRefundChoice>>,
): Promise<ConsignmentSaleCancelled> {
  if (isClientMode()) {
    return Promise.reject(new ConsignmentActionRejected(CONSIGNMENT_PRIMARY_ONLY,
      'a sale is cancelled on the main computer — this window has no business database'));
  }
  return runOnPrimary(
    () => cancelConsignmentSaleInHouse(id, localConsignmentActor(), currentBranchId(), undefined, consignorRefunds),
    frischLesen,
  );
}
