// ════════════════════════════════════════════════════════════════════════════
// MOBILE-EDIT v0.8.48 — wer darf seine Preise noch aendern, und wann wird das entschieden?
// Run: node test/mobile-price-eligibility/price-eligibility.test.ts
//
// Zwei Fragen, beide gegen eine ECHTE sql.js-Datenbank mit echten Relationen:
//
//   1. Die Regel selbst. Herkunft wird positiv nachgewiesen (`mobile_upload_receipts`), und jede
//      geschaeftliche Verknuepfung sperrt. Geprueft wird jede Tabelle aus `TRANSACTION_RELATIONS`
//      einzeln — eine vergessene waere sonst genau die Luecke, die niemand bemerkt.
//   2. WANN sie geprueft wird. Eine Pruefung vor der Transaktion ist wertlos, wenn zwischen ihr und
//      dem Schreiben ein Verkauf entsteht. Deshalb laeuft die verbindliche Pruefung im Koordinator,
//      in derselben Transaktion wie der UPDATE — und genau das wird hier nachgestellt.
//
// Der Koordinator ist der echte. Nichts wird nachgebaut, was in Produktion anders liefe.
// ════════════════════════════════════════════════════════════════════════════

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import initSqlJs from 'sql.js';
import { applyMediaSchema, MEDIA_ENTITY_SCOPE } from '../../src/core/db/media-schema.ts';
import { MediaDbCoordinator } from '../../src/core/media/coordinator.ts';
import { evaluatePriceEligibility, TRANSACTION_RELATIONS, PRICE_COLUMNS, touchesPriceColumns } from '../../src/core/products/price-eligibility.ts';
import type {
  AbortInput, AbortResult, CommitInput, CommitResult, MediaBytes,
  MediaCommandGateway, PrepareInput, PrepareResult, ReadVerifiedInput, RecoveryOutcome,
} from '../../src/core/media/gateway.ts';

