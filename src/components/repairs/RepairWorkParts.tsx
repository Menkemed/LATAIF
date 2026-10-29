// ════════════════════════════════════════════════════════════════════════════
// REPAIR-REDESIGN — die gemeinsamen Teile der Reparaturmasken (Liste, Quick Edit, Detailseite):
//   • `RepairWorkSourceBadge` — In-house / External workshop / Hybrid, ABGELEITET aus der Arbeit
//     (`repair-work-source`), nicht mehr gewählt;
//   • `RepairWorkLineForm` — eine Arbeitszeile anlegen: Quelle (eigene Arbeit ODER eine Werkstatt), Arbeitsart,
//     Kosten, Beschreibung. Dieselbe Kostenregel wie Primary, PC2 und Handy (`repairLineCostIssue`).
// Hier steht keine Buchungsregel — Speichern geht weiter über die Hausfunktion bzw. den Fernbefehl der Maske.
// ════════════════════════════════════════════════════════════════════════════
import { useMemo } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { REPAIR_WORK_TYPES, type RepairWorkType } from '@/core/models/types';
import { IN_HOUSE_LINE_NOTE } from '@/core/repairs/repair-line-view';
import { hasSelectableWorkshop, NO_WORKSHOP_HINT, workshopOptions, type WorkshopCandidate } from '@/core/repairs/repair-workshop-choice';
import {
  REPAIR_LINE_COST_MESSAGE, REPAIR_WORK_SOURCE_LABEL, repairLineCostIssue, repairWorkTypeLabel,
  type RepairWorkSource, type RepairWorkSourceKind,
} from '@/core/repairs/repair-work-source';

const BADGE: Record<RepairWorkSourceKind, { fg: string; bg: string }> = {
  inhouse: { fg: '#5B3DCC', bg: 'rgba(113,93,227,0.10)' },
  external: { fg: '#1D4ED8', bg: 'rgba(61,127,255,0.10)' },
  hybrid: { fg: '#9A3412', bg: 'rgba(255,135,48,0.16)' },
  none: { fg: '#4B5563', bg: 'rgba(107,114,128,0.12)' },
};

export function RepairWorkSourceBadge({ kind, size = 11 }: { kind: RepairWorkSourceKind; size?: number }) {
  const c = BADGE[kind];
  return (
    <span data-repair-work-source={kind}
      style={{ display: 'inline-block', fontSize: size, fontWeight: 600, color: c.fg, background: c.bg, borderRadius: 999, padding: '3px 10px', whiteSpace: 'nowrap' }}>
      {REPAIR_WORK_SOURCE_LABEL[kind]}
    </span>
  );
}

/** „Own staff + Workshop A (planned)" — wer arbeitet, mit Namen. */
export function repairWorkSourceText(ws: RepairWorkSource, nameOf: (supplierId: string) => string): string {
  const shops = ws.workshopIds.map((id) => `${nameOf(id)}${id === ws.plannedWorkshopId ? ' (planned)' : id === ws.assignedWorkshopId ? ' (assigned)' : ''}`);
  if (ws.externalWithoutWorkshop) shops.push('workshop not chosen yet');
  if (ws.kind === 'hybrid') return ['Own staff', ...shops].join(' + ');
  if (ws.kind === 'external') return shops.join(', ') || 'Workshop not chosen yet';
  if (ws.kind === 'inhouse') return 'Own staff';
  return '—';
}

export interface WorkLineDraft {
  source: 'inhouse' | 'external';
  supplierId: string;
  workType: RepairWorkType;
  description: string;
  cost: string;
  dueDate: string;
}

export const EMPTY_WORK_LINE: WorkLineDraft = { source: 'inhouse', supplierId: '', workType: 'service', description: '', cost: '', dueDate: '' };

export interface WorkLineValues {
  supplierId?: string;
  workType: RepairWorkType;
  description?: string;
  costAmount: number;
  dueDate?: string;
}

/** Was die Zeile speichern würde — oder warum noch nicht. Eigene Arbeit ohne Betrag = 0.000. */
export function workLineValues(d: WorkLineDraft): { values: WorkLineValues } | { problem: string } {
  const ext = d.source === 'external';
  if (ext && !d.supplierId) return { problem: 'Choose the workshop.' };
  const raw = d.cost.trim();
  const cost = raw === '' && !ext ? 0 : Number(raw);
  const issue = repairLineCostIssue(ext ? d.supplierId : null, raw === '' && ext ? Number.NaN : cost);
  if (issue) return { problem: issue === 'LINE_COST_REQUIRED' || raw === '' ? 'Enter the workshop cost (above 0) — it becomes the payable to the workshop.' : REPAIR_LINE_COST_MESSAGE[issue] };
  return {
    values: {
      ...(ext ? { supplierId: d.supplierId } : {}),
      workType: d.workType,
      ...(d.description.trim() ? { description: d.description.trim() } : {}),
      costAmount: cost,
      ...(d.dueDate ? { dueDate: d.dueDate } : {}),
    },
  };
}

