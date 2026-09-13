// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6E — der Rechnungs-Lebenszyklus am Verkauf: anlegen MIT Zahlung, die
// Schlusszahlung mit Sondernummer, der Butterfly-Schalter — EINE Hausfolge für Primary und PC2.
// Run: node test/r6e/invoice-lifecycle-parity.test.ts
//
// Gefahren werden die ECHTEN Hausfolgen (`invoice-create-house`, `invoice-payment-house`,
// `invoice-flag-house`), die echten Primary-Anschlüsse (`…OnPrimary` → `runOnPrimary`), die echten
// Store-Funktionen (`createDirectInvoice`, `recordPayment`), die echte C3A-Maschine mit durablem
// Nachweis und das echte Schema samt Hauptbuch. Gestellt sind nur das Speichern und — im
// Client-Abschnitt — das Netz.
//
//   §1 Umfang   §2 anlegen + zahlen: Primary == PC2   §3 verlorene Antwort   §4 Fehlerinjektion
//   §5 Sicherheit (anlegen)   §6 Sondernummer   §7 Butterfly   §8 Client   §9 Oberfläche
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
  // Abgleich eingeschaltet: `trackUpdate`/`trackChange` schreiben ins Änderungsprotokoll — messbar.
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
const { COMMAND_LEDGER_DDL, COMMAND_LEDGER_INDEX, lookupCommand } = await import('../../src/core/bridge/command-ledger.ts');
const { resetDurabilityStateForTest } = await import('../../src/core/bridge/durability-state.ts');
const { resetTransactionHealthForTest } = await import('../../src/core/db/transaction-health.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const { applyMediaSchema } = await import('../../src/core/db/media-schema.ts');
const registry = await import('../../src/core/bridge/command-registry.ts');
const perms = await import('../../src/core/bridge/command-permissions.ts');
const invCmd = await import('../../src/core/bridge/invoice-command.ts');
const life = await import('../../src/core/bridge/invoice-lifecycle-commands.ts');
const flag = await import('../../src/core/bridge/invoice-flag-commands.ts');
const createHouse = await import('../../src/core/invoices/invoice-create-house.ts');
const payHouse = await import('../../src/core/invoices/invoice-payment-house.ts');
const flagHouse = await import('../../src/core/invoices/invoice-flag-house.ts');
const { toInvoiceLine } = await import('../../src/core/invoices/line-derivation.ts');
const { formatInvoiceDisplay } = await import('../../src/core/utils/invoiceNumber.ts');
const { useInvoiceStore } = await import('../../src/stores/invoiceStore.ts');
const { runSharedWrite } = await import('../../src/core/data/shared-write.ts');
const { CommandSaveController } = await import('../../src/core/bridge/client-command-save.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const marker = (m: string): void => { if (fails.length === 0) console.log(m); };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const codeOf = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const S = (v: unknown): string => JSON.stringify(v);
const NOW = '2026-09-13T10:00:00.000Z';

interface Db {
  run(sql: string, p?: unknown[]): unknown;
  exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
  export(): Uint8Array;
}
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const n = (db: Db, sql: string, p: unknown[] = []): number => Number(one(db, sql, p) ?? 0);
const rows = (db: Db, sql: string, p: unknown[] = []): Array<Record<string, unknown>> => {
  const r = db.exec(sql, p)[0];
  return r ? r.values.map((v) => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))) : [];
};

function realMigrations(): string[] {
  const dbSrc = src('src/core/db/database.ts');
  const start = dbSrc.indexOf('const migrations: string[] = [');
  const end = dbSrc.indexOf('\n  ];', start);
  return [...dbSrc.slice(start, end).matchAll(/`([^`]*)`/g)].map((m) => m[1]);
}
const MIGRATIONS = realMigrations();

/** Eine Zeile mit allen NOT-NULL-Spalten, damit ein Test nicht an einer Schema-Kleinigkeit scheitert. */
function insert(db: Db, table: string, values: Record<string, unknown>): void {
  const cols = rows(db, `PRAGMA table_info(${table})`);
  const data: Record<string, unknown> = { ...values };
  for (const c of cols) {
    const name = String(c.name);
    if (!c.notnull || c.dflt_value !== null || c.pk || data[name] !== undefined) continue;
    const t = String(c.type || '').toUpperCase();
    data[name] = /INT|REAL|NUM/.test(t) ? 0 : (/_at$|date/i.test(name) ? NOW : '');
  }
  const use = Object.keys(data).filter((k) => cols.some((c) => c.name === k));
  db.run(`INSERT INTO ${table} (${use.join(', ')}) VALUES (${use.map(() => '?').join(', ')})`, use.map((k) => data[k]));
}

function freshDb(): Db {
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  const db = new SQL.Database() as unknown as Db;
  db.run(src('src/core/db/schema.sql'));
  for (const stmt of MIGRATIONS) { try { db.run(stmt); } catch { /* schon da */ } }
  for (const stmt of A1_UPGRADE_SQL) { try { db.run(stmt); } catch { /* schon da */ } }
  db.run(COMMAND_LEDGER_DDL);
  db.run(COMMAND_LEDGER_INDEX);
  for (const [id, name] of [['branch-main', 'Haupt'], ['branch-other', 'Andere']]) {
    db.run('INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES (?,?,?,?,?)', [id, 'tenant-1', name, NOW, NOW]);
  }
  for (const [id, branch] of [['cat-w', 'branch-main'], ['cat-f', 'branch-other']]) {
    db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES (?,?,?,'w','#000',?,?)", [id, branch, id, NOW, NOW]);
  }
  insert(db, 'customers', { id: 'cust-1', branch_id: 'branch-main', first_name: 'Ali', last_name: 'Hassan', created_at: NOW, updated_at: NOW });
  insert(db, 'customers', { id: 'cust-x', branch_id: 'branch-other', first_name: 'Otto', last_name: 'Other', created_at: NOW, updated_at: NOW });
  insert(db, 'employees', { id: 'emp-1', branch_id: 'branch-main', name: 'Emma', employment_status: 'active', created_at: NOW, updated_at: NOW });
  insert(db, 'employees', { id: 'emp-x', branch_id: 'branch-other', name: 'Erik', employment_status: 'active', created_at: NOW, updated_at: NOW });
  for (const [id, branch, cat, tax] of [['p1', 'branch-main', 'cat-w', 'VAT_10'], ['p2', 'branch-main', 'cat-w', 'MARGIN'],
    ['p-foreign', 'branch-other', 'cat-f', 'VAT_10']]) {
    db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
        scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
        tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
      VALUES (?,?,?,'Rolex',?,?,20,'Pre-Owned','[]',100,'BHD',150,'in_stock',?,0,'[]','{}','OWN',?,?)`,
    [id, branch, cat, 'M ' + id, 'SKU-' + id, tax, NOW, NOW]);
    db.run(`INSERT INTO stock_lots (id, branch_id, product_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
      VALUES (?,?,?,100,20,20,'ACTIVE',?,?)`, ['lot-' + id, branch, id, NOW, NOW]);
  }
  applyMediaSchema(db as never);
  setTestDatabase(db as never);
  useInvoiceStore.getState().loadInvoices();
  return db;
}

