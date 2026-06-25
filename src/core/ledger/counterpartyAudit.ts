// ═══════════════════════════════════════════════════════════
// LATAIF — Per-Counterparty Reconciliation (READ-ONLY Diagnostik)
// ───────────────────────────────────────────────────────────
// Ergänzt die globale ReconciliationPage um eine Counterparty-Achse:
// AR je Kunde, Customer-Credit je Kunde, AP je Lieferant, Supplier-Credit
// je Lieferant, plus Credit-Integritäts-Befunde. Deckt den Netting-Blindspot
// der branch-weiten Konto-Totale ab (Kunde A +10 / Kunde B −10 = global 0,
// per-Kunde aber zwei Mismatches).
//
// HARTE INVARIANTE — DIESES MODUL IST VOLLSTÄNDIG READ-ONLY:
//   • Jeglicher DB-Zugriff läuft ausschließlich über den injizierten `run`-Runner.
//   • `run` darf NUR SELECT/WITH ausführen (im Test instrumentiert + erzwungen).
//   • Keine Imports von db-Helpern/Stores/Posting zur LAUFZEIT (nur `import type`).
//   • Keine Inserts/Updates/Deletes/Posts/Reversals/Backfills.
//
// SSOT: Die Domain-Formeln spiegeln 1:1 die globalen `domainAR/domainAP/
// domainCustomerCredit/domainSupplierCredit` aus ReconciliationPage.tsx
// (CANCELLED-/CardFees-/Overpay-Cap-Regeln identisch). Die Ledger-Seite nutzt
// dieselbe Netto-Mechanik wie `balanceOf` (DEBIT−CREDIT bzw. CREDIT−DEBIT je
// nach natürlichem Vorzeichen; Reversierungen netten sich als Gegenzeilen weg).
//
// FILS-GENAU: Alle Vergleiche laufen in Integer-Fils (toFils = round(n*1000)).
// `status==='ok'` GENAU DANN, wenn `diffFils === 0` — bereits 1 Fils ist Mismatch.
// (Die globale Page behält ihre 0.01-BHD-Float-Toleranz; diese strengere Regel
//  gilt nur für die neuen Counterparty-Checks.)
// ═══════════════════════════════════════════════════════════

import type { LedgerAccount } from './posting';

/** Read-only SQL-Runner. Bekommt SQL + Positions-Parameter, liefert Zeilen-Objekte.
 *  Die Page injiziert den echten `query`; Tests injizieren einen node:sqlite-Runner,
 *  der jeden Nicht-SELECT verwirft (= Read-only-Beweis). */
export type SqlRunner = (sql: string, params?: unknown[]) => Array<Record<string, unknown>>;

// ── Result-Typen ──────────────────────────────────────────────

export interface CpRow {
  id: string;                 // counterparty_id ('__UNASSIGNED__' = keine Counterparty)
  name: string;               // aufgelöster Anzeigename, sonst id
  account: LedgerAccount;
  domainFils: number;         // Integer-Fils
  ledgerFils: number;         // Integer-Fils
  diffFils: number;           // ledgerFils − domainFils
  status: 'ok' | 'mismatch';  // ok ⇔ diffFils === 0
}

export interface CpSection {
  title: string;
  account: LedgerAccount;
  rows: CpRow[];
  checked: number;            // Anzahl geprüfter Counterparties (mit Aktivität)
  mismatches: number;         // rows mit status === 'mismatch'
  netDiffFils: number;        // Σ diffFils (kann sich wegnetten)
  sumAbsDiffFils: number;     // Σ |diffFils| (nettet NICHT weg)
  ok: boolean;                // mismatches === 0
}

export type CreditIssueSeverity = 'error' | 'warning' | 'info';

export type CreditIssueKind =
  | 'credit_no_ledger'        // Domain-Credit-Row ohne erwartete Ledger-Gruppe
  | 'ledger_no_credit'        // Ledger-Credit-Gruppe ohne passende Domain-Row
  | 'missing_counterparty'    // Credit/AR/AP-Ledgerzeile ohne counterparty_id
  | 'wrong_counterparty_type' // Konto impliziert Typ, counterparty_type weicht ab
  | 'bad_reference'           // method='credit'-Payment ohne gültige reference
  | 'overused'               // used_amount > amount / amount<=0 / used<0
  | 'inconsistent_status'     // status passt nicht zu used_amount
  | 'orphan_payment'          // credit_applications zeigt auf fehlende Row
  | 'used_drift';             // used_amount ≠ Σ Einlösungen

