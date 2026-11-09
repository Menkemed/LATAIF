// CENTRAL-C3G — die Geldvorgänge nach dem Beleg, von einem zweiten Rechner.
//
// Sieben Namen, und die Zahl sieben ist das Ergebnis eines Audits über **fünfundzwanzig** noch
// nicht freigegebene Aktionen. Jede wurde einzeln eingeordnet, und der Grund steht in der
// Matrix (`c3g-action-audit.md`), nicht in einer Sammelbegründung:
//
//   • **A — Tagesbetrieb.** Ein Guthaben auf eine Rechnung anrechnen. Das passiert am Tresen,
//     und ein Client, der es nicht kann, schickt den Kunden zum anderen Rechner.
//   • **B — buchhalterisch heikel, aber normal.** Eine falsch getippte Zahlung berichtigen oder
//     löschen; einen Auftrag in eine Rechnung wandeln; einen Einlieferer auszahlen; melden, dass
//     der Agent verkauft hat, und ihn abrechnen. Alles davon bewegt Geld — deshalb hier, aber
//     nur mit vollem Nachweis.
//   • **C — zerstörend, administrativ oder Wiederherstellung.** Sie bleiben am Primary, und zwar
//     ausdrücklich: `deleteInvoice`, `deletePayment` wäre eine Korrektur (die ist dabei), aber
//     `setSpecialMark`, `cancelOrderWithMoney`, `deleteOrder`, `cancelSale`,
//     `markReturnedAfterSale`, `deleteConsignment`, `deleteRepair`,
//     `undoTransferInvoiceConvert` und `deleteTransfer` sind es nicht. Keine davon ist ein
//     Kassenvorgang; alle sind Storno, Löschung oder Wiederherstellung. Symmetrie ist kein Grund.
//
// Und drei Klasse-B-Ketten sind AUSDRÜCKLICH vertagt statt halb gebaut: die Rückgabe mit
// Gutschrift (vier Stufen, eigene Steuerurkunde, und §3 verlangt die Mengen-Nebenläufigkeit über
// die ganze Kette), die Reparatur-Zustandsmaschine samt Rechnung, und `recordSale` einer
// Kommission (die erzeugt Rechnung UND Einkauf). Jede davon ist ein eigener Schnitt in der Größe
// von C3D — halb gebaut wären sie gefährlicher als gar nicht gebaut.
//
// Was für alle sieben gilt:
//
//  1. **Es wird keine Buchhaltung nachgebaut.** Jede Operation ruft die Funktion, die auch der
//     Mensch am Primary auslöst. Stornobuchungen, Kartengebühren, Guthaben-FIFO, Nummernkreise,
//     Bestandsrückgabe: alles bleibt dort.
//  2. **Der Store liest seine EIGENE Liste.** `applyCreditToInvoice`, `recordPartialPayout`,
//     `markTransferSold` und `markTransferSettled` schlagen den Vorgang in der geladenen Liste
//     ihres Stores nach, nicht in der Datenbank. Am Primary lädt ein Bildschirm sie; ein
//     Fernauftrag hat keinen. Deshalb wird vor jedem dieser Aufrufe geladen — sonst arbeitet die
//     Domäne auf dem Stand irgendeines anderen Zeitpunkts, im Zweifel auf gar keinem.
//  3. **Ändern braucht die gesehene FASSUNG**, verglichen INNERHALB der Transaktion. Bei Geld ist
//     das kein Komfort: zwei Rechner, die dieselbe Zahlung berichtigen, dürfen nicht beide
//     gewinnen.

import { getDatabase, saveDatabaseDurably } from '@/core/db/database';
import { STOCK_UNAVAILABLE_MESSAGE } from '@/core/lots/lot-availability';
import { query } from '@/core/db/helpers';
import {
  beginLedgerTransaction, commitLedgerTransaction, rollbackLedgerTransaction,
} from '@/core/ledger/posting';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { convertOrderToInvoiceInHouse } from '@/core/orders/order-convert-house';
import { OrderActionRejected } from '@/core/orders/order-create';
import { useAgentStore } from '@/stores/agentStore';
// CONSIGNMENT-AGENT — ein Nein der Agentenregeln (Kommissionsware) ist ein fachliches Nein, kein Fehler.
import { TransferActionRejected } from '@/core/agents/transfer-rules';
import { ACCEPTED_PAYOUT_METHODS, ConsignmentActionRejected } from '@/core/consignment/consignment-finance';
import { payOutConsignmentInHouse } from '@/core/consignment/consignment-finance-house';
import { TAX_SCHEMES, type TaxScheme } from '@/core/models/types';
import {
  CommandNotEvaluated, CommandRejected, runRemoteCommand, type CommandOutcome, type EngineDeps,
} from './mutation-engine';
import type { CommandIdentity } from './command-ledger';
import { BusinessError, registerCommand, type CommandActor } from './command-registry';
import { VAT_PERIOD_FILED, VatPeriodFiled } from '@/core/tax/vat-period-lock';
import { CardFeeNotConfigured } from '@/core/finance/card-fees';
import { assertOffsetUndoSafe } from '@/core/offsets/party-offset-restore';
import { InvoiceActionRejected } from '@/core/invoices/invoice-cancel';

