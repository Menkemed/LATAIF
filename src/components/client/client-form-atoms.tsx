// CENTRAL-C3E — die geteilten Bausteine der drei Handelsformulare.
//
// Sie liegen zusammen, weil dreimal derselbe Rahmen entstanden wäre: ein Kasten, ein Feld, ein
// Knopf, eine Warnung — und der Positionseditor, der in Einkauf und Auftrag WORTGLEICH derselbe
// ist (ein Artikel, eine Menge, ein Preis). Drei Abschriften davon wären drei Stellen, an denen
// sich der Vertrag auseinanderentwickeln kann.

import type { ReactNode } from 'react';
import type { DraftLine } from '@/core/bridge/client-commercial-request';
import { btn, field, label, warn } from './client-form-style';

export function Row({ children }: { children: ReactNode }) {
  return <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>{children}</div>;
}

export interface FieldProps {
  kind: string;
  name: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  numeric?: boolean;
  date?: boolean;
}

export function TextField({ kind, name, label: l, value, onChange, disabled, numeric, date }: FieldProps) {
  return (
    <div style={{ flex: 1 }}>
      <label style={label}>{l}</label>
      <input data-client-field={`${kind}.${name}`} value={value} disabled={disabled}
        type={date ? 'date' : numeric ? 'number' : 'text'} min={numeric ? 0 : undefined}
        onChange={(e) => onChange(e.target.value)} style={field} />
    </div>
  );
}

export function PickField({ kind, name, label: l, value, onChange, disabled, options }:
FieldProps & { options: Array<[string, string]> }) {
  return (
    <div style={{ flex: 1 }}>
      <label style={label}>{l}</label>
      <select data-client-field={`${kind}.${name}`} value={value} disabled={disabled}
        onChange={(e) => onChange(e.target.value)} style={field}>
        {options.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
      </select>
    </div>
  );
}

/**
 * Der Positionseditor. Er kennt nur BESTEHENDE Artikel — die Auswahl kommt aus `products.list`,
 * also aus der Autorität. Ein Feld, in das jemand eine Artikelkennung tippen könnte, gibt es
 * nicht: dieser Rechner hat keine Datenbank, in der er sie nachschlagen könnte.
 */
export function LineEditor({ kind, lines, setLines, products, disabled }: {
  kind: string;
  lines: DraftLine[];
  setLines: (fn: (prev: DraftLine[]) => DraftLine[]) => void;
  products: Array<Record<string, unknown>>;
  disabled: boolean;
}) {
  const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
  return (
    <div data-client-lines={kind} style={{ marginTop: 12 }}>
      <label style={label}>Items</label>
      {lines.map((l, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6, alignItems: 'flex-end' }}>
          <div style={{ flex: 3 }}>
            <select data-client-line-product={i} value={l.productId} disabled={disabled}
              onChange={(e) => setLines((prev) => prev.map((x, j) => (j === i ? { ...x, productId: e.target.value } : x)))}
              style={field}>
              <option value="">— choose an item —</option>
              {products.map((p) => (
                <option key={s(p.id)} value={s(p.id)}>
                  {s(p.brand)} {s(p.name)} · {s(p.sku)}
                </option>
              ))}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <input data-client-line-qty={i} type="number" min={1} step={1} value={l.quantity} disabled={disabled}
              onChange={(e) => setLines((prev) => prev.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))}
              style={field} />
          </div>
          <div style={{ flex: 1 }}>
            <input data-client-line-price={i} type="number" min={0} step="0.001" value={l.unitPrice} disabled={disabled}
              onChange={(e) => setLines((prev) => prev.map((x, j) => (j === i ? { ...x, unitPrice: e.target.value } : x)))}
              style={field} />
          </div>
          <button data-client-line-remove={i} disabled={disabled || lines.length === 1}
            onClick={() => setLines((prev) => prev.filter((_, j) => j !== i))}
            style={{ ...btn(false), marginTop: 0 }}>×</button>
        </div>
      ))}
      <button data-client-line-add disabled={disabled}
        onClick={() => setLines((prev) => [...prev, { productId: '', quantity: '1', unitPrice: '' }])}
        style={btn(false)}>Add item</button>
    </div>
  );
}

/** Der Ausgang eines Speicherversuchs, für alle drei Formulare gleich beschriftet. */
export function Outcome({ kind, outcome }: { kind: string; outcome: { kind: string; code?: string; message?: string } | null }) {
  if (!outcome) return null;
  if (outcome.kind === 'unknown') {
    return (
      <div data-client-pending={kind} style={warn}>
        The outcome of this save is not known — it may already exist. Retrying checks the same
        attempt instead of writing a second one.
      </div>
    );
  }
  if (outcome.kind === 'business_error') {
    return <div data-client-rejected={kind} style={warn}>{outcome.code}: {outcome.message}</div>;
  }
  if (outcome.kind === 'not_executed') {
    return <div data-client-notexecuted={kind} style={warn}>Not executed ({outcome.code}) — safe to send again.</div>;
  }
  return null;
}
