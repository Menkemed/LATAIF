// Plan §Banking — Cash + Bank overview + unified transaction log with all 9 types.
import { useEffect, useState, useMemo } from 'react';
import { ArrowRightLeft, Wallet, Building2, Smartphone, ArrowUpRight, ArrowDownLeft } from 'lucide-react';
import { PageLayout } from '@/components/layout/PageLayout';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Bhd } from '@/components/ui/Bhd';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { useBankingStore, transferFlow, transferDirectionFor, type BankTransactionType, type BankAccount } from '@/stores/bankingStore';

function fmt(v: number | null | undefined): string {
  return (v ?? 0).toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}

const TYPE_LABELS: Record<BankTransactionType, string> = {
  SALES_IN: 'Sales',
  PURCHASE_OUT: 'Purchase',
  EXPENSE_OUT: 'Expense',
  LOAN_IN: 'Loan In',
  LOAN_OUT: 'Loan Out',
  PARTNER_INVESTMENT_IN: 'Partner In',
  PARTNER_WITHDRAWAL_OUT: 'Partner Out',
  TRANSFER: 'Transfer',
  REFUND: 'Refund',
};

const TYPE_COLORS: Record<BankTransactionType, string> = {
  SALES_IN: '#7EAA6E',
  PURCHASE_OUT: '#B77B3A',
  EXPENSE_OUT: '#AA6E6E',
  LOAN_IN: '#6E8AAA',
  LOAN_OUT: '#6E8AAA',
  PARTNER_INVESTMENT_IN: '#7B4AAA',
  PARTNER_WITHDRAWAL_OUT: '#7B4AAA',
  TRANSFER: '#6B7280',
  REFUND: '#D17060',
};

