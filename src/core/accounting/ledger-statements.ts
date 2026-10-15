// ════════════════════════════════════════════════════════════════════════════
// B1 OPENING ACCOUNTING — Saldenliste, vorläufige Bilanz und Stichtagsliste aus dem Hauptbuch (nur lesen).
//
// Quelle für alles Gebuchte ist ausschließlich `ledger_entries` (Beträge in Fils summiert, keine Gleitkomma-Reste). Der
// Stichtag ist ein Kalendertag; „vor dem Stichtag" heißt `occurred_at` vor 00:00 Uhr Ortszeit dieses Tages — dieselbe
// Kalenderlogik wie der NBR-Export (`new Date(iso)`, Ortszeit). Entwürfe (Eröffnungsbelege, Altbestand) stehen hier
// NICHT drin; sie zeigt die Eröffnungsübersicht getrennt (`opening-accounting.ts`).
//
// Schreibt nichts, bucht nichts, ändert keine Rechnung und keinen NBR-Export. Ein Ergebnis ist immer PROVISIONAL: einen
// offiziellen Abschlussstatus gibt es in B1 nicht.
// ════════════════════════════════════════════════════════════════════════════
import { query } from '@/core/db/helpers';
import {
  ACCOUNT_CLASSES, GROUP_LABEL, accountClassOf, sideBalanceFils,
  type AccountClass, type AccountGroup,
} from '@/core/ledger/account-classes';

const toBhd = (fils: number): number => fils / 1000;

export class LedgerStatementInputError extends Error {
  readonly code: string;
  constructor(message: string) { super(message); this.code = 'AS_OF_DATE_INVALID'; this.name = 'LedgerStatementInputError'; }
}

/** JJJJ-MM-TT → der Zeitpunkt 00:00 Uhr Ortszeit dieses Tages als ISO-Zeit (exklusive Grenze). */
export function cutoffBoundaryIso(day: unknown): string {
  if (typeof day !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(day)) throw new LedgerStatementInputError('the date is JJJJ-MM-TT');
  const d = new Date(`${day}T00:00:00`);
  if (Number.isNaN(d.getTime()) || `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` !== day) {
    throw new LedgerStatementInputError('the date does not exist');
  }
  return d.toISOString();
}

// ── Saldenliste ─────────────────────────────────────────────────────────────

export interface TrialBalanceLine {
  account: string;
  klass: AccountClass | null;
  group: AccountGroup | null;
  contra: boolean;
  debit: number;
  credit: number;
  /** Auf der Seite der Klasse (Aktiva/Aufwand Soll − Haben, sonst Haben − Soll); nicht zugeordnet: Soll − Haben. */
  balance: number;
  entries: number;
}

export interface TrialBalance {
  asOfDate: string;
  boundaryIso: string;
  lines: TrialBalanceLine[];
  totalDebit: number;
  totalCredit: number;
  /** Soll − Haben über alles; 0 bei einem ausgeglichenen Hauptbuch. */
  imbalance: number;
  unclassified: string[];
  entries: number;
}

interface FilsLine { account: string; debitF: number; creditF: number; n: number }

function filsLinesBefore(branchId: string, boundaryIso: string): FilsLine[] {
  return query(
    `SELECT account,
            COALESCE(SUM(CASE WHEN direction = 'DEBIT'  THEN CAST(ROUND(amount * 1000) AS INTEGER) ELSE 0 END), 0) AS d,
            COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN CAST(ROUND(amount * 1000) AS INTEGER) ELSE 0 END), 0) AS c,
            COUNT(*) AS n
       FROM ledger_entries WHERE branch_id = ? AND occurred_at < ?
      GROUP BY account ORDER BY account`,
    [branchId, boundaryIso],
  ).map((r) => ({ account: String(r.account), debitF: Number(r.d) || 0, creditF: Number(r.c) || 0, n: Number(r.n) || 0 }));
}

export function trialBalanceAt(ctx: { branchId: string }, asOfDate: string): TrialBalance {
  const boundaryIso = cutoffBoundaryIso(asOfDate);
  const raw = filsLinesBefore(ctx.branchId, boundaryIso);
  let dF = 0; let cF = 0; let n = 0;
  const unclassified: string[] = [];
  const lines = raw.map((l) => {
    dF += l.debitF; cF += l.creditF; n += l.n;
    const info = accountClassOf(l.account);
    if (!info) unclassified.push(l.account);
    return {
      account: l.account, klass: info?.klass ?? null, group: info?.group ?? null, contra: info?.contra === true,
      debit: toBhd(l.debitF), credit: toBhd(l.creditF),
      balance: toBhd(info ? sideBalanceFils(info.klass, l.debitF, l.creditF) : l.debitF - l.creditF), entries: l.n,
    };
  });
  return { asOfDate, boundaryIso, lines, totalDebit: toBhd(dF), totalCredit: toBhd(cF), imbalance: toBhd(dF - cF), unclassified, entries: n };
}

