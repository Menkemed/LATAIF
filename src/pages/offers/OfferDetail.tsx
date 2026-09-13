import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Edit3, Save, Trash2, Plus, X, FileText, Download, Sparkles } from 'lucide-react';
import { useGoBack } from '@/hooks/useGoBack';
import { Button } from '@/components/ui/Button';
import { primaryOnlyDeleteProps, blockDeleteOnClient } from '@/core/data/primary-only';
import { Card } from '@/components/ui/Card';
import { StatusDot } from '@/components/ui/StatusDot';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { MessagePreviewModal } from '@/components/ai/MessagePreviewModal';
import { useOfferStore } from '@/stores/offerStore';
import { useCustomerStore } from '@/stores/customerStore';
import { useProductStore } from '@/stores/productStore';
import { downloadPdf } from '@/core/pdf/pdf-generator';
import { formatProductMultiLine, getProductSpecs } from '@/core/utils/product-format';
import { usePermission } from '@/hooks/usePermission';
import { HistoryDrawer } from '@/components/shared/HistoryPanel';
import { ConfirmTaxSchemeModal } from '@/components/shared/ConfirmTaxSchemeModal';
import { NumberTypeDialog } from '@/components/ui/NumberTypeDialog';
import type { TaxScheme } from '@/core/models/types';
import { Bhd } from '@/components/ui/Bhd';
import { vatEngine } from '@/core/tax/vat-engine';
// CENTRAL-UI-PARITY R6E — Bearbeiten ist ein Entwurf im Fenster, gespeichert mit EINEM „Save";
// Senden/Annehmen/Ablehnen und „Create Invoice" sind je EIN Auftrag. Alles durch die gemeinsame
// Schreibweiche: am Primary die Hausfolge in einer Transaktion, auf PC2 der geprüfte Fernbefehl.
import { useSharedWrites, fehlertext } from '@/core/data/shared-write';
import { WriteError } from '@/components/shared/WriteError';
import {
  draftOf, priceFromField, saveOfferConvert, saveOfferStatus, saveOfferUpdate, type OfferDraft,
} from '@/core/offers/offer-actions';
import type { OfferTargetStatus } from '@/core/offers/offer-rules';

function fmt(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}

