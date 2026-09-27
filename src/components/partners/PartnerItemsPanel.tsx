// PARTNER-ITEMS — die Artikelbeteiligungen der Partner: je Artikel Anteil, Kostenanteil (inkl.
// nachträglich aktivierter Kosten), Beiträge, Auszahlungen, Gewinn (rechnerisch / freigegeben) und der
// offene Ausgleich; darüber die Summen je Partner. Alle Handlungen gehen am Hauptrechner direkt, auf
// PC2 als geprüfter Befehl — gebucht wird immer am Hauptrechner.
import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Bhd } from '@/components/ui/Bhd';
import { WriteError } from '@/components/shared/WriteError';
import { useSharedWrites, fehlertext } from '@/core/data/shared-write';
import type { PartnerItemSale, PartnerItemView, PartnerItemsOfPartner } from '@/core/partners/item-participation-house';
import { saveCancelMovement, saveItemMovement, saveItemOffset, saveSettleSale } from '@/core/partners/item-participation-save';
import type { Partner } from '@/core/models/types';
import { OwnershipChangeModal, type OwnershipTarget } from './OwnershipChangeModal';

const fmt = (v: number): string => v.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });

/** Offener Ausgleich in Worten: wer schuldet wem. */
export function openText(open: number, partnerName: string): string {
  if (Math.abs(open) < 0.0005) return 'settled';
  return open > 0 ? `LATAIF owes ${partnerName} ${fmt(open)} BHD` : `${partnerName} owes LATAIF ${fmt(-open)} BHD`;
}

const KIND_LABEL: Record<string, string> = {
  CONTRIBUTION: 'Contribution / repayment (partner → LATAIF)',
  PAYOUT: 'Payout (LATAIF → partner)',
  PROFIT_SHARE: 'Profit share settled',
  PROFIT_CORRECTION: 'Settlement correction',
  OFFSET: 'Offset with another item',
  SUPPLIER_RETURN: 'Returned to supplier — share of gain/loss',
  TAKEOVER: 'Pieces left the partnership',
};

interface MoveForm { item: PartnerItemView; partnerId: string; partnerName: string; kind: 'CONTRIBUTION' | 'PAYOUT' }
interface OffsetForm { partner: PartnerItemsOfPartner; from: string; to: string }

