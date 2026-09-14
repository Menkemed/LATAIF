// ════════════════════════════════════════════════════════════════════════════
// POST-PARITY R7A (PP-2, PP-10) — Fertigungsabschluss und Abgleich der Fertigungstabellen.
// Run: node test/r7a/pp2-pp10-production.test.ts
//
// PP-2: der Abschluss (Arbeit + Gemeinkosten) hatte keinen Aufrufer — erfasste Kosten wurden nie gebucht.
// Jetzt `production.complete`: EINE Hausfolge für Primary und PC2 (`completeProductionInHouse`), nur ein
// bestätigter Beleg, genau EINE Ausgabe (bar bezahlt, beide Buchungen strikt), Beleg COMPLETED, Einstand
// des Fertigteils unverändert (Materialwert), atomar, verlorene Antwort genau einmal, der Absender aus dem
// Ausweis, kein halber Abschluss.
//
// PP-10: `production_inputs`/`production_outputs` standen nicht im Abgleich-Vertrag (Manifest) und wurden
// von keinem Schreiber nachgeführt — ein anderer Datenbank-Rechner sah Belege ohne Ein- und Ausgänge,
// ein Löschen ließ dort Waisen. Jetzt reisen sie mit dem Beleg (insert/delete), ein Echo ist kein
// Schreiben, der Feldvertrag gilt.
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
      for (const cand of [p, p + '.ts', p + '.tsx']) {
        if (existsSync(cand)) return { url: pathToFileURL(cand).href, shortCircuit: true };
      }
      return { url: pathToFileURL(p + '.ts').href, shortCircuit: true };
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
const { tauriState, stageForTest } = await import('../bridge/_tauri-shim.ts');
const { COMMAND_LEDGER_DDL, COMMAND_LEDGER_INDEX, commandCount } = await import('../../src/core/bridge/command-ledger.ts');
const { resetDurabilityStateForTest } = await import('../../src/core/bridge/durability-state.ts');
const { resetTransactionHealthForTest } = await import('../../src/core/db/transaction-health.ts');
const { installWriteGuard } = await import('../../src/core/db/write-guard.ts');
const { SKU_SEQUENCES_DDL } = await import('../../src/core/products/sku-sequence.ts');
const registry = await import('../../src/core/bridge/command-registry.ts');
const perms = await import('../../src/core/bridge/command-permissions.ts');
const cmd = await import('../../src/core/bridge/production-commands.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const { applyMediaSchema } = await import('../../src/core/db/media-schema.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { useProductionStore, createProductionOnPrimary } = await import('../../src/stores/productionStore.ts');
const house = await import('../../src/core/production/production-house.ts');
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
const all = (db: Db, sql: string, p: unknown[] = []): unknown[][] => db.exec(sql, p)[0]?.values ?? [];

function realMigrations(): string[] {
  const dbSrc = src('src/core/db/database.ts');
  const start = dbSrc.indexOf('const migrations: string[] = [');
  const end = dbSrc.indexOf('\n  ];', start);
  return [...dbSrc.slice(start, end).matchAll(/`([^`]*)`/g)].map((m) => m[1]);
}
const MIGRATIONS = realMigrations();

/** Die Welt: sechs Artikel — zwei normale Eingänge, einer ohne Lose, ein verkaufter, einer mit drei Stück, einer einer fremden Filiale. */
const PRODUKTE: Array<[string, string, string, number, number]> = [
  ['p1', 'branch-main', 'in_stock', 100, 1], ['p2', 'branch-main', 'in_stock', 150, 1],
  ['p-legacy', 'branch-main', 'in_stock', 50, 0], ['p-sold', 'branch-main', 'sold', 80, 1],
  ['p-multi', 'branch-main', 'in_stock', 30, 3], ['p-foreign', 'branch-other', 'in_stock', 100, 1],
];

function freshDb(): Db {
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  tauriState.reset();
  const db = new SQL.Database() as unknown as Db;
  db.run(src('src/core/db/schema.sql'));
  for (const stmt of MIGRATIONS) { try { db.run(stmt); } catch { /* schon da */ } }
  for (const stmt of A1_UPGRADE_SQL) { try { db.run(stmt); } catch { /* schon da */ } }
  db.run(COMMAND_LEDGER_DDL);
  db.run(COMMAND_LEDGER_INDEX);
  db.run(SKU_SEQUENCES_DDL);
  applyMediaSchema(db as never);
  for (const [id, name] of [['branch-main', 'Haupt'], ['branch-other', 'Andere']]) {
    db.run('INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES (?,?,?,?,?)', [id, 'tenant-1', name, NOW, NOW]);
  }
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES ('cat-watch','branch-main','Watches','w','#000',?,?)", [NOW, NOW]);
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  for (const [id, branch, stock, price, lotQty] of PRODUKTE) {
    db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition, scope_of_delivery,
        purchase_price, purchase_currency, stock_status, tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
      VALUES (?,?,'cat-watch','Rolex',?,?,?,'Pre-Owned','[]',?,'BHD',?,'MARGIN',0,'[]','{}','OWN',?,?)`,
    [id, branch, 'M ' + id, 'SKU-' + id, lotQty === 0 ? 1 : lotQty, price, stock, NOW, NOW]);
    if (lotQty > 0) {
      db.run(`INSERT INTO stock_lots (id, branch_id, product_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`,
      ['lot-' + id, branch, id, price, lotQty, stock === 'sold' ? 0 : lotQty, stock === 'sold' ? 'EXHAUSTED' : 'ACTIVE', NOW, NOW]);
    }
  }
  useProductStore.getState().loadProducts();
  useProductStore.getState().loadCategories();
  useProductionStore.getState().loadRecords();
  return db;
}

