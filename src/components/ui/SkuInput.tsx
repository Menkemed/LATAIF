// Reusable SKU/Reference-Eingabe mit Live-Duplicate-Check + Next-Number-Suggestion.
// Genutzt in Collection→New Item, Edit-Mode, Purchase→New Item, Consignment→New Item.
//
// Verhalten:
// - Tippt der User eine SKU, die schon existiert → rote Error-Linie + Warnung darunter.
// - System schlägt die nächste freie Nummer vor (anhand Stamm + trailing-Digits).
// - „Use XXX"-Button füllt das Feld automatisch aus.
// - excludeProductId überspringt das aktuelle Produkt (Edit-Modus, sonst meldet das
//   eigene SKU sich selbst als Duplikat).
import { useEffect, useMemo, useState } from 'react';
import { Input } from './Input';
import { useProductStore } from '@/stores/productStore';
import { readsFromPrimary } from '@/core/data/primary-source';
import { remoteRead } from '@/core/bridge/remote-read';

/**
 * v0.8.91 — die nächste Nummer zu `seed`, am Primary aus dem lokalen Zähler, auf PC2 aus DEM Zähler des Primary
 * (`products.sku_preview.get`). Nur gelesen, entprellt; leer, solange nichts zu fragen ist oder die Antwort fehlt.
 */
export function useSkuPeek(seed: string, enabled = true): string {
  const peekSku = useProductStore(s => s.peekSku);
  const products = useProductStore(s => s.products);
  const [answer, setAnswer] = useState('');
  useEffect(() => {
    const s = (seed || '').trim();
    if (!enabled || !s) { setAnswer(''); return; }
    let alive = true;
    const t = setTimeout(() => {
      if (!readsFromPrimary()) { if (alive) setAnswer(peekSku(s)); return; }
      // Eine C2-Auskunft (wie `products.get`): die Antwort IST `{ sku }`. Ohne Antwort keine Vorschau — vergeben wird ohnehin am Primary.
      remoteRead<{ sku?: unknown }>('products.sku_preview.get', { seed: s })
        .then(d => { if (alive) setAnswer(typeof d?.sku === 'string' ? d.sku : ''); })
        .catch(() => { if (alive) setAnswer(''); });
    }, 200);
    return () => { alive = false; clearTimeout(t); };
  }, [seed, enabled, peekSku, products]);
  return answer;
}

export interface SkuInputProps {
  value: string;
  onChange: (next: string) => void;
  excludeProductId?: string;
  label?: string;
  placeholder?: string;
  /**
   * SKU-UNIFY — a full example SKU (`ROL-WCH-001`) for the stem this product will be numbered
   * under. Given one, an EMPTY field shows the number the create is about to claim.
   *
   * Showing it costs nothing: the peek is read-only, so a form that is opened, looked at and
   * cancelled leaves the counter where it was. It is therefore only informational — the create
   * claims its own number, and if someone else took this one meanwhile the saved product simply
   * gets the next. Omit the prop where no automatic number is assigned (the edit dialog).
   */
  previewSeed?: string;
}

export function SkuInput({
  value,
  onChange,
  excludeProductId,
  label = 'SKU / REFERENCE',
  placeholder = 'Internal reference',
  previewSeed,
}: SkuInputProps) {
  const { products } = useProductStore();

  const taken = useMemo(() => {
    const t = (value || '').trim();
    if (!t) return false;
    const needle = t.toUpperCase();
    return products.some(p =>
      p.id !== excludeProductId &&
      (p.sku || '').trim().toUpperCase() === needle
    );
  }, [value, products, excludeProductId]);

  // The number offered when the typed SKU is already gone. It comes from the durable counter, not
  // from the product list: the list forgets a number as soon as its product is deleted, and
  // offering the operator a retired number is the failure this whole split exists to stop.
  // v0.8.91 — auch auf PC2 (aus dem Zähler des Primary).
  const suggestion = useSkuPeek(value, taken);

  /**
   * The number an empty field is about to be given. Debounced because the seed changes with every
   * keystroke in Brand, and the first peek for a stem nobody has used yet reads the whole surviving
   * history to find out where to start — worth it once, not once per letter.
   */
  const empty = !(value || '').trim();
  const preview = useSkuPeek(previewSeed ?? '', !!previewSeed && empty);

  return (
    <div>
      <Input
        label={label}
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
        error={taken ? 'Diese SKU / Reference ist bereits vergeben.' : undefined}
      />
      {!taken && preview && (
        <div data-sku-preview={preview} style={{ marginTop: 6, fontSize: 12, color: '#6B7280' }}>
          Will be assigned:{' '}
          <span className="font-mono" style={{ color: '#0F0F10', fontWeight: 500 }}>{preview}</span>
          <span> — leave empty to use it.</span>
        </div>
      )}
      {taken && suggestion && (
        <div style={{ marginTop: 6, fontSize: 12, color: '#6B7280', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <span>
            Next free number:{' '}
            <span className="font-mono" style={{ color: '#0F0F10', fontWeight: 500 }}>{suggestion}</span>
          </span>
          <button
            type="button"
            onClick={() => onChange(suggestion)}
            className="cursor-pointer transition-colors"
            style={{
              padding: '3px 10px', fontSize: 11, borderRadius: 999,
              border: '1px solid #0F0F10', background: 'transparent', color: '#0F0F10',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = '#0F0F10'; e.currentTarget.style.color = '#FFFFFF'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#0F0F10'; }}
          >
            Use {suggestion}
          </button>
        </div>
      )}
    </div>
  );
}
