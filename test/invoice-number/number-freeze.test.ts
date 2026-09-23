// ════════════════════════════════════════════════════════════════════════════
// INVOICE-NUMBER-FREEZE (S1) — eine Endnummer wird genau EINMAL vergeben, an echten Zeilen einer
// echten sql.js-Datenbank (schema.sql + echte Migrationen, Harness wie stock-lot-integrity).
// Run: node --experimental-strip-types test/invoice-number/number-freeze.test.ts
//
//   A1–A5  FINAL → Preiserhöhung → PARTIAL → Restzahlung; Zahlung ändern/löschen; Reduzierung
//   A6/A7  Sonder-Kreis (SINV) und Reparatur-Kreis (RINV) bleiben fest
//   A8     FINAL ohne Zahlungsvorgang (Edit / Zahlung ändern) bekommt die Endnummer genau einmal
//   A9/A10 Nummer und Sonder-Kennzeichen nicht mehr frei setzbar
//   A11    Rollback verbrennt keine Nummer
//   A12    Aufstieg alter Daten (Protokoll, FINAL, vorläufige und umbenannte Kreise)
//   A13    Anzeige-Regel; Q Quelltext: genau eine Vergabestelle
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
// Der echte invoice.paid-Handler (registriert sich beim Laden des Moduls).
await import('../../src/core/automation/automation-handlers.ts');
const { eventBus } = await import('../../src/core/events/event-bus.ts');
const { useInvoiceStore } = await import('../../src/stores/invoiceStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { useCustomerStore } = await import('../../src/stores/customerStore.ts');
const { useSupplierStore } = await import('../../src/stores/supplierStore.ts');
const { useSalesReturnStore } = await import('../../src/stores/salesReturnStore.ts');
const { useCreditNoteStore } = await import('../../src/stores/creditNoteStore.ts');
const { useAgentStore } = await import('../../src/stores/agentStore.ts');
const { useConsignmentStore } = await import('../../src/stores/consignmentStore.ts');
const { useProductionStore } = await import('../../src/stores/productionStore.ts');
const { useAuthStore } = await import('../../src/stores/authStore.ts');
const cancelReturnHouse = await import('../../src/core/returns/return-cancel-house.ts');
const { cancelInvoiceInHouse } = await import('../../src/core/invoices/invoice-cancel-house.ts');
const { convertTransferInHouse, undoTransferConversionInHouse } = await import('../../src/core/agents/transfer-house.ts');
const { createProductionInHouse } = await import('../../src/core/production/production-house.ts');
const { STOCK_UNAVAILABLE_MESSAGE } = await import('../../src/core/lots/lot-availability.ts');
const { classifyLegacyInvoiceLines, LEGACY_STOCK_LINES_MESSAGE } = await import('../../src/core/lots/stock-contract.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const S = (v: unknown): string => JSON.stringify(v);
const NOW = '2026-09-21T10:00:00.000Z';

interface Db {
  run(sql: string, p?: unknown[]): unknown;
  exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
}
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const n = (db: Db, sql: string, p: unknown[] = []): number => Number(one(db, sql, p) ?? 0);
const s = (db: Db, sql: string, p: unknown[] = []): string => String(one(db, sql, p) ?? '');
const all = (db: Db, sql: string, p: unknown[] = []): string => JSON.stringify(db.exec(sql, p)[0]?.values ?? []);

function realMigrations(): string[] {
  const dbSrc = src('src/core/db/database.ts');
  const start = dbSrc.indexOf('const migrations: string[] = [');
  const end = dbSrc.indexOf('\n  ];', start);
  return [...dbSrc.slice(start, end).matchAll(/`([^`]*)`/g)].map((m) => m[1]);
}
const MIGRATIONS = realMigrations();

function insert(db: Db, table: string, values: Record<string, unknown>): void {
  const info = db.exec(`PRAGMA table_info(${table})`)[0];
  const cols = info.values.map((v) => ({
    name: String(v[1]), type: String(v[2] ?? ''), notnull: Number(v[3]) === 1, dflt: v[4], pk: Number(v[5]) > 0,
  }));
  const data: Record<string, unknown> = { ...values };
  for (const c of cols) {
    if (!c.notnull || c.dflt !== null || c.pk || data[c.name] !== undefined) continue;
    data[c.name] = /INT|REAL|NUM/i.test(c.type) ? 0 : (/_at$|date/i.test(c.name) ? NOW : '');
  }
  const names = Object.keys(data).filter((k) => cols.some((c) => c.name === k));
  db.run(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`, names.map((k) => data[k]));
}

function reload(): void {
  useProductStore.getState().loadProducts();
  useCustomerStore.getState().loadCustomers();
  useSupplierStore.getState().loadSuppliers();
  useInvoiceStore.getState().loadInvoices();
  useSalesReturnStore.getState().loadReturns();
  useCreditNoteStore.getState().loadCreditNotes();
  useAgentStore.getState().loadAgents();
  useAgentStore.getState().loadTransfers();
}

/** Artikel: `lotQty` = Einkaufslos mit dieser Menge; null = ohne Los, Menge `manualQty`. */
function product(db: Db, id: string, lotQty: number | null, manualQty = 0, extra: { status?: string; source?: string } = {}): void {
  db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
      scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
      tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
    VALUES (?,'branch-main','cat-w','Rolex',?,?,?,'Pre-Owned','[]',100,'BHD',150,?,'VAT_10',0,'[]','{}',?,?,?)`,
  [id, 'M ' + id, 'SKU-' + id, lotQty ?? manualQty, extra.status ?? 'in_stock', extra.source ?? 'OWN', NOW, NOW]);
  if (lotQty !== null) {
    db.run(`INSERT INTO stock_lots (id, branch_id, product_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
      VALUES (?,'branch-main',?,100,?,?,'ACTIVE',?,?)`, ['lot-' + id, id, lotQty, lotQty, NOW, NOW]);
  }
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
  for (const [id, first] of [['cust-1', 'Ali'], ['cust-2', 'Nora']]) {
    db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level,
        preferences, customer_type, sales_stage, created_at, updated_at)
      VALUES (?,'branch-main',?,'Hassan','BH','en',0,'[]','collector','active',?,?)`, [id, first, NOW, NOW]);
  }
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
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const LINE = (productId: string, qty = 1, price = 1000) => ({
  productId, quantity: qty, unitPrice: price, purchasePrice: 100, taxScheme: 'VAT_10', vatRate: 10,
  vatAmount: (price * qty) / 10, lineTotal: price * qty * 1.1,
});
function rechnung(lines: Array<ReturnType<typeof LINE>>, customerId = 'cust-1'): string {
  const id = imHaus(() => useInvoiceStore.getState().createDirectInvoice(customerId, lines as never, 'SLI').id);
  reload();
  return id;
}
function voll(invId: string): string {
  const db = current();
  const offen = n(db, 'SELECT gross_amount - paid_amount FROM invoices WHERE id = ?', [invId]);
  const pay = imHaus(() => useInvoiceStore.getState().recordPayment(invId, offen, 'cash'));
  reload();
  return pay;
}
const { formatInvoiceDisplay } = await import('../../src/core/utils/invoiceNumber.ts');
const { backfillInvoiceNumberFinalized } = await import('../../src/core/invoices/final-number.ts');

let DB: Db | null = null;
const current = (): Db => DB as Db;
const neu = (): Db => { DB = freshDb(); return DB; };
void OWNER_ACTOR; void imHausAsync; void tick; void useConsignmentStore; void useProductionStore;
void cancelReturnHouse; void cancelInvoiceInHouse; void convertTransferInHouse; void undoTransferConversionInHouse;
void createProductionInHouse; void STOCK_UNAVAILABLE_MESSAGE; void classifyLegacyInvoiceLines; void LEGACY_STOCK_LINES_MESSAGE;
void eventBus; void posting;

const YEAR = new Date().getFullYear();
const nummer = (db: Db, inv: string): string => s(db, 'SELECT invoice_number FROM invoices WHERE id = ?', [inv]);
const status = (db: Db, inv: string): string => s(db, 'SELECT status FROM invoices WHERE id = ?', [inv]);
const merker = (db: Db, inv: string): unknown => one(db, 'SELECT number_finalized_at FROM invoices WHERE id = ?', [inv]);
const sonder = (db: Db, inv: string): number => n(db, 'SELECT special_mark FROM invoices WHERE id = ?', [inv]);
const zaehler = (db: Db, doc: string): number => n(db, 'SELECT next_number FROM document_sequences WHERE doc_type = ?', [doc]);
const vergaben = (db: Db, inv: string): number =>
  n(db, "SELECT COUNT(*) FROM audit_log WHERE entity_type = 'invoices' AND entity_id = ? AND field_name = 'invoice_number'", [inv]);
const anzeige = (inv: string): string => {
  const i = useInvoiceStore.getState().getInvoice(inv);
  return i ? formatInvoiceDisplay(i) : '(fehlt)';
};
const offen = (db: Db, inv: string): number => n(db, 'SELECT gross_amount - paid_amount FROM invoices WHERE id = ?', [inv]);
function zahle(inv: string, betrag: number, special?: boolean): string {
  const id = imHaus(() => useInvoiceStore.getState().recordPayment(inv, betrag, 'cash', undefined, special));
  reload();
  return id;
}
function aendern(inv: string, lines: Array<ReturnType<typeof LINE>>, delta?: number): void {
  imHaus(() => useInvoiceStore.getState().editInvoice(inv, {
    lines: lines as never, reason: 'S1 Test',
    ...(delta ? { deltaPayment: { amount: delta, method: 'cash' } } : {}),
  } as never));
  reload();
}
const payIds = (db: Db, inv: string): string[] =>
  (db.exec('SELECT id FROM payments WHERE invoice_id = ? ORDER BY created_at, id', [inv])[0]?.values ?? []).map((v) => String(v[0]));

// ══ A1–A3 — FINAL → Preiserhöhung → PARTIAL → Restzahlung: dieselbe Endnummer ═════════════
{
  const db = neu();
  product(db, 'p1', null, 5); reload();
  const inv = rechnung([LINE('p1', 1)]);
  ok(/^PINV-/.test(nummer(db, inv)) && merker(db, inv) === null, `A0 neue Rechnung: vorläufige Nummer, kein Merker (${nummer(db, inv)})`);
  voll(inv);
  const endnr = nummer(db, inv);
  ok(endnr === `INV-${YEAR}-000001` && status(db, inv) === 'FINAL' && !!merker(db, inv),
    `A1 Vollzahlung: Endnummer ${endnr}, Merker gesetzt`);
  ok(zaehler(db, 'INV') === 2 && vergaben(db, inv) === 1, `A1 …genau eine Nummer gezogen (Zähler ${zaehler(db, 'INV')}, Vergaben ${vergaben(db, inv)})`);
  const anzeigeVorher = anzeige(inv);
  ok(anzeigeVorher === 'No: 000001', `A1 …Anzeige ${anzeigeVorher}`);

  aendern(inv, [LINE('p1', 1, 1200)]);
  ok(status(db, inv) === 'PARTIAL' && nummer(db, inv) === endnr && offen(db, inv) === 220,
    `A2 Preiserhöhung 1100 → 1320: PARTIAL, offen 220, Nummer bleibt (${status(db, inv)}/${nummer(db, inv)}/${offen(db, inv)})`);
  ok(anzeige(inv) === anzeigeVorher, `A2 …Anzeige unverändert trotz PARTIAL (${anzeige(inv)})`);
  zahle(inv, 220);
  ok(status(db, inv) === 'FINAL' && nummer(db, inv) === endnr, `A2 Restzahlung: FINAL, DIESELBE Nummer (${nummer(db, inv)})`);
  ok(zaehler(db, 'INV') === 2 && vergaben(db, inv) === 1, `A2 …keine zweite Nummer gezogen (Zähler ${zaehler(db, 'INV')}, Vergaben ${vergaben(db, inv)})`);

  // Erhöhung mit Nachzahlung im selben Speichern.
  aendern(inv, [LINE('p1', 1, 1300)], 110);
  ok(status(db, inv) === 'FINAL' && nummer(db, inv) === endnr && zaehler(db, 'INV') === 2,
    `A2b Erhöhung + Nachzahlung in einem Speichern: FINAL, Nummer bleibt, Zähler 2 (${nummer(db, inv)})`);

  // A3 — Zahlung ändern: kleiner (PARTIAL), wieder voll (FINAL).
  const [p1] = payIds(db, inv);
  const vorher = n(db, 'SELECT amount FROM payments WHERE id = ?', [p1]);
  useInvoiceStore.getState().updatePayment(p1, inv, { amount: vorher - 100 }); reload();
  ok(status(db, inv) === 'PARTIAL' && nummer(db, inv) === endnr && anzeige(inv) === anzeigeVorher,
    `A3 Zahlung verkleinert: PARTIAL, Nummer und Anzeige bleiben (${status(db, inv)}/${anzeige(inv)})`);
  useInvoiceStore.getState().updatePayment(p1, inv, { amount: vorher }); reload();
  ok(status(db, inv) === 'FINAL' && nummer(db, inv) === endnr && zaehler(db, 'INV') === 2 && vergaben(db, inv) === 1,
    `A3 Zahlung zurück auf voll: FINAL, dieselbe Nummer, Zähler 2 (${nummer(db, inv)})`);

  // A4 — Zahlung löschen, neu voll bezahlen.
  for (const pid of payIds(db, inv)) { useInvoiceStore.getState().deletePayment(pid, inv); reload(); }
  ok(status(db, inv) !== 'FINAL' && nummer(db, inv) === endnr && anzeige(inv) === anzeigeVorher,
    `A4 alle Zahlungen gelöscht: ${status(db, inv)}, Nummer und Anzeige bleiben (${anzeige(inv)})`);
  voll(inv);
  ok(status(db, inv) === 'FINAL' && nummer(db, inv) === endnr && zaehler(db, 'INV') === 2 && vergaben(db, inv) === 1,
    `A4 erneut voll bezahlt: dieselbe Nummer, keine neue gezogen (${nummer(db, inv)}, Zähler ${zaehler(db, 'INV')})`);

  // A5 — Reduzierung unter den bezahlten Betrag: Nummer bleibt, Überschuss wird Guthaben.
  const bezahlt = n(db, 'SELECT paid_amount FROM invoices WHERE id = ?', [inv]);
  aendern(inv, [LINE('p1', 1, 1000)]);
  const guthaben = n(db, "SELECT COALESCE(SUM(amount), 0) FROM customer_credits WHERE source_type = 'invoice_edit' AND source_id = ?", [inv]);
  ok(status(db, inv) === 'FINAL' && nummer(db, inv) === endnr && Math.abs(guthaben - (bezahlt - 1100)) < 0.005,
    `A5 Reduzierung ${bezahlt} → 1100: FINAL, Nummer bleibt, Guthaben ${guthaben}`);
  ok(n(db, 'SELECT COUNT(*) FROM payments WHERE invoice_id = ?', [inv]) === payIds(db, inv).length && payIds(db, inv).length > 0,
    'A5 …die Zahlungen bestehen weiter');

  // A9 — die Nummer ist kein frei setzbares Feld mehr.
  imHaus(() => useInvoiceStore.getState().updateInvoice(inv, { invoiceNumber: 'HACK-1' } as never)); reload();
  ok(nummer(db, inv) === endnr, `A9 updateInvoice({invoiceNumber}) ändert nichts (${nummer(db, inv)})`);
  // A10 — das Sonder-Kennzeichen steht mit der Endnummer fest.
  const sm = meldung(() => useInvoiceStore.getState().setSpecialMark(inv, true));
  ok(/number is final/.test(sm) && sonder(db, inv) === 0, `A10 Sonder-Kennzeichen nach Endnummer: abgewiesen (${sm.slice(0, 50)})`);
}

// ══ A6 — Sonder-Kreis: SINV bleibt SINV, die Wahl gilt nur beim ersten Mal ═════════════════
{
  const db = neu();
  product(db, 'p2', null, 5); reload();
  const inv = rechnung([LINE('p2', 1)]);
  const pre = meldung(() => useInvoiceStore.getState().setSpecialMark(inv, false));
  ok(pre === '', `A10 Sonder-Kennzeichen VOR der Endnummer bleibt umstellbar (${pre})`);
  zahle(inv, offen(db, inv), true);
  const endnr = nummer(db, inv);
  ok(endnr === `SINV-${YEAR}-000001` && sonder(db, inv) === 1 && anzeige(inv) === 'No: .000001',
    `A6 Sonder-Vollzahlung: ${endnr}, Anzeige ${anzeige(inv)}`);
  aendern(inv, [LINE('p2', 1, 1100)]);
  ok(status(db, inv) === 'PARTIAL' && anzeige(inv) === 'No: .000001', `A6 Erhöhung: PARTIAL, Anzeige bleibt ${anzeige(inv)}`);
  zahle(inv, offen(db, inv), false);  // eine ANDERE Wahl darf nichts mehr ändern
  ok(nummer(db, inv) === endnr && sonder(db, inv) === 1 && zaehler(db, 'SINV') === 2 && zaehler(db, 'INV') === 1,
    `A6 Restzahlung mit Wahl „normal": weiter ${nummer(db, inv)}, Sonder 1, kein INV gezogen`);
}

// ══ A7 — Reparatur-Kreis: RPINV → RINV, danach fest ═══════════════════════════════════════
{
  const db = neu();
  product(db, 'p3', null, 5); reload();
  const inv = imHaus(() => useInvoiceStore.getState().createDirectInvoice('cust-1', [LINE('p3', 1)] as never, 'R', undefined, 'repair').id);
  reload();
  ok(/^RPINV-/.test(nummer(db, inv)), `A7 Reparatur vorläufig ${nummer(db, inv)}`);
  voll(inv);
  const endnr = nummer(db, inv);
  ok(endnr === `RINV-${YEAR}-000001` && anzeige(inv) === 'Repair-000001', `A7 Reparatur-Endnummer ${endnr} (${anzeige(inv)})`);
  aendern(inv, [LINE('p3', 1, 1200)]);
  zahle(inv, offen(db, inv));
  ok(nummer(db, inv) === endnr && zaehler(db, 'RINV') === 2 && anzeige(inv) === 'Repair-000001',
    `A7 Erhöhung + Restzahlung: dieselbe ${nummer(db, inv)}, Zähler RINV 2`);
}

// ══ A8 — FINAL ohne Zahlungsvorgang (Edit deckt die Rechnung): Endnummer genau einmal ═══════
{
  const db = neu();
  product(db, 'p4', null, 5); reload();
  const inv = rechnung([LINE('p4', 1)]);
  zahle(inv, 600);
  ok(status(db, inv) === 'PARTIAL' && /^PINV-/.test(nummer(db, inv)), 'A8 SETUP teilbezahlt, vorläufige Nummer');
  aendern(inv, [LINE('p4', 1, 600 / 1.1)]);
  const endnr = nummer(db, inv);
  ok(status(db, inv) === 'FINAL' && endnr === `INV-${YEAR}-000001` && !!merker(db, inv),
    `A8 Edit senkt auf den bezahlten Betrag: FINAL mit Endnummer ${endnr} (früher: FINAL mit PINV)`);
  aendern(inv, [LINE('p4', 1, 800)]);
  zahle(inv, offen(db, inv));
  ok(nummer(db, inv) === endnr && zaehler(db, 'INV') === 2 && vergaben(db, inv) === 1,
    `A8 danach erhöht und nachbezahlt: dieselbe ${nummer(db, inv)}`);
  // Zahlung vergrößern bis voll (ohne recordPayment) — auch hier genau einmal.
  const inv2 = rechnung([LINE('p4', 1)]);
  const [pid] = [zahle(inv2, 500)];
  useInvoiceStore.getState().updatePayment(pid, inv2, { amount: 1100 }); reload();
  ok(status(db, inv2) === 'FINAL' && nummer(db, inv2) === `INV-${YEAR}-000002` && !!merker(db, inv2),
    `A8b Zahlung auf voll geändert: FINAL mit Endnummer ${nummer(db, inv2)}`);
}

// ══ A11 — Fehlschlag: Rollback nimmt die gezogene Nummer mit ═════════════════════════════
{
  const db = neu();
  product(db, 'p5', null, 5); reload();
  const inv = rechnung([LINE('p5', 1)]);
  const vorher = nummer(db, inv);
  const m = meldung(() => imHaus(() => { useInvoiceStore.getState().recordPayment(inv, 1100, 'cash'); throw new Error('Absturz nach der Zahlung'); }));
  reload();
  ok(/Absturz/.test(m) && nummer(db, inv) === vorher && merker(db, inv) === null && zaehler(db, 'INV') === 1,
    `A11 Rollback: keine Nummer verbrannt, kein Merker (${nummer(db, inv)}, Zähler ${zaehler(db, 'INV')})`);
}

// ══ A12 — Aufstieg alter Daten beim Start ════════════════════════════════════════════════
{
  const db = neu();
  const alt = (id: string, nr: string, st: string): void => insert(db, 'invoices', {
    id, branch_id: 'branch-main', invoice_number: nr, customer_id: 'cust-1', status: st,
    net_amount: 1000, vat_rate_snapshot: 10, vat_amount: 100, gross_amount: 1100, paid_amount: st === 'FINAL' ? 1100 : 500,
    tax_scheme_snapshot: 'VAT_10', created_at: NOW, updated_at: NOW,
  });
  alt('b-final', `INV-${YEAR}-000040`, 'FINAL');
  alt('b-zurueck', `INV-${YEAR}-000041`, 'PARTIAL');  // der Fehlerfall: schon mal FINAL, dann zurückgefallen
  db.run(`INSERT INTO audit_log (id, module, entity_type, entity_id, action_type, field_name, old_value, new_value, changed_at)
    VALUES ('au-1','Sales','invoices','b-zurueck','UPDATE','invoice_number','PINV-${YEAR}-000007','INV-${YEAR}-000041','2026-01-05T10:00:00.000Z')`);
  alt('b-offen', `PINV-${YEAR}-000008`, 'PARTIAL');
  alt('b-final-pinv', `PINV-${YEAR}-000009`, 'FINAL');  // nie eine Endnummer bekommen
  db.run("UPDATE document_sequences SET prefix = 'PX' WHERE doc_type = 'PINV'");
  alt('b-final-px', `PX-${YEAR}-000010`, 'FINAL');       // umbenannter vorläufiger Kreis
  const vorNr = all(db, 'SELECT id, invoice_number, status, special_mark FROM invoices ORDER BY id');
  backfillInvoiceNumberFinalized(db as never);
  ok(!!merker(db, 'b-final') && merker(db, 'b-zurueck') === '2026-01-05T10:00:00.000Z',
    `A12 FINAL mit Endnummer und zurückgefallene (Protokoll) bekommen den Merker (${S(merker(db, 'b-zurueck'))})`);
  ok(merker(db, 'b-offen') === null && merker(db, 'b-final-pinv') === null && merker(db, 'b-final-px') === null,
    'A12 vorläufige Nummern bleiben ohne Merker — auch FINAL mit PINV und ein umbenannter Kreis');
  ok(all(db, 'SELECT id, invoice_number, status, special_mark FROM invoices ORDER BY id') === vorNr,
    'A12 …Nummern, Status und Kennzeichen unverändert');
  const nach1 = all(db, 'SELECT id, number_finalized_at FROM invoices ORDER BY id');
  backfillInvoiceNumberFinalized(db as never);
  ok(all(db, 'SELECT id, number_finalized_at FROM invoices ORDER BY id') === nach1, 'A12 …zweiter Start ändert nichts (idempotent)');
  reload();
  ok(anzeige('b-zurueck') === 'No: 000041', `A12 die zurückgefallene Rechnung zeigt wieder ihre Endform (${anzeige('b-zurueck')})`);
  zahle('b-zurueck', 600);
  ok(nummer(db, 'b-zurueck') === `INV-${YEAR}-000041` && zaehler(db, 'INV') === 1,
    `A12 …und behält ihre Nummer, wenn sie jetzt voll bezahlt wird (${nummer(db, 'b-zurueck')})`);
}

// ══ A13 — die Anzeige-Regel selbst ════════════════════════════════════════════════════════
ok(formatInvoiceDisplay({ invoiceNumber: 'INV-2026-000009', status: 'PARTIAL', numberFinalizedAt: 'x' }) === 'No: 000009', 'A13 Endnummer + PARTIAL → No: 000009');
ok(formatInvoiceDisplay({ invoiceNumber: 'PINV-2026-000009', status: 'PARTIAL' }) === 'PINV-2026-000009', 'A13 vorläufig → Rohnummer (unverändert)');
ok(formatInvoiceDisplay({ invoiceNumber: 'INV-2026-000009', status: 'FINAL' }) === 'No: 000009', 'A13 FINAL ohne Merker → wie bisher');
ok(formatInvoiceDisplay({ invoiceNumber: 'SRINV-2026-000002', status: 'RETURNED', specialMark: true, numberFinalizedAt: 'x' }) === '.Repair-000002', 'A13 Sonder-Reparatur zurückgegeben → .Repair-000002');

// ══ Quelltext — genau EINE Stelle vergibt Endnummern ═══════════════════════════════════════
{
  const store = src('src/stores/invoiceStore.ts');
  ok(!/getNextDocumentNumber\(\s*[^)]*'(INV|SINV|RINV|SRINV)'/.test(store) && !/'SINV' : 'INV'|'SRINV' : 'RINV'/.test(store),
    'Q invoiceStore zieht keine Endnummer mehr selbst');
  ok((store.match(/ensureFinalInvoiceNumber\(/g) ?? []).length === 4,
    `Q …Zahlung, Edit, Zahlung ändern, Zahlung löschen gehen über ensureFinalInvoiceNumber (${(store.match(/ensureFinalInvoiceNumber\(/g) ?? []).length})`);
  ok(!/invoiceNumber: 'invoice_number'/.test(store), 'Q updateInvoice kennt invoice_number nicht mehr');
}
void current;

console.log(`\ninvoice-number-freeze: ${PASS} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
