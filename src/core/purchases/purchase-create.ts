// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R5E — einen Einkauf anlegen: EINE Vorbereitung für beide Seiten.
//
// Die Anlegemaske („New Purchase") kann in einer Zeile einen NEUEN Artikel mit anlegen (die Maske
// „New Item"), nennt den Mitarbeiter, kann aus einem Auftrag kommen (Wareneingang: die Posten des
// Auftrags gehen auf „Arrived") oder aus einem Foto der Wareneingangs-Inbox (danach „erledigt").
// Der Fernbefehl kannte nur bestehende Artikel. Jetzt schickt die Maske ihre Eingaben, und EINE
// Vorbereitung baut daraus den Einkauf, den `createPurchase` anlegt — Lose, Menge, Status, Vorsteuer,
// Verbindlichkeit, Buchung bleiben dort. Der Anschluss ans Haus steht in `purchase-house`.
// ════════════════════════════════════════════════════════════════════════════
import type { Product } from '@/core/models/types';
import { F, PartnerItemRejected, planLineParticipation, type PartnerShareInput } from '@/core/partners/item-participation';
import {
  EMBEDDED_PRODUCT_FIELDS, checkEmbeddedProduct, pickProductSpec, stageSpecImages, type EmbeddedProductPort,
} from '@/core/products/embedded-product';
import { isBrandRequired } from '@/core/products/field-contract';
import { businessDateIssue } from '@/core/utils/business-date';
// BULK METAL V1 — die Bulk-Zeile: Gesamtgewicht (mg) + Gesamtkosten (Fils), Lot entsteht im Haus.
import { BulkRejected, filsToBhd } from '@/core/bulk/bulk-math';
import { checkBulkPurchaseLine, type BulkPurchaseLineInput } from '@/core/bulk/bulk-purchase';

export class PurchaseActionRejected extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'PurchaseActionRejected';
  }
}

export const PURCHASE_TAX_SCHEMES = ['ZERO', 'VAT_10'] as const;
export const PURCHASE_PAYMENT_METHODS = ['cash', 'bank', 'benefit'] as const;

/** Eine Zeile der Maske. */
export interface PurchaseDraftLine {
  mode: 'existing' | 'new' | 'bulk';
  /** BULK METAL V1 — nur bei mode 'bulk': Metall, Feinheit, Gewicht (mg), Betrag (Fils), Verkaufs-Steuerart, Composition. */
  bulk?: BulkPurchaseLineInput;
  productId?: string;
  newProduct?: Partial<Product>;
  brand: string;
  name: string;
  sku: string;
  categoryId: string;
  quantity: number;
  /** Brutto pro Stück — was an den Lieferanten gezahlt wird. */
  unitPrice: number;
  sourceOrderLineId?: string;
  /** PARTNER-ITEMS — gemeinsam gekauft: Partner und Anteile; LATAIF hält den Rest. Leer = allein. */
  partnerShares?: PartnerShareInput[];
}

/** MOBILE-PURCHASE — eine von mehreren Zahlungen, die zusammen mit dem Einkauf erfasst werden. */
export interface PurchasePaymentInput {
  amount: number;
  method: typeof PURCHASE_PAYMENT_METHODS[number];
  reference?: string;
}

/**
 * MOBILE-PURCHASE — der Lieferant, wenn er erst MIT dem Einkauf entsteht: aus einem bestehenden Kunden
 * (dieselbe Person, verknüpfte Lieferantenrolle der Stammdaten) oder als neue Person (erst Kunde, dann
 * die verknüpfte Lieferantenrolle). Dieselben Hausfunktionen wie „New Supplier → Use existing customer".
 */
export interface PurchaseSupplierFromCustomer {
  customerId: string;
  /** Der Stand des Kunden, den der Mensch gesehen hat (`updated_at`). */
  seenCustomerUpdatedAt: string;
  createDespiteExistingSuppliers?: boolean;
}
export interface PurchaseNewSupplierPerson {
  /** Die Kundenfelder, geprüft wie `customers.create`. */
  fields: Record<string, unknown>;
  createDespiteExistingSuppliers?: boolean;
  /** Das Ausweisfoto als schon aufgenommenes Medium — setzt nur der Befehl (vor der Klammer), nie der Rumpf. */
  idMediaId?: string;
}

