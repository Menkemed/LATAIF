import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { PreciousMetal, MetalStatus } from '@/core/models/types';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, currentBranchId } from '@/core/db/helpers';
import { trackInsert, trackUpdate, trackDelete } from '@/core/sync/track';
import { postMetalPayment, postMetalPaymentReversed, hasLedgerEntries, hasReversalFor } from '@/core/ledger/posting';
// CENTRAL-UI-PARITY R6D — Anlegen, Status und Spotpreis laufen durch DIESELBE Hausfolge wie die
// Maske und der Fernbefehl (`core/metals/metal-house`). Die Store-Einstiege bleiben für ihre
// synchronen Aufrufer, halten aber keine eigene Logik mehr.
import {
  MetalRejected, changeMetalStatusInHouse, createMetalInHouse, inOneTransaction, localHouseBranch,
  metalFromRow, setSpotPriceInHouse, spotPriceOf, type MetalRecord,
} from '@/core/metals/metal-house';
// CENTRAL-UI-PARITY — auf einem Rechner ohne Datenbank holt derselbe Aufruf den Stand vom Primary.
import { hydrateFromPrimary } from '@/core/data/primary-source';
// CENTRAL-UI-PARITY R1 — der Ausweis der Leseanfrage reist als Parameter, nicht als globaler
// Zustand: am Primary aus der eigenen Sitzung, aus der Ferne aus dem geprueften Absender.
import { localReadContext, type BusinessReadContext } from '@/core/data/read-context';

// ZIEL.md §3a — Posting-Service ist der einzige Schreibpfad für Finanzbuchungen.
function safePost(label: string, fn: () => void): void {
  try { fn(); } catch (err) {
    console.error(`[ledger] ${label} failed:`, err);
  }
}

interface MetalStore {
  metals: MetalRecord[];
  loading: boolean;
  loadMetals: () => void;
  getMetal: (id: string) => MetalRecord | undefined;
  createMetal: (data: Partial<PreciousMetal>) => PreciousMetal;
  updateMetal: (id: string, data: Partial<PreciousMetal>) => void;
  deleteMetal: (id: string) => void;
  getSpotPrice: (metalType: string) => number;
  setSpotPrice: (metalType: string, price: number) => void;
  // Plan §8 #4 — Payment-Tracking für Metall-Verkäufe
  recordMetalPayment: (metalId: string, amount: number, method: 'cash' | 'bank' | 'card', date?: string, note?: string) => void;
  getMetalPayments: (metalId: string) => Array<{ id: string; amount: number; method: string; paidAt: string; note?: string }>;
}

