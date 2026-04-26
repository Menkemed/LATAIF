import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { Invoice, InvoiceLine, InvoiceStatus, InvoiceTaxScheme, TaxScheme } from '@/core/models/types';
import { vatEngine } from '@/core/tax/vat-engine';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId, getNextDocumentNumber } from '@/core/db/helpers';
import { eventBus } from '@/core/events/event-bus';
import { trackInsert, trackUpdate, trackDelete, trackStatusChange, trackPayment } from '@/core/sync/track';

interface InvoiceStore {
  invoices: Invoice[];
  loading: boolean;
  loadInvoices: () => void;
  getInvoice: (id: string) => Invoice | undefined;
  createInvoiceFromOffer: (offerId: string, perLineSchemes?: Record<string, TaxScheme>) => Invoice;
  createDirectInvoice: (customerId: string, lines: { productId: string; quantity?: number; unitPrice: number; purchasePrice: number; taxScheme: string; vatRate: number; vatAmount: number; lineTotal: number }[], notes?: string) => Invoice;
  updateInvoice: (id: string, data: Partial<Invoice>) => void;
  rewriteInvoiceLines: (id: string, lines: { productId: string; unitPrice: number; purchasePrice: number; taxScheme: string; vatRate: number; vatAmount: number; lineTotal: number; description?: string; quantity?: number }[]) => void;
  recordPayment: (invoiceId: string, amount: number, method: string, notes?: string) => void;
  // Plan §Edit: einzelne Payments später ändern oder löschen.
  updatePayment: (paymentId: string, invoiceId: string, data: { amount?: number; method?: string; notes?: string; receivedAt?: string }) => void;
  deletePayment: (paymentId: string, invoiceId: string) => void;
  getInvoicePayments: (invoiceId: string) => Array<{ id: string; amount: number; method: string; receivedAt: string; notes?: string }>;
  deleteInvoice: (id: string) => void;
  getNextInvoiceNumber: () => string;
}

function rowToInvoice(row: Record<string, unknown>): Invoice {
  return {
    id: row.id as string,
    invoiceNumber: row.invoice_number as string,
    offerId: row.offer_id as string | undefined,
    customerId: row.customer_id as string,
    status: (row.status as InvoiceStatus) || 'DRAFT',
    currency: (row.currency as Invoice['currency']) || 'BHD',
    netAmount: (row.net_amount as number) || 0,
    vatRateSnapshot: (row.vat_rate_snapshot as number) || 0,
    vatAmount: (row.vat_amount as number) || 0,
    grossAmount: (row.gross_amount as number) || 0,
    taxSchemeSnapshot: (row.tax_scheme_snapshot as InvoiceTaxScheme) || 'MARGIN',
    purchasePriceSnapshot: row.purchase_price_snapshot as number | undefined,
    salePriceSnapshot: row.sale_price_snapshot as number | undefined,
    marginSnapshot: row.margin_snapshot as number | undefined,
    paidAmount: (row.paid_amount as number) || 0,
    tipAmount: (row.tip_amount as number) || 0,
    butterfly: Number(row.butterfly) === 1,
    issuedAt: row.issued_at as string | undefined,
    dueAt: row.due_at as string | undefined,
    notes: row.notes as string | undefined,
    lines: [],
    createdAt: row.created_at as string,
    createdBy: row.created_by as string | undefined,
  };
}

function rowToLine(row: Record<string, unknown>): InvoiceLine {
  return {
    id: row.id as string,
    invoiceId: row.invoice_id as string,
    productId: row.product_id as string,
    description: row.description as string | undefined,
    quantity: Math.max(1, (row.quantity as number) || 1),
    unitPrice: (row.unit_price as number) || 0,
    purchasePriceSnapshot: (row.purchase_price_snapshot as number) || 0,
    vatRate: (row.vat_rate as number) || 0,
    taxScheme: (row.tax_scheme as InvoiceLine['taxScheme']) || 'MARGIN',
    vatAmount: (row.vat_amount as number) || 0,
    lineTotal: (row.line_total as number) || 0,
    position: (row.position as number) || 1,
  };
}

