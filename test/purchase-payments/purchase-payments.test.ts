// ════════════════════════════════════════════════════════════════════════════
// v0.8.91 DESKTOP PURCHASE MULTI-PAYMENT — mehrere Zahlungen beim Anlegen eines Einkaufs, je mit eigenem Tag.
// Echte sql.js-Datenbank (schema.sql + echte Migrationen + A1 + Medienschema), echte Stores, echte Hausfolge
// (`createPurchaseDetailedInHouse`), echter Fernbefehl (`purchases.create`), echtes Hauptbuch, Banking.
// Relative Daten (heute / Vortage) — der Test ist an jedem Tag gleich.
// Run: node --experimental-strip-types test/purchase-payments/purchase-payments.test.ts
//
//   A  Cash 400 + Bank 350 + Benefit 250 auf 1000: PAID, drei Zahlungen an ihren Tagen (Liste, Hauptbuch, Banking),
//      Kasse/Bank/Benefit belastet, Lieferantenschuld 0
//   B  Teilzahlung: PARTIALLY_PAID, offen 700, Lieferantenschuld 700
//   C  Grenzen: Überzahlung, Tag vor dem Einkauf, Zukunft, falsche Form — Nein, nichts angelegt
//   D  ohne Tag (wie vom Telefon): das Einkaufsdatum, wie bisher
//   E  Atomarität: scheitert die dritte Zahlung, gibt es keinen Einkauf, keinen Artikel, kein Los, keine Buchung
//   F  PC2: derselbe Rumpf fern == Primary; Wiederholung derselben Kennung ohne zweite Wirkung; Rumpfregeln;
//      der bisherige Einzelrumpf (paymentAmount) geht weiter
//   G  die Maske: Zahlungszeilen mit Weg, Betrag, Tag, Referenz; schickt `payments` mit `paidDate`
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
  ['lataif_sync_url', 'http://127.0.0.1:9/sync'],
  ['lataif_sync_token', 'test-token'],
]);
const storage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};
(globalThis as { localStorage?: unknown }).localStorage = storage;
(globalThis as { window?: unknown }).window = { localStorage: storage, confirm: () => true };

const initSqlJs = (await import('sql.js')).default;
const SQL = await initSqlJs({ locateFile: (f: string) => resolvePath(repo, 'node_modules/sql.js/dist', f) });

const { setTestDatabase } = await import('../sync/_db-shim.ts');
const { tauriState } = await import('../bridge/_tauri-shim.ts');
const { COMMAND_LEDGER_DDL, COMMAND_LEDGER_INDEX } = await import('../../src/core/bridge/command-ledger.ts');
const { resetDurabilityStateForTest } = await import('../../src/core/bridge/durability-state.ts');
const { resetTransactionHealthForTest } = await import('../../src/core/db/transaction-health.ts');
const { installWriteGuard } = await import('../../src/core/db/write-guard.ts');
const { SKU_SEQUENCES_DDL } = await import('../../src/core/products/sku-sequence.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const { applyMediaSchema } = await import('../../src/core/db/media-schema.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { useSupplierStore } = await import('../../src/stores/supplierStore.ts');
const { usePurchaseStore } = await import('../../src/stores/purchaseStore.ts');
const { useAuthStore } = await import('../../src/stores/authStore.ts');
const { bankTransactionsFor } = await import('../../src/stores/bankingStore.ts');
const cmd = await import('../../src/core/bridge/commercial-commands.ts');
const purchaseHouse = await import('../../src/core/purchases/purchase-house.ts');
const purchaseRules = await import('../../src/core/purchases/purchase-create.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const S = (v: unknown): string => JSON.stringify(v);
const NOW = new Date().toISOString();
const TODAY = NOW.slice(0, 10);
const dayBefore = (d: string, k: number): string => new Date(Date.parse(d + 'T00:00:00.000Z') - k * 86400000).toISOString().slice(0, 10);
const T3 = dayBefore(TODAY, 3);
const T2 = dayBefore(TODAY, 2);
const r3 = (v: unknown): number => Math.round((Number(v) || 0) * 1000) / 1000;

interface Db {
  run(sql: string, p?: unknown[]): unknown;
  exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
}
const rows = (db: Db, sql: string, p: unknown[] = []): Array<Record<string, unknown>> => {
  const r = db.exec(sql, p)[0];
  return r ? r.values.map((v) => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))) : [];
};
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const n = (db: Db, sql: string, p: unknown[] = []): number => Number(one(db, sql, p) ?? 0);

