import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Printer, Search, UserCheck } from 'lucide-react';
import { PageLayout } from '@/components/layout/PageLayout';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { PhoneInput } from '@/components/ui/PhoneInput';
import { DuplicateWarningBanner } from '@/components/contacts/DuplicateWarningBanner';
import { findSimilarContacts } from '@/core/contacts/duplicate-check';
import { QuickCustomerModal } from '@/components/customers/QuickCustomerModal';
import { TransferTable } from '@/components/agents/TransferTable';
import { StaffSelect } from '@/components/employees/StaffSelect';
import { StaffFilterPill } from '@/components/employees/StaffFilterPill';
import { ProductHoverCard } from '@/components/products/ProductHoverCard';
import { PrintItemsFilterModal } from '@/components/print/PrintItemsFilterModal';
import { runApprovalPrint } from '@/core/pdf/agent-print-helpers';
import { productSearchText } from '@/core/utils/product-format';
import type { ItemListFilter } from '@/core/pdf/itemListPdf';
import { useAgentStore } from '@/stores/agentStore';
import { useProductStore } from '@/stores/productStore';
import { useCustomerStore } from '@/stores/customerStore';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { useEmployeeStore } from '@/stores/employeeStore';
import type { Agent } from '@/core/models/types';
import { Bhd } from '@/components/ui/Bhd';


interface NewTransferForm {
  customerId?: string;
  productId?: string;
  ourPrice?: number;
  returnBy?: string;
  notes?: string;
  staffId?: string;
}

