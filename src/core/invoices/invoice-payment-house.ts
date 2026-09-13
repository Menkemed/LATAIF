// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6E — eine Zahlung auf eine Rechnung, und die Wahl des Nummernkreises, wenn
// genau diese Zahlung die Rechnung schließt („Final Number Type": Normal / Special).
//
// Der Vertrag der Sondernummer, am Haus gemessen (`invoiceStore.recordPayment`):
//
//   • Sie ist eine ECHTE Belegnummer, keine Anzeige: bei der Zahlung, die eine noch nicht endgültige
//     Rechnung voll bezahlt, zieht das Haus die Endnummer aus einem DURABLEN Zähler
//     (`getNextDocumentNumber`, in derselben Transaktion) — Verkauf INV bzw. SINV, Reparatur RINV
//     bzw. SRINV — und ersetzt damit `invoice_number`. Der Punkt davor („No: .000009") ist nur die
//     Anzeige der Marke `special_mark` (`formatInvoiceDisplay`).
//   • SINV/SRINV sind EIGENE Zähler: der normale Kreis wird dabei nicht angefasst, und umgekehrt.
//   • Die Wahl wirkt NUR auf der Zahlung, die schließt. Auf jeder anderen Zahlung (Teilzahlung,
//     Zahlung auf eine schon endgültige Rechnung) bleibt die Marke der Rechnung, wie sie ist — kein
//     Nein, die Wahl ist dann schlicht ohne Wirkung. Fehlt die Wahl, entscheidet die Marke, mit der
//     die Rechnung angelegt wurde.
//   • Wer sie treffen darf: wer die Zahlung erfassen darf. Die Maske zeigt den Dialog genau dann,
//     wenn die Zahlung schließt — hinter demselben Knopf „Record Payment". Ein eigenes Recht gibt es
//     nicht, also auch keines hier.
//   • Der Client nennt NIE eine Nummer — nur die Wahl (ja/nein). Nummer, Marke und Status entscheidet
//     der Primary und meldet sie zurück.
//
// Die Folge läuft in der Transaktion des Aufrufers (`runOnPrimary` an der Maske, `runRemoteCommand`
// für PC2). Vorher lief die Zahlung am Primary OHNE Transaktion: eine gescheiterte Buchung wurde
// verschluckt (`safePost`) — Zahlung, Statuswechsel und verbrauchte Endnummer ohne Buchungssatz.
// ════════════════════════════════════════════════════════════════════════════
import { query } from '@/core/db/helpers';
import { runOnPrimary } from '@/core/data/primary-action';
import { watchLedgerPosts } from '@/core/ledger/posting';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { useProductStore } from '@/stores/productStore';
import { useCustomerStore } from '@/stores/customerStore';
import { InvoiceActionRejected } from './invoice-cancel';
import { assertInvoiceHouse, localInvoiceBranch } from './invoice-house-guards';
import { PAYMENT_AMOUNT_INVALID, PAYMENT_METHOD_INVALID, INVOICE_CARD_BRANDS, type InvoiceCardBrand } from './invoice-create-house';

/**
 * Die Zahlarten einer Zahlung auf eine bestehende Rechnung. `credit` fehlt mit Absicht: Guthaben
 * einzulösen ist ein eigener Vorgang (`applyCreditToInvoice`, `invoices.apply_credit`).
 */
export const INVOICE_PAYMENT_METHODS = ['cash', 'card', 'bank_transfer', 'benefit', 'other'] as const;

export const INVOICE_NOT_FOUND = 'INVOICE_NOT_FOUND';
export const INVOICE_CANCELLED = 'INVOICE_CANCELLED';

export interface InvoicePaymentInput {
  invoiceId: string;
  amount: number;
  method: string;
  notes?: string;
  cardBrand?: InvoiceCardBrand;
  /** Die Wahl aus „Final Number Type" — wirkt nur, wenn DIESE Zahlung die Rechnung schließt. */
  specialMarkOnFinal?: boolean;
}

export interface InvoicePaymentRecorded {
  invoiceId: string;
  /** Die Nummer NACH der Zahlung — bei Vollzahlung die Endnummer aus dem Zähler des Hauses. */
  invoiceNumber: string;
  status: string;
  specialMark: boolean;
  grossAmount: number;
  paidAmount: number;
  openAmount: number;
  revision: number;
  updatedAt: string;
  paymentId: string;
}