export const useMetalStore = create<MetalStore>((set, get) => ({
  metals: [],
  loading: false,

  loadMetals: () => {
    if (hydrateFromPrimary('store.metals.get', (d) => set(d as never))) return;
    try {
      set({ ...loadMetalsFor(localReadContext()), loading: false });
    } catch {
      set({ metals: [], loading: false });
    }
  },

  getMetal: (id) => get().metals.find(m => m.id === id),

  getSpotPrice: (metalType: string): number => {
    try { return spotPriceOf(currentBranchId(), metalType); } catch { return 0; }
  },

  // R6D — dieselbe Hausfolge wie `metals.set_spot_price`; ohne Sitzung kein stilles 'branch-main'.
  setSpotPrice: (metalType: string, price: number) => {
    inOneTransaction(() => setSpotPriceInHouse(metalType, price, localHouseBranch()));
  },

  // R6D — Zeile, Goldbewegung, Lieferantenschuld und Verknüpfung in EINER Transaktion; ein Fehler
  // wirft (vorher blieben bis zu vier getrennte Commits und verschluckte Fehler zurück).
  createMetal: (data) => {
    const r = inOneTransaction(() => createMetalInHouse({
      metalType: data.metalType,
      karat: data.karat,
      weightGrams: data.weightGrams,
      purchaseTotal: data.purchaseTotal,
      purchasePricePerGram: data.purchasePricePerGram,
      supplierId: data.supplierId,
      supplierName: data.supplierName,
      description: data.description,
      notes: data.notes,
    }, localHouseBranch()));
    get().loadMetals();
    return r.metal;
  },

  updateMetal: (id, data) => {
    // R6D — ein Statuswechsel ist KEIN Feldupdate mehr: er geht durch die Hausfolge (nur von „am
    // Lager", Spot/Schmelzwert vom Haus). Vorher ließ sich ein verkauftes Stück einschmelzen und ein
    // zweites Mal verkaufen.
    if (data.status !== undefined) {
      if (data.status !== 'sold' && data.status !== 'melted') {
        throw new MetalRejected('METAL_STATUS_INVALID', 'an item is either sold or melted');
      }
      const status = data.status;
      inOneTransaction(() => changeMetalStatusInHouse({
        metalId: id, status, salePrice: status === 'sold' ? data.salePrice : undefined,
      }, localHouseBranch()));
      get().loadMetals();
      return;
    }

    const db = getDatabase();
    const now = new Date().toISOString();
    const fields: string[] = [];
    const values: unknown[] = [];

    const fieldMap: Record<string, string> = {
      metalType: 'metal_type',
      karat: 'karat',
      weightGrams: 'weight_grams',
      description: 'description',
      purchasePricePerGram: 'purchase_price_per_gram',
      purchaseTotal: 'purchase_total',
      spotPriceAtPurchase: 'spot_price_at_purchase',
      currentSpotPrice: 'current_spot_price',
      meltValue: 'melt_value',
      salePrice: 'sale_price',
      supplierName: 'supplier_name',
      customerId: 'customer_id',
      notes: 'notes',
    };

    for (const [key, val] of Object.entries(data)) {
      const col = fieldMap[key];
      if (col) { fields.push(`${col} = ?`); values.push(val ?? null); }
    }
    if (data.images) { fields.push('images = ?'); values.push(JSON.stringify(data.images)); }

    if (fields.length === 0) return;
    fields.push('updated_at = ?'); values.push(now); values.push(id);
    db.run(`UPDATE precious_metals SET ${fields.join(', ')} WHERE id = ?`, values);
    saveDatabase();
    trackUpdate('precious_metals', id, data);
    get().loadMetals();
  },

  deleteMetal: (id) => {
    const db = getDatabase();
    // M-02 — Ledger-Storno VOR dem Löschen: jede Metal-Zahlung reverst ihr
    // Paar (DR CASH/BANK / CR REVENUE). Sonst bleiben Cash & Revenue als
    // unsichtbarer Orphan verfälscht (Domain-Row weg, Ledger bleibt).
    const pays = query('SELECT id FROM metal_payments WHERE metal_id = ?', [id]);
    for (const p of pays) {
      const payId = p.id as string;
      safePost(`postMetalPaymentReversed(${payId})`, () => {
        if (!hasLedgerEntries('METAL_PAYMENT', payId)) return;
        if (hasReversalFor('METAL_PAYMENT', payId)) return;
        postMetalPaymentReversed(payId);
      });
    }
    db.run('DELETE FROM precious_metals WHERE id = ?', [id]);
    saveDatabase();
    trackDelete('precious_metals', id);
    get().loadMetals();
  },

  // Plan §8 #4 — Metal-Zahlungen. Akkumuliert, leitet paymentStatus + bei voll+status=in_stock auf 'sold' ab.
  recordMetalPayment: (metalId, amount, method, date, note) => {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('Metal payment amount must be a positive number.');
    }
    const db = getDatabase();
    const now = new Date().toISOString();
    const m = get().getMetal(metalId);
    if (!m) return;

    const paymentId = uuid();
    db.run(
      `INSERT INTO metal_payments (id, metal_id, amount, method, paid_at, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [paymentId, metalId, amount, method, date || now.split('T')[0], note || null, now]
    );

    const target = m.salePrice || 0;
    const newPaid = target > 0 ? Math.min(target, (m.paidAmount || 0) + amount) : (m.paidAmount || 0) + amount;
    const newStatus: 'UNPAID' | 'PARTIALLY_PAID' | 'PAID' =
      target > 0 && newPaid >= target - 0.005 ? 'PAID'
      : newPaid > 0 ? 'PARTIALLY_PAID' : 'UNPAID';
    const newMetalStatus: MetalStatus = newStatus === 'PAID' && m.status === 'in_stock' ? 'sold' : m.status;

    db.run(
      `UPDATE precious_metals SET paid_amount = ?, payment_status = ?, status = ?, updated_at = ? WHERE id = ?`,
      [newPaid, newStatus, newMetalStatus, now, metalId]
    );
    saveDatabase();
    trackInsert('metal_payments', paymentId, { metalId, amount, method });
    trackUpdate('precious_metals', metalId, { paidAmount: newPaid, paymentStatus: newStatus, status: newMetalStatus });
    get().loadMetals();

    // ZIEL.md §3a — Metal-Payment ans Ledger.
    safePost(`postMetalPayment(${paymentId})`, () => {
      if (hasLedgerEntries('METAL_PAYMENT', paymentId)) return;
      postMetalPayment({
        id: paymentId, metalId, amount, method,
        paidAt: date || now.split('T')[0],
      });
    });
  },

  getMetalPayments: (metalId) => {
    try {
      const rows = query(
        `SELECT id, amount, method, paid_at, note FROM metal_payments WHERE metal_id = ? ORDER BY paid_at ASC`,
        [metalId]
      );
      return rows.map(r => ({
        id: r.id as string,
        amount: (r.amount as number) || 0,
        method: r.method as string,
        paidAt: r.paid_at as string,
        note: (r.note as string) || undefined,
      }));
    } catch { return []; }
  },
}));

/** CENTRAL-UI-PARITY R2B — die Edelmetall-Bestaende einer Filiale, zustandsfrei (R6D: samt Fassung). */
export function loadMetalsFor(ctx: BusinessReadContext): { metals: MetalRecord[] } {
  const rows = query('SELECT * FROM precious_metals WHERE branch_id = ? ORDER BY updated_at DESC', [ctx.branchId]);
  return { metals: rows.map(metalFromRow) };
}
