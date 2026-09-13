// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6F — der Lebenszyklus eines Einkaufs: „Return to Supplier"
// (`purchases.return_to_supplier`), „Cancel" (`purchases.cancel`) und „Inbox-Foto verwerfen"
// (`purchases.dismiss_inbox`) — EINE Hausfolge für Primary und PC2.
// Run: node test/r6f/purchase-parity.test.ts
//
// Gefahren werden die ECHTE Hausfolge (`purchase-lifecycle-house`), die echten Primary-Anschlüsse
// (`purchase-house` → `runOnPrimary`), die echten Store-Altanschlüsse, die echte C3A-Maschine mit
// durablem Nachweis und das echte Schema samt Hauptbuch. Gestellt sind nur Speichern und Netz.
//
//   §1 Umfang   §2 Rückgabe: Primary == PC2   §3 Rückgabe: Varianten (Guthaben, Benefit, Status)
//   §4 Rückgabe: Regeln   §5 Rückgabe: verlorene Antwort, alte Fassung   §6 Rückgabe: Fehlerinjektion
//   §7 Storno: Primary == PC2   §8 Storno mit Retoure   §9 Storno: Regeln, Wiederholung, Fassung
//   §10 Storno: Fehlerinjektion   §11 Inbox-Foto   §12 Client ohne Bücher   §13 Oberfläche
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

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
  // Abgleich eingeschaltet: `trackChange` schreibt ins Änderungsprotokoll — messbar, auch im Rollback.
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
const { COMMAND_LEDGER_DDL, COMMAND_LEDGER_INDEX, lookupCommand } = await import('../../src/core/bridge/command-ledger.ts');
const { resetDurabilityStateForTest } = await import('../../src/core/bridge/durability-state.ts');
const { resetTransactionHealthForTest } = await import('../../src/core/db/transaction-health.ts');
const { installWriteGuard } = await import('../../src/core/db/write-guard.ts');
const { SKU_SEQUENCES_DDL } = await import('../../src/core/products/sku-sequence.ts');
const registry = await import('../../src/core/bridge/command-registry.ts');
const perms = await import('../../src/core/bridge/command-permissions.ts');
const readOps = await import('../../src/core/bridge/store-read-ops.ts');
const cmds = await import('../../src/core/bridge/purchase-lifecycle-commands.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const { applyMediaSchema } = await import('../../src/core/db/media-schema.ts');
const payables = await import('../../src/core/payables/payables-house.ts');
const life = await import('../../src/core/purchases/purchase-lifecycle-house.ts');
const purchaseHouse = await import('../../src/core/purchases/purchase-house.ts');
const { usePurchaseStore, loadPurchaseInboxFor } = await import('../../src/stores/purchaseStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { useOrderStore } = await import('../../src/stores/orderStore.ts');
const { useSupplierStore } = await import('../../src/stores/supplierStore.ts');
const { localReadContext } = await import('../../src/core/data/read-context.ts');
const { runSharedWrite } = await import('../../src/core/data/shared-write.ts');
const { CommandSaveController } = await import('../../src/core/bridge/client-command-save.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const marker = (m: string): void => { if (fails.length === 0) console.log(m); };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const codeOf = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const S = (v: unknown): string => JSON.stringify(v);
const NOW = '2026-09-13T10:00:00.000Z';
const CTX = { branchId: 'branch-main', userId: 'user-test', now: NOW };

const OP_RET = 'purchases.return_to_supplier';
const OP_CANCEL = 'purchases.cancel';
const OP_INBOX = 'purchases.dismiss_inbox';

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
  ps.loadPurchaseInbox();
  useProductStore.getState().loadProducts();
  useOrderStore.getState().loadOrders();
  useSupplierStore.getState().loadSuppliers();
}

let current: Db;
const nimm = (db: Db): Db => { setTestDatabase(db as never); current = db; return db; };

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
  for (const [id, branch] of [['sup-1', 'branch-main'], ['sup-2', 'branch-main'], ['sup-x', 'branch-other']]) {
    db.run('INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at) VALUES (?,?,?,1,?,?)', [id, branch, 'Lieferant ' + id, NOW, NOW]);
  }
  db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level,
      preferences, customer_type, sales_stage, created_at, updated_at)
    VALUES ('cust-1','branch-main','Ali','Hassan','BH','en',0,'[]','collector','active',?,?)`, [NOW, NOW]);
  applyMediaSchema(db as never);
  nimm(db);
  installWriteGuard(db as never);
  for (const [id, branch] of [['p1', 'branch-main'], ['p2', 'branch-main'], ['p3', 'branch-main'], ['p-x', 'branch-other']]) {
    db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
        scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
        tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
      VALUES (?,?,'cat-w','Rolex',?,?,0,'Pre-Owned','[]',100,'BHD',150,'in_stock','MARGIN',0,'[]','{}','OWN',?,?)`,
    [id, branch, 'M ' + id, 'SKU-' + id, NOW, NOW]);
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

interface Zeile { productId: string; quantity: number; unitPrice: number; vat?: boolean; sourceOrderLineId?: string }
function kauf(lines: Zeile[], o: { supplierId?: string; sourceOrderId?: string } = {}): string {
  return imHaus(() => usePurchaseStore.getState().createPurchase({
    supplierId: o.supplierId ?? 'sup-1',
    sourceOrderId: o.sourceOrderId,
    lines: lines.map((l) => ({
      productId: l.productId, quantity: l.quantity, unitPrice: l.unitPrice,
      taxScheme: l.vat ? 'VAT_10' as const : 'ZERO' as const, vatRate: l.vat ? 10 : 0,
      sourceOrderLineId: l.sourceOrderLineId,
    })),
  }).id);
}
const zeilen = (db: Db, pid: string): string[] =>
  (db.exec('SELECT id FROM purchase_lines WHERE purchase_id = ? ORDER BY position', [pid])[0]?.values ?? []).map((v) => String(v[0]));
const rev = (db: Db, pid: string): number => n(db, 'SELECT revision FROM purchases WHERE id = ?', [pid]);

