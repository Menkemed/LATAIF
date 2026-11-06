// ════════════════════════════════════════════════════════════════════════════
// CUSTOM-ORDER K2 — „Create Invoice" eines Auftrags: EINE Hausfolge für Primary und PC2.
//
// Vorher rechnete die Auftragsansicht am Primary selbst — mit dem Rechnungsdatum „jetzt", den Artikel
// eines Sonderstücks VOR der Klammer angelegt (ohne SKU, nicht mit der Order verknüpft: bei einem
// Fehler blieb eine Waise, nach Storno + erneuter Umwandlung entstand ein zweiter Artikel), die
// Anzahlung NACH der Klammer übertragen. Der Fernbefehl lehnte ein Sonderstück ganz ab.
//
// Jetzt, in genau einer Klammer des Aufrufers (runOnPrimary bzw. runRemoteCommand):
//   1. prüfen — VOR jedem Schreiben: Auftrag, fertige Positionen, gezeigte = abzurechnende Positionen,
//      Rechnungsdatum (gültig, nicht künftig; das VAT-Quartal prüft die Rechnung selbst), die Kosten des
//      Sonderstücks (vorhanden und angekommen), seine Kategorie (vorhanden, aktiv, mit SKU-Kürzel — nie ITM-GEN),
//      die Anzahlung;
//   2. den Artikel des Sonderstücks anlegen oder WIEDERVERWENDEN — mit SKU aus dem Zähler, der Kategorie
//      der Order, den Bildern der Order, Einstand = Kosten der Order — und an Zeile und Order binden;
//   3. die Zeilen rechnen (Brutto bleibt bei jeder Steuerart; die der Order ist nur Vorauswahl);
//   4. Rechnung zum gewählten Datum, Zeilen und Order verknüpfen, ggf. „abschließen";
//   5. die Anzahlung ANRECHNEN (order-deposit-apply) — am Rechnungstag, ohne Geldbewegung.
// Ein Fehler an irgendeiner Stelle rollt alles zurück: keine Rechnung, kein Artikel, keine Anrechnung.
// ════════════════════════════════════════════════════════════════════════════
import { query } from '@/core/db/helpers';
import { getDatabase } from '@/core/db/database';
import { trackUpdate } from '@/core/sync/track';
import { useOrderStore } from '@/stores/orderStore';
import { useProductStore } from '@/stores/productStore';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { useOrderPaymentStore } from '@/stores/orderPaymentStore';
import { businessDateIssue } from '@/core/utils/business-date';
import { skuCategoryCode, skuIsEmpty } from '@/core/products/sku-allocation';
import { canonicalTaxScheme, type Order, type OrderLine, type Product, type TaxScheme } from '@/core/models/types';
import { buildOrderInvoiceLines, markConvertedLinesDelivered, orderCustomCostBasis } from './order-invoice-lines';
import { OrderActionRejected } from './order-create';
import { watchLedgerPosts } from '@/core/ledger/posting';
import { adoptOrderPhotosToProduct } from './order-media';
import { assertOrderCarryOverMayFinalize, carryOverOrderPaymentsToInvoice } from './order-payment-carryover';
import { OPEN_DEPOSIT_TOTAL_SQL } from './order-deposit-sql';
import { vatEngine } from '@/core/tax/vat-engine';

export interface OrderConvertRequest {
  orderId: string;
  /** Steuerart je abzurechnender Position (die Wahl im Dialog); fehlt eine, gilt die der Position. */
  taxSchemes?: Record<string, TaxScheme>;
  specialMark?: boolean;
  markComplete?: boolean;
  /** Rechnungsdatum JJJJ-MM-TT; leer = heute. */
  invoiceDate?: string;
  /**
   * CUSTOM-ORDER Review — der ALTWEG: ein Auftrag ohne gespeicherte Steuerart je Position wird als EINE Rechnungszeile
   * über den vereinbarten Preis abgerechnet; dies ist die im Dialog gewählte Steuerart dieser Zeile. Schließt `taxSchemes` aus.
   */
  legacyScheme?: TaxScheme;
}

