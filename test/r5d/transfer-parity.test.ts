// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R5D — Agenten-Transfer anlegen, umwandeln, gesammelt umwandeln: dieselbe Wirkung.
// Run: node test/r5d/transfer-parity.test.ts
//
// Bewiesen an echten Zeilen einer echten sql.js-Datenbank, jeweils in ZWEI gleich gesäten Welten —
// einmal über den Anschluss der Maske am Primary (`transfer-house`), einmal über den Fernbefehl mit
// genau dem Rumpf, den dieselbe Maske am zweiten Rechner baut (`transfer-rules`):
//
//   §2 Anlegen: Kunde, Stück, Our Price, Modell mit Anteil, Rückgabedatum, Mitarbeiter — Zeile,
//      Agent, Bestand, Nummer gleich. Der alte Grund `staffId` ist geschlossen.
//   §3 Umwandeln: an einen gewählten Kunden und „Auto-create from agent" — Rechnung, Zeilen,
//      Buchungen, der neue Kunde Feld für Feld gleich.
//   §4 Gesammelt: EINE Rechnung, Zeilen in der Reihenfolge der Auswahl, nur verkaufte eines Agenten.
//   §6/§7 Atomar: ein Fehler nach dem Transfer, zwischen Kunde und Rechnung, zwischen Rechnung und
//      Verknüpfung, mitten in der Sammelrechnung hinterlässt NICHTS.
//   §9 Autorität: fremde Filiale/Kunde/Stück/Mitarbeiter/Transfer, nichts Abgeleitetes aus dem Rumpf.
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

/** Was ein Transfer im Haus hinterlässt — ohne Kennungen und Zeitpunkte. */
function bildDesTransfers(db: Db, tid: string) {
  const t = row(db, 'SELECT * FROM agent_transfers WHERE id = ?', [tid]);
  return {
    transfer: ohne(t, ['agent_id', 'invoice_id']),
    agent: ohne(row(db, 'SELECT * FROM agents WHERE id = ?', [String(t.agent_id ?? '')])),
    stueck: row(db, 'SELECT stock_status, source_type, quantity FROM products WHERE id = ?', [String(t.product_id ?? '')]),
    agenten: n(db, 'SELECT COUNT(*) FROM agents'),
    zaehler: zaehler(db),
  };
}
/** Was eine Rechnung im Haus hinterlässt — Kopf, Zeilen, Buchungen, der Kunde. */
function bildDerRechnung(db: Db, invId: string) {
  const k = row(db, 'SELECT * FROM invoices WHERE id = ?', [invId]);
  return {
    kopf: ohne(k, ['customer_id']),
    zeilen: all(db, 'SELECT product_id, unit_price, purchase_price_snapshot, tax_scheme, vat_rate, vat_amount, line_total FROM invoice_lines WHERE invoice_id = ? ORDER BY rowid', [invId]),
    kunde: ohne(row(db, 'SELECT * FROM customers WHERE id = ?', [String(k.customer_id ?? '')])),
    buchungen: buchungen(db),
    kunden: n(db, 'SELECT COUNT(*) FROM customers'),
    rechnungen: n(db, 'SELECT COUNT(*) FROM invoices'),
  };
}

/** Ein verkaufter Transfer, fern angelegt und verkauft — in beiden Welten auf demselben Weg. */
async function verkaufterTransfer(db: Db, nth: string, customerId: string, productId: string, preis = 300, verkauf = 400): Promise<string> {
  const out = await fern(() => cmd.runTransferCreate(deps(db), identity(nth + '1', 'transfers.create'),
    { customerId, productId, agentPrice: preis }));
  if (!out.ok) throw new Error('setup transfer: ' + out.code);
  const tid = String(out.value?.transferId);
  const sold = await fern(() => fin.runMarkSold(deps(db), identity(nth + '2', 'transfers.mark_sold'),
    { transferId: tid, salePrice: verkauf, expectedRevision: trev(db, tid) }));
  if (!sold.ok) throw new Error('setup sold: ' + sold.code);
  return tid;
}

// ── §1 Der Umfang: genau die drei Transferzeilen der Klasse B, keine neue Buchung ──
{
  // Die elf Klasse-B-Zeilen vor R5D, aus der Matrix gelesen (R5C-Stand) — und davon die drei Transfers.
  const vorher = ['returns.create', 'returns.approve', 'returns.refund', 'purchases.create', 'consignments.record_sale',
    'consignments.record_payout', 'orders.create', 'orders.update',
    'transfers.create', 'transfers.convert_to_invoice', 'transfers.convert_many_to_invoice'];
  const drei = vorher.filter((op) => op.startsWith('transfers.'));
  ok(drei.length === 3, 'SCOPE der eingefrorene Ausschnitt sind genau drei Transferfaelle');
  for (const op of drei) {
    const z = R4C_MATRIX.find((x) => x.op === op);
    ok(!!z && z.paritaet === 'exakt' && z.verdrahtet && z.luecke === null, `SCOPE ${op} ist geschlossen`);
    ok(ALLOWED_MUTATIONS.includes(op), `SCOPE ${op} ist eine VORHANDENE Buchung`);
  }
  // R5E/R5F schliessen weitere Zeilen — gepinnt wird, dass kein Transfer zurueckfaellt und nur aus
  // dem R5D-Rest weiter geschlossen wird.
  const nochB = R4C_MATRIX.filter((z) => z.luecke === 'B').map((z) => z.op).sort();
  ok(nochB.every((op) => vorher.includes(op) && !op.startsWith('transfers.')),
    `SCOPE die uebrigen Klasse-B-Zeilen stammen aus dem R5D-Rest (${nochB.join(', ')})`);
  ok(ALLOWED_MUTATIONS.length === 41, `SCOPE nur die freigegebene neue Buchung invoices.cancel (${ALLOWED_MUTATIONS.length})`);
  const rust = src('src-tauri/src/bridge.rs');
  const rustOps = [...(/pub const REMOTE_OPS: &\[&str\] = &\[([\s\S]*?)\];/.exec(rust)?.[1] ?? '').matchAll(/OP_[A-Z_]+/g)].length;
  ok(rustOps === 108, `SCOPE die Registry steht bei 108 (R5F.1: invoices.cancel) (${rustOps})`);
  for (const op of ['transfers.update', 'transfers.mark_returned', 'transfers.mark_sold']) {
    const z = R4C_MATRIX.find((x) => x.op === op);
    ok(!!z && z.verdrahtet, `SCOPE Nachbar ${op} bleibt verdrahtet`);
  }
  const stand = [R4C_MATRIX.filter((z) => z.verdrahtet).length,
    R4C_MATRIX.filter((z) => z.paritaet === 'exakt' && !z.verdrahtet).length,
    R4C_MATRIX.filter((z) => z.luecke === 'B').length, R4C_MATRIX.filter((z) => z.paritaet === 'keine-ui').length];
  ok(stand[0] >= 30 && stand[1] === 0 && stand[3] >= 2 && stand[0] + stand[2] + stand[3] === 40,
    `SCOPE die Matrix faellt nicht hinter 30/0/8/2 zurueck (${stand.join('/')})`);
}

