// ════════════════════════════════════════════════════════════════════════════
// Owner 14.11.2026 — Approval-Transfer bearbeiten und korrigieren: Preis/Modell vor und nach dem Verkauf (Umbuchung am
// Verkaufstag), Sperren nach Zahlung/Rechnung, Entfernen ohne Buchung (Löschen) und mit Buchung (Storno), Primary == PC2.
// Run: node test/transfer-correction/transfer-correction.test.ts
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
// Owner 14.11.2026 — „Edit" und „Remove" eines Approval-Transfers.
// ════════════════════════════════════════════════════════════════════════════
const konto = (db: Db, acc: string): number => n(db, `SELECT ROUND(COALESCE(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END), 0), 3)
  FROM ledger_entries WHERE account = ?`, [acc]);
const ausgeglichen = (db: Db): boolean => n(db, "SELECT ROUND(COALESCE(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END), 0), 3) FROM ledger_entries") === 0;
const lebendAR = (db: Db, tid: string): string => all(db, `SELECT e1.amount, substr(e1.occurred_at, 1, 10), e1.counterparty_id FROM ledger_entries e1
  WHERE e1.source_module = 'AGENT_TRANSFER_SOLD' AND e1.source_id = ? AND e1.account = 'ACCOUNTS_RECEIVABLE' AND e1.reverses_entry_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM ledger_entries e2 WHERE e2.reverses_entry_id = e1.id)`, [tid]);
let kx = 600;
const kid = (): string => String(++kx);
async function anlegen(db: Db, pid: string, extra: Record<string, unknown> = {}): Promise<string> {
  const o = await fern(() => cmd.runTransferCreate(deps(db), identity(kid(), 'transfers.create'),
    { customerId: 'cust-1', productId: pid, agentPrice: 900, settlementModel: 'split', excessSplitPct: 60, ...extra }));
  if (!o.ok) throw new Error('setup create: ' + o.code);
  reload();
  return String(o.value?.transferId);
}
async function verkaufen(db: Db, tid: string, preis = 1000): Promise<void> {
  const o = await fern(() => fin.runMarkSold(deps(db), identity(kid(), 'transfers.mark_sold'), { transferId: tid, salePrice: preis, expectedRevision: trev(db, tid) }));
  if (!o.ok) throw new Error('setup sold: ' + o.code);
  reload();
}
const bearbeiten = (weg: 'primary' | 'fern', db: Db, tid: string, patch: Record<string, unknown>) => (weg === 'primary'
  ? primary(() => house.editTransferOnPrimary(tid, rules.transferEditPatch(patch as never), trev(db, tid)))
  : fern(() => cmd.runTransferUpdate(deps(db), identity(kid(), 'transfers.update'), { id: tid, expectedRevision: trev(db, tid), ...patch })));