export function AgentList() {
  const { agents, transfers, loadAgents, loadTransfers, updateAgent, deleteAgent, createTransferForCustomer } = useAgentStore();
  const { products, categories, loadProducts, loadCategories } = useProductStore();
  const { customers, loadCustomers } = useCustomerStore();
  const { invoices, loadInvoices } = useInvoiceStore();
  const { loadEmployees } = useEmployeeStore();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [showNewTransfer, setShowNewTransfer] = useState(false);
  const [showQuickCustomer, setShowQuickCustomer] = useState(false);
  const [tab, setTab] = useState<'agents' | 'transfers'>('agents');
  const [transferForm, setTransferForm] = useState<NewTransferForm>({});
  const [editAgent, setEditAgent] = useState<Agent | null>(null);
  const [editAgentForm, setEditAgentForm] = useState<Partial<Agent>>({});
  const [showPrintAll, setShowPrintAll] = useState(false);

  const staffFilter = searchParams.get('staff') || '';

  useEffect(() => { loadAgents(); loadTransfers(); loadProducts(); loadCategories(); loadCustomers(); loadInvoices(); loadEmployees(); }, [loadAgents, loadTransfers, loadProducts, loadCategories, loadCustomers, loadInvoices, loadEmployees]);

  // Transfer-Picker: Suche + Hover-Preview
  const [transferSearch, setTransferSearch] = useState('');
  const [transferHovered, setTransferHovered] = useState<{ id: string; rect: DOMRect } | null>(null);
  const transferListRef = useRef<HTMLDivElement>(null);

  // Reset Picker-State wenn das Modal aufgemacht / geschlossen wird, damit alte
  // Hover-Karten + Search-Query nicht in die naechste Session leaken.
  useEffect(() => {
    if (!showNewTransfer) {
      setTransferSearch('');
      setTransferHovered(null);
    }
  }, [showNewTransfer]);

  // Duplicate-Check beim Edit (Name/Phone Aenderung) — Agent selbst ausschliessen.
  const agentDuplicateMatches = useMemo(() => {
    if (!editAgent) return [];
    return findSimilarContacts(
      { name: editAgentForm.name, phone: editAgentForm.phone, whatsapp: editAgentForm.whatsapp },
      agents,
      { excludeId: editAgent.id },
    );
  }, [editAgent, editAgentForm.name, editAgentForm.phone, editAgentForm.whatsapp, agents]);

  const filteredTransfers = useMemo(() => {
    if (!staffFilter) return transfers;
    return transfers.filter(t => t.staffId === staffFilter);
  }, [transfers, staffFilter]);

  // Customer-Optionen für Edit-Agent + New-Transfer-Modal
  const customerOptions = useMemo(() => customers.map(c => ({
    id: c.id,
    label: `${c.firstName} ${c.lastName}${c.company ? ` — ${c.company}` : ''}`.trim(),
    subtitle: c.phone || c.email || undefined,
  })), [customers]);

  const availableProducts = useMemo(() => products.filter(p => p.stockStatus === 'in_stock'), [products]);

  // Deep-Match über Brand / Name / SKU / Condition + alle Attribut-Werte —
  // key-agnostisch via productSearchText (gleiche Suche wie Sales/Order/Purchase).
  const filteredTransferProducts = useMemo(() => {
    const q = transferSearch.trim().toLowerCase();
    if (!q) return availableProducts;
    return availableProducts.filter(p => productSearchText(p).includes(q));
  }, [availableProducts, transferSearch]);

  function handleCreateTransfer() {
    if (!transferForm.customerId || !transferForm.productId || !transferForm.ourPrice) return;
    createTransferForCustomer({
      customerId: transferForm.customerId,
      productId: transferForm.productId,
      ourPrice: transferForm.ourPrice,
      returnBy: transferForm.returnBy,
      notes: transferForm.notes,
      staffId: transferForm.staffId,
    });
    setShowNewTransfer(false);
    setTransferForm({});
  }

  return (
    <PageLayout
      title="Approval & Distribution"
      subtitle={`${agents.length} approvals · ${transfers.filter(t => t.status === 'transferred').length} items on approval`}
      actions={
        <div className="flex gap-2 items-center">
          {tab === 'transfers' && <StaffFilterPill />}
          {tab === 'agents' && (
            <Button variant="ghost" onClick={() => setShowPrintAll(true)}>
              <Printer size={14} /> Print All
            </Button>
          )}
          <Button variant="primary" onClick={() => setShowNewTransfer(true)}>New Transfer</Button>
        </div>
      }
    >
      {/* Tabs */}
      <div className="flex gap-1" style={{ marginBottom: 24 }}>
        {(['agents', 'transfers'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className="cursor-pointer transition-all duration-200"
            style={{
              padding: '8px 20px', fontSize: 13, borderRadius: 6,
              border: 'none', background: tab === t ? '#E5E9EE' : 'transparent',
              color: tab === t ? '#0F0F10' : '#6B7280',
            }}>{t === 'agents' ? 'Approvals' : 'Transfers'}</button>
        ))}
      </div>

      {tab === 'agents' ? (
        /* Approval List */
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20 }}>
          {agents.length === 0 && (
            <div style={{ gridColumn: '1 / -1', padding: '64px 0', textAlign: 'center' }}>
              <UserCheck size={40} strokeWidth={1} style={{ color: '#6B7280', margin: '0 auto 16px' }} />
              <p style={{ fontSize: 14, color: '#6B7280' }}>No approvals yet.</p>
            </div>
          )}
          {agents.map(agent => {
            // Plan §Agent Ledger §9: Total Given / Sold / Paid / Outstanding pro Agent.
            const myTransfers = transfers.filter(t => t.agentId === agent.id);
            const activeTransfers = myTransfers.filter(t => t.status === 'transferred');
            const totalGiven = myTransfers
              .filter(t => t.status !== 'returned')
              .reduce((s, t) => s + (t.agentPrice || 0), 0);
            const totalSold = myTransfers
              .filter(t => t.status === 'sold' || t.status === 'settled')
              .reduce((s, t) => s + ((t.actualSalePrice ?? t.agentPrice) || 0), 0);
            const totalPaid = myTransfers.reduce((s, t) => {
              if (t.invoiceId) {
                const inv = invoices.find(i => i.id === t.invoiceId);
                return s + (inv?.paidAmount || 0);
              }
              if (t.settlementStatus === 'paid') {
                return s + ((t.settlementAmount ?? t.actualSalePrice ?? t.agentPrice) || 0);
              }
              if (t.settlementStatus === 'partial') {
                return s + (t.settlementPaidAmount || 0);
              }
              return s;
            }, 0);
            const outstanding = Math.max(0, totalSold - totalPaid);
            // Plan §Agent §Status (User-Spec): Aktiv = mindestens ein Item beim Agent.
            const isActive = activeTransfers.length > 0;
            return (
              <Card key={agent.id} hoverable onClick={() => navigate(`/agents/${agent.id}`)}>
                <div className="flex items-center justify-between" style={{ marginBottom: 12 }}>
                  <h3 style={{ fontSize: 16, color: '#0F0F10', fontWeight: 500 }}>{agent.name}</h3>
                  <span style={{ fontSize: 12, color: isActive ? '#7EAA6E' : '#AA6E6E' }}>
                    {isActive ? 'Active' : 'Inactive'}
                  </span>
                </div>
                {agent.company && <p style={{ fontSize: 12, color: '#6B7280', marginBottom: 8 }}>{agent.company}</p>}
                {agent.phone && <p style={{ fontSize: 12, color: '#4B5563', marginBottom: 4 }}>{agent.phone}</p>}
                <div style={{ borderTop: '1px solid #E5E9EE', marginTop: 12, paddingTop: 12 }}>
                  <div className="flex justify-between" style={{ fontSize: 12, marginBottom: 4 }}>
                    <span style={{ color: '#6B7280' }}>Items with Agent</span>
                    <span style={{ color: '#0F0F10' }}>{activeTransfers.length}</span>
                  </div>
                </div>
                <div style={{ borderTop: '1px solid #E5E9EE', marginTop: 10, paddingTop: 10, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <div>
                    <div style={{ fontSize: 10, color: '#6B7280', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Total Given</div>
                    <div className="font-mono" style={{ fontSize: 13, color: '#0F0F10' }}><Bhd v={totalGiven}/> BHD</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: '#6B7280', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Total Sold</div>
                    <div className="font-mono" style={{ fontSize: 13, color: '#0F0F10' }}><Bhd v={totalSold}/> BHD</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: '#6B7280', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Total Paid</div>
                    <div className="font-mono" style={{ fontSize: 13, color: '#7EAA6E' }}><Bhd v={totalPaid}/> BHD</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: '#6B7280', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Outstanding</div>
                    <div className="font-mono" style={{ fontSize: 13, color: outstanding > 0 ? '#AA6E6E' : '#6B7280' }}><Bhd v={outstanding}/> BHD</div>
                  </div>
                </div>
                <div style={{ borderTop: '1px solid #E5E9EE', marginTop: 10, paddingTop: 8, display: 'flex', justifyContent: 'flex-end' }}>
                  <button onClick={(e) => { e.stopPropagation(); setEditAgent(agent); setEditAgentForm({ ...agent }); }}
                    className="cursor-pointer" style={{ padding: '3px 10px', fontSize: 11, border: '1px solid #D5D9DE', color: '#6B7280', borderRadius: 4, background: 'none' }}>
                    Edit
                  </button>
                </div>
              </Card>
            );
          })}
        </div>
      ) : (
        /* Transfers tab — geteilte Komponente, alle Klienten gemischt */
        <TransferTable transfers={filteredTransfers} showAgentColumn />
      )}

      <PrintItemsFilterModal
        open={showPrintAll}
        onClose={() => setShowPrintAll(false)}
        kind="approval"
        scope="all"
        contextLabel={`${agents.length} agent${agents.length === 1 ? '' : 's'}`}
        onConfirm={(filter: ItemListFilter) => {
          runApprovalPrint({
            filter,
            scope: 'aggregate',
            agents,
            transfers,
            invoices,
            products,
            categories,
          });
        }}
      />

      {/* QuickCustomerModal — vom "+" im Transfer-Modal aufgerufen, um direkt
          einen neuen Customer anzulegen und ihn als Empfänger des Transfers
          auszuwählen. */}
      <QuickCustomerModal open={showQuickCustomer} onClose={() => setShowQuickCustomer(false)}
        onCreated={(id) => {
          loadCustomers();
          setTimeout(() => {
            setTransferForm(f => ({ ...f, customerId: id }));
          }, 50);
        }} />

      {/* New Transfer Modal — vereinfachter Approval-Flow (User-Spec):
          Customer direkt wählen oder neu anlegen. Approval-Account wird
          automatisch beim Speichern erzeugt/aktualisiert. */}
      <Modal open={showNewTransfer} onClose={() => setShowNewTransfer(false)} title="New Transfer" width={520}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Customer Select + New Client */}
          <div>
            <span className="text-overline" style={{ marginBottom: 8, display: 'block' }}>CLIENT</span>
            <div className="flex items-end gap-2">
              <div style={{ flex: 1 }}>
                <SearchSelect
                  placeholder="Search clients..."
                  options={customerOptions}
                  value={transferForm.customerId || ''}
                  onChange={cid => setTransferForm({ ...transferForm, customerId: cid || undefined })}
                />
              </div>
              <button onClick={() => setShowQuickCustomer(true)}
                title="New Client"
                className="cursor-pointer flex items-center justify-center"
                style={{ width: 38, height: 38, borderRadius: 8, border: '1px solid #D5D9DE', background: '#FFFFFF', color: '#0F0F10', fontSize: 18, fontWeight: 300, marginBottom: 2 }}>
                +
              </button>
            </div>
          </div>

          {/* Product Select — mit Suche + Hover-Preview-Card (2026-05-18) */}
          <div>
            <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
              <span className="text-overline">ITEM</span>
              <span style={{ fontSize: 10, color: '#9CA3AF' }}>
                {filteredTransferProducts.length} / {availableProducts.length}
              </span>
            </div>
            <div className="flex items-center gap-2" style={{
              padding: '7px 10px', marginBottom: 6,
              background: '#F2F7FA', border: '1px solid #E5E9EE', borderRadius: 6,
            }}>
              <Search size={13} style={{ color: '#6B7280', flexShrink: 0 }} />
              <input
                value={transferSearch}
                onChange={e => setTransferSearch(e.target.value)}
                placeholder="Search brand, name, SKU, reference, attributes..."
                className="flex-1 outline-none"
                style={{ background: 'transparent', border: 'none', fontSize: 12, color: '#0F0F10' }}
                autoFocus={false}
              />
              {transferSearch && (
                <button
                  onClick={() => setTransferSearch('')}
                  className="cursor-pointer"
                  style={{ background: 'none', border: 'none', color: '#6B7280', fontSize: 11, padding: 0 }}
                  title="Clear"
                >
                  ×
                </button>
              )}
            </div>
            <div
              ref={transferListRef}
              style={{ maxHeight: 220, overflowY: 'auto' }}
              onMouseLeave={() => setTransferHovered(null)}
            >
              {filteredTransferProducts.length === 0 ? (
                <div style={{ padding: '16px 10px', fontSize: 12, color: '#9CA3AF', textAlign: 'center' }}>
                  {transferSearch ? 'No items match.' : 'No items in stock.'}
                </div>
              ) : filteredTransferProducts.map(p => (
                <div
                  key={p.id}
                  onClick={() => setTransferForm({ ...transferForm, productId: p.id, ourPrice: p.plannedSalePrice || p.purchasePrice })}
                  onMouseEnter={e => {
                    setTransferHovered({ id: p.id, rect: (e.currentTarget as HTMLDivElement).getBoundingClientRect() });
                  }}
                  className="cursor-pointer rounded transition-colors"
                  style={{
                    padding: '8px 10px', marginBottom: 2,
                    background: transferForm.productId === p.id ? 'rgba(15,15,16,0.06)' : 'transparent',
                    border: `1px solid ${transferForm.productId === p.id ? '#0F0F10' : 'transparent'}`,
                  }}>
                  <div className="flex justify-between items-center">
                    <div style={{ minWidth: 0, flex: 1, paddingRight: 8 }}>
                      <div style={{ fontSize: 13, color: '#0F0F10', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {p.brand} {p.name}
                      </div>
                      {p.sku && (
                        <div className="font-mono" style={{ fontSize: 10, color: '#9CA3AF', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {p.sku}
                        </div>
                      )}
                    </div>
                    <span className="font-mono" style={{ fontSize: 12, color: '#4B5563', flexShrink: 0 }}>
                      <Bhd v={p.plannedSalePrice || p.purchasePrice}/> BHD
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <Input required label="OUR PRICE (BHD)" type="number" placeholder="Vereinbarter Betrag, den wir bekommen möchten"
            value={transferForm.ourPrice || ''}
            onChange={e => setTransferForm({ ...transferForm, ourPrice: Number(e.target.value) || undefined })} />

          <Input label="RETURN BY (DATE)" type="date" value={transferForm.returnBy || ''} onChange={e => setTransferForm({ ...transferForm, returnBy: e.target.value })} />

          <StaffSelect value={transferForm.staffId || ''} onChange={(id) => setTransferForm({ ...transferForm, staffId: id || undefined })}
            helper="Who handed over this item (optional)." />

          <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setShowNewTransfer(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleCreateTransfer}
              disabled={!transferForm.customerId || !transferForm.productId || !transferForm.ourPrice}>
              Transfer Item
            </Button>
          </div>
        </div>

        {/* Hover-Preview-Karte: anchored an der gehoverten Row, fixed positioning
            via Portal damit overflow:hidden im Modal die Karte nicht abschneidet.
            Bevorzugt rechts vom Modal, faellt nach links wenn kein Platz. */}
        {showNewTransfer && transferHovered && createPortal(
          (() => {
            const product = availableProducts.find(p => p.id === transferHovered.id);
            if (!product) return null;
            const PREVIEW_W = 320;
            const r = transferHovered.rect;
            const spaceRight = window.innerWidth - r.right - 16;
            const placeRight = spaceRight >= PREVIEW_W + 8;
            const left = placeRight
              ? r.right + 8
              : Math.max(8, r.left - PREVIEW_W - 8);
            const maxTop = window.innerHeight - 360;
            const top = Math.max(16, Math.min(maxTop, r.top));
            return (
              <div style={{
                position: 'fixed',
                top, left, width: PREVIEW_W,
                zIndex: 100001,
                pointerEvents: 'none',
              }}>
                <ProductHoverCard product={product} categories={categories} />
              </div>
            );
          })(),
          document.body
        )}
      </Modal>

      {/* Edit Agent Modal */}
      <Modal open={!!editAgent} onClose={() => setEditAgent(null)} title={`Edit Approval — ${editAgent?.name || ''}`} width={480}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {agentDuplicateMatches.length > 0 && (
            <DuplicateWarningBanner
              matches={agentDuplicateMatches}
              entityLabel="approval / agent"
            />
          )}
          <Input required label="NAME" value={editAgentForm.name || ''} onChange={e => setEditAgentForm({ ...editAgentForm, name: e.target.value })} />
          <Input label="COMPANY" value={editAgentForm.company || ''} onChange={e => setEditAgentForm({ ...editAgentForm, company: e.target.value })} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <PhoneInput label="PHONE" value={editAgentForm.phone || ''} onChange={v => setEditAgentForm({ ...editAgentForm, phone: v })} />
            <PhoneInput label="WHATSAPP" value={editAgentForm.whatsapp || ''} onChange={v => setEditAgentForm({ ...editAgentForm, whatsapp: v })} />
          </div>
          <Input label="EMAIL" value={editAgentForm.email || ''} onChange={e => setEditAgentForm({ ...editAgentForm, email: e.target.value })} />
          <div>
            <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>STATUS</span>
            <div className="flex gap-2">
              {[true, false].map(v => (
                <button key={String(v)} onClick={() => setEditAgentForm({ ...editAgentForm, active: v })}
                  className="cursor-pointer rounded"
                  style={{ padding: '7px 14px', fontSize: 12,
                    border: `1px solid ${(editAgentForm.active ?? true) === v ? '#0F0F10' : '#D5D9DE'}`,
                    color: (editAgentForm.active ?? true) === v ? '#0F0F10' : '#6B7280',
                    background: (editAgentForm.active ?? true) === v ? 'rgba(15,15,16,0.06)' : 'transparent',
                  }}>{v ? 'Active' : 'Inactive'}</button>
              ))}
            </div>
          </div>
          <div>
            <SearchSelect
              label="LINKED CUSTOMER (für Convert-to-Invoice)"
              placeholder="Pick existing customer (optional)…"
              options={customerOptions}
              value={editAgentForm.customerId || ''}
              onChange={cid => setEditAgentForm({ ...editAgentForm, customerId: cid || undefined })}
            />
            <p style={{ fontSize: 11, color: '#6B7280', marginTop: 4 }}>
              Wird beim ersten Convert automatisch gesetzt. Hier nur ändern wenn nötig.
            </p>
          </div>
          <div>
            <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>NOTES</span>
            <textarea value={editAgentForm.notes || ''}
              onChange={e => setEditAgentForm({ ...editAgentForm, notes: e.target.value })}
              rows={3}
              style={{ width: '100%', background: 'transparent', border: '1px solid #D5D9DE', borderRadius: 6, padding: '8px 10px', fontSize: 13, color: '#0F0F10' }} />
          </div>
          <div className="flex justify-between gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="danger" onClick={() => {
              if (editAgent && window.confirm(`Delete approval "${editAgent.name}"?`)) {
                deleteAgent(editAgent.id);
                setEditAgent(null);
              }
            }}>Delete</Button>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setEditAgent(null)}>Cancel</Button>
              <Button variant="primary" onClick={() => {
                if (!editAgent) return;
                updateAgent(editAgent.id, editAgentForm);
                setEditAgent(null);
              }}>Save</Button>
            </div>
          </div>
        </div>
      </Modal>
    </PageLayout>
  );
}
