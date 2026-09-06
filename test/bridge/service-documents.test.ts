// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-C3F — Reparatur und Agenten-Transfer von einem zweiten Rechner.
// Run: node test/bridge/service-documents.test.ts
//
// Der Befund, der diesen Schnitt geprägt hat: „Transfer" heißt hier NICHT Filialtransfer.
// `agent_transfers` trägt EIN Produkt, keine Menge, keine Quell- oder Zielfiliale — der
// Bestandseffekt ist ein Statuswechsel am Artikel. „Quelle reduzieren, Ziel erhöhen" gibt es in
// diesem Haus nicht, und es wurde auch nicht erfunden: geprüft wird der Vertrag, den es gibt.
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
const { COMMAND_LEDGER_DDL, COMMAND_LEDGER_INDEX } = await import('../../src/core/bridge/command-ledger.ts');
const { resetDurabilityStateForTest } = await import('../../src/core/bridge/durability-state.ts');
const { resetTransactionHealthForTest } = await import('../../src/core/db/transaction-health.ts');
const { installWriteGuard } = await import('../../src/core/db/write-guard.ts');
const { SKU_SEQUENCES_DDL } = await import('../../src/core/products/sku-sequence.ts');
const cmd = await import('../../src/core/bridge/service-commands.ts');
await import('../../src/core/bridge/financial-commands.ts');
const { executeCommand, ALLOWED_MUTATIONS, knownCommands } =
  await import('../../src/core/bridge/command-registry.ts');
await import('../../src/core/bridge/read-commands.ts');
await import('../../src/core/bridge/customer-commands.ts');
await import('../../src/core/bridge/product-commands.ts');
await import('../../src/core/bridge/invoice-lifecycle-commands.ts');
await import('../../src/core/bridge/commercial-commands.ts');
await import('../../src/core/bridge/financial-commands.ts');
await import('../../src/core/bridge/return-commands.ts');
await import('../../src/core/bridge/lifecycle-commands.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const { useRepairStore } = await import('../../src/stores/repairStore.ts');
const { useAgentStore } = await import('../../src/stores/agentStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const codeOf = (p: string): string => src(p).split(/\r?\n/)
  .filter((l) => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')); })
  .join('\n');
const NOW = '2026-09-09T10:00:00.000Z';

interface Db {
  run(sql: string, p?: unknown[]): unknown;
  exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
  export(): Uint8Array;
}
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const n = (db: Db, sql: string, p: unknown[] = []): number => Number(one(db, sql, p) ?? 0);
const s = (db: Db, sql: string, p: unknown[] = []): string => String(one(db, sql, p) ?? '');

function realMigrations(): string[] {
  const dbSrc = src('src/core/db/database.ts');
  const start = dbSrc.indexOf('const migrations: string[] = [');
  const end = dbSrc.indexOf('\n  ];', start);
  return [...dbSrc.slice(start, end).matchAll(/`([^`]*)`/g)].map((m) => m[1]);
}
const MIGRATIONS = realMigrations();

function freshDb(): Db {
  const db = new SQL.Database() as unknown as Db;
  db.run(src('src/core/db/schema.sql'));
  for (const stmt of MIGRATIONS) { try { db.run(stmt); } catch { /* schon da */ } }
  for (const stmt of A1_UPGRADE_SQL) { try { db.run(stmt); } catch { /* schon da */ } }
  db.run(COMMAND_LEDGER_DDL);
  db.run(COMMAND_LEDGER_INDEX);
  db.run(SKU_SEQUENCES_DDL);
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-main','tenant-1','Haupt',?,?)", [NOW, NOW]);
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES ('cat-w','branch-main','Watches','w','#000',?,?)", [NOW, NOW]);
  db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level,
      preferences, customer_type, sales_stage, created_at, updated_at)
    VALUES ('cust-1','branch-main','Ali','Hassan','BH','en',0,'[]','collector','active',?,?)`, [NOW, NOW]);
  db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level,
      preferences, customer_type, sales_stage, created_at, updated_at)
    VALUES ('cust-2','branch-main','Nora','Salem','BH','en',0,'[]','collector','active',?,?)`, [NOW, NOW]);
  db.run(`INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at)
    VALUES ('sup-1','branch-main','Workshop',1,?,?)`, [NOW, NOW]);
  db.run(`INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at)
    VALUES ('sup-other','branch-other','Fremd',1,?,?)`, [NOW, NOW]);
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  useProductStore.getState().loadProducts();
  useRepairStore.getState().loadRepairs();
  useAgentStore.getState().loadAgents();
  useAgentStore.getState().loadTransfers();
  return db;
}

function seedProduct(db: Db, id: string, status = 'in_stock'): void {
  db.run(
    `INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
       scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
       tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
     VALUES (?,?,'cat-w','Rolex',?,?,1,'Pre-Owned','[]',100,'BHD',150,?,'VAT_10',0,'[]','{}','OWN',?,?)`,
    [id, 'branch-main', 'M ' + id, 'SKU-' + id, status, NOW, NOW],
  );
  useProductStore.getState().loadProducts();
}

const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-000000000000`;
// CENTRAL-C4 — die Rolle gehoert zum Absender: der Fernweg prueft sie, bevor er etwas ausfuehrt.
const ACTOR = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test', role: 'ADMIN' };
const identity = (x: string, op: string, hash = 'h' + x) => ({ commandId: ID(x), ...ACTOR, op, payloadHash: hash });
const deps = (db: Db) => ({
  db: db as never,
  begin: posting.beginLedgerTransaction,
  commit: posting.commitLedgerTransaction,
  rollback: posting.rollbackLedgerTransaction,
  durableSave: async () => {},
  now: () => NOW,
});
const val = <T>(o: unknown): T => (o as { value: T }).value;
const code = (o: unknown): string => (o as { code?: string }).code ?? '';
const rrev = (db: Db, id: string): number => n(db, 'SELECT revision FROM repairs WHERE id = ?', [id]);
const trev = (db: Db, id: string): number => n(db, 'SELECT revision FROM agent_transfers WHERE id = ?', [id]);
const pstatus = (db: Db, id: string): string => s(db, 'SELECT stock_status FROM products WHERE id = ?', [id]);