// ── K1 Bearbeiten vor dem Verkauf: Preis, Modell, Anteil, Kunde, Datum, Mitarbeiter, Notiz — Primary == PC2 ──
{
  const bilder: Record<string, unknown>[] = [];
  for (const weg of ['primary', 'fern'] as const) {
    const db = freshDb();
    const tid = await anlegen(db, 'p1');
    const aus = await bearbeiten(weg, db, tid, { agentPrice: 950, settlementModel: 'split', excessSplitPct: 40, customerId: 'cust-2',
      transferredAt: '2026-11-01', staffId: 'emp-1', notes: 'corrected', returnBy: '2026-12-01' });
    reload();
    const r = row(db, `SELECT t.agent_price, t.settlement_model, t.excess_split_pct, t.staff_id, substr(t.transferred_at, 1, 10) AS tag, t.notes, t.return_by,
        t.status, a.customer_id FROM agent_transfers t JOIN agents a ON a.id = t.agent_id WHERE t.id = ?`, [tid]);
    ok(aus.ok && Number(r.agent_price) === 950 && Number(r.excess_split_pct) === 40 && r.customer_id === 'cust-2' && r.tag === '2026-11-01'
      && r.staff_id === 'emp-1' && r.notes === 'corrected' && r.return_by === '2026-12-01' && r.status === 'transferred',
      `K1 ${weg}: alle Felder geändert, Kunde → cust-2 (${aus.code || 'ok'}; ${S(r)})`);
    ok(/agent_transfers/.test(all(db, "SELECT entity_type FROM audit_log WHERE entity_id = ? AND action_type = 'UPDATE'", [tid])),
      `K1 ${weg}: Änderung im Protokoll`);
    ok(n(db, 'SELECT COUNT(*) FROM ledger_entries') === 0, `K1 ${weg}: vor dem Verkauf keine Buchung`);
    bilder.push(r);
  }
  ok(S(bilder[0]) === S(bilder[1]), 'K1 PARITÄT Primary == PC2');
  // Wechsel auf Full: der Anteil fällt weg.
  const db = freshDb();
  const tid = await anlegen(db, 'p2');
  await bearbeiten('fern', db, tid, { settlementModel: 'full' });
  ok(s(db, 'SELECT settlement_model FROM agent_transfers WHERE id = ?', [tid]) === 'full'
    && one(db, 'SELECT excess_split_pct FROM agent_transfers WHERE id = ?', [tid]) === null, 'K1 Split → Full: kein Anteil mehr');
}

// ── K2 Bearbeiten nach dem Verkauf (ohne Rechnung, ohne Zahlung): Abrechnung neu, Forderung am Verkaufstag umgebucht ──
{
  const bilder: string[] = [];
  for (const weg of ['primary', 'fern'] as const) {
    const db = freshDb();
    const tid = await anlegen(db, 'p1');
    await verkaufen(db, tid, 1000);                // split 60 %: 900 + 60 % von 100 = 960
    const tag0 = s(db, "SELECT substr(occurred_at, 1, 10) FROM ledger_entries WHERE source_module = 'AGENT_TRANSFER_SOLD' AND source_id = ? LIMIT 1", [tid]);
    const cogs0 = konto(db, 'COGS');
    ok(Number(one(db, 'SELECT settlement_amount FROM agent_transfers WHERE id = ?', [tid])) === 960 && konto(db, 'ACCOUNTS_RECEIVABLE') === 960,
      `K2 ${weg}: Verkauf 1000 → Abrechnung 960, Forderung 960`);
    const a = await bearbeiten(weg, db, tid, { agentPrice: 800 });   // 800 + 60 % von 200 = 920
    reload();
    ok(a.ok && Number(one(db, 'SELECT settlement_amount FROM agent_transfers WHERE id = ?', [tid])) === 920
      && konto(db, 'ACCOUNTS_RECEIVABLE') === 920 && konto(db, 'REVENUE') === -920 && konto(db, 'COGS') === cogs0 && ausgeglichen(db),
      `K2 ${weg}: Preis 800 → Abrechnung 920; Forderung/Erlös 920, Wareneinsatz unverändert, ausgeglichen (${a.code || 'ok'})`);
    ok(lebendAR(db, tid) === S([[920, tag0, 'cust-1']]), `K2 ${weg}: lebende Forderung 920 am Verkaufstag, Kunde unverändert (${lebendAR(db, tid)})`);
    const b = await bearbeiten(weg, db, tid, { settlementModel: 'full' });   // full: wir bekommen den Verkaufspreis 1000
    reload();
    ok(b.ok && konto(db, 'ACCOUNTS_RECEIVABLE') === 1000 && ausgeglichen(db), `K2 ${weg}: → Full, Forderung 1000 (${b.code || 'ok'})`);
    const c = await bearbeiten(weg, db, tid, { settlementModel: 'split', excessSplitPct: 50, agentPrice: 1100 });
    ok(!c.ok && c.code === 'TRANSFER_BELOW_PRICE' && konto(db, 'ACCOUNTS_RECEIVABLE') === 1000,
      `K2 ${weg}: Verkauf unter neuem Our Price ohne Bestätigung: Nein, nichts gebucht (${c.code})`);
    const d = await bearbeiten(weg, db, tid, { settlementModel: 'split', excessSplitPct: 50, agentPrice: 1100, acknowledgeBelowPrice: true });
    reload();
    ok(d.ok && konto(db, 'ACCOUNTS_RECEIVABLE') === 1000 && Number(one(db, 'SELECT agent_price FROM agent_transfers WHERE id = ?', [tid])) === 1100,
      `K2 ${weg}: mit Bestätigung: Our Price 1100, wir bekommen den Verkaufspreis 1000 (${d.code || 'ok'})`);
    const e = await bearbeiten(weg, db, tid, { customerId: 'cust-2' });
    ok(!e.ok && e.code === 'TRANSFER_CLIENT_FIXED', `K2 ${weg}: Kunde nach dem Verkauf: Nein (${e.code})`);
    const f = await bearbeiten(weg, db, tid, { notes: 'after sale' });
    ok(f.ok, `K2 ${weg}: Notiz nach dem Verkauf geht (${f.code || 'ok'})`);
    bilder.push(S([konto(db, 'ACCOUNTS_RECEIVABLE'), konto(db, 'REVENUE'), konto(db, 'COGS'), konto(db, 'INVENTORY'),
      row(db, 'SELECT agent_price, settlement_model, excess_split_pct, settlement_amount, status FROM agent_transfers WHERE id = ?', [tid])]));
  }
  ok(bilder[0] === bilder[1], `K2 PARITÄT Primary == PC2 (${bilder[0]})`);
}

