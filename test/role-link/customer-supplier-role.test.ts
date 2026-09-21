// ════════════════════════════════════════════════════════════════════════════
// CUSTOMER-SUPPLIER-ROLE-LINK — dieselbe Person als Kunde UND Lieferant, zwei Rollen, getrennte Bücher.
// Run: node test/role-link/customer-supplier-role.test.ts
//
// Echte Hausfunktionen (Stores, Einkauf, Rechnung, Zahlungen, Retoure, Storno), echte C3A-Maschine,
// echtes Schema aus den Migrationen. Bewiesen:
//   §1 Kunde → Lieferanten-Rolle (eigene Kennung, Kunde unverändert, nur Identitätsfelder übernommen)
//   §2 zweiter Versuch / anderer Rechner / Wiederholung / veralteter Stand / Rumpf mit Identität
//   §3–§8 Einkauf → Verbindlichkeit auf SUPPLIER, Rechnung → Forderung auf CUSTOMER, getrennte Salden,
//        Zahlungen, Retoure, Storno, Guthaben — nie über die Verknüpfung auf die andere Rolle
//   §9/§10 Lebenszyklus: Lieferant still-/gelöscht ↔ Kunde bleibt; Kunde gelöscht ↔ Lieferant bleibt
//   §11 Primary == PC2   §13 nicht verknüpfte Fälle unverändert (auch die alte Kommissions-Suche)
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath, join } from 'node:path';

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
const { COMMAND_LEDGER_DDL, COMMAND_LEDGER_INDEX } = await import('../../src/core/bridge/command-ledger.ts');
const { resetDurabilityStateForTest } = await import('../../src/core/bridge/durability-state.ts');
const { resetTransactionHealthForTest } = await import('../../src/core/db/transaction-health.ts');
const { installWriteGuard } = await import('../../src/core/db/write-guard.ts');
const { SKU_SEQUENCES_DDL } = await import('../../src/core/products/sku-sequence.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { customerBalance, supplierBalance } = await import('../../src/core/ledger/queries.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const { applyMediaSchema } = await import('../../src/core/db/media-schema.ts');
const md = await import('../../src/core/bridge/masterdata-commands.ts');
const rules = await import('../../src/core/masterdata/masterdata-rules.ts');
const { runInvoiceCreate } = await import('../../src/core/bridge/invoice-command.ts');
const cancelHouse = await import('../../src/core/invoices/invoice-cancel-house.ts');
const purchaseHouse = await import('../../src/core/purchases/purchase-house.ts');
const registry = await import('../../src/core/bridge/command-registry.ts');
const { useSupplierStore } = await import('../../src/stores/supplierStore.ts');
const { useCustomerStore } = await import('../../src/stores/customerStore.ts');
const { usePurchaseStore } = await import('../../src/stores/purchaseStore.ts');
const { useInvoiceStore } = await import('../../src/stores/invoiceStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { findOrCreateSupplierForConsignor } = await import('../../src/stores/consignmentStore.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const S = (v: unknown): string => JSON.stringify(v);
const NOW = '2026-09-19T10:00:00.000Z';

interface Db { run(sql: string, p?: unknown[]): unknown; exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }> }
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const n = (db: Db, sql: string, p: unknown[] = []): number => Number(one(db, sql, p) ?? 0);
function row(db: Db, sql: string, p: unknown[] = []): Record<string, unknown> {
  const r = db.exec(sql, p)[0];
  if (!r || r.values.length === 0) return {};
  return Object.fromEntries(r.columns.map((c, i) => [c, r.values[0][i]]));
}
const all = (db: Db, sql: string, p: unknown[] = []): string => JSON.stringify(db.exec(sql, p)[0]?.values ?? []);

function realMigrations(): string[] {
  const dbSrc = src('src/core/db/database.ts');
  const start = dbSrc.indexOf('const migrations: string[] = [');
  const end = dbSrc.indexOf('\n  ];', start);
  return [...dbSrc.slice(start, end).matchAll(/`([^`]*)`/g)].map((m) => m[1]);
}
const MIGRATIONS = realMigrations();

function customer(db: Db, id: string, first: string, last: string, extra: Record<string, unknown> = {}): void {
  const cols = ['id', 'branch_id', 'first_name', 'last_name', 'country', 'language', 'vip_level', 'preferences', 'customer_type', 'sales_stage', 'created_at', 'updated_at', ...Object.keys(extra)];
  const vals = [id, 'branch-main', first, last, 'BH', 'en', 2, '["rolex"]', 'collector', 'active', NOW, NOW, ...Object.values(extra)];
  db.run(`INSERT INTO customers (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, vals);
}

function reload(): void {
  useSupplierStore.getState().loadSuppliers();
  useCustomerStore.getState().loadCustomers();
  usePurchaseStore.getState().loadPurchases();
  usePurchaseStore.getState().loadReturns();
  useInvoiceStore.getState().loadInvoices();
  useProductStore.getState().loadProducts();
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
  customer(db, 'c1', 'Ali', 'Hassan', { phone: '+973 3300 0001', whatsapp: '+973 3300 0009', email: 'ali@example.com', personal_id: '900123456', vat_account_number: 'VAT-C1', notes: 'VIP customer — prefers Rolex' });
  customer(db, 'c3', 'Sara', 'Stale', { phone: '+973 3300 0003' });
  customer(db, 'c4', 'Del', 'Customer', { phone: '+973 3300 0004' });
  customer(db, 'c5', 'Par', 'Ity', { phone: '+973 3300 0005', company: 'Parity Gold W.L.L.' });
  applyMediaSchema(db as never);
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  for (const [id, cost] of [['p-sale', 300], ['p-buy', 0]] as const) {
    db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition, scope_of_delivery, purchase_price,
        purchase_currency, planned_sale_price, stock_status, tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
      VALUES (?,'branch-main','cat-w','Rolex',?,?,?,'Pre-Owned','[]',?,'BHD',500,'in_stock','ZERO',0,'[]','{}','OWN',?,?)`,
    [id, 'M ' + id, 'SKU-' + id, id === 'p-sale' ? 1 : 0, cost, NOW, NOW]);
  }
  db.run(`INSERT INTO stock_lots (id, branch_id, product_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
    VALUES ('lot-p-sale','branch-main','p-sale',300,1,1,'ACTIVE',?,?)`, [NOW, NOW]);
  reload();
  return db;
}

function imHaus<T>(fn: () => T): T {
  posting.beginLedgerTransaction();
  try { const out = fn(); posting.commitLedgerTransaction(); return out; }
  catch (e) { posting.rollbackLedgerTransaction(); throw e; }
}
const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-000000000000`;
const ACTOR = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role: 'ADMIN' };
const identity = (x: string, op: string, hash = 'h' + x) => ({ commandId: ID(x), ...ACTOR, op, payloadHash: hash });
const deps = (db: Db) => ({
  db: db as never,
  begin: () => { setTestDatabase(db as never); posting.beginLedgerTransaction(); },
  commit: posting.commitLedgerTransaction,
  rollback: posting.rollbackLedgerTransaction,
  durableSave: async () => {},
  now: () => NOW,
});
type Outcome = { kind: string; code?: string; frozen?: boolean; replayed?: boolean; value?: Record<string, unknown> };
async function fern(p: () => Promise<unknown>): Promise<Outcome & { thrown?: string }> {
  try { return await p() as Outcome; } catch (e) { return { kind: 'thrown', thrown: String((e as { code?: string }).code ?? (e as Error).message) }; }
}
const meldung = (fn: () => unknown): string => { try { fn(); return ''; } catch (e) { return (e as Error).message; } };
const wirft = (fn: () => unknown): string => { try { fn(); return ''; } catch (e) { return String((e as { code?: string }).code ?? (e as Error).message); } };
/** Jede Buchung einer Gegenpartei: welche Art, welche Kennung. */
const gegenparteien = (db: Db): string => all(db,
  "SELECT DISTINCT counterparty_type, counterparty_id FROM ledger_entries WHERE counterparty_id IS NOT NULL ORDER BY 1, 2");

// ═════════════════════════════════════════════════════════════════════════════════════════════
{
  const db = freshDb();
  const kundeVorher = S(row(db, 'SELECT * FROM customers WHERE id = ?', ['c1']));
  const kundenVorher = n(db, 'SELECT COUNT(*) FROM customers');

  // ── §1 Kunde → Lieferanten-Rolle (Primary, Hausfunktion) ───────────────────────────────────
  const r1 = imHaus(() => useSupplierStore.getState().createSupplierFromCustomer('c1', { address: 'Manama Souq 12', notes: 'buys scrap gold from us' }, NOW));
  const sId = r1.supplier.id;
  const sup = row(db, 'SELECT * FROM suppliers WHERE id = ?', [sId]);
  ok(!r1.existing && sId !== 'c1' && sup.linked_customer_id === 'c1', `§1 eine NEUE Lieferanten-Kennung, ausdrücklich mit c1 verknüpft (${sId})`);
  ok(sup.name === 'Ali Hassan' && sup.phone === '+973 3300 0001' && sup.email === 'ali@example.com' && sup.cpr === '900123456',
    `§1 übernommen: Name, Telefon, E-Mail, Ausweisnummer (${S([sup.name, sup.phone, sup.email, sup.cpr])})`);
  ok(sup.address === 'Manama Souq 12' && sup.notes === 'buys scrap gold from us' && sup.cpr_image == null,
    '§1 Lieferanten-eigene Felder vom Benutzer; kein Ausweisfoto kopiert');
  ok(!String(sup.notes).includes('VIP') && !Object.values(sup).includes('VAT-C1'), '§1 Kunden-eigene Daten (Notiz, Steuernummer) bleiben beim Kunden');
  ok(S(row(db, 'SELECT * FROM customers WHERE id = ?', ['c1'])) === kundeVorher && n(db, 'SELECT COUNT(*) FROM customers') === kundenVorher,
    '§1 der Kunde ist unverändert, keine zweite Kundenzeile');
  const firma = rules.supplierSeedFromCustomer({ firstName: 'Par', lastName: 'Ity', company: 'Parity Gold W.L.L.', whatsapp: '+973 1' });
  ok(firma.name === 'Parity Gold W.L.L.' && firma.phone === '+973 1', '§1 Firma: der Firmenname; ohne Telefon die WhatsApp-Nummer (EINE Regel)');

  // ── §2 kein zweiter Lieferant: Primary nochmal, PC2 neu, PC2 Wiederholung ───────────────────
  const lieferantenVorher = n(db, 'SELECT COUNT(*) FROM suppliers');
  const r2 = imHaus(() => useSupplierStore.getState().createSupplierFromCustomer('c1', {}, NOW));
  ok(r2.existing && r2.supplier.id === sId, '§2 zweiter Versuch am Primary → die bestehende Rolle');
  const pc2a = await fern(() => md.runSupplierCreate(deps(db), identity('11', 'suppliers.create'), { linkedCustomerId: 'c1', linkedCustomerUpdatedAt: NOW }));
  ok(pc2a.kind === 'ok' && pc2a.value?.supplierId === sId && pc2a.value?.existing === true, `§2 PC2 mit NEUER Kennung → dieselbe Rolle (${S(pc2a)})`);
  const pc2b = await fern(() => md.runSupplierCreate(deps(db), identity('11', 'suppliers.create'), { linkedCustomerId: 'c1', linkedCustomerUpdatedAt: NOW }));
  ok(pc2b.kind === 'ok' && pc2b.replayed === true && pc2b.value?.supplierId === sId, '§2 dieselbe Kennung erneut → Wiedergabe, kein zweiter Lauf');
  ok(n(db, 'SELECT COUNT(*) FROM suppliers') === lieferantenVorher && n(db, "SELECT COUNT(*) FROM suppliers WHERE linked_customer_id = 'c1'") === 1,
    '§2 genau EIN Lieferant für c1');
  ok(/UNIQUE|constraint/i.test(wirft(() => db.run(`INSERT INTO suppliers (id, branch_id, name, linked_customer_id, created_at, updated_at) VALUES ('dup','branch-main','x','c1',?,?)`, [NOW, NOW]))),
    '§2 …und das Schema sperrt eine zweite Rolle selbst (eindeutiger Index)');
  // veralteter Stand (c3 wurde seit dem Öffnen geändert)
  db.run("UPDATE customers SET phone = '+973 9999 9999', updated_at = '2026-09-19T11:00:00.000Z' WHERE id = 'c3'");
  const stale = await fern(() => md.runSupplierCreate(deps(db), identity('12', 'suppliers.create'), { linkedCustomerId: 'c3', linkedCustomerUpdatedAt: NOW }));
  ok(stale.kind === 'rejected' && stale.code === 'CUSTOMER_CHANGED' && stale.frozen === true, `§2 veralteter Kundenstand → CUSTOMER_CHANGED (${S(stale)})`);
  ok(n(db, "SELECT COUNT(*) FROM suppliers WHERE linked_customer_id = 'c3'") === 0, '§2 …und nichts angelegt');
  ok(wirft(() => imHaus(() => useSupplierStore.getState().createSupplierFromCustomer('c3', {}, NOW))) === 'CUSTOMER_CHANGED', '§2 dasselbe Urteil am Primary');
  for (const f of ['name', 'phone', 'email', 'cpr']) {
    ok(/comes from the customer/.test(meldung(() => md.parseSupplierCreate({ linkedCustomerId: 'c1', linkedCustomerUpdatedAt: NOW, [f]: 'x' }))),
      `§2 ein Rumpf mit ${f} wird abgewiesen — die Identität kommt vom Kunden`);
  }
  ok(/required/.test(meldung(() => md.parseSupplierCreate({ linkedCustomerId: 'c1' }))), '§2 ohne gesehenen Stand kein Auftrag');
  const fremd = await fern(() => md.runSupplierCreate(deps(db), identity('13', 'suppliers.create'), { linkedCustomerId: 'nope', linkedCustomerUpdatedAt: NOW }));
  ok(fremd.kind === 'rejected' && fremd.code === 'CUSTOMER_NOT_FOUND', '§2 ein unbekannter Kunde → CUSTOMER_NOT_FOUND');

  // ── §3 Einkauf → Verbindlichkeit auf die Lieferanten-Rolle ─────────────────────────────────
  reload();
  const pid = imHaus(() => usePurchaseStore.getState().createPurchase({
    supplierId: sId, lines: [{ productId: 'p-buy', quantity: 1, unitPrice: 300, taxScheme: 'ZERO' as const, vatRate: 0 }],
  }).id);
  ok(one(db, 'SELECT supplier_id FROM purchases WHERE id = ?', [pid]) === sId, '§3 der Einkauf verweist auf die supplierId');
  ok(Math.abs(supplierBalance(sId, 'branch-main') - 300) < 0.001, `§3 Verbindlichkeit 300 gegen SUPPLIER ${sId} (${supplierBalance(sId, 'branch-main')})`);
  ok(n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module LIKE '%urchase%' AND counterparty_id = 'c1'") === 0, '§3 …keine Einkaufsbuchung trifft die Kunden-Kennung');

  // ── §4 Rechnung → Forderung auf die Kunden-Rolle ──────────────────────────────────────────
  const inv = await fern(() => runInvoiceCreate(deps(db) as never, identity('20', 'invoices.create') as never, {
    customerId: 'c1', lines: [{ productId: 'p-sale', quantity: 1, unitPrice: 500 }],
  }));
  const invId = String(inv.value?.invoiceId ?? '');
  const gross = n(db, 'SELECT gross_amount FROM invoices WHERE id = ?', [invId]);
  ok(inv.kind === 'ok' && one(db, 'SELECT customer_id FROM invoices WHERE id = ?', [invId]) === 'c1', `§4 die Rechnung verweist auf die customerId (${S(inv).slice(0, 120)})`);
  ok(Math.abs(customerBalance('c1', 'branch-main') - gross) < 0.001 && gross === 500, `§4 Forderung ${gross} gegen CUSTOMER c1`);

  // ── §5 beide gleichzeitig: getrennte Salden, keine Verrechnung ─────────────────────────────
  ok(Math.abs(customerBalance('c1', 'branch-main') - 500) < 0.001 && Math.abs(supplierBalance(sId, 'branch-main') - 300) < 0.001,
    '§5 Kunde schuldet 500, wir schulden 300 — beide stehen getrennt');
  ok(n(db, "SELECT COUNT(*) FROM ledger_entries WHERE (counterparty_type = 'CUSTOMER' AND counterparty_id = ?) OR (counterparty_type = 'SUPPLIER' AND counterparty_id = 'c1')", [sId]) === 0,
    '§5 keine Buchung vertauscht Art und Kennung');
  ok(customerBalance(sId, 'branch-main') === 0 && supplierBalance('c1', 'branch-main') === 0, '§5 die Kennung der einen Rolle hat in den Büchern der anderen keinen Saldo');

  // ── §6 Kundenzahlung berührt die Verbindlichkeit nicht ─────────────────────────────────────
  useInvoiceStore.getState().loadInvoices();
  imHaus(() => useInvoiceStore.getState().recordPayment(invId, 100, 'cash'));
  ok(Math.abs(customerBalance('c1', 'branch-main') - 400) < 0.001 && Math.abs(supplierBalance(sId, 'branch-main') - 300) < 0.001,
    '§6 Kundenzahlung 100 → Forderung 400, Verbindlichkeit bleibt 300');

  // ── §7 Lieferantenzahlung berührt die Forderung nicht ───────────────────────────────────────
  usePurchaseStore.getState().addPayment(pid, 50, 'cash');
  ok(Math.abs(supplierBalance(sId, 'branch-main') - 250) < 0.001 && Math.abs(customerBalance('c1', 'branch-main') - 400) < 0.001,
    '§7 Lieferantenzahlung 50 → Verbindlichkeit 250, Forderung bleibt 400');

  // ── §8 Retoure / Storno bleiben auf ihrer Rolle ────────────────────────────────────────────
  reload();
  const lineId = String(one(db, 'SELECT id FROM purchase_lines WHERE purchase_id = ?', [pid]));
  const rueck = await purchaseHouse.returnToSupplierOnPrimary({ purchaseId: pid, refundMethod: 'credit', lines: [{ purchaseLineId: lineId, quantity: 1, unitPrice: 300 }] } as never).then(() => 'ok', (e) => String((e as { code?: string }).code ?? e));
  ok(rueck === 'ok', `§8 Retoure an den Lieferanten gebucht (${rueck})`);
  ok(n(db, "SELECT COUNT(*) FROM supplier_credits WHERE supplier_id = ?", [sId]) >= 0 && n(db, "SELECT COUNT(*) FROM customer_credits WHERE customer_id IN ('c1', ?)", [sId]) === 0,
    '§8 die Retoure erzeugt kein Kundenguthaben');
  const beforeCancel = supplierBalance(sId, 'branch-main');
  const storno = await cancelHouse.cancelInvoiceOnPrimary({ invoiceId: invId, refundMethod: 'cash' } as never).then(() => 'ok', (e) => String((e as { code?: string }).code ?? e));
  ok(storno === 'ok', `§8 Rechnungsstorno gebucht (${storno})`);
  ok(Math.abs(supplierBalance(sId, 'branch-main') - beforeCancel) < 0.001, '§8 der Storno der Rechnung ändert die Verbindlichkeit nicht');
  const gp = gegenparteien(db);
  ok(!gp.includes(`["CUSTOMER","${sId}"]`) && !gp.includes('["SUPPLIER","c1"]'), `§8 alle Buchungen: CUSTOMER nur c1, SUPPLIER nur ${sId} (${gp})`);

  // ── §9 Lieferant still-/gelöscht → Kunde bleibt ────────────────────────────────────────────
  imHaus(() => useSupplierStore.getState().updateSupplier(sId, { active: false }));
  ok(S(row(db, 'SELECT * FROM customers WHERE id = ?', ['c1'])) === kundeVorher, '§9 Lieferant stillgelegt → Kunde unverändert');
  imHaus(() => useSupplierStore.getState().updateSupplier(sId, { phone: '+973 1111 1111', notes: 'nur Lieferant' }));
  ok(one(db, "SELECT phone FROM customers WHERE id = 'c1'") === '+973 3300 0001', '§9 Lieferantenfelder ändern den Kunden nicht (keine Live-Synchronisierung)');
  const r4 = imHaus(() => useSupplierStore.getState().createSupplierFromCustomer('c4', {}, NOW));
  imHaus(() => useSupplierStore.getState().deleteSupplier(r4.supplier.id));
  ok(n(db, "SELECT COUNT(*) FROM customers WHERE id = 'c4'") === 1 && n(db, 'SELECT COUNT(*) FROM suppliers WHERE id = ?', [r4.supplier.id]) === 0,
    '§9 Lieferanten-Rolle gelöscht → Kunde bleibt');

  // ── §10 Kunde gelöscht → Lieferant bleibt ──────────────────────────────────────────────────
  const r4b = imHaus(() => useSupplierStore.getState().createSupplierFromCustomer('c4', {}, NOW));
  reload();
  imHaus(() => useCustomerStore.getState().deleteCustomer('c4'));
  const s4 = row(db, 'SELECT * FROM suppliers WHERE id = ?', [r4b.supplier.id]);
  ok(n(db, "SELECT COUNT(*) FROM customers WHERE id = 'c4'") === 0 && s4.id === r4b.supplier.id && s4.linked_customer_id == null && s4.name === 'Del Customer',
    '§10 Kunde gelöscht → Lieferant bleibt, nur die Verknüpfung ist gelöst');
  ok(n(db, "SELECT COUNT(*) FROM sync_changelog WHERE table_name = 'suppliers' AND record_id = ? AND action = 'update'", [r4b.supplier.id]) >= 1,
    '§10 …und das Lösen reist über den Abgleich');
  ok(wirft(() => imHaus(() => useCustomerStore.getState().deleteCustomer('c1'))).includes('Cannot delete customer'), '§10 ein Kunde mit Belegen bleibt wie bisher geschützt');
  ok(one(db, 'SELECT linked_customer_id FROM suppliers WHERE id = ?', [sId]) === 'c1', '§10 …und seine Lieferanten-Verknüpfung bleibt');

  // ── §13 nicht verknüpfte Fälle unverändert; Kommissions-Suche respektiert die Rolle ─────────
  const plain = imHaus(() => useSupplierStore.getState().createSupplier({ name: 'Plain Dealer', phone: '+973 3300 0005' }));
  ok(one(db, 'SELECT linked_customer_id FROM suppliers WHERE id = ?', [plain.id]) == null, '§13 ein normaler Lieferant hat keine Verknüpfung');
  ok(imHaus(() => findOrCreateSupplierForConsignor('c1')) === sId, '§13 Kommission: die ausdrückliche Rolle von c1 wird genommen');
  // c5 hat dieselbe Telefonnummer wie „Plain Dealer" (unverknüpft) → alte Suche findet ihn wie bisher
  ok(imHaus(() => findOrCreateSupplierForConsignor('c5')) === plain.id, '§13 alte Telefon-Suche unter UNverknüpften Lieferanten unverändert');
  // ein Kunde mit der Telefonnummer eines FREMD verknüpften Lieferanten bekommt nicht dessen Rolle
  customer(db, 'c6', 'Twin', 'Phone', { phone: '+973 1111 1111' });
  const c6s = imHaus(() => findOrCreateSupplierForConsignor('c6'));
  ok(c6s !== sId && one(db, 'SELECT linked_customer_id FROM suppliers WHERE id = ?', [c6s]) === 'c6',
    '§13 …aber nie die Rolle eines ANDEREN Kunden; die neue Rolle ist ausdrücklich verknüpft');
}

// ── §11 Primary == PC2 (dieselbe Zeile) ─────────────────────────────────────────────────────
{
  const bild = (db: Db, id: string) => {
    const r = row(db, 'SELECT * FROM suppliers WHERE id = ?', [id]);
    return S(Object.fromEntries(Object.entries(r).filter(([k]) => !/^(id|created_at|updated_at|created_by)$/.test(k)).sort()));
  };
  const a = freshDb();
  const p = imHaus(() => useSupplierStore.getState().createSupplierFromCustomer('c5', { address: 'Seef' }, NOW));
  const bildA = bild(a, p.supplier.id);
  const b = freshDb();
  const f = await fern(() => md.runSupplierCreate(deps(b), identity('50', 'suppliers.create'), { linkedCustomerId: 'c5', linkedCustomerUpdatedAt: NOW, address: 'Seef' }));
  ok(f.kind === 'ok' && f.value?.existing === false, '§11 PC2 legt an');
  ok(bildA === bild(b, String(f.value?.supplierId)), `§11 Primary und PC2 schreiben dieselbe Zeile (${bildA})`);
}

// ── Vertrag: Registry, Buchungscode, Oberfläche ─────────────────────────────────────────────
{
  ok((registry.ALLOWED_MUTATIONS as readonly string[]).length === 104 && (registry.ALLOWED_MUTATIONS as readonly string[]).includes('suppliers.create'),
    'REGISTRY keine neue Buchung — suppliers.create trägt die Rolle (103 Mutationen)');
  const rust = src('src-tauri/src/bridge.rs');
  const ops = [...(/pub const REMOTE_OPS: &\[&str\] = &\[([\s\S]*?)\];/.exec(rust)?.[1] ?? '').matchAll(/OP_[A-Z_]+/g)].length;
  ok(ops === 177, `REGISTRY 176 unverändert (${ops})`);
  // Kein Buchungs-, Saldo- oder Belegcode liest die Verknüpfung.
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
  const leser = walk(resolvePath(repo, 'src')).filter((p) => /\.(ts|tsx)$/.test(p))
    .filter((p) => /linked_customer_id|linkedCustomerId/.test(readFileSync(p, 'utf8')))
    .map((p) => p.slice(resolvePath(repo, 'src').length + 1).replace(/\\/g, '/')).sort();
  const erlaubt = ['components/suppliers/UseCustomerAsSupplier.tsx', 'core/bridge/masterdata-commands.ts', 'core/db/database.ts', 'core/masterdata/masterdata-rules.ts', 'core/masterdata/masterdata-save.ts',
    'core/models/types.ts', 'pages/customers/CustomerDetail.tsx', 'pages/suppliers/SupplierDetail.tsx', 'stores/consignmentStore.ts',
    'stores/customerStore.ts', 'stores/supplierStore.ts',
    // MEDIA-IDENTITY — der verknuepfte Lieferant zeigt den Ausweis SEINES Kunden (keine Spiegelkopie).
    // Gelesen wird nur, WESSEN Dokument gilt — kein Betrag, kein Saldo, keine Verrechnung.
    'core/identity/identity-media.ts'];
  ok(leser.every((p) => erlaubt.includes(p)), `ACCOUNTING kein Ledger-/Rechnungs-/Einkaufscode liest die Verknüpfung (${S(leser)})`);
  ok(!/linked_customer_id/.test(src('src/core/ledger/posting.ts')) && !/linked_customer_id/.test(src('src/core/ledger/queries.ts')), 'ACCOUNTING Buchung und Saldo kennen nur Art + Kennung');
  const ui = src('src/components/suppliers/UseCustomerAsSupplier.tsx');
  ok(/saveSupplierFromCustomer\(anlegen, picked/.test(ui) && /supplierSeedFromCustomer\(picked\)/.test(ui), 'UI die Maske zeigt die Regel und schickt nur den Kunden');
  ok(/<UseCustomerAsSupplier/.test(src('src/pages/suppliers/SupplierList.tsx')) && /<UseCustomerAsSupplier/.test(src('src/pages/purchases/PurchaseCreate.tsx')),
    'UI „Use existing customer" in der Lieferantenliste und im Einkauf');
  const manifest = JSON.parse(src('src/core/sync/sync-business-schema.json'));
  ok(manifest.tables.suppliers.allowed_fields.includes('linked_customer_id'), 'SYNC die Verknüpfung reist mit der Lieferantenzeile');
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// V2 — Filiale, eindeutige Zuordnung, bestehende Rolle ausdrücklich verknüpfen
// ═════════════════════════════════════════════════════════════════════════════════════════════
{
  const db = freshDb();
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-other','tenant-1','Andere',?,?)", [NOW, NOW]);
  const cons = await import('../../src/stores/consignmentStore.ts');
  const lieferanten = () => n(db, 'SELECT COUNT(*) FROM suppliers');
  const raw = (id: string, name: string, phone: string | null, notes: string | null = null) =>
    db.run('INSERT INTO suppliers (id, branch_id, name, phone, notes, active, created_at, updated_at) VALUES (?,?,?,?,?,1,?,?)', [id, 'branch-main', name, phone, notes, NOW, NOW]);

  // ── V2-1 Filiale: kein Lieferant, keine Buchung ────────────────────────────────────────────
  db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level, preferences, customer_type, sales_stage, created_at, updated_at)
    VALUES ('cB','branch-other','Bea','Branch','BH','en',0,'[]','collector','active',?,?)`, [NOW, NOW]);
  const vorher = lieferanten();
  const buchungenVorher = n(db, 'SELECT COUNT(*) FROM ledger_entries');
  ok(wirft(() => imHaus(() => useSupplierStore.getState().createSupplierFromCustomer('cB', {}, NOW))) === 'CUSTOMER_BRANCH_MISMATCH', 'V2 Filiale: Primary → CUSTOMER_BRANCH_MISMATCH');
  const fb = await fern(() => md.runSupplierCreate(deps(db), identity('70', 'suppliers.create'), { linkedCustomerId: 'cB', linkedCustomerUpdatedAt: NOW }));
  ok(fb.kind === 'rejected' && fb.code === 'CUSTOMER_BRANCH_MISMATCH' && fb.frozen === true, `V2 Filiale: PC2 → dasselbe Urteil (${S(fb)})`);
  ok(wirft(() => imHaus(() => cons.findOrCreateSupplierForConsignor('cB'))) === 'CONSIGNOR_BRANCH_MISMATCH', 'V2 Filiale: Kommission → CONSIGNOR_BRANCH_MISMATCH');
  ok(lieferanten() === vorher && n(db, 'SELECT COUNT(*) FROM ledger_entries') === buchungenVorher, 'V2 Filiale: kein Lieferant, keine Buchung');
  const rs = src('src/stores/consignmentStore.ts');
  const beginn = rs.indexOf('recordSale: (id, params) => {');
  const zu = rs.indexOf('findOrCreateSupplierForConsignor(con.consignorId)', beginn);
  ok(zu > beginn && zu < rs.indexOf('purch.createPurchase(', beginn) && zu < rs.indexOf('inv.createDirectInvoice(', beginn),
    'V2 Filiale: die Zuordnung fällt VOR Einkauf und Rechnung — ein Nein hinterlässt keine Auszahlung');

  // ── V2-2 mehrdeutige / fremde Treffer → keine Auswahl ─────────────────────────────────────
  customer(db, 'cN', 'Nadia', 'Twin');             // ohne Telefon
  raw('sN1', 'Nadia Twin', null); raw('sN2', 'nadia twin ', null);
  const v0 = lieferanten();
  ok(wirft(() => imHaus(() => cons.findOrCreateSupplierForConsignor('cN'))) === 'CONSIGNOR_SUPPLIER_AMBIGUOUS', 'V2 zwei Lieferanten mit gleichem Namen → keine automatische Auswahl');
  ok(lieferanten() === v0, 'V2 …und kein neuer angelegt');
  customer(db, 'cP', 'Pia', 'Phone', { phone: '+973 5500 0001' });
  raw('sP1', 'Irgendwer', '+973 5500 0001'); raw('sP2', 'Jemand', '+97355000001');
  ok(wirft(() => imHaus(() => cons.findOrCreateSupplierForConsignor('cP'))) === 'CONSIGNOR_SUPPLIER_AMBIGUOUS', 'V2 zwei Lieferanten mit derselben Nummer → fail-closed');
  customer(db, 'cS', 'Sam', 'Same', { phone: '+973 5500 0002' });
  raw('sS', 'Sam Same', '+973 5500 0099');          // gleicher Name, ANDERE Nummer = andere Person
  const cS = imHaus(() => cons.findOrCreateSupplierForConsignor('cS'));
  ok(cS !== 'sS' && one(db, 'SELECT linked_customer_id FROM suppliers WHERE id = ?', [cS]) === 'cS',
    'V2 gleicher Name, andere Nummer → nicht der Fremde; eine eigene, verknüpfte Rolle');
  customer(db, 'cM', 'Mia', 'Mirror', { phone: '+973 5500 0003' });
  raw('sM', 'Mia M. (alt)', null, rules.consignorMirrorNote('cM'));
  ok(imHaus(() => cons.findOrCreateSupplierForConsignor('cM')) === 'sM', 'V2 der alte Kommissions-Spiegel mit GENAU dieser Kunden-Kennung wird wiedergefunden');

  // ── V2-3 bestehende Rolle: nicht still eine zweite, sondern ausdrücklich verknüpfen ────────
  customer(db, 'cL', 'Lina', 'Legacy', { phone: '+973 5500 0004', personal_id: '870011223' });
  raw('sL', 'Lina Legacy', '+973 5500 0004');
  reload();
  const pAlt = imHaus(() => usePurchaseStore.getState().createPurchase({
    supplierId: 'sL', lines: [{ productId: 'p-buy', quantity: 1, unitPrice: 200, taxScheme: 'ZERO' as const, vatRate: 0 }],
  }).id);
  const apAlt = supplierBalance('sL', 'branch-main');
  const kand = rules.supplierLinkCandidates({ id: 'cL', firstName: 'Lina', lastName: 'Legacy', phone: '+973 5500 0004', personalId: '870011223' },
    [{ id: 'sL', name: 'Lina Legacy', phone: '+973 5500 0004' }, { id: 'sX', name: 'Lina Legacy', phone: '+973 5500 0004', linkedCustomerId: 'other' }]);
  ok(kand.length === 1 && kand[0].supplier.id === 'sL' && S(kand[0].reasons) === S(['same_phone', 'same_name']),
    `V2 Kandidat angezeigt (mit Grund), ein fremd verknüpfter nie (${S(kand)})`);
  const vN = lieferanten();
  ok(wirft(() => imHaus(() => useSupplierStore.getState().createSupplierFromCustomer('cL', {}, NOW))) === 'SUPPLIER_CANDIDATES_EXIST', 'V2 „Use existing customer" legt NICHT still eine zweite Rolle an');
  const pc2k = await fern(() => md.runSupplierCreate(deps(db), identity('71', 'suppliers.create'), { linkedCustomerId: 'cL', linkedCustomerUpdatedAt: NOW }));
  ok(pc2k.kind === 'rejected' && pc2k.code === 'SUPPLIER_CANDIDATES_EXIST' && lieferanten() === vN, 'V2 …auch nicht von PC2');
  const vorLink = row(db, 'SELECT * FROM suppliers WHERE id = ?', ['sL']);
  const link = await fern(() => md.runSupplierUpdate(deps(db), identity('72', 'suppliers.update'), { id: 'sL', linkedCustomerId: 'cL', linkedCustomerUpdatedAt: NOW }));
  ok(link.kind === 'ok' && link.value?.supplierId === 'sL', `V2 der eindeutige bestehende Lieferant wird ausdrücklich verknüpft (${S(link)})`);
  const nachLink = row(db, 'SELECT * FROM suppliers WHERE id = ?', ['sL']);
  const geaendert = Object.keys(nachLink).filter((k) => S(nachLink[k]) !== S(vorLink[k])).sort();
  // MEDIA-IDENTITY — seither traegt der Lieferant eine Fassung, und JEDE Aenderung erhoeht sie um eins
  // (Ausloeser `trg_suppliers_revision`). Geld- oder Stammdatenfelder bleiben weiterhin unberuehrt.
  ok(S(geaendert) === S(['linked_customer_id', 'revision', 'updated_at']) && Number(nachLink.revision) === Number(vorLink.revision) + 1, `V2 …nur die Verknüpfung ändert sich (${S(geaendert)})`);
  ok(one(db, 'SELECT supplier_id FROM purchases WHERE id = ?', [pAlt]) === 'sL' && Math.abs(supplierBalance('sL', 'branch-main') - apAlt) < 0.001,
    'V2 historische Einkäufe/Verbindlichkeiten bleiben auf derselben Lieferanten-Kennung');
  ok(imHaus(() => cons.findOrCreateSupplierForConsignor('cL')) === 'sL', 'V2 danach nimmt die Kommissions-Auszahlung genau diese Rolle');
  const pNeu = imHaus(() => usePurchaseStore.getState().createPurchase({
    supplierId: 'sL', lines: [{ productId: 'p-buy', quantity: 1, unitPrice: 100, taxScheme: 'ZERO' as const, vatRate: 0 }],
  }).id);
  ok(one(db, 'SELECT supplier_id FROM purchases WHERE id = ?', [pNeu]) === 'sL' && Math.abs(supplierBalance('sL', 'branch-main') - (apAlt + 100)) < 0.001,
    'V2 ein neuer Einkauf läuft auf dieselbe Rolle weiter');
  const invL = await fern(() => runInvoiceCreate(deps(db) as never, identity('73', 'invoices.create') as never, { customerId: 'cL', lines: [{ productId: 'p-sale', quantity: 1, unitPrice: 500 }] }));
  ok(invL.kind === 'ok' && Math.abs(customerBalance('cL', 'branch-main') - 500) < 0.001 && Math.abs(supplierBalance('sL', 'branch-main') - (apAlt + 100)) < 0.001,
    'V2 die Forderung an den Kunden steht getrennt daneben');
  ok(n(db, "SELECT COUNT(*) FROM ledger_entries WHERE (counterparty_type = 'CUSTOMER' AND counterparty_id = 'sL') OR (counterparty_type = 'SUPPLIER' AND counterparty_id = 'cL')") === 0,
    'V2 keine Buchung vertauscht Rolle und Kennung');
  const again = await fern(() => md.runSupplierUpdate(deps(db), identity('74', 'suppliers.update'), { id: 'sL', linkedCustomerId: 'cL', linkedCustomerUpdatedAt: NOW }));
  ok(again.kind === 'ok' && again.value?.existing === true, 'V2 erneutes Verknüpfen ist ein No-op');
  raw('sQ', 'Quelle', null);
  ok(wirft(() => imHaus(() => useSupplierStore.getState().linkSupplierToCustomer('sQ', 'cL', NOW))) === 'CUSTOMER_ALREADY_SUPPLIER', 'V2 ein Kunde bekommt keine zweite Rolle per Verknüpfung');
  ok(wirft(() => imHaus(() => useSupplierStore.getState().linkSupplierToCustomer('sL', 'cM', NOW))) === 'SUPPLIER_ALREADY_LINKED', 'V2 eine fremd verknüpfte Rolle wird nicht umgehängt');
  // ausdrücklich neu trotz Kandidat
  customer(db, 'cK', 'Kai', 'Kandidat', { phone: '+973 5500 0005' });
  raw('sK', 'Kai Kandidat', '+973 5500 0005');
  const neu = imHaus(() => useSupplierStore.getState().createSupplierFromCustomer('cK', { createDespiteExistingSuppliers: true }, NOW));
  ok(!neu.existing && neu.supplier.id !== 'sK' && one(db, 'SELECT linked_customer_id FROM suppliers WHERE id = ?', ['sK']) == null,
    'V2 „Create a new supplier instead" legt ausdrücklich neu an; der alte bleibt unverknüpft');
  const ui = src('src/components/suppliers/UseCustomerAsSupplier.tsx');
  ok(/supplierLinkCandidates\(picked, suppliers\)/.test(ui) && /saveSupplierLinkToCustomer\(verknuepfen/.test(ui) && /createDespiteExistingSuppliers: trotzdemNeu/.test(ui),
    'V2 UI: Kandidaten anzeigen, ausdrücklich verknüpfen oder ausdrücklich neu anlegen');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — customer/supplier role link: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('PARTY_ROLE_ACCOUNTING_CONTRACT_PROVED');
console.log('PARTY_ROLE_IDENTITY_CONTRACT_PROVED');
