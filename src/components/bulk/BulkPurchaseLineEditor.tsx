// ════════════════════════════════════════════════════════════════════════════
// BULK METAL V1 — die Bulk-Zeile der Einkaufsmaske (Spec 6.2): Metall, Feinheit, Gesamtgewicht,
// Gesamtkosten, Verkaufs-Steuerart, optionale Composition. Anzeige getrennt: Purchase Cost/g (aus den
// Eingaben, netto bei VAT_10 — dieselbe Regel wie das Haus) und Live Market/g (SSOT, nur Referenz).
// ════════════════════════════════════════════════════════════════════════════
import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { METAL_GRADES, metalPurity } from '@/core/gold/purity';
import { getSpotPrices, bhdPerGramFine } from '@/core/market/spot-prices';
import {
  BULK_SALE_TAX_SCHEMES, COMPOSITION_LABEL, COMPOSITION_TYPES, costPerGramText, parseBhdToFils, parseGramsToMg,
  type CompositionType,
} from '@/core/bulk/bulk-math';
import { bulkPurchaseAmounts } from '@/core/bulk/bulk-purchase';
import { BULK_METALS, METAL_LABEL } from '@/core/bulk/bulk-product';

export interface BulkDraft {
  metal: string;
  fineness: string;
  weightText: string;
  costText: string;
  saleTaxScheme: string;
  composition: Array<{ type: CompositionType; grams: string; pieces: string }>;
}

export const newBulkDraft = (purchaseTaxScheme: string): BulkDraft => ({
  metal: 'silver', fineness: '925', weightText: '', costText: '',
  saleTaxScheme: purchaseTaxScheme === 'VAT_10' ? 'VAT_10' : 'MARGIN', composition: [],
});

/** Text → mg/Fils für den Auftrag (wirft mit verständlichem Satz bei falscher Eingabe). */
export function bulkDraftToInput(d: BulkDraft): { metal: string; fineness: string; weightMg: number; lineTotalFils: number; saleTaxScheme: string; composition: Array<{ type: CompositionType; weightMg: number; pieces?: number }> } {
  return {
    metal: d.metal, fineness: d.fineness, saleTaxScheme: d.saleTaxScheme,
    weightMg: parseGramsToMg(d.weightText.trim()),
    lineTotalFils: parseBhdToFils(d.costText.trim()),
    composition: d.composition.filter((c) => c.grams.trim()).map((c) => ({
      type: c.type, weightMg: parseGramsToMg(c.grams.trim()), ...(c.pieces.trim() ? { pieces: Number(c.pieces.trim()) } : {}),
    })),
  };
}

const safe = <T,>(fn: () => T): T | null => { try { return fn(); } catch { return null; } };

