// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6E — „Rechnung anlegen" samt Zahlung: EINE Folge, EINE Klammer.
//
// Was vorher geschah (auditiert, nicht angenommen): die Maske „Direct Sale" rief ZWEI Store-
// Aufrufe hintereinander — `createDirectInvoice`, dann `recordPayment` — ohne gemeinsame
// Transaktion. Scheiterte die Zahlung, blieb eine unbezahlte Rechnung stehen: Bestand verbraucht,
// PINV-Nummer verbraucht, Forderung gebucht. Die Maske zeigte den Fehler, der Mensch speicherte
// erneut — und hatte zwei Rechnungen. Ein gescheiterter Buchungssatz der Zahlung wurde außerhalb
// einer Transaktion sogar still verschluckt (`safePost`): Zahlung ohne Buchung. PC2 konnte das
// Ganze gar nicht (`invoices.create` kannte keine Zahlung, die Maske sagte ehrlich Nein).
//
// Jetzt: `createInvoiceInHouse` legt an und bucht die Zahlung in der Transaktion des Aufrufers
// (`runOnPrimary` an der Maske, `runRemoteCommand` für PC2). Beide Store-Funktionen schlucken
// Buchungsfehler; der Wächter `watchLedgerPosts` macht daraus ein Nein für die GANZE Handlung.
// Nachgebaut wird nichts: Nummernkreis (PINV, bei Vollzahlung INV/SINV), Lose, Steuer, Einstand,
// Forderung, Kartengebühr als Auto-Ausgabe, Buchungen — alles bleibt in den Store-Funktionen.
//
// Die Regeln kommen aus vorhandenen Verträgen: die Zahlarten sind die vier Knöpfe der Maske; eine
// Überzahlung beim ANLEGEN weist die Maske ab (`validate`: „Paid exceeds total" — eine Überzahlung
// läuft bewusst über die Zahlung auf der Rechnungsseite und wird dort Guthaben); Kunde, Artikel und
// Mitarbeiter müssen in der Filiale existieren, deren Bücher der Primary führt.
// ════════════════════════════════════════════════════════════════════════════
import { query } from '@/core/db/helpers';
import { runOnPrimary } from '@/core/data/primary-action';
import { watchLedgerPosts } from '@/core/ledger/posting';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { useProductStore } from '@/stores/productStore';
import { InvoiceActionRejected } from './invoice-cancel';
import { assertInvoiceHouse, localInvoiceBranch } from './invoice-house-guards';

/** Die Zahlarten der Maske („4 · PAYMENT": Cash, Bank, Card, Benefit) — keine weitere. */
export const INVOICE_CREATE_PAYMENT_METHODS = ['cash', 'bank_transfer', 'card', 'benefit'] as const;
export type InvoiceCreatePaymentMethod = typeof INVOICE_CREATE_PAYMENT_METHODS[number];
/** Die Kartenmarken der Maske (Normal 2,2 % / Amex 2,5 %). */
export const INVOICE_CARD_BRANDS = ['normal', 'amex'] as const;
export type InvoiceCardBrand = typeof INVOICE_CARD_BRANDS[number];

export const INVOICE_NEEDS_A_LINE = 'INVOICE_NEEDS_A_LINE';
export const CUSTOMER_NOT_FOUND = 'CUSTOMER_NOT_FOUND';
export const EMPLOYEE_NOT_FOUND = 'EMPLOYEE_NOT_FOUND';
export const PRODUCT_NOT_FOUND = 'PRODUCT_NOT_FOUND';
export const PAYMENT_AMOUNT_INVALID = 'PAYMENT_AMOUNT_INVALID';
export const PAYMENT_METHOD_INVALID = 'PAYMENT_METHOD_INVALID';
export const PAYMENT_EXCEEDS_TOTAL = 'PAYMENT_EXCEEDS_TOTAL';

/** Die Zahlung, die ein Mensch beim Anlegen eingibt: Betrag, Weg, bei Karte die Marke. Mehr nicht. */
export interface InvoiceCreatePayment {
  amount: number;
  method: InvoiceCreatePaymentMethod;
  cardBrand?: InvoiceCardBrand;
}

