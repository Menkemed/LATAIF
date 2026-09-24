// ════════════════════════════════════════════════════════════════════════════
// INVOICE-EDIT S3/S5 — den falsch gewählten Kunden einer Rechnung korrigieren, mit allem, was an ihr hängt.
//
// Es ist keine Übertragung eines Geschäfts zwischen zwei Personen, sondern die Korrektur einer
// falschen Zuordnung: die Rechnung, ihre Zahlungen, Retouren, Gutschriften samt Erstattungen und das
// Guthaben, das AUS dieser Rechnung entstand, gehörten von Anfang an dem richtigen Kunden. Alles
// zieht deshalb gemeinsam um — in der Transaktion von `editInvoice`, ganz oder gar nicht.
//
// Gebucht wird nur mit den vorhandenen Buchungen: jede Quelle (PAYMENT, CREDIT_NOTE; die Rechnung
// selbst in `editInvoice`) wird mit `reverseSource` beim alten Kunden ausgebucht und mit ihrer
// eigenen Buchungsfunktion (`postInvoicePayment`, `postCreditNote`) beim neuen neu gebucht — alle
// auf EIN Korrekturdatum, den Tag des Wechsels. Stichtage davor bleiben, wie sie waren; am
// Korrekturtag heben sich Kasse, Bank, Umsatz, VAT und Erstattungen auf, nur die kundenbezogenen
// Salden (Forderung, Guthaben) wandern. Nach dem Umbuchen muss jede Quelle Konto für Konto dieselben
// Beträge tragen (sonst Rollback). Belege (Nummern, Beträge, Daten, Referenzen, Link-Zeilen) bleiben;
// nur ihr Kunde wird korrigiert. Die Spur bleibt: Storno-Buchungen, Revision, Verlauf.
//
// Gesperrt (mit Kennung), wo eine Korrektur fremdes Eigentum oder gemeldete Steuer berührte:
//   • Guthaben aus dieser Rechnung, das für ETWAS ANDERES verwendet wurde (dann hat der alte Kunde
//     echten Gegenwert erhalten — das ist ein eigener Fall),
//   • eine Rate, bezahlt mit UNABHÄNGIGEM Guthaben des alten Kunden (dessen Guthaben bleibt seins),
//   • eine Rechnung aus einem Auftrag oder einer Reparatur mit Geldfluss (die haben eigene Kunden-
//     buchungen),
//   • eine Rechnung oder Gutschrift in einem Quartal, für das die VAT schon bezahlt (also gemeldet)
//     ist — dort stünde im NBR-Export ein anderer Käufer; das braucht einen Korrekturbeleg.
// Mit Geldfluss braucht die Korrektur eine ausdrückliche Bestätigung; eine neue Zahlung im selben
// Speichern ist nicht erlaubt (sie würde beim alten Kunden gebucht).
// ════════════════════════════════════════════════════════════════════════════
import { getDatabase } from '@/core/db/database';
import { query } from '@/core/db/helpers';
import { trackChange } from '@/core/sync/sync-service';
import { InvoiceActionRejected } from '@/core/invoices/invoice-cancel';
import { logAuditOrThrow } from '@/core/audit/audit-log';
import { postCreditNote, postInvoicePayment, reverseSource } from '@/core/ledger/posting';
import type { CreditNote, PaymentMethod } from '@/core/models/types';

/** Dieselbe Kennung wie beim Anlegen (`invoice-create-house`) — hier nicht importiert, weil jenes
 *  Modul den Rechnungs-Store lädt, der dieses Modul lädt (Zirkel). */
export const CUSTOMER_NOT_FOUND = 'CUSTOMER_NOT_FOUND';

