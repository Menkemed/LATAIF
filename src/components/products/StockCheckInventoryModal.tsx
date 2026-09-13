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
// CENTRAL-UI-PARITY R6C — the modal no longer touches a database itself. Opening, saving and
// finishing are ONE house sequence (`inventory-house.ts`): on the Primary it runs in the Primary's
// write queue with its own transaction; on a DB-less PC2 the same sequence runs on the Primary as
// the commands `inventory.start` / `inventory.save` / `inventory.finish`. PC2's own core is never
// asked. It still cannot change a product: an inventory here is observations plus a worksheet — no
// stock movement, no ledger.
// ════════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { ProductHoverCard } from '@/components/products/ProductHoverCard';
import { useAuthStore } from '@/stores/authStore';
import { itemsNeedingHistory, isDecided, type SessionItem } from '@/core/stock/inventory-session';
import { InventoryCheckFailed, type InventorySheet } from '@/core/stock/inventory-house';
import {
  finishInventoryHere, inventoryViewFromPrimary, openInventoryHere, saveInventoryHere, type InventoryView,
} from '@/core/stock/inventory-port';
import {
  prepareNotes,
  stockCheckLabel,
  MAX_STOCK_CHECK_NOTES,
  type StockCheck,
  type StockCheckStatus,
} from '@/core/stock/stock-check';
import { useSharedWrite, fehlertext } from '@/core/data/shared-write';
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

type SaveValue = { sheet: InventorySheet; recorded: number; unchanged: boolean };

