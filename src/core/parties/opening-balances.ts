// ════════════════════════════════════════════════════════════════════════════
// OPENING BALANCES S1 — Eröffnungsposten von Kunden und Lieferanten zum Stichtag 15.10.2026.
//
// Geschäftsregel (Owner, 15.10.2026): LATAIF führt ab dem 15.10.2026 die laufende Buchhaltung samt VAT. Alte
// Rechnungen, Einkäufe und Zahlungen werden NICHT einzeln nachgetragen; übernommen werden die tatsächlich
// vorhandenen Salden — je Kunde bzw. Lieferant als eigene, nummerierte Eröffnungsposten (OB-…):
//   • CUSTOMER_RECEIVABLE  Kunde schuldet uns        • SUPPLIER_PAYABLE  wir schulden dem Lieferanten
//   • CUSTOMER_ADVANCE     Kunde hat vorausbezahlt   • SUPPLIER_ADVANCE  wir haben vorausbezahlt
// je als einzelne alte Rechnung (DOCUMENT, mit Referenz) oder als zusammengefasster Restbetrag (REMAINDER, höchstens
// einer je Partei und Art, ausdrücklich ohne Überschneidung mit den Einzelposten). Keine gegenseitige Verrechnung.
//
// Was diese Datei NICHT tut — und warum (fail-closed, docs/opening-balances-contract.md):
//   • Sie BUCHT NICHT. Ein Posten steht immer auf accounting = PENDING: das Gegenkonto (Vorschlag: Eröffnungskonto
//     OPENING_BALANCE_EQUITY), das Buchungsdatum und die VAT-Behandlung bestätigt erst der Buchhalter (E1–E5). Die
//     Vorschau zeigt den VORGESCHLAGENEN Buchungssatz, ausdrücklich als nicht gebucht.
//   • Ein Posten ist deshalb noch NICHT bezahlbar und steht nicht in Receivables/Payables oder im Hauptbuch.
//   • Kein Umsatz, kein Einkauf, keine VAT, keine Kassen-, Bank- oder Benefit-Bewegung — weder jetzt noch bei der
//     späteren Freischaltung (die bucht nur Forderung/Verbindlichkeit gegen das bestätigte Eröffnungskonto).
//
// Geschrieben wird nur am Primary (Owner); der PC2 schickt dieselbe Absicht als Fernbefehl `opening_balances.create`
// / `.cancel`, der Primary prüft die Rolle des geprüften Absenders noch einmal (assertOwner).
// ════════════════════════════════════════════════════════════════════════════
import { v4 as uuid } from 'uuid';
import { getDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId, getNextDocumentNumber } from '@/core/db/helpers';
import { trackChange, watchSyncTracks } from '@/core/sync/sync-service';
import { logAuditOrThrow } from '@/core/audit/audit-log';
import { canonicalRole } from '@/core/models/types';
import { runOnPrimary } from '@/core/data/primary-action';
import { isClientMode } from '@/core/bridge/client-mode';
import { useAuthStore } from '@/stores/authStore';
import { watchLedgerPosts } from '@/core/ledger/posting';
import { businessDateIssue } from '@/core/utils/business-date';
import { payloadHash } from '@/core/bulk/bulk-math';
import type { BusinessReadContext } from '@/core/data/read-context';

/** Der Eröffnungsstichtag (Owner-Entscheidung): Salden zu Beginn des 15.10.2026. */
export const OPENING_CUTOFF_DATE = '2026-10-15';

export type OpeningPartyType = 'CUSTOMER' | 'SUPPLIER';
export const OPENING_KINDS = ['CUSTOMER_RECEIVABLE', 'CUSTOMER_ADVANCE', 'SUPPLIER_PAYABLE', 'SUPPLIER_ADVANCE'] as const;
export type OpeningKind = typeof OPENING_KINDS[number];
export const OPENING_SCOPES = ['DOCUMENT', 'REMAINDER'] as const;
export type OpeningScope = typeof OPENING_SCOPES[number];
/** Wie die alte Rechnung steuerlich behandelt wurde — nur festgehalten, nie gebucht. */
export const PRIOR_VAT_STATES = ['DECLARED_BEFORE', 'OUTSIDE_VAT', 'UNKNOWN'] as const;
export type PriorVat = typeof PRIOR_VAT_STATES[number];

