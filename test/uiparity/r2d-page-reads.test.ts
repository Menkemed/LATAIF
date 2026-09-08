// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R2D — die zwölf Flächen, die bisher selbst abfragten.
// Run: node --experimental-strip-types test/uiparity/r2d-page-reads.test.ts
//
// Bis R2C stellten ein Dutzend Seiten und Masken ihre Abfrage selbst: Artikeldetail, Suche,
// Lieferant, Kunde, Auftrag, Einkaufsanlage, Zahlungsmaske, Rechnungsliste, Sammlung, Übersicht,
// Auftragsliste, Gold-Modal. Am Primary war das richtig. Auf einem Rechner ohne Datenbank fing
// jedes \`try\` seinen Fehler ab — die Flächen waren dort still leer.
//
// Dieses Gate prüft, was jetzt gilt, und zwar an echten Zeilen in drei Filialen:
//
//   A  Jede der zwölf Auskünfte antwortet — und zwar mit den Daten des ANFRAGENDEN.
//   B  Eine Kennung ist Auswahl, keine Erlaubnis: dieselbe Kennung aus einer fremden Filiale
//      liefert NICHTS, nicht etwa fremde Daten.
//   C  Die Sitzung des Menschen am Primary (hier absichtlich eine dritte Filiale) ändert nichts.
//   D  Ein Filialwunsch im Rumpf ändert nichts.
//   E  Die Suche findet über alle Belegarten nur Eigenes.
//   F  Kein Fernlesen fasst den Bildschirm des Primary an.
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    if (specifier === '@tauri-apps/api/core' || specifier === '@tauri-apps/api/event') {
      return { url: pathToFileURL(resolvePath(repo, 'test/bridge/_tauri-shim.ts')).href, shortCircuit: true };
    }
    if (specifier === '@/core/db/database' || specifier === './database' || specifier === '../db/database') {
      return { url: pathToFileURL(resolvePath(repo, 'test/sync/_db-shim.ts')).href, shortCircuit: true };
    }
    if (specifier === '../auth/auth' || specifier === '@/core/auth/auth') {
      return { url: pathToFileURL(resolvePath(repo, 'test/uiparity/_auth-switch.ts')).href, shortCircuit: true };
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

const store = new Map<string, string>([['lataif_session', JSON.stringify({ branchId: 'branch-c', userId: 'user-c' })]]);
const storage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};
(globalThis as { localStorage?: unknown }).localStorage = storage;
(globalThis as { window?: unknown }).window = { localStorage: storage };

let PASS = 0; const fails: string[] = [];
const ok = (c: boolean, m: string) => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string) => readFileSync(resolvePath(repo, p), 'utf8');

interface Db { run(sql: string, p?: unknown[]): unknown; exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>; }
const initSqlJs = (await import('sql.js')).default;
const SQL = await initSqlJs({ locateFile: (f: string) => resolvePath(repo, 'node_modules/sql.js/dist', f) });
const { setTestDatabase } = await import('../sync/_db-shim.ts');
const { setPrimarySession } = await import('./_auth-switch.ts');
const { executeCommand } = await import('../../src/core/bridge/command-registry.ts');
await import('../../src/core/bridge/store-read-commands.ts');

