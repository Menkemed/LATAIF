// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-C3B — die erste produktive Fernmutation, geprüft an der ECHTEN Rechnungslogik.
// Run: node test/bridge/remote-invoice-create.test.ts
//
// Gefahren wird der Produktivcode: `createDirectInvoice` aus dem Store, `postInvoiceIssued` aus der
// Buchungsschicht, `getNextDocumentNumber` aus dem durablen Zähler, `runRemoteCommand` aus der
// C3A-Maschine, die echten Transaktionsklammern aus `posting.ts`. Gestellt sind nur die
// Datenbankquelle (eine echte sql.js-Datenbank mit dem ECHTEN Schema) und das Speichern.
//
// Die Frage, an der C3B hängt: Wenn zwei Rechner gleichzeitig dasselbe letzte Stück verkaufen —
// wer gewinnt, was passiert mit dem anderen, und was passiert, wenn die Antwort verlorengeht?
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
const withTs = (p: string): string => (existsSync(p) ? p : existsSync(p + '.ts') ? p + '.ts' : p);
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    if (specifier === '@/core/db/database') {
      return { url: pathToFileURL(resolvePath(repo, 'test/sync/_db-shim.ts')).href, shortCircuit: true };
    }
    if (specifier.startsWith('@/')) {
      return { url: pathToFileURL(withTs(resolvePath(repo, 'src', specifier.slice(2)))).href, shortCircuit: true };
    }
    if ((specifier === './database' || specifier === '../db/database') && context.parentURL) {
      return { url: pathToFileURL(resolvePath(repo, 'test/sync/_db-shim.ts')).href, shortCircuit: true };
    }
    if (specifier === '../auth/auth' && context.parentURL && context.parentURL.includes('/db/helpers')) {
      return { url: pathToFileURL(resolvePath(repo, 'test/sync/_auth-shim.ts')).href, shortCircuit: true };
    }
    if (specifier.startsWith('.') && context.parentURL) {
      const p = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
      if (!existsSync(p) && existsSync(p + '.ts')) return { url: pathToFileURL(p + '.ts').href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
} as never);

// Der Renderer merkt sich Kleinigkeiten im Browser-Speicher (Sync-Adresse, Sitzung). In Node gibt
// es den nicht — hier steht das kleinste Ersatzstueck, und der Sync ist ABSICHTLICH eingerichtet:
// nur dann schreibt `trackChange` wirklich, und nur dann ist "keine zweite Sync-Wirkung" eine Aussage.
const store = new Map<string, string>([
  ['lataif_sync_url', 'https://primary.local'],
  ['lataif_sync_token', 'tok'],
  ['lataif_session', JSON.stringify({ branchId: 'branch-main', userId: 'user-test' })],
]);
const localStorageShim = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => { store.clear(); },
};
(globalThis as { localStorage?: unknown }).localStorage = localStorageShim;
// `client-mode` fragt `window.localStorage` — derselbe Speicher, anderer Name.
(globalThis as { window?: unknown }).window = { localStorage: localStorageShim };
const initSqlJs = (await import('sql.js')).default;
const SQL = await initSqlJs({ locateFile: (f: string) => resolvePath(repo, 'node_modules/sql.js/dist', f) });

const { setTestDatabase } = await import('../sync/_db-shim.ts');
const { COMMAND_LEDGER_DDL, COMMAND_LEDGER_INDEX, lookupCommand, commandCount } =
  await import('../../src/core/bridge/command-ledger.ts');
const { runRemoteCommand } = await import('../../src/core/bridge/mutation-engine.ts');
const { resetDurabilityStateForTest, setDurableSaver, isDurabilityDegraded } =
  await import('../../src/core/bridge/durability-state.ts');
const { resetTransactionHealthForTest } = await import('../../src/core/db/transaction-health.ts');
const { installWriteGuard } = await import('../../src/core/db/write-guard.ts');
const {
  runInvoiceCreate, parseInvoicePayload, buildInvoiceLines, asDomainVerdict, InvoicePayloadError,
} = await import('../../src/core/bridge/invoice-command.ts');
const { executeCommand } = await import('../../src/core/bridge/command-registry.ts');
const { businessWriteScheduler } = await import('../../src/core/bridge/command-scheduler.ts');
const { toInvoiceLine } = await import('../../src/core/invoices/line-derivation.ts');
const { InvoiceSaveAttempt, InvoiceSaveController } = await import('../../src/core/bridge/client-invoice-save.ts');
const { enterClientMode, setClientToken } = await import('../../src/core/bridge/client-mode.ts');
await import('../../src/core/bridge/return-commands.ts');
await import('../../src/core/bridge/lifecycle-commands.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');

interface Db {
  run(sql: string, p?: unknown[]): unknown;
  exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
  export(): Uint8Array;
}

const NOW = '2026-09-04T10:00:00.000Z';
const ID = (n: string): string => `${n.padStart(8, '0')}-0000-4000-8000-000000000000`;
const identity = (commandId: string, hash = 'h1', user = 'user-test') => ({
  commandId, tenantId: 'tenant-1', branchId: 'branch-main', userId: user, role: 'ADMIN',
  op: 'invoices.create', payloadHash: hash,
});

/** Ein Absender, wie ihn Rust aus den geprueften Anmeldedaten reicht. */
const actor = (commandId: string, hash = 'h1', user = 'user-test') => ({
  commandId, tenantId: 'tenant-1', branchId: 'branch-main', userId: user, role: 'ADMIN', payloadHash: hash,
});

const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];

/** Frische Abhaengigkeiten fuer dieselbe Datenbank — fuer Abschnitte mit mehreren Auftraegen. */
const d0 = (db: Db) => deps(db).deps;

/**
 * Eine echte Datenbank mit dem ECHTEN Schema des Hauses — kein nachgebautes Modell: `schema.sql`,
 * danach die ECHTEN Migrationen, wortgleich aus `database.ts` gelesen (dort stehen `stock_lots`,
 * `ledger_entries`, `products.quantity` und `invoice_lines.lot_id`). Ein nachgebautes Schema wäre
 * die zweite Wahrheit, gegen die dieser ganze Test argumentiert.
 */
