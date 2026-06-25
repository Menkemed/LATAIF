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
import {
  postPurchasePayment, postStandaloneSupplierCredit, postExpenseSupplierCreditPayment,
  hasLedgerEntries, hasReversalFor, reverseSource,
  beginLedgerTransaction, commitLedgerTransaction, rollbackLedgerTransaction,
} from '@/core/ledger/posting';
// Slice B — gemeinsamer reiner FIFO-Planer (kein DB/Mutation/Ledger). Der Writer ruft ihn IN
// der Transaktion auf FRISCH geladenen Daten; dieselbe Funktion speist die UI-Vorschau.
import { planSupplierCreditExpenseAllocations } from '@/core/finance/expenseCreditAllocation';

function safePost(label: string, fn: () => void): void {
  try { fn(); } catch (err) {
    console.error(`[ledger] ${label} failed:`, err);
  }
}

// BHD hat 3 Dezimalstellen (Fils). Vergleiche/Rundungen laufen in Minor Units (Fils),
// konsistent zur Projekt-Konvention (posting.ts ROUND, card-fee-booking.ts ROUND3).
// KEINE BHD-Toleranzwerte wie 0.005 — die erlaubten sonst mehrere Fils Schlupf.
const toFils = (n: number) => Math.round(n * 1000);
const round3 = (n: number) => toFils(n) / 1000;

