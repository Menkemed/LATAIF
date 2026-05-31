// Consignor-Detail-Page (2026-05-18) — Approval-Style Mirror von AgentDetail.tsx
// fuer Konsignware. Zeigt pro Customer eine Header-Section, KPI-Strip und die
// gefilterte Liste seiner Consignments. So sieht der User auf einen Blick was
// dieser Kunde alles bei uns konsigniert hat.
import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Edit3, History as HistoryIcon, Mail, Phone, FileText, Truck, Printer } from 'lucide-react';
import { useGoBack } from '@/hooks/useGoBack';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { StatusDot } from '@/components/ui/StatusDot';
import { Bhd } from '@/components/ui/Bhd';
import { HistoryDrawer } from '@/components/shared/HistoryPanel';
import { PrintItemsFilterModal } from '@/components/print/PrintItemsFilterModal';
import { runConsignmentPrint } from '@/core/pdf/consignment-print-helpers';
import type { ItemListFilter } from '@/core/pdf/itemListPdf';
import { useConsignmentStore } from '@/stores/consignmentStore';
import { useCustomerStore } from '@/stores/customerStore';
import { useProductStore } from '@/stores/productStore';
import { useSupplierStore } from '@/stores/supplierStore';
import { commissionModelLabel } from '@/core/consignment/economics';

