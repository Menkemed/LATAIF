// ═══════════════════════════════════════════════════════════
// LATAIF — Production & Consumption Store (Plan §Production)
//
// Regeln (Plan §3 + §16):
//  - Gesamtwert bleibt gleich → Input Value = Output Value
//  - Input-Produkte werden entfernt (Inventory ↓)
//  - Output-Produkte werden ins Inventar gebucht (IN_STOCK, source_type=OWN)
//  - keine versteckten Gewinne
//  - alles dokumentieren
// ═══════════════════════════════════════════════════════════

import { create } from 'zustand';
import type { ProductionRecord, ProductionInput, ProductionOutput } from '@/core/models/types';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query } from '@/core/db/helpers';
import { trackDelete } from '@/core/sync/track';
import { trackChange } from '@/core/sync/sync-service';   // sync-only (kein Audit) — Ein-/Ausgangszeilen
import { completeProductionInHouse, type ProductionCompleteInput, type ProductionCompleted } from '@/core/production/production-house';
import { reverseSource, hasLedgerEntries, hasReversalFor } from '@/core/ledger/posting';
import { restoreLot, syncProductQuantity, trackLotRow, trackProductRow } from '@/core/lots/lot-queries';
// CENTRAL-UI-PARITY R6F — das Anlegen ist EINE Hausfolge für Primary und PC2 (production-house),
// am Primary exklusiv in einer Transaktion (`runOnPrimary`), danach durabel.
import { runOnPrimary } from '@/core/data/primary-action';
import { useProductStore } from '@/stores/productStore';
import {
  assertProductionHere, createProductionInHouse, localProductionCtx,
  type ProductionCreateInput, type ProductionCreated,
} from '@/core/production/production-house';
// CENTRAL-UI-PARITY — auf einem Rechner ohne Datenbank holt derselbe Aufruf den Stand vom Primary.
import { hydrateFromPrimary } from '@/core/data/primary-source';
// CENTRAL-UI-PARITY R1 — der Ausweis der Leseanfrage reist als Parameter, nicht als globaler
// Zustand: am Primary aus der eigenen Sitzung, aus der Ferne aus dem geprueften Absender.
import { localReadContext, type BusinessReadContext } from '@/core/data/read-context';

function safePost(label: string, fn: () => void): void {
  try { fn(); } catch (err) {
    console.error(`[ledger] ${label} failed:`, err);
  }
}

interface ProductionStore {
  records: ProductionRecord[];
  loading: boolean;
  loadRecords: () => void;
  getRecord: (id: string) => ProductionRecord | undefined;
  // CENTRAL-UI-PARITY R6F — asynchron: jeder Ausgang entsteht über den Anlageweg des Hauses
  // (`createProductWithMedia`, Bilder in den Medienspeicher), und der hat Wartepunkte. Die
  // Eingabe ist dieselbe wie bisher (Spec aus NewProductModal + Fertigungswert je Ausgang,
  // Plan §8 #7 Arbeit/Gemeinkosten); geprüft und geschrieben wird in `production-house`.
  createRecord: (input: ProductionCreateInput) => Promise<ProductionRecord>;
  // Plan §8 #7 — der Abschluss (Kosten finalisieren + buchen) ist seit R7A die Hausfolge
  // `completeProductionInHouse` (am Primary: `completeProductionOnPrimary`, fern: `production.complete`).
  deleteRecord: (id: string) => void;
}

function rowToRecord(row: Record<string, unknown>): ProductionRecord {
  return {
    id: row.id as string,
    recordNumber: row.record_number as string,
    branchId: row.branch_id as string,
    productionDate: row.production_date as string,
    totalValue: (row.total_value as number) || 0,
    notes: row.notes as string | undefined,
    status: (row.status as ProductionRecord['status']) || 'CONFIRMED',
    laborCost: (row.labor_cost as number) || 0,
    overheadCost: (row.overhead_cost as number) || 0,
    totalCost: (row.total_cost as number) || 0,
    inputs: [],
    outputs: [],
    createdAt: row.created_at as string,
    createdBy: row.created_by as string | undefined,
  };
}

function rowToInput(row: Record<string, unknown>): ProductionInput {
  const raw = row.product_snapshot as string | undefined;
  let snapshot: ProductionInput['snapshot'];
  if (raw) {
    try { snapshot = JSON.parse(raw); } catch { /* legacy or corrupt — ignore */ }
  }
  return {
    id: row.id as string,
    recordId: row.record_id as string,
    productId: row.product_id as string,
    productSnapshot: raw,
    snapshot,
    inputValue: (row.input_value as number) || 0,
  };
}

