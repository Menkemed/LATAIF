// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R1 — eine Fernabfrage darf den Bildschirm des Primary nicht anfassen,
// und sie muss aus der Identität des ANFRAGENDEN lesen. Run: node test/uiparity/r1-read-isolation.test.ts
//
// Der Fehler, den dieses Gate zuerst rot festhält und danach absichert, hat zwei Gesichter:
//
//   A  Der Fernweg rief die echte Ladefunktion des Primary-Stores. Damit schrieb jedes Lesen von
//      PC2 in genau den Zustand, den der Mensch am Primary vor sich hat — Liste, Auswahl, Filter.
//   B  Diese Ladefunktion nimmt ihre Filiale aus `currentBranchId()`, also aus der Sitzung des
//      PRIMARY. Ein Client aus Filiale B bekam die Daten von Filiale A.
//   C  Und was der Client selbst im Rumpf mitschickt, darf niemals Autorität sein.
//
// Geprüft wird an einer echten sql.js-Datenbank mit zwei Filialen und echten Zeilen.
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
    // Die umschaltbare Anmeldung: sie ist der ganze Punkt dieses Gates.
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

const store = new Map<string, string>([['lataif_session', JSON.stringify({ branchId: 'branch-a', userId: 'user-a' })]]);
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
const { useProductStore } = await import('../../src/stores/productStore.ts');

const NOW = '2026-09-08T00:00:00.000Z';
function realMigrations(): string[] {
  const dbSrc = src('src/core/db/database.ts');
  const start = dbSrc.indexOf('const migrations: string[] = [');
  const end = dbSrc.indexOf('\n  ];', start);
  return [...dbSrc.slice(start, end).matchAll(/`([^`]*)`/g)].map((m) => m[1]);
}
const MIGRATIONS = realMigrations();

/** Zwei Filialen, in jeder ein eigener Artikel — daran wird sichtbar, wessen Daten kommen. */
function twoBranchDb(): Db {
  const db = new SQL.Database() as unknown as Db;
  db.run(src('src/core/db/schema.sql'));
  for (const stmt of MIGRATIONS) { try { db.run(stmt); } catch { /* schon da */ } }
  for (const [b, name] of [['branch-a', 'Filiale A'], ['branch-b', 'Filiale B']]) {
    db.run('INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES (?,?,?,?,?)', [b, 'tenant-1', name, NOW, NOW]);
    db.run(`INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?)`, ['cat-' + b, b, 'Kat ' + b, 'w', '#000', NOW, NOW]);
    db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, condition, scope_of_delivery,
        purchase_price, purchase_currency, planned_sale_price, stock_status, tax_scheme, days_in_stock,
        quantity, images, attributes, source_type, created_at, updated_at)
      VALUES (?,?,?,?,?,?, 'Pre-Owned','[]', 100,'BHD',150,'in_stock','VAT_10',0,1,'[]','{}','OWN',?,?)`,
    ['p-' + b, b, 'cat-' + b, 'Zenith', 'Artikel ' + b, 'SKU-' + b, NOW, NOW]);
  }
  setTestDatabase(db as never);
  return db;
}

type Reply = { kind: string; value?: { data?: Record<string, unknown> }; code?: string };
const remoteRead = (op: string, payload: unknown, branchId: string) =>
  executeCommand(op, { actor: { tenantId: 'tenant-1', branchId, userId: 'user-b', role: 'ADMIN' }, input: payload },
    { tenantId: 'tenant-1', branchId, userId: 'user-b', role: 'ADMIN' } as never) as Promise<Reply>;

const SENTINEL = { id: 'sentinel', name: 'NICHT ANFASSEN' } as never;

// ── A — der Bildschirm des Primary bleibt unberührt ─────────────────────────
{
  twoBranchDb();
  setPrimarySession('branch-a', 'user-a');
  // Der Primary hat seinen eigenen Stand vor sich: eine Liste und eine Auswahl.
  useProductStore.setState({ products: [SENTINEL], selectedProduct: SENTINEL, searchQuery: 'gold' } as never);
  const before = JSON.stringify({
    products: useProductStore.getState().products,
    selected: (useProductStore.getState() as unknown as { selectedProduct?: unknown }).selectedProduct,
    query: (useProductStore.getState() as unknown as { searchQuery?: unknown }).searchQuery,
  });

  const reply = await remoteRead('store.products.get', {}, 'branch-b');
  ok(reply.kind === 'ok', `A die Auskunft antwortet (${reply.kind}${reply.code ? ' ' + reply.code : ''})`);

  const after = JSON.stringify({
    products: useProductStore.getState().products,
    selected: (useProductStore.getState() as unknown as { selectedProduct?: unknown }).selectedProduct,
    query: (useProductStore.getState() as unknown as { searchQuery?: unknown }).searchQuery,
  });
  ok(after === before, 'A der sichtbare Zustand des Primary ist bitgenau derselbe geblieben');
}

// ── B — gelesen wird die Filiale des ANFRAGENDEN ────────────────────────────
{
  twoBranchDb();
  setPrimarySession('branch-a', 'user-a');
  const reply = await remoteRead('store.products.get', {}, 'branch-b');
  const rows = (reply.value?.data?.products ?? []) as Array<{ id?: string; branchId?: string }>;
  ok(rows.length === 1, `B genau der eine Artikel der Filiale des Anfragenden (${rows.length})`);
  ok(rows[0]?.id === 'p-branch-b', `B …und zwar der aus B, nicht der des Primary (${rows[0]?.id})`);
}

// ── C — was im Rumpf steht, ist niemals Autorität ───────────────────────────
{
  twoBranchDb();
  setPrimarySession('branch-a', 'user-a');
  const reply = await remoteRead('store.products.get', { branchId: 'branch-a', tenantId: 'tenant-1' }, 'branch-b');
  const rows = (reply.value?.data?.products ?? []) as Array<{ id?: string }>;
  ok(rows.every((r) => r.id !== 'p-branch-a'),
    `C ein Filialwunsch im Rumpf aendert nichts (${rows.map((r) => r.id).join(',') || 'leer'})`);
}

// ── D — zwei Fernkontexte nacheinander, ohne sich zu vermischen ─────────────
{
  twoBranchDb();
  setPrimarySession('branch-a', 'user-a');
  const b = await remoteRead('store.products.get', {}, 'branch-b');
  const a = await remoteRead('store.products.get', {}, 'branch-a');
  const idsB = ((b.value?.data?.products ?? []) as Array<{ id?: string }>).map((r) => r.id).join(',');
  const idsA = ((a.value?.data?.products ?? []) as Array<{ id?: string }>).map((r) => r.id).join(',');
  ok(idsB === 'p-branch-b' && idsA === 'p-branch-a', `D zwei Kontexte, zwei Antworten (${idsB} | ${idsA})`);
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central ui parity r1: read isolation and identity: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R1_REMOTE_READ_ISOLATION_PROVED');
