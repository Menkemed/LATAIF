// ZIEL.md §3a — Reconciliation View.
// Vergleicht Ledger-Salden (Single Source of Truth) gegen Domain-Aggregate
// (Invoices, Purchases, Expenses, Orders, Debts, Partner-Tx).
//
// CENTRAL-UI-PARITY R2D — die RECHNUNG steht nicht mehr hier, sondern in
// `core/reports/reconciliation-snapshot`: dieselbe Funktion am Primary und für die Ferne.
// Diese Datei zeigt nur noch an — und repariert, was der Mensch am Hauptrechner repariert.
import { useState, useEffect } from 'react';
import { Card } from '@/components/ui/Card';
import { Bhd } from '@/components/ui/Bhd';
import { Button } from '@/components/ui/Button';
import { reverseSource, hasReversalFor, type SourceModule } from '@/core/ledger/posting';
import { type CpSection, type CreditIssue } from '@/core/ledger/counterpartyAudit';
import { useAuthStore } from '@/stores/authStore';
import { useSharedRead } from '@/core/data/shared-read';
import { readsFromPrimary } from '@/core/data/primary-source';
import {
  reconciliationSnapshotFor, diff, status, EPSILON,
  type ReconciliationSnapshot,
} from '@/core/reports/reconciliation-snapshot';

const fromFils = (f: number) => f / 1000;
const filsLabel = (f: number) => `${f > 0 ? '+' : ''}${f} fils`;
const shortId = (id: string) => (id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id);
const fmt = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });

/** Solange nichts da ist, wird nichts behauptet: leere Listen statt erfundener Nullen. */
const LEERE_ABSTIMMUNG: ReconciliationSnapshot = {
  rows: [], revenueOther: 0, branchImbalance: 0, broken: [], sources: [], orphans: [],
  branchId: '', counterparty: null, counterpartyError: null,
};