export interface OrderConverted {
  orderId: string;
  invoiceId: string;
  invoiceNumber: string;
  grossAmount: number;
  invoicedLines: number;
  productIds: string[];
  revision: number;
}

const EPS = 0.0005;
const nein = (code: string, msg: string): OrderActionRejected => new OrderActionRejected(code, `${msg} Nothing was changed.`);

/** Der Zeitpunkt der Rechnung: heute = jetzt; ein anderer Tag = dieser Tag 00:00 UTC (wie createDirectInvoice). */
export function invoiceTimestamp(day: string | undefined, nowIso: string): string {
  if (!day || day === nowIso.slice(0, 10)) return nowIso;
  return `${day}T00:00:00.000Z`;
}

/** Was für die Umwandlung gilt — nur lesend; wirft ein fachliches Nein vor jedem Schreiben. */
function planConvert(req: OrderConvertRequest, branchId: string) {
  const order = query('SELECT id, customer_id, status, order_number, branch_id FROM orders WHERE id = ? AND branch_id = ?', [req.orderId, branchId])[0];
  if (!order) throw nein('ORDER_NOT_FOUND', 'No such order in this branch.');
  if (String(order.status) === 'cancelled') throw nein('ORDER_CANCELLED', 'A cancelled order is not invoiced.');
  const customerId = String(order.customer_id ?? '');
  if (!customerId) throw nein('ORDER_HAS_NO_CUSTOMER', 'This order has no client.');
  const os = useOrderStore.getState();
  os.loadOrders();
  const billable = os.getBillableLines(req.orderId);
  if (billable.length === 0) {
    // Nichts mehr offen und schon berechnet → das ist ein zweiter Versuch, kein „noch nicht angekommen".
    const berechnet = query("SELECT COUNT(*) AS n FROM order_lines WHERE order_id = ? AND invoice_id IS NOT NULL AND status <> 'CANCELLED'", [req.orderId])[0];
    if (Number(berechnet?.n ?? 0) > 0) throw nein('ORDER_ALREADY_INVOICED', 'Everything on this order is already on an invoice.');
  }
  if (billable.length === 0) throw nein('ORDER_NOTHING_BILLABLE', 'Nothing on this order is ready to invoice yet — mark the items as "Arrived" first.');
  // CUSTOM-ORDER Review — Altweg nur für einen Auftrag OHNE gespeicherte Steuerarten, und nie zusammen mit `taxSchemes`.
  if (req.legacyScheme !== undefined) {
    if (req.taxSchemes) throw nein('ORDER_CONVERT_MODE_INVALID', 'Either the tax scheme per line or the one scheme of an old order — not both.');
    if (billable.every((l) => !!l.taxScheme)) {
      throw nein('ORDER_HAS_TAX_SCHEMES', 'This order keeps a tax scheme per line — it is invoiced line by line. Reload the order.');
    }
  }
  if (req.taxSchemes) {
    const gezeigt = Object.keys(req.taxSchemes).sort().join('|');
    const faellig = billable.map((l) => l.id).sort().join('|');
    if (gezeigt !== faellig) throw nein('ORDER_LINES_CHANGED', 'The lines to invoice are not the ones that were confirmed — reload the order.');
  }
  const day = req.invoiceDate ? String(req.invoiceDate).slice(0, 10) : undefined;
  const dateIssue = businessDateIssue(day, 'The invoice date');
  if (dateIssue) throw nein('INVOICE_DATE_INVALID', `${dateIssue}.`);
  const auftrag = os.getOrder(req.orderId);
  if (!auftrag) throw nein('ORDER_NOT_FOUND', 'No such order in this branch.');
  const allLines = os.getOrderLines(req.orderId);
  const customLine = billable.find((l) => l.materialKind === 'custom');
  const costBasis = orderCustomCostBasis(allLines);
  if (customLine) {
    // v0.6.7 — ohne Kosten ginge der ganze Preis als Marge durch (COGS 0, Lagerwert falsch).
    if (costBasis <= EPS) {
      throw nein('CUSTOM_COSTS_MISSING', 'The custom piece has no costs recorded yet — enter labour / material / gold via "Add Cost" first.');
    }
    // K1 — der Wareneinsatz der Rechnung darf nur Kosten tragen, die schon gebucht (angekommen) sind.
    const offen = allLines.filter((l) => l.isCustomerFacing === false && l.status !== 'CANCELLED'
      && l.status !== 'ARRIVED' && l.status !== 'DELIVERED' && (l.costAmount || 0) > EPS);
    if (offen.length > 0) {
      throw nein('CUSTOM_COSTS_NOT_ARRIVED', `${offen.length} cost line(s) of this order have not arrived yet — their cost is not booked. Mark them as arrived first.`);
    }
    if (!customLine.productId) assertCustomPieceCategory(auftrag);
  }
  // CUSTOM-ORDER Abschluss — der Altweg legt den Artikel eines Sonderstücks ebenfalls neu an (ohne verknüpften Artikel):
  // dieselbe Prüfung VOR jedem Schreiben, auch wenn der alte Auftrag keine Sonderstück-Zeile führt.
  if (req.legacyScheme !== undefined && !(auftrag.productId || auftrag.existingProductId)
    && (auftrag.type === 'custom' || billable.some((l) => l.materialKind === 'custom'))) {
    assertCustomPieceCategory(auftrag);
  }
  // Steuerart je Position: die Wahl im Dialog, sonst die festgehaltene, sonst die des Artikels.
  const schemes: Record<string, TaxScheme> = {};
  for (const l of billable) {
    const p = l.productId ? query('SELECT tax_scheme FROM products WHERE id = ?', [l.productId])[0] : undefined;
    schemes[l.id] = req.taxSchemes?.[l.id] ?? (canonicalTaxScheme(String(l.taxScheme ?? p?.tax_scheme ?? 'ZERO')) as TaxScheme);
  }
  return { order, customerId, billable, auftrag, schemes, costBasis, day };
}

