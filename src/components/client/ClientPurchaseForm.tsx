// CENTRAL-C3E — der Einkaufsbildschirm des zweiten Rechners.
//
// Nur ANLEGEN, und das ist keine Auslassung: es gibt im ganzen Haus keine Bearbeitung eines
// Einkaufs. Ein Formular „Einkauf ändern" hier hätte einen Vertrag erfunden, den der Primary
// nicht hat — und mit ihm eine zweite Bewertung von Ware.
//
// Der Bildschirm rechnet eine Summe. Sie wird NICHT mitgeschickt: der Primary rechnet seine
// eigene, aus denselben Positionen. Was hier steht, ist eine Vorschau, keine Zusage.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CommandSaveController, type SaveOutcome } from '@/core/bridge/client-command-save';
import { remoteRead, type RemoteReadError } from '@/core/bridge/remote-read';
import {
  EMPTY_PURCHASE, previewTotal, purchaseComplete, purchaseCreateRequest,
  type DraftLine, type PurchaseDraft,
} from '@/core/bridge/client-commercial-request';
import { LineEditor, Outcome, PickField, Row, TextField } from './client-form-atoms';
import { box, btn, field, label, warn } from './client-form-style';

export const OP_PURCHASES_CREATE = 'purchases.create';

export interface PurchaseSaveValue {
  purchaseId: string;
  purchaseNumber: string;
  totalAmount: number;
  paidAmount: number;
  openAmount: number;
  replayed?: boolean;
}

const fmt = (v: number): string => v.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

