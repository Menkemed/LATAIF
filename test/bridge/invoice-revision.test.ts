// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-C3D FINAL — die Fassung einer Rechnung: kein verlorenes Update.
// Run: node test/bridge/invoice-revision.test.ts
//
// Der Befund, der diese Datei nötig gemacht hat: `updated_at` SIEHT aus wie eine Fassung. Gemessen
// sind zwei aufeinanderfolgende `new Date().toISOString()` in 200 von 200 Fällen identisch — sql.js
// schreibt im Speicher, und zwei Vorgänge liegen mühelos in derselben Millisekunde. Ein
// optimistisches Sperren darauf ist eine Sicherung, die genau im Rennen versagt.
//
// Also eine echte Fassung: eine Ganzzahl, die ein TRIGGER bei jeder Änderung an der
// Rechnungszeile erhöht — in derselben SQL-Transaktion, also unteilbar mit der Wirkung.
//
// Geprüft wird hier ohne künstliche Zeitabstände: kein `sleep`, kein „warte eine Millisekunde".
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
const { runInvoiceCreate } = await import('../../src/core/bridge/invoice-command.ts');
const { runInvoiceUpdate, parseInvoiceUpdate } =
  await import('../../src/core/bridge/invoice-lifecycle-commands.ts');
// Zwei Auftraege, die gleichzeitig ankommen, laufen in der Produktion durch `executeCommand` —
// und damit durch die EINE Schreibreihenfolge. Ein Test, der die Befehle direkt parallel ruft,
// wuerde etwas messen, das es nicht gibt (und die Transaktionsklammern zerreissen).
const { executeCommand } = await import('../../src/core/bridge/command-registry.ts');
await import('../../src/core/bridge/invoice-lifecycle-commands.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const { useInvoiceStore } = await import('../../src/stores/invoiceStore.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const NOW = '2026-09-06T10:00:00.000Z';

interface Db {
  run(sql: string, p?: unknown[]): unknown;
  exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
  export(): Uint8Array;
}
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const n = (db: Db, sql: string, p: unknown[] = []): number => Number(one(db, sql, p) ?? 0);

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
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-main','tenant-1','Haupt',?,?)", [NOW, NOW]);
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES ('cat-w','branch-main','W','w','#000',?,?)", [NOW, NOW]);
  db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level,
      preferences, customer_type, sales_stage, created_at, updated_at)
    VALUES ('cust-1','branch-main','Ali','Hassan','BH','en',0,'[]','collector','active',?,?)`, [NOW, NOW]);
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  useInvoiceStore.getState().loadInvoices();
  return db;
}

function seedProduct(db: Db, id: string, qty: number, cost = 100): void {
  db.run(
    `INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
       scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
       tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
     VALUES (?,?,'cat-w','Rolex',?,?,?,'Pre-Owned','[]',?,'BHD',150,'in_stock','VAT_10',0,'[]','{}','OWN',?,?)`,
    [id, 'branch-main', 'P ' + id, 'SKU-' + id, qty, cost, NOW, NOW],
  );
  db.run(
    `INSERT INTO stock_lots (id, branch_id, product_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
     VALUES (?,?,?,?,?,?,'ACTIVE',?,?)`,
    ['lot-' + id, 'branch-main', id, cost, qty, qty, NOW, NOW],
  );
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

const rev = (db: Db, id: string): number => n(db, 'SELECT revision FROM invoices WHERE id = ?', [id]);
const stamp = (db: Db, id: string): string => String(one(db, 'SELECT updated_at FROM invoices WHERE id = ?', [id]) ?? '');

async function makeInvoice(d: ReturnType<typeof deps>, nth: string, productId: string, qty = 1, price = 150) {
  const out = await runInvoiceCreate(d, identity(nth, 'invoices.create'), {
    customerId: 'cust-1', lines: [{ productId, quantity: qty, unitPrice: price }],
  });
  if (out.kind !== 'ok') throw new Error('setup failed: ' + JSON.stringify(out));
  return (out as { value: { invoiceId: string } }).value.invoiceId;
}
const editBody = (id: string, revision: number, qty: number, reason: string, price = 150) => ({
  id, expectedRevision: revision, reason,
  customerId: 'cust-1', lines: [{ productId: 'p1', quantity: qty, unitPrice: price }],
});

// ── 1) Warum kein Zeitstempel — gemessen, nicht behauptet ─────────────────
{
  let identical = 0;
  for (let i = 0; i < 200; i++) {
    if (new Date().toISOString() === new Date().toISOString()) identical += 1;
  }
  ok(identical > 0,
    `TOKEN zwei aufeinanderfolgende Zeitstempel sind in ${identical}/200 Faellen GLEICH — als Fassung untauglich`);
  ok(identical > 100,
    `TOKEN …und das ist der Normalfall, nicht der Ausnahmefall (${identical}/200)`);

  // Und im echten Schreibweg: zwei Mutationen nacheinander, ohne jede Wartezeit.
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  const db = freshDb();
  const d = deps(db);
  seedProduct(db, 'p1', 5);
  const inv = await makeInvoice(d, '1', 'p1');
  const store2 = useInvoiceStore.getState();
  const t0 = stamp(db, inv);
  const r0 = rev(db, inv);
  store2.recordPayment(inv, 1, 'cash');
  const t1 = stamp(db, inv);
  const r1 = rev(db, inv);
  store2.recordPayment(inv, 1, 'cash');
  const t2 = stamp(db, inv);
  const r2 = rev(db, inv);

  // Ob ZWEI ECHTE Mutationen dieselbe Millisekunde treffen, haengt an der Maschine — genau das
  // ist das Problem: eine Sicherung, die vom Tempo des Rechners abhaengt, ist keine. Der
  // Zeitstempel wird deshalb nur noch angezeigt.
  ok(t0 <= t1 && t1 <= t2, `TOKEN der Zeitstempel laeuft hoechstens vorwaerts (${t0} / ${t1} / ${t2})`);
  ok(r0 < r1 && r1 < r2, `TOKEN die FASSUNG steigt bei JEDER Mutation (${r0} → ${r1} → ${r2})`);
  ok(r1 >= r0 + 1 && r2 >= r1 + 1,
    'TOKEN …streng steigend, unabhaengig von der Uhr (die Hoehe des Schritts sagt niemand zu)');
}

// ── 2) Deckung: jede Rechnungsmutation bewegt die Fassung ─────────────────
//
// Die Matrix wird nicht behauptet, sondern gefahren: jede echte Mutation des Stores läuft, und
// danach muss die Fassung eine andere sein. Auch die LOKALEN — ein Mensch am Primary zählt
// genauso wie ein Fernauftrag.
{
  resetDurabilityStateForTest();
  const db = freshDb();
  const d = deps(db);
  seedProduct(db, 'p1', 9);
  const inv = await makeInvoice(d, '2', 'p1', 1, 150);
  const store2 = () => useInvoiceStore.getState();

  const moves: Array<[string, () => void]> = [
    ['recordPayment (Teilzahlung)', () => { store2().recordPayment(inv, 10, 'cash'); }],
    ['editInvoice (lokal)', () => {
      store2().editInvoice(inv, {
        lines: [{ productId: 'p1', lotId: 'lot-p1', unitPrice: 150, purchasePrice: 100, taxScheme: 'VAT_10', vatRate: 0.1, vatAmount: 15, lineTotal: 165, quantity: 2 }],
        reason: 'lokal',
      });
    }],
    ['setSpecialMark', () => { store2().setSpecialMark(inv, true); }],
    ['updateInvoice (Notiz)', () => { store2().updateInvoice(inv, { notes: 'geändert' } as never); }],
    ['updatePayment', () => {
      const p = store2().getInvoicePayments(inv)[0];
      store2().updatePayment(p.id, inv, { amount: 12 });
    }],
    ['deletePayment', () => {
      const p = store2().getInvoicePayments(inv)[0];
      store2().deletePayment(p.id, inv);
    }],
    ['applyCreditToInvoice', () => {
      db.run(
        `INSERT INTO customer_credits (id, branch_id, customer_id, source_type, source_id, amount, used_amount, status, created_at)
         VALUES ('cred-1','branch-main','cust-1','manual','x',20,0,'OPEN',?)`, [NOW],
      );
      store2().applyCreditToInvoice(inv, 5);
    }],
  ];

  for (const [name, run] of moves) {
    const before = rev(db, inv);
    const stampBefore = stamp(db, inv);
    try { run(); } catch (e) { ok(false, `COVERAGE ${name} lief nicht: ${String(e)}`); continue; }
    const after = rev(db, inv);
    ok(after > before, `COVERAGE ${name} erhoeht die Fassung (${before} → ${after})`);
    void stampBefore;
  }

  // Und der Trigger ist der Grund — nicht die Sorgfalt eines Aufrufers.
  const dbSrc = src('src/core/db/database.ts');
  ok(/CREATE TRIGGER trg_invoices_revision/.test(dbSrc) && /AFTER UPDATE ON invoices/.test(dbSrc),
    'COVERAGE die Fassung haengt an einem Trigger, nicht an einem Aufrufer');
  ok(/WHEN NEW\.revision = OLD\.revision/.test(dbSrc),
    'COVERAGE …mit einer Bedingung gegen den eigenen Nachschlag');
  const invStore = src('src/stores/invoiceStore.ts');
  const invoiceWrites = [...invStore.matchAll(/UPDATE invoices SET ([^`]*?)WHERE/gs)].map((m) => m[1]);
  ok(invoiceWrites.length > 0, `COVERAGE der Scanner sieht die Schreibstellen (${invoiceWrites.length})`);
  ok(invoiceWrites.every((w) => !/\brevision\b/.test(w)),
    'COVERAGE und KEINE davon setzt die Fassung von Hand — sie koennte es vergessen');
  // Nicht zu verwechseln mit `invoice_edits.revision`: das ist der Zaehler der Aenderungs-HISTORIE
  // und bewegt sich bei einer ZAHLUNG nicht — als Nebenlaeufigkeits-Token also untauglich.
  ok(/INSERT INTO invoice_edits \(id, branch_id, invoice_id, revision/.test(invStore),
    'COVERAGE die Historie hat ihre eigene Zaehlung — sie ist nicht diese hier');
}

