// ═══════════════════════════════════════════════════════════
// LATAIF — Central Financial Ledger: Read-Side Queries
// ZIEL.md §3a — Dashboards/Customer-360/Cashflow lesen IMMER hier.
// ═══════════════════════════════════════════════════════════

import { query, currentBranchId } from '@/core/db/helpers';
import type { LedgerAccount, CounterpartyType } from './posting';

// ── Account-Konvention ────────────────────────────────────────
//
// Pro Konto definieren wir das "natürliche" Vorzeichen:
//   ASSET (CASH, BANK, CARD_CLEARING, AR, INVENTORY)        → DEBIT positiv
//   LIABILITY (AP, VAT_OUTPUT, MARGIN_VAT, COMMISSION_*)    → CREDIT positiv
//   INCOME (REVENUE)                                         → CREDIT positiv
//   EXPENSE (COGS, REFUNDS, CARD_FEES, EXPENSES_*, TAX_PAID) → DEBIT positiv
//
// `balanceOf` liefert das "wirtschaftlich sinnvolle" Vorzeichen:
//   - CASH-Saldo: positiv = Geld da
//   - REVENUE: positiv = Umsatz erzielt
//   - AR: positiv = Kunde schuldet uns
//   - AP: positiv = wir schulden Lieferanten

const NATURAL_DEBIT: Set<LedgerAccount> = new Set([
  'CASH',
  'BANK',
  'CARD_CLEARING',
  'ACCOUNTS_RECEIVABLE',
  'INVENTORY',
  'COGS',
  'REFUNDS',
  'CARD_FEES',
  'EXPENSES_OPERATING',
  'TAX_PAID',
  'INTERNAL_TRANSFER',
  'VAT_INPUT',
  // Supplier-Credit: wir halten Guthaben beim Lieferanten (Asset, DEBIT-natur).
  // Aufladung via Purchase-Return refundMethod='credit'. Verbrauch via 'credit'-Payment.
  'SUPPLIER_CREDIT',
  // Loan-Receivable: wir haben Geld verliehen (MONEY_GIVEN). Asset, DEBIT-natur.
  'LOAN_RECEIVABLE',
]);

function naturalSign(account: LedgerAccount): 1 | -1 {
  return NATURAL_DEBIT.has(account) ? 1 : -1;
}

// ── Filter-Shape ──────────────────────────────────────────────

export interface BalanceFilter {
  branchId?: string;
  fromISO?: string;       // inclusive
  untilISO?: string;      // exclusive
  counterpartyType?: CounterpartyType;
  counterpartyId?: string;
  sourceModule?: string;
}

// ── balanceOf(account) ────────────────────────────────────────
//
// Nettosaldo eines Kontos. Vorzeichen ist das natürliche
// (Cash positiv = Geld da, AR positiv = Kunde schuldet uns).

export function balanceOf(account: LedgerAccount, filter: BalanceFilter = {}): number {
  const branchId = filter.branchId ?? currentBranchId();
  const where: string[] = [`branch_id = ?`, `account = ?`];
  const params: unknown[] = [branchId, account];

  if (filter.fromISO)            { where.push(`occurred_at >= ?`);      params.push(filter.fromISO); }
  if (filter.untilISO)           { where.push(`occurred_at < ?`);       params.push(filter.untilISO); }
  if (filter.counterpartyType)   { where.push(`counterparty_type = ?`); params.push(filter.counterpartyType); }
  if (filter.counterpartyId)     { where.push(`counterparty_id = ?`);   params.push(filter.counterpartyId); }
  if (filter.sourceModule)       { where.push(`source_module = ?`);     params.push(filter.sourceModule); }

  const rows = query(
    `SELECT
       COALESCE(SUM(CASE WHEN direction = 'DEBIT'  THEN amount ELSE 0 END), 0) AS debit_total,
       COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END), 0) AS credit_total
     FROM ledger_entries
     WHERE ${where.join(' AND ')}`,
    params
  );
  const debit  = (rows[0]?.debit_total  as number) || 0;
  const credit = (rows[0]?.credit_total as number) || 0;
  return naturalSign(account) === 1 ? (debit - credit) : (credit - debit);
}

// ── Customer-Saldo (offene Forderung) ─────────────────────────

export function customerBalance(customerId: string, branchId?: string): number {
  return balanceOf('ACCOUNTS_RECEIVABLE', {
    branchId,
    counterpartyType: 'CUSTOMER',
    counterpartyId: customerId,
  });
}

// ── Supplier-Saldo (offene Verbindlichkeit) ───────────────────

