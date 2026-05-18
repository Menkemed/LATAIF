// ═══════════════════════════════════════════════════════════
// LATAIF — Scrap Gold Quick Trade Store (Multi-Line + Split-Payments)
//
// Direkter Altgold-Handel: mehrere Items pro Trade, jeweils Spread
// = Sale - Purchase. Trade-weite Split-Payments pro Direction:
// Seller bekommt mehrere Methoden (z.B. 200 cash + 300 benefit),
// Buyer zahlt mehrere Methoden (z.B. 300 cash + 600 bank).
//
// Ledger bucht reale Brutto-Cash-Flows + Spread als REVENUE.
// Banking surfaced jede Split-Zeile separat.
// ═══════════════════════════════════════════════════════════

import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId } from '@/core/db/helpers';
import {
  rowToScrapTrade,
  rowToScrapTradeLine,
  rowToScrapTradePayment,
  type ScrapTrade,
  type ScrapTradeLine,
  type ScrapTradePayment,
  type ScrapPaymentMethod,
} from '@/core/models/types';
import {
  postScrapTrade,
  reverseTransaction,
} from '@/core/ledger/posting';

// Input-Shape pro Line beim Create/Update (ohne IDs, Position, Timestamps —
// die füllt der Store auf).
export interface ScrapTradeLineInput {
  weightGrams: number;
  karat: string;
  purchasePrice: number;
  salePrice: number;
  notes?: string;
  imagesPurchase?: string[];
  imagesSale?: string[];
}

export interface ScrapTradePaymentInput {
  method: ScrapPaymentMethod;
  amount: number;
}

export interface ScrapTradeInput {
  sellerName: string;
  sellerPhone?: string;
  sellerCustomerId?: string;
  buyerName: string;
  buyerPhone?: string;
  buyerSupplierId?: string;
  tradeDate: string;
  notes?: string;
  lines: ScrapTradeLineInput[];
  paymentsOut: ScrapTradePaymentInput[];   // Splits zum Seller
  paymentsIn: ScrapTradePaymentInput[];    // Splits vom Buyer
}

interface ScrapTradeStore {
  trades: ScrapTrade[];
  loadTrades: () => void;
  createTrade: (input: ScrapTradeInput) => string;
  updateTrade: (id: string, input: ScrapTradeInput) => void;
  cancelTrade: (id: string) => void;
  deleteTrade: (id: string) => void;
  getTrade: (id: string) => ScrapTrade | undefined;
}

// ── Helpers ────────────────────────────────────────────────────

const EPSILON = 0.001;

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function computeAggregates(lines: ScrapTradeLineInput[]): {
  weightGrams: number;
  karat: string;
  purchasePrice: number;
  salePrice: number;
  profit: number;
} {
  const weight = lines.reduce((s, l) => s + (Number(l.weightGrams) || 0), 0);
  const purchase = lines.reduce((s, l) => s + (Number(l.purchasePrice) || 0), 0);
  const sale = lines.reduce((s, l) => s + (Number(l.salePrice) || 0), 0);
  const uniqueKarats = Array.from(new Set(lines.map(l => l.karat).filter(Boolean)));
  const karat = uniqueKarats.length === 1 ? uniqueKarats[0] : 'mixed';
  return {
    weightGrams: round3(weight),
    karat,
    purchasePrice: round3(purchase),
    salePrice: round3(sale),
    profit: round3(sale - purchase),
  };
}

function sumPayments(splits: ScrapTradePaymentInput[]): number {
  return round3(splits.reduce((s, p) => s + (Number(p.amount) || 0), 0));
}

function validatePayments(
  paymentsOut: ScrapTradePaymentInput[],
  paymentsIn: ScrapTradePaymentInput[],
  totalPurchase: number,
  totalSale: number,
): void {
  if (!paymentsOut.length) throw new Error('At least one payment out is required');
  if (!paymentsIn.length) throw new Error('At least one payment in is required');
  const sOut = sumPayments(paymentsOut);
  const sIn = sumPayments(paymentsIn);
  if (Math.abs(sOut - totalPurchase) > EPSILON) {
    throw new Error(`Payment OUT (${sOut.toFixed(3)}) must equal Total Purchase (${totalPurchase.toFixed(3)})`);
  }
  if (Math.abs(sIn - totalSale) > EPSILON) {
    throw new Error(`Payment IN (${sIn.toFixed(3)}) must equal Total Sale (${totalSale.toFixed(3)})`);
  }
  for (const p of [...paymentsOut, ...paymentsIn]) {
    if (!(Number(p.amount) > 0)) {
      throw new Error('Each payment split must have amount > 0');
    }
  }
}