export const OP_INVOICES_APPLY_CREDIT = 'invoices.apply_credit';
export const OP_INVOICES_UPDATE_PAYMENT = 'invoices.update_payment';
export const OP_INVOICES_DELETE_PAYMENT = 'invoices.delete_payment';
export const OP_ORDERS_CONVERT_TO_INVOICE = 'orders.convert_to_invoice';
export const OP_CONSIGNMENTS_RECORD_PAYOUT = 'consignments.record_payout';
export const OP_TRANSFERS_MARK_SOLD = 'transfers.mark_sold';
export const OP_TRANSFERS_MARK_SETTLED = 'transfers.mark_settled';

/** Die sieben Namen dieses Schnitts — dieselbe Liste kennt auch Rust. */
export const C3G_MUTATIONS = [
  OP_INVOICES_APPLY_CREDIT, OP_INVOICES_UPDATE_PAYMENT, OP_INVOICES_DELETE_PAYMENT,
  OP_ORDERS_CONVERT_TO_INVOICE, OP_CONSIGNMENTS_RECORD_PAYOUT,
  OP_TRANSFERS_MARK_SOLD, OP_TRANSFERS_MARK_SETTLED,
] as const;

/**
 * Was ausdrücklich NICHT freigegeben ist — als LISTE im Code, nicht nur im Bericht. Ein späterer
 * Schnitt, der einen dieser Namen registrieren will, kommt an dieser Stelle vorbei und damit an
 * der Frage, ob PC2 sie für den normalen Betrieb wirklich braucht.
 */
export const C3G_PRIMARY_ONLY = [
  'invoices.set_special_mark', 'invoices.delete',
  'orders.cancel_with_money', 'orders.delete',
  // R6F — `consignments.cancel_sale` ist seither freigegeben (Verkaufsstorno über die R6E-Storno-Grundlage,
  // eine Transaktion, keine harte Löschung von Gutschrift oder Retoure).
  'consignments.mark_returned_after_sale', 'consignments.delete',
  'repairs.delete',
  // R6E — `transfers.undo_convert` ist seither freigegeben: die Umwandlung wird als Rechnungsstorno
  // zurückgenommen (die Rechnung bleibt als Beleg), nicht mehr gelöscht. Löschen bleibt hier.
  'transfers.delete',
] as const;

export class FinancialPayloadError extends Error {
  readonly code = 'INVALID_PAYLOAD';
  constructor(message: string) {
    super(message);
    this.name = 'FinancialPayloadError';
  }
}

// CENTRAL-C3H — dieselben Bausteine benutzen jetzt auch die Rueckgabe-Kette und die
// Lebenszyklus-Aktionen. Sie werden EXPORTIERT statt kopiert: ein zweiter Satz Pruefungen waere
// ein zweiter Satz Luecken.
export const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function onlyKnownFields(raw: Record<string, unknown>, allowed: readonly string[]): void {
  for (const k of Object.keys(raw)) {
    if (!allowed.includes(k)) throw new FinancialPayloadError(`unknown field: ${k}`);
  }
}
export function reqString(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new FinancialPayloadError(`${name} is required`);
  return v.trim();
}
export function optString(v: unknown, name: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new FinancialPayloadError(`${name} must be a string`);
  const t = v.trim();
  return t === '' ? undefined : t;
}
/** R5F — ein Freitext der Maske, WIE getippt (die Maske trimmt nicht); leer heisst „keiner". */
export function optText(v: unknown, name: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new FinancialPayloadError(`${name} must be a string`);
  return v === '' ? undefined : v;
}
export function positive(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    throw new FinancialPayloadError(`${name} must be a positive number`);
  }
  return v;
}
export function expectedRevisionOf(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw new FinancialPayloadError('expectedRevision is required — a money action must say which revision it saw');
  }
  return v;
}

/** Der Fassungsvergleich, INNERHALB der Transaktion, gegen die Zeile selbst. */
export type RevisionedTable =
  'invoices' | 'orders' | 'consignments' | 'agent_transfers' | 'repairs' | 'sales_returns'
  // MEDIA-IDENTITY §9 — Kunde und Lieferant haben jetzt eine Fassung, weil ihr Ausweisdokument
  // von zwei Bildschirmen aus getauscht werden kann.
  | 'customers' | 'suppliers';

export function assertRevision(
  table: RevisionedTable,
  id: string, expected: number, notFound: string,
): void {
  const live = query(`SELECT revision FROM ${table} WHERE id = ?`, [id])[0];
  if (!live) throw new CommandRejected(notFound, 'no such record');
  const now = Number(live.revision ?? 0);
  if (now !== expected) {
    throw new CommandRejected(
      'RECORD_CHANGED',
      `this record changed since you opened it (you saw ${expected}, it is now ${now})`,
    );
  }
}

export function financialDeps(): EngineDeps {
  return {
    db: getDatabase() as never,
    begin: beginLedgerTransaction,
    commit: commitLedgerTransaction,
    rollback: rollbackLedgerTransaction,
    durableSave: saveDatabaseDurably,
    now: () => new Date().toISOString(),
  };
}

export type FinancialResult = { readonly [k: string]: unknown };

/** Der Rechnungszustand, wie ihn auch der Lesebefehl zeigt — vom Primary gerechnet. */
export function invoiceState(id: string): FinancialResult {
  const r = query(
    'SELECT id, invoice_number, status, gross_amount, paid_amount, revision, updated_at '
    + 'FROM invoices WHERE id = ?', [id],
  )[0];
  const gross = Number(r?.gross_amount ?? 0);
  const paid = Number(r?.paid_amount ?? 0);
  return {
    invoiceId: id,
    invoiceNumber: String(r?.invoice_number ?? ''),
    status: String(r?.status ?? ''),
    grossAmount: gross,
    paidAmount: paid,
    openAmount: Math.max(0, gross - paid),
    revision: Number(r?.revision ?? 0),
    updatedAt: String(r?.updated_at ?? ''),
  };
}

