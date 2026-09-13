// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6F — ein Fertigungsvorgang (`production.create`): EINE Hausfolge für Primary und
// PC2 (`production-house`), am Primary über `createProductionOnPrimary` (→ `runOnPrimary`), fern über
// die C3A-Maschine. Run: node test/r6f/production-parity.test.ts
//
// Gefahren werden die ECHTE Hausfolge, der echte Anlageweg `createProductWithMedia` samt Orchestrator
// und Koordinator, das echte Schema samt Hauptbuch und Losen. Gestellt sind nur das Speichern, die
// IPC-Grenze zu Rust (`_tauri-shim`) und — im Client-Abschnitt — das Netz.
//
//   §1 Primary == PC2   §2 verlorene Antwort   §3 verbrauchte Eingänge (Stand statt Fassung)
//   §4 Fehlerinjektion (Medien, Los, Protokoll, Hauptbuch)   §5 Autorität + Negative   §6 Brücke
//   §7 Client   §8 Oberfläche
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

// ══ §1 — Primary == PC2 ═══════════════════════════════════════════════════════
{
  const dbA = freshDb();
  const a = await createProductionOnPrimary(INPUT());
  const wA = welt(dbA);
  const byA = s(dbA, 'SELECT created_by FROM production_records');
  const prodByA = all(dbA, 'SELECT created_by FROM products WHERE id IN (SELECT product_id FROM production_outputs)').map((r) => String(r[0]));
  ok(useProductionStore.getState().records.length === 1 && useProductionStore.getState().records[0].id === a.recordId,
    'PRIMARY die Liste zeigt den neuen Vorgang (runOnPrimary lädt neu)');

  const dbB = freshDb();
  const body = await remoteBody(INPUT());
  const staged = [...tauriState.staged.keys()].length;
  const b = await cmd.runProductionCreate(deps(dbB) as never, identity('1'), body);
  const wB = welt(dbB);
  const byB = s(dbB, 'SELECT created_by FROM production_records');
  const prodByB = all(dbB, 'SELECT created_by FROM products WHERE id IN (SELECT product_id FROM production_outputs)').map((r) => String(r[0]));

  ok(b.kind === 'ok', `PARITY PC2 legt den Vorgang an (${S(b).slice(0, 200)})`);
  ok(S(wA) === S(wB), `PARITY Beleg, Eingänge, Ausgänge, Lose, Bilder, Hauptbuch Zeichen für Zeichen gleich\n  A=${S(wA).slice(0, 600)}\n  B=${S(wB).slice(0, 600)}`);
  ok(byA === 'user-test' && byB === 'user-pc2' && prodByA.every((x) => x === 'user-test') && prodByB.every((x) => x === 'user-pc2'),
    `PARITY created_by: am Primary die Sitzung, fern der geprüfte Absender (${byA}/${byB} · ${S(prodByA)}/${S(prodByB)})`);
  ok(wA.recNoOk && Number(wA.rec.total_value) === 250 && Number(wA.rec.labor_cost) === 5 && Number(wA.rec.overhead_cost) === 2.5
    && Number(wA.rec.total_cost) === 257.5 && wA.rec.status === 'CONFIRMED' && wA.rec.branch_id === 'branch-main',
  `BELEG PRD-Nummer, Wert 250 = Eingang, Kosten 5 + 2.5, Summe 257.5, CONFIRMED (${S(wA.rec)})`);
  ok(S(wA.inputsNow) === S([['p1', 'consumed', 0], ['p2', 'consumed', 0]]) && S(wA.inputLots) === S([['lot-p1', 0, 'EXHAUSTED'], ['lot-p2', 0, 'EXHAUSTED']]),
    `EINGANG verbraucht, nicht gelöscht; Lose geleert (${S(wA.inputsNow)} ${S(wA.inputLots)})`);
  const [ringA, ringB] = wA.outputs;
  ok(wA.outputs.length === 2 && ringA.product.images === '[]' && ringB.product.images === '[]',
    'MEDIEN kein Bild als Text in products.images — die Galerie gehört dem Medienspeicher');
  ok(ringA.media.length === 2 && Number(ringA.media[0][1]) === 1 && Number(ringA.media[1][1]) === 0 && ringB.media.length === 0,
    `MEDIEN Ring A: zwei Bilder in Reihenfolge, Platz 0 Hauptbild; Ring B keins (${S(ringA.media)})`);
  ok(S(ringA.media.map((m) => m[2])) === S(wB.outputs[0].media.map((m) => m[2])) && !!ringA.media[0]?.[2],
    'MEDIEN …dieselben Bytes auf beiden Wegen (Inhaltshash des Hauptbilds)');
  ok(ringA.product.stock_status === 'in_stock' && ringA.product.source_type === 'OWN' && Number(ringA.product.quantity) === 1
    && Number(ringA.product.purchase_price) === 150 && ringA.product.purchase_currency === 'BHD' && ringA.product.planned_sale_price === null
    && ringA.product.storage_location === null,
  `AUSGANG eigene Ware im Bestand, Einstand = Wert, Menge 1, ausgeblendete Felder wirken nicht (${S(ringA.product)})`);
  ok(ringA.product.notes === 'hand made\nCreated from Production PRD-#' && String(ringA.product.scope_of_delivery).includes('Box'),
    `AUSGANG Notiz mit Herkunft, Lieferumfang (${S(ringA.product.notes)})`);
  ok(ringB.product.sku === 'PRD-SKU-1', `AUSGANG die getippte SKU, getrimmt (${S(ringB.product.sku)})`);
  ok(S(ringA.lots) === S([['branch-main', null, 150, 1, 1, 'ACTIVE']]) && S(ringB.lots) === S([['branch-main', null, 100, 1, 1, 'ACTIVE']]),
    `LOS je Ausgang ein Los zum Ausgangswert, ohne Einkauf (${S(ringA.lots)} ${S(ringB.lots)})`);
  ok(wA.ledger === 0 && wA.expenses === 0, 'HAUPTBUCH das Anlegen bucht nichts (Arbeit/Gemeinkosten erst beim Abschließen)');
  ok(wA.changelog === 1 && wA.audit === 1, `SPUR Abgleich + Protokoll des Belegs je einmal (${wA.changelog}/${wA.audit})`);
  const v = (b as { value: Record<string, unknown> }).value;
  ok(typeof v.recordNumber === 'string' && (v.outputProductIds as string[]).length === 2 && v.imageCount === 2 && v.totalValue === 250
    && Object.keys(v).sort().join(',') === 'imageCount,outputProductIds,recordId,recordNumber,totalValue',
  `ANTWORT klein: Beleg, Nummer, Wert, Ausgänge, Bildzahl (${S(v)})`);
  ok(!S(body).includes('data:image') && !S(body).includes('plannedSalePrice') && !S(body).includes('images')
    && S(Object.keys(body).sort()) === S(['inputProductIds', 'laborCost', 'notes', 'outputs', 'overheadCost']),
  `RUMPF keine Bytes, keine ausgeblendeten Felder — nur, was ein Mensch eingibt (${S(body).slice(0, 240)})`);
  ok(staged === 2 && tauriState.staged.size === 0 && tauriState.discarded.length === 2,
    `ABLAGE zwei Fotos abgelegt, nach dem Erfolg geräumt (${staged}/${tauriState.staged.size}/${tauriState.discarded.length})`);

  // ══ §2 — verlorene Antwort: dieselbe Kennung, genau eine Wirkung ═══════════
  const zaehler = () => S([n(dbB, 'SELECT COUNT(*) FROM production_records'), n(dbB, 'SELECT COUNT(*) FROM products'),
    n(dbB, 'SELECT COUNT(*) FROM stock_lots'), n(dbB, 'SELECT COUNT(*) FROM media_links'), commandCount(dbB as never),
    n(dbB, 'SELECT COUNT(*) FROM sync_changelog'), n(dbB, 'SELECT COUNT(*) FROM audit_log')]);
  const vorher = zaehler();
  const again = await cmd.runProductionCreate(deps(dbB) as never, identity('1'), body);
  ok(again.kind === 'ok' && (again as { replayed: boolean }).replayed === true && S((again as { value: unknown }).value) === S(v),
    'RETRY dieselbe Kennung: dieselbe Antwort, als Wiederholung erkannt');
  ok(zaehler() === vorher, `RETRY kein zweiter Beleg, Artikel, Los, Bild, Nachweis, Protokoll (${vorher})`);
  const conflict = await cmd.runProductionCreate(deps(dbB) as never, identity('1', 'ANDERS'), { ...body, notes: 'anders' });
  ok(conflict.kind === 'rejected' && codeOfOutcome(conflict) === 'COMMAND_ID_CONFLICT' && !frozen(conflict) && zaehler() === vorher,
    `RETRY dieselbe Kennung, anderer Rumpf: abgewiesen, nichts eingefroren, nichts geschrieben (${S(conflict)})`);

  // ══ §3 — Stand statt Fassung: ein inzwischen verbrauchter Eingang ist ein Nein ══
  const nochmal = await cmd.runProductionCreate(deps(dbB) as never, identity('2'), await remoteBody({ ...INPUT(), inputProductIds: ['p1', 'p2'] }));
  ok(nochmal.kind === 'rejected' && codeOfOutcome(nochmal) === 'PRODUCTION_INPUT_NOT_AVAILABLE' && frozen(nochmal),
    `STALE ein schon verbrauchter Eingang: eingefrorenes Nein (${codeOfOutcome(nochmal)})`);
  ok(n(dbB, 'SELECT COUNT(*) FROM production_records') === 1 && n(dbB, 'SELECT COUNT(*) FROM media_links') === 2,
    'STALE …und nichts geschrieben');
  const lokal = await wirftAsync(() => createProductionOnPrimary(INPUT()));
  ok(lokal.code === 'PRODUCTION_INPUT_NOT_AVAILABLE' && n(dbB, 'SELECT COUNT(*) FROM production_records') === 1,
    `STALE am Primary dieselbe Regel, derselbe Code (${lokal.code})`);
}
marker('CENTRAL_UI_R6F_PRODUCTION_PARITY_PROVED');

