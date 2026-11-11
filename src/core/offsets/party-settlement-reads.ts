// ════════════════════════════════════════════════════════════════════════════
// CUSTOMER ACCOUNT C — „Settle Balance" im Kundenkonto: was LESEN und VORSCHLAGEN darf (Maske am Primary, PC2 über
// `parties.account.get` mit view = 'customer_account', und die Hausfolge selbst). Nur Datenbank und reine Rechnung — keine
// Speicher, kein Primary-Anschluss (Lesebefehle laden es ohne Kreis).
//
// Freigegeben (Owner 09.11.2026) sind ZWEI Arten von Gegenposten, in dieser Reihenfolge (V7):
//   1. Store Credit — nur der freie Teil eines OPEN-Guthabens dieses Kunden in dieser Filiale (Betrag − verwendet);
//   2. We Borrowed  — ein offenes Darlehen, AUSDRÜCKLICH diesem Kunden zugeordnet (wie B1).
// (B2/B3: 3. Einkäufe der ausdrücklich verknüpften Lieferantenrolle, normal und Kommission.)
// (v0.8.101 S4: 4. auszahlbare Partnerguthaben des ausdrücklich verknüpften Partners — nur was „Pay out" erlaubt.)
// Innerhalb jeder Gruppe das älteste zuerst; links die offenen Rechnungen, älteste zuerst. Was der Partner LATAIF schuldet,
// Gesellschafterkapital, Order-Anzahlungen, Eröffnungsposten und Gold werden hier NIE angeboten.
//
// Der Vorschlag paart der Reihe nach (FIFO): jede gewählte Rechnung mit den gewählten Gegenposten, bis eine Seite leer ist —
// je Zuordnung der kleinere Rest oder ein von Hand gesetzter Betrag („Change amount", nie über der Obergrenze). Dieselbe
// Funktion rechnet die Vorschau der Maske und — gegen den frischen Stand — die Buchung im Haus.
// ════════════════════════════════════════════════════════════════════════════
import { query } from '@/core/db/helpers';
import { paidFilsOfDebt } from '@/core/finance/debt-status';
import { openItemsStamp } from '@/core/finance/open-items-stamp';
import { formatInvoiceDisplayShort } from '@/core/utils/invoiceNumber';
import { isDebtClosed, storeCreditLabel } from './party-offset-reads';
import { partnerItemsOverview } from '@/core/partners/item-participation-house';
import { partnerOpenRows } from '@/core/partners/partner-open-balances';

export const OP_CUSTOMERS_SETTLE_BALANCE = 'customers.settle_balance';
export const OP_CUSTOMERS_SETTLEMENT_REVERSE = 'customers.settlement_reverse';

/** Unter 5 Fils ist nichts offen — dieselbe Schwelle wie Receivables / „Receive Payment". */
const OPEN_EPS_F = 5;
const F = (n: unknown): number => Math.round((Number(n) || 0) * 1000);
const B = (f: number): number => f / 1000;
const day = (v: unknown): string => String(v ?? '').slice(0, 10);

// B2/B3 (Owner 10.11.2026) — dritte Gruppe: offene Einkäufe (normal und Kommission) der AUSDRÜCKLICH verknüpften Lieferantenrolle.
// v0.8.101 S4 (Owner 11.11.2026) — vierte Gruppe: auszahlbare Partnerguthaben des AUSDRÜCKLICH verknüpften Partners.
export type SettleSourceKind = 'STORE_CREDIT' | 'LOAN_BORROWED' | 'PURCHASE' | 'PARTNER_ITEM';
/** Reihenfolge der Gruppen (V7, nur die freigegebenen). */
export const SETTLE_SOURCE_ORDER: readonly SettleSourceKind[] = ['STORE_CREDIT', 'LOAN_BORROWED', 'PURCHASE', 'PARTNER_ITEM'];
export const SETTLE_SOURCE_LABEL: Record<SettleSourceKind, string> = { STORE_CREDIT: 'Store credit', LOAN_BORROWED: 'We Borrowed', PURCHASE: 'Purchases', PARTNER_ITEM: 'Partner balances' };