// ── §2 Anlegen: dieselbe Zeile auf beiden Wegen ──────────────────────────
const FORM = {
  customerId: 'cust-1', productId: 'p1', ourPrice: 900, settlementModel: 'split', excessSplitPct: 60,
  returnBy: '2026-10-01', staffId: 'emp-1',
};
{
  // Der Rumpf ist genau das, was die Maske erfasst — und nichts, was das Haus bestimmt.
  const body = rules.transferCreateBody(FORM);
  ok(S(Object.keys(body).sort()) === S(['agentPrice', 'customerId', 'excessSplitPct', 'productId', 'returnBy', 'settlementModel', 'staffId']),
    `CREATE der Rumpf traegt genau die Felder der Maske (${Object.keys(body).join(', ')})`);
  ok(body.staffId === 'emp-1', 'CREATE …auch den Mitarbeiter — der alte Klasse-B-Grund');
  ok(!('excessSplitPct' in rules.transferCreateBody({ ...FORM, settlementModel: 'full' })),
    'CREATE beim Modell „full" reist kein Anteil mit — wie die Maske ihn nicht schickt');
  ok(rules.transferCreateBody({ ...FORM, excessSplitPct: undefined }).excessSplitPct === 50,
    'CREATE „split" ohne Eingabe nimmt 50 — wie die Maske');
  ok(rules.transferCreateBody({ ...FORM, settlementModel: undefined }).settlementModel === 'full',
    'CREATE ohne Wahl gilt „full" — wie die Maske');

  let db = freshDb();
  const p = await primary(() => house.createTransferOnPrimary(FORM));
  ok(p.ok, `CREATE am Primary entsteht der Transfer (${p.code})`);
  const bildP = bildDesTransfers(db, String(p.value?.id));

  db = freshDb();
  const r = await fern(() => cmd.runTransferCreate(deps(db), identity('11', 'transfers.create'), rules.transferCreateBody(FORM)));
  ok(r.ok, `CREATE fern entsteht der Transfer (${r.code})`);
  const tid = String(r.value?.transferId);
  const bildR = bildDesTransfers(db, tid);
  const diff = [...unterschiede(bildP.transfer, bildR.transfer), ...unterschiede(bildP.agent, bildR.agent),
    ...unterschiede(bildP.stueck, bildR.stueck)];
  ok(diff.length === 0, `CREATE lokal == fern: Transfer, Agent, Stueck (${diff.join(' · ') || 'gleich'})`);
  ok(bildP.agenten === bildR.agenten && bildP.zaehler === bildR.zaehler, 'CREATE …ein Agent, derselbe Zaehlerstand');
  const t = bildR.transfer;
  ok(t.staff_id === 'emp-1', `CREATE der Mitarbeiter steht am Transfer (${S(t.staff_id)})`);
  ok(t.settlement_model === 'split' && Number(t.excess_split_pct) === 60 && Number(t.agent_price) === 900,
    `CREATE Modell, Anteil und Our Price wie gewaehlt (${S([t.settlement_model, t.excess_split_pct, t.agent_price])})`);
  ok(t.status === 'transferred' && t.return_by === '2026-10-01', 'CREATE Status und Rueckgabedatum');
  ok(t.branch_id === 'branch-main' && t.created_by === 'user-test', `CREATE Filiale und Anleger vom Haus (${S([t.branch_id, t.created_by])})`);
  ok(/^TRF-\d{4}-\d{5}$/.test(String(t.transfer_number)), `CREATE die Nummer aus dem Kreis des Hauses (${S(t.transfer_number)})`);
  ok(S(bildR.stueck) === S({ stock_status: 'with_agent', source_type: 'AGENT', quantity: 1 }),
    `CREATE das Stueck ist beim Agenten (${S(bildR.stueck)})`);
  ok(bildR.agent.customer_id === 'cust-1' && bildR.agenten === 1, 'CREATE das Haus hat den Agenten zum Kunden angelegt');
  ok(Number(t.revision) >= 1, `CREATE die Fassung steht (${S(t.revision)})`);

  // Dieselbe Kennung noch einmal: dieselbe Antwort, kein zweiter Transfer, keine zweite Nummer.
  const zVor = zaehler(db);
  const again = await fern(() => cmd.runTransferCreate(deps(db), identity('11', 'transfers.create'), rules.transferCreateBody(FORM)));
  ok(again.ok && again.replayed === true && String(again.value?.transferId) === tid, 'CREATE die Wiederholung ist eine Wiederholung');
  ok(n(db, 'SELECT COUNT(*) FROM agent_transfers') === 1 && zaehler(db) === zVor, 'CREATE …ohne zweiten Transfer, ohne neue Nummer');

  // Ein zweiter Transfer desselben Kunden findet DENSELBEN Agenten.
  const second = await fern(() => cmd.runTransferCreate(deps(db), identity('12', 'transfers.create'),
    rules.transferCreateBody({ customerId: 'cust-1', productId: 'p2', ourPrice: 200 })));
  ok(second.ok && n(db, 'SELECT COUNT(*) FROM agents') === 1, 'CREATE ein Kunde — ein Agent');
  ok(s(db, 'SELECT settlement_model FROM agent_transfers WHERE id = ?', [String(second.value?.transferId)]) === 'full'
    && one(db, 'SELECT excess_split_pct FROM agent_transfers WHERE id = ?', [String(second.value?.transferId)]) === null,
    'CREATE ohne Wahl „full" und kein Anteil');
}
{
  // Die Grenzen des Anteils sind die der Maske (0–100), auf beiden Wegen.
  for (const [pct, gut] of [[0, true], [100, true], [101, false], [-1, false]] as Array<[number, boolean]>) {
    let db = freshDb();
    const p = await primary(() => house.createTransferOnPrimary({ ...FORM, excessSplitPct: pct }));
    db = freshDb();
    const r = await fern(() => cmd.runTransferCreate(deps(db), identity('21', 'transfers.create'),
      { customerId: 'cust-1', productId: 'p1', agentPrice: 900, settlementModel: 'split', excessSplitPct: pct }));
    ok(p.ok === gut && r.ok === gut, `CREATE Anteil ${pct}% — ${gut ? 'erlaubt' : 'abgewiesen'} auf beiden Wegen (${p.code || 'ok'} / ${r.code || 'ok'})`);
    if (gut) ok(n(db, 'SELECT excess_split_pct FROM agent_transfers') === pct, `CREATE …und steht so am Transfer (${pct})`);
  }
  // Our Price: groesser als 0 — ein negativer Betrag war an der Maske eintippbar, er ist kein Fachfall.
  for (const preis of [0, -5]) {
    freshDb();
    const p = await primary(() => house.createTransferOnPrimary({ ...FORM, ourPrice: preis }));
    const db = freshDb();
    const r = await fern(() => cmd.runTransferCreate(deps(db), identity('22', 'transfers.create'),
      { customerId: 'cust-1', productId: 'p1', agentPrice: preis }));
    ok(!p.ok && p.code === 'INVALID_AMOUNT' && !r.ok, `CREATE Our Price ${preis} wird auf beiden Wegen abgewiesen (${p.code} / ${r.code})`);
    ok(n(db, 'SELECT COUNT(*) FROM agent_transfers') === 0, 'CREATE …und nichts entsteht');
  }
}

// ── §9 Anlegen: das Haus entscheidet ─────────────────────────────────────
{
  const faelle: Array<[string, Record<string, unknown>, string]> = [
    ['ein Kunde einer fremden Filiale', { customerId: 'cust-x' }, 'CUSTOMER_NOT_FOUND'],
    ['ein Platzhalter-Kunde', { customerId: 'sys-walkin' }, 'CUSTOMER_NOT_FOUND'],
    ['ein Stueck einer fremden Filiale', { productId: 'p-foreign' }, 'PRODUCT_NOT_FOUND'],
    ['ein verkauftes Stueck', { productId: 'p-sold' }, 'PRODUCT_NOT_AVAILABLE'],
    ['ein fremder Mitarbeiter', { staffId: 'emp-x' }, 'EMPLOYEE_NOT_FOUND'],
    ['ein ausgeschiedener Mitarbeiter', { staffId: 'emp-gone' }, 'EMPLOYEE_NOT_FOUND'],
  ];
  for (const [was, patch, erwartet] of faelle) {
    freshDb();
    const p = await primary(() => house.createTransferOnPrimary({ ...FORM, ...patch } as never));
    const db = freshDb();
    const vor = zaehler(db);
    const r = await fern(() => cmd.runTransferCreate(deps(db), identity('31', 'transfers.create'),
      rules.transferCreateBody({ ...FORM, ...patch } as never)));
    ok(!p.ok && p.code === erwartet && !r.ok && r.code === erwartet,
      `AUTH ${was}: ${erwartet} auf beiden Wegen (${p.code} / ${r.code})`);
    ok(n(db, 'SELECT COUNT(*) FROM agent_transfers') === 0 && n(db, 'SELECT COUNT(*) FROM agents') === 0 && zaehler(db) === vor,
      `AUTH …${was}: kein Transfer, kein Agent, keine Nummer`);
  }
  // Schon draussen: der Bestand sagt „im Lager", aber ein offener Transfer steht — das Haus merkt es.
  {
    const db = freshDb();
    const erst = await fern(() => cmd.runTransferCreate(deps(db), identity('32', 'transfers.create'), rules.transferCreateBody(FORM)));
    db.run("UPDATE products SET stock_status = 'in_stock' WHERE id = 'p1'");
    const p = await primary(() => house.createTransferOnPrimary(FORM));
    const r = await fern(() => cmd.runTransferCreate(deps(db), identity('33', 'transfers.create'), rules.transferCreateBody(FORM)));
    ok(erst.ok && p.code === 'PRODUCT_ALREADY_OUT' && r.code === 'PRODUCT_ALREADY_OUT',
      `AUTH ein Stueck, das schon draussen ist, geht nicht zweimal hinaus (${p.code} / ${r.code})`);
    ok(n(db, 'SELECT COUNT(*) FROM agent_transfers') === 1, 'AUTH …es bleibt bei einem Transfer');
  }
  // Was das Haus bestimmt, kann der Rumpf nicht setzen.
  for (const [f, v] of [['agentId', 'agent-1'], ['transferNumber', 'TRF-2026-00099'], ['status', 'sold'], ['branchId', 'branch-other'],
    ['stockStatus', 'in_stock'], ['actualSalePrice', 900], ['settlementAmount', 1], ['createdBy', 'u'], ['invoiceId', 'i']] as Array<[string, unknown]>) {
    const db = freshDb();
    const r = await fern(() => cmd.runTransferCreate(deps(db), identity('34', 'transfers.create'), { ...rules.transferCreateBody(FORM), [f]: v }));
    ok(!r.ok && n(db, 'SELECT COUNT(*) FROM agent_transfers') === 0, `AUTH der Rumpf setzt ${f} nicht (${r.code})`);
  }
  {
    const db = freshDb();
    const r = await fern(() => cmd.runTransferCreate(deps(db), fremd('35', 'transfers.create'), rules.transferCreateBody(FORM)));
    ok(r.code === 'BRANCH_MISMATCH' && n(db, 'SELECT COUNT(*) FROM agent_transfers') === 0,
      `AUTH ein Ausweis einer fremden Filiale schreibt nicht in diese Buecher (${r.code})`);
  }
}