export function ReconciliationPage() {
  const [refreshTick, setRefreshTick] = useState(0);
  const [openCp, setOpenCp] = useState<Record<string, boolean>>({});
  // Reaktiv auf den aktiven Branch: Branch-Wechsel (authStore.switchBranch setzt session
  // neu, ohne Reload) muss die gesamte Reconciliation neu berechnen — daher in den useMemo-Deps.
  const sessionBranchId = useAuthStore(s => s.session?.branchId);

  const data = useSharedRead(
    'page.reconciliation.get', {}, reconciliationSnapshotFor, LEERE_ABSTIMMUNG, [refreshTick, sessionBranchId],
  );

  useEffect(() => {
    // initial paint already covered by useMemo, refresh on mount once.
  }, []);

  const mismatches = data.rows.filter(r => status(r) === 'mismatch').length;

  const cp = data.counterparty;
  const cpErr = data.counterpartyError;
  const cpSections: CpSection[] = cp ? [cp.arByCustomer, cp.customerCreditByCustomer, cp.apBySupplier, cp.supplierCreditBySupplier] : [];
  const cpMismatchTotal = cpSections.reduce((s, x) => s + x.mismatches, 0);
  const cpIssueErrors = cp ? cp.issues.filter(i => i.severity === 'error').length : 0;
  const cpIssueWarnings = cp ? cp.issues.filter(i => i.severity === 'warning').length : 0;
  const toggleCp = (key: string) => setOpenCp(o => ({ ...o, [key]: !o[key] }));

  return (
    // app-content = der scrollende Container des App-Layouts (Shell ist overflow:hidden) —
    // ohne ihn ist die Seite unterhalb des Viewports abgeschnitten und nicht scrollbar.
    <div className="app-content">
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
        {/* M-01: Info-Zeile AUSSERHALB der Vergleichs-Rows (kein Domain-Pendant,
            keine ✓/✗-Logik, kein account-Key-Konflikt mit der REVENUE-Zeile). */}
        <div style={{ padding: '10px 16px', borderTop: '1px solid #E5E9EE', fontSize: 12, color: '#6B7280', display: 'flex', justifyContent: 'space-between' }}>
          <span>
            Other revenue (ledger) {'—'} Repair / Metal / Agent-Sold / Scrap-Spread, ohne Invoice-Pendant; bewusst nicht Teil des Vergleichs:
          </span>
          <span style={{ fontFamily: 'monospace' }}><Bhd v={data.revenueOther}/> BHD</span>
        </div>
      </Card>

      {/* ── Counterparty-Reconciliation (read-only) ─────────────────────── */}
      {cpErr ? (
        <Card className="mb-4">
          <h3 style={{ fontSize: 14, fontWeight: 600, color: '#DC2626', marginBottom: 4 }}>Counterparty-Reconciliation — Fehler</h3>
          <p style={{ fontSize: 13, color: '#DC2626' }}>
            Audit fehlgeschlagen (read-only, keine Daten verändert): {cpErr}
          </p>
          <p style={{ fontSize: 12, color: '#6B7280', marginTop: 6 }}>
            Die globale Reconciliation oben ist davon unberührt. „Refresh" erneut versuchen.
          </p>
        </Card>
      ) : cp ? (
        <>
      <Card className="mb-4">
        <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Counterparty-Health</h3>
        <p style={{ fontSize: 12, color: '#6B7280', marginBottom: 12 }}>
          Pro Kunde / Lieferant: Domain gegen Ledger derselben counterparty_id, fils-genau (Mismatch ab 1 Fils).
          Deckt Abweichungen auf, die sich im Branch-Gesamttotal gegenseitig wegnetten. Rein read-only.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12 }}>
          <HealthBox label="AR by Customer" value={`${cp.arByCustomer.mismatches} ✗ · ${cp.arByCustomer.sumAbsDiffFils}f`} ok={cp.arByCustomer.ok} hint={`${cp.arByCustomer.checked} geprüft`} />
          <HealthBox label="Customer Credit" value={`${cp.customerCreditByCustomer.mismatches} ✗ · ${cp.customerCreditByCustomer.sumAbsDiffFils}f`} ok={cp.customerCreditByCustomer.ok} hint={`${cp.customerCreditByCustomer.checked} geprüft`} />
          <HealthBox label="AP by Supplier" value={`${cp.apBySupplier.mismatches} ✗ · ${cp.apBySupplier.sumAbsDiffFils}f`} ok={cp.apBySupplier.ok} hint={`${cp.apBySupplier.checked} geprüft`} />
          <HealthBox label="Supplier Credit" value={`${cp.supplierCreditBySupplier.mismatches} ✗ · ${cp.supplierCreditBySupplier.sumAbsDiffFils}f`} ok={cp.supplierCreditBySupplier.ok} hint={`${cp.supplierCreditBySupplier.checked} geprüft`} />
          <HealthBox label="Credit Integrity" value={`${cpIssueErrors} err · ${cpIssueWarnings} warn`} ok={cpIssueErrors === 0} hint={`${cp.queryCount} SELECTs gesamt`} />
        </div>
        {(cpMismatchTotal > 0 || cpIssueErrors > 0) && (
          <p style={{ fontSize: 12, color: '#DC2626', marginTop: 10 }}>
            {cpMismatchTotal} Counterparty-Mismatch{cpMismatchTotal === 1 ? '' : 'es'}
            {cpIssueErrors > 0 ? ` · ${cpIssueErrors} Integritäts-Fehler` : ''} — Details unten aufklappen.
          </p>
        )}
      </Card>

      <CpSectionCard section={cp.arByCustomer} open={!!openCp.ar} onToggle={() => toggleCp('ar')} />
      <CpSectionCard section={cp.customerCreditByCustomer} open={!!openCp.cc} onToggle={() => toggleCp('cc')} />
      <CpSectionCard section={cp.apBySupplier} open={!!openCp.ap} onToggle={() => toggleCp('ap')} />
      <CpSectionCard section={cp.supplierCreditBySupplier} open={!!openCp.sc} onToggle={() => toggleCp('sc')} />
      <CreditIssuesCard issues={cp.issues} open={!!openCp.ci} onToggle={() => toggleCp('ci')} />
        </>
      ) : null}

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
            {/* Der Storno SCHREIBT ins Hauptbuch. Er gehoert damit dorthin, wo die Datenbank
                steht — auf einem Rechner ohne Datenbank gibt es ihn nicht, statt ihn anzubieten
                und dann still zu scheitern. Die AUSKUNFT oben ist auf beiden Rechnern dieselbe. */}
            {!readsFromPrimary() && <Button
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
            </Button>}
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