export const KINDS_OF: Record<OpeningPartyType, readonly OpeningKind[]> = {
  CUSTOMER: ['CUSTOMER_RECEIVABLE', 'CUSTOMER_ADVANCE'],
  SUPPLIER: ['SUPPLIER_PAYABLE', 'SUPPLIER_ADVANCE'],
};

export const KIND_LABEL: Record<OpeningKind, string> = {
  CUSTOMER_RECEIVABLE: 'Customer owes us',
  CUSTOMER_ADVANCE: 'Customer paid in advance',
  SUPPLIER_PAYABLE: 'We owe the supplier',
  SUPPLIER_ADVANCE: 'We paid the supplier in advance',
};

/**
 * Die Freischaltung der Eröffnungsbuchung. Sie ist AUS und hat in diesem Stand keinen Schalter: es gibt keinen Weg,
 * der einen Eröffnungsposten bucht oder bezahlt. Erst nach den Antworten des Buchhalters (E1 Gegenkonto, E2 Datum,
 * E3 VAT) wird ein eigener, geprüfter Schritt gebaut.
 */
export const OPENING_BOOKING = {
  active: false as const,
  reason: 'Opening positions are recorded, not booked: the counter account, the booking date and the VAT treatment wait for the accountant (E1–E3).',
};

export class OpeningBalanceRejected extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'OpeningBalanceRejected';
  }
}
const nein = (code: string, msg: string): OpeningBalanceRejected => new OpeningBalanceRejected(code, `${msg} — nothing was changed`);

const MAX_AMOUNT = 100_000_000;
const toFils = (n: number): number => Math.round(n * 1000);

export interface OpeningCtx { branchId: string; userId: string; now: string; role?: string }

export interface OpeningItemInput {
  actionId: string;
  partyType: OpeningPartyType;
  partyId: string;
  kind: OpeningKind;
  scope: OpeningScope;
  reference?: string;
  /** JJJJ-MM-TT, vor dem Stichtag. */
  documentDate?: string;
  /** JJJJ-MM-TT. */
  dueDate?: string;
  amount: number;
  priorVat?: PriorVat;
  note?: string;
  /** Pflicht: „dieser Betrag steht nicht schon als Beleg in LATAIF". */
  confirmNotInLataif?: boolean;
  /** Pflicht, wenn Einzelposten und Restbetrag derselben Art nebeneinander stehen: „sie überschneiden sich nicht". */
  confirmNoOverlap?: boolean;
}

export interface OpeningItem {
  id: string;
  itemNumber: string;
  partyType: OpeningPartyType;
  partyId: string;
  kind: OpeningKind;
  scope: OpeningScope;
  reference: string | null;
  documentDate: string | null;
  dueDate: string | null;
  amount: number;
  cutoffDate: string;
  priorVat: PriorVat;
  note: string | null;
  status: 'RECORDED' | 'CANCELLED';
  accounting: 'PENDING' | 'POSTED';
  createdAt: string;
  createdBy: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
}

function itemOf(r: Record<string, unknown>): OpeningItem {
  const s = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
  return {
    id: String(r.id), itemNumber: String(r.item_number), partyType: String(r.party_type) as OpeningPartyType,
    partyId: String(r.party_id), kind: String(r.kind) as OpeningKind, scope: String(r.scope) as OpeningScope,
    reference: s(r.reference), documentDate: s(r.document_date), dueDate: s(r.due_date), amount: Number(r.amount) || 0,
    cutoffDate: String(r.cutoff_date), priorVat: String(r.prior_vat) as PriorVat, note: s(r.note),
    status: String(r.status) === 'CANCELLED' ? 'CANCELLED' : 'RECORDED',
    accounting: String(r.accounting) === 'POSTED' ? 'POSTED' : 'PENDING',
    createdAt: String(r.created_at), createdBy: s(r.created_by), cancelledAt: s(r.cancelled_at), cancelReason: s(r.cancel_reason),
  };
}

function assertOwner(ctx: OpeningCtx): void {
  if (canonicalRole(ctx.role) !== 'ADMIN') throw nein('PERMISSION_DENIED', 'only the owner (admin) may record opening balances');
}

/** Groß, ohne doppelte Leerzeichen: „inv 12" und „INV  12" sind dieselbe alte Rechnung. */
export function referenceKey(ref: string): string {
  return ref.trim().replace(/\s+/g, ' ').toUpperCase();
}

function text(v: unknown, what: string, max: number): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw nein('INVALID_INPUT', `${what} must be text`);
  const t = v.trim();
  if (t.length > max) throw nein('INVALID_INPUT', `${what} is longer than ${max} characters`);
  return t === '' ? undefined : t;
}