export interface CreditIssue {
  kind: CreditIssueKind;
  severity: CreditIssueSeverity;
  side: 'customer' | 'supplier';
  entityId: string;           // betroffene Row/Ledger-id
  counterpartyId?: string;
  amountFils?: number;
  detail: string;             // genaue Ursache
}

export interface CounterpartyAudit {
  arByCustomer: CpSection;
  customerCreditByCustomer: CpSection;
  apBySupplier: CpSection;
  supplierCreditBySupplier: CpSection;
  issues: CreditIssue[];
  queryCount: number;         // tatsächliche Anzahl SELECTs (Perf/N+1-Nachweis)
}

// ── Fils + Vorzeichen ─────────────────────────────────────────

const toFils = (n: unknown): number => Math.round((Number(n) || 0) * 1000);

// Natürliches Vorzeichen der vier relevanten Konten (Spiegel von queries.ts NATURAL_DEBIT):
//   +1 = DEBIT-natur (Saldo = DEBIT − CREDIT), −1 = CREDIT-natur (Saldo = CREDIT − DEBIT)
const ACCOUNT_SIGN: Record<string, 1 | -1> = {
  ACCOUNTS_RECEIVABLE: 1,
  CUSTOMER_CREDIT: -1,
  ACCOUNTS_PAYABLE: -1,
  SUPPLIER_CREDIT: 1,
};

const UNASSIGNED = '__UNASSIGNED__';

// ── Ledger-Seite: gruppiert je counterparty_id (1 Query / 2 Konten) ──────────
// Liefert account → (counterparty_id → signierte Fils). Kein reverses_entry_id-
// Filter: Reversierungen sind Gegenzeilen und netten sich in der SUM weg (wie balanceOf).

function ledgerMaps(run: SqlRunner, branchId: string, accounts: LedgerAccount[]): Map<string, Map<string, number>> {
  const placeholders = accounts.map(() => '?').join(',');
  const rows = run(
    `SELECT COALESCE(counterparty_id,'') AS cid, account,
            COALESCE(SUM(CASE WHEN direction='DEBIT'  THEN amount ELSE 0 END),0) AS d,
            COALESCE(SUM(CASE WHEN direction='CREDIT' THEN amount ELSE 0 END),0) AS c
     FROM ledger_entries
     WHERE branch_id=? AND account IN (${placeholders})
     GROUP BY cid, account`,
    [branchId, ...accounts]
  );
  const out = new Map<string, Map<string, number>>();
  for (const acc of accounts) out.set(acc, new Map());
  for (const r of rows) {
    const acc = String(r.account);
    const m = out.get(acc);
    if (!m) continue;
    const cid = String(r.cid ?? '');
    const d = Number(r.d) || 0;
    const c = Number(r.c) || 0;
    const signed = (ACCOUNT_SIGN[acc] ?? 1) === 1 ? d - c : c - d;
    m.set(cid, toFils(signed));
  }
  return out;
}

// ── Domain-Seite: gruppierte Maps (BHD akkumulieren, am Ende toFils) ─────────

type FilsMap = Map<string, number>;

function accumulate(run: SqlRunner, sql: string, params: unknown[], sign: 1 | -1, bhd: Map<string, number>): void {
  for (const r of run(sql, params)) {
    const cid = String(r.cid ?? '');
    bhd.set(cid, (bhd.get(cid) || 0) + sign * (Number(r.t) || 0));
  }
}

function toFilsMap(bhd: Map<string, number>): FilsMap {
  const out: FilsMap = new Map();
  for (const [k, v] of bhd) out.set(k, toFils(v));
  return out;
}

