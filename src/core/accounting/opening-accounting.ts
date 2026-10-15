// ════════════════════════════════════════════════════════════════════════════
// B1 OPENING ACCOUNTING — Eröffnungsbilanz zum 15.10.2026: Erfassung und Abstimmung, KEINE Buchung.
//
// Der Owner erfasst alle Anfangssalden selbst. Die Kunden-/Lieferanten-Eröffnungsposten (`opening_balance_items`,
// Customer/Supplier Edit) und die Altbestands-Vorschau (`/old-stock`) gibt es schon; hier kommen die übrigen Saldoarten als
// eigene, nummerierte Entwurfsbelege dazu (`opening_account_items`, Nummernkreis OB- wie die Parteiposten):
//   • CASH_BALANCE / BANK_BALANCE / BENEFIT_BALANCE  der gezählte bzw. laut Auszug vorhandene Stand am Stichtag
//     (je Konto höchstens einer; geändert wird er per Korrektur). Er ist ein SOLL-Stand, kein Zugang: die Übersicht
//     vergleicht ihn mit dem Hauptbuch vor dem Stichtag (inkl. einer vorhandenen Settings-Eröffnung vom 01.01.2000)
//     und zeigt die Differenz — gebucht wird sie nicht.
//   • LOAN_RECEIVABLE / LOAN_PAYABLE                 alte Darlehen (Gegenpartei Pflicht, nicht schon in LATAIF)
//   • OTHER_ASSET / OTHER_LIABILITY                  sonstige Vermögenswerte / Verbindlichkeiten
//   • VAT_PAYABLE / VAT_RECEIVABLE                   VAT-Eröffnungssalden offener Perioden (nur notiert)
//
// Jeder Beleg: Betrag in Fils genau, Referenz und Pflichtgrund, Stichtag, Audit (Akteur, Zeit), Storno mit Grund und
// Stand-Prüfung, kontrollierte Korrektur (der alte Beleg wird in DERSELBEN Transaktion storniert und mit dem neuen
// verknüpft), Aktionskennung + Payload-Hash (Wiederholung findet ihren Beleg). Am PC2 derselbe Weg als Fernbefehl
// (`opening_accounts.create` / `.cancel`), geschrieben nur am Primary.
//
// Was diese Datei NICHT tut: buchen. accounting bleibt PENDING; es gibt hier keinen Weg zu POSTED. Kein Hauptbuch, keine
// Kasse/Bank/Benefit, keine VAT, keine Rechnung, kein NBR-Export. Die Übersicht ist immer PROVISIONAL (B2 bucht erst nach
// den Antworten des Buchhalters E1–E4).
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
import { payloadHash } from '@/core/bulk/bulk-math';
import {
  OPENING_CUTOFF_DATE, OPENING_KINDS, kindTotals, referenceKey,
  type OpeningItem, type OpeningKind, type OpeningKindTotal,
} from '@/core/parties/opening-balances';
import { oldStockReconciliationFor } from '@/core/stock/old-stock-reconciliation';
import {
  balanceSheetAt, cutoffBoundaryIso, cutoffTransactionsFor, sideBalanceBeforeFils, trialBalanceAt,
  type BalanceSheet, type CutoffTransactions, type TrialBalance,
} from './ledger-statements';

export { OPENING_CUTOFF_DATE };

export const OPENING_ACCOUNT_KINDS = [
  'CASH_BALANCE', 'BANK_BALANCE', 'BENEFIT_BALANCE', 'LOAN_RECEIVABLE', 'LOAN_PAYABLE', 'OTHER_ASSET', 'OTHER_LIABILITY', 'VAT_PAYABLE', 'VAT_RECEIVABLE',
] as const;
export type OpeningAccountKind = typeof OPENING_ACCOUNT_KINDS[number];
export const COUNT_KINDS: readonly OpeningAccountKind[] = ['CASH_BALANCE', 'BANK_BALANCE', 'BENEFIT_BALANCE'];
export type CounterpartyType = 'CUSTOMER' | 'SUPPLIER' | 'OTHER';

export interface OpeningAccountKindInfo {
  label: string;
  side: 'ASSET' | 'LIABILITY';
  /** Ein gezählter Stand (Soll-Stand des Kontos), kein Zugang. */
  count: boolean;
  /** Das Hauptbuchkonto, mit dem ein gezählter Stand verglichen wird. */
  ledgerAccount: string | null;
  counterparty: 'REQUIRED' | 'OPTIONAL' | 'NONE';
  /** Vorschlag, nicht bindend (E1–E4). */
  proposed: string;
}

export const OPENING_ACCOUNT_KIND_INFO: Readonly<Record<OpeningAccountKind, OpeningAccountKindInfo>> = {
  CASH_BALANCE: { label: 'Cash on hand (counted)', side: 'ASSET', count: true, ledgerAccount: 'CASH', counterparty: 'NONE', proposed: 'Difference to the ledger: Dr CASH / Cr OPENING_BALANCE_EQUITY (or reverse)' },
  BANK_BALANCE: { label: 'Bank balance (statement)', side: 'ASSET', count: true, ledgerAccount: 'BANK', counterparty: 'NONE', proposed: 'Difference to the ledger: Dr BANK / Cr OPENING_BALANCE_EQUITY (or reverse)' },
  BENEFIT_BALANCE: { label: 'Benefit balance (app)', side: 'ASSET', count: true, ledgerAccount: 'BENEFIT', counterparty: 'NONE', proposed: 'Difference to the ledger: Dr BENEFIT / Cr OPENING_BALANCE_EQUITY (or reverse)' },
  LOAN_RECEIVABLE: { label: 'Loan given (they owe us)', side: 'ASSET', count: false, ledgerAccount: null, counterparty: 'REQUIRED', proposed: 'Dr LOAN_RECEIVABLE / Cr OPENING_BALANCE_EQUITY' },
  LOAN_PAYABLE: { label: 'Loan taken (we owe)', side: 'LIABILITY', count: false, ledgerAccount: null, counterparty: 'REQUIRED', proposed: 'Dr OPENING_BALANCE_EQUITY / Cr LOAN_PAYABLE' },
  OTHER_ASSET: { label: 'Other asset', side: 'ASSET', count: false, ledgerAccount: null, counterparty: 'OPTIONAL', proposed: 'Dr (account to be decided) / Cr OPENING_BALANCE_EQUITY' },
  OTHER_LIABILITY: { label: 'Other liability', side: 'LIABILITY', count: false, ledgerAccount: null, counterparty: 'OPTIONAL', proposed: 'Dr OPENING_BALANCE_EQUITY / Cr (account to be decided)' },
  VAT_PAYABLE: { label: 'VAT payable to NBR (open period)', side: 'LIABILITY', count: false, ledgerAccount: null, counterparty: 'NONE', proposed: 'Dr OPENING_BALANCE_EQUITY / Cr VAT (account and period: E3)' },
  VAT_RECEIVABLE: { label: 'VAT refund due from NBR', side: 'ASSET', count: false, ledgerAccount: null, counterparty: 'NONE', proposed: 'Dr VAT (account and period: E3) / Cr OPENING_BALANCE_EQUITY' },
};

