// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R5E — der Auftrag am Haus: dieselben Regeln, EINE Klammer.
//
// „Save Order" schrieb am Primary den Auftrag (samt neuer Artikel, Zeilen, Anzahlung, Buchung,
// Kartengebühr) und DANACH, getrennt und mit verschlucktem Fehler, die Gold-Verbindlichkeit beim
// Goldschmied. „Save" der Auftragsseite zog erst den Preis der Angebotszeile und schrieb dann den
// Kopf. Jetzt:
//
//   • `…InHouse` — die EINE Folge (Prüfen, Hausfunktion, Nebenwirkung), die der Fernbefehl innerhalb
//     seiner Transaktion ruft;
//   • `…OnPrimary` — dieselbe Folge für die Maske des Primary, exklusiv, in EINER Transaktion.
// ════════════════════════════════════════════════════════════════════════════
import { query, currentBranchId } from '@/core/db/helpers';
import { runOnPrimary } from '@/core/data/primary-action';
import { useOrderStore } from '@/stores/orderStore';
import { useProductStore } from '@/stores/productStore';
import { useGoldStore } from '@/stores/goldStore';
import { useCustomerStore } from '@/stores/customerStore';
import type { Order } from '@/core/models/types';
import { OrderActionRejected, planOrderCreate, type OrderCreateInput, type OrderCreatePort } from './order-create';
import { planOrderEdit, orderEditInput, type OrderEditInput } from './order-edit';

const str = (v: unknown): string | undefined => (v === null || v === undefined || v === '' ? undefined : String(v));

/** Die Nachschlagestellen des Hauses — immer in der Filiale, deren Bücher dieser Rechner führt. */
export function houseOrderPort(branchId: string): OrderCreatePort {
  const ps = useProductStore.getState();
  ps.loadCategories();
  ps.loadProducts();
  return {
    customerExists: (id) => !!query(
      "SELECT id FROM customers WHERE id = ? AND branch_id = ? AND id NOT LIKE 'sys-%'", [id, branchId],
    )[0],
    product: (id) => {
      const r = query('SELECT id, brand, name, sku, category_id, attributes, condition, tax_scheme FROM products WHERE id = ? AND branch_id = ?',
        [id, branchId])[0];
      if (!r) return undefined;
      let attributes: Record<string, unknown> = {};
      try { attributes = JSON.parse(String(r.attributes || '{}')) as Record<string, unknown>; } catch { /* leer */ }
      return {
        id: String(r.id), brand: String(r.brand ?? ''), name: String(r.name ?? ''), sku: str(r.sku),
        categoryId: str(r.category_id), attributes, condition: str(r.condition), taxScheme: str(r.tax_scheme),
      };
    },
    // Die Lieferantenauswahl der Maske (Goldschmied, Extra-Gold, Materialien) zeigt nur aktive.
    supplier: (id) => {
      const r = query('SELECT name FROM suppliers WHERE id = ? AND branch_id = ? AND COALESCE(active, 1) = 1', [id, branchId])[0];
      return r ? { name: String(r.name ?? '') } : undefined;
    },
    category: (id) => useProductStore.getState().categories.find((c) => c.id === id && !c.id.startsWith('cat-repair-service')),
    isSkuTaken: (sku) => useProductStore.getState().isSkuTaken(sku),
  };
}

/** Die Listen, die die Maske danach zeigt — auch nach einem Rollback. */
function frischLesen(): void {
  useOrderStore.getState().loadOrders();
  useProductStore.getState().loadProducts();
  useCustomerStore.getState().loadCustomers();
  try { useGoldStore.getState().loadGoldPayables(); } catch { /* kein Goldmodul geladen */ }
}

export interface OrderCreated { order: Order; goldPayableId?: string }

/**
 * „Save Order": der Auftrag — und, wenn der Goldschmied das Extra-Gold stellt, die Gold-
 * Verbindlichkeit in Gramm, verknüpft mit der Extra-Gold-Kostenzeile. EINE Folge; scheitert die
 * Verbindlichkeit, gibt es auch den Auftrag nicht (vorher blieb er ohne sie stehen).
 */
export function createOrderInHouse(input: OrderCreateInput, branchId: string, extras: Record<string, unknown> = {}): OrderCreated {
  const plan = planOrderCreate(input, houseOrderPort(branchId));
  const os = useOrderStore.getState();
  const order = os.createOrder({ ...plan.order, ...extras } as never);
  let goldPayableId: string | undefined;
  if (plan.goldPayable) {
    const egLine = useOrderStore.getState().getOrderLines(order.id)
      .find((l) => l.materialKind === 'gold' && (l.description || '').startsWith('Extra Gold'));
    goldPayableId = useGoldStore.getState().createGoldPayable({
      supplierId: plan.goldPayable.supplierId,
      sourceOrderId: order.id,
      sourceOrderLineId: egLine?.id,
      weightGrams: plan.goldPayable.weightGrams,
      karat: plan.goldPayable.karat,
    }).id;
  }
  return { order, goldPayableId };
}

/**
 * „Save" der Auftragsseite: bei einer Angebotszeile deren Preis (der Kopfpreis folgt aus den
 * Zeilen), dann die Eingaben mit den beiden abgeleiteten Zahlen. EINE Folge.
 */
export function updateOrderInHouse(id: string, input: OrderEditInput, branchId: string): void {
  const live = query('SELECT id, status FROM orders WHERE id = ? AND branch_id = ?', [id, branchId])[0];
  if (!live) throw new OrderActionRejected('ORDER_NOT_FOUND', 'no such order in this branch');
  // Die Maske bietet „Edit" nur für einen laufenden Auftrag an.
  if (['cancelled', 'completed'].includes(String(live.status))) {
    throw new OrderActionRejected('ORDER_NOT_EDITABLE', `this order is ${String(live.status)} — it is no longer edited`);
  }
  const os = useOrderStore.getState();
  const quote = os.getOrderLines(id).filter((l) => l.isCustomerFacing !== false).find((l) => l.materialKind === 'custom');
  const plan = planOrderEdit(input, quote ? { id: quote.id, unitPrice: quote.unitPrice } : undefined);
  if (plan.linePrice) {
    try {
      os.updateOrderLinePrice(plan.linePrice.lineId, plan.linePrice.unitPrice);
    } catch (e) {
      throw new OrderActionRejected('QUOTE_LINE_INVOICED', e instanceof Error ? e.message : String(e));
    }
  }
  useOrderStore.getState().updateOrder(id, plan.patch as never);
}

/** „Save Order" am Primary. */
export function createOrderOnPrimary(input: OrderCreateInput): Promise<OrderCreated> {
  return runOnPrimary(() => createOrderInHouse(input, currentBranchId()), frischLesen);
}

/** „Save" der Auftragsseite am Primary — die sechs Werte des Formulars. */
export function updateOrderOnPrimary(id: string, form: Partial<Order>): Promise<void> {
  return runOnPrimary(() => updateOrderInHouse(id, orderEditInput(form), currentBranchId()), frischLesen);
}