// AR je Kunde — Spiegel von domainAR (4 Beine, Overpay-Cap, CANCELLED-Regel).
function domainArMap(run: SqlRunner, branchId: string): FilsMap {
  const bhd = new Map<string, number>();
  accumulate(run,
    `SELECT COALESCE(customer_id,'') AS cid, COALESCE(SUM(gross_amount),0) AS t
     FROM invoices WHERE branch_id=? AND status!='CANCELLED' GROUP BY cid`,
    [branchId], 1, bhd);
  accumulate(run,
    `SELECT COALESCE(i.customer_id,'') AS cid, COALESCE(SUM(MIN(pp.paid,i.gross_amount)),0) AS t
     FROM invoices i
     JOIN (SELECT invoice_id, SUM(amount) AS paid FROM payments GROUP BY invoice_id) pp ON pp.invoice_id=i.id
     WHERE i.branch_id=? AND i.status!='CANCELLED' GROUP BY cid`,
    [branchId], -1, bhd);
  accumulate(run,
    `SELECT COALESCE(i.customer_id,'') AS cid, COALESCE(SUM(p.amount),0) AS t
     FROM payments p JOIN invoices i ON i.id=p.invoice_id
     WHERE i.branch_id=? AND i.status='CANCELLED' GROUP BY cid`,
    [branchId], -1, bhd);
  accumulate(run,
    `SELECT COALESCE(customer_id,'') AS cid, COALESCE(SUM(receivable_cancel_amount),0) AS t
     FROM credit_notes WHERE branch_id=? GROUP BY cid`,
    [branchId], -1, bhd);
  return toFilsMap(bhd);
}

// Customer-Credit je Kunde — Spiegel von domainCustomerCredit (Σ amount−used, alle Rows).
function domainCustomerCreditMap(run: SqlRunner, branchId: string): FilsMap {
  const bhd = new Map<string, number>();
  accumulate(run,
    `SELECT COALESCE(customer_id,'') AS cid, COALESCE(SUM(amount-used_amount),0) AS t
     FROM customer_credits WHERE branch_id=? GROUP BY cid`,
    [branchId], 1, bhd);
  return toFilsMap(bhd);
}

// AP je Lieferant — Spiegel von domainAP (Purchases+Expenses, CardFees raus, Cap, CANCELLED raus).
// Expenses ohne supplier_id landen im Unassigned-Bucket ('') — legitim, kein Fehler.
function domainApMap(run: SqlRunner, branchId: string): FilsMap {
  const bhd = new Map<string, number>();
  accumulate(run,
    `SELECT COALESCE(supplier_id,'') AS cid, COALESCE(SUM(total_amount),0) AS t
     FROM purchases WHERE branch_id=? AND status!='CANCELLED' GROUP BY cid`,
    [branchId], 1, bhd);
  accumulate(run,
    `SELECT COALESCE(supplier_id,'') AS cid, COALESCE(SUM(amount),0) AS t
     FROM expenses WHERE branch_id=? AND status!='CANCELLED' AND category!='CardFees' GROUP BY cid`,
    [branchId], 1, bhd);
  accumulate(run,
    `SELECT COALESCE(pu.supplier_id,'') AS cid, COALESCE(SUM(MIN(pp.paid,pu.total_amount)),0) AS t
     FROM (SELECT purchase_id, SUM(amount) AS paid FROM purchase_payments GROUP BY purchase_id) pp
     JOIN purchases pu ON pu.id=pp.purchase_id
     WHERE pu.branch_id=? AND pu.status!='CANCELLED' GROUP BY cid`,
    [branchId], -1, bhd);
  accumulate(run,
    `SELECT COALESCE(e.supplier_id,'') AS cid, COALESCE(SUM(ep.amount),0) AS t
     FROM expense_payments ep JOIN expenses e ON e.id=ep.expense_id
     WHERE e.branch_id=? AND e.status!='CANCELLED' GROUP BY cid`,
    [branchId], -1, bhd);
  return toFilsMap(bhd);
}

// Supplier-Credit je Lieferant — Spiegel von domainSupplierCredit (Σ amount−used, alle Rows).
function domainSupplierCreditMap(run: SqlRunner, branchId: string): FilsMap {
  const bhd = new Map<string, number>();
  accumulate(run,
    `SELECT COALESCE(supplier_id,'') AS cid, COALESCE(SUM(amount-used_amount),0) AS t
     FROM supplier_credits WHERE branch_id=? GROUP BY cid`,
    [branchId], 1, bhd);
  return toFilsMap(bhd);
}

// ── Namen ─────────────────────────────────────────────────────