/**
 * CUSTOM-ORDER Abschluss — die Kategorie eines NEU anzulegenden Sonderstücks, geprüft VOR jedem Schreiben (neuer Weg und
 * Altweg, Primary und PC2): vorhanden, aktiv und mit eigenem SKU-Kürzel (Gold-Diamond Jewellery → ITM-GLD). Ohne sie gäbe
 * der Zähler still `ITM-GEN` — das ist ausgeschlossen. Eine an der Order eingetragene SKU muss frei sein und wird dann
 * übernommen. Ein schon verknüpfter Artikel (erneute Umwandlung nach Storno) behält seine SKU und wird hier nicht geprüft.
 */
function assertCustomPieceCategory(auftrag: Order): void {
  const spec = auftrag.customProductSpec || {};
  const catId = String(spec.categoryId || auftrag.categoryId || '');
  const cat = catId ? query('SELECT id, name, active FROM categories WHERE id = ?', [catId])[0] : undefined;
  if (!cat) {
    throw nein('CUSTOM_CATEGORY_MISSING',
      'The custom piece has no category — without it the item would get no ITM-GLD number. Set the category on the order (product details) first.');
  }
  const name = String(cat.name ?? catId);
  if (Number(cat.active ?? 1) === 0) {
    throw nein('CUSTOM_CATEGORY_INACTIVE', `The category "${name}" of the custom piece is inactive — choose an active one on the order first.`);
  }
  if (!skuIsEmpty(spec.sku)) {
    // Eine in der Order eingetragene SKU muss frei sein (sonst stünde das Nein erst mitten im Schreiben).
    if (useProductStore.getState().isSkuTaken(String(spec.sku))) {
      throw nein('SKU_TAKEN', `The SKU ${String(spec.sku)} entered on the order is already used by another item — change it on the order first.`);
    }
    return;
  }
  if (skuCategoryCode(catId) === 'GEN') {
    throw nein('CUSTOM_CATEGORY_NO_SKU_CODE',
      `The category "${name}" has no SKU code — the custom piece would be numbered ITM-GEN. Choose a jewellery category on the order (Gold-Diamond Jewellery → ITM-GLD) or enter a SKU there first.`);
  }
}

