// ════════════════════════════════════════════════════════════════════════════
// MIXED-INVOICE P2 — E10 Steuerartwahl beim Verkauf (Owner-Entscheidungen D1–D5 vom 03.11.2026).
// Run: node test/p2/e10-tax-choice.test.ts
//
//   §A D3 eine Regel für eine fehlende Artikel-Steuerart (MARGIN, wie Spalten-Default, Lader und Record Sale)
//   §B D3 Parität: Artikel ohne Steuerart — Maske am Primary und PC2-Befehl („Auto") buchen dieselbe Zeile
//   §C D5 Eigenware aus einem VAT-10-%-Einkauf: VAT 10 % / Zero-rated / Margin wählbar (Primary = PC2), die
//      Margenformel unverändert, der Einkauf unverändert; reiner Steuerartwechsel hält das Kundenbrutto
//   §D D2/D3/D4/D5 Kommission mit Einlieferer-VAT 10 %: alle drei wählbar — Primary, PC2 (gemeinsamer Rumpf)
//      und Telefon (Einzelrumpf aus `saleBody`) buchen gleich; die Einkaufs-VAT ist Pflicht — ein Rumpf ohne sie
//      (alte Handy-Seite) bucht nichts und bekommt CONSIGNOR_VAT_REQUIRED
//   §E D2 Altbestand: Einkauf ohne Steueraufzeichnung gilt als No VAT, wird aber nicht überschrieben;
//      bestehende Rechnung behält ihre Steuer (keine Umklassifizierung)
//   §F Telefon: Rumpf, Prüfung, Maske (Quelltext); D1 keine Hinweise/Bestätigung
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    if (specifier === '@tauri-apps/api/core') return { url: pathToFileURL(resolvePath(repo, 'test/bridge/_tauri-shim.ts')).href, shortCircuit: true };
    if (specifier === '@/core/db/database' || specifier === '../db/database.ts') return { url: pathToFileURL(resolvePath(repo, 'test/sync/_db-shim.ts')).href, shortCircuit: true };
    if ((specifier === './database' || specifier === '../db/database') && context.parentURL) return { url: pathToFileURL(resolvePath(repo, 'test/sync/_db-shim.ts')).href, shortCircuit: true };
    if (specifier === '../auth/auth' && context.parentURL && context.parentURL.includes('/db/helpers')) return { url: pathToFileURL(resolvePath(repo, 'test/sync/_auth-shim.ts')).href, shortCircuit: true };
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
  ['lataif_sync_url', 'http://127.0.0.1:9/sync'], ['lataif_sync_token', 'test-token'],
]);
const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, String(v)); }, removeItem: (k: string) => { store.delete(k); } };
(globalThis as { localStorage?: unknown }).localStorage = storage;
(globalThis as { window?: unknown }).window = { localStorage: storage };

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
await import('../../src/core/bridge/read-commands.ts');
const cmd = await import('../../src/core/bridge/commercial-commands.ts');
const life = await import('../../src/core/bridge/lifecycle-commands.ts');
const { runInvoiceCreate, buildInvoiceLines } = await import('../../src/core/bridge/invoice-command.ts');
const { createInvoiceInHouse } = await import('../../src/core/invoices/invoice-create-house.ts');
const { resolveLineScheme, toInvoiceLine } = await import('../../src/core/invoices/line-derivation.ts');
const finance = await import('../../src/core/consignment/consignment-finance.ts');
const conHouse = await import('../../src/core/consignment/consignment-finance-house.ts');
const { purchaseEditCheck } = await import('../../src/core/purchases/purchase-edit-house.ts');
const { useInvoiceStore } = await import('../../src/stores/invoiceStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { useCustomerStore } = await import('../../src/stores/customerStore.ts');
const { useConsignmentStore } = await import('../../src/stores/consignmentStore.ts');
const { usePurchaseStore } = await import('../../src/stores/purchaseStore.ts');
const { useSupplierStore } = await import('../../src/stores/supplierStore.ts');
const { useAuthStore } = await import('../../src/stores/authStore.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const S = (v: unknown): string => JSON.stringify(v);
const NOW = '2026-11-03T10:00:00.000Z';

interface Db { run(sql: string, p?: unknown[]): unknown; exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }> }
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const n = (db: Db, sql: string, p: unknown[] = []): number => Math.round(Number(one(db, sql, p) ?? 0) * 1000) / 1000;
const s = (db: Db, sql: string, p: unknown[] = []): string => String(one(db, sql, p) ?? '');
const all = (db: Db, sql: string, p: unknown[] = []): string => S(db.exec(sql, p)[0]?.values ?? []);

function realMigrations(): string[] {
  const dbSrc = src('src/core/db/database.ts');
  const a = dbSrc.indexOf('const migrations: string[] = ['); const b = dbSrc.indexOf('\n  ];', a);
  return [...dbSrc.slice(a, b).matchAll(/`([^`]*)`/g)].map((m) => m[1]);
}
const MIGRATIONS = realMigrations();
function insert(db: Db, table: string, values: Record<string, unknown>): void {
  const cols = db.exec(`PRAGMA table_info(${table})`)[0].values.map((v) => ({ name: String(v[1]), type: String(v[2] ?? ''), notnull: Number(v[3]) === 1, dflt: v[4], pk: Number(v[5]) > 0 }));
  const data: Record<string, unknown> = { ...values };
  for (const c of cols) { if (!c.notnull || c.dflt !== null || c.pk || data[c.name] !== undefined) continue; data[c.name] = /INT|REAL|NUM/i.test(c.type) ? 0 : (/_at$|date/i.test(c.name) ? NOW : ''); }
  const names = Object.keys(data).filter((k) => cols.some((c) => c.name === k));
  db.run(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`, names.map((k) => data[k]));
}
function reload(): void {
  useProductStore.getState().loadProducts(); useCustomerStore.getState().loadCustomers(); useInvoiceStore.getState().loadInvoices();
  useConsignmentStore.getState().loadConsignments(); usePurchaseStore.getState().loadPurchases(); useSupplierStore.getState().loadSuppliers();
}
function freshDb(): Db {
  resetDurabilityStateForTest(); resetTransactionHealthForTest();
  const db = new SQL.Database() as unknown as Db;
  db.run(src('src/core/db/schema.sql'));
  for (const st of MIGRATIONS) { try { db.run(st); } catch { /* da */ } }
  for (const st of A1_UPGRADE_SQL) { try { db.run(st); } catch { /* da */ } }
  db.run(COMMAND_LEDGER_DDL); db.run(COMMAND_LEDGER_INDEX); db.run(SKU_SEQUENCES_DDL);
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-main','tenant-1','Haupt',?,?)", [NOW, NOW]);
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES ('cat-w','branch-main','Watch','w','#000',?,?)", [NOW, NOW]);
  for (const [id, first] of [['cust-1', 'Ali'], ['cust-2', 'Nora']]) {
    db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level, preferences, customer_type, sales_stage, created_at, updated_at)
      VALUES (?,'branch-main',?,'Hassan','BH','en',0,'[]','collector','active',?,?)`, [id, first, NOW, NOW]);
  }
  insert(db, 'suppliers', { id: 'sup-1', branch_id: 'branch-main', name: 'Händler', created_at: NOW, updated_at: NOW });
  applyMediaSchema(db as never); setTestDatabase(db as never); installWriteGuard(db as never); reload(); tauriState.reset();
  return db;
}
/** Ein Artikel; `scheme === null` = ohne Steuerart (Datenlücke). */
function artikel(db: Db, id: string, scheme: string | null, cost = 0): void {
  db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition, scope_of_delivery, purchase_price, purchase_currency,
      planned_sale_price, stock_status, tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
    VALUES (?,'branch-main','cat-w','Rolex',?,?,0,'Pre-Owned','[]',?,'BHD',1500,'in_stock',?,0,'[]','{}','OWN',?,?)`, [id, 'M ' + id, 'SKU-' + id, cost, scheme, NOW, NOW]);
}
useAuthStore.setState({ session: { userId: 'user-test', branchId: 'branch-main', role: 'ADMIN' } as never });
function imHaus<T>(fn: () => T): T { posting.beginLedgerTransaction(); try { const o = fn(); posting.commitLedgerTransaction(); return o; } catch (e) { posting.rollbackLedgerTransaction(); throw e; } }
const meldung = (fn: () => unknown): string => { try { fn(); return ''; } catch (e) { return String((e as { code?: unknown }).code ?? '') + '|' + (e as Error).message; } };
/** Einkauf beim Händler (Menge, Stückpreis brutto, mit/ohne VAT 10 %). */
function einkauf(db: Db, pid: string, menge: number, preis: number, vat10: boolean): string {
  const id = imHaus(() => usePurchaseStore.getState().createPurchase({
    supplierId: 'sup-1', lines: [{ productId: pid, quantity: menge, unitPrice: preis, taxScheme: vat10 ? 'VAT_10' as const : 'ZERO' as const, vatRate: vat10 ? 10 : 0 }],
  }).id);
  reload(); return id;
}
const losVon = (db: Db, pid: string): string => s(db, "SELECT id FROM stock_lots WHERE product_id = ? AND qty_remaining > 0 ORDER BY acquired_at, id LIMIT 1", [pid]);