export function OfferDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const goBack = useGoBack('/offers');
  const { offers, loadOffers, deleteOffer } = useOfferStore();
  const { customers, loadCustomers } = useCustomerStore();
  const { products, loadProducts, categories, loadCategories } = useProductStore();
  const w = useSharedWrites();

  const [editing, setEditing] = useState(false);
  // R6E — der Entwurf: Kopf und Positionen, nur hier im Fenster, bis „Save". „Cancel" verwirft ihn.
  const [draft, setDraft] = useState<OfferDraft | null>(null);
  const [fehler, setFehler] = useState('');
  const [showVatConfirm, setShowVatConfirm] = useState(false);
  // 2026-05-16 — Nach VAT-Confirm fragen wir noch Normal vs Special Final.
  const [pendingPerLine, setPendingPerLine] = useState<Record<string, TaxScheme> | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showAddLine, setShowAddLine] = useState(false);
  const [customerSearch, setCustomerSearch] = useState('');
  const [showFollowUp, setShowFollowUp] = useState(false);
  const perm = usePermission();

  useEffect(() => { loadOffers(); loadCustomers(); loadProducts(); loadCategories(); }, [loadOffers, loadCustomers, loadProducts, loadCategories]);

  const offer = useMemo(() => offers.find(o => o.id === id), [offers, id]);
  const customer = useMemo(() => offer ? customers.find(c => c.id === offer.customerId) : null, [offer, customers]);

  const filteredCustomers = useMemo(() => {
    if (!customerSearch) return customers.slice(0, 10);
    const q = customerSearch.toLowerCase();
    return customers.filter(c => `${c.firstName} ${c.lastName} ${c.company || ''}`.toLowerCase().includes(q));
  }, [customers, customerSearch]);

  const availableProducts = useMemo(() => {
    if (!offer) return [];
    const usedIds = new Set((draft ? draft.lines : offer.lines).map(l => l.productId));
    return products.filter(p => p.stockStatus === 'in_stock' && !usedIds.has(p.id));
  }, [products, offer, draft]);

  if (!offer) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ height: '100vh', background: '#FFFFFF' }}>
        <p style={{ color: '#6B7280' }}>Offer not found</p>
      </div>
    );
  }

  const canEdit = offer.status === 'draft';
  const canDelete = offer.status === 'draft' || offer.status === 'rejected';
  const canCreateInvoice = offer.status === 'accepted' && !offer.invoiceId;
  const bearbeiten = editing && draft !== null;

  function startEdit() {
    if (!offer) return;
    setFehler('');
    setDraft(draftOf(offer));
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
    setDraft(null);
    setShowAddLine(false);
    setFehler('');
  }

  // R6E — EIN Speichern: Kopf und der ganze Positionsstand mit der gesehenen Fassung. Bei einem Nein
  // bleibt der Entwurf stehen (nichts geht verloren), der Grund steht über der Seite.
  async function handleSave() {
    if (!offer || !draft) return;
    setFehler('');
    const r = await saveOfferUpdate(w, offer, draft);
    if (r.kind !== 'ok') { setFehler(fehlertext(r)); return; }
    setEditing(false);
    setDraft(null);
  }

  function handleDelete() {
    if (!id) return;
    if (blockDeleteOnClient()) { setConfirmDelete(false); return; }
    deleteOffer(id);
    navigate('/offers');
  }

  async function handleStatus(status: OfferTargetStatus) {
    if (!offer) return;
    setFehler('');
    const r = await saveOfferStatus(w, offer, status);
    if (r.kind !== 'ok') setFehler(fehlertext(r));
  }

  function handleCreateInvoice() {
    if (!id) return;
    setFehler('');
    setShowVatConfirm(true);
  }

  function handleConfirmCreateInvoice(perLine: Record<string, TaxScheme>) {
    setShowVatConfirm(false);
    if (!id) return;
    // Step 2: Number-Type-Dialog vor dem eigentlichen Convert.
    setPendingPerLine(perLine);
  }

  // R6E — die Rechnung entsteht am Primary über denselben Weg wie jede andere; erst bei Erfolg geht
  // es zur Rechnung, sonst bleibt der Grund sichtbar.
  async function handleNumberTypeConfirm(special: boolean) {
    const perLine = pendingPerLine;
    setPendingPerLine(null);
    if (!offer || !perLine) return;
    setFehler('');
    const r = await saveOfferConvert(w, offer, perLine, special);
    if (r.kind !== 'ok') { setFehler(fehlertext(r)); return; }
    navigate(`/invoices/${r.value.invoiceId}`);
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

  // R6E — Hinzufügen/Entfernen/Preis ändern nur im Entwurf. Den Einstand rechnet der Primary beim
  // Speichern mit SEINEM Los — die Seite schickt nur Artikel und Preis.
  function handleAddLine(product: typeof products[0]) {
    setDraft(d => d ? { ...d, lines: [...d.lines, { productId: product.id, price: String(product.plannedSalePrice || product.purchasePrice) }] } : d);
    setShowAddLine(false);
  }

  function handleRemoveLine(idx: number) {
    setDraft(d => d ? { ...d, lines: d.lines.filter((_, i) => i !== idx) } : d);
  }

  function setLinePrice(idx: number, price: string) {
    setDraft(d => d ? { ...d, lines: d.lines.map((l, i) => i === idx ? { ...l, price } : l) } : d);
  }

  /** Das Schema einer Entwurfsposition: die bestehende behält ihres, eine neue nimmt das des Artikels. */
  function schemeOfDraft(line: { id?: string; productId: string }): TaxScheme {
    const saved = line.id ? offer?.lines.find(l => l.id === line.id) : undefined;
    if (saved) return saved.taxScheme;
    return (products.find(p => p.id === line.productId)?.taxScheme as TaxScheme) || 'MARGIN';
  }

  /** Nur die Vorschau im Entwurf; gespeichert rechnet der Primary (dieselbe Netto-Rechnung). */
  function previewTotal(price: number, scheme: TaxScheme): number {
    if (!Number.isFinite(price) || price < 0) return 0;
    return vatEngine.calculateNet(price, 0, scheme, offer?.vatRate || 10).grossAmount;
  }

  const rows = bearbeiten
    ? draft!.lines.map((l, idx) => {
      const price = priceFromField(l.price);
      return {
        key: l.id ?? `new-${l.productId}`, idx, productId: l.productId,
        unitPrice: Number.isFinite(price) ? price : 0, priceText: String(l.price),
        lineTotal: previewTotal(price, schemeOfDraft(l)),
      };
    })
    : offer.lines.map((l, idx) => ({
      key: l.id, idx, productId: l.productId, unitPrice: l.unitPrice, priceText: String(l.unitPrice), lineTotal: l.lineTotal,
    }));
  const shownTotal = bearbeiten ? rows.reduce((s, r) => s + r.lineTotal, 0) : offer.total;
  const lineCols = bearbeiten ? 'minmax(0,3fr) minmax(0,1fr) minmax(0,1fr) 32px' : 'minmax(0,3fr) minmax(0,1fr) minmax(0,1fr)';
  const shownCustomerId = bearbeiten ? draft!.customerId : offer.customerId;

  function renderField(label: string, value: React.ReactNode, editField?: React.ReactNode) {
    return (
      <div className="flex justify-between items-center" style={{ padding: '10px 0', borderBottom: '1px solid #E5E9EE' }}>
        <span style={{ fontSize: 13, color: '#6B7280' }}>{label}</span>
        {editing && editField ? editField : <span style={{ fontSize: 13, color: '#0F0F10' }}>{value || '—'}</span>}
      </div>
    );
  }

  return (
    <div className="app-content" style={{ background: '#FFFFFF' }}>
      <div style={{ padding: '32px 48px 64px', maxWidth: 1500 }}>

        {/* Header */}
        <div className="flex items-center justify-between" style={{ marginBottom: 32 }}>
          <button onClick={goBack}
            className="flex items-center gap-2 cursor-pointer transition-colors"
            style={{ background: 'none', border: 'none', color: '#6B7280', fontSize: 13 }}
            onMouseEnter={e => (e.currentTarget.style.color = '#0F0F10')}
            onMouseLeave={e => (e.currentTarget.style.color = '#6B7280')}
          >
            <ArrowLeft size={16} /> Back
          </button>
          <div className="flex gap-2">
            {editing ? (
              <>
                <Button variant="ghost" data-offer-cancel onClick={cancelEdit} disabled={w.busy}>Cancel</Button>
                <Button variant="primary" data-offer-save onClick={() => { void handleSave(); }} disabled={w.busy}><Save size={14} /> Save</Button>
              </>
            ) : (
              <>
                <Button variant="secondary" onClick={handleDownloadPdf}><Download size={14} /> PDF</Button>
                <Button variant="ghost" onClick={() => setShowHistory(true)}>History</Button>
                {canEdit && perm.canEditOffers && <Button variant="secondary" data-offer-edit onClick={startEdit}><Edit3 size={14} /> Edit</Button>}
                {offer.status === 'draft' && perm.canEditOffers && <Button variant="primary" data-offer-send onClick={() => { void handleStatus('sent'); }} disabled={w.busy}>Send Offer</Button>}
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
                    <Button variant="primary" data-offer-accept onClick={() => { void handleStatus('accepted'); }} disabled={w.busy}>Accept</Button>
                    <Button variant="danger" data-offer-reject onClick={() => { void handleStatus('rejected'); }} disabled={w.busy}>Reject</Button>
                  </>
                )}
                {canCreateInvoice && (
                  <Button variant="primary" data-offer-create-invoice onClick={handleCreateInvoice} disabled={w.busy}><FileText size={14} /> Create Invoice</Button>
                )}
                {canDelete && perm.canDeleteOffers && (
                  <Button variant="danger" {...primaryOnlyDeleteProps()} onClick={() => setConfirmDelete(true)}><Trash2 size={14} /> Delete</Button>
                )}
              </>
            )}
          </div>
        </div>

        <WriteError text={fehler} />

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
            <span className="font-display" style={{ fontSize: 24, color: '#0F0F10' }}><Bhd v={offer.total}/> BHD</span>
          </div>
        </div>

        {/* Content Grid */}
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 24 }}>

          {/* Lines */}
          <Card>
            <div className="flex justify-between items-center" style={{ marginBottom: 16 }}>
              <span className="text-overline">LINE ITEMS</span>
              {bearbeiten && (
                <button data-offer-line-add onClick={() => setShowAddLine(true)}
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
            <div style={{ display: 'grid', gridTemplateColumns: lineCols, gap: 12, padding: '8px 0', borderBottom: '1px solid #E5E9EE' }}>
              <span style={{ fontSize: 11, color: '#6B7280' }}>PRODUCT</span>
              <span style={{ fontSize: 11, color: '#6B7280', textAlign: 'right' }}>UNIT PRICE</span>
              <span style={{ fontSize: 11, color: '#6B7280', textAlign: 'right' }}>TOTAL</span>
              {bearbeiten && <span />}
            </div>

            {rows.length === 0 && (
              <div style={{ padding: '32px 0', textAlign: 'center' }}>
                <p style={{ fontSize: 13, color: '#6B7280' }}>No items added yet.</p>
              </div>
            )}

            {rows.map(line => {
              const product = products.find(p => p.id === line.productId);
              const outOfRange = product && (
                (product.minSalePrice && line.unitPrice < product.minSalePrice) ||
                (product.plannedSalePrice && line.unitPrice > product.plannedSalePrice)
              );
              return (
                <div key={line.key} data-offer-line={line.productId} style={{ display: 'grid', gridTemplateColumns: lineCols, gap: 12, padding: '12px 0', borderBottom: '1px solid rgba(229,225,214,0.6)', alignItems: 'center' }}>
                  <div>
                    <span style={{ fontSize: 13, color: '#0F0F10', display: 'block' }}>
                      {product ? `${product.brand} ${product.name}` : 'Unknown Product'}
                    </span>
                    {(() => {
                      // Plan §Print — Specs als 2-Spalten-Grid (kompakt + ästhetisch, auch im Print-View).
                      const specs = getProductSpecs(product, categories);
                      if (specs.length === 0) return null;
                      return (
                        <div style={{
                          display: 'grid', gridTemplateColumns: '1fr 1fr',
                          columnGap: 16, rowGap: 1,
                          marginTop: 4, fontSize: 10, color: '#444',
                        }}>
                          {specs.map((s, i) => (
                            <div key={i} style={{ display: 'flex', gap: 4, lineHeight: 1.35 }}>
                              <span style={{ color: '#9CA3AF' }}>{s.label}:</span>
                              <span style={{ color: '#374151', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.value}</span>
                            </div>
                          ))}
                        </div>
                      );
                    })()}
                    {outOfRange && (
                      <span style={{ fontSize: 10, color: '#AA6E6E', display: 'block', marginTop: 2 }}>
                        Price outside range (<Bhd v={product.minSalePrice || 0}/> — <Bhd v={product.plannedSalePrice || 0}/>)
                      </span>
                    )}
                  </div>
                  {bearbeiten ? (
                    <input
                      type="number"
                      data-offer-line-price={line.productId}
                      value={line.priceText}
                      onChange={e => setLinePrice(line.idx, e.target.value)}
                      className="font-mono outline-none"
                      style={{ minWidth: 0, width: '100%', textAlign: 'right', padding: '2px 6px', fontSize: 13, background: 'transparent', border: '1px solid #D5D9DE', borderRadius: 4, color: '#0F0F10' }}
                    />
                  ) : (
                    <span className="font-mono" style={{ fontSize: 13, color: '#4B5563', textAlign: 'right', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><Bhd v={line.unitPrice}/></span>
                  )}
                  <span className="font-mono" style={{ fontSize: 13, color: '#0F0F10', textAlign: 'right', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><Bhd v={line.lineTotal}/></span>
                  {bearbeiten && (
                    <button data-offer-line-remove={line.productId} onClick={() => handleRemoveLine(line.idx)}
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
            {rows.length > 0 && (
              <div style={{ marginTop: 16, padding: '16px 0 0', borderTop: '1px solid #E5E9EE' }}>
                <div className="flex justify-between" style={{ fontSize: 16, paddingTop: 10 }}>
                  <span style={{ color: '#0F0F10', fontWeight: 500 }}>Total</span>
                  <span className="font-mono" style={{ color: '#0F0F10', fontWeight: 500 }}><Bhd v={shownTotal}/> BHD</span>
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
                  customer ? `${customer.firstName} ${customer.lastName}` : '—',
                  bearbeiten ? (
                    <div style={{ width: 200 }}>
                      <input
                        placeholder="Search..."
                        value={customerSearch}
                        onChange={e => setCustomerSearch(e.target.value)}
                        className="w-full outline-none"
                        style={{ background: '#F2F7FA', border: '1px solid #E5E9EE', borderRadius: 4, padding: '4px 8px', fontSize: 12, color: '#0F0F10', marginBottom: 4 }}
                      />
                      <div style={{ maxHeight: 100, overflowY: 'auto' }}>
                        {filteredCustomers.map(c => (
                          <div key={c.id} data-offer-customer-option={c.id} onClick={() => setDraft(d => d ? { ...d, customerId: c.id } : d)}
                            className="cursor-pointer" style={{
                              padding: '4px 8px', fontSize: 12, borderRadius: 4,
                              background: shownCustomerId === c.id ? 'rgba(15,15,16,0.06)' : 'transparent',
                              color: shownCustomerId === c.id ? '#0F0F10' : '#4B5563',
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
                  offer.validUntil || '—',
                  bearbeiten ? (
                    <Input type="date" data-offer-valid-until value={draft!.validUntil} onChange={e => { const v = e.target.value; setDraft(d => d ? { ...d, validUntil: v } : d); }} style={{ width: 160 }} />
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
                {/* R6E — die Notiz gehört zum Entwurf: nur im Bearbeiten änderbar, gespeichert mit „Save". */}
                {bearbeiten && offer.status === 'draft' && (
                  <button
                    className="cursor-pointer flex items-center gap-1 transition-colors"
                    style={{ background: 'none', border: 'none', color: '#0F0F10', fontSize: 11 }}
                    onClick={async () => {
                      const ai = await import('@/core/ai/ai-service');
                      if (!ai.isAiConfigured()) { alert('Set OpenAI API key in Settings > AI'); return; }
                      try {
                        const items = (draft?.lines ?? []).map(l => {
                          const p = products.find(pr => pr.id === l.productId);
                          const price = priceFromField(l.price);
                          return { brand: p?.brand || '', name: p?.name || '', price: Number.isFinite(price) ? price : 0 };
                        });
                        const text = await ai.generateOfferText({
                          customerName: customer ? `${customer.firstName} ${customer.lastName}` : 'Customer',
                          items, total: shownTotal,
                        });
                        setDraft(d => d ? { ...d, notes: text } : d);
                      } catch (e) { alert(String(e)); }
                    }}
                  >Generate with AI</button>
                )}
              </div>
              <div style={{ marginTop: 0 }}>
                {bearbeiten ? (
                  <textarea
                    data-offer-notes
                    value={draft!.notes}
                    onChange={e => { const v = e.target.value; setDraft(d => d ? { ...d, notes: v } : d); }}
                    className="w-full outline-none transition-colors duration-300"
                    rows={4}
                    style={{ background: 'transparent', borderBottom: '1px solid #D5D9DE', padding: '8px 0', fontSize: 14, color: '#0F0F10', resize: 'vertical' }}
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

      <NumberTypeDialog
        open={!!pendingPerLine}
        variant="sales"
        onCancel={() => setPendingPerLine(null)}
        onConfirm={(special) => { void handleNumberTypeConfirm(special); }}
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

      {/* Add line item modal — fügt dem Entwurf hinzu, gespeichert wird mit „Save" */}
      <Modal open={showAddLine} onClose={() => setShowAddLine(false)} title="Add Item" width={500}>
        <div style={{ maxHeight: '50vh', overflowY: 'auto' }}>
          {availableProducts.length === 0 && (
            <p style={{ fontSize: 13, color: '#6B7280', padding: '24px 0', textAlign: 'center' }}>No available products.</p>
          )}
          {availableProducts.map(p => (
            <div key={p.id} data-offer-add-product={p.id} onClick={() => handleAddLine(p)}
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
                <span className="font-mono" style={{ fontSize: 13, color: '#4B5563' }}><Bhd v={p.plannedSalePrice || p.purchasePrice}/> BHD</span>
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
