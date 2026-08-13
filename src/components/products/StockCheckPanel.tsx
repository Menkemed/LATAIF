// ════════════════════════════════════════════════════════════════════════════
// MOBILE-I1 §16/§26 — the stock-check block on the desktop product detail.
//
// A separate component on purpose: the existing detail view keeps every field it had, and this is
// ADDED below it. It reads and writes the same `stock_checks` rows the phone does, so a check made
// during a walk-around appears here on the next load without any sync step existing.
//
// It cannot change the product. The only backend calls it makes are the two stock-check commands,
// and neither can reach `products`.
// ════════════════════════════════════════════════════════════════════════════

import { Fragment, useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useAuthStore } from '@/stores/authStore';
import {
  listStockChecks,
  recordStockCheck,
  prepareNotes,
  stockCheckLabel,
  MAX_STOCK_CHECK_NOTES,
  type StockCheck,
  type StockCheckStatus,
} from '@/core/stock/stock-check';

function when(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function tone(status: StockCheckStatus): string {
  return status === 'available' ? 'text-emerald-400' : 'text-red-400';
}

export function StockCheckPanel({ productId }: { productId: string }) {
  const userId = useAuthStore(s => s.session?.userId);
  const [checks, setChecks] = useState<StockCheck[]>([]);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    try {
      setChecks(await listStockChecks(productId, 20));
    } catch {
      // A history that cannot be read must not break the page — the product details stay usable.
      setMsg({ text: 'Check history unavailable.', bad: true });
    } finally {
      setLoaded(true);
    }
  }, [productId]);

  useEffect(() => { void reload(); }, [reload]);

  const save = async (status: StockCheckStatus) => {
    if (busy) return;
    const prepared = prepareNotes(notes);
    if (!prepared.ok) {
      setMsg({ text: `Notes are limited to ${MAX_STOCK_CHECK_NOTES} characters.`, bad: true });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      // A fresh id per click: a retry of THIS click is the same observation, a new click is a new one.
      await recordStockCheck({
        productId,
        status,
        notes: prepared.value,
        userId,
        requestId: crypto.randomUUID(),
      });
      setNotes('');
      setMsg({ text: 'Saved.', bad: false });
      await reload();
    } catch (e) {
      setMsg({ text: String(e), bad: true });
    } finally {
      setBusy(false);
    }
  };

  const latest = checks[0] ?? null;
  const earlier = checks.slice(1);

  return (
    <div className="mt-6 border-t border-white/10 pt-4">
      <div className="text-[11px] uppercase tracking-wider text-gray-500 mb-2">Stock check</div>

      <div className="text-sm mb-3">
        {!loaded ? (
          <span className="text-gray-500">Loading…</span>
        ) : latest ? (
          <>
            <span className={`font-semibold ${tone(latest.status)}`}>{stockCheckLabel(latest.status)}</span>
            <span className="text-gray-500"> · {when(latest.checked_at)}</span>
            {latest.checked_by_name && <span className="text-gray-500"> · {latest.checked_by_name}</span>}
            <span className="text-gray-600"> · {latest.source === 'mobile' ? 'mobile' : 'desktop'}</span>
            {latest.notes && <div className="text-gray-300 mt-1">{latest.notes}</div>}
          </>
        ) : (
          <span className="text-gray-500">Never checked.</span>
        )}
      </div>

      {/* MOBILE-I1 §D1 — the note comes BEFORE the buttons. The buttons SAVE, so with the field
          underneath them the reading order invited a click first and the note second; live that
          produced nine checks with no note at all before the tenth carried one. */}
      <input
        type="text"
        value={notes}
        maxLength={MAX_STOCK_CHECK_NOTES}
        onChange={e => setNotes(e.target.value)}
        placeholder="Notes (optional) — e.g. in safe, with customer"
        className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm"
      />

      <div className="flex gap-2 mt-2">
        <Button variant="ghost" disabled={busy} onClick={() => void save('available')}>Available</Button>
        <Button variant="ghost" disabled={busy} onClick={() => void save('not_available')}>Not available</Button>
      </div>

      {msg && <div className={`text-xs mt-2 ${msg.bad ? 'text-red-400' : 'text-emerald-400'}`}>{msg.text}</div>}

      {earlier.length > 0 && (
        <div className="mt-4">
          <div className="text-[11px] uppercase tracking-wider text-gray-500 mb-1">Earlier checks</div>
          {/* §D2 — columns, not a `·`-joined sentence: at ten entries the single-line form was
              unreadable. Plain CSS grid; no data-grid dependency for five columns. */}
          <div className="grid text-xs" style={{ gridTemplateColumns: 'auto 1fr auto auto auto', columnGap: 12 }}>
            <div className="text-gray-600 pb-1">Status</div>
            <div className="text-gray-600 pb-1">Notes</div>
            <div className="text-gray-600 pb-1">Checked at</div>
            <div className="text-gray-600 pb-1">Source</div>
            <div className="text-gray-600 pb-1">By</div>
            {earlier.map(c => (
              <Fragment key={c.check_id}>
                <div className={`py-1 border-t border-white/5 ${tone(c.status)}`}>{stockCheckLabel(c.status)}</div>
                <div className="py-1 border-t border-white/5 text-gray-300">{c.notes || <span className="text-gray-600">—</span>}</div>
                <div className="py-1 border-t border-white/5 text-gray-500 whitespace-nowrap">{when(c.checked_at)}</div>
                <div className="py-1 border-t border-white/5 text-gray-500">{c.source}</div>
                <div className="py-1 border-t border-white/5 text-gray-500 whitespace-nowrap">{c.checked_by_name || '—'}</div>
              </Fragment>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
