// CENTRAL-C3E — der Kommissionsbildschirm des zweiten Rechners: anlegen und ändern.
//
// Zwei Dinge machen ihn schwieriger als die anderen beiden:
//
//  1. **Anlegen heißt hier auch: einen Artikel anlegen.** So macht es der Primary, und so bleibt
//     es. Die SKU steht in keinem Feld — sie kommt aus dem durablen Zähler des Primary. Ein
//     Eingabefeld dafür wäre eine Einladung, eine bereits vergebene Nummer zu erzwingen.
//  2. **Das Auszahlungsmodell ist irgendwann gesperrt.** Ob, entscheidet die Domäne, und der
//     Lesevorgang sagt es (`payoutLocked`). Ist es gesperrt, sind seine Felder hier abgeschaltet
//     UND der Änderungsauftrag lässt sie weg — sonst liefe eine reine Notizänderung in die Sperre.
//
// Die Duplikatswarnung ist dieselbe Bedeutung wie am Primary: sie sperrt nicht, sie fragt. Der
// Primary lehnt einen Verdacht zunächst ab; „Create anyway" schickt denselben Auftrag mit der
// bewussten Antwort — und mit einer NEUEN Kennung, denn es ist eine neue Entscheidung.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CommandSaveController, type SaveOutcome } from '@/core/bridge/client-command-save';
import { remoteRead, type RemoteReadError } from '@/core/bridge/remote-read';
import {
  CONSIGNMENT_EDIT_FIELDS, EMPTY_CONSIGNMENT, changeCount, consignmentComplete,
  consignmentCreateRequest, consignmentUpdateRequest, draftOf,
  type ConsignmentDraft, type Draft,
} from '@/core/bridge/client-commercial-request';
import { recordPayoutRequest } from '@/core/bridge/client-financial-request';
import { Outcome, PickField, Row, TextField } from './client-form-atoms';
import { box, btn, field, label, warn } from './client-form-style';

export const OP_CONSIGNMENTS_CREATE = 'consignments.create';
export const OP_CONSIGNMENTS_UPDATE = 'consignments.update';
// CENTRAL-C3G - den Einlieferer auszahlen. Ein ausdruecklicher Betrag, kein Rest-Automatismus:
// der Rest aendert sich zwischen Lesen und Ankommen, und wer Geld auszahlt, meint einen Betrag.
export const OP_CONSIGNMENTS_RECORD_PAYOUT = 'consignments.record_payout';

export interface ConsignmentSaveValue {
  consignmentId: string;
  consignmentNumber: string;
  sku?: string;
  payoutModel: string;
  agreedPrice: number;
  revision: number;
  replayed?: boolean;
}

const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const EDIT_FIELDS = [...CONSIGNMENT_EDIT_FIELDS, 'payoutModel', 'commissionRate', 'excessSplitPct'];

