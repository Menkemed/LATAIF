// ═══════════════════════════════════════════════════════════
// LATAIF — Gold-Flow Store (Plan repair-multi-supplier)
//
// Zentraler Store fuer die drei Gold-Buckets:
//   - gold_payables          (wir schulden Workshop/Supplier X Gramm)
//   - customer_gold_credits  (wir schulden Kunden X Gramm)
//   - precious_metals        (Shop-Inventar)
//
// Jeder Bucket hat dieselben drei Lifecycle-Actions:
//   1. Settle in Gold      → gramm-Transfer zwischen Buckets (kein BHD-Ledger)
//   2. Convert to Money    → BHD-Wert wird zum Settlement-Zeitpunkt verhandelt
//                            und als Expense (Supplier) oder Customer-Credit gebucht
//   3. Cross-Settle        → eine Position entgegen einer anderen verrechnen
//
// JEDE Settlement-Aktion schreibt automatisch einen `gold_movements`-Eintrag
// fuer den Audit-Trail. ledger_entries (BHD) wird NUR im convert_to_money-Pfad
// beruehrt — Gold bleibt Gold, Geld bleibt Geld.
// ═══════════════════════════════════════════════════════════

import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type {
  GoldPayable, CustomerGoldCredit, GoldMovement, GoldBucket,
  Expense,
} from '@/core/models/types';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId, getNextDocumentNumber } from '@/core/db/helpers';
import { trackInsert, trackUpdate } from '@/core/sync/track';
import { postExpense, hasLedgerEntries } from '@/core/ledger/posting';
import { KARAT_PURITY as PURITY_LOOKUP } from '@/core/gold/purity';

function safePost(label: string, fn: () => void): void {
  try { fn(); } catch (err) {
    console.error(`[ledger] ${label} failed:`, err);
  }
}

function nowIso(): string { return new Date().toISOString(); }

