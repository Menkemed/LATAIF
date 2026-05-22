// Plan §Supplier §8: Detail-View mit Ledger + Purchase/Payment/Return-Historie
import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Building2, Edit3, Save, Trash2 } from 'lucide-react';
import { useGoBack } from '@/hooks/useGoBack';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Bhd } from '@/components/ui/Bhd';
import { KPICard } from '@/components/ui/KPICard';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { ImageUpload } from '@/components/ui/ImageUpload';
import { SoftWarn } from '@/components/ui/SoftWarn';
import { PhoneInput } from '@/components/ui/PhoneInput';
import { validateCpr, validatePhone } from '@/core/contacts/contact-validate';
import { HistoryDrawer } from '@/components/shared/HistoryPanel';
import { useSupplierStore } from '@/stores/supplierStore';
import { usePurchaseStore } from '@/stores/purchaseStore';
import { useGoldStore } from '@/stores/goldStore';
import { SettleGoldModal, type SettleGoldMode } from '@/components/repairs/SettleGoldModal';
import type { GoldPayable } from '@/core/models/types';
import { query } from '@/core/db/helpers';
import type { Supplier } from '@/core/models/types';

function fmt(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}

function fmtDate(iso?: string): string {
  if (!iso) return '\u2014';
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function SupplierDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const goBack = useGoBack('/suppliers');
  const { suppliers, loadSuppliers, updateSupplier, deleteSupplier, getLedger } = useSupplierStore();
  const { purchases, loadPurchases } = usePurchaseStore();
  // v0.4.4 — KEIN useGoldStore() ohne Selector: das ganze Store-Objekt aendert
  // bei jeder Mutation seine Referenz. In einer useEffect-Dependency + loadAll()
  // im Effect → Endlos-Loop (SupplierDetail fror beim Oeffnen ein, zeigte
  // "Supplier not found"). Stabile Selektoren — Actions sind referenz-stabil.
  const goldLoadAll = useGoldStore(s => s.loadAll);
  const getGoldOwedBySupplier = useGoldStore(s => s.getGoldOwedBySupplier);
  const getGoldPayablesBySupplier = useGoldStore(s => s.getGoldPayablesBySupplier);
  const goldPayables = useGoldStore(s => s.goldPayables);
  const [settleModal, setSettleModal] = useState<{ open: boolean; mode: SettleGoldMode; payable?: GoldPayable }>({ open: false, mode: 'settle_supplier_return' });
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Partial<Supplier>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => { loadSuppliers(); loadPurchases(); goldLoadAll(); }, [loadSuppliers, loadPurchases, goldLoadAll]);

  // Plan repair-multi-supplier — Gold-Buckets fuer diesen Supplier
  const goldOwedSummary = useMemo(() => id ? getGoldOwedBySupplier(id) : [], [id, getGoldOwedBySupplier, goldPayables]);
  const supplierGoldPayables = useMemo(() => id ? getGoldPayablesBySupplier(id) : [], [id, getGoldPayablesBySupplier, goldPayables]);

  const supplier = useMemo(() => suppliers.find(s => s.id === id), [suppliers, id]);

  useEffect(() => {
    if (supplier) setForm({ ...supplier });
  }, [supplier]);

  const ledger = useMemo(() => id ? getLedger(id) : { totalPurchases: 0, totalPaid: 0, outstandingBalance: 0, creditBalance: 0 }, [id, getLedger, purchases]);

  const supplierPurchases = useMemo(
    () => id ? purchases.filter(p => p.supplierId === id).sort((a, b) => b.purchaseDate.localeCompare(a.purchaseDate)) : [],
    [purchases, id]
  );

  // Payment-Historie aus purchase_payments
  const payments = useMemo(() => {
    if (!id) return [] as Array<{ id: string; purchaseNumber: string; amount: number; method: string; paidAt: string; reference?: string }>;
    try {
      const rows = query(
        `SELECT pp.id, pp.amount, pp.method, pp.paid_at, pp.reference, p.purchase_number
         FROM purchase_payments pp
         JOIN purchases p ON p.id = pp.purchase_id
         WHERE p.supplier_id = ?
         ORDER BY pp.paid_at DESC`,
        [id]
      );
      return rows.map(r => ({
        id: r.id as string,
        purchaseNumber: r.purchase_number as string,
        amount: r.amount as number,
        method: r.method as string,
        paidAt: r.paid_at as string,
        reference: r.reference as string | undefined,
      }));
    } catch { return []; }
  }, [id, purchases]);

  const returns = useMemo(() => {
    if (!id) return [] as Array<{ id: string; returnNumber: string; totalAmount: number; returnDate: string; status: string; refundMethod?: string }>;
    try {
      const rows = query(
        `SELECT id, return_number, total_amount, return_date, status, refund_method
         FROM purchase_returns WHERE supplier_id = ? ORDER BY return_date DESC`,
        [id]
      );
      return rows.map(r => ({
        id: r.id as string,
        returnNumber: r.return_number as string,
        totalAmount: r.total_amount as number,
        returnDate: r.return_date as string,
        status: r.status as string,
        refundMethod: r.refund_method as string | undefined,
      }));
    } catch { return []; }
  }, [id, purchases]);

  // Workshop-/Service-Payables: A/P-Expenses aus Repairs UND Orders. Order-
  // Kostenzeilen (Goldschmied-Labor, Diamant-Einkauf bei Sonderanfertigungen)
  // tragen related_module='order' — vorher fehlten sie hier komplett, obwohl
  // die OUTSTANDING-KPI sie laengst mitzaehlt (getLedger summiert ALLE expenses
  // des Suppliers, modul-unabhaengig). Jetzt deckt sich Liste wieder mit KPI.
  const workshopExpenses = useMemo(() => {
    if (!id) return [] as Array<{ id: string; expenseNumber: string; description: string; amount: number; paidAmount: number; expenseDate: string; status: string; module: string; linkId?: string }>;
    try {
      const rows = query(
        `SELECT id, expense_number, description, amount, paid_amount, expense_date, status, related_module, related_entity_id
         FROM expenses
         WHERE supplier_id = ? AND related_module IN ('repair', 'order') AND status != 'CANCELLED'
         ORDER BY expense_date DESC`,
        [id]
      );
      return rows.map(r => ({
        id: r.id as string,
        expenseNumber: r.expense_number as string,
        description: r.description as string,
        amount: (r.amount as number) || 0,
        paidAmount: (r.paid_amount as number) || 0,
        expenseDate: r.expense_date as string,
        status: r.status as string,
        module: (r.related_module as string) || 'repair',
        linkId: (r.related_entity_id as string) || undefined,
      }));
    } catch { return []; }
  }, [id, purchases]);

  if (!supplier) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ height: '100vh', background: '#FFFFFF' }}>
        <p style={{ color: '#6B7280' }}>Supplier not found</p>
      </div>
    );
  }

  function handleSave() {
    if (!id) return;
    updateSupplier(id, {
      name: form.name,
      phone: form.phone,
      email: form.email,
      address: form.address,
      notes: form.notes,
      cpr: form.cpr,
      cprImage: form.cprImage,
      active: form.active,
    });
    setEditing(false);
  }

  function handleDelete() {
    if (!id) return;
    deleteSupplier(id);
    navigate('/suppliers');
  }

  return (
    <div className="app-content" style={{ background: '#FFFFFF' }}>
      <div style={{ padding: '32px 48px 64px', maxWidth: 1500 }}>
        {/* Header */}
        <div className="flex items-center justify-between" style={{ marginBottom: 32 }}>
          <button onClick={goBack}
            className="flex items-center gap-2 cursor-pointer transition-colors"
            style={{ background: 'none', border: 'none', color: '#6B7280', fontSize: 13 }}>
            <ArrowLeft size={16} /> Back
          </button>
          <div className="flex gap-2">
            {editing ? (
              <>
                <Button variant="ghost" onClick={() => { setEditing(false); setForm({ ...supplier }); }}>Cancel</Button>
                <Button variant="primary" onClick={handleSave}><Save size={14} /> Save</Button>
              </>
            ) : (
              <>
                <Button variant="ghost" onClick={() => setShowHistory(true)}>History</Button>
                <Button variant="secondary" onClick={() => setEditing(true)}><Edit3 size={14} /> Edit</Button>
              </>
            )}
          </div>
        </div>

        {/* Hero */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 32, marginBottom: 40 }}>
          <div className="rounded-xl flex items-center justify-center"
            style={{ height: 180, background: '#F2F7FA', border: '1px solid #E5E9EE' }}>
            <Building2 size={48} strokeWidth={0.8} style={{ color: '#6B7280' }} />
          </div>
          <div>
            <span className="text-overline">SUPPLIER</span>
            {editing ? (
              <Input required label="" value={form.name || ''} onChange={e => setForm({ ...form, name: e.target.value })} />
            ) : (
              <h1 className="font-display" style={{ fontSize: 28, color: '#0F0F10', marginTop: 4, lineHeight: 1.2 }}>{supplier.name}</h1>
            )}
            <div style={{ marginTop: 20 }}>
              {editing ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div>
                    <PhoneInput label="PHONE" value={form.phone || ''} onChange={v => setForm({ ...form, phone: v })} />
                    <SoftWarn warning={validatePhone(form.phone).warning} />
                  </div>
                  <Input label="EMAIL" value={form.email || ''} onChange={e => setForm({ ...form, email: e.target.value })} />
                  <Input label="ADDRESS" value={form.address || ''} onChange={e => setForm({ ...form, address: e.target.value })} />
                  <div>
                    <Input label="CPR / ID NUMBER" value={form.cpr || ''} onChange={e => setForm({ ...form, cpr: e.target.value })} />
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
                      style={{ marginTop: 6, background: 'transparent', borderBottom: '1px solid #D5D9DE', padding: '8px 0', fontSize: 14, color: '#0F0F10' }} />
                  </div>
                </div>
              ) : (
                <>
                  {supplier.phone && <div style={{ fontSize: 13, color: '#4B5563' }}>{supplier.phone}</div>}
                  {supplier.email && <div style={{ fontSize: 13, color: '#6B7280', marginTop: 4 }}>{supplier.email}</div>}
                  {supplier.address && <div style={{ fontSize: 13, color: '#6B7280', marginTop: 4 }}>{supplier.address}</div>}
                  {supplier.cpr && (
                    <div style={{ fontSize: 13, color: '#4B5563', marginTop: 8 }}>
                      <span style={{ color: '#9CA3AF', fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', marginRight: 6 }}>CPR</span>
                      <span className="font-mono">{supplier.cpr}</span>
                    </div>
                  )}
                  {supplier.cprImage && (
                    <div style={{ marginTop: 10 }}>
                      <img src={supplier.cprImage} alt="CPR / ID Card" style={{ maxWidth: 220, maxHeight: 140, border: '1px solid #E5E9EE', borderRadius: 6, objectFit: 'contain', background: '#F2F7FA' }} />
                    </div>
                  )}
                  {supplier.notes && <div style={{ fontSize: 13, color: '#4B5563', marginTop: 12, lineHeight: 1.5 }}>{supplier.notes}</div>}
                </>
              )}
            </div>
          </div>
        </div>

        {/* Ledger KPIs (Plan §Supplier §3 + §4 + §10 + §Purchase Returns §8) */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 32 }}>
          <KPICard label="TOTAL PURCHASES" value={fmt(ledger.totalPurchases)} unit="BHD" />
          <KPICard label="TOTAL PAID" value={fmt(ledger.totalPaid)} unit="BHD" />
          <KPICard label="OUTSTANDING" value={fmt(ledger.outstandingBalance)} unit={`BHD · ${supplierPurchases.filter(p => p.status !== 'PAID' && p.status !== 'CANCELLED').length + workshopExpenses.filter(e => e.status !== 'PAID' && e.status !== 'CANCELLED').length} open`} />
          <KPICard label="CREDIT BALANCE" value={fmt(ledger.creditBalance)} unit="BHD available" />
        </div>

        {/* Purchases List */}
        <Card>
          <div className="flex justify-between items-center" style={{ marginBottom: 12 }}>
            <span className="text-overline">PURCHASES ({supplierPurchases.length})</span>
          </div>
          {supplierPurchases.length === 0 ? (
            <p style={{ fontSize: 13, color: '#6B7280', padding: '20px 0' }}>No purchases yet.</p>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr 1fr', gap: 12, fontSize: 12 }}>
              <span className="text-overline">NUMBER</span>
              <span className="text-overline">DATE</span>
              <span className="text-overline" style={{ display: 'block', textAlign: 'right' }}>TOTAL</span>
              <span className="text-overline" style={{ display: 'block', textAlign: 'right' }}>PAID</span>
              <span className="text-overline" style={{ display: 'block', textAlign: 'right' }}>REMAINING</span>
              <span className="text-overline">STATUS</span>
              {supplierPurchases.map(p => (
                <div key={p.id} style={{ display: 'contents', cursor: 'pointer' }}
                  onClick={() => navigate(`/purchases/${p.id}`)}>
                  <span className="font-mono" style={{ fontSize: 12, color: '#0F0F10', padding: '8px 0', borderTop: '1px solid #E5E9EE' }}>{p.purchaseNumber}</span>
                  <span style={{ fontSize: 12, color: '#4B5563', padding: '8px 0', borderTop: '1px solid #E5E9EE' }}>{fmtDate(p.purchaseDate)}</span>
                  <span className="font-mono" style={{ fontSize: 12, color: '#0F0F10', textAlign: 'right', padding: '8px 0', borderTop: '1px solid #E5E9EE' }}><Bhd v={p.totalAmount}/></span>
                  <span className="font-mono" style={{ fontSize: 12, color: '#16A34A', textAlign: 'right', padding: '8px 0', borderTop: '1px solid #E5E9EE' }}><Bhd v={p.paidAmount}/></span>
                  <span className="font-mono" style={{ fontSize: 12, color: p.remainingAmount > 0 ? '#DC2626' : '#6B7280', textAlign: 'right', padding: '8px 0', borderTop: '1px solid #E5E9EE' }}><Bhd v={p.remainingAmount}/></span>
                  <span style={{ fontSize: 11, padding: '8px 0', borderTop: '1px solid #E5E9EE', color: '#4B5563' }}>{p.status}</span>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Workshop / Service Payables — Repair- UND Order-Kostenzeilen */}
        {workshopExpenses.length > 0 && (
          <div style={{ marginTop: 24 }}>
            <Card>
              <span className="text-overline" style={{ marginBottom: 12 }}>WORKSHOP &amp; SERVICE COSTS ({workshopExpenses.length})</span>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.8fr 0.8fr 1fr 1fr 1fr 1fr', gap: 12, fontSize: 12, marginTop: 12 }}>
                <span className="text-overline">EXPENSE #</span>
                <span className="text-overline">DESCRIPTION</span>
                <span className="text-overline">SOURCE</span>
                <span className="text-overline">DATE</span>
                <span className="text-overline" style={{ display: 'block', textAlign: 'right' }}>AMOUNT</span>
                <span className="text-overline" style={{ display: 'block', textAlign: 'right' }}>PAID</span>
                <span className="text-overline">STATUS</span>
                {workshopExpenses.map(e => {
                  const remaining = Math.max(0, e.amount - e.paidAmount);
                  const target = e.linkId ? (e.module === 'order' ? `/orders/${e.linkId}` : `/repairs/${e.linkId}`) : null;
                  return (
                    <div key={e.id} style={{ display: 'contents' }}
                      onClick={() => target && navigate(target)}
                    >
                      <span className="font-mono" style={{ fontSize: 12, color: '#3D7FFF', padding: '8px 0', borderTop: '1px solid #E5E9EE', cursor: target ? 'pointer' : 'default' }}>{e.expenseNumber}</span>
                      <span style={{ fontSize: 12, color: '#4B5563', padding: '8px 0', borderTop: '1px solid #E5E9EE', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.description}</span>
                      <span style={{ fontSize: 11, color: '#6B7280', padding: '8px 0', borderTop: '1px solid #E5E9EE', textTransform: 'capitalize' }}>{e.module}</span>
                      <span style={{ fontSize: 12, color: '#4B5563', padding: '8px 0', borderTop: '1px solid #E5E9EE' }}>{fmtDate(e.expenseDate)}</span>
                      <span className="font-mono" style={{ fontSize: 12, color: '#0F0F10', textAlign: 'right', padding: '8px 0', borderTop: '1px solid #E5E9EE' }}><Bhd v={e.amount}/></span>
                      <span className="font-mono" style={{ fontSize: 12, color: '#16A34A', textAlign: 'right', padding: '8px 0', borderTop: '1px solid #E5E9EE' }}><Bhd v={e.paidAmount}/></span>
                      <span style={{
                        fontSize: 11, padding: '8px 0', borderTop: '1px solid #E5E9EE',
                        color: e.status === 'PAID' ? '#16A34A' : remaining > 0 ? '#DC2626' : '#6B7280',
                        fontWeight: remaining > 0 ? 600 : 400,
                      }}>
                        {e.status === 'PAID' ? 'Paid' : remaining > 0 ? `${fmt(remaining)} pending` : e.status}
                      </span>
                    </div>
                  );
                })}
              </div>
            </Card>
          </div>
        )}

        {/* Gold-Owed (Plan repair-multi-supplier) — KPI-Karte + Liste der OPEN Gold-Payables.
            Bewusst SEPARAT von BHD-Money-Payables: Gold bleibt Gold, Geld bleibt Geld. */}
        {(goldOwedSummary.length > 0 || supplierGoldPayables.length > 0) && (
          <div style={{ marginTop: 24 }}>
            <Card>
              <div className="flex justify-between items-start" style={{ marginBottom: 14 }}>
                <span className="text-overline">GOLD OWED · BY KARAT</span>
                {goldOwedSummary.length > 0 && (
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                    {goldOwedSummary.map(s => (
                      <div key={s.karat} style={{
                        padding: '6px 12px', borderRadius: 6,
                        background: 'rgba(198,163,109,0.08)',
                        border: '1px solid rgba(198,163,109,0.3)',
                      }}>
                        <span className="font-mono" style={{ fontSize: 16, color: '#0F0F10' }}>
                          {s.totalGrams.toFixed(3)}g
                        </span>
                        <span style={{ fontSize: 11, color: '#8A7548', marginLeft: 6 }}>{s.karat}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {supplierGoldPayables.length === 0 ? (
                <p style={{ fontSize: 13, color: '#6B7280', padding: '20px 0' }}>No gold-payables.</p>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 0.9fr 0.8fr 1fr 1fr 1.4fr', gap: 12, fontSize: 12 }}>
                  <span className="text-overline">DATE</span>
                  <span className="text-overline">REPAIR</span>
                  <span className="text-overline">KARAT</span>
                  <span className="text-overline" style={{ textAlign: 'right' }}>WEIGHT (g)</span>
                  <span className="text-overline" style={{ textAlign: 'right' }}>SETTLED (g)</span>
                  <span className="text-overline">ACTIONS</span>
                  {supplierGoldPayables.map(gp => {
                    const remaining = Math.max(0, gp.weightGrams - gp.fulfilledGrams);
                    return (
                      <div key={gp.id} style={{ display: 'contents' }}>
                        <span style={{ fontSize: 12, color: '#4B5563', padding: '8px 0', borderTop: '1px solid #E5E9EE' }}>{fmtDate(gp.createdAt)}</span>
                        <span className="font-mono" style={{ fontSize: 11, color: '#3D7FFF', padding: '8px 0', borderTop: '1px solid #E5E9EE', cursor: gp.sourceRepairId ? 'pointer' : 'default' }}
                          onClick={() => gp.sourceRepairId && navigate(`/repairs/${gp.sourceRepairId}`)}>
                          {gp.sourceRepairId ? gp.sourceRepairId.slice(0, 8) : '—'}
                        </span>
                        <span style={{ fontSize: 12, color: '#4B5563', padding: '8px 0', borderTop: '1px solid #E5E9EE' }}>{gp.karat}</span>
                        <span className="font-mono" style={{ fontSize: 12, color: '#0F0F10', textAlign: 'right', padding: '8px 0', borderTop: '1px solid #E5E9EE' }}>{gp.weightGrams.toFixed(3)}</span>
                        <span className="font-mono" style={{ fontSize: 12, color: gp.status === 'FULFILLED' ? '#16A34A' : '#6B7280', textAlign: 'right', padding: '8px 0', borderTop: '1px solid #E5E9EE' }}>
                          {gp.fulfilledGrams.toFixed(3)}
                        </span>
                        <div style={{ padding: '6px 0', borderTop: '1px solid #E5E9EE', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {gp.status === 'OPEN' && remaining > 0 && (
                            <>
                              <button onClick={() => setSettleModal({ open: true, mode: 'settle_supplier_return', payable: gp })}
                                style={{ fontSize: 10, padding: '3px 8px', border: '1px solid #D5D9DE', borderRadius: 4, background: 'transparent', color: '#0F0F10', cursor: 'pointer' }}>
                                Return gold
                              </button>
                              <button onClick={() => setSettleModal({ open: true, mode: 'apply_shop_to_supplier', payable: gp })}
                                style={{ fontSize: 10, padding: '3px 8px', border: '1px solid #D5D9DE', borderRadius: 4, background: 'transparent', color: '#0F0F10', cursor: 'pointer' }}>
                                Apply shop gold
                              </button>
                              <button onClick={() => setSettleModal({ open: true, mode: 'convert_supplier_money', payable: gp })}
                                style={{ fontSize: 10, padding: '3px 8px', border: '1px solid #C6A36D', borderRadius: 4, background: 'rgba(198,163,109,0.08)', color: '#8A7548', cursor: 'pointer' }}>
                                → BHD
                              </button>
                            </>
                          )}
                          {gp.status !== 'OPEN' && (
                            <span style={{ fontSize: 10, color: '#6B7280' }}>{gp.status}</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
          </div>
        )}

        {/* Payments History */}
        <div style={{ marginTop: 24 }}>
          <Card>
            <span className="text-overline" style={{ marginBottom: 12 }}>PAYMENTS ({payments.length})</span>
            {payments.length === 0 ? (
              <p style={{ fontSize: 13, color: '#6B7280', padding: '20px 0' }}>No payments yet.</p>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr', gap: 12, fontSize: 12 }}>
                <span className="text-overline">PURCHASE</span>
                <span className="text-overline">DATE</span>
                <span className="text-overline" style={{ display: 'block', textAlign: 'right' }}>AMOUNT</span>
                <span className="text-overline">METHOD</span>
                <span className="text-overline">REFERENCE</span>
                {payments.map(p => (
                  <div key={p.id} style={{ display: 'contents' }}>
                    <span className="font-mono" style={{ fontSize: 12, color: '#0F0F10', padding: '8px 0', borderTop: '1px solid #E5E9EE' }}>{p.purchaseNumber}</span>
                    <span style={{ fontSize: 12, color: '#4B5563', padding: '8px 0', borderTop: '1px solid #E5E9EE' }}>{fmtDate(p.paidAt)}</span>
                    <span className="font-mono" style={{ fontSize: 12, color: '#16A34A', textAlign: 'right', padding: '8px 0', borderTop: '1px solid #E5E9EE' }}><Bhd v={p.amount}/></span>
                    <span style={{ fontSize: 11, padding: '8px 0', borderTop: '1px solid #E5E9EE', color: '#4B5563' }}>{p.method}</span>
                    <span style={{ fontSize: 11, padding: '8px 0', borderTop: '1px solid #E5E9EE', color: '#6B7280' }}>{p.reference || '\u2014'}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        {/* Returns (PRET) */}
        <div style={{ marginTop: 24 }}>
          <Card>
            <span className="text-overline" style={{ marginBottom: 12 }}>PURCHASE RETURNS ({returns.length})</span>
            {returns.length === 0 ? (
              <p style={{ fontSize: 13, color: '#6B7280', padding: '20px 0' }}>No returns yet.</p>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr', gap: 12, fontSize: 12 }}>
                <span className="text-overline">NUMBER</span>
                <span className="text-overline">DATE</span>
                <span className="text-overline" style={{ display: 'block', textAlign: 'right' }}>AMOUNT</span>
                <span className="text-overline">REFUND METHOD</span>
                <span className="text-overline">STATUS</span>
                {returns.map(r => (
                  <div key={r.id} style={{ display: 'contents' }}>
                    <span className="font-mono" style={{ fontSize: 12, color: '#0F0F10', padding: '8px 0', borderTop: '1px solid #E5E9EE' }}>{r.returnNumber}</span>
                    <span style={{ fontSize: 12, color: '#4B5563', padding: '8px 0', borderTop: '1px solid #E5E9EE' }}>{fmtDate(r.returnDate)}</span>
                    <span className="font-mono" style={{ fontSize: 12, color: '#DC2626', textAlign: 'right', padding: '8px 0', borderTop: '1px solid #E5E9EE' }}><Bhd v={r.totalAmount}/></span>
                    <span style={{ fontSize: 11, padding: '8px 0', borderTop: '1px solid #E5E9EE', color: '#4B5563' }}>{r.refundMethod || '\u2014'}</span>
                    <span style={{ fontSize: 11, padding: '8px 0', borderTop: '1px solid #E5E9EE', color: '#4B5563' }}>{r.status}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        {/* Danger zone */}
        {editing && (
          <div style={{ marginTop: 24 }}>
            <Button variant="danger" onClick={() => setConfirmDelete(true)}>
              <Trash2 size={14} /> Delete Supplier
            </Button>
          </div>
        )}
      </div>

      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete Supplier" width={400}>
        <p style={{ fontSize: 14, color: '#4B5563', marginBottom: 20 }}>
          Delete supplier <strong style={{ color: '#0F0F10' }}>{supplier.name}</strong>? Purchases remain but supplier link is lost.
        </p>
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button>
          <Button variant="danger" onClick={handleDelete}>Delete</Button>
        </div>
      </Modal>

      <HistoryDrawer
        open={showHistory}
        onClose={() => setShowHistory(false)}
        entityType="suppliers"
        entityId={supplier.id}
        title={`History · ${supplier.name}`}
      />

      <SettleGoldModal
        open={settleModal.open}
        mode={settleModal.mode}
        payable={settleModal.payable}
        onClose={() => setSettleModal({ open: false, mode: 'settle_supplier_return' })}
      />
    </div>
  );
}