// ── K3 Sperren: Abrechnungszahlung, Rechnung — Preis/Modell nicht mehr; nichts geändert ──
{
  const db = freshDb();
  const tid = await anlegen(db, 'p1');
  await verkaufen(db, tid, 1000);
  const pay = await fern(() => fin.runMarkSettled(deps(db), identity(kid(), 'transfers.mark_settled'), { transferId: tid, amount: 100, method: 'cash', expectedRevision: trev(db, tid) }));
  reload();
  const vor = buchungen(db);
  const a = await bearbeiten('fern', db, tid, { agentPrice: 700 });
  const ap = await bearbeiten('primary', db, tid, { agentPrice: 700 });
  ok(pay.ok && a.code === 'TRANSFER_SETTLEMENT_RECORDED' && ap.code === 'TRANSFER_SETTLEMENT_RECORDED' && buchungen(db) === vor,
    `K3 nach Abrechnungszahlung: Preis gesperrt (PC2 und Primary), nichts gebucht (${a.code}/${ap.code})`);
  const tid2 = await anlegen(db, 'p2');
  await verkaufen(db, tid2, 1000);
  const conv = await fern(() => life.runConvertTransfer(deps(db), identity(kid(), 'transfers.convert_to_invoice'),
    rules.transferConvertBody({ id: tid2, revision: trev(db, tid2) }, { customerId: 'cust-1' })));
  reload();
  const vor2 = buchungen(db);
  const b = await bearbeiten('fern', db, tid2, { settlementModel: 'full' });
  ok(conv.ok && b.code === 'TRANSFER_INVOICED' && buchungen(db) === vor2, `K3 nach der Rechnung: Modell gesperrt (${b.code})`);
}