const PC2 = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2' };
const ACTOR = { ...PC2, role: 'ADMIN' };
const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-000000000000`;
const identity = (x: string, hash = 'h' + x) => ({ commandId: ID(x), ...ACTOR, op: 'production.create', payloadHash: hash });
function deps(db: Db) {
  return {
    db: db as never,
    begin: posting.beginLedgerTransaction,
    commit: posting.commitLedgerTransaction,
    rollback: posting.rollbackLedgerTransaction,
    durableSave: async () => {},
    now: () => NOW,
  };
}

function bytes(seed: string): Uint8Array {
  const b = new Uint8Array(32);
  for (let i = 0; i < 32; i++) b[i] = (seed.charCodeAt(i % seed.length) + i * 13) & 0xff;
  return b;
}
const dataUrl = (b: Uint8Array): string => 'data:image/jpeg;base64,' + Buffer.from(b).toString('base64');
const fromDataUrl = (u: string): Uint8Array => new Uint8Array(Buffer.from(u.slice(u.indexOf(',') + 1), 'base64'));
const B1 = bytes('ring-a-front');
const B2 = bytes('ring-a-back');

type Input = Parameters<typeof house.createProductionInHouse>[0];
/** Was ein Mensch an der Maske eingibt: p1 (100) + p2 (150) → Ring A (150, zwei Fotos) + Ring B (100, getippte SKU). */
function INPUT(): Input {
  return {
    inputProductIds: ['p1', 'p2'],
    outputs: [
      {
        spec: {
          categoryId: 'cat-watch', brand: 'Custom', name: 'Ring A', condition: 'New', taxScheme: 'MARGIN',
          attributes: {}, scopeOfDelivery: ['Box'], notes: 'hand made', images: [dataUrl(B1), dataUrl(B2)],
          // Ein Feld, das die Maske der Fertigung ausblendet — es darf weder reisen noch wirken.
          plannedSalePrice: 999,
        } as never,
        value: 150,
      },
      { spec: { categoryId: 'cat-watch', brand: 'Custom', name: 'Ring B', sku: ' PRD-SKU-1 ', images: [] }, value: 100 },
    ],
    laborCost: 5,
    overheadCost: 2.5,
    notes: 'merge two watches',
  };
}

/** Der Rumpf, wie PC2 ihn baut: Fotos in die Ablage (Kennung = Inhalt), im Auftrag nur Kennungen. */
async function remoteBody(input: Input, owner = PC2): Promise<Record<string, unknown>> {
  const bodies = await house.productionOutputBodies(input.outputs, async (urls) => urls.map((u) => stageForTest(fromDataUrl(u), owner)));
  return house.productionCreateRequest(input, bodies);
}

const mediaOf = (db: Db, pid: string): unknown[][] => all(db, `
  SELECT l.sort_order, l.is_primary,
         (SELECT g.stored_blob_hash FROM media_blob_generations g
           WHERE g.tenant_id = o.tenant_id AND g.blob_id = o.master_blob_id ORDER BY g.generation_no DESC LIMIT 1)
    FROM media_links l JOIN media_objects o ON o.tenant_id = l.tenant_id AND o.media_id = l.media_id
   WHERE l.entity_id = ? AND l.deleted_at IS NULL ORDER BY l.sort_order`, [pid]);

/** Die fachliche Wirkung — ohne Kennungen, Zeitstempel und Belegnummer. */
function welt(db: Db) {
  const rec = row(db, 'SELECT branch_id, production_date, total_value, notes, status, labor_cost, overhead_cost, total_cost, record_number FROM production_records');
  const recNo = String(rec.record_number ?? '');
  delete rec.record_number;
  const outIds = all(db, 'SELECT o.product_id FROM production_outputs o JOIN products p ON p.id = o.product_id ORDER BY p.name').map((v) => String(v[0]));
  return {
    rec,
    recNoOk: /^PRD/.test(recNo),
    inputs: all(db, 'SELECT product_id, input_value, product_snapshot FROM production_inputs ORDER BY product_id'),
    outputs: outIds.map((pid) => ({
      product: row(db, `SELECT branch_id, category_id, brand, name, sku, quantity, condition, scope_of_delivery, purchase_date,
          purchase_price, purchase_currency, planned_sale_price, stock_status, tax_scheme, source_type, images, attributes,
          storage_location, REPLACE(notes, ?, 'PRD-#') AS notes FROM products WHERE id = ?`, [recNo, pid]),
      value: one(db, 'SELECT output_value FROM production_outputs WHERE product_id = ?', [pid]),
      lots: all(db, 'SELECT branch_id, purchase_id, unit_cost, qty_total, qty_remaining, status FROM stock_lots WHERE product_id = ?', [pid]),
      media: mediaOf(db, pid),
    })),
    inputsNow: all(db, "SELECT id, stock_status, quantity FROM products WHERE id IN ('p1','p2') ORDER BY id"),
    inputLots: all(db, "SELECT id, qty_remaining, status FROM stock_lots WHERE product_id IN ('p1','p2') ORDER BY id"),
    ledger: n(db, 'SELECT COUNT(*) FROM ledger_entries'),
    expenses: n(db, 'SELECT COUNT(*) FROM expenses'),
    changelog: n(db, "SELECT COUNT(*) FROM sync_changelog WHERE table_name = 'production_records'"),
    audit: n(db, "SELECT COUNT(*) FROM audit_log WHERE entity_type = 'production_records'"),
  };
}

/** „Es ist nichts passiert": kein Beleg, kein neuer Artikel, kein Bild, kein Nachweis, Eingänge unberührt. */
function unberuehrt(db: Db): { ok: boolean; z: Record<string, number> } {
  const z = {
    belege: n(db, 'SELECT COUNT(*) FROM production_records'),
    eingaenge: n(db, 'SELECT COUNT(*) FROM production_inputs'),
    ausgaenge: n(db, 'SELECT COUNT(*) FROM production_outputs'),
    artikel: n(db, 'SELECT COUNT(*) FROM products'),
    lose: n(db, 'SELECT COUNT(*) FROM stock_lots'),
    bilder: n(db, 'SELECT COUNT(*) FROM media_links'),
    bildauftraege: n(db, 'SELECT COUNT(*) FROM media_ingest_jobs'),
    nachweise: commandCount(db as never),
    verbraucht: n(db, "SELECT COUNT(*) FROM products WHERE stock_status = 'consumed'"),
    leereLose: n(db, "SELECT COUNT(*) FROM stock_lots WHERE product_id IN ('p1','p2') AND (status != 'ACTIVE' OR qty_remaining != 1)"),
    protokoll: n(db, "SELECT COUNT(*) FROM audit_log WHERE entity_type IN ('production_records','products')"),
    abgleich: n(db, "SELECT COUNT(*) FROM sync_changelog WHERE table_name IN ('production_records','products','stock_lots')"),
  };
  const ok = z.belege === 0 && z.eingaenge === 0 && z.ausgaenge === 0 && z.artikel === PRODUKTE.length && z.lose === 5
    && z.bilder === 0 && z.bildauftraege === 0 && z.nachweise === 0 && z.verbraucht === 0 && z.leereLose === 0
    && z.protokoll === 0 && z.abgleich === 0;
  return { ok, z };
}

const codeOfOutcome = (o: unknown): string => String((o as { code?: string }).code ?? '');
const frozen = (o: unknown): boolean => (o as { frozen?: boolean }).frozen === true;
async function wirftAsync(fn: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await fn(); return { code: '', message: '' }; } catch (e) {
    return { code: String((e as { code?: string }).code ?? ''), message: String((e as Error).message ?? e) };
  }
}

// ══ R7A ═════════════════════════════════════════════════════════════════════
const { completeProductionOnPrimary } = await import('../../src/stores/productionStore.ts');
const ac = await import('../../src/core/sync/apply-change.ts');
const nimm = (db: Db): Db => { setTestDatabase(db as never); return db; };
const rows = (db: Db, sql: string, p: unknown[] = []): Array<Record<string, unknown>> => {
  const r = db.exec(sql, p)[0];
  return r ? r.values.map((v) => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))) : [];
};
function insert(db: Db, table: string, values: Record<string, unknown>): void {
  const names = Object.keys(values);
  db.run(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`, names.map((k) => values[k]));
}
function balanced(db: Db): boolean {
  const t = all(db, `SELECT transaction_id,
      SUM(CASE WHEN direction = 'DEBIT' THEN CAST(ROUND(amount * 1000) AS INTEGER) ELSE 0 END),
      SUM(CASE WHEN direction = 'CREDIT' THEN CAST(ROUND(amount * 1000) AS INTEGER) ELSE 0 END)
    FROM ledger_entries GROUP BY transaction_id`);
  return t.every((r) => Number(r[1]) === Number(r[2]));
}
const saldo = (db: Db, account: string): number => n(db,
  `SELECT COALESCE(ROUND(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 3), 0) FROM ledger_entries WHERE account = ?`, [account]);