/** Die Buchung der Eröffnung ist AUS und hat in B1 keinen Schalter. */
export const OPENING_ACCOUNTING_BOOKING = {
  active: false as const,
  reason: 'Recorded and reconciled only — nothing here is booked. The opening booking (B2) waits for the accountant (E1–E4).',
};

export class OpeningAccountRejected extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'OpeningAccountRejected'; }
}
const nein = (code: string, msg: string): OpeningAccountRejected => new OpeningAccountRejected(code, `${msg} — nothing was changed`);

const MAX_AMOUNT = 100_000_000;
const toFils = (n: number): number => Math.round(n * 1000);
const bhd = (fils: number): number => fils / 1000;

export interface OpeningAccountCtx { branchId: string; userId: string; now: string; role?: string }

export interface OpeningAccountInput {
  actionId: string;
  kind: OpeningAccountKind;
  amount: number;
  reference: string;
  reason: string;
  counterpartyType?: CounterpartyType;
  counterpartyId?: string;
  counterpartyName?: string;
  /** Kontrollierte Korrektur: dieser noch nicht gebuchte Beleg wird in derselben Transaktion storniert und ersetzt. */
  correctsId?: string;
  expectedCorrectsRevision?: number;
  /** Pflicht bei Darlehen: „dieses Darlehen steht nicht schon in LATAIF (Debts)". */
  confirmNotInLataif?: boolean;
}

export interface OpeningAccountItem {
  id: string;
  itemNumber: string;
  kind: OpeningAccountKind;
  amount: number;
  reference: string;
  reason: string;
  counterpartyType: CounterpartyType | null;
  counterpartyId: string | null;
  counterpartyName: string | null;
  cutoffDate: string;
  correctsId: string | null;
  status: 'RECORDED' | 'CANCELLED';
  accounting: 'PENDING' | 'POSTED';
  createdAt: string;
  createdBy: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  revision: number;
}

function itemOf(r: Record<string, unknown>): OpeningAccountItem {
  const s = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
  return {
    id: String(r.id), itemNumber: String(r.item_number), kind: String(r.kind) as OpeningAccountKind, amount: Number(r.amount) || 0,
    reference: String(r.reference ?? ''), reason: String(r.reason ?? ''),
    counterpartyType: s(r.counterparty_type) as CounterpartyType | null, counterpartyId: s(r.counterparty_id), counterpartyName: s(r.counterparty_name),
    cutoffDate: String(r.cutoff_date), correctsId: s(r.corrects_id),
    status: String(r.status) === 'CANCELLED' ? 'CANCELLED' : 'RECORDED',
    accounting: String(r.accounting) === 'POSTED' ? 'POSTED' : 'PENDING',
    createdAt: String(r.created_at), createdBy: s(r.created_by), cancelledAt: s(r.cancelled_at), cancelReason: s(r.cancel_reason),
    revision: Number(r.revision) || 0,
  };
}

function assertOwner(ctx: OpeningAccountCtx): void {
  if (canonicalRole(ctx.role) !== 'ADMIN') throw nein('PERMISSION_DENIED', 'only the owner (admin) may record opening balances');
}

/**
 * B1 FINAL GATE — die Eröffnungsbilanz ist vertraulich: auch LESEN nur der Owner. Am Primary prüft das die Fernauskunft
 * mit der Rolle aus dem geprüften Token (Rust legt sie in `actor`, der Client kann sie nicht setzen) — nicht nur die Maske.
 */
export function mayReadOpeningAccounting(role: string | null | undefined): boolean {
  return canonicalRole(role ?? undefined) === 'ADMIN';
}

function text(v: unknown, what: string, max: number): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw nein('INVALID_INPUT', `${what} must be text`);
  const t = v.trim();
  if (t.length > max) throw nein('INVALID_INPUT', `${what} is longer than ${max} characters`);
  return t === '' ? undefined : t;
}

export interface OpeningAccountPlan {
  kind: OpeningAccountKind;
  amount: number;
  reference: string;
  referenceKey: string;
  reason: string;
  counterparty: { type: CounterpartyType; id: string | null; name: string } | null;
  corrects: { id: string; itemNumber: string; amount: number; revision: number } | null;
  /** Für einen gezählten Stand: der Hauptbuchsaldo vor dem Stichtag und die Differenz (nur Anzeige). */
  ledgerBefore: number | null;
  difference: number | null;
  proposed: string;
}

