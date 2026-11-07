// ════════════════════════════════════════════════════════════════════════════
// MIXED-INVOICE P3 — gemischte Rechnung anlegen: eigene Lagerware + Kommissionsartikel auf EINER Kundenrechnung.
// Run: node test/p3/mixed-invoice-create.test.ts
//
//   §1 Abnahme 1: 2 eigene Artikel + 3 Kommissionen von 2 Einlieferern ⇒ 1 Rechnung, 2 Einkäufe, Summen, Zeilen,
//      Einstand, Verbindlichkeiten, VAT je Zeile — Primary und PC2 buchen GLEICH (ohne Kennungen verglichen)
//   §2 Abnahme 6: Lager je Artikel genau −1, Hauptbuch je Quelle einmal; Abgleich (Lager, AP, AR, ausgeglichen); Audit
//   §3 Abnahme 2: SALES/ACCOUNTANT ⇒ Nein (Haus am Primary und fern; zentrale Rechte fern), nichts gebucht
//   §4 Abnahme 3: E7 ohne Bestätigung ⇒ Nein (Primary + PC2), mit Bestätigung ⇒ gebucht; „Record Sale" unverändert ohne E7
//   §5 Abnahme 4: Fehler im Einkauf / im Protokoll ⇒ nichts gebucht (Rollback)
//   §6 Abnahme 5: wiederholter PC2-Befehl ⇒ einmal gebucht; veraltete Fassung ⇒ Nein
//   §7 Zahlungen: Teilzahlung (PINV, Rest offen, Reserved) und Vollzahlung (Endnummer, verkauft) über die Rechnungswege
//   §8 Sperren: zugemachtes VAT-Quartal, Datum vor der Einlieferung (E3), Käufer = Einlieferer, Boden ohne Bestätigung,
//      eigene Zeile mit Kommissionsware, Überzahlung, ohne Einkaufs-VAT, ohne Kommissionsartikel — je nichts gebucht
//   §9 Bestehende Wege unverändert: reine Kommission („Record Sale") und reine Eigenware („Save Invoice"); Rumpfgrenzen
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
const perms = await import('../../src/core/bridge/command-permissions.ts');
await import('../../src/core/bridge/read-commands.ts');
// Der echte invoice.paid-Handler (Artikel „sold" bei Vollzahlung) — registriert sich beim Laden.
await import('../../src/core/automation/automation-handlers.ts');
const cmd = await import('../../src/core/bridge/commercial-commands.ts');
const life = await import('../../src/core/bridge/lifecycle-commands.ts');
const { runInvoiceCreate } = await import('../../src/core/bridge/invoice-command.ts');
const { createInvoiceOnPrimary } = await import('../../src/core/invoices/invoice-create-house.ts');
const { toInvoiceLine } = await import('../../src/core/invoices/line-derivation.ts');
const mixedMod = await import('../../src/core/invoices/mixed-invoice.ts');
const finance = await import('../../src/core/consignment/consignment-finance.ts');
const conHouse = await import('../../src/core/consignment/consignment-finance-house.ts');
const { computeConsignmentSale } = await import('../../src/core/consignment/economics.ts');
const { useInvoiceStore } = await import('../../src/stores/invoiceStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { useCustomerStore } = await import('../../src/stores/customerStore.ts');
const { useConsignmentStore } = await import('../../src/stores/consignmentStore.ts');
const { usePurchaseStore } = await import('../../src/stores/purchaseStore.ts');
const { useSupplierStore } = await import('../../src/stores/supplierStore.ts');
const { useExpenseStore } = await import('../../src/stores/expenseStore.ts');
const { useAuthStore } = await import('../../src/stores/authStore.ts');
const { todayIso } = await import('../../src/core/utils/business-date.ts');

type MixIn = import('../../src/core/invoices/mixed-invoice.ts').MixedInvoiceInput;
type Line = MixIn['ownLines'][number];

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const S = (v: unknown): string => JSON.stringify(v);
const NOW = '2026-11-07T10:00:00.000Z';
const HEUTE = todayIso();

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
  useExpenseStore.getState().loadExpenses();
}
function sitzung(role: string): void { useAuthStore.setState({ session: { userId: 'user-test', branchId: 'branch-main', role } as never }); }
function freshDb(): Db {
  resetDurabilityStateForTest(); resetTransactionHealthForTest();
  const db = new SQL.Database() as unknown as Db;
  db.run(src('src/core/db/schema.sql'));
  for (const st of MIGRATIONS) { try { db.run(st); } catch { /* da */ } }
  for (const st of A1_UPGRADE_SQL) { try { db.run(st); } catch { /* da */ } }
  db.run(COMMAND_LEDGER_DDL); db.run(COMMAND_LEDGER_INDEX); db.run(SKU_SEQUENCES_DDL);
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-main','tenant-1','Haupt',?,?)", [NOW, NOW]);
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES ('cat-w','branch-main','Watch','w','#000',?,?)", [NOW, NOW]);
  for (const [id, first] of [['cust-1', 'Ali'], ['cust-2', 'Nora'], ['cust-3', 'Sara']]) {
    db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level, preferences, customer_type, sales_stage, created_at, updated_at)
      VALUES (?,'branch-main',?,'Hassan','BH','en',0,'[]','collector','active',?,?)`, [id, first, NOW, NOW]);
  }
  insert(db, 'suppliers', { id: 'sup-1', branch_id: 'branch-main', name: 'Händler', created_at: NOW, updated_at: NOW });
  applyMediaSchema(db as never); setTestDatabase(db as never); installWriteGuard(db as never); reload(); tauriState.reset();
  sitzung('ADMIN');
  return db;
}
function imHaus<T>(fn: () => T): T { posting.beginLedgerTransaction(); try { const o = fn(); posting.commitLedgerTransaction(); return o; } catch (e) { posting.rollbackLedgerTransaction(); throw e; } }
const deps = (db: Db) => ({ db: db as never, begin: posting.beginLedgerTransaction, commit: posting.commitLedgerTransaction, rollback: posting.rollbackLedgerTransaction,
  durableSave: async () => { /* test */ }, now: () => NOW });
let seq = 0;
const ident = (op: string, role = 'ADMIN', x?: string) => {
  const k = x ?? String(++seq).padStart(4, '0');
  return { commandId: `0000${k}-0000-4000-8000-000000000000`, tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role, op, payloadHash: `h${k}` };
};
interface Ausgang { ok: boolean; code: string; value: Record<string, unknown>; replayed: boolean }
async function fern(p: () => Promise<unknown>): Promise<Ausgang> {
  try {
    const o = await p() as { kind: string; code?: string; value?: Record<string, unknown>; replayed?: boolean };
    return o.kind === 'ok' ? { ok: true, code: '', value: o.value ?? {}, replayed: o.replayed === true } : { ok: false, code: o.code ?? '?', value: {}, replayed: false };
  } catch (e) { return { ok: false, code: String((e as { code?: unknown }).code ?? 'THROWN:' + String(e)), value: {}, replayed: false }; }
}
async function primary(p: () => unknown): Promise<Ausgang> {
  try { return { ok: true, code: '', value: (await p() ?? {}) as Record<string, unknown>, replayed: false }; }
  catch (e) { return { ok: false, code: String((e as { code?: unknown }).code ?? 'THROWN:' + String(e)), value: {}, replayed: false }; }
}

// ── Die Welt: zwei eigene Artikel mit Einkauf, drei Kommissionen von zwei Einlieferern, ein Käufer ─────────────
function artikel(db: Db, id: string, name: string, scheme: string): void {
  db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition, scope_of_delivery, purchase_price, purchase_currency,
      planned_sale_price, stock_status, tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
    VALUES (?,'branch-main','cat-w','Rolex',?,?,0,'Pre-Owned','[]',0,'BHD',1500,'in_stock',?,0,'[]','{}','OWN',?,?)`, [id, name, 'SKU-' + id, scheme, NOW, NOW]);
}
function einkauf(pid: string, menge: number, preis: number, vat10: boolean): void {
  imHaus(() => usePurchaseStore.getState().createPurchase({
    supplierId: 'sup-1', lines: [{ productId: pid, quantity: menge, unitPrice: preis, taxScheme: vat10 ? 'VAT_10' as const : 'ZERO' as const, vatRate: vat10 ? 10 : 0 }],
  }));
  reload();
}
async function kommission(db: Db, consignorId: string, name: string, payout: Record<string, unknown>): Promise<string> {
  const c = await fern(() => cmd.runConsignmentCreate(deps(db), ident('consignments.create') as never, {
    consignorId, product: { brand: 'Patek', name, categoryId: 'cat-w' }, agreedPrice: 1000, payout,
  }));
  if (!c.ok) throw new Error('setup consignment: ' + c.code);
  reload();
  return String(c.value.consignmentId ?? '');
}
const PCT = { model: 'percent', commissionRate: 20 };
const FIX = { model: 'consignor_fixed' };
interface Welt { db: Db; k1: string; k2: string; k3: string }
async function welt(): Promise<Welt> {
  const db = freshDb();
  artikel(db, 'own-1', 'Datejust eigen', 'MARGIN'); einkauf('own-1', 1, 2000, false);
  artikel(db, 'own-2', 'Goldkette eigen', 'VAT_10'); einkauf('own-2', 2, 550, true);
  const k1 = await kommission(db, 'cust-1', 'Nautilus', PCT);
  const k2 = await kommission(db, 'cust-1', 'Aquanaut', PCT);
  const k3 = await kommission(db, 'cust-3', 'Calatrava', FIX);
  return { db, k1, k2, k3 };
}
const losVon = (db: Db, pid: string): string => s(db, "SELECT id FROM stock_lots WHERE product_id = ? AND qty_remaining > 0 ORDER BY acquired_at, id LIMIT 1", [pid]);
/** Die eigene Zeile so, wie die Maske am Primary sie baut (Los, Einstand des Loses, Steuerart). */
function eigeneZeile(db: Db, pid: string, scheme: 'VAT_10' | 'ZERO' | 'MARGIN', net: number, qty = 1): Line {
  const lot = losVon(db, pid);
  return toInvoiceLine({ productId: pid, lotId: lot, quantity: qty, unitPrice: net, costBasis: n(db, 'SELECT unit_cost FROM stock_lots WHERE id = ?', [lot]), scheme: scheme }) as Line;
}
/** Dieselbe Zeile als ABSICHT, wie die Maske am zweiten Rechner sie schickt. */
function eigeneAbsicht(db: Db, pid: string, scheme: string, net: number, qty = 1): Record<string, unknown> {
  return { productId: pid, lotId: losVon(db, pid), quantity: qty, unitPrice: net, scheme };
}
const conRev = (db: Db, id: string): number => n(db, 'SELECT revision FROM consignments WHERE id = ?', [id]);
type Item = MixIn['items'][number];
function standardItems(w: Welt): Item[] {
  return [
    { consignmentId: w.k1, salePrice: 1200, acknowledgeShortfall: false, taxScheme: 'MARGIN', consignorTaxScheme: 'ZERO' },
    { consignmentId: w.k2, salePrice: 1100, acknowledgeShortfall: false, taxScheme: 'VAT_10', consignorTaxScheme: 'ZERO' },
    { consignmentId: w.k3, salePrice: 1050, acknowledgeShortfall: false, taxScheme: 'ZERO', consignorTaxScheme: 'VAT_10' },
  ];
}
interface Opt { items?: Item[]; payments?: MixIn['payments']; issuedDate?: string; notes?: string; staffId?: string; ownLines?: 'std' | 'none'; customerId?: string }
function amPrimary(w: Welt, o: Opt = {}): Promise<Ausgang> {
  setTestDatabase(w.db as never); reload();
  const ownLines = o.ownLines === 'none' ? [] : [eigeneZeile(w.db, 'own-1', 'MARGIN', 2500), eigeneZeile(w.db, 'own-2', 'VAT_10', 600)];
  return primary(() => conHouse.createMixedInvoiceOnPrimary({
    customerId: o.customerId ?? 'cust-2', ownLines, items: o.items ?? standardItems(w), issuedDate: o.issuedDate ?? HEUTE,
    notes: o.notes ?? 'Lieferung Freitag', ...(o.staffId ? { staffId: o.staffId } : {}), specialMark: false, ...(o.payments ? { payments: o.payments } : {}),
  }));
}
function rumpf(w: Welt, o: Opt = {}): Record<string, unknown> {
  const ownLines = o.ownLines === 'none' ? [] : [eigeneAbsicht(w.db, 'own-1', 'MARGIN', 2500), eigeneAbsicht(w.db, 'own-2', 'VAT_10', 600)];
  const items = o.items ?? standardItems(w);
  return mixedMod.mixedInvoiceBody({
    customerId: o.customerId ?? 'cust-2', items, issuedDate: o.issuedDate ?? HEUTE, notes: o.notes ?? 'Lieferung Freitag',
    ...(o.staffId ? { staffId: o.staffId } : {}), specialMark: false, ...(o.payments ? { payments: o.payments } : {}),
  }, ownLines, Object.fromEntries(items.map((it) => [it.consignmentId, conRev(w.db, it.consignmentId)])));
}
function amPC2(w: Welt, o: Opt = {}, role = 'ADMIN', x?: string): Promise<Ausgang> {
  setTestDatabase(w.db as never); reload();
  return fern(() => life.runRecordSale(deps(w.db), ident('consignments.record_sale', role, x) as never, rumpf(w, o)));
}
const zaehler = (db: Db): string => S([n(db, 'SELECT COUNT(*) FROM invoices'), n(db, 'SELECT COUNT(*) FROM invoice_lines'), n(db, 'SELECT COUNT(*) FROM purchases'),
  n(db, 'SELECT COUNT(*) FROM expenses'), n(db, 'SELECT COUNT(*) FROM ledger_entries'), n(db, 'SELECT COUNT(*) FROM payments'),
  all(db, 'SELECT status FROM consignments ORDER BY consignment_number'), all(db, 'SELECT product_id, qty_remaining FROM stock_lots ORDER BY product_id, id'),
  n(db, "SELECT COUNT(*) FROM audit_log WHERE field_name = 'mixed_invoice'")]);

