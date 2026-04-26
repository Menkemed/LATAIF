import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageLayout } from '@/components/layout/PageLayout';
import { Button } from '@/components/ui/Button';
import { VIPBadge } from '@/components/ui/VIPBadge';
import { StatusDot } from '@/components/ui/StatusDot';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { useCustomerStore } from '@/stores/customerStore';
import { matchesDeep } from '@/core/utils/deep-search';
import type { Customer, VIPLevel } from '@/core/models/types';

function fmt(v: number): string {
  return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

const BRANDS = ['Rolex', 'Patek Philippe', 'Audemars Piguet', 'Richard Mille', 'Vacheron Constantin', 'A. Lange & Sohne', 'Omega', 'Cartier'];

export function CustomerList() {
  const navigate = useNavigate();
  const { customers, loadCustomers, createCustomer, searchQuery, setSearchQuery, getCustomerStats } = useCustomerStore();
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState<Partial<Customer>>({
    country: 'BH', language: 'en', vipLevel: 0, customerType: 'collector', salesStage: 'lead', preferences: [],
  });

  useEffect(() => { loadCustomers(); }, [loadCustomers]);

  const filtered = useMemo(() => {
    if (!searchQuery) return customers;
    return customers.filter(c => matchesDeep(c, searchQuery));
  }, [customers, searchQuery]);

  function handleCreate() {
    if (!form.firstName || !form.lastName) return;
    createCustomer(form);
    setShowNew(false);
    setForm({ country: 'BH', language: 'en', vipLevel: 0, customerType: 'collector', salesStage: 'lead', preferences: [] });
  }

  return (
    <PageLayout
      title="Clients"
      subtitle={`${customers.length} clients`}
      showSearch onSearch={setSearchQuery} searchPlaceholder="Search clients..."
      actions={<Button variant="primary" onClick={() => setShowNew(true)}>New Client</Button>}
    >
      {/* Table Header */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '2.5fr 1fr 1fr 1.5fr 1fr 1fr 1fr',
          gap: 16,
          padding: '0 16px 12px',
        }}
      >
        <span className="text-overline">CLIENT</span>
        <span className="text-overline">STATUS</span>
        <span className="text-overline">VIP</span>
        <span className="text-overline">PREFERENCES</span>
        <span className="text-overline" style={{ textAlign: 'right' }}>REVENUE</span>
        <span className="text-overline" style={{ textAlign: 'right' }}>PROFIT</span>
        <span className="text-overline" style={{ textAlign: 'right' }}>OUTSTANDING</span>
      </div>

      <div style={{ borderTop: '1px solid #E5E1D6' }} />

      {filtered.length === 0 && (
        <div style={{ padding: '64px 0', textAlign: 'center', fontSize: 14, color: '#6B7280' }}>
          {searchQuery ? 'No clients match your search.' : 'No clients yet. Create your first client.'}
        </div>
      )}

      {filtered.map(c => {
        const stats = getCustomerStats(c.id);
        return (
          <div
            key={c.id}
            className="cursor-pointer transition-colors"
            style={{
              display: 'grid',
              gridTemplateColumns: '2.5fr 1fr 1fr 1.5fr 1fr 1fr 1fr',
              gap: 16,
              padding: '14px 16px',
              alignItems: 'center',
              borderBottom: '1px solid rgba(229,225,214,0.6)',
            }}
            onClick={() => navigate(`/clients/${c.id}`)}
            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(15,15,16,0.03)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <div className="flex items-center gap-3">
              <div
                className="flex items-center justify-center rounded-full shrink-0"
                style={{ width: 36, height: 36, background: '#E5E1D6', border: '1px solid #D5D1C4', fontSize: 11, color: '#4B5563', fontWeight: 500 }}
              >
                {c.firstName[0]}{c.lastName[0]}
              </div>
              <div>
                <div style={{ fontSize: 14, color: '#0F0F10' }}>{c.firstName} {c.lastName}</div>
                {c.company && <div style={{ fontSize: 11, color: '#6B7280' }}>{c.company}</div>}
              </div>
            </div>
            <StatusDot status={c.salesStage} />
            <VIPBadge level={c.vipLevel} />
            <div style={{ fontSize: 12, color: '#4B5563', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {c.preferences.join(', ') || '\u2014'}
            </div>
            <div className="font-mono" style={{ textAlign: 'right', fontSize: 14, color: '#0F0F10' }}>
              {fmt(stats.revenue)}
              <div style={{ fontSize: 10, color: '#6B7280' }}>
                {stats.invoiceCount} invoice{stats.invoiceCount !== 1 ? 's' : ''}
              </div>
            </div>
            <div className="font-mono" style={{ textAlign: 'right', fontSize: 14, color: stats.profit >= 0 ? '#7EAA6E' : '#AA6E6E' }}>
              {fmt(stats.profit)}
              <div style={{ fontSize: 10, color: '#6B7280' }}>
                {stats.revenue > 0 ? `${((stats.profit / stats.revenue) * 100).toFixed(1)}% margin` : '—'}
              </div>
            </div>
            <div className="font-mono" style={{ textAlign: 'right', fontSize: 14, color: stats.outstanding > 0 ? '#AA6E6E' : '#6B7280' }}>
              {stats.outstanding > 0 ? fmt(stats.outstanding) : '\u2014'}
              {stats.openInvoiceCount > 0 && (
                <div style={{ fontSize: 10, color: '#6B7280' }}>{stats.openInvoiceCount} open</div>
              )}
            </div>
          </div>
        );
      })}

      {/* New Client Modal */}
      <Modal open={showNew} onClose={() => setShowNew(false)} title="New Client" width={560}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
            <Input label="FIRST NAME" placeholder="Ahmed" value={form.firstName || ''} onChange={e => setForm({ ...form, firstName: e.target.value })} />
            <Input label="LAST NAME" placeholder="Al-Khalifa" value={form.lastName || ''} onChange={e => setForm({ ...form, lastName: e.target.value })} />
          </div>
          <Input label="COMPANY" placeholder="Company name" value={form.company || ''} onChange={e => setForm({ ...form, company: e.target.value })} />
          <Input label="PERSONAL ID (CPR / PASSPORT)" placeholder="e.g. 900123456" value={form.personalId || ''} onChange={e => setForm({ ...form, personalId: e.target.value })} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
            <Input label="PHONE" placeholder="+973 3xxx xxxx" value={form.phone || ''} onChange={e => setForm({ ...form, phone: e.target.value })} />
            <Input label="WHATSAPP" placeholder="+973 3xxx xxxx" value={form.whatsapp || ''} onChange={e => setForm({ ...form, whatsapp: e.target.value })} />
          </div>
          <Input label="EMAIL" placeholder="email@example.com" value={form.email || ''} onChange={e => setForm({ ...form, email: e.target.value })} />
          <Input label="VAT ACCOUNT NUMBER (optional)" placeholder="For NBR VAT export" value={form.vatAccountNumber || ''} onChange={e => setForm({ ...form, vatAccountNumber: e.target.value })} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
            <Input label="BUDGET MIN (BHD)" type="number" placeholder="10000" value={form.budgetMin || ''} onChange={e => setForm({ ...form, budgetMin: Number(e.target.value) || undefined })} />
            <Input label="BUDGET MAX (BHD)" type="number" placeholder="350000" value={form.budgetMax || ''} onChange={e => setForm({ ...form, budgetMax: Number(e.target.value) || undefined })} />
          </div>

          {/* VIP */}
          <div>
            <span className="text-overline" style={{ marginBottom: 8 }}>VIP LEVEL</span>
            <div className="flex gap-2" style={{ marginTop: 8 }}>
              {([0, 1, 2, 3] as VIPLevel[]).map(level => (
                <button
                  key={level}
                  onClick={() => setForm({ ...form, vipLevel: level })}
                  className="cursor-pointer rounded transition-all duration-200"
                  style={{
                    padding: '8px 16px', fontSize: 13,
                    border: `1px solid ${form.vipLevel === level ? '#0F0F10' : '#D5D1C4'}`,
                    color: form.vipLevel === level ? '#0F0F10' : '#6B7280',
                    background: form.vipLevel === level ? 'rgba(15,15,16,0.06)' : 'transparent',
                  }}
                >
                  {level === 0 ? 'Standard' : level === 1 ? 'VIP' : level === 2 ? 'VVIP' : 'Ultra'}
                </button>
              ))}
            </div>
          </div>

          {/* Preferences */}
          <div>
            <span className="text-overline" style={{ marginBottom: 8 }}>BRAND PREFERENCES</span>
            <div className="flex flex-wrap gap-2" style={{ marginTop: 8 }}>
              {BRANDS.map(brand => {
                const selected = (form.preferences || []).includes(brand);
                return (
                  <button
                    key={brand}
                    onClick={() => {
                      const prefs = form.preferences || [];
                      setForm({ ...form, preferences: selected ? prefs.filter(p => p !== brand) : [...prefs, brand] });
                    }}
                    className="cursor-pointer transition-all duration-200"
                    style={{
                      padding: '6px 14px', fontSize: 12, borderRadius: 999,
                      border: `1px solid ${selected ? '#0F0F10' : '#D5D1C4'}`,
                      color: selected ? '#0F0F10' : '#6B7280',
                      background: selected ? 'rgba(15,15,16,0.06)' : 'transparent',
                    }}
                  >
                    {brand}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex justify-end gap-3" style={{ marginTop: 8, paddingTop: 16, borderTop: '1px solid #E5E1D6' }}>
            <Button variant="ghost" onClick={() => setShowNew(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleCreate}>Create Client</Button>
          </div>
        </div>
      </Modal>
    </PageLayout>
  );
}
