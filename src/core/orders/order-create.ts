// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R5E — einen Auftrag anlegen: EINE Vorbereitung für beide Seiten.
//
// Die Anlegemaske („New Order") baute den Auftrag in der React-Komponente: Produktzeilen mit
// Steuerschema, die Angebotszeile eines Sonderauftrags, Kostenzeilen (Goldschmied, Extra-Gold,
// Diamanten/Steine), das Kundenmaterial, die Kopffelder, Summe und Steuer — und danach, getrennt,
// die Gold-Verbindlichkeit beim Goldschmied. Der Fernbefehl kannte nur den normalen Auftrag.
//
// Jetzt gibt es EINE Vorbereitung (rein, ohne Datenbank): die Maske schickt ihre EINGABEN, das Haus
// leitet daraus ab, was es immer abgeleitet hat — mit denselben Formeln, am Primary wie fern.
// Der Anschluss ans Haus steht in `order-house`.
// ════════════════════════════════════════════════════════════════════════════
import type { CustomOrderMeta, MaterialDetails, OrderStatus, OrderType, Product } from '@/core/models/types';
import { vatEngine } from '@/core/tax/vat-engine';
import { CARD_BRANDS } from '@/core/finance/card-fees';
import {
  EMBEDDED_PRODUCT_FIELDS, FINAL_PRODUCT_FIELDS, checkEmbeddedProduct, pickProductSpec, stageSpecImages,
  type EmbeddedProductPort,
} from '@/core/products/embedded-product';

/** Ein Nein der geteilten Regeln — am Primary eine Absage der Maske, fern ein eingefrorenes Urteil. */
export class OrderActionRejected extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'OrderActionRejected';
  }
}

// ── Der Wortschatz der Maske — Werte, aus denen die Typen folgen ──────────
export const ORDER_TYPES = ['normal', 'custom', 'mixed'] as const;
/** Mit diesen Zuständen beginnt ein Auftrag (Karte „6 · STATUS"). */
export const ORDER_CREATE_STATUSES: readonly OrderStatus[] = ['pending', 'arrived', 'notified', 'completed'];
export const ORDER_PAYMENT_METHODS = ['cash', 'bank', 'card', 'benefit'] as const;
export const ORDER_LINE_SCHEMES = ['auto', 'VAT_10', 'ZERO', 'MARGIN'] as const;
export const ORDER_QUOTE_SCHEMES = ['MARGIN', 'VAT_10', 'ZERO'] as const;
export const GOLD_KARATS = ['24K', '22K', '21K', '18K'] as const;
export const ORDER_MATERIAL_KINDS = ['labor', 'diamond', 'stone', 'gold'] as const;

type LineScheme = typeof ORDER_LINE_SCHEMES[number];
type TaxScheme3 = 'VAT_10' | 'ZERO' | 'MARGIN';

/** Eine Zeile der Maske, wie sie im Formular steht (auch eine leere). */
export interface OrderDraftLine {
  mode: 'existing' | 'new';
  productId?: string;
  newProduct?: Partial<Product>;
  description: string;
  scheme: LineScheme;
  quantity: number;
  /** Netto pro Stück — die Maske rechnet ihn aus dem eingegebenen Brutto zurück. */
  unitPrice: number;
}

/** Eine Kostenposition der Karte „3d" (AddMaterialModal). */
export interface OrderMaterialInput {
  materialKind: typeof ORDER_MATERIAL_KINDS[number];
  description: string;
  quantity: number;
  caratPerPiece?: number;
  weightGrams?: number;
  karat?: string;
  totalCost: number;
  customerPrice?: number;
  supplierId?: string;
}

