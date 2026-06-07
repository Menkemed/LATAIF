// ZIEL.md §3a — Reconciliation View.
// Vergleicht Ledger-Salden (Single Source of Truth) gegen Domain-Aggregate
// (Invoices, Purchases, Expenses, Orders, Debts, Partner-Tx).
// Diskrepanzen sind Hinweise auf:
//   - Backfill-Bedarf (alte Daten ohne Ledger-Eintrag)
//   - manuelle DB-Eingriffe
//   - Bugs im Posting-Wire-Up

import { useEffect, useMemo, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Bhd } from '@/components/ui/Bhd';
import { Button } from '@/components/ui/Button';
import { query, currentBranchId } from '@/core/db/helpers';
import {
  balanceOf,
  ledgerImbalance,
  findImbalancedTransactions,
  type ImbalancedTx,
} from '@/core/ledger/queries';
import { reverseSource, hasReversalFor, type LedgerAccount, type SourceModule } from '@/core/ledger/posting';
import { canonicalLoanDirection } from '@/core/models/types';

const EPSILON = 0.01;        // BHD-Toleranz für "match"
const fmt = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });

interface Row {
  label: string;
  account: LedgerAccount;
  ledger: number;
  domain: number;
  note?: string;
}

interface SourceCount {
  source: string;
  count: number;
  totalDebit: number;
  totalCredit: number;
}

function diff(row: Row): number {
  return row.ledger - row.domain;
}

function status(row: Row): 'ok' | 'mismatch' {
  return Math.abs(diff(row)) < EPSILON ? 'ok' : 'mismatch';
}

// ── Domain-Aggregate ──────────────────────────────────────────
// Pro Account die Erwartung aus den Domain-Tabellen.

function domainAR(branchId: string): number {
  // Ledger-Mechanik:
  //   + DR(AR) pro non-cancelled Invoice (Original bleibt; cancelled hat Reversal-Pair = netto 0)
  //   - CR(AR) pro Payment (auch zu cancelled Invoices: das Geld floss real, AR ↓)
  //   - CR(AR) pro CN.receivableCancelAmount
  // Wir summieren also: gross der aktiven Invoices - ALLE Payments - CN-AR-Cancellations.
  // Wichtig: Payments NICHT über invoices.paid_amount filtern, sondern direkt aus payments-Tabelle —
  // sonst gehen Payments zu later-cancelled Invoices verloren und produzieren einen Phantom-Diff.
  const inv = query(
    `SELECT COALESCE(SUM(gross_amount), 0) AS t
     FROM invoices
     WHERE branch_id = ? AND status != 'CANCELLED'`,
    [branchId]
  );
  const pay = query(
    `SELECT COALESCE(SUM(p.amount), 0) AS t
     FROM payments p JOIN invoices i ON i.id = p.invoice_id
     WHERE i.branch_id = ?`,
    [branchId]
  );
  const cn = query(
    `SELECT COALESCE(SUM(receivable_cancel_amount), 0) AS t
     FROM credit_notes
     WHERE branch_id = ?`,
    [branchId]
  );
  return Number(inv[0]?.t || 0) - Number(pay[0]?.t || 0) - Number(cn[0]?.t || 0);
}

function domainAP(branchId: string): number {
  // Ledger-Mechanik (analog AR):
  //   + CR(AP) pro non-cancelled Purchase und Expense
  //   - DR(AP) pro Purchase-Payment und Expense-Payment (auch zu cancelled — das Geld floss real)
  // Wir vergleichen: aktive Verbindlichkeit - ALLE Payments. Payments zu cancelled Records
  // werden vom Ledger als Supplier-Credit (negative AP) getrackt; Domain muss das gleich tun.
  const purActive = query(
    `SELECT COALESCE(SUM(total_amount), 0) AS t
     FROM purchases
     WHERE branch_id = ? AND status != 'CANCELLED'`,
    [branchId]
  );
  const expActive = query(
    `SELECT COALESCE(SUM(amount), 0) AS t
     FROM expenses
     WHERE branch_id = ? AND status != 'CANCELLED'`,
    [branchId]
  );
  const purPayments = query(
    `SELECT COALESCE(SUM(pp.amount), 0) AS t
     FROM purchase_payments pp JOIN purchases pu ON pu.id = pp.purchase_id
     WHERE pu.branch_id = ?`,
    [branchId]
  );
  const expPayments = query(
    `SELECT COALESCE(SUM(ep.amount), 0) AS t
     FROM expense_payments ep JOIN expenses e ON e.id = ep.expense_id
     WHERE e.branch_id = ?`,
    [branchId]
  );
  return (
    Number(purActive[0]?.t || 0) +
    Number(expActive[0]?.t || 0) -
    Number(purPayments[0]?.t || 0) -
    Number(expPayments[0]?.t || 0)
  );
}

