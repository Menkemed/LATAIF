// ════════════════════════════════════════════════════════════════════════════
// Owner 19.11.2026 — „Correct final invoice date" (nur ADMIN, am Primary und vom PC2; geprüft und gespeichert am Primary).
//
// Das Datum der Endrechnung (`invoices.final_issued_at`) wird bei der ersten Vollzahlung einmal festgehalten und ändert
// sich danach nicht mehr — auch nicht, wenn „Manage payments" die Zahlung umdatiert. War das Datum der abschließenden
// Zahlung NACHWEISLICH falsch erfasst, korrigiert diese Aktion beides gemeinsam:
//   • die abschließende Zahlung bekommt ihren richtigen Tag (Hauptbuch: die alte Buchung wird an IHREM Tag
//     zurückgenommen, die neue steht am richtigen Tag — dieselbe Quelle, dieselben Konten, Betrag/Weg unverändert);
//   • `final_issued_at` folgt. Liste, Detail, PDF, CSV, NBR und VAT-Übersicht lesen genau dieses Datum.
// Steht die Zahlung schon auf dem richtigen Tag (früher über „Manage payments" umdatiert), zieht nur das Datum nach.
//
// Unverändert bleiben: die Endnummer (Nummern-Freeze), der Rechnungstag, Umsatz/VAT/Forderung (gebucht bei Ausstellung),
// die Kartengebühr (sie hängt am Erfassungszeitpunkt, nicht am Zahlungstag). Kein Versand an den Kunden.
//
// Abgewiesen — VOR jedem Schreiben — wird alles, was nicht eindeutig oder nicht sicher ist:
//   kein ADMIN · kein Grund · alte Fassung · keine voll bezahlte Endrechnung · Tag ungültig/künftig/vor dem Rechnungstag ·
//   die abschließende Zahlung ist nicht eindeutig oder keine Geldzahlung · eine andere Zahlung liegt nach dem neuen Tag ·
//   Überzahlung/Guthaben aus der Rechnung · ein betroffener Tag vor dem Buchungsstichtag oder in einem eingereichten bzw.
//   VAT-bezahlten Quartal · die Endnummer trägt ein anderes Jahr als der neue Tag (die Nummer wird nie geändert).
// Keine Massenkorrektur: genau eine Rechnung je Auftrag.
// ════════════════════════════════════════════════════════════════════════════
import { v4 as uuid } from 'uuid';
import { getDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId } from '@/core/db/helpers';
import { runOnPrimary } from '@/core/data/primary-action';
import { useAuthStore } from '@/stores/authStore';
import { logAuditOrThrow } from '@/core/audit/audit-log';
import { hasLedgerEntries, postInvoicePayment, reverseSource } from '@/core/ledger/posting';
import { isAdminRole } from '@/core/auth/role-permissions';
import { accountingOpeningDate } from '@/core/accounting/opening-date';
import { businessDateIssue, businessTimestamp } from '@/core/utils/business-date';
import { assertVatUnchanged, closedVatQuarters, nbrQuarterOfDate, vatFingerprint } from '@/core/tax/vat-period-lock';
import { InvoiceActionRejected } from '@/core/invoices/invoice-cancel';
import { trackChange } from '@/core/sync/sync-service';
import type { PaymentMethod } from '@/core/models/types';

export const OP_INVOICES_CORRECT_FINAL_DATE = 'invoices.correct_final_date';

