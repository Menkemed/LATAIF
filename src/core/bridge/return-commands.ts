// CENTRAL-C3H — die Rückgabe mit Gutschrift, von einem zweiten Rechner. Vier Stufen.
//
// C3G hat diese Kette AUSDRÜCKLICH vertagt statt halb gebaut, und das war richtig: sie ist der
// einzige Weg im Haus, der eine eigene Steuerurkunde erzeugt (die Gutschrift), Ware zurück in den
// Bestand bucht, Wareneinsatz und Steuer rückabwickelt, eine Forderung kürzt UND Geld auszahlt.
// Halb gebaut wäre sie gefährlicher gewesen als gar nicht gebaut.
//
// Was hier NICHT passiert: es wird keine Rückgabe- oder Steuerlogik nachgebaut. Jede der vier
// Operationen ruft die Funktion, die auch der Mensch am Primary auslöst — `createReturn`,
// `approveReturn`, `refundReturn`, `recordRefundPayment`. Mengen-Obergrenze, Bestandsrückführung,
// COGS-Storno, Steuer-Korrektur, Guthaben-Riegel, Kartengebühr und Nummernkreis bleiben dort.
//
// Drei Dinge sind neu und tragen den ganzen Schutz:
//
//  1. **Der Preis ist kein Feld des Rumpfes.** Der Client sagt WELCHE Rechnungszeile und WIE
//     VIELE Stück. Was das kostet und wieviel Steuer darauf entfällt, rechnet das Haus aus der
//     Rechnung (`returnLineAmounts`). Ein Preis im Rumpf hieße: ein zweiter Rechner könnte eine
//     Rückgabe zu einem Betrag buchen, den es auf dieser Rechnung nie gab.
//  2. **Die Menge entscheidet sich zweimal.** Der Vergleich der gelesenen Fassung fällt zuerst
//     (die Rechnung bekommt bei JEDER Rückgabe eine neue Fassung — dafür sorgen die Trigger),
//     und danach prüft `createReturn` die verbleibende Menge noch einmal gegen die Datenbank.
//     Zwei Rechner, die gleichzeitig das letzte Stück zurücknehmen wollen, können deshalb nicht
//     beide gewinnen: der zweite läuft in die Fassung, und selbst wenn nicht, in die Menge.
//  3. **Der Store liest seine EIGENE Liste.** `approveReturn`, `refundReturn` und
//     `recordRefundPayment` schlagen die Rückgabe in der geladenen Liste ihres Stores nach. Am
//     Primary lädt ein Bildschirm sie; ein Fernauftrag hat keinen. Ohne `loadReturns()` davor
//     täte keine der drei irgendetwas — still.

import { query } from '@/core/db/helpers';
import { returnLineAmounts } from '@/core/returns/return-lines';
import { useSalesReturnStore } from '@/stores/salesReturnStore';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { useProductStore } from '@/stores/productStore';
import {
  CommandNotEvaluated, CommandRejected, runRemoteCommand, type CommandOutcome, type EngineDeps,
} from './mutation-engine';
import type { CommandIdentity } from './command-ledger';
import { registerCommand, type CommandActor } from './command-registry';
import {
  FinancialPayloadError, assertRevision, execFinancial, expectedRevisionOf, financialDeps,
  invoiceState, isPlain, liveInvoice, onlyKnownFields, optString, positive, reqString,
} from './financial-commands';

export const OP_RETURNS_CREATE = 'returns.create';
export const OP_RETURNS_APPROVE = 'returns.approve';
export const OP_RETURNS_REFUND = 'returns.refund';
export const OP_RETURNS_RECORD_REFUND_PAYMENT = 'returns.record_refund_payment';

/** Die vier Namen der Rückgabe-Kette — dieselbe Liste kennt auch Rust. */
export const C3H_RETURN_MUTATIONS = [
  OP_RETURNS_CREATE, OP_RETURNS_APPROVE, OP_RETURNS_REFUND, OP_RETURNS_RECORD_REFUND_PAYMENT,
] as const;

/**
 * Die Art, wie die Ware weiterbehandelt wird. Vier Werte, und alle vier haben eine andere
 * buchhalterische Folge — deshalb eine feste Liste und kein freier Text.
 */