const ID = (k: number): string => `${String(k).padStart(8, '0')}-0000-4000-8000-000000000000`;
let seqNo = 0;
const nextId = (): string => ID(++seqNo);
const identity = (commandId: string, op: string, branchId = 'branch-main', hash = 'h') => ({
  commandId, tenantId: 'tenant-1', branchId, userId: 'user-test', role: 'ADMIN', op, payloadHash: hash,
});
function deps(db: Db) {
  return {
    db: db as never,
    begin: posting.beginLedgerTransaction,
    commit: posting.commitLedgerTransaction,
    rollback: posting.rollbackLedgerTransaction,
    durableSave: async () => { /* gestellt */ },
    now: () => NOW,
  };
}
type Fern = { kind: 'ok' | 'rejected' | 'thrown'; value: Record<string, unknown>; replayed: boolean; code: string; frozen: boolean };
async function fern(fn: () => Promise<{ kind: string; value?: unknown; replayed?: boolean; code?: string; frozen?: boolean }>): Promise<Fern> {
  try {
    const o = await fn();
    return o.kind === 'ok'
      ? { kind: 'ok', value: o.value as Record<string, unknown>, replayed: o.replayed === true, code: '', frozen: false }
      : { kind: 'rejected', code: String(o.code), frozen: o.frozen === true, value: {}, replayed: false };
  } catch (e) {
    return { kind: 'thrown', code: String((e as { code?: unknown }).code ?? (e as Error).message), value: {}, replayed: false, frozen: false };
  }
}
async function primary<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T; code: '' } | { ok: false; code: string; value?: undefined }> {
  try { return { ok: true, value: await fn(), code: '' }; } catch (e) { return { ok: false, code: String((e as { code?: unknown }).code ?? (e as Error).message) }; }
}
function parseMsg(fn: () => unknown): string {
  try { fn(); return ''; } catch (e) { return (e as Error).message; }
}
function wirft(fn: () => unknown): string {
  try { fn(); return ''; } catch (e) { return String((e as { code?: unknown }).code ?? (e as Error).message); }
}

