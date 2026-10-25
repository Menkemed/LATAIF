// ════════════════════════════════════════════════════════════════════════════
// v0.8.90 — „Data Repairs": automatische Kartengebühren, die nach einem „Edit Expense" (Datum/Betrag) als offene
// Verbindlichkeit neu gebucht wurden statt gegen das Karten-Clearing.
//
// Bis v0.8.89 nahm „Edit Expense" die Buchung einer Kartengebühr zurück und buchte sie mit der allgemeinen
// Ausgabenbuchung neu: DR EXPENSES_OPERATING / CR ACCOUNTS_PAYABLE. Eine Kartengebühr zieht der Processor aber sofort
// ab — richtig ist DR EXPENSES_OPERATING / CR CARD_CLEARING (bookCardFee). Folge: eine Verbindlichkeit ohne
// Lieferanten und ein zu hohes Karten-Clearing (Banking nettet richtig, das Hauptbuch nicht).
//
// Nur mit Beweis, nie pauschal: die LEBENDE Buchung der Gebühr ist genau dieses Paar über ihren Betrag, es gibt keine
// Ausgabenzahlung dazu (sonst wäre die „Verbindlichkeit" bezahlt worden — das entscheidet der Buchhalter), die
// zugehörige Kartenzahlung existiert, und der Buchungstag liegt in keinem eingereichten/bezahlten VAT-Quartal.
//
// Ausgelöst nur ausdrücklich vom Owner (Admin), am Primary, in EINER Transaktion: die falsche Buchung wird storniert
// (am selben Tag), die richtige gebucht (am selben Tag), alles protokolliert. Keine Zeile wird gelöscht oder
// überschrieben; Betrag, Datum, Status und Verknüpfung der Ausgabe bleiben, wie sie sind.
// ════════════════════════════════════════════════════════════════════════════
import { query, currentBranchId, currentUserId } from '@/core/db/helpers';
import { reverseSource } from '@/core/ledger/posting';
import { logAuditOrThrow } from '@/core/audit/audit-log';
import { canonicalRole } from '@/core/models/types';
import { runOnPrimary } from '@/core/data/primary-action';
import { isClientMode } from '@/core/bridge/client-mode';
import { useAuthStore } from '@/stores/authStore';
import { closedVatQuarters, nbrQuarterOfDate } from '@/core/tax/vat-period-lock';
import { isAutoCardFee, postCardFeeEntries } from './card-fee-booking';

export class CardFeeRepairRejected extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'CardFeeRepairRejected';
  }
}

const r3 = (v: unknown): number => Math.round((Number(v) || 0) * 1000) / 1000;

export interface CardFeeRepairEvidence {
  expenseId: string;
  expenseNumber: string;
  amount: number;
  expenseDate: string;
  /** Der Tag der falschen (lebenden) Buchung — an ihm wird storniert und richtig gebucht. */
  occurredAt: string;
  relatedModule: string;
  relatedEntityId: string;
  /** Die Belegnummer der Zahlung (Rechnung/Auftrag/Reparatur) — zur Anzeige. */
  documentNumber: string;
  wrongEntryIds: string[];
}

/** Die lebenden Originalzeilen einer Quelle (nicht selbst Storno, nicht storniert). */
function lebend(expenseId: string): Array<Record<string, unknown>> {
  return query(
    `SELECT e1.id, e1.account, e1.direction, e1.amount, e1.occurred_at FROM ledger_entries e1
      WHERE e1.source_module = 'EXPENSE' AND e1.source_id = ? AND e1.reverses_entry_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM ledger_entries e2 WHERE e2.reverses_entry_id = e1.id)
      ORDER BY e1.entry_no`,
    [expenseId],
  );
}

