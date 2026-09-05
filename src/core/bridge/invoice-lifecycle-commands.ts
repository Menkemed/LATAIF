// CENTRAL-C3D — eine Rechnung ändern und eine Zahlung buchen, von einem zweiten Rechner aus.
//
// Nach dem Anlegen ist eine Rechnung kein Formular mehr, sondern ein Vorgang mit Geschichte: sie
// hat gebucht, Bestand verbraucht, vielleicht schon Geld gesehen. Deshalb sind die beiden
// Operationen hier deutlich enger als ihre lokalen Vorbilder — und deshalb sind es ZWEI.
//
//  1. **`invoices.update`** fährt `editInvoice`. Das ist im Haus EINE Transaktion, die die alte
//     Buchung zurücknimmt, Lose zurücklegt, die neuen Zeilen bucht, Lose verbraucht, neu postet,
//     den Status neu ableitet und einen Änderungsgrund verlangt. Nichts davon wird hier
//     nachgebaut.
//  2. **`invoices.record_payment`** fährt `recordPayment`. Eine Zahlung ist im Haus ein eigener
//     kanonischer Weg — mit Überzahlungs-Aufteilung, Statuswechsel und (bei Vollzahlung) einer
//     NEUEN Belegnummer aus dem passenden Zähler. Sie in `invoices.update` zu falten hieße, zwei
//     verschiedene Vorgänge unter einen Namen zu zwingen.
//
// Drei Verengungen gegenüber dem lokalen Vertrag, jede mit Grund:
//
//  • **`deltaPayment` gibt es hier nicht.** `editInvoice` kann eine Zahlung mitnehmen; aus der
//    Ferne wäre das ein zweiter Weg, Geld zu buchen — mit anderer Idempotenz. Zahlungen laufen
//    über die Zahlungsoperation, und nur dort.
//  • **Ein Änderungsauftrag braucht den Stand, den der Mensch gesehen hat** (`expectedUpdatedAt`).
//    Ein Client, der eine Rechnung um 10:00 liest und um 10:05 speichert, würde sonst still
//    überschreiben, was der Primary um 10:02 geändert hat. Der Vergleich läuft INNERHALB der
//    Transaktion, gegen die Zeile selbst.
//  • **Eine Zahlung braucht diesen Stand NICHT.** Sie ist keine Überschreibung, sondern ein
//    Zuwachs: zwei Rechner, die kurz nacheinander zahlen, haben beide recht. Der Primary rechnet
//    jede Zahlung gegen den FRISCHEN Rest — die zweite wird dann eben eine Überzahlung und damit
//    ein Guthaben, genau wie am Primary selbst. Was eine zweite Zahlung verhindert, ist die
//    Auftragskennung, nicht ein Zeitstempel.

import { getDatabase, saveDatabaseDurably } from '@/core/db/database';
import { query } from '@/core/db/helpers';
import {
  beginLedgerTransaction, commitLedgerTransaction, rollbackLedgerTransaction,
} from '@/core/ledger/posting';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { CommandNotEvaluated, CommandRejected, runRemoteCommand, type CommandOutcome, type EngineDeps } from './mutation-engine';
import type { CommandIdentity } from './command-ledger';
import { BusinessError, registerCommand, type CommandActor } from './command-registry';
import {
  InvoicePayloadError, asDomainVerdict, buildInvoiceLines, parseInvoicePayload,
} from './invoice-command';

export const OP_INVOICES_UPDATE = 'invoices.update';
export const OP_INVOICES_RECORD_PAYMENT = 'invoices.record_payment';

/** Die Zahlungsarten des Hauses. `credit` fehlt mit Absicht: Guthaben einzulösen ist ein eigener
 *  Vorgang (`applyCreditToInvoice`) mit eigenen Regeln — und der ist nicht freigegeben. */
const METHODS = ['cash', 'card', 'bank_transfer', 'benefit', 'other'] as const;
const CARD_BRANDS = ['normal', 'amex'] as const;

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// ── Änderungsauftrag ──────────────────────────────────────────────────────

