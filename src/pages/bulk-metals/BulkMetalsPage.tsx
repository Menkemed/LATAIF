// ════════════════════════════════════════════════════════════════════════════
// BULK METAL V1 — die Seite „Bulk Metals" (Spec 12.1). Lots je Metall/Feinheit mit Restgewicht,
// Original Cost/g, Current Cost Basis/g, Restwert und Live-Referenz; Lot-Detail mit Composition,
// „Sold as", Bewegungsverlauf und Verkäufen; die manuellen Aktionen (Korrektur, Write-off, Close,
// Abschreibung stornieren) mit stabiler action_id je Dialog. Alle Zahlen kommen vom Primary.
// ════════════════════════════════════════════════════════════════════════════
import { useEffect, useMemo, useState } from 'react';
import { Scale } from 'lucide-react';
import { PageLayout } from '@/components/layout/PageLayout';
import { KPICard } from '@/components/ui/KPICard';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { WriteError } from '@/components/shared/WriteError';
import { useSharedRead } from '@/core/data/shared-read';
import { useSharedWrites } from '@/core/data/shared-write';
import { usePermission } from '@/hooks/usePermission';
import { metalPurity } from '@/core/gold/purity';
import { getSpotPrices, bhdPerGramFine } from '@/core/market/spot-prices';
import {
  COMPOSITION_LABEL, COMPOSITION_TYPES, SALE_TO_COMPOSITION, costPerGramText, formatFils, formatMg,
  parseGramsToMg, type BulkType, type CompositionType,
} from '@/core/bulk/bulk-math';
import { bulkLotDetailFor, bulkMetalsPageFor, type BulkLotDetail, type BulkLotRow, type BulkPageData } from '@/core/bulk/bulk-reads';
import {
  closeLotOnPrimary, correctLotOnPrimary, newBulkActionId, reverseAdjustmentOnPrimary, writeOffOnPrimary,
} from '@/core/bulk/bulk-actions';

const EMPTY: BulkPageData = { articles: [], totalValueFils: 0, reconciliation: { lotsValueFils: 0, ledgerValueFils: 0, ok: true } };
const KIND_LABEL: Record<string, string> = {
  PURCHASE: 'Purchase', WEIGHT_CORRECTION: 'Weight correction', PURCHASE_CANCEL: 'Purchase cancelled', SALE: 'Sale',
  SALE_REVERSAL: 'Sale reversed', RETURN: 'Return', RETURN_CANCEL: 'Return cancelled', WRITE_OFF: 'Write-off',
  CLOSE: 'Close lot', ADJUSTMENT_REVERSAL: 'Write-off reversed',
};
const g = (mg: number): string => formatMg(mg);
const bhd = (fils: number): string => formatFils(fils);
const today = (): string => new Date().toISOString().slice(0, 10);

type Live = { gold?: number; silver?: number };
/** Live Market/g = BHD/g fein (SSOT) × Reinheit — nur Referenz, nie gebucht. */
function livePerGram(live: Live, metal: string, fineness: string): number | null {
  const fine = metal === 'gold' ? live.gold : metal === 'silver' ? live.silver : undefined;
  const purity = metalPurity(metal, fineness);
  return fine !== undefined && purity !== null ? fine * purity : null;
}

type Dialog =
  | { kind: 'writeoff'; lot: BulkLotRow; actionId: string }
  | { kind: 'close'; lot: BulkLotRow; actionId: string }
  | { kind: 'correct'; lot: BulkLotRow; actionId: string }
  | { kind: 'reverse'; lot: BulkLotRow; actionId: string };