const deps = (db: Db) => ({ db: db as never, begin: posting.beginLedgerTransaction, commit: posting.commitLedgerTransaction, rollback: posting.rollbackLedgerTransaction,
  durableSave: async () => { /* test */ }, now: () => NOW });
let seq = 0;
const ident = (op: string) => ({ commandId: `00000p${String(++seq).padStart(2, '0')}-0000-4000-8000-000000000000`, tenantId: 'tenant-1', branchId: 'branch-main',
  userId: 'user-pc2', role: 'ADMIN', op, payloadKind: 'x', payloadHash: `h${seq}` });
async function fern(p: () => Promise<unknown>): Promise<{ ok: boolean; code: string; value: Record<string, unknown> }> {
  try {
    const o = await p() as { kind: string; code?: string; value?: Record<string, unknown> };
    return o.kind === 'ok' ? { ok: true, code: '', value: o.value ?? {} } : { ok: false, code: o.code ?? '?', value: {} };
  } catch (e) { return { ok: false, code: String((e as { code?: unknown }).code ?? 'THROWN:' + String(e)), value: {} }; }
}

/** Die Zeile genau so, wie die Maske am Primary sie baut: „Auto" = Steuerart des Artikels aus dem Lader, Einstand des Loses. */
function maskenZeile(db: Db, pid: string, scheme: 'auto' | 'VAT_10' | 'ZERO' | 'MARGIN', net: number) {
  const p = useProductStore.getState().products.find((x) => x.id === pid)!;
  const lot = losVon(db, pid);
  const resolved = (scheme === 'auto' ? p.taxScheme : scheme) as 'VAT_10' | 'ZERO' | 'MARGIN';
  return toInvoiceLine({ productId: pid, lotId: lot, quantity: 1, unitPrice: net, costBasis: n(db, 'SELECT unit_cost FROM stock_lots WHERE id = ?', [lot]), scheme: resolved });
}
function amPrimary(db: Db, pid: string, scheme: 'auto' | 'VAT_10' | 'ZERO' | 'MARGIN', net: number): string {
  const r = imHaus(() => createInvoiceInHouse({ customerId: 'cust-2', lines: [maskenZeile(db, pid, scheme, net)] as never, specialMark: false }, 'branch-main'));
  reload(); return r.invoiceId;
}
async function vonPc2(db: Db, pid: string, scheme: 'auto' | 'VAT_10' | 'ZERO' | 'MARGIN', net: number): Promise<{ ok: boolean; code: string; inv: string }> {
  const r = await fern(() => runInvoiceCreate(deps(db), ident('invoices.create') as never,
    { customerId: 'cust-2', lines: [{ productId: pid, lotId: losVon(db, pid), quantity: 1, unitPrice: net, scheme }] }));
  reload(); return { ok: r.ok, code: r.code, inv: String(r.value.invoiceId ?? '') };
}
/** Was eine Rechnungszeile steuerlich ausmacht (ohne Kennungen). */
const zeileSig = (db: Db, inv: string): string => all(db,
  'SELECT tax_scheme, ROUND(unit_price,3), ROUND(vat_amount,3), ROUND(line_total,3), ROUND(purchase_price_snapshot,3), vat_rate FROM invoice_lines WHERE invoice_id = ? ORDER BY position', [inv]);

