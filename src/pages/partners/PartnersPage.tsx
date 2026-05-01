// Plan §Partner — Partners list + invest/withdraw/profit distribution modals
import { useEffect, useMemo, useState } from 'react';
import { Users, TrendingUp, TrendingDown, Gift } from 'lucide-react';
import { PageLayout } from '@/components/layout/PageLayout';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { usePartnerStore } from '@/stores/partnerStore';
import { HistoryDrawer } from '@/components/shared/HistoryPanel';
import { matchesDeep } from '@/core/utils/deep-search';
import type { Partner } from '@/core/models/types';

function fmt(v: number): string {
  return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

type TxKind = 'INVESTMENT' | 'WITHDRAWAL' | 'PROFIT_DISTRIBUTION';

export function PartnersPage() {
  const { partners, transactions, loadPartners, loadTransactions, createPartner, updatePartner, deletePartner,
    recordInvestment, recordWithdrawal, recordProfitDistribution, deleteTransaction } = usePartnerStore();

  const [search, setSearch] = useState('');
  const [showNewPartner, setShowNewPartner] = useState(false);
  const [partnerForm, setPartnerForm] = useState<Partial<Partner>>({});

  // Tx modal
  const [txModal, setTxModal] = useState<{ partnerId: string; kind: TxKind } | null>(null);
  const [txAmount, setTxAmount] = useState('');
  const [txMethod, setTxMethod] = useState<'cash' | 'bank'>('bank');
  const [txDate, setTxDate] = useState(new Date().toISOString().split('T')[0]);
  const [txNotes, setTxNotes] = useState('');
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [editPartner, setEditPartner] = useState<Partner | null>(null);
  const [editForm, setEditForm] = useState<Partial<Partner>>({});

  useEffect(() => { loadPartners(); loadTransactions(); }, [loadPartners, loadTransactions]);

  const filtered = useMemo(() => {
    if (!search) return partners;
    return partners.filter(p => matchesDeep(p, search));
  }, [partners, search]);

  const totalCapital = partners.reduce((s, p) => s + (p.balance || 0), 0);

  function openTx(partnerId: string, kind: TxKind) {
    setTxModal({ partnerId, kind });
    setTxAmount(''); setTxMethod('bank');
    setTxDate(new Date().toISOString().split('T')[0]);
    setTxNotes('');
  }

  function handleCreatePartner() {
    if (!partnerForm.name) return;
    createPartner(partnerForm);
    setShowNewPartner(false);
    setPartnerForm({});
  }

  function handleTx() {
    if (!txModal) return;
    const amt = parseFloat(txAmount);
    if (!amt || amt <= 0) return;
    if (txModal.kind === 'INVESTMENT') recordInvestment(txModal.partnerId, amt, txMethod, txDate, txNotes || undefined);
    else if (txModal.kind === 'WITHDRAWAL') recordWithdrawal(txModal.partnerId, amt, txMethod, txDate, txNotes || undefined);
    else recordProfitDistribution(txModal.partnerId, amt, txMethod, txDate, txNotes || undefined);
    setTxModal(null);
  }

  return (
    <PageLayout
      title="Partners"
      subtitle={`${partners.length} partners · ${fmt(totalCapital)} BHD total capital`}
      showSearch onSearch={setSearch} searchPlaceholder="Search partners..."
      actions={<Button variant="primary" onClick={() => setShowNewPartner(true)}>New Partner</Button>}
    >
      {filtered.length === 0 ? (
        <div style={{ padding: '80px 0', textAlign: 'center' }}>
          <Users size={40} strokeWidth={1} style={{ color: '#6B7280', margin: '0 auto 16px' }} />
          <p style={{ fontSize: 14, color: '#6B7280' }}>
            {search ? 'No partners match your search.' : 'No partners yet. Add your first partner.'}
          </p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 20 }}>
          {filtered.map(p => (
            <Card key={p.id}>
              <div className="flex items-start justify-between" style={{ marginBottom: 16 }}>
                <div>
                  <h3 style={{ fontSize: 18, color: '#0F0F10', fontWeight: 500 }}>{p.name}</h3>
                  {p.phone && <div style={{ fontSize: 12, color: '#6B7280', marginTop: 2 }}>{p.phone}</div>}
                  {p.email && <div style={{ fontSize: 12, color: '#6B7280' }}>{p.email}</div>}
                </div>
                <div style={{ textAlign: 'right' }}>
                  <span style={{ fontSize: 12, color: '#6B7280' }}>Share</span>
                  <div className="font-display" style={{ fontSize: 22, color: '#0F0F10' }}>{p.sharePercentage}%</div>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12, marginBottom: 16 }}>
                <div>
                  <span style={{ fontSize: 11, color: '#6B7280' }}>Invested</span>
                  <div className="font-mono" style={{ fontSize: 14, color: '#16A34A' }}>{fmt(p.totalInvested || 0)}</div>
                </div>
                <div>
                  <span style={{ fontSize: 11, color: '#6B7280' }}>Withdrawn</span>
                  <div className="font-mono" style={{ fontSize: 14, color: '#DC2626' }}>{fmt(p.totalWithdrawn || 0)}</div>
                </div>
                <div>
                  <span style={{ fontSize: 11, color: '#6B7280' }}>Profit share</span>
                  <div className="font-mono" style={{ fontSize: 14, color: '#16A34A' }}>{fmt(p.totalProfitShare || 0)}</div>
                </div>
                <div>
                  <span style={{ fontSize: 11, color: '#6B7280' }}>Balance</span>
                  <div className="font-mono" style={{ fontSize: 14, color: (p.balance || 0) >= 0 ? '#0F0F10' : '#DC2626' }}>{fmt(p.balance || 0)}</div>
                </div>
              </div>

              <div className="flex gap-2" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE', flexWrap: 'wrap' }}>
                <Button variant="secondary" onClick={() => openTx(p.id, 'INVESTMENT')}><TrendingUp size={12} /> Invest</Button>
                <Button variant="secondary" onClick={() => openTx(p.id, 'WITHDRAWAL')}><TrendingDown size={12} /> Withdraw</Button>
                <Button variant="ghost" onClick={() => openTx(p.id, 'PROFIT_DISTRIBUTION')}><Gift size={12} /> Profit Share</Button>
                <Button variant="ghost" onClick={() => { setEditPartner(p); setEditForm({ ...p }); }}>Edit</Button>
                <Button variant="ghost" onClick={() => setHistoryId(p.id)}>History</Button>
              </div>

              {/* Recent transactions for this partner */}
              {transactions.filter(t => t.partnerId === p.id).slice(0, 4).length > 0 && (
                <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
                  <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>RECENT</span>
                  {transactions.filter(t => t.partnerId === p.id).slice(0, 4).map(t => (
                    <div key={t.id} className="flex justify-between items-center" style={{ padding: '4px 0', fontSize: 11 }}>
                      <div>
                        <span className="font-mono" style={{ color: '#0F0F10' }}>{t.transactionNumber}</span>
                        <span style={{ color: '#6B7280', marginLeft: 8 }}>{t.transactionDate}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span style={{
                          color: t.type === 'WITHDRAWAL' ? '#DC2626' : '#16A34A',
                        }}>{t.type === 'WITHDRAWAL' ? '−' : '+'}{fmt(t.amount)} BHD</span>
                        <button onClick={() => deleteTransaction(t.id)} className="cursor-pointer" style={{ background: 'none', border: 'none', color: '#9CA3AF', fontSize: 11 }}>×</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {/* New Partner */}
      <Modal open={showNewPartner} onClose={() => setShowNewPartner(false)} title="New Partner" width={460}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Input required label="NAME" placeholder="Partner full name" value={partnerForm.name || ''} onChange={e => setPartnerForm({ ...partnerForm, name: e.target.value })} autoFocus />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <Input label="PHONE" value={partnerForm.phone || ''} onChange={e => setPartnerForm({ ...partnerForm, phone: e.target.value })} />
            <Input label="EMAIL" value={partnerForm.email || ''} onChange={e => setPartnerForm({ ...partnerForm, email: e.target.value })} />
          </div>
          <Input required label="PROFIT SHARE (%)" type="number" step="0.01" placeholder="0" value={partnerForm.sharePercentage ?? ''} onChange={e => setPartnerForm({ ...partnerForm, sharePercentage: parseFloat(e.target.value) || 0 })} />
          <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setShowNewPartner(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleCreatePartner} disabled={!partnerForm.name}>Create Partner</Button>
          </div>
        </div>
      </Modal>

      {/* Transaction */}
      <Modal open={!!txModal} onClose={() => setTxModal(null)}
        title={txModal?.kind === 'INVESTMENT' ? 'Record Investment' : txModal?.kind === 'WITHDRAWAL' ? 'Record Withdrawal' : 'Profit Distribution'}
        width={460}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <Input required label="AMOUNT (BHD)" type="number" step="0.01" placeholder="0.00" value={txAmount} onChange={e => setTxAmount(e.target.value)} autoFocus />
            <Input required label="DATE" type="date" value={txDate} onChange={e => setTxDate(e.target.value)} />
          </div>
          <div>
            <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>METHOD</span>
            <div className="flex gap-2" style={{ marginTop: 6 }}>
              {(['cash', 'bank'] as const).map(m => {
                const active = txMethod === m;
                return (
                  <button key={m} onClick={() => setTxMethod(m)} className="cursor-pointer rounded"
                    style={{ padding: '8px 16px', fontSize: 13,
                      border: `1px solid ${active ? '#0F0F10' : '#D5D9DE'}`,
                      color: active ? '#0F0F10' : '#6B7280',
                      background: active ? 'rgba(15,15,16,0.06)' : 'transparent',
                    }}>{m === 'cash' ? 'Cash' : 'Bank'}</button>
                );
              })}
            </div>
          </div>
          <Input label="NOTES" placeholder="Optional" value={txNotes} onChange={e => setTxNotes(e.target.value)} />
          <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setTxModal(null)}>Cancel</Button>
            <Button variant="primary" onClick={handleTx} disabled={!txAmount || parseFloat(txAmount) <= 0}>Confirm</Button>
          </div>
        </div>
      </Modal>

      <HistoryDrawer
        open={!!historyId}
        onClose={() => setHistoryId(null)}
        entityType="partners"
        entityId={historyId || ''}
        title="Partner History"
      />

      {/* Edit Partner Modal */}
      <Modal open={!!editPartner} onClose={() => setEditPartner(null)} title={`Edit Partner — ${editPartner?.name || ''}`} width={460}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Input required label="NAME" value={editForm.name || ''} onChange={e => setEditForm({ ...editForm, name: e.target.value })} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Input label="PHONE" value={editForm.phone || ''} onChange={e => setEditForm({ ...editForm, phone: e.target.value })} />
            <Input label="EMAIL" value={editForm.email || ''} onChange={e => setEditForm({ ...editForm, email: e.target.value })} />
          </div>
          <Input required label="SHARE %" type="number" value={editForm.sharePercentage ?? ''}
            onChange={e => setEditForm({ ...editForm, sharePercentage: Number(e.target.value) || 0 })} />
          <div>
            <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>STATUS</span>
            <div className="flex gap-2">
              {[true, false].map(v => (
                <button key={String(v)} onClick={() => setEditForm({ ...editForm, active: v })}
                  className="cursor-pointer rounded"
                  style={{ padding: '7px 14px', fontSize: 12,
                    border: `1px solid ${(editForm.active ?? true) === v ? '#0F0F10' : '#D5D9DE'}`,
                    color: (editForm.active ?? true) === v ? '#0F0F10' : '#6B7280',
                    background: (editForm.active ?? true) === v ? 'rgba(15,15,16,0.06)' : 'transparent',
                  }}>{v ? 'Active' : 'Inactive'}</button>
              ))}
            </div>
          </div>
          <div>
            <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>NOTES</span>
            <textarea value={editForm.notes || ''}
              onChange={e => setEditForm({ ...editForm, notes: e.target.value })}
              rows={3}
              style={{ width: '100%', background: 'transparent', border: '1px solid #D5D9DE', borderRadius: 6, padding: '8px 10px', fontSize: 13, color: '#0F0F10' }} />
          </div>
          <div className="flex justify-between gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="danger" onClick={() => {
              if (editPartner && window.confirm(`Delete partner "${editPartner.name}"?`)) {
                deletePartner(editPartner.id);
                setEditPartner(null);
              }
            }}>Delete</Button>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setEditPartner(null)}>Cancel</Button>
              <Button variant="primary" onClick={() => {
                if (!editPartner) return;
                updatePartner(editPartner.id, editForm);
                setEditPartner(null);
              }}>Save</Button>
            </div>
          </div>
        </div>
      </Modal>
    </PageLayout>
  );
}