export interface InvoiceUpdateRequest {
  id: string;
  /** Der Stand, den der Mensch gesehen hat. Ohne ihn kein Ändern. */
  expectedUpdatedAt: string;
  reason: string;
  body: ReturnType<typeof parseInvoicePayload>;
}

export function parseInvoiceUpdate(raw: unknown): InvoiceUpdateRequest {
  if (!isPlain(raw)) throw new InvoicePayloadError('payload must be an object');
  const { id, expectedUpdatedAt, reason, ...rest } = raw as {
    id?: unknown; expectedUpdatedAt?: unknown; reason?: unknown;
  };
  if (typeof id !== 'string' || !id.trim()) throw new InvoicePayloadError('id is required');
  if (typeof expectedUpdatedAt !== 'string' || !expectedUpdatedAt.trim()) {
    // Fail-closed: ohne den gesehenen Stand gibt es keine Aussage darüber, WORAUF sich diese
    // Änderung bezieht — und damit keine Möglichkeit, eine fremde Änderung zu bemerken.
    throw new InvoicePayloadError('expectedUpdatedAt is required — an edit must say which state it saw');
  }
  if (typeof reason !== 'string' || !reason.trim()) {
    // Dieselbe Pflicht wie im Haus: ein stiller Edit an einer gebuchten Rechnung ist keiner.
    throw new InvoicePayloadError('an edit reason is required');
  }
  // Eine Zahlung gehört nicht in einen Änderungsauftrag — sie hat ihre eigene Operation.
  if ('deltaPayment' in rest) {
    throw new InvoicePayloadError('a payment is its own command, not a field of an edit');
  }
  // Alles Übrige ist derselbe Rumpf wie beim Anlegen — inklusive seiner Verbotsliste.
  const body = parseInvoicePayload(rest);
  return { id, expectedUpdatedAt, reason: reason.trim(), body };
}

/**
 * Die Urteile, die `editInvoice` wirklich fällt — als LISTE, nicht als „alles, was nach einem
 * Geschäftsfehler aussieht". Ein Tippfehler im Code darf niemals als endgültiges fachliches Nein
 * eingefroren werden; er ist eine Störung, und die Kennung bleibt frei.
 */
const EDIT_VERDICTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^Cannot edit a cancelled invoice\.$/, 'INVOICE_CANCELLED'],
  [/^Invoice must have at least one line\.$/, 'INVOICE_NEEDS_A_LINE'],
  [/^An edit reason is required\.$/, 'EDIT_REASON_REQUIRED'],
  [/^Cannot edit invoice lines — /, 'INVOICE_HAS_RETURNS_OR_CREDIT_NOTES'],
  [/store credit .* has already been used/i, 'EDIT_CREDIT_ALREADY_USED'],
  [/^Cannot edit: this would shrink an existing overpayment store credit/, 'EDIT_WOULD_SHRINK_CREDIT'],
  [/^Cannot edit: the overpayment store credit from a payment has already been used/, 'EDIT_CREDIT_ALREADY_USED'],
];

function asEditVerdict(err: unknown): CommandRejected | null {
  // Zuerst die beiden Urteile, die schon der Anlegeweg kennt (Bestand, Ware beim Vertreter).
  const shared = asDomainVerdict(err);
  if (shared) return shared;
  const msg = err instanceof Error ? err.message : String(err);
  for (const [pattern, code] of EDIT_VERDICTS) {
    if (pattern.test(msg)) return new CommandRejected(code, msg);
  }
  return null;
}

export type InvoiceLifecycleResult = {
  invoiceId: string;
  invoiceNumber: string;
  status: string;
  grossAmount: number;
  paidAmount: number;
  openAmount: number;
  /** Der neue Stand — der nächste Änderungsauftrag muss ihn nennen. */
  updatedAt: string;
  /** Nur bei einer Zahlung gesetzt. */
  paymentId?: string;
};