export function ConsignorDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const goBack = useGoBack('/consignments');
  const { consignments, loadConsignments, markReturned } = useConsignmentStore();
  const { customers, loadCustomers } = useCustomerStore();
  const { products, categories, loadProducts, loadCategories } = useProductStore();
  const { suppliers, loadSuppliers } = useSupplierStore();
  const [showHistory, setShowHistory] = useState(false);
  const [showPrint, setShowPrint] = useState(false);

  useEffect(() => {
    loadConsignments(); loadCustomers(); loadProducts(); loadCategories(); loadSuppliers();
  }, [loadConsignments, loadCustomers, loadProducts, loadCategories, loadSuppliers]);

  const customer = useMemo(() => customers.find(c => c.id === id), [customers, id]);
  const myConsignments = useMemo(
    () => consignments.filter(c => c.consignorId === id),
    [consignments, id]
  );

  // Linked-Supplier-Mirror: Beim ersten recordSale wird ein Supplier mit dem
  // Phone des Consignors angelegt (findOrCreateSupplierForConsignor). Wenn der
  // Customer ein Telefon hat und ein gleichnamiger Supplier existiert, zeige
  // einen Quick-Link "View as Supplier" damit der User die Auszahlungs-Sicht hat.
  const linkedSupplier = useMemo(() => {
    if (!customer) return undefined;
    const norm = (s?: string) => (s || '').replace(/\s+/g, '').toLowerCase();
    const phoneA = norm(customer.phone);
    if (phoneA) {
      const byPhone = suppliers.find(s => norm(s.phone) === phoneA);
      if (byPhone) return byPhone;
    }
    const fullName = `${customer.firstName} ${customer.lastName}`.trim().toLowerCase();
    return suppliers.find(s => (s.name || '').trim().toLowerCase() === fullName);
  }, [customer, suppliers]);

  const stats = useMemo(() => {
    const active = myConsignments.filter(c => c.status === 'active');
    const sold = myConsignments.filter(c => c.status === 'sold');
    const itemsHeld = active.length;
    const totalAgreed = active.reduce((s, c) => s + (c.agreedPrice || 0), 0);
    const totalSold = sold.reduce((s, c) => s + ((c.salePrice ?? c.agreedPrice) || 0), 0);
    const totalPaidOut = sold
      .filter(c => c.payoutStatus === 'paid')
      .reduce((s, c) => s + (c.payoutAmount || 0), 0);
    const outstandingPayout = sold
      .filter(c => c.payoutStatus !== 'paid')
      .reduce((s, c) => s + (c.payoutAmount || 0), 0);
    const isActive = itemsHeld > 0;
    return { itemsHeld, totalAgreed, totalSold, totalPaidOut, outstandingPayout, isActive };
  }, [myConsignments]);

  if (!customer) {
    return (
      <div className="app-content flex items-center justify-center" style={{ background: '#FFFFFF', minHeight: '100vh' }}>
        <div style={{ textAlign: 'center' }}>
          <p style={{ color: '#6B7280', marginBottom: 12 }}>Consignor not found.</p>
          <Button variant="ghost" onClick={() => goBack()}>← Back</Button>
        </div>
      </div>
    );
  }

  const fullName = `${customer.firstName} ${customer.lastName}`.trim() || '(unnamed)';

  return (
    <div className="app-content" style={{ background: '#FFFFFF' }}>
      <div style={{ padding: '32px 48px 64px', maxWidth: 1500 }}>
        {/* Back */}
        <button onClick={() => goBack()}
          className="flex items-center gap-2 cursor-pointer transition-colors"
          style={{ background: 'none', border: 'none', color: '#6B7280', fontSize: 13, marginBottom: 12 }}>
          <ArrowLeft size={16} /> Back
        </button>

        {/* Header */}
        <div className="flex items-start justify-between" style={{ marginBottom: 28 }}>
          <div>
            <div className="flex items-center gap-3" style={{ marginBottom: 6 }}>
              <h1 className="font-display" style={{ fontSize: 28, color: '#0F0F10' }}>{fullName}</h1>
              <span style={{
                fontSize: 11, padding: '4px 12px', borderRadius: 999,
                background: stats.isActive ? 'rgba(126,170,110,0.10)' : 'rgba(107,114,128,0.10)',
                color: stats.isActive ? '#5C8550' : '#6B7280',
                border: `1px solid ${stats.isActive ? 'rgba(126,170,110,0.4)' : 'rgba(107,114,128,0.3)'}`,
              }}>
                {stats.isActive ? 'Active' : 'Inactive'}
              </span>
              <span style={{ fontSize: 11, color: '#9CA3AF', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                Consignor
              </span>
            </div>
            <div className="flex items-center gap-4" style={{ fontSize: 13, color: '#6B7280' }}>
              {customer.company && <span>{customer.company}</span>}
              {customer.phone && <span className="flex items-center gap-1"><Phone size={12} />{customer.phone}</span>}
              {customer.email && <span className="flex items-center gap-1"><Mail size={12} />{customer.email}</span>}
            </div>
            {linkedSupplier && (
              <button
                onClick={() => navigate(`/suppliers/${linkedSupplier.id}`)}
                className="cursor-pointer flex items-center gap-1"
                style={{ marginTop: 6, background: 'none', border: 'none', color: '#715DE3', fontSize: 12, padding: 0 }}
                title="Open supplier-mirror used for payout purchases"
              >
                <Truck size={12} /> Linked supplier: {linkedSupplier.name} →
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setShowPrint(true)}>
              <Printer size={14} /> Print Items
            </Button>
            <Button variant="ghost" onClick={() => setShowHistory(true)}>
              <HistoryIcon size={14} /> History
            </Button>
            <Button variant="secondary" onClick={() => navigate(`/clients/${customer.id}`)}>
              <Edit3 size={14} /> Open Client
            </Button>
          </div>
        </div>

        {/* KPI Strip */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 28 }}>
          <Card>
            <div style={{ fontSize: 10, color: '#6B7280', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 6 }}>Items Held</div>
            <div className="font-display" style={{ fontSize: 24, color: '#0F0F10' }}>{stats.itemsHeld}</div>
            <div style={{ fontSize: 11, color: '#6B7280', marginTop: 4 }}>currently active consignments</div>
          </Card>
          <Card>
            <div style={{ fontSize: 10, color: '#6B7280', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 6 }}>Agreed Value</div>
            <div className="font-display" style={{ fontSize: 24, color: '#0F0F10' }}>
              <Bhd v={stats.totalAgreed}/> <span style={{ fontSize: 13, color: '#6B7280' }}>BHD</span>
            </div>
          </Card>
          <Card>
            <div style={{ fontSize: 10, color: '#6B7280', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 6 }}>Sold Value</div>
            <div className="font-display" style={{ fontSize: 24, color: '#0F0F10' }}>
              <Bhd v={stats.totalSold}/> <span style={{ fontSize: 13, color: '#6B7280' }}>BHD</span>
            </div>
            <div style={{ fontSize: 11, color: '#6B7280', marginTop: 4 }}>
              paid out: <Bhd v={stats.totalPaidOut}/> BHD
            </div>
          </Card>
          <Card>
            <div style={{ fontSize: 10, color: '#6B7280', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 6 }}>Outstanding Payout</div>
            <div className="font-display" style={{ fontSize: 24, color: stats.outstandingPayout > 0 ? '#AA6E6E' : '#6B7280' }}>
              <Bhd v={stats.outstandingPayout}/> <span style={{ fontSize: 13, color: '#6B7280' }}>BHD</span>
            </div>
          </Card>
        </div>

        {/* Items */}
        <div style={{ marginBottom: 16 }}>
          <h2 className="font-display" style={{ fontSize: 18, color: '#0F0F10', marginBottom: 12 }}>Consignments</h2>
          {myConsignments.length === 0 ? (
            <Card>
              <div style={{ padding: '40px 0', textAlign: 'center' }}>
                <FileText size={32} strokeWidth={1} style={{ color: '#9CA3AF', margin: '0 auto 12px' }} />
                <p style={{ fontSize: 13, color: '#6B7280' }}>No consignments yet from this client.</p>
              </div>
            </Card>
          ) : (
            <Card noPadding>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #E5E9EE' }}>
                    {['Number', 'Product', 'Agreed Price', 'Sale / Payout', 'Status', 'Actions'].map(h => (
                      <th key={h} style={{
                        padding: '12px 16px', textAlign: 'left', fontSize: 11,
                        fontWeight: 500, letterSpacing: '0.06em', color: '#6B7280',
                        textTransform: 'uppercase',
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {myConsignments
                    .slice()
                    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
                    .map(con => {
                      const prod = products.find(p => p.id === con.productId);
                      const prodLabel = prod ? `${prod.brand} ${prod.name}` : '—';
                      const saleValue = con.salePrice ?? null;
                      const payoutValue = con.payoutAmount ?? null;
                      return (
                        <tr key={con.id}
                          className="cursor-pointer transition-colors duration-200"
                          style={{ borderBottom: '1px solid #E5E9EE' }}
                          onClick={() => navigate(`/consignments/${con.id}`)}
                          onMouseEnter={e => (e.currentTarget.style.background = '#F8FAFB')}
                          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                        >
                          <td style={{ padding: '12px 16px' }}>
                            <span className="font-mono" style={{ fontSize: 12, color: '#0F0F10' }}>{con.consignmentNumber}</span>
                          </td>
                          <td style={{ padding: '12px 16px' }}>
                            <div>
                              <span style={{ fontSize: 13, color: '#0F0F10' }}>{prodLabel}</span>
                              {prod?.sku && (
                                <span className="font-mono" style={{ fontSize: 11, color: '#6B7280', display: 'block', marginTop: 2 }}>{prod.sku}</span>
                              )}
                            </div>
                          </td>
                          <td style={{ padding: '12px 16px' }}>
                            <span className="font-mono" style={{ fontSize: 13, color: '#0F0F10' }}><Bhd v={con.agreedPrice}/></span>
                            <span style={{ fontSize: 10, color: '#6B7280', marginLeft: 4 }}>BHD</span>
                            {/* v0.7.21 — Modell-Label statt nur Rate; cost_split = "Cost + N% split". */}
                            <span style={{ fontSize: 10, color: '#6B7280', display: 'block', marginTop: 2 }}>
                              {commissionModelLabel(con)}
                            </span>
                          </td>
                          <td style={{ padding: '12px 16px' }}>
                            {saleValue != null ? (
                              <>
                                <span className="font-mono" style={{ fontSize: 13, color: '#0F0F10' }}>
                                  <Bhd v={saleValue}/> BHD
                                </span>
                                {payoutValue != null && (
                                  <span style={{ fontSize: 10, color: '#6B7280', display: 'block', marginTop: 2 }}>
                                    payout: <Bhd v={payoutValue}/> ({con.payoutStatus})
                                  </span>
                                )}
                              </>
                            ) : (
                              <span style={{ fontSize: 12, color: '#9CA3AF' }}>—</span>
                            )}
                          </td>
                          <td style={{ padding: '12px 16px' }}>
                            <StatusDot status={con.status} />
                          </td>
                          <td style={{ padding: '12px 16px' }} onClick={e => e.stopPropagation()}>
                            <div className="flex gap-1">
                              {con.status === 'active' && (
                                <button
                                  onClick={() => markReturned(con.id)}
                                  className="cursor-pointer transition-all duration-200"
                                  style={{
                                    padding: '4px 10px', fontSize: 11, borderRadius: 6,
                                    border: '1px solid #D5D9DE', color: '#6B7280',
                                    background: 'transparent',
                                  }}
                                >Return</button>
                              )}
                              {con.status === 'sold' && con.invoiceId && (
                                <button
                                  onClick={() => navigate(`/invoices/${con.invoiceId}`)}
                                  title="Open buyer invoice"
                                  className="cursor-pointer flex items-center gap-1"
                                  style={{
                                    padding: '4px 10px', fontSize: 11, borderRadius: 4,
                                    border: '1px solid #715DE3', color: '#FFFFFF',
                                    background: '#715DE3', fontWeight: 500,
                                  }}>
                                  <FileText size={11} /> Invoice
                                </button>
                              )}
                              <button
                                onClick={() => navigate(`/consignments/${con.id}`)}
                                className="cursor-pointer"
                                style={{
                                  padding: '4px 10px', fontSize: 11, borderRadius: 6,
                                  border: '1px solid #D5D9DE', color: '#0F0F10',
                                  background: 'transparent',
                                }}
                              >Open</button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </Card>
          )}
        </div>

        {/* Notes (vom Customer) */}
        {customer.notes && (
          <Card>
            <span className="text-overline" style={{ marginBottom: 8, display: 'block' }}>NOTES</span>
            <p style={{ fontSize: 13, color: '#4B5563', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{customer.notes}</p>
          </Card>
        )}
      </div>

      <HistoryDrawer
        open={showHistory}
        onClose={() => setShowHistory(false)}
        entityType="customers"
        entityId={customer.id}
        title={`History · ${fullName}`}
      />

      <PrintItemsFilterModal
        open={showPrint}
        onClose={() => setShowPrint(false)}
        kind="consignment"
        scope="single"
        contextLabel={fullName}
        onConfirm={(filter: ItemListFilter) => {
          runConsignmentPrint({
            filter,
            scope: 'single',
            consignors: [customer],
            consignments: myConsignments,
            products,
            categories,
          });
        }}
      />
    </div>
  );
}