export function BulkMetalsPage() {
  const perm = usePermission();
  const w = useSharedWrites();
  const [refresh, setRefresh] = useState(0);
  const page = useSharedRead('page.bulk_metals.get', { r: refresh }, bulkMetalsPageFor, EMPTY, [refresh]);
  const [live, setLive] = useState<Live>({});
  const [openLot, setOpenLot] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);

  useEffect(() => {
    let alive = true;
    void getSpotPrices().then((r) => {
      if (!alive) return;
      setLive({ gold: r.gold ? bhdPerGramFine(r.gold.usdPerOunce) : undefined, silver: r.silver ? bhdPerGramFine(r.silver.usdPerOunce) : undefined });
    }).catch(() => { /* keine Live-Referenz */ });
    return () => { alive = false; };
  }, []);

  const liveTotal = useMemo(() => {
    let sum = 0; let any = false;
    for (const a of page.articles) {
      const per = livePerGram(live, a.metal, a.fineness);
      if (per !== null) { sum += per * a.remainingWeightMg / 1000; any = true; }
    }
    return any ? sum : null;
  }, [page, live]);

  const reload = (): void => setRefresh((r) => r + 1);
  if (!perm.can('bulk_metals.view')) {
    return (
      <PageLayout title="Bulk Metals">
        <p data-bulk-no-access style={{ fontSize: 14, color: '#6B7280' }}>You do not have access to Bulk Metals.</p>
      </PageLayout>
    );
  }
  const open = (kind: Dialog['kind'], lot: BulkLotRow): void => { w.clear(); setDialog({ kind, lot, actionId: newBulkActionId() } as Dialog); };

  return (
    <PageLayout title="Bulk Metals" subtitle="Saleable metal by weight — lots, remaining grams, cost basis and live reference">
      <div data-bulk-notice style={{ padding: '10px 14px', background: '#F5F7FA', border: '1px solid #E5E9EE', borderRadius: 8, fontSize: 13, color: '#374151', marginBottom: 20 }}>
        Bulk Metals holds saleable stock by weight. Bars and single items stay in Precious Metals. Never record the same goods in both modules.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20, marginBottom: 24 }}>
        <KPICard label="BULK STOCK VALUE (COST)" value={bhd(page.totalValueFils)} unit="BHD · remaining lot values" />
        <KPICard label="LIVE MARKET VALUE" value={liveTotal === null ? '—' : liveTotal.toFixed(3)} unit="BHD · reference, not booked" />
        <KPICard label="LEDGER CHECK" value={page.reconciliation.ok ? 'OK' : 'MISMATCH'}
          unit={`lots ${bhd(page.reconciliation.lotsValueFils)} · ledger ${bhd(page.reconciliation.ledgerValueFils)}`} />
      </div>
      {!dialog && <WriteError text={w.fehler} />}

      {page.articles.length === 0 && (
        <div style={{ padding: '64px 0', textAlign: 'center' }}>
          <Scale size={40} strokeWidth={1} style={{ color: '#6B7280', margin: '0 auto 16px' }} />
          <p style={{ fontSize: 14, color: '#6B7280' }}>No bulk metal yet. Buy it with “Add bulk metal” in a new purchase.</p>
        </div>
      )}

      {page.articles.map((a) => {
        const per = livePerGram(live, a.metal, a.fineness);
        return (
          <div key={a.productId} data-bulk-article={a.productId} style={{ marginBottom: 28 }}>
            <div className="flex justify-between items-center" style={{ marginBottom: 8 }}>
              <h3 style={{ fontSize: 16, fontWeight: 600, color: '#0F0F10' }}>{a.name}</h3>
              <span style={{ fontSize: 13, color: '#4B5563' }}>
                {g(a.remainingWeightMg)} g · {bhd(a.remainingValueFils)} BHD
                {per !== null ? ` · live ${(per * a.remainingWeightMg / 1000).toFixed(3)} BHD` : ' · live —'}
              </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '0.8fr 1.4fr 0.8fr 0.8fr 0.8fr 0.8fr 1fr 0.8fr 1fr 0.7fr 0.7fr 0.6fr', gap: 10, padding: '6px 10px', fontSize: 11, color: '#6B7280' }}>
              <span>LOT</span><span>PURCHASE</span><span style={{ textAlign: 'right' }}>ORIGINAL g</span><span style={{ textAlign: 'right' }}>REMAINING g</span>
              <span style={{ textAlign: 'right' }}>ORIG. COST/g</span><span style={{ textAlign: 'right' }}>CURRENT COST/g</span><span style={{ textAlign: 'right' }}>REMAINING VALUE</span>
              <span style={{ textAlign: 'right' }}>LIVE/g</span><span style={{ textAlign: 'right' }}>LIVE VALUE</span><span>TAX</span><span>STATUS</span><span />
            </div>
            {a.lots.map((l) => (
              <div key={l.id} data-bulk-lot={l.lotNo} style={{ display: 'grid', gridTemplateColumns: '0.8fr 1.4fr 0.8fr 0.8fr 0.8fr 0.8fr 1fr 0.8fr 1fr 0.7fr 0.7fr 0.6fr', gap: 10, padding: '8px 10px', borderTop: '1px solid #E5E9EE', fontSize: 13, alignItems: 'center' }}>
                <span className="font-mono">{l.lotNo}</span>
                <span style={{ color: '#4B5563' }}>{l.purchaseNumber ?? '—'} · {l.acquiredAt}{l.supplierName ? ` · ${l.supplierName}` : ''}</span>
                <span className="font-mono" style={{ textAlign: 'right' }}>{g(l.originalWeightMg)}</span>
                <span className="font-mono" style={{ textAlign: 'right' }} data-bulk-remaining-mg={l.remainingWeightMg}>{g(l.remainingWeightMg)}</span>
                <span className="font-mono" style={{ textAlign: 'right' }}>{costPerGramText(l.originalValueFils, l.originalWeightMg)}</span>
                <span className="font-mono" style={{ textAlign: 'right' }}>{costPerGramText(l.remainingValueFils, l.remainingWeightMg)}</span>
                <span className="font-mono" style={{ textAlign: 'right' }} data-bulk-remaining-fils={l.remainingValueFils}>{bhd(l.remainingValueFils)}</span>
                <span className="font-mono" style={{ textAlign: 'right' }}>{per === null ? '—' : per.toFixed(3)}</span>
                <span className="font-mono" style={{ textAlign: 'right' }}>{per === null ? '—' : (per * l.remainingWeightMg / 1000).toFixed(3)}</span>
                <span>{l.saleTaxScheme}</span>
                <span data-bulk-status={l.status}>{l.status}</span>
                <Button variant="ghost" onClick={() => setOpenLot(l.id)} data-bulk-open={l.lotNo}>Details</Button>
              </div>
            ))}
          </div>
        );
      })}

      {openLot && !dialog && (
        <LotDetailModal lotId={openLot} refresh={refresh} onClose={() => setOpenLot(null)}
          canAdjust={perm.isAdmin} canReverse={perm.isOwner} onAction={open} />
      )}

      {dialog && (
        <ActionDialog dialog={dialog} fehler={w.fehler} busy={w.busy} onClose={() => setDialog(null)}
          onSubmit={async (body) => {
            const lot = dialog.lot;
            const input = { actionId: dialog.actionId, lotId: lot.id, expectedRevision: lot.revision, ...body };
            const op = dialog.kind === 'writeoff' ? 'bulk_metals.write_off' : dialog.kind === 'close' ? 'bulk_metals.close_lot'
              : dialog.kind === 'correct' ? 'bulk_metals.correct_weight' : 'bulk_metals.reverse_adjustment';
            const ok = await w.ok(op, {
              local: () => dialog.kind === 'writeoff' ? writeOffOnPrimary(input as never, reload)
                : dialog.kind === 'close' ? closeLotOnPrimary(input as never, reload)
                  : dialog.kind === 'correct' ? correctLotOnPrimary(input as never, reload)
                    : reverseAdjustmentOnPrimary(input as never, reload),
              remote: () => input,
            });
            if (!ok) return;
            reload();
            setDialog(null);
          }} />
      )}
    </PageLayout>
  );
}

