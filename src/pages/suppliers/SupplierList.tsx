// Plan §Supplier — List + inline create modal + ledger preview
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2 } from 'lucide-react';
import { PageLayout } from '@/components/layout/PageLayout';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { PhoneInput } from '@/components/ui/PhoneInput';
import { ImageUpload } from '@/components/ui/ImageUpload';
import { SoftWarn } from '@/components/ui/SoftWarn';
import { DuplicateWarningBanner } from '@/components/contacts/DuplicateWarningBanner';
import { findSimilarContacts } from '@/core/contacts/duplicate-check';
import { validateCpr, validatePhone } from '@/core/contacts/contact-validate';
import { useSupplierStore } from '@/stores/supplierStore';
import { matchesDeep } from '@/core/utils/deep-search';
import { useSharedWrite, fehlertext } from '@/core/data/shared-write';
import { WriteError } from '@/components/shared/WriteError';
import { saveSupplierCreate, saveSupplierUpdate } from '@/core/masterdata/masterdata-save';
import { workshopSuggestions } from '@/core/repairs/repair-workshop-choice';
import { UseCustomerAsSupplier } from '@/components/suppliers/UseCustomerAsSupplier';
import type { Supplier } from '@/core/models/types';
import { Bhd } from '@/components/ui/Bhd';

function fmt(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}

