// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6E — wer eine Fernbuchung verantwortet: der AUTHENTIFIZIERTE Absender, nicht die
// Anmeldung am Primary. Run: node test/r6e/actor-attribution.test.ts
//
// Der Primary ist hier als Benutzer A angemeldet (`user-test`, die Sitzung des Prüfstands), PC2 schickt
// als Benutzer B (`user-b` in den geprüften Ansprüchen). Gefahren werden die ECHTEN Fernbefehle, die
// echten Hausfolgen und Store-Schreiber, das echte Hauptbuch und Protokoll.
//
//   §1 Vertrag (`withActingUser`, `currentUserId`, `runRemoteCommand` setzt und räumt auf)
//   §2 PC2: Rechnung + Kartenzahlung → Rechnung, Zahlung, Gebühr, Hauptbuch, Protokoll gehören B
//   §3 Primary: dieselbe Handlung → alles gehört A
//   §4 PC2: Zahlung auf eine offene Rechnung (alter C3D-Weg) → B
//   §5 Nachbar R6D: Umbuchung Kasse → Bank → B
//   §6 Spoofing: kein Rumpf nennt den Urheber   §7 danach gilt wieder A
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

const A = 'user-test';   // die Anmeldung am Primary (Sitzung des Prüfstands)
const B = 'user-b';      // der geprüfte Absender auf PC2
const store = new Map<string, string>([['lataif_session', JSON.stringify({ branchId: 'branch-main', userId: A })]]);
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
const posting = await import('../../src/core/ledger/posting.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const { applyMediaSchema } = await import('../../src/core/db/media-schema.ts');
const { currentUserId } = await import('../../src/core/db/helpers.ts');
const acting = await import('../../src/core/auth/acting-user.ts');
const engine = await import('../../src/core/bridge/mutation-engine.ts');
const invCmd = await import('../../src/core/bridge/invoice-command.ts');
const life = await import('../../src/core/bridge/invoice-lifecycle-commands.ts');
const money = await import('../../src/core/bridge/money-commands.ts');
const createHouse = await import('../../src/core/invoices/invoice-create-house.ts');
const { toInvoiceLine } = await import('../../src/core/invoices/line-derivation.ts');
const { useInvoiceStore } = await import('../../src/stores/invoiceStore.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
let seit = 0;
const marker = (m: string): void => { if (fails.length === seit) console.log(m); seit = fails.length; };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const S = (v: unknown): string => JSON.stringify(v);
const NOW = '2026-09-13T10:00:00.000Z';

interface Db { run(sql: string, p?: unknown[]): unknown; exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>; export(): Uint8Array }
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const n = (db: Db, sql: string, p: unknown[] = []): number => Number(one(db, sql, p) ?? 0);
const col = (db: Db, sql: string, p: unknown[] = []): unknown[] => (db.exec(sql, p)[0]?.values ?? []).map((v) => v[0]);
const rows = (db: Db, sql: string, p: unknown[] = []): Array<Record<string, unknown>> => {
  const r = db.exec(sql, p)[0];
  return r ? r.values.map((v) => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))) : [];
};
const MIGRATIONS = (() => {
  const d = src('src/core/db/database.ts');
  const a = d.indexOf('const migrations: string[] = [');
  return [...d.slice(a, d.indexOf('\n  ];', a)).matchAll(/`([^`]*)`/g)].map((m) => m[1]);
})();
function insert(db: Db, table: string, values: Record<string, unknown>): void {
  const cols = rows(db, `PRAGMA table_info(${table})`);
  const data: Record<string, unknown> = { ...values };
  for (const c of cols) {
    const name = String(c.name);
    if (!c.notnull || c.dflt_value !== null || c.pk || data[name] !== undefined) continue;
    data[name] = /INT|REAL|NUM/.test(String(c.type || '').toUpperCase()) ? 0 : (/_at$|date/i.test(name) ? NOW : '');
  }
  const use = Object.keys(data).filter((k) => cols.some((c) => c.name === k));
  db.run(`INSERT INTO ${table} (${use.join(', ')}) VALUES (${use.map(() => '?').join(', ')})`, use.map((k) => data[k]));
}
function freshDb(): Db {
  resetDurabilityStateForTest(); resetTransactionHealthForTest();
  const db = new SQL.Database() as unknown as Db;
  db.run(src('src/core/db/schema.sql'));
  for (const s of MIGRATIONS) { try { db.run(s); } catch { /* da */ } }
  for (const s of A1_UPGRADE_SQL) { try { db.run(s); } catch { /* da */ } }
  db.run(COMMAND_LEDGER_DDL); db.run(COMMAND_LEDGER_INDEX);
  db.run('INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES (?,?,?,?,?)', ['branch-main', 'tenant-1', 'Haupt', NOW, NOW]);
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES ('cat-w','branch-main','W','w','#000',?,?)", [NOW, NOW]);
  insert(db, 'customers', { id: 'cust-1', branch_id: 'branch-main', first_name: 'Ali', last_name: 'Hassan', created_at: NOW, updated_at: NOW });
  db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition, scope_of_delivery, purchase_price,
      purchase_currency, planned_sale_price, stock_status, tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
    VALUES ('p1','branch-main','cat-w','Rolex','M','SKU-p1',20,'Pre-Owned','[]',100,'BHD',150,'in_stock','VAT_10',0,'[]','{}','OWN',?,?)`, [NOW, NOW]);
  db.run(`INSERT INTO stock_lots (id, branch_id, product_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
    VALUES ('lot-p1','branch-main','p1',100,20,20,'ACTIVE',?,?)`, [NOW, NOW]);
  applyMediaSchema(db as never);
  setTestDatabase(db as never);
  useInvoiceStore.getState().loadInvoices();
  return db;
}
let seq = 0;
const nextId = (): string => `${String(++seq).padStart(8, '0')}-0000-4000-8000-000000000000`;
const identity = (op: string, userId = B) => ({ commandId: nextId(), tenantId: 'tenant-1', branchId: 'branch-main', userId, role: 'ADMIN', op, payloadHash: 'h' });
const deps = (db: Db) => ({ db: db as never, begin: posting.beginLedgerTransaction, commit: posting.commitLedgerTransaction,
  rollback: posting.rollbackLedgerTransaction, durableSave: async () => { /* gestellt */ }, now: () => NOW });