// ── K4 Entfernen ohne Buchung: gelöscht, Stück im Lager, Nummer nicht wieder vergeben, Protokoll mit Grund ──
{
  const db = freshDb();
  const tid = await anlegen(db, 'p1');
  const nr = s(db, 'SELECT transfer_number FROM agent_transfers WHERE id = ?', [tid]);
  const z = zaehler(db);
  const ohneGrund = await primary(() => house.removeTransferOnPrimary(tid, '', trev(db, tid)));
  ok(ohneGrund.code === 'REASON_REQUIRED' && n(db, 'SELECT COUNT(*) FROM agent_transfers') === 1, 'K4 ohne Grund: Nein');
  const r = await primary(() => house.removeTransferOnPrimary(tid, 'wrong item selected', trev(db, tid)));
  reload();
  ok(r.ok && r.value?.kind === 'deleted' && n(db, 'SELECT COUNT(*) FROM agent_transfers WHERE id = ?', [tid]) === 0
    && s(db, "SELECT stock_status || '/' || source_type || '/' || quantity FROM products WHERE id = 'p1'") === 'in_stock/OWN/1',
    `K4 gelöscht, Stück wieder im Lager (${s(db, "SELECT stock_status || '/' || source_type FROM products WHERE id = 'p1'")})`);
  ok(/wrong item selected/.test(all(db, "SELECT old_value FROM audit_log WHERE entity_id = ? AND action_type = 'DELETE'", [tid])), 'K4 Protokoll mit Grund');
  const neu = await anlegen(db, 'p1');
  const nr2 = s(db, 'SELECT transfer_number FROM agent_transfers WHERE id = ?', [neu]);
  ok(zaehler(db) === z + 1 && nr2 !== nr, `K4 die Nummer wird nicht wieder vergeben (${nr} → neu ${nr2})`);
}

// ── K5 Entfernen nach dem Verkauf: Storno mit Gegenbuchung, Stück zurück, Transfer bleibt „cancelled"; Rest der Übergabe unberührt ──
{
  const db = freshDb();
  const b = await primary(() => house.createTransfersOnPrimary({ customerId: 'cust-1', settlementModel: 'full',
    items: [{ productId: 'p3', ourPrice: 500 }, { productId: 'p4', ourPrice: 600 }] }));
  const ids = (b.value as unknown as Array<{ id: string; productId: string }>) ?? [];
  const t3 = ids.find((x) => x.productId === 'p3')!.id, t4 = ids.find((x) => x.productId === 'p4')!.id;
  await verkaufen(db, t3, 700);
  const vor4 = S(row(db, 'SELECT * FROM agent_transfers WHERE id = ?', [t4]));
  const vorStueck = s(db, "SELECT stock_status || '/' || quantity FROM products WHERE id = 'p3'");
  const lotVor = n(db, "SELECT qty_remaining FROM stock_lots WHERE product_id = 'p3'");
  const r = await primary(() => house.removeTransferOnPrimary(t3, 'sold the wrong piece', trev(db, t3)));
  reload();
  ok(r.ok && r.value?.kind === 'cancelled' && s(db, 'SELECT status FROM agent_transfers WHERE id = ?', [t3]) === 'cancelled',
    `K5 storniert, Transfer bleibt als „cancelled" (${r.code || r.value?.kind})`);
  ok(konto(db, 'ACCOUNTS_RECEIVABLE') === 0 && konto(db, 'REVENUE') === 0 && konto(db, 'COGS') === 0 && ausgeglichen(db)
    && n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'AGENT_TRANSFER_SOLD' AND source_id = ? AND reverses_entry_id IS NOT NULL", [t3]) > 0,
    `K5 Gegenbuchung: Forderung, Erlös, Wareneinsatz zurück auf 0, ausgeglichen (${buchungen(db)})`);
  ok(vorStueck === 'sold/0' && s(db, "SELECT stock_status || '/' || quantity FROM products WHERE id = 'p3'") === 'in_stock/1'
    && n(db, "SELECT qty_remaining FROM stock_lots WHERE product_id = 'p3'") === lotVor + 1,
    `K5 Stück wieder im Lager, Los +1 (${vorStueck} → ${s(db, "SELECT stock_status || '/' || quantity FROM products WHERE id = 'p3'")})`);
  ok(S(row(db, 'SELECT * FROM agent_transfers WHERE id = ?', [t4])) === vor4, 'K5 der andere Transfer derselben Übergabe ist unverändert');
  const nochmal = await primary(() => house.removeTransferOnPrimary(t3, 'again', trev(db, t3)));
  const vorB = buchungen(db);
  ok(nochmal.code === 'TRANSFER_ALREADY_CANCELLED' && buchungen(db) === vorB, 'K5 zweites Entfernen: Nein, keine zweite Gegenbuchung');
  ok(/sold the wrong piece/.test(all(db, "SELECT new_value FROM audit_log WHERE entity_id = ? AND field_name = 'status'", [t3])), 'K5 Protokoll mit Grund');
}