const DISPOSITIONS = ['IN_STOCK', 'KEEP_AS_OWN', 'WRITE_OFF', 'RETURN_TO_OWNER'] as const;
/** Wie erstattet wird. `credit` erzeugt Guthaben statt Bargeld — es steht bewusst mit drin. */
const REFUND_METHODS = ['cash', 'bank', 'benefit', 'card', 'credit', 'other'] as const;

// ── Der Zustand einer Rückgabe, wie ihn auch der Lesebefehl zeigt ─────────

export function returnState(id: string): Record<string, unknown> {
  const r = query(
    `SELECT id, return_number, invoice_id, status, total_amount, vat_corrected, refund_amount,
            refund_paid_amount, refund_status, refund_method, product_disposition, revision
       FROM sales_returns WHERE id = ?`, [id],
  )[0];
  const total = Number(r?.total_amount ?? 0);
  const paid = Number(r?.refund_paid_amount ?? 0);
  return {
    returnId: id,
    returnNumber: String(r?.return_number ?? ''),
    invoiceId: String(r?.invoice_id ?? ''),
    status: String(r?.status ?? ''),
    totalAmount: total,
    vatCorrected: Number(r?.vat_corrected ?? 0),
    refundPaidAmount: paid,
    // Was noch offen ist, rechnet der Primary — nicht der Client.
    refundOpenAmount: Math.max(0, total - paid),
    refundStatus: String(r?.refund_status ?? ''),
    refundMethod: String(r?.refund_method ?? ''),
    productDisposition: String(r?.product_disposition ?? ''),
    revision: Number(r?.revision ?? 0),
  };
}

/** Eine Rückgabe dieser Filiale, die noch nicht verworfen ist. */
function liveReturn(id: string, branchId: string): Record<string, unknown> {
  const r = query(
    'SELECT id, branch_id, invoice_id, status, refund_status, total_amount, refund_paid_amount '
    + 'FROM sales_returns WHERE id = ? AND branch_id = ?', [id, branchId],
  )[0];
  if (!r) throw new CommandRejected('RETURN_NOT_FOUND', 'no such return in this branch');
  if (String(r.status) === 'REJECTED') {
    throw new CommandRejected('RETURN_CANCELLED', 'this return was cancelled — it takes no further action');
  }
  return r;
}

// ── 1) Eine Rückgabe anlegen ──────────────────────────────────────────────

export interface CreateReturnRequest {
  invoiceId: string;
  expectedRevision: number;
  lines: Array<{ invoiceLineId: string; quantity: number }>;
  refundMethod?: typeof REFUND_METHODS[number];
  productDisposition?: typeof DISPOSITIONS[number];
  reason?: string;
  notes?: string;
}

export function parseCreateReturn(raw: unknown): CreateReturnRequest {
  if (!isPlain(raw)) throw new FinancialPayloadError('payload must be an object');
  onlyKnownFields(raw, ['invoiceId', 'expectedRevision', 'lines', 'refundMethod', 'productDisposition', 'reason', 'notes']);
  if (!Array.isArray(raw.lines) || raw.lines.length === 0) {
    throw new FinancialPayloadError('a return needs at least one line');
  }
  const lines = raw.lines.map((l, i) => {
    if (!isPlain(l)) throw new FinancialPayloadError(`line ${i} must be an object`);
    // Ausdrücklich NUR diese beiden Felder. Preis und Steuer rechnet das Haus.
    onlyKnownFields(l, ['invoiceLineId', 'quantity']);
    return {
      invoiceLineId: reqString(l.invoiceLineId, `line ${i} invoiceLineId`),
      quantity: positive(l.quantity, `line ${i} quantity`),
    };
  });
  const out: CreateReturnRequest = {
    invoiceId: reqString(raw.invoiceId, 'invoiceId'),
    expectedRevision: expectedRevisionOf(raw.expectedRevision),
    lines,
  };
  if (raw.refundMethod !== undefined) {
    const m = String(raw.refundMethod);
    if (!(REFUND_METHODS as readonly string[]).includes(m)) {
      throw new FinancialPayloadError(`unknown refund method: ${m}`);
    }
    out.refundMethod = m as CreateReturnRequest['refundMethod'];
  }
  if (raw.productDisposition !== undefined) {
    const d = String(raw.productDisposition);
    if (!(DISPOSITIONS as readonly string[]).includes(d)) {
      throw new FinancialPayloadError(`unknown product disposition: ${d}`);
    }
    out.productDisposition = d as CreateReturnRequest['productDisposition'];
  }
  out.reason = optString(raw.reason, 'reason');
  out.notes = optString(raw.notes, 'notes');
  return out;
}

