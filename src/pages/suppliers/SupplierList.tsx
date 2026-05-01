// Plan §Supplier — List + inline create modal + ledger preview
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2 } from 'lucide-react';
import { PageLayout } from '@/components/layout/PageLayout';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { useSupplierStore } from '@/stores/supplierStore';
import { matchesDeep } from '@/core/utils/deep-search';
import type { Supplier } from '@/core/models/types';

function fmt(v: number): string {
  return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export function SupplierList() {
  const navigate = useNavigate();
  const { suppliers, loadSuppliers, createSupplier } = useSupplierStore();
  const [search, setSearch] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState<Partial<Supplier>>({});

  useEffect(() => { loadSuppliers(); }, [loadSuppliers]);

  const filtered = useMemo(() => {
    if (!search) return suppliers;
    return suppliers.filter(s => matchesDeep(s, search));
  }, [suppliers, search]);

  function handleCreate() {
    if (!form.name) return;
    createSupplier(form);
    setShowNew(false);
    setForm({});
  }

  const totalOutstanding = suppliers.reduce((s, x) => s + (x.outstandingBalance || 0), 0);
  const totalCredit = suppliers.reduce((s, x) => s + (x.creditBalance || 0), 0);

  return (
    <PageLayout
      title="Suppliers"
      subtitle={`${suppliers.length} suppliers · ${fmt(totalOutstanding)} BHD outstanding · ${fmt(totalCredit)} BHD credit`}
      showSearch onSearch={setSearch} searchPlaceholder="Search supplier by name or phone..."
      actions={<Button variant="primary" onClick={() => setShowNew(true)}>New Supplier</Button>}
    >
      {filtered.length === 0 ? (
        <div style={{ padding: '80px 0', textAlign: 'center' }}>
          <Building2 size={40} strokeWidth={1} style={{ color: '#6B7280', margin: '0 auto 16px' }} />
          <p style={{ fontSize: 14, color: '#6B7280' }}>
            {search ? 'No suppliers match your search.' : 'No suppliers yet. Create your first supplier.'}
          </p>
        </div>
      ) : (
        <Card noPadding>
          <div style={{
            display: 'grid', gridTemplateColumns: '2fr 1.5fr 1fr 1fr 1fr 0.9fr 0.9fr',
            gap: 16, padding: '14px 18px', borderBottom: '1px solid #E5E9EE',
          }}>
            {['NAME', 'CONTACT', 'TOTAL PURCHASES', 'PAID', 'OUTSTANDING', 'CREDIT', 'STATUS'].map(h => (
              <span key={h} className="text-overline">{h}</span>
            ))}
          </div>
          {filtered.map(s => (
            <div key={s.id} className="cursor-pointer transition-colors"
              onClick={() => navigate(`/suppliers/${s.id}`)}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(15,15,16,0.03)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              style={{
              display: 'grid', gridTemplateColumns: '2fr 1.5fr 1fr 1fr 1fr 0.9fr 0.9fr',
              gap: 16, padding: '14px 18px', alignItems: 'center',
              borderBottom: '1px solid rgba(229,225,214,0.6)',
            }}>
              <div>
                <div style={{ fontSize: 14, color: '#0F0F10' }}>{s.name}</div>
                {s.address && <div style={{ fontSize: 11, color: '#6B7280' }}>{s.address}</div>}
              </div>
              <div style={{ fontSize: 12, color: '#4B5563' }}>
                {s.phone && <div>{s.phone}</div>}
                {s.email && <div style={{ color: '#6B7280' }}>{s.email}</div>}
              </div>
              <div className="font-mono" style={{ fontSize: 13, color: '#0F0F10' }}>{fmt(s.totalPurchases || 0)}</div>
              <div className="font-mono" style={{ fontSize: 13, color: '#16A34A' }}>{fmt(s.totalPaid || 0)}</div>
              <div className="font-mono" style={{ fontSize: 13, color: (s.outstandingBalance || 0) > 0 ? '#DC2626' : '#6B7280' }}>
                {fmt(s.outstandingBalance || 0)}
              </div>
              <div className="font-mono" style={{ fontSize: 13, color: (s.creditBalance || 0) > 0 ? '#AA956E' : '#6B7280' }}>
                {fmt(s.creditBalance || 0)}
              </div>
              <div>
                <span style={{
                  fontSize: 11, padding: '2px 8px', borderRadius: 999,
                  color: s.active ? '#16A34A' : '#6B7280',
                  background: s.active ? 'rgba(22,163,74,0.08)' : 'rgba(107,114,128,0.08)',
                }}>{s.active ? 'Active' : 'Inactive'}</span>
              </div>
            </div>
          ))}
        </Card>
      )}

      <Modal open={showNew} onClose={() => setShowNew(false)} title="New Supplier" width={500}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Input required label="NAME" placeholder="e.g. Gold Dealer LLC" value={form.name || ''} onChange={e => setForm({ ...form, name: e.target.value })} autoFocus />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <Input label="PHONE" placeholder="+973 3xxx xxxx" value={form.phone || ''} onChange={e => setForm({ ...form, phone: e.target.value })} />
            <Input label="EMAIL" placeholder="contact@supplier.com" value={form.email || ''} onChange={e => setForm({ ...form, email: e.target.value })} />
          </div>
          <Input label="ADDRESS" placeholder="Street, City" value={form.address || ''} onChange={e => setForm({ ...form, address: e.target.value })} />
          <div>
            <span className="text-overline" style={{ marginBottom: 6 }}>NOTES</span>
            <textarea
              value={form.notes || ''}
              onChange={e => setForm({ ...form, notes: e.target.value })}
              className="w-full outline-none"
              rows={3}
              style={{ marginTop: 6, background: 'transparent', borderBottom: '1px solid #D5D9DE', padding: '8px 0', fontSize: 14, color: '#0F0F10', resize: 'vertical' }}
            />
          </div>
          <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setShowNew(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleCreate} disabled={!form.name}>Create Supplier</Button>
          </div>
        </div>
      </Modal>
    </PageLayout>
  );
}
