// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R4A.1 — die zwei Lesevorgänge, die erst auf KLICK laufen.
// Run: node --experimental-strip-types test/uiparity/r4a1-click-reads.test.ts
//
// R4A hat jede Fläche gezeichnet und dabei zwei Stellen ausdrücklich stehen lassen, weil sie
// beim Zeichnen nie laufen. Beide sind dieselbe Handlung — „welches Los ist gemeint?" — und
// beide griffen mitten im Zeichnen zur lokalen Datenbank, sobald der Mensch einen Artikel
// gewählt hatte. Auf einem Rechner ohne Datenbank ist das ein Absturz, nicht eine leere Liste.
//
// Die Wege, Klick für Klick:
//
//   1) /invoices/new (InvoiceCreate)
//      → Klick in den Artikel-Picker einer Zeile
//      → pickProductForLine(idx, productId)   [setzt nur noch den Zustand]
//      → Neuzeichnen: computed = lines.map(…)
//      → FRÜHER: getLotsWithPurchaseNumbers(product.id)
//      → core/lots/lot-queries.ts → query('SELECT … FROM stock_lots …') → getDatabase()
//      → JETZT: useSharedRead('product.lots.batch.get', { productIds })
//
//   2) /repairs (RepairList, Maske „New repair")
//      → Klick in den Artikel-Picker
//      → setForm({ productId })
//      → Neuzeichnen: der Block unter dem Picker
//      → FRÜHER: getLotsWithPurchaseNumbers(form.productId!)
//      → dieselbe Abfrage, dieselbe Datenbank
//      → JETZT: useSharedRead('product.lots.get', { productId })
//
// Dieses Gate hält beides fest — den Weg (statisch) und die Autorität (am laufenden Kommando,
// mit zwei echten Filialen und einer Negativkontrolle, die den alten Zustand nachstellt).
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
const codeOf = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

interface Db { run(sql: string, p?: unknown[]): unknown; exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>; }
const initSqlJs = (await import('sql.js')).default;
const SQL = await initSqlJs({ locateFile: (f: string) => resolvePath(repo, 'node_modules/sql.js/dist', f) });
const { setTestDatabase } = await import('../sync/_db-shim.ts');
const { setPrimarySession } = await import('./_auth-switch.ts');
const { executeCommand } = await import('../../src/core/bridge/command-registry.ts');
await import('../../src/core/bridge/store-read-commands.ts');

