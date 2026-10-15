// ════════════════════════════════════════════════════════════════════════════
// SETTLEMENT S2 — „Receive Payment" für einen Kunden über seine offenen Rechnungen (Gegenstück zu „Pay Supplier — Bulk").
//
//   A. Einzelne Posten: der Benutzer verteilt den Betrag selbst (manual) — je Rechnung höchstens ihr Offenes, Summe = Betrag.
//   B. Vom Gesamtsaldo: der Primary verteilt (fifo) — älteste Rechnung zuerst, nachvollziehbar je Rechnung.
//
// Jede Teilzahlung läuft über den VORHANDENEN Rechnungszahlungsweg (`recordInvoicePaymentInHouse`): dieselbe Zahlung,
// derselbe Statuswechsel, dieselbe Endnummer, dieselbe Kartengebühr, dieselbe Buchung (Soll Kasse/Bank/Karte, Haben
// Forderung des Kunden), derselbe VAT-Periodenschutz — alles in EINER Transaktion (Primary: runOnPrimary; PC2: der
// Fernbefehl `customers.settle`). Kein neuer Umsatz, keine neue VAT, keine erfundene Rechnung.
//
// „Offen" ist dieselbe Zahl wie in Receivables und im Hauptbuch: Brutto − gezahlt − Forderungsstorno der Gutschriften.
// Ein Betrag über dem Offenen wird NIE still überzahlt: ohne ausdrückliche Wahl (`confirmExcessAsCredit`) abgewiesen;
// mit Wahl wird der Rest nach der bestehenden Guthabenregel zu Store-Guthaben (Überzahlung der jüngsten zugeordneten
// Rechnung ohne Gutschrift → customer_credits + CUSTOMER_CREDIT, einlösbar wie bisher).
//
// Eröffnungsposten (OB-…) sind hier sichtbar, aber NICHT bezahlbar, solange ihre Buchung nicht freigeschaltet ist.
// Ein Erlass (Nachlass, Forderungsverzicht, uneinbringlich) ist hier NICHT möglich: Buchung und VAT bestätigt erst der
// Buchhalter (W1–W3) — die Vorschau rechnet ihn aus, schreiben kann ihn kein Weg.
// ════════════════════════════════════════════════════════════════════════════
import { query } from '@/core/db/helpers';
import { runOnPrimary } from '@/core/data/primary-action';
import { InvoiceActionRejected } from '@/core/invoices/invoice-cancel';
import { assertInvoiceHouse, localInvoiceBranch } from '@/core/invoices/invoice-house-guards';
import { INVOICE_PAYMENT_METHODS, recordInvoicePaymentInHouse } from '@/core/invoices/invoice-payment-house';
import { INVOICE_CARD_BRANDS, type InvoiceCardBrand } from '@/core/invoices/invoice-create-house';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { useCustomerStore } from '@/stores/customerStore';
import { openingItemsFor, type OpeningItem } from './opening-balances';
import type { BusinessReadContext } from '@/core/data/read-context';

const nein = (code: string, msg: string): InvoiceActionRejected => new InvoiceActionRejected(code, `${msg} — nothing was paid`);
const toFils = (n: number): number => Math.round(n * 1000);
const B = (f: number): number => f / 1000;

/**
 * Der Erlass (Nachlass / Forderungsverzicht / uneinbringliche Forderung) ist AUS: Gegenkonto, VAT-Korrektur und Beleg
 * bestätigt erst der Buchhalter (W1–W3, docs/opening-balances-contract.md). Es gibt keinen Weg, der ihn schreibt.
 */
export const WAIVER_BOOKING = {
  active: false as const,
  reason: 'Debt waiver / write-off is not available yet: the booking and VAT rules for an agreed discount, a waiver and an uncollectible debt wait for the accountant (W1–W3).',
};

export interface SettlementInvoice { id: string; number: string; date: string; totalF: number; openF: number; cnCancelF: number }

/** Die offenen Rechnungen eines Kunden in DIESER Filiale, älteste zuerst — dieselbe Regel wie Receivables. */
export function customerSettlementInvoices(customerId: string, branchId: string): SettlementInvoice[] {
  return query(
    `SELECT i.id, i.invoice_number, COALESCE(i.issued_at, i.created_at) AS d, i.created_at, i.gross_amount, i.paid_amount,
            COALESCE(cn.cancel_amount, 0) AS cn
       FROM invoices i
       LEFT JOIN (SELECT invoice_id, SUM(receivable_cancel_amount) AS cancel_amount FROM credit_notes WHERE status != 'CANCELLED' GROUP BY invoice_id) cn
         ON cn.invoice_id = i.id
      WHERE i.customer_id = ? AND i.branch_id = ? AND i.status NOT IN ('CANCELLED', 'DRAFT', 'RETURNED')
      ORDER BY d, i.created_at, i.invoice_number`,
    [customerId, branchId],
  ).map((r) => {
    const totalF = toFils(Number(r.gross_amount) || 0);
    const cnCancelF = toFils(Number(r.cn) || 0);
    return { id: String(r.id), number: String(r.invoice_number ?? ''), date: String(r.d ?? '').slice(0, 10), totalF, cnCancelF,
      openF: totalF - toFils(Number(r.paid_amount) || 0) - cnCancelF };
  }).filter((i) => i.openF > 5);   // wie Receivables: unter 0,005 BHD ist nichts offen
}

