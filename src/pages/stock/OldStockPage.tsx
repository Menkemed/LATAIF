// ════════════════════════════════════════════════════════════════════════════
// OLD STOCK — „Old stock": die schreibgeschützte Eröffnungsvorschau und Abstimmungsliste (Phase 3, Grundlage).
//
// Nur für den Owner, am Primary und am PC2 (Auskunft `page.old_stock.get`). Die Zahlen rechnet das Haus
// (`core/stock/old-stock-reconciliation`) — dieselbe Rechnung, die später die Eröffnungsbuchung in ihrer Transaktion
// wiederholt. Hier wird NICHTS gebucht: Gegenkonten, Datum und die Behandlung früherer Verkäufe entscheidet der
// Buchhalter (D1–D6, D8). Jeder Prüffall nennt seinen Grund.
// ════════════════════════════════════════════════════════════════════════════
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageLayout } from '@/components/layout/PageLayout';
import { KPICard } from '@/components/ui/KPICard';
import { Button } from '@/components/ui/Button';
import { useSharedRead } from '@/core/data/shared-read';
import { usePermission } from '@/hooks/usePermission';
import {
  OLD_STOCK_REVIEW_REASONS, oldStockReconciliationFor, type OldStockClass, type OldStockReconciliation,
} from '@/core/stock/old-stock-reconciliation';

const EMPTY: OldStockReconciliation = {
  branchId: '', rows: [],
  totals: { candidates: 0, review: 0, capitalised: 0, soldCogs: 0, pendingRemovalValue: 0, shelfValue: 0, v1: 0, v2: 0, reviewV1: 0 },
  ledger: { inventoryBalance: 0, unknownInventoryDebits: 0, unattributedCogs: 0 },
  notes: [],
};
const b3 = (n: number): string => n.toFixed(3);
const CLASS_LABEL: Record<OldStockClass, string> = {
  OPENING_CANDIDATE: 'Opening candidate', REVIEW: 'Review', CAPITALISED: 'Already in inventory',
};
type Filter = OldStockClass | 'ALL';

