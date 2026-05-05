// Plan §Agent §Detail (User-Spec): Approval-Account-Detailseite.
// Zeigt: Header (Name + Status), KPIs (Total Given/Sold/Paid/Outstanding),
// Items via geteilter TransferTable (gleiche Render-/Action-Logik wie der
// Transfers-Tab in AgentList — durch Zustand-Store automatisch synchron).
import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Edit3, History as HistoryIcon, Mail, Phone } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { TransferTable } from '@/components/agents/TransferTable';
import { useAgentStore } from '@/stores/agentStore';
import { useCustomerStore } from '@/stores/customerStore';
import { useProductStore } from '@/stores/productStore';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { HistoryDrawer } from '@/components/shared/HistoryPanel';

function fmt(v: number): string {
  return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export function AgentDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { agents, transfers, loadAgents, loadTransfers } = useAgentStore();
  const { customers, loadCustomers } = useCustomerStore();
  const { loadProducts } = useProductStore();
  const { invoices, loadInvoices } = useInvoiceStore();
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    loadAgents(); loadTransfers(); loadCustomers(); loadProducts(); loadInvoices();
  }, [loadAgents, loadTransfers, loadCustomers, loadProducts, loadInvoices]);

  const agent = useMemo(() => agents.find(a => a.id === id), [agents, id]);
  const linkedCustomer = useMemo(
    () => agent?.customerId ? customers.find(c => c.id === agent.customerId) : undefined,
    [agent, customers],
  );

  const myTransfers = useMemo(
    () => transfers.filter(t => t.agentId === id),
    [transfers, id],
  );

  const stats = useMemo(() => {
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
    const isActive = activeTransfers.length > 0;
    return { activeCount: activeTransfers.length, totalGiven, totalSold, totalPaid, outstanding, isActive };
  }, [myTransfers, invoices]);

  if (!agent) {
    return (
      <div className="app-content flex items-center justify-center" style={{ background: '#FFFFFF', minHeight: '100vh' }}>
        <p style={{ color: '#6B7280' }}>Approval not found</p>
      </div>
    );
  }

  return (
    <div className="app-content" style={{ background: '#FFFFFF' }}>
      <div style={{ padding: '32px 48px 64px', maxWidth: 1200 }}>
        {/* Header */}
        <button onClick={() => navigate('/agents')}
          className="flex items-center gap-2 cursor-pointer transition-colors"
          style={{ background: 'none', border: 'none', color: '#6B7280', fontSize: 13, marginBottom: 12 }}>
          <ArrowLeft size={16} /> Approvals
        </button>

        <div className="flex items-start justify-between" style={{ marginBottom: 28 }}>
          <div>
            <div className="flex items-center gap-3" style={{ marginBottom: 6 }}>
              <h1 className="font-display" style={{ fontSize: 28, color: '#0F0F10' }}>{agent.name}</h1>
              <span style={{
                fontSize: 11, padding: '4px 12px', borderRadius: 999,
                background: stats.isActive ? 'rgba(126,170,110,0.10)' : 'rgba(107,114,128,0.10)',
                color: stats.isActive ? '#5C8550' : '#6B7280',
                border: `1px solid ${stats.isActive ? 'rgba(126,170,110,0.4)' : 'rgba(107,114,128,0.3)'}`,
              }}>
                {stats.isActive ? 'Active' : 'Inactive'}
              </span>
            </div>
            <div className="flex items-center gap-4" style={{ fontSize: 13, color: '#6B7280' }}>
              {agent.company && <span>{agent.company}</span>}
              {agent.phone && <span className="flex items-center gap-1"><Phone size={12} />{agent.phone}</span>}
              {agent.email && <span className="flex items-center gap-1"><Mail size={12} />{agent.email}</span>}
              <span>· {agent.commissionRate}% commission</span>
            </div>
            {linkedCustomer && (
              <button onClick={() => navigate(`/clients/${linkedCustomer.id}`)}
                className="cursor-pointer" style={{ marginTop: 6, background: 'none', border: 'none', color: '#0F0F10', fontSize: 12, padding: 0 }}>
                Linked customer: {linkedCustomer.firstName} {linkedCustomer.lastName} →
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setShowHistory(true)}>
              <HistoryIcon size={14} /> History
            </Button>
            <Button variant="secondary" onClick={() => navigate('/agents')}>
              <Edit3 size={14} /> Edit
            </Button>
          </div>
        </div>

        {/* KPIs */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 28 }}>
          <Card>
            <div style={{ fontSize: 10, color: '#6B7280', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 6 }}>Total Given</div>
            <div className="font-display" style={{ fontSize: 24, color: '#0F0F10' }}>
              {fmt(stats.totalGiven)} <span style={{ fontSize: 13, color: '#6B7280' }}>BHD</span>
            </div>
            <div style={{ fontSize: 11, color: '#6B7280', marginTop: 4 }}>{stats.activeCount} item(s) currently with this client</div>
          </Card>
          <Card>
            <div style={{ fontSize: 10, color: '#6B7280', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 6 }}>Total Sold</div>
            <div className="font-display" style={{ fontSize: 24, color: '#0F0F10' }}>
              {fmt(stats.totalSold)} <span style={{ fontSize: 13, color: '#6B7280' }}>BHD</span>
            </div>
          </Card>
          <Card>
            <div style={{ fontSize: 10, color: '#6B7280', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 6 }}>Total Paid</div>
            <div className="font-display" style={{ fontSize: 24, color: '#7EAA6E' }}>
              {fmt(stats.totalPaid)} <span style={{ fontSize: 13, color: '#6B7280' }}>BHD</span>
            </div>
          </Card>
          <Card>
            <div style={{ fontSize: 10, color: '#6B7280', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 6 }}>Outstanding</div>
            <div className="font-display" style={{ fontSize: 24, color: stats.outstanding > 0 ? '#AA6E6E' : '#6B7280' }}>
              {fmt(stats.outstanding)} <span style={{ fontSize: 13, color: '#6B7280' }}>BHD</span>
            </div>
          </Card>
        </div>

        {/* Items / Transfers — geteilte Komponente, gefiltert auf diesen Klient.
            Sync: Wenn der User hier auf "Sold" klickt, wird der Zustand-Store
            geupdated und der Transfers-Tab in AgentList sieht das sofort. */}
        <div style={{ marginBottom: 16 }}>
          <h2 className="font-display" style={{ fontSize: 18, color: '#0F0F10', marginBottom: 12 }}>Items</h2>
          <TransferTable
            transfers={myTransfers}
            showAgentColumn={false}
            emptyMessage="Noch keine Items übergeben."
          />
        </div>

        {/* Notes */}
        {agent.notes && (
          <Card>
            <span className="text-overline" style={{ marginBottom: 8, display: 'block' }}>NOTES</span>
            <p style={{ fontSize: 13, color: '#4B5563', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{agent.notes}</p>
          </Card>
        )}
      </div>

      <HistoryDrawer
        open={showHistory}
        onClose={() => setShowHistory(false)}
        entityType="agents"
        entityId={agent.id}
        title={`History · ${agent.name}`}
      />
    </div>
  );
}
