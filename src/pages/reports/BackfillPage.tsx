// ZIEL.md §3a — Backfill UI.
// Replay aller historischen Domain-Records durch den Posting-Service. Idempotent.
// Nach erfolgreichem Run sollte die Reconciliation-Page Diff=0 für die betroffenen
// Konten zeigen.

import { useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { currentBranchId, query } from '@/core/db/helpers';
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

interface ARRow {
  id: string;
  occurred_at: string;
  direction: string;
  amount: number;
  source_module: string;
  source_id: string;
  reverses_entry_id: string | null;
  metadata: string | null;
}

const fmt = (n: number) => n.toLocaleString('en-US');

export function BackfillPage() {
  const [results, setResults] = useState<BackfillResult[]>([]);
  const [running, setRunning] = useState(false);
  const [auditQuery, setAuditQuery] = useState('');
  const [auditRows, setAuditRows] = useState<ARRow[]>([]);
  const [auditCustomer, setAuditCustomer] = useState<{ id: string; name: string } | null>(null);
  const [auditError, setAuditError] = useState<string | null>(null);

  function runCustomerAudit() {
    setAuditError(null);
    setAuditRows([]);
    setAuditCustomer(null);
    const q = auditQuery.trim();
    if (!q) { setAuditError('Customer name or ID required'); return; }

    let customerId: string | null = null;
    let customerName = '';
    try {
      const exact = query(`SELECT id, first_name, last_name FROM customers WHERE id = ?`, [q]);
      if (exact.length > 0) {
        customerId = exact[0].id as string;
        customerName = `${exact[0].first_name} ${exact[0].last_name}`;
      } else {
        const like = `%${q}%`;
        const matches = query(
          `SELECT id, first_name, last_name FROM customers
           WHERE (first_name LIKE ? OR last_name LIKE ? OR (first_name || ' ' || last_name) LIKE ?)
             AND id NOT LIKE 'sys-%'
           LIMIT 5`,
          [like, like, like]
        );
        if (matches.length === 0) { setAuditError(`No customer matches "${q}"`); return; }
        if (matches.length > 1) {
          setAuditError(`${matches.length} matches: ${matches.map(m => `${m.first_name} ${m.last_name}`).join(', ')} — be more specific`);
          return;
        }
        customerId = matches[0].id as string;
        customerName = `${matches[0].first_name} ${matches[0].last_name}`;
      }
    } catch (e) {
      setAuditError(`Lookup failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    if (!customerId) return;
    try {
      const rows = query(
        `SELECT id, occurred_at, direction, amount, source_module, source_id, reverses_entry_id, metadata_json
         FROM ledger_entries
         WHERE account = 'ACCOUNTS_RECEIVABLE'
           AND counterparty_type = 'CUSTOMER'
           AND counterparty_id = ?
         ORDER BY occurred_at ASC, id ASC`,
        [customerId]
      );
      setAuditCustomer({ id: customerId, name: customerName });
      setAuditRows(rows.map(r => ({
        id: r.id as string,
        occurred_at: r.occurred_at as string,
        direction: r.direction as string,
        amount: Number(r.amount || 0),
        source_module: r.source_module as string,
        source_id: r.source_id as string,
        reverses_entry_id: (r.reverses_entry_id as string | null) || null,
        metadata: (r.metadata_json as string | null) || null,
      })));
    } catch (e) {
      setAuditError(`Query failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const auditNet = auditRows.reduce((sum, r) => sum + (r.direction === 'DEBIT' ? r.amount : -r.amount), 0);

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

      <Card className="mb-4">
        <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Customer AR Inspector</h3>
        <p style={{ fontSize: 12, color: '#6B7280', marginBottom: 12 }}>
          Listet ALLE ACCOUNTS_RECEIVABLE-Entries für einen Customer (für Diagnose von Outstanding-Mismatch).
        </p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
          <input
            value={auditQuery}
            onChange={e => setAuditQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') runCustomerAudit(); }}
            placeholder="Customer name or ID (e.g. Sara)"
            style={{
              flex: 1, padding: '6px 10px', fontSize: 13,
              border: '1px solid #D5D9DE', borderRadius: 6, background: '#FFFFFF',
            }}
          />
          <Button onClick={runCustomerAudit}>Inspect</Button>
        </div>
        {auditError && (
          <div style={{ padding: 10, fontSize: 12, color: '#DC2626', background: 'rgba(220,38,38,0.06)', borderRadius: 6 }}>
            {auditError}
          </div>
        )}
        {auditCustomer && (
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 12, marginBottom: 8, color: '#0F0F10' }}>
              <strong>{auditCustomer.name}</strong> ({auditCustomer.id})
              {' — '}
              {auditRows.length} entries{' — '}
              <span style={{ color: auditNet > 0 ? '#DC2626' : auditNet < 0 ? '#3D7FFF' : '#16A34A', fontFamily: 'monospace' }}>
                Net AR = {auditNet.toLocaleString('en-US')} BHD
              </span>
            </div>
            {auditRows.length > 0 && (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse', fontFamily: 'monospace' }}>
                  <thead>
                    <tr style={{ background: '#F4F6F9', textAlign: 'left' }}>
                      <th style={{ padding: 6 }}>Occurred</th>
                      <th style={{ padding: 6 }}>Dir</th>
                      <th style={{ padding: 6, textAlign: 'right' }}>Amount</th>
                      <th style={{ padding: 6 }}>Source</th>
                      <th style={{ padding: 6 }}>Source ID</th>
                      <th style={{ padding: 6 }}>Reverses</th>
                      <th style={{ padding: 6 }}>Metadata</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditRows.map(r => (
                      <tr key={r.id} style={{
                        borderTop: '1px solid #E5E9EE',
                        background: r.reverses_entry_id ? 'rgba(113,93,227,0.04)' : 'transparent',
                      }}>
                        <td style={{ padding: 6 }}>{r.occurred_at?.slice(0, 19).replace('T', ' ')}</td>
                        <td style={{ padding: 6, color: r.direction === 'DEBIT' ? '#DC2626' : '#3D7FFF' }}>{r.direction}</td>
                        <td style={{ padding: 6, textAlign: 'right' }}>{r.amount.toLocaleString('en-US')}</td>
                        <td style={{ padding: 6 }}>{r.source_module}</td>
                        <td style={{ padding: 6, fontSize: 10, color: '#6B7280' }}>{r.source_id?.slice(0, 8)}…</td>
                        <td style={{ padding: 6, fontSize: 10, color: '#715DE3' }}>{r.reverses_entry_id ? r.reverses_entry_id.slice(0, 8) + '…' : ''}</td>
                        <td style={{ padding: 6, fontSize: 10, color: '#6B7280', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {r.metadata || ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
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