const REPAIR = {
  customerId: 'cust-1',
  itemBrand: 'Rolex',
  itemModel: 'Submariner',
  issueDescription: 'Krone klemmt',
  repairType: 'internal' as const,
  estimatedCost: 40,
  chargeToCustomer: 100,
};
const TRANSFER = { customerId: 'cust-1', productId: 'p1', agentPrice: 500 };

// ── 1) Umfang: was freigegeben ist — und was ausdrücklich nicht ───────────
{
  const list = ALLOWED_MUTATIONS as readonly string[];
  // CENTRAL-C3H hat die sechzehn in C3G als `B_DEFERRED` klassifizierten Aktionen freigeschaltet.
  // Was DIESE Datei prueft, aendert sich dadurch nicht — nur die Zahlen ziehen mit, und die
  // Namen, die weiterhin NICHT drauf stehen duerfen, bleiben dieselben zerstoerenden.
  ok(list.length === 40, `SCOPE genau 40 Mutationen (${list.length})`);
  for (const op of ['repairs.create', 'repairs.update', 'transfers.create', 'transfers.update', 'transfers.mark_returned']) {
    ok(list.includes(op), `SCOPE ${op} steht namentlich auf der Liste`);
  }
  for (const op of ['repairs.update_status', 'repairs.create_invoice', 'repairs.add_line',
    'transfers.convert_to_invoice']) {
    ok(list.includes(op), `SCOPE ${op} ist seit C3H freigegeben`);
  }
  for (const op of ['repairs.delete', 'transfers.delete', 'transfers.undo_convert',
    'repairs.action', 'transfers.action', 'repairs.set_status']) {
    ok(!list.includes(op), `SCOPE ${op} bleibt fail-closed`);
  }
  const known = knownCommands();
  const reads = known.filter((o) => o.endsWith('.list') || o.endsWith('.get'));
  ok(known.length === 59 && reads.length === 18,
    `SCOPE 1 Probe + 18 Reads + 40 Mutationen = 59 (${known.length}/${reads.length})`);
  const rust = src('src-tauri/src/bridge.rs');
  for (const op of ['repairs.list', 'repairs.get', 'transfers.list', 'transfers.get',
    'repairs.create', 'repairs.update', 'transfers.create', 'transfers.update', 'transfers.mark_returned']) {
    ok(rust.includes(`"${op}"`), `SCOPE Rust kennt ${op} ebenfalls`);
  }

  // Der BEFUND: es gibt keinen Filialtransfer, und deshalb auch keine Mengenbewegung.
  const tree = src('src/core/db/schema.sql') + src('src/core/db/database.ts') + src('src/stores/agentStore.ts');
  ok(!/destination_branch|source_branch|to_branch_id|from_branch_id/.test(tree),
    'SCOPE es gibt im Haus keinen Filialtransfer — kein Quell-/Zielfilialfeld');
  ok(!/CREATE TABLE IF NOT EXISTS agent_transfer_lines/.test(tree),
    'SCOPE …und keine Transferzeilen: ein Transfer traegt EIN Stueck');
}