// ── K6 Entfernen gesperrt: Abrechnungszahlung, Rechnung — Nein mit Korrekturweg, nichts geändert ──
{
  const db = freshDb();
  const t1 = await anlegen(db, 'p1');
  await verkaufen(db, t1, 1000);
  await fern(() => fin.runMarkSettled(deps(db), identity(kid(), 'transfers.mark_settled'), { transferId: t1, amount: 100, method: 'cash', expectedRevision: trev(db, t1) }));
  reload();
  const vor = buchungen(db) + s(db, "SELECT stock_status FROM products WHERE id = 'p1'");
  const a = await primary(() => house.removeTransferOnPrimary(t1, 'test', trev(db, t1)));
  let msg = ''; try { await house.removeTransferOnPrimary(t1, 'test', trev(db, t1)); } catch (e) { msg = String((e as Error).message); }
  ok(a.code === 'TRANSFER_SETTLEMENT_RECORDED' && /credit note/.test(msg) && buchungen(db) + s(db, "SELECT stock_status FROM products WHERE id = 'p1'") === vor,
    `K6 mit Zahlung: Nein mit Korrekturweg, nichts geändert (${a.code})`);
  const t2 = await anlegen(db, 'p2');
  await verkaufen(db, t2, 1000);
  await fern(() => life.runConvertTransfer(deps(db), identity(kid(), 'transfers.convert_to_invoice'),
    rules.transferConvertBody({ id: t2, revision: trev(db, t2) }, { customerId: 'cust-1' })));
  reload();
  const b = await primary(() => house.removeTransferOnPrimary(t2, 'test', trev(db, t2)));
  ok(b.code === 'TRANSFER_INVOICED' && n(db, 'SELECT COUNT(*) FROM agent_transfers WHERE id = ?', [t2]) === 1, `K6 mit Rechnung: Nein (${b.code})`);
}

// ── K7 Alter PC2-Rumpf (Preis, Rückgabe, Notiz unverändert mitgeschickt) an einem verkauften Transfer: kein Nein, keine Buchung ──
{
  const db = freshDb();
  const tid = await anlegen(db, 'p1', { returnBy: '2026-12-01' });
  await verkaufen(db, tid, 1000);
  const vor = buchungen(db);
  const a = await fern(() => cmd.runTransferUpdate(deps(db), identity(kid(), 'transfers.update'),
    { id: tid, expectedRevision: trev(db, tid), agentPrice: 900, returnBy: '2026-12-01', notes: 'old client note' }));
  ok(a.ok && buchungen(db) === vor && s(db, 'SELECT notes FROM agent_transfers WHERE id = ?', [tid]) === 'old client note',
    `K7 alter Rumpf: nur die Notiz ändert sich, keine Buchung (${a.code || 'ok'})`);
}