// Was eine Rechnung fachlich ist — ohne Kennungen, Zeitstempel und Nummern (Primary und PC2 vergleichbar).
function bild(db: Db, invoiceId: string): Record<string, unknown> {
  const name = (pid: unknown): string => s(db, 'SELECT name FROM products WHERE id = ?', [pid]);
  const kopf = db.exec('SELECT customer_id, status, ROUND(net_amount,3), ROUND(vat_amount,3), ROUND(gross_amount,3), ROUND(paid_amount,3), tax_scheme_snapshot, notes, staff_id FROM invoices WHERE id = ?', [invoiceId])[0]?.values?.[0] ?? [];
  const zeilen = (db.exec(`SELECT product_id, quantity, ROUND(unit_price,3), ROUND(purchase_price_snapshot,3), tax_scheme, ROUND(vat_amount,3), ROUND(line_total,3), lot_id IS NOT NULL
      FROM invoice_lines WHERE invoice_id = ? ORDER BY position, rowid`, [invoiceId])[0]?.values ?? []).map((r) => [name(r[0]), ...r.slice(1)]);
  const einkaeufe = (db.exec(`SELECT p.supplier_id, ROUND(p.total_amount,3), ROUND(p.remaining_amount,3), p.status, p.purchase_date FROM purchases p
      WHERE p.supplier_id != 'sup-1' ORDER BY p.total_amount`)[0]?.values ?? []).map((r) => [s(db, 'SELECT name FROM suppliers WHERE id = ?', [r[0]]), ...r.slice(1)]);
  const elines = (db.exec(`SELECT pl.product_id, ROUND(pl.unit_price,3), pl.tax_scheme, ROUND(pl.vat_amount,3), ROUND(pl.line_total,3) FROM purchase_lines pl
      JOIN purchases p ON p.id = pl.purchase_id WHERE p.supplier_id != 'sup-1' ORDER BY pl.line_total, pl.product_id`)[0]?.values ?? []).map((r) => [name(r[0]), ...r.slice(1)]);
  const kons = (db.exec(`SELECT product_id, status, ROUND(sale_price,3), ROUND(commission_amount,3), ROUND(payout_amount,3), buyer_id, invoice_id = ? FROM consignments ORDER BY consignment_number`, [invoiceId])[0]?.values ?? [])
    .map((r) => [name(r[0]), ...r.slice(1)]);
  const konten = all(db, `SELECT account, ROUND(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 3) AS net FROM ledger_entries GROUP BY account HAVING ABS(net) > 0.0005 ORDER BY account`);
  const bestand = all(db, "SELECT p.name, p.quantity, p.stock_status FROM products p ORDER BY p.name");
  return { kopf, zeilen, einkaeufe, elines, kons, konten, bestand };
}
function balanced(db: Db): boolean {
  const t = db.exec(`SELECT transaction_id, SUM(CASE WHEN direction = 'DEBIT' THEN CAST(ROUND(amount * 1000) AS INTEGER) ELSE 0 END),
      SUM(CASE WHEN direction = 'CREDIT' THEN CAST(ROUND(amount * 1000) AS INTEGER) ELSE 0 END) FROM ledger_entries GROUP BY transaction_id`)[0]?.values ?? [];
  return t.length > 0 && t.every((r) => Number(r[1]) === Number(r[2]));
}
/** Lager im Hauptbuch == Wert der aktiven Lose; AP == offene Einkäufe + offene Ausgaben; AR == offene Rechnungen; ausgeglichen. */
function abgleich(db: Db): string[] {
  const k = Object.fromEntries((db.exec(`SELECT account, ROUND(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 3) FROM ledger_entries GROUP BY account`)[0]?.values ?? [])
    .map((r) => [String(r[0]), Number(r[1])]));
  const lose = n(db, "SELECT COALESCE(ROUND(SUM(qty_remaining * unit_cost), 3), 0) FROM stock_lots WHERE status = 'ACTIVE'");
  const ap = n(db, `SELECT ROUND(COALESCE((SELECT SUM(remaining_amount) FROM purchases WHERE status NOT IN ('CANCELLED','DRAFT')), 0)
    + COALESCE((SELECT SUM(amount - paid_amount) FROM expenses WHERE status != 'CANCELLED' AND supplier_id IS NOT NULL), 0), 3)`);
  const ar = n(db, "SELECT COALESCE(ROUND(SUM(gross_amount - paid_amount), 3), 0) FROM invoices WHERE status != 'CANCELLED'");
  const out: string[] = [];
  if (!balanced(db)) out.push('unbalanced');
  if (Math.abs((k.INVENTORY ?? 0) - lose) > 0.005) out.push(`INVENTORY ${k.INVENTORY ?? 0} vs lots ${lose}`);
  if (Math.abs(-(k.ACCOUNTS_PAYABLE ?? 0) - ap) > 0.005) out.push(`AP ${-(k.ACCOUNTS_PAYABLE ?? 0)} vs domain ${ap}`);
  if (Math.abs((k.ACCOUNTS_RECEIVABLE ?? 0) - ar) > 0.005) out.push(`AR ${k.ACCOUNTS_RECEIVABLE ?? 0} vs invoices ${ar}`);
  return out;
}
const invVon = (r: Ausgang): string => String(r.value.invoiceId ?? '');