/**
 * CUSTOM-ORDER Review — die SKU eines Artikels, der aus einer Order entsteht. Ein Sonderstück (Custom Order) hat keine
 * Marke: „Custom Order" ist seine HERKUNFT, nicht sein Hersteller — darum der markenlose Stamm `ITM-<Kategorie>` (Owner:
 * ITM-GLD-nnn), aus dem zentralen Zähler. Eine eingetragene SKU bleibt; ist sie vergeben, kommt das Nein vor jedem Schreiben.
 */
export function orderProductSku(data: Partial<Product>, customPiece: boolean): string | undefined {
  const ps = useProductStore.getState();
  if (!skuIsEmpty(data.sku)) return String(data.sku);
  return ps.allocateSkuOnCreate(undefined, customPiece ? '' : String(data.brand ?? ''), String(data.categoryId ?? '')) || undefined;
}

/** Herkunft am Artikel festschreiben (einmal; eine schon gesetzte Herkunft bleibt). */
export function stampOrderOrigin(productId: string, orderId: string, customPiece: boolean): void {
  const o = query('SELECT order_number FROM orders WHERE id = ?', [orderId])[0];
  const originType = customPiece ? 'CUSTOM_ORDER' : 'ORDER';
  const originOrderNumber = String(o?.order_number ?? '');
  const db = getDatabase();
  db.run(
    `UPDATE products SET origin_type = ?, origin_order_id = ?, origin_order_number = ?
      WHERE id = ? AND origin_type IS NULL`,
    [originType, orderId, originOrderNumber, productId],
  );
  trackUpdate('products', productId, { originType, originOrderId: orderId, originOrderNumber });
}

/** Der Artikel eines Sonderstücks: anlegen (SKU, Kategorie, Bilder), Herkunft festschreiben, an Zeile + Order binden. */
function createCustomPieceProduct(data: Partial<Product>, line: OrderLine, orderId: string): Product {
  const ps = useProductStore.getState();
  const custom = line.materialKind === 'custom';
  const prod = ps.createProduct({ ...data, sku: orderProductSku(data, custom) });
  stampOrderOrigin(prod.id, orderId, custom);
  const db = getDatabase();
  db.run('UPDATE order_lines SET product_id = ? WHERE id = ?', [prod.id, line.id]);
  trackUpdate('order_lines', line.id, { productId: prod.id });
  if (custom) {
    // MEDIA-ORDER §7 — die Vorlage der Order wird Artikelbild (dasselbe Medienobjekt, neue Verknüpfung).
    adoptOrderPhotosToProduct(orderId, prod.id);
    useOrderStore.getState().updateOrder(orderId, { productId: prod.id } as never);
  }
  return prod;
}

/**
 * CUSTOM-ORDER Review — der Altweg (Auftrag ohne Steuerart je Position, vor v0.1.15): EINE Rechnungszeile über den
 * vereinbarten Preis (sonst die offene Anzahlung), Steuerart aus dem Dialog, Brutto bleibt. Der Artikel entsteht erst HIER
 * — in derselben Klammer wie Rechnung, Verknüpfung und Anrechnung —, nicht mehr vor dem Dialog; ein schon verknüpfter wird
 * wiederverwendet (kein zweiter nach Storno + erneuter Umwandlung).
 */