function isDay(v: string): boolean {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(v)) return false;
  const t = Date.parse(v + 'T00:00:00.000Z');
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
}

/** Die Partei in DIESER Filiale — sonst gibt es sie nicht. */
export function openingPartyOf(partyType: unknown, partyId: unknown, branchId: string): { type: OpeningPartyType; id: string; name: string } {
  if (partyType !== 'CUSTOMER' && partyType !== 'SUPPLIER') throw nein('PARTY_TYPE_INVALID', 'party type is CUSTOMER or SUPPLIER');
  if (typeof partyId !== 'string' || partyId.trim() === '') throw nein('PARTY_REQUIRED', 'choose the customer or supplier');
  if (partyType === 'CUSTOMER') {
    const c = query("SELECT first_name, last_name, company FROM customers WHERE id = ? AND branch_id = ? AND id NOT LIKE 'sys-%'", [partyId, branchId])[0];
    if (!c) throw nein('PARTY_NOT_FOUND', 'no such customer in this branch');
    const name = `${String(c.first_name ?? '')} ${String(c.last_name ?? '')}`.trim() || String(c.company ?? '') || partyId;
    return { type: 'CUSTOMER', id: partyId, name };
  }
  const s = query('SELECT name FROM suppliers WHERE id = ? AND branch_id = ?', [partyId, branchId])[0];
  if (!s) throw nein('PARTY_NOT_FOUND', 'no such supplier in this branch');
  return { type: 'SUPPLIER', id: partyId, name: String(s.name ?? partyId) };
}

/** Trägt eine LATAIF-Belegnummer diese Referenz? Dann ist sie schon im System und kein Eröffnungsposten. */
function lataifDocumentNamed(partyType: OpeningPartyType, key: string, branchId: string): string | null {
  const rows = partyType === 'CUSTOMER'
    ? query(`SELECT invoice_number AS n FROM invoices WHERE branch_id = ? AND UPPER(TRIM(invoice_number)) = ? LIMIT 1`, [branchId, key])
    : query(
      `SELECT purchase_number AS n FROM purchases WHERE branch_id = ? AND UPPER(TRIM(purchase_number)) = ?
       UNION ALL SELECT expense_number AS n FROM expenses WHERE branch_id = ? AND UPPER(TRIM(expense_number)) = ? LIMIT 1`,
      [branchId, key, branchId, key],
    );
  return rows[0] ? String(rows[0].n) : null;
}

export interface OpeningItemPlan {
  party: { type: OpeningPartyType; id: string; name: string };
  kind: OpeningKind;
  scope: OpeningScope;
  reference: string | null;
  referenceKey: string | null;
  documentDate: string | null;
  dueDate: string | null;
  amount: number;
  priorVat: PriorVat;
  note: string | null;
  /** Einzelposten und Restbetrag derselben Art stehen nebeneinander → ausdrücklich bestätigen. */
  needsOverlapConfirm: boolean;
}