function belegnummer(module: string, entityId: string, createdAt: string): string | null {
  if (module === 'invoice') {
    const p = query('SELECT 1 FROM payments WHERE invoice_id = ? AND created_at = ? LIMIT 1', [entityId, createdAt])[0];
    if (!p) return null;
    return String(query('SELECT invoice_number FROM invoices WHERE id = ?', [entityId])[0]?.invoice_number ?? entityId.slice(0, 8));
  }
  if (module === 'order') {
    const p = query('SELECT 1 FROM order_payments WHERE order_id = ? AND created_at = ? LIMIT 1', [entityId, createdAt])[0];
    if (!p) return null;
    return String(query('SELECT order_number FROM orders WHERE id = ?', [entityId])[0]?.order_number ?? entityId.slice(0, 8));
  }
  const r = query('SELECT repair_number FROM repairs WHERE id = ?', [entityId])[0];
  return r ? String(r.repair_number ?? entityId.slice(0, 8)) : null;
}

/**
 * Rein lesend: ist die lebende Buchung dieser Gebühr die falsche (Aufwand an Verbindlichkeiten)? `affected` = so
 * gebucht; `evidence` = sicher reparierbar; sonst `issue` = warum nicht (dann entscheidet der Buchhalter).
 */
export function cardFeeRepairEvidence(expenseId: string, branchId: string): { affected: boolean; evidence: CardFeeRepairEvidence | null; issue: string | null } {
  const row = query('SELECT * FROM expenses WHERE id = ? AND branch_id = ?', [expenseId, branchId])[0];
  if (!row) return { affected: false, evidence: null, issue: 'no such expense' };
  if (!isAutoCardFee(row)) return { affected: false, evidence: null, issue: 'not an automatic card fee' };
  if (String(row.status) === 'CANCELLED') return { affected: false, evidence: null, issue: 'the card fee is cancelled' };
  const live = lebend(expenseId);
  const ap = live.filter((l) => l.account === 'ACCOUNTS_PAYABLE');
  if (ap.length === 0) return { affected: false, evidence: null, issue: 'booked correctly' };
  const nein = (issue: string) => ({ affected: true, evidence: null, issue });
  const betrag = r3(row.amount);
  const exp = live.filter((l) => l.account === 'EXPENSES_OPERATING');
  if (live.length !== 2 || ap.length !== 1 || exp.length !== 1
    || ap[0].direction !== 'CREDIT' || exp[0].direction !== 'DEBIT' || r3(ap[0].amount) !== betrag || r3(exp[0].amount) !== betrag) {
    return nein('its booking is not exactly "expense to payables" over its amount');
  }
  const tag = String(ap[0].occurred_at ?? '');
  if (String(exp[0].occurred_at ?? '') !== tag) return nein('the two lines of its booking carry different dates');
  if (query('SELECT 1 FROM expense_payments WHERE expense_id = ? LIMIT 1', [expenseId]).length > 0) {
    return nein('a payment was recorded against it as a payable — the accountant decides');
  }
  if (r3(row.paid_amount) !== betrag || String(row.status) !== 'PAID') return nein('it is not fully paid as a card fee should be');
  const q = nbrQuarterOfDate(tag);
  if (q && closedVatQuarters(branchId).has(q.key)) return nein(`its booking date lies in the filed/paid VAT quarter ${q.key} — the accountant decides`);
  const nr = belegnummer(String(row.related_module), String(row.related_entity_id ?? ''), String(row.created_at ?? ''));
  if (!nr) return nein('its card payment cannot be found');
  return {
    affected: true,
    issue: null,
    evidence: {
      expenseId, expenseNumber: String(row.expense_number ?? ''), amount: betrag, expenseDate: String(row.expense_date ?? ''),
      occurredAt: tag, relatedModule: String(row.related_module), relatedEntityId: String(row.related_entity_id ?? ''),
      documentNumber: nr, wrongEntryIds: live.map((l) => String(l.id)),
    },
  };
}

export interface CardFeeRepairPreview {
  repairable: CardFeeRepairEvidence[];
  /** Falsch gebucht, aber nicht automatisch reparierbar — mit Grund. */
  blocked: Array<{ expenseId: string; expenseNumber: string; amount: number; issue: string }>;
}

