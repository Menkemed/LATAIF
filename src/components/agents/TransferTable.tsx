// Geteilte Transfer-Tabelle für Approval-Modul.
// Wird in AgentList (Tab "Transfers", alle Klienten) und in AgentDetail
// (gefiltert auf einen Klienten) verwendet — damit beide Ansichten
// garantiert dieselbe Render- + Action-Logik haben und immer synchron sind.
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileText } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { StatusDot } from '@/components/ui/StatusDot';
import { HistoryDrawer } from '@/components/shared/HistoryPanel';
import { useAgentStore } from '@/stores/agentStore';
import { useProductStore } from '@/stores/productStore';
import { useCustomerStore } from '@/stores/customerStore';
import { useInvoiceStore } from '@/stores/invoiceStore';
import type { AgentTransfer, Invoice } from '@/core/models/types';

function fmt(v: number): string {
  return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

// Display-Status (User-Spec: Transfer ↔ Invoice synchron). Wenn der Transfer
// einer Invoice zugeordnet ist, leiten wir den sichtbaren Status aus dem
// Zahlungsstand der Invoice ab — keine separate Wahrheit, kein Auseinanderlaufen.
//   invoice paid≈gross  → settled
//   invoice 0<paid<gross → partial   (orange "Partially Paid")
//   invoice paid≈0      → sold       (= verkauft, Geld noch nicht da)
// Für Transfers OHNE Invoice (Legacy-Settle-Pfad) bleibt der gespeicherte Status
// die Wahrheit, ergänzt um settlementStatus für partial-Markierung.
type TransferDisplayStatus = 'transferred' | 'sold' | 'partial' | 'settled' | 'returned';

function deriveTransferDisplayStatus(t: AgentTransfer, invoice?: Invoice): TransferDisplayStatus {
  if (t.status === 'returned') return 'returned';
  if (t.status === 'transferred') return 'transferred';
  // sold / settled
  if (t.invoiceId && invoice) {
    const paid = invoice.paidAmount || 0;
    const gross = invoice.grossAmount || 0;
    if (gross > 0 && paid >= gross - 0.005) return 'settled';
    if (paid > 0.005) return 'partial';
    return 'sold';
  }
  if (t.settlementStatus === 'paid') return 'settled';
  if (t.settlementStatus === 'partial') return 'partial';
  return t.status === 'settled' ? 'settled' : 'sold';
}

const STATUS_FILTERS: { value: '' | TransferDisplayStatus; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'transferred', label: 'On Approval' },
  { value: 'sold', label: 'Sold' },
  { value: 'partial', label: 'Partially Paid' },
  { value: 'settled', label: 'Settled' },
  { value: 'returned', label: 'Returned' },
];

interface TransferTableProps {
  transfers: AgentTransfer[];
  showAgentColumn?: boolean;
  emptyMessage?: string;
}

