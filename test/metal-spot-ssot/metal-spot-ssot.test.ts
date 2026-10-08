// ════════════════════════════════════════════════════════════════════════════
// METAL-SPOT-SSOT — EINE Live-Umrechnung: BHD pro Gramm Feinmetall = USD/oz ÷ 31.1034768 × 0.376.
// Echte sql.js-Datenbank (schema.sql + echte Migrationen + A1 + Medienschema) für den Hauspreis-Teil.
// Run: node --experimental-strip-types test/metal-spot-ssot/metal-spot-ssot.test.ts
//
//   1 die zentrale Funktion (ungerundet)   2 Übersicht Gold/Silber = zentrale Funktion (Ausdruck aus dem
//     Quelltext ausgewertet)   3 Add Material / Auftrag: dieselbe Zahl × Gold-Reinheit; Silber 999/925
//   4 Precious Metals: Hauspreis von Hand, Live-Wert nur Referenz, nichts rückwirkend   5 keine zweite Formel
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
const { useSalesReturnStore } = await import('../../src/stores/salesReturnStore.ts');
const { useCreditNoteStore } = await import('../../src/stores/creditNoteStore.ts');
const { useAuthStore } = await import('../../src/stores/authStore.ts');
const cancelReturnHouse = await import('../../src/core/returns/return-cancel-house.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const S = (v: unknown): string => JSON.stringify(v);
const NOW = '2026-10-07T10:00:00.000Z';
const r3 = (x: number): number => Math.round(x * 1000) / 1000;
const eq = (a: number, b: number): boolean => Math.abs(a - b) < 0.0005;

interface Db {
  run(sql: string, p?: unknown[]): unknown;
  exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
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

function reload(): void {
  useProductStore.getState().loadProducts();
  useCustomerStore.getState().loadCustomers();
  useSupplierStore.getState().loadSuppliers();
  usePurchaseStore.getState().loadPurchases();
  useInvoiceStore.getState().loadInvoices();
  useSalesReturnStore.getState().loadReturns();
  useCreditNoteStore.getState().loadCreditNotes();
}

/** Artikel ohne Los; `price` = sein (Brutto-)Einkaufspreis wie nach einem Einkauf. */
function product(db: Db, id: string, price: number, qty = 0): void {
  db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
      scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
      tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
    VALUES (?,'branch-main','cat-w','Silver',?,?,?,'New','[]',?,'BHD',150,'in_stock','MARGIN',0,'[]','{}','OWN',?,?)`,
  [id, 'Item ' + id, 'SKU-' + id, qty, price, NOW, NOW]);
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
  db.run("INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at) VALUES ('sup-1','branch-main','Lieferant',1,?,?)", [NOW, NOW]);
  applyMediaSchema(db as never);
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  reload();
  tauriState.reset();
  return db;
}

useAuthStore.setState({ session: { userId: 'user-test', branchId: 'branch-main', role: 'ADMIN' } as never });
const OWNER_ACTOR = { userId: 'user-test', role: 'ADMIN' };
const CTX = { branchId: 'branch-main', userId: 'user-test', now: NOW };

function imHaus<T>(fn: () => T): T {
  posting.beginLedgerTransaction();
  try { const out = fn(); posting.commitLedgerTransaction(); return out; }
  catch (e) { posting.rollbackLedgerTransaction(); throw e; }
}
async function imHausAsync<T>(fn: () => Promise<T>): Promise<T> {
  posting.beginLedgerTransaction();
  try { const out = await fn(); posting.commitLedgerTransaction(); return out; }
  catch (e) { posting.rollbackLedgerTransaction(); throw e; }
}
function meldung(fn: () => unknown): string {
  try { fn(); return ''; } catch (e) { return String((e as { code?: unknown }).code ?? '') + '|' + (e as Error).message; }
}
async function meldungAsync(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return ''; } catch (e) { return String((e as { code?: unknown }).code ?? '') + '|' + (e as Error).message; }
}

/** Einkauf: Stückpreis BRUTTO, wie die Maske ihn nimmt. */
function kauf(productId: string, quantity: number, unitPrice: number, vat: boolean): string {
  const id = imHaus(() => usePurchaseStore.getState().createPurchase({
    supplierId: 'sup-1',
    lines: [{ productId, quantity, unitPrice, taxScheme: vat ? 'VAT_10' as const : 'ZERO' as const, vatRate: vat ? 10 : 0 }],
  }).id);
  reload();
  return id;
}
/** Verkauf ohne Losangabe — das Haus nimmt das älteste Los und dessen Einstand. */
const LINE = (productId: string, qty = 1, price = 1000, scheme: 'VAT_10' | 'MARGIN' = 'VAT_10') => ({
  productId, quantity: qty, unitPrice: price, purchasePrice: 0, taxScheme: scheme, vatRate: 10,
  vatAmount: scheme === 'VAT_10' ? (price * qty) / 10 : 0, lineTotal: scheme === 'VAT_10' ? price * qty * 1.1 : price * qty,
});
function rechnung(lines: Array<ReturnType<typeof LINE>>): string {
  const id = imHaus(() => useInvoiceStore.getState().createDirectInvoice('cust-1', lines as never, 'LVC').id);
  reload();
  return id;
}
function voll(db: Db, invId: string): void {
  const offen = n(db, 'SELECT gross_amount - paid_amount FROM invoices WHERE id = ?', [invId]);
  imHaus(() => useInvoiceStore.getState().recordPayment(invId, offen, 'cash'));
  reload();
}
function retoure(db: Db, invId: string, productId: string): string {
  const lineId = s(db, 'SELECT id FROM invoice_lines WHERE invoice_id = ?', [invId]);
  const id = imHaus(() => {
    const rs = useSalesReturnStore.getState();
    rs.loadReturns();
    const rid = rs.createReturn({
      invoiceId: invId, refundMethod: 'cash', productDisposition: 'IN_STOCK', reason: 'defekt',
      lines: [{ invoiceLineId: lineId, productId, quantity: 1, unitPrice: 1100, vatAmount: 100 }],
    }).id;
    useSalesReturnStore.getState().loadReturns();
    useSalesReturnStore.getState().approveReturn(rid);
    return rid;
  });
  reload();
  return id;
}

let DB: Db | null = null;
const neu = (): Db => { DB = freshDb(); return DB; };

// ── Messgrößen ──
/** Saldo INVENTORY über das ganze Hauptbuch (Storni sind Gegenbuchungen). */
const inventory = (db: Db): number =>
  r3(n(db, "SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0) FROM ledger_entries WHERE account = 'INVENTORY'"));
const lotsValue = (db: Db): number =>
  r3(n(db, "SELECT COALESCE(SUM(qty_remaining * unit_cost), 0) FROM stock_lots WHERE status != 'CANCELLED' AND qty_remaining > 0"));
const lotOf = (db: Db, pid: string): string => s(db, 'SELECT id FROM stock_lots WHERE purchase_id = ?', [pid]);
const unitCost = (db: Db, lot: string): number => n(db, 'SELECT unit_cost FROM stock_lots WHERE id = ?', [lot]);
const lotRem = (db: Db, lot: string): number => n(db, 'SELECT qty_remaining FROM stock_lots WHERE id = ?', [lot]);
const purchaseLeg = (db: Db, pid: string, account: string, dir: string): number =>
  r3(n(db, 'SELECT COALESCE(SUM(amount), 0) FROM ledger_entries WHERE source_module = ? AND source_id = ? AND account = ? AND direction = ?', ['PURCHASE', pid, account, dir]));
const cogsOf = (db: Db, invId: string): number =>
  r3(n(db, "SELECT COALESCE(SUM(amount), 0) FROM ledger_entries WHERE source_module = 'INVOICE' AND source_id = ? AND account = 'COGS' AND direction = 'DEBIT'", [invId]));
const invariant = (db: Db, tag: string): void => {
  const a = inventory(db); const b = lotsValue(db);
  ok(eq(a, b), `${tag} Invariante: INVENTORY ${a} == Restwert der Lose ${b}`);
};

const spot = await import('../../src/core/market/spot-prices.ts');
const purity = await import('../../src/core/gold/purity.ts');
const metalHouse = await import('../../src/core/metals/metal-house.ts');

const USD = 4100;            // Gold, USD pro Feinunze
const USD_AG = 50;           // Silber, USD pro Feinunze
const FINE = USD / 31.1034768 * 0.376;
const FINE_AG = USD_AG / 31.1034768 * 0.376;
const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps;

/** Den Ausdruck vor „BHD/g…" einer Kachel aus dem Quelltext holen und mit dem Beispielkurs auswerten. */
function kachel(source: string, varName: 'spotGold' | 'spotSilver', usd: number): number {
  const m = source.match(new RegExp(`\\{([^{}]*${varName}[^{}]*)\\.toFixed\\(3\\)\\}\\s*<span[^>]*>BHD/g`));
  if (!m) throw new Error(`no ${varName} tile expression`);
  const fn = new Function('bhdPerGramFine', varName, `return ${m[1]};`);
  return Number(fn(spot.bhdPerGramFine, { usdPerOunce: usd }));
}

// ══ 1 — die EINE Live-Umrechnung ═════════════════════════════════════════════════
{
  ok(spot.TROY_OUNCE_GRAMS === 31.1034768 && spot.BHD_PER_USD === 0.376, '1 Konstanten: Feinunze 31.1034768 g, offizielle Bindung 0.376 BHD/USD');
  ok(near(spot.bhdPerGramFine(USD), FINE), `1 bhdPerGramFine(4100) = ${FINE} (ungerundet)`);
  ok(spot.bhdPerGramFine(USD).toFixed(3) === '49.564', `1 …angezeigt 49.564 BHD/g fine (${spot.bhdPerGramFine(USD).toFixed(3)})`);
  ok(String(spot.bhdPerGramFine(USD)).length > 8, '1 …intern nicht auf 3 Stellen gerundet');
  ok(spot.bhdPerGramFine(USD_AG).toFixed(3) === '0.604', `1 Silber 50 USD/oz → 0.604 BHD/g fine (${spot.bhdPerGramFine(USD_AG).toFixed(3)})`);
}

// ══ 2 — Übersicht: Gold- und Silber-Kachel = zentrale Funktion ═════════════════════
{
  const dash = src('src/pages/dashboard/Dashboard.tsx');
  const g = kachel(dash, 'spotGold', USD);
  const s2 = kachel(dash, 'spotSilver', USD_AG);
  ok(near(g, FINE), `2 Übersicht Gold = zentrale Funktion (${g.toFixed(6)} / ${FINE.toFixed(6)}; vorher 49.810, +0.5 %)`);
  ok(near(s2, FINE_AG), `2 Übersicht Silber = zentrale Funktion (${s2.toFixed(6)} / ${FINE_AG.toFixed(6)})`);
  ok(!/1\.417|116\.64/.test(dash), '2 …1.417 / 116.64 ist weg');
}

// ══ 3 — Add Material und Auftrag: dieselbe Zahl, × Gold-Reinheit ══════════════════
{
  const am = src('src/components/work-orders/AddMaterialModal.tsx');
  const oc = src('src/pages/orders/OrderCreate.tsx');
  for (const [name, s0] of [['Add Material', am], ['Auftrag', oc]] as const) {
    ok(/setGoldRate\(bhdPerGramFine\(r\.gold\.usdPerOunce\)\)/.test(s0), `3 ${name}: Live-Kurs über bhdPerGramFine`);
    ok(/Math\.round\(g \* marketValuePerGram\(goldRate, p\) \* 1000\) \/ 1000/.test(s0), `3 ${name}: Wert = Gramm × bhdPerGramFine × Reinheit, gerundet erst auf BHD`);
  }
  // Dieselbe Rechnung wie in beiden Masken, für 10 g je Karat.
  const auto = (karat: string): number => Math.round(10 * spot.marketValuePerGram(spot.bhdPerGramFine(USD), purity.goldPurity(karat)!) * 1000) / 1000;
  const want: Record<string, number> = { '24K': 495.14, '22K': 454.002, '21K': 433.681, '18K': 371.727 };
  for (const k of Object.keys(want)) ok(auto(k) === want[k], `3 10 g ${k} → ${want[k]} BHD (${auto(k)})`);
  ok(spot.marketValuePerGram(spot.bhdPerGramFine(USD), 0.999).toFixed(3) === '49.514', '3 Marktwert/g 24K = 49.514');
  ok(spot.marketValuePerGram(spot.bhdPerGramFine(USD_AG), purity.metalPurity('silver', '999')!).toFixed(3) === '0.604'
    && spot.marketValuePerGram(spot.bhdPerGramFine(USD_AG), purity.metalPurity('silver', '925')!).toFixed(3) === '0.559',
    '3 Silber 999 → 0.604, 925 → 0.559 BHD/g');
}

// ══ 4 — Precious Metals: der Hauspreis bleibt von Hand gesetzt ═════════════════════
{
  const db = neu();
  metalHouse.setSpotPriceInHouse('gold', 50, 'branch-main');
  metalHouse.createMetalInHouse({ metalType: 'gold', karat: '24K', weightGrams: 100 } as never, 'branch-main');
  const melt = (): number => n(db, "SELECT melt_value FROM precious_metals WHERE metal_type = 'gold'");
  const house = (): string => s(db, "SELECT value FROM settings WHERE key = 'spot_price.gold'");
  ok(melt() === 4995 && house() === '50', `4 Anlage mit Hauspreis 50: Schmelzwert 4,995 (${melt()})`);
  // Der Live-Kurs ändert sich — Hauspreis und gespeicherter Schmelzwert bleiben.
  const realFetch = globalThis.fetch;
  (globalThis as { fetch?: unknown }).fetch = async (url: string) => ({
    ok: true, json: async () => ({ price: String(url).includes('XAU') ? 5000 : 60, updatedAt: NOW }),
  });
  const live = await spot.getSpotPrices(true);
  (globalThis as { fetch?: unknown }).fetch = realFetch;
  ok(live.gold?.usdPerOunce === 5000 && near(live.gold.bhdPerGram, spot.bhdPerGramFine(5000)), '4 Live-Kurs neu geladen (5000 USD/oz), bhdPerGram aus derselben Funktion');
  ok(house() === '50' && melt() === 4995, `4 …Hauspreis 50 und Schmelzwert 4,995 unverändert (${house()}/${melt()})`);
  // Ein neuer Hauspreis ändert gespeicherte Schmelzwerte nicht rückwirkend.
  metalHouse.setSpotPriceInHouse('gold', 60, 'branch-main');
  ok(house() === '60' && melt() === 4995, '4 neuer Hauspreis 60: der gespeicherte Schmelzwert bleibt 4,995');
  const ml = src('src/pages/metals/MetalList.tsx');
  ok(/BHD per g fine · house price/.test(ml), '4 Maske: Hauspreis beschriftet als „BHD per g fine · house price"');
  ok(/Live reference: \$\{live\[type\]!\.toFixed\(3\)\} BHD\/g fine/.test(ml) && /bhdPerGramFine\(r\.gold\.usdPerOunce\)/.test(ml),
    '4 …daneben „Live reference: X.XXX BHD/g fine" aus derselben Funktion');
  ok(!/setSpotPrice[A-Za-z]*\([^)]*live/.test(ml), '4 …der Live-Wert wird nirgends als Hauspreis gespeichert');
  ok(/Melt value \(at the house price\)/.test(ml), '4 Schmelzwert-Vorschau nennt den Hauspreis');
}

// ══ 5 — keine zweite Live-Formel im Code ═══════════════════════════════════════════
{
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(f)) out.push(p); }
    return out;
  };
  const hits = walk(resolvePath(repo, 'src')).filter((p) => !/market[\\/]spot-prices\.ts$/.test(p))
    .filter((p) => /usdPerOunce\s*[*/]|31\.103|0\.376\b|1\.417|116\.64|\.bhdPerGram\b/.test(readFileSync(p, 'utf8')));
  ok(hits.length === 0, `5 außerhalb von spot-prices.ts rechnet niemand selbst um (${S(hits.map((p) => p.slice(repo.length + 1)))})`);
}

console.log(`\nmetal-spot-ssot: ${PASS} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
