// CENTRAL-C3F — der Reparaturbildschirm des zweiten Rechners: aufnehmen und ändern.
//
// Der Status fehlt hier mit Absicht. Ihn zu wechseln bucht im Haus Lieferantenverbindlichkeiten
// (`commitRepairLineExpenses`) und bei „ready" eine Werkstattgebühr — das ist ein eigener Vertrag
// mit eigenen Beweisen, nicht ein Feld dieses Formulars. Ein Auswahlfeld dafür wäre ein
// Versprechen, das der Primary nicht hält.
//
// Die Marge wird gezeigt, aber nicht geschickt: der Primary rechnet seine eigene aus dem Stand,
// der nach der Änderung wirklich gilt.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CommandSaveController, type SaveOutcome } from '@/core/bridge/client-command-save';
import { remoteRead, type RemoteReadError } from '@/core/bridge/remote-read';
import {
  EMPTY_REPAIR, REPAIR_EDIT_FIELDS, changeCount, draftOf, previewMargin, repairComplete,
  repairCreateRequest, repairUpdateRequest, type Draft, type RepairDraft,
} from '@/core/bridge/client-service-request';
import { Outcome, PickField, Row, TextField } from './client-form-atoms';
import { box, btn, field, label, warn } from './client-form-style';

export const OP_REPAIRS_CREATE = 'repairs.create';
export const OP_REPAIRS_UPDATE = 'repairs.update';

export interface RepairSaveValue {
  repairId: string;
  repairNumber: string;
  status: string;
  margin: number | null;
  voucherCode: string;
  revision: number;
  replayed?: boolean;
}

const fmt = (v: number): string => v.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