export const CUSTOMER_CHANGE_NEEDS_CONFIRMATION = 'INVOICE_CUSTOMER_CHANGE_NEEDS_CONFIRMATION';
export const CUSTOMER_CHANGE_WITH_NEW_PAYMENT = 'INVOICE_CUSTOMER_CHANGE_WITH_NEW_PAYMENT';
export const CUSTOMER_CHANGE_CREDIT_USED_ELSEWHERE = 'INVOICE_CUSTOMER_CHANGE_CREDIT_USED_ELSEWHERE';
export const CUSTOMER_CHANGE_FOREIGN_CREDIT = 'INVOICE_CUSTOMER_CHANGE_FOREIGN_CREDIT';
export const CUSTOMER_CHANGE_FROM_ORDER = 'INVOICE_CUSTOMER_CHANGE_FROM_ORDER';
export const CUSTOMER_CHANGE_FROM_REPAIR = 'INVOICE_CUSTOMER_CHANGE_FROM_REPAIR';
export const CUSTOMER_CHANGE_VAT_FILED = 'INVOICE_CUSTOMER_CHANGE_VAT_FILED';
export const CUSTOMER_CHANGE_PAYMENT_UNCLEAR = 'INVOICE_CUSTOMER_CHANGE_PAYMENT_UNCLEAR';

/** Die Kennungen, die ein Kundenwechsel als endgültiges fachliches Nein trägt (PC2-Urteilsliste). */
export const CUSTOMER_CHANGE_VERDICTS: readonly string[] = [
  CUSTOMER_CHANGE_NEEDS_CONFIRMATION, CUSTOMER_CHANGE_WITH_NEW_PAYMENT, CUSTOMER_CHANGE_CREDIT_USED_ELSEWHERE,
  CUSTOMER_CHANGE_FOREIGN_CREDIT, CUSTOMER_CHANGE_FROM_ORDER, CUSTOMER_CHANGE_FROM_REPAIR, CUSTOMER_CHANGE_VAT_FILED,
  CUSTOMER_CHANGE_PAYMENT_UNCLEAR, CUSTOMER_NOT_FOUND,
];

export interface MovablePayment {
  id: string;
  invoiceId: string;
  amount: number;
  method: string;
  receivedAt: string;
  createdAt: string;
  notes: string | null;
  /** Der Forderungsanteil, wenn die Zahlung beim Buchen geteilt wurde (Rest = Guthaben); sonst undefined. */
  openRemainder: number | undefined;
  /** Die wirksamen Buchungsbeine als Unterschrift (Konto|Richtung|Betrag) — muss nach dem Umbuchen gleich sein. */
  signature: string;
  /** false = Altzahlung ohne Buchung: nichts umzubuchen. */
  booked: boolean;
}

export interface MovableCreditNote {
  cn: CreditNote;
  signature: string;
}

export interface CustomerChangePlan {
  from: string;
  to: string;
  payments: MovablePayment[];
  /** Wirksame Gutschriften mit Buchung — werden umgebucht. */
  creditNotes: MovableCreditNote[];
  /** Belege, deren Kunde korrigiert wird (ohne Buchung): alle Gutschriften und Retouren der Rechnung. */
  creditNoteIds: string[];
  returnIds: string[];
  /** Guthaben aus dieser Rechnung (Überzahlung, Retoure). Das Edit-Guthaben baut `editInvoice` selbst neu. */
  creditIds: string[];
  /** Angebote, aus denen diese Rechnung wurde und die noch auf den alten Kunden lauten. */
  offerIds: string[];
}

/** Die wirksamen (nicht gegengebuchten) Beine einer Quelle. */
function activeLegs(sourceModule: string, sourceId: string): Array<{ account: string; direction: string; amount: number; cpType: string; cpId: string }> {
  return query(
    `SELECT e1.account, e1.direction, e1.amount, e1.counterparty_type, e1.counterparty_id
       FROM ledger_entries e1
      WHERE e1.source_module = ? AND e1.source_id = ? AND e1.reverses_entry_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM ledger_entries e2 WHERE e2.reverses_entry_id = e1.id)`,
    [sourceModule, sourceId],
  ).map((r) => ({
    account: String(r.account), direction: String(r.direction), amount: Number(r.amount) || 0,
    cpType: String(r.counterparty_type ?? ''), cpId: String(r.counterparty_id ?? ''),
  }));
}

const signatureOf = (legs: ReturnType<typeof activeLegs>): string =>
  legs.map((l) => `${l.account}|${l.direction}|${l.amount.toFixed(3)}`).sort().join(';');

