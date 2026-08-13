// ════════════════════════════════════════════════════════════════════════════
// POST-V0838 §C — the inventory modal: check a whole shelf without opening a product.
//
// The single-product panel is right when you are already looking at an item. For a stocktake it is
// the wrong shape — open, judge, go back, open the next — and it has a second problem the operator
// hit for real: its buttons SAVE, so a mis-click is immediately a permanent history row. Nine such
// rows exist in the live database.
//
// So this is a sorting surface, not a form. Products move between three columns as a local draft
// and NOTHING is written until Save. Until then a wrong click costs one more click to undo.
//
// It cannot change a product: the only backend call it makes is `recordStockCheck`, the same core
// the phone and the detail panel use, and that has no path to `products`.
// ════════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { ProductHoverCard } from '@/components/products/ProductHoverCard';
import { useAuthStore } from '@/stores/authStore';
import {
  latestStockChecks,
  recordStockCheck,
  prepareNotes,
  stockCheckLabel,
  MAX_STOCK_CHECK_NOTES,
  type StockCheck,
  type StockCheckStatus,
} from '@/core/stock/stock-check';
import type { Product, Category } from '@/core/models/types';

interface DraftEntry { status: StockCheckStatus; notes: string }

export interface StockCheckInventoryModalProps {
  open: boolean;
  onClose: () => void;
  /** The operator's CURRENT working set — the Collection's filtered list, not the whole stock. */
  products: Product[];
  categories: Category[];
}

