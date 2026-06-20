import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { Order, OrderStatus, OrderLine, OrderType, OrderLineStatus, CustomOrderMeta, MaterialDetails, Expense, Product } from '@/core/models/types';
import { deriveOrderType, deriveOrderStatusFromLines } from '@/core/models/types';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId, getNextNumber, getNextDocumentNumber } from '@/core/db/helpers';
import { eventBus } from '@/core/events/event-bus';
import { trackInsert, trackUpdate, trackDelete } from '@/core/sync/track';
import { trackChange } from '@/core/sync/sync-service';   // sync-only (kein Audit) — purchase_lines FK-Entkopplung
import { trackProductRow } from '@/core/lots/lot-queries';
import { useProductStore } from '@/stores/productStore';
import { bookCardFee, reverseCardFees } from '@/core/finance/card-fee-booking';
import { normalizeCardBrand } from '@/core/finance/card-fees';
import {
  postOrderPayment,
  postOrderPaymentReversed,
  postExpense,
  postExpenseCancelled,
  postOrderCancellationChoice,
  hasLedgerEntries,
  hasReversalFor,
} from '@/core/ledger/posting';

// ZIEL.md §3a — Posting-Service ist der einzige Schreibpfad für Finanzbuchungen.
function safePost(label: string, fn: () => void): void {
  try { fn(); } catch (err) {
    console.error(`[ledger] ${label} failed:`, err);
  }
}

// v0.3.1 — Eine Order-Line-A/P-Expense stornieren: Status → CANCELLED + Ledger-
// Reverse. Bewusst NICHT ueber expenseStore.updateExpense: commitOrderLineExpenses
// inserted die Expense per Raw-SQL, daher kennt der expenseStore-Cache sie nicht
// (before = getExpense() waere undefined → der Reverse-Block wuerde stumm
// uebersprungen). Wir bauen den Expense-Snapshot direkt aus der DB-Zeile —
// gleicher Pattern wie invoiceStore.cancelInvoice fuer seine Auto-Expenses.
function cancelOrderLineExpense(expenseId: string): void {
  const db = getDatabase();
  const rows = query(
    `SELECT id, expense_number, branch_id, category, amount, paid_amount, payment_method,
            expense_date, description, related_entity_id, supplier_id, status, created_at
       FROM expenses WHERE id = ?`,
    [expenseId]
  );
  if (rows.length === 0) return;
  const er = rows[0];
  if ((er.status as string) === 'CANCELLED') return;
  const expForReverse: Expense = {
    id: expenseId,
    expenseNumber: er.expense_number as string,
    branchId: er.branch_id as string,
    category: (er.category as Expense['category']) || 'Inventory',
    amount: Number(er.amount || 0),
    paidAmount: Number(er.paid_amount || 0),
    paymentMethod: (er.payment_method as Expense['paymentMethod']) || 'bank',
    expenseDate: er.expense_date as string,
    description: er.description as string,
    relatedModule: 'order',
    relatedEntityId: (er.related_entity_id as string) || undefined,
    supplierId: (er.supplier_id as string) || undefined,
    status: er.status as Expense['status'],
    createdAt: er.created_at as string,
  };
  db.run(`UPDATE expenses SET status = 'CANCELLED' WHERE id = ?`, [expenseId]);
  trackUpdate('expenses', expenseId, { status: 'CANCELLED' });
  safePost(`postExpenseCancelled(${expenseId}) [order-line]`, () => {
    if (!hasLedgerEntries('EXPENSE', expenseId)) return;
    if (hasReversalFor('EXPENSE', expenseId)) return;
    postExpenseCancelled(expForReverse);
  });
}

interface OrderStore {
  orders: Order[];
  loading: boolean;
  loadOrders: () => void;
  getOrder: (id: string) => Order | undefined;
  // v0.6.9 — "Need to Order"-Indikator: Orders mit mindestens einer Produkt-Zeile
  // im Status PENDING, ohne Supplier-Bestellung (ordered_supplier_id NULL), und
  // das verknuepfte Produkt hat 0 Bestand → muss noch beim Supplier bestellt werden.
  // products MUSS uebergeben werden, damit der Quantity-Check aus DERSELBEN
  // Quelle kommt wie die UI-Action-Zelle (productStore RAM) — sonst kann der
  // Sidebar-Puls und das „Auf Lager"-Badge auseinanderlaufen.
  getOrderIdsNeedingPurchase: (productQtyById: Map<string, number>) => Set<string>;
  // v0.6.9 — Soft-Reservation: Map product_id → { qty, orderNumbers[] }, deckt nur
  // offene Reservierungen (PENDING/ORDERED, nicht invoiced, Order aktiv). Sale-/
  // Order-Picker zeigen das als Hinweis, sperren aber NICHT (Soft-Warnung).
  getAllProductReservations: () => Map<string, { qty: number; orderNumbers: string[] }>;
  createOrder: (data: Partial<Omit<Order, 'lines'>> & { lines?: Array<Omit<OrderLine, 'id' | 'orderId' | 'lineTotal' | 'position'> & { newProduct?: Partial<Product> }> }) => Order;
  updateOrder: (id: string, data: Partial<Order>) => void;
  updateStatus: (id: string, status: OrderStatus) => void;
  deleteOrder: (id: string) => void;
  // v0.7.0 — Order cancellen MIT explizitem Geld-Handling und Auto-Lifecycle.
  // Throwt wenn die Order eine FINAL/PARTIAL Invoice hat (erst Invoice stornieren).
  // Reverst A/P-Expenses, cancelt offene Gold-Verbindlichkeiten, nullt
  // ordered_supplier_id, setzt Lines + Order auf CANCELLED. Bei totalPaid > 0
  // wird der gewaehlte Geld-Pfad gebucht (refund/credit/forfeit). ARRIVED-Lines
  // via Purchase bleiben unberuehrt — Stueck bleibt im Lager (Standard-Bestand).
  cancelOrderWithMoney: (id: string, choice: 'refund' | 'credit' | 'forfeit',
    refundMethod?: 'cash' | 'bank' | 'benefit', note?: string) => void;
  // Lines per Order — v0.2.1 erweitert um supplier-cost + material + customer-facing flag
  rewriteOrderLines: (orderId: string, lines: Array<{
    productId?: string;
    description: string;
    quantity: number;
    unitPrice: number;
    taxScheme?: OrderLine['taxScheme'];
    vatRate?: number;
    supplierId?: string;
    costAmount?: number;
    isCustomerFacing?: boolean;
    materialKind?: 'labor' | 'diamond' | 'stone' | 'gold' | 'custom' | null;
    materialDetails?: MaterialDetails;
  }>) => void;
  getOrderLines: (orderId: string) => OrderLine[];
  // v0.5.0 — Custom-Order „cost-later": einzelne Order-Line nachtraeglich anlegen/loeschen.
  // addOrderLine haengt eine Line ans Ende (naechste Position); bucht A/P sofort wenn
  // sie als ARRIVED + supplier_id reinkommt. deleteOrderLine reverst die A/P-Expense
  // und blockt wenn die Line bereits invoiced ist.
  addOrderLine: (orderId: string, line: {
    productId?: string;
    description: string;
    quantity?: number;
    unitPrice?: number;
    taxScheme?: OrderLine['taxScheme'];
    vatRate?: number;
    supplierId?: string;
    costAmount?: number;
    isCustomerFacing?: boolean;
    materialKind?: 'labor' | 'diamond' | 'stone' | 'gold' | 'custom' | null;
    materialDetails?: MaterialDetails;
    status?: OrderLineStatus;
  }) => string;
  deleteOrderLine: (lineId: string) => void;
  // v0.5.0 — Preis einer Order-Line aendern (z.B. Quoted Price nachtraeglich).
  // Aktualisiert unit_price + line_total und leitet agreed_price neu ab.
  // Blockt wenn die Line bereits invoiced ist.
  updateOrderLinePrice: (lineId: string, unitPrice: number) => void;
  // Back-to-Back — Order-Line in-place bearbeiten (Produkt/Menge/Preis/Beschreibung).
  // Guards: invoiced → komplett gesperrt; via aktivem Purchase beschafft →
  // Produkt-Wechsel gesperrt (Menge/Preis/Beschreibung bleiben frei).
  updateOrderLine: (lineId: string, patch: {
    productId?: string;
    newProduct?: Partial<Product>;
    description?: string;
    quantity?: number;
    unitPrice?: number;
  }) => void;
  // v0.2.1 — Trigger A/P-Expense fuer jede order_line mit supplier_id + cost_amount > 0
  // (analog zu repairStore.commitRepairLineExpenses). Idempotent: ueberspringt lines
  // die bereits expense_id haben. v0.3.0: committed nur Lines mit status='ARRIVED'.
  commitOrderLineExpenses: (orderId: string) => void;
  // v0.3.0 — Per-Line Fulfillment-Status
  updateOrderLineStatus: (lineId: string, status: OrderLineStatus) => void;
  // Back-to-Back — Zeile als "beim Supplier bestellt" markieren (Status ORDERED)
  // + den geplanten Supplier festhalten (gruppiert spaeter den Wareneingang).
  markOrderLineOrdered: (lineId: string, orderedSupplierId?: string) => void;
  recomputeOrderStatus: (orderId: string) => void;
  // v0.3.0 — Partial Invoicing: Lines die fertig + noch nicht invoiced sind
  getBillableLines: (orderId: string) => OrderLine[];
  // v0.3.0 — verknuepft Lines mit der erzeugten Invoice (nach Convert)
  markOrderLinesInvoiced: (lineIds: string[], invoiceId: string) => void;
}

