// ════════════════════════════════════════════════════════════════════════════
// v0.8.101 S4 — Verrechnung einer offenen Verkaufsrechnung mit einem AUSZAHLBAREN Partnerguthaben derselben Person
// (Owner-Freigabe 11.11.2026: „LATAIF schuldet dem Partner").
//
// Wer: nur ein Partner, der AUSDRÜCKLICH mit dem Kunden der Rechnung verknüpft ist (`partners.linked_customer_id`,
// „Link to client"), dieselbe Filiale. Kein Abgleich über Name oder Telefon.
// Was: nur, was „Pay out" an DIESEM Artikel jetzt erlauben würde — offener Saldo > 0, keine Sperre (Nachabrechnung,
// Rückkehr nach Übernahme, Lieferantengutschrift). NIE: Kapitalanteil am unverkauften Artikel, noch nicht abgerechneter
// Gewinn, ein Kostenanteil, den der Partner schuldet, Gesellschafterkapital (`partner_transactions`, PARTNER_EQUITY).
//
// Buchung — EINE, an der Rechnungszahlung (Zahlart 'partner_offset', vorhandener Weg `invoiceStore.recordPayment`):
//   Soll PARTNER_ITEM_BALANCE  Gegenpartei PARTNER  (LATAIFs Schuld gegenüber dem Partner sinkt)
//   Haben ACCOUNTS_RECEIVABLE  Gegenpartei KUNDE    (die Forderung an den Kunden sinkt)
// Kein Geldkonto, keine Kartengebühr, kein Steuertatbestand. Status, Endnummer, VAT-Periodensperre und Exportmonat der
// Rechnung folgen der Regel jeder Zahlung.
// Am Partnerartikel: eine Auszahlung (PAYOUT, Methode 'offset', Bezug Rechnung) OHNE eigene Buchung.
// `party_offsets` (payable_type 'PARTNER_ITEM', payable_id = Einkaufszeile, payable_payment_id = Auszahlung) verbindet beide.
//
// Aufheben: nur über die Rechnungszahlung (`deletePayment` → `restorePartnerOffsetForPayment`): Gegenbuchung, die
// Auszahlung per Verrechnung wird storniert (cancelled_at), das Guthaben ist wieder auszahlbar, Verrechnung REVERSED.
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
import { PartnerItemRejected } from '@/core/partners/item-participation';
import { partnerPayableNow, recordOffsetPayoutInHouse } from '@/core/partners/item-participation-house';
import { INVOICE_PARTNER_OFFSET_METHOD, OFFSET_PAYABLE_PARTNER_ITEM, OffsetRestoreError } from './party-offset-restore';
import { invoiceOpenFils, OFFSET_CLOSED_INVOICE } from './party-offset-reads';
import type { OffsetCtx, OffsetSettlementLink } from './party-offsets';

export const OFFSET_PARTNER_NOT_LINKED = 'OFFSET_PARTNER_NOT_LINKED';
export const OFFSET_PARTNER_NOT_PAYABLE = 'OFFSET_PARTNER_NOT_PAYABLE';
export const OFFSET_EXCEEDS_PARTNER = 'OFFSET_EXCEEDS_PARTNER';

const F = (n: unknown): number => Math.round((Number(n) || 0) * 1000);
const B = (f: number): number => f / 1000;
const nein = (code: string, msg: string): InvoiceActionRejected => new InvoiceActionRejected(code, `${msg} — nothing was offset`);
const todayLocal = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export interface PartnerOffsetInput {
  invoiceId: string;
  /** Die Einkaufszeile des gemeinsam gekauften Artikels (der Partner folgt aus der Verknüpfung mit dem Kunden). */
  purchaseLineId: string;
  amount: number;
  offsetDate?: string;
  specialMarkOnFinal?: boolean;
}
export interface PartnerOffsetCreated {
  offsetId: string; offsetNumber: string; invoiceId: string; invoiceNumber: string; paymentId: string;
  partnerId: string; purchaseLineId: string; purchaseNumber: string; movementId: string; partnerOpenAfter: number; amount: number; offsetDate: string;
}

/** Der Partner, der AUSDRÜCKLICH mit diesem Kunden verknüpft ist (höchstens einer je Kunde), in dieser Filiale. */
export function linkedPartnerOf(customerId: string, branchId: string): { id: string; name: string } | null {
  const r = query('SELECT id, name FROM partners WHERE linked_customer_id = ? AND branch_id = ?', [customerId, branchId])[0];
  return r ? { id: String(r.id), name: String(r.name ?? '') } : null;
}

