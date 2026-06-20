import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { Invoice, InvoiceLine, InvoiceStatus, InvoiceTaxScheme, TaxScheme, PaymentMethod } from '@/core/models/types';
import { vatEngine } from '@/core/tax/vat-engine';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId, getNextDocumentNumber } from '@/core/db/helpers';
import { eventBus } from '@/core/events/event-bus';
import { trackInsert, trackUpdate, trackDelete, trackStatusChange, trackPayment } from '@/core/sync/track';
import { trackChange } from '@/core/sync/sync-service';
import { consumeLot, restoreLot, syncProductQuantity, reserveProductIfDepleted, unreserveProductIfRestored } from '@/core/lots/lot-queries';
import { formatInvoiceDisplay } from '@/core/utils/invoiceNumber';
import { normalizeCardBrand, type CardBrand } from '@/core/finance/card-fees';
import { bookCardFee, reverseCardFees } from '@/core/finance/card-fee-booking';
import {
  postInvoiceIssued,
  postInvoicePayment,
  postInvoicePaymentReversed,
  postInvoiceCancelled,
  postExpenseCancelled,
  reverseSource,
  beginLedgerTransaction,
  commitLedgerTransaction,
  rollbackLedgerTransaction,
  hasLedgerEntries,
  hasReversalFor,
} from '@/core/ledger/posting';
import { logAudit } from '@/core/audit/audit-log';
import { useProductStore } from '@/stores/productStore';
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
  // Atomarer Gesamt-Edit einer gebuchten Rechnung (Header + Zeilen + Inventory +
  // Ledger-Reverse+Repost + optionale Delta-Zahlung + Status) in EINER SQL-Transaktion
  // mit Pflicht-Aenderungsgrund (Audit). Reduktion unter den bereits gezahlten Betrag
  // wird (vorerst) blockiert — Ueberzahlung→Store-Guthaben kommt als eigener Slice.
  editInvoice: (id: string, input: {
    lines: { productId: string; lotId?: string; unitPrice: number; purchasePrice: number; taxScheme: string; vatRate: number; vatAmount: number; lineTotal: number; description?: string; quantity?: number }[];
    customerId?: string;
    notes?: string;
    issuedAt?: string;
    staffId?: string;
    deltaPayment?: { amount: number; method: PaymentMethod; cardBrand?: CardBrand };
    reason: string;
  }) => void;
  recordPayment: (invoiceId: string, amount: number, method: string, notes?: string, specialMarkOnFinal?: boolean, cardBrand?: CardBrand) => void;
  // Credit-Modell Slice 3 — Store-Guthaben des Kunden gegen eine Invoice einlösen.
  // Konsumiert OPEN-customer_credits FIFO (used_amount↑) und bucht via recordPayment('credit')
  // DR CUSTOMER_CREDIT / CR AR. Gibt den tatsächlich verrechneten Betrag zurück.
  applyCreditToInvoice: (invoiceId: string, amount: number, note?: string) => number;
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

    // COGS-Anker-Fix (wie createDirectInvoice): _id einmal pro Line erzeugen und
    // fuer INSERT UND postInvoiceIssued nutzen -> source_line_id == invoice_lines.id.
    type OverrideLine = { _id: string; productId: string; description: string | null; purchasePrice: number; unitPrice: number; vatRate: number; taxScheme: string; vatAmount: number; lineTotal: number; position: number };
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
        _id: uuid(), productId: l.product_id as string, description: null,
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
      lineStmt.run([l._id, id, l.productId, l.unitPrice, l.purchasePrice, l.vatRate, l.taxScheme, l.vatAmount, l.lineTotal, l.position, lotId]);
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
    // Sync (Scope A): jede persistierte invoice_line mit ihrer kanonischen _id
    // uebertragen. trackChange snapshottet die volle Zeile via SELECT * (inkl.
    // lot_id/position/Preise/VAT) → Geraet B baut identische Lines. Erst HIER, nach
    // erfolgreichem Domain-Insert + saveDatabase: warf ein vorheriges INSERT, wird
    // nichts getrackt → kein verwaister Line-Sync-Eintrag bei fehlgeschlagenem Create.
    for (const l of lines) trackChange('invoice_lines', l._id, 'insert', {});
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
          id: l._id, invoiceId: id, productId: l.productId,
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
    // COGS-Anker-Fix: die endgueltige invoice_line.id EINMAL erzeugen (_id) und fuer
    // DB-INSERT UND das postInvoiceIssued-Objekt nutzen -> ledger source_line_id ==
    // invoice_lines.id (ein spaeterer Return findet via getInvoiceLineCogs den Cost).
    // Gleiches Muster wie editInvoice; kein zweiter uuid() pro Line mehr.
    type ResolvedLine = typeof lines[number] & { _id: string; _resolvedLotId: string | null; _resolvedCost: number };
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
      return { ...l, _id: uuid(), _resolvedLotId: lotId, _resolvedCost: cost };
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
      lineStmt.run([l._id, id, l.productId, qty, l.unitPrice, l._resolvedCost, l.vatRate, l.taxScheme, l.vatAmount, l.lineTotal, i + 1, l._resolvedLotId]);
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
    // Sync (Scope A): siehe createInvoiceFromOffer — Lines erst nach erfolgreichem
    // Domain-Insert mit kanonischer _id uebertragen (Full-Row-Snapshot via SELECT *).
    for (const l of resolvedLines) trackChange('invoice_lines', l._id, 'insert', {});
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
          id: l._id, invoiceId: id, productId: l.productId,
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
    // L-03: Status VOR dem UPDATE festhalten, um den echten Uebergang -> FINAL zu
    // erkennen. invoice.paid (und damit der Customer-LTV-Increment) darf nur beim
    // Uebergang feuern, nicht beim Re-Save eines bereits FINALen Beleges.
    const prevStatusBeforeUpdate = data.status === 'FINAL'
      ? ((query('SELECT status FROM invoices WHERE id = ?', [id])[0]?.status as string) || null)
      : null;
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
        // L2 — full-unwind: bei direktem Status-Cancel OHNE Refund-Return (z.B.
        // consignmentStore.cancelSale mit bereits bezahlter Buyer-Invoice) auch die
        // Zahlungs-Beine reversen, sonst bliebe CASH/BANK/BENEFIT phantom + AR negativ.
        // reversedByReturn=true (UI-handleCancelInvoice macht VORHER Sales-Return+refund)
        // ueberspringt diesen ganzen Block → KEIN Doppel-Refund. Unbezahlt = leere
        // Schleife (No-Op). Analog deleteInvoice; Guards = idempotent.
        const cancelPayIds = query('SELECT id FROM payments WHERE invoice_id = ?', [id]).map(r => r.id as string);
        for (const pid of cancelPayIds) {
          safePost(`postInvoicePaymentReversed(${pid}) [invoice-cancel]`, () => {
            if (!hasLedgerEntries('PAYMENT', pid)) return;
            if (hasReversalFor('PAYMENT', pid)) return;
            postInvoicePaymentReversed(pid);
          });
        }
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

    if (data.status === 'FINAL' && prevStatusBeforeUpdate !== 'FINAL') {
      eventBus.emit('invoice.paid', 'invoice', id, {});
    }
    get().loadInvoices();
  },

  editInvoice: (id, input) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const { lines, customerId, notes, issuedAt, staffId, deltaPayment, reason } = input;

    const inv0 = get().getInvoice(id);
    if (!inv0) throw new Error(`editInvoice: invoice ${id} not found`);
    if (inv0.status === 'CANCELLED') throw new Error('Cannot edit a cancelled invoice.');
    if (!lines || lines.length === 0) throw new Error('Invoice must have at least one line.');

    // Pflicht-Aenderungsgrund (Audit, Punkt 3) — kein stiller Edit.
    const reasonTrim = (reason || '').trim();
    if (!reasonTrim) throw new Error('An edit reason is required.');

    // ── Guard B (Regel 2) — aktive Returns / Credit Notes blockieren den Line-Edit.
    // editInvoice vergibt neue invoice_lines-IDs (DELETE+INSERT); bestehende
    // sales_return_lines.invoice_line_id und der per source_line_id verankerte
    // Original-COGS wuerden sonst verwaisen (Doppel-Return-Schutz + COGS-Reversal
    // kaputt). Daher hart blocken: CN ueber CreditNotes-Detail loeschbar, Return
    // ueber den Return-Storno — DANN ist der Line-Edit wieder frei.
    const activeReturns = Number(query(
      `SELECT COUNT(*) AS c FROM sales_returns WHERE invoice_id = ? AND status != 'REJECTED'`, [id]
    )[0]?.c || 0);
    const activeCreditNotes = Number(query(
      `SELECT COUNT(*) AS c FROM credit_notes WHERE invoice_id = ?`, [id]
    )[0]?.c || 0);
    if (activeReturns > 0 || activeCreditNotes > 0) {
      const parts: string[] = [];
      if (activeReturns > 0) parts.push(`${activeReturns} return${activeReturns > 1 ? 's' : ''}`);
      if (activeCreditNotes > 0) parts.push(`${activeCreditNotes} credit note${activeCreditNotes > 1 ? 's' : ''}`);
      throw new Error(
        `Cannot edit invoice lines — ${parts.join(' and ')} linked to this invoice. Delete the linked credit note / return first, then edit.`
      );
    }

    // Vorab-Berechnung des neuen Brutto (vor jeder Mutation).
    let preNet = 0, preVat = 0;
    for (const l of lines) {
      const qty = Math.max(1, l.quantity || 1);
      preNet += l.unitPrice * qty;
      preVat += l.vatAmount;   // L-17: vatAmount ist pro Line (createDirect-Konvention), kein ×qty
    }
    const newGross = preNet + preVat;
    const deltaAmount = deltaPayment && deltaPayment.amount > 0.005 ? deltaPayment.amount : 0;

    // ── Punkt 1: paid_amount IST per Invariante SUM(payments) — updatePayment/
    // deletePayment rechnen es daraus neu, ReconciliationPage.domainAR summiert
    // payments direkt. Daher darf der Edit den bereits gezahlten Betrag NICHT
    // unterschreiten (sonst muesste paid_amount still gesenkt werden = Invariante
    // gebrochen, Guthaben doppelt). Reduktion-unter-paid wird vorerst BLOCKIERT;
    // die saubere Ueberzahlung→Store-Guthaben-Umbuchung kommt als eigener Slice.
    const projectedPaid = inv0.paidAmount + deltaAmount;
    if (newGross < projectedPaid - 0.005) {
      throw new Error(
        `Cannot reduce the invoice total to ${newGross.toFixed(3)} BHD below the amount already paid ` +
        `(${projectedPaid.toFixed(3)} BHD). Refund or adjust the payment first — ` +
        `overpayment-to-store-credit is not yet available.`
      );
    }

    // Vorher-Snapshot fuer das Audit (Header + Zeilen + paid/status).
    const oldSnapshot = JSON.stringify({
      customerId: inv0.customerId, status: inv0.status,
      netAmount: inv0.netAmount, vatAmount: inv0.vatAmount, grossAmount: inv0.grossAmount,
      paidAmount: inv0.paidAmount, taxScheme: inv0.taxSchemeSnapshot,
      issuedAt: inv0.issuedAt, notes: inv0.notes || null,
      lines: (inv0.lines || []).map(l => ({
        productId: l.productId, qty: l.quantity, unitPrice: l.unitPrice,
        vat: l.vatAmount, lineTotal: l.lineTotal, taxScheme: l.taxScheme,
      })),
    });

    // Ledger-Relevanz VOR dem Reverse festhalten (DRAFT ohne Ledger nicht posten).
    const hadInvoiceLedger = hasLedgerEntries('INVOICE', id);

    // ── Punkt 2: EINE echte SQL-Transaktion. reverse + header + lines + lots +
    // repost + delta-payment + status + audit laufen als Einheit. Bei Fehler ROLLBACK
    // → kein persistierter Zwischenstand (saveDatabase erst beim COMMIT). Store-State
    // wird erst NACH COMMIT bzw. im Fehlerfall nach ROLLBACK re-synchronisiert.
    const productsToSync = new Set<string>();
    beginLedgerTransaction();
    try {
      // 1. (Regel 1) Bestehende INVOICE-Buchung reversen (AR/REVENUE/VAT/COGS/INVENTORY).
      //    Multi-cycle-safe; PAYMENT-Beine (eigener sourceModule) bleiben unangetastet.
      if (hadInvoiceLedger) {
        reverseSource('INVOICE', id, now);
      }

      // 2. Header (optional) — Kunde/Notiz/Datum/Mitarbeiter im selben Vorgang.
      const hSets: string[] = [];
      const hVals: unknown[] = [];
      if (customerId !== undefined) { hSets.push('customer_id = ?'); hVals.push(customerId); }
      if (notes !== undefined) { hSets.push('notes = ?'); hVals.push(notes || null); }
      if (issuedAt !== undefined) { hSets.push('issued_at = ?'); hVals.push(issuedAt); }
      if (staffId !== undefined) { hSets.push('staff_id = ?'); hVals.push(staffId || null); }
      if (hSets.length > 0) {
        hVals.push(now, id);
        db.run(`UPDATE invoices SET ${hSets.join(', ')}, updated_at = ? WHERE id = ?`, hVals);
      }
      const effCustomerId = customerId !== undefined ? customerId : inv0.customerId;

      // 3. Domain: alte Lots restoren (Bestand zurueck), dann Lines loeschen.
      {
        const oldLines = db.exec(
          `SELECT lot_id, product_id, quantity FROM invoice_lines WHERE invoice_id = ? AND lot_id IS NOT NULL`,
          [id]
        );
        if (oldLines.length > 0) {
          for (const row of oldLines[0].values) {
            const [lotId, productId, qty] = row as [string | null, string | null, number];
            if (lotId) restoreLot(lotId, Math.max(1, Number(qty) || 1));
            if (productId) productsToSync.add(productId);
          }
        }
      }
      // Sync (Scope A): alte Line-IDs VOR dem DELETE erfassen — Geraet B muss exakt
      // dieselben Zeilen entfernen. trackChange('delete') braucht nur die id (keinen
      // Row-Snapshot), daher genuegt das Tracking direkt nach dem SQL-DELETE. Beides
      // innerhalb der offenen Tx → atomar; Rollback verwirft die Changelog-Zeilen.
      const oldLineIds = query(`SELECT id FROM invoice_lines WHERE invoice_id = ?`, [id]).map(r => r.id as string);
      db.run(`DELETE FROM invoice_lines WHERE invoice_id = ?`, [id]);
      for (const oldId of oldLineIds) trackChange('invoice_lines', oldId, 'delete', {});

      // 4. Neue Lines — Auto-FIFO Lot-Pick wie createDirectInvoice. WICHTIG: Line-ID
      //    EINMAL erzeugen (_id) und fuer DB-INSERT UND Repost-Objekt nutzen → COGS-
      //    source_line_id == invoice_lines.id (ein spaeterer Return findet den Cost).
      type ResolvedRewriteLine = typeof lines[number] & { _id: string; _resolvedLotId: string | null; _resolvedCost: number };
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
        return { ...l, _id: uuid(), _resolvedLotId: lotId, _resolvedCost: cost };
      });

      let netAmount = 0, totalVat = 0, totalPurchase = 0, grossAmount = 0;
      const stmt = db.prepare(
        `INSERT INTO invoice_lines (id, invoice_id, product_id, description, quantity, unit_price, purchase_price_snapshot,
          vat_rate, tax_scheme, vat_amount, line_total, position, lot_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      resolvedLines.forEach((l, i) => {
        const qty = Math.max(1, l.quantity || 1);
        stmt.run([l._id, id, l.productId, l.description || null, qty, l.unitPrice, l._resolvedCost, l.vatRate, l.taxScheme, l.vatAmount, l.lineTotal, i + 1, l._resolvedLotId]);
        netAmount += l.unitPrice * qty;
        totalVat += l.vatAmount;   // L-17: vatAmount ist pro Line (createDirect-Konvention), kein ×qty
        totalPurchase += l._resolvedCost * qty;
        // v0.7.1 — siehe createDirectInvoice: lineTotal direkt aufsummieren statt
        // net+vat zu rechnen (MARGIN hat lineTotal=net, vatAmount=internalVat).
        grossAmount += l.lineTotal;
      });
      stmt.free();

      // Sync (Scope A): jede neue Line mit ihrer kanonischen _id uebertragen
      // (Full-Row-Snapshot via SELECT *, inkl. lot_id/position/Preise/VAT). Die Lines
      // sind hier bereits eingefuegt; trackChange liest sie in derselben offenen Tx.
      // Repost-Ledger (postInvoiceIssued, COGS.source_line_id == _id) folgt danach →
      // auf B existieren die Lines vor den referenzierenden Ledger-Entries.
      resolvedLines.forEach(l => trackChange('invoice_lines', l._id, 'insert', {}));

      // Neue Lots konsumieren.
      resolvedLines.forEach(l => {
        if (l._resolvedLotId) {
          const qty = Math.max(1, l.quantity || 1);
          consumeLot(l._resolvedLotId, qty);
        }
        if (l.productId) productsToSync.add(l.productId);
      });

      const margin = netAmount - totalPurchase;
      const schemes = new Set(lines.map(l => l.taxScheme));
      const taxScheme = schemes.size === 1 ? [...schemes][0] : 'mixed';

      // 5. invoices-Totale aktualisieren — VOR dem Repost.
      db.run(
        `UPDATE invoices SET net_amount = ?, vat_amount = ?, gross_amount = ?,
          purchase_price_snapshot = ?, sale_price_snapshot = ?, margin_snapshot = ?,
          tax_scheme_snapshot = ?, updated_at = ? WHERE id = ?`,
        [netAmount, totalVat, grossAmount, totalPurchase, netAmount, margin, taxScheme, now, id]
      );

      // 6. (Regel 1) Repost INVOICE — frische AR/REVENUE/VAT/COGS/INVENTORY. fresh.lines
      //    tragen die ECHTEN invoice_lines-IDs (_id). Kein safePost: ein Repost-Fehler
      //    MUSS den Gesamt-Rollback ausloesen. Nur posten, wenn die Rechnung ledger-
      //    relevant ist (war im Ledger oder ist nicht-DRAFT) — eine reine DRAFT bleibt
      //    ungebucht.
      if (hadInvoiceLedger || inv0.status !== 'DRAFT') {
        const fresh: Invoice = {
          id, invoiceNumber: inv0.invoiceNumber, customerId: effCustomerId,
          status: inv0.status, currency: inv0.currency || 'BHD',
          netAmount, vatRateSnapshot: lines[0]?.vatRate || 10, vatAmount: totalVat,
          grossAmount, taxSchemeSnapshot: taxScheme as InvoiceTaxScheme,
          purchasePriceSnapshot: totalPurchase, salePriceSnapshot: netAmount, marginSnapshot: margin,
          paidAmount: inv0.paidAmount, issuedAt: issuedAt ?? inv0.issuedAt, notes: notes ?? inv0.notes,
          lines: resolvedLines.map((l, i) => ({
            id: l._id, invoiceId: id, productId: l.productId,
            quantity: Math.max(1, l.quantity || 1),
            unitPrice: l.unitPrice, purchasePriceSnapshot: l._resolvedCost,
            vatRate: l.vatRate, taxScheme: l.taxScheme as TaxScheme,
            vatAmount: l.vatAmount, lineTotal: l.lineTotal, position: i + 1,
          })),
          createdAt: inv0.createdAt, createdBy: inv0.createdBy,
        };
        postInvoiceIssued(fresh);
      }

      // 7. Optionale Delta-Zahlung — innerhalb der Transaktion. recordPayment macht
      //    Payment-Insert + Ledger (DR CASH/CR AR, ambient) + ggf. Card-Fee + Nummer-
      //    Finalisierung. (newGross >= projectedPaid ist oben sichergestellt.)
      if (deltaAmount > 0 && deltaPayment) {
        get().recordPayment(id, deltaAmount, deltaPayment.method, undefined, undefined,
          deltaPayment.method === 'card' ? deltaPayment.cardBrand : undefined);
      }

      // 8. Status / paid / tip SSOT-konform aus SUM(payments) (== paid_amount-Invariante).
      //    Korrigiert FINAL→PARTIAL bei Erhoehung; bestaetigt FINAL nach Delta-Zahlung.
      const paidRow = query(`SELECT COALESCE(SUM(amount), 0) AS paid FROM payments WHERE invoice_id = ?`, [id])[0];
      const newPaid = Number(paidRow?.paid || 0);
      const tip = Math.max(0, newPaid - grossAmount);
      const newStatus: InvoiceStatus = newPaid >= grossAmount - 0.005 ? 'FINAL'
        : newPaid > 0.005 ? 'PARTIAL'
        : (inv0.status === 'DRAFT' ? 'DRAFT' : 'PARTIAL');
      db.run(
        `UPDATE invoices SET paid_amount = ?, tip_amount = ?, status = ?, updated_at = ? WHERE id = ?`,
        [newPaid, tip, newStatus, now, id]
      );
      if (newStatus !== inv0.status) trackStatusChange('invoices', id, inv0.status, newStatus);
      // Sync (Scope A): GENAU EIN Full-Row-Snapshot der invoices-Zeile, NACHDEM
      // Header, Totale, Status, paid_amount und tip_amount final sind. trackChange
      // (nicht trackUpdate) → kein Audit-Doppel; invoice_edits + Audit-History bleiben
      // unveraendert. Innerhalb der Tx → atomar mit Lines + Ledger; Rollback verwirft.
      trackChange('invoices', id, 'update', {});

      // 9. Produkt-Reservierung nachziehen (nach finalem Status): erst sync, dann
      //    unreserve, dann reserve (nur solange nicht FINAL).
      for (const pid of productsToSync) syncProductQuantity(pid);
      const isStillUnpaid = newStatus !== 'FINAL';
      for (const pid of productsToSync) {
        unreserveProductIfRestored(pid);
        if (isStillUnpaid) reserveProductIfDepleted(pid);
      }

      // 10. Audit (Punkt 3): invoice_edits-Revision mit vollem Vorher/Nachher-Snapshot
      //     + audit_log-Eintrag (im History-Drawer sichtbar).
      const newSnapshot = JSON.stringify({
        customerId: effCustomerId, status: newStatus,
        netAmount, vatAmount: totalVat, grossAmount, paidAmount: newPaid, taxScheme,
        issuedAt: issuedAt ?? inv0.issuedAt, notes: notes ?? inv0.notes ?? null,
        lines: resolvedLines.map(l => ({
          productId: l.productId, qty: Math.max(1, l.quantity || 1), unitPrice: l.unitPrice,
          vat: l.vatAmount, lineTotal: l.lineTotal, taxScheme: l.taxScheme,
        })),
      });
      let branchId: string; try { branchId = currentBranchId(); } catch { branchId = 'branch-main'; }
      let userId: string; try { userId = currentUserId(); } catch { userId = 'user-owner'; }
      const revRow = query(`SELECT COALESCE(MAX(revision), 0) AS r FROM invoice_edits WHERE invoice_id = ?`, [id])[0];
      const revision = Number(revRow?.r || 0) + 1;
      const editId = uuid();
      db.run(
        `INSERT INTO invoice_edits (id, branch_id, invoice_id, revision, reason, old_snapshot, new_snapshot, edited_by, edited_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [editId, branchId, id, revision, reasonTrim, oldSnapshot, newSnapshot, userId, now]
      );
      trackInsert('invoice_edits', editId, { invoiceId: id, revision });
      logAudit({
        module: 'Sales', entityType: 'invoices', entityId: id, action: 'UPDATE',
        field: `line edit (rev ${revision})`,
        oldValue: `${inv0.grossAmount.toFixed(3)} BHD · ${inv0.status} · ${reasonTrim}`,
        newValue: `${grossAmount.toFixed(3)} BHD · ${newStatus}`,
      });

      commitLedgerTransaction();
    } catch (e) {
      // Punkt 2 / Regel 5: vollstaendiger Rollback. Stores danach auf den
      // zurueckgerollten DB-Stand zurueckziehen (innere Funktionen wie recordPayment
      // koennten Store-State vorzeitig aktualisiert haben).
      rollbackLedgerTransaction();
      get().loadInvoices();
      try { useProductStore.getState().loadProducts(); } catch { /* noop */ }
      throw e;
    }

    // Erfolg: Store-State NACH COMMIT synchronisieren (Invoice + Produkte/Reservierung).
    get().loadInvoices();
    try { useProductStore.getState().loadProducts(); } catch { /* noop */ }
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
          // Konvertierung loggen (Plan §12) — reines Audit; der LAN-Sync laeuft unten ueber
          // den EINEN finalen trackChange (kein zweiter Invoice-Snapshot → keine Doppel-Emitter).
          logAudit({ module: 'Sales', entityType: 'invoices', entityId: invoiceId, action: 'UPDATE',
            field: 'invoice_number', oldValue: inv.invoiceNumber, newValue: newInvoiceNumber });
        }
      }
      // LAN-Sync (Gruppe 3): recordPayment war nur bei Voll-Zahlung gesynct → Teilzahlung / gleicher
      // Status liess paid_amount/status/invoice_number auf B stale. EIN autoritativer Invoice-Full-Row-
      // Snapshot nach dem finalen UPDATE (paid_amount/tip/status/invoice_number/special_mark).
      trackChange('invoices', invoiceId, 'update', {});

      if (wasFullyPaid) {
        // L-03: invoice.paid NUR beim echten Uebergang -> FINAL emittieren. Sonst
        // feuert es bei jeder Zusatz-/Tip-Zahlung auf einen bereits FINALen Beleg
        // erneut, und der einzige Consumer (customer-KPI-Handler) zaehlt Revenue/
        // Profit/PurchaseCount doppelt (Produkt-/Task-Logik dort ist schon idempotent).
        if (prevStatus !== 'FINAL') {
          eventBus.emit('invoice.paid', 'invoice', invoiceId, { amount: newPaid, tip });
        }
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

  // Credit-Modell Slice 3 — Einlösung von Store-Guthaben gegen eine Invoice.
  // Spiegel zum Supplier-'credit'-Muster, aber mit echtem used_amount-Tracking
  // (das die Slice-2-deleteReturn-Teardown-Logik korrekt hält). Ablauf:
  //   1. Cap = min(amount, Invoice-Rest (gross−paid), verfügbares Guthaben).
  //   2. FIFO OPEN-customer_credits konsumieren (used_amount↑, status→USED bei Voll-Verbrauch).
  //   3. recordPayment(method='credit') bucht via cashAccountFor('credit')→CUSTOMER_CREDIT
  //      automatisch DR CUSTOMER_CREDIT / CR AR — kein Geldfluss, reiner Liability/AR-Abbau.
  // Domain (used_amount) und Ledger (CUSTOMER_CREDIT-Saldo) bleiben dadurch spiegelgleich.
  applyCreditToInvoice: (invoiceId, amount, note) => {
    if (!Number.isFinite(amount) || amount <= 0) return 0;
    const db = getDatabase();
    const inv = get().getInvoice(invoiceId);
    if (!inv) return 0;
    if (inv.status === 'CANCELLED') return 0;
    const customerId = inv.customerId;
    let branchId: string;
    try { branchId = currentBranchId(); } catch { branchId = 'branch-main'; }

    // Cap auf den noch offenen Invoice-Rest — verhindert Tip/Über-Zahlung mit Guthaben.
    const remainingOnInvoice = Math.max(0, inv.grossAmount - inv.paidAmount);
    let toApply = Math.min(amount, remainingOnInvoice);
    if (toApply <= 0.005) return 0;

    // FIFO über OPEN-Credits (älteste zuerst). used_amount erhöhen; bei Voll-Verbrauch USED.
    const credits = query(
      `SELECT id, amount, used_amount FROM customer_credits
        WHERE branch_id = ? AND customer_id = ? AND status = 'OPEN'
        ORDER BY created_at ASC`,
      [branchId, customerId]
    );
    let remaining = toApply;
    let consumed = 0;
    for (const c of credits) {
      if (remaining <= 0.005) break;
      const total = Number(c.amount || 0);
      const used = Number(c.used_amount || 0);
      const avail = total - used;
      if (avail <= 0.005) continue;
      const take = Math.min(avail, remaining);
      const newUsed = used + take;
      const newStatus = newUsed >= total - 0.005 ? 'USED' : 'OPEN';
      db.run(`UPDATE customer_credits SET used_amount = ?, status = ? WHERE id = ?`,
        [newUsed, newStatus, c.id as string]);
      trackUpdate('customer_credits', c.id as string, { usedAmount: newUsed, status: newStatus });
      remaining -= take;
      consumed += take;
    }
    if (consumed <= 0.005) return 0;
    saveDatabase();

    // Verrechneten Betrag als Invoice-Payment method='credit' verbuchen — recordPayment
    // erledigt Payment-Insert, Status-Konvertierung (→FINAL) und den Ledger-Post.
    get().recordPayment(invoiceId, consumed, 'credit', note || 'Store-Guthaben verrechnet');
    return consumed;
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
    // M-12 Prerequisite — Payment-IDs VOR dem payments-Delete einsammeln, damit ihre
    // Ledger-Legs (DR CASH/BANK/BENEFIT / CR AR) unten mit-reversiert werden koennen.
    // Sonst bleibt das Geldkonto im Ledger stehen waehrend bankingStore die geloeschte
    // Row fallen laesst → Geldkonto-Drift (balanceOf != bankingStore).
    const linkedPaymentIds = query(
      `SELECT id FROM payments WHERE invoice_id = ?`, [id]
    ).map(r => r.id as string);
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

    // M-12 Prerequisite — die Geld-Legs jeder geloeschten Zahlung mit-reversieren,
    // damit CASH/BANK/BENEFIT im Ledger dem bankingStore folgt (geguardet + idempotent).
    for (const pid of linkedPaymentIds) {
      safePost(`postInvoicePaymentReversed(${pid}) [invoice-delete]`, () => {
        if (!hasLedgerEntries('PAYMENT', pid)) return;
        if (hasReversalFor('PAYMENT', pid)) return;
        postInvoicePaymentReversed(pid);
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
  //
  // Slice 1 (Zahlungsmodell-Bundle) — Ledger-konsistent: Aenderung von Betrag,
  // Methode ODER Empfangsdatum reversiert BEIDE Legs (Geld + Auto-Card-Fee) und
  // bucht sie mit den neuen Werten in EINER SQL-Transaktion neu (gleiche paymentId
  // → Multi-Cycle-Idempotenz via hasReversalFor; created_at unveraendert → das
  // bankingStore-Card-Fee-Netting ueber created_at bleibt intakt). Reine
  // notes-Aenderungen laufen den Leichtgewicht-Pfad ohne Ledger-Churn.
  updatePayment: (paymentId, invoiceId, data) => {
    const db = getDatabase();
    const now = new Date().toISOString();

    // Volle Alt-Row lesen: `data` traegt nur die von der UI geaenderten Felder
    // (pro-Feld-onBlur), card_brand + created_at fehlen dort grundsaetzlich,
    // werden aber fuer Repost (Betrag/Methode) und Card-Fee-Netting gebraucht.
    const oldRows = query(
      `SELECT amount, method, card_brand, notes, received_at, created_at FROM payments WHERE id = ?`,
      [paymentId]
    );
    if (oldRows.length === 0) return; // Payment existiert nicht (mehr).
    const old = oldRows[0];
    const oldAmount = Number(old.amount) || 0;
    const oldMethod = String(old.method);
    const oldCardBrand = (old.card_brand as string | null) ?? null;
    const oldNotes = (old.notes as string | null) ?? null;
    const oldReceivedAt = String(old.received_at);
    const oldCreatedAt = String(old.created_at);

    const newAmount = data.amount !== undefined ? data.amount : oldAmount;
    const newMethod = data.method !== undefined ? String(data.method) : oldMethod;
    const newNotes = data.notes !== undefined ? (data.notes ?? null) : oldNotes;
    const newReceivedAt = data.receivedAt !== undefined ? String(data.receivedAt) : oldReceivedAt;

    // 'credit' (Store-Guthaben-Einloesung) hier nicht editierbar — ein generischer
    // Repost wuerde CUSTOMER_CREDIT ohne used_amount-Buchhaltung bewegen. Kommt im
    // dedizierten Credit-Slice.
    if (newMethod === 'credit' || oldMethod === 'credit') {
      throw new Error('Credit-Zahlungen koennen hier nicht bearbeitet werden.');
    }
    if (newMethod === 'card' && newAmount <= 0) {
      // Karten-Repost braucht amount > 0 (postInvoicePayment wirft sonst).
      throw new Error('Eine Karten-Zahlung muss groesser als 0 sein.');
    }

    const amountChanged = data.amount !== undefined && newAmount !== oldAmount;
    const methodChanged = data.method !== undefined && newMethod !== oldMethod;
    const receivedAtChanged = data.receivedAt !== undefined && newReceivedAt !== oldReceivedAt;
    // Geld-Leg-Ledger haengt an Betrag/Methode (Konto+Hoehe) UND received_at
    // (occurred_at-Datierung) → alle drei loesen Reverse+Repost aus.
    const moneyLegChanged = amountChanged || methodChanged || receivedAtChanged;
    // Card-Fee haengt NUR an Betrag/Methode (nicht am Datum) — eine reine
    // received_at-Korrektur laesst die Fee unveraendert (created_at bleibt gleich).
    const cardFeeChanged = amountChanged || methodChanged;

    // ── Leichtgewicht-Pfad: nichts am Geld-Leg → nur Notiz persistieren. ──
    if (!moneyLegChanged) {
      if (data.notes !== undefined) {
        db.run(`UPDATE payments SET notes = ? WHERE id = ?`, [newNotes, paymentId]);
        saveDatabase();
        trackUpdate('payments', paymentId, { notes: newNotes });
        get().loadInvoices();
      }
      return;
    }

    // card_brand bei 'card' setzen (alten Brand erhalten, sonst 'normal' — die
    // Edit-UI hat keinen Brand-Selektor; die Amex-Unschaerfe bei cash→card ist
    // bewusst dokumentiert und gehoert in einen spaeteren UI-Slice).
    const newCardBrandValue: CardBrand | null =
      newMethod === 'card' ? normalizeCardBrand(oldMethod === 'card' ? oldCardBrand : null) : null;

    const branchId = currentBranchId();
    const userId = currentUserId();
    const inv = get().getInvoice(invoiceId);
    const customerId = inv?.customerId;

    // D3-Guard: zwei Karten-Fees mit IDENTISCHEM created_at koennte das
    // bankingStore-Netting (keyt auf created_at, nicht payment_id) nicht
    // disambiguieren. In diesem seltenen Kollisionsfall NICHT raten → Card-Fee-
    // Schritt ueberspringen + warnen (Geld-Leg keyt auf paymentId, bleibt korrekt).
    // Echte Loesung (Fee per payment_id) = spaeteres Bundle.
    const feeCountRow = query(
      `SELECT COUNT(*) AS n FROM expenses
       WHERE category = 'CardFees' AND related_module = 'invoice' AND related_entity_id = ?
         AND status != 'CANCELLED' AND created_at = ?`,
      [invoiceId, oldCreatedAt]
    );
    const feeCollision = Number(feeCountRow[0]?.n || 0) > 1;
    const touchCardFee = cardFeeChanged && !feeCollision;
    if (cardFeeChanged && feeCollision) {
      console.warn(`[updatePayment] card-fee created_at collision on invoice ${invoiceId} — skipping card-fee re-book for payment ${paymentId}`);
    }

    beginLedgerTransaction();
    try {
      // STEP A — Card-Fee reversieren, wenn sie sich aendert. Unbedingtes Reverse-
      // vor-Rebook macht die Pro-Feld-UI-Sequenz self-healing: erst jede aktive Fee
      // auf oldCreatedAt stornieren, dann (nur bei finaler Karte) neu buchen.
      // reverseCardFees ist idempotent (no-op ohne aktive Fee).
      if (touchCardFee) {
        reverseCardFees('invoice', invoiceId, oldCreatedAt);
      }

      // STEP B — Geld-Leg der alten Zahlung reversieren (geguardet, Multi-Cycle-safe).
      if (hasLedgerEntries('PAYMENT', paymentId) && !hasReversalFor('PAYMENT', paymentId)) {
        postInvoicePaymentReversed(paymentId, now);
      }

      // STEP C — payments-Row auf die neuen Werte setzen (inkl. card_brand).
      db.run(
        `UPDATE payments SET amount = ?, method = ?, card_brand = ?, notes = ?, received_at = ? WHERE id = ?`,
        [newAmount, newMethod, newCardBrandValue, newNotes, newReceivedAt, paymentId]
      );

      // Invoice paid_amount/tip/status nach dem Recompute neu setzen (unveraendert
      // zur alten Logik — nur jetzt INNERHALB der Transaktion).
      const sumRow = query(`SELECT COALESCE(SUM(amount), 0) AS paid FROM payments WHERE invoice_id = ?`, [invoiceId]);
      const newPaid = Number(sumRow[0]?.paid || 0);
      if (inv) {
        const tip = Math.max(0, newPaid - inv.grossAmount);
        const newStatus: InvoiceStatus = newPaid >= inv.grossAmount - 0.005 ? 'FINAL'
          : newPaid > 0 ? 'PARTIAL'
          : (inv.status === 'CANCELLED' ? 'CANCELLED' : 'DRAFT');
        db.run(`UPDATE invoices SET paid_amount = ?, tip_amount = ?, status = ?, updated_at = ? WHERE id = ?`,
          [newPaid, tip, newStatus, now, invoiceId]);
        if (newStatus !== inv.status) trackStatusChange('invoices', invoiceId, inv.status, newStatus);
        // LAN-Sync (Gruppe 3): paid_amount/status/tip nach Recompute → EIN Full-Row-Snapshot.
        trackChange('invoices', invoiceId, 'update', {});
      }

      // STEP D — Geld-Leg mit den NEUEN Werten neu buchen (gleiche paymentId →
      // Multi-Cycle-Idempotenz greift). occurred_at = newReceivedAt.
      if (newAmount > 0) {
        if (!customerId) throw new Error('updatePayment: customerId fehlt — Repost nicht moeglich.');
        postInvoicePayment(
          {
            id: paymentId,
            invoiceId,
            amount: newAmount,
            method: newMethod as PaymentMethod,
            receivedAt: newReceivedAt,
            notes: newNotes ?? undefined,
            createdAt: oldCreatedAt,
          },
          customerId
        );
      }

      // STEP E — Card-Fee neu buchen, wenn die FINALE Methode 'card' ist.
      // created_at = oldCreatedAt → bankingStore-Netting bleibt intakt.
      if (touchCardFee && newMethod === 'card' && newAmount > 0) {
        const label = inv
          ? formatInvoiceDisplay({ invoiceNumber: inv.invoiceNumber, status: inv.status, specialMark: !!inv.specialMark })
          : invoiceId.slice(0, 8);
        bookCardFee({
          branchId, userId, amount: newAmount, brand: newCardBrandValue ?? 'normal',
          relatedModule: 'invoice', relatedEntityId: invoiceId,
          label, createdAt: oldCreatedAt,
        });
      }

      saveDatabase();                    // deferred bis zum aeusseren COMMIT
      trackUpdate('payments', paymentId, data);
      commitLedgerTransaction();
    } catch (e) {
      rollbackLedgerTransaction();
      get().loadInvoices();
      throw e;
    }

    get().loadInvoices();
  },

  // Payment löschen + Invoice paid_amount/Status neu berechnen.
  deletePayment: (paymentId, invoiceId) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    // Slice 1 (Symmetrie zu updatePayment): method + created_at VOR dem DELETE
    // erfassen, um danach die Auto-Card-Fee dieser Zahlung mit-zu-reversieren.
    const delRows = query(`SELECT method, created_at FROM payments WHERE id = ?`, [paymentId]);
    const delMethod = delRows.length ? String(delRows[0].method) : '';
    const delCreatedAt = delRows.length ? String(delRows[0].created_at) : '';
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
      // LAN-Sync (Gruppe 3): paid_amount/status/tip nach Recompute waren ungetrackt → B stale.
      trackChange('invoices', invoiceId, 'update', {});
    }
    saveDatabase();
    trackDelete('payments', paymentId);

    // M-12 Prerequisite — die Geld-Legs dieser Zahlung im Ledger mit-reversieren,
    // sonst bleibt CASH/BANK/BENEFIT stehen obwohl die payment-Row weg ist (geguardet).
    safePost(`postInvoicePaymentReversed(${paymentId}) [payment-delete]`, () => {
      if (!hasLedgerEntries('PAYMENT', paymentId)) return;
      if (hasReversalFor('PAYMENT', paymentId)) return;
      postInvoicePaymentReversed(paymentId);
    });

    // Slice 1 — die Auto-Card-Fee dieser Zahlung mit-stornieren, sonst bleibt eine
    // verwaiste CardFees-Expense (DR EXPENSES / CR CARD_CLEARING) stehen. Bei
    // created_at-Kollision (mehrere Karten-Fees gleichen Zeitstempels) bewusst NICHT
    // raten → ueberspringen + warnen (Geld-Leg keyt auf paymentId, bleibt korrekt).
    if (delMethod === 'card' && delCreatedAt) {
      const feeCountRow = query(
        `SELECT COUNT(*) AS n FROM expenses
         WHERE category = 'CardFees' AND related_module = 'invoice' AND related_entity_id = ?
           AND status != 'CANCELLED' AND created_at = ?`,
        [invoiceId, delCreatedAt]
      );
      const n = Number(feeCountRow[0]?.n || 0);
      if (n === 1) {
        reverseCardFees('invoice', invoiceId, delCreatedAt);
      } else if (n > 1) {
        console.warn(`[deletePayment] card-fee created_at collision on invoice ${invoiceId} — skipping card-fee reversal for deleted payment ${paymentId}`);
      }
    }

    get().loadInvoices();
  },
}));