async function fern(fn: () => Promise<{ kind: string; value?: unknown; code?: string }>): Promise<{ kind: string; value: Record<string, unknown>; code: string }> {
  try { const o = await fn(); return { kind: o.kind, value: (o.value ?? {}) as Record<string, unknown>, code: String(o.code ?? '') }; }
  catch (e) { return { kind: 'thrown', value: {}, code: String((e as { code?: unknown }).code ?? (e as Error).message) }; }
}
/** Die Urheber aller Zeilen einer Tabelle, die NACH `rowid > vorher` entstanden sind. */
const urheber = (db: Db, table: string, spalte: string, vorher: number): string[] =>
  [...new Set(col(db, `SELECT ${spalte} FROM ${table} WHERE rowid > ?`, [vorher]).map(String))];
const maxRow = (db: Db, table: string): number => n(db, `SELECT COALESCE(MAX(rowid), 0) FROM ${table}`);
const REMOTE_BODY = { customerId: 'cust-1', lines: [{ productId: 'p1', quantity: 1, unitPrice: 100, scheme: 'VAT_10' }] };

// ══ §1 — der Vertrag ═════════════════════════════════════════════════════════
{
  ok(currentUserId() === A && acting.actingUserId() === null, 'VERTRAG außerhalb eines Fernauftrags gilt die Anmeldung am Primary');
  const drin = await acting.withActingUser(B, () => currentUserId());
  ok(drin === B && currentUserId() === A, 'VERTRAG während des Fernauftrags der Absender, danach wieder A');
  const verschachtelt = await acting.withActingUser(B, async () => {
    const innen = await acting.withActingUser('user-c', () => currentUserId());
    return [innen, currentUserId()];
  });
  ok(S(verschachtelt) === S(['user-c', B]) && currentUserId() === A, 'VERTRAG verschachtelt stellt den vorigen Urheber wieder her');
  let t = ''; try { await acting.withActingUser(B, () => { throw new Error('boom'); }); } catch (e) { t = String(e); }
  ok(/boom/.test(t) && currentUserId() === A, 'VERTRAG ein Fehler räumt genauso auf');
  let leer = ''; try { await acting.withActingUser('', () => 1); } catch (e) { leer = String(e); }
  ok(/authenticated user/.test(leer), 'VERTRAG ohne geprüften Absender kein Fernauftrag');

  const db = freshDb();
  const gesehen: string[] = [];
  const r1 = await engine.runRemoteCommand(deps(db) as never, identity('probe.x') as never, () => { gesehen.push(currentUserId()); return { ok: 1 }; });
  const r2 = await engine.runRemoteCommand(deps(db) as never, identity('probe.y') as never, () => { gesehen.push(currentUserId()); throw new engine.CommandRejected('NO', 'no'); });
  let t3 = ''; try { await engine.runRemoteCommand(deps(db) as never, identity('probe.z') as never, async () => { await Promise.resolve(); gesehen.push(currentUserId()); throw new Error('stoerung'); }); } catch (e) { t3 = String(e); }
  ok(r1.kind === 'ok' && r2.kind === 'rejected' && /stoerung/.test(t3) && S(gesehen) === S([B, B, B]),
    `VERTRAG runRemoteCommand setzt den Absender — auch über ein await hinweg (${S(gesehen)})`);
  ok(currentUserId() === A, 'VERTRAG …und nach Erfolg, Urteil und Störung gilt wieder A');
  const eng = src('src/core/bridge/mutation-engine.ts');
  ok(/withActingUser\(identity\.userId, \(\) => handler\(db\)\)/.test(eng), 'VERTRAG der Absender kommt aus der geprüften Kennung (identity.userId), nie aus dem Rumpf');
  ok(/actingUserId\(\) \?\? authService\.getCurrentUserId\(\)/.test(src('src/core/db/helpers.ts')), 'VERTRAG currentUserId() fragt zuerst den laufenden Fernauftrag — eine Stelle für alle Schreiber');
}
marker('CENTRAL_UI_R6E_ACTOR_CONTRACT_PINNED');

