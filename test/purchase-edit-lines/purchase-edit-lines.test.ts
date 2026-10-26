// ════════════════════════════════════════════════════════════════════════════
// PURCHASE-EDIT Teil 2/3 (v0.8.91) — Positionen nachtragen und entfernen.
// Echte sql.js-Datenbank (schema.sql + echte Migrationen + A1 + Medienschema), echte Stores, echte Hausfolgen,
// echtes Hauptbuch, echte Brücke — wie purchase-edit.test.ts.
// Run: node --experimental-strip-types test/purchase-edit-lines/purchase-edit-lines.test.ts
//
//   A  Neuer Artikel nachtragen: Summe, Zeile, Los, Artikel (SKU aus dem Zähler, Fotos, Preis, Datum), AP, Hauptbuch neu
//   B  Vorhandener Artikel nachtragen: zweites Los, Menge, Lagerstatus (verkaufter Artikel wieder im Lager)
//   C  Entfernen, Artikel von der Zeile angelegt und an nichts sonst: Zeile, Los UND Artikel weg, Protokoll, Abgleich
//   D  Entfernen, Artikel vorher vorhanden: nur Zeile und Los, Artikel bleibt (Menge, Status)
//   E  Entfernen, Artikel von der Zeile angelegt, aber anderswo gebunden (Angebot): Artikel bleibt
//   F  Sperren (fail-closed, nichts geschrieben, keine Nummer verbraucht)
//   G  Zahlungen bleiben; Überzahlung → Lieferantenguthaben, Nachtrag baut es wieder ab
//   H  Vorsteuer 10 % im laufenden Quartal: Nachtrag und Entfernen buchen die Vorsteuer neu
//   I  Alles in EINER Bearbeitung: Preis + Entfernen + Nachtragen, eine Fassung, ein Beleg
//   J  Atomar: scheitert das Anhängen nach dem Entfernen, bleibt alles wie vorher
//   K  PC2: derselbe Befehl fern (Fotos aus der Ablage, Wiederholung, Rumpf), Primary == PC2
//   L  Storno nach Nachtrag/Entfernen räumt sauber ab
//   M  Pins: Maske, Rumpf, Abgleichvertrag
// Invariante überall: Σ Restmenge × Einstand aller Lose == Saldo INVENTORY, Hauptbuch ausgeglichen.
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
const { buildSkuSeed } = await import('../../src/core/products/sku-allocation.ts');
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
const life = await import('../../src/core/purchases/purchase-lifecycle-house.ts');
const edit = await import('../../src/core/purchases/purchase-edit-house.ts');
const { PURCHASE_LINE_OPS } = await import('../../src/core/purchases/purchase-lines.ts');
const purchaseHouse = await import('../../src/core/purchases/purchase-house.ts');
const cmds = await import('../../src/core/bridge/purchase-edit-commands.ts');
const { productWasDeleted } = await import('../../src/core/products/product-leftovers.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const S = (v: unknown): string => JSON.stringify(v);
// Fest, damit das Quartal der Vorsteuer-Regel stimmt (Q4 2026) — dieselbe Uhr für Primary und PC2.
const NOW = '2026-10-24T10:00:00.000Z';
const PDATE = '2026-10-20';   // nach dem Eröffnungsstichtag 15.10.2026
const SDATE = '2026-10-21';
const IMG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQ==';
const r3 = (x: number): number => Math.round(x * 1000) / 1000;
const eq = (a: number, b: number): boolean => Math.abs(a - b) < 0.0005;

interface Db {
  run(sql: string, p?: unknown[]): unknown;
  exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
}
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const n = (db: Db, sql: string, p: unknown[] = []): number => Number(one(db, sql, p) ?? 0);
const s = (db: Db, sql: string, p: unknown[] = []): string => String(one(db, sql, p) ?? '');
const all = (db: Db, sql: string, p: unknown[] = []): string => S(db.exec(sql, p)[0]?.values ?? []);

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
  applyMediaSchema(db as never);
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  reload();
  useProductStore.getState().loadCategories();
  tauriState.reset();
  return db;
}

useAuthStore.setState({ session: { userId: 'user-test', branchId: 'branch-main', role: 'ADMIN' } as never });
const CTX = { branchId: 'branch-main', userId: 'user-test', now: NOW };

function imHaus<T>(fn: () => T): T {
  posting.beginLedgerTransaction();
  try { const out = fn(); posting.commitLedgerTransaction(); return out; }
  catch (e) { posting.rollbackLedgerTransaction(); throw e; }
}
function meldung(fn: () => unknown): string {
  try { fn(); return ''; } catch (e) { return String((e as { code?: unknown }).code ?? '') + '|' + (e as Error).message; }
}
const code = (m: string): string => m.split('|')[0];

type L = { price: number; qty?: number; sku?: string; brand?: string; productId?: string };
/** Ein Einkauf mit mehreren Zeilen (neue oder vorhandene Artikel). */
function kauf(lines: L[], o: { vat?: boolean; date?: string; paid?: number } = {}): { pid: string; lineIds: string[]; productIds: string[] } {
  const p = imHaus(() => usePurchaseStore.getState().createPurchase({
    supplierId: 'sup-1',
    purchaseDate: o.date ?? PDATE,
    lines: lines.map((l) => ({
      ...(l.productId ? { productId: l.productId } : {
        newProduct: { categoryId: 'cat-w', brand: l.brand ?? 'Rolex', name: 'Modell', sku: l.sku ?? `SKU-${Math.random().toString(36).slice(2, 8)}`, taxScheme: 'MARGIN', plannedSalePrice: 900 } as never,
      }),
      quantity: l.qty ?? 1, unitPrice: l.price,
      taxScheme: o.vat ? 'VAT_10' as const : 'ZERO' as const, vatRate: o.vat ? 10 : 0,
    })),
    ...(o.paid ? { initialPayment: { amount: o.paid, method: 'cash' as const } } : {}),
  }));
  reload();
  return { pid: p.id, lineIds: p.lines.map((l) => l.id), productIds: p.lines.map((l) => l.productId!) };
}
const rev = (db: Db, pid: string): number => n(db, 'SELECT revision FROM purchases WHERE id = ?', [pid]);
const editIt = (db: Db, req: Record<string, unknown>, ctx = CTX, ops: unknown = PURCHASE_LINE_OPS) => {
  const out = imHaus(() => edit.editPurchaseInHouse(req as never, ctx, rev(db, String(req.purchaseId)), ops as never));
  reload();
  return out;
};
const LINE = (productId: string, qty = 1, price = 700) => ({
  productId, quantity: qty, unitPrice: price, purchasePrice: 0, taxScheme: 'MARGIN', vatRate: 10, vatAmount: 0, lineTotal: price * qty,
});
/** Verkauf und volle Zahlung — erst dann ist der Artikel „sold" (eine offene Rechnung hält ihn „reserved"). */
function rechnung(productId: string, price = 700): string {
  const id = imHaus(() => useInvoiceStore.getState().createDirectInvoice('cust-1', [LINE(productId, 1, price)] as never, 'PE', `${SDATE}T12:00:00.000Z`).id);
  reload();
  const inv = useInvoiceStore.getState().invoices.find((i) => i.id === id)!;
  imHaus(() => useInvoiceStore.getState().recordPayment(id, r3(inv.grossAmount - inv.paidAmount), 'cash'));
  reload();
  return id;
}
const NEU = (o: Record<string, unknown> = {}) => ({
  mode: 'new', quantity: 1, unitPrice: 300,
  newProduct: { categoryId: 'cat-w', brand: 'Omega', name: 'Speedmaster', taxScheme: 'MARGIN', attributes: {}, ...o },
});

