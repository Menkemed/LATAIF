// ════════════════════════════════════════════════════════════════════════════
// CUSTOM-ORDER K3a — die Goldschuld einer Order in BHD begleichen: Gramm (ganz oder teilweise), Goldpreis je Gramm
// (manuell), Tag. Die Vorschau zeigt Betrag, aufgelösten Buchwert und die Differenz, die den Einstand der Order
// ändert. Rechnen und buchen tut das Haus (`settleOrderGoldInBhd`); am Primary in einer Klammer, an PC2 über
// `gold.payables.settle` (Art 'money_order'). Am Primary stehen darunter die wirksamen Begleichungen mit „Reverse".
// ════════════════════════════════════════════════════════════════════════════
import { useEffect, useMemo, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import type { GoldPayable } from '@/core/models/types';
import { goldRevisionOf, useGoldStore } from '@/stores/goldStore';
import { useSharedWrites, nichtAmClient, fehlertext } from '@/core/data/shared-write';
import {
  orderGoldReverseBody, orderGoldSettleBody, reverseOrderGoldSettlementOnPrimary, settleOrderGoldOnPrimary,
} from '@/core/gold/gold-house';
import { activeOrderGoldSettlements, type ActiveOrderGoldSettlement } from '@/core/gold/order-gold-settle';
import { readsFromPrimary } from '@/core/data/primary-source';

interface Props {
  open: boolean;
  onClose: () => void;
  payable: GoldPayable;
}

const F = (v: number): number => Math.round(v * 1000);
const fmt = (fils: number): string => (fils / 1000).toFixed(3);
const mulDiv = (a: number, b: number, c: number): number => Number((2n * BigInt(Math.max(0, a)) * BigInt(Math.max(0, b)) + BigInt(c)) / (2n * BigInt(c)));

type SettlementRow = ActiveOrderGoldSettlement;

export function SettleOrderGoldModal({ open, onClose, payable }: Props) {
  const w = useSharedWrites();
  const remaining = Math.max(0, Math.round((payable.weightGrams - payable.fulfilledGrams) * 1000) / 1000);
  const [grams, setGrams] = useState(remaining.toFixed(3));
  const [rate, setRate] = useState('');
  const [day, setDay] = useState(() => new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [rows, setRows] = useState<SettlementRow[]>([]);
  const local = !readsFromPrimary();

  useEffect(() => {
    if (!open) return;
    setGrams(remaining.toFixed(3)); setRate(''); setError(''); setNotes('');
    setDay(new Date().toISOString().slice(0, 10));
    if (local) {
      try { setRows(activeOrderGoldSettlements(payable.id)); } catch { setRows([]); }
    }
  }, [open, payable.id, remaining, local]);

  const preview = useMemo(() => {
    const g = F(parseFloat(grams) || 0), r = F(parseFloat(rate) || 0);
    const weight = F(payable.weightGrams), openMg = F(remaining);
    const book = F(payable.bookValue ?? 0);
    const settledShares = rows.reduce((s, x) => s + F(x.amount - x.difference), 0);
    const amount = g > 0 && r > 0 ? mulDiv(g, r, 1000) : 0;
    const share = g === openMg ? Math.max(0, book - settledShares) : (weight > 0 ? mulDiv(book, g, weight) : 0);
    return { g, r, amount, share, diff: amount - share, valid: g > 0 && r > 0 && g <= openMg };
  }, [grams, rate, payable.weightGrams, payable.bookValue, remaining, rows]);

  async function confirm() {
    setError('');
    if (payable.bookValue === undefined) { setError('This gold debt has no booked value yet — correct the order data first.'); return; }
    if (!preview.valid) { setError(`Enter grams (max. ${remaining.toFixed(3)} g) and a gold price per gram.`); return; }
    const revision = goldRevisionOf(payable);
    if (w.remote && !revision) { setError(fehlertext(nichtAmClient('settling gold (no revision loaded)'))); return; }
    const req = { payableId: payable.id, grams: preview.g / 1000, ratePerGram: preview.r / 1000, settledOn: day, ...(notes ? { notes } : {}) };
    const done = await w.ok('gold.payables.settle', {
      local: () => settleOrderGoldOnPrimary(req),
      remote: () => orderGoldSettleBody(req, revision ?? 0),
    });
    if (!done) return;
    useGoldStore.getState().loadAll();
    onClose();
  }

  async function reverse(id: string) {
    setError('');
    const revision = goldRevisionOf(payable);
    const done = await w.ok('gold.payables.settle', {
      local: () => reverseOrderGoldSettlementOnPrimary(id),
      remote: () => orderGoldReverseBody(payable.id, id, revision ?? 0),
    });
    if (!done) return;
    useGoldStore.getState().loadAll();
    onClose();
  }

  const input = { padding: '7px 9px', border: '1px solid #D5D9DE', borderRadius: 6, fontSize: 13, width: '100%' } as const;
  return (
    <Modal open={open} onClose={onClose} title="Settle gold debt in BHD" width={560}>
      <p style={{ fontSize: 13, color: '#4B5563', marginBottom: 12 }}>
        Open: <strong className="font-mono">{remaining.toFixed(3)} g {payable.karat}</strong>
        {payable.bookValue !== undefined && <> · booked value <strong className="font-mono">{payable.bookValue.toFixed(3)} BHD</strong></>}.
        The difference to the booked value changes the cost of the order (before the sale the piece, after the sale its invoice).
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><span className="text-overline">GRAMS ({payable.karat})</span>
          <input data-testid="order-gold-grams" style={input} value={grams} inputMode="decimal" onChange={(e) => setGrams(e.target.value)} /></label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><span className="text-overline">GOLD PRICE BHD/G</span>
          <input data-testid="order-gold-rate" style={input} value={rate} inputMode="decimal" onChange={(e) => setRate(e.target.value)} /></label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><span className="text-overline">DATE</span>
          <input data-testid="order-gold-date" type="date" style={input} value={day} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setDay(e.target.value)} /></label>
      </div>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 10 }}><span className="text-overline">NOTE</span>
        <input style={input} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
      <div className="flex gap-4" style={{ marginTop: 12, fontSize: 12.5, color: '#4B5563', flexWrap: 'wrap' }}>
        <span>Supplier debt <strong className="font-mono">{fmt(preview.amount)}</strong></span>
        <span>Booked value settled <strong className="font-mono">{fmt(preview.share)}</strong></span>
        <span>Cost of the order <strong className="font-mono">{preview.diff >= 0 ? '+' : '−'}{fmt(Math.abs(preview.diff))}</strong></span>
      </div>
      {rows.length > 0 && (
        <div style={{ marginTop: 14, borderTop: '1px solid #E5E9EE', paddingTop: 10 }}>
          <span className="text-overline">ACTIVE SETTLEMENTS</span>
          {rows.map((r) => (
            <div key={r.id} className="flex justify-between items-center" style={{ fontSize: 12.5, padding: '6px 0' }}>
              <span className="font-mono">{r.settledOn} · {r.grams.toFixed(3)} g × {r.rate.toFixed(3)} = {r.amount.toFixed(3)} BHD ({r.difference >= 0 ? '+' : ''}{r.difference.toFixed(3)})</span>
              <Button variant="ghost" onClick={() => { void reverse(r.id); }}>Reverse</Button>
            </div>
          ))}
        </div>
      )}
      {(error || w.fehler) && <p data-gold-settle-error style={{ color: '#B91C1C', fontSize: 12, marginTop: 10 }}>{error || w.fehler}</p>}
      <div className="flex justify-end gap-3" style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid #E5E9EE' }}>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => { void confirm(); }} disabled={!preview.valid || remaining <= 0}>Settle in BHD</Button>
      </div>
    </Modal>
  );
}