export const FINAL_DATE_PERMISSION = 'FINAL_DATE_PERMISSION_DENIED';
export const FINAL_DATE_REASON_REQUIRED = 'FINAL_DATE_REASON_REQUIRED';
export const FINAL_DATE_NOT_FINAL = 'FINAL_DATE_NOT_FINAL';
export const FINAL_DATE_INVALID = 'FINAL_DATE_INVALID';
export const FINAL_DATE_UNCHANGED = 'FINAL_DATE_UNCHANGED';
export const FINAL_DATE_BEFORE_INVOICE = 'FINAL_DATE_BEFORE_INVOICE';
export const FINAL_DATE_PAYMENT_UNCLEAR = 'FINAL_DATE_PAYMENT_UNCLEAR';
export const FINAL_DATE_PAYMENT_KIND = 'FINAL_DATE_PAYMENT_KIND';
export const FINAL_DATE_LATER_PAYMENT = 'FINAL_DATE_LATER_PAYMENT';
export const FINAL_DATE_OVERPAID = 'FINAL_DATE_OVERPAID';
export const FINAL_DATE_BEFORE_OPENING = 'FINAL_DATE_BEFORE_OPENING';
export const FINAL_DATE_NUMBER_YEAR = 'FINAL_DATE_NUMBER_YEAR';
export const FINAL_DATE_NO_LEDGER = 'FINAL_DATE_NO_LEDGER';
export const FINAL_DATE_CHANGED = 'INVOICE_CHANGED';
export const FINAL_DATE_VAT_PERIOD_FILED = 'VAT_PERIOD_FILED';

/** Nur echte Geldzahlungen tragen einen Zahlungstag, den man berichtigen kann — keine Anrechnung, keine Verrechnung. */
const GELD = new Set<string>(['cash', 'bank_transfer', 'card', 'benefit', 'other'] satisfies PaymentMethod[]);

export interface FinalDateCtx { branchId: string; userId: string; now: string; role?: string }

export interface FinalDateInput { invoiceId: string; newDate: string; reason: string; expectedRevision?: number }

export interface FinalDateCorrected {
  invoiceId: string;
  invoiceNumber: string;
  oldDate: string;
  newDate: string;
  /** Die umdatierte Zahlung — `null`, wenn sie schon auf dem neuen Tag stand (nur das Datum zog nach). */
  paymentId: string | null;
  revision: number;
}

const nein = (code: string, message: string): InvoiceActionRejected => new InvoiceActionRejected(code, message);
const tagVon = (iso: unknown): string => String(iso ?? '').slice(0, 10);

function quarterLabel(key: string): string {
  const [y, q] = key.split('-Q');
  return `Q${q}/${y}`;
}

/** ADMIN — aus der Sitzung UND aus `user_branches` (dieselbe Regel wie der Buchungsstichtag). */
function istAdmin(ctx: FinalDateCtx): boolean {
  if (!isAdminRole(ctx.role)) return false;
  const r = query('SELECT role FROM user_branches WHERE user_id = ? AND branch_id = ?', [ctx.userId, ctx.branchId])[0]?.role;
  return isAdminRole(typeof r === 'string' ? r : null);
}

/** Was die Korrektur täte — oder warum nicht. Liest nur; dieselbe Prüfung wie vor dem Schreiben. */
interface Plan {
  inv: Record<string, unknown>;
  oldDate: string;
  newDate: string;
  reason: string;
  pay: Record<string, unknown> | null;
}

