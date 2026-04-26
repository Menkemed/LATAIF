// Plan §Supplier §8: Detail-View mit Ledger + Purchase/Payment/Return-Historie
import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Building2, Edit3, Save, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { KPICard } from '@/components/ui/KPICard';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { HistoryDrawer } from '@/components/shared/HistoryPanel';
import { useSupplierStore } from '@/stores/supplierStore';
import { usePurchaseStore } from '@/stores/purchaseStore';
import { query } from '@/core/db/helpers';
import type { Supplier } from '@/core/models/types';

function fmt(v: number): string {
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function fmtDate(iso?: string): string {
  if (!iso) return '\u2014';
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function SupplierDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { suppliers, loadSuppliers, updateSupplier, deleteSupplier, getLedger } = useSupplierStore();
  const { purchases, loadPurchases } = usePurchaseStore();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Partial<Supplier>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => { loadSuppliers(); loadPurchases(); }, [loadSuppliers, loadPurchases]);

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
      <div style={{ padding: '32px 48px 64px', maxWidth: 1200 }}>
        {/* Header */}
        <div className="flex items-center justify-between" style={{ marginBottom: 32 }}>
          <button onClick={() => navigate('/suppliers')}
            className="flex items-center gap-2 cursor-pointer transition-colors"
            style={{ background: 'none', border: 'none', color: '#6B7280', fontSize: 13 }}>
            <ArrowLeft size={16} /> Suppliers
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
              <Input label="" value={form.name || ''} onChange={e => setForm({ ...form, name: e.target.value })} />
            ) : (
              <h1 className="font-display" style={{ fontSize: 28, color: '#0F0F10', marginTop: 4, lineHeight: 1.2 }}>{supplier.name}</h1>
            )}
            <div style={{ marginTop: 20 }}>
              {editing ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <Input label="PHONE" value={form.phone || ''} onChange={e => setForm({ ...form, phone: e.target.value })} />
                  <Input label="EMAIL" value={form.email || ''} onChange={e => setForm({ ...form, email: e.target.value })} />
                  <Input label="ADDRESS" value={form.address || ''} onChange={e => setForm({ ...form, address: e.target.value })} />
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
          <KPICard label="OUTSTANDING" value={fmt(ledger.outstandingBalance)} unit={`BHD · ${supplierPurchases.filter(p => p.status !== 'PAID' && p.status !== 'CANCELLED').length} open`} />
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
              <span className="text-overline" style={{ textAlign: 'right' }}>TOTAL</span>
              <span className="text-overline" style={{ textAlign: 'right' }}>PAID</span>
              <span className="text-overline" style={{ textAlign: 'right' }}>REMAINING</span>
              <span className="text-overline">STATUS</span>
              {supplierPurchases.map(p => (
                <div key={p.id} style={{ display: 'contents', cursor: 'pointer' }}
                  onClick={() => navigate(`/purchases/${p.id}`)}>
                  <span className="font-mono" style={{ fontSize: 12, color: '#0F0F10', padding: '8px 0', borderTop: '1px solid #E5E9EE' }}>{p.purchaseNumber}</span>
                  <span style={{ fontSize: 12, color: '#4B5563', padding: '8px 0', borderTop: '1px solid #E5E9EE' }}>{fmtDate(p.purchaseDate)}</span>
                  <span className="font-mono" style={{ fontSize: 12, color: '#0F0F10', textAlign: 'right', padding: '8px 0', borderTop: '1px solid #E5E9EE' }}>{fmt(p.totalAmount)}</span>
                  <span className="font-mono" style={{ fontSize: 12, color: '#16A34A', textAlign: 'right', padding: '8px 0', borderTop: '1px solid #E5E9EE' }}>{fmt(p.paidAmount)}</span>
                  <span className="font-mono" style={{ fontSize: 12, color: p.remainingAmount > 0 ? '#DC2626' : '#6B7280', textAlign: 'right', padding: '8px 0', borderTop: '1px solid #E5E9EE' }}>{fmt(p.remainingAmount)}</span>
                  <span style={{ fontSize: 11, padding: '8px 0', borderTop: '1px solid #E5E9EE', color: '#4B5563' }}>{p.status}</span>
                </div>
              ))}
            </div>
          )}
        </Card>

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
                <span className="text-overline" style={{ textAlign: 'right' }}>AMOUNT</span>
                <span className="text-overline">METHOD</span>
                <span className="text-overline">REFERENCE</span>
                {payments.map(p => (
                  <div key={p.id} style={{ display: 'contents' }}>
                    <span className="font-mono" style={{ fontSize: 12, color: '#0F0F10', padding: '8px 0', borderTop: '1px solid #E5E9EE' }}>{p.purchaseNumber}</span>
                    <span style={{ fontSize: 12, color: '#4B5563', padding: '8px 0', borderTop: '1px solid #E5E9EE' }}>{fmtDate(p.paidAt)}</span>
                    <span className="font-mono" style={{ fontSize: 12, color: '#16A34A', textAlign: 'right', padding: '8px 0', borderTop: '1px solid #E5E9EE' }}>{fmt(p.amount)}</span>
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
                <span className="text-overline" style={{ textAlign: 'right' }}>AMOUNT</span>
                <span className="text-overline">REFUND METHOD</span>
                <span className="text-overline">STATUS</span>
                {returns.map(r => (
                  <div key={r.id} style={{ display: 'contents' }}>
                    <span className="font-mono" style={{ fontSize: 12, color: '#0F0F10', padding: '8px 0', borderTop: '1px solid #E5E9EE' }}>{r.returnNumber}</span>
                    <span style={{ fontSize: 12, color: '#4B5563', padding: '8px 0', borderTop: '1px solid #E5E9EE' }}>{fmtDate(r.returnDate)}</span>
                    <span className="font-mono" style={{ fontSize: 12, color: '#DC2626', textAlign: 'right', padding: '8px 0', borderTop: '1px solid #E5E9EE' }}>{fmt(r.totalAmount)}</span>
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
    </div>
  );
}
