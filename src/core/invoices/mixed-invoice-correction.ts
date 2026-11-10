// ════════════════════════════════════════════════════════════════════════════
// MIXED-INVOICE P4 — eine Rechnung mit Kommissionszeilen (gemischt oder rein „Record Sale") korrigieren: EINE Hausfolge
// für die Maske des Primary (`correctMixedInvoiceOnPrimary`, exklusiv) und für PC2 (`invoices.update` mit `consignment`),
// in EINER Transaktion des Aufrufers. Diese Datei öffnet, schließt und rollt nie selbst zurück.
//
// Owner-Regeln (Plan §1, P4): E2 Überzahlung → Guthaben oder Rückforderung (Pflichtwahl); E3 unbezahlter Einkauf folgt dem
// Rechnungsdatum, (teil)bezahlter behält seins, kein Datum vor der Einlieferung oder vor einem bezahlten Einkauf; E4 der
// Käufer zieht mit (Käufer ≠ Einlieferer); E5 Zeile entfernen → Kommission Active, übrige Zeilen bleiben, keine leere
// Rechnung; E6 neue Zeile an den unbezahlten Einkauf desselben Einlieferers, sonst eigener Einkauf; E7 Bestätigung des
// negativen LATAIF-Ergebnisses; E8 zugemachte Quartale gesperrt; E9 Verlust-Ausgabe: unbezahlt angepasst, bezahlt bleibt,
// Mehrbetrag getrennt; E10 Einkaufs-VAT nur vor der ersten Auszahlung; E11 jede Gegenbuchung auf dem Tag ihres Originals;
// E13 nur ADMIN/MANAGER.
//
// Wiederverwendet, nicht nachgebaut: `editInvoice` (Zeilen, Lose, Steuer, Zahlungen, Kundenwechsel, Überzahlung, VAT-
// Sperre, Audit) läuft geschachtelt; die Ökonomie ist `computeConsignmentSale`; die Zeilenbeträge rechnet
// `consignmentLineAmounts` wie „Record Sale"; der Einkauf beim Einlieferer über seine Zeilen und Lose
// (`appendPurchaseLinesInHouse`, `purchaseLotUnitCost`, `postPurchaseReceived`, `reconcilePurchaseOverpayCredit`), die
// Rücknahme einer bezahlten Zeile über D3 (`einkaufZurueck`), der Storno eines unbezahlten über `cancelPurchaseInHouse`,
// die Verlust-Ausgabe über „Edit Expense" (`updateExpenseInHouse`).
//
// Bewusst gesperrt (Nein ohne Teilzustand): eine schon (teil)bezahlte Verlust-Ausgabe unter ihr Bezahltes mindern oder
// entfernen (E5/E9-Prüfpunkt, Owner-Entscheidung offen); ein mit Lieferanten-Guthaben bezahlter Einkauf unter das
// Verrechnete; eine Kommission mit Rückgabe nach dem Verkauf; ein Einkauf mit Retoure ändern.
// ════════════════════════════════════════════════════════════════════════════
import { getDatabase } from '@/core/db/database';
import { query } from '@/core/db/helpers';
import { isClientMode } from '@/core/bridge/client-mode';
import { runOnPrimary } from '@/core/data/primary-action';
import { currentBranchId } from '@/core/db/helpers';
import { logAuditOrThrow } from '@/core/audit/audit-log';
import { PURCHASE_HAS_OFFSET, purchaseHasActiveOffsets, purchaseHasOffsetMessage } from '@/core/purchases/purchase-settled';
import { trackUpdate } from '@/core/sync/track';
import { trackChange } from '@/core/sync/sync-service';
import {
  activeSourceDates, hasLedgerEntries, hasReversalFor, postPurchaseReceived, reverseConsignmentPayouts, reverseSource,
  watchLedgerPosts,
} from '@/core/ledger/posting';
import { assertCorrectionDates, type CorrectionDate } from '@/core/ledger/correction-dates';
import { purchaseLotUnitCost } from '@/core/lots/lot-cost';
import { vatEngine } from '@/core/tax/vat-engine';
import { syncProductQuantity, trackLotRow, trackProductRow } from '@/core/lots/lot-queries';
import { computeConsignmentSale, type ConsignmentSaleResult } from '@/core/consignment/economics';
import { boundSaleConsignments, withConsignmentCorrectionPermit, withConsignmentSalePermit } from '@/core/consignment/consignment-sale-link';
import {
  CONSIGNOR_OVERPAID, consignorLosses, consignorOverpaid, consignorPurchases, einkaufLage, einkaufZurueck, gemeinsameZeile,
  localConsignmentActor, verlustBezahltF, zumVerkauf, type ConsignmentActor,
} from '@/core/consignment/consignment-reversal-house';
import { ConsignmentActionRejected } from '@/core/consignment/consignment-finance';
import { cancelPurchaseInHouse } from '@/core/purchases/purchase-lifecycle-house';
import { belegFuerBuchung } from '@/core/purchases/purchase-edit-house';
import { reconcilePurchaseOverpayCredit, assertSupplierOverpayMutable, OverpayCreditRedeemed } from '@/core/payables/purchase-overpay';
import { markConsignorRepaymentClaim, updateExpenseInHouse } from '@/core/payables/payables-house';
import { applyCostExpense, planCostExpense } from '@/core/orders/order-cost-correction';
import { GoldRejected } from '@/core/gold/gold-settle';
import { InvoiceActionRejected } from '@/core/invoices/invoice-cancel';
import { issuedAtIso } from '@/core/invoices/issued-at';
import { assertMixedInvoiceActor } from '@/core/invoices/mixed-invoice-permission';
import type { OverpayChoice } from '@/core/invoices/invoice-refund';
import {
  CONSIGNMENT_LINE_LOCKED, CONSIGNMENT_PURCHASE_UNCLEAR, CONSIGNOR_OVERPAY_CHOICE_REQUIRED, CONSIGNOR_PURCHASE_MIXED_CHANGE,
  CONSIGNOR_VAT_LOCKED, CORRECTION_REVISION_REQUIRED, INVOICE_NEEDS_A_LINE, OWN_LINE_IS_CONSIGNMENT, SALE_BEFORE_CONSIGNMENT, SALE_BEFORE_PAID_PURCHASE,
  VAT_SHORTFALL_UNCONFIRMED, consignmentLineAmounts, consignmentVatShortfall, consignorPurchaseAmount,
  type ConsignorOverpayChoice, type MixedInvoiceCorrection, type SaleScheme,
} from './mixed-invoice';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { useProductStore } from '@/stores/productStore';
import { useCustomerStore } from '@/stores/customerStore';
import { useExpenseStore } from '@/stores/expenseStore';
import { usePurchaseStore, appendPurchaseLinesInHouse } from '@/stores/purchaseStore';
import { useConsignmentStore, rowToConsignment, findOrCreateSupplierForConsignor } from '@/stores/consignmentStore';
import { useSupplierStore } from '@/stores/supplierStore';
import type { PaymentMethod } from '@/core/models/types';
import type { CardBrand } from '@/core/finance/card-fees';

type EditInput = Parameters<ReturnType<typeof useInvoiceStore.getState>['editInvoice']>[1];
type EditLine = EditInput['lines'][number];

/** Die Eingabe der Korrektur: die Felder der Rechnungsänderung (eigene Zeilen) und der Kommissionsteil. */
export interface MixedInvoiceCorrectionInput {
  invoiceId: string;
  /** Die Fassung der Rechnung, die der Mensch gesehen hat. */
  expectedRevision: number;
  reason: string;
  /** Die EIGENEN Zeilen nach der Korrektur (wie bei „Save Changes"; ohne die Kommissionszeilen). */
  ownLines: EditLine[];
  customerId?: string;
  notes?: string;
  issuedAt?: string;
  staffId?: string;
  confirmCustomerChange?: boolean;
  overpayChoice?: OverpayChoice;
  refundNow?: { method: string; paidDate?: string };
  /** Nur am Primary (wie beim gewöhnlichen Ändern): eine Zahlung im selben Speichern. */
  deltaPayment?: { amount: number; method: PaymentMethod; cardBrand?: CardBrand };
  consignment: MixedInvoiceCorrection;
}

export interface MixedInvoiceCorrected {
  invoiceId: string;
  removed: string[];
  added: string[];
  corrected: string[];
  purchases: Array<{ purchaseId: string; purchaseNumber: string; action: 'corrected' | 'cancelled' | 'returned' | 'created' }>;
  /** E2 — was ein bezahlter Einlieferer jetzt schuldet: als Guthaben (verrechenbar) oder Rückforderung. */
  consignorClaims: Array<{ purchaseId: string; creditId: string; amount: number; kind: ConsignorOverpayChoice }>;
  /** E5/E9 — was ein Einlieferer aus einer schon bezahlten Verlust-Ausgabe zu viel erhielt: Guthaben oder Rückforderung. */
  lossClaims: Array<{ consignmentId: string; expenseId: string; creditId: string; amount: number; kind: ConsignorOverpayChoice }>;
}