function stateOf(id: string): InvoiceLifecycleResult {
  const r = query(
    'SELECT id, invoice_number, status, gross_amount, paid_amount, updated_at FROM invoices WHERE id = ?',
    [id],
  )[0];
  const gross = Number(r?.gross_amount ?? 0);
  const paid = Number(r?.paid_amount ?? 0);
  return {
    invoiceId: id,
    invoiceNumber: String(r?.invoice_number ?? ''),
    status: String(r?.status ?? ''),
    grossAmount: gross,
    paidAmount: paid,
    // Was offen ist, rechnet der Primary — genau wie im Lesebefehl.
    openAmount: Math.max(0, gross - paid),
    updatedAt: String(r?.updated_at ?? ''),
  };
}

export function invoiceLifecycleDeps(): EngineDeps {
  return {
    db: getDatabase() as never,
    begin: beginLedgerTransaction,
    commit: commitLedgerTransaction,
    rollback: rollbackLedgerTransaction,
    durableSave: saveDatabaseDurably,
    now: () => new Date().toISOString(),
  };
}

export function runInvoiceUpdate(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseInvoiceUpdate(raw);
  return runRemoteCommand(deps, identity, () => {
    const live = query('SELECT id, updated_at FROM invoices WHERE id = ?', [req.id])[0];
    if (!live) throw new CommandRejected('INVOICE_NOT_FOUND', 'no such invoice');
    // Der Vergleich läuft INNERHALB der Transaktion. Zwischen Lesen und Schreiben kann hier nichts
    // mehr dazwischenkommen: die eine Schreibreihenfolge hält den Platz.
    if (String(live.updated_at ?? '') !== req.expectedUpdatedAt) {
      // Ein Urteil über GENAU DIESE Anfrage: sie beschreibt einen Stand, den es nicht mehr gibt,
      // und sie wird nie wieder gültig. Der Mensch muss neu lesen und neu entscheiden — mit einer
      // neuen Auftragskennung.
      throw new CommandRejected('INVOICE_CHANGED', 'this invoice changed since you opened it');
    }

    // Die Zeilen entstehen mit den Werten des HAUSES: Steuerschema aus dem Produkt, Einstandskosten
    // aus dem gewählten Los, Los aufgelöst und ausdrücklich mitgegeben.
    const lines = buildInvoiceLines(req.body.lines);
    try {
      useInvoiceStore.getState().editInvoice(req.id, {
        lines,
        customerId: req.body.customerId,
        notes: req.body.notes,
        issuedAt: req.body.issuedDate,
        staffId: req.body.staffId,
        reason: req.reason,
      });
    } catch (err) {
      const verdict = asEditVerdict(err);
      if (verdict) throw verdict;
      throw err;
    }
    return stateOf(req.id) as unknown as Record<string, unknown>;
  });
}

// ── Zahlung ───────────────────────────────────────────────────────────────

export interface PaymentRequest {
  invoiceId: string;
  amount: number;
  method: typeof METHODS[number];
  notes?: string;
  cardBrand?: typeof CARD_BRANDS[number];
}

/**
 * Was ein Mensch am Zahlungsdialog eingibt — und nichts sonst. Ausdrücklich NICHT dabei: der
 * Zahlungsschlüssel (den vergibt der Primary), der neue Stand, der Status, die Belegnummer und die
 * Marke einer Sonderrechnung: `specialMarkOnFinal` entscheidet, unter welchem Zähler eine
 * Rechnung bei Vollzahlung ihre endgültige Nummer bekommt — das ist keine Eingabe eines
 * Zweitrechners.
 */