export function SupplierList() {
  const navigate = useNavigate();
  const { suppliers, loadSuppliers } = useSupplierStore();
  // CENTRAL-UI-PARITY R6C — „New Supplier": am Primary die Hausfunktion, auf PC2 `suppliers.create`.
  // Dieselbe Folge wie „+ New Supplier" im Einkauf und in der Werkstatt (masterdata-save).
  const anlegen = useSharedWrite<{ supplierId: string }>('suppliers.create');
  const [fehler, setFehler] = useState('');
  // REPAIR-WORKSHOP-FILTER — Vorschläge aus alten Reparaturen: nur anzeigen; markiert wird erst auf Klick (suppliers.update).
  const markieren = useSharedWrite<{ id: string }>('suppliers.update');
  const [vorschlagFehler, setVorschlagFehler] = useState('');
  const vorschlaege = useMemo(() => workshopSuggestions(suppliers), [suppliers]);
  async function handleMarkWorkshop(id: string) {
    const s = suppliers.find(x => x.id === id);
    if (!s) return;
    setVorschlagFehler('');
    // `cprImage` ausdrücklich NICHT mitgeben (wie „Deactivate"): nur die Einordnung ändert sich.
    const r = await saveSupplierUpdate(markieren, s, { ...s, cprImage: undefined, isWorkshop: true });
    if (r.kind !== 'ok') setVorschlagFehler(`Could not mark ${s.name} as workshop: ${fehlertext(r)}`);
  }
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState<Partial<Supplier>>({});
  // CUSTOMER-SUPPLIER-ROLE-LINK — „New Supplier": neu erfassen ODER die Lieferanten-Rolle eines Kunden.
  const [createMode, setCreateMode] = useState<'new' | 'customer'>('new');

  useEffect(() => { loadSuppliers(); }, [loadSuppliers]);

  // Default nur aktive; "Show inactive" blendet inaktive ein. Die Suche
  // durchsucht nur die aktuell eingeblendete Menge.
  const visible = useMemo(
    () => (showInactive ? suppliers : suppliers.filter(s => s.active)),
    [suppliers, showInactive],
  );
  const filtered = useMemo(() => {
    if (!search) return visible;
    return visible.filter(s => matchesDeep(s, search));
  }, [visible, search]);

  const activeCount = useMemo(() => suppliers.filter(s => s.active).length, [suppliers]);
  const inactiveCount = suppliers.length - activeCount;

  async function handleCreate() {
    setFehler('');
    const r = await saveSupplierCreate(anlegen, form);
    if (r.kind !== 'ok') { setFehler(`Could not create supplier: ${fehlertext(r)}`); return; }
    setShowNew(false);
    setForm({});
  }

  // Duplicate-Check live im New-Supplier-Modal (Name oder Phone).
  const duplicateMatches = useMemo(() => {
    if (!showNew) return [];
    return findSimilarContacts(
      { name: form.name, phone: form.phone },
      suppliers,
    );
  }, [showNew, form.name, form.phone, suppliers]);

  const totalOutstanding = suppliers.reduce((s, x) => s + (x.outstandingBalance || 0), 0);
  const totalCredit = suppliers.reduce((s, x) => s + (x.creditBalance || 0), 0);

  return (
    <PageLayout
      title="Suppliers"
      subtitle={`${activeCount} active${inactiveCount > 0 ? ` · ${inactiveCount} inactive` : ''} · ${fmt(totalOutstanding)} BHD outstanding · ${fmt(totalCredit)} BHD credit`}
      showSearch onSearch={setSearch} searchPlaceholder="Search supplier by name or phone..."
      actions={
        <>
          {inactiveCount > 0 && (
            <Button variant="ghost" onClick={() => setShowInactive(v => !v)}>
              {showInactive ? 'Hide inactive' : `Show inactive (${inactiveCount})`}
            </Button>
          )}
          <Button variant="primary" onClick={() => setShowNew(true)}>New Supplier</Button>
        </>
      }
    >
      {vorschlaege.length > 0 && (
        <div data-workshop-suggestions style={{ marginBottom: 16 }}>
        <Card style={{ padding: 16 }}>
          <span className="text-overline" style={{ display: 'block', marginBottom: 6 }}>WORKSHOP SUGGESTIONS</span>
          <p style={{ fontSize: 12, color: '#6B7280', lineHeight: 1.5, margin: '0 0 10px' }}>
            These suppliers already worked as a workshop in earlier repairs but are not marked as workshop. Repair → Workshop only
            offers marked workshops. Nothing is marked automatically — purchases, payments and bookings are not affected.
          </p>
          <WriteError text={vorschlagFehler} />
          {vorschlaege.map(v => (
            <div key={v.id} className="flex items-center justify-between" data-workshop-suggestion={v.id}
              style={{ padding: '8px 0', borderTop: '1px solid #F0F2F5', fontSize: 13 }}>
              <span>
                <span style={{ color: '#0F0F10' }}>{v.name}</span>
                <span style={{ color: '#6B7280', marginLeft: 8 }}>used in {v.uses} repair{v.uses === 1 ? '' : 's'}</span>
              </span>
              <Button variant="secondary" onClick={() => void handleMarkWorkshop(v.id)} disabled={markieren.busy} data-workshop-suggestion-mark={v.id}>
                Mark as Workshop
              </Button>
            </div>
          ))}
        </Card>
        </div>
      )}

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
            {['NAME', 'CONTACT', 'PURCHASES + EXPENSES', 'PAID', 'OUTSTANDING', 'CREDIT', 'STATUS'].map(h => (
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
                <div style={{ fontSize: 14, color: '#0F0F10' }}>
                  {s.name}
                  {s.isWorkshop && (
                    <span data-supplier-workshop-badge style={{ fontSize: 10, padding: '1px 7px', borderRadius: 999, marginLeft: 8, color: '#3D7FFF', background: 'rgba(61,127,255,0.08)' }}>Workshop</span>
                  )}
                </div>
                {s.address && <div style={{ fontSize: 11, color: '#6B7280' }}>{s.address}</div>}
              </div>
              <div style={{ fontSize: 12, color: '#4B5563' }}>
                {s.phone && <div>{s.phone}</div>}
                {s.email && <div style={{ color: '#6B7280' }}>{s.email}</div>}
              </div>
              <div className="font-mono" style={{ fontSize: 13, color: '#0F0F10' }}><Bhd v={s.totalPurchases || 0}/></div>
              <div className="font-mono" style={{ fontSize: 13, color: '#16A34A' }}><Bhd v={s.totalPaid || 0}/></div>
              <div className="font-mono" style={{ fontSize: 13, color: (s.outstandingBalance || 0) > 0 ? '#DC2626' : '#6B7280' }}>
                <Bhd v={s.outstandingBalance || 0}/>
              </div>
              <div className="font-mono" style={{ fontSize: 13, color: (s.creditBalance || 0) > 0 ? '#AA956E' : '#6B7280' }}>
                <Bhd v={s.creditBalance || 0}/>
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

      <Modal open={showNew} onClose={() => { setShowNew(false); setCreateMode('new'); }} title="New Supplier" width={500}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', gap: 8 }} data-supplier-create-mode>
            <Button variant={createMode === 'new' ? 'primary' : 'ghost'} onClick={() => setCreateMode('new')}>New supplier</Button>
            <Button variant={createMode === 'customer' ? 'primary' : 'ghost'} onClick={() => setCreateMode('customer')}>Use existing customer</Button>
          </div>
          {createMode === 'customer' ? (
            <UseCustomerAsSupplier
              onCancel={() => { setShowNew(false); setCreateMode('new'); }}
              onDone={(id) => { setShowNew(false); setCreateMode('new'); navigate(`/suppliers/${id}`); }}
            />
          ) : <>
          <WriteError text={fehler} />
          {duplicateMatches.length > 0 && (
            <DuplicateWarningBanner
              matches={duplicateMatches}
              entityLabel="supplier"
              onSelectMatch={s => { setShowNew(false); navigate(`/suppliers/${s.id}`); }}
            />
          )}
          <Input required label="NAME" placeholder="e.g. Gold Dealer LLC" value={form.name || ''} onChange={e => setForm({ ...form, name: e.target.value })} autoFocus />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div>
              <PhoneInput label="PHONE" value={form.phone || ''} onChange={v => setForm({ ...form, phone: v })} />
              <SoftWarn warning={validatePhone(form.phone).warning} />
            </div>
            <Input label="EMAIL" placeholder="contact@supplier.com" value={form.email || ''} onChange={e => setForm({ ...form, email: e.target.value })} />
          </div>
          <Input label="ADDRESS" placeholder="Street, City" value={form.address || ''} onChange={e => setForm({ ...form, address: e.target.value })} />
          <div>
            <Input label="CPR / ID NUMBER" placeholder="e.g. 900123456" value={form.cpr || ''} onChange={e => setForm({ ...form, cpr: e.target.value })} />
            <SoftWarn warning={validateCpr(form.cpr).warning} />
          </div>
          <div>
            <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>CPR / ID CARD PHOTO</span>
            <p style={{ fontSize: 11, color: '#9CA3AF', marginBottom: 6 }}>Wird auf jedem Ankaufs-Print mitgedruckt.</p>
            <ImageUpload
              images={form.cprImage ? [form.cprImage] : []}
              onChange={imgs => setForm({ ...form, cprImage: imgs[0] || undefined })}
              maxImages={1}
            />
          </div>
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
          {/* REPAIR-WORKSHOP-FILTER — eine reine Einordnung (nur dann in Repair → Workshop wählbar). */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: '#4B5563', cursor: 'pointer' }}>
            <input type="checkbox" checked={form.isWorkshop === true} onChange={e => setForm({ ...form, isWorkshop: e.target.checked })} data-supplier-create-is-workshop />
            <span>Is Workshop — selectable as workshop in repairs</span>
          </label>
          <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setShowNew(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => void handleCreate()} disabled={!form.name || anlegen.busy} data-supplier-create-save>
              {duplicateMatches.length > 0 ? 'Create anyway' : 'Create Supplier'}
            </Button>
          </div>
          </>}
        </div>
      </Modal>
    </PageLayout>
  );
}
