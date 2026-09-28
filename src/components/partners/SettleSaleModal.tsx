// PARTNER-ITEMS — „Settle sale" / „Correct settlement": die Aufstellung des Verkaufs im Dialog der App
// (netto − Einstand − Kartengebühr = Gewinn, Anteile), gebucht erst mit „Settle". Cancel bucht nichts.
import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Bhd } from '@/components/ui/Bhd';
import { WriteError } from '@/components/shared/WriteError';
import { useSharedWrites, fehlertext } from '@/core/data/shared-write';
import type { PartnerItemSale } from '@/core/partners/item-participation-house';
import { saveSettleSale } from '@/core/partners/item-participation-save';

export interface SettleTarget {
  sale: PartnerItemSale;
  itemLabel: string;
  partnerName: string;
  sharePct: number;
}

function Zeile({ label, v, minus, strong, attr }: { label: string; v: number; minus?: boolean; strong?: boolean; attr?: string }) {
  return (
    <div className="flex justify-between" style={{ padding: '6px 0', fontSize: 13, borderTop: strong ? '1px solid #E5E9EE' : undefined, fontWeight: strong ? 600 : 400 }}>
      <span style={{ color: strong ? '#0F0F10' : '#6B7280' }}>{label}</span>
      <span className="font-mono" {...(attr ? { [attr]: v.toFixed(3) } : {})}>{minus ? '− ' : ''}<Bhd v={v} /> BHD</span>
    </div>
  );
}

export function SettleSaleModal({ target, onClose }: { target: SettleTarget | null; onClose: () => void }) {
  const w = useSharedWrites();
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState('');
  const s = target?.sale;
  const correction = s?.state === 'NEEDS_CORRECTION';

  function close() { setFehler(''); onClose(); }
  async function settle() {
    if (!s) return;
    setBusy(true); setFehler('');
    const r = await saveSettleSale(w, s.invoiceLineId);
    setBusy(false);
    if (r.kind !== 'ok') { setFehler(fehlertext(r)); return; }
    close();
  }

  return (
    <Modal open={!!target} onClose={close} width={460}
      title={correction ? `Correct settlement — ${s?.invoiceNumber || 'sale'}` : `Settle sale — ${s?.invoiceNumber ?? ''}`}>
      {target && s && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }} data-settle-modal={correction ? 'CORRECTION' : 'SETTLEMENT'}>
          <WriteError text={fehler} />
          <div style={{ fontSize: 12, color: '#6B7280' }}>{target.itemLabel} · qty {s.quantity}</div>
          <div>
            <Zeile label="Net sale" v={s.net} />
            <Zeile label="Cost" v={s.cost} minus />
            {s.cardFee !== 0 && <Zeile label="Card fee" v={s.cardFee} minus attr="data-settle-fee" />}
            <Zeile label="Profit" v={s.profit} strong attr="data-settle-profit" />
          </div>
          <div style={{ background: '#F7F8FA', borderRadius: 8, padding: '6px 12px' }}>
            <Zeile label={`${target.partnerName} (${target.sharePct} %)`} v={s.partnerShare} attr="data-settle-partner-share" />
            <Zeile label="LATAIF" v={s.lataifShare} attr="data-settle-lataif-share" />
            {correction && (
              <>
                <Zeile label="Settled so far" v={s.released} />
                <Zeile label="Booked now (difference)" v={s.partnerShare - s.released} strong />
              </>
            )}
          </div>
          <p style={{ fontSize: 12, color: '#6B7280', lineHeight: 1.5 }}>
            {correction
              ? 'The sale changed after it was settled. Only the difference is booked; earlier settlements and payouts stay. If the partner received too much, the item shows what they owe back.'
              : `${target.partnerName}'s share goes on their item balance. No money moves yet — pay out afterwards with "Pay out".`}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={close} data-settle-cancel>Cancel</Button>
            <Button variant="primary" disabled={busy} onClick={() => void settle()} data-settle-confirm>
              {correction ? 'Correct settlement' : 'Settle'}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