export function parsePaymentPayload(raw: unknown): PaymentRequest {
  if (!isPlain(raw)) throw new InvoicePayloadError('payload must be an object');
  const allowed = new Set(['invoiceId', 'amount', 'method', 'notes', 'cardBrand']);
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) throw new InvoicePayloadError(`unknown field: ${k}`);
  }
  const invoiceId = raw.invoiceId;
  if (typeof invoiceId !== 'string' || !invoiceId.trim()) throw new InvoicePayloadError('invoiceId is required');
  const amount = raw.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new InvoicePayloadError('amount must be a positive number');
  }
  const method = String(raw.method ?? '');
  if (!(METHODS as readonly string[]).includes(method)) {
    throw new InvoicePayloadError(`unknown payment method: ${method || '(none)'}`);
  }
  if (raw.notes !== undefined && typeof raw.notes !== 'string') throw new InvoicePayloadError('notes must be a string');
  if (raw.cardBrand !== undefined && !(CARD_BRANDS as readonly string[]).includes(String(raw.cardBrand))) {
    throw new InvoicePayloadError('unknown card brand');
  }
  return {
    invoiceId,
    amount,
    method: method as PaymentRequest['method'],
    notes: raw.notes as string | undefined,
    cardBrand: raw.cardBrand as PaymentRequest['cardBrand'],
  };
}

export function runInvoicePayment(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parsePaymentPayload(raw);
  return runRemoteCommand(deps, identity, () => {
    const live = query('SELECT id, status FROM invoices WHERE id = ?', [req.invoiceId])[0];
    if (!live) throw new CommandRejected('INVOICE_NOT_FOUND', 'no such invoice');
    if (String(live.status) === 'CANCELLED') {
      throw new CommandRejected('INVOICE_CANCELLED', 'a cancelled invoice takes no payment');
    }
    let paymentId: string;
    try {
      // Der Rest wird vom Haus gegen den FRISCHEN Stand gerechnet: Aufteilung bei Überzahlung,
      // Statuswechsel, und bei Vollzahlung die neue Belegnummer aus dem passenden Zähler.
      paymentId = useInvoiceStore.getState().recordPayment(
        req.invoiceId, req.amount, req.method, req.notes, undefined, req.cardBrand,
      );
    } catch (err) {
      const verdict = asEditVerdict(err);
      if (verdict) throw verdict;
      throw err;
    }
    return { ...stateOf(req.invoiceId), paymentId } as unknown as Record<string, unknown>;
  });
}

// ── Die Anmeldung ─────────────────────────────────────────────────────────

async function execute(
  run: (deps: EngineDeps, identity: CommandIdentity, raw: unknown) => Promise<CommandOutcome>,
  op: string,
  payload: unknown,
  actor?: CommandActor,
): Promise<InvoiceLifecycleResult & { replayed: boolean }> {
  if (!actor) throw new Error(`${op} needs an authenticated identity`);
  const body = (payload as { input?: unknown } | null)?.input ?? payload;
  let outcome: CommandOutcome;
  try {
    outcome = await run(invoiceLifecycleDeps(), { ...actor, op }, body);
  } catch (err) {
    // Ein unbrauchbarer Rumpf ist eine Antwort, keine Störung.
    if (err instanceof InvoicePayloadError) throw new BusinessError(err.code, err.message);
    throw err;
  }
  if (outcome.kind === 'rejected') {
    // NUR ein eingefrorenes Urteil ist ein fachliches Nein. Ein nicht eingefrorenes heißt: der
    // Vorgang wurde nie bewertet — und als „abgelehnt" gemeldet würde er den Versuch beenden,
    // obwohl nichts geschehen ist.
    if (!outcome.frozen) throw new CommandNotEvaluated(outcome.code, outcome.message);
    throw new BusinessError(outcome.code, outcome.message);
  }
  return { ...(outcome.value as unknown as InvoiceLifecycleResult), replayed: outcome.replayed };
}

registerCommand(OP_INVOICES_UPDATE, {
  kind: 'mutation',
  handler: (payload, actor?: CommandActor) => execute(runInvoiceUpdate, OP_INVOICES_UPDATE, payload, actor),
});

registerCommand(OP_INVOICES_RECORD_PAYMENT, {
  kind: 'mutation',
  handler: (payload, actor?: CommandActor) => execute(runInvoicePayment, OP_INVOICES_RECORD_PAYMENT, payload, actor),
});