// Option B (read-only) — VOLLSTAENDIGE Validierung der Original-Source-Gruppe eines STANDALONE
// Credits, NICHT nur "ein Asset-Konto existiert". SSOT fuer Anzeige (refundable) UND Refund-Pfad.
// Liefert die Methode (Cash/Bank/Benefit) NUR bei exakt gueltiger Ledger-Struktur fuer
// source_module='SUPPLIER_PREPAYMENT', source_id=creditId:
//   - genau ZWEI Original-Legs (reverses_entry_id IS NULL) — kein drittes, kein fehlendes
//   - genau ein  DR SUPPLIER_CREDIT, Betrag == expectedAmount (Fils)
//   - genau ein  CR CASH|BANK|BENEFIT, Betrag == expectedAmount (Fils) — kein doppeltes Asset-Leg
//   - beide Legs in derselben transaction_id
//   - fuer KEINES der beiden Legs existiert bereits ein Reversal (auch ein TEIL-reversierter
//     Source ist damit nie wieder refundierbar) — zusaetzlich harter Riegel via hasReversalFor
//     (letzter Zyklus geschlossen → sofort raus).
// Jede Abweichung → null = "Unavailable": kein Refund-Button, Store wirft, keine Loeschung,
// keine Ledger-Rueckbuchung. Reines Lesen, kein Schema-/Ledger-Logik-Change.
function validateStandaloneCreditRefundSource(creditId: string, expectedAmount: number): 'Cash' | 'Bank' | 'Benefit' | null {
  try {
    // Letzter Zyklus bereits vollstaendig reversiert → nichts zu refunden.
    if (hasReversalFor('SUPPLIER_PREPAYMENT', creditId)) return null;
    const legs = query(
      `SELECT e1.account AS account, e1.direction AS direction, e1.amount AS amount, e1.transaction_id AS txn,
              (SELECT COUNT(*) FROM ledger_entries e2 WHERE e2.reverses_entry_id = e1.id) AS rev_count
         FROM ledger_entries e1
        WHERE e1.source_module = 'SUPPLIER_PREPAYMENT' AND e1.source_id = ?
          AND e1.reverses_entry_id IS NULL`,
      [creditId]
    );
    if (legs.length !== 2) return null;                                   // genau zwei Original-Legs
    if (legs.some(l => Number(l.rev_count) > 0)) return null;             // kein Leg (auch teil-) reversiert
    const want = toFils(expectedAmount);
    if (legs.some(l => toFils((l.amount as number) || 0) !== want)) return null;  // Betrag matcht Credit (Fils)
    if (new Set(legs.map(l => String(l.txn))).size !== 1) return null;    // beide Legs, eine Transaktion
    const drLeg = legs.find(l => l.account === 'SUPPLIER_CREDIT' && l.direction === 'DEBIT');
    const crLegs = legs.filter(l => l.direction === 'CREDIT'
      && (l.account === 'CASH' || l.account === 'BANK' || l.account === 'BENEFIT'));
    if (!drLeg || crLegs.length !== 1) return null;                       // genau ein DR SC + genau ein CR Asset
    switch (String(crLegs[0].account)) {
      case 'CASH':    return 'Cash';
      case 'BANK':    return 'Bank';
      case 'BENEFIT': return 'Benefit';
      default:        return null;
    }
  } catch { return null; }
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

// Diskriminator der drei Credit-Quellen via NULL-Konvention (kein source_type-Feld):
//   standalone       = source_return_id IS NULL AND source_purchase_id IS NULL
//   purchase_overpay = source_purchase_id IS NOT NULL AND source_return_id IS NULL
//   return           = source_return_id IS NOT NULL
type SupplierCreditKind = 'standalone' | 'purchase_overpay' | 'return';

// Zeile fuer die SUPPLIER-CREDITS-Card: zeigt ALLE offenen Credits typisiert. `method` wird
// nur fuer standalone aus dem Ledger abgeleitet (Option B), sonst null. `refundable` = standalone
// UND used_amount Fils-exakt 0 UND eindeutiges lebendes Asset-Leg (method != null).
export interface SupplierCreditDisplay {
  id: string;
  supplierId: string;
  amount: number;
  usedAmount: number;
  remaining: number;
  status: 'OPEN' | 'USED' | 'EXPIRED';
  createdAt: string;
  kind: SupplierCreditKind;
  method: 'Cash' | 'Bank' | 'Benefit' | null;
  refundable: boolean;
}

// Slice A — Ergebnis der atomaren Credit-gegen-Expense-Einloesung. Slice B zeigt daraus exakt,
// welche Credits (FIFO) auf welche Expenses (FIFO) angewendet wurden.
export interface SupplierCreditExpenseApplication {
  applied: number;   // tatsaechlich angewendeter Gesamtbetrag (== requestedAmount bei Erfolg)
  allocations: Array<{ expenseId: string; creditId: string; paymentId: string; amount: number }>;
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
  // SUPPLIER-CREDITS-Card: ALLE offenen Credits typisiert + (standalone) abgeleitete Methode + Refund-Eignung.
  getSupplierCreditsForDisplay: (supplierId: string) => SupplierCreditDisplay[];
  applyCreditToPurchase: (creditId: string, purchaseId: string, amount: number) => void;
  // Slice A — Supplier-Credits gegen offene supplier-verknuepfte Expenses einloesen. Der Store
  // berechnet den FIFO-Plan (Expenses + Credits, Datum dann ID) INNERHALB der Transaktion aus
  // FRISCH geladenen Daten selbst — die UI gibt KEINEN Allokationsplan als finanzielle Autoritaet vor.
  applySupplierCreditsToExpenses: (supplierId: string, requestedAmount: number, occurredAt?: string) => SupplierCreditExpenseApplication;
  // Standalone Supplier-Prepayment/-Credit (nicht dokument-gebunden) — z.B. PaySupplierModal-Ueberschuss.
  grantStandaloneCredit: (supplierId: string, amount: number, method: 'cash' | 'bank' | 'benefit', note?: string) => string;
  deleteStandaloneSupplierCredit: (creditId: string) => void;
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
  //
  // Outstanding-Fix (dieser Slice): pro AKTIVER Purchase ist der beglichene Betrag
  //   settled = paid_amount (cash/bank/benefit) + Σ purchase_payments(method='credit')
  // — eine Credit-Einloesung (applyCreditToPurchase) fasst paid_amount BEWUSST nicht an
  // (Overpay-Modell), wird aber als purchase_payments-Row method='credit' gefuehrt. Frueher
  // zaehlte getLedger nur paid_amount → eine voll per Credit beglichene Purchase zeigte
  // "OUTSTANDING <total> · 0 open". Jetzt PER-POSTEN: outstanding = max(0, total − settled),
  // Summe ueber alle Posten (eine Ueberzahlung/voll-Settlement einer Purchase darf die
  // Outstanding einer anderen NICHT druecken). totalPaid = Σ total − Σ outstanding = der
  // tatsaechlich beglichene Betrag (cash+bank+benefit+credit). Die paid_amount-SPALTE bleibt
  // cash-only (Overpay-Reconciliation). Cancelled Posten + deren credit-payments sind via
  // status != 'CANCELLED' ausgeschlossen. Reconciliation-Page rechnet AP eigenstaendig
  // (Ledger-vs-Domain) und wird davon NICHT beruehrt; das DASHBOARD "SUPPLIER PAYABLES" liest
  // seit M-24 balanceOf('ACCOUNTS_PAYABLE') — diese getLedger-Domain-Sicht deckt sich danach
  // mit dem Ledger (bei sauberen Daten).
  getLedger: (id) => {
    try {
      const purchaseRows = query(
        `SELECT p.total_amount AS total, p.paid_amount AS paid,
                COALESCE((SELECT SUM(pp.amount) FROM purchase_payments pp
                          WHERE pp.purchase_id = p.id AND pp.method = 'credit'), 0) AS credit_paid
           FROM purchases p WHERE p.supplier_id = ? AND p.status != 'CANCELLED'`,
        [id]
      );
      let purchasesTotal = 0, purchasesOutstanding = 0;
      for (const r of purchaseRows) {
        const total = (r.total as number) || 0;
        const settled = ((r.paid as number) || 0) + ((r.credit_paid as number) || 0);
        purchasesTotal += total;
        purchasesOutstanding += Math.max(0, total - settled);
      }

      // Slice A — Settlement-SSOT: settled = paid_amount (cash) + Σ credit-Einloesungen. paid_amount
      // bleibt cash-only; die credit-Begleichung kommt aus expense_payments(method='credit'). Eine
      // gebuendelte Korrelations-Subquery (kein N+1). Ohne den credit-Anteil bliebe eine credit-
      // beglichene Expense faelschlich im OUTSTANDING.
      const expenseRows = query(
        `SELECT e.amount AS total, e.paid_amount AS paid,
                COALESCE((SELECT SUM(ep.amount) FROM expense_payments ep
                          WHERE ep.expense_id = e.id AND ep.method = 'credit'), 0) AS credit_paid
           FROM expenses e WHERE e.supplier_id = ? AND e.status != 'CANCELLED'`,
        [id]
      );
      let expensesTotal = 0, expensesOutstanding = 0;
      for (const r of expenseRows) {
        const total = (r.total as number) || 0;
        const settled = ((r.paid as number) || 0) + ((r.credit_paid as number) || 0);
        expensesTotal += total;
        expensesOutstanding += Math.max(0, total - settled);
      }

      // totalObligations = Σ aller Supplier-Verpflichtungen (Purchases + Workshop-Expenses).
      // Das IST die Bedeutung des zurueckgegebenen Felds `totalPurchases` (bestehende Konvention,
      // KPI "TOTAL PURCHASES" zeigt Purchases + Workshop). Identitaet damit explizit:
      //   totalPaid = (purchasesTotal + expensesTotal) − outstandingBalance
      // wobei outstandingBalance Purchases- UND Expense-Outstanding enthaelt.
      const totalObligations = purchasesTotal + expensesTotal;
      const outstandingBalance = purchasesOutstanding + expensesOutstanding;
      const totalPaid = totalObligations - outstandingBalance;

      const credit = query(
        `SELECT COALESCE(SUM(amount - used_amount), 0) AS bal
           FROM supplier_credits WHERE supplier_id = ?`,
        [id]
      );
      const creditBalance = Math.max(0, (credit[0]?.bal as number) || 0);

      return {
        totalPurchases: round3(totalObligations),
        totalPaid: round3(totalPaid),
        outstandingBalance: round3(outstandingBalance),
        creditBalance: round3(creditBalance),
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

  // SUPPLIER-CREDITS-Card (dieser Slice): ALLE offenen Credits eines Suppliers mit Typ-
  // Diskriminator (NULL-Konvention), Ursprungs-Methode (nur standalone, Option B aus dem Ledger)
  // und Refund-Eignung. refundable = standalone UND used_amount Fils-exakt 0 UND eindeutiges
  // lebendes Asset-Leg (method != null). Reines Lesen — keine Mutation, kein Schema-Change.
  getSupplierCreditsForDisplay: (supplierId) => {
    try {
      const rows = query(
        `SELECT id, supplier_id, source_return_id, source_purchase_id, amount, used_amount, status, created_at
           FROM supplier_credits WHERE supplier_id = ? AND status = 'OPEN' ORDER BY created_at DESC`,
        [supplierId]
      );
      return rows.map(r => {
        const amount = (r.amount as number) || 0;
        const used = (r.used_amount as number) || 0;
        const kind: SupplierCreditKind = r.source_return_id
          ? 'return'
          : (r.source_purchase_id ? 'purchase_overpay' : 'standalone');
        const method = kind === 'standalone' ? validateStandaloneCreditRefundSource(r.id as string, amount) : null;
        const refundable = kind === 'standalone' && toFils(used) === 0 && method !== null;
        return {
          id: r.id as string,
          supplierId: r.supplier_id as string,
          amount,
          usedAmount: used,
          remaining: Math.max(0, amount - used),
          status: (r.status as 'OPEN' | 'USED' | 'EXPIRED') || 'OPEN',
          createdAt: r.created_at as string,
          kind,
          method,
          refundable,
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

    // Credit-Ueberanwendung verhindern (kein stilles Cappen): der beantragte Betrag darf den
    // echten offenen Rest der Purchase nicht uebersteigen. remaining = total_amount − paid_amount
    // (cash/bank/benefit) − bereits gebuchte credit-payments. Bei Verstoss: harter Abbruch VOR
    // jeder Mutation → kein used_amount-Update, keine purchase_payments-Row, kein Ledger-Post.
    const guardRow = query(`SELECT total_amount, paid_amount FROM purchases WHERE id = ?`, [purchaseId])[0];
    if (!guardRow) throw new Error('Purchase not found for credit application.');
    const guardTotal = (guardRow.total_amount as number) || 0;
    const guardPaid = (guardRow.paid_amount as number) || 0;
    const guardCreditPaid = Number(query(
      `SELECT COALESCE(SUM(amount), 0) AS t FROM purchase_payments WHERE purchase_id = ? AND method = 'credit'`,
      [purchaseId]
    )[0]?.t || 0);
    const purchaseRemaining = guardTotal - guardPaid - guardCreditPaid;
    // Vergleich in Fils (Minor Units), KEINE BHD-Toleranz: amount darf den offenen Rest nicht
    // ueberschreiten — schon 0.001 BHD darueber wird blockiert. remaining 30.000/amount 30.000 ok,
    // remaining 30.000/amount 30.001 → BLOCK. Abbruch VOR jeder Mutation.
    if (toFils(amount) > toFils(purchaseRemaining)) {
      throw new Error(
        `Credit amount (${amount.toFixed(3)}) exceeds the purchase's open balance (${Math.max(0, purchaseRemaining).toFixed(3)}).`
      );
    }

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

  // Slice A — Supplier-Credits gegen offene supplier-verknuepfte Expenses einloesen. AUTORITATIVER
  // Writer: berechnet den FIFO-Plan selbst aus FRISCH (in-Tx) geladenen Daten — die UI gibt keinen
  // Plan vor. ALLES in EINER aeusseren beginLedgerTransaction; jeder Fehler → kompletter Rollback +
  // Throw. Kein safePost, kein await, kein Zwischen-Save, kein Teilcommit. paid_amount bleibt cash-
  // only — die credit-Begleichung lebt in expense_payments(method='credit', reference=creditId) und
  // im Ledger (DR AP / CR SUPPLIER_CREDIT via postExpenseSupplierCreditPayment).
  applySupplierCreditsToExpenses: (supplierId, requestedAmount, occurredAt) => {
    const result: SupplierCreditExpenseApplication = { applied: 0, allocations: [] };
    if (!supplierId) throw new Error('applySupplierCreditsToExpenses: supplierId required.');
    if (!(toFils(requestedAmount) > 0)) throw new Error('Requested amount must be greater than zero.');
    const db = getDatabase();
    const now = new Date().toISOString();
    let branchId = 'branch-main';
    try { branchId = currentBranchId(); } catch { /* default */ }
    const occurred = occurredAt || now;
    const paidAt = occurred.includes('T') ? occurred.split('T')[0] : occurred;

    beginLedgerTransaction();
    try {
      // ── 2-3. Frisch laden: offene supplier-verknuepfte Expenses dieser Branch (settled = cash+credit) ──
      const expenseRows = query(
        `SELECT e.id AS id, e.amount AS amount, e.paid_amount AS paid, e.status AS status, e.created_at AS created_at,
                COALESCE((SELECT SUM(ep.amount) FROM expense_payments ep
                          WHERE ep.expense_id = e.id AND ep.method = 'credit'), 0) AS credit_paid
           FROM expenses e
          WHERE e.supplier_id = ? AND e.branch_id = ? AND e.status != 'CANCELLED'
          ORDER BY e.created_at ASC, e.id ASC`,
        [supplierId, branchId]
      );
      const openExpenses = expenseRows.map(r => {
        const amountF = toFils(Number(r.amount) || 0);
        const settledF = toFils(Number(r.paid) || 0) + toFils(Number(r.credit_paid) || 0);
        return { id: r.id as string, createdAt: (r.created_at as string) || '', amountF, settledF, remF: amountF - settledF };
      }).filter(e => e.remF > 0);

      // ── Frisch laden: offene Credits dieser Branch (available = amount − used_amount) ──
      const creditRows = query(
        `SELECT id, amount, used_amount, created_at FROM supplier_credits
          WHERE supplier_id = ? AND branch_id = ? AND status = 'OPEN'
          ORDER BY created_at ASC, id ASC`,
        [supplierId, branchId]
      );
      const openCredits = creditRows.map(r => {
        const totalF = toFils(Number(r.amount) || 0);
        const usedF = toFils(Number(r.used_amount) || 0);
        const availF = totalF - usedF;
        if (availF < 0) throw new Error('Supplier credit has a negative available balance — data inconsistency.');
        return { id: r.id as string, createdAt: (r.created_at as string) || '', totalF, usedF, availF };
      }).filter(c => c.availF > 0);

      // ── 3+4. Gemeinsamer reiner Planer: validiert Fils-genau (wirft → Rollback) und liefert den
      // FIFO-Plan (Expenses aeltester-zuerst, je Expense aus Credits aeltester-zuerst). KEIN stilles
      // Cappen. Identische Logik wie die UI-Vorschau — der Store bleibt aber die Autoritaet (frisch
      // geladen, in-Tx). ──
      const reqF = toFils(requestedAmount);
      const { allocations } = planSupplierCreditExpenseAllocations(openExpenses, openCredits, reqF);

      // ── 5+8. Pro Allokation: expense_payments-Row (method='credit', reference) + Ledger DIRECT ──
      const creditAppliedF = new Map<string, number>();
      const expenseAppliedF = new Map<string, number>();
      for (const a of allocations) {
        const payId = uuid();
        const amt = a.amountF / 1000;
        db.run(
          `INSERT INTO expense_payments (id, expense_id, amount, method, paid_at, reference, note, created_at)
           VALUES (?, ?, ?, 'credit', ?, ?, 'Applied from supplier credit', ?)`,
          [payId, a.expenseId, amt, paidAt, a.creditId, now]
        );
        trackInsert('expense_payments', payId, { expenseId: a.expenseId, amount: amt, method: 'credit', reference: a.creditId });
        // Ledger DIREKT (kein safePost): wirft → propagiert → Rollback der gesamten Einloesung.
        postExpenseSupplierCreditPayment(payId, a.expenseId, supplierId, amt, occurred);
        creditAppliedF.set(a.creditId, (creditAppliedF.get(a.creditId) || 0) + a.amountF);
        expenseAppliedF.set(a.expenseId, (expenseAppliedF.get(a.expenseId) || 0) + a.amountF);
        result.allocations.push({ expenseId: a.expenseId, creditId: a.creditId, paymentId: payId, amount: amt });
      }

      // ── 6. supplier_credits.used_amount/status (aggregiert je Credit) ──
      for (const [creditId, appliedF] of creditAppliedF) {
        const cr = openCredits.find(c => c.id === creditId)!;
        const newUsedF = cr.usedF + appliedF;
        if (newUsedF > cr.totalF) throw new Error('Internal error: credit over-application detected.');
        const newStatus = newUsedF >= cr.totalF ? 'USED' : 'OPEN';
        db.run(`UPDATE supplier_credits SET used_amount = ?, status = ? WHERE id = ?`, [newUsedF / 1000, newStatus, creditId]);
        trackUpdate('supplier_credits', creditId, { usedAmount: newUsedF / 1000, status: newStatus });
      }

      // ── 7. Expense-Status aus dem Settlement-SSOT (paid_amount UNVERAENDERT = cash-only) ──
      for (const [expenseId, appliedF] of expenseAppliedF) {
        const exp = openExpenses.find(e => e.id === expenseId)!;
        const newSettledF = exp.settledF + appliedF;
        const newStatus = newSettledF >= exp.amountF ? 'PAID' : 'PENDING';
        db.run(`UPDATE expenses SET status = ? WHERE id = ? AND status != 'CANCELLED'`, [newStatus, expenseId]);
        trackUpdate('expenses', expenseId, { status: newStatus });
      }

      result.applied = reqF / 1000;
      commitLedgerTransaction();
    } catch (e) {
      rollbackLedgerTransaction();
      throw e;
    }
    get().loadSuppliers();
    return result;
  },

  // Standalone Supplier-Prepayment/-Credit: Geld an einen Lieferanten ueber dessen offene Posten
  // hinaus. supplier_credits-Row mit source_return_id IS NULL AND source_purchase_id IS NULL
  // (= standalone, disjunkt von Return- und Purchase-Overpay-Credits). Ledger DR SUPPLIER_CREDIT /
  // CR cash atomar in EINER beginLedgerTransaction (Post wirft → rollback, Row faellt mit).
  grantStandaloneCredit: (supplierId, amount, method, note) => {
    const creditId = uuid();
    if (!supplierId || !(amount > 0.005)) return creditId;
    const db = getDatabase();
    const now = new Date().toISOString();
    let branchId = 'branch-main', userId = 'user-owner';
    try { branchId = currentBranchId(); userId = currentUserId(); } catch { /* defaults */ }
    beginLedgerTransaction();
    try {
      db.run(
        `INSERT INTO supplier_credits (id, branch_id, supplier_id, source_return_id, source_purchase_id,
           amount, used_amount, status, note, created_at, created_by)
         VALUES (?, ?, ?, NULL, NULL, ?, 0, 'OPEN', ?, ?, ?)`,
        [creditId, branchId, supplierId, amount, note || 'Supplier prepayment', now, userId]
      );
      trackInsert('supplier_credits', creditId, { supplierId, amount });
      postStandaloneSupplierCredit(creditId, supplierId, amount, method, now);
      commitLedgerTransaction();
    } catch (e) {
      rollbackLedgerTransaction();
      throw e;
    }
    get().loadSuppliers();
    return creditId;
  },

  // Refund eines STANDALONE Supplier-Credits = reales Geld zurueck auf das urspruengliche
  // Cash/Bank/Benefit-Konto (CR SUPPLIER_CREDIT / DR cash via reverseSource) — NICHT nur Row-Delete.
  // Gehaerteter, autoritativer Pfad; die UI darf sich NIE auf einen vorab geladenen used_amount
  // verlassen. Alles wird hier FRISCH aus der DB geprueft:
  //   1. Credit frisch laden  2. beide Source-IDs NULL (= standalone)  3. status='OPEN'
  //   4. used_amount Fils-exakt 0 (schon 0.001 BLOCKT — keine 0.005-Toleranz mehr)
  //   5. genau EIN lebendes, unreversiertes SUPPLIER_PREPAYMENT-Asset-Leg (Cash/Bank/Benefit)
  //   6. erst dann atomar: Ledger reversen + Row loeschen + trackDelete + commit.
  // Jeder verletzte Schritt WIRFT (kein stiller No-op) → die UI meldet nie faelschlich Erfolg,
  // und bei Doppel-Refund/Race gibt es keine zweite Rueckbuchung. NUR fuer standalone Credits —
  // Return-/Purchase-Overpay-Credits sind durch Schritt 2 ausgeschlossen.
  deleteStandaloneSupplierCredit: (creditId) => {
    const db = getDatabase();
    // Read → Validate → Mutate laufen als EINE atomare Einheit INNERHALB der Transaktion:
    // beginLedgerTransaction ZUERST, dann der frische SELECT, die Status-/Fils-Pruefung und die
    // Zwei-Leg-Validierung — alle gegen denselben Snapshot, gegen den anschliessend committed wird.
    // Jeder Fehler rollt die (bis dahin nur lesende) Transaktion zurueck und wirft verstaendlich;
    // keine Loeschung/Rueckbuchung auf Basis veralteter Daten. Frontend-DB = sql.js (eine
    // In-Memory-Verbindung), alles SYNCHRON → KEIN await/Race-Fenster zwischen Validierung und
    // Commit; Cross-Client-Konkurrenz regelt der Sync-Layer (last-writer-wins), nicht SQLite-Locks.
    beginLedgerTransaction();
    try {
      // 2. Credit frisch laden (nur standalone — beide Source-IDs NULL)
      const c = query(
        `SELECT amount, used_amount, status FROM supplier_credits
          WHERE id = ? AND source_return_id IS NULL AND source_purchase_id IS NULL`,
        [creditId]
      )[0];
      if (!c) {
        throw new Error('Supplier credit not found or not a standalone credit — it may have already been refunded or redeemed.');
      }
      // 3. Status + used_amount (Fils-exakt 0, schon 0.001 BLOCKT)
      if (String(c.status) !== 'OPEN') {
        throw new Error('This supplier credit is no longer open and cannot be refunded.');
      }
      if (toFils(Number(c.used_amount) || 0) !== 0) {
        throw new Error('Cannot refund this supplier credit because it has already been (partially) redeemed. Reverse the redemption first.');
      }
      // 4. Vollstaendige Source-Gruppen-Validierung (genau DR SUPPLIER_CREDIT + CR Asset, Betrag ==
      //    amount auf Fils, gleiche Transaktion, kein Leg reversiert). method != null garantiert die
      //    exakte, lebende, unreversierte 2-Leg-Struktur → reverseSource flippt sie vollstaendig.
      const method = validateStandaloneCreditRefundSource(creditId, (c.amount as number) || 0);
      if (!method) {
        throw new Error('Cannot refund: the original Cash/Bank/Benefit ledger entry for this credit is unavailable or invalid (missing, incomplete, amount-mismatched, or already reversed). A refund must book the money back to the original account.');
      }
      // 5. Reversal  6. Row loeschen  7. trackDelete  8. Commit
      reverseSource('SUPPLIER_PREPAYMENT', creditId, new Date().toISOString());
      db.run(`DELETE FROM supplier_credits WHERE id = ?`, [creditId]);
      trackDelete('supplier_credits', creditId);
      commitLedgerTransaction();
    } catch (e) {
      rollbackLedgerTransaction();
      throw e;
    }
    get().loadSuppliers();
  },
}));
