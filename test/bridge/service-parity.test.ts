// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-C3F FINAL — dieselbe Eingabe, dieselbe Zeile. Und was ein geschlossener Vorgang nicht
// mehr annimmt.
// Run: node test/bridge/service-parity.test.ts
//
// Der Befund, der diese Datei nötig gemacht hat: `createRepair` rechnet NICHTS. Die Ableitung der
// eigenen Kosten stand im Aufnahmebildschirm, VOR dem Store-Aufruf — und der Fernweg hatte sie
// nicht. Bei `repairType: 'external'` mit Voranschlag und ohne eigene Angabe speicherte der
// Primary `internalCost = estimatedCost`, der Fernweg `0`. Dieselbe Eingabe, zwei Zeilen.
//
// Deshalb wird hier nicht die Store-Funktion verglichen, sondern der GANZE produktive Callpath:
// links das, was der Bildschirm wirklich schickt, rechts der Fernauftrag — und danach die
// gespeicherten Zeilen Feld für Feld.
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
const ui = await import('../../src/core/bridge/client-service-request.ts');
const costs = await import('../../src/core/repairs/repair-cost.ts');
const { executeCommand, ALLOWED_MUTATIONS, knownCommands } =
  await import('../../src/core/bridge/command-registry.ts');
await import('../../src/core/bridge/read-commands.ts');
await import('../../src/core/bridge/customer-commands.ts');
await import('../../src/core/bridge/product-commands.ts');
await import('../../src/core/bridge/invoice-lifecycle-commands.ts');
await import('../../src/core/bridge/commercial-commands.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const { useRepairStore } = await import('../../src/stores/repairStore.ts');
const { useAgentStore } = await import('../../src/stores/agentStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { useCustomerStore } = await import('../../src/stores/customerStore.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const codeOf = (p: string): string => src(p).split(/\r?\n/)
  .filter((l) => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')); })
  .join('\n');
const NOW = '2026-09-10T10:00:00.000Z';

interface Db {
  run(sql: string, p?: unknown[]): unknown;
  exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
  export(): Uint8Array;
}
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const n = (db: Db, sql: string, p: unknown[] = []): number => Number(one(db, sql, p) ?? 0);
const s = (db: Db, sql: string, p: unknown[] = []): string => String(one(db, sql, p) ?? '');
const row = (db: Db, sql: string, p: unknown[] = []): Record<string, unknown> => {
  const r = db.exec(sql, p)[0];
  if (!r || r.values.length === 0) return {};
  return Object.fromEntries(r.columns.map((c, i) => [c, r.values[0][i]]));
};

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
  for (const [id, first] of [['cust-1', 'Ali'], ['cust-2', 'Nora']]) {
    db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level,
        preferences, customer_type, sales_stage, created_at, updated_at)
      VALUES (?,'branch-main',?,'Hassan','BH','en',0,'[]','collector','active',?,?)`, [id, first, NOW, NOW]);
  }
  db.run(`INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at)
    VALUES ('sup-1','branch-main','Workshop',1,?,?)`, [NOW, NOW]);
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  useProductStore.getState().loadProducts();
  useCustomerStore.getState().loadCustomers();
  useRepairStore.getState().loadRepairs();
  useAgentStore.getState().loadAgents();
  useAgentStore.getState().loadTransfers();
  return db;
}

function seedProduct(db: Db, id: string): void {
  db.run(
    `INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
       scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
       tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
     VALUES (?,?,'cat-w','Rolex',?,?,1,'Pre-Owned','[]',100,'BHD',150,'in_stock','VAT_10',0,'[]','{}','OWN',?,?)`,
    [id, 'branch-main', 'M ' + id, 'SKU-' + id, NOW, NOW],
  );
  useProductStore.getState().loadProducts();
}

const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-000000000000`;
const ACTOR = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test' };
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

/**
 * GENAU das, was der Aufnahmebildschirm an `createRepair` übergibt. Der Ausdruck stand dort als
 * Text; jetzt ist es dieselbe Primitive — und dieser Nachbau beweist, dass sie es ist.
 */
function localCreateRepair(form: Record<string, unknown>) {
  return useRepairStore.getState().createRepair({
    ...form, internalCost: costs.internalCostOnCreate(form as never),
  } as never);
}

const REPAIR_COMPARE = [
  'customer_id', 'item_brand', 'item_model', 'item_serial', 'issue_description', 'diagnosis',
  'repair_type', 'external_vendor', 'workshop_supplier_id', 'estimated_cost', 'actual_cost',
  'internal_cost', 'charge_to_customer', 'margin', 'status', 'tax_scheme', 'repair_scope',
  'product_id', 'invoice_id', 'notes',
];

// ── 1) Der echte Callpath der Aufnahme — als BEFUND ──────────────────────
{
  const list = codeOf('src/pages/repairs/RepairList.tsx');
  const detail = codeOf('src/pages/repairs/RepairDetail.tsx');
  const storeSrc = codeOf('src/stores/repairStore.ts');

  ok(/createRepair\(\{ \.\.\.form, internalCost: internalCostOnCreate\(form\) \}\)/.test(list),
    'CALLPATH die Aufnahme leitet die eigenen Kosten mit der GETEILTEN Primitive ab');
  ok(/internalCostOnEdit\(form\)/.test(detail) && /repairMargin\(form\)/.test(detail),
    'CALLPATH …und die Detailseite ebenso');
  for (const f of ['repair-cost']) {
    ok(src('src/pages/repairs/RepairList.tsx').includes(f) && src('src/pages/repairs/RepairDetail.tsx').includes(f),
      'CALLPATH beide Bildschirme laden dieselbe Quelle');
  }
  ok(src('src/core/bridge/service-commands.ts').includes('repair-cost'),
    'CALLPATH …und der Fernauftrag auch');
  ok(src('src/core/bridge/client-service-request.ts').includes('repair-cost'),
    'CALLPATH …und die Vorschau des Clients rechnet nicht selbst');

  // Und der Store rechnet weiterhin NICHTS davon — das ist der Grund, warum die Primitive nötig ist.
  // Die IMPLEMENTIERUNG, nicht die Schnittstellenzeile darueber — die traegt denselben Namen.
  const createSeg = storeSrc.slice(storeSrc.indexOf('  createRepair: (data) => {'), storeSrc.indexOf('  updateRepair: (id, data) => {'));
  // Genauer, als es zuerst dastand: `createRepair` leitet die KOPFZEILE nicht ab. Die eigenen
  // Kosten landen als `data.internalCost || 0` in der Spalte — ein Null-Vorgabewert, KEIN Rückfall
  // auf den Voranschlag. Genau deshalb braucht es die geteilte Primitive: den Rückfall macht der
  // Bildschirm, und ein zweiter Rechner müsste ihn nachtippen.
  ok(/data\.internalCost \|\| 0/.test(createSeg),
    'CALLPATH `createRepair` schreibt die eigenen Kosten, wie es sie bekommt (Null-Vorgabe, kein Rueckfall)');
  ok(!/data\.internalCost \|\| data\.estimatedCost/.test(createSeg),
    'CALLPATH …und kennt den Rueckfall der Kopfzeile auf den Voranschlag NICHT');
  ok(!/margin/.test(createSeg), 'CALLPATH …und eine Marge rechnet es ueberhaupt nicht');
  ok(/repair_number|voucher_code|'received'/.test(createSeg),
    'CALLPATH …aber Nummer, Gutscheincode und Anfangsstatus kommen von IHM');
  // Die EINE Ableitung, die es doch macht, betrifft die erste Arbeitszeile — und die teilen beide
  // Wege automatisch, weil sie im Store liegt.
  ok(/const cost = data\.repairType === 'hybrid'/.test(createSeg),
    'CALLPATH die Kosten der ersten Arbeitszeile leitet der Store selbst ab — geteilt, ohne Zutun');
}

// ── 2) Parität: dieselbe Eingabe, dieselbe Zeile ─────────────────────────
{
  // Die vier Fälle, in denen die Ableitung überhaupt etwas tut. Der zweite ist der, an dem der
  // Fernweg vorher auseinanderlief.
  const cases: Array<[string, Record<string, unknown>]> = [
    ['im eigenen Haus', { repairType: 'internal', estimatedCost: 40, chargeToCustomer: 100 }],
    ['Fremdarbeit ohne eigene Kostenangabe', { repairType: 'external', estimatedCost: 40, workshopSupplierId: 'sup-1', chargeToCustomer: 100 }],
    ['Fremdarbeit MIT eigener Angabe', { repairType: 'external', estimatedCost: 40, internalCost: 15, workshopSupplierId: 'sup-1', chargeToCustomer: 100 }],
    ['Mischarbeit', { repairType: 'hybrid', estimatedCost: 40, internalCost: 25, workshopSupplierId: 'sup-1', chargeToCustomer: 100 }],
  ];

  let idx = 0;
  for (const [label, input] of cases) {
    idx += 1;
    resetDurabilityStateForTest();
    resetTransactionHealthForTest();

    // A — der echte lokale Weg.
    const dbA = freshDb();
    const local = localCreateRepair({
      customerId: 'cust-1', itemBrand: 'Rolex', itemModel: 'Submariner',
      issueDescription: 'Krone klemmt', taxScheme: 'VAT_10', ...input,
    });
    const rowA = row(dbA, `SELECT ${REPAIR_COMPARE.join(', ')} FROM repairs WHERE id = ?`, [local.id]);
    const linesA = n(dbA, 'SELECT COUNT(*) FROM repair_lines WHERE repair_id = ?', [local.id]);
    const costA = n(dbA, 'SELECT COALESCE(SUM(cost_amount),0) FROM repair_lines WHERE repair_id = ?', [local.id]);
    const numA = s(dbA, 'SELECT repair_number FROM repairs WHERE id = ?', [local.id]);

    // B — der Fernauftrag, mit denselben Benutzereingaben.
    resetDurabilityStateForTest();
    const dbB = freshDb();
    const out = await cmd.runRepairCreate(deps(dbB), identity(String(idx), 'repairs.create'), {
      customerId: 'cust-1', itemBrand: 'Rolex', itemModel: 'Submariner',
      issueDescription: 'Krone klemmt', taxScheme: 'VAT_10', ...input,
    });
    ok(out.kind === 'ok', `PARITY (${label}) der Fernauftrag geht durch (${JSON.stringify(out)})`);
    const remoteId = val<{ repairId: string }>(out).repairId;
    const rowB = row(dbB, `SELECT ${REPAIR_COMPARE.join(', ')} FROM repairs WHERE id = ?`, [remoteId]);
    const linesB = n(dbB, 'SELECT COUNT(*) FROM repair_lines WHERE repair_id = ?', [remoteId]);
    const costB = n(dbB, 'SELECT COALESCE(SUM(cost_amount),0) FROM repair_lines WHERE repair_id = ?', [remoteId]);
    const numB = s(dbB, 'SELECT repair_number FROM repairs WHERE id = ?', [remoteId]);

    const diff = REPAIR_COMPARE.filter((f) => String(rowA[f] ?? '') !== String(rowB[f] ?? ''));
    ok(diff.length === 0,
      `PARITY (${label}) jede fachlich relevante Spalte stimmt ueberein${diff.length ? ' — ABWEICHUNG: '
        + diff.map((f) => `${f}: ${String(rowA[f])} vs ${String(rowB[f])}`).join(' | ') : ''}`);
    ok(linesA === linesB && costA === costB,
      `PARITY (${label}) gleiche Arbeitszeilen und gleiche Kosten (${linesA}/${costA} vs ${linesB}/${costB})`);
    ok(numA === numB, `PARITY (${label}) dieselbe Belegnummer aus demselben Zaehler (${numA})`);
    // Und die Zahl, an der es auseinanderlief, ausdrücklich benannt:
    ok(Number(rowA.internal_cost) === costs.internalCostOnCreate(input as never),
      `PARITY (${label}) die eigenen Kosten sind die der geteilten Ableitung (${rowA.internal_cost})`);
  }

  // Die Aufnahme setzt KEINE Marge — beide Seiten nicht. Das ist der Vertrag des Hauses.
  resetDurabilityStateForTest();
  const db = freshDb();
  const local = localCreateRepair({
    customerId: 'cust-1', issueDescription: 'x', repairType: 'internal', estimatedCost: 40, chargeToCustomer: 100,
  });
  ok(one(db, 'SELECT margin FROM repairs WHERE id = ?', [local.id]) === null,
    'PARITY die Aufnahme setzt KEINE Marge — auch lokal nicht');
}

// ── 3) Negativkontrolle: was ohne die geteilte Ableitung passiert ────────
{
  // Die alte Fernweg-Formel war „nimm, was dasteht, sonst 0". Gegen dieselbe Eingabe gehalten,
  // weicht sie ab — genau der Defekt, den dieser Schnitt behoben hat.
  const naive = (i: { internalCost?: number }): number => i.internalCost ?? 0;
  const input = { repairType: 'external', estimatedCost: 40 };
  ok(costs.internalCostOnCreate(input as never) === 40,
    'CONTROL die geteilte Ableitung ergibt 40 (der Voranschlag IST die Erwartung)');
  ok(naive(input as never) === 0, 'CONTROL …die alte Fernweg-Formel ergaebe 0');
  ok(costs.internalCostOnCreate(input as never) !== naive(input as never),
    'CONTROL …und genau diese Abweichung waere eine andere gespeicherte Zeile gewesen');

  // Und die beiden Ableitungen sind ABSICHTLICH verschieden — auch das wird festgehalten.
  const both = { repairType: 'internal', estimatedCost: 40, actualCost: 55 };
  ok(costs.internalCostOnCreate(both as never) === 0,
    'CONTROL bei eigener Arbeit rechnet die AUFNAHME den Voranschlag nicht ein');
  ok(costs.internalCostOnEdit(both as never) === 55,
    'CONTROL …beim AENDERN gewinnt der tatsaechliche Aufwand');
  ok(costs.totalRepairCost({ repairType: 'hybrid', estimatedCost: 40, internalCost: 25 } as never) === 65,
    'CONTROL und bei Mischarbeit zaehlen beide Teile (25 + 40)');
  ok(costs.repairMargin({ repairType: 'hybrid', estimatedCost: 40, internalCost: 25, chargeToCustomer: 100 } as never) === 35,
    'CONTROL …die Marge entsprechend (100 − 65)');
  ok(costs.repairMargin({ repairType: 'internal', estimatedCost: 40 } as never) === null,
    'CONTROL ohne Kundenpreis gibt es keine Marge — und das ist nicht 0');
}

// ── 4) Der Feldsatz des Transfer-Aenderns ────────────────────────────────
{
  const detail = codeOf('src/pages/agents/TransferDetail.tsx');
  const table = codeOf('src/components/agents/TransferTable.tsx');
  // BEFUND: beide echten Bildschirme bearbeiten GENAU drei Felder.
  for (const [name, text] of [['TransferDetail', detail], ['TransferTable', table]] as Array<[string, string]>) {
    const seg = text.slice(text.indexOf('Edit'), text.length);
    ok(/agentPrice/.test(seg) && /returnBy/.test(seg) && /notes/.test(seg),
      `SCOPE ${name} bearbeitet Preis, Rueckgabedatum und Notiz`);
    ok(!/setEditForm\(\{ \.\.\.editForm, productId|setEditTransferForm\(\{ \.\.\.editTransferForm, productId/.test(text),
      `SCOPE ${name} aendert den ARTIKEL nicht`);
    ok(!/setEditForm\(\{ \.\.\.editForm, agentId|setEditTransferForm\(\{ \.\.\.editTransferForm, agentId/.test(text),
      `SCOPE ${name} aendert den AGENTEN nicht`);
    ok(!/minimumPrice/.test(text), `SCOPE ${name} kennt kein Mindestpreisfeld`);
  }

  // Also nimmt der Fernauftrag genau diese drei — und nichts sonst.
  const allowed = ['agentPrice', 'returnBy', 'notes'];
  for (const f of allowed) {
    const body: Record<string, unknown> = { id: 't1', expectedRevision: 1 };
    body[f] = f === 'agentPrice' ? 600 : 'x';
    const parsed = cmd.parseTransferUpdate(body);
    ok((parsed as Record<string, unknown>)[f] !== undefined, `SCOPE ${f} ist erlaubt`);
  }
  for (const f of ['productId', 'agentId', 'customerId', 'minimumPrice', 'status', 'soldAt',
    'returnedAt', 'settledAt', 'actualSalePrice', 'commissionAmount', 'commissionRate',
    'settlementAmount', 'settlementPaidAmount', 'settlementStatus', 'settlementModel',
    'excessSplitPct', 'invoiceId', 'buyerInfo', 'transferNumber', 'branchId', 'staffId']) {
    let threw = false;
    try { cmd.parseTransferUpdate({ id: 't1', expectedRevision: 1, [f]: 'x' }); } catch { threw = true; }
    ok(threw, `SCOPE ${f} wird abgewiesen — es ist lokal nicht editierbar`);
  }
  ok(ui.TRANSFER_EDIT_FIELDS.join(',') === allowed.join(','),
    `SCOPE und das Client-Formular kennt dieselben drei (${ui.TRANSFER_EDIT_FIELDS.join(',')})`);

  // §5 — die Unveränderlichkeit ist dokumentiert, nicht bloß unerwähnt.
  const mine = src('src/core/bridge/service-commands.ts');
  ok(/Artikel und Agent sind nach dem Anlegen unver/.test(mine),
    'SCOPE die Unveraenderlichkeit von Artikel und Agent steht ausdruecklich im Vertrag');
  ok(!/patch\.productId|patch\.agentId/.test(codeOf('src/core/bridge/service-commands.ts')),
    'SCOPE …und der Fernweg schreibt beides nirgends');
}

// ── 5) Ein geschlossener Vorgang nimmt nichts mehr an ────────────────────
{
  for (const terminal of ['returned', 'sold', 'settled'] as const) {
    resetDurabilityStateForTest();
    const db = freshDb();
    const d = deps(db);
    seedProduct(db, 'p1');
    const created = await cmd.runTransferCreate(d, identity('20', 'transfers.create'),
      { customerId: 'cust-1', productId: 'p1', agentPrice: 500 });
    const tid = val<{ transferId: string }>(created).transferId;

    // Der Client liest den OFFENEN Transfer …
    const seen = n(db, 'SELECT revision FROM agent_transfers WHERE id = ?', [tid]);
    const priceBefore = n(db, 'SELECT agent_price FROM agent_transfers WHERE id = ?', [tid]);
    // … der Primary schliesst ihn ab …
    db.run('UPDATE agent_transfers SET status = ? WHERE id = ?', [terminal, tid]);
    const statusBefore = s(db, 'SELECT stock_status FROM products WHERE id = ?', ['p1']);

    // … und der alte Auftrag kommt an.
    const stale = await cmd.runTransferUpdate(d, identity('2' + terminal.length, 'transfers.update'),
      { id: tid, expectedRevision: seen, agentPrice: 999 });
    ok(stale.kind === 'rejected' && ['TRANSFER_NOT_OPEN', 'RECORD_CHANGED'].includes(code(stale)),
      `TERMINAL (${terminal}) der alte Auftrag scheitert (${JSON.stringify(stale)})`);
    ok((stale as { frozen: boolean }).frozen === true, `TERMINAL (${terminal}) …und das Urteil ist endgueltig`);
    ok(n(db, 'SELECT agent_price FROM agent_transfers WHERE id = ?', [tid]) === priceBefore,
      `TERMINAL (${terminal}) null Businesswirkung`);
    ok(s(db, 'SELECT status FROM agent_transfers WHERE id = ?', [tid]) === terminal,
      `TERMINAL (${terminal}) der Status bleibt der neue`);
    ok(s(db, 'SELECT stock_status FROM products WHERE id = ?', ['p1']) === statusBefore,
      `TERMINAL (${terminal}) und der Artikelzustand faellt NICHT auf den alten Clientstand zurueck`);

    // Auch die Rueckgabe nimmt einen geschlossenen Vorgang nicht mehr an.
    const back = await cmd.runTransferReturn(d, identity('3' + terminal.length, 'transfers.mark_returned'),
      { id: tid, expectedRevision: n(db, 'SELECT revision FROM agent_transfers WHERE id = ?', [tid]) });
    ok(back.kind === 'rejected'
      && ['TRANSFER_NOT_OPEN', 'TRANSFER_ALREADY_RETURNED'].includes(code(back)),
    `TERMINAL (${terminal}) auch die Rueckgabe wird abgewiesen (${JSON.stringify(back)})`);
    ok(s(db, 'SELECT stock_status FROM products WHERE id = ?', ['p1']) === statusBefore,
      `TERMINAL (${terminal}) …ohne den Artikel anzufassen`);
  }
}

// ── 6) Dasselbe für die Reparatur ────────────────────────────────────────
{
  resetDurabilityStateForTest();
  const db = freshDb();
  const d = deps(db);
  const created = await cmd.runRepairCreate(d, identity('40', 'repairs.create'), {
    customerId: 'cust-1', issueDescription: 'Krone klemmt', repairType: 'internal',
    estimatedCost: 40, chargeToCustomer: 100,
  });
  const rid = val<{ repairId: string }>(created).repairId;
  const seen = n(db, 'SELECT revision FROM repairs WHERE id = ?', [rid]);

  // Der Primary bewegt die Reparatur weiter — ueber den ECHTEN Weg.
  useRepairStore.getState().updateStatus(rid, 'diagnosed');
  const statusAfter = s(db, 'SELECT status FROM repairs WHERE id = ?', [rid]);
  ok(statusAfter === 'diagnosed', `TERMINAL-REPAIR der Primary hat den Status bewegt (${statusAfter})`);

  const stale = await cmd.runRepairUpdate(d, identity('41', 'repairs.update'),
    { id: rid, expectedRevision: seen, chargeToCustomer: 1 });
  ok(stale.kind === 'rejected' && code(stale) === 'RECORD_CHANGED',
    `TERMINAL-REPAIR der stale Edit scheitert (${JSON.stringify(stale)})`);
  ok((stale as { frozen: boolean }).frozen === true, 'TERMINAL-REPAIR …endgueltig');
  ok(n(db, 'SELECT charge_to_customer FROM repairs WHERE id = ?', [rid]) === 100,
    'TERMINAL-REPAIR null Businesswirkung');
  ok(s(db, 'SELECT status FROM repairs WHERE id = ?', [rid]) === 'diagnosed',
    'TERMINAL-REPAIR und der neuere Zustand wird NICHT ueberschrieben');

  // Mit der frischen Fassung geht es weiter — die Sicherung sperrt nicht dauerhaft.
  const fresh = n(db, 'SELECT revision FROM repairs WHERE id = ?', [rid]);
  const okEdit = await cmd.runRepairUpdate(d, identity('42', 'repairs.update'),
    { id: rid, expectedRevision: fresh, chargeToCustomer: 150 });
  ok(okEdit.kind === 'ok', `TERMINAL-REPAIR mit der frischen Fassung geht es (${JSON.stringify(okEdit)})`);
  ok(n(db, 'SELECT margin FROM repairs WHERE id = ?', [rid]) === 110,
    'TERMINAL-REPAIR …und die Marge kommt aus der geteilten Ableitung (150 − 40)');
}

// ── 7) Umfang und Registry unveraendert ──────────────────────────────────
{
  await import('../../src/core/bridge/service-commands.ts');
  await import('../../src/core/bridge/financial-commands.ts');
  const known = knownCommands();
  const reads = known.filter((o) => o.endsWith('.list') || o.endsWith('.get'));
  ok(known.length === 43 && reads.length === 18 && ALLOWED_MUTATIONS.length === 24,
    `SCOPE 1 Probe + 18 Reads + 24 Mutationen = 43 (${known.length}/${reads.length}/${ALLOWED_MUTATIONS.length})`);
  const c3f = ['repairs.create', 'repairs.update', 'transfers.create', 'transfers.update', 'transfers.mark_returned'];
  for (const op of c3f) ok((ALLOWED_MUTATIONS as readonly string[]).includes(op), `SCOPE ${op} steht darauf`);
  for (const op of ['transfers.convert_to_invoice', 'transfers.undo_convert',
    'transfers.delete', 'repairs.update_status', 'repairs.delete']) {
    ok(!(ALLOWED_MUTATIONS as readonly string[]).includes(op), `SCOPE ${op} bleibt draussen`);
  }
  const unknown = await executeCommand('transfers.delete', { input: {} }, identity('90', 'transfers.delete', 'z'));
  ok(unknown.kind === 'infrastructure_error', 'SCOPE …und erreicht nichts');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central c3f parity and state safety: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