function LotDetailModal({ lotId, refresh, onClose, canAdjust, canReverse, onAction }: {
  lotId: string; refresh: number; onClose: () => void; canAdjust: boolean; canReverse: boolean;
  onAction: (kind: Dialog['kind'], lot: BulkLotRow) => void;
}) {
  const data = useSharedRead('bulk_metals.lot_detail.get', { lotId, r: refresh },
    (ctx) => ({ detail: bulkLotDetailFor(ctx, lotId) }), { detail: null as BulkLotDetail | null }, [lotId, refresh]);
  const d = data.detail;
  if (!d) return <Modal open onClose={onClose} title="Lot"><p style={{ fontSize: 13 }}>Loading…</p></Modal>;
  const l = d.lot;
  const soldByComp = new Map<string, number>();
  let byWeight = 0;
  for (const s of d.soldAs) {
    const c = SALE_TO_COMPOSITION[s.bulkType as BulkType];
    if (c) soldByComp.set(c, (soldByComp.get(c) ?? 0) + s.soldMg); else byWeight += s.soldMg;
  }
  const lastReversible = l.lastMovement && (l.lastMovement.kind === 'WRITE_OFF' || l.lastMovement.kind === 'CLOSE') && !l.lastMovement.reversed;
  return (
    <Modal open onClose={onClose} title={`Lot ${l.lotNo} · ${l.metal} ${l.fineness}`} width={860}>
      <div data-bulk-detail={l.lotNo} style={{ display: 'grid', gap: 16, fontSize: 13 }}>
        <div className="flex gap-6" style={{ flexWrap: 'wrap', color: '#374151' }}>
          <span>Remaining <b className="font-mono">{g(l.remainingWeightMg)} g</b></span>
          <span>Value <b className="font-mono">{bhd(l.remainingValueFils)} BHD</b></span>
          <span>Original cost/g <b className="font-mono">{costPerGramText(l.originalValueFils, l.originalWeightMg)}</b></span>
          <span>Current cost/g <b className="font-mono">{costPerGramText(l.remainingValueFils, l.remainingWeightMg)}</b></span>
          <span>Tax <b>{l.saleTaxScheme}</b></span>
          <span>Status <b>{l.status}</b></span>
        </div>
        {canAdjust && (
          <div className="flex gap-3" style={{ flexWrap: 'wrap' }}>
            {l.unused && l.status === 'ACTIVE' && <Button variant="secondary" onClick={() => onAction('correct', l)} data-bulk-action="correct">Correct lot</Button>}
            {l.status === 'ACTIVE' && <Button variant="secondary" onClick={() => onAction('writeoff', l)} data-bulk-action="writeoff">Write off grams</Button>}
            {l.status === 'ACTIVE' && <Button variant="secondary" onClick={() => onAction('close', l)} data-bulk-action="close">Close lot</Button>}
            {canReverse && lastReversible && <Button variant="ghost" onClick={() => onAction('reverse', l)} data-bulk-action="reverse">Reverse last {l.lastMovement!.kind === 'CLOSE' ? 'close' : 'write-off'}</Button>}
          </div>
        )}
        <div>
          <span className="text-overline">COMPOSITION (PURCHASED) · SOLD AS</span>
          {COMPOSITION_TYPES.map((t) => {
            const purchased = l.composition.find((c) => c.type === t);
            const sold = soldByComp.get(t) ?? 0;
            if (!purchased && !sold) return null;
            return (
              <div key={t} className="flex justify-between" style={{ padding: '4px 0', borderBottom: '1px solid #F1F3F5' }}>
                <span>{COMPOSITION_LABEL[t as CompositionType]}</span>
                <span className="font-mono">Purchased {purchased ? `${g(purchased.weightMg)} g${purchased.pieces ? ` (~${purchased.pieces} pcs)` : ''}` : '—'} · Sold as {g(sold)} g</span>
              </div>
            );
          })}
          {byWeight > 0 && <div className="flex justify-between" style={{ padding: '4px 0' }}><span>By weight</span><span className="font-mono">Sold {g(byWeight)} g</span></div>}
        </div>
        <div>
          <span className="text-overline">MOVEMENTS</span>
          {d.movements.map((m) => (
            <div key={m.id} data-bulk-movement={m.kind} style={{ display: 'grid', gridTemplateColumns: '0.3fr 1.1fr 0.8fr 0.8fr 0.8fr 0.9fr 1.6fr', gap: 8, padding: '4px 0', borderBottom: '1px solid #F1F3F5' }}>
              <span className="font-mono">{m.seq}</span>
              <span>{KIND_LABEL[m.kind] ?? m.kind}{m.reversed ? ' (reversed)' : ''}</span>
              <span className="font-mono" style={{ textAlign: 'right' }}>{g(m.weightMg)} g</span>
              <span className="font-mono" style={{ textAlign: 'right' }}>{bhd(m.valueFils)}</span>
              <span className="font-mono" style={{ textAlign: 'right' }}>{g(m.weightAfterMg)} g</span>
              <span>{m.businessDate}</span>
              <span style={{ color: '#4B5563' }}>{m.document}{m.reason && m.document !== m.reason ? ` · ${m.reason}` : ''} · {m.createdBy}</span>
            </div>
          ))}
        </div>
        <div>
          <span className="text-overline">SALES</span>
          {d.sales.length === 0 && <p style={{ color: '#6B7280' }}>No sales yet.</p>}
          {d.sales.map((s) => (
            <div key={s.lineId} style={{ display: 'grid', gridTemplateColumns: '1fr 0.8fr 1.6fr 0.7fr 0.8fr 0.8fr 0.8fr 0.8fr', gap: 8, padding: '4px 0', borderBottom: '1px solid #F1F3F5', opacity: s.returned || s.cancelled ? 0.5 : 1 }}>
              <span className="font-mono">{s.invoiceNumber}</span>
              <span>{s.date}</span>
              <span>{s.description}{s.returned ? ' · returned' : ''}{s.cancelled ? ' · cancelled' : ''}</span>
              <span className="font-mono" style={{ textAlign: 'right' }}>{g(s.weightMg)} g</span>
              <span className="font-mono" style={{ textAlign: 'right' }}>COGS {bhd(s.cogsFils)}</span>
              <span className="font-mono" style={{ textAlign: 'right' }}>Net {bhd(s.netRevenueFils)}</span>
              <span className="font-mono" style={{ textAlign: 'right' }}>Margin {bhd(s.marginFils)}</span>
              <span className="font-mono" style={{ textAlign: 'right' }}>{costPerGramText(s.marginFils, s.weightMg)}/g</span>
            </div>
          ))}
        </div>
        <div className="flex justify-end"><Button variant="ghost" onClick={onClose}>Close</Button></div>
      </div>
    </Modal>
  );
}