export interface SettleInvoice {
  /** v0.8.101 S5 — 'PARTNER_ITEM': eine GEBUCHTE Partnerforderung (id = Einkaufszeile) statt einer Rechnung. Fehlt: Rechnung. */
  kind?: 'INVOICE' | 'PARTNER_ITEM';
  partnerName?: string;
  productLabel?: string;
  id: string; number: string; date: string;
  total: number; paid: number; open: number;
  /** Die Endnummer steht schon fest (eine frühere Vollzahlung) — keine Wahl mehr. */
  finalized: boolean;
  revision: number;
}
export interface SettleSource {
  kind: SettleSourceKind; id: string; number: string; date: string; label: string;
  total: number; open: number; revision: number;
  /** B2/B3 — nur bei Einkäufen: ein Kommissions-Einkauf (Kopf oder Zeile verweist auf eine Kommission). */
  consignment?: boolean;
  /** v0.8.101 S4 — nur bei Partnerguthaben: der verknüpfte Partner und der Artikel. */
  partnerId?: string;
  partnerName?: string;
  productLabel?: string;
}
export interface SettlePair { invoiceId: string; sourceKind: SettleSourceKind; sourceId: string; amountF: number }
/**
 * B2/B3 Nachbesserung (Owner 10.11.2026) — eine Zeile des Vorschlags MIT ihrer Obergrenze: `maxF` = was an dieser Stelle
 * höchstens geht (kleinerer Rest von Rechnung und Gegenposten, nachdem die früheren Zeilen gerechnet sind). `edited`:
 * der Betrag ist von Hand gesetzt (`amountF` = der gesetzte Betrag; 0 = diese Zuordnung bleibt aus).
 */
export interface SettlePlanRow extends SettlePair { maxF: number; edited: boolean }
/** Schlüssel einer Zuordnung (Gegenposten → Rechnung) für einen von Hand gesetzten Betrag. */
export const settlePairKey = (sourceId: string, invoiceId: string): string => `${sourceId}>${invoiceId}`;
/** Ein von Hand gesetzter Betrag je Zuordnung (Fils). Fehlt er: der Vorschlag (kleinerer Rest). */
export type SettleAmountsF = Readonly<Record<string, number>>;

export interface SettlementLine {
  offsetId: string; offsetNumber: string; status: string; amount: number; offsetDate: string;
  invoiceId: string; invoiceNumber: string; invoicePaymentId: string;
  sourceKind: SettleSourceKind; sourceId: string; sourceNumber: string;
  /** v0.8.101 S4 — nur bei Partnerguthaben: der Partner (für den Link in den Partnerartikel). */
  partnerId?: string;
  /** v0.8.101 S5 — die linke Seite: eine Rechnung oder eine gebuchte Partnerforderung (dann invoiceId = Einkaufszeile). */
  receivableKind: 'INVOICE' | 'PARTNER_ITEM';
  receivablePartnerId?: string;
  reversedAt: string | null; reverseReason: string | null;
}
export interface SettlementView {
  /** Die gemeinsame Nummer (STL-…); eine Einzelverrechnung (B1) steht mit ihrer eigenen Nummer da. */
  number: string; single: boolean; date: string;
  status: 'ACTIVE' | 'PARTIAL' | 'REVERSED';
  total: number; activeTotal: number; activeLines: number;
  lines: SettlementLine[];
}
export interface SettleBalanceRead {
  customerId: string;
  invoices: SettleInvoice[];
  sources: SettleSource[];
  /** Fingerabdruck aller angebotenen offenen Posten beider Seiten — die Maske schickt ihn mit der Bestätigung zurück. */
  stamp: string;
  settlements: SettlementView[];
}

const invNo = (r: Record<string, unknown>): string => formatInvoiceDisplayShort({
  invoiceNumber: String(r.invoice_number ?? ''), status: String(r.status ?? ''), specialMark: Number(r.special_mark) === 1,
  numberFinalizedAt: (r.number_finalized_at as string | null) || null,
}) || String(r.invoice_number ?? '');

