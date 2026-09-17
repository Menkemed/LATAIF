// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6C FINAL GATE — Registry-Diff, Stammdaten-Autorität, Inventur-Vertrag, Durabilität,
// R6A-Abschluss. Run: node test/r6c/final-gate.test.ts
//
//   §1 Registry 108 → 121: genau 11 Buchungen + 2 Auskünfte gegen den Stand VOR R6C (`5fc7bb2`), TS == Rust,
//      Rechte, Idempotenz/Fassung, unbekannte Namen weiter fail-closed
//   §2 Stammdaten: der Primary entscheidet (Filiale, Kennung, Summen, Pflichtnamen, Anteil, Gehalt, Status)
//   §3 Inventur-Vertrag: was eine Inventur erfasst — und was sie ausdrücklich NICHT erzeugt
//   §4 Inventur: Fehler und Durabilität
//   §5 R6A-Abschluss 95 / 16 / 16 / 79
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    if (specifier === '@/core/db/database') {
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

const store = new Map<string, string>([['lataif_session', JSON.stringify({ branchId: 'branch-main', userId: 'user-test' })]]);
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
const { COMMAND_LEDGER_DDL, COMMAND_LEDGER_INDEX } = await import('../../src/core/bridge/command-ledger.ts');
const { resetDurabilityStateForTest } = await import('../../src/core/bridge/durability-state.ts');
const { resetTransactionHealthForTest } = await import('../../src/core/db/transaction-health.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const registry = await import('../../src/core/bridge/command-registry.ts');
for (const m of ['read-commands', 'invoice-command', 'customer-commands', 'product-commands', 'invoice-lifecycle-commands',
  'commercial-commands', 'service-commands', 'financial-commands', 'return-commands', 'invoice-cancel-command',
  'lifecycle-commands', 'masterdata-commands', 'inventory-commands', 'store-read-commands',
  'money-commands', 'payables-commands', 'gold-commands', 'metal-commands',
  'offer-commands', 'invoice-flag-commands', 'sales-reversal-commands', 'message-commands',
  'purchase-lifecycle-commands', 'order-lifecycle-commands', 'consignment-lifecycle-commands', 'production-commands', 'office-commands']) {
  await import(`../../src/core/bridge/${m}.ts`);
}
const perms = await import('../../src/core/bridge/command-permissions.ts');
const readOps = await import('../../src/core/bridge/store-read-ops.ts');
const md = await import('../../src/core/bridge/masterdata-commands.ts');
const inv = await import('../../src/core/bridge/inventory-commands.ts');
const rules = await import('../../src/core/masterdata/masterdata-rules.ts');
const session = await import('../../src/core/stock/inventory-session.ts');
const house = await import('../../src/core/stock/inventory-house.ts');
const stockCheck = await import('../../src/core/stock/stock-check.ts');
const { runSharedWrite } = await import('../../src/core/data/shared-write.ts');
const { useSupplierStore } = await import('../../src/stores/supplierStore.ts');
const { usePartnerStore } = await import('../../src/stores/partnerStore.ts');
const { useEmployeeStore } = await import('../../src/stores/employeeStore.ts');
const { useAgentStore } = await import('../../src/stores/agentStore.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const marker = (m: string): void => { if (fails.length === 0) console.log(m); };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const vor = (p: string): string => execFileSync('git', ['show', `5fc7bb2:${p}`], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const codeOf = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const S = (v: unknown): string => JSON.stringify(v);
const NOW = '2026-09-13T10:00:00.000Z';
let T = Date.parse(NOW);
const tick = (): string => { T += 1000; return new Date(T).toISOString(); };

interface Db { run(sql: string, p?: unknown[]): unknown; exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>; export(): Uint8Array }
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const rows = (db: Db, sql: string, p: unknown[] = []): Array<Record<string, unknown>> => {
  const r = db.exec(sql, p)[0];
  return r ? r.values.map((v) => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))) : [];
};
const MIGRATIONS = (() => {
  const d = src('src/core/db/database.ts');
  const a = d.indexOf('const migrations: string[] = [');
  return [...d.slice(a, d.indexOf('\n  ];', a)).matchAll(/`([^`]*)`/g)].map((m) => m[1]);
})();
function insert(db: Db, table: string, values: Record<string, unknown>): void {
  const cols = rows(db, `PRAGMA table_info(${table})`);
  const data: Record<string, unknown> = { ...values };
  for (const c of cols) {
    const name = String(c.name);
    if (!c.notnull || c.dflt_value !== null || c.pk || data[name] !== undefined) continue;
    data[name] = /INT|REAL|NUM/.test(String(c.type || '').toUpperCase()) ? 0 : (/_at$|date/i.test(name) ? NOW : '');
  }
  const use = Object.keys(data).filter((k) => cols.some((c) => c.name === k));
  db.run(`INSERT INTO ${table} (${use.join(', ')}) VALUES (${use.map(() => '?').join(', ')})`, use.map((k) => data[k]));
}
function freshDb(): Db {
  const db = new SQL.Database() as unknown as Db;
  db.run(src('src/core/db/schema.sql'));
  for (const s of MIGRATIONS) { try { db.run(s); } catch { /* da */ } }
  for (const s of A1_UPGRADE_SQL) { try { db.run(s); } catch { /* da */ } }
  db.run(COMMAND_LEDGER_DDL); db.run(COMMAND_LEDGER_INDEX);
  db.run(session.INVENTORY_SESSION_DDL); db.run(session.INVENTORY_SESSION_ITEMS_DDL); db.run(session.INVENTORY_BOOTSTRAP_DDL);
  for (const b of ['branch-main', 'branch-other']) db.run('INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES (?,?,?,?,?)', [b, 'tenant-1', b, NOW, NOW]);
  insert(db, 'categories', { id: 'cat', branch_id: 'branch-main', name: 'Cat', icon: 'Watch', color: '#000', attributes: '[]', scope_options: '[]', condition_options: '[]', active: 1, sort_order: 1, created_at: NOW, updated_at: NOW });
  for (const [id, b] of [['p1', 'branch-main'], ['p2', 'branch-main'], ['p3', 'branch-main'], ['px', 'branch-other']]) {
    insert(db, 'products', { id, branch_id: b, category_id: 'cat', brand: 'B', name: id, sku: id, condition: 'New', scope_of_delivery: '[]', purchase_price: 100, purchase_currency: 'BHD', planned_sale_price: 200, tax_scheme: 'MARGIN', stock_status: 'in_stock', quantity: 1, images: '[]', attributes: '{}', source_type: 'OWN', created_at: NOW, updated_at: NOW });
  }
  setTestDatabase(db as never); resetDurabilityStateForTest(); resetTransactionHealthForTest();
  return db;
}
let seq = 0;
const nextId = (): string => `${String(++seq).padStart(8, '0')}-0000-4000-8000-000000000000`;
const identity = (commandId: string, op: string, branchId = 'branch-main') => ({ commandId, tenantId: 'tenant-1', branchId, userId: 'user-test', role: 'ADMIN', op, payloadHash: 'h' });
function deps(db: Db, st = { failSave: false }) {
  return { db: db as never, begin: posting.beginLedgerTransaction, commit: posting.commitLedgerTransaction, rollback: posting.rollbackLedgerTransaction,
    durableSave: async () => { if (st.failSave) throw new Error('disk full'); }, now: () => tick() };
}
async function fern(fn: () => Promise<{ kind: string; value?: unknown; replayed?: boolean; code?: string; frozen?: boolean }>) {
  try {
    const o = await fn();
    return o.kind === 'ok' ? { kind: 'ok', value: o.value as Record<string, unknown>, replayed: o.replayed === true, code: '' }
      : { kind: 'rejected', code: String(o.code), value: {} as Record<string, unknown>, replayed: false };
  } catch (e) { return { kind: 'thrown', code: String((e as { code?: unknown }).code ?? (e as Error).message), msg: String((e as Error).message), value: {} as Record<string, unknown>, replayed: false }; }
}
const wirft = (fn: () => unknown): string => { try { fn(); return ''; } catch (e) { return String((e as { code?: unknown }).code ?? (e as Error).message); } };
const meldung = (fn: () => unknown): string => { try { fn(); return ''; } catch (e) { return String((e as Error).message); } };
function fakeCore() {
  const r: Array<Record<string, unknown>> = [];
  let calls = 0;
  return {
    rows: r, get calls() { return calls; },
    async latest(ids: readonly string[]) { const o: Record<string, unknown> = {}; for (const id of ids) { const m = r.filter((x) => x.product_id === id); if (m.length) o[id] = m[m.length - 1]; } return o as never; },
    async record(p: { productId: string; status: string; notes: string | null; userId?: string; requestId: string }) {
      calls += 1;
      const seen = r.find((x) => x.request_id === p.requestId);
      if (seen) return seen as never;
      const row = { check_id: 'c' + (r.length + 1), product_id: p.productId, status: p.status, notes: p.notes, checked_at: tick(), checked_by: p.userId ?? null, checked_by_name: null, source: 'desktop', request_id: p.requestId };
      r.push(row);
      return row as never;
    },
  };
}

const R6C_MUT = ['suppliers.create', 'suppliers.update', 'agents.update', 'partners.create', 'partners.update', 'employees.create', 'employees.update',
  'inventory.start', 'inventory.save', 'inventory.finish', 'inventory.record_check'];
const R6C_READ = ['inventory.session.get', 'inventory.checks.get'];
// R6D — seither achtundzwanzig Buchungen und drei Auskünfte, alle HINTER den R6C-Namen (eigenes Gate: test/r6d).
const R6D_MUT = ['tax.record_payment', 'banking.transfer', 'partners.record_tx', 'debts.create', 'debts.update', 'debts.record_payment', 'expenses.create', 'expenses.update', 'expenses.record_payment', 'expenses.template_create', 'expenses.template_update', 'purchases.record_payment', 'purchases.apply_credit', 'suppliers.pay', 'suppliers.apply_credit', 'suppliers.refund_credit', 'gold.payables.settle', 'gold.customer_credits.settle', 'repairs.record_gold_usage', 'repairs.add_material', 'orders.add_cost', 'orders.remove_cost', 'metals.create', 'metals.update_status', 'metals.set_spot_price', 'scrap_trades.create', 'scrap_trades.update', 'scrap_trades.cancel'];
const R6D_READ = ['metals.spot_prices.get', 'debts.payments.get', 'suppliers.credits.get'];
// R6E — seither acht Buchungen, keine Auskunft, alle HINTER den R6D-Namen (eigenes Gate: test/r6e).
const R6E_MUT = ['offers.create', 'offers.update', 'offers.set_status', 'offers.convert_to_invoice', 'invoices.set_butterfly', 'returns.cancel', 'transfers.undo_convert', 'customers.log_message'];
// R6F — seither vierzehn Buchungen, keine Auskunft, alle HINTER den R6E-Namen (eigenes Gate: test/r6f).
const R6F_MUT = ['purchases.return_to_supplier', 'purchases.cancel', 'purchases.dismiss_inbox', 'orders.cancel', 'orders.update_line_status', 'orders.mark_line_ordered', 'orders.update_line', 'consignments.return_after_sale', 'consignments.cancel_sale', 'production.create', 'tasks.create', 'tasks.update', 'documents.upload', 'documents.set_ocr'];
// POST-PARITY R7A (PP-2) — seither eine weitere Buchung HINTER den R6F-Namen: der Fertigungsabschluss.
const R7A_MUT = ['production.complete'];

// ══ §1 — Registry 108 → 121 ══════════════════════════════════════════════════
{
  const list = (t: string): string[] => [...(/export const ALLOWED_MUTATIONS: readonly string\[\] = \[([\s\S]*?)\];/.exec(t)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const vorher = list(vor('src/core/bridge/command-registry.ts'));
  const jetzt = [...registry.ALLOWED_MUTATIONS];
  ok(vorher.length === 41 && S(jetzt.filter((o) => !vorher.includes(o))) === S([...R6C_MUT, ...R6D_MUT, ...R6E_MUT, ...R6F_MUT, ...R7A_MUT]) && vorher.every((o) => jetzt.includes(o)) && jetzt.length === 103,
    `REGISTRY Buchungen 41 → 52 (R6C) → 80 (R6D) → 88 (R6E) → 102 (R6F) → 103 (R7A): GENAU die elf R6C-, achtundzwanzig R6D-, acht R6E- und vierzehn R6F-Namen + eins aus R7A (production.complete), keine fällt weg (${jetzt.filter((o) => !vorher.includes(o)).join(',')})`);
  const catalogue = (t: string): string[] => [...t.matchAll(/^export const OP_[A-Z_]+ = '([^']+)'/gm)].map((m) => m[1]);
  const readsVor = catalogue(vor('src/core/bridge/store-read-ops.ts'));
  const readsJetzt = [...readOps.STORE_READ_OPS];
  ok(S(readsJetzt.filter((o) => !readsVor.includes(o))) === S([...R6C_READ, ...R6D_READ]) && readsJetzt.length === readsVor.length + 5,
    `REGISTRY Auskünfte: GENAU die zwei R6C- und die drei R6D-Namen (${readsJetzt.filter((o) => !readsVor.includes(o)).join(',')})`);
  const rustOps = (t: string): string[] => {
    const l = /pub const REMOTE_OPS: &\[&str\] = &\[([\s\S]*?)\];/.exec(t)?.[1] ?? '';
    return (l.match(/OP_[A-Z_]+/g) ?? []).map((c) => new RegExp(`pub const ${c}: &str = "([^"]+)"`).exec(t)?.[1] ?? c);
  };
  const rVor = rustOps(vor('src-tauri/src/bridge.rs'));
  const rJetzt = rustOps(src('src-tauri/src/bridge.rs'));
  ok(rVor.length === 108 && rJetzt.length === 176 && S(rJetzt.filter((o) => !rVor.includes(o))) === S([...R6C_MUT, ...R6C_READ, ...R6D_MUT, ...R6D_READ, ...R6E_MUT, ...R6F_MUT, ...R7A_MUT, 'products.duplicates.get']),
    `REGISTRY Rust 108 → 121 (R6C) → 152 (R6D) → 160 (R6E) → 174 (R6F) → 175 (R7A) → 176 (PRE-G5): GENAU diese dreizehn, einunddreißig, acht und vierzehn + eins aus R7A (production.complete), in dieser Reihenfolge (${rJetzt.filter((o) => !rVor.includes(o)).join(',')})`);
  const known = registry.knownCommands();
  ok(known.length === 176 && S([...known].sort()) === S([...rJetzt].sort()), `REGISTRY der Renderer registriert GENAU die 176 Namen (PRE-G5), die Rust durchlässt (${known.length})`);
  for (const op of [...R6C_MUT, ...R6C_READ]) {
    const isMut = R6C_MUT.includes(op);
    ok(known.includes(op) && rJetzt.includes(op) && (isMut ? registry.ALLOWED_MUTATIONS.includes(op) : readOps.STORE_READ_OPS.includes(op))
      && (isMut ? op in perms.OPERATION_PERMISSIONS && perms.OPERATION_PERMISSIONS[op] === null : op in perms.READ_PERMISSIONS && perms.READ_PERMISSIONS[op] === null),
    `REGISTRY ${op}: TS registriert, Rust lässt durch, Recht wie am Primary (kein Tor)`);
  }
  // Idempotenz: jede neue Buchung läuft durch die C3A-Maschine (durabler Nachweis); Speichern/Abschließen verlangen die Fassung.
  const mdSrc = codeOf(src('src/core/bridge/masterdata-commands.ts'));
  const invSrc = codeOf(src('src/core/bridge/inventory-commands.ts'));
  for (const fn of ['runSupplierCreate', 'runSupplierUpdate', 'runEmployeeCreate', 'runEmployeeUpdate', 'runPartnerCreate', 'runPartnerUpdate', 'runAgentUpdate']) {
    const b = mdSrc.slice(mdSrc.indexOf(`export async function ${fn}`) >= 0 ? mdSrc.indexOf(`export async function ${fn}`) : mdSrc.indexOf(`export function ${fn}`));
    ok(/runRemoteCommand\(deps, identity,/.test(b.slice(0, 900)), `IDEMPOTENT ${fn} läuft durch runRemoteCommand (Kennung, durabler Nachweis)`);
  }
  for (const fn of ['runInventoryStart', 'runInventorySave', 'runInventoryFinish', 'runInventoryRecordCheck']) {
    const b = invSrc.slice(invSrc.indexOf(`export function ${fn}`));
    ok(/runRemoteCommand\(deps, identity,/.test(b.slice(0, 700)), `IDEMPOTENT ${fn} läuft durch runRemoteCommand`);
  }
  ok(wirft(() => inv.parseInventorySave({ sessionId: 's', items: [], visibleProductIds: [] })) !== '' && wirft(() => inv.parseInventoryFinish({ sessionId: 's' })) !== '',
    'REVISION inventory.save und inventory.finish verlangen die gesehene Fassung');
  ok(/requestIdFor: \(productId\) => `\$\{identity\.commandId\}:\$\{productId\}`/.test(invSrc) && /requestId: identity\.commandId/.test(invSrc),
    'IDEMPOTENT die Beobachtungen im Kern tragen die Auftragskennung (Wiederholung → dieselbe Zeile)');
  // Unbekanntes bleibt fail-closed.
  const r = await registry.executeCommand('inventory.adjust', {}, identity(nextId(), 'inventory.adjust') as never);
  ok(r.kind === 'infrastructure_error' && r.code === 'BRIDGE_OP_NOT_REGISTERED', `FAILCLOSED ein unbekannter Name läuft nicht (${S(r)})`);
  // R6D hat `partners.record_tx` und `metals.create` bewusst freigegeben (eigenes Gate: test/r6d) — sie stehen hier nicht mehr.
  // R6F ebenso `tasks.create` (Aufgaben über den Primary, eigenes Gate: test/r6f); `tasks.delete` bleibt draußen.
  for (const op of ['suppliers.delete', 'employees.delete', 'partners.delete_tx', 'inventory.adjust', 'inventory.reset', 'metals.delete', 'tasks.delete']) {
    let t = ''; try { registry.registerCommand(op, { kind: 'mutation', handler: () => ({}) }); } catch (e) { t = String(e); }
    ok(/refusing to register/.test(t) && !rJetzt.includes(op), `FAILCLOSED ${op} ist weder registrierbar noch in Rust`);
  }
}
marker('CENTRAL_UI_R6C_REGISTRY_121_AUDITED');

// ══ §2 — Stammdaten: der Primary entscheidet ═════════════════════════════════
{
  const db = freshDb();
  const d = deps(db);
  // Summen nie aus einem veralteten Formularstand.
  ok(!(rules.SUPPLIER_UPDATE_FIELDS as readonly string[]).some((f) => /total|balance|outstanding|credit/i.test(f))
    && !(rules.PARTNER_UPDATE_FIELDS as readonly string[]).some((f) => /total|balance/i.test(f))
    && !(rules.AGENT_UPDATE_FIELDS as readonly string[]).some((f) => /total|commission/i.test(f)),
  'AUTH die Feldlisten der Masken enthalten keine Summe, keinen Saldo, keine Provision');
  for (const [parse, k] of [[md.parseSupplierUpdate, 'outstandingBalance'], [md.parseSupplierUpdate, 'totalPurchases'], [md.parsePartnerUpdate, 'balance'],
    [md.parsePartnerUpdate, 'totalInvested'], [md.parseAgentUpdate, 'totalSales'], [md.parseAgentUpdate, 'totalCommission']] as Array<[(r: unknown) => unknown, string]>) {
    ok(/the primary decides/.test(meldung(() => parse({ id: 'x', [k]: 1 }))), `AUTH fern: ${k} gibt der Primary vor`);
  }
  insert(db, 'agents', { id: 'a1', branch_id: 'branch-main', name: 'Ali', commission_rate: 10, active: 1, total_sales: 900, total_commission: 90, created_at: NOW, updated_at: NOW });
  useAgentStore.getState().updateAgent('a1', { name: 'Ali', totalSales: 1, totalCommission: 1 } as never);
  ok(Number(one(db, "SELECT total_sales FROM agents WHERE id='a1'")) === 900 && Number(one(db, "SELECT total_commission FROM agents WHERE id='a1'")) === 90,
    'AUTH am Primary: die Hausfunktion schreibt keine Agenten-Summe aus einem Formular');
  // Filiale und Kennung.
  for (const [run, body, op] of [[md.runSupplierCreate, { name: 'S' }, 'suppliers.create'], [md.runPartnerCreate, { name: 'P' }, 'partners.create'], [md.runEmployeeCreate, { name: 'E' }, 'employees.create']] as Array<[never, Record<string, unknown>, string]>) {
    const f = await fern(() => (run as (a: unknown, b: unknown, c: unknown) => Promise<never>)(d, identity(nextId(), op, 'branch-other'), body));
    ok(f.code === 'BRANCH_MISMATCH', `AUTH ${op}: ein Ausweis einer anderen Filiale legt nichts an`);
    const g = await fern(() => (run as (a: unknown, b: unknown, c: unknown) => Promise<never>)(d, identity(nextId(), op), { ...body, id: 'mine' }));
    ok(g.kind === 'thrown' && g.code === 'MASTERDATA_PAYLOAD_INVALID' && /the primary decides id/.test(String(g.msg)), `AUTH ${op}: die Kennung vergibt der Primary`);
    const h = await fern(() => (run as (a: unknown, b: unknown, c: unknown) => Promise<never>)(d, identity(nextId(), op), { ...body, branchId: 'branch-other' }));
    ok(h.kind === 'thrown' && h.code === 'MASTERDATA_PAYLOAD_INVALID' && /the primary decides branchId/.test(String(h.msg)), `AUTH ${op}: die Filiale nennt kein Rumpf`);
  }
  const made = await fern(() => md.runSupplierCreate(d, identity(nextId(), 'suppliers.create'), { name: 'S' }));
  const sid = String(made.value.supplierId);
  ok(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(sid) && one(db, 'SELECT branch_id FROM suppliers WHERE id = ?', [sid]) === 'branch-main',
    'AUTH Kennung UUID v4 vom Primary, Filiale aus seiner Sitzung');
  insert(db, 'suppliers', { id: 'sx', branch_id: 'branch-other', name: 'X', active: 1, created_at: NOW, updated_at: NOW });
  insert(db, 'partners', { id: 'px', branch_id: 'branch-other', name: 'X', share_percentage: 5, active: 1, created_at: NOW, updated_at: NOW });
  insert(db, 'employees', { id: 'ex', branch_id: 'branch-other', name: 'X', employment_status: 'active', created_at: NOW, updated_at: NOW });
  insert(db, 'agents', { id: 'ax', branch_id: 'branch-other', name: 'X', commission_rate: 10, active: 1, created_at: NOW, updated_at: NOW });
  for (const [run, id, op, code] of [[md.runSupplierUpdate, 'sx', 'suppliers.update', 'SUPPLIER_NOT_FOUND'], [md.runPartnerUpdate, 'px', 'partners.update', 'PARTNER_NOT_FOUND'],
    [md.runEmployeeUpdate, 'ex', 'employees.update', 'EMPLOYEE_NOT_FOUND'], [md.runAgentUpdate, 'ax', 'agents.update', 'AGENT_NOT_FOUND']] as Array<[never, string, string, string]>) {
    const r = await fern(() => (run as (a: unknown, b: unknown, c: unknown) => Promise<never>)(d, identity(nextId(), op), { id, notes: 'n' }));
    ok(r.code === code, `AUTH ${op}: ein Datensatz einer anderen Filiale ist von hier aus nicht vorhanden (${r.code})`);
  }
  // Pflichtnamen — am Primary UND fern, derselbe Code.
  for (const [local, remote, code] of [
    [() => useSupplierStore.getState().createSupplier({ name: ' \t ' }), () => md.parseSupplierCreate({ name: ' \t ' }), rules.SUPPLIER_NAME_REQUIRED],
    [() => usePartnerStore.getState().createPartner({ name: '  ' }), () => md.parsePartnerCreate({ name: '  ' }), rules.PARTNER_NAME_REQUIRED],
    [() => useEmployeeStore.getState().createEmployee({ name: '  ', employmentStatus: 'active' } as never), () => md.parseEmployeeCreate({ name: '  ' }), rules.EMPLOYEE_NAME_REQUIRED],
    [() => useSupplierStore.getState().updateSupplier(sid, { name: '' }), () => md.parseSupplierUpdate({ id: sid, name: '' }), rules.SUPPLIER_NAME_REQUIRED],
    [() => useAgentStore.getState().updateAgent('a1', { name: ' ' }), () => md.parseAgentUpdate({ id: 'a1', name: ' ' }), rules.AGENT_NAME_REQUIRED],
    [() => usePartnerStore.getState().updatePartner('p', { name: '' }), () => md.parsePartnerUpdate({ id: 'p', name: '' }), rules.PARTNER_NAME_REQUIRED],
    [() => useEmployeeStore.getState().updateEmployee('e', { name: ' ' }), () => md.parseEmployeeUpdate({ id: 'e', name: ' ' }), rules.EMPLOYEE_NAME_REQUIRED],
  ] as Array<[() => unknown, () => unknown, string]>) {
    ok(wirft(local) === code && wirft(remote) === code, `AUTH leerer Pflichtname: ${code} am Primary und fern`);
  }
  // Partneranteil: der fachliche Bereich steht am Typ (`sharePercentage: number; // 0–100`).
  ok(/sharePercentage: number;\s*\/\/ 0–100/.test(src('src/core/models/types.ts')), 'AUTH der Bereich des Partneranteils ist der des Modells (0–100)');
  for (const [v, good] of [[0, true], [100, true], [12.5, true], [100.001, false], [-0.001, false], [Number.NaN, false], ['50', false]] as Array<[unknown, boolean]>) {
    ok((wirft(() => rules.partnerCreateInput({ name: 'P', sharePercentage: v })) === '') === good && (wirft(() => md.parsePartnerUpdate({ id: 'p', sharePercentage: v })) === '') === good,
      `AUTH Partneranteil ${String(v)}: ${good ? 'angenommen' : 'abgewiesen'} (Primary und fern)`);
  }
  // Grundgehalt: der kanonische Vertrag — endliche Zahl ≥ 0, keine Obergrenze.
  ok(!('MAX_BASE_SALARY' in rules), 'AUTH keine erfundene Obergrenze für das Grundgehalt');
  for (const [v, good] of [[0, true], [400, true], [1_000_000, true], [1_000_000.01, true], [50_000_000, true], [Number.MAX_SAFE_INTEGER, true],
    [-0.01, false], [-1, false], [Number.POSITIVE_INFINITY, false], [Number.NaN, false], ['400', false]] as Array<[unknown, boolean]>) {
    ok((wirft(() => rules.employeeCreateInput({ name: 'E', baseSalary: v })) === '') === good && (wirft(() => md.parseEmployeeUpdate({ id: 'e', baseSalary: v })) === '') === good,
      `AUTH Grundgehalt ${String(v)}: ${good ? 'angenommen' : 'abgewiesen'} (Primary und fern)`);
  }
  // Status und Aktiv-Schalter: nur gültige Zielwerte; jeder Übergang ist erlaubt wie am Primary.
  for (const bad of ['false', 0, 1, null]) {
    ok(wirft(() => md.parseSupplierUpdate({ id: sid, active: bad })) !== '' && wirft(() => md.parsePartnerUpdate({ id: 'p', active: bad })) !== ''
      && wirft(() => md.parseAgentUpdate({ id: 'a1', active: bad })) !== '', `AUTH active=${S(bad)} ist kein Zielwert — abgewiesen`);
  }
  const e = await fern(() => md.runEmployeeCreate(d, identity(nextId(), 'employees.create'), { name: 'Status' }));
  const eid = String(e.value.employeeId);
  const kette: string[] = [];
  for (const st of ['on_leave', 'inactive', 'active', 'inactive']) {
    await fern(() => md.runEmployeeUpdate(d, identity(nextId(), 'employees.update'), { id: eid, employmentStatus: st }));
    kette.push(String(one(db, 'SELECT employment_status FROM employees WHERE id = ?', [eid])));
  }
  ok(S(kette) === S(['on_leave', 'inactive', 'active', 'inactive']), `AUTH Mitarbeiterstatus: jeder Übergang zwischen den drei Werten, wie am Primary (${S(kette)})`);
  ok((await fern(() => md.runEmployeeUpdate(d, identity(nextId(), 'employees.update'), { id: eid, employmentStatus: 'fired' }))).code === 'EMPLOYEE_STATUS_INVALID', 'AUTH ein vierter Status existiert nicht');
  // Dieselbe Domäne: jede Hausfunktion prüft selbst, jeder Fernbefehl ruft die Hausfunktion.
  for (const [file, fns] of [['src/stores/supplierStore.ts', ['createSupplier: (data) => {', 'updateSupplier: (id, data) => {']], ['src/stores/partnerStore.ts', ['createPartner: (data) => {', 'updatePartner: (id, data) => {']],
    ['src/stores/employeeStore.ts', ['createEmployee: (data) => {', 'updateEmployee: (id, data) => {']], ['src/stores/agentStore.ts', ['updateAgent: (id, data) => {']]] as Array<[string, string[]]>) {
    const c = codeOf(src(file));
    for (const fn of fns) ok(/Input\(/.test(c.slice(c.indexOf(fn), c.indexOf(fn) + 400)), `DOMAIN ${fn.split(':')[0]} prüft mit der gemeinsamen Regel`);
  }
  const mdc = codeOf(src('src/core/bridge/masterdata-commands.ts'));
  ok(['createSupplier(', 'updateSupplier(', 'createEmployee(', 'updateEmployee(', 'createPartner(', 'updatePartner(', 'updateAgent('].every((f) => mdc.includes(f)), 'DOMAIN jeder Fernbefehl ruft die Hausfunktion des Primary');
}
marker('CENTRAL_UI_R6C_MASTERDATA_AUTHORITY_PINNED');

// ══ §3 — Inventur-Vertrag ═══════════════════════════════════════════════════
{
  const writeTargets = (code: string): string[] => [...new Set([...code.matchAll(/(INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-z_]+)/gi)].map((m) => m[2].toLowerCase()))]
    .filter((t) => t !== 'set');
  const ERLAUBT = S(['inventory_bootstrap', 'inventory_session_items', 'inventory_sessions']);
  const altModal = codeOf(vor('src/components/products/StockCheckInventoryModal.tsx'));
  const altSession = codeOf(vor('src/core/stock/inventory-session.ts'));
  ok(/recordStockCheck\(/.test(altModal) && /persistSessionItems\(/.test(altModal) && /closeSession\(/.test(altModal) && /ensureOpenSession\(/.test(altModal),
    'VERTRAG vor R6C: die Maske schrieb Beobachtung (recordStockCheck) und Arbeitsblatt (Sitzung) — sonst nichts');
  ok(!/updateProduct|stock_lots|ledger|post[A-Z]\w*\(|createExpense|adjust|quantity:/i.test(altModal) && S(writeTargets(altSession).sort()) === ERLAUBT,
    `VERTRAG vor R6C: kein Bestand, keine Lose, kein Hauptbuch, keine Ausgabe (Schreibziele: ${writeTargets(altSession).join(',')})`);
  const neu = ['src/core/stock/inventory-house.ts', 'src/core/stock/inventory-session.ts', 'src/core/stock/inventory-port.ts', 'src/core/stock/inventory-core.ts',
    'src/core/bridge/inventory-commands.ts', 'src/components/products/StockCheckInventoryModal.tsx', 'src/components/products/StockCheckPanel.tsx'].map((f) => codeOf(src(f))).join('\n');
  ok(S(writeTargets(neu).sort()) === ERLAUBT, `VERTRAG jetzt: Schreibziele weiterhin nur Lauf, Arbeitsblatt und der einmalige Bootstrap-Stempel (${writeTargets(neu).join(',')})`);
  ok(!/updateProduct|stock_lots|ledger_entries|post[A-Z]\w*\(|createExpense|recordExpense|stockStatus\s*[:=]|quantity\s*[:=]/.test(neu),
    'VERTRAG jetzt: kein Bestandsausgleich, keine Differenzbuchung, kein Hauptbuch, keine Ausgabe');
  const ohneVerbot = neu.replace(/export const INVENTORY_FORBIDDEN = \[[\s\S]*?\];/, '');
  ok(!/expected(Qty|Quantity|Stock)|variance|resultingStock|difference|countedQuantity/i.test(ohneVerbot),
    'VERTRAG kein Sollbestand, keine Differenz, kein Ergebnisbestand als neue Semantik — die Namen stehen nur auf der Verbotsliste');
  ok(['expectedQuantity', 'variance', 'resultingStock', 'quantity', 'stockStatus', 'adjustment', 'ledger'].every((k) => inv.INVENTORY_FORBIDDEN.includes(k)), 'VERTRAG …und dort werden sie abgewiesen');
  const rs = src('src-tauri/src/sync/stock_check.rs');
  ok(/INSERT INTO stock_checks/.test(rs) && !/UPDATE products|INSERT INTO products|DELETE FROM/.test(rs) && /SQLITE_OPEN_READ_ONLY/.test(rs),
    'VERTRAG der Kern schreibt nur die Beobachtung; die Geschäftsdatenbank öffnet er nur lesend');
  ok(S(stockCheck.STOCK_CHECK_STATUSES) === S(['available', 'not_available']) && stockCheck.MAX_STOCK_CHECK_NOTES === 500, 'VERTRAG erfasst: verfügbar / nicht verfügbar, Notiz ≤ 500');
  // Lebenszyklus mit Fassung, vollständig.
  const db = freshDb();
  const core = fakeCore();
  const d = deps(db);
  const produkte = () => S(rows(db, 'SELECT id, quantity, stock_status FROM products ORDER BY id'));
  const vorher = produkte();
  const rev = (sid: string) => Number(one(db, 'SELECT revision FROM inventory_sessions WHERE session_id = ?', [sid]));
  const st = await fern(() => inv.runInventoryStart(d, identity(nextId(), 'inventory.start'), { productIds: ['p1', 'p2', 'p3'] }, core as never));
  const sid = String(st.value.sessionId);
  ok(st.value.created === true && rev(sid) === 1, 'LIFECYCLE start: neuer Lauf, Fassung 1');
  const fremd = { check_id: 'phone-1', product_id: 'p3', status: 'available', notes: null, checked_at: tick(), checked_by: null, checked_by_name: null, source: 'mobile', request_id: null };
  core.rows.push(fremd);
  const st2 = await fern(() => inv.runInventoryStart(d, identity(nextId(), 'inventory.start'), { productIds: ['p1', 'p2', 'p3'] }, core as never));
  ok(st2.value.sessionId === sid && st2.value.foldedIn === 1 && rev(sid) === 2, 'LIFECYCLE start erneut: derselbe Lauf, eine Einfaltung → Fassung 2');
  const sv = await fern(() => inv.runInventorySave(d, identity(nextId(), 'inventory.save'), { sessionId: sid, expectedRevision: 2, items: [{ productId: 'p1', status: 'available', notes: 'a' }, { productId: 'p3', status: 'available', notes: '' }], visibleProductIds: ['p1', 'p2', 'p3'] }, core as never));
  ok(sv.kind === 'ok' && rev(sid) === 3 && sv.value.recorded === 1, `LIFECYCLE save: nur die neue Entscheidung wird beobachtet (p3 kam vom Telefon), Fassung 3 (${S(sv.value)})`);
  const sv2 = await fern(() => inv.runInventorySave(d, identity(nextId(), 'inventory.save'), { sessionId: sid, expectedRevision: 3, items: [{ productId: 'p1', status: 'available', notes: 'a' }, { productId: 'p3', status: 'available', notes: '' }], visibleProductIds: ['p1', 'p2', 'p3'] }, core as never));
  ok(sv2.value.unchanged === true && rev(sid) === 3, 'LIFECYCLE save ohne Änderung: keine Wirkung, Fassung bleibt');
  const items = rows(db, 'SELECT product_id, status, notes FROM inventory_session_items WHERE session_id = ? ORDER BY product_id', [sid]);
  ok(S(items.map((i) => i.status)) === S(['available', 'to_check', 'available']) && items.every((i) => ['available', 'not_available', 'to_check'].includes(String(i.status))),
    `LIFECYCLE das Arbeitsblatt kennt nur verfügbar / nicht verfügbar / zu prüfen (${S(items)})`);
  const rc = await fern(() => inv.runInventoryRecordCheck(d, identity(nextId(), 'inventory.record_check'), { productId: 'p2', status: 'not_available', notes: 'x' }, core as never));
  ok(rc.kind === 'ok' && rev(sid) === 3, 'LIFECYCLE record_check: eine Beobachtung, der Lauf bleibt unberührt');
  const fi = await fern(() => inv.runInventoryFinish(d, identity(nextId(), 'inventory.finish'), { sessionId: sid, expectedRevision: 3 }));
  ok(fi.kind === 'ok' && rev(sid) === 4 && one(db, 'SELECT status FROM inventory_sessions WHERE session_id = ?', [sid]) === 'closed', 'LIFECYCLE finish: geschlossen, Fassung 4');
  const st3 = await fern(() => inv.runInventoryStart(d, identity(nextId(), 'inventory.start'), { productIds: ['p1'] }, core as never));
  ok(st3.value.created === true && st3.value.sessionId !== sid && rev(String(st3.value.sessionId)) === 1, 'LIFECYCLE danach: ein neuer Lauf beginnt bei Fassung 1');
  ok(produkte() === vorher && Number(one(db, 'SELECT COUNT(*) FROM ledger_entries')) === 0 && Number(one(db, 'SELECT COUNT(*) FROM expenses')) === 0,
    'LIFECYCLE über den ganzen Lauf: Bestand, Hauptbuch, Ausgaben unverändert');
}
marker('CENTRAL_UI_R6C_INVENTORY_CONTRACT_PINNED');

// ══ §4 — Inventur: Fehler und Durabilität ════════════════════════════════════
{
  const db = freshDb();
  const core = fakeCore();
  const st = { failSave: false };
  const d = deps(db, st);
  const s = await fern(() => inv.runInventoryStart(d, identity(nextId(), 'inventory.start'), { productIds: ['p1', 'p2'] }, core as never));
  const sid = String(s.value.sessionId);
  const stale = await fern(() => inv.runInventorySave(d, identity(nextId(), 'inventory.save'), { sessionId: sid, expectedRevision: 9, items: [{ productId: 'p1', status: 'available', notes: '' }], visibleProductIds: ['p1', 'p2'] }, core as never));
  ok(stale.code === house.INVENTORY_SESSION_STALE && core.calls === 0 && Number(one(db, 'SELECT COUNT(*) FROM inventory_session_items')) === 0,
    'DURABLE eine alte Fassung wird VOR jedem Schreiben abgewiesen — kein Kernaufruf, kein Arbeitsblatt');
  const staleFin = await fern(() => inv.runInventoryFinish(d, identity(nextId(), 'inventory.finish'), { sessionId: sid, expectedRevision: 9 }));
  ok(staleFin.code === house.INVENTORY_SESSION_STALE && one(db, 'SELECT status FROM inventory_sessions WHERE session_id = ?', [sid]) === 'open', 'DURABLE Abschließen mit alter Fassung: Nein, der Lauf bleibt offen');
  const id = nextId();
  const body = { sessionId: sid, expectedRevision: 1, items: [{ productId: 'p1', status: 'available', notes: '' }], visibleProductIds: ['p1', 'p2'] };
  st.failSave = true;
  const lost = await fern(() => inv.runInventorySave(d, identity(id, 'inventory.save'), body, core as never));
  st.failSave = false;
  const calls = core.calls;
  const again = await fern(() => inv.runInventorySave(d, identity(id, 'inventory.save'), body, core as never));
  ok(lost.kind === 'thrown' && again.kind === 'ok' && again.replayed && core.calls === calls && core.rows.length === 1,
    'DURABLE ohne bestätigtes Speichern kein Erfolg; dieselbe Kennung danach: genau eine Wirkung');
  const modal = codeOf(src('src/components/products/StockCheckInventoryModal.tsx'));
  const saveBody = modal.slice(modal.indexOf('const save = async () => {'), modal.indexOf('const [confirmFinish'));
  ok(saveBody.indexOf("if (r.kind !== 'ok') {") > 0 && saveBody.indexOf('return;', saveBody.indexOf("if (r.kind !== 'ok') {")) < saveBody.lastIndexOf('onClose()'),
    'DURABLE ein gescheitertes Speichern schließt die Maske nicht');
  const finBody = modal.slice(modal.indexOf('const finishInventory = async () => {'), modal.indexOf('const attemptClose'));
  ok(finBody.indexOf("if (r.kind !== 'ok') {") > 0 && finBody.indexOf('return;', finBody.indexOf("if (r.kind !== 'ok') {")) < finBody.indexOf('Inventory finished'),
    'DURABLE ein gescheitertes Abschließen meldet kein „finished"');
  const port = codeOf(src('src/core/stock/inventory-port.ts'));
  ok(!/saveDatabase\(\)/.test(port) && (port.match(/await saveDatabaseDurably\(\)/g) ?? []).length >= 4 && (port.match(/runExclusive\(async/g) ?? []).length === 4,
    'DURABLE am Primary: Schreibreihenfolge, eigene Transaktion, erst danach durabel — nie das verschobene saveDatabase()');
  const houseSrc = codeOf(src('src/core/stock/inventory-house.ts'));
  ok(!/saveDatabase|beginLedgerTransaction|COMMIT/.test(houseSrc) && /INSIDE_COMMAND/.test(codeOf(src('src/core/bridge/inventory-commands.ts'))),
    'DURABLE die Hausfolge speichert und committet nie selbst — das tut die Klammer (Maschine bzw. Primary-Anschluss)');
  // Die alte lokale Datei auf PC2 ist bedeutungslos.
  store.set('lataif_runtime_mode', 'client');
  const e1 = await (async () => { try { await stockCheck.latestStockChecks(['p1']); return ''; } catch (e) { return String((e as { code?: string }).code); } })();
  let localCalled = false;
  const r = await runSharedWrite(true, { local: () => { localCalled = true; return {}; }, remote: () => ({ productIds: ['p1'] }) },
    { send: async () => ({ kind: 'ok', value: { sessionId: 's' }, replayed: false }) } as never);
  store.delete('lataif_runtime_mode');
  ok(e1 === stockCheck.STOCK_CHECK_PRIMARY_ONLY && !localCalled && r.kind === 'ok', 'DURABLE auf PC2 wird weder der eigene Kern noch die lokale Hausfolge berührt — nur der Primary');
  ok((modal.match(/(openInventoryHere|saveInventoryHere|finishInventoryHere)\(/g) ?? []).length === 3
    && (modal.match(/local: [^\n]*(openInventoryHere|saveInventoryHere|finishInventoryHere)|local: async \(\) => \{[\s\S]{0,120}(saveInventoryHere|finishInventoryHere)/g) ?? []).length === 3,
    'DURABLE in der Maske stehen die lokalen Hausfolgen nur im Primary-Anschluss (`local:`)');
}
marker('CENTRAL_UI_R6C_INVENTORY_DURABILITY_PINNED');

// ══ §4b — keine erfundenen Grenzen ══════════════════════════════════════════
{
  const { readdirSync } = await import('node:fs');
  const walk = (dir: string): string[] => readdirSync(resolvePath(repo, dir), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : /\.(ts|tsx)$/.test(e.name) ? [`${dir}/${e.name}`] : []));
  const hits = walk('src').filter((p) => /MAX_BASE_SALARY|MAX_INVENTORY_PRODUCTS|INVENTORY_TOO_MANY/.test(src(p)));
  ok(hits.length === 0, `LIMIT keine Obergrenze fürs Grundgehalt, keine Höchstzahl für eine Inventur (${hits.join(', ') || 'nirgends'})`);
  const rustTake = Number(/async fn latest_stock_checks[\s\S]*?\.take\((\d+)\)/.exec(src('src-tauri/src/lib.rs'))?.[1] ?? Number.NaN);
  ok(stockCheck.LATEST_STOCK_CHECKS_BATCH <= rustTake, `LIMIT je Kernaufruf höchstens so viele Artikel, wie der Kern beantwortet (${stockCheck.LATEST_STOCK_CHECKS_BATCH} ≤ ${rustTake})`);
  const lsc = codeOf(src('src/core/stock/stock-check.ts'));
  ok(/i \+= LATEST_STOCK_CHECKS_BATCH/.test(lsc) && /productIds\.slice\(i, i \+ LATEST_STOCK_CHECKS_BATCH\)/.test(lsc),
    'LIMIT die letzten Beobachtungen werden in Blöcken gelesen — keine stille Kürzung hinter Position 1000');
  ok(!/\.slice\(0, [^)]*\)/.test(codeOf(src('src/core/stock/inventory-core.ts'))) && /latestStockChecks\(\[\.\.\.productIds\]\)/.test(src('src/core/stock/inventory-core.ts')),
    'LIMIT der Anschluss des Primary reicht die ganze Liste weiter');
}
marker('CENTRAL_UI_R6C_NO_INVENTED_LIMITS_PINNED');

// ══ §5 — R6A-Abschluss ══════════════════════════════════════════════════════
{
  const doc = src('docs/central-ui-parity.md');
  const a = doc.indexOf('### Write-Gap-SSOT');
  const zeilen = doc.slice(a, doc.indexOf('### Keine toten Knöpfe')).split(/\r?\n/).filter((l) => /^\| /.test(l) && !/^\| UI-Handlung|^\|---/.test(l)).map((l) => l.split('|').map((x) => x.trim()));
  const A = zeilen.filter((p) => p[5] === 'A');
  const zu = A.filter((p) => /geschlossen \(R6C\)/.test(p[7] ?? ''));
  ok(A.length === 95 && zu.length === 16 && A.length - zu.length === 79, `R6A A vorher 95, R6C geschlossen 16, verbleibend 79 (${A.length}/${zu.length}/${A.length - zu.length})`);
  ok(zu.every((p) => /^(Stammdaten|Inventur) ·/.test(p[8] ?? '')), 'R6A geschlossen sind nur Zeilen der Domänen Stammdaten und Inventur');
  // R6D hat Metall geschlossen, R6F Aufgaben, Dokumente und Inbox-Foto (eigene Gates). Geprüft bleibt: R6C selbst hat sie
  // NICHT geschlossen — sie tragen die Marke ihres eigenen Bündels.
  const nichtZu = A.filter((p) => /Aufgabe|Dokument|Texterkennung|Inbox-Foto/.test(p[1]));
  ok(nichtZu.length === 5 && nichtZu.every((p) => !/geschlossen \(R6C\)/.test(p[7] ?? '') && /geschlossen \(R6F\)/.test(p[7] ?? '')),
    `R6A Aufgaben, Dokumente, Inbox-Foto: nicht von R6C, sondern von R6F geschlossen (${nichtZu.length})`);
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — r6c final gate: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R6C_FINAL_GATE_PROVED');
