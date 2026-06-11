import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { PageLayout } from '@/components/layout/PageLayout';
import { Button } from '@/components/ui/Button';
import { VIPBadge } from '@/components/ui/VIPBadge';
import { StatusDot } from '@/components/ui/StatusDot';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { PhoneInput } from '@/components/ui/PhoneInput';
import { SoftWarn } from '@/components/ui/SoftWarn';
import { DuplicateWarningBanner } from '@/components/contacts/DuplicateWarningBanner';
import { findSimilarContacts } from '@/core/contacts/duplicate-check';
import { validateCpr, validatePhone } from '@/core/contacts/contact-validate';
import { useCustomerStore } from '@/stores/customerStore';
import { matchesDeep } from '@/core/utils/deep-search';
import type { Customer, VIPLevel } from '@/core/models/types';
import { Bhd } from '@/components/ui/Bhd';


const BRANDS = ['Rolex', 'Patek Philippe', 'Audemars Piguet', 'Richard Mille', 'Vacheron Constantin', 'A. Lange & Sohne', 'Omega', 'Cartier'];

export function CustomerList() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { customers, loadCustomers, createCustomer, searchQuery, setSearchQuery, getCustomerStats } = useCustomerStore();
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState<Partial<Customer>>({
    country: 'BH', language: 'en', vipLevel: 0, customerType: 'collector', salesStage: 'lead', preferences: [],
  });

  useEffect(() => { loadCustomers(); }, [loadCustomers]);

  // ?filter=outstanding → nur Kunden mit offener AR (Invoice + Approval-Sold + Consignment-Sold).
  // Spiegelt den Dashboard-RECEIVABLES-Klick-Pfad: User soll genau die Kunden sehen,
  // deren AR-Balance in die Dashboard-Summe einfliesst.
  const filterMode = searchParams.get('filter') || '';

  // M-01 — Stats EINMAL pro Kunde berechnen (Batch-Map): Filter und Zeilen-Render
  // lesen aus derselben Map statt getCustomerStats doppelt pro Kunde aufzurufen.
  const statsById = useMemo(() => {
    const m = new Map<string, ReturnType<typeof getCustomerStats>>();
    for (const c of customers) m.set(c.id, getCustomerStats(c.id));
    return m;
  }, [customers, getCustomerStats]);

  const filtered = useMemo(() => {
    let r = customers;
    if (searchQuery) r = r.filter(c => matchesDeep(c, searchQuery));
    if (filterMode === 'outstanding') {
      r = r.filter(c => (statsById.get(c.id)?.invoiceOutstanding || 0) > 0.005);
    }
    return r;
  }, [customers, searchQuery, filterMode, statsById]);

  function clearFilter() {
    const next = new URLSearchParams(searchParams);
    next.delete('filter');
    setSearchParams(next, { replace: true });
  }

  function handleCreate() {
    if (!form.firstName || !form.lastName) return;
    createCustomer(form);
    setShowNew(false);
    setForm({ country: 'BH', language: 'en', vipLevel: 0, customerType: 'collector', salesStage: 'lead', preferences: [] });
  }

  // Duplicate-Check live waehrend der Eingabe im New-Client-Modal.
  const duplicateMatches = useMemo(() => {
    if (!showNew) return [];
    return findSimilarContacts(
      { firstName: form.firstName, lastName: form.lastName, phone: form.phone, whatsapp: form.whatsapp },
      customers,
    );
  }, [showNew, form.firstName, form.lastName, form.phone, form.whatsapp, customers]);

  return (
    <PageLayout
      title="Clients"
      subtitle={filterMode === 'outstanding'
        ? `${filtered.length} client${filtered.length === 1 ? '' : 's'} with outstanding receivables`
        : `${customers.length} clients`}
      showSearch onSearch={setSearchQuery} searchPlaceholder="Search clients..."
      actions={<Button variant="primary" onClick={() => setShowNew(true)}>New Client</Button>}
    >
      {filterMode === 'outstanding' && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 16px', marginBottom: 12,
          background: 'rgba(255,135,48,0.08)',
          border: '1px solid rgba(255,135,48,0.25)',
          borderRadius: 6,
          fontSize: 13, color: '#0F0F10',
        }}>
          <span>Showing only clients with open receivables (invoices, approval-sold, consignment-sold)</span>
          <button onClick={clearFilter}
            style={{ fontSize: 12, color: '#3D7FFF', background: 'transparent', border: 'none', cursor: 'pointer' }}>
            ✕ Clear filter
          </button>
        </div>
      )}

      {/* Table Header */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0,2.4fr) minmax(0,0.9fr) minmax(0,0.8fr) minmax(0,1.4fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)',
          gap: 16,
          padding: '0 16px 12px',
        }}
      >
        <span className="text-overline">CLIENT</span>
        <span className="text-overline">STATUS</span>
        <span className="text-overline">VIP</span>
        <span className="text-overline">PREFERENCES</span>
        <span className="text-overline" style={{ display: 'block', textAlign: 'right' }}>REVENUE</span>
        <span className="text-overline" style={{ display: 'block', textAlign: 'right' }}>PROFIT</span>
        <span className="text-overline" style={{ display: 'block', textAlign: 'right' }}>OUTSTANDING</span>
      </div>

      <div style={{ borderTop: '1px solid #E5E9EE' }} />

      {filtered.length === 0 && (
        <div style={{ padding: '64px 0', textAlign: 'center', fontSize: 14, color: '#6B7280' }}>
          {searchQuery ? 'No clients match your search.' : 'No clients yet. Create your first client.'}
        </div>
      )}

      {filtered.map(c => {
        const stats = statsById.get(c.id) ?? getCustomerStats(c.id);
        return (
          <div
            key={c.id}
            className="cursor-pointer transition-colors"
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0,2.4fr) minmax(0,0.9fr) minmax(0,0.8fr) minmax(0,1.4fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)',
              gap: 16,
              padding: '14px 16px',
              alignItems: 'center',
              borderBottom: '1px solid rgba(229,225,214,0.6)',
            }}
            onClick={() => navigate(`/clients/${c.id}`)}
            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(15,15,16,0.03)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <div className="flex items-center gap-3" style={{ minWidth: 0 }}>
              <div
                className="flex items-center justify-center rounded-full shrink-0"
                style={{ width: 36, height: 36, background: '#E5E9EE', border: '1px solid #D5D9DE', fontSize: 11, color: '#4B5563', fontWeight: 500 }}
              >
                {`${(c.firstName || '').charAt(0)}${(c.lastName || '').charAt(0)}`.toUpperCase() || '?'}
              </div>
              <div style={{ minWidth: 0, overflow: 'hidden' }}>
                <div style={{ fontSize: 14, color: '#0F0F10', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.firstName} {c.lastName}</div>
                {c.company && <div style={{ fontSize: 11, color: '#6B7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.company}</div>}
              </div>
            </div>
            <div style={{ minWidth: 0 }}><StatusDot status={c.salesStage} /></div>
            <div style={{ minWidth: 0 }}><VIPBadge level={c.vipLevel} /></div>
            <div style={{ fontSize: 12, color: '#4B5563', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
              {(c.preferences || []).join(', ') || '\u2014'}
            </div>
            <div className="font-mono" style={{ textAlign: 'right', fontSize: 14, color: '#0F0F10', minWidth: 0, overflow: 'hidden' }}>
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><Bhd v={stats.revenue}/></div>
              <div style={{ fontSize: 10, color: '#6B7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {stats.invoiceCount} invoice{stats.invoiceCount !== 1 ? 's' : ''}
              </div>
            </div>
            <div className="font-mono" style={{ textAlign: 'right', fontSize: 14, color: stats.profit >= 0 ? '#7EAA6E' : '#AA6E6E', minWidth: 0, overflow: 'hidden' }}>
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><Bhd v={stats.profit}/></div>
              <div style={{ fontSize: 10, color: '#6B7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {stats.revenue > 0 ? `${((stats.profit / stats.revenue) * 100).toFixed(1)}% margin` : '—'}
              </div>
            </div>
            <div className="font-mono" style={{ textAlign: 'right', fontSize: 14, color: stats.outstanding > 0 ? '#AA6E6E' : '#6B7280', minWidth: 0, overflow: 'hidden' }}>
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{stats.outstanding > 0 ? <Bhd v={stats.outstanding}/> : '\u2014'}</div>
              {stats.openInvoiceCount > 0 && (
                <div
                  onClick={e => { e.stopPropagation(); navigate(`/invoices?customer=${c.id}`); }}
                  style={{ fontSize: 10, color: '#3D7FFF', cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: 'underline' }}>
                  {stats.openInvoiceCount} open
                </div>
              )}
            </div>
          </div>
        );
      })}

      {/* New Client Modal */}
      <Modal open={showNew} onClose={() => setShowNew(false)} title="New Client" width={560}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {duplicateMatches.length > 0 && (
            <DuplicateWarningBanner
              matches={duplicateMatches}
              entityLabel="client"
              onSelectMatch={c => { setShowNew(false); navigate(`/clients/${c.id}`); }}
            />
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
            <Input required label="FIRST NAME" placeholder="Ahmed" value={form.firstName || ''} onChange={e => setForm({ ...form, firstName: e.target.value })} />
            <Input required label="LAST NAME" placeholder="Al-Khalifa" value={form.lastName || ''} onChange={e => setForm({ ...form, lastName: e.target.value })} />
          </div>
          <Input label="COMPANY" placeholder="Company name" value={form.company || ''} onChange={e => setForm({ ...form, company: e.target.value })} />
          <div>
            <Input label="PERSONAL ID (CPR / PASSPORT)" placeholder="e.g. 900123456" value={form.personalId || ''} onChange={e => setForm({ ...form, personalId: e.target.value })} />
            <SoftWarn warning={validateCpr(form.personalId).warning} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
            <div>
              <PhoneInput label="PHONE" value={form.phone || ''} onChange={v => setForm({ ...form, phone: v })} />
              <SoftWarn warning={validatePhone(form.phone).warning} />
            </div>
            <div>
              <PhoneInput label="WHATSAPP" value={form.whatsapp || ''} onChange={v => setForm({ ...form, whatsapp: v })} />
              <SoftWarn warning={validatePhone(form.whatsapp).warning} />
            </div>
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
                    border: `1px solid ${form.vipLevel === level ? '#0F0F10' : '#D5D9DE'}`,
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
                      border: `1px solid ${selected ? '#0F0F10' : '#D5D9DE'}`,
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

          <div className="flex justify-end gap-3" style={{ marginTop: 8, paddingTop: 16, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setShowNew(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleCreate}>
              {duplicateMatches.length > 0 ? 'Create anyway' : 'Create Client'}
            </Button>
          </div>
        </div>
      </Modal>
    </PageLayout>
  );
}
