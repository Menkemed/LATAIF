// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6E-CN — „Cancel Return" storniert die Gutschrift, statt sie zu löschen.
// Run: node test/r6e/credit-note-reversal.test.ts
//
// Vorher löschte `cancelReturnInHouse` die `credit_notes`-Zeile (eine Steuerurkunde mit Nummer) und
// das daraus entstandene, unbenutzte Store-Guthaben. Jetzt bleiben beide stehen, als CANCELLED:
// Nummer und Beträge unverändert, Storno eindeutig (Status, wann, wer, warum), keine Wirkung mehr
// auf offene Posten, Guthaben, Steuer, Deckel und Abstimmung. Das Hauptbuch storniert wie bisher.
//
// Gefahren werden die ECHTE Hausfolge, der echte Primary-Anschluss (`salesReturnStore.cancelReturn`
// → `runOnPrimary`), der echte Fernbefehl (`returns.cancel` über die C3A-Maschine), die echten Leser
// (Kunde, Forderungen, Seitenlesungen, Abstimmung, Gegenpartei-Prüfung, Steuer, Umsatz, Nachbuchung)
// und das echte Schema samt Migrationen. Gestellt ist nur das Speichern.
//
//   §1 Schema + Leser-Inventar   §2 Storno: Primary == PC2, Gutschrift bleibt, Leser == vor der Retoure
//   §3 Nachbuchung   §4 Wiederholung + verlorene Antwort   §5 Fehlerinjektion   §6 Folgeleser   §7 Oberfläche
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, readdirSync, existsSync } from 'node:fs';
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
  // Abgleich eingeschaltet: `trackChange` schreibt ins Änderungsprotokoll — messbar, auch im Rollback.
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
const { COMMAND_LEDGER_DDL, COMMAND_LEDGER_INDEX, lookupCommand } = await import('../../src/core/bridge/command-ledger.ts');
const { resetDurabilityStateForTest } = await import('../../src/core/bridge/durability-state.ts');
const { resetTransactionHealthForTest } = await import('../../src/core/db/transaction-health.ts');
const { installWriteGuard } = await import('../../src/core/db/write-guard.ts');
const { SKU_SEQUENCES_DDL } = await import('../../src/core/products/sku-sequence.ts');
await import('../../src/core/bridge/command-registry.ts');
await import('../../src/core/bridge/read-commands.ts');
const rev = await import('../../src/core/bridge/sales-reversal-commands.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const { applyMediaSchema } = await import('../../src/core/db/media-schema.ts');
const { useInvoiceStore } = await import('../../src/stores/invoiceStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { useCustomerStore } = await import('../../src/stores/customerStore.ts');
const { useSalesReturnStore } = await import('../../src/stores/salesReturnStore.ts');
const { useCreditNoteStore, loadCreditNotesFor } = await import('../../src/stores/creditNoteStore.ts');
const { useAuthStore } = await import('../../src/stores/authStore.ts');
const { localReadContext } = await import('../../src/core/data/read-context.ts');
const cancelHouse = await import('../../src/core/returns/return-cancel-house.ts');
const reversal = await import('../../src/core/invoices/invoice-reversal.ts');
const { receivablesBreakdown } = await import('../../src/core/finance/receivables.ts');
const { invoiceListExtrasFor, customerDetailReadsFor } = await import('../../src/core/data/page-reads.ts');
const { reconciliationSnapshotFor } = await import('../../src/core/reports/reconciliation-snapshot.ts');
const { financeFor } = await import('../../src/core/reports/analytics-snapshot.ts');
const { loadSalesData } = await import('../../src/core/reports/sales-metrics-loader.ts');
const { computeSalesMetrics } = await import('../../src/core/reports/sales-metrics.ts');
const { backfillCreditNotes } = await import('../../src/core/ledger/backfill.ts');
const MANIFEST = JSON.parse(readFileSync(resolvePath(repo, 'src/core/sync/sync-business-schema.json'), 'utf8')) as {
  tables: Record<string, { allowed_fields: string[] }>;
};

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const marker = (m: string): void => { if (fails.length === 0) console.log(m); };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const codeOf = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const S = (v: unknown): string => JSON.stringify(v);
const NOW = '2026-09-13T10:00:00.000Z';
const r3 = (x: unknown): number => Math.round((Number(x) || 0) * 1000) / 1000;

interface Db {
  run(sql: string, p?: unknown[]): unknown;
  exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
}
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const n = (db: Db, sql: string, p: unknown[] = []): number => Number(one(db, sql, p) ?? 0);
const s = (db: Db, sql: string, p: unknown[] = []): string => String(one(db, sql, p) ?? '');
function row(db: Db, sql: string, p: unknown[] = []): Record<string, unknown> {
  const r = db.exec(sql, p)[0];
  if (!r || r.values.length === 0) return {};
  return Object.fromEntries(r.columns.map((c, i) => [c, r.values[0][i]]));
}
function rows(db: Db, sql: string, p: unknown[] = []): Array<Record<string, unknown>> {
  const r = db.exec(sql, p)[0];
  if (!r) return [];
  return r.values.map((v) => Object.fromEntries(r.columns.map((c, i) => [c, v[i]])));
}
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
  useInvoiceStore.getState().loadInvoices();
  useSalesReturnStore.getState().loadReturns();
  useCreditNoteStore.getState().loadCreditNotes();
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
  for (const [id, name] of [['branch-main', 'Haupt'], ['branch-other', 'Andere']]) {
    db.run('INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES (?,?,?,?,?)', [id, 'tenant-1', name, NOW, NOW]);
  }
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES ('cat-w','branch-main','Watch','w','#000',?,?)", [NOW, NOW]);
  db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level,
      preferences, customer_type, sales_stage, created_at, updated_at)
    VALUES ('cust-1','branch-main','Ali','Hassan','BH','en',0,'[]','collector','active',?,?)`, [NOW, NOW]);
  applyMediaSchema(db as never);
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
      scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
      tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
    VALUES ('p2','branch-main','cat-w','Rolex','M p2','SKU-p2',1,'Pre-Owned','[]',100,'BHD',150,'in_stock','VAT_10',0,'[]','{}','OWN',?,?)`, [NOW, NOW]);
  db.run(`INSERT INTO stock_lots (id, branch_id, product_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
    VALUES ('lot-p2','branch-main','p2',100,1,1,'ACTIVE',?,?)`, [NOW, NOW]);
  reload();
  tauriState.reset();
  return db;
}

// Der Mensch am Primary ist der Owner (die Maske zeigt „Cancel Return" nur ihm).
useAuthStore.setState({ session: { userId: 'user-test', branchId: 'branch-main', role: 'ADMIN' } as never });

