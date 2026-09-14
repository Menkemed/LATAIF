// ════════════════════════════════════════════════════════════════════════════
// POST-PARITY R7A (PP-1) — Lieferanten-Guthaben: Einlösung → Rücknahme → Abstimmung.
// Run: node test/r7a/pp1-supplier-credit-reconciliation.test.ts
//
// Befund (R6F, PP-1): Nach einer STORNIERTEN Guthaben-Einlösung bleibt die Zahlungszeile (method
// 'credit', reference = Guthaben-id) als Historie stehen. Wird die Guthabenzeile danach rechtmäßig
// abgewickelt (Retouren-Rücknahme, Overpay-Rebook, Erstattung eines Standalone-Guthabens — letzteres
// über die normale Maske und PC2), zeigt die Referenz ins Leere, und die Abstimmung meldete einen
// HARTEN Befund (bad_reference), obwohl Geld und Salden stimmten; schon vorher warnte sie used_drift.
//
// Vertrag: eine Einlösung, deren Buchung vollständig gegengebucht ist, ist Historie — sie zählt nicht
// zu `applied` und muss auf keine Guthabenzeile mehr zeigen. Eine LEBENDE Einlösung bleibt voll
// geprüft; korrekte Buchungen werden nicht „repariert", keine Löschhistorie wird erfunden.
// Gefahren werden die echten Schreiber (Haus, Fernbefehl `purchases.cancel`) auf dem echten Schema.
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath, relative } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    if (specifier === '@tauri-apps/api/core') {
      return { url: pathToFileURL(resolvePath(repo, 'test/bridge/_tauri-shim.ts')).href, shortCircuit: true };
    }
    if (specifier === '@/core/db/database' || specifier === '../db/database.ts') {
      return { url: pathToFileURL(resolvePath(repo, 'test/sync/_db-shim.ts')).href, shortCircuit: true };
    }
    if ((specifier === './database' || specifier === '../db/database') && context.parentURL) {
      return { url: pathToFileURL(resolvePath(repo, 'test/sync/_db-shim.ts')).href, shortCircuit: true };
    }
    if (specifier === '../auth/auth' && context.parentURL && context.parentURL.includes('/db/helpers')) {
      return { url: pathToFileURL(resolvePath(repo, 'test/sync/_auth-shim.ts')).href, shortCircuit: true };
    }
    if (specifier.startsWith('@/')) {
      const p = resolvePath(repo, 'src', specifier.slice(2));
      return { url: pathToFileURL(existsSync(p) ? p : p + '.ts').href, shortCircuit: true };
    }
    if (specifier.startsWith('.') && context.parentURL) {
      const p = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
      if (!existsSync(p) && existsSync(p + '.ts')) return { url: pathToFileURL(p + '.ts').href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
} as never);

const store = new Map<string, string>([
  ['lataif_session', JSON.stringify({ branchId: 'branch-main', userId: 'user-test' })],
  ['lataif_sync_url', 'http://127.0.0.1:9/sync'],
  ['lataif_sync_token', 'test-token'],
]);
const storage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};
(globalThis as { localStorage?: unknown }).localStorage = storage;
(globalThis as { window?: unknown }).window = { localStorage: storage, confirm: () => true };

const initSqlJs = (await import('sql.js')).default;
const SQL = await initSqlJs({ locateFile: (f: string) => resolvePath(repo, 'node_modules/sql.js/dist', f) });