// ══ §1 / §2 — Abnahme 1 und 6: eine gemischte Rechnung, Primary == PC2 ══════════════════════════════════════
const bilder: Record<string, unknown>[] = [];
for (const weg of ['primary', 'pc2'] as const) {
  const w = await welt();
  const vorherLose = all(w.db, 'SELECT product_id, qty_remaining FROM stock_lots ORDER BY product_id');
  const r = weg === 'primary' ? await amPrimary(w) : await amPC2(w);
  reload();
  const inv = invVon(r);
  ok(r.ok && inv !== '', `§1 ${weg}: die gemischte Rechnung wird angelegt (${r.code})`);
  if (!r.ok) continue;
  const b = bild(w.db, inv);
  bilder.push(b);
  const zeilen = b.zeilen as unknown[][];
  ok(n(w.db, 'SELECT COUNT(*) FROM invoices') === 1 && zeilen.length === 5,
    `§1 ${weg}: EINE Rechnung mit 5 Zeilen (2 eigene + 3 Kommission) (${n(w.db, 'SELECT COUNT(*) FROM invoices')}/${zeilen.length})`);
  ok(S(zeilen.map((z) => z[0])) === S(['Datejust eigen', 'Goldkette eigen', 'Nautilus', 'Aquanaut', 'Calatrava']),
    `§1 ${weg}: Reihenfolge eigene Zeilen, dann Kommission in Auswahlreihenfolge (${S(zeilen.map((z) => z[0]))})`);
  // Eigene Zeilen: Einstand aus dem Los (2000 bzw. 500 netto), Steuer je Zeile.
  ok(S(zeilen[0]) === S(['Datejust eigen', 1, 2500, 2000, 'MARGIN', 45.455, 2500, 1]) && S(zeilen[1]) === S(['Goldkette eigen', 1, 600, 500, 'VAT_10', 60, 660, 1]),
    `§1 ${weg}: eigene Zeilen mit Los-Einstand und eigener Steuer (${S(zeilen[0])} ${S(zeilen[1])})`);
  // Kommissionszeilen: Steuer je Zeile, Brutto = Verkaufspreis, Einstand = Auszahlung (Los des Auto-Einkaufs).
  const kom = zeilen.slice(2).map((z) => [z[4], z[6], z[3]]);
  ok(S(kom) === S([['MARGIN', 1200, 960], ['VAT_10', 1100, 880], ['ZERO', 1050, 909.091]]),
    `§1 ${weg}: Kommissionszeilen MARGIN/VAT 10 %/Zero, Brutto = Preis, Einstand = Auszahlung (bei Einlieferer-VAT 10 % netto) (${S(kom)})`);
  const kopf = b.kopf as unknown[];
  ok(Number(kopf[4]) === 6510 && kopf[6] === 'mixed' && kopf[7] === 'Lieferung Freitag' && kopf[0] === 'cust-2',
    `§1 ${weg}: Summe 6.510 BHD, Kopf „mixed", Notiz der Maske, Käufer (${S(kopf)})`);
  // Einlieferer: je Einlieferer EIN Einkauf (cust-1: 960 + 880, cust-3: 1000 mit VAT 10 %), unbezahlt.
  const ek = b.einkaeufe as unknown[][];
  ok(ek.length === 2 && Number(ek[0][1]) === 1000 && Number(ek[1][1]) === 1840 && ek.every((e) => Number(e[2]) === Number(e[1]) && e[4] === HEUTE),
    `§1 ${weg}: 2 Einkäufe (1.000 Sara mit VAT, 1.840 Ali), unbezahlt, auf das Rechnungsdatum (${S(ek)})`);
  ok(S((b.elines as unknown[][]).map((l) => [l[0], l[2], l[3], l[4]])) === S([['Aquanaut', 'ZERO', 0, 880], ['Nautilus', 'ZERO', 0, 960], ['Calatrava', 'VAT_10', 90.909, 1000]]),
    `§1 ${weg}: Einkaufszeilen je Kommission mit der gewählten Einkaufs-VAT (${S(b.elines)})`);
  ok((b.kons as unknown[][]).every((k) => k[1] === 'sold' && k[5] === 'cust-2' && Number(k[6]) === 1),
    `§1 ${weg}: alle 3 Kommissionen sold, Käufer und Rechnung verknüpft (${S(b.kons)})`);
  // §2 Lager je Artikel genau −1.
  const nachLose = all(w.db, 'SELECT product_id, qty_remaining FROM stock_lots ORDER BY product_id');
  const own1 = n(w.db, "SELECT SUM(qty_remaining) FROM stock_lots WHERE product_id = 'own-1'");
  const own2 = n(w.db, "SELECT SUM(qty_remaining) FROM stock_lots WHERE product_id = 'own-2'");
  const konsLose = n(w.db, `SELECT COUNT(*) FROM stock_lots sl JOIN consignments c ON c.product_id = sl.product_id WHERE sl.qty_remaining = 0`);
  const konsMenge = all(w.db, 'SELECT p.quantity FROM products p JOIN consignments c ON c.product_id = p.id ORDER BY c.consignment_number');
  ok(own1 === 0 && own2 === 1 && konsLose === 3 && konsMenge === '[[0],[0],[0]]' && n(w.db, "SELECT quantity FROM products WHERE id = 'own-2'") === 1,
    `§2 ${weg}: Lager je Artikel genau −1 (eigen 1→0, 2→1; Kommission Los 1→0, Menge 0, kein Doppelabzug) (${vorherLose} → ${nachLose}; ${konsMenge})`);
  // §2 Hauptbuch je Quelle einmal: die Rechnung EIN Buchungssatz, jeder Einkauf EINER.
  const proQuelle = all(w.db, `SELECT source_module, COUNT(DISTINCT transaction_id) FROM ledger_entries
     WHERE source_id = ? OR source_id IN (SELECT id FROM purchases WHERE supplier_id != 'sup-1') GROUP BY source_module ORDER BY source_module`, [inv]);
  ok(proQuelle === '[["INVOICE",1],["PURCHASE",2]]', `§2 ${weg}: Hauptbuch je Quelle einmal (Rechnung 1, Einkäufe je 1) (${proQuelle})`);
  const fehler = abgleich(w.db);
  ok(fehler.length === 0, `§2 ${weg}: Abgleich Lager/AP/AR/ausgeglichen ohne Abweichung (${fehler.join('; ')})`);
  const audit = s(w.db, "SELECT new_value FROM audit_log WHERE field_name = 'mixed_invoice' AND entity_id = ?", [inv]);
  ok(/"ownLines":2/.test(audit) && /"role":"ADMIN"/.test(audit) && (JSON.parse(audit || '{}').purchases ?? []).length === 2
    && s(w.db, "SELECT changed_by FROM audit_log WHERE field_name = 'mixed_invoice'") === (weg === 'pc2' ? 'user-pc2' : 'user-test'),
    `§2 ${weg}: Audit der gemischten Rechnung (eigene Zeilen, Kommissionen, Einkäufe, Rolle, Handelnder) (${audit})`);
  // E7-Grundlage: VAT 10 % auf K2 (Provision 220, VAT 100) ist positiv — keine Bestätigung nötig.
  ok(mixedMod.consignmentVatShortfall(computeConsignmentSale({ commissionType: 'percent', commissionRate: 20, agreedPrice: 1000 } as never, 1100), 'VAT_10', 100) === null,
    `§1 ${weg}: Aquanaut VAT 10 % mit 20 % Provision: LATAIF-Ergebnis 120 ≥ 0, keine E7-Bestätigung`);
}
if (bilder.length === 2) {
  const [a, b] = bilder;
  const diff = Object.keys(a).filter((k) => S(a[k]) !== S(b[k])).map((k) => `${k}: ${S(a[k]).slice(0, 300)} vs ${S(b[k]).slice(0, 300)}`);
  ok(diff.length === 0, `§1 Primary und PC2 buchen GLEICH (Kopf, Zeilen, Einkäufe, Kommissionen, Konten, Bestand) (${diff.join(' | ')})`);
}