function nextTradeNumber(branchId: string): string {
  const rows = query(
    `SELECT trade_number FROM scrap_trades WHERE branch_id = ?`,
    [branchId]
  );
  let max = 0;
  for (const r of rows) {
    const n = parseInt(String(r.trade_number).replace(/\D/g, ''), 10);
    if (!isNaN(n) && n > max) max = n;
  }
  return `SGT-${String(max + 1).padStart(6, '0')}`;
}

function latestUnreversedTransactionFor(tradeId: string): string | null {
  const rows = query(
    `SELECT le.transaction_id, MIN(le.recorded_at) AS ts
       FROM ledger_entries le
      WHERE le.source_module = 'SCRAP_TRADE'
        AND le.source_id = ?
        AND le.reverses_entry_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM ledger_entries r WHERE r.reverses_entry_id = le.id
        )
   GROUP BY le.transaction_id
   ORDER BY ts DESC
      LIMIT 1`,
    [tradeId]
  );
  return rows.length > 0 ? (rows[0].transaction_id as string) : null;
}

// Backfill: für jeden bestehenden scrap_trades-Eintrag ohne Lines/Payments
// einen Default aus den Aggregat-Feldern erzeugen. Idempotent.
function backfillTradeData(): void {
  const db = getDatabase();

  // 1. Lines
  const lineOrphans = query(
    `SELECT st.id, st.weight_grams, st.karat, st.purchase_price, st.sale_price, st.profit,
            st.images_purchase, st.images_sale, st.created_at
       FROM scrap_trades st
      WHERE NOT EXISTS (
        SELECT 1 FROM scrap_trade_lines stl WHERE stl.scrap_trade_id = st.id
      )`
  );
  for (const o of lineOrphans) {
    db.run(
      `INSERT INTO scrap_trade_lines (
        id, scrap_trade_id, position, weight_grams, karat,
        purchase_price, sale_price, profit, notes,
        images_purchase, images_sale, created_at
      ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      [
        uuid(), o.id, o.weight_grams, o.karat,
        o.purchase_price, o.sale_price, o.profit,
        o.images_purchase || '[]',
        o.images_sale || '[]',
        o.created_at,
      ]
    );
  }

  // 2. Payments: für Trades ohne payments-Einträge die Legacy-Felder
  //    payment_method_purchase / payment_method_sale als 1-Split-Default ablegen.
  const paymentOrphans = query(
    `SELECT st.id, st.purchase_price, st.sale_price,
            st.payment_method_purchase, st.payment_method_sale, st.created_at
       FROM scrap_trades st
      WHERE NOT EXISTS (
        SELECT 1 FROM scrap_trade_payments stp WHERE stp.scrap_trade_id = st.id
      )`
  );
  for (const o of paymentOrphans) {
    const outMethod = (o.payment_method_purchase as string) || 'cash';
    const inMethod = (o.payment_method_sale as string) || 'cash';
    const purchase = Number(o.purchase_price) || 0;
    const sale = Number(o.sale_price) || 0;
    if (purchase > 0) {
      db.run(
        `INSERT INTO scrap_trade_payments (id, scrap_trade_id, direction, method, amount, position, created_at)
         VALUES (?, ?, 'OUT', ?, ?, 1, ?)`,
        [uuid(), o.id, outMethod, purchase, o.created_at]
      );
    }
    if (sale > 0) {
      db.run(
        `INSERT INTO scrap_trade_payments (id, scrap_trade_id, direction, method, amount, position, created_at)
         VALUES (?, ?, 'IN', ?, ?, 1, ?)`,
        [uuid(), o.id, inMethod, sale, o.created_at]
      );
    }
  }

  if (lineOrphans.length > 0 || paymentOrphans.length > 0) {
    saveDatabase();
  }
}

function insertLines(db: ReturnType<typeof getDatabase>, tradeId: string, lines: ScrapTradeLineInput[], createdAt: string): void {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const purchase = round3(Number(l.purchasePrice) || 0);
    const sale = round3(Number(l.salePrice) || 0);
    db.run(
      `INSERT INTO scrap_trade_lines (
        id, scrap_trade_id, position, weight_grams, karat,
        purchase_price, sale_price, profit, notes,
        images_purchase, images_sale, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuid(), tradeId, i + 1,
        round3(Number(l.weightGrams) || 0), l.karat,
        purchase, sale, round3(sale - purchase),
        l.notes || null,
        JSON.stringify(l.imagesPurchase || []),
        JSON.stringify(l.imagesSale || []),
        createdAt,
      ]
    );
  }
}