// ── Messgrößen ──
const inventory = (db: Db): number =>
  r3(n(db, "SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0) FROM ledger_entries WHERE account = 'INVENTORY'"));
const lotsValue = (db: Db): number =>
  r3(n(db, "SELECT COALESCE(SUM(qty_remaining * unit_cost), 0) FROM stock_lots WHERE status != 'CANCELLED' AND qty_remaining > 0"));
const balance = (db: Db, account: string, extra = '', p: unknown[] = []): number =>
  r3(n(db, `SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0) FROM ledger_entries WHERE account = ? ${extra}`, [account, ...p]));
const apOf = (db: Db, supplierId: string): number => -balance(db, 'ACCOUNTS_PAYABLE', 'AND counterparty_id = ?', [supplierId]);
const purchaseLive = (db: Db, pid: string, account: string, dir: string): number =>
  r3(n(db, `SELECT COALESCE(SUM(e1.amount), 0) FROM ledger_entries e1 WHERE e1.source_module = 'PURCHASE' AND e1.source_id = ? AND e1.account = ? AND e1.direction = ?
             AND e1.reverses_entry_id IS NULL AND NOT EXISTS (SELECT 1 FROM ledger_entries e2 WHERE e2.reverses_entry_id = e1.id)`, [pid, account, dir]));
const invariant = (db: Db, tag: string): void => {
  const a = inventory(db); const b = lotsValue(db);
  ok(eq(a, b), `${tag} Invariante: INVENTORY ${a} == Restwert der Lose ${b}`);
  const d = r3(n(db, "SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0) FROM ledger_entries"));
  ok(eq(d, 0), `${tag} Hauptbuch ausgeglichen (${d})`);
};
/** Was eine Ablehnung NICHT verändern darf — Beleg, Zeilen, Lose, Artikel, Hauptbuch, Protokolle, Zähler. */
const zustand = (db: Db): string => S({
  p: all(db, 'SELECT id, total_amount, paid_amount, remaining_amount, status, revision FROM purchases ORDER BY id'),
  l: all(db, 'SELECT id, quantity, unit_price, line_total FROM purchase_lines ORDER BY id'),
  lots: all(db, 'SELECT id, qty_total, qty_remaining, unit_cost, status FROM stock_lots ORDER BY id'),
  prod: all(db, 'SELECT id, sku, quantity, stock_status FROM products ORDER BY id'),
  le: n(db, 'SELECT COUNT(*) FROM ledger_entries'), au: n(db, 'SELECT COUNT(*) FROM audit_log'),
  pe: n(db, 'SELECT COUNT(*) FROM purchase_edits'), sc: all(db, 'SELECT stem, next_number FROM sku_sequences ORDER BY stem'),
  cr: all(db, 'SELECT id, amount, used_amount, status FROM supplier_credits ORDER BY id'),
});

// ══ A — neuen Artikel nachtragen ═══════════════════════════════════════════════════
{
  const db = freshDb();
  const k = kauf([{ price: 500 }]);
  const seed = buildSkuSeed('Omega', 'cat-w');
  const sku0 = useProductStore.getState().peekSku(seed);
  const vorEintraege = n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'PURCHASE' AND source_id = ?", [k.pid]);
  const r0 = rev(db, k.pid);
  const out = editIt(db, { purchaseId: k.pid, reason: 'Artikel vergessen', addLines: [NEU({ images: [IMG] }) as never].map((x) => ({ ...x, quantity: 2 })) });
  ok(S(out.kinds) === S(['ADD_LINE']) && out.totalAmount === 1100 && out.remainingAmount === 1100 && out.status === 'UNPAID' && out.addedLineIds.length === 1,
    `A Kopf: 500 + 2 × 300 = 1100, offen, UNPAID (${S(out)})`);
  const lid = out.addedLineIds[0];
  ok(all(db, 'SELECT quantity, unit_price, line_total, position, created_product, tax_scheme FROM purchase_lines WHERE id = ?', [lid]) === S([[2, 300, 600, 2, 1, 'ZERO']]),
    `A Zeile hinten angehängt, legt ihren Artikel an (${all(db, 'SELECT quantity, unit_price, line_total, position, created_product, tax_scheme FROM purchase_lines WHERE id = ?', [lid])})`);
  const pid2 = s(db, 'SELECT product_id FROM purchase_lines WHERE id = ?', [lid]);
  ok(s(db, 'SELECT sku FROM products WHERE id = ?', [pid2]) === sku0 && useProductStore.getState().peekSku(seed) !== sku0,
    `A die SKU kommt aus dem zentralen Zähler (Vorschau ${sku0} = vergeben ${s(db, 'SELECT sku FROM products WHERE id = ?', [pid2])})`);
  ok(all(db, 'SELECT brand, name, purchase_price, substr(purchase_date, 1, 10), stock_status, quantity FROM products WHERE id = ?', [pid2])
    === S([['Omega', 'Speedmaster', 300, PDATE, 'in_stock', 2]]), 'A Artikel in Collections: Marke, Modell, Einkaufspreis, -datum, im Lager, Menge 2');
  ok(s(db, 'SELECT images FROM products WHERE id = ?', [pid2]).includes(IMG), 'A das Foto des neuen Artikels ist am Artikel');
  ok(all(db, 'SELECT qty_total, qty_remaining, unit_cost, acquired_at, status FROM stock_lots WHERE purchase_line_id = ?', [lid]) === S([[2, 2, 300, PDATE, 'ACTIVE']]),
    'A ein Los: 2 Stück zu 300, datiert auf den Einkauf');
  ok(apOf(db, 'sup-1') === 1100 && purchaseLive(db, k.pid, 'INVENTORY', 'DEBIT') === 1100, `A AP und Lager 1100 (${apOf(db, 'sup-1')} / ${purchaseLive(db, k.pid, 'INVENTORY', 'DEBIT')})`);
  ok(n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'PURCHASE' AND source_id = ? AND reverses_entry_id IS NOT NULL", [k.pid]) === vorEintraege,
    'A die alte Einkaufsbuchung ist gegengebucht (nicht überschrieben)');
  ok(n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'PURCHASE' AND source_id = ? AND reverses_entry_id IS NULL AND substr(occurred_at, 1, 10) = '2026-10-24'", [k.pid]) > vorEintraege,
    'A …und neu gebucht am Tag der Korrektur');
  ok(rev(db, k.pid) === r0 + 1 && s(db, 'SELECT kinds FROM purchase_edits WHERE purchase_id = ?', [k.pid]) === 'ADD_LINE'
    && s(db, "SELECT new_value FROM audit_log WHERE entity_type = 'purchases' AND entity_id = ? AND action_type = 'UPDATE'", [k.pid]).includes(lid),
  'A eine Fassung mehr, Beleg ADD_LINE, Feldprotokoll nennt die neue Zeile');
  ok(n(db, "SELECT COUNT(*) FROM sync_changelog WHERE table_name = 'purchase_lines' AND record_id = ? AND action = 'insert'", [lid]) === 1,
    'A die neue Zeile reist über den Abgleich');
  invariant(db, 'A');

  // Eine eingetippte SKU bleibt; die Vorschau-Nummer wird dann nicht verbraucht.
  const sku1 = useProductStore.getState().peekSku(seed);
  const out2 = editIt(db, { purchaseId: k.pid, reason: 'noch eins', addLines: [NEU({ sku: 'OWN-77' })] });
  ok(s(db, 'SELECT p.sku FROM purchase_lines l JOIN products p ON p.id = l.product_id WHERE l.id = ?', [out2.addedLineIds[0]]) === 'OWN-77'
    && useProductStore.getState().peekSku(seed) === sku1, 'A eine eingetippte SKU bleibt, der Zähler bleibt');
  // Eine schon vergebene SKU: Nein, nichts geschrieben.
  const vor = zustand(db);
  const m = meldung(() => editIt(db, { purchaseId: k.pid, reason: 'doppelt', addLines: [NEU({ sku: 'OWN-77' })] }));
  ok(code(m) === 'SKU_TAKEN' && zustand(db) === vor, `A vergebene SKU: Nein, nichts geschrieben (${m.slice(0, 70)})`);
  invariant(db, 'A2');
}