// ── 3) Rennen A: Primary zahlt zwischendurch ──────────────────────────────
{
  resetDurabilityStateForTest();
  const db = freshDb();
  const d = deps(db);
  seedProduct(db, 'p1', 9);
  const inv = await makeInvoice(d, '3', 'p1');

  // Der Client liest.
  const seen = rev(db, inv);
  // Der Primary zahlt — ohne jede Wartezeit dazwischen.
  useInvoiceStore.getState().recordPayment(inv, 5, 'cash');
  // Der Client speichert mit der alten Fassung.
  const stale = await runInvoiceUpdate(d, identity('4', 'invoices.update'), editBody(inv, seen, 2, 'stale'));

  ok(stale.kind === 'rejected' && (stale as { code: string }).code === 'INVOICE_CHANGED',
    `RACE-A eine zwischenzeitliche Zahlung macht den Edit ungueltig (${JSON.stringify(stale)})`);
  ok((stale as { frozen: boolean }).frozen === true, 'RACE-A …und das Urteil ist eingefroren');
  ok(n(db, 'SELECT COUNT(*) FROM invoice_edits WHERE invoice_id=?', [inv]) === 0, 'RACE-A nichts wurde geaendert');
  ok((stale as { message: string }).message.includes(String(seen)),
    `RACE-A die Antwort sagt, welche Fassung gesehen wurde (${(stale as { message: string }).message})`);

  // Mit der frischen Fassung geht derselbe Wunsch durch.
  const good = await runInvoiceUpdate(d, identity('5', 'invoices.update'), editBody(inv, rev(db, inv), 2, 'frisch'));
  ok(good.kind === 'ok', `RACE-A mit frischer Fassung geht es (${JSON.stringify(good)})`);
  ok((good as { value: { revision: number } }).value.revision > seen,
    'RACE-A und die Antwort nennt die NEUE Fassung fuer den naechsten Auftrag');
}