/** Ein nicht stornierter, offener Beleg — sonst gar nichts. */
export function liveInvoice(id: string, branchId: string): Record<string, unknown> {
  const inv = query('SELECT id, status, gross_amount, paid_amount FROM invoices WHERE id = ? AND branch_id = ?',
    [id, branchId])[0];
  if (!inv) throw new CommandRejected('INVOICE_NOT_FOUND', 'no such invoice in this branch');
  if (String(inv.status) === 'CANCELLED') {
    throw new CommandRejected('INVOICE_CANCELLED', 'a cancelled invoice takes no money action');
  }
  return inv;
}

// ── Guthaben auf eine Rechnung anrechnen ──────────────────────────────────

export interface ApplyCreditRequest {
  invoiceId: string;
  amount: number;
  expectedRevision: number;
  note?: string;
}

/**
 * Der Betrag ist ein WUNSCH, keine Zusage: das Haus deckelt ihn auf den offenen Rest und auf das
 * wirklich vorhandene Guthaben, und es entscheidet per FIFO, welche Guthabenzeilen dran sind. Was
 * am Ende angerechnet wurde, sagt die Antwort — nicht der Rumpf.
 */
export function parseApplyCredit(raw: unknown): ApplyCreditRequest {
  if (!isPlain(raw)) throw new FinancialPayloadError('payload must be an object');
  onlyKnownFields(raw, ['invoiceId', 'amount', 'expectedRevision', 'note']);
  return {
    invoiceId: reqString(raw.invoiceId, 'invoiceId'),
    amount: positive(raw.amount, 'amount'),
    expectedRevision: expectedRevisionOf(raw.expectedRevision),
    note: optString(raw.note, 'note'),
  };
}

export function runApplyCredit(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseApplyCredit(raw);
  return runRemoteCommand(deps, identity, () => {
    liveInvoice(req.invoiceId, identity.branchId);
    assertRevision('invoices', req.invoiceId, req.expectedRevision, 'INVOICE_NOT_FOUND');
    // Der Store schlägt die Rechnung in SEINER Liste nach — ein Fernauftrag hat keinen
    // Bildschirm, der sie geladen hat. Also erst laden, dann rufen.
    useInvoiceStore.getState().loadInvoices();
    const applied = useInvoiceStore.getState().applyCreditToInvoice(req.invoiceId, req.amount, req.note);
    if (!(applied > 0)) {
      // Kein Guthaben, oder nichts mehr offen. Ein Urteil über GENAU diese Anfrage — und keins,
      // das man durch Wiederholen umdreht.
      throw new CommandRejected('NO_CREDIT_APPLIED',
        'nothing was applied — there is no open store credit for this client, or the invoice has nothing left open');
    }
    return { ...invoiceState(req.invoiceId), appliedAmount: applied } as unknown as Record<string, unknown>;
  });
}

// ── Eine Zahlung berichtigen ──────────────────────────────────────────────

const METHODS = ['cash', 'card', 'bank_transfer', 'benefit', 'other'] as const;

export interface UpdatePaymentRequest {
  invoiceId: string;
  paymentId: string;
  expectedRevision: number;
  amount?: number;
  method?: typeof METHODS[number];
  notes?: string;
  receivedAt?: string;
}

export function parseUpdatePayment(raw: unknown): UpdatePaymentRequest {
  if (!isPlain(raw)) throw new FinancialPayloadError('payload must be an object');
  onlyKnownFields(raw, ['invoiceId', 'paymentId', 'expectedRevision', 'amount', 'method', 'notes', 'receivedAt']);
  const out: UpdatePaymentRequest = {
    invoiceId: reqString(raw.invoiceId, 'invoiceId'),
    paymentId: reqString(raw.paymentId, 'paymentId'),
    expectedRevision: expectedRevisionOf(raw.expectedRevision),
  };
  if (raw.amount !== undefined) out.amount = positive(raw.amount, 'amount');
  if (raw.method !== undefined) {
    const m = String(raw.method);
    // `credit` fehlt mit Absicht: eine Guthaben-Zahlung entsteht aus `applyCreditToInvoice` und
    // hängt an einer Guthabenzeile. Sie nachträglich in Bargeld umzudeuten hinge das Guthaben ab.
    if (!(METHODS as readonly string[]).includes(m)) throw new FinancialPayloadError(`unknown payment method: ${m}`);
    out.method = m as UpdatePaymentRequest['method'];
  }
  if (raw.notes !== undefined) out.notes = String(raw.notes);
  if (raw.receivedAt !== undefined) out.receivedAt = reqString(raw.receivedAt, 'receivedAt');
  if (out.amount === undefined && out.method === undefined
    && out.notes === undefined && out.receivedAt === undefined) {
    throw new FinancialPayloadError('an edit must change something');
  }
  return out;
}