function rowToOrder(row: Record<string, unknown>): Order {
  let attrs: Record<string, string | number | boolean | string[]> = {};
  try { attrs = JSON.parse((row.attributes as string) || '{}'); } catch { /* */ }
  let customMeta: CustomOrderMeta | undefined;
  try {
    const raw = row.custom_meta as string | null;
    if (raw) customMeta = JSON.parse(raw) as CustomOrderMeta;
  } catch { /* */ }
  // v0.6.7 — Custom-Order Produkt-Spec (Kategorie + Attribute + Foto …) als JSON.
  let customProductSpec: Order['customProductSpec'];
  try {
    const raw = row.custom_product_spec as string | null;
    if (raw) customProductSpec = JSON.parse(raw) as Order['customProductSpec'];
  } catch { /* */ }
  return {
    id: row.id as string,
    orderNumber: row.order_number as string,
    customerId: row.customer_id as string,
    // v0.2.1 — Order-Type Discriminator + Custom-Meta
    type: ((row.type as string) || 'normal') as OrderType,
    customMeta,
    customProductSpec,
    goldsmithSupplierId: (row.goldsmith_supplier_id as string | null) || undefined,
    laborCost: (row.labor_cost as number) || 0,
    extraGoldValue: (row.extra_gold_value as number) || 0,
    categoryId: (row.category_id as string | null) || undefined,
    attributes: attrs,
    condition: (row.condition as string | null) || undefined,
    serialNumber: (row.serial_number as string | null) || undefined,
    existingProductId: (row.existing_product_id as string | null) || undefined,
    requestedBrand: row.requested_brand as string,
    requestedModel: row.requested_model as string,
    requestedReference: row.requested_reference as string | undefined,
    requestedDetails: row.requested_details as string | undefined,
    taxAmount: (row.tax_amount as number) || 0,
    paymentMethod: (row.payment_method as 'cash' | 'bank' | 'card' | undefined) || undefined,
    fullyPaid: Number(row.fully_paid) === 1,
    agreedPrice: row.agreed_price as number | undefined,
    depositAmount: (row.deposit_amount as number) || 0,
    depositPaid: row.deposit_paid === 1,
    depositDate: row.deposit_date as string | undefined,
    remainingAmount: row.remaining_amount as number | undefined,
    supplierName: row.supplier_name as string | undefined,
    supplierPrice: row.supplier_price as number | undefined,
    expectedMargin: row.expected_margin as number | undefined,
    expectedDelivery: row.expected_delivery as string | undefined,
    actualDelivery: row.actual_delivery as string | undefined,
    status: (row.status as OrderStatus) || 'pending',
    productId: row.product_id as string | undefined,
    invoiceId: row.invoice_id as string | undefined,
    notes: row.notes as string | undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    createdBy: row.created_by as string | undefined,
  };
}