/** Die Urteile, die `createReturn` wirklich fällt — als Liste, nicht als „klingt fachlich". */
const CREATE_VERDICTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/exceeds remaining/i, 'RETURN_QUANTITY_EXCEEDED'],
  [/at least one line/i, 'RETURN_NO_LINES'],
  [/non-negative|must be non-negative/i, 'RETURN_INVALID_QUANTITY'],
];

function asVerdict(err: unknown, table: ReadonlyArray<readonly [RegExp, string]>): CommandRejected | null {
  const msg = err instanceof Error ? err.message : String(err);
  for (const [pattern, code] of table) if (pattern.test(msg)) return new CommandRejected(code, msg);
  return null;
}

export function runCreateReturn(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseCreateReturn(raw);
  return runRemoteCommand(deps, identity, () => {
    liveInvoice(req.invoiceId, identity.branchId);
    // Die Fassung der RECHNUNG ist hier der Wächter: sie steigt bei jeder Rückgabe auf sie
    // (Trigger), also sieht ein Client, der die verbleibende Menge gelesen hat, sofort, dass
    // sich darunter etwas bewegt hat.
    assertRevision('invoices', req.invoiceId, req.expectedRevision, 'INVOICE_NOT_FOUND');

    // Preis und Steuer aus der RECHNUNG, nicht aus dem Rumpf.
    const lines = req.lines.map((l) => {
      const src = query(
        'SELECT id, product_id, quantity, line_total, vat_amount FROM invoice_lines WHERE id = ? AND invoice_id = ?',
        [l.invoiceLineId, req.invoiceId],
      )[0];
      if (!src) {
        throw new CommandRejected('RETURN_LINE_NOT_ON_INVOICE',
          'one of these lines does not belong to this invoice');
      }
      const amounts = returnLineAmounts(
        { quantity: Number(src.quantity ?? 1), lineTotal: Number(src.line_total ?? 0), vatAmount: Number(src.vat_amount ?? 0) },
        l.quantity,
      );
      return {
        invoiceLineId: l.invoiceLineId,
        productId: String(src.product_id ?? '') || undefined,
        quantity: amounts.quantity,
        unitPrice: amounts.unitPrice,
        vatAmount: amounts.vatAmount,
      };
    });

    useSalesReturnStore.getState().loadReturns();
    let created: { id: string };
    try {
      created = useSalesReturnStore.getState().createReturn({
        invoiceId: req.invoiceId,
        refundMethod: req.refundMethod,
        productDisposition: req.productDisposition ?? 'IN_STOCK',
        reason: req.reason,
        notes: req.notes,
        lines,
      });
    } catch (err) {
      const verdict = asVerdict(err, CREATE_VERDICTS);
      if (verdict) throw verdict;
      throw err;
    }
    useInvoiceStore.getState().loadInvoices();
    useProductStore.getState().loadProducts();
    return {
      ...returnState(created.id),
      invoiceRevision: Number(query('SELECT revision FROM invoices WHERE id = ?', [req.invoiceId])[0]?.revision ?? 0),
    };
  });
}

// ── 2) Eine Rückgabe genehmigen ───────────────────────────────────────────

export interface ReturnActionRequest {
  returnId: string;
  expectedRevision: number;
}

export function parseApproveReturn(raw: unknown): ReturnActionRequest {
  if (!isPlain(raw)) throw new FinancialPayloadError('payload must be an object');
  onlyKnownFields(raw, ['returnId', 'expectedRevision']);
  return {
    returnId: reqString(raw.returnId, 'returnId'),
    expectedRevision: expectedRevisionOf(raw.expectedRevision),
  };
}