// ── §A D3 eine Regel für eine fehlende Artikel-Steuerart ─────────────────────────────────────
{
  ok(resolveLineScheme('auto', undefined) === 'MARGIN' && resolveLineScheme(undefined, '') === 'MARGIN'
    && resolveLineScheme('auto', null as never) === 'MARGIN' && resolveLineScheme('auto', 'kaputt') === 'MARGIN',
    '§A Artikel ohne (gültige) Steuerart + „Auto" ⇒ MARGIN (vorher VAT 10 % nur auf diesem Weg)');
  ok(resolveLineScheme('auto', 'VAT_10') === 'VAT_10' && resolveLineScheme('auto', 'ZERO') === 'ZERO' && resolveLineScheme(undefined, 'MARGIN') === 'MARGIN',
    '§A „Auto" folgt weiter der Steuerart des Artikels');
  ok(resolveLineScheme('ZERO', 'VAT_10') === 'ZERO' && resolveLineScheme('MARGIN', 'VAT_10') === 'MARGIN' && resolveLineScheme('VAT_10', 'MARGIN') === 'VAT_10',
    '§A eine ausdrückliche Wahl gilt immer (D3)');
  const lader = src('src/stores/productStore.ts');
  ok(/taxScheme: \(row\.tax_scheme as Product\['taxScheme'\]\) \|\| 'MARGIN'/.test(lader)
    && /\(taxScheme \|\| \(prod\?\.tax_scheme as TaxScheme \| undefined\) \|\| 'MARGIN'\)/.test(src('src/stores/consignmentStore.ts'))
    && /tax_scheme\s+TEXT DEFAULT 'MARGIN'/.test(src('src/core/db/schema.sql')),
    '§A dieselbe Regel steht im Artikel-Lader (Maske Primary/PC2), in „Record Sale" und im Spalten-Default');
}