export const useOrderStore = create<OrderStore>((set, get) => ({
  orders: [],
  loading: false,

  loadOrders: () => {
    try {
      const branchId = currentBranchId();
      const rows = query('SELECT * FROM orders WHERE branch_id = ? ORDER BY created_at DESC', [branchId]);
      set({ orders: rows.map(rowToOrder), loading: false });
    } catch { set({ orders: [], loading: false }); }
  },

  getOrder: (id) => get().orders.find(o => o.id === id),

  // v0.6.9 — Orders, die noch beim Supplier bestellt werden muessen. Filter:
  //   - Order ist aktiv (nicht cancelled/completed)
  //   - mind. 1 Zeile mit status='PENDING'
  //   - kundenseitige Produkt-Zeile (is_customer_facing=1, kein material_kind)
  //   - kein ordered_supplier_id gesetzt (noch nicht „beim Supplier bestellt")
  //   - verknuepftes Produkt hat <=0 Bestand (oder kein product_id)
  // Die UI nutzt das fuer Sidebar-Badge, Dashboard-KPI und OrderList-Marker.
  getOrderIdsNeedingPurchase: (productQtyById) => {
    try {
      // Kandidaten aus der DB: Zeilen die struktuell „muss bestellt werden"
      // sein KOENNTEN (PENDING, kundenseitig, Produkt-Zeile, kein Supplier).
      // Bestand wird AUSSERHALB per productQtyById gegen-gecheckt — das ist die
      // gleiche Quelle, die die UI-Zelle anzeigt, also keine Divergenz mehr.
      const rows = query(
        `SELECT ol.order_id, ol.product_id
           FROM order_lines ol
           JOIN orders o ON o.id = ol.order_id
          WHERE ol.status = 'PENDING'
            AND COALESCE(ol.is_customer_facing, 1) = 1
            AND ol.ordered_supplier_id IS NULL
            AND ol.material_kind IS NULL
            AND ol.product_id IS NOT NULL
            AND o.status NOT IN ('cancelled', 'completed')`
      );
      const out = new Set<string>();
      for (const r of rows) {
        const pid = r.product_id as string;
        const qty = productQtyById.get(pid) ?? 0;
        if (qty <= 0) out.add(r.order_id as string);
      }
      return out;
    } catch { return new Set<string>(); }
  },

  // v0.6.9 — Soft-Reservation: alle Produkt-Stuecke, die in offenen Orders
  // (PENDING/ORDERED, kundenseitig, nicht invoiced, Order aktiv) versprochen sind.
  // EIN Query, Map keyed by product_id. Sale-/Order-Picker zeigen den Hinweis,
  // blockieren aber nicht — der Verkaufer entscheidet selbst.
  getAllProductReservations: () => {
    const m = new Map<string, { qty: number; orderNumbers: string[] }>();
    try {
      const rows = query(
        `SELECT ol.product_id, ol.quantity, o.order_number
           FROM order_lines ol
           JOIN orders o ON o.id = ol.order_id
          WHERE ol.status IN ('PENDING', 'ORDERED')
            AND COALESCE(ol.is_customer_facing, 1) = 1
            AND ol.material_kind IS NULL
            AND ol.invoice_id IS NULL
            AND ol.product_id IS NOT NULL
            AND o.status NOT IN ('cancelled', 'completed')`
      );
      for (const r of rows) {
        const pid = r.product_id as string;
        const q = Math.max(1, (r.quantity as number) || 1);
        const on = r.order_number as string;
        const cur = m.get(pid) || { qty: 0, orderNumbers: [] };
        cur.qty += q;
        cur.orderNumbers.push(on);
        m.set(pid, cur);
      }
    } catch { /* */ }
    return m;
  },

  createOrder: (data) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const id = uuid();
    let branchId: string, userId: string;
    try { branchId = currentBranchId(); userId = currentUserId(); }
    catch { branchId = 'branch-main'; userId = 'user-owner'; }

    const orderNumber = getNextNumber('orders', 'order.number_prefix', 'ORD');

    // v0.3.0 — agreedPrice: falls Caller keinen liefert, aus den customer-facing
    // Lines ableiten (SUM unitPrice*qty). So funktioniert createOrder auch wenn
    // nur lines uebergeben werden (z.B. E2E / programmatische Aufrufe).
    const derivedAgreed = (data.lines || [])
      .filter(l => (l as Partial<OrderLine>).isCustomerFacing !== false)
      .reduce((s, l) => s + ((l.unitPrice || 0) * Math.max(1, l.quantity || 1)), 0);
    const agreedPrice = data.agreedPrice != null ? data.agreedPrice
      : (derivedAgreed > 0 ? derivedAgreed : null);

    const remaining = (agreedPrice || 0) - (data.depositAmount || 0);

    // Plan §Order: Order-Status ist orthogonal zum Zahlungsstand.
    // Default ist immer 'pending', auch bei direkt-bezahlten Auftraegen — der Payment-Status
    // (UNPAID/PARTIALLY_PAID/PAID) wird live aus den order_payments abgeleitet.
    // Ausnahme: fullyPaid + bereits arrived/notified ist hier nicht der Fall — neue Auftraege
    // koennen nur 'pending' starten oder per Caller explizit gesetzt sein.
    const initialStatus: OrderStatus = (data.status as OrderStatus) || 'pending';
    // v0.2.1 — Order-Type + Custom-Meta + promoted Custom-Fields
    // v0.3.0 — type wird IMMER aus den Lines abgeleitet (override data.type),
    // damit Mixed-Orders korrekt erkannt werden egal was der Caller schickt.
    const orderType: OrderType = data.lines && data.lines.length > 0
      ? deriveOrderType(data.lines)
      : ((data.type as OrderType) || 'normal');
    const customMetaJson = data.customMeta ? JSON.stringify(data.customMeta) : null;
    // v0.6.7 — Custom-Order Produkt-Spec (NewProductModal-Output) serialisieren.
    const customProductSpecJson = data.customProductSpec ? JSON.stringify(data.customProductSpec) : null;
    // v0.3.0 — initialer Line-Status aus dem Order-Initial-Status gemappt
    const initialLineStatus: OrderLineStatus =
      initialStatus === 'arrived' ? 'ARRIVED'
      : initialStatus === 'notified' ? 'ARRIVED'
      : initialStatus === 'completed' ? 'DELIVERED'
      : initialStatus === 'cancelled' ? 'CANCELLED'
      : 'PENDING';
    db.run(
      `INSERT INTO orders (id, branch_id, order_number, customer_id,
        category_id, attributes, condition, serial_number, existing_product_id,
        requested_brand, requested_model, requested_reference, requested_details,
        agreed_price, tax_amount, deposit_amount, deposit_paid, deposit_date, remaining_amount,
        payment_method, fully_paid,
        supplier_name, supplier_price, expected_margin, expected_delivery,
        status, notes, created_at, updated_at, created_by,
        type, custom_meta, goldsmith_supplier_id, labor_cost, extra_gold_value,
        custom_product_spec)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, branchId, orderNumber, data.customerId,
       data.categoryId || null, JSON.stringify(data.attributes || {}),
       data.condition || null, data.serialNumber || null, data.existingProductId || null,
       data.requestedBrand || '', data.requestedModel || '',
       data.requestedReference || null, data.requestedDetails || null,
       agreedPrice, data.taxAmount || 0, data.depositAmount || 0,
       data.depositPaid || data.fullyPaid ? 1 : 0, data.depositDate || null, remaining,
       data.paymentMethod || null, data.fullyPaid ? 1 : 0,
       data.supplierName || null, data.supplierPrice || null,
       agreedPrice && data.supplierPrice ? agreedPrice - data.supplierPrice : null,
       data.expectedDelivery || null, initialStatus, data.notes || null, now, now, userId,
       orderType, customMetaJson, data.goldsmithSupplierId || null,
       data.laborCost || 0, data.extraGoldValue || 0,
       customProductSpecJson]
    );

    // Order Lines persistieren falls übergeben — inkl. Tax-Scheme-Snapshot,
    // damit Convert-to-Invoice ohne erneutes Nachfragen funktioniert.
    // v0.2.1 — auch supplier_id / cost_amount / is_customer_facing / material_*
    // werden persistiert (analog zu repair_lines).
    if (data.lines && data.lines.length > 0) {
      // Back-to-Back Beschaffung: Zeilen mit newProduct-Spec ("New" zur Order-Zeit)
      // legen das Produkt sofort an. quantity wird per syncProductQuantity auf 0
      // gesetzt — es gibt noch kein stock_lot, der Bestand entsteht erst beim
      // Wareneingang (Purchase). Vor dem prepare aufgeloest, um das offene
      // Statement nicht mit anderen db-Ops zu verschachteln.
      const resolvedProductIds: Array<string | null> = data.lines.map((l) => {
        if (l.productId) return l.productId;
        if (l.newProduct) {
          try {
            const created = useProductStore.getState().createProduct({
              ...l.newProduct,
              stockStatus: 'in_stock',
            });
            // Order-Zeit "New"-Produkt hat noch keinen Bestand — quantity 0 bis
            // der Wareneingang (Purchase) ein stock_lot anlegt. createProduct
            // erzwingt min. 1, daher hier explizit zuruecksetzen.
            db.run(`UPDATE products SET quantity = 0 WHERE id = ?`, [created.id]);
            trackProductRow(created.id);   // LAN-Sync Phase 1b
            return created.id;
          } catch (err) {
            console.error('[order] createProduct (new order line) failed:', err);
            return null;
          }
        }
        return null;
      });
      const stmt = db.prepare(
        `INSERT INTO order_lines (id, order_id, product_id, description, quantity, unit_price, line_total, position, tax_scheme, vat_rate,
          supplier_id, cost_amount, is_customer_facing, material_kind, material_details, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      data.lines.forEach((l, i) => {
        const qty = Math.max(1, l.quantity || 1);
        const total = qty * (l.unitPrice || 0);
        const matJson = l.materialDetails ? JSON.stringify(l.materialDetails) : null;
        // v0.3.0 — falls Caller explizit einen Line-Status schickt nutze den,
        // sonst der vom Order-Initial-Status abgeleitete.
        const lineStatus = (l as Partial<OrderLine>).status || initialLineStatus;
        stmt.run([
          uuid(), id, resolvedProductIds[i], l.description || '', qty, l.unitPrice || 0, total, i + 1,
          l.taxScheme || null, l.vatRate ?? null,
          l.supplierId || null, l.costAmount ?? 0,
          l.isCustomerFacing === false ? 0 : 1,
          l.materialKind || null, matJson, lineStatus,
          now,
        ]);
      });
      stmt.free();
    }

    // Plan §Order: Wenn beim Anlegen ein Deposit eingegeben wurde, gleich als order_payments-Eintrag
    // persistieren — sonst zeigt OrderDetail Total Paid = 0 (summiert aus order_payments), waehrend
    // OrderList den deposit_amount aus der orders-Tabelle nimmt → Inkonsistenz.
    const initialPaid = data.fullyPaid ? (agreedPrice || 0) : (data.depositAmount || 0);
    let initialPaymentId: string | null = null;
    const paidAt = data.depositDate || now.split('T')[0];
    const method = data.paymentMethod || 'cash';
    // v0.7.26 — Karten-Brand des Deposits (nur bei method 'card').
    const depositBrand = method === 'card' ? normalizeCardBrand(data.cardBrand) : null;
    if (initialPaid > 0) {
      initialPaymentId = uuid();
      db.run(
        `INSERT INTO order_payments (id, order_id, amount, paid_at, method, card_brand, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          initialPaymentId,
          id,
          initialPaid,
          paidAt,
          method,
          depositBrand,
          data.fullyPaid ? 'Initial full payment' : 'Initial deposit',
          now,
        ]
      );
    }

    saveDatabase();
    trackInsert('orders', id, { orderNumber, customerId: data.customerId });
    eventBus.emit('order.created', 'order', id, { customerId: data.customerId });
    get().loadOrders();

    // ZIEL.md §3a — Initial-Deposit ans Ledger.
    if (initialPaymentId && initialPaid > 0 && data.customerId) {
      const payId = initialPaymentId;
      const customerId = data.customerId;
      safePost(`postOrderPayment(${payId}) [initial]`, () => {
        if (hasLedgerEntries('ORDER_PAYMENT', payId)) return;
        postOrderPayment(
          { id: payId, orderId: id, amount: initialPaid, method, paidAt },
          customerId
        );
      });
    }

    // v0.7.26 — Karten-Gebuehr fuer Deposit buchen (brand-genau). created_at = now
    // matcht den order_payments-Insert → bankingStore nettet die Order-Bank-Zeile.
    if (depositBrand && initialPaid > 0) {
      bookCardFee({
        branchId, userId, amount: initialPaid, brand: depositBrand,
        relatedModule: 'order', relatedEntityId: id, label: orderNumber, createdAt: now,
      });
    }

    return get().getOrder(id)!;
  },

  updateOrder: (id, data) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const fields: string[] = [];
    const values: unknown[] = [];
    const map: Record<string, string> = {
      customerId: 'customer_id', categoryId: 'category_id',
      condition: 'condition', serialNumber: 'serial_number', existingProductId: 'existing_product_id',
      requestedBrand: 'requested_brand',
      requestedModel: 'requested_model', requestedReference: 'requested_reference',
      requestedDetails: 'requested_details', agreedPrice: 'agreed_price',
      taxAmount: 'tax_amount', paymentMethod: 'payment_method',
      depositAmount: 'deposit_amount', depositDate: 'deposit_date',
      remainingAmount: 'remaining_amount', supplierName: 'supplier_name',
      supplierPrice: 'supplier_price', expectedMargin: 'expected_margin',
      expectedDelivery: 'expected_delivery', actualDelivery: 'actual_delivery',
      status: 'status', productId: 'product_id', invoiceId: 'invoice_id', notes: 'notes',
      // v0.2.1
      type: 'type', goldsmithSupplierId: 'goldsmith_supplier_id',
      laborCost: 'labor_cost', extraGoldValue: 'extra_gold_value',
    };
    for (const [k, v] of Object.entries(data)) {
      const col = map[k]; if (col) { fields.push(`${col} = ?`); values.push(v ?? null); }
    }
    if (data.attributes !== undefined) {
      fields.push('attributes = ?'); values.push(JSON.stringify(data.attributes));
    }
    if (data.customMeta !== undefined) {
      fields.push('custom_meta = ?'); values.push(data.customMeta ? JSON.stringify(data.customMeta) : null);
    }
    if (data.depositPaid !== undefined) { fields.push('deposit_paid = ?'); values.push(data.depositPaid ? 1 : 0); }
    if (data.fullyPaid !== undefined) { fields.push('fully_paid = ?'); values.push(data.fullyPaid ? 1 : 0); }
    if (fields.length === 0) return;
    fields.push('updated_at = ?'); values.push(now); values.push(id);
    db.run(`UPDATE orders SET ${fields.join(', ')} WHERE id = ?`, values);
    saveDatabase();
    trackUpdate('orders', id, data);
    get().loadOrders();

    // Plan §Order: KEINE Auto-Status-Promotion. Order-Status (PENDING/ARRIVED/NOTIFIED/COMPLETED)
    // ist explizit vom User gesetzt — Zahlung != Prozessfortschritt.
    // Beispiel: Kunde zahlt voll, Ware noch nicht da → Payment=PAID, Order=PENDING.
  },

  updateStatus: (id, status) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const updates: Partial<Order> = { status };

    if (status === 'arrived') {
      updates.actualDelivery = now.split('T')[0];
    }

    // v0.3.0 — Order-Status ist primaer ein Roll-up der Line-Stati. Wenn der
    // User den Order-Status manuell setzt, cascaded das auf die Lines:
    //  - 'arrived'   → alle non-cancelled PENDING-Lines → ARRIVED
    //  - 'completed' → alle non-cancelled Lines → DELIVERED
    //  - 'cancelled' → alle Lines → CANCELLED
    //  - 'notified' / 'pending' → nur Order-Status (kein Line-Cascade)
    // LAN-Sync (Gruppe 2): betroffene order_lines VOR dem Bulk-Status-Update erfassen,
    // danach je Row als update tracken — Bulk-WHERE order_id=? ist sonst nicht trackbar → B blieb stale.
    let cascadedLineIds: string[] = [];
    if (status === 'arrived') {
      cascadedLineIds = query(`SELECT id FROM order_lines WHERE order_id = ? AND status IN ('PENDING', 'ORDERED')`, [id]).map(r => r.id as string);
      db.run(`UPDATE order_lines SET status = 'ARRIVED' WHERE order_id = ? AND status IN ('PENDING', 'ORDERED')`, [id]);
    } else if (status === 'completed') {
      cascadedLineIds = query(`SELECT id FROM order_lines WHERE order_id = ? AND status != 'CANCELLED'`, [id]).map(r => r.id as string);
      db.run(`UPDATE order_lines SET status = 'DELIVERED' WHERE order_id = ? AND status != 'CANCELLED'`, [id]);
    } else if (status === 'cancelled') {
      cascadedLineIds = query(`SELECT id FROM order_lines WHERE order_id = ?`, [id]).map(r => r.id as string);
      db.run(`UPDATE order_lines SET status = 'CANCELLED' WHERE order_id = ?`, [id]);
    }

    get().updateOrder(id, updates);
    // Lines nach dem orders-Header (updateOrder hat ihn getrackt) → FK-Reihenfolge.
    for (const lid of cascadedLineIds) trackChange('order_lines', lid, 'update', {});

    // v0.2.1/v0.3.0 — Bei status='arrived'/'completed' werden die jetzt
    // ARRIVED-Lines mit supplier_id als A/P-Expense gebucht. commitOrderLineExpenses
    // filtert intern auf status IN ('ARRIVED','DELIVERED') + idempotent.
    if (status === 'arrived' || status === 'completed') {
      try { get().commitOrderLineExpenses(id); }
      catch (err) { console.error('[order] commitOrderLineExpenses failed:', err); }
    }

    const eventMap: Record<OrderStatus, string> = {
      pending: 'order.created',
      arrived: 'order.arrived',
      notified: 'order.notified',
      completed: 'order.completed',
      cancelled: 'order.cancelled',
    };
    if (eventMap[status]) {
      eventBus.emit(eventMap[status] as any, 'order', id, { status });
    }
  },

  // v0.3.0 — Per-Line Fulfillment-Status setzen. Triggert A/P-Buchung wenn
  // die Line auf ARRIVED geht + recomputed den Order-Roll-up-Status.
  updateOrderLineStatus: (lineId, status) => {
    const db = getDatabase();
    const lineRows = query(
      `SELECT order_id, invoice_id, status, expense_id, ordered_supplier_id FROM order_lines WHERE id = ?`,
      [lineId]
    );
    if (lineRows.length === 0) throw new Error(`Order-Line ${lineId} nicht gefunden`);
    const orderId = lineRows[0].order_id as string;
    const invoiceId = lineRows[0].invoice_id as string | null;
    const lineExpenseId = lineRows[0].expense_id as string | null;
    const currentStatus = lineRows[0].status as string;
    const orderedSupplierId = lineRows[0].ordered_supplier_id as string | null;

    // Salesforce-Regel: eine bereits invoicte Line darf nicht ge-cancelled
    // werden ohne die Invoice anzufassen → Block + Hinweis.
    if (status === 'CANCELLED' && invoiceId) {
      throw new Error('Diese Line ist bereits in einer Invoice — erst die Invoice stornieren (Cancel + Replace).');
    }

    // v0.6.8 — Back-to-Back-Guard: eine ORDERED-Zeile (beim Supplier bestellt)
    // darf nicht manuell auf ARRIVED/DELIVERED gesetzt werden — der Statuswechsel
    // muss ueber den Wareneingang (createPurchase mit source_order_line_id) laufen,
    // sonst entstehen keine Kosten, kein Lager-Lot und keine A/P-Schuld.
    if (currentStatus === 'ORDERED' && orderedSupplierId
        && (status === 'ARRIVED' || status === 'DELIVERED')) {
      throw new Error(
        'Diese Zeile ist beim Supplier bestellt — bitte „Wareneingang erfassen" nutzen, ' +
        'damit ein Purchase angelegt wird (Kosten + Lager + A/P). Manueller ARRIVED ist gesperrt.'
      );
    }

    // v0.6.9 — Undo der Supplier-Bestellung: wenn eine ORDERED-Zeile zurueck auf
    // PENDING geht, MUSS der ordered_supplier_id mitgenullt werden — sonst bleibt
    // die Zeile halb-bestellt haengen (Status PENDING + supplier gesetzt) und der
    // „Beim Supplier bestellt"-Button erscheint nicht mehr in der UI.
    if (currentStatus === 'ORDERED' && status === 'PENDING' && orderedSupplierId) {
      db.run(`UPDATE order_lines SET ordered_supplier_id = NULL WHERE id = ?`, [lineId]);
      trackUpdate('order_lines', lineId, { orderedSupplierId: null });
    }

    db.run(`UPDATE order_lines SET status = ? WHERE id = ?`, [status, lineId]);
    trackUpdate('order_lines', lineId, { status });

    // v0.3.1 — Wird eine Line mit bereits gebuchter A/P-Expense ge-CANCELLED,
    // muss die Expense mit-storniert werden (Ledger-Reverse). Sonst bliebe die
    // Supplier-Schuld als Orphan stehen. expense_id wird geloest, damit ein
    // spaeteres Re-ARRIVED via commitOrderLineExpenses sauber neu bucht.
    if (status === 'CANCELLED' && lineExpenseId) {
      try {
        cancelOrderLineExpense(lineExpenseId);
        db.run(`UPDATE order_lines SET expense_id = NULL WHERE id = ?`, [lineId]);
        trackUpdate('order_lines', lineId, { expenseId: null });
      } catch (err) {
        console.error('[order] order-line expense cancel failed:', err);
      }
    }

    // Bei ARRIVED: A/P-Expense fuer Supplier-Lines buchen (idempotent).
    if (status === 'ARRIVED' || status === 'DELIVERED') {
      try { get().commitOrderLineExpenses(orderId); }
      catch (err) { console.error('[order] commitOrderLineExpenses failed:', err); }
    }

    saveDatabase();
    get().recomputeOrderStatus(orderId);
    get().loadOrders();
  },

  // Back-to-Back — Zeile als "beim Supplier bestellt" markieren. Reiner Marker:
  // kein Geld, kein Lager. Der geplante Supplier wird festgehalten, damit der
  // Wareneingang die Posten nach Lieferant gruppieren kann.
  markOrderLineOrdered: (lineId, orderedSupplierId) => {
    const db = getDatabase();
    const rows = query(`SELECT order_id, invoice_id FROM order_lines WHERE id = ?`, [lineId]);
    if (rows.length === 0) throw new Error(`Order-Line ${lineId} nicht gefunden`);
    if (rows[0].invoice_id) {
      throw new Error('Diese Position ist bereits in einer Invoice.');
    }
    const orderId = rows[0].order_id as string;
    db.run(`UPDATE order_lines SET status = 'ORDERED', ordered_supplier_id = ? WHERE id = ?`,
      [orderedSupplierId || null, lineId]);
    trackUpdate('order_lines', lineId, { status: 'ORDERED', orderedSupplierId: orderedSupplierId || null });
    saveDatabase();
    get().recomputeOrderStatus(orderId);
    get().loadOrders();
  },

  // v0.3.0 — Order-Status aus den Line-Stati neu ableiten (Roll-up).
  recomputeOrderStatus: (orderId) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const orderRows = query(`SELECT status FROM orders WHERE id = ?`, [orderId]);
    if (orderRows.length === 0) return;
    const currentStatus = (orderRows[0].status as OrderStatus) || 'pending';
    // v0.5.0 — nur kundenseitige Lines zaehlen fuer den Roll-up. Interne
    // Kostenpositionen (is_customer_facing = 0) sind reine Buchhaltung und
    // duerfen den Fulfillment-Status nicht beeinflussen.
    const lineRows = query(
      `SELECT status FROM order_lines WHERE order_id = ? AND COALESCE(is_customer_facing, 1) = 1`,
      [orderId]
    );
    if (lineRows.length === 0) return;
    const lineStatuses = lineRows.map(r => ((r.status as string) || 'PENDING') as OrderLineStatus);
    const derived = deriveOrderStatusFromLines(lineStatuses, currentStatus);
    if (derived !== currentStatus) {
      db.run(`UPDATE orders SET status = ?, updated_at = ? WHERE id = ?`, [derived, now, orderId]);
      trackUpdate('orders', orderId, { status: derived });
      saveDatabase();
      get().loadOrders();
    }
  },

  // v0.3.0 — Lines die fertig (ARRIVED/DELIVERED) + customer-facing + noch
  // nicht invoiced sind. Basis fuer partielles Convert-to-Invoice.
  getBillableLines: (orderId) => {
    return get().getOrderLines(orderId).filter(l =>
      l.isCustomerFacing !== false &&
      !l.invoiceId &&
      (l.status === 'ARRIVED' || l.status === 'DELIVERED')
    );
  },

  // v0.3.0 — nach erfolgreichem Convert: die invoicten Lines mit der Invoice
  // verknuepfen. Order.invoice_id zeigt auf die zuletzt erzeugte Invoice.
  markOrderLinesInvoiced: (lineIds, invoiceId) => {
    if (lineIds.length === 0) return;
    const db = getDatabase();
    for (const lid of lineIds) {
      db.run(`UPDATE order_lines SET invoice_id = ? WHERE id = ?`, [invoiceId, lid]);
      trackUpdate('order_lines', lid, { invoiceId });
    }
    saveDatabase();
    get().loadOrders();
  },

  // v0.5.0 — Custom-Order „cost-later": eine einzelne Line ans Order anhaengen.
  // Genutzt von OrderDetail um Labor-/Diamond-/Material-Kosten nachzutragen wenn
  // das Stueck fertig ist. Kommt die Line als ARRIVED + supplier_id rein, bucht
  // commitOrderLineExpenses direkt die A/P-Schuld.
  addOrderLine: (orderId, line) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const posRow = query(`SELECT COALESCE(MAX(position), 0) AS m FROM order_lines WHERE order_id = ?`, [orderId]);
    const position = Number(posRow[0]?.m || 0) + 1;
    const lineId = uuid();
    const qty = Math.max(1, line.quantity || 1);
    const total = qty * (line.unitPrice || 0);
    const matJson = line.materialDetails ? JSON.stringify(line.materialDetails) : null;
    const status: OrderLineStatus = line.status || 'PENDING';
    db.run(
      `INSERT INTO order_lines (id, order_id, product_id, description, quantity, unit_price, line_total, position,
        tax_scheme, vat_rate, supplier_id, cost_amount, is_customer_facing, material_kind, material_details, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [lineId, orderId, line.productId || null, line.description || '', qty, line.unitPrice || 0, total, position,
       line.taxScheme || null, line.vatRate ?? null,
       line.supplierId || null, line.costAmount ?? 0,
       line.isCustomerFacing === false ? 0 : 1,
       line.materialKind || null, matJson, status, now]
    );
    trackInsert('order_lines', lineId, { orderId, position, status });
    saveDatabase();

    // Bei ARRIVED/DELIVERED: A/P-Expense fuer supplier-Lines buchen (idempotent).
    if (status === 'ARRIVED' || status === 'DELIVERED') {
      try { get().commitOrderLineExpenses(orderId); }
      catch (err) { console.error('[order] commitOrderLineExpenses (addOrderLine) failed:', err); }
    }
    get().recomputeOrderStatus(orderId);
    get().loadOrders();
    return lineId;
  },

  // v0.5.0 — Eine Order-Line loeschen. Blockt wenn bereits invoiced; reverst die
  // verknuepfte A/P-Expense damit keine Orphan-Supplier-Schuld zurueckbleibt.
  deleteOrderLine: (lineId) => {
    const db = getDatabase();
    const rows = query(
      `SELECT order_id, invoice_id, expense_id FROM order_lines WHERE id = ?`,
      [lineId]
    );
    if (rows.length === 0) return;
    const orderId = rows[0].order_id as string;
    const invoiceId = rows[0].invoice_id as string | null;
    const expenseId = rows[0].expense_id as string | null;
    if (invoiceId) {
      throw new Error('Diese Position ist bereits in einer Invoice — erst die Invoice stornieren.');
    }
    // v0.6.5 — verknuepfte Gold-Verbindlichkeit(en): OPEN → mitloeschen; bereits
    // beglichene (FULFILLED) → Loeschen blockieren, sonst verwaist die schon
    // gebuchte Settlement-Expense.
    const linkedGp = query(`SELECT id, status FROM gold_payables WHERE source_order_line_id = ?`, [lineId]);
    if (linkedGp.some(g => g.status !== 'OPEN' && g.status !== 'CANCELLED')) {
      throw new Error('Die Gold-Verbindlichkeit dieser Position wurde bereits beglichen — bitte erst die Verbindlichkeit rückabwickeln.');
    }
    for (const g of linkedGp) {
      db.run(`DELETE FROM gold_payables WHERE id = ?`, [g.id as string]);
      trackDelete('gold_payables', g.id as string);
    }
    if (expenseId) {
      try {
        cancelOrderLineExpense(expenseId);
        db.run(`DELETE FROM expense_payments WHERE expense_id = ?`, [expenseId]);
        db.run(`DELETE FROM expenses WHERE id = ?`, [expenseId]);
        trackDelete('expenses', expenseId);
      } catch (err) {
        console.error(`[order] order-line expense cleanup failed (${expenseId}):`, err);
      }
    }
    // Back-to-Back: eine evtl. verknuepfte Purchase-Zeile entkoppeln (defensiv —
    // sql.js erzwingt FK ON DELETE SET NULL evtl. nicht).
    // LAN-Sync (Bug-3): betroffene purchase_lines VOR dem Nullen erfassen, danach als update tracken.
    const plUnlinkedIds = query(`SELECT id FROM purchase_lines WHERE source_order_line_id = ?`, [lineId]).map(r => r.id as string);
    db.run(`UPDATE purchase_lines SET source_order_line_id = NULL WHERE source_order_line_id = ?`, [lineId]);
    db.run(`DELETE FROM order_lines WHERE id = ?`, [lineId]);
    trackDelete('order_lines', lineId);
    for (const plId of plUnlinkedIds) trackChange('purchase_lines', plId, 'update', {});
    saveDatabase();
    get().recomputeOrderStatus(orderId);
    get().loadOrders();
  },

  // v0.5.0 — Preis einer Order-Line aendern (Quoted Price nachtraeglich).
  updateOrderLinePrice: (lineId, unitPrice) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const rows = query(`SELECT order_id, quantity, invoice_id FROM order_lines WHERE id = ?`, [lineId]);
    if (rows.length === 0) throw new Error(`Order-Line ${lineId} nicht gefunden`);
    if (rows[0].invoice_id) {
      throw new Error('Diese Position ist bereits in einer Invoice — Preis erst nach Storno der Invoice aenderbar.');
    }
    const orderId = rows[0].order_id as string;
    const qty = Math.max(1, (rows[0].quantity as number) || 1);
    const total = qty * unitPrice;
    db.run(`UPDATE order_lines SET unit_price = ?, line_total = ? WHERE id = ?`, [unitPrice, total, lineId]);
    trackUpdate('order_lines', lineId, { unitPrice, lineTotal: total });
    // agreed_price = Σ line_total der kundenseitigen Lines neu ableiten.
    const sumRow = query(
      `SELECT COALESCE(SUM(line_total), 0) AS t FROM order_lines WHERE order_id = ? AND COALESCE(is_customer_facing, 1) = 1`,
      [orderId]
    );
    const agreed = Number(sumRow[0]?.t || 0);
    db.run(`UPDATE orders SET agreed_price = ?, updated_at = ? WHERE id = ?`,
      [agreed > 0 ? agreed : null, now, orderId]);
    trackUpdate('orders', orderId, { agreedPrice: agreed });
    saveDatabase();
    get().loadOrders();
  },

  // Back-to-Back — Order-Line in-place bearbeiten. Zeilen-ID bleibt erhalten,
  // damit purchase_lines.source_order_line_id-Verknuepfungen intakt bleiben.
  updateOrderLine: (lineId, patch) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const rows = query(
      `SELECT order_id, product_id, quantity, unit_price, invoice_id FROM order_lines WHERE id = ?`,
      [lineId]
    );
    if (rows.length === 0) throw new Error(`Order-Line ${lineId} nicht gefunden`);
    if (rows[0].invoice_id) {
      throw new Error('Diese Position ist bereits in einer Invoice — erst die Invoice stornieren.');
    }
    const orderId = rows[0].order_id as string;

    // Produkt-Wechsel? — gesperrt sobald die Zeile via aktivem Purchase beschafft wurde.
    const wantsProductChange = patch.productId !== undefined || patch.newProduct !== undefined;
    if (wantsProductChange) {
      const sourced = query(
        `SELECT 1 FROM purchase_lines pl JOIN purchases p ON p.id = pl.purchase_id
          WHERE pl.source_order_line_id = ? AND p.status != 'CANCELLED' LIMIT 1`,
        [lineId]
      );
      if (sourced.length > 0) {
        throw new Error('Diese Position wurde bereits beim Supplier beschafft — Produkt erst nach Storno des Purchase aenderbar.');
      }
    }

    // Produkt aufloesen: undefined = nicht aendern.
    let productId: string | null | undefined;
    if (patch.newProduct) {
      try {
        const created = useProductStore.getState().createProduct({
          ...patch.newProduct,
          stockStatus: 'in_stock',
        });
        // New-Produkt ohne Bestand — quantity 0 bis zum Wareneingang (Purchase).
        db.run(`UPDATE products SET quantity = 0 WHERE id = ?`, [created.id]);
        trackProductRow(created.id);   // LAN-Sync Phase 1b
        productId = created.id;
      } catch (err) {
        console.error('[order] createProduct (updateOrderLine) failed:', err);
      }
    } else if (patch.productId !== undefined) {
      productId = patch.productId || null;
    }

    const fields: string[] = [];
    const values: unknown[] = [];
    if (productId !== undefined) { fields.push('product_id = ?'); values.push(productId); }
    if (patch.description !== undefined) { fields.push('description = ?'); values.push(patch.description || ''); }
    const qty = patch.quantity !== undefined ? Math.max(1, patch.quantity) : (Number(rows[0].quantity) || 1);
    const unitPrice = patch.unitPrice !== undefined ? patch.unitPrice : (Number(rows[0].unit_price) || 0);
    if (patch.quantity !== undefined) { fields.push('quantity = ?'); values.push(qty); }
    if (patch.unitPrice !== undefined) { fields.push('unit_price = ?'); values.push(unitPrice); }
    if (patch.quantity !== undefined || patch.unitPrice !== undefined) {
      fields.push('line_total = ?'); values.push(qty * unitPrice);
    }
    if (fields.length === 0) return;
    values.push(lineId);
    db.run(`UPDATE order_lines SET ${fields.join(', ')} WHERE id = ?`, values);
    trackUpdate('order_lines', lineId, patch);

    // agreed_price = Σ line_total der kundenseitigen Lines neu ableiten.
    const sumRow = query(
      `SELECT COALESCE(SUM(line_total), 0) AS t FROM order_lines WHERE order_id = ? AND COALESCE(is_customer_facing, 1) = 1`,
      [orderId]
    );
    const agreed = Number(sumRow[0]?.t || 0);
    db.run(`UPDATE orders SET agreed_price = ?, updated_at = ? WHERE id = ?`,
      [agreed > 0 ? agreed : null, now, orderId]);
    trackUpdate('orders', orderId, { agreedPrice: agreed });
    saveDatabase();
    get().loadOrders();
  },

  // v0.2.1 — Port von repairStore.commitRepairLineExpenses. Postet pro
  // order_line mit supplier_id + cost_amount > 0 einen Expense + Ledger A/P.
  // Idempotent: ueberspringt lines die bereits expense_id haben.
  commitOrderLineExpenses: (orderId) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const orderRows = query(
      `SELECT id, branch_id, order_number, payment_method FROM orders WHERE id = ?`,
      [orderId]
    );
    if (orderRows.length === 0) return;
    const order = orderRows[0];
    const orderNumber = order.order_number as string;
    let branchId: string, userId: string;
    try { branchId = currentBranchId(); userId = currentUserId(); }
    catch { branchId = (order.branch_id as string) || 'branch-main'; userId = 'user-owner'; }

    // v0.3.0 — nur Lines die physisch da sind (status='ARRIVED') werden gebucht.
    // Die A/P-Schuld entsteht wenn das Teil vom Supplier geliefert wurde —
    // nicht schon bei Order-Anlage. DELIVERED zaehlt auch (war mal ARRIVED).
    const lineRows = query(
      `SELECT id, position, supplier_id, description, cost_amount, material_kind, material_details
         FROM order_lines
         WHERE order_id = ? AND supplier_id IS NOT NULL AND expense_id IS NULL
           AND cost_amount > 0
           AND status IN ('ARRIVED', 'DELIVERED')
         ORDER BY position`,
      [orderId]
    );
    if (lineRows.length === 0) return;

    for (const lr of lineRows) {
      const lineId = lr.id as string;
      const position = (lr.position as number) || 0;
      const supplierId = lr.supplier_id as string;
      const description = (lr.description as string) || '';
      const cost = (lr.cost_amount as number) || 0;
      const matKind = (lr.material_kind as string) || 'labor';
      if (cost <= 0) continue;

      const expenseId = uuid();
      const expenseNumber = getNextDocumentNumber('EXP');
      const method = ((order.payment_method as 'cash' | 'bank' | 'benefit' | null) || 'bank');
      const expStatus = 'PENDING' as const;

      // Supplier-Label
      let supplierLabel = '';
      try {
        const sRow = query(`SELECT name FROM suppliers WHERE id = ?`, [supplierId]);
        if (sRow.length > 0) supplierLabel = ' · ' + (sRow[0].name as string);
      } catch { /* */ }

      // Sub-Number Format: ORD-000023-L1 (analog v0.1.48 Repair-Lines)
      const lineLabel = position > 0 ? `${orderNumber}-L${position}` : orderNumber;
      const desc = `${lineLabel} · ${matKind}${description ? ' · ' + description : ''}${supplierLabel}`;
      db.run(
        `INSERT INTO expenses (id, branch_id, expense_number, category, amount, paid_amount, payment_method,
           expense_date, description, related_module, related_entity_id, supplier_id, status, created_at, created_by)
         VALUES (?, ?, ?, 'Inventory', ?, 0, ?, ?, ?, 'order', ?, ?, ?, ?, ?)`,
        [expenseId, branchId, expenseNumber, cost, method,
         now.split('T')[0], desc, orderId, supplierId, expStatus, now, userId]
      );
      trackInsert('expenses', expenseId, {
        category: 'Inventory', amount: cost, orderId, orderLineId: lineId,
        supplierId, status: expStatus,
      });

      // Link expense back to order_line
      db.run(`UPDATE order_lines SET expense_id = ? WHERE id = ?`, [expenseId, lineId]);
      trackUpdate('order_lines', lineId, { expenseId });

      // ZIEL.md §3a — Ledger-Posting nach Insert.
      const expFresh: Expense = {
        id: expenseId,
        branchId,
        expenseNumber,
        category: 'Inventory',
        amount: cost,
        paidAmount: 0,
        paymentMethod: method,
        expenseDate: now.split('T')[0],
        description: desc,
        relatedModule: 'order',
        relatedEntityId: orderId,
        supplierId,
        status: expStatus,
        createdAt: now,
        createdBy: userId,
      };
      safePost(`postExpense(${expenseId}) [order-line]`, () => {
        if (hasLedgerEntries('EXPENSE', expenseId)) return;
        postExpense(expFresh);
      });
    }

    saveDatabase();
    get().loadOrders();
  },

  rewriteOrderLines: (orderId, lines) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    // v0.3.0 — alte Line-Stati per Position merken, damit Edit nicht das
    // Fulfillment zuruecksetzt. Auch invoice_id erhalten (wo Position matcht).
    const oldRows = query(
      `SELECT position, status, invoice_id FROM order_lines WHERE order_id = ?`,
      [orderId]
    );
    const oldByPos = new Map<number, { status: string; invoiceId: string | null }>();
    for (const r of oldRows) {
      oldByPos.set((r.position as number) || 0, {
        status: (r.status as string) || 'PENDING',
        invoiceId: (r.invoice_id as string | null) || null,
      });
    }
    db.run(`DELETE FROM order_lines WHERE order_id = ?`, [orderId]);
    if (lines.length > 0) {
      const stmt = db.prepare(
        `INSERT INTO order_lines (id, order_id, product_id, description, quantity, unit_price, line_total, position, tax_scheme, vat_rate,
          supplier_id, cost_amount, is_customer_facing, material_kind, material_details, status, invoice_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      lines.forEach((l, i) => {
        const qty = Math.max(1, l.quantity || 1);
        const total = qty * (l.unitPrice || 0);
        const matJson = l.materialDetails ? JSON.stringify(l.materialDetails) : null;
        const prev = oldByPos.get(i + 1);
        stmt.run([
          uuid(), orderId, l.productId || null, l.description || '', qty, l.unitPrice || 0, total, i + 1,
          l.taxScheme || null, l.vatRate ?? null,
          l.supplierId || null, l.costAmount ?? 0,
          l.isCustomerFacing === false ? 0 : 1,
          l.materialKind || null, matJson,
          prev?.status || 'PENDING', prev?.invoiceId || null,
          now,
        ]);
      });
      stmt.free();
    }
    // Recompute agreedPrice from lines — nur customer-facing zaehlt!
    const sumRow = query(`SELECT COALESCE(SUM(line_total), 0) AS t FROM order_lines WHERE order_id = ? AND COALESCE(is_customer_facing, 1) = 1`, [orderId]);
    const total = Number(sumRow[0]?.t || 0);
    // v0.3.0 — type neu ableiten nach Line-Edit
    const derivedType = deriveOrderType(lines.map(l => ({ materialKind: l.materialKind })));
    db.run(`UPDATE orders SET agreed_price = ?, type = ?, updated_at = ? WHERE id = ?`,
      [total > 0 ? total : null, derivedType, now, orderId]);
    saveDatabase();
    trackUpdate('orders', orderId, { linesReplaced: true, total, type: derivedType });
    get().loadOrders();
  },

  getOrderLines: (orderId) => {
    try {
      const rows = query(
        `SELECT * FROM order_lines WHERE order_id = ? ORDER BY position`,
        [orderId]
      );
      return rows.map(r => {
        let matDetails: MaterialDetails | undefined;
        try {
          const raw = r.material_details as string | null;
          if (raw) matDetails = JSON.parse(raw) as MaterialDetails;
        } catch { /* */ }
        return {
          id: r.id as string,
          orderId: r.order_id as string,
          productId: (r.product_id as string | null) || undefined,
          description: (r.description as string) || '',
          quantity: (r.quantity as number) || 1,
          unitPrice: (r.unit_price as number) || 0,
          lineTotal: (r.line_total as number) || 0,
          position: (r.position as number) || 0,
          taxScheme: (r.tax_scheme as OrderLine['taxScheme'] | null) || undefined,
          vatRate: r.vat_rate != null ? (r.vat_rate as number) : undefined,
          // v0.2.1 — neue Felder
          supplierId: (r.supplier_id as string | null) || undefined,
          costAmount: r.cost_amount != null ? (r.cost_amount as number) : undefined,
          expenseId: (r.expense_id as string | null) || undefined,
          isCustomerFacing: r.is_customer_facing == null ? true : Number(r.is_customer_facing) === 1,
          materialKind: (r.material_kind as OrderLine['materialKind']) || undefined,
          materialDetails: matDetails,
          // v0.3.0 — Per-Line Status + partial-invoicing link
          status: ((r.status as string) || 'PENDING') as OrderLineStatus,
          invoiceId: (r.invoice_id as string | null) || undefined,
          orderedSupplierId: (r.ordered_supplier_id as string | null) || undefined,
        };
      });
    } catch { return []; }
  },

  // v0.7.0 — siehe Interface-Doku. Throw bei invoiced Lines, sonst:
  //   1. Customer-Money (totalPaid > 0) → choice-basierte Ledger-Buchung +
  //      bei 'credit' Insert in customer_credits.
  //   2. Cost-Line-Expenses reverten + DELETE.
  //   3. Open gold_payables → CANCELLED.
  //   4. ORDERED-Lines → ordered_supplier_id NULL.
  //   5. Status → cancelled. Lines → CANCELLED.
  cancelOrderWithMoney: (id, choice, refundMethod, note) => {
    const db = getDatabase();
    const now = new Date().toISOString();

    // 0. Order + Customer laden
    const oRows = query(`SELECT id, customer_id, status, product_id FROM orders WHERE id = ?`, [id]);
    if (oRows.length === 0) throw new Error(`Order ${id} nicht gefunden`);
    const customerId = oRows[0].customer_id as string;
    const currentStatus = oRows[0].status as OrderStatus;
    const linkedProductId = (oRows[0].product_id as string | null) || null;  // L-07
    if (currentStatus === 'cancelled') throw new Error('Order ist bereits storniert.');

    // 0a. Invoiced-Block: keine Line darf invoice_id != NULL haben
    const invoicedRows = query(
      `SELECT COUNT(*) AS n FROM order_lines WHERE order_id = ? AND invoice_id IS NOT NULL`,
      [id]
    );
    if (Number(invoicedRows[0]?.n || 0) > 0) {
      throw new Error('Mind. eine Zeile ist bereits in einer Invoice — bitte erst die Invoice stornieren.');
    }

    // 1. totalPaid berechnen (SUM order_payments)
    const payRows = query(`SELECT COALESCE(SUM(amount),0) AS t FROM order_payments WHERE order_id = ?`, [id]);
    const totalPaid = Number(payRows[0]?.t || 0);

    // 1a. Geld-Buchung gemaess Wahl
    if (totalPaid > 0) {
      if (choice === 'refund' && !refundMethod) {
        throw new Error('Refund braucht eine Zahlmethode (Cash / Bank / Benefit).');
      }
      // L-06 — der customer_credits-Insert (= die einloesbare Gutschrift fuer die
      // bereits erhaltene Anzahlung) darf NICHT mehr still per console.warn schlucken:
      // schlaegt er fehl, bricht der ganze Storno ab (Error bubbelt), BEVOR die Order
      // auf 'cancelled' gesetzt wird. Sonst waere die Order storniert, aber die
      // Anzahlung haette keinen Domain-Credit zum Einloesen (Geld-Phantom). Insert vor
      // dem Post — Reihenfolge-Konvention ZIEL.md §3a. Credit-Modell: der Post bucht
      // jetzt DR CUSTOMER_DEPOSITS / CR CUSTOMER_CREDIT (Anzahlung→Store-Guthaben),
      // sodass Domain-Row und Ledger-Saldo spiegelgleich + einloesbar sind.
      if (choice === 'credit') {
        const creditId = uuid();
        let branchId: string;
        try { branchId = currentBranchId(); } catch { branchId = 'branch-main'; }
        db.run(
          `INSERT INTO customer_credits (id, branch_id, customer_id, amount, used_amount, status,
             source_type, source_id, note, created_at)
           VALUES (?, ?, ?, ?, 0, 'OPEN', 'order_cancel', ?, ?, ?)`,
          [creditId, branchId, customerId, totalPaid, id,
           note || `Storno Order — Guthaben zur weiteren Verrechnung`, now]
        );
        trackInsert('customer_credits', creditId, {
          customerId, amount: totalPaid, sourceOrderId: id,
        });
      }
      safePost(`postOrderCancellationChoice(${id}, ${choice})`, () => {
        postOrderCancellationChoice({
          orderId: id, customerId, totalPaid, choice, refundMethod,
        });
      });
    }

    // 2. Cost-Lines analysieren: real-gebuchte A/P (expense_id != NULL) bleiben
    //    OFFEN als Verbindlichkeit gegenueber dem Supplier. Der Goldsmith hat
    //    bereits gearbeitet / Material geliefert — diese Schuld kann nicht
    //    einfach geloescht werden, sie muss bezahlt oder mit dem Supplier
    //    manuell verhandelt werden (dann macht der User die Expense-Storno selbst).
    //    Lines OHNE expense_id (noch nie ARRIVED) haben keine A/P → einfach weg.
    const costRows = query(
      `SELECT id, expense_id, cost_amount, material_kind, supplier_id
         FROM order_lines
         WHERE order_id = ? AND COALESCE(is_customer_facing, 1) = 0`,
      [id]
    );
    const realizedCosts = costRows.filter(r => r.expense_id);
    const customCostBasis = costRows.reduce((s, r) => s + ((r.cost_amount as number) || 0), 0);
    // expense_id auf der order_line nullen, damit die nachfolgende Status-Cascade
    // nicht den Eindruck erweckt, die Line haenge weiter an einer Expense.
    // Die Expense selbst BLEIBT (real A/P-Schuld).
    for (const lr of realizedCosts) {
      const lid = lr.id as string;
      db.run(`UPDATE order_lines SET expense_id = NULL WHERE id = ?`, [lid]);
      trackUpdate('order_lines', lid, { expenseId: null });
    }

    // 3. Offene Gold-Verbindlichkeiten cancellen.
    const gpRows = query(
      `SELECT id FROM gold_payables WHERE source_order_id = ? AND status = 'OPEN'`,
      [id]
    );
    for (const gr of gpRows) {
      const gpId = gr.id as string;
      db.run(`UPDATE gold_payables SET status = 'CANCELLED', updated_at = ? WHERE id = ?`,
        [now, gpId]);
      trackUpdate('gold_payables', gpId, { status: 'CANCELLED' });
    }

    // 4. ORDERED-Lines: ordered_supplier_id nullen (Supplier-Marker wegnehmen).
    //    Cancel-Cascade weiter unten setzt sie auf CANCELLED.
    db.run(
      `UPDATE order_lines SET ordered_supplier_id = NULL
         WHERE order_id = ? AND status = 'ORDERED'`,
      [id]
    );

    // 5. Order + Lines auf CANCELLED.
    db.run(`UPDATE order_lines SET status = 'CANCELLED' WHERE order_id = ?`, [id]);
    db.run(`UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ?`, [now, id]);
    trackUpdate('orders', id, { status: 'cancelled', cancelChoice: choice });
    // LAN-Sync (Gruppe 2): alle order_lines nach dem finalen CANCELLED-Update tracken — der
    // Full-Row-Snapshot deckt status=CANCELLED + ordered_supplier_id=NULL (Bulk oben) gemeinsam ab.
    for (const lid of query(`SELECT id FROM order_lines WHERE order_id = ?`, [id]).map(r => r.id as string)) {
      trackChange('order_lines', lid, 'update', {});
    }

    // 5b. L-07 — ein per Convert-Vorbereitung erzeugtes 'reserved' Custom-Produkt
    //     (order.product_id, OrderDetail.handleConvert) wieder freigeben, sonst haengt
    //     es nach dem Storno fuer immer in 'reserved'. Wird so eines freigegeben,
    //     ueberspringen wir den Overflow-Create unten (sonst Duplikat fuer dasselbe Stueck).
    let freedReservedProduct = false;
    if (linkedProductId) {
      const pr = query(`SELECT stock_status FROM products WHERE id = ?`, [linkedProductId]);
      if (pr.length > 0 && pr[0].stock_status === 'reserved') {
        db.run(`UPDATE products SET stock_status = 'in_stock', updated_at = ? WHERE id = ?`,
          [now, linkedProductId]);
        trackUpdate('products', linkedProductId, { stockStatus: 'in_stock' });
        freedReservedProduct = true;
      }
    }

    // 6. Custom-Order mit angefangener Arbeit: Stueck in Lager ueberfuehren.
    //    Trigger: customCostBasis > 0 UND mind. eine ARRIVED Cost-Line (= realer
    //    Arbeit/Material). Das fertige/halbfertige Stueck wird als Lagerprodukt
    //    angelegt mit kapitalisierter Kostenbasis als purchasePrice. So bleibt
    //    der Wert im System sichtbar und das Stueck ist weiterverkaeufbar.
    if (!freedReservedProduct && customCostBasis > 0 && realizedCosts.length > 0) {
      try {
        const ord = query(
          `SELECT category_id, attributes, condition, requested_brand, requested_model,
                  agreed_price, custom_product_spec FROM orders WHERE id = ?`, [id]);
        if (ord.length > 0) {
          const row = ord[0];
          let spec: Partial<Product> = {};
          try {
            const raw = row.custom_product_spec as string | null;
            if (raw) spec = JSON.parse(raw) as Partial<Product>;
          } catch { /* */ }
          let attrs: Record<string, string | number | boolean | string[]> = {};
          try { attrs = JSON.parse((row.attributes as string) || '{}'); } catch { /* */ }
          const agreedPrice = (row.agreed_price as number) || 0;
          const newProduct = useProductStore.getState().createProduct({
            categoryId: spec.categoryId || (row.category_id as string) || '',
            brand: spec.brand || (row.requested_brand as string) || 'Custom',
            name: spec.name || (row.requested_model as string) || 'Custom (cancelled order)',
            sku: spec.sku,
            condition: spec.condition || (row.condition as string) || '',
            attributes: (spec.attributes as Record<string, string | number | boolean | string[]>) || attrs,
            images: spec.images || [],
            scopeOfDelivery: spec.scopeOfDelivery || [],
            purchasePrice: customCostBasis,
            plannedSalePrice: agreedPrice > 0 ? agreedPrice : customCostBasis,
            stockStatus: 'in_stock',  // frei verkaeuflich (anders als Convert: dort 'reserved')
            taxScheme: spec.taxScheme || 'MARGIN',
            sourceType: 'OWN',
            notes: (spec.notes ? spec.notes + '\n\n' : '')
              + `From cancelled custom order — capitalized costs ${customCostBasis.toFixed(3)} BHD.`,
          });
          console.info('[order] cancelled custom-order → product transferred to stock',
            { orderId: id, productId: newProduct.id, value: customCostBasis });
        }
      } catch (err) {
        console.error('[order] cancel: custom product overflow to stock failed:', err);
      }
    }

    saveDatabase();
    eventBus.emit('order.cancelled', 'order', id, { status: 'cancelled', choice });
    get().loadOrders();
  },

  deleteOrder: (id) => {
    const db = getDatabase();
    // ZIEL.md §3a — Vor dem CASCADE-Delete der order_payments deren Ledger-Buchungen reversen,
    // sonst hängt Customer-Deposits-Liability ohne Quelle in der Luft.
    const payRows = query('SELECT id FROM order_payments WHERE order_id = ?', [id]);
    for (const r of payRows) {
      const opId = r.id as string;
      safePost(`postOrderPaymentReversed(${opId}) [delete-order]`, () => {
        if (!hasLedgerEntries('ORDER_PAYMENT', opId)) return;
        if (hasReversalFor('ORDER_PAYMENT', opId)) return;
        postOrderPaymentReversed(opId);
      });
    }
    // v0.7.26 — Order-Karten-Gebuehren reversen (Bank zurueck), sonst bliebe der
    // CardFee-Bank-Abgang nach dem Order-Loeschen stehen.
    reverseCardFees('order', id);
    // v0.3.1 — Order-Line-A/P-Expenses (gebucht bei ARRIVED via commitOrderLineExpenses)
    // vor dem Loeschen der order_lines storno-reversen + entfernen. Sonst bliebe die
    // Supplier-Schuld als Orphan-Expense ohne Quelle im Ledger haengen.
    const expRows = query(
      `SELECT expense_id FROM order_lines WHERE order_id = ? AND expense_id IS NOT NULL`,
      [id]
    );
    for (const er of expRows) {
      const expId = er.expense_id as string;
      try {
        cancelOrderLineExpense(expId);
        db.run(`DELETE FROM expense_payments WHERE expense_id = ?`, [expId]);
        db.run(`DELETE FROM expenses WHERE id = ?`, [expId]);
        trackDelete('expenses', expId);
      } catch (err) {
        console.error(`[order] order-line expense cleanup failed (${expId}):`, err);
      }
    }
    // v0.6.0 — Order-verknuepfte Gold-Verbindlichkeiten stornieren (Gramm-Schuld,
    // kein Ledger-Effekt). Nur OPEN — bereits beglichene bleiben unberuehrt.
    const gpRows = query(`SELECT id FROM gold_payables WHERE source_order_id = ? AND status = 'OPEN'`, [id]);
    for (const gr of gpRows) {
      const gpId = gr.id as string;
      db.run(`UPDATE gold_payables SET status = 'CANCELLED', updated_at = ? WHERE id = ?`,
        [new Date().toISOString(), gpId]);
      trackUpdate('gold_payables', gpId, { status: 'CANCELLED' });
    }
    // Back-to-Back: Purchase-Verknuepfungen entkoppeln, bevor die order_lines
    // hart geloescht werden (sql.js erzwingt FK ON DELETE SET NULL evtl. nicht).
    // LAN-Sync (Bug-3): betroffene purchase_lines VOR dem Nullen erfassen, danach als update tracken.
    const plUnlinkedIds = query(
      `SELECT id FROM purchase_lines WHERE source_order_line_id IN (SELECT id FROM order_lines WHERE order_id = ?)`,
      [id]
    ).map(r => r.id as string);
    db.run(
      `UPDATE purchase_lines SET source_order_line_id = NULL
        WHERE source_order_line_id IN (SELECT id FROM order_lines WHERE order_id = ?)`,
      [id]
    );
    // LAN-Sync (Gruppe 2): betroffene purchases VOR dem source_order_id-Nullen erfassen, danach je
    // Purchase-Header als update tracken (sonst stale Order-Ref auf B; asymmetrisch zur purchase_lines daneben).
    const purUnlinkedIds = query(`SELECT id FROM purchases WHERE source_order_id = ?`, [id]).map(r => r.id as string);
    db.run(`UPDATE purchases SET source_order_id = NULL WHERE source_order_id = ?`, [id]);
    db.run(`DELETE FROM order_lines WHERE order_id = ?`, [id]);
    db.run(`DELETE FROM orders WHERE id = ?`, [id]);
    saveDatabase();
    trackDelete('orders', id);
    for (const plId of plUnlinkedIds) trackChange('purchase_lines', plId, 'update', {});
    for (const pId of purUnlinkedIds) trackChange('purchases', pId, 'update', {});
    get().loadOrders();
  },
}));
