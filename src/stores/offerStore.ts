import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { Offer, OfferLine, OfferStatus } from '@/core/models/types';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId, getNextNumber } from '@/core/db/helpers';
import { eventBus } from '@/core/events/event-bus';
import { vatEngine } from '@/core/tax/vat-engine';
import { trackInsert, trackUpdate, trackDelete } from '@/core/sync/track';

interface OfferStore {
  offers: Offer[];
  loading: boolean;
  loadOffers: () => void;
  getOffer: (id: string) => Offer | undefined;
  createOffer: (customerId: string, lines: { productId: string; unitPrice: number; taxScheme: string; purchasePrice: number }[], notes?: string, validUntil?: string) => Offer;
  updateOffer: (id: string, data: Partial<Offer>) => void;
  updateOfferLine: (offerId: string, lineId: string, data: Partial<OfferLine>) => void;
  addOfferLine: (offerId: string, line: { productId: string; unitPrice: number; taxScheme: string; purchasePrice: number }) => void;
  removeOfferLine: (offerId: string, lineId: string) => void;
  deleteOffer: (id: string) => void;
  getNextOfferNumber: () => string;
  recalcOfferTotals: (offerId: string) => void;
}

function getVatRate(): number {
  try {
    const db = getDatabase();
    const branchId = currentBranchId();
    const r = db.exec(`SELECT value FROM settings WHERE branch_id = ? AND key = 'vat.standard_rate'`, [branchId]);
    if (r.length > 0 && r[0].values.length > 0) return Number(r[0].values[0][0]);
  } catch { /* */ }
  return 10;
}

function rowToOffer(row: Record<string, unknown>): Offer {
  return {
    id: row.id as string,
    offerNumber: row.offer_number as string,
    customerId: row.customer_id as string,
    status: (row.status as OfferStatus) || 'draft',
    validUntil: row.valid_until as string | undefined,
    currency: (row.currency as Offer['currency']) || 'BHD',
    subtotal: (row.subtotal as number) || 0,
    vatRate: (row.vat_rate as number) || 0,
    vatAmount: (row.vat_amount as number) || 0,
    total: (row.total as number) || 0,
    taxScheme: (row.tax_scheme as Offer['taxScheme']) || 'MARGIN',
    notes: row.notes as string | undefined,
    sentAt: row.sent_at as string | undefined,
    sentVia: row.sent_via as Offer['sentVia'],
    followUpAt: row.follow_up_at as string | undefined,
    lines: [],
    invoiceId: row.invoice_id as string | undefined,
    createdAt: row.created_at as string,
    createdBy: row.created_by as string | undefined,
  };
}

function rowToLine(row: Record<string, unknown>): OfferLine {
  return {
    id: row.id as string,
    offerId: row.offer_id as string,
    productId: row.product_id as string,
    unitPrice: (row.unit_price as number) || 0,
    vatRate: (row.vat_rate as number) || 0,
    taxScheme: (row.tax_scheme as OfferLine['taxScheme']) || 'MARGIN',
    lineTotal: (row.line_total as number) || 0,
    position: (row.position as number) || 1,
  };
}