/** Die offenen Rechnungen eines Kunden in DIESER Filiale, älteste zuerst — dieselbe Regel wie „Receive Payment". */
export function settleInvoicesOf(customerId: string, branchId: string): SettleInvoice[] {
  return query(
    `SELECT i.id, i.invoice_number, i.status, i.special_mark, i.number_finalized_at, i.revision,
            COALESCE(i.issued_at, i.created_at) AS d, i.created_at, i.gross_amount, i.paid_amount,
            COALESCE((SELECT SUM(receivable_cancel_amount) FROM credit_notes WHERE invoice_id = i.id AND status != 'CANCELLED'), 0) AS cn
       FROM invoices i
      WHERE i.customer_id = ? AND i.branch_id = ? AND i.status NOT IN ('CANCELLED', 'DRAFT', 'RETURNED')
      ORDER BY d, i.created_at, i.invoice_number`,
    [customerId, branchId],
  ).map((r) => ({ r, openF: F(r.gross_amount) - F(r.paid_amount) - F(r.cn) }))
    .filter((x) => x.openF > OPEN_EPS_F)
    .map(({ r, openF }) => ({
      id: String(r.id), number: invNo(r), date: day(r.d),
      total: B(F(r.gross_amount)), paid: B(F(r.paid_amount)), open: B(openF),
      finalized: !!r.number_finalized_at, revision: Number(r.revision ?? 0),
    }));
}

/**
 * v0.8.101 S5 (Owner E3) — GEBUCHTE Forderungen an den Partner, der AUSDRÜCKLICH mit diesem Kunden verknüpft ist (je Artikel):
 * nur der Teil eines negativen Saldos aus Bewegungen (Soll auf PARTNER_ITEM_BALANCE, z. B. Rückforderung nach Abrechnung), nie
 * ein nur berechneter Kostenanteil; nicht, solange Nachabrechnung, Lieferantengutschrift oder Reparatur offen sind. Älteste zuerst.
 */
export function settlePartnerReceivablesOf(customerId: string, branchId: string): SettleInvoice[] {
  const partner = query('SELECT id FROM partners WHERE linked_customer_id = ? AND branch_id = ?', [customerId, branchId])[0];
  if (!partner) return [];
  const out: SettleInvoice[] = [];
  for (const p of partnerItemsOverview(branchId, String(partner.id))) {
    for (const it of p.items) {
      if (it.correctionPending || it.refundPending || it.repairPending) continue;
      const openF = F(it.open);
      const receivableF = Math.min(Math.max(0, -openF), Math.max(0, -(openF + F(it.owedCost))));
      if (receivableF <= OPEN_EPS_F) continue;
      const letzte = [...it.movements].reverse().find((m) => !m.cancelled)?.occurredAt || it.purchaseDate;
      out.push({
        kind: 'PARTNER_ITEM', id: it.purchaseLineId, number: it.purchaseNumber || it.purchaseLineId.slice(0, 8), date: day(letzte),
        total: B(receivableF), paid: 0, open: B(receivableF), finalized: true, revision: 0, partnerName: p.name, productLabel: it.productLabel,
      });
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.number.localeCompare(b.number)));
}

/** Freie Store-Guthaben (OPEN, Betrag − verwendet), älteste zuerst. Ein Eröffnungsguthaben wird nicht angeboten. */
export function settleCreditsOf(customerId: string, branchId: string): SettleSource[] {
  return query(
    `SELECT cc.id, cc.source_type, cc.amount, cc.used_amount, cc.created_at,
            cn.credit_note_number, i.invoice_number, i.status, i.special_mark, i.number_finalized_at
       FROM customer_credits cc
       LEFT JOIN credit_notes cn ON cn.id = cc.source_id AND cc.source_type = 'sales_return'
       LEFT JOIN invoices i ON i.id = cc.source_id
      WHERE cc.customer_id = ? AND cc.branch_id = ? AND cc.status = 'OPEN' AND COALESCE(cc.source_type, '') != 'opening'
      ORDER BY cc.created_at, cc.id`,
    [customerId, branchId],
  ).map((r) => ({ r, openF: F(r.amount) - F(r.used_amount) }))
    .filter((x) => x.openF > OPEN_EPS_F)
    .map(({ r, openF }) => ({
      kind: 'STORE_CREDIT' as const, id: String(r.id),
      number: String(r.credit_note_number ?? '') || (r.invoice_number ? invNo(r) : 'Store credit'),
      // Die Herkunft (z. B. „overpayment", „from a return") — „Store credit" steht schon als Gruppe bzw. Nummer da.
      date: day(r.created_at), label: storeCreditLabel(r.source_type).replace(/^store credit(?: · )?/, '') || 'store credit',
      total: B(F(r.amount)), open: B(openF), revision: 0,
    }));
}

