// CENTRAL-C3B — das Rechnungsformular des zweiten Rechners.
//
// Es sieht aus wie das Formular auf dem Primary und ist bewusst NICHT dieselbe Komponente: die
// große Seite hängt an fünf lokalen Stores, an Losen, Medienbildern, Auftragsumwandlung und dem
// Bearbeitungsmodus. Was an ihr für die Richtigkeit zählt, ist hier trotzdem dasselbe Stück Code:
// die Zeilenableitung (`line-derivation`) und der Speichervertrag (`client-invoice-save`). Alles
// andere ist Anzeige.
//
// Drei Regeln, die dieses Formular von einer gewöhnlichen Eingabemaske unterscheiden:
//
//  1. **Was hier gerechnet wird, ist eine Vorschau.** Netto, MwSt und Summe stehen da, damit ein
//     Mensch sieht, was er tut — verbindlich sind sie erst, wenn der Primary sie gerechnet hat.
//     Deshalb schickt der Speichern-Knopf sie auch gar nicht mit; er schickt nur die Auswahl.
//  2. **Eine Kennung gehört zum Vorsatz, nicht zur Anfrage.** Ein Klick auf „Save" beginnt genau
//     einen Versuch. Kommt keine Antwort, bleibt derselbe Versuch offen, und „Retry" fragt mit
//     DERSELBEN Kennung nach — der Primary antwortet dann mit dem eingefrorenen Ergebnis statt
//     ein zweites Mal zu buchen. Eine neue Kennung gibt es erst nach einer Antwort.
//  3. **Der Ausgang „unbekannt" wird ausgesprochen.** Kein Spinner, der irgendwann verschwindet,
//     kein „fehlgeschlagen": es steht da, dass der Ausgang offen ist und dass Wiederholen den
//     bestehenden Auftrag prüft. Das ist die einzige ehrliche Auskunft — und die einzige, nach der
//     ein Benutzer nicht aus Versehen eine zweite Rechnung schreibt.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { calcInvoiceLine, resolveLineScheme, vatRateFor, type LineScheme } from '@/core/invoices/line-derivation';
import { remoteFormSource, type InvoiceFormCustomer, type InvoiceFormProduct, type InvoiceFormSource } from '@/core/invoices/invoice-form-source';
import { InvoiceSaveController, type SaveOutcome } from '@/core/bridge/client-invoice-save';
import { buildInvoiceRequest } from '@/core/invoices/invoice-request';

interface DraftLine {
  productId: string;
  quantity: number;
  unitPrice: number;
}

const today = (): string => new Date().toISOString().slice(0, 10);
const fmt = (v: number): string => v.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });

