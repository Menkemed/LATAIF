// Plan §Purchases — List with status filter + New Purchase button (navigiert zu Full-Page).
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShoppingCart } from 'lucide-react';
import { PageLayout } from '@/components/layout/PageLayout';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { usePurchaseStore } from '@/stores/purchaseStore';
import { useSupplierStore } from '@/stores/supplierStore';
import { matchesDeep } from '@/core/utils/deep-search';
import type { PurchaseStatus } from '@/core/models/types';

function fmt(v: number): string {
  return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

type StatusFilter = '' | PurchaseStatus;

export function PurchaseList() {
  const navigate = useNavigate();
  const { purchases, loadPurchases } = usePurchaseStore();
  const { suppliers, loadSuppliers } = useSupplierStore();

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<StatusFilter>('');

  useEffect(() => { loadPurchases(); loadSuppliers(); }, [loadPurchases, loadSuppliers]);

  const filtered = useMemo(() => {
    let r = purchases;
    if (filter) r = r.filter(p => p.status === filter);
    if (search) r = r.filter(p => matchesDeep(p, search, [suppliers.find(s => s.id === p.supplierId)]));
    return r;
  }, [purchases, search, filter, suppliers]);

  const totalOutstanding = purchases
    .filter(p => p.status !== 'CANCELLED')
    .reduce((s, p) => s + p.remainingAmount, 0);

  const getSupplier = (id: string) => suppliers.find(s => s.id === id);

  const statusColors: Record<PurchaseStatus, string> = {
    DRAFT: '#9CA3AF', UNPAID: '#DC2626', PARTIALLY_PAID: '#D97706',
    PAID: '#16A34A', CANCELLED: '#6B7280',
  };

  return (
    <PageLayout
      title="Purchases"
      subtitle={`${purchases.length} purchases · ${fmt(totalOutstanding)} BHD outstanding`}
      showSearch onSearch={setSearch} searchPlaceholder="Search purchase # or supplier..."
      actions={
        <div className="flex gap-2 items-center">
          <div className="flex gap-1" style={{ marginRight: 4 }}>
            {(['', 'DRAFT', 'UNPAID', 'PARTIALLY_PAID', 'PAID', 'CANCELLED'] as StatusFilter[]).map(s => (
              <button key={s || 'all'} onClick={() => setFilter(s)}
                className="cursor-pointer transition-all"
                style={{
                  padding: '6px 12px', borderRadius: 999, fontSize: 12,
                  border: `1px solid ${filter === s ? '#0F0F10' : 'transparent'}`,
                  color: filter === s ? '#0F0F10' : '#6B7280',
                  background: filter === s ? 'rgba(15,15,16,0.06)' : 'transparent',
                }}>{s || 'All'}</button>
            ))}
          </div>
          <Button variant="primary" onClick={() => navigate('/purchases/new')} disabled={suppliers.length === 0}>New Purchase</Button>
        </div>
      }
    >
      {filtered.length === 0 ? (
        <div style={{ padding: '60px 0', textAlign: 'center' }}>
          <ShoppingCart size={36} strokeWidth={1} style={{ color: '#6B7280', margin: '0 auto 12px' }} />
          <p style={{ fontSize: 13, color: '#6B7280' }}>
            {search || filter ? 'No purchases match your filters.' : 'No purchases yet.'}
          </p>
          {suppliers.length === 0 && (
            <p style={{ fontSize: 12, color: '#9CA3AF', marginTop: 8 }}>Create a supplier first to record purchases.</p>
          )}
        </div>
      ) : (
        <Card noPadding>
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 1.3fr 1.5fr 1fr 1fr 1fr 1fr',
            gap: 14, padding: '12px 16px', borderBottom: '1px solid #E5E1D6',
          }}>
            {['NUMBER', 'DATE', 'SUPPLIER', 'TOTAL', 'PAID', 'REMAINING', 'STATUS'].map(h => (
              <span key={h} className="text-overline">{h}</span>
            ))}
          </div>
          {filtered.map(p => {
            const s = getSupplier(p.supplierId);
            return (
              <div key={p.id} onClick={() => navigate(`/purchases/${p.id}`)}
                className="cursor-pointer transition-colors"
                style={{
                  display: 'grid', gridTemplateColumns: '1fr 1.3fr 1.5fr 1fr 1fr 1fr 1fr',
                  gap: 14, padding: '14px 16px', alignItems: 'center',
                  borderBottom: '1px solid rgba(229,225,214,0.6)',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(15,15,16,0.03)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <span className="font-mono" style={{ fontSize: 12, color: '#0F0F10' }}>{p.purchaseNumber}</span>
                <span style={{ fontSize: 12, color: '#4B5563' }}>{p.purchaseDate}</span>
                <span style={{ fontSize: 13, color: '#0F0F10' }}>{s?.name || '—'}</span>
                <span className="font-mono" style={{ fontSize: 13, color: '#0F0F10' }}>{fmt(p.totalAmount)}</span>
                <span className="font-mono" style={{ fontSize: 13, color: '#16A34A' }}>{fmt(p.paidAmount)}</span>
                <span className="font-mono" style={{ fontSize: 13, color: p.remainingAmount > 0 ? '#DC2626' : '#6B7280' }}>{fmt(p.remainingAmount)}</span>
                <span style={{ fontSize: 11, color: statusColors[p.status] }}>{p.status}</span>
              </div>
            );
          })}
        </Card>
      )}
    </PageLayout>
  );
}