/** Prüft eine Eingabe (rein lesend) — dieselbe Prüfung für die Vorschau der Maske und das Haus. */
export function planOpeningItem(input: Partial<OpeningItemInput>, branchId: string): OpeningItemPlan {
  const party = openingPartyOf(input.partyType, input.partyId, branchId);
  const kind = input.kind as OpeningKind;
  if (!KINDS_OF[party.type].includes(kind)) {
    throw nein('KIND_INVALID', `a ${party.type.toLowerCase()} takes ${KINDS_OF[party.type].join(' or ')}`);
  }
  const scope = input.scope as OpeningScope;
  if (!(OPENING_SCOPES as readonly string[]).includes(scope)) throw nein('SCOPE_INVALID', 'scope is DOCUMENT (one old invoice) or REMAINDER (summarised balance)');
  const amount = input.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
    throw nein('AMOUNT_INVALID', 'the amount must be above 0');
  }
  if (Math.abs(amount * 1000 - toFils(amount)) > 1e-6) throw nein('AMOUNT_INVALID', 'the amount has at most 3 decimals (fils)');
  const reference = text(input.reference, 'reference', 80) ?? null;
  if (scope === 'DOCUMENT' && !reference) throw nein('REFERENCE_REQUIRED', 'a single old invoice needs its reference (number)');
  const key = reference ? referenceKey(reference) : null;
  const documentDate = text(input.documentDate, 'document date', 10) ?? null;
  if (documentDate) {
    const issue = businessDateIssue(documentDate, 'Document date');
    if (issue) throw nein('INVALID_DATE', issue);
    if (documentDate >= OPENING_CUTOFF_DATE) throw nein('DATE_NOT_BEFORE_CUTOFF', `an opening position is from before ${OPENING_CUTOFF_DATE} — anything from that day on is recorded in LATAIF itself`);
  }
  const dueDate = text(input.dueDate, 'due date', 10) ?? null;
  if (dueDate && !isDay(dueDate)) throw nein('INVALID_DATE', 'Due date is not a valid date');
  const priorVat = (input.priorVat ?? 'UNKNOWN') as PriorVat;
  if (!(PRIOR_VAT_STATES as readonly string[]).includes(priorVat)) throw nein('PRIOR_VAT_INVALID', 'prior VAT is DECLARED_BEFORE, OUTSIDE_VAT or UNKNOWN');
  const note = text(input.note, 'note', 500) ?? null;

  if (key) {
    const lataif = lataifDocumentNamed(party.type, key, branchId);
    if (lataif) throw nein('REFERENCE_IS_LATAIF_DOCUMENT', `${lataif} is a LATAIF document — it is already in the system and is paid there, not as an opening position`);
    if (scope === 'DOCUMENT' && query(
      `SELECT 1 FROM opening_balance_items WHERE branch_id = ? AND party_type = ? AND party_id = ? AND kind = ?
         AND scope = 'DOCUMENT' AND status = 'RECORDED' AND reference_key = ? LIMIT 1`,
      [branchId, party.type, party.id, kind, key],
    ).length > 0) throw nein('DUPLICATE_REFERENCE', `${reference} is already recorded as an opening position of this ${party.type.toLowerCase()}`);
  }
  const andere = (s: OpeningScope): boolean => query(
    `SELECT 1 FROM opening_balance_items WHERE branch_id = ? AND party_type = ? AND party_id = ? AND kind = ? AND scope = ? AND status = 'RECORDED' LIMIT 1`,
    [branchId, party.type, party.id, kind, s],
  ).length > 0;
  if (scope === 'REMAINDER' && andere('REMAINDER')) {
    throw nein('REMAINDER_EXISTS', 'there is already a summarised remainder of this kind — cancel it first and record the new amount');
  }
  const needsOverlapConfirm = scope === 'REMAINDER' ? andere('DOCUMENT') : andere('REMAINDER');
  return {
    party, kind, scope, reference, referenceKey: key, documentDate, dueDate,
    amount: toFils(amount) / 1000, priorVat, note, needsOverlapConfirm,
  };
}

