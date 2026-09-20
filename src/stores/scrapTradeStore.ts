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
//
// CENTRAL-UI-PARITY R6D — Anlegen, Ändern und Stornieren laufen durch DIESELBE Hausfolge wie die
// Maske und der Fernbefehl (`core/metals/scrap-house`), jeweils in EINER Transaktion. Die
// Store-Einstiege bleiben für synchrone Aufrufer, halten aber keine eigene Logik mehr.
// ═══════════════════════════════════════════════════════════

import { scrapPhotoRefs } from '@/core/metals/scrap-media';
import type { OwnerMediaRef } from '@/core/media/owner-media-resolver';
import type { ScrapLinePhotoRef } from '@/core/models/types';
import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query } from '@/core/db/helpers';
// CENTRAL-UI-PARITY — auf einem Rechner ohne Datenbank holt derselbe Aufruf den Stand vom Primary.
import { hydrateFromPrimary } from '@/core/data/primary-source';
// CENTRAL-UI-PARITY R1 — der Ausweis der Leseanfrage reist als Parameter, nicht als globaler
// Zustand: am Primary aus der eigenen Sitzung, aus der Ferne aus dem geprueften Absender.
import { localReadContext, type BusinessReadContext } from '@/core/data/read-context';
import {
  rowToScrapTrade,
  rowToScrapTradeLine,
  rowToScrapTradePayment,
  type ScrapTrade,
  type ScrapTradeLine,
  type ScrapTradePayment,
} from '@/core/models/types';
import { inOneTransaction, localHouseBranch } from '@/core/metals/metal-house';
import {
  cancelScrapTradeInHouse, createScrapTradeInHouse, updateScrapTradeInHouse,
  type ScrapTradeInput,
} from '@/core/metals/scrap-house';

// Die Eingabeformen wohnen jetzt beim Haus; hier bleiben sie unter ihrem alten Namen erreichbar.
export type { ScrapTradeLineInput, ScrapTradePaymentInput, ScrapTradeInput } from '@/core/metals/scrap-house';

interface ScrapTradeStore {
  trades: ScrapTrade[];
  loadTrades: () => void;
  createTrade: (input: ScrapTradeInput) => string;
  updateTrade: (id: string, input: ScrapTradeInput) => void;
  cancelTrade: (id: string) => void;
  deleteTrade: (id: string) => void;
  getTrade: (id: string) => ScrapTrade | undefined;
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

// ── Store ─────────────────────────────────────────────────────

export const useScrapTradeStore = create<ScrapTradeStore>((set, get) => ({
  trades: [],

  loadTrades: () => {
    if (hydrateFromPrimary('store.scrap_trades.get', (d) => set(d as never))) return;
    // Der Nachtrag fehlender Altdaten ist ein SCHREIBvorgang. Er bleibt deshalb ausschliesslich
    // im Weg des Primary — eine Fernauskunft darf nichts veraendern.
    backfillTradeData();
    set(loadScrapTradesFor(localReadContext()));
  },

  getTrade: (id) => get().trades.find(t => t.id === id),

  createTrade: (input) => {
    const r = inOneTransaction(() => createScrapTradeInHouse(input, localHouseBranch()));
    get().loadTrades();
    return r.tradeId;
  },

  // R6D — die Fassung aus der geladenen Liste wird jetzt GEGEN die Zeile geprüft (vorher nur
  // hochgezählt); ein zwischenzeitlich geändertes Geschäft wird nicht überschrieben.
  updateTrade: (id, input) => {
    const current = get().trades.find(t => t.id === id);
    if (!current) return;
    inOneTransaction(() => updateScrapTradeInHouse(id, current.version, input, localHouseBranch()));
    get().loadTrades();
  },

  // R6D — Umkehrbuchungen und Status in EINER Transaktion, Fassung hoch.
  cancelTrade: (id) => {
    const current = get().trades.find(t => t.id === id);
    if (!current || current.status === 'cancelled') return;
    inOneTransaction(() => cancelScrapTradeInHouse(id, current.version, localHouseBranch()));
    get().loadTrades();
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

/**
 * CENTRAL-UI-PARITY R2B — die Altgold-Geschaefte einer Filiale samt Zeilen und Zahlungen.
 *
 * Zwei Dinge sind hier anders als in der alten Store-Fassung, und beide mit Absicht:
 * der Nachtrag alter Daten (ein Schreibvorgang) bleibt draussen, und die Abfrage ist auf die
 * Filiale des Ausweises eingeschraenkt. Vorher las sie ALLE Filialen — am Ein-Filial-Betrieb
 * faellt das nicht auf, ueber das Netz waere es eine Preisgabe fremder Daten.
 */
/** Eine Medienreferenz in der Form, die eine Geschaeftsauskunft weitergibt. */
function alsFotoReferenz(r: OwnerMediaRef): ScrapLinePhotoRef {
  return {
    mediaId: r.mediaId, key: r.main.storageKey, thumbKey: r.thumbnail?.storageKey ?? null,
    hash: r.main.hash, extension: r.main.extension,
  };
}

export function loadScrapTradesFor(ctx: BusinessReadContext): { trades: ScrapTrade[] } {
  const tradeRows = query(
    `SELECT * FROM scrap_trades WHERE branch_id = ? ORDER BY trade_date DESC, created_at DESC`,
    [ctx.branchId]
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
    // MEDIA-SCRAP — die Fotos als REFERENZEN dazu, in wenigen Abfragen statt einer je Zeile.
    // Eine Liste bleibt damit eine Liste: keine Bytes, keine Daten-URLs.
    for (const [tradeId, list] of linesByTrade) {
      const refs = scrapPhotoRefs(tradeId);
      for (const line of list) {
        const r = refs.get(line.lineKey);
        line.photos = {
          purchase: (r?.purchase ?? []).map(alsFotoReferenz),
          sale: (r?.sale ?? []).map(alsFotoReferenz),
        };
      }
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
  return { trades };
}