function convertLegacyInHouse(req: OrderConvertRequest, plan: ReturnType<typeof planConvert>, beforeWrite?: () => void): OrderConverted {
  const nowIso = new Date().toISOString();
  const issuedAt = invoiceTimestamp(plan.day, nowIso);
  const os = useOrderStore.getState();
  const ps = useProductStore.getState();
  ps.loadProducts();
  const auftrag = plan.auftrag;
  const scheme = canonicalTaxScheme(String(req.legacyScheme)) as TaxScheme;
  const rate = scheme === 'ZERO' ? 0 : 10;
  const offen = Number(query(OPEN_DEPOSIT_TOTAL_SQL, [req.orderId])[0]?.t ?? 0) || 0;
  const gross = Math.round(((auftrag.agreedPrice || 0) > EPS ? (auftrag.agreedPrice || 0) : offen) * 1000) / 1000;
  if (gross <= EPS) throw nein('ORDER_PRICE_MISSING', 'The order has no agreed price — set it on the order first.');
  const customPiece = auftrag.type === 'custom' || plan.billable.some((l) => l.materialKind === 'custom');
  const linkedId = auftrag.productId || auftrag.existingProductId;
  const linked = linkedId ? useProductStore.getState().products.find((p) => p.id === linkedId) : undefined;
  if (linkedId && !linked) throw nein('ORDER_PRODUCT_MISSING', 'The item linked to this order no longer exists — link it again.');
  const spec = auftrag.customProductSpec || {};
  const newCost = plan.costBasis > EPS ? plan.costBasis : (auftrag.supplierPrice || 0);
  const data: Partial<Product> = linked ? {} : {
    categoryId: spec.categoryId || auftrag.categoryId || '',
    brand: spec.brand || auftrag.requestedBrand || '',
    name: spec.name || auftrag.requestedModel || auftrag.requestedBrand || 'Custom Item',
    sku: spec.sku,
    condition: spec.condition || auftrag.condition || '',
    attributes: (spec.attributes as Record<string, string | number | boolean | string[]>) || auftrag.attributes || {},
    images: spec.images || [],
    scopeOfDelivery: spec.scopeOfDelivery || [],
    purchasePrice: newCost,
    plannedSalePrice: auftrag.agreedPrice,
    stockStatus: 'reserved',
    taxScheme: scheme,
    sourceType: 'OWN',
    supplierName: auftrag.supplierName,
    notes: spec.notes || (auftrag.requestedDetails ? `From order ${auftrag.orderNumber}: ${auftrag.requestedDetails}` : `From order ${auftrag.orderNumber}`),
  };
  if (!linked && !skuIsEmpty(spec.sku) && useProductStore.getState().isSkuTaken(String(spec.sku))) {
    throw nein('SKU_TAKEN', `The SKU ${String(spec.sku)} entered on the order is already used by another item — change it on the order first.`);
  }
  // Einstand der Zeile: der eines verknüpften Artikels (ein Sonderstück folgt den Order-Kosten), sonst der neue.
  const cost = linked ? (plan.costBasis > EPS && auftrag.productId === linked.id ? plan.costBasis : (linked.purchasePrice || 0)) : newCost;
  const calc = scheme === 'VAT_10' ? vatEngine.calculateStandardVAT(gross, rate) : vatEngine.calculateNet(gross, cost, scheme, rate);
  assertOrderCarryOverMayFinalize(req.orderId, calc.grossAmount, undefined, issuedAt);
  beforeWrite?.();
  const check = watchLedgerPosts('orders.convert_to_invoice');

  let prod: Product;
  if (linked) {
    prod = linked;
    if (Math.abs((linked.purchasePrice || 0) - cost) > EPS) {
      useProductStore.getState().updateProduct(linked.id, { purchasePrice: cost });
      useProductStore.getState().loadProducts();
    }
  } else {
    prod = ps.createProduct({ ...data, sku: orderProductSku(data, customPiece) });
    stampOrderOrigin(prod.id, req.orderId, customPiece);
    // MEDIA-ORDER §7 — die Vorlage des Auftrags wird Artikelbild (dasselbe Medienobjekt, neue Verknüpfung).
    adoptOrderPhotosToProduct(req.orderId, prod.id);
    os.updateOrder(req.orderId, { productId: prod.id } as never);
  }
  // Die Sonderstück-Zeile zeigt auf ihren Artikel (wie im neuen Weg) — sonst fände eine spätere Goldschuld-Begleichung
  // (K3a) die verkaufte Rechnungszeile nicht.
  for (const l of plan.billable) {
    if (l.materialKind !== 'custom' || l.productId) continue;
    getDatabase().run('UPDATE order_lines SET product_id = ? WHERE id = ?', [prod.id, l.id]);
    trackUpdate('order_lines', l.id, { productId: prod.id });
  }
  os.assertOrderLinesBillable(plan.billable.map((l) => l.id));
  const invoice = useInvoiceStore.getState().createDirectInvoice(
    plan.customerId,
    [{ productId: prod.id, quantity: 1, unitPrice: calc.netAmount, purchasePrice: cost, taxScheme: scheme, vatRate: rate,
       vatAmount: calc.internalVatAmount ?? calc.vatAmount, lineTotal: calc.grossAmount }] as never,
    `Final invoice for order ${String(plan.order.order_number ?? '')}`,
    plan.day && plan.day !== nowIso.slice(0, 10) ? plan.day : undefined, undefined, undefined, req.specialMark === true,
  );
  if (!invoice?.id) throw new Error('orders.convert_to_invoice: the invoice was not created');
  os.markOrderLinesInvoiced(plan.billable.map((l) => l.id), invoice.id);
  os.updateOrder(req.orderId, { invoiceId: invoice.id } as never);
  if (req.markComplete) markConvertedLinesDelivered(plan.billable, os.updateOrderLineStatus);
  const invGross = Number(query('SELECT gross_amount FROM invoices WHERE id = ?', [invoice.id])[0]?.gross_amount ?? 0);
  carryOverOrderPaymentsToInvoice(invoice.id, req.orderId, String(plan.order.order_number ?? ''), invGross, undefined, issuedAt);
  check();
  useOrderStore.getState().loadOrders();
  useInvoiceStore.getState().loadInvoices();
  useProductStore.getState().loadProducts();
  useOrderPaymentStore.getState().loadPayments(req.orderId);
  const inv = query('SELECT invoice_number, gross_amount FROM invoices WHERE id = ?', [invoice.id])[0];
  return {
    orderId: req.orderId, invoiceId: invoice.id, invoiceNumber: String(inv?.invoice_number ?? ''),
    grossAmount: Number(inv?.gross_amount ?? 0), invoicedLines: plan.billable.length, productIds: [prod.id],
    revision: Number(query('SELECT revision FROM orders WHERE id = ?', [req.orderId])[0]?.revision ?? 0),
  };
}