export function ClientInvoiceCreate({ source = remoteFormSource() }: { source?: InvoiceFormSource }) {
  const [customers, setCustomers] = useState<InvoiceFormCustomer[]>([]);
  const [products, setProducts] = useState<InvoiceFormProduct[]>([]);
  const [customerId, setCustomerId] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([{ productId: '', quantity: 1, unitPrice: 0 }]);
  const [issuedDate, setIssuedDate] = useState(today());
  const [notes, setNotes] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<SaveOutcome | null>(null);

  // EIN Wächter pro Formular: er entscheidet, wann eine neue Kennung entsteht — nie die Oberfläche.
  const controller = useMemo(() => new InvoiceSaveController(), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [cs, ps] = await Promise.all([source.searchCustomers(''), source.searchProducts('')]);
        if (!cancelled) { setCustomers(cs); setProducts(ps); setLoadError(null); }
      } catch (e) {
        // Kein stiller Rückfall auf irgendetwas Lokales: der Client hat nichts, und das sagt er.
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [source]);

  const productById = (id: string): InvoiceFormProduct | undefined => products.find((p) => p.id === id);

  /** Nur Anzeige. Dieselbe Rechnung wie auf dem Primary — aber ohne jede Verbindlichkeit. */
  const preview = lines.map((l) => {
    const p = productById(l.productId);
    const scheme: LineScheme = resolveLineScheme('auto', p?.taxScheme);
    const qty = Math.max(1, l.quantity);
    const calc = calcInvoiceLine(l.unitPrice, qty, 0, scheme, vatRateFor(scheme));
    return { scheme, net: calc.netAmount, vat: calc.vatAmount, gross: calc.grossAmount };
  });
  const total = preview.reduce((sum, c) => sum + c.gross, 0);

  const complete = customerId !== '' && lines.length > 0
    && lines.every((l) => l.productId !== '' && l.quantity >= 1 && l.unitPrice >= 0);

  const pending = outcome?.kind === 'unknown';
  const done = outcome?.kind === 'ok';

  const send = useCallback(async () => {
    setBusy(true);
    try {
      // Der Wächter gibt bei einem offenen Versuch DENSELBEN zurück — deshalb steht hier kein
      // `new InvoiceSaveAttempt()`, und deshalb kann ein zweiter Klick keine zweite Rechnung
      // erzeugen.
      const attempt = controller.beginAttempt();
      // Der Rumpf entsteht in einer eigenen, pruefbaren Funktion — nicht hier zwischen JSX.
      setOutcome(await attempt.send(buildInvoiceRequest({ customerId, issuedDate, notes, lines })));
    } finally {
      setBusy(false);
    }
  }, [controller, customerId, issuedDate, lines, notes]);

  function startOver(): void {
    // Nach einer Antwort ist der nächste Klick ein neuer Vorsatz — der Wächter vergibt dann von
    // sich aus eine neue Kennung. Ein abgelehnter Versuch wird NICHT wiederverwendet.
    controller.forget();
    setOutcome(null);
    setLines([{ productId: '', quantity: 1, unitPrice: 0 }]);
    setNotes('');
  }

  if (done && outcome.kind === 'ok') {
    return (
      <div data-client-invoice-done style={box}>
        <div style={{ fontSize: 18, fontWeight: 600 }}>Invoice created</div>
        {/* Die Nummer kommt vom Primary. Der Client rechnet sie nicht nach und speichert nichts. */}
        <div data-client-invoice-number style={{ marginTop: 8, fontFamily: 'monospace', fontSize: 16 }}>
          {outcome.invoiceNumber}
        </div>
        <div style={{ opacity: 0.7, marginTop: 4 }}>{fmt(outcome.grossAmount)} BHD · {outcome.invoiceId}</div>
        {outcome.replayed && (
          <div style={{ marginTop: 8, opacity: 0.8 }}>
            This was the answer to the attempt that had already run — nothing was booked twice.
          </div>
        )}
        <button data-client-invoice-new onClick={startOver} style={btn(true)}>New invoice</button>
      </div>
    );
  }

  return (
    <div data-client-invoice-form style={box}>
      <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>New invoice</div>
      {loadError && <div data-client-invoice-loaderror style={warn}>Cannot reach the server: {loadError}</div>}

      <label style={label}>Client</label>
      <select data-client-invoice-customer value={customerId} disabled={pending}
        onChange={(e) => setCustomerId(e.target.value)} style={field}>
        <option value="">— choose —</option>
        {customers.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
      </select>

      <label style={{ ...label, marginTop: 12 }}>Items</label>
      {lines.map((l, i) => (
        <div key={i} data-client-invoice-line style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
          <select data-client-invoice-product value={l.productId} disabled={pending}
            onChange={(e) => {
              const p = productById(e.target.value);
              setLines((prev) => prev.map((x, j) => (j === i
                ? { ...x, productId: e.target.value, unitPrice: x.unitPrice || (p?.plannedSalePrice ?? 0) }
                : x)));
            }}
            style={{ ...field, flex: 3 }}>
            <option value="">— choose —</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>{p.label}{p.sku ? ` · ${p.sku}` : ''}</option>
            ))}
          </select>
          <input data-client-invoice-qty type="number" min={1} step={1} value={l.quantity} disabled={pending}
            onChange={(e) => setLines((prev) => prev.map((x, j) => (j === i ? { ...x, quantity: Math.max(1, parseInt(e.target.value, 10) || 1) } : x)))}
            style={{ ...field, flex: 1 }} />
          <input data-client-invoice-price type="number" min={0} step="0.001" value={l.unitPrice} disabled={pending}
            onChange={(e) => setLines((prev) => prev.map((x, j) => (j === i ? { ...x, unitPrice: Math.max(0, parseFloat(e.target.value) || 0) } : x)))}
            style={{ ...field, flex: 1 }} />
          <span style={{ alignSelf: 'center', minWidth: 90, textAlign: 'right', opacity: 0.8 }}>
            {fmt(preview[i]?.gross ?? 0)}
          </span>
        </div>
      ))}
      <button data-client-invoice-addline disabled={pending}
        onClick={() => setLines((prev) => [...prev, { productId: '', quantity: 1, unitPrice: 0 }])}
        style={btn(false)}>Add item</button>

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <div style={{ flex: 1 }}>
          <label style={label}>Date</label>
          <input data-client-invoice-date type="date" value={issuedDate} disabled={pending}
            onChange={(e) => setIssuedDate(e.target.value)} style={field} />
        </div>
        <div style={{ flex: 2 }}>
          <label style={label}>Note</label>
          <input data-client-invoice-notes value={notes} disabled={pending}
            onChange={(e) => setNotes(e.target.value)} style={field} />
        </div>
      </div>

      {/* Vorschau, ausdruecklich als solche benannt — der Primary rechnet verbindlich. */}
      <div data-client-invoice-total style={{ marginTop: 12, fontSize: 16 }}>
        Preview total: <strong>{fmt(total)} BHD</strong>
        <span style={{ opacity: 0.6, fontSize: 12 }}> · the primary calculates the binding amount</span>
      </div>

      {pending && (
        <div data-client-invoice-pending style={warn}>
          The outcome of this save is not known — the invoice may already exist. Retrying checks the
          same order instead of writing a second one.
        </div>
      )}
      {outcome?.kind === 'business_error' && (
        <div data-client-invoice-rejected style={warn}>
          {outcome.code}: {outcome.message}
        </div>
      )}
      {outcome?.kind === 'not_executed' && (
        <div data-client-invoice-notexecuted style={warn}>
          Not executed ({outcome.code}) — safe to send again.
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button data-client-invoice-save disabled={busy || !complete || outcome?.kind === 'business_error'}
          onClick={send} style={btn(true)}>
          {pending ? 'Retry the same order' : busy ? 'Saving…' : 'Save'}
        </button>
        {outcome?.kind === 'business_error' && (
          <button data-client-invoice-restart onClick={startOver} style={btn(false)}>Start a new attempt</button>
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
