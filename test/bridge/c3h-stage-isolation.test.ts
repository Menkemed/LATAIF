// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-C3H REVIEW — die zwei Zusagen, die noch keine EIGENE Messung hatten.
// Run: node test/bridge/c3h-stage-isolation.test.ts
//
// Die übrigen Zusagen von C3H sind in `return-chain`, `lifecycle-actions`,
// `client-lifecycle-ui` und dem Zwei-Instanzen-E2E gemessen. Zwei waren es NICHT — sie werden
// hier nachgeholt, jede an echten Zeilen einer echten sql.js-Datenbank:
//
//   1. **Jede Stufe der Rückgabe wirkt GENAU EINMAL.** Bestand, Wareneinsatz und Los gehören zum
//      Anlegen; Gutschrift und Steuerkorrektur zum Genehmigen; Bargeld zum Auszahlen. Keine
//      Stufe wiederholt die Wirkung einer anderen — auch nicht `refundReturn`, das intern
//      genehmigt und auszahlt.
//   2. **Die Sammelrechnung über mehrere Transfers ist ATOMAR.** Ist EINER der genannten
//      Vorgänge stale oder ungültig, wird gar nichts umgewandelt — keine halbe Rechnung, kein
//      halb gebundener Transfer.
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
  // Ohne eingerichteten Abgleich schreibt `trackChange` NICHTS — dann waere die Zusage
  // "die Rueckgabe steht im Aenderungsjournal" gar nicht pruefbar. Also einrichten.
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
const { COMMAND_LEDGER_DDL, COMMAND_LEDGER_INDEX } = await import('../../src/core/bridge/command-ledger.ts');
const { resetDurabilityStateForTest } = await import('../../src/core/bridge/durability-state.ts');
const { resetTransactionHealthForTest } = await import('../../src/core/db/transaction-health.ts');
const { installWriteGuard } = await import('../../src/core/db/write-guard.ts');
const { SKU_SEQUENCES_DDL } = await import('../../src/core/products/sku-sequence.ts');
const ret = await import('../../src/core/bridge/return-commands.ts');
const { runInvoiceCreate } = await import('../../src/core/bridge/invoice-command.ts');
const fin = await import('../../src/core/bridge/financial-commands.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const { useInvoiceStore } = await import('../../src/stores/invoiceStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { useCustomerStore } = await import('../../src/stores/customerStore.ts');
const { useSalesReturnStore } = await import('../../src/stores/salesReturnStore.ts');
const life = await import('../../src/core/bridge/lifecycle-commands.ts');
const cmdS = await import('../../src/core/bridge/service-commands.ts');
const { useAgentStore } = await import('../../src/stores/agentStore.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const codeOf = (p: string): string => src(p).split(/\r?\n/)
  .filter((l) => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')); })
  .join('\n');
const NOW = '2026-09-06T10:00:00.000Z';

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
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES ('cat-w','branch-main','W','w','#000',?,?)", [NOW, NOW]);
  for (const [id, first] of [['cust-1', 'Ali'], ['cust-2', 'Nora']]) {
    db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level,
        preferences, customer_type, sales_stage, created_at, updated_at)
      VALUES (?,'branch-main',?,'Hassan','BH','en',0,'[]','collector','active',?,?)`, [id, first, NOW, NOW]);
  }
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  useProductStore.getState().loadProducts();
  useCustomerStore.getState().loadCustomers();
  useInvoiceStore.getState().loadInvoices();
  useSalesReturnStore.getState().loadReturns();
  useAgentStore.getState().loadAgents();
  useAgentStore.getState().loadTransfers();
  return db;
}

function seedProduct(db: Db, id: string, qty = 3, cost = 100): void {
  db.run(
    `INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
       scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
       tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
     VALUES (?,?,'cat-w','Rolex',?,?,?,'Pre-Owned','[]',?,'BHD',150,'in_stock','VAT_10',0,'[]','{}','OWN',?,?)`,
    [id, 'branch-main', 'M ' + id, 'SKU-' + id, qty, cost, NOW, NOW],
  );
  db.run(
    `INSERT INTO stock_lots (id, branch_id, product_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
     VALUES (?,?,?,?,?,?,'ACTIVE',?,?)`,
    ['lot-' + id, 'branch-main', id, cost, qty, qty, NOW, NOW],
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
const irev = (db: Db, id: string): number => n(db, 'SELECT revision FROM invoices WHERE id = ?', [id]);
const rrev = (db: Db, id: string): number => n(db, 'SELECT revision FROM sales_returns WHERE id = ?', [id]);
const arNet = (db: Db, customerId: string): number => n(db,
  `SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0)
     FROM ledger_entries WHERE account = 'ACCOUNTS_RECEIVABLE' AND counterparty_id = ?`, [customerId]);

async function makeInvoice(d: ReturnType<typeof deps>, nth: string, qty = 1, price = 150) {
  const out = await runInvoiceCreate(d, identity(nth, 'invoices.create'), {
    customerId: 'cust-1', lines: [{ productId: 'p1', quantity: qty, unitPrice: price }],
  });
  if (out.kind !== 'ok') throw new Error('setup failed: ' + JSON.stringify(out));
  return (out as { value: { invoiceId: string } }).value.invoiceId;
}
const lineOf = (db: Db, inv: string): string => s(db, 'SELECT id FROM invoice_lines WHERE invoice_id = ?', [inv]);

// ── 1) Jede Stufe wirkt GENAU EINMAL ─────────────────────────────────────
//
// Gemessen wird nach JEDER Stufe derselbe Satz Zahlen. Was sich bewegen DARF, bewegt sich; alles
// andere muss stehen bleiben. Ein Gate, das nur den Endzustand prüft, sähe eine doppelte
// Bestandsrückgabe nicht, die eine doppelte Entnahme ausgleicht.
{
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  const db = freshDb();
  const d = deps(db);
  seedProduct(db, 'p1', 5, 100);
  const inv = await makeInvoice(d, '1', 1, 150);
  const line = lineOf(db, inv);
  const gross = n(db, 'SELECT gross_amount FROM invoices WHERE id = ?', [inv]);
  useInvoiceStore.getState().loadInvoices();
  useInvoiceStore.getState().recordPayment(inv, gross, 'cash', 'paid in full');

  const snap = () => ({
    qty: n(db, "SELECT quantity FROM products WHERE id = 'p1'"),
    lot: n(db, "SELECT qty_remaining FROM stock_lots WHERE id = 'lot-p1'"),
    cogs: n(db, "SELECT COUNT(*) FROM ledger_entries WHERE account = 'COGS'"),
    cogsNet: n(db, `SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0)
                      FROM ledger_entries WHERE account = 'COGS'`),
    vat: n(db, 'SELECT vat_amount FROM invoices WHERE id = ?', [inv]),
    cash: n(db, `SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0)
                   FROM ledger_entries WHERE account = 'CASH'`),
    cn: n(db, 'SELECT COUNT(*) FROM credit_notes'),
    returns: n(db, 'SELECT COUNT(*) FROM sales_returns'),
  });
  const before = snap();

  // ── Stufe 1: anlegen. Ware und Wareneinsatz — sonst nichts.
  const c = await ret.runCreateReturn(d, identity('2', 'returns.create'), {
    invoiceId: inv, expectedRevision: irev(db, inv),
    lines: [{ invoiceLineId: line, quantity: 1 }], refundMethod: 'cash',
  });
  ok(c.kind === 'ok', 'STAGE-1 die Rueckgabe entsteht');
  const rid = String(val<Record<string, unknown>>(c).returnId);
  const s1 = snap();
  ok(s1.lot === before.lot + 1, `STAGE-1 das Los bekommt GENAU ein Stueck zurueck (${before.lot} → ${s1.lot})`);
  ok(s1.qty === before.qty + 1, `STAGE-1 …und der Bestand folgt (${before.qty} → ${s1.qty})`);
  ok(s1.cogs > before.cogs, 'STAGE-1 der Wareneinsatz wird zurueckgedreht');
  ok(Math.abs(s1.cogsNet) < 0.005, `STAGE-1 …und zwar auf null, nicht darueber hinaus (${s1.cogsNet})`);
  ok(s1.vat === before.vat, 'STAGE-1 die Steuer der Rechnung ist noch UNBERUEHRT — das ist Stufe 2');
  ok(s1.cash === before.cash, 'STAGE-1 …und es floss noch kein Geld — die Gutschrift kommt erst');
  ok(s1.cn === before.cn, 'STAGE-1 …und es gibt noch keine Gutschrift');

  // ── Stufe 2: genehmigen. Gutschrift und Steuer — kein Bestand, kein Geld.
  const a = await ret.runApproveReturn(d, identity('3', 'returns.approve'), { returnId: rid, expectedRevision: rrev(db, rid) });
  ok(a.kind === 'ok', 'STAGE-2 die Genehmigung laeuft');
  const total0 = n(db, 'SELECT total_amount FROM sales_returns WHERE id = ?', [rid]);
  const s2 = snap();
  ok(s2.cn === s1.cn + 1, `STAGE-2 GENAU eine Gutschrift entsteht (${s1.cn} → ${s2.cn})`);
  ok(s2.vat < s1.vat, `STAGE-2 die Steuer wird korrigiert (${s1.vat} → ${s2.vat})`);
  ok(s2.lot === s1.lot, 'STAGE-2 das Los bleibt unangetastet — keine zweite Bestandsrueckgabe');
  ok(s2.qty === s1.qty, 'STAGE-2 …und der Bestand ebenso');
  ok(s2.cogs === s1.cogs, 'STAGE-2 …und KEIN zweiter Wareneinsatz-Storno');
  // Hier faellt die Geldbuchung: die Gutschrift IST die Urkunde ueber den Bar-/Forderungs-Split.
  ok(before.cash - s2.cash <= total0 + 0.005,
    `STAGE-2 die Gutschrift bucht hoechstens den Rueckgabebetrag (${(before.cash - s2.cash).toFixed(3)} von ${total0})`);

  // ── Stufe 3: erstatten. NUR Geld. `refundReturn` genehmigt intern noch einmal — idempotent.
  const total = total0;
  const r = await ret.runRefundReturn(d, identity('4', 'returns.refund'), {
    returnId: rid, amount: total, expectedRevision: rrev(db, rid),
  });
  ok(r.kind === 'ok', 'STAGE-3 die Erstattung laeuft');
  const s3 = snap();
  // Und der eigentliche Schutz: ueber die GANZE Kette bewegte sich der Betrag genau einmal.
  ok(Math.abs(before.cash - s3.cash - total) < 0.005,
    `STAGE-3 ueber die ganze Kette floss GENAU der Rueckgabebetrag (${(before.cash - s3.cash).toFixed(3)} von ${total})`);
  ok(s3.cn === s2.cn, 'STAGE-3 KEINE zweite Gutschrift — die interne Genehmigung ist idempotent');
  ok(s3.vat === s2.vat, 'STAGE-3 …und KEINE zweite Steuerkorrektur');
  ok(s3.lot === s2.lot && s3.qty === s2.qty, 'STAGE-3 …und kein zweites Mal Ware');
  ok(s3.cogs === s2.cogs, 'STAGE-3 …und kein zweiter Wareneinsatz-Storno');
  ok(before.cash - s3.cash < total * 2 - 0.005,
    `STAGE-3 …und ausdruecklich NICHT zweimal (${(before.cash - s3.cash).toFixed(3)}, doppelt waere ${total * 2})`);

  // ── Stufe 4: die Auszahlung buchen. Auf eine erledigte Rueckgabe: ein Urteil, keine Wirkung.
  const p = await ret.runRecordRefundPayment(d, identity('5', 'returns.record_refund_payment'), {
    returnId: rid, amount: total, method: 'cash', expectedRevision: rrev(db, rid),
  });
  ok(p.kind === 'rejected' && code(p) === 'ALREADY_REFUNDED',
    `STAGE-4 eine erledigte Rueckgabe zahlt nicht noch einmal aus (${code(p)})`);
  const s4 = snap();
  ok(s4.cash === s3.cash, 'STAGE-4 …und die Kasse steht');
  ok(s4.cn === s3.cn && s4.vat === s3.vat && s4.lot === s3.lot && s4.cogs === s3.cogs,
    'STAGE-4 …und sonst bewegte sich nichts');
  ok(s4.returns === before.returns + 1, 'STAGE-4 die ganze Kette hinterliess GENAU eine Rueckgabe');
}

// ── 2) Die vierte Stufe als EIGENER Weg — auch dort nur Geld ─────────────
//
// Dieselbe Messung, aber mit `record_refund_payment` statt `refund`: es genehmigt intern
// ebenfalls, wenn noetig, und darf dabei genauso wenig doppelt wirken.
{
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  const db = freshDb();
  const d = deps(db);
  seedProduct(db, 'p1', 5, 100);
  const inv = await makeInvoice(d, '1', 1, 150);
  const line = lineOf(db, inv);
  const gross = n(db, 'SELECT gross_amount FROM invoices WHERE id = ?', [inv]);
  useInvoiceStore.getState().loadInvoices();
  useInvoiceStore.getState().recordPayment(inv, gross, 'cash', 'paid');

  const c = await ret.runCreateReturn(d, identity('2', 'returns.create'), {
    invoiceId: inv, expectedRevision: irev(db, inv),
    lines: [{ invoiceLineId: line, quantity: 1 }], refundMethod: 'cash',
  });
  const rid = String(val<Record<string, unknown>>(c).returnId);
  const lotAfterCreate = n(db, "SELECT qty_remaining FROM stock_lots WHERE id = 'lot-p1'");
  const cogsAfterCreate = n(db, "SELECT COUNT(*) FROM ledger_entries WHERE account = 'COGS'");
  const cashBefore = n(db, `SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0)
                              FROM ledger_entries WHERE account = 'CASH'`);
  const total = n(db, 'SELECT total_amount FROM sales_returns WHERE id = ?', [rid]);

  // Ohne vorherige Genehmigung: der Weg genehmigt selbst — GENAU einmal.
  const p = await ret.runRecordRefundPayment(d, identity('6', 'returns.record_refund_payment'), {
    returnId: rid, amount: total, method: 'cash', expectedRevision: rrev(db, rid),
  });
  ok(p.kind === 'ok', 'PAYOUT die Auszahlung laeuft auch ohne vorherige Genehmigung');
  ok(n(db, 'SELECT COUNT(*) FROM credit_notes WHERE sales_return_id = ?', [rid]) === 1,
    'PAYOUT sie erzeugt GENAU eine Gutschrift');
  ok(n(db, "SELECT qty_remaining FROM stock_lots WHERE id = 'lot-p1'") === lotAfterCreate,
    'PAYOUT und KEIN zweites Mal Ware');
  ok(n(db, "SELECT COUNT(*) FROM ledger_entries WHERE account = 'COGS'") === cogsAfterCreate,
    'PAYOUT …und kein zweiter Wareneinsatz-Storno');
  const cashAfter = n(db, `SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0)
                             FROM ledger_entries WHERE account = 'CASH'`);
  ok(Math.abs(cashBefore - cashAfter - total) < 0.005,
    `PAYOUT und es floss GENAU der Betrag, EINMAL (${(cashBefore - cashAfter).toFixed(3)} von ${total})`);
}

// ── 3) Die Sammelrechnung ist ATOMAR ─────────────────────────────────────
//
// Der Fall, der zaehlt: zwei Vorgaenge in EINEM Rumpf, einer davon stale (oder gar nicht
// umwandelbar). Dann darf NICHTS entstehen — keine Rechnung ueber den einen, keine halbe
// Bindung am anderen.
{
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  const db = freshDb();
  const d = deps(db);
  seedProduct(db, 'p1', 1, 100);
  seedProduct(db, 'p2', 1, 100);
  seedProduct(db, 'p3', 1, 100);
  const mk = async (nth: string, productId: string) => {
    const out = await cmdS.runTransferCreate(d, identity(nth, 'transfers.create'), {
      customerId: 'cust-2', productId, agentPrice: 300, settlementModel: 'full',
    });
    if (out.kind !== 'ok') throw new Error('setup transfer: ' + JSON.stringify(out));
    return String((out as { value: { transferId: string } }).value.transferId);
  };
  const t1 = await mk('1', 'p1');
  const t2 = await mk('2', 'p2');
  const sold = async (nth: string, id: string) => {
    const out = await fin.runMarkSold(d, identity(nth, 'transfers.mark_sold'),
      { transferId: id, salePrice: 400, expectedRevision: n(db, 'SELECT revision FROM agent_transfers WHERE id = ?', [id]) });
    if (out.kind !== 'ok') throw new Error('setup sold: ' + JSON.stringify(out));
  };
  await sold('3', t1);
  await sold('4', t2);
  const rev = (id: string) => n(db, 'SELECT revision FROM agent_transfers WHERE id = ?', [id]);

  // (a) Einer der beiden traegt eine ALTE Fassung.
  const invBefore = n(db, 'SELECT COUNT(*) FROM invoices');
  const stale = await life.runConvertTransfers(d, identity('5', 'transfers.convert_many_to_invoice'), {
    transfers: [{ id: t1, expectedRevision: rev(t1) }, { id: t2, expectedRevision: rev(t2) - 1 }],
    customerId: 'cust-1',
  });
  ok(stale.kind === 'rejected' && code(stale) === 'RECORD_CHANGED',
    `BULK-ATOMIC ein stale Vorgang weist die GANZE Sammelrechnung ab (${code(stale)})`);
  ok(n(db, 'SELECT COUNT(*) FROM invoices') === invBefore,
    'BULK-ATOMIC …und es entstand KEINE Rechnung');
  ok(s(db, 'SELECT invoice_id FROM agent_transfers WHERE id = ?', [t1]) === '',
    'BULK-ATOMIC …auch nicht fuer den gueltigen Vorgang');
  ok(s(db, 'SELECT invoice_id FROM agent_transfers WHERE id = ?', [t2]) === '',
    'BULK-ATOMIC …und der stale ist unveraendert');

  // (b) Einer ist gar nicht umwandelbar (noch draussen).
  const t3 = await mk('6', 'p3');
  ok(s(db, 'SELECT status FROM agent_transfers WHERE id = ?', [t3]) === 'transferred', 'BULK-ATOMIC (Aufbau) t3 ist offen');
  const mixed = await life.runConvertTransfers(d, identity('7', 'transfers.convert_many_to_invoice'), {
    transfers: [{ id: t1, expectedRevision: rev(t1) }, { id: t3, expectedRevision: rev(t3) }],
    customerId: 'cust-1',
  });
  ok(mixed.kind === 'rejected' && code(mixed) === 'TRANSFER_NOT_SOLD',
    `BULK-ATOMIC ein nicht verkaufter Vorgang weist die ganze Rechnung ab (${code(mixed)})`);
  ok(n(db, 'SELECT COUNT(*) FROM invoices') === invBefore, 'BULK-ATOMIC …und wieder entstand nichts');
  ok(s(db, 'SELECT invoice_id FROM agent_transfers WHERE id = ?', [t1]) === '',
    'BULK-ATOMIC …der gueltige Vorgang blieb ungebunden');

  // (c) Und mit zwei gueltigen Vorgaengen entsteht GENAU eine.
  const good = await life.runConvertTransfers(d, identity('8', 'transfers.convert_many_to_invoice'), {
    transfers: [{ id: t1, expectedRevision: rev(t1) }, { id: t2, expectedRevision: rev(t2) }],
    customerId: 'cust-1',
  });
  ok(good.kind === 'ok', `BULK-ATOMIC zwei gueltige ergeben eine Rechnung (${code(good)})`);
  const invId = String(val<Record<string, unknown>>(good).invoiceId);
  ok(n(db, 'SELECT COUNT(*) FROM invoices') === invBefore + 1, 'BULK-ATOMIC …GENAU eine');
  ok(n(db, 'SELECT COUNT(*) FROM invoice_lines WHERE invoice_id = ?', [invId]) === 2,
    'BULK-ATOMIC …mit zwei Zeilen');
  ok(s(db, 'SELECT invoice_id FROM agent_transfers WHERE id = ?', [t1]) === invId
    && s(db, 'SELECT invoice_id FROM agent_transfers WHERE id = ?', [t2]) === invId,
    'BULK-ATOMIC …und beide Vorgaenge tragen sie');

  // Die Prüfung fällt VOR jeder Wirkung — das ist der Grund, warum (a) und (b) nichts hinterliessen.
  const mine = codeOf('src/core/bridge/lifecycle-commands.ts');
  const at = mine.indexOf('export function runConvertTransfers');
  const body = mine.slice(at, at + 1400);
  ok(body.indexOf('assertConvertible') < body.indexOf('convertTransfersToInvoice'),
    'BULK-ATOMIC alle Voraussetzungen werden geprueft, BEVOR irgendetwas laeuft');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central c3h stage isolation + bulk atomicity: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
