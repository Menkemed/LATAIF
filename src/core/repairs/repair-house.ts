// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R5C — die Reparatur am Primary: dieselben Regeln, EINE Klammer.
//
// Die drei Handlungen der Reparaturmasken schrieben am Primary ohne gemeinsame Klammer: das
// Anlegen einer Reparatur an eigener Ware setzt den Artikel auf `in_repair` und legt ggf. die
// erste Arbeitszeile an; das Ändern bucht Zahlwege und Kartengebühr um; die Sammelrechnung legt
// den Beleg an und verknüpft danach jede Reparatur einzeln. Scheiterte ein späterer Schritt, blieb
// der frühere stehen. Der Fernbefehl klammert seit jeher — jetzt klammert der Primary genauso,
// exklusiv in derselben Warteschlange, und speichert erst nach dem Commit durabel.
//
// Die Regeln selbst stehen in `repair-rules`; hier wohnen nur die Anschlüsse ans Haus.
// ════════════════════════════════════════════════════════════════════════════
import { query, currentBranchId } from '@/core/db/helpers';
import { saveDatabaseDurably } from '@/core/db/database';
import { beginLedgerTransaction, commitLedgerTransaction, rollbackLedgerTransaction } from '@/core/ledger/posting';
import { runExclusive } from '@/core/bridge/command-scheduler';
import { getLotsWithPurchaseNumbers } from '@/core/lots/lot-queries';
import { useRepairStore } from '@/stores/repairStore';
import { useProductStore } from '@/stores/productStore';
import { useInvoiceStore } from '@/stores/invoiceStore';
import type { Repair } from '@/core/models/types';
import {
  RepairActionRejected, assertRepairEditRefs, buildRepairEditPatch, normalizeRepairCreate, planRepairCreate,
  type RepairHousePort, type RepairInvoiceOptions,
} from './repair-rules';

/** Die Nachschlagestellen des Hauses — immer in der Filiale, deren Bücher dieser Rechner führt. */
export function houseRepairPort(branchId: string): RepairHousePort {
  const str = (v: unknown): string | undefined => (v === null || v === undefined || v === '' ? undefined : String(v));
  return {
    customerExists: (id) => !!query(
      "SELECT id FROM customers WHERE id = ? AND branch_id = ? AND id NOT LIKE 'sys-%'", [id, branchId],
    )[0],
    product: (id) => {
      const r = query('SELECT id, source_type, brand, name, sku, category_id FROM products WHERE id = ? AND branch_id = ?',
        [id, branchId])[0];
      if (!r) return undefined;
      return {
        id: String(r.id), sourceType: str(r.source_type) ?? null,
        brand: str(r.brand), name: str(r.name), sku: str(r.sku), categoryId: str(r.category_id),
      };
    },
    // Dieselbe Quelle wie die Losauswahl der Maske — keine zweite Vorstellung davon, was „aktiv" ist.
    lotBelongs: (lotId, productId) => getLotsWithPurchaseNumbers(productId, branchId).some((l) => l.id === lotId),
    supplierExists: (id) => !!query('SELECT id FROM suppliers WHERE id = ? AND branch_id = ?', [id, branchId])[0],
    // Die Mitarbeiterauswahl der Maske zeigt nur, wer nicht ausgeschieden ist.
    employeeExists: (id) => !!query(
      "SELECT id FROM employees WHERE id = ? AND branch_id = ? AND COALESCE(employment_status, 'active') != 'inactive'",
      [id, branchId],
    )[0],
    // Dieselbe Menge wie die Kategorie-Chips der Masken: die aktiven der Filiale, ohne „Repair Service".
    categoryExists: (id) => !id.startsWith('cat-repair-service')
      && !!query('SELECT id FROM categories WHERE id = ? AND branch_id = ? AND COALESCE(active, 1) = 1', [id, branchId])[0],
  };
}

function frischLesen(): void {
  const rs = useRepairStore.getState();
  rs.loadRepairs();
  rs.loadRepairLines();
  useProductStore.getState().loadProducts();
  useInvoiceStore.getState().loadInvoices();
}

/** Eine Handlung am Primary: exklusiv, in EINER Transaktion, erst danach durabel. */
function amPrimary<T>(work: () => T | Promise<T>): Promise<T> {
  return runExclusive(async () => {
    beginLedgerTransaction();
    let out: T;
    try {
      out = await work();
      commitLedgerTransaction();
    } catch (e) {
      rollbackLedgerTransaction();
      frischLesen();
      throw e;
    }
    await saveDatabaseDurably();
    frischLesen();
    return out;
  });
}

/** „Create Repair" am Primary — dieselbe Vorbereitung wie der Fernbefehl, dann `createRepair`. */
export function createRepairOnPrimary(form: Partial<Repair>): Promise<Repair> {
  return amPrimary(() => {
    const data = planRepairCreate(normalizeRepairCreate(form), houseRepairPort(currentBranchId()));
    return useRepairStore.getState().createRepair({ ...data, images: form.images ?? [] });
  });
}

/** „Save" der Detailseite am Primary — derselbe Schreibsatz wie der Fernbefehl. */
export function updateRepairOnPrimary(id: string, form: Partial<Repair>): Promise<void> {
  return amPrimary(() => {
    const rs = useRepairStore.getState();
    rs.loadRepairs();
    const seen = rs.getRepair(id);
    if (!seen) throw new RepairActionRejected('REPAIR_NOT_FOUND', 'no such repair');
    const patch = buildRepairEditPatch(form);
    assertRepairEditRefs(patch, seen, houseRepairPort(currentBranchId()));
    rs.updateRepair(id, patch);
  });
}

/** Eine oder mehrere Reparaturen in EINE Rechnung — Liste, Kürzel und Detailseite. */
export function invoiceRepairsOnPrimary(
  repairIds: readonly string[], opts: RepairInvoiceOptions = {},
): Promise<{ invoiceId: string }> {
  return amPrimary(() => {
    const rs = useRepairStore.getState();
    rs.loadRepairs();
    rs.loadRepairLines();
    return rs.createCombinedRepairInvoice([...repairIds], opts);
  });
}