/** Offene Darlehen „We Borrowed", ausdrücklich diesem Kunden zugeordnet, älteste zuerst — dieselbe Regel wie B1. */
export function settleLoansOf(customerId: string, branchId: string): SettleSource[] {
  return query(
    `SELECT id, loan_number, amount, status, created_at, revision, counterparty FROM debts
      WHERE branch_id = ? AND customer_id = ? AND direction IN ('we_borrow', 'MONEY_RECEIVED')
      ORDER BY created_at, loan_number`,
    [branchId, customerId],
  ).filter((d) => !isDebtClosed(d.status))
    .map((d) => ({ d, openF: F(d.amount) - paidFilsOfDebt(String(d.id)) }))
    .filter((x) => x.openF > OPEN_EPS_F)
    .map(({ d, openF }) => ({
      kind: 'LOAN_BORROWED' as const, id: String(d.id), number: String(d.loan_number ?? '') || String(d.id).slice(0, 8),
      date: day(d.created_at), label: 'We Borrowed', total: B(F(d.amount)), open: B(openF), revision: Number(d.revision ?? 1),
    }));
}

/**
 * B2/B3 — offene Einkäufe der Lieferantenrolle, die AUSDRÜCKLICH mit diesem Kunden verknüpft ist (`linked_customer_id`),
 * dieselbe Filiale, älteste zuerst; normal und Kommission (gekennzeichnet). Offen nach der EINEN Regel (`purchase-settled`):
 * Summe − Geld − Lieferantenguthaben − wirksame Verrechnungen. Nur mit lebender Einkaufsbuchung (die AP steht im Hauptbuch).
 */
export function settlePurchasesOf(customerId: string, branchId: string): SettleSource[] {
  return query(
    `SELECT p.id, p.purchase_number, p.purchase_date, p.created_at, p.total_amount, p.paid_amount, p.revision,
            (p.source_consignment_id IS NOT NULL OR EXISTS (SELECT 1 FROM purchase_lines pl WHERE pl.purchase_id = p.id
               AND pl.source_consignment_id IS NOT NULL)) AS cons,
            COALESCE((SELECT SUM(pp.amount) FROM purchase_payments pp WHERE pp.purchase_id = p.id AND pp.method IN ('credit', 'offset')
               AND pp.voided_at IS NULL), 0) AS non_cash
       FROM purchases p JOIN suppliers s ON s.id = p.supplier_id
      WHERE s.linked_customer_id = ? AND s.branch_id = ? AND p.branch_id = ? AND p.status NOT IN ('CANCELLED', 'DRAFT')
        AND EXISTS (SELECT 1 FROM ledger_entries le WHERE le.source_module = 'PURCHASE' AND le.source_id = p.id AND le.reverses_entry_id IS NULL
                      AND NOT EXISTS (SELECT 1 FROM ledger_entries r WHERE r.reverses_entry_id = le.id))
      ORDER BY p.purchase_date, p.created_at, p.purchase_number`,
    [customerId, branchId, branchId],
  ).map((r) => ({ r, openF: F(r.total_amount) - F(r.paid_amount) - F(r.non_cash) }))
    .filter((x) => x.openF > OPEN_EPS_F)
    .map(({ r, openF }) => ({
      kind: 'PURCHASE' as const, id: String(r.id), number: String(r.purchase_number ?? '') || String(r.id).slice(0, 8),
      date: day(r.purchase_date || r.created_at), label: Number(r.cons) === 1 ? 'consignment purchase' : 'purchase',
      total: B(F(r.total_amount)), open: B(openF), revision: Number(r.revision ?? 1), consignment: Number(r.cons) === 1,
    }));
}