function realMigrations(): string[] {
  const dbSrc = src('src/core/db/database.ts');
  const start = dbSrc.indexOf('const migrations: string[] = [');
  const end = dbSrc.indexOf('\n  ];', start);
  if (start < 0 || end < 0) throw new Error("could not read the real migrations");
  const block = dbSrc.slice(start, end);
  return [...block.matchAll(/`([^`]*)`/g)].map((m) => m[1]);
}
const MIGRATIONS = realMigrations();

function freshDb(): Db {
  const db = new SQL.Database() as unknown as Db;
  db.run(src('src/core/db/schema.sql'));
  for (const stmt of MIGRATIONS) { try { db.run(stmt); } catch { /* duplicate column / schon da */ } }
  for (const stmt of A1_UPGRADE_SQL) { try { db.run(stmt); } catch { /* schon vorhanden */ } }
  db.run(COMMAND_LEDGER_DDL);
  db.run(COMMAND_LEDGER_INDEX);
  setTestDatabase(db as never);
  return db;
}

/** Ein Kunde, ein Produkt, ein Los mit GENAU EINEM Stück. */
function seed(db: Db, opts: { qty?: number; scheme?: string } = {}): { customerId: string; productId: string; lotId: string } {
  const qty = opts.qty ?? 1;
  db.run(`INSERT INTO branches (id, tenant_id, name, created_at, updated_at)
          VALUES ('branch-main','tenant-1','Hauptfiliale',?,?)`, [NOW, NOW]);
  db.run(`INSERT INTO categories (id, branch_id, name, created_at, updated_at)
          VALUES ('cat-1','branch-main','Uhren',?,?)`, [NOW, NOW]);
  db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, created_at, updated_at)
          VALUES ('cust-1','branch-main','Kunde','Eins',?,?)`, [NOW, NOW]);
  db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, purchase_price,
            planned_sale_price, tax_scheme, stock_status, created_at, updated_at)
          VALUES ('prod-1','branch-main','cat-1','Rolex','Ring','SKU-1', 100, 150, ?, 'in_stock', ?, ?)`,
    [opts.scheme ?? 'VAT_10', NOW, NOW]);
  try { db.run(`UPDATE products SET quantity = ? WHERE id = 'prod-1'`, [qty]); } catch { /* Spalte kommt aus einer Migration */ }
  db.run(`INSERT INTO stock_lots (id, branch_id, product_id, qty_total, qty_remaining, unit_cost, status, acquired_at, created_at)
          VALUES ('lot-1','branch-main','prod-1', ?, ?, 100, 'ACTIVE', ?, ?)`, [qty, qty, NOW, NOW]);
  return { customerId: 'cust-1', productId: 'prod-1', lotId: 'lot-1' };
}

/** Die echten Transaktionsklammern kommen aus `posting.ts`; nur das Speichern ist gestellt. */
function deps(db: Db, opts: { failSave?: boolean } = {}) {
  const posting = postingMod;
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
const postingMod = await import('../../src/core/ledger/posting.ts');

const payloadFor = (customerId: string, lotId: string | null, unitPrice = 150) => ({
  customerId,
  lines: [{ productId: 'prod-1', lotId, quantity: 1, unitPrice, scheme: 'auto' as const }],
});

// ── 1) Die Zulassungsliste: genau EINE Mutation ───────────────────────────
{
  const registry = await import('../../src/core/bridge/command-registry.ts');
  await import('../../src/core/bridge/read-commands.ts');
  await import('../../src/core/bridge/invoice-command.ts');

  ok(!('REMOTE_MUTATIONS_ENABLED' in registry),
    'ALLOWLIST der globale Schalter ist weg — er haette in einem Zug JEDE Mutation freigegeben');
  await import('../../src/core/bridge/customer-commands.ts');
  await import('../../src/core/bridge/product-commands.ts');
  await import('../../src/core/bridge/invoice-lifecycle-commands.ts');
  await import('../../src/core/bridge/commercial-commands.ts');
  await import('../../src/core/bridge/service-commands.ts');
  await import('../../src/core/bridge/financial-commands.ts');
  ok(Array.isArray(registry.ALLOWED_MUTATIONS)
    && registry.ALLOWED_MUTATIONS.join(',') === 'invoices.create,customers.create,customers.update,products.create,products.update,invoices.update,invoices.record_payment,purchases.create,consignments.create,consignments.update,orders.create,orders.update,repairs.create,repairs.update,transfers.create,transfers.update,transfers.mark_returned,invoices.apply_credit,invoices.update_payment,invoices.delete_payment,orders.convert_to_invoice,consignments.record_payout,transfers.mark_sold,transfers.mark_settled,returns.create,returns.approve,returns.refund,returns.record_refund_payment,orders.update_status,orders.add_payment,orders.delete_payment,consignments.record_sale,consignments.mark_returned,repairs.update_status,repairs.create_invoice,repairs.add_line,repairs.update_line,repairs.cancel_line,transfers.convert_to_invoice,transfers.convert_many_to_invoice',
    `ALLOWLIST genau diese Namen stehen darauf (${JSON.stringify(registry.ALLOWED_MUTATIONS)})`);

  for (const op of ['products.delete', 'invoice.delete', 'purchase.create', 'anything.write']) {
    let threw: string | null = null;
    try { registry.registerCommand(op, { kind: 'mutation', handler: () => ({ ok: true }) }); }
    catch (e) { threw = String(e); }
    ok(threw !== null && /refusing to register/.test(threw), `ALLOWLIST ${op} wird abgewiesen`);
  }

  const known = registry.knownCommands();
  const reads = known.filter((o) => o.endsWith('.list') || o.endsWith('.get'));
  ok(known.length === 59, `ALLOWLIST produktiv neunundfuenfzig Namen (${known.length}: ${known.join(', ')})`);
  ok(reads.length === 18 && known.includes('bridge.probe') && known.includes('invoices.create'),
    'ALLOWLIST eine Probe, achtzehn Lesevorgaenge, vierzig Mutationen');

  // Und Rust prueft dieselbe Liste ein zweites Mal.
  const rs = src('src-tauri/src/bridge.rs');
  ok(/pub const OP_INVOICES_CREATE: &str = "invoices.create";/.test(rs), 'ALLOWLIST Rust kennt den Namen…');
  const list = rs.slice(rs.indexOf('pub const REMOTE_OPS'), rs.indexOf('];', rs.indexOf('pub const REMOTE_OPS')));
  ok((list.match(/OP_[A-Z_]+/g) || []).length === 59, 'ALLOWLIST …und seine Liste ist genau neunundfuenfzig Namen lang');

  // Der Umschlag wird in `lib.rs` VON HAND zusammengesetzt. Ein neues Feld an der Struktur
  // erreicht den Renderer deshalb nicht von selbst — genau daran scheiterte der erste Lauf:
  // die Identitaet fehlte, und jede Buchung wurde fail-closed abgewiesen.
  const libRs = src('src-tauri/src/lib.rs');
  const sink = libRs.slice(libRs.indexOf('fn deliver('), libRs.indexOf('fn deliver(') + 1200);
  ok(/"identity": envelope.identity/.test(sink),
    'ALLOWLIST und der Umschlag traegt die Identitaet wirklich nach draussen');
  for (const f of ['"opId": envelope.op_id', '"op": envelope.op', '"generation": envelope.generation', '"payload": envelope.payload']) {
    ok(sink.includes(f), `ALLOWLIST …zusammen mit allem anderen (${f})`);
  }

  // Und der Befehl packt den Rumpf aus derselben Huelle aus wie die Lesebefehle.
  const cmdSrc = src('src/core/bridge/invoice-command.ts');
  ok(cmdSrc.includes('const body = (payload as { input?: unknown } | null)?.input ?? payload;'),
    'ALLOWLIST der Rumpf des Clients steckt in `input`, der Absender daneben');
}

// ── 2) Dieselbe Rechnungslogik wie das Formular ───────────────────────────
{
  const cmd = src('src/core/bridge/invoice-command.ts');
  ok(/createDirectInvoice\(/.test(cmd), 'REUSE der Befehl ruft die ECHTE Store-Funktion…');
  ok(!/INSERT INTO invoices/i.test(cmd) && !/INSERT INTO invoice_lines/i.test(cmd),
    'REUSE …und schreibt keine einzige Rechnungszeile selbst');
  ok(!/getNextDocumentNumber|document_sequences/.test(cmd),
    'REUSE die Nummer vergibt weiterhin nur der Store');

  const ui = src('src/pages/invoices/InvoiceCreate.tsx');
  ok(/toInvoiceLine\(/.test(ui) && /calcInvoiceLine/.test(ui),
    'REUSE das Formular benutzt dieselbe Ableitung wie der Fernauftrag');
  ok(!/vatEngine\.calculateNet/.test(ui), 'REUSE …und rechnet nicht mehr selbst');
  const rustSrc = src('src-tauri/src/bridge.rs');
  ok(!/invoice_lines|INSERT INTO invoices/i.test(rustSrc), 'REUSE und in Rust liegt keine Rechnungslogik');

  // Die Ableitung ist wirklich dieselbe Rechnung wie vorher (v0.7.1-Regeln unveraendert).
  const std = toInvoiceLine({ productId: 'p', quantity: 2, unitPrice: 100, costBasis: 60, scheme: 'VAT_10' });
  ok(std.vatRate === 10 && Math.abs(std.lineTotal - 220) < 0.005 && Math.abs(std.vatAmount - 20) < 0.005,
    `REUSE VAT_10: 2 x 100 netto ergibt 220 brutto (${JSON.stringify(std)})`);
  const zero = toInvoiceLine({ productId: 'p', quantity: 1, unitPrice: 100, costBasis: 60, scheme: 'ZERO' });
  ok(zero.vatRate === 0 && Math.abs(zero.lineTotal - 100) < 0.005, 'REUSE ZERO bleibt ohne Steuer');
  const margin = toInvoiceLine({ productId: 'p', quantity: 1, unitPrice: 150, costBasis: 100, scheme: 'MARGIN' });
  ok(Math.abs(margin.lineTotal - 150) < 0.005 && margin.vatAmount > 0 && margin.vatAmount < 50,
    `REUSE MARGIN: der Kunde zahlt netto, die Steuer steckt in der Marge (${JSON.stringify(margin)})`);
}

// ── 3) Der Rumpf des Clients ist ein Wunsch, keine Anweisung ──────────────
{
  const db = freshDb();
  seed(db);

  for (const [field, raw] of [
    ['invoiceNumber', { customerId: 'cust-1', lines: [], invoiceNumber: 'INV-2026-000001' }],
    ['branchId', { customerId: 'cust-1', branchId: 'branch-fremd', lines: [] }],
    ['userId', { customerId: 'cust-1', userId: 'user-boss', lines: [] }],
    ['status', { customerId: 'cust-1', status: 'FINAL', lines: [] }],
    ['paidAmount', { customerId: 'cust-1', paidAmount: 999, lines: [] }],
    ['grossAmount', { customerId: 'cust-1', grossAmount: 1, lines: [] }],
    ['numbering', { customerId: 'cust-1', numbering: 'repair', lines: [] }],
    ['allowWithAgent', { customerId: 'cust-1', allowWithAgent: true, lines: [] }],
    ['issuedAt', { customerId: 'cust-1', issuedAt: '2020-01-01T00:00:00.000Z', lines: [] }],
  ] as const) {
    let threw: string | null = null;
    try { parseInvoicePayload(raw); } catch (e) { threw = String(e); }
    ok(threw !== null && new RegExp(field).test(threw), `AUTHORITY ${field} entscheidet der Primary (${threw})`);
  }

  for (const [what, raw] of [
    ['zeilenweise Steuerbetraege', { customerId: 'cust-1', lines: [{ productId: 'prod-1', unitPrice: 1, vatAmount: 0 }] }],
    ['zeilenweise Summen', { customerId: 'cust-1', lines: [{ productId: 'prod-1', unitPrice: 1, lineTotal: 1 }] }],
    ['zeilenweise Einstandskosten', { customerId: 'cust-1', lines: [{ productId: 'prod-1', unitPrice: 1, purchasePrice: 0 }] }],
    ['unbekannte Felder', { customerId: 'cust-1', lines: [{ productId: 'prod-1', unitPrice: 1, discountAll: true }] }],
  ] as const) {
    let threw: string | null = null;
    try { parseInvoicePayload(raw); } catch (e) { threw = String(e); }
    ok(threw !== null, `AUTHORITY ${what} kommen nicht vom Client (${threw})`);
  }

  // Was erlaubt ist, wird sauber uebernommen.
  const wish = parseInvoicePayload({
    customerId: 'cust-1', notes: 'bar', issuedDate: '2026-09-01', specialMark: true,
    lines: [{ productId: 'prod-1', lotId: 'lot-1', quantity: 2, unitPrice: 150, scheme: 'auto' }],
  });
  ok(wish.customerId === 'cust-1' && wish.lines[0].quantity === 2 && wish.specialMark === true,
    'AUTHORITY der erlaubte Wunsch kommt unveraendert durch');

  // Und die abgeleiteten Werte entstehen HIER, aus den Daten des Hauses.
  const built = buildInvoiceLines([{ productId: 'prod-1', lotId: 'lot-1', quantity: 1, unitPrice: 150, scheme: 'auto' }]);
  ok(built[0].purchasePrice === 100, `AUTHORITY die Einstandskosten kommen aus dem Los (${built[0].purchasePrice})`);
  ok(built[0].taxScheme === 'VAT_10' && built[0].vatRate === 10,
    `AUTHORITY das Steuerschema kommt vom Produkt (${built[0].taxScheme})`);
  ok(Math.abs(built[0].lineTotal - 165) < 0.005, `AUTHORITY die Zeilensumme rechnet der Primary (${built[0].lineTotal})`);

  let foreignLot: string | null = null;
  try { buildInvoiceLines([{ productId: 'prod-1', lotId: 'lot-fremd', quantity: 1, unitPrice: 150 }]); }
  catch (e) { foreignLot = String(e); }
  ok(foreignLot !== null && /lot/.test(foreignLot), 'AUTHORITY ein fremdes Los wird abgewiesen');
}

// ── 4) Der echte Weg: eine Rechnung entsteht, mit allem, was dazugehoert ──
{
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  const db = freshDb();
  installWriteGuard(db as never);
  const s = seed(db, { qty: 2 });
  const { deps: d, state } = deps(db);

  const out = await runInvoiceCreate(d, identity(ID('1')), payloadFor(s.customerId, s.lotId));
  ok(out.kind === 'ok', `ENGINE die Rechnung entsteht (${JSON.stringify(out)})`);
  const value = (out as { value: { invoiceId: string; invoiceNumber: string; grossAmount: number } }).value;
  ok(/^PINV-\d{4}-\d{6}$/.test(value.invoiceNumber), `ENGINE mit einer Nummer aus dem Zaehler (${value.invoiceNumber})`);
  ok(Math.abs(value.grossAmount - 165) < 0.005, `ENGINE und dem Betrag des Hauses (${value.grossAmount})`);

  ok(Number(one(db, 'SELECT COUNT(*) FROM invoices')) === 1, 'ENGINE genau eine Rechnung');
  ok(Number(one(db, 'SELECT COUNT(*) FROM invoice_lines')) === 1, 'ENGINE mit ihrer Zeile');
  ok(Number(one(db, "SELECT qty_remaining FROM stock_lots WHERE id='lot-1'")) === 1,
    'ENGINE der Bestand ist abgezogen');
  ok(Number(one(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module='INVOICE'")) > 0,
    'ENGINE und gebucht ist sie auch');
  ok(commandCount(db as never) === 1, 'ENGINE der durable Nachweis steht');
  ok(state.saves === 1 && state.disk !== null, 'ENGINE …und der Stand ist geschrieben');

  // Alles im selben Abbild: Rechnung, Zeile, Bestand, Buchung, Nachweis.
  // Bewusst abgesichert: fehlt das Abbild, ist die Aussage oben schon rot — der Rest soll dann
  // trotzdem noch laufen und nicht mit einem Absturz alles Weitere verschlucken.
  const image = (state.disk ? new SQL.Database(state.disk) : new SQL.Database()) as unknown as Db;
  ok(state.disk !== null && Number(one(image, 'SELECT COUNT(*) FROM invoices')) === 1
    && Number(one(image, 'SELECT COUNT(*) FROM remote_command_ledger')) === 1
    && Number(one(image, "SELECT qty_remaining FROM stock_lots WHERE id='lot-1'")) === 1
    && Number(one(image, "SELECT COUNT(*) FROM ledger_entries WHERE source_module='INVOICE'")) > 0,
    'ENGINE das Abbild auf der Platte traegt alles gemeinsam');
}

// ── 5) Zwei Rechnungen gleichzeitig: zwei verschiedene Nummern ────────────
{
  resetDurabilityStateForTest();
  const db = freshDb();
  installWriteGuard(db as never);
  seed(db, { qty: 5 });
  db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, created_at, updated_at)
          VALUES ('cust-2','branch-main','Kunde','Zwei',?,?)`, [NOW, NOW]);
  const { deps: d } = deps(db);

  // Der ECHTE Weg: `executeCommand` → Zulassungsliste → die eine Schreibreihenfolge → Maschine.
  const [a, b] = await Promise.all([
    executeCommand('invoices.create', payloadFor('cust-1', 'lot-1'), actor(ID('2'), 'hA')),
    executeCommand('invoices.create', payloadFor('cust-2', 'lot-1'), actor(ID('3'), 'hB')),
  ]);
  const numbers = [a, b].map((o) => (o as { value?: { invoiceNumber: string } }).value?.invoiceNumber);
  ok(a.kind === 'ok' && b.kind === 'ok', `SEQ beide Geschaeftsvorgaenge gehen durch (${JSON.stringify([a, b])})`);
  ok(numbers[0] !== numbers[1], `SEQ zwei verschiedene Rechnungsnummern (${numbers.join(' / ')})`);
  ok(Number(one(db, 'SELECT COUNT(DISTINCT invoice_number) FROM invoices')) === 2,
    'SEQ und in der Datenbank stehen sie beide');
  ok(Number(one(db, "SELECT qty_remaining FROM stock_lots WHERE id='lot-1'")) === 3,
    'SEQ der Bestand ist zweimal abgezogen — nicht einmal, nicht dreimal');
}