function when(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

export function StockCheckInventoryModal({ open, onClose, products, categories }: StockCheckInventoryModalProps) {
  const userId = useAuthStore(s => s.session?.userId);
  const [draft, setDraft] = useState<Map<string, DraftEntry>>(new Map());
  const [latest, setLatest] = useState<Record<string, StockCheck>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  /** One request id per product per save ATTEMPT — a retry of the same decision reuses it, so a
   *  double click or a re-save after a partial failure cannot produce a second history row. */
  const requestIds = useRef<Map<string, string>>(new Map());

  // Fresh draft every time the modal opens: a stocktake is a session, not a stored document.
  useEffect(() => {
    if (!open) return;
    setDraft(new Map());
    setSaved(new Set());
    setFailed(new Set());
    setMsg(null);
    setConfirmDiscard(false);
    requestIds.current = new Map();
    let cancelled = false;
    void latestStockChecks(products.map(p => p.id))
      .then(r => { if (!cancelled) setLatest(r); })
      .catch(() => { if (!cancelled) setLatest({}); });
    return () => { cancelled = true; };
  }, [open, products]);

  const assign = useCallback((id: string, status: StockCheckStatus) => {
    setDraft(prev => {
      const next = new Map(prev);
      const cur = next.get(id);
      next.set(id, { status, notes: cur?.notes ?? '' });
      return next;
    });
    setFailed(prev => { const n = new Set(prev); n.delete(id); return n; });
  }, []);

  const unassign = useCallback((id: string) => {
    setDraft(prev => { const next = new Map(prev); next.delete(id); return next; });
  }, []);

  const setNotes = useCallback((id: string, notes: string) => {
    setDraft(prev => {
      const next = new Map(prev);
      const cur = next.get(id);
      if (cur) next.set(id, { ...cur, notes });
      return next;
    });
  }, []);

  const pending = useMemo(() => products.filter(p => !draft.has(p.id)), [products, draft]);
  const inColumn = useCallback(
    (status: StockCheckStatus) => products.filter(p => draft.get(p.id)?.status === status),
    [products, draft],
  );
  const availables = useMemo(() => inColumn('available'), [inColumn]);
  const notAvailables = useMemo(() => inColumn('not_available'), [inColumn]);
  const unsaved = draft.size > saved.size;

  const save = async () => {
    if (saving) return;                                   // §F — a second click never starts a second run
    const entries = [...draft.entries()].filter(([id]) => !saved.has(id));
    if (entries.length === 0) { onClose(); return; }
    // Refuse the whole save on a note the backend would reject, rather than saving the rest and
    // silently dropping one note.
    for (const [id, e] of entries) {
      if (!prepareNotes(e.notes).ok) {
        setMsg({ text: `A note is longer than ${MAX_STOCK_CHECK_NOTES} characters.`, bad: true });
        setFailed(new Set([id]));
        return;
      }
    }
    setSaving(true);
    setMsg(null);
    const ok = new Set(saved);
    const bad = new Set<string>();
    for (const [id, e] of entries) {
      let rid = requestIds.current.get(id);
      if (!rid) { rid = crypto.randomUUID(); requestIds.current.set(id, rid); }
      try {
        await recordStockCheck({
          productId: id,
          status: e.status,
          notes: prepareNotes(e.notes).ok ? (prepareNotes(e.notes) as { value: string | null }).value : null,
          userId,
          requestId: rid,
        });
        ok.add(id);
      } catch {
        bad.add(id);
      }
    }
    setSaved(ok);
    setFailed(bad);
    setSaving(false);
    if (bad.size === 0) {
      onClose();
      return;
    }
    // §F — never close on a partial result. The modal stays open with the failures marked, and
    // pressing Save again retries ONLY those, under the same request ids.
    setMsg({
      text: `${ok.size} of ${draft.size} saved — ${bad.size} failed. The failed items are marked; press Save to retry them.`,
      bad: true,
    });
  };

  const attemptClose = () => {
    if (unsaved && !saving) { setConfirmDiscard(true); return; }   // §C6 — never lose a draft silently
    onClose();
  };

  const row = (p: Product, column: 'pending' | StockCheckStatus) => {
    const entry = draft.get(p.id);
    const last = latest[p.id];
    const isSaved = saved.has(p.id);
    const isFailed = failed.has(p.id);
    return (
      <div
        key={p.id}
        data-inv-row={p.id}
        onMouseEnter={e => setHover({ id: p.id, x: e.clientX, y: e.clientY })}
        onMouseMove={e => setHover(h => (h && h.id === p.id ? { id: p.id, x: e.clientX, y: e.clientY } : h))}
        onMouseLeave={() => setHover(h => (h && h.id === p.id ? null : h))}
        style={{
          borderTop: '1px solid rgba(255,255,255,0.06)',
          padding: '6px 8px',
          background: isFailed ? 'rgba(170,110,110,0.12)' : undefined,
          opacity: isSaved ? 0.55 : 1,
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <div style={{ minWidth: 0 }}>
            <div className="text-xs" style={{ fontFamily: 'monospace', color: '#8A8A93' }}>{p.sku || '—'}</div>
            <div className="text-sm" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              <span className="text-gray-400">{p.brand}</span> {p.name}
            </div>
            {/* §C9 — the last check is context, not a classification: a product checked yesterday
                is still offered for checking today. */}
            {last && (
              <div className="text-[11px]" style={{ color: last.status === 'available' ? '#7FA87F' : '#AA6E6E' }}>
                {stockCheckLabel(last.status)} · {when(last.checked_at)}
              </div>
            )}
          </div>
          <div className="flex items-center gap-1" style={{ flex: '0 0 auto' }}>
            {column === 'pending' ? (
              <>
                <button data-inv-yes={p.id} title="Available" disabled={saving}
                  onClick={() => assign(p.id, 'available')}
                  className="px-2 py-1 rounded" style={{ border: '1px solid #2A2A32', color: '#7FA87F' }}>✓</button>
                <button data-inv-no={p.id} title="Not available" disabled={saving}
                  onClick={() => assign(p.id, 'not_available')}
                  className="px-2 py-1 rounded" style={{ border: '1px solid #2A2A32', color: '#AA6E6E' }}>✗</button>
              </>
            ) : (
              <>
                <button data-inv-flip={p.id} disabled={saving || isSaved}
                  title={column === 'available' ? 'Move to Not available' : 'Move to Available'}
                  onClick={() => assign(p.id, column === 'available' ? 'not_available' : 'available')}
                  className="px-2 py-1 rounded" style={{ border: '1px solid #2A2A32', color: '#8A8A93' }}>
                  {column === 'available' ? '✗' : '✓'}
                </button>
                <button data-inv-undo={p.id} title="Back to unchecked" disabled={saving || isSaved}
                  onClick={() => unassign(p.id)}
                  className="px-2 py-1 rounded" style={{ border: '1px solid #2A2A32', color: '#8A8A93' }}>↩</button>
              </>
            )}
          </div>
        </div>
        {/* §C7 — the note sits WITH the decision it belongs to, and is editable until Save. */}
        {entry && !isSaved && (
          <input
            data-inv-note={p.id}
            type="text"
            value={entry.notes}
            maxLength={MAX_STOCK_CHECK_NOTES}
            disabled={saving}
            onChange={e => setNotes(p.id, e.target.value)}
            placeholder="Note (optional)"
            className="w-full bg-black/30 border border-white/10 rounded px-2 py-1 text-xs mt-1"
          />
        )}
      </div>
    );
  };

  const column = (title: string, items: Product[], kind: 'pending' | StockCheckStatus, colour?: string) => (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8 }}>
      <div className="text-[11px] uppercase tracking-wider px-2 py-2" style={{ color: colour || '#6B6B73' }}>
        {title} <span style={{ color: '#6B6B73' }}>({items.length})</span>
      </div>
      <div data-inv-col={kind} style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
        {items.length === 0
          ? <div className="text-xs px-2 py-3" style={{ color: '#4B4B53' }}>—</div>
          : items.map(p => row(p, kind))}
      </div>
    </div>
  );

  const hovered = hover ? products.find(p => p.id === hover.id) : null;

  return (
    <>
      <Modal open={open} onClose={attemptClose} title="Stock check" width={1180}>
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm" data-inv-progress>
            <strong>{draft.size}</strong> / {products.length} checked
            <span className="text-gray-500"> · {pending.length} remaining · {availables.length} available · {notAvailables.length} not available</span>
          </div>
          <div className="text-xs text-gray-500">Nothing is saved until you press Save.</div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, height: '58vh' }}>
          {column('To check', pending, 'pending')}
          {column('Available', availables, 'available', '#7FA87F')}
          {column('Not available', notAvailables, 'not_available', '#AA6E6E')}
        </div>

        {msg && <div className={`text-xs mt-3 ${msg.bad ? 'text-red-400' : 'text-emerald-400'}`}>{msg.text}</div>}

        <div className="flex items-center justify-end gap-2 mt-4">
          <Button variant="ghost" onClick={attemptClose} disabled={saving}>Cancel</Button>
          <Button data-testid="inv-save" onClick={() => void save()} disabled={saving || draft.size === 0}>
            {saving ? 'Saving…' : `Save stock check (${draft.size - saved.size})`}
          </Button>
        </div>
      </Modal>

      {/* §C3 — the SAME hover card the pickers use, so the preview cannot drift from theirs. */}
      {open && hovered && !confirmDiscard && (
        <div style={{
          position: 'fixed',
          left: Math.min(hover!.x + 18, window.innerWidth - 340),
          top: Math.min(hover!.y + 12, window.innerHeight - 320),
          // above the modal's own 9999 — a preview that renders behind the dialog is no preview
          zIndex: 10050,
          pointerEvents: 'none',
        }}>
          <ProductHoverCard product={hovered} categories={categories} />
        </div>
      )}

      <Modal open={confirmDiscard} onClose={() => setConfirmDiscard(false)} title="Unsaved stock check" width={460}>
        <div className="text-sm mb-4">
          You have unsaved stock-check changes. Closing now discards them — nothing has been written yet.
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirmDiscard(false)}>Continue editing</Button>
          <Button data-testid="inv-discard" onClick={() => { setConfirmDiscard(false); onClose(); }}>Discard</Button>
        </div>
      </Modal>
    </>
  );
}