const idC = (x: string, over: Record<string, unknown> = {}) => ({ commandId: ID('9' + x), ...ACTOR, ...over, op: 'production.complete', payloadHash: 'hc' + x });
const recId = (db: Db): string => s(db, 'SELECT id FROM production_records');
const zahl = (db: Db, t: string): number => n(db, `SELECT COUNT(*) FROM ${t}`);
/** Die Wirkung des Abschlusses — ohne Kennungen, Zeitstempel, Nummern. */
const abschluss = (db: Db) => S({
  rec: row(db, 'SELECT status, labor_cost, overhead_cost, total_cost, total_value FROM production_records'),
  exp: all(db, 'SELECT category, amount, paid_amount, payment_method, status, related_module FROM expenses'),
  pay: all(db, 'SELECT amount, method FROM expense_payments'),
  led: all(db, 'SELECT source_module, account, direction, ROUND(SUM(amount), 3), COUNT(*) FROM ledger_entries GROUP BY 1, 2, 3 ORDER BY 1, 2, 3'),
  outCost: all(db, 'SELECT p.purchase_price FROM production_outputs o JOIN products p ON p.id = o.product_id ORDER BY p.purchase_price'),
  lots: all(db, 'SELECT l.unit_cost, l.qty_remaining, l.status FROM stock_lots l JOIN production_outputs o ON o.product_id = l.product_id ORDER BY l.unit_cost'),
});
let seqC = 500;
async function angelegt(weg: 'P' | 'C', input: Input = INPUT()): Promise<Db> {
  const db = freshDb();
  if (weg === 'P') await createProductionOnPrimary(input);
  else {
    const r = await cmd.runProductionCreate(deps(db) as never, identity(String(++seqC)), await remoteBody(input));
    if (r.kind !== 'ok') throw new Error('create failed ' + S(r));
  }
  return db;
}
interface Aus { ok: boolean; v: Record<string, unknown>; code: string; frozen: boolean; replayed: boolean; message: string }
async function abschliessen(db: Db, weg: 'P' | 'C', body: Record<string, unknown>, x = String(++seqC)): Promise<Aus> {
  nimm(db);
  try {
    if (weg === 'P') return { ok: true, v: await completeProductionOnPrimary(body as never) as unknown as Record<string, unknown>, code: '', frozen: false, replayed: false, message: '' };
    const o = await cmd.runProductionComplete(deps(db) as never, idC(x) as never, body) as { kind: string; value?: Record<string, unknown>; code?: string; frozen?: boolean; replayed?: boolean; message?: string };
    return { ok: o.kind === 'ok', v: o.value ?? {}, code: o.code ?? '', frozen: o.frozen === true, replayed: o.replayed === true, message: o.message ?? '' };
  } catch (e) {
    return { ok: false, v: {}, code: String((e as { code?: string }).code ?? ''), frozen: false, replayed: false, message: String((e as Error).message ?? e) };
  }
}