export function OldStockPage() {
  const perm = usePermission();
  const navigate = useNavigate();
  const [refresh, setRefresh] = useState(0);
  const [filter, setFilter] = useState<Filter>('OPENING_CANDIDATE');
  const data = useSharedRead<OldStockReconciliation>('page.old_stock.get', { r: refresh }, (ctx) => oldStockReconciliationFor(ctx), EMPTY, [refresh]);
  const rows = useMemo(() => data.rows.filter((r) => filter === 'ALL' || r.klass === filter), [data, filter]);

  if (!perm.isOwner) {
    return (
      <PageLayout title="Old stock">
        <p data-old-stock-no-access style={{ fontSize: 14, color: '#6B7280' }}>Only the owner can see the opening of old stock.</p>
      </PageLayout>
    );
  }

  return (
    <PageLayout title="Old stock" subtitle="Opening preview and reconciliation — read only, nothing is booked">
      <div data-old-stock-notes style={{ padding: '10px 14px', background: '#F5F7FA', border: '1px solid #E5E9EE', borderRadius: 8, fontSize: 13, color: '#374151', marginBottom: 20, display: 'grid', gap: 4 }}>
        <span>Old stock is recorded with New Collection (desktop and phone), the Excel import or “Add old stock” on an item — without money. Its opening waits for the accountant’s rules.</span>
        {data.notes.map((n) => <span key={n}>{n}</span>)}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 20, marginBottom: 24 }}>
        <KPICard label="OPENING CANDIDATES" value={String(data.totals.candidates)} unit={`${data.totals.review} to review · ${data.totals.capitalised} already in inventory`} />
        <KPICard label="V1 (SOLD + MISSING + SHELF)" value={b3(data.totals.v1)} unit="BHD · preview, candidates only" />
        <KPICard label="V2 (SOLD + SHELF)" value={b3(data.totals.v2)} unit="BHD · preview, candidates only" />
        <KPICard label="INVENTORY IN THE LEDGER" value={b3(data.ledger.inventoryBalance)} unit="BHD today" />
      </div>
      <div className="flex gap-2" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        {(['OPENING_CANDIDATE', 'REVIEW', 'CAPITALISED', 'ALL'] as Filter[]).map((f) => (
          <Button key={f} variant={filter === f ? 'primary' : 'ghost'} onClick={() => setFilter(f)} data-old-stock-filter={f}>
            {f === 'ALL' ? 'All' : CLASS_LABEL[f as OldStockClass]}
          </Button>
        ))}
        <Button variant="ghost" onClick={() => setRefresh((r) => r + 1)}>Refresh</Button>
      </div>
      <div style={{ fontSize: 12, color: '#6B7280', marginBottom: 8 }}>
        (a) cost of sales already booked · (b) pending removals without a booking · (c) on hand × historical cost. Candidates: sold {b3(data.totals.soldCogs)} · missing {b3(data.totals.pendingRemovalValue)} · shelf {b3(data.totals.shelfValue)} BHD.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '0.9fr 2fr 0.7fr 0.6fr 0.8fr 0.9fr 0.9fr 0.9fr 0.9fr 0.9fr 2fr', gap: 8, padding: '6px 10px', fontSize: 11, color: '#6B7280' }}>
        <span>SKU</span><span>ITEM</span><span>STATUS</span><span style={{ textAlign: 'right' }}>ON HAND</span><span style={{ textAlign: 'right' }}>HIST. COST</span>
        <span style={{ textAlign: 'right' }}>(a) SOLD</span><span style={{ textAlign: 'right' }}>(b) MISSING</span><span style={{ textAlign: 'right' }}>(c) SHELF</span>
        <span style={{ textAlign: 'right' }}>V1</span><span style={{ textAlign: 'right' }}>V2</span><span>CLASS / REASON</span>
      </div>
      {rows.length === 0 && <p data-old-stock-empty style={{ fontSize: 13, color: '#6B7280', padding: '16px 10px' }}>Nothing in this list.</p>}
      {rows.map((r) => (
        <div key={r.productId} data-old-stock-row={r.productId} data-old-stock-class={r.klass} onClick={() => navigate(`/collection/${r.productId}`)}
          className="cursor-pointer"
          style={{ display: 'grid', gridTemplateColumns: '0.9fr 2fr 0.7fr 0.6fr 0.8fr 0.9fr 0.9fr 0.9fr 0.9fr 0.9fr 2fr', gap: 8, padding: '8px 10px', borderTop: '1px solid #E5E9EE', fontSize: 12, alignItems: 'start' }}>
          <span className="font-mono">{r.sku || '—'}</span>
          <span>{r.title}{r.oldStockReceiptQty > 0 ? ` · +${r.oldStockReceiptQty} added as old stock` : ''}</span>
          <span>{r.stockStatus}</span>
          <span className="font-mono" style={{ textAlign: 'right' }}>{r.shelfQty}</span>
          <span className="font-mono" style={{ textAlign: 'right' }}>{r.historicalCost === null ? '—' : b3(r.historicalCost)}</span>
          <span className="font-mono" style={{ textAlign: 'right' }}>{b3(r.soldCogs)}</span>
          <span className="font-mono" style={{ textAlign: 'right' }} title={r.pendingRemovalNumbers.join(', ')}>{r.pendingRemovalQty > 0 ? `${b3(r.pendingRemovalValue)} (${r.pendingRemovalQty})` : '—'}</span>
          <span className="font-mono" style={{ textAlign: 'right' }}>{b3(r.shelfValue)}</span>
          <span className="font-mono" style={{ textAlign: 'right' }}>{r.klass === 'CAPITALISED' ? '—' : b3(r.v1)}</span>
          <span className="font-mono" style={{ textAlign: 'right' }}>{r.klass === 'CAPITALISED' ? '—' : b3(r.v2)}</span>
          <span style={{ color: r.klass === 'REVIEW' ? '#7A3535' : '#374151' }}>
            {CLASS_LABEL[r.klass]}{r.reasons.length > 0 ? ': ' : ''}
            {r.reasons.map((k) => OLD_STOCK_REVIEW_REASONS[k] ?? k).join('; ')}
          </span>
        </div>
      ))}
    </PageLayout>
  );
}