/**
 * v0.8.101 S4 — auszahlbare Partnerguthaben des Partners, der AUSDRÜCKLICH mit diesem Kunden verknüpft ist, je Artikel —
 * genau was „Pay out" jetzt erlauben würde (offen > 0, keine Sperre), älteste zuerst. Dieselbe Ableitung wie Payables und
 * Kundenkonto (`partnerOpenRows`). Nie: Kostenanteil, Rückforderung, noch nicht abgerechneter Gewinn, Gesellschafterkapital.
 */
export function settlePartnerItemsOf(customerId: string, branchId: string): SettleSource[] {
  const partner = query('SELECT id, name FROM partners WHERE linked_customer_id = ? AND branch_id = ?', [customerId, branchId])[0];
  if (!partner) return [];
  return partnerOpenRows(partnerItemsOverview(branchId, String(partner.id)))
    .filter((r) => r.side === 'PAYABLE' && r.origin === 'PAYOUT' && !r.onHold && F(r.open) > OPEN_EPS_F)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.purchaseNumber.localeCompare(b.purchaseNumber) || a.purchaseLineId.localeCompare(b.purchaseLineId)))
    .map((r) => ({
      kind: 'PARTNER_ITEM' as const, id: r.purchaseLineId, number: r.purchaseNumber || r.purchaseLineId.slice(0, 8),
      date: r.date, label: `partner balance · ${r.productLabel}`, total: r.open, open: r.open, revision: 0,
      partnerId: r.partnerId, partnerName: r.partnerName, productLabel: r.productLabel,
    }));
}

/** Der Fingerabdruck der angebotenen Posten beider Seiten (Art, Kennung, offener Betrag in Fils). */
export function settleStamp(invoices: readonly SettleInvoice[], sources: readonly SettleSource[]): string {
  return openItemsStamp([
    ...invoices.map((i) => ({ kind: i.kind === 'PARTNER_ITEM' ? 'partner-receivable' : 'invoice', id: i.id, openF: F(i.open) })),
    ...sources.map((s) => ({ kind: s.kind === 'STORE_CREDIT' ? 'credit' : s.kind === 'PURCHASE' ? 'purchase' : s.kind === 'PARTNER_ITEM' ? 'partner' : 'debt', id: s.id, openF: F(s.open) })),
  ]);
}

/**
 * Der Vorschlag MIT Obergrenzen: die gewählten Rechnungen (älteste zuerst) gegen die gewählten Gegenposten (Store Credit,
 * We Borrowed, Einkäufe; je älteste zuerst), der Reihe nach (FIFO). Jede Zuordnung nimmt den kleineren Rest beider Seiten —
 * oder den von Hand gesetzten Betrag (`amounts`, nie mehr als die Obergrenze); was dann offen bleibt, geht der Reihe nach
 * an den nächsten Gegenposten. Ohne `amounts` genau der bisherige Vorschlag. Rein rechnend, in Fils. Zeilen mit 0
 * (von Hand ausgeschlossen) bleiben in der Liste, damit die Maske sie zeigen und zurücksetzen kann.
 */
export function planSettlementRows(
  invoices: readonly SettleInvoice[], sources: readonly SettleSource[],
  selected: { invoiceIds: readonly string[]; sourceIds: readonly string[]; amounts?: SettleAmountsF },
): SettlePlanRow[] {
  const invSel = new Set(selected.invoiceIds);
  const srcSel = new Set(selected.sourceIds);
  const iv = invoices.filter((i) => invSel.has(i.id)).map((i) => ({ id: i.id, kind: i.kind ?? 'INVOICE', left: F(i.open) })).filter((x) => x.left > OPEN_EPS_F);
  const sv = SETTLE_SOURCE_ORDER.flatMap((k) => sources.filter((s) => s.kind === k && srcSel.has(s.id)))
    .map((s) => ({ kind: s.kind, id: s.id, left: F(s.open) })).filter((x) => x.left > OPEN_EPS_F);
  const rows: SettlePlanRow[] = [];
  for (const i of iv) {
    for (const q of sv) {
      if (i.left <= OPEN_EPS_F) break;
      if (q.left <= OPEN_EPS_F) continue;
      // v0.8.101 S5 — eine Partnerforderung nur gegen „We Borrowed" und offene Einkäufe derselben Person (nie gegen ein
      // Partnerguthaben — das ist die Verrechnung Artikel↔Artikel im Partnermodul; Store Credit: Owner-Entscheidung offen).
      if (i.kind === 'PARTNER_ITEM' && q.kind !== 'LOAN_BORROWED' && q.kind !== 'PURCHASE') continue;
      const maxF = Math.min(i.left, q.left);
      const hand = selected.amounts?.[settlePairKey(q.id, i.id)];
      const edited = typeof hand === 'number' && Number.isFinite(hand);
      const amountF = edited ? Math.max(0, Math.min(Math.round(hand), maxF)) : maxF;
      rows.push({ invoiceId: i.id, sourceKind: q.kind, sourceId: q.id, amountF, maxF, edited });
      i.left -= amountF; q.left -= amountF;
    }
  }
  return rows;
}

