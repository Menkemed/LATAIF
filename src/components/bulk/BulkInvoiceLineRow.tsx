// ════════════════════════════════════════════════════════════════════════════
// BULK METAL V1 — die Bulk-Zeile der Rechnungsmaske (Spec 7.2). Lot manuell, Typ, Gewicht, Gesamtbetrag
// wie bei jeder Zeile, optionale Beschreibung. Menge fest 1.
// BULK TAX SELECTION (v0.8.98) — Steuerart wählbar wie bei normalen Zeilen: Auto (= Steuerart des Lots), VAT 10%,
// Zero, Margin. Der Gesamtbetrag inkl. VAT bleibt beim Wechsel genau stehen; Netto und VAT folgen (die Fußzeile zeigt,
// was gespeichert wird — gerechnet mit derselben Funktion wie im Haus).
// Bei einer bestehenden Zeile (Ändern) sind Lot und Gewicht gesperrt — Korrektur: Zeile entfernen und
// neu anlegen. Eine retournierte Zeile behält Preis und Steuerart. Die COGS-Vorschau kommt vom Primary;
// gespeichert wird die Zuteilung der Transaktion.
// ════════════════════════════════════════════════════════════════════════════
import { Trash2 } from 'lucide-react';
import { Bhd } from '@/components/ui/Bhd';
import { BULK_TYPES, BULK_TYPE_LABEL, formatFils, formatMg, type BulkSaleTaxScheme, type BulkType } from '@/core/bulk/bulk-math';
import { METAL_LABEL, type BulkMetal } from '@/core/bulk/bulk-product';
import type { BulkLotForSale } from '@/core/bulk/bulk-reads';
import { readsFromPrimary, fetchFromPrimary } from '@/core/data/primary-source';
import { localReadContext } from '@/core/data/read-context';
import { bulkAllocationPreviewFor } from '@/core/bulk/bulk-reads';

export interface BulkInvoiceDraft {
  lotId: string;
  weightText: string;
  bulkType: BulkType;
  /** Gesamtbetrag des Kunden (wie das Feld „Total Price incl. VAT" jeder Zeile). */
  grossText: string;
  description: string;
  /** v0.8.98 — die Wahl: `auto` = Steuerart des Lots (Vorauswahl einer neuen Zeile); bestehende Zeile: die gespeicherte. */
  scheme?: BulkSchemeChoice;
  /** Bestehende Zeile beim Ändern: Lot/Gewicht/COGS stehen fest. */
  kept?: { weightMg: number; cogsFils: number; lotLabel: string; scheme: string };
  previewCogsFils?: number | null;
}

export type BulkSchemeChoice = 'auto' | BulkSaleTaxScheme;

/** Die Steuerart, mit der gerechnet und gespeichert wird: `auto` → die des Lots; ohne bekanntes Lot die gespeicherte. */
export function resolvedBulkScheme(draft: BulkInvoiceDraft, lotScheme: string | null | undefined): BulkSaleTaxScheme {
  const choice = draft.scheme ?? (draft.kept ? (draft.kept.scheme as BulkSaleTaxScheme) : 'auto');
  if (choice !== 'auto') return choice;
  return ((lotScheme || draft.kept?.scheme || 'MARGIN') as BulkSaleTaxScheme);
}

/** COGS-Vorschau (nur Anzeige): am Primary lokal, auf PC2 über den Lesebefehl. */
export async function previewBulkCogs(lotId: string, weightMg: number): Promise<number | null> {
  try {
    if (readsFromPrimary()) {
      const d = await fetchFromPrimary('bulk_metals.allocation_preview.get', { lotId, weightMg });
      return d && typeof d.cogsFils === 'number' ? d.cogsFils : null;
    }
    return bulkAllocationPreviewFor(localReadContext(), lotId, weightMg).cogsFils;
  } catch { return null; }
}

const lotLabel = (l: BulkLotForSale): string =>
  `${l.lotNo} · ${METAL_LABEL[l.metal as BulkMetal] ?? l.metal} ${l.fineness} · ${formatMg(l.remainingWeightMg)} g left · ${l.saleTaxScheme}`;

