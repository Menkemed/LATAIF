// PARTNER-ITEMS — der Block „Jointly bought items" in der Partnerkarte: Summen (eingezahlt, Gewinnanteile,
// ausgezahlt, offen), darunter jeder laufende Artikel dieses Partners mit Stand, offenem Betrag und genau
// einer passenden Handlung; erledigte und übernommene zusammengeklappt. Die Handlung öffnet denselben
// Dialog wie die Artikeltabelle darunter (PartnerItemsPanel) — gebucht und geprüft wird dort.
import { useState } from 'react';
import { Bhd } from '@/components/ui/Bhd';
import type { PartnerItemView, PartnerItemsOfPartner } from '@/core/partners/item-participation-house';

export interface PartnerItemAction {
  kind: 'PAYS_IN' | 'REPAYS' | 'PAY_OUT' | 'SETTLE';
  partnerId: string;
  purchaseLineId: string;
  invoiceLineId?: string;
}

const RED = '#DC2626', GREEN = '#16A34A', GREY = '#6B7280', MUTED = '#9CA3AF';
const fmt = (v: number): string => v.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const done = (it: PartnerItemView): boolean => it.moneyStatus === 'SETTLED' || it.moneyStatus === 'TAKEN_OVER_SETTLED';

function Pill({ text, tone }: { text: string; tone: 'grey' | 'amber' | 'green' | 'red' }) {
  const c = { grey: ['#F2F4F6', GREY], amber: ['#FEF3C7', '#B45309'], green: ['#DCFCE7', GREEN], red: ['#FEE2E2', RED] }[tone];
  return <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 999, background: c[0], color: c[1], whiteSpace: 'nowrap' }}>{text}</span>;
}

function Row({ it, partnerId, onAction }: { it: PartnerItemView; partnerId: string; onAction: (a: PartnerItemAction) => void }) {
  const toSettle = it.sales.find((s) => s.settleable);
  let stage: [string, 'grey' | 'amber' | 'green' | 'red'];
  if (toSettle) stage = [toSettle.state === 'NEEDS_CORRECTION' ? 'Correction due' : 'Sold · to settle', 'amber'];
  else if (it.participating && it.ownership.qty > 0) stage = ['In stock', 'grey'];
  else if (it.open > 0) stage = ['Settled', 'green'];
  else if (it.open < 0) stage = ['Repayment due', 'red'];
  else stage = ['Running', 'grey'];
  const what = toSettle
    ? `profit ${fmt(toSettle.profit)} · partner ${fmt(toSettle.partnerShare)}`
    : it.moneyAction === 'PAYS_IN' ? 'partner owes cost share'
      : it.moneyAction === 'REPAYS' ? 'partner owes money back'
        : it.moneyAction === 'PAY_OUT' ? 'LATAIF owes partner' : 'nothing open';
  const act: [string, PartnerItemAction['kind']] | null = toSettle ? ['Settle', 'SETTLE']
    : it.moneyAction === 'PAYS_IN' ? ['Pays in', 'PAYS_IN']
      : it.moneyAction === 'REPAYS' ? ['Repays', 'REPAYS']
        : it.moneyAction === 'PAY_OUT' ? ['Pay out', 'PAY_OUT'] : null;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto auto', gap: 10, alignItems: 'center', padding: '8px 0', borderTop: '1px solid #F0F1F3' }}
      data-partner-card-item={it.purchaseLineId}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, color: '#0F0F10', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {it.productLabel} <span style={{ color: MUTED }}>· {it.purchaseNumber} · {it.sharePct} %</span>
        </div>
        <div className="flex items-center gap-2" style={{ marginTop: 3 }}>
          <Pill text={stage[0]} tone={stage[1]} />
          <span style={{ fontSize: 11, color: GREY }}>{what}</span>
        </div>
      </div>
      <div className="font-mono" style={{ fontSize: 12, textAlign: 'right', color: it.open < 0 ? RED : it.open > 0 ? GREEN : GREY }}
        data-partner-card-item-open={it.open.toFixed(3)}>
        {it.open > 0 ? '+' : ''}<Bhd v={it.open} />
      </div>
      <div style={{ minWidth: 70, textAlign: 'right' }}>
        {act && (
          <button type="button" className="cursor-pointer" data-partner-card-action={act[1]}
            onClick={() => onAction({ kind: act[1], partnerId, purchaseLineId: it.purchaseLineId, invoiceLineId: toSettle?.invoiceLineId })}
            style={{ fontSize: 11, padding: '4px 10px', borderRadius: 999, border: '1px solid #D5D9DE', background: '#FFFFFF', color: '#0F0F10' }}>
            {act[0]}
          </button>
        )}
      </div>
    </div>
  );
}

