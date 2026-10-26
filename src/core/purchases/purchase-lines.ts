// ════════════════════════════════════════════════════════════════════════════
// Die Zeilenfolge des Einkaufs — EINE Stelle für „Save Purchase" und für „Edit purchase → Add item".
//
// Hier wohnt, was beide Wege gemeinsam brauchen und was die Hausfolge der Bearbeitung nicht selbst kennen
// darf (sie importiert keinen Store): die Nachschlagestellen des Hauses, die SKU-Vergabe aus dem zentralen
// Zähler und das Anhängen einer Position (Artikel, Zeile, Los, Menge — `appendPurchaseLinesInHouse`).
// PURCHASE-EDIT Teil 2 reicht `PURCHASE_LINE_OPS` an `editPurchaseInHouse` herein, am Primary wie für PC2.
// ════════════════════════════════════════════════════════════════════════════
import { query } from '@/core/db/helpers';
import { useProductStore } from '@/stores/productStore';
import { appendPurchaseLinesInHouse, type PurchaseInputLine } from '@/stores/purchaseStore';
import { isBrandRequired } from '@/core/products/field-contract';
import { EmbeddedProductRejected } from '@/core/products/embedded-product';
import { PurchaseActionRejected, planPurchaseLines, type PurchaseCreatePort, type PurchaseDraftLine } from './purchase-create';
import { PurchaseEditRejected, type PlannedAddLine, type PurchaseEditAddLine, type PurchaseLineOps } from './purchase-edit-house';

/** Die Nachschlagestellen des Hauses — immer in der Filiale, deren Bücher dieser Rechner führt. */
export function housePurchasePort(branchId: string): PurchaseCreatePort {
  const ps = useProductStore.getState();
  ps.loadCategories();
  ps.loadProducts();
  const has = (sql: string, p: unknown[]): boolean => !!query(sql, p)[0];
  return {
    // Die Lieferantenauswahl der Maske zeigt nur aktive.
    supplierActive: (id) => has('SELECT id FROM suppliers WHERE id = ? AND branch_id = ? AND COALESCE(active, 1) = 1', [id, branchId]),
    // Die Artikelauswahl der Maske: alles außer dem Reparatur-Service.
    productPickable: (id) => has(
      "SELECT id FROM products WHERE id = ? AND branch_id = ? AND COALESCE(category_id, '') NOT LIKE 'cat-repair-service%' AND COALESCE(category_id, '') NOT LIKE 'cat-bulk-metal%' AND id NOT LIKE 'bulk-%'",
      [id, branchId]),
    categoryExists: (id) => has('SELECT id FROM categories WHERE id = ? AND branch_id = ?', [id, branchId]),
    employeeActive: (id) => has(
      "SELECT id FROM employees WHERE id = ? AND branch_id = ? AND COALESCE(employment_status, 'active') != 'inactive'",
      [id, branchId]),
    orderExists: (id) => has('SELECT id FROM orders WHERE id = ? AND branch_id = ?', [id, branchId]),
    orderLineOf: (lineId) => {
      const r = query('SELECT ol.order_id FROM order_lines ol JOIN orders o ON o.id = ol.order_id WHERE ol.id = ? AND o.branch_id = ?',
        [lineId, branchId])[0];
      return r ? String(r.order_id) : undefined;
    },
    inboxExists: (id) => has('SELECT id FROM purchase_inbox WHERE id = ? AND branch_id = ?', [id, branchId]),
    partnerActive: (id) => has('SELECT id FROM partners WHERE id = ? AND branch_id = ? AND active = 1', [id, branchId]),
    category: (id) => useProductStore.getState().categories.find((c) => c.id === id && !c.id.startsWith('cat-repair-service') && !c.id.startsWith('cat-bulk-metal')),
    isSkuTaken: (sku) => useProductStore.getState().isSkuTaken(sku),
  };
}

/**
 * SKU-ALLOC — ein neuer Artikel ohne eingetippte SKU bekommt eine aus DEMSELBEN durablen Zähler wie
 * Collection, Kommission und Handy-Upload (`allocateSkuOnCreate`), am PC wie vom Telefon. Erst nach
 * der Planung — eine abgewiesene Eingabe verbraucht keine Nummer — und innerhalb der Klammer des
 * Einkaufs: scheitert er, fällt auch die Nummer zurück. Eine eingetippte SKU bleibt, wie sie ist.
 */
