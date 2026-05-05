import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { UserCheck } from 'lucide-react';
import { PageLayout } from '@/components/layout/PageLayout';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { QuickCustomerModal } from '@/components/customers/QuickCustomerModal';
import { TransferTable } from '@/components/agents/TransferTable';
import { useAgentStore } from '@/stores/agentStore';
import { useProductStore } from '@/stores/productStore';
import { useCustomerStore } from '@/stores/customerStore';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { HistoryDrawer } from '@/components/shared/HistoryPanel';
import type { Agent, AgentTransfer } from '@/core/models/types';

function fmt(v: number): string {
  return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export function AgentList() {
  const { agents, transfers, loadAgents, loadTransfers, createAgent, updateAgent, deleteAgent, createTransfer } = useAgentStore();
  const { products, loadProducts } = useProductStore();
  const { customers, loadCustomers } = useCustomerStore();
  const { invoices, loadInvoices } = useInvoiceStore();
  const navigate = useNavigate();
  const [showNewAgent, setShowNewAgent] = useState(false);
  const [showNewTransfer, setShowNewTransfer] = useState(false);
  const [showQuickCustomer, setShowQuickCustomer] = useState(false);
  const [tab, setTab] = useState<'agents' | 'transfers'>('agents');
  const [agentForm, setAgentForm] = useState<Partial<Agent>>({ commissionRate: 10 });
  const [transferForm, setTransferForm] = useState<Partial<AgentTransfer> & { agentId?: string; productId?: string }>({ commissionRate: 10 });
  const [historyAgentId, setHistoryAgentId] = useState<string | null>(null);
  const [editAgent, setEditAgent] = useState<Agent | null>(null);
  const [editAgentForm, setEditAgentForm] = useState<Partial<Agent>>({});

  useEffect(() => { loadAgents(); loadTransfers(); loadProducts(); loadCustomers(); loadInvoices(); }, [loadAgents, loadTransfers, loadProducts, loadCustomers, loadInvoices]);

  // Customer-Optionen für Edit-Agent-Modal (Linked-Customer-Feld)
  const customerOptions = useMemo(() => customers.map(c => ({
    id: c.id,
    label: `${c.firstName} ${c.lastName}${c.company ? ` — ${c.company}` : ''}`.trim(),
    subtitle: c.phone || c.email || undefined,
  })), [customers]);

  const availableProducts = useMemo(() => products.filter(p => p.stockStatus === 'in_stock'), [products]);

  function handleCreateAgent() {
    if (!agentForm.name) return;
    createAgent(agentForm);
    setShowNewAgent(false);
    setAgentForm({ commissionRate: 10 });
  }

  function handleCreateTransfer() {
    if (!transferForm.agentId || !transferForm.productId) return;
    createTransfer(transferForm);
    setShowNewTransfer(false);
    setTransferForm({ commissionRate: 10 });
  }

  return (
    <PageLayout
      title="Approval & Distribution"
      subtitle={`${agents.length} approvals · ${transfers.filter(t => t.status === 'transferred').length} items on approval`}
      actions={
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setShowNewTransfer(true)}>New Transfer</Button>
          <Button variant="primary" onClick={() => setShowNewAgent(true)}>New Approval</Button>
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
                    <span style={{ color: '#6B7280' }}>Commission Rate</span>
                    <span style={{ color: '#0F0F10' }}>{agent.commissionRate}%</span>
                  </div>
                  <div className="flex justify-between" style={{ fontSize: 12, marginBottom: 4 }}>
                    <span style={{ color: '#6B7280' }}>Items with Agent</span>
                    <span style={{ color: '#0F0F10' }}>{activeTransfers.length}</span>
                  </div>
                </div>
                <div style={{ borderTop: '1px solid #E5E9EE', marginTop: 10, paddingTop: 10, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <div>
                    <div style={{ fontSize: 10, color: '#6B7280', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Total Given</div>
                    <div className="font-mono" style={{ fontSize: 13, color: '#0F0F10' }}>{fmt(totalGiven)} BHD</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: '#6B7280', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Total Sold</div>
                    <div className="font-mono" style={{ fontSize: 13, color: '#0F0F10' }}>{fmt(totalSold)} BHD</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: '#6B7280', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Total Paid</div>
                    <div className="font-mono" style={{ fontSize: 13, color: '#7EAA6E' }}>{fmt(totalPaid)} BHD</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: '#6B7280', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Outstanding</div>
                    <div className="font-mono" style={{ fontSize: 13, color: outstanding > 0 ? '#AA6E6E' : '#6B7280' }}>{fmt(outstanding)} BHD</div>
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
        <TransferTable transfers={transfers} showAgentColumn />
      )}

      {/* New Approval Modal — Customer-Picker oder neuer Customer (User-Spec) */}
      <Modal open={showNewAgent} onClose={() => setShowNewAgent(false)} title="New Approval" width={480}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{
            padding: '8px 12px', borderRadius: 8, background: '#F2F7FA',
            border: '1px solid #E5E9EE', color: '#6B7280', fontSize: 12, lineHeight: 1.5,
          }}>
            <strong style={{ color: '#0F0F10' }}>Bestehenden Client wählen</strong> oder mit dem Plus einen neuen anlegen.
            Name, Company, Phone und Email werden vom Customer übernommen.
          </div>

          <div className="flex items-end gap-2">
            <div style={{ flex: 1 }}>
              <SearchSelect
                label="CLIENT"
                placeholder="Search clients..."
                options={customerOptions}
                value={agentForm.customerId || ''}
                onChange={cid => {
                  const c = customers.find(cc => cc.id === cid);
                  if (c) {
                    const fullName = `${c.firstName || ''} ${c.lastName || ''}`.trim() || c.firstName || c.lastName || 'Client';
                    setAgentForm({
                      ...agentForm,
                      customerId: c.id,
                      name: fullName,
                      company: c.company,
                      phone: c.phone,
                      whatsapp: c.whatsapp,
                      email: c.email,
                    });
                  } else {
                    setAgentForm({ ...agentForm, customerId: undefined });
                  }
                }}
              />
            </div>
            <button onClick={() => setShowQuickCustomer(true)}
              title="New Client"
              className="cursor-pointer flex items-center justify-center"
              style={{ width: 38, height: 38, borderRadius: 8, border: '1px solid #D5D9DE', background: '#FFFFFF', color: '#0F0F10', fontSize: 18, fontWeight: 300, marginBottom: 2 }}>
              +
            </button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Input label="COMMISSION %" type="number" value={agentForm.commissionRate || ''} onChange={e => setAgentForm({ ...agentForm, commissionRate: Number(e.target.value) })} />
            <Input label="PHONE (override)" placeholder={agentForm.phone || ''} value={agentForm.phone || ''} onChange={e => setAgentForm({ ...agentForm, phone: e.target.value })} />
          </div>

          {agentForm.customerId && (
            <div style={{ padding: '10px 14px', background: '#F7F5EE', borderRadius: 8, fontSize: 12 }}>
              <div style={{ color: '#6B7280', marginBottom: 4 }}>SELECTED</div>
              <div style={{ color: '#0F0F10' }}>{agentForm.name}{agentForm.company ? ` · ${agentForm.company}` : ''}</div>
              {agentForm.phone && <div style={{ color: '#4B5563', fontSize: 11, marginTop: 2 }}>{agentForm.phone}</div>}
            </div>
          )}

          <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setShowNewAgent(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleCreateAgent} disabled={!agentForm.name}>Create Approval</Button>
          </div>
        </div>
      </Modal>

      {/* QuickCustomerModal — wird vom + bei Client benutzt */}
      <QuickCustomerModal open={showQuickCustomer} onClose={() => setShowQuickCustomer(false)}
        onCreated={(id) => {
          loadCustomers();
          setTimeout(() => {
            const fresh = useCustomerStore.getState().customers.find(c => c.id === id);
            if (fresh) {
              const fullName = `${fresh.firstName || ''} ${fresh.lastName || ''}`.trim() || 'Client';
              setAgentForm(f => ({
                ...f,
                customerId: fresh.id,
                name: fullName,
                company: fresh.company,
                phone: fresh.phone,
                whatsapp: fresh.whatsapp,
                email: fresh.email,
              }));
            }
          }, 50);
        }} />

      {/* New Transfer Modal */}
      <Modal open={showNewTransfer} onClose={() => setShowNewTransfer(false)} title="New Transfer" width={520}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Approval Select */}
          <div>
            <span className="text-overline" style={{ marginBottom: 8 }}>APPROVAL</span>
            <div className="flex flex-wrap gap-2" style={{ marginTop: 8 }}>
              {agents.filter(a => a.active).map(a => (
                <button key={a.id} onClick={() => setTransferForm({ ...transferForm, agentId: a.id, commissionRate: a.commissionRate })}
                  className="cursor-pointer rounded transition-all" style={{
                    padding: '6px 14px', fontSize: 12,
                    border: `1px solid ${transferForm.agentId === a.id ? '#0F0F10' : '#D5D9DE'}`,
                    color: transferForm.agentId === a.id ? '#0F0F10' : '#6B7280',
                    background: transferForm.agentId === a.id ? 'rgba(15,15,16,0.06)' : 'transparent',
                  }}>{a.name}</button>
              ))}
            </div>
          </div>
          {/* Product Select */}
          <div>
            <span className="text-overline" style={{ marginBottom: 8 }}>ITEM</span>
            <div style={{ maxHeight: 200, overflowY: 'auto', marginTop: 8 }}>
              {availableProducts.map(p => (
                <div key={p.id} onClick={() => setTransferForm({ ...transferForm, productId: p.id, agentPrice: p.plannedSalePrice || p.purchasePrice })}
                  className="cursor-pointer rounded transition-colors" style={{
                    padding: '8px 10px', marginBottom: 2,
                    background: transferForm.productId === p.id ? 'rgba(15,15,16,0.06)' : 'transparent',
                    border: `1px solid ${transferForm.productId === p.id ? '#0F0F10' : 'transparent'}`,
                  }}>
                  <div className="flex justify-between">
                    <span style={{ fontSize: 13, color: '#0F0F10' }}>{p.brand} {p.name}</span>
                    <span className="font-mono" style={{ fontSize: 12, color: '#4B5563' }}>{fmt(p.plannedSalePrice || p.purchasePrice)} BHD</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div>
            <span className="text-overline" style={{ marginBottom: 6 }}>COMMISSION TYPE</span>
            <div className="flex gap-2" style={{ marginTop: 6 }}>
              {(['percent', 'fixed'] as const).map(t => {
                const active = (transferForm.commissionType ?? 'percent') === t;
                return (
                  <button key={t} type="button" onClick={() => setTransferForm({ ...transferForm, commissionType: t })}
                    className="cursor-pointer rounded transition-all"
                    style={{ padding: '7px 14px', fontSize: 12,
                      border: `1px solid ${active ? '#0F0F10' : '#D5D9DE'}`,
                      color: active ? '#0F0F10' : '#6B7280',
                      background: active ? 'rgba(15,15,16,0.06)' : 'transparent',
                    }}>{t === 'percent' ? 'Percent of sale' : 'Fixed per item'}</button>
                );
              })}
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Input required label="AGENT PRICE (BHD)" type="number" value={transferForm.agentPrice || ''} onChange={e => setTransferForm({ ...transferForm, agentPrice: Number(e.target.value) })} />
            {(transferForm.commissionType ?? 'percent') === 'percent' ? (
              <Input required label="COMMISSION %" type="number" value={transferForm.commissionRate || ''} onChange={e => setTransferForm({ ...transferForm, commissionRate: Number(e.target.value) })} />
            ) : (
              <Input required label="COMMISSION FIXED (BHD)" type="number" value={transferForm.commissionValue || ''} onChange={e => setTransferForm({ ...transferForm, commissionValue: Number(e.target.value) })} />
            )}
          </div>
          <Input label="RETURN BY (DATE)" type="date" value={transferForm.returnBy || ''} onChange={e => setTransferForm({ ...transferForm, returnBy: e.target.value })} />
          <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setShowNewTransfer(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleCreateTransfer}>Transfer Item</Button>
          </div>
        </div>
      </Modal>

      {/* Edit Agent Modal */}
      <Modal open={!!editAgent} onClose={() => setEditAgent(null)} title={`Edit Approval — ${editAgent?.name || ''}`} width={480}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Input required label="NAME" value={editAgentForm.name || ''} onChange={e => setEditAgentForm({ ...editAgentForm, name: e.target.value })} />
          <Input label="COMPANY" value={editAgentForm.company || ''} onChange={e => setEditAgentForm({ ...editAgentForm, company: e.target.value })} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Input label="PHONE" value={editAgentForm.phone || ''} onChange={e => setEditAgentForm({ ...editAgentForm, phone: e.target.value })} />
            <Input label="WHATSAPP" value={editAgentForm.whatsapp || ''} onChange={e => setEditAgentForm({ ...editAgentForm, whatsapp: e.target.value })} />
          </div>
          <Input label="EMAIL" value={editAgentForm.email || ''} onChange={e => setEditAgentForm({ ...editAgentForm, email: e.target.value })} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Input required label="COMMISSION %" type="number" value={editAgentForm.commissionRate ?? ''}
              onChange={e => setEditAgentForm({ ...editAgentForm, commissionRate: Number(e.target.value) || 0 })} />
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

      {/* Agent History Drawer */}
      <HistoryDrawer
        open={!!historyAgentId}
        onClose={() => setHistoryAgentId(null)}
        entityType="agents"
        entityId={historyAgentId || ''}
        title="Agent History"
      />
    </PageLayout>
  );
}