export const useInvoiceStore = create<InvoiceStore>((set, get) => ({
  invoices: [],
  loading: false,

  loadInvoices: () => {
    try {
      const branchId = currentBranchId();
      const rows = query('SELECT * FROM invoices WHERE branch_id = ? ORDER BY created_at DESC', [branchId]);
      const invoices = rows.map(r => {
        const inv = rowToInvoice(r);
        const lineRows = query('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY position', [inv.id]);
        inv.lines = lineRows.map(rowToLine);
        return inv;
      });
      set({ invoices, loading: false });
    } catch { set({ invoices: [], loading: false }); }
  },

  getInvoice: (id) => get().invoices.find(i => i.id === id),

  // Plan §Sales §2: Partial Invoice (PINV) bis volle Zahlung; Final Invoice (INV) bei Vollzahlung.
  // Initial-Nummer ist immer PINV (Rechnung startet als PARTIAL). Bei Konvertierung wird eine
  // neue INV-Nummer zugewiesen (siehe recordPayment).
  getNextInvoiceNumber: () => getNextDocumentNumber('PINV'),

  createInvoiceFromOffer: (offerId, perLineSchemes) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const id = uuid();
    let branchId: string, userId: string;
    try { branchId = currentBranchId(); userId = currentUserId(); }
    catch { branchId = 'branch-main'; userId = 'user-owner'; }

    // Get offer data
    const offerRows = query('SELECT * FROM offers WHERE id = ?', [offerId]);
    if (offerRows.length === 0) throw new Error('Offer not found');
    const offer = offerRows[0];

    const offerLineRows = query('SELECT ol.*, p.purchase_price FROM offer_lines ol JOIN products p ON p.id = ol.product_id WHERE ol.offer_id = ?', [offerId]);

    const invoiceNumber = get().getNextInvoiceNumber();
    const dueDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    let totalPurchase = 0;
    let totalSale = 0;
    let sumNet = 0, sumVat = 0, sumGross = 0;
    const vatRate = (offer.vat_rate as number) || 10;

    type OverrideLine = { productId: string; description: string | null; purchasePrice: number; unitPrice: number; vatRate: number; taxScheme: string; vatAmount: number; lineTotal: number; position: number };
    const lines: OverrideLine[] = [];

    for (const l of offerLineRows) {
      const pp = (l.purchase_price as number) || 0;
      const origScheme = (l.tax_scheme as string) || 'MARGIN';
      const offerLineId = l.id as string;
      const overridden = perLineSchemes?.[offerLineId];
      const scheme = overridden || origScheme;

      // Offer lines store unit_price as NET (Plan §Tax §7). Recompute VAT/gross
      // with the (possibly overridden) scheme using the Netto-API.
      const offerNet = (l.unit_price as number) || 0;
      const calc = vatEngine.calculateNet(offerNet, pp, scheme as TaxScheme, vatRate);
      const net = calc.netAmount;
      const vatAmt = calc.vatAmount;
      const gross = calc.grossAmount;

      totalPurchase += pp;
      totalSale += net;
      sumNet += net; sumVat += vatAmt; sumGross += gross;
      lines.push({
        productId: l.product_id as string, description: null,
        purchasePrice: pp, unitPrice: net, vatRate, taxScheme: scheme, vatAmount: vatAmt, lineTotal: gross,
        position: (l.position as number) || 0,
      });
    }

    const finalSchemes = new Set(lines.map(l => l.taxScheme));
    const invoiceScheme: string = finalSchemes.size === 1 ? [...finalSchemes][0] : 'mixed';

    db.run(
      `INSERT INTO invoices (id, branch_id, invoice_number, offer_id, customer_id, status, currency,
        net_amount, vat_rate_snapshot, vat_amount, gross_amount, tax_scheme_snapshot,
        purchase_price_snapshot, sale_price_snapshot, margin_snapshot,
        paid_amount, issued_at, due_at, notes, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, 'PARTIAL', 'BHD', ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?, ?, ?, ?, ?)`,
      [id, branchId, invoiceNumber, offerId, offer.customer_id,
       sumNet, vatRate, sumVat, sumGross,
       invoiceScheme, now, dueDate, offer.notes || null, now, now, userId]
    );

    const lineStmt = db.prepare(
      `INSERT INTO invoice_lines (id, invoice_id, product_id, description, quantity, unit_price, purchase_price_snapshot,
        vat_rate, tax_scheme, vat_amount, line_total, position)
       VALUES (?, ?, ?, NULL, 1, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const l of lines) {
      lineStmt.run([uuid(), id, l.productId, l.unitPrice, l.purchasePrice, l.vatRate, l.taxScheme, l.vatAmount, l.lineTotal, l.position]);
    }
    lineStmt.free();

    const margin = totalSale - totalPurchase;
    db.run(`UPDATE invoices SET purchase_price_snapshot = ?, sale_price_snapshot = ?, margin_snapshot = ? WHERE id = ?`,
      [totalPurchase, totalSale, margin, id]);

    // Update offer status + Plan §8 #10: bidirektionale Verknüpfung (offer.invoice_id).
    db.run(`UPDATE offers SET status = 'accepted', invoice_id = ?, updated_at = ? WHERE id = ?`, [id, now, offerId]);

    saveDatabase();
    trackInsert('invoices', id, { invoiceNumber, customerId: offer.customer_id as string });
    eventBus.emit('invoice.created', 'invoice', id, { offerId, total: offer.total });
    eventBus.emit('invoice.issued', 'invoice', id, {});
    get().loadInvoices();

    return get().getInvoice(id)!;
  },

  createDirectInvoice: (customerId, lines, notes) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const id = uuid();
    let branchId: string, userId: string;
    try { branchId = currentBranchId(); userId = currentUserId(); }
    catch { branchId = 'branch-main'; userId = 'user-owner'; }

    const invoiceNumber = get().getNextInvoiceNumber();
    const dueDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    let netAmount = 0, totalVat = 0, totalPurchase = 0;
    for (const l of lines) {
      const qty = Math.max(1, l.quantity || 1);
      netAmount += l.unitPrice * qty;
      totalVat += l.vatAmount;
      totalPurchase += l.purchasePrice * qty;
    }
    const grossAmount = netAmount + totalVat;
    const margin = netAmount - totalPurchase;

    // Determine tax scheme: if all lines same scheme, use that; otherwise 'mixed'
    const lineSchemes = new Set(lines.map(l => l.taxScheme));
    const taxScheme: string = lineSchemes.size === 1 ? [...lineSchemes][0] : 'mixed';

    db.run(
      `INSERT INTO invoices (id, branch_id, invoice_number, customer_id, status, currency,
        net_amount, vat_rate_snapshot, vat_amount, gross_amount, tax_scheme_snapshot,
        purchase_price_snapshot, sale_price_snapshot, margin_snapshot,
        paid_amount, issued_at, due_at, notes, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, 'PARTIAL', 'BHD', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
      [id, branchId, invoiceNumber, customerId,
       netAmount, lines[0]?.vatRate || 10, totalVat, grossAmount,
       taxScheme, totalPurchase, netAmount, margin, now, dueDate, notes || null, now, now, userId]
    );

    const lineStmt = db.prepare(
      `INSERT INTO invoice_lines (id, invoice_id, product_id, quantity, unit_price, purchase_price_snapshot,
        vat_rate, tax_scheme, vat_amount, line_total, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    lines.forEach((l, i) => {
      const qty = Math.max(1, l.quantity || 1);
      lineStmt.run([uuid(), id, l.productId, qty, l.unitPrice, l.purchasePrice, l.vatRate, l.taxScheme, l.vatAmount, l.lineTotal, i + 1]);
    });
    lineStmt.free();

    saveDatabase();
    trackInsert('invoices', id, { invoiceNumber, customerId });
    eventBus.emit('invoice.created', 'invoice', id, { customerId, grossAmount });
    get().loadInvoices();
    return get().getInvoice(id)!;
  },

  updateInvoice: (id, data) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const fields: string[] = [];
    const values: unknown[] = [];

    const map: Record<string, string> = {
      invoiceNumber: 'invoice_number', status: 'status', notes: 'notes',
      issuedAt: 'issued_at', dueAt: 'due_at', customerId: 'customer_id',
      netAmount: 'net_amount', vatAmount: 'vat_amount', grossAmount: 'gross_amount',
      paidAmount: 'paid_amount', vatRateSnapshot: 'vat_rate_snapshot',
      taxSchemeSnapshot: 'tax_scheme_snapshot',
      purchasePriceSnapshot: 'purchase_price_snapshot',
      salePriceSnapshot: 'sale_price_snapshot', marginSnapshot: 'margin_snapshot',
      butterfly: 'butterfly',
    };

    for (const [k, v] of Object.entries(data)) {
      const col = map[k];
      if (col) {
        fields.push(`${col} = ?`);
        values.push(k === 'butterfly' ? (v ? 1 : 0) : v);
      }
    }
    if (fields.length === 0) return;
    fields.push('updated_at = ?'); values.push(now); values.push(id);
    db.run(`UPDATE invoices SET ${fields.join(', ')} WHERE id = ?`, values);
    saveDatabase();
    trackUpdate('invoices', id, data);

    // Plan §8 #6 — bei Stornierung verknüpfte Auto-Expenses (Card-Fees etc.) als CANCELLED markieren.
    if (data.status === 'CANCELLED') {
      db.run(
        `UPDATE expenses SET status = 'CANCELLED' WHERE related_module = 'invoice' AND related_entity_id = ? AND status != 'CANCELLED'`,
        [id]
      );
      // Plan §8 #10 — zugehöriges Offer zurück auf 'sent' damit Sales neu angehen können.
      db.run(
        `UPDATE offers SET status = 'sent', invoice_id = NULL, updated_at = ? WHERE invoice_id = ?`,
        [now, id]
      );
      saveDatabase();
    }

    if (data.status === 'FINAL') {
      eventBus.emit('invoice.paid', 'invoice', id, {});
    }
    get().loadInvoices();
  },

  rewriteInvoiceLines: (id, lines) => {
    const db = getDatabase();
    const now = new Date().toISOString();

    db.run(`DELETE FROM invoice_lines WHERE invoice_id = ?`, [id]);

    let netAmount = 0, totalVat = 0, totalPurchase = 0;
    const stmt = db.prepare(
      `INSERT INTO invoice_lines (id, invoice_id, product_id, description, quantity, unit_price, purchase_price_snapshot,
        vat_rate, tax_scheme, vat_amount, line_total, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    lines.forEach((l, i) => {
      const qty = Math.max(1, l.quantity || 1);
      stmt.run([uuid(), id, l.productId, l.description || null, qty, l.unitPrice, l.purchasePrice, l.vatRate, l.taxScheme, l.vatAmount, l.lineTotal, i + 1]);
      netAmount += l.unitPrice * qty;
      totalVat += l.vatAmount * qty;
      totalPurchase += l.purchasePrice * qty;
    });
    stmt.free();

    const grossAmount = netAmount + totalVat;
    const margin = netAmount - totalPurchase;
    const schemes = new Set(lines.map(l => l.taxScheme));
    const taxScheme = schemes.size === 1 ? [...schemes][0] : 'mixed';

    db.run(
      `UPDATE invoices SET net_amount = ?, vat_amount = ?, gross_amount = ?,
        purchase_price_snapshot = ?, sale_price_snapshot = ?, margin_snapshot = ?,
        tax_scheme_snapshot = ?, updated_at = ? WHERE id = ?`,
      [netAmount, totalVat, grossAmount, totalPurchase, netAmount, margin, taxScheme, now, id]
    );

    // Recompute tip if newly paid >= gross
    const inv = get().getInvoice(id);
    if (inv) {
      const tip = Math.max(0, inv.paidAmount - grossAmount);
      db.run(`UPDATE invoices SET tip_amount = ? WHERE id = ?`, [tip, id]);
    }

    saveDatabase();
    trackUpdate('invoices', id, { linesReplaced: true, netAmount, grossAmount });
    get().loadInvoices();
  },

  recordPayment: (invoiceId, amount, method, notes) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const paymentId = uuid();
    let branchId: string, userId: string;
    try { branchId = currentBranchId(); userId = currentUserId(); }
    catch { branchId = 'branch-main'; userId = 'user-owner'; }

    db.run(
      `INSERT INTO payments (id, branch_id, invoice_id, amount, method, reference, received_at, notes, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      [paymentId, branchId, invoiceId, amount, method, now, notes || null, now, userId]
    );

    // Plan §Sales §11 + §Expenses §8: Card-Fee wird automatisch als Expense gebucht.
    if (method === 'card' && amount > 0) {
      const rateRow = query(
        `SELECT value FROM settings WHERE branch_id = ? AND key = 'finance.card_fee_rate'`,
        [branchId]
      );
      const feeRate = parseFloat((rateRow[0]?.value as string) || '2.2') || 0;
      const fee = Math.round(amount * feeRate) / 100;
      if (fee > 0) {
        const expenseId = uuid();
        const expenseNumber = getNextDocumentNumber('EXP');
        db.run(
          `INSERT INTO expenses (id, branch_id, expense_number, category, amount, payment_method,
            expense_date, description, related_module, related_entity_id, created_at, created_by)
           VALUES (?, ?, ?, 'CardFees', ?, 'bank', ?, ?, 'invoice', ?, ?, ?)`,
          [expenseId, branchId, expenseNumber, fee, now.split('T')[0],
           `Card fee for payment ${paymentId.slice(0, 8)} (${feeRate}% of ${amount.toFixed(3)} BHD)`,
           invoiceId, now, userId]
        );
        trackInsert('expenses', expenseId, { category: 'CardFees', amount: fee, auto: true, invoiceId });
      }
    }

    // Plan §Sales §12: bei Vollzahlung Auto-Konvertierung Partial → Final.
    // Plan §Sales §3: Nur Final Invoice zählt in Umsatz/Gewinn/Steuer.
    const inv = get().getInvoice(invoiceId);
    if (inv) {
      const newPaid = inv.paidAmount + amount;
      const tip = Math.max(0, newPaid - inv.grossAmount);
      const wasFullyPaid = newPaid >= inv.grossAmount;
      const prevStatus = inv.status;
      const newStatus: InvoiceStatus = wasFullyPaid ? 'FINAL' : 'PARTIAL';

      // Wenn Konvertierung PARTIAL → FINAL: neue INV-Nummer zuweisen
      let newInvoiceNumber = inv.invoiceNumber;
      if (wasFullyPaid && inv.status !== 'FINAL') {
        newInvoiceNumber = getNextDocumentNumber('INV');
      }

      db.run(`UPDATE invoices SET paid_amount = ?, tip_amount = ?, status = ?, invoice_number = ?, updated_at = ? WHERE id = ?`,
        [newPaid, tip, newStatus, newInvoiceNumber, now, invoiceId]);

      if (prevStatus !== newStatus) {
        trackStatusChange('invoices', invoiceId, prevStatus, newStatus);
        if (wasFullyPaid) {
          // Konvertierung loggen (Plan §12)
          trackUpdate('invoices', invoiceId, { convertedToFinal: newInvoiceNumber, previousNumber: inv.invoiceNumber });
        }
      }

      if (wasFullyPaid) {
        eventBus.emit('invoice.paid', 'invoice', invoiceId, { amount: newPaid, tip });
        eventBus.emit('payment.received', 'payment', paymentId, { invoiceId, amount });
      }
    }

    saveDatabase();
    trackInsert('payments', paymentId, { invoiceId, amount, method });
    trackPayment('invoices', invoiceId, amount, method);
    get().loadInvoices();
  },

  deleteInvoice: (id) => {
    const db = getDatabase();
    db.run(`DELETE FROM invoice_lines WHERE invoice_id = ?`, [id]);
    db.run(`DELETE FROM payments WHERE invoice_id = ?`, [id]);
    db.run(`DELETE FROM invoices WHERE id = ?`, [id]);
    saveDatabase();
    trackDelete('invoices', id);
    get().loadInvoices();
  },

  // Liest alle Payments einer Invoice.
  getInvoicePayments: (invoiceId) => {
    try {
      const rows = query(
        `SELECT id, amount, method, received_at, notes FROM payments WHERE invoice_id = ? ORDER BY received_at ASC, created_at ASC`,
        [invoiceId]
      );
      return rows.map(r => ({
        id: r.id as string,
        amount: (r.amount as number) || 0,
        method: r.method as string,
        receivedAt: r.received_at as string,
        notes: r.notes as string | undefined,
      }));
    } catch { return []; }
  },

  // Plan §Edit: bestehende Payment ändern. Recalc paid_amount + Status der Invoice.
  updatePayment: (paymentId, invoiceId, data) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const fields: string[] = [];
    const values: unknown[] = [];
    if (data.amount !== undefined) { fields.push('amount = ?'); values.push(data.amount); }
    if (data.method !== undefined) { fields.push('method = ?'); values.push(data.method); }
    if (data.notes !== undefined) { fields.push('notes = ?'); values.push(data.notes); }
    if (data.receivedAt !== undefined) { fields.push('received_at = ?'); values.push(data.receivedAt); }
    if (fields.length === 0) return;
    values.push(paymentId);
    db.run(`UPDATE payments SET ${fields.join(', ')} WHERE id = ?`, values);

    // Recalc paid_amount + status
    const sumRow = query(`SELECT COALESCE(SUM(amount), 0) AS paid FROM payments WHERE invoice_id = ?`, [invoiceId]);
    const newPaid = Number(sumRow[0]?.paid || 0);
    const inv = get().getInvoice(invoiceId);
    if (inv) {
      const tip = Math.max(0, newPaid - inv.grossAmount);
      const newStatus: InvoiceStatus = newPaid >= inv.grossAmount ? 'FINAL'
        : newPaid > 0 ? 'PARTIAL'
        : (inv.status === 'CANCELLED' ? 'CANCELLED' : 'DRAFT');
      db.run(`UPDATE invoices SET paid_amount = ?, tip_amount = ?, status = ?, updated_at = ? WHERE id = ?`,
        [newPaid, tip, newStatus, now, invoiceId]);
      if (newStatus !== inv.status) trackStatusChange('invoices', invoiceId, inv.status, newStatus);
    }
    saveDatabase();
    trackUpdate('payments', paymentId, data);
    get().loadInvoices();
  },

  // Payment löschen + Invoice paid_amount/Status neu berechnen.
  deletePayment: (paymentId, invoiceId) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    db.run(`DELETE FROM payments WHERE id = ?`, [paymentId]);

    const sumRow = query(`SELECT COALESCE(SUM(amount), 0) AS paid FROM payments WHERE invoice_id = ?`, [invoiceId]);
    const newPaid = Number(sumRow[0]?.paid || 0);
    const inv = get().getInvoice(invoiceId);
    if (inv) {
      const tip = Math.max(0, newPaid - inv.grossAmount);
      const newStatus: InvoiceStatus = newPaid >= inv.grossAmount ? 'FINAL'
        : newPaid > 0 ? 'PARTIAL'
        : (inv.status === 'CANCELLED' ? 'CANCELLED' : 'DRAFT');
      db.run(`UPDATE invoices SET paid_amount = ?, tip_amount = ?, status = ?, updated_at = ? WHERE id = ?`,
        [newPaid, tip, newStatus, now, invoiceId]);
      if (newStatus !== inv.status) trackStatusChange('invoices', invoiceId, inv.status, newStatus);
    }
    saveDatabase();
    trackDelete('payments', paymentId);
    get().loadInvoices();
  },
}));