// ══ PP-2 §1 — Primary == PC2 ═════════════════════════════════════════════════
const dbA = await angelegt('P');
const a = await abschliessen(dbA, 'P', { recordId: recId(dbA) });
const listeA = useProductionStore.getState().records.find((r) => r.id === recId(dbA))?.status;
const dbB = await angelegt('C');
const b = await abschliessen(dbB, 'C', { recordId: recId(dbB) }, 'B1');
const zA = JSON.parse(abschluss(dbA)), zB = JSON.parse(abschluss(dbB));
ok(a.ok && b.ok && S(zA) === S(zB), `PARITY Abschluss am Primary == Abschluss über PC2 (${a.code || 'ok'}/${b.code || 'ok'})\n  A=${S(zA).slice(0, 500)}\n  B=${S(zB).slice(0, 500)}`);
ok(zA.rec.status === 'COMPLETED' && Number(zA.rec.labor_cost) === 5 && Number(zA.rec.overhead_cost) === 2.5 && Number(zA.rec.total_cost) === 257.5 && Number(zA.rec.total_value) === 250,
  `BELEG COMPLETED; Summe 257.5 = Material 250 + Arbeit 5 + Gemeinkosten 2.5 (${S(zA.rec)})`);
ok(S(zA.exp) === S([['Miscellaneous', 7.5, 7.5, 'cash', 'PAID', 'production']]) && S(zA.pay) === S([[7.5, 'cash']]),
  `AUSGABE genau EINE: 7.5, bar bezahlt, related_module production (${S(zA.exp)} ${S(zA.pay)})`);
ok(balanced(dbA) && saldo(dbA, 'CASH') === -7.5 && saldo(dbA, 'EXPENSES_OPERATING') === 7.5 && saldo(dbA, 'ACCOUNTS_PAYABLE') === 0,
  `HAUPTBUCH Aufwand 7.5 gegen Kasse, A/P ausgeglichen, jede Transaktion ausgeglichen (${S([saldo(dbA, 'CASH'), saldo(dbA, 'EXPENSES_OPERATING'), saldo(dbA, 'ACCOUNTS_PAYABLE')])})`);
ok(S(zA.outCost) === S([[100], [150]]) && S(zA.lots) === S([[100, 1, 'ACTIVE'], [150, 1, 'ACTIVE']]),
  `EINSTAND der Fertigteile bleibt der Materialwert (100/150), Lose unverändert — Arbeit/Gemeinkosten sind Aufwand, nicht doppelt (${S(zA.outCost)} ${S(zA.lots)})`);
ok(s(dbA, 'SELECT created_by FROM expenses') === 'user-test' && s(dbB, 'SELECT created_by FROM expenses') === 'user-pc2'
  && String(a.v.expenseId ?? '') !== '' && String(b.v.expenseId ?? '') !== '',
`AKTEUR die Ausgabe: am Primary die Sitzung, fern der geprüfte Absender (${s(dbA, 'SELECT created_by FROM expenses')}/${s(dbB, 'SELECT created_by FROM expenses')})`);
ok(n(dbA, "SELECT COUNT(*) FROM audit_log WHERE entity_type = 'production_records' AND action_type = 'UPDATE'") === 1
  && n(dbA, "SELECT COUNT(*) FROM sync_changelog WHERE table_name = 'production_records' AND action = 'update'") >= 1,
'SPUR Protokoll und Abgleich des Abschlusses');
ok(listeA === 'COMPLETED', `PRIMARY die Liste zeigt COMPLETED (runOnPrimary lädt neu) (${listeA})`);