export function runApproveReturn(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseApproveReturn(raw);
  return runRemoteCommand(deps, identity, () => {
    const r = liveReturn(req.returnId, identity.branchId);
    // `approveReturn` ist absichtlich idempotent — es tut bei schon genehmigten Rückgaben
    // nichts. Für einen FERNAUFTRAG wäre das kein Erfolg, sondern ein stilles Nichts: der
    // Mensch am anderen Rechner sähe „gespeichert" und hätte keine Gutschrift. Also hier ein
    // ausdrückliches Urteil, bevor überhaupt etwas läuft.
    if (String(r.status) !== 'REQUESTED') {
      throw new CommandRejected('RETURN_NOT_REQUESTED',
        `this return is "${String(r.status)}" — only a requested one is approved`);
    }
    assertRevision('sales_returns', req.returnId, req.expectedRevision, 'RETURN_NOT_FOUND');
    useSalesReturnStore.getState().loadReturns();
    useSalesReturnStore.getState().approveReturn(req.returnId);

    const after = returnState(req.returnId);
    if (String(after.status) === 'REQUESTED') {
      // Nicht als Erfolg einfrieren, was nicht geschehen ist.
      throw new CommandNotEvaluated('APPROVE_NOT_APPLIED', 'the return is still requested');
    }
    const cn = query('SELECT id, credit_note_number FROM credit_notes WHERE sales_return_id = ? LIMIT 1', [req.returnId])[0];
    useInvoiceStore.getState().loadInvoices();
    return {
      ...after,
      creditNoteId: String(cn?.id ?? ''),
      creditNoteNumber: String(cn?.credit_note_number ?? ''),
      invoice: invoiceState(String(after.invoiceId)),
    };
  });
}

// ── 3) Eine Rückgabe erstatten ────────────────────────────────────────────

export interface RefundReturnRequest {
  returnId: string;
  amount: number;
  expectedRevision: number;
}

/**
 * Ein ausdrücklicher Betrag, kein „erstatte alles". Derselbe Grund wie überall bei Geld: „alles"
 * ist eine Zahl, die sich zwischen Lesen und Ankommen ändert. Das Haus deckelt ihn weiterhin auf
 * das, was wirklich in bar zurückfließen kann (`cashRefundCap`) — was am Ende geflossen ist,
 * sagt die Antwort.
 */
export function parseRefundReturn(raw: unknown): RefundReturnRequest {
  if (!isPlain(raw)) throw new FinancialPayloadError('payload must be an object');
  onlyKnownFields(raw, ['returnId', 'amount', 'expectedRevision']);
  return {
    returnId: reqString(raw.returnId, 'returnId'),
    amount: positive(raw.amount, 'amount'),
    expectedRevision: expectedRevisionOf(raw.expectedRevision),
  };
}

const REFUND_VERDICTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/settled as store credit/i, 'REFUND_IS_STORE_CREDIT'],
  [/Store credit can only be granted/i, 'REFUND_NOT_STORE_CREDIT'],
];

export function runRefundReturn(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseRefundReturn(raw);
  return runRemoteCommand(deps, identity, () => {
    const r = liveReturn(req.returnId, identity.branchId);
    if (String(r.refund_status) === 'REFUNDED') {
      throw new CommandRejected('ALREADY_REFUNDED', 'this return is already fully refunded');
    }
    assertRevision('sales_returns', req.returnId, req.expectedRevision, 'RETURN_NOT_FOUND');
    const before = Number(r.refund_paid_amount ?? 0);
    const beforeStatus = String(r.status);
    useSalesReturnStore.getState().loadReturns();
    try {
      // Der Weg des Hauses: genehmigen, falls nötig (die Gutschrift MUSS existieren, bevor Geld
      // fließt), Deckel rechnen, auszahlen — oder, wenn nichts in bar zurückfließen kann, die
      // Rückgabe schließen, weil die Gutschrift allein sie erledigt.
      useSalesReturnStore.getState().refundReturn(req.returnId, req.amount);
    } catch (err) {
      const verdict = asVerdict(err, REFUND_VERDICTS);
      if (verdict) throw verdict;
      throw err;
    }
    const after = returnState(req.returnId);
    const paid = Number(after.refundPaidAmount ?? 0);
    if (paid <= before && String(after.status) === beforeStatus) {
      throw new CommandNotEvaluated('REFUND_NOT_APPLIED', 'nothing changed on this return');
    }
    useInvoiceStore.getState().loadInvoices();
    return { ...after, appliedAmount: paid - before, invoice: invoiceState(String(after.invoiceId)) };
  });
}

