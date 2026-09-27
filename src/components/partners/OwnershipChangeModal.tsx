// PARTNER-ITEMS — „Take over (LATAIF alone)" und „Change partners" für die unverkauften Stücke einer
// Einkaufszeile. Beides nur zum aktuellen Lager-Einstand (angezeigt, vom Haus geprüft), ohne
// Geldbewegung: Ansprüche und Verpflichtungen stehen danach auf dem Ausgleichskonto, gezahlt wird
// über „Record contribution" / „Pay out". Am Hauptrechner direkt, auf PC2 als geprüfter Befehl.
import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Bhd } from '@/components/ui/Bhd';
import { WriteError } from '@/components/shared/WriteError';
import { useSharedWrites, fehlertext } from '@/core/data/shared-write';
import type { Partner } from '@/core/models/types';
import { saveChangePartners, saveTakeOver } from '@/core/partners/item-participation-save';
import { PartnerItemRejected, planLineParticipation } from '@/core/partners/item-participation';

export interface OwnershipTarget {
  purchaseLineId: string;
  label: string;
  qty: number;
  value: number;
  /** Die heutigen Partner und Anteile (leer = LATAIF allein). */
  current: Array<{ partnerId: string; sharePct: number }>;
}

interface Props {
  mode: 'TAKEOVER' | 'CHANGE' | null;
  target: OwnershipTarget | null;
  partners: Partner[];
  onClose: () => void;
}

export function OwnershipChangeModal({ mode, target, partners, onClose }: Props) {
  const w = useSharedWrites();
  const [rows, setRows] = useState<Array<{ partnerId: string; sharePct: string }> | null>(null);
  const [fehler, setFehler] = useState('');
  const [busy, setBusy] = useState(false);
  const active = useMemo(() => partners.filter((p) => p.active), [partners]);
  const open = !!mode && !!target;
  const shown = rows ?? (target?.current.length ? target.current.map((c) => ({ partnerId: c.partnerId, sharePct: String(c.sharePct) })) : [{ partnerId: '', sharePct: '50' }]);
  const nameOf = (id: string) => partners.find((p) => p.id === id)?.name ?? id;

  let preview: string | null = null;
  if (mode === 'CHANGE' && target) {
    try {
      const plan = planLineParticipation(shown.map((r) => ({ partnerId: r.partnerId, sharePct: parseFloat(r.sharePct) })), Math.round(target.value * 1000));
      preview = plan.map((p) => `${p.partnerId ? nameOf(p.partnerId) : 'LATAIF'} ${p.shareBp / 100} % = ${(p.costShareF / 1000).toFixed(3)} BHD`).join(' · ');
    } catch (e) { preview = e instanceof PartnerItemRejected ? e.message : String(e); }
  }

  function close() { setRows(null); setFehler(''); onClose(); }

  async function confirm() {
    if (!target || !mode) return;
    setBusy(true); setFehler('');
    const r = mode === 'TAKEOVER'
      ? await saveTakeOver(w, { purchaseLineId: target.purchaseLineId, expectedValue: target.value })
      : await saveChangePartners(w, {
        purchaseLineId: target.purchaseLineId, expectedValue: target.value,
        partnerShares: shown.map((r) => ({ partnerId: r.partnerId, sharePct: parseFloat(r.sharePct) })),
      });
    setBusy(false);
    if (r.kind !== 'ok') { setFehler(fehlertext(r)); return; }
    close();
  }

  return (
    <Modal open={open} onClose={close} width={520}
      title={mode === 'TAKEOVER' ? `Take over by LATAIF — ${target?.label ?? ''}` : `Change partners — ${target?.label ?? ''}`}>
      {target && mode && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-ownership-modal={mode}>
          <WriteError text={fehler} />
          <div style={{ fontSize: 13 }}>
            {target.qty} unsold piece{target.qty === 1 ? '' : 's'} · current stock cost{' '}
            <strong data-ownership-value={target.value.toFixed(3)}><Bhd v={target.value} /> BHD</strong>
          </div>
          <p style={{ fontSize: 12, color: '#6B7280' }}>
            {mode === 'TAKEOVER'
              ? 'LATAIF holds these pieces alone from now on, at their current stock cost (no other value). Each partner keeps what they paid in, less payouts, plus settled profit, on their item balance — pay it out with "Pay out". No stock entry, no purchase, no revaluation.'
              : 'New shares for these pieces at their current stock cost. Leaving partners keep their claim on their item balance; new partners owe their cost share — money moves only with "Record contribution" / "Pay out". Settled sales stay as they are.'}
          </p>
          {mode === 'CHANGE' && (
            <div>
              {shown.map((r, i) => (
                <div key={i} className="flex items-center gap-2" style={{ marginBottom: 6 }}>
                  <select value={r.partnerId} data-ownership-partner={i}
                    onChange={(e) => setRows(shown.map((x, k) => (k === i ? { ...x, partnerId: e.target.value } : x)))}
                    style={{ flex: 2, padding: '7px 6px', fontSize: 13, border: '1px solid #D5D9DE', borderRadius: 6 }}>
                    <option value="">Select partner…</option>
                    {active.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  <input type="number" step="0.01" value={r.sharePct} data-ownership-share={i}
                    onChange={(e) => setRows(shown.map((x, k) => (k === i ? { ...x, sharePct: e.target.value } : x)))}
                    style={{ width: 80, padding: '7px 6px', fontSize: 13, border: '1px solid #D5D9DE', borderRadius: 6 }} />
                  <span style={{ fontSize: 12, color: '#6B7280' }}>%</span>
                  <button type="button" onClick={() => setRows(shown.filter((_, k) => k !== i))} disabled={shown.length === 1}
                    className="cursor-pointer" style={{ background: 'none', border: 'none', color: '#9CA3AF' }}><Trash2 size={13} /></button>
                </div>
              ))}
              <button type="button" onClick={() => setRows([...shown, { partnerId: '', sharePct: '0' }])} className="cursor-pointer flex items-center gap-1"
                style={{ background: 'none', border: 'none', color: '#6B7280', fontSize: 12 }}><Plus size={12} /> Another partner</button>
              {preview && <div style={{ fontSize: 12, marginTop: 8 }} data-ownership-preview>{preview}</div>}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={close}>Cancel</Button>
            <Button variant="primary" disabled={busy} onClick={() => void confirm()} data-ownership-confirm>Confirm</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
