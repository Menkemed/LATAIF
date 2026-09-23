// ════════════════════════════════════════════════════════════════════════════
// INVOICE-EDIT S3 — den Kunden einer Rechnung wechseln, auch wenn schon gezahlt wurde.
//
// Früher lehnte `editInvoice` jeden Kundenwechsel mit Zahlungen ab: der Edit buchte nur die
// INVOICE-Quelle um, die Zahlungsbeine (DR Kasse / CR Forderung, Gegenpartei = Kunde) blieben beim
// alten Kunden — die Forderung wäre auf zwei Kunden verteilt gewesen.
//
// Jetzt ziehen die Zahlungsbeine mit: jede Zahlung wird mit dem vorhandenen Storno
// (`reverseSource('PAYMENT')`) beim alten Kunden ausgebucht und mit der vorhandenen Zahlungsbuchung
// (`postInvoicePayment`) beim neuen Kunden neu gebucht. Storno und Neubuchung — der Zahlungen UND
// der Rechnung (`editInvoice`) — tragen EIN gemeinsames Korrekturdatum: den Tag des Wechsels. So
// bleiben Stichtagsauszüge vor dem Wechsel wie sie waren (die Rechnung und ihre Zahlungen stehen
// dort beim alten Kunden), nichts wird zurückdatiert, und Kasse/Bank/Umsatz/VAT heben sich am
// Korrekturtag auf — nur die Forderung wandert. Die Zahlungszeilen selbst (ID, Betrag, Art,
// Referenz, Notiz, Datum) und das Rechnungsdatum bleiben unberührt; Nummer, Zeilen, Bestand und
// Retourenverweise sowieso. Alles in der Transaktion von `editInvoice`.
//
// Gesperrt bleibt, was einem Kunden GEHÖRT und sich nicht sicher übertragen lässt:
//   • Guthaben aus dieser Rechnung (Überzahlung beim Zahlen oder aus einem früheren Edit),
//   • eine mit Guthaben bezahlte Rate (das Guthaben war das des alten Kunden),
//   • Retouren/Gutschriften (sie lauten auf den alten Kunden und buchen dessen Forderung),
//   • eine Rechnung aus einem Auftrag mit Anzahlung (die Anzahlung gehört zum Auftrag des Kunden).
// Keine Verrechnung zwischen zwei Kunden. Mit Zahlungen braucht der Wechsel eine ausdrückliche
// Bestätigung; eine neue Zahlung im selben Speichern ist nicht erlaubt (sie würde beim alten
// Kunden gebucht).
// ════════════════════════════════════════════════════════════════════════════
import { query } from '@/core/db/helpers';
import { InvoiceActionRejected } from '@/core/invoices/invoice-cancel';
import { postInvoicePayment, reverseSource } from '@/core/ledger/posting';
import type { PaymentMethod } from '@/core/models/types';

/** Dieselbe Kennung wie beim Anlegen (`invoice-create-house`) — hier nicht importiert, weil jenes
 *  Modul den Rechnungs-Store lädt, der dieses Modul lädt (Zirkel). */
export const CUSTOMER_NOT_FOUND = 'CUSTOMER_NOT_FOUND';

export const CUSTOMER_CHANGE_NEEDS_CONFIRMATION = 'INVOICE_CUSTOMER_CHANGE_NEEDS_CONFIRMATION';
export const CUSTOMER_CHANGE_WITH_NEW_PAYMENT = 'INVOICE_CUSTOMER_CHANGE_WITH_NEW_PAYMENT';
export const CUSTOMER_CHANGE_HAS_CREDIT = 'INVOICE_CUSTOMER_CHANGE_HAS_CREDIT';
export const CUSTOMER_CHANGE_HAS_RETURN = 'INVOICE_CUSTOMER_CHANGE_HAS_RETURN';
export const CUSTOMER_CHANGE_FROM_ORDER = 'INVOICE_CUSTOMER_CHANGE_FROM_ORDER';
export const CUSTOMER_CHANGE_PAYMENT_UNCLEAR = 'INVOICE_CUSTOMER_CHANGE_PAYMENT_UNCLEAR';

/** Die Kennungen, die ein Kundenwechsel als endgültiges fachliches Nein trägt (PC2-Urteilsliste). */
export const CUSTOMER_CHANGE_VERDICTS: readonly string[] = [
  CUSTOMER_CHANGE_NEEDS_CONFIRMATION, CUSTOMER_CHANGE_WITH_NEW_PAYMENT, CUSTOMER_CHANGE_HAS_CREDIT,
  CUSTOMER_CHANGE_HAS_RETURN, CUSTOMER_CHANGE_FROM_ORDER, CUSTOMER_CHANGE_PAYMENT_UNCLEAR, CUSTOMER_NOT_FOUND,
];

export interface MovablePayment {
  id: string;
  invoiceId: string;
  amount: number;
  method: string;
  receivedAt: string;
  createdAt: string;
  notes: string | null;
  /** Die wirksamen Buchungsbeine als Unterschrift (Konto|Richtung|Betrag) — muss nach dem Umbuchen gleich sein. */
  signature: string;
  /** false = Altzahlung ohne Buchung: nichts umzubuchen. */
  booked: boolean;
}