function rowToGoldPayable(row: Record<string, unknown>): GoldPayable {
  return {
    id: row.id as string,
    branchId: row.branch_id as string,
    supplierId: row.supplier_id as string,
    sourceRepairId: (row.source_repair_id as string) || undefined,
    sourceRepairLineId: (row.source_repair_line_id as string) || undefined,
    direction: ((row.direction as string) || 'we_owe') as GoldPayable['direction'],
    weightGrams: (row.weight_grams as number) || 0,
    karat: row.karat as string,
    settlementType: row.settlement_type as GoldPayable['settlementType'],
    fulfilledGrams: (row.fulfilled_grams as number) || 0,
    settlementExpenseId: (row.settlement_expense_id as string) || undefined,
    status: ((row.status as string) || 'OPEN') as GoldPayable['status'],
    notes: (row.notes as string) || undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function rowToCustomerGoldCredit(row: Record<string, unknown>): CustomerGoldCredit {
  return {
    id: row.id as string,
    branchId: row.branch_id as string,
    customerId: row.customer_id as string,
    sourceRepairId: (row.source_repair_id as string) || undefined,
    weightGrams: (row.weight_grams as number) || 0,
    karat: row.karat as string,
    fulfilledGrams: (row.fulfilled_grams as number) || 0,
    settlementCreditId: (row.settlement_credit_id as string) || undefined,
    status: ((row.status as string) || 'OPEN') as CustomerGoldCredit['status'],
    notes: (row.notes as string) || undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function rowToGoldMovement(row: Record<string, unknown>): GoldMovement {
  return {
    id: row.id as string,
    branchId: row.branch_id as string,
    movedAt: row.moved_at as string,
    direction: row.direction as 'in' | 'out',
    weightGrams: (row.weight_grams as number) || 0,
    karat: row.karat as string,
    sourceBucket: (row.source_bucket as GoldBucket) || undefined,
    sourceId: (row.source_id as string) || undefined,
    targetBucket: (row.target_bucket as GoldBucket) || undefined,
    targetId: (row.target_id as string) || undefined,
    relatedRepairId: (row.related_repair_id as string) || undefined,
    notes: (row.notes as string) || undefined,
  };
}

// Schreibt einen Audit-Eintrag fuer eine Gramm-Bewegung. Wird intern von
// allen Settlement-Aktionen aufgerufen. Branch-ID kommt aus der Aktion,
// nicht aus der aktuellen Session — damit Cross-Branch-Bewegungen sauber
// dokumentiert werden.
function recordGoldMovement(args: {
  branchId: string;
  direction: 'in' | 'out';
  weightGrams: number;
  karat: string;
  sourceBucket?: GoldBucket;
  sourceId?: string;
  targetBucket?: GoldBucket;
  targetId?: string;
  relatedRepairId?: string;
  notes?: string;
}): string {
  const db = getDatabase();
  const id = uuid();
  const now = nowIso();
  db.run(
    `INSERT INTO gold_movements (id, branch_id, moved_at, direction, weight_grams, karat,
       source_bucket, source_id, target_bucket, target_id, related_repair_id, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, args.branchId, now, args.direction, args.weightGrams, args.karat,
      args.sourceBucket || null, args.sourceId || null,
      args.targetBucket || null, args.targetId || null,
      args.relatedRepairId || null, args.notes || null,
    ]
  );
  trackInsert('gold_movements', id, {
    direction: args.direction, weightGrams: args.weightGrams, karat: args.karat,
    relatedRepairId: args.relatedRepairId,
  });
  return id;
}

// Adjustiert das Shop-Gold-Inventar in `precious_metals`. Sucht einen passenden
// Eintrag (gleiche karat + in_stock), legt einen neuen an wenn keiner existiert
// (bei Inflow) oder reduziert den Bestand (bei Outflow). SoftWarn bei
// Inventar-negativ — UI muss SoftWarn anzeigen, hier wird einfach erlaubt
// (Salesforce-Stil: User entscheidet bewusst).
function adjustPreciousMetals(args: {
  branchId: string;
  karat: string;
  deltaGrams: number;        // positiv = Inflow, negativ = Outflow
  sourceLabel: string;
}): void {
  const db = getDatabase();
  const now = nowIso();
  // Suche existierenden in_stock-Eintrag fuer dieses Karat
  const rows = query(
    `SELECT id, weight_grams FROM precious_metals
       WHERE branch_id = ? AND karat = ? AND status = 'in_stock'
       ORDER BY created_at DESC LIMIT 1`,
    [args.branchId, args.karat]
  );
  if (rows.length > 0) {
    const existingId = rows[0].id as string;
    const existingWeight = (rows[0].weight_grams as number) || 0;
    const next = existingWeight + args.deltaGrams;
    db.run(
      `UPDATE precious_metals SET weight_grams = ?, updated_at = ? WHERE id = ?`,
      [next, now, existingId]
    );
    trackUpdate('precious_metals', existingId, { weightGrams: next, source: args.sourceLabel });
    return;
  }
  // Kein Eintrag — bei Inflow neu anlegen
  if (args.deltaGrams > 0) {
    let userId: string;
    try { userId = currentUserId(); } catch { userId = 'user-owner'; }
    const id = uuid();
    db.run(
      `INSERT INTO precious_metals (id, branch_id, metal_type, karat, weight_grams,
         description, status, paid_amount, payment_status, images, created_at, updated_at, created_by)
       VALUES (?, ?, 'gold', ?, ?, ?, 'in_stock', 0, 'UNPAID', '[]', ?, ?, ?)`,
      [id, args.branchId, args.karat, args.deltaGrams, args.sourceLabel, now, now, userId]
    );
    trackInsert('precious_metals', id, { karat: args.karat, weightGrams: args.deltaGrams, source: args.sourceLabel });
    return;
  }
  // Outflow ohne Bestand — wir lassen es als "negatives" Inventory laufen
  // (legen einen Eintrag mit negativem Wert an, damit Reconciliation-Page das sichtbar zeigt).
  let userId: string;
  try { userId = currentUserId(); } catch { userId = 'user-owner'; }
  const id = uuid();
  db.run(
    `INSERT INTO precious_metals (id, branch_id, metal_type, karat, weight_grams,
       description, status, paid_amount, payment_status, images, created_at, updated_at, created_by)
     VALUES (?, ?, 'gold', ?, ?, ?, 'in_stock', 0, 'UNPAID', '[]', ?, ?, ?)`,
    [id, args.branchId, args.karat, args.deltaGrams, `NEG: ${args.sourceLabel}`, now, now, userId]
  );
  trackInsert('precious_metals', id, { karat: args.karat, weightGrams: args.deltaGrams, source: args.sourceLabel, negative: true });
}

interface GoldStore {
  // State
  goldPayables: GoldPayable[];
  customerGoldCredits: CustomerGoldCredit[];
  loading: boolean;

  // Loaders
  loadGoldPayables: () => void;
  loadCustomerGoldCredits: () => void;
  loadAll: () => void;

  // Create — wird beim Repair-Form-Save aufgerufen
  createGoldPayable: (data: Partial<GoldPayable>) => GoldPayable;
  createCustomerGoldCredit: (data: Partial<CustomerGoldCredit>) => CustomerGoldCredit;

  // Workshop-Gold-Settlements
  settleGoldReturn: (payableId: string, grams: number, notes?: string) => void;
  convertGoldPayableToMoney: (payableId: string, agreedBhd: number, method?: 'cash' | 'bank' | 'benefit', notes?: string) => void;
  cancelGoldPayable: (payableId: string, notes?: string) => void;

  // Customer-Credit-Settlements
  redeemCustomerCredit: (creditId: string, grams: number, repairId?: string) => void;
  returnCustomerCredit: (creditId: string, grams: number, notes?: string) => void;
  convertCustomerCreditToMoney: (creditId: string, agreedBhd: number, notes?: string) => void;
  cancelCustomerCredit: (creditId: string, notes?: string) => void;

  // Cross-Settle: Shop-Gold-Inventar → Supplier-Gold-Payable
  applyShopGoldToSupplierPayable: (payableId: string, grams: number) => void;

  // Plan v0.1.47 — Cross-Karat-Settle. Shop hat anderes Karat als Payable
  // verlangt. Purity-Conversion macht den Match (24K kann fuer 21K-Schuld
  // verwendet werden mit entsprechend weniger Gramm — gleicher pure-au-Wert).
  applyShopGoldCrossKaratToPayable: (payableId: string, sourceKarat: string, sourceGrams: number) => void;

  // Plan v0.1.45 — Customer-Gold-Leftover „Shop Keeps": Inflow ins Shop-Inventar
  // ohne Supplier/Customer-Beteiligung. Schreibt automatisch gold_movement.
  creditShopGold: (branchId: string, karat: string, grams: number, opts?: { repairId?: string; sourceLabel?: string; notes?: string }) => void;

  // Plan v0.1.46 — Audit-Eintrag fuer Gold-Inflow aus externer Quelle (Lieferanten-
  // Kauf / Direkt-Eintrag). Aufgerufen von metalStore.createMetal damit JEDE
  // Bestandserhoehung einen gold_movement-Audit-Eintrag erzeugt.
  recordExternalGoldInflow: (branchId: string, karat: string, grams: number, opts?: { supplierId?: string; metalId?: string; notes?: string }) => void;

  // Aggregate-Selektoren fuer Detail-Pages
  getGoldOwedBySupplier: (supplierId: string) => Array<{ karat: string; totalGrams: number; count: number }>;
  getGoldCreditByCustomer: (customerId: string) => Array<{ karat: string; totalGrams: number; count: number }>;
  getGoldPayablesBySupplier: (supplierId: string) => GoldPayable[];
  getGoldCreditsByCustomer: (customerId: string) => CustomerGoldCredit[];
  loadGoldMovements: (filters?: { repairId?: string; supplierId?: string; customerId?: string; limit?: number }) => GoldMovement[];

  // Plan v0.1.45 — Reconciliation: Drift-Check fuer repair_lines / expenses /
  // gold-buckets. Read-only; gibt nur Diagnose, kein Auto-Fix.
  getRepairLineDrift: () => Array<{
    repairId: string;
    repairNumber: string;
    lineId: string;
    expenseId?: string;
    drift: 'cancelled_expense' | 'missing_expense' | 'amount_mismatch' | 'orphan_expense';
    detail: string;
  }>;
  getGoldDrift: () => Array<{ karat: string; movementsNet: number; preciousMetalsSum: number; drift: number }>;

  // v0.1.49 Dashboard-Selektoren
  getTopSuppliersByGoldOwed: (limit?: number) => Array<{
    supplierId: string;
    supplierName: string;
    breakdown: Array<{ karat: string; grams: number }>;
    pureAuGrams: number;
  }>;
  getTopCustomersByGoldCredit: (limit?: number) => Array<{
    customerId: string;
    customerName: string;
    breakdown: Array<{ karat: string; grams: number }>;
    pureAuGrams: number;
  }>;
  getRecentGoldMovements: (limit?: number) => Array<{
    id: string;
    movedAt: string;
    direction: 'in' | 'out';
    weightGrams: number;
    karat: string;
    sourceBucket?: string;
    targetBucket?: string;
    relatedRepairId?: string;
    notes?: string;
  }>;
  getNegativeInventoryRows: () => Array<{
    id: string;
    karat: string;
    weightGrams: number;
    description: string;
    createdAt: string;
  }>;
  getPureGoldTotal: () => {
    totalGrams: number;
    pureAuGrams: number;
    perKarat: Array<{ karat: string; grams: number; pureAu: number }>;
  };
}

export const useGoldStore = create<GoldStore>((set, get) => ({
  goldPayables: [],
  customerGoldCredits: [],
  loading: false,

  loadGoldPayables: () => {
    try {
      const branchId = currentBranchId();
      const rows = query(
        `SELECT * FROM gold_payables WHERE branch_id = ? ORDER BY created_at DESC`,
        [branchId]
      );
      set({ goldPayables: rows.map(rowToGoldPayable) });
    } catch { set({ goldPayables: [] }); }
  },

  loadCustomerGoldCredits: () => {
    try {
      const branchId = currentBranchId();
      const rows = query(
        `SELECT * FROM customer_gold_credits WHERE branch_id = ? ORDER BY created_at DESC`,
        [branchId]
      );
      set({ customerGoldCredits: rows.map(rowToCustomerGoldCredit) });
    } catch { set({ customerGoldCredits: [] }); }
  },

  loadAll: () => {
    set({ loading: true });
    get().loadGoldPayables();
    get().loadCustomerGoldCredits();
    set({ loading: false });
  },

  createGoldPayable: (data) => {
    const db = getDatabase();
    const id = uuid();
    const now = nowIso();
    let branchId: string;
    try { branchId = currentBranchId(); } catch { branchId = 'branch-main'; }

    if (!data.supplierId) throw new Error('createGoldPayable: supplierId required');
    if (!data.weightGrams || data.weightGrams <= 0) throw new Error('createGoldPayable: weightGrams must be > 0');
    if (!data.karat) throw new Error('createGoldPayable: karat required');
    // v0.2.1 — exactly one of sourceRepairId / sourceOrderId
    if (data.sourceRepairId && data.sourceOrderId) {
      throw new Error('createGoldPayable: only one of sourceRepairId / sourceOrderId may be set');
    }

    db.run(
      `INSERT INTO gold_payables (id, branch_id, supplier_id, source_repair_id, source_repair_line_id, source_order_id,
         direction, weight_grams, karat, settlement_type, fulfilled_grams, status, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'OPEN', ?, ?, ?)`,
      [
        id, branchId, data.supplierId, data.sourceRepairId || null, data.sourceRepairLineId || null,
        data.sourceOrderId || null,
        data.direction || 'we_owe', data.weightGrams, data.karat,
        data.settlementType || 'return_gold', data.notes || null, now, now,
      ]
    );
    trackInsert('gold_payables', id, {
      supplierId: data.supplierId, weightGrams: data.weightGrams, karat: data.karat,
      settlementType: data.settlementType,
      sourceRepairId: data.sourceRepairId,
      sourceOrderId: data.sourceOrderId,
    });
    saveDatabase();
    get().loadGoldPayables();
    return get().goldPayables.find(p => p.id === id)!;
  },

  createCustomerGoldCredit: (data) => {
    const db = getDatabase();
    const id = uuid();
    const now = nowIso();
    let branchId: string;
    try { branchId = currentBranchId(); } catch { branchId = 'branch-main'; }

    if (!data.customerId) throw new Error('createCustomerGoldCredit: customerId required');
    if (!data.weightGrams || data.weightGrams <= 0) throw new Error('createCustomerGoldCredit: weightGrams must be > 0');
    if (!data.karat) throw new Error('createCustomerGoldCredit: karat required');
    // v0.2.1 — exactly one of sourceRepairId / sourceOrderId
    if (data.sourceRepairId && data.sourceOrderId) {
      throw new Error('createCustomerGoldCredit: only one of sourceRepairId / sourceOrderId may be set');
    }

    db.run(
      `INSERT INTO customer_gold_credits (id, branch_id, customer_id, source_repair_id, source_order_id,
         weight_grams, karat, fulfilled_grams, status, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'OPEN', ?, ?, ?)`,
      [
        id, branchId, data.customerId, data.sourceRepairId || null, data.sourceOrderId || null,
        data.weightGrams, data.karat, data.notes || null, now, now,
      ]
    );
    trackInsert('customer_gold_credits', id, {
      customerId: data.customerId, weightGrams: data.weightGrams, karat: data.karat,
      sourceRepairId: data.sourceRepairId,
      sourceOrderId: data.sourceOrderId,
    });
    saveDatabase();
    get().loadCustomerGoldCredits();
    return get().customerGoldCredits.find(c => c.id === id)!;
  },

  // Workshop bringt physisch X Gramm zurueck (oder wir geben aus unserem Inventar
  // X Gramm an den Workshop) → fulfilled_grams ↑ und precious_metals ↑ (Inflow vom
  // Workshop) bzw. ↓ (Outflow zu Workshop, je nach direction).
  // Standard-Fall: direction='we_owe' + settlement_type='return_gold' → Workshop hat
  // unser Gold zurueckgegeben → precious_metals ↑.
  // Bei direction='we_owe' aber Apply-Shop-Gold-To-Supplier (cross-settle) ist das
  // ein Outflow aus Shop → wird ueber applyShopGoldToSupplierPayable() gesteuert.
  // Hier: die "natuerliche" return-Variante wo der Workshop liefert.
  settleGoldReturn: (payableId, grams, notes) => {
    const db = getDatabase();
    const now = nowIso();
    const p = get().goldPayables.find(x => x.id === payableId);
    if (!p) throw new Error(`Gold-Payable ${payableId} nicht gefunden`);
    if (p.status === 'FULFILLED' || p.status === 'CANCELLED') {
      throw new Error(`Gold-Payable bereits ${p.status}`);
    }
    const newFulfilled = p.fulfilledGrams + grams;
    const isDone = newFulfilled >= p.weightGrams - 0.0001;
    const nextStatus = isDone ? 'FULFILLED' : 'OPEN';
    db.run(
      `UPDATE gold_payables SET fulfilled_grams = ?, status = ?, updated_at = ? WHERE id = ?`,
      [newFulfilled, nextStatus, now, payableId]
    );
    trackUpdate('gold_payables', payableId, { fulfilledGrams: newFulfilled, status: nextStatus });

    // Workshop liefert Gold zurueck → Shop-Inventar ↑
    adjustPreciousMetals({
      branchId: p.branchId, karat: p.karat, deltaGrams: grams,
      sourceLabel: `Gold-Return from supplier (payable ${payableId.slice(0, 8)})`,
    });

    recordGoldMovement({
      branchId: p.branchId, direction: 'in', weightGrams: grams, karat: p.karat,
      sourceBucket: 'gold_payable', sourceId: payableId,
      targetBucket: 'precious_metals',
      relatedRepairId: p.sourceRepairId,
      notes: notes || `Settlement (return_gold)`,
    });

    saveDatabase();
    get().loadGoldPayables();
  },

  // Gold-Schuld in BHD umrechnen. Erzeugt eine Expense beim verknuepften Supplier
  // (genau wie ein normaler Repair-Cost), markiert die gold_payable als FULFILLED
  // und linkt die Expense-ID. Damit ist die Gramm-Schuld geschlossen und die
  // Money-Schuld erscheint im normalen A/P-Flow.
  convertGoldPayableToMoney: (payableId, agreedBhd, method = 'bank', notes) => {
    const db = getDatabase();
    const now = nowIso();
    const p = get().goldPayables.find(x => x.id === payableId);
    if (!p) throw new Error(`Gold-Payable ${payableId} nicht gefunden`);
    if (p.status !== 'OPEN') throw new Error(`Gold-Payable bereits ${p.status}`);
    if (agreedBhd <= 0) throw new Error('Agreed BHD muss > 0 sein');

    let branchId: string, userId: string;
    try { branchId = currentBranchId(); userId = currentUserId(); }
    catch { branchId = p.branchId; userId = 'user-owner'; }

    const expenseId = uuid();
    const expenseNumber = getNextDocumentNumber('EXP');
    const remainingGrams = p.weightGrams - p.fulfilledGrams;
    const description = `Gold-Settlement: ${remainingGrams.toFixed(3)}g ${p.karat} (gold_payable ${payableId.slice(0, 8)})`;

    db.run(
      `INSERT INTO expenses (id, branch_id, expense_number, category, amount, paid_amount, payment_method,
         expense_date, description, related_module, related_entity_id, supplier_id, status, created_at, created_by)
       VALUES (?, ?, ?, 'RepairCosts', ?, 0, ?, ?, ?, 'gold_payable', ?, ?, 'PENDING', ?, ?)`,
      [
        expenseId, branchId, expenseNumber, agreedBhd, method,
        now.split('T')[0], description, payableId, p.supplierId, now, userId,
      ]
    );
    trackInsert('expenses', expenseId, {
      category: 'RepairCosts', amount: agreedBhd, sourceGoldPayableId: payableId,
      supplierId: p.supplierId, status: 'PENDING',
    });

    const expenseRecord: Expense = {
      id: expenseId, expenseNumber, branchId, category: 'RepairCosts',
      amount: agreedBhd, paidAmount: 0, paymentMethod: method,
      expenseDate: now.split('T')[0], description,
      relatedModule: 'gold_payable', relatedEntityId: payableId,
      supplierId: p.supplierId, status: 'PENDING', createdAt: now,
    };
    safePost(`postExpense(${expenseId}) [gold-convert]`, () => {
      if (hasLedgerEntries('EXPENSE', expenseId)) return;
      postExpense(expenseRecord);
    });

    db.run(
      `UPDATE gold_payables SET settlement_expense_id = ?, status = 'FULFILLED',
         fulfilled_grams = weight_grams, notes = COALESCE(notes, '') || ?, updated_at = ?
         WHERE id = ?`,
      [expenseId, ' · ' + (notes || `Converted to ${agreedBhd} BHD`), now, payableId]
    );
    trackUpdate('gold_payables', payableId, {
      status: 'FULFILLED', settlementExpenseId: expenseId, convertedTo: agreedBhd,
    });

    recordGoldMovement({
      branchId: p.branchId, direction: 'out', weightGrams: remainingGrams, karat: p.karat,
      sourceBucket: 'gold_payable', sourceId: payableId,
      targetBucket: 'external',
      relatedRepairId: p.sourceRepairId,
      notes: notes || `Converted ${remainingGrams.toFixed(3)}g to ${agreedBhd} BHD`,
    });

    saveDatabase();
    get().loadGoldPayables();
  },

  cancelGoldPayable: (payableId, notes) => {
    const db = getDatabase();
    const now = nowIso();
    const p = get().goldPayables.find(x => x.id === payableId);
    if (!p) return;
    if (p.status === 'CANCELLED' || p.status === 'FULFILLED') return;
    db.run(
      `UPDATE gold_payables SET status = 'CANCELLED', notes = COALESCE(notes, '') || ?, updated_at = ? WHERE id = ?`,
      [' · ' + (notes || 'Cancelled'), now, payableId]
    );
    trackUpdate('gold_payables', payableId, { status: 'CANCELLED' });
    saveDatabase();
    get().loadGoldPayables();
  },

  // Customer-Gold-Credit beim naechsten Repair anteilig einloesen. Wird vom
  // Repair-Form aufgerufen wenn der User die Source 'customer-credit' waehlt.
  // Schreibt KEINEN Expense oder Ledger-Eintrag — nur die Gramm werden verbucht.
  redeemCustomerCredit: (creditId, grams, repairId) => {
    const db = getDatabase();
    const now = nowIso();
    const c = get().customerGoldCredits.find(x => x.id === creditId);
    if (!c) throw new Error(`Customer-Gold-Credit ${creditId} nicht gefunden`);
    if (c.status !== 'OPEN') throw new Error(`Credit bereits ${c.status}`);
    const remaining = c.weightGrams - c.fulfilledGrams;
    if (grams > remaining + 0.0001) {
      throw new Error(`Nur ${remaining.toFixed(3)}g verbleibend — kann nicht ${grams.toFixed(3)}g einloesen`);
    }
    const newFulfilled = c.fulfilledGrams + grams;
    const isDone = newFulfilled >= c.weightGrams - 0.0001;
    const nextStatus = isDone ? 'FULFILLED' : 'OPEN';
    // Atomar via SQL — verhindert Race wenn 2 gleichzeitige Repairs denselben Credit nutzen
    const res = db.run(
      `UPDATE customer_gold_credits SET fulfilled_grams = ?, status = ?, updated_at = ?
         WHERE id = ? AND fulfilled_grams + ? <= weight_grams + 0.0001`,
      [newFulfilled, nextStatus, now, creditId, grams]
    );
    // sql.js: db.run gibt nichts zurueck — wir muessen separat checken
    void res;
    trackUpdate('customer_gold_credits', creditId, { fulfilledGrams: newFulfilled, status: nextStatus });

    recordGoldMovement({
      branchId: c.branchId, direction: 'in', weightGrams: grams, karat: c.karat,
      sourceBucket: 'customer_gold_credit', sourceId: creditId,
      targetBucket: 'repair_consumption', targetId: repairId,
      relatedRepairId: repairId,
      notes: `Redeemed in repair`,
    });

    saveDatabase();
    get().loadCustomerGoldCredits();
  },

  // Customer holt physisch X Gramm seines Guthabens ab. Kein Ledger-Effekt.
  returnCustomerCredit: (creditId, grams, notes) => {
    const db = getDatabase();
    const now = nowIso();
    const c = get().customerGoldCredits.find(x => x.id === creditId);
    if (!c) throw new Error(`Customer-Gold-Credit ${creditId} nicht gefunden`);
    if (c.status !== 'OPEN') throw new Error(`Credit bereits ${c.status}`);
    const newFulfilled = c.fulfilledGrams + grams;
    const isDone = newFulfilled >= c.weightGrams - 0.0001;
    const nextStatus = isDone ? 'FULFILLED' : 'OPEN';
    db.run(
      `UPDATE customer_gold_credits SET fulfilled_grams = ?, status = ?, updated_at = ?,
         notes = COALESCE(notes, '') || ? WHERE id = ?`,
      [newFulfilled, nextStatus, now, ' · returned ' + grams.toFixed(3) + 'g' + (notes ? ' (' + notes + ')' : ''), creditId]
    );
    trackUpdate('customer_gold_credits', creditId, { fulfilledGrams: newFulfilled, status: nextStatus });

    recordGoldMovement({
      branchId: c.branchId, direction: 'out', weightGrams: grams, karat: c.karat,
      sourceBucket: 'customer_gold_credit', sourceId: creditId,
      targetBucket: 'external',
      notes: notes || `Returned to customer`,
    });

    saveDatabase();
    get().loadCustomerGoldCredits();
  },

  // Customer-Gold-Credit zu BHD-Refund konvertieren. Erzeugt einen
  // customer_credits-Eintrag (BHD-basiert), den die Returns-Refund-Logik
  // einloesen kann. Gold-Credit wird FULFILLED.
  convertCustomerCreditToMoney: (creditId, agreedBhd, notes) => {
    const db = getDatabase();
    const now = nowIso();
    const c = get().customerGoldCredits.find(x => x.id === creditId);
    if (!c) throw new Error(`Customer-Gold-Credit ${creditId} nicht gefunden`);
    if (c.status !== 'OPEN') throw new Error(`Credit bereits ${c.status}`);
    if (agreedBhd <= 0) throw new Error('Agreed BHD muss > 0 sein');

    const remainingGrams = c.weightGrams - c.fulfilledGrams;
    let branchId: string;
    try { branchId = currentBranchId(); } catch { branchId = c.branchId; }
    const creditId2 = uuid();

    // Pruefen ob die customer_credits-Tabelle existiert. Falls nicht, nur als
    // Notiz im Credit speichern + Movement schreiben (Sicherheits-Fallback).
    try {
      db.run(
        `INSERT INTO customer_credits (id, branch_id, customer_id, amount, used_amount, status,
           source_type, source_id, note, created_at)
         VALUES (?, ?, ?, ?, 0, 'OPEN', 'gold_conversion', ?, ?, ?)`,
        [creditId2, branchId, c.customerId, agreedBhd, creditId,
         `Gold-Conversion: ${remainingGrams.toFixed(3)}g ${c.karat}` + (notes ? ' · ' + notes : ''), now]
      );
      trackInsert('customer_credits', creditId2, {
        customerId: c.customerId, amount: agreedBhd, sourceGoldCreditId: creditId,
      });
    } catch (err) {
      console.warn('[gold] customer_credits insert failed — table may not exist:', err);
    }

    db.run(
      `UPDATE customer_gold_credits SET settlement_credit_id = ?, status = 'FULFILLED',
         fulfilled_grams = weight_grams, notes = COALESCE(notes, '') || ?, updated_at = ?
         WHERE id = ?`,
      [creditId2, ' · Converted to ' + agreedBhd + ' BHD', now, creditId]
    );
    trackUpdate('customer_gold_credits', creditId, {
      status: 'FULFILLED', settlementCreditId: creditId2, convertedTo: agreedBhd,
    });

    recordGoldMovement({
      branchId: c.branchId, direction: 'out', weightGrams: remainingGrams, karat: c.karat,
      sourceBucket: 'customer_gold_credit', sourceId: creditId,
      targetBucket: 'external',
      notes: notes || `Converted ${remainingGrams.toFixed(3)}g to ${agreedBhd} BHD`,
    });

    saveDatabase();
    get().loadCustomerGoldCredits();
  },

  cancelCustomerCredit: (creditId, notes) => {
    const db = getDatabase();
    const now = nowIso();
    const c = get().customerGoldCredits.find(x => x.id === creditId);
    if (!c) return;
    if (c.status === 'CANCELLED' || c.status === 'FULFILLED') return;
    db.run(
      `UPDATE customer_gold_credits SET status = 'CANCELLED', notes = COALESCE(notes, '') || ?, updated_at = ? WHERE id = ?`,
      [' · ' + (notes || 'Cancelled'), now, creditId]
    );
    trackUpdate('customer_gold_credits', creditId, { status: 'CANCELLED' });
    saveDatabase();
    get().loadCustomerGoldCredits();
  },

  // Cross-Settle: Shop-Inventar → Workshop-Gold-Payable. Setzt voraus dass
  // der User bewusst diese Aktion waehlt (z.B. weil eine Customer-Restmenge
  // beim Shop liegt und gleichzeitig ein Workshop-Payable offen ist).
  applyShopGoldToSupplierPayable: (payableId, grams) => {
    const db = getDatabase();
    const now = nowIso();
    const p = get().goldPayables.find(x => x.id === payableId);
    if (!p) throw new Error(`Gold-Payable ${payableId} nicht gefunden`);
    if (p.status !== 'OPEN') throw new Error(`Gold-Payable bereits ${p.status}`);
    const remaining = p.weightGrams - p.fulfilledGrams;
    if (grams > remaining + 0.0001) {
      throw new Error(`Nur ${remaining.toFixed(3)}g verbleibend — kann nicht ${grams.toFixed(3)}g anwenden`);
    }

    // Shop-Inventar ↓ (Outflow)
    adjustPreciousMetals({
      branchId: p.branchId, karat: p.karat, deltaGrams: -grams,
      sourceLabel: `Applied to supplier gold-payable ${payableId.slice(0, 8)}`,
    });

    // Gold-Payable ↑ fulfilled
    const newFulfilled = p.fulfilledGrams + grams;
    const isDone = newFulfilled >= p.weightGrams - 0.0001;
    const nextStatus = isDone ? 'FULFILLED' : 'OPEN';
    db.run(
      `UPDATE gold_payables SET fulfilled_grams = ?, status = ?, updated_at = ? WHERE id = ?`,
      [newFulfilled, nextStatus, now, payableId]
    );
    trackUpdate('gold_payables', payableId, { fulfilledGrams: newFulfilled, status: nextStatus });

    recordGoldMovement({
      branchId: p.branchId, direction: 'out', weightGrams: grams, karat: p.karat,
      sourceBucket: 'precious_metals',
      targetBucket: 'gold_payable', targetId: payableId,
      relatedRepairId: p.sourceRepairId,
      notes: `Cross-Settle: Shop gold applied to supplier payable`,
    });

    saveDatabase();
    get().loadGoldPayables();
  },

  // Plan v0.1.47 — Cross-Karat-Settle: Shop-Inventar in einem ANDEREN Karat
  // wird auf einen Supplier-Payable angewendet. Purity-Math sorgt fuer
  // pure-gold-aequivalenten Transfer.
  //
  // Beispiel: Supplier-Payable verlangt 10g 21K (= 8.75g pure Au).
  //   Shop hat 24K-Bestand. Wenn User 8.76g vom 24K-Bestand einsetzt
  //   (=8.75g pure Au), wird der Payable voll getilgt.
  //
  // Aufrufer gibt sourceKarat + sourceGrams an. Wir berechnen wieviel das
  // im Target-Karat (= p.karat) wert ist und fulfillen den Payable
  // entsprechend (max bis voll). Wenn target_equivalent > remaining → Fehler
  // (Aufrufer sollte vorher targetEquivalent() pruefen und ggf. weniger
  // sourceGrams uebergeben).
  applyShopGoldCrossKaratToPayable: (payableId, sourceKarat, sourceGrams) => {
    const db = getDatabase();
    const now = nowIso();
    const p = get().goldPayables.find(x => x.id === payableId);
    if (!p) throw new Error(`Gold-Payable ${payableId} nicht gefunden`);
    if (p.status !== 'OPEN') throw new Error(`Gold-Payable bereits ${p.status}`);
    if (!Number.isFinite(sourceGrams) || sourceGrams <= 0) {
      throw new Error('sourceGrams muss > 0 sein');
    }

    // Purity-Math: wieviel Target-Karat-Aequivalent sind X Gramm Source-Karat?
    // Async-Import um Bundle-Splitting nicht zu zerstoeren.
    // (purity.ts ist 1kb, kein Issue.)
    const sourceP = PURITY_LOOKUP[sourceKarat] ?? 1.0;
    const targetP = PURITY_LOOKUP[p.karat] ?? 1.0;
    if (sourceP <= 0 || targetP <= 0) {
      throw new Error(`Ungueltiges Karat: source=${sourceKarat} target=${p.karat}`);
    }
    const targetEquivalentGrams = (sourceGrams * sourceP) / targetP;
    const remaining = p.weightGrams - p.fulfilledGrams;
    if (targetEquivalentGrams > remaining + 0.0001) {
      throw new Error(
        `${sourceGrams.toFixed(3)}g ${sourceKarat} = ${targetEquivalentGrams.toFixed(3)}g ${p.karat}-aequivalent — ` +
        `Payable hat nur ${remaining.toFixed(3)}g verbleibend.`
      );
    }

    // Shop-Inventar ↓ (Outflow in source-karat)
    adjustPreciousMetals({
      branchId: p.branchId, karat: sourceKarat, deltaGrams: -sourceGrams,
      sourceLabel: `Cross-karat applied: ${sourceGrams.toFixed(3)}g ${sourceKarat} → payable ${payableId.slice(0, 8)} (${p.karat})`,
    });

    // Gold-Payable ↑ fulfilled (in target-karat)
    const newFulfilled = p.fulfilledGrams + targetEquivalentGrams;
    const isDone = newFulfilled >= p.weightGrams - 0.0001;
    const nextStatus = isDone ? 'FULFILLED' : 'OPEN';
    db.run(
      `UPDATE gold_payables SET fulfilled_grams = ?, status = ?, updated_at = ? WHERE id = ?`,
      [newFulfilled, nextStatus, now, payableId]
    );
    trackUpdate('gold_payables', payableId, { fulfilledGrams: newFulfilled, status: nextStatus });

    // gold_movement-Audit: zwei separate Eintraege um Source + Target jeweils
    // korrekt mit Karat + Gramm zu zeigen. Anders als bei Same-Karat-Cross-Settle
    // muessen wir die unterschiedlichen Gewichte transparent machen — der Owner
    // soll im Audit sehen "8.76g 24K wurden zu 10g 21K-Schuld aequivalent".
    recordGoldMovement({
      branchId: p.branchId, direction: 'out', weightGrams: sourceGrams, karat: sourceKarat,
      sourceBucket: 'precious_metals',
      targetBucket: 'gold_payable', targetId: payableId,
      relatedRepairId: p.sourceRepairId,
      notes: `Cross-Karat-Settle OUT: ${sourceGrams.toFixed(3)}g ${sourceKarat} (${(sourceP * 100).toFixed(1)}% fine) → ${targetEquivalentGrams.toFixed(3)}g ${p.karat}-equivalent`,
    });
    recordGoldMovement({
      branchId: p.branchId, direction: 'in', weightGrams: targetEquivalentGrams, karat: p.karat,
      sourceBucket: 'precious_metals',
      targetBucket: 'gold_payable', targetId: payableId,
      relatedRepairId: p.sourceRepairId,
      notes: `Cross-Karat-Settle FULFILL: payable in ${p.karat} reduced by ${targetEquivalentGrams.toFixed(3)}g (au-equivalent from ${sourceKarat})`,
    });

    saveDatabase();
    get().loadGoldPayables();
  },

  // ─── Aggregatoren fuer Detail-Pages ───

  getGoldOwedBySupplier: (supplierId) => {
    try {
      const rows = query(
        `SELECT karat,
                SUM(weight_grams - fulfilled_grams) AS total_grams,
                COUNT(*) AS cnt
           FROM gold_payables
           WHERE supplier_id = ? AND status = 'OPEN'
           GROUP BY karat
           ORDER BY karat`,
        [supplierId]
      );
      return rows.map(r => ({
        karat: r.karat as string,
        totalGrams: (r.total_grams as number) || 0,
        count: (r.cnt as number) || 0,
      })).filter(r => r.totalGrams > 0);
    } catch { return []; }
  },

  getGoldCreditByCustomer: (customerId) => {
    try {
      const rows = query(
        `SELECT karat,
                SUM(weight_grams - fulfilled_grams) AS total_grams,
                COUNT(*) AS cnt
           FROM customer_gold_credits
           WHERE customer_id = ? AND status = 'OPEN'
           GROUP BY karat
           ORDER BY karat`,
        [customerId]
      );
      return rows.map(r => ({
        karat: r.karat as string,
        totalGrams: (r.total_grams as number) || 0,
        count: (r.cnt as number) || 0,
      })).filter(r => r.totalGrams > 0);
    } catch { return []; }
  },

  getGoldPayablesBySupplier: (supplierId) =>
    get().goldPayables.filter(p => p.supplierId === supplierId),

  getGoldCreditsByCustomer: (customerId) =>
    get().customerGoldCredits.filter(c => c.customerId === customerId),

  loadGoldMovements: (filters = {}) => {
    try {
      const conds: string[] = [];
      const params: unknown[] = [];
      if (filters.repairId) { conds.push('related_repair_id = ?'); params.push(filters.repairId); }
      // For supplier/customer movements, we look up via the source_id linking to gold_payables/customer_gold_credits
      const where = conds.length > 0 ? 'WHERE ' + conds.join(' AND ') : '';
      const limit = filters.limit || 100;
      const rows = query(
        `SELECT * FROM gold_movements ${where} ORDER BY moved_at DESC LIMIT ?`,
        [...params, limit]
      );
      return rows.map(rowToGoldMovement);
    } catch { return []; }
  },

  // Plan v0.1.46 — externer Gold-Inflow (Lieferanten-Kauf, Direkt-Eintrag in
  // /metals). Wird von metalStore.createMetal aufgerufen damit jedes Inflow
  // einen gold_movement-Audit-Eintrag erzeugt. Bei supplierId wird der Movement
  // mit source_bucket=external + source_id=supplierId getaggt; bei manueller
  // Erfassung ohne Supplier ist nur source_bucket=external gesetzt.
  recordExternalGoldInflow: (branchId, karat, grams, opts = {}) => {
    if (!Number.isFinite(grams) || grams <= 0) {
      throw new Error('recordExternalGoldInflow: grams must be > 0');
    }
    if (!karat) throw new Error('recordExternalGoldInflow: karat required');
    recordGoldMovement({
      branchId, direction: 'in', weightGrams: grams, karat,
      sourceBucket: 'external',
      sourceId: opts.supplierId,
      targetBucket: 'precious_metals',
      targetId: opts.metalId,
      notes: opts.notes || (opts.supplierId
        ? `Purchase from supplier ${opts.supplierId.slice(0, 8)}`
        : 'Manual inventory entry'),
    });
    saveDatabase();
  },

  // Plan v0.1.45 — Customer-Gold-Leftover „Shop Keeps" als direkter Inflow
  // ins Shop-Inventar. Source-Bucket = 'repair_consumption' damit der
  // Audit-Trail klar zeigt woher das Gold kommt (Customer brachte X g, der
  // Shop behaelt den Rest als implizite Reparatur-Gebuehr-Komponente).
  creditShopGold: (branchId, karat, grams, opts = {}) => {
    if (!Number.isFinite(grams) || grams <= 0) {
      throw new Error('creditShopGold: grams must be > 0');
    }
    if (!karat) throw new Error('creditShopGold: karat required');

    const label = opts.sourceLabel || (opts.repairId
      ? `Customer-leftover from repair ${opts.repairId.slice(0, 8)}`
      : `Shop-keeps gold credit`);

    adjustPreciousMetals({
      branchId, karat, deltaGrams: grams, sourceLabel: label,
    });
    recordGoldMovement({
      branchId, direction: 'in', weightGrams: grams, karat,
      sourceBucket: 'repair_consumption',
      sourceId: opts.repairId,
      targetBucket: 'precious_metals',
      relatedRepairId: opts.repairId,
      notes: opts.notes || label,
    });

    saveDatabase();
    // Reload nicht noetig — precious_metals wird nicht im Store gecacht.
  },

  // Plan v0.1.45 — Reconciliation: pruefe Drift zwischen repair_lines.expense_id
  // und expenses-Status / -Existenz. Liefert Liste von Problemen die manuell
  // (vom Owner) gesichtet werden muessen.
  getRepairLineDrift: () => {
    try {
      // LEFT JOIN: jede repair_line mit ihrer (optionalen) expense + repair.
      // Wir suchen:
      //   - drift='cancelled_expense' → line.expense_id zeigt auf CANCELLED expense (line aber OPEN)
      //   - drift='missing_expense'   → line.expense_id ist gesetzt aber expense existiert nicht
      //   - drift='amount_mismatch'   → line.cost_amount != expense.amount
      //   - drift='orphan_expense'    → expense mit related_module='repair' aber kein passender repair_line
      const drifts: ReturnType<GoldStore['getRepairLineDrift']> = [];

      const lineRows = query(
        `SELECT rl.id AS line_id, rl.repair_id, rl.expense_id, rl.cost_amount, rl.status AS line_status,
                r.repair_number,
                e.id AS exp_id, e.amount AS exp_amount, e.status AS exp_status, e.related_entity_id
           FROM repair_lines rl
           JOIN repairs r ON r.id = rl.repair_id
           LEFT JOIN expenses e ON e.id = rl.expense_id`
      );
      for (const row of lineRows) {
        const lineId = row.line_id as string;
        const repairId = row.repair_id as string;
        const repairNumber = (row.repair_number as string) || '?';
        const expId = (row.expense_id as string) || undefined;
        const cost = (row.cost_amount as number) || 0;
        const lineStatus = row.line_status as string;
        const expExisting = !!row.exp_id;
        const expAmount = (row.exp_amount as number) || 0;
        const expStatus = row.exp_status as string | undefined;

        if (expId && !expExisting) {
          drifts.push({
            repairId, repairNumber, lineId, expenseId: expId,
            drift: 'missing_expense',
            detail: `Line linkt auf expense_id=${expId.slice(0,8)} — Expense existiert nicht in der DB`,
          });
          continue;
        }
        if (expId && expStatus === 'CANCELLED' && lineStatus === 'OPEN') {
          drifts.push({
            repairId, repairNumber, lineId, expenseId: expId,
            drift: 'cancelled_expense',
            detail: `Line OPEN aber verknuepfte Expense ist CANCELLED — Cost ${cost.toFixed(3)} BHD nicht im A/P`,
          });
          continue;
        }
        if (expId && expExisting && lineStatus === 'OPEN' && Math.abs(cost - expAmount) > 0.005) {
          drifts.push({
            repairId, repairNumber, lineId, expenseId: expId,
            drift: 'amount_mismatch',
            detail: `Line-Cost=${cost.toFixed(3)} vs Expense-Amount=${expAmount.toFixed(3)} (Drift ${(cost - expAmount).toFixed(3)})`,
          });
        }
      }

      // Orphan expenses: related_module='repair' aber kein passender repair_line.expense_id
      const orphanRows = query(
        `SELECT e.id AS exp_id, e.amount, e.related_entity_id, e.status,
                r.repair_number
           FROM expenses e
           LEFT JOIN repair_lines rl ON rl.expense_id = e.id
           LEFT JOIN repairs r ON r.id = e.related_entity_id
           WHERE e.related_module = 'repair'
             AND e.status != 'CANCELLED'
             AND rl.id IS NULL`
      );
      for (const row of orphanRows) {
        const repairId = (row.related_entity_id as string) || '';
        const repairNumber = (row.repair_number as string) || '?';
        const expId = row.exp_id as string;
        const amount = (row.amount as number) || 0;
        drifts.push({
          repairId, repairNumber, lineId: '', expenseId: expId,
          drift: 'orphan_expense',
          detail: `Expense ${expId.slice(0,8)} (${amount.toFixed(3)} BHD) ohne repair_line-Link — Backfill verpasst oder Line geloescht?`,
        });
      }

      return drifts;
    } catch (err) {
      console.error('[gold] getRepairLineDrift failed:', err);
      return [];
    }
  },

  getGoldDrift: () => {
    try {
      const rows = query(
        `SELECT karat,
                COALESCE(SUM(CASE WHEN direction='in' THEN weight_grams ELSE -weight_grams END), 0) AS net_movement
           FROM gold_movements
           GROUP BY karat`
      );
      const pmRows = query(
        `SELECT karat, COALESCE(SUM(weight_grams), 0) AS pm_sum FROM precious_metals
           WHERE status = 'in_stock' AND karat IS NOT NULL
           GROUP BY karat`
      );
      const pmMap: Record<string, number> = {};
      for (const r of pmRows) {
        pmMap[r.karat as string] = (r.pm_sum as number) || 0;
      }

      const out: ReturnType<GoldStore['getGoldDrift']> = [];
      // Karate aus beiden Quellen kombinieren
      const allKarats = new Set<string>([
        ...rows.map(r => r.karat as string),
        ...Object.keys(pmMap),
      ]);
      for (const k of Array.from(allKarats).filter(Boolean)) {
        const mv = rows.find(r => r.karat === k);
        const movementsNet = mv ? (mv.net_movement as number) : 0;
        const pmSum = pmMap[k] || 0;
        out.push({
          karat: k,
          movementsNet,
          preciousMetalsSum: pmSum,
          drift: movementsNet - pmSum,
        });
      }
      return out.sort((a, b) => a.karat.localeCompare(b.karat));
    } catch (err) {
      console.error('[gold] getGoldDrift failed:', err);
      return [];
    }
  },

  // ── v0.1.49 Dashboard-Selektoren ────────────────────────────────────

  // Top-Lieferanten nach Gold-Schuld (we_owe). Pure-Au-summiert ueber alle
  // Karate des Lieferanten damit ein einziger Vergleichswert entsteht.
  getTopSuppliersByGoldOwed: (limit = 5) => {
    try {
      const rows = query(
        `SELECT gp.supplier_id, s.name AS supplier_name,
                gp.karat,
                SUM(gp.weight_grams - gp.fulfilled_grams) AS open_grams
           FROM gold_payables gp
           LEFT JOIN suppliers s ON s.id = gp.supplier_id
           WHERE gp.status = 'OPEN' AND gp.direction = 'we_owe'
           GROUP BY gp.supplier_id, gp.karat
           HAVING open_grams > 0
           ORDER BY open_grams DESC`
      );
      // Aggregate by supplier (sum pure-au across karats)
      const PURITY: Record<string, number> = {
        '24K': 0.999, '22K': 0.916, '21K': 0.875, '18K': 0.75, '14K': 0.585, '9K': 0.375,
      };
      const map: Record<string, { supplierId: string; supplierName: string;
        breakdown: Array<{ karat: string; grams: number }>; pureAuGrams: number }> = {};
      for (const r of rows) {
        const sid = r.supplier_id as string;
        const name = (r.supplier_name as string) || sid.slice(0, 8);
        const karat = r.karat as string;
        const grams = (r.open_grams as number) || 0;
        const pure = grams * (PURITY[karat] ?? 1);
        if (!map[sid]) map[sid] = { supplierId: sid, supplierName: name, breakdown: [], pureAuGrams: 0 };
        map[sid].breakdown.push({ karat, grams });
        map[sid].pureAuGrams += pure;
      }
      return Object.values(map).sort((a, b) => b.pureAuGrams - a.pureAuGrams).slice(0, limit);
    } catch { return []; }
  },

  // Spiegel-Analog fuer Customer-Gold-Credits (we_owe an Kunden).
  getTopCustomersByGoldCredit: (limit = 5) => {
    try {
      const rows = query(
        `SELECT cc.customer_id,
                COALESCE(c.first_name || ' ' || c.last_name, '(unnamed)') AS customer_name,
                cc.karat,
                SUM(cc.weight_grams - cc.fulfilled_grams) AS open_grams
           FROM customer_gold_credits cc
           LEFT JOIN customers c ON c.id = cc.customer_id
           WHERE cc.status = 'OPEN'
           GROUP BY cc.customer_id, cc.karat
           HAVING open_grams > 0
           ORDER BY open_grams DESC`
      );
      const PURITY: Record<string, number> = {
        '24K': 0.999, '22K': 0.916, '21K': 0.875, '18K': 0.75, '14K': 0.585, '9K': 0.375,
      };
      const map: Record<string, { customerId: string; customerName: string;
        breakdown: Array<{ karat: string; grams: number }>; pureAuGrams: number }> = {};
      for (const r of rows) {
        const cid = r.customer_id as string;
        const name = (r.customer_name as string) || cid.slice(0, 8);
        const karat = r.karat as string;
        const grams = (r.open_grams as number) || 0;
        const pure = grams * (PURITY[karat] ?? 1);
        if (!map[cid]) map[cid] = { customerId: cid, customerName: name.trim(), breakdown: [], pureAuGrams: 0 };
        map[cid].breakdown.push({ karat, grams });
        map[cid].pureAuGrams += pure;
      }
      return Object.values(map).sort((a, b) => b.pureAuGrams - a.pureAuGrams).slice(0, limit);
    } catch { return []; }
  },

  // Letzte N gold_movements fuer Recent-Activity-Feed im Dashboard.
  getRecentGoldMovements: (limit = 20) => {
    try {
      const rows = query(
        `SELECT id, moved_at, direction, weight_grams, karat, source_bucket, target_bucket,
                related_repair_id, notes
           FROM gold_movements
           ORDER BY moved_at DESC LIMIT ?`,
        [limit]
      );
      return rows.map(r => ({
        id: r.id as string,
        movedAt: r.moved_at as string,
        direction: r.direction as 'in' | 'out',
        weightGrams: (r.weight_grams as number) || 0,
        karat: (r.karat as string) || '',
        sourceBucket: (r.source_bucket as string) || undefined,
        targetBucket: (r.target_bucket as string) || undefined,
        relatedRepairId: (r.related_repair_id as string) || undefined,
        notes: (r.notes as string) || undefined,
      }));
    } catch { return []; }
  },

  // Negative precious_metals rows = Anomalie (Outflow ohne Bestand entstanden).
  // Surfacing fuer Owner damit das nicht stillschweigend auflaeuft.
  getNegativeInventoryRows: () => {
    try {
      const rows = query(
        `SELECT id, branch_id, karat, weight_grams, description, created_at
           FROM precious_metals
           WHERE status = 'in_stock' AND weight_grams < 0
           ORDER BY weight_grams ASC`
      );
      return rows.map(r => ({
        id: r.id as string,
        karat: (r.karat as string) || '',
        weightGrams: (r.weight_grams as number) || 0,
        description: (r.description as string) || '',
        createdAt: (r.created_at as string) || '',
      }));
    } catch { return []; }
  },

  // Pure-Gold-Aggregat ueber alle Karate (24K-Equivalent). Schnell-Sicht
  // fuer „wieviel Gold habe ich physisch insgesamt im Shop?".
  getPureGoldTotal: () => {
    try {
      const rows = query(
        `SELECT karat, COALESCE(SUM(weight_grams), 0) AS total
           FROM precious_metals
           WHERE status = 'in_stock' AND karat IS NOT NULL AND weight_grams > 0
           GROUP BY karat`
      );
      const PURITY: Record<string, number> = {
        '24K': 0.999, '22K': 0.916, '21K': 0.875, '18K': 0.75, '14K': 0.585, '9K': 0.375,
      };
      let totalGrams = 0, pureAu = 0;
      const perKarat: Array<{ karat: string; grams: number; pureAu: number }> = [];
      for (const r of rows) {
        const k = r.karat as string;
        const g = (r.total as number) || 0;
        const p = g * (PURITY[k] ?? 1);
        totalGrams += g;
        pureAu += p;
        perKarat.push({ karat: k, grams: g, pureAu: p });
      }
      return { totalGrams, pureAuGrams: pureAu, perKarat: perKarat.sort((a,b) => a.karat.localeCompare(b.karat)) };
    } catch { return { totalGrams: 0, pureAuGrams: 0, perKarat: [] }; }
  },
}));