function counterpartyOf(input: Partial<OpeningAccountInput>, rule: OpeningAccountKindInfo['counterparty'], branchId: string): OpeningAccountPlan['counterparty'] {
  const type = input.counterpartyType;
  const given = type !== undefined || input.counterpartyId !== undefined || input.counterpartyName !== undefined;
  if (rule === 'NONE') {
    if (given) throw nein('COUNTERPARTY_NOT_ALLOWED', 'this kind of balance has no counterparty');
    return null;
  }
  if (!given) {
    if (rule === 'REQUIRED') throw nein('COUNTERPARTY_REQUIRED', 'name who owes or is owed (customer, supplier or other)');
    return null;
  }
  if (type === 'CUSTOMER' || type === 'SUPPLIER') {
    if (input.counterpartyName !== undefined) throw nein('INVALID_INPUT', 'a customer or supplier is chosen by id, not by name');
    const id = typeof input.counterpartyId === 'string' ? input.counterpartyId.trim() : '';
    if (!id) throw nein('COUNTERPARTY_REQUIRED', `choose the ${type.toLowerCase()}`);
    if (type === 'CUSTOMER') {
      const c = query("SELECT first_name, last_name, company FROM customers WHERE id = ? AND branch_id = ? AND id NOT LIKE 'sys-%'", [id, branchId])[0];
      if (!c) throw nein('COUNTERPARTY_NOT_FOUND', 'no such customer in this branch');
      return { type, id, name: `${String(c.first_name ?? '')} ${String(c.last_name ?? '')}`.trim() || String(c.company ?? '') || id };
    }
    const sp = query('SELECT name FROM suppliers WHERE id = ? AND branch_id = ?', [id, branchId])[0];
    if (!sp) throw nein('COUNTERPARTY_NOT_FOUND', 'no such supplier in this branch');
    return { type, id, name: String(sp.name ?? id) };
  }
  if (type === 'OTHER') {
    if (input.counterpartyId !== undefined) throw nein('INVALID_INPUT', 'another counterparty has a name, not an id');
    const name = text(input.counterpartyName, 'counterparty name', 120);
    if (!name) throw nein('COUNTERPARTY_REQUIRED', 'enter the name of the counterparty');
    return { type, id: null, name };
  }
  throw nein('COUNTERPARTY_TYPE_INVALID', 'counterparty is CUSTOMER, SUPPLIER or OTHER');
}

/** Prüft eine Eingabe (rein lesend) — dieselbe Prüfung für die Vorschau der Maske und das Haus. */
export function planOpeningAccountItem(input: Partial<OpeningAccountInput>, branchId: string): OpeningAccountPlan {
  const kind = input.kind as OpeningAccountKind;
  if (!(OPENING_ACCOUNT_KINDS as readonly string[]).includes(kind)) throw nein('KIND_INVALID', `kind is one of ${OPENING_ACCOUNT_KINDS.join(', ')}`);
  const info = OPENING_ACCOUNT_KIND_INFO[kind];
  const amount = input.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || Math.abs(amount) > MAX_AMOUNT) throw nein('AMOUNT_INVALID', 'the amount must be a number');
  if (Math.abs(amount * 1000 - toFils(amount)) > 1e-6) throw nein('AMOUNT_INVALID', 'the amount has at most 3 decimals (fils)');
  if (info.count) {
    // Ein gezählter Stand darf 0 sein; nur die Bank kann überzogen (negativ) sein.
    if (amount < 0 && kind !== 'BANK_BALANCE') throw nein('AMOUNT_INVALID', 'a counted balance cannot be below 0');
  } else if (amount <= 0) {
    throw nein('AMOUNT_INVALID', 'the amount must be above 0');
  }
  const reference = text(input.reference, 'reference', 80);
  if (!reference) throw nein('REFERENCE_REQUIRED', info.count ? 'name the count or the statement (for example “Cash count 15.10.2026” or the statement number)' : 'a reference (contract, document or description) is required');
  const reason = text(input.reason, 'reason', 500);
  if (!reason) throw nein('REASON_REQUIRED', 'please give the reason / basis of this balance');
  const counterparty = counterpartyOf(input, info.counterparty, branchId);
  const key = referenceKey(reference);

  let corrects: OpeningAccountPlan['corrects'] = null;
  if (input.correctsId !== undefined) {
    const old = query('SELECT * FROM opening_account_items WHERE id = ? AND branch_id = ?', [String(input.correctsId ?? ''), branchId])[0];
    if (!old) throw nein('ITEM_NOT_FOUND', 'the document to correct does not exist in this branch');
    if (String(old.status) !== 'RECORDED') throw nein('ALREADY_CANCELLED', `${String(old.item_number)} is cancelled — it cannot be corrected`);
    if (String(old.accounting) !== 'PENDING') throw nein('BOOKED_NEEDS_REVERSAL', `${String(old.item_number)} is booked — it is corrected with a reversal, not here`);
    if (String(old.kind) !== kind) throw nein('KIND_MISMATCH', `${String(old.item_number)} is a different kind of balance`);
    if (typeof input.expectedCorrectsRevision !== 'number' || input.expectedCorrectsRevision !== Number(old.revision)) {
      throw nein('ITEM_CHANGED', `${String(old.item_number)} changed meanwhile — reload and correct again`);
    }
    corrects = { id: String(old.id), itemNumber: String(old.item_number), amount: Number(old.amount) || 0, revision: Number(old.revision) || 0 };
  }
  const anderer = corrects?.id ?? '';
  if (info.count) {
    const live = query("SELECT item_number FROM opening_account_items WHERE branch_id = ? AND kind = ? AND status = 'RECORDED' AND id != ? LIMIT 1", [branchId, kind, anderer])[0];
    if (live) throw nein('COUNT_EXISTS', `${String(live.item_number)} already records this balance — correct it instead`);
  } else {
    const dup = query(
      "SELECT item_number FROM opening_account_items WHERE branch_id = ? AND kind = ? AND reference_key = ? AND status = 'RECORDED' AND id != ? LIMIT 1",
      [branchId, kind, key, anderer],
    )[0];
    if (dup) throw nein('DUPLICATE_REFERENCE', `${reference} is already recorded as ${String(dup.item_number)}`);
  }
  if (kind === 'LOAN_RECEIVABLE' || kind === 'LOAN_PAYABLE') {
    const loan = query('SELECT loan_number FROM debts WHERE branch_id = ? AND UPPER(TRIM(loan_number)) = ? LIMIT 1', [branchId, key])[0];
    if (loan) throw nein('REFERENCE_IS_LATAIF_DOCUMENT', `${String(loan.loan_number)} is a LATAIF loan — it is already in the system`);
  }
  let ledgerBefore: number | null = null;
  let difference: number | null = null;
  if (info.count && info.ledgerAccount) {
    const f = sideBalanceBeforeFils({ branchId }, cutoffBoundaryIso(OPENING_CUTOFF_DATE), [info.ledgerAccount]);
    ledgerBefore = bhd(f);
    difference = bhd(toFils(amount) - f);
  }
  return {
    kind, amount: bhd(toFils(amount)), reference, referenceKey: key, reason, counterparty, corrects, ledgerBefore, difference, proposed: info.proposed,
  };
}