export function PartnerItemsPanel({ overview, partners = [] }: { overview: PartnerItemsOfPartner[]; partners?: Partner[] }) {
  const w = useSharedWrites();
  const [own, setOwn] = useState<{ mode: 'TAKEOVER' | 'CHANGE'; target: OwnershipTarget } | null>(null);
  const [openRows, setOpenRows] = useState<Record<string, boolean>>({});
  const [form, setForm] = useState<MoveForm | null>(null);
  const [offset, setOffset] = useState<OffsetForm | null>(null);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<'cash' | 'bank' | 'benefit'>('bank');
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [note, setNote] = useState('');
  const [fehler, setFehler] = useState('');
  const [busy, setBusy] = useState(false);

  if (overview.length === 0) return null;

  function ownTarget(it: PartnerItemView): OwnershipTarget {
    const current = overview.flatMap((p) => p.items.filter((x) => x.purchaseLineId === it.purchaseLineId && x.participating)
      .map((x) => ({ partnerId: p.partnerId, sharePct: x.sharePct })));
    return { purchaseLineId: it.purchaseLineId, label: `${it.productLabel} · ${it.purchaseNumber}`, qty: it.ownership.qty, value: it.ownership.value, current };
  }
  const today = () => new Date().toISOString().split('T')[0];

  function openForm(item: PartnerItemView, partnerId: string, partnerName: string, kind: MoveForm['kind']) {
    setForm({ item, partnerId, partnerName, kind });
    const suggestion = kind === 'CONTRIBUTION' ? Math.max(0, -item.open) : Math.max(0, item.open);
    setAmount(suggestion > 0 ? suggestion.toFixed(3) : '');
    setMethod('bank'); setDate(today()); setNote(''); setFehler('');
  }

  function openOffset(p: PartnerItemsOfPartner) {
    const from = p.items.find((i) => i.open > 0 && !i.correctionPending);
    const to = p.items.find((i) => i.open < 0 && !i.correctionPending);
    setOffset({ partner: p, from: from?.purchaseLineId ?? '', to: to?.purchaseLineId ?? '' });
    setAmount(from && to ? Math.min(from.open, -to.open).toFixed(3) : '');
    setDate(today()); setNote(''); setFehler('');
  }

  async function saveMove() {
    if (!form) return;
    setBusy(true); setFehler('');
    const r = await saveItemMovement(w, {
      purchaseLineId: form.item.purchaseLineId, partnerId: form.partnerId, kind: form.kind,
      amount: parseFloat(amount), method, date, note: note || undefined,
    });
    setBusy(false);
    if (r.kind !== 'ok') { setFehler(fehlertext(r)); return; }
    setForm(null);
  }

  async function saveOffset() {
    if (!offset) return;
    setBusy(true); setFehler('');
    const r = await saveItemOffset(w, {
      partnerId: offset.partner.partnerId, fromPurchaseLineId: offset.from, toPurchaseLineId: offset.to,
      amount: parseFloat(amount), date, note: note || undefined,
    });
    setBusy(false);
    if (r.kind !== 'ok') { setFehler(fehlertext(r)); return; }
    setOffset(null);
  }

  async function settle(item: PartnerItemView, s: PartnerItemSale, partnerName: string) {
    const correction = s.state === 'NEEDS_CORRECTION';
    const text = correction
      ? `Correct the settlement of ${s.invoiceNumber || 'this sale'}?\n\nThe sale changed after it was settled. Profit today (ERP rule): ${fmt(s.profit)} BHD; ` +
        `${partnerName}'s share today ${fmt(s.partnerShare)} BHD, settled so far ${fmt(s.released)} BHD.\n` +
        `Only the difference (${fmt(s.partnerShare - s.released)} BHD) is booked today. Earlier settlements and payouts stay as they are — ` +
        `if the partner was paid too much, the item shows what they owe back (repayment or offset).`
      : `Settle the sale on ${s.invoiceNumber}?\n\nNet sale ${fmt(s.net)} − cost ${fmt(s.cost)}` +
        `${s.cardFee ? ` − card fee ${fmt(s.cardFee)}` : ''} = profit ${fmt(s.profit)} BHD.\n` +
        `${partnerName}'s share ${fmt(s.partnerShare)} BHD · LATAIF's share ${fmt(s.lataifShare)} BHD.\n` +
        `The partner's share goes on their item balance. No money moves yet — pay out afterwards with "Pay out".`;
    if (!(await window.confirm(text))) return;
    setBusy(true); setFehler('');
    const r = await saveSettleSale(w, s.invoiceLineId);
    setBusy(false);
    if (r.kind !== 'ok') setFehler(`${item.productLabel}: ${fehlertext(r)}`);
  }

  async function cancelMove(item: PartnerItemView, movementId: string, kind: string) {
    const warning = kind === 'PAYOUT' || kind === 'CONTRIBUTION'
      ? 'Reverse this entry as an ENTRY ERROR? Only do this if the money did NOT actually move. A real payment stays — a changed sale is fixed with "Correct settlement".'
      : 'Reverse this entry as an entry error? It is reversed in the books and stays visible as cancelled.';
    if (!(await window.confirm(warning))) return;
    setBusy(true); setFehler('');
    const r = await saveCancelMovement(w, movementId);
    setBusy(false);
    if (r.kind !== 'ok') setFehler(`${item.productLabel}: ${fehlertext(r)}`);
  }

  const grid = '2.2fr 0.55fr 0.95fr 0.9fr 0.9fr 1fr 1fr 1.2fr';

  return (
    <div style={{ marginTop: 28 }} data-partner-items>
      <span className="text-overline" style={{ marginBottom: 10, display: 'block' }}>JOINTLY BOUGHT ITEMS</span>
      <WriteError text={fehler} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {overview.map((p) => (
          <Card key={p.partnerId}>
            <div className="flex items-start justify-between" style={{ marginBottom: 10 }} data-partner-items-partner={p.partnerId}>
              <div>
                <h3 style={{ fontSize: 16, color: '#0F0F10', fontWeight: 500 }}>
                  {p.name}{!p.active && <span style={{ fontSize: 11, color: '#9CA3AF', marginLeft: 8 }}>(inactive)</span>}
                </h3>
                <div style={{ fontSize: 11, color: '#6B7280', marginTop: 4 }} data-partner-items-profit>
                  Profit share: computed <Bhd v={p.profitComputed} /> · released <Bhd v={p.profitReleased} /> · paid out in total <Bhd v={p.paidOut} /> · contributed <Bhd v={p.contributed} />
                </div>
              </div>
              <div style={{ textAlign: 'right', fontSize: 12 }} data-partner-items-total={p.openTotal.toFixed(3)}>
                <div style={{ color: p.openTotal >= 0 ? '#0F0F10' : '#DC2626' }}>{openText(p.openTotal, p.name)}</div>
                <div style={{ color: '#6B7280', fontSize: 11 }}>
                  owed to partner <Bhd v={p.owedToPartner} /> · owed by partner <Bhd v={p.owedByPartner} />
                </div>
                {p.owedToPartner > 0 && p.owedByPartner > 0 && (
                  <Button variant="ghost" disabled={busy} onClick={() => openOffset(p)} data-partner-items-offset={p.partnerId}>Offset items</Button>
                )}
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: grid, gap: 8, fontSize: 10, color: '#6B7280', paddingBottom: 6, borderBottom: '1px solid #E5E9EE' }}>
              <span>ITEM</span><span>SHARE</span><span>COST SHARE</span><span>PAID IN</span><span>PAID OUT</span><span>PROFIT COMPUTED</span><span>PROFIT RELEASED</span><span>OPEN</span>
            </div>
            {p.items.map((it) => {
              const key = `${p.partnerId}:${it.purchaseLineId}`;
              const expanded = !!openRows[key];
              return (
                <div key={key} style={{ borderBottom: '1px solid #F0F1F3' }} data-partner-item={it.purchaseLineId}>
                  <div style={{ display: 'grid', gridTemplateColumns: grid, gap: 8, fontSize: 12, padding: '8px 0', alignItems: 'center' }}>
                    <button type="button" onClick={() => setOpenRows({ ...openRows, [key]: !expanded })} className="cursor-pointer flex items-center gap-1"
                      style={{ background: 'none', border: 'none', textAlign: 'left', color: '#0F0F10', padding: 0 }} data-partner-item-toggle={it.purchaseLineId}>
                      {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      <span>{it.productLabel}</span>
                      <span style={{ color: '#9CA3AF', fontSize: 11 }}>· {it.purchaseNumber}{it.quantity > 1 ? ` · ${it.quantity} pcs` : ''}</span>
                    </button>
                    <span>{it.sharePct} %</span>
                    <span className="font-mono"><Bhd v={it.costShare + it.extraCostShare} />{it.extraCostShare !== 0 && <span style={{ fontSize: 10, color: '#9CA3AF' }}> incl. <Bhd v={it.extraCostShare} /> added cost</span>}</span>
                    <span className="font-mono"><Bhd v={it.contributed} /></span>
                    <span className="font-mono"><Bhd v={it.paidOut} /></span>
                    <span className="font-mono"><Bhd v={it.profitComputed} /></span>
                    <span className="font-mono"><Bhd v={it.profitShare} /></span>
                    <span className="font-mono" style={{ color: it.open >= 0 ? '#0F0F10' : '#DC2626' }} data-partner-item-open={it.open.toFixed(3)}><Bhd v={it.open} /></span>
                  </div>
                  {(it.warnings.length > 0 || it.correctionPending) && (
                    <div style={{ fontSize: 11, color: '#B45309', paddingBottom: 6 }} data-partner-item-warning>
                      {it.correctionPending && 'Payouts wait until the settlement is corrected. '}{it.warnings.join(' · ')}
                    </div>
                  )}
                  {expanded && (
                    <div style={{ padding: '4px 0 12px 18px', fontSize: 12 }}>
                      <div style={{ color: '#6B7280', marginBottom: 6 }}>
                        {openText(it.open, p.name)}
                        {it.owedCost > 0 && <> · still to fund for unsold pieces: <Bhd v={it.owedCost} /> BHD</>}
                        {it.offsets !== 0 && <> · offsets <Bhd v={it.offsets} /></>}
                      </div>
                      <div className="flex gap-2" style={{ marginBottom: 10 }}>
                        <Button variant="secondary" disabled={busy}
                          onClick={() => openForm(it, p.partnerId, p.name, 'CONTRIBUTION')} data-partner-item-contribute={it.purchaseLineId}>
                          {it.open < 0 ? 'Record contribution / repayment' : 'Record contribution'}
                        </Button>
                        <Button variant="secondary" disabled={busy || it.open <= 0 || it.correctionPending || it.refundPending}
                          onClick={() => openForm(it, p.partnerId, p.name, 'PAYOUT')} data-partner-item-payout={it.purchaseLineId}>
                          Pay out
                        </Button>
                        {it.ownership.canTakeOver && (
                          <Button variant="ghost" disabled={busy} onClick={() => setOwn({ mode: 'TAKEOVER', target: ownTarget(it) })}
                            data-partner-item-takeover={it.purchaseLineId}>Take over (LATAIF alone)</Button>
                        )}
                        {it.ownership.canChange && it.participating && (
                          <Button variant="ghost" disabled={busy} onClick={() => setOwn({ mode: 'CHANGE', target: ownTarget(it) })}
                            data-partner-item-change={it.purchaseLineId}>Change partners</Button>
                        )}
                      </div>
                      {!it.participating && (
                        <div style={{ color: '#6B7280', marginBottom: 6 }} data-partner-item-ended>
                          No longer a partner on this item ({it.endedReason === 'CHANGE' ? 'partners changed' : 'taken over by LATAIF'}) — history below.
                        </div>
                      )}
                      {it.ownership.blocker && (it.ownership.mode === 'ACTIVE' || it.ownership.mode === 'RETURNED_AFTER_END') && (
                        <div style={{ color: '#9CA3AF', fontSize: 11, marginBottom: 6 }}>Take over / change: {it.ownership.blocker}</div>
                      )}
                      <span className="text-overline" style={{ fontSize: 10 }}>SALES</span>
                      {it.sales.length === 0 && <div style={{ color: '#9CA3AF', margin: '4px 0 8px' }}>Not sold yet.</div>}
                      {it.sales.map((s) => (
                        <div key={s.invoiceLineId} className="flex items-center justify-between" style={{ padding: '4px 0' }} data-partner-item-sale={s.invoiceLineId} data-sale-state={s.state}>
                          <span>
                            {s.invoiceNumber || '(deleted line)'} · {s.invoiceStatus} · qty {s.quantity} · net <Bhd v={s.net} /> − cost <Bhd v={s.cost} />
                            {s.cardFee !== 0 && <> − card fee <Bhd v={s.cardFee} /></>} = profit <Bhd v={s.profit} /> · {p.name}&apos;s share <Bhd v={s.partnerShare} />
                            {' · '}LATAIF&apos;s share <span data-partner-item-lataif-share={s.lataifShare.toFixed(3)}><Bhd v={s.lataifShare} /></span>
                            {s.settled && <> · released <Bhd v={s.released} /></>}
                            {s.state === 'SETTLED' && <span style={{ color: '#16A34A', marginLeft: 6 }}>settled</span>}
                            {s.state === 'NEEDS_CORRECTION' && <span style={{ color: '#B45309', marginLeft: 6 }}>{s.changedAfterSettlement}</span>}
                            {s.blocker && <span style={{ color: '#9CA3AF', marginLeft: 6 }}>— {s.blocker}</span>}
                          </span>
                          {s.settleable && (
                            <Button variant="primary" disabled={busy} onClick={() => void settle(it, s, p.name)}
                              data-partner-item-settle={s.invoiceLineId}>{s.state === 'NEEDS_CORRECTION' ? 'Correct settlement' : 'Settle sale'}</Button>
                          )}
                        </div>
                      ))}
                      <span className="text-overline" style={{ fontSize: 10, marginTop: 8, display: 'block' }}>BOOKINGS</span>
                      {it.movements.length === 0 && <div style={{ color: '#9CA3AF', marginTop: 4 }}>None yet.</div>}
                      {it.movements.map((m) => (
                        <div key={m.id} className="flex items-center justify-between" style={{ padding: '3px 0', color: m.cancelled ? '#9CA3AF' : '#0F0F10', textDecoration: m.cancelled ? 'line-through' : 'none' }}
                          data-partner-item-movement={m.kind}>
                          <span>
                            {m.occurredAt} · {KIND_LABEL[m.kind] ?? m.kind}{m.invoiceNumber ? ` ${m.invoiceNumber}` : ''}
                            {m.method ? ` · ${m.method}` : ''} · <Bhd v={m.amount} /> BHD{m.detail ? ` · ${m.detail}` : ''}{m.note ? ` · ${m.note}` : ''}
                          </span>
                          {!m.cancelled && m.kind !== 'SUPPLIER_RETURN' && m.kind !== 'TAKEOVER' && (
                            <button type="button" disabled={busy} onClick={() => void cancelMove(it, m.id, m.kind)} className="cursor-pointer"
                              style={{ background: 'none', border: 'none', color: '#9CA3AF', fontSize: 11 }} data-partner-item-cancel={m.id}>reverse (entry error)</button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </Card>
        ))}
      </div>

      <OwnershipChangeModal mode={own?.mode ?? null} target={own?.target ?? null} partners={partners} onClose={() => setOwn(null)} />

      <Modal open={!!form} onClose={() => setForm(null)} width={460}
        title={form?.kind === 'CONTRIBUTION' ? `Contribution from ${form?.partnerName ?? ''}` : `Pay out to ${form?.partnerName ?? ''}`}>
        {form && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <WriteError text={fehler} />
            <p style={{ fontSize: 12, color: '#6B7280' }}>
              {form.item.productLabel} · {form.item.purchaseNumber} — {openText(form.item.open, form.partnerName)}.{' '}
              {form.kind === 'CONTRIBUTION'
                ? 'Money the partner pays into LATAIF’s cash or bank for this item (also a repayment). It is not a supplier payment — LATAIF pays the supplier once, on the purchase.'
                : 'Money LATAIF pays the partner from this item — at most what LATAIF owes on it.'}
            </p>
            <Input required label="AMOUNT (BHD)" type="number" step="0.001" value={amount} onChange={(e) => setAmount(e.target.value)} data-partner-item-amount />
            <Input required label="DATE" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            <div>
              <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>METHOD</span>
              <div className="flex gap-2">
                {(['cash', 'bank', 'benefit'] as const).map((m) => (
                  <button key={m} type="button" onClick={() => setMethod(m)} className="cursor-pointer rounded" data-partner-item-method={m}
                    style={{ padding: '8px 14px', fontSize: 13, border: `1px solid ${method === m ? '#0F0F10' : '#D5D9DE'}`, color: method === m ? '#0F0F10' : '#6B7280', background: method === m ? 'rgba(15,15,16,0.06)' : 'transparent' }}>
                    {m === 'cash' ? 'Cash' : m === 'bank' ? 'Bank' : 'Benefit'}
                  </button>
                ))}
              </div>
            </div>
            <Input label="NOTE" placeholder="Optional" value={note} onChange={(e) => setNote(e.target.value)} />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setForm(null)}>Cancel</Button>
              <Button variant="primary" disabled={busy || !amount || parseFloat(amount) <= 0} onClick={() => void saveMove()} data-partner-item-save>Confirm</Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={!!offset} onClose={() => setOffset(null)} width={520} title={`Offset items — ${offset?.partner.name ?? ''}`}>
        {offset && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <WriteError text={fehler} />
            <p style={{ fontSize: 12, color: '#6B7280' }}>
              What LATAIF owes the partner on one item is set off against what the partner owes on another. No money moves; both items show the offset.
            </p>
            <label style={{ fontSize: 12 }}>LATAIF owes on
              <select value={offset.from} onChange={(e) => setOffset({ ...offset, from: e.target.value })} data-partner-offset-from
                style={{ width: '100%', padding: '8px 6px', border: '1px solid #D5D9DE', borderRadius: 6, marginTop: 4 }}>
                {offset.partner.items.filter((i) => i.open > 0).map((i) => <option key={i.purchaseLineId} value={i.purchaseLineId}>{i.productLabel} · {i.purchaseNumber} · {fmt(i.open)}</option>)}
              </select>
            </label>
            <label style={{ fontSize: 12 }}>Partner owes on
              <select value={offset.to} onChange={(e) => setOffset({ ...offset, to: e.target.value })} data-partner-offset-to
                style={{ width: '100%', padding: '8px 6px', border: '1px solid #D5D9DE', borderRadius: 6, marginTop: 4 }}>
                {offset.partner.items.filter((i) => i.open < 0).map((i) => <option key={i.purchaseLineId} value={i.purchaseLineId}>{i.productLabel} · {i.purchaseNumber} · {fmt(-i.open)}</option>)}
              </select>
            </label>
            <Input required label="AMOUNT (BHD)" type="number" step="0.001" value={amount} onChange={(e) => setAmount(e.target.value)} data-partner-offset-amount />
            <Input required label="DATE" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            <Input label="NOTE" placeholder="Optional" value={note} onChange={(e) => setNote(e.target.value)} />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setOffset(null)}>Cancel</Button>
              <Button variant="primary" disabled={busy || !amount || parseFloat(amount) <= 0 || !offset.from || !offset.to} onClick={() => void saveOffset()} data-partner-offset-save>Confirm</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