export function PartnerCardItems({ data, partnerName, onAction }: {
  data: PartnerItemsOfPartner; partnerName: string; onAction: (a: PartnerItemAction) => void;
}) {
  const [showDone, setShowDone] = useState(false);
  const running = data.items.filter((it) => !done(it));
  const finished = data.items.filter(done);
  const settled = finished.filter((it) => it.moneyStatus === 'SETTLED').length;
  const takenOver = finished.length - settled;
  const open = data.openTotal;
  const head = Math.abs(open) < 0.0005 ? { t: 'Settled — nothing open', c: GREEN }
    : open < 0 ? { t: `${partnerName} owes LATAIF ${fmt(-open)}`, c: RED } : { t: `LATAIF owes ${partnerName} ${fmt(open)}`, c: GREEN };

  const tile = (label: string, v: number, color = '#0F0F10', attr?: string) => (
    <div style={{ background: '#F7F8FA', borderRadius: 8, padding: '7px 9px' }}>
      <div style={{ fontSize: 10, color: GREY }}>{label}</div>
      <div className="font-mono" style={{ fontSize: 13, fontWeight: 500, color }} {...(attr ? { [attr]: v.toFixed(3) } : {})}><Bhd v={v} /></div>
    </div>
  );

  return (
    <div style={{ borderTop: '1px solid #E5E9EE', paddingTop: 12, marginBottom: 14 }} data-partner-card-items={data.partnerId}>
      <div className="flex items-center justify-between" style={{ gap: 8 }}>
        <span className="text-overline">JOINTLY BOUGHT ITEMS · {data.items.length}</span>
        <span style={{ fontSize: 12, color: head.c, textAlign: 'right' }} data-partner-card-status>{head.t}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 8, marginTop: 10 }}>
        {tile('Paid in', data.contributed, '#0F0F10', 'data-partner-card-paid-in')}
        {tile('Profit share', data.profitReleased, '#0F0F10', 'data-partner-card-profit')}
        {tile('Paid out', data.paidOut, '#0F0F10', 'data-partner-card-paid-out')}
        {tile('Open', open, open < 0 ? RED : open > 0 ? GREEN : '#0F0F10', 'data-partner-card-open')}
      </div>
      {data.owedToPartner > 0 && data.owedByPartner > 0 && (
        <div style={{ fontSize: 11, color: GREY, marginTop: 6 }}>
          LATAIF owes <Bhd v={data.owedToPartner} /> · {partnerName} owes <Bhd v={data.owedByPartner} />
        </div>
      )}

      {running.length > 0 && (
        <>
          <span className="text-overline" style={{ display: 'block', marginTop: 12, marginBottom: 2, fontSize: 10 }}>RUNNING · {running.length}</span>
          {running.map((it) => <Row key={it.purchaseLineId} it={it} partnerId={data.partnerId} onAction={onAction} />)}
        </>
      )}
      {finished.length > 0 && (
        <>
          <div className="flex items-center justify-between" style={{ borderTop: '1px solid #F0F1F3', paddingTop: 8, marginTop: running.length ? 0 : 10 }}>
            <span style={{ fontSize: 11, color: GREY }} data-partner-card-done>
              DONE · {settled} settled{takenOver ? ` · ${takenOver} taken over by LATAIF` : ''}
            </span>
            <button type="button" className="cursor-pointer" onClick={() => setShowDone(!showDone)} data-partner-card-done-toggle
              style={{ fontSize: 11, padding: '3px 10px', borderRadius: 999, border: '1px solid #D5D9DE', background: '#FFFFFF', color: GREY }}>
              {showDone ? 'Hide' : 'Show'}
            </button>
          </div>
          {showDone && finished.map((it) => (
            <div key={it.purchaseLineId} className="flex items-center justify-between" style={{ padding: '7px 0', borderTop: '1px solid #F0F1F3', gap: 8 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, color: '#0F0F10' }}>{it.productLabel} <span style={{ color: MUTED }}>· {it.purchaseNumber} · {it.sharePct} %</span></div>
                <div style={{ marginTop: 3 }}>
                  <Pill text={it.moneyStatus === 'TAKEN_OVER_SETTLED' ? 'Taken over by LATAIF — settled' : 'Settled — nothing open'} tone={it.moneyStatus === 'TAKEN_OVER_SETTLED' ? 'grey' : 'green'} />
                </div>
              </div>
              <span className="font-mono" style={{ fontSize: 12, color: GREY }}><Bhd v={0} /></span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
