// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6F — SUPPLIER CREDIT REVERSAL (Vertrag gepinnt, Klasse B).
// Run: node test/r6f/supplier-credit-reversal-contract.test.ts
//
// Entscheid: `supplier_credits` ist eine operative Saldo-Zeile (keine Nummer, kein Druck/Export,
// keine Detailansicht; die Overpay-Zeile wird bei jeder Ueberschuss-Aenderung mit NEUER id neu
// angelegt). Die Historie tragen Quellbeleg (purchase_returns / purchases + Zahlungen, CANCELLED),
// Hauptbuch (Original + Storno, ausgeglichen) und Protokoll (CREATE mit Betrag + DELETE). Darum
// darf die Zeile bei einer VOLLEN Rueckabwicklung weiter geloescht werden — aber nur, solange keine
// LEBENDE Einloesung existiert (dann Sperre, nichts geschrieben).
//
// Gefahren werden die ECHTEN Schreiber (Haus + Store-Altanschluesse + Fernbefehl) auf dem echten
// Schema; gestellt sind nur Speichern und Netz (Bootstrap wie purchase-parity.test.ts).
//
//   §1 Schreiber/Leser (Quelltext)   §2 Retouren-Guthaben, nie benutzt   §3 Overpay-Guthaben, nie benutzt
//   §4 Guthaben benutzt → Sperre     §5 FLAG: benutzt, Einloesung storniert, dann Rueckabwicklung
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