function domainRevenue(branchId: string): number {
  // Ledger-Logik pro Invoice-Line:
  //   CR REVENUE by (line.line_total - line.vat_amount).
  // Wir summieren also line-level, NICHT invoice.net_amount — das Header-Feld
  // kann durch akkumulierte Rundungen abweichen (Σ line_total - Σ vat_amount
  // ≠ Header-net wenn Rundung pro Line gerundet wurde).
  const invRows = query(
    `SELECT COALESCE(SUM(il.line_total - il.vat_amount), 0) AS t
     FROM invoice_lines il
     JOIN invoices i ON i.id = il.invoice_id
     WHERE i.branch_id = ? AND i.status != 'CANCELLED'`,
    [branchId]
  );
  const cnRows = query(
    `SELECT COALESCE(SUM(total_amount - vat_amount), 0) AS t
     FROM credit_notes
     WHERE branch_id = ?`,
    [branchId]
  );
  return Number(invRows[0]?.t || 0) - Number(cnRows[0]?.t || 0);
}

function domainCustomerDeposits(branchId: string): number {
  // Offene Order-Anzahlungen, die noch NICHT in Invoice umgewandelt wurden.
  const rows = query(
    `SELECT COALESCE(SUM(op.amount), 0) AS t
     FROM order_payments op JOIN orders o ON o.id = op.order_id
     WHERE o.branch_id = ? AND COALESCE(op.converted_to_invoice, 0) = 0
       AND o.status != 'cancelled'`,
    [branchId]
  );
  return Number(rows[0]?.t || 0);
}

function domainLoanReceivable(branchId: string): number {
  const rows = query(
    `SELECT d.id, d.direction, d.amount, COALESCE((SELECT SUM(amount) FROM debt_payments WHERE debt_id = d.id), 0) AS paid
     FROM debts d
     WHERE d.branch_id = ? AND UPPER(COALESCE(d.status, 'OPEN')) != 'CANCELLED'`,
    [branchId]
  );
  let sum = 0;
  for (const r of rows) {
    const dir = canonicalLoanDirection(r.direction as string);
    if (dir === 'MONEY_GIVEN') {
      sum += Math.max(0, Number(r.amount || 0) - Number(r.paid || 0));
    }
  }
  return sum;
}

function domainLoanPayable(branchId: string): number {
  const rows = query(
    `SELECT d.id, d.direction, d.amount, COALESCE((SELECT SUM(amount) FROM debt_payments WHERE debt_id = d.id), 0) AS paid
     FROM debts d
     WHERE d.branch_id = ? AND UPPER(COALESCE(d.status, 'OPEN')) != 'CANCELLED'`,
    [branchId]
  );
  let sum = 0;
  for (const r of rows) {
    const dir = canonicalLoanDirection(r.direction as string);
    if (dir === 'MONEY_RECEIVED') {
      sum += Math.max(0, Number(r.amount || 0) - Number(r.paid || 0));
    }
  }
  return sum;
}

function domainPartnerEquity(branchId: string): number {
  // Invest - Withdrawal - ProfitDistribution.
  const rows = query(
    `SELECT type, COALESCE(SUM(amount), 0) AS t
     FROM partner_transactions
     WHERE branch_id = ?
     GROUP BY type`,
    [branchId]
  );
  let invest = 0, withdraw = 0, profit = 0;
  for (const r of rows) {
    const t = Number(r.t || 0);
    if (r.type === 'INVESTMENT') invest = t;
    else if (r.type === 'WITHDRAWAL') withdraw = t;
    else if (r.type === 'PROFIT_DISTRIBUTION') profit = t;
  }
  return invest - withdraw - profit;
}