// ── 4) Rennen B: zwei Clients, dieselbe Ausgangsfassung ───────────────────
{
  resetDurabilityStateForTest();
  const db = freshDb();
  const d = deps(db);
  seedProduct(db, 'p1', 9);
  const inv = await makeInvoice(d, '6', 'p1');
  const base = rev(db, inv);

  // Beide fassen denselben Vorsatz, mit derselben gelesenen Fassung — gleichzeitig abgeschickt.
  const [a, b] = await Promise.all([
    executeCommand('invoices.update', { input: editBody(inv, base, 2, 'Client A') }, identity('7', 'invoices.update')),
    executeCommand('invoices.update', { input: editBody(inv, base, 3, 'Client B') }, identity('8', 'invoices.update')),
  ]);
  const winners = [a, b].filter((x) => x.kind === 'ok');
  const losers = [a, b].filter((x) => x.kind === 'business_error');
  ok(winners.length === 1, `RACE-B genau EINER committet (${JSON.stringify([a, b])})`);
  ok(losers.length === 1 && (losers[0] as { code: string }).code === 'INVOICE_CHANGED',
    `RACE-B der andere bekommt INVOICE_CHANGED (${JSON.stringify(losers[0])})`);
  ok(n(db, 'SELECT COUNT(*) FROM invoice_edits WHERE invoice_id=?', [inv]) === 1,
    'RACE-B es gibt genau EINEN Aenderungsgrund — kein verlorenes Update');
  ok(rev(db, inv) > base, `RACE-B und die Fassung ist gestiegen (${base} → ${rev(db, inv)})`);
  // Der Verlierer hat sie NICHT bewegt: ein abgelehnter Auftrag hinterlaesst keine Fassung.
  const afterRace = rev(db, inv);
  const again = await executeCommand('invoices.update',
    { input: editBody(inv, base, 4, 'nochmal mit der alten Fassung') }, identity('81', 'invoices.update'));
  ok(again.kind === 'business_error' && rev(db, inv) === afterRace,
    'RACE-B ein weiterer Versuch mit der alten Fassung bewegt nichts');
}