// ══ §2 — PC2 (B): Rechnung + Kartenzahlung ═══════════════════════════════════
let remoteInvoice = '';
{
  const db = freshDb();
  const v = { inv: maxRow(db, 'invoices'), pay: maxRow(db, 'payments'), led: maxRow(db, 'ledger_entries'), exp: maxRow(db, 'expenses'), aud: maxRow(db, 'audit_log') };
  const r = await fern(() => invCmd.runInvoiceCreate(deps(db) as never, identity('invoices.create') as never,
    { ...REMOTE_BODY, payment: { amount: 110, method: 'card', cardBrand: 'normal' } }));
  ok(r.kind === 'ok', `PC2 angelegt und bezahlt (${r.kind} ${r.code})`);
  remoteInvoice = String(r.value.invoiceId ?? '');
  ok(S(urheber(db, 'invoices', 'created_by', v.inv)) === S([B]), `PC2 die Rechnung gehört B (${S(urheber(db, 'invoices', 'created_by', v.inv))})`);
  ok(S(urheber(db, 'payments', 'created_by', v.pay)) === S([B]), `PC2 die Zahlung gehört B (${S(urheber(db, 'payments', 'created_by', v.pay))})`);
  ok(n(db, 'SELECT COUNT(*) FROM ledger_entries WHERE rowid > ?', [v.led]) >= 4 && S(urheber(db, 'ledger_entries', 'created_by', v.led)) === S([B]),
    `PC2 jede neue Hauptbuchzeile gehört B (${S(urheber(db, 'ledger_entries', 'created_by', v.led))})`);
  const gebuehr = urheber(db, 'expenses', 'created_by', v.exp);
  ok(gebuehr.length === 1 && gebuehr[0] === B, `PC2 die automatische Kartengebühr gehört B (${S(gebuehr)})`);
  const prot = urheber(db, 'audit_log', 'changed_by', v.aud);
  ok(prot.length > 0 && prot.every((u) => u === B), `PC2 das Protokoll nennt B (${S(prot)})`);
  ok(currentUserId() === A, 'PC2 …und der Primary bleibt als A angemeldet');
}
marker('CENTRAL_UI_R6E_REMOTE_INVOICE_ACTOR_PROVED');