/** In der Transaktion des Aufrufers: einen Eröffnungsposten erfassen — Beleg, Protokoll, Sync; KEINE Buchung. */
export function recordOpeningItemInHouse(input: OpeningItemInput, ctx: OpeningCtx): OpeningItem {
  assertOwner(ctx);
  const actionId = typeof input.actionId === 'string' ? input.actionId.trim() : '';
  if (actionId.length < 8 || actionId.length > 100) throw nein('ACTION_ID_REQUIRED', 'a stable action id is required');
  // Der Fingerabdruck der ABSICHT (vor jeder Prüfung gegen den Bestand): eine wiederholte Aktion findet ihren Beleg,
  // auch wenn die Prüfung inzwischen „schon erfasst" sagen würde.
  const trim = (v: unknown): unknown => (typeof v === 'string' ? v.trim() : v ?? null);
  const hash = payloadHash({
    op: 'opening_item', partyType: trim(input.partyType), partyId: trim(input.partyId), kind: trim(input.kind), scope: trim(input.scope),
    reference: trim(input.reference) || null, documentDate: trim(input.documentDate) || null, dueDate: trim(input.dueDate) || null,
    amount: typeof input.amount === 'number' ? toFils(input.amount) : input.amount ?? null,
    priorVat: trim(input.priorVat) || 'UNKNOWN', note: trim(input.note) || null,
  });
  const schon = query('SELECT * FROM opening_balance_items WHERE branch_id = ? AND action_id = ?', [ctx.branchId, actionId])[0];
  if (schon) {
    if (String(schon.payload_hash) !== hash) throw nein('ACTION_ID_CONFLICT', 'this action id was already used for a different opening position');
    return itemOf(schon);
  }
  const plan = planOpeningItem(input, ctx.branchId);
  if (input.confirmNotInLataif !== true) {
    throw nein('CONFIRM_NOT_IN_LATAIF', 'confirm that this amount is not already a document (invoice, purchase, payment) in LATAIF');
  }
  if (plan.needsOverlapConfirm && input.confirmNoOverlap !== true) {
    throw nein('CONFIRM_NO_OVERLAP', 'single old invoices and the summarised remainder of the same kind must not overlap — confirm it');
  }

  const buchung = watchLedgerPosts('opening position');
  const abgleich = watchSyncTracks('opening position');
  const id = uuid();
  const number = getNextDocumentNumber('OB');
  getDatabase().run(
    `INSERT INTO opening_balance_items (id, branch_id, item_number, party_type, party_id, kind, scope, reference, reference_key,
       document_date, due_date, amount, cutoff_date, prior_vat, note, status, accounting, action_id, payload_hash,
       created_at, created_by, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RECORDED', 'PENDING', ?, ?, ?, ?, 0)`,
    [id, ctx.branchId, number, plan.party.type, plan.party.id, plan.kind, plan.scope, plan.reference, plan.referenceKey,
      plan.documentDate, plan.dueDate, plan.amount, OPENING_CUTOFF_DATE, plan.priorVat, plan.note, actionId, hash,
      ctx.now, ctx.userId || null],
  );
  trackChange('opening_balance_items', id, 'insert', {});
  logAuditOrThrow({
    module: 'Finance', entityType: 'opening_balance_items', entityId: id, action: 'CREATE',
    newValue: {
      itemNumber: number, partyType: plan.party.type, partyId: plan.party.id, partyName: plan.party.name, kind: plan.kind,
      scope: plan.scope, reference: plan.reference, documentDate: plan.documentDate, dueDate: plan.dueDate, amount: plan.amount,
      cutoffDate: OPENING_CUTOFF_DATE, priorVat: plan.priorVat, accounting: 'PENDING',
      confirmedNotInLataif: true, confirmedNoOverlap: plan.needsOverlapConfirm ? true : null,
    },
    actor: { userId: ctx.userId, branchId: ctx.branchId },
  });
  buchung();
  abgleich();
  return itemOf(query('SELECT * FROM opening_balance_items WHERE id = ?', [id])[0]);
}

export interface OpeningCancelInput { itemId: string; reason: string }

/** Storno eines noch nicht gebuchten Postens: Status, Grund, Protokoll, Sync. Gelöscht wird nie. */
export function cancelOpeningItemInHouse(input: OpeningCancelInput, ctx: OpeningCtx): OpeningItem {
  assertOwner(ctx);
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!reason) throw nein('REASON_REQUIRED', 'please give a reason for the cancellation');
  if (reason.length > 500) throw nein('INVALID_INPUT', 'the reason is longer than 500 characters');
  const row = query('SELECT * FROM opening_balance_items WHERE id = ? AND branch_id = ?', [String(input.itemId ?? ''), ctx.branchId])[0];
  if (!row) throw nein('ITEM_NOT_FOUND', 'no such opening position in this branch');
  if (String(row.status) === 'CANCELLED') throw nein('ALREADY_CANCELLED', `${String(row.item_number)} is already cancelled`);
  // Ein gebuchter Posten braucht eine Gegenbuchung — dieser Weg existiert erst mit der Freischaltung.
  if (String(row.accounting) !== 'PENDING') throw nein('BOOKED_NEEDS_REVERSAL', `${String(row.item_number)} is booked — it is corrected with a reversal, not here`);
  const buchung = watchLedgerPosts('opening position cancel');
  const abgleich = watchSyncTracks('opening position cancel');
  getDatabase().run(
    `UPDATE opening_balance_items SET status = 'CANCELLED', cancelled_at = ?, cancelled_by = ?, cancel_reason = ?, revision = revision + 1
      WHERE id = ? AND status = 'RECORDED' AND accounting = 'PENDING'`,
    [ctx.now, ctx.userId || null, reason, String(row.id)],
  );
  if (Number(query('SELECT changes() AS n')[0]?.n) !== 1) throw nein('ITEM_CHANGED', 'the opening position changed meanwhile');
  trackChange('opening_balance_items', String(row.id), 'update', {});
  logAuditOrThrow({
    module: 'Finance', entityType: 'opening_balance_items', entityId: String(row.id), action: 'STATUS_CHANGE', field: 'status',
    oldValue: 'RECORDED', newValue: { status: 'CANCELLED', itemNumber: row.item_number, amount: Number(row.amount), reason },
    actor: { userId: ctx.userId, branchId: ctx.branchId },
  });
  buchung();
  abgleich();
  return itemOf(query('SELECT * FROM opening_balance_items WHERE id = ?', [String(row.id)])[0]);
}