export function TransferTable({ transfers, showAgentColumn = true, emptyMessage }: TransferTableProps) {
  const navigate = useNavigate();
  const { agents, transfers: allTransfers, markTransferSold, markTransferReturned, markTransferSettled,
    convertTransferToInvoice, convertTransfersToInvoice, undoTransferInvoiceConvert, updateTransfer, deleteTransfer } = useAgentStore();
  const { products } = useProductStore();
  const { customers, createCustomer } = useCustomerStore();
  const { invoices } = useInvoiceStore();

  const [filterStatus, setFilterStatus] = useState<'' | TransferDisplayStatus>('');

  // Sold
  const [soldModal, setSoldModal] = useState<string | null>(null);
  const [soldPrice, setSoldPrice] = useState(0);

  // Settle
  const [settleModal, setSettleModal] = useState<string | null>(null);
  const [settleMethod, setSettleMethod] = useState<'cash' | 'bank'>('cash');
  const [settleAmount, setSettleAmount] = useState<string>('');
  const [settlePartial, setSettlePartial] = useState(false);

  // Convert (single)
  const [convertModal, setConvertModal] = useState<string | null>(null);
  const [convertCustomerId, setConvertCustomerId] = useState<string>('');
  const [convertMode, setConvertMode] = useState<'existing' | 'auto'>('existing');
  const [convertError, setConvertError] = useState('');

  // Bulk Convert (Combined Invoice — User-Spec)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkModal, setBulkModal] = useState(false);
  const [bulkCustomerId, setBulkCustomerId] = useState<string>('');
  const [bulkMode, setBulkMode] = useState<'existing' | 'auto'>('existing');
  const [bulkError, setBulkError] = useState('');

  // Edit / History
  const [editTransfer, setEditTransfer] = useState<AgentTransfer | null>(null);
  const [editTransferForm, setEditTransferForm] = useState<Partial<AgentTransfer>>({});
  const [historyTransferId, setHistoryTransferId] = useState<string | null>(null);

  const customerOptions = useMemo(() => customers.map(c => ({
    id: c.id,
    label: `${c.firstName} ${c.lastName}${c.company ? ` — ${c.company}` : ''}`.trim(),
    subtitle: c.phone || c.email || undefined,
  })), [customers]);

  // Wir filtern hier nochmals auf Status — auf den abgeleiteten Display-Status,
  // damit "Settled" eine voll bezahlte Invoice meint und nicht den rohen
  // Transfer-Status. Die übergebenen Transfers sind bereits vom Parent
  // vorgefiltert (z.B. nach Agent in der Detail-Page).
  const filtered = useMemo(() => {
    if (!filterStatus) return transfers;
    return transfers.filter(t => {
      const linkedInvoice = t.invoiceId ? invoices.find(i => i.id === t.invoiceId) : undefined;
      return deriveTransferDisplayStatus(t, linkedInvoice) === filterStatus;
    });
  }, [transfers, filterStatus, invoices]);

  // Bulk-Convert (Combined Invoice): nur sold-Transfers ohne Invoice-Link.
  const isEligibleForBulk = (t: AgentTransfer) => t.status === 'sold' && !t.invoiceId;

  // Selektion gegen aktuelle Realität abgleichen — Transfers können sich
  // im Store geändert haben (Sold zu Settled konvertiert, gelöscht, …).
  const validSelectedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const id of selectedIds) {
      const t = allTransfers.find(x => x.id === id);
      if (t && isEligibleForBulk(t)) ids.add(id);
    }
    return ids;
  }, [selectedIds, allTransfers]);
  const selectedTransfers = useMemo(
    () => allTransfers.filter(t => validSelectedIds.has(t.id)),
    [validSelectedIds, allTransfers],
  );
  const selectedAgentIds = useMemo(
    () => new Set(selectedTransfers.map(t => t.agentId)),
    [selectedTransfers],
  );
  const sameAgent = selectedAgentIds.size <= 1;
  const selectedTotal = selectedTransfers.reduce((s, t) => s + (t.settlementAmount || 0), 0);

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const clearSelection = () => setSelectedIds(new Set());

  function openBulkModal() {
    if (validSelectedIds.size === 0) return;
    if (!sameAgent) {
      setBulkError('All selected items must be from the same approval / agent.');
      setBulkModal(true);
      return;
    }
    const agent = agents.find(a => a.id === selectedTransfers[0].agentId);
    let initialCustomerId = agent?.customerId || '';
    if (!initialCustomerId && agent) {
      const norm = (s?: string) => (s || '').replace(/\s+/g, '').toLowerCase();
      const phoneA = norm(agent.phone);
      const emailA = norm(agent.email);
      const whatsAppA = norm(agent.whatsapp);
      const match = customers.find(c => {
        if (phoneA && norm(c.phone) === phoneA) return true;
        if (emailA && norm(c.email) === emailA) return true;
        if (whatsAppA && norm(c.whatsapp) === whatsAppA) return true;
        return false;
      });
      if (match) initialCustomerId = match.id;
    }
    setBulkCustomerId(initialCustomerId);
    setBulkMode('existing');
    setBulkError('');
    setBulkModal(true);
  }

  function handleBulkConfirm() {
    const ids = Array.from(validSelectedIds);
    if (ids.length === 0) return;
    if (!sameAgent) { setBulkError('All selected items must be from the same approval / agent.'); return; }
    const agent = agents.find(a => a.id === selectedTransfers[0].agentId);
    if (!agent) { setBulkError('Agent not found.'); return; }
    let customerId = bulkCustomerId;
    if (bulkMode === 'auto') {
      const parts = (agent.name || '').trim().split(/\s+/);
      const firstName = parts[0] || agent.name || 'Agent';
      const lastName = parts.slice(1).join(' ') || '';
      const newCust = createCustomer({
        firstName, lastName,
        company: agent.company,
        phone: agent.phone,
        whatsapp: agent.whatsapp,
        email: agent.email,
        notes: `Auto-created from agent ${agent.name} for combined invoice.`,
      });
      customerId = newCust.id;
    }
    if (!customerId) { setBulkError('Please pick a customer or choose auto-create.'); return; }
    try {
      const invoice = convertTransfersToInvoice(ids, customerId);
      setBulkModal(false);
      setSelectedIds(new Set());
      navigate(`/invoices/${invoice.id}`);
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : String(err));
    }
  }

  // Wenn allTransfers im Store geupdated wird (Sold/Settle/etc.), reflektieren
  // beide Views das automatisch — garantiert durch Zustand-Subscriptions.
  // Wir nutzen `allTransfers` hier nur für Modal-Zugriffe nach ID, wo der
  // gefilterte `transfers`-Prop nicht reicht.
  const findTransfer = (id: string) => allTransfers.find(t => t.id === id) || transfers.find(t => t.id === id);

  function openConvertModal(transferId: string) {
    const t = findTransfer(transferId);
    if (!t) return;
    const agent = agents.find(a => a.id === t.agentId);
    let initialCustomerId = agent?.customerId || '';
    if (!initialCustomerId && agent) {
      const norm = (s?: string) => (s || '').replace(/\s+/g, '').toLowerCase();
      const phoneA = norm(agent.phone);
      const emailA = norm(agent.email);
      const whatsAppA = norm(agent.whatsapp);
      const match = customers.find(c => {
        if (phoneA && norm(c.phone) === phoneA) return true;
        if (emailA && norm(c.email) === emailA) return true;
        if (whatsAppA && norm(c.whatsapp) === whatsAppA) return true;
        return false;
      });
      if (match) initialCustomerId = match.id;
    }
    setConvertCustomerId(initialCustomerId);
    setConvertMode('existing');
    setConvertError('');
    setConvertModal(transferId);
  }

  function handleConvertConfirm() {
    if (!convertModal) return;
    const t = findTransfer(convertModal);
    if (!t) return;
    const agent = agents.find(a => a.id === t.agentId);
    if (!agent) { setConvertError('Agent not found.'); return; }
    let customerId = convertCustomerId;
    if (convertMode === 'auto') {
      const parts = (agent.name || '').trim().split(/\s+/);
      const firstName = parts[0] || agent.name || 'Agent';
      const lastName = parts.slice(1).join(' ') || '';
      const newCust = createCustomer({
        firstName, lastName,
        company: agent.company,
        phone: agent.phone,
        whatsapp: agent.whatsapp,
        email: agent.email,
        notes: `Auto-created from agent ${agent.name} for transfer settlements.`,
      });
      customerId = newCust.id;
    }
    if (!customerId) { setConvertError('Please pick a customer or choose auto-create.'); return; }
    try {
      const invoice = convertTransferToInvoice(convertModal, customerId);
      setConvertModal(null);
      navigate(`/invoices/${invoice.id}`);
    } catch (err) {
      setConvertError(err instanceof Error ? err.message : String(err));
    }
  }

  // Spalten-Layout — Checkbox vorne, Agent-Spalte optional (in Detail-Page redundant).
  const gridCols = showAgentColumn
    ? '36px 90px minmax(0,1fr) minmax(0,1fr) minmax(0,1.3fr) minmax(0,0.9fr) minmax(0,0.9fr) minmax(0,0.9fr) minmax(0,0.8fr) minmax(0,1.4fr)'
    : '36px 90px minmax(0,1fr) minmax(0,1.6fr) minmax(0,0.9fr) minmax(0,0.9fr) minmax(0,0.9fr) minmax(0,0.8fr) minmax(0,1.4fr)';
  const headers = showAgentColumn
    ? ['', 'DATE', 'DOCUMENT', 'AGENT', 'ITEM', 'AMOUNT', 'PAID', 'OUTSTANDING', 'STATUS', 'ACTIONS']
    : ['', 'DATE', 'DOCUMENT', 'ITEM', 'AMOUNT', 'PAID', 'OUTSTANDING', 'STATUS', 'ACTIONS'];

  return (
    <div>
      {/* Bulk-Action-Toolbar — sichtbar sobald mind. 1 sold-Transfer selektiert */}
      {validSelectedIds.size > 0 && (
        <div style={{
          marginBottom: 12, padding: '10px 14px', borderRadius: 8,
          background: sameAgent ? 'rgba(113,93,227,0.06)' : 'rgba(220,38,38,0.06)',
          border: `1px solid ${sameAgent ? 'rgba(113,93,227,0.3)' : 'rgba(220,38,38,0.3)'}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        }}>
          <div style={{ fontSize: 12, color: '#0F0F10' }}>
            <strong>{validSelectedIds.size} sold transfer(s)</strong> selected
            {sameAgent ? (
              <> · combined settlement <span className="font-mono">{fmt(selectedTotal)} BHD</span></>
            ) : (
              <span style={{ color: '#DC2626', marginLeft: 8 }}>
                · all selections must be from the same approval / agent
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={clearSelection}>Clear</Button>
            <Button variant="primary" onClick={openBulkModal} disabled={!sameAgent}>
              <FileText size={14} /> Create Combined Invoice
            </Button>
          </div>
        </div>
      )}

      {/* Filter-Pills */}
      <div className="flex gap-1" style={{ marginBottom: 16 }}>
        {STATUS_FILTERS.map(sf => (
          <button key={sf.value} onClick={() => setFilterStatus(sf.value)}
            className="cursor-pointer transition-all duration-200" style={{
              padding: '5px 12px', fontSize: 11, borderRadius: 999, border: 'none',
              background: filterStatus === sf.value ? 'rgba(15,15,16,0.08)' : 'transparent',
              color: filterStatus === sf.value ? '#0F0F10' : '#6B7280',
            }}>{sf.label}</button>
        ))}
      </div>

      {/* Header */}
      <div style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 12, padding: '0 12px 10px' }}>
        {headers.map((h, i) => (
          <span key={i} className="text-overline">{h}</span>
        ))}
      </div>
      <div style={{ borderTop: '1px solid #E5E9EE' }} />

      {filtered.length === 0 && (
        <div style={{ padding: '48px 0', textAlign: 'center', fontSize: 13, color: '#6B7280' }}>
          {emptyMessage || (transfers.length === 0 ? 'No transfers yet.' : 'No transfers in this filter.')}
        </div>
      )}

      {filtered.map(t => {
        const agent = agents.find(a => a.id === t.agentId);
        const product = products.find(p => p.id === t.productId);
        const linkedInvoice = t.invoiceId ? invoices.find(i => i.id === t.invoiceId) : undefined;
        const amount = linkedInvoice
          ? linkedInvoice.grossAmount
          : ((t.settlementAmount ?? t.actualSalePrice ?? t.agentPrice) || 0);
        const paid = linkedInvoice
          ? (linkedInvoice.paidAmount || 0)
          : (t.settlementStatus === 'paid'
            ? (t.settlementAmount ?? amount)
            : (t.settlementStatus === 'partial' ? (t.settlementPaidAmount || 0) : 0));
        const outstanding = Math.max(0, amount - paid);
        const date = (t.transferredAt || t.createdAt || '').split('T')[0];
        const docLabel = linkedInvoice ? `${t.transferNumber} → ${linkedInvoice.invoiceNumber}` : t.transferNumber;
        const eligible = isEligibleForBulk(t);
        const checked = validSelectedIds.has(t.id);
        return (
          <div key={t.id} style={{
            display: 'grid', gridTemplateColumns: gridCols,
            gap: 12, padding: '12px', alignItems: 'center', borderBottom: '1px solid rgba(229,225,214,0.6)',
            background: checked ? 'rgba(113,93,227,0.04)' : 'transparent',
          }}>
            <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {eligible ? (
                <input type="checkbox" checked={checked} onChange={() => toggleSelect(t.id)}
                  title="Select for combined invoice"
                  style={{ cursor: 'pointer', width: 16, height: 16, accentColor: '#715DE3' }} />
              ) : null}
            </span>
            <span style={{ fontSize: 11, color: '#6B7280' }}>{date || '—'}</span>
            <span className="font-mono" style={{ fontSize: 11, color: '#4B5563' }}>{docLabel}</span>
            {showAgentColumn && (
              <span style={{ fontSize: 12, color: '#0F0F10' }}>{agent?.name || '—'}</span>
            )}
            <span style={{ fontSize: 12, color: '#0F0F10', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {product ? `${product.brand} ${product.name}` : '—'}
            </span>
            <span className="font-mono" style={{ fontSize: 12, color: '#0F0F10' }}>{fmt(amount)}</span>
            <span className="font-mono" style={{ fontSize: 12, color: paid > 0 ? '#7EAA6E' : '#6B7280' }}>{fmt(paid)}</span>
            <span className="font-mono" style={{ fontSize: 12, color: outstanding > 0 ? '#AA6E6E' : '#6B7280' }}>{fmt(outstanding)}</span>
            <StatusDot status={deriveTransferDisplayStatus(t, linkedInvoice)} />
            <div className="flex gap-1 flex-wrap">
              {t.status === 'transferred' && (
                <>
                  <button onClick={() => { setSoldModal(t.id); setSoldPrice(t.agentPrice); }}
                    className="cursor-pointer" style={{ padding: '3px 8px', fontSize: 11, border: '1px solid #7EAA6E', color: '#7EAA6E', borderRadius: 4, background: 'none' }}>Sold</button>
                  <button onClick={() => markTransferReturned(t.id)}
                    className="cursor-pointer" style={{ padding: '3px 8px', fontSize: 11, border: '1px solid #6B7280', color: '#6B7280', borderRadius: 4, background: 'none' }}>Return</button>
                </>
              )}
              {(t.status === 'sold' || t.status === 'settled') && outstanding > 0 && (
                <button onClick={() => {
                  setSettleModal(t.id); setSettleMethod('cash');
                  setSettlePartial(false);
                  setSettleAmount(String(outstanding.toFixed(2)));
                }}
                  className="cursor-pointer" style={{ padding: '3px 8px', fontSize: 11, border: '1px solid #0F0F10', color: '#0F0F10', borderRadius: 4, background: 'none' }}>
                  {paid > 0 ? 'Receive More' : 'Settle'}
                </button>
              )}
              {(t.status === 'sold' || t.status === 'settled') && !t.invoiceId && (
                <button onClick={() => openConvertModal(t.id)}
                  className="cursor-pointer flex items-center gap-1" style={{ padding: '3px 8px', fontSize: 11, border: '1px solid #715DE3', color: '#715DE3', borderRadius: 4, background: 'none' }}>
                  <FileText size={11} /> Convert to Invoice
                </button>
              )}
              {t.invoiceId && (() => {
                const canUndo = !linkedInvoice || (linkedInvoice.paidAmount || 0) <= 0.005;
                return (
                  <>
                    <button onClick={() => navigate(`/invoices/${t.invoiceId}`)}
                      className="cursor-pointer flex items-center gap-1" style={{ padding: '3px 8px', fontSize: 11, border: '1px solid #715DE3', color: '#715DE3', borderRadius: 4, background: 'rgba(113,93,227,0.06)' }}>
                      <FileText size={11} /> View Invoice
                    </button>
                    {canUndo && (
                      <button onClick={() => {
                        if (!window.confirm(`Convert rückgängig machen? Die Invoice wird gelöscht und der Transfer wieder auf "Sold" gesetzt.`)) return;
                        try { undoTransferInvoiceConvert(t.id); }
                        catch (err) { alert(err instanceof Error ? err.message : String(err)); }
                      }}
                        title="Convert rückgängig machen (nur möglich solange Invoice unbezahlt)"
                        className="cursor-pointer" style={{ padding: '3px 8px', fontSize: 11, border: '1px solid #D5D9DE', color: '#6B7280', borderRadius: 4, background: 'none' }}>
                        Undo
                      </button>
                    )}
                  </>
                );
              })()}
              <button onClick={() => { setEditTransfer(t); setEditTransferForm({ ...t }); }}
                className="cursor-pointer" style={{ padding: '3px 8px', fontSize: 11, border: '1px solid #D5D9DE', color: '#0F0F10', borderRadius: 4, background: 'none' }}>
                Edit
              </button>
              <button onClick={() => setHistoryTransferId(t.id)}
                className="cursor-pointer" style={{ padding: '3px 8px', fontSize: 11, border: '1px solid #D5D9DE', color: '#6B7280', borderRadius: 4, background: 'none' }}>
                History
              </button>
            </div>
          </div>
        );
      })}

      {/* Sold Modal */}
      <Modal open={!!soldModal} onClose={() => setSoldModal(null)} title="Record Sale" width={400}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Input required label="SALE PRICE (BHD)" type="number" value={soldPrice || ''} onChange={e => setSoldPrice(Number(e.target.value))} />
          <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setSoldModal(null)}>Cancel</Button>
            <Button variant="primary" onClick={() => {
              if (soldModal && soldPrice > 0) { markTransferSold(soldModal, soldPrice); setSoldModal(null); }
            }} disabled={soldPrice <= 0}>Confirm Sale</Button>
          </div>
        </div>
      </Modal>

      {/* Settle Modal */}
      <Modal open={!!settleModal} onClose={() => setSettleModal(null)} title="Settle with Agent" width={420}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {settleModal && (() => {
            const t = findTransfer(settleModal);
            if (!t) return null;
            const linkedInv = t.invoiceId ? invoices.find(i => i.id === t.invoiceId) : undefined;
            const amount = linkedInv ? linkedInv.grossAmount : ((t.settlementAmount ?? t.actualSalePrice ?? t.agentPrice) || 0);
            const prevPaid = linkedInv
              ? (linkedInv.paidAmount || 0)
              : (t.settlementStatus === 'partial' ? (t.settlementPaidAmount || 0) : 0);
            const remaining = Math.max(0, amount - prevPaid);
            return (
              <>
                {linkedInv && (
                  <div style={{
                    padding: '8px 12px', borderRadius: 8, background: 'rgba(113,93,227,0.06)',
                    border: '1px solid rgba(113,93,227,0.25)', fontSize: 11, color: '#4B5563', lineHeight: 1.5,
                  }}>
                    <strong style={{ color: '#0F0F10' }}>Wird in Invoice {linkedInv.invoiceNumber} gebucht.</strong>
                    {' '}Kein zweiter Topf — sobald die Invoice bezahlt ist, ist auch der Transfer fertig.
                  </div>
                )}
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
              </>
            );
          })()}
          <div>
            <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>PAYMENT TYPE</span>
            <div className="flex gap-2">
              {[{ id: false, label: 'Full Payment' }, { id: true, label: 'Partial Payment' }].map(o => (
                <button key={String(o.id)} onClick={() => setSettlePartial(o.id)}
                  className="cursor-pointer rounded"
                  style={{ padding: '7px 14px', fontSize: 12,
                    border: `1px solid ${settlePartial === o.id ? '#0F0F10' : '#D5D9DE'}`,
                    color: settlePartial === o.id ? '#0F0F10' : '#6B7280',
                    background: settlePartial === o.id ? 'rgba(15,15,16,0.06)' : 'transparent',
                  }}>{o.label}</button>
              ))}
            </div>
          </div>
          {settlePartial && (
            <Input required label="AMOUNT (BHD)" type="number" value={settleAmount}
              onChange={e => setSettleAmount(e.target.value)} />
          )}
          <div>
            <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>RECEIVED INTO</span>
            <div className="flex gap-2">
              {(['cash', 'bank'] as const).map(m => (
                <button key={m} onClick={() => setSettleMethod(m)}
                  className="cursor-pointer rounded transition-all"
                  style={{ padding: '8px 16px', fontSize: 13,
                    border: `1px solid ${settleMethod === m ? '#0F0F10' : '#D5D9DE'}`,
                    color: settleMethod === m ? '#0F0F10' : '#6B7280',
                    background: settleMethod === m ? 'rgba(15,15,16,0.06)' : 'transparent',
                  }}>{m === 'cash' ? 'Cash' : 'Bank'}</button>
              ))}
            </div>
            <p style={{ fontSize: 11, color: '#6B7280', marginTop: 4 }}>
              Der Agent zahlt uns aus — Geld kommt rein.
            </p>
          </div>
          <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
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

      {/* Convert Modal */}
      <Modal open={!!convertModal} onClose={() => setConvertModal(null)} title="Convert Transfer to Invoice" width={460}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {convertModal && (() => {
            const t = findTransfer(convertModal);
            if (!t) return null;
            const agent = agents.find(a => a.id === t.agentId);
            const settlement = t.settlementAmount || 0;
            return (
              <>
                <div style={{ padding: '10px 14px', background: '#F7F5EE', borderRadius: 8, fontSize: 12 }}>
                  <div className="flex justify-between" style={{ marginBottom: 4 }}>
                    <span style={{ color: '#6B7280' }}>Transfer</span>
                    <span className="font-mono" style={{ color: '#0F0F10' }}>{t.transferNumber}</span>
                  </div>
                  <div className="flex justify-between" style={{ marginBottom: 4 }}>
                    <span style={{ color: '#6B7280' }}>Agent</span>
                    <span style={{ color: '#0F0F10' }}>{agent?.name || '—'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span style={{ color: '#6B7280' }}>Settlement (Forderung)</span>
                    <span className="font-mono" style={{ color: '#0F0F10' }}>{fmt(settlement)} BHD</span>
                  </div>
                </div>
                <p style={{ fontSize: 12, color: '#6B7280' }}>
                  Diese Forderung an den Agent wird als reguläre Invoice angelegt.
                  Wähle einen bestehenden Customer oder lass automatisch einen aus den Agent-Daten anlegen.
                </p>
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
              </>
            );
          })()}
          <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setConvertModal(null)}>Cancel</Button>
            <Button variant="primary" onClick={handleConvertConfirm}>
              <FileText size={14} /> Create Invoice
            </Button>
          </div>
        </div>
      </Modal>

      {/* Edit Transfer Modal */}
      <Modal open={!!editTransfer} onClose={() => setEditTransfer(null)} title={`Edit Transfer — ${editTransfer?.transferNumber || ''}`} width={460}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Input required label="AGENT PRICE (BHD)" type="number" value={editTransferForm.agentPrice ?? ''}
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
                    border: `1px solid ${(editTransferForm.commissionType ?? 'percent') === t ? '#0F0F10' : '#D5D9DE'}`,
                    color: (editTransferForm.commissionType ?? 'percent') === t ? '#0F0F10' : '#6B7280',
                    background: (editTransferForm.commissionType ?? 'percent') === t ? 'rgba(15,15,16,0.06)' : 'transparent',
                  }}>{t === 'percent' ? 'Percent' : 'Fixed'}</button>
              ))}
            </div>
          </div>
          {(editTransferForm.commissionType ?? 'percent') === 'percent' ? (
            <Input required label="COMMISSION %" type="number" value={editTransferForm.commissionRate ?? ''}
              onChange={e => setEditTransferForm({ ...editTransferForm, commissionRate: Number(e.target.value) || 0 })} />
          ) : (
            <Input required label="COMMISSION FIXED (BHD)" type="number" value={editTransferForm.commissionValue ?? ''}
              onChange={e => setEditTransferForm({ ...editTransferForm, commissionValue: Number(e.target.value) || 0 })} />
          )}
          <Input label="RETURN BY (DATE)" type="date" value={(editTransferForm.returnBy || '').split('T')[0]}
            onChange={e => setEditTransferForm({ ...editTransferForm, returnBy: e.target.value })} />
          <div>
            <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>NOTES</span>
            <textarea value={editTransferForm.notes || ''}
              onChange={e => setEditTransferForm({ ...editTransferForm, notes: e.target.value })}
              rows={3}
              style={{ width: '100%', background: 'transparent', border: '1px solid #D5D9DE', borderRadius: 6, padding: '8px 10px', fontSize: 13, color: '#0F0F10' }} />
          </div>
          <div className="flex justify-between gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
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

      {/* Bulk Combined-Invoice Modal */}
      <Modal open={bulkModal} onClose={() => setBulkModal(false)} title="Create Combined Invoice" width={520}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {(() => {
            if (selectedTransfers.length === 0) {
              return <p style={{ fontSize: 12, color: '#6B7280' }}>No transfers selected.</p>;
            }
            const agent = agents.find(a => a.id === selectedTransfers[0].agentId);
            return (
              <>
                <div style={{ padding: '10px 14px', background: '#F7F5EE', borderRadius: 8, fontSize: 12 }}>
                  <div className="flex justify-between" style={{ marginBottom: 4 }}>
                    <span style={{ color: '#6B7280' }}>Approval</span>
                    <span style={{ color: '#0F0F10' }}>{agent?.name || '—'}</span>
                  </div>
                  <div className="flex justify-between" style={{ marginBottom: 4 }}>
                    <span style={{ color: '#6B7280' }}>Items</span>
                    <span className="font-mono" style={{ color: '#0F0F10' }}>{selectedTransfers.length}</span>
                  </div>
                  <div className="flex justify-between">
                    <span style={{ color: '#6B7280' }}>Combined Settlement</span>
                    <span className="font-mono" style={{ color: '#0F0F10' }}>{fmt(selectedTotal)} BHD</span>
                  </div>
                </div>

                <div style={{ maxHeight: 180, overflowY: 'auto', border: '1px solid #E5E9EE', borderRadius: 6 }}>
                  {selectedTransfers.map(t => {
                    const product = products.find(p => p.id === t.productId);
                    return (
                      <div key={t.id} style={{
                        display: 'grid', gridTemplateColumns: '110px 1fr auto',
                        gap: 8, padding: '8px 12px', alignItems: 'center', fontSize: 12,
                        borderBottom: '1px solid rgba(229,225,214,0.6)',
                      }}>
                        <span className="font-mono" style={{ color: '#4B5563', fontSize: 11 }}>{t.transferNumber}</span>
                        <span style={{ color: '#0F0F10', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {product ? `${product.brand} ${product.name}` : '—'}
                        </span>
                        <span className="font-mono" style={{ color: '#0F0F10' }}>
                          {fmt(t.settlementAmount || 0)} BHD
                        </span>
                      </div>
                    );
                  })}
                </div>

                <p style={{ fontSize: 12, color: '#6B7280' }}>
                  Diese {selectedTransfers.length} Items werden zu EINER Multi-Line-Invoice zusammengefasst.
                  Jeder Transfer wird mit der neuen Invoice verknüpft — keine doppelte Konvertierung mehr möglich.
                </p>

                <div>
                  <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>BILL TO</span>
                  <div className="flex gap-2" style={{ marginBottom: 10 }}>
                    {(['existing', 'auto'] as const).map(m => (
                      <button key={m} onClick={() => setBulkMode(m)}
                        className="cursor-pointer rounded transition-all"
                        style={{ padding: '7px 14px', fontSize: 12,
                          border: `1px solid ${bulkMode === m ? '#0F0F10' : '#D5D9DE'}`,
                          color: bulkMode === m ? '#0F0F10' : '#6B7280',
                          background: bulkMode === m ? 'rgba(15,15,16,0.06)' : 'transparent',
                        }}>{m === 'existing' ? 'Pick existing customer' : 'Auto-create from agent'}</button>
                    ))}
                  </div>
                  {bulkMode === 'existing' ? (
                    <SearchSelect
                      placeholder="Search customers…"
                      options={customerOptions}
                      value={bulkCustomerId}
                      onChange={setBulkCustomerId}
                    />
                  ) : (
                    <div style={{ padding: '10px 14px', background: '#F2F7FA', border: '1px solid #E5E9EE', borderRadius: 6, fontSize: 12, color: '#4B5563' }}>
                      Wird angelegt: <strong style={{ color: '#0F0F10' }}>{agent?.name}</strong>
                      {agent?.company ? ` · ${agent.company}` : ''}
                      {agent?.phone ? ` · ${agent.phone}` : ''}
                    </div>
                  )}
                </div>
              </>
            );
          })()}

          {bulkError && (
            <div style={{ padding: '8px 12px', background: 'rgba(220,38,38,0.06)', border: '1px solid rgba(220,38,38,0.3)', borderRadius: 6, fontSize: 12, color: '#DC2626' }}>
              {bulkError}
            </div>
          )}

          <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setBulkModal(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleBulkConfirm} disabled={!sameAgent || validSelectedIds.size === 0}>
              <FileText size={14} /> Create Invoice
            </Button>
          </div>
        </div>
      </Modal>

      {/* History Drawer */}
      <HistoryDrawer
        open={!!historyTransferId}
        onClose={() => setHistoryTransferId(null)}
        entityType="agent_transfers"
        entityId={historyTransferId || ''}
        title="Transfer History"
      />
    </div>
  );
}
