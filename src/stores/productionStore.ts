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
import { v4 as uuid } from 'uuid';
import type { ProductionRecord, ProductionInput, ProductionOutput, Product } from '@/core/models/types';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId, getNextDocumentNumber } from '@/core/db/helpers';
import { trackInsert, trackUpdate, trackDelete } from '@/core/sync/track';

interface ProductionStore {
  records: ProductionRecord[];
  loading: boolean;
  loadRecords: () => void;
  getRecord: (id: string) => ProductionRecord | undefined;
  createRecord: (input: {
    productionDate?: string;
    notes?: string;
    inputProductIds: string[];  // existing products consumed
    outputs: Array<{
      categoryId: string;
      brand: string;
      name: string;
      value: number;
      sku?: string;
    }>;
    // Plan §8 #7 — Cost-Tracking
    laborCost?: number;
    overheadCost?: number;
  }) => ProductionRecord;
  // Plan §8 #7 — Record als abgeschlossen markieren + Kosten finalisieren
  completeRecord: (id: string, laborCost?: number, overheadCost?: number) => void;
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
  return {
    id: row.id as string,
    recordId: row.record_id as string,
    productId: row.product_id as string,
    productSnapshot: row.product_snapshot as string | undefined,
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
    try {
      const branchId = currentBranchId();
      const rows = query('SELECT * FROM production_records WHERE branch_id = ? ORDER BY created_at DESC', [branchId]);
      const list: ProductionRecord[] = rows.map(r => {
        const rec = rowToRecord(r);
        rec.inputs = query('SELECT * FROM production_inputs WHERE record_id = ?', [rec.id]).map(rowToInput);
        rec.outputs = query('SELECT * FROM production_outputs WHERE record_id = ?', [rec.id]).map(rowToOutput);
        return rec;
      });
      set({ records: list, loading: false });
    } catch { set({ records: [], loading: false }); }
  },

  getRecord: (id) => get().records.find(r => r.id === id),

  createRecord: (input) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const id = uuid();
    let branchId: string, userId: string;
    try { branchId = currentBranchId(); userId = currentUserId(); }
    catch { branchId = 'branch-main'; userId = 'user-owner'; }

    // Look up input products for their purchase_price snapshots
    const inputProducts: Product[] = [];
    const inputRows = query(
      `SELECT * FROM products WHERE id IN (${input.inputProductIds.map(() => '?').join(',')})`,
      input.inputProductIds
    );
    for (const r of inputRows) {
      inputProducts.push({
        id: r.id as string,
        categoryId: r.category_id as string,
        brand: r.brand as string,
        name: r.name as string,
        sku: r.sku as string | undefined,
        quantity: Math.max(1, (r.quantity as number) || 1),
        condition: (r.condition as string) || '',
        scopeOfDelivery: [], storageLocation: undefined, purchaseDate: r.purchase_date as string | undefined,
        purchasePrice: (r.purchase_price as number) || 0,
        purchaseCurrency: 'BHD', plannedSalePrice: undefined,
        stockStatus: (r.stock_status as Product['stockStatus']) || 'in_stock',
        taxScheme: (r.tax_scheme as Product['taxScheme']) || 'MARGIN',
        sourceType: (r.source_type as Product['sourceType']) || 'OWN',
        images: [], attributes: {}, createdAt: r.created_at as string, updatedAt: r.updated_at as string,
      });
    }

    const totalInput = inputProducts.reduce((s, p) => s + p.purchasePrice, 0);
    const totalOutput = input.outputs.reduce((s, o) => s + o.value, 0);

    // Plan §12: Total Input Value = Total Output Value. Wir tolerieren 0.01 BHD Rundung.
    if (Math.abs(totalInput - totalOutput) > 0.01) {
      throw new Error(`Value mismatch — Input ${totalInput.toFixed(2)} ≠ Output ${totalOutput.toFixed(2)}`);
    }

    const recordNumber = getNextDocumentNumber('PRD');
    const prodDate = input.productionDate || now.split('T')[0];