// ── 5) Rennen C: der Primary vor Ort gegen den Client ─────────────────────
{
  resetDurabilityStateForTest();
  const db = freshDb();
  const d = deps(db);
  seedProduct(db, 'p1', 9);
  const inv = await makeInvoice(d, '9', 'p1');
  const base = rev(db, inv);

  // Ein Mensch am Primary aendert lokal — direkt am Store, ohne Fernauftrag.
  useInvoiceStore.getState().editInvoice(inv, {
    lines: [{ productId: 'p1', lotId: 'lot-p1', unitPrice: 150, purchasePrice: 100, taxScheme: 'VAT_10', vatRate: 0.1, vatAmount: 15, lineTotal: 165, quantity: 2 }],
    reason: 'Primary vor Ort',
  });
  const afterLocal = rev(db, inv);
  ok(afterLocal > base, 'RACE-C der lokale Edit erhoeht die Fassung');

  const remote = await executeCommand('invoices.update',
    { input: editBody(inv, base, 3, 'Client aus derselben Fassung') }, identity('10', 'invoices.update'));
  ok(remote.kind === 'business_error' && (remote as { code: string }).code === 'INVOICE_CHANGED',
    `RACE-C der Fernauftrag aus derselben Ausgangsfassung verliert (${JSON.stringify(remote)})`);
  ok(n(db, 'SELECT COUNT(*) FROM invoice_edits WHERE invoice_id=?', [inv]) === 1,
    'RACE-C und der lokale Edit steht unveraendert da');
  ok(rev(db, inv) === afterLocal, 'RACE-C die Fassung wurde durch die Ablehnung nicht bewegt');
}

