// ════════════════════════════════════════════════════════════════════════════
// v0.8.90 CARD FEE EDIT — „Edit Expense" bucht eine automatische Kartengebühr gegen das Karten-Clearing (vorher als
// offene Verbindlichkeit), und „Data Repairs" bucht so falsch gebuchte Gebühren mit Beweis richtig um.
// Echte sql.js-Datenbank (schema.sql + echte Migrationen + A1 + Medienschema), echte Stores und Hausfolgen, echter
// Fernbefehl (`expenses.update`), echtes Hauptbuch, die Abstimmung der App (`reconciliationSnapshotFor`).
// Run: node --experimental-strip-types test/card-fee-edit/card-fee-edit.test.ts
//
//   A  Fix: Datum/Betrag einer Kartengebühr → DR Aufwand / CR Karten-Clearing; Betrag bleibt bezahlt; Banking ==
//      Hauptbuch; Kategorie/Zahlweg gesperrt; nicht in/aus einem eingereichten Quartal; normale Ausgabe unverändert
//      (Verbindlichkeit); PC2 (`expenses.update`) == Primary
//   B  Reparatur: der alte Fehler nachgestellt → Vorschau mit Beweis; nur Admin, nur mit Grund; Storno + richtige
//      Buchung am selben Tag, Protokoll, Historie bleibt; danach sauber und nicht wiederholbar; gesperrte Fälle
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
await import('../../src/core/automation/automation-handlers.ts');
const { useInvoiceStore } = await import('../../src/stores/invoiceStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { useCustomerStore } = await import('../../src/stores/customerStore.ts');
const { useSupplierStore } = await import('../../src/stores/supplierStore.ts');
const { usePurchaseStore } = await import('../../src/stores/purchaseStore.ts');
const { useAuthStore } = await import('../../src/stores/authStore.ts');
const { bankTransactionsFor } = await import('../../src/stores/bankingStore.ts');
const house = await import('../../src/core/invoices/invoice-create-house.ts');
const payables = await import('../../src/core/payables/payables-house.ts');
const payCmd = await import('../../src/core/bridge/payables-commands.ts');
const repair = await import('../../src/core/finance/card-fee-repair.ts');
const { reconciliationSnapshotFor } = await import('../../src/core/reports/reconciliation-snapshot.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const S = (v: unknown): string => JSON.stringify(v);
const NOW = new Date().toISOString();
const TODAY = NOW.slice(0, 10);
const dayBefore = (d: string, n: number): string => new Date(Date.parse(d + 'T00:00:00.000Z') - n * 86400000).toISOString().slice(0, 10);
const YESTERDAY = dayBefore(TODAY, 1);
const T3 = dayBefore(TODAY, 3);
const ALT = dayBefore(TODAY, 100);
const eq = (a: number, b: number): boolean => Math.abs(a - b) < 0.0005;

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
  useCustomerStore.getState().loadCustomers();
  useSupplierStore.getState().loadSuppliers();
  usePurchaseStore.getState().loadPurchases();
  useInvoiceStore.getState().loadInvoices();
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
  db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level,
      preferences, customer_type, sales_stage, created_at, updated_at)
    VALUES ('cust-1','branch-main','Test','Kunde','BH','en',0,'[]','collector','active',?,?)`, [NOW, NOW]);
  db.run("INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at) VALUES ('sup-1','branch-main','Lieferant A',1,?,?)", [NOW, NOW]);
  db.run("INSERT OR REPLACE INTO settings (branch_id, key, value, category, updated_at) VALUES ('branch-main','finance.card_fee_rate','2.2','finance',?)", [NOW]);
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
const CTX = () => ({ branchId: 'branch-main', userId: 'user-test', now: new Date().toISOString() });
const RCTX = (role = 'ADMIN') => ({ ...CTX(), role });
const RCTX_READ = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test', role: 'ADMIN' };

function ware(price = 400): string {
  const p = imHaus(() => usePurchaseStore.getState().createPurchase({
    supplierId: 'sup-1', purchaseDate: dayBefore(TODAY, 5),
    lines: [{ newProduct: { categoryId: 'cat-w', brand: 'Rolex', name: 'Datejust', sku: `SKU-${Math.random().toString(36).slice(2, 8)}`, taxScheme: 'ZERO' } as never, quantity: 1, unitPrice: price, taxScheme: 'ZERO' as const, vatRate: 0 }],
  }));
  reload();
  return p.lines[0].productId!;
}
/** Eine Rechnung über 500, bezahlt per Karte (Normal, 2,2 % → 11) am Vortag. */
function kartenverkauf(): { invoiceId: string; feeId: string; paymentId: string } {
  const p = ware(300);
  const out = imHaus(() => house.createInvoiceInHouse({
    customerId: 'cust-1', specialMark: false, issuedDate: YESTERDAY,
    lines: [{ productId: p, quantity: 1, unitPrice: 500, purchasePrice: 0, taxScheme: 'ZERO', vatRate: 0, vatAmount: 0, lineTotal: 500 }],
    payments: [{ amount: 500, method: 'card', cardBrand: 'normal' }],
  } as never, 'branch-main'));
  reload();
  const feeId = String(one(current, "SELECT id FROM expenses WHERE category = 'CardFees' AND related_entity_id = ?", [out.invoiceId]));
  return { invoiceId: out.invoiceId, feeId, paymentId: String(out.paymentId) };
}
let current: Db;
const saldo = (db: Db, account: string): number => Math.round(n(db, "SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END), 0) FROM ledger_entries WHERE account = ?", [account]) * 1000) / 1000;
/** Die Verbindlichkeit aus DIESER Gebühr (der Testeinkauf ist unbezahlt und steht zu Recht in den Verbindlichkeiten). */
const apGebuehr = (db: Db, id: string): number => Math.round(n(db, "SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END), 0) FROM ledger_entries WHERE account = 'ACCOUNTS_PAYABLE' AND source_module = 'EXPENSE' AND source_id = ?", [id]) * 1000) / 1000;
const ausgeglichen = (db: Db): boolean => rows(db, "SELECT transaction_id, ROUND(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END), 3) AS d FROM ledger_entries GROUP BY transaction_id").every((r) => Number(r.d) === 0);
const lebend = (db: Db, id: string) => rows(db, `SELECT account, direction, amount, substr(occurred_at, 1, 10) AS d FROM ledger_entries e1
  WHERE source_module = 'EXPENSE' AND source_id = ? AND reverses_entry_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM ledger_entries e2 WHERE e2.reverses_entry_id = e1.id) ORDER BY account`, [id]);
const abstimmungSauber = (): boolean => {
  const s = reconciliationSnapshotFor(RCTX_READ) as { rows: Array<{ ledger: number; domain: number }>; branchImbalance: number };
  return s.rows.every((r) => Math.abs(r.ledger - r.domain) < 0.01) && Math.abs(s.branchImbalance) < 0.005;
};
const apDiff = (): number => {
  const s = reconciliationSnapshotFor(RCTX_READ) as { rows: Array<{ account: string; ledger: number; domain: number }> };
  const r = s.rows.find((x) => x.account === 'ACCOUNTS_PAYABLE')!;
  return Math.round((r.ledger - r.domain) * 1000) / 1000;
};
/** Banking-Bewegungen (Bank) == Hauptbuch BANK + CARD_CLEARING? */
const bankingGleich = (db: Db): boolean => {
  const tx = bankTransactionsFor(RCTX_READ as never, []) as Array<{ account: string; amount: number; flow: string }>;
  const bank = tx.filter((t) => t.account === 'bank').reduce((s, t) => s + (t.flow === 'out' ? -1 : 1) * t.amount, 0);
  return eq(Math.round(bank * 1000) / 1000, Math.round((saldo(db, 'BANK') + saldo(db, 'CARD_CLEARING')) * 1000) / 1000);
};
const nettoBanking = (paymentId: string): number => Number((bankTransactionsFor(RCTX_READ as never, []) as Array<{ id: string; amount: number }>).find((t) => t.id === `pay-${paymentId}`)?.amount);

// ══ A — der Fix ═════════════════════════════════════════════════════════════════
{
  const db = freshDb(); current = db;
  const k = kartenverkauf();
  ok(S(lebend(db, k.feeId)) === S([{ account: 'CARD_CLEARING', direction: 'CREDIT', amount: 11, d: YESTERDAY }, { account: 'EXPENSES_OPERATING', direction: 'DEBIT', amount: 11, d: YESTERDAY }]),
    `A Ausgangslage: Gebühr 11 gegen Karten-Clearing (${S(lebend(db, k.feeId))})`);
  // A1 Datum ändern.
  imHaus(() => payables.updateExpenseInHouse(k.feeId, { expenseDate: T3 }, CTX()));
  ok(S(lebend(db, k.feeId)) === S([{ account: 'CARD_CLEARING', direction: 'CREDIT', amount: 11, d: T3 }, { account: 'EXPENSES_OPERATING', direction: 'DEBIT', amount: 11, d: T3 }])
    && apGebuehr(db, k.feeId) === 0,
  `A1 Datum geändert: wieder gegen Karten-Clearing am neuen Tag, keine Verbindlichkeit (${S(lebend(db, k.feeId))})`);
  ok(abstimmungSauber() && bankingGleich(db) && eq(nettoBanking(k.paymentId), 489) && ausgeglichen(db), 'A1 Abstimmung sauber, Banking == Hauptbuch, netto 489');
  // A2 Betrag ändern (die Bank zog tatsächlich 12,5 ab).
  imHaus(() => payables.updateExpenseInHouse(k.feeId, { amount: 12.5 }, CTX()));
  const e2 = rows(db, 'SELECT amount, paid_amount, status FROM expenses WHERE id = ?', [k.feeId])[0];
  ok(eq(Number(e2.amount), 12.5) && eq(Number(e2.paid_amount), 12.5) && e2.status === 'PAID', `A2 Betrag 12,5: bleibt voll bezahlt (${S(e2)})`);
  ok(eq(saldo(db, 'CARD_CLEARING'), 487.5) && apGebuehr(db, k.feeId) === 0 && eq(nettoBanking(k.paymentId), 487.5) && bankingGleich(db) && abstimmungSauber(),
    `A2 Karten-Clearing 487,5 == Banking netto, keine Verbindlichkeit (${saldo(db, 'CARD_CLEARING')})`);
  // A3 Kategorie / Zahlweg gesperrt — nichts geändert.
  const vor = S(rows(db, 'SELECT * FROM expenses WHERE id = ?', [k.feeId]));
  const kat = meldung(() => imHaus(() => payables.updateExpenseInHouse(k.feeId, { category: 'Miscellaneous' as never }, CTX())));
  const weg = meldung(() => imHaus(() => payables.updateExpenseInHouse(k.feeId, { paymentMethod: 'cash' as never }, CTX())));
  ok(code(kat) === 'EXPENSE_CARD_FEE_LOCKED' && code(weg) === 'EXPENSE_CARD_FEE_LOCKED' && S(rows(db, 'SELECT * FROM expenses WHERE id = ?', [k.feeId])) === vor,
    `A3 Kategorie / Zahlweg einer Kartengebühr: gesperrt, nichts geändert (${code(kat)} / ${code(weg)})`);
  // A4 nicht in ein eingereichtes Quartal.
  const [ay, am] = ALT.split('-').map(Number);
  db.run(`INSERT INTO vat_filings (id, branch_id, year, quarter, filed_at, filed_by, invoice_count, snapshot_json, created_at)
          VALUES ('vf-a','branch-main',?,?,?, 'user-test', 0, '{}', ?)`, [ay, Math.ceil(am / 3), NOW, NOW]);
  const vat = meldung(() => imHaus(() => payables.updateExpenseInHouse(k.feeId, { expenseDate: ALT }, CTX())));
  ok(code(vat) === 'VAT_PERIOD_FILED' && S(rows(db, 'SELECT * FROM expenses WHERE id = ?', [k.feeId])) === vor, `A4 in ein eingereichtes Quartal: Nein (${code(vat)})`);
  // A5 eine normale Ausgabe bleibt, wie sie war (Aufwand an Verbindlichkeit).
  const norm = imHaus(() => payables.createExpenseInHouse({ category: 'Rent' as never, amount: 100, paymentMethod: 'cash' as never, expenseDate: YESTERDAY, initialPaid: 0 }, CTX()));
  const nid = String((norm as { expenseId?: string; id?: string }).expenseId ?? (norm as { id?: string }).id);
  imHaus(() => payables.updateExpenseInHouse(nid, { expenseDate: T3 }, CTX()));
  ok(S(lebend(db, nid)) === S([{ account: 'ACCOUNTS_PAYABLE', direction: 'CREDIT', amount: 100, d: T3 }, { account: 'EXPENSES_OPERATING', direction: 'DEBIT', amount: 100, d: T3 }]),
    `A5 normale Ausgabe (Miete) unverändert: Aufwand an Verbindlichkeit (${S(lebend(db, nid))})`);
  // A6 PC2: derselbe Befehl fern.
  const rev = Number(one(db, 'SELECT revision FROM expenses WHERE id = ?', [k.feeId]) ?? 0);
  const deps = { db: db as never, begin: () => { setTestDatabase(db as never); posting.beginLedgerTransaction(); },
    commit: posting.commitLedgerTransaction, rollback: posting.rollbackLedgerTransaction, durableSave: async () => {}, now: () => new Date().toISOString() };
  const r = await payCmd.runExpenseUpdate(deps as never,
    { commandId: '00000061-0000-4000-8000-000000000000', tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role: 'ADMIN', op: 'expenses.update', payloadHash: 'h61' } as never,
    { expenseId: k.feeId, expectedRevision: rev, expenseDate: YESTERDAY }) as { kind: string; code?: string };
  setTestDatabase(db as never); reload();
  ok(r.kind === 'ok' && S(lebend(db, k.feeId)) === S([{ account: 'CARD_CLEARING', direction: 'CREDIT', amount: 12.5, d: YESTERDAY }, { account: 'EXPENSES_OPERATING', direction: 'DEBIT', amount: 12.5, d: YESTERDAY }]),
    `A6 PC2 expenses.update == Primary: gegen Karten-Clearing (${r.kind} ${r.code ?? ''} ${S(lebend(db, k.feeId))})`);
  ok(ausgeglichen(db) && bankingGleich(db), 'A Hauptbuch ausgeglichen, Banking == Hauptbuch');
}

// ══ B — die Reparatur ═══════════════════════════════════════════════════════════
{
  const db = freshDb(); current = db;
  const k = kartenverkauf();
  // Der alte Fehler, genau wie bis v0.8.89: Datum geändert, Buchung zurück, allgemeine Ausgabenbuchung neu.
  const alt = () => imHaus(() => {
    db.run('UPDATE expenses SET expense_date = ? WHERE id = ?', [T3, k.feeId]);
    posting.reverseSource('EXPENSE', k.feeId, new Date().toISOString());
    const e = rows(db, 'SELECT * FROM expenses WHERE id = ?', [k.feeId])[0];
    posting.postExpense({ id: k.feeId, expenseNumber: String(e.expense_number), amount: Number(e.amount), expenseDate: T3, createdAt: String(e.created_at),
      category: 'CardFees', relatedModule: 'invoice', relatedEntityId: k.invoiceId } as never);
  });
  alt();
  ok(apDiff() === 11 && !bankingGleich(db), `B0 der alte Fehler nachgestellt: Abstimmung meldet Verbindlichkeit 11, Banking ≠ Hauptbuch (${apDiff()})`);
  const nr = String(one(db, 'SELECT invoice_number FROM invoices WHERE id = ?', [k.invoiceId]));
  const v = repair.cardFeeRepairPreview('branch-main');
  ok(v.repairable.length === 1 && v.blocked.length === 0 && v.repairable[0].expenseId === k.feeId && eq(v.repairable[0].amount, 11)
    && v.repairable[0].occurredAt.slice(0, 10) === T3 && v.repairable[0].documentNumber === nr,
  `B1 Vorschau: genau diese Gebühr, 11, gebucht am ${T3}, Beleg ${nr} (${S(v)})`);
  const zaehl = () => S([n(db, 'SELECT COUNT(*) FROM ledger_entries'), n(db, 'SELECT COUNT(*) FROM audit_log')]);
  const vor = zaehl();
  const fremd = meldung(() => imHaus(() => repair.repairCardFeeBookingsInHouse({ expenseIds: [k.feeId], reason: 'x' }, RCTX('SALES'))));
  const ohneGrund = meldung(() => imHaus(() => repair.repairCardFeeBookingsInHouse({ expenseIds: [k.feeId], reason: ' ' }, RCTX())));
  ok(code(fremd) === 'PERMISSION_DENIED' && code(ohneGrund) === 'REASON_REQUIRED' && zaehl() === vor, `B2 nur Admin, nur mit Grund — sonst nichts geschrieben (${code(fremd)} / ${code(ohneGrund)})`);
  const eintraegeVor = n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'EXPENSE' AND source_id = ?", [k.feeId]);
  const res = imHaus(() => repair.repairCardFeeBookingsInHouse({ expenseIds: [k.feeId], reason: 'Kartengebühr falsch als Verbindlichkeit gebucht' }, RCTX()));
  ok(res.repaired.length === 1 && S(lebend(db, k.feeId)) === S([{ account: 'CARD_CLEARING', direction: 'CREDIT', amount: 11, d: T3 }, { account: 'EXPENSES_OPERATING', direction: 'DEBIT', amount: 11, d: T3 }]),
    `B3 repariert: lebende Buchung wieder gegen Karten-Clearing, am Tag ${T3} (${S(lebend(db, k.feeId))})`);
  ok(apGebuehr(db, k.feeId) === 0 && eq(saldo(db, 'CARD_CLEARING'), 489) && apDiff() === 0 && abstimmungSauber() && bankingGleich(db) && ausgeglichen(db),
    `B3 Verbindlichkeit 0, Karten-Clearing 489 == Banking, Abstimmung sauber (${apGebuehr(db, k.feeId)} / ${saldo(db, 'CARD_CLEARING')})`);
  const nachher = n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'EXPENSE' AND source_id = ?", [k.feeId]);
  ok(nachher === eintraegeVor + 4 && eintraegeVor === 6, `B3 Historie bleibt: ${eintraegeVor} Zeilen vorher, ${nachher} nachher (Storno + richtige Buchung dazu, nichts gelöscht)`);
  const prot = rows(db, "SELECT module, entity_id, field_name, new_value FROM audit_log WHERE entity_id = ? AND field_name = 'ledger'", [k.feeId]);
  ok(prot.length === 1 && /CARD_FEE_REBOOK_V0890/.test(String(prot[0].new_value)) && /falsch als Verbindlichkeit/.test(String(prot[0].new_value)),
    `B3 protokolliert mit Grund (${S(prot)})`);
  const e = rows(db, 'SELECT amount, paid_amount, status, expense_date FROM expenses WHERE id = ?', [k.feeId])[0];
  ok(eq(Number(e.amount), 11) && eq(Number(e.paid_amount), 11) && e.status === 'PAID' && e.expense_date === T3, 'B3 die Ausgabe selbst bleibt, wie sie ist (Betrag, bezahlt, Datum)');
  ok(repair.cardFeeRepairPreview('branch-main').repairable.length === 0
    && code(meldung(() => imHaus(() => repair.repairCardFeeBookingsInHouse({ expenseIds: [k.feeId], reason: 'nochmal' }, RCTX())))) === 'CARD_FEE_REPAIR_NOT_PROVEN',
  'B4 danach nichts mehr zu reparieren; ein zweiter Lauf ist ein Nein');

  // B5 gesperrt: falsch gebucht, aber im eingereichten Quartal — der Buchhalter entscheidet.
  const k2 = kartenverkauf();
  imHaus(() => {
    db.run('UPDATE expenses SET expense_date = ? WHERE id = ?', [ALT, k2.feeId]);
    posting.reverseSource('EXPENSE', k2.feeId, new Date().toISOString());
    const x = rows(db, 'SELECT * FROM expenses WHERE id = ?', [k2.feeId])[0];
    posting.postExpense({ id: k2.feeId, expenseNumber: String(x.expense_number), amount: Number(x.amount), expenseDate: ALT, createdAt: String(x.created_at),
      category: 'CardFees', relatedModule: 'invoice', relatedEntityId: k2.invoiceId } as never);
  });
  const [ay, am] = ALT.split('-').map(Number);
  db.run(`INSERT INTO vat_filings (id, branch_id, year, quarter, filed_at, filed_by, invoice_count, snapshot_json, created_at)
          VALUES ('vf-b','branch-main',?,?,?, 'user-test', 0, '{}', ?)`, [ay, Math.ceil(am / 3), NOW, NOW]);
  const v5 = repair.cardFeeRepairPreview('branch-main');
  const vor5 = zaehl();
  const nein5 = meldung(() => imHaus(() => repair.repairCardFeeBookingsInHouse({ expenseIds: [k2.feeId], reason: 'x' }, RCTX())));
  ok(v5.repairable.length === 0 && v5.blocked.length === 1 && /filed\/paid VAT quarter/.test(v5.blocked[0].issue) && code(nein5) === 'CARD_FEE_REPAIR_NOT_PROVEN' && zaehl() === vor5,
    `B5 im eingereichten Quartal: gesperrt mit Grund, Reparatur weist ab (${S(v5.blocked)})`);
  // B6 gesperrt: gegen die „Verbindlichkeit" wurde eine Zahlung erfasst — auch das entscheidet der Buchhalter.
  db.run("DELETE FROM vat_filings WHERE id = 'vf-b'");
  db.run("INSERT INTO expense_payments (id, expense_id, amount, method, paid_at, created_at) VALUES ('ep-1', ?, 11, 'bank', ?, ?)", [k2.feeId, TODAY, NOW]);
  const v6 = repair.cardFeeRepairPreview('branch-main');
  ok(v6.repairable.length === 0 && v6.blocked.length === 1 && /payment was recorded against it/.test(v6.blocked[0].issue), `B6 mit erfasster Zahlung: gesperrt (${S(v6.blocked)})`);
  // B7 die Seite „Data Repairs" zeigt Vorschau und Knopf.
  const tab = src('src/pages/settings/DataRepairsTab.tsx');
  ok(/cardFeeRepairPreview\(currentBranchId\(\)\)/.test(tab) && /repairCardFeeBookingsOnPrimary\(/.test(tab) && /data-repair-card-fee-rebook/.test(tab) && /data-repair-card-fee-blocked/.test(tab),
    'B7 Data Repairs: Vorschau, gesperrte Fälle mit Grund, Knopf zum Auslösen');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — card fee edit v0.8.90: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