// ══ §4 — Fehlerinjektion: nichts Halbes, weder fern noch am Primary ═══════════
{
  // (a) Die Medien fallen aus (Veröffentlichen scheitert) — fern: kein Urteil, dieselbe Kennung darf erneut.
  {
    const db = freshDb();
    const body = await remoteBody(INPUT());
    tauriState.prepareShouldThrow = true;
    const failed = await cmd.runProductionCreate(deps(db) as never, identity('41'), body);
    tauriState.prepareShouldThrow = false;
    const u = unberuehrt(db);
    ok(failed.kind === 'rejected' && codeOfOutcome(failed) === 'PRODUCT_MEDIA_INCOMPLETE' && !frozen(failed),
      `FAIL-MEDIA ein Medienausfall ist kein Erfolg und kein Urteil (${S(failed)})`);
    ok(u.ok, `FAIL-MEDIA kein Beleg, kein Artikel, kein Bild, kein Nachweis, Eingänge unberührt (${S(u.z)})`);
    ok(tauriState.staged.size === 2 && tauriState.discarded.length === 0, 'FAIL-MEDIA die Ablage bleibt für die Wiederholung liegen');
    const retry = await cmd.runProductionCreate(deps(db) as never, identity('41'), body);
    ok(retry.kind === 'ok' && (retry as { replayed: boolean }).replayed === false && n(db, 'SELECT COUNT(*) FROM production_records') === 1
      && n(db, 'SELECT COUNT(*) FROM media_links') === 2 && tauriState.staged.size === 0,
    `FAIL-MEDIA dieselbe Kennung legt danach genau EINEN Vorgang an (${S(retry).slice(0, 120)})`);
  }
  {
    const db = freshDb();
    tauriState.prepareShouldThrow = true;
    const r = await wirftAsync(() => createProductionOnPrimary(INPUT()));
    tauriState.prepareShouldThrow = false;
    const u = unberuehrt(db);
    ok(r.code === 'PRODUCT_MEDIA_INCOMPLETE' && u.ok, `FAIL-MEDIA am Primary: dieselbe Klammer, nichts bleibt (${r.code} ${S(u.z)})`);
    ok(useProductionStore.getState().records.length === 0, 'FAIL-MEDIA …und die Liste zeigt keinen Geistervorgang');
  }

  // (b) Ein späterer Schreibschritt scheitert — das Los des ZWEITEN Ausgangs, nachdem beide Artikel
  //     samt Bildern und der erste Ausgang schon geschrieben sind.
  const losBruch = (db: Db) => db.run(`CREATE TRIGGER r6f_los BEFORE INSERT ON stock_lots
    WHEN NEW.purchase_id IS NULL AND (SELECT COUNT(*) FROM production_outputs) >= 2
    BEGIN SELECT RAISE(ABORT, 'R6F: injected lot'); END`);
  {
    const db = freshDb();
    const body = await remoteBody(INPUT());
    losBruch(db);
    const r = await wirftAsync(() => cmd.runProductionCreate(deps(db) as never, identity('42'), body));
    db.run('DROP TRIGGER r6f_los');
    const u = unberuehrt(db);
    ok(/injected lot/.test(r.message) && u.ok, `FAIL-LOS fern: der ganze Vorgang ist zurückgenommen (${r.message.slice(0, 60)} ${S(u.z)})`);
    ok(tauriState.staged.size === 2, 'FAIL-LOS …die Ablage bleibt');
    const retry = await cmd.runProductionCreate(deps(db) as never, identity('42'), body);
    ok(retry.kind === 'ok' && n(db, 'SELECT COUNT(*) FROM production_outputs') === 2, 'FAIL-LOS …dieselbe Kennung wirkt danach genau einmal');
  }
  {
    const db = freshDb();
    losBruch(db);
    const r = await wirftAsync(() => createProductionOnPrimary(INPUT()));
    db.run('DROP TRIGGER r6f_los');
    const u = unberuehrt(db);
    ok(/injected lot/.test(r.message) && u.ok, `FAIL-LOS am Primary: nichts bleibt (${S(u.z)})`);
  }

  // (c) Das Protokoll scheitert — der Beleg bleibt nicht ohne seine Protokollzeile stehen.
  {
    const db = freshDb();
    const body = await remoteBody(INPUT());
    db.run("CREATE TRIGGER r6f_audit BEFORE INSERT ON audit_log WHEN NEW.entity_type = 'production_records' BEGIN SELECT RAISE(ABORT, 'R6F: injected audit'); END");
    const r = await wirftAsync(() => cmd.runProductionCreate(deps(db) as never, identity('43'), body));
    const rp = await wirftAsync(() => createProductionOnPrimary(INPUT()));
    db.run('DROP TRIGGER r6f_audit');
    const u = unberuehrt(db);
    ok(/injected audit/.test(r.message) && /injected audit/.test(rp.message) && u.ok,
      `FAIL-AUDIT fern und am Primary: alles zurück (${r.message.slice(0, 40)} / ${rp.message.slice(0, 40)} ${S(u.z)})`);
  }

  // (d) Das Hauptbuch verweigert JEDE Buchung — das Anlegen geht trotzdem durch: es bucht nichts.
  {
    const db = freshDb();
    db.run("CREATE TRIGGER r6f_ledger BEFORE INSERT ON ledger_entries BEGIN SELECT RAISE(ABORT, 'R6F: no ledger'); END");
    const made = await createProductionOnPrimary(INPUT());
    const remote = await cmd.runProductionCreate(deps(db) as never, identity('44'), await remoteBody({
      ...INPUT(), inputProductIds: ['p-legacy'], laborCost: undefined, overheadCost: undefined,
      outputs: [{ spec: { categoryId: 'cat-watch', brand: 'Custom', name: 'Ring C' }, value: 50 }],
    }));
    db.run('DROP TRIGGER r6f_ledger');
    ok(!!made.recordId && remote.kind === 'ok' && n(db, 'SELECT COUNT(*) FROM ledger_entries') === 0,
      `LEDGER das Anlegen bucht nie — auch ein Eingang ohne Lose geht durch (${S(remote).slice(0, 80)})`);
    ok(s(db, "SELECT stock_status FROM products WHERE id = 'p-legacy'") === 'consumed',
      'LEDGER …und der Eingang ohne Lose ist verbraucht');
  }
}
marker('CENTRAL_UI_R6F_PRODUCTION_ATOMICITY_PROVED');

