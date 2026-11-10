// ════════════════════════════════════════════════════════════════════════════
// CUSTOMER ACCOUNT C — „Settle Balance" im Kundenkonto: was LESEN und VORSCHLAGEN darf (Maske am Primary, PC2 über
// `parties.account.get` mit view = 'customer_account', und die Hausfolge selbst). Nur Datenbank und reine Rechnung — keine
// Speicher, kein Primary-Anschluss (Lesebefehle laden es ohne Kreis).
//
// Freigegeben (Owner 09.11.2026) sind ZWEI Arten von Gegenposten, in dieser Reihenfolge (V7):
//   1. Store Credit — nur der freie Teil eines OPEN-Guthabens dieses Kunden in dieser Filiale (Betrag − verwendet);
//   2. We Borrowed  — ein offenes Darlehen, AUSDRÜCKLICH diesem Kunden zugeordnet (wie B1).
// Innerhalb jeder Gruppe das älteste zuerst; links die offenen Rechnungen, älteste zuerst. Einkäufe, Kommission,
// Partner, Order-Anzahlungen, Eröffnungsposten und Gold werden hier NIE angeboten.
//
// Der Vorschlag paart der Reihe nach (zwei Zeiger): jede gewählte Rechnung mit den gewählten Gegenposten, bis eine Seite
// leer ist. Dieselbe Funktion rechnet die Vorschau der Maske und — gegen den frischen Stand — die Buchung im Haus.
// ════════════════════════════════════════════════════════════════════════════
import { query } from '@/core/db/helpers';
import { paidFilsOfDebt } from '@/core/finance/debt-status';
import { openItemsStamp } from '@/core/finance/open-items-stamp';
import { formatInvoiceDisplayShort } from '@/core/utils/invoiceNumber';
import { isDebtClosed, storeCreditLabel } from './party-offset-reads';

export const OP_CUSTOMERS_SETTLE_BALANCE = 'customers.settle_balance';
export const OP_CUSTOMERS_SETTLEMENT_REVERSE = 'customers.settlement_reverse';

/** Unter 5 Fils ist nichts offen — dieselbe Schwelle wie Receivables / „Receive Payment". */
const OPEN_EPS_F = 5;
const F = (n: unknown): number => Math.round((Number(n) || 0) * 1000);
const B = (f: number): number => f / 1000;
const day = (v: unknown): string => String(v ?? '').slice(0, 10);

// B2/B3 (Owner 10.11.2026) — dritte Gruppe: offene Einkäufe (normal und Kommission) der AUSDRÜCKLICH verknüpften Lieferantenrolle.
export type SettleSourceKind = 'STORE_CREDIT' | 'LOAN_BORROWED' | 'PURCHASE';
/** Reihenfolge der Gruppen (V7, nur die freigegebenen). */
export const SETTLE_SOURCE_ORDER: readonly SettleSourceKind[] = ['STORE_CREDIT', 'LOAN_BORROWED', 'PURCHASE'];
export const SETTLE_SOURCE_LABEL: Record<SettleSourceKind, string> = { STORE_CREDIT: 'Store credit', LOAN_BORROWED: 'We Borrowed', PURCHASE: 'Purchases' };

export interface SettleInvoice {
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
}
export interface SettlePair { invoiceId: string; sourceKind: SettleSourceKind; sourceId: string; amountF: number }

