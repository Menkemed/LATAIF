// CENTRAL-C3E — der Auftragsbildschirm des zweiten Rechners: anlegen und ändern.
//
// Nur der NORMALE Auftrag. Ein Sonderauftrag trägt seinen Preis in einer Angebotszeile, und der
// Bildschirm am Primary schreibt den Kopfpreis dann bewusst nicht — diesen doppelten Vertrag aus
// der Ferne zu bedienen wäre geraten. Der Primary lehnt einen solchen Auftrag ausdrücklich ab, und
// dieses Formular bietet ihn gar nicht erst an.
//
// Zwei Zahlen fehlen hier mit Absicht: der Rest und die Marge. Beide rechnet der Primary — aus dem
// Stand, der NACH der Änderung wirklich gilt. Zwei Rechner, die je ein Feld ändern, kämen sonst zu
// zwei verschiedenen Resten.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CommandSaveController, type SaveOutcome } from '@/core/bridge/client-command-save';
import { remoteRead, type RemoteReadError } from '@/core/bridge/remote-read';
import {
  EMPTY_ORDER, ORDER_EDIT_FIELDS, changeCount, draftOf, orderComplete, orderCreateRequest,
  orderUpdateRequest, previewTotal, type Draft, type DraftLine, type OrderDraft,
} from '@/core/bridge/client-commercial-request';
import { LineEditor, Outcome, PickField, Row, TextField } from './client-form-atoms';
import { box, btn, field, label, warn } from './client-form-style';

export const OP_ORDERS_CREATE = 'orders.create';
export const OP_ORDERS_UPDATE = 'orders.update';

export interface OrderSaveValue {
  orderId: string;
  orderNumber: string;
  agreedPrice: number | null;
  remainingAmount: number;
  paidAmount: number;
  revision: number;
  replayed?: boolean;
}

const fmt = (v: number): string => v.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

