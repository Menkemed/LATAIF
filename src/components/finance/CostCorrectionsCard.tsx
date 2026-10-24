// ════════════════════════════════════════════════════════════════════════════
// PURCHASE-EDIT D1 — die Überleitung der Einstandskorrekturen (Reconciliation).
//
// Eine Einstandskorrektur bucht das Hauptbuch am Tag der Korrektur, der Gewinnbericht ordnet sie dem
// Verkaufsmonat zu (Erfassungsfehler). Diese Karte zeigt beides je Monat nebeneinander — über alle
// Monate gleicht es sich aus — und darunter jeden Beleg mit seinem VAT-Merker. Nichts hier bucht,
// nichts geht in eine VAT-Erklärung: der Merker „VAT to review" wartet auf den Buchhalter.
// ════════════════════════════════════════════════════════════════════════════
import { Link } from 'react-router-dom';
import { Card } from '@/components/ui/Card';
import { Bhd } from '@/components/ui/Bhd';
import { useSharedRead } from '@/core/data/shared-read';
import { costCorrectionBridge, costCorrectionRows, type CostCorrectionRow } from '@/core/purchases/cost-correction-read';

interface CostCorrectionsPage {
  rows: CostCorrectionRow[];
  bridge: Array<{ month: string; booked: number; attributed: number; difference: number }>;
}

const LEER: CostCorrectionsPage = { rows: [], bridge: [] };
const TH: React.CSSProperties = { padding: 8 };
const TD: React.CSSProperties = { padding: 8, fontFamily: 'monospace' };

export function CostCorrectionsCard({ refreshTick, branchId }: { refreshTick: number; branchId?: string }) {
  const data = useSharedRead<CostCorrectionsPage>(
    'page.cost_corrections.get', { v: refreshTick },
    (ctx) => ({ rows: costCorrectionRows(ctx.branchId), bridge: costCorrectionBridge(ctx.branchId) }),
    LEER, [refreshTick, branchId],
  );
  if (data.rows.length === 0) return null;
  const sum = (k: 'booked' | 'attributed') => data.bridge.reduce((s, r) => s + r[k], 0);
  const review = data.rows.filter((r) => r.status === 'ACTIVE' && r.vatStatus === 'REVIEW');

  return (
    <Card noPadding className="mb-4">
      <div style={{ padding: 16, borderBottom: '1px solid #E5E9EE' }} data-cost-corrections-card>
        <h3 style={{ fontSize: 14, fontWeight: 600 }}>Einstandskorrekturen (Purchase Edit)</h3>
        <p style={{ fontSize: 12, color: '#6B7280', marginTop: 4 }}>
          Hauptbuch = Buchungsmonat (COGS, Quelle COST_CORRECTION, inkl. Gegenbuchungen). Gewinnbericht = Verkaufsmonat der
          wirksamen Korrekturen. Über alle Monate muss die Differenz 0 sein. Diese Übersicht umfasst nur Einstandskorrekturen —
          sie ist keine vollständige Abstimmung von Hauptbuch und Gewinnbericht.
          {review.length > 0 && <> {review.length} Beleg(e) mit möglichem VAT-Effekt warten auf den Buchhalter — nichts wird automatisch erklärt.</>}
        </p>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#F4F6F9', textAlign: 'left' }}>
              <th style={TH}>Monat</th>
              <th style={{ ...TH, textAlign: 'right' }}>Hauptbuch (gebucht)</th>
              <th style={{ ...TH, textAlign: 'right' }}>Gewinnbericht (zugeordnet)</th>
              <th style={{ ...TH, textAlign: 'right' }}>Differenz</th>
            </tr>
          </thead>
          <tbody>
            {data.bridge.map((r) => (
              <tr key={r.month} style={{ borderTop: '1px solid #E5E9EE' }} data-cost-bridge-month={r.month}>
                <td style={TD}>{r.month}</td>
                <td style={{ ...TD, textAlign: 'right' }}><Bhd v={r.booked} /></td>
                <td style={{ ...TD, textAlign: 'right' }}><Bhd v={r.attributed} /></td>
                <td style={{ ...TD, textAlign: 'right', color: r.difference === 0 ? '#6B7280' : '#B45309' }}><Bhd v={r.difference} /></td>
              </tr>
            ))}
            <tr style={{ borderTop: '2px solid #E5E9EE', fontWeight: 600 }}>
              <td style={TD}>Summe</td>
              <td style={{ ...TD, textAlign: 'right' }}><Bhd v={sum('booked')} /></td>
              <td style={{ ...TD, textAlign: 'right' }}><Bhd v={sum('attributed')} /></td>
              <td style={{ ...TD, textAlign: 'right' }} data-cost-bridge-total><Bhd v={Math.round((sum('attributed') - sum('booked')) * 1000) / 1000} /></td>
            </tr>
          </tbody>
        </table>
      </div>
      <div style={{ overflowX: 'auto', borderTop: '1px solid #E5E9EE' }}>
        <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#F4F6F9', textAlign: 'left' }}>
              <th style={TH}>Beleg</th>
              <th style={TH}>Einkauf</th>
              <th style={TH}>Rechnung</th>
              <th style={TH}>Artikel</th>
              <th style={{ ...TH, textAlign: 'right' }}>Stück</th>
              <th style={{ ...TH, textAlign: 'right' }}>Einstand alt → neu</th>
              <th style={{ ...TH, textAlign: 'right' }}>Betrag</th>
              <th style={TH}>Gebucht / Verkaufsmonat</th>
              <th style={TH}>VAT</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.slice(0, 200).map((r) => (
              <tr key={r.id} style={{ borderTop: '1px solid #E5E9EE', opacity: r.status === 'ACTIVE' ? 1 : 0.55 }}>
                <td style={TD}>{r.correctionNumber}{r.status !== 'ACTIVE' && <span style={{ marginLeft: 6, color: '#6B7280' }}>{r.status}</span>}</td>
                <td style={TD}><Link to={`/purchases/${r.purchaseId}`}>{r.purchaseNumber || '—'}</Link></td>
                <td style={TD}>{r.invoiceNumber ? <Link to={`/invoices/${r.invoiceId}`}>{r.invoiceNumber}</Link> : '—'}</td>
                <td style={{ ...TD, fontFamily: 'inherit' }}>{r.productLabel || '—'}</td>
                <td style={{ ...TD, textAlign: 'right' }}>{r.quantity}</td>
                <td style={{ ...TD, textAlign: 'right' }}><Bhd v={r.oldUnitCost} /> → <Bhd v={r.newUnitCost} /></td>
                <td style={{ ...TD, textAlign: 'right', color: r.amount < 0 ? '#16A34A' : '#DC2626' }}><Bhd v={r.amount} /></td>
                <td style={TD}>{r.bookingDate} / {r.economicDate.slice(0, 7)}</td>
                <td style={{ ...TD, fontFamily: 'inherit' }}>
                  {r.status === 'ACTIVE' && r.vatStatus === 'REVIEW'
                    ? <span style={{ color: '#B45309' }}>to review{r.vatEstimate ? <> · est. <Bhd v={r.vatEstimate} /></> : null}</span>
                    : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