// ── §6 Anlegen ist atomar: ein Fehler NACH dem Transfer hinterlässt nichts ──
{
  const echt = eventBus.emit.bind(eventBus);
  for (const weg of ['primary', 'fern'] as const) {
    const db = freshDb();
    const vor = { zaehler: zaehler(db), agenten: n(db, 'SELECT COUNT(*) FROM agents') };
    let imFehler = '';
    (eventBus as { emit: unknown }).emit = (name: string, ...rest: unknown[]) => {
      if (name === 'agent_transfer.created') {
        imFehler = S([n(db, 'SELECT COUNT(*) FROM agent_transfers'), s(db, "SELECT stock_status FROM products WHERE id = 'p1'"),
          n(db, 'SELECT COUNT(*) FROM agents')]);
        throw new Error('R5D: failure after the transfer insert');
      }
      return (echt as (...a: unknown[]) => unknown)(name, ...rest);
    };
    let aus: Ausgang;
    try {
      aus = weg === 'primary'
        ? await primary(() => house.createTransferOnPrimary(FORM))
        : await fern(() => cmd.runTransferCreate(deps(db), identity('41', 'transfers.create'), rules.transferCreateBody(FORM)));
    } finally {
      (eventBus as { emit: unknown }).emit = echt;
    }
    ok(imFehler === S([1, 'with_agent', 1]), `ATOMIC ${weg}: im Fehler standen Transfer, Bestandswechsel und Agent schon (${imFehler})`);
    ok(!aus.ok, `ATOMIC ${weg}: der Vorgang meldet keinen Erfolg (${aus.code})`);
    ok(n(db, 'SELECT COUNT(*) FROM agent_transfers') === 0, `ATOMIC ${weg}: kein Transfer blieb stehen`);
    ok(s(db, "SELECT stock_status || '/' || source_type FROM products WHERE id = 'p1'") === 'in_stock/OWN',
      `ATOMIC ${weg}: das Stueck liegt wieder im Lager und gehoert uns`);
    ok(n(db, 'SELECT COUNT(*) FROM agents') === vor.agenten, `ATOMIC ${weg}: kein Agent blieb stehen`);
    ok(zaehler(db) === vor.zaehler, `ATOMIC ${weg}: keine Nummer wurde verbrannt`);
    // Und danach gelingt es — genau einmal.
    const heil = weg === 'primary'
      ? await primary(() => house.createTransferOnPrimary(FORM))
      : await fern(() => cmd.runTransferCreate(deps(db), identity('41', 'transfers.create'), rules.transferCreateBody(FORM)));
    ok(heil.ok && n(db, 'SELECT COUNT(*) FROM agent_transfers') === 1 && n(db, 'SELECT COUNT(*) FROM agents') === 1,
      `ATOMIC ${weg}: danach entsteht genau ein Transfer mit genau einem Agenten (${heil.code || 'ok'})`);
  }
}

