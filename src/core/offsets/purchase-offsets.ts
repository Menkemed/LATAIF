// ════════════════════════════════════════════════════════════════════════════
// B2/B3 — Verrechnung einer offenen Verkaufsrechnung mit einem offenen EINKAUF derselben Person (normaler Einkauf und
// Kommissions-Einkauf — beide sind dieselbe Verbindlichkeit ACCOUNTS_PAYABLE beim Lieferanten). Owner-Freigabe 10.11.2026.
//
// Wer: nur ein Einkauf eines Lieferanten, der AUSDRÜCKLICH mit dem Kunden der Rechnung verknüpft ist
// (`suppliers.linked_customer_id`), dieselbe Filiale. Kein Abgleich über Name oder Telefon.
// Was: nur der tatsächlich offene Rest (Summe − Geld − Lieferantenguthaben − wirksame Verrechnungen, `purchase-settled`)
// eines Einkaufs mit lebender Einkaufsbuchung (AP steht im Hauptbuch). Nicht: Altkommission ohne Einkauf, ConsignorLoss,
// Gold in Gramm, Eröffnungsposten, Partnerabrechnungen, Scrap-Gold — sie sind keine Einkäufe bzw. haben keine AP-Buchung.
//
// Buchung — EINE, an der Rechnungszahlung (Zahlart 'purchase_offset', vorhandener Weg `invoiceStore.recordPayment`):
//   Soll ACCOUNTS_PAYABLE      Gegenpartei LIEFERANT (der Lieferant des Einkaufs)
//   Haben ACCOUNTS_RECEIVABLE  Gegenpartei KUNDE     (der Kunde der Rechnung)
// Kein Geldkonto, keine Kartengebühr, keine zweite Kommissionsverbindlichkeit, keine neue Einkaufs-/Verkaufsbuchung, kein
// Steuertatbestand (VAT/Margin/Vorsteuer bleiben an Rechnung und Einkauf). Status, Endnummer, VAT-Periodensperre und
// Exportmonat der Rechnung folgen unverändert der Regel jeder Zahlung.
// Am Einkauf: eine Zeile 'offset' OHNE eigene Buchung; `paid_amount` bleibt nur Geld; Rest und Status nach der EINEN Regel.
// `party_offsets` (payable_type 'PURCHASE') verbindet beide Zeilen dauerhaft (STL-…, Betrag, Tag, Person, ACTIVE/REVERSED).
//
// Aufheben: nur über die Rechnungszahlung (`deletePayment` → `restorePurchaseOffsetForPayment`): Gegenbuchung, die
// Einkaufszeile wird storniert (voided_at, nie gelöscht), Rest/Status des Einkaufs neu, Verrechnung REVERSED.
// ════════════════════════════════════════════════════════════════════════════
import { v4 as uuid } from 'uuid';
import { getDatabase } from '@/core/db/database';
import { query, currentUserId, getNextDocumentNumber } from '@/core/db/helpers';
import { trackInsert } from '@/core/sync/track';
import { logAuditOrThrow } from '@/core/audit/audit-log';
import { hasLedgerEntries } from '@/core/ledger/posting';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { businessDateIssue, businessTimestamp } from '@/core/utils/business-date';
import { formatInvoiceDisplayShort } from '@/core/utils/invoiceNumber';
import { InvoiceActionRejected } from '@/core/invoices/invoice-cancel';
import { assertInvoiceHouse } from '@/core/invoices/invoice-house-guards';
import { OPENING_CUTOFF_DATE } from '@/core/parties/opening-balances';
import {
  INVOICE_PURCHASE_OFFSET_METHOD, PURCHASE_OFFSET_METHOD, purchaseSettlementOf, refreshPurchaseSettlementRow,
} from '@/core/purchases/purchase-settled';
import { OFFSET_PAYABLE_PURCHASE, OffsetRestoreError } from './party-offset-restore';
import { invoiceOpenFils, OFFSET_CLOSED_INVOICE } from './party-offset-reads';
import type { OffsetCtx, OffsetSettlementLink } from './party-offsets';