/** Rein lesend: die Vorschau für „Data Repairs". */
export function cardFeeRepairPreview(branchId: string): CardFeeRepairPreview {
  const out: CardFeeRepairPreview = { repairable: [], blocked: [] };
  for (const r of query("SELECT id, expense_number, amount FROM expenses WHERE branch_id = ? AND category = 'CardFees' AND status != 'CANCELLED' ORDER BY created_at", [branchId])) {
    const b = cardFeeRepairEvidence(String(r.id), branchId);
    if (!b.affected) continue;
    if (b.evidence) out.repairable.push(b.evidence);
    else out.blocked.push({ expenseId: String(r.id), expenseNumber: String(r.expense_number ?? ''), amount: r3(r.amount), issue: b.issue ?? '' });
  }
  return out;
}

export interface CardFeeRepairInput { expenseIds: string[]; reason: string }
export interface CardFeeRepaired { repaired: Array<{ expenseId: string; expenseNumber: string; amount: number; occurredAt: string }> }
export interface CardFeeRepairCtx { branchId: string; userId: string; now: string; role?: string }

/** In der Transaktion des Aufrufers: ALLE genannten Gebühren mit Beweis richtig gebucht — oder keine. */
export function repairCardFeeBookingsInHouse(input: CardFeeRepairInput, ctx: CardFeeRepairCtx): CardFeeRepaired {
  if (canonicalRole(ctx.role) !== 'ADMIN') throw new CardFeeRepairRejected('PERMISSION_DENIED', 'only the owner (admin) may re-book card fees');
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!reason) throw new CardFeeRepairRejected('REASON_REQUIRED', 'please enter a reason');
  const ids = Array.isArray(input.expenseIds) ? [...new Set(input.expenseIds.filter((x) => typeof x === 'string' && x))] : [];
  if (ids.length === 0) throw new CardFeeRepairRejected('NOTHING_TO_REPAIR', 'no card fee named — nothing was changed');
  const beweise = ids.map((id) => ({ id, ...cardFeeRepairEvidence(id, ctx.branchId) }));
  const ohne = beweise.filter((b) => !b.evidence);
  if (ohne.length > 0) {
    throw new CardFeeRepairRejected('CARD_FEE_REPAIR_NOT_PROVEN', `${ohne.map((b) => `${b.id}: ${b.issue}`).join('; ')} — nothing was changed`);
  }
  const repaired: CardFeeRepaired['repaired'] = [];
  for (const b of beweise) {
    const e = b.evidence!;
    // Storno der falschen Buchung und die richtige — beide am Tag der falschen, damit die Periode stimmt.
    reverseSource('EXPENSE', e.expenseId, e.occurredAt);
    postCardFeeEntries({
      expenseId: e.expenseId, expenseNumber: e.expenseNumber, amount: e.amount, occurredAt: e.occurredAt,
      branchId: ctx.branchId, userId: ctx.userId, relatedModule: e.relatedModule, relatedEntityId: e.relatedEntityId,
    });
    logAuditOrThrow({
      module: 'Expense', entityType: 'expenses', entityId: e.expenseId, action: 'UPDATE', field: 'ledger',
      oldValue: { credit: 'ACCOUNTS_PAYABLE', amount: e.amount, entries: e.wrongEntryIds },
      newValue: { credit: 'CARD_CLEARING', amount: e.amount, occurredAt: e.occurredAt, repair: 'CARD_FEE_REBOOK_V0890', reason },
      actor: { userId: ctx.userId, branchId: ctx.branchId },
    });
    repaired.push({ expenseId: e.expenseId, expenseNumber: e.expenseNumber, amount: e.amount, occurredAt: e.occurredAt });
  }
  return { repaired };
}

function localCtx(): CardFeeRepairCtx {
  const session = useAuthStore.getState().session as { role?: string } | null | undefined;
  return { branchId: currentBranchId(), userId: currentUserId(), now: new Date().toISOString(), role: session?.role };
}

/** Am Primary — exklusiv, EINE Transaktion, erst danach durabel. Auf PC2 nicht. */
export function repairCardFeeBookingsOnPrimary(input: CardFeeRepairInput, reload: () => void): Promise<CardFeeRepaired> {
  if (isClientMode()) {
    return Promise.reject(new CardFeeRepairRejected('PRIMARY_ONLY', 'this repair runs on the main computer only'));
  }
  return runOnPrimary(() => repairCardFeeBookingsInHouse(input, localCtx()), reload);
}
