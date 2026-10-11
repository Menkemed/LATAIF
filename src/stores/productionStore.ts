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
import { query } from '@/core/db/helpers';
import { completeProductionInHouse, type ProductionCompleteInput, type ProductionCompleted } from '@/core/production/production-house';
// CENTRAL-UI-PARITY R6F — das Anlegen ist EINE Hausfolge für Primary und PC2 (production-house),
// am Primary exklusiv in einer Transaktion (`runOnPrimary`), danach durabel.
import { runOnPrimary } from '@/core/data/primary-action';
import { useProductStore } from '@/stores/productStore';
import {
  assertProductionHere, createProductionInHouse, deleteProductionInHouse, localProductionCtx,
  type ProductionCreateInput, type ProductionCreated, type ProductionDeleted,
} from '@/core/production/production-house';
// CENTRAL-UI-PARITY — auf einem Rechner ohne Datenbank holt derselbe Aufruf den Stand vom Primary.
import { hydrateFromPrimary } from '@/core/data/primary-source';
// CENTRAL-UI-PARITY R1 — der Ausweis der Leseanfrage reist als Parameter, nicht als globaler
// Zustand: am Primary aus der eigenen Sitzung, aus der Ferne aus dem geprueften Absender.
import { localReadContext, type BusinessReadContext } from '@/core/data/read-context';

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
  // Löschen: die Hausfolge `deleteProductionInHouse` über `runOnPrimary` (atomar, nur am Primary).
  deleteRecord: (id: string) => Promise<void>;
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

  // PRODUCTION-DELETE-ATOMICITY — EIN Vorgang am Primary (`deleteProductionInHouse`): exklusiv, in einer
  // Transaktion, jeder Fehler rollt alles zurück, danach durabel gespeichert. Vorher lief das Löschen hier
  // ohne Rahmen, und die Buchungs-Stornos verschluckten Fehler (safePost) — ein halber Zustand war möglich.
  deleteRecord: async (id) => {
    await deleteProductionOnPrimary(id);
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
/** PRODUCTION-DELETE-ATOMICITY — „Delete" am Primary: die Hausfolge exklusiv in EINER Transaktion, danach durabel. */
export async function deleteProductionOnPrimary(recordId: string): Promise<ProductionDeleted> {
  assertProductionHere();
  const ctx = localProductionCtx();
  return runOnPrimary(() => deleteProductionInHouse(recordId, ctx), nachFertigung);
}

export async function completeProductionOnPrimary(input: ProductionCompleteInput): Promise<ProductionCompleted> {
  assertProductionHere();
  const ctx = localProductionCtx();
  return runOnPrimary(() => completeProductionInHouse(input, ctx), nachFertigung);
}