// ══ PP-2 §2 — genau einmal ═══════════════════════════════════════════════════
{
  const ledA = zahl(dbA, 'ledger_entries'), ledB = zahl(dbB, 'ledger_entries');
  const a2 = await abschliessen(dbA, 'P', { recordId: recId(dbA) });
  const b2 = await abschliessen(dbB, 'C', { recordId: recId(dbB) });
  const b3 = await abschliessen(dbB, 'C', { recordId: recId(dbB) }, 'B1');
  ok(!a2.ok && a2.code === 'PRODUCTION_ALREADY_COMPLETED' && zahl(dbA, 'expenses') === 1 && zahl(dbA, 'ledger_entries') === ledA,
    `ONCE Primary: ein zweiter Abschluss ist ein Nein, keine zweite Ausgabe (${a2.code})`);
  ok(!b2.ok && b2.code === 'PRODUCTION_ALREADY_COMPLETED' && b2.frozen && zahl(dbB, 'expenses') === 1,
    `ONCE PC2: ein zweiter Abschluss (neue Kennung) ist ein eingefrorenes Nein (${b2.code})`);
  ok(b3.ok && b3.replayed && zahl(dbB, 'expenses') === 1 && zahl(dbB, 'ledger_entries') === ledB,
    'LOST dieselbe Kennung noch einmal: das eingefrorene Ergebnis, genau eine Ausgabe, keine neue Buchung');
}
// Ein Altstand mit schon gebuchter Ausgabe wird nicht ein zweites Mal gebucht.
{
  const db = await angelegt('P');
  insert(db, 'expenses', { id: 'exp-alt', branch_id: 'branch-main', expense_number: 'EXP-ALT', category: 'Miscellaneous', amount: 7.5,
    payment_method: 'cash', expense_date: '2026-09-13', status: 'PAID', paid_amount: 7.5, related_module: 'production', related_entity_id: recId(db), created_at: NOW });
  const r = await abschliessen(db, 'C', { recordId: recId(db) });
  ok(!r.ok && r.code === 'PRODUCTION_ALREADY_BOOKED' && zahl(db, 'expenses') === 1 && s(db, 'SELECT status FROM production_records') === 'CONFIRMED',
    `ONCE ein Beleg, dessen Kosten schon als Ausgabe stehen, wird nicht noch einmal gebucht (${r.code})`);
}

// ══ PP-2 §3 — endgültige Beträge; ohne Kosten keine Ausgabe ═════════════════
{
  const dbO = await angelegt('P', { ...INPUT(), laborCost: 0, overheadCost: 0 });
  const o = await abschliessen(dbO, 'C', { recordId: recId(dbO), laborCost: 10, overheadCost: 0 });
  ok(o.ok && Number(o.v.totalCost) === 260 && S(all(dbO, 'SELECT amount, status FROM expenses')) === S([[10, 'PAID']])
    && Number(one(dbO, 'SELECT labor_cost FROM production_records')) === 10 && balanced(dbO),
  `BETRAG die endgültige Arbeit (10) beim Abschluss: Ausgabe 10, Summe 260 (${S(o.v).slice(0, 200)})`);
  const dbZ = await angelegt('P', { ...INPUT(), laborCost: 0, overheadCost: 0 });
  const ledZ = zahl(dbZ, 'ledger_entries');
  const z = await abschliessen(dbZ, 'P', { recordId: recId(dbZ) });
  ok(z.ok && z.v.expenseId === null && zahl(dbZ, 'expenses') === 0 && zahl(dbZ, 'ledger_entries') === ledZ
    && s(dbZ, 'SELECT status FROM production_records') === 'COMPLETED' && Number(one(dbZ, 'SELECT total_cost FROM production_records')) === 250,
  'NULL ohne Arbeit/Gemeinkosten: COMPLETED, keine Ausgabe, keine Buchung');
}

// ══ PP-2 §4 — Fehlerinjektion: kein halber Abschluss ═════════════════════════
for (const [weg, muster] of [['P', /UPDATE production_records SET status = 'COMPLETED'/], ['C', /UPDATE production_records SET status = 'COMPLETED'/],
  ['P', /INSERT INTO ledger_entries/], ['C', /INSERT INTO expense_payments/]] as Array<['P' | 'C', RegExp]>) {
  const db = await angelegt('P');
  const vor = abschluss(db) + '|' + zahl(db, 'sync_changelog') + '|' + zahl(db, 'audit_log');
  const raw = db.run.bind(db);
  (db as { run: Db['run'] }).run = (sql: string, p?: unknown[]) => { if (muster.test(sql)) throw new Error('R7A: injected failure'); return raw(sql, p); };
  const x = 'F' + (++seqC);
  const f = await abschliessen(db, weg, { recordId: recId(db) }, x);
  (db as { run: Db['run'] }).run = raw;
  const nach = abschluss(db) + '|' + zahl(db, 'sync_changelog') + '|' + zahl(db, 'audit_log');
  ok(!f.ok && nach === vor && s(db, 'SELECT status FROM production_records') === 'CONFIRMED' && zahl(db, 'expenses') === 0 && zahl(db, 'expense_payments') === 0,
    `ATOMAR [${weg}] Ausfall bei ${muster}: nichts bleibt — CONFIRMED, keine Ausgabe, keine Zahlung, keine Buchung, keine Spur (${f.code || f.message.slice(0, 80)})`);
  const g = await abschliessen(db, weg, { recordId: recId(db) }, x);
  ok(g.ok && zahl(db, 'expenses') === 1 && s(db, 'SELECT status FROM production_records') === 'COMPLETED',
    `ATOMAR [${weg}] danach geht derselbe Abschluss genau einmal durch (${g.code || 'ok'})`);
}

