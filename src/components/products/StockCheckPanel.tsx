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

import { useCallback, useEffect, useState } from 'react';
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

      <div className="flex gap-2 mb-2">
        <Button variant="ghost" disabled={busy} onClick={() => void save('available')}>Available</Button>
        <Button variant="ghost" disabled={busy} onClick={() => void save('not_available')}>Not available</Button>
      </div>

      <input
        type="text"
        value={notes}
        maxLength={MAX_STOCK_CHECK_NOTES}
        onChange={e => setNotes(e.target.value)}
        placeholder="Notes (optional) — e.g. in safe, with customer"
        className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm"
      />

      {msg && <div className={`text-xs mt-2 ${msg.bad ? 'text-red-400' : 'text-emerald-400'}`}>{msg.text}</div>}

      {earlier.length > 0 && (
        <div className="mt-4">
          <div className="text-[11px] uppercase tracking-wider text-gray-500 mb-1">Earlier checks</div>
          {earlier.map(c => (
            <div key={c.check_id} className="text-xs text-gray-500 py-1 border-t border-white/5">
              <span className={tone(c.status)}>{stockCheckLabel(c.status)}</span>
              <span> · {when(c.checked_at)}</span>
              {c.checked_by_name && <span> · {c.checked_by_name}</span>}
              <span className="text-gray-600"> · {c.source}</span>
              {c.notes && <span> · {c.notes}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
