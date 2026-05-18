// Transfer-Detail-Page (2026-05-18) — eigene Detail-Ansicht pro Approval-Transfer.
// Vorher fuehrte ein Row-Klick in der Transfer-Liste nur zu /agents/:agentId oder
// /invoices/:invoiceId; ein einzelner Transfer hatte kein eigenes Fenster.
// Diese Page zeigt: Header (Transfer# + Status), KPI-Strip (Our Price / Amount /
// Paid / Outstanding), Produkt-Card, Agent + Linked-Customer-Info, optional
// Linked-Invoice, Notes/Meta + Action-Buttons identisch zur TransferTable.
import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, FileText, History as HistoryIcon, Trash2 } from 'lucide-react';
import { useGoBack } from '@/hooks/useGoBack';
import { PageLayout } from '@/components/layout/PageLayout';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { StatusDot } from '@/components/ui/StatusDot';
import { Bhd } from '@/components/ui/Bhd';
import { HistoryDrawer } from '@/components/shared/HistoryPanel';
import { ProductHoverCard } from '@/components/products/ProductHoverCard';
import { formatInvoiceDisplayShort } from '@/core/utils/invoiceNumber';
import { useAgentStore } from '@/stores/agentStore';
import { useProductStore } from '@/stores/productStore';
import { useCustomerStore } from '@/stores/customerStore';
import { useInvoiceStore } from '@/stores/invoiceStore';
import type { AgentTransfer, Invoice } from '@/core/models/types';

type TransferDisplayStatus = 'transferred' | 'unpaid' | 'partial' | 'settled' | 'returned';

function deriveTransferDisplayStatus(t: AgentTransfer, invoice?: Invoice): TransferDisplayStatus {
  if (t.status === 'returned') return 'returned';
  if (t.status === 'transferred') return 'transferred';
  if (t.invoiceId && invoice) {
    const paid = invoice.paidAmount || 0;
    const gross = invoice.grossAmount || 0;
    if (gross > 0 && paid >= gross - 0.005) return 'settled';
    if (paid > 0.005) return 'partial';
    return 'unpaid';
  }
  if (t.settlementStatus === 'paid') return 'settled';
  if (t.settlementStatus === 'partial') return 'partial';
  return 'unpaid';
}