function customerNames(run: SqlRunner, branchId: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of run(`SELECT id, first_name, last_name, company FROM customers WHERE branch_id=?`, [branchId])) {
    const full = [r.first_name, r.last_name].map(x => String(x ?? '').trim()).filter(Boolean).join(' ');
    m.set(String(r.id), full || String(r.company ?? '').trim() || String(r.id));
  }
  return m;
}

function supplierNames(run: SqlRunner, branchId: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of run(`SELECT id, name FROM suppliers WHERE branch_id=?`, [branchId])) {
    m.set(String(r.id), String(r.name ?? '').trim() || String(r.id));
  }
  return m;
}

// ── Section-Builder (Domain ⨝ Ledger Merge) ───────────────────

function buildSection(
  title: string,
  account: LedgerAccount,
  domain: FilsMap,
  ledger: FilsMap,
  names: Map<string, string>
): CpSection {
  const ids = new Set<string>([...domain.keys(), ...ledger.keys()]);
  const rows: CpRow[] = [];
  for (const id of ids) {
    const domainFils = domain.get(id) || 0;
    const ledgerFils = ledger.get(id) || 0;
    if (domainFils === 0 && ledgerFils === 0) continue; // inaktive Counterparty → überspringen
    const diffFils = ledgerFils - domainFils;
    rows.push({
      id: id === '' ? UNASSIGNED : id,
      name: id === '' ? 'Unassigned (keine Counterparty)' : (names.get(id) || id),
      account,
      domainFils,
      ledgerFils,
      diffFils,
      status: diffFils === 0 ? 'ok' : 'mismatch',
    });
  }
  rows.sort((a, b) => Math.abs(b.diffFils) - Math.abs(a.diffFils) || b.ledgerFils - a.ledgerFils);
  const mismatches = rows.filter(r => r.status === 'mismatch').length;
  const netDiffFils = rows.reduce((s, r) => s + r.diffFils, 0);
  const sumAbsDiffFils = rows.reduce((s, r) => s + Math.abs(r.diffFils), 0);
  return { title, account, rows, checked: rows.length, mismatches, netDiffFils, sumAbsDiffFils, ok: mismatches === 0 };
}

// ── Credit-Integritäts-Befunde (Ziel 5) ───────────────────────
// severity='error' NUR bei beweisbar eindeutigem 1:1-Key (in-Tabellen-Arithmetik,
// explizite FK/reference-Konvention, sauber gekeyte Source-Module). Return-Credits,
// Order-Cancel (präfixierte Source-IDs) und unbekannte Module → 'warning'.

// Sauber gekeyte customer-credit Source-Types → erwartete (sourceModule, sourceId).
// sourceId = source_id der Row, außer gold_conversion (= Row-id selbst).
const CUSTOMER_CLEAN: Record<string, string> = {
  overpayment: 'PAYMENT',
  invoice_edit: 'INVOICE',
  order_overpayment: 'ORDER_OVERPAY',
  sales_return: 'CREDIT_NOTE',
};

