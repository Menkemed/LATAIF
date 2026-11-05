// ════════════════════════════════════════════════════════════════════════════
// BULK METAL V1 — die Bulk-Zeile einer Rechnung (Spec Kapitel 7–9).
//
// Der Mensch (Maske oder PC2) schickt nur die ABSICHT: Lot, Gewicht (mg), Typ, Kundenbetrag inkl. VAT (Fils),
// Steuerart, optional Beschreibung. Der Primary rechnet daraus die Zeile: Menge 1, Einstand = zugeteilter COGS,
// Netto/VAT aus dem Kundenbetrag (`bulkAmountsFromGross`, v0.8.98). Gespeichert wird im bestehenden Zeilenvertrag
// (unit_price = Netto, vat_amount, line_total) — Margen-MwSt, NBR, COGS-Buchung und Auswertungen lesen ihn unverändert.
//
// BULK TAX SELECTION (v0.8.98): Die Steuerart ist wählbar (VAT_10, ZERO, MARGIN); ohne Angabe gilt bei einer neuen
// Zeile die des Lots, bei einer bestehenden die gespeicherte. Der Kundenbetrag bleibt auf das Fils genau.
// ════════════════════════════════════════════════════════════════════════════
import { query } from '@/core/db/helpers';
import { vatRateFor, type InvoiceLineInput } from '@/core/invoices/line-derivation';
import {
  BULK_SALE_TAX_SCHEMES, BulkRejected, assertBulkType, assertFils, assertWeightMg, bulkAmountsFromGross, bulkAmountsIssue,
  bulkGrossOfNet, bulkLineDescription, filsOfStoredAmount, filsToBhd, netFilsFromGross,
  type BulkSaleTaxScheme, type BulkType,
} from './bulk-math';
import { METAL_LABEL, isBulkMetalProduct } from './bulk-product';
import { getBulkLot, planBulkTakes, restoreBulk, type BulkCtx } from './bulk-lot-house';

/** Was Maske/PC2 für eine Bulk-Zeile schicken. */
export interface BulkLineIntent {
  lotId: string;
  weightMg: number;
  bulkType: string;
  /**
   * v0.8.98 — der Kundenbetrag inkl. VAT in Fils. Er ist der Preis (wie `customerGross` bei normalen Zeilen): das Haus
   * rechnet Netto und VAT daraus, die Summe bleibt genau dieser Betrag.
   */
  grossFils?: number;
  /**
   * Bis v0.8.97 der einzige Preis: Netto je Stück in Fils (bei MARGIN/ZERO = Kundenbetrag). Ältere Clients schicken nur
   * ihn; zusammen mit `grossFils` ist er nur eine Gegenprobe.
   */
  unitPriceFils?: number;
  /** v0.8.98 — die gewählte Steuerart. Fehlt sie (oder `auto`): neue Zeile = Steuerart des Lots, bestehende = gespeicherte. */
  scheme?: BulkSaleTaxScheme;
  description?: string;
}

/** Was der Primary an die Zeile hängt (wird in invoice_lines gespeichert). */
export interface BulkLineMeta {
  lotId: string;
  weightMg: number;
  cogsFils: number;
  bulkType: BulkType;
  metal: string;
  fineness: string;
}

export type BuiltBulkLine = InvoiceLineInput & { bulk: BulkLineMeta; description: string };