export const OFFSET_PURCHASE_NOT_FOUND = 'OFFSET_PURCHASE_NOT_FOUND';
export const OFFSET_PURCHASE_NOT_OPEN = 'OFFSET_PURCHASE_NOT_OPEN';
export const OFFSET_SUPPLIER_NOT_LINKED = 'OFFSET_SUPPLIER_NOT_LINKED';
export const OFFSET_PURCHASE_NOT_BOOKED = 'OFFSET_PURCHASE_NOT_BOOKED';
export const OFFSET_EXCEEDS_PURCHASE = 'OFFSET_EXCEEDS_PURCHASE';

const F = (n: unknown): number => Math.round((Number(n) || 0) * 1000);
const B = (f: number): number => f / 1000;
const nein = (code: string, msg: string): InvoiceActionRejected => new InvoiceActionRejected(code, `${msg} — nothing was offset`);
const todayLocal = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Ist dieser Einkauf ein Kommissions-Einkauf (Kopf oder eine Zeile verweist auf eine Kommission)? Nur für die Beschriftung. */
export function isConsignmentPurchase(purchaseId: string): boolean {
  return query(
    `SELECT 1 FROM purchases p WHERE p.id = ? AND (p.source_consignment_id IS NOT NULL
       OR EXISTS (SELECT 1 FROM purchase_lines pl WHERE pl.purchase_id = p.id AND pl.source_consignment_id IS NOT NULL)) LIMIT 1`,
    [purchaseId],
  ).length > 0;
}

export interface PurchaseOffsetInput {
  invoiceId: string;
  purchaseId: string;
  amount: number;
  /** Geschäftstag der Verrechnung (JJJJ-MM-TT); fehlt er: heute. */
  offsetDate?: string;
  /** „Final Number Type" — wirkt nur, wenn DIESE Verrechnung die Rechnung schließt. */
  specialMarkOnFinal?: boolean;
}
export interface PurchaseOffsetCreated {
  offsetId: string; offsetNumber: string; invoiceId: string; invoiceNumber: string; invoiceStatus: string; invoiceOpen: number;
  paymentId: string; purchaseId: string; purchaseNumber: string; purchasePaymentId: string; purchaseOpen: number; purchaseStatus: string;
  supplierId: string; consignment: boolean; amount: number; offsetDate: string;
}

/**
 * Eine Rechnung mit EINEM Einkauf verrechnen — in der Transaktion des Aufrufers (`settleBalanceInHouse`; Primary über
 * `runOnPrimary`, PC2 über `customers.settle_balance` in `runRemoteCommand`). Alles geprüft gegen den frischen Stand.
 */