export function StockCheckInventoryModal({ open, onClose, products, categories }: StockCheckInventoryModalProps) {
  const userId = useAuthStore(s => s.session?.userId);
  // R6C — one intent per action. On the Primary the house sequence runs locally (write queue, own
  // transaction, durable); on PC2 the same sequence runs on the Primary as a command. A lost answer
  // repeats the SAME attempt — it can never record a verdict twice.
  const starten = useSharedWrite<InventoryView>('inventory.start');
  const speichern = useSharedWrite<SaveValue>('inventory.save');
  const abschliessen = useSharedWrite<{ sessionId: string }>('inventory.finish');
  const remote = starten.remote;
  const startSave = starten.save;
  const startForget = starten.forget;
  const [draft, setDraft] = useState<Map<string, DraftEntry>>(new Map());
  const [latest, setLatest] = useState<Record<string, StockCheck>>({});
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  // What the worksheet last recorded, per product. This is the SAVED state, and it is what makes a
  // second Save write nothing while a corrected verdict still writes a new observation.
  const [persisted, setPersisted] = useState<Map<string, SessionItem>>(new Map());
  const [sessionId, setSessionId] = useState<string | null>(null);
  /** R6C — the revision of the run this screen shows. Saving or finishing names it; a run changed
   *  elsewhere in the meantime (another computer) is refused instead of silently overwritten. */
  const [revision, setRevision] = useState(0);
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  /** One request id per product per save ATTEMPT (Primary) — a retry of the same decision reuses it,
   *  so a double click or a re-save after a partial failure cannot produce a second history row. On
   *  PC2 the Primary derives them from the command id, which a retry keeps. */
  const requestIds = useRef<Map<string, string>>(new Map());
  /** How many cards the phone filled in for this open — shown to the operator, and the one
   *  honest signal that the cross-surface fold-in ran at all. */
  const [foldedIn, setFoldedIn] = useState<string>('');
  /** When the run in progress was started — shown to the operator so an inventory left open for
   *  days is obvious rather than a surprise. */
  const [runStartedAt, setRunStartedAt] = useState<string>('');

  /** The worksheet as the house holds it → the three columns. */
  const applySheet = useCallback((s: Pick<InventorySheet, 'sessionId' | 'startedAt' | 'revision' | 'items'>) => {
    const decided = s.items.filter(i => isDecided(i.status));
    setSessionId(s.sessionId);
    setRunStartedAt(s.startedAt);
    setRevision(s.revision);
    setPersisted(new Map(s.items.map(i => [i.productId, i])));
    setDraft(new Map(decided.map(i => [i.productId, { status: i.status as StockCheckStatus, notes: i.notes }])));
    setSaved(new Set(decided.map(i => i.productId)));
  }, []);

  // Fresh state every time the modal opens: a stocktake is a session, not a stored document. Reset
  // while rendering the opening (React's "adjust state when a prop changes"), not inside the effect.
  const [shownOpen, setShownOpen] = useState(false);
  if (open !== shownOpen) {
    setShownOpen(open);
    if (open) {
      setSessionId(null);
      setRunStartedAt('');
      setRevision(0);
      setPersisted(new Map());
      setDraft(new Map());
      setSaved(new Set());
      setFailed(new Set());
      setMsg(null);
      setConfirmDiscard(false);
      setLatest({});
      setFoldedIn('');
      setLoading(true);
    }
  }

  // Opening the dialog is what STARTS an inventory (or picks up the open one), and checks made on the
  // phone during the run are folded into it — the same rule as before, now in ONE house sequence.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    requestIds.current = new Map();
    const ids = products.map(p => p.id);
    // Opening is repeatable by nature (the same open run; every observation folded in once), so a
    // new open may take a new id — an unanswered earlier open must not pin this one to its body.
    startForget();
    void (async () => {
      const r = await startSave({
        local: () => openInventoryHere(ids),
        remote: () => ({ productIds: ids }),
        shape: (v) => ({
          sessionId: typeof v.sessionId === 'string' ? v.sessionId : null,
          startedAt: String(v.startedAt ?? ''),
          revision: Number(v.revision ?? 0),
          items: [],
          latest: {},
          foldedIn: Number(v.foldedIn ?? 0),
        }),
      });
      if (cancelled) return;
      if (r.kind !== 'ok') {
        setLoading(false);
        setFoldedIn('error');
        // Swallowing this would show three plausible columns built on nothing.
        setMsg({ text: `The inventory could not be opened: ${fehlertext(r)}`, bad: true });
        return;
      }
      let view: InventoryView = r.value;
      if (remote) {
        const v = await inventoryViewFromPrimary(ids);
        if (cancelled) return;
        if (!v) {
          setLoading(false);
          setFoldedIn('error');
          setMsg({ text: 'The inventory could not be read from the main computer.', bad: true });
          return;
        }
        view = { ...v, foldedIn: r.value.foldedIn };
      }
      applySheet(view);
      setLatest(view.latest);
      setFoldedIn(String(view.foldedIn));
      if (view.foldedIn > 0) {
        setMsg({ text: `${view.foldedIn} item${view.foldedIn === 1 ? '' : 's'} checked on the phone were added to this inventory.`, bad: false });
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [open, products, remote, startSave, startForget, applySheet]);

  /** R6C — on PC2 an unanswered save keeps its id; until it is answered the draft must not change,
   *  or the repeat would be a different request under the same name. */
  const pending = speichern.remote && speichern.openCommandId !== null;
  const locked = saving || loading || pending;

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

  const pendingCards = useMemo(() => products.filter(p => !draft.has(p.id)), [products, draft]);
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
    if (saving || loading) return;                        // §F — a second click never starts a second run
    if (!sessionId) { setMsg({ text: 'The inventory is not open — close and open it again.', bad: true }); return; }
    if (dirty.length === 0 && removed.length === 0 && !pending) { onClose(); return; }
    // Refuse the whole save on a note the house would reject, rather than saving the rest and
    // silently dropping one note.
    for (const d of dirty) {
      if (!prepareNotes(d.notes).ok) {
        setMsg({ text: `A note is longer than ${MAX_STOCK_CHECK_NOTES} characters.`, bad: true });
        setFailed(new Set([d.productId]));
        return;
      }
    }
    setSaving(true);
    setMsg(null);
    const ask = {
      sessionId,
      expectedRevision: revision,
      items: draftItems.map(d => ({ productId: d.productId, status: d.status as StockCheckStatus, notes: d.notes })),
      visibleProductIds: products.map(p => p.id),
    };
    const rid = (productId: string): string => {
      let r = requestIds.current.get(productId);
      if (!r) { r = crypto.randomUUID(); requestIds.current.set(productId, r); }
      return r;
    };
    let notRecorded: string[] = [];
    const r = await speichern.save({
      local: async () => {
        try {
          return await saveInventoryHere(ask, rid, userId);
        } catch (e) {
          if (e instanceof InventoryCheckFailed) notRecorded = e.failed;
          throw e;
        }
      },
      remote: () => ask,
      shape: (v) => ({
        sheet: { sessionId, startedAt: runStartedAt, revision: Number(v.revision ?? revision), items: [] },
        recorded: Number(v.recorded ?? 0),
        unchanged: v.unchanged === true,
      }),
    });
    if (r.kind !== 'ok') {
      setSaving(false);
      setFailed(new Set(notRecorded));
      // §F — never close on a partial result. Nothing went onto the worksheet; the checks that did
      // land are found again (same request ids) when Save is pressed again.
      setMsg({
        text: notRecorded.length > 0
          ? `${notRecorded.length} of ${dirty.length} item${dirty.length === 1 ? '' : 's'} could not be recorded — the worksheet is unchanged. The failed items are marked; press Save to retry.`
          : `Not saved: ${fehlertext(r)}`,
        bad: true,
      });
      return;
    }
    // The worksheet as the house now holds it. On PC2 it is read back from the Primary; a worksheet
    // that cannot be read back is said, not closed away.
    let sheet: Pick<InventorySheet, 'sessionId' | 'startedAt' | 'revision' | 'items'> = r.value.sheet;
    if (remote) {
      const v = await inventoryViewFromPrimary(products.map(p => p.id));
      if (!v) {
        setSaving(false);
        setRevision(r.value.sheet.revision);
        setMsg({ text: 'Saved on the main computer, but the worksheet could not be read back — reopen to continue.', bad: true });
        return;
      }
      sheet = v;
    }
    applySheet(sheet);
    requestIds.current = new Map();
    setFailed(new Set());
    setSaving(false);
    onClose();
  };

  /** INVENTORY-SESSION — put the worksheet away deliberately. Nothing else clears it: no date rolls
   *  over, nothing expires. The history is NOT touched; only the run in progress ends. */
  const [confirmFinish, setConfirmFinish] = useState(false);
  const finishInventory = async () => {
    if (saving || loading) return;
    if (sessionId) {
      const sid = sessionId;
      const r = await abschliessen.save({
        local: async () => { await finishInventoryHere(sid, revision); return { sessionId: sid }; },
        remote: () => ({ sessionId: sid, expectedRevision: revision }),
        shape: () => ({ sessionId: sid }),
      });
      if (r.kind !== 'ok') {
        // R6B — no "finished" without effect.
        setMsg({ text: `The inventory could not be closed: ${fehlertext(r)}`, bad: true });
        setConfirmFinish(false);
        return;
      }
    }
    setSessionId(null);
    setRevision(0);
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
                <button data-inv-yes={p.id} title="Available" disabled={locked}
                  onClick={() => assign(p.id, 'available')}
                  className="px-2 py-1 rounded" style={{ border: '1px solid #2A2A32', color: '#7FA87F' }}>✓</button>
                <button data-inv-no={p.id} title="Not available" disabled={locked}
                  onClick={() => assign(p.id, 'not_available')}
                  className="px-2 py-1 rounded" style={{ border: '1px solid #2A2A32', color: '#AA6E6E' }}>✗</button>
              </>
            ) : (
              <>
                <button data-inv-flip={p.id} disabled={locked}
                  title={column === 'available' ? 'Move to Not available' : 'Move to Available'}
                  onClick={() => assign(p.id, column === 'available' ? 'not_available' : 'available')}
                  className="px-2 py-1 rounded" style={{ border: '1px solid #2A2A32', color: '#8A8A93' }}>
                  {column === 'available' ? '✗' : '✓'}
                </button>
                <button data-inv-undo={p.id} title="Back to unchecked" disabled={locked}
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
            disabled={locked}
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
            data-inv-run={runStartedAt || 'none'} data-inv-revision={String(revision)}>
            <strong>{draft.size}</strong> / {products.length} checked
            <span className="text-gray-500"> · {pendingCards.length} remaining · {availables.length} available · {notAvailables.length} not available</span>
          </div>
          <div className="text-xs text-gray-500">
            {loading ? 'Opening the inventory…' : 'Nothing is saved until you press Save · this inventory stays open until you finish it'}
            {runStartedAt && <> · running since {when(runStartedAt)}</>}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, height: '58vh' }}>
          {column('To check', pendingCards, 'pending')}
          {column('Available', availables, 'available', '#7FA87F')}
          {column('Not available', notAvailables, 'not_available', '#AA6E6E')}
        </div>

        {pending && (
          <div data-inv-pending className="text-xs mt-3 text-red-400">
            No answer from the main computer yet — it is not clear whether this was saved. Press Save again: the same attempt is repeated, and it can never record a check twice.
          </div>
        )}
        {msg && <div data-save-error={msg.bad ? '' : undefined} className={`text-xs mt-3 ${msg.bad ? 'text-red-400' : 'text-emerald-400'}`}>{msg.text}</div>}

        <div className="flex items-center justify-between gap-2 mt-4">
          <Button variant="ghost" data-testid="inv-finish" disabled={locked || (draft.size === 0 && !sessionId)}
            onClick={() => setConfirmFinish(true)}>
            Finish inventory
          </Button>
          <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={attemptClose} disabled={saving}>Cancel</Button>
          <Button data-testid="inv-save" onClick={() => void save()} disabled={saving || loading || (draft.size === 0 && !unsaved && !pending)}>
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
          <Button data-testid="inv-finish-confirm" disabled={abschliessen.busy} onClick={() => { void finishInventory(); }}>Finish inventory</Button>
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
