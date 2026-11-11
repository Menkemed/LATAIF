// ════════════════════════════════════════════════════════════════════════════
// CUSTOMER ACCOUNT A1 — das gemeinsame Kundenkonto: alles, was ein Kunde LATAIF schuldet und LATAIF ihm schuldet,
// mit Nettosaldo und Kontoauszug. NUR LESEN: keine Buchung, keine Verrechnung, keine Datenänderung beim Öffnen.
//
// Keine zweite Buchhaltung. Jede Zeile ist ein vorhandener Beleg, gelesen mit DERSELBEN Regel wie die Fläche, die ihn
// heute führt (Quelle steht je Abschnitt dabei). „Offen" ist immer der heute offene Betrag dieses Belegs; ein schon
// angerechnetes Guthaben, eine angerechnete Anzahlung, ein ausgezahlter Partnerbetrag zählt nie ein zweites Mal.
//
// Was zum Kunden gehört, entscheidet nur eine AUSDRÜCKLICHE Verknüpfung:
//   • Rechnung, Reparatur, Darlehen, Guthaben, Retoure, Auftrag, Eröffnungsposten — die Kundenkennung am Beleg;
//   • Übergabe an einen Agenten — `agents.customer_id`;
//   • Einkäufe, Ausgaben, Lieferantenguthaben, Lieferanten-Eröffnungsposten — die Lieferantenrolle mit
//     `suppliers.linked_customer_id`, dazu ein Einkauf aus einer Kommission dieses Kunden (`source_consignment_id`);
//   • Kommission — `consignments.consignor_id`.
// Was nur nach Name oder Telefon aussieht, ist ein HINWEIS: es steht im Kasten „Not linked", zählt nicht im Saldo und
// macht den Saldo als unvollständig kenntlich.
//
// PARTNER (A2 / P1): Ein Partner zählt nur, wenn er ausdrücklich mit dem Kunden verknüpft ist (`partners.linked_customer_id`,
// „Link to client" mit Bestätigung). Dann laufen seine OFFENEN Beträge über `partnerOpenRows` (dieselbe Zahl wie
// Receivables/Payables, je Partner und Artikel genau einmal) in den Saldo. Ein nur rechnerischer Gewinnanteil aus einem
// noch nicht abgerechneten Verkauf zählt nie. Ein möglicher Partner (gleicher Name/gleiches Telefon) ohne Verknüpfung ist
// nur ein Hinweis. Gesellschafter-Konten (`partner_transactions`, Eigenkapital) gehören NICHT hierher.
//
// Gold in Gramm steht getrennt und wird nie in BHD gerechnet.
//
// Am Primary lokal, am PC2 als Teil der Auskunft `parties.account.get` (view = 'customer_account') vom Primary — die
// Filiale kommt aus dem Ausweis.
// ════════════════════════════════════════════════════════════════════════════
import { query } from '@/core/db/helpers';
import { paymentMethodLabel } from '@/core/utils/payment-method-label';
import type { BusinessReadContext } from '@/core/data/read-context';
import { customerOrderDepositsFor } from '@/core/data/page-reads';
import { openingItemsFor, OPENING_CUTOFF_DATE, type OpeningItem } from './opening-balances';
import { partnerItemsOverview, type PartnerItemsOfPartner } from '@/core/partners/item-participation-house';
import { partnerOpenRows, partnerItemHref, PARTNER_ORIGIN_LABEL } from '@/core/partners/partner-open-balances';
import { formatInvoiceDisplayShort } from '@/core/utils/invoiceNumber';

export const CUSTOMER_ACCOUNT_VIEW = 'customer_account';

/** Unter 5 Fils ist nichts offen — dieselbe Schwelle wie Receivables/Payables (0,005 BHD). */
const OPEN_EPS_F = 5;
const F = (n: unknown): number => Math.round((Number(n) || 0) * 1000);
const B = (f: number): number => f / 1000;
const day = (v: unknown): string => String(v ?? '').slice(0, 10);
const txt = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

export type AccountSide = 'OWES_US' | 'WE_OWE';

export type AccountDocKind =
  // Kunde schuldet LATAIF
  | 'INVOICE' | 'REPAIR' | 'APPROVAL' | 'LOAN_LENT' | 'OPENING_RECEIVABLE' | 'SUPPLIER_CREDIT' | 'SUPPLIER_REFUND'
  | 'OPENING_SUPPLIER_ADVANCE' | 'PARTNER_RECEIVABLE'
  // LATAIF schuldet dem Kunden
  | 'STORE_CREDIT' | 'REFUND_DUE' | 'RETURN_REFUND' | 'LOAN_BORROWED' | 'PURCHASE' | 'SUPPLIER_EXPENSE'
  | 'CONSIGNMENT_PAYOUT' | 'ORDER_DEPOSIT' | 'OPENING_ADVANCE' | 'OPENING_SUPPLIER_PAYABLE' | 'PARTNER_PAYABLE';

export const ACCOUNT_KIND_LABEL: Record<AccountDocKind, string> = {
  INVOICE: 'Sales invoice',
  REPAIR: 'Repair (not invoiced)',
  APPROVAL: 'Approval sold (agent)',
  LOAN_LENT: 'We Lent',
  OPENING_RECEIVABLE: 'Opening balance — client owes us',
  SUPPLIER_CREDIT: 'Credit with his supplier role',
  SUPPLIER_REFUND: 'Refund due from his supplier role',
  OPENING_SUPPLIER_ADVANCE: 'Opening balance — we paid him in advance',
  PARTNER_RECEIVABLE: 'Partner — owes us',
  STORE_CREDIT: 'Store credit',
  REFUND_DUE: 'Refund owed (invoice correction)',
  RETURN_REFUND: 'Refund owed (return)',
  LOAN_BORROWED: 'We Borrowed',
  PURCHASE: 'Purchase (supplier role)',
  SUPPLIER_EXPENSE: 'Expense (supplier role)',
  CONSIGNMENT_PAYOUT: 'Consignment payout',
  ORDER_DEPOSIT: 'Order deposit',
  OPENING_ADVANCE: 'Opening balance — client paid in advance',
  OPENING_SUPPLIER_PAYABLE: 'Opening balance — we owe his supplier role',
  PARTNER_PAYABLE: 'Partner — we owe',
};

/** Eine Begleichung eines Belegs (Zahlung, Anrechnung, Gutschrift …): mindert seinen offenen Betrag. */
export interface AccountEventRaw { date: string; text: string; amountF: number }