/** Der Vorschlag (nur Zuordnungen mit Betrag) — dieselbe Rechnung für die Vorschau der Maske und die Buchung im Haus. */
export function planSettlement(
  invoices: readonly SettleInvoice[], sources: readonly SettleSource[],
  selected: { invoiceIds: readonly string[]; sourceIds: readonly string[]; amounts?: SettleAmountsF },
): SettlePair[] {
  return planSettlementRows(invoices, sources, selected)
    .filter((r) => r.amountF > 0)
    .map(({ invoiceId, sourceKind, sourceId, amountF }) => ({ invoiceId, sourceKind, sourceId, amountF }));
}

/**
 * Welche Rechnungen dieser Vorschlag VOLL bezahlt — dieselbe Regel wie jede Zahlung (`recordPayment`: bezahlt ≥ Brutto).
 * Nur für sie fragt die Maske die Endnummer (Normal/Special), und nur, wenn sie noch keine hat.
 */
export function finalizingInvoices(invoices: readonly SettleInvoice[], pairs: readonly SettlePair[]): SettleInvoice[] {
  return invoices.filter((i) => {
    if (i.kind === 'PARTNER_ITEM') return false;
    const addF = pairs.filter((p) => p.invoiceId === i.id).reduce((s, p) => s + p.amountF, 0);
    return addF > 0 && F(i.paid) + addF >= F(i.total) - OPEN_EPS_F;
  });
}

