import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Wrench } from 'lucide-react';
import { PageLayout } from '@/components/layout/PageLayout';
import { Button } from '@/components/ui/Button';
import { StatusDot } from '@/components/ui/StatusDot';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { QuickCustomerModal } from '@/components/customers/QuickCustomerModal';
import { useRepairStore } from '@/stores/repairStore';
import { useCustomerStore } from '@/stores/customerStore';
import { useProductStore } from '@/stores/productStore';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { matchesDeep } from '@/core/utils/deep-search';
import type { Repair, RepairStatus } from '@/core/models/types';
import { REPAIR_FIELDS, type RepairFieldDef } from '@/core/models/repair-fields';

function fmt(v: number): string {
  return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

const STATUS_FILTERS: { value: RepairStatus | ''; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'received', label: 'Received' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'ready', label: 'Ready' },
  { value: 'picked_up', label: 'Picked Up' },
];

const NEXT_STATUS: Partial<Record<RepairStatus, { status: RepairStatus; label: string }>> = {
  received: { status: 'in_progress', label: 'Start' },
  in_progress: { status: 'ready', label: 'Mark Ready' },
  ready: { status: 'picked_up', label: 'Picked Up' },
};

export function RepairList() {
  const navigate = useNavigate();
  const { repairs, loadRepairs, createRepair, updateStatus } = useRepairStore();
  const { customers, loadCustomers } = useCustomerStore();
  const { categories, loadCategories } = useProductStore();
  const { invoices, loadInvoices } = useInvoiceStore();
  const [showNew, setShowNew] = useState(false);
  const [filterStatus, setFilterStatus] = useState<RepairStatus | ''>('');
  const [searchQuery, setSearchQuery] = useState('');
  const [showQuickCustomer, setShowQuickCustomer] = useState(false);
  const [form, setForm] = useState<Partial<Repair>>({
    repairType: 'internal',
    taxScheme: 'VAT_10',
    itemAttributes: {},
  });
  const [searchParams, setSearchParams] = useSearchParams();

  useEffect(() => { loadRepairs(); loadCustomers(); loadCategories(); loadInvoices(); }, [loadRepairs, loadCustomers, loadCategories, loadInvoices]);

  // Plan §Repair §Picked-Up-Gate (UX): button für „Picked Up" deaktivieren wenn
  // charge > 0 und noch nicht voll bezahlt — User sieht direkt warum's blockiert,
  // statt erst auf einen Alert zu warten.
  function isRepairBlockedFromPickup(rep: Repair): boolean {
    const charge = rep.chargeToCustomer || 0;
    if (charge <= 0.005) return false;
    if (rep.customerPaymentStatus === 'PAID') return false;
    if (rep.invoiceId) {
      const inv = invoices.find(i => i.id === rep.invoiceId);
      if (inv && (inv.paidAmount || 0) >= (inv.grossAmount || 0) - 0.005) return false;
    }
    return true;
  }

  // Filter Repair-Service-Kategorien aus der UI raus (interne Service-Items, keine Repair-Items)
  const repairableCategories = useMemo(
    () => categories.filter(c => !c.id.startsWith('cat-repair-service')),
    [categories]
  );

  // Aktive Field-Liste für die gewählte Kategorie. Falls keine Kategorie gewählt
  // oder unbekannt (Legacy-Repairs) → leere Liste, dann werden generische Felder gezeigt.
  const activeFields: RepairFieldDef[] = useMemo(() => {
    if (!form.itemCategoryId) return [];
    return REPAIR_FIELDS[form.itemCategoryId] || [];
  }, [form.itemCategoryId]);

  // Pre-fill customer from URL
  useEffect(() => {
    const customerParam = searchParams.get('customer');
    if (customerParam) {
      setForm(f => ({ ...f, customerId: customerParam }));
      setShowNew(true);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const customerOptions = useMemo(() => customers.map(c => ({
    id: c.id, label: `${c.firstName} ${c.lastName}`, subtitle: c.company, meta: c.phone,
  })), [customers]);

  const getCustomerName = (id: string) => {
    const c = customers.find(c => c.id === id);
    return c ? `${c.firstName} ${c.lastName}` : '\u2014';
  };

  const filtered = useMemo(() => {
    let r = repairs;
    if (searchQuery) {
      r = r.filter(rep => {
        const customer = customers.find(c => c.id === rep.customerId);
        return matchesDeep(rep, searchQuery, [customer, rep.product]);
      });
    }
    if (filterStatus) r = r.filter(rep => rep.status === filterStatus);
    return r;
  }, [repairs, searchQuery, filterStatus, customers]);

  function openNew() {
    setForm({
      repairType: 'internal',
      taxScheme: 'VAT_10',
      itemAttributes: {},
    });
    setShowNew(true);
  }

  function setRepairAttr(key: string, value: string | number | boolean) {
    setForm(f => ({ ...f, itemAttributes: { ...(f.itemAttributes || {}), [key]: value } }));
  }

  function setRepairCoreField(field: NonNullable<RepairFieldDef['coreField']>, value: string) {
    setForm(f => ({ ...f, [field]: value }));
  }

  function handleCreate() {
    if (!form.customerId || !form.issueDescription) return;
    // Plan §Repair §External: bei external/hybrid soll Estimated Cost als
    // internalCost mitlaufen, damit die Expense-Auto-Erzeugung bei Status='ready'
    // greift (siehe repairStore.updateStatus → external/hybrid → expenses).
    const effectiveInternalCost =
      (form.repairType === 'external' || form.repairType === 'hybrid')
        ? (form.internalCost || form.estimatedCost || 0)
        : (form.internalCost || 0);
    createRepair({ ...form, internalCost: effectiveInternalCost });
    setShowNew(false);
  }

  function handleQuickStatus(e: React.MouseEvent, repairId: string, newStatus: RepairStatus) {
    e.stopPropagation();
    try {
      updateStatus(repairId, newStatus);
    } catch (err) {
      // Plan §Repair §Picked-Up-Gate: charge > 0 → Invoice + Payment Pflicht.
      alert(err instanceof Error ? err.message : String(err));
    }
  }

  const activeCount = repairs.filter(r => r.status !== 'picked_up' && r.status !== 'cancelled').length;

  return (
    <PageLayout
      title="Repairs"
      subtitle={`${activeCount} active repairs`}
      showSearch onSearch={setSearchQuery} searchPlaceholder="Search by repair #, customer, item, voucher..."
      actions={
        <div className="flex items-center gap-3">
          {/* Status Filter */}
          <div className="flex gap-1" style={{ marginRight: 4 }}>
            {STATUS_FILTERS.map(sf => (
              <button key={sf.value} onClick={() => setFilterStatus(sf.value)}
                className="cursor-pointer transition-all duration-200"
                style={{
                  padding: '6px 12px', borderRadius: 999, fontSize: 12,
                  border: `1px solid ${filterStatus === sf.value ? '#0F0F10' : 'transparent'}`,
                  color: filterStatus === sf.value ? '#0F0F10' : '#6B7280',
                  background: filterStatus === sf.value ? 'rgba(15,15,16,0.06)' : 'transparent',
                }}>{sf.label}</button>
            ))}
          </div>
          <Button variant="primary" onClick={openNew}>New Repair</Button>
        </div>
      }
    >
      {/* Table Header */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1.2fr 1.8fr 2fr 1.5fr 1fr 1fr 1fr',
          gap: 16,
          padding: '0 16px 12px',
        }}
      >
        <span className="text-overline">REPAIR #</span>
        <span className="text-overline">CLIENT</span>
        <span className="text-overline">ITEM</span>
        <span className="text-overline">VOUCHER</span>
        <span className="text-overline">STATUS</span>
        <span className="text-overline" style={{ display: 'block', textAlign: 'right' }}>COST</span>
        <span className="text-overline" style={{ display: 'block', textAlign: 'right' }}>ACTION</span>
      </div>

      <div style={{ borderTop: '1px solid #E5E9EE' }} />

      {filtered.length === 0 && (
        <div style={{ padding: '64px 0', textAlign: 'center' }}>
          <Wrench size={40} strokeWidth={1} style={{ color: '#6B7280', margin: '0 auto 16px' }} />
          <p style={{ fontSize: 14, color: '#6B7280' }}>
            {searchQuery || filterStatus ? 'No repairs match your filters.' : 'No repairs yet. Create your first repair ticket.'}
          </p>
        </div>
      )}

      {filtered.map(rep => {
        const next = NEXT_STATUS[rep.status];
        const itemLabel = [rep.itemBrand, rep.itemModel].filter(Boolean).join(' ');
        const blockedPickup = next?.status === 'picked_up' && isRepairBlockedFromPickup(rep);

        return (
          <div
            key={rep.id}
            className="cursor-pointer transition-colors"
            style={{
              display: 'grid',
              gridTemplateColumns: '1.2fr 1.8fr 2fr 1.5fr 1fr 1fr 1fr',
              gap: 16,
              padding: '14px 16px',
              alignItems: 'center',
              borderBottom: '1px solid rgba(229,225,214,0.6)',
            }}
            onClick={() => navigate(`/repairs/${rep.id}`)}
            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(15,15,16,0.03)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            {/* Repair Number */}
            <div>
              <span className="font-mono" style={{ fontSize: 13, color: '#0F0F10' }}>{rep.repairNumber}</span>
              <div style={{ fontSize: 11, color: '#6B7280', marginTop: 2 }}>
                {rep.repairType === 'internal' ? 'Internal' : rep.repairType === 'external' ? 'External' : 'Hybrid'}
              </div>
            </div>

            {/* Client */}
            <div className="flex items-center gap-3">
              <div
                className="flex items-center justify-center rounded-full shrink-0"
                style={{ width: 32, height: 32, background: '#E5E9EE', border: '1px solid #D5D9DE', fontSize: 10, color: '#4B5563', fontWeight: 500 }}
              >
                {(() => {
                  const c = customers.find(c => c.id === rep.customerId);
                  return c ? (`${(c.firstName || '').charAt(0)}${(c.lastName || '').charAt(0)}`.toUpperCase() || '?') : '??';
                })()}
              </div>
              <span style={{ fontSize: 14, color: '#0F0F10' }}>{getCustomerName(rep.customerId)}</span>
            </div>

            {/* Item */}
            <div>
              <div style={{ fontSize: 13, color: '#0F0F10', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {itemLabel || rep.itemDescription || '\u2014'}
              </div>
              {rep.itemReference && (
                <span className="font-mono" style={{ fontSize: 11, color: '#6B7280' }}>{rep.itemReference}</span>
              )}
            </div>

            {/* Voucher Code */}
            <div>
              <span className="font-mono" style={{
                fontSize: 13, color: '#0F0F10', fontWeight: 600,
                letterSpacing: '0.08em',
                padding: '3px 10px', borderRadius: 6,
                background: 'rgba(15,15,16,0.06)',
                border: '1px solid rgba(15,15,16,0.15)',
              }}>{rep.voucherCode}</span>
            </div>

            {/* Status */}
            <StatusDot status={rep.status} />

            {/* Cost */}
            <div style={{ textAlign: 'right' }}>
              {rep.chargeToCustomer != null ? (
                <div>
                  <span className="font-mono" style={{ fontSize: 14, color: '#0F0F10' }}>{fmt(rep.chargeToCustomer)}</span>
                  <span style={{ fontSize: 10, color: '#6B7280', marginLeft: 3 }}>BHD</span>
                  {rep.margin != null && (
                    <div className="font-mono" style={{ fontSize: 11, color: rep.margin >= 0 ? '#7EAA6E' : '#AA6E6E', marginTop: 2 }}>
                      {rep.margin >= 0 ? '+' : ''}{fmt(rep.margin)}
                    </div>
                  )}
                </div>
              ) : (
                <span style={{ fontSize: 12, color: '#6B7280' }}>{rep.estimatedCost ? `~${fmt(rep.estimatedCost)}` : '\u2014'}</span>
              )}
            </div>

            {/* Quick Status Action */}
            <div style={{ textAlign: 'right' }}>
              {next && (
                <button
                  onClick={(e) => { if (!blockedPickup) handleQuickStatus(e, rep.id, next.status); else e.stopPropagation(); }}
                  disabled={blockedPickup}
                  title={blockedPickup ? 'Erst Invoice + Payment, dann Picked Up.' : undefined}
                  className={blockedPickup ? '' : 'cursor-pointer transition-all duration-200'}
                  style={{
                    padding: '5px 12px', fontSize: 11, borderRadius: 999,
                    border: `1px solid ${blockedPickup ? '#E5E9EE' : '#D5D9DE'}`,
                    color: blockedPickup ? '#9CA3AF' : '#4B5563',
                    background: 'transparent',
                    cursor: blockedPickup ? 'not-allowed' : 'pointer',
                    opacity: blockedPickup ? 0.5 : 1,
                  }}
                  onMouseEnter={e => {
                    if (blockedPickup) return;
                    e.currentTarget.style.borderColor = '#0F0F10';
                    e.currentTarget.style.color = '#0F0F10';
                    e.currentTarget.style.background = 'rgba(15,15,16,0.06)';
                  }}
                  onMouseLeave={e => {
                    if (blockedPickup) return;
                    e.currentTarget.style.borderColor = '#D5D9DE';
                    e.currentTarget.style.color = '#4B5563';
                    e.currentTarget.style.background = 'transparent';
                  }}
                >{blockedPickup ? 'Unpaid' : next.label}</button>
              )}
            </div>
          </div>
        );
      })}

      {/* New Repair Modal */}
      <Modal open={showNew} onClose={() => setShowNew(false)} title="New Repair" width={660}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxHeight: '65vh', overflowY: 'auto', paddingRight: 4 }}>

          {/* Customer Selector */}
          <div>
            <SearchSelect
              label="CLIENT"
              placeholder="Search clients by name, company, phone..."
              options={customerOptions}
              value={form.customerId || ''}
              onChange={id => setForm({ ...form, customerId: id || undefined })}
            />
            <button onClick={() => setShowQuickCustomer(true)}
              className="cursor-pointer transition-colors"
              style={{ background: 'none', border: 'none', color: '#0F0F10', fontSize: 11, marginTop: 6, padding: 0 }}
            >+ New Client</button>
          </div>

          {/* Item Details — kategoriebasiert (Plan §Repair §Item-Details) */}
          <div style={{ borderTop: '1px solid #E5E9EE', paddingTop: 20 }}>
            <span className="text-overline" style={{ marginBottom: 12, display: 'block' }}>ITEM CATEGORY</span>
            <div className="flex flex-wrap gap-2" style={{ marginTop: 8 }}>
              {repairableCategories.map(cat => {
                const active = form.itemCategoryId === cat.id;
                return (
                  <button key={cat.id}
                    onClick={() => setForm({ ...form, itemCategoryId: cat.id, itemAttributes: {}, itemBrand: undefined, itemModel: undefined, itemReference: undefined, itemSerial: undefined })}
                    className="cursor-pointer rounded-lg transition-all duration-200"
                    style={{
                      padding: '8px 14px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6,
                      border: `1px solid ${active ? cat.color : '#D5D9DE'}`,
                      color: active ? cat.color : '#6B7280',
                      background: active ? cat.color + '08' : 'transparent',
                    }}>
                    <span className="rounded-full" style={{ width: 5, height: 5, background: cat.color }} />
                    {cat.name}
                  </button>
                );
              })}
            </div>

            {/* Kategorie-spezifische Felder */}
            {activeFields.length > 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 16 }}>
                {activeFields.map(field => {
                  const value = field.coreField
                    ? (form[field.coreField] as string | undefined) || ''
                    : (form.itemAttributes?.[field.key] as string | number | undefined) ?? '';
                  if (field.type === 'select' && field.options) {
                    return (
                      <div key={field.key}>
                        <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>
                          {field.label.toUpperCase()}
                          {field.required && <span style={{ color: '#DC2626', marginLeft: 4 }}>*</span>}
                        </span>
                        <div className="flex flex-wrap gap-1" style={{ marginTop: 6 }}>
                          {field.options.map(opt => {
                            const sel = value === opt;
                            return (
                              <button key={opt}
                                onClick={() => field.coreField
                                  ? setRepairCoreField(field.coreField, opt)
                                  : setRepairAttr(field.key, opt)}
                                className="cursor-pointer transition-all duration-200"
                                style={{
                                  padding: '4px 10px', fontSize: 11, borderRadius: 999,
                                  border: `1px solid ${sel ? '#0F0F10' : '#D5D9DE'}`,
                                  color: sel ? '#0F0F10' : '#6B7280',
                                  background: sel ? 'rgba(15,15,16,0.06)' : 'transparent',
                                }}>{opt}</button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  }
                  return (
                    <Input key={field.key}
                      required={field.required}
                      label={field.label.toUpperCase() + (field.unit ? ` (${field.unit})` : '')}
                      type={field.type === 'number' ? 'number' : 'text'}
                      placeholder={field.label}
                      value={String(value)}
                      onChange={e => {
                        const v = field.type === 'number' ? Number(e.target.value) : e.target.value;
                        if (field.coreField) {
                          setRepairCoreField(field.coreField, String(v));
                        } else {
                          setRepairAttr(field.key, v);
                        }
                      }}
                    />
                  );
                })}
              </div>
            )}

            {/* Generische Brand/Model wenn keine Kategorie gewählt (Legacy / Quick-Capture) */}
            {!form.itemCategoryId && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 16 }}>
                <Input label="BRAND" placeholder="e.g. Rolex, Cartier" value={form.itemBrand || ''} onChange={e => setForm({ ...form, itemBrand: e.target.value })} />
                <Input label="MODEL" placeholder="e.g. Submariner" value={form.itemModel || ''} onChange={e => setForm({ ...form, itemModel: e.target.value })} />
              </div>
            )}

            <div style={{ marginTop: 16 }}>
              <Input label="ITEM DESCRIPTION (OPTIONAL)" placeholder="Additional details about the item..." value={form.itemDescription || ''} onChange={e => setForm({ ...form, itemDescription: e.target.value })} />
            </div>
          </div>

          {/* Issue Description */}
          <div style={{ borderTop: '1px solid #E5E9EE', paddingTop: 20 }}>
            <span className="text-overline" style={{ marginBottom: 8 }}>ISSUE</span>
            <textarea
              style={{
                width: '100%', marginTop: 8, background: 'transparent',
                borderBottom: '1px solid #D5D9DE', border: 'none', borderBottomStyle: 'solid', borderBottomWidth: 1, borderBottomColor: '#D5D9DE',
                padding: '10px 0', fontSize: 14, color: '#0F0F10',
                resize: 'vertical', minHeight: 60, outline: 'none',
                fontFamily: 'inherit',
              }}
              placeholder="Describe the issue or requested repair..."
              value={form.issueDescription || ''}
              onChange={e => setForm({ ...form, issueDescription: e.target.value })}
              onFocus={e => (e.currentTarget.style.borderBottomColor = '#0F0F10')}
              onBlur={e => (e.currentTarget.style.borderBottomColor = '#D5D9DE')}
            />
          </div>

          {/* Repair Type */}
          <div>
            <span className="text-overline" style={{ marginBottom: 8, display: 'block' }}>REPAIR TYPE</span>
            <div className="flex gap-2" style={{ marginTop: 8 }}>
              {(['internal', 'external', 'hybrid'] as Repair['repairType'][]).map(type => (
                <button key={type} onClick={() => setForm({ ...form, repairType: type })}
                  className="cursor-pointer rounded transition-all duration-200"
                  style={{
                    padding: '7px 14px', fontSize: 12,
                    border: `1px solid ${form.repairType === type ? '#0F0F10' : '#D5D9DE'}`,
                    color: form.repairType === type ? '#0F0F10' : '#6B7280',
                    background: form.repairType === type ? 'rgba(15,15,16,0.06)' : 'transparent',
                  }}>
                  {type.charAt(0).toUpperCase() + type.slice(1)}
                </button>
              ))}
            </div>
            <p style={{ fontSize: 11, color: '#6B7280', marginTop: 6 }}>
              {form.repairType === 'internal' && 'Komplett intern bearbeitet — keine externen Kosten.'}
              {form.repairType === 'external' && 'Komplett extern bearbeitet — Estimated Cost = Workshop-Rechnung. Wird bei Status „Ready" als Expense gebucht.'}
              {form.repairType === 'hybrid' && 'Teil intern, Teil extern — der externe Anteil (Estimated Cost) wird als Expense gebucht.'}
            </p>
          </div>

          {/* External-Workshop-Bereich — nur bei external/hybrid sichtbar */}
          {(form.repairType === 'external' || form.repairType === 'hybrid') && (
            <div style={{ borderTop: '1px solid #E5E9EE', paddingTop: 20 }}>
              <span className="text-overline" style={{ marginBottom: 12 }}>EXTERNAL REPAIR DETAILS</span>
              <div style={{ marginTop: 12 }}>
                <Input label="WORKSHOP NAME" placeholder="z.B. Swiss Time Workshop"
                  value={form.externalVendor || ''}
                  onChange={e => setForm({ ...form, externalVendor: e.target.value })} />
                <p style={{ fontSize: 11, color: '#6B7280', marginTop: 6 }}>
                  Estimated Cost (unten) = was der Workshop berechnet. Wird bei Status „Ready" automatisch als Expense in /expenses + /payables gebucht (status PENDING bis bezahlt).
                </p>
              </div>
            </div>
          )}

          {/* Costs */}
          <div style={{ borderTop: '1px solid #E5E9EE', paddingTop: 20 }}>
            <span className="text-overline" style={{ marginBottom: 12 }}>COSTS</span>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginTop: 12 }}>
              <Input label={form.repairType === 'internal' ? 'ESTIMATED COST (BHD)' : 'ESTIMATED COST / WORKSHOP FEE (BHD)'}
                type="number" placeholder="0"
                value={form.estimatedCost || ''}
                onChange={e => setForm({ ...form, estimatedCost: Number(e.target.value) || undefined })} />
              <Input label="CHARGE TO CLIENT (BHD)" type="number" placeholder="0 = free repair"
                value={form.chargeToCustomer || ''}
                onChange={e => setForm({ ...form, chargeToCustomer: Number(e.target.value) || undefined })} />
            </div>

            {/* Service-Tax-Scheme: Default VAT_10 (Standard für Service in BH).
                Auf ZERO setzen wenn Service vom Workshop schon mit VAT abgerechnet
                wurde oder generell nicht VAT-pflichtig ist. */}
            <div style={{ marginTop: 16 }}>
              <span className="text-overline" style={{ marginBottom: 8, display: 'block' }}>SERVICE TAX SCHEME (FOR INVOICE)</span>
              <div className="flex gap-2" style={{ marginTop: 8 }}>
                {(['ZERO', 'VAT_10'] as const).map(scheme => (
                  <button key={scheme} onClick={() => setForm({ ...form, taxScheme: scheme })}
                    className="cursor-pointer rounded transition-all duration-200"
                    style={{
                      padding: '7px 14px', fontSize: 12,
                      border: `1px solid ${form.taxScheme === scheme ? '#0F0F10' : '#D5D9DE'}`,
                      color: form.taxScheme === scheme ? '#0F0F10' : '#6B7280',
                      background: form.taxScheme === scheme ? 'rgba(15,15,16,0.06)' : 'transparent',
                    }}>{scheme === 'ZERO' ? '0% (no VAT)' : 'VAT 10%'}</button>
                ))}
              </div>
              <p style={{ fontSize: 11, color: '#6B7280', marginTop: 6 }}>
                Wird beim Erstellen der Repair-Invoice angewendet. Charge to Client gilt als gross-incl-VAT bei 10%.
              </p>
            </div>

            {(form.estimatedCost || 0) > 0 && (form.chargeToCustomer || 0) > 0 && (
              <div className="rounded font-mono" style={{
                marginTop: 12, padding: 12, background: '#F2F7FA', border: '1px solid #E5E9EE',
                fontSize: 13, display: 'flex', justifyContent: 'space-between',
              }}>
                <span style={{ color: '#6B7280' }}>Estimated Margin</span>
                <span style={{ color: ((form.chargeToCustomer || 0) - (form.estimatedCost || 0)) >= 0 ? '#7EAA6E' : '#AA6E6E' }}>
                  {fmt((form.chargeToCustomer || 0) - (form.estimatedCost || 0))} BHD
                </span>
              </div>
            )}
            {(form.chargeToCustomer || 0) === 0 && (
              <p style={{ fontSize: 11, color: '#6B7280', marginTop: 8 }}>
                Charge = 0 → Free repair, kein Invoice nötig. Kann direkt nach Fertigstellung auf Picked Up.
              </p>
            )}
          </div>

          {/* Estimated Ready Date */}
          <Input label="ESTIMATED READY DATE" type="date" value={form.estimatedReady || ''} onChange={e => setForm({ ...form, estimatedReady: e.target.value })} />

          {/* Notes */}
          <div>
            <span className="text-overline" style={{ marginBottom: 8 }}>NOTES</span>
            <textarea
              style={{
                width: '100%', marginTop: 8, background: 'transparent',
                border: 'none', borderBottomStyle: 'solid', borderBottomWidth: 1, borderBottomColor: '#D5D9DE',
                padding: '10px 0', fontSize: 14, color: '#0F0F10',
                resize: 'vertical', minHeight: 48, outline: 'none',
                fontFamily: 'inherit',
              }}
              placeholder="Internal notes..."
              value={form.notes || ''}
              onChange={e => setForm({ ...form, notes: e.target.value })}
              onFocus={e => (e.currentTarget.style.borderBottomColor = '#0F0F10')}
              onBlur={e => (e.currentTarget.style.borderBottomColor = '#D5D9DE')}
            />
          </div>

          <div className="flex justify-end gap-3" style={{ marginTop: 8, paddingTop: 16, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setShowNew(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleCreate}>Create Repair</Button>
          </div>
        </div>
      </Modal>

      <QuickCustomerModal
        open={showQuickCustomer}
        onClose={() => setShowQuickCustomer(false)}
        onCreated={(id) => { loadCustomers(); setForm(f => ({ ...f, customerId: id })); }}
      />
    </PageLayout>
  );
}
