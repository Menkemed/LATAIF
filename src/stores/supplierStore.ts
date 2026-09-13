// ═══════════════════════════════════════════════════════════
// LATAIF — Supplier Store (Plan §Supplier)
// ═══════════════════════════════════════════════════════════

import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { Supplier } from '@/core/models/types';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId } from '@/core/db/helpers';
import { trackInsert, trackUpdate, trackDelete } from '@/core/sync/track';
// CENTRAL-UI-PARITY R6D — Guthaben einloesen, gewaehren und zurueckbuchen laufen durch DIE
// Hausfolge, die auch der Fernbefehl ruft (Filiale aus dem Rahmen, strikt gebucht, feste Codes).
// Die Store-Aktionen bleiben mit ihrer Signatur und klammern sich selbst atomar.
import {
  atomar, localHouseCtx, validateStandaloneCreditRefundSource,
  applyOneCreditToPurchaseInHouse, applySupplierCreditToExpensesInHouse,
  grantStandaloneCreditInHouse, refundStandaloneCreditInHouse, type PayMethod,
} from '@/core/payables/payables-house';
// CENTRAL-UI-PARITY — auf einem Rechner ohne Datenbank holt derselbe Aufruf den Stand vom Primary.
import { hydrateFromPrimary } from '@/core/data/primary-source';
// CENTRAL-UI-PARITY R1 — der Ausweis der Leseanfrage reist als Parameter, nicht als globaler
// Zustand: am Primary aus der eigenen Sitzung, aus der Ferne aus dem geprueften Absender.
import { localReadContext, type BusinessReadContext } from '@/core/data/read-context';
// CENTRAL-UI-PARITY R6C — die eine Stammdaten-Regel (Name Pflicht und getrimmt, Texte getrimmt).
import { supplierCreateInput, supplierUpdateInput } from '@/core/masterdata/masterdata-rules';

// BHD hat 3 Dezimalstellen (Fils). Vergleiche/Rundungen laufen in Minor Units (Fils),
// konsistent zur Projekt-Konvention (posting.ts ROUND, card-fee-booking.ts ROUND3).
// KEINE BHD-Toleranzwerte wie 0.005 — die erlaubten sonst mehrere Fils Schlupf.
const toFils = (n: number) => Math.round(n * 1000);
const round3 = (n: number) => toFils(n) / 1000;

// Option B (read-only) — die VOLLSTAENDIGE Validierung der Original-Source-Gruppe eines STANDALONE
// Credits steht seit R6D in `payables-house.ts` (`validateStandaloneCreditRefundSource`): EINE
// Pruefung fuer Anzeige (refundable) UND Rueckbuchung.

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

// SUPPLIER-CREDITS-Card: eine Zeile mit Typ-Diskriminator (NULL-Konvention), Ursprungs-Methode (nur
// standalone, Option B aus dem Ledger) und Refund-Eignung. Reines Lesen.
function creditDisplayRow(r: Record<string, unknown>): SupplierCreditDisplay {
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
}