/** Eine Datenbank, die an EINER Stelle scheitert — Fehlerinjektion an echten Wirkungspunkten. */
function faulty(db: Db, pred: (sql: string, p?: unknown[]) => boolean) {
  const f = { armed: true };
  const proxy = new Proxy(db as object, {
    get(t, k) {
      if (k === 'run') {
        return (sql: string, p?: unknown[]) => {
          if (f.armed && pred(sql, p)) throw new Error('INJECTED');
          return (t as Db).run(sql, p);
        };
      }
      const v = (t as Record<string | symbol, unknown>)[k];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  }) as unknown as Db;
  return { db: proxy, f };
}
const ledgerInsertFor = (mod: string) => (sql: string, p?: unknown[]): boolean =>
  /INSERT INTO ledger_entries/.test(sql) && Array.isArray(p) && p.includes(mod);

/** Zeilen ohne Kennungen und Zeitpunkte — vergleichbar zwischen zwei Datenbanken. */
const OHNE = /^(id|invoice_id|related_entity_id|payment_id|source_id|credit_id)$|_at$|_date$/;
const clean = (r: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(r)
  .filter(([k]) => !OHNE.test(k)).sort(([a], [b]) => a.localeCompare(b)));
function snapshot(db: Db) {
  return {
    rows: S({
      invoices: rows(db, 'SELECT * FROM invoices ORDER BY rowid').map(clean),
      lines: rows(db, 'SELECT * FROM invoice_lines ORDER BY rowid').map(clean),
      payments: rows(db, 'SELECT * FROM payments ORDER BY rowid').map(clean),
      expenses: rows(db, 'SELECT * FROM expenses ORDER BY rowid').map(clean),
      credits: rows(db, 'SELECT * FROM customer_credits ORDER BY rowid').map(clean),
      lots: rows(db, 'SELECT id, qty_remaining, status FROM stock_lots ORDER BY id'),
    }),
    ledger: S(rows(db, `SELECT source_module, account, direction, amount, counterparty_type,
        CASE WHEN reverses_entry_id IS NULL THEN 0 ELSE 1 END AS rev
      FROM ledger_entries ORDER BY source_module, account, direction, amount`).map((r) => Object.values(r))),
    seq: seqSig(db),
  };
}
const seqSig = (db: Db): string => S(rows(db, 'SELECT doc_type, next_number FROM document_sequences ORDER BY doc_type'));
const seqOf = (db: Db, t: string): number => n(db, 'SELECT next_number FROM document_sequences WHERE doc_type = ?', [t]);
const lc = (db: Db): number => n(db, 'SELECT COUNT(*) FROM ledger_entries');
const cnt = (db: Db, t: string): number => n(db, `SELECT COUNT(*) FROM ${t}`);
const lotLeft = (db: Db, lot = 'lot-p1'): number => n(db, 'SELECT qty_remaining FROM stock_lots WHERE id = ?', [lot]);
const inv = (db: Db, id: string): Record<string, unknown> => rows(db, 'SELECT * FROM invoices WHERE id = ?', [id])[0] ?? {};
function balanced(db: Db): boolean {
  const t = rows(db, `SELECT transaction_id,
      SUM(CASE WHEN direction = 'DEBIT' THEN CAST(ROUND(amount * 1000) AS INTEGER) ELSE 0 END) AS d,
      SUM(CASE WHEN direction = 'CREDIT' THEN CAST(ROUND(amount * 1000) AS INTEGER) ELSE 0 END) AS c
    FROM ledger_entries GROUP BY transaction_id`);
  return t.length > 0 && t.every((r) => Number(r.d) === Number(r.c));
}

// Die Maske: eine Zeile, wie `toInvoiceLine` sie aus dem gewählten Los rechnet (p1: VAT 10 %, Los-Einstand 100).
const houseLine = (productId = 'p1', lotId = 'lot-p1', unitPrice = 150, scheme: 'VAT_10' | 'MARGIN' | 'ZERO' = 'VAT_10') =>
  toInvoiceLine({ productId, lotId, quantity: 1, unitPrice, costBasis: 100, scheme });
// PC2: derselbe Wunsch, wie die Maske ihn schickt.
const wireLine = (productId = 'p1', lotId = 'lot-p1', unitPrice = 150) => ({ productId, lotId, quantity: 1, unitPrice, scheme: 'auto' });
const body = (extra: Record<string, unknown> = {}) => ({ customerId: 'cust-1', lines: [wireLine()], issuedDate: '2026-09-01', ...extra });
const primaryInput = (extra: Record<string, unknown> = {}) =>
  ({ customerId: 'cust-1', lines: [houseLine()], issuedDate: '2026-09-01', specialMark: false, ...extra }) as never;

async function mkInv(d: ReturnType<typeof deps>, extra: Record<string, unknown> = {}): Promise<string> {
  const o = await invCmd.runInvoiceCreate(d, identity(nextId(), 'invoices.create'), body(extra));
  if (o.kind !== 'ok') throw new Error('setup failed: ' + S(o));
  return String((o.value as Record<string, unknown>).invoiceId);
}
const pay = (d: ReturnType<typeof deps>, b: Record<string, unknown>, cid = nextId(), branchId = 'branch-main') =>
  fern(() => life.runInvoicePayment(d, identity(cid, 'invoices.record_payment', branchId), b));

// ══ §1 — Umfang ═════════════════════════════════════════════════════════════
{
  ok(registry.ALLOWED_MUTATIONS.includes('invoices.set_butterfly') && registry.knownCommands().includes('invoices.set_butterfly'),
    'SCOPE invoices.set_butterfly ist freigegeben und registriert');
  ok(registry.knownCommands().includes('invoices.create') && registry.knownCommands().includes('invoices.record_payment'),
    'SCOPE anlegen und zahlen bleiben DIESELBEN Namen (keine neue Buchung für die Zahlung beim Anlegen)');
  ok(perms.OPERATION_PERMISSIONS['invoices.set_butterfly'] === perms.OPERATION_PERMISSIONS['invoices.update']
    && perms.OPERATION_PERMISSIONS['invoices.set_butterfly'] !== null,
  'SCOPE Butterfly braucht dasselbe Recht wie der Knopf (Rechnungen bearbeiten)');
  ok(!registry.ALLOWED_MUTATIONS.includes('invoices.set_special_mark'),
    'SCOPE die Sondermarke hat KEINEN eigenen Befehl — sie ist eine Wahl der Zahlung, die schließt');
}
marker('CENTRAL_UI_R6E_INVOICE_SCOPE_PROVED');

// ══ §2 — anlegen + zahlen: Primary == PC2 ════════════════════════════════════
{
  // A — Vollzahlung bar mit Sondernummer
  const dbP = freshDb();
  const p = await primary(() => createHouse.createInvoiceOnPrimary(primaryInput({ specialMark: true, payment: { amount: 165, method: 'cash' } })));
  const sP = snapshot(dbP);
  const rowP = rows(dbP, 'SELECT * FROM invoices')[0] ?? {};
  const dbC = freshDb();
  const c = await fern(() => invCmd.runInvoiceCreate(deps(dbC), identity(nextId(), 'invoices.create'),
    body({ specialMark: true, payment: { amount: 165, method: 'cash' } })));
  const sC = snapshot(dbC);
  const rowC = rows(dbC, 'SELECT * FROM invoices')[0] ?? {};
  ok(p.ok && c.kind === 'ok' && sP.rows === sC.rows, `PARITY anlegen + Vollzahlung: dieselben Zeilen (Rechnung, Positionen, Zahlung, Lose) (${p.code}/${c.code})`);
  ok(sP.ledger === sC.ledger && sP.ledger.includes('"PAYMENT"') && sP.ledger.includes('"INVOICE"') && balanced(dbP) && balanced(dbC),
    `LEDGER dieselben Buchungen (Rechnung + Zahlung), ausgeglichen (${sP.ledger})`);
  ok(sP.seq === sC.seq, `COUNTER dieselben Zähler (${sP.seq})`);
  ok(rowP.status === 'FINAL' && /^SINV-/.test(String(rowP.invoice_number)) && /000001$/.test(String(rowP.invoice_number))
    && Number(rowP.special_mark) === 1 && Number(rowP.paid_amount) === 165 && rowC.invoice_number === rowP.invoice_number,
  `FINAL Vollzahlung schließt: Endnummer aus dem Sonderkreis, Marke gesetzt (${String(rowP.invoice_number)})`);
  ok(cnt(dbP, 'payments') === 1 && lotLeft(dbP) === 19 && cnt(dbC, 'payments') === 1 && lotLeft(dbC) === 19, 'STOCK ein Stück verbraucht, eine Zahlung');
  const v = c.value;
  ok(v.invoiceNumber === rowC.invoice_number && v.status === 'FINAL' && v.paidAmount === 165 && v.specialMark === true
    && typeof v.paymentId === 'string' && v.revision === Number(rowC.revision) && v.grossAmount === 165,
  `RESULT die Antwort nennt Nummer, Status, Bezahltes, Marke, Fassung und Zahlung des Primary (${S(v)})`);
  ok(p.ok && p.value.invoiceNumber === rowP.invoice_number && p.value.status === 'FINAL', 'RESULT der Primary-Anschluss meldet dasselbe');
  ok(rowP.created_by === 'user-test' && rowC.created_by === 'user-test', 'ACTOR Benutzer vermerkt (Sitzung des Primary — siehe Bericht)');

  // B — Teilzahlung Karte (Amex): Kartengebühr als Auto-Ausgabe, Rechnung bleibt PARTIAL
  const dbP2 = freshDb();
  const p2 = await primary(() => createHouse.createInvoiceOnPrimary(primaryInput({ payment: { amount: 50, method: 'card', cardBrand: 'amex' } })));
  const sP2 = snapshot(dbP2);
  const eP = rows(dbP2, 'SELECT * FROM expenses')[0] ?? {};
  const dbC2 = freshDb();
  const c2 = await fern(() => invCmd.runInvoiceCreate(deps(dbC2), identity(nextId(), 'invoices.create'),
    body({ payment: { amount: 50, method: 'card', cardBrand: 'amex' } })));
  const sC2 = snapshot(dbC2);
  ok(p2.ok && c2.kind === 'ok' && sP2.rows === sC2.rows && sP2.ledger === sC2.ledger && sP2.seq === sC2.seq,
    `PARITY Teilzahlung Karte: Zeilen, Buchungen, Zähler gleich (${c2.code})`);
  ok(c2.value.status === 'PARTIAL' && /^PINV-/.test(String(c2.value.invoiceNumber)) && c2.value.paidAmount === 50
    && eP.category === 'CardFees' && Number(eP.amount) > 0 && eP.related_module === 'invoice' && sP2.ledger.includes('"EXPENSE"') && balanced(dbP2) && balanced(dbC2),
  `CARDFEE die Gebühr ist eine Auto-Ausgabe mit Buchung; die Rechnung bleibt PARTIAL (${String(eP.amount)})`);
  const payRow = rows(dbC2, 'SELECT method, card_brand, amount FROM payments')[0] ?? {};
  ok(payRow.method === 'card' && payRow.card_brand === 'amex' && Number(payRow.amount) === 50, 'CARDFEE Marke und Betrag der Zahlung wie eingegeben');

  // C — ohne Zahlung: wie bisher
  const dbP3 = freshDb();
  const p3 = await primary(() => createHouse.createInvoiceOnPrimary(primaryInput()));
  const sP3 = snapshot(dbP3);
  const dbC3 = freshDb();
  const c3 = await fern(() => invCmd.runInvoiceCreate(deps(dbC3), identity(nextId(), 'invoices.create'), body()));
  const sC3 = snapshot(dbC3);
  ok(p3.ok && c3.kind === 'ok' && sP3.rows === sC3.rows && sP3.ledger === sC3.ledger && cnt(dbC3, 'payments') === 0
    && c3.value.status === 'PARTIAL' && c3.value.paidAmount === 0 && c3.value.paymentId === undefined,
  'PARITY ohne Zahlung: PARTIAL mit 0 bezahlt, keine Zahlung — unverändert');
}

// ══ §3 — verlorene Antwort ═══════════════════════════════════════════════════
{
  const db = freshDb();
  const d = deps(db);
  const seqVor = seqSig(db);
  const idA = nextId();
  const payload = body({ specialMark: true, payment: { amount: 165, method: 'cash' } });
  const a = await fern(() => invCmd.runInvoiceCreate(d, identity(idA, 'invoices.create'), payload));
  const nach = { i: cnt(db, 'invoices'), p: cnt(db, 'payments'), l: lc(db), s: cnt(db, 'sync_changelog'), q: seqSig(db), lot: lotLeft(db) };
  const b = await fern(() => invCmd.runInvoiceCreate(d, identity(idA, 'invoices.create'), payload));
  ok(a.kind === 'ok' && b.kind === 'ok' && b.replayed && b.value.invoiceId === a.value.invoiceId && b.value.invoiceNumber === a.value.invoiceNumber
    && b.value.paymentId === a.value.paymentId,
  'LOST dieselbe Kennung: als Wiederholung erkannt, dieselbe Rechnung, dieselbe Nummer, dieselbe Zahlung');
  ok(S({ i: cnt(db, 'invoices'), p: cnt(db, 'payments'), l: lc(db), s: cnt(db, 'sync_changelog'), q: seqSig(db), lot: lotLeft(db) }) === S(nach)
    && nach.i === 1 && nach.p === 1 && nach.lot === 19,
  'LOST genau eine Rechnung, eine Zahlung, eine Buchungsfolge, ein Bestandsabzug, kein zweiter Abgleich');
  ok(seqVor !== nach.q && S(rows(db, "SELECT doc_type FROM document_sequences WHERE doc_type IN ('PINV','SINV') ORDER BY doc_type")) === S([{ doc_type: 'PINV' }, { doc_type: 'SINV' }])
    && seqOf(db, 'PINV') === 2 && seqOf(db, 'SINV') === 2,
  `LOST je Kreis genau EINE Nummer verbraucht (PINV beim Anlegen, SINV beim Schließen) (${nach.q})`);
}

// ══ §4 — Fehlerinjektion: nichts bleibt halb ════════════════════════════════
{
  const faelle: Array<[string, (sql: string, p?: unknown[]) => boolean, Record<string, unknown>]> = [
    ['Buchung der Zahlung', ledgerInsertFor('PAYMENT'), { amount: 165, method: 'cash' }],
    ['Zahlungszeile', (sql) => /INSERT INTO payments/.test(sql), { amount: 165, method: 'cash' }],
    ['Endnummer/Stand der Rechnung', (sql) => /UPDATE invoices SET paid_amount/.test(sql), { amount: 165, method: 'cash' }],
    ['Buchung der Rechnung (von createDirectInvoice verschluckt)', ledgerInsertFor('INVOICE'), { amount: 165, method: 'cash' }],
    ['Buchung der Kartengebühr (von bookCardFee verschluckt)', ledgerInsertFor('EXPENSE'), { amount: 60, method: 'card' }],
  ];
  for (const [was, pred, zahlung] of faelle) {
    const dbF = freshDb();
    const seqVor = seqSig(dbF);
    const { db: bad } = faulty(dbF, pred);
    setTestDatabase(bad as never);
    const idF = nextId();
    const f1 = await fern(() => invCmd.runInvoiceCreate(deps(bad), identity(idF, 'invoices.create'), body({ specialMark: true, payment: zahlung })));
    const f2 = await primary(() => createHouse.createInvoiceOnPrimary(primaryInput({ specialMark: true, payment: zahlung })));
    setTestDatabase(dbF as never);
    ok(f1.kind === 'thrown' && !f2.ok && cnt(dbF, 'invoices') === 0 && cnt(dbF, 'invoice_lines') === 0 && cnt(dbF, 'payments') === 0
      && cnt(dbF, 'expenses') === 0 && lc(dbF) === 0 && lotLeft(dbF) === 20 && seqSig(dbF) === seqVor
      && lookupCommand(dbF as never, identity(idF, 'invoices.create')).kind === 'fresh',
    `ATOMIC Fehler bei „${was}": keine Rechnung, keine Zahlung, kein Bestandsabzug, keine Nummer verbraucht, Kennung frei — fern UND am Primary (${f1.code} / ${f2.code})`);
  }
}
marker('CENTRAL_UI_R6E_INVOICE_CREATE_ATOMIC_PROVED');

// ══ §5 — Sicherheit beim Anlegen ═════════════════════════════════════════════
{
  const base = body({ payment: { amount: 10, method: 'cash' } });
  for (const k of ['paidAmount', 'status', 'invoiceNumber', 'grossAmount', 'vatAmount', 'branchId', 'userId']) {
    ok(/the primary decides/.test(parseMsg(() => invCmd.parseInvoiceCreatePayload({ ...base, [k]: 1 }))), `PAYLOAD anlegen: ${k} bestimmt der Primary`);
  }
  for (const k of ['paidAmount', 'status', 'invoiceNumber', 'paymentId', 'specialMarkOnFinal', 'specialMark', 'fee', 'ledger']) {
    ok(/the primary decides .*\(payment\)/.test(parseMsg(() => invCmd.parseInvoiceCreatePayload({ ...base, payment: { amount: 10, method: 'cash', [k]: 1 } }))),
      `PAYLOAD Zahlung: ${k} bestimmt der Primary`);
  }
  ok(/unknown field in payment/.test(parseMsg(() => invCmd.parseInvoiceCreatePayload({ ...base, payment: { amount: 10, method: 'cash', tip: 1 } }))),
    'PAYLOAD Zahlung: ein unbekanntes Feld wird abgewiesen');
  for (const method of ['credit', 'bitcoin', 'other', '', undefined]) {
    ok(parseMsg(() => invCmd.parseInvoiceCreatePayload({ ...base, payment: { amount: 10, method } })) !== '',
      `PAYLOAD Zahlung: Weg ${S(method)} abgewiesen (die Maske bietet Cash/Bank/Card/Benefit)`);
  }
  for (const amount of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, '10', null]) {
    ok(parseMsg(() => invCmd.parseInvoiceCreatePayload({ ...base, payment: { amount, method: 'cash' } })) !== '', `PAYLOAD Zahlung: Betrag ${String(amount)} abgewiesen`);
  }
  ok(parseMsg(() => invCmd.parseInvoiceCreatePayload({ ...base, payment: 'cash' })) !== ''
    && parseMsg(() => invCmd.parseInvoiceCreatePayload({ ...base, payment: { amount: 10, method: 'card', cardBrand: 'visa' } })) !== '',
  'PAYLOAD Zahlung: kein Objekt / unbekannte Kartenmarke abgewiesen');
  const okWish = invCmd.parseInvoiceCreatePayload({ ...base, payment: { amount: 12.5, method: 'card', cardBrand: 'amex' } });
  ok(okWish.payment?.amount === 12.5 && okWish.payment?.method === 'card' && okWish.payment?.cardBrand === 'amex', 'PAYLOAD eine gültige Zahlung kommt durch');
  ok(parseMsg(() => life.parseInvoiceUpdate({ id: 'i1', expectedRevision: 1, reason: 'x', ...body(), payment: { amount: 1, method: 'cash' } })) !== '',
    'PAYLOAD invoices.update kennt `payment` weiterhin nicht (eine Zahlung ist dort kein Feld)');

  const db = freshDb();
  const d = deps(db);
  const seqVor = seqSig(db);
  const cases: Array<[string, Record<string, unknown>, string, string?]> = [
    ['ein Kunde einer fremden Filiale', body({ customerId: 'cust-x', payment: { amount: 10, method: 'cash' } }), createHouse.CUSTOMER_NOT_FOUND],
    ['ein unbekannter Kunde', body({ customerId: 'cust-none', payment: { amount: 10, method: 'cash' } }), createHouse.CUSTOMER_NOT_FOUND],
    ['ein Artikel einer fremden Filiale', body({ lines: [wireLine('p-foreign', 'lot-p-foreign')], payment: { amount: 10, method: 'cash' } }), createHouse.PRODUCT_NOT_FOUND],
    ['ein Mitarbeiter einer fremden Filiale', body({ staffId: 'emp-x' }), createHouse.EMPLOYEE_NOT_FOUND],
    ['eine Überzahlung beim Anlegen', body({ payment: { amount: 165.001, method: 'cash' } }), createHouse.PAYMENT_EXCEEDS_TOTAL],
    ['ein Ausweis einer anderen Filiale', body({ payment: { amount: 10, method: 'cash' } }), 'BRANCH_MISMATCH', 'branch-other'],
  ];
  for (const [was, b, code, branch] of cases) {
    const r = await fern(() => invCmd.runInvoiceCreate(d, identity(nextId(), 'invoices.create', branch ?? 'branch-main'), b));
    ok(r.kind === 'rejected' && r.frozen && r.code === code && cnt(db, 'invoices') === 0 && cnt(db, 'payments') === 0 && lc(db) === 0
      && lotLeft(db) === 20 && seqSig(db) === seqVor,
    `SECURITY ${was}: ${code}, eingefroren, nichts geschrieben, keine Nummer verbraucht (${r.code})`);
  }
  const over = await primary(() => createHouse.createInvoiceOnPrimary(primaryInput({ payment: { amount: 200, method: 'cash' } })));
  const badMethod = await primary(() => createHouse.createInvoiceOnPrimary(primaryInput({ payment: { amount: 10, method: 'credit' } })));
  const foreignCust = await primary(() => createHouse.createInvoiceOnPrimary(primaryInput({ customerId: 'cust-x' })));
  ok(!over.ok && over.code === createHouse.PAYMENT_EXCEEDS_TOTAL && !badMethod.ok && badMethod.code === createHouse.PAYMENT_METHOD_INVALID
    && !foreignCust.ok && foreignCust.code === createHouse.CUSTOMER_NOT_FOUND && cnt(db, 'invoices') === 0 && seqSig(db) === seqVor,
  `SECURITY am Primary dieselben Regeln (dieselbe Hausfolge) (${over.code}/${badMethod.code}/${foreignCust.code})`);
  const exact = await fern(() => invCmd.runInvoiceCreate(d, identity(nextId(), 'invoices.create'), body({ payment: { amount: 165, method: 'benefit' } })));
  ok(exact.kind === 'ok' && exact.value.status === 'FINAL' && /^INV-/.test(String(exact.value.invoiceNumber)), 'RULE genau der Gesamtbetrag ist erlaubt (Benefit, Normalkreis)');
}
marker('CENTRAL_UI_R6E_INVOICE_CREATE_PAY_PROVED');

