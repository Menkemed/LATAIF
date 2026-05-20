// ═══════════════════════════════════════════════════════════
// LATAIF — Purchase Store (Plan §Purchases + §Purchase Returns)
// ═══════════════════════════════════════════════════════════
//
// Regeln (Plan §5, §14, §17):
//  - Ware kommt IMMER ins Inventar (egal ob bezahlt oder nicht)
//  - Payable = total_amount − paid_amount
//  - Status: DRAFT | UNPAID | PARTIALLY_PAID | PAID | CANCELLED
//  - Teilzahlungen erlaubt, Status wird automatisch aktualisiert

import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { Purchase, PurchaseLine, PurchasePayment, PurchaseStatus, PurchaseReturn, PurchaseReturnLine, PurchaseReturnStatus, Product } from '@/core/models/types';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId, getNextDocumentNumber } from '@/core/db/helpers';
import { trackInsert, trackUpdate, trackDelete, trackStatusChange, trackPayment, trackRefund } from '@/core/sync/track';
import { syncProductQuantity } from '@/core/lots/lot-queries';
import { useProductStore } from '@/stores/productStore';
import {
  postPurchaseReceived,
  postPurchasePayment,
  postPurchaseCancelled,
  postEntries,
  hasLedgerEntries,
  hasReversalFor,
} from '@/core/ledger/posting';

// ZIEL.md §3a — Posting-Service ist der einzige Schreibpfad für Finanzbuchungen.
// Wenn die Buchung scheitert, wird das Domain-Insert NICHT zurückgerollt; stattdessen
// loggen wir und überlassen die Korrektur der Reconciliation-View. Der operative Flow
// (Purchase / Payment / Cancel) darf nicht an einer Bilanz-Diskrepanz blockiert werden.
function safePost(label: string, fn: () => void): void {
  try { fn(); } catch (err) {
    console.error(`[ledger] ${label} failed:`, err);
  }
}

interface PurchaseInput {
  supplierId: string;
  purchaseDate?: string;
  notes?: string;
  staffId?: string;
  lines: Array<{
    productId?: string;       // if omitted → new product is created
    // Plan §Purchase §New-Item: bei „New" wird das Produkt mit voller
    // Collection-Spec angelegt (Kategorie + dyn. Attribute + Photos + Tax-Scheme).
    // Legacy-Felder newProductBrand/Name/etc. bleiben als Fallback erhalten.
    newProduct?: Partial<Product>;
    newProductBrand?: string;
    newProductName?: string;
    newProductCategoryId?: string;
    newProductSku?: string;
    description?: string;
    quantity: number;
    unitPrice: number;        // gross-incl-VAT pro Stück (was an den Lieferanten gezahlt wird)
    // Plan §Purchase §Tax: Input-VAT (Vorsteuer) per Line.
    taxScheme?: 'ZERO' | 'VAT_10';
    vatRate?: number;          // 0 oder 10
  }>;
  initialPayment?: { amount: number; method: 'cash' | 'bank' | 'benefit'; reference?: string };
}

// v0.4.0 — Mobile-Capture: ein Foto aus der /mobile-Seite, das noch zu einer
// echten Purchase werden soll. Klick im Desktop oeffnet damit New Purchase.
export interface PurchaseInboxItem {
  id: string;
  branchId: string;
  images: string[];
  note?: string;
  status: string;
  createdAt: string;
}

interface PurchaseStore {
  purchases: Purchase[];
  returns: PurchaseReturn[];
  purchaseInbox: PurchaseInboxItem[];
  loading: boolean;
  loadPurchases: () => void;
  loadReturns: () => void;
  getPurchase: (id: string) => Purchase | undefined;
  getReturn: (id: string) => PurchaseReturn | undefined;
  createPurchase: (input: PurchaseInput) => Purchase;
  addPayment: (purchaseId: string, amount: number, method: 'cash' | 'bank' | 'benefit' | 'credit', reference?: string, note?: string) => void;
  cancelPurchase: (id: string) => void;
  deletePurchase: (id: string) => void;
  // Returns
  createReturn: (input: {
    purchaseId: string;
    returnDate?: string;
    refundMethod?: 'cash' | 'bank' | 'benefit' | 'credit';
    notes?: string;
    lines: Array<{ purchaseLineId: string; productId?: string; quantity: number; unitPrice: number }>;
  }) => PurchaseReturn;
  confirmReturn: (id: string) => void;
  completeReturn: (id: string) => void;
  cancelReturn: (id: string) => void;
  deleteReturn: (id: string) => void;
  // v0.4.0 — Purchase-Inbox (Mobile-Capture)
  loadPurchaseInbox: () => void;
  markPurchaseInboxDone: (id: string) => void;
  dismissPurchaseInbox: (id: string) => void;
}

