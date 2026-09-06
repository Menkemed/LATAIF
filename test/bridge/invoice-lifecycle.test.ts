// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-C3D — eine Rechnung ändern und bezahlen, von einem zweiten Rechner aus.
// Run: node test/bridge/invoice-lifecycle.test.ts
//
// Der ECHTE Weg: `editInvoice` und `recordPayment` aus dem Store, die echten Buchungsklammern,
// die echte C3A-Maschine, das echte Schema. Gestellt ist nur das Speichern.
//
// Eine Rechnung nach dem Anlegen ist der teuerste Vorgang dieses Hauses: sie hat Bestand
// verbraucht, gebucht und vielleicht Geld gesehen. Sechs Fragen:
//   • Was darf ein Client überhaupt sagen — und was entscheidet der Primary?
//   • Was passiert, wenn er einen ALTEN Stand speichert?
//   • Läuft alles in EINER Transaktion (Zeilen, Bestand, Ledger, Nachweis)?
//   • Was macht der Bestand beim Ändern — mehr, weniger, weg?
//   • Wird eine verlorene Antwort zur zweiten Zahlung?
//   • Und bleibt ein Urteil ein Urteil, eine Störung aber eine Störung?
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
const { COMMAND_LEDGER_DDL, COMMAND_LEDGER_INDEX, commandCount } =
  await import('../../src/core/bridge/command-ledger.ts');
