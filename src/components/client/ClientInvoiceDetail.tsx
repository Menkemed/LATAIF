// CENTRAL-C3D — eine Rechnung am zweiten Rechner: ansehen, ändern, bezahlen.
//
// Das hier ist die erste Client-Oberfläche, die einen Vorgang MIT GESCHICHTE anfasst. Drei Dinge
// stehen deshalb anders da als in den Anlege-Formularen:
//
//  1. **Die gesehene Fassung fährt mit.** Was geladen wurde, trägt eine Fassungsnummer
//     (`revision`), und die geht bei jeder Änderung mit. Hat der Primary die Rechnung inzwischen
//     angefasst, ist seine Fassung höher und er weist die Änderung ab — statt sie still zu
//     überschreiben. Danach lädt diese Ansicht neu und der Mensch entscheidet noch einmal.
//  2. **Ein Änderungsgrund ist Pflicht**, genau wie am Primary. Ohne ihn ist der Knopf aus; und
//     der Primary würde ihn ohnehin abweisen.
//  3. **Ändern und Bezahlen sind zwei Vorgänge**, jeder mit eigenem Vorsatz und eigener Kennung.
//     Eine Zeitgrenze beim Bezahlen darf nie dazu führen, dass zweimal Geld gebucht wird —
//     deshalb hat jeder der beiden seinen eigenen Wächter.
//
// Gerechnet wird hier nichts. Netto, MwSt, Summe, offener Rest und Status kommen vom Primary;
// diese Ansicht zeigt sie und schickt Auswahl zurück.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CommandSaveController, type SaveOutcome } from '@/core/bridge/client-command-save';
import { remoteRead, type RemoteReadError } from '@/core/bridge/remote-read';
import { buildUpdateRequest, type InvoiceDraftLine } from './client-invoice-request';

export const OP_INVOICES_UPDATE = 'invoices.update';
export const OP_INVOICES_RECORD_PAYMENT = 'invoices.record_payment';

/** Was der Primary über eine Rechnung sagt — und was er nach einem Auftrag zurückmeldet. */
export interface InvoiceView {
  id: string;
  invoiceNumber: string;
  customerId: string;
  status: string;
  netAmount: number;
  vatAmount: number;
  grossAmount: number;
  paidAmount: number;
  openAmount: number;
  issuedAt: string;
  /** Die Fassung, gegen die eine Änderung gilt. */
  revision: number;
  updatedAt: string;
  notes?: string;
  lines: Array<{ id: string; productId: string; description: string; quantity: number; unitPrice: number; lineTotal: number }>;
}

export interface LifecycleValue {
  invoiceId: string;
  invoiceNumber: string;
  status: string;
  grossAmount: number;
  paidAmount: number;
  openAmount: number;
  revision: number;
  updatedAt: string;
  paymentId?: string;
  replayed?: boolean;
}

type DraftLine = InvoiceDraftLine;

const METHODS = ['cash', 'card', 'bank_transfer', 'benefit', 'other'] as const;
const fmt = (v: number): string => v.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });

// Der Rumpf entsteht in `client-invoice-request` — dort ist er ohne Browser prüfbar.
export { buildUpdateRequest };

export interface ClientInvoiceDetailProps {
  invoiceId: string;
  onClose?: () => void;
  read?: typeof remoteRead;
}