// ── Vorläufige Bilanz ───────────────────────────────────────────────────────

export interface BalanceSheetGroup { group: AccountGroup; label: string; accounts: Array<{ account: string; balance: number; contra: boolean }>; total: number }

export interface BalanceSheet {
  asOfDate: string;
  boundaryIso: string;
  /** Immer PROVISIONAL: B1 kennt keinen Abschluss. */
  status: 'PROVISIONAL';
  assets: BalanceSheetGroup[];
  liabilities: BalanceSheetGroup[];
  equity: {
    /** OPENING_BALANCE_EQUITY — z. B. die vorhandene Settings-Eröffnung vom 01.01.2000. */
    opening: number;
    partner: number;
    /** Gebuchtes Ergebnis vor dem Stichtag: Ertrag − Aufwand. */
    result: number;
    income: number;
    expense: number;
    total: number;
  };
  totals: { assets: number; liabilities: number; equityAndResult: number };
  /** Aktiva − Passiva − (Eigenkapital + Ergebnis): 0, wenn das Hauptbuch ausgeglichen und jedes Konto zugeordnet ist. */
  difference: number;
  imbalance: number;
  unclassified: Array<{ account: string; debitMinusCredit: number }>;
}

const ASSET_ORDER: AccountGroup[] = ['CASH', 'RECEIVABLES', 'INVENTORY', 'SUPPLIER_ADVANCES', 'LOANS_RECEIVABLE', 'VAT_ASSET', 'OTHER_ASSETS'];
const LIABILITY_ORDER: AccountGroup[] = ['PAYABLES', 'CUSTOMER_ADVANCES', 'LOANS_PAYABLE', 'VAT', 'OTHER_LIABILITIES'];

export function balanceSheetAt(ctx: { branchId: string }, asOfDate: string): BalanceSheet {
  const boundaryIso = cutoffBoundaryIso(asOfDate);
  const raw = filsLinesBefore(ctx.branchId, boundaryIso);
  const byGroup = new Map<AccountGroup, Array<{ account: string; fils: number; contra: boolean }>>();
  const unclassified: Array<{ account: string; debitMinusCredit: number }> = [];
  let dF = 0; let cF = 0;
  for (const l of raw) {
    dF += l.debitF; cF += l.creditF;
    const info = accountClassOf(l.account);
    if (!info) { unclassified.push({ account: l.account, debitMinusCredit: toBhd(l.debitF - l.creditF) }); continue; }
    const xs = byGroup.get(info.group) ?? [];
    xs.push({ account: l.account, fils: sideBalanceFils(info.klass, l.debitF, l.creditF), contra: info.contra === true });
    byGroup.set(info.group, xs);
  }
  const groupsOf = (order: AccountGroup[]): { groups: BalanceSheetGroup[]; fils: number } => {
    let fils = 0;
    const groups = order.map((g) => {
      const xs = byGroup.get(g) ?? [];
      const t = xs.reduce((s, x) => s + x.fils, 0);
      fils += t;
      return { group: g, label: GROUP_LABEL[g], accounts: xs.map((x) => ({ account: x.account, balance: toBhd(x.fils), contra: x.contra })), total: toBhd(t) };
    });
    return { groups, fils };
  };
  const a = groupsOf(ASSET_ORDER);
  const p = groupsOf(LIABILITY_ORDER);
  const sum = (g: AccountGroup): number => (byGroup.get(g) ?? []).reduce((s, x) => s + x.fils, 0);
  const openingF = sum('OPENING_EQUITY');
  const partnerF = sum('PARTNER_EQUITY');
  const incomeF = sum('INCOME');
  const expenseF = sum('EXPENSE');
  const resultF = incomeF - expenseF;
  const equityF = openingF + partnerF + resultF;
  return {
    asOfDate, boundaryIso, status: 'PROVISIONAL',
    assets: a.groups, liabilities: p.groups,
    equity: { opening: toBhd(openingF), partner: toBhd(partnerF), result: toBhd(resultF), income: toBhd(incomeF), expense: toBhd(expenseF), total: toBhd(equityF) },
    totals: { assets: toBhd(a.fils), liabilities: toBhd(p.fils), equityAndResult: toBhd(equityF) },
    difference: toBhd(a.fils - p.fils - equityF),
    imbalance: toBhd(dF - cF),
    unclassified,
  };
}