export function ClientOrderForm({ orderId, onSaved, onCancel, read = remoteRead }: {
  orderId?: string;
  onSaved?: (id: string) => void;
  onCancel?: () => void;
  read?: typeof remoteRead;
}) {
  const editing = typeof orderId === 'string' && orderId !== '';
  const [draft, setDraft] = useState<OrderDraft>(EMPTY_ORDER);
  const [lines, setLines] = useState<DraftLine[]>([{ productId: '', quantity: '1', unitPrice: '' }]);
  const [base, setBase] = useState<Draft>({});
  const [edit, setEdit] = useState<Draft>({});
  const [revision, setRevision] = useState(0);
  const [orderType, setOrderType] = useState('normal');
  const [customers, setCustomers] = useState<Array<Record<string, unknown>>>([]);
  const [products, setProducts] = useState<Array<Record<string, unknown>>>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<SaveOutcome<OrderSaveValue> | null>(null);

  const controller = useMemo(
    () => new CommandSaveController<OrderSaveValue>(editing ? OP_ORDERS_UPDATE : OP_ORDERS_CREATE),
    [editing],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (editing) {
          const row = await read<Record<string, unknown>>('orders.get', { id: orderId });
          if (cancelled) return;
          const d = draftOf(ORDER_EDIT_FIELDS, row);
          setBase(d);
          setEdit(d);
          setRevision(Number(row.revision ?? 0));
          setOrderType(s(row.type) || 'normal');
        } else {
          const [people, prod] = await Promise.all([
            read<{ items: Array<Record<string, unknown>> }>('customers.list', { limit: 500 }),
            read<{ items: Array<Record<string, unknown>> }>('products.list', { limit: 500 }),
          ]);
          if (cancelled) return;
          setCustomers(people.items ?? []);
          setProducts(prod.items ?? []);
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
  }, [editing, orderId, read]);

  const set = (f: keyof OrderDraft, v: string): void => setDraft((p) => ({ ...p, [f]: v }));
  const setE = (f: string, v: string): void => setEdit((p) => ({ ...p, [f]: v }));

  const body = editing ? orderUpdateRequest(orderId!, revision, base, edit) : orderCreateRequest(draft, lines);
  const custom = editing && orderType !== 'normal';
  const complete = editing ? (changeCount(body) > 0 && !custom) : orderComplete(draft, lines);
  const pending = outcome?.kind === 'unknown';

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
    if (!editing && !keepDraft) {
      setDraft(EMPTY_ORDER);
      setLines([{ productId: '', quantity: '1', unitPrice: '' }]);
    }
  }

  if (loading) return <div data-client-order-loading style={box}>Loading…</div>;

  if (outcome?.kind === 'ok') {
    return (
      <div data-client-order-done style={box}>
        <div style={{ fontSize: 18, fontWeight: 600 }}>{editing ? 'Order updated' : 'Order created'}</div>
        <div data-client-order-number style={{ marginTop: 6 }}>{outcome.value.orderNumber}</div>
        <div style={{ marginTop: 4, opacity: 0.8 }}>
          {fmt(outcome.value.agreedPrice ?? 0)} BHD · paid {fmt(outcome.value.paidAmount)}
          {' · '}open {fmt(outcome.value.remainingAmount)}
        </div>
        {outcome.replayed && (
          <div data-client-order-replayed style={{ marginTop: 8, opacity: 0.8 }}>
            This was the answer to the attempt that had already run — nothing was created twice.
          </div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          {!editing && (
            <button data-client-order-again onClick={() => startOver()} style={btn(true)}>New order</button>
          )}
          <button data-client-order-back onClick={() => {
            const id = outcome.value.orderId;
            startOver();
            onSaved?.(id);
          }} style={btn(editing)}>{editing ? 'Back' : 'Show orders'}</button>
        </div>
      </div>
    );
  }

  return (
    <div data-client-order-form style={box}>
      <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>{editing ? 'Edit order' : 'New order'}</div>
      {loadError && <div data-client-order-loaderror style={warn}>Cannot reach the server: {loadError}</div>}

      {custom && (
        <div data-client-order-custom style={warn}>
          This is a {orderType} order — its price lives in a quote line. It can only be changed on the
          primary machine.
        </div>
      )}

      {!editing && (
        <>
          <Row>
            <div style={{ flex: 2 }}>
              <label style={label}>Client</label>
              <select data-client-field="order.customerId" value={draft.customerId} disabled={pending}
                onChange={(e) => set('customerId', e.target.value)} style={field}>
                <option value="">— choose a client —</option>
                {customers.map((c) => (
                  <option key={s(c.id)} value={s(c.id)}>
                    {s(c.firstName)} {s(c.lastName)}{s(c.company) ? ` · ${s(c.company)}` : ''}
                  </option>
                ))}
              </select>
            </div>
            <TextField kind="order" name="expectedDelivery" label="Expected" date
              value={draft.expectedDelivery} onChange={(v) => set('expectedDelivery', v)} disabled={pending} />
          </Row>

          <LineEditor kind="order" lines={lines} setLines={setLines} products={products} disabled={!!pending} />

          <Row>
            <TextField kind="order" name="depositAmount" label="Deposit" numeric
              value={draft.depositAmount} onChange={(v) => set('depositAmount', v)} disabled={pending} />
            <PickField kind="order" name="paymentMethod" label="Method" value={draft.paymentMethod}
              onChange={(v) => set('paymentMethod', v)} disabled={pending}
              options={[['cash', 'Cash'], ['bank', 'Bank'], ['card', 'Card'], ['benefit', 'Benefit']]} />
            {draft.paymentMethod === 'card' && (
              <PickField kind="order" name="cardBrand" label="Card" value={draft.cardBrand}
                onChange={(v) => set('cardBrand', v)} disabled={pending}
                options={[['normal', 'Normal'], ['amex', 'Amex']]} />
            )}
          </Row>
        </>
      )}

      {editing && (
        <Row>
          <TextField kind="order" name="agreedPrice" label="Agreed price" numeric
            value={edit.agreedPrice ?? ''} onChange={(v) => setE('agreedPrice', v)} disabled={pending || custom} />
          <TextField kind="order" name="depositAmount" label="Deposit" numeric
            value={edit.depositAmount ?? ''} onChange={(v) => setE('depositAmount', v)} disabled={pending || custom} />
          <TextField kind="order" name="expectedDelivery" label="Expected" date
            value={edit.expectedDelivery ?? ''} onChange={(v) => setE('expectedDelivery', v)} disabled={pending || custom} />
        </Row>
      )}

      <Row>
        <TextField kind="order" name="supplierName" label="Supplier"
          value={editing ? (edit.supplierName ?? '') : draft.supplierName}
          onChange={(v) => (editing ? setE('supplierName', v) : set('supplierName', v))}
          disabled={pending || custom} />
        <TextField kind="order" name="supplierPrice" label="Supplier price" numeric
          value={editing ? (edit.supplierPrice ?? '') : draft.supplierPrice}
          onChange={(v) => (editing ? setE('supplierPrice', v) : set('supplierPrice', v))}
          disabled={pending || custom} />
      </Row>

      <label style={{ ...label, marginTop: 8 }}>Note</label>
      <input data-client-field="order.notes" value={editing ? (edit.notes ?? '') : draft.notes}
        disabled={pending || custom}
        onChange={(e) => (editing ? setE('notes', e.target.value) : set('notes', e.target.value))} style={field} />

      {!editing && (
        <div data-client-order-preview style={{ marginTop: 12, fontSize: 13, opacity: 0.75 }}>
          {fmt(previewTotal(lines))} BHD — the primary calculates the real total, the remainder and the margin.
        </div>
      )}
      {editing && (
        <div data-client-order-changes style={{ marginTop: 10, fontSize: 12, opacity: 0.7 }}>
          {changeCount(body) === 0
            ? 'Nothing changed yet — only what you edit is sent.'
            : `Sending only: ${Object.keys(body).filter((k) => k !== 'id' && k !== 'expectedRevision').join(', ')}`}
        </div>
      )}

      <Outcome kind="order" outcome={outcome} />

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button data-client-order-save disabled={busy || !complete || outcome?.kind === 'business_error'}
          onClick={send} style={btn(true)}>
          {pending ? 'Retry the same attempt' : busy ? 'Saving…' : 'Save'}
        </button>
        {outcome?.kind === 'business_error' && (
          <button data-client-order-restart onClick={() => startOver(true)} style={btn(false)}>
            Start a new attempt
          </button>
        )}
        {onCancel && !pending && (
          <button data-client-order-cancel onClick={onCancel} style={btn(false)}>Cancel</button>
        )}
      </div>
    </div>
  );
}