/** Ein Beleg, so wie ihn der Sammler liest (Fils). `openF` kommt aus der Regel der führenden Fläche. */
export interface AccountDocRaw {
  key: string;
  kind: AccountDocKind;
  side: AccountSide;
  number: string;
  date: string;
  detail?: string;
  totalF: number;
  openF: number;
  /** Gehört zu einem bestimmten Vorgang / ist gesperrt — zählt im Saldo, ist aber nicht frei verrechenbar. */
  bound?: string;
  /** Abgeschlossen ohne offenen Rest (z. B. Rechnung voll retourniert) — nur Verlauf. */
  closedText?: string;
  href?: string;
  events: AccountEventRaw[];
  /** Text für den Rest, den die Einzelbewegungen nicht erklären (Gutschrift, Korrektur, Storno …). */
  residualText?: string;
}

export interface AccountDoc {
  key: string;
  kind: AccountDocKind;
  kindLabel: string;
  side: AccountSide;
  number: string;
  date: string;
  detail: string | null;
  total: number;
  settled: number;
  open: number;
  status: 'OPEN' | 'PARTIAL' | 'SETTLED';
  bound: string | null;
  href: string | null;
}

export interface StatementRow {
  date: string;
  docKey: string;
  number: string;
  kindLabel: string;
  text: string;
  /** + = der Kunde schuldet mehr / LATAIF schuldet weniger; − = umgekehrt. */
  change: number;
  /** Laufender Saldo: + = der Kunde schuldet LATAIF, − = LATAIF schuldet dem Kunden. */
  balance: number;
  status: AccountDoc['status'];
  href: string | null;
}

export interface SideTotals { total: number; free: number; bound: number }

export interface PartnerSaleView {
  invoiceId: string; invoiceNumber: string; issuedAt: string; partnerShare: number; released: number; state: string;
}
export interface PartnerItemAccountView {
  purchaseId: string; purchaseNumber: string; purchaseDate: string; productLabel: string; sharePct: number;
  /** Vereinbarter Einkaufsbeitrag (Kostenanteil) und tatsächlich eingezahlt. */
  costShare: number; contributed: number;
  sales: PartnerSaleView[];
  /** Gebuchter (abgerechneter) Gewinn-/Verlustanteil. */
  profitShare: number;
  /** Rechnerischer Anteil aus Verkäufen, die noch nicht abgerechnet sind — NIE im Saldo. */
  profitNotSettled: number;
  paidOut: number; offsets: number;
  /** Offener Stand der Partnerlogik: + = LATAIF schuldet dem Partner, − = der Partner schuldet LATAIF. */
  open: number;
  moneyAction: string; moneyStatus: string; onHold: boolean; participating: boolean;
  href: string;
}
export interface PartnerAccountView {
  partnerId: string; name: string; active: boolean;
  /** LINKED zählt im Saldo; POSSIBLE ist nur ein Hinweis (Name/Telefon) und zählt nicht. */
  link: 'LINKED' | 'POSSIBLE';
  matchedBy: string | null;
  owedToPartner: number; owedByPartner: number;
  items: PartnerItemAccountView[];
}

export interface DebtHint { id: string; loanNumber: string; counterparty: string; direction: 'WE_LENT' | 'WE_BORROWED'; open: number; date: string; revision: number }
export interface SupplierHint { id: string; name: string; matchedBy: string; outstanding: number }

export interface CustomerAccount {
  customer: { id: string; name: string; phone: string | null; updatedAt: string };
  supplierRole: { id: string; name: string } | null;
  owesUs: SideTotals;
  weOwe: SideTotals;
  /** owesUs.total − weOwe.total: + = der Kunde schuldet LATAIF, − = LATAIF schuldet dem Kunden. */
  net: number;
  /** Dasselbe nur über die frei verrechenbaren Beträge. */
  netFree: number;
  direction: 'CLIENT_OWES' | 'WE_OWE' | 'BALANCED';
  docs: AccountDoc[];
  statement: StatementRow[];
  partners: PartnerAccountView[];
  gold: Array<{ karat: string; grams: number; count: number }>;
  hints: { debts: DebtHint[]; suppliers: SupplierHint[]; partners: PartnerAccountView[] };
  complete: boolean;
  incomplete: string[];
}

// ════════════════════════════════════════════════════════════════════════════
// Rechnen (rein, ohne Datenbank) — Saldo, Belegstand und Kontoauszug aus den gelesenen Belegen.
// ════════════════════════════════════════════════════════════════════════════

export interface CustomerAccountRaw {
  customer: CustomerAccount['customer'];
  supplierRole: CustomerAccount['supplierRole'];
  docs: AccountDocRaw[];
  partners: PartnerAccountView[];
  gold: CustomerAccount['gold'];
  hints: CustomerAccount['hints'];
}

const sideOf = (s: AccountSide): number => (s === 'OWES_US' ? 1 : -1);
const DOC_ORDER: Record<AccountSide, number> = { OWES_US: 0, WE_OWE: 1 };

function statusOf(openF: number, totalF: number): AccountDoc['status'] {
  if (openF <= 0) return 'SETTLED';
  return openF < totalF ? 'PARTIAL' : 'OPEN';
}