// ── §B D3 Parität: Artikel ohne Steuerart ─────────────────────────────────────────────────────
{
  const db = freshDb();
  artikel(db, 'leer-a', null); artikel(db, 'leer-b', null);
  einkauf(db, 'leer-a', 1, 500, false); einkauf(db, 'leer-b', 1, 500, false);
  ok(s(db, "SELECT COALESCE(tax_scheme,'<null>') FROM products WHERE id = 'leer-a'") === '<null>'
    && useProductStore.getState().products.find((p) => p.id === 'leer-a')?.taxScheme === 'MARGIN',
    '§B Datenlücke: Artikel ohne Steuerart, der Lader der Maske zeigt „Auto (MARGIN)"');
  const built = buildInvoiceLines([{ productId: 'leer-a', lotId: losVon(db, 'leer-a'), quantity: 1, unitPrice: 800, scheme: 'auto' }] as never);
  ok(built[0]?.taxScheme === 'MARGIN', `§B PC2-Befehl (anlegen UND ändern teilen buildInvoiceLines): „Auto" ⇒ MARGIN (${built[0]?.taxScheme})`);
  const p = amPrimary(db, 'leer-a', 'auto', 800);
  const r = await vonPc2(db, 'leer-b', 'auto', 800);
  ok(r.ok && zeileSig(db, p) === zeileSig(db, r.inv) && /"MARGIN",800,27\.273,800,500,10/.test(zeileSig(db, p)),
    `§B Maske am Primary und PC2 buchen dieselbe Zeile (MARGIN, Kundenpreis 800) — ${zeileSig(db, p)} vs ${zeileSig(db, r.inv)}`);
  ok(n(db, 'SELECT gross_amount FROM invoices WHERE id = ?', [p]) === n(db, 'SELECT gross_amount FROM invoices WHERE id = ?', [r.inv]),
    '§B …gleiches Rechnungsbrutto (vorher: PC2 880 statt 800)');
  ok(s(db, "SELECT COALESCE(tax_scheme,'<null>') FROM products WHERE id IN ('leer-a','leer-b') GROUP BY tax_scheme") === '<null>',
    '§B die fehlende Artikel-Steuerart wird beim Verkauf nicht nachgetragen');
}