export interface SettlementLine {
  offsetId: string; offsetNumber: string; status: string; amount: number; offsetDate: string;
  invoiceId: string; invoiceNumber: string; invoicePaymentId: string;
  sourceKind: SettleSourceKind; sourceId: string; sourceNumber: string;
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

/** Der Fingerabdruck der angebotenen Posten beider Seiten (Art, Kennung, offener Betrag in Fils). */
export function settleStamp(invoices: readonly SettleInvoice[], sources: readonly SettleSource[]): string {
  return openItemsStamp([
    ...invoices.map((i) => ({ kind: 'invoice', id: i.id, openF: F(i.open) })),
    ...sources.map((s) => ({ kind: s.kind === 'STORE_CREDIT' ? 'credit' : s.kind === 'PURCHASE' ? 'purchase' : 'debt', id: s.id, openF: F(s.open) })),
  ]);
}

/**
 * Der Vorschlag: die gewählten Rechnungen (älteste zuerst) gegen die gewählten Gegenposten (Store Credit, dann We
 * Borrowed; je älteste zuerst), der Reihe nach, bis eine Seite aufgebraucht ist. Rein rechnend, in Fils.
 */
export function planSettlement(
  invoices: readonly SettleInvoice[], sources: readonly SettleSource[],
  selected: { invoiceIds: readonly string[]; sourceIds: readonly string[] },
): SettlePair[] {
  const invSel = new Set(selected.invoiceIds);
  const srcSel = new Set(selected.sourceIds);
  const iv = invoices.filter((i) => invSel.has(i.id)).map((i) => ({ id: i.id, left: F(i.open) })).filter((x) => x.left > OPEN_EPS_F);
  const sv = SETTLE_SOURCE_ORDER.flatMap((k) => sources.filter((s) => s.kind === k && srcSel.has(s.id)))
    .map((s) => ({ kind: s.kind, id: s.id, left: F(s.open) })).filter((x) => x.left > OPEN_EPS_F);
  const pairs: SettlePair[] = [];
  let a = 0, b = 0;
  while (a < iv.length && b < sv.length) {
    const amountF = Math.min(iv[a].left, sv[b].left);
    pairs.push({ invoiceId: iv[a].id, sourceKind: sv[b].kind, sourceId: sv[b].id, amountF });
    iv[a].left -= amountF; sv[b].left -= amountF;
    if (iv[a].left <= OPEN_EPS_F) a++;
    if (sv[b].left <= OPEN_EPS_F) b++;
  }
  return pairs;
}

/**
 * Welche Rechnungen dieser Vorschlag VOLL bezahlt — dieselbe Regel wie jede Zahlung (`recordPayment`: bezahlt ≥ Brutto).
 * Nur für sie fragt die Maske die Endnummer (Normal/Special), und nur, wenn sie noch keine hat.
 */
export function finalizingInvoices(invoices: readonly SettleInvoice[], pairs: readonly SettlePair[]): SettleInvoice[] {
  return invoices.filter((i) => {
    const addF = pairs.filter((p) => p.invoiceId === i.id).reduce((s, p) => s + p.amountF, 0);
    return addF > 0 && F(i.paid) + addF >= F(i.total) - OPEN_EPS_F;
  });
}

/** Alle Verrechnungen dieses Kunden (Settle Balance und Einzelverrechnungen), jüngste zuerst, mit jeder Zuordnung. */
export function settlementsOf(customerId: string, branchId: string): SettlementView[] {
  const rows = query(
    `SELECT o.*, i.invoice_number, i.status AS inv_status, i.special_mark, i.number_finalized_at,
            d.loan_number, cn.credit_note_number, pu.purchase_number
       FROM party_offsets o
       LEFT JOIN invoices i ON i.id = o.receivable_id
       LEFT JOIN debts d ON d.id = o.payable_id AND o.payable_type = 'DEBT'
       LEFT JOIN customer_credits cc ON cc.id = o.payable_id AND o.payable_type = 'STORE_CREDIT'
       LEFT JOIN credit_notes cn ON cn.id = cc.source_id AND cc.source_type = 'sales_return'
       LEFT JOIN purchases pu ON pu.id = o.payable_id AND o.payable_type = 'PURCHASE'
      WHERE o.customer_id = ? AND o.branch_id = ? AND o.receivable_type = 'INVOICE'
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
    const line: SettlementLine = {
      offsetId: String(o.id), offsetNumber: String(o.offset_number), status: String(o.status), amount: B(F(o.amount)),
      offsetDate: String(o.offset_date ?? ''), invoiceId: String(o.receivable_id),
      invoiceNumber: invNo({ invoice_number: o.invoice_number, status: o.inv_status, special_mark: o.special_mark, number_finalized_at: o.number_finalized_at }),
      invoicePaymentId: String(o.receivable_payment_id),
      sourceKind: credit ? 'STORE_CREDIT' : purchase ? 'PURCHASE' : 'LOAN_BORROWED', sourceId: String(o.payable_id),
      sourceNumber: credit ? (String(o.credit_note_number ?? '') || 'Store credit')
        : purchase ? (String(o.purchase_number ?? '') || String(o.payable_id).slice(0, 8))
          : (String(o.loan_number ?? '') || String(o.payable_id).slice(0, 8)),
      reversedAt: (o.reversed_at as string | null) ?? null, reverseReason: (o.reverse_reason as string | null) ?? null,
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
  const invoices = settleInvoicesOf(customerId, ctx.branchId);
  const sources = [...settleCreditsOf(customerId, ctx.branchId), ...settleLoansOf(customerId, ctx.branchId), ...settlePurchasesOf(customerId, ctx.branchId)];
  return { customerId, invoices, sources, stamp: settleStamp(invoices, sources), settlements: settlementsOf(customerId, ctx.branchId) };
}