export function buildCustomerAccount(raw: CustomerAccountRaw): CustomerAccount {
  const docs: AccountDoc[] = [];
  type Line = { date: string; seq: number; docKey: string; number: string; kindLabel: string; text: string; changeF: number; status: AccountDoc['status']; href: string | null };
  const lines: Line[] = [];
  let seq = 0;
  const tot = { OWES_US: { t: 0, b: 0 }, WE_OWE: { t: 0, b: 0 } };

  const ordered = [...raw.docs].sort((a, b) => a.date.localeCompare(b.date) || DOC_ORDER[a.side] - DOC_ORDER[b.side] || a.number.localeCompare(b.number));
  for (const d of ordered) {
    // Ein Rest unter der Schwelle ist nichts offen; ein negativer Rest (überzahlt) auch nicht — das Zuviel steht als
    // eigener Beleg (Guthaben), sonst zählte es doppelt.
    const openF = d.openF > OPEN_EPS_F ? d.openF : 0;
    const status = statusOf(openF, d.totalF);
    const kindLabel = ACCOUNT_KIND_LABEL[d.kind];
    const view: AccountDoc = {
      key: d.key, kind: d.kind, kindLabel, side: d.side, number: d.number, date: d.date, detail: d.detail ?? null,
      total: B(d.totalF), settled: B(d.totalF - openF), open: B(openF), status, bound: d.bound ?? null, href: d.href ?? null,
    };
    docs.push(view);
    tot[d.side].t += openF;
    if (d.bound) tot[d.side].b += openF;

    // Kontoauszug: der Beleg selbst, seine Begleichungen, dann der Rest, den sie nicht erklären — so ergibt jeder Beleg
    // genau seinen offenen Betrag, und die letzte Zeile ist genau der Nettosaldo.
    const sg = sideOf(d.side);
    const base = { docKey: d.key, number: d.number, kindLabel, status, href: d.href ?? null };
    lines.push({ ...base, date: d.date, seq: seq++, text: d.detail || kindLabel, changeF: sg * d.totalF });
    let evF = 0;
    for (const e of [...d.events].sort((a, b) => a.date.localeCompare(b.date))) {
      if (e.amountF === 0) continue;
      evF += e.amountF;
      lines.push({ ...base, date: e.date || d.date, seq: seq++, text: e.text, changeF: -sg * e.amountF });
    }
    const restF = d.totalF - evF - openF;
    if (restF !== 0) {
      const lastDate = d.events.reduce((m, e) => (e.date > m ? e.date : m), d.date);
      lines.push({ ...base, date: lastDate, seq: seq++, text: d.closedText || d.residualText || (restF > 0 ? 'Settled / corrected' : 'Correction'), changeF: -sg * restF });
    }
  }

  lines.sort((a, b) => a.date.localeCompare(b.date) || a.seq - b.seq);
  let balF = 0;
  const statement: StatementRow[] = lines.map((l) => {
    balF += l.changeF;
    return { date: l.date, docKey: l.docKey, number: l.number, kindLabel: l.kindLabel, text: l.text, change: B(l.changeF), balance: B(balF), status: l.status, href: l.href };
  });

  const owesUs: SideTotals = { total: B(tot.OWES_US.t), bound: B(tot.OWES_US.b), free: B(tot.OWES_US.t - tot.OWES_US.b) };
  const weOwe: SideTotals = { total: B(tot.WE_OWE.t), bound: B(tot.WE_OWE.b), free: B(tot.WE_OWE.t - tot.WE_OWE.b) };
  const netF = tot.OWES_US.t - tot.WE_OWE.t;
  const netFreeF = (tot.OWES_US.t - tot.OWES_US.b) - (tot.WE_OWE.t - tot.WE_OWE.b);

  const incomplete: string[] = [];
  if (raw.hints.debts.length) incomplete.push(`${raw.hints.debts.length} loan(s) without a client link look like this client`);
  if (raw.hints.suppliers.length) incomplete.push('a supplier with the same name or phone is not linked to this client');
  if (raw.hints.partners.length) incomplete.push('a partner with the same name or phone is not linked to this client');

  return {
    customer: raw.customer,
    supplierRole: raw.supplierRole,
    owesUs, weOwe,
    net: B(netF), netFree: B(netFreeF),
    direction: netF > 0 ? 'CLIENT_OWES' : netF < 0 ? 'WE_OWE' : 'BALANCED',
    docs, statement,
    partners: raw.partners,
    gold: raw.gold,
    hints: raw.hints,
    complete: incomplete.length === 0,
    incomplete,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Lesen (Datenbank) — je Belegart dieselbe Regel wie die führende Fläche.
// ════════════════════════════════════════════════════════════════════════════

const PAYMENT_LABEL: Record<string, string> = {
  cash: 'Cash', bank_transfer: 'Bank transfer', bank: 'Bank', card: 'Card', benefit: 'Benefit', credit: 'Store credit applied',
  order_deposit: 'Order deposit applied', other: 'Other', cheque: 'Cheque',
  debt_offset: 'Offset with loan · no cash',
  // v0.8.101 S0 — Verrechnung mit einem Einkauf derselben Person; am Einkauf heißt die Gegenzeile 'offset'.
  purchase_offset: 'Offset with purchase · no cash', offset: 'Offset · no cash',
  // v0.8.101 S4 — Verrechnung mit einem Partnerguthaben derselben Person.
  partner_offset: 'Offset with partner balance · no cash',
  partner: 'by partner directly · no cash from LATAIF',
};
/** Unbekannte Zahlart: die gemeinsame Beschriftung (`paymentMethodLabel`), nie der technische Rohwert. */
const payLabel = (m: unknown): string => PAYMENT_LABEL[txt(m)] || (txt(m) ? paymentMethodLabel(txt(m)) : 'Payment');

export class CustomerAccountRejected extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'CustomerAccountRejected'; }
}