// ══ B — vorhandenen Artikel nachtragen ════════════════════════════════════════════
{
  const db = freshDb();
  const k1 = kauf([{ price: 400 }]);
  const x = k1.productIds[0];
  rechnung(x);
  ok(s(db, 'SELECT stock_status FROM products WHERE id = ?', [x]) === 'sold', 'B vorher: der Artikel ist verkauft');
  const k2 = kauf([{ price: 200 }]);
  const out = editIt(db, { purchaseId: k2.pid, reason: 'zweites Stück vergessen', addLines: [{ mode: 'existing', productId: x, quantity: 1, unitPrice: 450 }] });
  const lid = out.addedLineIds[0];
  ok(out.totalAmount === 650 && n(db, 'SELECT created_product FROM purchase_lines WHERE id = ?', [lid]) === 0,
    `B Summe 650, die Zeile verknüpft den vorhandenen Artikel (created_product 0)`);
  ok(n(db, 'SELECT COUNT(*) FROM stock_lots WHERE product_id = ?', [x]) === 2 && n(db, 'SELECT quantity FROM products WHERE id = ?', [x]) === 1
    && s(db, 'SELECT stock_status FROM products WHERE id = ?', [x]) === 'in_stock',
  'B ein zweites Los, Menge 1, wieder im Lager (dieselbe Regel wie beim Anlegen)');
  ok(n(db, 'SELECT purchase_price FROM products WHERE id = ?', [x]) === 400, 'B der Einkaufspreis des vorhandenen Artikels bleibt (er gehört dem ersten Einkauf)');
  invariant(db, 'B');
}

// ══ C — entfernen, Artikel geht mit ═════════════════════════════════════════════════
{
  const db = freshDb();
  const k = kauf([{ price: 500 }, { price: 300 }]);
  const [l1, l2] = k.lineIds;
  const p2 = k.productIds[1];
  const check = edit.purchaseEditCheck(k.pid, 'branch-main', NOW);
  const c2 = check.lines.find((l) => l.lineId === l2)!;
  ok(c2.remove.allowed && c2.removesProduct, `C Auskunft: entfernbar, der Artikel geht mit (${S(c2.remove)})`);
  const lot2 = s(db, 'SELECT id FROM stock_lots WHERE purchase_line_id = ?', [l2]);
  const out = editIt(db, { purchaseId: k.pid, reason: 'doppelt erfasst', removeLineIds: [l2] });
  ok(S(out.kinds) === S(['REMOVE_LINE']) && out.totalAmount === 500 && S(out.removedLineIds) === S([l2]) && S(out.removedProductIds) === S([p2]),
    `C Kopf 500, Zeile und Artikel entfernt (${S(out)})`);
  ok(n(db, 'SELECT COUNT(*) FROM purchase_lines WHERE id = ?', [l2]) === 0 && n(db, 'SELECT COUNT(*) FROM stock_lots WHERE id = ?', [lot2]) === 0
    && n(db, 'SELECT COUNT(*) FROM products WHERE id = ?', [p2]) === 0, 'C Zeile, Los und Artikel sind weg');
  ok(n(db, 'SELECT COUNT(*) FROM purchase_lines WHERE id = ?', [l1]) === 1, 'C die andere Zeile bleibt');
  ok(productWasDeleted(db as never, p2), 'C das Löschen des Artikels ist protokolliert (Sperre gegen ein Wiederanlegen vom Handy)');
  ok(n(db, "SELECT COUNT(*) FROM audit_log WHERE entity_type = 'purchase_lines' AND entity_id = ? AND action_type = 'DELETE'", [l2]) === 1,
    'C das Entfernen der Zeile steht im Protokoll');
  const vorher = JSON.parse(s(db, 'SELECT old_snapshot FROM purchase_edits WHERE purchase_id = ?', [k.pid]));
  ok(vorher.lines.some((l: { id: string }) => l.id === l2), 'C der Vorher-Stand des Belegs enthält die entfernte Zeile');
  ok(['purchase_lines', 'stock_lots', 'products'].every((t) =>
    n(db, "SELECT COUNT(*) FROM sync_changelog WHERE table_name = ? AND action = 'delete'", [t]) === 1), 'C Abgleich: Zeile, Los und Artikel als Löschung gemeldet');
  ok(apOf(db, 'sup-1') === 500, `C AP 500 (${apOf(db, 'sup-1')})`);
  invariant(db, 'C');
}