function customerName(id: string): string {
  const r = query('SELECT first_name, last_name, company FROM customers WHERE id = ?', [id])[0];
  const name = [r?.first_name, r?.last_name].map((v) => String(v ?? '').trim()).filter(Boolean).join(' ');
  return name || String(r?.company ?? '') || id;
}

const ids = (rows: Array<Record<string, unknown>>): string[] => rows.map((r) => String(r.id));
const quarterOf = (iso: string): string => {
  const y = Number(iso.slice(0, 4)); const m = Number(iso.slice(5, 7));
  return y > 0 && m > 0 ? `${y}-Q${Math.ceil(m / 3)}` : '';
};
const unclear = (): InvoiceActionRejected => new InvoiceActionRejected(CUSTOMER_CHANGE_PAYMENT_UNCLEAR,
  'The customer cannot be changed automatically: a booking of this invoice is not in its usual form. Check its payments and credit notes first.');

/**
 * Prüft VOR jedem Schreiben, ob der Kunde wechseln darf, und liefert, was umzubuchen ist.
 * `null` = kein Wechsel. Wirft `InvoiceActionRejected` mit Kennung und verständlichem Satz.
 */
export function planCustomerChange(
  invoiceId: string,
  from: string,
  to: string | undefined,
  opts: { confirmed?: boolean; newPayment?: boolean },
): CustomerChangePlan | null {
  if (to === undefined || to === from) return null;
  const inv = query('SELECT branch_id, status, issued_at, created_at FROM invoices WHERE id = ?', [invoiceId])[0];
  if (!to || !inv || !query('SELECT id FROM customers WHERE id = ? AND branch_id = ?', [to, inv.branch_id])[0]) {
    throw new InvoiceActionRejected(CUSTOMER_NOT_FOUND, 'no such client in this branch');
  }
  if (opts.newPayment) {
    throw new InvoiceActionRejected(CUSTOMER_CHANGE_WITH_NEW_PAYMENT,
      'Change the customer and record the new payment in two steps: save the customer change first, then record the payment.');
  }

  const payRows = query(
    `SELECT id, amount, method, received_at, created_at, notes FROM payments WHERE invoice_id = ? ORDER BY received_at, created_at, id`,
    [invoiceId],
  );
  const paymentIds = new Set(ids(payRows));
  const cnRows = query(
    `SELECT id, credit_note_number, branch_id, customer_id, invoice_id, sales_return_id, total_amount, vat_amount,
            cash_refund_amount, receivable_cancel_amount, refund_method, reason, notes, issued_at, created_at, status
       FROM credit_notes WHERE invoice_id = ?`,
    [invoiceId],
  );
  const activeCn = cnRows.filter((r) => String(r.status ?? 'ISSUED') !== 'CANCELLED');
  const returnRows = query('SELECT id, status FROM sales_returns WHERE invoice_id = ?', [invoiceId]);
  const creditRows = query(
    `SELECT id, amount, used_amount, source_type FROM customer_credits
      WHERE (source_type = 'overpayment' AND source_id IN (SELECT id FROM payments WHERE invoice_id = ?))
         OR (source_type = 'sales_return' AND source_id IN (SELECT id FROM credit_notes WHERE invoice_id = ?))
         OR (source_type = 'invoice_edit' AND source_id = ?)`,
    [invoiceId, invoiceId, invoiceId],
  );
  const invoiceCreditIds = new Set(ids(creditRows));
  const moneyFlow = payRows.length > 0 || activeCn.length > 0 || creditRows.length > 0
    || returnRows.some((r) => String(r.status) !== 'REJECTED');

  const plan: CustomerChangePlan = {
    from, to, payments: [], creditNotes: [], creditNoteIds: ids(cnRows), returnIds: ids(returnRows),
    creditIds: creditRows.filter((r) => String(r.source_type) !== 'invoice_edit').map((r) => String(r.id)),
    offerIds: ids(query('SELECT id FROM offers WHERE invoice_id = ? AND customer_id = ?', [invoiceId, from])),
  };
  if (!moneyFlow) return plan;

  // Auftrag / Reparatur: eigene Kundenbuchungen (Anzahlungen, Reparaturzahlungen) — eigener Fall.
  if (query(`SELECT 1 FROM order_lines WHERE invoice_id = ? UNION SELECT 1 FROM orders WHERE invoice_id = ? LIMIT 1`, [invoiceId, invoiceId]).length > 0) {
    throw new InvoiceActionRejected(CUSTOMER_CHANGE_FROM_ORDER,
      'The customer cannot be changed here: this invoice was created from an order, and its payments belong to that order. Correct the order first.');
  }
  if (query('SELECT 1 FROM repairs WHERE invoice_id = ? LIMIT 1', [invoiceId]).length > 0) {
    throw new InvoiceActionRejected(CUSTOMER_CHANGE_FROM_REPAIR,
      'The customer cannot be changed here: this invoice belongs to a repair with its own customer bookings. Correct the repair first.');
  }

  // Gemeldete VAT: ein bezahltes Quartal, in dem diese Rechnung oder eine ihrer Gutschriften steht.
  // Der NBR-Export zeigt dort den Käufer — ein anderer Käufer braucht einen Beleg.
  // BEKANNTE LÜCKE (nicht erledigt): erkannt wird nur ein Quartal, dessen VAT schon BEZAHLT ist
  // (`tax_payments`). Eine eingereichte, aber noch unbezahlte Periode (und eine Erstattungsperiode)
  // ist hier NICHT geschützt — das Haus kennt „eingereicht" noch nicht. Das leistet erst das eigene
  // VAT-Perioden-Paket („VAT gemeldet bis"); es bleibt Release-Blocker.
  const filed = new Set(query('SELECT DISTINCT year, quarter FROM tax_payments WHERE branch_id = ?', [inv.branch_id])
    .map((r) => `${Number(r.year)}-Q${Number(r.quarter)}`));
  if (filed.size > 0) {
    const status = String(inv.status);
    const lastPay = payRows.reduce((m, r) => (String(r.received_at) > m ? String(r.received_at) : m), '');
    const invDate = lastPay || String(inv.issued_at ?? inv.created_at ?? '');
    const quarters = [
      ...(status === 'FINAL' || status === 'RETURNED' ? [quarterOf(invDate)] : []),
      ...activeCn.map((r) => quarterOf(String(r.issued_at ?? ''))),
    ].filter((q) => filed.has(q));
    if (quarters.length > 0) {
      throw new InvoiceActionRejected(CUSTOMER_CHANGE_VAT_FILED,
        `The customer cannot be changed: the VAT for ${[...new Set(quarters)].join(', ')} is already paid, and this invoice `
        + 'is part of it. A different buyer on a filed return needs a tax correction document — handle it separately.');
    }
  }

  // Guthaben aus dieser Rechnung: nur umbuchbar, solange es nirgends sonst verwendet wurde.
  for (const c of creditRows) {
    const apps = query('SELECT payment_id, amount FROM credit_applications WHERE credit_id = ?', [String(c.id)]);
    const onThis = apps.filter((a) => paymentIds.has(String(a.payment_id))).reduce((s, a) => s + (Number(a.amount) || 0), 0);
    const used = Number(c.used_amount) || 0;
    if (apps.some((a) => !paymentIds.has(String(a.payment_id))) || used > onThis + 0.005) {
      throw new InvoiceActionRejected(CUSTOMER_CHANGE_CREDIT_USED_ELSEWHERE,
        `The customer cannot be changed: store credit from this invoice was already used by ${customerName(from)} for something else. `
        + 'That value really went to them — handle this case separately.');
    }
  }
  // Mit Guthaben bezahlte Raten: nur Guthaben, das selbst aus dieser Rechnung stammt, zieht mit.
  for (const p of payRows.filter((r) => String(r.method) === 'credit')) {
    const apps = query('SELECT credit_id FROM credit_applications WHERE payment_id = ?', [String(p.id)]);
    if (apps.length === 0 || apps.some((a) => !invoiceCreditIds.has(String(a.credit_id)))) {
      throw new InvoiceActionRejected(CUSTOMER_CHANGE_FOREIGN_CREDIT,
        `The customer cannot be changed: part of this invoice was paid with store credit of ${customerName(from)} that does not `
        + 'come from this invoice. Remove that store-credit payment first (the credit goes back to them), then change the customer.');
    }
  }

  if (!opts.confirmed) {
    throw new InvoiceActionRejected(CUSTOMER_CHANGE_NEEDS_CONFIRMATION,
      `This invoice has payments, returns or credit. Confirm that the invoice and everything booked on it move from ${customerName(from)} to ${customerName(to)}.`);
  }

  plan.payments = payRows.map((r): MovablePayment => {
    const id = String(r.id);
    const legs = activeLegs('PAYMENT', id);
    const amount = Number(r.amount) || 0;
    const debit = legs.filter((l) => l.direction === 'DEBIT');
    const ar = legs.filter((l) => l.account === 'ACCOUNTS_RECEIVABLE' && l.direction === 'CREDIT');
    const split = legs.filter((l) => l.account === 'CUSTOMER_CREDIT' && l.direction === 'CREDIT');
    const arAmount = ar.reduce((s, l) => s + l.amount, 0);
    const splitAmount = split.reduce((s, l) => s + l.amount, 0);
    const ok = legs.length === 0 || (
      debit.length === 1 && debit[0].account !== 'ACCOUNTS_RECEIVABLE' && Math.abs(debit[0].amount - amount) < 0.0005
      && ar.length === 1 && split.length <= 1 && ar.length + split.length + 1 === legs.length
      && Math.abs(arAmount + splitAmount - amount) < 0.0005
      && legs.every((l) => l.cpType === 'CUSTOMER' && l.cpId === from)
    );
    if (!ok) throw unclear();
    return {
      id, invoiceId, amount, method: String(r.method), receivedAt: String(r.received_at), createdAt: String(r.created_at),
      notes: (r.notes as string | null) ?? null, openRemainder: split.length > 0 ? arAmount : undefined,
      signature: signatureOf(legs), booked: legs.length > 0,
    };
  });

  for (const r of activeCn) {
    const id = String(r.id);
    const legs = activeLegs('CREDIT_NOTE', id);
    if (legs.length === 0) continue;   // Alt-Gutschrift ohne Buchung: nur der Beleg wird korrigiert
    if (!legs.every((l) => l.cpType === 'CUSTOMER' && l.cpId === from)) throw unclear();
    plan.creditNotes.push({
      signature: signatureOf(legs),
      cn: {
        id, creditNoteNumber: String(r.credit_note_number), branchId: String(r.branch_id), customerId: to,
        invoiceId, salesReturnId: (r.sales_return_id as string) || undefined,
        totalAmount: Number(r.total_amount || 0), vatAmount: Number(r.vat_amount || 0),
        cashRefundAmount: Number(r.cash_refund_amount || 0), receivableCancelAmount: Number(r.receivable_cancel_amount || 0),
        refundMethod: (r.refund_method as CreditNote['refundMethod']) || 'bank',
        reason: (r.reason as string) || undefined, notes: (r.notes as string) || undefined,
        issuedAt: String(r.issued_at), createdAt: String(r.created_at),
      },
    });
  }
  return plan;
}