function rowToPurchase(row: Record<string, unknown>): Purchase {
  // Snapshot der Supplier-Daten zum Zeitpunkt des Purchase-Create (Audit-Trail).
  let snapshot: import('@/core/models/types').SupplierSnapshot | undefined;
  const snapRaw = row.supplier_snapshot as string | null | undefined;
  if (snapRaw) {
    try { snapshot = JSON.parse(snapRaw); } catch { snapshot = undefined; }
  }
  return {
    id: row.id as string,
    purchaseNumber: row.purchase_number as string,
    branchId: row.branch_id as string,
    supplierId: row.supplier_id as string,
    status: (row.status as PurchaseStatus) || 'DRAFT',
    totalAmount: (row.total_amount as number) || 0,
    paidAmount: (row.paid_amount as number) || 0,
    remainingAmount: (row.remaining_amount as number) || 0,
    purchaseDate: row.purchase_date as string,
    notes: row.notes as string | undefined,
    lines: [],
    payments: [],
    staffId: (row.staff_id as string) || undefined,
    supplierSnapshot: snapshot,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    createdBy: row.created_by as string | undefined,
  };
}

function rowToLine(row: Record<string, unknown>): PurchaseLine {
  return {
    id: row.id as string,
    purchaseId: row.purchase_id as string,
    productId: row.product_id as string | undefined,
    description: row.description as string | undefined,
    quantity: (row.quantity as number) || 1,
    unitPrice: (row.unit_price as number) || 0,
    lineTotal: (row.line_total as number) || 0,
    position: (row.position as number) || 0,
    taxScheme: (row.tax_scheme as 'ZERO' | 'VAT_10' | null) || undefined,
    vatRate: row.vat_rate != null ? (row.vat_rate as number) : undefined,
    vatAmount: row.vat_amount != null ? (row.vat_amount as number) : undefined,
  };
}

function rowToPayment(row: Record<string, unknown>): PurchasePayment {
  return {
    id: row.id as string,
    purchaseId: row.purchase_id as string,
    amount: (row.amount as number) || 0,
    method: (row.method as 'cash' | 'bank') || 'cash',
    paidAt: row.paid_at as string,
    reference: row.reference as string | undefined,
    note: row.note as string | undefined,
    createdAt: row.created_at as string,
  };
}

function rowToReturn(row: Record<string, unknown>): PurchaseReturn {
  return {
    id: row.id as string,
    returnNumber: row.return_number as string,
    branchId: row.branch_id as string,
    purchaseId: row.purchase_id as string,
    supplierId: row.supplier_id as string,
    status: (row.status as PurchaseReturnStatus) || 'DRAFT',
    totalAmount: (row.total_amount as number) || 0,
    returnDate: row.return_date as string,
    refundMethod: row.refund_method as 'cash' | 'bank' | 'benefit' | 'credit' | undefined,
    refundAmount: (row.refund_amount as number) || 0,
    notes: row.notes as string | undefined,
    lines: [],
    createdAt: row.created_at as string,
    createdBy: row.created_by as string | undefined,
  };
}

function rowToReturnLine(row: Record<string, unknown>): PurchaseReturnLine {
  return {
    id: row.id as string,
    returnId: row.return_id as string,
    purchaseLineId: row.purchase_line_id as string | undefined,
    productId: row.product_id as string | undefined,
    quantity: (row.quantity as number) || 1,
    unitPrice: (row.unit_price as number) || 0,
    lineTotal: (row.line_total as number) || 0,
  };
}