// ── 6) Menge 1, zwei Clients: einer verkauft, einer bekommt ein Nein ──────
{
  resetDurabilityStateForTest();
  const db = freshDb();
  installWriteGuard(db as never);
  const s = seed(db, { qty: 1 });
  db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, created_at, updated_at)
          VALUES ('cust-2','branch-main','Kunde','Zwei',?,?)`, [NOW, NOW]);
  const { deps: d } = deps(db);

  // Zwei angemeldete Sitzungen, fast gleichzeitig, auf dem ECHTEN Weg durch die Brücke.
  const before = businessWriteScheduler.peakConcurrency();
  const results = await Promise.all([
    executeCommand('invoices.create', payloadFor('cust-1', s.lotId), actor(ID('4'), 'hA', 'user-a')),
    executeCommand('invoices.create', payloadFor('cust-2', s.lotId), actor(ID('5'), 'hB', 'user-b')),
  ]);
  const winners = results.filter((r) => r.kind === 'ok');
  const losers = results.filter((r) => r.kind === 'business_error');
  ok(winners.length === 1, `LASTUNIT genau eine Rechnung ist erfolgreich (${JSON.stringify(results)})`);
  ok(losers.length === 1 && (losers[0] as { code: string }).code === 'STOCK_UNAVAILABLE',
    `LASTUNIT und genau eine fachliche Ablehnung (${JSON.stringify(losers[0])})`);
  ok(lookupCommand(db as never, identity(ID('4'), 'hA', 'user-a')).kind === 'replay'
    && lookupCommand(db as never, identity(ID('5'), 'hB', 'user-b')).kind === 'replay',
    'LASTUNIT beide Ausgaenge sind durabel festgehalten — der Erfolg wie das Nein');
  ok(businessWriteScheduler.peakConcurrency() === Math.max(1, before),
    `LASTUNIT und beide liefen durch DIESELBE Schreibreihenfolge, nie nebeneinander (${businessWriteScheduler.peakConcurrency()})`);

  // Ohne angemeldete Kennung gibt es keine Buchung — auch nicht mit gueltigem Rumpf.
  const anon = await executeCommand('invoices.create', payloadFor('cust-1', s.lotId));
  ok(anon.kind === 'infrastructure_error' && anon.code === 'BRIDGE_IDENTITY_MISSING',
    `LASTUNIT eine Mutation ohne Absender wird abgewiesen (${JSON.stringify(anon)})`);

  ok(Number(one(db, "SELECT qty_remaining FROM stock_lots WHERE id='lot-1'")) === 0,
    'LASTUNIT der Bestand ist exakt 0…');
  ok(Number(one(db, "SELECT COUNT(*) FROM stock_lots WHERE qty_remaining < 0")) === 0,
    'LASTUNIT …und nirgends negativ');
  ok(Number(one(db, 'SELECT COUNT(*) FROM invoices')) === 1, 'LASTUNIT eine einzige Rechnung');
  ok(Number(one(db, 'SELECT COUNT(*) FROM invoice_lines')) === 1, 'LASTUNIT eine einzige Zeile');
  ok(Number(one(db, "SELECT COUNT(DISTINCT source_id) FROM ledger_entries WHERE source_module='INVOICE'")) === 1,
    'LASTUNIT und genau eine gebuchte Wirkung');

  // Die Wiederholung der abgelehnten Kennung bleibt abgelehnt — ohne die Domaene zu fragen.
  const lost = results[0].kind === 'business_error';
  const loserId = lost ? ID('4') : ID('5');
  const loserHash = lost ? 'hA' : 'hB';
  const loserUser = lost ? 'user-a' : 'user-b';
  const loserCustomer = lost ? 'cust-1' : 'cust-2';
  db.run(`UPDATE stock_lots SET qty_remaining = 5, status='ACTIVE' WHERE id='lot-1'`); // die Ware kommt zurueck
  const again = await runInvoiceCreate(d, identity(loserId, loserHash, loserUser), payloadFor(loserCustomer, s.lotId));
  ok(again.kind === 'rejected' && (again as { code: string }).code === 'STOCK_UNAVAILABLE'
    && (again as { replayed: boolean }).replayed === true,
    `LASTUNIT die Wiederholung bekommt dasselbe Nein (${JSON.stringify(again)})`);
  ok(Number(one(db, 'SELECT COUNT(*) FROM invoices')) === 1,
    'LASTUNIT …und schreibt keine zweite Rechnung, obwohl die Ware wieder da ist');
}

// ── 6b) Ohne Los im Rumpf: ein leergekauftes Produkt wird NICHT verkauft ──
//
// Die Luecke, die erst die Ende-zu-Ende-Pruefung zeigte: `createDirectInvoice` sucht sich ohne
// `lotId` selbst ein Los, und wenn keines mehr offen ist, bucht es die Zeile OHNE Los weiter —
// die Bestandspruefung ueberspringt eine loslose Zeile, weil es loslose Ware wirklich gibt
// (Reparaturleistung, Kommission vor dem Auto-Einkauf). Am Formular faellt das nie auf: es gibt
// immer ein Los mit. Ueber die Ferne hiesse es: das letzte Stueck wird zweimal verkauft, beim
// zweiten Mal ohne Bestandsabzug.
{
  resetDurabilityStateForTest();
  const db = freshDb();
  installWriteGuard(db as never);
  const s = seed(db, { qty: 1 });
  const { deps: d } = deps(db);

  // Der Client nennt KEIN Los — genau das, was das Formular des Clients schickt.
  const sold = await runInvoiceCreate(d, identity(ID('30')), {
    customerId: s.customerId,
    lines: [{ productId: s.productId, quantity: 1, unitPrice: 150, scheme: 'auto' }],
  });
  ok(sold.kind === 'ok', `EMPTY das eine Stueck wird verkauft (${JSON.stringify(sold)})`);
  ok(Number(one(db, "SELECT qty_remaining FROM stock_lots WHERE id='lot-1'")) === 0,
    'EMPTY …und der Bestand ist abgezogen — das Los wurde aufgeloest, nicht offen gelassen');
  ok(String(one(db, "SELECT lot_id FROM invoice_lines LIMIT 1")) === s.lotId,
    'EMPTY die Zeile haengt an ihrem Los');

  // Und jetzt derselbe Wunsch noch einmal, mit einer NEUEN Kennung: die Ware ist weg.
  const second = await runInvoiceCreate(d, identity(ID('31'), 'h2'), {
    customerId: s.customerId,
    lines: [{ productId: s.productId, quantity: 1, unitPrice: 150, scheme: 'auto' }],
  });
  ok(second.kind === 'rejected' && (second as { code: string }).code === 'STOCK_UNAVAILABLE',
    `EMPTY der zweite Verkauf bekommt ein fachliches Nein (${JSON.stringify(second)})`);
  ok((second as { frozen: boolean }).frozen === true, 'EMPTY …und es ist eingefroren');
  ok(Number(one(db, 'SELECT COUNT(*) FROM invoices')) === 1, 'EMPTY es bleibt bei einer Rechnung');
  ok(Number(one(db, "SELECT qty_remaining FROM stock_lots WHERE id='lot-1'")) === 0,
    'EMPTY der Bestand ist 0 und nicht negativ');

  // Ein ausdruecklich genanntes, leeres Los ebenfalls.
  const named = await runInvoiceCreate(d, identity(ID('32'), 'h3'), {
    customerId: s.customerId,
    lines: [{ productId: s.productId, lotId: s.lotId, quantity: 1, unitPrice: 150, scheme: 'auto' }],
  });
  ok(named.kind === 'rejected' && (named as { code: string }).code === 'STOCK_UNAVAILABLE',
    `EMPTY auch ein genanntes leeres Los wird abgewiesen (${JSON.stringify(named)})`);

  // Ware ohne Lose bleibt, wie sie war: Reparaturleistungen haben keine und muessen weiter gehen.
  db.run("INSERT INTO products (id, branch_id, category_id, brand, name, sku, purchase_price, tax_scheme, stock_status, created_at, updated_at)"
    + " VALUES ('srv-1','branch-main','cat-repair-service','Service','Politur','SRV-1', 0, 'VAT_10', 'in_stock', ?, ?)", [NOW, NOW]);
  const service = await runInvoiceCreate(d, identity(ID('33'), 'h4'), {
    customerId: s.customerId,
    lines: [{ productId: 'srv-1', quantity: 1, unitPrice: 20, scheme: 'auto' }],
  });
  ok(service.kind === 'ok', `EMPTY loslose Ware wird weiterhin verkauft (${JSON.stringify(service)})`);
}

// ── 6c) Dieselbe Zuteilungsregel wie das Formular ─────────────────────────
//
// Die Gefahr bei einer zweiten Schreibstelle ist nicht, dass sie falsch rechnet — sondern dass sie
// ANDERS waehlt. Zwei Zuteilungsregeln fuer dasselbe Los heissen: derselbe Verkauf zieht je nach
// Weg von einem anderen Einkauf ab, und die Marge stimmt nie wieder. Deshalb kommt die Liste der
// konsumierbaren Lose aus DEM Helfer des Hauses, aus dem auch das Formular seine Auswahl baut.
{
  resetDurabilityStateForTest();
  const db = freshDb();
  installWriteGuard(db as never);
  const s = seed(db, { qty: 1 });
  const lots = await import('../../src/core/lots/lot-queries.ts');

  // Zwei weitere Lose desselben Produkts: eines aelter, eines juenger, beide offen.
  db.run("INSERT INTO stock_lots (id, branch_id, product_id, qty_total, qty_remaining, unit_cost, status, acquired_at, created_at)"
    + " VALUES ('lot-old','branch-main','prod-1', 2, 2, 80, 'ACTIVE', '2026-01-01T00:00:00.000Z', ?)", [NOW]);
  db.run("INSERT INTO stock_lots (id, branch_id, product_id, qty_total, qty_remaining, unit_cost, status, acquired_at, created_at)"
    + " VALUES ('lot-new','branch-main','prod-1', 5, 5, 120, 'ACTIVE', '2027-01-01T00:00:00.000Z', ?)", [NOW]);

  // Die kanonische Reihenfolge des Hauses: nicht storniert, Restmenge > 0, aeltestes zuerst.
  const house = lots.getLotsWithPurchaseNumbers(s.productId);
  ok(house.map((x: { id: string }) => x.id).join(',') === 'lot-old,lot-1,lot-new',
    `EQUIV der Helfer des Hauses ordnet FIFO (${house.map((x: { id: string }) => x.id).join(',')})`);

  // Und der Fernauftrag waehlt GENAU dasselbe, ohne eigene Abfrage.
  const built = buildInvoiceLines([{ productId: s.productId, quantity: 1, unitPrice: 150 }]);
  ok(built[0].lotId === 'lot-old', `EQUIV der Fernauftrag nimmt dasselbe erste Los (${built[0].lotId})`);
  ok(built[0].purchasePrice === 80, `EQUIV …samt seiner Einstandskosten (${built[0].purchasePrice})`);
  const cmdSrc = src('src/core/bridge/invoice-command.ts');
  ok(/getLotsWithPurchaseNumbers\(l\.productId\)/.test(cmdSrc),
    'EQUIV weil er den Helfer benutzt und keine eigene Reihenfolge erfindet');
  ok(!/ORDER BY acquired_at/.test(cmdSrc), 'EQUIV …im Befehl steht keine zweite FIFO-Abfrage');

  // Eine Menge ueberspannt KEINE Lose — das ist das bestehende Modell (`consumeLot` nimmt EIN
  // Los, `assertLotsConsumable` weist eine zu grosse Menge vorher ab). Der Fernauftrag erbt das.
  const tooMany = await runInvoiceCreate(d0(db), identity(ID('40')), {
    customerId: s.customerId,
    lines: [{ productId: s.productId, lotId: 'lot-old', quantity: 3, unitPrice: 150, scheme: 'auto' }],
  });
  ok(tooMany.kind === 'rejected' && (tooMany as { code: string }).code === 'STOCK_UNAVAILABLE',
    `EQUIV eine Menge ueber die Losgrenze wird abgewiesen, nicht aufgeteilt (${JSON.stringify(tooMany)})`);
  ok(Number(one(db, "SELECT qty_remaining FROM stock_lots WHERE id='lot-old'")) === 2,
    'EQUIV …und das Los bleibt unberuehrt');

  // Genau die Menge des Loses geht.
  const exact = await runInvoiceCreate(d0(db), identity(ID('41'), 'h41'), {
    customerId: s.customerId,
    lines: [{ productId: s.productId, lotId: 'lot-old', quantity: 2, unitPrice: 150, scheme: 'auto' }],
  });
  ok(exact.kind === 'ok', `EQUIV die volle Losmenge geht (${JSON.stringify(exact)})`);
  ok(Number(one(db, "SELECT qty_remaining FROM stock_lots WHERE id='lot-old'")) === 0,
    'EQUIV das Los ist leer');

  // Danach waehlt der naechste Auftrag das naechste offene Los — wieder wie das Formular.
  const next = buildInvoiceLines([{ productId: s.productId, quantity: 1, unitPrice: 150 }]);
  ok(next[0].lotId === 'lot-1' && next[0].purchasePrice === 100,
    `EQUIV das naechste offene Los rueckt nach (${next[0].lotId}/${next[0].purchasePrice})`);
}

// ── 7) Verlorene Antwort: dieselbe Kennung, keine zweite Wirkung ──────────
{
  resetDurabilityStateForTest();
  const db = freshDb();
  installWriteGuard(db as never);
  const s = seed(db, { qty: 5 });
  const { deps: d } = deps(db);

  const first = await runInvoiceCreate(d, identity(ID('6')), payloadFor(s.customerId, s.lotId));
  const v1 = (first as { value: { invoiceId: string; invoiceNumber: string } }).value;
  const lotAfter = Number(one(db, "SELECT qty_remaining FROM stock_lots WHERE id='lot-1'"));
  const ledgerAfter = Number(one(db, 'SELECT COUNT(*) FROM ledger_entries'));
  const changelogAfter = Number(one(db, 'SELECT COUNT(*) FROM sync_changelog'));

  // Die Antwort geht verloren — der Client fragt mit DERSELBEN Kennung erneut.
  const second = await runInvoiceCreate(d, identity(ID('6')), payloadFor(s.customerId, s.lotId));
  const v2 = (second as { value: { invoiceId: string; invoiceNumber: string } }).value;
  ok(second.kind === 'ok' && (second as { replayed: boolean }).replayed === true, 'RETRY sie ist als Wiederholung erkannt');
  ok(v2.invoiceId === v1.invoiceId, `RETRY dieselbe Rechnung (${v2.invoiceId})`);
  ok(v2.invoiceNumber === v1.invoiceNumber, `RETRY dieselbe Nummer (${v2.invoiceNumber})`);
  ok(Number(one(db, 'SELECT COUNT(*) FROM invoices')) === 1, 'RETRY es bleibt bei einer Rechnung');
  ok(Number(one(db, "SELECT qty_remaining FROM stock_lots WHERE id='lot-1'")) === lotAfter,
    'RETRY kein zweiter Bestandsabzug');
  ok(Number(one(db, 'SELECT COUNT(*) FROM ledger_entries')) === ledgerAfter, 'RETRY keine zweite Buchung');
  ok(Number(one(db, 'SELECT COUNT(*) FROM sync_changelog')) === changelogAfter, 'RETRY keine zweite Sync-Wirkung');
  ok(Number(one(db, 'SELECT COUNT(*) FROM payments')) === 0, 'RETRY und keine Zahlung — die gehoert nicht dazu');
  ok(Number(one(db, "SELECT next_number FROM document_sequences WHERE doc_type='PINV'")) === 2,
    'RETRY die Nummer wurde nur einmal verbraucht');

  // Dieselbe Kennung mit anderem Rumpf ist ein Widerspruch — und laeuft nicht.
  const conflict = await runInvoiceCreate(d, identity(ID('6'), 'ANDERS'), payloadFor(s.customerId, s.lotId, 999));
  ok(conflict.kind === 'rejected' && (conflict as { code: string }).code === 'COMMAND_ID_CONFLICT'
    && (conflict as { frozen: boolean }).frozen === false,
    `RETRY gleiche Kennung, anderer Rumpf: abgewiesen, nichts eingefroren (${JSON.stringify(conflict)})`);
  ok(Number(one(db, 'SELECT COUNT(*) FROM invoices')) === 1, 'RETRY …und keine zweite Rechnung');
}

// ── 8) Neustart: der Nachweis liegt auf der Platte, nicht im Speicher ─────
{
  resetDurabilityStateForTest();
  const db = freshDb();
  installWriteGuard(db as never);
  const s = seed(db, { qty: 5 });
  const { deps: d, state } = deps(db);

  const first = await runInvoiceCreate(d, identity(ID('7')), payloadFor(s.customerId, s.lotId));
  const v1 = (first as { value: { invoiceId: string; invoiceNumber: string } }).value;

  // Der Prozess startet neu: neue Datenbank aus der letzten durablen Datei, alles im Speicher weg.
  const restarted = new SQL.Database(state.disk as Uint8Array) as unknown as Db;
  setTestDatabase(restarted as never);
  installWriteGuard(restarted as never);
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  const { deps: d2 } = deps(restarted);

  ok(lookupCommand(restarted as never, identity(ID('7'))).kind === 'replay',
    'RESTART der Nachweis hat den Neustart ueberlebt');
  const after = await runInvoiceCreate(d2, identity(ID('7')), payloadFor(s.customerId, s.lotId));
  const v2 = (after as { value: { invoiceId: string; invoiceNumber: string } }).value;
  ok(after.kind === 'ok' && (after as { replayed: boolean }).replayed === true
    && v2.invoiceId === v1.invoiceId && v2.invoiceNumber === v1.invoiceNumber,
    `RESTART die Wiederholung findet ihr Ergebnis wieder (${JSON.stringify(v2)})`);
  ok(Number(one(restarted, 'SELECT COUNT(*) FROM invoices')) === 1, 'RESTART und es bleibt bei einer Rechnung');
}

// ── 9) Speichern scheitert: kein Erfolg, keine zweite Rechnung ────────────
{
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  const db = freshDb();
  installWriteGuard(db as never);
  const s = seed(db, { qty: 5 });
  const { deps: d, state } = deps(db, { failSave: true });

  let threw: string | null = null;
  try { await runInvoiceCreate(d, identity(ID('8')), payloadFor(s.customerId, s.lotId)); }
  catch (e) { threw = String(e); }
  ok(threw !== null && /disk full/.test(threw), `PERSIST kein definitiver Erfolg (${threw})`);
  ok(isDurabilityDegraded(), 'PERSIST der Prozess merkt sich die Speicherschuld');
  ok(Number(one(db, 'SELECT COUNT(*) FROM invoices')) === 1,
    'PERSIST die Rechnung steht im Speicher — sie war committet');

  // Keine neue Businessmutation, solange die Schuld offen ist: auch nicht lokal.
  let localBlocked: string | null = null;
  try { db.run("INSERT INTO customers (id, branch_id, first_name, last_name, created_at, updated_at) VALUES ('c9','branch-main','X','Y',?,?)", [NOW, NOW]); }
  catch (e) { localBlocked = String(e); }
  ok(localBlocked !== null, 'PERSIST und kein weiterer Geschaeftsschreibvorgang');

  // Die Wiederholung fuehrt die Rechnung NICHT erneut aus…
  let retryErr: string | null = null;
  try { await runInvoiceCreate(d, identity(ID('8')), payloadFor(s.customerId, s.lotId)); }
  catch (e) { retryErr = String(e); }
  ok(retryErr !== null && Number(one(db, 'SELECT COUNT(*) FROM invoices')) === 1,
    'PERSIST die Wiederholung schreibt keine zweite Rechnung');

  // …und nach gelungenem Speichern bekommt sie ihr urspruengliches Ergebnis.
  state.failSave = false;
  const settled = await runInvoiceCreate(d, identity(ID('8')), payloadFor(s.customerId, s.lotId));
  ok(settled.kind === 'ok' && (settled as { replayed: boolean }).replayed === true,
    `PERSIST nach gelungenem Nachholen kommt das eingefrorene Ergebnis (${JSON.stringify(settled)})`);
  ok(!isDurabilityDegraded() && Number(one(db, 'SELECT COUNT(*) FROM invoices')) === 1,
    'PERSIST und es bleibt bei einer Rechnung');
}

// ── 10) Der Client: eine Kennung pro Vorsatz, nicht pro Anfrage ───────────
{
  // Der echte Weg in den Clientmodus — kein gestellter Zustand.
  enterClientMode('https://primary.local');
  setClientToken('tok');

  const reply = (status: number, body: Record<string, unknown>): Response =>
    ({ status, ok: status >= 200 && status < 300, json: async () => body }) as unknown as Response;

  // (a) Zeitgrenze: der Ausgang ist offen — dieselbe Kennung, niemals eine neue.
  const ctl = new InvoiceSaveController();
  const attempt = ctl.beginAttempt();
  const firstId = attempt.commandId;
  const timeout = await attempt.send({ customerId: 'c' }, async () => reply(504, {}));
  ok(timeout.kind === 'unknown', `CLIENT eine Zeitgrenze ist kein Fehlschlag (${JSON.stringify(timeout)})`);
  ok(!attempt.isSettled(), 'CLIENT der Versuch bleibt offen');
  ok(ctl.beginAttempt().commandId === firstId,
    'CLIENT ein zweiter Klick erzeugt KEINE zweite Rechnung — dieselbe Kennung');

  // Die Wiederholung derselben Kennung findet das eingefrorene Ergebnis.
  const okOut = await attempt.send({ customerId: 'c' }, async () =>
    reply(200, { ok: true, value: { invoiceId: 'inv-1', invoiceNumber: 'PINV-2026-000001', grossAmount: 165, replayed: true } }));
  ok(okOut.kind === 'ok' && okOut.replayed === true, `CLIENT die Wiederholung bekommt die Rechnung (${JSON.stringify(okOut)})`);
  ok(attempt.isSettled(), 'CLIENT damit ist der Versuch beantwortet');
  ok(ctl.beginAttempt().commandId !== firstId, 'CLIENT der naechste bewusste Save bekommt eine neue Kennung');

  // (b) Nachweislich nicht ausgefuehrt → dieselbe Kennung darf sofort erneut.
  const ctl2 = new InvoiceSaveController();
  const a2 = ctl2.beginAttempt();
  const notRun = await a2.send({ customerId: 'c' }, async () =>
    reply(503, { ok: false, error: 'BRIDGE_NOT_READY', outcome: 'not_executed' }));
  ok(notRun.kind === 'not_executed', `CLIENT „nicht ausgefuehrt" ist wiederholbar (${JSON.stringify(notRun)})`);
  ok(!a2.isSettled() && ctl2.beginAttempt().commandId === a2.commandId,
    'CLIENT …mit derselben Kennung');

  // (c) Ein fachliches Nein beendet den Versuch — ein neuer Wille bekommt eine neue Kennung.
  const ctl3 = new InvoiceSaveController();
  const a3 = ctl3.beginAttempt();
  const no = await a3.send({ customerId: 'c' }, async () =>
    reply(200, { ok: false, error: 'STOCK_UNAVAILABLE', message: 'nichts mehr da' }));
  ok(no.kind === 'business_error' && no.code === 'STOCK_UNAVAILABLE', `CLIENT das Nein kommt an (${JSON.stringify(no)})`);
  ok(a3.isSettled() && ctl3.beginAttempt().commandId !== a3.commandId,
    'CLIENT und ein bewusst neuer Versuch bekommt eine neue Kennung');

  // (d) Netz weg: ebenfalls offen, nie „ist nicht passiert".
  const a4 = new InvoiceSaveAttempt();
  const gone = await a4.send({ customerId: 'c' }, async () => { throw new Error('ECONNRESET'); });
  ok(gone.kind === 'unknown', `CLIENT ein Abbruch laesst den Ausgang offen (${JSON.stringify(gone)})`);

  // Und im Code steht nirgends ein automatischer zweiter Versuch mit neuer Kennung.
  // Seit C3C liegt der Vertrag im generischen Modul — er gilt fuer JEDEN schreibenden Auftrag,
  // nicht nur fuer Rechnungen. Die Regel muss dort stehen, und das Rechnungsmodul muss sie
  // BENUTZEN statt sie ein zweites Mal zu schreiben.
  const genericSrc = src('src/core/bridge/client-command-save.ts');
  ok(/if \(this\.attempt && !this\.attempt\.isSettled\(\)\) return this\.attempt;/.test(genericSrc),
    'CLIENT die Regel steht im Code, nicht nur im Test');
  const clientSrc = src('src/core/bridge/client-invoice-save.ts');
  ok(/new CommandSaveController<InvoiceSaveValue>\(OP_INVOICES_CREATE\)/.test(clientSrc)
    && !/newCommandId\(\)/.test(clientSrc),
    'CLIENT …und das Rechnungsformular erzeugt keine Kennung an ihm vorbei');
}

