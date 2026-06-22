// ═══════════════════════════════════════════════════════════
// LATAIF — Supplier Store (Plan §Supplier)
// ═══════════════════════════════════════════════════════════

import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { Supplier, PurchasePayment } from '@/core/models/types';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId } from '@/core/db/helpers';
import { trackInsert, trackUpdate, trackDelete } from '@/core/sync/track';
import { trackChange } from '@/core/sync/sync-service';   // sync-only Header-Snapshot (purchases-Status nach Credit-Einloesung)
import { postPurchasePayment, hasLedgerEntries } from '@/core/ledger/posting';

function safePost(label: string, fn: () => void): void {
  try { fn(); } catch (err) {
    console.error(`[ledger] ${label} failed:`, err);
  }
}

// ── SSOT: alle Tabellen/Spalten, die einen Supplier referenzieren ──
// Hat EINE davon einen Treffer, gilt der Supplier als "verknuepft" und darf NICHT
// hart geloescht werden: das Frontend (sql.js) erzwingt keine Foreign Keys, ein
// DELETE wuerde sonst diese 13 Referenzstellen ueber 12 Tabellen verwaisen lassen
// (inkl. offener supplier_credits/gold_payables). Stattdessen deaktivieren
// (active=0 via updateSupplier). Mehrere Spalten/Tabellen teilen sich ein Label
// (repairs+repair_lines → "repair", orders+order_lines → "order") und werden im
// Count aggregiert. Neue Supplier-FK-Tabelle → hier eintragen.
const SUPPLIER_LINK_TABLES: { table: string; column: string; label: string }[] = [
  { table: 'purchases',                   column: 'supplier_id',           label: 'purchase' },
  { table: 'purchase_returns',            column: 'supplier_id',           label: 'purchase return' },
  { table: 'supplier_credits',            column: 'supplier_id',           label: 'supplier credit' },
  { table: 'gold_payables',               column: 'supplier_id',           label: 'gold payable' },
  { table: 'expenses',                    column: 'supplier_id',           label: 'expense' },
  { table: 'recurring_expense_templates', column: 'supplier_id',           label: 'recurring expense' },
  { table: 'repairs',                     column: 'workshop_supplier_id',  label: 'repair' },
  { table: 'repair_lines',                column: 'supplier_id',           label: 'repair' },
  { table: 'scrap_trades',                column: 'buyer_supplier_id',     label: 'scrap trade' },
  { table: 'precious_metals',             column: 'supplier_id',           label: 'metal record' },
  { table: 'orders',                      column: 'goldsmith_supplier_id', label: 'order' },
  { table: 'order_lines',                 column: 'supplier_id',           label: 'order' },
  { table: 'order_lines',                 column: 'ordered_supplier_id',   label: 'order' },
];

/**
 * Zaehlt fuer einen Supplier alle Referenzen ueber SUPPLIER_LINK_TABLES und
 * aggregiert nach Label (nur Treffer mit count > 0). Leeres Array = nirgends
 * referenziert = hart loeschbar. Wirft bei Query-Fehlern bewusst durch (statt
 * "leer" zurueckzugeben), damit ein Schema-Problem nie zu faelschlichem Loeschen
 * verknuepfter Geschaeftsdaten fuehrt.
 */
function querySupplierLinks(id: string): { label: string; count: number }[] {
  const cols = SUPPLIER_LINK_TABLES
    .map((t, i) => `(SELECT COUNT(*) FROM ${t.table} WHERE ${t.column} = ?) AS c${i}`)
    .join(', ');
  const rows = query(`SELECT ${cols}`, SUPPLIER_LINK_TABLES.map(() => id));
  const rec = rows[0] as Record<string, unknown> | undefined;
  const links: { label: string; count: number }[] = [];
  if (!rec) return links;
  SUPPLIER_LINK_TABLES.forEach((t, idx) => {
    const n = Number(rec[`c${idx}`] || 0);
    if (n <= 0) return;
    const existing = links.find(l => l.label === t.label);
    if (existing) existing.count += n;
    else links.push({ label: t.label, count: n });
  });
  return links;
}