// Orphans: Ledger-Einträge, deren source_id keine Domain-Row mehr hat.
// Typische Ursache: LedgerDebugPage-Tests, manuelle DB-Eingriffe, oder
// gelöschte Domain-Records. Verschmutzen Account-Salden ohne Domain-Match.
interface Orphan {
  sourceModule: string;
  sourceId: string;
  count: number;
  totalAmount: number;
}

const SOURCE_TABLE_MAP: Record<string, string> = {
  INVOICE: 'invoices',
  PAYMENT: 'payments',
  CREDIT_NOTE: 'credit_notes',
  PURCHASE: 'purchases',
  PURCHASE_PAYMENT: 'purchase_payments',
  EXPENSE: 'expenses',
  EXPENSE_PAYMENT: 'expense_payments',
  METAL_PAYMENT: 'metal_payments',
  ORDER_PAYMENT: 'order_payments',
  LOAN: 'debts',
  LOAN_PAYMENT: 'debt_payments',
  PARTNER_TX: 'partner_transactions',
  TAX_PAYMENT: 'tax_payments',
  BANK_TRANSFER: 'bank_transfers',
};

function loadOrphans(branchId: string): Orphan[] {
  const out: Orphan[] = [];
  for (const [src, tbl] of Object.entries(SOURCE_TABLE_MAP)) {
    let rows: Record<string, unknown>[] = [];
    try {
      // Originale ohne Domain-Row UND ohne bereits existierende Reversal-Buchung.
      // Sobald eine Reversal-Tx existiert, gilt der Orphan als "neutralisiert" —
      // im Ledger bleiben die Einträge stehen (immutable), Salden sind aber bereinigt.
      rows = query(
        `SELECT le.source_id AS sid,
                COUNT(*) AS c,
                COALESCE(SUM(CASE WHEN le.direction='DEBIT' THEN le.amount ELSE 0 END), 0) AS amt
         FROM ledger_entries le
         WHERE le.branch_id = ? AND le.source_module = ?
           AND le.reverses_entry_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM ${tbl} t WHERE t.id = le.source_id)
           AND NOT EXISTS (
             SELECT 1 FROM ledger_entries r
             WHERE r.source_module = le.source_module
               AND r.source_id = le.source_id
               AND r.reverses_entry_id IS NOT NULL
           )
         GROUP BY le.source_id`,
        [branchId, src]
      );
    } catch {
      // Tabelle existiert evtl. nicht (z.B. tax_payments) — in dem Fall gilt jeder
      // Eintrag als Orphan, was ungenau wäre. Wir überspringen.
      continue;
    }
    for (const r of rows) {
      out.push({
        sourceModule: src,
        sourceId: r.sid as string,
        count: Number(r.c || 0),
        totalAmount: Number(r.amt || 0),
      });
    }
  }
  return out;
}

function loadSourceCounts(branchId: string): SourceCount[] {
  const rows = query(
    `SELECT source_module,
            COUNT(*) AS c,
            COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE 0 END), 0) AS d,
            COALESCE(SUM(CASE WHEN direction='CREDIT' THEN amount ELSE 0 END), 0) AS c2
     FROM ledger_entries
     WHERE branch_id = ?
     GROUP BY source_module
     ORDER BY c DESC`,
    [branchId]
  );
  return rows.map(r => ({
    source: r.source_module as string,
    count: Number(r.c || 0),
    totalDebit: Number(r.d || 0),
    totalCredit: Number(r.c2 || 0),
  }));
}

