import { useEffect, useMemo, useState } from 'react';
import { UserCheck } from 'lucide-react';
import { PageLayout } from '@/components/layout/PageLayout';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { StatusDot } from '@/components/ui/StatusDot';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { useAgentStore } from '@/stores/agentStore';
import { useProductStore } from '@/stores/productStore';
import { HistoryDrawer } from '@/components/shared/HistoryPanel';
import type { Agent, AgentTransfer } from '@/core/models/types';

function fmt(v: number): string {
  return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export function AgentList() {
  const { agents, transfers, loadAgents, loadTransfers, createAgent, updateAgent, deleteAgent, createTransfer, updateTransfer, markTransferSold, markTransferReturned, markTransferSettled, deleteTransfer } = useAgentStore();
  const { products, loadProducts } = useProductStore();
  const [showNewAgent, setShowNewAgent] = useState(false);
  const [showNewTransfer, setShowNewTransfer] = useState(false);
  const [tab, setTab] = useState<'agents' | 'transfers'>('agents');
  const [agentForm, setAgentForm] = useState<Partial<Agent>>({ commissionRate: 10 });
  const [transferForm, setTransferForm] = useState<Partial<AgentTransfer> & { agentId?: string; productId?: string }>({ commissionRate: 10 });
  const [filterStatus, setFilterStatus] = useState('');
  const [soldModal, setSoldModal] = useState<string | null>(null);
  const [soldPrice, setSoldPrice] = useState(0);
  const [soldBuyerInfo, setSoldBuyerInfo] = useState('');
  const [settleModal, setSettleModal] = useState<string | null>(null);
  const [settleMethod, setSettleMethod] = useState<'cash' | 'bank'>('cash');
  const [settleAmount, setSettleAmount] = useState<string>('');
  const [settlePartial, setSettlePartial] = useState(false);
  const [historyAgentId, setHistoryAgentId] = useState<string | null>(null);
  const [historyTransferId, setHistoryTransferId] = useState<string | null>(null);
  const [editAgent, setEditAgent] = useState<Agent | null>(null);
  const [editAgentForm, setEditAgentForm] = useState<Partial<Agent>>({});
  const [editTransfer, setEditTransfer] = useState<AgentTransfer | null>(null);
  const [editTransferForm, setEditTransferForm] = useState<Partial<AgentTransfer>>({});

  useEffect(() => { loadAgents(); loadTransfers(); loadProducts(); }, [loadAgents, loadTransfers, loadProducts]);

  const availableProducts = useMemo(() => products.filter(p => p.stockStatus === 'in_stock'), [products]);

  const filteredTransfers = useMemo(() => {
    if (!filterStatus) return transfers;
    return transfers.filter(t => t.status === filterStatus);
  }, [transfers, filterStatus]);

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
      subtitle={`${agents.length} approvals \u00b7 ${transfers.filter(t => t.status === 'transferred').length} items on approval`}
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
              border: 'none', background: tab === t ? '#E5E1D6' : 'transparent',
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
            // Plan §Agent §4: berücksichtigt Teilzahlungen via settlementPaidAmount
            const totalPaid = myTransfers.reduce((s, t) => {
              if (t.settlementStatus === 'paid') {
                return s + ((t.settlementAmount ?? t.actualSalePrice ?? t.agentPrice) || 0);
              }
              if (t.settlementStatus === 'partial') {
                return s + (t.settlementPaidAmount || 0);
              }
              return s;
            }, 0);
            const outstanding = Math.max(0, totalSold - totalPaid);
            return (
              <Card key={agent.id} hoverable onClick={() => { setEditAgent(agent); setEditAgentForm({ ...agent }); }}>
                <div className="flex items-center justify-between" style={{ marginBottom: 12 }}>
                  <h3 style={{ fontSize: 16, color: '#0F0F10', fontWeight: 500 }}>{agent.name}</h3>
                  <span style={{ fontSize: 12, color: agent.active ? '#7EAA6E' : '#AA6E6E' }}>
                    {agent.active ? 'Active' : 'Inactive'}
                  </span>
                </div>
                {agent.company && <p style={{ fontSize: 12, color: '#6B7280', marginBottom: 8 }}>{agent.company}</p>}
                {agent.phone && <p style={{ fontSize: 12, color: '#4B5563', marginBottom: 4 }}>{agent.phone}</p>}
                <div style={{ borderTop: '1px solid #E5E1D6', marginTop: 12, paddingTop: 12 }}>
                  <div className="flex justify-between" style={{ fontSize: 12, marginBottom: 4 }}>
                    <span style={{ color: '#6B7280' }}>Commission Rate</span>
                    <span style={{ color: '#0F0F10' }}>{agent.commissionRate}%</span>
                  </div>
                  <div className="flex justify-between" style={{ fontSize: 12, marginBottom: 4 }}>
                    <span style={{ color: '#6B7280' }}>Items with Agent</span>
                    <span style={{ color: '#0F0F10' }}>{activeTransfers.length}</span>
                  </div>
                </div>
                <div style={{ borderTop: '1px solid #E5E1D6', marginTop: 10, paddingTop: 10, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
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
              </Card>
            );
          })}
        </div>
      ) : (
        /* Transfer List */
        <>
          <div className="flex gap-1" style={{ marginBottom: 16 }}>
            {['', 'transferred', 'sold', 'returned', 'settled'].map(s => (
              <button key={s} onClick={() => setFilterStatus(s)}
                className="cursor-pointer" style={{
                  padding: '5px 12px', fontSize: 11, borderRadius: 999, border: 'none',
                  background: filterStatus === s ? 'rgba(15,15,16,0.08)' : 'transparent',
                  color: filterStatus === s ? '#0F0F10' : '#6B7280',
                }}>{s || 'All'}</button>
            ))}
          </div>

          {/* Plan §Agent Ledger §10: Datum / Dokument (AGD/INV) / Betrag / Zahlung / Restbetrag */}
          <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr 1fr 1.3fr 0.9fr 0.9fr 0.9fr 0.8fr 1.2fr', gap: 12, padding: '0 12px 10px' }}>
            {['DATE', 'DOCUMENT', 'AGENT', 'ITEM', 'AMOUNT', 'PAID', 'OUTSTANDING', 'STATUS', 'ACTIONS'].map(h => (
              <span key={h} className="text-overline">{h}</span>
            ))}
          </div>
          <div style={{ borderTop: '1px solid #E5E1D6' }} />

          {filteredTransfers.length === 0 && (
            <div style={{ padding: '48px 0', textAlign: 'center', fontSize: 13, color: '#6B7280' }}>No transfers found.</div>
          )}

          {filteredTransfers.map(t => {
            const agent = agents.find(a => a.id === t.agentId);
            const product = products.find(p => p.id === t.productId);
            const amount = (t.settlementAmount ?? t.actualSalePrice ?? t.agentPrice) || 0;
            const paid = t.settlementStatus === 'paid'
              ? (t.settlementAmount ?? amount)
              : (t.settlementStatus === 'partial' ? (t.settlementPaidAmount || 0) : 0);
            const outstanding = Math.max(0, amount - paid);
            const date = (t.transferredAt || t.createdAt || '').split('T')[0];
            const docLabel = t.invoiceId ? `${t.transferNumber} → INV` : t.transferNumber;
            return (
              <div key={t.id} style={{
                display: 'grid', gridTemplateColumns: '90px 1fr 1fr 1.3fr 0.9fr 0.9fr 0.9fr 0.8fr 1.2fr',
                gap: 12, padding: '12px', alignItems: 'center', borderBottom: '1px solid rgba(229,225,214,0.6)',
              }}>
                <span style={{ fontSize: 11, color: '#6B7280' }}>{date || '—'}</span>
                <span className="font-mono" style={{ fontSize: 11, color: '#4B5563' }}>{docLabel}</span>
                <span style={{ fontSize: 12, color: '#0F0F10' }}>{agent?.name || '—'}</span>
                <span style={{ fontSize: 12, color: '#0F0F10', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{product ? `${product.brand} ${product.name}` : '—'}</span>
                <span className="font-mono" style={{ fontSize: 12, color: '#0F0F10' }}>{fmt(amount)}</span>
                <span className="font-mono" style={{ fontSize: 12, color: paid > 0 ? '#7EAA6E' : '#6B7280' }}>{fmt(paid)}</span>
                <span className="font-mono" style={{ fontSize: 12, color: outstanding > 0 ? '#AA6E6E' : '#6B7280' }}>{fmt(outstanding)}</span>
                <StatusDot status={t.status} />
                <div className="flex gap-1">
                  {t.status === 'transferred' && (
                    <>
                      <button onClick={() => { setSoldModal(t.id); setSoldPrice(t.agentPrice); setSoldBuyerInfo(''); }}
                        className="cursor-pointer" style={{ padding: '3px 8px', fontSize: 11, border: '1px solid #7EAA6E', color: '#7EAA6E', borderRadius: 4, background: 'none' }}>Sold</button>
                      <button onClick={() => markTransferReturned(t.id)}
                        className="cursor-pointer" style={{ padding: '3px 8px', fontSize: 11, border: '1px solid #6B7280', color: '#6B7280', borderRadius: 4, background: 'none' }}>Return</button>
                    </>
                  )}
                  {(t.status === 'sold' || t.settlementStatus === 'partial') && (
                    <button onClick={() => {
                      setSettleModal(t.id); setSettleMethod('cash');
                      setSettlePartial(false);
                      setSettleAmount(String(Math.max(0, amount - paid).toFixed(2)));
                    }}
                      className="cursor-pointer" style={{ padding: '3px 8px', fontSize: 11, border: '1px solid #0F0F10', color: '#0F0F10', borderRadius: 4, background: 'none' }}>
                      {t.settlementStatus === 'partial' ? 'Pay More' : 'Settle'}
                    </button>
                  )}
                  <button onClick={() => { setEditTransfer(t); setEditTransferForm({ ...t }); }}
                    className="cursor-pointer" style={{ padding: '3px 8px', fontSize: 11, border: '1px solid #D5D1C4', color: '#0F0F10', borderRadius: 4, background: 'none' }}>
                    Edit
                  </button>
                  <button onClick={() => setHistoryTransferId(t.id)}
                    className="cursor-pointer" style={{ padding: '3px 8px', fontSize: 11, border: '1px solid #D5D1C4', color: '#6B7280', borderRadius: 4, background: 'none' }}>
                    History
                  </button>
                </div>
              </div>
            );
          })}
        </>
      )}

      {/* New Approval Modal */}
      <Modal open={showNewAgent} onClose={() => setShowNewAgent(false)} title="New Approval" width={480}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Input label="NAME" placeholder="Approval name" value={agentForm.name || ''} onChange={e => setAgentForm({ ...agentForm, name: e.target.value })} />
          <Input label="COMPANY" placeholder="Company" value={agentForm.company || ''} onChange={e => setAgentForm({ ...agentForm, company: e.target.value })} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Input label="PHONE" placeholder="+973..." value={agentForm.phone || ''} onChange={e => setAgentForm({ ...agentForm, phone: e.target.value })} />
            <Input label="COMMISSION %" type="number" value={agentForm.commissionRate || ''} onChange={e => setAgentForm({ ...agentForm, commissionRate: Number(e.target.value) })} />
          </div>
          <Input label="EMAIL" placeholder="email" value={agentForm.email || ''} onChange={e => setAgentForm({ ...agentForm, email: e.target.value })} />
          <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E1D6' }}>
            <Button variant="ghost" onClick={() => setShowNewAgent(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleCreateAgent}>Create Approval</Button>
          </div>
        </div>
      </Modal>

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
                    border: `1px solid ${transferForm.agentId === a.id ? '#0F0F10' : '#D5D1C4'}`,
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
                      border: `1px solid ${active ? '#0F0F10' : '#D5D1C4'}`,
                      color: active ? '#0F0F10' : '#6B7280',
                      background: active ? 'rgba(15,15,16,0.06)' : 'transparent',
                    }}>{t === 'percent' ? 'Percent of sale' : 'Fixed per item'}</button>
                );
              })}
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Input label="AGENT PRICE (BHD)" type="number" value={transferForm.agentPrice || ''} onChange={e => setTransferForm({ ...transferForm, agentPrice: Number(e.target.value) })} />
            {(transferForm.commissionType ?? 'percent') === 'percent' ? (
              <Input label="COMMISSION %" type="number" value={transferForm.commissionRate || ''} onChange={e => setTransferForm({ ...transferForm, commissionRate: Number(e.target.value) })} />
            ) : (
              <Input label="COMMISSION FIXED (BHD)" type="number" value={transferForm.commissionValue || ''} onChange={e => setTransferForm({ ...transferForm, commissionValue: Number(e.target.value) })} />
            )}
          </div>
          <Input label="RETURN BY (DATE)" type="date" value={transferForm.returnBy || ''} onChange={e => setTransferForm({ ...transferForm, returnBy: e.target.value })} />
          <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E1D6' }}>
            <Button variant="ghost" onClick={() => setShowNewTransfer(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleCreateTransfer}>Transfer Item</Button>
          </div>
        </div>
      </Modal>
      {/* Settle Modal — Plan §Agent §4: Full oder Partial Payment */}
      <Modal open={!!settleModal} onClose={() => setSettleModal(null)} title="Settle with Agent" width={420}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {settleModal && (() => {
            const t = transfers.find(x => x.id === settleModal);
            if (!t) return null;
            const amount = (t.settlementAmount ?? t.actualSalePrice ?? t.agentPrice) || 0;
            const prevPaid = t.settlementStatus === 'partial' ? (t.settlementPaidAmount || 0) : 0;
            const remaining = Math.max(0, amount - prevPaid);
            return (
              <div style={{ padding: '10px 14px', background: '#F7F5EE', borderRadius: 8, fontSize: 12 }}>
                <div className="flex justify-between" style={{ marginBottom: 4 }}>
                  <span style={{ color: '#6B7280' }}>Total</span>
                  <span className="font-mono" style={{ color: '#0F0F10' }}>{fmt(amount)} BHD</span>
                </div>
                <div className="flex justify-between" style={{ marginBottom: 4 }}>
                  <span style={{ color: '#6B7280' }}>Already Paid</span>
                  <span className="font-mono" style={{ color: '#16A34A' }}>{fmt(prevPaid)} BHD</span>
                </div>
                <div className="flex justify-between">
                  <span style={{ color: '#6B7280' }}>Remaining</span>
                  <span className="font-mono" style={{ color: '#DC2626' }}>{fmt(remaining)} BHD</span>
                </div>
              </div>
            );
          })()}
          <div>
            <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>PAYMENT TYPE</span>
            <div className="flex gap-2">
              {[
                { id: false, label: 'Full Payment' },
                { id: true, label: 'Partial Payment' },
              ].map(o => (
                <button key={String(o.id)} onClick={() => setSettlePartial(o.id)}
                  className="cursor-pointer rounded"
                  style={{ padding: '7px 14px', fontSize: 12,
                    border: `1px solid ${settlePartial === o.id ? '#0F0F10' : '#D5D1C4'}`,
                    color: settlePartial === o.id ? '#0F0F10' : '#6B7280',
                    background: settlePartial === o.id ? 'rgba(15,15,16,0.06)' : 'transparent',
                  }}>{o.label}</button>
              ))}
            </div>
          </div>
          {settlePartial && (
            <Input label="AMOUNT (BHD)" type="number" value={settleAmount}
              onChange={e => setSettleAmount(e.target.value)} />
          )}
          <div>
            <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>PAID FROM</span>
            <div className="flex gap-2">
              {(['cash', 'bank'] as const).map(m => (
                <button key={m} onClick={() => setSettleMethod(m)}
                  className="cursor-pointer rounded transition-all"
                  style={{ padding: '8px 16px', fontSize: 13,
                    border: `1px solid ${settleMethod === m ? '#0F0F10' : '#D5D1C4'}`,
                    color: settleMethod === m ? '#0F0F10' : '#6B7280',
                    background: settleMethod === m ? 'rgba(15,15,16,0.06)' : 'transparent',
                  }}>{m === 'cash' ? 'Cash' : 'Bank'}</button>
              ))}
            </div>
          </div>
          <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E1D6' }}>
            <Button variant="ghost" onClick={() => setSettleModal(null)}>Cancel</Button>
            <Button variant="primary" onClick={() => {
              if (!settleModal) return;
              const amt = settlePartial ? parseFloat(settleAmount) : undefined;
              if (settlePartial && (!amt || amt <= 0)) return;
              markTransferSettled(settleModal, amt, settleMethod);
              setSettleModal(null);
            }}>Confirm</Button>
          </div>
        </div>
      </Modal>

      {/* Edit Agent Modal */}
      <Modal open={!!editAgent} onClose={() => setEditAgent(null)} title={`Edit Approval — ${editAgent?.name || ''}`} width={480}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Input label="NAME" value={editAgentForm.name || ''} onChange={e => setEditAgentForm({ ...editAgentForm, name: e.target.value })} />
          <Input label="COMPANY" value={editAgentForm.company || ''} onChange={e => setEditAgentForm({ ...editAgentForm, company: e.target.value })} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Input label="PHONE" value={editAgentForm.phone || ''} onChange={e => setEditAgentForm({ ...editAgentForm, phone: e.target.value })} />
            <Input label="WHATSAPP" value={editAgentForm.whatsapp || ''} onChange={e => setEditAgentForm({ ...editAgentForm, whatsapp: e.target.value })} />
          </div>
          <Input label="EMAIL" value={editAgentForm.email || ''} onChange={e => setEditAgentForm({ ...editAgentForm, email: e.target.value })} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Input label="COMMISSION %" type="number" value={editAgentForm.commissionRate ?? ''}
              onChange={e => setEditAgentForm({ ...editAgentForm, commissionRate: Number(e.target.value) || 0 })} />
            <div>
              <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>STATUS</span>
              <div className="flex gap-2">
                {[true, false].map(v => (
                  <button key={String(v)} onClick={() => setEditAgentForm({ ...editAgentForm, active: v })}
                    className="cursor-pointer rounded"
                    style={{ padding: '7px 14px', fontSize: 12,
                      border: `1px solid ${(editAgentForm.active ?? true) === v ? '#0F0F10' : '#D5D1C4'}`,
                      color: (editAgentForm.active ?? true) === v ? '#0F0F10' : '#6B7280',
                      background: (editAgentForm.active ?? true) === v ? 'rgba(15,15,16,0.06)' : 'transparent',
                    }}>{v ? 'Active' : 'Inactive'}</button>
                ))}
              </div>
            </div>
          </div>
          <div>
            <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>NOTES</span>
            <textarea value={editAgentForm.notes || ''}
              onChange={e => setEditAgentForm({ ...editAgentForm, notes: e.target.value })}
              rows={3}
              style={{ width: '100%', background: 'transparent', border: '1px solid #D5D1C4', borderRadius: 6, padding: '8px 10px', fontSize: 13, color: '#0F0F10' }} />
          </div>
          <div className="flex justify-between gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E1D6' }}>
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

      {/* Edit Transfer Modal */}
      <Modal open={!!editTransfer} onClose={() => setEditTransfer(null)} title={`Edit Transfer — ${editTransfer?.transferNumber || ''}`} width={460}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Input label="AGENT PRICE (BHD)" type="number" value={editTransferForm.agentPrice ?? ''}
            onChange={e => setEditTransferForm({ ...editTransferForm, agentPrice: Number(e.target.value) || 0 })} />
          <Input label="MINIMUM PRICE (BHD)" type="number" value={editTransferForm.minimumPrice ?? ''}
            onChange={e => setEditTransferForm({ ...editTransferForm, minimumPrice: Number(e.target.value) || undefined })} />
          <div>
            <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>COMMISSION TYPE</span>
            <div className="flex gap-2">
              {(['percent', 'fixed'] as const).map(t => (
                <button key={t} onClick={() => setEditTransferForm({ ...editTransferForm, commissionType: t })}
                  className="cursor-pointer rounded"
                  style={{ padding: '7px 14px', fontSize: 12,
                    border: `1px solid ${(editTransferForm.commissionType ?? 'percent') === t ? '#0F0F10' : '#D5D1C4'}`,
                    color: (editTransferForm.commissionType ?? 'percent') === t ? '#0F0F10' : '#6B7280',
                    background: (editTransferForm.commissionType ?? 'percent') === t ? 'rgba(15,15,16,0.06)' : 'transparent',
                  }}>{t === 'percent' ? 'Percent' : 'Fixed'}</button>
              ))}
            </div>
          </div>
          {(editTransferForm.commissionType ?? 'percent') === 'percent' ? (
            <Input label="COMMISSION %" type="number" value={editTransferForm.commissionRate ?? ''}
              onChange={e => setEditTransferForm({ ...editTransferForm, commissionRate: Number(e.target.value) || 0 })} />
          ) : (
            <Input label="COMMISSION FIXED (BHD)" type="number" value={editTransferForm.commissionValue ?? ''}
              onChange={e => setEditTransferForm({ ...editTransferForm, commissionValue: Number(e.target.value) || 0 })} />
          )}
          <Input label="RETURN BY (DATE)" type="date" value={(editTransferForm.returnBy || '').split('T')[0]}
            onChange={e => setEditTransferForm({ ...editTransferForm, returnBy: e.target.value })} />
          <div>
            <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>NOTES</span>
            <textarea value={editTransferForm.notes || ''}
              onChange={e => setEditTransferForm({ ...editTransferForm, notes: e.target.value })}
              rows={3}
              style={{ width: '100%', background: 'transparent', border: '1px solid #D5D1C4', borderRadius: 6, padding: '8px 10px', fontSize: 13, color: '#0F0F10' }} />
          </div>
          <div className="flex justify-between gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E1D6' }}>
            <Button variant="danger" onClick={() => {
              if (editTransfer && window.confirm(`Delete transfer ${editTransfer.transferNumber}?`)) {
                deleteTransfer(editTransfer.id);
                setEditTransfer(null);
              }
            }}>Delete</Button>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setEditTransfer(null)}>Cancel</Button>
              <Button variant="primary" onClick={() => {
                if (!editTransfer) return;
                updateTransfer(editTransfer.id, editTransferForm);
                setEditTransfer(null);
              }}>Save</Button>
            </div>
          </div>
        </div>
      </Modal>

      {/* History drawers */}
      <HistoryDrawer
        open={!!historyAgentId}
        onClose={() => setHistoryAgentId(null)}
        entityType="agents"
        entityId={historyAgentId || ''}
        title="Agent History"
      />
      <HistoryDrawer
        open={!!historyTransferId}
        onClose={() => setHistoryTransferId(null)}
        entityType="agent_transfers"
        entityId={historyTransferId || ''}
        title="Transfer History"
      />

      {/* Mark as Sold Modal */}
      <Modal open={!!soldModal} onClose={() => setSoldModal(null)} title="Record Sale" width={400}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Input label="SALE PRICE (BHD)" type="number" value={soldPrice || ''} onChange={e => setSoldPrice(Number(e.target.value))} />
          <Input label="BUYER INFO" placeholder="Buyer name or reference" value={soldBuyerInfo} onChange={e => setSoldBuyerInfo(e.target.value)} />
          <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E1D6' }}>
            <Button variant="ghost" onClick={() => setSoldModal(null)}>Cancel</Button>
            <Button variant="primary" onClick={() => { if (soldModal && soldPrice > 0) { markTransferSold(soldModal, soldPrice, soldBuyerInfo || undefined); setSoldModal(null); } }} disabled={soldPrice <= 0}>Confirm Sale</Button>
          </div>
        </div>
      </Modal>
    </PageLayout>
  );
}