// ══ §6 — Sondernummer: der Vertrag der Schlusszahlung ═══════════════════════
{
  const db = freshDb();
  const d = deps(db);
  const sinv0 = seqOf(db, 'SINV');
  const inv0 = seqOf(db, 'INV');
  const i1 = await mkInv(d);
  const a = await pay(d, { invoiceId: i1, amount: 50, method: 'cash', specialMarkOnFinal: true });
  ok(a.kind === 'ok' && a.value.status === 'PARTIAL' && a.value.specialMark === false && /^PINV-/.test(String(a.value.invoiceNumber))
    && Number(inv(db, i1).special_mark) === 0 && seqOf(db, 'SINV') === sinv0,
  'SPECIAL auf einer Teilzahlung bleibt die Wahl ohne Wirkung: Marke unverändert, keine Nummer gezogen (kein Nein)');
  const cidB = nextId();
  const b = await pay(d, { invoiceId: i1, amount: 115, method: 'cash', specialMarkOnFinal: true }, cidB);
  ok(b.kind === 'ok' && b.value.status === 'FINAL' && /^SINV-/.test(String(b.value.invoiceNumber)) && /000001$/.test(String(b.value.invoiceNumber))
    && b.value.specialMark === true && Number(inv(db, i1).special_mark) === 1 && inv(db, i1).invoice_number === b.value.invoiceNumber,
  `SPECIAL die Zahlung, die schließt, zieht die Endnummer aus dem Sonderkreis und ersetzt invoice_number (${String(b.value.invoiceNumber)})`);
  ok(seqOf(db, 'INV') === inv0 && seqOf(db, 'SINV') !== sinv0, 'SPECIAL der normale Kreis (INV) bleibt unberührt');
  ok(formatInvoiceDisplay({ invoiceNumber: String(b.value.invoiceNumber), status: 'FINAL', specialMark: true }) === 'No: .000001',
    'SPECIAL der Punkt ist nur die Anzeige der Marke — die Nummer selbst ist eine echte Belegnummer');
  ok(rows(db, "SELECT new_value FROM audit_log WHERE entity_id = ? AND field_name = 'invoice_number'", [i1]).some((r) => String(r.new_value).includes(String(b.value.invoiceNumber))),
    'SPECIAL der Nummernwechsel steht im Protokoll');
  const vorReplay = { p: cnt(db, 'payments'), q: seqSig(db), l: lc(db) };
  const b2 = await pay(d, { invoiceId: i1, amount: 115, method: 'cash', specialMarkOnFinal: true }, cidB);
  ok(b2.kind === 'ok' && b2.replayed && b2.value.invoiceNumber === b.value.invoiceNumber
    && S({ p: cnt(db, 'payments'), q: seqSig(db), l: lc(db) }) === S(vorReplay),
  'LOST die Wiederholung der Schlusszahlung zieht KEINE zweite Nummer und bucht keine zweite Zahlung');
  const i2 = await mkInv(d);
  const c = await pay(d, { invoiceId: i2, amount: 165, method: 'bank_transfer', specialMarkOnFinal: true });
  ok(c.kind === 'ok' && /^SINV-/.test(String(c.value.invoiceNumber)) && /000002$/.test(String(c.value.invoiceNumber)) && c.value.invoiceNumber !== b.value.invoiceNumber,
    `UNIQUE zwei Sonderrechnungen, zwei verschiedene Nummern (${String(b.value.invoiceNumber)} / ${String(c.value.invoiceNumber)})`);
  const sinvNachZwei = seqOf(db, 'SINV');
  const i3 = await mkInv(d);
  const e = await pay(d, { invoiceId: i3, amount: 165, method: 'cash', specialMarkOnFinal: false });
  ok(e.kind === 'ok' && /^INV-/.test(String(e.value.invoiceNumber)) && e.value.specialMark === false && seqOf(db, 'SINV') === sinvNachZwei,
    `SPECIAL „Normal" zieht aus dem normalen Kreis — der Sonderkreis bleibt unberührt (${String(e.value.invoiceNumber)})`);
  const i4 = await mkInv(d, { specialMark: true });
  ok(Number(inv(db, i4).special_mark) === 1 && /^PINV-/.test(String(inv(db, i4).invoice_number)), 'SPECIAL eine als Sonderrechnung angelegte Teilrechnung trägt die Marke schon (Nummer bleibt PINV)');
  const f = await pay(d, { invoiceId: i4, amount: 165, method: 'cash' });
  ok(f.kind === 'ok' && /^SINV-/.test(String(f.value.invoiceNumber)) && f.value.specialMark === true,
    'SPECIAL ohne Wahl entscheidet die Marke der Rechnung (wie am Primary)');
  const i5 = await mkInv(d, { specialMark: true });
  const g = await pay(d, { invoiceId: i5, amount: 165, method: 'cash', specialMarkOnFinal: false });
  ok(g.kind === 'ok' && /^INV-/.test(String(g.value.invoiceNumber)) && g.value.specialMark === false && Number(inv(db, i5).special_mark) === 0,
    'SPECIAL die Wahl beim Schließen geht der Marke vom Anlegen vor (wie am Primary)');
  const vorH = seqSig(db);
  const h = await pay(d, { invoiceId: i3, amount: 10, method: 'cash', specialMarkOnFinal: true });
  ok(h.kind === 'ok' && h.value.invoiceNumber === e.value.invoiceNumber && h.value.specialMark === false && seqSig(db) === vorH
    && n(db, "SELECT COUNT(*) FROM customer_credits WHERE source_type = 'overpayment' AND source_id = ?", [h.value.paymentId]) === 1,
  'SPECIAL eine Zahlung auf eine schon endgültige Rechnung ändert weder Nummer noch Marke (der Überschuss wird Guthaben)');
  // Reparatur: RPINV → RINV / SRINV
  posting.beginLedgerTransaction();
  const r1 = useInvoiceStore.getState().createDirectInvoice('cust-1', [houseLine('p2', 'lot-p2', 200, 'MARGIN')], undefined, '2026-09-01', 'repair');
  const r2 = useInvoiceStore.getState().createDirectInvoice('cust-1', [houseLine('p2', 'lot-p2', 200, 'MARGIN')], undefined, '2026-09-01', 'repair');
  posting.commitLedgerTransaction();
  const vorR = { s: seqOf(db, 'SINV'), i: seqOf(db, 'INV') };
  const rs = await pay(d, { invoiceId: r1.id, amount: 200, method: 'cash', specialMarkOnFinal: true });
  const rn = await pay(d, { invoiceId: r2.id, amount: 200, method: 'cash', specialMarkOnFinal: false });
  ok(/^RPINV-/.test(r1.invoiceNumber) && rs.kind === 'ok' && /^SRINV-/.test(String(rs.value.invoiceNumber)) && rn.kind === 'ok' && /^RINV-/.test(String(rn.value.invoiceNumber))
    && seqOf(db, 'SINV') === vorR.s && seqOf(db, 'INV') === vorR.i,
  `SPECIAL Reparatur: Sonder → SRINV, normal → RINV; die Verkaufskreise bleiben unberührt (${String(rs.value.invoiceNumber)} / ${String(rn.value.invoiceNumber)})`);
  ok(balanced(db), 'LEDGER jede Zahlung gleicht sich aus');

  // Parität Primary == PC2 (Karte Amex, schließt, Sonderkreis)
  const dbP = freshDb();
  const iP = await mkInv(deps(dbP));
  const pp = await primary(() => payHouse.recordInvoicePaymentOnPrimary({ invoiceId: iP, amount: 165, method: 'card', cardBrand: 'amex', specialMarkOnFinal: true }));
  const sP = snapshot(dbP);
  const dbC = freshDb();
  const iC = await mkInv(deps(dbC));
  const cc = await pay(deps(dbC), { invoiceId: iC, amount: 165, method: 'card', cardBrand: 'amex', specialMarkOnFinal: true });
  const sC = snapshot(dbC);
  ok(pp.ok && cc.kind === 'ok' && sP.rows === sC.rows && sP.ledger === sC.ledger && sP.seq === sC.seq && balanced(dbP) && balanced(dbC),
    `PARITY Schlusszahlung mit Sondernummer: Primary == PC2 (Zeilen, Gebühr, Buchungen, Zähler) (${pp.code}/${cc.code})`);
  ok(pp.ok && pp.value.invoiceNumber === cc.value.invoiceNumber && pp.value.specialMark === true && cc.value.status === 'FINAL'
    && cnt(dbC, 'expenses') === 1, `RESULT beide melden die Nummer des Primary (${String(cc.value.invoiceNumber)})`);

  // Sicherheit
  for (const k of ['invoiceNumber', 'specialMark', 'status', 'paidAmount', 'paymentId', 'revision', 'branchId']) {
    ok(/the primary decides/.test(parseMsg(() => life.parsePaymentPayload({ invoiceId: 'i1', amount: 10, method: 'cash', [k]: 1 }))), `PAYLOAD Zahlung: ${k} bestimmt der Primary`);
  }
  for (const v of ['yes', 1, null]) {
    ok(parseMsg(() => life.parsePaymentPayload({ invoiceId: 'i1', amount: 10, method: 'cash', specialMarkOnFinal: v })) !== '', `PAYLOAD specialMarkOnFinal ${S(v)} ist keine Wahl`);
  }
  const good = life.parsePaymentPayload({ invoiceId: 'i1', amount: 10, method: 'cash', specialMarkOnFinal: true });
  ok(good.specialMarkOnFinal === true && life.parsePaymentPayload({ invoiceId: 'i1', amount: 10, method: 'cash' }).specialMarkOnFinal === undefined,
    'PAYLOAD die Wahl ist optional — ohne sie entscheidet die Marke der Rechnung');
  const dbS = freshDb();
  const dS = deps(dbS);
  insert(dbS, 'invoices', { id: 'inv-x', branch_id: 'branch-other', invoice_number: 'PINV-X', customer_id: 'cust-x', status: 'PARTIAL', gross_amount: 100, net_amount: 100, created_at: NOW, updated_at: NOW });
  const seqS = seqSig(dbS);
  const fx = await pay(dS, { invoiceId: 'inv-x', amount: 100, method: 'cash', specialMarkOnFinal: true });
  const iS = await mkInv(dS);
  const seqS2 = seqSig(dbS);
  const bx = await pay(dS, { invoiceId: iS, amount: 165, method: 'cash', specialMarkOnFinal: true }, nextId(), 'branch-other');
  ok(fx.kind === 'rejected' && fx.frozen && fx.code === payHouse.INVOICE_NOT_FOUND && seqSig(dbS) === seqS2 && seqS !== '' && cnt(dbS, 'payments') === 0
    && bx.kind === 'rejected' && bx.code === 'BRANCH_MISMATCH',
  `SECURITY Rechnung einer fremden Filiale: INVOICE_NOT_FOUND (vorher lief die Zahlung ohne Statuswechsel an ihr vorbei); fremder Ausweis: BRANCH_MISMATCH (${fx.code}/${bx.code})`);
  dbS.run("UPDATE invoices SET status = 'CANCELLED' WHERE id = ?", [iS]);
  const cx = await pay(dS, { invoiceId: iS, amount: 165, method: 'cash', specialMarkOnFinal: true });
  ok(cx.kind === 'rejected' && cx.code === payHouse.INVOICE_CANCELLED && seqSig(dbS) === seqS2, 'SECURITY eine stornierte Rechnung nimmt keine Zahlung (keine Nummer)');

  // Fehlerinjektion an der Schlusszahlung
  for (const [was, pred, method] of [
    ['Buchung der Zahlung', ledgerInsertFor('PAYMENT'), 'cash'],
    ['Buchung der Kartengebühr (vorher verschluckt — Ausgabe ohne Buchung)', ledgerInsertFor('EXPENSE'), 'card'],
    ['Stand/Endnummer der Rechnung', (sql: string) => /UPDATE invoices SET paid_amount/.test(sql), 'cash'],
  ] as Array<[string, (sql: string, p?: unknown[]) => boolean, string]>) {
    const dbF = freshDb();
    const iF = await mkInv(deps(dbF));
    const vor = { q: seqSig(dbF), l: lc(dbF), n: inv(dbF, iF).invoice_number, r: inv(dbF, iF).revision };
    const { db: bad } = faulty(dbF, pred);
    setTestDatabase(bad as never);
    const idF = nextId();
    const f1 = await fern(() => life.runInvoicePayment(deps(bad), identity(idF, 'invoices.record_payment'), { invoiceId: iF, amount: 165, method, specialMarkOnFinal: true }));
    const f2 = await primary(() => payHouse.recordInvoicePaymentOnPrimary({ invoiceId: iF, amount: 165, method, specialMarkOnFinal: true }));
    setTestDatabase(dbF as never);
    ok(f1.kind === 'thrown' && !f2.ok && cnt(dbF, 'payments') === 0 && cnt(dbF, 'expenses') === 0 && lc(dbF) === vor.l && seqSig(dbF) === vor.q
      && inv(dbF, iF).status === 'PARTIAL' && inv(dbF, iF).invoice_number === vor.n && inv(dbF, iF).revision === vor.r
      && lookupCommand(dbF as never, identity(idF, 'invoices.record_payment')).kind === 'fresh',
    `ATOMIC Schlusszahlung, Fehler bei „${was}": keine Zahlung, keine Endnummer verbraucht, Rechnung unverändert — fern UND am Primary (${f1.code}/${f2.code})`);
  }
  ok(perms.OPERATION_PERMISSIONS['invoices.record_payment'] !== null && perms.OPERATION_PERMISSIONS['invoices.record_payment'] !== undefined,
    'AUTH die Nummernwahl hängt am Recht der Zahlung (dasselbe Tor wie der Knopf „Record Payment") — kein erfundenes zweites');
}
marker('CENTRAL_UI_R6E_SPECIAL_NUMBER_CONTRACT_PROVED');