// ══ PP-2 §5 — Autorität und Negative ═════════════════════════════════════════
{
  const db = await angelegt('P');
  const rid = recId(db);
  const faelle: Array<[Record<string, unknown>, RegExp]> = [
    [{ recordId: rid, status: 'COMPLETED' }, /the primary decides status/],
    [{ recordId: rid, totalCost: 1 }, /the primary decides totalCost/],
    [{ recordId: rid, expenseId: 'x' }, /the primary decides expenseId/],
    [{ recordId: rid, createdBy: 'user-x' }, /the primary decides createdBy/],
    [{ recordId: rid, revision: 3 }, /the primary decides revision/],
    [{ recordId: rid, colour: 'red' }, /unknown field: colour/],
    [{}, /recordId is required/],
    [{ recordId: rid, laborCost: -1 }, /laborCost must be a number ≥ 0/],
  ];
  let k = 0;
  for (const [body, muster] of faelle) {
    const r = await wirftAsync(() => cmd.runProductionComplete(deps(nimm(db)) as never, idC('A' + (++k)) as never, body));
    ok(r.code === 'PRODUCTION_PAYLOAD_INVALID' && muster.test(r.message), `AUTHORITY ${S(body).slice(0, 60)} → ${muster} (${r.code}: ${r.message})`);
  }
  ok(zahl(db, 'expenses') === 0 && s(db, 'SELECT status FROM production_records') === 'CONFIRMED', 'AUTHORITY kein Rumpf hat etwas geschrieben');
  const nf = await abschliessen(db, 'C', { recordId: 'nope' });
  ok(!nf.ok && nf.code === 'PRODUCTION_NOT_FOUND' && nf.frozen, `NEG ein unbekannter Beleg ist ein eingefrorenes Nein (${nf.code})`);
  const fremd = await cmd.runProductionComplete(deps(nimm(db)) as never, idC('FB', { branchId: 'branch-other' }) as never, { recordId: rid }).catch((e) => ({ kind: 'thrown', e: String(e) }));
  ok((fremd as { kind: string }).kind !== 'ok' && /BRANCH_MISMATCH/.test(S(fremd)) && zahl(db, 'expenses') === 0, `NEG Ausweis einer anderen Filiale → BRANCH_MISMATCH (${S(fremd).slice(0, 120)})`);
  store.set('lataif_runtime_mode', 'client');
  const cm = await wirftAsync(() => completeProductionOnPrimary({ recordId: rid }));
  store.delete('lataif_runtime_mode');
  ok(cm.code === 'PRODUCTION_PRIMARY_ONLY' && zahl(db, 'expenses') === 0, `CLIENT ohne Geschäftsdatenbank verweigert der Anschluss, bevor er schreibt (${cm.code})`);
}

// ══ PP-2 §6 — Löschen nach dem Abschluss nimmt die Ausgabe sauber zurück ═════
{
  nimm(dbA);
  useProductionStore.getState().loadRecords();
  useProductionStore.getState().deleteRecord(recId(dbA));
  ok(zahl(dbA, 'production_records') === 0 && zahl(dbA, 'expenses') === 0 && zahl(dbA, 'expense_payments') === 0
    && balanced(dbA) && saldo(dbA, 'CASH') === 0 && saldo(dbA, 'EXPENSES_OPERATING') === 0,
  `DELETE der Abschluss hinterlässt keine verwaiste Ausgabe: Löschen nimmt sie samt Zahlung zurück, Kasse 0 (${saldo(dbA, 'CASH')})`);
}

// ══ PP-2 §7 — Registry, Rust, Oberfläche ═════════════════════════════════════
{
  // (Die Gesamtzahl 175 prüfen die Final-Gates mit ALLEN Befehlsmodulen; hier ist nur production-commands geladen.)
  ok(registry.ALLOWED_MUTATIONS.at(-1) === 'production.complete' && registry.ALLOWED_MUTATIONS.length === 103
    && registry.knownCommands().includes('production.complete') && registry.knownCommands().includes('production.create'),
  `REGISTRY production.complete registriert: 103 Buchungen, angemeldet neben production.create (${registry.ALLOWED_MUTATIONS.length})`);
  ok('production.complete' in perms.OPERATION_PERMISSIONS && (perms.OPERATION_PERMISSIONS as Record<string, unknown>)['production.complete'] === null,
    'RECHT wie das Anlegen: kein Tor (die Seite fragt usePermission nicht)');
  const rs = src('src-tauri/src/bridge.rs');
  ok(/pub const OP_PRODUCTION_COMPLETE: &str = "production\.complete";/.test(rs) && /OP_DOCUMENTS_SET_OCR,\s*OP_PRODUCTION_COMPLETE,\s*\];/.test(rs),
    'RUST derselbe Name steht in REMOTE_OPS');
  const pd = codeOf(src('src/pages/production/ProductionDetail.tsx'));
  ok(/useSharedWrite<unknown>\('production\.complete'\)/.test(pd) && /local: \(\) => completeProductionOnPrimary\(body\),\s*remote: \(\) => body,/.test(pd)
    && /record\.status === 'CONFIRMED'/.test(pd) && pd.includes('data-production-complete') && pd.includes('data-production-error'),
  'UI ProductionDetail: „Complete Production" für einen bestätigten Beleg, EINE Weiche, derselbe Rumpf auf beiden Wegen');
  const st = codeOf(src('src/stores/productionStore.ts'));
  const h = codeOf(src('src/core/production/production-house.ts'));
  ok(!/completeRecord/.test(st) && !/postExpense|INSERT INTO expenses|branch-main|user-owner/.test(st.slice(st.indexOf('export async function completeProductionOnPrimary'))),
    'STORE der alte Abschluss (ohne Klammer, verschluckte Buchung, stilles branch-main) ist weg');
  ok(/createExpenseInHouse\(/.test(h) && !/BEGIN|COMMIT|ROLLBACK|saveDatabase|safePost/.test(h), 'HOUSE über den Anlageweg der Ausgaben; keine eigene Transaktion, kein safePost');
  ok(/booked when the record is completed/.test(src('src/pages/production/ProductionPage.tsx')), 'UI die Anlage-Maske sagt die Wahrheit über den Buchungszeitpunkt');
}
marker('POST_PARITY_R7A_PP2_PRODUCTION_COMPLETION_FIXED');