// ══ §1 — Schreiber und Leser (Quelltext + Schema + Abgleich-Manifest) ═════════
{
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const f of readdirSync(d)) {
      const p = resolvePath(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(f)) files.push(p);
    }
  };
  walk(resolvePath(repo, 'src'));
  const rel = (p: string): string => relative(repo, p).replace(/\\/g, '/');
  const treffer = (re: RegExp): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const f of files) {
      const c = (codeOf(readFileSync(f, 'utf8')).match(re) || []).length;
      if (c > 0) out[rel(f)] = c;
    }
    return out;
  };
  const del = treffer(/DELETE FROM supplier_credits/g);
  ok(S(del) === S({
    'src/core/payables/payables-house.ts': 1, 'src/core/payables/purchase-overpay.ts': 1, 'src/core/purchases/purchase-lifecycle-house.ts': 1,
  }), `WRITER genau drei Loeschstellen: Standalone-Refund, Overpay-Clawback, Retouren-Umkehr (${S(del)})`);
  const ins = treffer(/INSERT INTO supplier_credits/g);
  ok(S(Object.keys(ins).sort()) === S(['src/core/operations/b1-protocol.ts', 'src/core/payables/payables-house.ts',
    'src/core/payables/purchase-overpay.ts', 'src/core/purchases/purchase-lifecycle-house.ts']),
  `WRITER Anlage: Retoure (Guthaben), Overpay-Rebook, Standalone-Grant, B1-Fallback (${S(ins)})`);
  const upd = treffer(/UPDATE supplier_credits/g);
  ok(S(Object.keys(upd).sort()) === S(['src/core/finance/supplierCreditRestore.ts', 'src/core/operations/b1-protocol.ts', 'src/core/payables/payables-house.ts']),
    `WRITER Aenderung nur used_amount/status: Einloesung (Einkauf, Ausgaben), Restore, B1 (${S(upd)})`);
  const leserDateien = Object.keys(treffer(/supplier_credits/g)).sort();
  ok(!leserDateien.some((f) => /\.tsx$|pdf|export|print/i.test(f)),
    `READER keine Seite, kein PDF/Export/Druck liest die Tabelle direkt — nur Stores/Core (${leserDateien.join(', ')})`);
  // Jede Loeschstelle steht hinter einer used-Sperre.
  const lh = codeOf(src('src/core/purchases/purchase-lifecycle-house.ts'));
  const umkehr = lh.slice(lh.indexOf('export function reverseConfirmedPurchaseReturnInHouse'), lh.indexOf('export interface PurchaseCancelOptions'));
  ok(umkehr.indexOf("'PURCHASE_RETURN_CREDIT_USED'") > 0 && umkehr.indexOf("'PURCHASE_RETURN_CREDIT_USED'") < umkehr.indexOf('DELETE FROM supplier_credits'),
    'GUARD Retouren-Umkehr: used > 0 sperrt VOR dem Loeschen');
  const ov = codeOf(src('src/core/payables/purchase-overpay.ts'));
  ok(/teardownSupplierOverpayCredit[\s\S]*?assertSupplierOverpayCreditUnused\(purchaseId, msg\);[\s\S]*?clawbackSupplierOverpayCredit/.test(ov)
    && /if \(ex && ex\.used > 0\.005\) throw new OverpayCreditRedeemed[\s\S]*?clawbackSupplierOverpayCredit\(purchaseId\)/.test(ov),
  'GUARD Overpay-Teardown und -Rebook: eingeloestes Guthaben sperrt VOR dem Clawback');
  // Schema: keine Belegnummer, kein Storno-Feld; status existiert (OPEN/USED), CANCELLED kennt kein Schreiber.
  const db = freshDb();
  const cols = (db.exec('PRAGMA table_info(supplier_credits)')[0]?.values ?? []).map((v) => String(v[1]));
  ok(cols.includes('status') && !cols.some((c) => /number|cancel|void/i.test(c)),
    `SCHEMA supplier_credits hat status, aber keine Nummer und kein Storno-Feld (${cols.join(',')})`);
  ok(!files.some((f) => /supplier_credits[^`]*status\s*=\s*'CANCELLED'|'CANCELLED'[^`]*supplier_credits/.test(codeOf(readFileSync(f, 'utf8'))
    .split('\n').filter((l) => l.includes('supplier_credits')).join('\n'))),
  'SCHEMA kein Schreiber setzt supplier_credits auf CANCELLED');
  const manifest = JSON.parse(src('src/core/sync/sync-business-schema.json'));
  const findTable = (o: unknown): Record<string, unknown> | null => {
    if (!o || typeof o !== 'object') return null;
    const r = o as Record<string, unknown>;
    if (r.supplier_credits && typeof r.supplier_credits === 'object') return r.supplier_credits as Record<string, unknown>;
    for (const v of Object.values(r)) { const x = findTable(v); if (x) return x; }
    return null;
  };
  const m = findTable(manifest);
  ok(!!m && S((m.allowed_operations as string[]).slice().sort()) === S(['delete', 'insert', 'update']),
    `SYNC das Manifest erlaubt insert/update/delete — die Loeschung reist zum PC2 (${S(m?.allowed_operations)})`);
  // Leser: Auswahl/Karte nur OPEN; Salden summieren ALLE Zeilen (eine Storno-Zeile muesste dort gefiltert werden).
  const ss = codeOf(src('src/stores/supplierStore.ts'));
  ok(/FROM supplier_credits WHERE supplier_id = \? AND branch_id = \? AND status = 'OPEN'/.test(ss)
    && /SUM\(amount - used_amount\), 0\) AS bal\s*FROM supplier_credits WHERE supplier_id = \?`/.test(ss),
  'READER Karte/Auswahl lesen nur OPEN; die KPI summiert alle Zeilen');
  ok(/FROM supplier_credits\s*WHERE branch_id = \?/.test(codeOf(src('src/core/reports/reconciliation-snapshot.ts')))
    && /FROM supplier_credits WHERE branch_id=\? GROUP BY cid/.test(codeOf(src('src/core/ledger/counterpartyAudit.ts'))),
  'READER Reconciliation und Counterparty-Sektion summieren alle Zeilen der Filiale');
  // Die Retoure hat im Store zwei Altanschluesse ohne Aufrufer; deleteReturn loescht auch den Beleg.
  const aufrufer = files.filter((f) => !f.endsWith('purchaseStore.ts') && /\bdeleteReturn\b/.test(codeOf(readFileSync(f, 'utf8'))));
  ok(aufrufer.length === 0, `LEGACY purchaseStore.deleteReturn hat keinen Aufrufer (${aufrufer.map(rel).join(', ') || 'keiner'})`);
  flag('purchaseStore.deleteReturn (ohne Aufrufer) loescht nach der Umkehr auch purchase_returns + Zeilen hart — Beleg weg; nicht erreichbar, nicht Teil dieses Vertrags.');
}
marker('CENTRAL_UI_R6F_SUPPLIER_CREDIT_WRITERS_READERS_PINNED');

// ══ §2 — Retouren-Guthaben, nie benutzt → volle Rueckabwicklung ══════════════
{
  // (a) Einkauf stornieren (Store-Altanschluss = Kommission; Maske/Fern lehnen PAID ab).
  const w = retourWelt();
  const vor = leser(w.db);
  ok(einig(vor, 1000) && vor.errors.length === 0,
    `SETUP Guthaben 1000 OPEN — alle Leser einig, keine harten Befunde (${S(vor.werte)} ${S(vor.errors)})`);
  const rPaid = await fern(() => cmds.runPurchaseCancel(deps(w.db), identity(nx(), OP_CANCEL), { purchaseId: w.pid, expectedRevision: rev(w.db, w.pid) }));
  ok(rPaid.code === 'PURCHASE_PAID_NOT_CANCELLABLE' && n(w.db, 'SELECT COUNT(*) FROM supplier_credits WHERE id = ?', [w.creditId]) === 1,
    `REACH Maske/Fern: ein Einkauf mit Retouren-Guthaben ist PAID → Cancel abgelehnt, Guthaben unberuehrt (${rPaid.code})`);
  nimm(w.db);
  usePurchaseStore.getState().cancelPurchase(w.pid);
  ok(n(w.db, 'SELECT COUNT(*) FROM supplier_credits WHERE id = ?', [w.creditId]) === 0, 'DELETE die ungenutzte Guthabenzeile ist weg');
  const ret = row(w.db, 'SELECT status, total_amount, refund_method, refund_amount FROM purchase_returns WHERE id = ?', [w.returnId]);
  ok(ret.status === 'CANCELLED' && Number(ret.refund_amount) === 1000 && ret.refund_method === 'credit'
    && n(w.db, 'SELECT COUNT(*) FROM purchase_return_lines WHERE return_id = ?', [w.returnId]) === 2,
  `SOURCE die Retoure bleibt als CANCELLED mit Zeilen, Erstattung 1000 als Guthaben (${S(ret)})`);
  const p = row(w.db, 'SELECT status, total_amount, paid_amount FROM purchases WHERE id = ?', [w.pid]);
  ok(p.status === 'CANCELLED' && Number(p.total_amount) === 1800 && n(w.db, 'SELECT COUNT(*) FROM purchase_payments WHERE purchase_id = ?', [w.pid]) === 1,
    `SOURCE der Einkauf bleibt als CANCELLED mit Originalsumme und Zahlung (${S(p)})`);
  const sp = spur(w.db, 'PURCHASE_RETURN', w.returnId);
  const scLegs = all(w.db, `SELECT o.direction, ROUND(o.amount, 3), r.direction FROM ledger_entries o LEFT JOIN ledger_entries r ON r.reverses_entry_id = o.id
                            WHERE o.source_module = 'PURCHASE_RETURN' AND o.source_id = ? AND o.reverses_entry_id IS NULL AND o.account = 'SUPPLIER_CREDIT'`, [w.returnId]);
  ok(sp.orig === 4 && sp.storno === 4 && sp.lebend === 0 && scLegs === S([['DEBIT', 1000, 'CREDIT']]) && balanced(w.db),
    `LEDGER Original (DR SUPPLIER_CREDIT 1000 …) UND Storno bleiben, ausgeglichen (${S(sp)} ${scLegs})`);
  ok(salden(w.db) === '[]', `LEDGER nach dem vollen Rueckbau steht jedes Konto auf 0 (${salden(w.db)})`);
  ok(protokoll(w.db, 'supplier_credits', w.creditId) === S([['CREATE'], ['DELETE']])
    && n(w.db, "SELECT COUNT(*) FROM audit_log WHERE entity_type = 'supplier_credits' AND entity_id = ? AND action_type = 'CREATE' AND new_value LIKE '%1000%'", [w.creditId]) === 1
    && statusProtokoll(w.db, 'purchase_returns', w.returnId) && statusProtokoll(w.db, 'purchases', w.pid),
  'AUDIT Guthaben CREATE (mit Betrag) + DELETE; Retoure und Einkauf STATUS_CHANGE → CANCELLED');
  ok(n(w.db, "SELECT COUNT(*) FROM sync_changelog WHERE table_name = 'supplier_credits' AND record_id = ? AND action = 'delete'", [w.creditId]) === 1,
    'SYNC die Loeschung geht in den Abgleich');
  const nach = leser(w.db);
  ok(einig(nach, 0) && nach.errors.length === 0, `READERS nachher alle 0 und einig, keine harten Befunde (${S(nach.werte)} ${S(nach.errors)})`);

  // (b) Nur die Retoure umkehren (Store-Altanschluss cancelReturn) — Einkauf lebt weiter.
  const w2 = retourWelt();
  nimm(w2.db);
  usePurchaseStore.getState().cancelReturn(w2.returnId);
  const p2 = row(w2.db, 'SELECT status, total_amount, paid_amount, remaining_amount FROM purchases WHERE id = ?', [w2.pid]);
  ok(n(w2.db, 'SELECT COUNT(*) FROM supplier_credits') === 0 && s(w2.db, 'SELECT status FROM purchase_returns WHERE id = ?', [w2.returnId]) === 'CANCELLED'
    && Number(p2.total_amount) === 1800 && Number(p2.paid_amount) === 1500 && Number(p2.remaining_amount) === 300 && p2.status === 'PARTIALLY_PAID',
  `CANCEL-RETURN Guthaben weg, Retoure CANCELLED, Einkauf zurueck auf 1800 / 1500 / offen 300 (${S(p2)})`);
  const sp2 = spur(w2.db, 'PURCHASE_RETURN', w2.returnId);
  ok(sp2.orig === 4 && sp2.storno === 4 && sp2.lebend === 0 && balanced(w2.db)
    && protokoll(w2.db, 'supplier_credits', w2.creditId) === S([['CREATE'], ['DELETE']]) && statusProtokoll(w2.db, 'purchase_returns', w2.returnId),
  `CANCEL-RETURN Hauptbuch Original + Storno, Protokoll CREATE/DELETE + STATUS_CHANGE (${S(sp2)})`);
  const nach2 = leser(w2.db);
  ok(einig(nach2, 0) && nach2.errors.length === 0, `CANCEL-RETURN alle Leser 0 (${S(nach2.werte)})`);
}
marker('CENTRAL_UI_R6F_SUPPLIER_CREDIT_RETURN_REVERSAL_PINNED');

// ══ §3 — Overpay-Guthaben, nie benutzt → Rebook (neue id) und volle Rueckabwicklung ═
{
  const w = overWelt();
  const vor = leser(w.db);
  ok(einig(vor, 200) && vor.errors.length === 0, `SETUP Overpay-Guthaben 200 — alle Leser einig (${S(vor.werte)} ${S(vor.errors)})`);
  // Rebook: jede Aenderung des Ueberschusses legt die Zeile NEU an — ihre id ist keine Belegidentitaet.
  usePurchaseStore.getState().addPayment(w.pid, 100, 'cash');
  const neu = s(w.db, 'SELECT id FROM supplier_credits WHERE source_purchase_id = ? AND source_return_id IS NULL', [w.pid]);
  ok(neu !== '' && neu !== w.creditId && n(w.db, 'SELECT COUNT(*) FROM supplier_credits') === 1
    && n(w.db, 'SELECT amount FROM supplier_credits WHERE id = ?', [neu]) === 300
    && protokoll(w.db, 'supplier_credits', w.creditId) === S([['CREATE'], ['DELETE']]),
  'REBOOK Ueberschuss 200 → 300: alte Zeile geloescht, neue Zeile (neue id) — eine berechnete Saldo-Zeile');
  const spR = spur(w.db, 'PURCHASE_OVERPAY', w.pid);
  ok(spR.storno === 2 && spR.lebend === 2 && balanced(w.db), `REBOOK Hauptbuch: altes Reklass-Bein storniert, neues lebt (${S(spR)})`);
  ok(einig(leser(w.db), 300), 'REBOOK alle Leser 300');
  // Volle Rueckabwicklung.
  const rPaid = await fern(() => cmds.runPurchaseCancel(deps(w.db), identity(nx(), OP_CANCEL), { purchaseId: w.pid, expectedRevision: rev(w.db, w.pid) }));
  ok(rPaid.code === 'PURCHASE_PAID_NOT_CANCELLABLE', `REACH Maske/Fern: ein ueberzahlter Einkauf ist PAID → Cancel abgelehnt (${rPaid.code})`);
  nimm(w.db);
  usePurchaseStore.getState().cancelPurchase(w.pid);
  ok(n(w.db, 'SELECT COUNT(*) FROM supplier_credits') === 0, 'DELETE die ungenutzte Overpay-Zeile ist weg');
  const p = row(w.db, 'SELECT status, total_amount, paid_amount FROM purchases WHERE id = ?', [w.pid]);
  ok(p.status === 'CANCELLED' && Number(p.paid_amount) === 1300 && n(w.db, 'SELECT COUNT(*) FROM purchase_payments WHERE purchase_id = ?', [w.pid]) === 2,
    `SOURCE der Einkauf bleibt CANCELLED mit beiden Zahlungen (Ueberzahlung sichtbar: 1300 auf 1000) (${S(p)})`);
  const sp = spur(w.db, 'PURCHASE_OVERPAY', w.pid);
  ok(sp.orig === 4 && sp.storno === 4 && sp.lebend === 0 && balanced(w.db) && salden(w.db) === '[]',
    `LEDGER beide Reklass-Zyklen Original + Storno, alles ausgeglichen und auf 0 (${S(sp)} ${salden(w.db)})`);
  ok(protokoll(w.db, 'supplier_credits', neu) === S([['CREATE'], ['DELETE']]) && statusProtokoll(w.db, 'purchases', w.pid)
    && n(w.db, "SELECT COUNT(*) FROM sync_changelog WHERE table_name = 'supplier_credits' AND action = 'delete'") === 2,
  'AUDIT/SYNC CREATE + DELETE je Zeile, Einkauf STATUS_CHANGE → CANCELLED, beide Loeschungen im Abgleich');
  const nach = leser(w.db);
  ok(einig(nach, 0) && nach.errors.length === 0, `READERS nachher alle 0 und einig (${S(nach.werte)} ${S(nach.errors)})`);
}
marker('CENTRAL_UI_R6F_SUPPLIER_CREDIT_OVERPAY_REVERSAL_PINNED');

// ══ §4 — Guthaben (teil-)benutzt → jede Rueckabwicklung gesperrt, nichts geschrieben ═
{
  // (a) Retouren-Guthaben 600 von 1000 in einen zweiten Einkauf eingeloest.
  const w = retourWelt();
  const y = kauf([{ productId: 'p3', quantity: 1, unitPrice: 1000 }]);
  const app = imHaus(() => payables.applyCreditToPurchaseInHouse(y, 600, CTX));
  ok(app.applications.length === 1 && app.applications[0].creditId === w.creditId, 'SETUP 600 aus dem Retouren-Guthaben eingeloest');
  const vor = zaehler(w.db);
  nimm(w.db); reload();
  const alt = wirft(() => usePurchaseStore.getState().cancelPurchase(w.pid));
  const ret = wirft(() => usePurchaseStore.getState().cancelReturn(w.returnId));
  const haus = wirft(() => imHaus(() => life.cancelPurchaseInHouse(w.pid, 'branch-main')));
  ok(alt === 'PURCHASE_RETURN_CREDIT_USED' && ret === 'PURCHASE_RETURN_CREDIT_USED' && haus === 'PURCHASE_RETURN_CREDIT_USED' && zaehler(w.db) === vor,
    `BLOCK Einkauf-Storno, Retouren-Storno, Haus: PURCHASE_RETURN_CREDIT_USED, nichts geschrieben (${alt} / ${ret} / ${haus})`);
  const l = leser(w.db);
  ok(einig(l, 400) && l.errors.length === 0, `READERS Rest 400 ueberall (${S(l.werte)})`);
  // „Refunded": Retouren-/Overpay-Guthaben sind nicht erstattbar (nur Standalone) — kein Refund-Zustand moeglich.
  ok(wirft(() => imHaus(() => payables.refundStandaloneCreditInHouse(w.creditId, CTX))) === 'SUPPLIER_CREDIT_NOT_FOUND'
    && useSupplierStore.getState().getSupplierCreditsForDisplay('sup-1').every((c) => c.kind === 'return' && !c.refundable),
  'REFUND ein Retouren-Guthaben ist nicht erstattbar (SUPPLIER_CREDIT_NOT_FOUND, Karte ohne Refund-Knopf)');

  // (b) Retouren-Guthaben gegen eine Lieferanten-Ausgabe eingeloest.
  const wE = retourWelt();
  insert(wE.db, 'expenses', { id: 'exp-1', branch_id: 'branch-main', expense_number: 'EXP-1', category: 'RepairCosts', amount: 300,
    payment_method: 'cash', expense_date: '2026-09-14', status: 'PENDING', paid_amount: 0, supplier_id: 'sup-1', created_at: NOW });
  const ex = imHaus(() => payables.applySupplierCreditToExpensesInHouse('sup-1', 250, CTX));
  const vorE = zaehler(wE.db);
  nimm(wE.db); reload();
  const altE = wirft(() => usePurchaseStore.getState().cancelPurchase(wE.pid));
  ok(ex.applied === 250 && altE === 'PURCHASE_RETURN_CREDIT_USED' && zaehler(wE.db) === vorE,
    `BLOCK Einloesung gegen eine Ausgabe sperrt ebenso (${altE})`);

  // (c) Overpay-Guthaben 150 von 200 eingeloest → Storno und Rebook gesperrt.
  const wO = overWelt();
  const y2 = kauf([{ productId: 'p3', quantity: 1, unitPrice: 500 }]);
  imHaus(() => payables.applyCreditToPurchaseInHouse(y2, 150, CTX));
  const vorO = zaehler(wO.db);
  nimm(wO.db); reload();
  const altO = wirft(() => usePurchaseStore.getState().cancelPurchase(wO.pid));
  const rebook = wirft(() => usePurchaseStore.getState().addPayment(wO.pid, 100, 'cash'));
  ok(altO === 'PURCHASE_OVERPAY_CREDIT_REDEEMED' && rebook === 'PURCHASE_OVERPAY_CREDIT_REDEEMED' && zaehler(wO.db) === vorO,
    `BLOCK Overpay eingeloest: Storno und Rebook PURCHASE_OVERPAY_CREDIT_REDEEMED, nichts geschrieben (${altO} / ${rebook})`);
  ok(einig(leser(wO.db), 50), 'READERS Overpay-Rest 50 ueberall');
}
marker('CENTRAL_UI_R6F_SUPPLIER_CREDIT_USED_BLOCK_PINNED');

// ══ §5 — benutzt, Einloesung storniert (used → 0), dann Rueckabwicklung ══════════════
// Die Sperre prueft used_amount, nicht „nie benutzt". Nach dem Storno des einloesenden Einkaufs
// bleibt dessen Zahlungszeile (method 'credit', reference = Guthaben-id) als Historie stehen; die
// Rueckabwicklung loescht die Guthabenzeile trotzdem → die Referenz zeigt ins Leere. Geld/Salden
// bleiben korrekt. Bis R7A meldete die Counterparty-Pruefung dafuer einen harten Befund
// (bad_reference) — POST-PARITY R7A (PP-1): eine vollstaendig stornierte Einloesung ist Historie und
// wird weder als applied gezaehlt noch auf ihre Guthabenzeile geprueft.
{
  const w = retourWelt();
  const y = kauf([{ productId: 'p3', quantity: 1, unitPrice: 1000 }]);
  const app = imHaus(() => payables.applyCreditToPurchaseInHouse(y, 600, CTX));
  const payId = app.applications[0].paymentId;
  const c = await fern(() => cmds.runPurchaseCancel(deps(w.db), identity(nx(), OP_CANCEL), { purchaseId: y, expectedRevision: rev(w.db, y) }));
  const g = row(w.db, 'SELECT used_amount, status FROM supplier_credits WHERE id = ?', [w.creditId]);
  ok(c.ok && Number(g.used_amount) === 0 && g.status === 'OPEN', `SETUP Einloesender Einkauf storniert (Maske/Fern) → Guthaben used 0, OPEN (${S(g)})`);
  const zw = leser(w.db);
  // POST-PARITY R7A (PP-1) — die stornierte Einloesung ist Historie, keine lebende: sie zaehlt nicht
  // mehr als applied → keine falsche used_drift-Warnung.
  ok(einig(zw, 1000) && zw.errors.length === 0 && !zw.warnings.includes('used_drift'),
    `READERS 1000 einig; die stornierte Einloesung zaehlt nicht als applied — keine used_drift (${S(zw.warnings)})`);
  nimm(w.db);
  usePurchaseStore.getState().cancelPurchase(w.pid);
  const ref = s(w.db, 'SELECT reference FROM purchase_payments WHERE id = ?', [payId]);
  ok(n(w.db, 'SELECT COUNT(*) FROM supplier_credits WHERE id = ?', [w.creditId]) === 0 && ref === w.creditId
    && s(w.db, 'SELECT status FROM purchases WHERE id = ?', [y]) === 'CANCELLED',
  'PINNED Rueckabwicklung erlaubt (used 0): Zeile geloescht, die Zahlungszeile des stornierten Einkaufs referenziert sie weiter');
  const nach = leser(w.db);
  ok(einig(nach, 0) && balanced(w.db) && salden(w.db) === '[]', `PINNED Salden bleiben korrekt: alle Leser 0, Hauptbuch auf 0 (${S(nach.werte)})`);
  // R7A (PP-1) — vorher: bad_reference (error) fuer genau diese Zahlung, obwohl Geld und Salden stimmten.
  ok(S(nach.errors) === '[]' && !nach.warnings.includes('used_drift'),
    `R7A Reconciliation meldet KEINE falsche bad_reference mehr — die Zahlung ist storniert (Historie) (${S(nach.errors)})`);

  // Dasselbe beim Overpay-Rebook (keine volle Rueckabwicklung): Einloesung storniert, dann neue Zahlung.
  const wO = overWelt();
  const y2 = kauf([{ productId: 'p3', quantity: 1, unitPrice: 500 }]);
  const app2 = imHaus(() => payables.applyCreditToPurchaseInHouse(y2, 150, CTX));
  await fern(() => cmds.runPurchaseCancel(deps(wO.db), identity(nx(), OP_CANCEL), { purchaseId: y2, expectedRevision: rev(wO.db, y2) }));
  nimm(wO.db);
  usePurchaseStore.getState().addPayment(wO.pid, 100, 'cash');
  const lO = leser(wO.db);
  ok(n(wO.db, 'SELECT COUNT(*) FROM supplier_credits WHERE id = ?', [wO.creditId]) === 0 && einig(lO, 300)
    && S(lO.errors) === '[]' && !!app2.applications[0].paymentId,
  `R7A Overpay-Rebook nach storniertem Einloesen: alte Zeile weg, Salden 300 korrekt, keine falsche bad_reference (${S(lO.errors)})`);
}
marker('CENTRAL_UI_R6F_SUPPLIER_CREDIT_RESTORED_USAGE_FLAG_PINNED');

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central ui r6f supplier credit reversal contract: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R6F_SUPPLIER_CREDIT_REVERSAL_CONTRACT_PINNED');