// ── Per-Counterparty Section Card (read-only, aufklappbar) ──────
function CpSectionCard({ section, open, onToggle }: { section: CpSection; open: boolean; onToggle: () => void }) {
  const rows = section.rows.slice(0, 200);
  return (
    <Card noPadding className="mb-4">
      <div
        onClick={onToggle}
        style={{ padding: 16, borderBottom: open ? '1px solid #E5E9EE' : 'none', cursor: 'pointer',
                 background: section.ok ? 'transparent' : 'rgba(220,38,38,0.04)' }}
      >
        <h3 style={{ fontSize: 14, fontWeight: 600, color: section.ok ? '#16A34A' : '#DC2626' }}>
          {open ? '▾' : '▸'} {section.title} {section.ok ? '✓' : '✗'}
        </h3>
        <p style={{ fontSize: 12, color: '#6B7280', marginTop: 4 }}>
          {section.checked} geprüft · {section.mismatches} Mismatch{section.mismatches === 1 ? '' : 'es'} ·
          {' '}Σ|Diff| {section.sumAbsDiffFils} fils · netto {section.netDiffFils} fils ·{' '}
          <span style={{ fontFamily: 'monospace' }}>{section.account}</span>
        </p>
      </div>
      {open && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#F4F6F9', textAlign: 'left' }}>
                <th style={{ padding: 8 }}>Name</th>
                <th style={{ padding: 8 }}>ID</th>
                <th style={{ padding: 8, textAlign: 'right' }}>Domain</th>
                <th style={{ padding: 8, textAlign: 'right' }}>Ledger</th>
                <th style={{ padding: 8, textAlign: 'right' }}>Diff (fils)</th>
                <th style={{ padding: 8, width: 40 }}>OK</th>
                <th style={{ padding: 8 }}>Diagnose</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={7} style={{ padding: 20, textAlign: 'center', color: '#9CA3AF' }}>Keine aktiven Counterparties.</td></tr>
              ) : rows.map(r => {
                const ok = r.status === 'ok';
                return (
                  <tr key={r.id} style={{ borderTop: '1px solid #E5E9EE', background: ok ? 'transparent' : 'rgba(220,38,38,0.04)' }}>
                    <td style={{ padding: 8 }}>{r.name}</td>
                    <td style={{ padding: 8, fontFamily: 'monospace', color: '#9CA3AF' }}>{shortId(r.id)}</td>
                    <td style={{ padding: 8, fontFamily: 'monospace', textAlign: 'right' }}><Bhd v={fromFils(r.domainFils)} /></td>
                    <td style={{ padding: 8, fontFamily: 'monospace', textAlign: 'right' }}><Bhd v={fromFils(r.ledgerFils)} /></td>
                    <td style={{ padding: 8, fontFamily: 'monospace', textAlign: 'right', color: ok ? '#9CA3AF' : '#DC2626', fontWeight: ok ? 400 : 600 }}>{filsLabel(r.diffFils)}</td>
                    <td style={{ padding: 8, textAlign: 'center' }}><span style={{ fontSize: 15 }}>{ok ? '✓' : '✗'}</span></td>
                    <td style={{ padding: 8, fontSize: 11, color: '#6B7280' }}>{ok ? '—' : `Ledger − Domain = ${filsLabel(r.diffFils)}`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {section.rows.length > rows.length && (
            <div style={{ padding: '8px 16px', fontSize: 11, color: '#9CA3AF', borderTop: '1px solid #E5E9EE' }}>
              … {section.rows.length - rows.length} weitere Zeilen ausgeblendet (Top 200 nach |Diff|).
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

// ── Credit Integrity Issues Card (read-only, aufklappbar) ──────
const SEV_COLOR: Record<string, string> = { error: '#DC2626', warning: '#B45309', info: '#6B7280' };

function CreditIssuesCard({ issues, open, onToggle }: { issues: CreditIssue[]; open: boolean; onToggle: () => void }) {
  const errors = issues.filter(i => i.severity === 'error').length;
  const warnings = issues.filter(i => i.severity === 'warning').length;
  const ok = errors === 0;
  const rows = issues.slice(0, 200);
  return (
    <Card noPadding className="mb-4">
      <div
        onClick={onToggle}
        style={{ padding: 16, borderBottom: open ? '1px solid #E5E9EE' : 'none', cursor: 'pointer',
                 background: ok ? 'transparent' : 'rgba(220,38,38,0.04)' }}
      >
        <h3 style={{ fontSize: 14, fontWeight: 600, color: ok ? '#16A34A' : '#DC2626' }}>
          {open ? '▾' : '▸'} Credit Integrity Issues {ok ? '✓' : '✗'}
        </h3>
        <p style={{ fontSize: 12, color: '#6B7280', marginTop: 4 }}>
          {errors} Fehler · {warnings} Warnung{warnings === 1 ? '' : 'en'} ·
          {' '}Warnungen (Return-/Order-Cancel-/unsichere Mappings) sind KEIN harter Fehler.
        </p>
      </div>
      {open && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#F4F6F9', textAlign: 'left' }}>
                <th style={{ padding: 8 }}>Severity</th>
                <th style={{ padding: 8 }}>Kind</th>
                <th style={{ padding: 8 }}>Side</th>
                <th style={{ padding: 8 }}>Entity</th>
                <th style={{ padding: 8 }}>Counterparty</th>
                <th style={{ padding: 8 }}>Detail</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={6} style={{ padding: 20, textAlign: 'center', color: '#16A34A' }}>Keine Integritäts-Befunde.</td></tr>
              ) : rows.map((i, idx) => (
                <tr key={`${i.kind}-${i.entityId}-${idx}`} style={{ borderTop: '1px solid #E5E9EE' }}>
                  <td style={{ padding: 8, fontWeight: 600, color: SEV_COLOR[i.severity] || '#6B7280' }}>{i.severity}</td>
                  <td style={{ padding: 8, fontFamily: 'monospace' }}>{i.kind}</td>
                  <td style={{ padding: 8 }}>{i.side}</td>
                  <td style={{ padding: 8, fontFamily: 'monospace', color: '#9CA3AF' }}>{shortId(i.entityId)}</td>
                  <td style={{ padding: 8, fontFamily: 'monospace', color: '#9CA3AF' }}>{i.counterpartyId ? shortId(i.counterpartyId) : '—'}</td>
                  <td style={{ padding: 8, fontSize: 11, color: '#6B7280' }}>{i.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {issues.length > rows.length && (
            <div style={{ padding: '8px 16px', fontSize: 11, color: '#9CA3AF', borderTop: '1px solid #E5E9EE' }}>
              … {issues.length - rows.length} weitere Befunde ausgeblendet (erste 200).
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