export function createPurchaseOffsetInHouse(input: PurchaseOffsetInput, ctx: OffsetCtx, link?: OffsetSettlementLink): PurchaseOffsetCreated {
  assertInvoiceHouse(ctx.branchId);
  const amountF = F(input.amount);
  if (typeof input.amount !== 'number' || !Number.isFinite(input.amount) || amountF <= 0 || Math.abs(input.amount * 1000 - amountF) > 1e-6) {
    throw nein('OFFSET_AMOUNT_INVALID', 'the amount must be above 0 with at most 3 decimals');
  }
  // ── Rechnung: in dieser Filiale, offen.
  const inv = query('SELECT id, customer_id, status, issued_at, created_at FROM invoices WHERE id = ? AND branch_id = ?', [input.invoiceId, ctx.branchId])[0];
  if (!inv) throw nein('INVOICE_NOT_FOUND', 'no such invoice in this branch');
  if (OFFSET_CLOSED_INVOICE.includes(String(inv.status))) throw nein('OFFSET_INVOICE_NOT_OPEN', `this invoice is ${String(inv.status).toLowerCase()}`);
  // ── Einkauf: in dieser Filiale, nicht storniert, Lieferant AUSDRÜCKLICH mit dem Kunden verknüpft, AP gebucht.
  const p = query(
    `SELECT p.id, p.purchase_number, p.purchase_date, p.created_at, p.status, p.supplier_id, s.linked_customer_id, s.branch_id AS s_branch
       FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = ? AND p.branch_id = ?`,
    [input.purchaseId, ctx.branchId],
  )[0];
  if (!p) throw nein(OFFSET_PURCHASE_NOT_FOUND, 'no such purchase in this branch');
  if (['CANCELLED', 'DRAFT'].includes(String(p.status))) throw nein(OFFSET_PURCHASE_NOT_OPEN, `this purchase is ${String(p.status).toLowerCase()}`);
  if (!p.linked_customer_id || String(p.linked_customer_id) !== String(inv.customer_id) || String(p.s_branch) !== ctx.branchId) {
    throw nein(OFFSET_SUPPLIER_NOT_LINKED, 'the supplier of this purchase is not linked to the client of the invoice — link the supplier role first');
  }
  if (!hasLedgerEntries('PURCHASE', input.purchaseId)) {
    throw nein(OFFSET_PURCHASE_NOT_BOOKED, 'this purchase has no live accounting entry (no payable to offset)');
  }
  // ── Beträge beider Seiten, frisch, in Fils — nach der EINEN Regel.
  const invOpenF = invoiceOpenFils(input.invoiceId);
  const purOpenF = purchaseSettlementOf(input.purchaseId).openF;
  if (invOpenF <= 5) throw nein('OFFSET_INVOICE_NOT_OPEN', 'nothing is open on this invoice');
  if (purOpenF <= 5) throw nein(OFFSET_PURCHASE_NOT_OPEN, 'nothing is open on this purchase');
  if (amountF > invOpenF) throw nein('OFFSET_EXCEEDS_INVOICE', `at most ${B(invOpenF).toFixed(3)} is open on the invoice`);
  if (amountF > purOpenF) throw nein(OFFSET_EXCEEDS_PURCHASE, `at most ${B(purOpenF).toFixed(3)} is open on the purchase`);
  // ── Tag: gültig, nicht in der Zukunft, nicht vor Rechnung, Einkauf oder Eröffnungsstichtag.
  const tag = input.offsetDate ?? todayLocal();
  const issue = businessDateIssue(tag, 'Offset date');
  if (issue || typeof tag !== 'string') throw nein('OFFSET_DATE_INVALID', issue || 'the offset date is not valid');
  const rechnungstag = String(inv.issued_at || inv.created_at || '').slice(0, 10);
  const einkaufstag = String(p.purchase_date || p.created_at || '').slice(0, 10);
  const frueheste = [rechnungstag, einkaufstag, OPENING_CUTOFF_DATE].filter(Boolean).sort().pop() as string;
  if (tag < frueheste) throw nein('OFFSET_DATE_TOO_EARLY', `the offset date must be on or after ${frueheste} (invoice, purchase and opening cutoff)`);

  let userId = ctx.userId ?? '';
  if (!userId) { try { userId = currentUserId(); } catch { userId = ''; } }
  const supplierId = String(p.supplier_id);
  const purchaseNumber = String(p.purchase_number ?? '') || String(p.id).slice(0, 8);
  const consignment = isConsignmentPurchase(input.purchaseId);
  const createdAt = new Date().toISOString();
  const receivedAt = businessTimestamp(tag, createdAt);
  const offsetNumber = link ? `${link.settlementNumber}/${link.line}` : getNextDocumentNumber('STL');

  // ── 1. Die Rechnungszahlung über den vorhandenen Weg — Soll AP (Gegenpartei Lieferant) / Haben AR (Kunde).
  useInvoiceStore.getState().loadInvoices();
  const paymentId = uuid();
  useInvoiceStore.getState().recordPayment(
    input.invoiceId, B(amountF), INVOICE_PURCHASE_OFFSET_METHOD,
    `Offset ${offsetNumber} · ${consignment ? 'consignment purchase' : 'purchase'} ${purchaseNumber} · no cash`,
    input.specialMarkOnFinal, undefined, paymentId, false, { receivedAt, createdAt, apSupplierId: supplierId },
  );
  if (!hasLedgerEntries('PAYMENT', paymentId)) throw new OffsetRestoreError('OFFSET_NOT_BOOKED', 'the offset could not be booked — nothing was offset');
  const after = query('SELECT invoice_number, status, special_mark, number_finalized_at FROM invoices WHERE id = ?', [input.invoiceId])[0];
  const invoiceLabel = formatInvoiceDisplayShort({
    invoiceNumber: String(after?.invoice_number ?? ''), status: String(after?.status ?? ''), specialMark: Number(after?.special_mark) === 1,
    numberFinalizedAt: (after?.number_finalized_at as string | null) || null,
  }) || String(after?.invoice_number ?? '');

  // ── 2. Die Zeile am Einkauf — OHNE eigene Buchung (sie steht an der Rechnungszahlung); paid_amount bleibt Geld.
  const db = getDatabase();
  const purchasePaymentId = uuid();
  db.run(
    `INSERT INTO purchase_payments (id, purchase_id, amount, method, paid_at, reference, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [purchasePaymentId, input.purchaseId, B(amountF), PURCHASE_OFFSET_METHOD, tag, offsetNumber, `Offset ${offsetNumber} · invoice ${invoiceLabel} · no cash`, createdAt],
  );
  trackInsert('purchase_payments', purchasePaymentId, { purchaseId: input.purchaseId, amount: B(amountF), method: PURCHASE_OFFSET_METHOD, reference: offsetNumber });
  const st = refreshPurchaseSettlementRow(input.purchaseId, createdAt);

  // ── 3. Die Verbindung beider Zeilen — dauerhaft, nummeriert.
  const offsetId = uuid();
  db.run(
    `INSERT INTO party_offsets (id, branch_id, offset_number, customer_id, receivable_type, receivable_id, receivable_payment_id,
       payable_type, payable_id, payable_payment_id, amount, offset_date, status, note, created_at, created_by, settlement_number)
     VALUES (?, ?, ?, ?, 'INVOICE', ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', NULL, ?, ?, ?)`,
    [offsetId, ctx.branchId, offsetNumber, String(inv.customer_id), input.invoiceId, paymentId, OFFSET_PAYABLE_PURCHASE, input.purchaseId,
      purchasePaymentId, B(amountF), tag, createdAt, userId || null, link?.settlementNumber ?? null],
  );
  trackInsert('party_offsets', offsetId, { offsetNumber, invoiceId: input.invoiceId, purchaseId: input.purchaseId, amount: B(amountF) });
  logAuditOrThrow({
    module: 'Finance', entityType: 'party_offsets', entityId: offsetId, action: 'CREATE',
    newValue: {
      offsetNumber, settlementNumber: link?.settlementNumber ?? null, customerId: inv.customer_id, invoiceId: input.invoiceId,
      invoiceNumber: invoiceLabel, paymentId, purchaseId: input.purchaseId, purchaseNumber, purchasePaymentId, supplierId, consignment,
      amount: B(amountF), offsetDate: tag, purchaseOpenAfter: st.remainingAmount, purchaseStatusAfter: st.status,
      booking: 'DR ACCOUNTS_PAYABLE (supplier) / CR ACCOUNTS_RECEIVABLE (customer)', noCash: true,
    },
    actor: { userId: userId || undefined, branchId: ctx.branchId },
  });

  return {
    offsetId, offsetNumber, invoiceId: input.invoiceId, invoiceNumber: invoiceLabel, invoiceStatus: String(after?.status ?? ''),
    invoiceOpen: B(Math.max(0, invoiceOpenFils(input.invoiceId))), paymentId, purchaseId: input.purchaseId, purchaseNumber,
    purchasePaymentId, purchaseOpen: st.remainingAmount, purchaseStatus: st.status, supplierId, consignment, amount: B(amountF), offsetDate: tag,
  };
}