    const labor = input.laborCost || 0;
    const overhead = input.overheadCost || 0;
    const totalCost = totalInput + labor + overhead;
    db.run(
      `INSERT INTO production_records (id, branch_id, record_number, production_date, total_value, notes, status,
         labor_cost, overhead_cost, total_cost, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 'CONFIRMED', ?, ?, ?, ?, ?)`,
      [id, branchId, recordNumber, prodDate, totalInput, input.notes || null,
       labor, overhead, totalCost, now, userId]
    );

    // Log inputs + delete input products (Plan §5)
    const inStmt = db.prepare(
      `INSERT INTO production_inputs (id, record_id, product_id, product_snapshot, input_value) VALUES (?, ?, ?, ?, ?)`
    );
    for (const p of inputProducts) {
      inStmt.run([uuid(), id, p.id, JSON.stringify({ brand: p.brand, name: p.name, sku: p.sku }), p.purchasePrice]);
      db.run(`DELETE FROM products WHERE id = ?`, [p.id]);
    }
    inStmt.free();

    // Create outputs: new products, source_type=OWN, status=IN_STOCK
    const outStmt = db.prepare(
      `INSERT INTO production_outputs (id, record_id, product_id, output_value) VALUES (?, ?, ?, ?)`
    );
    for (const o of input.outputs) {
      const pId = uuid();
      db.run(
        `INSERT INTO products (id, branch_id, category_id, brand, name, sku, condition, scope_of_delivery,
          purchase_date, purchase_price, purchase_currency, stock_status, tax_scheme, expected_margin, days_in_stock,
          supplier_name, notes, images, attributes, source_type, created_at, updated_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, 'BHD', 'in_stock', 'MARGIN', NULL, 0, NULL, ?, '[]', '{}', 'OWN', ?, ?, ?)`,
        [pId, branchId, o.categoryId, o.brand, o.name, o.sku || null, '', prodDate, o.value,
         `Created from Production ${recordNumber}`, now, now, userId]
      );
      outStmt.run([uuid(), id, pId, o.value]);
    }
    outStmt.free();

    saveDatabase();
    trackInsert('production_records', id, { recordNumber, totalValue: totalInput });
    get().loadRecords();
    return get().getRecord(id)!;
  },

  // Plan §8 #7 — Record abschließen (COMPLETED) + optional Kosten anpassen.
  completeRecord: (id, laborCost, overheadCost) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const r = get().getRecord(id);
    if (!r) return;
    const labor = typeof laborCost === 'number' ? laborCost : (r.laborCost || 0);
    const overhead = typeof overheadCost === 'number' ? overheadCost : (r.overheadCost || 0);
    const totalCost = (r.totalValue || 0) + labor + overhead;
    db.run(
      `UPDATE production_records SET status = 'COMPLETED', labor_cost = ?, overhead_cost = ?, total_cost = ? WHERE id = ?`,
      [labor, overhead, totalCost, id]
    );
    saveDatabase();
    trackUpdate('production_records', id, { status: 'COMPLETED', laborCost: labor, overheadCost: overhead, totalCost });
    get().loadRecords();
    // Auto-Expense für Arbeit + Overhead falls > 0 (optional, als Audit-Hilfe)
    if (labor + overhead > 0) {
      let branchId: string, userId: string;
      try { branchId = currentBranchId(); userId = currentUserId(); }
      catch { branchId = 'branch-main'; userId = 'user-owner'; }
      const expenseId = uuid();
      const expenseNumber = getNextDocumentNumber('EXP');
      db.run(
        `INSERT INTO expenses (id, branch_id, expense_number, category, amount, payment_method,
          expense_date, description, related_module, related_entity_id, status, created_at, created_by)
         VALUES (?, ?, ?, 'Other', ?, 'cash', ?, ?, 'production', ?, 'PAID', ?, ?)`,
        [expenseId, branchId, expenseNumber, labor + overhead, now.split('T')[0],
         `Production ${r.recordNumber} — Labor ${labor.toFixed(2)} + Overhead ${overhead.toFixed(2)}`,
         id, now, userId]
      );
      trackInsert('expenses', expenseId, { category: 'Other', amount: labor + overhead, auto: true, productionId: id });
      saveDatabase();
    }
  },

  deleteRecord: (id) => {
    const db = getDatabase();
    db.run('DELETE FROM production_records WHERE id = ?', [id]);
    saveDatabase();
    trackDelete('production_records', id);
    get().loadRecords();
  },
}));
