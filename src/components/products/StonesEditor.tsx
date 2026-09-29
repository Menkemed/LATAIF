// ════════════════════════════════════════════════════════════════════════════
// STONES — die EINE Eingabe der Steinliste am Rechner (Collection, Bearbeiten, Einkauf, Kommission,
// Reparatur). Daten, Listen und Prüfung kommen aus src/core/products/stones.ts; diese Datei zeichnet
// nur. Während der Eingabe dürfen Menge und Karat noch Text sein — geprüft und normalisiert wird
// beim Speichern (dieselbe Prüfung wie am Primary und am Telefon).
// ════════════════════════════════════════════════════════════════════════════
import { Plus, X } from 'lucide-react';
import {
  STONE_TYPES, DIAMOND_COLORS, DIAMOND_CLARITIES, DIAMOND_SHAPES, MAX_STONE_ROWS,
  parseStones, readStones, stoneRowLabel, stonesSectionSummary, diamondWeightInfo, fmtCarat, type StoneOption,
} from '@/core/products/stones';

/** Eine Zeile, wie sie in der Maske steht (Menge/Karat noch als Text möglich). */
export interface StoneDraft { type: string; qty: string | number; carat?: string | number; name?: string; color?: string; clarity?: string; shape?: string }

const leerZeile = (): StoneDraft => ({ type: '', qty: '' });

function asDrafts(value: unknown): StoneDraft[] {
  if (Array.isArray(value)) return value.map((r) => ({ ...(r as StoneDraft) }));
  return readStones(value).map((r) => ({ ...r }));
}

const feld: React.CSSProperties = {
  padding: '5px 8px', fontSize: 12, border: '1px solid #D5D9DE', borderRadius: 4,
  background: '#FFFFFF', color: '#0F0F10', minWidth: 0, height: 30,
};

const beschriftet: React.CSSProperties = { display: 'grid', gap: 2, margin: 0 };
const beschriftung: React.CSSProperties = { fontSize: 10, lineHeight: '12px', color: '#6B7280', paddingLeft: 2 };