interface WorkLineFormProps {
  draft: WorkLineDraft;
  onChange: (d: WorkLineDraft) => void;
  onCancel: () => void;
  onSubmit: (v: WorkLineValues) => void;
  suppliers: readonly WorkshopCandidate[];
  busy?: boolean;
  showDueDate?: boolean;
  /** Präfix der Testkennungen (`data-<prefix>-type` …) — „quick-work" im Quick Edit, „repair-line" an der Detailseite. */
  prefix: string;
  /** Die Kennung des Speichern-Knopfs (bestehende Prüfungen greifen darauf zu). */
  saveAttr: string;
}

export function RepairWorkLineForm({ draft, onChange, onCancel, onSubmit, suppliers, busy, showDueDate, prefix, saveAttr }: WorkLineFormProps) {
  const options = useMemo(() => workshopOptions(suppliers, [draft.supplierId]), [suppliers, draft.supplierId]);
  const result = workLineValues(draft);
  const ext = draft.source === 'external';
  const seg = (on: boolean): React.CSSProperties => ({
    flex: 1, padding: '8px 10px', fontSize: 12, fontWeight: 600, borderRadius: 6, border: 'none', cursor: 'pointer',
    color: on ? '#FFFFFF' : '#0F0F10', background: on ? '#0F0F10' : 'transparent',
  });
  const attr = (k: string) => ({ [`data-${prefix}-${k}`]: true });
  return (
    <div style={{ padding: 12, border: '1px solid #E5E9EE', borderRadius: 8, background: '#FAFBFC', display: 'flex', flexDirection: 'column', gap: 10 }} {...attr('form')}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div>
          <span className="text-overline" style={{ marginBottom: 6 }}>WORK SOURCE</span>
          <div className="flex" style={{ gap: 3, padding: 3, border: '1px solid #D5D9DE', borderRadius: 8, background: '#FFFFFF', marginTop: 6 }}>
            <button type="button" style={seg(!ext)} aria-pressed={!ext} {...attr('source-inhouse')}
              onClick={() => onChange({ ...draft, source: 'inhouse', supplierId: '' })}>In-house</button>
            <button type="button" style={seg(ext)} aria-pressed={ext} {...attr('source-external')}
              onClick={() => onChange({ ...draft, source: 'external' })}>External workshop</button>
          </div>
        </div>
        <div>
          <span className="text-overline" style={{ marginBottom: 6 }}>WORK TYPE</span>
          <select value={draft.workType} onChange={(e) => onChange({ ...draft, workType: e.target.value as RepairWorkType })}
            style={{ width: '100%', marginTop: 6, padding: '9px 10px', fontSize: 13, border: '1px solid #D5D9DE', borderRadius: 6, background: '#FFFFFF' }} {...attr('type')}>
            {REPAIR_WORK_TYPES.map((t) => <option key={t} value={t}>{repairWorkTypeLabel(t)}</option>)}
          </select>
        </div>
      </div>
      {ext && (
        <div>
          <SearchSelect label="WORKSHOP *" placeholder="Pick a workshop / goldsmith" options={options}
            value={draft.supplierId} onChange={(sid) => onChange({ ...draft, supplierId: sid })} />
          {!hasSelectableWorkshop(suppliers) && <p data-repair-no-workshop-hint style={{ fontSize: 11, color: '#B45309', marginTop: 6, lineHeight: 1.4 }}>{NO_WORKSHOP_HINT}</p>}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: showDueDate ? '140px 1fr 150px' : '140px 1fr', gap: 10 }}>
        <Input label="COST (BHD)" type="number" step="0.001" min="0" placeholder={ext ? 'workshop bill' : '0.000'}
          value={draft.cost} onChange={(e) => onChange({ ...draft, cost: e.target.value })} {...attr('cost')} />
        <Input label="DESCRIPTION (OPTIONAL)" placeholder={ext ? 'e.g. clasp soldering' : 'e.g. high polish'}
          value={draft.description} onChange={(e) => onChange({ ...draft, description: e.target.value })} {...attr('description')} />
        {showDueDate && (
          <Input label="DUE DATE (OPTIONAL)" type="date" value={draft.dueDate} onChange={(e) => onChange({ ...draft, dueDate: e.target.value })} />
        )}
      </div>
      <p style={{ fontSize: 11, color: '#4B5563', margin: 0, lineHeight: 1.45 }}>
        {ext
          ? 'From the workshop’s bill — it becomes the payable to that workshop (booked once the work starts).'
          : `${IN_HOUSE_LINE_NOTE} Leave empty or 0.000 for regular salaried staff — no booking then.`}
      </p>
      {'problem' in result && (draft.cost.trim() !== '' || ext) && (
        <p style={{ fontSize: 11, color: '#B45309', margin: 0 }} {...attr('problem')}>{result.problem}</p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button variant="primary" disabled={!!busy || 'problem' in result} {...{ [`data-${saveAttr}`]: true }}
          onClick={() => { if ('values' in result) onSubmit(result.values); }}>Add Line</Button>
      </div>
    </div>
  );
}