function insertPayments(
  db: ReturnType<typeof getDatabase>,
  tradeId: string,
  paymentsOut: ScrapTradePaymentInput[],
  paymentsIn: ScrapTradePaymentInput[],
  createdAt: string,
): void {
  for (let i = 0; i < paymentsOut.length; i++) {
    const p = paymentsOut[i];
    db.run(
      `INSERT INTO scrap_trade_payments (id, scrap_trade_id, direction, method, amount, position, created_at)
       VALUES (?, ?, 'OUT', ?, ?, ?, ?)`,
      [uuid(), tradeId, p.method, round3(Number(p.amount) || 0), i + 1, createdAt]
    );
  }
  for (let i = 0; i < paymentsIn.length; i++) {
    const p = paymentsIn[i];
    db.run(
      `INSERT INTO scrap_trade_payments (id, scrap_trade_id, direction, method, amount, position, created_at)
       VALUES (?, ?, 'IN', ?, ?, ?, ?)`,
      [uuid(), tradeId, p.method, round3(Number(p.amount) || 0), i + 1, createdAt]
    );
  }
}

// ── Store ─────────────────────────────────────────────────────

export const useScrapTradeStore = create<ScrapTradeStore>((set, get) => ({
  trades: [],

  loadTrades: () => {
    backfillTradeData();
    const tradeRows = query(
      `SELECT * FROM scrap_trades ORDER BY trade_date DESC, created_at DESC`
    );
    const ids = tradeRows.map(t => String(t.id));
    const linesByTrade = new Map<string, ScrapTradeLine[]>();
    const paymentsOutByTrade = new Map<string, ScrapTradePayment[]>();
    const paymentsInByTrade = new Map<string, ScrapTradePayment[]>();

    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      const lineRows = query(
        `SELECT * FROM scrap_trade_lines
         WHERE scrap_trade_id IN (${placeholders})
         ORDER BY position ASC`,
        ids
      );
      for (const row of lineRows) {
        const line = rowToScrapTradeLine(row);
        const list = linesByTrade.get(line.scrapTradeId) || [];
        list.push(line);
        linesByTrade.set(line.scrapTradeId, list);
      }

      const pmtRows = query(
        `SELECT * FROM scrap_trade_payments
         WHERE scrap_trade_id IN (${placeholders})
         ORDER BY direction, position ASC`,
        ids
      );
      for (const row of pmtRows) {
        const pmt = rowToScrapTradePayment(row);
        const target = pmt.direction === 'OUT' ? paymentsOutByTrade : paymentsInByTrade;
        const list = target.get(pmt.scrapTradeId) || [];
        list.push(pmt);
        target.set(pmt.scrapTradeId, list);
      }
    }

    const trades = tradeRows.map(r =>
      rowToScrapTrade(
        r,
        linesByTrade.get(String(r.id)) || [],
        paymentsOutByTrade.get(String(r.id)) || [],
        paymentsInByTrade.get(String(r.id)) || [],
      )
    );
    set({ trades });
  },

  getTrade: (id) => get().trades.find(t => t.id === id),

  createTrade: (input) => {
    if (!input.lines || input.lines.length === 0) {
      throw new Error('Scrap trade requires at least one item');
    }
    const agg = computeAggregates(input.lines);
    validatePayments(input.paymentsOut, input.paymentsIn, agg.purchasePrice, agg.salePrice);

    const id = uuid();
    const branchId = currentBranchId();
    const now = new Date().toISOString();

    const db = getDatabase();
    // payment_method_purchase / payment_method_sale werden hier nur als
    // "primäre Methode" (erste Split) gespeichert, damit Banking-Reports
    // einen Default haben. SSOT sind die scrap_trade_payments-Rows.
    db.run(
      `INSERT INTO scrap_trades (
        id, branch_id, trade_number,
        seller_name, seller_phone, seller_customer_id,
        buyer_name, buyer_phone, buyer_supplier_id,
        weight_grams, karat,
        purchase_price, sale_price, profit,
        payment_method_purchase, payment_method_sale,
        trade_date, notes, images_purchase, images_sale, status,
        created_at, updated_at, created_by, version, sync_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', 'completed', ?, ?, ?, 1, 'pending')`,
      [
        id, branchId, nextTradeNumber(branchId),
        (input.sellerName || '').trim(), input.sellerPhone || null, input.sellerCustomerId || null,
        (input.buyerName || '').trim(), input.buyerPhone || null, input.buyerSupplierId || null,
        agg.weightGrams, agg.karat,
        agg.purchasePrice, agg.salePrice, agg.profit,
        input.paymentsOut[0]?.method || 'cash',
        input.paymentsIn[0]?.method || 'cash',
        input.tradeDate, input.notes || null,
        now, now, currentUserId() || null,
      ]
    );

    insertLines(db, id, input.lines, now);
    insertPayments(db, id, input.paymentsOut, input.paymentsIn, now);

    postScrapTrade({
      id,
      tradeDate: input.tradeDate,
      paymentsOut: input.paymentsOut,
      paymentsIn: input.paymentsIn,
    });
    saveDatabase();

    get().loadTrades();
    return id;
  },

  updateTrade: (id, input) => {
    const current = get().trades.find(t => t.id === id);
    if (!current) return;
    if (current.status === 'cancelled') {
      throw new Error('Cannot edit a cancelled trade');
    }
    if (!input.lines || input.lines.length === 0) {
      throw new Error('Scrap trade requires at least one item');
    }
    const agg = computeAggregates(input.lines);
    validatePayments(input.paymentsOut, input.paymentsIn, agg.purchasePrice, agg.salePrice);

    const now = new Date().toISOString();
    const db = getDatabase();
    db.run(
      `UPDATE scrap_trades SET
        seller_name = ?, seller_phone = ?, seller_customer_id = ?,
        buyer_name = ?, buyer_phone = ?, buyer_supplier_id = ?,
        weight_grams = ?, karat = ?,
        purchase_price = ?, sale_price = ?, profit = ?,
        payment_method_purchase = ?, payment_method_sale = ?,
        trade_date = ?, notes = ?,
        updated_at = ?, version = ?, sync_status = 'pending'
       WHERE id = ?`,
      [
        (input.sellerName || '').trim(), input.sellerPhone || null, input.sellerCustomerId || null,
        (input.buyerName || '').trim(), input.buyerPhone || null, input.buyerSupplierId || null,
        agg.weightGrams, agg.karat,
        agg.purchasePrice, agg.salePrice, agg.profit,
        input.paymentsOut[0]?.method || 'cash',
        input.paymentsIn[0]?.method || 'cash',
        input.tradeDate, input.notes || null,
        now, current.version + 1,
        id,
      ]
    );

    // Lines + Payments komplett ersetzen
    db.run(`DELETE FROM scrap_trade_lines WHERE scrap_trade_id = ?`, [id]);
    db.run(`DELETE FROM scrap_trade_payments WHERE scrap_trade_id = ?`, [id]);
    insertLines(db, id, input.lines, now);
    insertPayments(db, id, input.paymentsOut, input.paymentsIn, now);

    // Ledger reverse + repost
    const lastTxId = latestUnreversedTransactionFor(id);
    if (lastTxId) reverseTransaction(lastTxId, now);
    postScrapTrade({
      id,
      tradeDate: input.tradeDate,
      paymentsOut: input.paymentsOut,
      paymentsIn: input.paymentsIn,
    });
    saveDatabase();

    get().loadTrades();
  },

  cancelTrade: (id) => {
    const current = get().trades.find(t => t.id === id);
    if (!current || current.status === 'cancelled') return;
    const now = new Date().toISOString();
    const db = getDatabase();
    db.run(
      `UPDATE scrap_trades SET status = 'cancelled', updated_at = ?, sync_status = 'pending' WHERE id = ?`,
      [now, id]
    );

    const lastTxId = latestUnreversedTransactionFor(id);
    if (lastTxId) reverseTransaction(lastTxId, now);
    saveDatabase();

    set(s => ({
      trades: s.trades.map(t => t.id === id ? { ...t, status: 'cancelled', updatedAt: now } : t),
    }));
  },

  deleteTrade: (id) => {
    const current = get().trades.find(t => t.id === id);
    if (!current || current.status !== 'cancelled') {
      throw new Error('Only cancelled trades can be deleted');
    }
    const db = getDatabase();
    db.run(`DELETE FROM scrap_trades WHERE id = ?`, [id]);
    saveDatabase();
    set(s => ({ trades: s.trades.filter(t => t.id !== id) }));
  },
}));