/** Die Zahlung muss zu DIESER Rechnung gehören — und darf keine Guthaben-Zahlung sein. */
function livePayment(paymentId: string, invoiceId: string, forDelete = false): Record<string, unknown> {
  const p = query('SELECT id, invoice_id, method, amount FROM payments WHERE id = ?', [paymentId])[0];
  if (!p) throw new CommandRejected('PAYMENT_NOT_FOUND', 'no such payment');
  if (String(p.invoice_id) !== invoiceId) {
    throw new CommandRejected('PAYMENT_NOT_ON_INVOICE', 'this payment belongs to another invoice');
  }
  if (String(p.method) === 'credit') {
    throw new CommandRejected('PAYMENT_IS_CREDIT',
      'a store-credit payment is tied to a credit line — it is corrected on the primary, not here');
  }
  // CUSTOM-ORDER K2 — die Anrechnung einer Order-Anzahlung hängt an ihrer Order-Zahlung: korrigiert am Primary.
  if (String(p.method) === 'order_deposit') {
    throw new CommandRejected('PAYMENT_IS_ORDER_DEPOSIT',
      'an applied order deposit is tied to its order payment — it is corrected on the primary, not here');
  }
  // CUSTOMER ACCOUNT B1 — eine Verrechnung mit einem Darlehen wird nie geändert, nur als Ganzes aufgehoben (Löschen:
  // `deletePayment` öffnet das Darlehen wieder über die Gegenzeile).
  if (String(p.method) === 'debt_offset' && !forDelete) {
    throw new CommandRejected('PAYMENT_IS_DEBT_OFFSET',
      'an offset with a loan is not edited — remove the offset (the loan opens again) instead');
  }
  return p;
}

export function runUpdatePayment(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseUpdatePayment(raw);
  return runRemoteCommand(deps, identity, () => {
    liveInvoice(req.invoiceId, identity.branchId);
    livePayment(req.paymentId, req.invoiceId);
    assertRevision('invoices', req.invoiceId, req.expectedRevision, 'INVOICE_NOT_FOUND');
    useInvoiceStore.getState().loadInvoices();
    // Der Weg des Hauses: alte Buchung zurücknehmen, Kartengebühr netten, neu buchen, Stand und
    // Status neu ableiten. Nichts davon wird hier gerechnet.
    try {
      useInvoiceStore.getState().updatePayment(req.paymentId, req.invoiceId, {
        amount: req.amount,
        method: req.method,
        notes: req.notes,
        receivedAt: req.receivedAt,
      });
    } catch (err) {
      // VAT-PERIOD-LOCK — ein eingereichtes/bezahltes Quartal ist ein endgültiges fachliches Nein.
      if (err instanceof VatPeriodFiled) throw new CommandRejected(VAT_PERIOD_FILED, err.message);
      // v0.8.87 — Debitzahlung ohne gespeicherten Satz.
      if (err instanceof CardFeeNotConfigured) throw new CommandRejected(err.code, err.message);
      throw err;
    }
    return { ...invoiceState(req.invoiceId), paymentId: req.paymentId } as unknown as Record<string, unknown>;
  });
}

// ── Eine Zahlung löschen ──────────────────────────────────────────────────

export interface DeletePaymentRequest {
  invoiceId: string;
  paymentId: string;
  expectedRevision: number;
}

export function parseDeletePayment(raw: unknown): DeletePaymentRequest {
  if (!isPlain(raw)) throw new FinancialPayloadError('payload must be an object');
  onlyKnownFields(raw, ['invoiceId', 'paymentId', 'expectedRevision']);
  return {
    invoiceId: reqString(raw.invoiceId, 'invoiceId'),
    paymentId: reqString(raw.paymentId, 'paymentId'),
    expectedRevision: expectedRevisionOf(raw.expectedRevision),
  };
}

/**
 * Die Urteile, die `deletePayment` wirklich fällt. Als LISTE, nicht als „alles, was nach einem
 * Geschäftsfehler aussieht": ein Tippfehler im Code darf nie als endgültiges fachliches Nein
 * eingefroren werden.
 */
const DELETE_VERDICTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/store credit .* has already been used/i, 'CREDIT_ALREADY_USED'],
  [/overpayment/i, 'CREDIT_ALREADY_USED'],
  [/credit/i, 'CREDIT_BLOCKS_DELETE'],
];

function asDeleteVerdict(err: unknown): CommandRejected | null {
  const msg = err instanceof Error ? err.message : String(err);
  // VAT-PERIOD-LOCK — das Nein trägt seine Kennung selbst (eingereichtes/bezahltes Quartal).
  if (err instanceof VatPeriodFiled) return new CommandRejected(VAT_PERIOD_FILED, msg);
  for (const [pattern, code] of DELETE_VERDICTS) {
    if (pattern.test(msg)) return new CommandRejected(code, msg);
  }
  return null;
}

export function runDeletePayment(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseDeletePayment(raw);
  return runRemoteCommand(deps, identity, () => {
    liveInvoice(req.invoiceId, identity.branchId);
    livePayment(req.paymentId, req.invoiceId, true);
    assertRevision('invoices', req.invoiceId, req.expectedRevision, 'INVOICE_NOT_FOUND');
    // CUSTOMER ACCOUNT C — eine Verrechnung („Remove offset" vom PC2): keine doppelte Erstattung nach einer späteren Rückgabe.
    const verrechnung = query("SELECT * FROM party_offsets WHERE receivable_payment_id = ? AND status = 'ACTIVE'", [req.paymentId])[0];
    if (verrechnung) {
      try { assertOffsetUndoSafe(verrechnung); } catch (err) {
        if (err instanceof InvoiceActionRejected) throw new CommandRejected(err.code, err.message);
        throw err;
      }
    }
    useInvoiceStore.getState().loadInvoices();
    try {
      // Die Schutzregeln des Hauses gelten unverändert: eine Zahlung, deren
      // Überzahlungs-Guthaben schon eingelöst ist, wird nicht zurückgenommen.
      useInvoiceStore.getState().deletePayment(req.paymentId, req.invoiceId, { offsetReason: 'offset removed' });
    } catch (err) {
      const verdict = asDeleteVerdict(err);
      if (verdict) throw verdict;
      throw err;
    }
    const gone = query('SELECT id FROM payments WHERE id = ?', [req.paymentId])[0];
    if (gone) {
      // Nicht als Erfolg einfrieren, was nicht geschehen ist.
      throw new CommandNotEvaluated('PAYMENT_DELETE_INCOMPLETE', 'the payment is still there');
    }
    return { ...invoiceState(req.invoiceId), deletedPaymentId: req.paymentId } as unknown as Record<string, unknown>;
  });
}