// ── §3 Einzeln umwandeln: gewählter Kunde und „Auto-create from agent" ────
const AGENT = { name: 'Karim Al Mansour', company: 'KM Trading', phone: '+97333000000', whatsapp: '+97333000001', email: 'km@example.com' };
async function einzelWelt(weg: 'primary' | 'fern', billTo: Record<string, unknown>, status = 'sold') {
  const db = freshDb();
  const tid = await verkaufterTransfer(db, '5', 'cust-1', 'p2', 300, 440);
  db.run('UPDATE agents SET name = ?, company = ?, phone = ?, whatsapp = ?, email = ?',
    [AGENT.name, AGENT.company, AGENT.phone, AGENT.whatsapp, AGENT.email]);
  if (status !== 'sold') db.run('UPDATE agent_transfers SET status = ? WHERE id = ?', [status, tid]);
  const kundenVor = n(db, 'SELECT COUNT(*) FROM customers');
  // Der Rumpf, den die Maske schickt — eine verlorene Antwort wiederholt GENAU ihn.
  const rumpf = rules.transferConvertBody({ id: tid, revision: trev(db, tid) }, billTo as never);
  const aus = weg === 'primary'
    ? await primary(() => house.convertTransferOnPrimary(tid, billTo as never))
    : await fern(() => life.runConvertTransfer(deps(db), identity('59', 'transfers.convert_to_invoice'), rumpf));
  const invId = s(db, 'SELECT invoice_id FROM agent_transfers WHERE id = ?', [tid]);
  return { db, tid, aus, invId, kundenVor, rumpf, bild: invId ? bildDerRechnung(db, invId) : null, transfer: bildDesTransfers(db, tid) };
}
{
  // (a) An einen gewählten Kunden.
  const a = await einzelWelt('primary', { customerId: 'cust-2' });
  const b = await einzelWelt('fern', { customerId: 'cust-2' });
  ok(a.aus.ok && b.aus.ok, `CONVERT gewaehlter Kunde: beide Wege wandeln um (${a.aus.code || 'ok'} / ${b.aus.code || 'ok'})`);
  const diff = [...unterschiede(a.bild!.kopf, b.bild!.kopf), ...unterschiede(a.transfer.transfer, b.transfer.transfer)];
  ok(diff.length === 0 && a.bild!.zeilen === b.bild!.zeilen && a.bild!.buchungen === b.bild!.buchungen,
    `CONVERT lokal == fern: Kopf, Zeilen, Buchungen, Transfer (${diff.join(' · ') || 'gleich'})`);
  ok(s(b.db, 'SELECT customer_id FROM invoices WHERE id = ?', [b.invId]) === 'cust-2', 'CONVERT die Rechnung geht an den gewaehlten Kunden');
  ok(b.bild!.kunden === b.kundenVor && a.bild!.kunden === a.kundenVor, 'CONVERT …und es entsteht KEIN Kunde');
  ok(Math.abs(n(b.db, 'SELECT gross_amount FROM invoices WHERE id = ?', [b.invId]) - 440) < 0.005,
    'CONVERT ihre Summe IST der Abrechnungsbetrag');
  ok(s(b.db, 'SELECT notes FROM invoices WHERE id = ?', [b.invId]) === `Agent settlement · transfer ${s(b.db, 'SELECT transfer_number FROM agent_transfers WHERE id = ?', [b.tid])}`,
    'CONVERT der Vermerk der Rechnung ist der des Hauses');
  ok(s(b.db, 'SELECT invoice_number FROM invoices WHERE id = ?', [b.invId]) === s(a.db, 'SELECT invoice_number FROM invoices WHERE id = ?', [a.invId]),
    'CONVERT dieselbe Nummer aus demselben Kreis');
  ok(b.transfer.transfer.status === 'sold' && b.invId !== '', 'CONVERT der Transfer traegt die Rechnung und bleibt „sold"');
  ok(n(b.db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'AGENT_TRANSFER_SOLD' AND reverses_entry_id IS NOT NULL") > 0,
    'CONVERT die Forderung aus dem Verkauf ist storniert — sie steht nicht zweimal');
  const replay = await fern(() => life.runConvertTransfer(deps(b.db), identity('59', 'transfers.convert_to_invoice'), b.rumpf));
  ok(replay.ok && replay.replayed === true && String(replay.value?.invoiceId) === b.invId
    && n(b.db, 'SELECT COUNT(*) FROM invoices') === 1,
  `CONVERT …eine Wiederholung derselben Absicht liefert dieselbe Rechnung, keine zweite (${replay.code || 'replayed'})`);
}
{
  // (b) „Auto-create from agent": IMMER ein neuer Kunde aus dem Agenten, auch wenn der Agent schon
  //     einen Kunden kennt — genau wie die Maske (kein Abgleich).
  const a = await einzelWelt('primary', { autoCustomer: true });
  const b = await einzelWelt('fern', { autoCustomer: true });
  ok(a.aus.ok && b.aus.ok, `AUTO beide Wege wandeln um (${a.aus.code || 'ok'} / ${b.aus.code || 'ok'})`);
  ok(a.bild!.kunden === a.kundenVor + 1 && b.bild!.kunden === b.kundenVor + 1, 'AUTO genau EIN neuer Kunde — auf beiden Wegen');
  const kunde = b.bild!.kunde;
  ok(kunde.first_name === 'Karim' && kunde.last_name === 'Al Mansour' && kunde.company === AGENT.company
    && kunde.phone === AGENT.phone && kunde.whatsapp === AGENT.whatsapp && kunde.email === AGENT.email,
  `AUTO der Kunde traegt die Angaben DES AGENTEN (${S([kunde.first_name, kunde.last_name, kunde.company, kunde.phone])})`);
  ok(kunde.notes === 'Auto-created from agent Karim Al Mansour for transfer settlements.', `AUTO …und den Vermerk der Maske (${S(kunde.notes)})`);
  ok(kunde.branch_id === 'branch-main' && kunde.created_by === 'user-test', 'AUTO …in der Filiale des Hauses');
  const diff = [...unterschiede(a.bild!.kunde, b.bild!.kunde), ...unterschiede(a.bild!.kopf, b.bild!.kopf)];
  ok(diff.length === 0 && a.bild!.zeilen === b.bild!.zeilen && a.bild!.buchungen === b.bild!.buchungen,
    `AUTO lokal == fern: Kunde, Kopf, Zeilen, Buchungen (${diff.join(' · ') || 'gleich'})`);
  const neu = s(b.db, "SELECT id FROM customers WHERE first_name = 'Karim'");
  ok(s(b.db, 'SELECT customer_id FROM invoices WHERE id = ?', [b.invId]) === neu, 'AUTO die Rechnung geht an den neuen Kunden');
  ok(val<Record<string, unknown>>({ value: b.aus.value }).customerId === neu && b.aus.value?.customerCreated === true,
    'AUTO die Antwort nennt ihn');
  ok(s(b.db, "SELECT customer_id FROM agents") === 'cust-1', 'AUTO der Agent behaelt seinen Kunden (die Hausfunktion merkt nur einen fehlenden)');
  // Dieselbe Kennung: kein zweiter Kunde, keine zweite Rechnung.
  const replay = await fern(() => life.runConvertTransfer(deps(b.db), identity('59', 'transfers.convert_to_invoice'), b.rumpf));
  ok(replay.ok && replay.replayed === true && String(replay.value?.invoiceId) === b.invId,
    `AUTO die Wiederholung derselben Absicht liefert dieselbe Rechnung (${replay.code || 'replayed'})`);
  ok(n(b.db, 'SELECT COUNT(*) FROM customers') === b.kundenVor + 1 && n(b.db, 'SELECT COUNT(*) FROM invoices') === 1,
    'AUTO …ohne zweiten Kunden, ohne zweite Rechnung');
  // Der Agent ohne Kunden: dann merkt ihn das Haus.
  const db = freshDb();
  const tid = await verkaufterTransfer(db, '6', 'cust-1', 'p3');
  db.run('UPDATE agents SET customer_id = NULL');
  await fern(() => life.runConvertTransfer(deps(db), identity('61', 'transfers.convert_to_invoice'),
    rules.transferConvertBody({ id: tid, revision: trev(db, tid) }, { autoCustomer: true })));
  ok(s(db, 'SELECT customer_id FROM agents') === s(db, "SELECT customer_id FROM invoices"),
    'AUTO ein Agent ohne Kunden merkt sich den neuen');
}
{
  // (c) Ein abgerechneter (Altbestand) wird einzeln noch Rechnung — gesammelt nicht (§4).
  const a = await einzelWelt('primary', { customerId: 'cust-2' }, 'settled');
  const b = await einzelWelt('fern', { customerId: 'cust-2' }, 'settled');
  ok(a.aus.ok && b.aus.ok, `CONVERT ein „settled"-Transfer wird einzeln Rechnung (${a.aus.code || 'ok'} / ${b.aus.code || 'ok'})`);
}

// ── §4 Gesammelt: EINE Rechnung, Zeilen in der Reihenfolge der Auswahl ────
async function sammelWelt(weg: 'primary' | 'fern', billTo: Record<string, unknown>) {
  const db = freshDb();
  const t1 = await verkaufterTransfer(db, '7', 'cust-1', 'p1', 300, 400);
  const t2 = await verkaufterTransfer(db, '8', 'cust-1', 'p2', 250, 330);
  db.run('UPDATE agents SET name = ?, company = ?, phone = ?, whatsapp = ?, email = ?',
    [AGENT.name, AGENT.company, AGENT.phone, AGENT.whatsapp, AGENT.email]);
  const kundenVor = n(db, 'SELECT COUNT(*) FROM customers');
  const ids = [t2, t1]; // bewusst NICHT die Reihenfolge des Anlegens
  const rumpf = rules.transferConvertManyBody(ids.map((id) => ({ id, revision: trev(db, id) })), billTo as never);
  const aus = weg === 'primary'
    ? await primary(() => house.convertTransfersOnPrimary(ids, billTo as never))
    : await fern(() => life.runConvertTransfers(deps(db), identity('79', 'transfers.convert_many_to_invoice'), rumpf));
  const invId = s(db, 'SELECT invoice_id FROM agent_transfers WHERE id = ?', [t1]);
  return { db, t1, t2, aus, invId, kundenVor, rumpf, bild: invId ? bildDerRechnung(db, invId) : null };
}
{
  const a = await sammelWelt('primary', { autoCustomer: true });
  const b = await sammelWelt('fern', { autoCustomer: true });
  ok(a.aus.ok && b.aus.ok, `BATCH beide Wege legen die Sammelrechnung an (${a.aus.code || 'ok'} / ${b.aus.code || 'ok'})`);
  ok(b.bild!.rechnungen === 1 && a.bild!.rechnungen === 1, 'BATCH genau EINE Rechnung');
  ok(s(b.db, 'SELECT invoice_id FROM agent_transfers WHERE id = ?', [b.t2]) === b.invId, 'BATCH beide Transfers tragen sie');
  const zeilen = JSON.parse(b.bild!.zeilen) as unknown[][];
  ok(zeilen.length === 2 && zeilen[0][0] === 'p2' && zeilen[1][0] === 'p1', `BATCH zwei Zeilen, in der Reihenfolge der Auswahl (${S(zeilen.map((z) => z[0]))})`);
  ok(zeilen[0][3] === 'VAT_10' && zeilen[1][3] === 'MARGIN', 'BATCH …jede mit dem Steuerschema IHRES Artikels');
  ok(Math.abs(n(b.db, 'SELECT gross_amount FROM invoices WHERE id = ?', [b.invId]) - 730) < 0.005, 'BATCH die Summe ist die beider Abrechnungen');
  ok(b.bild!.kunden === b.kundenVor + 1 && b.bild!.kunde.notes === 'Auto-created from agent Karim Al Mansour for combined invoice.',
    `BATCH genau ein neuer Kunde mit dem Vermerk der Sammelrechnung (${S(b.bild!.kunde.notes)})`);
  const diff = [...unterschiede(a.bild!.kopf, b.bild!.kopf), ...unterschiede(a.bild!.kunde, b.bild!.kunde)];
  ok(diff.length === 0 && a.bild!.zeilen === b.bild!.zeilen && a.bild!.buchungen === b.bild!.buchungen,
    `BATCH lokal == fern: Kopf, Zeilen, Kunde, Buchungen (${diff.join(' · ') || 'gleich'})`);
  const replay = await fern(() => life.runConvertTransfers(deps(b.db), identity('79', 'transfers.convert_many_to_invoice'), b.rumpf));
  ok(replay.ok && replay.replayed === true && String(replay.value?.invoiceId) === b.invId
    && n(b.db, 'SELECT COUNT(*) FROM invoices') === 1
    && n(b.db, 'SELECT COUNT(*) FROM customers') === b.kundenVor + 1, 'BATCH die Wiederholung legt nichts doppelt an');
}
{
  // Die Regeln der Sammelrechnung — auf beiden Wegen dieselben.
  const db = freshDb();
  const t1 = await verkaufterTransfer(db, '81', 'cust-1', 'p1');
  const t2 = await verkaufterTransfer(db, '82', 'cust-1', 'p2');
  const tOther = await verkaufterTransfer(db, '83', 'cust-2', 'p3');
  const open = String((await fern(() => cmd.runTransferCreate(deps(db), identity('84', 'transfers.create'),
    { customerId: 'cust-1', productId: 'p4', agentPrice: 100 }))).value?.transferId);
  const tSettled = await verkaufterTransfer(db, '85', 'cust-1', 'p5');
  db.run("UPDATE agent_transfers SET status = 'settled' WHERE id = ?", [tSettled]);
  const faelle: Array<[string, string[], string]> = [
    ['zwei Agenten', [t1, tOther], 'TRANSFERS_NOT_SAME_AGENT'],
    ['ein noch offener', [t1, open], 'TRANSFER_NOT_SOLD'],
    ['ein abgerechneter', [t1, tSettled], 'TRANSFER_NOT_COMBINABLE'],
  ];
  const rechnungenVor = n(db, 'SELECT COUNT(*) FROM invoices');
  let nth = 86;
  for (const [was, ids, erwartet] of faelle) {
    const p = await primary(() => house.convertTransfersOnPrimary(ids, { customerId: 'cust-2' }));
    const r = await fern(() => life.runConvertTransfers(deps(db), identity(String(nth++), 'transfers.convert_many_to_invoice'),
      rules.transferConvertManyBody(ids.map((id) => ({ id, revision: trev(db, id) })), { customerId: 'cust-2' })));
    ok(p.code === erwartet && r.code === erwartet, `BATCH ${was}: ${erwartet} auf beiden Wegen (${p.code} / ${r.code})`);
  }
  ok(n(db, 'SELECT COUNT(*) FROM invoices') === rechnungenVor && s(db, 'SELECT COALESCE(MAX(invoice_id), \'\') FROM agent_transfers') === '',
    'BATCH …und keine Teilmenge wurde fakturiert');
  ok(rules.canCombineTransfer({ status: 'sold' }) && !rules.canCombineTransfer({ status: 'settled' })
    && rules.canConvertTransfer({ status: 'settled' }) && !rules.canConvertTransfer({ status: 'sold', invoiceId: 'i' }),
  'BATCH die Auswahl der Liste und der Knopf der Zeile fragen dieselben Regeln');
  // Schon fakturiert — einzeln wie gesammelt.
  const ok1 = await fern(() => life.runConvertTransfers(deps(db), identity('90', 'transfers.convert_many_to_invoice'),
    rules.transferConvertManyBody([t1, t2].map((id) => ({ id, revision: trev(db, id) })), { customerId: 'cust-2' })));
  ok(ok1.ok, 'BATCH zwei verkaufte eines Agenten werden eine Rechnung');
  const twice = await fern(() => life.runConvertTransfer(deps(db), identity('91', 'transfers.convert_to_invoice'),
    rules.transferConvertBody({ id: t1, revision: trev(db, t1) }, { customerId: 'cust-2' })));
  const twiceP = await primary(() => house.convertTransferOnPrimary(t1, { customerId: 'cust-2' }));
  ok(twice.code === 'TRANSFER_ALREADY_INVOICED' && twiceP.code === 'TRANSFER_ALREADY_INVOICED',
    `AUTH ein fakturierter Transfer wird nicht noch einmal Rechnung (${twice.code} / ${twiceP.code})`);
}

// ── §9 Umwandeln: das Haus entscheidet ────────────────────────────────────
{
  const db = freshDb();
  const tid = await verkaufterTransfer(db, '92', 'cust-1', 'p1');
  const vor = S([n(db, 'SELECT COUNT(*) FROM invoices'), n(db, 'SELECT COUNT(*) FROM customers'), buchungen(db)]);
  const rumpf = rules.transferConvertBody({ id: tid, revision: trev(db, tid) }, { customerId: 'cust-2' });
  const faelle: Array<[string, () => Promise<Ausgang>, string]> = [
    ['ein Kunde einer fremden Filiale', () => fern(() => life.runConvertTransfer(deps(db), identity('93', 'transfers.convert_to_invoice'), { ...rumpf, customerId: 'cust-x' })), 'CUSTOMER_NOT_FOUND'],
    ['ein Platzhalter-Kunde', () => fern(() => life.runConvertTransfer(deps(db), identity('94', 'transfers.convert_to_invoice'), { ...rumpf, customerId: 'sys-walkin' })), 'CUSTOMER_NOT_FOUND'],
    ['ein fremder Transfer', () => fern(() => life.runConvertTransfer(deps(db), identity('95', 'transfers.convert_to_invoice'), { ...rumpf, transferId: 'tr-none' })), 'TRANSFER_NOT_FOUND'],
    ['eine alte Fassung', () => fern(() => life.runConvertTransfer(deps(db), identity('96', 'transfers.convert_to_invoice'), { ...rumpf, expectedRevision: trev(db, tid) - 1 })), 'RECORD_CHANGED'],
    ['ein Ausweis einer fremden Filiale', () => fern(() => life.runConvertTransfer(deps(db), fremd('97', 'transfers.convert_to_invoice'), rumpf)), 'BRANCH_MISMATCH'],
    ['fremde Filiale, gesammelt', () => fern(() => life.runConvertTransfers(deps(db), fremd('98', 'transfers.convert_many_to_invoice'),
      rules.transferConvertManyBody([{ id: tid, revision: trev(db, tid) }], { autoCustomer: true }))), 'BRANCH_MISMATCH'],
  ];
  for (const [was, lauf, erwartet] of faelle) {
    const r = await lauf();
    ok(r.code === erwartet, `AUTH ${was}: ${erwartet} (${r.code})`);
  }
  {
    const p1 = await primary(() => house.convertTransferOnPrimary(tid, { customerId: 'cust-x' }));
    const p2 = await primary(() => house.convertTransferOnPrimary(tid, { customerId: 'sys-walkin' }));
    ok(p1.code === 'CUSTOMER_NOT_FOUND' && p2.code === 'CUSTOMER_NOT_FOUND', `AUTH …am Primary dieselben Kunden-Regeln (${p1.code} / ${p2.code})`);
  }
  // Was das Haus rechnet oder bestimmt, reist nicht im Rumpf.
  for (const [f, v] of [['grossAmount', 1], ['lines', []], ['status', 'settled'], ['invoiceNumber', 'INV-1'], ['branchId', 'branch-other'],
    ['firstName', 'Evil'], ['customer', { firstName: 'Evil' }], ['taxScheme', 'ZERO'], ['settlementAmount', 1]] as Array<[string, unknown]>) {
    const r = await fern(() => life.runConvertTransfer(deps(db), identity('99', 'transfers.convert_to_invoice'), { ...rumpf, [f]: v }));
    ok(!r.ok, `AUTH der Rumpf setzt ${f} nicht (${r.code})`);
  }
  for (const [was, body] of [
    ['autoCustomer UND customerId', { ...rumpf, autoCustomer: true }],
    ['autoCustomer als Text', { transferId: tid, expectedRevision: trev(db, tid), autoCustomer: 'yes' }],
    ['ohne Kunde und ohne auto', { transferId: tid, expectedRevision: trev(db, tid) }],
  ] as Array<[string, Record<string, unknown>]>) {
    const r = await fern(() => life.runConvertTransfer(deps(db), identity('100', 'transfers.convert_to_invoice'), body));
    ok(!r.ok, `AUTH ${was} ist keine Wahl der Maske (${r.code})`);
  }
  ok(S([n(db, 'SELECT COUNT(*) FROM invoices'), n(db, 'SELECT COUNT(*) FROM customers'), buchungen(db)]) === vor,
    'AUTH …nach all dem: keine Rechnung, kein Kunde, keine Buchung');
}

// ── §7 Umwandeln ist EINE Handlung: jeder Bruch hinterlässt nichts ────────
async function bruchWelt(weg: 'primary' | 'fern', sammel: boolean, brich: (db: Db, ids: string[]) => () => void, nth: string) {
  const db = freshDb();
  const t1 = await verkaufterTransfer(db, nth + '1', 'cust-1', 'p1');
  const t2 = await verkaufterTransfer(db, nth + '2', 'cust-1', 'p2');
  const ids = sammel ? [t1, t2] : [t1];
  const vor = S([n(db, 'SELECT COUNT(*) FROM invoices'), n(db, 'SELECT COUNT(*) FROM invoice_lines'),
    n(db, 'SELECT COUNT(*) FROM customers'), buchungen(db), all(db, 'SELECT id, invoice_id, status, revision FROM agent_transfers ORDER BY id')]);
  const heilen = brich(db, ids);
  const lauf = () => (sammel
    ? (weg === 'primary'
      ? primary(() => house.convertTransfersOnPrimary(ids, { autoCustomer: true }))
      : fern(() => life.runConvertTransfers(deps(db), identity(nth + '9', 'transfers.convert_many_to_invoice'),
        rules.transferConvertManyBody(ids.map((id) => ({ id, revision: trev(db, id) })), { autoCustomer: true }))))
    : (weg === 'primary'
      ? primary(() => house.convertTransferOnPrimary(t1, { autoCustomer: true }))
      : fern(() => life.runConvertTransfer(deps(db), identity(nth + '9', 'transfers.convert_to_invoice'),
        rules.transferConvertBody({ id: t1, revision: trev(db, t1) }, { autoCustomer: true })))));
  let aus: Ausgang;
  try { aus = await lauf(); } finally { heilen(); }
  const nach = S([n(db, 'SELECT COUNT(*) FROM invoices'), n(db, 'SELECT COUNT(*) FROM invoice_lines'),
    n(db, 'SELECT COUNT(*) FROM customers'), buchungen(db), all(db, 'SELECT id, invoice_id, status, revision FROM agent_transfers ORDER BY id')]);
  // Danach — dieselbe Absicht, dieselbe Kennung — gelingt es genau einmal.
  const heil = await lauf();
  return { db, aus, gleich: vor === nach, heil, rechnungen: n(db, 'SELECT COUNT(*) FROM invoices'), kunden: n(db, 'SELECT COUNT(*) FROM customers') };
}
{
  const kundenBasis = 4;
  // (a) Zwischen Kunde und Rechnung.
  const zwischenKundeUndRechnung = (db: Db) => {
    const echt = useInvoiceStore.getState().createDirectInvoice;
    let imFehler = -1;
    useInvoiceStore.setState({
      createDirectInvoice: (() => {
        imFehler = n(db, 'SELECT COUNT(*) FROM customers');
        throw new Error('R5D: failure between customer and invoice');
      }) as never,
    });
    return () => {
      useInvoiceStore.setState({ createDirectInvoice: echt });
      ok(imFehler === kundenBasis + 1, `ROLLBACK im Fehler stand der neue Kunde schon (${imFehler})`);
    };
  };
  // (b) Zwischen Rechnung und Verknüpfung — der Transfer weigert sich, die Rechnung zu tragen.
  const zwischenRechnungUndLink = (db: Db, ids: string[]) => {
    const letzter = ids[ids.length - 1];
    db.run(`CREATE TRIGGER r5d_bruch BEFORE UPDATE OF invoice_id ON agent_transfers
      WHEN NEW.invoice_id IS NOT NULL AND NEW.id = '${letzter}'
      BEGIN SELECT RAISE(ABORT, 'R5D: failure between invoice and transfer link'); END`);
    return () => { db.run('DROP TRIGGER IF EXISTS r5d_bruch'); };
  };
  const faelle: Array<[string, boolean, (db: Db, ids: string[]) => () => void]> = [
    ['einzeln, zwischen Kunde und Rechnung', false, zwischenKundeUndRechnung],
    ['einzeln, zwischen Rechnung und Verknuepfung', false, zwischenRechnungUndLink],
    ['gesammelt, zwischen Kunde und Rechnung', true, zwischenKundeUndRechnung],
    ['gesammelt, mitten in den Verknuepfungen', true, zwischenRechnungUndLink],
  ];
  let nth = 20;
  for (const [was, sammel, brich] of faelle) {
    for (const weg of ['primary', 'fern'] as const) {
      const w = await bruchWelt(weg, sammel, brich, String(nth++));
      ok(!w.aus.ok, `ROLLBACK ${weg} ${was}: kein Erfolg gemeldet (${w.aus.code.slice(0, 60)})`);
      ok(w.gleich, `ROLLBACK ${weg} ${was}: keine Rechnung, keine Zeile, kein Kunde, keine Buchung, kein Transfer beruehrt`);
      ok(w.heil.ok && w.rechnungen === 1 && w.kunden === kundenBasis + 1,
        `ROLLBACK ${weg} ${was}: danach gelingt es genau einmal (${w.heil.code || 'ok'} · ${w.rechnungen}/${w.kunden})`);
    }
  }
}

// ── §5 Eine Domäne: die Masken und die Fernbefehle rufen dieselbe Folge ──
{
  const table = codeOf(src('src/components/agents/TransferTable.tsx'));
  const detail = codeOf(src('src/pages/agents/TransferDetail.tsx'));
  const list = codeOf(src('src/pages/agents/AgentList.tsx'));
  for (const [name, t] of [['TransferTable', table], ['TransferDetail', detail]] as Array<[string, string]>) {
    ok(!/createCustomer\(/.test(t), `DOMAIN ${name} legt keinen Kunden mehr selbst an`);
    ok(!/convertTransferToInvoice\(|convertTransfersToInvoice\(/.test(t), `DOMAIN ${name} ruft die Umwandlung des Stores nicht selbst`);
    ok(/convertTransferOnPrimary\(/.test(t) && /transferConvertBody\(/.test(t), `DOMAIN ${name}: Primary-Anschluss und Fernrumpf aus der geteilten Domaene`);
    ok(/canConvertTransfer\(/.test(t), `DOMAIN ${name}: der Knopf fragt die geteilte Regel`);
    ok(!/status === 'sold' \|\| \w+\.status === 'settled'/.test(t), `DOMAIN ${name}: keine zweite Statusliste`);
    ok(/w\.save\('transfers\.convert_to_invoice'/.test(t), `DOMAIN ${name}: GENAU eine Buchung fuer die Handlung`);
    ok(!/customers\.create/.test(t), `DOMAIN ${name}: kein vorgeschalteter Kundenbefehl`);
  }
  ok(/const isEligibleForBulk = \(t: AgentTransfer\) => canCombineTransfer\(t\);/.test(table), 'DOMAIN die Auswahl der Liste fragt die Regel');
  ok(/convertTransfersOnPrimary\(/.test(table) && /transferConvertManyBody\(/.test(table), 'DOMAIN die Sammelrechnung ebenso');
  ok(!/createTransferForCustomer\(/.test(list) && /createTransferOnPrimary\(/.test(list) && /transferCreateBody\(/.test(list),
    'DOMAIN die Anlegemaske ruft die geteilte Folge');
  const svc = codeOf(src('src/core/bridge/service-commands.ts'));
  const lc = codeOf(src('src/core/bridge/lifecycle-commands.ts'));
  ok(/createTransferInHouse\(/.test(svc) && !/PRODUCT_ALREADY_OUT|createTransferForCustomer\(/.test(svc),
    'DOMAIN der Fernbefehl „anlegen" ruft dieselbe Folge — ohne eigene Pruefliste');
  ok(/convertTransferInHouse\(/.test(lc) && /convertTransfersInHouse\(/.test(lc) && /transferConvertBlocker\(/.test(lc),
    'DOMAIN die Fernbefehle „umwandeln" ebenso, mit derselben Sperrregel');
  ok(!/s\(row\.status\) !== 'sold'|createCustomer\(/.test(lc), 'DOMAIN …ohne eigene Statusliste und ohne eigenen Kundenweg');
  const h = codeOf(src('src/core/agents/transfer-house.ts'));
  ok(!/vatEngine|calculateNet|INSERT INTO|UPDATE \w+ SET|getNextDocumentNumber/.test(h),
    'DOMAIN die Folge rechnet keine Steuer, legt keine Zeile an, vergibt keine Nummer — das tut das Haus');
  ok(/as\.convertTransferToInvoice\(/.test(h) && /as\.convertTransfersToInvoice\(/.test(h) && /createTransferForCustomer\(/.test(h),
    'DOMAIN …sie ruft die Funktionen des Hauses');
  // Der Kunde aus dem Agenten steht an GENAU einer Stelle.
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(f) && /Auto-created from agent/.test(readFileSync(p, 'utf8'))) files.push(p.slice(repo.length + 1));
    }
  };
  walk(resolvePath(repo, 'src'));
  ok(files.length === 1 && /transfer-rules/.test(files[0]), `DOMAIN der Kunde aus dem Agenten entsteht an EINER Stelle (${files.join(', ')})`);
  // Die Klammer am Primary: exklusiv, eine Transaktion, dann durabel.
  ok(/runExclusive\(/.test(h) && /beginLedgerTransaction\(\)/.test(h) && /rollbackLedgerTransaction\(\)/.test(h) && /saveDatabaseDurably\(\)/.test(h),
    'DOMAIN die Maske des Primary schreibt in EINER Klammer');
  ok((h.match(/return amPrimary\(/g) || []).length === 3, 'DOMAIN …fuer alle drei Handlungen');
}

// ════════════════════════════════════════════════════════════════════════════
// R5D.1 — die drei Verträge des Primary, gegen den Stand VOR R5D (27768c0) gepinnt, und die zwei
// übrigen Einstiege der gemeinsamen Oberfläche (Detailseite, „+ New Client").
// ════════════════════════════════════════════════════════════════════════════
const VOR_R5D = '27768c0';
const damals = (p: string): string => execFileSync('git', ['show', `${VOR_R5D}:${p}`], { cwd: repo, encoding: 'utf8' });
const economics = await import('../../src/core/agent/economics.ts');

// ── PRICE: „Our Price" > 0 war der Vertrag — nur ein Minus ging mangels Prüfung durch ──
{
  const maske = damals('src/pages/agents/AgentList.tsx');
  ok(/ourPrice: Number\(e\.target\.value\) \|\| undefined/.test(maske)
    && /disabled=\{!transferForm\.customerId \|\| !transferForm\.productId \|\| !transferForm\.ourPrice\}/.test(maske),
  'PRICE vor R5D: die Anlegemaske machte aus 0 und einem leeren Feld „kein Preis" und sperrte den Knopf');
  ok(!/ourPrice\s*[<>]=?\s*0|ourPrice < 0/.test(maske), 'PRICE vor R5D: …ein Minus prueft sie nirgends — eine fehlende Pruefung, kein Fachfall');
  const fern = damals('src/core/bridge/service-commands.ts');
  ok(/price <= 0\) \{\s*throw new ServicePayloadError\('agentPrice must be a positive number'\)/.test(fern)
    && /p <= 0\) \{\s*throw new ServicePayloadError\('agentPrice must be a positive number'\)/.test(fern),
  'PRICE vor R5D: der Fernbefehl verlangte > 0 seit C3F — beim Anlegen UND beim Aendern');
  // Was nachgelagert einen positiven Boden voraussetzt: beim Modell „split" ist Our Price der Boden.
  for (const [boden, erwartet] of [[-500, 'TRANSFER_NO_SETTLEMENT'], [0, 'TRANSFER_NO_SETTLEMENT'], [300, null]] as Array<[number, string | null]>) {
    const s0 = economics.computeAgentTransferSale({ settlementModel: 'split', agentPrice: boden, excessSplitPct: 0 }, 400).ourSettlement;
    const b = rules.transferConvertBlocker({ status: 'sold', settlementAmount: s0 });
    ok((b?.code ?? null) === erwartet, `PRICE Boden ${boden} bei „split" 0 %: Abrechnung ${s0} → ${b?.code ?? 'Rechnung moeglich'}`);
  }
  // Heute: EINE Regel fuer Anlegen und Aendern, Primary wie fern.
  for (const v of [0, -1, Number.NaN]) {
    let code = '';
    try { rules.transferEditPatch({ agentPrice: v }); } catch (e) { code = (e as { code?: string }).code ?? ''; }
    let fern = '';
    try { cmd.parseTransferUpdate({ id: 't1', expectedRevision: 1, agentPrice: v }); } catch (e) { fern = String(e); }
    ok(code === 'INVALID_AMOUNT' && fern !== '', `PRICE Aendern auf ${v}: am Primary INVALID_AMOUNT, fern abgewiesen`);
  }
  const voll = { id: 't1', status: 'sold', settlementAmount: 999, agentPrice: 750, returnBy: '', notes: 'n', invoiceId: 'x', staffId: 'e' };
  const patch = rules.transferEditPatch(voll as never);
  ok(S(patch) === S({ agentPrice: 750, returnBy: null, notes: 'n' }),
    `PRICE der Schreibsatz der Aenderungsmaske traegt genau Preis, Rueckgabe (leer = keins) und Notiz (${S(patch)})`);
  for (const f of ['src/components/agents/TransferTable.tsx', 'src/pages/agents/TransferDetail.tsx']) {
    const t = codeOf(src(f));
    ok(/local: \(\) => \{ updateTransfer\(\w+(\.id)?, transferEditPatch\(\w+\)/.test(t) && /expectedRevision: fassung, \.\.\.transferEditPatch\(/.test(t),
      `PRICE ${f.split('/').pop()}: beide Anschluesse schreiben denselben Satz`);
  }
}

// ── STOCK: nur ein Stück im Lager — das war die Liste der Maske und die Prüfung des Fernbefehls ──
{
  ok(/products\.filter\(p => p\.stockStatus === 'in_stock'\)/.test(damals('src/pages/agents/AgentList.tsx')),
    'STOCK vor R5D: die Artikelliste der Anlegemaske zeigte NUR, was im Lager liegt');
  const fern = damals('src/core/bridge/service-commands.ts');
  ok(/status !== 'in_stock'/.test(fern) && /PRODUCT_ALREADY_OUT/.test(fern), 'STOCK vor R5D: der Fernbefehl pruefte Lager und „schon draussen" seit C3F');
  ok(/PRODUCT_NOT_AVAILABLE/.test(damals('test/bridge/service-documents.test.ts')),
    'STOCK vor R5D: …und ein Test hielt es fest („verkaufte Ware geht nicht auf Kommission")');
  for (const st of ['in_stock', 'with_agent', 'sold', 'in_repair', 'reserved', 'consignment', 'returned', '']) {
    ok(rules.isTransferableStock(st) === (st === 'in_stock'), `STOCK „${st || '(leer)'}" ${st === 'in_stock' ? 'geht' : 'geht nicht'} hinaus`);
  }
  ok(/products\.filter\(p => isTransferableStock\(p\.stockStatus\)\)/.test(codeOf(src('src/pages/agents/AgentList.tsx'))),
    'STOCK heute: die Liste der Maske fragt DIESELBE Regel wie das Haus');
  ok(/if \(!isTransferableStock\(stock\)\)/.test(codeOf(src('src/core/agents/transfer-rules.ts'))), 'STOCK …und die Pruefung beim Anlegen ebenso');
}

// ── SHARE: 0–100 % war die Maske — nicht die Regel der Kommission ──
{
  const maske = damals('src/pages/agents/AgentList.tsx');
  ok(/excessSplitPct: Math\.max\(0, Math\.min\(100, Number\(e\.target\.value\) \|\| 0\)\)/.test(maske)
    && /excessSplitPct \?\? 50/.test(maske), 'SHARE vor R5D: die Maske begrenzte auf 0–100 und nahm ohne Eingabe 50');
  ok(/data\.excessSplitPct \?\? 50/.test(damals('src/stores/agentStore.ts')), 'SHARE vor R5D: das Haus speicherte den Wert ohne weitere Grenze');
  ok(/pct <= 0 \|\| pct >= 100/.test(damals('src/core/bridge/service-commands.ts')),
    'SHARE vor R5D: nur der Fernbefehl wich ab (1–99, mit Verweis auf die Kommission) — die Abweichung ist geschlossen');
  let pinnte = '';
  try { pinnte = execFileSync('git', ['grep', '-l', '1 and 99', VOR_R5D, '--', 'test'], { cwd: repo, encoding: 'utf8' }); } catch { pinnte = ''; }
  ok(pinnte.trim() === '', 'SHARE vor R5D: kein Test hielt 1–99 fuer Transfers fest');
  const e0 = economics.computeAgentTransferSale({ settlementModel: 'split', agentPrice: 1000, excessSplitPct: 0 }, 1200);
  const e100 = economics.computeAgentTransferSale({ settlementModel: 'split', agentPrice: 1000, excessSplitPct: 100 }, 1200);
  ok(e0.ourSettlement === 1000 && e0.customerShare === 200 && e100.ourSettlement === 1200 && e100.customerShare === 0,
    'SHARE beide Raender sind Fachfaelle: 0 % — der Kunde behaelt den Ueberschuss, 100 % — das Haus');
  ok(S(['150', '-5', 'abc', '55.5', '0', '100'].map(rules.clampTransferSplitPct)) === S([100, 0, 0, 55.5, 0, 100]),
    'SHARE heute: dieselbe Begrenzung wie die Maske, als EINE Funktion');
  ok(/clampTransferSplitPct\(e\.target\.value\)/.test(codeOf(src('src/pages/agents/AgentList.tsx'))), 'SHARE …und die Maske benutzt sie');
  for (const [pct, gut] of [[0, true], [100, true], [55.5, true], [100.5, false], [-0.5, false]] as Array<[number, boolean]>) {
    let p = true; try { rules.normalizeTransferCreate({ ...FORM, excessSplitPct: pct }); } catch { p = false; }
    let r = true; try { cmd.parseTransferCreate({ customerId: 'c', productId: 'p', agentPrice: 1, settlementModel: 'split', excessSplitPct: pct }); } catch { r = false; }
    ok(p === gut && r === gut, `SHARE ${pct} %: ${gut ? 'erlaubt' : 'abgewiesen'} — Primary und fern dieselbe Regel`);
  }
  ok(!/consignment/i.test(src('src/core/agents/transfer-rules.ts').replace(/Kommission/g, '')), 'SHARE die Regel des Transfers leiht nichts von der Kommission');
}

// ── DETAIL: Edit, Sold, Return der Detailseite über die geteilten Buchungen ──
{
  const d = codeOf(src('src/pages/agents/TransferDetail.tsx'));
  const ohneAnschluss = d.replace(/local: \(\) => \{[^\n]*\n/g, '');
  for (const [op, fn] of [['transfers.update', 'updateTransfer'], ['transfers.mark_sold', 'markTransferSold'], ['transfers.mark_returned', 'markTransferReturned']]) {
    ok(new RegExp(`w\\.ok\\('${op.replace('.', '\\.')}'`).test(d), `DETAIL ${op} ueber die gemeinsame Weiche`);
    ok(!new RegExp(`\\b${fn}\\(`).test(ohneAnschluss), `DETAIL ${fn}() steht nur noch im Primary-Anschluss`);
  }
  ok(/acknowledgeBelowPrice: true/.test(d), 'DETAIL die Bestaetigung unter Our Price reist mit — wie die Maske sie verlangt');
  ok((d.match(/loadTransfers\(\)/g) || []).length >= 4, 'DETAIL nach jedem Erfolg wird frisch gelesen');
  ok(/<WriteError text=\{w\.fehler\} \/>/.test(d) && /disabled=\{w\.busy\}/.test(d), 'DETAIL Ausgang sichtbar, Knopf waehrenddessen gesperrt');
}

// ── NEW CLIENT: „+ New Client" legt über `customers.create` an — genau einmal ──
{
  const m = codeOf(src('src/components/customers/QuickCustomerModal.tsx'));
  ok(/useSharedWrite<\{ customerId: string \}>\('customers\.create'\)/.test(m), 'CLIENT die Schnellanlage benutzt die vorhandene Buchung');
  ok((m.match(/createCustomer\(/g) || []).length === 1 && /local: \(\) => \(\{ customerId: createCustomer\(felder\)\.id \}\)/.test(m),
    'CLIENT createCustomer() nur im Primary-Anschluss');
  ok(/remote: \(\) => createPayload\(felder, CUSTOMER_EDITABLE\)/.test(m), 'CLIENT fern derselbe Rumpf wie die Kundenliste');
  const custCmd = await import('../../src/core/bridge/customer-commands.ts');
  const { createPayload, CUSTOMER_EDITABLE } = await import('../../src/core/data/write-payloads.ts');
  const db = freshDb();
  const rumpf = createPayload({ firstName: 'Lina', lastName: 'Client', phone: undefined, whatsapp: undefined, vatAccountNumber: undefined, personalId: undefined }, CUSTOMER_EDITABLE);
  const vor = n(db, 'SELECT COUNT(*) FROM customers');
  const a = await fern(() => custCmd.runCustomerCreate(deps(db), identity('701', 'customers.create'), rumpf));
  const b = await fern(() => custCmd.runCustomerCreate(deps(db), identity('701', 'customers.create'), rumpf));
  ok(a.ok && b.ok && b.replayed === true && a.value?.customerId === b.value?.customerId,
    'CLIENT die verlorene Antwort: dieselbe Kennung liefert denselben Kunden');
  ok(n(db, 'SELECT COUNT(*) FROM customers') === vor + 1, 'CLIENT …und es gibt ihn genau einmal');
  const neu = String(a.value?.customerId);
  const t = await fern(() => cmd.runTransferCreate(deps(db), identity('702', 'transfers.create'),
    rules.transferCreateBody({ customerId: neu, productId: 'p1', ourPrice: 500 })));
  ok(t.ok, `CLIENT …und sofort als Empfaenger eines Transfers waehlbar (${t.code || 'ok'})`);
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central ui parity r5d transfer parity: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R5D_TRANSFER_SCOPE_FROZEN');
console.log('CENTRAL_UI_R5D_TRANSFER_CREATE_SEMANTICS_AUDITED');
console.log('CENTRAL_UI_R5D_SINGLE_CONVERT_SEMANTICS_AUDITED');
console.log('CENTRAL_UI_R5D_BATCH_CONVERT_SEMANTICS_AUDITED');
console.log('CENTRAL_UI_R5D_SHARED_TRANSFER_DOMAIN_PROVED');
console.log('CENTRAL_UI_R5D_TRANSFER_CREATE_ATOMICITY_PROVED');
console.log('CENTRAL_UI_R5D_TRANSFER_CONVERSION_ATOMICITY_PROVED');
console.log('CENTRAL_UI_R5D_TRANSFER_INPUT_AUTHORITY_PROVED');
console.log('CENTRAL_UI_R5D_TRANSFER_PRICE_CONTRACT_PINNED');
console.log('CENTRAL_UI_R5D_TRANSFER_STOCK_CONTRACT_PINNED');
console.log('CENTRAL_UI_R5D_TRANSFER_SHARE_CONTRACT_PINNED');