const F = (n: unknown): number => Math.round((Number(n) || 0) * 1000);
const B = (f: number): number => f / 1000;
const R3 = (n: number): number => Math.round(n * 1000) / 1000;
const fmt = (f: number): string => B(f).toFixed(3);
const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const dayOf = (iso: unknown): string => s(iso).slice(0, 10);
const nein = (code: string, message: string): never => { throw new ConsignmentActionRejected(code, message); };
const vatOf = (lineTotal: number, scheme: 'ZERO' | 'VAT_10'): number => (scheme === 'VAT_10' ? lineTotal * 10 / 110 : 0);
const schemeOf = (v: unknown): 'ZERO' | 'VAT_10' => (s(v) === 'VAT_10' ? 'VAT_10' : 'ZERO');
const SCHEMES: readonly string[] = ['MARGIN', 'VAT_10', 'ZERO'];

/** Ein Einlieferer-Einkauf dieser Rechnung, den die Korrektur berührt — geplant vor dem ersten Schreiben. */
interface EinkaufPlan {
  id: string;
  number: string;
  row: Record<string, unknown>;
  lines: Array<Record<string, unknown>>;
  cashF: number;
  creditF: number;
  settledF: number;
  everPaid: boolean;
  hasReturn: boolean;
  /** Zeile → neuer Betrag (brutto) — eine korrigierte Kommissionszeile. */
  amounts: Map<string, number>;
  /** E10 — neue Einkaufs-VAT für ALLE Zeilen. */
  scheme?: 'ZERO' | 'VAT_10';
  /** E3 — neues Einkaufsdatum (nur unbezahlt). */
  date?: string;
  /** E6 — angehängte Kommissionen (Betrag brutto). */
  appends: Array<{ consignmentId: string; productId: string; amount: number }>;
  /** E5 — Zeilen, die unbezahlt an Ort und Stelle gehen. */
  dropLines: Set<string>;
  /** E5 — Kommissionen, deren Zeile über D3 (bezahlt) zurückgeht. */
  returns: string[];
  /** Ganz zurück (alle Zeilen weg, unbezahlt): Storno auf dem eigenen Tag. */
  cancel: boolean;
}

/** Eine Kommissionszeile der Korrektur, gerechnet. */
interface Teil {
  con: Record<string, unknown>;
  id: string;
  nr: string;
  productId: string;
  consignorId: string;
  salePrice: number;
  scheme: SaleScheme;
  econ: ConsignmentSaleResult;
  /** Beträge der Rechnungszeile (nach der Regel von „Record Sale"). */
  net: number;
  vat: number;
  gross: number;
  /** Was der Einkauf beim Einlieferer für diesen Verkauf trägt. */
  purchaseAmount: number;
  /** Die gespeicherte Rechnungszeile (nur für bleibende). */
  line?: Record<string, unknown>;
  /** Preis oder Steuerart geändert (oder neu). */
  changed: boolean;
  added: boolean;
  /** Der Einkauf dieser Kommission (bleibend) bzw. der, an den sie kommt (neu, E6) — `null`: neuer Einkauf. */
  purchaseId: string | null;
  purchaseLineId?: string;
}

function assertBooks(): void {
  if (isClientMode()) nein('CONSIGNMENT_PRIMARY_ONLY', 'this happens on the main computer — this window has no business database');
}

/** Die Verlust-Ausgaben einer Kommission mit Betrag, Beglichenem und Tag (älteste zuerst). */
function verluste(consignmentId: string, branchId: string): Array<{ id: string; amountF: number; settledF: number; date: string }> {
  return consignorLosses(consignmentId, branchId).map((id) => {
    const e = query('SELECT amount, expense_date FROM expenses WHERE id = ?', [id])[0];
    return { id, amountF: F(e?.amount), settledF: verlustBezahltF(id), date: dayOf(e?.expense_date) };
  });
}

/**
 * E9 — die Verlust-Ausgaben auf den neuen Gesamtverlust verteilen: zuerst bis zum schon Beglichenen jeder Ausgabe; ein
 * Mehrbetrag erhöht die jüngste UNBEZAHLTE Ausgabe, sonst wird er eine eigene neue Ausgabe.
 * E5/E9 (Owner-Entscheidung, wie die Custom-Order-Kosten): liegt der neue Verlust UNTER dem schon Bezahlten, bekommen die
 * Ausgaben (älteste zuerst) höchstens ihr Beglichenes — der Rest ist eine echte Überzahlung (`overpayF`), die je Ausgabe als
 * Guthaben oder Rückforderung gebucht wird (`applyCostExpense`). Die Zahlungen selbst bleiben.
 */
function verlustPlan(rows: ReadonlyArray<{ id: string; amountF: number; settledF: number }>, targetF: number):
  { amounts: Map<string, number>; extraF: number; overpayF: number } {
  const bezahltF = rows.reduce((x, r) => x + r.settledF, 0);
  if (targetF < bezahltF) {
    const amounts = new Map<string, number>();
    let restF = targetF;
    for (const r of rows) { const a = Math.min(r.settledF, restF); amounts.set(r.id, a); restF -= a; }
    return { amounts, extraF: 0, overpayF: bezahltF - targetF };
  }
  const amounts = new Map(rows.map((r) => [r.id, r.settledF]));
  let restF = targetF - bezahltF;
  for (const r of rows) {
    const add = Math.min(restF, r.amountF - r.settledF);
    amounts.set(r.id, (amounts.get(r.id) ?? 0) + add);
    restF -= add;
  }
  let extraF = 0;
  if (restF > 0) {
    const last = rows[rows.length - 1];
    if (last && last.settledF === 0) amounts.set(last.id, (amounts.get(last.id) ?? 0) + restF);
    else extraF = restF;
  }
  return { amounts, extraF, overpayF: 0 };
}

/** E2/E11 — der Tag, an dem die Überzahlung einer Ausgabe entsteht: der spätere von Ausgabetag und ihren Zahlungen. */
function verlustUeberTag(expenseId: string, now: string): string {
  const tage = [dayOf(query('SELECT expense_date FROM expenses WHERE id = ?', [expenseId])[0]?.expense_date),
    ...query('SELECT paid_at FROM expense_payments WHERE expense_id = ?', [expenseId]).map((r) => dayOf(r.paid_at))].filter(Boolean).sort();
  const tag = tage.pop() ?? dayOf(now);
  return tag < dayOf(now) ? `${tag}T12:00:00.000Z` : now;
}

/** Eine UNBEZAHLTE Verlust-Ausgabe zurücknehmen, ihre Buchung auf ihrem eigenen Tag gespiegelt (E11). */
function verlustStornieren(expenseId: string, now: string): void {
  getDatabase().run(`UPDATE expenses SET status = 'CANCELLED' WHERE id = ?`, [expenseId]);
  if (hasLedgerEntries('EXPENSE', expenseId) && !hasReversalFor('EXPENSE', expenseId)) {
    reverseSource('EXPENSE', expenseId, now, { mirrorOriginalDates: true });
  }
  trackUpdate('expenses', expenseId, { status: 'CANCELLED', reason: 'consignment-correction' });
}

/** Eine neue Verlust-Ausgabe — derselbe Weg wie „Record Sale" (unbezahlt, beim Einlieferer als Lieferant). */
function verlustAnlegen(con: Record<string, unknown>, supplierId: string, amount: number, salePrice: number, date: string): string {
  const e = useExpenseStore.getState().createExpense({
    category: 'ConsignorLoss',
    amount,
    supplierId,
    paymentMethod: 'cash',
    description: `Consignor guarantee shortfall · ${s(con.consignment_number)} · sold ${salePrice} BHD vs agreed ${s(con.agreed_price)} BHD`,
    expenseDate: date,
    relatedModule: 'consignment',
    relatedEntityId: s(con.id),
    payNow: false,
  });
  return e.id;
}

function einkaufPlanOf(purchaseId: string, branchId: string): EinkaufPlan {
  const row = query('SELECT * FROM purchases WHERE id = ? AND branch_id = ?', [purchaseId, branchId])[0];
  if (!row) nein('PURCHASE_NOT_FOUND', 'a purchase of this sale is not in this branch');
  // B2/B3 — eine wirksame Verrechnung des Einkaufs mit einer Kundenrechnung zuerst aufheben (die Korrektur änderte ihn).
  if (purchaseHasActiveOffsets(purchaseId)) nein(PURCHASE_HAS_OFFSET, purchaseHasOffsetMessage(`Correcting this sale (purchase ${s(row!.purchase_number)})`));
  const lines = query('SELECT * FROM purchase_lines WHERE purchase_id = ? ORDER BY position, id', [purchaseId]);
  const creditF = F(query(
    `SELECT COALESCE(SUM(amount), 0) AS t FROM purchase_payments WHERE purchase_id = ? AND method IN ('credit', 'offset') AND voided_at IS NULL`,
    [purchaseId],
  )[0]?.t);
  const cashF = F(row!.paid_amount);
  const everPaid = query('SELECT 1 FROM purchase_payments WHERE purchase_id = ? LIMIT 1', [purchaseId]).length > 0 || cashF + creditF > 0;
  const hasReturn = query(`SELECT 1 FROM purchase_returns WHERE purchase_id = ? AND status != 'CANCELLED' LIMIT 1`, [purchaseId]).length > 0;
  return {
    id: purchaseId, number: s(row!.purchase_number), row: row!, lines, cashF, creditF, settledF: cashF + creditF, everPaid, hasReturn,
    amounts: new Map(), appends: [], dropLines: new Set(), returns: [], cancel: false,
  };
}

