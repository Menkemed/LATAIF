// ════════════════════════════════════════════════════════════════════════════
// Owner 14.11.2026 — „New Transfer" mit mehreren Stücken: jedes Stück ein eigener Transfer (Nummer, Preis, Modell, Status),
// alle in EINER Transaktion; vorher geprüft; Primary == PC2; PC2-Wiederholung ohne Doppel; alter Einzelauftrag bleibt.
// Run: node test/transfer-batch/transfer-batch.test.ts
// Aufbau (Welt, Anschlüsse) übernommen aus test/r5d/transfer-parity.test.ts.
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath, join } from 'node:path';

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
(globalThis as { window?: unknown }).window = { localStorage: storage };

const initSqlJs = (await import('sql.js')).default;
const SQL = await initSqlJs({ locateFile: (f: string) => resolvePath(repo, 'node_modules/sql.js/dist', f) });

const { setTestDatabase } = await import('../sync/_db-shim.ts');
const { tauriState } = await import('../bridge/_tauri-shim.ts');
const { COMMAND_LEDGER_DDL, COMMAND_LEDGER_INDEX } = await import('../../src/core/bridge/command-ledger.ts');
const { resetDurabilityStateForTest } = await import('../../src/core/bridge/durability-state.ts');
const { resetTransactionHealthForTest } = await import('../../src/core/db/transaction-health.ts');
const { installWriteGuard } = await import('../../src/core/db/write-guard.ts');
const { SKU_SEQUENCES_DDL } = await import('../../src/core/products/sku-sequence.ts');
const { ALLOWED_MUTATIONS } = await import('../../src/core/bridge/command-registry.ts');
await import('../../src/core/bridge/read-commands.ts');
await import('../../src/core/bridge/customer-commands.ts');
const fin = await import('../../src/core/bridge/financial-commands.ts');
const life = await import('../../src/core/bridge/lifecycle-commands.ts');
const cmd = await import('../../src/core/bridge/service-commands.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const { applyMediaSchema } = await import('../../src/core/db/media-schema.ts');
const { eventBus } = await import('../../src/core/events/event-bus.ts');
const { useInvoiceStore } = await import('../../src/stores/invoiceStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { useCustomerStore } = await import('../../src/stores/customerStore.ts');
const { useAgentStore } = await import('../../src/stores/agentStore.ts');
const house = await import('../../src/core/agents/transfer-house.ts');
const rules = await import('../../src/core/agents/transfer-rules.ts');
const { R4C_MATRIX } = await import('../uiparity/_r4c-write-matrix.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const codeOf = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const NOW = '2026-09-12T10:00:00.000Z';
const S = (v: unknown): string => JSON.stringify(v);

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
}

const PRODUKTE: Array<[string, string, string, string]> = [
  ['p1', 'branch-main', 'in_stock', 'MARGIN'], ['p2', 'branch-main', 'in_stock', 'VAT_10'],
  ['p3', 'branch-main', 'in_stock', 'MARGIN'], ['p4', 'branch-main', 'in_stock', 'VAT_10'],
  ['p5', 'branch-main', 'in_stock', 'ZERO'], ['p6', 'branch-main', 'in_stock', 'MARGIN'],
  ['p-sold', 'branch-main', 'sold', 'MARGIN'], ['p-foreign', 'branch-other', 'in_stock', 'MARGIN'],
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
  for (const [id, first, branch] of [['cust-1', 'Ali', 'branch-main'], ['cust-2', 'Nora', 'branch-main'],
    ['cust-x', 'Fremd', 'branch-other'], ['sys-walkin', 'Walk-in', 'branch-main']]) {
    db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level,
        preferences, customer_type, sales_stage, created_at, updated_at)
      VALUES (?,?,?,'Hassan','BH','en',0,'[]','collector','active',?,?)`, [id, branch, first, NOW, NOW]);
  }
  for (const [id, branch, st] of [['emp-1', 'branch-main', 'active'], ['emp-gone', 'branch-main', 'inactive'], ['emp-x', 'branch-other', 'active']]) {
    insert(db, 'employees', { id, branch_id: branch, name: 'M ' + id, employment_status: st, created_at: NOW, updated_at: NOW });
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

const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-000000000000`;
const ACTOR = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test', role: 'ADMIN' };
const identity = (x: string, op: string, hash = 'h' + x) => ({ commandId: ID(x), ...ACTOR, op, payloadHash: hash });
const fremd = (x: string, op: string) => ({ ...identity(x, op), branchId: 'branch-other' });
const deps = (db: Db) => ({
  db: db as never,
  begin: posting.beginLedgerTransaction,
  commit: posting.commitLedgerTransaction,
  rollback: posting.rollbackLedgerTransaction,
  durableSave: async () => {},
  now: () => NOW,
});
const val = <T>(o: unknown): T => (o as { value: T }).value;
const trev = (db: Db, id: string): number => n(db, 'SELECT revision FROM agent_transfers WHERE id = ?', [id]);

/** Ein Ausgang, egal ob Primary oder fern: ok mit Wert, oder der Code des Neins. */
interface Ausgang { ok: boolean; code: string; value?: Record<string, unknown>; replayed?: boolean }
async function fern(p: () => Promise<unknown>): Promise<Ausgang> {
  try {
    const o = await p() as { kind: string; code?: string; value?: Record<string, unknown>; replayed?: boolean };
    if (o.kind === 'ok') return { ok: true, code: '', value: o.value, replayed: o.replayed };
    return { ok: false, code: o.code ?? '(ohne Code)' };
  } catch (e) {
    return { ok: false, code: (e as { code?: string }).code ?? 'THROWN:' + String(e) };
  }
}
async function primary(p: () => Promise<unknown>): Promise<Ausgang> {
  try { return { ok: true, code: '', value: await p() as Record<string, unknown> }; }
  catch (e) { return { ok: false, code: (e as { code?: string }).code ?? 'THROWN:' + String(e) }; }
}

const OHNE = /^(id|version|sync_status)$|_at$|_date$/;
function ohne(r: Record<string, unknown>, auch: string[] = []): Record<string, unknown> {
  return Object.fromEntries(Object.entries(r).filter(([k]) => !OHNE.test(k) && !auch.includes(k)).sort(([a], [b]) => a.localeCompare(b)));
}
const unterschiede = (a: Record<string, unknown>, b: Record<string, unknown>): string[] =>
  Object.keys({ ...a, ...b }).filter((k) => S(a[k] ?? null) !== S(b[k] ?? null)).map((k) => `${k}: ${S(a[k])} vs ${S(b[k])}`);
const buchungen = (db: Db): string =>
  all(db, 'SELECT account, direction, ROUND(SUM(amount), 3) FROM ledger_entries GROUP BY account, direction ORDER BY account, direction');
const zaehler = (db: Db): number => n(db, "SELECT next_number FROM document_sequences WHERE doc_type = 'TRF'");

// ════════════════════════════════════════════════════════════════════════════
// Owner 14.11.2026 — „New Transfer" mit mehreren Stücken (TRANSFER BATCH).
// ════════════════════════════════════════════════════════════════════════════
const KOPF = { customerId: 'cust-1', settlementModel: 'split', excessSplitPct: 60, returnBy: '2026-10-01', staffId: 'emp-1', notes: 'Batch' };
const ITEMS = [
  { productId: 'p1', ourPrice: 900 },                                        // erbt split 60
  { productId: 'p2', ourPrice: 500, settlementModel: 'full' },               // eigenes Modell full
  { productId: 'p3', ourPrice: 700, settlementModel: 'split', excessSplitPct: 30 }, // eigener Anteil 30
];
const BATCH = { ...KOPF, items: ITEMS };
const SOLL = { p1: ['split', 60, 900], p2: ['full', null, 500], p3: ['split', 30, 700] } as Record<string, unknown[]>;
const zeilen = (db: Db): Record<string, unknown>[] => (db.exec(`SELECT t.product_id, t.transfer_number, t.agent_price, t.settlement_model, t.excess_split_pct,
    t.status, t.return_by, t.staff_id, t.notes, t.branch_id, p.stock_status, p.source_type, p.quantity
  FROM agent_transfers t JOIN products p ON p.id = t.product_id ORDER BY t.product_id`)[0]?.values ?? [])
  .map((v) => ({ product: v[0], nummer: v[1], preis: Number(v[2]), modell: v[3], anteil: v[4] === null ? null : Number(v[4]), status: v[5],
    returnBy: v[6], staff: v[7], notes: v[8], branch: v[9], stueck: `${v[10]}/${v[11]}/${v[12]}` }));
const ohneNummer = (z: Record<string, unknown>[]) => z.map(({ nummer: _n, ...r }) => r);

// ── B0 Regel und Rumpf: je Stück aufgelöst, keine Vererbung auf dem Draht ──
{
  const inputs = rules.normalizeTransferBatch(BATCH);
  ok(S(inputs.map((x) => [x.productId, x.settlementModel, x.excessSplitPct ?? null, x.ourPrice])) === S([['p1', 'split', 60, 900], ['p2', 'full', null, 500], ['p3', 'split', 30, 700]]),
    `B0 je Stück: erbt das gemeinsame Modell, oder eigenes Modell / eigener Anteil (${S(inputs.map((x) => [x.settlementModel, x.excessSplitPct]))})`);
  const body = rules.transferBatchBody(BATCH) as { items: Array<Record<string, unknown>> } & Record<string, unknown>;
  ok(S(body.items) === S([{ productId: 'p1', agentPrice: 900, settlementModel: 'split', excessSplitPct: 60 },
    { productId: 'p2', agentPrice: 500, settlementModel: 'full' }, { productId: 'p3', agentPrice: 700, settlementModel: 'split', excessSplitPct: 30 }])
    && !('settlementModel' in body) && body.customerId === 'cust-1' && body.staffId === 'emp-1' && body.notes === 'Batch',
    `B0 Rumpf: je Stück Preis/Modell/Anteil aufgelöst, gemeinsam Kunde/Datum/Mitarbeiter/Notiz (${S(body.items)})`);
  const nein = (f: () => unknown): string => { try { f(); return ''; } catch (e) { return String((e as { code?: string }).code) + ' ' + String((e as Error).message); } };
  ok(/^NO_ITEMS_SELECTED/.test(nein(() => rules.normalizeTransferBatch({ ...KOPF, items: [] }))), 'B0 keine Auswahl: Nein');
  ok(/^ITEM_LISTED_TWICE item 2/.test(nein(() => rules.normalizeTransferBatch({ ...KOPF, items: [ITEMS[0], ITEMS[0]] }))), 'B0 ein Stück doppelt: Nein mit Stelle');
  ok(/^INVALID_AMOUNT item 2/.test(nein(() => rules.normalizeTransferBatch({ ...KOPF, items: [ITEMS[0], { productId: 'p2', ourPrice: 0 }] }))), 'B0 Preis 0 bei Stück 2: Nein mit Stelle');
  ok(/^TOO_MANY_ITEMS/.test(nein(() => rules.normalizeTransferBatch({ ...KOPF, items: Array.from({ length: 51 }, (_, i) => ({ productId: 'x' + i, ourPrice: 1 })) }))),
    'B0 mehr als 50 Stücke: Nein');
  ok(rules.normalizeTransferBatch({ ...KOPF, items: Array.from({ length: 50 }, (_, i) => ({ productId: 'x' + i, ourPrice: 1 })) }).length === 50, 'B0 genau 50 Stücke: geht');
}

// ── B1 Mehrfachanlage: drei Transfers, eigene Nummern, Preise, Modelle; Primary == PC2 ──
let bildP: Record<string, unknown>[] = [];
{
  const db = freshDb();
  const z0 = zaehler(db);
  const p = await primary(() => house.createTransfersOnPrimary(BATCH));
  ok(p.ok, `B1 am Primary entstehen die Transfers (${p.code})`);
  const z = zeilen(db);
  bildP = z;
  ok(z.length === 3 && z.every((r) => S([r.modell, r.anteil, r.preis]) === S(SOLL[String(r.product)])),
    `B1 Preise und Modelle je Stück wie gewählt (${S(z.map((r) => [r.product, r.modell, r.anteil, r.preis]))})`);
  ok(z.every((r) => r.status === 'transferred' && r.returnBy === '2026-10-01' && r.staff === 'emp-1' && r.notes === 'Batch' && r.branch === 'branch-main'),
    'B1 gemeinsame Angaben an jedem Transfer: Status, Rückgabe, Mitarbeiter, Notiz, Filiale');
  const nummern = z.map((r) => String(r.nummer));
  ok(new Set(nummern).size === 3 && nummern.every((x) => /^TRF-\d{4}-\d{5}$/.test(x)) && zaehler(db) === z0 + 3,
    `B1 drei eigene TRF-Nummern aus dem Kreis, Zähler +3 (${S(nummern)})`);
  ok(z.every((r) => r.stueck === 'with_agent/AGENT/1'), `B1 jedes Stück beim Agenten (${S(z.map((r) => r.stueck))})`);
  ok(n(db, 'SELECT COUNT(*) FROM agents') === 1, 'B1 EIN Agent zum Kunden');
}
{
  const db = freshDb();
  const r = await fern(() => cmd.runTransferCreate(deps(db), identity('101', 'transfers.create'), rules.transferBatchBody(BATCH)));
  ok(r.ok && Number(r.value?.count) === 3 && (r.value?.transfers as unknown[]).length === 3, `B1 PC2: EIN Auftrag, drei Transfers (${r.code || r.value?.count})`);
  const z = zeilen(db);
  ok(S(ohneNummer(z)) === S(ohneNummer(bildP)), `B1 PARITÄT Primary == PC2 je Stück (${S(ohneNummer(z)) === S(ohneNummer(bildP)) ? 'gleich' : S(ohneNummer(z))})`);
  // Idempotenz: dieselbe Kennung noch einmal — dieselbe Antwort, nichts doppelt.
  const z1 = zaehler(db);
  const again = await fern(() => cmd.runTransferCreate(deps(db), identity('101', 'transfers.create'), rules.transferBatchBody(BATCH)));
  ok(again.ok && again.replayed === true && S(again.value) === S(r.value), 'B1 PC2-Wiederholung: dieselbe Antwort');
  ok(n(db, 'SELECT COUNT(*) FROM agent_transfers') === 3 && zaehler(db) === z1, 'B1 …kein Transfer doppelt, keine Nummer verbrannt');
  // Neuer Auftrag mit denselben Stücken: sie sind schon draußen — Nein, nichts geschrieben.
  const nochmal = await fern(() => cmd.runTransferCreate(deps(db), identity('102', 'transfers.create'), rules.transferBatchBody(BATCH)));
  ok(!nochmal.ok && n(db, 'SELECT COUNT(*) FROM agent_transfers') === 3, `B1 dieselben Stücke erneut: Nein (${nochmal.code})`);
}

// ── B2 Atomar: scheitert das dritte Stück beim Schreiben, bleibt NICHTS ──
{
  const echt = eventBus.emit.bind(eventBus);
  for (const weg of ['primary', 'fern'] as const) {
    const db = freshDb();
    const vor = { zaehler: zaehler(db), agenten: n(db, 'SELECT COUNT(*) FROM agents') };
    let geschrieben = 0, imFehler = '';
    (eventBus as { emit: unknown }).emit = (name: string, ...rest: unknown[]) => {
      if (name === 'agent_transfer.created' && ++geschrieben === 3) {
        imFehler = S([n(db, 'SELECT COUNT(*) FROM agent_transfers'), n(db, "SELECT COUNT(*) FROM products WHERE stock_status = 'with_agent'")]);
        throw new Error('BATCH: failure while writing the third transfer');
      }
      return (echt as (...a: unknown[]) => unknown)(name, ...rest);
    };
    const aus = weg === 'primary'
      ? await primary(() => house.createTransfersOnPrimary(BATCH))
      : await fern(() => cmd.runTransferCreate(deps(db), identity('201', 'transfers.create'), rules.transferBatchBody(BATCH)));
    (eventBus as { emit: unknown }).emit = echt;
    reload();
    ok(imFehler === S([3, 3]), `B2 ${weg}: im Fehler standen schon drei Transfers (${imFehler})`);
    ok(!aus.ok, `B2 ${weg}: kein Erfolg gemeldet (${aus.code})`);
    ok(n(db, 'SELECT COUNT(*) FROM agent_transfers') === 0 && n(db, "SELECT COUNT(*) FROM products WHERE stock_status != 'in_stock' AND id IN ('p1','p2','p3')") === 0,
      `B2 ${weg}: vollständiges Rollback — kein Transfer, alle Stücke wieder im Lager`);
    ok(n(db, 'SELECT COUNT(*) FROM agents') === vor.agenten && zaehler(db) === vor.zaehler, `B2 ${weg}: kein Agent, keine Nummer verbrannt`);
  }
}

// ── B3 Vorher geprüft: ein nicht verfügbares Stück in der Mitte — Nein mit Stelle, nichts geschrieben ──
for (const weg of ['primary', 'fern'] as const) {
  const db = freshDb();
  const form = { ...KOPF, items: [ITEMS[0], { productId: 'p-sold', ourPrice: 400 }, ITEMS[2]] };
  const aus = weg === 'primary'
    ? await primary(() => house.createTransfersOnPrimary(form))
    : await fern(() => cmd.runTransferCreate(deps(db), identity('301', 'transfers.create'), rules.transferBatchBody(form)));
  let msg = '';
  try { await house.createTransfersOnPrimary(form); } catch (e) { msg = String((e as Error).message); }
  ok(aus.code === 'PRODUCT_NOT_AVAILABLE' && /item 2 \(SKU-p-sold\)/.test(msg) && n(db, 'SELECT COUNT(*) FROM agent_transfers') === 0
    && s(db, "SELECT stock_status FROM products WHERE id = 'p1'") === 'in_stock',
    `B3 ${weg}: verkauftes Stück an Stelle 2 → Nein, nichts geschrieben (${aus.code}; ${msg.slice(0, 60)})`);
}
{
  const db = freshDb();
  const doppelt = await fern(() => cmd.runTransferCreate(deps(db), identity('302', 'transfers.create'),
    { customerId: 'cust-1', items: [{ productId: 'p1', agentPrice: 900 }, { productId: 'p1', agentPrice: 900 }] }));
  const zuViele = await fern(() => cmd.runTransferCreate(deps(db), identity('303', 'transfers.create'),
    { customerId: 'cust-1', items: Array.from({ length: 51 }, (_, i) => ({ productId: 'p' + i, agentPrice: 1 })) }));
  const fremdesFeld = await fern(() => cmd.runTransferCreate(deps(db), identity('304', 'transfers.create'),
    { customerId: 'cust-1', productId: 'p1', items: [{ productId: 'p2', agentPrice: 1 }] }));
  const anteilOhneSplit = await fern(() => cmd.runTransferCreate(deps(db), identity('305', 'transfers.create'),
    { customerId: 'cust-1', items: [{ productId: 'p2', agentPrice: 1, settlementModel: 'full', excessSplitPct: 40 }] }));
  ok([doppelt, zuViele, fremdesFeld, anteilOhneSplit].every((x) => !x.ok) && n(db, 'SELECT COUNT(*) FROM agent_transfers') === 0,
    `B3 PC2-Rumpf streng: doppelt / 51 / gemischt mit Einzelfeldern / Anteil ohne Split — Nein (${S([doppelt.code, zuViele.code, fremdesFeld.code, anteilOhneSplit.code])})`);
}

// ── B4 Alte Einzelaufträge bleiben: der Rumpf ohne Artikelliste legt genau einen Transfer an ──
{
  const db = freshDb();
  const r = await fern(() => cmd.runTransferCreate(deps(db), identity('401', 'transfers.create'),
    { customerId: 'cust-1', productId: 'p1', agentPrice: 900, settlementModel: 'split', excessSplitPct: 60 }));
  ok(r.ok && typeof r.value?.transferId === 'string' && n(db, 'SELECT COUNT(*) FROM agent_transfers') === 1,
    `B4 alter Einzelauftrag: ein Transfer, dieselbe Antwortform (${r.code || 'ok'})`);
}

// ── B5 Stückzahl über 1: das ganze Stück geht hinaus (keine Teilmenge) ──
{
  const db = freshDb();
  db.run("UPDATE products SET quantity = 2 WHERE id = 'p5'");
  db.run("UPDATE stock_lots SET qty_total = 2, qty_remaining = 2 WHERE product_id = 'p5'");
  reload();
  const p = await primary(() => house.createTransfersOnPrimary({ ...KOPF, items: [{ productId: 'p5', ourPrice: 300 }, ITEMS[0]] }));
  ok(p.ok && s(db, "SELECT stock_status || '/' || quantity FROM products WHERE id = 'p5'") === 'with_agent/2'
    && n(db, "SELECT COUNT(*) FROM agent_transfers WHERE product_id = 'p5'") === 1,
    `B5 Stückzahl 2: ein Transfer, das ganze Stück beim Agenten (${s(db, "SELECT stock_status || '/' || quantity FROM products WHERE id = 'p5'")})`);
}

// ── B6 Die Maske: Mehrfachauswahl verdrahtet, ein Stück bleibt der Einzelauftrag ──
{
  const liste = src('src/pages/agents/AgentList.tsx');
  ok(/data-transfer-product-check/.test(liste) && /data-transfer-item-price/.test(liste) && /data-transfer-item-model/.test(liste)
    && /data-transfer-item-remove/.test(liste) && /TRANSFER_BATCH_MAX/.test(liste),
    'B6 Maske: Kästchen, Preis je Stück, Modell je Stück, Entfernen, Obergrenze');
  ok(/createTransfersOnPrimary\(batchForm\)/.test(liste) && /transferBatchBody\(batchForm\)/.test(liste)
    && /createTransferOnPrimary\(form\)/.test(liste) && /transferCreateBody\(form\)/.test(liste),
    'B6 Maske: mehrere → ein Auftrag mit Artikelliste; eines → der bisherige Einzelauftrag');
}

console.log(`\ntransfer-batch: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('TRANSFER_BATCH_PROVED');