/** Der gebuchte Saldo eines Kontos vor dem Stichtag, auf der Seite seiner Klasse, in Fils. */
export function sideBalanceBeforeFils(ctx: { branchId: string }, boundaryIso: string, accounts: readonly string[]): number {
  if (accounts.length === 0) return 0;
  let fils = 0;
  for (const l of filsLinesBefore(ctx.branchId, boundaryIso)) {
    if (!accounts.includes(l.account)) continue;
    const info = accountClassOf(l.account);
    fils += info ? sideBalanceFils(info.klass, l.debitF, l.creditF) : l.debitF - l.creditF;
  }
  return fils;
}

// ── Stichtagsliste: jede Buchung vor dem Stichtag ───────────────────────────

export type CutoffTxStatus = 'ACTIVE' | 'REVERSED' | 'REVERSED_AFTER_CUTOFF' | 'REVERSAL';

export interface CutoffTransaction {
  transactionId: string;
  occurredAt: string;
  sourceModule: string;
  sourceId: string;
  /** Belegnummer, soweit auflösbar (Rechnung, Einkauf, Ausgabe, Darlehen, …); sonst Modul und Kennung. */
  document: string;
  status: CutoffTxStatus;
  lines: Array<{ account: string; direction: 'DEBIT' | 'CREDIT'; amount: number; group: AccountGroup | null }>;
  amount: number;
  /** Wirkung auf den Stichtagssaldo je Gruppe (Seite der Gruppe); eine stornierte Buchung samt Storno vor dem Stichtag wirkt zusammen 0. */
  effect: Array<{ group: AccountGroup | 'UNCLASSIFIED'; delta: number }>;
}

export interface CutoffTransactions { asOfDate: string; boundaryIso: string; total: number; truncated: boolean; rows: CutoffTransaction[] }

/** Welche Tabelle die Belegnummer eines Moduls hält (Kennung = source_id). Unbekanntes bleibt Modul + Kennung. */
const DOCUMENT_LOOKUPS: Readonly<Record<string, readonly string[]>> = {
  INVOICE: ['SELECT invoice_number AS n FROM invoices WHERE id = ?'],
  PAYMENT: ['SELECT i.invoice_number AS n FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE p.id = ?', 'SELECT invoice_number AS n FROM invoices WHERE id = ?'],
  CREDIT_NOTE: ['SELECT credit_note_number AS n FROM credit_notes WHERE id = ?'],
  PURCHASE: ['SELECT purchase_number AS n FROM purchases WHERE id = ?'],
  PURCHASE_PAYMENT: ['SELECT p.purchase_number AS n FROM purchase_payments pp JOIN purchases p ON p.id = pp.purchase_id WHERE pp.id = ?', 'SELECT purchase_number AS n FROM purchases WHERE id = ?'],
  PURCHASE_RETURN: ['SELECT purchase_number AS n FROM purchases WHERE id = ?'],
  PURCHASE_OVERPAY: ['SELECT purchase_number AS n FROM purchases WHERE id = ?'],
  EXPENSE: ['SELECT expense_number AS n FROM expenses WHERE id = ?'],
  EXPENSE_PAYMENT: ['SELECT e.expense_number AS n FROM expense_payments ep JOIN expenses e ON e.id = ep.expense_id WHERE ep.id = ?', 'SELECT expense_number AS n FROM expenses WHERE id = ?'],
  LOAN: ['SELECT loan_number AS n FROM debts WHERE id = ?'],
  LOAN_PAYMENT: ['SELECT d.loan_number AS n FROM debt_payments dp JOIN debts d ON d.id = dp.debt_id WHERE dp.id = ?', 'SELECT loan_number AS n FROM debts WHERE id = ?'],
  PARTNER_TX: ['SELECT transaction_number AS n FROM partner_transactions WHERE id = ?'],
  STOCK_ADJUST: ['SELECT adjustment_number AS n FROM stock_adjustments WHERE id = ?'],
  SCRAP_TRADE: ['SELECT trade_number AS n FROM scrap_trades WHERE id = ?'],
  AGENT_TRANSFER_SOLD: ['SELECT transfer_number AS n FROM agent_transfers WHERE id = ?'],
};