const NOW = '2026-09-08T00:00:00.000Z';
function realMigrations(): string[] {
  const dbSrc = src('src/core/db/database.ts');
  const start = dbSrc.indexOf('const migrations: string[] = [');
  const end = dbSrc.indexOf('\n  ];', start);
  return [...dbSrc.slice(start, end).matchAll(/`([^`]*)`/g)].map((m) => m[1]);
}
const MIGRATIONS = realMigrations();

/**
 * Zwei Filialen mit vollem Satz an Belegen, dazu eine dritte für den Menschen am Primary.
 * Jede Zeile in A hat ihr Gegenstück in B — so ist „leer" nie mit „kaputt" zu verwechseln.
 */
let db: Db;
function fixture(): void {
  db = new SQL.Database() as unknown as Db;
  db.run(src('src/core/db/schema.sql'));
  for (const stmt of MIGRATIONS) { try { db.run(stmt); } catch { /* schon da */ } }

  for (const b of ['branch-a', 'branch-b', 'branch-c']) {
    const k = b.slice(-1);                      // a | b | c
    db.run('INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES (?,?,?,?,?)', [b, 'tenant-1', 'Filiale ' + k, NOW, NOW]);
    db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, company, country, language,
        vip_level, preferences, customer_type, sales_stage, created_at, updated_at)
      VALUES (?,?,?,?,'','BH','en','NONE','[]','PRIVATE','active',?,?)`, ['cust-' + k, b, 'Zenith' + k.toUpperCase(), 'Kunde', NOW, NOW]);
    db.run(`INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?)`, ['cat-' + k, b, 'Kat', 'w', '#000', NOW, NOW]);
    db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, condition, scope_of_delivery,
        purchase_price, purchase_currency, planned_sale_price, stock_status, tax_scheme, days_in_stock,
        quantity, images, attributes, source_type, created_at, updated_at)
      VALUES (?,?,?,?,'Uhr',?, 'Pre-Owned','[]',100,'BHD',150,'in_stock','VAT_10',0,1,'[]','{}','OWN',?,?)`,
    ['prod-' + k, b, 'cat-' + k, 'Zenith' + k.toUpperCase(), 'SKU-' + k, NOW, NOW]);
    db.run(`INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at)
      VALUES (?,?,?,1,?,?)`, ['sup-' + k, b, 'Zenith' + k.toUpperCase() + ' Supply', NOW, NOW]);
    db.run(`INSERT INTO settings (branch_id, key, value, category, updated_at)
      VALUES (?, 'finance.monthly_target', ?, 'finance', ?)`, [b, k === 'a' ? '5000' : '7000', NOW]);

    // Rechnung + Zahlung
    db.run(`INSERT INTO invoices (id, branch_id, invoice_number, customer_id, status, net_amount,
        vat_rate_snapshot, vat_amount, gross_amount, tax_scheme_snapshot, paid_amount, issued_at, created_at, updated_at)
      VALUES (?,?,?,?, 'PARTIAL', 90, 10, 10, 100, 'VAT_10', 30, ?, ?, ?)`,
    ['inv-' + k, b, 'INV-' + k.toUpperCase(), 'cust-' + k, NOW, NOW, NOW]);
    db.run(`INSERT INTO payments (id, branch_id, invoice_id, amount, method, received_at, created_at)
      VALUES (?,?,?,30,'cash',?,?)`, ['pay-' + k, b, 'inv-' + k, NOW, NOW]);
    db.run(`INSERT INTO invoice_lines (id, invoice_id, product_id, quantity, unit_price, vat_rate, vat_amount, line_total, position, tax_scheme)
      VALUES (?,?,?,1,100,10,10,100,0,'VAT_10')`, ['il-' + k, 'inv-' + k, 'prod-' + k]);
    db.run(`INSERT INTO credit_notes (id, branch_id, credit_note_number, invoice_id, customer_id, issued_at,
        total_amount, vat_amount, cash_refund_amount, receivable_cancel_amount, created_at)
      VALUES (?,?,?,?,?,?,20,0,0,20,?)`, ['cn-' + k, b, 'CN-' + k.toUpperCase(), 'inv-' + k, 'cust-' + k, NOW, NOW]);
    db.run(`INSERT INTO sales_returns (id, branch_id, return_number, invoice_id, customer_id, status,
        total_amount, vat_corrected, return_date, refund_amount, refund_paid_amount, refund_method, refund_paid_date, created_at)
      VALUES (?,?,?,?,?, 'APPROVED', 20, 0, ?, 20, 20, 'cash', ?, ?)`,
    ['sr-' + k, b, 'RET-' + k.toUpperCase(), 'inv-' + k, 'cust-' + k, NOW, NOW, NOW]);

    // Auftrag samt Zeile und Anzahlung
    db.run(`INSERT INTO orders (id, branch_id, order_number, customer_id, requested_brand, requested_model,
        status, agreed_price, created_at, updated_at)
      VALUES (?,?,?,?, 'Zenith', 'Elite', 'PENDING', 500, ?, ?)`,
    ['ord-' + k, b, 'ORD-' + k.toUpperCase(), 'cust-' + k, NOW, NOW]);
    db.run(`INSERT INTO order_lines (id, order_id, product_id, description, quantity, unit_price, line_total, position, created_at)
      VALUES (?,?,?,'Zeile',1,100,100,0,?)`, ['ol-' + k, 'ord-' + k, 'prod-' + k, NOW]);
    db.run(`INSERT INTO order_payments (id, order_id, amount, paid_at, method, converted_to_invoice, created_at)
      VALUES (?,?,?,?,'cash',0,?)`, ['op-' + k, 'ord-' + k, k === 'a' ? 60 : 80, NOW, NOW]);

    // Einkauf samt Zeile, Zahlung, Retoure
    db.run(`INSERT INTO purchases (id, branch_id, purchase_number, supplier_id, status,
        total_amount, paid_amount, remaining_amount, purchase_date, created_at, updated_at)
      VALUES (?,?,?,?, 'PARTIALLY_PAID', 200, 50, 150, ?, ?, ?)`,
    ['pur-' + k, b, 'PUR-' + k.toUpperCase(), 'sup-' + k, NOW, NOW, NOW]);
    db.run(`INSERT INTO purchase_lines (id, purchase_id, product_id, quantity, unit_price, line_total, position, source_order_line_id)
      VALUES (?,?,?,1,200,200,0,?)`, ['pl-' + k, 'pur-' + k, 'prod-' + k, 'ol-' + k]);
    db.run(`INSERT INTO purchase_payments (id, purchase_id, amount, method, paid_at, created_at)
      VALUES (?,?,50,'bank',?,?)`, ['pp-' + k, 'pur-' + k, NOW, NOW]);
    db.run(`INSERT INTO purchase_returns (id, branch_id, return_number, supplier_id, purchase_id,
        total_amount, return_date, status, created_at)
      VALUES (?,?,?,?,?,10,?, 'APPROVED', ?)`,
    ['pret-' + k, b, 'PRET-' + k.toUpperCase(), 'sup-' + k, 'pur-' + k, NOW, NOW]);
    db.run(`INSERT INTO stock_lots (id, branch_id, product_id, purchase_id, qty_total, qty_remaining,
        unit_cost, status, acquired_at, created_at) VALUES (?,?,?,?,1,1,100,'ACTIVE',?,?)`,
    ['lot-' + k, b, 'prod-' + k, 'pur-' + k, NOW, NOW]);

    // Reparatur, Ausgabe, Fertigung, Edelmetall, Wareneingang
    db.run(`INSERT INTO repairs (id, branch_id, repair_number, customer_id, issue_description, received_at, status, created_at, updated_at)
      VALUES (?,?,?,?, 'Service', ?, 'in_progress', ?, ?)`, ['rep-' + k, b, 'REP-' + k.toUpperCase(), 'cust-' + k, NOW, NOW, NOW]);
    db.run(`INSERT INTO expenses (id, branch_id, expense_number, category, amount, paid_amount, payment_method,
        status, expense_date, description, related_module, related_entity_id, supplier_id, created_at)
      VALUES (?,?,?, 'Workshop', 40, 0, 'cash', 'OPEN', ?, 'Arbeit', 'repair', ?, ?, ?)`,
    ['exp-' + k, b, 'EXP-' + k.toUpperCase(), NOW, 'rep-' + k, 'sup-' + k, NOW]);
    db.run(`INSERT INTO production_records (id, branch_id, record_number, production_date, total_value, status, created_at)
      VALUES (?,?,?,?,100,'CONFIRMED',?)`, ['prd-' + k, b, 'PRD-' + k.toUpperCase(), NOW, NOW]);
    db.run(`INSERT INTO production_inputs (id, record_id, product_id, input_value) VALUES (?,?,?,100)`, ['pi-' + k, 'prd-' + k, 'prod-' + k]);
    db.run(`INSERT INTO precious_metals (id, branch_id, metal_type, karat, weight_grams, status, created_at, updated_at)
      VALUES (?,?, 'gold', '21K', ?, 'in_stock', ?, ?)`, ['met-' + k, b, k === 'a' ? 11 : 22, NOW, NOW]);
    db.run(`INSERT INTO purchase_inbox (id, branch_id, images, note, created_at)
      VALUES (?,?,?,?,?)`, ['inbox-' + k, b, JSON.stringify(['data:image/png;base64,AAAA']), 'Notiz ' + k, NOW]);
    db.run(`INSERT INTO offers (id, branch_id, offer_number, customer_id, total, status, created_at, updated_at)
      VALUES (?,?,?,?,300,'draft',?,?)`, ['off-' + k, b, 'OFF-' + k.toUpperCase(), 'cust-' + k, NOW, NOW]);
    db.run(`INSERT INTO gold_payables (id, branch_id, supplier_id, karat, weight_grams, settlement_type, status, source_repair_id, created_at, updated_at)
      VALUES (?,?,?, '21K', 5, 'gold', 'open', ?, ?, ?)`, ['gp-' + k, b, 'sup-' + k, 'rep-' + k, NOW, NOW]);
  }
  setTestDatabase(db as never);
}

type Reply = { kind: string; value?: { data?: Record<string, unknown> }; code?: string };
const remoteRead = (op: string, payload: unknown, branchId: string) =>
  executeCommand(op, { actor: { tenantId: 'tenant-1', branchId, userId: 'user-' + branchId, role: 'ADMIN' }, input: payload },
    { tenantId: 'tenant-1', branchId, userId: 'user-' + branchId, role: 'ADMIN' } as never) as Promise<Reply>;
const daten = async (op: string, payload: unknown, branchId: string) =>
  (await remoteRead(op, payload, branchId)).value?.data ?? {};

fixture();
setPrimarySession('branch-c', 'user-c');   // der Mensch am Primary sitzt in einer DRITTEN Filiale

// ── A — jede der zwölf Auskünfte antwortet ───────────────────────────────
const OPS: Array<[string, Record<string, unknown>]> = [
  ['page.dashboard.get', {}],
  ['page.invoice_list.get', {}],
  ['page.order_list.get', {}],
  ['page.customer_detail.get', { customerId: 'cust-a' }],
  ['page.order_detail.get', { orderId: 'ord-a' }],
  ['page.supplier_detail.get', { supplierId: 'sup-a' }],
  ['page.product_detail.get', { productId: 'prod-a' }],
  ['page.purchase_create.get', { inboxId: 'inbox-a', orderId: 'ord-a', lineIds: ['ol-a'] }],
  ['refs.numbers.get', { orders: ['ord-a'], repairs: ['rep-a'], consignments: [] }],
  ['metals.stock_by_karat.get', {}],
  ['search.global.get', { q: 'ZenithA', filter: 'all' }],
  ['page.reconciliation.get', {}],
];
{
  let antworten = 0;
  for (const [op, input] of OPS) {
    const r = await remoteRead(op, input, 'branch-a');
    if (r.kind === 'ok') antworten++;
    else ok(false, `A ${op} antwortet (${r.kind} ${r.code ?? ''})`);
  }
  ok(antworten === OPS.length, `A alle ${OPS.length} Auskuenfte antworten (${antworten})`);
}

// ── B — und sie liefern die Zahlen des Anfragenden ───────────────────────
{
  const a = await daten('page.dashboard.get', {}, 'branch-a');
  const b = await daten('page.dashboard.get', {}, 'branch-b');
  ok(a.monthlyTarget === '5000' && b.monthlyTarget === '7000',
    `B das Monatsziel gehoert der eigenen Filiale (${a.monthlyTarget} | ${b.monthlyTarget})`);

  const la = await daten('page.invoice_list.get', {}, 'branch-a');
  ok((la.payments as unknown[]).length === 1 && la.openCount === 1,
    `B die Rechnungsliste zaehlt nur eigene (${(la.payments as unknown[]).length} Zahlungen, ${la.openCount} offen)`);

  const oa = await daten('page.order_list.get', {}, 'branch-a');
  const ob = await daten('page.order_list.get', {}, 'branch-b');
  const paidA = (oa.totals as Array<{ orderId: string; paid: number }>);
  const paidB = (ob.totals as Array<{ orderId: string; paid: number }>);
  ok(paidA.length === 1 && paidA[0].orderId === 'ord-a' && paidA[0].paid === 60, `B Anzahlungen A: 60 (${JSON.stringify(paidA)})`);
  ok(paidB.length === 1 && paidB[0].paid === 80, `B Anzahlungen B: 80 (${JSON.stringify(paidB)})`);

  const ma = await daten('metals.stock_by_karat.get', {}, 'branch-a');
  ok((ma.rows as Array<{ grams: number }>)[0]?.grams === 11, `B der Goldbestand ist der eigene (${JSON.stringify(ma.rows)})`);

  const pa = await daten('page.product_detail.get', { productId: 'prod-a' }, 'branch-a');
  ok((pa.sales as unknown[]).length === 1 && (pa.purchases as unknown[]).length === 1 && (pa.production as unknown[]).length === 1,
    `B die Artikelhistorie ist vollstaendig (${(pa.sales as unknown[]).length}/${(pa.purchases as unknown[]).length}/${(pa.production as unknown[]).length})`);
  ok((pa.provenance as { supplier: string | null }).supplier === 'ZenithA Supply',
    `B …samt Herkunft der Charge (${JSON.stringify(pa.provenance)})`);

  const sa = await daten('page.supplier_detail.get', { supplierId: 'sup-a' }, 'branch-a');
  ok((sa.payments as unknown[]).length === 1 && (sa.returns as unknown[]).length === 1 && (sa.expenses as unknown[]).length === 1,
    `B der Lieferant zeigt Zahlung, Retoure und Ausgabe (${(sa.payments as unknown[]).length}/${(sa.returns as unknown[]).length}/${(sa.expenses as unknown[]).length})`);

  const ca = await daten('page.customer_detail.get', { customerId: 'cust-a' }, 'branch-a');
  ok((ca.payments as unknown[]).length === 1 && (ca.refunds as unknown[]).length === 1,
    `B der Kunde zeigt Zahlung und Erstattung (${(ca.payments as unknown[]).length}/${(ca.refunds as unknown[]).length})`);
  ok((ca.creditNoteCancels as Record<string, number>)['inv-a'] === 20,
    `B …und die zurueckgebuchte Forderung (${JSON.stringify(ca.creditNoteCancels)})`);

  const da = await daten('page.order_detail.get', { orderId: 'ord-a' }, 'branch-a');
  ok((da.sourced as Array<{ purchaseNumber: string }>)[0]?.purchaseNumber === 'PUR-A',
    `B die Beschaffung des Auftrags (${JSON.stringify(da.sourced)})`);

  const va = await daten('page.purchase_create.get', { inboxId: 'inbox-a', orderId: 'ord-a', lineIds: ['ol-a'] }, 'branch-a');
  ok((va.inbox as { note: string } | null)?.note === 'Notiz a' && (va.order as { orderNumber: string } | null)?.orderNumber === 'ORD-A'
    && (va.lines as unknown[]).length === 1, `B die Vorlage fuer den Einkauf (${JSON.stringify(va.order)})`);

  const ra = await daten('refs.numbers.get', { orders: ['ord-a'], repairs: ['rep-a'] }, 'branch-a');
  ok((ra.orders as Record<string, string>)['ord-a'] === 'ORD-A' && (ra.repairs as Record<string, string>)['rep-a'] === 'REP-A',
    `B die Belegnummern (${JSON.stringify(ra)})`);

  const rec = await daten('page.reconciliation.get', {}, 'branch-a');
  ok(rec.branchId === 'branch-a' && Array.isArray(rec.rows) && (rec.rows as unknown[]).length > 0,
    `B die Abstimmung rechnet fuer die eigene Filiale (${rec.branchId}, ${(rec.rows as unknown[] | undefined)?.length} Zeilen)`);
}

// ── C — dieselbe Kennung aus einer fremden Filiale liefert NICHTS ────────
{
  const p = await daten('page.product_detail.get', { productId: 'prod-a' }, 'branch-b');
  ok((p.sales as unknown[]).length === 0 && (p.purchases as unknown[]).length === 0 && (p.production as unknown[]).length === 0
    && (p.provenance as { supplier: string | null }).supplier === null,
    'C ein fremder Artikel hat fuer B keine Historie');

  const c = await daten('page.customer_detail.get', { customerId: 'cust-a' }, 'branch-b');
  ok((c.payments as unknown[]).length === 0 && (c.refunds as unknown[]).length === 0
    && Object.keys(c.creditNoteCancels as Record<string, number>).length === 0,
    'C ein fremder Kunde ebenso wenig');

  const o = await daten('page.order_detail.get', { orderId: 'ord-a' }, 'branch-b');
  ok((o.sourced as unknown[]).length === 0, 'C ein fremder Auftrag zeigt keine Beschaffung');

  const s = await daten('page.supplier_detail.get', { supplierId: 'sup-a' }, 'branch-b');
  ok((s.payments as unknown[]).length === 0 && (s.returns as unknown[]).length === 0 && (s.expenses as unknown[]).length === 0,
    'C ein fremder Lieferant zeigt nichts');

  const v = await daten('page.purchase_create.get', { inboxId: 'inbox-a', orderId: 'ord-a', lineIds: ['ol-a'] }, 'branch-b');
  ok(v.inbox === null && v.order === null && (v.lines as unknown[]).length === 0,
    'C eine fremde Vorlage wird nicht vorbefuellt');

  const r = await daten('refs.numbers.get', { orders: ['ord-a'], repairs: ['rep-a'] }, 'branch-b');
  ok(Object.keys(r.orders as Record<string, string>).length === 0 && Object.keys(r.repairs as Record<string, string>).length === 0,
    'C fremde Belegnummern werden nicht aufgeloest');

  // Und die Gegenprobe, damit „leer" nicht „kaputt" heisst.
  const eigen = await daten('page.product_detail.get', { productId: 'prod-b' }, 'branch-b');
  ok((eigen.sales as unknown[]).length === 1, 'C …waehrend der EIGENE Artikel seine Historie sehr wohl hat');

  const ohne = await remoteRead('page.customer_detail.get', {}, 'branch-a');
  ok(ohne.kind !== 'ok', `C ohne Kennung gibt es keine Antwort (${ohne.kind})`);
}

// ── D — Sitzung am Primary und Rumpf ändern nichts ───────────────────────
{
  for (const primary of ['branch-a', 'branch-b', 'branch-c']) {
    setPrimarySession(primary, 'user-' + primary);
    const d = await daten('page.dashboard.get', {}, 'branch-a');
    ok(d.monthlyTarget === '5000', `D die Sitzung am Primary (${primary}) aendert die Antwort fuer A nicht`);
  }
  setPrimarySession('branch-c', 'user-c');

  const gewuenscht = await daten('page.dashboard.get', { branchId: 'branch-a', tenantId: 'tenant-1' }, 'branch-b');
  ok(gewuenscht.monthlyTarget === '7000', `D ein Filialwunsch im Rumpf holt nichts aus A (${gewuenscht.monthlyTarget})`);
}

// ── E — die Suche: nur Eigenes, über alle Belegarten ─────────────────────
{
  // BEFUND R2D, und der Grund fuer diese Zeilen: die Suche fing JEDEN Fehler in einem einzigen
  // umschliessenden `try` ab. Zwei Abfragen nannten Spalten, die es in dieser Datenbank nie gab
  // (`retail_price`, `purchases.gross_amount`) — die Artikelsuche und alles, was im selben Block
  // danach kam, lieferte deshalb still gar nichts. Ein Test, der nur Treffer zaehlt, haette das
  // nie gesehen. Also wird hier auch das Protokoll geprueft: eine geschluckte Abfrage ist ein
  // Fehlschlag, kein leeres Ergebnis.
  const geschluckt: string[] = [];
  const warnAlt = console.warn;
  console.warn = (...args: unknown[]) => { if (String(args[0] ?? '').includes('[search]')) geschluckt.push(String(args[1] ?? args[0])); };
  type Treffer = { type: string; id: string; title: string };
  const suche = async (q: string, branchId: string, extra: Record<string, unknown> = {}) =>
    ((await daten('search.global.get', { q, filter: 'all', ...extra }, branchId)).items ?? []) as Treffer[];

  const a = await suche('ZenithA', 'branch-a');
  ok(a.length > 0, `E die eigene Suche findet etwas (${a.length})`);
  ok(a.some((t) => t.id === 'prod-a') && a.some((t) => t.id === 'cust-a'),
    `E …Artikel und Kunde der eigenen Filiale (${a.map((t) => t.id).join(',')})`);

  const b = await suche('ZenithA', 'branch-b');
  ok(b.every((t) => !t.id.endsWith('-a')), `E die fremde Filiale findet davon NICHTS (${b.map((t) => t.id).join(',') || 'leer'})`);

  // Belegnummern-Abkuerzung: 'ORD-A' ist die Nummer eines Auftrags in A.
  const nummerA = await suche('ORD-A', 'branch-a');
  const nummerB = await suche('ORD-A', 'branch-b');
  ok(nummerA.some((t) => t.id === 'ord-a'), `E die Suche nach der Belegnummer findet den Auftrag (${nummerA.map((t) => t.id).join(',')})`);
  ok(nummerB.every((t) => t.id !== 'ord-a'), `E …aber nicht ueber die Filialgrenze (${nummerB.map((t) => t.id).join(',') || 'leer'})`);

  const mitWunsch = await suche('ZenithA', 'branch-b', { branchId: 'branch-a' });
  ok(mitWunsch.every((t) => !t.id.endsWith('-a')), 'E und ein Filialwunsch im Rumpf hilft dabei nicht');

  // Kein Tabellenname aus dem Rumpf: was gesucht wird, steht im Modul.
  const modul = src('src/core/search/global-search.ts');
  ok(/const DOC_PREFIX_MAP/.test(modul), 'E die Praefix-Tabelle steht im Modul, nicht im Rumpf');
  ok(!/params\.(table|numberCol)/.test(modul), 'E …und aus den Parametern kommt kein Tabellen- oder Spaltenname');

  console.warn = warnAlt;
  ok(geschluckt.length === 0, `E keine einzige Abfrage der Suche ist still gescheitert (${geschluckt.join(' | ') || 'keine'})`);
}

// ── F — kein Fernlesen fasst den Bildschirm des Primary an ───────────────
{
  const module = await Promise.all([
    import('../../src/stores/productStore.ts'), import('../../src/stores/customerStore.ts'),
    import('../../src/stores/invoiceStore.ts'), import('../../src/stores/supplierStore.ts'),
    import('../../src/stores/orderStore.ts'), import('../../src/stores/purchaseStore.ts'),
    import('../../src/stores/expenseStore.ts'), import('../../src/stores/metalStore.ts'),
    import('../../src/stores/analyticsStore.ts'),
  ]);
  const hooks = module.map((m) => Object.values(m).find(
    (v) => typeof v === 'function' && typeof (v as { getState?: unknown }).getState === 'function',
  ) as { getState(): Record<string, unknown>; setState(p: Record<string, unknown>): void });
  for (const h of hooks) h.setState({ __sentinel: 'NICHT ANFASSEN', __filter: 'gold', __auswahl: 'x', __seite: 3 });
  const vorher = hooks.map((h) => JSON.stringify(h.getState()));

  for (const [op, input] of OPS) await remoteRead(op, input, 'branch-a');

  ok(hooks.every((h, i) => JSON.stringify(h.getState()) === vorher[i]),
    'F Liste, Filter, Auswahl und Seitenzahl des Primary sind bitgenau dieselben geblieben');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central ui parity r2d: page reads, search and detail scope: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R2D_TYPED_PAGE_READS_PROVED');
console.log('CENTRAL_UI_R2D_GLOBAL_SEARCH_SCOPE_PROVED');
console.log('CENTRAL_UI_R2D_DETAIL_SCOPE_PROVED');
console.log('CENTRAL_UI_R2D_PRIMARY_STATE_ISOLATION_PROVED');
console.log('CENTRAL_UI_R2D_AUTHORITY_PROVED');