export function BulkInvoiceLineRow({ draft, lots, scheme, lotScheme, cogsFils, net, vat, internalVat, gross, returned, onChange, onRemove, removable }: {
  draft: BulkInvoiceDraft; lots: BulkLotForSale[]; scheme: string;
  /** Steuerart des gewählten Lots (für „Auto"); `null`, wenn das Lot nicht in der Liste ist. */
  lotScheme: string | null;
  cogsFils: number | null; net: number; vat: number; internalVat: number; gross: number;
  /** Zeile mit Retoure: Preis und Steuerart bleiben. */
  returned?: boolean;
  onChange: (d: BulkInvoiceDraft) => void; onRemove: () => void; removable: boolean;
}) {
  const set = (patch: Partial<BulkInvoiceDraft>): void => onChange({ ...draft, ...patch });
  const box = { padding: '7px 8px', fontSize: 12, border: '1px solid #D5D9DE', borderRadius: 4, background: '#FFFFFF' } as const;
  const locked = !!draft.kept;
  const choice: BulkSchemeChoice = draft.scheme ?? (draft.kept ? (draft.kept.scheme as BulkSaleTaxScheme) : 'auto');
  // „Auto" gibt es nur, wenn die Steuerart des Lots bekannt ist (bestehende Zeile mit leerem Lot: die drei Steuerarten).
  const showAuto = !!lotScheme || choice === 'auto';
  return (
    <div data-bulk-invoice-line style={{ padding: '10px 12px', background: '#FAFBFC', borderBottom: '1px solid #E5E9EE' }}>
      <div className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: '#0F0F10' }}>BULK METAL</span>
        {locked ? (
          <span title="Lot and weight of a saved bulk line are fixed — remove the line and add it again to change them."
            style={{ ...box, background: '#F2F7FA', color: '#4B5563' }} data-bulk-locked>
            {draft.kept!.lotLabel} · {formatMg(draft.kept!.weightMg)} g · fixed
          </span>
        ) : (
          <>
            <select value={draft.lotId} onChange={(e) => set({ lotId: e.target.value, previewCogsFils: undefined })} style={{ ...box, minWidth: 260 }} data-bulk-lot-select>
              <option value="">Choose a lot…</option>
              {lots.map((l) => <option key={l.lotId} value={l.lotId}>{lotLabel(l)}</option>)}
            </select>
            <input placeholder="Weight (g)" value={draft.weightText} onChange={(e) => set({ weightText: e.target.value, previewCogsFils: undefined })}
              className="font-mono" style={{ ...box, width: 110, textAlign: 'right' }} data-bulk-sale-weight />
          </>
        )}
        <select value={draft.bulkType} onChange={(e) => set({ bulkType: e.target.value as BulkType })} style={box} data-bulk-type>
          {BULK_TYPES.map((t) => <option key={t} value={t}>{BULK_TYPE_LABEL[t]}</option>)}
        </select>
        <input placeholder="Description (optional)" value={draft.description} onChange={(e) => set({ description: e.target.value })}
          style={{ ...box, flex: 1, minWidth: 180 }} data-bulk-description />
        <select value={choice} disabled={returned} data-bulk-tax-scheme
          title={returned ? 'Returned pieces keep their tax' : 'Changing the tax keeps the customer price incl. VAT'}
          onChange={(e) => set({ scheme: e.target.value as BulkSchemeChoice })}
          style={{ ...box, background: returned ? '#F2F7FA' : '#FFFFFF' }}>
          {showAuto && <option value="auto">Auto (lot · {lotScheme || scheme || '—'})</option>}
          <option value="VAT_10">VAT 10%</option>
          <option value="ZERO">Zero</option>
          <option value="MARGIN">Margin</option>
        </select>
        <input placeholder="Total incl. VAT" value={draft.grossText} disabled={returned} onChange={(e) => set({ grossText: e.target.value })}
          title={returned ? 'Returned pieces keep their price' : undefined}
          className="font-mono" style={{ ...box, width: 120, textAlign: 'right', border: '1px solid #0F0F10', fontWeight: 600 }} data-bulk-gross />
        <button onClick={onRemove} disabled={!removable} title="Remove this line"
          style={{ border: 'none', background: 'none', color: '#DC2626', opacity: removable ? 1 : 0.4, cursor: removable ? 'pointer' : 'not-allowed' }}>
          <Trash2 size={16} />
        </button>
      </div>
      <div style={{ fontSize: 11, color: '#4B5563', marginTop: 6 }} data-bulk-amounts>
        Qty 1 · COGS {cogsFils === null ? '—' : formatFils(cogsFils)} BHD (from the lot, staff only)
        {' · '}Net <span data-bulk-net><Bhd v={net} /></span>
        {scheme === 'MARGIN' ? <> · internal margin VAT <span data-bulk-vat><Bhd v={internalVat} /></span></>
          : scheme === 'VAT_10' ? <> · VAT <span data-bulk-vat><Bhd v={vat} /></span></> : <> · VAT <span data-bulk-vat><Bhd v={0} /></span></>}
        {' · '}<b style={{ color: '#0F0F10' }}>Total <span data-bulk-total><Bhd v={gross} /></span> BHD</b>
      </div>
    </div>
  );
}