// ════════════════════════════════════════════════════════════════════════════
// §1 — der Weg. Keine der beiden Seiten fasst die Datenbank noch selbst an.
// ════════════════════════════════════════════════════════════════════════════
{
  const inv = codeOf(src('src/pages/invoices/InvoiceCreate.tsx'));
  const rep = codeOf(src('src/pages/repairs/RepairList.tsx'));

  ok(!/getLotsWithPurchaseNumbers/.test(inv),
    '1 „Rechnung anlegen" ruft die Datenbankfunktion fuer Lose nicht mehr');
  ok(!/getLotsWithPurchaseNumbers/.test(rep),
    '1 „Reparatur anlegen" ebenso wenig');

  ok(/useSharedRead\(\s*\n?\s*'product\.lots\.batch\.get'/.test(inv),
    '1 …sondern fragt die Lose aller Zeilen ueber die gemeinsame Auskunft');
  ok(/useSharedRead\(\s*\n?\s*'product\.lots\.get'/.test(rep),
    '1 …und die Maske fragt die Lose des EINEN gewaehlten Artikels');

  // Der Klick selbst darf nichts mehr lesen: er setzt Zustand, mehr nicht.
  const pick = inv.slice(inv.indexOf('function pickProductForLine'), inv.indexOf('function addLine'));
  ok(pick.length > 40 && !/getLots|query\(/.test(pick),
    '1 der Klick auf einen Artikel liest nichts — er setzt nur den Zustand');
  ok(/lotId: undefined/.test(pick),
    '1 …und die FIFO-Wahl faellt beim Zeichnen (lots[0]), nicht im Klick');

  // Kein Rückfall auf eine lokale Datenbank, wenn die Antwort fehlt.
  ok(!/catch[\s\S]{0,80}getLotsWithPurchaseNumbers/.test(inv + rep),
    '1 und es gibt keinen stillen Rueckfall auf die lokale Datenbank');
}

// ════════════════════════════════════════════════════════════════════════════
// §3 — die Auskunft ist zusammengesetzt, nicht nachgebaut.
// ════════════════════════════════════════════════════════════════════════════
{
  const dom = codeOf(src('src/core/data/domain-reads.ts'));
  ok(!/SELECT /i.test(dom),
    '3 die Domaenen-Auskuenfte enthalten keine eigene Abfrage');
  ok(/export function productLotsBatchFor[\s\S]{0,420}productLotsFor\(ctx, id\)/.test(dom),
    '3 die Sammelauskunft ruft dieselbe Einzelauskunft — die FIFO-Logik ist nicht kopiert');
  ok(!/currentBranchId\(\)/.test(dom),
    '3 keine von ihnen nimmt die Filiale aus der Sitzung des Primary');

  const ops = src('src/core/bridge/store-read-ops.ts');
  const rust = src('src-tauri/src/bridge.rs');
  ok(ops.includes("'product.lots.batch.get'") && rust.includes('"product.lots.batch.get"'),
    '3 der neue Name steht in beiden Zulassungslisten — TS wie Rust');
}

// ════════════════════════════════════════════════════════════════════════════
// §4 — die Autorität, am laufenden Kommando.
// ════════════════════════════════════════════════════════════════════════════
function realMigrations(): string[] {
  const dbSrc = src('src/core/db/database.ts');
  const start = dbSrc.indexOf('const migrations: string[] = [');
  const end = dbSrc.indexOf('\n  ];', start);
  return [...dbSrc.slice(start, end).matchAll(/`([^`]*)`/g)].map((m) => m[1]);
}
const MIGRATIONS = realMigrations();
const NOW = new Date().toISOString();

/**
 * Zwei Filialen mit Ware, eine dritte für den Menschen am Primary. In JEDER der beiden liegen
 * Lose — sonst wäre „B sieht nichts von A" nicht von „B sieht überhaupt nichts" zu trennen.
 */
let db: Db;
function fixture(): Db {
  db = new SQL.Database() as unknown as Db;
  db.run(src('src/core/db/schema.sql'));
  for (const stmt of MIGRATIONS) { try { db.run(stmt); } catch { /* schon da */ } }
  for (const [b, name] of [['branch-a', 'Filiale A'], ['branch-b', 'Filiale B'], ['branch-c', 'Filiale C']]) {
    db.run('INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES (?,?,?,?,?)', [b, 'tenant-1', name, NOW, NOW]);
    db.run(`INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?)`, ['cat-' + b, b, 'Kat', 'w', '#000', NOW, NOW]);
    db.run(`INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at)
      VALUES (?,?,?,1,?,?)`, ['sup-' + b, b, 'Lieferant ' + b, NOW, NOW]);
    db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, condition, scope_of_delivery,
        purchase_price, purchase_currency, planned_sale_price, stock_status, tax_scheme, days_in_stock,
        quantity, images, attributes, source_type, created_at, updated_at)
      VALUES (?,?,?,'Zenith','Artikel',?, 'Pre-Owned','[]',100,'BHD',150,'in_stock','VAT_10',0,1,'[]','{}','OWN',?,?)`,
    ['prod-' + b, b, 'cat-' + b, 'SKU-' + b, NOW, NOW]);
    db.run(`INSERT INTO purchases (id, branch_id, purchase_number, supplier_id, status,
        total_amount, paid_amount, remaining_amount, purchase_date, created_at, updated_at)
      VALUES (?,?,?,?, 'PAID', 100, 100, 0, ?, ?, ?)`,
    ['pu-' + b, b, 'PUR-' + b, 'sup-' + b, NOW, NOW, NOW]);
  }
  // Filiale A: zwei Lose am eigenen Artikel (unterschiedliche Kosten → FIFO ist prüfbar).
  db.run(`INSERT INTO stock_lots (id, branch_id, product_id, purchase_id, unit_cost, qty_total,
      qty_remaining, status, acquired_at, created_at) VALUES
      ('lot-a1','branch-a','prod-branch-a','pu-branch-a', 100, 1, 1, 'ACTIVE', ?, ?),
      ('lot-a2','branch-a','prod-branch-a','pu-branch-a', 300, 1, 1, 'ACTIVE', ?, ?)`,
  [NOW, NOW, NOW, NOW]);
  // Filiale B: ein eigenes Los — UND eines am ARTIKEL VON A. Genau das ist der Fall, den die
  // fehlende Filialgrenze verriet: dieselbe Artikelkennung, fremde Filiale.
  db.run(`INSERT INTO stock_lots (id, branch_id, product_id, purchase_id, unit_cost, qty_total,
      qty_remaining, status, acquired_at, created_at) VALUES
      ('lot-b1','branch-b','prod-branch-b','pu-branch-b', 200, 1, 1, 'ACTIVE', ?, ?),
      ('lot-b2','branch-b','prod-branch-a','pu-branch-b', 999, 1, 1, 'ACTIVE', ?, ?)`,
  [NOW, NOW, NOW, NOW]);
  setTestDatabase(db as never);
  return db;
}