// ── 6) Rennen D: Wirkung und Fassung fallen nicht auseinander ─────────────
{
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  const db = freshDb();
  const d = deps(db);
  seedProduct(db, 'p1', 1);
  const inv = await makeInvoice(d, '11', 'p1');
  const before = rev(db, inv);

  // Ein fachliches Nein MITTEN im Edit: der Bestand reicht nicht.
  const refused = await runInvoiceUpdate(d, identity('12', 'invoices.update'), editBody(inv, before, 2, 'zu viel'));
  ok(refused.kind === 'rejected', `ROLLBACK der Edit wird abgelehnt (${JSON.stringify(refused)})`);
  ok(rev(db, inv) === before,
    `ROLLBACK und die Fassung ist NICHT gestiegen — sonst waere jede offene Ansicht grundlos ungueltig (${before} → ${rev(db, inv)})`);
  ok(n(db, 'SELECT COUNT(*) FROM invoice_edits WHERE invoice_id=?', [inv]) === 0, 'ROLLBACK nichts wurde geschrieben');

  // …und die zuvor gelesene Fassung gilt weiterhin.
  const still = await runInvoiceUpdate(d, identity('13', 'invoices.update'), editBody(inv, before, 1, 'anders', 200));
  ok(still.kind === 'ok', `ROLLBACK die unveraenderte Fassung traegt weiterhin (${JSON.stringify(still)})`);
  ok(n(db, 'SELECT COUNT(*) FROM invoice_edits WHERE invoice_id=?', [inv]) === 1,
    'ROLLBACK …und der Preis des LETZTEN Stuecks laesst sich aendern (das Los dieser Rechnung zaehlt mit)');

  // Auch ein Persistenzfehler darf keine Fassung hinterlassen.
  const failing = { ...deps(db), durableSave: async () => { throw new Error('disk full'); } };
  const revBefore = rev(db, inv);
  let threw: string | null = null;
  try {
    await runInvoiceUpdate(failing, identity('14', 'invoices.update'), editBody(inv, revBefore, 1, 'kein Platz', 300));
  } catch (e) { threw = String(e); }
  ok(threw !== null && /disk full/.test(threw), `ROLLBACK ein Speicherfehler ist kein Erfolg (${threw})`);
  // Die Wirkung steht im Speicher (die Transaktion hat committet), aber die Speicherschuld ist
  // gesetzt. Entscheidend: Wirkung UND Fassung sind ZUSAMMEN entstanden — der Trigger haengt an
  // derselben SQL-Transaktion. Es gibt also keinen Zustand „geaendert, aber alte Fassung" (der
  // einen zweiten Schreiber blind ueberschreiben liesse) und keinen „neue Fassung, aber nichts
  // geaendert" (der jede offene Ansicht grundlos entwertete).
  const revAfter = rev(db, inv);
  const grossAfter = n(db, 'SELECT gross_amount FROM invoices WHERE id=?', [inv]);
  ok(revAfter > revBefore && grossAfter > 300,
    `ROLLBACK Wirkung und Fassung sind gemeinsam entstanden (${revBefore} → ${revAfter}, brutto ${grossAfter})`);
  const withOld = await runInvoiceUpdate(deps(db), identity('15', 'invoices.update'), editBody(inv, revBefore, 1, 'alte Fassung', 400));
  ok(withOld.kind === 'rejected' && (withOld as { code: string }).code === 'INVOICE_CHANGED',
    'ROLLBACK …und die alte Fassung traegt danach nicht mehr');
}

// ── 7) Der Client darf die Fassung nicht wählen ───────────────────────────
{
  const good = parseInvoiceUpdate({
    id: 'i1', expectedRevision: 3, reason: 'x',
    customerId: 'cust-1', lines: [{ productId: 'p1', quantity: 1, unitPrice: 10 }],
  });
  ok(good.expectedRevision === 3, 'PAYLOAD die gelesene Fassung kommt durch');

  for (const [what, value] of [
    ['fehlt', undefined],
    ['ein Zeitstempel', '2026-09-06T10:00:00.000Z'],
    ['eine Kommazahl', 1.5],
    ['null', 0],
    ['negativ', -1],
    ['als Text', '3'],
  ] as const) {
    let threw: string | null = null;
    try {
      parseInvoiceUpdate({
        id: 'i1', reason: 'x', customerId: 'cust-1',
        lines: [{ productId: 'p1', quantity: 1, unitPrice: 10 }],
        ...(value === undefined ? {} : { expectedRevision: value }),
      });
    } catch (e) { threw = String(e); }
    ok(threw !== null && /expectedRevision/.test(threw), `PAYLOAD ${what} wird abgewiesen (${threw})`);
  }

  // Und der alte Zeitstempel-Vertrag ist WEG, nicht nur ungenutzt.
  const cmd = src('src/core/bridge/invoice-lifecycle-commands.ts');
  ok(!/expectedUpdatedAt/.test(cmd), 'PAYLOAD der Zeitstempel-Vertrag ist entfernt, nicht danebengelegt');
  ok(/Number\(live\.revision \?\? 0\) !== req\.expectedRevision/.test(cmd),
    'PAYLOAD verglichen wird die Fassung der ECHTEN Zeile');
}

