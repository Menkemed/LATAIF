// ZIEL.md §3a — Backfill UI.
// Replay aller historischen Domain-Records durch den Posting-Service. Idempotent.
// Nach erfolgreichem Run sollte die Reconciliation-Page Diff=0 für die betroffenen
// Konten zeigen.

import { useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { currentBranchId } from '@/core/db/helpers';
import {
  backfillAll,
  backfillInvoices,
  backfillInvoicePayments,
  backfillCreditNotes,
  backfillPurchases,
  backfillPurchasePayments,
  backfillExpenses,
  backfillExpensePayments,
  backfillBankTransfers,
  backfillOrderPayments,
  backfillDebts,
  backfillDebtPayments,
  backfillPartnerTransactions,
  backfillTaxPayments,
  backfillMetalPayments,
  backfillAgentSettlementPayments,
  backfillConsignmentPayouts,
  type BackfillResult,
} from '@/core/ledger/backfill';

const fmt = (n: number) => n.toLocaleString('en-US');

export function BackfillPage() {
  const [results, setResults] = useState<BackfillResult[]>([]);
  const [running, setRunning] = useState(false);

  function withBranch(fn: (branchId: string) => BackfillResult): () => void {
    return () => {
      let branchId = 'branch-main';
      try { branchId = currentBranchId(); } catch { /* */ }
      setRunning(true);
      try {
        const res = fn(branchId);
        setResults(prev => [res, ...prev].slice(0, 50));
      } finally {
        setRunning(false);
      }
    };
  }

  function runAll() {
    let branchId = 'branch-main';
    try { branchId = currentBranchId(); } catch { /* */ }
    setRunning(true);
    try {
      const res = backfillAll(branchId);
      setResults(res);
    } finally {
      setRunning(false);
    }
  }

  const totals = results.reduce(
    (acc, r) => ({
      total:   acc.total   + r.total,
      posted:  acc.posted  + r.posted,
      skipped: acc.skipped + r.skipped,
      failed:  acc.failed  + r.failed,
    }),
    { total: 0, posted: 0, skipped: 0, failed: 0 }
  );

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: '0 auto' }}>
      <h1 style={{ fontSize: 28, fontWeight: 600, marginBottom: 8 }}>Ledger Backfill</h1>
      <p style={{ color: '#6B7280', fontSize: 13, marginBottom: 24 }}>
        Schickt historische Domain-Records (Invoices, Purchases, Expenses, …) durch den
        Posting-Service. Idempotent — bestehende Buchungen werden übersprungen.
      </p>

      <Card className="mb-4">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button onClick={runAll} disabled={running}>{running ? '…' : 'Backfill ALL'}</Button>
          <Button onClick={withBranch(backfillInvoices)} disabled={running}>Invoices</Button>
          <Button onClick={withBranch(backfillInvoicePayments)} disabled={running}>Invoice-Payments</Button>
          <Button onClick={withBranch(backfillCreditNotes)} disabled={running}>Credit-Notes</Button>
          <Button onClick={withBranch(backfillPurchases)} disabled={running}>Purchases</Button>
          <Button onClick={withBranch(backfillPurchasePayments)} disabled={running}>Purchase-Payments</Button>
          <Button onClick={withBranch(backfillExpenses)} disabled={running}>Expenses</Button>
          <Button onClick={withBranch(backfillExpensePayments)} disabled={running}>Expense-Payments</Button>
          <Button onClick={withBranch(backfillBankTransfers)} disabled={running}>Bank-Transfers</Button>
          <Button onClick={withBranch(backfillOrderPayments)} disabled={running}>Order-Payments</Button>
          <Button onClick={withBranch(backfillDebts)} disabled={running}>Debts</Button>
          <Button onClick={withBranch(backfillDebtPayments)} disabled={running}>Debt-Payments</Button>
          <Button onClick={withBranch(backfillPartnerTransactions)} disabled={running}>Partner-Tx</Button>
          <Button onClick={withBranch(backfillTaxPayments)} disabled={running}>Tax-Payments</Button>
          <Button onClick={withBranch(backfillMetalPayments)} disabled={running}>Metal-Payments</Button>
          <Button onClick={withBranch(backfillAgentSettlementPayments)} disabled={running}>Agent-Settlements</Button>
          <Button onClick={withBranch(backfillConsignmentPayouts)} disabled={running}>Consignment-Payouts</Button>
        </div>
      </Card>

      {results.length > 0 && (
        <Card noPadding className="mb-4">
          <div style={{ padding: 16, borderBottom: '1px solid #E5E9EE', display: 'flex', justifyContent: 'space-between' }}>
            <h3 style={{ fontSize: 14, fontWeight: 600 }}>Results</h3>
            <div style={{ fontSize: 12, color: '#6B7280' }}>
              Σ total {fmt(totals.total)} · posted {fmt(totals.posted)} · skipped {fmt(totals.skipped)} · failed {fmt(totals.failed)}
            </div>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#F4F6F9', textAlign: 'left' }}>
                  <th style={{ padding: 10 }}>Domain</th>
                  <th style={{ padding: 10, textAlign: 'right' }}>Total</th>
                  <th style={{ padding: 10, textAlign: 'right' }}>Posted</th>
                  <th style={{ padding: 10, textAlign: 'right' }}>Skipped</th>
                  <th style={{ padding: 10, textAlign: 'right' }}>Failed</th>
                  <th style={{ padding: 10 }}>Errors</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r, i) => (
                  <tr key={i} style={{ borderTop: '1px solid #E5E9EE', background: r.failed > 0 ? 'rgba(220,38,38,0.04)' : 'transparent' }}>
                    <td style={{ padding: 10, fontFamily: 'monospace' }}>{r.domain}</td>
                    <td style={{ padding: 10, fontFamily: 'monospace', textAlign: 'right' }}>{fmt(r.total)}</td>
                    <td style={{ padding: 10, fontFamily: 'monospace', textAlign: 'right', color: r.posted > 0 ? '#16A34A' : '#9CA3AF' }}>{fmt(r.posted)}</td>
                    <td style={{ padding: 10, fontFamily: 'monospace', textAlign: 'right', color: '#6B7280' }}>{fmt(r.skipped)}</td>
                    <td style={{ padding: 10, fontFamily: 'monospace', textAlign: 'right', color: r.failed > 0 ? '#DC2626' : '#9CA3AF' }}>{fmt(r.failed)}</td>
                    <td style={{ padding: 10, fontSize: 11, color: '#DC2626', maxWidth: 400 }}>
                      {r.errors.slice(0, 3).map((e, j) => <div key={j} style={{ fontFamily: 'monospace' }}>{e}</div>)}
                      {r.errors.length > 3 && <div style={{ color: '#9CA3AF' }}>+ {r.errors.length - 3} weitere</div>}
                    </td>
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