export function withAllocatedSkus(payload: Record<string, unknown>): Record<string, unknown> {
  const allocate = useProductStore.getState().allocateSkuOnCreate;
  const lines = (payload.lines as Array<Record<string, unknown>>).map((l) => {
    if (l.productId) return l;
    const np = l.newProduct as Record<string, unknown> | undefined;
    if (np) {
      return np.sku ? l : { ...l, newProduct: { ...np, sku: allocate(undefined, np.brand as string | undefined, np.categoryId as string | undefined) } };
    }
    return l.newProductSku ? l : {
      ...l, newProductSku: allocate(undefined, l.newProductBrand as string | undefined, l.newProductCategoryId as string | undefined),
    };
  });
  return { ...payload, lines };
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * PURCHASE-EDIT Teil 2 — die nachgetragenen Positionen: dieselben Regeln wie eine Zeile von „Save Purchase"
 * (ganze Menge ≥ 1, Preis ≥ 0, Marke/Modell, wo die Kategorie sie verlangt, ein wählbarer Artikel, eine geprüfte
 * Artikel-Spec mit freier SKU), dann dieselbe Planung (`planPurchaseLines`). Ohne Partner, Auftrag oder Edelmetall —
 * das gibt es nur beim Anlegen.
 */
function planAdd(lines: readonly PurchaseEditAddLine[], taxScheme: 'ZERO' | 'VAT_10', branchId: string): PlannedAddLine[] {
  const drafts: PurchaseDraftLine[] = lines.map((l, i) => {
    const n = `New line ${i + 1}`;
    if (l.mode !== 'existing' && l.mode !== 'new') throw new PurchaseEditRejected('PURCHASE_EDIT_ADD_INVALID', `${n}: an existing or a new item`);
    if (typeof l.quantity !== 'number' || !Number.isInteger(l.quantity) || l.quantity < 1) {
      throw new PurchaseEditRejected('PURCHASE_EDIT_QTY_INVALID', `${n}: the quantity is a whole number of at least 1`);
    }
    if (typeof l.unitPrice !== 'number' || !Number.isFinite(l.unitPrice) || l.unitPrice < 0) {
      throw new PurchaseEditRejected('PURCHASE_EDIT_PRICE_INVALID', `${n}: the unit price is a number of at least 0`);
    }
    if (l.mode === 'existing') {
      if (!l.productId) throw new PurchaseEditRejected('PURCHASE_EDIT_ADD_INVALID', `${n}: pick the item`);
      if (l.newProduct) throw new PurchaseEditRejected('PURCHASE_EDIT_ADD_INVALID', `${n}: an existing item takes no new item details`);
    } else {
      if (!l.newProduct || typeof l.newProduct !== 'object') throw new PurchaseEditRejected('PURCHASE_EDIT_ADD_INVALID', `${n}: define the new item`);
      if (l.productId) throw new PurchaseEditRejected('PURCHASE_EDIT_ADD_INVALID', `${n}: a new item has no item id yet`);
      const np = l.newProduct;
      if (isBrandRequired(text(np.categoryId)) && (!text(np.brand).trim() || !text(np.name).trim())) {
        throw new PurchaseEditRejected('LINE_INVALID', `${n}: brand and model are required for this category`);
      }
    }
    const np = l.newProduct ?? {};
    return {
      mode: l.mode, productId: l.productId, newProduct: l.mode === 'new' ? l.newProduct : undefined,
      brand: text(np.brand), name: text(np.name), sku: text(np.sku), categoryId: text(np.categoryId),
      quantity: l.quantity, unitPrice: l.unitPrice,
    };
  });
  let planned: Array<Record<string, unknown>>;
  try {
    planned = planPurchaseLines(drafts, taxScheme, undefined, housePurchasePort(branchId));
  } catch (e) {
    if (e instanceof PurchaseActionRejected || e instanceof EmbeddedProductRejected) throw new PurchaseEditRejected(e.code, `New line: ${e.message}`);
    throw e;
  }
  // Die Zeilensumme wie beim Anlegen (Menge × Bruttostückpreis).
  return planned.map((line) => ({ line, lineTotal: (Number(line.quantity) || 1) * (Number(line.unitPrice) || 0) }));
}

/** PURCHASE-EDIT Teil 2 — anhängen: SKU aus dem zentralen Zähler, dann die Zeilenfolge von „Save Purchase". */
function append(purchaseId: string, purchaseDate: string, planned: readonly PlannedAddLine[], ctx: { branchId: string; userId: string; now: string }) {
  const { lines } = withAllocatedSkus({ lines: planned.map((p) => p.line) }) as { lines: PurchaseInputLine[] };
  return appendPurchaseLinesInHouse(purchaseId, purchaseDate, lines, ctx)
    .map((r) => ({ id: r.id, productId: r.productId, createdProduct: r.createdProduct }));
}

/** Was `editPurchaseInHouse` für Teil 2 hereingereicht bekommt — am Primary und im Fernbefehl dieselbe Folge. */
export const PURCHASE_LINE_OPS: PurchaseLineOps = { planAdd, append };