function plan(input: FinalDateInput, ctx: FinalDateCtx): Plan {
  if (!istAdmin(ctx)) throw nein(FINAL_DATE_PERMISSION, 'only an administrator (ADMIN) may correct the final invoice date');
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason.length < 3) throw nein(FINAL_DATE_REASON_REQUIRED, 'Please enter the reason for the correction (what was recorded wrongly).');
  const inv = query(
    `SELECT id, branch_id, invoice_number, status, issued_at, created_at, final_issued_at, number_finalized_at,
            gross_amount, paid_amount, revision FROM invoices WHERE id = ?`, [input.invoiceId])[0];
  if (!inv || String(inv.branch_id ?? '') !== ctx.branchId) throw nein('INVOICE_NOT_FOUND', 'no such invoice in this branch');
  if (input.expectedRevision !== undefined && Number(inv.revision ?? 0) !== input.expectedRevision) {
    throw nein(FINAL_DATE_CHANGED,
      `this invoice changed since you opened it (you saw ${input.expectedRevision}, it is now ${Number(inv.revision ?? 0)}) — reload it and try again`);
  }
  if (String(inv.status) !== 'FINAL' || !inv.number_finalized_at) {
    throw nein(FINAL_DATE_NOT_FINAL, 'only a fully paid final invoice has a final invoice date to correct');
  }
  const newDate = typeof input.newDate === 'string' ? input.newDate.trim() : '';
  const issue = /^\d{4}-\d{2}-\d{2}$/.test(newDate)
    ? businessDateIssue(newDate, 'The final invoice date', Date.parse(ctx.now)) : 'The final invoice date is not a valid date';
  if (issue) throw nein(FINAL_DATE_INVALID, issue);
  const invoiceDay = tagVon(inv.issued_at ?? inv.created_at);
  if (invoiceDay && newDate < invoiceDay) {
    throw nein(FINAL_DATE_BEFORE_INVOICE, `The final invoice date cannot be before the invoice date (${invoiceDay}).`);
  }

  const pays = query('SELECT id, amount, method, card_brand, notes, received_at, created_at FROM payments WHERE invoice_id = ? ORDER BY received_at, id',
    [input.invoiceId]);
  if (pays.length === 0) throw nein(FINAL_DATE_PAYMENT_UNCLEAR, 'this invoice has no payment — its final date cannot be corrected here');
  const latest = pays.map((p) => tagVon(p.received_at)).sort().pop()!;
  const oldDate = tagVon(inv.final_issued_at) || latest;
  if (newDate === oldDate) throw nein(FINAL_DATE_UNCHANGED, `The final invoice date is already ${oldDate}.`);

  // Die abschließende Zahlung: genau EINE Zahlung auf dem festgehaltenen Tag. Steht keine dort, ist die Zahlung schon
  // umdatiert — dann zieht nur das Datum nach, und zwar genau auf den Tag der spätesten Zahlung.
  const amTag = pays.filter((p) => tagVon(p.received_at) === oldDate);
  let pay: Record<string, unknown> | null = null;
  if (amTag.length > 1) {
    throw nein(FINAL_DATE_PAYMENT_UNCLEAR,
      `${amTag.length} payments are dated ${oldDate} — it is not clear which one completed the invoice; correct the payment dates with “Manage payments” first. Nothing was changed.`);
  }
  if (amTag.length === 1) {
    pay = amTag[0];
    const method = String(pay.method ?? '');
    if (!GELD.has(method)) {
      throw nein(FINAL_DATE_PAYMENT_KIND,
        `the completing payment is a ${method.replace(/_/g, ' ')} — it carries the day it was applied and is not re-dated. Nothing was changed.`);
    }
    const spaeter = pays.filter((p) => p.id !== pay!.id && tagVon(p.received_at) > newDate);
    if (spaeter.length > 0) {
      throw nein(FINAL_DATE_LATER_PAYMENT,
        `another payment of this invoice is dated ${tagVon(spaeter[spaeter.length - 1].received_at)}, after ${newDate} — the invoice would not be fully paid on ${newDate}. Check the payments first. Nothing was changed.`);
    }
    if (!hasLedgerEntries('PAYMENT', String(pay.id))) {
      throw nein(FINAL_DATE_NO_LEDGER, 'the completing payment has no live accounting entry — it has to be reconciled first. Nothing was changed.');
    }
    // Wie „Manage payments": eine Zahlung mit Überzahlungs-Aufteilung wird nicht neu gebucht (das Guthaben bliebe ungedeckt).
    const overpaid = (Number(inv.paid_amount) || 0) > (Number(inv.gross_amount) || 0) + 0.005;
    const credit = query(
      `SELECT 1 FROM customer_credits WHERE (source_type = 'invoice_edit' AND source_id = ?)
          OR (source_type = 'overpayment' AND source_id IN (SELECT id FROM payments WHERE invoice_id = ?)) LIMIT 1`,
      [input.invoiceId, input.invoiceId]);
    if (overpaid || credit.length > 0) {
      throw nein(FINAL_DATE_OVERPAID, 'this invoice was overpaid (store credit or tip) — its completing payment is not re-dated automatically; check it manually. Nothing was changed.');
    }
  } else if (newDate !== latest) {
    throw nein(FINAL_DATE_PAYMENT_UNCLEAR,
      `no payment is dated ${oldDate} (the payments were changed after the invoice was completed) — the final invoice date can only follow the completing payment, dated ${latest}. Nothing was changed.`);
  }

  // Die Endnummer wird nie geändert. Trägt sie ein Jahr, muss der neue Tag in diesem Jahr liegen (NBR zeigt die Nummer).
  const nummer = String(inv.invoice_number ?? '');
  const jahr = /-(\d{4})-\d+$/.exec(nummer)?.[1];
  if (jahr && newDate.slice(0, 4) !== jahr) {
    throw nein(FINAL_DATE_NUMBER_YEAR,
      `the final number ${nummer} carries the year ${jahr} — a final invoice date in ${newDate.slice(0, 4)} would not match it, and the number is never changed. Nothing was changed.`);
  }

  // Buchungsstichtag und geschlossene Quartale: der alte Tag (die Rücknahme steht dort), der neue Tag (Zahlung und Endrechnung).
  const stichtag = accountingOpeningDate();
  const zu = closedVatQuarters(ctx.branchId);
  const tage: Array<[string, string]> = [[oldDate, 'the recorded final date'], [newDate, 'the new final date']];
  if (pay && tagVon(pay.received_at) !== oldDate) tage.push([tagVon(pay.received_at), 'the recorded payment date']);
  for (const [tag, was] of tage) {
    if (tag < stichtag) {
      throw nein(FINAL_DATE_BEFORE_OPENING,
        `${was} (${tag}) is before the accounting opening date (${stichtag}) — bookings before it are not changed. Nothing was changed.`);
    }
    const q = nbrQuarterOfDate(tag)?.key ?? '';
    const c = q ? zu.get(q) : undefined;
    if (c) {
      throw nein(FINAL_DATE_VAT_PERIOD_FILED,
        `The VAT return for ${quarterLabel(q)} is already ${c.filedAt ? 'filed' : 'paid'} — ${was} (${tag}) lies in it, so the final invoice date cannot be moved. Nothing was changed.`);
    }
  }
  return { inv, oldDate, newDate, reason, pay };
}