// ── Lesen (Maske am Primary und, als Fernauskunft, am PC2; die Filiale kommt aus dem Ausweis) ───────────────

export interface ProposedLine { account: string; side: 'DEBIT' | 'CREDIT'; counterparty: string | null }

/** Der VORGESCHLAGENE Buchungssatz einer Art — nur Anzeige, nicht gebucht (Gegenkonto: E1 des Buchhalters). */
export function proposedBookingOf(kind: OpeningKind): ProposedLine[] {
  switch (kind) {
    case 'CUSTOMER_RECEIVABLE': return [{ account: 'ACCOUNTS_RECEIVABLE', side: 'DEBIT', counterparty: 'CUSTOMER' }, { account: 'OPENING_BALANCE_EQUITY', side: 'CREDIT', counterparty: null }];
    case 'CUSTOMER_ADVANCE': return [{ account: 'OPENING_BALANCE_EQUITY', side: 'DEBIT', counterparty: null }, { account: 'CUSTOMER_CREDIT', side: 'CREDIT', counterparty: 'CUSTOMER' }];
    case 'SUPPLIER_PAYABLE': return [{ account: 'OPENING_BALANCE_EQUITY', side: 'DEBIT', counterparty: null }, { account: 'ACCOUNTS_PAYABLE', side: 'CREDIT', counterparty: 'SUPPLIER' }];
    case 'SUPPLIER_ADVANCE': return [{ account: 'SUPPLIER_CREDIT', side: 'DEBIT', counterparty: 'SUPPLIER' }, { account: 'OPENING_BALANCE_EQUITY', side: 'CREDIT', counterparty: null }];
  }
}

export function openingItemsFor(ctx: { branchId: string }, partyType: OpeningPartyType, partyId: string): OpeningItem[] {
  return query(
    `SELECT * FROM opening_balance_items WHERE branch_id = ? AND party_type = ? AND party_id = ?
      ORDER BY CASE status WHEN 'RECORDED' THEN 0 ELSE 1 END, created_at, item_number`,
    [ctx.branchId, partyType, partyId],
  ).map(itemOf);
}

export interface OpenLataifDocument { kind: 'invoice' | 'purchase' | 'expense'; id: string; number: string; date: string; total: number; open: number }

/** Was LATAIF für diese Partei schon offen hat — damit nichts doppelt übernommen wird (dieselben Regeln wie Receivables/Pay Supplier). */
export function openLataifDocumentsFor(ctx: { branchId: string }, partyType: OpeningPartyType, partyId: string): OpenLataifDocument[] {
  if (partyType === 'CUSTOMER') {
    return query(
      `SELECT i.id, i.invoice_number, COALESCE(i.issued_at, i.created_at) AS d, i.gross_amount, i.paid_amount, COALESCE(cn.cancel_amount, 0) AS cn
         FROM invoices i
         LEFT JOIN (SELECT invoice_id, SUM(receivable_cancel_amount) AS cancel_amount FROM credit_notes WHERE status != 'CANCELLED' GROUP BY invoice_id) cn
           ON cn.invoice_id = i.id
        WHERE i.customer_id = ? AND i.branch_id = ? AND i.status NOT IN ('CANCELLED', 'DRAFT', 'RETURNED')
          AND (i.gross_amount - i.paid_amount - COALESCE(cn.cancel_amount, 0)) > 0.005
        ORDER BY d, i.invoice_number`,
      [partyId, ctx.branchId],
    ).map((r) => ({
      kind: 'invoice' as const, id: String(r.id), number: String(r.invoice_number ?? ''), date: String(r.d ?? '').slice(0, 10),
      total: Number(r.gross_amount) || 0,
      open: Math.max(0, toFils(Number(r.gross_amount) || 0) - toFils(Number(r.paid_amount) || 0) - toFils(Number(r.cn) || 0)) / 1000,
    }));
  }
  const out: OpenLataifDocument[] = [];
  for (const r of query(
    `SELECT p.id, p.purchase_number, p.purchase_date, p.total_amount, p.paid_amount,
            COALESCE((SELECT SUM(pp.amount) FROM purchase_payments pp WHERE pp.purchase_id = p.id AND pp.method = 'credit'), 0) AS credit_paid
       FROM purchases p WHERE p.supplier_id = ? AND p.branch_id = ? AND p.status NOT IN ('PAID', 'CANCELLED')`,
    [partyId, ctx.branchId],
  )) {
    const openF = toFils(Number(r.total_amount) || 0) - toFils(Number(r.paid_amount) || 0) - toFils(Number(r.credit_paid) || 0);
    if (openF > 0) out.push({ kind: 'purchase', id: String(r.id), number: String(r.purchase_number ?? ''), date: String(r.purchase_date ?? ''), total: Number(r.total_amount) || 0, open: openF / 1000 });
  }
  for (const r of query(
    `SELECT e.id, e.expense_number, e.expense_date, e.created_at, e.amount, e.paid_amount,
            COALESCE((SELECT SUM(ep.amount) FROM expense_payments ep WHERE ep.expense_id = e.id AND ep.method = 'credit'), 0) AS credit_paid
       FROM expenses e WHERE e.supplier_id = ? AND e.branch_id = ? AND e.status NOT IN ('PAID', 'CANCELLED')`,
    [partyId, ctx.branchId],
  )) {
    const openF = toFils(Number(r.amount) || 0) - toFils(Number(r.paid_amount) || 0) - toFils(Number(r.credit_paid) || 0);
    if (openF > 0) out.push({ kind: 'expense', id: String(r.id), number: String(r.expense_number ?? ''), date: String(r.expense_date ?? r.created_at ?? '').slice(0, 10), total: Number(r.amount) || 0, open: openF / 1000 });
  }
  return out.sort((a, b) => (a.date === b.date ? a.number.localeCompare(b.number) : a.date.localeCompare(b.date)));
}

