// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R2C §1 — die zwei Listen, die ÜBER ALLE FILIALEN zählten, festnageln.
// Run: node --experimental-strip-types test/uiparity/r2c-payables-trades-scope.test.ts
//
// R2B hat den Befund gemacht: `loadPayables` (fünf Quellen plus die Einstellung) und
// `loadTrades` hatten keine Filialgrenze. Am Ein-Filial-Betrieb unsichtbar — über das Netz die
// Preisgabe fremder Zahlen. Dieser Test hält den Zustand VORHER und NACHHER fest:
//
//   • Für JEDE der sechs korrigierten Abfragen: A sieht A, B sieht A nicht.
//   • Die Filiale des Menschen am Primary (hier absichtlich eine DRITTE) ändert nichts.
//   • Ein Filialwunsch im Rumpf des Clients ändert nichts.
//   • Negativkontrolle: dieselbe Abfrage OHNE das Prädikat liefert die fremden Zeilen —
//     der Fehler war real, und dieser Test wäre mit dem alten Code rot.
//
// Die sechste Abfrage ist die EINSTELLUNG (`payables.grace_period_days`). Sie ist hier
// sichtbar gemacht, weil sie die Fälligkeit rechnet: Filiale A hat 0 Tage Karenz, Filiale B
// hat 90. Dieselbe Rechnung, am selben Tag, muss deshalb je Anfragendem verschieden ausgehen.
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

// Die Fälligkeit rechnet die Anwendung gegen die ECHTE Uhr. Ein fest eingetragener Tag im
// Aufbau wanderte deshalb jeden Kalendertag um eins weiter (40 → 41 → …) und machte dieses
// Gate mit der Zeit rot, ohne dass sich am Programm etwas geändert hatte. Der Aufbau nimmt
// jetzt dieselbe Uhr wie die Anwendung: vierzig Tage vor JETZT sind immer vierzig Tage.
const TODAY = new Date();
const NOW = TODAY.toISOString();
const daysAgo = (n: number) => new Date(TODAY.getTime() - n * 86_400_000).toISOString();
const OLD = daysAgo(40);   // vierzig Tage alt — mit Karenz 0 überfällig, mit Karenz 90 nicht