/** Nur prüfen (für die Maske): `null` = möglich, sonst das Nein mit Kennung und Satz. */
export function checkFinalDateCorrection(input: FinalDateInput, ctx: FinalDateCtx): { code: string; message: string } | null {
  try { plan(input, ctx); return null; } catch (e) {
    if (e instanceof InvoiceActionRejected) return { code: e.code, message: e.message };
    throw e;
  }
}

/**
 * Die Korrektur — in der Transaktion des Aufrufers (Primary: `runOnPrimary`, PC2: der Fernauftrag). Wirft vor jedem
 * Schreiben; wirft die VAT-Gegenprüfung danach, rollt der Aufrufer alles zurück.
 */
export function correctFinalInvoiceDateInHouse(input: FinalDateInput, ctx: FinalDateCtx): FinalDateCorrected {
  const p = plan(input, ctx);
  const db = getDatabase();
  const invoiceId = String(p.inv.id);
  const vorher = vatFingerprint(invoiceId);
  const altFinal = (p.inv.final_issued_at as string | null) ?? null;
  const neuFinal = businessTimestamp(p.newDate, ctx.now);

  let paymentId: string | null = null;
  let altZahlung: string | null = null;
  if (p.pay) {
    paymentId = String(p.pay.id);
    altZahlung = String(p.pay.received_at ?? '');
    const customerId = String(query('SELECT customer_id FROM invoices WHERE id = ?', [invoiceId])[0]?.customer_id ?? '');
    // Die alte Buchung am Tag, an dem sie steht, zurücknehmen; neu am richtigen Tag — gleiche Quelle, Konten und Beträge.
    reverseSource('PAYMENT', paymentId, ctx.now, { mirrorOriginalDates: true, metadata: { correction: 'final-date', reason: p.reason } });
    db.run('UPDATE payments SET received_at = ? WHERE id = ?', [neuFinal, paymentId]);
    postInvoicePayment({
      id: paymentId, invoiceId, amount: Number(p.pay.amount) || 0, method: String(p.pay.method) as PaymentMethod,
      receivedAt: neuFinal, notes: (p.pay.notes as string | null) ?? undefined, createdAt: String(p.pay.created_at ?? ctx.now),
    }, customerId);
    trackChange('payments', paymentId, 'update', {});
  }
  db.run('UPDATE invoices SET final_issued_at = ?, updated_at = ? WHERE id = ?', [neuFinal, ctx.now, invoiceId]);
  trackChange('invoices', invoiceId, 'update', {});

  const edRev = Number(query('SELECT COALESCE(MAX(revision), 0) AS r FROM invoice_edits WHERE invoice_id = ?', [invoiceId])[0]?.r ?? 0) + 1;
  const editId = uuid();
  db.run(
    `INSERT INTO invoice_edits (id, branch_id, invoice_id, revision, reason, old_snapshot, new_snapshot, edited_by, edited_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [editId, ctx.branchId, invoiceId, edRev, p.reason,
      JSON.stringify({ kind: 'FINAL_DATE', finalIssuedAt: altFinal, finalDate: p.oldDate, payment: paymentId ? { id: paymentId, receivedAt: altZahlung } : null }),
      JSON.stringify({ kind: 'FINAL_DATE', finalIssuedAt: neuFinal, finalDate: p.newDate, payment: paymentId ? { id: paymentId, receivedAt: neuFinal } : null }),
      ctx.userId || null, ctx.now],
  );
  trackChange('invoice_edits', editId, 'insert', {});
  logAuditOrThrow({
    module: 'Sales', entityType: 'invoices', entityId: invoiceId, action: 'UPDATE', field: 'final_issued_at',
    oldValue: { finalDate: p.oldDate, finalIssuedAt: altFinal },
    newValue: { finalDate: p.newDate, finalIssuedAt: neuFinal, reason: p.reason, invoiceNumber: String(p.inv.invoice_number ?? ''),
      paymentMoved: paymentId ? { paymentId, from: altZahlung, to: neuFinal } : null },
    actor: { branchId: ctx.branchId, userId: ctx.userId },
  });
  if (paymentId) {
    logAuditOrThrow({
      module: 'Sales', entityType: 'payments', entityId: paymentId, action: 'UPDATE', field: 'received_at',
      oldValue: altZahlung, newValue: { receivedAt: neuFinal, reason: p.reason, invoiceId, via: 'correct final invoice date' },
      actor: { branchId: ctx.branchId, userId: ctx.userId },
    });
  }
  // Gegenprüfung: was der NBR-Export zeigt, darf sich in keinem eingereichten Quartal ändern (oben schon geprüft; hier fail-closed).
  assertVatUnchanged(ctx.branchId, vorher, vatFingerprint(invoiceId));

  const revision = Number(query('SELECT revision FROM invoices WHERE id = ?', [invoiceId])[0]?.revision ?? 0);
  return { invoiceId, invoiceNumber: String(p.inv.invoice_number ?? ''), oldDate: p.oldDate, newDate: p.newDate, paymentId, revision };
}

// ── Am Primary: exklusiv, in EINER Transaktion, danach durabel gespeichert (PC2: `invoices.correct_final_date`) ──

function localCtx(): FinalDateCtx {
  const session = useAuthStore.getState().session as { role?: string } | null | undefined;
  return { branchId: currentBranchId(), userId: currentUserId(), now: new Date().toISOString(), role: session?.role };
}

/** Die Maske am Primary: Vorprüfung ohne Schreiben (für Hinweise vor dem Speichern). */
export function checkFinalDateCorrectionHere(input: FinalDateInput): { code: string; message: string } | null {
  return checkFinalDateCorrection(input, localCtx());
}

/** „Correct final date" am Primary. */
export function correctFinalInvoiceDateOnPrimary(input: FinalDateInput, reload: () => void = () => {}): Promise<FinalDateCorrected> {
  return runOnPrimary(() => correctFinalInvoiceDateInHouse(input, localCtx()), reload);
}