/** Die EINGABEN der Anlegemaske — nichts, was das Haus ableitet. */
export interface OrderCreateInput {
  customerId: string;
  orderType: OrderType;
  lines: OrderDraftLine[];
  quotedPrice: number;
  customTaxScheme: typeof ORDER_QUOTE_SCHEMES[number];
  finalProductDescription: string;
  customProductSpec?: Partial<Product>;
  customerGoldGrams: number;
  customerGoldKarat: string;
  customerStones: string;
  goldsmithSupplierId: string;
  laborCost: number;
  extraGoldGrams: number;
  extraGoldKarat: string;
  extraGoldCost: number;
  extraGoldSupplierId: string;
  materials: OrderMaterialInput[];
  depositAmount: number;
  paymentMethod: typeof ORDER_PAYMENT_METHODS[number];
  cardBrand: string;
  fullyPaid: boolean;
  expectedDelivery: string;
  status: OrderStatus;
  notes: string;
}

/** Der Zustand der Maske (Textfelder als Text) — in die Eingaben der Vorbereitung. */
export interface OrderCreateFormState extends Omit<OrderCreateInput,
  'quotedPrice' | 'customerGoldGrams' | 'laborCost' | 'extraGoldGrams' | 'extraGoldCost' | 'materials'> {
  quotedPrice: string;
  customerGoldGrams: string;
  laborCost: string;
  extraGoldGrams: string;
  extraGoldCost: string;
  materialLines: Array<OrderMaterialInput & { supplierName?: string; _id?: string }>;
}

const num = (v: string): number => parseFloat(v) || 0;

export function orderCreateInput(f: OrderCreateFormState): OrderCreateInput {
  return {
    customerId: f.customerId,
    orderType: f.orderType,
    lines: f.lines.map((l) => ({
      mode: l.mode, productId: l.productId || undefined, newProduct: l.newProduct, description: l.description,
      scheme: l.scheme, quantity: l.quantity, unitPrice: l.unitPrice,
    })),
    quotedPrice: num(f.quotedPrice),
    customTaxScheme: f.customTaxScheme,
    finalProductDescription: f.finalProductDescription,
    customProductSpec: f.customProductSpec,
    customerGoldGrams: num(f.customerGoldGrams),
    customerGoldKarat: f.customerGoldKarat,
    customerStones: f.customerStones,
    goldsmithSupplierId: f.goldsmithSupplierId,
    laborCost: num(f.laborCost),
    extraGoldGrams: num(f.extraGoldGrams),
    extraGoldKarat: f.extraGoldKarat,
    extraGoldCost: num(f.extraGoldCost),
    extraGoldSupplierId: f.extraGoldSupplierId,
    materials: f.materialLines.map((m) => ({
      materialKind: m.materialKind, description: m.description, quantity: m.quantity,
      caratPerPiece: m.caratPerPiece, weightGrams: m.weightGrams, karat: m.karat,
      totalCost: m.totalCost, customerPrice: m.customerPrice, supplierId: m.supplierId || undefined,
    })),
    depositAmount: f.depositAmount,
    paymentMethod: f.paymentMethod,
    cardBrand: f.cardBrand,
    fullyPaid: f.fullyPaid,
    expectedDelivery: f.expectedDelivery,
    status: f.status,
    notes: f.notes,
  };
}

const wants = (t: OrderType) => ({ product: t === 'normal' || t === 'mixed', custom: t === 'custom' || t === 'mixed' });
const hatProdukt = (l: OrderDraftLine): boolean => !!(l.productId || l.newProduct);