// ══ PP-10 — die Fertigungstabellen reisen mit ═════════════════════════════════
{
  const dbS = await angelegt('P');
  const strom = rows(dbS, 'SELECT id, table_name, record_id, action, data FROM sync_changelog ORDER BY id');
  const kinder = strom.filter((c) => c.table_name === 'production_inputs' || c.table_name === 'production_outputs');
  ok(kinder.filter((c) => c.table_name === 'production_inputs' && c.action === 'insert').length === 2
    && kinder.filter((c) => c.table_name === 'production_outputs' && c.action === 'insert').length === 2,
  `WRITER jede Ein- und Ausgangszeile wird nachgeführt (${kinder.map((c) => `${c.table_name}:${c.action}`).join(', ')})`);
  const snap = (db: Db) => S({
    r: all(db, 'SELECT * FROM production_records ORDER BY id'),
    i: all(db, 'SELECT * FROM production_inputs ORDER BY id'),
    o: all(db, 'SELECT * FROM production_outputs ORDER BY id'),
  });
  const dbPeer = freshDb();
  const gift: string[] = [];
  const anwenden = (db: Db, liste: Array<Record<string, unknown>>) => {
    for (const c of liste) {
      try { ac.applySyncChange(db as never, { table_name: String(c.table_name), record_id: String(c.record_id), action: String(c.action), data: String(c.data) }); }
      catch (e) { gift.push(`${c.table_name}:${(e as { code?: string }).code ?? e}`); }
    }
  };
  anwenden(dbPeer, strom);
  ok(snap(dbPeer) === snap(dbS) && !gift.some((g) => /^production_/.test(g)),
    `PROPAGATION ein anderer Datenbank-Rechner hat Beleg, Eingänge und Ausgänge Zeile für Zeile gleich (Quarantäne außerhalb: ${gift.join(', ') || 'keine'})`);
  ok(all(dbPeer, 'SELECT COUNT(*) FROM production_inputs i JOIN production_records r ON r.id = i.record_id')[0][0] === 2,
    'OWNERSHIP jede Kindzeile hängt an ihrem Beleg (und damit an dessen Filiale)');
  const tc0 = n(dbPeer, 'SELECT total_changes()');
  anwenden(dbPeer, strom.filter((c) => String(c.table_name).startsWith('production_')));
  ok(n(dbPeer, 'SELECT total_changes()') === tc0 && snap(dbPeer) === snap(dbS), 'ECHO derselbe Stand noch einmal: nichts geschrieben (kein Update, kein Trigger)');
  // Löschen reist mit: keine Waisen auf dem anderen Rechner.
  const bis = Number(strom[strom.length - 1]?.id ?? 0);
  nimm(dbS);
  useProductionStore.getState().loadRecords();
  useProductionStore.getState().deleteRecord(recId(dbS));
  const neu = rows(dbS, 'SELECT id, table_name, record_id, action, data FROM sync_changelog WHERE id > ? ORDER BY id', [bis]);
  ok(neu.filter((c) => c.action === 'delete' && String(c.table_name).startsWith('production_')).length === 5,
    `WRITER Löschen führt Beleg + 2 Eingänge + 2 Ausgänge nach (${neu.map((c) => `${c.table_name}:${c.action}`).join(', ')})`);
  anwenden(dbPeer, neu);
  ok(zahl(dbPeer, 'production_records') === 0 && zahl(dbPeer, 'production_inputs') === 0 && zahl(dbPeer, 'production_outputs') === 0,
    'DELETE auf dem anderen Rechner verschwinden Beleg UND Kindzeilen — keine Waisen');
  // Feldvertrag: nur insert/delete, nur die Spalten.
  const ins = kinder.find((c) => c.table_name === 'production_inputs')!;
  const data = String(ins.data);
  ok(ac.changeContractViolation('production_inputs', 'insert', data) === null, 'CONTRACT die Eingangszeile besteht den Feldvertrag');
  ok(String(ac.changeContractViolation('production_inputs', 'update', data)).includes(ac.SYNC_OPERATION_NOT_ALLOWED),
    'CONTRACT ein Update einer (unveränderlichen) Kindzeile ist nicht vorgesehen');
  ok(String(ac.changeContractViolation('production_inputs', 'insert', JSON.stringify({ ...JSON.parse(data), hacked: 1 }))).includes(ac.SYNC_FIELD_NOT_ALLOWED),
    'CONTRACT ein fremdes Feld wird abgewiesen');
  // Veraltete/außer der Reihe: der Abgleich wendet nur an, was hinter dem durablen Stand liegt — für ALLE Tabellen dieselbe Regel.
  const sy = src('src/core/sync/sync-service.ts');
  ok(/changes = changes\.filter\(\(c\) => Number\(c\.id \?\? 0\) > start\.cursor\)/.test(sy) && /`writeCursor` geht nie rueckwaerts/.test(sy),
    'STALE eine erneut gelieferte (alte) Änderung wird nicht noch einmal angewendet; der Stand geht nie rückwärts');
  const pol = src('src-tauri/src/sync/sync_policy.rs');
  ok(/"production_inputs",\s*"production_outputs",/.test(pol) && /production_inputs: 'Production'/.test(src('src/core/sync/track.ts')),
    'POLICY Rust-Klassifikation und Modul-Zuordnung kennen beide Tabellen');
}
marker('POST_PARITY_R7A_PP10_PRODUCTION_SYNC_FIXED');