/**
 * Führt die Korrektur aus: Zahlungen und Gutschriften beim alten Kunden aus-, beim neuen einbuchen
 * (vorhandene Buchungen, alle auf das Korrekturdatum `at` — dasselbe, auf das `editInvoice` die
 * Rechnung umbucht), dann den Kunden der Belege korrigieren. Nur innerhalb der offenen Transaktion
 * von `editInvoice` aufrufen; jede Abweichung wirft und rollt alles zurück.
 */
export function moveInvoiceBookings(plan: CustomerChangePlan, at: string): { payments: string[]; creditNotes: string[]; recorded: CorrectionTrail } {
  // Wer hat laut Beleg bezahlt / Geld erhalten? VOR dem Umbuchen festhalten — die Belege selbst
  // bleiben unverändert, aber ihr Kunde ist danach der richtige. Die Spur steht in der Revision und
  // im Verlauf JEDES Belegs, damit nie unklar ist, wem eine Auszahlung damals zugeordnet war.
  const recorded = recordTrail(plan);
  const moved = { payments: [] as string[], creditNotes: [] as string[], recorded };
  for (const p of plan.payments) {
    if (!p.booked) continue;
    reverseSource('PAYMENT', p.id, at);
    postInvoicePayment({
      id: p.id, invoiceId: p.invoiceId, amount: p.amount, method: p.method as PaymentMethod,
      receivedAt: p.receivedAt, notes: p.notes ?? undefined, createdAt: p.createdAt,
    }, plan.to, p.openRemainder, { occurredAt: at });
    const after = activeLegs('PAYMENT', p.id);
    if (signatureOf(after) !== p.signature || after.some((l) => l.cpId !== plan.to)) {
      throw new Error(`moveInvoiceBookings: payment ${p.id} would change its booking — nothing was moved.`);
    }
    moved.payments.push(p.id);
  }
  for (const c of plan.creditNotes) {
    reverseSource('CREDIT_NOTE', c.cn.id, at);
    postCreditNote(c.cn, { occurredAt: at });
    const after = activeLegs('CREDIT_NOTE', c.cn.id);
    if (signatureOf(after) !== c.signature || after.some((l) => l.cpId !== plan.to)) {
      throw new Error(`moveInvoiceBookings: credit note ${c.cn.creditNoteNumber} would change its booking — nothing was moved.`);
    }
    moved.creditNotes.push(c.cn.id);
  }
  const db = getDatabase();
  const relink = (table: string, rowIds: string[]): void => {
    for (const id of rowIds) {
      db.run(`UPDATE ${table} SET customer_id = ? WHERE id = ?`, [plan.to, id]);
      trackChange(table, id, 'update', {});
    }
  };
  relink('credit_notes', plan.creditNoteIds);
  relink('sales_returns', plan.returnIds);
  relink('customer_credits', plan.creditIds);
  relink('offers', plan.offerIds);
  writeTrailToHistory(plan, recorded);
  return moved;
}