export function ReconciliationPage() {
  const [refreshTick, setRefreshTick] = useState(0);

  const data = useMemo(() => {
    let branchId = 'branch-main';
    try { branchId = currentBranchId(); } catch { /* */ }

    const rows: Row[] = [
      { label: 'Accounts Receivable',    account: 'ACCOUNTS_RECEIVABLE', ledger: balanceOf('ACCOUNTS_RECEIVABLE'), domain: domainAR(branchId),
        note: 'Domain = Σ invoice (gross − paid) − Σ CN.receivableCancelAmount.' },
      { label: 'Accounts Payable',       account: 'ACCOUNTS_PAYABLE',    ledger: balanceOf('ACCOUNTS_PAYABLE'),    domain: domainAP(branchId),
        note: 'Domain = Σ aktive (Purchase+Expense) − Σ alle Payments (auch zu cancelled).' },
      { label: 'Revenue (net)',          account: 'REVENUE',             ledger: balanceOf('REVENUE'),             domain: domainRevenue(branchId),
        note: 'Domain = Σ (line.line_total − line.vat_amount) − Σ CN.net (line-level wie Ledger).' },
      { label: 'Customer Deposits',      account: 'CUSTOMER_DEPOSITS',   ledger: balanceOf('CUSTOMER_DEPOSITS'),   domain: domainCustomerDeposits(branchId),
        note: 'Domain = noch nicht in Invoice umgewandelte Order-Anzahlungen.' },
      { label: 'Loan Receivable',        account: 'LOAN_RECEIVABLE',     ledger: balanceOf('LOAN_RECEIVABLE'),     domain: domainLoanReceivable(branchId),
        note: 'Domain = Σ verliehen − Σ zurückerhalten (we_lend / MONEY_GIVEN).' },
      { label: 'Loan Payable',           account: 'LOAN_PAYABLE',        ledger: balanceOf('LOAN_PAYABLE'),        domain: domainLoanPayable(branchId),
        note: 'Domain = Σ geliehen − Σ zurückgezahlt (we_borrow / MONEY_RECEIVED).' },
      { label: 'Partner Equity',         account: 'PARTNER_EQUITY',      ledger: balanceOf('PARTNER_EQUITY'),      domain: domainPartnerEquity(branchId),
        note: 'Domain = Σ Investments − Σ Withdrawals − Σ Profit-Distributions.' },
    ];

    const branchImbalance = ledgerImbalance(branchId);
    const broken: ImbalancedTx[] = findImbalancedTransactions(branchId);
    const sources = loadSourceCounts(branchId);
    const orphans = loadOrphans(branchId);

    return { rows, branchImbalance, broken, sources, orphans, branchId };
  }, [refreshTick]);

  useEffect(() => {
    // initial paint already covered by useMemo, refresh on mount once.
  }, []);

  const mismatches = data.rows.filter(r => status(r) === 'mismatch').length;

  return (
    <div style={{ padding: 24, maxWidth: 1280, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <h1 style={{ fontSize: 28, fontWeight: 600 }}>Reconciliation</h1>
        <Button onClick={() => setRefreshTick(t => t + 1)}>Refresh</Button>
      </div>
      <p style={{ color: '#6B7280', fontSize: 13, marginBottom: 24 }}>
        Vergleicht Ledger-Salden gegen Domain-Aggregate. Treffer = ✓, Diskrepanz = ✗.
        Diskrepanzen können auf Backfill-Bedarf, manuelle DB-Eingriffe oder Posting-Bugs hinweisen.
      </p>

      {/* Health Check */}
      <Card className="mb-4">
        <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Bilanz-Health</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          <HealthBox
            label="Branch-Imbalance"
            value={fmt(data.branchImbalance)}
            ok={Math.abs(data.branchImbalance) < EPSILON}
            hint="Σ DEBIT − Σ CREDIT muss 0 sein"
          />
          <HealthBox
            label="Unbalancierte Transaktionen"
            value={String(data.broken.length)}
            ok={data.broken.length === 0}
            hint="Pro transaction_id: SUM(DR)=SUM(CR)"
          />
          <HealthBox
            label="Account-Mismatches"
            value={`${mismatches} / ${data.rows.length}`}
            ok={mismatches === 0}
            hint="Ledger-vs-Domain Vergleich"
          />
          <HealthBox
            label="Orphan-Einträge"
            value={String(data.orphans.length)}
            ok={data.orphans.length === 0}
            hint="Ledger-Posts ohne Domain-Row"
          />
        </div>
      </Card>

      {/* Reconciliation Rows */}
      <Card noPadding className="mb-4">
        <div style={{ padding: 16, borderBottom: '1px solid #E5E9EE' }}>
          <h3 style={{ fontSize: 14, fontWeight: 600 }}>Account-Comparison</h3>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#F4F6F9', textAlign: 'left' }}>
                <th style={{ padding: 10 }}>Account</th>
                <th style={{ padding: 10, textAlign: 'right' }}>Ledger</th>
                <th style={{ padding: 10, textAlign: 'right' }}>Domain</th>
                <th style={{ padding: 10, textAlign: 'right' }}>Diff</th>
                <th style={{ padding: 10, width: 40 }}>OK</th>
                <th style={{ padding: 10 }}>Note</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map(r => {
                const d = diff(r);
                const ok = status(r) === 'ok';
                return (
                  <tr key={r.account} style={{ borderTop: '1px solid #E5E9EE', background: ok ? 'transparent' : 'rgba(220,38,38,0.04)' }}>
                    <td style={{ padding: 10 }}>
                      <div style={{ fontWeight: 500 }}>{r.label}</div>
                      <div style={{ fontSize: 11, color: '#9CA3AF', fontFamily: 'monospace' }}>{r.account}</div>
                    </td>
                    <td style={{ padding: 10, fontFamily: 'monospace', textAlign: 'right' }}><Bhd v={r.ledger}/></td>
                    <td style={{ padding: 10, fontFamily: 'monospace', textAlign: 'right' }}><Bhd v={r.domain}/></td>
                    <td style={{ padding: 10, fontFamily: 'monospace', textAlign: 'right', color: ok ? '#9CA3AF' : '#DC2626', fontWeight: ok ? 400 : 600 }}>
                      <Bhd v={d}/>
                    </td>
                    <td style={{ padding: 10, textAlign: 'center' }}>
                      <span style={{ fontSize: 16 }}>{ok ? '✓' : '✗'}</span>
                    </td>
                    <td style={{ padding: 10, fontSize: 11, color: '#6B7280' }}>{r.note}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Per-Source Breakdown */}
      <Card noPadding className="mb-4">
        <div style={{ padding: 16, borderBottom: '1px solid #E5E9EE' }}>
          <h3 style={{ fontSize: 14, fontWeight: 600 }}>Ledger-Einträge nach Source</h3>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#F4F6F9', textAlign: 'left' }}>
                <th style={{ padding: 10 }}>Source-Module</th>
                <th style={{ padding: 10, textAlign: 'right' }}>Einträge</th>
                <th style={{ padding: 10, textAlign: 'right' }}>Σ Debit</th>
                <th style={{ padding: 10, textAlign: 'right' }}>Σ Credit</th>
                <th style={{ padding: 10, textAlign: 'right' }}>Δ</th>
              </tr>
            </thead>
            <tbody>
              {data.sources.length === 0 ? (
                <tr><td colSpan={5} style={{ padding: 20, textAlign: 'center', color: '#9CA3AF' }}>Keine Ledger-Einträge.</td></tr>
              ) : data.sources.map(s => {
                const delta = s.totalDebit - s.totalCredit;
                const balanced = Math.abs(delta) < EPSILON;
                return (
                  <tr key={s.source} style={{ borderTop: '1px solid #E5E9EE' }}>
                    <td style={{ padding: 10, fontFamily: 'monospace' }}>{s.source}</td>
                    <td style={{ padding: 10, fontFamily: 'monospace', textAlign: 'right' }}>{s.count}</td>
                    <td style={{ padding: 10, fontFamily: 'monospace', textAlign: 'right' }}><Bhd v={s.totalDebit}/></td>
                    <td style={{ padding: 10, fontFamily: 'monospace', textAlign: 'right' }}><Bhd v={s.totalCredit}/></td>
                    <td style={{ padding: 10, fontFamily: 'monospace', textAlign: 'right', color: balanced ? '#9CA3AF' : '#DC2626' }}><Bhd v={delta}/></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Orphan Ledger Entries */}
      {data.orphans.length > 0 && (
        <Card noPadding className="mb-4">
          <div style={{ padding: 16, borderBottom: '1px solid #E5E9EE', background: 'rgba(217,119,6,0.06)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
            <div>
              <h3 style={{ fontSize: 14, fontWeight: 600, color: '#B45309' }}>
                Orphan-Ledger-Einträge ({data.orphans.length})
              </h3>
              <p style={{ fontSize: 12, color: '#6B7280', marginTop: 4 }}>
                Ledger-Buchungen, deren source_id keine Domain-Row mehr hat. Typische Ursachen:
                LedgerDebugPage-Tests, manuelle DB-Eingriffe, gelöschte Domain-Records. Verschmutzen
                Account-Salden ohne Domain-Match — daher Quelle für Reconciliation-Diffs.
              </p>
            </div>
            <Button
              onClick={() => {
                if (!confirm(`Storniert alle ${data.orphans.length} Orphan-Buchungen via reverseSource (Ledger bleibt immutable). Fortfahren?`)) return;
                let ok = 0, skipped = 0, failed = 0;
                for (const o of data.orphans) {
                  try {
                    if (hasReversalFor(o.sourceModule as SourceModule, o.sourceId)) { skipped++; continue; }
                    reverseSource(o.sourceModule as SourceModule, o.sourceId, new Date().toISOString());
                    ok++;
                  } catch { failed++; }
                }
                alert(`Reversed: ${ok} · already reversed: ${skipped} · failed: ${failed}`);
                setRefreshTick(t => t + 1);
              }}
            >
              Storniere alle Orphans
            </Button>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#F4F6F9', textAlign: 'left' }}>
                  <th style={{ padding: 8 }}>Source-Module</th>
                  <th style={{ padding: 8 }}>Source-ID</th>
                  <th style={{ padding: 8, textAlign: 'right' }}>Einträge</th>
                  <th style={{ padding: 8, textAlign: 'right' }}>Σ Debit</th>
                </tr>
              </thead>
              <tbody>
                {data.orphans.slice(0, 30).map(o => (
                  <tr key={`${o.sourceModule}-${o.sourceId}`} style={{ borderTop: '1px solid #E5E9EE' }}>
                    <td style={{ padding: 8, fontFamily: 'monospace' }}>{o.sourceModule}</td>
                    <td style={{ padding: 8, fontFamily: 'monospace', color: '#6B7280' }}>
                      {o.sourceId.slice(0, 8)}…{o.sourceId.slice(-4)}
                    </td>
                    <td style={{ padding: 8, fontFamily: 'monospace', textAlign: 'right' }}>{o.count}</td>
                    <td style={{ padding: 8, fontFamily: 'monospace', textAlign: 'right' }}><Bhd v={o.totalAmount}/></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Broken Transactions Drill-Down */}
      {data.broken.length > 0 && (
        <Card noPadding className="mb-4">
          <div style={{ padding: 16, borderBottom: '1px solid #E5E9EE', background: 'rgba(220,38,38,0.06)' }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, color: '#DC2626' }}>Unbalancierte Transaktionen ({data.broken.length})</h3>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#F4F6F9', textAlign: 'left' }}>
                  <th style={{ padding: 8 }}>Transaction</th>
                  <th style={{ padding: 8 }}>Source</th>
                  <th style={{ padding: 8, textAlign: 'right' }}>Debit</th>
                  <th style={{ padding: 8, textAlign: 'right' }}>Credit</th>
                  <th style={{ padding: 8, textAlign: 'right' }}>Diff</th>
                </tr>
              </thead>
              <tbody>
                {data.broken.slice(0, 30).map(b => (
                  <tr key={b.transactionId} style={{ borderTop: '1px solid #E5E9EE' }}>
                    <td style={{ padding: 8, fontFamily: 'monospace' }}>{b.transactionId.slice(0, 8)}…</td>
                    <td style={{ padding: 8, fontFamily: 'monospace' }}>{b.sourceModule}/{b.sourceId.slice(0, 6)}</td>
                    <td style={{ padding: 8, fontFamily: 'monospace', textAlign: 'right' }}><Bhd v={b.debit}/></td>
                    <td style={{ padding: 8, fontFamily: 'monospace', textAlign: 'right' }}><Bhd v={b.credit}/></td>
                    <td style={{ padding: 8, fontFamily: 'monospace', textAlign: 'right', color: '#DC2626' }}><Bhd v={b.diff}/></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

interface HealthBoxProps { label: string; value: string; ok: boolean; hint: string; }

function HealthBox({ label, value, ok, hint }: HealthBoxProps) {
  return (
    <div style={{
      padding: 14,
      border: '1px solid #E5E9EE',
      borderRadius: 10,
      background: ok ? 'rgba(22,163,74,0.05)' : 'rgba(220,38,38,0.05)',
    }}>
      <div style={{ fontSize: 12, color: '#6B7280', marginBottom: 4 }}>{label}</div>
      <div style={{
        fontSize: 22, fontWeight: 600, fontFamily: 'monospace',
        color: ok ? '#16A34A' : '#DC2626',
      }}>
        {ok ? '✓ ' : '✗ '}{value}
      </div>
      <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 4 }}>{hint}</div>
    </div>
  );
}