/** In der Transaktion des Aufrufers: einen Eröffnungsbeleg erfassen (oder einen ersetzen) — Beleg, Protokoll, Sync; KEINE Buchung. */
export function recordOpeningAccountItemInHouse(input: OpeningAccountInput, ctx: OpeningAccountCtx): OpeningAccountItem {
  assertOwner(ctx);
  const actionId = typeof input.actionId === 'string' ? input.actionId.trim() : '';
  if (actionId.length < 8 || actionId.length > 100) throw nein('ACTION_ID_REQUIRED', 'a stable action id is required');
  const trim = (v: unknown): unknown => (typeof v === 'string' ? v.trim() : v ?? null);
  const hash = payloadHash({
    op: 'opening_account', kind: trim(input.kind), amount: typeof input.amount === 'number' ? toFils(input.amount) : input.amount ?? null,
    reference: trim(input.reference) || null, reason: trim(input.reason) || null,
    counterpartyType: trim(input.counterpartyType) || null, counterpartyId: trim(input.counterpartyId) || null, counterpartyName: trim(input.counterpartyName) || null,
    correctsId: trim(input.correctsId) || null, expectedCorrectsRevision: input.expectedCorrectsRevision ?? null,
  });
  const schon = query('SELECT * FROM opening_account_items WHERE branch_id = ? AND action_id = ?', [ctx.branchId, actionId])[0];
  if (schon) {
    if (String(schon.payload_hash) !== hash) throw nein('ACTION_ID_CONFLICT', 'this action id was already used for a different opening document');
    return itemOf(schon);
  }
  const plan = planOpeningAccountItem(input, ctx.branchId);
  if ((plan.kind === 'LOAN_RECEIVABLE' || plan.kind === 'LOAN_PAYABLE') && input.confirmNotInLataif !== true) {
    throw nein('CONFIRM_NOT_IN_LATAIF', 'confirm that this loan is not already recorded in LATAIF (Debts)');
  }

  const buchung = watchLedgerPosts('opening document');
  const abgleich = watchSyncTracks('opening document');
  const db = getDatabase();
  const actor = { userId: ctx.userId, branchId: ctx.branchId };
  const id = uuid();
  const number = getNextDocumentNumber('OB');
  if (plan.corrects) {
    // Zuerst der alte Beleg (der Teilindex erlaubt sonst keinen zweiten gezählten Stand) — nur, wenn er unverändert ist.
    db.run(
      `UPDATE opening_account_items SET status = 'CANCELLED', cancelled_at = ?, cancelled_by = ?, cancel_reason = ?, revision = revision + 1
        WHERE id = ? AND branch_id = ? AND status = 'RECORDED' AND accounting = 'PENDING' AND revision = ?`,
      [ctx.now, ctx.userId || null, `corrected by ${number}: ${plan.reason}`, plan.corrects.id, ctx.branchId, plan.corrects.revision],
    );
    if (Number(query('SELECT changes() AS n')[0]?.n) !== 1) throw nein('ITEM_CHANGED', `${plan.corrects.itemNumber} changed meanwhile`);
    trackChange('opening_account_items', plan.corrects.id, 'update', {});
    logAuditOrThrow({
      module: 'Finance', entityType: 'opening_account_items', entityId: plan.corrects.id, action: 'STATUS_CHANGE', field: 'status',
      oldValue: 'RECORDED', newValue: { status: 'CANCELLED', itemNumber: plan.corrects.itemNumber, amount: plan.corrects.amount, correctedBy: number, reason: plan.reason },
      actor,
    });
  }
  db.run(
    `INSERT INTO opening_account_items (id, branch_id, item_number, kind, amount, reference, reference_key, reason,
       counterparty_type, counterparty_id, counterparty_name, cutoff_date, corrects_id, status, accounting, action_id, payload_hash,
       created_at, created_by, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RECORDED', 'PENDING', ?, ?, ?, ?, 0)`,
    [id, ctx.branchId, number, plan.kind, plan.amount, plan.reference, plan.referenceKey, plan.reason,
      plan.counterparty?.type ?? null, plan.counterparty?.id ?? null, plan.counterparty?.name ?? null, OPENING_CUTOFF_DATE,
      plan.corrects?.id ?? null, actionId, hash, ctx.now, ctx.userId || null],
  );
  trackChange('opening_account_items', id, 'insert', {});
  logAuditOrThrow({
    module: 'Finance', entityType: 'opening_account_items', entityId: id, action: 'CREATE',
    newValue: {
      itemNumber: number, kind: plan.kind, amount: plan.amount, reference: plan.reference, reason: plan.reason,
      counterparty: plan.counterparty, cutoffDate: OPENING_CUTOFF_DATE, accounting: 'PENDING',
      corrects: plan.corrects?.itemNumber ?? null, ledgerBefore: plan.ledgerBefore, difference: plan.difference,
      confirmedNotInLataif: input.confirmNotInLataif === true ? true : null,
    },
    actor,
  });
  buchung();
  abgleich();
  return itemOf(query('SELECT * FROM opening_account_items WHERE id = ?', [id])[0]);
}

export interface OpeningAccountCancelInput { itemId: string; reason: string; expectedRevision: number }

