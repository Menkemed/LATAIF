// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6E — Angebote: anlegen, als EIN Entwurf speichern, senden / annehmen /
// ablehnen, in eine Rechnung wandeln — EINE Hausfolge für Primary und PC2.
// Run: node test/r6e/offer-parity.test.ts
//
// Gefahren werden die ECHTE Hausfolge (`offer-house.ts`), die echten Primary-Anschlüsse
// (`offer-actions.ts` → `runOnPrimary`), die echte C3A-Maschine mit durablem Nachweis, das echte
// Schema samt Revisions-Triggern und Hauptbuch und — für die Rechnung — der echte
// `createDirectInvoice`. Gestellt sind nur das Speichern und — im Client-Abschnitt — das Netz.
//
//   §1 Umfang   §2 offers.create   §3 offers.update (Fassung)   §4 offers.set_status
//   §5 offers.convert_to_invoice   §6 Client (keine lokale Datenbank)   §7 Oberfläche
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
const { COMMAND_LEDGER_DDL, COMMAND_LEDGER_INDEX, lookupCommand } = await import('../../src/core/bridge/command-ledger.ts');
const { resetDurabilityStateForTest } = await import('../../src/core/bridge/durability-state.ts');
const { resetTransactionHealthForTest } = await import('../../src/core/db/transaction-health.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const house = await import('../../src/core/offers/offer-house.ts');
const rules = await import('../../src/core/offers/offer-rules.ts');
const cmd = await import('../../src/core/bridge/offer-commands.ts');
const actions = await import('../../src/core/offers/offer-actions.ts');
const registry = await import('../../src/core/bridge/command-registry.ts');
const perms = await import('../../src/core/bridge/command-permissions.ts');
await import('../../src/core/bridge/store-read-commands.ts');
// Die alten Ereignis-Handler der Automatisierung sind GELADEN — bewiesen wird, dass trotzdem nichts doppelt passiert.
await import('../../src/core/automation/automation-handlers.ts');
const { useOfferStore, loadOffersFor } = await import('../../src/stores/offerStore.ts');
const { useInvoiceStore } = await import('../../src/stores/invoiceStore.ts');
const { toInvoiceLine } = await import('../../src/core/invoices/line-derivation.ts');
const { runSharedWrite } = await import('../../src/core/data/shared-write.ts');
const { CommandSaveController } = await import('../../src/core/bridge/client-command-save.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const marker = (m: string): void => { if (fails.length === 0) console.log(m); };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const codeOf = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const S = (v: unknown): string => JSON.stringify(v);
const NOW = '2026-09-13T10:00:00.000Z';
const tick = () => new Promise((r) => setTimeout(r, 15));

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
  const db = new SQL.Database() as unknown as Db;
  db.run(src('src/core/db/schema.sql'));
  for (const stmt of MIGRATIONS) { try { db.run(stmt); } catch { /* schon da */ } }
  for (const stmt of A1_UPGRADE_SQL) { try { db.run(stmt); } catch { /* schon da */ } }
  db.run(COMMAND_LEDGER_DDL);
  db.run(COMMAND_LEDGER_INDEX);
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-main','tenant-1','Haupt',?,?)", [NOW, NOW]);
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-other','tenant-1','Andere',?,?)", [NOW, NOW]);
  insert(db, 'customers', { id: 'c1', branch_id: 'branch-main', first_name: 'Maya', last_name: 'Main', created_at: NOW, updated_at: NOW });
  insert(db, 'customers', { id: 'c3', branch_id: 'branch-main', first_name: 'Nora', last_name: 'Next', created_at: NOW, updated_at: NOW });
  insert(db, 'customers', { id: 'c2', branch_id: 'branch-other', first_name: 'Otto', last_name: 'Other', created_at: NOW, updated_at: NOW });
  insert(db, 'customers', { id: 'sys-walkin', branch_id: 'branch-main', first_name: 'Walk', last_name: 'In', created_at: NOW, updated_at: NOW });
  insert(db, 'employees', { id: 'e1', branch_id: 'branch-main', name: 'Emma', employment_status: 'active', created_at: NOW, updated_at: NOW });
  insert(db, 'employees', { id: 'e2', branch_id: 'branch-other', name: 'Erik', employment_status: 'active', created_at: NOW, updated_at: NOW });
  insert(db, 'categories', { id: 'cat-1', branch_id: 'branch-main', name: 'Watches', created_at: NOW, updated_at: NOW });
  const prod = (id: string, branch: string, scheme: string, pp: number) => insert(db, 'products', {
    id, branch_id: branch, category_id: 'cat-1', brand: 'Brand', name: id, sku: `SKU-${id}`, purchase_price: pp,
    planned_sale_price: pp * 2, tax_scheme: scheme, stock_status: 'in_stock', created_at: NOW, updated_at: NOW,
  });
  // p1: Differenzbesteuerung, Einkaufspreis 1000, das offene Los kostet aber 800 — genau hier lag der COGS-Fehler.
  prod('p1', 'branch-main', 'MARGIN', 1000);
  prod('p2', 'branch-main', 'VAT_10', 200);    // ohne Lose (z. B. Leistung) — Einstand aus dem Artikel
  prod('p3', 'branch-main', 'MARGIN', 300);
  prod('p4', 'branch-main', 'MARGIN', 400);    // über Lose geführt, aber keines mehr offen
  prod('px', 'branch-other', 'MARGIN', 100);
  const lot = (id: string, pid: string, qty: number, cost: number, status = 'ACTIVE') => insert(db, 'stock_lots', {
    id, branch_id: 'branch-main', product_id: pid, qty_total: 1, qty_remaining: qty, unit_cost: cost, status,
    acquired_at: '2026-01-01', created_at: NOW,
  });
  lot('L1', 'p1', 1, 800);
  lot('L3', 'p3', 1, 250);
  lot('L4', 'p4', 0, 350, 'EXHAUSTED');
  setTestDatabase(db as never);
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  return db;
}

const ID = (k: number): string => `${String(k).padStart(8, '0')}-0000-4000-8000-000000000000`;
let seq = 0;
const nextId = (): string => ID(++seq);
const identity = (commandId: string, op: string, branchId = 'branch-main', userId = 'user-test', hash = 'h') => ({
  commandId, tenantId: 'tenant-1', branchId, userId, role: 'ADMIN', op, payloadHash: hash,
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
async function fern(fn: () => Promise<{ kind: string; value?: unknown; replayed?: boolean; code?: string; frozen?: boolean }>) {
  try {
    const o = await fn();
    return o.kind === 'ok'
      ? { kind: 'ok' as const, value: o.value as Record<string, unknown>, replayed: o.replayed === true, code: '', frozen: false }
      : { kind: 'rejected' as const, code: String(o.code), frozen: o.frozen === true, value: {} as Record<string, unknown>, replayed: false };
  } catch (e) {
    return { kind: 'thrown' as const, code: String((e as { code?: unknown }).code ?? (e as Error).message), message: (e as Error).message, value: {} as Record<string, unknown>, replayed: false, frozen: false };
  }
}
async function primary<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; code: string }> {
  try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, code: String((e as { code?: unknown }).code ?? (e as Error).message) }; }
}
function wirft(fn: () => unknown): string {
  try { fn(); return ''; } catch (e) { return String((e as { code?: unknown }).code ?? (e as Error).message); }
}
function parseMsg(fn: () => unknown): string {
  try { fn(); return ''; } catch (e) { return (e as Error).message; }
}

