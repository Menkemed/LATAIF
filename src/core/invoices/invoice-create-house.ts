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
// BULK METAL V1 — Bulk-Absichten werden hier zu Zeilen (Zuteilung in DIESER Transaktion).
import { resolveBulkIntents } from '@/core/bulk/bulk-invoice';
// v0.8.87 — die Kartenarten aus der EINEN Quelle (Normal / Amex / Debit); das Zahlungsdatum nach der EINEN Datumsregel.
import { CARD_BRANDS, type CardBrand } from '@/core/finance/card-fees';
import { relabelCardFees } from '@/core/finance/card-fee-booking';
import { formatInvoiceDisplay } from '@/core/utils/invoiceNumber';
import { businessDateIssue, businessTimestamp, todayIso } from '@/core/utils/business-date';

/** Die Zahlarten der Maske („4 · PAYMENT": Cash, Bank, Card, Benefit) — keine weitere. */
export const INVOICE_CREATE_PAYMENT_METHODS = ['cash', 'bank_transfer', 'card', 'benefit'] as const;
export type InvoiceCreatePaymentMethod = typeof INVOICE_CREATE_PAYMENT_METHODS[number];
/** Die Kartenmarken der Masken — dieselbe Liste wie die Gebührensätze (Normal / Amex / Debit). */
export const INVOICE_CARD_BRANDS = CARD_BRANDS;
export type InvoiceCardBrand = CardBrand;

export const INVOICE_NEEDS_A_LINE = 'INVOICE_NEEDS_A_LINE';
export const CUSTOMER_NOT_FOUND = 'CUSTOMER_NOT_FOUND';
export const EMPLOYEE_NOT_FOUND = 'EMPLOYEE_NOT_FOUND';
export const PRODUCT_NOT_FOUND = 'PRODUCT_NOT_FOUND';
export const PAYMENT_AMOUNT_INVALID = 'PAYMENT_AMOUNT_INVALID';
export const PAYMENT_METHOD_INVALID = 'PAYMENT_METHOD_INVALID';
export const PAYMENT_EXCEEDS_TOTAL = 'PAYMENT_EXCEEDS_TOTAL';
export const PAYMENT_DATE_INVALID = 'PAYMENT_DATE_INVALID';
export const PAYMENT_DATE_BEFORE_INVOICE = 'PAYMENT_DATE_BEFORE_INVOICE';
export const PAYMENTS_INVALID = 'PAYMENTS_INVALID';
/** So viele Zahlungen nimmt das Anlegen auf einmal an (die Maske bietet „Add Payment" bis dahin). */
export const MAX_CREATE_PAYMENTS = 10;

/** Die Zahlung, die ein Mensch beim Anlegen eingibt: Betrag, Weg, bei Karte die Marke, der Tag. Mehr nicht. */
export interface InvoiceCreatePayment {
  amount: number;
  method: InvoiceCreatePaymentMethod;
  cardBrand?: InvoiceCardBrand;
  /** v0.8.87 — der Tag, an dem das Geld kam (JJJJ-MM-TT). Ohne Angabe: das Rechnungsdatum. */
  paidDate?: string;
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
  /** Eine Zahlung (der bisherige Rumpf). */
  payment?: InvoiceCreatePayment;
  /** v0.8.87 — mehrere Zahlungen beim Anlegen (Cash, Bank, Karten, Benefit beliebig kombiniert). Nicht zusammen mit `payment`. */
  payments?: InvoiceCreatePayment[];
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
  /** Die Zahlung, die zuletzt gebucht wurde (bei einer einzigen: diese). */
  paymentId?: string;
  /** v0.8.87 — alle Zahlungen dieses Anlegens, in der Reihenfolge der Buchung (nach Zahlungstag). */
  paymentIds?: string[];
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
  if (raw.paidDate !== undefined) {
    const issue = businessDateIssue(raw.paidDate, 'Payment date');
    if (issue || typeof raw.paidDate !== 'string' || raw.paidDate === '') throw new InvoiceActionRejected(PAYMENT_DATE_INVALID, issue || 'Payment date is not a valid date');
    out.paidDate = raw.paidDate;
  }
  return out;
}

/**
 * v0.8.87 — die Zahlungen eines Anlegens: entweder die eine (`payment`, der bisherige Rumpf) oder die Liste
 * (`payments`), nie beides; höchstens MAX_CREATE_PAYMENTS; jede einzeln geprüft (rein, ohne Datenbank).
 */
export function invoiceCreatePayments(input: { payment?: unknown; payments?: unknown }): InvoiceCreatePayment[] {
  if (input.payment !== undefined && input.payments !== undefined) {
    throw new InvoiceActionRejected(PAYMENTS_INVALID, 'send the payments either as one payment or as a list, not both');
  }
  if (input.payments === undefined) {
    return input.payment === undefined ? [] : [invoiceCreatePayment(input.payment as Record<string, unknown>)];
  }
  if (!Array.isArray(input.payments)) throw new InvoiceActionRejected(PAYMENTS_INVALID, 'payments must be a list');
  if (input.payments.length > MAX_CREATE_PAYMENTS) {
    throw new InvoiceActionRejected(PAYMENTS_INVALID, `at most ${MAX_CREATE_PAYMENTS} payments when creating an invoice`);
  }
  return input.payments.map((p, i) => {
    if (typeof p !== 'object' || p === null || Array.isArray(p)) throw new InvoiceActionRejected(PAYMENTS_INVALID, `payment ${i + 1} must be an object`);
    return invoiceCreatePayment(p as Record<string, unknown>);
  });
}