function rowToInboxItem(row: Record<string, unknown>): PurchaseInboxItem {
  let images: string[] = [];
  try {
    const parsed = JSON.parse((row.images as string) || '[]');
    if (Array.isArray(parsed)) images = parsed as string[];
  } catch { /* leeres Array lassen */ }
  return {
    id: row.id as string,
    branchId: row.branch_id as string,
    images,
    note: (row.note as string) || undefined,
    status: (row.status as string) || 'pending',
    createdAt: row.created_at as string,
  };
}

function computeStatus(total: number, paid: number, cancelled = false): PurchaseStatus {
  if (cancelled) return 'CANCELLED';
  if (total <= 0) return 'DRAFT';
  if (paid <= 0) return 'UNPAID';
  if (paid >= total) return 'PAID';
  return 'PARTIALLY_PAID';
}

export const usePurchaseStore = create<PurchaseStore>((set, get) => ({
  purchases: [],
  returns: [],
  purchaseInbox: [],
  loading: false,

  loadPurchases: () => {
    try {
      const branchId = currentBranchId();
      const rows = query('SELECT * FROM purchases WHERE branch_id = ? ORDER BY created_at DESC', [branchId]);
      const list: Purchase[] = rows.map(r => {
        const p = rowToPurchase(r);
        const lineRows = query('SELECT * FROM purchase_lines WHERE purchase_id = ? ORDER BY position', [p.id]);
        p.lines = lineRows.map(rowToLine);
        const payRows = query('SELECT * FROM purchase_payments WHERE purchase_id = ? ORDER BY paid_at ASC, created_at ASC', [p.id]);
        p.payments = payRows.map(rowToPayment);
        return p;
      });
      set({ purchases: list, loading: false });
    } catch { set({ purchases: [], loading: false }); }
  },

  // ── v0.4.0 — Purchase-Inbox (Mobile-Capture) ──
  loadPurchaseInbox: () => {
    try {
      const branchId = currentBranchId();
      const rows = query(
        `SELECT * FROM purchase_inbox WHERE branch_id = ? AND status = 'pending' ORDER BY created_at DESC`,
        [branchId]
      );
      set({ purchaseInbox: rows.map(rowToInboxItem) });
    } catch { set({ purchaseInbox: [] }); }
  },

  markPurchaseInboxDone: (id) => {
    const db = getDatabase();
    db.run(`UPDATE purchase_inbox SET status = 'done' WHERE id = ?`, [id]);
    saveDatabase();
    trackUpdate('purchase_inbox', id, { status: 'done' });
    get().loadPurchaseInbox();
  },

  dismissPurchaseInbox: (id) => {
    const db = getDatabase();
    db.run(`UPDATE purchase_inbox SET status = 'dismissed' WHERE id = ?`, [id]);
    saveDatabase();
    trackUpdate('purchase_inbox', id, { status: 'dismissed' });
    get().loadPurchaseInbox();
  },

  loadReturns: () => {
    try {
      const branchId = currentBranchId();
      const rows = query('SELECT * FROM purchase_returns WHERE branch_id = ? ORDER BY created_at DESC', [branchId]);
      const list: PurchaseReturn[] = rows.map(r => {
        const pr = rowToReturn(r);
        const lineRows = query('SELECT * FROM purchase_return_lines WHERE return_id = ?', [pr.id]);
        pr.lines = lineRows.map(rowToReturnLine);
        return pr;
      });
      set({ returns: list });
    } catch { set({ returns: [] }); }
  },

  getPurchase: (id) => get().purchases.find(p => p.id === id),
  getReturn: (id) => get().returns.find(r => r.id === id),

  createPurchase: (input) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const id = uuid();
    let branchId: string, userId: string;
    try { branchId = currentBranchId(); userId = currentUserId(); }
    catch { branchId = 'branch-main'; userId = 'user-owner'; }

    const purchaseNumber = getNextDocumentNumber('PUR');
    const purchaseDate = input.purchaseDate || now.split('T')[0];

    // Create or link products for each line and build line records.
    // Plan §5: Ware kommt IMMER ins Inventar, product_status = IN_STOCK, source_type = OWN
    const lineRecords: Array<{
      id: string; productId: string; description: string | null;
      qty: number; unitPrice: number; lineTotal: number; position: number;
      taxScheme: 'ZERO' | 'VAT_10'; vatRate: number; vatAmount: number;
    }> = [];
    let total = 0;
    input.lines.forEach((ln, idx) => {
      let productId = ln.productId;
      if (!productId) {
        if (ln.newProduct) {
          // Plan §Purchase §New-Item: Neues Produkt mit voller Collection-Spec
          // (Kategorie + dyn. Attribute + Photos + Tax-Scheme + Storage etc.).
          // Eine zentrale Stelle für das INSERT — useProductStore.createProduct —
          // statt SQL hier zu duplizieren.
          const created = useProductStore.getState().createProduct({
            ...ln.newProduct,
            purchasePrice: ln.unitPrice,        // Bruttopreis aus dem Purchase-Line-Input
            purchaseDate,
            stockStatus: 'in_stock',
            quantity: ln.quantity || 1,
          });
          productId = created.id;
        } else {
          // Legacy-Pfad: nur Brand/Name/SKU/Kategorie aus Inline-Eingabe.
          productId = uuid();
          const pNow = new Date().toISOString();
          db.run(
            `INSERT INTO products (id, branch_id, category_id, brand, name, sku, condition, scope_of_delivery,
              purchase_date, purchase_price, purchase_currency, stock_status, tax_scheme, expected_margin, days_in_stock,
              supplier_name, notes, images, attributes, created_at, updated_at, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, 'BHD', 'in_stock', 'MARGIN', NULL, 0, NULL, ?, '[]', '{}', ?, ?, ?)`,
            [productId, branchId, ln.newProductCategoryId || 'cat-watches', ln.newProductBrand || '', ln.newProductName || '',
             ln.newProductSku || null, '', purchaseDate, ln.unitPrice, ln.description || null, pNow, pNow, userId]
          );
        }
      }
      const qty = Math.max(1, ln.quantity || 1);
      const unitPrice = ln.unitPrice || 0;
      const lineTotal = qty * unitPrice;       // gross-incl-VAT
      const scheme: 'ZERO' | 'VAT_10' = ln.taxScheme || 'ZERO';
      const rate = ln.vatRate ?? (scheme === 'VAT_10' ? 10 : 0);
      // Input-VAT aus Brutto dekomponieren: vat = gross × rate / (100 + rate).
      const vatAmount = rate > 0 ? lineTotal * rate / (100 + rate) : 0;
      total += lineTotal;
      const lineId = uuid();
      lineRecords.push({
        id: lineId, productId, description: ln.description || null,
        qty, unitPrice, lineTotal, position: idx + 1,
        taxScheme: scheme, vatRate: rate, vatAmount,
      });
    });

    // Insert purchase header (status UNPAID unless initial payment covers)
    const status: PurchaseStatus = computeStatus(total, input.initialPayment?.amount || 0);
    const paid = input.initialPayment?.amount || 0;

    // Salesforce-Pattern: Supplier-Stamm-/Beleg-Daten zum Zeitpunkt des
    // Purchase-Create einfrieren. Vermeidet dass spaetere Edits am Supplier
    // (Name, CPR, ID-Bild) den gedruckten Original-Beleg ueberschreiben.
    let snapshotJson: string | null = null;
    try {
      const sup = query(
        'SELECT name, phone, email, address, cpr, cpr_image FROM suppliers WHERE id = ?',
        [input.supplierId]
      )[0];
      if (sup) {
        const snap = {
          name: (sup.name as string) || '',
          phone: (sup.phone as string) || undefined,
          email: (sup.email as string) || undefined,
          address: (sup.address as string) || undefined,
          cpr: (sup.cpr as string) || undefined,
          cprImage: (sup.cpr_image as string) || undefined,
          snapshotAt: now,
        };
        snapshotJson = JSON.stringify(snap);
      }
    } catch (err) {
      console.warn('[purchase] supplier snapshot failed:', err);
    }

    db.run(
      `INSERT INTO purchases (id, branch_id, purchase_number, supplier_id, status, total_amount, paid_amount, remaining_amount,
        purchase_date, notes, staff_id, supplier_snapshot, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, branchId, purchaseNumber, input.supplierId, status, total, paid, total - paid,
       purchaseDate, input.notes || null, input.staffId || null, snapshotJson, now, now, userId]
    );

    // Insert lines (inkl. Input-VAT-Felder)
    const lineStmt = db.prepare(
      `INSERT INTO purchase_lines (id, purchase_id, product_id, description, quantity, unit_price, line_total, position, tax_scheme, vat_rate, vat_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const l of lineRecords) {
      lineStmt.run([l.id, id, l.productId, l.description, l.qty, l.unitPrice, l.lineTotal, l.position, l.taxScheme, l.vatRate, l.vatAmount]);
    }
    lineStmt.free();

    // Phase 2 — Stock-Lots: Pro Purchase-Line ein Lot mit dem TATSAECHLICHEN
    // Einkaufspreis dieser Charge. Existing-Item-Purchase legt einen frischen
    // Lot an, ohne den alten Lot/products.purchase_price zu beruehren — damit
    // bleibt der Cost-Snapshot fuer noch nicht verkaufte alte Stuecke korrekt.
    const lotStmt = db.prepare(
      `INSERT INTO stock_lots
         (id, branch_id, product_id, purchase_id, purchase_line_id,
          unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`
    );
    const affectedProductIds = new Set<string>();
    for (const l of lineRecords) {
      if (!l.productId || l.qty <= 0) continue;
      // unit_cost = GROSS pro Stueck (Cash-Out an Supplier). Identische Basis wie
      // products.purchase_price heute, damit Phase 4 (Cost-Snapshot aus Lot) das
      // bestehende Margin-Verhalten 1:1 abloest, nur eben pro-Lot statt global.
      lotStmt.run([uuid(), branchId, l.productId, id, l.id,
        l.unitPrice, l.qty, l.qty, purchaseDate, now]);
      affectedProductIds.add(l.productId);
    }
    lotStmt.free();
    // Phase 7 Sync: products.quantity = Σ lot.qty_remaining
    for (const pid of affectedProductIds) syncProductQuantity(pid);

    // Initial payment (if any)
    let initialPaymentId: string | null = null;
    if (input.initialPayment && input.initialPayment.amount > 0) {
      initialPaymentId = uuid();
      db.run(
        `INSERT INTO purchase_payments (id, purchase_id, amount, method, paid_at, reference, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [initialPaymentId, id, input.initialPayment.amount, input.initialPayment.method, purchaseDate, input.initialPayment.reference || null, null, now]
      );
      trackPayment('purchases', id, input.initialPayment.amount, input.initialPayment.method);
    }

    saveDatabase();
    trackInsert('purchases', id, { purchaseNumber, supplierId: input.supplierId, total });
    get().loadPurchases();

    // ZIEL.md §3a — Ledger-Posting nach Domain-Insert.
    safePost(`postPurchaseReceived(${id})`, () => {
      if (hasLedgerEntries('PURCHASE', id)) return;
      const fresh = get().getPurchase(id);
      if (fresh) postPurchaseReceived(fresh);
    });
    if (initialPaymentId && input.initialPayment) {
      const ipId = initialPaymentId;
      const ipMethod = input.initialPayment.method;
      safePost(`postPurchasePayment(${ipId}) [initial]`, () => {
        if (hasLedgerEntries('PURCHASE_PAYMENT', ipId)) return;
        const fresh = get().getPurchase(id);
        const ip = fresh?.payments.find(p => p.id === ipId);
        if (ip) postPurchasePayment(ip, input.supplierId);
        else if (fresh) {
          // Fallback wenn loadPurchases nicht alle Felder hatte
          postPurchasePayment(
            {
              id: ipId, purchaseId: id, amount: input.initialPayment!.amount,
              method: ipMethod, paidAt: purchaseDate, createdAt: now,
            },
            input.supplierId
          );
        }
      });
    }

    return get().getPurchase(id)!;
  },

  addPayment: (purchaseId, amount, method, reference, note) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const p = get().getPurchase(purchaseId);
    if (!p) return;
    if (p.status === 'CANCELLED') return;

    const paymentId = uuid();
    const paidAt = now.split('T')[0];
    db.run(
      `INSERT INTO purchase_payments (id, purchase_id, amount, method, paid_at, reference, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [paymentId, purchaseId, amount, method, paidAt, reference || null, note || null, now]
    );
    const newPaid = p.paidAmount + amount;
    const newStatus = computeStatus(p.totalAmount, newPaid);
    db.run(
      `UPDATE purchases SET paid_amount = ?, remaining_amount = ?, status = ?, updated_at = ? WHERE id = ?`,
      [newPaid, Math.max(0, p.totalAmount - newPaid), newStatus, now, purchaseId]
    );
    saveDatabase();
    trackPayment('purchases', purchaseId, amount, method);
    if (newStatus !== p.status) trackStatusChange('purchases', purchaseId, p.status, newStatus);
    get().loadPurchases();

    // ZIEL.md §3a — Ledger-Posting für Supplier-Zahlung.
    safePost(`postPurchasePayment(${paymentId})`, () => {
      if (hasLedgerEntries('PURCHASE_PAYMENT', paymentId)) return;
      postPurchasePayment(
        {
          id: paymentId, purchaseId, amount,
          method, paidAt, reference, note, createdAt: now,
        },
        p.supplierId
      );
    });
  },

  cancelPurchase: (id) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const p = get().getPurchase(id);
    if (!p) return;
    // Phase 7 Sync: betroffene Produkt-IDs VOR dem Cancel sammeln, damit wir
    // products.quantity nachher korrekt aus den verbleibenden ACTIVE Lots ableiten koennen.
    const affectedRows = query(
      `SELECT DISTINCT product_id FROM stock_lots WHERE purchase_id = ?`,
      [id]
    );
    const affectedProductIds = affectedRows.map(r => r.product_id as string);
    db.run(`UPDATE purchases SET status = 'CANCELLED', updated_at = ? WHERE id = ?`, [now, id]);
    // Phase 2 — Lots dieser Purchase soft-cancellen. Audit-Trail bleibt; kuenftige
    // Sales-Picker filtern status='CANCELLED' raus (Phase 3). Bereits verkaufte
    // Pieces (invoice_lines.lot_id) bleiben verknuepft — der historische
    // Cost-Snapshot ist Eigentum der Invoice, nicht des Lots.
    db.run(`UPDATE stock_lots SET status = 'CANCELLED' WHERE purchase_id = ?`, [id]);
    for (const pid of affectedProductIds) syncProductQuantity(pid);
    saveDatabase();
    trackStatusChange('purchases', id, p.status, 'CANCELLED');
    get().loadPurchases();

    // ZIEL.md §3a — Ledger-Storno bei Purchase-Cancel (spiegelt INVENTORY/VAT_INPUT/AP).
    // Bestehende Payments bleiben gebucht — sie waren echtes Geld raus, wurden gezahlt.
    // Falls Lieferant refundiert, ist das eine separate Transaktion.
    safePost(`postPurchaseCancelled(${id})`, () => {
      if (!hasLedgerEntries('PURCHASE', id)) return;
      if (hasReversalFor('PURCHASE', id)) return;
      postPurchaseCancelled({ id } as Purchase);
    });
  },

  deletePurchase: (id) => {
    const db = getDatabase();
    // Phase 7 Sync: betroffene Produkte VOR Cancel/Delete sammeln.
    const affectedRows = query(
      `SELECT DISTINCT product_id FROM stock_lots WHERE purchase_id = ?`,
      [id]
    );
    const affectedProductIds = affectedRows.map(r => r.product_id as string);
    // Lots cleanen — Schema hat ON DELETE SET NULL, sonst bleiben orphaned Lots
    // mit purchase_id=NULL stehen und tauchen weiter als verkaufbar auf.
    // Bereits verkaufte Lots (invoice_lines.lot_id gesetzt) duerfen nicht weg —
    // soft-cancel statt hart loeschen, damit Cost-Snapshot-Audit erhalten bleibt.
    db.run(`UPDATE stock_lots SET status = 'CANCELLED', purchase_id = NULL, purchase_line_id = NULL WHERE purchase_id = ?`, [id]);
    db.run(`DELETE FROM purchases WHERE id = ?`, [id]);
    for (const pid of affectedProductIds) syncProductQuantity(pid);
    saveDatabase();
    trackDelete('purchases', id);
    get().loadPurchases();
  },

  // ── Purchase Returns (Plan §Purchase Returns) ──

  createReturn: (input) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const id = uuid();
    const purchase = get().getPurchase(input.purchaseId);
    if (!purchase) throw new Error('Purchase not found');
    let branchId: string, userId: string;
    try { branchId = currentBranchId(); userId = currentUserId(); }
    catch { branchId = 'branch-main'; userId = 'user-owner'; }

    const returnNumber = getNextDocumentNumber('PRET');
    const returnDate = input.returnDate || now.split('T')[0];
    const total = input.lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);

    db.run(
      `INSERT INTO purchase_returns (id, branch_id, return_number, purchase_id, supplier_id, status, total_amount,
        return_date, refund_method, refund_amount, notes, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, 0, ?, ?, ?)`,
      [id, branchId, returnNumber, input.purchaseId, purchase.supplierId, total, returnDate,
       input.refundMethod || null, input.notes || null, now, userId]
    );

    const stmt = db.prepare(
      `INSERT INTO purchase_return_lines (id, return_id, purchase_line_id, product_id, quantity, unit_price, line_total)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const l of input.lines) {
      stmt.run([uuid(), id, l.purchaseLineId, l.productId || null, l.quantity, l.unitPrice, l.quantity * l.unitPrice]);
    }
    stmt.free();

    saveDatabase();
    trackInsert('purchase_returns', id, { returnNumber, purchaseId: input.purchaseId, total });
    get().loadReturns();
    return get().getReturn(id)!;
  },

  // Confirm = perform the effects: reduce inventory + payable
  confirmReturn: (id) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const ret = get().getReturn(id);
    if (!ret || ret.status !== 'DRAFT') return;
    const purchase = get().getPurchase(ret.purchaseId);
    if (!purchase) return;

    // Plan §7 + §8: Payable reduzieren ODER Refund
    //  - wenn noch offen (remaining > 0): erst aus remaining runterziehen
    //  - wenn mehr als remaining: Rest als Refund (Cash/Bank ↑)
    let remainingPayable = purchase.remainingAmount;
    let refundAmount = 0;
    if (remainingPayable >= ret.totalAmount) {
      remainingPayable -= ret.totalAmount;
    } else {
      refundAmount = ret.totalAmount - remainingPayable;
      remainingPayable = 0;
    }
    const newTotal = Math.max(0, purchase.totalAmount - ret.totalAmount);
    const newPaid = Math.max(0, purchase.paidAmount - refundAmount);
    const newStatus = computeStatus(newTotal, newPaid, purchase.status === 'CANCELLED');

    db.run(
      `UPDATE purchases SET total_amount = ?, paid_amount = ?, remaining_amount = ?, status = ?, updated_at = ? WHERE id = ?`,
      [newTotal, newPaid, remainingPayable, newStatus, now, purchase.id]
    );

    // Remove returned products from inventory (Plan §6 Inventarlogik — Ware wird entfernt oder angepasst)
    for (const line of ret.lines) {
      if (line.productId) {
        db.run(`UPDATE products SET stock_status = 'sold', updated_at = ? WHERE id = ?`, [now, line.productId]);
      }
    }

    // Plan §Purchase Returns §9: DRAFT → CONFIRMED → COMPLETED.
    // COMPLETED wenn: kein Refund nötig (alles aus Payable) ODER Refund direkt via Cash/Bank abgewickelt.
    // Bleibt CONFIRMED wenn refundMethod='credit' (Credit muss extern/später abgewickelt werden).
    const finalStatus: 'CONFIRMED' | 'COMPLETED' =
      (refundAmount === 0 || (ret.refundMethod && ret.refundMethod !== 'credit')) ? 'COMPLETED' : 'CONFIRMED';

    db.run(
      `UPDATE purchase_returns SET status = ?, refund_amount = ? WHERE id = ?`,
      [finalStatus, refundAmount, id]
    );
    if (refundAmount > 0 && ret.refundMethod && ret.refundMethod !== 'credit') {
      trackRefund('purchase_returns', id, refundAmount, ret.refundMethod);
    }

    // Plan §8 #3 — Supplier-Credit Ledger. Bei refundMethod='credit' + refundAmount > 0
    // wird ein offenes Guthaben beim Lieferanten gebucht (gegen zukünftige Käufe verrechenbar).
    if (refundAmount > 0 && ret.refundMethod === 'credit' && purchase.supplierId) {
      let branchId: string, userId: string;
      try { branchId = currentBranchId(); userId = currentUserId(); }
      catch { branchId = 'branch-main'; userId = 'user-owner'; }
      const creditId = uuid();
      db.run(
        `INSERT INTO supplier_credits (id, branch_id, supplier_id, source_return_id, source_purchase_id,
           amount, used_amount, status, note, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, 0, 'OPEN', ?, ?, ?)`,
        [creditId, branchId, purchase.supplierId, id, purchase.id, refundAmount,
         `Credit aus Return ${ret.returnNumber || id.slice(0, 8)}`, now, userId]
      );
      trackInsert('supplier_credits', creditId, { supplierId: purchase.supplierId, amount: refundAmount });
    }

    saveDatabase();
    trackStatusChange('purchase_returns', id, 'DRAFT', finalStatus);

    // Ledger: Net-Effekt der Return-Buchung — INVENTORY runter, A/P runter (Anteil
    // ohne Refund) und Cash/Bank/SUPPLIER_CREDIT rauf (Refund-Anteil). Idempotent
    // ueber sourceModule='PURCHASE_RETURN' + sourceId=id. VAT-Korrektur bleibt approx,
    // weil purchase_return_lines kein vat_amount tragen — vernachlaessigt fuer jetzt.
    const apReduction = ret.totalAmount - refundAmount;
    const refundCashAcc =
      ret.refundMethod === 'cash'   ? 'CASH'   :
      ret.refundMethod === 'bank'   ? 'BANK'   :
      ret.refundMethod === 'credit' ? 'SUPPLIER_CREDIT' :
      'BANK';
    safePost(`postPurchaseReturn(${id})`, () => {
      if (hasLedgerEntries('PURCHASE_RETURN', id)) return;
      const entries: Parameters<typeof postEntries>[0] = [];
      if (ret.totalAmount > 0) {
        entries.push({
          account: 'INVENTORY',
          direction: 'CREDIT',
          amount: ret.totalAmount,
          counterpartyType: 'SUPPLIER',
          counterpartyId: purchase.supplierId,
          metadata: { purchaseId: purchase.id, returnNumber: ret.returnNumber },
        });
      }
      if (apReduction > 0.005) {
        entries.push({
          account: 'ACCOUNTS_PAYABLE',
          direction: 'DEBIT',
          amount: apReduction,
          counterpartyType: 'SUPPLIER',
          counterpartyId: purchase.supplierId,
          metadata: { purchaseId: purchase.id, returnNumber: ret.returnNumber, side: 'ap-reduction' },
        });
      }
      if (refundAmount > 0.005) {
        entries.push({
          account: refundCashAcc,
          direction: 'DEBIT',
          amount: refundAmount,
          counterpartyType: 'SUPPLIER',
          counterpartyId: purchase.supplierId,
          metadata: { purchaseId: purchase.id, returnNumber: ret.returnNumber, refundMethod: ret.refundMethod, side: 'refund-in' },
        });
      }
      if (entries.length > 0) {
        postEntries(entries, {
          occurredAt: now,
          sourceModule: 'PURCHASE_RETURN',
          sourceId: id,
        });
      }
    });

    get().loadPurchases();
    get().loadReturns();
  },

  // Plan §Purchase Returns §9: manuelle Transition CONFIRMED → COMPLETED (z.B. nach Credit-Abwicklung).
  completeReturn: (id) => {
    const db = getDatabase();
    const ret = get().getReturn(id);
    if (!ret || ret.status !== 'CONFIRMED') return;
    db.run(`UPDATE purchase_returns SET status = 'COMPLETED' WHERE id = ?`, [id]);
    saveDatabase();
    trackStatusChange('purchase_returns', id, 'CONFIRMED', 'COMPLETED');
    get().loadReturns();
  },

  cancelReturn: (id) => {
    const db = getDatabase();
    const ret = get().getReturn(id);
    if (!ret) return;
    db.run(`UPDATE purchase_returns SET status = 'CANCELLED' WHERE id = ?`, [id]);
    saveDatabase();
    trackStatusChange('purchase_returns', id, ret.status, 'CANCELLED');
    get().loadReturns();
  },

  deleteReturn: (id) => {
    const db = getDatabase();
    db.run(`DELETE FROM purchase_returns WHERE id = ?`, [id]);
    saveDatabase();
    trackDelete('purchase_returns', id);
    get().loadReturns();
  },
}));