/** Die Prüfung der Maske — wortgleich, damit beide Rechner dasselbe sagen. */
export function validateOrderCreate(input: OrderCreateInput): string | null {
  if (!input.customerId) return 'Please select a customer';
  const w = wants(input.orderType);
  const quote = input.quotedPrice;
  const spec = input.customProductSpec;
  const hasLabel = !!(spec?.brand?.trim() || spec?.name?.trim() || input.finalProductDescription.trim());
  const realLines = input.lines.filter(hatProdukt);

  let msg: string | null = null;
  if (w.custom && !w.product) {
    if (quote <= 0) msg = 'Bitte einen Quoted Price (approx.) angeben';
    else if (!spec?.categoryId) msg = 'Bitte Final Product definieren (Kategorie + Attribute).';
    else if (!hasLabel) msg = 'Bitte mindestens einen Bezeichner setzen (Brand, Name oder Beleg-Bezeichnung).';
  } else if (w.product && !w.custom) {
    if (realLines.length === 0) msg = 'Bitte mindestens einen Artikel waehlen (Existing) oder anlegen (New)';
    else if (realLines.some((l) => l.quantity <= 0)) msg = 'Jeder Artikel braucht eine Menge > 0';
  } else {
    if (realLines.length === 0 && quote <= 0) msg = 'Mixed Order braucht mindestens ein Produkt ODER einen Quoted Price';
    else if (realLines.some((l) => l.quantity <= 0)) msg = 'Jeder Artikel braucht eine Menge > 0';
    else if (quote > 0 && !spec?.categoryId) msg = 'Custom-Teil im Mixed-Order: bitte Final Product definieren (Kategorie + Attribute).';
    else if (quote > 0 && !hasLabel) msg = 'Custom-Teil: bitte mindestens einen Bezeichner setzen (Brand, Name oder Beleg-Bezeichnung).';
  }
  if (msg) return msg;
  // Gold ohne Bewertung: sonst entstuende eine Gold-Verbindlichkeit ohne Kostenzeile.
  if (input.extraGoldGrams > 0 && input.extraGoldCost <= 0) {
    return 'Extra gold: gold price unavailable — please enter the cost (BHD) for the gold manually.';
  }
  return null;
}

/** Die Nachschlagestellen des Hauses — immer in der Filiale, deren Bücher dieser Rechner führt. */
export interface OrderCreatePort extends EmbeddedProductPort {
  /** Ein Kunde der Kundenauswahl (ohne die Platzhalter `sys-…`). */
  customerExists(id: string): boolean;
  product(id: string): {
    id: string; brand: string; name: string; sku?: string; categoryId?: string;
    attributes?: Record<string, unknown>; condition?: string; taxScheme?: string;
  } | undefined;
  /** Ein Lieferant der Auswahl (aktiv). */
  supplier(id: string): { name: string } | undefined;
}

/** Was die Hausfunktion `createOrder` bekommt — und die Gold-Verbindlichkeit, die danach entsteht. */
export interface OrderCreatePlan {
  order: Record<string, unknown>;
  goldPayable?: { supplierId: string; weightGrams: number; karat: string };
}

const today = (): string => new Date().toISOString().split('T')[0];

/**
 * Aus den Eingaben der Maske der Auftrag, den das Haus anlegt. Dieselben Formeln wie bisher die
 * Maske: Steuerschema je Zeile (Auto = das des Artikels), die Angebotszeile (Brutto), Kostenzeilen
 * ohne Kundenpreis, Summe und sichtbare Steuer, Kopffelder aus der ersten Zeile oder der Spec.
 */