// ══ §5 — Autorität und Negative ═══════════════════════════════════════════════
{
  const db = freshDb();
  const OUT = (value: number, spec: Record<string, unknown> = {}) => ({ spec: { categoryId: 'cat-watch', brand: 'Custom', name: 'X', ...spec }, value });
  const fall = async (x: string, body: Record<string, unknown>, ident = identity(x)) => cmd.runProductionCreate(deps(db) as never, ident, body);
  const leer = () => n(db, 'SELECT COUNT(*) FROM production_records') === 0 && n(db, 'SELECT COUNT(*) FROM products') === PRODUKTE.length
    && n(db, "SELECT COUNT(*) FROM products WHERE stock_status = 'consumed'") === 0;

  for (const [x, what, body, code] of [
    ['51', 'Eingang einer fremden Filiale', { inputProductIds: ['p-foreign'], outputs: [OUT(100)] }, 'PRODUCTION_INPUT_NOT_FOUND'],
    ['52', 'unbekannter Eingang', { inputProductIds: ['gibt-es-nicht'], outputs: [OUT(100)] }, 'PRODUCTION_INPUT_NOT_FOUND'],
    ['53', 'verkaufter Eingang', { inputProductIds: ['p-sold'], outputs: [OUT(80)] }, 'PRODUCTION_INPUT_NOT_AVAILABLE'],
    ['54', 'Eingang mit drei Stück', { inputProductIds: ['p-multi'], outputs: [OUT(30)] }, 'PRODUCTION_INPUT_MULTI_PIECE'],
    ['55', 'Wert ungleich (11 Fils daneben)', { inputProductIds: ['p1'], outputs: [OUT(99.989)] }, 'PRODUCTION_VALUE_MISMATCH'],
    ['56', 'vergebene SKU (andere Schreibweise)', { inputProductIds: ['p1'], outputs: [OUT(100, { sku: ' sku-p2 ' })] }, 'SKU_TAKEN'],
    ['57', 'zweimal dieselbe SKU im Vorgang', { inputProductIds: ['p1'], outputs: [OUT(50, { sku: 'NEW-1' }), OUT(50, { sku: 'new-1' })] }, 'SKU_TAKEN'],
    ['58', 'unbekannte Kategorie', { inputProductIds: ['p1'], outputs: [OUT(100, { categoryId: 'cat-gibt-es-nicht' })] }, 'CATEGORY_NOT_FOUND'],
    ['59', 'Uhr ohne Namen', { inputProductIds: ['p1'], outputs: [{ spec: { categoryId: 'cat-watch', brand: 'Custom' }, value: 100 }] }, 'PRODUCT_FIELDS_REQUIRED'],
  ] as Array<[string, string, Record<string, unknown>, string]>) {
    const r = await fall(x, body);
    ok(r.kind === 'rejected' && codeOfOutcome(r) === code && frozen(r) && leer(),
      `NEIN ${what}: ${code}, eingefroren, nichts geschrieben (${codeOfOutcome(r)})`);
  }
  // Toleranz des Vorgangs (0.01 BHD) gilt weiter: 10 Fils daneben geht durch — auf einer eigenen Welt.
  {
    const dbT = freshDb();
    const r = await cmd.runProductionCreate(deps(dbT) as never, identity('60'), { inputProductIds: ['p1'], outputs: [OUT(99.99)] });
    ok(r.kind === 'ok' && Number(one(dbT, 'SELECT total_value FROM production_records')) === 100,
      `TOLERANZ 0.01 BHD Rundung wie bisher erlaubt (${S(r).slice(0, 80)})`);
    setTestDatabase(db as never);
    useProductStore.getState().loadProducts();
  }
  // Die Filiale des Ausweises muss die dieses Rechners sein.
  const fremd = await fall('61', { inputProductIds: ['p1'], outputs: [OUT(100)] }, { ...identity('61'), branchId: 'branch-other' });
  ok(fremd.kind === 'rejected' && codeOfOutcome(fremd) === 'BRANCH_MISMATCH' && leer(), `NEIN Ausweis einer anderen Filiale (${codeOfOutcome(fremd)})`);
  // Der Primary-Weg sagt dieselben Neins mit denselben Codes.
  const lokal = await wirftAsync(() => createProductionOnPrimary({ inputProductIds: ['p-multi'], outputs: [OUT(30)] as never }));
  const lokal2 = await wirftAsync(() => createProductionOnPrimary({ inputProductIds: ['p1', 'p1'], outputs: [OUT(200)] as never }));
  ok(lokal.code === 'PRODUCTION_INPUT_MULTI_PIECE' && lokal2.code === 'PRODUCTION_INPUT_DUPLICATE' && leer(),
    `NEIN am Primary: dieselben Codes (${lokal.code}/${lokal2.code})`);

  // Eine Ablage eines ANDEREN Benutzers ist von hier aus nicht vorhanden.
  tauriState.reset();
  const fremdeAblage = await remoteBody({ inputProductIds: ['p1'], outputs: [{ spec: { categoryId: 'cat-watch', brand: 'C', name: 'F', images: [dataUrl(B1)] }, value: 100 }] },
    { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-fremd' });
  const gestohlen = await wirftAsync(() => fall('62', fremdeAblage));
  // Neun Urteile oben + BRANCH_MISMATCH = zehn eingefrorene Nachweise; die fremde Ablage fügt keinen hinzu.
  ok(/staged image is gone/.test(gestohlen.message) && leer() && commandCount(db as never) === 10,
    `NEIN eine fremde Ablage öffnet nichts, es entsteht nichts (${gestohlen.message.slice(0, 60)})`);

  // Der Rumpf: verboten, abgeleitet, unbekannt, kaputt — abgewiesen, bevor irgendetwas läuft.
  const B = { inputProductIds: ['p1'], outputs: [OUT(100)] };
  const faelle: Array<[string, unknown]> = [
    ['id', { ...B, id: 'x' }], ['branchId', { ...B, branchId: 'branch-other' }], ['userId', { ...B, userId: 'boss' }],
    ['createdBy', { ...B, createdBy: 'boss' }], ['created_by', { ...B, created_by: 'boss' }], ['actor', { ...B, actor: 'boss' }],
    ['status', { ...B, status: 'COMPLETED' }], ['recordNumber', { ...B, recordNumber: 'PRD-1' }], ['totalValue', { ...B, totalValue: 1 }],
    ['totalCost', { ...B, totalCost: 1 }], ['productionDate', { ...B, productionDate: '2020-01-01' }], ['ledger', { ...B, ledger: [] }],
    ['revision', { ...B, revision: 3 }],
    ['spec.purchasePrice', { ...B, outputs: [OUT(100, { purchasePrice: 1 })] }], ['spec.stockStatus', { ...B, outputs: [OUT(100, { stockStatus: 'sold' })] }],
    ['spec.sourceType', { ...B, outputs: [OUT(100, { sourceType: 'CONSIGNMENT' })] }], ['spec.quantity', { ...B, outputs: [OUT(100, { quantity: 5 })] }],
    ['spec.images', { ...B, outputs: [OUT(100, { images: ['data:image/jpeg;base64,AAAA'] })] }], ['spec.createdBy', { ...B, outputs: [OUT(100, { createdBy: 'boss' })] }],
    ['spec.branchId', { ...B, outputs: [OUT(100, { branchId: 'branch-other' })] }], ['spec.id', { ...B, outputs: [OUT(100, { id: 'p-x' })] }],
    ['output.productId', { ...B, outputs: [{ ...OUT(100), productId: 'p1' }] }], ['output.lotId', { ...B, outputs: [{ ...OUT(100), lotId: 'l1' }] }],
    ['unbekannt', { ...B, discount: 5 }], ['spec.unbekannt', { ...B, outputs: [OUT(100, { secret: 1 })] }],
    ['Wert 0', { ...B, outputs: [OUT(0)] }], ['Wert als Text', { ...B, outputs: [{ spec: OUT(1).spec, value: '100' }] }],
    ['Arbeit negativ', { ...B, laborCost: -1 }], ['keine Eingänge', { ...B, inputProductIds: [] }],
    ['doppelter Eingang', { ...B, inputProductIds: ['p1', 'p1'] }], ['keine Ausgänge', { ...B, outputs: [] }],
    ['Ablage als Pfad', { ...B, outputs: [OUT(100, { stagingIds: ['../../etc/passwd'] })] }],
    ['neun Bilder', { ...B, outputs: [OUT(100, { stagingIds: Array.from({ length: 9 }, (_, i) => String(i).repeat(64)) })] }],
    ['Steuer unbekannt', { ...B, outputs: [OUT(100, { taxScheme: 'VAT_99' })] }], ['kein Objekt', 'p1'],
  ];
  for (const [what, body] of faelle) {
    let threw: unknown = null;
    try { await fall('63', body as never); } catch (e) { threw = e; }
    ok(threw instanceof cmd.ProductionPayloadError && leer(), `RUMPF ${what} wird abgewiesen (${String((threw as Error)?.message ?? threw).slice(0, 80)})`);
  }
  ok(commandCount(db as never) === 10, 'RUMPF …und kein einziger Nachweis mehr als die zehn Urteile oben');
}
marker('CENTRAL_UI_R6F_PRODUCTION_AUTHORITY_PROVED');

// ══ §6 — Die Brücke: eine Anmeldung, keine Rolle nötig, Urteile als fachliches Nein ═══════════
{
  const db = freshDb();
  ok(registry.ALLOWED_MUTATIONS.includes('production.create') && registry.knownCommands().includes('production.create'),
    'BRIDGE production.create ist freigegeben und angemeldet');
  ok(perms.OPERATION_PERMISSIONS['production.create'] === null, 'BRIDGE keine Sonderrolle — wie die Maske am Primary');
  const body = await remoteBody(INPUT());
  const reply = await registry.executeCommand('production.create', { input: body }, { ...ACTOR, commandId: ID('71'), payloadHash: 'h71' } as never);
  ok(reply.kind === 'ok' && n(db, 'SELECT COUNT(*) FROM production_records') === 1, `BRIDGE der angemeldete Weg legt an (${S(reply).slice(0, 160)})`);
  const bad = await registry.executeCommand('production.create', { input: { ...body, createdBy: 'boss' } }, { ...ACTOR, commandId: ID('72'), payloadHash: 'h72' } as never);
  ok(bad.kind === 'business_error' && (bad as { code: string }).code === 'PRODUCTION_PAYLOAD_INVALID', `BRIDGE ein verbotenes Feld ist ein fachliches Nein (${S(bad)})`);
  const nein = await registry.executeCommand('production.create', { input: { inputProductIds: ['p-sold'], outputs: [{ spec: { categoryId: 'cat-watch', brand: 'C', name: 'N' }, value: 80 }] } },
    { ...ACTOR, commandId: ID('73'), payloadHash: 'h73' } as never);
  ok(nein.kind === 'business_error' && (nein as { code: string }).code === 'PRODUCTION_INPUT_NOT_AVAILABLE', `BRIDGE ein Urteil kommt als fachliches Nein an (${S(nein)})`);
  const reg = codeOf(src('src/core/bridge/production-commands.ts'));
  ok((reg.match(/registerCommand\(/g) ?? []).length === 1 && /registerCommand\(OP_PRODUCTION_CREATE, \{\s*kind: 'mutation'/.test(reg),
    'BRIDGE genau EINE ausdrückliche Anmeldung');
}
marker('CENTRAL_UI_R6F_PRODUCTION_BRIDGE_PROVED');

// ══ §7 — Client: keine lokale Datenbank, der Weg geht über den Primary ═══════
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
  const calls: Array<Record<string, unknown>> = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    calls.push(JSON.parse(init.body) as Record<string, unknown>);
    return new Response(JSON.stringify({ ok: true, value: { recordId: 'r-1', replayed: false } }), { status: 200 });
  }) as never;
  try {
    const a = await wirftAsync(() => createProductionOnPrimary(INPUT()));
    const b = await wirftAsync(() => useProductionStore.getState().createRecord(INPUT()));
    const c = await wirftAsync(() => house.createProductionInHouse(INPUT(), { branchId: 'branch-main', userId: 'u' }));
    ok(a.code === 'PRODUCTION_PRIMARY_ONLY' && b.code === 'PRODUCTION_PRIMARY_ONLY' && c.code === 'PRODUCTION_PRIMARY_ONLY' && touched === 0,
      `CLIENT jeder Primary-Anschluss verweigert, bevor er eine Datenbank anfasst (${S([a.code, b.code, c.code])}, Zugriffe ${touched})`);
    const bodies = await house.productionOutputBodies(INPUT().outputs, async (urls) => urls.map((_, i) => String(i + 1).repeat(64)));
    const attempt = new CommandSaveController<Record<string, unknown>>('production.create').beginAttempt();
    const r = await runSharedWrite(true, {
      local: () => { throw new Error('lokal'); },
      remote: () => house.productionCreateRequest(INPUT(), bodies),
    }, attempt);
    const sent = calls.find((x) => x.op === 'production.create');
    const payload = sent?.payload as Record<string, unknown> | undefined;
    ok(r.kind === 'ok' && calls.length === 1 && !!payload && touched === 0
      && S(Object.keys(payload).sort()) === S(['inputProductIds', 'laborCost', 'notes', 'outputs', 'overheadCost'])
      && !S(payload).includes('data:') && S((payload.outputs as Array<{ spec: { stagingIds?: string[] } }>)[0].spec.stagingIds) === S(['1'.repeat(64), '2'.repeat(64)]),
    `CLIENT genau EIN geprüfter Auftrag mit Kennungen statt Bytes — keine lokale Wirkung (${S(payload).slice(0, 200)})`);
  } finally {
    globalThis.fetch = origFetch;
    store.delete('lataif_runtime_mode');
    store.delete('lataif_client_server_url');
    store.delete('lataif_client_token');
    setTestDatabase(db as never);
  }
}
marker('CENTRAL_UI_R6F_PRODUCTION_CLIENT_PROVED');

// ══ §8 — Oberfläche und Einbahn: EIN Anschluss, keine zweite Fertigungslogik ═══
{
  const page = codeOf(src('src/pages/production/ProductionPage.tsx'));
  ok(/useSharedWrite<unknown>\('production\.create'\)/.test(page) && /local: \(\) => createRecord\(input\)/.test(page)
    && /remote: \(\) => productionCreateRequest\(input, bodies\)/.test(page) && /productionOutputBodies\(input\.outputs, stageDataUrls\)/.test(page),
  'UI „Confirm Production": die gemeinsame Weiche — Store (Primary) oder geprüfter Fernbefehl (PC2), Fotos über die Ablage');
  ok(/if \(r\.kind !== 'ok'\) \{ setError\(fehlertext\(r\)\); return; \}/.test(page) && /disabled=\{!balanced \|\| inputTotal <= 0 \|\| anlegen\.busy\}/.test(page),
    'UI Erfolg nur bei ok, sonst der Grund; gesperrt, solange ein Versuch läuft');
  for (const attr of ['data-production-new', 'data-production-inputs', 'data-production-output-add', 'data-production-output-value',
    'data-production-output-edit', 'data-production-output-remove', 'data-production-labor', 'data-production-overhead',
    'data-production-notes', 'data-production-save', 'data-production-error']) {
    ok(page.includes(attr), `UI ${attr}`);
  }
  const st = codeOf(src('src/stores/productionStore.ts'));
  const create = st.slice(st.indexOf('createRecord: async (input)'), st.indexOf('completeRecord: (id, laborCost, overheadCost)'));
  ok(/createProductionOnPrimary\(input\)/.test(create) && !/INSERT INTO|branch-main|user-owner|saveDatabase/.test(create),
    'STORE createRecord ist nur noch der Anschluss an die Hausfolge (kein eigenes INSERT, kein stilles branch-main)');
  ok(/export async function createProductionOnPrimary[\s\S]{0,200}assertProductionHere\(\)[\s\S]{0,120}runOnPrimary\(\(\) => createProductionInHouse\(input, ctx\), nachFertigung\)/.test(st),
    'STORE am Primary: Riegel, dann runOnPrimary(Hausfolge)');
  const h = codeOf(src('src/core/production/production-house.ts'));
  ok(/createProductWithMedia\(/.test(h) && /alreadySerialised: true/.test(h) && !/INSERT INTO products|images = |UPDATE products SET images/.test(h),
    'HOUSE jeder Ausgang über den Anlageweg des Hauses — kein eigenes Produkt-INSERT, kein Bild in products.images');
  ok(!/BEGIN|COMMIT|ROLLBACK|saveDatabase|rollbackLedgerTransaction|beginLedgerTransaction/.test(h) && /logAuditOrThrow\(/.test(h),
    'HOUSE öffnet und schließt keine Transaktion, speichert nicht; das Protokoll gehört zum Vorgang');
}
marker('CENTRAL_UI_R6F_PRODUCTION_UI_PROVED');

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — R6F production parity: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R6F_PRODUCTION_PROVED');