function Auswahl({ value, options, leer, onChange, label, width }: {
  value: string | undefined; options: readonly StoneOption[]; leer: string; label: string; width: number;
  onChange: (v: string) => void;
}) {
  return (
    <select aria-label={label} value={value || ''} onChange={(e) => onChange(e.target.value)}
      style={{ ...feld, width, color: value ? '#0F0F10' : '#9CA3AF' }}>
      <option value="">{leer}</option>
      {options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
    </select>
  );
}

export function StonesEditor({ value, attributes, onChange, readOnly }: {
  value: unknown;
  /** Die übrigen Merkmale — für die Anzeige von Diamond Weight (abgeleitet oder von vor der Liste). */
  attributes?: Record<string, unknown>;
  onChange?: (rows: StoneDraft[]) => void;
  readOnly?: boolean;
}) {
  const rows = asDrafts(value);
  const pruefung = parseStones(rows);
  const gueltig = readStones(rows);
  const dw = diamondWeightInfo({ ...(attributes || {}), stones: gueltig });
  const setze = (next: StoneDraft[]) => onChange?.(next);
  const aendere = (i: number, patch: Partial<StoneDraft>) => {
    const next = rows.map((r, k) => {
      if (k !== i) return r;
      const n = { ...r, ...patch };
      // Nur Diamanten tragen Farbe/Reinheit/Form, nur „Other" einen Namen — beim Wechsel fällt es weg.
      if (n.type !== 'diamond') { delete n.color; delete n.clarity; delete n.shape; }
      if (n.type !== 'other') delete n.name;
      return n;
    });
    setze(next);
  };

  const fusszeile = dw.source === 'stones'
    ? `Diamond weight ${fmtCarat(dw.thousandths!)} ct — from the diamond rows`
    : dw.source === 'legacy'
      ? `Diamond weight ${fmtCarat(dw.thousandths!)} ct — recorded before the stone list; diamond rows with carat replace it`
      : '';

  return (
    <div data-stones-editor style={{ gridColumn: '1 / -1', border: '1px solid #E5E9EE', borderRadius: 6, padding: '10px 12px', background: '#FAFBFC' }}>
      <div className="flex items-center justify-between" style={{ gap: 8 }}>
        <span className="text-overline">STONES <span style={{ color: '#6B7280', textTransform: 'none', letterSpacing: 0 }} data-stones-summary>
          · {stonesSectionSummary(gueltig)}</span></span>
        {!readOnly && rows.length < MAX_STONE_ROWS && (
          <button type="button" data-stones-add onClick={() => setze([...rows, leerZeile()])} className="cursor-pointer flex items-center gap-1"
            style={{ fontSize: 11, color: '#0F0F10', background: 'none', border: '1px solid #D5D9DE', borderRadius: 4, padding: '3px 8px' }}>
            <Plus size={12} /> Add stone
          </button>
        )}
      </div>

      {readOnly ? (
        gueltig.length > 0 && (
          <div style={{ marginTop: 8, display: 'grid', gap: 4 }}>
            {gueltig.map((r, i) => <div key={i} data-stone-row style={{ fontSize: 13, color: '#0F0F10' }}>{stoneRowLabel(r)}</div>)}
          </div>
        )
      ) : (
        rows.length > 0 && (
          <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
            {rows.map((r, i) => (
              <div key={i} data-stone-row={i} style={{ display: 'grid', gap: 4, paddingBottom: 6, borderBottom: i < rows.length - 1 ? '1px solid #EEF1F4' : 'none' }}>
                {/* Oben: Stein, (Name), Menge, Gesamt-Karat, Entfernen — darunter nur bei Diamanten Farbe/Reinheit/Form.
                    Menge und Karat tragen eine feste Beschriftung: auch ausgefüllt sieht man, was was ist. */}
                <div className="flex items-end" style={{ gap: 6 }}>
                  <Auswahl label="Stone type" value={r.type} options={STONE_TYPES} leer="Stone…" width={132} onChange={(v) => aendere(i, { type: v })} />
                  {r.type === 'other' && (
                    <input aria-label="Stone name" placeholder="Stone name" value={r.name || ''} maxLength={60}
                      onChange={(e) => aendere(i, { name: e.target.value })} style={{ ...feld, width: 120 }} />
                  )}
                  <label style={beschriftet}>
                    <span style={beschriftung}>Qty</span>
                    <input aria-label="Quantity" placeholder="Qty" inputMode="numeric" value={r.qty ?? ''}
                      onChange={(e) => aendere(i, { qty: e.target.value })} style={{ ...feld, width: 56 }} />
                  </label>
                  <label style={beschriftet}>
                    <span style={beschriftung}>Total ct</span>
                    <input aria-label="Total carat" placeholder="Total ct" inputMode="decimal" value={r.carat ?? ''}
                      onChange={(e) => aendere(i, { carat: e.target.value })} style={{ ...feld, width: 76 }} />
                  </label>
                  <button type="button" aria-label="Remove stone" data-stones-remove={i} onClick={() => setze(rows.filter((_, k) => k !== i))}
                    className="cursor-pointer" style={{ background: 'none', border: 'none', color: '#9CA3AF', padding: 2, marginLeft: 'auto', marginBottom: 6 }}>
                    <X size={14} />
                  </button>
                </div>
                {r.type === 'diamond' && (
                  <div className="flex items-center flex-wrap" style={{ gap: 6 }}>
                    <Auswahl label="Color" value={r.color} options={DIAMOND_COLORS} leer="Color" width={80} onChange={(v) => aendere(i, { color: v || undefined })} />
                    <Auswahl label="Clarity" value={r.clarity} options={DIAMOND_CLARITIES} leer="Clarity" width={88} onChange={(v) => aendere(i, { clarity: v || undefined })} />
                    <Auswahl label="Shape" value={r.shape} options={DIAMOND_SHAPES} leer="Shape" width={110} onChange={(v) => aendere(i, { shape: v || undefined })} />
                  </div>
                )}
              </div>
            ))}
          </div>
        )
      )}

      {!readOnly && pruefung.issues.length > 0 && (
        <div data-stones-error style={{ marginTop: 6, fontSize: 11, color: '#DC2626' }}>{pruefung.issues[0].message}</div>
      )}
      {fusszeile && <div data-stones-diamond-total style={{ marginTop: 6, fontSize: 11, color: '#6B7280' }}>{fusszeile}</div>}
    </div>
  );
}
