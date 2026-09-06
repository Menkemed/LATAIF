// CENTRAL-C3F — der Transferbildschirm des zweiten Rechners.
//
// „Transfer" heißt hier NICHT Filialtransfer: ein Stück Ware geht auf Kommission zu einem Kunden.
// Deshalb wählt der Mensch einen KUNDEN und ein STÜCK — den Agenten dazu findet oder legt das
// Haus an, und die Transfernummer vergibt es ebenfalls. Beide stehen in keinem Feld.
//
// Der Kreislauf, den dieser Bildschirm abbildet, ist der normale: hinaus auf Kommission, ändern
// solange das Stück draußen ist, und zurück ins Lager. Verkauf, Abrechnung und Rechnung sind
// eigene Geldwege und ausdrücklich nicht dabei — auch nicht als Knopf.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CommandSaveController, type SaveOutcome } from '@/core/bridge/client-command-save';
import { remoteRead, type RemoteReadError } from '@/core/bridge/remote-read';
import {
  EMPTY_TRANSFER, TRANSFER_EDIT_FIELDS, changeCount, draftOf, transferComplete,
  transferCreateRequest, transferReturnRequest, transferUpdateRequest,
  type Draft, type TransferDraft,
} from '@/core/bridge/client-service-request';
import { Outcome, PickField, Row, TextField } from './client-form-atoms';
import { box, btn, field, label, warn } from './client-form-style';

export const OP_TRANSFERS_CREATE = 'transfers.create';
export const OP_TRANSFERS_UPDATE = 'transfers.update';
export const OP_TRANSFERS_MARK_RETURNED = 'transfers.mark_returned';

export interface TransferSaveValue {
  transferId: string;
  transferNumber: string;
  status: string;
  agentPrice: number;
  revision: number;
  replayed?: boolean;
}

const fmt = (v: number): string => v.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