const { setTestDatabase } = await import('../sync/_db-shim.ts');
const { tauriState } = await import('../bridge/_tauri-shim.ts');
const { COMMAND_LEDGER_DDL, COMMAND_LEDGER_INDEX } = await import('../../src/core/bridge/command-ledger.ts');
const { resetDurabilityStateForTest } = await import('../../src/core/bridge/durability-state.ts');
const { resetTransactionHealthForTest } = await import('../../src/core/db/transaction-health.ts');
const { installWriteGuard } = await import('../../src/core/db/write-guard.ts');
const { SKU_SEQUENCES_DDL } = await import('../../src/core/products/sku-sequence.ts');
const cmds = await import('../../src/core/bridge/purchase-lifecycle-commands.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const { applyMediaSchema } = await import('../../src/core/db/media-schema.ts');
const payables = await import('../../src/core/payables/payables-house.ts');
const life = await import('../../src/core/purchases/purchase-lifecycle-house.ts');
const { usePurchaseStore } = await import('../../src/stores/purchaseStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { useOrderStore } = await import('../../src/stores/orderStore.ts');
const { useSupplierStore, supplierLedgerFor, supplierCreditsFor } = await import('../../src/stores/supplierStore.ts');
const { localReadContext } = await import('../../src/core/data/read-context.ts');
const { query } = await import('../../src/core/db/helpers.ts');
const { reconciliationSnapshotFor } = await import('../../src/core/reports/reconciliation-snapshot.ts');
const { runCounterpartyAudit } = await import('../../src/core/ledger/counterpartyAudit.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const marker = (m: string): void => { if (fails.length === 0) console.log(m); };
const flag = (m: string): void => console.log('  FLAG ' + m);
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const codeOf = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const S = (v: unknown): string => JSON.stringify(v);
const r3 = (x: unknown): number => Math.round((Number(x) || 0) * 1000) / 1000;
const NOW = '2026-09-14T10:00:00.000Z';
const CTX = { branchId: 'branch-main', userId: 'user-test', now: NOW };
const OP_CANCEL = 'purchases.cancel';

interface Db {
  run(sql: string, p?: unknown[]): unknown;
  exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
}
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const n = (db: Db, sql: string, p: unknown[] = []): number => Number(one(db, sql, p) ?? 0);
const s = (db: Db, sql: string, p: unknown[] = []): string => String(one(db, sql, p) ?? '');
function row(db: Db, sql: string, p: unknown[] = []): Record<string, unknown> {
  const r = db.exec(sql, p)[0];
  if (!r || r.values.length === 0) return {};
  return Object.fromEntries(r.columns.map((c, i) => [c, r.values[0][i]]));
}
const all = (db: Db, sql: string, p: unknown[] = []): string => JSON.stringify(db.exec(sql, p)[0]?.values ?? []);

function realMigrations(): string[] {
  const dbSrc = src('src/core/db/database.ts');
  const start = dbSrc.indexOf('const migrations: string[] = [');
  const end = dbSrc.indexOf('\n  ];', start);
  return [...dbSrc.slice(start, end).matchAll(/`([^`]*)`/g)].map((m) => m[1]);
}
const MIGRATIONS = realMigrations();

function insert(db: Db, table: string, values: Record<string, unknown>): void {
  const info = db.exec(`PRAGMA table_info(${table})`)[0];
  const cols = info.values.map((v) => ({
    name: String(v[1]), type: String(v[2] ?? ''), notnull: Number(v[3]) === 1, dflt: v[4], pk: Number(v[5]) > 0,
  }));
  const data: Record<string, unknown> = { ...values };
  for (const c of cols) {
    if (!c.notnull || c.dflt !== null || c.pk || data[c.name] !== undefined) continue;
    data[c.name] = /INT|REAL|NUM/i.test(c.type) ? 0 : (/_at$|date/i.test(c.name) ? NOW : '');
  }
  const names = Object.keys(data).filter((k) => cols.some((c) => c.name === k));
  db.run(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`, names.map((k) => data[k]));
}

function reload(): void {
  const ps = usePurchaseStore.getState();
  ps.loadPurchases();
  ps.loadReturns();
  useProductStore.getState().loadProducts();
  useOrderStore.getState().loadOrders();
  useSupplierStore.getState().loadSuppliers();
}

const nimm = (db: Db): Db => { setTestDatabase(db as never); return db; };

function freshDb(): Db {
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  const db = new SQL.Database() as unknown as Db;
  db.run(src('src/core/db/schema.sql'));
  for (const stmt of MIGRATIONS) { try { db.run(stmt); } catch { /* schon da */ } }
  for (const stmt of A1_UPGRADE_SQL) { try { db.run(stmt); } catch { /* schon da */ } }
  db.run(COMMAND_LEDGER_DDL);
  db.run(COMMAND_LEDGER_INDEX);
  db.run(SKU_SEQUENCES_DDL);
  for (const [id, name] of [['branch-main', 'Haupt'], ['branch-other', 'Andere']]) {
    db.run('INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES (?,?,?,?,?)', [id, 'tenant-1', name, NOW, NOW]);
  }
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES ('cat-w','branch-main','Watch','w','#000',?,?)", [NOW, NOW]);
  for (const [id, branch] of [['sup-1', 'branch-main'], ['sup-2', 'branch-main']]) {
    db.run('INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at) VALUES (?,?,?,1,?,?)', [id, branch, 'Lieferant ' + id, NOW, NOW]);
  }
  applyMediaSchema(db as never);
  nimm(db);
  installWriteGuard(db as never);
  for (const id of ['p1', 'p2', 'p3']) {
    db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
        scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
        tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
      VALUES (?,'branch-main','cat-w','Rolex',?,?,0,'Pre-Owned','[]',100,'BHD',150,'in_stock','MARGIN',0,'[]','{}','OWN',?,?)`,
    [id, 'M ' + id, 'SKU-' + id, NOW, NOW]);
  }
  reload();
  tauriState.reset();
  return db;
}

function imHaus<T>(fn: () => T): T {
  posting.beginLedgerTransaction();
  try { const out = fn(); posting.commitLedgerTransaction(); return out; }
  catch (e) { posting.rollbackLedgerTransaction(); throw e; }
}

interface Zeile { productId: string; quantity: number; unitPrice: number; vat?: boolean }
function kauf(lines: Zeile[], supplierId = 'sup-1'): string {
  return imHaus(() => usePurchaseStore.getState().createPurchase({
    supplierId,
    lines: lines.map((l) => ({
      productId: l.productId, quantity: l.quantity, unitPrice: l.unitPrice,
      taxScheme: l.vat ? 'VAT_10' as const : 'ZERO' as const, vatRate: l.vat ? 10 : 0,
    })),
  }).id);
}
const zeilen = (db: Db, pid: string): string[] =>
  (db.exec('SELECT id FROM purchase_lines WHERE purchase_id = ? ORDER BY position', [pid])[0]?.values ?? []).map((v) => String(v[0]));
const rev = (db: Db, pid: string): number => n(db, 'SELECT revision FROM purchases WHERE id = ?', [pid]);

const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-000000000000`;
const ACTOR = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role: 'SALES' };
const identity = (x: string, op: string) => ({ commandId: ID(x), ...ACTOR, op, payloadHash: 'h' + x });
const deps = (db: Db) => ({
  db: db as never,
  begin: () => { setTestDatabase(db as never); posting.beginLedgerTransaction(); },
  commit: posting.commitLedgerTransaction,
  rollback: posting.rollbackLedgerTransaction,
  durableSave: async () => {},
  now: () => NOW,
});
let seq = 100;
const nx = (): string => String(++seq);

interface Ausgang { ok: boolean; code: string; frozen: boolean; value: Record<string, unknown> }
async function fern(p: () => Promise<unknown>): Promise<Ausgang> {
  try {
    const o = await p() as { kind: string; code?: string; value?: Record<string, unknown>; frozen?: boolean };
    if (o.kind === 'ok') return { ok: true, code: '', frozen: false, value: o.value ?? {} };
    return { ok: false, code: o.code ?? '(ohne Code)', frozen: o.frozen === true, value: {} };
  } catch (e) {
    return { ok: false, code: (e as { code?: string }).code ?? 'THROWN:' + String(e), frozen: false, value: {} };
  }
}
function wirft(fn: () => unknown): string {
  try { fn(); return ''; } catch (e) { return String((e as { code?: unknown }).code ?? (e as Error).message); }
}

/** Jede Buchung gleicht sich aus: Soll == Haben, je Transaktion, in Fils. */
function balanced(db: Db): boolean {
  const t = db.exec(`SELECT transaction_id,
      SUM(CASE WHEN direction = 'DEBIT' THEN CAST(ROUND(amount * 1000) AS INTEGER) ELSE 0 END),
      SUM(CASE WHEN direction = 'CREDIT' THEN CAST(ROUND(amount * 1000) AS INTEGER) ELSE 0 END)
    FROM ledger_entries GROUP BY transaction_id`)[0]?.values ?? [];
  return t.length > 0 && t.every((r) => Number(r[1]) === Number(r[2]));
}
const salden = (db: Db): string => all(db,
  `SELECT account, COALESCE(counterparty_id, '') AS cp, ROUND(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 3) AS net
     FROM ledger_entries GROUP BY account, cp HAVING ABS(net) > 0.0005 ORDER BY account, cp`);
/** Spur einer Quelle im Hauptbuch: Originale, deren Stornos, noch lebende Originale. */
function spur(db: Db, module: string, sourceId: string): { orig: number; storno: number; lebend: number } {
  return {
    orig: n(db, 'SELECT COUNT(*) FROM ledger_entries WHERE source_module = ? AND source_id = ? AND reverses_entry_id IS NULL', [module, sourceId]),
    storno: n(db, `SELECT COUNT(*) FROM ledger_entries r JOIN ledger_entries o ON o.id = r.reverses_entry_id
                    WHERE o.source_module = ? AND o.source_id = ?`, [module, sourceId]),
    lebend: n(db, `SELECT COUNT(*) FROM ledger_entries o WHERE o.source_module = ? AND o.source_id = ? AND o.reverses_entry_id IS NULL
                    AND NOT EXISTS (SELECT 1 FROM ledger_entries r WHERE r.reverses_entry_id = o.id)`, [module, sourceId]),
  };
}
const protokoll = (db: Db, table: string, id: string): string =>
  all(db, 'SELECT action_type FROM audit_log WHERE entity_type = ? AND entity_id = ? AND action_type IN (\'CREATE\', \'DELETE\') ORDER BY rowid', [table, id]);
const statusProtokoll = (db: Db, table: string, id: string): boolean =>
  n(db, "SELECT COUNT(*) FROM audit_log WHERE entity_type = ? AND entity_id = ? AND action_type = 'STATUS_CHANGE' AND new_value LIKE '%CANCELLED%'", [table, id]) > 0;
const zaehler = (db: Db) => S({
  sc: all(db, 'SELECT id, amount, used_amount, status FROM supplier_credits ORDER BY id'),
  l: n(db, 'SELECT COUNT(*) FROM ledger_entries'), a: n(db, 'SELECT COUNT(*) FROM audit_log'),
  log: n(db, 'SELECT COUNT(*) FROM sync_changelog'),
  p: all(db, 'SELECT id, total_amount, paid_amount, remaining_amount, status FROM purchases ORDER BY id'),
  r: all(db, 'SELECT id, status FROM purchase_returns ORDER BY id'),
  pp: n(db, 'SELECT COUNT(*) FROM purchase_payments'), ep: n(db, 'SELECT COUNT(*) FROM expense_payments'),
});

/**
 * Jeder aktive Leser des Lieferanten-Guthabens — Hauptbuch, Domain, Lieferanten-KPI (SupplierDetail
 * CREDIT BALANCE), Lieferantenliste, filialgebundene Auskunft (SupplierDetail-Karte / Einkauf
 * Credit-Modus / Pay Supplier), die zwei Store-Leser, die Reconciliation-Zeile (global) und die
 * Counterparty-Sektion. `errors` = harte Befunde der Counterparty-Pruefung auf Lieferantenseite.
 */
function leser(db: Db, sup = 'sup-1') {
  nimm(db);
  reload();
  const ctx = localReadContext();
  const st = useSupplierStore.getState();
  const recon = reconciliationSnapshotFor(ctx);
  const sc = (recon.rows as Array<{ account: string; ledger: number; domain: number }>).find((r) => r.account === 'SUPPLIER_CREDIT');
  const cp = runCounterpartyAudit(query as never, 'branch-main');
  const cpRow = cp.supplierCreditBySupplier.rows.find((r) => r.id === sup);
  const werte = {
    hauptbuch: r3(n(db, `SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0) FROM ledger_entries
                          WHERE account = 'SUPPLIER_CREDIT' AND counterparty_id = ?`, [sup])),
    domain: r3(n(db, 'SELECT COALESCE(SUM(amount - used_amount), 0) FROM supplier_credits WHERE supplier_id = ?', [sup])),
    kpi: r3(supplierLedgerFor(sup).creditBalance),
    liste: r3(st.suppliers.find((x) => x.id === sup)?.creditBalance ?? -1),
    auskunft: r3(supplierCreditsFor(ctx, sup).availableAmount),
    offen: r3(st.getOpenCredits(sup).reduce((a, c) => a + c.remaining, 0)),
    karte: r3(st.getSupplierCreditsForDisplay(sup).reduce((a, c) => a + c.remaining, 0)),
    reconLedger: r3(sc?.ledger), reconDomain: r3(sc?.domain),
    cpLedger: r3((cpRow?.ledgerFils ?? 0) / 1000), cpDomain: r3((cpRow?.domainFils ?? 0) / 1000),
  };
  const errors = cp.issues.filter((i) => i.side === 'supplier' && i.severity === 'error').map((i) => `${i.kind}:${i.entityId}`);
  const warnings = cp.issues.filter((i) => i.side === 'supplier' && i.severity === 'warning').map((i) => i.kind);
  return { werte, errors, warnings };
}
const einig = (l: ReturnType<typeof leser>, soll: number): boolean => Object.values(l.werte).every((v) => v === soll);

// ── Welten ──────────────────────────────────────────────────────────────────
// Retouren-Guthaben: Einkauf sup-1 — p1 2 × 500 (VAT_10) + p2 1 × 800 = 1800, bar 1500 bezahlt.
// Retoure 1 × p1 (500) + 1 × p2 (800) = 1300 als Guthaben → offen 300 getilgt, Guthaben 1000.
interface RetourWelt { db: Db; pid: string; returnId: string; creditId: string; returnNumber: string }
function retourWelt(): RetourWelt {
  const db = freshDb();
  const pid = kauf([{ productId: 'p1', quantity: 2, unitPrice: 500, vat: true }, { productId: 'p2', quantity: 1, unitPrice: 800 }]);
  usePurchaseStore.getState().addPayment(pid, 1500, 'cash');
  const [lA, lB] = zeilen(db, pid);
  const r = imHaus(() => life.returnToSupplierInHouse({
    purchaseId: pid, refundMethod: 'credit',
    lines: [{ purchaseLineId: lA, quantity: 1, unitPrice: 500 }, { purchaseLineId: lB, quantity: 1, unitPrice: 800 }],
  }, CTX));
  reload();
  return { db, pid, returnId: r.returnId, creditId: String(r.supplierCreditId), returnNumber: r.returnNumber };
}
// Overpay-Guthaben: Einkauf sup-1 — p1 1 × 1000, bar 1200 → Ueberschuss 200 als Guthaben.
interface OverWelt { db: Db; pid: string; creditId: string }
function overWelt(): OverWelt {
  const db = freshDb();
  const pid = kauf([{ productId: 'p1', quantity: 1, unitPrice: 1000 }]);
  usePurchaseStore.getState().addPayment(pid, 1200, 'cash');
  reload();
  return { db, pid, creditId: s(db, 'SELECT id FROM supplier_credits WHERE source_purchase_id = ? AND source_return_id IS NULL', [pid]) };
}


// ══ R7A PP-1 ════════════════════════════════════════════════════════════════
/** Die ALTE Regel (bis R7A): jede credit-Zahlung, deren Referenz auf keine Guthabenzeile zeigt. */
const alteRegel = (db: Db): number => n(db,
  `SELECT (SELECT COUNT(*) FROM purchase_payments WHERE method = 'credit' AND reference IS NOT NULL
             AND reference NOT IN (SELECT id FROM supplier_credits))
        + (SELECT COUNT(*) FROM expense_payments WHERE method = 'credit' AND reference IS NOT NULL
             AND reference NOT IN (SELECT id FROM supplier_credits))`);
/** Ein Retouren-Guthaben trägt immer die Warnung „Ledger-Schlüssel nicht beweisbar" — sie gehört nicht hierher. */
const warn = (l: ReturnType<typeof leser>): string[] => l.warnings.filter((k) => k !== 'credit_no_ledger');
const gut = (db: Db, id: string): Record<string, unknown> => row(db, 'SELECT amount, used_amount, status FROM supplier_credits WHERE id = ?', [id]);
const stand = (id: string) => (db: Db) => S(gut(db, id));

// §1 — aktive Teilnutzung, dann volle Nutzung: kein Befund, alle Leser einig.
{
  const w = retourWelt();
  const y = kauf([{ productId: 'p3', quantity: 1, unitPrice: 1000 }]);
  imHaus(() => payables.applyCreditToPurchaseInHouse(y, 400, CTX));
  const teil = leser(w.db);
  const g1 = gut(w.db, w.creditId);
  ok(einig(teil, 600) && teil.errors.length === 0 && warn(teil).length === 0 && Number(g1.used_amount) === 400 && g1.status === 'OPEN',
    `TEIL aktive Teilnutzung 400 von 1000: alle Leser 600, kein Befund (${S(teil.errors)} ${S(teil.warnings)} ${S(g1)})`);
  imHaus(() => payables.applyCreditToPurchaseInHouse(y, 600, CTX));
  const voll = leser(w.db);
  const g2 = gut(w.db, w.creditId);
  ok(einig(voll, 0) && voll.errors.length === 0 && warn(voll).length === 0 && Number(g2.used_amount) === 1000 && g2.status === 'USED',
    `VOLL volle Nutzung 1000: alle Leser 0, USED, kein Befund (${S(voll.errors)} ${S(voll.warnings)} ${S(g2)})`);
  ok(balanced(w.db), 'VOLL jede Buchung ausgeglichen');
}

// §2 — stornierte Nutzung (Guthaben VOLL eingelöst auf einen Einkauf über 1200, der dadurch teilbezahlt
// bleibt; ein ganz bezahlter Einkauf ist nicht stornierbar), Einkauf über den Fernbefehl storniert: Historie, kein Befund.
{
  const w = retourWelt();
  const y = kauf([{ productId: 'p3', quantity: 1, unitPrice: 1200 }]);
  const app = imHaus(() => payables.applyCreditToPurchaseInHouse(y, 1000, CTX));
  ok(gut(w.db, w.creditId).status === 'USED', 'STORNO Setup: das Guthaben ist voll eingelöst (USED)');
  const payId = app.applications[0].paymentId;
  const c = await fern(() => cmds.runPurchaseCancel(deps(w.db), identity(nx(), OP_CANCEL), { purchaseId: y, expectedRevision: rev(w.db, y) }));
  const g = gut(w.db, w.creditId);
  const l = leser(w.db);
  const sp = spur(w.db, 'PURCHASE_PAYMENT', payId);
  ok(c.ok && Number(g.used_amount) === 0 && g.status === 'OPEN', `STORNO Einlösung zurückgenommen: Guthaben used 0, OPEN (${S(g)})`);
  ok(s(w.db, 'SELECT reference FROM purchase_payments WHERE id = ?', [payId]) === w.creditId && sp.orig > 0 && sp.lebend === 0 && sp.storno === sp.orig,
    `STORNO die Zahlungszeile bleibt als Historie, ihre Buchung ist vollständig gegengebucht (${S(sp)})`);
  ok(einig(l, 1000) && l.errors.length === 0 && !l.warnings.includes('used_drift') && warn(l).length === 0,
    `STORNO alle Leser 1000, keine used_drift, kein Befund (${S(l.errors)} ${S(l.warnings)})`);
}

// §3 — der reproduzierte Befund über die normale Maske/PC2: Standalone-Guthaben eingelöst, Einkauf
// storniert, Guthaben erstattet (die Zeile verschwindet rechtmäßig) → vorher bad_reference (error).
{
  const db = freshDb();
  const creditId = imHaus(() => payables.grantStandaloneCreditInHouse('sup-1', 500, 'cash', 'R7A Vorauszahlung', CTX));
  const y = kauf([{ productId: 'p3', quantity: 1, unitPrice: 800 }]);
  const app = imHaus(() => payables.applyCreditToPurchaseInHouse(y, 300, CTX));
  const payId = app.applications[0].paymentId;
  const c = await fern(() => cmds.runPurchaseCancel(deps(db), identity(nx(), OP_CANCEL), { purchaseId: y, expectedRevision: rev(db, y) }));
  nimm(db); reload();
  const erstattbar = useSupplierStore.getState().getSupplierCreditsForDisplay('sup-1').some((k) => k.refundable);
  const r = imHaus(() => payables.refundStandaloneCreditInHouse(creditId, CTX));
  const l = leser(db);
  const alt = alteRegel(db);
  ok(c.ok && erstattbar && !!r && n(db, 'SELECT COUNT(*) FROM supplier_credits WHERE id = ?', [creditId]) === 0
    && s(db, 'SELECT reference FROM purchase_payments WHERE id = ?', [payId]) === creditId,
  'REPRO Einlösung storniert → Guthaben wieder erstattbar → erstattet: Zeile weg, die stornierte Zahlung zeigt weiter auf sie');
  ok(alt === 1, `REPRO die alte Regel meldete hier einen harten Befund (${alt} Zahlung ohne Guthabenzeile)`);
  ok(l.errors.length === 0 && warn(l).length === 0, `FIX die Abstimmung meldet nichts Falsches (${S(l.errors)} ${S(l.warnings)})`);
  ok(einig(l, 0) && balanced(db) && salden(db) === '[]', `FIX Salden korrekt: alle Leser 0, Hauptbuch ausgeglichen und auf 0 (${S(l.werte)} ${salden(db)})`);
}

// §4 — gemischt: eine stornierte UND eine lebende Einlösung desselben Guthabens → nur die lebende zählt.
{
  const db = freshDb();
  const creditId = imHaus(() => payables.grantStandaloneCreditInHouse('sup-1', 500, 'cash', undefined, CTX));
  const y1 = kauf([{ productId: 'p3', quantity: 1, unitPrice: 800 }]);
  imHaus(() => payables.applyCreditToPurchaseInHouse(y1, 200, CTX));
  const c = await fern(() => cmds.runPurchaseCancel(deps(db), identity(nx(), OP_CANCEL), { purchaseId: y1, expectedRevision: rev(db, y1) }));
  nimm(db);
  const y2 = kauf([{ productId: 'p2', quantity: 1, unitPrice: 400 }]);
  imHaus(() => payables.applyCreditToPurchaseInHouse(y2, 150, CTX));
  const l = leser(db);
  const g = gut(db, creditId);
  ok(c.ok && Number(g.used_amount) === 150 && l.errors.length === 0 && !l.warnings.includes('used_drift') && einig(l, 350),
    `GEMISCHT stornierte 200 + lebende 150: used 150 == Σ lebende Einlösungen, alle Leser 350, kein Befund (${S(g)} ${S(l.errors)} ${S(l.warnings)})`);
}

// §5 — echte Abweichungen bleiben erkennbar.
{
  // (a) eine LEBENDE Einlösung, deren Guthabenzeile fehlt — genau der Schaden, für den die Prüfung da ist.
  const db = freshDb();
  const creditId = imHaus(() => payables.grantStandaloneCreditInHouse('sup-1', 500, 'cash', undefined, CTX));
  const y = kauf([{ productId: 'p3', quantity: 1, unitPrice: 800 }]);
  const app = imHaus(() => payables.applyCreditToPurchaseInHouse(y, 300, CTX));
  const payId = app.applications[0].paymentId;
  db.run('DELETE FROM supplier_credits WHERE id = ?', [creditId]);
  const l = leser(db);
  ok(l.errors.includes(`bad_reference:${payId}`), `ECHT lebende Einlösung ohne Guthabenzeile → bad_reference (error) (${S(l.errors)})`);
}
{
  const db = freshDb();
  const creditId = imHaus(() => payables.grantStandaloneCreditInHouse('sup-1', 500, 'cash', undefined, CTX));
  const y = kauf([{ productId: 'p3', quantity: 1, unitPrice: 800 }]);
  imHaus(() => payables.applyCreditToPurchaseInHouse(y, 300, CTX));
  const vorher = stand(creditId)(db);
  db.run('UPDATE supplier_credits SET used_amount = 250 WHERE id = ?', [creditId]);
  const drift = leser(db);
  ok(drift.warnings.includes('used_drift'), `ECHT used_amount ≠ Σ lebende Einlösungen → used_drift (${S(drift.warnings)})`);
  db.run('UPDATE supplier_credits SET used_amount = 600 WHERE id = ?', [creditId]);
  const ueber = leser(db);
  ok(ueber.errors.includes(`overused:${creditId}`), `ECHT used > amount → overused (error) (${S(ueber.errors)})`);
  insert(db, 'purchase_payments', { id: 'pp-ohne-ref', purchase_id: y, amount: 10, method: 'credit', paid_at: NOW, created_at: NOW });
  const ohneRef = leser(db);
  ok(ohneRef.errors.includes('bad_reference:pp-ohne-ref'), `ECHT credit-Zahlung ohne Referenz → bad_reference (error) (${S(ohneRef.errors)})`);
  ok(vorher !== stand(creditId)(db), 'ECHT (die Abweichungen sind hier absichtlich von Hand gesetzt)');
}

// §6 — Quelltext: die Regel steht an EINER Stelle, für beide Einlösungsarten, im Prüfer — nicht in den Schreibern.
{
  const cp = codeOf(src('src/core/ledger/counterpartyAudit.ts'));
  ok(/source_module IN \('PURCHASE_PAYMENT','EXPENSE_PAYMENT'\)/.test(cp) && /reverses_entry_id = o\.id/.test(cp)
    && /if \(!liveCreditPay\(mod, r\.id\)\) continue;/.test(cp) && /appliedFils\.get\(id\) \?\? 0/.test(cp),
  'SOURCE counterpartyAudit: nur LEBENDE Einlösungen zählen (applied) und werden geprüft (bad_reference) — Kauf- und Ausgabenzahlungen');
  ok(!/INSERT INTO supplier_credits|UPDATE supplier_credits/.test(cp), 'SOURCE der Prüfer schreibt nichts (kein künstliches Reparieren)');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — post-parity r7a pp-1 supplier credit reconciliation: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('POST_PARITY_R7A_PP1_SUPPLIER_CREDIT_RECONCILIATION_FIXED');