/**
 * Eine Rechnung mit EINEM Partnerguthaben verrechnen — in der Transaktion des Aufrufers (`settleBalanceInHouse`; Primary
 * über `runOnPrimary`, PC2 über `customers.settle_balance` in `runRemoteCommand`). Alles geprüft gegen den frischen Stand.
 */
export function createPartnerOffsetInHouse(input: PartnerOffsetInput, ctx: OffsetCtx, link?: OffsetSettlementLink): PartnerOffsetCreated {
  assertInvoiceHouse(ctx.branchId);
  const amountF = F(input.amount);
  if (typeof input.amount !== 'number' || !Number.isFinite(input.amount) || amountF <= 0 || Math.abs(input.amount * 1000 - amountF) > 1e-6) {
    throw nein('OFFSET_AMOUNT_INVALID', 'the amount must be above 0 with at most 3 decimals');
  }
  // ── Rechnung: in dieser Filiale, offen.
  const inv = query('SELECT id, customer_id, status, issued_at, created_at FROM invoices WHERE id = ? AND branch_id = ?', [input.invoiceId, ctx.branchId])[0];
  if (!inv) throw nein('INVOICE_NOT_FOUND', 'no such invoice in this branch');
  if (OFFSET_CLOSED_INVOICE.includes(String(inv.status))) throw nein('OFFSET_INVOICE_NOT_OPEN', `this invoice is ${String(inv.status).toLowerCase()}`);
  // ── Partner: ausdrücklich mit dem Kunden der Rechnung verknüpft, dieselbe Filiale.
  const partner = linkedPartnerOf(String(inv.customer_id), ctx.branchId);
  if (!partner) throw nein(OFFSET_PARTNER_NOT_LINKED, 'no partner is linked to the client of this invoice — link the partner to the client first');
  const pl = query(
    `SELECT pl.id, p.purchase_number, p.purchase_date, p.created_at FROM purchase_lines pl JOIN purchases p ON p.id = pl.purchase_id
      WHERE pl.id = ? AND p.branch_id = ?`,
    [input.purchaseLineId, ctx.branchId],
  )[0];
  if (!pl) throw nein(OFFSET_PARTNER_NOT_PAYABLE, 'no such jointly bought item in this branch');
  // ── Beträge beider Seiten, frisch, in Fils — „Pay out" erlaubt genau das.
  let partnerOpenF = 0;
  try {
    const st = partnerPayableNow(input.purchaseLineId, partner.id, ctx.branchId);
    if (st.blocker) throw nein(OFFSET_PARTNER_NOT_PAYABLE, `this partner balance cannot be paid out now (${st.blocker.message})`);
    partnerOpenF = st.openF;
  } catch (e) {
    if (e instanceof PartnerItemRejected) throw nein(OFFSET_PARTNER_NOT_PAYABLE, e.message);
    throw e;
  }
  const invOpenF = invoiceOpenFils(input.invoiceId);
  if (invOpenF <= 5) throw nein('OFFSET_INVOICE_NOT_OPEN', 'nothing is open on this invoice');
  if (partnerOpenF <= 5) throw nein(OFFSET_PARTNER_NOT_PAYABLE, 'LATAIF owes this partner nothing on this item');
  if (amountF > invOpenF) throw nein('OFFSET_EXCEEDS_INVOICE', `at most ${B(invOpenF).toFixed(3)} is open on the invoice`);
  if (amountF > partnerOpenF) throw nein(OFFSET_EXCEEDS_PARTNER, `at most ${B(partnerOpenF).toFixed(3)} can be paid out to the partner on this item`);
  // ── Tag: gültig, nicht in der Zukunft, nicht vor Rechnung, Einkauf oder Eröffnungsstichtag.
  const tag = input.offsetDate ?? todayLocal();
  const issue = businessDateIssue(tag, 'Offset date');
  if (issue || typeof tag !== 'string') throw nein('OFFSET_DATE_INVALID', issue || 'the offset date is not valid');
  const rechnungstag = String(inv.issued_at || inv.created_at || '').slice(0, 10);
  const einkaufstag = String(pl.purchase_date || pl.created_at || '').slice(0, 10);
  const frueheste = [rechnungstag, einkaufstag, OPENING_CUTOFF_DATE].filter(Boolean).sort().pop() as string;
  if (tag < frueheste) throw nein('OFFSET_DATE_TOO_EARLY', `the offset date must be on or after ${frueheste} (invoice, purchase and opening cutoff)`);

  let userId = ctx.userId ?? '';
  if (!userId) { try { userId = currentUserId(); } catch { userId = ''; } }
  const purchaseNumber = String(pl.purchase_number ?? '') || String(pl.id).slice(0, 8);
  const createdAt = new Date().toISOString();
  const receivedAt = businessTimestamp(tag, createdAt);
  const offsetNumber = link ? `${link.settlementNumber}/${link.line}` : getNextDocumentNumber('STL');

  // ── 1. Die Rechnungszahlung über den vorhandenen Weg — Soll PARTNER_ITEM_BALANCE (Partner) / Haben AR (Kunde).
  useInvoiceStore.getState().loadInvoices();
  const paymentId = uuid();
  useInvoiceStore.getState().recordPayment(
    input.invoiceId, B(amountF), INVOICE_PARTNER_OFFSET_METHOD,
    `Offset ${offsetNumber} · partner balance ${partner.name} · item ${purchaseNumber} · no cash`,
    input.specialMarkOnFinal, undefined, paymentId, false, { receivedAt, createdAt, partnerId: partner.id },
  );
  if (!hasLedgerEntries('PAYMENT', paymentId)) throw new OffsetRestoreError('OFFSET_NOT_BOOKED', 'the offset could not be booked — nothing was offset');
  const after = query('SELECT invoice_number, status, special_mark, number_finalized_at FROM invoices WHERE id = ?', [input.invoiceId])[0];
  const invoiceLabel = formatInvoiceDisplayShort({
    invoiceNumber: String(after?.invoice_number ?? ''), status: String(after?.status ?? ''), specialMark: Number(after?.special_mark) === 1,
    numberFinalizedAt: (after?.number_finalized_at as string | null) || null,
  }) || String(after?.invoice_number ?? '');

  // ── 2. Die Auszahlung per Verrechnung am Partnerartikel — OHNE eigene Buchung (sie steht an der Rechnungszahlung).
  let movementId = '';
  let openAfterF = 0;
  try {
    const r = recordOffsetPayoutInHouse({
      purchaseLineId: input.purchaseLineId, partnerId: partner.id, amountF, date: tag, invoiceId: input.invoiceId, offsetNumber, invoiceLabel,
    }, { branchId: ctx.branchId, userId, now: createdAt });
    movementId = r.movementId;
    openAfterF = r.openAfterF;
  } catch (e) {
    if (e instanceof PartnerItemRejected) throw nein(OFFSET_PARTNER_NOT_PAYABLE, e.message);
    throw e;
  }

  // ── 3. Die Verbindung beider Zeilen — dauerhaft, nummeriert.
  const db = getDatabase();
  const offsetId = uuid();
  db.run(
    `INSERT INTO party_offsets (id, branch_id, offset_number, customer_id, receivable_type, receivable_id, receivable_payment_id,
       payable_type, payable_id, payable_payment_id, amount, offset_date, status, note, created_at, created_by, settlement_number)
     VALUES (?, ?, ?, ?, 'INVOICE', ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', NULL, ?, ?, ?)`,
    [offsetId, ctx.branchId, offsetNumber, String(inv.customer_id), input.invoiceId, paymentId, OFFSET_PAYABLE_PARTNER_ITEM, input.purchaseLineId,
      movementId, B(amountF), tag, createdAt, userId || null, link?.settlementNumber ?? null],
  );
  trackInsert('party_offsets', offsetId, { offsetNumber, invoiceId: input.invoiceId, purchaseLineId: input.purchaseLineId, amount: B(amountF) });
  logAuditOrThrow({
    module: 'Finance', entityType: 'party_offsets', entityId: offsetId, action: 'CREATE',
    newValue: {
      offsetNumber, settlementNumber: link?.settlementNumber ?? null, customerId: inv.customer_id, invoiceId: input.invoiceId,
      invoiceNumber: invoiceLabel, paymentId, partnerId: partner.id, purchaseLineId: input.purchaseLineId, purchaseNumber, movementId,
      amount: B(amountF), offsetDate: tag, partnerOpenAfter: B(openAfterF),
      booking: 'DR PARTNER_ITEM_BALANCE (partner) / CR ACCOUNTS_RECEIVABLE (customer)', noCash: true,
    },
    actor: { userId: userId || undefined, branchId: ctx.branchId },
  });
  return {
    offsetId, offsetNumber, invoiceId: input.invoiceId, invoiceNumber: invoiceLabel, paymentId, partnerId: partner.id,
    purchaseLineId: input.purchaseLineId, purchaseNumber, movementId, partnerOpenAfter: B(openAfterF), amount: B(amountF), offsetDate: tag,
  };
}