/** Die Geldflüsse, wie sie VOR der Korrektur gebucht waren: Zahler und Empfänger laut Beleg. */
export interface CorrectionTrail {
  payments: Array<{ id: string; amount: number; method: string; receivedAt: string; recordedPayer: string }>;
  refunds: Array<{ returnId: string; returnNumber: string; paid: number; method: string; date: string; recordedRecipient: string }>;
  creditNotes: Array<{ id: string; number: string; cashRefund: number; refundMethod: string; recordedRecipient: string }>;
}

function recordTrail(plan: CustomerChangePlan): CorrectionTrail {
  const inList = (list: string[]): string => list.map(() => '?').join(',') || 'NULL';
  return {
    payments: plan.payments.map((p) => ({
      id: p.id, amount: p.amount, method: p.method, receivedAt: p.receivedAt, recordedPayer: plan.from,
    })),
    refunds: query(
      `SELECT id, return_number, refund_paid_amount, refund_method, refund_paid_date, customer_id FROM sales_returns
        WHERE id IN (${inList(plan.returnIds)}) AND COALESCE(refund_paid_amount, 0) > 0`, plan.returnIds,
    ).map((r) => ({
      returnId: String(r.id), returnNumber: String(r.return_number ?? ''), paid: Number(r.refund_paid_amount) || 0,
      method: String(r.refund_method ?? ''), date: String(r.refund_paid_date ?? ''), recordedRecipient: String(r.customer_id),
    })),
    creditNotes: query(
      `SELECT id, credit_note_number, cash_refund_amount, refund_method, customer_id FROM credit_notes
        WHERE id IN (${inList(plan.creditNoteIds)})`, plan.creditNoteIds,
    ).map((r) => ({
      id: String(r.id), number: String(r.credit_note_number), cashRefund: Number(r.cash_refund_amount) || 0,
      refundMethod: String(r.refund_method ?? ''), recordedRecipient: String(r.customer_id),
    })),
  };
}

