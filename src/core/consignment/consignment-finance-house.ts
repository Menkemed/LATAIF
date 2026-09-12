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
import { useConsignmentStore } from '@/stores/consignmentStore';
import { useSupplierStore } from '@/stores/supplierStore';
import { useCustomerStore } from '@/stores/customerStore';
import { useProductStore } from '@/stores/productStore';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { usePurchaseStore } from '@/stores/purchaseStore';
import { useExpenseStore } from '@/stores/expenseStore';
import {
  ACCEPTED_PAYOUT_METHODS, ConsignmentActionRejected, payoutOpenAmount,
  type ConsignmentPayoutInput, type ConsignmentSaleInput,
} from './consignment-finance';

const SALE_VERDICTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/below consignor floor/i, 'SALE_BELOW_FLOOR'],
  [/Buyer cannot be the same as the consignor/i, 'BUYER_IS_CONSIGNOR'],
  [/Unsupported commission type/i, 'UNSUPPORTED_PAYOUT_MODEL'],
  [/cannot record sale/i, 'CONSIGNMENT_NOT_ACTIVE'],
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
 */
export function recordConsignmentSaleInHouse(
  id: string, input: ConsignmentSaleInput, branchId: string, beforeWrite?: () => void,
): ConsignmentSold {
  if (!Number.isFinite(input.salePrice) || input.salePrice <= 0) {
    throw new ConsignmentActionRejected('INVALID_AMOUNT', 'the sale price must be a positive number');
  }
  if (!input.buyerId) throw new ConsignmentActionRejected('BUYER_REQUIRED', 'a sale needs a buyer (the invoice needs a client)');
  const con = query('SELECT id, status, invoice_id FROM consignments WHERE id = ? AND branch_id = ?', [id, branchId])[0];
  if (!con) throw new ConsignmentActionRejected('CONSIGNMENT_NOT_FOUND', 'no such consignment in this branch');
  if (String(con.status) !== 'active') {
    throw new ConsignmentActionRejected('CONSIGNMENT_NOT_ACTIVE', `this consignment is "${String(con.status)}" — only an active one is sold`);
  }
  if (String(con.invoice_id ?? '') !== '') {
    throw new ConsignmentActionRejected('CONSIGNMENT_ALREADY_SOLD', 'this consignment already has an invoice');
  }
  if (!query('SELECT id FROM customers WHERE id = ? AND branch_id = ?', [input.buyerId, branchId])[0]) {
    throw new ConsignmentActionRejected('BUYER_NOT_FOUND', 'no such client in this branch');
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
  let out: ConsignmentSold | undefined;
  try {
    out = useConsignmentStore.getState().recordSale(id, {
      salePrice: input.salePrice,
      buyerId: input.buyerId,
      saleDate: input.saleDate,
      notes: input.notes,
      acknowledgeShortfall: input.acknowledgeShortfall,
      specialMark: input.specialMark,
    });
  } catch (e) {
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
  useExpenseStore.getState().loadExpenses();
  useProductStore.getState().loadProducts();
  useCustomerStore.getState().loadCustomers();
  useSupplierStore.getState().loadSuppliers();
}

/** „Record Sale" am Primary. */
export function recordConsignmentSaleOnPrimary(id: string, input: ConsignmentSaleInput): Promise<ConsignmentSold> {
  return runOnPrimary(() => recordConsignmentSaleInHouse(id, input, currentBranchId()), frischLesen);
}

/** „Pay Out Consignor" am Primary. */
export function payOutConsignmentOnPrimary(id: string, input: ConsignmentPayoutInput): Promise<{ appliedAmount: number }> {
  return runOnPrimary(() => payOutConsignmentInHouse(id, input, currentBranchId()), frischLesen);
}