// ── 8) Die Zahlung: ein Betrag, kein „zahl den Rest" ──────────────────────
//
// Der Unterschied ist teuer: ein Befehl „zahle den offenen Rest" trüge einen veralteten Rest im
// Kopf des Clients und erzeugte bei zwei Rechnern still Guthaben. Ein ausdrücklich eingegebener
// Betrag ist dagegen genau das, was ein Mensch gesagt hat — und der bestehende
// Überzahlungs→Guthaben-Vertrag bleibt richtig.
{
  const view = src('src/components/client/ClientInvoiceDetail.tsx');
  const code = view.split(/\r?\n/).filter((l) => !l.trim().startsWith('//')).join('\n');
  ok(/data-client-invoice-detail-amount/.test(code) && /type="number"/.test(code),
    'INTENT der Benutzer TIPPT einen Betrag');
  ok(/amount: Number\(amount\)/.test(code), 'INTENT …und genau der wird geschickt');
  ok(!/openAmount\s*[,)]/.test(code.slice(code.indexOf('const pay = useCallback'), code.indexOf('if (loadError)'))),
    'INTENT der offene Rest geht NICHT als Betrag mit');
  ok(!/pay\s*remaining|payRemaining|restzahlung/i.test(code),
    'INTENT es gibt keinen „zahle den Rest"-Knopf, der einen alten Rest mitschleppen koennte');

  const cmd = src('src/core/bridge/invoice-lifecycle-commands.ts');
  ok(/amount must be a positive number/.test(cmd), 'INTENT der Befehl verlangt einen Betrag…');
  ok(!/openAmount|remaining/.test(cmd.split('parsePaymentPayload')[1]?.slice(0, 900) ?? ''),
    'INTENT …und leitet ihn nirgends aus einem Rest ab');
}

// ── 9) Gegenproben: was OHNE die Fassung passiert ─────────────────────────
//
// Eine Sicherung, deren Fehlen man nicht sieht, ist keine. Hier wird der Trigger in einer eigenen
// Datenbank ENTFERNT — und genau dieselbe Folge, die oben abgewiesen wird, geht dann durch.
{
  resetDurabilityStateForTest();
  const db = freshDb();
  // Der Zähler bleibt stehen: das ist der Zustand VOR dieser Arbeit (und der Zustand, den ein
  // Zeitstempel mit Millisekunden-Auflösung faktisch hat, sobald zwei Vorgänge zusammenfallen).
  db.run('DROP TRIGGER IF EXISTS trg_invoices_revision');
  const d = deps(db);
  seedProduct(db, 'p1', 9);
  const inv = await makeInvoice(d, '16', 'p1');

  const seen = rev(db, inv);
  useInvoiceStore.getState().recordPayment(inv, 5, 'cash');
  ok(rev(db, inv) === seen, 'CONTROL a ohne Trigger bewegt eine Zahlung die Fassung NICHT');

  const blind = await runInvoiceUpdate(d, identity('17', 'invoices.update'), editBody(inv, seen, 2, 'blind'));
  ok(blind.kind === 'ok',
    `CONTROL a …und derselbe stale Edit geht klaglos durch (${JSON.stringify(blind)})`);
  ok(n(db, 'SELECT COUNT(*) FROM invoice_edits WHERE invoice_id=?', [inv]) === 1,
    'CONTROL a — genau der Zustand, den die Fassung verhindert');

  // Und das Rennen: zwei Auftraege aus derselben Ausgangsfassung — ohne Trigger gewinnen BEIDE,
  // und der erste Edit ist verloren.
  const base2 = rev(db, inv);
  const [x, y] = await Promise.all([
    executeCommand('invoices.update', { input: editBody(inv, base2, 3, 'A') }, identity('18', 'invoices.update')),
    executeCommand('invoices.update', { input: editBody(inv, base2, 4, 'B') }, identity('19', 'invoices.update')),
  ]);
  const bothWon = [x, y].filter((r) => r.kind === 'ok').length;
  ok(bothWon === 2, `CONTROL b ohne Fassung committen BEIDE (${bothWon}/2) — das verlorene Update`);
  ok(n(db, 'SELECT COUNT(*) FROM invoice_edits WHERE invoice_id=?', [inv]) === 3,
    'CONTROL b …und beide Aenderungsgruende stehen da, obwohl einer den anderen ueberschrieben hat');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central c3d invoice revision: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
console.log('CENTRAL_C3D_INVOICE_REVISION_COVERAGE_PROVED');
console.log('CENTRAL_C3D_NO_LOST_UPDATE_PROVED');
console.log('CENTRAL_C3D_PAYMENT_INTENT_SEMANTICS_PROVED');
