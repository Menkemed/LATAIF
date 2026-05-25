import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { Consignment, ConsignmentStatus, TaxScheme } from '@/core/models/types';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId, getNextNumber, getNextDocumentNumber } from '@/core/db/helpers';
import { eventBus } from '@/core/events/event-bus';
import { trackInsert, trackUpdate, trackDelete } from '@/core/sync/track';
import { postConsignmentPayout, postCreditNote, hasLedgerEntries, hasReversalFor, reverseSource } from '@/core/ledger/posting';
import type { CreditNote } from '@/core/models/types';
import { useSupplierStore } from './supplierStore';
import { useInvoiceStore } from './invoiceStore';
import { usePurchaseStore } from './purchaseStore';
import { useExpenseStore } from './expenseStore';
import { vatEngine } from '@/core/tax/vat-engine';

// ZIEL.md §3a — Posting-Service ist der einzige Schreibpfad für Finanzbuchungen.
function safePost(label: string, fn: () => void): void {
  try { fn(); } catch (err) {
    console.error(`[ledger] ${label} failed:`, err);
  }
}

// Plan 2026-05 §Consignment: Consignor lebt in customers (für Customer-Facing-Use),
// die Auszahlung läuft aber als Purchase die einen Supplier braucht. Mapping per
// (Name + Phone). Beim ersten Verkauf wird der Supplier-Mirror angelegt — gleiche
// Person, zwei Rollen (Customer + Supplier mit gleichem Namen).
//
// Direkter SQL-Lookup (statt Store-State) damit der Helper unabhängig von
// loadCustomers/loadSuppliers-Reihenfolge oder HMR-Modul-Duplikaten funktioniert.
export function findOrCreateSupplierForConsignor(consignorCustomerId: string): string {
  const custRows = query(
    `SELECT first_name, last_name, phone, email, branch_id FROM customers WHERE id = ?`,
    [consignorCustomerId]
  );
  if (custRows.length === 0) {
    throw new Error(`Consignor customer ${consignorCustomerId} not found — cannot resolve supplier`);
  }
  const c = custRows[0];
  const fullName = `${(c.first_name as string) || ''} ${(c.last_name as string) || ''}`.trim();
  const phone = ((c.phone as string) || '').trim();
  const branchId = (c.branch_id as string) || currentBranchId();

  // Match-Strategie: Phone primär (eindeutig), Name als Fallback. Vermeidet Duplikate
  // wenn der gleiche Consignor schon mal als Supplier angelegt wurde (manuell oder
  // durch früheres recordSale).
  if (phone) {
    const byPhone = query(
      `SELECT id FROM suppliers WHERE branch_id = ? AND TRIM(phone) = ? LIMIT 1`,
      [branchId, phone]
    );
    if (byPhone.length > 0) return byPhone[0].id as string;
  }
  if (fullName) {
    const byName = query(
      `SELECT id FROM suppliers WHERE branch_id = ? AND LOWER(TRIM(name)) = ? LIMIT 1`,
      [branchId, fullName.toLowerCase()]
    );
    if (byName.length > 0) return byName[0].id as string;
  }

  // Kein Match → neuen Supplier anlegen via SupplierStore (postet nichts ins Ledger,
  // nur Domain-Insert + branch_id-Handling).
  const created = useSupplierStore.getState().createSupplier({
    name: fullName || 'Unnamed Consignor',
    phone: (c.phone as string) || undefined,
    email: (c.email as string) || undefined,
    notes: `Auto-created from consignor (customer ${consignorCustomerId})`,
  });
  return created.id;
}

// Neuer Sold-Flow (2026-05): Sold → Auto-Invoice (Käufer) + Auto-Purchase
// (Consignor) + optionale Consignor-Loss-Expense bei Sale unter Agreed Price
// (nur Model 2). Ersetzt markSold/markPaidOut Kombi — Bezahlung läuft jetzt
// über die normalen Invoice-Payment + Purchase-Payment + Expense-Payment-Pfade.
export interface RecordSaleParams {
  salePrice: number;
  buyerId: string;                     // jetzt PFLICHT — Invoice braucht Customer
  saleDate?: string;                   // YYYY-MM-DD, default heute
  notes?: string;
  acknowledgeShortfall?: boolean;      // Model 2 + sub-agreed → Bestätigung Pflicht
  specialMark?: boolean;               // 2026-05-16 — Number-Type fuer erzeugte Invoice
}

export interface RecordSaleResult {
  invoiceId: string;
  purchaseId: string;
  expenseId?: string;                  // nur wenn Consignor-Loss erzeugt wurde
  consignorLossAmount: number;         // 0 wenn kein Verlust
  consignorPayout: number;
  ourCommission: number;
}

