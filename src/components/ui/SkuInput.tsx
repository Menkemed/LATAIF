// Reusable SKU/Reference-Eingabe mit Live-Duplicate-Check + Next-Number-Suggestion.
// Genutzt in Collection→New Item, Edit-Mode, Purchase→New Item, Consignment→New Item.
//
// Verhalten:
// - Tippt der User eine SKU, die schon existiert → rote Error-Linie + Warnung darunter.
// - System schlägt die nächste freie Nummer vor (anhand Stamm + trailing-Digits).
// - „Use XXX"-Button füllt das Feld automatisch aus.
// - excludeProductId überspringt das aktuelle Produkt (Edit-Modus, sonst meldet das
//   eigene SKU sich selbst als Duplikat).
import { useMemo } from 'react';
import { Input } from './Input';
import { useProductStore } from '@/stores/productStore';

export interface SkuInputProps {
  value: string;
  onChange: (next: string) => void;
  excludeProductId?: string;
  label?: string;
  placeholder?: string;
}

export function SkuInput({
  value,
  onChange,
  excludeProductId,
  label = 'SKU / REFERENCE',
  placeholder = 'Internal reference',
}: SkuInputProps) {
  const { products, nextAvailableSku } = useProductStore();

  const taken = useMemo(() => {
    const t = (value || '').trim();
    if (!t) return false;
    const needle = t.toUpperCase();
    return products.some(p =>
      p.id !== excludeProductId &&
      (p.sku || '').trim().toUpperCase() === needle
    );
  }, [value, products, excludeProductId]);

  const suggestion = useMemo(() => {
    if (!taken) return '';
    return nextAvailableSku(value);
  }, [taken, value, nextAvailableSku]);

  return (
    <div>
      <Input
        label={label}
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
        error={taken ? 'Diese SKU / Reference ist bereits vergeben.' : undefined}
      />
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