export interface OpeningKindTotal { kind: OpeningKind; label: string; count: number; amount: number; proposed: ProposedLine[] }

export interface PartyAccount {
  party: { type: OpeningPartyType; id: string; name: string };
  cutoffDate: string;
  booking: typeof OPENING_BOOKING;
  items: OpeningItem[];
  /** Je Art: nur erfasste (nicht stornierte) Posten — alle PENDING, nicht gebucht, nicht bezahlbar. */
  totals: OpeningKindTotal[];
  lataifOpen: OpenLataifDocument[];
  lataifOpenTotal: number;
  /** Die Vorschau einer Eingabe der Maske (wenn mitgeschickt): der geprüfte Plan oder der Grund, warum nicht. */
  preview: { plan: OpeningItemPlan | null; issue: string | null; code: string | null } | null;
}

export function kindTotals(items: readonly OpeningItem[], kinds: readonly OpeningKind[]): OpeningKindTotal[] {
  return kinds.map((kind) => {
    const live = items.filter((i) => i.kind === kind && i.status === 'RECORDED');
    return {
      kind, label: KIND_LABEL[kind], count: live.length,
      amount: live.reduce((s, i) => s + toFils(i.amount), 0) / 1000, proposed: proposedBookingOf(kind),
    };
  });
}

/** Alles, was der Bereich „Opening balances" einer Partei zeichnet — am Primary und (Fernauskunft) am PC2 gleich. */
export function partyAccountFor(ctx: BusinessReadContext | { branchId: string }, input: { partyType?: unknown; partyId?: unknown; preview?: unknown }): PartyAccount {
  const party = openingPartyOf(input.partyType, input.partyId, ctx.branchId);
  const items = openingItemsFor(ctx, party.type, party.id);
  const lataifOpen = openLataifDocumentsFor(ctx, party.type, party.id);
  let preview: PartyAccount['preview'] = null;
  if (input.preview && typeof input.preview === 'object' && !Array.isArray(input.preview)) {
    try {
      preview = { plan: planOpeningItem({ ...(input.preview as Record<string, unknown>), partyType: party.type, partyId: party.id } as Partial<OpeningItemInput>, ctx.branchId), issue: null, code: null };
    } catch (e) {
      preview = { plan: null, issue: e instanceof Error ? e.message : String(e), code: (e as { code?: string }).code ?? null };
    }
  }
  return {
    party, cutoffDate: OPENING_CUTOFF_DATE, booking: OPENING_BOOKING, items,
    totals: kindTotals(items, KINDS_OF[party.type]),
    lataifOpen, lataifOpenTotal: lataifOpen.reduce((s, d) => s + toFils(d.open), 0) / 1000,
    preview,
  };
}