export function checkBulkIntent(raw: unknown, what = 'bulk line'): BulkLineIntent {
  if (!raw || typeof raw !== 'object') throw new BulkRejected('BULK_LINE_INVALID', `${what}: lot, weight, type and price are required`);
  const r = raw as Record<string, unknown>;
  if (typeof r.lotId !== 'string' || !r.lotId.trim()) throw new BulkRejected('BULK_LOT_NOT_FOUND', `${what}: choose a lot`);
  const out: BulkLineIntent = {
    lotId: r.lotId.trim(),
    weightMg: assertWeightMg(r.weightMg, `${what}: weight`),
    bulkType: assertBulkType(r.bulkType),
  };
  const given = (v: unknown): boolean => v !== undefined && v !== null;
  // v0.8.98 — der Kundenbetrag; ältere Clients schicken nur das Netto. Einer von beiden muss da sein.
  if (given(r.grossFils)) out.grossFils = assertFils(r.grossFils, `${what}: price incl. VAT`, true);
  if (given(r.unitPriceFils) || !given(r.grossFils)) out.unitPriceFils = assertFils(r.unitPriceFils, `${what}: price`, true);
  if (given(r.scheme) && r.scheme !== 'auto') {
    if (typeof r.scheme !== 'string' || !(BULK_SALE_TAX_SCHEMES as readonly string[]).includes(r.scheme)) {
      throw new BulkRejected('BULK_TAX_SCHEME_INVALID', `${what}: unknown tax scheme`);
    }
    out.scheme = r.scheme as BulkSaleTaxScheme;
  }
  if (r.description !== undefined && r.description !== null) {
    if (typeof r.description !== 'string' || r.description.length > 200) throw new BulkRejected('BULK_LINE_INVALID', `${what}: description must be text (max 200)`);
    if (r.description.trim()) out.description = r.description.trim();
  }
  return out;
}

/**
 * v0.8.98 — der Kundenbetrag inkl. VAT einer Absicht für diese Steuerart. Mit `grossFils` ist er genau dieser Betrag
 * (ein mitgeschicktes Netto muss dazu passen). Ein älterer Client schickt nur das Netto: bei ZERO/MARGIN ist es der
 * Betrag; bei VAT_10 nur dann, wenn genau ein Brutto dazu passt — sonst wird abgewiesen, statt den Preis zu raten.
 */
function grossOfIntent(x: BulkLineIntent, scheme: BulkSaleTaxScheme): number {
  if (x.grossFils !== undefined) {
    if (x.unitPriceFils !== undefined && x.unitPriceFils !== netFilsFromGross(x.grossFils, scheme)) {
      throw new BulkRejected('BULK_PRICE_MISMATCH', 'the price incl. VAT and the net price of the bulk line do not match');
    }
    return x.grossFils;
  }
  const g = bulkGrossOfNet(x.unitPriceFils ?? 0, scheme);
  if (g === null) {
    throw new BulkRejected('BULK_GROSS_REQUIRED',
      'this price incl. VAT cannot be taken over exactly from this computer — update LATAIF here and save again');
  }
  return g;
}

/** Netto, gespeicherte Steuer und Summe (BHD, wie der Zeilenvertrag sie speichert) — immer aus dem Kundenbetrag. */
function amountsOf(grossFils: number, scheme: BulkSaleTaxScheme, cogsFils: number): { unitPrice: number; vatAmount: number; lineTotal: number } {
  const a = bulkAmountsFromGross(grossFils, scheme, cogsFils);
  return { unitPrice: filsToBhd(a.netFils), vatAmount: filsToBhd(a.taxFils), lineTotal: filsToBhd(a.grossFils) };
}

/**
 * Aus Absichten die Zeilen — Zuteilung nacheinander je Lot (zwei Zeilen aus demselben Lot in einer
 * Rechnung bekommen die richtige Folge), Beträge aus dem Kundenbetrag (`bulkAmountsFromGross`).
 */
export function buildBulkInvoiceLines(intents: readonly BulkLineIntent[], branchId: string): BuiltBulkLine[] {
  const checked = intents.map((x, i) => checkBulkIntent(x, `bulk line ${i + 1}`));
  const cogs = planBulkTakes(checked.map((x) => ({ lotId: x.lotId, weightMg: x.weightMg })), branchId);
  return checked.map((x, i) => {
    const lot = getBulkLot(x.lotId)!;
    const type = x.bulkType as BulkType;
    const scheme = x.scheme ?? lot.saleTaxScheme;
    const line: InvoiceLineInput = {
      productId: lot.productId, lotId: lot.id, quantity: 1, purchasePrice: filsToBhd(cogs[i]),
      taxScheme: scheme, vatRate: vatRateFor(scheme), ...amountsOf(grossOfIntent(x, scheme), scheme, cogs[i]),
    };
    return {
      ...line,
      description: x.description || bulkLineDescription(type, METAL_LABEL[lot.metal] ?? lot.metal, lot.fineness, x.weightMg),
      bulk: { lotId: lot.id, weightMg: x.weightMg, cogsFils: cogs[i], bulkType: type, metal: lot.metal, fineness: lot.fineness },
    };
  });
}