/**
 * Wandelt die fertigen Positionen eines Auftrags in eine Rechnung — in der Klammer des Aufrufers.
 * `beforeWrite` ist der letzte Wächter vor dem ersten Schreiben (fern: Fassung).
 */
export function convertOrderToInvoiceInHouse(req: OrderConvertRequest, branchId: string, beforeWrite?: () => void): OrderConverted {
  const plan = planConvert(req, branchId);
  if (req.legacyScheme !== undefined) return convertLegacyInHouse(req, plan, beforeWrite);
  const nowIso = new Date().toISOString();
  const issuedAt = invoiceTimestamp(plan.day, nowIso);
  const os = useOrderStore.getState();
  const ps = useProductStore.getState();
  ps.loadProducts();

  // Brutto der Rechnung VOR dem ersten Schreiben: dieselbe Zeilenrechnung mit einem Probe-Artikel für ein noch
  // nicht angelegtes Sonderstück (Einstand = Kosten der Order) — für die Anzahlungs-/VAT-Prüfung.
  const probe = buildOrderInvoiceLines({
    order: plan.auftrag, billableLines: plan.billable, perLineSchemes: plan.schemes, customCostBasis: plan.costBasis,
    findProduct: (pid) => useProductStore.getState().products.find((p) => p.id === pid),
    createProduct: (data) => ({ ...(data as Product), id: 'probe', purchasePrice: Number(data.purchasePrice ?? 0) }),
  });
  const probeGross = Math.round(probe.reduce((s, l) => s + l.lineTotal, 0) * 1000) / 1000;
  assertOrderCarryOverMayFinalize(req.orderId, probeGross, undefined, issuedAt);
  beforeWrite?.();
  // Jede Buchung dieser Folge ist Teil der Umwandlung — auch eine, die ein Unterschritt abfängt (z. B. „abschließen").
  const check = watchLedgerPosts('orders.convert_to_invoice');

  // Ein schon verknüpfter Artikel (erneute Umwandlung nach Storno) trägt den aktuellen Einstand der Order.
  const customLine = plan.billable.find((l) => l.materialKind === 'custom');
  if (customLine?.productId) {
    const p = useProductStore.getState().products.find((x) => x.id === customLine.productId);
    if (p && Math.abs((p.purchasePrice || 0) - plan.costBasis) > EPS) {
      useProductStore.getState().updateProduct(p.id, { purchasePrice: plan.costBasis });
      useProductStore.getState().loadProducts();
    }
  }
  const productIds: string[] = [];
  const lines = buildOrderInvoiceLines({
    order: plan.auftrag, billableLines: plan.billable, perLineSchemes: plan.schemes, customCostBasis: plan.costBasis,
    findProduct: (pid) => useProductStore.getState().products.find((p) => p.id === pid),
    createProduct: (data, line) => {
      const prod = createCustomPieceProduct(data, line, req.orderId);
      productIds.push(prod.id);
      return prod;
    },
  });
  for (const l of plan.billable) if (l.productId && !productIds.includes(l.productId)) productIds.push(l.productId);

  os.assertOrderLinesBillable(plan.billable.map((l) => l.id));
  const invoice = useInvoiceStore.getState().createDirectInvoice(
    plan.customerId, lines, `Invoice for order ${String(plan.order.order_number ?? '')}`,
    plan.day && plan.day !== nowIso.slice(0, 10) ? plan.day : undefined, undefined, undefined, req.specialMark === true,
  );
  if (!invoice?.id) throw new Error('orders.convert_to_invoice: the invoice was not created');
  os.markOrderLinesInvoiced(plan.billable.map((l) => l.id), invoice.id);
  os.updateOrder(req.orderId, { invoiceId: invoice.id } as never);
  if (req.markComplete) markConvertedLinesDelivered(plan.billable, os.updateOrderLineStatus);

  const gross = Number(query('SELECT gross_amount FROM invoices WHERE id = ?', [invoice.id])[0]?.gross_amount ?? 0);
  carryOverOrderPaymentsToInvoice(invoice.id, req.orderId, String(plan.order.order_number ?? ''), gross, undefined, issuedAt);
  check();

  useOrderStore.getState().loadOrders();
  useInvoiceStore.getState().loadInvoices();
  useProductStore.getState().loadProducts();
  useOrderPaymentStore.getState().loadPayments(req.orderId);
  const inv = query('SELECT invoice_number, gross_amount FROM invoices WHERE id = ?', [invoice.id])[0];
  return {
    orderId: req.orderId,
    invoiceId: invoice.id,
    invoiceNumber: String(inv?.invoice_number ?? ''),
    grossAmount: Number(inv?.gross_amount ?? 0),
    invoicedLines: plan.billable.length,
    productIds,
    revision: Number(query('SELECT revision FROM orders WHERE id = ?', [req.orderId])[0]?.revision ?? 0),
  };
}