// ── Auftrag → Rechnung ────────────────────────────────────────────────────

export interface ConvertOrderRequest {
  orderId: string;
  expectedRevision: number;
  /** R5A.2 — das Schema je Position, wie der Schema-Dialog es bestaetigt hat. */
  taxSchemes?: Record<string, TaxScheme>;
  /** R5A.2 — die Nummernart aus dem Nummern-Dialog (Punkt-Praefix). */
  specialMark?: boolean;
  /** R5A.2 — „Auftrag mit dieser Rechnung abschliessen". */
  markComplete?: boolean;
  /** CUSTOM-ORDER K2 — Rechnungsdatum aus dem Dialog (JJJJ-MM-TT). */
  invoiceDate?: string;
  /** CUSTOM-ORDER Review — Altweg (Auftrag ohne Steuerart je Position): die eine Steuerart aus dem Dialog. */
  legacyScheme?: TaxScheme;
}

const MAX_CONVERT_LINES = 500;

/**
 * WELCHE Positionen abgerechnet werden, entscheidet das Haus (`getBillableLines`: fertig,
 * kundenseitig, noch nicht berechnet), und die Rechnungsnummer ebenso. Ein Client, der eine
 * Auswahl mitschickte, könnte eine Position doppelt berechnen.
 *
 * R5A.2 — was der Mensch in den Dialogen ENTSCHEIDET, reist dagegen mit: das Schema je Position,
 * die Nummernart und „abschliessen". Das sind keine Ableitungen, sondern Wahlen — ohne sie
 * rechnete der Primary still etwas anderes, als die Maske gezeigt hat. Das Schema-Verzeichnis
 * waehlt KEINE Positionen aus: seine Schluessel muessen genau die abrechenbaren sein.
 */
export function parseConvertOrder(raw: unknown): ConvertOrderRequest {
  if (!isPlain(raw)) throw new FinancialPayloadError('payload must be an object');
  // CUSTOM-ORDER K2 — `invoiceDate` (JJJJ-MM-TT, optional): das im Dialog gewählte Rechnungsdatum. Ein älterer Client
  // schickt es nicht — dann gilt heute (wie bisher).
  // CUSTOM-ORDER Review — `legacyScheme`: der Altweg geht seit dem Review über DIESELBE Hausfolge (auch von PC2).
  onlyKnownFields(raw, ['orderId', 'expectedRevision', 'taxSchemes', 'specialMark', 'markComplete', 'invoiceDate', 'legacyScheme']);
  const out: ConvertOrderRequest = {
    orderId: reqString(raw.orderId, 'orderId'),
    expectedRevision: expectedRevisionOf(raw.expectedRevision),
  };
  for (const k of ['specialMark', 'markComplete'] as const) {
    if (raw[k] === undefined) continue;
    if (typeof raw[k] !== 'boolean') throw new FinancialPayloadError(`${k} must be true or false`);
    out[k] = raw[k] as boolean;
  }
  if (raw.invoiceDate !== undefined) {
    if (typeof raw.invoiceDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.invoiceDate)) {
      throw new FinancialPayloadError('invoiceDate must look like YYYY-MM-DD');
    }
    out.invoiceDate = raw.invoiceDate;
  }
  if (raw.taxSchemes !== undefined) {
    if (!isPlain(raw.taxSchemes)) throw new FinancialPayloadError('taxSchemes must be an object');
    const eintraege = Object.entries(raw.taxSchemes);
    if (eintraege.length === 0 || eintraege.length > MAX_CONVERT_LINES) {
      throw new FinancialPayloadError('taxSchemes must name the lines to invoice');
    }
    const schemes: Record<string, TaxScheme> = {};
    for (const [lineId, scheme] of eintraege) {
      if (!lineId.trim()) throw new FinancialPayloadError('taxSchemes: empty line id');
      if (!(TAX_SCHEMES as readonly unknown[]).includes(scheme)) {
        throw new FinancialPayloadError(`unknown tax scheme: ${String(scheme)}`);
      }
      schemes[lineId] = scheme as TaxScheme;
    }
    out.taxSchemes = schemes;
  }
  if (raw.legacyScheme !== undefined) {
    if (!(TAX_SCHEMES as readonly unknown[]).includes(raw.legacyScheme)) throw new FinancialPayloadError(`unknown tax scheme: ${String(raw.legacyScheme)}`);
    if (out.taxSchemes) throw new FinancialPayloadError('taxSchemes and legacyScheme exclude each other');
    out.legacyScheme = raw.legacyScheme as TaxScheme;
  }
  return out;
}