// ══ §3 — Abnahme 2: nur ADMIN/MANAGER ═══════════════════════════════════════════════════════════════════════
for (const role of ['SALES', 'ACCOUNTANT'] as const) {
  const w = await welt();
  const vorher = zaehler(w.db);
  sitzung(role);
  const p = await amPrimary(w);
  sitzung('ADMIN');
  const f = await amPC2(w, {}, role);
  ok(!p.ok && p.code === 'MIXED_INVOICE_NOT_PERMITTED' && !f.ok && f.code === 'MIXED_INVOICE_NOT_PERMITTED' && zaehler(w.db) === vorher,
    `§3 ${role}: Primary und PC2-Haus sagen Nein (${p.code}/${f.code}), nichts gebucht`);
  ok(perms.roleMayRunOp(role, 'consignments.record_sale') === false, `§3 ${role}: der zentrale Rechte-Wächter lässt den PC2-Befehl gar nicht laufen`);
}
{
  const w = await welt();
  sitzung('MANAGER');
  const p = await amPrimary(w);
  sitzung('ADMIN');
  ok(p.ok && perms.roleMayRunOp('MANAGER', 'consignments.record_sale'), `§3 MANAGER darf anlegen (Primary ${p.code || 'ok'}, PC2-Recht)`);
  const w2 = await welt();
  const f = await amPC2(w2, {}, 'MANAGER');
  ok(f.ok, `§3 MANAGER am PC2: angelegt (${f.code || 'ok'})`);
}

