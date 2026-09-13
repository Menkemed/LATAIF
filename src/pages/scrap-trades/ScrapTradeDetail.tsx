// Plan §Scrap Gold Quick Trade — Detail-View mit View/Edit/Cancel.
//
// CENTRAL-UI-PARITY R6D — „Save Changes" und „Yes, Cancel Trade" sind je EINE Buchung
// (`scrap_trades.update` / `scrap_trades.cancel`) gegen die Fassung, die diese Seite geladen hat.

import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Edit2, Ban, Trash2 } from 'lucide-react';
import { PageLayout } from '@/components/layout/PageLayout';
import { Button } from '@/components/ui/Button';
import { primaryOnlyDeleteProps, blockDeleteOnClient } from '@/core/data/primary-only';
import { Modal } from '@/components/ui/Modal';
import { WriteError } from '@/components/shared/WriteError';
import { ScrapTradeForm } from './ScrapTradeForm';
import { useScrapTradeStore, type ScrapTradeInput } from '@/stores/scrapTradeStore';
import { useSharedWrites } from '@/core/data/shared-write';
import { StagingUploadError } from '@/core/bridge/client-staging-upload';
import {
  cancelScrapTradeOnPrimary, scrapCancelBody, scrapUpdateBody, stageScrapPhotos, updateScrapTradeOnPrimary,
  type StagedScrapPhotos,
} from '@/core/metals/metal-actions';

export function ScrapTradeDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { trades, loadTrades, deleteTrade } = useScrapTradeStore();
  const w = useSharedWrites();
  const [editing, setEditing] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const laeuft = useRef(false);

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

  async function handleSubmit(values: ScrapTradeInput) {
    if (!trade || laeuft.current) return;
    const t = trade;
    laeuft.current = true;
    setBusy(true);
    try {
      let staged: StagedScrapPhotos[] = [];
      if (w.remote) {
        try {
          staged = await stageScrapPhotos(values);
        } catch (e) {
          alert(`The photos could not be handed to the main computer (${e instanceof StagingUploadError ? e.code : String(e)}). Nothing was saved — please try again.`);
          return;
        }
      }
      if (!await w.ok('scrap_trades.update', {
        local: () => updateScrapTradeOnPrimary(t.id, t.version, values),
        remote: () => scrapUpdateBody(t.id, t.version, values, staged),
      })) return;
      loadTrades();
      setEditing(false);
    } finally {
      laeuft.current = false;
      setBusy(false);
    }
  }

  async function handleCancelTrade() {
    if (!trade) return;
    const t = trade;
    if (!await w.ok('scrap_trades.cancel', {
      local: () => cancelScrapTradeOnPrimary(t.id, t.version),
      remote: () => scrapCancelBody(t.id, t.version),
    })) return;
    loadTrades();
    setConfirmCancel(false);
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
              <Button variant="secondary" icon={<Edit2 size={14} />} onClick={() => { w.clear(); setEditing(true); }} data-scrap-edit-open>Edit</Button>
              <Button variant="danger" icon={<Ban size={14} />} onClick={() => { w.clear(); setConfirmCancel(true); }} data-scrap-cancel-open>Cancel Trade</Button>
            </>
          )}
          {isCancelled && (
            <Button variant="danger" icon={<Trash2 size={14} />} {...primaryOnlyDeleteProps()} onClick={() => setConfirmDelete(true)}>Delete</Button>
          )}
        </div>
      }
    >
      {!confirmCancel && <WriteError text={w.fehler} />}
      <ScrapTradeForm
        key={`${trade.id}:${trade.version}`}
        initial={trade}
        submitLabel="Save Changes"
        onSubmit={handleSubmit}
        onCancel={() => setEditing(false)}
        disabled={!editing}
        busy={busy || w.busy}
      />

      {/* Cancel-Confirm */}
      <Modal open={confirmCancel} onClose={() => setConfirmCancel(false)} title="Cancel this trade?">
        <div style={{ padding: '0 4px' }}>
          <p style={{ fontSize: 13, color: '#6B7280', lineHeight: 1.6 }}>
            The trade will be marked as <strong>cancelled</strong> and the ledger entry (Profit of{' '}
            <strong>{trade.profit.toFixed(3)} BHD</strong>) will be reversed. Photos and trade record stay for audit history.
          </p>
          <WriteError text={w.fehler} />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
            <Button variant="ghost" onClick={() => setConfirmCancel(false)}>Keep Active</Button>
            <Button variant="danger" onClick={() => void handleCancelTrade()} disabled={w.busy} data-scrap-cancel-confirm>
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
              if (blockDeleteOnClient()) { setConfirmDelete(false); return; }
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