/** Eine Zeile, wie `createDirectInvoice` sie erwartet — gerechnet von `toInvoiceLine` (Maske) bzw. `buildInvoiceLines` (fern). */
export type InvoiceCreateLine = Parameters<ReturnType<typeof useInvoiceStore.getState>['createDirectInvoice']>[1][number];

export interface InvoiceCreateInput {
  customerId: string;
  lines: InvoiceCreateLine[];
  notes?: string;
  /** YYYY-MM-DD (die Maske) — `createDirectInvoice` macht daraus Mitternacht UTC. */
  issuedDate?: string;
  staffId?: string;
  /** Die Wahl aus dem Nummern-Dialog: gilt für die Endnummer, wenn diese Zahlung die Rechnung schließt. */
  specialMark: boolean;
  payment?: InvoiceCreatePayment;
}

export interface InvoiceCreated {
  invoiceId: string;
  /** Die Nummer NACH der Handlung — bei Vollzahlung schon die Endnummer (INV/SINV). */
  invoiceNumber: string;
  grossAmount: number;
  status: string;
  paidAmount: number;
  specialMark: boolean;
  revision: number;
  paymentId?: string;
}

const toFils = (v: number): number => Math.round(v * 1000);

/**
 * Die Zahlung prüfen — rein, ohne Datenbank: die Maske fragt damit vor dem Schicken nicht, aber der
 * Fernbefehl prüft damit den Rumpf und die Hausfolge noch einmal (derselbe Satz Regeln).
 */
export function invoiceCreatePayment(raw: Record<string, unknown>): InvoiceCreatePayment {
  const amount = raw.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new InvoiceActionRejected(PAYMENT_AMOUNT_INVALID, 'the paid amount must be a positive number');
  }
  const method = raw.method;
  if (typeof method !== 'string' || !(INVOICE_CREATE_PAYMENT_METHODS as readonly string[]).includes(method)) {
    throw new InvoiceActionRejected(PAYMENT_METHOD_INVALID,
      `payment method must be one of ${INVOICE_CREATE_PAYMENT_METHODS.join(', ')}`);
  }
  const out: InvoiceCreatePayment = { amount, method: method as InvoiceCreatePaymentMethod };
  if (raw.cardBrand !== undefined) {
    if (typeof raw.cardBrand !== 'string' || !(INVOICE_CARD_BRANDS as readonly string[]).includes(raw.cardBrand)) {
      throw new InvoiceActionRejected(PAYMENT_METHOD_INVALID, 'unknown card brand');
    }
    out.cardBrand = raw.cardBrand as InvoiceCardBrand;
  }
  return out;
}

function createdState(invoiceId: string, paymentId?: string): InvoiceCreated {
  const r = query(
    'SELECT invoice_number, status, gross_amount, paid_amount, special_mark, revision FROM invoices WHERE id = ?',
    [invoiceId],
  )[0];
  const out: InvoiceCreated = {
    invoiceId,
    invoiceNumber: String(r?.invoice_number ?? ''),
    grossAmount: Number(r?.gross_amount ?? 0),
    status: String(r?.status ?? ''),
    paidAmount: Number(r?.paid_amount ?? 0),
    specialMark: Number(r?.special_mark ?? 0) === 1,
    revision: Number(r?.revision ?? 0),
  };
  if (paymentId) out.paymentId = paymentId;
  return out;
}

/**
 * „Save Invoice": Rechnung, Zeilen, Bestandsabzug, Forderung — und, wenn ein Betrag eingegeben ist,
 * die Zahlung samt Aufteilung, Endnummer und Kartengebühr. Zusammen oder gar nicht. Erst wird
 * geprüft (aus der Datenbank, in der Filiale des Auftrags), dann geschrieben: ein Nein verbraucht
 * keine Nummer und keinen Bestand.
 */