type Reply = { kind: string; value?: { data?: Record<string, unknown> }; code?: string };
const remoteRead = (op: string, payload: unknown, branchId: string) =>
  executeCommand(op, { actor: { tenantId: 'tenant-1', branchId, userId: 'user-' + branchId, role: 'ADMIN' }, input: payload },
    { tenantId: 'tenant-1', branchId, userId: 'user-' + branchId, role: 'ADMIN' } as never) as Promise<Reply>;

interface Lot { id?: string; unitCost?: number; purchaseNumber?: string | null }
const lotsOf = (r: Reply) => ((r.value?.data?.lots ?? []) as Lot[]);
const fifoOf = (r: Reply) => (r.value?.data?.fifo as { fifoCost?: number; lotCount?: number } | null) ?? null;
const batchOf = (r: Reply) => ((r.value?.data?.byProduct ?? []) as Array<[string, { lots: Lot[] }]>);

fixture();
// Der Mensch am Primary sitzt in einer DRITTEN Filiale. Nichts unten darf davon abhängen.
setPrimarySession('branch-c', 'user-c');

// ── A — A sieht A ─────────────────────────────────────────────────────────
{
  const a = await remoteRead('product.lots.get', { productId: 'prod-branch-a' }, 'branch-a');
  const ids = lotsOf(a).map((l) => l.id).sort();
  ok(ids.join(',') === 'lot-a1,lot-a2', `4 Filiale A sieht ihre beiden Lose (${ids.join(',') || 'leer'})`);
  ok(fifoOf(a)?.fifoCost === 100 && fifoOf(a)?.lotCount === 2,
    `4 …und die FIFO-Kosten sind die des aeltesten EIGENEN Loses (${fifoOf(a)?.fifoCost})`);
  ok(lotsOf(a).every((l) => l.purchaseNumber === 'PUR-branch-a'),
    '4 …samt der Einkaufsnummer, die dazu gehoert');
}

// ── B — dieselbe Artikelkennung, fremde Filiale: nichts Fremdes ───────────
{
  const b = await remoteRead('product.lots.get', { productId: 'prod-branch-a' }, 'branch-b');
  const ids = lotsOf(b).map((l) => l.id).sort();
  ok(ids.join(',') === 'lot-b2',
    `4 B fragt mit der Artikelkennung von A und bekommt NUR sein eigenes Los (${ids.join(',') || 'leer'})`);
  ok(!ids.includes('lot-a1') && !ids.includes('lot-a2'),
    '4 …die Lose von A erreichen B nicht');
  ok(fifoOf(b)?.fifoCost === 999,
    `4 …und auch die FIFO-Kosten stammen aus der eigenen Filiale (${fifoOf(b)?.fifoCost})`);
}

// ── C — eine voellig fremde Kennung liefert nichts ────────────────────────
{
  const leer = await remoteRead('product.lots.get', { productId: 'prod-branch-c' }, 'branch-a');
  ok(lotsOf(leer).length === 0 && fifoOf(leer) === null,
    `4 eine fremde Artikelkennung liefert keine Zeile (${lotsOf(leer).length})`);
  const ohne = await remoteRead('product.lots.get', {}, 'branch-a');
  ok(ohne.kind !== 'error' && lotsOf(ohne).length === 0,
    `4 …und ohne Artikel ist die Antwort leer, kein Fehler (${ohne.kind})`);
}

