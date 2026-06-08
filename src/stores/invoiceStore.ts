import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { Invoice, InvoiceLine, InvoiceStatus, InvoiceTaxScheme, TaxScheme, PaymentMethod } from '@/core/models/types';
import { vatEngine } from '@/core/tax/vat-engine';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId, getNextDocumentNumber } from '@/core/db/helpers';
import { eventBus } from '@/core/events/event-bus';
import { trackInsert, trackUpdate, trackDelete, trackStatusChange, trackPayment } from '@/core/sync/track';
import { consumeLot, restoreLot, syncProductQuantity, reserveProductIfDepleted, unreserveProductIfRestored } from '@/core/lots/lot-queries';
import { formatInvoiceDisplay } from '@/core/utils/invoiceNumber';
import { normalizeCardBrand, type CardBrand } from '@/core/finance/card-fees';
import { bookCardFee } from '@/core/finance/card-fee-booking';
import {
  postInvoiceIssued,
  postInvoicePayment,
  postInvoiceCancelled,
  postExpenseCancelled,
  hasLedgerEntries,
  hasReversalFor,
} from '@/core/ledger/posting';
import type { Expense } from '@/core/models/types';

// ZIEL.md §3a — Posting-Service ist der einzige Schreibpfad für Finanzbuchungen.
// Domain-Insert + Ledger-Posting laufen in einem Try/Catch. Posting-Fehler werden
// loggend an die Konsole gemeldet, damit ein Bilanz-Bug nicht den Verkaufsfluss
// blockiert; Reconciliation-View zeigt Diskrepanzen.
function safePost(label: string, fn: () => void): void {
  try { fn(); } catch (err) {
    console.error(`[ledger] ${label} failed:`, err);
  }
}

interface InvoiceStore {
  invoices: Invoice[];
  loading: boolean;
  loadInvoices: () => void;
  getInvoice: (id: string) => Invoice | undefined;
  createInvoiceFromOffer: (offerId: string, perLineSchemes?: Record<string, TaxScheme>, staffId?: string, specialMark?: boolean) => Invoice;
  createDirectInvoice: (customerId: string, lines: { productId: string; lotId?: string; quantity?: number; unitPrice: number; purchasePrice: number; taxScheme: string; vatRate: number; vatAmount: number; lineTotal: number }[], notes?: string, issuedAtOverride?: string, numbering?: 'sales' | 'repair', staffId?: string, specialMark?: boolean) => Invoice;
  updateInvoice: (id: string, data: Partial<Invoice>) => void;
  rewriteInvoiceLines: (id: string, lines: { productId: string; lotId?: string; unitPrice: number; purchasePrice: number; taxScheme: string; vatRate: number; vatAmount: number; lineTotal: number; description?: string; quantity?: number }[]) => void;
  recordPayment: (invoiceId: string, amount: number, method: string, notes?: string, specialMarkOnFinal?: boolean, cardBrand?: CardBrand) => void;
  setSpecialMark: (invoiceId: string, special: boolean) => void;
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
    staffId: (row.staff_id as string) || undefined,
    specialMark: Number(row.special_mark) === 1,
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

