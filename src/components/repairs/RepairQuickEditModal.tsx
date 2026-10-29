// ════════════════════════════════════════════════════════════════════════════
// REPAIR-QUICK-EDIT — eine Reparatur direkt aus der Liste bearbeiten: Status, Kosten und Preis, Arbeits- und
// Materialzeilen (hinzufügen, ändern, stornieren), mit den Summen. Jede Handlung ist DIESELBE wie an der
// Detailseite — dieselbe Hausfunktion am Primary (eine Klammer, gesehene Fassung), derselbe geprüfte Fernbefehl
// an PC2. Hier steht keine eigene Geschäftsregel: Sperren (abgerechnet, bezahlt, gebuchte Quelle) prüft das Haus.
// Die Detailseite bleibt vollständig verfügbar („Open details").
//
// REPAIR-REDESIGN — Arbeit (eigene Arbeit und Werkstätten, getrennt mit Zwischensummen) und Material stehen in
// zwei Bereichen; „Actual Cost" ist bei vorhandenen Zeilen die Summe der Zeilen (das schreibt das Haus ohnehin bei
// jeder Zeile) und wird hier nur angezeigt. Die Kostensumme ist unverändert `computeRepairTotalCost`.
// ════════════════════════════════════════════════════════════════════════════
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { WriteError } from '@/components/shared/WriteError';
import { AddMaterialModal, type MaterialLineInput } from '@/components/work-orders/AddMaterialModal';
import { RepairStatusDialog, type RepairStatusStep } from '@/components/repairs/RepairStatusDialog';
import { pickupKeptInvoiceRefused, saveRepairInvoice, saveRepairStatus } from '@/components/repairs/repair-status-save';
import {
  EMPTY_WORK_LINE, RepairWorkLineForm, RepairWorkSourceBadge, repairWorkSourceText, type WorkLineDraft, type WorkLineValues,
} from '@/components/repairs/RepairWorkParts';
import { useRepairStore } from '@/stores/repairStore';
import { useSupplierStore } from '@/stores/supplierStore';
import { useCustomerStore } from '@/stores/customerStore';
import { usePermission } from '@/hooks/usePermission';
import { useSharedWrites, fehlertext, nichtAmClient } from '@/core/data/shared-write';
import {
  addRepairLineOnPrimary, cancelRepairLineOnPrimary, updateRepairLineOnPrimary, updateRepairOnPrimary,
} from '@/core/repairs/repair-house';
import { repairEditBody } from '@/core/repairs/repair-rules';
import {
  repairStatusActionLabel, repairStatusTargets, repairTransitionFacts,
} from '@/core/repairs/repair-status-flow';
import { IN_HOUSE_LINE_NOTE, repairCostLabels } from '@/core/repairs/repair-line-view';
import {
  repairCostView, repairEstimateRole, repairLineCostIssue, repairWorkSource, repairWorkTypeLabel,
} from '@/core/repairs/repair-work-source';
import { addRepairMaterialOnPrimary, materialRowsFromModal, repairMaterialBody, type RepairMaterialRequest } from '@/core/gold/gold-house';
import { repairItemDisplayName } from '@/core/products/display-name';
import { REPAIR_WORK_TYPES } from '@/core/models/types';
import type { Repair, RepairLine, RepairStatus, RepairWorkType } from '@/core/models/types';