// ── 4) Die tatsächliche Auszahlung buchen ─────────────────────────────────

export interface RecordRefundPaymentRequest {
  returnId: string;
  amount: number;
  method: typeof REFUND_METHODS[number];
  expectedRevision: number;
  date?: string;
  deductCardFee?: boolean;
}

export function parseRecordRefundPayment(raw: unknown): RecordRefundPaymentRequest {
  if (!isPlain(raw)) throw new FinancialPayloadError('payload must be an object');
  onlyKnownFields(raw, ['returnId', 'amount', 'method', 'expectedRevision', 'date', 'deductCardFee']);
  const method = String(raw.method ?? '');
  if (!(REFUND_METHODS as readonly string[]).includes(method)) {
    throw new FinancialPayloadError(`unknown refund method: ${method || '(none)'}`);
  }
  const out: RecordRefundPaymentRequest = {
    returnId: reqString(raw.returnId, 'returnId'),
    amount: positive(raw.amount, 'amount'),
    method: method as RecordRefundPaymentRequest['method'],
    expectedRevision: expectedRevisionOf(raw.expectedRevision),
  };
  out.date = optString(raw.date, 'date');
  // Wer die Kartengebühr trägt, ist eine Entscheidung des Menschen — sie schaltet nichts anderes
  // ab und gilt nur für genau diese Auszahlung.
  if (raw.deductCardFee !== undefined) out.deductCardFee = raw.deductCardFee === true;
  return out;
}

export function runRecordRefundPayment(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseRecordRefundPayment(raw);
  return runRemoteCommand(deps, identity, () => {
    const r = liveReturn(req.returnId, identity.branchId);
    if (String(r.refund_status) === 'REFUNDED') {
      throw new CommandRejected('ALREADY_REFUNDED', 'this return is already fully refunded');
    }
    assertRevision('sales_returns', req.returnId, req.expectedRevision, 'RETURN_NOT_FOUND');
    const before = Number(r.refund_paid_amount ?? 0);
    useSalesReturnStore.getState().loadReturns();
    try {
      useSalesReturnStore.getState().recordRefundPayment(
        req.returnId, req.amount, req.method, req.date, req.deductCardFee,
      );
    } catch (err) {
      const verdict = asVerdict(err, REFUND_VERDICTS);
      if (verdict) throw verdict;
      throw err;
    }
    const after = returnState(req.returnId);
    const paid = Number(after.refundPaidAmount ?? 0);
    if (paid <= before) {
      // Das Haus zahlt nichts aus, wenn der Kunde gar keinen Überschuss hat — das ist ein
      // Urteil über genau diese Anfrage, kein Erfolg.
      throw new CommandRejected('NO_CASH_REFUNDABLE',
        'nothing was paid out — the client has no surplus left on this invoice');
    }
    useInvoiceStore.getState().loadInvoices();
    return { ...after, appliedAmount: paid - before, invoice: invoiceState(String(after.invoiceId)) };
  });
}

// ── Die Anmeldung ─────────────────────────────────────────────────────────

registerCommand(OP_RETURNS_CREATE, {
  kind: 'mutation',
  handler: (p, a?: CommandActor) => execFinancial(runCreateReturn, OP_RETURNS_CREATE, p, a),
});
registerCommand(OP_RETURNS_APPROVE, {
  kind: 'mutation',
  handler: (p, a?: CommandActor) => execFinancial(runApproveReturn, OP_RETURNS_APPROVE, p, a),
});
registerCommand(OP_RETURNS_REFUND, {
  kind: 'mutation',
  handler: (p, a?: CommandActor) => execFinancial(runRefundReturn, OP_RETURNS_REFUND, p, a),
});
registerCommand(OP_RETURNS_RECORD_REFUND_PAYMENT, {
  kind: 'mutation',
  handler: (p, a?: CommandActor) => execFinancial(runRecordRefundPayment, OP_RETURNS_RECORD_REFUND_PAYMENT, p, a),
});

export { financialDeps as returnDeps };
