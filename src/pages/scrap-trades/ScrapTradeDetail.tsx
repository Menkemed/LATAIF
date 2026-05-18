// Plan §Scrap Gold Quick Trade — Detail-View mit View/Edit/Cancel.

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Edit2, Ban, Trash2 } from 'lucide-react';
import { PageLayout } from '@/components/layout/PageLayout';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { ScrapTradeForm } from './ScrapTradeForm';
import { useScrapTradeStore, type ScrapTradeInput } from '@/stores/scrapTradeStore';

export function ScrapTradeDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { trades, loadTrades, updateTrade, cancelTrade, deleteTrade } = useScrapTradeStore();
  const [editing, setEditing] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => { if (trades.length === 0) loadTrades(); }, [trades.length, loadTrades]);

  const trade = id ? trades.find(t => t.id === id) : undefined;

  if (!trade) {
    return (
      <PageLayout
        title="Trade not found"
        actions={<Button icon={<ArrowLeft size={14} />} onClick={() => navigate('/scrap-trades')}>Back</Button>}
      >
        <div style={{ maxWidth: 600, margin: '40px auto', textAlign: 'center', color: '#6B7280' }}>
          The trade you're looking for doesn't exist or was deleted.
        </div>
      </PageLayout>
    );
  }

  function handleSubmit(values: ScrapTradeInput) {
    if (!trade) return;
    updateTrade(trade.id, values);
    setEditing(false);
  }

  const isCancelled = trade.status === 'cancelled';
  const profitStr = trade.profit.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  const subtitle = isCancelled
    ? `Profit ${profitStr} BHD · CANCELLED`
    : `Profit ${profitStr} BHD`;

  return (
    <PageLayout
      title={`Trade ${trade.tradeNumber}`}
      subtitle={subtitle}
      actions={
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="ghost" icon={<ArrowLeft size={14} />} onClick={() => navigate('/scrap-trades')}>Back</Button>
          {!isCancelled && !editing && (
            <>
              <Button variant="secondary" icon={<Edit2 size={14} />} onClick={() => setEditing(true)}>Edit</Button>
              <Button variant="danger" icon={<Ban size={14} />} onClick={() => setConfirmCancel(true)}>Cancel Trade</Button>
            </>
          )}
          {isCancelled && (
            <Button variant="danger" icon={<Trash2 size={14} />} onClick={() => setConfirmDelete(true)}>Delete</Button>
          )}
        </div>
      }
    >
      <ScrapTradeForm
        initial={trade}
        submitLabel="Save Changes"
        onSubmit={handleSubmit}
        onCancel={() => setEditing(false)}
        disabled={!editing}
      />

      {/* Cancel-Confirm */}
      <Modal open={confirmCancel} onClose={() => setConfirmCancel(false)} title="Cancel this trade?">
        <div style={{ padding: '0 4px' }}>
          <p style={{ fontSize: 13, color: '#6B7280', lineHeight: 1.6 }}>
            The trade will be marked as <strong>cancelled</strong> and the ledger entry (Profit of{' '}
            <strong>{trade.profit.toFixed(3)} BHD</strong>) will be reversed. Photos and trade record stay for audit history.
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
            <Button variant="ghost" onClick={() => setConfirmCancel(false)}>Keep Active</Button>
            <Button variant="danger" onClick={() => { cancelTrade(trade.id); setConfirmCancel(false); }}>
              Yes, Cancel Trade
            </Button>
          </div>
        </div>
      </Modal>

      {/* Delete-Confirm (nur für cancelled) */}
      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete cancelled trade?">
        <div style={{ padding: '0 4px' }}>
          <p style={{ fontSize: 13, color: '#6B7280', lineHeight: 1.6 }}>
            This permanently removes the trade record from the database. The ledger reversal stays intact.
            This action <strong>cannot be undone</strong>.
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Keep Record</Button>
            <Button variant="danger" onClick={() => {
              deleteTrade(trade.id);
              setConfirmDelete(false);
              navigate('/scrap-trades');
            }}>
              Delete Permanently
            </Button>
          </div>
        </div>
      </Modal>
    </PageLayout>
  );
}