export function planOrderCreate(input: OrderCreateInput, port: OrderCreatePort): OrderCreatePlan {
  // Dieselben Wertebereiche wie der Fernbefehl — auch für die Maske des Primary (R5E FINAL).
  assertOrderCreateValues(input);
  const invalid = validateOrderCreate(input);
  if (invalid) throw new OrderActionRejected('ORDER_INVALID', invalid);
  if (!port.customerExists(input.customerId)) throw new OrderActionRejected('CUSTOMER_NOT_FOUND', 'no such client in this branch');
  // Jeder genannte Lieferant ist einer der Auswahl — auch der des Kopfes, der immer gespeichert wird.
  for (const sid of [input.goldsmithSupplierId, input.extraGoldSupplierId, ...input.materials.map((m) => m.supplierId ?? '')]) {
    if (sid && !port.supplier(sid)) throw new OrderActionRejected('SUPPLIER_NOT_FOUND', 'no such supplier in this branch');
  }
  const w = wants(input.orderType);
  const productOf = (l: OrderDraftLine) => {
    if (!l.productId) return undefined;
    const p = port.product(l.productId);
    if (!p) throw new OrderActionRejected('PRODUCT_NOT_FOUND', `no such product in this branch: ${l.productId}`);
    return p;
  };
  const checkSpec = (spec: Partial<Product> | undefined, fields: readonly string[]) => {
    const picked = pickProductSpec(spec, fields);
    return picked ? checkEmbeddedProduct(picked, port) : undefined;
  };

  // Je Zeile: Schema (Auto → das des Artikels bzw. des neuen Artikels, sonst MARGIN) und die
  // SICHTBARE Steuer — für MARGIN ist sie 0, die Margensteuer entsteht erst auf der Rechnung.
  const lines = input.lines.map((l) => {
    const product = productOf(l);
    const newProduct = l.newProduct ? checkSpec(l.newProduct, EMBEDDED_PRODUCT_FIELDS) : undefined;
    const fallback = ((product?.taxScheme || newProduct?.taxScheme) as TaxScheme3) || 'MARGIN';
    const scheme: TaxScheme3 = l.scheme === 'auto' ? fallback : l.scheme;
    const vatRate = scheme === 'ZERO' ? 0 : 10;
    const vat = vatEngine.calculateNet(l.unitPrice * l.quantity, 0, scheme, vatRate).vatAmount;
    return { l, product, newProduct, scheme, vatRate, vat };
  });

  const quoteGross = w.custom ? input.quotedPrice : 0;
  const quoteNet = input.customTaxScheme === 'VAT_10' ? quoteGross / 1.10 : quoteGross;
  const quoteVat = input.customTaxScheme === 'VAT_10' ? quoteGross - quoteNet : 0;
  const totalVat = lines.reduce((s, c) => s + c.vat, 0) + quoteVat;

  const productLines = w.product ? lines.filter((c) => hatProdukt(c.l)).map((c) => ({
    productId: c.l.productId,
    newProduct: c.newProduct,
    description: c.l.description,
    quantity: c.l.quantity,
    unitPrice: c.l.unitPrice,
    taxScheme: c.scheme,
    vatRate: c.vatRate,
  })) : [];

  const spec = w.custom ? checkSpec(input.customProductSpec, FINAL_PRODUCT_FIELDS) : undefined;
  const supplierName = (id: string | undefined): string | undefined => (id ? port.supplier(id)?.name : undefined);
  const customLines: Array<Record<string, unknown>> = [];
  if (w.custom) {
    // Die Angebotszeile — die einzige kundenseitige Position des Sonderteils, IMMER brutto.
    if (input.quotedPrice > 0) {
      const desc = (spec?.brand && spec?.name)
        ? `${spec.brand} ${spec.name}`.trim()
        : (input.finalProductDescription.trim() || 'Custom Order');
      customLines.push({
        description: desc, quantity: 1, unitPrice: input.quotedPrice,
        taxScheme: input.customTaxScheme, vatRate: input.customTaxScheme === 'ZERO' ? 0 : 10,
        isCustomerFacing: true, materialKind: 'custom', costAmount: 0,
      });
    }
    // Goldschmied-Arbeit — reine Kostenposition.
    if (input.laborCost > 0) {
      const sup = supplierName(input.goldsmithSupplierId);
      customLines.push({
        description: `Goldsmith Labor${sup ? ' — ' + sup : ''}`, quantity: 1, unitPrice: 0,
        supplierId: input.goldsmithSupplierId || undefined, costAmount: input.laborCost,
        isCustomerFacing: false, materialKind: 'labor',
      });
    }
    // Extra-Gold — Kostenposition; ihr Lieferant steht NIE an der Zeile (die Schuld in Gramm
    // lebt in der Gold-Verbindlichkeit, sonst stuende dasselbe Geld zweimal offen).
    if (input.extraGoldGrams > 0) {
      const sup = supplierName(input.extraGoldSupplierId);
      customLines.push({
        description: `Extra Gold ${input.extraGoldGrams.toFixed(3)}g ${input.extraGoldKarat}${sup ? ' — ' + sup : ''}`.trim(),
        quantity: 1, unitPrice: 0, costAmount: input.extraGoldCost, isCustomerFacing: false, materialKind: 'gold',
        materialDetails: { weightGrams: input.extraGoldGrams, karat: input.extraGoldKarat, supplierName: sup } as MaterialDetails,
      });
    }
    // Diamanten / Steine / Goldteile — Kostenpositionen.
    for (const m of input.materials) {
      const sup = supplierName(m.supplierId);
      const ct = (m.materialKind === 'diamond' || m.materialKind === 'stone')
        ? `${m.quantity}× ${(m.caratPerPiece || 0).toFixed(2)}ct ` : '';
      customLines.push({
        description: `${ct}${m.description}${sup ? ' — ' + sup : ''}`, quantity: 1, unitPrice: 0,
        supplierId: m.supplierId, costAmount: m.totalCost, isCustomerFacing: false, materialKind: m.materialKind,
        materialDetails: {
          ct: m.caratPerPiece, qty: m.quantity, description: m.description, karat: m.karat,
          weightGrams: m.weightGrams, supplierName: sup,
        } as MaterialDetails,
      });
    }
  }
  const allLines = [...productLines, ...customLines];

  const customMeta: CustomOrderMeta | undefined = w.custom ? {
    customerGoldWeight: input.customerGoldGrams > 0 ? input.customerGoldGrams : undefined,
    customerGoldKarat: input.customerGoldGrams > 0 ? input.customerGoldKarat : undefined,
    customerStones: input.customerStones.trim() || undefined,
    finalProductDescription: input.finalProductDescription.trim() || undefined,
    customerMaterialReceivedAt: input.customerGoldGrams > 0 ? today() : undefined,
    diamondDetails: input.materials
      .filter((m) => m.materialKind === 'diamond' || m.materialKind === 'stone')
      .map((m) => ({
        description: m.description, quantity: m.quantity, caratPerPiece: m.caratPerPiece || 0,
        totalCost: m.totalCost, customerPrice: m.customerPrice ?? m.totalCost, supplierId: m.supplierId,
      })),
  } : undefined;

  const productLinesTotal = productLines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
  const grandTotal = productLinesTotal + (w.custom ? input.quotedPrice : 0);
  // Die Kopffelder aus der ERSTEN Zeile der Maske — oder, beim reinen Sonderauftrag, aus der Spec.
  const first = lines[0];
  const product = first?.product;
  const heroBrand = w.custom && !w.product
    ? (spec?.brand?.trim() || 'Custom Order')
    : (product?.brand || first?.l.description.split(' ')[0] || (input.orderType === 'mixed' ? 'Mixed Order' : ''));
  const heroModel = w.custom && !w.product
    ? (spec?.name?.trim() || input.finalProductDescription.trim() || 'Sonderanfertigung')
    : (product?.name || first?.l.description || (input.orderType === 'mixed' ? `${allLines.length} positions` : ''));
  const deposit = input.fullyPaid ? grandTotal : input.depositAmount;
  const paid = input.depositAmount > 0 || input.fullyPaid;

  const order: Record<string, unknown> = {
    customerId: input.customerId,
    lines: allLines,
    customMeta,
    customProductSpec: w.custom ? spec : undefined,
    goldsmithSupplierId: input.goldsmithSupplierId || undefined,
    laborCost: input.laborCost,
    extraGoldValue: input.extraGoldCost,
    requestedBrand: heroBrand,
    requestedModel: heroModel,
    requestedReference: !w.custom ? product?.sku : spec?.sku,
    requestedDetails: input.customerGoldGrams > 0
      ? `Customer-Gold ${input.customerGoldGrams}g ${input.customerGoldKarat}`
      : (allLines.length > 1 ? `${allLines.length} positions` : undefined),
    categoryId: w.custom ? spec?.categoryId : product?.categoryId,
    attributes: w.custom ? spec?.attributes : product?.attributes,
    condition: w.custom ? spec?.condition : product?.condition,
    existingProductId: !w.custom ? product?.id : undefined,
    agreedPrice: grandTotal,
    taxAmount: totalVat,
    depositAmount: deposit,
    depositPaid: paid,
    depositDate: paid ? today() : undefined,
    paymentMethod: input.paymentMethod,
    cardBrand: input.paymentMethod === 'card' ? input.cardBrand : undefined,
    fullyPaid: input.fullyPaid,
    expectedDelivery: input.expectedDelivery || undefined,
    status: input.status,
    notes: input.notes || undefined,
  };
  const goldPayable = input.extraGoldSupplierId && input.extraGoldGrams > 0
    ? { supplierId: input.extraGoldSupplierId, weightGrams: input.extraGoldGrams, karat: input.extraGoldKarat }
    : undefined;
  return { order, goldPayable };
}