const norm = (s: unknown): string => txt(s).replace(/\s+/g, '').toLowerCase();
const normName = (s: unknown): string => txt(s).trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Die Partnerkennungen, die AUSDRÜCKLICH mit diesem Kunden verknüpft sind (`partners.linked_customer_id`, gesetzt nur
 * über „Link to client" — CUSTOMER ACCOUNT A2 / P1). Höchstens einer je Kunde und Filiale (Index).
 */
export function linkedPartnerIds(ctx: { branchId: string }, customerId: string): string[] {
  return query('SELECT id FROM partners WHERE branch_id = ? AND linked_customer_id = ?', [ctx.branchId, customerId]).map((r) => txt(r.id));
}

/**
 * Die offenen Partnerbeträge als Belege des Kundenkontos — ausschließlich der offene Stand der Partnerlogik
 * (`partnerOpenRows`, dieselbe Zahl wie Receivables/Payables): Kostenanteil/Rückforderung = der Partner schuldet LATAIF,
 * „Pay out" = LATAIF schuldet ihm. Ein nur rechnerischer Gewinnanteil aus einem noch nicht abgerechneten Verkauf ist
 * dort nicht enthalten und zählt deshalb nie. Eine wartende Auszahlung (Nachabrechnung/Lieferantengutschrift) ist gebunden.
 */
export function partnerDocsOf(ov: readonly PartnerItemsOfPartner[]): AccountDocRaw[] {
  return partnerOpenRows(ov).map((row) => ({
    key: `partner:${row.partnerId}:${row.purchaseLineId}`, kind: row.side === 'RECEIVABLE' ? 'PARTNER_RECEIVABLE' as const : 'PARTNER_PAYABLE' as const,
    side: row.side === 'RECEIVABLE' ? 'OWES_US' as const : 'WE_OWE' as const, number: row.purchaseNumber, date: day(row.date),
    detail: `${PARTNER_ORIGIN_LABEL[row.origin]} · ${row.productLabel}`, totalF: F(row.open), openF: F(row.open),
    bound: row.onHold ? 'partner payout on hold (settlement correction or supplier credit pending)' : undefined,
    href: row.href, events: [],
  }));
}

export function partnerView(p: PartnerItemsOfPartner, link: PartnerAccountView['link'], matchedBy: string | null): PartnerAccountView {
  return {
    partnerId: p.partnerId, name: p.name, active: p.active, link, matchedBy,
    owedToPartner: p.owedToPartner, owedByPartner: p.owedByPartner,
    items: p.items.map((it) => {
      const released = it.sales.reduce((a, s) => a + F(s.released), 0);
      const computed = it.sales.filter((s) => s.invoiceStatus === 'FINAL').reduce((a, s) => a + F(s.partnerShare), 0);
      return {
        purchaseId: it.purchaseId, purchaseNumber: it.purchaseNumber, purchaseDate: it.purchaseDate, productLabel: it.productLabel,
        sharePct: it.sharePct, costShare: it.costShare, contributed: it.contributed,
        sales: it.sales.map((s) => ({ invoiceId: s.invoiceId, invoiceNumber: s.invoiceNumber, issuedAt: day(s.issuedAt), partnerShare: s.partnerShare, released: s.released, state: s.state })),
        profitShare: it.profitShare,
        profitNotSettled: B(Math.max(0, computed - released)),
        paidOut: it.paidOut, offsets: it.offsets, open: it.open,
        moneyAction: it.moneyAction, moneyStatus: it.moneyStatus,
        onHold: it.open > 0 && (it.correctionPending || it.refundPending), participating: it.participating,
        href: partnerItemHref(p.partnerId, it.purchaseLineId),
      };
    }),
  };
}

export function customerAccountFor(ctx: BusinessReadContext | { branchId: string }, customerId: unknown): CustomerAccount {
  if (typeof customerId !== 'string' || customerId.trim() === '') throw new CustomerAccountRejected('PARTY_REQUIRED', 'choose the client');
  const branchId = ctx.branchId;
  const c = query("SELECT id, first_name, last_name, company, phone, updated_at FROM customers WHERE id = ? AND branch_id = ? AND id NOT LIKE 'sys-%'", [customerId, branchId])[0];
  if (!c) throw new CustomerAccountRejected('PARTY_NOT_FOUND', 'no such client in this branch');
  const name = `${txt(c.first_name)} ${txt(c.last_name)}`.trim() || txt(c.company) || customerId;
  const docs: AccountDocRaw[] = [];

  // ── Rechnungen — Regel von Receivables / „Receive Payment": Brutto − bezahlt − Forderungsstorno der Gutschriften,
  //    ohne Entwurf und Storno; eine retournierte Rechnung ist nicht mehr offen (nur Verlauf).
  const invRows = query(
    `SELECT i.id, i.invoice_number, i.status, i.special_mark, i.number_finalized_at, COALESCE(i.issued_at, i.created_at) AS d,
            i.gross_amount, i.paid_amount, COALESCE(cn.cancel_amount, 0) AS cn, cn.last_cn, cn.numbers
       FROM invoices i
       LEFT JOIN (SELECT invoice_id, SUM(receivable_cancel_amount) AS cancel_amount, MAX(COALESCE(issued_at, created_at)) AS last_cn,
                         GROUP_CONCAT(credit_note_number, ', ') AS numbers
                    FROM credit_notes WHERE status != 'CANCELLED' GROUP BY invoice_id) cn ON cn.invoice_id = i.id
      WHERE i.customer_id = ? AND i.branch_id = ? AND i.status NOT IN ('CANCELLED', 'DRAFT')`,
    [customerId, branchId],
  );
  const payByInv = new Map<string, AccountEventRaw[]>();
  for (const p of query(
    `SELECT p.invoice_id, p.amount, p.method, p.received_at,
            (SELECT o.offset_number || ' · ' || CASE WHEN o.payable_type = 'STORE_CREDIT' THEN 'store credit'
                                                    WHEN o.payable_type = 'PURCHASE' THEN 'purchase ' || COALESCE(pu.purchase_number, '')
                                                    WHEN o.payable_type = 'PARTNER_ITEM' THEN 'partner balance ' || COALESCE(ppu.purchase_number, '')
                                                    ELSE COALESCE(d.loan_number, '') END
               FROM party_offsets o LEFT JOIN debts d ON d.id = o.payable_id AND o.payable_type = 'DEBT'
                                    LEFT JOIN purchases pu ON pu.id = o.payable_id AND o.payable_type = 'PURCHASE'
                                    LEFT JOIN purchase_lines ppl ON ppl.id = o.payable_id AND o.payable_type = 'PARTNER_ITEM'
                                    LEFT JOIN purchases ppu ON ppu.id = ppl.purchase_id
              WHERE o.receivable_payment_id = p.id) AS offset_ref
       FROM payments p JOIN invoices i ON i.id = p.invoice_id
      WHERE i.customer_id = ? AND i.branch_id = ?`,
    [customerId, branchId],
  )) {
    const k = txt(p.invoice_id);
    const list = payByInv.get(k) ?? [];
    // CUSTOMER ACCOUNT B1/C — eine Verrechnung nennt ihren Gegenbeleg (STL-… · Darlehen bzw. Store Credit) und „no cash".
    const text = txt(p.offset_ref) ? `Offset ${txt(p.offset_ref)} · no cash` : payLabel(p.method);
    list.push({ date: day(p.received_at), text, amountF: F(p.amount) });
    payByInv.set(k, list);
  }
  for (const r of invRows) {
    const id = txt(r.id);
    const number = formatInvoiceDisplayShort({
      invoiceNumber: txt(r.invoice_number), status: txt(r.status), specialMark: Number(r.special_mark) === 1,
      numberFinalizedAt: (r.number_finalized_at as string | null) || null,
    }) || txt(r.invoice_number);
    const totalF = F(r.gross_amount);
    const cnF = F(r.cn);
    const returned = txt(r.status) === 'RETURNED';
    const events = [...(payByInv.get(id) ?? [])];
    if (cnF > 0) events.push({ date: day(r.last_cn) || day(r.d), text: `Credit note ${txt(r.numbers)}`.trim(), amountF: cnF });
    docs.push({
      key: `invoice:${id}`, kind: 'INVOICE', side: 'OWES_US', number, date: day(r.d), totalF,
      openF: returned ? 0 : totalF - F(r.paid_amount) - cnF,
      closedText: returned ? 'Returned' : undefined, residualText: 'Correction (overpayment / edit)',
      href: `/invoices/${id}`, events,
    });
  }

  // ── Reparaturen ohne Rechnung — Regel von Receivables (fertig/abgeholt, Gebühr − vom Kunden bezahlt).
  for (const r of query(
    `SELECT id, repair_number, status, COALESCE(charge_to_customer, 0) AS charge, COALESCE(customer_paid_amount, 0) AS paid,
            COALESCE(completed_at, received_at) AS d
       FROM repairs WHERE customer_id = ? AND branch_id = ? AND (invoice_id IS NULL OR invoice_id = '')
        AND status IN ('ready', 'picked_up') AND COALESCE(charge_to_customer, 0) > 0`,
    [customerId, branchId],
  )) {
    const paidF = F(r.paid);
    docs.push({
      key: `repair:${txt(r.id)}`, kind: 'REPAIR', side: 'OWES_US', number: txt(r.repair_number), date: day(r.d),
      totalF: F(r.charge), openF: F(r.charge) - paidF, href: `/repairs/${txt(r.id)}`,
      events: paidF > 0 ? [{ date: day(r.d), text: 'Paid by the client', amountF: paidF }] : [],
    });
  }

  // ── Übergaben an den Kunden als Agenten, verkauft, ohne Rechnung — Regel von Receivables.
  for (const r of query(
    `SELECT at.id, at.transfer_number, at.agent_id, COALESCE(at.settlement_amount, 0) AS total, COALESCE(at.settlement_paid_amount, 0) AS paid,
            COALESCE(at.sold_at, at.transferred_at) AS d
       FROM agent_transfers at JOIN agents ag ON ag.id = at.agent_id
      WHERE ag.customer_id = ? AND at.branch_id = ? AND at.invoice_id IS NULL AND at.status IN ('sold', 'settled')
        AND COALESCE(at.settlement_amount, 0) > 0`,
    [customerId, branchId],
  )) {
    const paidF = F(r.paid);
    docs.push({
      key: `approval:${txt(r.id)}`, kind: 'APPROVAL', side: 'OWES_US', number: txt(r.transfer_number), date: day(r.d),
      totalF: F(r.total), openF: F(r.total) - paidF, href: `/agents/${txt(r.agent_id)}`,
      events: paidF > 0 ? [{ date: day(r.d), text: 'Settled by the agent', amountF: paidF }] : [],
    });
  }

  // ── Darlehen beider Richtungen — Regel von Kundensaldo (we_lend) und Payables (we_borrow): Betrag − Rückzahlungen,
  //    ohne Storno; getilgt = nichts offen. Die kanonischen Namen (MONEY_GIVEN/RECEIVED) zählen mit.
  const debtPays = new Map<string, AccountEventRaw[]>();
  for (const p of query(
    `SELECT dp.debt_id, dp.amount, dp.source, dp.paid_at, dp.notes FROM debt_payments dp JOIN debts d ON d.id = dp.debt_id
      WHERE d.customer_id = ? AND d.branch_id = ?`,
    [customerId, branchId],
  )) {
    const list = debtPays.get(txt(p.debt_id)) ?? [];
    // CUSTOMER ACCOUNT B1 — Rückzahlung durch Verrechnung (bzw. ihre Aufhebung): der Text der Zeile nennt den Gegenbeleg.
    const offset = txt(p.source) === 'offset' || txt(p.source) === 'offset_reversal';
    list.push({ date: day(p.paid_at), text: offset ? (txt(p.notes) || 'Offset · no cash') : `Repayment · ${payLabel(p.source)}`, amountF: F(p.amount) });
    debtPays.set(txt(p.debt_id), list);
  }
  for (const r of query(
    `SELECT id, loan_number, direction, amount, status, created_at, notes FROM debts
      WHERE customer_id = ? AND branch_id = ? AND direction IN ('we_lend', 'MONEY_GIVEN', 'we_borrow', 'MONEY_RECEIVED')
        AND UPPER(status) != 'CANCELLED'`,
    [customerId, branchId],
  )) {
    const lent = txt(r.direction) === 'we_lend' || txt(r.direction) === 'MONEY_GIVEN';
    const events = debtPays.get(txt(r.id)) ?? [];
    const paidF = events.reduce((a, e) => a + e.amountF, 0);
    const closed = ['REPAID', 'SETTLED'].includes(txt(r.status).toUpperCase());
    docs.push({
      key: `debt:${txt(r.id)}`, kind: lent ? 'LOAN_LENT' : 'LOAN_BORROWED', side: lent ? 'OWES_US' : 'WE_OWE',
      number: txt(r.loan_number) || txt(r.id).slice(0, 8), date: day(r.created_at), detail: txt(r.notes) || undefined,
      totalF: F(r.amount), openF: closed ? 0 : F(r.amount) - paidF, residualText: 'Marked repaid', href: '/debts', events,
    });
  }

  // ── Store-Guthaben und Rückzahlungsansprüche — Regel von „Store Credit" (OPEN: Betrag − verwendet) und Payables
  //    (REFUND_DUE: offen bis zur Auszahlung). Verwendet/ausgezahlt = nur Verlauf.
  const invNo = (r: Record<string, unknown>): string => formatInvoiceDisplayShort({
    invoiceNumber: txt(r.invoice_number), status: txt(r.status), specialMark: Number(r.special_mark) === 1,
    numberFinalizedAt: (r.number_finalized_at as string | null) || null,
  }) || txt(r.invoice_number);
  const appByCredit = new Map<string, AccountEventRaw[]>();
  for (const a of query(
    `SELECT ca.credit_id, ca.amount, p.received_at, i.invoice_number, i.status, i.special_mark, i.number_finalized_at,
            (SELECT o.offset_number FROM party_offsets o WHERE o.receivable_payment_id = ca.payment_id) AS offset_number
       FROM credit_applications ca
       JOIN customer_credits cc ON cc.id = ca.credit_id
       LEFT JOIN payments p ON p.id = ca.payment_id LEFT JOIN invoices i ON i.id = p.invoice_id
      WHERE cc.customer_id = ? AND cc.branch_id = ?`,
    [customerId, branchId],
  )) {
    const list = appByCredit.get(txt(a.credit_id)) ?? [];
    // CUSTOMER ACCOUNT C — aus „Settle Balance": die STL-Nummer und „no cash".
    const ziel = a.invoice_number ? invNo(a) : 'an invoice';
    list.push({ date: day(a.received_at), text: a.offset_number ? `Offset ${txt(a.offset_number)} → ${ziel} · no cash` : `Applied to ${ziel}`, amountF: F(a.amount) });
    appByCredit.set(txt(a.credit_id), list);
  }
  const CREDIT_SOURCE: Record<string, string> = {
    sales_return: 'from a return', order_overpayment: 'order overpayment', overpayment: 'overpayment', order_cancel: 'order cancelled',
    gold_conversion: 'gold converted to money', invoice_edit: 'invoice correction', opening: 'opening balance',
  };
  for (const r of query(
    `SELECT cc.id, cc.source_type, cc.source_id, cc.amount, cc.used_amount, cc.status AS credit_status, cc.created_at,
            i.invoice_number, i.status, i.special_mark, i.number_finalized_at
       FROM customer_credits cc LEFT JOIN invoices i ON i.id = cc.source_id
      WHERE cc.customer_id = ? AND cc.branch_id = ? AND cc.status != 'CANCELLED'`,
    [customerId, branchId],
  )) {
    const status = txt(r.credit_status);
    const refund = status === 'REFUND_DUE' || status === 'REFUNDED';
    const usedF = F(r.used_amount);
    const live = status === 'OPEN' || status === 'REFUND_DUE';
    const events = refund
      ? (usedF > 0 ? [{ date: day(r.created_at), text: 'Paid out', amountF: usedF }] : [])
      : (appByCredit.get(txt(r.id)) ?? []);
    const src = CREDIT_SOURCE[txt(r.source_type)] || txt(r.source_type) || 'credit';
    docs.push({
      key: `credit:${txt(r.id)}`, kind: refund ? 'REFUND_DUE' : 'STORE_CREDIT', side: 'WE_OWE',
      number: r.invoice_number ? invNo(r) : (refund ? 'Refund' : 'Store credit'), date: day(r.created_at), detail: `${refund ? 'Refund owed' : 'Store credit'} · ${src}`,
      totalF: F(r.amount), openF: live ? F(r.amount) - usedF : 0, residualText: refund ? 'Paid out' : 'Used',
      href: r.invoice_number ? `/invoices/${txt(r.source_id)}` : undefined, events,
    });
  }

  // ── Erstattung aus einer Retoure — Regel von Payables (genehmigt/erstattet, Erstattung − ausgezahlt).
  for (const r of query(
    `SELECT sr.id, sr.return_number, sr.invoice_id, sr.refund_amount, COALESCE(sr.refund_paid_amount, 0) AS paid, sr.refund_method,
            sr.refund_paid_date, sr.return_date, cn.id AS cn_id
       FROM sales_returns sr LEFT JOIN credit_notes cn ON cn.sales_return_id = sr.id
      WHERE sr.customer_id = ? AND sr.branch_id = ? AND sr.status IN ('APPROVED', 'REFUNDED') AND COALESCE(sr.refund_amount, 0) > 0`,
    [customerId, branchId],
  )) {
    const paidF = F(r.paid);
    docs.push({
      key: `return:${txt(r.id)}`, kind: 'RETURN_REFUND', side: 'WE_OWE', number: txt(r.return_number), date: day(r.return_date),
      totalF: F(r.refund_amount), openF: F(r.refund_amount) - paidF,
      href: r.cn_id ? `/credit-notes/${txt(r.cn_id)}` : `/invoices/${txt(r.invoice_id)}`,
      events: paidF > 0 ? [{ date: day(r.refund_paid_date) || day(r.return_date), text: `Refund paid · ${payLabel(r.refund_method)}`, amountF: paidF }] : [],
    });
  }

  // ── Kommission (Altweg ohne Rechnung) — Regel von Payables: verkauft, Auszahlung − ausgezahlt. Ein „Record Sale"
  //    führt die Schuld als Einkauf beim Einlieferer (unten) und steht hier nicht, sonst zählte sie doppelt.
  for (const r of query(
    `SELECT id, consignment_number, payout_amount, COALESCE(payout_paid_amount, 0) AS paid, payout_date, agreement_date, created_at
       FROM consignments
      WHERE consignor_id = ? AND branch_id = ? AND UPPER(status) = 'SOLD' AND (invoice_id IS NULL OR invoice_id = '')
        AND COALESCE(payout_amount, 0) > 0`,
    [customerId, branchId],
  )) {
    const paidF = F(r.paid);
    docs.push({
      key: `consignment:${txt(r.id)}`, kind: 'CONSIGNMENT_PAYOUT', side: 'WE_OWE', number: txt(r.consignment_number),
      date: day(r.agreement_date || r.created_at), totalF: F(r.payout_amount), openF: F(r.payout_amount) - paidF,
      href: `/consignments/${txt(r.id)}`,
      events: paidF > 0 ? [{ date: day(r.payout_date) || day(r.agreement_date || r.created_at), text: 'Paid out', amountF: paidF }] : [],
    });
  }

  // ── Anzahlungen auf Aufträge — dieselbe Regel wie die Kundenseite (nicht angerechnet, nicht storniert, auf den
  //    vereinbarten Preis gedeckelt; der Rest ist schon Store-Guthaben). GEBUNDEN: sie gehört zu ihrem Auftrag.
  for (const o of customerOrderDepositsFor(ctx as BusinessReadContext, customerId).orders) {
    if (o.open <= 0.0005) continue;
    const first = o.payments.reduce((m, p) => (m === '' || day(p.paidAt) < m ? day(p.paidAt) : m), '');
    docs.push({
      key: `order:${o.orderId}`, kind: 'ORDER_DEPOSIT', side: 'WE_OWE', number: o.orderNumber, date: first,
      detail: `Deposit on order ${o.orderNumber} (${o.status})`, totalF: F(o.open), openF: F(o.open),
      bound: `bound to order ${o.orderNumber} — applied on its invoice`, href: `/orders/${o.orderId}`, events: [],
    });
  }

  // ── Eröffnungsposten des Kunden — erfasst, noch nicht gebucht und noch nicht bezahlbar (gesperrt bis zum Buchhalter).
  const opening = (items: OpeningItem[]): void => {
    for (const it of items) {
      if (it.status !== 'RECORDED') continue;
      const kind: AccountDocKind = it.kind === 'CUSTOMER_RECEIVABLE' ? 'OPENING_RECEIVABLE' : it.kind === 'CUSTOMER_ADVANCE' ? 'OPENING_ADVANCE'
        : it.kind === 'SUPPLIER_PAYABLE' ? 'OPENING_SUPPLIER_PAYABLE' : 'OPENING_SUPPLIER_ADVANCE';
      const side: AccountSide = kind === 'OPENING_RECEIVABLE' || kind === 'OPENING_SUPPLIER_ADVANCE' ? 'OWES_US' : 'WE_OWE';
      docs.push({
        key: `opening:${it.id}`, kind, side, number: it.itemNumber, date: it.documentDate || OPENING_CUTOFF_DATE,
        detail: it.reference ? `Opening position · ${it.reference}` : 'Opening position · summarised balance',
        totalF: F(it.amount), openF: F(it.amount), bound: 'opening position — recorded, not booked yet (waits for the accountant)',
        href: `/clients/${customerId}`, events: [],
      });
    }
  };
  opening(openingItemsFor(ctx, 'CUSTOMER', customerId));

  // ── Lieferantenrolle — NUR die ausdrücklich verknüpfte (`suppliers.linked_customer_id`).
  const sup = query('SELECT id, name FROM suppliers WHERE branch_id = ? AND linked_customer_id = ? LIMIT 1', [branchId, customerId])[0];
  const supplierRole = sup ? { id: txt(sup.id), name: txt(sup.name) } : null;

  // Einkäufe: die der Rolle und die aus einer Kommission dieses Kunden (Record Sale) — jeder Einkauf genau einmal.
  // Regel des Lieferantenkontos (`supplierLedgerStrict`): Betrag − bezahlt − Guthaben-Einlösungen; ohne Entwurf/Storno.
  const purchaseRows = query(
    `SELECT p.id, p.purchase_number, p.purchase_date, p.status, p.total_amount, p.paid_amount, p.supplier_id,
            p.source_consignment_id,
            COALESCE((SELECT SUM(pp.amount) FROM purchase_payments pp WHERE pp.purchase_id = p.id AND pp.method IN ('credit', 'offset') AND pp.voided_at IS NULL), 0) AS credit_paid,
            EXISTS (SELECT 1 FROM consignments cs WHERE cs.consignor_id = ?1 AND (cs.id = p.source_consignment_id
                      OR cs.id IN (SELECT pl.source_consignment_id FROM purchase_lines pl WHERE pl.purchase_id = p.id))) AS from_consignment
       FROM purchases p
      WHERE p.branch_id = ?2 AND p.status NOT IN ('DRAFT', 'CANCELLED')
        AND (p.supplier_id = ?3
             OR EXISTS (SELECT 1 FROM consignments cs WHERE cs.consignor_id = ?1 AND (cs.id = p.source_consignment_id
                          OR cs.id IN (SELECT pl.source_consignment_id FROM purchase_lines pl WHERE pl.purchase_id = p.id))))`,
    [customerId, branchId, supplierRole?.id ?? '\u0000'],
  );
  const purchasePays = new Map<string, AccountEventRaw[]>();
  if (purchaseRows.length) {
    for (const p of query(
      `SELECT pp.purchase_id, pp.amount, pp.method, pp.paid_at, pp.reference FROM purchase_payments pp
        WHERE pp.voided_at IS NULL AND pp.purchase_id IN (${purchaseRows.map(() => '?').join(',')})`,
      purchaseRows.map((r) => txt(r.id)),
    )) {
      const list = purchasePays.get(txt(p.purchase_id)) ?? [];
      // B2/B3 — eine Verrechnung mit einer Rechnung ist kein Geld: Nummer statt Zahlart.
      const text = txt(p.method) === 'credit' ? 'Paid with supplier credit'
        : txt(p.method) === 'offset' ? `Settled by offset ${txt(p.reference)} · no cash` : `Paid · ${payLabel(p.method)}`;
      list.push({ date: day(p.paid_at), text, amountF: F(p.amount) });
      purchasePays.set(txt(p.purchase_id), list);
    }
  }
  for (const r of purchaseRows) {
    const fromConsignment = Number(r.from_consignment) === 1;
    docs.push({
      key: `purchase:${txt(r.id)}`, kind: fromConsignment ? 'CONSIGNMENT_PAYOUT' : 'PURCHASE', side: 'WE_OWE',
      number: txt(r.purchase_number), date: day(r.purchase_date),
      detail: fromConsignment ? 'Consignment sold — payout as purchase' : undefined,
      totalF: F(r.total_amount), openF: F(r.total_amount) - F(r.paid_amount) - F(r.credit_paid),
      href: `/purchases/${txt(r.id)}`, events: purchasePays.get(txt(r.id)) ?? [], residualText: 'Correction (return / edit)',
    });
  }

  if (supplierRole) {
    // Ausgaben der Rolle (z. B. Werkstatt) — Regel des Lieferantenkontos: Betrag − bezahlt − Guthaben-Einlösungen.
    const expRows = query(
      `SELECT e.id, e.expense_number, e.expense_date, e.created_at, e.category, e.amount, e.paid_amount
         FROM expenses e WHERE e.supplier_id = ? AND e.branch_id = ? AND e.status != 'CANCELLED'`,
      [supplierRole.id, branchId],
    );
    const expPays = new Map<string, AccountEventRaw[]>();
    for (const p of query(
      `SELECT ep.expense_id, ep.amount, ep.method, ep.paid_at FROM expense_payments ep JOIN expenses e ON e.id = ep.expense_id
        WHERE e.supplier_id = ? AND e.branch_id = ?`,
      [supplierRole.id, branchId],
    )) {
      const list = expPays.get(txt(p.expense_id)) ?? [];
      list.push({ date: day(p.paid_at), text: txt(p.method) === 'credit' ? 'Paid with supplier credit' : `Paid · ${payLabel(p.method)}`, amountF: F(p.amount) });
      expPays.set(txt(p.expense_id), list);
    }
    for (const r of expRows) {
      const events = expPays.get(txt(r.id)) ?? [];
      const creditF = events.filter((e) => e.text === 'Paid with supplier credit').reduce((a, e) => a + e.amountF, 0);
      docs.push({
        key: `expense:${txt(r.id)}`, kind: 'SUPPLIER_EXPENSE', side: 'WE_OWE', number: txt(r.expense_number),
        date: day(r.expense_date || r.created_at), detail: txt(r.category) || undefined,
        totalF: F(r.amount), openF: F(r.amount) - F(r.paid_amount) - creditF, href: '/expenses', events,
      });
    }
    // Guthaben bei der Rolle und Rückforderung — P3 (Owner 09.11.2026), belegt durch den gespeicherten Status
    // (`supplierCreditsFor`: „Verrechenbar ist nur ein Guthaben (OPEN) — eine Rückforderung (REFUND_DUE) wartet auf das
    // Geld des Lieferanten"):
    //   • REFUND_DUE — der Lieferant muss Geld zurückzahlen (Rückforderung, „Record Repayment") → FREI.
    //   • OPEN — ein Guthaben, das die App nur auf seine Einkäufe/Ausgaben einlöst (Retoure, Überzahlung, Kostenkorrektur,
    //     Vorauszahlung) → GEBUNDEN. Auch ein Vorauszahlungs-Guthaben, für das sich eine Rückzahlung erfassen ließe, ist
    //     keine fällige Rückzahlung, solange es kein REFUND_DUE ist — keine pauschale Freigabe.
    for (const r of query(
      `SELECT id, amount, used_amount, status, created_at, source_return_id, source_purchase_id
         FROM supplier_credits WHERE supplier_id = ? AND branch_id = ? AND status != 'CANCELLED'`,
      [supplierRole.id, branchId],
    )) {
      const status = txt(r.status);
      const refund = status === 'REFUND_DUE' || status === 'REFUNDED';
      const usedF = F(r.used_amount);
      const live = status === 'OPEN' || status === 'REFUND_DUE';
      const herkunft = r.source_return_id ? 'from a supplier return' : r.source_purchase_id ? 'from an overpaid purchase' : 'credit / prepayment';
      docs.push({
        key: `supcredit:${txt(r.id)}`, kind: refund ? 'SUPPLIER_REFUND' : 'SUPPLIER_CREDIT', side: 'OWES_US',
        number: refund ? 'Supplier refund' : 'Supplier credit', date: day(r.created_at),
        detail: refund ? 'his supplier role must pay this back' : `credit we hold with his supplier role · ${herkunft}`,
        totalF: F(r.amount), openF: live ? F(r.amount) - usedF : 0, href: `/suppliers/${supplierRole.id}`,
        bound: refund ? undefined : 'usable only on his purchases / expenses — not money he has to pay back',
        events: usedF > 0 ? [{ date: day(r.created_at), text: refund ? 'Repaid by the supplier' : 'Used on purchases', amountF: usedF }] : [],
      });
    }
    opening(openingItemsFor(ctx, 'SUPPLIER', supplierRole.id));
  }

  // ── Partner — nur ausdrücklich verknüpfte zählen (heute keine, P1); mögliche Treffer nur als Hinweis.
  const partners: PartnerAccountView[] = [];
  const linked = linkedPartnerIds(ctx, customerId);
  for (const pid of linked) {
    const ov = partnerItemsOverview(branchId, pid);
    for (const p of ov) partners.push(partnerView(p, 'LINKED', null));
    // Ein verknüpfter Partner ohne gemeinsamen Artikel steht trotzdem da (nichts offen), damit die Verknüpfung sichtbar ist.
    if (ov.length === 0) {
      const p = query('SELECT name, active FROM partners WHERE id = ?', [pid])[0];
      partners.push({ partnerId: pid, name: txt(p?.name), active: Number(p?.active) === 1, link: 'LINKED', matchedBy: null, owedToPartner: 0, owedByPartner: 0, items: [] });
    }
    docs.push(...partnerDocsOf(ov));
  }
  const phone = norm(c.phone);
  const partnerHints: PartnerAccountView[] = [];
  // Ein schon mit einem (anderen) Kunden verknüpfter Partner ist nie ein Hinweis — er gehört dorthin.
  for (const p of query("SELECT id, name, phone FROM partners WHERE branch_id = ? AND (linked_customer_id IS NULL OR linked_customer_id = '')", [branchId])) {
    if (linked.includes(txt(p.id))) continue;
    const byPhone = phone !== '' && norm(p.phone) === phone;
    const byName = normName(p.name) !== '' && normName(p.name) === normName(name);
    if (!byPhone && !byName) continue;
    const ov = partnerItemsOverview(branchId, txt(p.id));
    const view = ov[0] ? partnerView(ov[0], 'POSSIBLE', byPhone ? 'phone' : 'name')
      : { partnerId: txt(p.id), name: txt(p.name), active: true, link: 'POSSIBLE' as const, matchedBy: byPhone ? 'phone' : 'name', owedToPartner: 0, owedByPartner: 0, items: [] };
    partnerHints.push(view);
  }

  // ── Hinweise: Darlehen ohne Kundenverknüpfung mit diesem Namen; ein unverknüpfter Lieferant mit gleichem Telefon/Namen.
  const debtHints: DebtHint[] = [];
  const names = [normName(name), normName(c.company)].filter((x) => x !== '');
  for (const r of query(
    `SELECT d.id, d.loan_number, d.counterparty, d.direction, d.amount, d.created_at, d.revision,
            COALESCE((SELECT SUM(amount) FROM debt_payments WHERE debt_id = d.id), 0) AS paid
       FROM debts d WHERE d.branch_id = ? AND (d.customer_id IS NULL OR d.customer_id = '')
        AND UPPER(d.status) NOT IN ('CANCELLED', 'REPAID', 'SETTLED')`,
    [branchId],
  )) {
    if (!names.includes(normName(r.counterparty))) continue;
    const openF = F(r.amount) - F(r.paid);
    if (openF <= OPEN_EPS_F) continue;
    const lent = txt(r.direction) === 'we_lend' || txt(r.direction) === 'MONEY_GIVEN';
    debtHints.push({ id: txt(r.id), loanNumber: txt(r.loan_number) || txt(r.id).slice(0, 8), counterparty: txt(r.counterparty), direction: lent ? 'WE_LENT' : 'WE_BORROWED', open: B(openF), date: day(r.created_at), revision: Number(r.revision ?? 1) });
  }
  const supplierHints: SupplierHint[] = [];
  if (!supplierRole) {
    for (const s of query('SELECT id, name, phone FROM suppliers WHERE branch_id = ? AND linked_customer_id IS NULL', [branchId])) {
      const byPhone = phone !== '' && norm(s.phone) === phone;
      const byName = normName(s.name) !== '' && normName(s.name) === normName(name);
      if (!byPhone && !byName) continue;
      const o = query(
        `SELECT COALESCE(SUM(MAX(0, p.total_amount - p.paid_amount
                  - COALESCE((SELECT SUM(pp.amount) FROM purchase_payments pp WHERE pp.purchase_id = p.id AND pp.method IN ('credit', 'offset') AND pp.voided_at IS NULL), 0))), 0) AS o
           FROM purchases p WHERE p.supplier_id = ? AND p.branch_id = ? AND p.status NOT IN ('DRAFT', 'CANCELLED')`,
        [txt(s.id), branchId],
      )[0];
      supplierHints.push({ id: txt(s.id), name: txt(s.name), matchedBy: byPhone ? 'phone' : 'name', outstanding: B(F(o?.o)) });
    }
  }

  // ── Gold in Gramm — getrennt, offen je Karat (Regel der Kundenseite: OPEN, Gewicht − erfüllt).
  const gold = query(
    `SELECT karat, SUM(weight_grams - fulfilled_grams) AS g, COUNT(*) AS n FROM customer_gold_credits
      WHERE customer_id = ? AND branch_id = ? AND status = 'OPEN' GROUP BY karat ORDER BY karat`,
    [customerId, branchId],
  ).map((r) => ({ karat: txt(r.karat), grams: Math.round((Number(r.g) || 0) * 1000) / 1000, count: Number(r.n) || 0 }))
    .filter((g) => g.grams > 0.0005);

  return buildCustomerAccount({
    customer: { id: customerId, name, phone: txt(c.phone) || null, updatedAt: txt(c.updated_at) },
    supplierRole, docs, partners, gold,
    hints: { debts: debtHints, suppliers: supplierHints, partners: partnerHints },
  });
}