/** Die gespeicherte Bulk-Zeile, die beim Ändern fortgesetzt wird. */
export interface KeptBulkLine {
  productId: string; lotId: string; purchasePrice: number; taxScheme: string;
  unitPrice: number; vatAmount: number; lineTotal: number;
}

/**
 * Invoice-Edit: die Beträge einer Bulk-Zeile, BEVOR zugeteilt wird — damit die Prüfungen vor dem
 * Schreiben (Retoure, Gutschriften-Summe) die echten Beträge sehen und nicht die 0 aus der Absicht.
 *   • fortgesetzte Zeile: Steuerart aus der Absicht, sonst die gespeicherte; Einstand der gespeicherte. Bleiben
 *     Steuerart und Kundenbetrag gleich, bleiben die gespeicherten Beträge GENAU stehen (`changed: false`) —
 *     nichts wird still neu gerechnet. Sonst neu aus dem Kundenbetrag.
 *   • neue Zeile: Steuerart aus der Absicht, sonst die des Lots; der Bruttobetrag hängt bei keinem Schema vom
 *     Einstand ab (MARGIN: die MwSt steckt im Preis). Fehlt das Lot, bleibt die Zeile, wie sie ist; die
 *     Zuteilung weist sie dann selbst ab.
 */
export function bulkLineAmountsForEdit(
  intent: BulkLineIntent,
  kept?: KeptBulkLine,
): { scheme: BulkSaleTaxScheme; unitPrice: number; vatAmount: number; lineTotal: number; changed: boolean } | null {
  const x = checkBulkIntent(intent);
  if (!kept) {
    const lot = getBulkLot(x.lotId);
    if (!lot) return null;
    const scheme = x.scheme ?? lot.saleTaxScheme;
    return { scheme, ...amountsOf(grossOfIntent(x, scheme), scheme, 0), changed: true };
  }
  const stored = kept.taxScheme as BulkSaleTaxScheme;
  const scheme = x.scheme ?? stored;
  const storedGross = filsOfStoredAmount(kept.lineTotal);
  // Älterer Client ohne Kundenbetrag, Netto und Steuerart wie gespeichert: die Zeile bleibt genau, wie sie ist.
  const gross = x.grossFils === undefined && scheme === stored && x.unitPriceFils === filsOfStoredAmount(kept.unitPrice)
    ? storedGross : grossOfIntent(x, scheme);
  if (scheme === stored && gross === storedGross) {
    return { scheme, unitPrice: kept.unitPrice, vatAmount: kept.vatAmount, lineTotal: kept.lineTotal, changed: false };
  }
  return { scheme, ...amountsOf(gross, scheme, filsOfStoredAmount(kept.purchasePrice)), changed: true };
}

/**
 * Ersetzt Zeilen mit `bulkIntent` durch ihre gerechneten Zeilen (Reihenfolge bleibt). Eine Zeile mit
 * Bulk-Systemartikel OHNE Bulk-Angaben ist ein Direktverkauf des Systemartikels → Nein.
 */
export function resolveBulkIntents<T extends { productId?: string; bulkIntent?: BulkLineIntent; bulk?: BulkLineMeta }>(
  lines: readonly T[], branchId: string,
): T[] {
  const intents = lines.filter((l) => l.bulkIntent).map((l) => l.bulkIntent!);
  const built = intents.length > 0 ? buildBulkInvoiceLines(intents, branchId) : [];
  let k = 0;
  return lines.map((l) => {
    if (l.bulkIntent) {
      const { bulkIntent: _drop, ...rest } = l;
      void _drop;
      return { ...rest, ...built[k++] } as unknown as T;
    }
    if (isBulkMetalProduct(l.productId) && !l.bulk) {
      throw new BulkRejected('BULK_PRODUCT_DIRECT_SALE', 'bulk metal is sold with “Add bulk metal” — choose a lot and a weight');
    }
    return l;
  });
}