export function ClientInvoiceDetail({ invoiceId, onClose, read = remoteRead }: ClientInvoiceDetailProps) {
  const [view, setView] = useState<InvoiceView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const [lines, setLines] = useState<DraftLine[]>([]);
  const [reason, setReason] = useState('');
  const [editBusy, setEditBusy] = useState(false);
  const [editOutcome, setEditOutcome] = useState<SaveOutcome<LifecycleValue> | null>(null);

  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<typeof METHODS[number]>('cash');
  const [payBusy, setPayBusy] = useState(false);
  const [payOutcome, setPayOutcome] = useState<SaveOutcome<LifecycleValue> | null>(null);

  // ZWEI Wächter: ändern und bezahlen sind verschiedene Vorsätze. Ein offener Zahlungsversuch
  // darf einen Änderungsversuch nicht blockieren — und vor allem nicht dessen Kennung erben.
  const editCtl = useMemo(() => new CommandSaveController<LifecycleValue>(OP_INVOICES_UPDATE), []);
  const payCtl = useMemo(() => new CommandSaveController<LifecycleValue>(OP_INVOICES_RECORD_PAYMENT), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const row = await read<InvoiceView>('invoices.get', { id: invoiceId });
        if (cancelled) return;
        setView(row);
        setLines((row.lines ?? []).map((l) => ({
          productId: l.productId, quantity: l.quantity, unitPrice: l.unitPrice,
        })));
        setLoadError(null);
      } catch (e) {
        if (cancelled) return;
        // Kein stiller Rückfall auf etwas Lokales: dieser Rechner hat keine Rechnung.
        const err = e as RemoteReadError;
        setLoadError(err?.code ? `${err.code}: ${err.message}` : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [invoiceId, read, tick]);

  const editPending = editOutcome?.kind === 'unknown';
  const payPending = payOutcome?.kind === 'unknown';

  const saveEdit = useCallback(async () => {
    if (!view) return;
    setEditBusy(true);
    try {
      const attempt = editCtl.beginAttempt();
      const out = await attempt.send(buildUpdateRequest({
        id: view.id,
        // Die Fassung, die DIESE Ansicht geladen hat — nicht die, die der Primary gerade hat.
        expectedRevision: view.revision,
        reason,
        customerId: view.customerId,
        lines,
        notes: view.notes,
      }));
      setEditOutcome(out);
      // Nach einem Ergebnis ist der gesehene Stand veraltet — auch nach einem Nein. Neu laden,
      // damit der nächste Vorsatz auf dem wirklichen Stand fußt.
      if (out.kind === 'ok' || out.kind === 'business_error') setTick((t) => t + 1);
    } finally {
      setEditBusy(false);
    }
  }, [editCtl, view, reason, lines]);

  const pay = useCallback(async () => {
    if (!view) return;
    setPayBusy(true);
    try {
      const attempt = payCtl.beginAttempt();
      const out = await attempt.send({
        invoiceId: view.id,
        amount: Number(amount),
        method,
      });
      setPayOutcome(out);
      if (out.kind === 'ok' || out.kind === 'business_error') setTick((t) => t + 1);
    } finally {
      setPayBusy(false);
    }
  }, [payCtl, view, amount, method]);

  if (loadError) return <div data-client-invoice-detail-error style={warn}>Cannot reach the server: {loadError}</div>;
  if (!view) return <div data-client-invoice-detail-loading style={box}>Loading…</div>;

  const canEdit = reason.trim() !== '' && lines.length > 0 && lines.every((l) => l.productId !== '');
  const payAmount = Number(amount);
  const canPay = Number.isFinite(payAmount) && payAmount > 0;

  return (
    <div data-client-invoice-detail style={box}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span data-client-invoice-detail-number style={{ fontFamily: 'monospace', fontSize: 16 }}>
          {view.invoiceNumber}
        </span>
        <span data-client-invoice-detail-status style={{ opacity: 0.7 }}>{view.status}</span>
        {onClose && <button data-client-invoice-detail-close onClick={onClose} style={{ ...btn(false), marginLeft: 'auto' }}>Close</button>}
      </div>

      {/* Alles Gerechnete kommt vom Primary — hier steht es nur. */}
      <div data-client-invoice-detail-totals style={{ marginTop: 8, fontSize: 13 }}>
        gross <strong>{fmt(view.grossAmount)}</strong> · paid <strong data-client-invoice-detail-paid>{fmt(view.paidAmount)}</strong>
        {' · '}open <strong data-client-invoice-detail-open>{fmt(view.openAmount)}</strong> BHD
      </div>

      <div style={{ marginTop: 14, fontSize: 12, opacity: 0.7 }}>Items</div>
      {lines.map((l, i) => (
        <div key={i} data-client-invoice-detail-line style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          <input data-client-invoice-detail-product value={l.productId} disabled={editPending}
            onChange={(e) => setLines((prev) => prev.map((x, j) => (j === i ? { ...x, productId: e.target.value } : x)))}
            style={{ ...field, flex: 3 }} />
          <input data-client-invoice-detail-qty type="number" min={1} step={1} value={l.quantity} disabled={editPending}
            onChange={(e) => setLines((prev) => prev.map((x, j) => (j === i ? { ...x, quantity: Math.max(1, parseInt(e.target.value, 10) || 1) } : x)))}
            style={{ ...field, flex: 1 }} />
          <input data-client-invoice-detail-price type="number" min={0} step="0.001" value={l.unitPrice} disabled={editPending}
            onChange={(e) => setLines((prev) => prev.map((x, j) => (j === i ? { ...x, unitPrice: Math.max(0, parseFloat(e.target.value) || 0) } : x)))}
            style={{ ...field, flex: 1 }} />
          <button data-client-invoice-detail-dropline disabled={editPending || lines.length <= 1}
            style={{ ...btn(false), marginTop: 0 }}
            onClick={() => setLines((prev) => prev.filter((_, j) => j !== i))}>remove</button>
        </div>
      ))}

      <label style={{ ...label, marginTop: 12 }}>Reason for the change (required)</label>
      <input data-client-invoice-detail-reason value={reason} disabled={editPending}
        onChange={(e) => setReason(e.target.value)} style={field} />

      {editPending && (
        <div data-client-invoice-detail-editpending style={warn}>
          The outcome of this change is not known — it may already have been applied. Retrying
          checks the same attempt instead of changing it twice.
        </div>
      )}
      {editOutcome?.kind === 'business_error' && (
        <div data-client-invoice-detail-editrejected style={warn}>
          {editOutcome.code}: {editOutcome.message}
          {editOutcome.code === 'INVOICE_CHANGED' && ' — the invoice was reloaded; look at it again before saving.'}
        </div>
      )}
      {editOutcome?.kind === 'not_executed' && (
        <div data-client-invoice-detail-editnotexecuted style={warn}>
          Not executed ({editOutcome.code}) — safe to send again.
        </div>
      )}

      <button data-client-invoice-detail-save disabled={editBusy || !canEdit} onClick={saveEdit} style={btn(true)}>
        {editPending ? 'Retry the same change' : editBusy ? 'Saving…' : 'Save change'}
      </button>

      {/* ── Zahlung: ein eigener Vorsatz, ein eigener Wächter ── */}
      <div style={{ marginTop: 20, borderTop: '1px solid rgba(128,128,128,0.3)', paddingTop: 12 }}>
        <div style={{ fontSize: 12, opacity: 0.7 }}>Record a payment</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          <input data-client-invoice-detail-amount type="number" min={0} step="0.001" value={amount}
            disabled={payPending} placeholder="0.000"
            onChange={(e) => setAmount(e.target.value)} style={{ ...field, flex: 1 }} />
          <select data-client-invoice-detail-method value={method} disabled={payPending}
            onChange={(e) => setMethod(e.target.value as typeof METHODS[number])} style={{ ...field, flex: 1 }}>
            {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <button data-client-invoice-detail-pay disabled={payBusy || !canPay} onClick={pay} style={{ ...btn(true), marginTop: 0 }}>
            {payPending ? 'Retry the same payment' : payBusy ? 'Booking…' : 'Record'}
          </button>
        </div>

        {payPending && (
          <div data-client-invoice-detail-paypending style={warn}>
            The outcome of this payment is not known — it may already be booked. Retrying checks the
            same payment instead of booking a second one.
          </div>
        )}
        {payOutcome?.kind === 'business_error' && (
          <div data-client-invoice-detail-payrejected style={warn}>{payOutcome.code}: {payOutcome.message}</div>
        )}
        {payOutcome?.kind === 'not_executed' && (
          <div data-client-invoice-detail-paynotexecuted style={warn}>
            Not executed ({payOutcome.code}) — safe to send again.
          </div>
        )}
        {payOutcome?.kind === 'ok' && (
          <div data-client-invoice-detail-paydone style={{ marginTop: 8, fontSize: 12, opacity: 0.8 }}>
            Booked · {payOutcome.value.status} · open {fmt(payOutcome.value.openAmount)} BHD
            {payOutcome.replayed && ' · this was the answer to the attempt that had already run'}
          </div>
        )}
      </div>
    </div>
  );
}

const box: React.CSSProperties = { padding: 16, maxWidth: 760 };
const label: React.CSSProperties = { display: 'block', fontSize: 12, opacity: 0.7, marginBottom: 4 };
const field: React.CSSProperties = {
  width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid rgba(128,128,128,0.4)',
  background: 'transparent', color: 'inherit',
};
const warn: React.CSSProperties = {
  marginTop: 12, padding: '8px 10px', borderRadius: 6,
  border: '1px solid rgba(200,150,0,0.5)', background: 'rgba(200,150,0,0.08)',
};
function btn(primary: boolean): React.CSSProperties {
  return {
    marginTop: 8, padding: '6px 12px', borderRadius: 999, cursor: 'pointer',
    border: '1px solid rgba(128,128,128,0.4)',
    background: primary ? 'rgba(90,140,255,0.18)' : 'transparent', color: 'inherit',
  };
}