// ── 2) Transfernummern: kein MAX()+1, und das wird gefahren ───────────────
{
  const seq = codeOf('src/core/agents/transfer-sequence.ts');
  const agents = codeOf('src/stores/agentStore.ts');
  ok(/ensureTransferSequence/.test(agents) && /getNextDocumentNumber\(TRANSFER_DOC_TYPE\)/.test(agents),
    'NUMBERING der Transfer zieht seine Nummer aus dem durablen Zaehler');
  ok(!/getNextNumber\(\s*'agent_transfers'/.test(agents),
    'NUMBERING …und nicht mehr aus MAX(Bestand)+1');
  ok(/document_sequences/.test(seq), 'NUMBERING der Zaehler liegt in document_sequences');
  const mine = codeOf('src/core/bridge/service-commands.ts');
  ok(!/getNextDocumentNumber|ensureTransferSequence|SELECT\s+MAX\s*\(/i.test(mine),
    'NUMBERING der Fernweg vergibt selbst keine Nummer');

  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  const db = freshDb();
  seedProduct(db, 'p1');
  seedProduct(db, 'p2');
  const [a, b] = await Promise.all([
    executeCommand('transfers.create', { input: TRANSFER }, identity('1', 'transfers.create', 'a')),
    executeCommand('transfers.create', { input: { ...TRANSFER, productId: 'p2', customerId: 'cust-2' } },
      identity('2', 'transfers.create', 'b')),
  ]);
  ok(a.kind === 'ok' && b.kind === 'ok', `NUMBERING zwei gleichzeitige Transfers entstehen (${a.kind}/${b.kind})`);
  const numbers = db.exec('SELECT transfer_number FROM agent_transfers').flatMap((r) => r.values.map((v) => String(v[0])));
  ok(numbers.length === 2 && new Set(numbers).size === 2,
    `NUMBERING …mit zwei verschiedenen Nummern (${numbers.join(', ')})`);
  ok(numbers.every((x) => /^TRF-\d{4}-\d{5}$/.test(x)), `NUMBERING …im Hausformat (${numbers.join(', ')})`);

  // Die Wiederholung verbrennt KEINE zweite Nummer.
  const counterBefore = n(db, "SELECT next_number FROM document_sequences WHERE doc_type = 'TRF'");
  const again = await executeCommand('transfers.create', { input: TRANSFER }, identity('1', 'transfers.create', 'a'));
  ok(again.kind === 'ok', 'NUMBERING die Wiederholung antwortet');
  ok(n(db, "SELECT next_number FROM document_sequences WHERE doc_type = 'TRF'") === counterBefore,
    'NUMBERING …und der Zaehler steht still');
  ok(n(db, 'SELECT COUNT(*) FROM agent_transfers') === 2, 'NUMBERING kein dritter Transfer');

  // Eine geloeschte Nummer wird NICHT wieder ausgegeben — genau der historische A1-Defekt.
  const highest = numbers.map((x) => Number(x.split('-')[2])).sort((x, y) => y - x)[0];
  db.run('DELETE FROM agent_transfers');
  seedProduct(db, 'p3');
  const after = await executeCommand('transfers.create', { input: { ...TRANSFER, productId: 'p3' } },
    identity('3', 'transfers.create', 'c'));
  ok(after.kind === 'ok', 'NUMBERING nach dem Loeschen entsteht ein neuer Transfer');
  const fresh = s(db, 'SELECT transfer_number FROM agent_transfers LIMIT 1');
  ok(Number(fresh.split('-')[2]) > highest,
    `NUMBERING …mit einer NEUEN Nummer, nicht der freigewordenen (${fresh} > ${highest})`);
}

// ── 3) Der Bestandsvertrag eines Transfers — so, wie es ihn gibt ──────────
{
  resetDurabilityStateForTest();
  const db = freshDb();
  const d = deps(db);
  seedProduct(db, 'p1');

  ok(pstatus(db, 'p1') === 'in_stock', 'STOCK vorher liegt das Stueck im Lager');
  const out = await cmd.runTransferCreate(d, identity('10', 'transfers.create'), TRANSFER);
  ok(out.kind === 'ok', `STOCK der Transfer entsteht (${JSON.stringify(out)})`);
  const v = val<{ transferId: string; transferNumber: string; agentId: string; status: string }>(out);
  ok(pstatus(db, 'p1') === 'with_agent', 'STOCK danach ist es beim Agenten…');
  ok(s(db, "SELECT source_type FROM products WHERE id = 'p1'") === 'AGENT', 'STOCK …und gehoert nicht mehr uns');
  ok(n(db, "SELECT quantity FROM products WHERE id = 'p1'") === 1,
    'STOCK die MENGE bleibt 1 — ein Agenten-Transfer bucht keine Menge, er verschiebt einen Zustand');
  ok(v.status === 'transferred', `STOCK der Transfer steht auf „transferred" (${v.status})`);
  ok(n(db, 'SELECT COUNT(*) FROM agents WHERE customer_id = ?', ['cust-1']) === 1,
    'STOCK das Haus hat den Agenten zum Kunden angelegt — der Client nennt keinen');

  // Zurueck: der Gegenpol, und er ist vollstaendig.
  const rev = trev(db, v.transferId);
  const back = await cmd.runTransferReturn(d, identity('11', 'transfers.mark_returned'),
    { id: v.transferId, expectedRevision: rev });
  ok(back.kind === 'ok', `STOCK die Rueckgabe geht durch (${JSON.stringify(back)})`);
  ok(pstatus(db, 'p1') === 'in_stock', 'STOCK das Stueck liegt wieder im Lager…');
  ok(s(db, "SELECT source_type FROM products WHERE id = 'p1'") === 'OWN', 'STOCK …und gehoert wieder uns');
  ok(s(db, 'SELECT status FROM agent_transfers WHERE id = ?', [v.transferId]) === 'returned',
    'STOCK der Transfer ist zurueck');
  ok(s(db, 'SELECT returned_at FROM agent_transfers WHERE id = ?', [v.transferId]) !== '',
    'STOCK …mit Zeitpunkt');

  // Es gibt keinen halben Zustand: entweder beide Wirkungen oder keine.
  const seq = n(db, "SELECT next_number FROM document_sequences WHERE doc_type = 'TRF'");
  seedProduct(db, 'p-sold', 'sold');
  const refused = await cmd.runTransferCreate(d, identity('12', 'transfers.create'), { ...TRANSFER, productId: 'p-sold' });
  ok(refused.kind === 'rejected' && code(refused) === 'PRODUCT_NOT_AVAILABLE',
    `ATOMIC verkaufte Ware geht nicht auf Kommission (${JSON.stringify(refused)})`);
  ok(pstatus(db, 'p-sold') === 'sold', 'ATOMIC …und ihr Zustand bleibt unberuehrt');
  ok(n(db, "SELECT next_number FROM document_sequences WHERE doc_type = 'TRF'") === seq,
    'ATOMIC …und es wurde keine Nummer verbrannt');
}

// ── 4) Wiederholung und Wettlauf um dasselbe Stück ────────────────────────
{
  resetDurabilityStateForTest();
  const db = freshDb();
  const d = deps(db);
  seedProduct(db, 'p1');

  const first = await cmd.runTransferCreate(d, identity('20', 'transfers.create'), TRANSFER);
  const again = await cmd.runTransferCreate(d, identity('20', 'transfers.create'), TRANSFER);
  ok(first.kind === 'ok' && again.kind === 'ok', 'RETRY die Wiederholung antwortet');
  ok((again as { replayed: boolean }).replayed === true, 'RETRY …und sagt, dass sie es war');
  ok(val<{ transferId: string }>(first).transferId === val<{ transferId: string }>(again).transferId,
    'RETRY derselbe Transfer');
  ok(n(db, 'SELECT COUNT(*) FROM agent_transfers') === 1, 'RETRY kein zweiter Transfer');
  ok(n(db, 'SELECT COUNT(*) FROM agents') === 1, 'RETRY kein zweiter Agent');
  ok(pstatus(db, 'p1') === 'with_agent', 'RETRY das Stueck ist EINMAL hinaus, nicht zweimal');

  const conflict = await cmd.runTransferCreate(d, identity('20', 'transfers.create', 'ANDERS'),
    { ...TRANSFER, agentPrice: 999 });
  ok(conflict.kind === 'rejected' && code(conflict) === 'COMMAND_ID_CONFLICT',
    'RETRY gleiche Kennung + anderer Rumpf → Konflikt');
  ok((conflict as { frozen: boolean }).frozen === false, 'RETRY …und wird nicht eingefroren');

  // Die Rueckgabe ebenso: dieselbe Kennung bucht sie nicht zweimal.
  const tid = val<{ transferId: string }>(first).transferId;
  const rev = trev(db, tid);
  const r1 = await cmd.runTransferReturn(d, identity('21', 'transfers.mark_returned'), { id: tid, expectedRevision: rev });
  const r2 = await cmd.runTransferReturn(d, identity('21', 'transfers.mark_returned'), { id: tid, expectedRevision: rev });
  ok(r1.kind === 'ok' && r2.kind === 'ok' && (r2 as { replayed: boolean }).replayed === true,
    'RETURN-RETRY die Wiederholung bekommt das eingefrorene Ergebnis');
  ok(s(db, 'SELECT status FROM agent_transfers WHERE id = ?', [tid]) === 'returned',
    'RETURN-RETRY der Transfer ist zurueck…');
  ok(pstatus(db, 'p1') === 'in_stock', 'RETURN-RETRY …und das Stueck liegt wieder im Lager');
  ok(n(db, 'SELECT COUNT(*) FROM agent_transfers') === 1, 'RETURN-RETRY es gibt weiterhin genau einen Transfer');

  // Und eine ZWEITE, bewusst neue Rueckgabe wird abgelehnt statt still durchgewinkt.
  const freshRev = trev(db, tid);
  const third = await cmd.runTransferReturn(d, identity('22', 'transfers.mark_returned'), { id: tid, expectedRevision: freshRev });
  ok(third.kind === 'rejected' && code(third) === 'TRANSFER_ALREADY_RETURNED',
    `RETURN eine zweite Rueckgabe ist ein Nein (${JSON.stringify(third)})`);
}
{
  // Zwei Clients, dasselbe letzte Stück: nur einer bekommt es.
  resetDurabilityStateForTest();
  const db = freshDb();
  seedProduct(db, 'p1');
  const [x, y] = await Promise.all([
    executeCommand('transfers.create', { input: TRANSFER }, identity('30', 'transfers.create', 'x')),
    executeCommand('transfers.create', { input: { ...TRANSFER, customerId: 'cust-2' } }, identity('31', 'transfers.create', 'y')),
  ]);
  const wins = [x, y].filter((r) => r.kind === 'ok').length;
  ok(wins === 1, `RACE genau einer bekommt das Stueck (${wins}/2: ${JSON.stringify([x.kind, y.kind])})`);
  const loser = [x, y].find((r) => r.kind !== 'ok');
  ok(['PRODUCT_NOT_AVAILABLE', 'PRODUCT_ALREADY_OUT'].includes((loser as { code?: string })?.code ?? ''),
    `RACE …und der andere bekommt eine Begruendung (${JSON.stringify(loser)})`);
  ok(n(db, 'SELECT COUNT(*) FROM agent_transfers') === 1, 'RACE es gibt genau einen Transfer');
  ok(n(db, "SELECT quantity FROM products WHERE id = 'p1'") === 1,
    'RACE und die Menge ist nie negativ geworden');
  ok(pstatus(db, 'p1') === 'with_agent', 'RACE das Stueck ist einmal hinaus');
}

// ── 5) Reparatur: Vertrag und Autorität ──────────────────────────────────
{
  resetDurabilityStateForTest();
  const db = freshDb();
  const d = deps(db);

  const out = await cmd.runRepairCreate(d, identity('40', 'repairs.create'), REPAIR);
  ok(out.kind === 'ok', `REPAIR die Reparatur entsteht (${JSON.stringify(out)})`);
  const v = val<{ repairId: string; repairNumber: string; status: string; voucherCode: string; margin: number | null }>(out);
  ok(/^REP-\d{4}-\d{5}$/.test(v.repairNumber), `REPAIR die Nummer kommt aus dem Zaehler (${v.repairNumber})`);
  ok(v.status === 'received', `REPAIR der Anfangsstatus kommt vom Haus (${v.status})`);
  ok(v.voucherCode.length === 8, `REPAIR der Gutscheincode auch (${v.voucherCode})`);
  ok(s(db, 'SELECT repair_scope FROM repairs WHERE id = ?', [v.repairId]) === 'CUSTOMER',
    'REPAIR aus der Ferne entsteht nur die KUNDEN-Reparatur');

  // Wiederholung.
  const again = await cmd.runRepairCreate(d, identity('40', 'repairs.create'), REPAIR);
  ok(again.kind === 'ok' && (again as { replayed: boolean }).replayed === true, 'REPAIR-RETRY antwortet');
  ok(n(db, 'SELECT COUNT(*) FROM repairs') === 1, 'REPAIR-RETRY keine zweite Reparatur');
  ok(val<{ repairNumber: string }>(again).repairNumber === v.repairNumber, 'REPAIR-RETRY dieselbe Nummer');

  // Neins.
  const noCustomer = await cmd.runRepairCreate(d, identity('41', 'repairs.create'), { ...REPAIR, customerId: 'gibt-es-nicht' });
  ok(noCustomer.kind === 'rejected' && code(noCustomer) === 'CUSTOMER_NOT_FOUND', 'REPAIR unbekannter Kunde → Nein');
  const foreign = await cmd.runRepairCreate(d, identity('42', 'repairs.create'),
    { ...REPAIR, repairType: 'external' as const, workshopSupplierId: 'sup-other' });
  ok(foreign.kind === 'rejected' && code(foreign) === 'SUPPLIER_NOT_FOUND',
    'REPAIR eine Werkstatt einer FREMDEN Filiale ist keine Werkstatt dieser');

  // Der Rumpf bestimmt nichts, was das Haus bestimmt.
  const bad: Array<[string, unknown]> = [
    ['eine Belegnummer', { ...REPAIR, repairNumber: 'REP-2026-00099' }],
    ['einen Gutscheincode', { ...REPAIR, voucherCode: 'AAAAAAAA' }],
    ['einen Status', { ...REPAIR, status: 'ready' }],
    ['eine Marge', { ...REPAIR, margin: 500 }],
    ['eine Filiale', { ...REPAIR, branchId: 'branch-other' }],
    ['eine Kennung', { ...REPAIR, id: 'rep-erfunden' }],
    ['eine Rechnung', { ...REPAIR, invoiceId: 'inv-1' }],
    ['einen Bereich', { ...REPAIR, repairScope: 'OWN' }],
    ['ein Produkt', { ...REPAIR, productId: 'p1' }],
    ['einen Geldweg', { ...REPAIR, customerPaidFrom: 'cash' }],
    ['einen Zeitpunkt', { ...REPAIR, receivedAt: NOW }],
  ];
  for (const [what, body] of bad) {
    let threw = '';
    try { cmd.parseRepairCreate(body); } catch (e) { threw = e instanceof Error ? e.message : String(e); }
    ok(threw !== '', `AUTHORITY der Reparaturrumpf nimmt ${what} nicht an (${threw || 'DURCHGELASSEN'})`);
  }
  for (const f of ['status', 'repairNumber', 'voucherCode', 'margin', 'invoiceId', 'repairScope',
    'productId', 'customerId', 'customerPaidFrom', 'internalPaidFrom', 'receivedAt']) {
    let threw = false;
    try { cmd.parseRepairUpdate({ id: 'r1', expectedRevision: 1, [f]: 'x' }); } catch { threw = true; }
    ok(threw, `AUTHORITY ein Reparatur-Aenderungsauftrag kann ${f} nicht setzen`);
  }
  let threw = false;
  try { cmd.parseRepairUpdate({ id: 'r1', diagnosis: 'x' }); } catch { threw = true; }
  ok(threw, 'AUTHORITY ohne die gesehene Fassung gibt es kein Aendern');
}

// ── 6) Reparatur ändern: Abgeleitetes rechnet der Primary ────────────────
{
  resetDurabilityStateForTest();
  const db = freshDb();
  const d = deps(db);
  const created = await cmd.runRepairCreate(d, identity('50', 'repairs.create'), REPAIR);
  const rid = val<{ repairId: string }>(created).repairId;
  const base = rrev(db, rid);

  // Nur der Kundenpreis aendert sich — die Marge muss der Primary NEU rechnen, mit den ALTEN Kosten.
  const edited = await cmd.runRepairUpdate(d, identity('51', 'repairs.update'),
    { id: rid, expectedRevision: base, chargeToCustomer: 150, diagnosis: 'Krone ersetzt' });
  ok(edited.kind === 'ok', `REPAIR-EDIT die Aenderung geht durch (${JSON.stringify(edited)})`);
  const ev = val<{ chargeToCustomer: number; internalCost: number; margin: number; revision: number }>(edited);
  ok(ev.chargeToCustomer === 150, 'REPAIR-EDIT der neue Preis steht');
  ok(ev.internalCost === 40, `REPAIR-EDIT die internen Kosten leiten sich aus dem Voranschlag ab (${ev.internalCost})`);
  ok(ev.margin === 110, `REPAIR-EDIT die Marge ist NEU gerechnet (150 − 40 = ${ev.margin})`);
  ok(ev.revision > base, `REPAIR-EDIT die Fassung ist gestiegen (${base} → ${ev.revision})`);
  ok(s(db, 'SELECT diagnosis FROM repairs WHERE id = ?', [rid]) === 'Krone ersetzt',
    'REPAIR-EDIT …und die Diagnose steht in der Zeile');

  // Der alte Stand traegt nicht mehr.
  const stale = await cmd.runRepairUpdate(d, identity('52', 'repairs.update'),
    { id: rid, expectedRevision: base, chargeToCustomer: 1 });
  ok(stale.kind === 'rejected' && code(stale) === 'RECORD_CHANGED',
    `REPAIR-STALE der alte Stand traegt nicht (${JSON.stringify(stale)})`);
  ok((stale as { frozen: boolean }).frozen === true, 'REPAIR-STALE …und das Urteil ist endgueltig');
  ok(n(db, 'SELECT charge_to_customer FROM repairs WHERE id = ?', [rid]) === 150,
    'REPAIR-STALE nichts wurde ueberschrieben');
}

// ── 7) Deckung: jede echte Mutation bewegt die Fassung ───────────────────
{
  resetDurabilityStateForTest();
  const db = freshDb();
  const d = deps(db);
  const created = await cmd.runRepairCreate(d, identity('60', 'repairs.create'), REPAIR);
  const rid = val<{ repairId: string }>(created).repairId;
  const rs = () => useRepairStore.getState();

  const moves = (label: string, fn: () => void): void => {
    const before = rrev(db, rid);
    fn();
    ok(rrev(db, rid) > before, `REPAIR-COVERAGE ${label} bewegt die Fassung (${before} → ${rrev(db, rid)})`);
  };
  moves('updateRepair (Kopf)', () => rs().updateRepair(rid, { notes: 'kopf' }));
  moves('updateStatus', () => rs().updateStatus(rid, 'diagnosed'));
  let lineId = '';
  moves('addRepairLine (nur repair_lines)', () => {
    lineId = rs().addRepairLine(rid, { supplierId: 'sup-1', workType: 'service', costAmount: 25 } as never).id;
  });
  moves('updateRepairLine (nur repair_lines)', () => rs().updateRepairLine(lineId, { costAmount: 30 } as never));
  moves('cancelRepairLine (nur repair_lines — im Haus ein Loeschen)', () => rs().cancelRepairLine(lineId));
  ok(n(db, 'SELECT COUNT(*) FROM repair_lines WHERE id = ?', [lineId]) === 0,
    'REPAIR-COVERAGE …und „cancel" heisst im Haus wirklich loeschen');
  moves('addRepairLine (zweite)', () => {
    lineId = rs().addRepairLine(rid, { supplierId: 'sup-1', workType: 'service', costAmount: 15 } as never).id;
  });
  const before = rrev(db, rid);
  db.run("UPDATE repairs SET customer_payment_status = 'PAID' WHERE id = ?", [rid]);
  ok(rrev(db, rid) > before, 'REPAIR-COVERAGE auch der Tageslauf (rohes SQL am Kopf) bewegt sie');
  const b2 = rrev(db, rid);
  db.run("UPDATE repair_lines SET status = 'DONE' WHERE repair_id = ?", [rid]);
  ok(rrev(db, rid) > b2, 'REPAIR-COVERAGE …und rohes SQL an der ZEILE ebenso');
}
{
  resetDurabilityStateForTest();
  const db = freshDb();
  const d = deps(db);
  seedProduct(db, 'p1');
  const created = await cmd.runTransferCreate(d, identity('70', 'transfers.create'), TRANSFER);
  const tid = val<{ transferId: string }>(created).transferId;
  const as = () => useAgentStore.getState();

  const moves = (label: string, fn: () => void): void => {
    const before = trev(db, tid);
    fn();
    ok(trev(db, tid) > before, `TRANSFER-COVERAGE ${label} bewegt die Fassung (${before} → ${trev(db, tid)})`);
  };
  moves('updateTransfer (Kopf)', () => as().updateTransfer(tid, { notes: 'kopf' }));
  moves('markTransferSold', () => as().markTransferSold(tid, 600, 'Kaeufer', true));
  moves('markTransferSettled', () => as().markTransferSettled(tid, 100, 'cash'));
  const before = trev(db, tid);
  db.run("INSERT INTO agent_settlement_payments (id, transfer_id, amount, method, paid_at, created_at) VALUES ('raw-1', ?, 5, 'cash', ?, ?)",
    [tid, NOW, NOW]);
  ok(trev(db, tid) > before,
    `TRANSFER-COVERAGE auch eine roh eingefuegte Abrechnungszahlung bewegt sie (${before} → ${trev(db, tid)})`);
  const b2 = trev(db, tid);
  db.run("DELETE FROM agent_settlement_payments WHERE id = 'raw-1'");
  ok(trev(db, tid) > b2, 'TRANSFER-COVERAGE …und ihr Loeschen ebenfalls');

  // Ein FREMDER Transfer bewegt diese Fassung nicht.
  seedProduct(db, 'p9');
  const other = await cmd.runTransferCreate(d, identity('71', 'transfers.create'),
    { ...TRANSFER, productId: 'p9', customerId: 'cust-2' });
  const mine = trev(db, tid);
  useAgentStore.getState().updateTransfer(val<{ transferId: string }>(other).transferId, { notes: 'fremd' });
  ok(trev(db, tid) === mine, 'TRANSFER-COVERAGE ein fremder Transfer bewegt sie nicht');
}

// ── 8) Rennen um den Lebenszyklus ────────────────────────────────────────
{
  resetDurabilityStateForTest();
  const db = freshDb();
  const d = deps(db);
  seedProduct(db, 'p1');
  const created = await cmd.runTransferCreate(d, identity('80', 'transfers.create'), TRANSFER);
  const tid = val<{ transferId: string }>(created).transferId;

  // Der Client liest N, der Primary nimmt die Ware zurueck, der Client aendert mit N.
  const seen = trev(db, tid);
  useAgentStore.getState().markTransferReturned(tid);
  const stale = await cmd.runTransferUpdate(d, identity('81', 'transfers.update'),
    { id: tid, expectedRevision: seen, agentPrice: 999 });
  ok(stale.kind === 'rejected' && code(stale) === 'TRANSFER_NOT_OPEN',
    `RACE-LIFECYCLE ein zurueckgegebener Transfer wird nicht mehr geaendert (${JSON.stringify(stale)})`);
  ok(n(db, 'SELECT agent_price FROM agent_transfers WHERE id = ?', [tid]) === 500,
    'RACE-LIFECYCLE nichts wurde ueberschrieben');

  // Und dieselbe Sicherung ueber die FASSUNG, wenn der Zustand offen bleibt.
  seedProduct(db, 'p2');
  const t2 = val<{ transferId: string }>(
    await cmd.runTransferCreate(d, identity('82', 'transfers.create'), { ...TRANSFER, productId: 'p2', customerId: 'cust-2' }),
  ).transferId;
  const seen2 = trev(db, t2);
  useAgentStore.getState().updateTransfer(t2, { notes: 'Primary war schneller' });
  const stale2 = await cmd.runTransferUpdate(d, identity('83', 'transfers.update'),
    { id: t2, expectedRevision: seen2, agentPrice: 777 });
  ok(stale2.kind === 'rejected' && code(stale2) === 'RECORD_CHANGED',
    `RACE-LIFECYCLE eine fremde Aenderung entwertet den Fernauftrag (${JSON.stringify(stale2)})`);

  // Zwei Clients auf derselben Fassung: genau einer gewinnt.
  seedProduct(db, 'p3');
  const t3 = (await executeCommand('transfers.create',
    { input: { ...TRANSFER, productId: 'p3' } }, identity('84', 'transfers.create', 'z')) as { value: { transferId: string } }).value.transferId;
  const base = trev(db, t3);
  const [x, y] = await Promise.all([
    executeCommand('transfers.update', { input: { id: t3, expectedRevision: base, agentPrice: 111 } }, identity('85', 'transfers.update', 'p')),
    executeCommand('transfers.update', { input: { id: t3, expectedRevision: base, agentPrice: 222 } }, identity('86', 'transfers.update', 'q')),
  ]);
  ok([x, y].filter((r) => r.kind === 'ok').length === 1, 'RACE-TWO genau einer gewinnt');
  const price = n(db, 'SELECT agent_price FROM agent_transfers WHERE id = ?', [t3]);
  ok(price === 111 || price === 222, `RACE-TWO kein Lost Update (${price})`);
}

// ── 9) Kein Geschäfts-SQL im Fernweg, kein zweiter Weg ───────────────────
{
  const mine = codeOf('src/core/bridge/service-commands.ts');
  ok(!/INSERT INTO (repairs|repair_lines|agent_transfers|agents|agent_settlement_payments)/i.test(mine),
    'REUSE der Fernweg legt keine Zeile selbst an');
  ok(!/UPDATE (repairs|agent_transfers|products) SET/i.test(mine),
    'REUSE …und schreibt auch keine');
  ok(/createRepair|updateRepair|createTransferForCustomer|updateTransfer|markTransferReturned/.test(mine),
    'REUSE er ruft die bestehenden Domaenenfunktionen');
  ok((mine.match(/runRemoteCommand\(/g) ?? []).length === 5, 'TX alle fuenf laufen durch die eine Maschine');
  const rust = src('src-tauri/src/bridge.rs');
  const noComments = rust.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  ok(!/INSERT INTO|UPDATE\s+(repairs|agent_transfers)/i.test(noComments),
    'REUSE Rust schreibt keine Geschaeftsdaten');
  // Die aeussere Klammer: die Domaenenfunktionen oeffnen keine eigene.
  for (const [file, fn] of [['src/stores/repairStore.ts', 'createRepair'], ['src/stores/agentStore.ts', 'createTransfer']]) {
    const text = src(file);
    const start = text.indexOf(`  ${fn}: (`);
    const seg = text.slice(start, start + 9000);
    const nextFn = seg.slice(10).search(/\n  [a-zA-Z]+: \(/);
    const own = nextFn > 0 ? seg.slice(0, nextFn + 10) : seg;
    ok(!/beginLedgerTransaction\(\)/.test(own), `TX ${fn} hat KEINE eigene Klammer — die des Fernauftrags ist Pflicht`);
  }
}

// ── 10) Gegenproben: was OHNE die Riegel passiert ────────────────────────
{
  // (a) Ohne die Kindtabellen-Deckung bleibt die Fassung stehen und der stale Auftrag geht durch.
  resetDurabilityStateForTest();
  const db = freshDb();
  db.run('DROP TRIGGER IF EXISTS trg_repair_lines_insert_repairs_revision');
  db.run('DROP TRIGGER IF EXISTS trg_repair_lines_update_repairs_revision');
  db.run('DROP TRIGGER IF EXISTS trg_repair_lines_delete_repairs_revision');
  const d = deps(db);
  const created = await cmd.runRepairCreate(d, identity('90', 'repairs.create'), REPAIR);
  const rid = val<{ repairId: string }>(created).repairId;
  const seen = rrev(db, rid);
  db.run("INSERT INTO repair_lines (id, branch_id, repair_id, position, supplier_id, work_type, cost_amount, status, created_at, updated_at) VALUES ('l-raw','branch-main',?,2,'sup-1','service',99,'OPEN',?,?)",
    [rid, NOW, NOW]);
  ok(rrev(db, rid) === seen, 'CONTROL-A ohne den Trigger bewegt eine neue Arbeitszeile die Fassung NICHT');
  const blind = await cmd.runRepairUpdate(d, identity('91', 'repairs.update'), { id: rid, expectedRevision: seen, chargeToCustomer: 1 });
  ok(blind.kind === 'ok' && n(db, 'SELECT charge_to_customer FROM repairs WHERE id = ?', [rid]) === 1,
    `CONTROL-A …und der stale Auftrag ueberschreibt klaglos (${JSON.stringify(blind)})`);
}
{
  // (b) Eine erzwungene Transfernummer und ein erzwungener Reparaturstatus.
  for (const [what, body, parse] of [
    ['eine Transfernummer', { ...TRANSFER, transferNumber: 'TRF-2026-00099' }, cmd.parseTransferCreate],
    ['einen Agenten', { ...TRANSFER, agentId: 'agent-1' }, cmd.parseTransferCreate],
    ['einen Status', { ...TRANSFER, status: 'sold' }, cmd.parseTransferCreate],
    ['einen Verkaufspreis', { ...TRANSFER, actualSalePrice: 900 }, cmd.parseTransferCreate],
  ] as Array<[string, unknown, (r: unknown) => unknown]>) {
    let threw = '';
    try { parse(body); } catch (e) { threw = e instanceof Error ? e.message : String(e); }
    ok(threw !== '', `CONTROL-B der Transferrumpf nimmt ${what} nicht an (${threw || 'DURCHGELASSEN'})`);
  }
  for (const f of ['status', 'soldAt', 'returnedAt', 'settledAt', 'actualSalePrice', 'commissionAmount',
    'settlementAmount', 'settlementStatus', 'invoiceId', 'agentId', 'productId', 'settlementModel']) {
    let threw = false;
    try { cmd.parseTransferUpdate({ id: 't1', expectedRevision: 1, [f]: 'x' }); } catch { threw = true; }
    ok(threw, `CONTROL-B ein Transfer-Aenderungsauftrag kann ${f} nicht setzen`);
  }
}
{
  // (c) Eine fremde Mutation: solange ihr Name nicht auf der Liste steht, ist sie nicht
  //     registrierbar — und sobald er es tut, ist sie es. Die Liste IST der Riegel.
  const { registerCommand, ALLOWED_MUTATIONS: LIST } = await import('../../src/core/bridge/command-registry.ts');
  // ZUERST prüfen, dass der echte Name nichts erreicht — DANACH die Liste anfassen. Umgekehrt
  // bewiese die Gegenprobe am Ende das Gegenteil: sie hätte ihn selbst angemeldet.
  const unknown = await executeCommand('transfers.delete', { input: {} }, identity('99', 'transfers.delete', 'u'));
  ok(unknown.kind === 'infrastructure_error' && (unknown as { code: string }).code === 'BRIDGE_OP_NOT_REGISTERED',
    'CONTROL-C ein unbekannter Name erreicht nichts');
  const before = LIST.length;
  let refused = '';
  try { registerCommand('transfers.delete', { kind: 'mutation', handler: () => ({ ok: true }) }); }
  catch (e) { refused = e instanceof Error ? e.message : String(e); }
  ok(/refusing to register/.test(refused), 'CONTROL-C eine fremde Mutation laesst sich nicht anmelden');
  // Dass die LISTE der Riegel ist, wird an einem Namen gezeigt, den es sonst nirgends gibt —
  // sonst bliebe eine echte Operation angemeldet zurück.
  (LIST as string[]).push('nur.fuer.die.gegenprobe.c3f');
  let registered = false;
  try { registerCommand('nur.fuer.die.gegenprobe.c3f', { kind: 'mutation', handler: () => ({ ok: true }) }); registered = true; } catch { /* */ }
  ok(registered, 'CONTROL-C …und mit einem Namen darauf schon — die Liste ist der ganze Riegel');
  (LIST as string[]).splice(before);
  ok(LIST.length === before && !(LIST as string[]).includes('transfers.delete'),
    'CONTROL-C die Liste ist danach wieder genau so lang, und der echte Name steht NICHT darauf');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central c3f service documents: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