interface ConsignmentStore {
  consignments: Consignment[];
  loading: boolean;
  loadConsignments: () => void;
  getConsignment: (id: string) => Consignment | undefined;
  createConsignment: (data: Partial<Consignment> & { productData?: Record<string, unknown> }) => Consignment;
  updateConsignment: (id: string, data: Partial<Consignment>) => void;
  // Legacy single-step Sold (DEPRECATED — wird durch recordSale ersetzt).
  // Bleibt vorerst funktional, damit alte UIs nicht brechen. Entfernen sobald
  // alle Call-Sites migriert sind.
  markSold: (id: string, salePrice: number, buyerId?: string, saleMethod?: 'cash' | 'bank') => void;
  // Neuer atomic Sold-Flow: Auto-Invoice + Auto-Purchase + optional Consignor-Loss.
  recordSale: (id: string, params: RecordSaleParams) => RecordSaleResult;
  // Vollständige Sale-Stornierung (Plan 2026-05): reverst Invoice + Auto-Purchase
  // + Loss-Expense (alle 3 Records die recordSale erzeugt) und setzt das
  // Consignment zurück auf 'active'. Für „Verkauf war ein Fehler"-Fälle wie
  // Buyer == Consignor.
  cancelSale: (id: string) => void;
  markPaidOut: (id: string, method: string, reference?: string) => void;
  // Plan §8 #2 — Partial Payouts. Akkumuliert bis payoutAmount erreicht ist.
  recordPartialPayout: (id: string, amount: number, method: string, reference?: string) => void;
  markReturned: (id: string) => void;
  // Plan §Commission §13: Return nach Verkauf (Endkunde bringt zurück).
  // Option A: RETURN_TO_OWNER (Ware verlässt System), Option B: KEEP_AS_OWN (wird eigene Ware).
  markReturnedAfterSale: (id: string, disposition: 'RETURN_TO_OWNER' | 'KEEP_AS_OWN') => void;
  deleteConsignment: (id: string) => void;
}

function rowToConsignment(row: Record<string, unknown>): Consignment {
  return {
    id: row.id as string,
    consignmentNumber: row.consignment_number as string,
    consignorId: row.consignor_id as string,
    productId: row.product_id as string,
    agreedPrice: (row.agreed_price as number) || 0,
    minimumPrice: row.minimum_price as number | undefined,
    commissionType: (row.commission_type as 'percent' | 'fixed' | 'consignor_fixed' | 'cost_split' | undefined) || 'percent',
    commissionValue: row.commission_value as number | undefined,
    commissionRate: (row.commission_rate as number) || 15,
    commissionAmount: row.commission_amount as number | undefined,
    excessSplitPct: row.excess_split_pct as number | undefined,
    payoutAmount: row.payout_amount as number | undefined,
    payoutPaidAmount: (row.payout_paid_amount as number) || 0,
    payoutStatus: (row.payout_status as Consignment['payoutStatus']) || 'pending',
    payoutMethod: row.payout_method as string | undefined,
    saleMethod: (row.sale_method as 'cash' | 'bank' | null) ?? null,
    payoutDate: row.payout_date as string | undefined,
    payoutReference: row.payout_reference as string | undefined,
    status: (row.status as ConsignmentStatus) || 'active',
    agreementDate: row.agreement_date as string,
    expiryDate: row.expiry_date as string | undefined,
    salePrice: row.sale_price as number | undefined,
    buyerId: row.buyer_id as string | undefined,
    invoiceId: row.invoice_id as string | undefined,
    notes: row.notes as string | undefined,
    staffId: (row.staff_id as string) || undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    createdBy: row.created_by as string | undefined,
  };
}