// ── D — der Rumpf des Clients ist Eingabe, nie Autoritaet ────────────────
{
  const gefaelscht = await remoteRead('product.lots.get',
    { productId: 'prod-branch-a', branchId: 'branch-a', tenantId: 'tenant-1' }, 'branch-b');
  const ids = lotsOf(gefaelscht).map((l) => l.id).sort();
  ok(ids.join(',') === 'lot-b2',
    `4 ein Filialwunsch im Rumpf aendert nichts (${ids.join(',') || 'leer'})`);
}

// ── E — der Mensch am Primary aendert nichts ─────────────────────────────
{
  setPrimarySession('branch-a', 'user-a');
  const b = await remoteRead('product.lots.get', { productId: 'prod-branch-a' }, 'branch-b');
  ok(lotsOf(b).map((l) => l.id).join(',') === 'lot-b2',
    '4 die Filiale des Menschen am Primary aendert die Antwort des Clients nicht');
  setPrimarySession('branch-c', 'user-c');
}

// ── F — die Sammelauskunft haelt sich an dieselbe Grenze ─────────────────
{
  const a = batchOf(await remoteRead('product.lots.batch.get',
    { productIds: ['prod-branch-a', 'prod-branch-b', 'prod-branch-a'] }, 'branch-a'));
  ok(a.length === 2, `4 die Sammelauskunft antwortet je Artikel genau einmal (${a.length})`);
  const karte = new Map(a);
  ok((karte.get('prod-branch-a')?.lots ?? []).map((l) => l.id).sort().join(',') === 'lot-a1,lot-a2',
    '4 …mit den eigenen Losen des eigenen Artikels');
  ok((karte.get('prod-branch-b')?.lots ?? []).length === 0,
    `4 …und mit NICHTS zum Artikel der fremden Filiale (${(karte.get('prod-branch-b')?.lots ?? []).length})`);

  const leer = batchOf(await remoteRead('product.lots.batch.get', { productIds: [] }, 'branch-a'));
  ok(leer.length === 0, '4 eine leere Liste ist eine gueltige, leere Antwort');
  const kaputt = await remoteRead('product.lots.batch.get', { productIds: 'prod-branch-a' }, 'branch-a');
  ok(kaputt.kind !== 'error' && batchOf(kaputt).length === 0,
    '4 …und ein Rumpf, der keine Liste ist, liefert nichts statt zu raten');
}

// ── G — Negativkontrolle: OHNE die Filialgrenze war der Fehler real ──────
{
  const roh = db.exec(
    `SELECT sl.id FROM stock_lots sl WHERE sl.product_id = ?
       AND sl.status != 'CANCELLED' AND sl.qty_remaining > 0`,
    ['prod-branch-a'],
  );
  const alle = (roh[0]?.values ?? []).map((v) => String(v[0])).sort();
  ok(alle.join(',') === 'lot-a1,lot-a2,lot-b2',
    `4 (Negativkontrolle) dieselbe Abfrage ohne Filiale liefert die fremden Lose (${alle.join(',')})`);
  ok(alle.includes('lot-b2') && alle.includes('lot-a1'),
    '4 (Negativkontrolle) …der alte Code haette B die Lose von A gezeigt — dieser Test waere rot gewesen');
}

// ── H — und die Funktion selbst nimmt die Filiale entgegen ───────────────
{
  const q = src('src/core/lots/lot-queries.ts');
  ok(/export function getLotsWithPurchaseNumbers\(productId: string, branchId\?: string\)/.test(q),
    '4 die Losabfrage nimmt eine Filiale entgegen');
  ok(/export function deriveProductCostFromLots\(productId: string, branchId\?: string\)/.test(q),
    '4 …und die FIFO-Ableitung ebenso');
  const dom = codeOf(src('src/core/data/domain-reads.ts'));
  ok(/getLotsWithPurchaseNumbers\(productId, ctx\.branchId\)/.test(dom)
    && /deriveProductCostFromLots\(productId, ctx\.branchId\)/.test(dom),
    '4 …und die Auskunft gibt ihr die Filiale des Ausweises weiter');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central ui parity r4a.1: click driven reads: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R4A1_CLICK_READ_PATHS_AUDITED');
console.log('CENTRAL_UI_R4A1_CLICK_READ_SCOPE_PROVED');