function rowToOutput(row: Record<string, unknown>): ProductionOutput {
  return {
    id: row.id as string,
    recordId: row.record_id as string,
    productId: row.product_id as string,
    outputValue: (row.output_value as number) || 0,
  };
}

export const useProductionStore = create<ProductionStore>((set, get) => ({
  records: [],
  loading: false,

  loadRecords: () => {
    if (hydrateFromPrimary('store.production.get', (d) => set(d as never))) return;
    try {
      set({ ...loadProductionRecordsFor(localReadContext()), loading: false });
    } catch { set({ records: [], loading: false }); }
  },

  getRecord: (id) => get().records.find(r => r.id === id),

  // CENTRAL-UI-PARITY R6F — dieselbe Hausfolge wie der Fernbefehl `production.create`; der Store
  // schreibt nicht mehr selbst (vorher: Bilder als Text in products.images, Eingänge ungeprüft,
  // stilles 'branch-main', Zwischen-saveDatabase ohne Klammer — siehe production-house).
  createRecord: async (input) => {
    const made = await createProductionOnPrimary(input);
    return get().getRecord(made.recordId)!;
  },

  deleteRecord: (id) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const rec = get().getRecord(id);
    // Kein Record geladen → reiner Row-Delete (Alt-Verhalten, nichts zu spiegeln).
    if (!rec) {
      db.run('DELETE FROM production_records WHERE id = ?', [id]);
      saveDatabase();
      trackDelete('production_records', id);
      get().loadRecords();
      return;
    }

    // F-PRD-04 — Block-Guard: ein Output, der nicht mehr in_stock ist (verkauft/
    // verbraucht/an Agent), darf nicht still verschwinden. "Verbrauchte blockieren".
    for (const o of rec.outputs) {
      if (!o.productId) continue;
      const st = (query(`SELECT stock_status FROM products WHERE id = ?`, [o.productId])[0]?.stock_status as string) || '';
      if (st && st !== 'in_stock') {
        throw new Error(
          `Production ${rec.recordNumber} kann nicht geloescht werden: Output-Produkt ist bereits '${st}' (verkauft/verbraucht).`
        );
      }
    }

    // 1. Inputs zurueck: Produkt wieder in_stock + geleerte Lots auffuellen (createRecord
    //    hatte sie via consumeLot geleert). restoreLot cappt bei qty_total.
    for (const inp of rec.inputs) {
      if (!inp.productId) continue;
      db.run(`UPDATE products SET stock_status = 'in_stock', updated_at = ? WHERE id = ?`, [now, inp.productId]);
      trackProductRow(inp.productId);   // LAN-Sync Phase 1b
      const lots = query(
        `SELECT id, qty_total, qty_remaining FROM stock_lots WHERE product_id = ? AND status != 'CANCELLED'`,
        [inp.productId]
      );
      for (const l of lots) {
        const total = Number(l.qty_total) || 0;
        const rem = Number(l.qty_remaining) || 0;
        if (rem < total) restoreLot(l.id as string, total - rem);
      }
      syncProductQuantity(inp.productId);
    }

    // 2. Outputs entfernen: Produkt + dessen Production-Lot (purchase_id NULL) loeschen.
    for (const o of rec.outputs) {
      if (!o.productId) continue;
      // LAN-Sync Phase 1a: Production-Output-Lots (purchase_id IS NULL) vor dem DELETE
      // erfassen und als delete an Geraet B tracken (kein zurueckgelassener Lot auf B).
      const delLotIds = query(`SELECT id FROM stock_lots WHERE product_id = ? AND purchase_id IS NULL`, [o.productId]).map(r => r.id as string);
      db.run(`DELETE FROM stock_lots WHERE product_id = ? AND purchase_id IS NULL`, [o.productId]);
      for (const lid of delLotIds) trackLotRow(lid, 'delete');
      db.run(`DELETE FROM products WHERE id = ?`, [o.productId]);
      trackDelete('products', o.productId);
    }

    // 3. Auto-Expense (Labor/Overhead) reversen, falls completeRecord eine erzeugt hat.
    const expRows = query(`SELECT id FROM expenses WHERE related_module = 'production' AND related_entity_id = ?`, [id]);
    for (const e of expRows) {
      const expId = e.id as string;
      for (const p of query(`SELECT id FROM expense_payments WHERE expense_id = ?`, [expId])) {
        const payId = p.id as string;
        if (hasLedgerEntries('EXPENSE_PAYMENT', payId) && !hasReversalFor('EXPENSE_PAYMENT', payId)) {
          safePost(`reverse EXPENSE_PAYMENT(${payId})`, () => reverseSource('EXPENSE_PAYMENT', payId, now));
        }
        db.run(`DELETE FROM expense_payments WHERE id = ?`, [payId]);
        trackDelete('expense_payments', payId);
      }
      if (hasLedgerEntries('EXPENSE', expId) && !hasReversalFor('EXPENSE', expId)) {
        safePost(`reverse EXPENSE(${expId})`, () => reverseSource('EXPENSE', expId, now));
      }
      db.run(`DELETE FROM expenses WHERE id = ?`, [expId]);
      trackDelete('expenses', expId);
    }

    // 4. Inputs/Outputs-Zeilen + Record loeschen.
    // R7A (PP-10) — die Kindzeilen reisen mit (vorher still nur lokal geloescht; ohne Fremdschluessel-
    // Erzwingung blieben sie auf einem anderen Datenbank-Rechner als Waisen stehen).
    const inRowIds = query(`SELECT id FROM production_inputs WHERE record_id = ?`, [id]).map(r => r.id as string);
    const outRowIds = query(`SELECT id FROM production_outputs WHERE record_id = ?`, [id]).map(r => r.id as string);
    db.run(`DELETE FROM production_inputs WHERE record_id = ?`, [id]);
    db.run(`DELETE FROM production_outputs WHERE record_id = ?`, [id]);
    db.run('DELETE FROM production_records WHERE id = ?', [id]);
    saveDatabase();
    for (const rid of inRowIds) trackChange('production_inputs', rid, 'delete', {});
    for (const rid of outRowIds) trackChange('production_outputs', rid, 'delete', {});
    trackDelete('production_records', id);
    get().loadRecords();
  },
}));