export function runConvertOrder(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseConvertOrder(raw);
  return runRemoteCommand(deps, identity, () => {
    // CUSTOM-ORDER K2 — DIESELBE Hausfolge wie am Primary (core/orders/order-convert-house): Sonderstück-Artikel mit
    // SKU/Kategorie/Bildern im Haus, Rechnungsdatum, Brutto bleibt, Anzahlung angerechnet — alles in DIESER Klammer.
    // Die Fassung prüft der letzte Wächter vor dem ersten Schreiben.
    try {
      const out = convertOrderToInvoiceInHouse({
        orderId: req.orderId,
        ...(req.taxSchemes ? { taxSchemes: req.taxSchemes } : {}),
        ...(req.specialMark !== undefined ? { specialMark: req.specialMark } : {}),
        ...(req.markComplete !== undefined ? { markComplete: req.markComplete } : {}),
        ...(req.invoiceDate ? { invoiceDate: req.invoiceDate } : {}),
        ...(req.legacyScheme ? { legacyScheme: req.legacyScheme } : {}),
      }, identity.branchId, () => assertRevision('orders', req.orderId, req.expectedRevision, 'ORDER_NOT_FOUND'));
      return {
        orderId: out.orderId,
        invoiceId: out.invoiceId,
        invoiceNumber: out.invoiceNumber,
        grossAmount: out.grossAmount,
        invoicedLines: out.invoicedLines,
        revision: out.revision,
      } as unknown as Record<string, unknown>;
    } catch (err) {
      // VAT-PERIOD-LOCK — ein Nein des Periodenschutzes ist ein Urteil, keine Störung.
      if (err instanceof VatPeriodFiled) throw new CommandRejected(VAT_PERIOD_FILED, err.message);
      if (err instanceof OrderActionRejected) throw new CommandRejected(err.code, err.message);
      const msg = err instanceof Error ? err.message : String(err);
      if (/already invoiced|bereits|already on an invoice/i.test(msg)) throw new CommandRejected('ORDER_ALREADY_INVOICED', msg);
      throw err;
    }
  });
}

// ── Einlieferer auszahlen ─────────────────────────────────────────────────

export interface RecordPayoutRequest {
  consignmentId: string;
  amount: number;
  method: string;
  expectedRevision: number;
  reference?: string;
}

/**
 * Ein ausdrücklicher Betrag, kein „zahl den Rest". Derselbe Grund wie bei der Rechnungszahlung:
 * „der Rest" ist eine Zahl, die sich zwischen Lesen und Ankommen ändert, und wer Geld auszahlt,
 * meint einen Betrag. R5F: die Maske „Pay Out Consignor" schickt den offenen Rest, den sie gesehen
 * hat (samt Fassung); die Wege stehen EINMAL in `core/consignment/consignment-finance`, und die
 * Regeln (nur ohne Rechnung, nie mehr als offen, erst null schliesst) in der Hausfolge.
 */
export function parseRecordPayout(raw: unknown): RecordPayoutRequest {
  if (!isPlain(raw)) throw new FinancialPayloadError('payload must be an object');
  onlyKnownFields(raw, ['consignmentId', 'amount', 'method', 'expectedRevision', 'reference']);
  const method = String(raw.method ?? '');
  if (!ACCEPTED_PAYOUT_METHODS.includes(method)) {
    throw new FinancialPayloadError(`unknown payout method: ${method || '(none)'}`);
  }
  return {
    consignmentId: reqString(raw.consignmentId, 'consignmentId'),
    amount: positive(raw.amount, 'amount'),
    method,
    expectedRevision: expectedRevisionOf(raw.expectedRevision),
    reference: optText(raw.reference, 'reference'),
  };
}

export function runRecordPayout(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseRecordPayout(raw);
  return runRemoteCommand(deps, identity, () => {
    const already = Number(query(
      'SELECT payout_paid_amount FROM consignments WHERE id = ? AND branch_id = ?', [req.consignmentId, identity.branchId],
    )[0]?.payout_paid_amount ?? 0);
    try {
      // Dieselbe Folge wie „Confirm Payout" am Primary; die gesehene Fassung ist der letzte Wächter.
      payOutConsignmentInHouse(req.consignmentId, { amount: req.amount, method: req.method, reference: req.reference },
        identity.branchId, () => assertRevision('consignments', req.consignmentId, req.expectedRevision, 'CONSIGNMENT_NOT_FOUND'));
    } catch (e) {
      if (e instanceof ConsignmentActionRejected) throw new CommandRejected(e.code, e.message);
      throw e;
    }

    const after = query(
      'SELECT payout_status, payout_paid_amount, payout_amount, status, revision FROM consignments WHERE id = ?',
      [req.consignmentId],
    )[0];
    const paid = Number(after?.payout_paid_amount ?? 0);
    if (paid <= already) {
      throw new CommandNotEvaluated('PAYOUT_NOT_APPLIED', 'nothing was paid out');
    }
    return {
      consignmentId: req.consignmentId,
      payoutAmount: Number(after?.payout_amount ?? 0),
      payoutPaidAmount: paid,
      // Was noch offen ist, rechnet der Primary.
      payoutOpenAmount: Math.max(0, Number(after?.payout_amount ?? 0) - paid),
      appliedAmount: paid - already,
      payoutStatus: String(after?.payout_status ?? ''),
      status: String(after?.status ?? ''),
      revision: Number(after?.revision ?? 0),
    } as unknown as Record<string, unknown>;
  });
}