/** Eine Datenbank, die an EINER Stelle scheitert — Fehlerinjektion an echten Wirkungspunkten. */
function faulty(db: Db, pattern: RegExp) {
  const f = { armed: true };
  const proxy = new Proxy(db as object, {
    get(t, k) {
      if (k === 'run') {
        return (sql: string, p?: unknown[]) => {
          if (f.armed && pattern.test(sql)) throw new Error('INJECTED at ' + pattern);
          return (t as Db).run(sql, p);
        };
      }
      const v = (t as Record<string | symbol, unknown>)[k];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  }) as unknown as Db;
  return { db: proxy, f };
}

/** Eine Zeile ohne Kennungen und Zeitstempel (Zeitpunkte zählen nur als „gesetzt"). */
function normRow(r: Record<string, unknown> | undefined, drop: RegExp, setOnly: RegExp = /^$/): string {
  return S(Object.fromEntries(Object.entries(r ?? {})
    .filter(([k]) => !drop.test(k))
    .map(([k, v]) => [k, setOnly.test(k) ? (v ? 'set' : null) : v])
    .sort(([a], [b]) => a.localeCompare(b))));
}
const offerSig = (db: Db, id: string): string => normRow(rows(db, 'SELECT * FROM offers WHERE id = ?', [id])[0], /^(id|created_at|updated_at|invoice_id)$/, /^sent_at$/);
const linesSig = (db: Db, id: string): string => S(rows(db, 'SELECT * FROM offer_lines WHERE offer_id = ? ORDER BY position', [id]).map((r) => normRow(r, /^(id|offer_id)$/)));
const prodSig = (db: Db): string => S(rows(db, 'SELECT id, stock_status, last_offer_price FROM products ORDER BY id'));
const taskSig = (db: Db, entity: string): string => S(rows(db,
  'SELECT title, description IS NOT NULL AS d, type, priority, linked_entity_type, auto_generated, status, assigned_to, created_by, due_at IS NOT NULL AS due FROM tasks WHERE linked_entity_id = ? ORDER BY title', [entity]));
const tasksOf = (db: Db, entity: string): number => n(db, 'SELECT COUNT(*) FROM tasks WHERE linked_entity_id = ?', [entity]);
const rev = (db: Db, id: string): number => n(db, 'SELECT revision FROM offers WHERE id = ?', [id]);
const seqOf = (db: Db, type: string): number => n(db, 'SELECT COALESCE(MAX(next_number), 0) FROM document_sequences WHERE doc_type = ?', [type]);
const statusOf = (db: Db, pid: string): string => String(one(db, 'SELECT stock_status FROM products WHERE id = ?', [pid]));
const lc = (db: Db): number => n(db, 'SELECT COUNT(*) FROM ledger_entries');
const ledgerSig = (db: Db, mod: string, id: string): string => S(rows(db,
  `SELECT account, direction, amount, counterparty_type, CASE WHEN reverses_entry_id IS NULL THEN 0 ELSE 1 END AS rev
     FROM ledger_entries WHERE source_module = ? AND source_id = ? ORDER BY rev, account, direction, amount`, [mod, id])
  .map((r) => [r.account, r.direction, r.amount, r.counterparty_type, r.rev]));
function balanced(db: Db): boolean {
  const t = rows(db, `SELECT transaction_id,
      SUM(CASE WHEN direction = 'DEBIT' THEN CAST(ROUND(amount * 1000) AS INTEGER) ELSE 0 END) AS d,
      SUM(CASE WHEN direction = 'CREDIT' THEN CAST(ROUND(amount * 1000) AS INTEGER) ELSE 0 END) AS c
    FROM ledger_entries GROUP BY transaction_id`);
  return t.length > 0 && t.every((r) => Number(r.d) === Number(r.c));
}

const FORM = { customerId: 'c1', lines: [{ productId: 'p1', unitPrice: 1500 }, { productId: 'p2', unitPrice: 100 }], notes: 'hello', validUntil: '2026-12-31' };
const OPS = ['offers.create', 'offers.update', 'offers.set_status', 'offers.convert_to_invoice'];

async function mkOffer(form: Record<string, unknown> = FORM): Promise<{ id: string; revision: number }> {
  const r = await actions.createOfferOnPrimary(rules.offerCreateInput(form));
  return { id: r.offerId, revision: r.revision };
}
async function toStatus(db: Db, id: string, ...steps: Array<'sent' | 'accepted' | 'rejected'>): Promise<void> {
  for (const s of steps) await actions.setOfferStatusOnPrimary(rules.offerStatusInput({ offerId: id, expectedRevision: rev(db, id), status: s }));
}

// ══ §1 — Umfang ═════════════════════════════════════════════════════════════
{
  ok(OPS.every((op) => registry.ALLOWED_MUTATIONS.includes(op)), 'SCOPE die vier Angebotsaktionen sind namentlich freigegeben');
  ok(OPS.every((op) => registry.knownCommands().includes(op)), `SCOPE und registriert (${OPS.filter((op) => !registry.knownCommands().includes(op)).join(',') || 'alle'})`);
  ok(S([...cmd.OFFER_OPS].sort()) === S([...OPS].sort()), 'SCOPE die Befehlsdatei kennt genau diese vier');
  ok(['offers.create', 'offers.set_status', 'offers.convert_to_invoice'].every((op) => perms.OPERATION_PERMISSIONS[op] === null)
    && perms.OPERATION_PERMISSIONS['offers.update'] !== null && perms.OPERATION_PERMISSIONS['offers.update'] !== undefined,
  'SCOPE Rechte wie die Knöpfe: nur das Bearbeiten ist an offers.edit gebunden');
  ok(!registry.ALLOWED_MUTATIONS.includes('offers.delete'), 'SCOPE Löschen bleibt am Primary (R6B)');
  const reg = codeOf(src('src/core/bridge/offer-commands.ts'));
  ok((reg.match(/^registerCommand\(OP_OFFERS_[A-Z_]+, \{ kind: 'mutation'/gm) ?? []).length === 4, 'SCOPE vier ausdrückliche Anmeldungen, keine Schleife');
}
marker('CENTRAL_UI_R6E_OFFER_SCOPE_PROVED');

// ══ §2 — offers.create ══════════════════════════════════════════════════════
{
  const dbP = freshDb();
  const p = await primary(() => mkOffer());
  const dbC = freshDb();
  const c = await fern(() => cmd.runOfferCreate(deps(dbC), identity(nextId(), 'offers.create'), FORM));
  const idP = p.ok ? p.value.id : '';
  const idC = String(c.value.offerId);
  ok(p.ok && c.kind === 'ok' && offerSig(dbP, idP) === offerSig(dbC, idC) && linesSig(dbP, idP) === linesSig(dbC, idC) && prodSig(dbP) === prodSig(dbC),
    `PARITY Anlegen: Kopf, Positionen und Artikelstatus — Primary == PC2 (${offerSig(dbC, idC)})`);
  const o = rows(dbC, 'SELECT * FROM offers WHERE id = ?', [idC])[0];
  const ls = rows(dbC, 'SELECT * FROM offer_lines WHERE offer_id = ? ORDER BY position', [idC]);
  ok(/^OFF-2026-\d{5}$/.test(String(o?.offer_number)) && c.value.offerNumber === o?.offer_number && o?.status === 'draft' && o?.branch_id === 'branch-main'
    && Number(o?.vat_rate) === 10 && o?.notes === 'hello' && o?.valid_until === '2026-12-31',
  `CREATE Nummer aus dem OFF-Kreis, Entwurf, Filiale und Satz vom Primary (${String(o?.offer_number)})`);
  ok(Number(ls[0]?.line_total) === 1500 && ls[0]?.tax_scheme === 'MARGIN' && Number(ls[1]?.line_total) === 110 && ls[1]?.tax_scheme === 'VAT_10'
    && Number(o?.subtotal) === 1600 && Number(o?.vat_amount) === 10 && Number(o?.total) === 1610 && c.value.total === 1610,
  'CREATE Brutto je Position (MARGIN = Netto, VAT_10 = Netto + 10 %), Summen vom Primary');
  ok(Number(o?.revision) === 3 && c.value.revision === 3, `CREATE die Fassung zählt Kopf und Positionen (${String(o?.revision)})`);
  ok(statusOf(dbC, 'p1') === 'offered' && statusOf(dbC, 'p2') === 'offered' && Number(one(dbC, "SELECT last_offer_price FROM products WHERE id = 'p1'")) === 1500,
    'CREATE die Artikel sind „offered" — in DERSELBEN Transaktion (vorher ein Ereignis nach dem Speichern)');
  await tick();
  ok(n(dbC, "SELECT COUNT(*) FROM products WHERE stock_status = 'offered'") === 2, 'CREATE nach dem Ereignis-Takt: nichts zusätzlich, nichts doppelt');

  const dbA = freshDb();
  const a = await fern(() => cmd.runOfferCreate(deps(dbA), identity(nextId(), 'offers.create', 'branch-main', 'user-pc2'), FORM));
  ok(a.kind === 'ok' && one(dbA, 'SELECT created_by FROM offers') === 'user-pc2', 'ACTOR das Angebot nennt den geprüften Absender, nicht die Anmeldung des Primary');

  const db = freshDb();
  const d = deps(db);
  const idA = nextId();
  const x = await fern(() => cmd.runOfferCreate(d, identity(idA, 'offers.create'), FORM));
  const y = await fern(() => cmd.runOfferCreate(d, identity(idA, 'offers.create'), FORM));
  ok(x.kind === 'ok' && y.replayed && y.value.offerNumber === x.value.offerNumber && n(db, 'SELECT COUNT(*) FROM offers') === 1
    && n(db, 'SELECT COUNT(*) FROM offer_lines') === 2 && seqOf(db, 'OFF') === 2,
  'LOST verlorene Antwort, dieselbe Kennung: ein Angebot, eine Nummer, ein Zählerschritt');

  const seqBefore = seqOf(db, 'OFF');
  const cases: Array<[Record<string, unknown>, string, string]> = [
    [{ ...FORM, customerId: 'c2' }, rules.CUSTOMER_NOT_FOUND, 'ein Kunde einer anderen Filiale'],
    [{ ...FORM, customerId: 'sys-walkin' }, rules.CUSTOMER_NOT_FOUND, 'ein System-Kunde (steht in keiner Auswahl)'],
    [{ ...FORM, lines: [{ productId: 'px', unitPrice: 5 }] }, rules.PRODUCT_NOT_FOUND, 'ein Artikel einer anderen Filiale'],
    [{ ...FORM, lines: [{ productId: 'nope', unitPrice: 5 }] }, rules.PRODUCT_NOT_FOUND, 'ein unbekannter Artikel'],
  ];
  for (const [body, code, what] of cases) {
    const r = await fern(() => cmd.runOfferCreate(d, identity(nextId(), 'offers.create'), body));
    ok(r.kind === 'rejected' && r.code === code && r.frozen && n(db, 'SELECT COUNT(*) FROM offers') === 1 && seqOf(db, 'OFF') === seqBefore,
      `SECURITY ${what}: ${code}, nichts angelegt, keine Nummer verbraucht`);
  }
  const foreign = await fern(() => cmd.runOfferCreate(d, identity(nextId(), 'offers.create', 'branch-other'), FORM));
  ok(foreign.kind === 'rejected' && foreign.code === 'BRANCH_MISMATCH' && n(db, 'SELECT COUNT(*) FROM offers') === 1, 'SECURITY ein Ausweis einer anderen Filiale legt nichts an');
  for (const k of ['id', 'branchId', 'status', 'revision', 'createdBy', 'offerNumber', 'total', 'subtotal', 'vatAmount', 'vatRate', 'sentAt', 'invoiceId', 'account']) {
    ok(/the primary decides/.test(parseMsg(() => cmd.parseOfferCreate({ ...FORM, [k]: 1 }))), `PAYLOAD create: ${k} bestimmt der Primary`);
  }
  for (const k of ['lineTotal', 'purchasePrice', 'vatRate', 'costBasis', 'lotId', 'position', 'id', 'offerId']) {
    ok(/the primary decides/.test(parseMsg(() => cmd.parseOfferCreate({ ...FORM, lines: [{ productId: 'p1', unitPrice: 5, [k]: 1 }] }))),
      `PAYLOAD create: ${k} einer Position bestimmt der Primary`);
  }
  ok(/unknown field/.test(parseMsg(() => cmd.parseOfferCreate({ ...FORM, foo: 1 }))), 'PAYLOAD create: ein unbekanntes Feld wird abgewiesen');
  ok(wirft(() => cmd.parseOfferCreate({ ...FORM, lines: [] })) === rules.OFFER_LINES_REQUIRED, 'PAYLOAD ohne Artikel kein Angebot (der Knopf ist dann gesperrt)');
  ok(wirft(() => cmd.parseOfferCreate({ ...FORM, lines: [{ productId: 'p1', unitPrice: 5 }, { productId: 'p1', unitPrice: 6 }] })) === rules.OFFER_DUPLICATE_PRODUCT,
    'PAYLOAD ein Artikel höchstens einmal (die Auswahl blendet gewählte aus)');
  for (const unitPrice of [-1, Number.NaN, '5', Number.POSITIVE_INFINITY]) {
    ok(wirft(() => cmd.parseOfferCreate({ ...FORM, lines: [{ productId: 'p1', unitPrice }] })) === rules.OFFER_PRICE_INVALID, `PAYLOAD Preis ${String(unitPrice)} abgewiesen`);
  }
  ok(wirft(() => cmd.parseOfferCreate({ ...FORM, validUntil: '2026-02-30' })) === rules.OFFER_DATE_INVALID && wirft(() => cmd.parseOfferCreate({ ...FORM, customerId: '' })) === rules.CUSTOMER_REQUIRED,
    'PAYLOAD Datum ein echter Kalendertag, Kunde Pflicht');
  ok(wirft(() => cmd.parseOfferCreate({ ...FORM, lines: [{ productId: 'p1', unitPrice: 5, taxScheme: 'standard' }] })) === rules.OFFER_SCHEME_INVALID, 'PAYLOAD nur die drei Schemata');

  for (const pat of [/INSERT INTO offer_lines/, /UPDATE products SET stock_status = 'offered'/]) {
    const dbF = freshDb();
    const { db: bad } = faulty(dbF, pat);
    setTestDatabase(bad as never);
    const idF = nextId();
    const f1 = await fern(() => cmd.runOfferCreate(deps(bad), identity(idF, 'offers.create'), FORM));
    const f2 = await primary(() => mkOffer());
    const f3 = wirft(() => useOfferStore.getState().createOffer('c1', [{ productId: 'p1', unitPrice: 1 }]));
    setTestDatabase(dbF as never);
    ok(f1.kind === 'thrown' && !f2.ok && f3 !== '' && n(dbF, 'SELECT COUNT(*) FROM offers') === 0 && n(dbF, 'SELECT COUNT(*) FROM offer_lines') === 0
      && seqOf(dbF, 'OFF') <= 1 && statusOf(dbF, 'p1') === 'in_stock' && lookupCommand(dbF as never, identity(idF, 'offers.create')).kind === 'fresh',
    `ATOMIC Fehler bei ${pat}: kein Angebot, keine Position, kein „offered", keine verbrannte Nummer — fern, am Primary und über den alten Store-Aufruf`);
  }
  const dbS = freshDb();
  const so = useOfferStore.getState().createOffer('c1', [{ productId: 'p3', unitPrice: 700 }], 'store');
  ok(!!so && so.revision === 2 && so.total === 700 && statusOf(dbS, 'p3') === 'offered', 'STORE der alte Aufruf läuft durch dieselbe Hausfolge (Fassung reist mit)');
}
marker('CENTRAL_UI_R6E_OFFER_CREATE_PROVED');

// ══ §3 — offers.update: EIN Speichern, eine Fassung ═════════════════════════
{
  const setup = async () => {
    const db = freshDb();
    const o = await mkOffer();
    const lines = rows(db, 'SELECT id, product_id FROM offer_lines WHERE offer_id = ? ORDER BY position', [o.id]);
    return { db, id: o.id, revision: o.revision, l1: String(lines[0].id), l2: String(lines[1].id) };
  };
  // Preis der VAT_10-Position ändern, p1 entfernen, p3 hinzufügen, Notiz ändern, Gültigkeit löschen, Kunde wechseln.
  const edit = (s: { id: string; revision: number; l2: string }) => ({
    offerId: s.id, expectedRevision: s.revision, notes: 'n2', validUntil: null, customerId: 'c3',
    lines: [{ id: s.l2, productId: 'p2', unitPrice: 120 }, { productId: 'p3', unitPrice: 400 }],
  });
  const P = await setup();
  const p = await primary(() => actions.updateOfferOnPrimary(rules.offerUpdateInput(edit(P))));
  const C = await setup();
  const c = await fern(() => cmd.runOfferUpdate(deps(C.db), identity(nextId(), 'offers.update'), edit(C)));
  ok(p.ok && c.kind === 'ok' && offerSig(P.db, P.id) === offerSig(C.db, C.id) && linesSig(P.db, P.id) === linesSig(C.db, C.id) && prodSig(P.db) === prodSig(C.db),
    `PARITY Speichern: Kopf, Positionen, Artikelstatus — Primary == PC2 (${offerSig(C.db, C.id)})`);
  const o = rows(C.db, 'SELECT * FROM offers WHERE id = ?', [C.id])[0];
  const ls = rows(C.db, 'SELECT * FROM offer_lines WHERE offer_id = ? ORDER BY position', [C.id]);
  ok(ls.length === 2 && ls[0].id === C.l2 && Number(ls[0].unit_price) === 120 && Number(ls[0].line_total) === 132 && ls[1].product_id === 'p3' && Number(ls[1].line_total) === 400,
    'UPDATE die VAT_10-Position behält ihre Steuer (132) — vorher setzte eine Preisänderung line_total = Netto (120)');
  ok(Number(o?.subtotal) === 520 && Number(o?.vat_amount) === 12 && Number(o?.total) === 532 && o?.notes === 'n2' && o?.valid_until === null && o?.customer_id === 'c3',
    'UPDATE Summen neu, Notiz, Gültigkeit gelöscht, Kunde gewechselt — ein Schritt');
  ok(Number(c.value.revision) > C.revision && Number(o?.revision) === Number(c.value.revision) && c.value.changed === true,
    `REVISION ein Speichern ergibt eine streng höhere Fassung (${C.revision} → ${String(c.value.revision)})`);
  ok(statusOf(C.db, 'p1') === 'in_stock' && statusOf(C.db, 'p3') === 'offered' && statusOf(C.db, 'p2') === 'offered',
    'UPDATE entfernter Artikel zurück auf Lager (vorher für immer „offered"), neuer Artikel „offered"');
  const shown = loadOffersFor({ tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test', role: 'ADMIN' }).offers.find((x) => x.id === C.id);
  ok(shown?.revision === Number(o?.revision), `REVISION die Liste der Seite (und damit store.offers.get für PC2) zeigt die Fassung (${String(shown?.revision)})`);
  const actor = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test', role: 'ADMIN' };
  const readOp = await registry.executeCommand('store.offers.get', { actor, input: {} }, actor as never) as { kind: string; value?: { data?: { offers?: Array<{ id: string; revision?: number }> } } };
  ok(readOp.kind === 'ok' && readOp.value?.data?.offers?.find((x) => x.id === C.id)?.revision === Number(o?.revision), 'REVISION …und die Leseauskunft für PC2 trägt sie');

  const d = deps(C.db);
  const r1 = Number(c.value.revision);
  const snap = { l: linesSig(C.db, C.id), r: rev(C.db, C.id), o: offerSig(C.db, C.id) };
  const stale = await fern(() => cmd.runOfferUpdate(d, identity(nextId(), 'offers.update'), { ...edit(C), expectedRevision: C.revision, notes: 'x' }));
  ok(stale.kind === 'rejected' && stale.code === 'RECORD_CHANGED' && stale.frozen && linesSig(C.db, C.id) === snap.l && rev(C.db, C.id) === snap.r,
    'STALE eine alte Fassung: RECORD_CHANGED, nichts geschrieben');
  const same = await fern(() => cmd.runOfferUpdate(d, identity(nextId(), 'offers.update'), {
    offerId: C.id, expectedRevision: r1, notes: 'n2', lines: ls.map((l) => ({ id: String(l.id), productId: String(l.product_id), unitPrice: Number(l.unit_price) })),
  }));
  ok(same.kind === 'ok' && same.value.changed === false && rev(C.db, C.id) === r1, 'UPDATE ein Speichern ohne Änderung: keine neue Fassung');
  const idA = nextId();
  const body = { offerId: C.id, expectedRevision: r1, lines: [{ id: C.l2, productId: 'p2', unitPrice: 150 }, { id: String(ls[1].id), productId: 'p3', unitPrice: 400 }] };
  const x = await fern(() => cmd.runOfferUpdate(d, identity(idA, 'offers.update'), body));
  const r2 = rev(C.db, C.id);
  const y = await fern(() => cmd.runOfferUpdate(d, identity(idA, 'offers.update'), body));
  ok(x.kind === 'ok' && y.replayed && rev(C.db, C.id) === r2 && r2 > r1 && Number(one(C.db, 'SELECT total FROM offers WHERE id = ?', [C.id])) === 565,
    'LOST verlorene Antwort: genau ein Speichern, eine Fassung');
  const otherOffer = (await fern(() => cmd.runOfferCreate(d, identity(nextId(), 'offers.create'), { customerId: 'c1', lines: [{ productId: 'p4', unitPrice: 9 }] }))).value;
  const foreignLine = String(one(C.db, 'SELECT id FROM offer_lines WHERE offer_id = ?', [otherOffer.offerId]));
  const fl = await fern(() => cmd.runOfferUpdate(d, identity(nextId(), 'offers.update'), { offerId: C.id, expectedRevision: r2, lines: [{ id: foreignLine, productId: 'p4', unitPrice: 9 }] }));
  ok(fl.kind === 'rejected' && fl.code === rules.OFFER_LINE_NOT_FOUND && rev(C.db, C.id) === r2, 'SECURITY eine Position eines ANDEREN Angebots ist hier nicht da');
  const swap = await fern(() => cmd.runOfferUpdate(d, identity(nextId(), 'offers.update'), { offerId: C.id, expectedRevision: r2, lines: [{ id: C.l2, productId: 'p4', unitPrice: 9 }] }));
  ok(swap.kind === 'rejected' && swap.code === rules.OFFER_LINE_INVALID, 'UPDATE eine bestehende Position behält ihren Artikel');
  const fp = await fern(() => cmd.runOfferUpdate(d, identity(nextId(), 'offers.update'), { offerId: C.id, expectedRevision: r2, lines: [{ productId: 'px', unitPrice: 9 }] }));
  const fc = await fern(() => cmd.runOfferUpdate(d, identity(nextId(), 'offers.update'), { offerId: C.id, expectedRevision: r2, customerId: 'c2', lines: [] }));
  ok(fp.code === rules.PRODUCT_NOT_FOUND && fc.code === rules.CUSTOMER_NOT_FOUND && rev(C.db, C.id) === r2, 'SECURITY fremder Artikel / fremder Kunde: Nein, nichts geändert');
  insert(C.db, 'offers', { id: 'ofx', branch_id: 'branch-other', offer_number: 'OFF-X', customer_id: 'c2', status: 'draft', created_at: NOW, updated_at: NOW });
  const fo = await fern(() => cmd.runOfferUpdate(d, identity(nextId(), 'offers.update'), { offerId: 'ofx', expectedRevision: 1, notes: 'hack', lines: [] }));
  ok(fo.kind === 'rejected' && fo.code === rules.OFFER_NOT_FOUND && one(C.db, "SELECT notes FROM offers WHERE id = 'ofx'") === null, 'SECURITY ein Angebot einer anderen Filiale ist nicht da');
  for (const k of ['total', 'subtotal', 'offerNumber', 'status', 'revision', 'vatAmount', 'createdBy', 'invoiceId']) {
    ok(/the primary decides/.test(parseMsg(() => cmd.parseOfferUpdate({ offerId: C.id, expectedRevision: 1, lines: [], [k]: 1 }))), `PAYLOAD update: ${k} bestimmt der Primary`);
  }
  for (const k of ['lineTotal', 'purchasePrice', 'vatRate', 'position']) {
    ok(/the primary decides/.test(parseMsg(() => cmd.parseOfferUpdate({ offerId: C.id, expectedRevision: 1, lines: [{ productId: 'p1', unitPrice: 1, [k]: 1 }] }))), `PAYLOAD update: ${k} einer Position bestimmt der Primary`);
  }
  ok(/expectedRevision is required/.test(parseMsg(() => cmd.parseOfferUpdate({ offerId: C.id, lines: [] }))), 'PAYLOAD ohne gesehene Fassung kein Speichern');
  setTestDatabase(C.db as never);
  await toStatus(C.db, C.id, 'sent');
  const ne = await fern(() => cmd.runOfferUpdate(d, identity(nextId(), 'offers.update'), { offerId: C.id, expectedRevision: rev(C.db, C.id), notes: 'late', lines: [] }));
  ok(ne.kind === 'rejected' && ne.code === rules.OFFER_NOT_EDITABLE && one(C.db, 'SELECT notes FROM offers WHERE id = ?', [C.id]) === 'n2',
    'UPDATE nur der Entwurf ist bearbeitbar (dieselbe Regel wie der Edit-Knopf)');

  for (const pat of [/UPDATE offers SET customer_id/, /DELETE FROM offer_lines/, /UPDATE products SET stock_status = 'in_stock'/]) {
    const F = await setup();
    const before = { l: linesSig(F.db, F.id), o: offerSig(F.db, F.id), p: prodSig(F.db) };
    const { db: bad } = faulty(F.db, pat);
    setTestDatabase(bad as never);
    const f1 = await fern(() => cmd.runOfferUpdate(deps(bad), identity(nextId(), 'offers.update'), edit(F)));
    const f2 = await primary(() => actions.updateOfferOnPrimary(rules.offerUpdateInput(edit(F))));
    setTestDatabase(F.db as never);
    ok(f1.kind === 'thrown' && !f2.ok && linesSig(F.db, F.id) === before.l && offerSig(F.db, F.id) === before.o && prodSig(F.db) === before.p && rev(F.db, F.id) === F.revision,
      `ATOMIC Fehler bei ${pat}: Positionen, Kopf, Fassung und Artikelstatus unverändert`);
  }
}
marker('CENTRAL_UI_R6E_OFFER_REVISION_PROVED');

// ══ §4 — offers.set_status ══════════════════════════════════════════════════
{
  const dbP = freshDb();
  const oP = await mkOffer();
  const p = await primary(() => actions.setOfferStatusOnPrimary(rules.offerStatusInput({ offerId: oP.id, expectedRevision: oP.revision, status: 'sent' })));
  const dbC = freshDb();
  const oC = await mkOffer();
  const c = await fern(() => cmd.runOfferStatus(deps(dbC), identity(nextId(), 'offers.set_status'), { offerId: oC.id, expectedRevision: oC.revision, status: 'sent' }));
  ok(p.ok && c.kind === 'ok' && offerSig(dbP, oP.id) === offerSig(dbC, oC.id) && taskSig(dbP, oP.id) === taskSig(dbC, oC.id),
    `PARITY Senden: Angebot und Aufgabe — Primary == PC2 (${taskSig(dbC, oC.id)})`);
  ok(one(dbC, 'SELECT status FROM offers WHERE id = ?', [oC.id]) === 'sent' && !!one(dbC, 'SELECT sent_at FROM offers WHERE id = ?', [oC.id]) && !!c.value.sentAt
    && Number(c.value.revision) === rev(dbC, oC.id) && rev(dbC, oC.id) === oC.revision + 1,
  'STATUS gesendet: Zeitpunkt vom Primary, neue Fassung');
  ok(tasksOf(dbC, oC.id) === 1 && one(dbC, 'SELECT title FROM tasks WHERE linked_entity_id = ?', [oC.id]) === 'Follow up on sent offer',
    'STATUS die Nachfass-Aufgabe entsteht IN der Transaktion (vorher ein Ereignis nach dem Speichern)');
  await tick();
  ok(tasksOf(dbC, oC.id) === 1 && tasksOf(dbP, oP.id) === 1, 'STATUS …und nach dem Ereignis-Takt keine zweite (die Handler sind geladen)');
  const dbU = freshDb();
  const oU = await mkOffer();
  const u = await fern(() => cmd.runOfferStatus(deps(dbU), identity(nextId(), 'offers.set_status', 'branch-main', 'user-pc2'), { offerId: oU.id, expectedRevision: oU.revision, status: 'sent', sentVia: 'whatsapp' }));
  ok(u.kind === 'ok' && one(dbU, 'SELECT assigned_to FROM tasks WHERE linked_entity_id = ?', [oU.id]) === 'user-pc2' && one(dbU, 'SELECT created_by FROM tasks WHERE linked_entity_id = ?', [oU.id]) === 'user-pc2'
    && one(dbU, 'SELECT sent_via FROM offers WHERE id = ?', [oU.id]) === 'whatsapp', 'ACTOR die Aufgabe gehört dem Absender; der Weg des Sendens wird vermerkt');

  setTestDatabase(dbC as never);
  const d = deps(dbC);
  const idA = nextId();
  const acc = { offerId: oC.id, expectedRevision: rev(dbC, oC.id), status: 'accepted' };
  const a1 = await fern(() => cmd.runOfferStatus(d, identity(idA, 'offers.set_status'), acc));
  const a2 = await fern(() => cmd.runOfferStatus(d, identity(idA, 'offers.set_status'), acc));
  ok(a1.kind === 'ok' && a2.replayed && one(dbC, 'SELECT status FROM offers WHERE id = ?', [oC.id]) === 'accepted' && tasksOf(dbC, oC.id) === 2
    && n(dbC, "SELECT COUNT(*) FROM tasks WHERE title = 'Create invoice for accepted offer' AND linked_entity_id = ?", [oC.id]) === 1,
  'LOST angenommen: die Aufgabe „Create invoice" genau einmal, auch bei verlorener Antwort');
  await tick();
  ok(tasksOf(dbC, oC.id) === 2, 'STATUS …und kein Ereignis legt eine zweite an');

  setTestDatabase(dbC as never);
  const oR = await mkOffer({ customerId: 'c1', lines: [{ productId: 'p3', unitPrice: 600 }] });
  await toStatus(dbC, oR.id, 'sent');
  ok(statusOf(dbC, 'p3') === 'offered', 'REJECT vorher „offered"');
  const rj = await fern(() => cmd.runOfferStatus(d, identity(nextId(), 'offers.set_status'), { offerId: oR.id, expectedRevision: rev(dbC, oR.id), status: 'rejected' }));
  ok(rj.kind === 'ok' && statusOf(dbC, 'p3') === 'in_stock' && one(dbC, 'SELECT status FROM offers WHERE id = ?', [oR.id]) === 'rejected',
    'REJECT die Artikel zurück auf Lager — in derselben Transaktion');

  const transitions: Array<[string, string, string]> = [
    [oC.id, 'sent', 'angenommen → gesendet'], [oC.id, 'rejected', 'angenommen → abgelehnt'], [oR.id, 'accepted', 'abgelehnt → angenommen'],
  ];
  const oD = await mkOffer({ customerId: 'c1', lines: [{ productId: 'p4', unitPrice: 1 }] });
  transitions.push([oD.id, 'accepted', 'Entwurf → angenommen'], [oD.id, 'rejected', 'Entwurf → abgelehnt']);
  for (const [oid, to, what] of transitions) {
    const before = rev(dbC, oid);
    const r = await fern(() => cmd.runOfferStatus(d, identity(nextId(), 'offers.set_status'), { offerId: oid, expectedRevision: before, status: to }));
    ok(r.kind === 'rejected' && r.code === rules.OFFER_INVALID_TRANSITION && r.frozen && rev(dbC, oid) === before, `TRANSITION ${what}: kein Knopf bietet das an — Nein`);
  }
  for (const status of ['expired', 'draft', 'viewed', 'ACCEPTED']) {
    ok(wirft(() => cmd.parseOfferStatus({ offerId: oD.id, expectedRevision: 1, status })) === rules.OFFER_STATUS_INVALID, `PAYLOAD Status ${status}: keines der drei Ziele`);
  }
  ok(wirft(() => cmd.parseOfferStatus({ offerId: oD.id, expectedRevision: 1, status: 'accepted', sentVia: 'email' })) === rules.OFFER_STATUS_INVALID
    && wirft(() => cmd.parseOfferStatus({ offerId: oD.id, expectedRevision: 1, status: 'sent', sentVia: 'fax' })) === rules.OFFER_STATUS_INVALID, 'PAYLOAD sentVia nur beim Senden, nur die bekannten Wege');
  for (const k of ['sentAt', 'offerNumber', 'invoiceId', 'total', 'id', 'branchId', 'revision', 'createdBy']) {
    ok(/the primary decides/.test(parseMsg(() => cmd.parseOfferStatus({ offerId: oD.id, expectedRevision: 1, status: 'sent', [k]: 1 }))), `PAYLOAD status: ${k} bestimmt der Primary`);
  }
  ok(/expectedRevision is required/.test(parseMsg(() => cmd.parseOfferStatus({ offerId: oD.id, status: 'sent' }))), 'PAYLOAD ohne gesehene Fassung kein Statuswechsel');
  const st = await fern(() => cmd.runOfferStatus(d, identity(nextId(), 'offers.set_status'), { offerId: oD.id, expectedRevision: rev(dbC, oD.id) - 1, status: 'sent' }));
  ok(st.kind === 'rejected' && st.code === 'RECORD_CHANGED' && one(dbC, 'SELECT status FROM offers WHERE id = ?', [oD.id]) === 'draft' && tasksOf(dbC, oD.id) === 0,
    'STALE alte Fassung: kein Senden, keine Aufgabe');
  insert(dbC, 'offers', { id: 'ofx', branch_id: 'branch-other', offer_number: 'OFF-X', customer_id: 'c2', status: 'draft', created_at: NOW, updated_at: NOW });
  const fo = await fern(() => cmd.runOfferStatus(d, identity(nextId(), 'offers.set_status'), { offerId: 'ofx', expectedRevision: 1, status: 'sent' }));
  ok(fo.kind === 'rejected' && fo.code === rules.OFFER_NOT_FOUND && one(dbC, "SELECT status FROM offers WHERE id = 'ofx'") === 'draft', 'SECURITY ein Angebot einer anderen Filiale ist nicht da');

  for (const [pat, to] of [[/INSERT INTO tasks/, 'sent'], [/UPDATE products SET stock_status = 'in_stock'/, 'rejected']] as Array<[RegExp, 'sent' | 'rejected']>) {
    const dbF = freshDb();
    const oF = await mkOffer();
    if (to === 'rejected') await toStatus(dbF, oF.id, 'sent');
    const before = { o: offerSig(dbF, oF.id), t: n(dbF, 'SELECT COUNT(*) FROM tasks'), p: prodSig(dbF), r: rev(dbF, oF.id) };
    const { db: bad } = faulty(dbF, pat);
    setTestDatabase(bad as never);
    const f1 = await fern(() => cmd.runOfferStatus(deps(bad), identity(nextId(), 'offers.set_status'), { offerId: oF.id, expectedRevision: before.r, status: to }));
    const f2 = await primary(() => actions.setOfferStatusOnPrimary(rules.offerStatusInput({ offerId: oF.id, expectedRevision: before.r, status: to })));
    setTestDatabase(dbF as never);
    ok(f1.kind === 'thrown' && !f2.ok && offerSig(dbF, oF.id) === before.o && n(dbF, 'SELECT COUNT(*) FROM tasks') === before.t && prodSig(dbF) === before.p && rev(dbF, oF.id) === before.r,
      `ATOMIC Fehler bei ${pat}: der Status bleibt, wie er war — keine halbe Folge`);
  }
}
marker('CENTRAL_UI_R6E_OFFER_STATUS_PROVED');

// ══ §5 — offers.convert_to_invoice ══════════════════════════════════════════
{
  const invOf = (db: Db, offerId: string): string => String(one(db, 'SELECT id FROM invoices WHERE offer_id = ?', [offerId]) ?? '');
  const invSig = (db: Db, id: string): string => normRow(rows(db, 'SELECT * FROM invoices WHERE id = ?', [id])[0], /^(id|created_at|updated_at|offer_id)$/, /^(issued_at|due_at)$/);
  const invLinesSig = (db: Db, id: string): string => S(rows(db, 'SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY position', [id]).map((r) => normRow(r, /^(id|invoice_id)$/)));
  const accepted = async (form: Record<string, unknown> = FORM) => {
    const db = freshDb();
    const o = await mkOffer(form);
    await toStatus(db, o.id, 'sent', 'accepted');
    return { db, id: o.id, revision: rev(db, o.id) };
  };

  const P = await accepted();
  const p = await primary(() => actions.convertOfferOnPrimary(rules.offerConvertInput({ offerId: P.id, expectedRevision: P.revision })));
  const C = await accepted();
  const c = await fern(() => cmd.runOfferConvert(deps(C.db), identity(nextId(), 'offers.convert_to_invoice'), { offerId: C.id, expectedRevision: C.revision }));
  const invP = invOf(P.db, P.id);
  const invC = invOf(C.db, C.id);
  ok(p.ok && c.kind === 'ok' && !!invP && invSig(P.db, invP) === invSig(C.db, invC) && invLinesSig(P.db, invP) === invLinesSig(C.db, invC)
    && ledgerSig(P.db, 'INVOICE', invP) === ledgerSig(C.db, 'INVOICE', invC) && ledgerSig(C.db, 'INVOICE', invC) !== '[]',
  `PARITY Umwandeln: Rechnung, Zeilen und Buchung — Primary == PC2 (${invSig(C.db, invC)})`);
  const il = rows(C.db, 'SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY position', [invC]);
  ok(Number(il[0]?.purchase_price_snapshot) === 800 && il[0]?.lot_id === 'L1' && Math.abs(Number(il[0]?.vat_amount) - 63.636) < 0.0005 && Number(il[0]?.line_total) === 1500,
    `COGS der Einstand der Zeile ist der des verbrauchten Loses (800), nicht products.purchase_price (1000) — Marge und interne MwSt folgen (${String(il[0]?.purchase_price_snapshot)} / ${String(il[0]?.vat_amount)})`);
  ok(Number(il[1]?.purchase_price_snapshot) === 200 && il[1]?.lot_id === null && Number(il[1]?.line_total) === 110 && Number(il[1]?.vat_rate) === 10,
    'COGS ein Artikel ohne Lose behält den Einstand des Artikels');
  const inv = rows(C.db, 'SELECT * FROM invoices WHERE id = ?', [invC])[0];
  ok(inv?.offer_id === C.id && /^PINV-/.test(String(inv?.invoice_number)) && inv?.status === 'PARTIAL' && Number(inv?.gross_amount) === 1610 && Number(inv?.purchase_price_snapshot) === 1000
    && c.value.invoiceId === invC && c.value.invoiceNumber === inv?.invoice_number && c.value.grossAmount === 1610,
  'INVOICE die Angebotskennung steht in der ERSTEN Zeile der Rechnung (dasselbe INSERT), Summen wie das Formular');
  ok(one(C.db, 'SELECT invoice_id FROM offers WHERE id = ?', [C.id]) === invC && one(C.db, 'SELECT status FROM offers WHERE id = ?', [C.id]) === 'accepted'
    && Number(c.value.offerRevision) === rev(C.db, C.id) && rev(C.db, C.id) > C.revision, 'INVOICE das Angebot ist verknüpft, neue Fassung im Ergebnis');
  ok(n(C.db, "SELECT qty_remaining FROM stock_lots WHERE id = 'L1'") === 0 && statusOf(C.db, 'p1') === 'reserved', 'STOCK das Los ist verbraucht, das Stück reserviert (bis zur Vollzahlung)');
  ok(tasksOf(C.db, invC) === 1 && one(C.db, 'SELECT type FROM tasks WHERE linked_entity_id = ?', [invC]) === 'payment_reminder', 'TASK die Zahlungserinnerung entsteht in derselben Transaktion');
  ok(balanced(C.db) && balanced(P.db), 'LEDGER jede Buchung gleicht sich aus');
  ok(n(C.db, "SELECT COALESCE(SUM(amount), 0) FROM ledger_entries WHERE source_module = 'INVOICE' AND source_id = ? AND account = 'COGS' AND direction = 'DEBIT'", [invC]) === 1000
    && n(C.db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'INVOICE' AND source_id = ? AND account = 'COGS' AND direction = 'DEBIT' AND amount = 800", [invC]) === 1,
  'LEDGER Wareneinsatz je Zeile im Hauptbuch = Einstand des Loses (800) bzw. des Artikels (200)');

  // Vergleich mit dem Rechnungsformular: dieselbe Ableitung (`toInvoiceLine`, Einstand aus dem gewählten Los) über `createDirectInvoice`.
  const dbF = freshDb();
  posting.beginLedgerTransaction();
  const formInv = useInvoiceStore.getState().createDirectInvoice('c1', [
    toInvoiceLine({ productId: 'p1', lotId: 'L1', quantity: 1, unitPrice: 1500, costBasis: 800, scheme: 'MARGIN' }),
    toInvoiceLine({ productId: 'p2', lotId: null, quantity: 1, unitPrice: 100, costBasis: 200, scheme: 'VAT_10' }),
  ], 'hello');
  posting.commitLedgerTransaction();
  ok(invLinesSig(dbF, formInv.id) === invLinesSig(C.db, invC) && ledgerSig(dbF, 'INVOICE', formInv.id) === ledgerSig(C.db, 'INVOICE', invC) && invSig(dbF, formInv.id) === invSig(C.db, invC),
    'COGS Angebot → Rechnung == Rechnungsformular: dieselben Zeilen, dieselbe Buchung (EIN Rechnungsweg)');

  const d = deps(C.db);
  setTestDatabase(C.db as never);
  const again = await fern(() => cmd.runOfferConvert(d, identity(nextId(), 'offers.convert_to_invoice'), { offerId: C.id, expectedRevision: rev(C.db, C.id) }));
  ok(again.kind === 'rejected' && again.code === rules.OFFER_ALREADY_INVOICED && n(C.db, 'SELECT COUNT(*) FROM invoices') === 1, 'DOUBLE ein zweites Umwandeln: Nein (H-03 bleibt)');

  const L = await accepted();
  const idA = nextId();
  const body = { offerId: L.id, expectedRevision: L.revision, perLineSchemes: {} as Record<string, string>, specialMark: false };
  const l1 = await fern(() => cmd.runOfferConvert(deps(L.db), identity(idA, 'offers.convert_to_invoice'), body));
  const counts = { inv: n(L.db, 'SELECT COUNT(*) FROM invoices'), led: lc(L.db), seq: seqOf(L.db, 'PINV'), tasks: n(L.db, 'SELECT COUNT(*) FROM tasks') };
  const l2 = await fern(() => cmd.runOfferConvert(deps(L.db), identity(idA, 'offers.convert_to_invoice'), body));
  ok(l1.kind === 'ok' && l2.replayed && l2.value.invoiceId === l1.value.invoiceId && counts.inv === 1 && n(L.db, 'SELECT COUNT(*) FROM invoices') === 1
    && lc(L.db) === counts.led && seqOf(L.db, 'PINV') === counts.seq && counts.seq === 2 && n(L.db, 'SELECT COUNT(*) FROM tasks') === counts.tasks
    && n(L.db, "SELECT qty_remaining FROM stock_lots WHERE id = 'L1'") === 0, 'LOST verlorene Antwort: genau eine Rechnung, eine Nummer, ein Los-Abzug, eine Buchung');

  const S2 = await accepted();
  const pinv0 = seqOf(S2.db, 'PINV');
  const stale = await fern(() => cmd.runOfferConvert(deps(S2.db), identity(nextId(), 'offers.convert_to_invoice'), { offerId: S2.id, expectedRevision: S2.revision - 1 }));
  ok(stale.kind === 'rejected' && stale.code === 'RECORD_CHANGED' && n(S2.db, 'SELECT COUNT(*) FROM invoices') === 0 && seqOf(S2.db, 'PINV') === pinv0, 'STALE alte Fassung: keine Rechnung, keine Nummer');
  const lineIds = rows(S2.db, 'SELECT id, product_id FROM offer_lines WHERE offer_id = ? ORDER BY position', [S2.id]);
  const bad1 = await fern(() => cmd.runOfferConvert(deps(S2.db), identity(nextId(), 'offers.convert_to_invoice'), { offerId: S2.id, expectedRevision: S2.revision, perLineSchemes: { nope: 'ZERO' } }));
  ok(bad1.kind === 'rejected' && bad1.code === rules.OFFER_LINE_NOT_FOUND, 'SECURITY ein Schema für eine fremde Position: Nein');
  const bad2 = await fern(() => cmd.runOfferConvert(deps(S2.db), identity(nextId(), 'offers.convert_to_invoice'), { offerId: S2.id, expectedRevision: S2.revision, staffId: 'e2' }));
  ok(bad2.kind === 'rejected' && bad2.code === rules.EMPLOYEE_NOT_FOUND && n(S2.db, 'SELECT COUNT(*) FROM invoices') === 0, 'SECURITY ein Mitarbeiter einer anderen Filiale: Nein');
  const zero = await fern(() => cmd.runOfferConvert(deps(S2.db), identity(nextId(), 'offers.convert_to_invoice'), {
    offerId: S2.id, expectedRevision: S2.revision, perLineSchemes: { [String(lineIds[1].id)]: 'ZERO' }, staffId: 'e1', specialMark: true,
  }));
  const zl = rows(S2.db, "SELECT * FROM invoice_lines WHERE product_id = 'p2'")[0];
  const zi = rows(S2.db, 'SELECT * FROM invoices')[0];
  ok(zero.kind === 'ok' && zl?.tax_scheme === 'ZERO' && Number(zl?.vat_amount) === 0 && Number(zl?.vat_rate) === 0 && Number(zl?.line_total) === 100
    && zi?.staff_id === 'e1' && Number(zi?.special_mark) === 1 && zi?.tax_scheme_snapshot === 'mixed',
  'SCHEME die Wahl des Schema-Dialogs gilt je Position (ZERO: Satz 0), Mitarbeiter und Nummernart reisen mit');

  const D = freshDb();
  const oD = await mkOffer();
  const nd = await fern(() => cmd.runOfferConvert(deps(D), identity(nextId(), 'offers.convert_to_invoice'), { offerId: oD.id, expectedRevision: oD.revision }));
  ok(nd.kind === 'rejected' && nd.code === rules.OFFER_NOT_ACCEPTED && n(D, 'SELECT COUNT(*) FROM invoices') === 0, 'STATUS nur ein angenommenes Angebot wird Rechnung (der Knopf steht nur dort)');
  insert(D, 'offers', { id: 'ofx', branch_id: 'branch-other', offer_number: 'OFF-X', customer_id: 'c2', status: 'accepted', created_at: NOW, updated_at: NOW });
  const fo = await fern(() => cmd.runOfferConvert(deps(D), identity(nextId(), 'offers.convert_to_invoice'), { offerId: 'ofx', expectedRevision: 1 }));
  ok(fo.kind === 'rejected' && fo.code === rules.OFFER_NOT_FOUND, 'SECURITY ein Angebot einer anderen Filiale ist nicht da');

  const X = await accepted({ customerId: 'c1', lines: [{ productId: 'p4', unitPrice: 900 }] });
  const pinvX = seqOf(X.db, 'PINV');
  const su = await fern(() => cmd.runOfferConvert(deps(X.db), identity(nextId(), 'offers.convert_to_invoice'), { offerId: X.id, expectedRevision: X.revision }));
  ok(su.kind === 'rejected' && su.code === rules.STOCK_UNAVAILABLE && su.frozen && n(X.db, 'SELECT COUNT(*) FROM invoices') === 0 && seqOf(X.db, 'PINV') === pinvX,
    'STOCK ein über Lose geführter Artikel ohne offenes Los: nicht lieferbar (vorher: Zeile ohne Los und ohne Bestandsabzug)');

  for (const k of ['lotId', 'purchasePrice', 'invoiceNumber', 'customerId', 'lines', 'grossAmount', 'status', 'quantity', 'id', 'branchId']) {
    ok(/the primary decides/.test(parseMsg(() => cmd.parseOfferConvert({ offerId: 'o', expectedRevision: 1, [k]: 1 }))), `PAYLOAD convert: ${k} bestimmt der Primary`);
  }
  ok(wirft(() => cmd.parseOfferConvert({ offerId: 'o', expectedRevision: 1, perLineSchemes: { a: 'standard' } })) === rules.OFFER_SCHEME_INVALID, 'PAYLOAD convert: nur die drei Schemata');
  ok(/expectedRevision is required/.test(parseMsg(() => cmd.parseOfferConvert({ offerId: 'o' }))), 'PAYLOAD convert: ohne gesehene Fassung keine Rechnung');

  for (const pat of [/INSERT INTO ledger_entries/, /UPDATE offers SET status = 'accepted', invoice_id/, /INSERT INTO tasks/]) {
    const F = await accepted();
    const before = { o: offerSig(F.db, F.id), led: lc(F.db), seq: seqOf(F.db, 'PINV'), tasks: n(F.db, 'SELECT COUNT(*) FROM tasks'), p: prodSig(F.db) };
    const { db: bad } = faulty(F.db, pat);
    setTestDatabase(bad as never);
    const idF = nextId();
    const f1 = await fern(() => cmd.runOfferConvert(deps(bad), identity(idF, 'offers.convert_to_invoice'), { offerId: F.id, expectedRevision: F.revision }));
    const f2 = await primary(() => actions.convertOfferOnPrimary(rules.offerConvertInput({ offerId: F.id, expectedRevision: F.revision })));
    const f3 = wirft(() => useInvoiceStore.getState().createInvoiceFromOffer(F.id));
    setTestDatabase(F.db as never);
    ok(f1.kind === 'thrown' && !f2.ok && f3 !== '' && n(F.db, 'SELECT COUNT(*) FROM invoices') === 0 && n(F.db, 'SELECT COUNT(*) FROM invoice_lines') === 0
      && n(F.db, "SELECT qty_remaining FROM stock_lots WHERE id = 'L1'") === 1 && seqOf(F.db, 'PINV') === before.seq && lc(F.db) === before.led
      && offerSig(F.db, F.id) === before.o && n(F.db, 'SELECT COUNT(*) FROM tasks') === before.tasks && prodSig(F.db) === before.p
      && lookupCommand(F.db as never, identity(idF, 'offers.convert_to_invoice')).kind === 'fresh',
    `ATOMIC Fehler bei ${pat}: keine halbe Rechnung, kein verbrauchtes Los, keine Nummer, keine Buchung, Angebot unverändert — fern, am Primary und über den Store`);
  }
  const Z = await accepted();
  const zs = useInvoiceStore.getState().createInvoiceFromOffer(Z.id, undefined, undefined, false);
  ok(!!zs && zs.offerId === Z.id && Number(one(Z.db, 'SELECT purchase_price_snapshot FROM invoice_lines WHERE product_id = ?', ['p1'])) === 800,
    'STORE createInvoiceFromOffer ist nur noch ein Anschluss an dieselbe Hausfolge (Unterschrift unverändert)');
}
marker('CENTRAL_UI_R6E_OFFER_TO_INVOICE_ATOMIC_PROVED');

// ══ §6 — Client: keine lokale Datenbank, der Weg geht über den Primary ═══════
{
  const db = freshDb();
  const o = await mkOffer();
  const base = loadOffersFor({ tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test', role: 'ADMIN' }).offers.find((x) => x.id === o.id)!;
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
  const calls: Array<{ body: Record<string, unknown> }> = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ body });
    if (String(body.op).startsWith('offers.')) return new Response(JSON.stringify({ ok: true, value: { offerId: o.id, revision: 9, invoiceId: 'inv-9', invoiceNumber: 'PINV-9', replayed: false } }), { status: 200 });
    return new Response(JSON.stringify({ ok: true, value: { data: {} } }), { status: 200 });
  }) as never;
  try {
    const refusals = [
      wirft(() => useOfferStore.getState().createOffer('c1', [{ productId: 'p1', unitPrice: 1 }])),
      wirft(() => useInvoiceStore.getState().createInvoiceFromOffer(o.id)),
      wirft(() => house.updateOfferInHouse({ offerId: o.id, lines: [] }, { branchId: 'branch-main', userId: 'u' })),
      wirft(() => house.setOfferStatusInHouse({ offerId: o.id, status: 'sent' }, { branchId: 'branch-main', userId: 'u' })),
      wirft(() => house.convertOfferToInvoiceInHouse({ offerId: o.id }, { branchId: 'branch-main', userId: 'u' })),
    ];
    ok(refusals.every((c) => c === rules.OFFER_PRIMARY_ONLY) && touched === 0,
      `CLIENT jede Angebotsaktion verweigert die lokale Datenbank, bevor sie sie anfasst (${S(refusals)}, Zugriffe ${touched})`);
    const write = { remote: true, save: <T,>(op: string, a: never) => runSharedWrite<T>(true, a, new CommandSaveController<Record<string, unknown>>(op).beginAttempt()) };
    const draft = actions.draftOf(base);
    const unchanged = await actions.saveOfferUpdate(write as never, base, draft);
    ok(unchanged.kind === 'ok' && calls.length === 0 && touched === 0, 'CLIENT ein Speichern ohne Änderung schickt nichts');
    const edited = { ...draft, notes: 'changed', lines: [{ ...draft.lines[1], price: '120' }, { productId: 'p3', price: '400' }] };
    const r = await actions.saveOfferUpdate(write as never, base, edited);
    const sent = calls.find((c) => c.body.op === 'offers.update');
    const payload = (sent?.body.payload ?? {}) as Record<string, unknown>;
    ok(r.kind === 'ok' && !!sent && S(Object.keys(payload).sort()) === S(['expectedRevision', 'lines', 'notes', 'offerId'])
      && payload.expectedRevision === base.revision && S(payload.lines) === S([{ productId: 'p2', unitPrice: 120, id: base.lines[1].id }, { productId: 'p3', unitPrice: 400 }]) && touched === 0,
    `CLIENT „Save" schickt EINEN Auftrag: der ganze Positionsstand mit der gesehenen Fassung — keine lokale Wirkung (${S(payload)})`);
    const before = calls.length;
    const bad = await actions.saveOfferUpdate(write as never, base, { ...draft, lines: [{ ...draft.lines[0], price: '' }] });
    ok(bad.kind === 'business_error' && (bad as { code: string }).code === rules.OFFER_PRICE_INVALID && calls.length === before, 'CLIENT dieselbe Eingaberegel VOR dem Schicken: kein Netz');
    const cr = await actions.saveOfferCreate(write as never, { customerId: 'c1', lines: [{ productId: 'p1', unitPrice: 1500 }], notes: '', validUntil: '' });
    const cSent = calls.find((c) => c.body.op === 'offers.create');
    ok(cr.kind === 'ok' && S(cSent?.body.payload) === S({ customerId: 'c1', lines: [{ productId: 'p1', unitPrice: 1500 }] }) && touched === 0,
      `CLIENT „Create Offer": nur Kunde, Artikel und Preis — kein Einstand, kein Schema, keine Summe (${S(cSent?.body.payload)})`);
    const sr = await actions.saveOfferStatus(write as never, base, 'sent');
    const sSent = calls.find((c) => c.body.op === 'offers.set_status');
    ok(sr.kind === 'ok' && S(sSent?.body.payload) === S({ offerId: o.id, status: 'sent', expectedRevision: base.revision }) && touched === 0, 'CLIENT „Send": Status und Fassung, sonst nichts');
    const cv = await actions.saveOfferConvert(write as never, base, { [base.lines[0].id]: 'VAT_10' }, true);
    const vSent = calls.find((c) => c.body.op === 'offers.convert_to_invoice');
    ok(cv.kind === 'ok' && cv.value.invoiceId === 'inv-9' && S(Object.keys((vSent?.body.payload ?? {}) as object).sort()) === S(['expectedRevision', 'offerId', 'perLineSchemes', 'specialMark']) && touched === 0,
      'CLIENT „Create Invoice": die Wahl der zwei Dialoge und die Fassung — keine Zeilen, kein Los, kein Einstand');
  } finally {
    globalThis.fetch = origFetch;
    store.delete('lataif_runtime_mode');
    store.delete('lataif_client_server_url');
    store.delete('lataif_client_token');
    setTestDatabase(db as never);
  }
}
marker('CENTRAL_UI_R6E_OFFER_CLIENT_NO_LOCAL_DB_PROVED');

// ══ §7 — Oberfläche: jede Handlung ein Anschluss ════════════════════════════
{
  const det = codeOf(src('src/pages/offers/OfferDetail.tsx'));
  ok(!/updateOfferLine\(|addOfferLine\(|removeOfferLine\(|updateOffer\(|createInvoiceFromOffer\(|getDatabase\(/.test(det),
    'UI Detail: kein Schreiben je Tastendruck, kein Store-Schreiber, kein zweiter Rechnungsweg');
  ok(/saveOfferUpdate\(w, offer, draft\)/.test(det) && /saveOfferStatus\(w, offer, status\)/.test(det) && /saveOfferConvert\(w, offer, perLine, special\)/.test(det),
    'UI Detail: Speichern, Status und Umwandeln — je ein Anschluss');
  ok(/if \(r\.kind !== 'ok'\) \{ setFehler\(fehlertext\(r\)\); return; \}/.test(det) && /<WriteError text=\{fehler\} \/>/.test(det) && /disabled=\{w\.busy\}/.test(det),
    'UI Detail: Fehler sichtbar, Entwurf bleibt bei einem Nein, gesperrt solange es läuft');
  ok((det.match(/primaryOnlyDeleteProps\(\)/g) ?? []).length === 1 && (det.match(/blockDeleteOnClient\(\)/g) ?? []).length === 1, 'UI Detail: Löschen bleibt Primary-only (R6B)');
  const list = codeOf(src('src/pages/offers/OfferList.tsx'));
  ok(!/createOffer\(|updateOffer\(|alert\(`Could not create offer/.test(list) && /saveOfferCreate\(w, \{/.test(list) && /saveOfferStatus\(w, offer, status\)/.test(list)
    && /<WriteError text=\{createFehler\} \/>/.test(list) && /<WriteError text=\{rowFehler\} \/>/.test(list), 'UI Liste: Anlegen und Zeilenknöpfe durch den Anschluss, Fehler sichtbar (kein alert)');
  const st = codeOf(src('src/stores/offerStore.ts'));
  ok(!/updateOfferLine|addOfferLine|removeOfferLine|recalcOfferTotals|'branch-main'|eventBus/.test(st), 'STORE die Einzelschreiber und das stille branch-main sind weg');
  const hs = codeOf(src('src/core/offers/offer-house.ts'));
  ok(!/'branch-main'|'user-owner'|saveDatabase|eventBus/.test(hs), 'HOUSE kein Ersatz-Absender, kein eigenes Speichern, kein Ereignis');
  const auto = codeOf(src('src/core/automation/automation-handlers.ts'));
  ok(!/eventBus\.on\('offer\./.test(auto), 'AUTOMATION kein Angebots-Handler mehr — die Folgen stehen in der Hausfolge');
  const inv = codeOf(src('src/stores/invoiceStore.ts'));
  const fromOffer = inv.slice(inv.indexOf('createInvoiceFromOffer: (offerId, perLineSchemes'), inv.indexOf('createDirectInvoice: (customerId, lines, notes'));
  ok(/convertOfferToInvoiceInHouse/.test(fromOffer) && !/INSERT INTO invoices|consumeLot|postInvoiceIssued|safePost/.test(fromOffer), 'INVOICE createInvoiceFromOffer baut keine eigene Rechnung mehr');
  const cmds = codeOf(src('src/core/bridge/offer-commands.ts'));
  ok(['createOfferInHouse(', 'updateOfferInHouse(', 'setOfferStatusInHouse(', 'convertOfferToInvoiceInHouse('].every((f) => cmds.includes(f))
    && (cmds.match(/assertHouseBranch\(identity\)/g) ?? []).length === 4, 'CMD der Fernbefehl ruft DIESELBE Hausfolge wie die Maske — in der Filiale, deren Bücher der Primary führt');
  const all = src('src/pages/offers/OfferDetail.tsx') + src('src/pages/offers/OfferList.tsx');
  const hooks = ['data-offer-new', 'data-offer-new-price', 'data-offer-new-valid-until', 'data-offer-new-notes', 'data-offer-create-save',
    'data-offer-row-send', 'data-offer-row-accept', 'data-offer-row-reject',
    'data-offer-edit', 'data-offer-save', 'data-offer-cancel', 'data-offer-line-price', 'data-offer-line-add', 'data-offer-add-product',
    'data-offer-line-remove', 'data-offer-notes', 'data-offer-valid-until', 'data-offer-customer-option',
    'data-offer-send', 'data-offer-accept', 'data-offer-reject', 'data-offer-create-invoice'];
  const missing = hooks.filter((h) => !all.includes(h));
  ok(missing.length === 0, `UI jede verdrahtete Stelle trägt ihren E2E-Haken (${missing.join(', ') || 'alle'})`);
}
marker('CENTRAL_UI_R6E_OFFER_UI_WIRED_PROVED');

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — r6e offer parity: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R6E_OFFER_PROVED');
