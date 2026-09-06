// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-C3C — ein zweiter Rechner legt Kunden an und ändert sie.
// Run: node test/bridge/customer-remote-write.test.ts
//
// Gefahren wird der ECHTE Kundenweg: `createCustomer` / `updateCustomer` aus dem Store, die echten
// Transaktionsklammern aus `posting.ts`, die C3A-Maschine mit ihrem durablen Nachweis, das echte
// Schema. Gestellt ist nur das Speichern.
//
// Die Fragen, an denen es hängt: Darf der Client bestimmen, was ihm nicht gehört? Was passiert bei
// einer verlorenen Antwort? Und bleibt die Doppelgänger-Regel des Hauses die, die sie ist?
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync } from 'node:fs';
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

const store = new Map<string, string>([
  ['lataif_sync_url', 'https://primary.local'],
  ['lataif_sync_token', 'tok'],
  ['lataif_session', JSON.stringify({ branchId: 'branch-main', userId: 'user-test' })],
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
const { COMMAND_LEDGER_DDL, COMMAND_LEDGER_INDEX, lookupCommand, commandCount } =
  await import('../../src/core/bridge/command-ledger.ts');
const { resetDurabilityStateForTest, isDurabilityDegraded } =
  await import('../../src/core/bridge/durability-state.ts');
const { resetTransactionHealthForTest } = await import('../../src/core/db/transaction-health.ts');
const { installWriteGuard } = await import('../../src/core/db/write-guard.ts');
const {
  runCustomerCreate, runCustomerUpdate, parseCustomerCreate, parseCustomerUpdate, CustomerPayloadError,
} = await import('../../src/core/bridge/customer-commands.ts');
const registry = await import('../../src/core/bridge/command-registry.ts');
await import('../../src/core/bridge/read-commands.ts');
await import('../../src/core/bridge/invoice-command.ts');
await import('../../src/core/bridge/return-commands.ts');
await import('../../src/core/bridge/lifecycle-commands.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const NOW = '2026-09-05T10:00:00.000Z';

interface Db {
  run(sql: string, p?: unknown[]): unknown;
  exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
  export(): Uint8Array;
}
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];

function realMigrations(): string[] {
  const dbSrc = src('src/core/db/database.ts');
  const start = dbSrc.indexOf('const migrations: string[] = [');
  const end = dbSrc.indexOf('\n  ];', start);
  const block = dbSrc.slice(start, end);
  return [...block.matchAll(/`([^`]*)`/g)].map((m) => m[1]);
}
const MIGRATIONS = realMigrations();

function freshDb(): Db {
  const db = new SQL.Database() as unknown as Db;
  db.run(src('src/core/db/schema.sql'));
  for (const stmt of MIGRATIONS) { try { db.run(stmt); } catch { /* schon da */ } }
  for (const stmt of A1_UPGRADE_SQL) { try { db.run(stmt); } catch { /* schon da */ } }
  db.run(COMMAND_LEDGER_DDL);
  db.run(COMMAND_LEDGER_INDEX);
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-main','tenant-1','Haupt',?,?)", [NOW, NOW]);
  setTestDatabase(db as never);
  return db;
}

const ID = (n: string): string => `${n.padStart(8, '0')}-0000-4000-8000-000000000000`;
const identity = (n: string, op: string, hash = 'h1') => ({
  commandId: ID(n), tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test', role: 'ADMIN', op, payloadHash: hash,
});

function deps(db: Db, opts: { failSave?: boolean } = {}) {
  const state = { saves: 0, failSave: opts.failSave === true, disk: null as Uint8Array | null };
  return {
    state,
    deps: {
      db: db as never,
      begin: posting.beginLedgerTransaction,
      commit: posting.commitLedgerTransaction,
      rollback: posting.rollbackLedgerTransaction,
      durableSave: async () => {
        if (state.failSave) throw new Error('disk full');
        state.disk = db.export();
        state.saves += 1;
      },
      now: () => NOW,
    },
  };
}

const WISH = { firstName: 'Ali', lastName: 'Hassan', phone: '+973 1234', email: 'ali@example.com' };

// ── 1) Der Rumpf ist ein Wunsch, keine Anweisung ──────────────────────────
{
  for (const [field, raw] of [
    ['id', { ...WISH, id: 'cust-forged' }],
    ['branchId', { ...WISH, branchId: 'branch-fremd' }],
    ['createdBy', { ...WISH, createdBy: 'user-boss' }],
    ['totalRevenue', { ...WISH, totalRevenue: 99999 }],
    ['purchaseCount', { ...WISH, purchaseCount: 7 }],
    ['lastPurchaseAt', { ...WISH, lastPurchaseAt: NOW }],
    ['createdAt', { ...WISH, createdAt: NOW }],
  ] as const) {
    let threw: string | null = null;
    try { parseCustomerCreate(raw); } catch (e) { threw = String(e); }
    ok(threw !== null && new RegExp(field).test(threw), `AUTHORITY ${field} entscheidet der Primary (${threw})`);
  }

  let unknownField: string | null = null;
  try { parseCustomerCreate({ ...WISH, loyaltyPoints: 5 }); } catch (e) { unknownField = String(e); }
  ok(unknownField !== null && /unknown field/.test(unknownField),
    `AUTHORITY ein unbekanntes Feld wird abgewiesen statt still ignoriert (${unknownField})`);

  for (const [what, raw] of [
    ['ohne Namen', { phone: '+973' }],
    ['leere Namen', { firstName: '   ', lastName: '' }],
  ] as const) {
    let threw: string | null = null;
    try { parseCustomerCreate(raw); } catch (e) { threw = String(e); }
    ok(threw !== null && /first or last name/.test(threw), `AUTHORITY ${what}: kein Kunde (${threw})`);
  }

  for (const [what, raw] of [
    ['Zahl als Text', { ...WISH, budgetMin: 'viel' }],
    ['negatives Budget', { ...WISH, budgetMax: -1 }],
    ['Vorlieben als Text', { ...WISH, preferences: 'gold' }],
  ] as const) {
    let threw: string | null = null;
    try { parseCustomerCreate(raw); } catch (e) { threw = String(e); }
    ok(threw !== null, `AUTHORITY ${what} wird abgewiesen (${threw})`);
  }

  const clean = parseCustomerCreate({ ...WISH, preferences: ['gold'], vipLevel: 2, notes: null });
  ok(clean.firstName === 'Ali' && Array.isArray(clean.preferences) && clean.vipLevel === 2 && clean.notes === null,
    `AUTHORITY der erlaubte Wunsch kommt unveraendert durch (${JSON.stringify(clean)})`);

  // Aendern: eine Kennung, mindestens ein Feld, und nichts Verbotenes.
  let noId: string | null = null;
  try { parseCustomerUpdate({ firstName: 'Neu' }); } catch (e) { noId = String(e); }
  ok(noId !== null && /id is required/.test(noId), 'AUTHORITY ein Update ohne Kennung ist keins');
  let empty: string | null = null;
  try { parseCustomerUpdate({ id: 'c1' }); } catch (e) { empty = String(e); }
  ok(empty !== null && /nothing to change/.test(empty), 'AUTHORITY und ein leeres Update auch nicht');
  const upd = parseCustomerUpdate({ id: 'c1', phone: '+973 999' });
  ok(upd.id === 'c1' && upd.fields.phone === '+973 999', 'AUTHORITY ein gueltiges Update kommt durch');
}

// ── 2) Der echte Weg: anlegen und aendern ─────────────────────────────────
{
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  const db = freshDb();
  installWriteGuard(db as never);
  const { deps: d, state } = deps(db);

  const created = await runCustomerCreate(d, identity('1', 'customers.create'), { ...WISH, preferences: ['gold'] });
  ok(created.kind === 'ok', `CREATE der Kunde entsteht (${JSON.stringify(created)})`);
  const value = (created as { value: { customerId: string; name: string } }).value;
  ok(value.name === 'Ali Hassan', `CREATE mit seinem Namen (${value.name})`);
  ok(Number(one(db, 'SELECT COUNT(*) FROM customers')) === 1, 'CREATE genau ein Kunde');
  ok(String(one(db, 'SELECT branch_id FROM customers')) === 'branch-main',
    'CREATE die Filiale kommt aus der Sitzung, nicht aus dem Rumpf');
  ok(Number(one(db, 'SELECT total_revenue FROM customers')) === 0,
    'CREATE und die Summen stehen auf 0 — der Client kann sie nicht setzen');
  ok(String(one(db, 'SELECT preferences FROM customers')) === '["gold"]', 'CREATE die Vorlieben sind gespeichert');
  ok(commandCount(db as never) === 1, 'CREATE der durable Nachweis steht');
  ok(state.saves === 1, 'CREATE …und danach wurde genau einmal geschrieben');

  const updated = await runCustomerUpdate(d, identity('2', 'customers.update', 'h2'),
    { id: value.customerId, phone: '+973 555', notes: 'VIP' });
  ok(updated.kind === 'ok', `UPDATE die Aenderung geht durch (${JSON.stringify(updated)})`);
  ok(String(one(db, 'SELECT phone FROM customers')) === '+973 555', 'UPDATE die Nummer ist geaendert');
  ok(String(one(db, 'SELECT notes FROM customers')) === 'VIP', 'UPDATE und die Notiz');
  ok(String(one(db, 'SELECT first_name FROM customers')) === 'Ali', 'UPDATE der Rest bleibt unangetastet');
  ok(Number(one(db, 'SELECT COUNT(*) FROM customers')) === 1, 'UPDATE es bleibt bei einem Kunden');

  // Ein Kunde, den es nicht gibt, ist ein Urteil — kein stiller Erfolg.
  const missing = await runCustomerUpdate(d, identity('3', 'customers.update', 'h3'), { id: 'nicht-da', phone: '+1' });
  ok(missing.kind === 'rejected' && (missing as { code: string }).code === 'CUSTOMER_NOT_FOUND',
    `UPDATE ein unbekannter Kunde wird abgelehnt statt still ins Leere geschrieben (${JSON.stringify(missing)})`);
  ok((missing as { frozen: boolean }).frozen === true, 'UPDATE …und das Urteil ist eingefroren');
}

// ── 3) Verlorene Antwort: dieselbe Kennung, kein zweiter Kunde ────────────
{
  resetDurabilityStateForTest();
  const db = freshDb();
  installWriteGuard(db as never);
  const { deps: d } = deps(db);

  const first = await runCustomerCreate(d, identity('4', 'customers.create'), WISH);
  const id1 = (first as { value: { customerId: string } }).value.customerId;
  const changelogAfter = Number(one(db, 'SELECT COUNT(*) FROM sync_changelog'));

  const second = await runCustomerCreate(d, identity('4', 'customers.create'), WISH);
  ok(second.kind === 'ok' && (second as { replayed: boolean }).replayed === true, 'RETRY als Wiederholung erkannt');
  ok((second as { value: { customerId: string } }).value.customerId === id1, 'RETRY derselbe Kunde');
  ok(Number(one(db, 'SELECT COUNT(*) FROM customers')) === 1, 'RETRY kein zweiter Kunde');
  ok(Number(one(db, 'SELECT COUNT(*) FROM sync_changelog')) === changelogAfter, 'RETRY keine zweite Sync-Wirkung');

  const conflict = await runCustomerCreate(d, identity('4', 'customers.create', 'ANDERS'), { ...WISH, firstName: 'Anders' });
  ok(conflict.kind === 'rejected' && (conflict as { code: string }).code === 'COMMAND_ID_CONFLICT'
    && (conflict as { frozen: boolean }).frozen === false,
    `RETRY gleiche Kennung, anderer Rumpf: abgewiesen, nichts eingefroren (${JSON.stringify(conflict)})`);
  ok(Number(one(db, 'SELECT COUNT(*) FROM customers')) === 1, 'RETRY …und kein dritter Kunde');

  // Auch das Aendern ist genau einmal wirksam.
  let runs = 0;
  const upd = () => runCustomerUpdate(d, identity('5', 'customers.update', 'h5'), { id: id1, vipLevel: 3 });
  await upd(); runs += 1;
  const again = await upd(); runs += 1;
  ok(again.kind === 'ok' && (again as { replayed: boolean }).replayed === true && runs === 2,
    'RETRY die Wiederholung eines Updates liefert das eingefrorene Ergebnis');
  ok(Number(one(db, 'SELECT vip_level FROM customers')) === 3, 'RETRY der Wert steht genau einmal');
}

// ── 4) Speichern scheitert nach dem Commit ────────────────────────────────
{
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  const db = freshDb();
  installWriteGuard(db as never);
  const { deps: d, state } = deps(db, { failSave: true });

  let threw: string | null = null;
  try { await runCustomerCreate(d, identity('6', 'customers.create'), WISH); } catch (e) { threw = String(e); }
  ok(threw !== null && /disk full/.test(threw), `PERSIST kein definitiver Erfolg (${threw})`);
  ok(isDurabilityDegraded(), 'PERSIST die Speicherschuld steht');
  ok(Number(one(db, 'SELECT COUNT(*) FROM customers')) === 1, 'PERSIST der Kunde steht im Speicher');

  let retryErr: string | null = null;
  try { await runCustomerCreate(d, identity('6', 'customers.create'), WISH); } catch (e) { retryErr = String(e); }
  ok(retryErr !== null && Number(one(db, 'SELECT COUNT(*) FROM customers')) === 1,
    'PERSIST die Wiederholung legt keinen zweiten an');

  state.failSave = false;
  const settled = await runCustomerCreate(d, identity('6', 'customers.create'), WISH);
  ok(settled.kind === 'ok' && (settled as { replayed: boolean }).replayed === true && !isDurabilityDegraded(),
    'PERSIST nach gelungenem Nachholen das eingefrorene Ergebnis');
}

// ── 5) Dieselbe Doppelgaenger-Regel wie im Haus ───────────────────────────
//
// Das Haus BLOCKIERT keinen Doppelgaenger; es warnt und laesst den Menschen entscheiden. Eine
// Sperre hier waere eine zweite Regel fuer dieselbe Frage.
{
  resetDurabilityStateForTest();
  const db = freshDb();
  installWriteGuard(db as never);
  const { deps: d } = deps(db);

  await runCustomerCreate(d, identity('7', 'customers.create'), WISH);
  const twin = await runCustomerCreate(d, identity('8', 'customers.create', 'h8'), WISH);
  ok(twin.kind === 'ok' && Number(one(db, 'SELECT COUNT(*) FROM customers')) === 2,
    'DUPLICATE ein zweiter gleicher Name wird angelegt — wie lokal auch');

  const list = src('src/pages/customers/CustomerList.tsx');
  ok(/findSimilarContacts/.test(list) && /DuplicateWarningBanner/.test(list),
    'DUPLICATE die Warnung ist eine Anzeige, keine Sperre — und sie liegt im Haus');
  const cmd = src('src/core/bridge/customer-commands.ts');
  ok(!/findSimilarContacts|DUPLICATE|similar/i.test(cmd.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')),
    'DUPLICATE der Befehl erfindet keine eigene Doppelgaenger-Regel');
}

// ── 6) Keine zweite Kundenlogik ───────────────────────────────────────────
{
  const cmd = src('src/core/bridge/customer-commands.ts');
  ok(/createCustomer\(/.test(cmd) && /updateCustomer\(/.test(cmd),
    'REUSE der Befehl ruft die ECHTEN Store-Funktionen…');
  ok(!/INSERT INTO customers|UPDATE customers SET/i.test(cmd),
    'REUSE …und schreibt keine einzige Kundenzeile selbst');
  const rustSrc = src('src-tauri/src/bridge.rs');
  ok(!/INSERT INTO customers|first_name/i.test(rustSrc), 'REUSE und in Rust liegt keine Kundenlogik');
  ok(/runRemoteCommand\(/.test(cmd), 'REUSE er laeuft durch die C3A-Maschine');
  ok(/beginLedgerTransaction|commitLedgerTransaction/.test(cmd), 'REUSE …mit den Klammern des Hauses');
}

// ── 7) Die Zulassungsliste: genau drei Namen ──────────────────────────────
{
  await import('../../src/core/bridge/customer-commands.ts');
  await import('../../src/core/bridge/product-commands.ts');
  await import('../../src/core/bridge/invoice-lifecycle-commands.ts');
  await import('../../src/core/bridge/commercial-commands.ts');
  await import('../../src/core/bridge/service-commands.ts');
  await import('../../src/core/bridge/financial-commands.ts');
  const known = registry.knownCommands();
  const reads = known.filter((o) => o.endsWith('.list') || o.endsWith('.get'));
  const mutations = registry.ALLOWED_MUTATIONS;
  ok(mutations.length === 40 && mutations.includes('invoices.create')
    && mutations.includes('customers.create') && mutations.includes('customers.update'),
    `ALLOWLIST genau vierzig Mutationen (${mutations.join(', ')})`);
  ok(known.length === 59 && reads.length === 18 && known.includes('bridge.probe'),
    `ALLOWLIST 1 Probe + 18 Reads + 40 Mutationen = 59 (${known.length})`);

  for (const op of ['products.delete', 'customers.delete', 'invoice.delete', 'anything.write']) {
    let threw: string | null = null;
    try { registry.registerCommand(op, { kind: 'mutation', handler: () => ({ ok: true }) }); }
    catch (e) { threw = String(e); }
    ok(threw !== null && /refusing to register/.test(threw), `ALLOWLIST ${op} wird weiterhin abgewiesen`);
  }

  const rs = src('src-tauri/src/bridge.rs');
  const list = rs.slice(rs.indexOf('pub const REMOTE_OPS'), rs.indexOf('];', rs.indexOf('pub const REMOTE_OPS')));
  ok((list.match(/OP_[A-Z_]+/g) || []).length === 59, 'ALLOWLIST Rust kennt dieselben neunundfuenfzig Namen');
  ok(/OP_CUSTOMERS_CREATE: &str = "customers.create"/.test(rs) && /OP_CUSTOMERS_UPDATE: &str = "customers.update"/.test(rs),
    'ALLOWLIST …namentlich, nicht generisch');
}

// ── 8) Gegenproben ────────────────────────────────────────────────────────
{
  // (a) An der Maschine vorbei: der Store direkt gerufen — kein Nachweis, und die „Wiederholung"
  //     legt einen zweiten Kunden an. Genau das faengt §3.
  resetDurabilityStateForTest();
  const db = freshDb();
  const customerStore = await import('../../src/stores/customerStore.ts');
  customerStore.useCustomerStore.getState().createCustomer(WISH as never);
  customerStore.useCustomerStore.getState().createCustomer(WISH as never);
  ok(commandCount(db as never) === 0 && Number(one(db, 'SELECT COUNT(*) FROM customers')) === 2,
    'CONTROL a ohne die Maschine gibt es keinen Nachweis und zwei Kunden');

  // (b) Ohne die Verbotsliste kaeme ein erfundener Umsatz durch.
  const forged = { ...WISH, totalRevenue: 99999 };
  let blocked = false;
  try { parseCustomerCreate(forged); } catch { blocked = true; }
  ok(blocked && Object.keys(forged).includes('totalRevenue'),
    'CONTROL b der Rumpf ENTHIELT den erfundenen Umsatz — die Pruefung hat ihn geworfen, nicht das Formular');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central c3c customer remote write: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
console.log('CENTRAL_C3C_CUSTOMER_DOMAIN_REUSE_PROVED');
console.log('CENTRAL_C3C_CUSTOMER_PAYLOAD_AUTHORITY_PROVED');
console.log('CENTRAL_C3C_CUSTOMER_IDEMPOTENT_WRITE_PROVED');