function realMigrations(): string[] {
  const dbSrc = src('src/core/db/database.ts');
  const start = dbSrc.indexOf('const migrations: string[] = [');
  const end = dbSrc.indexOf('\n  ];', start);
  return [...dbSrc.slice(start, end).matchAll(/`([^`]*)`/g)].map((m) => m[1]);
}
const MIGRATIONS = realMigrations();
function reload(): void {
  useProductStore.getState().loadProducts();
  useSupplierStore.getState().loadSuppliers();
  usePurchaseStore.getState().loadPurchases();
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
  db.run(SKU_SEQUENCES_DDL);
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-main','tenant-1','Haupt',?,?)", [NOW, NOW]);
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES ('cat-w','branch-main','Watch','w','#000',?,?)", [NOW, NOW]);
  db.run("INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at) VALUES ('sup-1','branch-main','Lieferant A',1,?,?)", [NOW, NOW]);
  applyMediaSchema(db as never);
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  reload();
  tauriState.reset();
  return db;
}
useAuthStore.setState({ session: { userId: 'user-test', branchId: 'branch-main', role: 'ADMIN' } as never });

function imHaus<T>(fn: () => T): T {
  posting.beginLedgerTransaction();
  try { const out = fn(); posting.commitLedgerTransaction(); return out; }
  catch (e) { posting.rollbackLedgerTransaction(); throw e; }
}
function meldung(fn: () => unknown): string {
  try { fn(); return ''; } catch (e) { return String((e as { code?: unknown }).code ?? '') + '|' + (e as Error).message; }
}
const code = (m: string): string => m.split('|')[0];
let sku = 0;
const ZEILE = (preis: number) => ({
  mode: 'new' as const, brand: 'Rolex', name: `Datejust ${++sku}`, sku: `SKU-PP-${sku}`, categoryId: 'cat-w', quantity: 1, unitPrice: preis,
  newProduct: { categoryId: 'cat-w', brand: 'Rolex', name: `Datejust ${sku}`, sku: `SKU-PP-${sku}`, taxScheme: 'MARGIN' },
});
const EINKAUF = (payments?: unknown[], extra: Record<string, unknown> = {}) => ({
  supplierId: 'sup-1', purchaseDate: T3, taxScheme: 'ZERO', lines: [ZEILE(600), ZEILE(400)],
  paymentAmount: 0, paymentMethod: 'bank', notes: '', staffId: '',
  ...(payments ? { payments } : {}), ...extra,
});
const anlegen = (input: Record<string, unknown>) => {
  const r = imHaus(() => purchaseHouse.createPurchaseDetailedInHouse(input as never, 'branch-main', 'user-test'));
  reload();
  return r.purchase;
};
const zahlungen = (db: Db, pid: string) => rows(db, 'SELECT amount, method, substr(paid_at, 1, 10) AS d, reference FROM purchase_payments WHERE purchase_id = ? ORDER BY rowid', [pid]);
const saldo = (db: Db, account: string): number => r3(n(db, "SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END), 0) FROM ledger_entries WHERE account = ?", [account]));
const ausgeglichen = (db: Db): boolean => rows(db, "SELECT ROUND(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END), 3) AS d FROM ledger_entries GROUP BY transaction_id").every((r) => Number(r.d) === 0);
const alles = (db: Db): string => S(['purchases', 'purchase_lines', 'products', 'stock_lots', 'purchase_payments', 'ledger_entries'].map((t) => n(db, `SELECT COUNT(*) FROM ${t}`)));
const DREI = [
  { amount: 400, method: 'cash', paidDate: T3 },
  { amount: 350, method: 'bank', paidDate: T2, reference: 'TR-77' },
  { amount: 250, method: 'benefit', paidDate: TODAY },
];

// ══ A — drei Wege, drei Tage ═══════════════════════════════════════════════════
{
  const db = freshDb();
  const p = anlegen(EINKAUF(DREI));
  const z = zahlungen(db, p.id);
  ok(String(one(db, 'SELECT status FROM purchases WHERE id = ?', [p.id])) === 'PAID' && r3(one(db, 'SELECT paid_amount FROM purchases WHERE id = ?', [p.id])) === 1000
    && r3(one(db, 'SELECT remaining_amount FROM purchases WHERE id = ?', [p.id])) === 0,
  `A Einkauf 1000, drei Zahlungen: PAID, bezahlt 1000, offen 0 (${one(db, 'SELECT status FROM purchases WHERE id = ?', [p.id])})`);
  ok(S(z) === S([{ amount: 400, method: 'cash', d: T3, reference: null }, { amount: 350, method: 'bank', d: T2, reference: 'TR-77' }, { amount: 250, method: 'benefit', d: TODAY, reference: null }]),
    `A jede Zahlung mit Weg, Tag und Referenz (${S(z)})`);
  const pays = rows(db, 'SELECT id FROM purchase_payments WHERE purchase_id = ? ORDER BY rowid', [p.id]).map((r) => String(r.id));
  const tage = pays.map((id) => [...new Set(rows(db, "SELECT substr(occurred_at, 1, 10) AS d FROM ledger_entries WHERE source_module = 'PURCHASE_PAYMENT' AND source_id = ?", [id]).map((r) => r.d))]);
  ok(S(tage) === S([[T3], [T2], [TODAY]]), `A die Buchung jeder Zahlung trägt ihren Tag (${S(tage)})`);
  ok(saldo(db, 'CASH') === -400 && saldo(db, 'BANK') === -350 && saldo(db, 'BENEFIT') === -250 && saldo(db, 'ACCOUNTS_PAYABLE') === 0 && ausgeglichen(db),
    `A Kasse −400, Bank −350, Benefit −250, Lieferantenschuld 0, Hauptbuch ausgeglichen (${saldo(db, 'CASH')} / ${saldo(db, 'BANK')} / ${saldo(db, 'BENEFIT')} / ${saldo(db, 'ACCOUNTS_PAYABLE')})`);
  const bt = (bankTransactionsFor({ tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test', role: 'ADMIN' } as never, []) as Array<{ account: string; amount: number; flow: string; date: string; relatedEntityId?: string }>)
    .filter((t) => t.relatedEntityId === p.id).map((t) => `${t.account}:${t.flow}:${t.amount}:${String(t.date).slice(0, 10)}`).sort();
  ok(S(bt) === S([`bank:out:350:${T2}`, `benefit:out:250:${TODAY}`, `cash:out:400:${T3}`]), `A Banking zeigt jede Zahlung an ihrem Tag auf ihrem Konto (${S(bt)})`);
}

// ══ B — Teilzahlung ═════════════════════════════════════════════════════════════
{
  const db = freshDb();
  const p = anlegen(EINKAUF([{ amount: 200, method: 'cash', paidDate: T3 }, { amount: 100, method: 'bank', paidDate: T2 }]));
  ok(String(one(db, 'SELECT status FROM purchases WHERE id = ?', [p.id])) === 'PARTIALLY_PAID' && r3(one(db, 'SELECT remaining_amount FROM purchases WHERE id = ?', [p.id])) === 700
    && saldo(db, 'ACCOUNTS_PAYABLE') === -700,
  `B Teilzahlung 300: PARTIALLY_PAID, offen 700, Lieferantenschuld 700 (${one(db, 'SELECT status FROM purchases WHERE id = ?', [p.id])} / ${saldo(db, 'ACCOUNTS_PAYABLE')})`);
}

// ══ C — Grenzen ═════════════════════════════════════════════════════════════════
{
  const db = freshDb();
  const vor = alles(db);
  const ueber = meldung(() => anlegen(EINKAUF([{ amount: 600, method: 'cash', paidDate: T3 }, { amount: 401, method: 'bank', paidDate: T3 }])));
  const frueh = meldung(() => anlegen(EINKAUF([{ amount: 100, method: 'cash', paidDate: dayBefore(TODAY, 5) }])));
  const zukunft = meldung(() => anlegen(EINKAUF([{ amount: 100, method: 'cash', paidDate: '2099-01-01' }])));
  const form = meldung(() => anlegen(EINKAUF([{ amount: 100, method: 'cash', paidDate: '25.10.2026' }])));
  ok(code(ueber) === 'PAYMENT_EXCEEDS_TOTAL' && code(frueh) === 'PAYMENT_DATE_BEFORE_PURCHASE' && code(zukunft) === 'PAYMENT_DATE_INVALID' && code(form) === 'PAYMENT_DATE_INVALID' && alles(db) === vor,
    `C Überzahlung / vor dem Einkauf / Zukunft / falsche Form: Nein, nichts angelegt (${[ueber, frueh, zukunft, form].map(code).join(' / ')})`);
  ok(code(meldung(() => anlegen(EINKAUF([{ amount: 100, method: 'card' }])))) === 'PAYMENT_METHOD_INVALID' && alles(db) === vor, 'C nur Cash, Bank, Benefit');
}

// ══ D — ohne Tag (wie vom Telefon) ══════════════════════════════════════════════
{
  const db = freshDb();
  const p = anlegen(EINKAUF([{ amount: 300, method: 'cash' }, { amount: 200, method: 'benefit' }]));
  ok(S(zahlungen(db, p.id).map((z) => z.d)) === S([T3, T3]), `D ohne eigenen Tag: das Einkaufsdatum, wie bisher (${S(zahlungen(db, p.id).map((z) => z.d))})`);
}

// ══ E — Atomarität ══════════════════════════════════════════════════════════════
{
  const db = freshDb();
  db.run("CREATE TRIGGER pp_bruch BEFORE INSERT ON purchase_payments WHEN NEW.method = 'benefit' BEGIN SELECT RAISE(ABORT, 'PP: injected'); END");
  const vor = alles(db);
  const bruch = meldung(() => anlegen(EINKAUF(DREI)));
  db.run('DROP TRIGGER pp_bruch');
  ok(/PP: injected/.test(bruch) && alles(db) === vor, `E scheitert die dritte Zahlung: kein Einkauf, kein Artikel, kein Los, keine Zahlung, keine Buchung (${bruch.slice(0, 50)})`);
}

// ══ F — PC2 ═════════════════════════════════════════════════════════════════════
{
  const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-000000000000`;
  const ident = (x: string) => ({ commandId: ID(x), tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role: 'ADMIN', op: 'purchases.create', payloadHash: 'h' + x });
  const deps = (db: Db) => ({ db: db as never, begin: () => { setTestDatabase(db as never); posting.beginLedgerTransaction(); },
    commit: posting.commitLedgerTransaction, rollback: posting.rollbackLedgerTransaction, durableSave: async () => {}, now: () => new Date().toISOString() });
  const bild = (db: Db, pid: string) => S({
    kopf: rows(db, 'SELECT status, total_amount, paid_amount, remaining_amount, purchase_date FROM purchases WHERE id = ?', [pid]),
    pay: zahlungen(db, pid),
    salden: ['CASH', 'BANK', 'BENEFIT', 'ACCOUNTS_PAYABLE', 'INVENTORY'].map((a) => saldo(db, a)),
  });
  sku = 0;
  const dbP = freshDb();
  const input = EINKAUF(DREI);
  const pP = anlegen(input);
  const bP = bild(dbP, pP.id);
  sku = 0;
  const dbR = freshDb();
  const body = await purchaseRules.purchaseCreateBody(EINKAUF(DREI) as never, async () => []);
  ok(Array.isArray(body.payments) && !('paymentAmount' in body) && !('paymentMethod' in body) && S((body.payments as Array<{ paidDate?: string }>).map((p) => p.paidDate)) === S([T3, T2, TODAY]),
    'F der Rumpf trägt die Liste mit Tagen und kein Einzelfeld daneben');
  const r = await cmd.runPurchaseCreate(deps(dbR) as never, ident('81') as never, body) as { kind: string; value?: Record<string, unknown>; code?: string };
  setTestDatabase(dbR as never); reload();
  const pidR = String(r.value?.purchaseId ?? '');
  ok(r.kind === 'ok' && bild(dbR, pidR) === bP, `F PC2 == Primary: Kopf, Zahlungen (Weg, Tag, Referenz), Salden (${r.kind} ${r.code ?? ''})\n  P=${bP}\n  R=${bild(dbR, pidR)}`);
  const vorW = alles(dbR);
  const r2 = await cmd.runPurchaseCreate(deps(dbR) as never, ident('81') as never, body) as { kind: string; replayed?: boolean };
  setTestDatabase(dbR as never);
  ok(r2.kind === 'ok' && r2.replayed === true && alles(dbR) === vorW, 'F dieselbe Kennung noch einmal (Doppelklick / Verbindungsabbruch): Wiederholung, kein zweiter Einkauf, keine zweite Zahlung');
  const rumpf = (raw: unknown): string => { try { cmd.parsePurchaseCreate(raw); return ''; } catch (e) { return (e as Error).message; } };
  const basis = { supplierId: 'sup-1', purchaseDate: T3, taxScheme: 'ZERO', lines: [{ mode: 'new', brand: 'Rolex', name: 'X', sku: 'X1', categoryId: 'cat-w', quantity: 1, unitPrice: 10 }] };
  ok(/unknown field/.test(rumpf({ ...basis, payments: [{ amount: 1, method: 'cash', fee: 1 }] }))
    && /not both/.test(rumpf({ ...basis, paymentAmount: 1, payments: [{ amount: 1, method: 'cash' }] }))
    && rumpf({ ...basis, payments: [{ amount: 1, method: 'cash', paidDate: T3 }] }) === ''
    && rumpf({ ...basis, payments: [{ amount: 1, method: 'cash' }] }) === '',
  'F Rumpfregeln: paidDate erlaubt (und weggelassen wie vom Telefon), Unbekanntes nicht, nicht beides');
  const alt = await cmd.runPurchaseCreate(deps(dbR) as never, ident('82') as never,
    await purchaseRules.purchaseCreateBody(EINKAUF(undefined, { paymentAmount: 300, paymentMethod: 'cash' }) as never, async () => [])) as { kind: string; value?: Record<string, unknown> };
  setTestDatabase(dbR as never); reload();
  ok(alt.kind === 'ok' && S(zahlungen(dbR, String(alt.value?.purchaseId)).map((z) => [z.amount, z.method])) === S([[300, 'cash']]), 'F der bisherige Einzelrumpf (paymentAmount) geht weiter');
}

// ══ G — die Maske ═══════════════════════════════════════════════════════════════
{
  const m = src('src/pages/purchases/PurchaseCreate.tsx');
  ok(/data-purchase-pay-add/.test(m) && /data-purchase-pay-remove/.test(m) && /data-purchase-pay-date/.test(m) && /data-purchase-pay-reference/.test(m)
    && /label="AMOUNT \(BHD\)"/.test(m) && /MAX_PURCHASE_PAYMENTS = 10/.test(m),
  'G Zahlungszeilen: hinzufügen, entfernen, Betrag, Tag, Referenz; höchstens 10');
  ok(/payments: zahlungen/.test(m) && /paidDate: r\.date/.test(m) && /paymentAmount: 0, paymentMethod: 'bank'/.test(m) && !/setPaymentAmount/.test(m),
    'G die Maske schickt die Liste mit Tagen; das alte Einzelfeld ist weg');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — purchase payments v0.8.91: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