export function ClientConsignmentForm({ consignmentId, onSaved, onCancel, read = remoteRead }: {
  consignmentId?: string;
  onSaved?: (id: string) => void;
  onCancel?: () => void;
  read?: typeof remoteRead;
}) {
  const editing = typeof consignmentId === 'string' && consignmentId !== '';
  const [draft, setDraft] = useState<ConsignmentDraft>(EMPTY_CONSIGNMENT);
  const [base, setBase] = useState<Draft>({});
  const [edit, setEdit] = useState<Draft>({});
  const [revision, setRevision] = useState(0);
  const [payoutLocked, setPayoutLocked] = useState(false);
  const [payoutOpen, setPayoutOpen] = useState(0);
  const [payoutStatus, setPayoutStatus] = useState('');
  const [payoutAmount, setPayoutAmount] = useState('');
  const [payoutMethod, setPayoutMethod] = useState('cash');
  const [payoutOutcome, setPayoutOutcome] = useState<SaveOutcome<{ payoutPaidAmount: number; payoutOpenAmount: number; payoutStatus: string; revision: number; replayed?: boolean }> | null>(null);
  const [payoutBusy, setPayoutBusy] = useState(false);
  const [consignors, setConsignors] = useState<Array<Record<string, unknown>>>([]);
  const [categories, setCategories] = useState<Array<Record<string, unknown>>>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<SaveOutcome<ConsignmentSaveValue> | null>(null);
  // Die bewusste Antwort auf einen Duplikatsverdacht. Sie gilt für GENAU den nächsten Versuch.
  // Kein Formularzustand: die Bestätigung gehört zu GENAU EINEM Klick. Läge sie im Formular,
  // trüge sie der nächste Speicherversuch stillschweigend weiter — und aus einer einmaligen
  // Entscheidung würde eine Einstellung.

  const controller = useMemo(
    () => new CommandSaveController<ConsignmentSaveValue>(editing ? OP_CONSIGNMENTS_UPDATE : OP_CONSIGNMENTS_CREATE),
    [editing],
  );
  // Ein eigener Vorsatz mit eigenem Wächter: eine hängengebliebene Änderung darf niemals als
  // Auszahlung weiterlaufen.
  const payoutController = useMemo(
    () => new CommandSaveController<{ payoutPaidAmount: number; payoutOpenAmount: number; payoutStatus: string; revision: number; replayed?: boolean }>(OP_CONSIGNMENTS_RECORD_PAYOUT),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (editing) {
          const row = await read<Record<string, unknown>>('consignments.get', { id: consignmentId });
          if (cancelled) return;
          const d = draftOf(EDIT_FIELDS, row);
          setBase(d);
          setEdit(d);
          setRevision(Number(row.revision ?? 0));
          setPayoutLocked(row.payoutLocked === true);
          setPayoutOpen(Number(row.payoutOpenAmount ?? 0));
          setPayoutStatus(s(row.payoutStatus));
        }
        const people = await read<{ items: Array<Record<string, unknown>> }>('customers.list', { limit: 500 });
        if (!cancelled) setConsignors(people.items ?? []);
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
  }, [editing, consignmentId, read]);

  // Die Kategorien kommen aus der Autorität, nicht aus einer Ableitung: ein Artikel ohne
  // Kategorie gibt es im Haus nicht, und dieser Rechner hat keine eigene Tabelle dafür.
  useEffect(() => {
    if (editing) return;
    let cancelled = false;
    read<{ items: Array<Record<string, unknown>> }>('categories.list', { limit: 200 })
      .then((list) => { if (!cancelled) setCategories(list.items ?? []); })
      .catch(() => { /* die Auswahl fehlt, das Formular bleibt ehrlich leer */ });
    return () => { cancelled = true; };
  }, [editing, read]);

  const set = (f: keyof ConsignmentDraft, v: string): void => setDraft((p) => ({ ...p, [f]: v }));
  const setE = (f: string, v: string): void => setEdit((p) => ({ ...p, [f]: v }));

  const body = editing
    ? consignmentUpdateRequest(consignmentId!, revision, base, edit, { payoutLocked })
    : consignmentCreateRequest(draft);
  const complete = editing ? changeCount(body) > 0 : consignmentComplete(draft);
  const pending = outcome?.kind === 'unknown';
  const duplicateSuspect = outcome?.kind === 'business_error' && outcome.code === 'POSSIBLE_DUPLICATE';

  const send = useCallback(async (payload: Record<string, unknown>) => {
    setBusy(true);
    try {
      const attempt = controller.beginAttempt();
      setOutcome(await attempt.send(payload));
    } finally {
      setBusy(false);
    }
  }, [controller]);

  /**
   * „Trotzdem anlegen" ist ein NEUER Vorsatz, kein zweiter Versuch desselben.
   *
   * Der Primary hat auf die alte Kennung ein endgültiges Nein gegeben — es steht in seinem
   * Auftragsbuch, und dieselbe Kennung bekäme für immer dieselbe Antwort. Sie mit einem
   * ERWEITERTEN Rumpf zu wiederholen wäre schlimmer: gleiche Kennung, andere Anfrage, also ein
   * Kennungskonflikt — und der Vorgang liefe nie. Deshalb wird der alte Versuch verworfen
   * (`forget`) und der nächste Klick holt sich eine neue Kennung.
   *
   * Und der Knopf SCHICKT auch. Ein Knopf mit der Aufschrift „Create anyway", der nur eine
   * Einstellung setzt und auf einen zweiten Klick wartet, verspricht etwas, das er nicht tut.
   */
  const createAnyway = useCallback(async () => {
    controller.forget();
    setOutcome(null);
    await send(consignmentCreateRequest(draft, true));
  }, [controller, draft, send]);

  function startOver(keepDraft = false): void {
    controller.forget();
    setOutcome(null);
    if (!editing && !keepDraft) setDraft(EMPTY_CONSIGNMENT);
  }

  if (loading) return <div data-client-consignment-loading style={box}>Loading…</div>;

  if (outcome?.kind === 'ok') {
    return (
      <div data-client-consignment-done style={box}>
        <div style={{ fontSize: 18, fontWeight: 600 }}>{editing ? 'Consignment updated' : 'Consignment created'}</div>
        <div data-client-consignment-number style={{ marginTop: 6 }}>{outcome.value.consignmentNumber}</div>
        <div style={{ marginTop: 4, opacity: 0.8 }}>
          {outcome.value.payoutModel}
          {outcome.value.sku ? ` · ${outcome.value.sku}` : ''}
        </div>
        {outcome.replayed && (
          <div data-client-consignment-replayed style={{ marginTop: 8, opacity: 0.8 }}>
            This was the answer to the attempt that had already run — nothing was created twice.
          </div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          {!editing && (
            <button data-client-consignment-again onClick={() => startOver()} style={btn(true)}>
              New consignment
            </button>
          )}
          <button data-client-consignment-back onClick={() => {
            const id = outcome.value.consignmentId;
            startOver();
            onSaved?.(id);
          }} style={btn(editing)}>{editing ? 'Back' : 'Show consignments'}</button>
        </div>
      </div>
    );
  }

  return (
    <div data-client-consignment-form style={box}>
      <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>
        {editing ? 'Edit consignment' : 'New consignment'}
      </div>
      {loadError && <div data-client-consignment-loaderror style={warn}>Cannot reach the server: {loadError}</div>}

      {!editing && (
        <>
          <Row>
            <div style={{ flex: 2 }}>
              <label style={label}>Consignor</label>
              <select data-client-field="consignment.consignorId" value={draft.consignorId} disabled={pending}
                onChange={(e) => set('consignorId', e.target.value)} style={field}>
                <option value="">— choose a client —</option>
                {consignors.map((c) => (
                  <option key={s(c.id)} value={s(c.id)}>
                    {s(c.firstName)} {s(c.lastName)}{s(c.company) ? ` · ${s(c.company)}` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label style={label}>Category</label>
              <select data-client-field="consignment.categoryId" value={draft.categoryId} disabled={pending}
                onChange={(e) => set('categoryId', e.target.value)} style={field}>
                <option value="">— choose —</option>
                {categories.map((c) => <option key={s(c.id)} value={s(c.id)}>{s(c.name)}</option>)}
              </select>
            </div>
          </Row>
          <Row>
            <TextField kind="consignment" name="brand" label="Brand" value={draft.brand}
              onChange={(v) => set('brand', v)} disabled={pending} />
            <TextField kind="consignment" name="name" label="Model" value={draft.name}
              onChange={(v) => set('name', v)} disabled={pending} />
            <TextField kind="consignment" name="condition" label="Condition" value={draft.condition}
              onChange={(v) => set('condition', v)} disabled={pending} />
          </Row>
        </>
      )}

      <Row>
        <TextField kind="consignment" name="agreedPrice" label="Agreed price" numeric
          value={editing ? (edit.agreedPrice ?? '') : draft.agreedPrice}
          onChange={(v) => (editing ? setE('agreedPrice', v) : set('agreedPrice', v))} disabled={pending} />
        <TextField kind="consignment" name="minimumPrice" label="Minimum price" numeric
          value={editing ? (edit.minimumPrice ?? '') : draft.minimumPrice}
          onChange={(v) => (editing ? setE('minimumPrice', v) : set('minimumPrice', v))} disabled={pending} />
        <TextField kind="consignment" name="expiryDate" label="Expires" date
          value={editing ? (edit.expiryDate ?? '') : draft.expiryDate}
          onChange={(v) => (editing ? setE('expiryDate', v) : set('expiryDate', v))} disabled={pending} />
      </Row>

      <Row>
        <PickField kind="consignment" name="payoutModel" label="Payout model"
          value={editing ? (edit.payoutModel ?? 'percent') : draft.payoutModel}
          onChange={(v) => (editing ? setE('payoutModel', v) : set('payoutModel', v))}
          disabled={pending || (editing && payoutLocked)}
          options={[['percent', 'Commission %'], ['consignor_fixed', 'Agreed + excess'], ['cost_split', 'Cost + split']]} />
        {(editing ? edit.payoutModel : draft.payoutModel) === 'percent' && (
          <TextField kind="consignment" name="commissionRate" label="Our share %" numeric
            value={editing ? (edit.commissionRate ?? '') : draft.commissionRate}
            onChange={(v) => (editing ? setE('commissionRate', v) : set('commissionRate', v))}
            disabled={pending || (editing && payoutLocked)} />
        )}
        {(editing ? edit.payoutModel : draft.payoutModel) === 'cost_split' && (
          <TextField kind="consignment" name="excessSplitPct" label="Our share of the profit %" numeric
            value={editing ? (edit.excessSplitPct ?? '') : draft.excessSplitPct}
            onChange={(v) => (editing ? setE('excessSplitPct', v) : set('excessSplitPct', v))}
            disabled={pending || (editing && payoutLocked)} />
        )}
      </Row>

      {editing && payoutLocked && (
        <div data-client-consignment-payoutlocked style={warn}>
          The payout model can no longer be changed — something has already been calculated from it.
        </div>
      )}

      <label style={{ ...label, marginTop: 8 }}>Note</label>
      <input data-client-field="consignment.notes"
        value={editing ? (edit.notes ?? '') : draft.notes} disabled={pending}
        onChange={(e) => (editing ? setE('notes', e.target.value) : set('notes', e.target.value))} style={field} />

      {editing && (
        <div data-client-consignment-payout style={{ marginTop: 16, borderTop: '1px solid rgba(128,128,128,0.3)', paddingTop: 12 }}>
          <div style={{ fontSize: 12, opacity: 0.7 }}>
            Payout · {payoutStatus || 'pending'} · {payoutOpen.toFixed(3)} BHD open
          </div>
          {payoutOpen > 0 ? (
            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              <input data-client-consignment-payout-amount type="number" min={0} step="0.001"
                value={payoutAmount} disabled={payoutOutcome?.kind === 'unknown'}
                onChange={(e) => setPayoutAmount(e.target.value)} style={{ ...field, flex: 1 }} />
              <select data-client-consignment-payout-method value={payoutMethod}
                disabled={payoutOutcome?.kind === 'unknown'}
                onChange={(e) => setPayoutMethod(e.target.value)} style={{ ...field, flex: 1 }}>
                <option value="cash">cash</option>
                <option value="bank">bank</option>
                <option value="benefit">benefit</option>
              </select>
              <button data-client-consignment-payout-save
                disabled={payoutBusy || payoutAmount.trim() === '' || payoutOutcome?.kind === 'business_error'}
                onClick={async () => {
                  setPayoutBusy(true);
                  try {
                    const attempt = payoutController.beginAttempt();
                    const out = await attempt.send(
                      recordPayoutRequest(consignmentId!, revision, payoutAmount, payoutMethod),
                    );
                    setPayoutOutcome(out);
                    if (out.kind === 'ok') {
                      setPayoutOpen(out.value.payoutOpenAmount);
                      setPayoutStatus(out.value.payoutStatus);
                      setPayoutAmount('');
                      // Die neue Fassung uebernehmen — sonst scheitert die naechste Teilzahlung
                      // an einem Stand, den dieser Klick selbst ueberholt hat.
                      setRevision((out.value as unknown as { revision: number }).revision);
                    }
                  } finally { setPayoutBusy(false); }
                }}
                style={{ ...btn(true), marginTop: 0 }}>
                {payoutOutcome?.kind === 'unknown' ? 'Retry the same payout' : 'Pay out'}
              </button>
            </div>
          ) : (
            <div style={{ fontSize: 12, opacity: 0.6, marginTop: 6 }}>
              Nothing to pay out — the amount appears once the item is sold.
            </div>
          )}
          {payoutOutcome?.kind === 'unknown' && (
            <div data-client-consignment-payout-pending style={warn}>
              The outcome is not known — the money may already be out. Retrying checks the same
              attempt instead of paying twice.
            </div>
          )}
          {payoutOutcome?.kind === 'business_error' && (
            <div data-client-consignment-payout-rejected style={warn}>
              {payoutOutcome.code}: {payoutOutcome.message}
            </div>
          )}
          {payoutOutcome?.kind === 'ok' && (
            <div data-client-consignment-payout-done style={{ marginTop: 8, fontSize: 12, opacity: 0.85 }}>
              Paid · {payoutOutcome.value.payoutPaidAmount.toFixed(3)} BHD total
              {payoutOutcome.replayed && ' · this was the answer to the attempt that had already run'}
            </div>
          )}
        </div>
      )}
      {editing && (
        <div data-client-consignment-changes style={{ marginTop: 10, fontSize: 12, opacity: 0.7 }}>
          {changeCount(body) === 0
            ? 'Nothing changed yet — only what you edit is sent.'
            : `Sending only: ${Object.keys(body).filter((k) => k !== 'id' && k !== 'expectedRevision').join(', ')}`}
        </div>
      )}

      <Outcome kind="consignment" outcome={outcome} />

      {duplicateSuspect && (
        <div data-client-consignment-duplicate style={warn}>
          The primary thinks this item may already exist. If it really is a different piece, you can
          create it anyway — that is a new decision and gets a new attempt.
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button data-client-consignment-save disabled={busy || !complete || outcome?.kind === 'business_error'}
          onClick={() => void send(body)} style={btn(true)}>
          {pending ? 'Retry the same attempt' : busy ? 'Saving…' : 'Save'}
        </button>
        {duplicateSuspect && (
          <button data-client-consignment-anyway disabled={busy} onClick={() => void createAnyway()}
            style={btn(false)}>Create anyway</button>
        )}
        {outcome?.kind === 'business_error' && !duplicateSuspect && (
          <button data-client-consignment-restart onClick={() => startOver(true)} style={btn(false)}>
            Start a new attempt
          </button>
        )}
        {onCancel && !pending && (
          <button data-client-consignment-cancel onClick={onCancel} style={btn(false)}>Cancel</button>
        )}
      </div>
    </div>
  );
}
