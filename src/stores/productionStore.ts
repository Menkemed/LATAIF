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
import type { ProductionRecord, ProductionInput, ProductionOutput, Product, Expense } from '@/core/models/types';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId, getNextDocumentNumber } from '@/core/db/helpers';
import { trackInsert, trackUpdate, trackDelete } from '@/core/sync/track';
import { postExpense, postExpensePayment, hasLedgerEntries } from '@/core/ledger/posting';

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
  createRecord: (input: {
    productionDate?: string;
    notes?: string;
    inputProductIds: string[];  // existing products consumed
    outputs: Array<{
      // Vollständige Produkt-Spec (categoryId/brand/name + dyn. attributes + images
      // + condition + taxScheme etc. — wird via NewProductModal befüllt). 'value'
      // ist der Production-Wert (= purchase_price des neuen Output-Produkts).
      spec: Partial<Product>;
      value: number;
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

    // Look up input products for their purchase_price snapshots + volle Spec
    // (attributes/images), damit der Detail-View später zeigen kann, was konsumiert
    // wurde. Die products-Row wird unten gelöscht — diese Daten sind danach nur
    // noch im production_inputs.product_snapshot vorhanden.
    const inputProducts: Product[] = [];
    const inputRows = query(
      `SELECT * FROM products WHERE id IN (${input.inputProductIds.map(() => '?').join(',')})`,
      input.inputProductIds
    );
    for (const r of inputRows) {
      let attrs: Record<string, string | number | boolean | string[]> = {};
      let imgs: string[] = [];
      try { attrs = JSON.parse((r.attributes as string) || '{}'); } catch { /* */ }
      try { imgs = JSON.parse((r.images as string) || '[]'); } catch { /* */ }
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
        images: imgs, attributes: attrs, createdAt: r.created_at as string, updatedAt: r.updated_at as string,
      });
    }

    const totalInput = inputProducts.reduce((s, p) => s + p.purchasePrice, 0);
    const totalOutput = input.outputs.reduce((s, o) => s + (Number(o.value) || 0), 0);

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

    // Log inputs — Plan §5 + Collection-History (2026-05-18): Input-Produkte werden
    // NICHT mehr hart geloescht. Stattdessen stock_status='consumed', damit die
    // Items in Collection unter dem Consumed-Filter weiter auffindbar bleiben und
    // im Product-Detail die Production-History anzeigen koennen. Snapshot bleibt
    // als Audit-Trail trotzdem auf production_inputs.product_snapshot.
    const inStmt = db.prepare(
      `INSERT INTO production_inputs (id, record_id, product_id, product_snapshot, input_value) VALUES (?, ?, ?, ?, ?)`
    );
    for (const p of inputProducts) {
      const snapshot = {
        categoryId: p.categoryId,
        brand: p.brand,
        name: p.name,
        sku: p.sku,
        condition: p.condition,
        attributes: p.attributes,
        images: p.images,
        purchasePrice: p.purchasePrice,
      };
      inStmt.run([uuid(), id, p.id, JSON.stringify(snapshot), p.purchasePrice]);
      db.run(`UPDATE products SET stock_status = 'consumed', updated_at = ? WHERE id = ?`, [now, p.id]);
    }
    inStmt.free();

    // Create outputs: new products, source_type=OWN, status=IN_STOCK.
    // Vollständige Spec aus NewProductModal wird übertragen — attributes + images
    // + condition etc. landen direkt auf der neuen Product-Row.
    const outStmt = db.prepare(
      `INSERT INTO production_outputs (id, record_id, product_id, output_value) VALUES (?, ?, ?, ?)`
    );
    for (const o of input.outputs) {
      const pId = uuid();
      const s = o.spec || {};
      const attrJson = JSON.stringify(s.attributes || {});
      const imgJson = JSON.stringify(s.images || []);
      const scopeJson = JSON.stringify(s.scopeOfDelivery || []);
      const userNotes = (s.notes ? `${s.notes}\n` : '') + `Created from Production ${recordNumber}`;
      db.run(
        `INSERT INTO products (id, branch_id, category_id, brand, name, sku, condition, scope_of_delivery,
          purchase_date, purchase_price, purchase_currency, stock_status, tax_scheme, expected_margin, days_in_stock,
          supplier_name, notes, images, attributes, source_type, created_at, updated_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'BHD', 'in_stock', ?, NULL, 0, NULL, ?, ?, ?, 'OWN', ?, ?, ?)`,
        [
          pId, branchId,
          s.categoryId || 'cat-watch',
          (s.brand || '').trim(),
          (s.name || '').trim(),
          s.sku || null,
          s.condition || '',
          scopeJson,
          prodDate,
          Number(o.value) || 0,
          s.taxScheme || 'MARGIN',
          userNotes,
          imgJson,
          attrJson,
          now, now, userId,
        ]
      );
      outStmt.run([uuid(), id, pId, Number(o.value) || 0]);
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
      const expenseAmount = labor + overhead;
      const expenseDate = now.split('T')[0];
      const expenseDescription = `Production ${r.recordNumber} — Labor ${labor.toFixed(2)} + Overhead ${overhead.toFixed(2)}`;
      db.run(
        `INSERT INTO expenses (id, branch_id, expense_number, category, amount, paid_amount, payment_method,
          expense_date, description, related_module, related_entity_id, status, created_at, created_by)
         VALUES (?, ?, ?, 'Miscellaneous', ?, ?, 'cash', ?, ?, 'production', ?, 'PAID', ?, ?)`,
        [expenseId, branchId, expenseNumber, expenseAmount, expenseAmount, expenseDate,
         expenseDescription,
         id, now, userId]
      );
      trackInsert('expenses', expenseId, { category: 'Miscellaneous', amount: expenseAmount, auto: true, productionId: id });
      saveDatabase();

      // Ledger-Post fuer Production-Expense (PAID, also direkt gegen Cash gegenbuchbar
      // beim postExpense — siehe posting.ts: paidAmount > 0 fuehrt zur Cash-Side-Buchung).
      const productionExpense: Expense = {
        id: expenseId,
        expenseNumber,
        branchId,
        category: 'Miscellaneous',
        amount: expenseAmount,
        paidAmount: expenseAmount,
        paymentMethod: 'cash',
        expenseDate,
        description: expenseDescription,
        relatedModule: 'production',
        relatedEntityId: id,
        status: 'PAID',
        createdAt: now,
      };
      safePost(`postExpense(${expenseId}) [production]`, () => {
        if (hasLedgerEntries('EXPENSE', expenseId)) return;
        postExpense(productionExpense);
      });
      // Production-Expenses sind direkt PAID — Cash-Leg via expense_payment + Ledger-Post.
      const payId = uuid();
      db.run(
        `INSERT INTO expense_payments (id, expense_id, amount, method, paid_at, note, created_at)
         VALUES (?, ?, ?, 'cash', ?, ?, ?)`,
        [payId, expenseId, expenseAmount, expenseDate, 'Auto-paid on production complete', now]
      );
      trackInsert('expense_payments', payId, { expenseId, amount: expenseAmount, method: 'cash' });
      safePost(`postExpensePayment(${payId}) [production]`, () => {
        if (hasLedgerEntries('EXPENSE_PAYMENT', payId)) return;
        postExpensePayment(
          {
            id: payId, expenseId, amount: expenseAmount,
            method: 'cash', paidAt: expenseDate, createdAt: now,
            note: 'Auto-paid on production complete',
          },
          undefined
        );
      });
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