/** Die Zeile einer Kommission in einem ihrer Einkäufe. */
function zeileIn(plan: EinkaufPlan, consignmentId: string, productId: string): Record<string, unknown> | undefined {
  if (plan.lines.length === 1) return plan.lines[0];
  const g = gemeinsameZeile(plan.id, consignmentId, productId);
  return g ? plan.lines.find((l) => s(l.id) === g.lineId) : undefined;
}

/** Der Einkauf (genau einer) und seine Zeile für eine gebundene Kommission — sonst null. */
function einkaufDerKommission(con: Record<string, unknown>, invoiceId: string, branchId: string): string | null {
  const alle = zumVerkauf(invoiceId, consignorPurchases(s(con.id), s(con.consignment_number), s(con.product_id), branchId));
  return alle.length === 1 ? alle[0] : null;
}

/**
 * „Save Changes" einer Rechnung mit Kommissionszeilen. Alle Regeln stehen vor dem ersten Schreiben; geschrieben wird in
 * der Transaktion des Aufrufers (Primary: `runOnPrimary`, PC2: `runRemoteCommand`). `beforeWrite` prüft fern die Fassungen
 * unmittelbar vor dem ersten Schreiben (wie beim Verkauf).
 */
export function correctMixedInvoiceInHouse(
  input: MixedInvoiceCorrectionInput, branchId: string, actor: ConsignmentActor, beforeWrite?: () => void,
): MixedInvoiceCorrected {
  assertBooks();
  // E13 — nur ADMIN/MANAGER: am Primary die Sitzung, fern der geprüfte Absender.
  assertMixedInvoiceActor({ role: actor.role ?? null });
  const now = new Date().toISOString();
  const invoiceId = s(input.invoiceId);
  const inv = query('SELECT * FROM invoices WHERE id = ? AND branch_id = ?', [invoiceId, branchId])[0];
  if (!inv) throw new InvoiceActionRejected('INVOICE_NOT_FOUND', 'no such invoice in this branch');
  if (s(inv.status) === 'CANCELLED') throw new InvoiceActionRejected('INVOICE_CANCELLED', 'Cannot edit a cancelled invoice.');
  if (Number(inv.revision ?? 0) !== input.expectedRevision) {
    throw new InvoiceActionRejected('INVOICE_CHANGED',
      `this invoice changed since you opened it (you saw ${input.expectedRevision}, it is now ${Number(inv.revision ?? 0)}) — reload it and edit it again`);
  }
  if (!s(input.reason).trim()) throw new InvoiceActionRejected('EDIT_REASON_REQUIRED', 'An edit reason is required.');
  const corr = input.consignment;
  if (!corr || !Array.isArray(corr.items)) nein('INVALID_INPUT', 'the consignment part of the correction is missing');
  const ownLines = Array.isArray(input.ownLines) ? input.ownLines : [];

  // ── 1. Die Kommissionen dieser Rechnung und die Zielmenge ──
  const gebunden = new Map(query('SELECT * FROM consignments WHERE invoice_id = ? AND branch_id = ?', [invoiceId, branchId])
    .map((r) => [s(r.id), r]));
  if (gebunden.size === 0 && boundSaleConsignments(invoiceId).length > 0) nein('CONSIGNMENT_NOT_FOUND', 'the consignments of this invoice are not in this branch');
  const ids = new Set<string>();
  const artikel = new Set<string>();
  for (const it of corr.items) {
    if (ids.has(it.consignmentId)) nein('DUPLICATE_ITEM', 'the same consignment is listed twice — each item is sold once');
    ids.add(it.consignmentId);
    if (!Number.isFinite(it.salePrice) || !(it.salePrice > 0)) nein('INVALID_AMOUNT', 'the sale price must be a positive number');
    if (!SCHEMES.includes(it.taxScheme)) nein('INVALID_TAX_SCHEME', `unknown tax scheme: ${s(it.taxScheme)} — Margin scheme, VAT 10 % or Zero-rated`);
  }
  const entfernt = [...gebunden.values()].filter((c) => !ids.has(s(c.id)));
  if (ownLines.length === 0 && corr.items.length === 0) {
    throw new InvoiceActionRejected(INVOICE_NEEDS_A_LINE,
      'An invoice keeps at least one line. To undo the whole sale, use "Cancel Sale" on the consignment. Nothing was changed.');
  }

  // Fassungen jeder gebundenen und jeder neuen Kommission (fail-closed: ohne Fassung keine Aussage, worauf sich das bezieht).
  const fassungKommission = (id: string): void => {
    const gesehen = corr.consignmentRevisions?.[id];
    if (typeof gesehen !== 'number') nein(CORRECTION_REVISION_REQUIRED, 'every consignment of this correction needs the revision you saw — reload the invoice');
    const jetzt = Number(query('SELECT revision FROM consignments WHERE id = ?', [id])[0]?.revision ?? 0);
    if (jetzt !== gesehen) nein('RECORD_CHANGED', `a consignment changed since you opened the invoice (you saw ${gesehen}, it is now ${jetzt}) — reload it`);
  };
  for (const id of gebunden.keys()) fassungKommission(id);
  for (const it of corr.items) if (!gebunden.has(it.consignmentId)) fassungKommission(it.consignmentId);

  const neuerKunde = s(input.customerId ?? inv.customer_id);
  const neuesDatumIso = issuedAtIso(input.issuedAt) ?? s(inv.issued_at);
  const neuerTag = dayOf(neuesDatumIso);
  const alterTag = dayOf(inv.issued_at);
  const datumWechsel = neuerTag !== alterTag;

  // ── 2. Je Kommissionszeile: Ökonomie, Beträge, Bestätigungen ──
  const teile: Teil[] = corr.items.map((it) => {
    const added = !gebunden.has(it.consignmentId);
    const con = added
      ? query('SELECT * FROM consignments WHERE id = ? AND branch_id = ?', [it.consignmentId, branchId])[0]
      : gebunden.get(it.consignmentId)!;
    if (!con) nein('CONSIGNMENT_NOT_FOUND', 'no such consignment in this branch');
    const nr = s(con!.consignment_number);
    const productId = s(con!.product_id);
    if (artikel.has(productId)) nein('DUPLICATE_PRODUCT', `${nr}: the same item cannot be sold twice on one invoice`);
    artikel.add(productId);
    if (added) {
      if (s(con!.status) !== 'active') nein('CONSIGNMENT_NOT_ACTIVE', `${nr}: this consignment is "${s(con!.status)}" — only an active one is added`);
      if (s(con!.invoice_id)) nein('CONSIGNMENT_ALREADY_SOLD', `${nr}: this consignment already has an invoice`);
    }
    const model = rowToConsignment(con!);
    const ctype = model.commissionType || 'percent';
    if (ctype !== 'percent' && ctype !== 'consignor_fixed' && ctype !== 'cost_split') {
      nein('UNSUPPORTED_PAYOUT_MODEL', `${nr}: unsupported commission type "${ctype}"`);
    }
    // E4 — Käufer ≠ Einlieferer, gegen den (neuen) Kunden.
    if (neuerKunde === s(con!.consignor_id)) {
      nein('BUYER_IS_CONSIGNOR', `${nr}: the customer is the consignor of this item — buyer and consignor must differ (use "Return" if the consignor takes it back)`);
    }
    // E3 — kein Rechnungsdatum vor der Einlieferung.
    const seit = dayOf(con!.agreement_date);
    if (seit && neuerTag < seit) {
      nein(SALE_BEFORE_CONSIGNMENT, `${nr}: the invoice date ${neuerTag} is before the consignment was taken in (${seit})`);
    }
    const econ = computeConsignmentSale(model, it.salePrice);
    // Netto, Brutto und die VAT 10 % (E7) hängen nicht am Einstand. Die Margen-VAT einer neuen oder geänderten Zeile rechnet
    // Schritt d) aus dem Einstand, den die Zeile NACH den Einkäufen wirklich hält (VAT-CONSISTENCY v0.8.99); hier nur geplant.
    const a = consignmentLineAmounts(it.salePrice, it.taxScheme, consignorPurchaseAmount(econ, it.salePrice));
    const line = added ? undefined : query('SELECT * FROM invoice_lines WHERE invoice_id = ? AND product_id = ? ORDER BY position, id', [invoiceId, productId])[0];
    if (!added && !line) nein('CONSIGNMENT_INVOICE_LINE_NOT_FOUND', `${nr}: the invoice has no line for this consigned item`);
    const changed = added || F(line!.line_total) !== F(a.calc.grossAmount) || s(line!.tax_scheme) !== it.taxScheme;
    if (!added && s(con!.status) !== 'sold' && (changed)) {
      throw new InvoiceActionRejected(CONSIGNMENT_LINE_LOCKED,
        `${nr} is "${s(con!.status)}" (returned after the sale or paid out the old way) — its line stays as it is. Nothing was changed.`);
    }
    const priceChanged = added || F(con!.sale_price) !== F(it.salePrice);
    if (priceChanged && econ.belowFloor && it.acknowledgeShortfall !== true) {
      nein('SALE_BELOW_FLOOR', `${nr}: sale ${it.salePrice} below consignor floor ${econ.floor} — confirm the shortfall (it is booked as Consignor Loss)`);
    }
    if (changed) {
      const ergebnis = consignmentVatShortfall(econ, it.taxScheme, a.persistedVat);
      if (ergebnis !== null && it.acknowledgeVatShortfall !== true) {
        nein(VAT_SHORTFALL_UNCONFIRMED, `${nr}: with VAT 10 % the LATAIF result is ${ergebnis.toFixed(3)} BHD — the commission is taken from the price incl. VAT, the VAT is carried by LATAIF. Confirm the negative result on the line (acknowledgeVatShortfall=true).`);
      }
    }
    return {
      con: con!, id: it.consignmentId, nr, productId, consignorId: s(con!.consignor_id), salePrice: it.salePrice, scheme: it.taxScheme,
      econ, net: a.calc.netAmount, vat: a.persistedVat, gross: a.calc.grossAmount,
      purchaseAmount: consignorPurchaseAmount(econ, it.salePrice), line, changed, added, purchaseId: null,
    };
  });
  // Eine eigene Zeile ist nie ein Kommissionsartikel dieser Korrektur (die stehen im Kommissionsteil).
  const konsArtikel = new Set([...[...gebunden.values()].map((c) => s(c.product_id)), ...teile.map((t) => t.productId)]);
  if (ownLines.some((l) => konsArtikel.has(s(l.productId)))) {
    throw new InvoiceActionRejected(OWN_LINE_IS_CONSIGNMENT,
      'an own-stock line cannot be a consignment item of this invoice — it is corrected in the consignment section. Nothing was changed.');
  }
  // Eine entfernte Kommission mit Rückgabe nach dem Verkauf bleibt (die Rückgabe ist ein eigener Vorgang).
  for (const c of entfernt) {
    if (s(c.status) !== 'sold') {
      throw new InvoiceActionRejected(CONSIGNMENT_LINE_LOCKED,
        `${s(c.consignment_number)} is "${s(c.status)}" — a returned item stays on its invoice (the return is its own document). Nothing was changed.`);
    }
    if (F(c.payout_paid_amount) > 0) {
      nein('CONSIGNOR_PAYOUT_PAID_LEGACY', `${s(c.consignment_number)}: this old sale was already paid out to the consignor — please check it with the accountant`);
    }
  }

  // ── 3. Die Einkäufe beim Einlieferer ──
  const plaene = new Map<string, EinkaufPlan>();
  const planFuer = (pid: string): EinkaufPlan => {
    let p = plaene.get(pid);
    if (!p) { p = einkaufPlanOf(pid, branchId); plaene.set(pid, p); }
    return p;
  };
  // Bleibende Kommissionen: der Einkauf folgt Betrag (E2/E9), Einkaufs-VAT (E10) und Datum (E3).
  const steuerWunsch = corr.purchaseTaxSchemes ?? {};
  for (const t of teile) {
    if (t.added) continue;
    const pid = einkaufDerKommission(t.con, invoiceId, branchId);
    const braucht = t.changed || datumWechsel || Object.keys(steuerWunsch).length > 0;
    if (!pid) {
      if (t.changed) nein(CONSIGNMENT_PURCHASE_UNCLEAR, `${t.nr}: the consignor's purchase of this sale is not clear — its line stays as it is`);
      continue;
    }
    if (!braucht) continue;
    const p = planFuer(pid);
    const z = zeileIn(p, t.id, t.productId);
    if (!z) nein(CONSIGNMENT_PURCHASE_UNCLEAR, `${t.nr}: this item's line in the consignor's purchase ${p.number} is not clear`);
    t.purchaseId = pid;
    t.purchaseLineId = s(z!.id);
    if (t.changed && F(z!.line_total) !== F(t.purchaseAmount)) p.amounts.set(s(z!.id), t.purchaseAmount);
  }
  for (const [pid, v] of Object.entries(steuerWunsch)) {
    const p = plaene.get(pid) ?? (query('SELECT 1 FROM purchases WHERE id = ?', [pid]).length ? planFuer(pid) : undefined);
    if (!p || ![...gebunden.values()].some((c) => einkaufDerKommission(c, invoiceId, branchId) === pid)) {
      nein('PURCHASE_NOT_FOUND', 'a purchase VAT change names a purchase that is not part of this sale');
    }
    const jetzt = new Set(p!.lines.map((l) => schemeOf(l.tax_scheme)));
    if (jetzt.size === 1 && jetzt.has(v)) continue;
    if (p!.everPaid) nein(CONSIGNOR_VAT_LOCKED, `${p!.number}: the consignor was already paid — the VAT of his purchase is fixed after the first payout`);
    p!.scheme = v;
  }
  // E3 — der unbezahlte Einkauf folgt dem Rechnungsdatum; ein (teil)bezahlter behält seins, die Rechnung nie davor.
  if (datumWechsel) {
    for (const p of plaene.values()) {
      if (!p.everPaid) { p.date = neuerTag; continue; }
      const pd = dayOf(p.row.purchase_date);
      if (neuerTag < pd) {
        nein(SALE_BEFORE_PAID_PURCHASE, `the invoice date ${neuerTag} is before the date of the consignor's paid purchase ${p.number} (${pd}), which keeps its date`);
      }
    }
  }
  // E5 — entfernte Kommissionen: unbezahlt an Ort und Stelle (bzw. der ganze Einkauf zurück), bezahlt über D3.
  for (const c of entfernt) {
    const pid = einkaufDerKommission(c, invoiceId, branchId);
    if (!pid) nein(CONSIGNMENT_PURCHASE_UNCLEAR, `${s(c.consignment_number)}: the consignor's purchase of this sale is not clear — use "Cancel Sale" or check it with the accountant`);
    const p = planFuer(pid!);
    const z = zeileIn(p, s(c.id), s(c.product_id));
    if (!z) nein(CONSIGNMENT_PURCHASE_UNCLEAR, `${s(c.consignment_number)}: this item's line in the consignor's purchase ${p.number} is not clear`);
    if (p.creditF > 0) {
      nein('CONSIGNOR_PAID_BY_CREDIT', `${s(c.consignment_number)}: the consignor's purchase ${p.number} was paid with supplier credit — it is not undone automatically; please check it with the accountant`);
    }
    if (consignorOverpaid(p.id)) {
      nein(CONSIGNOR_OVERPAID, `${s(c.consignment_number)}: the consignor's purchase ${p.number} is overpaid from an earlier correction (consignor credit or repayment claim) — settle that first`);
    }
    if (p.settledF > 0) p.returns.push(s(c.id));
    else p.dropLines.add(s(z!.id));
  }
  // E6 — neue Kommissionen: an den unbezahlten Einkauf desselben Einlieferers aus DIESEM Verkauf, sonst ein neuer.
  const lieferantVon = new Map<string, string>();
  const supplierOf = (consignorId: string): string => {
    let v = lieferantVon.get(consignorId);
    if (!v) { v = findOrCreateSupplierForConsignor(consignorId); lieferantVon.set(consignorId, v); }
    return v;
  };
  const kandidaten = new Map<string, string[]>();   // supplierId → Einkäufe dieses Verkaufs
  for (const c of gebunden.values()) {
    const pid = einkaufDerKommission(c, invoiceId, branchId);
    if (!pid) continue;
    const sup = s(query('SELECT supplier_id FROM purchases WHERE id = ?', [pid])[0]?.supplier_id);
    kandidaten.set(sup, [...new Set([...(kandidaten.get(sup) ?? []), pid])]);
  }
  const neueEinkaeufe = new Map<string, Teil[]>();   // consignorId → neue Teile ohne passenden Einkauf
  for (const t of teile) {
    if (!t.added) continue;
    const sup = supplierOf(t.consignorId);
    const ziel = (kandidaten.get(sup) ?? []).map((pid) => planFuer(pid))
      .find((p) => !p.everPaid && !p.hasReturn && s(p.row.status) !== 'CANCELLED'
        && p.dropLines.size + p.returns.length < p.lines.length);
    if (ziel) {
      ziel.appends.push({ consignmentId: t.id, productId: t.productId, amount: t.purchaseAmount });
      t.purchaseId = ziel.id;
    } else {
      neueEinkaeufe.set(t.consignorId, [...(neueEinkaeufe.get(t.consignorId) ?? []), t]);
    }
  }
  const neueVat = corr.consignorTaxSchemes ?? {};
  for (const [consignorId, gruppe] of neueEinkaeufe) {
    const v = neueVat[consignorId];
    if (v !== 'ZERO' && v !== 'VAT_10') {
      nein('CONSIGNOR_VAT_REQUIRED', `${gruppe.map((t) => t.nr).join(', ')}: choose the VAT of the consignor's new purchase — No VAT or VAT 10 %`);
    }
  }

  // Jeder Plan: Summen, Überzahlung, Sperren.
  const ueberzahlt = new Map<string, number>();   // purchaseId → Überzahlung in Fils nach der Korrektur
  const rueckgaben = new Map<string, number>();   // purchaseId → was die D3-Rückgaben zurückfordern (Fils)
  for (const p of plaene.values()) {
    const aendert = p.amounts.size > 0 || p.scheme !== undefined || p.date !== undefined || p.appends.length > 0;
    const allesWeg = p.dropLines.size + p.returns.length === p.lines.length && p.appends.length === 0;
    if (s(p.row.status) === 'CANCELLED') nein('PURCHASE_CANCELLED', `${p.number}: the consignor's purchase is cancelled`);
    if (p.hasReturn && (aendert || p.dropLines.size > 0 || p.returns.length > 0)) {
      nein('CONSIGNMENT_CONSIGNOR_SETTLED', `${p.number}: the consignor's purchase already has a return — it is not changed again automatically`);
    }
    if (p.returns.length > 0 && (aendert || p.dropLines.size > 0)) {
      nein(CONSIGNOR_PURCHASE_MIXED_CHANGE, `${p.number}: the consignor was already paid — save the removal of the line first, then correct the other amounts`);
    }
    if (p.dropLines.size > 0 && allesWeg) { p.cancel = true; p.dropLines.clear(); }
    if (p.returns.length > 0) {
      // Dieselbe Rechnung wie die D3-Rückgabe: die Zeile mindert zuerst den offenen Rest, der Überschuss ist zurückzufordern.
      let offenF = F(p.row.remaining_amount);
      let forderungF = 0;
      const ganz = p.lines.length === 1;
      for (const cid of p.returns) {
        const c = gebunden.get(cid)!;
        const z = zeileIn(p, cid, s(c.product_id))!;
        const wertF = F(z.line_total);
        const zurueckF = ganz ? p.settledF : Math.max(0, wertF - offenF);
        offenF = Math.max(0, offenF - wertF);
        forderungF += zurueckF;
      }
      if (forderungF > 0) rueckgaben.set(p.id, forderungF);
    }
    if (aendert || p.dropLines.size > 0) {
      let totalF = 0;
      for (const l of p.lines) {
        if (p.dropLines.has(s(l.id))) continue;
        totalF += p.amounts.has(s(l.id)) ? F(p.amounts.get(s(l.id))) : F(l.line_total);
      }
      for (const a of p.appends) totalF += F(a.amount);
      if (p.creditF > 0 && totalF < p.settledF) {
        nein('CONSIGNOR_PAID_BY_CREDIT', `${p.number}: the purchase is partly settled with supplier credit (${fmt(p.creditF)}); the corrected total (${fmt(totalF)}) cannot be lower than what is settled (${fmt(p.settledF)})`);
      }
      try { assertSupplierOverpayMutable(p.id, B(p.cashF), B(totalF)); } catch (e) {
        if (e instanceof OverpayCreditRedeemed) nein(e.code, e.message);
        throw e;
      }
      if (totalF < p.cashF) ueberzahlt.set(p.id, p.cashF - totalF);
    }
  }
  // E2/E11 — die Überzahlung steht am Tag, an dem sie entstand: dem späteren von Einkaufsdatum und Zahlungen.
  const ueberTag = new Map<string, string>();
  for (const pid of ueberzahlt.keys()) {
    const p = plaene.get(pid)!;
    const tag = [p.date ?? dayOf(p.row.purchase_date),
      ...query('SELECT paid_at FROM purchase_payments WHERE purchase_id = ? AND voided_at IS NULL', [pid]).map((r) => dayOf(r.paid_at))]
      .filter(Boolean).sort().pop() ?? dayOf(now);
    ueberTag.set(pid, tag);
  }
  const wahlen = corr.consignorOverpay ?? {};
  for (const pid of [...ueberzahlt.keys(), ...rueckgaben.keys()]) {
    const w = wahlen[pid];
    if (w !== 'credit' && w !== 'refund') {
      const betragF = (ueberzahlt.get(pid) ?? 0) + (rueckgaben.get(pid) ?? 0);
      nein(CONSIGNOR_OVERPAY_CHOICE_REQUIRED,
        `${plaene.get(pid)!.number}: the consignor was already paid ${fmt(betragF)} BHD more than he is now owed — choose: keep it as consignor credit (offset) or reclaim it from him`);
    }
  }
  // Fassung jedes Einkaufs, den die Korrektur ändert (eine Auszahlung dazwischen ⇒ Nein).
  for (const p of plaene.values()) {
    const beruehrt = p.cancel || p.returns.length > 0 || p.dropLines.size > 0 || p.amounts.size > 0 || p.scheme !== undefined
      || p.date !== undefined || p.appends.length > 0;
    if (!beruehrt) continue;
    const gesehen = corr.purchaseRevisions?.[p.id];
    if (typeof gesehen !== 'number') nein(CORRECTION_REVISION_REQUIRED, `${p.number}: the correction needs the revision of the consignor's purchase you saw — reload the invoice`);
    const jetzt = Number(p.row.revision ?? 0);
    if (jetzt !== gesehen) nein('RECORD_CHANGED', `the consignor's purchase ${p.number} changed since you opened the invoice (you saw ${gesehen}, it is now ${jetzt}) — reload it`);
  }

  // E9 — die Verlust-Ausgaben. E5/E9 (Owner-Entscheidung): eine schon (teil)bezahlte Ausgabe läuft über DENSELBEN Kern wie
  // die Custom-Order-Kosten (`planCostExpense`/`applyCostExpense`): unbezahlt und ohne Überzahlung folgt die offene Schuld
  // ohne Dialog; eine echte Überzahlung (auch beim Entfernen der Zeile) braucht die Wahl Guthaben oder Rückforderung. Die
  // Originalzahlungen bleiben. Eine unbezahlte Ausgabe wird wie bisher direkt angepasst bzw. storniert.
  type KostenPlan = NonNullable<ReturnType<typeof planCostExpense>>;
  type VerlustRows = ReturnType<typeof verluste>;
  const lossWahl = corr.lossOverpay ?? {};
  const kostenPlanen = (con: Record<string, unknown>, rows: VerlustRows, amounts: ReadonlyMap<string, number>): Map<string, { plan: KostenPlan; at: string }> => {
    const out = new Map<string, { plan: KostenPlan; at: string }>();
    const ueberF = rows.reduce((x, r) => x + Math.max(0, r.settledF - (amounts.get(r.id) ?? r.amountF)), 0);
    const w = lossWahl[s(con.id)];
    if (ueberF > 0 && w !== 'credit' && w !== 'refund') {
      nein(CONSIGNOR_OVERPAY_CHOICE_REQUIRED,
        `${s(con.consignment_number)}: the consignor's guarantee shortfall was already paid (${fmt(rows.reduce((x, r) => x + r.settledF, 0))} BHD) — ${fmt(ueberF)} BHD more than he is now owed. Choose: keep it as consignor credit (offset) or reclaim it from him`);
    }
    for (const r of rows) {
      if (r.settledF === 0) continue;
      const neu = amounts.get(r.id) ?? r.amountF;
      if (neu === r.amountF) continue;
      const at = verlustUeberTag(r.id, now);
      try {
        const kp = planCostExpense(r.id, neu, neu < r.settledF ? w : undefined, branchId, at);
        if (kp) out.set(r.id, { plan: kp, at });
      } catch (e) {
        if (e instanceof GoldRejected) nein(e.code, e.message);
        throw e;
      }
    }
    return out;
  };
  type VerlustPlan = { teil: Teil; rows: VerlustRows; plan: ReturnType<typeof verlustPlan>; kosten: Map<string, { plan: KostenPlan; at: string }> };
  const verlustPlaene: VerlustPlan[] = [];
  for (const t of teile) {
    if (t.added) continue;
    const rows = verluste(t.id, branchId);
    const zielF = F(t.econ.loss);
    const altF = rows.reduce((x, r) => x + r.amountF, 0);
    if (zielF === altF && !datumWechsel) continue;
    const plan = verlustPlan(rows, zielF);
    verlustPlaene.push({ teil: t, rows, plan, kosten: kostenPlanen(t.con, rows, plan.amounts) });
  }
  const entfernteVerluste = new Map<string, { con: Record<string, unknown>; rows: VerlustRows; kosten: Map<string, { plan: KostenPlan; at: string }> }>();
  for (const c of entfernt) {
    const rows = verluste(s(c.id), branchId);
    entfernteVerluste.set(s(c.id), { con: c, rows, kosten: kostenPlanen(c, rows, new Map(rows.map((r) => [r.id, 0]))) });
  }

  // E8/E11 — jede Gegen- und Neubuchung der Einlieferer-Seite in einer offenen Periode, nach dem Eröffnungsstichtag.
  const tage: CorrectionDate[] = [];
  for (const p of plaene.values()) {
    const beruehrt = p.cancel || p.dropLines.size > 0 || p.amounts.size > 0 || p.scheme !== undefined || p.date !== undefined || p.appends.length > 0;
    if (!beruehrt) continue;
    for (const iso of activeSourceDates('PURCHASE', p.id)) tage.push({ iso, what: `the reversal of the consignor's purchase ${p.number}` });
    if (!p.cancel) tage.push({ iso: p.date ?? dayOf(p.row.purchase_date), what: `the consignor's purchase ${p.number}` });
  }
  for (const v of verlustPlaene) for (const r of v.rows) {
    const neu = v.plan.amounts.get(r.id) ?? r.amountF;
    const wandert = datumWechsel && r.settledF === 0;
    if (neu === r.amountF && !wandert) continue;
    for (const iso of activeSourceDates('EXPENSE', r.id)) tage.push({ iso, what: 'the reversal of the consignor loss' });
    if (neu > 0) tage.push({ iso: wandert ? neuerTag : r.date, what: 'the consignor loss' });
  }
  for (const ev of entfernteVerluste.values()) for (const r of ev.rows) {
    for (const iso of activeSourceDates('EXPENSE', r.id)) tage.push({ iso, what: 'the reversal of the consignor loss' });
  }
  if (neueEinkaeufe.size > 0 || teile.some((t) => t.added && t.econ.loss > 0) || verlustPlaene.some((v) => v.plan.extraF > 0)) {
    tage.push({ iso: neuerTag, what: 'the consignor side of this sale' });
  }
  for (const [pid, tag] of ueberTag) tage.push({ iso: tag, what: `the consignor credit from purchase ${plaene.get(pid)!.number}` });
  assertCorrectionDates(branchId, tage);

  beforeWrite?.();

  // ════════════════════════════════ Schreiben ════════════════════════════════
  const db = getDatabase();
  const ctx = { branchId, userId: actor.userId, now };
  useInvoiceStore.getState().loadInvoices();
  useProductStore.getState().loadProducts();
  useCustomerStore.getState().loadCustomers();
  useSupplierStore.getState().loadSuppliers();
  useConsignmentStore.getState().loadConsignments();
  useExpenseStore.getState().loadExpenses();
  const buchung = watchLedgerPosts('mixed invoice correction');
  const vorherEinkauf = new Map([...plaene.values()].map((p) => [p.id, { total: Number(p.row.total_amount ?? 0), date: dayOf(p.row.purchase_date) }]));
  const ergebnisEinkaeufe: MixedInvoiceCorrected['purchases'] = [];
  const claims: MixedInvoiceCorrected['consignorClaims'] = [];

  // a) Einkäufe an Ort und Stelle (vor der Rechnung, damit ein neues Los und der neue Einstand schon da sind):
  //    Gegenbuchung auf den Originaltagen, Zeilenbeträge, Einkaufs-VAT, Datum, angehängte Zeilen.
  const neuerEinstand = new Map<string, number>();   // productId → Einstand des Loses nach der Korrektur
  const neuesLos = new Map<string, string>();         // productId → Los einer neuen Zeile
  const anOrt = [...plaene.values()].filter((p) => !p.cancel && p.returns.length === 0
    && (p.dropLines.size > 0 || p.amounts.size > 0 || p.scheme !== undefined || p.date !== undefined || p.appends.length > 0));
  for (const p of anOrt) {
    if (hasLedgerEntries('PURCHASE', p.id)) reverseSource('PURCHASE', p.id, now, { mirrorOriginalDates: true });
    const datum = p.date ?? dayOf(p.row.purchase_date);
    for (const l of p.lines) {
      const lid = s(l.id);
      if (p.dropLines.has(lid)) continue;
      const neuScheme = p.scheme ?? schemeOf(l.tax_scheme);
      const betrag = p.amounts.has(lid) ? p.amounts.get(lid)! : Number(l.line_total) || 0;
      if (!p.amounts.has(lid) && neuScheme === schemeOf(l.tax_scheme)) continue;
      const lineTotal = R3(betrag);
      const vat = vatOf(lineTotal, neuScheme);
      db.run('UPDATE purchase_lines SET quantity = 1, unit_price = ?, line_total = ?, tax_scheme = ?, vat_rate = ?, vat_amount = ? WHERE id = ?',
        [lineTotal, lineTotal, neuScheme, neuScheme === 'VAT_10' ? 10 : 0, vat, lid]);
      trackChange('purchase_lines', lid, 'update', {});
      const einstand = purchaseLotUnitCost({ qty: 1, unitPrice: lineTotal, lineTotal, vatAmount: vat });
      for (const lot of query(`SELECT id FROM stock_lots WHERE purchase_line_id = ? AND status != 'CANCELLED' AND COALESCE(unit, 'pcs') = 'pcs'`, [lid])) {
        db.run('UPDATE stock_lots SET unit_cost = ? WHERE id = ?', [einstand, s(lot.id)]);
        trackLotRow(s(lot.id), 'update');
      }
      if (l.product_id) neuerEinstand.set(s(l.product_id), einstand);
    }
    if (p.date) {
      db.run(`UPDATE stock_lots SET acquired_at = ? WHERE purchase_id = ? AND status != 'CANCELLED' AND COALESCE(unit, 'pcs') = 'pcs'`, [p.date, p.id]);
      for (const lot of query(`SELECT id FROM stock_lots WHERE purchase_id = ? AND COALESCE(unit, 'pcs') = 'pcs'`, [p.id])) trackLotRow(s(lot.id), 'update');
    }
    if (p.appends.length > 0) {
      // CONSIGNOR-JOINT-PURCHASE — mehr als eine Kommission am Einkauf: die Kommission steht an jeder Zeile, der Kopf wird leer
      // (die Einlieferer-Seite verteilt dann je Zeile, consignor-side.ts).
      const kopf = s(p.row.source_consignment_id);
      if (kopf) {
        for (const l of p.lines) {
          if (!l.source_consignment_id) {
            db.run('UPDATE purchase_lines SET source_consignment_id = ? WHERE id = ?', [kopf, s(l.id)]);
            trackChange('purchase_lines', s(l.id), 'update', {});
          }
        }
        db.run('UPDATE purchases SET source_consignment_id = NULL WHERE id = ?', [p.id]);
      }
      const vat = p.scheme ?? schemeOf(p.lines[0]?.tax_scheme);
      const neu = appendPurchaseLinesInHouse(p.id, datum, p.appends.map((a) => ({
        productId: a.productId, quantity: 1, unitPrice: R3(a.amount), taxScheme: vat, vatRate: vat === 'VAT_10' ? 10 : 0,
        sourceConsignmentId: a.consignmentId,
      })), ctx);
      for (const r of neu) {
        const lot = query(`SELECT id, unit_cost FROM stock_lots WHERE purchase_line_id = ? AND status != 'CANCELLED' LIMIT 1`, [r.id])[0];
        if (lot && r.productId) { neuesLos.set(r.productId, s(lot.id)); neuerEinstand.set(r.productId, Number(lot.unit_cost) || 0); }
      }
    }
    if (p.date) db.run('UPDATE purchases SET purchase_date = ?, updated_at = ? WHERE id = ?', [p.date, now, p.id]);
  }
  // b) Neue Einkäufe (E6: kein unbezahlter Einkauf dieses Einlieferers im Verkauf) — derselbe Weg wie „Record Sale".
  for (const [consignorId, gruppe] of neueEinkaeufe) {
    const vat = neueVat[consignorId] as 'ZERO' | 'VAT_10';
    const purchase = usePurchaseStore.getState().createPurchase({
      supplierId: supplierOf(consignorId),
      purchaseDate: neuerTag,
      notes: `Consignor payout · ${gruppe.map((t) => t.nr).join(', ')}`,
      sourceConsignmentId: gruppe.length === 1 ? gruppe[0].id : undefined,
      lines: gruppe.map((t) => ({
        productId: t.productId, quantity: 1, unitPrice: R3(t.purchaseAmount), taxScheme: vat, vatRate: vat === 'VAT_10' ? 10 : 0,
        sourceConsignmentId: t.id,
      })),
    });
    for (const t of gruppe) {
      t.purchaseId = purchase.id;
      const lot = query(`SELECT sl.id, sl.unit_cost FROM stock_lots sl JOIN purchase_lines pl ON pl.id = sl.purchase_line_id
        WHERE pl.purchase_id = ? AND pl.product_id = ? AND sl.status != 'CANCELLED' LIMIT 1`, [purchase.id, t.productId])[0];
      if (lot) { neuesLos.set(t.productId, s(lot.id)); neuerEinstand.set(t.productId, Number(lot.unit_cost) || 0); }
    }
    ergebnisEinkaeufe.push({ purchaseId: purchase.id, purchaseNumber: purchase.purchaseNumber, action: 'created' });
  }
  // c) Der neue Einstand steht an der Rechnungszeile, BEVOR die Rechnung neu bucht (Wareneinsatz = Los).
  let rebook = false;
  for (const t of teile) {
    if (t.added || !t.line) continue;
    const e = neuerEinstand.get(t.productId);
    if (e === undefined || F(e) === F(t.line.purchase_price_snapshot)) continue;
    db.run('UPDATE invoice_lines SET purchase_price_snapshot = ? WHERE id = ?', [e, s(t.line.id)]);
    rebook = true;
  }

  // d) Die Rechnung — über `editInvoice`, geschachtelt: eigene Zeilen wie gewohnt, Kommissionszeilen mit den Hausbeträgen.
  // VAT-CONSISTENCY (v0.8.99) — Margen-VAT = f(Zeilenbetrag, Einstand der Zeile), dieselbe Zahl wie Wareneinsatz, NBR und
  // Hauptbuch. Eine unveränderte Zeile behält ihre gespeicherte VAT — außer ihr Einstand selbst ändert sich (Einkauf
  // korrigiert, z. B. Einkaufs-VAT gewechselt, Schritt c): dann folgt die Margen-VAT dem neuen Einstand.
  const kommZeilen: EditLine[] = teile.map((t) => {
    if (!t.added && !t.changed) {
      const l = t.line!;
      const einstand = neuerEinstand.get(t.productId);
      const folgt = s(l.tax_scheme) === 'MARGIN' && einstand !== undefined && F(einstand) !== F(l.purchase_price_snapshot);
      return {
        lineId: s(l.id), productId: t.productId, lotId: s(l.lot_id) || undefined, quantity: 1,
        unitPrice: Number(l.unit_price) || 0, purchasePrice: einstand ?? (Number(l.purchase_price_snapshot) || 0),
        taxScheme: s(l.tax_scheme), vatRate: Number(l.vat_rate) || 0,
        vatAmount: folgt ? vatEngine.marginVatOfLine(Number(l.line_total) || 0, einstand!, Number(l.quantity) || 1, Number(l.vat_rate) || 10) : Number(l.vat_amount) || 0,
        lineTotal: Number(l.line_total) || 0, ...(l.description ? { description: s(l.description) } : {}), houseAmounts: true,
      };
    }
    const einstand = neuerEinstand.get(t.productId) ?? (Number(t.line?.purchase_price_snapshot) || 0);
    const base: EditLine = {
      productId: t.productId, quantity: 1, unitPrice: t.net, taxScheme: t.scheme, vatRate: t.scheme === 'ZERO' ? 0 : 10,
      vatAmount: t.scheme === 'MARGIN' ? vatEngine.marginVatOfLine(t.gross, einstand, 1, 10) : t.vat, lineTotal: t.gross, houseAmounts: true,
      purchasePrice: einstand,
    };
    if (t.added) return { ...base, lotId: neuesLos.get(t.productId) };
    return { ...base, lineId: s(t.line!.id), lotId: s(t.line!.lot_id) || undefined,
      ...(t.line!.description ? { description: s(t.line!.description) } : {}) };
  });
  if (teile.some((t) => t.changed)) rebook = true;
  withConsignmentCorrectionPermit(invoiceId, () => withConsignmentSalePermit(teile.filter((t) => t.added).map((t) => t.productId), () => {
    useInvoiceStore.getState().editInvoice(invoiceId, {
      lines: [...ownLines, ...kommZeilen],
      ...(input.customerId !== undefined ? { customerId: input.customerId } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.issuedAt !== undefined ? { issuedAt: input.issuedAt } : {}),
      ...(input.staffId !== undefined ? { staffId: input.staffId } : {}),
      ...(input.deltaPayment ? { deltaPayment: input.deltaPayment } : {}),
      reason: s(input.reason).trim(),
      ...(input.confirmCustomerChange ? { confirmCustomerChange: true } : {}),
      ...(input.overpayChoice ? { overpayChoice: input.overpayChoice } : {}),
      ...(input.refundNow ? { refundNow: input.refundNow } : {}),
      expectedRevision: input.expectedRevision,
      ...(rebook ? { rebook: true } : {}),
    });
  }));

  // e) Entfernte Kommissionen (E5): ihr Stück liegt jetzt wieder im Los — die Einlieferer-Seite zurück.
  for (const p of plaene.values()) {
    if (p.cancel) {
      cancelPurchaseInHouse(p.id, branchId, { now, mirrorOriginalDates: true });
      ergebnisEinkaeufe.push({ purchaseId: p.id, purchaseNumber: p.number, action: 'cancelled' });
      continue;
    }
    for (const lid of p.dropLines) {
      // Wie „Edit purchase → remove line" (Teil 3): das Los storniert (Historie), die Zeile geht; der Artikel bleibt.
      const l = p.lines.find((x) => s(x.id) === lid)!;
      for (const lot of query('SELECT id FROM stock_lots WHERE purchase_line_id = ?', [lid])) {
        db.run(`UPDATE stock_lots SET status = 'CANCELLED' WHERE id = ?`, [s(lot.id)]);
        trackLotRow(s(lot.id), 'update');
      }
      db.run('DELETE FROM purchase_lines WHERE id = ?', [lid]);
      trackChange('purchase_lines', lid, 'delete', {});
      if (l.product_id) syncProductQuantity(s(l.product_id));
      logAuditOrThrow({
        module: 'Purchase', entityType: 'purchase_lines', entityId: lid, action: 'DELETE', field: 'consignment_line',
        oldValue: { productId: s(l.product_id) || null, lineTotal: l.line_total, taxScheme: l.tax_scheme ?? null, consignmentId: l.source_consignment_id ?? null },
        newValue: { purchaseId: p.id, invoiceId, reason: 'consignment line removed from its invoice (entry error)' },
        actor: { branchId, userId: actor.userId },
      });
    }
    for (const cid of p.returns) {
      const c = gebunden.get(cid)!;
      const lage = einkaufLage(p.id);
      const r = einkaufZurueck(c, lage, { mode: 'pending' }, branchId, now, p.lines.length > 1);
      if (r && r.supplierCreditId) {
        const w = wahlen[p.id] as ConsignorOverpayChoice;
        if (w === 'refund') markConsignorRepaymentClaim(r.supplierCreditId);
        claims.push({ purchaseId: p.id, creditId: r.supplierCreditId, amount: r.refundAmount, kind: w });
      }
      ergebnisEinkaeufe.push({ purchaseId: p.id, purchaseNumber: p.number, action: 'returned' });
    }
  }
  // f) Die korrigierten Einkäufe neu gebucht (am Einkaufsdatum), Kopf und Überzahlung (E2).
  for (const p of anOrt) {
    const zeilen = query('SELECT line_total FROM purchase_lines WHERE purchase_id = ?', [p.id]);
    const totalF = zeilen.reduce((x, l) => x + F(l.line_total), 0);
    const settledF = p.settledF;
    const remainingF = Math.max(0, totalF - settledF);
    const status = totalF <= 0 ? 'DRAFT' : settledF <= 0 ? 'UNPAID' : settledF >= totalF ? 'PAID' : 'PARTIALLY_PAID';
    db.run('UPDATE purchases SET total_amount = ?, remaining_amount = ?, status = ?, updated_at = ? WHERE id = ?',
      [B(totalF), B(remainingF), status, now, p.id]);
    if (totalF > 0) {
      const beleg = belegFuerBuchung(p.id);
      postPurchaseReceived(beleg, { occurredAt: beleg.purchaseDate });
    }
    // E2 — die Überzahlung des bezahlten Einlieferers: dieselbe Umgliederung wie jede Einkaufsüberzahlung (Lieferanten-
    // Guthaben), am Tag der späteren von Einkauf und Zahlungen; „Rückforderung" ist dieselbe Zeile, nicht verrechenbar.
    const ueber = ueberzahlt.get(p.id) ?? 0;
    const tag = ueberTag.get(p.id) ?? dayOf(now);
    try { reconcilePurchaseOverpayCredit(p.id, { now: ueber > 0 && tag < dayOf(now) ? `${tag}T12:00:00.000Z` : now }); } catch (e) {
      if (e instanceof OverpayCreditRedeemed) nein(e.code, e.message);
      throw e;
    }
    if (ueber > 0) {
      const credit = query('SELECT id, amount FROM supplier_credits WHERE source_purchase_id = ? AND source_return_id IS NULL', [p.id])[0];
      if (!credit || F(credit.amount) !== ueber) throw new Error(`consignor overpayment ${p.number}: ${fmt(ueber)} expected as credit`);
      const w = wahlen[p.id] as ConsignorOverpayChoice;
      if (w === 'refund') markConsignorRepaymentClaim(s(credit.id), `Repayment claim — consignment correction ${p.number}`);
      claims.push({ purchaseId: p.id, creditId: s(credit.id), amount: B(ueber), kind: w });
    }
    trackChange('purchases', p.id, 'update', {});
    const nachher = query('SELECT total_amount, purchase_date FROM purchases WHERE id = ?', [p.id])[0];
    logAuditOrThrow({
      module: 'Purchase', entityType: 'purchases', entityId: p.id, action: 'UPDATE', field: 'consignment_correction',
      oldValue: vorherEinkauf.get(p.id), newValue: {
        total: Number(nachher?.total_amount ?? 0), date: dayOf(nachher?.purchase_date), invoiceId, reason: s(input.reason).trim(),
        ...(p.scheme ? { vat: p.scheme } : {}), ...(p.appends.length ? { added: p.appends.map((a) => a.consignmentId) } : {}),
        ...(p.dropLines.size ? { removedLines: [...p.dropLines] } : {}), ...(ueber > 0 ? { overpay: B(ueber), choice: wahlen[p.id] } : {}),
      },
      actor: { branchId, userId: actor.userId },
    });
    ergebnisEinkaeufe.push({ purchaseId: p.id, purchaseNumber: p.number, action: 'corrected' });
  }

  // g) Verlust-Ausgaben (E9): unbezahlt angepasst bzw. storniert, Mehrbetrag auf bezahltem Verlust als eigene Ausgabe; eine
  //    (teil)bezahlte über den Kern der Custom-Order-Kosten (offene Schuld folgt; Überzahlung → Guthaben/Rückforderung).
  const lossClaims: MixedInvoiceCorrected['lossClaims'] = [];
  const kostenAusfuehren = (con: Record<string, unknown>, k: { plan: KostenPlan; at: string }): void => {
    const cid = s(con.id);
    const res = applyCostExpense(k.plan, ctx, {
      link: { consignmentId: cid },
      noteFor: (choice, expenseNumber) => `${choice === 'credit' ? 'Consignor loss overpayment' : 'Repayment claim — consignor loss'} ${s(con.consignment_number)} (${expenseNumber})`,
      auditField: 'consignor_loss_overpay', reason: 'consignment-correction', mirrorOriginalDates: true, overpayAt: k.at,
    });
    if (res.overpayCreditId && res.overpay > 0 && res.overpayKind) {
      lossClaims.push({ consignmentId: cid, expenseId: res.expenseId, creditId: res.overpayCreditId, amount: res.overpay, kind: res.overpayKind });
    }
  };
  for (const v of verlustPlaene) {
    for (const r of v.rows) {
      const k = v.kosten.get(r.id);
      if (k) { kostenAusfuehren(v.teil.con, k); continue; }
      if (r.settledF > 0) continue;
      const neuF = v.plan.amounts.get(r.id) ?? r.amountF;
      const wandert = datumWechsel && r.date !== neuerTag;
      if (neuF <= 0) { verlustStornieren(r.id, now); continue; }
      if (neuF === r.amountF && !wandert) continue;
      updateExpenseInHouse(r.id, { ...(neuF !== r.amountF ? { amount: B(neuF) } : {}), ...(wandert ? { expenseDate: neuerTag } : {}) },
        ctx, undefined, { mirrorOriginalDates: true });
    }
    if (v.plan.extraF > 0 || (v.rows.length === 0 && F(v.teil.econ.loss) > 0)) {
      const betragF = v.rows.length === 0 ? F(v.teil.econ.loss) : v.plan.extraF;
      verlustAnlegen(v.teil.con, supplierOf(v.teil.consignorId), B(betragF), v.teil.salePrice, neuerTag);
    }
  }
  for (const ev of entfernteVerluste.values()) {
    for (const r of ev.rows) {
      const k = ev.kosten.get(r.id);
      if (k) kostenAusfuehren(ev.con, k);
      else if (r.settledF === 0) verlustStornieren(r.id, now);
    }
  }
  for (const t of teile) {
    if (t.added && t.econ.loss > 0) verlustAnlegen(t.con, supplierOf(t.consignorId), t.econ.loss, t.salePrice, neuerTag);
  }

  // h) Die Kommissionen: entfernte zurück auf „active" (wie „Cancel Sale"), bleibende und neue mit dem Verkauf.
  for (const c of entfernt) {
    const kid = s(c.id);
    const pid = s(c.product_id);
    const auszahlungen = watchLedgerPosts('consignor payout reversal');
    const umgekehrt = reverseConsignmentPayouts(kid, now);
    auszahlungen();
    db.run(
      `UPDATE products SET stock_status = 'consignment', source_type = 'CONSIGNMENT', quantity = CASE WHEN quantity <= 0 THEN 1 ELSE quantity END, updated_at = ? WHERE id = ?`,
      [now, pid],
    );
    trackUpdate('products', pid, { stockStatus: 'consignment', sourceType: 'CONSIGNMENT', removedFromInvoice: true });
    db.run(
      `UPDATE consignments SET
         status = 'active', sale_price = NULL, buyer_id = NULL, invoice_id = NULL,
         commission_amount = NULL, payout_amount = NULL, payout_paid_amount = 0, payout_status = 'pending',
         payout_method = NULL, payout_date = NULL, payout_reference = NULL, sale_method = NULL, updated_at = ?
       WHERE id = ?`,
      [now, kid],
    );
    trackUpdate('consignments', kid, { status: 'active', removedFromInvoice: invoiceId });
    logAuditOrThrow({
      module: 'Commission', entityType: 'consignments', entityId: kid, action: 'STATUS_CHANGE', field: 'invoice_line_removed',
      oldValue: { status: s(c.status), invoiceId, salePrice: c.sale_price ?? null, payoutAmount: c.payout_amount ?? null },
      newValue: { status: 'active', reason: s(input.reason).trim(), reversedPayouts: umgekehrt },
      actor: { branchId, userId: actor.userId },
    });
  }
  for (const t of teile) {
    const vorher = { status: s(t.con.status), salePrice: t.con.sale_price ?? null, buyerId: t.con.buyer_id ?? null,
      payoutAmount: t.con.payout_amount ?? null, commissionAmount: t.con.commission_amount ?? null };
    const kundeWechsel = s(t.con.buyer_id) !== neuerKunde;
    if (!t.added && !t.changed && !kundeWechsel) continue;
    db.run(
      `UPDATE consignments SET status = 'sold', sale_price = ?, buyer_id = ?, commission_amount = ?, payout_amount = ?, invoice_id = ?,
         updated_at = ? WHERE id = ?`,
      [t.salePrice, neuerKunde, t.econ.commission, t.econ.payout, invoiceId, now, t.id],
    );
    trackUpdate('consignments', t.id, { status: 'sold', salePrice: t.salePrice, buyerId: neuerKunde, invoiceId });
    // Der Einstand am Artikel (Anzeige): nur wo er noch der Platzhalter bzw. der Betrag des alten Einkaufs ist.
    const altBetrag = t.added ? 0 : Number(t.con.payout_amount ?? 0);
    db.run(`UPDATE products SET last_sale_price = ?, purchase_price = CASE WHEN COALESCE(purchase_price, 0) = 0 OR ABS(COALESCE(purchase_price, 0) - ?) < 0.0005 OR ABS(COALESCE(purchase_price, 0) - ?) < 0.0005 THEN ? ELSE purchase_price END, updated_at = ? WHERE id = ?`,
      [t.salePrice, altBetrag, Number(t.con.sale_price ?? 0), R3(t.purchaseAmount), now, t.productId]);
    trackProductRow(t.productId);
    logAuditOrThrow({
      module: 'Commission', entityType: 'consignments', entityId: t.id, action: t.added ? 'STATUS_CHANGE' : 'UPDATE',
      field: t.added ? 'invoice_line_added' : 'sale_corrected', oldValue: vorher,
      newValue: { status: 'sold', invoiceId, salePrice: t.salePrice, taxScheme: t.scheme, buyerId: neuerKunde,
        commission: R3(t.econ.commission), payout: R3(t.econ.payout), loss: R3(t.econ.loss), purchaseId: t.purchaseId,
        reason: s(input.reason).trim() },
      actor: { branchId, userId: actor.userId },
    });
  }

  // i) Das Protokoll der ganzen Korrektur — in DERSELBEN Transaktion (die Rechnung selbst protokolliert `editInvoice`).
  const result: MixedInvoiceCorrected = {
    invoiceId,
    removed: entfernt.map((c) => s(c.id)),
    added: teile.filter((t) => t.added).map((t) => t.id),
    corrected: teile.filter((t) => !t.added && t.changed).map((t) => t.id),
    purchases: ergebnisEinkaeufe,
    consignorClaims: claims,
    lossClaims,
  };
  logAuditOrThrow({
    module: 'Invoice', entityType: 'invoices', entityId: invoiceId, action: 'UPDATE', field: 'mixed_invoice_correction',
    newValue: { ...result, reason: s(input.reason).trim(), role: actor.role ?? null, ownLines: ownLines.length },
    actor: { branchId, userId: actor.userId },
  });
  buchung();
  return result;
}