/** Die EINGABEN der Anlegemaske. */
export interface PurchaseCreateInput {
  supplierId: string;
  supplierFromCustomer?: PurchaseSupplierFromCustomer;
  newSupplierPerson?: PurchaseNewSupplierPerson;
  /** Mehrere Zahlungen statt der einen Anzahlung (`paymentAmount` ist dann 0). */
  payments?: PurchasePaymentInput[];
  purchaseDate: string;
  taxScheme: typeof PURCHASE_TAX_SCHEMES[number];
  lines: PurchaseDraftLine[];
  paymentAmount: number;
  paymentMethod: typeof PURCHASE_PAYMENT_METHODS[number];
  notes: string;
  staffId: string;
  sourceOrderId?: string;
  inboxId?: string;
}

const fmt = (v: number): string => v.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
export const purchaseTotal = (lines: readonly PurchaseDraftLine[]): number =>
  lines.reduce((s, l) => s + (l.quantity || 0) * (l.unitPrice || 0), 0);

/** Die Prüfung der Maske — wortgleich; der Code sagt dem Fernweg, WAS nicht stimmt. */
export function purchaseCreateIssue(input: PurchaseCreateInput): { code: string; message: string } | null {
  const supplierWays = [!!input.supplierId, !!input.supplierFromCustomer, !!input.newSupplierPerson].filter(Boolean).length;
  if (supplierWays === 0) return { code: 'SUPPLIER_REQUIRED', message: 'Please select a supplier' };
  if (supplierWays > 1) return { code: 'SUPPLIER_AMBIGUOUS', message: 'Name the supplier one way only' };
  if (input.lines.length === 0) return { code: 'LINES_REQUIRED', message: 'Please add at least one line' };
  // BUSINESS-DATE — das Einkaufsdatum ist wählbar (nachträglich erfasster Einkauf), aber ein echter
  // Tag und nicht in der Zukunft: dieselbe Regel für Rechner, zweiten Rechner und Telefon.
  const dateIssue = businessDateIssue(input.purchaseDate, 'Purchase date');
  if (dateIssue) return { code: 'INVALID_DATE', message: dateIssue };
  // BULK METAL V1 — eine Bulk-Zeile ist Menge 1 zum Zeilenbetrag; Partner und Auftragsbezug gibt es dort nicht.
  for (let i = 0; i < input.lines.length; i++) {
    const l = input.lines[i];
    if (l.mode !== 'bulk') continue;
    try {
      const b = checkBulkPurchaseLine(l.bulk);
      if (l.quantity !== 1 || Math.round((l.unitPrice || 0) * 1000) !== b.lineTotalFils) {
        return { code: 'BULK_LINE_INVALID', message: `Line ${i + 1}: a bulk line is quantity 1 at its total cost` };
      }
      if ((l.partnerShares && l.partnerShares.length > 0) || l.sourceOrderLineId) {
        return { code: 'BULK_NOT_SUPPORTED_HERE', message: `Line ${i + 1}: partners and order links are not available for bulk metal` };
      }
    } catch (e) {
      if (e instanceof BulkRejected) return { code: e.code, message: `Line ${i + 1}: ${e.message}` };
      throw e;
    }
  }
  // DISPLAY-NAME — Marke und Modell sind nur dort Pflicht, wo die Kategorie sie verlangt; bei
  // Gold-Diamond Jewellery und Zubehör benennen die Merkmale den Artikel (wie beim Anlegen).
  const bad = input.lines.findIndex((l) => l.mode !== 'bulk' && (
    l.quantity <= 0 || l.unitPrice < 0
    || (l.mode === 'new'
      ? (isBrandRequired(String(l.newProduct?.categoryId ?? l.categoryId ?? '')) && (!l.brand || !l.name))
      : !l.productId)));
  if (bad !== -1) {
    return { code: 'LINE_INVALID', message: `Line ${bad + 1}: Brand+Name (oder Product) + Qty > 0 + Price ≥ 0 erforderlich` };
  }
  for (let i = 0; i < input.lines.length; i++) {
    const l = input.lines[i];
    if (!l.partnerShares || l.partnerShares.length === 0) continue;
    try { planLineParticipation(l.partnerShares, F((l.quantity || 0) * (l.unitPrice || 0))); }
    catch (e) {
      if (e instanceof PartnerItemRejected) return { code: e.code, message: `Line ${i + 1}: ${e.message}` };
      throw e;
    }
  }
  const total = purchaseTotal(input.lines);
  if (input.paymentAmount < 0) return { code: 'PAYMENT_NEGATIVE', message: 'Payment cannot be negative' };
  if (input.paymentAmount > total) {
    return { code: 'PAYMENT_EXCEEDS_TOTAL', message: `Payment (${fmt(input.paymentAmount)}) exceeds total (${fmt(total)})` };
  }
  if (input.payments && input.payments.length > 0) {
    if (input.paymentAmount > 0) return { code: 'PAYMENT_AMBIGUOUS', message: 'Either one payment or a list of payments, not both' };
    let sumF = 0;
    for (let i = 0; i < input.payments.length; i++) {
      const p = input.payments[i];
      if (typeof p.amount !== 'number' || !Number.isFinite(p.amount) || F(p.amount) <= 0) {
        return { code: 'PAYMENT_AMOUNT_INVALID', message: `Payment ${i + 1}: amount must be greater than zero` };
      }
      if (!(PURCHASE_PAYMENT_METHODS as readonly string[]).includes(p.method)) {
        return { code: 'PAYMENT_METHOD_INVALID', message: `Payment ${i + 1}: unknown payment method` };
      }
      sumF += F(p.amount);
    }
    // Filsgenau: Summe der Zahlungen gegen die Summe der Zeilen (je Zeile Menge × Stückpreis).
    const totalF = input.lines.reduce((a, l) => a + F((l.quantity || 0) * (l.unitPrice || 0)), 0);
    if (sumF > totalF) {
      return { code: 'PAYMENT_EXCEEDS_TOTAL', message: `Payments (${fmt(sumF / 1000)}) exceed total (${fmt(totalF / 1000)})` };
    }
  }
  return null;
}