// ══ §3 — Primary (A): dieselbe Handlung ══════════════════════════════════════
{
  const db = freshDb();
  const v = { inv: maxRow(db, 'invoices'), pay: maxRow(db, 'payments'), led: maxRow(db, 'ledger_entries'), aud: maxRow(db, 'audit_log') };
  const line = toInvoiceLine({ productId: 'p1', lotId: 'lot-p1', quantity: 1, unitPrice: 100, costBasis: 100, scheme: 'VAT_10' });
  let fehler = '';
  try { await createHouse.createInvoiceOnPrimary({ customerId: 'cust-1', lines: [line], specialMark: false, payment: { amount: 110, method: 'card', cardBrand: 'normal' } as never }); }
  catch (e) { fehler = String(e); }
  ok(fehler === '', `PRIMARY angelegt und bezahlt (${fehler})`);
  ok(S(urheber(db, 'invoices', 'created_by', v.inv)) === S([A]) && S(urheber(db, 'payments', 'created_by', v.pay)) === S([A])
    && S(urheber(db, 'ledger_entries', 'created_by', v.led)) === S([A]),
  'PRIMARY eine lokale Handlung von A gehört A — Rechnung, Zahlung, Hauptbuch');
  const prot = urheber(db, 'audit_log', 'changed_by', v.aud);
  ok(prot.every((u) => u === A), `PRIMARY das Protokoll nennt A (${S(prot)})`);
}
marker('CENTRAL_UI_R6E_LOCAL_ACTOR_PROVED');

// ══ §4 — PC2 (B): Zahlung auf eine offene Rechnung (C3D-Weg) ═════════════════
{
  const db = freshDb();
  const offen = await fern(() => invCmd.runInvoiceCreate(deps(db) as never, identity('invoices.create', 'user-c') as never, REMOTE_BODY));
  const invoiceId = String(offen.value.invoiceId ?? '');
  const v = { pay: maxRow(db, 'payments'), led: maxRow(db, 'ledger_entries') };
  const r = await fern(() => life.runInvoicePayment(deps(db) as never, identity('invoices.record_payment') as never, { invoiceId, amount: 50, method: 'cash' }));
  ok(offen.kind === 'ok' && r.kind === 'ok', `C3D Zahlung angenommen (${offen.code} ${r.code})`);
  ok(one(db, 'SELECT created_by FROM invoices WHERE id = ?', [invoiceId]) === 'user-c', 'C3D die Rechnung bleibt beim Absender, der sie angelegt hat (user-c)');
  ok(S(urheber(db, 'payments', 'created_by', v.pay)) === S([B]) && S(urheber(db, 'ledger_entries', 'created_by', v.led)) === S([B]),
    'C3D die Zahlung und ihre Buchung gehören dem, der gezahlt hat (B)');
}
marker('CENTRAL_UI_R6E_REMOTE_PAYMENT_ACTOR_PROVED');