// ── §C D5 Eigenware aus einem VAT-10-%-Einkauf ─────────────────────────────────────────────────
{
  const db = freshDb();
  artikel(db, 'rolex', 'VAT_10', 1100);
  const kauf = einkauf(db, 'rolex', 6, 1100, true);
  const einkaufVorher = all(db, 'SELECT tax_scheme, ROUND(vat_amount,3), ROUND(line_total,3) FROM purchase_lines WHERE purchase_id = ?', [kauf]);
  ok(n(db, "SELECT unit_cost FROM stock_lots WHERE product_id = 'rolex'") === 1000, '§C Einkauf 1.100 inkl. 10 % VAT ⇒ Los-Einstand 1.000 (netto)');
  const erwartet: Record<string, string> = {
    VAT_10: '[["VAT_10",1500,150,1650,1000,10]]',
    ZERO: '[["ZERO",1500,0,1500,1000,0]]',
    MARGIN: '[["MARGIN",1500,45.455,1500,1000,10]]',
  };
  const invs: Record<string, { p: string; f: string }> = {};
  for (const sch of ['VAT_10', 'ZERO', 'MARGIN'] as const) {
    const p = amPrimary(db, 'rolex', sch, 1500);
    const r = await vonPc2(db, 'rolex', sch, 1500);
    invs[sch] = { p, f: r.inv };
    ok(r.ok && zeileSig(db, p) === erwartet[sch] && zeileSig(db, r.inv) === erwartet[sch],
      `§C ${sch} auf VAT-10-%-Los: Primary und PC2 nehmen an, gleiche Zeile ${erwartet[sch]} (${zeileSig(db, p)} / ${zeileSig(db, r.inv)} ${r.code})`);
  }
  ok(/\[\["MARGIN",1500,45\.455/.test(zeileSig(db, invs.MARGIN.p)),
    '§C Margin: die bestehende Formel — VAT auf (1.500 − Netto-Einstand 1.000) × 10/110 = 45,455, unverändert (lot-vat-cost §8)');
  ok(all(db, 'SELECT tax_scheme, ROUND(vat_amount,3), ROUND(line_total,3) FROM purchase_lines WHERE purchase_id = ?', [kauf]) === einkaufVorher,
    '§C der Einkauf (VAT 10 %, Vorsteuer) bleibt, wie er war — Einkaufs- und Verkaufs-VAT getrennt');
  // Reiner Steuerartwechsel an der PC2-Rechnung (VAT 10 % → Margin → Zero-rated): das Kundenbrutto 1.650 bleibt.
  const inv = invs.VAT_10.f;
  const lid = s(db, 'SELECT id FROM invoice_lines WHERE invoice_id = ?', [inv]);
  const lot = s(db, 'SELECT lot_id FROM invoice_lines WHERE id = ?', [lid]);
  for (const sch of ['MARGIN', 'ZERO'] as const) {
    // Die Maske schickt das gespeicherte Netto unverändert mit — nur die Steuerart wechselt.
    const netto = n(db, 'SELECT unit_price FROM invoice_lines WHERE id = ?', [lid]);
    const m = meldung(() => imHaus(() => useInvoiceStore.getState().editInvoice(inv, {
      reason: 'P2 Steuerart', lines: [{ lineId: lid, productId: 'rolex', lotId: lot, quantity: 1, unitPrice: netto, purchasePrice: 1000,
        taxScheme: sch, vatRate: sch === 'ZERO' ? 0 : 10, vatAmount: 0, lineTotal: 1500 }],
    } as never)));
    reload();
    ok(m === '' && n(db, 'SELECT gross_amount FROM invoices WHERE id = ?', [inv]) === 1650 && s(db, 'SELECT tax_scheme FROM invoice_lines WHERE id = ?', [lid]) === sch,
      `§C Ändern VAT 10 % → ${sch} auf VAT-10-%-Los: angenommen, Kundenbrutto bleibt 1.650 (${m || n(db, 'SELECT gross_amount FROM invoices WHERE id = ?', [inv])})`);
  }
}

// ── §D Kommission mit Einlieferer-VAT 10 %: Primary = PC2 = Telefon ─────────────────────────────
const sandbox: Record<string, unknown> = {};
new Function('self', src('src-tauri/src/sync/mobile_repair_commands.js'))(sandbox);
new Function('self', src('src-tauri/src/sync/mobile_consignment_commands.js'))(sandbox);
const M = sandbox.MobileConsignment as {
  TAX_SCHEMES: string[]; CONSIGNOR_VAT: string[];
  saleBody(con: Record<string, unknown>, form: Record<string, unknown>, opts?: { acknowledgeShortfall?: boolean }): { ok: boolean; code?: string; body?: Record<string, unknown> };
};
async function kommission(db: Db, name: string): Promise<string> {
  const c = await fern(() => cmd.runConsignmentCreate(deps(db), ident('consignments.create') as never, {
    consignorId: 'cust-1', product: { brand: 'Patek', name, categoryId: 'cat-w' }, agreedPrice: 1000, payout: { model: 'percent', commissionRate: 20 },
  }));
  if (!c.ok) throw new Error('setup consignment: ' + c.code);
  reload();
  return String(c.value.consignmentId ?? '');
}
const conRev = (db: Db, id: string): number => n(db, 'SELECT revision FROM consignments WHERE id = ?', [id]);
const conInv = (db: Db, id: string): string => s(db, 'SELECT invoice_id FROM consignments WHERE id = ?', [id]);
const einkaufSig = (db: Db, id: string): string => all(db,
  `SELECT pl.tax_scheme, ROUND(pl.vat_amount,3), ROUND(pl.line_total,3) FROM purchase_lines pl JOIN consignments c ON c.product_id = pl.product_id WHERE c.id = ?`, [id]);
{
  // Bestehende Kommissionsformel (G4 bewusst unverändert): Margen-VAT auf Verkauf − Einkaufspreis des Artikels
  // (`products.purchase_price`, sonst Auszahlung) × 10/110 — der Artikel trägt beim Anlegen den Vorschlag 800.
  const margeVat = (pp: number): number => Math.round((1200 - pp) * 10 / 110 * 1000) / 1000;
  for (const sch of ['VAT_10', 'ZERO', 'MARGIN'] as const) {
    const db = freshDb();
    const a = await kommission(db, 'Nautilus A'); const b = await kommission(db, 'Nautilus B'); const c = await kommission(db, 'Nautilus C');
    const pp = n(db, 'SELECT purchase_price FROM products WHERE id = (SELECT product_id FROM consignments WHERE id = ?)', [a]);
    const erwartet: Record<string, string> = {
      VAT_10: '"VAT_10",1090.909,109.091,1200',
      ZERO: '"ZERO",1200,0,1200',
      MARGIN: `"MARGIN",1200,${margeVat(pp || 960)},1200`,
    };
    // Primary (Verkaufsdialog am Primary)
    setTestDatabase(db as never); reload();
    await conHouse.recordConsignmentSalesOnPrimary({ items: [{ consignmentId: a, salePrice: 1200, acknowledgeShortfall: false, taxScheme: sch, consignorTaxScheme: 'VAT_10' }],
      buyerId: 'cust-2', specialMark: false });
    reload();
    // PC2 (Verkaufsdialog am zweiten Rechner, gemeinsamer Rumpf)
    const rb = await fern(() => life.runRecordSale(deps(db), ident('consignments.record_sale') as never, finance.consignmentSalesBody(
      { items: [{ consignmentId: b, salePrice: 1200, acknowledgeShortfall: false, taxScheme: sch, consignorTaxScheme: 'VAT_10' }], buyerId: 'cust-2', specialMark: false },
      { [b]: conRev(db, b) })));
    reload();
    // Telefon (Einzelrumpf aus der echten Handy-Datei)
    const mobil = M.saleBody({ id: c, consignorId: 'cust-1', revision: conRev(db, c) },
      { buyerId: 'cust-2', salePrice: '1200', specialMark: false, taxScheme: sch, consignorTaxScheme: 'VAT_10' });
    const rc = mobil.ok ? await fern(() => life.runRecordSale(deps(db), ident('consignments.record_sale') as never, mobil.body)) : { ok: false, code: mobil.code ?? '', value: {} };
    reload();
    const sigs = [a, b, c].map((k) => zeileSig(db, conInv(db, k)));
    ok(rb.ok && rc.ok && sigs.every((x) => x.includes(erwartet[sch])),
      `§D ${sch} bei Einlieferer-VAT 10 %: Primary, PC2 und Telefon buchen ${erwartet[sch]} (${sigs.join(' | ')} ${rb.code}${rc.code})`);
    const eks = [a, b, c].map((k) => einkaufSig(db, k));
    ok(eks.every((x) => x === '[["VAT_10",87.273,960]]'),
      `§D …der Einkauf beim Einlieferer bleibt VAT 10 % (Vorsteuer 87,273 aus 960), unabhängig von der Rechnung (${eks.join(' | ')})`);
  }
  // D2 — die Einkaufs-VAT ist Pflicht: ein alter Telefon-Rumpf (ohne die Wahl) und ein gemeinsamer Rumpf ohne sie
  // buchen NICHTS und bekommen ein klares Nein; mit ausdrücklich „ohne VAT" (Artikel ohne Steuerart) wie bisher.
  const db = freshDb();
  const k = await kommission(db, 'Aquanaut');
  const ppAlt = n(db, 'SELECT purchase_price FROM products WHERE id = (SELECT product_id FROM consignments WHERE id = ?)', [k]);
  db.run('UPDATE products SET tax_scheme = NULL WHERE id = (SELECT product_id FROM consignments WHERE id = ?)', [k]);
  reload();
  ok(M.saleBody({ id: k, consignorId: 'cust-1', revision: conRev(db, k) }, { buyerId: 'cust-2', salePrice: '1200', specialMark: false }).code === 'CONSIGNOR_VAT_REQUIRED',
    '§D Telefon: ohne gewählte Einkaufs-VAT baut die Seite keinen Rumpf');
  const vorher = [n(db, 'SELECT COUNT(*) FROM invoices'), n(db, 'SELECT COUNT(*) FROM purchases'), n(db, 'SELECT COUNT(*) FROM ledger_entries')].join('/');
  const altRumpf = { consignmentId: k, expectedRevision: conRev(db, k), buyerId: 'cust-2', salePrice: 1200, specialMark: false };
  const ralt = await fern(() => life.runRecordSale(deps(db), ident('consignments.record_sale') as never, altRumpf));
  const rgem = await fern(() => life.runRecordSale(deps(db), ident('consignments.record_sale') as never, finance.consignmentSalesBody(
    { items: [{ consignmentId: k, salePrice: 1200, acknowledgeShortfall: false }], buyerId: 'cust-2', specialMark: false }, { [k]: conRev(db, k) })));
  reload();
  ok(!ralt.ok && ralt.code === 'CONSIGNOR_VAT_REQUIRED' && !rgem.ok && rgem.code === 'CONSIGNOR_VAT_REQUIRED'
    && [n(db, 'SELECT COUNT(*) FROM invoices'), n(db, 'SELECT COUNT(*) FROM purchases'), n(db, 'SELECT COUNT(*) FROM ledger_entries')].join('/') === vorher
    && s(db, 'SELECT status FROM consignments WHERE id = ?', [k]) === 'active',
    `§D alter Handy-Rumpf / Rumpf ohne Einkaufs-VAT: klares Nein (${ralt.code}/${rgem.code}), nichts gebucht, Kommission aktiv — keine stille No-VAT-Einstufung`);
  const neu = M.saleBody({ id: k, consignorId: 'cust-1', revision: conRev(db, k) }, { buyerId: 'cust-2', salePrice: '1200', specialMark: false, consignorTaxScheme: 'ZERO' });
  const ra = await fern(() => life.runRecordSale(deps(db), ident('consignments.record_sale') as never, neu.body));
  reload();
  ok(ra.ok && zeileSig(db, conInv(db, k)).includes(`"MARGIN",1200,${Math.round((1200 - (ppAlt || 960)) * 10 / 110 * 1000) / 1000},1200`) && einkaufSig(db, k) === '[["ZERO",0,960]]',
    `§D ausdrücklich „ohne VAT", Artikel ohne Steuerart ⇒ MARGIN, Einkauf ohne VAT (${zeileSig(db, conInv(db, k))} ${einkaufSig(db, k)} ${ra.code})`);
  ok(/ZERO\|.*consignorTaxScheme must be ZERO or VAT_10|consignorTaxScheme must be ZERO or VAT_10/.test(meldung(() => life.parseRecordSale({ consignmentId: 'c', buyerId: 'b', salePrice: 1, expectedRevision: 1, consignorTaxScheme: 'MARGIN' })))
    && /taxScheme must be MARGIN, VAT_10 or ZERO/.test(meldung(() => life.parseRecordSale({ consignmentId: 'c', buyerId: 'b', salePrice: 1, expectedRevision: 1, taxScheme: 'STANDARD' }))),
    '§D Einzelrumpf prüft wie der gemeinsame: Rechnung VAT 10 %/Zero/Margin, Einkauf ohne VAT/VAT 10 %');
  const parsed = life.parseRecordSale({ consignmentId: 'c', buyerId: 'b', salePrice: 1, expectedRevision: 1, taxScheme: 'ZERO', consignorTaxScheme: 'VAT_10' });
  ok(parsed.taxScheme === 'ZERO' && parsed.consignorTaxScheme === 'VAT_10', '§D …und trägt beide Werte ins Haus');
}

// ── §E D2 Altbestand: keine Steueraufzeichnung = No VAT, nichts überschrieben, nichts umklassifiziert ──────
{
  const db = freshDb();
  artikel(db, 'alt', null, 400);
  insert(db, 'purchases', { id: 'pur-alt', branch_id: 'branch-main', purchase_number: 'PUR-ALT-1', supplier_id: 'sup-1', status: 'RECEIVED',
    total_amount: 400, paid_amount: 0, purchase_date: '2026-10-20', created_at: NOW, updated_at: NOW });
  insert(db, 'purchase_lines', { id: 'pl-alt', purchase_id: 'pur-alt', product_id: 'alt', quantity: 1, unit_price: 400, line_total: 400,
    tax_scheme: null, vat_rate: null, vat_amount: 0, position: 1 });
  insert(db, 'stock_lots', { id: 'lot-alt', branch_id: 'branch-main', product_id: 'alt', purchase_id: 'pur-alt', purchase_line_id: 'pl-alt',
    unit_cost: 400, qty_total: 1, qty_remaining: 1, status: 'ACTIVE', acquired_at: NOW, created_at: NOW });
  reload();
  let sicht = ''; const fehler = meldung(() => { sicht = String(purchaseEditCheck('pur-alt', 'branch-main', NOW).lines?.[0]?.taxScheme ?? ''); });
  ok(fehler === '' && sicht === 'ZERO', `§E alter Einkauf ohne Steueraufzeichnung (keine VAT angefallen) gilt als No VAT (${sicht}${fehler})`);
  const r = await vonPc2(db, 'alt', 'MARGIN', 700);
  ok(r.ok && s(db, "SELECT COALESCE(tax_scheme,'<null>') FROM purchase_lines WHERE id = 'pl-alt'") === '<null>',
    `§E Verkauf daraus (Margin) — die fehlende Steueraufzeichnung des Einkaufs bleibt leer, nicht blind „No VAT" (${r.code})`);
  // Bestehende Rechnung: eine reine Notiz-Änderung lässt die Steuer der Zeile stehen.
  const vorher = zeileSig(db, r.inv); const buchungen = n(db, 'SELECT COUNT(*) FROM ledger_entries');
  const lid = s(db, 'SELECT id FROM invoice_lines WHERE invoice_id = ?', [r.inv]);
  const m = meldung(() => imHaus(() => useInvoiceStore.getState().editInvoice(r.inv, {
    reason: 'P2 Notiz', notes: 'nur eine Notiz', lines: [{ lineId: lid, productId: 'alt', lotId: 'lot-alt', quantity: 1, unitPrice: 700, purchasePrice: 400,
      taxScheme: 'MARGIN', vatRate: 10, vatAmount: n(db, 'SELECT vat_amount FROM invoice_lines WHERE id = ?', [lid]), lineTotal: 700 }],
  } as never)));
  reload();
  ok(m === '' && zeileSig(db, r.inv) === vorher && n(db, 'SELECT COUNT(*) FROM ledger_entries') === buchungen,
    `§E Notiz an bestehender Margin-Rechnung: Zeile unverändert, keine Buchung — keine Umklassifizierung (${m})`);
  // Die einzigen Steuer-Migrationen sind die alten Schreibweisen (standard/margin/exempt → VAT_10/MARGIN/ZERO).
  const steuerMig = MIGRATIONS.filter((m) => /UPDATE\s+(invoice_lines|purchase_lines|invoices|products)\b[^`;]*tax_scheme/i.test(m));
  ok(steuerMig.length > 0 && steuerMig.every((m) => /WHERE tax_scheme(_snapshot)? = '(standard|margin|exempt)'$/.test(m.trim()))
    && !/UPDATE\s+purchase_lines\s+SET[^`;]*tax_scheme/i.test(src('src/core/purchases/purchase-edit-house.ts')),
    `§E keine Startmigration und kein Einkaufs-Edit schreibt historische Steuerarten um (nur Schreibweisen: ${steuerMig.length})`);
}

// ── §F Telefon und Masken ───────────────────────────────────────────────────────────────────────
{
  const con = { id: 'con-1', consignorId: 'cust-1', revision: 3 };
  const voll = M.saleBody(con, { buyerId: 'cust-9', salePrice: '650', taxScheme: 'ZERO', consignorTaxScheme: 'VAT_10' });
  ok(voll.ok && voll.body?.taxScheme === 'ZERO' && voll.body?.consignorTaxScheme === 'VAT_10', `§F Telefon: Rumpf trägt Steuerart und Einkaufs-VAT (${S(voll.body)})`);
  ok(M.saleBody(con, { buyerId: 'cust-9', salePrice: '650', taxScheme: 'STANDARD' }).code === 'TAX_SCHEME_INVALID'
    && M.saleBody(con, { buyerId: 'cust-9', salePrice: '650', consignorTaxScheme: 'MARGIN' }).code === 'CONSIGNOR_VAT_INVALID',
    '§F Telefon: unbekannte Werte gehen nicht hinaus');
  ok(S(M.TAX_SCHEMES.slice().sort()) === S(['MARGIN', 'VAT_10', 'ZERO']) && S(M.CONSIGNOR_VAT) === S(['ZERO', 'VAT_10']),
    '§F Telefon: dieselben Vokabeln wie das Haus (3 Steuerarten, Einkauf ohne VAT / VAT 10 %)');
  const html = src('src-tauri/src/sync/mobile_consignment.html'); const ui = src('src-tauri/src/sync/mobile_consignment_ui.js');
  ok(/<select id="cnSaleTaxScheme"><\/select>/.test(html) && /<select id="cnSaleConsignorVat"><\/select>/.test(html)
    && /taxScheme: \$\('cnSaleTaxScheme'\)\.value, consignorTaxScheme: \$\('cnSaleConsignorVat'\)\.value/.test(ui),
    '§F Handy-Maske: zwei Auswahlen im Verkauf, beide reisen mit „Record sale"');
  ok(/indexOf\(art\) >= 0 \? art : 'MARGIN'/.test(ui) && /\$\('cnSaleConsignorVat'\)\.value = '';/.test(ui) && /Consignor purchase: choose the VAT/.test(ui),
    '§F Handy wie am Rechner: Steuerart des Artikels vorgewählt (ohne = Margin), Einkaufs-VAT NICHT vorbelegt');
  const dialog = src('src/components/consignments/ConsignmentSaleDialog.tsx');
  ok(/\(\(p\?\.taxScheme as TaxScheme \| undefined\) \|\| 'MARGIN'\)/.test(dialog)
    && /const ohneVat = consignorGroups\.find\(\(g\) => !consignorVat\[g\.consignorId\]\);/.test(dialog)
    && /consignorTaxScheme: consignorVat\[r\.c\.consignorId\],/.test(dialog) && !/consignorVat\[[^\]]+\] \?\? 'ZERO'/.test(dialog),
    '§F Verkaufsdialog am Rechner (Primary + PC2): Einkaufs-VAT je Einlieferer Pflicht, nichts vorbelegt');
  const maske = src('src/pages/invoices/InvoiceCreate.tsx');
  ok(/<option value="VAT_10">VAT 10%<\/option>/.test(maske) && /<option value="ZERO">Zero<\/option>/.test(maske) && /<option value="MARGIN">Margin<\/option>/.test(maske)
    && /data-invoice-line-scheme=\{idx\}\s*\n\s*disabled=\{!!l\.returnedQty\}/.test(maske),
    '§F Rechnungsmaske: alle drei wählbar, gesperrt nur für retournierte Stücke — nichts aus der Einkaufs-VAT (D5)');
  ok(!/Tax check|data-tax-check|taxCheck/.test(maske + dialog + ui), '§F D1: kein Steuerhinweis, keine zusätzliche Bestätigung');
  ok(!/VAT 0% on margin|Margin Scheme" applied/.test(maske), '§F D1: der sachlich falsche Text „Margin Scheme applied: VAT 0% on margin" ist entfernt');
  const verkauf = src('src/stores/invoiceStore.ts') + src('src/core/bridge/invoice-command.ts') + src('src/stores/consignmentStore.ts');
  ok(!/purchase_lines[^;]*tax_scheme|purchase_line_id[^;]*tax_scheme/.test(verkauf), '§F kein Verkaufsweg liest die Einkaufs-VAT für die Steuerart (D5, keine Kopplung)');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — P2 E10 tax choice: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('MIXED_INVOICE_P2_E10_TAX_CHOICE_PROVED');
