// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6E — zwei Rücknahmen: „Cancel Return" (`returns.cancel`) und „Undo convert"
// eines Agenten-Transfers (`transfers.undo_convert`) — EINE Hausfolge für Primary und PC2, dazu die
// geteilte Grundlage `reverseInvoiceInHouse` (Rechnung stornieren statt löschen).
// Run: node test/r6e/reversal-parity.test.ts
//
// Gefahren werden die ECHTEN Hausfolgen (`return-cancel-house`, `transfer-house`, `invoice-reversal`),
// die echten Primary-Anschlüsse (`salesReturnStore.cancelReturn`, `undoTransferConversionOnPrimary`
// → `runOnPrimary`), die echten Store-Funktionen, die echte C3A-Maschine mit durablem Nachweis und
// das echte Schema samt Hauptbuch. Gestellt sind nur das Speichern und — im Client-Abschnitt — das Netz.
//
//   §1 Umfang   §2 Storno: Primary == PC2   §3 verlorene Antwort, alte Fassung, schon storniert
//   §4 Sperren + Guthaben   §5 Fehlerinjektion (Storno)   §6 Autorität (Storno)   §7 Auskunft
//   §8 Undo: Stand vor der Umwandlung   §9 Sammelrechnung + mehrere Zyklen   §10 Undo: Wiederholung,
//   Fassung, Sperren, Autorität   §11 Fehlerinjektion (Undo)   §12 Client   §13 Oberfläche
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
(globalThis as { window?: unknown }).window = { localStorage: storage };

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
await import('../../src/core/bridge/read-commands.ts');
await import('../../src/core/bridge/customer-commands.ts');
const fin = await import('../../src/core/bridge/financial-commands.ts');
const life = await import('../../src/core/bridge/lifecycle-commands.ts');
const svc = await import('../../src/core/bridge/service-commands.ts');
const rev = await import('../../src/core/bridge/sales-reversal-commands.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const { applyMediaSchema } = await import('../../src/core/db/media-schema.ts');
const { useInvoiceStore } = await import('../../src/stores/invoiceStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { useCustomerStore } = await import('../../src/stores/customerStore.ts');
const { useAgentStore } = await import('../../src/stores/agentStore.ts');
const { useSalesReturnStore, loadSalesReturnsFor } = await import('../../src/stores/salesReturnStore.ts');
const { useAuthStore } = await import('../../src/stores/authStore.ts');
const { localReadContext } = await import('../../src/core/data/read-context.ts');
const house = await import('../../src/core/agents/transfer-house.ts');
const rules = await import('../../src/core/agents/transfer-rules.ts');
const cancelHouse = await import('../../src/core/returns/return-cancel-house.ts');
const returnHouse = await import('../../src/core/returns/return-house.ts');
const reversal = await import('../../src/core/invoices/invoice-reversal.ts');
const { runSharedWrite } = await import('../../src/core/data/shared-write.ts');
const { CommandSaveController } = await import('../../src/core/bridge/client-command-save.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const marker = (m: string): void => { if (fails.length === 0) console.log(m); };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const codeOf = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const S = (v: unknown): string => JSON.stringify(v);
const NOW = '2026-09-13T10:00:00.000Z';

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
  useProductStore.getState().loadProducts();
  useCustomerStore.getState().loadCustomers();
  useInvoiceStore.getState().loadInvoices();
  useAgentStore.getState().loadAgents();
  useAgentStore.getState().loadTransfers();
  useSalesReturnStore.getState().loadReturns();
}

const PRODUKTE: Array<[string, string, string, string]> = [
  ['p1', 'branch-main', 'in_stock', 'MARGIN'], ['p2', 'branch-main', 'in_stock', 'VAT_10'],
  ['p3', 'branch-main', 'in_stock', 'MARGIN'], ['p-foreign', 'branch-other', 'in_stock', 'MARGIN'],
];

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
  for (const [id, first, branch] of [['cust-1', 'Ali', 'branch-main'], ['cust-2', 'Nora', 'branch-main'], ['cust-x', 'Fremd', 'branch-other']]) {
    db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level,
        preferences, customer_type, sales_stage, created_at, updated_at)
      VALUES (?,?,?,'Hassan','BH','en',0,'[]','collector','active',?,?)`, [id, branch, first, NOW, NOW]);
  }
  applyMediaSchema(db as never);
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  for (const [id, branch, stock, tax] of PRODUKTE) {
    db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
        scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
        tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
      VALUES (?,?,'cat-w','Rolex',?,?,1,'Pre-Owned','[]',100,'BHD',150,?,?,0,'[]','{}','OWN',?,?)`,
    [id, branch, 'M ' + id, 'SKU-' + id, stock, tax, NOW, NOW]);
    db.run(`INSERT INTO stock_lots (id, branch_id, product_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
      VALUES (?,?,?,100,1,1,'ACTIVE',?,?)`, ['lot-' + id, branch, id, NOW, NOW]);
  }
  reload();
  tauriState.reset();
  return db;
}

// Der Mensch am Primary ist der Owner (die Maske zeigt „Cancel Return" nur ihm).
function sitzung(role: string): void {
  useAuthStore.setState({ session: { userId: 'user-test', branchId: 'branch-main', role } as never });
}
sitzung('ADMIN');