/** Je Beleg ein Verlaufseintrag: alter Kunde samt der damals gebuchten Zahlung/Auszahlung → neuer Kunde. */
function writeTrailToHistory(plan: CustomerChangePlan, t: CorrectionTrail): void {
  const from = customerName(plan.from); const to = customerName(plan.to);
  const entry = (entityType: string, entityId: string, oldValue: string): void => logAuditOrThrow({
    module: 'Sales', entityType, entityId, action: 'UPDATE', field: 'customer (correction)', oldValue, newValue: to,
  });
  for (const p of t.payments) {
    entry('payments', p.id, `${from} — recorded payer of ${p.amount.toFixed(3)} BHD ${p.method} on ${p.receivedAt.slice(0, 10)}`);
  }
  for (const r of t.refunds) {
    entry('sales_returns', r.returnId, `${customerName(r.recordedRecipient)} — recorded recipient of refund ${r.paid.toFixed(3)} BHD ${r.method} on ${r.date.slice(0, 10)}`);
  }
  for (const c of t.creditNotes) {
    entry('credit_notes', c.id, c.cashRefund > 0.0005
      ? `${customerName(c.recordedRecipient)} — recorded recipient of ${c.cashRefund.toFixed(3)} BHD (${c.refundMethod})`
      : customerName(c.recordedRecipient));
  }
  for (const id of plan.creditIds) entry('customer_credits', id, from);
}