export interface SettlementAllocation { invoiceId: string; amountF: number }
export interface SettlementPlan { allocations: SettlementAllocation[]; excessF: number }

/** Rein rechnend — dieselbe Verteilung für die Vorschau der Maske und das Haus. */
export function planCustomerSettlement(
  items: readonly SettlementInvoice[], amountF: number, mode: 'fifo' | 'manual', manual: readonly SettlementAllocation[] = [],
): SettlementPlan {
  if (!(amountF > 0)) throw nein('PAYMENT_AMOUNT_INVALID', 'the amount must be above 0');
  if (mode === 'manual') {
    if (manual.length === 0) throw nein('ALLOCATION_REQUIRED', 'choose the invoices this payment is for');
    const seen = new Set<string>();
    let sumF = 0;
    const allocations: SettlementAllocation[] = [];
    for (const a of manual) {
      if (seen.has(a.invoiceId)) throw nein('ALLOCATION_DUPLICATE', 'one allocation per invoice');
      seen.add(a.invoiceId);
      const item = items.find((i) => i.id === a.invoiceId);
      if (!item) throw nein('ALLOCATION_UNKNOWN_ITEM', `invoice ${a.invoiceId} is not open for this customer`);
      if (!(a.amountF > 0)) throw nein('ALLOCATION_INVALID', 'an allocation must be positive');
      if (a.amountF > item.openF) throw nein('ALLOCATION_EXCEEDS_REMAINING', `${item.number}: ${B(a.amountF).toFixed(3)} is more than its open ${B(item.openF).toFixed(3)}`);
      allocations.push({ invoiceId: a.invoiceId, amountF: a.amountF });
      sumF += a.amountF;
    }
    if (sumF !== amountF) throw nein('ALLOCATION_SUM_MISMATCH', `the allocations (${B(sumF).toFixed(3)}) do not match the payment (${B(amountF).toFixed(3)})`);
    return { allocations, excessF: 0 };
  }
  const allocations: SettlementAllocation[] = [];
  let pool = amountF;
  for (const item of items) {
    if (pool <= 0) break;
    const take = Math.min(pool, item.openF);
    if (take > 0) { allocations.push({ invoiceId: item.id, amountF: take }); pool -= take; }
  }
  return { allocations, excessF: pool };
}

/**
 * Die Vorschau „Zahlung + Erlass" (Beispiel: offen 1.000, gezahlt 900, erlassen 100, Rest 0). Rechnet nur — der Erlass
 * wird nirgends geschrieben (WAIVER_BOOKING). Zahlung und Erlass bleiben getrennte Größen; Erlass gilt nie als gezahlt.
 */
export function previewPaymentAndWaiver(openF: number, paymentF: number, waiverF: number): { paidF: number; waivedF: number; restF: number; overF: number } {
  const paidF = Math.max(0, paymentF);
  const waivedF = Math.max(0, Math.min(waiverF, Math.max(0, openF - paidF)));
  const restF = Math.max(0, openF - paidF - waivedF);
  return { paidF, waivedF, restF, overF: Math.max(0, paidF + Math.max(0, waiverF) - openF) };
}

export interface CustomerSettleRequest {
  customerId: string;
  amount: number;
  method: string;
  cardBrand?: InvoiceCardBrand;
  notes?: string;
  mode: 'fifo' | 'manual';
  allocations?: ReadonlyArray<{ invoiceId: string; amount: number }>;
  /** Ausdrücklich: ein Betrag über dem Offenen wird Store-Guthaben (bestehende Überzahlungsregel). */
  confirmExcessAsCredit?: boolean;
}

export interface CustomerSettled {
  customerId: string;
  amount: number;
  method: string;
  allocations: Array<{ invoiceId: string; invoiceNumber: string; amount: number; paymentId: string; status: string; openAfter: number }>;
  excessAmount: number;
  excessTo: 'store_credit' | null;
  excessInvoiceId: string | null;
}