// ══ §4 — Abnahme 3: E7 ═══════════════════════════════════════════════════════════════════════════════════════
{
  // Calatrava (Agreed 1000, Agreed + Excess) für 1.050 mit VAT 10 %: Provision 50, VAT 95,455 ⇒ LATAIF −45,455.
  const e7Items = (w: Welt, ack: boolean): Item[] => [
    { consignmentId: w.k3, salePrice: 1050, acknowledgeShortfall: false, taxScheme: 'VAT_10', consignorTaxScheme: 'ZERO', ...(ack ? { acknowledgeVatShortfall: true } : {}) },
  ];
  const vatK3 = mixedMod.consignmentLineAmounts(1050, 'VAT_10', 1000).persistedVat;
  ok(mixedMod.consignmentVatShortfall(computeConsignmentSale({ commissionType: 'consignor_fixed', agreedPrice: 1000 } as never, 1050), 'VAT_10', vatK3) === -45.455,
    `§4 E7-Regel: 1.050 mit VAT 10 % bei Agreed 1.000 ⇒ LATAIF −45,455 (VAT ${vatK3})`);
  ok(mixedMod.consignmentVatShortfall(computeConsignmentSale({ commissionType: 'consignor_fixed', agreedPrice: 1000 } as never, 1050), 'MARGIN', 4.545) === null
    && mixedMod.consignmentVatShortfall(computeConsignmentSale({ commissionType: 'consignor_fixed', agreedPrice: 1000 } as never, 900), 'VAT_10', 81.818) === null,
    '§4 E7 nur bei VAT 10 % und nicht unter dem Boden (Unterdeckung bestätigt der Verlust-Haken)');
  for (const weg of ['primary', 'pc2'] as const) {
    const w = await welt();
    const vorher = zaehler(w.db);
    const ohne = weg === 'primary' ? await amPrimary(w, { items: e7Items(w, false) }) : await amPC2(w, { items: e7Items(w, false) });
    ok(!ohne.ok && ohne.code === 'VAT_SHORTFALL_UNCONFIRMED' && zaehler(w.db) === vorher,
      `§4 ${weg}: E7 ohne Bestätigung ⇒ Nein (${ohne.code}), nichts gebucht`);
    const mit = weg === 'primary' ? await amPrimary(w, { items: e7Items(w, true) }) : await amPC2(w, { items: e7Items(w, true) });
    reload();
    ok(mit.ok && n(w.db, 'SELECT COUNT(*) FROM invoices') === 1 && s(w.db, 'SELECT status FROM consignments WHERE id = ?', [w.k3]) === 'sold',
      `§4 ${weg}: E7 mit Bestätigung ⇒ gebucht (${mit.code || 'ok'})`);
  }
  // „Record Sale" (ohne eigene Zeilen, alter Weg) fragt NICHT nach E7 — dessen Änderung wäre eine eigene Freigabe.
  const w = await welt();
  setTestDatabase(w.db as never); reload();
  const alt = await primary(() => conHouse.recordConsignmentSalesOnPrimary({ items: [{ consignmentId: w.k3, salePrice: 1050, acknowledgeShortfall: false, taxScheme: 'VAT_10', consignorTaxScheme: 'ZERO' }],
    buyerId: 'cust-2', specialMark: false }));
  ok(alt.ok, `§4 „Record Sale" bleibt unverändert: bucht ohne E7-Bestätigung (${alt.code || 'ok'})`);
  ok((() => {
    try { life.parseRecordSale({ items: [{ consignmentId: 'c', expectedRevision: 1, salePrice: 1, acknowledgeVatShortfall: true }], buyerId: 'b' }); return false; } catch { return true; }
  })(), '§4 ohne `ownLines` nimmt der Rumpf keine E7-Bestätigung an (unbekanntes Feld)');
}