// ── Agent hat verkauft ────────────────────────────────────────────────────

export interface MarkSoldRequest {
  transferId: string;
  salePrice: number;
  expectedRevision: number;
  buyerInfo?: string;
  acknowledgeBelowPrice?: boolean;
}

export function parseMarkSold(raw: unknown): MarkSoldRequest {
  if (!isPlain(raw)) throw new FinancialPayloadError('payload must be an object');
  onlyKnownFields(raw, ['transferId', 'salePrice', 'expectedRevision', 'buyerInfo', 'acknowledgeBelowPrice']);
  return {
    transferId: reqString(raw.transferId, 'transferId'),
    salePrice: positive(raw.salePrice, 'salePrice'),
    expectedRevision: expectedRevisionOf(raw.expectedRevision),
    buyerInfo: optString(raw.buyerInfo, 'buyerInfo'),
    // Dieselbe Bedeutung wie am Bildschirm: ein Verkauf UNTER unserem Preis braucht eine
    // ausdrückliche Bestätigung. Sie bestätigt genau das und schaltet nichts anderes ab.
    acknowledgeBelowPrice: raw.acknowledgeBelowPrice === true,
  };
}

function liveTransfer(id: string, branchId: string): Record<string, unknown> {
  const t = query('SELECT id, status, product_id, settlement_amount, settlement_paid_amount FROM agent_transfers WHERE id = ? AND branch_id = ?',
    [id, branchId])[0];
  if (!t) throw new CommandRejected('TRANSFER_NOT_FOUND', 'no such transfer in this branch');
  return t;
}

export function runMarkSold(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseMarkSold(raw);
  return runRemoteCommand(deps, identity, () => {
    const t = liveTransfer(req.transferId, identity.branchId);
    if (String(t.status) !== 'transferred') {
      throw new CommandRejected('TRANSFER_NOT_OPEN',
        `this transfer is "${String(t.status)}" — only one that is still out can be sold`);
    }
    assertRevision('agent_transfers', req.transferId, req.expectedRevision, 'TRANSFER_NOT_FOUND');
    // Gemessen und behoben: `markTransferSold` schlaegt den AGENTEN in der geladenen Liste nach,
    // um den Kunden zu finden, gegen den die Forderung gebucht wird. Ohne ihn wird sie STILL gar
    // nicht gebucht — der Verkauf saehe richtig aus, und das Geld staende nirgends. Also beide
    // Listen laden, nicht nur die Transfers.
    useAgentStore.getState().loadAgents();
    useAgentStore.getState().loadTransfers();
    try {
      useAgentStore.getState().markTransferSold(
        req.transferId, req.salePrice, req.buyerInfo, req.acknowledgeBelowPrice,
      );
    } catch (err) {
      if (err instanceof TransferActionRejected) throw new CommandRejected(err.code, err.message);
      const msg = err instanceof Error ? err.message : String(err);
      // STOCK-LOT-INTEGRITY — das Stück ist nicht mehr da: ein fachliches Nein, eingefroren.
      if (msg === STOCK_UNAVAILABLE_MESSAGE) throw new CommandRejected('STOCK_UNAVAILABLE', msg);
      if (/below Our Price/i.test(msg)) {
        // Ein Urteil über GENAU diese Anfrage: sie will unter Preis verkaufen, ohne es zu sagen.
        // Wer es doch will, schickt einen NEUEN Auftrag mit der Bestätigung.
        throw new CommandRejected('SALE_BELOW_OUR_PRICE', msg);
      }
      throw err;
    }
    const after = query(
      'SELECT status, actual_sale_price, settlement_amount, settlement_status, revision FROM agent_transfers WHERE id = ?',
      [req.transferId],
    )[0];
    if (String(after?.status) !== 'sold') {
      throw new CommandNotEvaluated('SALE_NOT_APPLIED', `status is ${String(after?.status)}`);
    }
    return {
      transferId: req.transferId,
      status: String(after?.status ?? ''),
      actualSalePrice: Number(after?.actual_sale_price ?? 0),
      // Was uns zusteht, rechnet die SSOT des Hauses — nicht der Client.
      settlementAmount: Number(after?.settlement_amount ?? 0),
      settlementStatus: String(after?.settlement_status ?? ''),
      revision: Number(after?.revision ?? 0),
    } as unknown as Record<string, unknown>;
  });
}

// ── Agent abrechnen ───────────────────────────────────────────────────────

export interface MarkSettledRequest {
  transferId: string;
  amount: number;
  method: 'cash' | 'bank';
  expectedRevision: number;
}

export function parseMarkSettled(raw: unknown): MarkSettledRequest {
  if (!isPlain(raw)) throw new FinancialPayloadError('payload must be an object');
  onlyKnownFields(raw, ['transferId', 'amount', 'method', 'expectedRevision']);
  const method = String(raw.method ?? '');
  if (method !== 'cash' && method !== 'bank') {
    throw new FinancialPayloadError(`unknown settlement method: ${method || '(none)'}`);
  }
  return {
    transferId: reqString(raw.transferId, 'transferId'),
    // Wieder ein ausdrücklicher Betrag: `markTransferSettled` bucht ohne ihn den GANZEN Rest aus,
    // und „der Rest" ändert sich zwischen Lesen und Ankommen.
    amount: positive(raw.amount, 'amount'),
    method,
    expectedRevision: expectedRevisionOf(raw.expectedRevision),
  };
}