// ── 11) Der Primary schreibt weiter lokal ─────────────────────────────────
{
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  const db = freshDb();
  installWriteGuard(db as never);
  const s = seed(db, { qty: 3 });
  const store = await import('../../src/stores/invoiceStore.ts');

  // Genau der Weg des Formulars: dieselbe Ableitung, dieselbe Store-Funktion, ohne Brücke.
  const line = toInvoiceLine({ productId: s.productId, lotId: s.lotId, quantity: 1, unitPrice: 150, costBasis: 100, scheme: 'VAT_10' });
  const local = store.useInvoiceStore.getState().createDirectInvoice(s.customerId, [line]);
  ok(!!local && /^PINV-/.test(local.invoiceNumber), `PRIMARY der lokale Weg funktioniert weiter (${local?.invoiceNumber})`);
  ok(Number(one(db, "SELECT qty_remaining FROM stock_lots WHERE id='lot-1'")) === 2,
    'PRIMARY mit demselben Bestandsabzug');

  // Und danach eine Fernrechnung auf derselben Datenbank — dieselbe Nummernfolge, keine Kollision.
  const { deps: d } = deps(db);
  const remote = await runInvoiceCreate(d, identity(ID('9')), payloadFor(s.customerId, s.lotId));
  const rv = (remote as { value: { invoiceNumber: string } }).value;
  ok(remote.kind === 'ok' && rv.invoiceNumber !== local.invoiceNumber,
    `PRIMARY beide Wege teilen einen Nummernkreis (${local.invoiceNumber} / ${rv.invoiceNumber})`);
  ok(Number(one(db, 'SELECT COUNT(DISTINCT invoice_number) FROM invoices')) === 2,
    'PRIMARY zwei Rechnungen, zwei Nummern');
}