// ══ D — entfernen, Artikel war vorher da ════════════════════════════════════════════
{
  const db = freshDb();
  const k1 = kauf([{ price: 400 }]);
  const x = k1.productIds[0];
  const k2 = kauf([{ price: 200 }, { price: 420, productId: x }]);
  ok(n(db, 'SELECT quantity FROM products WHERE id = ?', [x]) === 2, 'D vorher: zwei Stück (zwei Einkäufe)');
  const check = edit.purchaseEditCheck(k2.pid, 'branch-main', NOW);
  ok(!check.lines.find((l) => l.lineId === k2.lineIds[1])!.removesProduct, 'D Auskunft: der Artikel bleibt');
  const out = editIt(db, { purchaseId: k2.pid, reason: 'falsch zugeordnet', removeLineIds: [k2.lineIds[1]] });
  ok(out.removedProductIds.length === 0 && n(db, 'SELECT COUNT(*) FROM products WHERE id = ?', [x]) === 1
    && n(db, 'SELECT quantity FROM products WHERE id = ?', [x]) === 1 && s(db, 'SELECT stock_status FROM products WHERE id = ?', [x]) === 'in_stock',
  'D nur Zeile und Los entfernt — der Artikel bleibt mit dem Stück aus dem ersten Einkauf');
  ok(n(db, "SELECT COUNT(*) FROM stock_lots WHERE product_id = ? AND status = 'ACTIVE'", [x]) === 1
    && s(db, 'SELECT status FROM stock_lots WHERE purchase_line_id = ?', [k2.lineIds[1]]) === 'CANCELLED',
  'D das Los des ersten Einkaufs bleibt aktiv; das Los der entfernten Zeile ist storniert (Historie, wie beim Storno)');
  invariant(db, 'D');
  // Ohne weiteren Bestand: wie beim Storno nicht mehr „in_stock".
  const k3 = kauf([{ price: 100 }]);
  const y = k3.productIds[0];
  rechnung(y);
  const k4 = kauf([{ price: 50 }, { price: 110, productId: y }]);
  ok(s(db, 'SELECT stock_status FROM products WHERE id = ?', [y]) === 'in_stock', 'D2 der verkaufte Artikel kam mit dem zweiten Einkauf wieder ins Lager');
  editIt(db, { purchaseId: k4.pid, reason: 'nie gekommen', removeLineIds: [k4.lineIds[1]] });
  ok(n(db, 'SELECT quantity FROM products WHERE id = ?', [y]) === 0 && s(db, 'SELECT stock_status FROM products WHERE id = ?', [y]) === 'returned',
    `D2 ohne Bestand nicht mehr im Lager (${s(db, 'SELECT stock_status FROM products WHERE id = ?', [y])}) — dieselbe Regel wie beim Storno`);
  invariant(db, 'D2');
}

// ══ E — Artikel von der Zeile angelegt, aber anderswo gebunden ═══════════════════════
{
  const db = freshDb();
  const k = kauf([{ price: 500 }, { price: 300 }]);
  const p2 = k.productIds[1];
  db.run(`INSERT INTO offers (id, branch_id, offer_number, customer_id, status, created_at, updated_at) VALUES ('off-1','branch-main','OFF-1','cust-1','draft',?,?)`, [NOW, NOW]);
  db.run(`INSERT INTO offer_lines (id, offer_id, product_id, unit_price, line_total) VALUES ('ol-1','off-1',?,800,800)`, [p2]);
  const check = edit.purchaseEditCheck(k.pid, 'branch-main', NOW);
  const c2 = check.lines.find((l) => l.lineId === k.lineIds[1])!;
  ok(c2.remove.allowed && !c2.removesProduct, 'E Auskunft: entfernbar, aber der Artikel bleibt (er steht in einem Angebot)');
  const out = editIt(db, { purchaseId: k.pid, reason: 'nie geliefert', removeLineIds: [k.lineIds[1]] });
  ok(out.removedProductIds.length === 0 && n(db, 'SELECT COUNT(*) FROM products WHERE id = ?', [p2]) === 1
    && n(db, 'SELECT quantity FROM products WHERE id = ?', [p2]) === 0,
  `E der Artikel bleibt (Angebot), ohne Bestand (${S(out.removedProductIds)} / ${all(db, 'SELECT quantity, stock_status FROM products WHERE id = ?', [p2])})`);
  invariant(db, 'E');
}