const here = dirname(fileURLToPath(import.meta.url));
const WASM = join(here, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');

let PASS = 0, FAIL = 0;
const failures: string[] = [];
function ok(cond: unknown, msg: string): void { if (cond) PASS++; else { FAIL++; failures.push(msg); console.log(`  ✗ ${msg}`); } }

const TENANT = 't1', BRANCH = 'b1';

/** Ein Gateway wird gebraucht, weil der Koordinator eines verlangt — benutzt wird es hier nicht. */
class UnusedGateway implements MediaCommandGateway {
  async prepareStockImage(): Promise<PrepareResult> { throw new Error('not used'); }
  async commitStockImage(_i: CommitInput): Promise<CommitResult> { throw new Error('not used'); }
  async abortStockImage(i: AbortInput): Promise<AbortResult> { return { ingest_request_id: i.ingestRequestId, state: 'aborted' }; }
  async readVerifiedMedia(_i: ReadVerifiedInput): Promise<MediaBytes> { throw new Error('not used'); }
  async recoverMediaIngests(): Promise<RecoveryOutcome[]> { return []; }
  private _p?: PrepareInput;
}

type Db = { run: (sql: string, p?: unknown[]) => void; exec: (sql: string, p?: unknown[]) => Array<{ columns: string[]; values: unknown[][] }> };

function newDb(SQL: { Database: new () => Db }): Db {
  const db = new SQL.Database();
  applyMediaSchema({ run: (sql: string) => db.run(sql) });
  db.run(`CREATE TABLE tenants  (id TEXT PRIMARY KEY)`);
  db.run(`CREATE TABLE branches (id TEXT PRIMARY KEY, tenant_id TEXT)`);
  for (const t of Object.values(MEDIA_ENTITY_SCOPE)) db.run(`CREATE TABLE IF NOT EXISTS ${t.table} (id TEXT PRIMARY KEY, branch_id TEXT, tenant_id TEXT)`);
  for (const c of ['brand', 'name', 'category_id', 'sku', 'attributes', 'updated_at', 'notes', 'source_type', 'scope_of_delivery', 'image_hash', 'image_description', 'image_embedding']) {
    db.run(`ALTER TABLE products ADD COLUMN ${c} TEXT`);
  }
  for (const c of PRICE_COLUMNS) db.run(`ALTER TABLE products ADD COLUMN ${c} REAL`);
  db.run(`ALTER TABLE products ADD COLUMN quantity REAL DEFAULT 1`);
  db.run(`ALTER TABLE products ADD COLUMN images TEXT DEFAULT '[]'`);
  db.run(`CREATE TABLE sync_changelog (id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT, record_id TEXT, action TEXT)`);
  db.run(`CREATE TABLE audit_log (id TEXT PRIMARY KEY, branch_id TEXT, module TEXT, entity_type TEXT, entity_id TEXT, action_type TEXT, field_name TEXT, old_value TEXT, new_value TEXT, changed_by TEXT, changed_at TEXT)`);
  db.run(`CREATE TABLE mobile_upload_receipts (tenant_id TEXT, branch_id TEXT, authenticated_user_id TEXT, upload_event_id TEXT, payload_hash TEXT, entity_id TEXT, create_batch_id TEXT, product_id TEXT, canonical_product_metadata_hash TEXT, prepared_manifest_hash TEXT, created_at TEXT)`);
  // Jede Relation aus der SSOT — mit genau den Spalten, die die Pruefung anfasst, plus einer
  // eingefrorenen Preisspalte dort, wo die Historie sie in Wirklichkeit fuehrt.
  for (const t of TRANSACTION_RELATIONS) {
    // Einige dieser Namen legt bereits das Medien-Schema an (`orders`); dann fehlen nur die
    // Spalten, um die es hier geht.
    db.run(`CREATE TABLE IF NOT EXISTS ${t} (id TEXT PRIMARY KEY, product_id TEXT, frozen_price REAL)`);
    const cols = db.exec(`PRAGMA table_info(${t})`)[0].values.map((v) => String(v[1]));
    if (!cols.includes('product_id')) db.run(`ALTER TABLE ${t} ADD COLUMN product_id TEXT`);
    if (!cols.includes('frozen_price')) db.run(`ALTER TABLE ${t} ADD COLUMN frozen_price REAL`);
    db.run(`DELETE FROM ${t}`);
  }
  db.run(`CREATE TABLE inventory_session_items (id TEXT PRIMARY KEY, product_id TEXT)`);
  db.run(`INSERT INTO tenants (id) VALUES ('${TENANT}')`);
  db.run(`INSERT INTO branches (id, tenant_id) VALUES ('${BRANCH}','${TENANT}')`);
  return db;
}

const counter = (db: Db) => (sql: string, params: unknown[]): number => {
  const bound = sql.replace('?', `'${String(params[0]).replace(/'/g, "''")}'`);
  const r = db.exec(bound);
  return r.length && r[0].values.length ? Number(r[0].values[0][0]) : -1;
};

function addProduct(db: Db, id: string, opts: { receipt: boolean; sourceType?: string; purchase?: number; sale?: number; min?: number }): void {
  db.run(
    `INSERT INTO products (id, branch_id, tenant_id, name, source_type, purchase_price, planned_sale_price, min_sale_price, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00Z')`,
    [id, BRANCH, TENANT, 'Item ' + id, opts.sourceType ?? 'OWN', opts.purchase ?? 100, opts.sale ?? 150, opts.min ?? 140],
  );
  if (opts.receipt) {
    db.run(
      `INSERT INTO mobile_upload_receipts (tenant_id, branch_id, authenticated_user_id, upload_event_id, payload_hash, entity_id, create_batch_id, product_id, canonical_product_metadata_hash, prepared_manifest_hash, created_at)
       VALUES (?, ?, 'u1', ?, 'ph', ?, 'batch', ?, 'h', 'h', '2026-01-01T00:00:00Z')`,
      [TENANT, BRANCH, 'ev-' + id, id, id],
    );
  }
}

const priceRow = (db: Db, id: string): unknown[] => {
  const r = db.exec(`SELECT purchase_price, planned_sale_price, min_sale_price, sku, category_id, quantity FROM products WHERE id = '${id}'`);
  return r.length ? r[0].values[0] : [];
};
const dumpAll = (db: Db, table: string): string => {
  const r = db.exec(`SELECT * FROM ${table} ORDER BY id`);
  return r.length ? JSON.stringify(r[0].values) : '[]';
};

/** Ein mobiler Preis-Patch, wie ihn die Verdrahtung baut — inklusive der Flagge aus §6. */
function mobilePriceEdit(set: Array<[string, number | null]>, baseline: Array<number | null>) {
  return {
    set, baseline,
    invalidateImageDerived: false,
    withSync: false,
    priceEligibilityRequired: true,
    audit: { module: 'Product', changedBy: null, newValueJson: '{}' },
  };
}

// ════════════════════════════════════════════════════════════════════════════
async function main(): Promise<void> {
  const SQL = await initSqlJs({ locateFile: () => WASM }) as unknown as { Database: new () => Db };

  // ── Die Regel selbst: eigener freier Bestand, unabhaengig vom Anlageweg ──
  {
    const db = newDb(SQL);
    // Genau derselbe Artikel, einmal ueber das Handy angelegt (mit Upload-Quittung) und einmal am
    // Desktop (ohne). Fachlich sind beide dasselbe: eigener, unverkaufter Bestand.
    addProduct(db, "p-mobile", { receipt: true });
    addProduct(db, "p-desktop", { receipt: false });
    addProduct(db, "p-legacy", { receipt: false });
    addProduct(db, "p-consigned", { receipt: false, sourceType: "CONSIGNMENT" });
    addProduct(db, "p-agent", { receipt: true, sourceType: "AGENT" });
    const c = counter(db);

    ok(evaluatePriceEligibility("p-mobile", c).allowed, "ORIGIN a mobile-created item is eligible");
    ok(evaluatePriceEligibility("p-desktop", c).allowed,
      "ORIGIN a DESKTOP-created item is just as eligible — the upload receipt is not a permission");
    ok(evaluatePriceEligibility("p-legacy", c).allowed,
      "ORIGIN an imported or migrated item is not locked out for lacking a receipt");

    const cons = evaluatePriceEligibility("p-consigned", c);
    ok(!cons.allowed && cons.reason === "not_own_stock", `ORIGIN consigned goods are NOT own stock (${JSON.stringify(cons)})`);
    const agent = evaluatePriceEligibility("p-agent", c);
    ok(!agent.allowed && agent.reason === "not_own_stock",
      `ORIGIN goods out with an agent are NOT own stock, receipt or not (${JSON.stringify(agent)})`);

    ok(!evaluatePriceEligibility("", c).allowed, "ORIGIN an empty id is never eligible");
    ok(!evaluatePriceEligibility("p-does-not-exist", c).allowed, "ORIGIN an unknown item is never eligible");

    // NEGATIVKONTROLLE der alten, falschen Regel: haenge man die Berechtigung wieder an die
    // Upload-Quittung, waere der Desktop-Artikel gesperrt — genau der Fehler, der hier behoben wird.
    const receiptCount = c("SELECT COUNT(*) AS c FROM mobile_upload_receipts WHERE product_id = ?", ["p-desktop"]);
    ok(receiptCount === 0, "NEGATIVE CONTROL the desktop item really has no upload receipt…");
    ok(evaluatePriceEligibility("p-desktop", c).allowed,
      "NEGATIVE CONTROL …and is eligible anyway — the old receipt condition would have refused it");
  }
  // JEDE Relation sperrt — einzeln geprueft, damit keine vergessen werden kann.
  for (const table of TRANSACTION_RELATIONS) {
    const db = newDb(SQL);
    addProduct(db, 'p-1', { receipt: true });
    const c = counter(db);
    ok(evaluatePriceEligibility('p-1', c).allowed, `B ${table}: eligible before the relation exists`);
    db.run(`INSERT INTO ${table} (id, product_id) VALUES ('r-1', 'p-1')`);
    const v = evaluatePriceEligibility('p-1', c);
    ok(!v.allowed && v.reason === 'has_transaction' && v.relation === table,
      `B a row in ${table} locks the prices (${JSON.stringify(v)})`);
  }

  // Eine Inventurzaehlung ist KEIN Geschaeftsvorgang und darf nicht sperren.
  {
    const db = newDb(SQL);
    addProduct(db, 'p-1', { receipt: true });
    db.run(`INSERT INTO inventory_session_items (id, product_id) VALUES ('i-1','p-1')`);
    ok(evaluatePriceEligibility('p-1', counter(db)).allowed,
      'B a stock-check entry does not lock the prices — counting is an observation, not a transaction');
  }

  // Eine Relation, die nicht gelesen werden kann, sperrt ebenfalls (fail closed).
  {
    const db = newDb(SQL);
    addProduct(db, 'p-1', { receipt: true });
    db.run(`DROP TABLE invoice_lines`);
    const v = evaluatePriceEligibility('p-1', counter(db));
    ok(!v.allowed && v.relation === 'invoice_lines', `B an unreadable relation locks too (${JSON.stringify(v)})`);
  }

  ok(touchesPriceColumns([['notes', 'x']]) === false, 'RULE a text-only patch does not touch the price rule');
  ok(touchesPriceColumns([['notes', 'x'], ['min_sale_price', 1]]) === true, 'RULE a patch containing one price does');

  // ── A: der erlaubte Fall, durch den ECHTEN Koordinator — OHNE Quittung ───
  {
    const db = newDb(SQL);
    addProduct(db, 'p-1', { receipt: false });   // Desktop-Collection: kein Mobile-Receipt
    const co = new MediaDbCoordinator(db as never, new UnusedGateway());
    const before = priceRow(db, 'p-1');
    co.applyProductTextEditDurably({
      tenantId: TENANT, branchId: BRANCH, entityId: 'p-1', batchId: 'b-allowed',
      productEdit: mobilePriceEdit([['purchase_price', 110], ['planned_sale_price', 165], ['min_sale_price', 150]], [100, 150, 140]),
    });
    const after = priceRow(db, 'p-1');
    ok(Number(after[0]) === 110 && Number(after[1]) === 165 && Number(after[2]) === 150,
      `CASE-A all three prices were written (${JSON.stringify(after.slice(0, 3))})`);
    ok(after[3] === before[3] && after[4] === before[4] && Number(after[5]) === Number(before[5]),
      'CASE-A SKU, category and quantity are untouched');
  }

  // ── B: nur EIN Preis geaendert, die anderen bleiben exakt ────────────────
  {
    const db = newDb(SQL);
    addProduct(db, 'p-1', { receipt: true });
    const co = new MediaDbCoordinator(db as never, new UnusedGateway());
    co.applyProductTextEditDurably({
      tenantId: TENANT, branchId: BRANCH, entityId: 'p-1', batchId: 'b-one',
      productEdit: mobilePriceEdit([['planned_sale_price', 165]], [150]),
    });
    const after = priceRow(db, 'p-1');
    ok(Number(after[0]) === 100 && Number(after[1]) === 165 && Number(after[2]) === 140,
      `CASE-B only the changed price moved (${JSON.stringify(after.slice(0, 3))})`);
  }

  // ── C/D: verknuepfter Artikel — der Koordinator weist ab, nichts wird teilweise geschrieben ──
  for (const table of ['invoice_lines', 'purchase_lines', 'stock_lots', 'consignments']) {
    const db = newDb(SQL);
    addProduct(db, 'p-1', { receipt: true });
    db.run(`INSERT INTO ${table} (id, product_id, frozen_price) VALUES ('r-1','p-1', 99)`);
    const co = new MediaDbCoordinator(db as never, new UnusedGateway());
    const before = priceRow(db, 'p-1');
    const historyBefore = dumpAll(db, table);
    let thrown: unknown = null;
    try {
      co.applyProductTextEditDurably({
        tenantId: TENANT, branchId: BRANCH, entityId: 'p-1', batchId: 'b-' + table,
        // Der Patch enthaelt AUCH ein erlaubtes Feld — es darf trotzdem nichts committed werden.
        productEdit: { ...mobilePriceEdit([['planned_sale_price', 165]], [150]), set: [['notes', 'allowed'], ['planned_sale_price', 165]], baseline: [null, 150] },
      });
    } catch (e) { thrown = e; }
    ok((thrown as { message?: string })?.message === 'MOBILE_PRICE_NOT_ELIGIBLE',
      `CASE-C ${table}: the price change is refused (${(thrown as { message?: string })?.message})`);
    ok(JSON.stringify(priceRow(db, 'p-1')) === JSON.stringify(before), `CASE-C ${table}: no price moved`);
    const notes = db.exec(`SELECT notes FROM products WHERE id='p-1'`)[0].values[0][0];
    ok(notes === null, `CASE-C ${table}: and the allowed field was NOT committed on its own (${String(notes)})`);
    ok(dumpAll(db, table) === historyBefore, `CASE-C ${table}: the historical row is byte-identical`);
  }

  // ── §6 ATOMAR: die Verknuepfung entsteht NACH der Vorpruefung ────────────
  //
  // Genau die Luecke, um die es geht: erst fragen, dann schreiben — und dazwischen wird verkauft.
  // Die Vorpruefung sagt hier ausdruecklich "erlaubt", danach entsteht die Rechnungszeile, und erst
  // dann laeuft der Schreibvorgang. Nur weil die verbindliche Pruefung IN der Transaktion sitzt,
  // faellt das auf.
  {
    const db = newDb(SQL);
    addProduct(db, 'p-1', { receipt: true });
    const c = counter(db);
    ok(evaluatePriceEligibility('p-1', c).allowed, 'TOCTOU the pre-check says eligible');

    db.run(`INSERT INTO invoice_lines (id, product_id, frozen_price) VALUES ('inv-1','p-1', 150)`);

    const co = new MediaDbCoordinator(db as never, new UnusedGateway());
    const before = priceRow(db, 'p-1');
    let thrown: unknown = null;
    try {
      co.applyProductTextEditDurably({
        tenantId: TENANT, branchId: BRANCH, entityId: 'p-1', batchId: 'b-toctou',
        productEdit: mobilePriceEdit([['purchase_price', 110]], [100]),
      });
    } catch (e) { thrown = e; }
    ok((thrown as { message?: string })?.message === 'MOBILE_PRICE_NOT_ELIGIBLE',
      `TOCTOU the write is refused although the pre-check had passed (${(thrown as { message?: string })?.message})`);
    ok(JSON.stringify(priceRow(db, 'p-1')) === JSON.stringify(before), 'TOCTOU nothing was written');
  }

  // ── Der Desktop unterliegt der Regel NICHT ───────────────────────────────
  {
    const db = newDb(SQL);
    addProduct(db, 'p-desk', { receipt: false });
    db.run(`INSERT INTO invoice_lines (id, product_id, frozen_price) VALUES ('inv-1','p-desk', 150)`);
    const co = new MediaDbCoordinator(db as never, new UnusedGateway());
    co.applyProductTextEditDurably({
      tenantId: TENANT, branchId: BRANCH, entityId: 'p-desk', batchId: 'b-desktop',
      // Ohne die Flagge — so ruft der Desktop auf.
      productEdit: { set: [['purchase_price', 110]], baseline: [100], invalidateImageDerived: false, withSync: false, audit: { module: 'Product', changedBy: null, newValueJson: '{}' } },
    });
    ok(Number(priceRow(db, 'p-desk')[0]) === 110,
      'DESKTOP the rule is a mobile-surface rule — the desktop path is unaffected');
  }

  // ── §8 HISTORIE: eine erlaubte Aenderung fasst keine gebuchte Zeile an ───
  {
    const db = newDb(SQL);
    addProduct(db, 'p-free', { receipt: true });
    addProduct(db, 'p-sold', { receipt: true });
    for (const t of TRANSACTION_RELATIONS) db.run(`INSERT INTO ${t} (id, product_id, frozen_price) VALUES ('h-${t}','p-sold', 77)`);
    const historyBefore = TRANSACTION_RELATIONS.map((t) => `${t}:${dumpAll(db, t)}`).join('|');
    const soldBefore = priceRow(db, 'p-sold');

    const co = new MediaDbCoordinator(db as never, new UnusedGateway());
    co.applyProductTextEditDurably({
      tenantId: TENANT, branchId: BRANCH, entityId: 'p-free', batchId: 'b-history',
      productEdit: mobilePriceEdit([['purchase_price', 111], ['planned_sale_price', 166], ['min_sale_price', 151]], [100, 150, 140]),
    });

    ok(Number(priceRow(db, 'p-free')[0]) === 111, 'HISTORY the eligible item really changed');
    const historyAfter = TRANSACTION_RELATIONS.map((t) => `${t}:${dumpAll(db, t)}`).join('|');
    ok(historyAfter === historyBefore, 'HISTORY not one booked row moved — every frozen price is byte-identical');
    ok(JSON.stringify(priceRow(db, 'p-sold')) === JSON.stringify(soldBefore), 'HISTORY …and the other product is untouched');

    // NEGATIVKONTROLLE des Vergleichs: wird eine historische Zeile veraendert, MUSS er anschlagen.
    db.run(`UPDATE invoice_lines SET frozen_price = 78 WHERE id = 'h-invoice_lines'`);
    const tampered = TRANSACTION_RELATIONS.map((t) => `${t}:${dumpAll(db, t)}`).join('|');
    ok(tampered !== historyBefore, 'NEGATIVE CONTROL the history comparison detects a changed booked row');
  }
}

main()
  .catch((e) => { FAIL++; failures.push('harness: ' + ((e as { message?: string })?.message ?? String(e))); console.error(e); })
  .finally(() => {
    console.log(`\nMOBILE-EDIT v0.8.48 price eligibility: ${PASS} passed, ${FAIL} failed`);
    if (FAIL > 0) { for (const f of failures) console.log('   - ' + f); process.exit(1); }
  });
