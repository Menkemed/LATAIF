// ════════════════════════════════════════════════════════════════════════════
// Owner 14.11.2026 — „Edit Transfer" und „Remove" eines Approval-Transfers: EIN Fenster für die Liste und die Detailseite.
//
//   • Bearbeiten (Primary und PC2, `transfers.update` → `editTransferInHouse`): Our Price, Full/Split, Anteil, Kunde (nur solange
//     das Stück draußen ist), Übergabe- und Rückgabedatum, Mitarbeiter, Notiz. Nach dem Verkauf rechnet das Haus den
//     Abrechnungsbetrag mit derselben Formel neu und bucht die Forderung an ihrem Tag um; mit Rechnung oder Zahlung gesperrt.
//   • Entfernen (Primary und PC2, `transfers.remove` → `removeTransferInHouse`): ohne Buchung gelöscht, nach dem Verkauf
//     storniert (Transfer bleibt „cancelled"), mit Rechnung/Zahlung ein Nein mit dem Korrekturweg — `transferRemovePlan`.
// ════════════════════════════════════════════════════════════════════════════
import { useMemo, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { StaffSelect } from '@/components/employees/StaffSelect';
import { WriteError } from '@/components/shared/WriteError';
import { useAgentStore } from '@/stores/agentStore';
import { useCustomerStore } from '@/stores/customerStore';
import { useSharedWrites, nichtAmClient, fehlertext } from '@/core/data/shared-write';
import { latestBusinessDate } from '@/core/utils/business-date';
import { computeAgentTransferSale } from '@/core/agent/economics';
import {
  TransferActionRejected, clampTransferSplitPct, transferEditBlocker, transferEditPatch, transferRemovePlan,
  type TransferEditForm, type TransferEditPatch,
} from '@/core/agents/transfer-rules';
import { editTransferOnPrimary, removeTransferOnPrimary, type TransferRemoved } from '@/core/agents/transfer-house';
import type { AgentTransfer } from '@/core/models/types';

interface Props {
  transfer: AgentTransfer;
  onClose: () => void;
  /** Nach dem Speichern oder Entfernen (`kind`), damit der Aufrufer neu lädt bzw. zurückgeht. */
  onDone: (kind: 'saved' | 'deleted' | 'cancelled') => void;
  /** Gleich im Bereich „Remove" öffnen (Knopf „Remove" der Detailseite). */
  startWithRemove?: boolean;
}

const tagVon = (v?: string | null): string => (v ? String(v).slice(0, 10) : '');

export function TransferEditModal({ transfer: t, onClose, onDone, startWithRemove }: Props) {
  const w = useSharedWrites();
  const { agents } = useAgentStore();
  const { customers } = useCustomerStore();
  const kundeAlt = agents.find((a) => a.id === t.agentId)?.customerId || '';
  const modellAlt: 'full' | 'split' = t.settlementModel === 'split' ? 'split' : 'full';
  const [preis, setPreis] = useState(String(t.agentPrice ?? ''));
  const [modell, setModell] = useState<'full' | 'split'>(modellAlt);
  const [anteil, setAnteil] = useState<string>(t.excessSplitPct === undefined || t.excessSplitPct === null ? '' : String(t.excessSplitPct));
  const [kunde, setKunde] = useState(kundeAlt);
  const [datum, setDatum] = useState(tagVon(t.transferredAt || t.createdAt));
  const [rueckgabe, setRueckgabe] = useState(tagVon(t.returnBy));
  const [mitarbeiter, setMitarbeiter] = useState(t.staffId || '');
  const [notiz, setNotiz] = useState(t.notes || '');
  const [ack, setAck] = useState(false);
  const [entfernen, setEntfernen] = useState(!!startWithRemove);
  const [grund, setGrund] = useState('');
  const [hinweis, setHinweis] = useState('');

  const hatZahlungen = (t.settlementPaidAmount || 0) > 0.0005;
  const zustand = { status: t.status, invoiceId: t.invoiceId || null, hasPayments: hatZahlungen, hasSalePosting: t.status === 'sold' || t.status === 'settled' };
  // Was die Maske ändern darf — dieselbe Regel wie das Haus (ein Probe-Patch je Feldgruppe).
  const geldGesperrt = transferEditBlocker(zustand, { agentPrice: 1 });
  const kundeGesperrt = transferEditBlocker(zustand, { customerId: 'x' });
  const datumGesperrt = transferEditBlocker(zustand, { transferredAt: '2000-01-01' });

  const kundenOptionen = useMemo(() => customers.map((c) => ({
    id: c.id, label: `${c.firstName} ${c.lastName}${c.company ? ` — ${c.company}` : ''}`.trim(), subtitle: c.phone || c.email || undefined,
  })), [customers]);

  // Nur, was sich geändert hat — sonst wäre ein unverändertes Feld eine Änderung (und eine Sperre).
  const aenderung = ((): { patch?: TransferEditPatch; fehler?: string } => {
    const f: TransferEditForm = {};
    const p = Number(preis);
    if (preis.trim() === '' || !(p > 0)) return { fehler: 'Our Price must be above 0' };
    if (Math.abs(p - (t.agentPrice || 0)) > 0.0005) f.agentPrice = p;
    const pct = anteil.trim() === '' ? undefined : Number(anteil);
    if (modell !== modellAlt) { f.settlementModel = modell; if (modell === 'split') f.excessSplitPct = pct ?? 50; }
    else if (modell === 'split' && pct !== undefined && pct !== (t.excessSplitPct ?? null)) f.excessSplitPct = pct;
    if (kunde && kunde !== kundeAlt) f.customerId = kunde;
    if (datum && datum !== tagVon(t.transferredAt || t.createdAt)) f.transferredAt = datum;
    if (rueckgabe !== tagVon(t.returnBy)) f.returnBy = rueckgabe || null;
    if ((mitarbeiter || '') !== (t.staffId || '')) f.staffId = mitarbeiter || null;
    if (notiz !== (t.notes || '')) f.notes = notiz;
    if (ack) f.acknowledgeBelowPrice = true;
    try {
      const patch = transferEditPatch(f);
      const sperre = transferEditBlocker(zustand, patch);
      return sperre ? { patch, fehler: sperre.message } : { patch };
    } catch (e) { return { fehler: e instanceof TransferActionRejected ? e.message : String(e) }; }
  })();
  const geaendert = !!aenderung.patch && Object.keys(aenderung.patch).some((k) => k !== 'acknowledgeBelowPrice');

  // Nach dem Verkauf: was die Änderung am Abrechnungsbetrag bewirkt (dieselbe Formel wie das Haus).
  const vorschau = t.status === 'sold' && !geldGesperrt && Number(preis) > 0
    ? computeAgentTransferSale({ agentPrice: Number(preis), settlementModel: modell, excessSplitPct: anteil.trim() === '' ? undefined : Number(anteil) }, t.actualSalePrice || 0)
    : null;
  const brauchtAck = !!vorschau?.belowPrice && (Number(preis) !== t.agentPrice || modell !== modellAlt);

  const plan = transferRemovePlan(zustand);

  async function speichern() {
    if (!aenderung.patch || aenderung.fehler || !geaendert) return;
    if (brauchtAck && !ack) { setHinweis('Confirm that the sale is below the new Our Price.'); return; }
    const fassung = t.revision;
    // Am zweiten Rechner nie ohne gesehene Fassung schicken (wie jede fassungsbasierte Maske).
    if (w.remote && !fassung) { setHinweis(fehlertext(nichtAmClient('editing this transfer (no revision loaded)'))); return; }
    const patch = aenderung.patch;
    if (!await w.ok('transfers.update', {
      local: () => editTransferOnPrimary(t.id, patch, fassung || undefined),
      remote: () => ({ id: t.id, expectedRevision: fassung, ...patch }),
    })) return;
    // Frisch lesen — die nächste Handlung braucht die NEUE Fassung.
    void useAgentStore.getState().loadTransfers();
    onDone('saved');
  }

  // Primary == PC2 (Owner 14.11.2026): DIESELBE Hausfolge über die gemeinsame Weiche (`transfers.remove`) — das Haus
  // entscheidet löschen oder stornieren, prüft Grund, Fassung und Periode; eine Wiederholung wirkt einmal.
  async function entfernenAusfuehren() {
    if ('code' in plan) return;
    setHinweis('');
    const fassung = t.revision;
    if (w.remote && !fassung) { setHinweis(fehlertext(nichtAmClient('removing this transfer (no revision loaded)'))); return; }
    const r = await w.save<TransferRemoved>('transfers.remove', {
      local: () => removeTransferOnPrimary(t.id, grund, fassung || undefined),
      remote: () => ({ transferId: t.id, expectedRevision: fassung, reason: grund }),
    });
    if (r.kind !== 'ok') return;
    void useAgentStore.getState().loadTransfers();
    onDone(r.value.kind === 'cancelled' ? 'cancelled' : 'deleted');
  }

  const sperrHinweis = (s: { message: string } | null) => s
    ? <p style={{ fontSize: 11, color: '#B45309', margin: '4px 0 0', lineHeight: 1.4 }}>{s.message}</p> : null;

  return (
    <Modal open onClose={onClose} title={`Edit Transfer — ${t.transferNumber}`} width={520}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }} data-transfer-edit-modal>
        <WriteError text={w.fehler} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Input required label="OUR PRICE (BHD)" type="number" value={preis} disabled={!!geldGesperrt}
            onChange={(e) => { setPreis(e.target.value); setAck(false); }} data-transfer-edit-price />
          <div>
            <span className="text-overline" style={{ display: 'block', marginBottom: 6 }}>SETTLEMENT MODEL</span>
            <select value={modell} disabled={!!geldGesperrt} data-transfer-edit-model
              onChange={(e) => { setModell(e.target.value === 'split' ? 'split' : 'full'); setAck(false); }}
              style={{ width: '100%', padding: '9px 8px', fontSize: 13, border: '1px solid #D5D9DE', borderRadius: 6, background: '#FFFFFF' }}>
              <option value="full">Full amount to us</option>
              <option value="split">Our Price + Split</option>
            </select>
          </div>
        </div>
        {modell === 'split' && (
          <Input label="SHOP'S SHARE OF EXCESS (%)" type="number" placeholder="50" value={anteil} disabled={!!geldGesperrt}
            onChange={(e) => { setAnteil(e.target.value === '' ? '' : String(clampTransferSplitPct(e.target.value))); setAck(false); }}
            data-transfer-edit-pct />
        )}
        {sperrHinweis(geldGesperrt)}
        {vorschau && (
          <div style={{ fontSize: 12, color: '#4B5563', background: '#F7F8FA', borderRadius: 6, padding: '8px 10px' }} data-transfer-edit-preview>
            Sold for <strong>{t.actualSalePrice}</strong> BHD — settlement to us: <strong>{vorschau.ourSettlement}</strong> BHD
            {Math.abs(vorschau.ourSettlement - (t.settlementAmount || 0)) > 0.0005
              ? ` (now ${t.settlementAmount ?? 0}; the booked receivable is corrected on the sale date)` : ' (unchanged)'}
            {brauchtAck && (
              <label className="flex items-center gap-2" style={{ marginTop: 6, color: '#B45309' }}>
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} data-transfer-edit-ack />
                The sale is below the new Our Price — we receive only the sale amount, no split.
              </label>
            )}
          </div>
        )}
        <div>
          <SearchSelect label="CLIENT" placeholder="Search clients..." options={kundenOptionen} value={kunde}
            disabled={!!kundeGesperrt} onChange={(cid) => setKunde(cid || kundeAlt)} />
          {sperrHinweis(kundeGesperrt)}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Input label="TRANSFER DATE" type="date" value={datum} max={latestBusinessDate()} disabled={!!datumGesperrt}
            onChange={(e) => setDatum(e.target.value)} data-transfer-edit-date />
          <Input label="RETURN BY (DATE)" type="date" value={rueckgabe} onChange={(e) => setRueckgabe(e.target.value)} />
        </div>
        <StaffSelect value={mitarbeiter} onChange={(id) => setMitarbeiter(id || '')} helper="Who handed over this item (optional)." />
        <div>
          <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>NOTES</span>
          <textarea value={notiz} onChange={(e) => setNotiz(e.target.value)} rows={2} data-transfer-edit-notes
            style={{ width: '100%', background: 'transparent', border: '1px solid #D5D9DE', borderRadius: 6, padding: '8px 10px', fontSize: 13, color: '#0F0F10' }} />
        </div>
        {aenderung.fehler && geaendert && <p style={{ fontSize: 12, color: '#B45309', margin: 0 }} data-transfer-edit-problem>{aenderung.fehler}</p>}
        {hinweis && <p style={{ fontSize: 12, color: '#B45309', margin: 0 }} data-transfer-edit-hint>{hinweis}</p>}

        {/* Remove — am Primary, wie jedes Löschen; was geschieht, sagt die Regel VOR dem Klick. */}
        <div style={{ borderTop: '1px solid #E5E9EE', paddingTop: 12 }} data-transfer-remove>
          {!entfernen ? (
            <Button variant="ghost" onClick={() => setEntfernen(true)} data-transfer-remove-open>
              <span style={{ color: '#DC2626' }}>Remove this transfer…</span>
            </Button>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <p style={{ fontSize: 12, color: '#4B5563', margin: 0, lineHeight: 1.5 }} data-transfer-remove-plan>
                {'code' in plan ? <span style={{ color: '#B45309' }}>{plan.message}</span>
                  : plan.kind === 'delete'
                    ? 'Nothing is booked yet: the transfer is deleted and the item goes back to stock. Its number is not used again; the history keeps the reason.'
                    : 'The sale is booked: it is cancelled with reversing entries on its sale date, the item goes back to stock, and the transfer stays as "Cancelled". Other transfers of the same hand-over are not touched.'}
              </p>
              <p style={{ fontSize: 11, color: '#6B7280', margin: 0 }}>
                If the item really came back from the client, use “Returned” instead. For a replacement item, create a new transfer.
              </p>
              {!('code' in plan) && (
                <>
                  <Input label="REASON *" value={grund} onChange={(e) => setGrund(e.target.value)} placeholder="e.g. wrong item selected" data-transfer-remove-reason />
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" onClick={() => setEntfernen(false)}>Back</Button>
                    <Button variant="danger" disabled={grund.trim().length < 3 || w.busy} onClick={() => void entfernenAusfuehren()} data-transfer-remove-confirm>
                      {plan.kind === 'delete' ? 'Delete transfer' : 'Cancel sale and transfer'}
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button variant="primary" onClick={() => void speichern()} disabled={w.busy || !geaendert || !!aenderung.fehler || (brauchtAck && !ack)} data-transfer-save>
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}