function paymentState(invoiceId: string, paymentId: string): InvoicePaymentRecorded {
  const r = query(
    'SELECT invoice_number, status, special_mark, gross_amount, paid_amount, revision, updated_at FROM invoices WHERE id = ?',
    [invoiceId],
  )[0];
  const gross = Number(r?.gross_amount ?? 0);
  const paid = Number(r?.paid_amount ?? 0);
  return {
    invoiceId,
    invoiceNumber: String(r?.invoice_number ?? ''),
    status: String(r?.status ?? ''),
    specialMark: Number(r?.special_mark ?? 0) === 1,
    grossAmount: gross,
    paidAmount: paid,
    // Was offen ist, rechnet der Primary — wie im Lesebefehl.
    openAmount: Math.max(0, gross - paid),
    revision: Number(r?.revision ?? 0),
    updatedAt: String(r?.updated_at ?? ''),
    paymentId,
  };
}

/**
 * „Record Payment" (samt „Final Number Type", wenn die Zahlung schließt): die Zahlung, ihre
 * Aufteilung (Überzahlung → Guthaben), der Statuswechsel, die Endnummer, die Kartengebühr, die
 * Buchung — zusammen oder gar nicht. Der offene Rest wird gegen den FRISCHEN Stand gerechnet.
 */
export function recordInvoicePaymentInHouse(input: InvoicePaymentInput, branchId: string): InvoicePaymentRecorded {
  assertInvoiceHouse(branchId);
  if (typeof input.amount !== 'number' || !Number.isFinite(input.amount) || input.amount <= 0) {
    throw new InvoiceActionRejected(PAYMENT_AMOUNT_INVALID, 'amount must be a positive number');
  }
  if (!(INVOICE_PAYMENT_METHODS as readonly string[]).includes(input.method)) {
    throw new InvoiceActionRejected(PAYMENT_METHOD_INVALID, `unknown payment method: ${input.method || '(none)'}`);
  }
  if (input.cardBrand !== undefined && !(INVOICE_CARD_BRANDS as readonly string[]).includes(input.cardBrand)) {
    throw new InvoiceActionRejected(PAYMENT_METHOD_INVALID, 'unknown card brand');
  }
  if (input.specialMarkOnFinal !== undefined && typeof input.specialMarkOnFinal !== 'boolean') {
    throw new InvoiceActionRejected('INVALID_INPUT', 'specialMarkOnFinal must be true or false');
  }
  const inv = query('SELECT id, status FROM invoices WHERE id = ? AND branch_id = ?', [input.invoiceId, branchId])[0];
  if (!inv) throw new InvoiceActionRejected(INVOICE_NOT_FOUND, 'no such invoice in this branch');
  if (String(inv.status) === 'CANCELLED') {
    throw new InvoiceActionRejected(INVOICE_CANCELLED, 'a cancelled invoice takes no payment');
  }
  // Der Store rechnet Rest, Status und Endnummer gegen SEINE geladene Liste — frisch, sonst gegen
  // den Stand irgendeines früheren Zeitpunkts (fern gegen gar keinen).
  useInvoiceStore.getState().loadInvoices();
  const buchung = watchLedgerPosts('invoice payment');
  const paymentId = useInvoiceStore.getState().recordPayment(
    input.invoiceId, input.amount, input.method, input.notes, input.specialMarkOnFinal, input.cardBrand,
  );
  buchung();
  return paymentState(input.invoiceId, paymentId);
}

/** Die Listen, die die Seite danach zeigt — auch nach einem Rollback. */
function frischLesen(): void {
  useInvoiceStore.getState().loadInvoices();
  useProductStore.getState().loadProducts();
  useCustomerStore.getState().loadCustomers();
}

/** „Record Payment" / „Final Number Type" am Primary: exklusiv, EINE Transaktion, danach durabel. */
export async function recordInvoicePaymentOnPrimary(input: InvoicePaymentInput): Promise<InvoicePaymentRecorded> {
  const branchId = localInvoiceBranch();
  return runOnPrimary(() => recordInvoicePaymentInHouse(input, branchId), frischLesen);
}

/** Der Rumpf von `invoices.record_payment`, wie ihn die Masken am zweiten Rechner bauen. */
export function invoicePaymentBody(p: InvoicePaymentInput): Record<string, unknown> {
  return {
    invoiceId: p.invoiceId,
    amount: p.amount,
    method: p.method,
    ...(p.notes ? { notes: p.notes } : {}),
    ...(p.cardBrand ? { cardBrand: p.cardBrand } : {}),
    ...(typeof p.specialMarkOnFinal === 'boolean' ? { specialMarkOnFinal: p.specialMarkOnFinal } : {}),
  };
}