// ══ F — Sperren ═══════════════════════════════════════════════════════════════════
{
  const nein = (db: Db, req: Record<string, unknown>, want: string, tag: string, ctx = CTX, ops: unknown = PURCHASE_LINE_OPS): void => {
    const vor = zustand(db);
    const m = meldung(() => editIt(db, req, ctx, ops));
    ok(code(m) === want && zustand(db) === vor, `F ${tag}: ${want}, nichts geschrieben (${m.slice(0, 90)})`);
  };
  let db = freshDb();
  let k = kauf([{ price: 500 }, { price: 300 }]);
  rechnung(k.productIds[0]);
  nein(db, { purchaseId: k.pid, reason: 'x', removeLineIds: [k.lineIds[0]] }, 'PURCHASE_EDIT_REMOVE_STOCK_USED', 'verkauft');
  db.run("UPDATE products SET stock_status = 'reserved' WHERE id = ?", [k.productIds[1]]);
  nein(db, { purchaseId: k.pid, reason: 'x', removeLineIds: [k.lineIds[1]] }, 'PURCHASE_EDIT_REMOVE_STOCK_USED', 'reserviert');
  db.run("UPDATE products SET stock_status = 'in_stock' WHERE id = ?", [k.productIds[1]]);
  nein(db, { purchaseId: k.pid, reason: 'x', removeLineIds: [k.lineIds[1], k.lineIds[1]] }, 'PURCHASE_EDIT_LINE_DUPLICATE', 'doppelt');
  nein(db, { purchaseId: k.pid, reason: 'x', removeLineIds: ['gibt-es-nicht'] }, 'PURCHASE_EDIT_LINE_UNKNOWN', 'fremde Zeile');
  nein(db, { purchaseId: k.pid, reason: 'x', removeLineIds: [k.lineIds[1]], lines: [{ lineId: k.lineIds[1], unitPrice: 1 }], correctionKind: 'ENTRY_ERROR' },
    'PURCHASE_EDIT_LINE_CONFLICT', 'berichtigt UND entfernt');
  nein(db, { purchaseId: k.pid, reason: '  ', removeLineIds: [k.lineIds[1]] }, 'PURCHASE_EDIT_REASON_REQUIRED', 'ohne Grund');
  // Letzte Position
  db = freshDb();
  k = kauf([{ price: 500 }]);
  ok(edit.purchaseEditCheck(k.pid, 'branch-main', NOW).lines[0].remove.allowed === false, 'F Auskunft: die einzige Zeile ist nicht entfernbar');
  nein(db, { purchaseId: k.pid, reason: 'x', removeLineIds: [k.lineIds[0]] }, 'PURCHASE_EDIT_LAST_LINE', 'einzige Zeile');
  db = freshDb();
  k = kauf([{ price: 500 }, { price: 300 }]);
  nein(db, { purchaseId: k.pid, reason: 'x', removeLineIds: [...k.lineIds] }, 'PURCHASE_EDIT_LAST_LINE', 'alle Zeilen');
  nein(db, { purchaseId: k.pid, reason: 'x', removeLineIds: [...k.lineIds], addLines: [NEU()] }, 'PURCHASE_EDIT_LAST_LINE', 'alle Zeilen trotz Nachtrag');
  // Partner, Auftrag
  db.run(`INSERT INTO partners (id, branch_id, name, active, created_at, updated_at) VALUES ('par-1','branch-main','Partner',1,?,?)`, [NOW, NOW]);
  db.run(`INSERT INTO item_participations (id, branch_id, purchase_id, purchase_line_id, product_id, party, partner_id, share_bp, cost_share, line_total, quantity, created_at)
          VALUES ('ip1','branch-main',?,?,?,'PARTNER','par-1',5000,250,500,1,?)`, [k.pid, k.lineIds[0], k.productIds[0], NOW]);
  nein(db, { purchaseId: k.pid, reason: 'x', removeLineIds: [k.lineIds[0]] }, 'PURCHASE_EDIT_PARTNER_LINE', 'Partnerzeile');
  db.run('UPDATE purchase_lines SET source_order_line_id = ? WHERE id = ?', ['ol-x', k.lineIds[1]]);
  nein(db, { purchaseId: k.pid, reason: 'x', removeLineIds: [k.lineIds[1]] }, 'PURCHASE_EDIT_REMOVE_ORDER_LINE', 'Auftragszeile');
  // Nachtrag: Eingaben
  db = freshDb();
  k = kauf([{ price: 500 }]);
  nein(db, { purchaseId: k.pid, reason: 'x', addLines: [{ ...NEU(), quantity: 0 }] }, 'PURCHASE_EDIT_QTY_INVALID', 'Menge 0');
  nein(db, { purchaseId: k.pid, reason: 'x', addLines: [{ ...NEU(), quantity: 1.5 }] }, 'PURCHASE_EDIT_QTY_INVALID', 'Menge 1,5');
  nein(db, { purchaseId: k.pid, reason: 'x', addLines: [{ ...NEU(), unitPrice: -1 }] }, 'PURCHASE_EDIT_PRICE_INVALID', 'Preis negativ');
  nein(db, { purchaseId: k.pid, reason: 'x', addLines: [{ mode: 'new', quantity: 1, unitPrice: 1 }] }, 'PURCHASE_EDIT_ADD_INVALID', 'neu ohne Artikel');
  nein(db, { purchaseId: k.pid, reason: 'x', addLines: [{ mode: 'existing', productId: 'gibt-es-nicht', quantity: 1, unitPrice: 1 }] }, 'PRODUCT_NOT_FOUND', 'fremder Artikel');
  db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, quantity, condition, scope_of_delivery, purchase_price, purchase_currency, stock_status,
            tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
          VALUES ('bulk-gold-999','branch-main','cat-bulk-metal-gold','Gold','999',0,'','[]',0,'BHD','in_stock','MARGIN',0,'[]','{}','OWN',?,?)`, [NOW, NOW]);
  nein(db, { purchaseId: k.pid, reason: 'x', addLines: [{ mode: 'existing', productId: 'bulk-gold-999', quantity: 1, unitPrice: 1 }] }, 'PRODUCT_NOT_FOUND', 'Edelmetall-Systemartikel');
  nein(db, { purchaseId: k.pid, reason: 'x', addLines: Array.from({ length: 51 }, () => NEU()) }, 'PURCHASE_EDIT_ADD_TOO_MANY', 'mehr als 50');
  nein(db, { purchaseId: k.pid, reason: 'x', addLines: [NEU({ brand: '' })] }, 'LINE_INVALID', 'ohne Marke, wo die Kategorie sie verlangt');
  nein(db, { purchaseId: k.pid, reason: 'x', addLines: [NEU()] }, 'PURCHASE_EDIT_ADD_UNAVAILABLE', 'ohne Zeilenfolge', CTX, null);
  // Einkauf: Kommission, Rückgabe, Stichtag, Vorsteuer, gemischt, storniert
  db = freshDb();
  k = kauf([{ price: 500 }, { price: 300 }]);
  db.run("UPDATE purchases SET source_consignment_id = 'con-x' WHERE id = ?", [k.pid]);
  nein(db, { purchaseId: k.pid, reason: 'x', addLines: [NEU()] }, 'PURCHASE_EDIT_CONSIGNMENT', 'Kommission: Nachtrag');
  nein(db, { purchaseId: k.pid, reason: 'x', removeLineIds: [k.lineIds[1]] }, 'PURCHASE_EDIT_CONSIGNMENT', 'Kommission: Entfernen');
  db = freshDb();
  k = kauf([{ price: 500 }, { price: 300 }]);
  imHaus(() => life.returnToSupplierInHouse({ purchaseId: k.pid, refundMethod: 'cash', lines: [{ purchaseLineId: k.lineIds[0], quantity: 1, unitPrice: 500 }] }, CTX, rev(db, k.pid)));
  reload();
  nein(db, { purchaseId: k.pid, reason: 'x', addLines: [NEU()] }, 'PURCHASE_EDIT_HAS_RETURN', 'mit Rückgabe');
  db = freshDb();
  k = kauf([{ price: 500 }, { price: 300 }], { date: '2026-10-10' });
  nein(db, { purchaseId: k.pid, reason: 'x', addLines: [NEU()] }, 'PURCHASE_EDIT_BEFORE_CUTOVER', 'vor dem Stichtag: Nachtrag');
  nein(db, { purchaseId: k.pid, reason: 'x', removeLineIds: [k.lineIds[1]] }, 'PURCHASE_EDIT_BEFORE_CUTOVER', 'vor dem Stichtag: Entfernen');
  db = freshDb();
  k = kauf([{ price: 110 }, { price: 220 }], { vat: true });
  const spaeter = { ...CTX, now: '2027-01-05T10:00:00.000Z' };
  nein(db, { purchaseId: k.pid, reason: 'x', addLines: [NEU()] }, 'PURCHASE_EDIT_VAT_PERIOD', 'Vorsteuer, früheres Quartal: Nachtrag', spaeter);
  nein(db, { purchaseId: k.pid, reason: 'x', removeLineIds: [k.lineIds[1]] }, 'PURCHASE_EDIT_VAT_PERIOD', 'Vorsteuer, früheres Quartal: Entfernen', spaeter);
  db.run(`INSERT INTO vat_filings (id, branch_id, year, quarter, filed_at, snapshot_json, created_at) VALUES ('vf1','branch-main',2026,4,?, '{}', ?)`, [NOW, NOW]);
  nein(db, { purchaseId: k.pid, reason: 'x', addLines: [NEU()] }, 'PURCHASE_EDIT_VAT_PERIOD', 'Vorsteuer, eingereichtes Quartal');
  db = freshDb();
  k = kauf([{ price: 500 }, { price: 300 }]);
  db.run("UPDATE purchase_lines SET tax_scheme = 'VAT_10', vat_amount = 27.273 WHERE id = ?", [k.lineIds[1]]);
  ok(edit.purchaseEditCheck(k.pid, 'branch-main', NOW).addLines.allowed === false, 'F Auskunft: gemischte Vorsteuer sperrt den Nachtrag');
  nein(db, { purchaseId: k.pid, reason: 'x', addLines: [NEU()] }, 'PURCHASE_EDIT_ADD_MIXED_VAT', 'gemischte Vorsteuer');
  db = freshDb();
  k = kauf([{ price: 500 }, { price: 300 }]);
  imHaus(() => life.cancelPurchaseInHouse(k.pid, 'branch-main', {}));
  reload();
  nein(db, { purchaseId: k.pid, reason: 'x', addLines: [NEU()] }, 'PURCHASE_CANCELLED', 'storniert');
  // Alte Fassung
  db = freshDb();
  k = kauf([{ price: 500 }, { price: 300 }]);
  const vor = zustand(db);
  const alt = meldung(() => imHaus(() => edit.editPurchaseInHouse({ purchaseId: k.pid, reason: 'x', removeLineIds: [k.lineIds[1]] }, CTX, rev(db, k.pid) - 1, PURCHASE_LINE_OPS)));
  ok(code(alt) === 'RECORD_CHANGED' && zustand(db) === vor, 'F alte Fassung: RECORD_CHANGED, nichts geschrieben');
}

// ══ G — Zahlungen und Überzahlung ═══════════════════════════════════════════════════
{
  const db = freshDb();
  const k = kauf([{ price: 500 }, { price: 300 }], { paid: 800 });
  const zahlungen = all(db, 'SELECT id, amount, method, paid_at, voided_at FROM purchase_payments WHERE purchase_id = ?', [k.pid]);
  const out = editIt(db, { purchaseId: k.pid, reason: 'zweites Stück nie gekommen', removeLineIds: [k.lineIds[1]] });
  ok(out.totalAmount === 500 && out.remainingAmount === 0 && out.status === 'PAID' && out.overpayCredit === 300,
    `G Summe 500, bezahlt, die Überzahlung 300 wird Lieferantenguthaben (${S(out)})`);
  ok(all(db, 'SELECT id, amount, method, paid_at, voided_at FROM purchase_payments WHERE purchase_id = ?', [k.pid]) === zahlungen
    && n(db, 'SELECT paid_amount FROM purchases WHERE id = ?', [k.pid]) === 800, 'G die Zahlung bleibt unverändert (Zeile, Betrag, Tag)');
  ok(all(db, 'SELECT amount, used_amount, status FROM supplier_credits WHERE source_purchase_id = ?', [k.pid]) === S([[300, 0, 'OPEN']]), 'G Guthabenzeile 300 offen');
  invariant(db, 'G');
  const out2 = editIt(db, { purchaseId: k.pid, reason: 'doch geliefert, neu erfasst', addLines: [NEU({ unitPrice: undefined }) as never].map((x) => ({ ...x, unitPrice: 300 })) });
  ok(out2.totalAmount === 800 && out2.status === 'PAID' && out2.overpayCredit === 0
    && n(db, 'SELECT COALESCE(SUM(amount), 0) FROM supplier_credits WHERE source_purchase_id = ?', [k.pid]) === 0,
  `G der Nachtrag baut das Guthaben wieder ab (${S(out2)})`);
  invariant(db, 'G2');
}

// ══ H — Vorsteuer 10 % im laufenden Quartal ═════════════════════════════════════════
{
  const db = freshDb();
  const k = kauf([{ price: 110 }, { price: 55 }], { vat: true });
  ok(edit.purchaseEditCheck(k.pid, 'branch-main', NOW).addTaxScheme === 'VAT_10', 'H Auskunft: eine neue Zeile trägt 10 % Vorsteuer');
  const out = editIt(db, { purchaseId: k.pid, reason: 'vergessen', addLines: [{ ...NEU(), unitPrice: 220 }] });
  const lid = out.addedLineIds[0];
  ok(all(db, 'SELECT tax_scheme, vat_rate, ROUND(vat_amount, 3) FROM purchase_lines WHERE id = ?', [lid]) === S([['VAT_10', 10, 20]]), 'H die neue Zeile: VAT_10, 20 Vorsteuer');
  ok(eq(purchaseLive(db, k.pid, 'VAT_INPUT', 'DEBIT'), 35) && eq(n(db, 'SELECT unit_cost FROM stock_lots WHERE purchase_line_id = ?', [lid]), 200),
    `H Vorsteuer neu 10 + 5 + 20 = 35, Los netto 200 (${purchaseLive(db, k.pid, 'VAT_INPUT', 'DEBIT')})`);
  editIt(db, { purchaseId: k.pid, reason: 'nie gekommen', removeLineIds: [k.lineIds[1]] });
  ok(eq(purchaseLive(db, k.pid, 'VAT_INPUT', 'DEBIT'), 30) && apOf(db, 'sup-1') === 330, `H nach dem Entfernen: Vorsteuer 30, AP 330 (${apOf(db, 'sup-1')})`);
  invariant(db, 'H');
}

// ══ I — alles in einer Bearbeitung ═══════════════════════════════════════════════════
{
  const db = freshDb();
  const k = kauf([{ price: 500 }, { price: 300 }]);
  const r0 = rev(db, k.pid);
  const out = editIt(db, {
    purchaseId: k.pid, reason: 'Beleg nachgeprüft', lines: [{ lineId: k.lineIds[0], unitPrice: 450 }], correctionKind: 'ENTRY_ERROR',
    removeLineIds: [k.lineIds[1]], addLines: [NEU()],
  });
  ok(S(out.kinds) === S(['PRICE', 'REMOVE_LINE', 'ADD_LINE']) && out.totalAmount === 750 && rev(db, k.pid) === r0 + 1
    && n(db, 'SELECT COUNT(*) FROM purchase_edits WHERE purchase_id = ?', [k.pid]) === 1,
  `I Preis + Entfernen + Nachtrag: 450 + 300 = 750, eine Fassung, ein Beleg (${S(out.kinds)})`);
  ok(n(db, 'SELECT COUNT(*) FROM purchase_lines WHERE purchase_id = ?', [k.pid]) === 2 && apOf(db, 'sup-1') === 750, 'I zwei Zeilen, AP 750');
  invariant(db, 'I');
}

// ══ J — atomar ═════════════════════════════════════════════════════════════════════
{
  const db = freshDb();
  const k = kauf([{ price: 500 }, { price: 300 }]);
  const vor = zustand(db);
  const bricht = { planAdd: PURCHASE_LINE_OPS.planAdd, append: () => { throw new Error('append: injected'); } };
  const m = meldung(() => editIt(db, { purchaseId: k.pid, reason: 'x', removeLineIds: [k.lineIds[1]], addLines: [NEU()] }, CTX, bricht));
  ok(/injected/.test(m) && zustand(db) === vor && n(db, 'SELECT COUNT(*) FROM products WHERE id = ?', [k.productIds[1]]) === 1,
    `J das Anhängen scheitert NACH dem Entfernen: Zeile, Los, Artikel, Hauptbuch, Zähler wie vorher (${m.slice(0, 50)})`);
  const out = editIt(db, { purchaseId: k.pid, reason: 'x', removeLineIds: [k.lineIds[1]], addLines: [NEU()] });
  ok(out.totalAmount === 800 && out.removedProductIds.length === 1, 'J danach gelingt es genau einmal');
  invariant(db, 'J');
}

// ══ K — PC2 ═══════════════════════════════════════════════════════════════════════
{
  const { lookupCommand } = await import('../../src/core/bridge/command-ledger.ts');
  const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-000000000000`;
  const ACTOR = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role: 'ADMIN' };
  const identity = (x: string, op: string) => ({ commandId: ID(x), ...ACTOR, op, payloadHash: 'h' + x });
  const deps = (db: Db) => ({
    db: db as never,
    begin: () => { setTestDatabase(db as never); posting.beginLedgerTransaction(); },
    commit: posting.commitLedgerTransaction,
    rollback: posting.rollbackLedgerTransaction,
    durableSave: async () => {},
    now: () => NOW,
  });
  const STG = 'a'.repeat(64);
  const gelesen: string[] = []; const geraeumt: string[] = [];
  const media = {
    readStaged: async (id: string) => { gelesen.push(id); return { mime: 'image/jpeg', dataBase64: '/9j/4AAQSkZJRgABAQ' }; },
    discardStaged: async (id: string) => { geraeumt.push(id); },
  };
  type Aus = { ok: boolean; code: string; value: Record<string, unknown>; replayed: boolean };
  const fern = async (p: () => Promise<unknown>): Promise<Aus> => {
    try {
      const o = await p() as { kind: string; code?: string; value?: Record<string, unknown>; replayed?: boolean };
      return { ok: o.kind === 'ok', code: o.code ?? '', value: o.value ?? {}, replayed: o.replayed === true };
    } catch (e) { return { ok: false, code: String((e as { code?: unknown }).code ?? e), value: {}, replayed: false }; }
  };
  const db = freshDb();
  const k = kauf([{ price: 500 }, { price: 300 }]);
  const body = (over: Record<string, unknown> = {}) => ({
    purchaseId: k.pid, expectedRevision: rev(db, k.pid), reason: 'vom zweiten Rechner',
    removeLineIds: [k.lineIds[1]],
    addLines: [{ mode: 'new', quantity: 1, unitPrice: 250, newProduct: { categoryId: 'cat-w', brand: 'Omega', name: 'Seamaster', taxScheme: 'MARGIN', attributes: {}, stagingIds: [STG] } }],
    ...over,
  });
  const seed = buildSkuSeed('Omega', 'cat-w');
  const sku0 = useProductStore.getState().peekSku(seed);
  const r = await fern(() => cmds.runPurchaseEdit(deps(db), identity('701', 'purchases.correct'), body(), true, media));
  setTestDatabase(db as never);
  reload();
  const neuId = s(db, 'SELECT id FROM purchase_lines WHERE purchase_id = ? AND id NOT IN (?, ?)', [k.pid, k.lineIds[0], k.lineIds[1]]);
  const neuP = s(db, 'SELECT product_id FROM purchase_lines WHERE id = ?', [neuId]);
  ok(r.ok && Number(r.value.totalAmount) === 750 && n(db, 'SELECT COUNT(*) FROM products WHERE id = ?', [k.productIds[1]]) === 0,
    `K fern: entfernt und nachgetragen, Summe 750 (${r.code || 'ok'})`);
  ok(s(db, 'SELECT sku FROM products WHERE id = ?', [neuP]) === sku0, `K fern: die SKU vergibt der Primary aus seinem Zähler (${sku0})`);
  ok(s(db, 'SELECT images FROM products WHERE id = ?', [neuP]).includes('data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ'),
    'K fern: das Foto kommt aus der Ablage des Primary an den neuen Artikel');
  ok(S(gelesen) === S([STG]) && S(geraeumt) === S([STG]), `K fern: die Ablage wird gelesen und erst nach Erfolg geräumt (${S(gelesen)} / ${S(geraeumt)})`);
  ok(s(db, 'SELECT edited_by FROM purchase_edits WHERE purchase_id = ?', [k.pid]) === 'user-pc2', 'K das Protokoll nennt den Absender von PC2');
  invariant(db, 'K');
  // Wiederholung: dieselbe Antwort, keine zweite Zeile, keine zweite Nummer.
  const vor = zustand(db);
  const r2 = await fern(() => cmds.runPurchaseEdit(deps(db), identity('701', 'purchases.correct'), body({ expectedRevision: Number(r.value.revision) - 1 }), true, media));
  setTestDatabase(db as never);
  ok(r2.ok && r2.replayed && zustand(db) === vor, `K Wiederholung: aus dem Auftragsbuch, nichts doppelt (${r2.code || 'replayed'})`);
  // Rumpf
  ok(/unknown field/.test(meldung(() => cmds.parsePurchaseEdit(body(), false))), 'K purchases.update nimmt keine Positionen an (nur purchases.correct, Owner)');
  ok(/unknown field: lineTotal/.test(meldung(() => cmds.parsePurchaseEdit(body({ addLines: [{ mode: 'existing', productId: 'x', quantity: 1, unitPrice: 1, lineTotal: 1 }] }), true))),
    'K eine Zeilensumme rechnet der Primary, nicht der Rumpf');
  ok(/mode/.test(meldung(() => cmds.parsePurchaseEdit(body({ addLines: [{ mode: 'bulk', quantity: 1, unitPrice: 1 }] }), true))), 'K Edelmetall-Zeilen gibt es im Nachtrag nicht');
  ok(/staged|staging|content hash/i.test(meldung(() => cmds.parsePurchaseEdit(body({ addLines: [{ mode: 'new', quantity: 1, unitPrice: 1, newProduct: { categoryId: 'cat-w', brand: 'A', name: 'B', stagingIds: ['../x'] } }] }), true))),
    'K ein Foto ist nur eine Ablagekennung (Inhaltshash), kein Pfad');
  ok(/removeLineIds/.test(meldung(() => cmds.parsePurchaseEdit(body({ removeLineIds: 'x' }), true))), 'K removeLineIds ist eine Liste');
  // Ein verschwundenes Foto: Nein in der Klammer, nichts geschrieben, die Kennung bleibt frei.
  const k2 = kauf([{ price: 100 }]);
  const vor2 = zustand(db);
  const weg = await fern(() => cmds.runPurchaseEdit(deps(db), identity('702', 'purchases.correct'), {
    purchaseId: k2.pid, expectedRevision: rev(db, k2.pid), reason: 'x',
    addLines: [{ mode: 'new', quantity: 1, unitPrice: 1, newProduct: { categoryId: 'cat-w', brand: 'A', name: 'B', taxScheme: 'MARGIN', attributes: {}, stagingIds: ['b'.repeat(64)] } }],
  }, true, { readStaged: async () => { throw new Error('missing'); }, discardStaged: async () => {} }));
  setTestDatabase(db as never);
  ok(!weg.ok && zustand(db) === vor2, `K verschwundenes Foto: kein Nachtrag, nichts geschrieben (${weg.code.slice(0, 60)})`);
  ok(lookupCommand(db as never, identity('702', 'purchases.correct') as never).kind !== 'replay', 'K …und keine eingefrorene Wirkung');

  // Primary == PC2 (ohne Fotos): dieselbe Bearbeitung hinterlässt dasselbe.
  const bild = (d: Db, pid: string) => S({
    p: all(d, 'SELECT total_amount, paid_amount, remaining_amount, status FROM purchases WHERE id = ?', [pid]),
    l: all(d, 'SELECT quantity, unit_price, line_total, position, created_product, tax_scheme FROM purchase_lines WHERE purchase_id = ? ORDER BY position', [pid]),
    lots: all(d, 'SELECT qty_total, qty_remaining, unit_cost, status FROM stock_lots WHERE purchase_id = ? ORDER BY unit_cost', [pid]),
    prod: all(d, 'SELECT brand, name, sku, quantity, stock_status, purchase_price FROM products ORDER BY brand, name, sku'),
    pe: all(d, 'SELECT edit_no, reason, kinds FROM purchase_edits ORDER BY edit_no'),
    salden: all(d, `SELECT account, ROUND(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 3) AS net FROM ledger_entries GROUP BY 1 HAVING ABS(net) > 0.0005 ORDER BY 1`),
  });
  const welt = () => { const d = freshDb(); const w = kauf([{ price: 500, sku: 'P-1' }, { price: 300, sku: 'P-2' }]); return { d, w }; };
  const form = (w: { lineIds: string[] }) => ({
    reason: 'Parität', removeLineIds: [w.lineIds[1]],
    addLines: [{ mode: 'new' as const, quantity: 2, unitPrice: 120, newProduct: { categoryId: 'cat-w', brand: 'Omega', name: 'Parität', taxScheme: 'MARGIN' as const, attributes: {} } }],
  });
  const a = welt();
  let primaryFehler = '';
  try { await purchaseHouse.editPurchaseOnPrimary(a.w.pid, form(a.w), rev(a.d, a.w.pid)); } catch (e) { primaryFehler = String((e as { code?: unknown }).code ?? e); }
  setTestDatabase(a.d as never);
  const bA = bild(a.d, a.w.pid);
  const b = welt();
  const rb = await fern(() => cmds.runPurchaseEdit(deps(b.d), identity('711', 'purchases.correct'),
    { purchaseId: b.w.pid, expectedRevision: rev(b.d, b.w.pid), ...form(b.w) }, true, media));
  setTestDatabase(b.d as never);
  const bB = bild(b.d, b.w.pid);
  ok(primaryFehler === '' && rb.ok && bA === bB, `K Primary == PC2: Beleg, Zeilen, Lose, Artikel, Protokoll, Salden (${primaryFehler || 'ok'} / ${rb.code || 'ok'}${bA === bB ? '' : ` · ${bA} vs ${bB}`})`);
}