const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-000000000000`;
const ACTOR = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role: 'ADMIN' };
const identity = (x: string) => ({ commandId: ID(x), ...ACTOR, op: 'returns.cancel', payloadHash: 'h' + x });
const deps = (db: Db) => ({
  db: db as never,
  begin: posting.beginLedgerTransaction,
  commit: posting.commitLedgerTransaction,
  rollback: posting.rollbackLedgerTransaction,
  durableSave: async () => {},
  now: () => NOW,
});

interface Ausgang { ok: boolean; code: string; frozen: boolean; value: Record<string, unknown>; replayed: boolean }
async function fern(p: () => Promise<unknown>): Promise<Ausgang> {
  try {
    const o = await p() as { kind: string; code?: string; value?: Record<string, unknown>; replayed?: boolean; frozen?: boolean };
    if (o.kind === 'ok') return { ok: true, code: '', frozen: false, value: o.value ?? {}, replayed: o.replayed === true };
    return { ok: false, code: o.code ?? '(ohne Code)', frozen: o.frozen === true, value: {}, replayed: false };
  } catch (e) {
    return { ok: false, code: (e as { code?: string }).code ?? 'THROWN:' + String(e), frozen: false, value: {}, replayed: false };
  }
}
async function primary(p: () => unknown): Promise<Ausgang> {
  try { return { ok: true, code: '', frozen: false, value: (await p() ?? {}) as Record<string, unknown>, replayed: false }; }
  catch (e) { return { ok: false, code: (e as { code?: string }).code ?? 'THROWN:' + String(e), frozen: false, value: {}, replayed: false }; }
}
function meldung(fn: () => unknown): string {
  try { fn(); return ''; } catch (e) { return (e as Error).message; }
}

const OHNE = /^(id|version|sync_status)$|_at$|_date$/;
function ohne(r: Record<string, unknown>, auch: string[] = []): Record<string, unknown> {
  return Object.fromEntries(Object.entries(r).filter(([k]) => !OHNE.test(k) && !auch.includes(k)).sort(([a], [b]) => a.localeCompare(b)));
}
const unterschiede = (a: Record<string, unknown>, b: Record<string, unknown>): string[] =>
  Object.keys({ ...a, ...b }).filter((k) => S(a[k] ?? null) !== S(b[k] ?? null)).map((k) => `${k}: ${S(a[k])} vs ${S(b[k])}`);
const salden = (db: Db): string => all(db,
  `SELECT account, COALESCE(counterparty_id, '') AS cp, ROUND(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 3) AS net
     FROM ledger_entries GROUP BY account, cp HAVING ABS(net) > 0.0005 ORDER BY account, cp`);
const lc = (db: Db): number => n(db, 'SELECT COUNT(*) FROM ledger_entries');
const changelog = (db: Db): number => n(db, 'SELECT COUNT(*) FROM sync_changelog');
function balanced(db: Db): boolean {
  const t = db.exec(`SELECT transaction_id,
      SUM(CASE WHEN direction = 'DEBIT' THEN CAST(ROUND(amount * 1000) AS INTEGER) ELSE 0 END),
      SUM(CASE WHEN direction = 'CREDIT' THEN CAST(ROUND(amount * 1000) AS INTEGER) ELSE 0 END)
    FROM ledger_entries GROUP BY transaction_id`)[0]?.values ?? [];
  return t.length > 0 && t.every((r) => Number(r[1]) === Number(r[2]));
}
function faulty(db: Db, pattern: RegExp): Db {
  return new Proxy(db as object, {
    get(t, k) {
      if (k === 'run') {
        return (sql: string, p?: unknown[]) => {
          if (pattern.test(sql)) throw new Error('INJECTED at ' + pattern);
          return (t as Db).run(sql, p);
        };
      }
      const v = (t as Record<string | symbol, unknown>)[k];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  }) as unknown as Db;
}
function imHaus<T>(fn: () => T): T {
  posting.beginLedgerTransaction();
  try { const out = fn(); posting.commitLedgerTransaction(); return out; }
  catch (e) { posting.rollbackLedgerTransaction(); throw e; }
}

// ── Was die Leser sagen — Kunde, Forderungen, Seiten, Abstimmung, Steuer, Umsatz, Ware ─────────
function leser(db: Db, invId: string) {
  reload();
  const ctx = localReadContext();
  const cs = useCustomerStore.getState();
  const rec = reconciliationSnapshotFor(ctx);
  const fin = (financeFor(ctx) ?? {}) as Record<string, unknown>;
  const d = loadSalesData({ branchId: 'branch-main' });
  const m = computeSalesMetrics(d.invoices, d.salesReturns);
  const cp = rec.counterparty;
  const sec = (x: { rows: Array<{ id: string; domainFils: number; ledgerFils: number }>; ok: boolean } | undefined) =>
    x ? { ok: x.ok, rows: x.rows.map((r) => [r.id, r.domainFils, r.ledgerFils]) } : null;
  return {
    offenePosten: cs.getOutstanding('cust-1'),
    guthaben: r3(cs.getAvailableCredit('cust-1')),
    kundenzahlen: cs.getCustomerStats('cust-1'),
    forderungen: receivablesBreakdown('branch-main').map((r) => [r.customerId, r.source, r3(r.totalAmount), r3(r.paidAmount), r3(r.open)]),
    offeneRechnungen: invoiceListExtrasFor(ctx).openCount,
    kundenGutschriften: customerDetailReadsFor(ctx, 'cust-1').creditNoteCancels,
    abstimmung: rec.rows.map((r) => [r.label, r3(r.ledger), r3(r.domain)]),
    waisen: rec.orphans.length,
    gegenpartei: cp ? {
      ar: sec(cp.arByCustomer), cc: sec(cp.customerCreditByCustomer),
      befunde: cp.issues.filter((i) => i.side === 'customer').map((i) => `${i.kind}:${i.severity}`).sort(),
    } : rec.counterpartyError,
    steuer: {
      totalVat: r3(fin.totalVat), netVatOwed: r3(fin.netVatOwed), vatRefundDue: r3(fin.vatRefundDue),
      openCount: fin.openCount, openValue: r3(fin.openValue), quartale: fin.quarterly,
    },
    umsatz: { gross: r3(m.gross), net: r3(m.net), vat: r3(m.vat), profit: r3(m.profit) },
    rechnung: ohne(row(db, 'SELECT * FROM invoices WHERE id = ?', [invId]), ['revision']),
    // stock_status bewusst NICHT: die Warenfolge-Rücknahme setzt 'sold' (best effort, unverändert
    // übernommen), der Verkauf hinterließ 'reserved' — kein Gutschrift-Thema (s. Bericht).
    ware: all(db, "SELECT l.qty_remaining, l.status, p.quantity FROM stock_lots l JOIN products p ON p.id = l.product_id WHERE p.id = 'p2'"),
    salden: salden(db),
  };
}
type Leser = ReturnType<typeof leser>;
const leserDiff = (a: Leser, b: Leser): string[] =>
  Object.keys(a).filter((k) => S((a as Record<string, unknown>)[k]) !== S((b as Record<string, unknown>)[k]))
    .map((k) => `${k}: ${S((a as Record<string, unknown>)[k])} → ${S((b as Record<string, unknown>)[k])}`);

// ── Die Welt: Rechnung über p2 (VAT_10, 1000 + 100 Steuer), Retoure IN_STOCK über die ganze Zeile ──
type Art = 'unbezahlt-bar' | 'guthaben' | 'bezahlt-bar-offen';
interface Welt { db: Db; invId: string; lineId: string; retId: string; cnId: string; cnVor: Record<string, unknown>; vor: Leser; mit: Leser }
function welt(art: Art): Welt {
  const db = freshDb();
  const bezahlt = art === 'unbezahlt-bar' ? 0 : 1100;
  const invId = imHaus(() => {
    const inv = useInvoiceStore.getState().createDirectInvoice('cust-1', [{
      productId: 'p2', unitPrice: 1000, purchasePrice: 100, taxScheme: 'VAT_10', vatRate: 10, vatAmount: 100, lineTotal: 1100,
    }], 'R6E-CN');
    if (bezahlt) useInvoiceStore.getState().recordPayment(inv.id, bezahlt, 'cash');
    return inv.id;
  });
  const lineId = s(db, 'SELECT id FROM invoice_lines WHERE invoice_id = ?', [invId]);
  const vor = leser(db, invId);
  const retId = retoure(db, invId, lineId, art === 'guthaben' ? 'credit' : 'cash');
  const mit = leser(db, invId);
  const cnVor = row(db, 'SELECT * FROM credit_notes WHERE sales_return_id = ?', [retId]);
  return { db, invId, lineId, retId, cnId: String(cnVor.id ?? ''), cnVor, vor, mit };
}
function retoure(db: Db, invId: string, lineId: string, methode: 'cash' | 'credit'): string {
  const id = imHaus(() => {
    const rs = useSalesReturnStore.getState();
    rs.loadReturns();
    const rid = rs.createReturn({
      invoiceId: invId, refundMethod: methode, productDisposition: 'IN_STOCK', reason: 'defekt',
      lines: [{ invoiceLineId: lineId, productId: 'p2', quantity: 1, unitPrice: 1100, vatAmount: 100 }],
    }).id;
    useSalesReturnStore.getState().loadReturns();
    useSalesReturnStore.getState().approveReturn(rid);
    return rid;
  });
  void db;
  reload();
  return id;
}
const rrev = (db: Db, id: string): number => n(db, 'SELECT revision FROM sales_returns WHERE id = ?', [id]);
const GRUND = ' Kunde behaelt die Uhr ';
const rumpf = (w: Welt) => ({ returnId: w.retId, expectedRevision: rrev(w.db, w.retId), reason: GRUND });
let seq = 100;
const nx = (): string => String(++seq);
const cnZeile = (w: Welt): Record<string, unknown> => row(w.db, 'SELECT * FROM credit_notes WHERE id = ?', [w.cnId]);
const ccZeilen = (w: Welt): Array<Record<string, unknown>> =>
  rows(w.db, "SELECT * FROM customer_credits WHERE source_type = 'sales_return' AND source_id = ? ORDER BY id", [w.cnId]);
/** Was ein Fehlschlag nicht verändern darf. */
function zustand(w: Welt): string {
  return S({
    ret: row(w.db, 'SELECT * FROM sales_returns WHERE id = ?', [w.retId]),
    cn: all(w.db, 'SELECT * FROM credit_notes ORDER BY id'),
    cc: all(w.db, 'SELECT * FROM customer_credits ORDER BY id'),
    inv: all(w.db, 'SELECT * FROM invoices ORDER BY id'),
    lose: all(w.db, 'SELECT * FROM stock_lots ORDER BY id'),
    lc: lc(w.db), salden: salden(w.db), log: changelog(w.db),
    audit: n(w.db, 'SELECT COUNT(*) FROM audit_log'),
  });
}

// ══ §1 — Schema und Leser-Inventar ═══════════════════════════════════════════
{
  const db = freshDb();
  const cols = db.exec('PRAGMA table_info(credit_notes)')[0].values.map((v) => ({ name: String(v[1]), notnull: Number(v[3]), dflt: v[4] }));
  const st = cols.find((c) => c.name === 'status');
  ok(!!st && st.notnull === 1 && String(st.dflt) === "'ISSUED'", `SCHEMA credit_notes.status NOT NULL DEFAULT 'ISSUED' (${S(st)})`);
  ok(['cancelled_at', 'cancelled_by', 'cancel_reason'].every((c) => cols.some((x) => x.name === c)), 'SCHEMA cancelled_at / cancelled_by / cancel_reason');
  ok(['status', 'cancelled_at', 'cancelled_by', 'cancel_reason'].every((c) => MANIFEST.tables.credit_notes.allowed_fields.includes(c)),
    'SYNC die neuen Spalten stehen im Abgleich-Manifest');
  insert(db, 'invoices', { id: 'inv-alt', branch_id: 'branch-main', invoice_number: 'INV-ALT', customer_id: 'cust-1', status: 'FINAL', created_at: NOW, updated_at: NOW });
  db.run(`INSERT INTO credit_notes (id, branch_id, credit_note_number, invoice_id, customer_id, issued_at, created_at)
          VALUES ('cn-alt', 'branch-main', 'CN-ALT', 'inv-alt', 'cust-1', ?, ?)`, [NOW, NOW]);
  ok(s(db, "SELECT status FROM credit_notes WHERE id = 'cn-alt'") === 'ISSUED', 'SCHEMA ein Einfügen ohne Status (alter Schreiber, Abgleich) ist ISSUED');

  // Jede SQL-Stelle in src/, die Gutschriften oder Guthaben SUMMIERT oder ZÄHLT, muss den Storno
  // auslassen — sonst hätte eine stornierte Gutschrift dort noch eine Wirkung.
  const ERLAUBT: Array<[string, string]> = [
    ["source_type = 'gold_conversion'", 'Gold-Clearing: terminal, wird nie storniert'],
    ['FROM credit_applications WHERE credit_id=cc.id', 'Integritätsprüfung: CANCELLED wird im Code übersprungen'],
  ];
  const offen: string[] = [];
  let geprueft = 0;
  for (const rel of readdirSync(resolvePath(repo, 'src'), { recursive: true, encoding: 'utf8' })) {
    if (!/\.(ts|tsx)$/.test(rel) || /db[\\/]database\.ts$/.test(rel)) continue;
    const code = codeOf(src('src/' + rel.replace(/\\/g, '/')));
    for (const mm of code.matchAll(/`[^`]*`|'[^'\n]*'/g)) {
      const sql = mm[0];
      if (!/\b(SELECT|UPDATE|DELETE)\b/.test(sql) || !/\b(SUM|COUNT)\s*\(/.test(sql)) continue;
      const cn = /\bcredit_notes\b/.test(sql);
      const cc = /\bcustomer_credits\b/.test(sql);
      if (!cn && !cc) continue;
      geprueft++;
      const gefiltert = /status\s*!=\s*'CANCELLED'/.test(sql) || (!cn && /status\s*=\s*'OPEN'/.test(sql));
      if (!gefiltert && !ERLAUBT.some(([e]) => sql.includes(e))) offen.push(`${rel}: ${sql.slice(0, 100).replace(/\s+/g, ' ')}`);
    }
  }
  ok(geprueft >= 15 && offen.length === 0,
    `READERS jede Summe/Zählung über credit_notes/customer_credits lässt CANCELLED aus (${geprueft} Stellen) ${offen.join(' | ')}`);
  const h = codeOf(src('src/core/returns/return-cancel-house.ts'));
  ok(!/DELETE FROM (credit_notes|customer_credits)/.test(h) && /trackChange\('credit_notes', c\.id, 'update'/.test(h)
    && /trackChange\('customer_credits', ccId, 'update'/.test(h) && !/'delete'/.test(h),
  'HOUSE löscht weder Gutschrift noch Guthaben; beide reisen als Änderung, nicht als Löschung');
}
marker('CENTRAL_UI_R6E_CREDIT_NOTE_SCHEMA_PROVED');

// ══ §2 — Storno: Primary == PC2; die Gutschrift bleibt, jeder Leser steht wie VOR der Retoure ═══
const ARTEN: Art[] = ['unbezahlt-bar', 'guthaben', 'bezahlt-bar-offen'];
for (const art of ARTEN) {
  // Je Weg eine eigene Welt — nacheinander: die Leser lesen die AKTIVE Datenbank.
  const welten: Record<string, Welt> = {};
  let r: Ausgang = { ok: false, code: '', frozen: false, value: {}, replayed: false };
  for (const [weg, wer] of [['Primary', 'user-test'], ['PC2', 'user-pc2']] as Array<[string, string]>) {
    const w = welt(art);
    welten[weg] = w;
    ok(!!w.cnId && s(w.db, 'SELECT status FROM credit_notes WHERE id = ?', [w.cnId]) === 'ISSUED',
      `SETUP ${art}/${weg}: die freigegebene Retoure hat eine ausgestellte Gutschrift (${S(w.cnVor.credit_note_number)})`);
    ok(leserDiff(w.vor, w.mit).length > 0, `SETUP ${art}/${weg}: die Retoure hatte eine Wirkung auf die Leser (${leserDiff(w.vor, w.mit).length} Leser)`);
    if (art === 'guthaben') {
      ok(ccZeilen(w).length === 1 && String(ccZeilen(w)[0].status) === 'OPEN' && w.mit.guthaben === 1100,
        `SETUP guthaben/${weg}: ein offenes Store-Guthaben über 1100`);
    }
    const logVor = n(w.db, 'SELECT COUNT(*) FROM audit_log');
    const aus = weg === 'Primary'
      ? await primary(() => useSalesReturnStore.getState().cancelReturn(w.retId, GRUND))
      : await fern(() => rev.runReturnCancel(deps(w.db), identity(nx()), rumpf(w)));
    if (weg === 'PC2') r = aus;
    ok(aus.ok && n(w.db, 'SELECT COUNT(*) FROM audit_log') > logVor, `${art}/${weg} storniert (${aus.code || 'ok'})`);

    const cn = cnZeile(w);
    ok(cn.id === w.cnId && cn.credit_note_number === w.cnVor.credit_note_number,
      `${art}/${weg} die Gutschrift steht noch — mit ihrer Nummer (${S(cn.credit_note_number)})`);
    ok(cn.status === 'CANCELLED' && cn.cancelled_by === wer && /^\d{4}-\d\d-\d\dT/.test(String(cn.cancelled_at ?? ''))
      && cn.cancel_reason === 'Kunde behaelt die Uhr',
    `${art}/${weg} CANCELLED mit wann/wer/warum — wer = der, der storniert hat (${S([cn.status, cn.cancelled_by, cn.cancel_reason])})`);
    ok(unterschiede(ohne(w.cnVor, ['status', 'cancelled_by', 'cancel_reason']), ohne(cn, ['status', 'cancelled_by', 'cancel_reason'])).length === 0,
      `${art}/${weg} Nummer, Beträge, Methode, Verweise unverändert (${unterschiede(ohne(w.cnVor), ohne(cn)).join(' · ')})`);
    const cc = ccZeilen(w);
    if (art === 'guthaben') {
      ok(cc.length === 1 && cc[0].status === 'CANCELLED' && r3(cc[0].amount) === 1100 && r3(cc[0].used_amount) === 0,
        `${art}/${weg} das Store-Guthaben steht noch — CANCELLED, nicht einlösbar (${S(cc.map((c) => [c.status, c.amount, c.used_amount]))})`);
    } else {
      ok(cc.length === 0, `${art}/${weg} kein Guthaben (bar)`);
    }
    const nach = leser(w.db, w.invId);
    const diff = leserDiff(w.vor, nach);
    ok(diff.length === 0, `${art}/${weg} JEDER Leser steht wie VOR der Retoure (offene Posten, Guthaben, Forderungen, Abstimmung, Gegenpartei, Steuer, Umsatz, Rechnung, Ware, Salden) ${diff.join(' · ')}`);
    ok(balanced(w.db), `${art}/${weg} jede Buchung gleicht sich aus`);
    ok(n(w.db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'CREDIT_NOTE' AND source_id = ? AND reverses_entry_id IS NOT NULL", [w.cnId]) > 0
      && !posting.hasLedgerEntries('CREDIT_NOTE', w.cnId),
    `${art}/${weg} die Buchung der Gutschrift ist umgekehrt (Hauptbuch = Wahrheit, wie bisher)`);
    const a = row(w.db, "SELECT changed_by, changed_at, old_value, new_value FROM audit_log WHERE entity_type = 'credit_notes' AND entity_id = ? AND field_name = 'status'", [w.cnId]);
    ok(a.changed_by === wer && /^\d{4}-/.test(String(a.changed_at ?? '')) && /ISSUED/.test(String(a.old_value))
      && /"status":"CANCELLED"/.test(String(a.new_value)) && String(a.new_value).includes(String(w.cnVor.credit_note_number)),
    `${art}/${weg} Protokoll an der Gutschrift: ISSUED → CANCELLED, Mensch und Zeit (${S([a.changed_by, a.old_value])})`);
    const ar = row(w.db, "SELECT new_value FROM audit_log WHERE entity_type = 'sales_returns' AND field_name = 'cancel'");
    ok(String(ar.new_value).includes(`"cancelledCreditNoteNumbers":["${String(w.cnVor.credit_note_number)}"]`),
      `${art}/${weg} Protokoll der Retoure nennt die stornierte Gutschrift`);
    const cl = rows(w.db, "SELECT action, data FROM sync_changelog WHERE table_name IN ('credit_notes', 'customer_credits') AND record_id IN (SELECT id FROM credit_notes UNION SELECT id FROM customer_credits) ORDER BY rowid DESC");
    ok(n(w.db, "SELECT COUNT(*) FROM sync_changelog WHERE table_name IN ('credit_notes', 'customer_credits') AND action = 'delete'") === 0
      && cl.some((x) => x.action === 'update' && /"status":"CANCELLED"/.test(String(x.data)) && /"credit_note_number"/.test(String(x.data))),
    `${art}/${weg} Abgleich: die Gutschrift reist als Änderung mit Status (volle Zeile), keine Löschung`);
    const hist = loadCreditNotesFor(localReadContext()).creditNotes.find((c) => c.id === w.cnId);
    ok(!!hist && hist.status === 'CANCELLED' && hist.creditNoteNumber === w.cnVor.credit_note_number && hist.cancelReason === 'Kunde behaelt die Uhr',
      `${art}/${weg} Liste/Detail sehen sie als stornierte Historie (${S(hist?.status)})`);
  }
  const wP = welten.Primary;
  const wR = welten.PC2;
  ok(unterschiede(ohne(cnZeile(wP), ['cancelled_by', 'sales_return_id', 'invoice_id']), ohne(cnZeile(wR), ['cancelled_by', 'sales_return_id', 'invoice_id'])).length === 0
    && S(ccZeilen(wP).map((c) => ohne(c, ['source_id', 'created_by']))) === S(ccZeilen(wR).map((c) => ohne(c, ['source_id', 'created_by'])))
    && salden(wP.db) === salden(wR.db),
  `${art} PARITY lokal == fern: Gutschrift, Guthaben, Salden`);
  ok(Number(r.value.reversedCreditNotes) === 1 && S(r.value.cancelledCreditNoteNumbers) === S([wR.cnVor.credit_note_number])
    && Number(r.value.cancelledCustomerCredits) === (art === 'guthaben' ? 1 : 0),
  `${art} RESULT nennt die stornierte Gutschrift und das Guthaben (${S([r.value.reversedCreditNotes, r.value.cancelledCreditNoteNumbers, r.value.cancelledCustomerCredits])})`);
}
marker('CENTRAL_UI_R6E_CREDIT_NOTE_CANCEL_PARITY_PROVED');

// ══ §3 — Nachbuchung: eine stornierte Gutschrift bucht nie wieder ═══════════
{
  const w = welt('guthaben');
  await fern(() => rev.runReturnCancel(deps(w.db), identity(nx()), rumpf(w)));
  const vor = [lc(w.db), salden(w.db)];
  const res = backfillCreditNotes('branch-main');
  ok(res.skipped >= 1 && S([lc(w.db), salden(w.db)]) === S(vor) && !posting.hasLedgerEntries('CREDIT_NOTE', w.cnId),
    `BACKFILL die stornierte Gutschrift wird übersprungen, nichts gebucht (${S({ total: res.total, skipped: res.skipped })})`);
  // Ein Alt-Beleg ohne je gebuchtes Hauptbuch: stornierte bleibt ungebucht, ausgestellte wird nachgebucht.
  for (const [id, st] of [['cn-legacy-x', 'CANCELLED'], ['cn-legacy-ok', 'ISSUED']]) {
    insert(w.db, 'credit_notes', {
      id, branch_id: 'branch-main', credit_note_number: id.toUpperCase(), invoice_id: w.invId, customer_id: 'cust-1',
      issued_at: NOW, total_amount: 50, vat_amount: 0, cash_refund_amount: 0, receivable_cancel_amount: 50,
      status: st, created_at: NOW,
    });
  }
  const res2 = backfillCreditNotes('branch-main');
  ok(n(w.db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'CREDIT_NOTE' AND source_id = 'cn-legacy-x'") === 0
    && n(w.db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'CREDIT_NOTE' AND source_id = 'cn-legacy-ok'") > 0
    && res2.errors.length === 0 && balanced(w.db),
  `BACKFILL Alt-Beleg: CANCELLED ohne Hauptbuch bleibt ungebucht, ISSUED wird nachgebucht (Kontrolle) (${S({ skipped: res2.skipped, errors: res2.errors })})`);
}
marker('CENTRAL_UI_R6E_CREDIT_NOTE_BACKFILL_PROVED');

// ══ §4 — Wiederholung und verlorene Antwort: genau einmal ═══════════════════
{
  const w = welt('guthaben');
  const x = nx();
  const body = rumpf(w);
  const a = await fern(() => rev.runReturnCancel(deps(w.db), identity(x), body));
  const nachA = zustand(w);
  const b = await fern(() => rev.runReturnCancel(deps(w.db), identity(x), body));
  ok(a.ok && b.ok && b.replayed && S(a.value) === S(b.value) && zustand(w) === nachA,
    'LOST dieselbe Kennung: eingefrorene Antwort, genau eine Wirkung (Gutschrift, Guthaben, Buchungen, Protokoll, Abgleich)');
  ok(n(w.db, "SELECT COUNT(*) FROM audit_log WHERE entity_type = 'credit_notes' AND field_name = 'status'") === 1,
    'LOST genau EIN Storno-Eintrag an der Gutschrift');
  const c = await fern(() => rev.runReturnCancel(deps(w.db), identity(nx()), { ...body, expectedRevision: rrev(w.db, w.retId) }));
  ok(!c.ok && c.code === 'RETURN_ALREADY_CANCELLED' && c.frozen && zustand(w) === nachA,
    `AGAIN fern: ein neuer Auftrag auf die stornierte Retoure → eingefrorenes RETURN_ALREADY_CANCELLED, nichts ändert sich (${c.code})`);
  const pr = await primary(() => useSalesReturnStore.getState().cancelReturn(w.retId, 'noch einmal'));
  ok(pr.ok && zustand(w) === nachA, 'AGAIN Primary: idempotenter No-op — nichts ändert sich');
  const hs = meldung(() => imHaus(() => cancelHouse.cancelReturnInHouse(w.retId, 'x', { userId: 'u', role: 'ADMIN' }, 'branch-main')));
  ok(/already cancelled/.test(hs) && zustand(w) === nachA, `AGAIN Hausfolge direkt: Nein vor jedem Schreiben (${hs})`);
  ok(s(w.db, 'SELECT cancelled_by FROM credit_notes WHERE id = ?', [w.cnId]) === 'user-pc2',
    'AGAIN der erste Storno bleibt der gültige (kein Überschreiben von wer/wann)');
}
marker('CENTRAL_UI_R6E_CREDIT_NOTE_EXACTLY_ONCE_PROVED');

// ══ §5 — Fehlerinjektion: kein halber Stand ══════════════════════════════════
{
  const FEHLER: Array<[string, Art, RegExp | 'audit']> = [
    ['Storno der Gutschrift', 'guthaben', /UPDATE credit_notes SET status/],
    ['Storno des Guthabens', 'guthaben', /UPDATE customer_credits SET status/],
    ['Protokoll der Gutschrift', 'unbezahlt-bar', 'audit'],
    ['Stornobuchung', 'bezahlt-bar-offen', /INSERT INTO ledger_entries/],
  ];
  for (const [was, art, wo] of FEHLER) {
    for (const weg of ['primary', 'fern'] as const) {
      const w = welt(art);
      const vor = zustand(w);
      const x = nx();
      let aus: Ausgang;
      if (wo === 'audit') {
        w.db.run("CREATE TRIGGER cn_bruch BEFORE INSERT ON audit_log WHEN NEW.entity_type = 'credit_notes' BEGIN SELECT RAISE(ABORT, 'R6E-CN: injected'); END");
        try {
          aus = weg === 'primary'
            ? await primary(() => useSalesReturnStore.getState().cancelReturn(w.retId, GRUND))
            : await fern(() => rev.runReturnCancel(deps(w.db), identity(x), rumpf(w)));
        } finally { w.db.run('DROP TRIGGER IF EXISTS cn_bruch'); }
      } else {
        const bad = faulty(w.db, wo);
        setTestDatabase(bad as never);
        try {
          aus = weg === 'primary'
            ? await primary(() => useSalesReturnStore.getState().cancelReturn(w.retId, GRUND))
            : await fern(() => rev.runReturnCancel(deps(bad), identity(x), rumpf(w)));
        } finally { setTestDatabase(w.db as never); }
      }
      ok(!aus.ok && zustand(w) === vor,
        `ATOMIC ${weg} ${was} scheitert: Retoure, Gutschrift, Guthaben, Rechnung, Lose, Hauptbuch, Abgleich, Protokoll unverändert (${aus.code.slice(0, 60)})`);
      if (weg === 'fern') ok(lookupCommand(w.db as never, identity(x) as never).kind === 'fresh', `ATOMIC fern ${was}: die Kennung bleibt frei`);
      const heil = weg === 'primary'
        ? await primary(() => useSalesReturnStore.getState().cancelReturn(w.retId, GRUND))
        : await fern(() => rev.runReturnCancel(deps(w.db), identity(x), rumpf(w)));
      ok(heil.ok && s(w.db, 'SELECT status FROM credit_notes WHERE id = ?', [w.cnId]) === 'CANCELLED' && balanced(w.db),
        `ATOMIC ${weg} ${was}: danach gelingt es (${heil.code || 'ok'})`);
    }
  }
}
marker('CENTRAL_UI_R6E_CREDIT_NOTE_ATOMICITY_PROVED');

// ══ §6 — Folgeleser: was eine stornierte Gutschrift nicht mehr sperren oder zählen darf ═══
{
  // (a) Deckel: dieselbe Zeile lässt sich nach dem Storno erneut zurückgeben — die neue Gutschrift
  //     passt unter das Brutto, weil die stornierte nicht mehr mitzählt.
  const w = welt('unbezahlt-bar');
  await fern(() => rev.runReturnCancel(deps(w.db), identity(nx()), rumpf(w)));
  let neu = '';
  const cap = meldung(() => { neu = retoure(w.db, w.invId, w.lineId, 'cash'); });
  ok(!cap && s(w.db, 'SELECT status FROM sales_returns WHERE id = ?', [neu]) === 'APPROVED'
    && all(w.db, 'SELECT status FROM credit_notes ORDER BY status') === S([['CANCELLED'], ['ISSUED']]),
  `CAP eine neue Retoure derselben Zeile wird freigegeben — Deckel frei, alte Gutschrift bleibt CANCELLED (${cap || 'ok'})`);
  ok(s(w.db, 'SELECT status FROM invoices WHERE id = ?', [w.invId]) === 'RETURNED' && useCustomerStore.getState().getOutstanding('cust-1').outstanding === 0,
    'CAP …und nur die NEUE Gutschrift deckt die Forderung (Rechnung RETURNED, offen 0)');
  ok(balanced(w.db), 'CAP jede Buchung gleicht sich aus');

  // (b) Rechnungsstorno nach Retourenstorno: „keine Retouren/Gutschriften" gilt, und M-04 dreht die
  //     Rechnung VOLL zurück (die stornierte Gutschrift hat nichts mehr umgekehrt).
  const w2 = welt('unbezahlt-bar');
  await fern(() => rev.runReturnCancel(deps(w2.db), identity(nx()), rumpf(w2)));
  const inv = meldung(() => imHaus(() => reversal.reverseInvoiceInHouse(w2.invId, 'branch-main',
    { requireNoReturns: { code: 'INVOICE_HAS_RETURNS', message: 'has returns' } })));
  const arKunde = n(w2.db, "SELECT COALESCE(ROUND(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END), 3), 0) FROM ledger_entries WHERE account = 'ACCOUNTS_RECEIVABLE' AND counterparty_id = 'cust-1'");
  ok(!inv && s(w2.db, 'SELECT status FROM invoices WHERE id = ?', [w2.invId]) === 'CANCELLED' && Math.abs(arKunde) < 0.0005
    && all(w2.db, "SELECT qty_remaining, status FROM stock_lots WHERE id = 'lot-p2'") === S([[1, 'ACTIVE']]) && balanced(w2.db),
  `INVOICE-CANCEL nach Retourenstorno: nicht gesperrt, Forderung 0, Ware zurück (${inv || 'ok'}, AR ${arKunde})`);

  // (c) editInvoice: eine wirksame Retoure/Gutschrift sperrt den PREIS der retournierten Zeile
  //     (INVOICE-EDIT S2 — früher die ganze Rechnung); nach dem Retourenstorno ist er wieder frei.
  const edit = (x: Welt): string => meldung(() => imHaus(() => useInvoiceStore.getState().editInvoice(x.invId, {
    lines: [{ productId: 'p2', unitPrice: 900, purchasePrice: 100, taxScheme: 'VAT_10', vatRate: 10, vatAmount: 90, lineTotal: 990 }],
    reason: 'Korrektur',
  })));
  const wk = welt('unbezahlt-bar');
  const kontrolle = edit(wk);
  const w3 = welt('unbezahlt-bar');
  await fern(() => rev.runReturnCancel(deps(w3.db), identity(nx()), rumpf(w3)));
  const nachStorno = edit(w3);
  ok(/cannot be changed — it has a return/.test(kontrolle) && !/it has a return/.test(nachStorno),
    `EDIT wirksame Retoure sperrt den Preis der Zeile (Kontrolle), nach dem Storno nicht mehr (${nachStorno || 'ok'})`);

  // (d) Löschen: eine stornierte Gutschrift ist die Spur ihres Stornos.
  const w4 = welt('guthaben');
  await fern(() => rev.runReturnCancel(deps(w4.db), identity(nx()), rumpf(w4)));
  const del = meldung(() => imHaus(() => useCreditNoteStore.getState().deleteCreditNote(w4.cnId)));
  ok(/cancelled/.test(del) && s(w4.db, 'SELECT status FROM credit_notes WHERE id = ?', [w4.cnId]) === 'CANCELLED' && ccZeilen(w4).length === 1,
    `DELETE eine stornierte Gutschrift lässt sich nicht löschen (${del})`);

  // (e) Nachziehen einer Erstattung: eine stornierte Gutschrift wird nie neu gebucht.
  const w5 = welt('bezahlt-bar-offen');
  await fern(() => rev.runReturnCancel(deps(w5.db), identity(nx()), rumpf(w5)));
  const lcVor = n(w5.db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'CREDIT_NOTE'");
  useSalesReturnStore.getState().loadReturns();
  meldung(() => imHaus(() => useSalesReturnStore.getState().recordRefundPayment(w5.retId, 100, 'cash')));
  ok(n(w5.db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'CREDIT_NOTE'") === lcVor && !posting.hasLedgerEntries('CREDIT_NOTE', w5.cnId)
    && s(w5.db, 'SELECT status FROM credit_notes WHERE id = ?', [w5.cnId]) === 'CANCELLED',
  'REPOST die stornierte Gutschrift wird von der Erstattungs-Nachführung weder geändert noch neu gebucht');
}
marker('CENTRAL_UI_R6E_CREDIT_NOTE_READERS_PROVED');

// ══ §7 — Oberfläche: sichtbar als stornierte Historie ════════════════════════
{
  const list = codeOf(src('src/pages/credit-notes/CreditNoteList.tsx'));
  ok(/data-credit-note-status=/.test(list) && /data-credit-note-cancelled/.test(list) && /filter\(cn => cn\.status !== 'CANCELLED'\)/.test(list),
    'UI Liste: jede Gutschrift sichtbar, stornierte markiert, Summen ohne sie');
  const det = codeOf(src('src/pages/credit-notes/CreditNoteDetail.tsx'));
  ok(/data-credit-note-cancelled-banner/.test(det) && /\{!cancelled && \(\s*<Button[^>]*onClick=\{handleDelete\}/.test(det),
    'UI Detail: Storno-Hinweis (wann, warum), kein Löschen einer stornierten Gutschrift');
  const inv = codeOf(src('src/pages/invoices/InvoiceDetail.tsx'));
  ok((inv.match(/cn\.invoiceId === inv(oice)?\.id && cn\.status !== 'CANCELLED'/g) || []).length === 2,
    'UI Rechnung: „Credited"-Status und offener Rest zählen nur wirksame Gutschriften');
}
marker('CENTRAL_UI_R6E_CREDIT_NOTE_UI_PROVED');

// ══ §8 — Vertrag: eine bereits ERSTATTETE Retoure ist nicht stornierbar ══════
// Bestehende Regel (vor R6E im Store, seither in der Hausfolge): ist auf die Retoure schon eine Erstattung
// verbucht (`sales_returns.refund_paid_amount > 0`), bietet die Maske kein „Cancel Return" an, und die
// Hausfolge weist ab — Primary wie PC2 — ohne irgendetwas zu schreiben. Das gilt für jede verbuchte
// Erstattung: Bargeld/Bank/Karte UND ein Store-Guthaben, das über „Refund" als Erstattung gebucht wurde
// (`recordRefundPayment(…, 'credit')`: refund_status REFUNDED, Buchung CR CUSTOMER_CREDIT). Einen Rückholweg
// (Erstattung zurückbuchen) gibt es nicht — R6E erfindet keinen; der Knopf nennt den Grund.
const codeVon = (fn: () => unknown): string => { try { fn(); return ''; } catch (e) { return String((e as { code?: unknown }).code ?? (e as Error).message); } };
async function erstattetGesperrt(w: Welt, was: string, erstatten: () => void): Promise<void> {
  useSalesReturnStore.getState().loadReturns();
  const f = meldung(() => imHaus(erstatten));
  const bezahlt = n(w.db, 'SELECT refund_paid_amount FROM sales_returns WHERE id = ?', [w.retId]);
  ok(!f && bezahlt > 0.005 && salden(w.db) !== S(w.mit.salden) ,
    `PAID ${was}: die Erstattung ist verbucht (refund_paid_amount ${bezahlt}, Hauptbuch bewegt) ${f}`);
  reload();
  const cb = useSalesReturnStore.getState().getReturnCancelability(w.retId);
  ok(cb.canCancel === false && /already been paid out/.test(String(cb.blockReason)),
    `PAID ${was}: die Maske bietet kein „Cancel Return" an und nennt den Grund (${S(cb)})`);
  const vor = zustand(w);
  const lokal = codeVon(() => imHaus(() => cancelHouse.cancelReturnInHouse(w.retId, 'Storno', { userId: 'user-test', role: 'ADMIN' }, 'branch-main')));
  ok(lokal === cancelHouse.RETURN_REFUND_PAID_OUT && zustand(w) === vor,
    `PAID ${was}: am Primary abgewiesen (${lokal}), nichts geschrieben — Retoure, Gutschrift, Guthaben, Hauptbuch, Protokoll unverändert`);
  const fernR = await fern(() => rev.runReturnCancel(deps(w.db), identity(nx()), rumpf(w)));
  ok(!fernR.ok && fernR.code === cancelHouse.RETURN_REFUND_PAID_OUT && fernR.frozen && zustand(w) === vor,
    `PAID ${was}: fern ein eingefrorenes Nein (${fernR.code}), nichts geschrieben`);
  ok(s(w.db, 'SELECT status FROM credit_notes WHERE id = ?', [w.cnId]) === 'ISSUED', `PAID ${was}: die Gutschrift bleibt wirksam (ISSUED)`);
}
{
  const wb = welt('bezahlt-bar-offen');
  await erstattetGesperrt(wb, 'bar (Teil-Erstattung 500)', () => useSalesReturnStore.getState().recordRefundPayment(wb.retId, 500, 'cash'));
  const wg = welt('guthaben');
  await erstattetGesperrt(wg, 'Store-Guthaben über „Refund"', () => useSalesReturnStore.getState().refundReturn(wg.retId));
  ok(s(wg.db, 'SELECT refund_method FROM sales_returns WHERE id = ?', [wg.retId]) === 'credit'
    && S(ccZeilen(wg).map((c) => c.status)) === S(['OPEN']),
  'PAID Store-Guthaben: als Erstattung „credit" verbucht, das Guthaben bleibt einlösbar (OPEN)');
  // Kontrolle: dasselbe Guthaben OHNE verbuchte Erstattung (nur freigegeben) ist stornierbar — der Riegel
  // hängt an der Erstattung, nicht am Guthaben.
  const wf = welt('guthaben');
  reload();
  ok(useSalesReturnStore.getState().getReturnCancelability(wf.retId).canCancel === true
    && n(wf.db, 'SELECT refund_paid_amount FROM sales_returns WHERE id = ?', [wf.retId]) === 0,
  'PAID Kontrolle: freigegebenes, noch nicht als Erstattung verbuchtes Guthaben bleibt stornierbar');
  const ui = codeOf(src('src/pages/invoices/InvoiceDetail.tsx'));
  ok(/cb\.canCancel \? \(/.test(ui) && /Cannot cancel: \{cb\.blockReason\}/.test(ui) && /getReturnCancelability\(r\.id\)/.test(ui),
    'PAID die Maske fragt dieselbe Regel (returnCancelability) und zeigt statt des Knopfs den Grund');
  const h = codeOf(src('src/core/returns/return-cancel-house.ts'));
  ok(/if \(auszahlungGeflossen\(r\)\)/.test(h) && /throw new ReturnCancelRejected\(RETURN_REFUND_PAID_OUT/.test(h),
    'PAID Knopf-Regel und Hausfolge teilen denselben Riegel (auszahlungGeflossen)');
}
marker('CENTRAL_UI_R6E_PAID_REFUND_CANCEL_CONTRACT_PINNED');

// ══ §9 — Leser: wer credit_notes liest — und wer ausdrücklich NICHT ═══════════
{
  // Jede Datei, deren CODE (ohne Kommentare) die Tabelle nennt, ist hier eingeordnet. Ein neuer Leser
  // fällt auf, statt still eine stornierte Gutschrift mitzuzählen.
  const KLASSEN: Record<string, string> = {
    'src/core/bridge/return-commands.ts': 'Verweis (Gutschrift der Freigabe), keine Summe',
    'src/core/bridge/store-read-ops.ts': 'Name der Auskunft store.credit_notes.get',
    'src/core/data/page-reads.ts': 'Summen/Zählungen ohne CANCELLED',
    'src/core/finance/receivables.ts': 'Summen ohne CANCELLED',
    'src/core/invoices/invoice-cancel-house.ts': 'Storno-Sperre bei wirksamer Gutschrift ohne CANCELLED',
    'src/core/invoices/edit-lines.ts': 'Edit-Grenzen (INVOICE-EDIT S2): Gutschriften-Deckel und Forderungsminderung ohne CANCELLED',
    'src/core/invoices/customer-change.ts': 'Kundenwechsel (INVOICE-EDIT S3): wirksame Gutschrift (ohne CANCELLED) sperrt den Wechsel',
    'src/core/invoices/invoice-reversal.ts': 'requireNoReturns ohne CANCELLED',
    'src/core/ledger/backfill.ts': 'Nachbuchung überspringt CANCELLED',
    'src/core/ledger/counterpartyAudit.ts': 'Gegenpartei-Prüfung ohne CANCELLED',
    'src/core/reports/reconciliation-snapshot.ts': 'Abstimmung ohne CANCELLED',
    'src/core/returns/return-cancel-house.ts': 'der Storno selbst (setzt CANCELLED)',
    'src/core/sync/sync-service.ts': 'Tabellenzuordnung des Abgleichs',
    'src/core/db/database.ts': 'Schema/Migration',
    'src/stores/bankingStore.ts': 'Verweis; Retouren REJECTED und Guthaben-Erstattung ausgeschlossen',
    'src/stores/creditNoteStore.ts': 'Liste (mit Status) und Löschsperre',
    'src/stores/customerStore.ts': 'Kundensaldo/-kennzahlen ohne CANCELLED',
    'src/stores/invoiceStore.ts': 'M-04, Deckel ohne CANCELLED (Guard B ist seit INVOICE-EDIT S2 gezielt in edit-lines.ts)',
    'src/stores/payablesStore.ts': 'Verweis; nur APPROVED/REFUNDED-Retouren',
    'src/stores/salesReturnStore.ts': 'RETURNED-Prüfung, Riegel, Nachziehen ohne CANCELLED',
  };
  const gefunden: string[] = [];
  for (const rel of readdirSync(resolvePath(repo, 'src'), { recursive: true, encoding: 'utf8' })) {
    if (!/\.(ts|tsx)$/.test(rel)) continue;
    const p = 'src/' + rel.replace(/\\/g, '/');
    if (/\bcredit_notes\b/.test(codeOf(src(p)))) gefunden.push(p);
  }
  const fremd = gefunden.filter((p) => !(p in KLASSEN));
  ok(fremd.length === 0 && Object.keys(KLASSEN).every((p) => gefunden.includes(p)),
    `LESER jede Datei mit credit_notes im Code ist eingeordnet (${gefunden.length}; neu: ${fremd.join(', ') || 'keine'})`);
  // NOT A CONSUMER — Steuer, Quartal, NBR-Export, Umsatzkennzahlen, Hauptbuch-Abfragen lesen die Tabelle nicht.
  for (const [f, was] of [['src/core/reports/analytics-snapshot.ts', 'Steuer/Quartal (financeFor)'], ['src/pages/invoices/InvoiceList.tsx', 'NBR-Export'],
    ['src/core/reports/sales-metrics.ts', 'Umsatzkennzahlen'], ['src/core/reports/sales-metrics-loader.ts', 'Umsatz-Lader'], ['src/core/ledger/queries.ts', 'Hauptbuch/vatPosition']] as const) {
    ok(existsSync(resolvePath(repo, f)) && !/\bcredit_notes\b/.test(codeOf(src(f))), `NOT A CONSUMER ${was}: ${f} liest credit_notes nicht`);
  }
  ok(/status != 'REJECTED'/.test(codeOf(src('src/stores/bankingStore.ts'))) && /r\.status IN \('APPROVED', 'REFUNDED'\)/.test(codeOf(src('src/stores/payablesStore.ts'))),
    'LESER Bank und Verbindlichkeiten nehmen nur lebende Retouren — eine stornierte Retoure (REJECTED) samt Gutschrift wirkt dort nicht');

  // Wirksam wie bisher, storniert ohne Wirkung, aber sichtbar.
  const w = welt('unbezahlt-bar');
  const aktiv = leserDiff(w.vor, w.mit);
  ok(['offenePosten', 'forderungen', 'kundenGutschriften', 'salden'].every((k) => aktiv.some((d) => d.startsWith(k + ':'))),
    `AKTIV eine ausgestellte Gutschrift wirkt wie bisher (Offene Posten, Forderungen, Kunden-Gutschriften, Hauptbuch) — ${aktiv.length} Leser bewegt`);
  const r = await fern(() => rev.runReturnCancel(deps(w.db), identity(nx()), rumpf(w)));
  const nach = leser(w.db, w.invId);
  ok(r.ok && leserDiff(w.vor, nach).length === 0, `STORNIERT ohne finanzielle Wirkung — jeder Leser wie vor der Retoure (${leserDiff(w.vor, nach).join(' · ') || 'gleich'})`);
  const liste = loadCreditNotesFor(localReadContext()).creditNotes as Array<Record<string, unknown>>;
  const sichtbar = liste.find((c) => c.id === w.cnId);
  ok(!!sichtbar && sichtbar.status === 'CANCELLED' && sichtbar.creditNoteNumber === w.cnVor.credit_note_number && !!sichtbar.cancelledBy,
    `SICHTBAR die stornierte Gutschrift steht mit Nummer, Status und Urheber des Stornos in der Liste (${S(sichtbar && { s: sichtbar.status, n: sichtbar.creditNoteNumber, by: sichtbar.cancelledBy })})`);
  const del = meldung(() => imHaus(() => useCreditNoteStore.getState().deleteCreditNote(w.cnId)));
  ok(/cancelled/.test(del) && s(w.db, 'SELECT status FROM credit_notes WHERE id = ?', [w.cnId]) === 'CANCELLED', `DELETE bleibt gesperrt (${del})`);
}
marker('CENTRAL_UI_R6E_CREDIT_NOTE_READER_CLASSES_PINNED');

if (fails.length === 0) console.log('CENTRAL_UI_R6E_CREDIT_NOTE_REVERSAL_PROVED');
console.log(`\n${fails.length === 0 ? 'OK' : 'FAIL'} — central ui parity r6e credit note reversal: ${PASS} passed, ${fails.length} failed`);
for (const f of fails) console.log('  - ' + f);
process.exit(fails.length === 0 ? 0 : 1);