// ── K8 Geschlossene Periode (Owner 14.11.2026, Nachprüfung): Umbuchung und Storno eines verkauften Transfers buchen auf die
//    Tage der Verkaufsbuchung — dieselbe Regel wie jede periodengerechte Korrektur (`correctionDateIssue`: Ortstag wie der
//    NBR-Export, Eröffnungsstichtag, eingereichtes/bezahltes Quartal). Hauptbuch und Stück bleiben stimmig. ──
{
  const { setOpeningCutoffForTest } = await import('../../src/core/ledger/correction-dates.ts');
  const tzAlt = process.env.TZ;
  process.env.TZ = 'Asia/Bahrain';
  setOpeningCutoffForTest('2026-01-01');
  try {
    const verkaufAm = (db: Db, tid: string, iso: string): void =>
      db.run("UPDATE ledger_entries SET occurred_at = ? WHERE source_module = 'AGENT_TRANSFER_SOLD' AND source_id = ?", [iso, tid]);
    const zu = (db: Db, jahr: number, q: number): void =>
      insert(db, 'vat_filings', { id: `vf-${jahr}-${q}`, branch_id: 'branch-main', year: jahr, quarter: q, filed_at: NOW, snapshot_json: '{}', created_at: NOW });
    const stand = (db: Db, tid: string, pid: string): string => buchungen(db) + '|'
      + S(row(db, 'SELECT status, agent_price, settlement_amount FROM agent_transfers WHERE id = ?', [tid])) + '|'
      + s(db, "SELECT stock_status || '/' || quantity FROM products WHERE id = ?", [pid]) + '|' + n(db, 'SELECT qty_remaining FROM stock_lots WHERE product_id = ?', [pid]);

    // a) Verkauf im eingereichten Q3/2026: Preis ändern (PC2 und Primary) und Stornieren — Nein, nichts verändert.
    {
      const db = freshDb();
      const tid = await anlegen(db, 'p1');
      await verkaufen(db, tid, 1000);
      verkaufAm(db, tid, '2026-09-15T09:00:00.000Z');
      zu(db, 2026, 3);
      reload();
      const vor = stand(db, tid, 'p1');
      const a = await bearbeiten('fern', db, tid, { agentPrice: 800 });
      const b = await bearbeiten('primary', db, tid, { agentPrice: 800 });
      const c = await primary(() => house.removeTransferOnPrimary(tid, 'wrong piece', trev(db, tid)));
      ok(a.code === 'VAT_PERIOD_FILED' && b.code === 'VAT_PERIOD_FILED' && c.code === 'VAT_PERIOD_FILED' && stand(db, tid, 'p1') === vor,
        `K8a Q3/2026 eingereicht: Preis (PC2/Primary) und Storno abgewiesen, Hauptbuch/Transfer/Stück unverändert (${a.code}/${b.code}/${c.code})`);
      const d = await bearbeiten('fern', db, tid, { notes: 'still allowed' });
      ok(d.ok && stand(db, tid, 'p1') === vor, `K8a eine Notiz bleibt erlaubt, keine Buchung (${d.code || 'ok'})`);
    }
    // b) Quartalsgrenze in Ortszeit: 31.12.2026 22:30 UTC ist der 01.01.2027 in Bahrain (Q1/2027 — eingereicht) ⇒ Nein.
    {
      const db = freshDb();
      const tid = await anlegen(db, 'p1');
      await verkaufen(db, tid, 1000);
      verkaufAm(db, tid, '2026-12-31T22:30:00.000Z');
      zu(db, 2027, 1);
      reload();
      const vor = stand(db, tid, 'p1');
      const a = await bearbeiten('fern', db, tid, { agentPrice: 800 });
      const c = await primary(() => house.removeTransferOnPrimary(tid, 'wrong piece', trev(db, tid)));
      ok(a.code === 'VAT_PERIOD_FILED' && c.code === 'VAT_PERIOD_FILED' && stand(db, tid, 'p1') === vor,
        `K8b Verkauf am 01.01.2027 Ortszeit, Q1/2027 eingereicht: Umbuchung und Storno abgewiesen (${a.code}/${c.code})`);
    }
    // c) …und umgekehrt: 30.09.2026 22:30 UTC ist der 01.10.2026 (Q4, offen), Q3 eingereicht ⇒ erlaubt, Umbuchung am selben Zeitpunkt.
    {
      const db = freshDb();
      const tid = await anlegen(db, 'p1');
      await verkaufen(db, tid, 1000);
      verkaufAm(db, tid, '2026-09-30T22:30:00.000Z');
      zu(db, 2026, 3);
      reload();
      const a = await bearbeiten('fern', db, tid, { agentPrice: 800 });
      reload();
      const tage = all(db, "SELECT DISTINCT occurred_at FROM ledger_entries WHERE source_module = 'AGENT_TRANSFER_SOLD' AND source_id = ?", [tid]);
      ok(a.ok && konto(db, 'ACCOUNTS_RECEIVABLE') === 920 && ausgeglichen(db) && tage === S([['2026-09-30T22:30:00.000Z']]),
        `K8c Verkauf am 01.10.2026 Ortszeit (Q4 offen): umgebucht auf 920, Storno und Neubuchung am selben Zeitpunkt (${a.code || 'ok'}; ${tage})`);
    }
    // d) Vor dem Eröffnungsstichtag ⇒ Nein (dieselbe Kennung wie jede Korrektur).
    {
      const db = freshDb();
      const tid = await anlegen(db, 'p1');
      await verkaufen(db, tid, 1000);
      verkaufAm(db, tid, '2026-03-10T09:00:00.000Z');
      setOpeningCutoffForTest('2026-06-01');
      reload();
      const vor = stand(db, tid, 'p1');
      const c = await primary(() => house.removeTransferOnPrimary(tid, 'wrong piece', trev(db, tid)));
      ok(c.code === 'CORRECTION_BEFORE_OPENING_CUTOFF' && stand(db, tid, 'p1') === vor, `K8d Verkauf vor der Eröffnung: Storno abgewiesen (${c.code})`);
      setOpeningCutoffForTest('2026-01-01');
    }
    // e) Offene Periode: erst umbuchen, dann stornieren ⇒ Hauptbuch netto 0 und ausgeglichen, Stück und Los zurück.
    {
      const db = freshDb();
      const tid = await anlegen(db, 'p1');
      await verkaufen(db, tid, 1000);
      const lot0 = n(db, "SELECT qty_remaining FROM stock_lots WHERE product_id = 'p1'");
      const a = await bearbeiten('fern', db, tid, { agentPrice: 800 });
      reload();
      ok(a.ok && s(db, "SELECT stock_status || '/' || quantity FROM products WHERE id = 'p1'") === 'sold/0'
        && n(db, "SELECT qty_remaining FROM stock_lots WHERE product_id = 'p1'") === lot0,
        `K8e die Umbuchung lässt das verkaufte Stück unverändert (${a.code || 'ok'})`);
      const c = await primary(() => house.removeTransferOnPrimary(tid, 'wrong piece', trev(db, tid)));
      reload();
      ok(c.ok && c.value?.kind === 'cancelled' && konto(db, 'ACCOUNTS_RECEIVABLE') === 0 && konto(db, 'REVENUE') === 0 && konto(db, 'COGS') === 0
        && konto(db, 'INVENTORY') === n(db, "SELECT ROUND(COALESCE(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END), 0), 3) FROM ledger_entries WHERE account = 'INVENTORY' AND source_module != 'AGENT_TRANSFER_SOLD'")
        && ausgeglichen(db) && lebendAR(db, tid) === '[]'
        && s(db, "SELECT stock_status || '/' || quantity FROM products WHERE id = 'p1'") === 'in_stock/1'
        && n(db, "SELECT qty_remaining FROM stock_lots WHERE product_id = 'p1'") === lot0 + 1,
        `K8e umgebucht und dann storniert: Forderung/Erlös/Wareneinsatz 0, ausgeglichen, Stück und Los zurück (${c.code || c.value?.kind}; ${buchungen(db)})`);
    }
  } finally {
    setOpeningCutoffForTest(null);
    if (tzAlt === undefined) delete process.env.TZ; else process.env.TZ = tzAlt;
  }
}

console.log(`\ntransfer-correction: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('TRANSFER_CORRECTION_PROVED');