function auditCreditIntegrity(run: SqlRunner, branchId: string): CreditIssue[] {
  const issues: CreditIssue[] = [];

  // 1+2+6+7 — customer_credits in EINER Query (overused/status/drift/credit_no_ledger).
  const ccRows = run(
    `SELECT cc.id, cc.customer_id AS cp, cc.source_type, cc.source_id, cc.amount, cc.used_amount, cc.status,
            COALESCE((SELECT SUM(amount) FROM credit_applications WHERE credit_id=cc.id),0) AS applied
     FROM customer_credits cc WHERE cc.branch_id=?`,
    [branchId]
  );
  // Ledger-Grant-Keys (CR CUSTOMER_CREDIT, lebend) — für credit_no_ledger + ledger_no_credit.
  const ccGrantKeys = new Set<string>();
  for (const r of run(
    `SELECT DISTINCT source_module, source_id FROM ledger_entries le
     WHERE branch_id=? AND account='CUSTOMER_CREDIT' AND direction='CREDIT'
       AND reverses_entry_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM ledger_entries r WHERE r.reverses_entry_id=le.id)`,
    [branchId]
  )) ccGrantKeys.add(`${r.source_module}|${r.source_id}`);

  // Domain-Lookups für ledger_no_credit (customer).
  const ccById = new Set<string>();
  const ccByTypeSource = new Set<string>();
  for (const r of ccRows) {
    ccById.add(String(r.id));
    ccByTypeSource.add(`${r.source_type}|${r.source_id}`);
  }

  for (const r of ccRows) {
    const id = String(r.id);
    const cp = String(r.cp ?? '');
    const amt = toFils(r.amount);
    const used = toFils(r.used_amount);
    if (amt <= 0) issues.push({ kind: 'overused', severity: 'error', side: 'customer', entityId: id, counterpartyId: cp, amountFils: amt, detail: `amount<=0 (${amt} fils)` });
    if (used < 0) issues.push({ kind: 'overused', severity: 'error', side: 'customer', entityId: id, counterpartyId: cp, amountFils: used, detail: `used_amount<0 (${used} fils)` });
    if (used > amt) issues.push({ kind: 'overused', severity: 'error', side: 'customer', entityId: id, counterpartyId: cp, amountFils: used - amt, detail: `used>amount (used ${used} > amount ${amt} fils)` });
    const expectedStatus = used >= amt - 5 ? 'USED' : 'OPEN'; // 0.005 BHD = 5 Fils (Status-Flip-SSOT)
    if (String(r.status) !== expectedStatus) issues.push({ kind: 'inconsistent_status', severity: 'warning', side: 'customer', entityId: id, counterpartyId: cp, detail: `status='${r.status}' erwartet '${expectedStatus}' (used ${used}/amount ${amt} fils)` });
    const applied = toFils(r.applied);
    if (applied !== used) issues.push({ kind: 'used_drift', severity: 'warning', side: 'customer', entityId: id, counterpartyId: cp, amountFils: applied - used, detail: `Σ credit_applications ${applied} ≠ used_amount ${used} fils` });
    // credit_no_ledger
    const st = String(r.source_type ?? '');
    let expectKey: string | null = null;
    let sev: CreditIssueSeverity = 'error';
    if (st === 'gold_conversion') expectKey = `GOLD_CONVERSION|${id}`;
    else if (st === 'order_cancel') { expectKey = `ORDER_CANCEL|credit:${r.source_id}`; sev = 'warning'; }
    else if (CUSTOMER_CLEAN[st]) expectKey = `${CUSTOMER_CLEAN[st]}|${r.source_id}`;
    else { expectKey = null; sev = 'warning'; }
    if (expectKey === null) {
      issues.push({ kind: 'credit_no_ledger', severity: 'warning', side: 'customer', entityId: id, counterpartyId: cp, detail: `source_type='${st}' nicht eindeutig auf eine Ledger-Gruppe abbildbar (unverifiable)` });
    } else if (!ccGrantKeys.has(expectKey)) {
      issues.push({ kind: 'credit_no_ledger', severity: sev, side: 'customer', entityId: id, counterpartyId: cp, amountFils: amt, detail: `keine CUSTOMER_CREDIT-Gruppe für ${expectKey}${sev === 'warning' ? ' (präfixierte/unsichere Source-ID)' : ''}` });
    }
  }

  // ledger_no_credit (customer): jede lebende Grant-Gruppe braucht eine Domain-Row.
  for (const key of ccGrantKeys) {
    const [mod, sid] = splitKey(key);
    let found = false;
    let sev: CreditIssueSeverity = 'error';
    if (mod === 'PAYMENT') found = ccByTypeSource.has(`overpayment|${sid}`);
    else if (mod === 'INVOICE') found = ccByTypeSource.has(`invoice_edit|${sid}`);
    else if (mod === 'ORDER_OVERPAY') found = ccByTypeSource.has(`order_overpayment|${sid}`);
    else if (mod === 'CREDIT_NOTE') found = ccByTypeSource.has(`sales_return|${sid}`);
    else if (mod === 'GOLD_CONVERSION') found = ccById.has(sid);
    else if (mod === 'ORDER_CANCEL') { sev = 'warning'; const oid = sid.startsWith('credit:') ? sid.slice(7) : sid; found = ccByTypeSource.has(`order_cancel|${oid}`); }
    else { sev = 'warning'; found = true; } // unbekanntes Modul → nicht als harter Fehler werten
    if (!found) issues.push({ kind: 'ledger_no_credit', severity: sev, side: 'customer', entityId: `${mod}|${sid}`, detail: `CUSTOMER_CREDIT-Grant ohne passende customer_credits-Row (${mod})` });
  }

  // 1+6+7 — supplier_credits in EINER Query (overused/status/drift/credit_no_ledger).
  const scRows = run(
    `SELECT sc.id, sc.supplier_id AS cp, sc.source_return_id, sc.source_purchase_id, sc.amount, sc.used_amount, sc.status,
            COALESCE((SELECT SUM(amount) FROM purchase_payments WHERE method='credit' AND reference=sc.id),0)
            + COALESCE((SELECT SUM(amount) FROM expense_payments WHERE method='credit' AND reference=sc.id),0) AS applied
     FROM supplier_credits sc WHERE sc.branch_id=?`,
    [branchId]
  );
  const scIds = new Set<string>();
  for (const r of scRows) scIds.add(String(r.id));
  const scGrantKeys = new Set<string>();
  for (const r of run(
    `SELECT DISTINCT source_module, source_id FROM ledger_entries le
     WHERE branch_id=? AND account='SUPPLIER_CREDIT' AND direction='DEBIT'
       AND reverses_entry_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM ledger_entries r WHERE r.reverses_entry_id=le.id)`,
    [branchId]
  )) scGrantKeys.add(`${r.source_module}|${r.source_id}`);
  // Lookups für supplier ledger_no_credit
  const scByPurchase = new Set<string>();
  for (const r of scRows) if (r.source_purchase_id && !r.source_return_id) scByPurchase.add(String(r.source_purchase_id));

  for (const r of scRows) {
    const id = String(r.id);
    const cp = String(r.cp ?? '');
    const amt = toFils(r.amount);
    const used = toFils(r.used_amount);
    if (amt <= 0) issues.push({ kind: 'overused', severity: 'error', side: 'supplier', entityId: id, counterpartyId: cp, amountFils: amt, detail: `amount<=0 (${amt} fils)` });
    if (used < 0) issues.push({ kind: 'overused', severity: 'error', side: 'supplier', entityId: id, counterpartyId: cp, amountFils: used, detail: `used_amount<0 (${used} fils)` });
    if (used > amt) issues.push({ kind: 'overused', severity: 'error', side: 'supplier', entityId: id, counterpartyId: cp, amountFils: used - amt, detail: `used>amount (used ${used} > amount ${amt} fils)` });
    const expectedStatus = used >= amt - 5 ? 'USED' : 'OPEN';
    if (String(r.status) !== expectedStatus) issues.push({ kind: 'inconsistent_status', severity: 'warning', side: 'supplier', entityId: id, counterpartyId: cp, detail: `status='${r.status}' erwartet '${expectedStatus}' (used ${used}/amount ${amt} fils)` });
    const applied = toFils(r.applied);
    if (applied !== used) issues.push({ kind: 'used_drift', severity: 'warning', side: 'supplier', entityId: id, counterpartyId: cp, amountFils: applied - used, detail: `Σ credit-Payments ${applied} ≠ used_amount ${used} fils` });
    // credit_no_ledger (supplier): NULL-Konvention
    let expectKey: string | null = null;
    let sev: CreditIssueSeverity = 'error';
    if (r.source_return_id) { expectKey = null; sev = 'warning'; }                                    // Return-Credit: Ledger-Key nicht 1:1 bewiesen
    else if (r.source_purchase_id) expectKey = `PURCHASE_OVERPAY|${r.source_purchase_id}`;            // Purchase-Overpay
    else expectKey = `SUPPLIER_PREPAYMENT|${id}`;                                                     // Standalone
    if (expectKey === null) {
      issues.push({ kind: 'credit_no_ledger', severity: 'warning', side: 'supplier', entityId: id, counterpartyId: cp, detail: `Return-Credit (source_return_id gesetzt) — Ledger-Key nicht eindeutig beweisbar (unverifiable)` });
    } else if (!scGrantKeys.has(expectKey)) {
      issues.push({ kind: 'credit_no_ledger', severity: sev, side: 'supplier', entityId: id, counterpartyId: cp, amountFils: amt, detail: `keine SUPPLIER_CREDIT-Gruppe für ${expectKey}` });
    }
  }

  // ledger_no_credit (supplier)
  for (const key of scGrantKeys) {
    const [mod, sid] = splitKey(key);
    let found = false;
    let sev: CreditIssueSeverity = 'error';
    if (mod === 'PURCHASE_OVERPAY') found = scByPurchase.has(sid);
    else if (mod === 'SUPPLIER_PREPAYMENT') found = scIds.has(sid);
    else { sev = 'warning'; found = true; } // Return-/unbekannte Module → nicht hart werten
    if (!found) issues.push({ kind: 'ledger_no_credit', severity: sev, side: 'supplier', entityId: `${mod}|${sid}`, detail: `SUPPLIER_CREDIT-Grant ohne passende supplier_credits-Row (${mod})` });
  }

  // 5 — bad_reference: method='credit'-Payments müssen eine existierende supplier_credits.id referenzieren.
  const checkCreditRef = (rows: Array<Record<string, unknown>>, table: string) => {
    for (const r of rows) {
      const ref = r.reference == null ? '' : String(r.reference);
      if (!ref) issues.push({ kind: 'bad_reference', severity: 'error', side: 'supplier', entityId: String(r.id), counterpartyId: String(r.cp ?? ''), amountFils: toFils(r.amount), detail: `${table}.method='credit' ohne reference` });
      else if (!scIds.has(ref)) issues.push({ kind: 'bad_reference', severity: 'error', side: 'supplier', entityId: String(r.id), counterpartyId: String(r.cp ?? ''), amountFils: toFils(r.amount), detail: `${table}.reference='${ref}' zeigt auf kein supplier_credits` });
    }
  };
  checkCreditRef(run(
    `SELECT ep.id, ep.reference, ep.amount, e.supplier_id AS cp
     FROM expense_payments ep JOIN expenses e ON e.id=ep.expense_id
     WHERE e.branch_id=? AND ep.method='credit'`, [branchId]), 'expense_payments');
  checkCreditRef(run(
    `SELECT pp.id, pp.reference, pp.amount, pu.supplier_id AS cp
     FROM purchase_payments pp JOIN purchases pu ON pu.id=pp.purchase_id
     WHERE pu.branch_id=? AND pp.method='credit'`, [branchId]), 'purchase_payments');

  // 7 — orphan credit_applications: payment_id/credit_id müssen existieren.
  const payIds = new Set<string>();
  for (const r of run(`SELECT id FROM payments WHERE branch_id=?`, [branchId])) payIds.add(String(r.id));
  for (const r of run(`SELECT id, payment_id, credit_id, amount FROM credit_applications WHERE branch_id=?`, [branchId])) {
    if (!ccById.has(String(r.credit_id))) issues.push({ kind: 'orphan_payment', severity: 'error', side: 'customer', entityId: String(r.id), amountFils: toFils(r.amount), detail: `credit_applications.credit_id='${r.credit_id}' fehlt in customer_credits` });
    if (!payIds.has(String(r.payment_id))) issues.push({ kind: 'orphan_payment', severity: 'error', side: 'customer', entityId: String(r.id), amountFils: toFils(r.amount), detail: `credit_applications.payment_id='${r.payment_id}' fehlt in payments` });
  }

  // 3 — missing_counterparty: AR/CC/SC-Originale ohne counterparty_id; AP nur purchase-seitig.
  for (const r of run(
    `SELECT id, account, source_module FROM ledger_entries le
     WHERE branch_id=? AND reverses_entry_id IS NULL AND counterparty_id IS NULL
       AND ( account IN ('ACCOUNTS_RECEIVABLE','CUSTOMER_CREDIT','SUPPLIER_CREDIT')
             OR (account='ACCOUNTS_PAYABLE' AND source_module IN ('PURCHASE','PURCHASE_PAYMENT','PURCHASE_OVERPAY')) )
       AND NOT EXISTS (SELECT 1 FROM ledger_entries r WHERE r.reverses_entry_id=le.id)`,
    [branchId]
  )) {
    const acc = String(r.account);
    const side: 'customer' | 'supplier' = (acc === 'ACCOUNTS_RECEIVABLE' || acc === 'CUSTOMER_CREDIT') ? 'customer' : 'supplier';
    issues.push({ kind: 'missing_counterparty', severity: 'error', side, entityId: String(r.id), detail: `${acc}-Ledgerzeile ohne counterparty_id (source ${r.source_module})` });
  }

  // 4 — wrong_counterparty_type: Konto impliziert Typ, counterparty_type weicht ab.
  for (const r of run(
    `SELECT id, account, counterparty_type, source_module FROM ledger_entries le
     WHERE branch_id=? AND reverses_entry_id IS NULL AND counterparty_id IS NOT NULL AND counterparty_type IS NOT NULL
       AND ( (account IN ('ACCOUNTS_RECEIVABLE','CUSTOMER_CREDIT') AND counterparty_type!='CUSTOMER')
          OR (account IN ('ACCOUNTS_PAYABLE','SUPPLIER_CREDIT')   AND counterparty_type!='SUPPLIER') )
       AND NOT EXISTS (SELECT 1 FROM ledger_entries r WHERE r.reverses_entry_id=le.id)`,
    [branchId]
  )) {
    const acc = String(r.account);
    const side: 'customer' | 'supplier' = (acc === 'ACCOUNTS_RECEIVABLE' || acc === 'CUSTOMER_CREDIT') ? 'customer' : 'supplier';
    issues.push({ kind: 'wrong_counterparty_type', severity: 'error', side, entityId: String(r.id), detail: `${acc} mit counterparty_type='${r.counterparty_type}' (source ${r.source_module})` });
  }

  return issues;
}