/**
 * Vor dem Schreiben: passt eine gerechnete Bulk-Zeile zu ihrem Lot (Artikel, Menge, Snapshot) und zu ihrer Steuerart
 * (v0.8.98: wählbar — erlaubt sind VAT_10, ZERO, MARGIN; Netto, VAT und Summe müssen dazu passen)?
 */
export function assertBulkLineMatchesLot(l: {
  productId: string; quantity?: number; purchasePrice: number; taxScheme: string; unitPrice: number; vatAmount: number; lineTotal: number;
  bulk: BulkLineMeta;
}, branchId: string): void {
  const lot = getBulkLot(l.bulk.lotId);
  if (!lot || lot.branchId !== branchId) throw new BulkRejected('BULK_LOT_NOT_FOUND', 'no such bulk lot in this branch');
  if (lot.productId !== l.productId || (l.quantity ?? 1) !== 1 || filsOfStoredAmount(l.purchasePrice) !== l.bulk.cogsFils
    || bulkAmountsIssue(l.taxScheme, filsOfStoredAmount(l.unitPrice), filsOfStoredAmount(l.vatAmount), filsOfStoredAmount(l.lineTotal), l.bulk.cogsFils) !== null) {
    throw new BulkRejected('BULK_INVARIANT_VIOLATED', `the bulk line does not match lot ${lot.lotNo}`);
  }
}

export interface StoredBulkLine { id: string; invoiceId: string; productId: string; lotId: string; weightMg: number; cogsFils: number; bulkType: string | null }

export function storedBulkLines(invoiceId: string): StoredBulkLine[] {
  return query(
    `SELECT id, invoice_id, product_id, lot_id, bulk_weight_mg, bulk_cogs_fils, bulk_type FROM invoice_lines
      WHERE invoice_id = ? AND bulk_weight_mg IS NOT NULL ORDER BY position, id`, [invoiceId],
  ).map((r) => ({
    id: String(r.id), invoiceId: String(r.invoice_id), productId: String(r.product_id), lotId: String(r.lot_id),
    weightMg: Number(r.bulk_weight_mg), cogsFils: Number(r.bulk_cogs_fils ?? 0), bulkType: (r.bulk_type as string) || null,
  }));
}

export function storedBulkLine(lineId: string): StoredBulkLine | null {
  const r = query(
    `SELECT id, invoice_id, product_id, lot_id, bulk_weight_mg, bulk_cogs_fils, bulk_type FROM invoice_lines
      WHERE id = ? AND bulk_weight_mg IS NOT NULL`, [lineId],
  )[0];
  return r ? {
    id: String(r.id), invoiceId: String(r.invoice_id), productId: String(r.product_id), lotId: String(r.lot_id),
    weightMg: Number(r.bulk_weight_mg), cogsFils: Number(r.bulk_cogs_fils ?? 0), bulkType: (r.bulk_type as string) || null,
  } : null;
}

/** Storno, Löschen, Zeile entfernen: exakt die gespeicherten mg/Fils zurück ins Lot (SALE_REVERSAL). */
export function restoreBulkInvoiceLines(invoiceId: string, ctx: BulkCtx, onlyLineIds?: ReadonlySet<string>): void {
  for (const l of storedBulkLines(invoiceId)) {
    if (onlyLineIds && !onlyLineIds.has(l.id)) continue;
    restoreBulk({
      lotId: l.lotId, weightMg: l.weightMg, valueFils: l.cogsFils, kind: 'SALE_REVERSAL',
      source: { module: 'INVOICE', id: invoiceId, lineId: l.id }, bulkType: l.bulkType,
    }, ctx);
  }
}