  createInvoiceFromOffer: (offerId, perLineSchemes, staffId, specialMark) => {
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

    // H-03 — Doppelumwandlung verhindern. Prüft die invoices-Tabelle DIREKT
    // (nicht offer.invoice_id), damit ein nach Invoice-DELETE verwaister Link
    // keine legitime Re-Konvertierung blockiert. Storno setzt invoice_id selbst
    // zurück; eine stornierte (CANCELLED) Rechnung blockiert daher absichtlich nicht.
    const existingInv = query(
      `SELECT invoice_number FROM invoices WHERE offer_id = ? AND status != 'CANCELLED' LIMIT 1`,
      [offerId]
    );
    if (existingInv.length > 0) {
      throw new Error(`Dieses Angebot wurde bereits in Rechnung ${existingInv[0].invoice_number as string} umgewandelt.`);
    }

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
      // v0.7.1 — NBR: MARGIN-Lines persistieren internalVatAmount.
      const vatAmt = calc.internalVatAmount ?? calc.vatAmount;
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
        paid_amount, issued_at, due_at, notes, staff_id, special_mark, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, 'PARTIAL', 'BHD', ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, branchId, invoiceNumber, offerId, offer.customer_id,
       sumNet, vatRate, sumVat, sumGross,
       invoiceScheme, now, dueDate, offer.notes || null, staffId || null, specialMark ? 1 : 0, now, now, userId]
    );

    // Phase 3 — Offer→Invoice hat keine Lot-Info (Offers sind ohne Bestand).
    // Auto-FIFO: aelteste ACTIVE Lot pro Produkt picken, Cost-Snapshot ueberschreiben
    // mit lot.unit_cost falls Lot existiert (genauer als der von Offer mitgegebene
    // Snapshot von products.purchase_price).
    const lotsByProduct: Record<string, string | null> = {};
    {
      const productIds = [...new Set(lines.map(l => l.productId))];
      for (const pid of productIds) {
        const r = db.exec(
          `SELECT id, unit_cost FROM stock_lots
            WHERE product_id = ? AND status != 'CANCELLED' AND qty_remaining > 0
            ORDER BY acquired_at ASC, id ASC LIMIT 1`,
          [pid]
        );
        const row = r[0]?.values?.[0];
        lotsByProduct[pid] = row ? (row[0] as string) : null;
      }
    }

    const lineStmt = db.prepare(
      `INSERT INTO invoice_lines (id, invoice_id, product_id, description, quantity, unit_price, purchase_price_snapshot,
        vat_rate, tax_scheme, vat_amount, line_total, position, lot_id)
       VALUES (?, ?, ?, NULL, 1, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const l of lines) {
      const lotId = lotsByProduct[l.productId] || null;
      lineStmt.run([uuid(), id, l.productId, l.unitPrice, l.purchasePrice, l.vatRate, l.taxScheme, l.vatAmount, l.lineTotal, l.position, lotId]);
    }
    lineStmt.free();

    // Lots konsumieren (1 Stueck pro Line — Offer-Lines haben kein qty-Feld).
    // Phase 7 Sync: betroffene Produkt-IDs sammeln und products.quantity nachziehen.
    const productsToSync = new Set<string>();
    for (const l of lines) {
      const lotId = lotsByProduct[l.productId];
      if (lotId) consumeLot(lotId, 1);
      productsToSync.add(l.productId);
    }
    for (const pid of productsToSync) {
      syncProductQuantity(pid);
      // Plan §Sales §Partial-Payment-Reservation: Invoice startet als PARTIAL,
      // also Produkt vorerst auf 'reserved' setzen. Voll-Zahlung → invoice.paid
      // Handler markiert dann 'sold'.
      reserveProductIfDepleted(pid);
    }

    const margin = totalSale - totalPurchase;
    db.run(`UPDATE invoices SET purchase_price_snapshot = ?, sale_price_snapshot = ?, margin_snapshot = ? WHERE id = ?`,
      [totalPurchase, totalSale, margin, id]);

    // Update offer status + Plan §8 #10: bidirektionale Verknüpfung (offer.invoice_id).
    db.run(`UPDATE offers SET status = 'accepted', invoice_id = ?, updated_at = ? WHERE id = ?`, [id, now, offerId]);

    saveDatabase();
    trackInsert('invoices', id, { invoiceNumber, customerId: offer.customer_id as string });
    eventBus.emit('invoice.created', 'invoice', id, { offerId, total: offer.total });
    eventBus.emit('invoice.issued', 'invoice', id, {});

    // ZIEL.md §3a — Ledger-Posting nach Domain-Insert.
    safePost(`postInvoiceIssued(${id}) from offer`, () => {
      if (hasLedgerEntries('INVOICE', id)) return;
      const fresh: Invoice = {
        id, invoiceNumber, customerId: offer.customer_id as string,
        status: 'PARTIAL', currency: 'BHD',
        netAmount: sumNet, vatRateSnapshot: vatRate, vatAmount: sumVat,
        grossAmount: sumGross, taxSchemeSnapshot: invoiceScheme as InvoiceTaxScheme,
        purchasePriceSnapshot: totalPurchase, salePriceSnapshot: totalSale, marginSnapshot: margin,
        paidAmount: 0, issuedAt: now, dueAt: dueDate,
        lines: lines.map((l, i) => ({
          id: uuid(), invoiceId: id, productId: l.productId,
          quantity: 1,
          unitPrice: l.unitPrice, purchasePriceSnapshot: l.purchasePrice,
          vatRate: l.vatRate, taxScheme: l.taxScheme as TaxScheme,
          vatAmount: l.vatAmount, lineTotal: l.lineTotal, position: i + 1,
        })),
        createdAt: now, createdBy: userId, offerId,
      };
      postInvoiceIssued(fresh);
    });

    get().loadInvoices();

    return get().getInvoice(id)!;
  },

  createDirectInvoice: (customerId, lines, notes, issuedAtOverride, numbering, staffId, specialMark) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const id = uuid();
    let branchId: string, userId: string;
    try { branchId = currentBranchId(); userId = currentUserId(); }
    catch { branchId = 'branch-main'; userId = 'user-owner'; }

    // Repair-Invoices haben eine eigene Nummernserie analog zum Sales-Flow:
    //   RPINV-YYYY-NNNNNN  während PARTIAL
    //   RINV-YYYY-NNNNNN   nach Voll-Zahlung (siehe recordPayment)
    // So bleiben Repair-Rechnungen in der Invoice-Liste sichtbar, vermischen sich
    // aber nicht mit den normalen Sales-Nummern (PINV/INV).
    const invoiceNumber = numbering === 'repair'
      ? getNextDocumentNumber('RPINV')
      : get().getNextInvoiceNumber();
    // Issued-At Override (z.B. nachträgliche Rechnung mit Datum aus Vergangenheit).
    // Akzeptiert "YYYY-MM-DD" oder volles ISO. Default = jetzt.
    const issuedAt = issuedAtOverride
      ? (issuedAtOverride.includes('T') ? issuedAtOverride : `${issuedAtOverride}T00:00:00.000Z`)
      : now;
    const issuedDate = new Date(issuedAt);
    const dueDate = new Date(issuedDate.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // Phase 4 — Auto-FIFO Lot-Pick fuer Caller die keinen explicit lotId mitgeben
    // (agent settlement, repair invoices, order convert, consignment auto-sale).
    // InvoiceCreate liefert lotId direkt; alle anderen profitieren von dieser Auto-Logik:
    //   - Cost-Snapshot wird auf lot.unit_cost ueberschrieben (genauer als product.purchase_price)
    //   - Lot.qty_remaining wird konsumiert
    // Wenn kein Lot existiert (z.B. Consignment-Produkt bevor Auto-Purchase laeuft, oder
    // Repair-Service-Produkt) bleibt der vom Caller mitgegebene purchasePrice unveraendert.
    type ResolvedLine = typeof lines[number] & { _resolvedLotId: string | null; _resolvedCost: number };
    const resolvedLines: ResolvedLine[] = lines.map(l => {
      let lotId = l.lotId || null;
      let cost = l.purchasePrice;
      if (!lotId && l.productId) {
        const r = db.exec(
          `SELECT id, unit_cost FROM stock_lots
            WHERE product_id = ? AND status != 'CANCELLED' AND qty_remaining > 0
            ORDER BY acquired_at ASC, id ASC LIMIT 1`,
          [l.productId]
        );
        const row = r[0]?.values?.[0];
        if (row) {
          lotId = row[0] as string;
          cost = Number(row[1]) || cost;
        }
      }
      return { ...l, _resolvedLotId: lotId, _resolvedCost: cost };
    });

    let netAmount = 0, totalVat = 0, totalPurchase = 0, grossAmount = 0;
    for (const l of resolvedLines) {
      const qty = Math.max(1, l.quantity || 1);
      netAmount += l.unitPrice * qty;
      totalVat += l.vatAmount;
      totalPurchase += l._resolvedCost * qty;
      // v0.7.1 — invoice-level gross direkt aus line.lineTotal aufsummieren.
      // Bei MARGIN ist lineTotal = net (kunde zahlt net), und vatAmount ist der
      // interne Margin-VAT — `net + vat` waere falsch.
      grossAmount += l.lineTotal;
    }
    const margin = netAmount - totalPurchase;

    // Determine tax scheme: if all lines same scheme, use that; otherwise 'mixed'
    const lineSchemes = new Set(lines.map(l => l.taxScheme));
    const taxScheme: string = lineSchemes.size === 1 ? [...lineSchemes][0] : 'mixed';

    db.run(
      `INSERT INTO invoices (id, branch_id, invoice_number, customer_id, status, currency,
        net_amount, vat_rate_snapshot, vat_amount, gross_amount, tax_scheme_snapshot,
        purchase_price_snapshot, sale_price_snapshot, margin_snapshot,
        paid_amount, issued_at, due_at, notes, staff_id, special_mark, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, 'PARTIAL', 'BHD', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, branchId, invoiceNumber, customerId,
       netAmount, lines[0]?.vatRate || 10, totalVat, grossAmount,
       taxScheme, totalPurchase, netAmount, margin, issuedAt, dueDate, notes || null, staffId || null, specialMark ? 1 : 0, now, now, userId]
    );

    const lineStmt = db.prepare(
      `INSERT INTO invoice_lines (id, invoice_id, product_id, quantity, unit_price, purchase_price_snapshot,
        vat_rate, tax_scheme, vat_amount, line_total, position, lot_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    resolvedLines.forEach((l, i) => {
      const qty = Math.max(1, l.quantity || 1);
      lineStmt.run([uuid(), id, l.productId, qty, l.unitPrice, l._resolvedCost, l.vatRate, l.taxScheme, l.vatAmount, l.lineTotal, i + 1, l._resolvedLotId]);
    });
    lineStmt.free();

    // Phase 3 — Stock-Lot konsumieren. Der Cost-Snapshot in invoice_line.purchase_price_snapshot
    // ist bereits gesetzt; hier reduzieren wir nur den Restbestand des Lots, damit kuenftige
    // Sales nicht denselben Bestand doppelt verkaufen koennen.
    // Phase 7 Sync: products.quantity nach Konsumption nachziehen.
    const directProductsToSync = new Set<string>();
    resolvedLines.forEach(l => {
      if (l._resolvedLotId) {
        const qty = Math.max(1, l.quantity || 1);
        consumeLot(l._resolvedLotId, qty);
      }
      if (l.productId) directProductsToSync.add(l.productId);
    });
    for (const pid of directProductsToSync) {
      syncProductQuantity(pid);
      // Plan §Sales §Partial-Payment-Reservation: Invoice startet als PARTIAL,
      // also Produkt vorerst auf 'reserved' setzen. Voll-Zahlung → invoice.paid
      // Handler markiert dann 'sold'.
      reserveProductIfDepleted(pid);
    }

    saveDatabase();
    trackInsert('invoices', id, { invoiceNumber, customerId });
    eventBus.emit('invoice.created', 'invoice', id, { customerId, grossAmount });

    // ZIEL.md §3a — Ledger-Posting nach Domain-Insert.
    safePost(`postInvoiceIssued(${id})`, () => {
      if (hasLedgerEntries('INVOICE', id)) return;
      const fresh: Invoice = {
        id, invoiceNumber, customerId, status: 'PARTIAL', currency: 'BHD',
        netAmount, vatRateSnapshot: lines[0]?.vatRate || 10, vatAmount: totalVat,
        grossAmount, taxSchemeSnapshot: taxScheme as InvoiceTaxScheme,
        purchasePriceSnapshot: totalPurchase, salePriceSnapshot: netAmount, marginSnapshot: margin,
        paidAmount: 0, issuedAt, notes,
        lines: resolvedLines.map((l, i) => ({
          id: uuid(), invoiceId: id, productId: l.productId,
          quantity: Math.max(1, l.quantity || 1),
          unitPrice: l.unitPrice, purchasePriceSnapshot: l._resolvedCost,
          vatRate: l.vatRate, taxScheme: l.taxScheme as TaxScheme,
          vatAmount: l.vatAmount, lineTotal: l.lineTotal, position: i + 1,
        })),
        createdAt: now, createdBy: userId,
      };
      postInvoiceIssued(fresh);
    });

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
      staffId: 'staff_id',
    };

    for (const [k, v] of Object.entries(data)) {
      const col = map[k];
      if (col) {
        fields.push(`${col} = ?`);
        values.push(k === 'butterfly' ? (v ? 1 : 0) : (v ?? null));
      }
    }
    if (fields.length === 0) return;
    fields.push('updated_at = ?'); values.push(now); values.push(id);
    db.run(`UPDATE invoices SET ${fields.join(', ')} WHERE id = ?`, values);
    saveDatabase();
    trackUpdate('invoices', id, data);

    // Plan §8 #6 — bei Stornierung verknüpfte Auto-Expenses (Card-Fees etc.) als CANCELLED markieren.
    if (data.status === 'CANCELLED') {
      // M-04 — wurde die Invoice bereits via Return/Credit-Note rueckabgewickelt,
      // haben CN (Geld) + SALES_RETURN_COGS (COGS) + restoreLot (Stock) alles
      // umgekehrt. Ein zusaetzlicher postInvoiceCancelled + Lot-Restore wuerde
      // REVENUE/VAT/COGS/AR DOPPELT reversen (live bewiesen). Daher Ledger-Reverse
      // + Stock-Restore ueberspringen, sobald eine Credit-Note existiert. Die
      // strukturelle Entkopplung (Offer/Order/Auto-Expense) laeuft unabhaengig weiter.
      const reversedByReturn =
        (Number(query(`SELECT COUNT(*) c FROM credit_notes WHERE invoice_id = ?`, [id])[0]?.c) || 0) > 0;

      // Phase 3 — Stock-Lots restoren: jede invoice_line gibt ihren Bestand zurueck.
      // Phase 7 Sync: products.quantity nach Restore nachziehen.
      if (!reversedByReturn) {
        const lotLines = db.exec(
          `SELECT lot_id, product_id, quantity FROM invoice_lines WHERE invoice_id = ? AND lot_id IS NOT NULL`,
          [id]
        );
        const cancelProductsToSync = new Set<string>();
        if (lotLines.length > 0) {
          for (const row of lotLines[0].values) {
            const [lotId, productId, qty] = row as [string | null, string | null, number];
            if (lotId) restoreLot(lotId, Math.max(1, Number(qty) || 1));
            if (productId) cancelProductsToSync.add(productId);
          }
        }
        for (const pid of cancelProductsToSync) {
          syncProductQuantity(pid);
          // Stornierung: 'reserved' → 'in_stock' (war ja noch nicht 'sold').
          unreserveProductIfRestored(pid);
        }
      }

      // Vor dem UPDATE Auto-Expenses fuer Reverse-Posting einsammeln (sonst sind sie nach
      // dem Cancel-UPDATE nicht mehr im richtigen Status fuer postExpenseCancelled).
      const linkedExpenses = query(
        `SELECT id, expense_number, branch_id, category, amount, paid_amount, payment_method,
                expense_date, description, related_module, related_entity_id, supplier_id, status, created_at
           FROM expenses WHERE related_module = 'invoice' AND related_entity_id = ? AND status != 'CANCELLED'`,
        [id]
      );
      db.run(
        `UPDATE expenses SET status = 'CANCELLED' WHERE related_module = 'invoice' AND related_entity_id = ? AND status != 'CANCELLED'`,
        [id]
      );
      // Plan §8 #10 — zugehöriges Offer zurück auf 'sent' damit Sales neu angehen können.
      db.run(
        `UPDATE offers SET status = 'sent', invoice_id = NULL, updated_at = ? WHERE invoice_id = ?`,
        [now, id]
      );
      // Order ↔ Invoice entkoppeln (analog zum Offer). Eine stornierte Invoice
      // gibt ihre Order-Zeilen wieder frei: invoice_id = NULL macht sie erneut
      // editier-/loeschbar und re-invoicebar (getBillableLines filtert !invoiceId).
      // Ohne das bliebe die Order dauerhaft an einer toten Invoice haengen und
      // jeder Zeilen-Delete/-Edit wuerde mit „erst Invoice stornieren" blocken.
      db.run(`UPDATE order_lines SET invoice_id = NULL WHERE invoice_id = ?`, [id]);
      db.run(`UPDATE orders SET invoice_id = NULL WHERE invoice_id = ?`, [id]);
      saveDatabase();

      // ZIEL.md §3a — Ledger-Storno bei Invoice-Cancel. M-04: nur wenn KEIN Return
      // die Rueckabwicklung schon gebucht hat (sonst Doppel-Reverse von REVENUE/VAT/COGS/AR).
      if (!reversedByReturn) {
        safePost(`postInvoiceCancelled(${id})`, () => {
          if (!hasLedgerEntries('INVOICE', id)) return;     // nie gepostet → nichts zu reverten
          if (hasReversalFor('INVOICE', id)) return;        // bereits storniert
          postInvoiceCancelled({ id } as Invoice);
        });
      }

      // Auto-Expenses (Card-Fees etc.) ebenfalls reverten — sonst Doppelbuchung im Ledger.
      for (const er of linkedExpenses) {
        const expId = er.id as string;
        const expForReverse: Expense = {
          id: expId,
          expenseNumber: er.expense_number as string,
          branchId: er.branch_id as string,
          category: (er.category as Expense['category']) || 'CardFees',
          amount: Number(er.amount || 0),
          paidAmount: Number(er.paid_amount || 0),
          paymentMethod: (er.payment_method as 'cash' | 'bank') || 'bank',
          expenseDate: er.expense_date as string,
          description: er.description as string,
          relatedModule: 'invoice',
          relatedEntityId: id,
          supplierId: (er.supplier_id as string) || undefined,
          status: er.status as Expense['status'],
          createdAt: er.created_at as string,
        };
        safePost(`postExpenseCancelled(${expId}) [invoice-cancel]`, () => {
          if (!hasLedgerEntries('EXPENSE', expId)) return;
          if (hasReversalFor('EXPENSE', expId)) return;
          postExpenseCancelled(expForReverse);
        });
      }
    }

    if (data.status === 'FINAL') {
      eventBus.emit('invoice.paid', 'invoice', id, {});
    }
    get().loadInvoices();
  },

  rewriteInvoiceLines: (id, lines) => {
    const db = getDatabase();
    const now = new Date().toISOString();

    // Vorab-Berechnung um zu prüfen ob neuer Brutto die bereits geleisteten Zahlungen
    // unterläuft — sonst entstünde paid > gross und negative outstanding.
    let preNet = 0, preVat = 0;
    for (const l of lines) {
      const qty = Math.max(1, l.quantity || 1);
      preNet += l.unitPrice * qty;
      preVat += l.vatAmount;   // L-17: vatAmount ist pro Line (createDirect-Konvention), kein ×qty
    }
    const newGross = preNet + preVat;
    const inv0 = get().getInvoice(id);
    if (inv0 && inv0.paidAmount > newGross + 0.005) {
      throw new Error(
        `Cannot reduce invoice gross to ${newGross.toFixed(3)} BHD — already paid ${inv0.paidAmount.toFixed(3)} BHD. Refund the excess first.`
      );
    }

    // Phase 3 — alte Lots restoren bevor wir DELETE machen, sonst geht der
    // Bestand verloren. Pro alter invoice_line mit lot_id: qty zurueckgeben.
    // Phase 7 Sync: betroffene Produkt-IDs sammeln (alte UND neue), am Ende einmal sync.
    const rewriteProductsToSync = new Set<string>();
    {
      const oldLines = db.exec(
        `SELECT lot_id, product_id, quantity FROM invoice_lines WHERE invoice_id = ? AND lot_id IS NOT NULL`,
        [id]
      );
      if (oldLines.length > 0) {
        for (const row of oldLines[0].values) {
          const [lotId, productId, qty] = row as [string | null, string | null, number];
          if (lotId) restoreLot(lotId, Math.max(1, Number(qty) || 1));
          if (productId) rewriteProductsToSync.add(productId);
        }
      }
    }

    db.run(`DELETE FROM invoice_lines WHERE invoice_id = ?`, [id]);

    // Phase 4 — Auto-FIFO Lot-Pick spiegelt createDirectInvoice. Caller (InvoiceCreate
    // im Edit-Mode) liefert lotId; falls nicht, FIFO-Lot picken + lot.unit_cost als Cost.
    type ResolvedRewriteLine = typeof lines[number] & { _resolvedLotId: string | null; _resolvedCost: number };
    const resolvedLines: ResolvedRewriteLine[] = lines.map(l => {
      let lotId = l.lotId || null;
      let cost = l.purchasePrice;
      if (!lotId && l.productId) {
        const r = db.exec(
          `SELECT id, unit_cost FROM stock_lots
            WHERE product_id = ? AND status != 'CANCELLED' AND qty_remaining > 0
            ORDER BY acquired_at ASC, id ASC LIMIT 1`,
          [l.productId]
        );
        const row = r[0]?.values?.[0];
        if (row) {
          lotId = row[0] as string;
          cost = Number(row[1]) || cost;
        }
      }
      return { ...l, _resolvedLotId: lotId, _resolvedCost: cost };
    });

    let netAmount = 0, totalVat = 0, totalPurchase = 0, grossAmount = 0;
    const stmt = db.prepare(
      `INSERT INTO invoice_lines (id, invoice_id, product_id, description, quantity, unit_price, purchase_price_snapshot,
        vat_rate, tax_scheme, vat_amount, line_total, position, lot_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    resolvedLines.forEach((l, i) => {
      const qty = Math.max(1, l.quantity || 1);
      stmt.run([uuid(), id, l.productId, l.description || null, qty, l.unitPrice, l._resolvedCost, l.vatRate, l.taxScheme, l.vatAmount, l.lineTotal, i + 1, l._resolvedLotId]);
      netAmount += l.unitPrice * qty;
      totalVat += l.vatAmount;   // L-17: vatAmount ist pro Line (createDirect-Konvention), kein ×qty
      totalPurchase += l._resolvedCost * qty;
      // v0.7.1 — siehe createDirectInvoice: lineTotal direkt aufsummieren statt
      // net+vat zu rechnen (MARGIN hat lineTotal=net, vatAmount=internalVat).
      grossAmount += l.lineTotal;
    });
    stmt.free();

    // Neue Lots konsumieren.
    resolvedLines.forEach(l => {
      if (l._resolvedLotId) {
        const qty = Math.max(1, l.quantity || 1);
        consumeLot(l._resolvedLotId, qty);
      }
      if (l.productId) rewriteProductsToSync.add(l.productId);
    });
    // Phase 7 Sync: products.quantity nach alter Restore + neuer Konsumption final nachziehen.
    // Plan §Sales §Partial-Payment-Reservation: nach Rewrite zuerst entreservieren
    // (Produkte die jetzt wieder qty>0 haben) und dann reservieren (Produkte die
    // durch neue Lines auf 0 fallen). Reihenfolge wichtig: erst unreserve, dann reserve.
    for (const pid of rewriteProductsToSync) syncProductQuantity(pid);
    const invForRewrite = get().getInvoice(id);
    const isStillUnpaid = !invForRewrite || invForRewrite.status !== 'FINAL';
    for (const pid of rewriteProductsToSync) {
      unreserveProductIfRestored(pid);
      if (isStillUnpaid) reserveProductIfDepleted(pid);
    }

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

  recordPayment: (invoiceId, amount, method, notes, specialMarkOnFinal, cardBrand) => {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('Payment amount must be a positive number.');
    }
    const db = getDatabase();
    // WICHTIG: dasselbe `now` wird fuer den payments-Insert UND die Auto-CardFees-
    // Expense verwendet. bankingStore matcht die Fee ueber created_at = payment.created_at
    // um die Bank-Zeile netto zu zeigen — dieser geteilte Timestamp ist load-bearing.
    const now = new Date().toISOString();
    const paymentId = uuid();
    let branchId: string, userId: string;
    try { branchId = currentBranchId(); userId = currentUserId(); }
    catch { branchId = 'branch-main'; userId = 'user-owner'; }

    // v0.7.26 — Karten-Brand nur bei 'card' merken; steuert die Gebuehren-Rate.
    const cardBrandValue: CardBrand | null = method === 'card' ? normalizeCardBrand(cardBrand) : null;
    db.run(
      `INSERT INTO payments (id, branch_id, invoice_id, amount, method, card_brand, reference, received_at, notes, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      [paymentId, branchId, invoiceId, amount, method, cardBrandValue, now, notes || null, now, userId]
    );

    // Plan §Sales §12: bei Vollzahlung Auto-Konvertierung Partial → Final.
    // Plan §Sales §3: Nur Final Invoice zählt in Umsatz/Gewinn/Steuer.
    // v0.3.2 — finalInvoiceLabel haelt die Display-Nummer NACH einer evtl.
    // Finalisierung fest, damit die danach erzeugte Card-Fee-Expense dieselbe
    // Nummer traegt wie die Bank-Zeile (No: 000009 statt veraltetem PINV-…).
    let finalInvoiceLabel = '';
    const inv = get().getInvoice(invoiceId);
    if (inv) {
      const newPaid = inv.paidAmount + amount;
      const tip = Math.max(0, newPaid - inv.grossAmount);
      // Float-Tolerance: BHD hat 3 Dezimalen → unter 0.005 BHD = ein Halb-Fil = effektiv null.
      const wasFullyPaid = newPaid >= inv.grossAmount - 0.005;
      const prevStatus = inv.status;
      const newStatus: InvoiceStatus = wasFullyPaid ? 'FINAL' : 'PARTIAL';

      // Wenn Konvertierung PARTIAL → FINAL: neue Nummer in der jeweiligen Serie zuweisen.
      //   Sales:  PINV  → INV
      //   Repair: RPINV → RINV
      // So bleiben Repair-Rechnungen sauber in eigener Serie, parallel zur Sales-Logik.
      // 2026-05-16 — Special-Mark wird beim Final-werden gesetzt; bestehende
      // Partial-Marke bleibt sonst unangetastet.
      const useSpecial = wasFullyPaid && inv.status !== 'FINAL'
        ? (typeof specialMarkOnFinal === 'boolean' ? specialMarkOnFinal : !!inv.specialMark)
        : !!inv.specialMark;
      const nextSpecial = useSpecial ? 1 : 0;

      // Beim Konvertieren PARTIAL → FINAL: neue Nummer aus dem passenden Zaehler.
      //   Sales Normal:   INV-YYYY-NNNNNN
      //   Sales Special:  SINV-YYYY-NNNNNN  (eigener Zaehler — laeuft 1,2,3,... parallel)
      //   Repair Normal:  RINV-YYYY-NNNNNN
      //   Repair Special: SRINV-YYYY-NNNNNN (eigener Zaehler)
      let newInvoiceNumber = inv.invoiceNumber;
      if (wasFullyPaid && inv.status !== 'FINAL') {
        const isRepair = inv.invoiceNumber.startsWith('RPINV-');
        if (isRepair) {
          newInvoiceNumber = getNextDocumentNumber(useSpecial ? 'SRINV' : 'RINV');
        } else {
          newInvoiceNumber = getNextDocumentNumber(useSpecial ? 'SINV' : 'INV');
        }
      }
      // v0.3.2 — Display-Nummer fuer die danach erzeugte Card-Fee-Beschreibung
      // festhalten (nutzt die finale Nummer + Status, nicht den Pre-Payment-Stand).
      finalInvoiceLabel = formatInvoiceDisplay({
        invoiceNumber: newInvoiceNumber, status: newStatus, specialMark: useSpecial,
      });

      db.run(`UPDATE invoices SET paid_amount = ?, tip_amount = ?, status = ?, invoice_number = ?, special_mark = ?, updated_at = ? WHERE id = ?`,
        [newPaid, tip, newStatus, newInvoiceNumber, nextSpecial, now, invoiceId]);

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

    // Plan §Sales §11 + §Expenses §8: Card-Fee wird automatisch als Expense gebucht.
    // v0.3.2 — NACH der Finalisierung, damit expenseDescription die finale
    // Invoice-Nummer traegt (finalInvoiceLabel). created_at bleibt `now` und
    // matcht damit weiterhin den payments-Insert (bankingStore Card-Fee-Netting).
    if (method === 'card' && amount > 0) {
      // v0.7.26 — Auto-CardFees ueber den SSOT-Helper (brand-genaue Rate 2,2%/2,5%).
      // created_at = `now` matcht den payments-Insert → bankingStore nettet die
      // Bank-Zeile korrekt. Label nutzt die finale Invoice-Nummer (No: 000009/PINV-…).
      bookCardFee({
        branchId, userId, amount, brand: cardBrandValue ?? 'normal',
        relatedModule: 'invoice', relatedEntityId: invoiceId,
        label: finalInvoiceLabel || invoiceId.slice(0, 8), createdAt: now,
      });
    }

    saveDatabase();
    trackInsert('payments', paymentId, { invoiceId, amount, method });
    trackPayment('invoices', invoiceId, amount, method);

    // ZIEL.md §3a — Ledger-Posting für Customer-Zahlung.
    const invForLedger = get().getInvoice(invoiceId);
    if (invForLedger) {
      safePost(`postInvoicePayment(${paymentId})`, () => {
        if (hasLedgerEntries('PAYMENT', paymentId)) return;
        postInvoicePayment(
          {
            id: paymentId,
            invoiceId,
            amount,
            method: method as PaymentMethod,
            receivedAt: now,
            notes,
            createdAt: now,
          },
          invForLedger.customerId
        );
      });
    }

    get().loadInvoices();
  },

  setSpecialMark: (invoiceId, special) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    db.run(`UPDATE invoices SET special_mark = ?, updated_at = ? WHERE id = ?`,
      [special ? 1 : 0, now, invoiceId]);
    saveDatabase();
    trackUpdate('invoices', invoiceId, { specialMark: special });
    get().loadInvoices();
  },

  deleteInvoice: (id) => {
    const db = getDatabase();
    // Vor dem Cancel die Auto-Expenses fuer Reverse-Posting einsammeln.
    const linkedExpenses = query(
      `SELECT id, expense_number, branch_id, category, amount, paid_amount, payment_method,
              expense_date, description, related_module, related_entity_id, supplier_id, status, created_at
         FROM expenses WHERE related_module = 'invoice' AND related_entity_id = ? AND status != 'CANCELLED'`,
      [id]
    );
    // Auto-erzeugte Expenses (Card-Fees etc.) cancellen, damit Cashflow konsistent bleibt.
    db.run(
      `UPDATE expenses SET status = 'CANCELLED'
       WHERE related_module = 'invoice' AND related_entity_id = ? AND status != 'CANCELLED'`,
      [id]
    );
    // Phase 3 — Stock-Lots restoren bevor invoice_lines weg sind.
    // Phase 7 Sync: betroffene Produkte sammeln, am Ende sync.
    const deleteProductsToSync = new Set<string>();
    {
      const lotLines = db.exec(
        `SELECT lot_id, product_id, quantity FROM invoice_lines WHERE invoice_id = ? AND lot_id IS NOT NULL`,
        [id]
      );
      if (lotLines.length > 0) {
        for (const row of lotLines[0].values) {
          const [lotId, productId, qty] = row as [string | null, string | null, number];
          if (lotId) restoreLot(lotId, Math.max(1, Number(qty) || 1));
          if (productId) deleteProductsToSync.add(productId);
        }
      }
    }
    db.run(`DELETE FROM invoice_lines WHERE invoice_id = ?`, [id]);
    for (const pid of deleteProductsToSync) {
      syncProductQuantity(pid);
      // M-05 — wie im Cancel-Branch: 'reserved' → 'in_stock' wenn der Lot wieder
      // Bestand hat. Sonst bleibt das Produkt nach Invoice-Delete unverkaeuflich.
      unreserveProductIfRestored(pid);
    }
    db.run(`DELETE FROM payments WHERE invoice_id = ?`, [id]);
    // Order ↔ Invoice entkoppeln BEVOR die Invoice geloescht wird — sql.js
    // erzwingt ON DELETE SET NULL nicht zuverlaessig, sonst bleiben
    // order_lines.invoice_id / orders.invoice_id als Geist-Referenz stehen und
    // die Order ist dauerhaft gesperrt (Zeilen-Delete/-Edit verlangt einen
    // Invoice-Storno, den es nicht mehr gibt).
    db.run(`UPDATE order_lines SET invoice_id = NULL WHERE invoice_id = ?`, [id]);
    db.run(`UPDATE orders SET invoice_id = NULL WHERE invoice_id = ?`, [id]);
    db.run(`DELETE FROM invoices WHERE id = ?`, [id]);
    saveDatabase();
    trackDelete('invoices', id);

    // Ledger: Invoice-Reverse + jeden zugehoerigen CardFee-Expense reverten,
    // sonst bleiben Geist-Eintraege bestehen die nie wieder geclearbar sind.
    safePost(`postInvoiceCancelled(${id}) [delete]`, () => {
      if (!hasLedgerEntries('INVOICE', id)) return;
      if (hasReversalFor('INVOICE', id)) return;
      postInvoiceCancelled({ id } as Invoice);
    });
    for (const er of linkedExpenses) {
      const expId = er.id as string;
      const expForReverse: Expense = {
        id: expId,
        expenseNumber: er.expense_number as string,
        branchId: er.branch_id as string,
        category: (er.category as Expense['category']) || 'CardFees',
        amount: Number(er.amount || 0),
        paidAmount: Number(er.paid_amount || 0),
        paymentMethod: (er.payment_method as 'cash' | 'bank') || 'bank',
        expenseDate: er.expense_date as string,
        description: er.description as string,
        relatedModule: 'invoice',
        relatedEntityId: id,
        supplierId: (er.supplier_id as string) || undefined,
        status: er.status as Expense['status'],
        createdAt: er.created_at as string,
      };
      safePost(`postExpenseCancelled(${expId}) [invoice-delete]`, () => {
        if (!hasLedgerEntries('EXPENSE', expId)) return;
        if (hasReversalFor('EXPENSE', expId)) return;
        postExpenseCancelled(expForReverse);
      });
    }

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
      const newStatus: InvoiceStatus = newPaid >= inv.grossAmount - 0.005 ? 'FINAL'
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
      const newStatus: InvoiceStatus = newPaid >= inv.grossAmount - 0.005 ? 'FINAL'
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