export function ClientPurchaseForm({ onSaved, read = remoteRead }: {
  onSaved?: (id: string) => void;
  read?: typeof remoteRead;
}) {
  const [draft, setDraft] = useState<PurchaseDraft>(EMPTY_PURCHASE);
  const [lines, setLines] = useState<DraftLine[]>([{ productId: '', quantity: '1', unitPrice: '' }]);
  const [suppliers, setSuppliers] = useState<Array<Record<string, unknown>>>([]);
  const [products, setProducts] = useState<Array<Record<string, unknown>>>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<SaveOutcome<PurchaseSaveValue> | null>(null);

  const controller = useMemo(() => new CommandSaveController<PurchaseSaveValue>(OP_PURCHASES_CREATE), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Beide Auswahllisten kommen aus der Autorität. Ohne sie gibt es kein Formular — es wird
        // nichts Lokales gezeigt und nichts geraten.
        const [sup, prod] = await Promise.all([
          read<{ items: Array<Record<string, unknown>> }>('suppliers.list', {}),
          read<{ items: Array<Record<string, unknown>> }>('products.list', { limit: 500 }),
        ]);
        if (cancelled) return;
        setSuppliers(sup.items ?? []);
        setProducts(prod.items ?? []);
        setLoadError(null);
      } catch (e) {
        if (cancelled) return;
        const err = e as RemoteReadError;
        setLoadError(err?.code ? `${err.code}: ${err.message}` : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [read]);

  const set = (f: keyof PurchaseDraft, v: string): void => setDraft((p) => ({ ...p, [f]: v }));
  const total = previewTotal(lines);
  const complete = purchaseComplete(draft, lines);
  const pending = outcome?.kind === 'unknown';

  const send = useCallback(async () => {
    setBusy(true);
    try {
      // Der Wächter gibt bei einem offenen Versuch DENSELBEN zurück — ein zweiter Klick legt
      // deshalb keinen zweiten Einkauf an, und keine zweite Ware.
      const attempt = controller.beginAttempt();
      setOutcome(await attempt.send(purchaseCreateRequest(draft, lines)));
    } finally {
      setBusy(false);
    }
  }, [controller, draft, lines]);

  function startOver(): void {
    controller.forget();
    setOutcome(null);
    setDraft(EMPTY_PURCHASE);
    setLines([{ productId: '', quantity: '1', unitPrice: '' }]);
  }

  if (loading) return <div data-client-purchase-loading style={box}>Loading…</div>;

  if (outcome?.kind === 'ok') {
    return (
      <div data-client-purchase-done style={box}>
        <div style={{ fontSize: 18, fontWeight: 600 }}>Purchase booked</div>
        <div data-client-purchase-number style={{ marginTop: 6 }}>{outcome.value.purchaseNumber}</div>
        <div style={{ marginTop: 4, opacity: 0.8 }}>
          {fmt(outcome.value.totalAmount)} BHD · paid {fmt(outcome.value.paidAmount)} · open {fmt(outcome.value.openAmount)}
        </div>
        {outcome.replayed && (
          <div data-client-purchase-replayed style={{ marginTop: 8, opacity: 0.8 }}>
            This was the answer to the attempt that had already run — nothing was booked twice.
          </div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <button data-client-purchase-again onClick={startOver} style={btn(true)}>New purchase</button>
          <button data-client-purchase-list onClick={() => {
            const id = outcome.value.purchaseId;
            startOver();
            onSaved?.(id);
          }} style={btn(false)}>Show purchases</button>
        </div>
      </div>
    );
  }

  return (
    <div data-client-purchase-form style={box}>
      <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>New purchase</div>
      {loadError && <div data-client-purchase-loaderror style={warn}>Cannot reach the server: {loadError}</div>}

      <Row>
        <div style={{ flex: 2 }}>
          <label style={label}>Supplier</label>
          <select data-client-field="purchase.supplierId" value={draft.supplierId} disabled={pending}
            onChange={(e) => set('supplierId', e.target.value)} style={field}>
            <option value="">— choose a supplier —</option>
            {suppliers.map((x) => (
              <option key={s(x.id)} value={s(x.id)}>{s(x.name)}{x.active === false ? ' (inactive)' : ''}</option>
            ))}
          </select>
        </div>
        <TextField kind="purchase" name="purchaseDate" label="Date" date
          value={draft.purchaseDate} onChange={(v) => set('purchaseDate', v)} disabled={pending} />
        <PickField kind="purchase" name="taxScheme" label="Input VAT" value={draft.taxScheme}
          onChange={(v) => set('taxScheme', v)} disabled={pending}
          options={[['ZERO', 'None'], ['VAT_10', '10 %']]} />
      </Row>

      <LineEditor kind="purchase" lines={lines} setLines={setLines} products={products} disabled={!!pending} />

      <Row>
        <TextField kind="purchase" name="paymentAmount" label="Pay now" numeric
          value={draft.paymentAmount} onChange={(v) => set('paymentAmount', v)} disabled={pending} />
        <PickField kind="purchase" name="paymentMethod" label="Method" value={draft.paymentMethod}
          onChange={(v) => set('paymentMethod', v)} disabled={pending}
          options={[['bank', 'Bank'], ['cash', 'Cash'], ['benefit', 'Benefit']]} />
      </Row>

      <label style={{ ...label, marginTop: 8 }}>Note</label>
      <input data-client-field="purchase.notes" value={draft.notes} disabled={pending}
        onChange={(e) => set('notes', e.target.value)} style={field} />

      <div data-client-purchase-preview style={{ marginTop: 12, fontSize: 13, opacity: 0.75 }}>
        {fmt(total)} BHD — the primary calculates the real total, VAT and stock.
      </div>

      <Outcome kind="purchase" outcome={outcome} />

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button data-client-purchase-save disabled={busy || !complete || outcome?.kind === 'business_error'}
          onClick={send} style={btn(true)}>
          {pending ? 'Retry the same attempt' : busy ? 'Saving…' : 'Save'}
        </button>
        {outcome?.kind === 'business_error' && (
          <button data-client-purchase-restart onClick={startOver} style={btn(false)}>Start a new attempt</button>
        )}
      </div>
    </div>
  );
}