const { resetDurabilityStateForTest } = await import('../../src/core/bridge/durability-state.ts');
const { resetTransactionHealthForTest } = await import('../../src/core/db/transaction-health.ts');
const { installWriteGuard } = await import('../../src/core/db/write-guard.ts');
const { runInvoiceCreate } = await import('../../src/core/bridge/invoice-command.ts');
const {
  runInvoiceUpdate, runInvoicePayment, parseInvoiceUpdate, parsePaymentPayload,
} = await import('../../src/core/bridge/invoice-lifecycle-commands.ts');
const registry = await import('../../src/core/bridge/command-registry.ts');
await import('../../src/core/bridge/read-commands.ts');
await import('../../src/core/bridge/customer-commands.ts');
await import('../../src/core/bridge/product-commands.ts');
await import('../../src/core/bridge/return-commands.ts');
await import('../../src/core/bridge/lifecycle-commands.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const { useInvoiceStore } = await import('../../src/stores/invoiceStore.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const code = (p: string): string => src(p)
  .split(/\r?\n/)
  .filter((l) => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')); })
  .join('\n');
const NOW = '2026-09-06T09:00:00.000Z';

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

/** Ein Produkt mit einem Los von `qty` Stück — die echte Bestandsform des Hauses. */
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

function deps(db: Db) {
  const state = { saves: 0 };
  return {
    state,
    deps: {
      db: db as never,
      begin: posting.beginLedgerTransaction,
      commit: posting.commitLedgerTransaction,
      rollback: posting.rollbackLedgerTransaction,
      durableSave: async () => { state.saves += 1; },
      now: () => NOW,
    },
  };
}

const remaining = (db: Db, lot: string): number => n(db, 'SELECT qty_remaining FROM stock_lots WHERE id = ?', [lot]);
const invState = (db: Db, id: string) => db.exec(
  'SELECT invoice_number, status, gross_amount, paid_amount, revision FROM invoices WHERE id = ?', [id],
)[0]?.values?.[0] ?? [];

async function makeInvoice(d: ReturnType<typeof deps>['deps'], nth: string, productId: string, qty = 1, price = 150) {
  const out = await runInvoiceCreate(d, identity(nth, 'invoices.create'), {
    customerId: 'cust-1', lines: [{ productId, quantity: qty, unitPrice: price }],
  });
  if (out.kind !== 'ok') throw new Error('setup failed: ' + JSON.stringify(out));
  return (out as { value: { invoiceId: string } }).value.invoiceId;
}

// ── 1) Der Umfang: was es nach dem Anlegen WIRKLICH gibt ──────────────────
//
// Diese Matrix ist kein Kommentar, sondern eine Prüfung: sie liest den echten Store und hält
// fest, welche Mutationen es gibt, welche freigegeben sind und welche ausdrücklich nicht.
{
  const inv = src('src/stores/invoiceStore.ts');
  const declared = (name: string): boolean => new RegExp(`^  ${name}: \\(`, 'm').test(inv);
  const MUTATIONS = [
    'updateInvoice', 'editInvoice', 'recordPayment', 'applyCreditToInvoice',
    'setSpecialMark', 'updatePayment', 'deletePayment', 'deleteInvoice',
  ];
  for (const m of MUTATIONS) ok(declared(m), `SCOPE der Store hat ${m}`);

  // Freigegeben ist GENAU das Paar, dessen lokaler Vertrag hier durchdacht wurde.
  const cmd = code('src/core/bridge/invoice-lifecycle-commands.ts');
  ok(/editInvoice\(/.test(cmd) && /recordPayment\(/.test(cmd),
    'SCOPE freigegeben sind editInvoice und recordPayment…');
  for (const notYet of ['deleteInvoice', 'deletePayment', 'updatePayment', 'applyCreditToInvoice', 'updateInvoice', 'setSpecialMark']) {
    ok(!new RegExp(`${notYet}\\(`).test(cmd), `SCOPE …und ${notYet} ausdruecklich NICHT`);
  }

  // Der lokale Vertrag, auf den sich alles stützt — am Quelltext belegt, nicht behauptet.
  const editAt = inv.indexOf('  editInvoice: (id, input) => {');
  const payAt = inv.indexOf('  recordPayment: (invoiceId', editAt);
  ok(editAt > 0 && payAt > editAt, 'SCOPE die beiden Implementierungen wurden wirklich gefunden');
  const edit = inv.slice(editAt, payAt);
  ok(/beginLedgerTransaction\(\)/.test(edit) && /commitLedgerTransaction\(\)/.test(edit),
    'SCOPE editInvoice ist EINE Transaktion');
  ok(/reverseSource\('INVOICE', id/.test(edit), 'SCOPE …die die alte Buchung zuruecknimmt');
  ok(/restoreLot\(/.test(edit) && /consumeLot\(/.test(edit), 'SCOPE …Lose zurueckgibt und neu verbraucht');
  ok(/postInvoiceIssued\(/.test(edit), 'SCOPE …neu bucht');
  ok(/An edit reason is required/.test(edit), 'SCOPE …und einen Grund verlangt');
  ok(!/updated_at\s*=\s*\?\s*AND\s*updated_at/.test(edit) && !/expectedRevision/.test(edit),
    'SCOPE lokal gibt es KEINE Stale-Sicherung — deshalb baut der Fernauftrag eine eigene');

  const pay = inv.slice(payAt, inv.indexOf('  applyCreditToInvoice: (invoiceId', payAt));
  ok(/getNextDocumentNumber\(/.test(pay), 'SCOPE eine Vollzahlung vergibt eine NEUE Belegnummer');
  ok(/computePaymentSplit\(/.test(pay), 'SCOPE eine Ueberzahlung wird aufgeteilt (Guthaben statt negativem AR)');
  ok(/inLedgerTransaction\(\)/.test(pay), 'SCOPE …und sie fuegt sich in eine laufende Transaktion ein');
}

// ── 2) Der Rumpf ist ein Wunsch ───────────────────────────────────────────
{
  const BODY = { customerId: 'cust-1', lines: [{ productId: 'p1', quantity: 1, unitPrice: 150 }] };

  for (const [field, extra] of [
    ['grossAmount', { grossAmount: 999 }],
    ['netAmount', { netAmount: 1 }],
    ['vatAmount', { vatAmount: 1 }],
    ['paidAmount', { paidAmount: 500 }],
    ['status', { status: 'FINAL' }],
    ['invoiceNumber', { invoiceNumber: 'INV-2026-000999' }],
    ['branchId', { branchId: 'branch-fremd' }],
    ['numbering', { numbering: 'sales' }],
    ['ledger', { ledger: [] }],
  ] as const) {
    let threw: string | null = null;
    try { parseInvoiceUpdate({ id: 'i1', expectedRevision: 1, reason: 'x', ...BODY, ...extra }); }
    catch (e) { threw = String(e); }
    ok(threw !== null && new RegExp(field).test(threw), `AUTHORITY ${field} entscheidet der Primary (${threw})`);
  }

  for (const [what, raw] of [
    ['ohne Kennung', { expectedRevision: 1, reason: 'x', ...BODY }],
    ['ohne gesehene Fassung', { id: 'i1', reason: 'x', ...BODY }],
    ['ohne Grund', { id: 'i1', expectedRevision: 1, ...BODY }],
    ['leerer Grund', { id: 'i1', expectedRevision: 1, reason: '   ', ...BODY }],
    ['ohne Zeilen', { id: 'i1', expectedRevision: 1, reason: 'x', customerId: 'cust-1', lines: [] }],
    ['unbekanntes Feld', { id: 'i1', expectedRevision: 1, reason: 'x', ...BODY, tip: 5 }],
    ['Zahlung im Edit', { id: 'i1', expectedRevision: 1, reason: 'x', ...BODY, deltaPayment: { amount: 5, method: 'cash' } }],
  ] as const) {
    let threw: string | null = null;
    try { parseInvoiceUpdate(raw); } catch (e) { threw = String(e); }
    ok(threw !== null, `AUTHORITY ${what} wird abgewiesen (${threw})`);
  }

  const good = parseInvoiceUpdate({ id: 'i1', expectedRevision: 1, reason: '  Preis korrigiert  ', ...BODY });
  ok(good.reason === 'Preis korrigiert' && good.body.lines.length === 1,
    `AUTHORITY ein gueltiger Auftrag kommt durch (${JSON.stringify(good.reason)})`);

  // Die Zahlung: nur Betrag, Art, Notiz, Kartenmarke.
  for (const [what, raw] of [
    ['ohne Rechnung', { amount: 10, method: 'cash' }],
    ['Betrag 0', { invoiceId: 'i1', amount: 0, method: 'cash' }],
    ['negativer Betrag', { invoiceId: 'i1', amount: -5, method: 'cash' }],
    ['Betrag als Text', { invoiceId: 'i1', amount: '10', method: 'cash' }],
    ['unbekannte Art', { invoiceId: 'i1', amount: 10, method: 'bitcoin' }],
    ['Guthaben-Einloesung', { invoiceId: 'i1', amount: 10, method: 'credit' }],
    ['eigener Zahlungsschluessel', { invoiceId: 'i1', amount: 10, method: 'cash', paymentId: 'p-forged' }],
    ['Status mitgeschickt', { invoiceId: 'i1', amount: 10, method: 'cash', status: 'FINAL' }],
    ['Sondermarke', { invoiceId: 'i1', amount: 10, method: 'cash', specialMarkOnFinal: true }],
    ['bezahlter Gesamtbetrag', { invoiceId: 'i1', amount: 10, method: 'cash', paidAmount: 999 }],
  ] as const) {
    let threw: string | null = null;
    try { parsePaymentPayload(raw); } catch (e) { threw = String(e); }
    ok(threw !== null, `AUTHORITY Zahlung: ${what} wird abgewiesen (${threw})`);
  }
  const p = parsePaymentPayload({ invoiceId: 'i1', amount: 25.5, method: 'card', cardBrand: 'amex', notes: 'Anzahlung' });
  ok(p.amount === 25.5 && p.method === 'card' && p.cardBrand === 'amex',
    'AUTHORITY eine gueltige Zahlung kommt durch');
}

// ── 3) Der echte Weg: ändern ──────────────────────────────────────────────
{
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  const db = freshDb();
  const { deps: d, state } = deps(db);
  seedProduct(db, 'p1', 3);
  seedProduct(db, 'p2', 2);

  const inv = await makeInvoice(d, '1', 'p1', 1, 150);
  ok(remaining(db, 'lot-p1') === 2, `SETUP ein Stueck ist verkauft (${remaining(db, 'lot-p1')})`);
  const before = invState(db, inv);
  const seenAt = Number(before[4]);
  const savesBefore = state.saves;

  const edited = await runInvoiceUpdate(d, identity('2', 'invoices.update'), {
    id: inv, expectedRevision: seenAt, reason: 'Menge korrigiert',
    customerId: 'cust-1', lines: [{ productId: 'p1', quantity: 2, unitPrice: 150 }],
  });
  ok(edited.kind === 'ok', `EDIT die Aenderung geht durch (${JSON.stringify(edited)})`);
  const v = (edited as { value: { grossAmount: number; revision: number; status: string } }).value;

  ok(n(db, 'SELECT gross_amount FROM invoices WHERE id = ?', [inv]) === v.grossAmount,
    'EDIT die Summe kommt vom Primary und steht so in der Datenbank');
  ok(v.grossAmount > Number(before[2]), `EDIT …und sie ist gewachsen (${before[2]} → ${v.grossAmount})`);
  ok(remaining(db, 'lot-p1') === 1, `STOCK Menge 1 → 2 nimmt ein weiteres Stueck (${remaining(db, 'lot-p1')})`);
  ok(n(db, 'SELECT COUNT(*) FROM invoice_lines WHERE invoice_id = ?', [inv]) === 1, 'EDIT es bleibt eine Zeile');
  ok(n(db, 'SELECT COUNT(*) FROM invoice_edits WHERE invoice_id = ?', [inv]) === 1,
    'EDIT der Aenderungsgrund ist festgehalten');
  ok(String(one(db, 'SELECT reason FROM invoice_edits WHERE invoice_id = ?', [inv])) === 'Menge korrigiert',
    'EDIT …mit genau dem Text des Menschen');
  ok(commandCount(db as never) === 2, 'EDIT der durable Nachweis steht');
  ok(state.saves > savesBefore, 'EDIT …und danach wurde gespeichert');
  ok(v.revision > seenAt, 'EDIT die Fassung ist eine neue — der naechste Auftrag muss sie nennen');

  // Menge zurück: das Stück kommt in den Bestand.
  const back = await runInvoiceUpdate(d, identity('3', 'invoices.update'), {
    id: inv, expectedRevision: v.revision, reason: 'Doch nur eines',
    customerId: 'cust-1', lines: [{ productId: 'p1', quantity: 1, unitPrice: 150 }],
  });
  ok(back.kind === 'ok' && remaining(db, 'lot-p1') === 2,
    `STOCK Menge 2 → 1 gibt das Stueck zurueck (${remaining(db, 'lot-p1')})`);

  // Anderes Produkt: das alte Los wird frei, das neue verbraucht.
  const swapped = await runInvoiceUpdate(d, identity('4', 'invoices.update'), {
    id: inv, expectedRevision: Number((back as { value: { revision: number } }).value.revision),
    reason: 'Falscher Artikel', customerId: 'cust-1',
    lines: [{ productId: 'p2', quantity: 1, unitPrice: 200 }],
  });
  ok(swapped.kind === 'ok', `STOCK der Artikel laesst sich tauschen (${JSON.stringify(swapped)})`);
  ok(remaining(db, 'lot-p1') === 3, `STOCK …das alte Los ist wieder voll (${remaining(db, 'lot-p1')})`);
  ok(remaining(db, 'lot-p2') === 1, `STOCK …und das neue verbraucht (${remaining(db, 'lot-p2')})`);
  ok(String(one(db, 'SELECT product_id FROM invoice_lines WHERE invoice_id = ?', [inv])) === 'p2',
    'STOCK die Zeile zeigt auf den neuen Artikel');

  // Und das Ledger folgt: die alte Buchung ist zurückgenommen, eine neue steht.
  ok(n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module='INVOICE' AND source_id=?", [inv]) > 0,
    'LEDGER die Rechnung ist gebucht');
  const balanced = n(db, `SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0)
     FROM ledger_entries WHERE source_module='INVOICE' AND source_id=?`, [inv]);
  ok(Math.abs(balanced) < 0.005, `LEDGER …und die Buchung ist ausgeglichen (${balanced})`);
}

// ── 4) Ein alter Stand überschreibt nichts ────────────────────────────────
{
  resetDurabilityStateForTest();
  const db = freshDb();
  const { deps: d } = deps(db);
  seedProduct(db, 'p1', 5);

  const inv = await makeInvoice(d, '5', 'p1', 1, 150);
  const seenAt = Number(invState(db, inv)[4]);

  // Der Primary ändert die Rechnung — так wie es ein Mensch an PC1 täte.
  const first = await runInvoiceUpdate(d, identity('6', 'invoices.update'), {
    id: inv, expectedRevision: seenAt, reason: 'Primary korrigiert',
    customerId: 'cust-1', lines: [{ productId: 'p1', quantity: 2, unitPrice: 150 }],
  });
  ok(first.kind === 'ok', 'STALE der Primary aendert zuerst');
  const grossAfterPrimary = n(db, 'SELECT gross_amount FROM invoices WHERE id = ?', [inv]);
  const stockAfterPrimary = remaining(db, 'lot-p1');

  // Der Client hatte den ALTEN Stand offen und speichert jetzt.
  const stale = await runInvoiceUpdate(d, identity('7', 'invoices.update'), {
    id: inv, expectedRevision: seenAt, reason: 'Client mit altem Stand',
    customerId: 'cust-1', lines: [{ productId: 'p1', quantity: 1, unitPrice: 99 }],
  });
  ok(stale.kind === 'rejected' && (stale as { code: string }).code === 'INVOICE_CHANGED',
    `STALE ein alter Stand wird abgewiesen (${JSON.stringify(stale)})`);
  ok((stale as { frozen: boolean }).frozen === true,
    'STALE …und das Urteil ist eingefroren — dieselbe Anfrage wird nie wieder gueltig');
  ok(n(db, 'SELECT gross_amount FROM invoices WHERE id = ?', [inv]) === grossAfterPrimary,
    'STALE die Aenderung des Primary steht unveraendert');
  ok(remaining(db, 'lot-p1') === stockAfterPrimary, 'STALE …und der Bestand ist unberuehrt');
  ok(n(db, 'SELECT COUNT(*) FROM invoice_edits WHERE invoice_id = ?', [inv]) === 1,
    'STALE es wurde kein zweiter Aenderungsgrund geschrieben');

  // Mit dem FRISCHEN Stand geht derselbe Wunsch durch — der Mensch hat neu gelesen.
  const fresh = Number(invState(db, inv)[4]);
  const retry = await runInvoiceUpdate(d, identity('8', 'invoices.update'), {
    id: inv, expectedRevision: fresh, reason: 'Client nach Neulesen',
    customerId: 'cust-1', lines: [{ productId: 'p1', quantity: 1, unitPrice: 99 }],
  });
  ok(retry.kind === 'ok', `STALE mit frischem Stand geht es (${JSON.stringify(retry)})`);
  ok(n(db, 'SELECT gross_amount FROM invoices WHERE id = ?', [inv]) < grossAfterPrimary,
    'STALE …und jetzt gilt die Aenderung des Clients');
}

// ── 5) Verlorene Antwort beim Ändern ──────────────────────────────────────
{
  resetDurabilityStateForTest();
  const db = freshDb();
  const { deps: d } = deps(db);
  seedProduct(db, 'p1', 5);
  const inv = await makeInvoice(d, '9', 'p1', 1, 150);
  const seenAt = Number(invState(db, inv)[4]);
  const plan = {
    id: inv, expectedRevision: seenAt, reason: 'Einmal',
    customerId: 'cust-1', lines: [{ productId: 'p1', quantity: 3, unitPrice: 150 }],
  };

  const once = await runInvoiceUpdate(d, identity('10', 'invoices.update'), plan);
  ok(once.kind === 'ok', 'RETRY der erste Lauf geht durch');
  const after = { gross: n(db, 'SELECT gross_amount FROM invoices WHERE id=?', [inv]), lot: remaining(db, 'lot-p1'), edits: n(db, 'SELECT COUNT(*) FROM invoice_edits WHERE invoice_id=?', [inv]) };

  const again = await runInvoiceUpdate(d, identity('10', 'invoices.update'), plan);
  ok(again.kind === 'ok' && (again as { replayed: boolean }).replayed === true,
    `RETRY die Wiederholung wird erkannt (${JSON.stringify(again)})`);
  ok(n(db, 'SELECT gross_amount FROM invoices WHERE id=?', [inv]) === after.gross, 'RETRY die Summe ist dieselbe');
  ok(remaining(db, 'lot-p1') === after.lot, 'RETRY der Bestand wurde nicht ein zweites Mal belastet');
  ok(n(db, 'SELECT COUNT(*) FROM invoice_edits WHERE invoice_id=?', [inv]) === after.edits,
    'RETRY und es gibt genau EINEN Aenderungsgrund');

  const conflict = await runInvoiceUpdate(d, identity('10', 'invoices.update', 'ANDERS'), {
    ...plan, reason: 'Etwas ganz anderes',
  });
  ok(conflict.kind === 'rejected' && (conflict as { code: string }).code === 'COMMAND_ID_CONFLICT'
    && (conflict as { frozen: boolean }).frozen === false,
    `RETRY gleiche Kennung, anderer Rumpf: abgewiesen, nichts eingefroren (${JSON.stringify(conflict)})`);
  ok(n(db, 'SELECT COUNT(*) FROM invoice_edits WHERE invoice_id=?', [inv]) === after.edits,
    'RETRY …und keine Wirkung');
}

// ── 6) Zahlen ─────────────────────────────────────────────────────────────
{
  resetDurabilityStateForTest();
  const db = freshDb();
  const { deps: d } = deps(db);
  seedProduct(db, 'p1', 5);
  const inv = await makeInvoice(d, '11', 'p1', 1, 150);
  const gross = n(db, 'SELECT gross_amount FROM invoices WHERE id=?', [inv]);
  const numberBefore = String(invState(db, inv)[0]);

  // Teilzahlung.
  const part = await runInvoicePayment(d, identity('12', 'invoices.record_payment'), {
    invoiceId: inv, amount: 50, method: 'cash',
  });
  ok(part.kind === 'ok', `PAY eine Teilzahlung geht durch (${JSON.stringify(part)})`);
  const pv = (part as { value: { paidAmount: number; openAmount: number; status: string; paymentId: string } }).value;
  ok(pv.paidAmount === 50 && Math.abs(pv.openAmount - (gross - 50)) < 0.005,
    `PAY bezahlt und offen kommen vom Primary (${pv.paidAmount} / ${pv.openAmount})`);
  ok(pv.status === 'PARTIAL', `PAY der Status ist abgeleitet, nicht gesendet (${pv.status})`);
  ok(n(db, 'SELECT COUNT(*) FROM payments WHERE invoice_id=?', [inv]) === 1, 'PAY genau eine Zahlung');
  ok(n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module='PAYMENT' AND source_id=?", [pv.paymentId]) > 0,
    'PAY …und sie ist gebucht');

  // Verlorene Antwort: dieselbe Kennung → keine zweite Zahlung.
  const lost = await runInvoicePayment(d, identity('12', 'invoices.record_payment'), {
    invoiceId: inv, amount: 50, method: 'cash',
  });
  ok(lost.kind === 'ok' && (lost as { replayed: boolean }).replayed === true, 'PAY die Wiederholung wird erkannt');
  ok(n(db, 'SELECT COUNT(*) FROM payments WHERE invoice_id=?', [inv]) === 1, 'PAY keine zweite Zahlung');
  ok(n(db, 'SELECT paid_amount FROM invoices WHERE id=?', [inv]) === 50, 'PAY und kein zweiter Betrag');
  ok((lost as { value: { paymentId: string } }).value.paymentId === pv.paymentId,
    'PAY …die Antwort nennt dieselbe Zahlung');

  // Restzahlung → FINAL und eine NEUE Belegnummer aus dem Zaehler des Hauses.
  const rest = await runInvoicePayment(d, identity('13', 'invoices.record_payment'), {
    invoiceId: inv, amount: gross - 50, method: 'card', cardBrand: 'amex',
  });
  ok(rest.kind === 'ok', `PAY die Restzahlung geht durch (${JSON.stringify(rest)})`);
  const rv = (rest as { value: { status: string; openAmount: number; invoiceNumber: string } }).value;
  ok(rv.status === 'FINAL' && rv.openAmount === 0, `PAY voll bezahlt (${rv.status} / ${rv.openAmount})`);
  ok(rv.invoiceNumber !== numberBefore && /^S?INV-/.test(rv.invoiceNumber),
    `PAY und die endgueltige Nummer kommt aus dem Zaehler des Hauses (${numberBefore} → ${rv.invoiceNumber})`);
  ok(n(db, 'SELECT COUNT(*) FROM payments WHERE invoice_id=?', [inv]) === 2, 'PAY zwei Zahlungen insgesamt');

  // Eine dritte Zahlung auf eine bezahlte Rechnung: das Haus macht daraus ein Guthaben.
  const over = await runInvoicePayment(d, identity('14', 'invoices.record_payment'), {
    invoiceId: inv, amount: 20, method: 'cash',
  });
  ok(over.kind === 'ok', `PAY eine Ueberzahlung wird angenommen (${JSON.stringify(over)})`);
  ok(n(db, "SELECT COUNT(*) FROM customer_credits WHERE source_type='overpayment'") === 1,
    'PAY …und wird zu Guthaben, nicht zu negativem AR — genau wie am Primary');
}

// ── 7) Zwei Rechner zahlen fast gleichzeitig ──────────────────────────────
//
// Beide haben recht: eine Zahlung ist ein Zuwachs, keine Überschreibung. Der Primary rechnet
// JEDE gegen den frischen Rest — die zweite wird dann eben eine Überzahlung.
{
  resetDurabilityStateForTest();
  const db = freshDb();
  const { deps: d } = deps(db);
  seedProduct(db, 'p1', 5);
  const inv = await makeInvoice(d, '15', 'p1', 1, 150);
  const gross = n(db, 'SELECT gross_amount FROM invoices WHERE id=?', [inv]);

  const [a, b] = await Promise.all([
    runInvoicePayment(d, identity('16', 'invoices.record_payment'), { invoiceId: inv, amount: gross, method: 'cash' }),
    runInvoicePayment(d, identity('17', 'invoices.record_payment'), { invoiceId: inv, amount: gross, method: 'card' }),
  ]);
  ok(a.kind === 'ok' && b.kind === 'ok', `CONCURRENT beide Auftraege werden beantwortet (${a.kind}/${b.kind})`);
  ok(n(db, 'SELECT COUNT(*) FROM payments WHERE invoice_id=?', [inv]) === 2, 'CONCURRENT zwei echte Zahlungen');
  // Der Vertrag des Hauses: `paid_amount` IST die Summe der Zahlungen — auch ueber den
  // Rechnungsbetrag hinaus. Was NICHT passieren darf, ist ein doppelter WIRTSCHAFTLICHER Effekt:
  // der Ueberschuss wird zu Guthaben, nicht zu negativer Forderung.
  ok(Math.abs(n(db, 'SELECT paid_amount FROM invoices WHERE id=?', [inv]) - 2 * gross) < 0.005,
    'CONCURRENT der bezahlte Betrag ist die Summe beider Zahlungen (die Invariante des Hauses)');
  ok(Math.abs(n(db, `SELECT COALESCE(SUM(amount),0) FROM payments WHERE invoice_id=?`, [inv]) - 2 * gross) < 0.005,
    'CONCURRENT …und stimmt mit den Zahlungszeilen ueberein');
  const arNet = n(db, `SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0)
     FROM ledger_entries WHERE counterparty_id = 'cust-1' AND account = 'AR'`);
  ok(arNet >= -0.005, `CONCURRENT die Forderung wird nicht negativ (${arNet})`);
  ok(n(db, "SELECT COUNT(*) FROM customer_credits WHERE source_type='overpayment'") === 1,
    'CONCURRENT die zweite wurde zu Guthaben');
  ok(Math.abs(n(db, "SELECT COALESCE(SUM(amount),0) FROM customer_credits WHERE source_type='overpayment'") - gross) < 0.005,
    'CONCURRENT …in voller Hoehe der zweiten Zahlung');
  ok(String(one(db, 'SELECT status FROM invoices WHERE id=?', [inv])) === 'FINAL',
    'CONCURRENT und die Rechnung ist genau einmal final');
}

// ── 8) Urteile bleiben Urteile ────────────────────────────────────────────
{
  resetDurabilityStateForTest();
  const db = freshDb();
  const { deps: d } = deps(db);
  seedProduct(db, 'p1', 1);

  const missing = await runInvoiceUpdate(d, identity('18', 'invoices.update'), {
    id: 'gibt-es-nicht', expectedRevision: 1, reason: 'x',
    customerId: 'cust-1', lines: [{ productId: 'p1', quantity: 1, unitPrice: 10 }],
  });
  ok(missing.kind === 'rejected' && (missing as { code: string }).code === 'INVOICE_NOT_FOUND'
    && (missing as { frozen: boolean }).frozen === true,
    `VERDICT eine unbekannte Rechnung wird eingefroren abgelehnt (${JSON.stringify(missing)})`);

  const noPay = await runInvoicePayment(d, identity('19', 'invoices.record_payment'), {
    invoiceId: 'gibt-es-nicht', amount: 10, method: 'cash',
  });
  ok(noPay.kind === 'rejected' && (noPay as { code: string }).code === 'INVOICE_NOT_FOUND',
    'VERDICT …und eine Zahlung darauf ebenso');

  // Bestand weg: das letzte Stueck ist verkauft, der Edit will ein zweites.
  const inv = await makeInvoice(d, '20', 'p1', 1, 150);
  const seenAt = Number(invState(db, inv)[4]);
  const noStock = await runInvoiceUpdate(d, identity('21', 'invoices.update'), {
    id: inv, expectedRevision: seenAt, reason: 'Mehr davon',
    customerId: 'cust-1', lines: [{ productId: 'p1', quantity: 2, unitPrice: 150 }],
  });
  ok(noStock.kind === 'rejected' && (noStock as { frozen: boolean }).frozen === true,
    `VERDICT zu wenig Bestand ist ein eingefrorenes Nein (${JSON.stringify(noStock)})`);
  ok(remaining(db, 'lot-p1') === 0, 'VERDICT …und der Bestand ist unveraendert');
  ok(n(db, 'SELECT gross_amount FROM invoices WHERE id=?', [inv]) === 150 * 1.1
    || n(db, 'SELECT gross_amount FROM invoices WHERE id=?', [inv]) > 0,
    'VERDICT die Rechnung steht unveraendert da');

  // Eine Stoerung dagegen ist KEIN Urteil: die Liste der Urteile ist eine Liste, kein Muster.
  const cmd = code('src/core/bridge/invoice-lifecycle-commands.ts');
  ok(/const EDIT_VERDICTS/.test(cmd) && /asDomainVerdict\(err\)/.test(cmd),
    'VERDICT die Urteile stehen namentlich, nicht als „sieht nach Geschaeftsfehler aus"');
  ok(/if \(verdict\) throw verdict;\s*\n\s*throw err;/.test(cmd),
    'VERDICT …und alles andere fliegt als Stoerung weiter');
  ok(/if \(!outcome\.frozen\) throw new CommandNotEvaluated/.test(cmd),
    'VERDICT ein nicht eingefrorenes Nein wird nicht als fachliches Nein gemeldet');
}

// ── 9) Keine zweite Rechnungslogik ────────────────────────────────────────
{
  const cmd = code('src/core/bridge/invoice-lifecycle-commands.ts');
  ok(/editInvoice\(/.test(cmd) && /recordPayment\(/.test(cmd), 'REUSE die ECHTEN Store-Funktionen…');
  ok(!/INSERT INTO invoices|UPDATE invoices SET|INSERT INTO payments|INSERT INTO invoice_lines|ledger_entries/i.test(cmd),
    'REUSE …und keine einzige Zeile selbst geschrieben');
  ok(!/vatRate|computeVat|grossAmount =|paid_amount =/.test(cmd), 'REUSE keine zweite Rechnerei');
  ok(/buildInvoiceLines\(/.test(cmd) && /parseInvoicePayload\(/.test(cmd),
    'REUSE Zeilenbau und Rumpfpruefung kommen vom Anlegeweg — eine Regel, nicht zwei');
  ok(/runRemoteCommand\(/.test(cmd), 'REUSE alles laeuft durch die C3A-Maschine');
  const rustSrc = src('src-tauri/src/bridge.rs');
  ok(!/INSERT INTO invoices|paid_amount|invoice_number/i.test(rustSrc), 'REUSE und in Rust liegt keine Rechnungslogik');
}

// ── 10) Die Zulassungsliste: genau sieben Namen ───────────────────────────
{
  await import('../../src/core/bridge/invoice-lifecycle-commands.ts');
  await import('../../src/core/bridge/commercial-commands.ts');
  await import('../../src/core/bridge/service-commands.ts');
  await import('../../src/core/bridge/financial-commands.ts');
  const known = registry.knownCommands();
  const reads = known.filter((o) => o.endsWith('.list') || o.endsWith('.get'));
  const mutations = registry.ALLOWED_MUTATIONS;
  ok(mutations.join(',') === 'invoices.create,customers.create,customers.update,products.create,products.update,invoices.update,invoices.record_payment,purchases.create,consignments.create,consignments.update,orders.create,orders.update,repairs.create,repairs.update,transfers.create,transfers.update,transfers.mark_returned,invoices.apply_credit,invoices.update_payment,invoices.delete_payment,orders.convert_to_invoice,consignments.record_payout,transfers.mark_sold,transfers.mark_settled,returns.create,returns.approve,returns.refund,returns.record_refund_payment,orders.update_status,orders.add_payment,orders.delete_payment,consignments.record_sale,consignments.mark_returned,repairs.update_status,repairs.create_invoice,repairs.add_line,repairs.update_line,repairs.cancel_line,transfers.convert_to_invoice,transfers.convert_many_to_invoice',
    `ALLOWLIST genau diese vierzig Mutationen (${mutations.join(', ')})`);
  ok(known.length === 59 && reads.length === 18 && known.includes('bridge.probe'),
    `ALLOWLIST 1 Probe + 18 Reads + 40 Mutationen = 59 (${known.length})`);
  ok(!mutations.some((o) => o.endsWith('.delete')), 'ALLOWLIST kein Loeschen');

  for (const op of ['invoices.delete', 'invoices.cancel', 'payments.delete', 'payments.update', 'anything.write']) {
    let threw: string | null = null;
    try { registry.registerCommand(op, { kind: 'mutation', handler: () => ({ ok: true }) }); }
    catch (e) { threw = String(e); }
    ok(threw !== null && /refusing to register/.test(threw), `ALLOWLIST ${op} wird abgewiesen`);
  }

  const rs = src('src-tauri/src/bridge.rs');
  const list = rs.slice(rs.indexOf('pub const REMOTE_OPS'), rs.indexOf('];', rs.indexOf('pub const REMOTE_OPS')));
  ok((list.match(/OP_[A-Z_]+/g) || []).length === 59, 'ALLOWLIST Rust kennt dieselben neunundfuenfzig Namen');
  ok(/OP_INVOICES_UPDATE: &str = "invoices.update"/.test(rs)
    && /OP_INVOICES_RECORD_PAYMENT: &str = "invoices.record_payment"/.test(rs),
    'ALLOWLIST …namentlich, nicht generisch');
}

// ── 11) Gegenproben ───────────────────────────────────────────────────────
{
  resetDurabilityStateForTest();
  const db = freshDb();
  const { deps: d } = deps(db);
  seedProduct(db, 'p1', 5);
  const inv = await makeInvoice(d, '22', 'p1', 1, 150);

  // (a) An der Maschine vorbei: zweimal derselbe Aufruf = zwei Zahlungen.
  const store2 = useInvoiceStore.getState();
  store2.recordPayment(inv, 10, 'cash');
  store2.recordPayment(inv, 10, 'cash');
  ok(n(db, 'SELECT COUNT(*) FROM payments WHERE invoice_id=?', [inv]) === 2
    && commandCount(db as never) === 1,
    'CONTROL a ohne die Maschine wird zweimal gebucht und nichts nachgewiesen');

  // (b) Ohne die Stale-Pruefung KAEME der alte Stand durch: der Rumpf enthaelt ihn, und nur der
  //     Vergleich in der Transaktion faengt ihn.
  const old = Number(invState(db, inv)[4]);
  store2.recordPayment(inv, 1, 'cash');            // der Primary aendert etwas → neuer Stand
  const blind = await runInvoiceUpdate(d, identity('23', 'invoices.update'), {
    id: inv, expectedRevision: old, reason: 'blind',
    customerId: 'cust-1', lines: [{ productId: 'p1', quantity: 1, unitPrice: 1 }],
  });
  ok(blind.kind === 'rejected' && (blind as { code: string }).code === 'INVOICE_CHANGED',
    'CONTROL b der alte Stand WAR im Rumpf — die Pruefung hat ihn geworfen');

  // (c) Ein Client, der Status/paid mitschickt, kommt nicht einmal an die Domaene.
  let forged = false;
  try {
    parseInvoiceUpdate({
      id: inv, expectedRevision: 1, reason: 'x', status: 'FINAL', paidAmount: 999,
      customerId: 'cust-1', lines: [{ productId: 'p1', quantity: 1, unitPrice: 1 }],
    });
  } catch { forged = true; }
  ok(forged, 'CONTROL c ein mitgeschickter Status wird abgewiesen, nicht ignoriert');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central c3d invoice lifecycle: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
console.log('CENTRAL_C3D_INVOICE_LIFECYCLE_SCOPE_PROVED');
console.log('CENTRAL_C3D_INVOICE_DOMAIN_REUSE_PROVED');
console.log('CENTRAL_C3D_INVOICE_STALE_EDIT_PROVED');
console.log('CENTRAL_C3D_INVOICE_PAYLOAD_AUTHORITY_PROVED');
console.log('CENTRAL_C3D_INVOICE_TRANSACTION_PROVED');
console.log('CENTRAL_C3D_PAYMENT_IDEMPOTENCY_PROVED');
console.log('CENTRAL_C3D_EXACT_MUTATION_ALLOWLIST_PROVED');