export const useConsignmentStore = create<ConsignmentStore>((set, get) => ({
  consignments: [],
  loading: false,

  loadConsignments: () => {
    try {
      const branchId = currentBranchId();
      const rows = query('SELECT * FROM consignments WHERE branch_id = ? ORDER BY created_at DESC', [branchId]);
      set({ consignments: rows.map(rowToConsignment), loading: false });
    } catch { set({ consignments: [], loading: false }); }
  },

  getConsignment: (id) => get().consignments.find(c => c.id === id),

  createConsignment: (data) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const id = uuid();
    let branchId: string, userId: string;
    try { branchId = currentBranchId(); userId = currentUserId(); }
    catch { branchId = 'branch-main'; userId = 'user-owner'; }

    const consignmentNumber = getNextNumber('consignments', 'consignment.number_prefix', 'CON');

    // Update product status to consignment
    if (data.productId) {
      // Plan §Commission §4: source_type = CONSIGNMENT beim Intake
      db.run(`UPDATE products SET stock_status = 'consignment', source_type = 'CONSIGNMENT', updated_at = ? WHERE id = ?`, [now, data.productId]);

      // 2026-05-16 — Erwarteten Cost beim Intake setzen, damit die Product-Detail-
      // Seite nicht "Cost: 0 BHD" zeigt solange noch kein Auto-Purchase existiert.
      // Formel:
      //   - percent  → agreedPrice * (1 - rate/100)   (Anteil der dem Consignor zusteht)
      //   - consignor_fixed (= Agreed+Excess) → agreedPrice (Garantie an den Consignor)
      // Wird nur gesetzt wenn aktuell 0 (placeholder), damit echte Cost-Daten
      // (z.B. nach echtem Sale via recordSale) nicht ueberschrieben werden.
      const agreed = Number(data.agreedPrice) || 0;
      const rate = Number(data.commissionRate ?? 15);
      const ctype = (data.commissionType || 'percent') as string;
      // v0.7.10 — cost_split: expected cost = consignor's cost floor (= agreedPrice),
      // analog zu consignor_fixed. Excess wird ggf. spaeter beim Sale gesplittet,
      // aendert aber nicht den Erwartungswert beim Intake.
      const expectedCost = (ctype === 'consignor_fixed' || ctype === 'cost_split')
        ? agreed
        : Math.max(0, agreed * (1 - rate / 100));
      if (expectedCost > 0) {
        db.run(
          `UPDATE products SET purchase_price = ? WHERE id = ? AND COALESCE(purchase_price, 0) = 0`,
          [expectedCost, data.productId]
        );
      }
    }

    db.run(
      `INSERT INTO consignments (id, branch_id, consignment_number, consignor_id, product_id,
        agreed_price, minimum_price, commission_rate, commission_type, commission_value,
        excess_split_pct,
        status, agreement_date, expiry_date,
        notes, staff_id, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
      [id, branchId, consignmentNumber, data.consignorId, data.productId,
       data.agreedPrice || 0, data.minimumPrice || null,
       data.commissionRate || 15,
       data.commissionType || 'percent',
       data.commissionValue ?? null,
       // Nur fuer cost_split persistieren; sonst NULL (kein Drift in der Semantik
       // bei anderen Modi).
       data.commissionType === 'cost_split' ? (data.excessSplitPct ?? 50) : null,
       data.agreementDate || now.split('T')[0], data.expiryDate || null,
       data.notes || null, data.staffId || null, now, now, userId]
    );

    saveDatabase();
    trackInsert('consignments', id, { consignmentNumber, consignorId: data.consignorId });
    eventBus.emit('consignment.created', 'consignment', id, { consignorId: data.consignorId });
    get().loadConsignments();
    return get().getConsignment(id)!;
  },

  updateConsignment: (id, data) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const fields: string[] = [];
    const values: unknown[] = [];
    const map: Record<string, string> = {
      consignorId: 'consignor_id', agreedPrice: 'agreed_price', minimumPrice: 'minimum_price',
      commissionRate: 'commission_rate', commissionType: 'commission_type', commissionValue: 'commission_value',
      expiryDate: 'expiry_date', notes: 'notes',
      status: 'status', salePrice: 'sale_price', commissionAmount: 'commission_amount',
      payoutAmount: 'payout_amount', payoutStatus: 'payout_status',
      payoutPaidAmount: 'payout_paid_amount',
      payoutMethod: 'payout_method', payoutDate: 'payout_date', payoutReference: 'payout_reference',
      saleMethod: 'sale_method',
      // Plan 2026-05 §Sold-Flow: Buyer + Invoice-Verlinkung muss persistieren,
      // sonst zeigt /consignment/:id keine Invoice und der Sold-Flow ist unvollständig.
      buyerId: 'buyer_id', invoiceId: 'invoice_id',
      staffId: 'staff_id',
    };
    for (const [k, v] of Object.entries(data)) {
      const col = map[k]; if (col) { fields.push(`${col} = ?`); values.push(v ?? null); }
    }
    if (fields.length === 0) return;
    fields.push('updated_at = ?'); values.push(now); values.push(id);
    db.run(`UPDATE consignments SET ${fields.join(', ')} WHERE id = ?`, values);
    saveDatabase();
    trackUpdate('consignments', id, data);
    get().loadConsignments();
  },

  markSold: (id, salePrice, buyerId, saleMethod) => {
    const con = get().getConsignment(id);
    if (!con) return;
    let payout: number;
    let commission: number;
    if (con.commissionType === 'consignor_fixed') {
      payout = con.commissionValue || 0;
      commission = salePrice - payout;
    } else if (con.commissionType === 'cost_split') {
      // v0.7.10 — wird vom neuen recordSale-Pfad bevorzugt verwendet, aber
      // markSold (Legacy) muss konsistent rechnen: Profit ueber Cost gemaess
      // shopPct splitten.
      const cost = con.agreedPrice || 0;
      const shopPct = con.excessSplitPct ?? 50;
      if (salePrice >= cost) {
        const profit = salePrice - cost;
        commission = profit * (shopPct / 100);
        payout = cost + profit * ((100 - shopPct) / 100);
      } else {
        payout = cost;
        commission = salePrice - cost; // negative = Verlust
      }
    } else if (con.commissionType === 'fixed') {
      commission = con.commissionValue || 0;
      payout = salePrice - commission;
    } else {
      commission = salePrice * (con.commissionRate / 100);
      payout = salePrice - commission;
    }
    get().updateConsignment(id, {
      status: 'sold', salePrice, buyerId,
      commissionAmount: commission, payoutAmount: payout,
      saleMethod: saleMethod ?? null,
    });
    // Update product — quantity-aware.
    const db = getDatabase();
    db.run(
      `UPDATE products SET
         quantity = CASE WHEN COALESCE(quantity,1) > 1 THEN COALESCE(quantity,1) - 1 ELSE 0 END,
         stock_status = CASE WHEN COALESCE(quantity,1) > 1 THEN stock_status ELSE 'sold' END,
         updated_at = ? WHERE id = ?`,
      [new Date().toISOString(), con.productId]);
    saveDatabase();
    eventBus.emit('consignment.sold', 'consignment', id, { salePrice, commission, payout });
  },

  // ── Neuer Sold-Flow: Auto-Invoice + Auto-Purchase + (optional) Consignor-Loss-Expense.
  // Plan 2026-05: Eine Wahrheit pro Verpflichtung — Invoice = Käufer-AR,
  // Purchase = Consignor-AP, Expense = Loss-Tracking. Bezahlung läuft über
  // die normalen Zahlungspfade (Invoice-Payment, Purchase-Payment, Expense-Payment).
  recordSale: (id, params) => {
    const con = get().getConsignment(id);
    if (!con) throw new Error(`Consignment ${id} not found`);
    if (con.status !== 'active') {
      throw new Error(`Consignment ${con.consignmentNumber} is ${con.status} — cannot record sale`);
    }
    if (!params.buyerId) throw new Error('Buyer is required (Invoice needs a customer)');
    if (!Number.isFinite(params.salePrice) || params.salePrice <= 0) {
      throw new Error('Sale price must be positive');
    }
    // Plan 2026-05: Buyer != Consignor. Wenn der Consignor seine eigene Ware
    // „kauft", ist das wirtschaftlich kein Verkauf, sondern eine Rückgabe —
    // die müsste über den Return-Flow laufen. Wir blocken hier strikt, sonst
    // entstehen sinnlose AR/AP-Posts gegen denselben Kontakt.
    if (params.buyerId === con.consignorId) {
      throw new Error(
        'Buyer cannot be the same as the consignor. ' +
        'If the consignor is taking the item back, use "Return" instead — ' +
        'no sale, no invoice, no purchase needed.'
      );
    }

    const isAgreedExcess = con.commissionType === 'consignor_fixed';
    const isCostSplit = con.commissionType === 'cost_split';
    const isPercent = con.commissionType === 'percent' || !con.commissionType;
    if (!isAgreedExcess && !isPercent && !isCostSplit) {
      throw new Error(`Unsupported commission type "${con.commissionType}" — use percent / consignor_fixed / cost_split`);
    }

    // Payout/Loss berechnen
    let consignorPayout: number;
    let ourCommission: number;
    let consignorLoss = 0;
    if (isPercent) {
      ourCommission = params.salePrice * ((con.commissionRate || 0) / 100);
      consignorPayout = params.salePrice - ourCommission;
    } else if (isCostSplit) {
      // v0.7.10 — cost_split: consignor nennt seinen Kost (= agreedPrice),
      // alles drueber wird mit excessSplitPct (shop %) gesplittet. Below cost
      // analog zu consignor_fixed (Garantie + Loss-Expense), damit sich der
      // Modus konsistent verhaelt mit dem User-Mental-Modell "ich kriege
      // mindestens meinen Kost zurueck".
      const cost = con.agreedPrice || 0;
      const shopPct = con.excessSplitPct ?? 50;
      if (params.salePrice >= cost) {
        const profit = params.salePrice - cost;
        ourCommission = profit * (shopPct / 100);
        consignorPayout = cost + profit * ((100 - shopPct) / 100);
      } else {
        if (!params.acknowledgeShortfall) {
          throw new Error(
            `Sale ${params.salePrice} below consignor's cost ${cost}. Confirm shortfall (acknowledgeShortfall=true) — will be recorded as Consignor Loss expense.`
          );
        }
        consignorPayout = cost;
        consignorLoss = cost - params.salePrice;
        ourCommission = -consignorLoss;
      }
    } else {
      // Model 2: Agreed Price + Excess to us
      const agreed = con.agreedPrice || 0;
      if (params.salePrice >= agreed) {
        consignorPayout = agreed;
        ourCommission = params.salePrice - agreed;
      } else {
        // Sale UNTER Agreed → Variante B: Consignor-Loss-Expense
        if (!params.acknowledgeShortfall) {
          throw new Error(
            `Sale ${params.salePrice} below agreed ${agreed}. Confirm shortfall (acknowledgeShortfall=true) — will be recorded as Consignor Loss expense.`
          );
        }
        consignorPayout = agreed;                      // volle Garantie
        consignorLoss = agreed - params.salePrice;     // Differenz = Loss
        ourCommission = -consignorLoss;                // negative Marge
      }
    }

    // Tax-Scheme + VAT-Berechnung für Buyer-Invoice (ähnlich agentStore convertTransferToInvoice)
    const prodRows = query(
      `SELECT id, tax_scheme, purchase_price, brand, name FROM products WHERE id = ?`,
      [con.productId]
    );
    const prod = prodRows[0];
    const scheme = ((prod?.tax_scheme as TaxScheme | undefined) || 'MARGIN') as TaxScheme;
    const purchasePrice = (prod?.purchase_price as number | undefined) || consignorPayout;
    const rate = scheme === 'ZERO' ? 0 : 10;
    const grossSale = params.salePrice;
    const netInput = scheme === 'VAT_10' ? grossSale / (1 + rate / 100) : grossSale;
    const calc = vatEngine.calculateNet(netInput, purchasePrice, scheme, rate);
    // v0.7.1 — NBR: MARGIN persistiert internalVat.
    const persistedVat = calc.internalVatAmount ?? calc.vatAmount;

    // 1. Find-or-Create Supplier für den Consignor (1 Person, 2 Rollen)
    const consignorSupplierId = findOrCreateSupplierForConsignor(con.consignorId);

    // 2. Consignor-Purchase ZUERST anlegen — sonst hat das Consignment-Produkt
    // beim Invoice-Insert noch keinen Stock-Lot, und der FIFO-Auto-Pick in
    // createDirectInvoice findet nichts. Reihenfolge: Purchase (= Lot entsteht)
    // → Invoice (= Lot wird konsumiert + Cost-Snapshot zieht lot.unit_cost).
    //
    // Bei Shortfall: Purchase = echter Marktwert (= Sale Price), Loss läuft separat als Expense.
    // Bei normalem/excess Sale: Purchase = consignorPayout (was Frau Y wirklich kriegt).
    const purchaseAmount = consignorLoss > 0 ? params.salePrice : consignorPayout;
    const purch = usePurchaseStore.getState();
    const purchase = purch.createPurchase({
      supplierId: consignorSupplierId,
      purchaseDate: params.saleDate || new Date().toISOString().split('T')[0],
      notes: `Consignor payout · ${con.consignmentNumber}${params.notes ? ' · ' + params.notes : ''}`,
      lines: [{
        productId: con.productId,
        quantity: 1,
        unitPrice: purchaseAmount,
        taxScheme: 'ZERO',                  // Privatperson → keine Vorsteuer
        vatRate: 0,
      }],
    });

    // 2b. Cost-Snapshot auf das Produkt selbst schreiben — Consignment-Produkte
    // werden mit purchase_price=0 angelegt; ohne diese Zeile bleibt der Cost
    // auf der Product-Detail-Seite auf 0 obwohl der Auto-Purchase einen Lot
    // mit echtem unit_cost erzeugt hat. Wir ueberschreiben nur wenn aktuell
    // 0 (= placeholder), damit echte Cost-Daten nicht ueberschrieben werden.
    const db0 = getDatabase();
    db0.run(
      `UPDATE products SET purchase_price = ? WHERE id = ? AND COALESCE(purchase_price, 0) = 0`,
      [purchaseAmount, con.productId]
    );

    // 3. Buyer-Invoice — auto-FIFO im createDirectInvoice findet den frisch
    // angelegten Lot aus Schritt 2 und konsumiert ihn.
    const inv = useInvoiceStore.getState();
    const invoice = inv.createDirectInvoice(
      params.buyerId,
      [{
        productId: con.productId,
        unitPrice: calc.netAmount,
        purchasePrice,
        taxScheme: scheme,
        vatRate: rate,
        vatAmount: persistedVat,
        lineTotal: calc.grossAmount,
      }],
      `Consignment sale · ${con.consignmentNumber}`,
      undefined,
      undefined,
      undefined,
      params.specialMark,
    );

    // 4. Bei Shortfall: Consignor-Loss-Expense (Variante B)
    let expenseId: string | undefined;
    if (consignorLoss > 0) {
      const exp = useExpenseStore.getState();
      const expense = exp.createExpense({
        category: 'ConsignorLoss',
        amount: consignorLoss,
        supplierId: consignorSupplierId,
        paymentMethod: 'cash',
        description: `Consignor guarantee shortfall · ${con.consignmentNumber} · sold ${params.salePrice} BHD vs agreed ${con.agreedPrice} BHD`,
        expenseDate: params.saleDate || new Date().toISOString().split('T')[0],
        relatedModule: 'consignment',
        relatedEntityId: id,
        // WICHTIG: payNow=false → bleibt PENDING. Sonst zieht createExpense
        // sofort Cash/Bank ab. Wir wollen aber AP zur Frau Y aufbauen, die
        // dann via Banking gezahlt wird (zusammen mit Purchase-AP).
        payNow: false,
      });
      expenseId = expense.id;
    }

    // 5. Consignment-Status + Verlinkungen
    get().updateConsignment(id, {
      status: 'sold',
      salePrice: params.salePrice,
      buyerId: params.buyerId,
      commissionAmount: ourCommission,
      payoutAmount: consignorPayout,
      invoiceId: invoice.id,
    });

    // 6. Produkt: NUR quantity dekrementieren + last_sale_price merken.
    // Plan §Sales §Partial-Payment-Reservation (2026-05-16): stock_status NICHT
    // mehr explizit auf 'sold' setzen — der Invoice-Flow markiert das Produkt
    // automatisch korrekt: 'consignment' → 'consignment_reserved' (PARTIAL) →
    // 'sold' (FINAL via invoice.paid event). Ein hartes 'sold' hier wuerde
    // den Reserved-Lifecycle ueberspringen, sodass ein Teilzahlungs-Verkauf
    // sofort als komplett bezahlt aussieht.
    const db = getDatabase();
    db.run(
      `UPDATE products SET
         quantity = CASE WHEN COALESCE(quantity,1) > 1 THEN COALESCE(quantity,1) - 1 ELSE 0 END,
         last_sale_price = ?, updated_at = ? WHERE id = ?`,
      [params.salePrice, new Date().toISOString(), con.productId]
    );
    saveDatabase();

    eventBus.emit('consignment.sale_recorded', 'consignment', id, {
      invoiceId: invoice.id,
      purchaseId: purchase.id,
      expenseId,
      consignorPayout,
      ourCommission,
      consignorLoss,
    });

    return {
      invoiceId: invoice.id,
      purchaseId: purchase.id,
      expenseId,
      consignorLossAmount: consignorLoss,
      consignorPayout,
      ourCommission,
    };
  },

  // ── Cancel Sale: vollständiges Undo des recordSale-Flows ────────────────
  // Reverst Invoice + Auto-Purchase + Loss-Expense (falls vorhanden) und setzt
  // das Consignment zurück auf 'active'. Für „Verkauf war ein Fehler"-Cases.
  cancelSale: (id) => {
    const con = get().getConsignment(id);
    if (!con) throw new Error(`Consignment ${id} not found`);
    // Plan 2026-05: Cancel funktioniert für sold UND returned (= post-sale-return
    // wurde schon ausgelöst, aber die Auto-Purchase + Loss-Expense aus dem
    // recordSale-Flow hängen noch). Dann cleant Cancel-Sale die Reste auf.
    if (con.status !== 'sold' && con.status !== 'returned') {
      throw new Error(`Consignment ${con.consignmentNumber} is "${con.status}" — only sold/returned consignments can be cancelled.`);
    }

    const db = getDatabase();
    const now = new Date().toISOString();

    // 0. Post-Sale-Return-Artefakte cleanen — wenn der User vorher ueber
    // markReturnedAfterSale ein Sales-Return + Credit Note erzeugt hat, haengen
    // diese sonst nach dem Cancel weiter (CN-Ledger-Posts bleiben aktiv → Phantom
    // CASH/REVENUE-Bewegungen). Wir reversen die CN im Ledger und loeschen die
    // CN- + Sales-Return-Records, damit die Invoice-Cancel sauber durchlaufen kann.
    if (con.invoiceId) {
      try {
        const cnRows = query(
          `SELECT id FROM credit_notes
           WHERE invoice_id = ? AND reason LIKE ?`,
          [con.invoiceId, `Consignment post-sale return (${con.consignmentNumber})%`]
        );
        for (const row of cnRows) {
          const cnId = row.id as string;
          try {
            if (hasLedgerEntries('CREDIT_NOTE', cnId) && !hasReversalFor('CREDIT_NOTE', cnId)) {
              reverseSource('CREDIT_NOTE', cnId, now);
            }
          } catch (e) {
            console.warn('[cancelSale] CN reversal failed:', e);
          }
          // sales_return + lines + CN-row entfernen (dem User-Geist nach: nie passiert).
          const srRow = query(`SELECT sales_return_id FROM credit_notes WHERE id = ?`, [cnId])[0];
          const srId = srRow?.sales_return_id as string | undefined;
          db.run(`DELETE FROM credit_notes WHERE id = ?`, [cnId]);
          if (srId) {
            db.run(`DELETE FROM sales_return_lines WHERE return_id = ?`, [srId]);
            db.run(`DELETE FROM sales_returns WHERE id = ?`, [srId]);
          }
        }
      } catch (e) {
        console.warn('[cancelSale] post-sale-return cleanup failed:', e);
      }
    }

    // 1. Linked Invoice cancellen — der invoiceStore.updateInvoice triggert
    // Ledger-Reversal (postInvoiceCancelled), CN/Loss-Cleanup, Offer-Reset.
    if (con.invoiceId) {
      try {
        useInvoiceStore.getState().updateInvoice(con.invoiceId, { status: 'CANCELLED' });
      } catch (e) {
        console.warn('[cancelSale] invoice cancel failed:', e);
      }
    }

    // 2. Linked Auto-Purchase cancellen (direct SQL lookup, dann
    // purchaseStore.cancelPurchase für Status + Ledger-Reversal). Direkter
    // SQL statt store.purchases damit Re-Loads/HMR-Edge-Cases nicht stören.
    try {
      const purRows = query(
        `SELECT id FROM purchases WHERE notes LIKE ? AND status != 'CANCELLED' LIMIT 1`,
        [`%${con.consignmentNumber}%`]
      );
      if (purRows.length > 0) {
        const purchaseId = purRows[0].id as string;
        usePurchaseStore.getState().cancelPurchase(purchaseId);
      }
    } catch (e) {
      console.warn('[cancelSale] purchase cancel failed:', e);
    }

    // 3. Linked Loss-Expense cancellen (direct SQL lookup, dann updateExpense
    // für Status + postExpenseCancelled).
    try {
      const expRows = query(
        `SELECT id FROM expenses
         WHERE related_module = 'consignment' AND related_entity_id = ?
           AND category = 'ConsignorLoss' AND status != 'CANCELLED'
         LIMIT 1`,
        [id]
      );
      if (expRows.length > 0) {
        const expenseId = expRows[0].id as string;
        useExpenseStore.getState().updateExpense(expenseId, { status: 'CANCELLED' });
      }
    } catch (e) {
      console.warn('[cancelSale] loss-expense cancel failed:', e);
    }

    // 4. Consignment zurück auf 'active', Sale-Felder leeren.
    db.run(
      `UPDATE consignments SET
         status = 'active',
         sale_price = NULL,
         buyer_id = NULL,
         invoice_id = NULL,
         commission_amount = NULL,
         payout_amount = NULL,
         payout_paid_amount = 0,
         payout_status = 'pending',
         sale_method = NULL,
         updated_at = ?
       WHERE id = ?`,
      [now, id]
    );

    // 5. Produkt zurück auf consignment-stock.
    db.run(
      `UPDATE products SET stock_status = 'consignment', source_type = 'CONSIGNMENT', updated_at = ? WHERE id = ?`,
      [now, con.productId]
    );

    saveDatabase();
    trackUpdate('consignments', id, { status: 'active', cancelledSale: true });
    eventBus.emit('consignment.sale_cancelled', 'consignment', id, { previousInvoiceId: con.invoiceId });
    get().loadConsignments();
  },

  markPaidOut: (id, method, reference) => {
    const con = get().getConsignment(id);
    const full = con?.payoutAmount || 0;
    const alreadyPaid = con?.payoutPaidAmount || 0;
    const delta = Math.max(0, full - alreadyPaid);
    const payoutDate = new Date().toISOString().split('T')[0];
    get().updateConsignment(id, {
      status: 'paid_out', payoutStatus: 'paid',
      payoutPaidAmount: full,
      payoutMethod: method, payoutDate,
      payoutReference: reference,
    });
    eventBus.emit('consignment.paid_out', 'consignment', id, {});

    // ZIEL.md §3a — nur den Delta posten (was JETZT gezahlt wird), Vorzahlungen
    // sind bereits über recordPartialPayout im Ledger.
    if (con && delta > 0) {
      const ledgerMethod: 'cash' | 'bank' = method === 'cash' ? 'cash' : 'bank';
      const synthId = uuid();
      safePost(`postConsignmentPayout(${synthId}) [markPaidOut]`, () => {
        if (hasLedgerEntries('CONSIGNMENT_PAYOUT', synthId)) return;
        postConsignmentPayout({
          id: synthId, consignmentId: id, consignorId: con.consignorId,
          amount: delta, method: ledgerMethod, paidAt: payoutDate,
        });
      });
    }
  },

  // Plan §8 #2 — Teilausgleich. Mehrfach aufrufbar bis payoutAmount erreicht.
  recordPartialPayout: (id, amount, method, reference) => {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('Consignment payout amount must be a positive number.');
    }
    const con = get().getConsignment(id);
    if (!con) return;
    const target = con.payoutAmount || 0;
    const newPaid = target > 0 ? Math.min(target, (con.payoutPaidAmount || 0) + amount) : (con.payoutPaidAmount || 0) + amount;
    const appliedAmount = newPaid - (con.payoutPaidAmount || 0);  // tatsächlich neu gezahlt (geclamped)
    const fully = target > 0 && newPaid >= target - 0.005;
    const newPayoutStatus: Consignment['payoutStatus'] = fully ? 'paid' : (newPaid > 0 ? 'partial' : 'pending');
    const newStatus = fully ? 'paid_out' : con.status;
    const payoutDate = new Date().toISOString().split('T')[0];
    get().updateConsignment(id, {
      status: newStatus,
      payoutStatus: newPayoutStatus,
      payoutPaidAmount: newPaid,
      payoutMethod: method,
      payoutDate,
      payoutReference: reference,
    });
    if (fully) eventBus.emit('consignment.paid_out', 'consignment', id, {});

    // ZIEL.md §3a — Cash-Bewegung an Consignor.
    if (appliedAmount > 0) {
      const ledgerMethod: 'cash' | 'bank' = method === 'cash' ? 'cash' : 'bank';
      const synthId = uuid();
      safePost(`postConsignmentPayout(${synthId}) [partial]`, () => {
        if (hasLedgerEntries('CONSIGNMENT_PAYOUT', synthId)) return;
        postConsignmentPayout({
          id: synthId, consignmentId: id, consignorId: con.consignorId,
          amount: appliedAmount, method: ledgerMethod, paidAt: payoutDate,
        });
      });
    }
  },

  markReturned: (id) => {
    const con = get().getConsignment(id);
    if (!con) return;
    const db = getDatabase();
    // Plan §Commission §12: Ware NICHT verkauft → zurück an Besitzer.
    // Produkt verlässt System (stock_status = returned).
    db.run(`UPDATE products SET stock_status = 'returned', updated_at = ? WHERE id = ?`,
      [new Date().toISOString(), con.productId]);
    // Status-String bleibt lowercase 'returned' für Backward-Compat zu UI-Filtern.
    get().updateConsignment(id, { status: 'returned', payoutStatus: 'returned' });
    saveDatabase();
    eventBus.emit('consignment.returned', 'consignment', id, {});
  },

  // Plan §Commission §13: Endkunde bringt Ware zurück (nach Verkauf).
  // Erstellt automatisch einen Sales Return (RET) für die ursprüngliche Rechnung mit der gewählten Disposition.
  markReturnedAfterSale: (id, disposition) => {
    const con = get().getConsignment(id);
    if (!con) return;
    const db = getDatabase();
    const now = new Date().toISOString();

    if (!con.invoiceId || !con.salePrice) {
      // Kein Invoice verknüpft oder noch nicht verkauft — Fallback auf normale Rückgabe
      get().markReturned(id);
      return;
    }

    // Finde die Invoice-Line für dieses Produkt
    const lineRows = query(
      `SELECT id, unit_price, vat_amount FROM invoice_lines WHERE invoice_id = ? AND product_id = ?`,
      [con.invoiceId, con.productId]
    );
    if (lineRows.length === 0) {
      get().markReturned(id);
      return;
    }

    let branchId: string, userId: string;
    try { branchId = currentBranchId(); userId = currentUserId(); }
    catch { branchId = 'branch-main'; userId = 'user-owner'; }

    const invRows = query('SELECT customer_id, paid_amount, gross_amount FROM invoices WHERE id = ?', [con.invoiceId]);
    const customerId = invRows[0]?.customer_id as string;
    // Bug-Fix 2026-05: Cash/Receivable-Split anhand der tatsaechlich vom Kunden
    // gezahlten Summe — sonst entsteht eine Phantom-Cash-Auszahlung, wenn die
    // Invoice (z.B. Consignment-Auto-Sale) nie bezahlt wurde. Spiegelt computeRefundSplit
    // aus salesReturnStore (vereinfacht, da consignment-post-sale immer 1:1 zur Invoice).
    const customerPaid = (invRows[0]?.paid_amount as number) || 0;

    // Return-Nummer
    const returnNumber = `RET-${Date.now().toString(36).toUpperCase().slice(-6)}`;
    const returnId = uuid();
    const totalAmount = lineRows.reduce((s, l) => s + ((l.unit_price as number) || 0), 0);
    const vatCorrected = lineRows.reduce((s, l) => s + ((l.vat_amount as number) || 0), 0);

    const cashRefundCap = Math.min(totalAmount, Math.max(0, customerPaid));
    const receivableCancel = Math.max(0, totalAmount - cashRefundCap);
    const refundMethod = cashRefundCap > 0 ? 'cash' : null;

    db.run(
      `INSERT INTO sales_returns (id, branch_id, return_number, invoice_id, customer_id, status, total_amount,
        vat_corrected, return_date, refund_method, refund_amount, product_disposition, notes, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, 'REFUNDED', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [returnId, branchId, returnNumber, con.invoiceId, customerId, totalAmount, vatCorrected,
       now.split('T')[0], refundMethod, cashRefundCap, disposition,
       `Consignment post-sale return (${con.consignmentNumber})`, now, userId]
    );

    for (const l of lineRows) {
      db.run(
        `INSERT INTO sales_return_lines (id, return_id, invoice_line_id, product_id, quantity, unit_price, vat_amount, line_total)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
        [uuid(), returnId, l.id as string, con.productId, (l.unit_price as number) || 0,
         (l.vat_amount as number) || 0, (l.unit_price as number) || 0]
      );
    }

    // Produkt-Disposition
    if (disposition === 'RETURN_TO_OWNER') {
      db.run(`UPDATE products SET stock_status = 'returned', updated_at = ? WHERE id = ?`, [now, con.productId]);
      get().updateConsignment(id, { status: 'returned' });
    } else {
      // KEEP_AS_OWN: purchase_price = sale_price (Plan §13B)
      db.run(
        `UPDATE products SET stock_status = 'in_stock', source_type = 'OWN',
         purchase_price = COALESCE(?, purchase_price), updated_at = ? WHERE id = ?`,
        [con.salePrice ?? null, now, con.productId]
      );
      // Phase 5 — neuer Stock-Lot an Sale-Preis als Acquisition-Cost. Spiegelt
      // die Logik von salesReturnStore.applyDisposition KEEP_AS_OWN. Originaler
      // Lot der Sale-Konsumption bleibt EXHAUSTED — wir haben die Ware effektiv
      // zum Sale-Preis "zurueckgekauft".
      if (con.salePrice && con.salePrice > 0) {
        db.run(
          `INSERT INTO stock_lots
             (id, branch_id, product_id, purchase_id, purchase_line_id,
              unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
           VALUES (?, ?, ?, NULL, NULL, ?, 1, 1, 'ACTIVE', ?, ?)`,
          [uuid(), branchId, con.productId, con.salePrice, now.split('T')[0], now]
        );
      }
      get().updateConsignment(id, { status: 'returned' });
    }

    // Invoice-VAT-Korrektur. paid_amount NICHT mehr abziehen — der Cash-Anteil
    // ist via cashRefundCap im Ledger bereits korrekt verbucht; ein zweites Mal
    // hier paid_amount zu kuerzen wuerde Listenanzeigen ('Remaining') verzerren.
    db.run(
      `UPDATE invoices SET
         vat_amount = MAX(0, vat_amount - ?),
         updated_at = ?
       WHERE id = ?`,
      [vatCorrected, now, con.invoiceId]
    );

    // Synthetische Credit Note + Ledger-Post. Cash/Receivable-Split entspricht
    // der oben berechneten Aufteilung: nur was der Kunde tatsaechlich gezahlt hat,
    // geht als Cash zurueck — der Rest cancelt die Forderung.
    const cnId = uuid();
    const cnNumber = getNextDocumentNumber('CN');
    db.run(
      `INSERT INTO credit_notes (id, branch_id, credit_note_number, invoice_id, customer_id,
         issued_at, total_amount, vat_amount, cash_refund_amount, receivable_cancel_amount,
         refund_method, sales_return_id, reason, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [cnId, branchId, cnNumber, con.invoiceId, customerId, now, totalAmount, vatCorrected,
       cashRefundCap, receivableCancel, refundMethod || 'bank', returnId,
       `Consignment post-sale return (${con.consignmentNumber})`, now, userId]
    );
    trackInsert('credit_notes', cnId, { creditNoteNumber: cnNumber, invoiceId: con.invoiceId, totalAmount });

    saveDatabase();
    trackInsert('sales_returns', returnId, { returnNumber, invoiceId: con.invoiceId, consignmentId: id, disposition });

    const cn: CreditNote = {
      id: cnId,
      creditNoteNumber: cnNumber,
      branchId,
      customerId,
      invoiceId: con.invoiceId,
      salesReturnId: returnId,
      totalAmount,
      vatAmount: vatCorrected,
      cashRefundAmount: cashRefundCap,
      receivableCancelAmount: receivableCancel,
      refundMethod: (refundMethod as 'cash' | undefined) || 'bank',
      reason: `Consignment post-sale return (${con.consignmentNumber})`,
      issuedAt: now,
      createdAt: now,
    };
    safePost(`postCreditNote(${cnId}) [consignment-return]`, () => {
      if (hasLedgerEntries('CREDIT_NOTE', cnId)) return;
      postCreditNote(cn);
    });

    eventBus.emit('consignment.returned', 'consignment', id, { disposition, returnId });
  },

  deleteConsignment: (id) => {
    const db = getDatabase();
    const con = get().getConsignment(id);
    if (con && con.status === 'active') {
      db.run(`UPDATE products SET stock_status = 'in_stock', updated_at = ? WHERE id = ?`,
        [new Date().toISOString(), con.productId]);
    }
    db.run(`DELETE FROM consignments WHERE id = ?`, [id]);
    saveDatabase();
    trackDelete('consignments', id);
    get().loadConsignments();
  },
}));