// ══ L — Storno nach Nachtrag und Entfernen ═══════════════════════════════════════════
{
  const db = freshDb();
  const k = kauf([{ price: 500 }, { price: 300 }]);
  editIt(db, { purchaseId: k.pid, reason: 'x', removeLineIds: [k.lineIds[1]], addLines: [NEU(), { mode: 'existing', productId: k.productIds[0], quantity: 1, unitPrice: 480 }] });
  imHaus(() => life.cancelPurchaseInHouse(k.pid, 'branch-main', {}));
  reload();
  ok(n(db, "SELECT COUNT(*) FROM stock_lots WHERE purchase_id = ? AND status != 'CANCELLED'", [k.pid]) === 0 && inventory(db) === 0 && apOf(db, 'sup-1') === 0,
    'L Storno: alle Lose (auch die nachgetragenen) storniert, Lager und AP 0');
  invariant(db, 'L');
}

// ══ M — Pins ═════════════════════════════════════════════════════════════════════
{
  const pe = src('src/pages/purchases/PurchaseEdit.tsx');
  ok(/data-purchase-edit-remove=\{l\.id\}/.test(pe) && /data-purchase-edit-add-new/.test(pe) && /data-purchase-edit-add-existing/.test(pe),
    'M Maske: „Remove" je Position, „Add existing item" und „Add new item"');
  ok(/<NewProductModal[\s\S]*?skuAutoAssign[\s\S]*?\/>/.test(pe), 'M Maske: dieselbe „New Item"-Maske mit SKU-Vorschau');
  ok(/const removeLock: EditLock \| undefined = !owner \? NUR_OWNER : c\?\.remove;/.test(pe) && /const addLock: EditLock \| undefined = !owner \? NUR_OWNER : check\?\.addLines;/.test(pe),
    'M Maske: Entfernen und Nachtragen nur Owner und nur, wo die Auskunft es erlaubt');
  const ph = src('src/core/purchases/purchase-house.ts');
  ok(/\|\| \(form\.addLines !== undefined && form\.addLines\.length > 0\) \|\| \(form\.removeLineIds !== undefined && form\.removeLineIds\.length > 0\)/.test(ph),
    'M Positionen ändern ist eine Geldkorrektur (purchases.correct)');
  ok(/editPurchaseInHouse\(req, localHouseCtx\(\), expectedRevision, PURCHASE_LINE_OPS\)/.test(ph) && /stageSpecImages\(pickProductSpec\(l\.newProduct, EMBEDDED_PRODUCT_FIELDS\), stage\)/.test(ph),
    'M Primary: dieselbe Zeilenfolge; PC2: Fotos vorab in die Ablage');
  const pc = src('src/core/bridge/purchase-edit-commands.ts');
  ok(/editPurchaseInHouse\(request, ctx, req\.expectedRevision, PURCHASE_LINE_OPS\)/.test(pc) && /mitFotos\(spec, owner, read\)/.test(pc),
    'M Fernbefehl: dieselbe Zeilenfolge, Fotos in der Klammer gelesen');
  const manifest = JSON.parse(src('src/core/sync/sync-business-schema.json')) as { tables: Record<string, { allowed_operations: string[] }> };
  ok(S(manifest.tables.purchase_lines.allowed_operations) === S(['insert', 'update', 'delete']), 'M Abgleichvertrag: eine Einkaufszeile darf gelöscht werden');
  const ps = src('src/stores/purchaseStore.ts');
  ok(/buildPurchaseLineRecords\(input\.lines, purchaseDate, \{ branchId, userId, now \}, 1\)/.test(ps) && /insertPurchaseLineRows\(id, purchaseDate, lineRecords, existingProductIds, \{ branchId, userId, now \}\)/.test(ps),
    'M „Save Purchase" und der Nachtrag benutzen DIESELBE Zeilenfolge');
}

console.log(`\npurchase-edit-lines: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