/** CENTRAL-UI-PARITY R2B — die Fertigungsvorgaenge einer Filiale samt Ein- und Ausgang. */
export function loadProductionRecordsFor(ctx: BusinessReadContext): { records: ProductionRecord[] } {
  const rows = query('SELECT * FROM production_records WHERE branch_id = ? ORDER BY created_at DESC', [ctx.branchId]);
  const records: ProductionRecord[] = rows.map((r) => {
    const rec = rowToRecord(r);
    // Ein- und Ausgaenge haengen am Vorgang; der ist bereits auf die Filiale eingeschraenkt.
    rec.inputs = query('SELECT * FROM production_inputs WHERE record_id = ?', [rec.id]).map(rowToInput);
    rec.outputs = query('SELECT * FROM production_outputs WHERE record_id = ?', [rec.id]).map(rowToOutput);
    return rec;
  });
  return { records };
}

/** Nach dem Anlegen (auch nach einer Rücknahme) zeigen Liste und Bestand den wirklichen Stand. */
function nachFertigung(): void {
  useProductionStore.getState().loadRecords();
  useProductStore.getState().loadProducts();
}

/**
 * CENTRAL-UI-PARITY R6F — „Confirm Production" am Primary: die Hausfolge exklusiv in EINER
 * Transaktion, erst danach durabel. Auf einem Rechner ohne Datenbank verweigert der Riegel, BEVOR
 * irgendetwas eine Datenbank anfasst — dort geht die Maske über `production.create`.
 */
export async function createProductionOnPrimary(input: ProductionCreateInput): Promise<ProductionCreated> {
  assertProductionHere();
  const ctx = localProductionCtx();
  return runOnPrimary(() => createProductionInHouse(input, ctx), nachFertigung);
}

/**
 * POST-PARITY R7A (PP-2) — „Complete Production" am Primary: dieselbe Hausfolge wie der Fernbefehl
 * `production.complete`, exklusiv in EINER Transaktion, erst danach durabel. Ohne Datenbank verweigert
 * der Riegel, BEVOR irgendetwas eine Datenbank anfasst.
 */
export async function completeProductionOnPrimary(input: ProductionCompleteInput): Promise<ProductionCompleted> {
  assertProductionHere();
  const ctx = localProductionCtx();
  return runOnPrimary(() => completeProductionInHouse(input, ctx), nachFertigung);
}
