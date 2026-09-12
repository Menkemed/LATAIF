// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R5E — der Einkauf am Haus: dieselben Regeln, EINE Klammer.
//
// „Save Purchase" legte am Primary neue Artikel, Beleg, Zeilen, Lose, Menge, Status, Zahlung,
// Auftragsverknüpfung und Buchung in `createPurchase` an und markierte DANACH, getrennt, das Foto
// der Wareneingangs-Inbox als erledigt. Jetzt ist das EINE Folge — am Primary exklusiv in EINER
// Transaktion, fern in der Transaktion des Auftrags.
// ════════════════════════════════════════════════════════════════════════════
import { query, currentBranchId } from '@/core/db/helpers';
import { runOnPrimary } from '@/core/data/primary-action';
import { usePurchaseStore } from '@/stores/purchaseStore';
import { useProductStore } from '@/stores/productStore';
import { useOrderStore } from '@/stores/orderStore';
import type { Purchase } from '@/core/models/types';
import { planPurchaseCreate, type PurchaseCreateInput, type PurchaseCreatePort } from './purchase-create';

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
      "SELECT id FROM products WHERE id = ? AND branch_id = ? AND COALESCE(category_id, '') NOT LIKE 'cat-repair-service%'",
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
    category: (id) => useProductStore.getState().categories.find((c) => c.id === id && !c.id.startsWith('cat-repair-service')),
    isSkuTaken: (sku) => useProductStore.getState().isSkuTaken(sku),
  };
}

function frischLesen(): void {
  usePurchaseStore.getState().loadPurchases();
  useProductStore.getState().loadProducts();
  useOrderStore.getState().loadOrders();
}

/** „Save Purchase": der Einkauf — und, wenn er aus einem Inbox-Foto kam, das Foto „erledigt". */
export function createPurchaseInHouse(input: PurchaseCreateInput, branchId: string): Purchase {
  const payload = planPurchaseCreate(input, housePurchasePort(branchId));
  const store = usePurchaseStore.getState();
  const purchase = store.createPurchase(payload as never);
  if (input.inboxId) usePurchaseStore.getState().markPurchaseInboxDone(input.inboxId);
  return purchase;
}

/** „Save Purchase" am Primary. */
export function createPurchaseOnPrimary(input: PurchaseCreateInput): Promise<Purchase> {
  return runOnPrimary(() => createPurchaseInHouse(input, currentBranchId()), frischLesen);
}