export function runMarkSettled(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseMarkSettled(raw);
  return runRemoteCommand(deps, identity, () => {
    const t = liveTransfer(req.transferId, identity.branchId);
    if (String(t.status) !== 'sold') {
      throw new CommandRejected('TRANSFER_NOT_SOLD',
        `this transfer is "${String(t.status)}" — only a sold one is settled`);
    }
    const total = Number(t.settlement_amount ?? 0);
    const already = Number(t.settlement_paid_amount ?? 0);
    if (already >= total - 0.005) {
      throw new CommandRejected('ALREADY_SETTLED', 'this transfer is already settled in full');
    }
    assertRevision('agent_transfers', req.transferId, req.expectedRevision, 'TRANSFER_NOT_FOUND');
    // Gemessen und behoben: `markTransferSold` schlaegt den AGENTEN in der geladenen Liste nach,
    // um den Kunden zu finden, gegen den die Forderung gebucht wird. Ohne ihn wird sie STILL gar
    // nicht gebucht — der Verkauf saehe richtig aus, und das Geld staende nirgends. Also beide
    // Listen laden, nicht nur die Transfers.
    useAgentStore.getState().loadAgents();
    useAgentStore.getState().loadTransfers();
    try {
      useAgentStore.getState().markTransferSettled(req.transferId, req.amount, req.method);
    } catch (err) {
      if (err instanceof TransferActionRejected) throw new CommandRejected(err.code, err.message);
      throw err;
    }

    const after = query(
      'SELECT settlement_amount, settlement_paid_amount, settlement_status, status, revision FROM agent_transfers WHERE id = ?',
      [req.transferId],
    )[0];
    const paid = Number(after?.settlement_paid_amount ?? 0);
    if (paid <= already) {
      throw new CommandNotEvaluated('SETTLEMENT_NOT_APPLIED', 'nothing was settled');
    }
    return {
      transferId: req.transferId,
      settlementAmount: Number(after?.settlement_amount ?? 0),
      settlementPaidAmount: paid,
      settlementOpenAmount: Math.max(0, Number(after?.settlement_amount ?? 0) - paid),
      appliedAmount: paid - already,
      settlementStatus: String(after?.settlement_status ?? ''),
      status: String(after?.status ?? ''),
      revision: Number(after?.revision ?? 0),
    } as unknown as Record<string, unknown>;
  });
}

// ── Die Anmeldung ─────────────────────────────────────────────────────────

// CENTRAL-C3H — dieselbe Klammer benutzen jetzt auch die Rueckgabe-Kette und die
// Lebenszyklus-Aktionen. Sie wird EXPORTIERT statt kopiert: die Uebersetzung von
// "eingefrorenes Urteil" nach "fachliches Nein" und von "nie bewertet" nach "offener Ausgang"
// darf es genau einmal geben.
export async function execFinancial(
  run: (deps: EngineDeps, identity: CommandIdentity, raw: unknown) => Promise<CommandOutcome>,
  op: string,
  payload: unknown,
  actor?: CommandActor,
): Promise<FinancialResult & { replayed: boolean }> {
  if (!actor) throw new Error(`${op} needs an authenticated identity`);
  const body = (payload as { input?: unknown } | null)?.input ?? payload;
  let outcome: CommandOutcome;
  try {
    outcome = await run(financialDeps(), { ...actor, op }, body);
  } catch (err) {
    if (err instanceof FinancialPayloadError) throw new BusinessError(err.code, err.message);
    throw err;
  }
  if (outcome.kind === 'rejected') {
    if (!outcome.frozen) throw new CommandNotEvaluated(outcome.code, outcome.message);
    throw new BusinessError(outcome.code, outcome.message);
  }
  return { ...(outcome.value as FinancialResult), replayed: outcome.replayed };
}

registerCommand(OP_INVOICES_APPLY_CREDIT, {
  kind: 'mutation',
  handler: (p, a?: CommandActor) => execFinancial(runApplyCredit, OP_INVOICES_APPLY_CREDIT, p, a),
});
registerCommand(OP_INVOICES_UPDATE_PAYMENT, {
  kind: 'mutation',
  handler: (p, a?: CommandActor) => execFinancial(runUpdatePayment, OP_INVOICES_UPDATE_PAYMENT, p, a),
});
registerCommand(OP_INVOICES_DELETE_PAYMENT, {
  kind: 'mutation',
  handler: (p, a?: CommandActor) => execFinancial(runDeletePayment, OP_INVOICES_DELETE_PAYMENT, p, a),
});
registerCommand(OP_ORDERS_CONVERT_TO_INVOICE, {
  kind: 'mutation',
  handler: (p, a?: CommandActor) => execFinancial(runConvertOrder, OP_ORDERS_CONVERT_TO_INVOICE, p, a),
});
registerCommand(OP_CONSIGNMENTS_RECORD_PAYOUT, {
  kind: 'mutation',
  handler: (p, a?: CommandActor) => execFinancial(runRecordPayout, OP_CONSIGNMENTS_RECORD_PAYOUT, p, a),
});
registerCommand(OP_TRANSFERS_MARK_SOLD, {
  kind: 'mutation',
  handler: (p, a?: CommandActor) => execFinancial(runMarkSold, OP_TRANSFERS_MARK_SOLD, p, a),
});
registerCommand(OP_TRANSFERS_MARK_SETTLED, {
  kind: 'mutation',
  handler: (p, a?: CommandActor) => execFinancial(runMarkSettled, OP_TRANSFERS_MARK_SETTLED, p, a),
});