function realMigrations(): string[] {
  const dbSrc = src('src/core/db/database.ts');
  const start = dbSrc.indexOf('const migrations: string[] = [');
  const end = dbSrc.indexOf('\n  ];', start);
  return [...dbSrc.slice(start, end).matchAll(/`([^`]*)`/g)].map((m) => m[1]);
}
const MIGRATIONS = realMigrations();

/**
 * Drei Filialen. In A liegt von JEDER der fünf Payable-Quellen genau eine Zeile, dazu ein
 * Altgold-Geschäft. In B liegt nur ein Einkauf — damit B eine EIGENE, nicht leere Antwort hat
 * und „B sieht nichts von A" nicht mit „B sieht überhaupt nichts" verwechselt werden kann.
 * In C sitzt der Mensch am Primary. Er darf auf keine der Antworten Einfluss haben.
 */
let db: Db;
function fixture(): Db {
  db = new SQL.Database() as unknown as Db;
  db.run(src('src/core/db/schema.sql'));
  for (const stmt of MIGRATIONS) { try { db.run(stmt); } catch { /* schon da */ } }
  for (const [b, name] of [['branch-a', 'Filiale A'], ['branch-b', 'Filiale B'], ['branch-c', 'Filiale C']]) {
    db.run('INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES (?,?,?,?,?)', [b, 'tenant-1', name, NOW, NOW]);
    db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, company, country, language,
        vip_level, preferences, customer_type, sales_stage, created_at, updated_at)
      VALUES (?,?,?,?,'','BH','en','NONE','[]','PRIVATE','active',?,?)`, ['cust-' + b, b, 'Kunde', b, NOW, NOW]);
    db.run(`INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?)`, ['cat-' + b, b, 'Kat', 'w', '#000', NOW, NOW]);
    db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, condition, scope_of_delivery,
        purchase_price, purchase_currency, planned_sale_price, stock_status, tax_scheme, days_in_stock,
        quantity, images, attributes, source_type, created_at, updated_at)
      VALUES (?,?,?,'Zenith','Artikel',?, 'Pre-Owned','[]',100,'BHD',150,'in_stock','VAT_10',0,1,'[]','{}','OWN',?,?)`,
    ['prod-' + b, b, 'cat-' + b, 'SKU-' + b, NOW, NOW]);
    db.run(`INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at)
      VALUES (?,?,?,1,?,?)`, ['sup-' + b, b, 'Lieferant ' + b, NOW, NOW]);
  }

  // Die Einstellung — sechste Abfrage. A ohne Karenz, B mit drei Monaten.
  db.run(`INSERT INTO settings (branch_id, key, value, category, updated_at) VALUES (?,?,?,?,?)`,
    ['branch-a', 'payables.grace_period_days', '0', 'payables', NOW]);
  db.run(`INSERT INTO settings (branch_id, key, value, category, updated_at) VALUES (?,?,?,?,?)`,
    ['branch-b', 'payables.grace_period_days', '90', 'payables', NOW]);

  // 1) Einkauf — in beiden Filialen, damit die Karenz vergleichbar wird.
  for (const b of ['branch-a', 'branch-b']) {
    db.run(`INSERT INTO purchases (id, branch_id, purchase_number, supplier_id, status,
        total_amount, paid_amount, remaining_amount, purchase_date, created_at, updated_at)
      VALUES (?,?,?,?, 'UNPAID', 100, 0, 100, ?, ?, ?)`,
    ['pu-' + b, b, 'PUR-' + b, 'sup-' + b, OLD, OLD, OLD]);
  }
  // 2) Verkaufsretoure mit offener Erstattung
  db.run(`INSERT INTO sales_returns (id, branch_id, return_number, invoice_id, customer_id, status,
      total_amount, vat_corrected, return_date, refund_amount, refund_paid_amount, created_at)
    VALUES ('sr-a','branch-a','RET-A','inv-a','cust-branch-a','APPROVED',50,0,?,50,0,?)`, [OLD, OLD]);
  // 3) Kommission: verkauft, Eigentümer noch nicht ausgezahlt
  db.run(`INSERT INTO consignments (id, branch_id, consignment_number, consignor_id, product_id,
      agreed_price, commission_rate, payout_amount, payout_paid_amount, status, agreement_date, created_at, updated_at)
    VALUES ('cs-a','branch-a','CON-A','cust-branch-a','prod-branch-a',80,15,80,0,'sold',?,?,?)`, [OLD, OLD, OLD]);
  // 4) Offene Ausgabe
  db.run(`INSERT INTO expenses (id, branch_id, expense_number, category, amount, paid_amount,
      payment_method, status, expense_date, created_at)
    VALUES ('ex-a','branch-a','EXP-A','Rent',30,0,'cash','OPEN',?,?)`, [OLD, OLD]);
  // 5) Aufgenommenes Darlehen
  db.run(`INSERT INTO debts (id, branch_id, direction, counterparty, amount, source, status, created_at, updated_at)
    VALUES ('d-a','branch-a','we_borrow','Onkel',60,'manual','open',?,?)`, [OLD, OLD]);
  // 6) Altgold in beiden Filialen
  for (const b of ['branch-a', 'branch-b']) {
    db.run(`INSERT INTO scrap_trades (id, branch_id, trade_number, seller_name, buyer_name,
        weight_grams, karat, purchase_price, sale_price, profit, trade_date, created_at, updated_at)
      VALUES (?,?,?, 'Verkaeufer','Kaeufer',10,'21K',50,60,10,?,?,?)`,
    ['st-' + b, b, 'ST-' + b, OLD, OLD, OLD]);
  }
  setTestDatabase(db as never);
  return db;
}

type Reply = { kind: string; value?: { data?: Record<string, unknown> }; code?: string };
const remoteRead = (op: string, payload: unknown, branchId: string) =>
  executeCommand(op, { actor: { tenantId: 'tenant-1', branchId, userId: 'user-' + branchId, role: 'ADMIN' }, input: payload },
    { tenantId: 'tenant-1', branchId, userId: 'user-' + branchId, role: 'ADMIN' } as never) as Promise<Reply>;

interface Row { id?: string; type?: string; sourceId?: string; daysOverdue?: number; outstanding?: number }
const payablesOf = (r: Reply) => (r.value?.data?.payables ?? []) as Row[];
const tradesOf = (r: Reply) => (r.value?.data?.trades ?? []) as Array<{ id?: string }>;

fixture();
// Der Mensch am Primary sitzt in einer DRITTEN Filiale. Nichts unten darf davon abhängen.
setPrimarySession('branch-c', 'user-c');

// ── A — jede der fünf Quellen: A sieht A ───────────────────────────────────
const QUELLEN: Array<[string, string, string]> = [
  ['supplier', 'pu-branch-a', 'der offene Einkauf'],
  ['refund', 'sr-a', 'die offene Erstattung'],
  ['consignor', 'cs-a', 'die offene Auszahlung an den Eigentuemer'],
  ['expense', 'ex-a', 'die offene Ausgabe'],
  ['loan', 'd-a', 'das aufgenommene Darlehen'],
];
{
  const a = payablesOf(await remoteRead('store.payables.get', {}, 'branch-a'));
  ok(a.length === 5, `A Filiale A bekommt genau ihre fuenf offenen Posten (${a.length})`);
  for (const [type, sourceId, label] of QUELLEN) {
    ok(a.some((r) => r.type === type && r.sourceId === sourceId), `A ${label} ist dabei (${type})`);
  }
}

// ── B — dieselben fünf Quellen: B sieht nichts davon ───────────────────────
{
  const b = payablesOf(await remoteRead('store.payables.get', {}, 'branch-b'));
  for (const [type, sourceId, label] of QUELLEN) {
    ok(!b.some((r) => r.sourceId === sourceId), `B ${label} erreicht die fremde Filiale NICHT (${type})`);
  }
  ok(b.length === 1 && b[0]?.sourceId === 'pu-branch-b',
    `B …und B bekommt trotzdem den EIGENEN Einkauf (${b.map((r) => r.sourceId).join(',') || 'leer'})`);
}

// ── C — die Einstellung ist die sechste Abfrage, und auch sie gehört dem Anfragenden ──
{
  const a = payablesOf(await remoteRead('store.payables.get', {}, 'branch-a'));
  const b = payablesOf(await remoteRead('store.payables.get', {}, 'branch-b'));
  const pa = a.find((r) => r.sourceId === 'pu-branch-a');
  const pb = b.find((r) => r.sourceId === 'pu-branch-b');
  // Gleiches Datum, gleiche Zeile — nur die Karenz der eigenen Filiale unterscheidet sie.
  ok(pa?.daysOverdue === 40, `C mit Karenz 0 (Filiale A) ist der Einkauf 40 Tage ueberfaellig (${pa?.daysOverdue})`);
  ok(pb?.daysOverdue === -50, `C mit Karenz 90 (Filiale B) ist derselbe Fall nicht faellig (${pb?.daysOverdue})`);
}

// ── D — der Mensch am Primary ändert nichts ───────────────────────────────
{
  const vorher = payablesOf(await remoteRead('store.payables.get', {}, 'branch-a')).map((r) => r.id).sort().join(',');
  for (const b of ['branch-a', 'branch-b', 'branch-c']) {
    setPrimarySession(b, 'user-' + b);
    const jetzt = payablesOf(await remoteRead('store.payables.get', {}, 'branch-a')).map((r) => r.id).sort().join(',');
    ok(jetzt === vorher, `D die Sitzung am Primary (${b}) aendert die Antwort fuer A nicht`);
  }
  setPrimarySession('branch-c', 'user-c');
}

// ── E — der Rumpf des Clients ist Eingabe, nie Ausweis ────────────────────
{
  const gewuenscht = payablesOf(await remoteRead('store.payables.get', { branchId: 'branch-a', tenantId: 'tenant-1' }, 'branch-b'));
  ok(gewuenscht.every((r) => r.sourceId === 'pu-branch-b'),
    `E ein Filialwunsch im Rumpf holt nichts aus A (${gewuenscht.map((r) => r.sourceId).join(',') || 'leer'})`);
  const trades = tradesOf(await remoteRead('store.scrap_trades.get', { branchId: 'branch-a' }, 'branch-b'));
  ok(trades.length === 1 && trades[0]?.id === 'st-branch-b',
    `E …und beim Altgold ebenso (${trades.map((t) => t.id).join(',') || 'leer'})`);
}

// ── F — Altgold: A sieht A, B sieht B, und die Auskunft schreibt nicht ────
{
  const a = tradesOf(await remoteRead('store.scrap_trades.get', {}, 'branch-a'));
  const b = tradesOf(await remoteRead('store.scrap_trades.get', {}, 'branch-b'));
  ok(a.length === 1 && a[0]?.id === 'st-branch-a', `F Filiale A bekommt ihr Geschaeft (${a.map((t) => t.id).join(',')})`);
  ok(b.length === 1 && b[0]?.id === 'st-branch-b', `F Filiale B ihres (${b.map((t) => t.id).join(',')})`);
  const rows = db.exec('SELECT COUNT(*) FROM scrap_trades');
  ok(Number(rows[0]?.values?.[0]?.[0] ?? 0) === 2, 'F und die Auskunft hat nichts angelegt oder geaendert');
}

// ── G — NEGATIVKONTROLLE: dieselben Abfragen OHNE das Prädikat ────────────
//
// Das ist der Zustand vor R2B, wörtlich. Wenn diese Prüfungen NICHT anschlagen, ist die
// Fixture kaputt und die Aussagen oben wertlos — dann fehlt schlicht das Fremdmaterial.
{
  const zaehle = (sql: string) => Number(db.exec(sql)[0]?.values?.[0]?.[0] ?? 0);
  const alt: Array<[string, string]> = [
    ['Einkaeufe', `SELECT COUNT(*) FROM purchases p WHERE p.status IN ('UNPAID','PARTIALLY_PAID') AND p.total_amount > p.paid_amount`],
    ['Retouren', `SELECT COUNT(*) FROM sales_returns r WHERE r.refund_amount > COALESCE(r.refund_paid_amount,0) AND r.status IN ('APPROVED','REFUNDED')`],
    ['Kommissionen', `SELECT COUNT(*) FROM consignments cs WHERE (cs.status='sold' OR cs.status='SOLD') AND COALESCE(cs.payout_amount,0) > COALESCE(cs.payout_paid_amount,0)`],
    ['Ausgaben', `SELECT COUNT(*) FROM expenses e WHERE e.status != 'CANCELLED' AND e.amount > COALESCE(e.paid_amount,0) + 0.005`],
    ['Darlehen', `SELECT COUNT(*) FROM debts d WHERE d.direction='we_borrow' AND d.status NOT IN ('CANCELLED','REPAID','settled')`],
    ['Altgold', `SELECT COUNT(*) FROM scrap_trades`],
  ];
  // Filiale B hat je Quelle höchstens EINE eigene Zeile (Einkauf, Altgold) — alles darüber
  // hinaus wäre bei der alten Abfrage fremdes Material in ihrer Liste.
  const eigenB: Record<string, number> = { Einkaeufe: 1, Retouren: 0, Kommissionen: 0, Ausgaben: 0, Darlehen: 0, Altgold: 1 };
  for (const [label, sql] of alt) {
    const ohneGrenze = zaehle(sql);
    ok(ohneGrenze > eigenB[label],
      `G Negativkontrolle: ${label} ohne Filialgrenze liefert ${ohneGrenze} statt ${eigenB[label]} — der Fehler war real`);
  }
  // Und der heutige Code hat das Prädikat wirklich im Text stehen, nicht nur im Ergebnis.
  const pay = src('src/stores/payablesStore.ts');
  const scrap = src('src/stores/scrapTradeStore.ts');
  const anzahl = (s: string, n: string) => s.split(n).length - 1;
  // Und der Fund aus diesem Lauf: eine eingestellte Karenz von NULL Tagen darf nicht still
  // zu dreissig werden. Genau das tat `|| 30`.
  ok(!pay.includes(", 10) || 30"),
    'G und eine Karenz von null Tagen wird nicht mehr auf dreissig zurueckgedreht');
  ok(anzahl(pay, 'ctx.branchId') === 6, `G alle sechs Abfragen der Verbindlichkeiten nennen den Ausweis (${anzahl(pay, 'ctx.branchId')})`);
  ok(anzahl(scrap, 'ctx.branchId') === 1, `G und das Altgold ebenso (${anzahl(scrap, 'ctx.branchId')})`);
  ok(!/currentBranchId\(\)/.test(pay.slice(pay.indexOf('export function loadPayablesFor'))),
    'G in der gemeinsamen Ladefunktion steht keine Primary-Sitzung mehr');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central ui parity r2c: payables and scrap trades are branch scoped: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R2C_PAYABLE_TRADE_SCOPE_PINNED');