const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-000000000000`;
const ACTOR = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role: 'SALES' };
const identity = (x: string, op: string, over: Partial<typeof ACTOR> = {}) =>
  ({ commandId: ID(x), ...ACTOR, ...over, op, payloadHash: 'h' + x });
const deps = (db: Db) => ({
  db: db as never,
  // Jede Klammer eines Auftrags zeigt auf SEINE Datenbank (auch die, die ein Nein einfriert).
  begin: () => { setTestDatabase(db as never); posting.beginLedgerTransaction(); },
  commit: posting.commitLedgerTransaction,
  rollback: posting.rollbackLedgerTransaction,
  durableSave: async () => {},
  now: () => NOW,
});
let seq = 100;
const nx = (): string => String(++seq);

interface Ausgang { ok: boolean; code: string; frozen: boolean; thrown: boolean; value: Record<string, unknown>; replayed: boolean }
async function fern(p: () => Promise<unknown>): Promise<Ausgang> {
  try {
    const o = await p() as { kind: string; code?: string; value?: Record<string, unknown>; replayed?: boolean; frozen?: boolean };
    if (o.kind === 'ok') return { ok: true, code: '', frozen: false, thrown: false, value: o.value ?? {}, replayed: o.replayed === true };
    return { ok: false, code: o.code ?? '(ohne Code)', frozen: o.frozen === true, thrown: false, value: {}, replayed: false };
  } catch (e) {
    return { ok: false, code: (e as { code?: string }).code ?? 'THROWN:' + String(e), frozen: false, thrown: true, value: {}, replayed: false };
  }
}
async function primary(p: () => unknown): Promise<Ausgang> {
  try { return { ok: true, code: '', frozen: false, thrown: false, value: (await p() ?? {}) as Record<string, unknown>, replayed: false }; }
  catch (e) { return { ok: false, code: (e as { code?: string }).code ?? 'THROWN:' + String(e), frozen: false, thrown: true, value: {}, replayed: false }; }
}
function wirft(fn: () => unknown): string {
  try { fn(); return ''; } catch (e) { return String((e as { code?: unknown }).code ?? (e as Error).message); }
}
function meldung(fn: () => unknown): string {
  try { fn(); return ''; } catch (e) { return (e as Error).message; }
}

const OHNE = /^(id|version|sync_status)$|_at$|_date$/;
function ohne(r: Record<string, unknown>, auch: string[] = []): Record<string, unknown> {
  return Object.fromEntries(Object.entries(r).filter(([k]) => !OHNE.test(k) && !auch.includes(k)).sort(([a], [b]) => a.localeCompare(b)));
}
const unterschiede = (a: Record<string, unknown>, b: Record<string, unknown>): string[] =>
  Object.keys({ ...a, ...b }).filter((k) => S(a[k] ?? null) !== S(b[k] ?? null)).map((k) => `${k}: ${S(a[k])} vs ${S(b[k])}`);
/** Buchungen je Quelle, Konto, Richtung — was eine Handlung im Hauptbuch hinterlässt. */
const buchungen = (db: Db): string => all(db,
  `SELECT source_module, account, direction, ROUND(SUM(amount), 3), SUM(CASE WHEN reverses_entry_id IS NULL THEN 0 ELSE 1 END)
     FROM ledger_entries GROUP BY source_module, account, direction ORDER BY source_module, account, direction`);
/** Der Saldo je Konto und Gegenpartei — was ein Bericht zeigt. */
const salden = (db: Db): string => all(db,
  `SELECT account, COALESCE(counterparty_id, '') AS cp, ROUND(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 3) AS net
     FROM ledger_entries GROUP BY account, cp HAVING ABS(net) > 0.0005 ORDER BY account, cp`);
const saldo = (db: Db, account: string): number => n(db,
  `SELECT COALESCE(ROUND(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 3), 0) FROM ledger_entries WHERE account = ?`, [account]);
const lc = (db: Db): number => n(db, 'SELECT COUNT(*) FROM ledger_entries');
const changelog = (db: Db): number => n(db, 'SELECT COUNT(*) FROM sync_changelog');
/** Jede Buchung gleicht sich aus: Soll == Haben, je Transaktion, in Fils. */
function balanced(db: Db): boolean {
  const t = db.exec(`SELECT transaction_id,
      SUM(CASE WHEN direction = 'DEBIT' THEN CAST(ROUND(amount * 1000) AS INTEGER) ELSE 0 END),
      SUM(CASE WHEN direction = 'CREDIT' THEN CAST(ROUND(amount * 1000) AS INTEGER) ELSE 0 END)
    FROM ledger_entries GROUP BY transaction_id`)[0]?.values ?? [];
  return t.length > 0 && t.every((r) => Number(r[1]) === Number(r[2]));
}
/** Ein Schreibvorgang, der an einer Stelle bricht — optional mit einem Blick in den Zustand genau davor. */
function faulty(db: Db, pattern: RegExp, when: (p: unknown[]) => boolean = () => true, spy?: () => void) {
  const f = { armed: true, hit: 0 };
  const proxy = new Proxy(db as object, {
    get(t, k) {
      if (k === 'run') {
        return (sql: string, p?: unknown[]) => {
          if (f.armed && pattern.test(sql) && when(p ?? [])) {
            f.hit++;
            spy?.();
            throw new Error('INJECTED at ' + pattern);
          }
          return (t as Db).run(sql, p);
        };
      }
      const v = (t as Record<string | symbol, unknown>)[k];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  }) as unknown as Db;
  return { db: proxy, f };
}

// ════════════════════════════════════════════════════════════════════════════
// Die Welt einer Rückgabe: Einkauf bei sup-1 — Zeile A p1 2 × 500 (VAT_10), Zeile B p2 1 × 800.
// Summe 1800. Optional bar bezahlt oder mit Lieferanten-Guthaben beglichen.
// ════════════════════════════════════════════════════════════════════════════
interface Welt { db: Db; pid: string; lA: string; lB: string }
function rueckgabeWelt(o: { bezahlt?: number; guthaben?: number } = {}): Welt {
  const db = freshDb();
  const pid = kauf([{ productId: 'p1', quantity: 2, unitPrice: 500, vat: true }, { productId: 'p2', quantity: 1, unitPrice: 800 }]);
  if (o.bezahlt) usePurchaseStore.getState().addPayment(pid, o.bezahlt, 'cash');
  if (o.guthaben) {
    imHaus(() => payables.grantStandaloneCreditInHouse('sup-1', o.guthaben!, 'cash', 'Vorauszahlung', CTX));
    imHaus(() => payables.applyCreditToPurchaseInHouse(pid, 1800, CTX));
  }
  reload();
  const [lA, lB] = zeilen(db, pid);
  return { db, pid, lA, lB };
}
const rueckRumpf = (w: Welt, over: Record<string, unknown> = {}) => ({
  purchaseId: w.pid, expectedRevision: rev(w.db, w.pid), refundMethod: 'bank', notes: ' defekt ',
  lines: [{ purchaseLineId: w.lA, quantity: 1, unitPrice: 500 }, { purchaseLineId: w.lB, quantity: 1, unitPrice: 800 }],
  ...over,
});
const rueckAnfrage = (w: Welt, over: Record<string, unknown> = {}) => {
  const { expectedRevision: _r, ...req } = rueckRumpf(w, over);
  return req as unknown as Parameters<typeof life.returnToSupplierInHouse>[0];
};
function kaufBild(db: Db, pid: string) {
  return {
    einkauf: ohne(row(db, 'SELECT * FROM purchases WHERE id = ?', [pid]), ['supplier_snapshot']),
    retouren: all(db, 'SELECT return_number, status, total_amount, refund_method, refund_amount, notes, supplier_id FROM purchase_returns WHERE purchase_id = ? ORDER BY return_number', [pid]),
    retourZeilen: all(db, `SELECT prl.product_id, prl.quantity, prl.unit_price, prl.line_total FROM purchase_return_lines prl
      JOIN purchase_returns pr ON pr.id = prl.return_id WHERE pr.purchase_id = ? ORDER BY prl.product_id`, [pid]),
    lose: all(db, 'SELECT product_id, qty_total, qty_remaining, status FROM stock_lots WHERE purchase_id = ? ORDER BY product_id', [pid]),
    stueck: all(db, "SELECT id, quantity, stock_status FROM products WHERE branch_id = 'branch-main' ORDER BY id"),
    guthaben: all(db, `SELECT supplier_id, amount, used_amount, status, source_return_id IS NOT NULL, source_purchase_id IS NOT NULL
      FROM supplier_credits ORDER BY amount, status`),
    auftrag: all(db, "SELECT ol.status, o.status FROM order_lines ol JOIN orders o ON o.id = ol.order_id ORDER BY ol.id"),
    buchungen: buchungen(db),
    salden: salden(db),
  };
}
const bildDiff = (a: ReturnType<typeof kaufBild>, b: ReturnType<typeof kaufBild>): string[] => [
  ...unterschiede(a.einkauf, b.einkauf),
  ...(['retouren', 'retourZeilen', 'lose', 'stueck', 'guthaben', 'auftrag', 'buchungen', 'salden'] as const)
    .filter((k) => a[k] !== b[k]).map((k) => `${k}: ${a[k]} vs ${b[k]}`),
];
const zaehler = (db: Db) => S({
  r: n(db, 'SELECT COUNT(*) FROM purchase_returns'), rl: n(db, 'SELECT COUNT(*) FROM purchase_return_lines'),
  l: lc(db), sc: n(db, 'SELECT COUNT(*) FROM supplier_credits'), log: changelog(db),
  a: n(db, 'SELECT COUNT(*) FROM audit_log'), lose: all(db, 'SELECT qty_remaining, status FROM stock_lots ORDER BY id'),
  p: all(db, 'SELECT total_amount, paid_amount, remaining_amount, status, revision FROM purchases ORDER BY id'),
  num: all(db, 'SELECT doc_type, next_number FROM document_sequences ORDER BY doc_type'),
});

// ══ §1 — Umfang ═════════════════════════════════════════════════════════════
{
  for (const op of [OP_RET, OP_CANCEL, OP_INBOX]) {
    ok(registry.ALLOWED_MUTATIONS.includes(op), `SCOPE ${op} ist namentlich freigegeben`);
    ok(registry.knownCommands().includes(op), `SCOPE ${op} ist registriert`);
    ok(perms.OPERATION_PERMISSIONS[op] === null, `SCOPE ${op} ohne Rollen-Tor (wie die Knöpfe der Maske)`);
  }
  ok(S([...cmds.PURCHASE_LIFECYCLE_OPS].sort()) === S([OP_CANCEL, OP_INBOX, OP_RET].sort()), 'SCOPE die Befehlsdatei kennt genau diese drei');
  const reg = codeOf(src('src/core/bridge/purchase-lifecycle-commands.ts'));
  ok((reg.match(/registerCommand\(/g) || []).length === 3 && !/for \(|forEach/.test(reg.slice(reg.indexOf('registerCommand('))),
    'SCOPE drei ausdrückliche Anmeldungen, keine Schleife');
}
marker('CENTRAL_UI_R6F_PURCHASE_SCOPE_PROVED');

// ══ §2 — Rückgabe: Primary == PC2 ═══════════════════════════════════════════
{
  const wP = rueckgabeWelt({ bezahlt: 1500 });
  ok(s(wP.db, 'SELECT status FROM purchases WHERE id = ?', [wP.pid]) === 'PARTIALLY_PAID' && n(wP.db, 'SELECT remaining_amount FROM purchases WHERE id = ?', [wP.pid]) === 300,
    'SETUP der Einkauf ist teilbezahlt: 1800, bezahlt 1500, offen 300');
  const lcP = lc(wP.db);
  nimm(wP.db);
  const p = await primary(() => purchaseHouse.returnToSupplierOnPrimary(rueckAnfrage(wP), rev(wP.db, wP.pid)));
  const bildP = kaufBild(wP.db, wP.pid);

  const wR = rueckgabeWelt({ bezahlt: 1500 });
  const logVor = changelog(wR.db);
  const r = await fern(() => cmds.runPurchaseReturn(deps(wR.db), identity('201', OP_RET), rueckRumpf(wR)));
  const bildR = kaufBild(wR.db, wR.pid);
  ok(p.ok && r.ok, `PARITY beide Wege geben zurück (${p.code || 'ok'} / ${r.code || 'ok'})`);
  const diff = bildDiff(bildP, bildR);
  ok(diff.length === 0, `PARITY lokal == fern: Einkauf, Retoure, Zeilen, Lose, Stück, Guthaben, Buchungen je Quelle, Salden (${diff.join(' · ') || 'gleich'})`);
  const e = row(wR.db, 'SELECT total_amount, paid_amount, remaining_amount, status FROM purchases WHERE id = ?', [wR.pid]);
  ok(Number(e.total_amount) === 500 && Number(e.paid_amount) === 500 && Number(e.remaining_amount) === 0 && e.status === 'PAID',
    `PAYABLE erst der offene Rest (300), der Überschuss (1000) ist Erstattung: 500 / bezahlt 500 / offen 0 / PAID (${S(e)})`);
  ok(bildR.retouren === S([[String(r.value.returnNumber), 'COMPLETED', 1300, 'bank', 1000, 'defekt', 'sup-1']]),
    `RETURN eine Retoure, COMPLETED, 1300, Erstattung 1000 per Bank, Notiz getrimmt (${bildR.retouren})`);
  ok(bildR.retourZeilen === S([['p1', 1, 500, 500], ['p2', 1, 800, 800]]), `RETURN die Zeilen tragen den Artikel der Einkaufszeile (${bildR.retourZeilen})`);
  ok(bildR.lose === S([['p1', 2, 1, 'ACTIVE'], ['p2', 1, 0, 'EXHAUSTED']]), `STOCK Los A 2→1, Los B 1→0 (${bildR.lose})`);
  ok(bildR.stueck === S([['p1', 1, 'in_stock'], ['p2', 0, 'returned'], ['p3', 0, 'in_stock']]), `STOCK p1 bleibt mit 1 auf Lager, p2 ist 'returned' (${bildR.stueck})`);
  const pr = all(wR.db, `SELECT account, direction, ROUND(amount, 3) FROM ledger_entries WHERE source_module = 'PURCHASE_RETURN' ORDER BY account`);
  ok(pr === S([['ACCOUNTS_PAYABLE', 'DEBIT', 300], ['BANK', 'DEBIT', 1000], ['INVENTORY', 'CREDIT', 1254.545], ['VAT_INPUT', 'CREDIT', 45.455]]),
    `LEDGER INVENTORY netto + Vorsteuer anteilig, AP um den offenen Rest, BANK um die Erstattung (${pr})`);
  ok(balanced(wP.db) && balanced(wR.db) && lc(wP.db) > lcP, 'LEDGER jede Buchung gleicht sich aus (Primary und PC2)');
  ok(s(wP.db, 'SELECT created_by FROM purchase_returns') === 'user-test' && s(wR.db, 'SELECT created_by FROM purchase_returns') === 'user-pc2',
    'ACTOR die Retoure gehört lokal der Anmeldung am Primary, fern dem Absender (gewollt verschieden)');
  const aP = s(wP.db, "SELECT changed_by FROM audit_log WHERE entity_type = 'purchase_returns' AND action_type = 'STATUS_CHANGE'");
  const aR = s(wR.db, "SELECT changed_by FROM audit_log WHERE entity_type = 'purchase_returns' AND action_type = 'STATUS_CHANGE'");
  ok(aP === 'user-test' && aR === 'user-pc2', `AUDIT das atomare Protokoll nennt den, der zurückgegeben hat (${aP} / ${aR})`);
  ok(r.value.status === 'COMPLETED' && Number(r.value.refundAmount) === 1000 && Number(r.value.totalAmount) === 1300 && r.value.purchaseStatus === 'PAID'
    && Number(r.value.remainingAmount) === 0 && Number(r.value.revision) === rev(wR.db, wR.pid) && /^PRET/.test(String(r.value.returnNumber))
    && r.value.supplierCreditId === null && r.value.refundMethod === 'bank',
  `RESULT Status, Summe, Erstattung, Einkaufsstatus, Rest, neue Fassung (${S(r.value)})`);
  const tabellen = all(wR.db, 'SELECT DISTINCT table_name FROM sync_changelog WHERE id > ? ORDER BY table_name', [logVor]);
  ok(['purchase_returns', 'purchase_return_lines', 'purchases', 'stock_lots', 'products'].every((t) => tabellen.includes(`"${t}"`)),
    `SYNC Retoure, Zeilen, Einkauf, Lose und Artikel gehen in den Abgleich (${tabellen})`);
}
marker('CENTRAL_UI_R6F_PURCHASE_RETURN_PARITY_PROVED');

// ══ §3 — Rückgabe: Varianten ════════════════════════════════════════════════
{
  // (a) Erstattung als Lieferanten-Guthaben: Retoure CONFIRMED, offenes Guthaben, SUPPLIER_CREDIT.
  const wC = rueckgabeWelt({ bezahlt: 1500 });
  const rc = await fern(() => cmds.runPurchaseReturn(deps(wC.db), identity('301', OP_RET), rueckRumpf(wC, { refundMethod: 'credit' })));
  const gut = row(wC.db, 'SELECT supplier_id, amount, used_amount, status, source_purchase_id, created_by FROM supplier_credits WHERE source_return_id IS NOT NULL');
  ok(rc.ok && rc.value.status === 'CONFIRMED' && Number(gut.amount) === 1000 && gut.status === 'OPEN' && gut.source_purchase_id === wC.pid
    && gut.created_by === 'user-pc2' && rc.value.supplierCreditId !== null,
  `CREDIT Retoure CONFIRMED, Guthaben 1000 OPEN beim Lieferanten, Urheber der Absender (${S(gut)})`);
  ok(saldo(wC.db, 'SUPPLIER_CREDIT') === 1000 && saldo(wC.db, 'BANK') === 0 && balanced(wC.db), 'CREDIT die Erstattung steht auf SUPPLIER_CREDIT, nicht auf der Bank');
  const wC2 = rueckgabeWelt({ bezahlt: 1500 });
  nimm(wC2.db);
  const pc = await primary(() => purchaseHouse.returnToSupplierOnPrimary(rueckAnfrage(wC2, { refundMethod: 'credit' }), rev(wC2.db, wC2.pid)));
  ok(pc.ok && bildDiff(kaufBild(wC.db, wC.pid), kaufBild(wC2.db, wC2.pid)).length === 0, 'CREDIT lokal == fern');

  // (b) Benefit: BEFUND — vorher auf BANK gebucht, obwohl das Geld auf Benefit zurückkam.
  const wB = rueckgabeWelt({ bezahlt: 1500 });
  const rb = await fern(() => cmds.runPurchaseReturn(deps(wB.db), identity('302', OP_RET), rueckRumpf(wB, { refundMethod: 'benefit' })));
  ok(rb.ok && saldo(wB.db, 'BENEFIT') === 1000 && saldo(wB.db, 'BANK') === 0,
    `BEFUND behoben: eine Benefit-Erstattung bucht auf BENEFIT (vorher BANK) (${saldo(wB.db, 'BENEFIT')} / ${saldo(wB.db, 'BANK')})`);

  // (c) Mit Guthaben beglichener Einkauf: BEFUND — der Status fiel auf UNPAID, obwohl Rest 0.
  const wG = rueckgabeWelt({ guthaben: 2000 });
  ok(s(wG.db, 'SELECT status FROM purchases WHERE id = ?', [wG.pid]) === 'PAID' && n(wG.db, 'SELECT paid_amount FROM purchases WHERE id = ?', [wG.pid]) === 0,
    'SETUP der Einkauf ist voll mit Lieferanten-Guthaben beglichen (bar 0)');
  const rg = await fern(() => cmds.runPurchaseReturn(deps(wG.db), identity('303', OP_RET), rueckRumpf(wG, {
    refundMethod: 'cash', lines: [{ purchaseLineId: wG.lB, quantity: 1, unitPrice: 800 }],
  })));
  const eg = row(wG.db, 'SELECT total_amount, remaining_amount, status FROM purchases WHERE id = ?', [wG.pid]);
  ok(rg.ok && eg.status === 'PAID' && Number(eg.remaining_amount) === 0 && Number(eg.total_amount) === 1000,
    `BEFUND behoben: nach der Rückgabe bleibt der beglichene Einkauf PAID (vorher UNPAID bei Rest 0) (${S(eg)})`);

  // (d) Unbezahlt, Teilrückgabe: nur die Verbindlichkeit sinkt, keine Erstattung.
  const wU = rueckgabeWelt();
  const ru = await fern(() => cmds.runPurchaseReturn(deps(wU.db), identity('304', OP_RET), rueckRumpf(wU, { lines: [{ purchaseLineId: wU.lA, quantity: 1, unitPrice: 500 }] })));
  const eu = row(wU.db, 'SELECT total_amount, paid_amount, remaining_amount, status FROM purchases WHERE id = ?', [wU.pid]);
  ok(ru.ok && ru.value.status === 'COMPLETED' && Number(ru.value.refundAmount) === 0 && Number(eu.total_amount) === 1300
    && Number(eu.remaining_amount) === 1300 && eu.status === 'UNPAID' && saldo(wU.db, 'CASH') === 0 && saldo(wU.db, 'BANK') === 0,
  `PARTIAL Teilrückgabe 1 von 2: Summe und offener Rest 1300, keine Erstattung (${S(eu)})`);
  ok(all(wU.db, 'SELECT qty_remaining, status FROM stock_lots WHERE purchase_id = ? ORDER BY product_id', [wU.pid]) === S([[1, 'ACTIVE'], [1, 'ACTIVE']]),
    'PARTIAL das Los der Zeile A trägt noch 1');
}
marker('CENTRAL_UI_R6F_PURCHASE_RETURN_VARIANTS_PROVED');

// ══ §4 — Rückgabe: Regeln (auf beiden Wegen dasselbe Nein, nichts geschrieben) ════
{
  const beide = async (w: Welt, over: Record<string, unknown>, x: string): Promise<[Ausgang, Ausgang, boolean]> => {
    const vor = zaehler(w.db);
    nimm(w.db);
    const p = await primary(() => purchaseHouse.returnToSupplierOnPrimary(rueckAnfrage(w, over), rev(w.db, w.pid)));
    const r = await fern(() => cmds.runPurchaseReturn(deps(w.db), identity(x, OP_RET), rueckRumpf(w, over)));
    return [p, r, zaehler(w.db).replace(/"log":\d+/, '') === vor.replace(/"log":\d+/, '')];
  };
  // Verkauftes geht nicht an den Lieferanten zurück — BEFUND: vorher still gekappt.
  const wS = rueckgabeWelt({ bezahlt: 1500 });
  wS.db.run("UPDATE stock_lots SET qty_remaining = 0, status = 'EXHAUSTED' WHERE purchase_line_id = ?", [wS.lB]);
  const [pS, rS, nS] = await beide(wS, {}, '401');
  ok(pS.code === 'PURCHASE_RETURN_STOCK_UNAVAILABLE' && rS.code === 'PURCHASE_RETURN_STOCK_UNAVAILABLE' && rS.frozen && nS,
    `STOCK eine schon verkaufte Ware: PURCHASE_RETURN_STOCK_UNAVAILABLE auf beiden Wegen, nichts geschrieben (${pS.code} / ${rS.code})`);
  const w = rueckgabeWelt({ bezahlt: 1500 });
  const fremdeZeile = zeilen(w.db, kauf([{ productId: 'p3', quantity: 1, unitPrice: 100 }]))[0];
  reload();
  const faelle: Array<[string, Record<string, unknown>, string]> = [
    ['mehr als die Zeile', { lines: [{ purchaseLineId: w.lA, quantity: 3, unitPrice: 500 }] }, 'PURCHASE_RETURN_QTY_INVALID'],
    ['Menge 0', { lines: [{ purchaseLineId: w.lA, quantity: 0, unitPrice: 500 }] }, 'PURCHASE_RETURN_QTY_INVALID'],
    ['negativer Preis', { lines: [{ purchaseLineId: w.lA, quantity: 1, unitPrice: -1 }] }, 'PURCHASE_RETURN_PRICE_INVALID'],
    ['fremde Zeile', { lines: [{ purchaseLineId: fremdeZeile, quantity: 1, unitPrice: 100 }] }, 'PURCHASE_RETURN_LINE_UNKNOWN'],
    ['doppelte Zeile', { lines: [{ purchaseLineId: w.lA, quantity: 1, unitPrice: 500 }, { purchaseLineId: w.lA, quantity: 1, unitPrice: 500 }] }, 'PURCHASE_RETURN_LINE_DUPLICATE'],
    ['Summe 0', { lines: [{ purchaseLineId: w.lA, quantity: 1, unitPrice: 0 }] }, 'PURCHASE_RETURN_TOTAL_INVALID'],
    ['mehr als der Einkauf', { lines: [{ purchaseLineId: w.lA, quantity: 1, unitPrice: 5000 }] }, 'PURCHASE_RETURN_EXCEEDS_PURCHASE'],
  ];
  let i = 410;
  for (const [was, over, code] of faelle) {
    const [p, r, nichts] = await beide(w, over, String(++i));
    ok(p.code === code && r.code === code && r.frozen && nichts, `RULE ${was}: ${code} auf beiden Wegen, nichts geschrieben (${p.code} / ${r.code})`);
  }
  // Der Rumpf ohne Zeilen und mit einem unbekannten Erstattungsweg — dieselben Codes schon beim Prüfen.
  ok(wirft(() => cmds.parsePurchaseReturn(rueckRumpf(w, { lines: [] }))) === 'PURCHASE_RETURN_NO_LINES'
    && wirft(() => cmds.parsePurchaseReturn(rueckRumpf(w, { refundMethod: 'gold' }))) === 'PURCHASE_RETURN_METHOD_INVALID'
    && wirft(() => imHaus(() => life.returnToSupplierInHouse(rueckAnfrage(w, { refundMethod: 'gold' }), CTX))) === 'PURCHASE_RETURN_METHOD_INVALID'
    && wirft(() => imHaus(() => life.returnToSupplierInHouse(rueckAnfrage(w, { lines: [] }), CTX))) === 'PURCHASE_RETURN_NO_LINES',
  'RULE ohne Zeile / unbekannter Erstattungsweg: dieselben Codes im Rumpf und im Haus');
  // Schon eine wirksame Retoure: die Maske bietet „Return to Supplier" dann nicht mehr an.
  const erste = await fern(() => cmds.runPurchaseReturn(deps(w.db), identity('430', OP_RET), rueckRumpf(w, { lines: [{ purchaseLineId: w.lA, quantity: 1, unitPrice: 100 }] })));
  const [p2, r2, n2] = await beide(w, { lines: [{ purchaseLineId: w.lA, quantity: 1, unitPrice: 100 }] }, '431');
  ok(erste.ok && p2.code === 'PURCHASE_RETURN_EXISTS' && r2.code === 'PURCHASE_RETURN_EXISTS' && n2,
    `RULE eine zweite Retoure: PURCHASE_RETURN_EXISTS (${p2.code} / ${r2.code})`);
  // Ein Nein verbrennt keine Belegnummer: nach neun Abweisungen trägt die erste echte Retoure die Nummer 1.
  ok(/0{5}1$/.test(String(erste.value.returnNumber)),
    `RULE Abweisungen stehen vor der Nummernvergabe — die erste Retoure ist Nr. 1 (${String(erste.value.returnNumber)})`);
  // Storniert: keine Rückgabe.
  const wX = rueckgabeWelt();
  await fern(() => cmds.runPurchaseCancel(deps(wX.db), identity('432', OP_CANCEL), { purchaseId: wX.pid, expectedRevision: rev(wX.db, wX.pid) }));
  const [pX, rX, nX] = await beide(wX, {}, '433');
  ok(pX.code === 'PURCHASE_CANCELLED' && rX.code === 'PURCHASE_CANCELLED' && nX, `RULE ein stornierter Einkauf: PURCHASE_CANCELLED (${pX.code} / ${rX.code})`);
  // Fremde Filiale.
  insert(w.db, 'purchases', { id: 'pur-x', branch_id: 'branch-other', purchase_number: 'PUR-X', supplier_id: 'sup-x', status: 'UNPAID', total_amount: 100, remaining_amount: 100, purchase_date: '2026-09-01', created_at: NOW, updated_at: NOW });
  const fremd = await fern(() => cmds.runPurchaseReturn(deps(w.db), identity('434', OP_RET), { ...rueckRumpf(w), purchaseId: 'pur-x', expectedRevision: 1 }));
  ok(fremd.code === 'PURCHASE_NOT_FOUND', `AUTH ein Einkauf einer fremden Filiale: PURCHASE_NOT_FOUND (${fremd.code})`);
  const ausweis = await fern(() => cmds.runPurchaseReturn(deps(w.db), identity('435', OP_RET, { branchId: 'branch-other' }), rueckRumpf(w)));
  ok(ausweis.code === 'BRANCH_MISMATCH', `AUTH ein Ausweis einer fremden Filiale schreibt nicht in diese Bücher (${ausweis.code})`);
  // Was der Primary entscheidet, reist nicht im Rumpf — oben und auf Zeilenebene.
  for (const [k, v] of [['status', 'COMPLETED'], ['returnNumber', 'PRET-1'], ['returnDate', '2026-01-01'], ['supplierId', 'sup-2'],
    ['totalAmount', 1], ['refundAmount', 1], ['remainingAmount', 0], ['paidAmount', 0], ['supplierCreditId', 'c'], ['branchId', 'b'],
    ['userId', 'u'], ['createdBy', 'u'], ['created_by', 'u'], ['actor', 'u'], ['revision', 9], ['account', 'CASH'], ['amount', 1],
    ['stockStatus', 'returned'], ['id', 'x']] as Array<[string, unknown]>) {
    ok(/the primary decides/.test(meldung(() => cmds.parsePurchaseReturn({ ...rueckRumpf(w), [k]: v }))), `PAYLOAD rückgabe: ${k} bestimmt der Primary`);
  }
  for (const [k, v] of [['productId', 'p3'], ['lineTotal', 1], ['lotId', 'l'], ['qtyRemaining', 1], ['vatAmount', 1], ['status', 'x']] as Array<[string, unknown]>) {
    ok(/the primary decides/.test(meldung(() => cmds.parsePurchaseReturn(rueckRumpf(w, { lines: [{ purchaseLineId: w.lA, quantity: 1, unitPrice: 1, [k]: v }] })))),
      `PAYLOAD rückgabe-zeile: ${k} bestimmt der Primary`);
  }
  ok(/unknown field/.test(meldung(() => cmds.parsePurchaseReturn({ ...rueckRumpf(w), foo: 1 }))), 'PAYLOAD rückgabe: ein unbekanntes Feld wird abgewiesen');
  ok(/expectedRevision is required/.test(meldung(() => { const { expectedRevision: _x, ...b } = rueckRumpf(w); cmds.parsePurchaseReturn(b); })),
    'PAYLOAD rückgabe: ohne gesehene Fassung kein Auftrag');
  ok(/must be a number/.test(meldung(() => cmds.parsePurchaseReturn(rueckRumpf(w, { lines: [{ purchaseLineId: w.lA, quantity: '1', unitPrice: 1 }] })))),
    'PAYLOAD rückgabe: Menge ist eine Zahl');
}
marker('CENTRAL_UI_R6F_PURCHASE_RETURN_RULES_PROVED');

// ══ §5 — Rückgabe: verlorene Antwort, alte Fassung ═══════════════════════════
{
  const w = rueckgabeWelt({ bezahlt: 1500 });
  const rumpf = rueckRumpf(w);
  const a = await fern(() => cmds.runPurchaseReturn(deps(w.db), identity('501', OP_RET), rumpf));
  const nachA = zaehler(w.db);
  const b = await fern(() => cmds.runPurchaseReturn(deps(w.db), identity('501', OP_RET), rumpf));
  ok(a.ok && b.ok && b.replayed && S(b.value.returnId) === S(a.value.returnId) && zaehler(w.db) === nachA,
    'LOST dieselbe Kennung: die eingefrorene Antwort, genau eine Retoure, eine Buchung, ein Protokoll');
  const w2 = rueckgabeWelt({ bezahlt: 1500 });
  const vor = zaehler(w2.db);
  const stale = await fern(() => cmds.runPurchaseReturn(deps(w2.db), identity('502', OP_RET), { ...rueckRumpf(w2), expectedRevision: rev(w2.db, w2.pid) + 1 }));
  nimm(w2.db);
  const staleP = await primary(() => purchaseHouse.returnToSupplierOnPrimary(rueckAnfrage(w2), rev(w2.db, w2.pid) + 1));
  ok(stale.code === 'RECORD_CHANGED' && stale.frozen && staleP.code === 'RECORD_CHANGED' && zaehler(w2.db).replace(/"log":\d+/, '') === vor.replace(/"log":\d+/, ''),
    `STALE eine andere Fassung als die gesehene: RECORD_CHANGED auf beiden Wegen, nichts geschrieben (${stale.code} / ${staleP.code})`);
}
marker('CENTRAL_UI_R6F_PURCHASE_RETURN_REPLAY_PROVED');

// ══ §6 — Rückgabe: Fehlerinjektion ═══════════════════════════════════════════
{
  // (a) Die Buchung scheitert — vorher `safePost`: die Retoure stand, das Hauptbuch nicht.
  for (const weg of ['primary', 'fern'] as const) {
    const w = rueckgabeWelt({ bezahlt: 1500 });
    const vor = zaehler(w.db);
    const x = '61' + (weg === 'primary' ? '1' : '2');
    const { db: bad } = faulty(w.db, /INSERT INTO ledger_entries/);
    nimm(bad);
    let aus: Ausgang;
    try {
      aus = weg === 'primary'
        ? await primary(() => purchaseHouse.returnToSupplierOnPrimary(rueckAnfrage(w), rev(w.db, w.pid)))
        : await fern(() => cmds.runPurchaseReturn(deps(bad), identity(x, OP_RET), rueckRumpf(w)));
    } finally { nimm(w.db); }
    ok(!aus.ok && zaehler(w.db) === vor, `ATOMIC ${weg} Buchung scheitert: keine Retoure, Lose, Einkauf, Nummer, Abgleich unverändert (${aus.code.slice(0, 50)})`);
    if (weg === 'fern') ok(lookupCommand(w.db as never, identity(x, OP_RET)).kind === 'fresh', 'ATOMIC fern: die Kennung bleibt frei');
    const heil = weg === 'primary'
      ? await primary(() => purchaseHouse.returnToSupplierOnPrimary(rueckAnfrage(w), rev(w.db, w.pid)))
      : await fern(() => cmds.runPurchaseReturn(deps(w.db), identity(x, OP_RET), rueckRumpf(w)));
    ok(heil.ok && n(w.db, 'SELECT COUNT(*) FROM purchase_returns') === 1, `ATOMIC ${weg}: danach gelingt es genau einmal (${heil.code || 'ok'})`);
  }
  // (b) Das atomare Protokoll scheitert — der letzte Schritt vor Buchung und Overpay.
  for (const weg of ['primary', 'fern'] as const) {
    const w = rueckgabeWelt({ bezahlt: 1500 });
    const vor = zaehler(w.db);
    w.db.run("CREATE TRIGGER r6f_bruch BEFORE INSERT ON audit_log WHEN NEW.entity_type = 'purchase_returns' AND NEW.action_type = 'STATUS_CHANGE' BEGIN SELECT RAISE(ABORT, 'R6F: injected'); END");
    nimm(w.db);
    let aus: Ausgang;
    try {
      aus = weg === 'primary'
        ? await primary(() => purchaseHouse.returnToSupplierOnPrimary(rueckAnfrage(w), rev(w.db, w.pid)))
        : await fern(() => cmds.runPurchaseReturn(deps(w.db), identity('62' + (weg === 'primary' ? '1' : '2'), OP_RET), rueckRumpf(w)));
    } finally { w.db.run('DROP TRIGGER IF EXISTS r6f_bruch'); }
    ok(!aus.ok && zaehler(w.db).replace(/"a":\d+/, '') === vor.replace(/"a":\d+/, ''),
      `ATOMIC ${weg} Protokoll scheitert: nichts bleibt halb stehen (${aus.code.slice(0, 50)})`);
  }
  // (c) Das Lieferanten-Guthaben kann nicht angelegt werden (Erstattung als Guthaben).
  for (const weg of ['primary', 'fern'] as const) {
    const w = rueckgabeWelt({ bezahlt: 1500 });
    const vor = zaehler(w.db);
    const { db: bad } = faulty(w.db, /INSERT INTO supplier_credits/);
    nimm(bad);
    let aus: Ausgang;
    try {
      aus = weg === 'primary'
        ? await primary(() => purchaseHouse.returnToSupplierOnPrimary(rueckAnfrage(w, { refundMethod: 'credit' }), rev(w.db, w.pid)))
        : await fern(() => cmds.runPurchaseReturn(deps(bad), identity('63' + (weg === 'primary' ? '1' : '2'), OP_RET), rueckRumpf(w, { refundMethod: 'credit' })));
    } finally { nimm(w.db); }
    ok(!aus.ok && zaehler(w.db) === vor, `ATOMIC ${weg} Guthaben scheitert: Retoure, Lose, Einkauf unverändert (${aus.code.slice(0, 50)})`);
  }
  const h = codeOf(src('src/core/purchases/purchase-lifecycle-house.ts'));
  ok(!/beginLedgerTransaction|commitLedgerTransaction|rollbackLedgerTransaction|saveDatabaseDurably|saveDatabase\(|safePost|'BEGIN'|'ROLLBACK'|'branch-main'/.test(h),
    'ATOMIC die Hausfolge öffnet, schließt, speichert und rollt nie selbst zurück; keine verschluckte Buchung, keine stille Filiale');
  ok(!/stores\/purchaseStore/.test(h), 'ATOMIC die Hausfolge importiert den Store nicht (der Store ruft sie)');
}
marker('CENTRAL_UI_R6F_PURCHASE_RETURN_ATOMIC_PROVED');
marker('CENTRAL_UI_R6F_PURCHASE_RETURN_PROVED');

// ════════════════════════════════════════════════════════════════════════════
// Storno — die Welt: Auftrag ord-1 (Zeile ol-1), Einkauf bei sup-1: Zeile A p1 1 × 1000 für ol-1,
// Zeile B p2 2 × 500. Bar 300 bezahlt, 200 aus einem Lieferanten-Guthaben (500) eingelöst.
// ════════════════════════════════════════════════════════════════════════════
interface StornoWelt { db: Db; pid: string; creditId: string }
function stornoWelt(): StornoWelt {
  const db = freshDb();
  insert(db, 'orders', { id: 'ord-1', branch_id: 'branch-main', order_number: 'ORD-1', customer_id: 'cust-1', requested_brand: 'Rolex', requested_model: 'Sub', status: 'pending', created_at: NOW, updated_at: NOW });
  insert(db, 'order_lines', { id: 'ol-1', order_id: 'ord-1', description: 'Sub', quantity: 1, unit_price: 1500, line_total: 1500, position: 1, status: 'PENDING', created_at: NOW });
  const pid = kauf([{ productId: 'p1', quantity: 1, unitPrice: 1000, sourceOrderLineId: 'ol-1' }, { productId: 'p2', quantity: 2, unitPrice: 500 }], { sourceOrderId: 'ord-1' });
  usePurchaseStore.getState().addPayment(pid, 300, 'cash');
  const creditId = imHaus(() => payables.grantStandaloneCreditInHouse('sup-1', 500, 'cash', 'Vorauszahlung', CTX));
  imHaus(() => payables.applyCreditToPurchaseInHouse(pid, 200, CTX));
  reload();
  return { db, pid, creditId };
}
const stornoRumpf = (w: { db: Db; pid: string }) => ({ purchaseId: w.pid, expectedRevision: rev(w.db, w.pid) });

// ══ §7 — Storno: Primary == PC2 ═════════════════════════════════════════════
{
  const wP = stornoWelt();
  ok(s(wP.db, "SELECT status FROM order_lines WHERE id = 'ol-1'") === 'ARRIVED' && s(wP.db, 'SELECT status FROM purchases WHERE id = ?', [wP.pid]) === 'PARTIALLY_PAID',
    'SETUP die Auftragszeile ist ARRIVED, der Einkauf teilbezahlt (bar + Guthaben)');
  const ordRevVor = n(wP.db, "SELECT revision FROM orders WHERE id = 'ord-1'");
  nimm(wP.db);
  const p = await primary(() => purchaseHouse.cancelPurchaseOnPrimary(wP.pid, rev(wP.db, wP.pid)));
  const bildP = kaufBild(wP.db, wP.pid);
  const wR = stornoWelt();
  const r = await fern(() => cmds.runPurchaseCancel(deps(wR.db), identity('701', OP_CANCEL), stornoRumpf(wR)));
  const bildR = kaufBild(wR.db, wR.pid);
  ok(p.ok && r.ok, `PARITY beide Wege stornieren (${p.code || 'ok'} / ${r.code || 'ok'})`);
  const diff = bildDiff(bildP, bildR);
  ok(diff.length === 0, `PARITY lokal == fern: Einkauf, Lose, Stück, Auftrag, Guthaben, Buchungen je Quelle, Salden (${diff.join(' · ') || 'gleich'})`);
  const e = row(wR.db, 'SELECT status, total_amount, paid_amount FROM purchases WHERE id = ?', [wR.pid]);
  ok(e.status === 'CANCELLED' && Number(e.total_amount) === 2000 && Number(e.paid_amount) === 300 && n(wR.db, 'SELECT COUNT(*) FROM purchase_payments WHERE purchase_id = ?', [wR.pid]) === 2,
    `NO-DELETE der Einkauf bleibt als CANCELLED stehen — Summe, Bezahltes und beide Zahlungen (Historie) (${S(e)})`);
  ok(bildR.lose === S([['p1', 1, 1, 'CANCELLED'], ['p2', 2, 2, 'CANCELLED']]) && bildR.stueck === S([['p1', 0, 'returned'], ['p2', 0, 'returned'], ['p3', 0, 'in_stock']]),
    `STOCK Lose soft-storniert, Artikel ohne Bestand 'returned' (${bildR.lose} · ${bildR.stueck})`);
  ok(s(wR.db, "SELECT status FROM order_lines WHERE id = 'ol-1'") === 'PENDING' && n(wP.db, "SELECT revision FROM orders WHERE id = 'ord-1'") > ordRevVor,
    'ORDER die Auftragszeile ist wieder PENDING (neu beschaffbar), die Fassung des Auftrags ist gestiegen');
  setTestDatabase(wR.db as never);
  ok(posting.hasReversalFor('PURCHASE', wR.pid) && n(wR.db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'PURCHASE_PAYMENT' AND reverses_entry_id IS NOT NULL") === 4,
    'LEDGER die Einkaufsbuchung und BEIDE Zahlungen (bar + Guthaben) sind storniert');
  const g = row(wR.db, 'SELECT used_amount, status FROM supplier_credits WHERE id = ?', [wR.creditId]);
  ok(Number(g.used_amount) === 0 && g.status === 'OPEN' && saldo(wR.db, 'SUPPLIER_CREDIT') === 500,
    `CREDIT das eingelöste Guthaben ist zurück: used 0, OPEN, SUPPLIER_CREDIT 500 (${S(g)})`);
  ok(saldo(wR.db, 'ACCOUNTS_PAYABLE') === 0 && saldo(wR.db, 'INVENTORY') === 0 && saldo(wR.db, 'CASH') === -500,
    `LEDGER AP und Lager auf 0; Kasse nur noch die Vorauszahlung (${saldo(wR.db, 'ACCOUNTS_PAYABLE')} / ${saldo(wR.db, 'INVENTORY')} / ${saldo(wR.db, 'CASH')})`);
  ok(balanced(wP.db) && balanced(wR.db), 'LEDGER jede Buchung gleicht sich aus');
  const auditQ = "SELECT changed_by, old_value FROM audit_log WHERE entity_type = 'purchases' AND action_type = 'STATUS_CHANGE' AND new_value LIKE '%CANCELLED%'";
  const aP = row(wP.db, auditQ);
  const aR = row(wR.db, auditQ);
  ok(aP.changed_by === 'user-test' && aR.changed_by === 'user-pc2' && String(aR.old_value).includes('PARTIALLY_PAID'),
    `AUDIT das atomare Protokoll nennt den, der storniert hat, und den alten Status (${S([aP.changed_by, aR.changed_by, aR.old_value])})`);
  ok(r.value.status === 'CANCELLED' && r.value.previousStatus === 'PARTIALLY_PAID' && Number(r.value.reversedPayments) === 2
    && Number(r.value.restoredSupplierCredits) === 1 && Number(r.value.revertedOrderLines) === 1 && Number(r.value.cancelledLots) === 2
    && Number(r.value.revision) === rev(wR.db, wR.pid) && S(r.value.cancelledReturns) === '[]',
  `RESULT Status, Zahlungen, Guthaben, Auftragszeilen, Lose, neue Fassung (${S(r.value)})`);
}
marker('CENTRAL_UI_R6F_PURCHASE_CANCEL_PARITY_PROVED');

// ══ §8 — Storno mit Retoure: die Retoure geht mit, das Hauptbuch steht wieder auf null ═══
{
  const mitRetoure = async (weg: 'primary' | 'fern') => {
    const w = rueckgabeWelt({ bezahlt: 300 });
    // Teilrückgabe ohne Erstattung (offen 1500 ≥ 1300): der Einkauf bleibt teilbezahlt → „Cancel" wird angeboten.
    const ret = await fern(() => cmds.runPurchaseReturn(deps(w.db), identity(nx(), OP_RET), rueckRumpf(w)));
    const out = weg === 'primary'
      ? (nimm(w.db), await primary(() => purchaseHouse.cancelPurchaseOnPrimary(w.pid, rev(w.db, w.pid))))
      : await fern(() => cmds.runPurchaseCancel(deps(w.db), identity(nx(), OP_CANCEL), stornoRumpf(w)));
    return { w, ret, out };
  };
  const P = await mitRetoure('primary');
  const R = await mitRetoure('fern');
  ok(P.ret.ok && R.ret.ok && P.out.ok && R.out.ok, `CASCADE beide Wege: Retoure, dann Storno (${P.out.code || 'ok'} / ${R.out.code || 'ok'})`);
  ok(bildDiff(kaufBild(P.w.db, P.w.pid), kaufBild(R.w.db, R.w.pid)).length === 0, 'CASCADE lokal == fern');
  ok(s(R.w.db, 'SELECT status FROM purchase_returns') === 'CANCELLED' && n(R.w.db, 'SELECT COUNT(*) FROM purchase_return_lines') === 2,
    'CASCADE die Retoure bleibt mit ihren Zeilen stehen — als CANCELLED (Historie)');
  setTestDatabase(R.w.db as never);
  ok(posting.hasReversalFor('PURCHASE_RETURN', String(R.ret.value.returnId)), 'CASCADE ihre Buchung ist storniert');
  ok(salden(R.w.db) === '[]',
    `BEFUND behoben: nach dem Storno steht JEDES Konto wieder auf 0 — vorher blieb die Retourenbuchung stehen (Lager negativ, AP im Soll) (${salden(R.w.db)})`);
  const e = row(R.w.db, 'SELECT total_amount, paid_amount, status FROM purchases WHERE id = ?', [R.w.pid]);
  ok(Number(e.total_amount) === 1800 && Number(e.paid_amount) === 300 && e.status === 'CANCELLED',
    `CASCADE der Einkauf trägt wieder seine Originalsumme und ist CANCELLED (${S(e)})`);
  ok(all(R.w.db, 'SELECT status FROM stock_lots WHERE purchase_id = ?', [R.w.pid]) === S([['CANCELLED'], ['CANCELLED']]), 'CASCADE alle Lose des Einkaufs storniert');
  ok(S(R.out.value.cancelledReturns) === S([String(R.ret.value.returnNumber)]), `RESULT die Antwort nennt die mitgenommene Retoure (${S(R.out.value.cancelledReturns)})`);
  ok(balanced(P.w.db) && balanced(R.w.db), 'CASCADE jede Buchung gleicht sich aus');

  // Der Altweg (Kommission) storniert auch einen bezahlten Einkauf — mit Retoure samt Erstattung.
  const wL = rueckgabeWelt({ bezahlt: 1500 });
  const retL = await fern(() => cmds.runPurchaseReturn(deps(wL.db), identity(nx(), OP_RET), rueckRumpf(wL, { refundMethod: 'credit' })));
  nimm(wL.db);
  const alt = await primary(() => usePurchaseStore.getState().cancelPurchase(wL.pid));
  ok(retL.ok && alt.ok && s(wL.db, 'SELECT status FROM purchases WHERE id = ?', [wL.pid]) === 'CANCELLED' && salden(wL.db) === '[]'
    && n(wL.db, 'SELECT COUNT(*) FROM supplier_credits') === 0,
  `LEGACY der Store-Anschluss (bezahlt, Retoure als Guthaben): alles auf 0, das ungenutzte Retouren-Guthaben ist weg (bestehender Vertrag) (${salden(wL.db)})`);
  // Das Guthaben der Retoure ist schon eingelöst: kein Storno — auf dem Haus- und dem Altweg.
  const wU = rueckgabeWelt({ bezahlt: 1500 });
  await fern(() => cmds.runPurchaseReturn(deps(wU.db), identity(nx(), OP_RET), rueckRumpf(wU, { refundMethod: 'credit' })));
  const y = kauf([{ productId: 'p3', quantity: 1, unitPrice: 600 }]);
  imHaus(() => payables.applyCreditToPurchaseInHouse(y, 600, CTX));
  const vorU = zaehler(wU.db);
  nimm(wU.db);
  const altU = await primary(() => usePurchaseStore.getState().cancelPurchase(wU.pid));
  const hausU = wirft(() => imHaus(() => life.cancelPurchaseInHouse(wU.pid, 'branch-main')));
  ok(altU.code === 'PURCHASE_RETURN_CREDIT_USED' && hausU === 'PURCHASE_RETURN_CREDIT_USED' && zaehler(wU.db) === vorU,
    `BLOCK das Retouren-Guthaben floss schon in einen anderen Einkauf: PURCHASE_RETURN_CREDIT_USED, nichts geschrieben (${altU.code})`);
}
marker('CENTRAL_UI_R6F_PURCHASE_CANCEL_CASCADE_PROVED');

// ══ §9 — Storno: Regeln, Wiederholung, Fassung, Autorität ════════════════════
{
  const w = stornoWelt();
  const rumpf = stornoRumpf(w);
  const a = await fern(() => cmds.runPurchaseCancel(deps(w.db), identity('901', OP_CANCEL), rumpf));
  const nachA = zaehler(w.db);
  const b = await fern(() => cmds.runPurchaseCancel(deps(w.db), identity('901', OP_CANCEL), rumpf));
  ok(a.ok && b.ok && b.replayed && zaehler(w.db) === nachA, 'LOST dieselbe Kennung: eingefrorene Antwort, exakt eine Wirkung');
  const c = await fern(() => cmds.runPurchaseCancel(deps(w.db), identity('902', OP_CANCEL), stornoRumpf(w)));
  nimm(w.db);
  const cP = await primary(() => purchaseHouse.cancelPurchaseOnPrimary(w.pid, rev(w.db, w.pid)));
  const alt = await primary(() => usePurchaseStore.getState().cancelPurchase(w.pid));
  ok(c.code === 'PURCHASE_ALREADY_CANCELLED' && c.frozen && cP.code === 'PURCHASE_ALREADY_CANCELLED' && alt.ok && zaehler(w.db).replace(/"log":\d+/, '') === nachA.replace(/"log":\d+/, ''),
    `ALREADY eine neue Absicht: eingefrorenes Nein (fern und Maske); der Altweg bleibt ein No-op (${c.code} / ${cP.code})`);
  // Alte Fassung
  const w2 = stornoWelt();
  const vor2 = zaehler(w2.db);
  const stale = await fern(() => cmds.runPurchaseCancel(deps(w2.db), identity('903', OP_CANCEL), { ...stornoRumpf(w2), expectedRevision: rev(w2.db, w2.pid) + 1 }));
  nimm(w2.db);
  const staleP = await primary(() => purchaseHouse.cancelPurchaseOnPrimary(w2.pid, rev(w2.db, w2.pid) + 1));
  ok(stale.code === 'RECORD_CHANGED' && stale.frozen && staleP.code === 'RECORD_CHANGED' && zaehler(w2.db).replace(/"log":\d+/, '') === vor2.replace(/"log":\d+/, ''),
    `STALE eine andere Fassung: RECORD_CHANGED auf beiden Wegen, nichts geschrieben (${stale.code} / ${staleP.code})`);
  // Voll bezahlt: die Maske zeigt keinen „Cancel" — fern und am Primary dasselbe Nein; der Altweg darf.
  const w3 = rueckgabeWelt({ bezahlt: 1800 });
  const vor3 = zaehler(w3.db);
  const paid = await fern(() => cmds.runPurchaseCancel(deps(w3.db), identity('904', OP_CANCEL), stornoRumpf(w3)));
  nimm(w3.db);
  const paidP = await primary(() => purchaseHouse.cancelPurchaseOnPrimary(w3.pid, rev(w3.db, w3.pid)));
  ok(paid.code === 'PURCHASE_PAID_NOT_CANCELLABLE' && paid.frozen && paidP.code === 'PURCHASE_PAID_NOT_CANCELLABLE' && zaehler(w3.db).replace(/"log":\d+/, '') === vor3.replace(/"log":\d+/, ''),
    `RULE voll bezahlt: PURCHASE_PAID_NOT_CANCELLABLE (Regel der Maske) (${paid.code} / ${paidP.code})`);
  const altPaid = await primary(() => usePurchaseStore.getState().cancelPurchase(w3.pid));
  ok(altPaid.ok && s(w3.db, 'SELECT status FROM purchases WHERE id = ?', [w3.pid]) === 'CANCELLED' && salden(w3.db) === '[]',
    'LEGACY der Store-Anschluss (Kommission: Auto-Einkauf) storniert wie bisher auch einen bezahlten Einkauf — vollständiger Rückbau');
  // Eingelöste Overpay-Gutschrift (nur auf dem Altweg erreichbar: überzahlt heißt PAID).
  const w4 = freshDb();
  const x4 = kauf([{ productId: 'p1', quantity: 1, unitPrice: 1000 }]);
  usePurchaseStore.getState().addPayment(x4, 1200, 'cash');
  const y4 = kauf([{ productId: 'p2', quantity: 1, unitPrice: 500 }]);
  imHaus(() => payables.applyCreditToPurchaseInHouse(y4, 200, CTX));
  const vor4 = zaehler(w4);
  const over = await primary(() => usePurchaseStore.getState().cancelPurchase(x4));
  ok(over.code === 'PURCHASE_OVERPAY_CREDIT_REDEEMED' && zaehler(w4) === vor4,
    `BLOCK die Überzahlungs-Gutschrift ist eingelöst: PURCHASE_OVERPAY_CREDIT_REDEEMED vor jedem Schreiben (${over.code})`);
  // Fremde Filiale, fremder Ausweis.
  insert(w4, 'purchases', { id: 'pur-x', branch_id: 'branch-other', purchase_number: 'PUR-X', supplier_id: 'sup-x', status: 'UNPAID', total_amount: 100, remaining_amount: 100, purchase_date: '2026-09-01', created_at: NOW, updated_at: NOW });
  const fremd = await fern(() => cmds.runPurchaseCancel(deps(w4), identity('905', OP_CANCEL), { purchaseId: 'pur-x', expectedRevision: 1 }));
  ok(fremd.code === 'PURCHASE_NOT_FOUND' && s(w4, "SELECT status FROM purchases WHERE id = 'pur-x'") === 'UNPAID',
    `AUTH ein Einkauf einer fremden Filiale: PURCHASE_NOT_FOUND (${fremd.code})`);
  const ausweis = await fern(() => cmds.runPurchaseCancel(deps(w4), identity('906', OP_CANCEL, { branchId: 'branch-other' }), { purchaseId: y4, expectedRevision: rev(w4, y4) }));
  ok(ausweis.code === 'BRANCH_MISMATCH', `AUTH ein Ausweis einer fremden Filiale: BRANCH_MISMATCH (${ausweis.code})`);
  for (const [k, v] of [['status', 'CANCELLED'], ['reason', 'x'], ['purchaseNumber', 'P'], ['totalAmount', 0], ['paidAmount', 0], ['remainingAmount', 0],
    ['payments', []], ['orderLineIds', []], ['lotIds', []], ['supplierCreditIds', []], ['account', 'AP'], ['amount', 1], ['branchId', 'b'],
    ['userId', 'u'], ['createdBy', 'u'], ['actor', 'u'], ['revision', 1], ['id', 'x']] as Array<[string, unknown]>) {
    const m = meldung(() => cmds.parsePurchaseCancel({ ...stornoRumpf({ db: w4, pid: y4 }), [k]: v }));
    ok(/the primary decides|unknown field/.test(m) && (k === 'reason' ? /unknown field/.test(m) : /the primary decides/.test(m)),
      `PAYLOAD storno: ${k} ${k === 'reason' ? 'kennt die Maske nicht' : 'bestimmt der Primary'}`);
  }
  ok(/expectedRevision is required/.test(meldung(() => cmds.parsePurchaseCancel({ purchaseId: y4 }))), 'PAYLOAD storno: ohne gesehene Fassung kein Auftrag');
}
marker('CENTRAL_UI_R6F_PURCHASE_CANCEL_RULES_PROVED');

// ══ §10 — Storno: Fehlerinjektion an den kritischen Stellen ═══════════════════
{
  const stand = (db: Db, pid: string) => S({
    z: zaehler(db), ol: all(db, 'SELECT status FROM order_lines'), o: all(db, 'SELECT status, revision FROM orders'),
    pr: all(db, 'SELECT quantity, stock_status FROM products ORDER BY id'), sc: all(db, 'SELECT used_amount, status FROM supplier_credits ORDER BY id'),
    p: all(db, 'SELECT status FROM purchases WHERE id = ?', [pid]),
  });
  // (a) NACH Los- und Artikelrückbau, beim Zurücksetzen der Auftragszeile.
  for (const weg of ['primary', 'fern'] as const) {
    const w = stornoWelt();
    const vor = stand(w.db, w.pid);
    let imFehler = '';
    const { db: bad } = faulty(w.db, /UPDATE order_lines/, () => true,
      () => { imFehler = all(w.db, 'SELECT status FROM stock_lots WHERE purchase_id = ? ORDER BY product_id', [w.pid]); });
    nimm(bad);
    const x = '1' + (weg === 'primary' ? '01' : '02') + '1';
    let aus: Ausgang;
    try {
      aus = weg === 'primary'
        ? await primary(() => purchaseHouse.cancelPurchaseOnPrimary(w.pid, rev(w.db, w.pid)))
        : await fern(() => cmds.runPurchaseCancel(deps(bad), identity(x, OP_CANCEL), stornoRumpf(w)));
    } finally { nimm(w.db); }
    ok(imFehler === S([['CANCELLED'], ['CANCELLED']]), `ATOMIC ${weg}: im Fehler waren die Lose schon storniert (${imFehler})`);
    ok(!aus.ok && stand(w.db, w.pid) === vor, `ATOMIC ${weg} Auftragszeile scheitert: Einkauf, Lose, Artikel, Auftrag, Guthaben, Buchungen unverändert (${aus.code.slice(0, 50)})`);
    if (weg === 'fern') ok(lookupCommand(w.db as never, identity(x, OP_CANCEL)).kind === 'fresh', 'ATOMIC fern: die Kennung bleibt frei');
  }
  // (b) NACH den Stornobuchungen, beim atomaren Protokoll — unmittelbar vor dem Commit.
  for (const weg of ['primary', 'fern'] as const) {
    const w = stornoWelt();
    const vor = stand(w.db, w.pid);
    let imFehler = -1;
    const { db: bad } = faulty(w.db, /INSERT INTO audit_log/,
      (p) => p[3] === 'purchases' && p[5] === 'STATUS_CHANGE' && String(p[8]).includes('CANCELLED'),
      () => { imFehler = n(w.db, 'SELECT COUNT(*) FROM ledger_entries WHERE reverses_entry_id IS NOT NULL'); });
    nimm(bad);
    const x = '1' + (weg === 'primary' ? '03' : '04') + '1';
    let aus: Ausgang;
    try {
      aus = weg === 'primary'
        ? await primary(() => purchaseHouse.cancelPurchaseOnPrimary(w.pid, rev(w.db, w.pid)))
        : await fern(() => cmds.runPurchaseCancel(deps(bad), identity(x, OP_CANCEL), stornoRumpf(w)));
    } finally { nimm(w.db); }
    ok(imFehler > 0, `ATOMIC ${weg}: im Fehler standen die Stornobuchungen schon (${imFehler})`);
    ok(!aus.ok && stand(w.db, w.pid) === vor, `ATOMIC ${weg} Protokoll scheitert: keine Stornobuchung, kein Guthaben-Restore, nichts bleibt (${aus.code.slice(0, 50)})`);
    const heil = weg === 'primary'
      ? await primary(() => purchaseHouse.cancelPurchaseOnPrimary(w.pid, rev(w.db, w.pid)))
      : await fern(() => cmds.runPurchaseCancel(deps(w.db), identity(x, OP_CANCEL), stornoRumpf(w)));
    ok(heil.ok && s(w.db, 'SELECT status FROM purchases WHERE id = ?', [w.pid]) === 'CANCELLED' && balanced(w.db),
      `ATOMIC ${weg}: danach gelingt es genau einmal (${heil.code || 'ok'})`);
  }
  // (c) Eine Stornobuchung scheitert — vorher `safePost`: der Einkauf war storniert, das Hauptbuch nicht.
  for (const weg of ['primary', 'fern', 'altweg'] as const) {
    const w = stornoWelt();
    const vor = stand(w.db, w.pid);
    const { db: bad } = faulty(w.db, /INSERT INTO ledger_entries/);
    nimm(bad);
    let aus: Ausgang;
    try {
      aus = weg === 'primary'
        ? await primary(() => purchaseHouse.cancelPurchaseOnPrimary(w.pid, rev(w.db, w.pid)))
        : weg === 'fern'
          ? await fern(() => cmds.runPurchaseCancel(deps(bad), identity(nx(), OP_CANCEL), stornoRumpf(w)))
          : await primary(() => usePurchaseStore.getState().cancelPurchase(w.pid));
    } finally { nimm(w.db); }
    ok(!aus.ok && stand(w.db, w.pid) === vor,
      `BEFUND behoben (${weg}): eine scheiternde Stornobuchung nimmt den ganzen Storno zurück — vorher blieb der Einkauf ohne Buchung storniert (${aus.code.slice(0, 50)})`);
  }
  const st = codeOf(src('src/stores/purchaseStore.ts'));
  const body = (name: string): string => { const i = st.indexOf(`  ${name}: (id) => {`); return i < 0 ? '' : st.slice(i, st.indexOf('\n  },', i)); };
  ok(/cancelPurchaseInHouse\(/.test(body('cancelPurchase')) && !/safePost|reverseSource|postPurchaseCancelled/.test(body('cancelPurchase')),
    'DOMAIN der Store-Anschluss `cancelPurchase` ruft die Hausfolge — keine eigene Stornologik mehr');
  ok(/export function cancelPurchaseInHouse\(purchaseId: string, branchId: string, opts: PurchaseCancelOptions = \{\}\): PurchaseCancelled/.test(src('src/core/purchases/purchase-lifecycle-house.ts')),
    'DOMAIN die synchron aufrufbare Hausfunktion für den Kommissions-Storno: cancelPurchaseInHouse(purchaseId, branchId, opts)');
}
marker('CENTRAL_UI_R6F_PURCHASE_CANCEL_ATOMIC_PROVED');

// ══ §11 — Inbox-Foto verwerfen ═══════════════════════════════════════════════
{
  const BILD = '["data:image/jpeg;base64,/9j/AAAA"]';
  const inboxWelt = (): Db => {
    const db = freshDb();
    for (const [id, branch, status] of [['inb-1', 'branch-main', 'pending'], ['inb-2', 'branch-main', 'done'], ['inb-x', 'branch-other', 'pending']]) {
      db.run('INSERT INTO purchase_inbox (id, branch_id, images, note, status, created_at, created_by) VALUES (?,?,?,?,?,?,?)', [id, branch, BILD, 'vom Handy', status, NOW, 'user-mobile']);
    }
    reload();
    return db;
  };
  const inboxZeile = (db: Db, id = 'inb-1') => ohne(row(db, 'SELECT * FROM purchase_inbox WHERE id = ?', [id]));
  const dP = inboxWelt();
  ok(loadPurchaseInboxFor(localReadContext()).purchaseInbox.some((x) => x.id === 'inb-1'), 'READ vorher zeigt die Inbox das Foto (dieselbe Auskunft, die PC2 bekommt)');
  const p = await primary(() => purchaseHouse.dismissPurchaseInboxOnPrimary('inb-1'));
  const dR = inboxWelt();
  const logVor = changelog(dR);
  const r = await fern(() => cmds.runInboxDismiss(deps(dR), identity('1101', OP_INBOX), { inboxId: 'inb-1' }));
  ok(p.ok && r.ok && S(inboxZeile(dP)) === S(inboxZeile(dR)) && inboxZeile(dR).status === 'dismissed',
    `PARITY beide Wege verwerfen — dieselbe Zeile (${S(inboxZeile(dR))})`);
  ok(s(dR, "SELECT images FROM purchase_inbox WHERE id = 'inb-1'") === BILD && n(dR, 'SELECT COUNT(*) FROM media_links') === 0,
    'MEDIA das Foto bleibt in seiner Zeile (Vertrag der Inbox: inline, kein Media-Root, keine Verknüpfung) — nichts wird gelöscht');
  nimm(dR);
  ok(!loadPurchaseInboxFor(localReadContext()).purchaseInbox.some((x) => x.id === 'inb-1'), 'READ danach zeigt kein Leser das verworfene Foto');
  ok(readOps.STORE_READ_OPS.includes('store.purchases.get') && /loadPurchaseInboxFor\(ctx\)/.test(src('src/core/bridge/store-read-commands.ts')),
    'READ keine neue Auskunft — PC2 sieht die Inbox über die vorhandene `store.purchases.get`');
  const aP = s(dP, "SELECT changed_by FROM audit_log WHERE entity_type = 'purchase_inbox' AND action_type = 'STATUS_CHANGE'");
  const aR = s(dR, "SELECT changed_by FROM audit_log WHERE entity_type = 'purchase_inbox' AND action_type = 'STATUS_CHANGE'");
  ok(aP === 'user-test' && aR === 'user-pc2', `AUDIT atomar, mit dem, der verworfen hat (${aP} / ${aR})`);
  ok(n(dR, "SELECT COUNT(*) FROM sync_changelog WHERE table_name = 'purchase_inbox' AND action = 'update' AND id > ?", [logVor]) === 1,
    'SYNC genau eine Änderung (update, kein delete — die Inbox hat im Abgleich keinen Löschweg)');
  ok(r.value.status === 'dismissed' && r.value.inboxId === 'inb-1', `RESULT (${S(r.value)})`);
  // Verlorene Antwort
  const vor = zaehler(dR);
  const again = await fern(() => cmds.runInboxDismiss(deps(dR), identity('1101', OP_INBOX), { inboxId: 'inb-1' }));
  ok(again.ok && again.replayed && zaehler(dR) === vor, 'LOST dieselbe Kennung: eingefrorene Antwort, keine zweite Wirkung');
  // Nicht mehr offen: schon verworfen / schon zu einem Einkauf geworden — BEFUND: vorher blind überschrieben.
  const nochmal = await fern(() => cmds.runInboxDismiss(deps(dR), identity('1102', OP_INBOX), { inboxId: 'inb-1' }));
  const erledigt = await fern(() => cmds.runInboxDismiss(deps(dR), identity('1103', OP_INBOX), { inboxId: 'inb-2' }));
  nimm(dR);
  const erledigtP = await primary(() => purchaseHouse.dismissPurchaseInboxOnPrimary('inb-2'));
  ok(nochmal.code === 'INBOX_NOT_PENDING' && nochmal.frozen && erledigt.code === 'INBOX_NOT_PENDING' && erledigtP.code === 'INBOX_NOT_PENDING'
    && s(dR, "SELECT status FROM purchase_inbox WHERE id = 'inb-2'") === 'done',
  `RULE nur ein offenes Foto wird verworfen — ein erledigtes bleibt 'done' (vorher auf 'dismissed' gekippt) (${nochmal.code} / ${erledigt.code})`);
  const fremd = await fern(() => cmds.runInboxDismiss(deps(dR), identity('1104', OP_INBOX), { inboxId: 'inb-x' }));
  const ausweis = await fern(() => cmds.runInboxDismiss(deps(dR), identity('1105', OP_INBOX, { branchId: 'branch-other' }), { inboxId: 'inb-x' }));
  ok(fremd.code === 'INBOX_NOT_FOUND' && ausweis.code === 'BRANCH_MISMATCH' && s(dR, "SELECT status FROM purchase_inbox WHERE id = 'inb-x'") === 'pending',
    `AUTH ein Foto einer fremden Filiale: INBOX_NOT_FOUND / BRANCH_MISMATCH (${fremd.code} / ${ausweis.code})`);
  for (const [k, v] of [['status', 'dismissed'], ['images', []], ['note', 'x'], ['mediaIds', []], ['stagingIds', []], ['branchId', 'b'],
    ['userId', 'u'], ['createdBy', 'u'], ['id', 'x'], ['revision', 1]] as Array<[string, unknown]>) {
    ok(/the primary decides/.test(meldung(() => cmds.parseInboxDismiss({ inboxId: 'inb-1', [k]: v }))), `PAYLOAD inbox: ${k} bestimmt der Primary`);
  }
  ok(/unknown field/.test(meldung(() => cmds.parseInboxDismiss({ inboxId: 'inb-1', foo: 1 }))) && /inboxId is required/.test(meldung(() => cmds.parseInboxDismiss({}))),
    'PAYLOAD inbox: unbekanntes Feld / fehlende Kennung abgewiesen');
  // Fehlerinjektion: das Protokoll scheitert → das Foto bleibt offen.
  for (const weg of ['primary', 'fern'] as const) {
    const db = inboxWelt();
    const vorI = zaehler(db);
    db.run("CREATE TRIGGER r6f_inbox BEFORE INSERT ON audit_log WHEN NEW.entity_type = 'purchase_inbox' BEGIN SELECT RAISE(ABORT, 'R6F: injected'); END");
    let aus: Ausgang;
    try {
      aus = weg === 'primary'
        ? await primary(() => purchaseHouse.dismissPurchaseInboxOnPrimary('inb-1'))
        : await fern(() => cmds.runInboxDismiss(deps(db), identity('11' + (weg === 'primary' ? '1' : '2') + '0', OP_INBOX), { inboxId: 'inb-1' }));
    } finally { db.run('DROP TRIGGER IF EXISTS r6f_inbox'); }
    ok(!aus.ok && zaehler(db) === vorI && s(db, "SELECT status FROM purchase_inbox WHERE id = 'inb-1'") === 'pending',
      `ATOMIC ${weg} Protokoll scheitert: das Foto bleibt offen, kein Abgleich (${aus.code.slice(0, 50)})`);
  }
  // Der Altanschluss des Stores geht über dieselbe Hausfolge.
  const dL = inboxWelt();
  usePurchaseStore.getState().dismissPurchaseInbox('inb-1');
  ok(s(dL, "SELECT status FROM purchase_inbox WHERE id = 'inb-1'") === 'dismissed' && wirft(() => usePurchaseStore.getState().dismissPurchaseInbox('inb-2')) === 'INBOX_NOT_PENDING',
    'DOMAIN der Store-Anschluss `dismissPurchaseInbox` ruft dieselbe Hausfolge (dieselbe Regel)');
  const h = codeOf(src('src/core/purchases/purchase-lifecycle-house.ts'));
  const dis = h.slice(h.indexOf('export function dismissPurchaseInboxInHouse'));
  ok(!/invoke\(|unlink|rmSync|DELETE FROM|media_links|staging/.test(dis), 'MEDIA das Verwerfen fasst keine Datei und keinen zweiten Bildspeicher an');
}
marker('CENTRAL_UI_R6F_PURCHASE_INBOX_PROVED');

// ══ §12 — Client: keine lokale Datenbank, der Weg geht über den Primary ═══════
{
  const w = rueckgabeWelt({ bezahlt: 1500 });
  const purchase = { id: w.pid, revision: rev(w.db, w.pid) };
  let touched = 0;
  const counting = new Proxy(w.db as object, {
    get(t, k) {
      const v = (t as Record<string | symbol, unknown>)[k];
      if (k === 'run' || k === 'exec' || k === 'prepare') return (...a: unknown[]) => { touched++; return (v as (...x: unknown[]) => unknown).apply(t, a); };
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
  setTestDatabase(counting as never);
  store.set('lataif_runtime_mode', 'client');
  store.set('lataif_client_server_url', 'https://primary.local');
  store.set('lataif_client_token', 'tok');
  const calls: Array<{ body: Record<string, unknown> }> = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ body });
    return new Response(JSON.stringify({ ok: true, value: { replayed: false } }), { status: 200 });
  }) as never;
  try {
    const a = await primary(() => purchaseHouse.returnToSupplierOnPrimary(rueckAnfrage(w), 1));
    const b = await primary(() => purchaseHouse.cancelPurchaseOnPrimary(w.pid, 1));
    const c = await primary(() => purchaseHouse.dismissPurchaseInboxOnPrimary('inb-1'));
    const d = wirft(() => life.cancelPurchaseInHouse(w.pid, 'branch-main'));
    const e = wirft(() => life.dismissPurchaseInboxInHouse('inb-1', 'branch-main'));
    const f = wirft(() => usePurchaseStore.getState().cancelPurchase(w.pid));
    ok(a.code === 'PURCHASE_PRIMARY_ONLY' && b.code === 'PURCHASE_PRIMARY_ONLY' && c.code === 'PURCHASE_PRIMARY_ONLY' && d === 'PURCHASE_PRIMARY_ONLY'
      && e === 'PURCHASE_PRIMARY_ONLY' && f === 'CLIENT_HAS_NO_BOOKS' && touched === 0,
    `CLIENT jeder Primary-Anschluss und der Store-Altweg verweigern, bevor sie eine Datenbank anfassen (${S([a.code, b.code, c.code, d, e, f])}, Zugriffe ${touched})`);
    const write = (op: string) => {
      const ctl = new CommandSaveController<Record<string, unknown>>(op);
      return { remote: true, save: (ad: never) => runSharedWrite(true, ad, ctl.beginAttempt()) } as never;
    };
    const r1 = await purchaseHouse.savePurchaseReturn(write(OP_RET), purchase, {
      refundMethod: 'credit', notes: '  kaputt ', lines: [{ purchaseLineId: w.lA, quantity: 1, unitPrice: 500 }, { purchaseLineId: w.lB, quantity: 0, unitPrice: 800 }],
    });
    const r2 = await purchaseHouse.savePurchaseCancel(write(OP_CANCEL), purchase);
    const r3 = await purchaseHouse.saveInboxDismiss(write(OP_INBOX), 'inb-1');
    const r4 = await purchaseHouse.savePurchaseCancel(write(OP_CANCEL), { id: w.pid });
    const sent = (op: string) => calls.find((x) => x.body.op === op)?.body.payload as Record<string, unknown> | undefined;
    const s1 = sent(OP_RET); const s2 = sent(OP_CANCEL); const s3 = sent(OP_INBOX);
    ok(r1.kind === 'ok' && r2.kind === 'ok' && r3.kind === 'ok' && !!s1 && !!s2 && !!s3 && touched === 0,
      `CLIENT je EIN geprüfter Auftrag — keine lokale Wirkung (Zugriffe ${touched})`);
    ok(S(Object.keys(s1 ?? {}).sort()) === S(['expectedRevision', 'lines', 'notes', 'purchaseId', 'refundMethod'])
      && S(s1?.lines) === S([{ purchaseLineId: w.lA, quantity: 1, unitPrice: 500 }]) && s1?.notes === 'kaputt' && s1?.expectedRevision === purchase.revision,
    `CLIENT Rückgabe: nur die Wahl des Menschen (Zeile/Menge/Preis/Weg/Notiz) + gesehene Fassung; die 0-Zeile reist nicht mit (${S(s1)})`);
    ok(S(s2) === S({ purchaseId: w.pid, expectedRevision: purchase.revision }) && S(s3) === S({ inboxId: 'inb-1' }),
      `CLIENT Storno und Inbox: nur Kennung (+ Fassung) (${S(s2)} · ${S(s3)})`);
    ok(r4.kind === 'business_error' && r4.code === 'REVISION_UNKNOWN' && calls.filter((x) => x.body.op === OP_CANCEL).length === 1,
      'CLIENT ohne geladene Fassung wird gar nicht erst geschickt');
  } finally {
    globalThis.fetch = origFetch;
    store.delete('lataif_runtime_mode');
    store.delete('lataif_client_server_url');
    store.delete('lataif_client_token');
    nimm(w.db);
  }
}
marker('CENTRAL_UI_R6F_PURCHASE_CLIENT_PROVED');

// ══ §13 — Oberfläche: jede Maske ein Anschluss ══════════════════════════════
{
  const pd = codeOf(src('src/pages/purchases/PurchaseDetail.tsx'));
  ok(/savePurchaseReturn\(viaWrites\(w, PURCHASE_LIFECYCLE_OP\.RETURN_TO_SUPPLIER\)/.test(pd) && /savePurchaseCancel\(viaWrites\(w, PURCHASE_LIFECYCLE_OP\.CANCEL\)/.test(pd),
    'UI PurchaseDetail: „Confirm Return" und „Confirm Cancel" je EINE Buchung über die gemeinsame Weiche');
  ok(!/\bcreateReturn\(|\bconfirmReturn\(|\bcancelPurchase\(/.test(pd), 'UI PurchaseDetail: keine direkten Store-Schreibwege mehr');
  ok(!/productId: l\.productId/.test(pd), 'UI PurchaseDetail: der Artikel reist nicht mit (der Primary nimmt den der Einkaufszeile)');
  for (const a of ['data-purchase-return-open', 'data-purchase-return-line', 'data-purchase-return-qty', 'data-purchase-return-price',
    'data-purchase-return-method', 'data-purchase-return-notes', 'data-purchase-return-confirm', 'data-purchase-cancel', 'data-purchase-cancel-confirm']) {
    ok(pd.includes(a), `UI PurchaseDetail trägt ${a}`);
  }
  ok(/disabled=\{w\.busy \|\| returnTotal <= 0\}/.test(pd) && /onClick=\{\(\) => void handleCancelPurchase\(\)\} disabled=\{w\.busy\}/.test(pd),
    'UI PurchaseDetail: Knöpfe während des Laufs gesperrt; das Modal schließt nur bei Erfolg');
  const pl = codeOf(src('src/pages/purchases/PurchaseList.tsx'));
  ok(/useSharedWrite<Record<string, unknown>>\(PURCHASE_LIFECYCLE_OP\.DISMISS_INBOX\)/.test(pl) && /saveInboxDismiss\(verwerfen, inboxId\)/.test(pl)
    && !/dismissPurchaseInbox\(/.test(pl) && /data-purchase-inbox-dismiss/.test(pl) && /disabled=\{verwerfen\.busy\}/.test(pl),
  'UI PurchaseList: „Dismiss" ist EINE Buchung, data-purchase-inbox-dismiss, gesperrt während des Laufs');
  const st = codeOf(src('src/stores/purchaseStore.ts'));
  ok(/createPurchaseReturnDraftInHouse\(/.test(st) && /confirmPurchaseReturnInHouse\(/.test(st) && /cancelPurchaseInHouse\(/.test(st)
    && /dismissPurchaseInboxInHouse\(/.test(st) && /reverseConfirmedPurchaseReturnInHouse\(/.test(st) && !/postEntries|reverseSource|postPurchaseCancelled/.test(st),
  'DOMAIN die Store-Aktionen (Signaturen unverändert) rufen dieselbe Hausfolge — EINE Implementierung, keine Buchungslogik mehr im Store');
  ok((st.match(/await /g) || []).length === 0, 'DOMAIN der Store bleibt ohne `await` (von außen unteilbar)');
  const ph = codeOf(src('src/core/purchases/purchase-house.ts'));
  ok(/runOnPrimary\(\(\) => returnToSupplierInHouse\(/.test(ph) && /runOnPrimary\(\(\) => cancelPurchaseInHouse\(/.test(ph) && /runOnPrimary\(\(\) => dismissPurchaseInboxInHouse\(/.test(ph)
    && /blockPaid: true/.test(ph), 'DOMAIN am Primary je EINE Klammer um die Hausfolge; die Regel der Maske (nicht bezahlt) gilt dort');
  const cm = codeOf(src('src/core/bridge/purchase-lifecycle-commands.ts'));
  ok(/returnToSupplierInHouse\(/.test(cm) && /cancelPurchaseInHouse\(/.test(cm) && /dismissPurchaseInboxInHouse\(/.test(cm) && /blockPaid: true/.test(cm)
    && !/INSERT INTO|UPDATE \w+ SET|DELETE FROM|postEntries|reverseSource/.test(cm),
  'DOMAIN die Fernbefehle rufen dieselbe Folge und schreiben nichts selbst');
}
marker('CENTRAL_UI_R6F_PURCHASE_UI_PROVED');

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central ui parity r6f purchase parity: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