function ActionDialog({ dialog, fehler, busy, onClose, onSubmit }: {
  dialog: Dialog; fehler: string; busy: boolean; onClose: () => void; onSubmit: (body: Record<string, unknown>) => Promise<void>;
}) {
  const l = dialog.lot;
  const [grams, setGrams] = useState(dialog.kind === 'correct' ? g(l.originalWeightMg) : '');
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(today());
  const [comp, setComp] = useState<Array<{ type: CompositionType; grams: string; pieces: string }>>([]);
  const [localError, setLocalError] = useState('');
  const detail = useSharedRead('bulk_metals.lot_detail.get', { lotId: l.id }, (ctx) => ({ detail: bulkLotDetailFor(ctx, l.id) }),
    { detail: null as BulkLotDetail | null }, [l.id]);
  useEffect(() => {
    if (dialog.kind === 'correct' && detail.detail) {
      setComp(detail.detail.lot.composition.map((c) => ({ type: c.type, grams: g(c.weightMg), pieces: c.pieces ? String(c.pieces) : '' })));
    }
  }, [dialog.kind, detail.detail]);
  const title = dialog.kind === 'writeoff' ? `Write off grams · ${l.lotNo}` : dialog.kind === 'close' ? `Close lot / write off remaining stock · ${l.lotNo}`
    : dialog.kind === 'correct' ? `Correct lot · ${l.lotNo}` : `Reverse last ${l.lastMovement?.kind === 'CLOSE' ? 'close' : 'write-off'} · ${l.lotNo}`;

  async function submit(): Promise<void> {
    setLocalError('');
    try {
      if (dialog.kind === 'writeoff') await onSubmit({ weightMg: parseGramsToMg(grams.trim()), reason, businessDate: date });
      else if (dialog.kind === 'close') await onSubmit({ confirmWeightMg: l.remainingWeightMg, confirmValueFils: l.remainingValueFils, reason, businessDate: date });
      else if (dialog.kind === 'correct') {
        await onSubmit({
          newWeightMg: parseGramsToMg(grams.trim()), reason,
          composition: comp.filter((c) => c.grams.trim()).map((c) => ({ type: c.type, weightMg: parseGramsToMg(c.grams.trim()), ...(c.pieces.trim() ? { pieces: Number(c.pieces) } : {}) })),
        });
      } else await onSubmit({ movementId: l.lastMovement?.id, reason });
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Modal open onClose={onClose} title={title} width={560}>
      <div data-bulk-dialog={dialog.kind} style={{ display: 'grid', gap: 12, fontSize: 13 }}>
        <p style={{ color: '#4B5563' }}>Remaining: <b className="font-mono">{g(l.remainingWeightMg)} g · {bhd(l.remainingValueFils)} BHD</b></p>
        {dialog.kind === 'close' && <p>The whole remaining stock is written off as inventory loss (no COGS, no VAT correction).</p>}
        {dialog.kind === 'reverse' && <p>The latest write-off/close of this lot is reversed exactly (same grams and value, ledger mirrored). Only the latest movement can be reversed.</p>}
        {(dialog.kind === 'writeoff' || dialog.kind === 'correct') && (
          <Input label={dialog.kind === 'correct' ? 'Corrected total weight (g)' : 'Weight to write off (g)'} value={grams}
            onChange={(e) => setGrams(e.target.value)} placeholder="e.g. 1.200" data-bulk-grams />
        )}
        {dialog.kind === 'correct' && (
          <div>
            <span className="text-overline">COMPOSITION (never scaled automatically)</span>
            {comp.map((c, i) => (
              <div key={i} className="flex gap-2" style={{ marginTop: 6 }}>
                <select value={c.type} onChange={(e) => setComp(comp.map((x, k) => k === i ? { ...x, type: e.target.value as CompositionType } : x))}>
                  {COMPOSITION_TYPES.map((t) => <option key={t} value={t}>{COMPOSITION_LABEL[t]}</option>)}
                </select>
                <Input value={c.grams} onChange={(e) => setComp(comp.map((x, k) => k === i ? { ...x, grams: e.target.value } : x))} placeholder="g" />
                <Input value={c.pieces} onChange={(e) => setComp(comp.map((x, k) => k === i ? { ...x, pieces: e.target.value } : x))} placeholder="~ pcs" />
                <Button variant="ghost" onClick={() => setComp(comp.filter((_, k) => k !== i))}>×</Button>
              </div>
            ))}
            <Button variant="ghost" onClick={() => setComp([...comp, { type: 'MIXED_OTHER', grams: '', pieces: '' }])}>+ Composition row</Button>
          </div>
        )}
        {(dialog.kind === 'writeoff' || dialog.kind === 'close') && (
          <Input label="Business date" type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} />
        )}
        <Input label="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} data-bulk-reason />
        <WriteError text={localError || fehler} />
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy || !reason.trim()} data-bulk-submit>Confirm</Button>
        </div>
      </div>
    </Modal>
  );
}
