// ═══════════════════════════════════════════════════════════
// LATAIF — Repair + Gold Reconciliation (v0.1.45)
//
// Read-only Diagnostic-Page fuer Owner. Zeigt:
//   - Repair-Line-Drift: Lines deren expense_id auf cancelled/missing/amount-
//     mismatching Expenses zeigt (Backfill-Audit von v0.1.44)
//   - Gold-Drift: Vergleicht SUM(gold_movements net) vs SUM(precious_metals)
//     je Karat — divergence deutet auf direkte SQL-Manipulation oder fehlende
//     Bewegungs-Audits hin.
//
// Kein Auto-Fix. Owner entscheidet manuell fuer jeden Eintrag was zu tun ist
// (Cancel, Edit, oder Ignore wenn historisch bekannt).
// ═══════════════════════════════════════════════════════════

import { useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useGoldStore } from '@/stores/goldStore';
import { useRepairStore } from '@/stores/repairStore';
import { usePermission } from '@/hooks/usePermission';

export function RepairReconcilePage() {
  const perm = usePermission();
  const navigate = useNavigate();
  // Stable selector for actions — avoid re-running effect every render
  const loadAllGold = useGoldStore(s => s.loadAll);
  const getRepairLineDrift = useGoldStore(s => s.getRepairLineDrift);
  const getGoldDrift = useGoldStore(s => s.getGoldDrift);
  // Subscribe to slices we read in JSX so re-renders stay reactive
  const goldPayables = useGoldStore(s => s.goldPayables);
  const customerGoldCredits = useGoldStore(s => s.customerGoldCredits);
  const { loadRepairs, loadRepairLines } = useRepairStore();
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    loadRepairs(); loadRepairLines(); loadAllGold();
  }, [loadRepairs, loadRepairLines, loadAllGold, refreshKey]);

  // Permission-Guard
  if (!perm.isOwner) {
    return <Navigate to="/" replace />;
  }

  const lineDrift = useMemo(() => getRepairLineDrift(), [getRepairLineDrift, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const goldDrift = useMemo(() => getGoldDrift(), [getGoldDrift, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const driftColors: Record<string, { bg: string; fg: string; border: string }> = {
    cancelled_expense: { bg: 'rgba(220,38,38,0.06)', fg: '#DC2626', border: 'rgba(220,38,38,0.3)' },
    missing_expense:   { bg: 'rgba(220,38,38,0.06)', fg: '#DC2626', border: 'rgba(220,38,38,0.3)' },
    amount_mismatch:   { bg: 'rgba(217,119,6,0.06)', fg: '#92400E', border: 'rgba(217,119,6,0.3)' },
    orphan_expense:    { bg: 'rgba(217,119,6,0.06)', fg: '#92400E', border: 'rgba(217,119,6,0.3)' },
  };

  return (
    <div className="app-content" style={{ background: '#FFFFFF' }}>
      <div style={{ padding: '32px 48px 80px', maxWidth: 1200 }}>
        <h1 className="font-display" style={{ fontSize: 28, color: '#0F0F10', marginBottom: 8 }}>
          Repair + Gold Reconciliation
        </h1>
        <p style={{ fontSize: 13, color: '#6B7280', marginBottom: 24 }}>
          Read-only Audit. Zeigt Drift zwischen repair_lines / expenses und gold_movements / precious_metals.
          Kein Auto-Fix — jeder Eintrag muss manuell beurteilt werden.
        </p>

        <div className="flex justify-end" style={{ marginBottom: 16 }}>
          <Button variant="secondary" onClick={() => setRefreshKey(k => k + 1)}>Refresh</Button>
        </div>

        {/* Repair-Line-Drift */}
        <Card>
          <div className="flex justify-between items-center" style={{ marginBottom: 12 }}>
            <span className="text-overline">REPAIR-LINE DRIFT ({lineDrift.length})</span>
            {lineDrift.length === 0 && (
              <span style={{ fontSize: 11, color: '#16A34A' }}>✓ Keine Diskrepanzen</span>
            )}
          </div>
          {lineDrift.length === 0 ? (
            <p style={{ fontSize: 13, color: '#6B7280', padding: '20px 0' }}>
              Alle repair_lines stimmen mit ihren verknuepften expenses ueberein.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {lineDrift.map((d, i) => {
                const c = driftColors[d.drift] || driftColors.amount_mismatch;
                return (
                  <div key={i} style={{
                    padding: '12px 14px', border: `1px solid ${c.border}`, background: c.bg,
                    borderRadius: 6,
                  }}>
                    <div className="flex justify-between items-start" style={{ marginBottom: 6 }}>
                      <div>
                        <span className="font-mono" style={{ fontSize: 12, color: '#3D7FFF', cursor: 'pointer', textDecoration: 'underline' }}
                          onClick={() => navigate(`/repairs/${d.repairId}`)}>
                          {d.repairNumber}
                        </span>
                        {d.expenseId && (
                          <span style={{ fontSize: 11, color: '#6B7280', marginLeft: 10 }}>
                            exp: <span className="font-mono">{d.expenseId.slice(0, 8)}</span>
                          </span>
                        )}
                      </div>
                      <span style={{
                        fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 999,
                        color: c.fg, background: c.bg, border: `1px solid ${c.border}`,
                        textTransform: 'uppercase',
                      }}>
                        {d.drift.replace(/_/g, ' ')}
                      </span>
                    </div>
                    <p style={{ fontSize: 12, color: '#4B5563' }}>{d.detail}</p>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        {/* Gold-Drift */}
        <div style={{ marginTop: 24 }}>
          <Card>
            <div className="flex justify-between items-center" style={{ marginBottom: 12 }}>
              <span className="text-overline">GOLD INVENTORY DRIFT</span>
              <span style={{ fontSize: 11, color: '#6B7280' }}>movements_net vs precious_metals_sum</span>
            </div>
            {goldDrift.length === 0 ? (
              <p style={{ fontSize: 13, color: '#6B7280', padding: '20px 0' }}>Keine Gold-Bewegungen erfasst.</p>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr 1fr 1fr', gap: 12, fontSize: 12 }}>
                <span className="text-overline">KARAT</span>
                <span className="text-overline" style={{ textAlign: 'right' }}>Σ MOVEMENTS NET</span>
                <span className="text-overline" style={{ textAlign: 'right' }}>Σ precious_metals</span>
                <span className="text-overline" style={{ textAlign: 'right' }}>DRIFT (g)</span>
                {goldDrift.map(d => (
                  <div key={d.karat} style={{ display: 'contents' }}>
                    <span style={{ fontSize: 13, color: '#0F0F10', padding: '10px 0', borderTop: '1px solid #E5E9EE' }}>{d.karat}</span>
                    <span className="font-mono" style={{ fontSize: 13, color: '#4B5563', textAlign: 'right', padding: '10px 0', borderTop: '1px solid #E5E9EE' }}>
                      {d.movementsNet.toFixed(3)}
                    </span>
                    <span className="font-mono" style={{ fontSize: 13, color: '#4B5563', textAlign: 'right', padding: '10px 0', borderTop: '1px solid #E5E9EE' }}>
                      {d.preciousMetalsSum.toFixed(3)}
                    </span>
                    <span className="font-mono" style={{
                      fontSize: 13, textAlign: 'right', padding: '10px 0', borderTop: '1px solid #E5E9EE',
                      color: Math.abs(d.drift) < 0.001 ? '#16A34A' : '#DC2626',
                      fontWeight: Math.abs(d.drift) < 0.001 ? 400 : 600,
                    }}>
                      {d.drift.toFixed(3)}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <p style={{ fontSize: 11, color: '#9CA3AF', marginTop: 16, lineHeight: 1.5 }}>
              Drift ≠ 0 deutet auf direkte SQL-Manipulation oder fehlende gold_movement-Audit-Schreibvorgaenge hin.
              Bei zukuenftigen Code-Changes immer adjustPreciousMetals + recordGoldMovement zusammen aufrufen.
            </p>
          </Card>
        </div>

        {/* Quick-Stats */}
        <div style={{ marginTop: 24 }}>
          <Card>
            <span className="text-overline" style={{ marginBottom: 12, display: 'block' }}>QUICK STATS</span>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
              <Stat label="OPEN gold_payables" value={goldPayables.filter(p => p.status === 'OPEN').length} />
              <Stat label="OPEN customer_gold_credits" value={customerGoldCredits.filter(c => c.status === 'OPEN').length} />
              <Stat label="Repair-Line Drifts" value={lineDrift.length} highlight={lineDrift.length > 0} />
              <Stat label="Karate mit Gold-Drift" value={goldDrift.filter(d => Math.abs(d.drift) >= 0.001).length} highlight={goldDrift.some(d => Math.abs(d.drift) >= 0.001)} />
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: '#9CA3AF', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 4 }}>{label}</div>
      <div className="font-mono" style={{ fontSize: 20, color: highlight ? '#DC2626' : '#0F0F10' }}>{value}</div>
    </div>
  );
}