export function TransferDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const goBack = useGoBack('/agents');
  const {
    agents, transfers, loadAgents, loadTransfers,
    markTransferSold, markTransferReturned, convertTransferToInvoice,
    undoTransferInvoiceConvert, updateTransfer, deleteTransfer,
  } = useAgentStore();
  const { products, categories, loadProducts, loadCategories } = useProductStore();
  const { customers, createCustomer, loadCustomers } = useCustomerStore();
  const { invoices, loadInvoices } = useInvoiceStore();

  useEffect(() => {
    loadAgents(); loadTransfers(); loadProducts(); loadCategories(); loadCustomers(); loadInvoices();
  }, [loadAgents, loadTransfers, loadProducts, loadCategories, loadCustomers, loadInvoices]);

  const transfer = useMemo(() => transfers.find(t => t.id === id), [transfers, id]);
  const agent = useMemo(() => transfer ? agents.find(a => a.id === transfer.agentId) : undefined, [agents, transfer]);
  const product = useMemo(() => transfer ? products.find(p => p.id === transfer.productId) : undefined, [products, transfer]);
  const linkedInvoice = useMemo(() => transfer?.invoiceId ? invoices.find(i => i.id === transfer.invoiceId) : undefined, [invoices, transfer]);
  const linkedCustomer = useMemo(() => agent?.customerId ? customers.find(c => c.id === agent.customerId) : undefined, [customers, agent]);

  const customerOptions = useMemo(() => customers.map(c => ({
    id: c.id,
    label: `${c.firstName} ${c.lastName}${c.company ? ` — ${c.company}` : ''}`.trim(),
    subtitle: c.phone || c.email || undefined,
  })), [customers]);

  // Modal-State (analog zur TransferTable, aber pro Transfer)
  const [soldOpen, setSoldOpen] = useState(false);
  const [soldPrice, setSoldPrice] = useState(0);
  const [convertOpen, setConvertOpen] = useState(false);
  const [convertCustomerId, setConvertCustomerId] = useState('');
  const [convertMode, setConvertMode] = useState<'existing' | 'auto'>('existing');
  const [convertError, setConvertError] = useState('');
  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState<Partial<AgentTransfer>>({});
  const [historyOpen, setHistoryOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (!transfer) {
    return (
      <PageLayout title="Transfer Detail">
        <Card>
          <div style={{ padding: '60px 0', textAlign: 'center' }}>
            <p style={{ fontSize: 14, color: '#6B7280', marginBottom: 16 }}>Transfer not found.</p>
            <Button variant="ghost" onClick={() => goBack()}>← Back</Button>
          </div>
        </Card>
      </PageLayout>
    );
  }

  const displayStatus = deriveTransferDisplayStatus(transfer, linkedInvoice);
  const amount = linkedInvoice
    ? linkedInvoice.grossAmount
    : ((transfer.settlementAmount ?? transfer.actualSalePrice ?? transfer.agentPrice) || 0);
  const paid = linkedInvoice
    ? (linkedInvoice.paidAmount || 0)
    : (transfer.settlementStatus === 'paid'
      ? (transfer.settlementAmount ?? amount)
      : (transfer.settlementStatus === 'partial' ? (transfer.settlementPaidAmount || 0) : 0));
  const outstanding = Math.max(0, amount - paid);

  function openConvertModal() {
    let initialCustomerId = agent?.customerId || '';
    if (!initialCustomerId && agent) {
      const norm = (s?: string) => (s || '').replace(/\s+/g, '').toLowerCase();
      const phoneA = norm(agent.phone);
      const emailA = norm(agent.email);
      const whatsAppA = norm(agent.whatsapp);
      const match = customers.find(c =>
        (phoneA && norm(c.phone) === phoneA) ||
        (emailA && norm(c.email) === emailA) ||
        (whatsAppA && norm(c.whatsapp) === whatsAppA)
      );
      if (match) initialCustomerId = match.id;
    }
    setConvertCustomerId(initialCustomerId);
    setConvertMode('existing');
    setConvertError('');
    setConvertOpen(true);
  }

  function handleConvertConfirm() {
    if (!agent) { setConvertError('Agent not found.'); return; }
    let customerId = convertCustomerId;
    if (convertMode === 'auto') {
      const parts = (agent.name || '').trim().split(/\s+/);
      const firstName = parts[0] || agent.name || 'Agent';
      const lastName = parts.slice(1).join(' ') || '';
      const newCust = createCustomer({
        firstName, lastName, company: agent.company,
        phone: agent.phone, whatsapp: agent.whatsapp, email: agent.email,
        notes: `Auto-created from agent ${agent.name} for transfer settlements.`,
      });
      customerId = newCust.id;
    }
    if (!customerId) { setConvertError('Please pick a customer or choose auto-create.'); return; }
    try {
      const inv = convertTransferToInvoice(transfer!.id, customerId);
      setConvertOpen(false);
      navigate(`/invoices/${inv.id}`);
    } catch (err) {
      setConvertError(err instanceof Error ? err.message : String(err));
    }
  }

  const formattedTransferred = (transfer.transferredAt || transfer.createdAt || '').split('T')[0];
  const formattedSold = transfer.soldAt ? transfer.soldAt.split('T')[0] : '';
  const formattedReturned = transfer.returnedAt ? transfer.returnedAt.split('T')[0] : '';

  return (
    <PageLayout
      title={`Transfer ${transfer.transferNumber}`}
      subtitle={agent?.name ? `Approval: ${agent.name}` : 'Approval Transfer'}
      actions={
        <div className="flex gap-2 items-center">
          <Button variant="ghost" onClick={() => goBack()}>
            <ArrowLeft size={14} /> Back
          </Button>
          <Button variant="ghost" onClick={() => setHistoryOpen(true)}>
            <HistoryIcon size={14} /> History
          </Button>
        </div>
      }
    >
      <div style={{ maxWidth: 1100, display: 'flex', flexDirection: 'column', gap: 18 }}>
        {/* Hero / KPI strip */}
        <Card style={{ padding: 18 }}>
          <div className="flex items-center justify-between" style={{ marginBottom: 14 }}>
            <div className="flex items-center gap-3">
              <span className="font-mono" style={{ fontSize: 15, color: '#0F0F10', fontWeight: 600 }}>
                {transfer.transferNumber}
              </span>
              <StatusDot status={displayStatus} />
            </div>
            <span style={{ fontSize: 11, color: '#9CA3AF' }}>
              transferred {formattedTransferred || '—'}
              {formattedSold && ` · sold ${formattedSold}`}
              {formattedReturned && ` · returned ${formattedReturned}`}
            </span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
            {[
              { label: 'Our Price', value: transfer.agentPrice || 0, color: '#4B5563' },
              { label: 'Amount', value: amount, color: '#0F0F10' },
              { label: 'Paid', value: paid, color: paid > 0 ? '#16A34A' : '#6B7280' },
              { label: 'Outstanding', value: outstanding, color: outstanding > 0 ? '#DC2626' : '#6B7280' },
            ].map(k => (
              <div key={k.label} style={{
                padding: '10px 12px', borderRadius: 8,
                background: '#FAFBFC', border: '1px solid #E5E9EE',
              }}>
                <div style={{ fontSize: 10, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>
                  {k.label}
                </div>
                <div className="font-mono" style={{ fontSize: 16, color: k.color, fontWeight: 600 }}>
                  <Bhd v={k.value} /> <span style={{ fontSize: 10, color: '#9CA3AF', fontWeight: 400 }}>BHD</span>
                </div>
              </div>
            ))}
          </div>
        </Card>

        {/* Actions */}
        <Card style={{ padding: 14 }}>
          <div className="flex flex-wrap gap-2">
            {transfer.status === 'transferred' && (
              <>
                <Button variant="primary" onClick={() => { setSoldPrice(transfer.agentPrice); setSoldOpen(true); }}>
                  Mark as Sold
                </Button>
                <Button variant="ghost" onClick={() => markTransferReturned(transfer.id)}>
                  Mark as Returned
                </Button>
              </>
            )}
            {(transfer.status === 'sold' || transfer.status === 'settled') && !transfer.invoiceId && (
              <Button variant="primary" onClick={openConvertModal}>
                <FileText size={14} /> Create Invoice
              </Button>
            )}
            {transfer.invoiceId && linkedInvoice && (
              <>
                <Button variant="primary" onClick={() => navigate(`/invoices/${linkedInvoice.id}`)}>
                  <FileText size={14} /> Open Invoice ({formatInvoiceDisplayShort(linkedInvoice)})
                </Button>
                {(linkedInvoice.paidAmount || 0) <= 0.005 && (
                  <Button variant="ghost" onClick={() => {
                    if (!window.confirm(`Convert rückgängig machen? Die Invoice wird gelöscht und der Transfer wieder auf "Sold" gesetzt.`)) return;
                    try { undoTransferInvoiceConvert(transfer.id); }
                    catch (err) { alert(err instanceof Error ? err.message : String(err)); }
                  }}>
                    Undo Convert
                  </Button>
                )}
              </>
            )}
            <Button variant="ghost" onClick={() => { setEditForm({ ...transfer }); setEditOpen(true); }}>
              Edit
            </Button>
            <div style={{ flex: 1 }} />
            <Button variant="ghost" onClick={() => setConfirmDelete(true)}>
              <Trash2 size={14} color="#DC2626" /> <span style={{ color: '#DC2626' }}>Delete</span>
            </Button>
          </div>
        </Card>

        {/* Item + Approval */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
          <Card style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '10px 14px', borderBottom: '1px solid #E5E9EE' }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#0F0F10' }}>Item</span>
            </div>
            <div style={{ padding: 14 }}>
              {product ? (
                <button
                  onClick={() => navigate(`/collection/${product.id}`)}
                  className="cursor-pointer"
                  style={{ background: 'none', border: 'none', padding: 0, textAlign: 'left', width: '100%' }}
                  title="Open product detail"
                >
                  <ProductHoverCard product={product} categories={categories} />
                </button>
              ) : (
                <div style={{ padding: 16, fontSize: 12, color: '#9CA3AF', textAlign: 'center' }}>
                  Product no longer available.
                </div>
              )}
            </div>
          </Card>

          <Card style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '10px 14px', borderBottom: '1px solid #E5E9EE' }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#0F0F10' }}>Approval / Agent</span>
            </div>
            <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {agent ? (
                <>
                  <button
                    onClick={() => navigate(`/agents/${agent.id}`)}
                    className="cursor-pointer"
                    style={{
                      background: 'none', border: 'none', padding: 0, textAlign: 'left',
                      color: '#715DE3', fontSize: 15, fontWeight: 600,
                      textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 3,
                    }}
                    title="Open approval detail"
                  >
                    {agent.name}
                  </button>
                  {agent.company && <span style={{ fontSize: 12, color: '#4B5563' }}>{agent.company}</span>}
                  {agent.phone && <span style={{ fontSize: 12, color: '#4B5563' }}>Phone: {agent.phone}</span>}
                  {agent.email && <span style={{ fontSize: 12, color: '#4B5563' }}>Email: {agent.email}</span>}
                  <div style={{ borderTop: '1px solid #F0F2F5', paddingTop: 8, marginTop: 4 }}>
                    <div style={{ fontSize: 10, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>
                      Linked Customer
                    </div>
                    {linkedCustomer ? (
                      <button
                        onClick={() => navigate(`/clients/${linkedCustomer.id}`)}
                        className="cursor-pointer"
                        style={{
                          background: 'none', border: 'none', padding: 0,
                          color: '#715DE3', fontSize: 13,
                          textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 3,
                        }}
                      >
                        {linkedCustomer.firstName} {linkedCustomer.lastName}
                        {linkedCustomer.company ? ` — ${linkedCustomer.company}` : ''}
                      </button>
                    ) : (
                      <span style={{ fontSize: 12, color: '#9CA3AF' }}>None linked</span>
                    )}
                  </div>
                </>
              ) : (
                <span style={{ fontSize: 12, color: '#9CA3AF' }}>Agent not found.</span>
              )}
            </div>
          </Card>
        </div>

        {/* Meta / Notes */}
        <Card style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
            <KvCell label="Transfer Number" value={transfer.transferNumber} mono />
            <KvCell label="Status" value={transfer.status.toUpperCase()} />
            <KvCell label="Return By" value={transfer.returnBy ? transfer.returnBy.split('T')[0] : '—'} />
            <KvCell label="Actual Sale Price"
              value={transfer.actualSalePrice ? <><Bhd v={transfer.actualSalePrice}/> BHD</> : '—'} />
            <KvCell label="Settlement Amount"
              value={transfer.settlementAmount ? <><Bhd v={transfer.settlementAmount}/> BHD</> : '—'} />
            <KvCell label="Settlement Status" value={(transfer.settlementStatus || 'pending').toUpperCase()} />
          </div>
          {transfer.notes && (
            <div style={{ borderTop: '1px solid #F0F2F5', paddingTop: 10 }}>
              <div style={{ fontSize: 10, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>
                Notes
              </div>
              <p style={{ fontSize: 13, color: '#0F0F10', whiteSpace: 'pre-wrap', margin: 0 }}>{transfer.notes}</p>
            </div>
          )}
        </Card>
      </div>

      {/* Sold Modal */}
      <Modal open={soldOpen} onClose={() => setSoldOpen(false)} title="Record Sale" width={420}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ padding: '10px 14px', background: '#F7F5EE', borderRadius: 8, fontSize: 12 }}>
            <div className="flex justify-between">
              <span style={{ color: '#6B7280' }}>Our Price (vereinbart)</span>
              <span className="font-mono" style={{ color: '#0F0F10' }}><Bhd v={transfer.agentPrice || 0}/> BHD</span>
            </div>
          </div>
          <Input required label="ACTUAL SALE PRICE (BHD)" type="number"
            placeholder="Tatsächlich verkauft — darf abweichen"
            value={soldPrice || ''}
            onChange={e => setSoldPrice(Number(e.target.value))} />
          <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setSoldOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => {
              if (soldPrice > 0) { markTransferSold(transfer.id, soldPrice); setSoldOpen(false); }
            }} disabled={soldPrice <= 0}>Confirm Sale</Button>
          </div>
        </div>
      </Modal>

      {/* Convert Modal */}
      <Modal open={convertOpen} onClose={() => setConvertOpen(false)} title="Create Invoice from Transfer" width={460}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ padding: '10px 14px', background: '#F7F5EE', borderRadius: 8, fontSize: 12 }}>
            <div className="flex justify-between" style={{ marginBottom: 4 }}>
              <span style={{ color: '#6B7280' }}>Transfer</span>
              <span className="font-mono" style={{ color: '#0F0F10' }}>{transfer.transferNumber}</span>
            </div>
            <div className="flex justify-between" style={{ marginBottom: 4 }}>
              <span style={{ color: '#6B7280' }}>Agent</span>
              <span style={{ color: '#0F0F10' }}>{agent?.name || '—'}</span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: '#6B7280' }}>Settlement</span>
              <span className="font-mono" style={{ color: '#0F0F10' }}><Bhd v={transfer.settlementAmount || 0}/> BHD</span>
            </div>
          </div>
          <div>
            <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>BILL TO</span>
            <div className="flex gap-2" style={{ marginBottom: 10 }}>
              {(['existing', 'auto'] as const).map(m => (
                <button key={m} onClick={() => setConvertMode(m)}
                  className="cursor-pointer rounded transition-all"
                  style={{ padding: '7px 14px', fontSize: 12,
                    border: `1px solid ${convertMode === m ? '#0F0F10' : '#D5D9DE'}`,
                    color: convertMode === m ? '#0F0F10' : '#6B7280',
                    background: convertMode === m ? 'rgba(15,15,16,0.06)' : 'transparent',
                  }}>{m === 'existing' ? 'Pick existing customer' : 'Auto-create from agent'}</button>
              ))}
            </div>
            {convertMode === 'existing' ? (
              <SearchSelect
                placeholder="Search customers…"
                options={customerOptions}
                value={convertCustomerId}
                onChange={setConvertCustomerId}
              />
            ) : (
              <div style={{ padding: '10px 14px', background: '#F2F7FA', border: '1px solid #E5E9EE', borderRadius: 6, fontSize: 12, color: '#4B5563' }}>
                Wird angelegt: <strong style={{ color: '#0F0F10' }}>{agent?.name}</strong>
                {agent?.company ? ` · ${agent.company}` : ''}
                {agent?.phone ? ` · ${agent.phone}` : ''}
              </div>
            )}
          </div>
          {convertError && (
            <div style={{ padding: '8px 12px', background: 'rgba(220,38,38,0.06)', border: '1px solid rgba(220,38,38,0.3)', borderRadius: 6, fontSize: 12, color: '#DC2626' }}>
              {convertError}
            </div>
          )}
          <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setConvertOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleConvertConfirm}>
              <FileText size={14} /> Create Invoice
            </Button>
          </div>
        </div>
      </Modal>

      {/* Edit Modal */}
      <Modal open={editOpen} onClose={() => setEditOpen(false)} title={`Edit Transfer — ${transfer.transferNumber}`} width={460}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Input required label="OUR PRICE (BHD)" type="number" value={editForm.agentPrice ?? ''}
            onChange={e => setEditForm({ ...editForm, agentPrice: Number(e.target.value) || 0 })} />
          <Input label="RETURN BY (DATE)" type="date" value={(editForm.returnBy || '').split('T')[0]}
            onChange={e => setEditForm({ ...editForm, returnBy: e.target.value })} />
          <div>
            <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>NOTES</span>
            <textarea value={editForm.notes || ''}
              onChange={e => setEditForm({ ...editForm, notes: e.target.value })}
              rows={3}
              style={{ width: '100%', background: 'transparent', border: '1px solid #D5D9DE', borderRadius: 6, padding: '8px 10px', fontSize: 13, color: '#0F0F10' }} />
          </div>
          <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => {
              updateTransfer(transfer.id, editForm);
              setEditOpen(false);
            }}>Save</Button>
          </div>
        </div>
      </Modal>

      {/* Delete Confirm */}
      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete Transfer" width={380}>
        <p style={{ fontSize: 14, color: '#4B5563', marginBottom: 20 }}>
          Delete transfer <strong>{transfer.transferNumber}</strong>? This action cannot be undone.
        </p>
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button>
          <Button variant="danger" onClick={() => {
            deleteTransfer(transfer.id);
            setConfirmDelete(false);
            goBack();
          }}>Delete</Button>
        </div>
      </Modal>

      {/* History */}
      <HistoryDrawer
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        entityType="agent_transfers"
        entityId={transfer.id}
        title="Transfer History"
      />
    </PageLayout>
  );
}

function KvCell({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 2 }}>
        {label}
      </div>
      <div className={mono ? 'font-mono' : ''} style={{ fontSize: 13, color: '#0F0F10' }}>{value}</div>
    </div>
  );
}