export function createInvoiceInHouse(input: InvoiceCreateInput, branchId: string): InvoiceCreated {
  assertInvoiceHouse(branchId);
  const customerId = typeof input.customerId === 'string' ? input.customerId.trim() : '';
  if (!customerId || !query('SELECT id FROM customers WHERE id = ? AND branch_id = ?', [customerId, branchId])[0]) {
    throw new InvoiceActionRejected(CUSTOMER_NOT_FOUND, 'no such client in this branch');
  }
  if (input.staffId && !query('SELECT id FROM employees WHERE id = ? AND branch_id = ?', [input.staffId, branchId])[0]) {
    throw new InvoiceActionRejected(EMPLOYEE_NOT_FOUND, 'no such employee in this branch');
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new InvoiceActionRejected(INVOICE_NEEDS_A_LINE, 'an invoice needs at least one line');
  }
  for (const l of input.lines) {
    if (!query('SELECT id FROM products WHERE id = ? AND branch_id = ?', [l.productId, branchId])[0]) {
      throw new InvoiceActionRejected(PRODUCT_NOT_FOUND, 'no such article in this branch');
    }
  }
  const payment = input.payment ? invoiceCreatePayment(input.payment as unknown as Record<string, unknown>) : undefined;
  if (payment) {
    // Dieselbe Summe, die `createDirectInvoice` gleich schreibt (v0.7.1: Summe der Zeilensummen),
    // in Fils verglichen — und dieselbe Regel wie `validate` der Maske im Anlege-Modus.
    const gross = input.lines.reduce((s, l) => s + (Number(l.lineTotal) || 0), 0);
    if (toFils(payment.amount) > toFils(gross)) {
      throw new InvoiceActionRejected(PAYMENT_EXCEEDS_TOTAL,
        `Paid (${payment.amount.toFixed(3)}) exceeds total (${gross.toFixed(3)}) — an overpayment is recorded on the invoice page, where it becomes store credit`);
    }
  }

  const buchung = watchLedgerPosts('invoice create');
  const inv = useInvoiceStore.getState().createDirectInvoice(
    customerId, input.lines, input.notes || undefined, input.issuedDate, undefined, input.staffId || undefined,
    input.specialMark === true,
  );
  // `createDirectInvoice` gibt die Rechnung aus SEINER frisch geladenen Liste zurück — fehlt sie dort,
  // stimmt etwas mit der Filiale nicht, und die Zahlung liefe ins Leere. Also kein Weiter.
  if (!inv?.id) throw new Error('the invoice was not created');
  let paymentId: string | undefined;
  if (payment) {
    // Dieselbe Wahl wie bisher an der Maske: die Nummernart gilt, wenn DIESE Zahlung schließt;
    // sonst bleibt die Marke, mit der die Rechnung angelegt wurde.
    paymentId = useInvoiceStore.getState().recordPayment(
      inv.id, payment.amount, payment.method, undefined, input.specialMark === true,
      payment.method === 'card' ? payment.cardBrand : undefined,
    );
  }
  buchung();
  return createdState(inv.id, paymentId);
}

/** Die Listen, die die Maske danach zeigt — auch nach einem Rollback. */
function frischLesen(): void {
  useInvoiceStore.getState().loadInvoices();
  useProductStore.getState().loadProducts();
}

/** „Save Invoice" am Primary: exklusiv, EINE Transaktion, danach durabel. */
export async function createInvoiceOnPrimary(input: InvoiceCreateInput): Promise<InvoiceCreated> {
  const branchId = localInvoiceBranch();
  return runOnPrimary(() => createInvoiceInHouse(input, branchId), frischLesen);
}

/**
 * Die Zahlung, wie die Maske sie meint — für beide Anschlüsse dieselbe: kein Betrag, keine Zahlung;
 * die Kartenmarke nur bei Karte.
 */
export function invoiceCreatePaymentBody(
  paidAmount: number, method: string, cardBrand: InvoiceCardBrand,
): Record<string, unknown> | undefined {
  if (!(paidAmount > 0)) return undefined;
  return { amount: paidAmount, method, ...(method === 'card' ? { cardBrand } : {}) };
}