/** "2 purchases and 1 expense" — pluralisiert (+s) und verbindet mit Komma/„and". */
function formatSupplierLinks(links: { label: string; count: number }[]): string {
  const parts = links.map(l => `${l.count} ${l.label}${l.count === 1 ? '' : 's'}`);
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

interface SupplierCredit {
  id: string;
  supplierId: string;
  amount: number;
  usedAmount: number;
  remaining: number;
  status: 'OPEN' | 'USED' | 'EXPIRED';
  sourceReturnId?: string;
  sourcePurchaseId?: string;
  note?: string;
  createdAt: string;
}

interface SupplierStore {
  suppliers: Supplier[];
  loading: boolean;
  loadSuppliers: () => void;
  getSupplier: (id: string) => Supplier | undefined;
  createSupplier: (data: Partial<Supplier>) => Supplier;
  updateSupplier: (id: string, data: Partial<Supplier>) => void;
  deleteSupplier: (id: string) => void;
  getLedger: (id: string) => { totalPurchases: number; totalPaid: number; outstandingBalance: number; creditBalance: number };
  // Plan §8 #3 — explizite Credit-Records aus supplier_credits Tabelle
  getOpenCredits: (supplierId: string) => SupplierCredit[];
  applyCreditToPurchase: (creditId: string, purchaseId: string, amount: number) => void;
}

function rowToSupplier(row: Record<string, unknown>): Supplier {
  return {
    id: row.id as string,
    branchId: row.branch_id as string,
    name: row.name as string,
    phone: row.phone as string | undefined,
    email: row.email as string | undefined,
    address: row.address as string | undefined,
    notes: row.notes as string | undefined,
    cpr: (row.cpr as string) || undefined,
    cprImage: (row.cpr_image as string) || undefined,
    active: Number(row.active) === 1,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export const useSupplierStore = create<SupplierStore>((set, get) => ({
  suppliers: [],
  loading: false,

  loadSuppliers: () => {
    try {
      const branchId = currentBranchId();
      const rows = query('SELECT * FROM suppliers WHERE branch_id = ? ORDER BY name', [branchId]);
      const list = rows.map(rowToSupplier);
      // Enrich with ledger numbers
      for (const s of list) {
        Object.assign(s, get().getLedger(s.id));
      }
      set({ suppliers: list, loading: false });
    } catch { set({ suppliers: [], loading: false }); }
  },

  getSupplier: (id) => get().suppliers.find(s => s.id === id),

  createSupplier: (data) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const id = uuid();
    let branchId: string, userId: string;
    try { branchId = currentBranchId(); userId = currentUserId(); }
    catch { branchId = 'branch-main'; userId = 'user-owner'; }

    db.run(
      `INSERT INTO suppliers (id, branch_id, name, phone, email, address, notes, cpr, cpr_image, active, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      [id, branchId, data.name || '', data.phone || null, data.email || null,
       data.address || null, data.notes || null,
       data.cpr || null, data.cprImage || null,
       now, now, userId]
    );
    saveDatabase();
    trackInsert('suppliers', id, { name: data.name });
    get().loadSuppliers();
    return get().getSupplier(id)!;
  },

  updateSupplier: (id, data) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const fields: string[] = [];
    const values: unknown[] = [];
    const map: Record<string, string> = {
      name: 'name', phone: 'phone', email: 'email', address: 'address', notes: 'notes',
      cpr: 'cpr', cprImage: 'cpr_image',
    };
    for (const [k, v] of Object.entries(data)) {
      const col = map[k]; if (col) { fields.push(`${col} = ?`); values.push(v ?? null); }
    }
    if (data.active !== undefined) { fields.push('active = ?'); values.push(data.active ? 1 : 0); }
    if (fields.length === 0) return;
    fields.push('updated_at = ?'); values.push(now); values.push(id);
    db.run(`UPDATE suppliers SET ${fields.join(', ')} WHERE id = ?`, values);
    saveDatabase();
    trackUpdate('suppliers', id, data);
    get().loadSuppliers();
  },

  deleteSupplier: (id) => {
    // Guard (Product/N1-Muster): ein Supplier mit IRGENDEINER Verknuepfung darf
    // nicht hart geloescht werden — sonst verwaisen verknuepfte Geschaeftsdaten
    // (Frontend erzwingt keine FKs). Bei Treffern wirft die Meldung; die UI
    // faengt sie und zeigt einen Alert. Stattdessen deaktivieren (active=0).
    const links = querySupplierLinks(id);
    if (links.length > 0) {
      throw new Error(`Cannot delete supplier — referenced by ${formatSupplierLinks(links)}. Mark as inactive instead.`);
    }
    const db = getDatabase();
    db.run('DELETE FROM suppliers WHERE id = ?', [id]);
    saveDatabase();
    trackDelete('suppliers', id);
    get().loadSuppliers();
  },

  // Plan §Supplier §4: computed from purchases/payments.
  // Slice 4b-Fix: creditBalance = Σ (amount − used_amount) aus supplier_credits (ALLE Quellen:
  // Return-Credits refund_method='credit' UND Purchase-Ueberzahlung source_return_id IS NULL),
  // konsistent mit domainSupplierCredit. Frueher nur purchase_returns → Overpay-Credits unsichtbar.
  // Plan §Repair §Workshop-as-Supplier: zusätzlich fließen Repair-Expenses
  // (category='RepairCosts', supplier_id=?) in die Bilanz ein, damit Workshop-
  // Forderungen sichtbar werden — gleicher Ledger, unterschiedliche Quellen.
  getLedger: (id) => {
    try {
      const p = query(
        `SELECT COALESCE(SUM(total_amount),0) as t, COALESCE(SUM(paid_amount),0) as paid
         FROM purchases WHERE supplier_id = ? AND status != 'CANCELLED'`,
        [id]
      );
      const purchasesTotal = (p[0]?.t as number) || 0;
      const purchasesPaid = (p[0]?.paid as number) || 0;

      const e = query(
        `SELECT COALESCE(SUM(amount),0) as t, COALESCE(SUM(paid_amount),0) as paid
         FROM expenses WHERE supplier_id = ? AND status != 'CANCELLED'`,
        [id]
      );
      const expensesTotal = (e[0]?.t as number) || 0;
      const expensesPaid = (e[0]?.paid as number) || 0;

      const totalPurchases = purchasesTotal + expensesTotal;
      const totalPaid = purchasesPaid + expensesPaid;

      const credit = query(
        `SELECT COALESCE(SUM(amount - used_amount), 0) AS bal
           FROM supplier_credits WHERE supplier_id = ?`,
        [id]
      );
      const creditBalance = Math.max(0, (credit[0]?.bal as number) || 0);

      // outstandingBalance = totalPurchases − totalPaid (Domain-Wahrheit), damit
      // die per-Supplier-KPI mit der sichtbaren Detail-Tabelle uebereinstimmt
      // (itemisierte Sicht → Domain, M-24-Scope-Entscheid). Das DASHBOARD-Aggregat
      // "SUPPLIER PAYABLES" liest seit M-24 dagegen das Ledger
      // (balanceOf('ACCOUNTS_PAYABLE', {counterpartyType:'SUPPLIER'})) — beide
      // koennen bei Alt-Daten-Luecken abweichen (z.B. historische Repair-Expenses
      // ohne Ledger-Post, Legacy-Expenses mit paid_amount ohne payment-Rows);
      // die Reconciliation-Page macht den Ledger-vs-Domain-Vergleich sichtbar.
      const outstandingBalance = totalPurchases - totalPaid;

      return {
        totalPurchases,
        totalPaid,
        outstandingBalance,
        creditBalance,
      };
    } catch {
      return { totalPurchases: 0, totalPaid: 0, outstandingBalance: 0, creditBalance: 0 };
    }
  },

  // Plan §8 #3 — offene Credit-Records aus supplier_credits (neu eingeführte Tabelle).
  getOpenCredits: (supplierId) => {
    try {
      const rows = query(
        `SELECT id, supplier_id, source_return_id, source_purchase_id, amount, used_amount, status, note, created_at
           FROM supplier_credits WHERE supplier_id = ? AND status = 'OPEN' ORDER BY created_at DESC`,
        [supplierId]
      );
      return rows.map(r => {
        const amount = (r.amount as number) || 0;
        const used = (r.used_amount as number) || 0;
        return {
          id: r.id as string,
          supplierId: r.supplier_id as string,
          amount,
          usedAmount: used,
          remaining: Math.max(0, amount - used),
          status: (r.status as 'OPEN' | 'USED' | 'EXPIRED') || 'OPEN',
          sourceReturnId: (r.source_return_id as string) || undefined,
          sourcePurchaseId: (r.source_purchase_id as string) || undefined,
          note: (r.note as string) || undefined,
          createdAt: r.created_at as string,
        };
      });
    } catch { return []; }
  },

  // Plan §8 #3 — Credit auf einen Purchase anwenden: used_amount erhöhen, Purchase als bezahlt verbuchen.
  applyCreditToPurchase: (creditId, purchaseId, amount) => {
    if (amount <= 0) return;
    const db = getDatabase();
    const now = new Date().toISOString();
    const cRows = query(`SELECT amount, used_amount FROM supplier_credits WHERE id = ?`, [creditId]);
    if (cRows.length === 0) return;
    const total = (cRows[0].amount as number) || 0;
    const used = (cRows[0].used_amount as number) || 0;
    const available = total - used;
    const apply = Math.min(amount, available);
    if (apply <= 0) return;

    const newUsed = used + apply;
    const newStatus = newUsed >= total - 0.005 ? 'USED' : 'OPEN';
    db.run(
      `UPDATE supplier_credits SET used_amount = ?, status = ? WHERE id = ?`,
      [newUsed, newStatus, creditId]
    );
    // Als Purchase-Payment mit method='credit' verbuchen.
    const payId = uuid();
    const paidAt = now.split('T')[0];
    db.run(
      `INSERT INTO purchase_payments (id, purchase_id, amount, method, paid_at, reference, note, created_at)
       VALUES (?, ?, ?, 'credit', ?, ?, 'Applied from supplier credit', ?)`,
      [payId, purchaseId, apply, paidAt, creditId, now]
    );
    // Slice 4b-Fix — Purchase-Status/Outstanding spiegeln die Credit-Einloesung, OHNE die Overpay-
    // Basis paid_amount zu veraendern (die bleibt bewusst credit-frei; sonst zoege reconcile-
    // PurchaseOverpayCredit eine Phantom-Ueberzahlung). settled = paid_amount + Σ credit-Payments →
    // nur die Display-Felder status/remaining_amount werden nachgezogen.
    const stRow = query(`SELECT total_amount, paid_amount FROM purchases WHERE id = ?`, [purchaseId])[0];
    if (stRow) {
      const totalAmt = (stRow.total_amount as number) || 0;
      const paidAmt = (stRow.paid_amount as number) || 0;
      const creditPaid = Number(query(
        `SELECT COALESCE(SUM(amount), 0) AS t FROM purchase_payments WHERE purchase_id = ? AND method = 'credit'`,
        [purchaseId]
      )[0]?.t || 0);
      const settled = paidAmt + creditPaid;
      const newRemaining = Math.max(0, totalAmt - settled);
      const purStatus = settled >= totalAmt - 0.005 ? 'PAID' : (settled > 0.005 ? 'PARTIALLY_PAID' : 'UNPAID');
      db.run(`UPDATE purchases SET remaining_amount = ?, status = ?, updated_at = ? WHERE id = ?`,
        [newRemaining, purStatus, now, purchaseId]);
      trackChange('purchases', purchaseId, 'update', {});
    }
    saveDatabase();
    trackUpdate('supplier_credits', creditId, { usedAmount: newUsed, status: newStatus });
    trackInsert('purchase_payments', payId, { purchaseId, amount: apply, method: 'credit' });

    // Ledger-Post: Method='credit' bucht AP runter ↔ SUPPLIER_CREDIT runter (kein Cash).
    // Ohne den Post bleibt sowohl die A/P-Reduktion als auch der Credit-Verbrauch unsichtbar
    // im zentralen Ledger → Reconciliation-Page hat dauerhaft eine Diskrepanz.
    const supRow = query(`SELECT supplier_id FROM purchases WHERE id = ?`, [purchaseId])[0];
    const supplierId = (supRow?.supplier_id as string) || '';
    if (supplierId) {
      const payment: PurchasePayment = {
        id: payId,
        purchaseId,
        amount: apply,
        method: 'credit',
        paidAt,
        reference: creditId,
        note: 'Applied from supplier credit',
        createdAt: now,
      };
      safePost(`postPurchasePayment(${payId}) [credit]`, () => {
        if (hasLedgerEntries('PURCHASE_PAYMENT', payId)) return;
        postPurchasePayment(payment, supplierId);
      });
    }
  },
}));
