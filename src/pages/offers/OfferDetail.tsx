import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Edit3, Save, Trash2, Plus, X, FileText, Download, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { StatusDot } from '@/components/ui/StatusDot';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { MessagePreviewModal } from '@/components/ai/MessagePreviewModal';
import { useOfferStore } from '@/stores/offerStore';
import { useCustomerStore } from '@/stores/customerStore';
import { useProductStore } from '@/stores/productStore';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { downloadPdf } from '@/core/pdf/pdf-generator';
import { formatProductMultiLine, getProductSpecs } from '@/core/utils/product-format';
import { usePermission } from '@/hooks/usePermission';
import { HistoryDrawer } from '@/components/shared/HistoryPanel';
import { ConfirmTaxSchemeModal } from '@/components/shared/ConfirmTaxSchemeModal';
import type { TaxScheme } from '@/core/models/types';

function fmt(v: number): string {
  return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export function OfferDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { offers, loadOffers, updateOffer, updateOfferLine, addOfferLine, removeOfferLine, deleteOffer } = useOfferStore();
  const { customers, loadCustomers } = useCustomerStore();
  const { products, loadProducts, categories, loadCategories } = useProductStore();
  const { createInvoiceFromOffer } = useInvoiceStore();

  const [editing, setEditing] = useState(false);
  const [formNotes, setFormNotes] = useState('');
  const [showVatConfirm, setShowVatConfirm] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [formValidUntil, setFormValidUntil] = useState('');
  const [formCustomerId, setFormCustomerId] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showAddLine, setShowAddLine] = useState(false);
  const [customerSearch, setCustomerSearch] = useState('');
  const [showFollowUp, setShowFollowUp] = useState(false);
  const perm = usePermission();

  useEffect(() => { loadOffers(); loadCustomers(); loadProducts(); loadCategories(); }, [loadOffers, loadCustomers, loadProducts, loadCategories]);

  const offer = useMemo(() => offers.find(o => o.id === id), [offers, id]);
  const customer = useMemo(() => offer ? customers.find(c => c.id === offer.customerId) : null, [offer, customers]);

  useEffect(() => {
    if (offer) {
      setFormNotes(offer.notes || '');
      setFormValidUntil(offer.validUntil || '');
      setFormCustomerId(offer.customerId);
    }
  }, [offer]);

  const filteredCustomers = useMemo(() => {
    if (!customerSearch) return customers.slice(0, 10);
    const q = customerSearch.toLowerCase();
    return customers.filter(c => `${c.firstName} ${c.lastName} ${c.company || ''}`.toLowerCase().includes(q));
  }, [customers, customerSearch]);

  const availableProducts = useMemo(() => {
    if (!offer) return [];
    const usedIds = new Set(offer.lines.map(l => l.productId));
    return products.filter(p => p.stockStatus === 'in_stock' && !usedIds.has(p.id));
  }, [products, offer]);

  if (!offer) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ height: '100vh', background: '#FFFFFF' }}>
        <p style={{ color: '#6B7280' }}>Offer not found</p>
      </div>
    );
  }

  const canEdit = offer.status === 'draft';
  const canDelete = offer.status === 'draft' || offer.status === 'rejected';
  const canCreateInvoice = offer.status === 'accepted';

  function handleSave() {
    if (!id) return;
    updateOffer(id, {
      notes: formNotes || undefined,
      validUntil: formValidUntil || undefined,
      customerId: formCustomerId,
    });
    setEditing(false);
  }

  function handleDelete() {
    if (!id) return;
    deleteOffer(id);
    navigate('/offers');
  }

  function handleSend() {
    if (!id) return;
    updateOffer(id, { status: 'sent', sentAt: new Date().toISOString() });
  }

  function handleAccept() {
    if (!id) return;
    updateOffer(id, { status: 'accepted' });
  }

  function handleReject() {
    if (!id) return;
    updateOffer(id, { status: 'rejected' });
  }

  function handleCreateInvoice() {
    if (!id) return;
    setShowVatConfirm(true);
  }

  function handleConfirmCreateInvoice(perLine: Record<string, TaxScheme>) {
    setShowVatConfirm(false);
    if (!id) return;
    const invoice = createInvoiceFromOffer(id, perLine);
    if (invoice) {
      navigate(`/invoices/${invoice.id}`);
    }
  }

  function handleDownloadPdf() {
    if (!offer) return;
    const lines = offer.lines.map(l => {
      const p = products.find(pr => pr.id === l.productId);
      // Plan §Print — volle Specs
      const desc = formatProductMultiLine(p, categories);
      return { label: desc || 'Product', value: `${fmt(l.lineTotal)} BHD` };
    });
    downloadPdf({
      title: offer.offerNumber,
      number: offer.offerNumber,
      date: offer.createdAt?.split('T')[0] || '',
      subtitle: offer.validUntil ? `Valid until ${offer.validUntil}` : undefined,
      customer: customer ? { name: `${customer.firstName} ${customer.lastName}`, company: customer.company, phone: customer.phone } : undefined,
      type: 'offer',
      sections: [
        { title: 'Items', lines },
        { title: 'Summary', lines: [
          { label: 'Total', value: `${fmt(offer.total)} BHD`, bold: true },
        ]},
      ],
      footer: 'Thank you for your interest. This offer is subject to availability.',
    });
  }

  function handleAddLine(product: typeof products[0]) {
    if (!id) return;
    addOfferLine(id, {
      productId: product.id,
      unitPrice: product.plannedSalePrice || product.purchasePrice,
      taxScheme: product.taxScheme,
      purchasePrice: product.purchasePrice,
    });
    setShowAddLine(false);
  }

  function handleRemoveLine(lineId: string) {
    if (!id) return;
    removeOfferLine(id, lineId);
  }

  function renderField(label: string, value: React.ReactNode, editField?: React.ReactNode) {
    return (
      <div className="flex justify-between items-center" style={{ padding: '10px 0', borderBottom: '1px solid #E5E1D6' }}>
        <span style={{ fontSize: 13, color: '#6B7280' }}>{label}</span>
        {editing && editField ? editField : <span style={{ fontSize: 13, color: '#0F0F10' }}>{value || '\u2014'}</span>}
      </div>
    );
  }

  return (
    <div className="app-content" style={{ background: '#FFFFFF' }}>
      <div style={{ padding: '32px 48px 64px', maxWidth: 1200 }}>

        {/* Header */}
        <div className="flex items-center justify-between" style={{ marginBottom: 32 }}>
          <button onClick={() => navigate('/offers')}
            className="flex items-center gap-2 cursor-pointer transition-colors"
            style={{ background: 'none', border: 'none', color: '#6B7280', fontSize: 13 }}
            onMouseEnter={e => (e.currentTarget.style.color = '#0F0F10')}
            onMouseLeave={e => (e.currentTarget.style.color = '#6B7280')}
          >
            <ArrowLeft size={16} /> Offers
          </button>
          <div className="flex gap-2">
            {editing ? (
              <>
                <Button variant="ghost" onClick={() => { setEditing(false); setFormNotes(offer.notes || ''); setFormValidUntil(offer.validUntil || ''); setFormCustomerId(offer.customerId); }}>Cancel</Button>
                <Button variant="primary" onClick={handleSave}><Save size={14} /> Save</Button>
              </>
            ) : (
              <>
                <Button variant="secondary" onClick={handleDownloadPdf}><Download size={14} /> PDF</Button>
                <Button variant="ghost" onClick={() => setShowHistory(true)}>History</Button>
                {canEdit && perm.canEditOffers && <Button variant="secondary" onClick={() => setEditing(true)}><Edit3 size={14} /> Edit</Button>}
                {offer.status === 'draft' && perm.canEditOffers && <Button variant="primary" onClick={handleSend}>Send Offer</Button>}
                {(offer.status === 'draft' || offer.status === 'sent') && customer?.whatsapp && (
                  <Button variant="ghost" onClick={() => {
                    const num = (customer.whatsapp || customer.phone || '').replace(/[^0-9+]/g, '').replace(/^\+/, '');
                    const items = offer.lines.map(l => { const p = products.find(pr => pr.id === l.productId); return p ? `${p.brand} ${p.name}: ${fmt(l.lineTotal)} BHD` : ''; }).filter(Boolean).join('%0A');
                    const text = `Hi ${customer.firstName},%0A%0AHere is your offer ${offer.offerNumber}:%0A${items}%0A%0ATotal: ${fmt(offer.total)} BHD%0A%0APlease let us know if you are interested.`;
                    window.open(`https://wa.me/${num}?text=${text}`, '_blank');
                  }}>WhatsApp</Button>
                )}
                {offer.status === 'sent' && customer && (customer.whatsapp || customer.phone) && (
                  <Button variant="secondary" onClick={() => setShowFollowUp(true)}>
                    <Sparkles size={14} /> AI Follow-Up
                  </Button>
                )}
                {offer.status === 'sent' && perm.canEditOffers && (
                  <>
                    <Button variant="primary" onClick={handleAccept}>Accept</Button>
                    <Button variant="danger" onClick={handleReject}>Reject</Button>
                  </>
                )}
                {canCreateInvoice && (
                  <Button variant="primary" onClick={handleCreateInvoice}><FileText size={14} /> Create Invoice</Button>
                )}
                {canDelete && perm.canDeleteOffers && (
                  <Button variant="danger" onClick={() => setConfirmDelete(true)}><Trash2 size={14} /> Delete</Button>
                )}
              </>
            )}
          </div>
        </div>

        {/* Hero */}
        <div className="animate-fade-in" style={{ marginBottom: 40 }}>
          <span className="text-overline">{offer.offerNumber}</span>
          <h1 className="font-display" style={{ fontSize: 32, color: '#0F0F10', marginTop: 4, lineHeight: 1.2 }}>
            {customer ? `${customer.firstName} ${customer.lastName}` : 'Unknown Client'}
          </h1>
          {customer?.company && (
            <span style={{ fontSize: 13, color: '#4B5563', display: 'block', marginTop: 4 }}>{customer.company}</span>
          )}
          <div className="flex items-center gap-4" style={{ marginTop: 12 }}>
            <StatusDot status={offer.status} />
            <span className="font-display" style={{ fontSize: 24, color: '#0F0F10' }}>{fmt(offer.total)} BHD</span>
          </div>
        </div>

        {/* Content Grid */}
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 24 }}>

          {/* Lines */}
          <Card>
            <div className="flex justify-between items-center" style={{ marginBottom: 16 }}>
              <span className="text-overline">LINE ITEMS</span>
              {canEdit && !editing && (
                <button onClick={() => setShowAddLine(true)}
                  className="flex items-center gap-1 cursor-pointer transition-colors"
                  style={{ background: 'none', border: 'none', color: '#0F0F10', fontSize: 12 }}
                  onMouseEnter={e => (e.currentTarget.style.opacity = '0.7')}
                  onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
                >
                  <Plus size={14} /> Add Item
                </button>
              )}
            </div>

            {/* Line header */}
            <div style={{ display: 'grid', gridTemplateColumns: canEdit ? '3fr 1fr 1fr 32px' : '3fr 1fr 1fr', gap: 12, padding: '8px 0', borderBottom: '1px solid #E5E1D6' }}>
              <span style={{ fontSize: 11, color: '#6B7280' }}>PRODUCT</span>
              <span style={{ fontSize: 11, color: '#6B7280', textAlign: 'right' }}>UNIT PRICE</span>
              <span style={{ fontSize: 11, color: '#6B7280', textAlign: 'right' }}>TOTAL</span>
              {canEdit && <span />}
            </div>

            {offer.lines.length === 0 && (
              <div style={{ padding: '32px 0', textAlign: 'center' }}>
                <p style={{ fontSize: 13, color: '#6B7280' }}>No items added yet.</p>
              </div>
            )}

            {offer.lines.map(line => {
              const product = products.find(p => p.id === line.productId);
              const outOfRange = product && (
                (product.minSalePrice && line.unitPrice < product.minSalePrice) ||
                (product.maxSalePrice && line.unitPrice > product.maxSalePrice)
              );
              return (
                <div key={line.id} style={{ display: 'grid', gridTemplateColumns: canEdit ? '3fr 1fr 1fr 32px' : '3fr 1fr 1fr', gap: 12, padding: '12px 0', borderBottom: '1px solid rgba(229,225,214,0.6)', alignItems: 'center' }}>
                  <div>
                    <span style={{ fontSize: 13, color: '#0F0F10', display: 'block' }}>
                      {product ? `${product.brand} ${product.name}` : 'Unknown Product'}
                    </span>
                    {(() => {
                      // Plan §Print — Specs unter dem Produkt-Namen, auch im Print-View sichtbar.
                      const specs = getProductSpecs(product, categories);
                      if (specs.length === 0) return null;
                      return (
                        <span style={{ fontSize: 10, color: '#6B7280', display: 'block', marginTop: 2, lineHeight: 1.4 }}>
                          {specs.map(s => `${s.label}: ${s.value}`).join(' · ')}
                        </span>
                      );
                    })()}
                    {outOfRange && (
                      <span style={{ fontSize: 10, color: '#AA6E6E', display: 'block', marginTop: 2 }}>
                        Price outside range ({fmt(product.minSalePrice || 0)} — {fmt(product.maxSalePrice || 0)})
                      </span>
                    )}
                  </div>
                  {canEdit ? (
                    <input
                      type="number"
                      value={line.unitPrice}
                      onChange={e => {
                        const newPrice = Number(e.target.value) || 0;
                        updateOfferLine(offer.id, line.id, { unitPrice: newPrice, lineTotal: newPrice });
                      }}
                      className="font-mono outline-none"
                      style={{ width: 80, textAlign: 'right', padding: '2px 6px', fontSize: 13, background: 'transparent', border: '1px solid #D5D1C4', borderRadius: 4, color: '#0F0F10' }}
                    />
                  ) : (
                    <span className="font-mono" style={{ fontSize: 13, color: '#4B5563', textAlign: 'right' }}>{fmt(line.unitPrice)}</span>
                  )}
                  <span className="font-mono" style={{ fontSize: 13, color: '#0F0F10', textAlign: 'right' }}>{fmt(line.lineTotal)}</span>
                  {canEdit && (
                    <button onClick={() => handleRemoveLine(line.id)}
                      className="cursor-pointer transition-colors flex items-center justify-center"
                      style={{ background: 'none', border: 'none', color: '#6B7280', padding: 4 }}
                      onMouseEnter={e => (e.currentTarget.style.color = '#AA6E6E')}
                      onMouseLeave={e => (e.currentTarget.style.color = '#6B7280')}
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
              );
            })}

            {/* Total (brutto; VAT is embedded per business rule) */}
            {offer.lines.length > 0 && (
              <div style={{ marginTop: 16, padding: '16px 0 0', borderTop: '1px solid #E5E1D6' }}>
                <div className="flex justify-between" style={{ fontSize: 16, paddingTop: 10 }}>
                  <span style={{ color: '#0F0F10', fontWeight: 500 }}>Total</span>
                  <span className="font-mono" style={{ color: '#0F0F10', fontWeight: 500 }}>{fmt(offer.total)} BHD</span>
                </div>
              </div>
            )}
          </Card>

          {/* Details sidebar */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            <Card>
              <span className="text-overline" style={{ marginBottom: 16 }}>DETAILS</span>
              <div style={{ marginTop: 16 }}>
                {renderField('Offer Number', <span className="font-mono" style={{ color: '#0F0F10' }}>{offer.offerNumber}</span>)}
                {renderField('Status', <StatusDot status={offer.status} />)}
                {renderField('Currency', offer.currency)}
                {renderField('Tax Scheme', offer.taxScheme === 'MARGIN' ? 'Margin Scheme' : offer.taxScheme === 'VAT_10' ? 'Standard VAT' : 'Exempt')}
                {renderField(
                  'Client',
                  customer ? `${customer.firstName} ${customer.lastName}` : '\u2014',
                  editing ? (
                    <div style={{ width: 200 }}>
                      <input
                        placeholder="Search..."
                        value={customerSearch}
                        onChange={e => setCustomerSearch(e.target.value)}
                        className="w-full outline-none"
                        style={{ background: '#EFECE2', border: '1px solid #E5E1D6', borderRadius: 4, padding: '4px 8px', fontSize: 12, color: '#0F0F10', marginBottom: 4 }}
                      />
                      <div style={{ maxHeight: 100, overflowY: 'auto' }}>
                        {filteredCustomers.map(c => (
                          <div key={c.id} onClick={() => setFormCustomerId(c.id)}
                            className="cursor-pointer" style={{
                              padding: '4px 8px', fontSize: 12, borderRadius: 4,
                              background: formCustomerId === c.id ? 'rgba(15,15,16,0.06)' : 'transparent',
                              color: formCustomerId === c.id ? '#0F0F10' : '#4B5563',
                            }}>
                            {c.firstName} {c.lastName}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : undefined
                )}
                {renderField(
                  'Valid Until',
                  offer.validUntil || '\u2014',
                  editing ? (
                    <Input type="date" value={formValidUntil} onChange={e => setFormValidUntil(e.target.value)} style={{ width: 160 }} />
                  ) : undefined
                )}
                {renderField('Created', offer.createdAt?.split('T')[0])}
                {offer.sentAt && renderField('Sent', offer.sentAt.split('T')[0])}
                {offer.sentVia && renderField('Sent Via', offer.sentVia)}
                {offer.followUpAt && renderField('Follow Up', offer.followUpAt.split('T')[0])}
              </div>
            </Card>

            <Card>
              <div className="flex items-center justify-between" style={{ marginBottom: 16 }}>
                <span className="text-overline">NOTES</span>
                {offer.status === 'draft' && (
                  <button
                    className="cursor-pointer flex items-center gap-1 transition-colors"
                    style={{ background: 'none', border: 'none', color: '#0F0F10', fontSize: 11 }}
                    onClick={async () => {
                      const ai = await import('@/core/ai/ai-service');
                      if (!ai.isAiConfigured()) { alert('Set OpenAI API key in Settings > AI'); return; }
                      try {
                        const items = offer.lines.map(l => {
                          const p = products.find(pr => pr.id === l.productId);
                          return { brand: p?.brand || '', name: p?.name || '', price: l.unitPrice };
                        });
                        const text = await ai.generateOfferText({
                          customerName: customer ? `${customer.firstName} ${customer.lastName}` : 'Customer',
                          items, total: offer.total,
                        });
                        setFormNotes(text);
                      } catch (e) { alert(String(e)); }
                    }}
                  >Generate with AI</button>
                )}
              </div>
              <div style={{ marginTop: 0 }}>
                {editing || offer.status === 'draft' ? (
                  <textarea
                    value={formNotes}
                    onChange={e => setFormNotes(e.target.value)}
                    className="w-full outline-none transition-colors duration-300"
                    rows={4}
                    style={{ background: 'transparent', borderBottom: '1px solid #D5D1C4', padding: '8px 0', fontSize: 14, color: '#0F0F10', resize: 'vertical' }}
                  />
                ) : (
                  <p style={{ fontSize: 13, color: '#4B5563', lineHeight: 1.6 }}>{offer.notes || 'No notes.'}</p>
                )}
              </div>
            </Card>
          </div>
        </div>
      </div>

      {customer && (() => {
        const firstLine = offer.lines[0];
        const firstProduct = firstLine ? products.find(p => p.id === firstLine.productId) : undefined;
        const itemList = offer.lines.map(l => {
          const p = products.find(pr => pr.id === l.productId);
          return p ? `${p.brand} ${p.name}` : '';
        }).filter(Boolean).join(', ');
        return (
          <MessagePreviewModal
            open={showFollowUp}
            onClose={() => setShowFollowUp(false)}
            type="follow_up"
            customerId={customer.id}
            customerName={`${customer.firstName} ${customer.lastName}`}
            customerPhone={customer.phone}
            customerWhatsapp={customer.whatsapp}
            productImage={firstProduct?.images?.[0]}
            productLabel={itemList}
            details={`Offer ${offer.offerNumber} sent ${offer.sentAt ? offer.sentAt.split('T')[0] : 'recently'}. Total: ${fmt(offer.total)} BHD.`}
            linkedEntityType="offer"
            linkedEntityId={offer.id}
          />
        );
      })()}

      {/* VAT confirmation before invoice creation */}
      <ConfirmTaxSchemeModal
        open={showVatConfirm}
        lines={offer.lines.map(l => {
          const p = products.find(pr => pr.id === l.productId);
          return {
            id: l.id,
            label: p ? `${p.brand} ${p.name}` : 'Product',
            currentScheme: (l.taxScheme as TaxScheme) || 'MARGIN',
          };
        })}
        onCancel={() => setShowVatConfirm(false)}
        onConfirm={handleConfirmCreateInvoice}
      />

      {/* Delete confirmation modal */}
      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete Offer" width={400}>
        <p style={{ fontSize: 14, color: '#4B5563', marginBottom: 20 }}>
          Delete offer <strong style={{ color: '#0F0F10' }}>{offer.offerNumber}</strong>? This cannot be undone.
        </p>
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button>
          <Button variant="danger" onClick={handleDelete}>Delete</Button>
        </div>
      </Modal>

      {/* Add line item modal */}
      <Modal open={showAddLine} onClose={() => setShowAddLine(false)} title="Add Item" width={500}>
        <div style={{ maxHeight: '50vh', overflowY: 'auto' }}>
          {availableProducts.length === 0 && (
            <p style={{ fontSize: 13, color: '#6B7280', padding: '24px 0', textAlign: 'center' }}>No available products.</p>
          )}
          {availableProducts.map(p => (
            <div key={p.id} onClick={() => handleAddLine(p)}
              className="cursor-pointer rounded transition-colors"
              style={{ padding: '10px 12px', marginBottom: 2, borderBottom: '1px solid rgba(229,225,214,0.6)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(15,15,16,0.03)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <div className="flex justify-between items-center">
                <div>
                  <span style={{ fontSize: 13, color: '#0F0F10' }}>{p.brand} {p.name}</span>
                  {p.sku && <span className="font-mono" style={{ fontSize: 11, color: '#6B7280', marginLeft: 8 }}>{p.sku}</span>}
                </div>
                <span className="font-mono" style={{ fontSize: 13, color: '#4B5563' }}>{fmt(p.plannedSalePrice || p.purchasePrice)} BHD</span>
              </div>
            </div>
          ))}
        </div>
      </Modal>

      <HistoryDrawer
        open={showHistory}
        onClose={() => setShowHistory(false)}
        entityType="offers"
        entityId={offer.id}
        title={`History · ${offer.offerNumber}`}
      />
    </div>
  );
}
