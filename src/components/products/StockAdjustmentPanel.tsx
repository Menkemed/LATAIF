// ════════════════════════════════════════════════════════════════════════════
// STOCK CORRECTION — „Stock corrections" auf der Artikelseite: Abgang (Verlust, Diebstahl, Schaden, Zählfehler)
// mit Vorschau, und die Korrekturbelege des Artikels mit Storno. Nur für den Owner (Admin). Am Primary läuft die
// Hausfolge lokal (`runOnPrimary`); am PC2 liest die Karte über `stock_adjustments.product.get` und schreibt über die
// Fernbefehle `stock_adjustments.issue` / `.cancel` — der Primary prüft die Rolle des Absenders und fährt dieselbe
// Hausfolge. Alle Regeln liegen im Haus (`core/stock/stock-adjustment`), die Maske zeigt nur, was es sagt.
// OLD STOCK — „Add old stock": weitere Stücke Altbestand eines schon erfassten Artikels (nur Menge, historischer Einstand,
// Beleg; keine Buchung — die Eröffnung wartet auf die Regeln des Buchhalters).
// ════════════════════════════════════════════════════════════════════════════
import { useState } from 'react';
import { v4 as uuid } from 'uuid';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { useSharedRead } from '@/core/data/shared-read';
import { useSharedWrites, fehlertext } from '@/core/data/shared-write';
import {
  STOCK_ADJUSTMENT_REASONS, addOldStockOnPrimary, cancelStockAdjustmentOnPrimary, issueStockOnPrimary, stockCorrectionsFor,
  type StockAdjustmentResult, type StockCorrectionsRead,
} from '@/core/stock/stock-adjustment';

const REASON_LABEL: Record<string, string> = {
  LOST: 'Lost', STOLEN: 'Stolen', DAMAGED: 'Damaged beyond sale', COUNT_ERROR: 'Counting error', OTHER: 'Other',
};
const today = (): string => new Date().toISOString().slice(0, 10);
const EMPTY: StockCorrectionsRead = { docs: [], issuePreview: null, receiptPreview: null };