function splitKey(key: string): [string, string] {
  const i = key.indexOf('|');
  return i < 0 ? [key, ''] : [key.slice(0, i), key.slice(i + 1)];
}

// ── Haupteinstieg ─────────────────────────────────────────────

/** Führt die komplette per-Counterparty-Reconciliation aus. VOLLSTÄNDIG READ-ONLY.
 *  Alle DB-Zugriffe laufen über `run` (Default ist der echte query-Runner der Page;
 *  Tests injizieren einen SELECT-only-Runner zum Read-only-Beweis). */
export function runCounterpartyAudit(run: SqlRunner, branchId: string): CounterpartyAudit {
  let count = 0;
  const counted: SqlRunner = (sql, params) => { count++; return run(sql, params); };

  const custLedger = ledgerMaps(counted, branchId, ['ACCOUNTS_RECEIVABLE', 'CUSTOMER_CREDIT']);
  const suppLedger = ledgerMaps(counted, branchId, ['ACCOUNTS_PAYABLE', 'SUPPLIER_CREDIT']);

  const arDomain = domainArMap(counted, branchId);
  const ccDomain = domainCustomerCreditMap(counted, branchId);
  const apDomain = domainApMap(counted, branchId);
  const scDomain = domainSupplierCreditMap(counted, branchId);

  const custNames = customerNames(counted, branchId);
  const suppNames = supplierNames(counted, branchId);

  const arByCustomer = buildSection('AR by Customer', 'ACCOUNTS_RECEIVABLE', arDomain, custLedger.get('ACCOUNTS_RECEIVABLE') ?? new Map(), custNames);
  const customerCreditByCustomer = buildSection('Customer Credit by Customer', 'CUSTOMER_CREDIT', ccDomain, custLedger.get('CUSTOMER_CREDIT') ?? new Map(), custNames);
  const apBySupplier = buildSection('AP by Supplier', 'ACCOUNTS_PAYABLE', apDomain, suppLedger.get('ACCOUNTS_PAYABLE') ?? new Map(), suppNames);
  const supplierCreditBySupplier = buildSection('Supplier Credit by Supplier', 'SUPPLIER_CREDIT', scDomain, suppLedger.get('SUPPLIER_CREDIT') ?? new Map(), suppNames);

  const issues = auditCreditIntegrity(counted, branchId);

  return { arByCustomer, customerCreditByCustomer, apBySupplier, supplierCreditBySupplier, issues, queryCount: count };
}

// Einzel-Builder exportiert für gezielte Tests / Wiederverwendung.
export const __testables = {
  domainArMap, domainCustomerCreditMap, domainApMap, domainSupplierCreditMap, ledgerMaps, buildSection, auditCreditIntegrity, toFils,
};