// ══ §5 — Nachbar R6D: Umbuchung Kasse → Bank ═════════════════════════════════
{
  const db = freshDb();
  const v = { bt: maxRow(db, 'bank_transfers'), led: maxRow(db, 'ledger_entries') };
  const r = await fern(() => money.runBankTransfer(deps(db) as never, identity('banking.transfer') as never,
    { direction: 'CASH_TO_BANK', amount: 25, transferDate: '2026-09-13' }));
  ok(r.kind === 'ok', `R6D Umbuchung angenommen (${r.code})`);
  ok(S(urheber(db, 'bank_transfers', 'created_by', v.bt)) === S([B]) && S(urheber(db, 'ledger_entries', 'created_by', v.led)) === S([B]),
    'R6D Umbuchung und ihre zwei Beine gehören B');
}
marker('CENTRAL_UI_R6E_R6D_NEIGHBOUR_ACTOR_PROVED');

// ══ §6 — Spoofing: kein Rumpf nennt den Urheber ══════════════════════════════
{
  const db = freshDb();
  const vorher = { inv: n(db, 'SELECT COUNT(*) FROM invoices'), pay: n(db, 'SELECT COUNT(*) FROM payments'), bt: n(db, 'SELECT COUNT(*) FROM bank_transfers'), led: n(db, 'SELECT COUNT(*) FROM ledger_entries') };
  for (const f of ['createdBy', 'userId', 'created_by', 'actor']) {
    const r = await fern(() => invCmd.runInvoiceCreate(deps(db) as never, identity('invoices.create') as never, { ...REMOTE_BODY, [f]: 'user-evil' }));
    ok(r.kind === 'thrown', `SPOOF invoices.create mit ${f} wird abgewiesen (${r.code})`);
    const z = await fern(() => invCmd.runInvoiceCreate(deps(db) as never, identity('invoices.create') as never,
      { ...REMOTE_BODY, payment: { amount: 10, method: 'cash', [f]: 'user-evil' } }));
    ok(z.kind === 'thrown', `SPOOF die Zahlung darin mit ${f} wird abgewiesen (${z.code})`);
  }
  const p = await fern(() => life.runInvoicePayment(deps(db) as never, identity('invoices.record_payment') as never,
    { invoiceId: remoteInvoice || 'x', amount: 5, method: 'cash', createdBy: 'user-evil' }));
  ok(p.kind === 'thrown', `SPOOF invoices.record_payment mit createdBy wird abgewiesen (${p.code})`);
  const b = await fern(() => money.runBankTransfer(deps(db) as never, identity('banking.transfer') as never,
    { direction: 'CASH_TO_BANK', amount: 5, transferDate: '2026-09-13', createdBy: 'user-evil' }));
  ok(b.kind === 'thrown', `SPOOF banking.transfer mit createdBy wird abgewiesen (${b.code})`);
  ok(n(db, 'SELECT COUNT(*) FROM invoices') === vorher.inv && n(db, 'SELECT COUNT(*) FROM payments') === vorher.pay
    && n(db, 'SELECT COUNT(*) FROM bank_transfers') === vorher.bt && n(db, 'SELECT COUNT(*) FROM ledger_entries') === vorher.led,
  'SPOOF …und nichts wurde geschrieben');
  ok(n(db, "SELECT COUNT(*) FROM ledger_entries WHERE created_by = 'user-evil'") === 0, 'SPOOF kein Zeile trägt den behaupteten Urheber');
}
marker('CENTRAL_UI_R6E_ACTOR_SPOOFING_REJECTED');

// ══ §7 — danach gilt wieder A ════════════════════════════════════════════════
ok(currentUserId() === A && acting.actingUserId() === null, 'NACHHER nach allen Fernaufträgen ist kein Absender liegen geblieben');
marker('CENTRAL_UI_REMOTE_ACTOR_ATTRIBUTION_PROVED');

console.log(fails.length === 0 ? `PASS — r6e actor attribution: ${PASS} passed, 0 failed` : `FAIL — r6e actor attribution: ${PASS} passed, ${fails.length} failed`);
process.exit(fails.length === 0 ? 0 : 1);