/** Storno eines noch nicht gebuchten Belegs: Status, Grund, Protokoll, Sync — nur gegen den gesehenen Stand. Gelöscht wird nie. */
export function cancelOpeningAccountItemInHouse(input: OpeningAccountCancelInput, ctx: OpeningAccountCtx): OpeningAccountItem {
  assertOwner(ctx);
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!reason) throw nein('REASON_REQUIRED', 'please give a reason for the cancellation');
  if (reason.length > 500) throw nein('INVALID_INPUT', 'the reason is longer than 500 characters');
  const row = query('SELECT * FROM opening_account_items WHERE id = ? AND branch_id = ?', [String(input.itemId ?? ''), ctx.branchId])[0];
  if (!row) throw nein('ITEM_NOT_FOUND', 'no such opening document in this branch');
  if (String(row.status) === 'CANCELLED') throw nein('ALREADY_CANCELLED', `${String(row.item_number)} is already cancelled`);
  if (String(row.accounting) !== 'PENDING') throw nein('BOOKED_NEEDS_REVERSAL', `${String(row.item_number)} is booked — it is corrected with a reversal, not here`);
  if (typeof input.expectedRevision !== 'number' || input.expectedRevision !== Number(row.revision)) {
    throw nein('ITEM_CHANGED', `${String(row.item_number)} changed meanwhile — reload`);
  }
  const buchung = watchLedgerPosts('opening document cancel');
  const abgleich = watchSyncTracks('opening document cancel');
  getDatabase().run(
    `UPDATE opening_account_items SET status = 'CANCELLED', cancelled_at = ?, cancelled_by = ?, cancel_reason = ?, revision = revision + 1
      WHERE id = ? AND status = 'RECORDED' AND accounting = 'PENDING' AND revision = ?`,
    [ctx.now, ctx.userId || null, reason, String(row.id), Number(row.revision)],
  );
  if (Number(query('SELECT changes() AS n')[0]?.n) !== 1) throw nein('ITEM_CHANGED', 'the opening document changed meanwhile');
  trackChange('opening_account_items', String(row.id), 'update', {});
  logAuditOrThrow({
    module: 'Finance', entityType: 'opening_account_items', entityId: String(row.id), action: 'STATUS_CHANGE', field: 'status',
    oldValue: 'RECORDED', newValue: { status: 'CANCELLED', itemNumber: row.item_number, amount: Number(row.amount), reason },
    actor: { userId: ctx.userId, branchId: ctx.branchId },
  });
  buchung();
  abgleich();
  return itemOf(query('SELECT * FROM opening_account_items WHERE id = ?', [String(row.id)])[0]);
}

// ── Die vorhandene Settings-Eröffnung (Cash/Bank/Benefit, gebucht auf den 01.01.2000) ───────────────

export interface LegacyCashOpening {
  settings: { cash: number; bank: number; benefit: number };
  /** Netto im Hauptbuch aus der Quelle OPENING_BALANCE (alle auf den 01.01.2000). */
  ledger: { cash: number; bank: number; benefit: number };
  bookedOn: '2000-01-01';
  /** Settings und Hauptbuch stimmen überein (nichts zu tun). */
  inSync: boolean;
  /** Settings-Werte, die NICHT im Hauptbuch stehen (z. B. nie über Backfill gebucht) — sie zählen nirgends. */
  notBooked: string[];
  /** Ungültige oder negative Settings-Werte. */
  invalid: string[];
}