const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-000000000000`;
const ACTOR = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role: 'ADMIN' };
const identity = (x: string, op: string, over: Partial<typeof ACTOR> = {}) =>
  ({ commandId: ID(x), ...ACTOR, ...over, op, payloadHash: 'h' + x });
const deps = (db: Db) => ({
  db: db as never,
  begin: posting.beginLedgerTransaction,
  commit: posting.commitLedgerTransaction,
  rollback: posting.rollbackLedgerTransaction,
  durableSave: async () => {},
  now: () => NOW,
});

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
const buchungen = (db: Db): string =>
  all(db, 'SELECT account, direction, ROUND(SUM(amount), 3) FROM ledger_entries GROUP BY account, direction ORDER BY account, direction');
/** Der Saldo je Konto und Gegenpartei — was ein Bericht zeigt. */
const salden = (db: Db): string => all(db,
  `SELECT account, COALESCE(counterparty_id, '') AS cp, ROUND(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 3) AS net
     FROM ledger_entries GROUP BY account, cp HAVING ABS(net) > 0.0005 ORDER BY account, cp`);
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
function faulty(db: Db, pattern: RegExp) {
  const f = { armed: true };
  const proxy = new Proxy(db as object, {
    get(t, k) {
      if (k === 'run') {
        return (sql: string, p?: unknown[]) => {
          if (f.armed && pattern.test(sql)) throw new Error('INJECTED at ' + pattern);
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
// Die Welt einer Retoure: Rechnung über p2 (VAT_10, 1000 + 100 Steuer), eine Retoure IN_STOCK
// über die ganze Zeile, freigegeben (Gutschrift) — bezahlt oder nicht, bar oder als Guthaben.
// ════════════════════════════════════════════════════════════════════════════
interface Retourenwelt { db: Db; invId: string; retId: string; lineId: string }
function imHaus<T>(fn: () => T): T {
  posting.beginLedgerTransaction();
  try { const out = fn(); posting.commitLedgerTransaction(); return out; }
  catch (e) { posting.rollbackLedgerTransaction(); throw e; }
}
function retourenWelt(o: { bezahlt?: number; methode?: 'cash' | 'credit'; erstattet?: boolean } = {}): Retourenwelt {
  const db = freshDb();
  const invId = imHaus(() => {
    const inv = useInvoiceStore.getState().createDirectInvoice('cust-1', [{
      productId: 'p2', unitPrice: 1000, purchasePrice: 100, taxScheme: 'VAT_10', vatRate: 10, vatAmount: 100, lineTotal: 1100,
    }], 'R6E');
    if (o.bezahlt) useInvoiceStore.getState().recordPayment(inv.id, o.bezahlt, 'cash');
    return inv.id;
  });
  const lineId = s(db, 'SELECT id FROM invoice_lines WHERE invoice_id = ?', [invId]);
  const retId = imHaus(() => {
    const rs = useSalesReturnStore.getState();
    rs.loadReturns();
    const id = rs.createReturn({
      invoiceId: invId, refundMethod: o.methode ?? 'cash', productDisposition: 'IN_STOCK', reason: 'defekt',
      lines: [{ invoiceLineId: lineId, productId: 'p2', quantity: 1, unitPrice: 1100, vatAmount: 100 }],
    }).id;
    useSalesReturnStore.getState().loadReturns();
    useSalesReturnStore.getState().approveReturn(id);
    if (o.erstattet) { useSalesReturnStore.getState().loadReturns(); useSalesReturnStore.getState().refundReturn(id); }
    return id;
  });
  reload();
  return { db, invId, retId, lineId };
}
const rrev = (db: Db, id: string): number => n(db, 'SELECT revision FROM sales_returns WHERE id = ?', [id]);
function retourenBild(w: Retourenwelt) {
  return {
    retoure: ohne(row(w.db, 'SELECT * FROM sales_returns WHERE id = ?', [w.retId]), ['invoice_id']),
    rechnung: ohne(row(w.db, 'SELECT * FROM invoices WHERE id = ?', [w.invId])),
    gutschriften: n(w.db, 'SELECT COUNT(*) FROM credit_notes'),
    guthaben: n(w.db, 'SELECT COUNT(*) FROM customer_credits'),
    lose: all(w.db, 'SELECT product_id, qty_remaining, status FROM stock_lots ORDER BY product_id'),
    stueck: all(w.db, "SELECT quantity, stock_status FROM products WHERE id = 'p2'"),
    buchungen: buchungen(w.db),
    salden: salden(w.db),
  };
}
const GRUND = ' Kunde behaelt die Uhr ';
const stornoRumpf = (w: Retourenwelt, reason = GRUND) => ({ returnId: w.retId, expectedRevision: rrev(w.db, w.retId), reason });

// ══ §1 — Umfang ═════════════════════════════════════════════════════════════
{
  for (const op of ['returns.cancel', 'transfers.undo_convert']) {
    ok(registry.ALLOWED_MUTATIONS.includes(op), `SCOPE ${op} ist namentlich freigegeben`);
    ok(registry.knownCommands().includes(op), `SCOPE ${op} ist registriert`);
  }
  ok(S([...rev.SALES_REVERSAL_OPS].sort()) === S(['returns.cancel', 'transfers.undo_convert']), 'SCOPE die Befehlsdatei kennt genau diese zwei');
  ok(perms.OPERATION_PERMISSIONS['returns.cancel']?.kind === 'isOwner' && perms.OPERATION_PERMISSIONS['transfers.undo_convert'] === null,
    'SCOPE Storno nur für den Owner (wie perm.isOwner der Maske), Undo ohne Tor (wie die Transfer-Masken)');
  ok(perms.roleMayRunOp('ADMIN', 'returns.cancel') && !perms.roleMayRunOp('MANAGER', 'returns.cancel') && !perms.roleMayRunOp('SALES', 'returns.cancel')
    && perms.roleMayRunOp('SALES', 'transfers.undo_convert'), 'SCOPE die zentrale Prüfung: nur kanonisch ADMIN storniert eine Retoure');
  const reg = codeOf(src('src/core/bridge/sales-reversal-commands.ts'));
  ok((reg.match(/registerCommand\(/g) || []).length === 2 && !/for \(|forEach/.test(reg.slice(reg.indexOf('registerCommand('))),
    'SCOPE zwei ausdrückliche Anmeldungen, keine Schleife');
}
marker('CENTRAL_UI_R6E_REVERSAL_SCOPE_PROVED');

// ══ §2 — Storno: Primary == PC2 ═════════════════════════════════════════════
{
  const wP = retourenWelt();
  const vorP = retourenBild(wP);
  ok(vorP.rechnung.status === 'RETURNED' && Number(vorP.rechnung.vat_amount) === 0 && vorP.gutschriften === 1,
    `SETUP die freigegebene Retoure hat die unbezahlte Rechnung auf RETURNED gesetzt, Steuer 0, eine Gutschrift (${S([vorP.rechnung.status, vorP.rechnung.vat_amount])})`);
  const lcP = lc(wP.db);
  const p = await primary(() => useSalesReturnStore.getState().cancelReturn(wP.retId, GRUND));
  const bildP = retourenBild(wP);

  const wR = retourenWelt();
  const rechnungImAbgleich = (): number => n(wR.db, "SELECT COUNT(*) FROM sync_changelog WHERE table_name = 'invoices'");
  const abgleichVor = rechnungImAbgleich();
  const r = await fern(() => rev.runReturnCancel(deps(wR.db), identity('201', 'returns.cancel'), stornoRumpf(wR)));
  const bildR = retourenBild(wR);
  ok(p.ok && r.ok, `PARITY beide Wege stornieren (${p.code || 'ok'} / ${r.code || 'ok'})`);
  const diff = [...unterschiede(bildP.retoure, bildR.retoure), ...unterschiede(bildP.rechnung, bildR.rechnung)];
  ok(diff.length === 0 && bildP.buchungen === bildR.buchungen && bildP.salden === bildR.salden && bildP.lose === bildR.lose
    && bildP.stueck === bildR.stueck && bildP.gutschriften === bildR.gutschriften,
  `PARITY lokal == fern: Retoure, Rechnung, Buchungen, Salden, Lose, Stück (${diff.join(' · ') || 'gleich'})`);
  ok(bildR.retoure.status === 'REJECTED' && n(wR.db, 'SELECT COUNT(*) FROM sales_return_lines') === 1,
    'CANCEL die Retoure bleibt als REJECTED stehen — samt Zeile (Historie)');
  // R6E-CN — vorher: `gutschriften === 0` (Zeile gelöscht). Jetzt bleibt sie als CANCELLED stehen.
  ok(bildR.gutschriften === 1 && n(wR.db, "SELECT COUNT(*) FROM credit_notes WHERE status = 'CANCELLED'") === 1
    && n(wR.db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'CREDIT_NOTE' AND reverses_entry_id IS NOT NULL") > 0,
  'CANCEL die Gutschrift ist im Hauptbuch storniert und bleibt als CANCELLED-Zeile stehen (Nummer belegt)');
  ok(n(wR.db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'SALES_RETURN_COGS' AND reverses_entry_id IS NOT NULL") > 0,
    'CANCEL der Wareneinsatz der Retoure ist zurückgedreht');
  ok(Number(bildR.rechnung.vat_amount) === 100, `CANCEL die Steuer der Rechnung ist wieder da (${S(bildR.rechnung.vat_amount)})`);
  ok(bildR.rechnung.status === 'PARTIAL' && bildP.rechnung.status === 'PARTIAL',
    `CANCEL BEFUND behoben: die Rechnung ist wieder PARTIAL — vorher blieb sie RETURNED, obwohl die Forderung zurück war (${S([bildP.rechnung.status, bildR.rechnung.status])})`);
  ok(n(wR.db, `SELECT COUNT(*) FROM invoices WHERE customer_id = 'cust-1' AND status IN ('PARTIAL', 'DRAFT')`) === 1,
    'CANCEL …damit steht sie wieder in den offenen Posten des Kunden');
  const arKunde = n(wR.db, "SELECT ROUND(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END), 3) FROM ledger_entries WHERE account = 'ACCOUNTS_RECEIVABLE' AND counterparty_id = 'cust-1'");
  ok(Math.abs(arKunde - 1100) < 0.005, `LEDGER die Forderung an den Kunden steht wieder bei 1100 (${arKunde})`);
  ok(bildR.lose === S([['p-foreign', 1, 'ACTIVE'], ['p1', 1, 'ACTIVE'], ['p2', 0, 'EXHAUSTED'], ['p3', 1, 'ACTIVE']]),
    `STOCK das Los ist wieder verbraucht wie nach dem Verkauf (${bildR.lose})`);
  ok(balanced(wP.db) && balanced(wR.db), 'LEDGER jede Buchung gleicht sich aus (Primary und PC2)');
  ok(lc(wP.db) > lcP, 'LEDGER es wurde gebucht (Storno-Zeilen)');
  const auditP = row(wP.db, "SELECT changed_by, branch_id, new_value FROM audit_log WHERE entity_type = 'sales_returns' AND field_name = 'cancel'");
  const auditR = row(wR.db, "SELECT changed_by, branch_id, new_value FROM audit_log WHERE entity_type = 'sales_returns' AND field_name = 'cancel'");
  ok(auditP.changed_by === 'user-test' && auditR.changed_by === 'user-pc2' && auditR.branch_id === 'branch-main',
    `AUDIT das Protokoll nennt den, der storniert hat — fern den Absender, nicht die Sitzung am Primary (${S([auditP.changed_by, auditR.changed_by])})`);
  ok(/"reason":"Kunde behaelt die Uhr"/.test(String(auditR.new_value)) && /"invoiceStatus":"PARTIAL"/.test(String(auditR.new_value)),
    'AUDIT Grund (getrimmt) und neuer Rechnungsstatus stehen im atomaren Eintrag');
  ok(rechnungImAbgleich() === abgleichVor + 1, `SYNC die geänderte Rechnung geht jetzt in den Abgleich (vorher nicht) (${abgleichVor} → ${rechnungImAbgleich()})`);
  ok(r.value.status === 'REJECTED' && r.value.invoiceStatus === 'PARTIAL' && Number(r.value.reversedCreditNotes) === 1 && Number(r.value.revision) > 0,
    `RESULT die Antwort nennt Status, Rechnungsstatus, Gutschriften, neue Fassung (${S(r.value)})`);
}
marker('CENTRAL_UI_R6E_RETURN_CANCEL_PARITY_PROVED');

// ══ §3 — verlorene Antwort, alte Fassung, schon storniert ════════════════════
{
  const w = retourenWelt();
  const rumpf = stornoRumpf(w);
  const a = await fern(() => rev.runReturnCancel(deps(w.db), identity('301', 'returns.cancel'), rumpf));
  const nachA = [lc(w.db), n(w.db, "SELECT COUNT(*) FROM audit_log WHERE field_name = 'cancel'"), changelog(w.db)];
  const b = await fern(() => rev.runReturnCancel(deps(w.db), identity('301', 'returns.cancel'), rumpf));
  ok(a.ok && b.ok && b.replayed && S(b.value.revision) === S(a.value.revision),
    'LOST dieselbe Kennung: die eingefrorene Antwort, nicht ein zweiter Lauf');
  ok(S([lc(w.db), n(w.db, "SELECT COUNT(*) FROM audit_log WHERE field_name = 'cancel'"), changelog(w.db)]) === S(nachA),
    'LOST …genau eine Wirkung: Buchungen, Protokoll und Abgleich unverändert');
  // Eine NEUE Absicht auf eine stornierte Retoure: eingefrorenes Nein (fern), No-op (Primary, wie bisher).
  const c = await fern(() => rev.runReturnCancel(deps(w.db), identity('302', 'returns.cancel'), { ...rumpf, expectedRevision: rrev(w.db, w.retId) }));
  ok(!c.ok && c.code === 'RETURN_ALREADY_CANCELLED' && c.frozen, `ALREADY fern: eingefrorenes Nein (${c.code})`);
  const vor = lc(w.db);
  const p = await primary(() => useSalesReturnStore.getState().cancelReturn(w.retId, 'noch einmal'));
  ok(p.ok && lc(w.db) === vor && n(w.db, "SELECT COUNT(*) FROM audit_log WHERE field_name = 'cancel'") === 1,
    'ALREADY Primary: idempotenter No-op wie bisher — nichts gebucht, kein zweites Protokoll');
  // Alte Fassung
  const w2 = retourenWelt();
  const vor2 = S(retourenBild(w2));
  const stale = await fern(() => rev.runReturnCancel(deps(w2.db), identity('303', 'returns.cancel'), { ...stornoRumpf(w2), expectedRevision: rrev(w2.db, w2.retId) + 1 }));
  ok(!stale.ok && stale.code === 'RECORD_CHANGED' && stale.frozen && S(retourenBild(w2)) === vor2,
    `STALE eine andere Fassung als die gesehene: RECORD_CHANGED, nichts geschrieben (${stale.code})`);
}
marker('CENTRAL_UI_R6E_RETURN_CANCEL_REPLAY_PROVED');

// ══ §4 — Sperren und Store-Guthaben ═════════════════════════════════════════
{
  // Ausgezahlt: echtes Geld ist hinaus.
  const wA = retourenWelt({ bezahlt: 1100, methode: 'cash', erstattet: true });
  ok(n(wA.db, 'SELECT refund_paid_amount FROM sales_returns WHERE id = ?', [wA.retId]) > 0, 'SETUP die Retoure ist bar ausgezahlt');
  const vorA = S(retourenBild(wA));
  const pA = await primary(() => useSalesReturnStore.getState().cancelReturn(wA.retId, 'x'));
  const rA = await fern(() => rev.runReturnCancel(deps(wA.db), identity('401', 'returns.cancel'), stornoRumpf(wA)));
  ok(pA.code === 'RETURN_REFUND_PAID_OUT' && rA.code === 'RETURN_REFUND_PAID_OUT' && rA.frozen && S(retourenBild(wA)) === vorA,
    `BLOCK ausgezahlter Refund: auf beiden Wegen dasselbe Nein, nichts geschrieben (${pA.code} / ${rA.code})`);

  // Store-Guthaben (freigegeben, noch unbenutzt): der Storno baut es ab — Zeile und Buchung.
  const wC = retourenWelt({ bezahlt: 1100, methode: 'credit' });
  ok(n(wC.db, "SELECT COUNT(*) FROM customer_credits WHERE source_type = 'sales_return' AND status = 'OPEN'") === 1,
    'SETUP die Gutschrift hat ein offenes Store-Guthaben angelegt');
  const ccVor = n(wC.db, "SELECT ROUND(SUM(CASE WHEN direction='CREDIT' THEN amount ELSE -amount END), 3) FROM ledger_entries WHERE account = 'CUSTOMER_CREDIT'");
  const pC = await primary(() => useSalesReturnStore.getState().cancelReturn(wC.retId, GRUND));
  const wC2 = retourenWelt({ bezahlt: 1100, methode: 'credit' });
  const rC = await fern(() => rev.runReturnCancel(deps(wC2.db), identity('402', 'returns.cancel'), stornoRumpf(wC2)));
  const ccNach = n(wC2.db, "SELECT COALESCE(ROUND(SUM(CASE WHEN direction='CREDIT' THEN amount ELSE -amount END), 3), 0) FROM ledger_entries WHERE account = 'CUSTOMER_CREDIT'");
  // R6E-CN — vorher: COUNT(*) === 0 (Zeile gelöscht). Jetzt: die Zeile bleibt, CANCELLED, nicht einlösbar.
  const ccStorniert = (db: Db): string => all(db, "SELECT status, used_amount FROM customer_credits WHERE source_type = 'sales_return'");
  ok(pC.ok && rC.ok && ccStorniert(wC.db) === S([['CANCELLED', 0]]) && ccStorniert(wC2.db) === S([['CANCELLED', 0]])
    && n(wC2.db, "SELECT COUNT(*) FROM customer_credits WHERE status = 'OPEN'") === 0,
  `CREDIT das unbenutzte Guthaben ist CANCELLED (nicht mehr einlösbar) — auf beiden Wegen (${pC.code || 'ok'} / ${rC.code || 'ok'})`);
  ok(ccVor === 1100 && Math.abs(ccNach) < 0.0005, `CREDIT …und seine Buchung (CUSTOMER_CREDIT ${ccVor} → ${ccNach})`);
  // R6E-CN — vorher: `removedCustomerCredits === 1`; das Ergebnis heißt jetzt, was geschieht.
  ok(Number(rC.value.cancelledCustomerCredits) === 1 && S(retourenBild(wC).salden) === S(retourenBild(wC2).salden),
    'CREDIT lokal == fern: dieselben Salden');

  // Verbraucht: der Wert floss schon auf eine andere Rechnung.
  const wU = retourenWelt({ bezahlt: 1100, methode: 'credit' });
  wU.db.run("UPDATE customer_credits SET used_amount = 10 WHERE source_type = 'sales_return'");
  const vorU = S(retourenBild(wU));
  const pU = await primary(() => useSalesReturnStore.getState().cancelReturn(wU.retId, 'x'));
  const rU = await fern(() => rev.runReturnCancel(deps(wU.db), identity('403', 'returns.cancel'), stornoRumpf(wU)));
  ok(pU.code === 'RETURN_CREDIT_USED' && rU.code === 'RETURN_CREDIT_USED' && S(retourenBild(wU)) === vorU,
    `BLOCK verbrauchtes Guthaben: auf beiden Wegen dasselbe Nein (${pU.code} / ${rU.code})`);

  // Grund ist Pflicht — in der Maske, im Rumpf und in der Hausfolge.
  const wG = retourenWelt();
  const pG = await primary(() => useSalesReturnStore.getState().cancelReturn(wG.retId, '   '));
  ok(pG.code === 'RETURN_REASON_REQUIRED' && wirft(() => rev.parseReturnCancel({ ...stornoRumpf(wG), reason: '  ' })) === 'RETURN_REASON_REQUIRED'
    && wirft(() => rev.parseReturnCancel({ returnId: wG.retId, expectedRevision: 1 })) === 'RETURN_REASON_REQUIRED',
  `REASON ohne Grund kein Storno — Primary und Rumpf mit demselben Code (${pG.code})`);
}
marker('CENTRAL_UI_R6E_RETURN_CANCEL_RULES_PROVED');

// ══ §5 — Fehlerinjektion (Storno) ═══════════════════════════════════════════
{
  // (a) Das atomare Protokoll scheitert — der LETZTE Schritt der Folge.
  for (const weg of ['primary', 'fern'] as const) {
    const w = retourenWelt();
    const vor = S({ bild: retourenBild(w), lc: lc(w.db), log: changelog(w.db) });
    w.db.run("CREATE TRIGGER r6e_bruch BEFORE INSERT ON audit_log WHEN NEW.field_name = 'cancel' BEGIN SELECT RAISE(ABORT, 'R6E: injected'); END");
    const x = '51' + (weg === 'primary' ? '1' : '2');
    let aus: Ausgang;
    try {
      aus = weg === 'primary'
        ? await primary(() => useSalesReturnStore.getState().cancelReturn(w.retId, GRUND))
        : await fern(() => rev.runReturnCancel(deps(w.db), identity(x, 'returns.cancel'), stornoRumpf(w)));
    } finally { w.db.run('DROP TRIGGER IF EXISTS r6e_bruch'); }
    const nach = S({ bild: retourenBild(w), lc: lc(w.db), log: changelog(w.db) });
    ok(!aus.ok && vor === nach, `ATOMIC ${weg} Protokoll scheitert: Retoure, Gutschrift, Rechnung, Lose, Buchungen, Abgleich unverändert (${aus.code.slice(0, 50)})`);
    if (weg === 'fern') ok(lookupCommand(w.db as never, identity(x, 'returns.cancel')).kind === 'fresh', 'ATOMIC fern: die Kennung bleibt frei');
    const heil = weg === 'primary'
      ? await primary(() => useSalesReturnStore.getState().cancelReturn(w.retId, GRUND))
      : await fern(() => rev.runReturnCancel(deps(w.db), identity(x, 'returns.cancel'), stornoRumpf(w)));
    ok(heil.ok && s(w.db, 'SELECT status FROM sales_returns WHERE id = ?', [w.retId]) === 'REJECTED',
      `ATOMIC ${weg}: danach gelingt es (${heil.code || 'ok'})`);
  }
  // (b) Eine Stornobuchung scheitert.
  for (const weg of ['primary', 'fern'] as const) {
    const w = retourenWelt();
    const vor = S({ bild: retourenBild(w), lc: lc(w.db) });
    const { db: bad } = faulty(w.db, /INSERT INTO ledger_entries/);
    setTestDatabase(bad as never);
    let aus: Ausgang;
    try {
      aus = weg === 'primary'
        ? await primary(() => useSalesReturnStore.getState().cancelReturn(w.retId, GRUND))
        : await fern(() => rev.runReturnCancel(deps(bad), identity('52' + (weg === 'primary' ? '1' : '2'), 'returns.cancel'), stornoRumpf(w)));
    } finally { setTestDatabase(w.db as never); }
    ok(!aus.ok && S({ bild: retourenBild(w), lc: lc(w.db) }) === vor, `ATOMIC ${weg} Buchung scheitert: nichts bleibt halb stehen (${aus.code.slice(0, 50)})`);
  }
  const h = codeOf(src('src/core/returns/return-cancel-house.ts'));
  ok(!/beginLedgerTransaction|commitLedgerTransaction|rollbackLedgerTransaction|saveDatabaseDurably|'BEGIN'|'ROLLBACK'/.test(h),
    'ATOMIC die Hausfolge öffnet, schließt und rollt nie selbst zurück (die äußere Klammer entscheidet)');
  const st = codeOf(src('src/stores/salesReturnStore.ts'));
  ok(/runOnPrimary\(/.test(st) && /cancelReturnInHouse\(/.test(st) && !/beginLedgerTransaction|rollbackLedgerTransaction/.test(st),
    'ATOMIC der Store ist nur noch der Anschluss: runOnPrimary + Hausfolge, keine eigene Transaktion');
}
marker('CENTRAL_UI_R6E_RETURN_CANCEL_ATOMICITY_PROVED');

// ══ §6 — Autorität (Storno) ═════════════════════════════════════════════════
{
  const w = retourenWelt();
  const vor = S(retourenBild(w));
  // Die Rolle des Auftraggebers — nicht die der Sitzung am Primary.
  const alsVerkauf = await fern(() => rev.runReturnCancel(deps(w.db), identity('601', 'returns.cancel', { role: 'SALES' }), stornoRumpf(w)));
  ok(!alsVerkauf.ok && alsVerkauf.code === 'RETURN_OWNER_ONLY' && alsVerkauf.frozen,
    `AUTH ein Absender ohne Owner-Rolle: die Hausfolge sagt Nein, auch wenn am Primary der Owner sitzt (${alsVerkauf.code})`);
  ok(wirft(() => imHaus(() => cancelHouse.cancelReturnInHouse(w.retId, 'x', { userId: 'u', role: 'MANAGER' }, 'branch-main'))) === 'RETURN_OWNER_ONLY',
    'AUTH die Hausfolge direkt mit MANAGER: RETURN_OWNER_ONLY');
  sitzung('SALES');
  const pS = await primary(() => useSalesReturnStore.getState().cancelReturn(w.retId, 'x'));
  sitzung('ADMIN');
  ok(pS.code === 'RETURN_OWNER_ONLY', `AUTH am Primary ohne Owner-Sitzung: dasselbe Nein (${pS.code})`);
  // Fremde Filiale: die Retoure einer anderen Filiale gibt es hier nicht.
  insert(w.db, 'invoices', { id: 'inv-x', branch_id: 'branch-other', invoice_number: 'INV-X', customer_id: 'cust-x', status: 'PARTIAL', created_at: NOW, updated_at: NOW });
  insert(w.db, 'sales_returns', { id: 'ret-x', branch_id: 'branch-other', return_number: 'RET-X', invoice_id: 'inv-x', customer_id: 'cust-x', status: 'APPROVED', created_at: NOW });
  const fremd = await fern(() => rev.runReturnCancel(deps(w.db), identity('602', 'returns.cancel'), { returnId: 'ret-x', expectedRevision: rrev(w.db, 'ret-x') || 1, reason: 'x' }));
  ok(fremd.code === 'RETURN_NOT_FOUND', `AUTH eine Retoure einer fremden Filiale: RETURN_NOT_FOUND (${fremd.code})`);
  const ausweis = await fern(() => rev.runReturnCancel(deps(w.db), identity('603', 'returns.cancel', { branchId: 'branch-other' }), stornoRumpf(w)));
  ok(ausweis.code === 'BRANCH_MISMATCH', `AUTH ein Ausweis einer fremden Filiale schreibt nicht in diese Bücher (${ausweis.code})`);
  // Was der Primary entscheidet, reist nicht im Rumpf.
  for (const [k, v] of [['status', 'REJECTED'], ['invoiceId', w.invId], ['refundPaidAmount', 0], ['creditNoteIds', []], ['customerCreditIds', []],
    ['account', 'CASH'], ['debit', 1], ['amount', 1], ['branchId', 'branch-other'], ['userId', 'u'], ['revision', 9], ['role', 'ADMIN'],
    ['cardFeeRestored', 0], ['vatCorrected', 0]] as Array<[string, unknown]>) {
    ok(/the primary decides/.test(meldung(() => rev.parseReturnCancel({ ...stornoRumpf(w), [k]: v }))), `PAYLOAD storno: ${k} bestimmt der Primary`);
  }
  ok(/unknown field/.test(meldung(() => rev.parseReturnCancel({ ...stornoRumpf(w), foo: 1 }))), 'PAYLOAD storno: ein unbekanntes Feld wird abgewiesen');
  ok(/expectedRevision is required/.test(meldung(() => rev.parseReturnCancel({ returnId: w.retId, reason: 'x' }))), 'PAYLOAD storno: ohne gesehene Fassung kein Auftrag');
  ok(S(retourenBild(w)) === vor, 'AUTH …nach all dem: nichts geschrieben');
}
marker('CENTRAL_UI_R6E_RETURN_CANCEL_AUTHORITY_PROVED');

// ══ §7 — Die Auskunft für den Knopf (PC2 sieht, was der Primary rechnet) ═════
{
  const w = retourenWelt();
  const aus = loadSalesReturnsFor(localReadContext());
  const c = aus.cancelability[w.retId];
  ok(!!c && c.canCancel && c.blockReason === null && c.needsStockWarning === false,
    `READ die Liste der Retouren trägt je Retoure die Storno-Auskunft (${S(c)})`);
  ok(S(useSalesReturnStore.getState().getReturnCancelability(w.retId)) === S(c), 'READ …dieselbe Antwort, die die Maske am Primary live bekommt');
  const wA = retourenWelt({ bezahlt: 1100, methode: 'cash', erstattet: true });
  const cA = loadSalesReturnsFor(localReadContext()).cancelability[wA.retId];
  ok(!!cA && !cA.canCancel && /already been paid out/.test(String(cA.blockReason)), `READ eine ausgezahlte Retoure: gesperrt, mit Grund (${S(cA?.blockReason)})`);
  await fern(() => rev.runReturnCancel(deps(wA.db), identity('701', 'returns.cancel'), stornoRumpf(wA)));
  const store2 = await import('../../src/core/bridge/store-read-ops.ts');
  ok(store2.STORE_READ_OPS.includes('store.sales_returns.get'), 'READ keine neue Auskunft — die vorhandene `store.sales_returns.get` trägt es');
}
marker('CENTRAL_UI_R6E_RETURN_CANCELABILITY_READ_PROVED');
marker('CENTRAL_UI_R6E_RETURN_CANCEL_PROVED');

// ════════════════════════════════════════════════════════════════════════════
// Undo convert — der Stand VOR der Umwandlung ist das Ziel.
// ════════════════════════════════════════════════════════════════════════════
const trev = (db: Db, id: string): number => n(db, 'SELECT revision FROM agent_transfers WHERE id = ?', [id]);
let seq = 1000;
const nx = (): string => String(++seq);
async function verkaufterTransfer(db: Db, customerId: string, productId: string, preis = 300, verkauf = 440): Promise<string> {
  const out = await fern(() => svc.runTransferCreate(deps(db), identity(nx(), 'transfers.create'), { customerId, productId, agentPrice: preis }));
  if (!out.ok) throw new Error('setup transfer: ' + out.code);
  const tid = String(out.value.transferId);
  const sold = await fern(() => fin.runMarkSold(deps(db), identity(nx(), 'transfers.mark_sold'), { transferId: tid, salePrice: verkauf, expectedRevision: trev(db, tid) }));
  if (!sold.ok) throw new Error('setup sold: ' + sold.code);
  return tid;
}
/** Was eine Umwandlung berühren kann — ohne Fassung und Zeitpunkte des Transfers. */
function transferBild(db: Db, tids: string[]) {
  const pids = tids.map((t) => s(db, 'SELECT product_id FROM agent_transfers WHERE id = ?', [t]));
  const inList = pids.map(() => '?').join(', ');
  return {
    transfers: tids.map((t) => ohne(row(db, 'SELECT * FROM agent_transfers WHERE id = ?', [t]), ['revision'])),
    stuecke: all(db, `SELECT id, quantity, stock_status FROM products WHERE id IN (${inList}) ORDER BY id`, pids),
    lose: all(db, `SELECT product_id, qty_remaining, status FROM stock_lots WHERE product_id IN (${inList}) ORDER BY product_id`, pids),
    salden: salden(db),
  };
}
const gleich = (a: ReturnType<typeof transferBild>, b: ReturnType<typeof transferBild>): string[] => [
  ...a.transfers.flatMap((t, i) => unterschiede(t, b.transfers[i] ?? {})),
  ...(a.stuecke === b.stuecke ? [] : [`stuecke ${a.stuecke} vs ${b.stuecke}`]),
  ...(a.lose === b.lose ? [] : [`lose ${a.lose} vs ${b.lose}`]),
  ...(a.salden === b.salden ? [] : [`salden ${a.salden} vs ${b.salden}`]),
];

// ══ §8 — Undo: exakt der Stand vor der Umwandlung, Primary == PC2 ═══════════
async function undoWelt(weg: 'primary' | 'fern') {
  const db = freshDb();
  const tid = await verkaufterTransfer(db, 'cust-1', 'p2');
  const s0 = transferBild(db, [tid]);
  const conv = weg === 'primary'
    ? await primary(() => house.convertTransferOnPrimary(tid, { customerId: 'cust-2' }))
    : await fern(() => life.runConvertTransfer(deps(db), identity(nx(), 'transfers.convert_to_invoice'),
      rules.transferConvertBody({ id: tid, revision: trev(db, tid) }, { customerId: 'cust-2' })));
  const invId = s(db, 'SELECT invoice_id FROM agent_transfers WHERE id = ?', [tid]);
  const s1 = transferBild(db, [tid]);
  const undoId = nx();
  const rumpf = house.transferUndoBody({ id: tid, revision: trev(db, tid) });
  const undo = weg === 'primary'
    ? await primary(() => house.undoTransferConversionOnPrimary(tid, trev(db, tid)))
    : await fern(() => rev.runTransferUndo(deps(db), identity(undoId, 'transfers.undo_convert'), rumpf));
  return { db, tid, invId, s0, s1, conv, undo, s2: transferBild(db, [tid]), undoId, rumpf };
}
{
  const P = await undoWelt('primary');
  const R = await undoWelt('fern');
  ok(P.conv.ok && R.conv.ok && P.invId !== '' && R.invId !== '', 'SETUP beide Welten haben umgewandelt');
  ok(gleich(P.s0, P.s1).length > 0, 'SETUP die Umwandlung hat den Stand verändert (Los, Buchungen, Verknüpfung)');
  ok(P.undo.ok && R.undo.ok, `UNDO beide Wege nehmen die Umwandlung zurück (${P.undo.code || 'ok'} / ${R.undo.code || 'ok'})`);
  const dP = gleich(P.s0, P.s2);
  const dR = gleich(R.s0, R.s2);
  ok(dP.length === 0, `UNDO Primary: Transfer, Stück, Los und Salden je Konto/Kunde == vor der Umwandlung (${dP.join(' · ') || 'gleich'})`);
  ok(dR.length === 0, `UNDO PC2: Transfer, Stück, Los und Salden je Konto/Kunde == vor der Umwandlung (${dR.join(' · ') || 'gleich'})`);
  for (const [name, w] of [['Primary', P], ['PC2', R]] as const) {
    ok(s(w.db, 'SELECT status FROM invoices WHERE id = ?', [w.invId]) === 'CANCELLED' && n(w.db, 'SELECT COUNT(*) FROM invoices') === 1
      && n(w.db, 'SELECT COUNT(*) FROM invoice_lines WHERE invoice_id = ?', [w.invId]) === 1,
    `NO-DELETE ${name}: die Rechnung bleibt mit Nummer und Zeile als CANCELLED stehen (vorher hart gelöscht)`);
    ok(one(w.db, 'SELECT invoice_id FROM agent_transfers WHERE id = ?', [w.tid]) === null, `UNDO ${name}: der Transfer trägt keine Rechnung mehr`);
  }
  setTestDatabase(R.db as never);
  ok(posting.hasLedgerEntries('AGENT_TRANSFER_SOLD', R.tid), 'LEDGER die Verkaufsforderung steht wieder (vorher: nach dem Undo verschwunden)');
  ok(n(R.db, "SELECT COUNT(DISTINCT transaction_id) FROM ledger_entries WHERE source_module = 'AGENT_TRANSFER_SOLD' AND reverses_entry_id IS NULL") === 2,
    'LEDGER …als zweiter Zyklus derselben Quelle (Verkauf, Neubuchung)');
  ok(s(R.db, "SELECT counterparty_id FROM ledger_entries WHERE source_module = 'AGENT_TRANSFER_SOLD' AND account = 'ACCOUNTS_RECEIVABLE' ORDER BY rowid DESC LIMIT 1") === 'cust-1',
    'LEDGER …an denselben Kunden wie der Verkauf (nicht an den Rechnungskunden)');
  ok(balanced(P.db) && balanced(R.db), 'LEDGER jede Buchung gleicht sich aus');
  // Audit-Integrity-Gate — der Urheber unterscheidet sich GEWOLLT: lokal die Anmeldung am Primary, fern
  // der geprüfte Absender (zentrale Absender-Zuordnung, test/r6e/actor-attribution). Die Wirkung ist gleich.
  ok(one(P.db, 'SELECT created_by FROM invoices WHERE id = ?', [P.invId]) === 'user-test'
    && one(R.db, 'SELECT created_by FROM invoices WHERE id = ?', [R.invId]) === 'user-pc2',
  'ACTOR die Rechnung der Umwandlung gehört lokal der Anmeldung am Primary, fern dem Absender');
  const invP = ohne(row(P.db, 'SELECT * FROM invoices WHERE id = ?', [P.invId]), ['created_by']);
  const invR = ohne(row(R.db, 'SELECT * FROM invoices WHERE id = ?', [R.invId]), ['created_by']);
  ok(unterschiede(invP, invR).length === 0 && buchungen(P.db) === buchungen(R.db),
    `PARITY lokal == fern: stornierte Rechnung und Buchungen (${unterschiede(invP, invR).join(' · ') || 'gleich'})`);
  ok(R.undo.value.invoiceStatus === 'CANCELLED' && R.undo.value.invoiceReversed === true && Number(R.undo.value.receivablesRestored) === 1
    && S((R.undo.value.transfers as Array<Record<string, unknown>>).map((t) => t.invoiceId)) === S(['']),
  `RESULT die Antwort nennt Rechnungsstatus, Forderungen und die entkoppelten Transfers (${S(R.undo.value)})`);
  // Verlorene Antwort: dieselbe Kennung — dieselbe Antwort, keine zweite Wirkung.
  const vor = [lc(R.db), changelog(R.db)];
  const again = await fern(() => rev.runTransferUndo(deps(R.db), identity(R.undoId, 'transfers.undo_convert'), R.rumpf));
  ok(again.ok && again.replayed && S([lc(R.db), changelog(R.db)]) === S(vor) && gleich(R.s0, transferBild(R.db, [R.tid])).length === 0,
    'LOST dieselbe Kennung: eingefrorene Antwort, exakt eine Wirkung');
  // Und noch einmal umwandeln und zurücknehmen: derselbe Stand (mehrere Zyklen).
  const again2 = await fern(() => life.runConvertTransfer(deps(R.db), identity(nx(), 'transfers.convert_to_invoice'),
    rules.transferConvertBody({ id: R.tid, revision: trev(R.db, R.tid) }, { customerId: 'cust-2' })));
  const undo2 = await fern(() => rev.runTransferUndo(deps(R.db), identity(nx(), 'transfers.undo_convert'), house.transferUndoBody({ id: R.tid, revision: trev(R.db, R.tid) })));
  const d2 = gleich(R.s0, transferBild(R.db, [R.tid]));
  ok(again2.ok && undo2.ok && d2.length === 0 && n(R.db, "SELECT COUNT(*) FROM invoices WHERE status = 'CANCELLED'") === 2,
    `CYCLE umwandeln → zurück → umwandeln → zurück: wieder exakt der Stand davor, zwei stornierte Belege (${d2.join(' · ') || 'gleich'})`);
  setTestDatabase(P.db as never);
}
marker('CENTRAL_UI_R6E_TRANSFER_UNDO_STATE_PROVED');

// ══ §9 — Sammelrechnung: Undo an EINEM Transfer nimmt alle zurück ═══════════
for (const weg of ['primary', 'fern'] as const) {
  const db = freshDb();
  const t1 = await verkaufterTransfer(db, 'cust-1', 'p1', 300, 400);
  const t2 = await verkaufterTransfer(db, 'cust-1', 'p2', 250, 330);
  const s0 = transferBild(db, [t1, t2]);
  const conv = weg === 'primary'
    ? await primary(() => house.convertTransfersOnPrimary([t1, t2], { customerId: 'cust-2' }))
    : await fern(() => life.runConvertTransfers(deps(db), identity(nx(), 'transfers.convert_many_to_invoice'),
      rules.transferConvertManyBody([t1, t2].map((id) => ({ id, revision: trev(db, id) })), { customerId: 'cust-2' })));
  const invId = s(db, 'SELECT invoice_id FROM agent_transfers WHERE id = ?', [t1]);
  const undo = weg === 'primary'
    ? await primary(() => house.undoTransferConversionOnPrimary(t2, trev(db, t2)))
    : await fern(() => rev.runTransferUndo(deps(db), identity(nx(), 'transfers.undo_convert'), house.transferUndoBody({ id: t2, revision: trev(db, t2) })));
  const d = gleich(s0, transferBild(db, [t1, t2]));
  ok(conv.ok && undo.ok && invId !== '' && s(db, 'SELECT invoice_id FROM agent_transfers WHERE id = ?', [t2]) === ''
    && one(db, 'SELECT invoice_id FROM agent_transfers WHERE id = ?', [t1]) === null,
  `BATCH ${weg}: Undo am zweiten Transfer entkoppelt BEIDE (${undo.code || 'ok'})`);
  ok(d.length === 0, `BATCH ${weg}: beide Transfers, beide Stücke, beide Lose, alle Salden == vor der Umwandlung (${d.join(' · ') || 'gleich'})`);
  ok(s(db, 'SELECT status FROM invoices WHERE id = ?', [invId]) === 'CANCELLED' && n(db, 'SELECT COUNT(*) FROM invoice_lines WHERE invoice_id = ?', [invId]) === 2,
    `BATCH ${weg}: die Sammelrechnung bleibt mit zwei Zeilen als CANCELLED`);
  ok(balanced(db), `BATCH ${weg}: jede Buchung gleicht sich aus`);
}
marker('CENTRAL_UI_R6E_TRANSFER_UNDO_BATCH_PROVED');

// ══ §10 — Fassung, Sperren, Autorität (Undo) ═════════════════════════════════
{
  const db = freshDb();
  const tid = await verkaufterTransfer(db, 'cust-1', 'p2');
  const conv = await primary(() => house.convertTransferOnPrimary(tid, { customerId: 'cust-2' }));
  const invId = s(db, 'SELECT invoice_id FROM agent_transfers WHERE id = ?', [tid]);
  const stand = () => S([transferBild(db, [tid]), s(db, 'SELECT status FROM invoices WHERE id = ?', [invId]), lc(db)]);
  const vor = stand();
  ok(conv.ok, 'SETUP umgewandelt');
  const stale = await fern(() => rev.runTransferUndo(deps(db), identity(nx(), 'transfers.undo_convert'), { transferId: tid, expectedRevision: trev(db, tid) + 1 }));
  const staleP = await primary(() => house.undoTransferConversionOnPrimary(tid, trev(db, tid) + 1));
  ok(stale.code === 'RECORD_CHANGED' && stale.frozen && staleP.code === 'RECORD_CHANGED' && stand() === vor,
    `STALE eine andere Fassung: RECORD_CHANGED auf beiden Wegen, nichts geschrieben (${stale.code} / ${staleP.code})`);
  const fremd = await fern(() => rev.runTransferUndo(deps(db), identity(nx(), 'transfers.undo_convert', { branchId: 'branch-other' }), house.transferUndoBody({ id: tid, revision: trev(db, tid) })));
  ok(fremd.code === 'BRANCH_MISMATCH' && stand() === vor, `AUTH ein Ausweis einer fremden Filiale: BRANCH_MISMATCH (${fremd.code})`);
  insert(db, 'agent_transfers', { id: 'tr-x', branch_id: 'branch-other', transfer_number: 'TRF-X', agent_id: 'a-x', product_id: 'p-foreign', status: 'sold', invoice_id: invId, created_at: NOW, updated_at: NOW });
  const fremdT = await fern(() => rev.runTransferUndo(deps(db), identity(nx(), 'transfers.undo_convert'), { transferId: 'tr-x', expectedRevision: trev(db, 'tr-x') || 1 }));
  ok(fremdT.code === 'TRANSFER_NOT_FOUND', `AUTH ein Transfer einer fremden Filiale: TRANSFER_NOT_FOUND (${fremdT.code})`);
  db.run("DELETE FROM agent_transfers WHERE id = 'tr-x'");
  for (const [k, v] of [['invoiceId', invId], ['status', 'sold'], ['transferIds', [tid]], ['amount', 1], ['account', 'AR'], ['branchId', 'b'],
    ['revision', 3], ['settlementAmount', 1], ['receivablesRestored', 1], ['role', 'ADMIN']] as Array<[string, unknown]>) {
    ok(/the primary decides/.test(meldung(() => rev.parseTransferUndo({ transferId: tid, expectedRevision: 1, [k]: v }))), `PAYLOAD undo: ${k} bestimmt der Primary`);
  }
  ok(/unknown field/.test(meldung(() => rev.parseTransferUndo({ transferId: tid, expectedRevision: 1, foo: 1 }))), 'PAYLOAD undo: ein unbekanntes Feld wird abgewiesen');
  ok(/expectedRevision is required/.test(meldung(() => rev.parseTransferUndo({ transferId: tid }))), 'PAYLOAD undo: ohne gesehene Fassung kein Auftrag');
  // Bezahlt: die bestehende Regel.
  imHaus(() => useInvoiceStore.getState().recordPayment(invId, 50, 'cash'));
  const vorBez = stand();
  const bez = await fern(() => rev.runTransferUndo(deps(db), identity(nx(), 'transfers.undo_convert'), house.transferUndoBody({ id: tid, revision: trev(db, tid) })));
  const bezP = await primary(() => house.undoTransferConversionOnPrimary(tid, trev(db, tid)));
  ok(bez.code === 'TRANSFER_INVOICE_PAID' && bez.frozen && bezP.code === 'TRANSFER_INVOICE_PAID' && stand() === vorBez,
    `BLOCK eine bezahlte Rechnung: TRANSFER_INVOICE_PAID auf beiden Wegen (${bez.code} / ${bezP.code})`);
  // Nicht umgewandelt.
  const db2 = freshDb();
  const t2 = await verkaufterTransfer(db2, 'cust-1', 'p1');
  const nicht = await fern(() => rev.runTransferUndo(deps(db2), identity(nx(), 'transfers.undo_convert'), house.transferUndoBody({ id: t2, revision: trev(db2, t2) })));
  ok(nicht.code === 'TRANSFER_NOT_CONVERTED', `BLOCK ein Transfer ohne Rechnung: TRANSFER_NOT_CONVERTED (${nicht.code})`);
  // Eine Retoure an der Rechnung: die Umkehr der Zeilen-Buchung ist nicht mehr unberührt.
  await primary(() => house.convertTransferOnPrimary(t2, { customerId: 'cust-2' }));
  const inv2 = s(db2, 'SELECT invoice_id FROM agent_transfers WHERE id = ?', [t2]);
  const line2 = s(db2, 'SELECT id FROM invoice_lines WHERE invoice_id = ?', [inv2]);
  const ret = await primary(() => returnHouse.createReturnOnPrimary({ invoiceId: inv2, lines: [{ invoiceLineId: line2, quantity: 1 }], refundMethod: 'cash', productDisposition: 'IN_STOCK', refundNow: false }));
  const vorRet = S([transferBild(db2, [t2]), lc(db2), s(db2, 'SELECT status FROM invoices WHERE id = ?', [inv2])]);
  const mitRet = await fern(() => rev.runTransferUndo(deps(db2), identity(nx(), 'transfers.undo_convert'), house.transferUndoBody({ id: t2, revision: trev(db2, t2) })));
  ok(ret.ok && mitRet.code === 'TRANSFER_INVOICE_HAS_RETURNS' && vorRet === S([transferBild(db2, [t2]), lc(db2), s(db2, 'SELECT status FROM invoices WHERE id = ?', [inv2])]),
    `BLOCK eine Rechnung mit Retoure: erst die Retoure stornieren (${mitRet.code})`);
  // Die Grundlage selbst: schon storniert, fremde Filiale.
  ok(wirft(() => imHaus(() => reversal.reverseInvoiceInHouse(inv2, 'branch-other'))) === 'INVOICE_NOT_FOUND',
    'FOUNDATION eine Rechnung einer fremden Filiale: INVOICE_NOT_FOUND');
}
marker('CENTRAL_UI_R6E_TRANSFER_UNDO_AUTHORITY_PROVED');

// ══ §11 — Fehlerinjektion (Undo): NACH dem Storno der Rechnung, VOR dem Entkoppeln ═══
for (const weg of ['primary', 'fern'] as const) {
  const db = freshDb();
  const tid = await verkaufterTransfer(db, 'cust-1', 'p2');
  await primary(() => house.convertTransferOnPrimary(tid, { customerId: 'cust-2' }));
  const invId = s(db, 'SELECT invoice_id FROM agent_transfers WHERE id = ?', [tid]);
  const stand = () => S([transferBild(db, [tid]), s(db, 'SELECT status FROM invoices WHERE id = ?', [invId]), lc(db), changelog(db),
    all(db, 'SELECT qty_remaining, status FROM stock_lots ORDER BY id')]);
  const vor = stand();
  const echt = useAgentStore.getState().updateTransfer;
  let imFehler = '';
  useAgentStore.setState({
    updateTransfer: ((id: string, data: Record<string, unknown>) => {
      if ('invoiceId' in data && data.invoiceId === undefined) {
        imFehler = S([s(db, 'SELECT status FROM invoices WHERE id = ?', [invId]), s(db, "SELECT qty_remaining FROM stock_lots WHERE product_id = 'p2'")]);
        throw new Error('R6E: failure between invoice reversal and transfer restore');
      }
      return echt(id, data as never);
    }) as never,
  });
  const x = nx();
  let aus: Ausgang;
  try {
    aus = weg === 'primary'
      ? await primary(() => house.undoTransferConversionOnPrimary(tid, trev(db, tid)))
      : await fern(() => rev.runTransferUndo(deps(db), identity(x, 'transfers.undo_convert'), house.transferUndoBody({ id: tid, revision: trev(db, tid) })));
  } finally { useAgentStore.setState({ updateTransfer: echt }); }
  ok(imFehler === S(['CANCELLED', '1']), `ATOMIC ${weg}: im Fehler war die Rechnung schon storniert und das Los zurück (${imFehler})`);
  ok(!aus.ok && stand() === vor, `ATOMIC ${weg}: Rechnung nicht storniert, Lose, Buchungen, Abgleich, Transfer unverändert (${aus.code.slice(0, 50)})`);
  if (weg === 'fern') ok(lookupCommand(db as never, identity(x, 'transfers.undo_convert')).kind === 'fresh', 'ATOMIC fern: die Kennung bleibt frei');
  const heil = weg === 'primary'
    ? await primary(() => house.undoTransferConversionOnPrimary(tid, trev(db, tid)))
    : await fern(() => rev.runTransferUndo(deps(db), identity(x, 'transfers.undo_convert'), house.transferUndoBody({ id: tid, revision: trev(db, tid) })));
  ok(heil.ok && s(db, 'SELECT status FROM invoices WHERE id = ?', [invId]) === 'CANCELLED'
    && n(db, "SELECT COUNT(DISTINCT transaction_id) FROM ledger_entries WHERE source_module = 'AGENT_TRANSFER_SOLD' AND reverses_entry_id IS NULL") === 2,
  `ATOMIC ${weg}: danach gelingt es genau einmal (${heil.code || 'ok'})`);
}
{
  // Eine Buchung des Stornos scheitert — `updateInvoice` fing sie bisher ab (`safePost`); hier bricht sie ab.
  const db = freshDb();
  const tid = await verkaufterTransfer(db, 'cust-1', 'p2');
  await primary(() => house.convertTransferOnPrimary(tid, { customerId: 'cust-2' }));
  const vor = S([transferBild(db, [tid]), lc(db)]);
  const { db: bad } = faulty(db, /INSERT INTO ledger_entries/);
  setTestDatabase(bad as never);
  let aus: Ausgang;
  try { aus = await fern(() => rev.runTransferUndo(deps(bad), identity(nx(), 'transfers.undo_convert'), house.transferUndoBody({ id: tid, revision: trev(db, tid) }))); }
  finally { setTestDatabase(db as never); }
  ok(!aus.ok && S([transferBild(db, [tid]), lc(db)]) === vor, `ATOMIC eine abgefangene Stornobuchung bricht die ganze Rücknahme ab (${aus.code.slice(0, 60)})`);
}
marker('CENTRAL_UI_R6E_TRANSFER_UNDO_ATOMIC_PROVED');

// ══ §12 — Client: keine lokale Datenbank, der Weg geht über den Primary ═══════
{
  const db = freshDb();
  let touched = 0;
  const counting = new Proxy(db as object, {
    get(t, k) {
      const v = (t as Record<string | symbol, unknown>)[k];
      if (k === 'run' || k === 'exec') return (...a: unknown[]) => { touched++; return (v as (...x: unknown[]) => unknown).apply(t, a); };
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
    const a = await primary(() => useSalesReturnStore.getState().cancelReturn('r1', 'x'));
    const b = await primary(() => house.undoTransferConversionOnPrimary('t1', 2));
    const c = wirft(() => cancelHouse.cancelReturnInHouse('r1', 'x', { userId: 'u', role: 'ADMIN' }, 'branch-main'));
    ok(a.code === 'RETURN_PRIMARY_ONLY' && b.code === 'TRANSFER_PRIMARY_ONLY' && c === 'RETURN_PRIMARY_ONLY' && touched === 0,
      `CLIENT jeder Primary-Anschluss verweigert, bevor er eine Datenbank anfasst (${S([a.code, b.code, c])}, Zugriffe ${touched})`);
    useSalesReturnStore.setState({
      returns: [{ id: 'r-pc2', status: 'APPROVED', refundPaidAmount: 0, lines: [] } as never],
      cancelability: { 'r-pc2': { canCancel: true, blockReason: null, needsStockWarning: true } },
    });
    const cb = useSalesReturnStore.getState().getReturnCancelability('r-pc2');
    ok(cb.canCancel && cb.needsStockWarning && touched === 0, 'CLIENT der Knopf „Cancel Return" liest die Auskunft des Primary — keine lokale Frage');
    useSalesReturnStore.setState({ cancelability: {} });
    ok(useSalesReturnStore.getState().getReturnCancelability('r-pc2').canCancel === false, 'CLIENT …ohne Auskunft fail-closed');
    const write = (op: string) => new CommandSaveController<Record<string, unknown>>(op).beginAttempt();
    const r1 = await runSharedWrite(true, { local: () => { throw new Error('lokal'); }, remote: () => ({ returnId: 'r-pc2', expectedRevision: 3, reason: 'x' }) }, write('returns.cancel'));
    const r2 = await runSharedWrite(true, { local: () => { throw new Error('lokal'); }, remote: () => house.transferUndoBody({ id: 't-pc2', revision: 4 }) }, write('transfers.undo_convert'));
    const sent1 = calls.find((x) => x.body.op === 'returns.cancel');
    const sent2 = calls.find((x) => x.body.op === 'transfers.undo_convert');
    ok(r1.kind === 'ok' && r2.kind === 'ok' && !!sent1 && !!sent2
      && S(Object.keys(sent1.body.payload as object).sort()) === S(['expectedRevision', 'reason', 'returnId'])
      && S(Object.keys(sent2.body.payload as object).sort()) === S(['expectedRevision', 'transferId']) && touched === 0,
    `CLIENT je EIN geprüfter Auftrag mit der gesehenen Fassung — keine lokale Wirkung (${S(sent1?.body.payload)} · ${S(sent2?.body.payload)})`);
  } finally {
    globalThis.fetch = origFetch;
    store.delete('lataif_runtime_mode');
    store.delete('lataif_client_server_url');
    store.delete('lataif_client_token');
    setTestDatabase(db as never);
  }
}
marker('CENTRAL_UI_R6E_REVERSAL_CLIENT_PROVED');

// ══ §13 — Oberfläche: jede Maske ein Anschluss ══════════════════════════════
{
  for (const f of ['src/components/agents/TransferTable.tsx', 'src/pages/agents/TransferDetail.tsx']) {
    const t = codeOf(src(f));
    const name = f.split('/').pop();
    ok(/w\.ok\('transfers\.undo_convert'/.test(t) && /undoTransferConversionOnPrimary\(/.test(t) && /transferUndoBody\(/.test(t),
      `UI ${name}: „Undo" über die gemeinsame Weiche — Primary-Anschluss und Fernrumpf aus der geteilten Domäne`);
    ok(!/undoTransferInvoiceConvert\(/.test(t), `UI ${name}: die Store-Aktion wird nicht mehr direkt gerufen`);
    ok(/The invoice will be cancelled and the transfer reset to "Sold"/.test(src(f)) && !/invoice will be deleted/.test(src(f)),
      `UI ${name}: die Rückfrage sagt „cancelled", nicht mehr „deleted"`);
    ok(/data-transfer-undo/.test(t) && /canUndoTransferConvert\(/.test(t), `UI ${name}: data-transfer-undo, derselbe Knopf-Regel`);
  }
  const idc = codeOf(src('src/pages/invoices/InvoiceDetail.tsx'));
  ok(/w\.ok\('returns\.cancel'/.test(idc) && /local: \(\) => cancelReturn\(returnId, grund\)/.test(idc)
    && /remote: \(\) => \(\{ returnId, expectedRevision: fassung, reason: grund \}\)/.test(idc),
  'UI InvoiceDetail: „Cancel Return" über die gemeinsame Weiche mit der gesehenen Fassung');
  ok(/data-return-cancel-open/.test(idc) && /data-return-cancel-reason/.test(idc) && /data-return-cancel-confirm/.test(idc),
    'UI InvoiceDetail: data-return-cancel-open / -reason / -confirm');
  ok(/disabled=\{!cancelReturnReason\.trim\(\) \|\| w\.busy\}/.test(idc), 'UI InvoiceDetail: Knopf ohne Grund und während des Laufs gesperrt');
  ok(!/alert\(e instanceof Error \? e\.message : String\(e\)\);\s*\n?\s*\}\s*\n?\s*\}\}\s*\n?\s*style=\{\{ background: '#DC2626' \}\}/.test(idc),
    'UI InvoiceDetail: kein lokaler try/alert-Pfad mehr am Storno');
  const ag = codeOf(src('src/stores/agentStore.ts'));
  const undoBody = ag.slice(ag.indexOf('undoTransferInvoiceConvert: (transferId, branchIdArg)'), ag.indexOf('}));', ag.indexOf('undoTransferInvoiceConvert: (transferId, branchIdArg)')));
  ok(!/deleteInvoice\(/.test(undoBody) && /reverseInvoiceInHouse\(/.test(undoBody), 'NO-DELETE „Undo convert" storniert über die Grundlage und löscht keine Rechnung');
  const rv = codeOf(src('src/core/invoices/invoice-reversal.ts'));
  ok(/updateInvoice\(invoiceId, \{ status: 'CANCELLED' \}\)/.test(rv) && /watchLedgerPosts\(/.test(rv) && !/deleteInvoice|DELETE FROM|beginLedgerTransaction|rollbackLedgerTransaction/.test(rv),
    'FOUNDATION die Grundlage: CANCELLED über das Haus, abgefangene Buchungen brechen ab, nichts wird gelöscht, keine eigene Transaktion');
  const th = codeOf(src('src/core/agents/transfer-house.ts'));
  ok(!/INSERT INTO|UPDATE \w+ SET|DELETE FROM/.test(th) && /runOnPrimary\(/.test(th), 'DOMAIN die Transfer-Folge schreibt nichts selbst — sie ruft das Haus');
}
marker('CENTRAL_UI_R6E_REVERSAL_UI_PROVED');

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central ui parity r6e reversal parity: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