export function supplierBalance(supplierId: string, branchId?: string): number {
  return balanceOf('ACCOUNTS_PAYABLE', {
    branchId,
    counterpartyType: 'SUPPLIER',
    counterpartyId: supplierId,
  });
}

// ── Cashflow für eine Periode ─────────────────────────────────
//
// Liefert Zu- und Abflüsse je Cash-Konto im Zeitraum.

export interface CashflowSnapshot {
  cash: number;          // CASH-Bewegung (Debit - Credit) in Periode
  bank: number;          // BANK-Bewegung
  card: number;          // CARD_CLEARING-Bewegung
  refunds: number;       // REFUNDS gebucht (Auszahlungen an Kunden)
  taxPaid: number;       // TAX_PAID
  cardFees: number;      // CARD_FEES
  netInflow: number;     // cash + bank + card - refunds - cardFees - taxPaid
}

export function cashflow(
  fromISO: string,
  untilISO: string,
  branchId?: string
): CashflowSnapshot {
  const f = { branchId, fromISO, untilISO };
  const cash     = balanceOf('CASH', f);
  const bank     = balanceOf('BANK', f);
  const card     = balanceOf('CARD_CLEARING', f);
  const refunds  = balanceOf('REFUNDS', f);
  const taxPaid  = balanceOf('TAX_PAID', f);
  const cardFees = balanceOf('CARD_FEES', f);
  const netInflow = cash + bank + card - refunds - cardFees - taxPaid;
  return { cash, bank, card, refunds, taxPaid, cardFees, netInflow };
}

// ── Revenue-Snapshot für eine Periode ─────────────────────────

export interface RevenueSnapshot {
  netRevenue: number;
  vatOutput: number;
  marginVat: number;
  refunds: number;
  grossRevenue: number;     // netRevenue + vatOutput + marginVat
  effectiveRevenue: number; // grossRevenue - refunds
}

export function revenueSnapshot(
  fromISO: string,
  untilISO: string,
  branchId?: string
): RevenueSnapshot {
  const f = { branchId, fromISO, untilISO };
  const netRevenue = balanceOf('REVENUE', f);
  const vatOutput  = balanceOf('VAT_OUTPUT', f);
  const marginVat  = balanceOf('MARGIN_VAT', f);
  const refunds    = balanceOf('REFUNDS', f);
  const grossRevenue = netRevenue + vatOutput + marginVat;
  return {
    netRevenue,
    vatOutput,
    marginVat,
    refunds,
    grossRevenue,
    effectiveRevenue: grossRevenue - refunds,
  };
}

// ── Bilanz-Sanity-Check (Reconciliation) ──────────────────────
//
// Über alle Einträge im Branch muss SUM(DEBIT) = SUM(CREDIT) gelten.
// Differenz != 0 → Bug im Posting-Service oder manueller DB-Eingriff.

export function ledgerImbalance(branchId?: string): number {
  const bId = branchId ?? currentBranchId();
  const rows = query(
    `SELECT
       COALESCE(SUM(CASE WHEN direction = 'DEBIT'  THEN amount ELSE 0 END), 0) AS d,
       COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END), 0) AS c
     FROM ledger_entries
     WHERE branch_id = ?`,
    [bId]
  );
  const d = (rows[0]?.d as number) || 0;
  const c = (rows[0]?.c as number) || 0;
  return d - c;
}

// ── Per-Transaction Bilanz-Check ──────────────────────────────
//
// Findet transaction_ids, deren Soll/Haben nicht netto 0 ergibt.
// Sollte IMMER leer sein. Diagnose-Tool für Reconciliation-View.

export interface ImbalancedTx {
  transactionId: string;
  debit: number;
  credit: number;
  diff: number;
  sourceModule: string;
  sourceId: string;
}

export function findImbalancedTransactions(branchId?: string): ImbalancedTx[] {
  const bId = branchId ?? currentBranchId();
  const rows = query(
    `SELECT transaction_id,
            MAX(source_module) AS source_module,
            MAX(source_id)     AS source_id,
            SUM(CASE WHEN direction = 'DEBIT'  THEN amount ELSE 0 END) AS d,
            SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END) AS c
     FROM ledger_entries
     WHERE branch_id = ?
     GROUP BY transaction_id
     HAVING ABS(d - c) > 0.001`,
    [bId]
  );
  return rows.map(r => ({
    transactionId: r.transaction_id as string,
    sourceModule:  r.source_module as string,
    sourceId:      r.source_id as string,
    debit:         (r.d as number) || 0,
    credit:        (r.c as number) || 0,
    diff:          ((r.d as number) || 0) - ((r.c as number) || 0),
  }));
}