function createdState(invoiceId: string, paymentIds: string[] = []): InvoiceCreated {
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
  if (paymentIds.length > 0) {
    out.paymentId = paymentIds[paymentIds.length - 1];
    out.paymentIds = [...paymentIds];
  }
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
  input = { ...input, lines: resolveBulkIntents(input.lines, branchId) };
  for (const l of input.lines) {
    if (!query('SELECT id FROM products WHERE id = ? AND branch_id = ?', [l.productId, branchId])[0]) {
      throw new InvoiceActionRejected(PRODUCT_NOT_FOUND, 'no such article in this branch');
    }
  }
  const payments = invoiceCreatePayments(input);
  // v0.8.87 — jede Zahlung trägt ihren Tag: ohne Angabe das Rechnungsdatum (so kommt eine am 24.10. erfasste
  // Zahlung zu einer Rechnung vom 23.10. auch am 23.10. in Banking an). Nie vor dem Rechnungsdatum.
  const issuedDay = input.issuedDate || todayIso();
  const mitTag = payments.map((p, i) => ({ ...p, paidDate: p.paidDate ?? issuedDay, order: i }));
  for (const p of mitTag) {
    if (p.paidDate < issuedDay) {
      throw new InvoiceActionRejected(PAYMENT_DATE_BEFORE_INVOICE,
        `the payment date (${p.paidDate}) is before the invoice date (${issuedDay})`);
    }
  }
  if (payments.length > 0) {
    // Dieselbe Summe, die `createDirectInvoice` gleich schreibt (v0.7.1: Summe der Zeilensummen),
    // in Fils verglichen — und dieselbe Regel wie `validate` der Maske im Anlege-Modus.
    const gross = input.lines.reduce((s, l) => s + (Number(l.lineTotal) || 0), 0);
    const paidF = payments.reduce((s, p) => s + toFils(p.amount), 0);
    if (paidF > toFils(gross)) {
      throw new InvoiceActionRejected(PAYMENT_EXCEEDS_TOTAL,
        `Paid (${(paidF / 1000).toFixed(3)}) exceeds total (${gross.toFixed(3)}) — an overpayment is recorded on the invoice page, where it becomes store credit`);
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
  const paymentIds: string[] = [];
  // Nach Zahlungstag gebucht (bei gleichem Tag in der Reihenfolge der Maske): die Zahlung, die schließt, ist
  // die mit dem spätesten Tag — genau der Tag, den der NBR-Export als Vollzahlung liest; an ihm prüft das Haus
  // die VAT-Periode. Jede Zahlung bekommt ihren EIGENEN Erfassungszeitpunkt (eine Millisekunde Abstand):
  // Banking verknüpft eine Kartengebühr über diesen Zeitpunkt mit ihrer Zahlung.
  const geordnet = [...mitTag].sort((a, b) => (a.paidDate < b.paidDate ? -1 : a.paidDate > b.paidDate ? 1 : a.order - b.order));
  const basis = Date.now();
  const kartenZeitpunkte: string[] = [];
  geordnet.forEach((p, i) => {
    const createdAt = new Date(basis + i).toISOString();
    const receivedAt = businessTimestamp(p.paidDate, createdAt);
    if (p.method === 'card') kartenZeitpunkte.push(createdAt);
    // Dieselbe Wahl wie bisher an der Maske: die Nummernart gilt, wenn DIESE Zahlung schließt;
    // sonst bleibt die Marke, mit der die Rechnung angelegt wurde.
    paymentIds.push(useInvoiceStore.getState().recordPayment(
      inv.id, p.amount, p.method, undefined, input.specialMark === true,
      p.method === 'card' ? p.cardBrand : undefined, undefined, undefined, { receivedAt, createdAt },
    ));
  });
  // v0.8.88 — eine Kartengebühr, die VOR der schließenden Zahlung gebucht wurde, trug noch die vorläufige Nummer
  // (PINV-…). Jetzt, in derselben Transaktion, alle Gebühren dieses Anlegens mit der endgültigen (nur der Text).
  if (kartenZeitpunkte.length > 0) {
    const kopf = query('SELECT invoice_number, status, special_mark, number_finalized_at FROM invoices WHERE id = ?', [inv.id])[0];
    relabelCardFees('invoice', inv.id, kartenZeitpunkte, formatInvoiceDisplay({
      invoiceNumber: String(kopf?.invoice_number ?? ''), status: String(kopf?.status ?? ''),
      specialMark: Number(kopf?.special_mark ?? 0) === 1, numberFinalizedAt: (kopf?.number_finalized_at as string | null) || undefined,
    }));
  }
  buchung();
  return createdState(inv.id, paymentIds);
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
 * die Kartenmarke nur bei Karte; der Tag, wenn die Maske einen nennt.
 */
export function invoiceCreatePaymentBody(
  paidAmount: number, method: string, cardBrand: InvoiceCardBrand, paidDate?: string,
): Record<string, unknown> | undefined {
  if (!(paidAmount > 0)) return undefined;
  return { amount: paidAmount, method, ...(method === 'card' ? { cardBrand } : {}), ...(paidDate ? { paidDate } : {}) };
}

/** v0.8.87 — die Zahlungszeilen der Maske als Rumpf: Zeilen ohne Betrag fallen weg. */
export function invoiceCreatePaymentsBody(
  rows: ReadonlyArray<{ amount: number; method: string; cardBrand: InvoiceCardBrand; paidDate?: string }>,
): Array<Record<string, unknown>> {
  return rows.map((r) => invoiceCreatePaymentBody(r.amount, r.method, r.cardBrand, r.paidDate)).filter((x): x is Record<string, unknown> => !!x);
}