// ══ PP-2 §8 — der Kostenvertrag an einem Beispiel (R7A Final Contract Gate) ═══════
// Material 250 (p1 + p2 → Ring A 150 + Ring B 100), Arbeit 150, Gemeinkosten 50. Der Einstand der Fertigteile
// bleibt der Materialwert (die Fertigung ist wertgleich, bucht weder INVENTORY noch COGS); Arbeit + Gemeinkosten
// sind EINE Betriebsausgabe (Miscellaneous, nicht in CAPITALIZED_EXPENSE_CATEGORIES). Später verkauft (400 + 300):
// Σ Gewinn = Σ Erlös − total_cost — jeder Kostenteil genau EINMAL, im Hauptbuch (REVENUE − COGS − EXPENSES_OPERATING)
// wie in den Berichten (Marge − Betriebsausgaben). Kapitalisieren UND Ausgabe buchen zählte 200 doppelt (Gewinn 50).
{
  const { isCapitalizedExpenseCategory } = await import('../../src/core/models/types.ts');
  const db = await angelegt('P', { ...INPUT(), laborCost: 150, overheadCost: 50 });
  const r = await abschliessen(db, 'P', { recordId: recId(db) });
  const z = JSON.parse(abschluss(db));
  ok(r.ok && Number(z.rec.total_value) === 250 && Number(z.rec.total_cost) === 450,
    `KOSTEN Beleg: Material 250 + Arbeit 150 + Gemeinkosten 50 = total_cost 450 (${S(z.rec)})`);
  ok(S(z.outCost) === S([[100], [150]]) && S(z.lots) === S([[100, 1, 'ACTIVE'], [150, 1, 'ACTIVE']]),
    `KOSTEN Einstand der Fertigteile = Materialwert 100/150, Lose zum Materialwert (${S(z.outCost)} ${S(z.lots)})`);
  ok(S(z.exp) === S([['Miscellaneous', 200, 200, 'cash', 'PAID', 'production']]) && !isCapitalizedExpenseCategory('Miscellaneous'),
    `KOSTEN Arbeit + Gemeinkosten = EINE Betriebsausgabe 200, bar, nicht kapitalisiert (${S(z.exp)})`);
  ok(saldo(db, 'CASH') === -200 && saldo(db, 'EXPENSES_OPERATING') === 200 && saldo(db, 'ACCOUNTS_PAYABLE') === 0
    && n(db, "SELECT COUNT(*) FROM ledger_entries WHERE account IN ('INVENTORY', 'COGS')") === 0,
    'KOSTEN Hauptbuch: Aufwand 200 gegen Kasse; die Fertigung selbst bucht weder INVENTORY noch COGS (wertgleich 250 → 250)');
  // Späterer Verkauf beider Fertigteile — Einstand je Zeile nach der Regel des Rechnungswegs
  // (ältestes aktives Los, sonst purchase_price; `invoiceStore` ResolvedLine).
  const preis: Record<string, number> = { 'Ring A': 400, 'Ring B': 300 };
  const zeilen = rows(db, 'SELECT p.id, p.name, p.purchase_price FROM production_outputs o JOIN products p ON p.id = o.product_id ORDER BY p.name')
    .map((o, i) => {
      const lot = rows(db, `SELECT unit_cost FROM stock_lots WHERE product_id = ? AND status = 'ACTIVE' AND qty_remaining > 0
        ORDER BY acquired_at ASC, id ASC LIMIT 1`, [o.id])[0];
      const p = preis[String(o.name)];
      return { id: `il-r7a-${i}`, productId: String(o.id), quantity: 1, unitPrice: p, lineTotal: p, vatAmount: 0, vatRate: 0,
        taxScheme: 'MARGIN', purchasePriceSnapshot: Number(lot?.unit_cost ?? o.purchase_price) };
    });
  const jetzt = new Date().toISOString();
  posting.postInvoiceIssued({ id: 'inv-r7a-8', invoiceNumber: 'INV-R7A-8', customerId: 'c-r7a', currency: 'BHD',
    issuedAt: jetzt, createdAt: jetzt, lines: zeilen } as never);
  const marge = zeilen.reduce((sum, l) => sum + (l.unitPrice - l.purchasePriceSnapshot), 0);
  const betrieb = n(db, 'SELECT COALESCE(SUM(amount), 0) FROM expenses');
  const gewinnBuch = Math.round((-saldo(db, 'REVENUE') - saldo(db, 'COGS') - saldo(db, 'EXPENSES_OPERATING')) * 1000) / 1000;
  ok(S(zeilen.map((l) => l.purchasePriceSnapshot)) === S([150, 100]) && saldo(db, 'COGS') === 250 && saldo(db, 'INVENTORY') === -250,
    `VERKAUF Wareneinsatz = Materialwert (150/100), COGS 250 gegen INVENTORY 250 = Σ Eingangswert (${S(zeilen.map((l) => l.purchasePriceSnapshot))})`);
  ok(marge === 450 && betrieb === 200 && marge - betrieb === 250 && gewinnBuch === 250 && 700 - Number(z.rec.total_cost) === 250 && balanced(db),
    `MARGE Berichte 450 − Betriebsausgaben 200 = Hauptbuch ${gewinnBuch} = Erlös 700 − total_cost 450 — Arbeit/Gemeinkosten genau einmal`);
}
marker('POST_PARITY_R7A_PRODUCTION_ACCOUNTING_CONTRACT_PINNED');

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — post-parity r7a pp-2/pp-10 production completion + sync: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