/**
 * MIXED-INVOICE E7 (Owner A) — der gewöhnliche Änderungsweg (ältere Maske) stellt eine Kommissionszeile auf VAT 10 % um: macht
 * das das LATAIF-Ergebnis negativ, ist das ohne Bestätigung kein Speichern (die Bestätigung trägt nur die Korrekturfolge).
 * Rückgabe: die Meldung, sonst `null`.
 */
export function plainEditVatShortfall(invoiceId: string, branchId: string, lines: ReadonlyArray<{ productId?: string; taxScheme: string }>): string | null {
  for (const c of query('SELECT * FROM consignments WHERE invoice_id = ? AND branch_id = ?', [invoiceId, branchId])) {
    const l = lines.find((x) => x.productId === s(c.product_id));
    if (!l || l.taxScheme !== 'VAT_10') continue;
    const alt = query('SELECT tax_scheme FROM invoice_lines WHERE invoice_id = ? AND product_id = ? LIMIT 1', [invoiceId, s(c.product_id)])[0];
    if (s(alt?.tax_scheme) === 'VAT_10') continue;
    const preis = Number(c.sale_price) || 0;
    const econ = computeConsignmentSale(rowToConsignment(c), preis);
    const a = consignmentLineAmounts(preis, 'VAT_10', econ.payout);
    const ergebnis = consignmentVatShortfall(econ, 'VAT_10', a.persistedVat);
    if (ergebnis !== null) {
      return `${s(c.consignment_number)}: with VAT 10 % the LATAIF result is ${ergebnis.toFixed(3)} BHD — confirm the negative result in the invoice correction (update this computer if the confirmation is missing). Nothing was changed.`;
    }
  }
  return null;
}

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

/** „Save Changes" am Primary — exklusiv, in EINER Transaktion, mit der Rolle der Sitzung. */
export function correctMixedInvoiceOnPrimary(input: MixedInvoiceCorrectionInput): Promise<MixedInvoiceCorrected> {
  return runOnPrimary(() => correctMixedInvoiceInHouse(input, currentBranchId(), localConsignmentActor()), frischLesen);
}
