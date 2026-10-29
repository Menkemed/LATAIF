// ════════════════════════════════════════════════════════════════════════════
// REPAIR-WORKFLOW — die Rückfrage zu einem Statusschritt, EIN Fenster für Liste, Quick Edit und Detailseite:
//   • „Picked Up": der TATSÄCHLICHE Abholtag (Standard heute; nicht künftig, nicht vor der Annahme) — optional
//     gleich die Rechnung, datiert auf diesen Tag;
//   • „Returned": ohne Reparatur zurück an den Kunden (später wieder aufnehmbar);
//   • „Reopen": eine zurückgegebene Reparatur auf eine zulässige Stufe zurück.
// Es entscheidet nichts selbst: die Schritte kommen aus `repairStatusTargets`, gebucht wird im Haus.
// ════════════════════════════════════════════════════════════════════════════
import { useEffect, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { latestBusinessDate, todayIso } from '@/core/utils/business-date';
import { canInvoiceRepair } from '@/core/repairs/repair-rules';
import { REPAIR_TAX_SCHEMES } from '@/core/models/types';
import type { Repair, RepairStatus, RepairTaxScheme } from '@/core/models/types';

export interface RepairStatusStep {
  status: RepairStatus;
  pickedUpDate?: string;
  /** Nur bei „Picked Up": gleich abrechnen, datiert auf den Abholtag. */
  invoice?: { taxScheme: RepairTaxScheme };
}

const name = (s: string): string => s.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

export function RepairStatusDialog({
  repair, target, reopenTargets = [], busy, error, note, onClose, onConfirm, allowInvoice = true,
}: {
  repair: Repair | null | undefined;
  /** Der gewählte Schritt; bei einer zurückgegebenen Reparatur die Vorauswahl (oder leer). */
  target: RepairStatus | null;
  reopenTargets?: readonly RepairStatus[];
  busy: boolean;
  error?: string;
  /** Ein neutraler Hinweis (z. B. „gilt für alle verknüpften Reparaturen"). */
  note?: string;
  onClose: () => void;
  onConfirm: (step: RepairStatusStep) => void;
  /** Die Rechnungsseite fragt die Abholung NACH der Rechnung — dort gibt es nichts mehr abzurechnen. */
  allowInvoice?: boolean;
}) {
  const reopen = repair?.status === 'returned';
  const [ziel, setZiel] = useState<RepairStatus | null>(target);
  const [datum, setDatum] = useState(todayIso());
  const [abrechnen, setAbrechnen] = useState(false);
  const [steuer, setSteuer] = useState<RepairTaxScheme>('VAT_10');
  useEffect(() => {
    setZiel(reopen && reopenTargets.length === 1 ? reopenTargets[0] : target);
    setDatum(todayIso());
    setSteuer(repair?.taxScheme === 'ZERO' ? 'ZERO' : 'VAT_10');
    // Abrechenbar „ready" → beim Abholen gleich abrechnen ist der übliche Weg; die Wahl bleibt beim Menschen.
    setAbrechnen(false);
  }, [repair?.id, target, reopen, reopenTargets.join(','), repair?.taxScheme]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!repair || (!target && !reopen)) return null;
  const abholung = !reopen && ziel === 'picked_up';
  const empfangen = repair.receivedAt ? repair.receivedAt.slice(0, 10) : '';
  // Abrechnen gleich mit der Abholung: dieselbe Regel wie der Knopf „Create Invoice" (nur dass die Reparatur dann
  // „picked_up" ist — das Haus nimmt beides an).
  const kannAbrechnen = allowInvoice && abholung
    && canInvoiceRepair({ ...repair, status: 'ready' }) && !repair.invoiceId;
  const datumFehler = abholung && (!datum ? 'Choose the pickup date.'
    : datum > latestBusinessDate() ? 'The pickup date cannot be in the future.'
      : empfangen && datum < empfangen ? `The pickup date is before the repair was received (${empfangen}).` : '');
  const titel = reopen ? 'Reopen Repair' : ziel === 'picked_up' ? 'Picked Up' : ziel === 'returned' ? 'Mark as Returned' : `Mark as ${name(String(ziel))}`;

  function bestaetigen() {
    if (!ziel || datumFehler) return;
    onConfirm({
      status: ziel,
      ...(abholung ? { pickedUpDate: datum } : {}),
      ...(abholung && kannAbrechnen && abrechnen ? { invoice: { taxScheme: steuer } } : {}),
    });
  }

  return (
    <Modal open onClose={onClose} title={titel} width={480}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }} data-repair-status-dialog={reopen ? 'reopen' : String(ziel)}>
        <p style={{ fontSize: 12, color: '#4B5563', lineHeight: 1.5 }}>
          <span className="font-mono">{repair.repairNumber}</span>
          {reopen
            ? ' — undo the return: the repair continues at the chosen step. Photos, costs, work and material lines, workshop and history stay. Invoices, payments and bookings are not changed.'
            : ziel === 'returned'
              ? ' — the item goes back to the client without repair. If this was a mistake, the repair can be reopened later.'
              : ziel === 'picked_up'
                ? ' — enter the day the client actually collected the item. The time you record it is kept separately.'
                : ` — move the repair to "${name(String(ziel))}".`}
        </p>

        {reopen && (
          <div>
            <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>REOPEN AS</span>
            {reopenTargets.length === 0 ? (
              <p style={{ fontSize: 12, color: '#B45309' }} data-reopen-none>
                This repair cannot be reopened automatically.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {reopenTargets.map((s) => (
                  <label key={s} data-reopen-target={s}
                    style={{ display: 'flex', gap: 10, padding: 9, borderRadius: 6, cursor: 'pointer',
                             border: `1px solid ${ziel === s ? '#0F0F10' : '#D5D9DE'}`,
                             background: ziel === s ? 'rgba(15,15,16,0.04)' : 'transparent' }}>
                    <input type="radio" name="repair-reopen-target" checked={ziel === s} onChange={() => setZiel(s)} />
                    <span style={{ fontSize: 13, color: '#0F0F10' }}>{name(s)}</span>
                  </label>
                ))}
                {reopenTargets.length > 1 && (
                  <p style={{ fontSize: 11, color: '#6B7280' }}>
                    The step before the return was not recorded (older return) — choose where the repair continues.
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {abholung && (
          <>
            <Input label="PICKUP DATE (DAY THE CLIENT COLLECTED)" type="date" value={datum}
              min={empfangen || undefined} max={latestBusinessDate()}
              onChange={(e) => setDatum(e.target.value)} data-pickup-date />
            {repair.invoiceId && (
              <p style={{ fontSize: 11, color: '#6B7280' }}>The existing invoice keeps its date and number — it is not changed by the pickup.</p>
            )}
            {kannAbrechnen && (
              <div style={{ padding: '10px 12px', border: '1px solid #E5E9EE', borderRadius: 6 }}>
                <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', fontSize: 13 }}>
                  <input type="checkbox" checked={abrechnen} onChange={(e) => setAbrechnen(e.target.checked)} data-pickup-invoice />
                  Create the invoice now, dated the pickup day
                </label>
                {abrechnen && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    {REPAIR_TAX_SCHEMES.map((s) => (
                      <label key={s} data-pickup-invoice-tax={s}
                        style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '6px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12,
                                 border: `1px solid ${steuer === s ? '#0F0F10' : '#D5D9DE'}` }}>
                        <input type="radio" name="pickup-invoice-tax" checked={steuer === s} onChange={() => setSteuer(s)} />
                        {s === 'ZERO' ? '0% (No VAT)' : 'VAT 10%'}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {note && <p style={{ fontSize: 11, color: '#6B7280' }} data-repair-status-note>{note}</p>}

        {(datumFehler || error) && (
          <div style={{ padding: '8px 12px', background: 'rgba(220,38,38,0.06)', border: '1px solid rgba(220,38,38,0.3)', borderRadius: 6, fontSize: 12, color: '#DC2626' }}>
            {datumFehler || error}
          </div>
        )}

        <div className="flex justify-end gap-3" style={{ paddingTop: 10, borderTop: '1px solid #E5E9EE' }}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={bestaetigen} disabled={busy || !ziel || !!datumFehler} data-status-confirm>
            {reopen ? 'Reopen' : 'Confirm'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
