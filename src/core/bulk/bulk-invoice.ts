// ════════════════════════════════════════════════════════════════════════════
// BULK METAL V1 — die Bulk-Zeile einer Rechnung (Spec Kapitel 7–9).
//
// Der Mensch (Maske oder PC2) schickt nur die ABSICHT: Lot, Gewicht (mg), Typ, Preis (Fils),
// optional Beschreibung. Der Primary rechnet daraus mit dem BESTEHENDEN Zeilenvertrag
// (`toInvoiceLine`) die Zeile: Menge 1, Steuerart aus dem Lot, Einstand = zugeteilter COGS. Damit
// laufen Margen-MwSt, NBR, COGS-Buchung und Auswertungen unverändert.
// ════════════════════════════════════════════════════════════════════════════
import { query } from '@/core/db/helpers';
import { toInvoiceLine, type InvoiceLineInput, type LineScheme } from '@/core/invoices/line-derivation';
import {
  BulkRejected, assertBulkType, assertFils, assertWeightMg, bulkLineDescription, filsOfStoredAmount, filsToBhd,
  type BulkType,
} from './bulk-math';
import { METAL_LABEL, isBulkMetalProduct } from './bulk-product';
import { getBulkLot, planBulkTakes, restoreBulk, type BulkCtx } from './bulk-lot-house';

/** Was Maske/PC2 für eine Bulk-Zeile schicken. */
export interface BulkLineIntent {
  lotId: string;
  weightMg: number;
  bulkType: string;
  /** Der Preis im bestehenden Zeilenvertrag (Netto je Stück; bei MARGIN/ZERO = Kundenbetrag), in Fils. */
  unitPriceFils: number;
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
    unitPriceFils: assertFils(r.unitPriceFils, `${what}: price`, true),
  };
  if (r.description !== undefined && r.description !== null) {
    if (typeof r.description !== 'string' || r.description.length > 200) throw new BulkRejected('BULK_LINE_INVALID', `${what}: description must be text (max 200)`);
    if (r.description.trim()) out.description = r.description.trim();
  }
  return out;
}

/**
 * Aus Absichten die Zeilen — Zuteilung nacheinander je Lot (zwei Zeilen aus demselben Lot in einer
 * Rechnung bekommen die richtige Folge), Beträge über den bestehenden Zeilenvertrag.
 */
export function buildBulkInvoiceLines(intents: readonly BulkLineIntent[], branchId: string): BuiltBulkLine[] {
  const checked = intents.map((x, i) => checkBulkIntent(x, `bulk line ${i + 1}`));
  const cogs = planBulkTakes(checked.map((x) => ({ lotId: x.lotId, weightMg: x.weightMg })), branchId);
  return checked.map((x, i) => {
    const lot = getBulkLot(x.lotId)!;
    const type = x.bulkType as BulkType;
    const line = toInvoiceLine({
      productId: lot.productId, lotId: lot.id, quantity: 1,
      unitPrice: filsToBhd(x.unitPriceFils), costBasis: filsToBhd(cogs[i]), scheme: lot.saleTaxScheme,
    });
    return {
      ...line,
      description: x.description || bulkLineDescription(type, METAL_LABEL[lot.metal] ?? lot.metal, lot.fineness, x.weightMg),
      bulk: { lotId: lot.id, weightMg: x.weightMg, cogsFils: cogs[i], bulkType: type, metal: lot.metal, fineness: lot.fineness },
    };
  });
}

/**
 * Invoice-Edit: die Beträge einer Bulk-Zeile, BEVOR zugeteilt wird — damit die Prüfungen vor dem
 * Schreiben (Retoure, Gutschriften-Summe) die echten Beträge sehen und nicht die 0 aus der Absicht.
 *   • fortgesetzte Zeile: derselbe Zeilenvertrag mit dem gespeicherten Einstand und der gespeicherten Steuerart;
 *   • neue Zeile: Brutto aus Preis und Steuerart des Lots — der Bruttobetrag hängt bei keinem Schema vom
 *     Einstand ab (MARGIN: die MwSt steckt im Preis). Fehlt das Lot, bleibt die Zeile, wie sie ist; die
 *     Zuteilung weist sie dann selbst ab.
 */
export function bulkLineAmountsForEdit(
  intent: BulkLineIntent,
  kept?: { productId: string; lotId: string; purchasePrice: number; taxScheme: string },
): { unitPrice: number; vatAmount: number; lineTotal: number } | null {
  const x = checkBulkIntent(intent);
  const lot = kept ? null : getBulkLot(x.lotId);
  if (!kept && !lot) return null;
  const line = toInvoiceLine({
    productId: kept?.productId ?? lot!.productId, lotId: kept?.lotId ?? lot!.id, quantity: 1,
    unitPrice: filsToBhd(x.unitPriceFils), costBasis: kept?.purchasePrice ?? 0,
    scheme: (kept?.taxScheme ?? lot!.saleTaxScheme) as LineScheme,
  });
  return { unitPrice: line.unitPrice, vatAmount: line.vatAmount, lineTotal: line.lineTotal };
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

/** Vor dem Schreiben: passt eine gerechnete Bulk-Zeile zu ihrem Lot (Artikel, Menge, Steuerart, Snapshot)? */
export function assertBulkLineMatchesLot(l: { productId: string; quantity?: number; purchasePrice: number; taxScheme: string; bulk: BulkLineMeta }, branchId: string): void {
  const lot = getBulkLot(l.bulk.lotId);
  if (!lot || lot.branchId !== branchId) throw new BulkRejected('BULK_LOT_NOT_FOUND', 'no such bulk lot in this branch');
  if (lot.productId !== l.productId || (l.quantity ?? 1) !== 1 || l.taxScheme !== lot.saleTaxScheme
    || filsOfStoredAmount(l.purchasePrice) !== l.bulk.cogsFils) {
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