export function ClientTransferForm({ transferId, onSaved, onCancel, read = remoteRead }: {
  transferId?: string;
  onSaved?: (id: string) => void;
  onCancel?: () => void;
  read?: typeof remoteRead;
}) {
  const editing = typeof transferId === 'string' && transferId !== '';
  const [draft, setDraft] = useState<TransferDraft>(EMPTY_TRANSFER);
  const [base, setBase] = useState<Draft>({});
  const [edit, setEdit] = useState<Draft>({});
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState('');
  const [customers, setCustomers] = useState<Array<Record<string, unknown>>>([]);
  const [products, setProducts] = useState<Array<Record<string, unknown>>>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<SaveOutcome<TransferSaveValue> | null>(null);

  // ZWEI Wächter, nicht einer: ändern und zurücknehmen sind zwei Vorsätze, und ein offener
  // Änderungsversuch darf niemals als Rückgabe weiterlaufen.
  const editController = useMemo(
    () => new CommandSaveController<TransferSaveValue>(editing ? OP_TRANSFERS_UPDATE : OP_TRANSFERS_CREATE),
    [editing],
  );
  const returnController = useMemo(() => new CommandSaveController<TransferSaveValue>(OP_TRANSFERS_MARK_RETURNED), []);
  const [returnOutcome, setReturnOutcome] = useState<SaveOutcome<TransferSaveValue> | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (editing) {
          const row = await read<Record<string, unknown>>('transfers.get', { id: transferId });
          if (cancelled) return;
          const d = draftOf([...TRANSFER_EDIT_FIELDS], row);
          setBase(d);
          setEdit(d);
          setRevision(Number(row.revision ?? 0));
          setStatus(s(row.status));
        } else {
          const [people, prod] = await Promise.all([
            read<{ items: Array<Record<string, unknown>> }>('customers.list', { limit: 500 }),
            read<{ items: Array<Record<string, unknown>> }>('products.list', { limit: 500 }),
          ]);
          if (cancelled) return;
          setCustomers(people.items ?? []);
          // Nur was im Lager liegt, kann hinausgehen. Der Primary prüft das noch einmal — hier
          // steht es, damit der Mensch gar nicht erst das Falsche wählt.
          setProducts((prod.items ?? []).filter((p) => s(p.stockStatus) === 'in_stock'));
        }
        if (!cancelled) setLoadError(null);
      } catch (e) {
        if (cancelled) return;
        const err = e as RemoteReadError;
        setLoadError(err?.code ? `${err.code}: ${err.message}` : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [editing, transferId, read]);

  const set = (f: keyof TransferDraft, v: string): void => setDraft((p) => ({ ...p, [f]: v }));
  const setE = (f: string, v: string): void => setEdit((p) => ({ ...p, [f]: v }));

  const body = editing ? transferUpdateRequest(transferId!, revision, base, edit) : transferCreateRequest(draft);
  const closed = editing && status !== '' && status !== 'transferred';
  const complete = editing ? (changeCount(body) > 0 && !closed) : transferComplete(draft);
  const pending = outcome?.kind === 'unknown';
  const returnPending = returnOutcome?.kind === 'unknown';

  const send = useCallback(async () => {
    setBusy(true);
    try {
      const attempt = editController.beginAttempt();
      setOutcome(await attempt.send(body));
    } finally {
      setBusy(false);
    }
  }, [editController, body]);

  const sendReturn = useCallback(async () => {
    setBusy(true);
    try {
      const attempt = returnController.beginAttempt();
      setReturnOutcome(await attempt.send(transferReturnRequest(transferId!, revision)));
    } finally {
      setBusy(false);
    }
  }, [returnController, transferId, revision]);

  function startOver(keepDraft = false): void {
    editController.forget();
    setOutcome(null);
    if (!editing && !keepDraft) setDraft(EMPTY_TRANSFER);
  }

  if (loading) return <div data-client-transfer-loading style={box}>Loading…</div>;

  if (returnOutcome?.kind === 'ok') {
    return (
      <div data-client-transfer-returned style={box}>
        <div style={{ fontSize: 18, fontWeight: 600 }}>Item is back</div>
        <div data-client-transfer-number style={{ marginTop: 6 }}>{returnOutcome.value.transferNumber}</div>
        <div style={{ marginTop: 4, opacity: 0.8 }}>{returnOutcome.value.status}</div>
        {returnOutcome.replayed && (
          <div data-client-transfer-replayed style={{ marginTop: 8, opacity: 0.8 }}>
            This was the answer to the attempt that had already run — it came back once, not twice.
          </div>
        )}
        <button data-client-transfer-back onClick={() => {
          const id = returnOutcome.value.transferId;
          returnController.forget();
          setReturnOutcome(null);
          onSaved?.(id);
        }} style={btn(true)}>Back</button>
      </div>
    );
  }

  if (outcome?.kind === 'ok') {
    return (
      <div data-client-transfer-done style={box}>
        <div style={{ fontSize: 18, fontWeight: 600 }}>{editing ? 'Transfer updated' : 'Item is out on approval'}</div>
        <div data-client-transfer-number style={{ marginTop: 6 }}>{outcome.value.transferNumber}</div>
        <div style={{ marginTop: 4, opacity: 0.8 }}>
          {outcome.value.status} · {fmt(outcome.value.agentPrice)} BHD
        </div>
        {outcome.replayed && (
          <div data-client-transfer-replayed style={{ marginTop: 8, opacity: 0.8 }}>
            This was the answer to the attempt that had already run — nothing went out twice.
          </div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          {!editing && (
            <button data-client-transfer-again onClick={() => startOver()} style={btn(true)}>New transfer</button>
          )}
          <button data-client-transfer-list onClick={() => {
            const id = outcome.value.transferId;
            startOver();
            onSaved?.(id);
          }} style={btn(editing)}>{editing ? 'Back' : 'Show transfers'}</button>
        </div>
      </div>
    );
  }

  return (
    <div data-client-transfer-form style={box}>
      <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>
        {editing ? 'Transfer on approval' : 'Send an item out on approval'}
      </div>
      {loadError && <div data-client-transfer-loaderror style={warn}>Cannot reach the server: {loadError}</div>}
      {closed && (
        <div data-client-transfer-closed style={warn}>
          This transfer is “{status}” — only one that is still out can be changed or taken back.
        </div>
      )}

      {!editing && (
        <>
          <Row>
            <div style={{ flex: 2 }}>
              <label style={label}>Client</label>
              <select data-client-field="transfer.customerId" value={draft.customerId} disabled={pending}
                onChange={(e) => set('customerId', e.target.value)} style={field}>
                <option value="">— choose a client —</option>
                {customers.map((c) => (
                  <option key={s(c.id)} value={s(c.id)}>
                    {s(c.firstName)} {s(c.lastName)}{s(c.company) ? ` · ${s(c.company)}` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ flex: 2 }}>
              <label style={label}>Item</label>
              <select data-client-field="transfer.productId" value={draft.productId} disabled={pending}
                onChange={(e) => set('productId', e.target.value)} style={field}>
                <option value="">— choose an item in stock —</option>
                {products.map((p) => (
                  <option key={s(p.id)} value={s(p.id)}>{s(p.brand)} {s(p.name)} · {s(p.sku)}</option>
                ))}
              </select>
            </div>
          </Row>
          <Row>
            <PickField kind="transfer" name="settlementModel" label="Settlement" value={draft.settlementModel}
              onChange={(v) => set('settlementModel', v)} disabled={pending}
              options={[['full', 'Our price'], ['split', 'Our price + split']]} />
            {draft.settlementModel === 'split' && (
              <TextField kind="transfer" name="excessSplitPct" label="Our share of the excess %" numeric
                value={draft.excessSplitPct} onChange={(v) => set('excessSplitPct', v)} disabled={pending} />
            )}
          </Row>
        </>
      )}

      <Row>
        <TextField kind="transfer" name="agentPrice" label="Our price" numeric
          value={editing ? (edit.agentPrice ?? '') : draft.agentPrice}
          onChange={(v) => (editing ? setE('agentPrice', v) : set('agentPrice', v))} disabled={pending || closed} />
        {editing && (
          <TextField kind="transfer" name="minimumPrice" label="Minimum" numeric value={edit.minimumPrice ?? ''}
            onChange={(v) => setE('minimumPrice', v)} disabled={pending || closed} />
        )}
        <TextField kind="transfer" name="returnBy" label="Back by" date
          value={editing ? (edit.returnBy ?? '') : draft.returnBy}
          onChange={(v) => (editing ? setE('returnBy', v) : set('returnBy', v))} disabled={pending || closed} />
      </Row>

      <label style={{ ...label, marginTop: 8 }}>Note</label>
      <input data-client-field="transfer.notes" value={editing ? (edit.notes ?? '') : draft.notes}
        disabled={pending || closed}
        onChange={(e) => (editing ? setE('notes', e.target.value) : set('notes', e.target.value))} style={field} />

      {editing && (
        <div data-client-transfer-changes style={{ marginTop: 10, fontSize: 12, opacity: 0.7 }}>
          {changeCount(body) === 0
            ? 'Nothing changed yet — only what you edit is sent.'
            : `Sending only: ${Object.keys(body).filter((k) => k !== 'id' && k !== 'expectedRevision').join(', ')}`}
        </div>
      )}

      <Outcome kind="transfer" outcome={outcome} />
      {/* Der Erfolgsfall hat oben schon eine eigene Ansicht — hier bleibt, was schiefging. */}
      {returnOutcome && <Outcome kind="transfer-return" outcome={returnOutcome} />}

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button data-client-transfer-save disabled={busy || !complete || outcome?.kind === 'business_error'}
          onClick={send} style={btn(true)}>
          {pending ? 'Retry the same attempt' : busy ? 'Saving…' : 'Save'}
        </button>
        {editing && !closed && (
          <button data-client-transfer-return disabled={busy || returnOutcome?.kind === 'business_error'}
            onClick={sendReturn} style={btn(false)}>
            {returnPending ? 'Retry the same return' : 'Item came back'}
          </button>
        )}
        {outcome?.kind === 'business_error' && (
          <button data-client-transfer-restart onClick={() => startOver(true)} style={btn(false)}>
            Start a new attempt
          </button>
        )}
        {onCancel && !pending && !returnPending && (
          <button data-client-transfer-cancel onClick={onCancel} style={btn(false)}>Cancel</button>
        )}
      </div>
    </div>
  );
}