export function BankingPage() {
  const { transfers, loadTransfers, createTransfer, getTransactions } = useBankingStore();
  const [showNew, setShowNew] = useState(false);
  const [amount, setAmount] = useState('');
  const [fromAcc, setFromAcc] = useState<BankAccount>('cash');
  const [toAcc, setToAcc] = useState<BankAccount>('bank');
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [notes, setNotes] = useState('');
  const [accountFilter, setAccountFilter] = useState<BankAccount | 'all'>('all');
  const [typeFilter, setTypeFilter] = useState<BankTransactionType | 'all'>('all');

  useEffect(() => { loadTransfers(); }, [loadTransfers]);

  // getTransactions feuert ~14 SQL-Queries — auf Production-Daten merklich langsam.
  // Vorher lief das doppelt (einmal für allTxs, einmal über getBalances). Wir
  // berechnen die Balances jetzt aus derselben Tx-Liste statt nochmal zu queryn.
  const allTxs = useMemo(() => {
    try { return getTransactions(); }
    catch (err) { console.error('[BankingPage] getTransactions failed:', err); return []; }
  }, [getTransactions, transfers]);

  const balances = useMemo(() => {
    let cash = 0, bank = 0, benefit = 0;
    for (const t of allTxs) {
      const sign = t.flow === 'in' ? 1 : -1;
      if (t.account === 'cash') cash += sign * t.amount;
      else if (t.account === 'benefit') benefit += sign * t.amount;
      else bank += sign * t.amount;
    }
    return { cash, bank, benefit };
  }, [allTxs]);
  const filteredTxs = useMemo(() => {
    return allTxs.filter(t => {
      if (accountFilter !== 'all' && t.account !== accountFilter) return false;
      if (typeFilter !== 'all' && t.type !== typeFilter) return false;
      return true;
    });
  }, [allTxs, accountFilter, typeFilter]);

  const uniqueTypes = useMemo(() => {
    const set = new Set<BankTransactionType>();
    allTxs.forEach(t => set.add(t.type));
    return Array.from(set);
  }, [allTxs]);

  function handleCreate() {
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return;
    if (fromAcc === toAcc) return;
    const dir = transferDirectionFor(fromAcc, toAcc);
    if (!dir) return;
    createTransfer({ amount: amt, direction: dir, transferDate: date, notes: notes || undefined });
    setAmount(''); setNotes('');
    setDate(new Date().toISOString().split('T')[0]);
    setShowNew(false);
  }

  // Wenn From == To, Ziel auto-flippen (häufiger Bedienfehler)
  function pickFrom(a: BankAccount) {
    setFromAcc(a);
    if (a === toAcc) {
      const fallback: BankAccount = a === 'cash' ? 'bank' : 'cash';
      setToAcc(fallback);
    }
  }
  function pickTo(a: BankAccount) {
    setToAcc(a);
    if (a === fromAcc) {
      const fallback: BankAccount = a === 'cash' ? 'bank' : 'cash';
      setFromAcc(fallback);
    }
  }

  const ACCOUNT_META: Record<BankAccount, { label: string; icon: string }> = {
    cash:    { label: 'Cash',    icon: '💵' },
    bank:    { label: 'Bank',    icon: '🏦' },
    benefit: { label: 'Benefit', icon: '📱' },
  };

  return (
    <PageLayout
      title="Banking"
      subtitle="Cash, Bank & Benefit (BenefitPay App) — live balances + unified transaction log"
      actions={<Button variant="primary" onClick={() => setShowNew(true)}><ArrowRightLeft size={14} /> Transfer</Button>}
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20, marginBottom: 24 }}>
        <Card>
          <div className="flex items-center gap-3" style={{ marginBottom: 10 }}>
            <div className="rounded-full flex items-center justify-center" style={{ width: 40, height: 40, background: '#E9FF5E' }}>
              <Wallet size={18} style={{ color: '#0F0F10' }} />
            </div>
            <div>
              <span className="text-overline">CASH BALANCE</span>
              <div style={{ fontSize: 11, color: '#6B7280' }}>Physical cash on hand</div>
            </div>
          </div>
          <div style={{ fontSize: 28, fontWeight: 300, color: balances.cash < 0 ? '#AA6E6E' : '#0F0F10', fontVariantNumeric: 'tabular-nums' }}>
            <Bhd v={balances.cash}/> <span style={{ fontSize: 14, color: '#6B7280' }}>BHD</span>
          </div>
        </Card>
        <Card>
          <div className="flex items-center gap-3" style={{ marginBottom: 10 }}>
            <div className="rounded-full flex items-center justify-center" style={{ width: 40, height: 40, background: '#C4E3EC' }}>
              <Building2 size={18} style={{ color: '#0F0F10' }} />
            </div>
            <div>
              <span className="text-overline">BANK BALANCE</span>
              <div style={{ fontSize: 11, color: '#6B7280' }}>Card-net after auto-fees</div>
            </div>
          </div>
          <div style={{ fontSize: 28, fontWeight: 300, color: balances.bank < 0 ? '#AA6E6E' : '#0F0F10', fontVariantNumeric: 'tabular-nums' }}>
            <Bhd v={balances.bank}/> <span style={{ fontSize: 14, color: '#6B7280' }}>BHD</span>
          </div>
        </Card>
        <Card>
          <div className="flex items-center gap-3" style={{ marginBottom: 10 }}>
            <div className="rounded-full flex items-center justify-center" style={{ width: 40, height: 40, background: 'rgba(255,135,48,0.15)' }}>
              <Smartphone size={18} style={{ color: '#FF8730' }} />
            </div>
            <div>
              <span className="text-overline">BENEFIT BALANCE</span>
              <div style={{ fontSize: 11, color: '#6B7280' }}>BenefitPay App transfers</div>
            </div>
          </div>
          <div style={{ fontSize: 28, fontWeight: 300, color: balances.benefit < 0 ? '#AA6E6E' : '#0F0F10', fontVariantNumeric: 'tabular-nums' }}>
            <Bhd v={balances.benefit}/> <span style={{ fontSize: 14, color: '#6B7280' }}>BHD</span>
          </div>
        </Card>
      </div>

      <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <span className="text-overline">TRANSACTIONS ({filteredTxs.length})</span>
        <div className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
          {(['all', 'cash', 'bank', 'benefit'] as const).map(a => (
            <button key={a} onClick={() => setAccountFilter(a)} style={{
              fontSize: 11, padding: '4px 10px', borderRadius: 999, cursor: 'pointer',
              border: '1px solid ' + (accountFilter === a ? '#0F0F10' : '#D5D9DE'),
              background: accountFilter === a ? '#0F0F10' : 'transparent',
              color: accountFilter === a ? '#FFFFFF' : '#4B5563',
            }}>{a === 'all' ? 'All accounts' : a[0].toUpperCase() + a.slice(1)}</button>
          ))}
          <select value={typeFilter} onChange={e => setTypeFilter(e.target.value as BankTransactionType | 'all')}
            style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, border: '1px solid #D5D9DE', background: '#FFFFFF' }}>
            <option value="all">All types</option>
            {uniqueTypes.map(t => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
          </select>
        </div>
      </div>

      {filteredTxs.length === 0 ? (
        <div style={{ padding: '60px 0', textAlign: 'center', fontSize: 13, color: '#6B7280' }}>
          No transactions match the selected filters.
        </div>
      ) : (
        <Card noPadding>
          <div style={{ display: 'grid', gridTemplateColumns: '100px 120px 80px 1fr 110px 40px', gap: 12, padding: '12px 16px', borderBottom: '1px solid #E5E9EE' }}>
            {['DATE', 'TYPE', 'ACCOUNT', 'DESCRIPTION', 'AMOUNT', ''].map(h => (
              <span key={h} className="text-overline">{h}</span>
            ))}
          </div>
          <div style={{ maxHeight: 600, overflowY: 'auto' }}>
            {filteredTxs.map(t => (
              <div key={t.id} style={{
                display: 'grid', gridTemplateColumns: '100px 120px 80px 1fr 110px 40px',
                gap: 12, padding: '10px 16px', alignItems: 'center',
                borderBottom: '1px solid rgba(229,225,214,0.6)',
              }}>
                <span style={{ fontSize: 12, color: '#4B5563' }}>{t.date?.split('T')[0] || '—'}</span>
                <span style={{
                  fontSize: 10, padding: '2px 8px', borderRadius: 999,
                  background: TYPE_COLORS[t.type] + '15', color: TYPE_COLORS[t.type],
                  justifySelf: 'start', whiteSpace: 'nowrap',
                }}>{TYPE_LABELS[t.type]}</span>
                <span style={{ fontSize: 11, color: '#6B7280', textTransform: 'uppercase' }}>
                  {t.account === 'cash' ? '💵 Cash' : t.account === 'benefit' ? '📱 Benefit' : '🏦 Bank'}
                </span>
                <span style={{ fontSize: 12, color: '#4B5563', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {t.description || '—'}
                </span>
                <span className="font-mono" style={{
                  fontSize: 13, textAlign: 'right',
                  color: t.flow === 'in' ? '#7EAA6E' : '#AA6E6E',
                  fontVariantNumeric: 'tabular-nums',
                }}>
                  {t.flow === 'in' ? '+' : '−'} <Bhd v={t.amount}/>
                </span>
                <span style={{ color: t.flow === 'in' ? '#7EAA6E' : '#AA6E6E', display: 'flex', justifyContent: 'center' }}>
                  {t.flow === 'in' ? <ArrowDownLeft size={14} /> : <ArrowUpRight size={14} />}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {transfers.length > 0 && (
        <>
          <div style={{ marginTop: 28, marginBottom: 12 }}>
            <span className="text-overline">TRANSFERS CASH ↔ BANK ↔ BENEFIT</span>
          </div>
          {/* Plan §Banking §13: Transaktionen sind unveränderbar — keine Delete-Buttons. */}
          <Card noPadding>
            {transfers.map(t => {
              const fl = transferFlow(t.direction);
              return (
                <div key={t.id} style={{
                  display: 'grid', gridTemplateColumns: '110px 1fr 120px 2fr',
                  gap: 14, padding: '10px 16px', alignItems: 'center',
                  borderBottom: '1px solid rgba(229,225,214,0.6)',
                }}>
                  <span style={{ fontSize: 12, color: '#4B5563' }}>{t.transferDate}</span>
                  <span style={{ fontSize: 12, color: '#0F0F10' }}>
                    {ACCOUNT_META[fl.from].icon} {ACCOUNT_META[fl.from].label} → {ACCOUNT_META[fl.to].label} {ACCOUNT_META[fl.to].icon}
                  </span>
                  <span className="font-mono" style={{ fontSize: 13, color: '#0F0F10' }}><Bhd v={t.amount}/> BHD</span>
                  <span style={{ fontSize: 12, color: '#6B7280' }}>{t.notes || '—'}</span>
                </div>
              );
            })}
          </Card>
        </>
      )}

      <Modal open={showNew} onClose={() => setShowNew(false)} title="Transfer between accounts" width={460}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <div>
              <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>FROM</span>
              <div className="flex gap-2" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                {(['cash', 'bank', 'benefit'] as const).map(a => {
                  const active = fromAcc === a;
                  return (
                    <button key={a} onClick={() => pickFrom(a)} className="cursor-pointer rounded"
                      style={{ padding: '8px 12px', fontSize: 13,
                        border: `1px solid ${active ? '#0F0F10' : '#D5D9DE'}`,
                        color: active ? '#0F0F10' : '#6B7280',
                        background: active ? 'rgba(15,15,16,0.06)' : 'transparent',
                      }}>{ACCOUNT_META[a].icon} {ACCOUNT_META[a].label}</button>
                  );
                })}
              </div>
            </div>
            <div>
              <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>TO</span>
              <div className="flex gap-2" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                {(['cash', 'bank', 'benefit'] as const).map(a => {
                  const active = toAcc === a;
                  const disabled = a === fromAcc;
                  return (
                    <button key={a} onClick={() => !disabled && pickTo(a)}
                      className={disabled ? '' : 'cursor-pointer'}
                      disabled={disabled}
                      style={{ padding: '8px 12px', fontSize: 13, borderRadius: 4,
                        border: `1px solid ${active ? '#0F0F10' : '#D5D9DE'}`,
                        color: disabled ? '#C5C9CE' : (active ? '#0F0F10' : '#6B7280'),
                        background: active ? 'rgba(15,15,16,0.06)' : 'transparent',
                        opacity: disabled ? 0.5 : 1,
                      }}>{ACCOUNT_META[a].icon} {ACCOUNT_META[a].label}</button>
                  );
                })}
              </div>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <Input required label="AMOUNT (BHD)" type="number" step="0.001" placeholder="0.000" value={amount} onChange={e => setAmount(e.target.value)} autoFocus />
            <Input required label="DATE" type="date" value={date} onChange={e => setDate(e.target.value)} />
          </div>
          <Input label="NOTES" placeholder="Optional" value={notes} onChange={e => setNotes(e.target.value)} />
          <div style={{ fontSize: 12, color: '#6B7280', padding: '8px 0' }}>
            {ACCOUNT_META[fromAcc].icon} {ACCOUNT_META[fromAcc].label} → {ACCOUNT_META[toAcc].label} {ACCOUNT_META[toAcc].icon}
          </div>
          <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setShowNew(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleCreate} disabled={!amount || parseFloat(amount) <= 0 || fromAcc === toAcc}>Create Transfer</Button>
          </div>
        </div>
      </Modal>

    </PageLayout>
  );
}