/** Die Wertebereiche der Eingaben — dieselben, die die Maske anbietet. */
export function assertOrderCreateValues(input: OrderCreateInput): void {
  const bad = (m: string): never => { throw new OrderActionRejected('INVALID_INPUT', m); };
  if (!(ORDER_TYPES as readonly string[]).includes(input.orderType)) bad(`unknown order type: ${input.orderType}`);
  if (!ORDER_CREATE_STATUSES.includes(input.status)) bad(`an order cannot start as ${input.status}`);
  if (!(ORDER_PAYMENT_METHODS as readonly string[]).includes(input.paymentMethod)) bad(`unknown payment method: ${input.paymentMethod}`);
  if (!(CARD_BRANDS as readonly string[]).includes(input.cardBrand)) bad(`unknown card brand: ${input.cardBrand}`);
  if (!(ORDER_QUOTE_SCHEMES as readonly string[]).includes(input.customTaxScheme)) bad(`unknown tax scheme: ${input.customTaxScheme}`);
  for (const k of [input.customerGoldKarat, input.extraGoldKarat]) {
    if (!(GOLD_KARATS as readonly string[]).includes(k)) bad(`unknown karat: ${k}`);
  }
  for (const [n, v] of [['quotedPrice', input.quotedPrice], ['customerGoldGrams', input.customerGoldGrams],
    ['laborCost', input.laborCost], ['extraGoldGrams', input.extraGoldGrams], ['extraGoldCost', input.extraGoldCost],
    ['depositAmount', input.depositAmount]] as Array<[string, number]>) {
    if (!Number.isFinite(v) || v < 0) bad(`${n} must be a number of at least 0`);
  }
  for (const l of input.lines) {
    if (!(ORDER_LINE_SCHEMES as readonly string[]).includes(l.scheme)) bad(`unknown line tax scheme: ${l.scheme}`);
    if (!Number.isInteger(l.quantity) || l.quantity < 1) bad('a line quantity is a whole number of at least 1');
    if (!Number.isFinite(l.unitPrice) || l.unitPrice < 0) bad('a line price must be a number of at least 0');
  }
  for (const m of input.materials) {
    if (!(ORDER_MATERIAL_KINDS as readonly string[]).includes(m.materialKind)) bad(`unknown material: ${m.materialKind}`);
    if (!Number.isFinite(m.totalCost) || m.totalCost < 0) bad('a material cost must be a number of at least 0');
  }
}

/**
 * Der Rumpf von `orders.create`, wie ihn die Maske am zweiten Rechner baut: die Eingaben, die
 * Fotos der Artikel-Entwürfe als Kennungen der Zwischenablage.
 */
export async function orderCreateBody(
  input: OrderCreateInput, stage: (urls: readonly string[]) => Promise<string[]>,
): Promise<Record<string, unknown>> {
  const lines = [];
  for (const l of input.lines) {
    const line: Record<string, unknown> = {
      mode: l.mode, description: l.description, scheme: l.scheme, quantity: l.quantity, unitPrice: l.unitPrice,
    };
    if (l.productId) line.productId = l.productId;
    if (l.newProduct) line.newProduct = await stageSpecImages(pickProductSpec(l.newProduct, EMBEDDED_PRODUCT_FIELDS), stage);
    lines.push(line);
  }
  const body: Record<string, unknown> = { ...input, lines };
  if (input.customProductSpec) {
    body.customProductSpec = await stageSpecImages(pickProductSpec(input.customProductSpec, FINAL_PRODUCT_FIELDS), stage);
  } else {
    delete body.customProductSpec;
  }
  return body;
}