/** In der Transaktion des Aufrufers: eine Zahlung des Kunden auf seine offenen Rechnungen verteilen und buchen. */
export function settleCustomerInHouse(req: CustomerSettleRequest, branchId: string): CustomerSettled {
  assertInvoiceHouse(branchId);
  if (typeof req.customerId !== 'string' || !req.customerId.trim()) throw nein('CUSTOMER_REQUIRED', 'choose the customer');
  if (!query("SELECT 1 FROM customers WHERE id = ? AND branch_id = ? AND id NOT LIKE 'sys-%'", [req.customerId, branchId])[0]) {
    throw nein('CUSTOMER_NOT_FOUND', 'no such customer in this branch');
  }
  if (typeof req.amount !== 'number' || !Number.isFinite(req.amount) || req.amount <= 0) throw nein('PAYMENT_AMOUNT_INVALID', 'the amount must be above 0');
  const amountF = toFils(req.amount);
  if (Math.abs(req.amount * 1000 - amountF) > 1e-6) throw nein('PAYMENT_AMOUNT_INVALID', 'the amount has at most 3 decimals (fils)');
  if (!(INVOICE_PAYMENT_METHODS as readonly string[]).includes(req.method)) throw nein('PAYMENT_METHOD_INVALID', `unknown payment method: ${req.method || '(none)'}`);
  if (req.cardBrand !== undefined && !(INVOICE_CARD_BRANDS as readonly string[]).includes(req.cardBrand)) throw nein('PAYMENT_METHOD_INVALID', 'unknown card brand');
  if (req.mode !== 'fifo' && req.mode !== 'manual') throw nein('PAY_MODE_INVALID', 'mode is fifo or manual');
  if (req.mode === 'fifo' && (req.allocations?.length ?? 0) > 0) throw nein('ALLOCATION_INVALID', 'FIFO decides the allocation — send none');

  const items = customerSettlementInvoices(req.customerId, branchId);
  if (items.length === 0) throw nein('CUSTOMER_NOTHING_OPEN', 'this customer has no open invoice');
  const manual = (req.allocations ?? []).map((a) => ({ invoiceId: String(a.invoiceId), amountF: toFils(Number(a.amount)) }));
  const plan = planCustomerSettlement(items, amountF, req.mode, manual);

  // Der Rest über dem Offenen: nie still. Er wird — ausdrücklich gewählt — die Überzahlung der jüngsten zugeordneten
  // Rechnung ohne Gutschrift; dort trennt der vorhandene Zahlungsweg ihn exakt als Store-Guthaben ab.
  let excessInvoiceId: string | null = null;
  if (plan.excessF > 0) {
    if (req.confirmExcessAsCredit !== true) {
      throw nein('PAYMENT_EXCEEDS_OPEN', `the payment is ${B(plan.excessF).toFixed(3)} more than everything open (${B(amountF - plan.excessF).toFixed(3)}) — choose explicitly to keep the rest as store credit, or lower the amount`);
    }
    const carrier = [...plan.allocations].reverse().find((a) => (items.find((i) => i.id === a.invoiceId)?.cnCancelF ?? 1) === 0);
    if (!carrier) throw nein('EXCESS_NOT_POSSIBLE', 'the rest cannot become store credit on these invoices (credit notes) — lower the amount');
    carrier.amountF += plan.excessF;
    excessInvoiceId = carrier.invoiceId;
  }

  const out: CustomerSettled = {
    customerId: req.customerId, amount: B(amountF), method: req.method, allocations: [],
    excessAmount: B(plan.excessF), excessTo: plan.excessF > 0 ? 'store_credit' : null, excessInvoiceId,
  };
  for (const a of plan.allocations) {
    const r = recordInvoicePaymentInHouse({
      invoiceId: a.invoiceId, amount: B(a.amountF), method: req.method,
      ...(req.notes ? { notes: req.notes } : {}), ...(req.cardBrand ? { cardBrand: req.cardBrand } : {}),
    }, branchId);
    const item = items.find((i) => i.id === a.invoiceId)!;
    out.allocations.push({
      invoiceId: a.invoiceId, invoiceNumber: r.invoiceNumber, amount: B(a.amountF), paymentId: r.paymentId, status: r.status,
      openAfter: B(Math.max(0, item.openF - a.amountF)),
    });
  }
  return out;
}

export interface CustomerSettlementRead {
  invoices: Array<{ id: string; number: string; date: string; total: number; open: number; hasCreditNote: boolean }>;
  openTotal: number;
  /** Eröffnungsposten des Kunden: sichtbar, nicht bezahlbar (Buchung noch nicht freigeschaltet). */
  openingItems: OpeningItem[];
  waiver: typeof WAIVER_BOOKING;
}

/** Was die Maske „Receive Payment" zeigt — am Primary lokal, am PC2 als Teil von `parties.account.get`. */
export function customerSettlementFor(ctx: BusinessReadContext | { branchId: string }, customerId: string): CustomerSettlementRead {
  const items = customerSettlementInvoices(customerId, ctx.branchId);
  return {
    invoices: items.map((i) => ({ id: i.id, number: i.number, date: i.date, total: B(i.totalF), open: B(i.openF), hasCreditNote: i.cnCancelF > 0 })),
    openTotal: B(items.reduce((s, i) => s + i.openF, 0)),
    openingItems: openingItemsFor(ctx, 'CUSTOMER', customerId).filter((i) => i.status === 'RECORDED'),
    waiver: WAIVER_BOOKING,
  };
}

function frischLesen(): void {
  useInvoiceStore.getState().loadInvoices();
  useCustomerStore.getState().loadCustomers();
}

/** „Receive Payment" am Primary: exklusiv, EINE Transaktion, danach durabel. */
export function settleCustomerOnPrimary(req: CustomerSettleRequest): Promise<CustomerSettled> {
  const branchId = localInvoiceBranch();
  return runOnPrimary(() => settleCustomerInHouse(req, branchId), frischLesen);
}