/**
 * INVOICE-EDIT S4 — „letzter Kauf" folgt der Rechnung. `invoice.paid` setzt `last_purchase_at` (und
 * die Verkaufsstufe) beim Kunden, der die Rechnung beim Bezahlen hatte. Wechselt eine BEZAHLTE
 * Rechnung den Kunden, bliebe der Kauf beim alten Kunden stehen und fehlte beim neuen.
 *   • neuer Kunde (Rechnung bleibt FINAL): letzter Kauf = spätestens der Abschluss dieser Rechnung,
 *     Verkaufsstufe „active" — wie `invoice.paid`. Wird sie erst durch diesen Edit FINAL, meldet das
 *     `invoice.paid` selbst (nach dem Commit).
 *   • alter Kunde (Rechnung war FINAL): war sie sein letzter Kauf, gilt wieder sein vorletzter
 *     (Abschluss seiner übrigen bezahlten Rechnungen, sonst leer). Hat er einen späteren Kauf, bleibt
 *     alles, wie es ist. Die Verkaufsstufe bleibt (sie ist ein Vertriebsstand, kein Zähler).
 * Umsatz- und Kaufkennzahlen rechnet das Haus aus den Rechnungen (`computeSalesMetrics`) — die folgen
 * dem Kunden der Rechnung von selbst.
 */
export function moveLastPurchase(
  plan: CustomerChangePlan, invoiceId: string, wasFinal: boolean, isFinal: boolean, now: string,
): string[] {
  const touched: string[] = [];
  const doneAt = String(query(
    'SELECT COALESCE(number_finalized_at, issued_at, created_at) AS t FROM invoices WHERE id = ?', [invoiceId],
  )[0]?.t ?? now);
  if (wasFinal) {
    const old = query('SELECT last_purchase_at FROM customers WHERE id = ?', [plan.from])[0];
    const current = (old?.last_purchase_at as string | null) ?? null;
    const others = (query(
      `SELECT MAX(COALESCE(number_finalized_at, issued_at, created_at)) AS t FROM invoices
        WHERE customer_id = ? AND status = 'FINAL' AND id != ?`, [plan.from, invoiceId],
    )[0]?.t as string | null) ?? null;
    if (current !== null && (others === null || others < doneAt)) {
      getDatabase().run('UPDATE customers SET last_purchase_at = ?, updated_at = ? WHERE id = ?', [others, now, plan.from]);
      touched.push(plan.from);
    }
  }
  if (wasFinal && isFinal) {
    getDatabase().run(
      `UPDATE customers SET
         last_purchase_at = CASE WHEN last_purchase_at IS NULL OR last_purchase_at < ? THEN ? ELSE last_purchase_at END,
         sales_stage = 'active', updated_at = ?
       WHERE id = ?`,
      [doneAt, doneAt, now, plan.to],
    );
    touched.push(plan.to);
  }
  return touched;
}

export { customerName as customerDisplayName };
