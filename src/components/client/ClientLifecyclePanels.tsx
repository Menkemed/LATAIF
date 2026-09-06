// CENTRAL-C3H — die fünf Lebenszyklus-Tafeln des zweiten Rechners.
//
// Jede hängt an EINEM Vorgang, liest ihn beim Primary (`….get`) und bietet genau die Handlungen
// an, die dort auch wirklich gehen. Was „wirklich geht", entscheidet dabei nicht diese Datei:
// `nextStatus` und `allowedStatusTargets` kommen aus der Antwort des Primary, aus derselben
// Ableitung, gegen die er beim Schreiben ein zweites Mal prüft. Ein Client, der sich seine eigene
// Reihenfolge ausdächte, böte Knöpfe an, die sofort abgewiesen werden.
//
// Gerechnet wird hier nichts: offene Beträge, zurückgebbare Mengen, Auszahlungsstände und
// Kostensummen kommen fertig vom Primary. Diese Tafeln zeigen sie und schicken eine Auswahl
// zurück.
//
// Nach JEDER erfolgreichen Handlung wird neu geladen. Das ist nicht Bequemlichkeit: eine
// Reparatur, deren Arbeitszeile gerade dazukam, hat eine neue Fassung, und die nächste Handlung
// muss sie nennen. In C3G FINAL war genau das der Befund — die Formulare trugen weiter die alte.

import { useCallback, useEffect, useState } from 'react';
import { remoteRead, type RemoteReadError } from '@/core/bridge/remote-read';
import {
  addOrderPaymentRequest, addRepairLineRequest, approveReturnRequest, cancelRepairLineRequest,
  consignmentReturnRequest, convertTransferRequest, createReturnRequest, deleteOrderPaymentRequest,
  orderStatusRequest, recordRefundPaymentRequest, recordSaleRequest, refundReturnRequest,
  repairInvoiceRequest, repairStatusRequest, returnLineCount, updateRepairLineRequest,
  type ReturnDraftLine,
} from '@/core/bridge/client-lifecycle-request';
import { ClientAction, type ActionValue } from './client-action-panel';
import { useState as useFlashState } from 'react';
import { PickField, Row, TextField } from './client-form-atoms';
import { box, field, label, warn } from './client-form-style';

const fmt = (v: number): string => v.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const n = (v: unknown): number => Number(v ?? 0);

type Row0 = Record<string, unknown>;

/** Laden, neu laden, Ladefehler — für alle fünf Tafeln dasselbe. */
function useRemoteRecord(op: string, id: string, read: typeof remoteRead) {
  const [row, setRow] = useState<Row0 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((k) => k + 1), []);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await read<Row0>(op, { id });
        if (!cancelled) { setRow(r); setError(null); }
      } catch (e) {
        if (cancelled) return;
        const err = e as RemoteReadError;
        setError(err?.code ? `${err.code}: ${err.message}` : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [op, id, read, tick]);
  return { row, error, reload };
}

/**
 * Die Bestaetigungen einer Tafel. Sie gehoeren IHR, nicht den Knoepfen: eine Handlung, die den
 * Vorgang weiterschaltet, laesst ihren eigenen Knopf verschwinden — und mit ihm seine Antwort.
 */
function useFlash(): [Record<string, string>, (kind: string, replayed: boolean) => void] {
  const [flash, setFlash] = useFlashState<Record<string, string>>({});
  const note = useCallback((kind: string, replayed: boolean) => {
    setFlash((p) => ({
      ...p,
      [kind]: replayed ? 'Already done — this was the same attempt, not a second one.' : 'Done.',
    }));
  }, [setFlash]);
  return [flash, note];
}

function Flash({ flash }: { flash: Record<string, string> }) {
  const keys = Object.keys(flash);
  if (keys.length === 0) return null;
  return (
    <div style={{ marginTop: 8 }}>
      {keys.map((k) => (
        <div key={k} data-client-done={k} style={{ fontSize: 12, opacity: 0.85 }}>
          {k}: {flash[k]}
        </div>
      ))}
    </div>
  );
}

function Head({ kind, title, sub }: { kind: string; title: string; sub?: string }) {
  return (
    <div style={{ marginBottom: 4 }}>
      <div data-client-panel={kind} style={{ fontSize: 15, fontWeight: 600 }}>{title}</div>
      {sub ? <div style={{ opacity: 0.75, marginTop: 2 }}>{sub}</div> : null}
    </div>
  );
}