export const useOfferStore = create<OfferStore>((set, get) => ({
  offers: [],
  loading: false,

  loadOffers: () => {
    try {
      const branchId = currentBranchId();
      const rows = query('SELECT * FROM offers WHERE branch_id = ? ORDER BY created_at DESC', [branchId]);
      const offers = rows.map(r => {
        const offer = rowToOffer(r);
        const lineRows = query('SELECT * FROM offer_lines WHERE offer_id = ? ORDER BY position', [offer.id]);
        offer.lines = lineRows.map(rowToLine);
        return offer;
      });
      set({ offers, loading: false });
    } catch { set({ offers: [], loading: false }); }
  },

  getOffer: (id) => get().offers.find(o => o.id === id),

  getNextOfferNumber: () => getNextNumber('offers', 'offer.number_prefix', 'OFF'),

  createOffer: (customerId, lines, notes, validUntil) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const id = uuid();
    const vatRate = getVatRate();
    let branchId: string, userId: string;
    try { branchId = currentBranchId(); userId = currentUserId(); }
    catch { branchId = 'branch-main'; userId = 'user-owner'; }

    const offerNumber = get().getNextOfferNumber();

    // Plan §Tax §7: Netto-Eingabe. Total = Summe aus grossAmount (Kundenpreis).
    let totalGross = 0;
    let totalVat = 0;
    const offerLines: OfferLine[] = lines.map((l, i) => {
      const calc = vatEngine.calculateNet(l.unitPrice, l.purchasePrice, l.taxScheme as any, vatRate);
      totalGross += calc.grossAmount;
      totalVat += calc.vatAmount;
      return {
        id: uuid(), offerId: id, productId: l.productId,
        unitPrice: l.unitPrice, vatRate, taxScheme: l.taxScheme as any,
        lineTotal: calc.grossAmount, position: i + 1,
      };
    });

    const subtotal = totalGross - totalVat;
    const total = totalGross;

    db.run(
      `INSERT INTO offers (id, branch_id, offer_number, customer_id, status, valid_until, currency,
        subtotal, vat_rate, vat_amount, total, notes, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, 'draft', ?, 'BHD', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, branchId, offerNumber, customerId, validUntil || null,
       subtotal, vatRate, totalVat, total, notes || null, now, now, userId]
    );

    const lineStmt = db.prepare(
      `INSERT INTO offer_lines (id, offer_id, product_id, unit_price, vat_rate, tax_scheme, line_total, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const l of offerLines) {
      lineStmt.run([l.id, id, l.productId, l.unitPrice, l.vatRate, l.taxScheme, l.lineTotal, l.position]);
    }
    lineStmt.free();

    saveDatabase();
    trackInsert('offers', id, { offerNumber, customerId, total });
    eventBus.emit('offer.created', 'offer', id, { customerId, total });
    get().loadOffers();

    return { id, offerNumber, customerId, status: 'draft' as OfferStatus, currency: 'BHD' as const,
      subtotal, vatRate, vatAmount: totalVat, total, taxScheme: 'MARGIN' as const,
      lines: offerLines, createdAt: now, notes, validUntil };
  },

  updateOffer: (id, data) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const fields: string[] = [];
    const values: unknown[] = [];

    const map: Record<string, string> = {
      status: 'status', notes: 'notes', validUntil: 'valid_until',
      sentAt: 'sent_at', sentVia: 'sent_via', followUpAt: 'follow_up_at',
      subtotal: 'subtotal', vatAmount: 'vat_amount', total: 'total',
      customerId: 'customer_id', offerNumber: 'offer_number',
    };

    for (const [k, v] of Object.entries(data)) {
      const col = map[k];
      if (col) { fields.push(`${col} = ?`); values.push(v); }
    }

    if (fields.length === 0) return;
    fields.push('updated_at = ?'); values.push(now); values.push(id);
    db.run(`UPDATE offers SET ${fields.join(', ')} WHERE id = ?`, values);
    saveDatabase();
    trackUpdate('offers', id, data);

    // Emit status change events for automation
    if (data.status === 'sent') {
      const offer = get().getOffer(id);
      eventBus.emit('offer.sent', 'offer', id, { offerNumber: offer?.offerNumber, customerId: offer?.customerId });
    } else if (data.status === 'accepted') {
      const offer = get().getOffer(id);
      eventBus.emit('offer.accepted', 'offer', id, { offerNumber: offer?.offerNumber, customerId: offer?.customerId });
    } else if (data.status === 'rejected') {
      eventBus.emit('offer.rejected', 'offer', id, {});
    }

    get().loadOffers();
  },

  updateOfferLine: (offerId, lineId, data) => {
    const db = getDatabase();
    const fields: string[] = [];
    const values: unknown[] = [];
    if (data.unitPrice !== undefined) { fields.push('unit_price = ?'); values.push(data.unitPrice); }
    if (data.taxScheme) { fields.push('tax_scheme = ?'); values.push(data.taxScheme); }
    if (data.lineTotal !== undefined) { fields.push('line_total = ?'); values.push(data.lineTotal); }
    if (fields.length === 0) return;
    values.push(lineId);
    db.run(`UPDATE offer_lines SET ${fields.join(', ')} WHERE id = ?`, values);
    saveDatabase();
    // Recalculate offer totals
    get().recalcOfferTotals(offerId);
    get().loadOffers();
  },

  addOfferLine: (offerId, line) => {
    const db = getDatabase();
    const vatRate = getVatRate();
    const calc = vatEngine.calculateNet(line.unitPrice, line.purchasePrice, line.taxScheme as any, vatRate);
    const lineId = uuid();
    const pos = (get().getOffer(offerId)?.lines.length || 0) + 1;
    db.run(
      `INSERT INTO offer_lines (id, offer_id, product_id, unit_price, vat_rate, tax_scheme, line_total, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [lineId, offerId, line.productId, line.unitPrice, vatRate, line.taxScheme, calc.grossAmount, pos]
    );
    saveDatabase();
    get().recalcOfferTotals(offerId);
    get().loadOffers();
  },

  removeOfferLine: (offerId, lineId) => {
    const db = getDatabase();
    db.run(`DELETE FROM offer_lines WHERE id = ?`, [lineId]);
    saveDatabase();
    get().recalcOfferTotals(offerId);
    get().loadOffers();
  },

  deleteOffer: (id) => {
    const db = getDatabase();
    db.run(`DELETE FROM offer_lines WHERE offer_id = ?`, [id]);
    db.run(`DELETE FROM offers WHERE id = ?`, [id]);
    saveDatabase();
    trackDelete('offers', id);
    get().loadOffers();
  },

  recalcOfferTotals: (offerId: string) => {
    const db = getDatabase();
    const lineRows = query('SELECT * FROM offer_lines WHERE offer_id = ?', [offerId]);
    let subtotal = 0;
    let totalVat = 0;
    for (const l of lineRows) {
      subtotal += l.unit_price as number;
      totalVat += (l.line_total as number) - (l.unit_price as number);
    }
    const total = subtotal + totalVat;
    const now = new Date().toISOString();
    db.run(`UPDATE offers SET subtotal = ?, vat_amount = ?, total = ?, updated_at = ? WHERE id = ?`,
      [subtotal, totalVat, total, now, offerId]);
    saveDatabase();
  },
}));
