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
import { createPortal } from 'react-dom';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { ProductHoverCard } from '@/components/products/ProductHoverCard';
import { useAuthStore } from '@/stores/authStore';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { currentBranchId } from '@/core/db/helpers';
import {
  loadOpenSession, ensureOpenSession, persistSessionItems, closeSession, itemsNeedingHistory,
  mergeExternalChecks, isDecided, lastFinishedAt, startForNewRun,
  type InventorySessionDb, type SessionItem,
} from '@/core/stock/inventory-session';
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
  const branchId = currentBranchId();
  const [draft, setDraft] = useState<Map<string, DraftEntry>>(new Map());
  const [latest, setLatest] = useState<Record<string, StockCheck>>({});
  const [saving, setSaving] = useState(false);
  // What the worksheet last recorded, per product. This is the SAVED state, and it is what makes a
  // second Save write nothing while a corrected verdict still writes a new observation.
  const [persisted, setPersisted] = useState<Map<string, SessionItem>>(new Map());
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  /** One request id per product per save ATTEMPT — a retry of the same decision reuses it, so a
   *  double click or a re-save after a partial failure cannot produce a second history row. */
  const requestIds = useRef<Map<string, string>>(new Map());
  /** Set as soon as the operator moves a card. A background fold-in must not overwrite live work. */
  const touched = useRef(false);
  /** How many cards the phone filled in for this open — shown to the operator, and the one
   *  honest signal that the cross-surface fold-in ran at all. */
  const [foldedIn, setFoldedIn] = useState<string>('');
  /** When the run in progress was started — shown to the operator so an inventory left open for
   *  days is obvious rather than a surprise. */
  const [runStartedAt, setRunStartedAt] = useState<string>('');

  // Fresh draft every time the modal opens: a stocktake is a session, not a stored document.
  useEffect(() => {
    if (!open) return;
    // INVENTORY-SESSION — reopen where the operator stopped, even days later. The worksheet is the
    // truth about the RUN; the columns are rebuilt from it instead of starting blank.
    //
    // Opening the dialog is what STARTS an inventory. That is the deliberate act the merge boundary
    // needs: without a start there is no window, and a phone check would either be ignored forever
    // or drag the whole history into a fresh run. Only "Finish inventory" ends it.
    const restored = new Map<string, DraftEntry>();
    const before = new Map<string, SessionItem>();
    let sid: string | null = null;
    let startedAt = '';
    try {
      const db = getDatabase() as unknown as InventorySessionDb;
      // A run that is already open is picked up as it stands. One that is NOT open yet is left
      // uncreated for now: where it should start depends on what the phone has already recorded,
      // and that answer only arrives with the history read below.
      const s = loadOpenSession(db, branchId);
      sid = s ? s.sessionId : null;
      if (s) {
        startedAt = s.startedAt;
        for (const it of s.items) {
          if (isDecided(it.status)) restored.set(it.productId, { status: it.status as StockCheckStatus, notes: it.notes });
          before.set(it.productId, it);
        }
      }
    } catch { /* no worksheet readable — start blank rather than block the run */ }
    setSessionId(sid);
    setRunStartedAt(startedAt);
    setPersisted(before);
    setDraft(restored);
    setSaved(new Set([...before.values()].filter(i => isDecided(i.status)).map(i => i.productId)));
    setFailed(new Set());
    setMsg(null);
    setConfirmDiscard(false);
    requestIds.current = new Map();
    touched.current = false;
    setLatest({});
    setFoldedIn('');
    let cancelled = false;
    void latestStockChecks(products.map(p => p.id))
      .then(async r => {
        if (cancelled) return;
        setLatest(r);
        // CROSS-SURFACE — a verdict recorded on the phone during THIS run belongs in these columns,
        // not only in the history strip. Skipped once the operator has started clicking: their live
        // work outranks a background fold-in, and the next open will pick it up anyway.
        if (touched.current) { setFoldedIn('busy'); return; }
        const external = Object.values(r);
        if (!sid) {
          // OPENING A RUN THAT THE PHONE ALREADY BEGAN — the operator walked the shelf with the
          // phone and is only now sitting down. Those checks belong to the run about to open, so it
          // starts at the earliest of them rather than at this moment, which would leave every one
          // of them on the wrong side of the boundary. With nothing to pick up it simply starts now.
          try {
            const db = getDatabase() as unknown as InventorySessionDb;
            const begin = startForNewRun(external, lastFinishedAt(db, branchId)) ?? new Date().toISOString();
            sid = ensureOpenSession(db, branchId, begin, () => crypto.randomUUID());
            startedAt = begin;
            await saveDatabase();
            if (cancelled) return;
            setSessionId(sid);
            setRunStartedAt(begin);
          } catch { setFoldedIn('no-run'); return; }
        }
        if (!sid || !startedAt) { setFoldedIn('no-run'); return; }
        const merged = mergeExternalChecks([...before.values()], external, startedAt);
        if (merged.changed.length === 0) { setFoldedIn('0'); return; }
        const next = new Map(merged.items.map(i => [i.productId, i]));
        // Store BEFORE reporting it: a fold-in the operator can see but that never reached the disk
        // would be re-applied on the next open, which is harmless but dishonest to show as done.
        try {
          const db = getDatabase() as unknown as InventorySessionDb;
          persistSessionItems(db, sid, merged.items.filter(i => isDecided(i.status)), [], new Date().toISOString());
          await saveDatabase();
        } catch { /* the columns still show it; the next open folds it in again */ }
        if (cancelled) return;
        setPersisted(next);
        setDraft(new Map([...next.values()].filter(i => isDecided(i.status))
          .map(i => [i.productId, { status: i.status as StockCheckStatus, notes: i.notes }])));
        setSaved(new Set([...next.values()].filter(i => isDecided(i.status)).map(i => i.productId)));
        setMsg({ text: `${merged.changed.length} item${merged.changed.length === 1 ? '' : 's'} checked on the phone were added to this inventory.`, bad: false });
        setFoldedIn(String(merged.changed.length));
      })
      .catch(() => {
        if (cancelled) return;
        setLatest({});
        setFoldedIn('error');
        // Swallowing this would show three plausible columns built on nothing — the operator has to
        // know the history could not be read before they trust what they are looking at.
        setMsg({ text: 'The stock-check history could not be read, so checks made on the phone are not shown here yet.', bad: true });
      });
    return () => { cancelled = true; };
  }, [open, products, branchId]);

  const assign = useCallback((id: string, status: StockCheckStatus) => {
    touched.current = true;
    setDraft(prev => {
      const next = new Map(prev);
      const cur = next.get(id);
      next.set(id, { status, notes: cur?.notes ?? '' });
      return next;
    });
    setFailed(prev => { const n = new Set(prev); n.delete(id); return n; });
  }, []);

  const unassign = useCallback((id: string) => {
    touched.current = true;
    setDraft(prev => { const next = new Map(prev); next.delete(id); return next; });
  }, []);

  const setNotes = useCallback((id: string, notes: string) => {
    touched.current = true;
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
  /** The worksheet as the screen currently shows it. */
  const draftItems = useMemo<SessionItem[]>(
    () => [...draft.entries()].map(([productId, e]) => ({ productId, status: e.status as SessionItem['status'], notes: e.notes })),
    [draft],
  );
  /** Only what the worksheet has not already recorded — a second Save with no change writes nothing,
   *  and a corrected verdict writes a NEW observation because the history is append-only. */
  const dirty = useMemo(
    () => itemsNeedingHistory(draftItems, [...persisted.values()].filter(i => isDecided(i.status))),
    [draftItems, persisted],
  );
  /** Recorded AND untouched since — the greyed-out state. Editing a card takes it out of this set
   *  again, because from that moment it is a decision the history does not know about yet. */
  const dirtyIds = useMemo(() => new Set(dirty.map(d => d.productId)), [dirty]);
  // A row already parked in `to_check` is not something the save has to remove again.
  const removed = useMemo(
    () => [...persisted.values()].filter(i => isDecided(i.status) && !draft.has(i.productId)
      && products.some(p => p.id === i.productId)).map(i => i.productId),
    [persisted, draft, products],
  );
  const unsaved = dirty.length > 0 || removed.length > 0;

  const save = async () => {
    if (saving) return;                                   // §F — a second click never starts a second run
    // `dirty` is derived from the draft, which only ever holds decided cards — the narrowing is
    // what tells the type system that, since SessionItemStatus also covers the parked state.
    const entries: Array<[string, DraftEntry]> = dirty
      .filter(d => isDecided(d.status))
      .map(d => [d.productId, { status: d.status as StockCheckStatus, notes: d.notes }]);
    if (entries.length === 0 && removed.length === 0) { onClose(); return; }
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
    /** The check id this run produced per product — the worksheet records it so the merge never
     *  folds the desktop's own observation back in as if it had come from somewhere else. */
    const wrote = new Map<string, string>();
    for (const [id, e] of entries) {
      let rid = requestIds.current.get(id);
      if (!rid) { rid = crypto.randomUUID(); requestIds.current.set(id, rid); }
      try {
        const written = await recordStockCheck({
          productId: id,
          status: e.status,
          notes: prepareNotes(e.notes).ok ? (prepareNotes(e.notes) as { value: string | null }).value : null,
          userId,
          requestId: rid,
        });
        if (written && written.check_id) wrote.set(id, written.check_id);
        ok.add(id);
      } catch {
        bad.add(id);
      }
    }
    // INVENTORY-SESSION — the worksheet is written for everything that actually landed, so reopening
    // shows the same three columns. A failed item stays OUT of it: its verdict was never observed.
    try {
      const db = getDatabase() as unknown as InventorySessionDb;
      const nowIso = new Date().toISOString();
      const sid = sessionId ?? ensureOpenSession(db, branchId, nowIso, () => crypto.randomUUID());
      // Carry the observation identity: a row this save wrote points at its own check, an
      // untouched row keeps the one it was already accounting for.
      const keep = draftItems.filter(d => !bad.has(d.productId)).map(d => ({
        ...d,
        appliedCheckId: wrote.get(d.productId) ?? persisted.get(d.productId)?.appliedCheckId ?? null,
      }));
      persistSessionItems(db, sid, keep, products.map(p => p.id), nowIso);
      await saveDatabase();
      setSessionId(sid);
      setPersisted(prev => {
        const next = new Map(prev);
        for (const id of products.map(p => p.id)) {
          if (!keep.some(k => k.productId === id)) {
            // Parked, not forgotten — the stored `to_check` is what a later merge compares against.
            if (next.has(id)) next.set(id, { productId: id, status: 'to_check', notes: '', updatedAt: nowIso, appliedCheckId: null });
          }
        }
        for (const k of keep) next.set(k.productId, { ...k, updatedAt: nowIso });
        return next;
      });
    } catch {
      setMsg({ text: 'Saved to the history, but the worksheet could not be stored — reopening may start blank.', bad: true });
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

  /** INVENTORY-SESSION — put the worksheet away deliberately. Nothing else clears it: no date rolls
   *  over, nothing expires. The history is NOT touched; only the run in progress ends. */
  const [confirmFinish, setConfirmFinish] = useState(false);
  const finishInventory = async () => {
    if (saving) return;
    try {
      if (sessionId) {
        closeSession(getDatabase() as unknown as InventorySessionDb, sessionId, new Date().toISOString());
        await saveDatabase();
      }
    } catch {
      setMsg({ text: 'The inventory could not be closed — please try again.', bad: true });
      setConfirmFinish(false);
      return;
    }
    setSessionId(null);
    setPersisted(new Map());
    setDraft(new Map());
    setSaved(new Set());
    requestIds.current = new Map();
    setConfirmFinish(false);
    setMsg({ text: 'Inventory finished — the columns start empty next time. The history is unchanged.', bad: false });
  };

  const attemptClose = () => {
    if (unsaved && !saving) { setConfirmDiscard(true); return; }   // §C6 — never lose a draft silently
    onClose();
  };

  const row = (p: Product, column: 'pending' | StockCheckStatus) => {
    const entry = draft.get(p.id);
    const last = latest[p.id];
    // "Already in the history, unchanged since" — a look, never a lock. A run picked up days later
    // arrives entirely in this state, and an operator who cannot correct it has no inventory at all.
    const isSaved = saved.has(p.id) && !dirtyIds.has(p.id);
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
                <button data-inv-flip={p.id} disabled={saving}
                  title={column === 'available' ? 'Move to Not available' : 'Move to Available'}
                  onClick={() => assign(p.id, column === 'available' ? 'not_available' : 'available')}
                  className="px-2 py-1 rounded" style={{ border: '1px solid #2A2A32', color: '#8A8A93' }}>
                  {column === 'available' ? '✗' : '✓'}
                </button>
                <button data-inv-undo={p.id} title="Back to unchecked" disabled={saving}
                  onClick={() => unassign(p.id)}
                  className="px-2 py-1 rounded" style={{ border: '1px solid #2A2A32', color: '#8A8A93' }}>↩</button>
              </>
            )}
          </div>
        </div>
        {/* §C7 — the note sits WITH the decision it belongs to, and stays editable: correcting the
            note of an item saved yesterday is the ordinary case, not an exception. */}
        {entry && (
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
          <div className="text-sm" data-inv-progress data-inv-merged={foldedIn} data-inv-history={String(Object.keys(latest).length)}
            data-inv-run={runStartedAt || 'none'}>
            <strong>{draft.size}</strong> / {products.length} checked
            <span className="text-gray-500"> · {pending.length} remaining · {availables.length} available · {notAvailables.length} not available</span>
          </div>
          <div className="text-xs text-gray-500">
            Nothing is saved until you press Save · this inventory stays open until you finish it
            {runStartedAt && <> · running since {when(runStartedAt)}</>}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, height: '58vh' }}>
          {column('To check', pending, 'pending')}
          {column('Available', availables, 'available', '#7FA87F')}
          {column('Not available', notAvailables, 'not_available', '#AA6E6E')}
        </div>

        {msg && <div className={`text-xs mt-3 ${msg.bad ? 'text-red-400' : 'text-emerald-400'}`}>{msg.text}</div>}

        <div className="flex items-center justify-between gap-2 mt-4">
          <Button variant="ghost" data-testid="inv-finish" disabled={saving || (draft.size === 0 && !sessionId)}
            onClick={() => setConfirmFinish(true)}>
            Finish inventory
          </Button>
          <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={attemptClose} disabled={saving}>Cancel</Button>
          <Button data-testid="inv-save" onClick={() => void save()} disabled={saving || draft.size === 0}>
            {saving ? 'Saving…' : `Save stock check (${dirty.length})`}
          </Button>
          </div>
        </div>
      </Modal>

      {/* §C3 — the SAME hover card the pickers use, so the preview cannot drift from theirs. */}
      {/* The preview MUST live in the same top-level layer as the dialog. The Modal portals itself to
          document.body, and its backdrop paints a blur; a preview rendered here in the page tree sits
          in a lower stacking context, so any z-index it carries is meaningless against the portal and
          it appears behind the blur. Portalling it to the same parent is what actually puts it on top. */}
      {open && hovered && !confirmDiscard && createPortal(
        <div style={{
          position: 'fixed',
          left: Math.min(hover!.x + 18, window.innerWidth - 340),
          top: Math.min(hover!.y + 12, window.innerHeight - 320),
          zIndex: 10050,
          pointerEvents: 'none',
        }}>
          <ProductHoverCard product={hovered} categories={categories} />
        </div>,
        document.body,
      )}

      <Modal open={confirmFinish} onClose={() => setConfirmFinish(false)} title="Finish inventory?" width={460}>
        <div className="text-sm mb-4">
          This ends the current inventory. The three columns start empty next time you open it.
          Everything you already saved stays in the stock-check history — nothing is deleted there.
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirmFinish(false)}>Keep working</Button>
          <Button data-testid="inv-finish-confirm" onClick={() => { void finishInventory(); }}>Finish inventory</Button>
        </div>
      </Modal>

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