// ══ 1) Die Rückgabe-Kette an einer Rechnung ═══════════════════════════════

export function ClientReturnPanel({ invoiceId, read = remoteRead, onChanged }: {
  invoiceId: string; read?: typeof remoteRead; onChanged?: () => void;
}) {
  const { row, error, reload } = useRemoteRecord('invoices.get', invoiceId, read);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [disposition, setDisposition] = useState('IN_STOCK');
  const [refundMethod, setRefundMethod] = useState('bank');
  const [reason, setReason] = useState('');
  const [refundAmount, setRefundAmount] = useState<Record<string, string>>({});
  const [payMethod, setPayMethod] = useState<Record<string, string>>({});
  const [deductFee, setDeductFee] = useState<Record<string, boolean>>({});

  const [flash, note] = useFlash();
  // Erst merken, DASS es geklappt hat — dann neu laden. Die Reihenfolge ist der ganze Punkt:
  // das Neuladen laesst den Knopf verschwinden.
  const doneOf = useCallback((kind: string) => (v: ActionValue, replayed: boolean) => {
    note(kind, replayed);
    void v;
    reload();
    onChanged?.();
  }, [note, reload, onChanged]);

  if (error) return <div data-client-return-error style={warn}>{error}</div>;
  if (!row) return <div data-client-return-loading style={box}>Loading…</div>;

  const lines = (row.lines as Row0[] | undefined) ?? [];
  const returns = (row.returns as Row0[] | undefined) ?? [];
  const revision = n(row.revision);
  const draft: ReturnDraftLine[] = lines.map((l) => ({ invoiceLineId: s(l.id), quantity: qty[s(l.id)] ?? '' }));
  const createBody = () => createReturnRequest(invoiceId, revision, draft, {
    refundMethod, productDisposition: disposition, reason,
  });
  const nothingPicked = returnLineCount(createBody()) === 0;

  return (
    <div data-client-returns style={{ marginTop: 20 }}>
      <Head kind="returns" title="Returns"
        sub={`${s(row.invoiceNumber)} · the primary says how much of each line may still come back`} />
      <Flash flash={flash} />

      {lines.map((l) => {
        const id = s(l.id);
        const left = n(l.returnableQuantity);
        return (
          <div key={id} data-client-return-line={id} style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginTop: 6 }}>
            <div style={{ flex: 2 }}>
              <label style={label}>{s(l.description) || s(l.productId)}</label>
              <div style={{ opacity: 0.75 }}>
                sold {n(l.quantity)} · returned {n(l.returnedQuantity)} ·{' '}
                <b data-client-return-left={id}>{left}</b> left · {fmt(n(l.lineTotal))} BHD
              </div>
            </div>
            <div style={{ flex: 1 }}>
              <input data-client-return-qty={id} type="number" min={0} max={left} step="1"
                value={qty[id] ?? ''} disabled={left <= 0}
                placeholder={left > 0 ? `up to ${left}` : 'nothing left'}
                onChange={(e) => setQty((p) => ({ ...p, [id]: e.target.value }))} style={field} />
            </div>
          </div>
        );
      })}

      <Row>
        <PickField kind="return" name="disposition" label="The goods" value={disposition}
          onChange={setDisposition} options={[
            ['IN_STOCK', 'Back into stock'],
            ['KEEP_AS_OWN', 'Keep as our own'],
            ['WRITE_OFF', 'Write off'],
            ['RETURN_TO_OWNER', 'Back to the owner'],
          ]} />
        <PickField kind="return" name="method" label="Refund as" value={refundMethod}
          onChange={setRefundMethod} options={[
            ['bank', 'Bank'], ['cash', 'Cash'], ['benefit', 'Benefit'],
            ['card', 'Card'], ['credit', 'Store credit'], ['other', 'Other'],
          ]} />
      </Row>
      <Row>
        <TextField kind="return" name="reason" label="Reason" value={reason} onChange={setReason} />
      </Row>
      {/* Der Preis fehlt hier mit Absicht: er steht auf der Rechnung, und das Haus rechnet ihn. */}
      <ClientAction op="returns.create" kind="return.create" label="Create return"
        body={createBody} disabled={nothingPicked} onDone={doneOf('return.create')} />

      {returns.map((r) => {
        const rid = s(r.id);
        const rrev = n(r.revision);
        const open = n(r.refundOpenAmount);
        return (
          <div key={rid} data-client-return={rid} style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid rgba(128,128,128,0.25)' }}>
            <Head kind={`return.${rid}`} title={s(r.returnNumber)}
              sub={`${s(r.status)} · ${s(r.refundStatus)} · ${fmt(n(r.totalAmount))} BHD · paid ${fmt(n(r.refundPaidAmount))} · open ${fmt(open)}`} />
            {s(r.status) === 'REQUESTED' && (
              <ClientAction op="returns.approve" kind={`return.approve.${rid}`} label="Approve"
                body={() => approveReturnRequest(rid, rrev)} onDone={doneOf(`return.approve.${rid}`)} />
            )}
            {s(r.refundStatus) !== 'REFUNDED' && (
              <>
                <ClientAction op="returns.refund" kind={`return.refund.${rid}`} label="Refund"
                  body={() => refundReturnRequest(rid, rrev, refundAmount[rid] ?? '')}
                  disabled={!(Number(refundAmount[rid] ?? 0) > 0)} onDone={doneOf(`return.refund.${rid}`)}>
                  <Row>
                    <div style={{ flex: 1 }}>
                      <label style={label}>Refund amount</label>
                      <input data-client-refund-amount={rid} type="number" min={0} step="0.001"
                        value={refundAmount[rid] ?? ''}
                        onChange={(e) => setRefundAmount((p) => ({ ...p, [rid]: e.target.value }))}
                        style={field} />
                    </div>
                  </Row>
                </ClientAction>
                <ClientAction op="returns.record_refund_payment" kind={`return.pay.${rid}`}
                  label="Record the payout"
                  body={() => recordRefundPaymentRequest(rid, rrev, refundAmount[rid] ?? '',
                    payMethod[rid] ?? s(r.refundMethod) ?? 'bank', { deductCardFee: deductFee[rid] })}
                  disabled={!(Number(refundAmount[rid] ?? 0) > 0)} onDone={doneOf(`return.pay.${rid}`)}>
                  <Row>
                    <PickField kind="refundpay" name={`method.${rid}`} label="Paid by"
                      value={payMethod[rid] ?? s(r.refundMethod) ?? 'bank'}
                      onChange={(v) => setPayMethod((p) => ({ ...p, [rid]: v }))}
                      options={[['bank', 'Bank'], ['cash', 'Cash'], ['benefit', 'Benefit'],
                        ['card', 'Card'], ['credit', 'Store credit'], ['other', 'Other']]} />
                    <div style={{ flex: 1, alignSelf: 'flex-end' }}>
                      <label style={{ ...label, display: 'flex', gap: 6, alignItems: 'center' }}>
                        <input data-client-refund-fee={rid} type="checkbox"
                          checked={!!deductFee[rid]}
                          onChange={(e) => setDeductFee((p) => ({ ...p, [rid]: e.target.checked }))} />
                        The client carries the card fee
                      </label>
                    </div>
                  </Row>
                </ClientAction>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ══ 2) Der Auftrag: Status und Anzahlungen ════════════════════════════════

export function ClientOrderLifecycle({ orderId, read = remoteRead, onChanged }: {
  orderId: string; read?: typeof remoteRead; onChanged?: () => void;
}) {
  const { row, error, reload } = useRemoteRecord('orders.get', orderId, read);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('cash');
  const [reference, setReference] = useState('');
  const [flash, note] = useFlash();
  // Erst merken, DASS es geklappt hat — dann neu laden. Die Reihenfolge ist der ganze Punkt:
  // das Neuladen laesst den Knopf verschwinden.
  const doneOf = useCallback((kind: string) => (v: ActionValue, replayed: boolean) => {
    note(kind, replayed);
    void v;
    reload();
    onChanged?.();
  }, [note, reload, onChanged]);

  if (error) return <div data-client-order-lifecycle-error style={warn}>{error}</div>;
  if (!row) return <div data-client-order-lifecycle-loading style={box}>Loading…</div>;

  const revision = n(row.revision);
  const next = s(row.nextStatus);
  const invoiced = s(row.invoiceId) !== '';
  const payments = (row.payments as Row0[] | undefined) ?? [];

  return (
    <div data-client-order-lifecycle style={{ marginTop: 20 }}>
      <Head kind="order" title={`${s(row.orderNumber)} · ${s(row.status)}`}
        sub={`agreed ${fmt(n(row.agreedPrice))} · paid ${fmt(n(row.paidAmount))} · open ${fmt(n(row.remainingAmount))} BHD`} />
      <Flash flash={flash} />

      {next ? (
        <ClientAction op="orders.update_status" kind="order.status" label={`Advance to ${next}`}
          body={() => orderStatusRequest(orderId, revision, next)} onDone={doneOf('order.status')} />
      ) : (
        <div data-client-order-terminal style={{ opacity: 0.7, marginTop: 8 }}>
          This order has no next step — it is finished or cancelled.
        </div>
      )}

      {!invoiced && (
        <ClientAction op="orders.add_payment" kind="order.pay" label="Record a deposit"
          body={() => addOrderPaymentRequest(orderId, revision, amount, method, { reference })}
          disabled={!(Number(amount) > 0)}
          onDone={(v, r) => { setAmount(''); setReference(''); doneOf('order.pay')(v, r); }}>
          <Row>
            <div style={{ flex: 1 }}>
              <label style={label}>Amount</label>
              <input data-client-order-pay-amount type="number" min={0} step="0.001" value={amount}
                onChange={(e) => setAmount(e.target.value)} style={field} />
            </div>
            <PickField kind="orderpay" name="method" label="Method" value={method} onChange={setMethod}
              options={[['cash', 'Cash'], ['card', 'Card'], ['bank', 'Bank'], ['benefit', 'Benefit'], ['other', 'Other']]} />
            <TextField kind="orderpay" name="reference" label="Reference" value={reference} onChange={setReference} />
          </Row>
        </ClientAction>
      )}

      {payments.map((p) => {
        const pid = s(p.id);
        return (
          <div key={pid} data-client-order-payment={pid} style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
            <div style={{ flex: 1 }}>
              {fmt(n(p.amount))} BHD · {s(p.method)} · {s(p.paidAt)}
              {p.convertedToInvoice ? ' · moved to the invoice' : ''}
            </div>
            {p.deletable ? (
              <ClientAction op="orders.delete_payment" kind={`order.delpay.${pid}`} label="Remove"
                body={() => deleteOrderPaymentRequest(orderId, pid, revision)} onDone={doneOf(`order.delpay.${pid}`)} />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

// ══ 3) Die Kommission: Verkauf und Rückgabe ═══════════════════════════════

export function ClientConsignmentLifecycle({ consignmentId, read = remoteRead, onChanged }: {
  consignmentId: string; read?: typeof remoteRead; onChanged?: () => void;
}) {
  const { row, error, reload } = useRemoteRecord('consignments.get', consignmentId, read);
  const [buyers, setBuyers] = useState<Row0[]>([]);
  const [buyerId, setBuyerId] = useState('');
  const [salePrice, setSalePrice] = useState('');
  const [flash, note] = useFlash();
  // Erst merken, DASS es geklappt hat — dann neu laden. Die Reihenfolge ist der ganze Punkt:
  // das Neuladen laesst den Knopf verschwinden.
  const doneOf = useCallback((kind: string) => (v: ActionValue, replayed: boolean) => {
    note(kind, replayed);
    void v;
    reload();
    onChanged?.();
  }, [note, reload, onChanged]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await read<{ items: Row0[] }>('customers.list', { limit: 500 });
        if (!cancelled) setBuyers(r.items ?? []);
      } catch { /* die Tafel bleibt bedienbar; der Primary weist einen unbekannten Käufer ab */ }
    })();
    return () => { cancelled = true; };
  }, [read]);

  if (error) return <div data-client-consignment-lifecycle-error style={warn}>{error}</div>;
  if (!row) return <div data-client-consignment-lifecycle-loading style={box}>Loading…</div>;

  const revision = n(row.revision);
  const active = s(row.status) === 'active';
  // Der Einlieferer kann nicht sein eigener Käufer sein — das wäre eine Rücknahme, kein Verkauf.
  const options: Array<[string, string]> = [['', '— pick the buyer —'], ...buyers
    .filter((c) => s(c.id) !== s(row.consignorId))
    .map((c) => [s(c.id), s(c.name) || s(c.id)] as [string, string])];

  return (
    <div data-client-consignment-lifecycle style={{ marginTop: 20 }}>
      <Head kind="consignment" title={`${s(row.consignmentNumber)} · ${s(row.status)}`}
        sub={`agreed ${fmt(n(row.agreedPrice))} BHD · ${s(row.payoutModel)}`} />
      <Flash flash={flash} />

      {active ? (
        <>
          <ClientAction op="consignments.record_sale" kind="consignment.sale" label="Record the sale"
            body={() => recordSaleRequest(consignmentId, revision, buyerId, salePrice)}
            disabled={buyerId === '' || !(Number(salePrice) > 0)}
            onDone={doneOf('consignment.sale')}
            confirm={{
              // GENAU dieses Urteil, kein anderes: der Verkauf liegt unter dem Boden des
              // Einlieferers und erzeugt einen Verlust. Wer das will, sagt es ausdrücklich —
              // mit einem NEUEN Versuch, nicht mit demselben unter geändertem Rumpf.
              codes: ['SALE_BELOW_FLOOR'],
              label: 'Sell anyway and book the shortfall',
              body: () => recordSaleRequest(consignmentId, revision, buyerId, salePrice, { acknowledgeShortfall: true }),
            }}>
            <Row>
              <PickField kind="sale" name="buyer" label="Buyer" value={buyerId} onChange={setBuyerId} options={options} />
              <div style={{ flex: 1 }}>
                <label style={label}>Sale price</label>
                <input data-client-sale-price type="number" min={0} step="0.001" value={salePrice}
                  onChange={(e) => setSalePrice(e.target.value)} style={field} />
              </div>
            </Row>
          </ClientAction>
          <ClientAction op="consignments.mark_returned" kind="consignment.return"
            label="Handed back unsold"
            body={() => consignmentReturnRequest(consignmentId, revision)} onDone={doneOf('consignment.return')} />
        </>
      ) : (
        <div data-client-consignment-closed style={{ opacity: 0.7, marginTop: 8 }}>
          This consignment is “{s(row.status)}” — a sale or a hand-back is not possible from here.
          {s(row.payoutOpenAmount) !== '0' && n(row.payoutOpenAmount) > 0
            ? ` The payout of ${fmt(n(row.payoutOpenAmount))} BHD is still open.` : ''}
        </div>
      )}
    </div>
  );
}

// ══ 4) Die Reparatur: Status, Arbeitszeilen, Rechnung ═════════════════════

export function ClientRepairLifecycle({ repairId, read = remoteRead, onChanged }: {
  repairId: string; read?: typeof remoteRead; onChanged?: () => void;
}) {
  const { row, error, reload } = useRemoteRecord('repairs.get', repairId, read);
  const [suppliers, setSuppliers] = useState<Row0[]>([]);
  const [newLine, setNewLine] = useState<Record<string, string>>({ costAmount: '', supplierId: '', workType: 'labor', description: '' });
  const [editLine, setEditLine] = useState<string | null>(null);
  const [lineBase, setLineBase] = useState<Record<string, string>>({});
  const [lineDraft, setLineDraft] = useState<Record<string, string>>({});
  const [flash, note] = useFlash();
  // Erst merken, DASS es geklappt hat — dann neu laden. Die Reihenfolge ist der ganze Punkt:
  // das Neuladen laesst den Knopf verschwinden.
  const doneOf = useCallback((kind: string) => (v: ActionValue, replayed: boolean) => {
    note(kind, replayed);
    void v;
    reload();
    onChanged?.();
  }, [note, reload, onChanged]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await read<{ items: Row0[] }>('suppliers.list', { limit: 500 });
        if (!cancelled) setSuppliers(r.items ?? []);
      } catch { /* die Zeile geht auch ohne Lieferanten — dann ohne Verbindlichkeit */ }
    })();
    return () => { cancelled = true; };
  }, [read]);

  if (error) return <div data-client-repair-lifecycle-error style={warn}>{error}</div>;
  if (!row) return <div data-client-repair-lifecycle-loading style={box}>Loading…</div>;

  const revision = n(row.revision);
  const targets = (row.allowedStatusTargets as string[] | undefined) ?? [];
  const lines = (row.lines as Row0[] | undefined) ?? [];
  const invoiced = s(row.invoiceId) !== '';
  const supplierOptions: Array<[string, string]> = [['', '— no supplier —'],
    ...suppliers.map((x) => [s(x.id), s(x.name) || s(x.id)] as [string, string])];
  const workOptions: Array<[string, string]> = [
    ['labor', 'Labor'], ['polish', 'Polish'], ['plating', 'Plating'],
    ['parts', 'Parts'], ['other', 'Other'],
  ];

  return (
    <div data-client-repair-lifecycle style={{ marginTop: 20 }}>
      <Head kind="repair" title={`${s(row.repairNumber)} · ${s(row.status)}`}
        sub={`own cost ${fmt(n(row.internalCost))} · work lines ${fmt(n(row.openLineTotal))} · charge ${fmt(n(row.chargeToCustomer))} BHD`} />
      <Flash flash={flash} />

      {targets.length === 0 && (
        <div data-client-repair-terminal style={{ opacity: 0.7, marginTop: 8 }}>
          This repair is finished — no further step is possible.
        </div>
      )}
      {targets.map((t) => (
        <ClientAction key={t} op="repairs.update_status" kind={`repair.status.${t}`}
          label={`Mark as ${t.replace(/_/g, ' ')}`}
          body={() => repairStatusRequest(repairId, revision, t)} onDone={doneOf(`repair.status.${t}`)} />
      ))}

      {!invoiced && (
        <ClientAction op="repairs.add_line" kind="repair.addline" label="Add a work line"
          body={() => addRepairLineRequest(repairId, revision, newLine)}
          disabled={!(Number(newLine.costAmount) > 0)}
          onDone={(v, r) => { setNewLine({ costAmount: '', supplierId: '', workType: 'labor', description: '' }); doneOf('repair.addline')(v, r); }}>
          <Row>
            <div style={{ flex: 1 }}>
              <label style={label}>Cost</label>
              <input data-client-repair-line-cost type="number" min={0} step="0.001"
                value={newLine.costAmount}
                onChange={(e) => setNewLine((p) => ({ ...p, costAmount: e.target.value }))} style={field} />
            </div>
            <PickField kind="repairline" name="supplier" label="Workshop" value={newLine.supplierId}
              onChange={(v) => setNewLine((p) => ({ ...p, supplierId: v }))} options={supplierOptions} />
            <PickField kind="repairline" name="worktype" label="Work" value={newLine.workType}
              onChange={(v) => setNewLine((p) => ({ ...p, workType: v }))} options={workOptions} />
          </Row>
          <Row>
            <TextField kind="repairline" name="description" label="Description"
              value={newLine.description}
              onChange={(v) => setNewLine((p) => ({ ...p, description: v }))} />
          </Row>
        </ClientAction>
      )}

      {lines.map((l) => {
        const lid = s(l.id);
        const editingThis = editLine === lid;
        return (
          <div key={lid} data-client-repair-line={lid} style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              {fmt(n(l.costAmount))} BHD · {s(l.workType) || '—'} · {s(l.status)}
              {l.editable ? '' : ' · frozen (payment booked)'}
            </div>
            {!!l.editable && !invoiced && !editingThis && (
              <button data-client-repair-line-edit={lid} onClick={() => {
                const base = { costAmount: s(l.costAmount), supplierId: s(l.supplierId), workType: s(l.workType), description: '', dueDate: '', notes: '' };
                setLineBase(base); setLineDraft(base); setEditLine(lid);
              }} style={{ padding: '4px 10px', borderRadius: 999, cursor: 'pointer', border: '1px solid rgba(128,128,128,0.4)', background: 'transparent', color: 'inherit' }}>Edit</button>
            )}
            {editingThis && (
              <ClientAction op="repairs.update_line" kind={`repair.editline.${lid}`} label="Save the line"
                body={() => updateRepairLineRequest(repairId, lid, revision, lineBase, lineDraft)}
                onDone={(v, r) => { setEditLine(null); doneOf(`repair.editline.${lid}`)(v, r); }}>
                <Row>
                  <div style={{ flex: 1 }}>
                    <label style={label}>Cost</label>
                    <input data-client-repair-line-newcost={lid} type="number" min={0} step="0.001"
                      value={lineDraft.costAmount ?? ''}
                      onChange={(e) => setLineDraft((p) => ({ ...p, costAmount: e.target.value }))} style={field} />
                  </div>
                  <PickField kind="repairlineedit" name={`supplier.${lid}`} label="Workshop"
                    value={lineDraft.supplierId ?? ''}
                    onChange={(v) => setLineDraft((p) => ({ ...p, supplierId: v }))} options={supplierOptions} />
                </Row>
              </ClientAction>
            )}
            {!!l.editable && !invoiced && (
              <ClientAction op="repairs.cancel_line" kind={`repair.cancelline.${lid}`} label="Remove"
                body={() => cancelRepairLineRequest(repairId, lid, revision)} onDone={doneOf(`repair.cancelline.${lid}`)} />
            )}
          </div>
        );
      })}

      {!invoiced && n(row.chargeToCustomer) > 0 && s(row.repairScope) !== 'OWN' && (
        <ClientAction op="repairs.create_invoice" kind="repair.invoice" label="Create the invoice"
          body={() => repairInvoiceRequest(repairId, revision)} onDone={doneOf('repair.invoice')} />
      )}
      {invoiced && (
        <div data-client-repair-invoiced style={{ opacity: 0.75, marginTop: 8 }}>
          Invoiced — its cost lines are frozen.
        </div>
      )}
    </div>
  );
}

// ══ 5) Der Agenten-Transfer → Rechnung ════════════════════════════════════

export function ClientTransferInvoicePanel({ transferId, read = remoteRead, onChanged }: {
  transferId: string; read?: typeof remoteRead; onChanged?: () => void;
}) {
  const { row, error, reload } = useRemoteRecord('transfers.get', transferId, read);
  const [customers, setCustomers] = useState<Row0[]>([]);
  const [customerId, setCustomerId] = useState('');
  const [flash, note] = useFlash();
  // Erst merken, DASS es geklappt hat — dann neu laden. Die Reihenfolge ist der ganze Punkt:
  // das Neuladen laesst den Knopf verschwinden.
  const doneOf = useCallback((kind: string) => (v: ActionValue, replayed: boolean) => {
    note(kind, replayed);
    void v;
    reload();
    onChanged?.();
  }, [note, reload, onChanged]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await read<{ items: Row0[] }>('customers.list', { limit: 500 });
        if (!cancelled) setCustomers(r.items ?? []);
      } catch { /* der Primary weist einen unbekannten Kunden ab */ }
    })();
    return () => { cancelled = true; };
  }, [read]);

  if (error) return <div data-client-transfer-invoice-error style={warn}>{error}</div>;
  if (!row) return <div data-client-transfer-invoice-loading style={box}>Loading…</div>;

  const revision = n(row.revision);
  const status = s(row.status);
  const invoiced = s(row.invoiceId) !== '';
  const convertible = (status === 'sold' || status === 'settled') && !invoiced && n(row.settlementAmount) > 0;
  const options: Array<[string, string]> = [['', '— pick the client —'],
    ...customers.map((c) => [s(c.id), s(c.name) || s(c.id)] as [string, string])];

  return (
    <div data-client-transfer-invoice style={{ marginTop: 20 }}>
      <Head kind="transferinvoice" title={`${s(row.transferNumber)} · ${status}`}
        sub={`settlement ${fmt(n(row.settlementAmount))} · paid ${fmt(n(row.settlementPaidAmount))} BHD`} />
      <Flash flash={flash} />
      {invoiced && (
        <div data-client-transfer-already-invoiced style={{ opacity: 0.75, marginTop: 8 }}>
          This transfer already carries an invoice. Undoing that is not possible from here.
        </div>
      )}
      {!invoiced && !convertible && (
        <div data-client-transfer-not-convertible style={{ opacity: 0.75, marginTop: 8 }}>
          Only a sold or settled transfer with a settlement amount becomes an invoice.
        </div>
      )}
      {convertible && (
        <ClientAction op="transfers.convert_to_invoice" kind="transfer.convert" label="Turn into an invoice"
          body={() => convertTransferRequest(transferId, revision, customerId)}
          disabled={customerId === ''} onDone={doneOf('transfer.convert')}>
          <Row>
            <PickField kind="convert" name="customer" label="Invoice to" value={customerId}
              onChange={setCustomerId} options={options} />
          </Row>
        </ClientAction>
      )}
    </div>
  );
}