export interface CustomerChangePlan {
  from: string;
  to: string;
  payments: MovablePayment[];
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
  const inv = query('SELECT branch_id FROM invoices WHERE id = ?', [invoiceId])[0];
  if (!to || !inv || !query('SELECT id FROM customers WHERE id = ? AND branch_id = ?', [to, inv.branch_id])[0]) {
    throw new InvoiceActionRejected(CUSTOMER_NOT_FOUND, 'no such client in this branch');
  }
  if (opts.newPayment) {
    throw new InvoiceActionRejected(CUSTOMER_CHANGE_WITH_NEW_PAYMENT,
      'Change the customer and record the new payment in two steps: save the customer change first, then record the payment.');
  }
  // Retouren und Gutschriften lauten auf den alten Kunden und bewegen dessen Forderung — auch ohne Zahlung.
  const returns = Number(query(
    `SELECT (SELECT COUNT(*) FROM sales_returns WHERE invoice_id = ? AND status != 'REJECTED')
          + (SELECT COUNT(*) FROM credit_notes WHERE invoice_id = ? AND status != 'CANCELLED') AS c`,
    [invoiceId, invoiceId],
  )[0]?.c ?? 0);
  if (returns > 0) {
    throw new InvoiceActionRejected(CUSTOMER_CHANGE_HAS_RETURN,
      `The customer cannot be changed: this invoice has a return or credit note for ${customerName(from)}. Cancel it first.`);
  }

  const rows = query(
    `SELECT id, amount, method, received_at, created_at, notes FROM payments WHERE invoice_id = ? ORDER BY received_at, created_at, id`,
    [invoiceId],
  );
  // Guthaben aus dieser Rechnung (Überzahlung beim Zahlen oder aus einem Edit) gehört dem alten Kunden.
  const credit = query(
    `SELECT 1 FROM customer_credits
      WHERE (source_type = 'invoice_edit' AND source_id = ?)
         OR (source_type = 'overpayment' AND source_id IN (SELECT id FROM payments WHERE invoice_id = ?))
      LIMIT 1`,
    [invoiceId, invoiceId],
  ).length > 0;
  if (credit || rows.some((r) => String(r.method) === 'credit')) {
    throw new InvoiceActionRejected(CUSTOMER_CHANGE_HAS_CREDIT,
      `The customer cannot be changed: store credit of ${customerName(from)} is tied to this invoice `
      + '(an overpayment or a payment made with store credit). Store credit is never moved to another customer.');
  }
  if (rows.length === 0) return { from, to, payments: [] };

  if (query('SELECT 1 FROM order_lines WHERE invoice_id = ? LIMIT 1', [invoiceId]).length > 0) {
    throw new InvoiceActionRejected(CUSTOMER_CHANGE_FROM_ORDER,
      'The customer cannot be changed: this invoice was created from an order, and its payments belong to that order.');
  }
  if (!opts.confirmed) {
    throw new InvoiceActionRejected(CUSTOMER_CHANGE_NEEDS_CONFIRMATION,
      `This invoice has payments. Confirm that the invoice and its payments move from ${customerName(from)} to ${customerName(to)}.`);
  }

  const payments = rows.map((r): MovablePayment => {
    const id = String(r.id);
    const legs = activeLegs('PAYMENT', id);
    const amount = Number(r.amount) || 0;
    const ok = legs.length === 0 || (
      legs.length === 2
      && legs.every((l) => l.cpType === 'CUSTOMER' && l.cpId === from && Math.abs(l.amount - amount) < 0.0005)
      && legs.some((l) => l.account === 'ACCOUNTS_RECEIVABLE' && l.direction === 'CREDIT')
      && legs.some((l) => l.account !== 'ACCOUNTS_RECEIVABLE' && l.account !== 'CUSTOMER_CREDIT' && l.direction === 'DEBIT')
    );
    if (!ok) {
      throw new InvoiceActionRejected(CUSTOMER_CHANGE_PAYMENT_UNCLEAR,
        'The customer cannot be changed automatically: a payment of this invoice is not booked as a plain payment. Check the payments first.');
    }
    return {
      id, invoiceId, amount, method: String(r.method), receivedAt: String(r.received_at), createdAt: String(r.created_at),
      notes: (r.notes as string | null) ?? null, signature: signatureOf(legs), booked: legs.length > 0,
    };
  });
  return { from, to, payments };
}

/**
 * Bucht die Zahlungen beim alten Kunden aus und beim neuen ein — mit den vorhandenen Buchungen,
 * beides auf das Korrekturdatum `at` (dasselbe, auf das `editInvoice` die Rechnung umbucht).
 * Nur innerhalb der offenen Transaktion von `editInvoice` aufrufen. Prüft danach, dass jede
 * Zahlung Konto für Konto dieselben Beträge trägt (sonst Rollback).
 */
export function moveInvoicePayments(plan: CustomerChangePlan, at: string): string[] {
  const moved: string[] = [];
  for (const p of plan.payments) {
    if (!p.booked) continue;
    reverseSource('PAYMENT', p.id, at);
    postInvoicePayment({
      id: p.id, invoiceId: p.invoiceId, amount: p.amount, method: p.method as PaymentMethod,
      receivedAt: p.receivedAt, notes: p.notes ?? undefined, createdAt: p.createdAt,
    }, plan.to, undefined, { occurredAt: at });
    const after = activeLegs('PAYMENT', p.id);
    if (signatureOf(after) !== p.signature || after.some((l) => l.cpId !== plan.to)) {
      throw new Error(`moveInvoicePayments: payment ${p.id} would change its booking — nothing was moved.`);
    }
    moved.push(p.id);
  }
  return moved;
}

export { customerName as customerDisplayName };