const fmt = (v: number | null | undefined): string => (Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
const wort = (t: string): string => t.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
const geld = (s: string): number | null => (s.trim() === '' ? null : Number(s));
const feld = (v: number | null | undefined): string => (v === null || v === undefined ? '' : String(v));

type LineEdit = { lineId: string; description: string; cost: string; workType: RepairWorkType; notes: string };

export function RepairQuickEditModal({ repairId, onClose }: { repairId: string | null; onClose: () => void }) {
  const navigate = useNavigate();
  const perm = usePermission();
  const w = useSharedWrites();
  const { repairs, repairLines, loadRepairs, loadRepairLines, getRepairLines } = useRepairStore();
  const { suppliers } = useSupplierStore();
  const { customers } = useCustomerStore();
  const repair = repairId ? repairs.find((r) => r.id === repairId) : undefined;
  const lines = useMemo(
    () => (repairId ? getRepairLines(repairId) : []),
    [repairId, repairLines, getRepairLines], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const offen = lines.filter((l) => l.status === 'OPEN');

  // Beträge: ein Entwurf, der nur durch „Save amounts" (geglückt) oder einen Wechsel der Reparatur ersetzt wird —
  // ein Hintergrund-Neuladen überschreibt keine Eingabe.
  const [betrag, setBetrag] = useState({ estimated: '', actual: '', charge: '' });
  const [betragGeaendert, setBetragGeaendert] = useState(false);
  const [zeileEdit, setZeileEdit] = useState<LineEdit | null>(null);
  const [arbeit, setArbeit] = useState<WorkLineDraft | null>(null);
  const [material, setMaterial] = useState(false);
  const [schritt, setSchritt] = useState<RepairStatus | 'REOPEN' | null>(null);
  const [hinweis, setHinweis] = useState('');
  const [erweitert, setErweitert] = useState(false);

  useEffect(() => {
    if (!repair) return;
    if (!betragGeaendert) {
      setBetrag({ estimated: feld(repair.estimatedCost), actual: feld(repair.actualCost), charge: feld(repair.chargeToCustomer) });
    }
  }, [repair?.id, repair?.revision]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setBetragGeaendert(false); setZeileEdit(null); setArbeit(null); setSchritt(null); setHinweis(''); setErweitert(false); w.clear();
  }, [repairId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!repairId) return null;
  if (!repair) {
    return (
      <Modal open onClose={onClose} title="Quick Edit Repair" width={560}>
        <p style={{ fontSize: 13, color: '#6B7280' }}>This repair is no longer in the list.</p>
      </Modal>
    );
  }
  const rep: Repair = repair;
  const customer = customers.find((c) => c.id === rep.customerId);
  const ziele = repairStatusTargets(repairTransitionFacts(rep, lines));
  const abgerechnet = !!rep.invoiceId;
  const kosten = repairCostView(rep, offen);
  const quelle = repairWorkSource(rep, offen);
  const total = kosten.total;
  const charge = rep.chargeToCustomer ?? 0;
  const labels = repairCostLabels(rep.repairType);
  const darf = perm.canManageRepairs;
  const nameOf = (id: string): string => suppliers.find((s) => s.id === id)?.name || 'Supplier';
  const arbeitsZeilen = offen.filter((l) => !l.materialKind);
  const materialZeilen = offen.filter((l) => !!l.materialKind);
  const eigene = arbeitsZeilen.filter((l) => !l.supplierId);
  const werkstaetten = arbeitsZeilen.map((l) => l.supplierId).filter((x, i, a): x is string => !!x && a.indexOf(x) === i);
  const schaetzung = repairEstimateRole(rep, kosten.hasLines);

  /** Die gesehene Fassung — ohne sie schickt PC2 gar nicht erst (wie an der Detailseite). */
  function fassung(was: string): number | null {
    const rev = rep.revision;
    if (w.remote && !rev) { alert(fehlertext(nichtAmClient(`${was} (no revision loaded)`))); return null; }
    return rev || 0;
  }
  function neuLaden(): void { loadRepairs(); loadRepairLines(); }

  async function betraegeSpeichern() {
    const f = fassung('saving the repair amounts');
    if (f === null) return;
    const { images: _fotos, ...ohneFotos } = rep;   // die Galerie bleibt, wie sie ist
    const form: Partial<Repair> = {
      ...ohneFotos,
      estimatedCost: geld(betrag.estimated) as number | undefined,
      // Mit Kostenzeilen ist Actual Cost deren Summe (das Haus schreibt sie bei jeder Zeile) — hier nicht überschreibbar.
      actualCost: kosten.hasLines ? rep.actualCost : geld(betrag.actual) as number | undefined,
      chargeToCustomer: geld(betrag.charge) as number | undefined,
    };
    if (!await w.ok('repairs.update', {
      local: () => updateRepairOnPrimary(rep.id, form, f),
      remote: () => repairEditBody(rep.id, f, rep, form),
    })) return;
    setBetragGeaendert(false);
    setHinweis('Amounts saved.');
    neuLaden();
  }

  async function zeileSpeichern(line: RepairLine) {
    if (!zeileEdit) return;
    const f = fassung('changing a cost line');
    if (f === null) return;
    const patch: Record<string, unknown> = {};
    const neu = zeileEdit.cost.trim() === '' && !line.supplierId ? 0 : Number(zeileEdit.cost);
    if (zeileEdit.description !== (line.description || '')) patch.description = zeileEdit.description;
    if (zeileEdit.notes !== (line.notes || '')) patch.notes = zeileEdit.notes;
    if (Number.isFinite(neu) && Math.abs(neu - (line.costAmount || 0)) > 0.0005) patch.costAmount = neu;
    if (!line.materialKind && zeileEdit.workType !== line.workType) patch.workType = zeileEdit.workType;
    if (Object.keys(patch).length === 0) { setZeileEdit(null); return; }
    if (!await w.ok('repairs.update_line', {
      local: async () => { await updateRepairLineOnPrimary(rep.id, line.id, patch as never, f); return {}; },
      remote: () => ({ repairId: rep.id, lineId: line.id, expectedRevision: f, ...patch }),
    })) return;
    setZeileEdit(null);
    setHinweis('Line saved.');
    neuLaden();
  }

  async function zeileStornieren(line: RepairLine) {
    if (!(await window.confirm(`Cancel this line (${line.description || wort(line.workType || 'service')})? Its booking is taken back.`))) return;
    const f = fassung('cancelling a repair line');
    if (f === null) return;
    if (!await w.ok('repairs.cancel_line', {
      local: async () => { await cancelRepairLineOnPrimary(line.id); return {}; },
      remote: () => ({ repairId: rep.id, lineId: line.id, expectedRevision: f }),
    })) return;
    setHinweis('Line cancelled.');
    neuLaden();
  }

  async function arbeitHinzufuegen(v: WorkLineValues) {
    const f = fassung('adding a repair line');
    if (f === null) return;
    if (!await w.ok('repairs.add_line', {
      local: async () => { await addRepairLineOnPrimary(rep.id, v); return {}; },
      remote: () => ({ repairId: rep.id, expectedRevision: f, ...v }),
    })) return;
    setArbeit(null);
    setHinweis('Work line added.');
    neuLaden();
  }

  async function materialHinzufuegen(rows: MaterialLineInput[]): Promise<boolean> {
    const f = fassung('adding repair material');
    if (f === null) return false;
    const req: RepairMaterialRequest = { repairId: rep.id, expectedRevision: f || undefined, rows: materialRowsFromModal(rows) };
    if (!await w.ok('repairs.add_material', {
      local: () => addRepairMaterialOnPrimary(req),
      remote: () => repairMaterialBody(req),
    })) return false;
    setHinweis('Material added.');
    neuLaden();
    return true;
  }

  async function schrittAusfuehren(step: RepairStatusStep) {
    const neu = await saveRepairStatus(w, rep, step.status, step.pickedUpDate);
    if (neu === null) return;
    neuLaden();
    if (step.invoice) {
      // Gleich abrechnen — datiert auf den Abholtag (die VAT-Periodensperre des Hauses gilt). Schlägt es fehl, bleibt
      // die Abholung stehen; die Rechnung lässt sich später anlegen (sie nimmt dann denselben Abholtag).
      const inv = await saveRepairInvoice(w, [{ id: rep.id, revision: neu || rep.revision }],
        { taxScheme: step.invoice.taxScheme, invoiceDate: step.pickedUpDate });
      neuLaden();
      setSchritt(null);
      if ('error' in inv) { w.clear(); setHinweis(pickupKeptInvoiceRefused(step.pickedUpDate, inv.error)); return; }
      onClose();
      navigate(`/invoices/${inv.invoiceId}`);
      return;
    }
    setSchritt(null);
    setHinweis(`Status: ${wort(step.status)}.`);
  }

  const kopf = { display: 'block', fontSize: 10, color: '#4B5563', letterSpacing: '0.06em', textTransform: 'uppercase' as const, marginBottom: 6 };
  const bereich: React.CSSProperties = { border: '1px solid #E5E9EE', borderRadius: 10 };
  const bereichKopf: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '10px 12px', borderBottom: '1px solid #EEF1F4' };

  /** Eine offene Zeile — anzeigen, ändern, stornieren (Arbeit und Material gleich). */
  function zeile(l: RepairLine) {
    const edit = zeileEdit?.lineId === l.id ? zeileEdit : null;
    const editKosten = edit ? (edit.cost.trim() === '' && !l.supplierId ? 0 : Number(edit.cost)) : 0;
    const editOk = !!edit && repairLineCostIssue(l.supplierId, editKosten) === null;
    return (
      <div key={l.id} data-quick-line={l.id} style={{ padding: '8px 12px', borderBottom: '1px solid #F2F4F7', fontSize: 12 }}>
        {!edit ? (
          <div style={{ display: 'grid', gridTemplateColumns: '100px 1fr 90px auto', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: '#0F0F10', background: l.materialKind ? '#FFF7ED' : '#F2F7FA', border: `1px solid ${l.materialKind ? '#FED7AA' : '#D5D9DE'}`, borderRadius: 999, padding: '2px 8px', justifySelf: 'start' }}>
              {l.materialKind ? wort(l.materialKind) : repairWorkTypeLabel(l.workType)}
            </span>
            <span style={{ color: '#0F0F10', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {l.description || '—'}
              {l.materialKind && <span style={{ color: '#4B5563' }}> · {l.supplierId ? nameOf(l.supplierId) : 'Own stock'}</span>}
            </span>
            <span className="font-mono" style={{ textAlign: 'right' }}>{fmt(l.costAmount)}</span>
            {darf && !abgerechnet ? (
              <span className="flex gap-2">
                <button type="button" className="cursor-pointer" style={{ fontSize: 11, color: '#5B3DCC', background: 'none', border: 'none' }}
                  onClick={() => setZeileEdit({ lineId: l.id, description: l.description || '', cost: String(l.costAmount ?? ''), workType: l.workType || 'service', notes: l.notes || '' })}
                  data-quick-line-edit={l.id}>Edit</button>
                <button type="button" className="cursor-pointer" style={{ fontSize: 11, color: '#B91C1C', background: 'none', border: 'none' }}
                  onClick={() => void zeileStornieren(l)} data-quick-line-cancel={l.id}>Cancel</button>
              </span>
            ) : <span />}
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: l.materialKind ? '1fr 120px' : '150px 1fr 120px', gap: 10 }}>
            {!l.materialKind && (
              <select value={edit.workType} onChange={(e) => setZeileEdit({ ...edit, workType: e.target.value as RepairWorkType })}
                style={{ padding: '6px 8px', fontSize: 12, border: '1px solid #D5D9DE', borderRadius: 6 }} data-quick-line-worktype>
                {REPAIR_WORK_TYPES.map((t) => <option key={t} value={t}>{wort(t)}</option>)}
              </select>
            )}
            <Input placeholder="Description" value={edit.description} onChange={(e) => setZeileEdit({ ...edit, description: e.target.value })} data-quick-line-description />
            <Input type="number" step="0.001" min="0" placeholder={l.supplierId ? 'Cost' : '0.000'} value={edit.cost} onChange={(e) => setZeileEdit({ ...edit, cost: e.target.value })} data-quick-line-cost />
            <div style={{ gridColumn: '1 / -1' }} className="flex justify-between items-center">
              <span style={{ fontSize: 11, color: '#4B5563' }}>
                Source: {l.supplierId ? nameOf(l.supplierId) : (l.materialKind ? 'Own stock' : 'In-house')}
                {l.supplierId ? ' — to change the workshop of a booked line, cancel it and add a new one.' : ' — 0.000 is fine.'}
              </span>
              <span className="flex gap-2">
                <Button variant="ghost" onClick={() => setZeileEdit(null)}>Cancel</Button>
                <Button variant="primary" onClick={() => void zeileSpeichern(l)} disabled={w.busy || !editOk} data-quick-line-save>Save line</Button>
              </span>
            </div>
          </div>
        )}
      </div>
    );
  }

  const gruppe = (titel: string, farbe: string, ls: RepairLine[], hinweisText: string, key: string) => {
    const sub = ls.reduce((s, l) => s + (l.costAmount || 0), 0);
    return (
      <div key={key} style={{ paddingTop: 6 }} data-quick-work-group={key}>
        <div className="flex justify-between items-center" style={{ padding: '4px 12px' }}>
          <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: farbe }}>{titel}</span>
          <span style={{ fontSize: 11, color: '#4B5563' }}>Subtotal <span className="font-mono">{fmt(sub)}</span></span>
        </div>
        {ls.map(zeile)}
        <p style={{ fontSize: 11, color: '#4B5563', margin: '4px 12px 6px' }}>{hinweisText}</p>
      </div>
    );
  };

  return (
    <>
      <Modal open onClose={onClose} title="Quick Edit Repair" width={780}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }} data-repair-quick-edit-modal={rep.repairNumber}>
          <WriteError text={w.fehler} />
          <div className="flex justify-between items-start" style={{ gap: 12 }}>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-mono" style={{ fontSize: 13, color: '#0F0F10' }}>{rep.repairNumber}</span>
                <RepairWorkSourceBadge kind={quelle.kind} />
              </div>
              <div style={{ fontSize: 12, color: '#4B5563', marginTop: 2 }}>
                {customer ? `${customer.firstName} ${customer.lastName}`.trim() : '—'} · {repairItemDisplayName(rep) || '—'}
              </div>
              <div style={{ fontSize: 12, color: '#0F0F10', marginTop: 2 }}><span style={{ color: '#4B5563' }}>Issue:</span> {rep.issueDescription || '—'}</div>
              <div style={{ fontSize: 11, color: '#4B5563', marginTop: 2 }} data-quick-work-source-text>{repairWorkSourceText(quelle, nameOf)}</div>
            </div>
            <div className="flex items-center gap-2">
              <span data-quick-status style={{ fontSize: 11, padding: '3px 10px', borderRadius: 999, background: 'rgba(15,15,16,0.06)', color: '#0F0F10' }}>
                {wort(rep.status)}
              </span>
              {rep.invoiceId && (
                <Button variant="ghost" onClick={() => { onClose(); navigate(`/invoices/${rep.invoiceId}`); }}>Invoice</Button>
              )}
              <Button variant="ghost" onClick={() => { onClose(); navigate(`/repairs/${rep.id}`); }} data-quick-open-details>Open details</Button>
            </div>
          </div>
          {hinweis && (
            <p style={{ fontSize: 12, color: /NOT created/.test(hinweis) ? '#B45309' : '#3F6F2F' }} data-quick-hint>{hinweis}</p>
          )}

          {/* STATUS — nur die Schritte, die das Haus zulässt (vorwärts, Returned, Reopen). */}
          <div>
            <span style={kopf}>Status</span>
            <div className="flex flex-wrap gap-2">
              {ziele.length === 0 && <span style={{ fontSize: 12, color: '#4B5563' }}>No further step from here.</span>}
              {darf && rep.status === 'returned' && ziele.length > 0 && (
                <Button variant="primary" disabled={w.busy} onClick={() => setSchritt('REOPEN')} data-quick-status-target="reopen">
                  {ziele.length === 1 ? repairStatusActionLabel(rep.status, ziele[0]) : 'Reopen Repair'}
                </Button>
              )}
              {darf && rep.status !== 'returned' && ziele.map((t) => (
                <Button key={t} variant={t === 'returned' ? 'secondary' : 'primary'} disabled={w.busy}
                  onClick={() => setSchritt(t)} data-quick-status-target={t}>
                  {repairStatusActionLabel(rep.status, t)}
                </Button>
              ))}
            </div>
          </div>

          {/* ARBEIT — eigene Arbeit und Werkstätten getrennt, jede mit Zwischensumme. */}
          <div style={bereich} data-quick-work-section>
            <div style={bereichKopf}>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#0F0F10' }}>Work / Labour</span>
              <span style={{ fontSize: 12, color: '#4B5563' }}>Work total <span className="font-mono" style={{ color: '#0F0F10' }} data-quick-work-total>{fmt(kosten.work)}</span></span>
            </div>
            {arbeitsZeilen.length === 0 && (
              <p style={{ fontSize: 12, color: '#4B5563', padding: '10px 12px', margin: 0 }}>No work line yet.</p>
            )}
            {eigene.length > 0 && gruppe('In-house · own staff', '#5B3DCC', eigene,
              'Only extra costs not already in Payroll or Expenses — 0.000 is right for salaried staff. No payable.', 'inhouse')}
            {werkstaetten.map((sid) => gruppe(`External workshop · ${nameOf(sid)}`, '#1D4ED8', arbeitsZeilen.filter((l) => l.supplierId === sid),
              `Payable to ${nameOf(sid)} — booked as before (once the work starts).`, sid))}
            {quelle.plannedWorkshopId && (
              <p style={{ fontSize: 11, color: '#1D4ED8', margin: '6px 12px' }} data-quick-planned-workshop>
                Planned: {nameOf(quelle.plannedWorkshopId)} — no work line yet, nothing booked. Add its work line when the bill is known.
              </p>
            )}
            <div style={{ padding: '8px 12px 12px' }}>
              {darf && !abgerechnet && !arbeit && (
                <Button variant="secondary" onClick={() => setArbeit({ ...EMPTY_WORK_LINE, ...(quelle.plannedWorkshopId ? { source: 'external', supplierId: quelle.plannedWorkshopId } : {}) })}
                  disabled={w.busy} data-quick-add-work>+ Add Work</Button>
              )}
              {arbeit && (
                <RepairWorkLineForm draft={arbeit} onChange={setArbeit} onCancel={() => setArbeit(null)}
                  onSubmit={(v) => void arbeitHinzufuegen(v)} suppliers={suppliers} busy={w.busy}
                  prefix="quick-work" saveAttr="quick-work-save" />
              )}
            </div>
          </div>

          {/* MATERIAL — eigener Bereich, eigener Dialog (Gold-, Bestands- und Lieferantenregeln unverändert). */}
          <div style={bereich} data-quick-material-section>
            <div style={bereichKopf}>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#0F0F10' }}>Materials / Parts</span>
              <span style={{ fontSize: 12, color: '#4B5563' }}>Material total <span className="font-mono" style={{ color: '#0F0F10' }} data-quick-material-total>{fmt(kosten.material)}</span></span>
            </div>
            {materialZeilen.length === 0 && <p style={{ fontSize: 12, color: '#4B5563', padding: '10px 12px', margin: 0 }}>No material on this repair.</p>}
            {materialZeilen.map(zeile)}
            {darf && !abgerechnet && (
              <div style={{ padding: '8px 12px 12px' }}>
                <Button variant="secondary" onClick={() => setMaterial(true)} disabled={w.busy} data-quick-add-material>+ Add Material</Button>
              </div>
            )}
          </div>

          {/* PREIS + ZUSAMMENFASSUNG — dieselbe Summe wie Detailseite, Einstand und Rechnung (`computeRepairTotalCost`). */}
          <div style={{ ...bereich, padding: 12, display: 'grid', gridTemplateColumns: '1fr 1.2fr', gap: 16 }}>
            <div>
              <Input label="CHARGE TO CLIENT (BHD)" type="number" step="0.001" value={betrag.charge} disabled={abgerechnet || !darf}
                onChange={(e) => { setBetrag({ ...betrag, charge: e.target.value }); setBetragGeaendert(true); }} data-quick-charge />
              {abgerechnet
                ? <p style={{ fontSize: 11, color: '#4B5563', marginTop: 6 }}>Invoiced — cost and charge are on the invoice and are frozen here.</p>
                : (
                  <div className="flex justify-end" style={{ marginTop: 8 }}>
                    <Button variant="primary" onClick={() => void betraegeSpeichern()} disabled={w.busy || !betragGeaendert || !darf} data-quick-save-amounts>
                      Save amounts
                    </Button>
                  </div>
                )}
            </div>
            <div style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }} data-quick-totals>
              <div className="flex justify-between"><span style={{ color: '#4B5563' }}>Work cost</span><span className="font-mono">{fmt(kosten.work)}</span></div>
              <div className="flex justify-between"><span style={{ color: '#4B5563' }}>Material cost</span><span className="font-mono">{fmt(kosten.material)}</span></div>
              {kosten.own > 0.0005 && (
                <div className="flex justify-between"><span style={{ color: '#4B5563' }}>{labels.own.charAt(0) + labels.own.slice(1).toLowerCase()}</span><span className="font-mono">{fmt(kosten.own)}</span></div>
              )}
              {kosten.fee > 0.0005 && (
                <div className="flex justify-between"><span style={{ color: '#4B5563' }}>Workshop fee (older repair, no lines)</span><span className="font-mono">{fmt(kosten.fee)}</span></div>
              )}
              <div className="flex justify-between" style={{ borderTop: '1px solid #E5E9EE', paddingTop: 4 }}>
                <span style={{ color: '#4B5563' }}>Cost lines</span><span className="font-mono" data-quick-lines-total>{fmt(kosten.linesTotal)}</span>
              </div>
              <div className="flex justify-between"><span style={{ fontWeight: 600 }}>Total actual cost</span><span className="font-mono" style={{ fontWeight: 600 }} data-quick-total-cost>{fmt(total)}</span></div>
              <div className="flex justify-between"><span style={{ color: '#4B5563' }}>Charge to client</span><span className="font-mono" data-quick-charge-total>{fmt(charge)}</span></div>
              <div className="flex justify-between" style={{ borderTop: '1px solid #E5E9EE', paddingTop: 4 }}>
                <span style={{ fontWeight: 600 }}>Margin</span>
                <span className="font-mono" style={{ fontWeight: 600, color: charge - total >= 0 ? '#15803D' : '#B91C1C' }} data-quick-margin>{fmt(charge - total)}</span>
              </div>
            </div>
          </div>

          {/* ADVANCED — Schätzung und (nur ohne Zeilen) der von Hand erfasste Aufwand, mit ihrer bestehenden Bedeutung. */}
          <div style={bereich}>
            <button type="button" onClick={() => setErweitert(!erweitert)} aria-expanded={erweitert} data-quick-advanced
              className="cursor-pointer" style={{ width: '100%', display: 'flex', justifyContent: 'space-between', padding: '10px 12px', background: 'none', border: 'none', fontSize: 12, color: '#0F0F10' }}>
              <span>Advanced: estimate and manual cost</span><span style={{ color: '#4B5563' }}>{erweitert ? 'Hide' : 'Show'}</span>
            </button>
            {erweitert && (
              <div style={{ padding: '0 12px 12px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <Input label={`${schaetzung === 'fee' ? labels.estimated : 'ESTIMATED COST'} (BHD)`} type="number" step="0.001" value={betrag.estimated} disabled={abgerechnet || !darf}
                    onChange={(e) => { setBetrag({ ...betrag, estimated: e.target.value }); setBetragGeaendert(true); }} data-quick-estimated />
                  <p style={{ fontSize: 11, color: '#4B5563', marginTop: 4, lineHeight: 1.4 }}>
                    {schaetzung === 'fee'
                      ? 'Older repair without cost lines: this is the workshop fee — it is booked as the workshop’s cost at “Ready”.'
                      : 'Information only (e.g. for the quote) — not counted as cost.'}
                  </p>
                </div>
                <div>
                  {kosten.hasLines ? (
                    <>
                      <Input label="ACTUAL COST (BHD)" value={fmt(kosten.linesTotal)} disabled readOnly data-quick-actual />
                      <p style={{ fontSize: 11, color: '#4B5563', marginTop: 4, lineHeight: 1.4 }}>Calculated from the cost lines — change a line instead.</p>
                    </>
                  ) : (
                    <>
                      <Input label={`${labels.actual} (BHD)`} type="number" step="0.001" value={betrag.actual} disabled={abgerechnet || !darf}
                        onChange={(e) => { setBetrag({ ...betrag, actual: e.target.value }); setBetragGeaendert(true); }} data-quick-actual />
                      <p style={{ fontSize: 11, color: '#4B5563', marginTop: 4, lineHeight: 1.4 }}>No cost lines yet: entered by hand, counted as before.</p>
                    </>
                  )}
                </div>
                <p style={{ gridColumn: '1 / -1', fontSize: 11, color: '#4B5563', margin: 0 }}>{IN_HOUSE_LINE_NOTE}</p>
              </div>
            )}
          </div>
        </div>
      </Modal>

      <AddMaterialModal open={material} onClose={() => setMaterial(false)} showCustomerPrice={false} ownStockNote={IN_HOUSE_LINE_NOTE}
        busy={w.busy} submitError={w.fehler} onSubmitAll={async (rows) => { const ok = await materialHinzufuegen(rows); if (ok) setMaterial(false); return ok; }} />

      {schritt && (
        <RepairStatusDialog
          repair={rep}
          target={schritt === 'REOPEN' ? null : schritt}
          reopenTargets={rep.status === 'returned' ? ziele : []}
          busy={w.busy}
          error={w.fehler}
          onClose={() => { setSchritt(null); w.clear(); }}
          onConfirm={(s) => void schrittAusfuehren(s)}
        />
      )}
    </>
  );
}