export function legacyCashOpeningFor(branchId: string): LegacyCashOpening {
  const keys = { cash: 'finance.opening_cash', bank: 'finance.opening_bank', benefit: 'finance.opening_benefit' } as const;
  const accounts = { cash: 'CASH', bank: 'BANK', benefit: 'BENEFIT' } as const;
  const settings = { cash: 0, bank: 0, benefit: 0 };
  const ledger = { cash: 0, bank: 0, benefit: 0 };
  const notBooked: string[] = [];
  const invalid: string[] = [];
  for (const k of ['cash', 'bank', 'benefit'] as const) {
    const raw = query('SELECT value FROM settings WHERE branch_id = ? AND key = ?', [branchId, keys[k]])[0]?.value;
    const v = raw === undefined || raw === null || String(raw).trim() === '' ? 0 : Number(raw);
    if (!Number.isFinite(v) || v < 0) invalid.push(k);
    settings[k] = Number.isFinite(v) ? bhd(toFils(v)) : 0;
    const f = Number(query(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN CAST(ROUND(amount * 1000) AS INTEGER) ELSE -CAST(ROUND(amount * 1000) AS INTEGER) END), 0) AS n
         FROM ledger_entries WHERE branch_id = ? AND source_module = 'OPENING_BALANCE' AND account = ?`,
      [branchId, accounts[k]],
    )[0]?.n) || 0;
    ledger[k] = bhd(f);
    if (Number.isFinite(v) && toFils(v) !== f) notBooked.push(k);
  }
  return { settings, ledger, bookedOn: '2000-01-01', inSync: notBooked.length === 0 && invalid.length === 0, notBooked, invalid };
}

// ── Die Eröffnungsübersicht ─────────────────────────────────────────────────

/** NOT_VERIFIED: kein nachgewiesener Stichtagswert (Altbestand: nur der heutige Wert; Card Clearing: kein Abrechnungsstand). */
export type OverviewStatus = 'EMPTY' | 'BOOKED' | 'PROVISIONAL' | 'MISSING' | 'RECONCILED' | 'NOT_VERIFIED';

export interface OverviewRow {
  key: string;
  label: string;
  side: 'ASSET' | 'LIABILITY';
  accounts: string[];
  /** Gebucht vor dem Stichtag (Seite der Klasse). */
  booked: number;
  /** Ungebuchte Entwürfe dieser Saldoart (Summe); bei gezählten Ständen null. */
  draft: number | null;
  /** Gezählter Soll-Stand (nur Cash/Bank/Benefit). */
  target: number | null;
  /** Was eine spätere Eröffnung hier verändern würde (Differenz bzw. Entwurfssumme) — nicht gebucht. */
  adjustment: number | null;
  /** Spanne statt Einzelwert (Altbestand: V2 … V1, D5 offen). */
  range: { low: number; high: number } | null;
  /** CURRENT = der heutige Wert, NICHT der Wert zum Stichtag (nur Information, in keiner Stichtagssumme). */
  valuation: 'CUTOFF' | 'CURRENT_NOT_VERIFIED';
  status: OverviewStatus;
  source: string;
  notes: string[];
}

export interface OpeningAccountingRead {
  cutoffDate: string;
  asOfDate: string;
  status: 'PROVISIONAL';
  booking: typeof OPENING_ACCOUNTING_BOOKING;
  rows: OverviewRow[];
  equity: {
    openingBooked: number;
    partnerBooked: number;
    resultBooked: number;
    assetsBooked: number;
    liabilitiesBooked: number;
    /** Wirkung aller Entwürfe außer Altbestand (Aktiva − Passiva). */
    draftNet: number;
    /**
     * Rechnerisches Eröffnungskapital, wenn die Entwürfe so gebucht würden — nichts erfunden, nichts gebucht. Der
     * Altbestand ist NICHT enthalten: es gibt nur seinen heutigen Wert, nicht den nachgewiesenen Wert zum Stichtag (B5).
     */
    provisionalOpening: { withoutOldStock: number; oldStock: { included: false; basis: 'CURRENT'; verifiedAtCutoff: false; low: number; high: number } };
  };
  issues: string[];
  legacyCash: LegacyCashOpening;
  items: OpeningAccountItem[];
  partyItems: { totals: OpeningKindTotal[]; pending: number; cancelled: number };
  oldStock: {
    /** Der Wert ist der HEUTIGE; der Wert zum Stichtag ist offen (B5). */
    valuation: 'CURRENT'; asOfCutoff: 'PENDING_NOT_VERIFIED';
    candidates: number; review: number; capitalised: number; soldCogs: number; pendingRemovalValue: number; shelfValue: number;
    v1: number; v2: number; unknownInventoryDebits: number; notes: string[];
  };
  trialBalance: TrialBalance;
  balanceSheet: BalanceSheet;
  transactions: CutoffTransactions | null;
  /** Für die Auswahl der Gegenpartei (am PC2 kommt sie mit derselben Auskunft). */
  counterparties: { customers: Array<{ id: string; name: string }>; suppliers: Array<{ id: string; name: string }> };
  preview: { plan: OpeningAccountPlan | null; issue: string | null; code: string | null } | null;
}

export function openingAccountItemsFor(ctx: { branchId: string }): OpeningAccountItem[] {
  return query(
    `SELECT * FROM opening_account_items WHERE branch_id = ?
      ORDER BY CASE status WHEN 'RECORDED' THEN 0 ELSE 1 END, created_at, item_number`,
    [ctx.branchId],
  ).map(itemOf);
}

export interface OpeningAccountingInput { asOfDate?: unknown; view?: unknown; txLimit?: unknown; preview?: unknown }

/** Alles, was „Settings → Opening Balances" zeichnet — am Primary und (Fernauskunft) am PC2 gleich. Schreibt nichts. */
export function openingAccountingFor(ctx: { branchId: string }, input: OpeningAccountingInput = {}): OpeningAccountingRead {
  const asOfDate = input.asOfDate === undefined || input.asOfDate === null || input.asOfDate === '' ? OPENING_CUTOFF_DATE : String(input.asOfDate);
  const cutoffIso = cutoffBoundaryIso(OPENING_CUTOFF_DATE);
  const booked = (accounts: readonly string[]): number => sideBalanceBeforeFils(ctx, cutoffIso, accounts);
  const items = openingAccountItemsFor(ctx);
  const live = items.filter((i) => i.status === 'RECORDED');
  const draftOf = (kind: OpeningAccountKind): number => live.filter((i) => i.kind === kind).reduce((s, i) => s + toFils(i.amount), 0);
  const partyRows = query('SELECT * FROM opening_balance_items WHERE branch_id = ?', [ctx.branchId]).map((r) => ({
    kind: String(r.kind) as OpeningKind, status: String(r.status) === 'CANCELLED' ? 'CANCELLED' as const : 'RECORDED' as const, amount: Number(r.amount) || 0,
  }));
  const partyTotals = kindTotals(partyRows as unknown as OpeningItem[], OPENING_KINDS);
  const partyF = (kind: OpeningKind): number => toFils(partyTotals.find((t) => t.kind === kind)?.amount ?? 0);
  const legacyCash = legacyCashOpeningFor(ctx.branchId);
  const os = oldStockReconciliationFor(ctx);

  const rows: OverviewRow[] = [];
  const issues: string[] = [OPENING_ACCOUNTING_BOOKING.reason];
  for (const kind of COUNT_KINDS) {
    const info = OPENING_ACCOUNT_KIND_INFO[kind];
    const acc = info.ledgerAccount as string;
    const b = booked([acc]);
    const count = live.find((i) => i.kind === kind);
    const notes: string[] = [];
    const legacyKey = acc === 'CASH' ? 'cash' : acc === 'BANK' ? 'bank' : 'benefit';
    if (legacyCash.ledger[legacyKey] !== 0) notes.push(`Includes the existing settings opening of ${legacyCash.ledger[legacyKey].toFixed(3)} BHD booked on 01.01.2000 — it is part of the ledger balance, not a second opening.`);
    if (legacyCash.notBooked.includes(legacyKey)) notes.push(`The settings value ${legacyCash.settings[legacyKey].toFixed(3)} BHD is not in the ledger and is not counted anywhere — record the counted balance instead.`);
    let status: OverviewStatus;
    let adjustment: number | null = null;
    if (!count) {
      status = 'MISSING';
      issues.push(`${info.label}: no counted balance as of ${OPENING_CUTOFF_DATE} recorded yet.`);
    } else {
      const d = toFils(count.amount) - b;
      adjustment = bhd(d);
      status = d === 0 ? 'RECONCILED' : 'PROVISIONAL';
      if (d !== 0) issues.push(`${info.label}: counted ${count.amount.toFixed(3)} BHD, ledger ${bhd(b).toFixed(3)} BHD — difference ${bhd(d).toFixed(3)} BHD not booked (explain: missing ERP transaction or opening difference).`);
    }
    rows.push({ key: kind, label: info.label, side: 'ASSET', accounts: [acc], booked: bhd(b), draft: null, target: count ? count.amount : null, adjustment, range: null, valuation: 'CUTOFF', status, source: 'Ledger before the cutoff; count in Settings → Opening Balances', notes });
  }
  const plain = (key: string, label: string, side: 'ASSET' | 'LIABILITY', accounts: string[], draftF: number, source: string, notes: string[] = []): void => {
    const b = booked(accounts);
    const status: OverviewStatus = draftF !== 0 ? 'PROVISIONAL' : b !== 0 ? 'BOOKED' : 'EMPTY';
    rows.push({ key, label, side, accounts, booked: bhd(b), draft: bhd(draftF), target: null, adjustment: bhd(draftF), range: null, valuation: 'CUTOFF', status, source, notes });
  };
  // Card Clearing: es gibt keinen erfassten Abrechnungsstand zum Stichtag — offener Abstimmungspunkt, nie „abgestimmt".
  {
    const b = booked(['CARD_CLEARING']);
    rows.push({
      key: 'CARD_CLEARING', label: 'Card clearing (money at the card processor)', side: 'ASSET', accounts: ['CARD_CLEARING'], booked: bhd(b), draft: null, target: null,
      adjustment: null, range: null, valuation: 'CUTOFF', status: 'NOT_VERIFIED', source: 'Ledger only',
      notes: ['No statement balance of the card processor as of the cutoff is recorded — open reconciliation point.'],
    });
    issues.push(`Card clearing: ${bhd(b).toFixed(3)} BHD booked before the cutoff; no settlement statement as of ${OPENING_CUTOFF_DATE} recorded — open reconciliation point.`);
  }
  plain('CUSTOMER_RECEIVABLES', 'Customer receivables', 'ASSET', ['ACCOUNTS_RECEIVABLE'], partyF('CUSTOMER_RECEIVABLE'), 'LATAIF invoices (ledger) + opening positions (Customer Edit)');
  plain('SUPPLIER_ADVANCES', 'Supplier advances / credits', 'ASSET', ['SUPPLIER_CREDIT'], partyF('SUPPLIER_ADVANCE'), 'Ledger + opening positions (Supplier Edit)');
  plain('LOANS_RECEIVABLE', 'Loans given', 'ASSET', ['LOAN_RECEIVABLE'], draftOf('LOAN_RECEIVABLE'), 'LATAIF loans (ledger) + opening documents');
  plain('VAT_RECEIVABLE', 'Input VAT / VAT refund due', 'ASSET', ['VAT_INPUT'], draftOf('VAT_RECEIVABLE'), 'Ledger + opening documents',
    ['The NBR return is computed from invoices and purchase lines, not from this ledger balance (E3).']);
  plain('OTHER_ASSETS', 'Other assets', 'ASSET', ['GOLD_CREDIT_CLEARING', 'INTERNAL_TRANSFER'], draftOf('OTHER_ASSET'), 'Ledger + opening documents');
  // Altbestand: Regalwert + schon gebuchter Wareneinsatz (gleicht das negative INVENTORY aus) ± offene Abgänge — V2 … V1.
  // B1 FINAL GATE: das ist der HEUTIGE Stand, nicht der Stand zum 15.10.2026 — nur Information (CURRENT, NOT VERIFIED), in
  // keiner Stichtagssumme und nicht im rechnerischen Eröffnungskapital. Die Bewertung zum Stichtag löst B5.
  {
    const b = booked(['INVENTORY']);
    const notes = [
      `CURRENT value (today), not the value as of ${OPENING_CUTOFF_DATE}: the value at the cutoff is PENDING / NOT VERIFIED (B5) and is not included in the opening equity.`,
      `Preview of the old stock as it is now (page “Old stock”): ${os.totals.candidates} candidate(s), ${os.totals.review} to review, ${os.totals.capitalised} already capitalised by purchases.`,
      `V2 = shelf value + cost of sales already booked = ${os.totals.v2.toFixed(3)} BHD; V1 = V2 + pending removals = ${os.totals.v1.toFixed(3)} BHD (D4/D5 open).`,
      ...os.notes,
    ];
    const status: OverviewStatus = os.totals.candidates > 0 || os.totals.review > 0 ? 'NOT_VERIFIED' : b !== 0 ? 'BOOKED' : 'EMPTY';
    if (os.totals.review > 0) issues.push(`Old stock: ${os.totals.review} item(s) need a review before an opening value can be proposed.`);
    if (os.ledger.unknownInventoryDebits > 0) issues.push(`Old stock: ${os.ledger.unknownInventoryDebits} inventory booking(s) of unknown origin in the ledger.`);
    if (os.totals.candidates > 0) issues.push(`Old stock: only the CURRENT value ${os.totals.v2.toFixed(3)}–${os.totals.v1.toFixed(3)} BHD is known — the value as of ${OPENING_CUTOFF_DATE} is NOT VERIFIED and not included in the opening equity (B5; D1–D6, D8).`);
    rows.push({
      key: 'OLD_STOCK', label: 'Inventory / old stock', side: 'ASSET', accounts: ['INVENTORY'], booked: bhd(b), draft: null, target: null, adjustment: null,
      range: os.totals.candidates > 0 ? { low: os.totals.v2, high: os.totals.v1 } : null, valuation: 'CURRENT_NOT_VERIFIED', status, source: 'Ledger + CURRENT old-stock preview (Collection)', notes,
    });
  }
  plain('SUPPLIER_PAYABLES', 'Supplier payables', 'LIABILITY', ['ACCOUNTS_PAYABLE'], partyF('SUPPLIER_PAYABLE'), 'LATAIF purchases/expenses (ledger) + opening positions (Supplier Edit)');
  plain('CUSTOMER_ADVANCES', 'Customer advances / credits', 'LIABILITY', ['CUSTOMER_CREDIT', 'CUSTOMER_DEPOSITS'], partyF('CUSTOMER_ADVANCE'), 'Ledger + opening positions (Customer Edit)');
  plain('LOANS_PAYABLE', 'Loans taken', 'LIABILITY', ['LOAN_PAYABLE'], draftOf('LOAN_PAYABLE'), 'LATAIF loans (ledger) + opening documents');
  plain('VAT_PAYABLE', 'VAT (output, margin VAT, paid to NBR)', 'LIABILITY', ['VAT_OUTPUT', 'MARGIN_VAT', 'TAX_PAID'], draftOf('VAT_PAYABLE'), 'Ledger + opening documents',
    ['VAT period lock and NBR export stay unchanged; an opening VAT balance is only recorded (E3).']);
  plain('OTHER_LIABILITIES', 'Other liabilities', 'LIABILITY', ['COMMISSION_PAYABLE_AGENT', 'COMMISSION_PAYABLE_CONSIGNOR', 'PARTNER_ITEM_BALANCE'], draftOf('OTHER_LIABILITY'), 'Ledger + opening documents');

  const pendingParty = partyRows.filter((r) => r.status === 'RECORDED').length;
  if (pendingParty > 0) issues.push(`${pendingParty} customer/supplier opening position(s) recorded, not booked and not payable.`);
  if (live.length > 0) issues.push(`${live.length} opening document(s) recorded, not booked.`);
  if (legacyCash.invalid.length > 0) issues.push(`The settings opening has an invalid or negative value (${legacyCash.invalid.join(', ')}) — it is not booked and stays frozen.`);
  if (legacyCash.notBooked.length > 0) issues.push(`The settings opening (${legacyCash.notBooked.join(', ')}) differs from the ledger — not counted; use the counted balance.`);

  const sheet = balanceSheetAt(ctx, OPENING_CUTOFF_DATE);
  const assetsF = rows.filter((r) => r.side === 'ASSET').reduce((s, r) => s + toFils(r.booked), 0);
  const liabilitiesF = rows.filter((r) => r.side === 'LIABILITY').reduce((s, r) => s + toFils(r.booked), 0);
  const draftNetF = rows.filter((r) => r.key !== 'OLD_STOCK').reduce((s, r) => s + (r.side === 'ASSET' ? 1 : -1) * toFils(r.adjustment ?? 0), 0);
  const openingF = toFils(sheet.equity.opening);
  if (sheet.imbalance !== 0) issues.push(`The ledger is not balanced before the cutoff (${sheet.imbalance.toFixed(3)} BHD).`);
  if (sheet.unclassified.length > 0) issues.push(`Ledger accounts without a class: ${sheet.unclassified.map((u) => u.account).join(', ')}.`);
  if (sheet.difference !== 0) issues.push(`Assets − liabilities − equity before the cutoff leave ${sheet.difference.toFixed(3)} BHD unexplained.`);
  if (asOfDate !== OPENING_CUTOFF_DATE) issues.push(`The trial balance below is shown as of ${asOfDate}, not the opening cutoff ${OPENING_CUTOFF_DATE}.`);

  let preview: OpeningAccountingRead['preview'] = null;
  if (input.preview && typeof input.preview === 'object' && !Array.isArray(input.preview)) {
    try {
      preview = { plan: planOpeningAccountItem(input.preview as Partial<OpeningAccountInput>, ctx.branchId), issue: null, code: null };
    } catch (e) {
      preview = { plan: null, issue: e instanceof Error ? e.message : String(e), code: (e as { code?: string }).code ?? null };
    }
  }
  const lim = Number(input.txLimit);
  return {
    cutoffDate: OPENING_CUTOFF_DATE, asOfDate, status: 'PROVISIONAL', booking: OPENING_ACCOUNTING_BOOKING,
    rows,
    equity: {
      openingBooked: sheet.equity.opening, partnerBooked: sheet.equity.partner, resultBooked: sheet.equity.result,
      assetsBooked: bhd(assetsF), liabilitiesBooked: bhd(liabilitiesF), draftNet: bhd(draftNetF),
      provisionalOpening: {
        withoutOldStock: bhd(openingF + draftNetF),
        oldStock: { included: false, basis: 'CURRENT', verifiedAtCutoff: false, low: os.totals.v2, high: os.totals.v1 },
      },
    },
    issues, legacyCash, items,
    partyItems: { totals: partyTotals, pending: pendingParty, cancelled: partyRows.length - pendingParty },
    oldStock: {
      valuation: 'CURRENT', asOfCutoff: 'PENDING_NOT_VERIFIED',
      candidates: os.totals.candidates, review: os.totals.review, capitalised: os.totals.capitalised, soldCogs: os.totals.soldCogs,
      pendingRemovalValue: os.totals.pendingRemovalValue, shelfValue: os.totals.shelfValue, v1: os.totals.v1, v2: os.totals.v2,
      unknownInventoryDebits: os.ledger.unknownInventoryDebits, notes: os.notes,
    },
    trialBalance: trialBalanceAt(ctx, asOfDate),
    balanceSheet: asOfDate === OPENING_CUTOFF_DATE ? sheet : balanceSheetAt(ctx, asOfDate),
    transactions: input.view === 'transactions' ? cutoffTransactionsFor(ctx, asOfDate, Number.isFinite(lim) && lim > 0 ? lim : 1000) : null,
    counterparties: {
      customers: query("SELECT id, first_name, last_name, company FROM customers WHERE branch_id = ? AND id NOT LIKE 'sys-%' ORDER BY first_name, last_name LIMIT 5000", [ctx.branchId])
        .map((r) => ({ id: String(r.id), name: `${String(r.first_name ?? '')} ${String(r.last_name ?? '')}`.trim() || String(r.company ?? '') || String(r.id) })),
      suppliers: query('SELECT id, name FROM suppliers WHERE branch_id = ? ORDER BY name LIMIT 5000', [ctx.branchId])
        .map((r) => ({ id: String(r.id), name: String(r.name ?? r.id) })),
    },
    preview,
  };
}

// ── Anschlüsse am Primary: exklusiv, EINE Transaktion, erst danach durabel ──────
function localCtx(): OpeningAccountCtx {
  const session = useAuthStore.getState().session as { role?: string } | null | undefined;
  return { branchId: currentBranchId(), userId: currentUserId(), now: new Date().toISOString(), role: session?.role };
}
const nurPrimary = (): Promise<never> => Promise.reject(new OpeningAccountRejected('PRIMARY_ONLY', 'this computer records opening balances through the main computer'));

export function recordOpeningAccountItemOnPrimary(input: OpeningAccountInput, reload: () => void): Promise<OpeningAccountItem> {
  if (isClientMode()) return nurPrimary();
  return runOnPrimary(() => recordOpeningAccountItemInHouse(input, localCtx()), reload);
}
export function cancelOpeningAccountItemOnPrimary(input: OpeningAccountCancelInput, reload: () => void): Promise<OpeningAccountItem> {
  if (isClientMode()) return nurPrimary();
  return runOnPrimary(() => cancelOpeningAccountItemInHouse(input, localCtx()), reload);
}