// ══ §7 — Butterfly ═══════════════════════════════════════════════════════════
{
  const syncOf = (db: Db, id: string): number => n(db, "SELECT COUNT(*) FROM sync_changelog WHERE table_name = 'invoices' AND record_id = ?", [id]);
  const dbP = freshDb();
  const iP = await mkInv(deps(dbP));
  const revP = Number(inv(dbP, iP).revision);
  const vorP = { s: syncOf(dbP, iP), l: lc(dbP) };
  const p = await primary(() => flagHouse.setInvoiceButterflyOnPrimary(iP, true, revP));
  const rowP = clean(inv(dbP, iP));
  const dbC = freshDb();
  const d = deps(dbC);
  const iC = await mkInv(d);
  const revC = Number(inv(dbC, iC).revision);
  const vorC = { s: syncOf(dbC, iC), l: lc(dbC) };
  const c = await fern(() => flag.runSetButterfly(d, identity(nextId(), 'invoices.set_butterfly'), { invoiceId: iC, expectedRevision: revC, butterfly: true }));
  const rowC = clean(inv(dbC, iC));
  ok(p.ok && c.kind === 'ok' && S(rowP) === S(rowC) && Number(inv(dbC, iC).butterfly) === 1 && Number(inv(dbP, iP).butterfly) === 1,
    `PARITY Butterfly: Primary == PC2 (${p.code}/${c.code})`);
  ok(Number(inv(dbC, iC).revision) === revC + 1 && Number(inv(dbP, iP).revision) === revP + 1 && c.value.revision === revC + 1 && c.value.changed === true && c.value.butterfly === true,
    'REVISION die Fassung steigt genau um eins (Trigger)');
  ok(lc(dbC) === vorC.l && lc(dbP) === vorP.l && syncOf(dbC, iC) === vorC.s + 1 && syncOf(dbP, iP) === vorP.s + 1
    && inv(dbC, iC).status === 'PARTIAL' && Number(inv(dbC, iC).gross_amount) === 165,
  'EFFECT keine Buchung, kein Geld, kein Status — genau eine Änderung für den Abgleich');

  // verlorene Antwort
  const cid = nextId();
  const rev1 = Number(inv(dbC, iC).revision);
  const a1 = await fern(() => flag.runSetButterfly(d, identity(cid, 'invoices.set_butterfly'), { invoiceId: iC, expectedRevision: rev1, butterfly: false }));
  const nach = { r: Number(inv(dbC, iC).revision), s: syncOf(dbC, iC) };
  const a2 = await fern(() => flag.runSetButterfly(d, identity(cid, 'invoices.set_butterfly'), { invoiceId: iC, expectedRevision: rev1, butterfly: false }));
  ok(a1.kind === 'ok' && a2.kind === 'ok' && a2.replayed && Number(inv(dbC, iC).butterfly) === 0 && nach.r === rev1 + 1
    && S({ r: Number(inv(dbC, iC).revision), s: syncOf(dbC, iC) }) === S(nach),
  'LOST dieselbe Kennung: eine Änderung, eine Fassung, ein Abgleich');
  // alte Fassung
  const stale = await fern(() => flag.runSetButterfly(d, identity(nextId(), 'invoices.set_butterfly'), { invoiceId: iC, expectedRevision: rev1, butterfly: true }));
  ok(stale.kind === 'rejected' && stale.frozen && stale.code === 'RECORD_CHANGED' && Number(inv(dbC, iC).butterfly) === 0 && Number(inv(dbC, iC).revision) === nach.r,
    'STALE eine alte Fassung: RECORD_CHANGED, nichts geschrieben');
  const staleP = await primary(() => flagHouse.setInvoiceButterflyOnPrimary(iC, true, rev1));
  ok(!staleP.ok && staleP.code === 'RECORD_CHANGED', 'STALE am Primary dieselbe Regel');
  // derselbe Wert: nichts zu schreiben
  const same = await fern(() => flag.runSetButterfly(d, identity(nextId(), 'invoices.set_butterfly'), { invoiceId: iC, expectedRevision: nach.r, butterfly: false }));
  ok(same.kind === 'ok' && same.value.changed === false && Number(inv(dbC, iC).revision) === nach.r && syncOf(dbC, iC) === nach.s,
    'NOOP derselbe Wert: keine Fassung verbraucht, kein Abgleich');
  // Regeln der Seite
  dbC.run("UPDATE invoices SET status = 'CANCELLED' WHERE id = ?", [iC]);
  const revX = Number(inv(dbC, iC).revision);
  const canc = await fern(() => flag.runSetButterfly(d, identity(nextId(), 'invoices.set_butterfly'), { invoiceId: iC, expectedRevision: revX, butterfly: true }));
  ok(canc.kind === 'rejected' && canc.code === 'INVOICE_CANCELLED' && Number(inv(dbC, iC).butterfly) === 0, 'RULE eine stornierte Rechnung wird nicht markiert (der Knopf steht dort nicht)');
  insert(dbC, 'invoices', { id: 'inv-x', branch_id: 'branch-other', invoice_number: 'PINV-X', customer_id: 'cust-x', status: 'PARTIAL', gross_amount: 100, created_at: NOW, updated_at: NOW });
  const foreign = await fern(() => flag.runSetButterfly(d, identity(nextId(), 'invoices.set_butterfly'), { invoiceId: 'inv-x', expectedRevision: 1, butterfly: true }));
  const missing = await fern(() => flag.runSetButterfly(d, identity(nextId(), 'invoices.set_butterfly'), { invoiceId: 'nope', expectedRevision: 1, butterfly: true }));
  const iC2 = await mkInv(d);
  const wrongBranch = await fern(() => flag.runSetButterfly(d, identity(nextId(), 'invoices.set_butterfly', 'branch-other'), { invoiceId: iC2, expectedRevision: Number(inv(dbC, iC2).revision), butterfly: true }));
  ok(foreign.code === 'INVOICE_NOT_FOUND' && missing.code === 'INVOICE_NOT_FOUND' && wrongBranch.code === 'BRANCH_MISMATCH'
    && Number(inv(dbC, 'inv-x').butterfly ?? 0) === 0 && Number(inv(dbC, iC2).butterfly) === 0,
  `SECURITY fremde Filiale / unbekannt / fremder Ausweis: nichts markiert (${foreign.code}/${missing.code}/${wrongBranch.code})`);
  // Rumpf
  const okBody = { invoiceId: 'i1', expectedRevision: 3, butterfly: true };
  for (const k of ['status', 'paidAmount', 'invoiceNumber', 'grossAmount', 'specialMark', 'revision', 'branchId', 'notes', 'customerId']) {
    ok(/the primary decides/.test(parseMsg(() => flag.parseSetButterfly({ ...okBody, [k]: 1 }))), `PAYLOAD butterfly: ${k} ist von hier unerreichbar`);
  }
  ok(/unknown field/.test(parseMsg(() => flag.parseSetButterfly({ ...okBody, foo: 1 }))), 'PAYLOAD butterfly: unbekanntes Feld abgewiesen');
  for (const [was, b] of [['Text statt Wahl', { ...okBody, butterfly: 'true' }], ['ohne Fassung', { invoiceId: 'i1', butterfly: true }],
    ['Fassung 0', { ...okBody, expectedRevision: 0 }], ['ohne Rechnung', { expectedRevision: 1, butterfly: true }]] as Array<[string, unknown]>) {
    ok(parseMsg(() => flag.parseSetButterfly(b)) !== '', `PAYLOAD butterfly: ${was} abgewiesen`);
  }
  // Fehlerinjektion
  const dbF = freshDb();
  const iF = await mkInv(deps(dbF));
  const revF = Number(inv(dbF, iF).revision);
  const { db: bad } = faulty(dbF, (sql) => /UPDATE invoices SET butterfly/.test(sql));
  setTestDatabase(bad as never);
  const idF = nextId();
  const f1 = await fern(() => flag.runSetButterfly(deps(bad), identity(idF, 'invoices.set_butterfly'), { invoiceId: iF, expectedRevision: revF, butterfly: true }));
  const f2 = await primary(() => flagHouse.setInvoiceButterflyOnPrimary(iF, true, revF));
  setTestDatabase(dbF as never);
  ok(f1.kind === 'thrown' && !f2.ok && Number(inv(dbF, iF).butterfly) === 0 && Number(inv(dbF, iF).revision) === revF
    && lookupCommand(dbF as never, identity(idF, 'invoices.set_butterfly')).kind === 'fresh',
  'ATOMIC scheitert das Schreiben, bleibt alles wie es war — fern und am Primary, die Kennung bleibt frei');
  ok(!/updateInvoice\(/.test(codeOf(src('src/core/invoices/invoice-flag-house.ts'))) && !/updateInvoice\(/.test(codeOf(src('src/core/bridge/invoice-flag-commands.ts'))),
    'SECURITY das allgemeine updateInvoice (Status, Beträge, Nummer) ist vom Butterfly-Weg aus unerreichbar');
}
marker('CENTRAL_UI_R6E_BUTTERFLY_PROVED');

// ══ §8 — Client: keine lokale Datenbank, der Weg geht über den Primary ═══════
{
  const db = freshDb();
  const iReal = await mkInv(deps(db));
  let touched = 0;
  const counting = new Proxy(db as object, {
    get(t, k) {
      const v = (t as Record<string | symbol, unknown>)[k];
      if (k === 'run' || k === 'exec' || k === 'prepare') return (...a: unknown[]) => { touched++; return (v as (...x: unknown[]) => unknown).apply(t, a); };
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
  setTestDatabase(counting as never);
  store.set('lataif_runtime_mode', 'client');
  store.set('lataif_client_server_url', 'https://primary.local');
  store.set('lataif_client_token', 'tok');
  const calls: Array<{ body: Record<string, unknown> }> = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const b = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ body: b });
    return new Response(JSON.stringify({ ok: true, value: { invoiceId: 'remote-1', invoiceNumber: 'SINV-2026-000009', status: 'FINAL', specialMark: true, replayed: false } }), { status: 200 });
  }) as never;
  try {
    const refusals = [
      wirft(() => createHouse.createInvoiceInHouse(primaryInput({ payment: { amount: 10, method: 'cash' } }), 'branch-main')),
      wirft(() => payHouse.recordInvoicePaymentInHouse({ invoiceId: iReal, amount: 10, method: 'cash', specialMarkOnFinal: true }, 'branch-main')),
      wirft(() => flagHouse.setInvoiceButterflyInHouse(iReal, true, 'branch-main', 1)),
    ];
    const onPrimary = [
      await primary(() => createHouse.createInvoiceOnPrimary(primaryInput())),
      await primary(() => payHouse.recordInvoicePaymentOnPrimary({ invoiceId: iReal, amount: 10, method: 'cash' })),
      await primary(() => flagHouse.setInvoiceButterflyOnPrimary(iReal, true, 1)),
    ];
    ok(refusals.every((x) => x === 'INVOICE_PRIMARY_ONLY') && onPrimary.every((x) => !x.ok && x.code === 'INVOICE_PRIMARY_ONLY') && touched === 0,
      `CLIENT jede Hausfolge und jeder Primary-Anschluss verweigert die lokale Datenbank, bevor er sie anfasst (${S(refusals)}, Zugriffe ${touched})`);
    const lokal = () => { throw new Error('LOCAL CALLED'); };
    const send = <T,>(op: string, remote: () => Record<string, unknown>) =>
      runSharedWrite<T>(true, { local: lokal as never, remote }, new CommandSaveController<Record<string, unknown>>(op).beginAttempt());
    // Die Rümpfe baut DERSELBE Code wie die Masken.
    const zahlung = createHouse.invoiceCreatePaymentBody(165, 'card', 'amex');
    const r1 = await send('invoices.create', () => ({ ...body({ specialMark: true }), ...(zahlung ? { payment: zahlung } : {}) }));
    const r2 = await send('invoices.record_payment', () => payHouse.invoicePaymentBody({ invoiceId: iReal, amount: 165, method: 'cash', specialMarkOnFinal: true }));
    const r3 = await send('invoices.set_butterfly', () => flagHouse.invoiceButterflyBody(iReal, true, 4));
    const byOp = (op: string) => calls.find((x) => x.body.op === op)?.body.payload as Record<string, unknown> | undefined;
    ok(r1.kind === 'ok' && S(byOp('invoices.create')?.payment) === S({ amount: 165, method: 'card', cardBrand: 'amex' }) && byOp('invoices.create')?.specialMark === true,
      `CLIENT anlegen + zahlen: EIN Auftrag mit der Zahlung als Feld (${S(byOp('invoices.create'))})`);
    ok(r2.kind === 'ok' && S(byOp('invoices.record_payment')) === S({ invoiceId: iReal, amount: 165, method: 'cash', specialMarkOnFinal: true }),
      'CLIENT Schlusszahlung: die Nummernwahl reist als Wahl — keine Nummer, keine Marke, kein Status');
    ok(r3.kind === 'ok' && S(byOp('invoices.set_butterfly')) === S({ invoiceId: iReal, expectedRevision: 4, butterfly: true }),
      'CLIENT Butterfly: Rechnung, gesehene Fassung, Wert — nichts sonst');
    ok(createHouse.invoiceCreatePaymentBody(0, 'cash', 'normal') === undefined && S(createHouse.invoiceCreatePaymentBody(5, 'cash', 'amex')) === S({ amount: 5, method: 'cash' }),
      'CLIENT ohne Betrag keine Zahlung; die Kartenmarke nur bei Karte');
    ok(touched === 0, `CLIENT keine einzige lokale Datenbankberührung (${touched})`);
  } finally {
    globalThis.fetch = origFetch;
    store.delete('lataif_runtime_mode');
    store.delete('lataif_client_server_url');
    store.delete('lataif_client_token');
    setTestDatabase(db as never);
  }
}
marker('CENTRAL_UI_R6E_INVOICE_CLIENT_NO_LOCAL_DB_PROVED');

// ══ §9 — Oberfläche: jede Maske ein Anschluss ══════════════════════════════
{
  const ic = codeOf(src('src/pages/invoices/InvoiceCreate.tsx'));
  ok(!/recording a payment while creating an invoice/.test(ic) && /recording a payment while editing an invoice/.test(ic),
    'UI Direct Sale: das ehrliche Nein beim Anlegen mit Zahlung ist weg; im Ändern bleibt es');
  ok(/local: async \(\) => \{\s*const inv = await createInvoiceOnPrimary\(/.test(ic) && !/createDirectInvoice\(|recordPayment\(/.test(ic)
    && /\.\.\.\(zahlung \? \{ payment: zahlung \} : \{\}\)/.test(ic),
  'UI Direct Sale: am Primary EINE Hausfolge (keine zwei losen Store-Aufrufe mehr), fern die Zahlung als Feld');
  const idt = codeOf(src('src/pages/invoices/InvoiceDetail.tsx'));
  const il = codeOf(src('src/pages/invoices/InvoiceList.tsx'));
  ok(!/the special number circle/.test(idt) && !/the special number circle/.test(il), 'UI der Sonderkreis ist auf keiner Seite mehr ein Nein am Client');
  ok((idt.match(/recordInvoicePaymentOnPrimary\(zahlung\)/g) ?? []).length === 1 && (il.match(/recordInvoicePaymentOnPrimary\(zahlung\)/g) ?? []).length === 1
    && /invoicePaymentBody\(zahlung\)/.test(idt) && /invoicePaymentBody\(zahlung\)/.test(il) && /specialMarkOnFinal: specialMark/.test(idt) && /specialMarkOnFinal: specialMark/.test(il),
  'UI Schlusszahlung (Rechnung + Liste): am Primary die Hausfolge, fern die Wahl als Feld');
  ok(!/updateInvoice\(invoice\.id, \{ butterfly/.test(idt) && /w\.ok\('invoices\.set_butterfly'/.test(idt) && /setInvoiceButterflyOnPrimary\(invId, next, fassung\)/.test(idt),
    'UI Butterfly: kein allgemeines updateInvoice mehr, eine eigene Buchung mit Fassung');
  const all = src('src/pages/invoices/InvoiceCreate.tsx') + src('src/pages/invoices/InvoiceDetail.tsx') + src('src/pages/invoices/InvoiceList.tsx')
    + src('src/components/ui/NumberTypeDialog.tsx');
  const hooks = ['data-invoice-pay-amount', 'data-invoice-pay-method', 'data-invoice-pay-card-brand', 'data-invoice-pay-full', 'data-invoice-pay-later',
    'data-invoice-save', 'data-invoice-save-print', 'data-invoice-butterfly', 'data-invoice-list-pay-amount', 'data-invoice-list-pay-method',
    'data-final-number-normal', 'data-final-number-special', 'data-final-number-confirm', 'data-final-number-cancel'];
  const missing = hooks.filter((h) => !all.includes(h));
  ok(missing.length === 0, `UI jede verdrahtete Stelle trägt ihren E2E-Haken (${missing.join(', ') || 'alle'})`);
  const cmds = codeOf(src('src/core/bridge/invoice-command.ts')) + codeOf(src('src/core/bridge/invoice-lifecycle-commands.ts'));
  ok(/createInvoiceInHouse\(/.test(cmds) && /recordInvoicePaymentInHouse\(/.test(cmds) && /setInvoiceButterflyInHouse\(/.test(codeOf(src('src/core/bridge/invoice-flag-commands.ts')))
    && !/useInvoiceStore\.getState\(\)\.(createDirectInvoice|recordPayment)\(/.test(cmds),
  'UI der Fernbefehl ruft DIESELBE Hausfolge wie die Maske — kein zweiter Weg zum Store');
  const houses = ['invoice-create-house', 'invoice-payment-house', 'invoice-flag-house'].map((f) => codeOf(src(`src/core/invoices/${f}.ts`))).join('\n');
  ok(!/'branch-main'/.test(houses) && !/beginLedgerTransaction|commitLedgerTransaction|rollbackLedgerTransaction|saveDatabaseDurably/.test(houses),
    "HOUSE kein stilles 'branch-main', keine eigene Klammer, kein eigenes durables Speichern");
}
marker('CENTRAL_UI_R6E_INVOICE_UI_WIRED_PROVED');

console.log(`\ninvoice-lifecycle-parity: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) {
  for (const f of fails) console.log('  FAIL ' + f);
  process.exit(1);
}