export function validatePurchaseCreate(input: PurchaseCreateInput): string | null {
  return purchaseCreateIssue(input)?.message ?? null;
}

/** Die Nachschlagestellen des Hauses — immer in der Filiale, deren Bücher dieser Rechner führt. */
export interface PurchaseCreatePort extends EmbeddedProductPort {
  /** Ein Lieferant der Auswahl (aktiv). */
  supplierActive(id: string): boolean;
  /** Ein Artikel der Artikelauswahl (ohne den Reparatur-Service). */
  productPickable(id: string): boolean;
  categoryExists(id: string): boolean;
  employeeActive(id: string): boolean;
  orderExists(id: string): boolean;
  orderLineOf(lineId: string): string | undefined;
  inboxExists(id: string): boolean;
  /** PARTNER-ITEMS — ein aktiver Partner dieser Filiale (nur aktive bekommen eine neue Beteiligung). */
  partnerActive(id: string): boolean;
}

/**
 * Aus den Eingaben der Einkauf, den das Haus anlegt — genau der Satz, den die Maske bisher selbst an
 * `createPurchase` gab (neue Artikel mit ihrer Spec, die Inline-Felder als Rückfall, das Schema und
 * die Vorsteuer je Zeile, die Verknüpfung mit dem Auftrag).
 */