function documentOf(module: string, sourceId: string): string {
  if (module === 'OPENING_BALANCE') return 'Opening (settings)';
  for (const sql of DOCUMENT_LOOKUPS[module] ?? []) {
    try {
      const n = query(sql, [sourceId])[0]?.n;
      if (n !== undefined && n !== null && String(n) !== '') return String(n);
    } catch { /* Tabelle/Spalte in dieser Datenbank nicht vorhanden → nächster Versuch */ }
  }
  return `${module} ${sourceId.slice(0, 8)}`;
}

export function cutoffTransactionsFor(ctx: { branchId: string }, asOfDate: string, limit = 1000): CutoffTransactions {
  const boundaryIso = cutoffBoundaryIso(asOfDate);
  const max = Math.max(1, Math.min(5000, Math.floor(Number(limit) || 1000)));
  const total = Number(query('SELECT COUNT(DISTINCT transaction_id) AS n FROM ledger_entries WHERE branch_id = ? AND occurred_at < ?', [ctx.branchId, boundaryIso])[0]?.n) || 0;
  const heads = query(
    `SELECT transaction_id AS tx, MIN(occurred_at) AS at, MIN(entry_no) AS no FROM ledger_entries
      WHERE branch_id = ? AND occurred_at < ? GROUP BY transaction_id ORDER BY at, no LIMIT ?`,
    [ctx.branchId, boundaryIso, max],
  );
  // Wann eine Zeile storniert wurde (eine Abfrage für alle; `reverses_entry_id` hat keinen Index).
  const reversedAtOf = new Map<string, string>();
  for (const r of query(
    'SELECT reverses_entry_id AS id, MIN(occurred_at) AS at FROM ledger_entries WHERE branch_id = ? AND reverses_entry_id IS NOT NULL GROUP BY reverses_entry_id',
    [ctx.branchId],
  )) reversedAtOf.set(String(r.id), String(r.at));
  const rows: CutoffTransaction[] = [];
  for (const h of heads) {
    const tx = String(h.tx);
    const lines = query(
      `SELECT id, account, direction, CAST(ROUND(amount * 1000) AS INTEGER) AS f, source_module, source_id, reverses_entry_id
         FROM ledger_entries WHERE transaction_id = ? AND branch_id = ? ORDER BY entry_no`,
      [tx, ctx.branchId],
    );
    const isReversal = lines.some((l) => l.reverses_entry_id !== null && l.reverses_entry_id !== undefined);
    const reversedAt = lines.map((l) => reversedAtOf.get(String(l.id))).filter((v): v is string => v !== undefined);
    const status: CutoffTxStatus = isReversal ? 'REVERSAL'
      : reversedAt.length === 0 ? 'ACTIVE'
      : reversedAt.every((at) => at < boundaryIso) ? 'REVERSED' : 'REVERSED_AFTER_CUTOFF';
    const effect = new Map<AccountGroup | 'UNCLASSIFIED', number>();
    let debitF = 0;
    const out = lines.map((l) => {
      const f = Number(l.f) || 0;
      const dir = String(l.direction) === 'DEBIT' ? 'DEBIT' as const : 'CREDIT' as const;
      if (dir === 'DEBIT') debitF += f;
      const info = accountClassOf(String(l.account));
      const key = info?.group ?? 'UNCLASSIFIED';
      const delta = info ? sideBalanceFils(info.klass, dir === 'DEBIT' ? f : 0, dir === 'CREDIT' ? f : 0) : (dir === 'DEBIT' ? f : -f);
      effect.set(key, (effect.get(key) ?? 0) + delta);
      return { account: String(l.account), direction: dir, amount: toBhd(f), group: info?.group ?? null };
    });
    const first = lines[0] ?? {};
    rows.push({
      transactionId: tx, occurredAt: String(h.at), sourceModule: String(first.source_module ?? ''), sourceId: String(first.source_id ?? ''),
      document: documentOf(String(first.source_module ?? ''), String(first.source_id ?? '')),
      status, lines: out, amount: toBhd(debitF),
      effect: [...effect.entries()].filter(([, v]) => v !== 0).map(([group, v]) => ({ group, delta: toBhd(v) })),
    });
  }
  return { asOfDate, boundaryIso, total, truncated: total > rows.length, rows };
}

/** Jedes Konto aus `LedgerAccount` ist einer Klasse zugeordnet (für Tests und die Anzeige). */
export const CLASSIFIED_ACCOUNTS: readonly string[] = Object.keys(ACCOUNT_CLASSES);