// ══ §5 — Abnahme 4: Fehler ⇒ nichts gebucht ═══════════════════════════════════════════════════════════════════
function faulty(db: Db, when: (sql: string, p?: unknown[]) => boolean) {
  const f = { armed: true, fired: false };
  const proxy = new Proxy(db as object, {
    get(t, k) {
      if (k === 'run') return (sql: string, p?: unknown[]) => { if (f.armed && when(sql, p)) { f.fired = true; throw new Error('P3: injected failure'); } return (t as Db).run(sql, p); };
      const v = (t as Record<string | symbol, unknown>)[k];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  }) as unknown as Db;
  return { db: proxy, f };
}
for (const [wo, wann] of [
  // Der Einkauf des ZWEITEN Einlieferers (sein Kopf ist der zweite Einkauf dieses Verkaufs).
  ['im zweiten Einlieferer-Einkauf', (() => { let z = 0; return (sql: string) => /INSERT INTO purchases \(/i.test(sql) && ++z === 2; })()],
  // Ganz am Ende: das Audit der gemischten Rechnung — Rechnung, Einkäufe, Zahlung, Kommissionen stehen da schon.
  ['im Audit nach Rechnung, Einkäufen und Zahlung', (sql: string, p?: unknown[]) => /INSERT INTO audit_log/i.test(sql) && Array.isArray(p) && p.includes('mixed_invoice')],
] as Array<[string, (sql: string, p?: unknown[]) => boolean]>) {
  const w = await welt();
  const vorher = zaehler(w.db);
  const { db: kaputt, f } = faulty(w.db, wann);
  setTestDatabase(kaputt as never); reload();
  const ownLines = [eigeneZeile(w.db, 'own-1', 'MARGIN', 2500), eigeneZeile(w.db, 'own-2', 'VAT_10', 600)];
  const r = await primary(() => conHouse.createMixedInvoiceOnPrimary({ customerId: 'cust-2', ownLines, items: standardItems(w), issuedDate: HEUTE, specialMark: false,
    payments: [{ amount: 1000, method: 'cash' }] }));
  f.armed = false;
  setTestDatabase(w.db as never); reload();
  ok(f.fired && !r.ok && zaehler(w.db) === vorher && n(w.db, 'SELECT COUNT(*) FROM invoices') === 0,
    `§5 Fehler ${wo} ⇒ nichts gebucht: keine Rechnung, kein Einkauf, keine Zahlung, Lose und Kommissionen unverändert (${r.code.slice(0, 80)})`);
  const heil = await amPrimary(w);
  ok(heil.ok, `§5 …danach geht derselbe Verkauf sauber (${heil.code || 'ok'})`);
}

// ══ §6 — Abnahme 5: Wiederholung und veraltete Fassung ═════════════════════════════════════════════════════════
{
  const w = await welt();
  const body = rumpf(w);
  setTestDatabase(w.db as never); reload();
  const x = ident('consignments.record_sale');
  const r1 = await fern(() => life.runRecordSale(deps(w.db), x as never, body));
  const nach1 = zaehler(w.db);
  const r2 = await fern(() => life.runRecordSale(deps(w.db), x as never, body));
  ok(r1.ok && r2.ok && r2.replayed && zaehler(w.db) === nach1 && n(w.db, 'SELECT COUNT(*) FROM invoices') === 1 && invVon(r1) === invVon(r2),
    `§6 derselbe PC2-Befehl zweimal ⇒ einmal gebucht, Wiederholung liefert dasselbe Ergebnis (replayed ${r2.replayed})`);
  // Eine Kommission hat sich seit dem Laden geändert (andere Fassung) ⇒ Nein, nichts gebucht.
  const w2 = await welt();
  const alt = rumpf(w2);
  w2.db.run('UPDATE consignments SET revision = revision + 1 WHERE id = ?', [w2.k2]);
  const vorher = zaehler(w2.db);
  setTestDatabase(w2.db as never); reload();
  const r3 = await fern(() => life.runRecordSale(deps(w2.db), ident('consignments.record_sale') as never, alt));
  ok(!r3.ok && /CHANGED|STALE|REVISION/i.test(r3.code) && zaehler(w2.db) === vorher, `§6 veraltete Fassung einer Kommission ⇒ Nein (${r3.code}), nichts gebucht`);
  // Ein zweiter Verkauf derselben Kommission (schon verkauft) ⇒ Nein.
  const r4 = await amPC2(w, { ownLines: 'none' });
  ok(!r4.ok && /NOT_ACTIVE|ALREADY_SOLD|CHANGED/.test(r4.code) && n(w.db, 'SELECT COUNT(*) FROM invoices') === 1, `§6 dieselben Kommissionen noch einmal ⇒ Nein (${r4.code})`);
}

// ══ §7 — Zahlungen über die vorhandenen Rechnungswege ══════════════════════════════════════════════════════════
{
  // Teilzahlung beim Anlegen.
  const w = await welt();
  const r = await amPrimary(w, { payments: [{ amount: 1000, method: 'cash' }] });
  reload();
  const inv = invVon(r);
  ok(r.ok && s(w.db, 'SELECT status FROM invoices WHERE id = ?', [inv]) === 'PARTIAL' && n(w.db, 'SELECT paid_amount FROM invoices WHERE id = ?', [inv]) === 1000
    && /^PINV/.test(s(w.db, 'SELECT invoice_number FROM invoices WHERE id = ?', [inv])),
    `§7 Teilzahlung 1.000: PINV, PARTIAL, bezahlt 1.000 (${s(w.db, 'SELECT invoice_number || " " || status FROM invoices WHERE id = ?', [inv])})`);
  const reserviert = all(w.db, "SELECT p.stock_status FROM products p JOIN consignments c ON c.product_id = p.id ORDER BY c.consignment_number");
  ok(/reserved/.test(reserviert) && abgleich(w.db).length === 0, `§7 Teilzahlung: Kommissionsartikel reserviert, Abgleich ohne Abweichung (${reserviert}; ${abgleich(w.db).join('; ')})`);
  // Restzahlung über den normalen Zahlungsweg der Rechnung ⇒ voll bezahlt, Endnummer, Artikel verkauft.
  imHaus(() => useInvoiceStore.getState().recordPayment(inv, 5510, 'bank_transfer'));
  reload();
  ok(s(w.db, 'SELECT status FROM invoices WHERE id = ?', [inv]) === 'FINAL' && n(w.db, 'SELECT paid_amount FROM invoices WHERE id = ?', [inv]) === 6510
    && !/^PINV/.test(s(w.db, 'SELECT invoice_number FROM invoices WHERE id = ?', [inv])),
    `§7 Restzahlung 5.510 über „Record Payment": FINAL, Endnummer (${s(w.db, 'SELECT invoice_number || " " || status FROM invoices WHERE id = ?', [inv])})`);
  const verkauft = all(w.db, "SELECT p.stock_status FROM products p WHERE p.id IN ('own-1') OR p.id IN (SELECT product_id FROM consignments) ORDER BY p.name");
  ok(!/reserved|consignment"/.test(verkauft) && /sold/.test(verkauft) && abgleich(w.db).length === 0, `§7 nach Vollzahlung: verkauft, Abgleich ohne Abweichung (${verkauft})`);
  // Vollzahlung beim Anlegen (zwei Wege), PC2.
  const w2 = await welt();
  const r2 = await amPC2(w2, { payments: [{ amount: 4000, method: 'cash' }, { amount: 2510, method: 'bank_transfer' }] });
  reload();
  const inv2 = invVon(r2);
  ok(r2.ok && s(w2.db, 'SELECT status FROM invoices WHERE id = ?', [inv2]) === 'FINAL' && n(w2.db, 'SELECT COUNT(*) FROM payments WHERE invoice_id = ?', [inv2]) === 2
    && abgleich(w2.db).length === 0,
    `§7 PC2 Vollzahlung beim Anlegen (Cash + Bank): FINAL, 2 Zahlungen, Abgleich ohne Abweichung (${r2.code || 'ok'} ${abgleich(w2.db).join('; ')})`);
}

// ══ §8 — Sperren: je ein Nein, nichts gebucht ══════════════════════════════════════════════════════════════════
{
  const pruefe = async (was: string, erwartet: RegExp, vorbereiten: (w: Welt) => Opt | Promise<Opt>, wege: Array<'primary' | 'pc2'> = ['primary', 'pc2']): Promise<void> => {
    for (const weg of wege) {
      const w = await welt();
      const o = await vorbereiten(w);
      const vorher = zaehler(w.db);
      const r = weg === 'primary' ? await amPrimary(w, o) : await amPC2(w, o);
      ok(!r.ok && erwartet.test(r.code) && zaehler(w.db) === vorher, `§8 ${weg} ${was} ⇒ Nein (${r.code}), nichts gebucht`);
    }
  };
  await pruefe('zugemachtes VAT-Quartal (Q3 2026 eingereicht)', /VAT|PERIOD|FILED|QUARTER/i, (w) => {
    w.db.run("UPDATE consignments SET agreement_date = '2026-08-01'");
    insert(w.db, 'vat_filings', { id: 'vf-1', branch_id: 'branch-main', year: 2026, quarter: 3, filed_at: NOW, snapshot_json: '{}', created_at: NOW });
    return { issuedDate: '2026-09-20' };
  });
  await pruefe('Rechnungsdatum vor der Einlieferung (E3)', /SALE_BEFORE_CONSIGNMENT/, (w) => {
    w.db.run("UPDATE consignments SET agreement_date = ? WHERE id = ?", [HEUTE, w.k2]);
    return { issuedDate: '2026-11-01' };
  });
  await pruefe('Käufer ist Einlieferer', /BUYER_IS_CONSIGNOR/, () => ({ customerId: 'cust-3' }));
  await pruefe('unter dem Boden ohne Bestätigung', /SALE_BELOW_FLOOR/, (w) => ({ items: [{ consignmentId: w.k3, salePrice: 900, acknowledgeShortfall: false, taxScheme: 'ZERO', consignorTaxScheme: 'ZERO' }] }));
  await pruefe('ohne Einkaufs-VAT des Einlieferers', /CONSIGNOR_VAT_REQUIRED/, (w) => ({ items: [{ consignmentId: w.k1, salePrice: 1200, acknowledgeShortfall: false, taxScheme: 'MARGIN' }] }));
  await pruefe('ohne Kommissionsartikel', /MIXED_INVOICE_NEEDS_CONSIGNMENT|items must be a non-empty list|INVALID/, () => ({ items: [] }), ['primary']);
  await pruefe('Überzahlung beim Anlegen', /PAYMENT_EXCEEDS_TOTAL/, () => ({ payments: [{ amount: 7000, method: 'cash' }] }));
  // Eigene Zeile mit Kommissionsware (auch derselbe Artikel wie ein Kommissionsartikel) ⇒ Nein.
  for (const weg of ['primary', 'pc2'] as const) {
    const w = await welt();
    const kp = s(w.db, 'SELECT product_id FROM consignments WHERE id = ?', [w.k1]);
    const vorher = zaehler(w.db);
    setTestDatabase(w.db as never); reload();
    const r = weg === 'primary'
      ? await primary(() => conHouse.createMixedInvoiceOnPrimary({ customerId: 'cust-2', ownLines: [toInvoiceLine({ productId: kp, lotId: null, quantity: 1, unitPrice: 1200, costBasis: 0, scheme: 'MARGIN' }) as Line],
        items: [standardItems(w)[0]], issuedDate: HEUTE, specialMark: false }))
      : await fern(() => life.runRecordSale(deps(w.db), ident('consignments.record_sale') as never, mixedMod.mixedInvoiceBody({ customerId: 'cust-2', items: [standardItems(w)[0]], issuedDate: HEUTE, specialMark: false },
        [{ productId: kp, quantity: 1, unitPrice: 1200, scheme: 'MARGIN' }], { [w.k1]: conRev(w.db, w.k1) })));
    ok(!r.ok && r.code === 'OWN_LINE_IS_CONSIGNMENT' && zaehler(w.db) === vorher, `§8 ${weg} eigene Zeile mit Kommissionsware ⇒ Nein (${r.code}), nichts gebucht`);
  }
  // Eigenes Stück nicht mehr auf Lager (Los leer) ⇒ Nein.
  for (const weg of ['primary', 'pc2'] as const) {
    const w = await welt();
    w.db.run("UPDATE stock_lots SET qty_remaining = 0 WHERE product_id = 'own-1'");
    const vorher = zaehler(w.db);
    const r = weg === 'primary' ? await amPrimary(w) : await amPC2(w);
    ok(!r.ok && zaehler(w.db) === vorher && n(w.db, 'SELECT COUNT(*) FROM invoices') === 0, `§8 ${weg} eigenes Stück nicht mehr auf Lager ⇒ Nein (${r.code.slice(0, 60)}), nichts gebucht`);
  }
}

// ══ §9 — bestehende Wege unverändert; Rumpfgrenzen ═════════════════════════════════════════════════════════════
{
  // Reine Kommission über „Record Sale": Notiz wie bisher, Mengenregel wie bisher, kein Audit der gemischten Rechnung.
  const w = await welt();
  setTestDatabase(w.db as never); reload();
  const r = await primary(() => conHouse.recordConsignmentSalesOnPrimary({ items: [{ consignmentId: w.k1, salePrice: 1200, acknowledgeShortfall: false, consignorTaxScheme: 'ZERO' }],
    buyerId: 'cust-2', notes: 'x', specialMark: false }));
  reload();
  const inv = invVon(r);
  ok(r.ok && /^Consignment sale · /.test(s(w.db, 'SELECT notes FROM invoices WHERE id = ?', [inv])) && n(w.db, 'SELECT COUNT(*) FROM invoice_lines WHERE invoice_id = ?', [inv]) === 1
    && n(w.db, "SELECT COUNT(*) FROM audit_log WHERE field_name = 'mixed_invoice'") === 0,
    `§9 „Record Sale" (reine Kommission) unverändert: Notiz „Consignment sale · …", eine Zeile, kein Mixed-Audit (${s(w.db, 'SELECT notes FROM invoices WHERE id = ?', [inv])})`);
  // Reine Eigenware über „Save Invoice" (Primary + PC2) — Kommissionsware bleibt dort gesperrt.
  const w2 = await welt();
  setTestDatabase(w2.db as never); reload();
  const e = await primary(() => createInvoiceOnPrimary({ customerId: 'cust-2', lines: [eigeneZeile(w2.db, 'own-1', 'MARGIN', 2500)], specialMark: false }));
  const kp = s(w2.db, 'SELECT product_id FROM consignments WHERE id = ?', [w2.k1]);
  const g = await fern(() => runInvoiceCreate(deps(w2.db), ident('invoices.create') as never, { customerId: 'cust-2', lines: [{ productId: kp, unitPrice: 1200, scheme: 'MARGIN' }], specialMark: false }));
  ok(e.ok && !g.ok && /CONSIGNMENT/.test(g.code), `§9 „Save Invoice" unverändert: Eigenware ok, Kommissionsware dort weiter gesperrt (${g.code})`);
  // Rumpfgrenzen: verbotene Felder in eigenen Zeilen, Mitarbeiter/E7 nur mit `ownLines`, Einzelrumpf ohne `ownLines`.
  const fehlerVon = (raw: unknown): string => { try { life.parseRecordSale(raw); return ''; } catch (x) { return (x as Error).message; } };
  const basis = { items: [{ consignmentId: 'c', expectedRevision: 1, salePrice: 1 }], buyerId: 'b' };
  ok(/purchasePrice/.test(fehlerVon({ ...basis, ownLines: [{ productId: 'p', unitPrice: 1, purchasePrice: 0 }] }))
    && /staffId/.test(fehlerVon({ ...basis, staffId: 's' }))
    && /ownLines/.test(fehlerVon({ consignmentId: 'c', expectedRevision: 1, salePrice: 1, buyerId: 'b', ownLines: [] }))
    && fehlerVon({ ...basis, ownLines: [], staffId: 's' }) === '',
    '§9 Rumpf: eigene Zeilen streng wie invoices.create (kein Einstand vom Client), Mitarbeiter nur mit ownLines, Einzelrumpf ohne ownLines');
  const geprueft = life.parseRecordSale({ ...basis, ownLines: [{ productId: 'p', unitPrice: 5, quantity: 2, scheme: 'auto' }], staffId: 's' });
  ok(geprueft.ownLines?.length === 1 && geprueft.ownLines[0].quantity === 2 && geprueft.staffId === 's', '§9 Rumpf: ownLines und staffId werden übernommen');
}
// Quelltext: die Maske nutzt dieselbe Rechnung der Kommissionszeile und schickt den gemischten Rumpf.
{
  const maske = src('src/pages/invoices/InvoiceCreate.tsx') + src('src/components/invoices/ConsignmentInvoiceLines.tsx');
  ok(/createMixedInvoiceOnPrimary/.test(maske) && /mixedInvoiceBody/.test(maske) && /consignmentLineAmounts/.test(maske) && /consignmentVatShortfall/.test(maske)
    && /useSharedWrite<[^>]*>\('consignments\.record_sale'\)/.test(maske),
    '§9 Maske: Primary über createMixedInvoiceOnPrimary, PC2 über consignments.record_sale mit mixedInvoiceBody; dieselbe Zeilen- und E7-Rechnung');
  ok(/isAdmin/.test(maske), '§9 Maske: Kommissionsartikel nur für ADMIN/MANAGER (isAdmin)');
}

console.log(fails.length ? `\nFAIL — P3 mixed invoice create: ${PASS} passed, ${fails.length} failed` : `\nPASS — P3 mixed invoice create: ${PASS} passed, 0 failed`);
if (fails.length) process.exit(1);