export function BulkPurchaseLineEditor({ draft, purchaseTaxScheme, onChange, onRemove, removable }: {
  draft: BulkDraft; purchaseTaxScheme: string; onChange: (d: BulkDraft) => void; onRemove: () => void; removable: boolean;
}) {
  const [live, setLive] = useState<{ gold?: number; silver?: number }>({});
  useEffect(() => {
    void getSpotPrices().then((r) => setLive({
      gold: r.gold ? bhdPerGramFine(r.gold.usdPerOunce) : undefined, silver: r.silver ? bhdPerGramFine(r.silver.usdPerOunce) : undefined,
    })).catch(() => { /* keine Live-Referenz */ });
  }, []);
  const set = (patch: Partial<BulkDraft>): void => onChange({ ...draft, ...patch });
  const weightMg = safe(() => parseGramsToMg(draft.weightText.trim()));
  const costFils = safe(() => parseBhdToFils(draft.costText.trim()));
  const lotValue = costFils !== null ? bulkPurchaseAmounts(costFils, purchaseTaxScheme === 'VAT_10' ? 10 : 0).lotValueFils : null;
  const fine = draft.metal === 'gold' ? live.gold : draft.metal === 'silver' ? live.silver : undefined;
  const purity = metalPurity(draft.metal, draft.fineness);
  const livePerG = fine !== undefined && purity !== null ? fine * purity : null;
  const grades = (METAL_GRADES as Record<string, readonly string[]>)[draft.metal] ?? [];
  const box = { padding: '7px 8px', fontSize: 12, border: '1px solid #D5D9DE', borderRadius: 4, background: '#FFFFFF' } as const;

  return (
    <div data-bulk-purchase-line style={{ padding: '10px 12px', background: '#FAFBFC' }}>
      <div className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: '#0F0F10' }}>BULK METAL</span>
        <select value={draft.metal} onChange={(e) => {
          const m = e.target.value;
          const g = (METAL_GRADES as Record<string, readonly string[]>)[m] ?? [];
          set({ metal: m, fineness: g.includes(draft.fineness) ? draft.fineness : (g[0] ?? '') });
        }} style={box} data-bulk-metal>
          {BULK_METALS.map((m) => <option key={m} value={m}>{METAL_LABEL[m]}</option>)}
        </select>
        <select value={draft.fineness} onChange={(e) => set({ fineness: e.target.value })} style={box} data-bulk-fineness>
          {grades.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
        <input placeholder="Total weight (g)" value={draft.weightText} onChange={(e) => set({ weightText: e.target.value })}
          className="font-mono" style={{ ...box, width: 140, textAlign: 'right' }} data-bulk-weight />
        <input placeholder="Total cost (BHD)" value={draft.costText} onChange={(e) => set({ costText: e.target.value })}
          className="font-mono" style={{ ...box, width: 140, textAlign: 'right' }} data-bulk-cost />
        <label style={{ fontSize: 11, color: '#4B5563' }}>Sale tax</label>
        <select value={draft.saleTaxScheme} onChange={(e) => set({ saleTaxScheme: e.target.value })} style={box} data-bulk-sale-tax>
          {BULK_SALE_TAX_SCHEMES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <button onClick={onRemove} disabled={!removable} title="Remove this line"
          style={{ marginLeft: 'auto', border: 'none', background: 'none', color: '#DC2626', opacity: removable ? 1 : 0.4, cursor: removable ? 'pointer' : 'not-allowed' }}>
          <Trash2 size={16} />
        </button>
      </div>
      <div style={{ fontSize: 11, color: '#4B5563', marginTop: 6 }}>
        Purchase cost/g: <b className="font-mono">{weightMg !== null && lotValue !== null ? costPerGramText(lotValue, weightMg) : '—'}</b> BHD
        {purchaseTaxScheme === 'VAT_10' ? ' (net of input VAT)' : ''}
        {' · '}Live market/g: <b className="font-mono">{livePerG === null ? '—' : livePerG.toFixed(3)}</b> BHD (reference only)
      </div>
      <div style={{ marginTop: 8 }}>
        <span style={{ fontSize: 10, color: '#9CA3AF', letterSpacing: '0.06em' }}>COMPOSITION (OPTIONAL, INFORMATION ONLY)</span>
        {draft.composition.map((c, i) => (
          <div key={i} className="flex items-center gap-2" style={{ marginTop: 4 }}>
            <select value={c.type} onChange={(e) => set({ composition: draft.composition.map((x, k) => k === i ? { ...x, type: e.target.value as CompositionType } : x) })} style={box}>
              {COMPOSITION_TYPES.map((t) => <option key={t} value={t}>{COMPOSITION_LABEL[t]}</option>)}
            </select>
            <input placeholder="g" value={c.grams} onChange={(e) => set({ composition: draft.composition.map((x, k) => k === i ? { ...x, grams: e.target.value } : x) })}
              className="font-mono" style={{ ...box, width: 100, textAlign: 'right' }} />
            <input placeholder="~ pcs" value={c.pieces} onChange={(e) => set({ composition: draft.composition.map((x, k) => k === i ? { ...x, pieces: e.target.value } : x) })}
              className="font-mono" style={{ ...box, width: 80, textAlign: 'right' }} />
            <button onClick={() => set({ composition: draft.composition.filter((_, k) => k !== i) })} style={{ border: 'none', background: 'none', color: '#6B7280', cursor: 'pointer' }}>×</button>
          </div>
        ))}
        <button onClick={() => set({ composition: [...draft.composition, { type: 'RINGS', grams: '', pieces: '' }] })}
          style={{ marginTop: 4, border: 'none', background: 'none', color: '#4B5563', fontSize: 11, cursor: 'pointer' }}>+ Composition row</button>
      </div>
    </div>
  );
}