export function ClientRepairForm({ repairId, onSaved, onCancel, read = remoteRead }: {
  repairId?: string;
  onSaved?: (id: string) => void;
  onCancel?: () => void;
  read?: typeof remoteRead;
}) {
  const editing = typeof repairId === 'string' && repairId !== '';
  const [draft, setDraft] = useState<RepairDraft>(EMPTY_REPAIR);
  const [base, setBase] = useState<Draft>({});
  const [edit, setEdit] = useState<Draft>({});
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState('');
  const [customers, setCustomers] = useState<Array<Record<string, unknown>>>([]);
  const [suppliers, setSuppliers] = useState<Array<Record<string, unknown>>>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<SaveOutcome<RepairSaveValue> | null>(null);

  const controller = useMemo(
    () => new CommandSaveController<RepairSaveValue>(editing ? OP_REPAIRS_UPDATE : OP_REPAIRS_CREATE),
    [editing],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (editing) {
          const row = await read<Record<string, unknown>>('repairs.get', { id: repairId });
          if (cancelled) return;
          const d = draftOf([...REPAIR_EDIT_FIELDS], row);
          setBase(d);
          setEdit(d);
          setRevision(Number(row.revision ?? 0));
          setStatus(s(row.status));
        } else {
          const people = await read<{ items: Array<Record<string, unknown>> }>('customers.list', { limit: 500 });
          if (!cancelled) setCustomers(people.items ?? []);
        }
        const sup = await read<{ items: Array<Record<string, unknown>> }>('suppliers.list', {});
        if (!cancelled) { setSuppliers(sup.items ?? []); setLoadError(null); }
      } catch (e) {
        if (cancelled) return;
        const err = e as RemoteReadError;
        setLoadError(err?.code ? `${err.code}: ${err.message}` : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [editing, repairId, read]);

  const set = (f: keyof RepairDraft, v: string): void => setDraft((p) => ({ ...p, [f]: v }));
  const setE = (f: string, v: string): void => setEdit((p) => ({ ...p, [f]: v }));
  const cur = (f: keyof RepairDraft): string => (editing ? (edit[f] ?? '') : draft[f]);
  const put = (f: keyof RepairDraft, v: string): void => (editing ? setE(f, v) : set(f, v));

  const body = editing ? repairUpdateRequest(repairId!, revision, base, edit) : repairCreateRequest(draft);
  const complete = editing ? changeCount(body) > 0 : repairComplete(draft);
  const pending = outcome?.kind === 'unknown';
  const margin = previewMargin({
    repairType: cur('repairType') || 'internal',
    estimatedCost: cur('estimatedCost'),
    actualCost: cur('actualCost'),
    internalCost: cur('internalCost'),
    chargeToCustomer: cur('chargeToCustomer'),
  });

  const send = useCallback(async () => {
    setBusy(true);
    try {
      const attempt = controller.beginAttempt();
      setOutcome(await attempt.send(body));
    } finally {
      setBusy(false);
    }
  }, [controller, body]);

  function startOver(keepDraft = false): void {
    controller.forget();
    setOutcome(null);
    if (!editing && !keepDraft) setDraft(EMPTY_REPAIR);
  }

  if (loading) return <div data-client-repair-loading style={box}>Loading…</div>;

  if (outcome?.kind === 'ok') {
    return (
      <div data-client-repair-done style={box}>
        <div style={{ fontSize: 18, fontWeight: 600 }}>{editing ? 'Repair updated' : 'Repair booked in'}</div>
        <div data-client-repair-number style={{ marginTop: 6 }}>{outcome.value.repairNumber}</div>
        <div style={{ marginTop: 4, opacity: 0.8 }}>
          {outcome.value.status}
          {outcome.value.voucherCode ? ` · voucher ${outcome.value.voucherCode}` : ''}
          {outcome.value.margin === null ? '' : ` · margin ${fmt(outcome.value.margin)}`}
        </div>
        {outcome.replayed && (
          <div data-client-repair-replayed style={{ marginTop: 8, opacity: 0.8 }}>
            This was the answer to the attempt that had already run — nothing was booked twice.
          </div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          {!editing && (
            <button data-client-repair-again onClick={() => startOver()} style={btn(true)}>New repair</button>
          )}
          <button data-client-repair-back onClick={() => {
            const id = outcome.value.repairId;
            startOver();
            onSaved?.(id);
          }} style={btn(editing)}>{editing ? 'Back' : 'Show repairs'}</button>
        </div>
      </div>
    );
  }

  return (
    <div data-client-repair-form style={box}>
      <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>
        {editing ? 'Edit repair' : 'Book in a repair'}
      </div>
      {loadError && <div data-client-repair-loaderror style={warn}>Cannot reach the server: {loadError}</div>}
      {editing && (
        <div data-client-repair-status style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>
          Status: {status} — moving a repair along books supplier costs, so it stays on the primary.
        </div>
      )}

      {!editing && (
        <Row>
          <div style={{ flex: 2 }}>
            <label style={label}>Client</label>
            <select data-client-field="repair.customerId" value={draft.customerId} disabled={pending}
              onChange={(e) => set('customerId', e.target.value)} style={field}>
              <option value="">— choose a client —</option>
              {customers.map((c) => (
                <option key={s(c.id)} value={s(c.id)}>
                  {s(c.firstName)} {s(c.lastName)}{s(c.company) ? ` · ${s(c.company)}` : ''}
                </option>
              ))}
            </select>
          </div>
          <PickField kind="repair" name="taxScheme" label="Tax" value={draft.taxScheme}
            onChange={(v) => set('taxScheme', v)} disabled={pending}
            options={[['VAT_10', '10 %'], ['ZERO', 'None'], ['MARGIN', 'Margin']]} />
        </Row>
      )}

      <Row>
        <TextField kind="repair" name="itemBrand" label="Brand" value={cur('itemBrand')}
          onChange={(v) => put('itemBrand', v)} disabled={pending} />
        <TextField kind="repair" name="itemModel" label="Model" value={cur('itemModel')}
          onChange={(v) => put('itemModel', v)} disabled={pending} />
        <TextField kind="repair" name="itemSerial" label="Serial" value={cur('itemSerial')}
          onChange={(v) => put('itemSerial', v)} disabled={pending} />
      </Row>

      {!editing && (
        <>
          <label style={{ ...label, marginTop: 8 }}>What is wrong</label>
          <input data-client-field="repair.issueDescription" value={draft.issueDescription} disabled={pending}
            onChange={(e) => set('issueDescription', e.target.value)} style={field} />
        </>
      )}
      {editing && (
        <>
          <label style={{ ...label, marginTop: 8 }}>Diagnosis</label>
          <input data-client-field="repair.diagnosis" value={edit.diagnosis ?? ''} disabled={pending}
            onChange={(e) => setE('diagnosis', e.target.value)} style={field} />
        </>
      )}

      <Row>
        <PickField kind="repair" name="repairType" label="Type" value={cur('repairType') || 'internal'}
          onChange={(v) => put('repairType', v)} disabled={pending}
          options={[['internal', 'In house'], ['external', 'Workshop'], ['hybrid', 'Both']]} />
        <div style={{ flex: 1 }}>
          <label style={label}>Workshop</label>
          <select data-client-field="repair.workshopSupplierId" value={cur('workshopSupplierId')} disabled={pending}
            onChange={(e) => put('workshopSupplierId', e.target.value)} style={field}>
            <option value="">— none —</option>
            {suppliers.map((x) => <option key={s(x.id)} value={s(x.id)}>{s(x.name)}</option>)}
          </select>
        </div>
        <TextField kind="repair" name="estimatedReady" label="Ready by" date value={cur('estimatedReady')}
          onChange={(v) => put('estimatedReady', v)} disabled={pending} />
      </Row>

      <Row>
        <TextField kind="repair" name="estimatedCost" label="Estimated cost" numeric value={cur('estimatedCost')}
          onChange={(v) => put('estimatedCost', v)} disabled={pending} />
        {editing && (
          <TextField kind="repair" name="actualCost" label="Actual cost" numeric value={cur('actualCost')}
            onChange={(v) => put('actualCost', v)} disabled={pending} />
        )}
        <TextField kind="repair" name="internalCost" label="In-house cost" numeric value={cur('internalCost')}
          onChange={(v) => put('internalCost', v)} disabled={pending} />
        <TextField kind="repair" name="chargeToCustomer" label="Charge to client" numeric value={cur('chargeToCustomer')}
          onChange={(v) => put('chargeToCustomer', v)} disabled={pending} />
      </Row>

      <label style={{ ...label, marginTop: 8 }}>Note</label>
      <input data-client-field="repair.notes" value={cur('notes')} disabled={pending}
        onChange={(e) => put('notes', e.target.value)} style={field} />

      <div data-client-repair-preview style={{ marginTop: 12, fontSize: 13, opacity: 0.75 }}>
        {margin === null ? 'No charge set yet.' : `${fmt(margin)} BHD margin`} — the primary calculates
        the real cost and margin.
      </div>

      {editing && (
        <div data-client-repair-changes style={{ marginTop: 10, fontSize: 12, opacity: 0.7 }}>
          {changeCount(body) === 0
            ? 'Nothing changed yet — only what you edit is sent.'
            : `Sending only: ${Object.keys(body).filter((k) => k !== 'id' && k !== 'expectedRevision').join(', ')}`}
        </div>
      )}

      <Outcome kind="repair" outcome={outcome} />

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button data-client-repair-save disabled={busy || !complete || outcome?.kind === 'business_error'}
          onClick={send} style={btn(true)}>
          {pending ? 'Retry the same attempt' : busy ? 'Saving…' : 'Save'}
        </button>
        {outcome?.kind === 'business_error' && (
          <button data-client-repair-restart onClick={() => startOver(true)} style={btn(false)}>
            Start a new attempt
          </button>
        )}
        {onCancel && !pending && (
          <button data-client-repair-cancel onClick={onCancel} style={btn(false)}>Cancel</button>
        )}
      </div>
    </div>
  );
}