// ── 12) Gegenproben ───────────────────────────────────────────────────────
{
  // (a) An der C3A-Maschine vorbei: die Domaenenfunktion direkt gerufen — kein Nachweis, und die
  //     „Wiederholung" bucht ein zweites Mal. Genau das faengt §7.
  resetDurabilityStateForTest();
  const db = freshDb();
  const s = seed(db, { qty: 5 });
  const store = await import('../../src/stores/invoiceStore.ts');
  const line = () => toInvoiceLine({ productId: s.productId, lotId: s.lotId, quantity: 1, unitPrice: 150, costBasis: 100, scheme: 'VAT_10' });
  store.useInvoiceStore.getState().createDirectInvoice(s.customerId, [line()]);
  store.useInvoiceStore.getState().createDirectInvoice(s.customerId, [line()]);
  ok(commandCount(db as never) === 0 && Number(one(db, 'SELECT COUNT(*) FROM invoices')) === 2,
    'CONTROL a ohne die Maschine gibt es keinen Nachweis und zwei Rechnungen — genau das faengt §7');

  // (b) Die Zulassungsliste global geoeffnet: dann waere jede kuenftige Mutation registrierbar.
  const registry = await import('../../src/core/bridge/command-registry.ts');
  const openList: readonly string[] = ['invoices.create', 'products.create', 'invoice.delete'];
  ok(openList.includes('invoice.delete') && !registry.ALLOWED_MUTATIONS.includes('invoice.delete'),
    'CONTROL b eine offene Liste liesse `invoice.delete` zu — die echte tut es nicht');

  // (c) Ohne Bestandspruefung: das letzte Stueck wuerde zweimal verkauft.
  const lots = src('src/core/lots/lot-queries.ts');
  ok(/assertLotsConsumable/.test(lots) && /STOCK_UNAVAILABLE_MESSAGE/.test(lots),
    'CONTROL c die Bestandspruefung ist der Grund, warum §6 ueberhaupt ein Nein hat');
  const inv = src('src/stores/invoiceStore.ts');
  const checkAt = inv.indexOf('assertLotsConsumable(');
  const insertAt = inv.indexOf('INSERT INTO invoices (id, branch_id, invoice_number');
  ok(checkAt > 0 && checkAt < insertAt, 'CONTROL c …und sie steht VOR dem ersten Schreibvorgang');

  // (d) Ohne Serialisierung liefen beide Auftraege ineinander.
  const registrySrc = src('src/core/bridge/command-registry.ts');
  ok(/value = await runExclusive\(\(\) => spec\.handler\(payload, actor\)\);/.test(registrySrc),
    'CONTROL d eine Mutation laeuft ausschliesslich in der einen Schreibreihenfolge');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central c3b remote invoice create: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
console.log('CENTRAL_C3B_SINGLE_MUTATION_ALLOWLIST_PROVED');
console.log('CENTRAL_C3B_INVOICE_DOMAIN_REUSE_PROVED');
console.log('CENTRAL_C3B_INVOICE_PAYLOAD_AUTHORITY_PROVED');
console.log('CENTRAL_C3B_INVOICE_REMOTE_ENGINE_PROVED');
console.log('CENTRAL_C3B_INVOICE_SEQUENCE_CONCURRENCY_PROVED');
console.log('CENTRAL_C3B_LAST_UNIT_CONCURRENCY_PROVED');
console.log('CENTRAL_C3B_INVOICE_RETRY_IDEMPOTENCY_PROVED');
console.log('CENTRAL_C3B_CLIENT_INVOICE_SAVE_UX_PROVED');