/** Alle Verrechnungen dieses Kunden (Settle Balance und Einzelverrechnungen), jüngste zuerst, mit jeder Zuordnung. */
export function settlementsOf(customerId: string, branchId: string): SettlementView[] {
  const rows = query(
    `SELECT o.*, i.invoice_number, i.status AS inv_status, i.special_mark, i.number_finalized_at,
            d.loan_number, cn.credit_note_number, pu.purchase_number, ppu.purchase_number AS partner_purchase_number, ipm.partner_id AS partner_id,
            rpu.purchase_number AS receivable_purchase_number, ripm.partner_id AS receivable_partner_id
       FROM party_offsets o
       LEFT JOIN invoices i ON i.id = o.receivable_id
       LEFT JOIN debts d ON d.id = o.payable_id AND o.payable_type = 'DEBT'
       LEFT JOIN customer_credits cc ON cc.id = o.payable_id AND o.payable_type = 'STORE_CREDIT'
       LEFT JOIN credit_notes cn ON cn.id = cc.source_id AND cc.source_type = 'sales_return'
       LEFT JOIN purchases pu ON pu.id = o.payable_id AND o.payable_type = 'PURCHASE'
       LEFT JOIN purchase_lines ppl ON ppl.id = o.payable_id AND o.payable_type = 'PARTNER_ITEM'
       LEFT JOIN purchases ppu ON ppu.id = ppl.purchase_id
       LEFT JOIN item_partner_movements ipm ON ipm.id = o.payable_payment_id AND o.payable_type = 'PARTNER_ITEM'
       LEFT JOIN purchase_lines rpl ON rpl.id = o.receivable_id AND o.receivable_type = 'PARTNER_ITEM'
       LEFT JOIN purchases rpu ON rpu.id = rpl.purchase_id
       LEFT JOIN item_partner_movements ripm ON ripm.id = o.receivable_payment_id AND o.receivable_type = 'PARTNER_ITEM'
      WHERE o.customer_id = ? AND o.branch_id = ? AND o.receivable_type IN ('INVOICE', 'PARTNER_ITEM')
      ORDER BY o.created_at, o.offset_number`,
    [customerId, branchId],
  );
  const groups = new Map<string, SettlementLine[]>();
  const single = new Map<string, boolean>();
  for (const o of rows) {
    const key = String(o.settlement_number ?? '') || String(o.offset_number);
    single.set(key, !o.settlement_number);
    const credit = String(o.payable_type) === 'STORE_CREDIT';
    const purchase = String(o.payable_type) === 'PURCHASE';
    const partnerItem = String(o.payable_type) === 'PARTNER_ITEM';
    const line: SettlementLine = {
      offsetId: String(o.id), offsetNumber: String(o.offset_number), status: String(o.status), amount: B(F(o.amount)),
      offsetDate: String(o.offset_date ?? ''), invoiceId: String(o.receivable_id),
      invoiceNumber: invNo({ invoice_number: o.invoice_number, status: o.inv_status, special_mark: o.special_mark, number_finalized_at: o.number_finalized_at }),
      invoicePaymentId: String(o.receivable_payment_id),
      sourceKind: credit ? 'STORE_CREDIT' : purchase ? 'PURCHASE' : partnerItem ? 'PARTNER_ITEM' : 'LOAN_BORROWED', sourceId: String(o.payable_id),
      sourceNumber: credit ? (String(o.credit_note_number ?? '') || 'Store credit')
        : purchase ? (String(o.purchase_number ?? '') || String(o.payable_id).slice(0, 8))
          : partnerItem ? (String(o.partner_purchase_number ?? '') || String(o.payable_id).slice(0, 8))
          : (String(o.loan_number ?? '') || String(o.payable_id).slice(0, 8)),
      reversedAt: (o.reversed_at as string | null) ?? null, reverseReason: (o.reverse_reason as string | null) ?? null,
      ...(partnerItem && o.partner_id ? { partnerId: String(o.partner_id) } : {}),
      receivableKind: String(o.receivable_type) === 'PARTNER_ITEM' ? 'PARTNER_ITEM' : 'INVOICE',
      ...(String(o.receivable_type) === 'PARTNER_ITEM' ? {
        invoiceNumber: String(o.receivable_purchase_number ?? '') || String(o.receivable_id).slice(0, 8),
        ...(o.receivable_partner_id ? { receivablePartnerId: String(o.receivable_partner_id) } : {}),
      } : {}),
    };
    groups.set(key, [...(groups.get(key) ?? []), line]);
  }
  return [...groups.entries()].map(([number, lines]) => {
    const active = lines.filter((l) => l.status === 'ACTIVE');
    const totalF = lines.reduce((s, l) => s + F(l.amount), 0);
    return {
      number, single: single.get(number) === true, date: lines[0]?.offsetDate ?? '',
      status: active.length === lines.length ? 'ACTIVE' as const : active.length === 0 ? 'REVERSED' as const : 'PARTIAL' as const,
      total: B(totalF), activeTotal: B(active.reduce((s, l) => s + F(l.amount), 0)), activeLines: active.length, lines,
    };
  }).reverse();
}

/** Was „Settle Balance" zeigt — am Primary lokal, am PC2 als Teil von `parties.account.get` (view customer_account). */
export function settleBalanceFor(ctx: { branchId: string }, customerId: string): SettleBalanceRead {
  const invoices = [...settleInvoicesOf(customerId, ctx.branchId), ...settlePartnerReceivablesOf(customerId, ctx.branchId)];
  const sources = [...settleCreditsOf(customerId, ctx.branchId), ...settleLoansOf(customerId, ctx.branchId), ...settlePurchasesOf(customerId, ctx.branchId),
    ...settlePartnerItemsOf(customerId, ctx.branchId)];
  return { customerId, invoices, sources, stamp: settleStamp(invoices, sources), settlements: settlementsOf(customerId, ctx.branchId) };
}
