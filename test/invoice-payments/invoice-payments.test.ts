// ════════════════════════════════════════════════════════════════════════════
// v0.8.87 INVOICE PAYMENTS — Zahlungsdatum beim Anlegen, Debitkarte, mehrere Zahlungen beim Anlegen.
// Echte sql.js-Datenbank (schema.sql + echte Migrationen + A1 + Medienschema), echte Stores, echte
// Hausfolge (`createInvoiceInHouse`), echter Fernbefehl (`invoices.create`), echtes Hauptbuch.
// Run: node --experimental-strip-types test/invoice-payments/invoice-payments.test.ts
//
//   A  Rechnung vom 23.10., erfasst am 24.10.: die Zahlung trägt den 23.10. (Liste, Banking, Buchung), der
//      Erfassungszeitpunkt bleibt fürs Audit; ein separat gewählter Tag; nie vor dem Rechnungsdatum, nie Zukunft
//   B  Debitkarte: eigener Satz aus Settings; OHNE Satz ein Nein vor jedem Schreiben (Anlegen, Record payment,
//      Auftrag, Anzahlung, Reparatur) — kein Rückfall auf Normal; 0 % geht ohne Gebühr; Satzänderung ändert keine
//      alte Gebühr; Normal/Amex unverändert; Altbestand bleibt Normal
//   C  mehrere Zahlungen beim Anlegen: Cash + Bank + Normal + Amex + Debit; Gebühr je Zeile; Banking nettet jede
//      Kartenzahlung mit IHRER Gebühr; Status/Endnummer; Teilzahlung; Überzahlung abgewiesen; Rollback
//   D  VAT-Sperre: eine Zahlung, die in ein eingereichtes Quartal schlösse, wird abgewiesen; D2 (v0.8.88) auch eine
//      TEILzahlung mit Tag im eingereichten Quartal und das Umdatieren hinein — Primary und PC2; Zahlungen im
//      offenen Quartal gehen; Snapshot, Zahlungen/Banking, Hauptbuch der gemeldeten Periode bleiben unverändert
//   E  PC2: `invoices.create` mit `payments` == Primary; Wiederholung derselben Kennung ohne zweite Wirkung;
//      Rumpfregeln (`payment` weiter, nicht beides, verbotene Felder); Debit ohne Satz = eingefrorenes Nein;
//      Auftrag von PC2 kennt Debit
//   F  v0.8.88: „Record Payment" mit Zahlungstag (Banking, Hauptbuch, Gebühr; Grenzen; eingereichtes Quartal; ohne
//      Tag wie bisher; PC2 == Primary, Wiederholung); Gebührentext beim Anlegen mit der endgültigen Nummer
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
const { useOrderStore } = await import('../../src/stores/orderStore.ts');
const { useOrderPaymentStore } = await import('../../src/stores/orderPaymentStore.ts');
const { useRepairStore } = await import('../../src/stores/repairStore.ts');
const commercial = await import('../../src/core/bridge/commercial-commands.ts');
const fin = await import('../../src/core/bridge/financial-commands.ts');
const lifecycle = await import('../../src/core/bridge/invoice-lifecycle-commands.ts');
const payHouse = await import('../../src/core/invoices/invoice-payment-house.ts');
const { formatInvoiceDisplay } = await import('../../src/core/utils/invoiceNumber.ts');
const { bankTransactionsFor } = await import('../../src/stores/bankingStore.ts');
const house = await import('../../src/core/invoices/invoice-create-house.ts');
const cmd = await import('../../src/core/bridge/invoice-command.ts');
const fees = await import('../../src/core/finance/card-fees.ts');
const { nbrInvoicesFromDb, liveVatQuarters } = await import('../../src/core/tax/vat-quarter-overview.ts');
const { nbrMonthTotals, invoiceFinalizationDate } = await import('../../src/core/tax/nbr-export.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const S = (v: unknown): string => JSON.stringify(v);
const NOW = new Date().toISOString();
const TODAY = NOW.slice(0, 10);
const dayBefore = (d: string, n: number): string => new Date(Date.parse(d + 'T00:00:00.000Z') - n * 86400000).toISOString().slice(0, 10);
const YESTERDAY = dayBefore(TODAY, 1);
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
let current: Db;
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
  applyMediaSchema(db as never);
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  current = db;
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
const setRate = (db: Db, key: string, value: string): void => {
  db.run('INSERT OR REPLACE INTO settings (branch_id, key, value, category, updated_at) VALUES (?, ?, ?, ?, ?)', ['branch-main', key, value, 'finance', NOW]);
};

/** Ware über einen echten Einkauf (Lager + Los), dann die Zeile einer Rechnung. */
function ware(price = 400, qty = 1): string {
  const p = imHaus(() => usePurchaseStore.getState().createPurchase({
    supplierId: 'sup-1', purchaseDate: dayBefore(TODAY, 3),
    lines: [{ newProduct: { categoryId: 'cat-w', brand: 'Rolex', name: 'Datejust', sku: `SKU-${Math.random().toString(36).slice(2, 8)}`, taxScheme: 'ZERO' } as never, quantity: qty, unitPrice: price, taxScheme: 'ZERO' as const, vatRate: 0 }],
  }));
  reload();
  return p.lines[0].productId!;
}
const LINE = (productId: string, price: number) => ({
  productId, quantity: 1, unitPrice: price, purchasePrice: 0, taxScheme: 'ZERO', vatRate: 0, vatAmount: 0, lineTotal: price,
});
const anlegen = (db: Db, input: Record<string, unknown>) => {
  const out = imHaus(() => house.createInvoiceInHouse({ customerId: 'cust-1', specialMark: false, ...input } as never, 'branch-main'));
  reload();
  return out;
};
const zahlungen = (db: Db, invId: string) => rows(db, 'SELECT id, amount, method, card_brand, received_at, created_at FROM payments WHERE invoice_id = ? ORDER BY received_at, created_at', [invId]);
const gebuehren = (db: Db, invId: string) => rows(db, "SELECT amount, created_at, expense_date, status, description FROM expenses WHERE category = 'CardFees' AND related_entity_id = ? ORDER BY created_at", [invId]);
const saldo = (db: Db, account: string): number => Math.round(n(db, "SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END), 0) FROM ledger_entries WHERE account = ?", [account]) * 1000) / 1000;
const ausgeglichen = (db: Db): boolean => rows(db, "SELECT transaction_id, ROUND(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END), 3) AS d FROM ledger_entries GROUP BY transaction_id").every((r) => Number(r.d) === 0);
const banking = () => bankTransactionsFor({ tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test', role: 'ADMIN' } as never, []);

// ══ A — Zahlungsdatum ═════════════════════════════════════════════════════════
{
  const db = freshDb();
  const p = ware(400);
  // Rechnung vom Vortag, heute erfasst — ohne eigenen Tag: der Tag der Rechnung.
  const out = anlegen(db, { lines: [LINE(p, 1000)], issuedDate: YESTERDAY, payments: [{ amount: 1000, method: 'cash' }] });
  const z = zahlungen(db, out.invoiceId);
  ok(z.length === 1 && String(z[0].received_at).slice(0, 10) === YESTERDAY && String(z[0].created_at).slice(0, 10) === TODAY,
    `A ohne Tag: Zahlung am Rechnungsdatum (${z[0]?.received_at}), Erfassung bleibt heute (${z[0]?.created_at})`);
  const le = rows(db, "SELECT occurred_at FROM ledger_entries WHERE source_module = 'PAYMENT' AND source_id = ?", [z[0]?.id]);
  ok(le.length > 0 && le.every((r) => String(r.occurred_at).slice(0, 10) === YESTERDAY), 'A die Buchung der Zahlung trägt denselben Tag');
  const b = banking().find((t) => t.id === `pay-${z[0]?.id}`);
  ok(b && String(b.date).slice(0, 10) === YESTERDAY, `A Banking zeigt die Zahlung am ${YESTERDAY} (${b?.date})`);
  ok(out.status === 'FINAL' && invoiceFinalizationDate(useInvoiceStore.getState().getInvoice(out.invoiceId)!, z.map((x) => ({ receivedAt: String(x.received_at), amount: Number(x.amount), method: String(x.method) })) as never).slice(0, 10) === YESTERDAY,
    'A der Vollzahlungstag (NBR-Exportmonat) ist der Zahlungstag');
  // Separat gewählter Tag (heute) zu einer Rechnung vom Vortag.
  const p2 = ware(300);
  const out2 = anlegen(db, { lines: [LINE(p2, 500)], issuedDate: YESTERDAY, payments: [{ amount: 500, method: 'bank_transfer', paidDate: TODAY }] });
  const z2 = zahlungen(db, out2.invoiceId);
  ok(z2.length === 1 && String(z2[0].received_at).slice(0, 10) === TODAY, `A separat gewählter Tag (heute) bleibt (${z2[0]?.received_at})`);
  // Nie vor dem Rechnungsdatum, nie in der Zukunft — und dann nichts angelegt.
  const p3 = ware(200);
  const vorher = n(db, 'SELECT COUNT(*) FROM invoices');
  const frueh = meldung(() => anlegen(db, { lines: [LINE(p3, 300)], issuedDate: YESTERDAY, payments: [{ amount: 300, method: 'cash', paidDate: dayBefore(TODAY, 5) }] }));
  const zukunft = meldung(() => anlegen(db, { lines: [LINE(p3, 300)], issuedDate: YESTERDAY, payments: [{ amount: 300, method: 'cash', paidDate: '2099-01-01' }] }));
  ok(code(frueh) === 'PAYMENT_DATE_BEFORE_INVOICE' && code(zukunft) === 'PAYMENT_DATE_INVALID' && n(db, 'SELECT COUNT(*) FROM invoices') === vorher,
    `A vor dem Rechnungsdatum / in der Zukunft: Nein, keine Rechnung (${code(frueh)} / ${code(zukunft)})`);
  ok(n(db, 'SELECT quantity FROM products WHERE id = ?', [p3]) === 1, 'A …und kein Bestand verbraucht');
  // Bestehende Zahlungen werden nicht angefasst: der Weg ohne Tag (record_payment) bleibt „jetzt".
  const p4 = ware(100);
  const out4 = anlegen(db, { lines: [LINE(p4, 200)], issuedDate: YESTERDAY });
  imHaus(() => useInvoiceStore.getState().recordPayment(out4.invoiceId, 50, 'cash'));
  reload();
  const z4 = zahlungen(db, out4.invoiceId);
  ok(z4.length === 1 && String(z4[0].received_at) === String(z4[0].created_at), 'A eine Zahlung auf der Rechnungsseite (ohne Tag) bleibt wie bisher: Eingang == Erfassung');
  ok(ausgeglichen(db), 'A Hauptbuch ausgeglichen');
}

// ══ B — Debitkarte ════════════════════════════════════════════════════════════
{
  const db = freshDb();
  ok(S(fees.CARD_BRANDS) === S(['normal', 'amex', 'debit']) && S(house.INVOICE_CARD_BRANDS) === S(fees.CARD_BRANDS), 'B EINE Liste der Kartenarten: Normal, Amex, Debit');
  ok(fees.normalizeCardBrand('debit') === 'debit' && fees.normalizeCardBrand(null) === 'normal' && fees.normalizeCardBrand('amex') === 'amex' && fees.normalizeCardBrand('visa') === 'normal',
    'B Normalisieren: Debit bleibt Debit, Altbestand/unbekannt bleibt Normal');
  setRate(db, 'finance.card_fee_rate', '2.2');
  setRate(db, 'finance.card_fee_rate_amex', '2.5');
  // Ohne eigenen Debit-Satz: KEIN Rückfall auf Normal — ein Nein vor jedem Schreiben, mit klarer Meldung.
  ok(code(meldung(() => fees.cardFeeRate('branch-main', 'debit'))) === 'CARD_FEE_NOT_CONFIGURED'
    && !fees.cardFeeConfigured('branch-main', 'debit') && fees.cardFeeConfigured('branch-main', 'normal') && fees.cardFeeConfigured('branch-main', 'amex'),
  'B ohne eigenen Debit-Satz: kein Satz (kein Rückfall auf Normal); Normal/Amex unberührt');
  const p0 = ware(500);
  const stand = () => S([n(db, 'SELECT COUNT(*) FROM invoices'), n(db, 'SELECT COUNT(*) FROM payments'), n(db, 'SELECT COUNT(*) FROM expenses'),
    n(db, 'SELECT COUNT(*) FROM ledger_entries'), n(db, 'SELECT COUNT(*) FROM orders'), n(db, 'SELECT COUNT(*) FROM order_payments'), n(db, 'SELECT quantity FROM products WHERE id = ?', [p0])]);
  const vor0 = stand();
  const nein0 = meldung(() => anlegen(db, { lines: [LINE(p0, 1000)], issuedDate: TODAY, payments: [{ amount: 400, method: 'cash' }, { amount: 600, method: 'card', cardBrand: 'debit' }] }));
  ok(code(nein0) === 'CARD_FEE_NOT_CONFIGURED' && /Settings/.test(nein0) && stand() === vor0,
    `B Debit ohne Satz beim Anlegen: Nein mit Hinweis auf Settings, nichts geschrieben — auch nicht die Barzahlung davor (${nein0.slice(0, 70)})`);
  const offen = anlegen(db, { lines: [LINE(p0, 1000)], issuedDate: TODAY });
  const vor1 = stand();
  const nein1 = meldung(() => imHaus(() => useInvoiceStore.getState().recordPayment(offen.invoiceId, 100, 'card', undefined, false, 'debit')));
  ok(code(nein1) === 'CARD_FEE_NOT_CONFIGURED' && stand() === vor1, 'B …dasselbe bei „Record payment" auf einer offenen Rechnung');
  const nein2 = meldung(() => imHaus(() => useOrderStore.getState().createOrder({ customerId: 'cust-1', agreedPrice: 500, depositAmount: 100, paymentMethod: 'card', cardBrand: 'debit', lines: [] } as never)));
  ok(code(nein2) === 'CARD_FEE_NOT_CONFIGURED' && stand() === vor1, `B …beim Anlegen eines Auftrags mit Debit-Anzahlung (kein Auftrag, keine Nummer) (${code(nein2)})`);
  const auftrag = imHaus(() => useOrderStore.getState().createOrder({ customerId: 'cust-1', agreedPrice: 500, lines: [] } as never));
  const vor2 = stand();
  const nein3 = meldung(() => imHaus(() => useOrderPaymentStore.getState().addPayment({ orderId: auftrag.id, amount: 100, method: 'card', cardBrand: 'debit', paidAt: TODAY } as never)));
  ok(code(nein3) === 'CARD_FEE_NOT_CONFIGURED' && stand() === vor2, `B …bei einer Auftrags-Anzahlung (${code(nein3)})`);
  const rep = imHaus(() => useRepairStore.getState().createRepair({ customerId: 'cust-1', itemDescription: 'Uhr', issueDescription: 'Glas', chargeToCustomer: 100 } as never));
  const repVor = S(rows(db, 'SELECT customer_paid_from, customer_card_brand, updated_at FROM repairs WHERE id = ?', [rep.id]));
  const nein4 = meldung(() => imHaus(() => useRepairStore.getState().updateRepair(rep.id, { customerPaidFrom: 'card', customerCardBrand: 'debit' } as never)));
  ok(code(nein4) === 'CARD_FEE_NOT_CONFIGURED' && S(rows(db, 'SELECT customer_paid_from, customer_card_brand, updated_at FROM repairs WHERE id = ?', [rep.id])) === repVor && stand() === vor2,
    `B …bei der Kundenzahlung einer Reparatur (Reparatur unverändert) (${code(nein4)})`);
  ok(/emptied once set/.test(src('src/pages/settings/SettingsPage.tsx')) && !/Debit card empty = same rate as Normal/.test(src('src/pages/settings/SettingsPage.tsx')),
    'B Settings: ein gesetzter Debit-Satz lässt sich nicht leeren (0 ist erlaubt); kein Hinweis mehr auf einen Rückfall');
  setRate(db, 'finance.card_fee_rate_debit', '1.5');
  ok(fees.cardFeeRate('branch-main', 'debit') === 1.5 && fees.cardFeeRate('branch-main', 'normal') === 2.2 && fees.cardFeeRate('branch-main', 'amex') === 2.5,
    'B eigener Debit-Satz 1,5 %; Normal und Amex unverändert');
  const p = ware(500);
  const out = anlegen(db, { lines: [LINE(p, 1000)], issuedDate: TODAY, payments: [{ amount: 1000, method: 'card', cardBrand: 'debit' }] });
  const g = gebuehren(db, out.invoiceId);
  const z = zahlungen(db, out.invoiceId);
  ok(z[0]?.card_brand === 'debit' && g.length === 1 && eq(Number(g[0].amount), 15) && /Debit/.test(String(g[0].description)),
    `B Debitzahlung: Marke gespeichert, Gebühr 1,5 % = 15 (${S(g)})`);
  setRate(db, 'finance.card_fee_rate_debit', '2.0');
  ok(eq(Number(gebuehren(db, out.invoiceId)[0].amount), 15), 'B Satz später geändert: die gebuchte Gebühr bleibt 15');
  const p2 = ware(500);
  const out2 = anlegen(db, { lines: [LINE(p2, 1000)], issuedDate: TODAY, payments: [{ amount: 1000, method: 'card', cardBrand: 'debit' }] });
  ok(eq(Number(gebuehren(db, out2.invoiceId)[0].amount), 20), 'B …eine neue Zahlung nimmt den neuen Satz (20)');
  const old = n(db, "SELECT COUNT(*) FROM payments WHERE card_brand = 'normal'");
  ok(old === 0 && n(db, "SELECT COUNT(*) FROM payments WHERE card_brand = 'debit'") === 2, 'B keine Umklassifizierung: nur die zwei Debitzahlungen tragen debit');
  ok(saldo(db, 'CARD_CLEARING') === Math.round((2000 - 35) * 1000) / 1000 && ausgeglichen(db), `B Karten-Clearing netto 1965 (${saldo(db, 'CARD_CLEARING')})`);
  // 0 % ist ein ausdrücklicher Satz: die Zahlung geht, es entsteht keine Gebühr.
  setRate(db, 'finance.card_fee_rate_debit', '0');
  const p3 = ware(500);
  const out3 = anlegen(db, { lines: [LINE(p3, 800)], issuedDate: TODAY, payments: [{ amount: 800, method: 'card', cardBrand: 'debit' }] });
  const z3 = zahlungen(db, out3.invoiceId);
  ok(out3.status === 'FINAL' && z3[0]?.card_brand === 'debit' && gebuehren(db, out3.invoiceId).length === 0 && eq(Number(banking().find((t) => t.id === `pay-${z3[0]?.id}`)?.amount), 800),
    'B Debit-Satz 0 %: Zahlung gebucht, keine Gebühr, Banking zeigt den vollen Betrag');
}

// ══ C — mehrere Zahlungen beim Anlegen ═══════════════════════════════════════
{
  const db = freshDb();
  setRate(db, 'finance.card_fee_rate', '2.0');
  setRate(db, 'finance.card_fee_rate_amex', '3.0');
  setRate(db, 'finance.card_fee_rate_debit', '1.0');
  const p = ware(1000);
  const out = anlegen(db, {
    lines: [LINE(p, 2000)], issuedDate: YESTERDAY, payments: [
      { amount: 500, method: 'cash' },
      { amount: 300, method: 'bank_transfer', paidDate: TODAY },
      { amount: 400, method: 'card', cardBrand: 'normal' },
      { amount: 200, method: 'card', cardBrand: 'amex' },
      { amount: 600, method: 'card', cardBrand: 'debit', paidDate: YESTERDAY },
    ],
  });
  const z = zahlungen(db, out.invoiceId);
  ok(z.length === 5 && out.paymentIds?.length === 5 && out.status === 'FINAL' && eq(out.paidAmount, 2000), `C fünf Zahlungen, Rechnung FINAL, bezahlt 2000 (${out.status} ${out.paidAmount})`);
  ok(new Set(z.map((x) => x.created_at)).size === 5, 'C jede Zahlung hat ihren EIGENEN Erfassungszeitpunkt');
  ok(z.filter((x) => String(x.received_at).slice(0, 10) === YESTERDAY).length === 4 && String(z[4].received_at).slice(0, 10) === TODAY,
    'C vier am Rechnungsdatum, die Bankzahlung am gewählten Tag (heute)');
  const g = gebuehren(db, out.invoiceId);
  ok(g.length === 3 && S(g.map((x) => Number(x.amount)).sort((a, b) => a - b)) === S([6, 6, 8]), `C drei Kartengebühren: Normal 8 (2 %), Amex 6 (3 %), Debit 6 (1 %) (${S(g.map((x) => x.amount))})`);
  ok(g.every((x) => String(x.expense_date) === YESTERDAY), 'C die Gebühren tragen den Tag ihrer Zahlung');
  const bt = banking();
  const netto = (id: unknown) => bt.find((t) => t.id === `pay-${id}`)?.amount;
  const byBrand = (b: string) => z.find((x) => x.card_brand === b);
  ok(eq(Number(netto(byBrand('normal')?.id)), 392) && eq(Number(netto(byBrand('amex')?.id)), 194) && eq(Number(netto(byBrand('debit')?.id)), 594),
    `C Banking nettet JEDE Kartenzahlung mit IHRER Gebühr (392 / 194 / 594) — ${S([netto(byBrand('normal')?.id), netto(byBrand('amex')?.id), netto(byBrand('debit')?.id)])}`);
  ok(saldo(db, 'ACCOUNTS_RECEIVABLE') === 0 && saldo(db, 'CASH') === 500 && saldo(db, 'BANK') === 300 && saldo(db, 'CARD_CLEARING') === 1200 - 20, 'C Hauptbuch: Forderung 0, Kasse 500, Bank 300, Karten 1180 netto');
  ok(ausgeglichen(db), 'C Hauptbuch ausgeglichen');
  ok(/^INV-/.test(String(out.invoiceNumber)) || !/^PINV/.test(String(out.invoiceNumber)), `C Endnummer vergeben (${out.invoiceNumber})`);
  // Teilzahlung.
  const p2 = ware(300);
  const t = anlegen(db, { lines: [LINE(p2, 1000)], issuedDate: TODAY, payments: [{ amount: 200, method: 'cash' }, { amount: 300, method: 'card', cardBrand: 'debit' }] });
  ok(t.status === 'PARTIAL' && eq(t.paidAmount, 500) && /^PINV/.test(t.invoiceNumber) && Math.round(n(db, "SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END), 0) FROM ledger_entries WHERE account = 'ACCOUNTS_RECEIVABLE' AND counterparty_id = 'cust-1'")) === 500,
    `C Teilzahlung: PARTIAL, bezahlt 500, offen 500 (${t.status} ${t.invoiceNumber})`);
  // Überzahlung: abgewiesen, nichts angelegt.
  const p3 = ware(300);
  const vor = S([n(db, 'SELECT COUNT(*) FROM invoices'), n(db, 'SELECT COUNT(*) FROM payments'), n(db, 'SELECT COUNT(*) FROM ledger_entries'), n(db, 'SELECT quantity FROM products WHERE id = ?', [p3])]);
  const ueber = meldung(() => anlegen(db, { lines: [LINE(p3, 500)], issuedDate: TODAY, payments: [{ amount: 300, method: 'cash' }, { amount: 300, method: 'bank_transfer' }] }));
  ok(code(ueber) === 'PAYMENT_EXCEEDS_TOTAL' && S([n(db, 'SELECT COUNT(*) FROM invoices'), n(db, 'SELECT COUNT(*) FROM payments'), n(db, 'SELECT COUNT(*) FROM ledger_entries'), n(db, 'SELECT quantity FROM products WHERE id = ?', [p3])]) === vor,
    `C Überzahlung beim Anlegen: abgewiesen, nichts geschrieben (${code(ueber)})`);
  // Rollback: die dritte Zahlung scheitert in der Datenbank → Rechnung, Zahlungen, Bestand, Buchungen weg.
  db.run("CREATE TRIGGER ip_bruch BEFORE INSERT ON payments WHEN NEW.method = 'benefit' BEGIN SELECT RAISE(ABORT, 'IP: injected'); END");
  const vor2 = S([n(db, 'SELECT COUNT(*) FROM invoices'), n(db, 'SELECT COUNT(*) FROM payments'), n(db, 'SELECT COUNT(*) FROM ledger_entries'), n(db, 'SELECT COUNT(*) FROM expenses'), n(db, 'SELECT quantity FROM products WHERE id = ?', [p3])]);
  const bruch = meldung(() => anlegen(db, { lines: [LINE(p3, 500)], issuedDate: TODAY, payments: [{ amount: 100, method: 'cash' }, { amount: 100, method: 'card', cardBrand: 'amex' }, { amount: 100, method: 'benefit' }] }));
  current.run('DROP TRIGGER ip_bruch');
  ok(/IP: injected/.test(bruch) && S([n(db, 'SELECT COUNT(*) FROM invoices'), n(db, 'SELECT COUNT(*) FROM payments'), n(db, 'SELECT COUNT(*) FROM ledger_entries'), n(db, 'SELECT COUNT(*) FROM expenses'), n(db, 'SELECT quantity FROM products WHERE id = ?', [p3])]) === vor2,
    `C Rollback: scheitert eine Zahlung, gibt es keine Rechnung, keine Zahlung, keine Gebühr, keinen Bestandsabzug (${bruch.slice(0, 60)})`);
  ok(code(meldung(() => house.invoiceCreatePayments({ payment: { amount: 1, method: 'cash' }, payments: [] }))) === 'PAYMENTS_INVALID'
    && code(meldung(() => house.invoiceCreatePayments({ payments: Array.from({ length: 11 }, () => ({ amount: 1, method: 'cash' })) }))) === 'PAYMENTS_INVALID'
    && code(meldung(() => house.invoiceCreatePayments({ payments: [{ amount: 1, method: 'card', cardBrand: 'visa' }] }))) === 'PAYMENT_METHOD_INVALID',
  'C Regeln: nicht beides, höchstens 10, nur bekannte Kartenarten');
}

// ══ D — VAT-Sperre ═════════════════════════════════════════════════════════════
{
  const db = freshDb();
  // Ein eingereichtes Quartal: das des Vortags — eine Zahlung, die dort schlösse, ist ein Nein.
  const [y, m] = YESTERDAY.split('-').map(Number);
  db.run(`INSERT INTO vat_filings (id, branch_id, year, quarter, filed_at, filed_by, invoice_count, snapshot_json, created_at)
          VALUES ('vf1','branch-main',?,?,?, 'user-test', 0, '{}', ?)`, [y, Math.ceil(m / 3), NOW, NOW]);
  const p = ware(200);
  const vor = n(db, 'SELECT COUNT(*) FROM invoices');
  const nein = meldung(() => anlegen(db, { lines: [LINE(p, 400)], issuedDate: YESTERDAY, payments: [{ amount: 400, method: 'cash', paidDate: YESTERDAY }] }));
  ok(code(nein) === 'VAT_PERIOD_FILED' && n(db, 'SELECT COUNT(*) FROM invoices') === vor, `D Vollzahlung in ein eingereichtes Quartal: Nein, nichts angelegt (${nein.slice(0, 80)})`);
  const q = Math.ceil(m / 3); const tq = Math.ceil(Number(TODAY.slice(5, 7)) / 3);
  if (q === tq && YESTERDAY.slice(0, 4) === TODAY.slice(0, 4)) {
    ok(true, 'D (heute liegt im selben eingereichten Quartal — der Ausweichtag entfällt)');
  } else {
    // v0.8.93 — das Rechnungsdatum selbst liegt im eingereichten Quartal: Umsatz/VAT würden dort gebucht → Nein.
    const neinDatum = meldung(() => anlegen(db, { lines: [LINE(p, 400)], issuedDate: YESTERDAY, payments: [{ amount: 400, method: 'cash', paidDate: TODAY }] }));
    const ja = anlegen(db, { lines: [LINE(p, 400)], issuedDate: TODAY, payments: [{ amount: 400, method: 'cash', paidDate: TODAY }] });
    ok(code(neinDatum) === 'VAT_PERIOD_FILED' && ja.status === 'FINAL', 'D Rechnungsdatum im eingereichten Quartal: Nein; mit Datum im offenen Quartal geht derselbe Verkauf');
  }
  ok(S(liveVatQuarters('branch-main').get(`${y}-Q${q}`) ?? null) === 'null' || (liveVatQuarters('branch-main').get(`${y}-Q${q}`)?.invoiceCount ?? 0) === 0,
    'D das eingereichte Quartal bekommt keine Rechnung dazu');
}
{
  // D2 — ein VORIGES, eingereichtes Quartal (Rechnungstag vor ~100 Tagen) gegen das offene von heute.
  const db = freshDb();
  const ALT = dayBefore(TODAY, 100);
  const [ay, am] = ALT.split('-').map(Number);
  const altKey = `${ay}-Q${Math.ceil(am / 3)}`;
  db.run(`INSERT INTO vat_filings (id, branch_id, year, quarter, filed_at, filed_by, invoice_count, snapshot_json, created_at)
          VALUES ('vf2','branch-main',?,?,?, 'user-test', 0, '{}', ?)`, [ay, Math.ceil(am / 3), NOW, NOW]);
  const imAlten = () => liveVatQuarters('branch-main').get(altKey)?.invoiceCount ?? 0;
  const qVon = `${ay}-${String((Math.ceil(am / 3) - 1) * 3 + 1).padStart(2, '0')}-01`;
  const qBis = `${ay}-${String(Math.ceil(am / 3) * 3).padStart(2, '0')}-31T23:59:59.999Z`;
  // Was die gemeldete Periode an ZAHLUNGEN ausmacht: Snapshot, Zahlungen (Banking), Zahlungs-/Gebührenbuchungen im
  // Hauptbuch — alles mit Datum im Quartal. (Die Verkaufsbuchung einer rückdatierten Rechnung am Rechnungstag ist
  // älteres, gewolltes Verhalten — v0.8.72 „nachträglich erfassen" — und keine Zahlungsbuchung. Seit v0.8.93 lässt
  // sich eine NEUE Rechnung nicht mehr in ein eingereichtes Quartal datieren; die alte unten entsteht vorher.)
  const periode = () => S({
    snap: one(db, "SELECT snapshot_json FROM vat_filings WHERE id = 'vf2'"),
    pay: n(db, 'SELECT COUNT(*) FROM payments WHERE received_at >= ? AND received_at <= ?', [qVon, qBis]),
    bank: banking().filter((t) => String(t.date) >= qVon && String(t.date) <= qBis).length,
    led: n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module IN ('PAYMENT', 'EXPENSE', 'REFUND') AND occurred_at >= ? AND occurred_at <= ?", [qVon, qBis]),
    exp: n(db, 'SELECT COUNT(*) FROM expenses WHERE expense_date >= ? AND expense_date <= ?', [qVon, qBis.slice(0, 10)]),
  });
  const p = ware(200);
  const alles = () => S([n(db, 'SELECT COUNT(*) FROM invoices'), n(db, 'SELECT COUNT(*) FROM payments'), n(db, 'SELECT COUNT(*) FROM ledger_entries'), n(db, 'SELECT COUNT(*) FROM expenses')]);
  const vor = alles();
  const perVor = periode();
  // Vorschlag = Rechnungstag → die Vollzahlung fiele ins eingereichte Quartal: Nein, nichts angelegt.
  const nein = meldung(() => anlegen(db, { lines: [LINE(p, 400)], issuedDate: ALT, payments: [{ amount: 400, method: 'cash' }] }));
  ok(code(nein) === 'VAT_PERIOD_FILED' && alles() === vor, `D2 Abschlusszahlung im eingereichten Quartal: Nein, nichts angelegt (${code(nein)})`);
  // v0.8.88 — auch eine TEILzahlung mit Tag im eingereichten Quartal ist ein Nein (vorher erlaubt): nichts angelegt.
  const neinTeil = meldung(() => anlegen(db, { lines: [LINE(p, 400)], issuedDate: ALT, payments: [{ amount: 100, method: 'cash' }] }));
  const neinMix = meldung(() => anlegen(db, { lines: [LINE(p, 400)], issuedDate: ALT, payments: [{ amount: 300, method: 'card', cardBrand: 'normal' }, { amount: 100, method: 'cash', paidDate: TODAY }] }));
  ok(code(neinTeil) === 'VAT_PERIOD_FILED' && code(neinMix) === 'VAT_PERIOD_FILED' && /open quarter/.test(neinTeil) && alles() === vor,
    `D2 Teilzahlung im eingereichten Quartal (allein / mit Rest heute): Nein mit Hinweis, nichts angelegt (${code(neinTeil)} / ${code(neinMix)})`);
  // v0.8.93 — bis v0.8.92 erlaubt: Rechnungstag im eingereichten Quartal, Zahlungen heute. Export heute, aber Umsatz,
  // VAT und Forderung stünden mit neuen Hauptbuchzeilen im eingereichten Quartal → jetzt ebenfalls ein Nein.
  const neinDatum = meldung(() => anlegen(db, { lines: [LINE(p, 400)], issuedDate: ALT, payments: [{ amount: 300, method: 'cash', paidDate: TODAY }, { amount: 100, method: 'card', cardBrand: 'normal', paidDate: TODAY }] }));
  ok(code(neinDatum) === 'VAT_PERIOD_FILED' && /new invoice dated in that quarter/.test(neinDatum) && alles() === vor,
    `D2 Rechnungstag im eingereichten Quartal, Zahlungen heute: Nein, nichts angelegt (${code(neinDatum)})`);
  // Mit Rechnungstag im offenen Quartal: FINAL, Exportmonat heute, das eingereichte Quartal bekommt nichts.
  const ja = anlegen(db, { lines: [LINE(p, 400)], issuedDate: TODAY, payments: [{ amount: 300, method: 'cash', paidDate: TODAY }, { amount: 100, method: 'card', cardBrand: 'normal', paidDate: TODAY }] });
  const nbr = nbrMonthTotals(nbrInvoicesFromDb('branch-main', 'FINAL').invoices, nbrInvoicesFromDb('branch-main', 'FINAL').payments);
  ok(ja.status === 'FINAL' && nbr.some((m) => m.invoiceIds.includes(ja.invoiceId) && m.month === TODAY.slice(0, 7)) && imAlten() === 0,
    `D2 Rechnung und Zahlungen im offenen Quartal: FINAL, Exportmonat ${TODAY.slice(0, 7)}, eingereichtes Quartal ${altKey} ohne Rechnung`);
  // Teilzahlung heute, dann umdatieren — weder HINEIN ins eingereichte Quartal … (eine ALTE Rechnung mit Tag im
  // Quartal, angelegt bevor es eingereicht wurde: die Einreichung für die Anlage kurz beiseite.)
  const p2 = ware(200);
  db.run("UPDATE vat_filings SET year = -year WHERE id = 'vf2'");
  const teil = anlegen(db, { lines: [LINE(p2, 400)], issuedDate: ALT, payments: [{ amount: 100, method: 'cash', paidDate: TODAY }] });
  db.run("UPDATE vat_filings SET year = -year WHERE id = 'vf2'");
  const zt = zahlungen(db, teil.invoiceId)[0];
  const vorUm = S(rows(db, 'SELECT amount, received_at FROM payments WHERE id = ?', [zt?.id]));
  const neinUm = meldung(() => useInvoiceStore.getState().updatePayment(String(zt?.id), teil.invoiceId, { receivedAt: `${ALT}T12:00:00.000Z` }));
  ok(teil.status === 'PARTIAL' && code(neinUm) === 'VAT_PERIOD_FILED' && S(rows(db, 'SELECT amount, received_at FROM payments WHERE id = ?', [zt?.id])) === vorUm,
    `D2 Teilzahlung ins eingereichte Quartal umdatieren: Nein, Zahlung unverändert (${code(neinUm)})`);
  // … und auf PC2 dasselbe Nein (eingefroren), beim Anlegen wie beim Umdatieren.
  const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-000000000000`;
  const ACTOR = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role: 'ADMIN' };
  const deps = { db: db as never, begin: () => { setTestDatabase(db as never); posting.beginLedgerTransaction(); },
    commit: posting.commitLedgerTransaction, rollback: posting.rollbackLedgerTransaction, durableSave: async () => {}, now: () => new Date().toISOString() };
  const p3 = ware(200);
  const lot3 = String(one(db, 'SELECT id FROM stock_lots WHERE product_id = ?', [p3]) ?? '');
  const vorR = alles();
  const rA = await cmd.runInvoiceCreate(deps as never, { commandId: ID('41'), ...ACTOR, op: 'invoices.create', payloadHash: 'h41' } as never,
    { customerId: 'cust-1', lines: [{ productId: p3, lotId: lot3, quantity: 1, unitPrice: 400, scheme: 'ZERO' }], issuedDate: ALT, specialMark: false, payments: [{ amount: 100, method: 'cash', paidDate: ALT }] },
  ) as { kind: string; code?: string; frozen?: boolean };
  setTestDatabase(db as never); reload();
  ok(rA.kind === 'rejected' && rA.code === 'VAT_PERIOD_FILED' && rA.frozen === true && alles() === vorR, `D2 PC2 Teilzahlung im eingereichten Quartal anlegen: eingefrorenes Nein, nichts angelegt (${rA.kind} ${rA.code})`);
  const rev = Number(one(db, 'SELECT revision FROM invoices WHERE id = ?', [teil.invoiceId]) ?? 0);
  const rU = await fin.runUpdatePayment(deps as never, { commandId: ID('42'), ...ACTOR, op: 'invoices.update_payment', payloadHash: 'h42' } as never,
    { invoiceId: teil.invoiceId, paymentId: String(zt?.id), expectedRevision: rev, receivedAt: `${ALT}T12:00:00.000Z` },
  ) as { kind: string; code?: string };
  setTestDatabase(db as never); reload();
  ok(rU.kind === 'rejected' && rU.code === 'VAT_PERIOD_FILED' && S(rows(db, 'SELECT amount, received_at FROM payments WHERE id = ?', [zt?.id])) === vorUm,
    `D2 PC2 Zahlung ins eingereichte Quartal umdatieren: Nein, Zahlung unverändert (${rU.kind} ${rU.code})`);
  // Die Restzahlung heute (Rechnungsseite, ohne Tag): Abschluss heute — wie bisher.
  imHaus(() => useInvoiceStore.getState().recordPayment(teil.invoiceId, 300, 'cash'));
  reload();
  ok(useInvoiceStore.getState().getInvoice(teil.invoiceId)?.status === 'FINAL' && imAlten() === 0, 'D2 …Rest heute: FINAL im offenen Quartal');
  ok(periode() === perVor, `D2 die gemeldete Periode ist unverändert: Snapshot, Zahlungen/Banking, Zahlungs- und Gebührenbuchungen (${periode()})`);
  ok(ausgeglichen(db), 'D2 Hauptbuch ausgeglichen');
}

// ══ E — PC2: derselbe Befehl fern ═══════════════════════════════════════════════
{
  const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-000000000000`;
  const ACTOR = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role: 'ADMIN' };
  const identity = (x: string) => ({ commandId: ID(x), ...ACTOR, op: 'invoices.create', payloadHash: 'h' + x });
  const deps = (db: Db) => ({
    db: db as never,
    begin: () => { setTestDatabase(db as never); posting.beginLedgerTransaction(); },
    commit: posting.commitLedgerTransaction,
    rollback: posting.rollbackLedgerTransaction,
    durableSave: async () => {},
    now: () => new Date().toISOString(),
  });
  const bild = (db: Db, invId: string) => S({
    inv: rows(db, 'SELECT status, gross_amount, paid_amount, substr(issued_at, 1, 10) AS d FROM invoices WHERE id = ?', [invId]),
    pay: rows(db, 'SELECT amount, method, card_brand, substr(received_at, 1, 10) AS d FROM payments WHERE invoice_id = ? ORDER BY received_at, amount', [invId]),
    fee: rows(db, "SELECT amount, expense_date FROM expenses WHERE category = 'CardFees' AND related_entity_id = ? ORDER BY amount", [invId]),
    led: rows(db, "SELECT account, ROUND(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END), 3) AS s FROM ledger_entries GROUP BY account HAVING ABS(s) > 0.0005 ORDER BY account"),
  });
  const ZAHL = [{ amount: 300, method: 'cash' }, { amount: 700, method: 'card', cardBrand: 'debit', paidDate: TODAY }];
  const dbP = freshDb();
  setRate(dbP, 'finance.card_fee_rate_debit', '1.0');
  const pP = ware(400);
  const outP = anlegen(dbP, { lines: [LINE(pP, 1000)], issuedDate: YESTERDAY, payments: ZAHL });
  const bP = bild(dbP, outP.invoiceId);
  const dbR = freshDb();
  setRate(dbR, 'finance.card_fee_rate_debit', '1.0');
  const pR = ware(400);
  const lot = String(one(dbR, 'SELECT id FROM stock_lots WHERE product_id = ?', [pR]) ?? '');
  const body = { customerId: 'cust-1', lines: [{ productId: pR, lotId: lot, quantity: 1, unitPrice: 1000, scheme: 'ZERO' }], issuedDate: YESTERDAY, specialMark: false, payments: ZAHL };
  const r = await cmd.runInvoiceCreate(deps(dbR), identity('31') as never, body) as { kind: string; value?: Record<string, unknown>; replayed?: boolean };
  setTestDatabase(dbR as never); reload();
  const invR = String(r.value?.invoiceId ?? '');
  ok(r.kind === 'ok' && (r.value?.paymentIds as unknown[])?.length === 2, `E PC2: invoices.create mit zwei Zahlungen geht durch (${r.kind} ${S(r.value).slice(0, 120)})`);
  ok(bild(dbR, invR) === bP, `E PC2 == Primary: Rechnung, Zahlungen (Tag, Marke), Gebühr, Salden\n  P=${bP}\n  R=${bild(dbR, invR)}`);
  const vorWdh = S([n(dbR, 'SELECT COUNT(*) FROM invoices'), n(dbR, 'SELECT COUNT(*) FROM payments'), n(dbR, 'SELECT COUNT(*) FROM ledger_entries')]);
  const r2 = await cmd.runInvoiceCreate(deps(dbR), identity('31') as never, body) as { kind: string; replayed?: boolean };
  setTestDatabase(dbR as never);
  ok(r2.kind === 'ok' && r2.replayed === true && S([n(dbR, 'SELECT COUNT(*) FROM invoices'), n(dbR, 'SELECT COUNT(*) FROM payments'), n(dbR, 'SELECT COUNT(*) FROM ledger_entries')]) === vorWdh,
    'E dieselbe Kennung noch einmal (Doppelklick / verlorene Antwort): Wiederholung, keine zweite Rechnung, keine zweite Zahlung');
  const wirft = (raw: unknown): string => { try { cmd.parseInvoiceCreatePayload(raw); return ''; } catch (e) { return (e as Error).message; } };
  const basis = { customerId: 'cust-1', lines: [{ productId: pR, quantity: 1, unitPrice: 1 }] };
  ok(wirft({ ...basis, payment: { amount: 1, method: 'cash' } }) === '', 'E der bisherige Rumpf `payment` geht weiter (älterer PC2)');
  ok(/not both/.test(wirft({ ...basis, payment: { amount: 1, method: 'cash' }, payments: [{ amount: 1, method: 'cash' }] })), 'E `payment` UND `payments`: abgewiesen');
  ok(/primary decides receivedAt/.test(wirft({ ...basis, payments: [{ amount: 1, method: 'cash', receivedAt: NOW }] }))
    && /primary decides fee/.test(wirft({ ...basis, payments: [{ amount: 1, method: 'card', fee: 0 }] }))
    && /unknown field/.test(wirft({ ...basis, payments: [{ amount: 1, method: 'cash', foo: 1 }] })),
  'E Zeitpunkt, Gebühr und Unbekanntes bestimmt der Primary — der Rumpf trägt nur Betrag, Weg, Marke, Tag');
  ok(/not a valid date|cannot be in the future/.test(wirft({ ...basis, payments: [{ amount: 1, method: 'cash', paidDate: '24.10.2026' }] })), 'E ein Tag in falscher Form: abgewiesen');
  const { invoiceFinalizationDate: _f } = { invoiceFinalizationDate };
  void _f;
  const nbr = nbrMonthTotals(nbrInvoicesFromDb('branch-main', 'FINAL').invoices, nbrInvoicesFromDb('branch-main', 'FINAL').payments);
  ok(nbr.some((m) => m.invoiceIds.includes(invR) && m.month === TODAY.slice(0, 7)), 'E NBR: die Rechnung steht im Monat ihrer Vollzahlung (spätester Zahlungstag)');
  // PC2 ohne Debit-Satz am Primary: ein eingefrorenes fachliches Nein mit Kennung und Meldung, nichts angelegt.
  const dbN = freshDb();
  const pN = ware(400);
  const lotN = String(one(dbN, 'SELECT id FROM stock_lots WHERE product_id = ?', [pN]) ?? '');
  const vorN = S([n(dbN, 'SELECT COUNT(*) FROM invoices'), n(dbN, 'SELECT COUNT(*) FROM payments'), n(dbN, 'SELECT COUNT(*) FROM ledger_entries')]);
  const rN = await cmd.runInvoiceCreate(deps(dbN), identity('32') as never,
    { customerId: 'cust-1', lines: [{ productId: pN, lotId: lotN, quantity: 1, unitPrice: 1000, scheme: 'ZERO' }], issuedDate: TODAY, specialMark: false, payments: [{ amount: 1000, method: 'card', cardBrand: 'debit' }] },
  ) as { kind: string; code?: string; message?: string; frozen?: boolean };
  setTestDatabase(dbN as never);
  ok(rN.kind === 'rejected' && rN.code === 'CARD_FEE_NOT_CONFIGURED' && rN.frozen === true && /Settings/.test(String(rN.message))
    && S([n(dbN, 'SELECT COUNT(*) FROM invoices'), n(dbN, 'SELECT COUNT(*) FROM payments'), n(dbN, 'SELECT COUNT(*) FROM ledger_entries')]) === vorN,
  `E PC2 Debit ohne Satz: Nein CARD_FEE_NOT_CONFIGURED (endgültig, mit Meldung), nichts angelegt (${rN.kind} ${rN.code})`);
  // Auftrag von PC2: Debit ist eine bekannte Kartenart (vorher kannte der Rumpf nur Normal/Amex).
  const auftragRumpf = (b: string): string => {
    try { return 'ok:' + commercial.parseOrderCreate({ customerId: 'cust-1', lines: [{ mode: 'existing', productId: pN, quantity: 1, unitPrice: 100 }], depositAmount: 50, paymentMethod: 'card', cardBrand: b }).cardBrand; }
    catch (e) { return (e as Error).message; }
  };
  ok(auftragRumpf('debit') === 'ok:debit' && /card brand/.test(auftragRumpf('visa')), `E PC2 Auftrag: Debit-Anzahlung im Rumpf erlaubt, Unbekanntes nicht (${auftragRumpf('debit')} / ${auftragRumpf('visa')})`);
}

// ══ F — v0.8.88: Zahlungsdatum bei „Record Payment" + endgültige Nummer im Gebührentext ═══════════════════
{
  const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-000000000000`;
  const ACTOR = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role: 'ADMIN' };
  const ident = (x: string) => ({ commandId: ID(x), ...ACTOR, op: 'invoices.record_payment', payloadHash: 'h' + x });
  const depsF = (db: Db) => ({
    db: db as never, begin: () => { setTestDatabase(db as never); posting.beginLedgerTransaction(); },
    commit: posting.commitLedgerTransaction, rollback: posting.rollbackLedgerTransaction, durableSave: async () => {}, now: () => new Date().toISOString(),
  });
  const zahlen = (db: Db, input: Record<string, unknown>) => { const r = imHaus(() => payHouse.recordInvoicePaymentInHouse(input as never, 'branch-main')); reload(); return r; };
  const T3 = dayBefore(TODAY, 3);
  const T2 = dayBefore(TODAY, 2);
  const alles = (db: Db) => S([n(db, 'SELECT COUNT(*) FROM payments'), n(db, 'SELECT COUNT(*) FROM ledger_entries'), n(db, 'SELECT COUNT(*) FROM expenses')]);

  // F1 Primary: Rechnung vom T-3 ohne Zahlung, Kartenzahlung nachgetragen mit Tag T-2.
  const db = freshDb();
  const p = ware(400);
  const offen = anlegen(db, { lines: [LINE(p, 1000)], issuedDate: T3 });
  const r1 = zahlen(db, { invoiceId: offen.invoiceId, amount: 400, method: 'card', cardBrand: 'normal', paidDate: T2 });
  const z1 = zahlungen(db, offen.invoiceId).find((x) => x.id === r1.paymentId)!;
  ok(String(z1.received_at).slice(0, 10) === T2 && String(z1.created_at).slice(0, 10) === TODAY,
    `F1 Record Payment mit Tag: Eingang ${T2}, Erfassung bleibt heute (${z1.received_at} / ${z1.created_at})`);
  const le1 = rows(db, "SELECT occurred_at FROM ledger_entries WHERE source_module = 'PAYMENT' AND source_id = ?", [r1.paymentId]);
  const g1 = gebuehren(db, offen.invoiceId);
  const b1 = banking().find((t) => t.id === `pay-${r1.paymentId}`);
  ok(le1.length > 0 && le1.every((r) => String(r.occurred_at).slice(0, 10) === T2) && g1.length === 1 && String(g1[0].expense_date) === T2
    && String(g1[0].created_at) === String(z1.created_at) && b1 && String(b1.date).slice(0, 10) === T2 && eq(Number(b1.amount), 400 - 8.8),
  `F1 Hauptbuch, Gebühr (Tag + Verknüpfung) und Banking (netto ${b1?.amount}) tragen den Zahlungstag`);
  // F2 Grenzen: vor dem Rechnungsdatum / Zukunft → Nein, nichts geschrieben.
  const vor2 = alles(db);
  const frueh = meldung(() => zahlen(db, { invoiceId: offen.invoiceId, amount: 100, method: 'cash', paidDate: dayBefore(TODAY, 5) }));
  const spaet = meldung(() => zahlen(db, { invoiceId: offen.invoiceId, amount: 100, method: 'cash', paidDate: '2099-01-01' }));
  const kaputt = meldung(() => zahlen(db, { invoiceId: offen.invoiceId, amount: 100, method: 'cash', paidDate: '25.10.2026' }));
  ok(code(frueh) === 'PAYMENT_DATE_BEFORE_INVOICE' && code(spaet) === 'PAYMENT_DATE_INVALID' && code(kaputt) === 'PAYMENT_DATE_INVALID' && alles(db) === vor2,
    `F2 vor dem Rechnungsdatum / Zukunft / falsche Form: Nein, nichts geschrieben (${code(frueh)} / ${code(spaet)} / ${code(kaputt)})`);
  // F3 ohne Tag: wie bisher (Eingang == Erfassung) — und die schließende Zahlung bekommt die Endnummer.
  const r3 = zahlen(db, { invoiceId: offen.invoiceId, amount: 600, method: 'cash', specialMarkOnFinal: false });
  const z3 = zahlungen(db, offen.invoiceId).find((x) => x.id === r3.paymentId)!;
  ok(String(z3.received_at) === String(z3.created_at) && r3.status === 'FINAL', `F3 ohne Tag wie bisher: Eingang == Erfassung, FINAL (${r3.invoiceNumber})`);
  // Historisches nicht umschreiben: die Gebühr der früheren Teilzahlung behält ihren Text (damals PINV).
  ok(/PINV-/.test(String(gebuehren(db, offen.invoiceId)[0]?.description)), `F3 die Gebühr der früheren Teilzahlung bleibt, wie sie gebucht wurde (${gebuehren(db, offen.invoiceId)[0]?.description})`);
  ok(ausgeglichen(db), 'F Hauptbuch ausgeglichen');

  // F4 eingereichtes Quartal: Rechnung vor ~100 Tagen, Quartal eingereicht.
  const ALT = dayBefore(TODAY, 100);
  const [ay, am] = ALT.split('-').map(Number);
  // Die Rechnung entstand, bevor das Quartal eingereicht wurde (seit v0.8.93 ließe sie sich danach nicht mehr anlegen).
  const p4 = ware(200);
  const alt = anlegen(db, { lines: [LINE(p4, 500)], issuedDate: ALT });
  db.run(`INSERT INTO vat_filings (id, branch_id, year, quarter, filed_at, filed_by, invoice_count, snapshot_json, created_at)
          VALUES ('vf3','branch-main',?,?,?, 'user-test', 0, '{}', ?)`, [ay, Math.ceil(am / 3), NOW, NOW]);
  const vor4 = alles(db);
  const nein4 = meldung(() => zahlen(db, { invoiceId: alt.invoiceId, amount: 100, method: 'cash', paidDate: ALT }));
  ok(code(nein4) === 'VAT_PERIOD_FILED' && alles(db) === vor4, `F4 Teilzahlung mit Tag im eingereichten Quartal: Nein, nichts geschrieben (${code(nein4)})`);
  const r4 = zahlen(db, { invoiceId: alt.invoiceId, amount: 100, method: 'cash', paidDate: TODAY });
  ok(r4.status === 'PARTIAL' && String(zahlungen(db, alt.invoiceId)[0]?.received_at).slice(0, 10) === TODAY, 'F4 …mit Tag im offenen Quartal geht');

  // F5 PC2 == Primary, Wiederholung ohne zweite Wirkung, Rumpfregeln.
  const bildF = (d: Db, invId: string) => S({
    pay: rows(d, 'SELECT amount, method, card_brand, substr(received_at, 1, 10) AS d FROM payments WHERE invoice_id = ? ORDER BY received_at, amount', [invId]),
    fee: rows(d, "SELECT amount, expense_date FROM expenses WHERE category = 'CardFees' AND related_entity_id = ? ORDER BY amount", [invId]),
    led: rows(d, "SELECT account, ROUND(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END), 3) AS s FROM ledger_entries GROUP BY account HAVING ABS(s) > 0.0005 ORDER BY account"),
  });
  const ZAHLUNG = { amount: 300, method: 'card', cardBrand: 'amex', paidDate: T2 };
  const dbP = freshDb();
  const pP = ware(400);
  const invP = anlegen(dbP, { lines: [LINE(pP, 1000)], issuedDate: T3 });
  zahlen(dbP, { invoiceId: invP.invoiceId, ...ZAHLUNG });
  const bP = bildF(dbP, invP.invoiceId);
  const dbR = freshDb();
  const pR = ware(400);
  const invR = anlegen(dbR, { lines: [LINE(pR, 1000)], issuedDate: T3 });
  const body = payHouse.invoicePaymentBody({ invoiceId: invR.invoiceId, ...ZAHLUNG } as never);
  const rR = await lifecycle.runInvoicePayment(depsF(dbR) as never, ident('51') as never, body) as { kind: string; value?: Record<string, unknown> };
  setTestDatabase(dbR as never); reload();
  ok(rR.kind === 'ok' && body.paidDate === T2 && bildF(dbR, invR.invoiceId) === bP, `F5 PC2 == Primary: Zahlung (Tag, Marke), Gebühr, Salden\n  P=${bP}\n  R=${bildF(dbR, invR.invoiceId)}`);
  const vorW = alles(dbR);
  const rW = await lifecycle.runInvoicePayment(depsF(dbR) as never, ident('51') as never, body) as { kind: string; replayed?: boolean };
  setTestDatabase(dbR as never);
  ok(rW.kind === 'ok' && rW.replayed === true && alles(dbR) === vorW, 'F5 dieselbe Kennung noch einmal (Verbindungsabbruch): Wiederholung, keine zweite Zahlung');
  const rumpf = (raw: unknown): string => { try { lifecycle.parsePaymentPayload(raw); return ''; } catch (e) { return (e as Error).message; } };
  ok(/primary decides receivedAt/.test(rumpf({ invoiceId: 'x', amount: 1, method: 'cash', receivedAt: NOW }))
    && /not a valid date|cannot be in the future/.test(rumpf({ invoiceId: 'x', amount: 1, method: 'cash', paidDate: '2099-01-01' }))
    && rumpf({ invoiceId: 'x', amount: 1, method: 'cash', paidDate: T2 }) === '' && rumpf({ invoiceId: 'x', amount: 1, method: 'cash' }) === '',
  'F5 Rumpf: paidDate erlaubt (und weggelassen wie bisher), receivedAt bestimmt der Primary, Zukunft abgewiesen');

  // F6 endgültige Nummer im Gebührentext — gemischte Zahlungen beim Anlegen.
  const dbN = freshDb();
  const pN = ware(1000);
  const gem = anlegen(dbN, { lines: [LINE(pN, 2000)], issuedDate: T2, payments: [
    { amount: 500, method: 'card', cardBrand: 'normal' }, { amount: 500, method: 'cash' },
    { amount: 400, method: 'card', cardBrand: 'amex', paidDate: TODAY }, { amount: 600, method: 'bank_transfer', paidDate: TODAY },
  ] });
  const gN = gebuehren(dbN, gem.invoiceId);
  const label = String(formatInvoiceDisplay(useInvoiceStore.getState().getInvoice(gem.invoiceId)));
  ok(gem.status === 'FINAL' && gN.length === 2 && gN.every((g) => String(g.description).split(' · ')[1] === label && !/PINV/.test(String(g.description))),
    `F6 gemischte Zahlungen: jede Gebühr trägt die endgültige Nummer ${label} (${S(gN.map((g) => g.description))})`);
  ok(S(gN.map((g) => Number(g.amount)).sort((a, b) => a - b)) === S([10, 11]) && n(dbN, "SELECT COUNT(*) FROM expenses WHERE category = 'CardFees'") === 2
    && ausgeglichen(dbN) && saldo(dbN, 'CARD_CLEARING') === 900 - 21,
  'F6 …Beträge, Anzahl und Buchungen der Gebühren unverändert (11 + 10, keine zusätzliche, Karten-Clearing netto 879)');
  const teil = anlegen(dbN, { lines: [LINE(ware(300), 1000)], issuedDate: TODAY, payments: [{ amount: 200, method: 'card', cardBrand: 'normal' }] });
  ok(String(gebuehren(dbN, teil.invoiceId)[0]?.description).split(' · ')[1] === String(formatInvoiceDisplay(useInvoiceStore.getState().getInvoice(teil.invoiceId))),
    'F6 Teilzahlung: die Gebühr trägt die (noch vorläufige) Nummer, die die Rechnung jetzt hat');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — invoice payments v0.8.88: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