export const useSupplierStore = create<SupplierStore>((set, get) => ({
  suppliers: [],
  loading: false,

  loadSuppliers: () => {
    if (hydrateFromPrimary('store.suppliers.get', (d) => set(d as never))) return;
    try {
      set({ ...loadSuppliersFor(localReadContext()), loading: false });
    } catch { set({ suppliers: [], loading: false }); }
  },

  getSupplier: (id) => get().suppliers.find(s => s.id === id),

  createSupplier: (data) => {
    // R6C — vorher prüfte nur die Maske (zwei von drei ließen einen Namen aus Leerzeichen durch,
    // nur eine trimmte). Jetzt prüft die Hausfunktion selbst — für jeden Einstieg, am Primary wie fern.
    const input = supplierCreateInput(data as Record<string, unknown>);
    const db = getDatabase();
    const now = new Date().toISOString();
    const id = uuid();
    let branchId: string, userId: string;
    try { branchId = currentBranchId(); userId = currentUserId(); }
    catch { branchId = 'branch-main'; userId = 'user-owner'; }

    db.run(
      `INSERT INTO suppliers (id, branch_id, name, phone, email, address, notes, cpr, cpr_image, active, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      [id, branchId, input.name, input.phone ?? null, input.email ?? null,
       input.address ?? null, input.notes ?? null,
       input.cpr ?? null, input.cprImage ?? null,
       now, now, userId]
    );
    saveDatabase();
    trackInsert('suppliers', id, { name: input.name });
    get().loadSuppliers();
    return get().getSupplier(id)!;
  },

  updateSupplier: (id, data) => {
    // R6C — ein geleertes Namensfeld schrieb bisher einen leeren Namen. Dieselbe Regel wie beim Anlegen.
    const input = supplierUpdateInput(data as Record<string, unknown>);
    const db = getDatabase();
    const now = new Date().toISOString();
    const fields: string[] = [];
    const values: unknown[] = [];
    const map: Record<string, string> = {
      name: 'name', phone: 'phone', email: 'email', address: 'address', notes: 'notes',
      cpr: 'cpr', cprImage: 'cpr_image',
    };
    for (const [k, v] of Object.entries(input)) {
      const col = map[k]; if (col) { fields.push(`${col} = ?`); values.push(v ?? null); }
    }
    if (input.active !== undefined) { fields.push('active = ?'); values.push(input.active ? 1 : 0); }
    if (fields.length === 0) return;
    fields.push('updated_at = ?'); values.push(now); values.push(id);
    db.run(`UPDATE suppliers SET ${fields.join(', ')} WHERE id = ?`, values);
    saveDatabase();
    trackUpdate('suppliers', id, input);
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
  getLedger: (id) => supplierLedgerFor(id),


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

  // SUPPLIER-CREDITS-Card (dieser Slice): ALLE offenen Credits eines Suppliers typisiert.
  // R6D — die Masken lesen jetzt `supplierCreditsFor` (filialgebunden, auch auf PC2); dieser
  // Store-Weg bleibt fuer bestehende Aufrufer.
  getSupplierCreditsForDisplay: (supplierId) => {
    try {
      const rows = query(
        `SELECT id, supplier_id, source_return_id, source_purchase_id, amount, used_amount, status, created_at
           FROM supplier_credits WHERE supplier_id = ? AND status = 'OPEN' ORDER BY created_at DESC`,
        [supplierId]
      );
      return rows.map(creditDisplayRow);
    } catch { return []; }
  },

  // Plan §8 #3 — Credit auf einen Purchase anwenden: used_amount erhöhen, Purchase als bezahlt verbuchen.
  // R6D — EINE genannte Zeile, strikt: kein stilles Kappen auf das Verfuegbare, Filiale geprueft,
  // Buchung DR AP / CR SUPPLIER_CREDIT ohne `safePost`. Die Maske benutzt jetzt den FIFO des Hauses
  // (`purchases.apply_credit`); dieser Weg bleibt fuer bestehende Aufrufer.
  applyCreditToPurchase: (creditId, purchaseId, amount) => {
    atomar(() => applyOneCreditToPurchaseInHouse(creditId, purchaseId, amount, localHouseCtx()));
    get().loadSuppliers();
  },

  // Slice A — Supplier-Credits gegen offene supplier-verknuepfte Expenses einloesen. AUTORITATIVER
  // Writer: berechnet den FIFO-Plan selbst aus FRISCH (in-Tx) geladenen Daten — die UI gibt keinen
  // Plan vor. paid_amount bleibt cash-only — die credit-Begleichung lebt in expense_payments
  // (method='credit', reference=creditId) und im Ledger (DR AP / CR SUPPLIER_CREDIT).
  // R6D — der Schreiber lebt jetzt als `applySupplierCreditToExpensesInHouse` im Haus (dieselbe
  // Folge, Filiale aus dem Rahmen statt stillem 'branch-main', feste Codes); „Pay Supplier → Credit"
  // ruft ihn am Primary und fern (`suppliers.apply_credit`). Die Store-Aktion klammert sich selbst.
  applySupplierCreditsToExpenses: (supplierId, requestedAmount, occurredAt) => {
    const result = atomar(() => applySupplierCreditToExpensesInHouse(supplierId, requestedAmount, localHouseCtx(), occurredAt));
    get().loadSuppliers();
    return result;
  },

  // Standalone Supplier-Prepayment/-Credit: Geld an einen Lieferanten ueber dessen offene Posten
  // hinaus (DR SUPPLIER_CREDIT / CR cash). R6D — Hausfolge, strikt (vorher: stiller No-op bei 0).
  grantStandaloneCredit: (supplierId, amount, method, note) => {
    const creditId = atomar(() => grantStandaloneCreditInHouse(supplierId, amount, method as PayMethod, note, localHouseCtx()));
    get().loadSuppliers();
    return creditId;
  },

  // Refund eines STANDALONE Supplier-Credits = reales Geld zurueck auf das urspruengliche
  // Cash/Bank/Benefit-Konto (CR SUPPLIER_CREDIT / DR cash via reverseSource) — NICHT nur Row-Delete.
  // R6D — dieselbe gehaertete Folge (frisch lesen, standalone, OPEN, unbenutzt, lebende Quelle) im
  // Haus, jetzt mit Filialpruefung; jeder verletzte Schritt WIRFT.
  deleteStandaloneSupplierCredit: (creditId) => {
    atomar(() => refundStandaloneCreditInHouse(creditId, localHouseCtx()));
    get().loadSuppliers();
  },
}));

/**
 * CENTRAL-UI-PARITY R2A — die gemeinsame Ladefunktion fuer Lieferanten samt ihren Ledger-Zahlen.
 *
 * Zustandsfrei: kein `set`, kein `get`, kein `currentBranchId()`. Die Filiale kommt aus dem
 * Ausweis, den der Aufrufer mitbringt — am Primary aus der eigenen Sitzung, aus der Ferne aus dem
 * geprueften Absender. Damit koennen beide Wege dieselbe Funktion benutzen, ohne dass das Lesen
 * des einen den Bildschirm des anderen anfasst.
 */
export function loadSuppliersFor(ctx: BusinessReadContext): { suppliers: Supplier[] } {
  const rows = query('SELECT * FROM suppliers WHERE branch_id = ? ORDER BY name', [ctx.branchId]);
  const suppliers = rows.map(rowToSupplier);
  // Die Ledger-Zahlen gehoeren zur Anzeige eines Lieferanten; sie werden hier mitgerechnet, damit
  // beide Wege dieselbe Zeile sehen. Die Rechnung selbst ist unveraendert.
  for (const s of suppliers) Object.assign(s, supplierLedgerFor(s.id));
  return { suppliers };
}

/**
 * CENTRAL-UI-PARITY R6D — die offenen Guthaben EINES Lieferanten in DER Filiale des Anfragenden
 * (Auskunft `suppliers.credits.get`). Einkauf (Credit-Modus), Sammelzahlung (Guthaben-Modus) und
 * die Guthaben-Karte lasen sie bisher direkt aus der Datenbank — auf PC2 also nie, und am Primary
 * ohne Filialgrenze. `availableAmount` ist der Betrag, gegen den das Haus beim Einloesen prueft.
 */
export function supplierCreditsFor(ctx: BusinessReadContext, supplierId: string): { credits: SupplierCreditDisplay[]; availableAmount: number } {
  if (!supplierId) return { credits: [], availableAmount: 0 };
  const rows = query(
    `SELECT id, supplier_id, source_return_id, source_purchase_id, amount, used_amount, status, created_at
       FROM supplier_credits WHERE supplier_id = ? AND branch_id = ? AND status = 'OPEN' ORDER BY created_at DESC, id DESC`,
    [supplierId, ctx.branchId]
  );
  const credits = rows.map(creditDisplayRow);
  const availableF = credits.reduce((s, c) => s + Math.max(0, toFils(c.amount) - toFils(c.usedAmount)), 0);
  return { credits, availableAmount: availableF / 1000 };
}

/**
 * CENTRAL-UI-PARITY R2A — die Ledger-Zahlen eines Lieferanten, als freie Funktion.
 *
 * Sie war nur als Store-Methode verpackt; gerechnet hat sie immer schon aus der Datenbank. Jetzt
 * koennen der Primary-Store UND die gemeinsame Ladefunktion sie benutzen, ohne einen
 * Zustandsspeicher anzufassen.
 */
export function supplierLedgerFor(id: string): { totalPurchases: number; totalPaid: number; outstandingBalance: number; creditBalance: number } {
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
}