export interface OpeningOverview {
  cutoffDate: string;
  booking: typeof OPENING_BOOKING;
  totals: OpeningKindTotal[];
  parties: Array<{ partyType: OpeningPartyType; partyId: string; name: string; kind: OpeningKind; count: number; amount: number }>;
  cancelledCount: number;
  /** Der vorhandene Kassen-Anfangsbestand (Settings → Hauptbuch, Stichtag 01.01.2000) — hier nur gezeigt, nie verschoben. */
  cashOpening: { settings: { cash: number; bank: number; benefit: number }; ledger: { cash: number; bank: number; benefit: number }; bookedOn: string };
}

/** Die gemeinsame Abstimmungsliste aller Eröffnungsposten der Filiale (schreibgeschützt). */
export function openingOverviewFor(ctx: { branchId: string }): OpeningOverview {
  const items = query('SELECT * FROM opening_balance_items WHERE branch_id = ?', [ctx.branchId]).map(itemOf);
  const live = items.filter((i) => i.status === 'RECORDED');
  const names = new Map<string, string>();
  for (const r of query("SELECT id, first_name, last_name, company FROM customers WHERE branch_id = ?", [ctx.branchId])) {
    names.set('CUSTOMER:' + String(r.id), `${String(r.first_name ?? '')} ${String(r.last_name ?? '')}`.trim() || String(r.company ?? ''));
  }
  for (const r of query('SELECT id, name FROM suppliers WHERE branch_id = ?', [ctx.branchId])) names.set('SUPPLIER:' + String(r.id), String(r.name ?? ''));
  const groups = new Map<string, { partyType: OpeningPartyType; partyId: string; name: string; kind: OpeningKind; count: number; fils: number }>();
  for (const i of live) {
    const k = `${i.partyType}:${i.partyId}:${i.kind}`;
    const g = groups.get(k) ?? { partyType: i.partyType, partyId: i.partyId, name: names.get(`${i.partyType}:${i.partyId}`) || i.partyId, kind: i.kind, count: 0, fils: 0 };
    g.count += 1; g.fils += toFils(i.amount);
    groups.set(k, g);
  }
  const setting = (key: string): number => Number(query('SELECT value FROM settings WHERE branch_id = ? AND key = ?', [ctx.branchId, key])[0]?.value) || 0;
  const ledgerNet = (account: string): number => Number(query(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0) AS n FROM ledger_entries
      WHERE branch_id = ? AND source_module = 'OPENING_BALANCE' AND account = ?`, [ctx.branchId, account],
  )[0]?.n) || 0;
  return {
    cutoffDate: OPENING_CUTOFF_DATE, booking: OPENING_BOOKING,
    totals: kindTotals(items, OPENING_KINDS),
    parties: [...groups.values()].sort((a, b) => a.name.localeCompare(b.name)).map((g) => ({ partyType: g.partyType, partyId: g.partyId, name: g.name, kind: g.kind, count: g.count, amount: g.fils / 1000 })),
    cancelledCount: items.length - live.length,
    cashOpening: {
      settings: { cash: setting('finance.opening_cash'), bank: setting('finance.opening_bank'), benefit: setting('finance.opening_benefit') },
      ledger: { cash: ledgerNet('CASH'), bank: ledgerNet('BANK'), benefit: ledgerNet('BENEFIT') },
      bookedOn: '2000-01-01',
    },
  };
}

// ── Anschlüsse am Primary: exklusiv, EINE Transaktion, erst danach durabel ──────
function localCtx(): OpeningCtx {
  const session = useAuthStore.getState().session as { role?: string } | null | undefined;
  return { branchId: currentBranchId(), userId: currentUserId(), now: new Date().toISOString(), role: session?.role };
}
const nurPrimary = (): Promise<never> => Promise.reject(new OpeningBalanceRejected('PRIMARY_ONLY', 'this computer records opening balances through the main computer'));

export function recordOpeningItemOnPrimary(input: OpeningItemInput, reload: () => void): Promise<OpeningItem> {
  if (isClientMode()) return nurPrimary();
  return runOnPrimary(() => recordOpeningItemInHouse(input, localCtx()), reload);
}
export function cancelOpeningItemOnPrimary(input: OpeningCancelInput, reload: () => void): Promise<OpeningItem> {
  if (isClientMode()) return nurPrimary();
  return runOnPrimary(() => cancelOpeningItemInHouse(input, localCtx()), reload);
}