export function StockAdjustmentPanel({ productId, quantity, purchasePrice, onChanged }: { productId: string; quantity: number; purchasePrice?: number | null; onChanged: () => void }) {
  const w = useSharedWrites();
  const [refresh, setRefresh] = useState(0);
  const [open, setOpen] = useState(false);
  const [actionId, setActionId] = useState('');
  const [qty, setQty] = useState('1');
  const [category, setCategory] = useState<string>('LOST');
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(today());
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [storno, setStorno] = useState<{ id: string; number: string } | null>(null);
  const [stornoReason, setStornoReason] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [addActionId, setAddActionId] = useState('');
  const [addQty, setAddQty] = useState('1');
  const [addCost, setAddCost] = useState('');
  const [addReason, setAddReason] = useState('');
  const [addDate, setAddDate] = useState(today());
  const [addConfirm, setAddConfirm] = useState(false);
  const n = Number(qty);
  const issueQuantity = open && Number.isInteger(n) ? n : null;
  const an = Number(addQty);
  const receiptQuantity = addOpen && Number.isInteger(an) ? an : null;
  const ac = addCost.trim() === '' ? NaN : Number(addCost);
  const receiptUnitCost = addOpen && Number.isFinite(ac) ? ac : null;
  const data = useSharedRead<StockCorrectionsRead>(
    'stock_adjustments.product.get', { productId, issueQuantity, receiptQuantity, receiptUnitCost, r: refresh },
    (ctx) => stockCorrectionsFor(ctx, { productId, issueQuantity, receiptQuantity, receiptUnitCost }), EMPTY,
    [productId, issueQuantity, receiptQuantity, receiptUnitCost, refresh],
  );
  const docs = data.docs;
  const preview = open ? data.issuePreview : null;
  const addPreview = addOpen ? data.receiptPreview : null;
  const busy = w.busy;
  const reload = (): void => { setRefresh((r) => r + 1); onChanged(); };

  function startAdd(): void {
    w.clear(); setAddActionId(uuid()); setAddQty('1'); setAddCost(purchasePrice !== null && purchasePrice !== undefined ? String(purchasePrice) : '');
    setAddReason(''); setAddDate(today()); setAddConfirm(false); setMsg(null); setAddOpen(true);
  }

  async function confirmAdd(): Promise<void> {
    if (!addPreview?.plan) return;
    const p = addPreview.plan;
    if (!(await window.confirm(`Add ${p.quantity} piece(s) of old stock (${p.qtyBefore} → ${p.qtyBefore + p.quantity}) at a historical cost of ${p.unitCost.toFixed(3)} BHD each? No money and no booking: the opening of old stock is reconciled later.`))) return;
    const input = {
      actionId: addActionId, productId, quantity: p.quantity, expectedQuantity: p.qtyBefore, unitCost: p.unitCost,
      reason: addReason, businessDate: addDate, ...(p.openRemovals.length > 0 ? { confirmNotRemovedPiece: addConfirm } : {}),
    };
    const out = await w.save<StockAdjustmentResult>('stock_adjustments.add_old_stock', {
      local: () => addOldStockOnPrimary(input, reload),
      remote: () => input,
    });
    if (out.kind !== 'ok') { setMsg({ text: fehlertext(out), ok: false }); return; }
    setMsg({ text: `${out.value.adjustmentNumber}: ${out.value.qtyBefore} → ${out.value.qtyAfter} · old stock, opening pending`, ok: true });
    setAddOpen(false);
    reload();
  }

  function start(): void {
    w.clear(); setActionId(uuid()); setQty('1'); setCategory('LOST'); setReason(''); setDate(today()); setMsg(null); setOpen(true);
  }

  async function confirm(): Promise<void> {
    if (!preview?.plan) return;
    const p = preview.plan;
    const text = p.path === 'LOT'
      ? `Remove ${p.quantity} piece(s) from stock (${p.qtyBefore} → ${p.qtyBefore - p.quantity}) and book ${p.value.toFixed(3)} BHD as inventory loss?`
      : `Remove ${p.quantity} piece(s) from stock (${p.qtyBefore} → ${p.qtyBefore - p.quantity})? This item has no inventory booking — only the quantity changes; the accounting is reconciled later.`;
    if (!(await window.confirm(text))) return;
    const input = { actionId, productId, quantity: p.quantity, expectedQuantity: p.qtyBefore, reasonCategory: category, reason, businessDate: date };
    const out = await w.save<StockAdjustmentResult>('stock_adjustments.issue', {
      local: () => issueStockOnPrimary(input, reload),
      remote: () => input,
    });
    if (out.kind !== 'ok') { setMsg({ text: fehlertext(out), ok: false }); return; }
    const r = out.value;
    setMsg({ text: `${r.adjustmentNumber}: ${r.qtyBefore} → ${r.qtyAfter}${r.accounting === 'BOOKED' ? ` · inventory loss ${Number(r.value).toFixed(3)} BHD` : ' · accounting reconciliation pending'}`, ok: true });
    setOpen(false);
    reload();
  }

  async function cancel(): Promise<void> {
    if (!storno || !stornoReason.trim()) return;
    const { id, number } = storno;
    if (!(await window.confirm(`Cancel ${number}? The stock goes back exactly as before.`))) return;
    const input = { adjustmentId: id, reason: stornoReason.trim() };
    const out = await w.save<StockAdjustmentResult>('stock_adjustments.cancel', {
      local: () => cancelStockAdjustmentOnPrimary(input, reload),
      remote: () => input,
    });
    if (out.kind !== 'ok') { setMsg({ text: fehlertext(out), ok: false }); return; }
    setStorno(null);
    setMsg({ text: `${out.value.adjustmentNumber} cancelled — stock back to ${out.value.qtyBefore}.`, ok: true });
    reload();
  }

  return (
    <Card style={{ marginBottom: 32 }} data-stock-adjustments>
      <div className="flex justify-between items-center">
        <span style={{ fontSize: 13, fontWeight: 600, color: '#0F0F10' }}>Stock corrections</span>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={startAdd} disabled={busy} data-old-stock-open>Add old stock</Button>
          <Button variant="secondary" onClick={start} disabled={busy || !(quantity > 0)} data-stock-issue-open>Remove from stock</Button>
        </div>
      </div>
      {msg && (
        <div data-stock-msg style={{ marginTop: 10, padding: '8px 12px', borderRadius: 8, fontSize: 12,
          background: msg.ok ? 'rgba(126,170,110,0.10)' : 'rgba(170,110,110,0.10)', color: msg.ok ? '#3F6E2F' : '#7A3535' }}>{msg.text}</div>
      )}
      {docs.length === 0 && <p style={{ fontSize: 12, color: '#6B7280', marginTop: 8 }}>No stock corrections for this item.</p>}
      {docs.map((d) => (
        <div key={d.adjustmentId} data-stock-adjustment={d.adjustmentNumber} className="flex justify-between items-center"
          style={{ padding: '8px 0', borderTop: '1px solid #F1F3F5', fontSize: 12, opacity: d.status === 'CANCELLED' ? 0.55 : 1 }}>
          <span>
            <b className="font-mono">{d.adjustmentNumber}</b> · {d.direction === 'RECEIPT' ? '+' : '−'}{d.quantity} ({d.qtyBefore} → {d.qtyAfter}) ·{' '}
            {d.direction === 'RECEIPT'
              ? `old stock${d.unitCostHint !== null ? ` at ${d.unitCostHint.toFixed(3)} BHD` : ''} · opening pending`
              : d.accounting === 'BOOKED' ? `inventory loss ${d.value.toFixed(3)} BHD` : 'accounting reconciliation pending'}
            {d.status === 'CANCELLED' ? ' · cancelled' : ''}
          </span>
          {d.status === 'POSTED' && <Button variant="ghost" disabled={busy} onClick={() => { w.clear(); setStornoReason(''); setStorno({ id: d.adjustmentId, number: d.adjustmentNumber }); }} data-stock-adjustment-cancel>Cancel</Button>}
        </div>
      ))}

      {open && (
        <Modal open onClose={() => setOpen(false)} title="Remove from stock" width={560}>
          <div data-stock-issue-dialog style={{ display: 'grid', gap: 12, fontSize: 13 }}>
            <p style={{ color: '#4B5563' }}>For pieces that are lost, stolen, damaged or were counted wrongly. Sales, returns and consignment have their own way.</p>
            <Input label="Pieces to remove" value={qty} onChange={(e) => setQty(e.target.value)} data-stock-issue-qty />
            <label style={{ display: 'grid', gap: 4 }}>
              <span className="text-overline">REASON</span>
              <select value={category} onChange={(e) => setCategory(e.target.value)} data-stock-issue-category>
                {STOCK_ADJUSTMENT_REASONS.map((r) => <option key={r} value={r}>{REASON_LABEL[r]}</option>)}
              </select>
            </label>
            <Input label="What happened (required)" value={reason} onChange={(e) => setReason(e.target.value)} data-stock-issue-reason />
            <Input label="Business date" type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} />
            {preview?.plan ? (
              <div data-stock-issue-preview style={{ padding: '10px 12px', borderRadius: 8, background: '#F5F7FA', fontSize: 12, color: '#374151' }}>
                Stock {preview.plan.qtyBefore} → {preview.plan.qtyBefore - preview.plan.quantity}.{' '}
                {preview.plan.path === 'LOT'
                  ? `Inventory loss ${preview.plan.value.toFixed(3)} BHD from ${preview.plan.lots.length} lot(s), oldest first.`
                  : `No inventory booking exists for this item: only the quantity changes, marked for later accounting reconciliation${preview.plan.purchasePriceHint !== null ? ` (purchase price ${preview.plan.purchasePriceHint})` : ''}.`}
              </div>
            ) : (
              <div data-stock-issue-refused style={{ padding: '10px 12px', borderRadius: 8, background: 'rgba(170,110,110,0.10)', fontSize: 12, color: '#7A3535' }}>
                {preview?.issue ?? 'Enter a whole number of pieces.'}
              </div>
            )}
            {msg && !msg.ok && <div data-stock-dialog-error style={{ fontSize: 12, color: '#7A3535' }}>{msg.text}</div>}
            <div className="flex justify-end gap-3">
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button variant="primary" disabled={busy || !preview?.plan || !reason.trim()} onClick={() => void confirm()} data-stock-issue-submit>Confirm</Button>
            </div>
          </div>
        </Modal>
      )}
      {addOpen && (
        <Modal open onClose={() => setAddOpen(false)} title="Add old stock" width={560}>
          <div data-old-stock-dialog style={{ display: 'grid', gap: 12, fontSize: 13 }}>
            <p style={{ color: '#4B5563' }}>For more pieces of this item that you already owned (old stock). No money is booked and nothing is purchased — buy new goods with a Purchase. The opening of old stock is reconciled later.</p>
            <Input label="Pieces to add" value={addQty} onChange={(e) => setAddQty(e.target.value)} data-old-stock-qty />
            <Input label="Historical cost per piece (BHD)" value={addCost} onChange={(e) => setAddCost(e.target.value)} data-old-stock-cost />
            <Input label="Where do these pieces come from (required)" value={addReason} onChange={(e) => setAddReason(e.target.value)} data-old-stock-reason />
            <Input label="Business date" type="date" value={addDate} max={today()} onChange={(e) => setAddDate(e.target.value)} />
            {addPreview?.plan ? (
              <div data-old-stock-preview style={{ padding: '10px 12px', borderRadius: 8, background: '#F5F7FA', fontSize: 12, color: '#374151' }}>
                Stock {addPreview.plan.qtyBefore} → {addPreview.plan.qtyBefore + addPreview.plan.quantity}, historical cost {addPreview.plan.unitCost.toFixed(3)} BHD per piece
                {addPreview.plan.itemCost !== null && Math.abs(addPreview.plan.itemCost - addPreview.plan.unitCost) > 0.0005 ? ` (the item shows ${addPreview.plan.itemCost.toFixed(3)} — this difference will be listed for review)` : ''}. No booking.
              </div>
            ) : (
              <div data-old-stock-refused style={{ padding: '10px 12px', borderRadius: 8, background: 'rgba(170,110,110,0.10)', fontSize: 12, color: '#7A3535' }}>
                {addPreview?.issue ?? 'Enter a whole number of pieces and the historical cost.'}
              </div>
            )}
            {addPreview?.plan && addPreview.plan.openRemovals.length > 0 && (
              <label data-old-stock-removals style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12, color: '#7A5A1F' }}>
                <input type="checkbox" checked={addConfirm} onChange={(e) => setAddConfirm(e.target.checked)} data-old-stock-confirm />
                <span>This item has removals ({addPreview.plan.openRemovals.map((r) => r.adjustmentNumber).join(', ')}). A found piece that was removed belongs to its removal (cancel it if possible) — I confirm these are other pieces of old stock.</span>
              </label>
            )}
            {msg && !msg.ok && <div data-stock-dialog-error style={{ fontSize: 12, color: '#7A3535' }}>{msg.text}</div>}
            <div className="flex justify-end gap-3">
              <Button variant="ghost" onClick={() => setAddOpen(false)}>Cancel</Button>
              <Button variant="primary" disabled={busy || !addPreview?.plan || !addReason.trim() || (addPreview.plan.openRemovals.length > 0 && !addConfirm)} onClick={() => void confirmAdd()} data-old-stock-submit>Add old stock</Button>
            </div>
          </div>
        </Modal>
      )}
      {storno && (
        <Modal open onClose={() => setStorno(null)} title={`Cancel ${storno.number}`} width={480}>
          <div style={{ display: 'grid', gap: 12, fontSize: 13 }}>
            <p style={{ color: '#4B5563' }}>Only possible while nothing else has changed the stock of this item since the correction.</p>
            <Input label="Reason (required)" value={stornoReason} onChange={(e) => setStornoReason(e.target.value)} data-stock-cancel-reason />
            {msg && !msg.ok && <div data-stock-dialog-error style={{ fontSize: 12, color: '#7A3535' }}>{msg.text}</div>}
            <div className="flex justify-end gap-3">
              <Button variant="ghost" onClick={() => setStorno(null)}>Back</Button>
              <Button variant="primary" disabled={busy || !stornoReason.trim()} onClick={() => void cancel()} data-stock-cancel-submit>Cancel correction</Button>
            </div>
          </div>
        </Modal>
      )}
    </Card>
  );
}