export function planPurchaseCreate(input: PurchaseCreateInput, port: PurchaseCreatePort): Record<string, unknown> {
  const issue = purchaseCreateIssue(input);
  if (issue) throw new PurchaseActionRejected(issue.code, issue.message);
  if (!(PURCHASE_TAX_SCHEMES as readonly string[]).includes(input.taxScheme)) {
    throw new PurchaseActionRejected('INVALID_INPUT', `unknown tax scheme: ${input.taxScheme}`);
  }
  if (!(PURCHASE_PAYMENT_METHODS as readonly string[]).includes(input.paymentMethod)) {
    throw new PurchaseActionRejected('INVALID_INPUT', `unknown payment method: ${input.paymentMethod}`);
  }
  if (!input.supplierId) throw new PurchaseActionRejected('SUPPLIER_REQUIRED', 'Please select a supplier');
  if (!port.supplierActive(input.supplierId)) throw new PurchaseActionRejected('SUPPLIER_NOT_FOUND', 'no such supplier in this branch');
  if (input.staffId && !port.employeeActive(input.staffId)) {
    throw new PurchaseActionRejected('EMPLOYEE_NOT_FOUND', 'no such active employee in this branch');
  }
  if (input.sourceOrderId && !port.orderExists(input.sourceOrderId)) {
    throw new PurchaseActionRejected('ORDER_NOT_FOUND', 'no such order in this branch');
  }
  if (input.inboxId && !port.inboxExists(input.inboxId)) {
    throw new PurchaseActionRejected('INBOX_NOT_FOUND', 'no such inbox photo in this branch');
  }
  const inputVatRate = input.taxScheme === 'VAT_10' ? 10 : 0;
  const lines = input.lines.map((l) => {
    // Eine verknüpfte Auftragsposition gehört zu GENAU dem Auftrag, aus dem die Maske kam.
    if (l.sourceOrderLineId) {
      if (!input.sourceOrderId || port.orderLineOf(l.sourceOrderLineId) !== input.sourceOrderId) {
        throw new PurchaseActionRejected('ORDER_LINE_NOT_ON_ORDER', 'this order line does not belong to the order');
      }
    }
    for (const s of l.partnerShares ?? []) {
      if (!port.partnerActive(s.partnerId)) throw new PurchaseActionRejected('PARTNER_NOT_ACTIVE', 'this partner is not an active partner of this branch');
    }
    const partnerShares = l.partnerShares && l.partnerShares.length > 0
      ? l.partnerShares.map((s) => ({ partnerId: s.partnerId, sharePct: s.sharePct }))
      : undefined;
    if (l.mode === 'bulk') {
      const bulk = checkBulkPurchaseLine(l.bulk);
      return { bulk, quantity: 1, unitPrice: filsToBhd(bulk.lineTotalFils), taxScheme: input.taxScheme, vatRate: inputVatRate };
    }
    if (l.mode === 'existing') {
      if (!l.productId || !port.productPickable(l.productId)) {
        throw new PurchaseActionRejected('PRODUCT_NOT_FOUND', `no such product in this branch: ${l.productId ?? ''}`);
      }
      return {
        productId: l.productId, quantity: l.quantity, unitPrice: l.unitPrice,
        taxScheme: input.taxScheme, vatRate: inputVatRate, sourceOrderLineId: l.sourceOrderLineId, partnerShares,
      };
    }
    const picked = pickProductSpec(l.newProduct, EMBEDDED_PRODUCT_FIELDS);
    const newProduct = picked ? checkEmbeddedProduct(picked, port) : undefined;
    if (!newProduct && l.categoryId && !port.categoryExists(l.categoryId)) {
      throw new PurchaseActionRejected('CATEGORY_NOT_FOUND', 'no such category');
    }
    return {
      newProduct,
      newProductBrand: l.brand,
      newProductName: l.name,
      newProductSku: l.sku || undefined,
      newProductCategoryId: l.categoryId || undefined,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      taxScheme: input.taxScheme,
      vatRate: inputVatRate,
      sourceOrderLineId: l.sourceOrderLineId,
      partnerShares,
    };
  });
  return {
    supplierId: input.supplierId,
    purchaseDate: input.purchaseDate,
    notes: input.notes || undefined,
    staffId: input.staffId || undefined,
    lines,
    initialPayment: input.paymentAmount > 0 ? { amount: input.paymentAmount, method: input.paymentMethod } : undefined,
    sourceOrderId: input.sourceOrderId || undefined,
  };
}

/** Der Rumpf von `purchases.create`, wie ihn die Maske am zweiten Rechner baut. */
export async function purchaseCreateBody(
  input: PurchaseCreateInput, stage: (urls: readonly string[]) => Promise<string[]>,
): Promise<Record<string, unknown>> {
  const lines = [];
  for (const l of input.lines) {
    const line: Record<string, unknown> = {
      mode: l.mode, brand: l.brand, name: l.name, sku: l.sku, categoryId: l.categoryId,
      quantity: l.quantity, unitPrice: l.unitPrice,
    };
    if (l.productId) line.productId = l.productId;
    if (l.mode === 'bulk' && l.bulk) line.bulk = { ...l.bulk };
    if (l.newProduct) line.newProduct = await stageSpecImages(pickProductSpec(l.newProduct, EMBEDDED_PRODUCT_FIELDS), stage);
    if (l.sourceOrderLineId) line.sourceOrderLineId = l.sourceOrderLineId;
    if (l.partnerShares && l.partnerShares.length > 0) {
      line.partnerShares = l.partnerShares.map((s) => ({ partnerId: s.partnerId, sharePct: s.sharePct }));
    }
    lines.push(line);
  }
  const body: Record<string, unknown> = {
    supplierId: input.supplierId, purchaseDate: input.purchaseDate, taxScheme: input.taxScheme, lines,
    paymentAmount: input.paymentAmount, paymentMethod: input.paymentMethod, notes: input.notes, staffId: input.staffId,
  };
  if (input.sourceOrderId) body.sourceOrderId = input.sourceOrderId;
  if (input.inboxId) body.inboxId = input.inboxId;
  return body;
}
