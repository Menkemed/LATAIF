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
import {
  EMBEDDED_PRODUCT_FIELDS, checkEmbeddedProduct, pickProductSpec, stageSpecImages, type EmbeddedProductPort,
} from '@/core/products/embedded-product';

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
  mode: 'existing' | 'new';
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
}

/** Die EINGABEN der Anlegemaske. */
export interface PurchaseCreateInput {
  supplierId: string;
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
  if (!input.supplierId) return { code: 'SUPPLIER_REQUIRED', message: 'Please select a supplier' };
  if (input.lines.length === 0) return { code: 'LINES_REQUIRED', message: 'Please add at least one line' };
  const bad = input.lines.findIndex((l) =>
    l.quantity <= 0 || l.unitPrice < 0
    || (l.mode === 'new' ? (!l.brand || !l.name) : !l.productId));
  if (bad !== -1) {
    return { code: 'LINE_INVALID', message: `Line ${bad + 1}: Brand+Name (oder Product) + Qty > 0 + Price ≥ 0 erforderlich` };
  }
  const total = purchaseTotal(input.lines);
  if (input.paymentAmount < 0) return { code: 'PAYMENT_NEGATIVE', message: 'Payment cannot be negative' };
  if (input.paymentAmount > total) {
    return { code: 'PAYMENT_EXCEEDS_TOTAL', message: `Payment (${fmt(input.paymentAmount)}) exceeds total (${fmt(total)})` };
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
    if (l.mode === 'existing') {
      if (!l.productId || !port.productPickable(l.productId)) {
        throw new PurchaseActionRejected('PRODUCT_NOT_FOUND', `no such product in this branch: ${l.productId ?? ''}`);
      }
      return {
        productId: l.productId, quantity: l.quantity, unitPrice: l.unitPrice,
        taxScheme: input.taxScheme, vatRate: inputVatRate, sourceOrderLineId: l.sourceOrderLineId,
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
    if (l.newProduct) line.newProduct = await stageSpecImages(pickProductSpec(l.newProduct, EMBEDDED_PRODUCT_FIELDS), stage);
    if (l.sourceOrderLineId) line.sourceOrderLineId = l.sourceOrderLineId;
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
