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
let twoBranchDbHandle: Db;
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
  twoBranchDbHandle = db;
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

// ── E — R2A: dieselbe Frage fuer JEDE migrierte Flaeche, datengetrieben ─────
//
// Kein eigener Riesentest je Domaene: eine Schleife ueber alle branchabhaengigen Auskuenfte, und
// fuer jede dieselben drei Zusagen — der Bildschirm des Primary bleibt, die Daten sind die des
// Anfragenden, und ein Filialwunsch im Rumpf aendert nichts.
{
  const OPS = [
    'store.products.get', 'store.customers.get', 'store.invoices.get',
    'store.suppliers.get', 'store.sales_returns.get', 'store.credit_notes.get',
    'store.orders.get', 'store.consignments.get', 'store.purchases.get',
    'store.repairs.get', 'store.agents.get',
    // R2B — Finanzen und Betriebsfuehrung. Dieselben drei Zusagen, kein neuer Test je Domaene.
    'store.expenses.get', 'store.recurring_expenses.get', 'store.banking.get',
    'store.payables.get', 'store.debts.get', 'store.gold.get', 'store.metals.get',
    'store.scrap_trades.get', 'store.employees.get', 'store.partners.get',
    'store.tasks.get', 'store.documents.get', 'store.offers.get', 'store.production.get',
  ];
  twoBranchDb();
  setPrimarySession('branch-a', 'user-a');

  // Der Primary haelt einen Sentinel-Zustand in JEDEM beteiligten Speicher.
  const stores = await Promise.all([
    import('../../src/stores/productStore.ts'), import('../../src/stores/customerStore.ts'),
    import('../../src/stores/invoiceStore.ts'), import('../../src/stores/supplierStore.ts'),
    import('../../src/stores/salesReturnStore.ts'), import('../../src/stores/creditNoteStore.ts'),
    import('../../src/stores/orderStore.ts'), import('../../src/stores/consignmentStore.ts'),
    import('../../src/stores/purchaseStore.ts'), import('../../src/stores/repairStore.ts'),
    import('../../src/stores/agentStore.ts'),
    import('../../src/stores/expenseStore.ts'), import('../../src/stores/recurringExpenseStore.ts'),
    import('../../src/stores/bankingStore.ts'), import('../../src/stores/payablesStore.ts'),
    import('../../src/stores/debtStore.ts'), import('../../src/stores/goldStore.ts'),
    import('../../src/stores/metalStore.ts'), import('../../src/stores/scrapTradeStore.ts'),
    import('../../src/stores/employeeStore.ts'), import('../../src/stores/partnerStore.ts'),
    import('../../src/stores/taskStore.ts'), import('../../src/stores/documentStore.ts'),
    import('../../src/stores/offerStore.ts'), import('../../src/stores/productionStore.ts'),
  ]);
  const hooks = stores.map((m) => Object.values(m).find(
    (v) => typeof v === 'function' && typeof (v as { getState?: unknown }).getState === 'function',
  ) as { getState(): Record<string, unknown>; setState(p: Record<string, unknown>): void });
  for (const h of hooks) h.setState({ __sentinel: 'NICHT ANFASSEN' });
  const before = hooks.map((h) => JSON.stringify(h.getState().__sentinel));

  let answered = 0;
  for (const op of OPS) {
    const reply = await remoteRead(op, { branchId: 'branch-a', tenantId: 'tenant-1' }, 'branch-b');
    if (reply.kind === 'ok') answered++;
    else ok(false, `E ${op} antwortet (${reply.kind} ${reply.code ?? ''})`);
  }
  ok(answered === OPS.length, `E alle ${OPS.length} migrierten Auskuenfte antworten (${answered})`);
  ok(hooks.every((h, i) => JSON.stringify(h.getState().__sentinel) === before[i]),
    'E und kein einziger Primary-Speicher wurde dabei angefasst');

  // Und die Daten sind die des Anfragenden — an der Flaeche gepruefT, die Zeilen in beiden hat.
  const pa = await remoteRead('store.products.get', {}, 'branch-a');
  const pb = await remoteRead('store.products.get', {}, 'branch-b');
  const idsA = ((pa.value?.data?.products ?? []) as Array<{ id?: string }>).map((r) => r.id).join(',');
  const idsB = ((pb.value?.data?.products ?? []) as Array<{ id?: string }>).map((r) => r.id).join(',');
  ok(idsA === 'p-branch-a' && idsB === 'p-branch-b', `E zwei Ausweise, zwei Antworten (${idsA} | ${idsB})`);
}

// ── F — Parameter schraenken ein, sie berechtigen nicht ────────────────────
{
  twoBranchDb();
  setPrimarySession('branch-a', 'user-a');
  // Ein Auftrag samt Zahlung in Filiale A.
  const dbA = twoBranchDbHandle;
  dbA.run(`INSERT INTO customers (id, branch_id, first_name, last_name, company, country, language,
      vip_level, preferences, customer_type, sales_stage, created_at, updated_at)
    VALUES ('c-a','branch-a','Kunde','A','','BH','en','NONE','[]','PRIVATE','active',?,?)`, [NOW, NOW]);
  dbA.run(`INSERT INTO orders (id, branch_id, order_number, customer_id, requested_brand,
      requested_model, status, created_at, updated_at)
    VALUES ('o-a','branch-a','ORD-A','c-a','Zenith','Elite','PENDING',?,?)`, [NOW, NOW]);
  dbA.run(`INSERT INTO order_payments (id, order_id, amount, paid_at, method, created_at)
    VALUES ('op-a','o-a',50,?,'cash',?)`, [NOW, NOW]);

  const mine = await remoteRead('order_payments.get', { orderId: 'o-a' }, 'branch-a');
  ok(((mine.value?.data?.payments ?? []) as unknown[]).length === 1,
    'F die eigene Auftragskennung liefert die eigene Zahlung');
  const foreign = await remoteRead('order_payments.get', { orderId: 'o-a' }, 'branch-b');
  ok(((foreign.value?.data?.payments ?? []) as unknown[]).length === 0,
    'F dieselbe Kennung aus einer fremden Filiale liefert NICHTS statt fremder Daten');
  const missing = await remoteRead('order_payments.get', {}, 'branch-a');
  ok(missing.kind !== 'ok', `F ohne Kennung gibt es keine Antwort (${missing.kind})`);
}

// ── G — R2B: die zwei Listen, die vorher GAR KEINE Filialgrenze hatten ─────
//
// Verbindlichkeiten und Altgold-Geschaefte zaehlten bisher ueber alle Filialen. Am
// Ein-Filial-Betrieb faellt das nicht auf; als Fernauskunft waere es die Preisgabe fremder
// Zahlen. Hier stehen echte Zeilen in Filiale A — und Filiale B darf sie nicht sehen.
{
  twoBranchDb();
  setPrimarySession('branch-a', 'user-a');
  const db = twoBranchDbHandle;
  db.run(`INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at)
    VALUES ('s-a','branch-a','Lieferant A',1,?,?)`, [NOW, NOW]);
  db.run(`INSERT INTO purchases (id, branch_id, purchase_number, supplier_id, status,
      total_amount, paid_amount, remaining_amount, purchase_date, created_at, updated_at)
    VALUES ('pu-a','branch-a','PUR-A','s-a','UNPAID',100,0,100,?,?,?)`, [NOW, NOW, NOW]);
  db.run(`INSERT INTO scrap_trades (id, branch_id, trade_number, seller_name, buyer_name,
      weight_grams, karat, purchase_price, sale_price, profit, trade_date, created_at, updated_at)
    VALUES ('st-a','branch-a','ST-A','Verkaeufer','Kaeufer',10,'21K',50,60,10,?,?,?)`, [NOW, NOW, NOW]);

  const payA = await remoteRead('store.payables.get', {}, 'branch-a');
  const payB = await remoteRead('store.payables.get', {}, 'branch-b');
  const rowsA = (payA.value?.data?.payables ?? []) as Array<{ sourceId?: string }>;
  const rowsB = (payB.value?.data?.payables ?? []) as Array<{ sourceId?: string }>;
  ok(rowsA.some((r) => r.sourceId === 'pu-a'), `G die eigene Filiale sieht ihre offene Rechnung (${rowsA.length})`);
  ok(rowsB.length === 0, `G die fremde Filiale sieht davon NICHTS (${rowsB.length})`);

  const scrapA = await remoteRead('store.scrap_trades.get', {}, 'branch-a');
  const scrapB = await remoteRead('store.scrap_trades.get', {}, 'branch-b');
  ok(((scrapA.value?.data?.trades ?? []) as unknown[]).length === 1, 'G das Altgold-Geschaeft gehoert Filiale A');
  ok(((scrapB.value?.data?.trades ?? []) as unknown[]).length === 0, 'G und Filiale B bekommt es nicht');

  // Und die Auskunft repariert nichts: der Nachtrag alter Zeilen ist ein Schreibvorgang und
  // bleibt im Weg des Primary. Die Zeile darf nach dem Fernlesen unveraendert sein.
  const after = db.exec('SELECT status FROM scrap_trades WHERE id = ?', ['st-a']);
  ok(String(after[0]?.values?.[0]?.[0] ?? '') === 'completed', 'G und sie hat die Zeile nicht angefasst');
}

// ── H — R2B: der Beleg reist ohne seinen Inhalt ────────────────────────────
//
// In dieser Tabelle steht die ganze Datei als Data-URL im Feld \`file_path\`. Die Liste soll
// ueber das Netz gehen, der Inhalt nicht — sonst waeren es je Aufruf viele Megabyte.
{
  twoBranchDb();
  setPrimarySession('branch-a', 'user-a');
  const db = twoBranchDbHandle;
  const fat = 'data:image/png;base64,' + 'A'.repeat(4096);
  db.run(`INSERT INTO documents (id, branch_id, file_name, file_path, file_type, file_size,
      doc_class, created_at) VALUES ('d-a','branch-a','beleg.png',?,'image/png',4096,'other',?)`,
    [fat, NOW]);

  const reply = await remoteRead('store.documents.get', {}, 'branch-a');
  const docs = (reply.value?.data?.documents ?? []) as Array<{ id?: string; fileName?: string; filePath?: string }>;
  ok(docs.length === 1 && docs[0].fileName === 'beleg.png', `H die Liste kommt an (${docs.length})`);
  ok(docs[0]?.filePath === '', 'H aber ohne den Dateiinhalt');
  ok(!JSON.stringify(reply.value ?? {}).includes(fat.slice(0, 64)), 'H und er steckt auch sonst nirgends in der Antwort');

  // Am Primary bleibt derselbe Loader vollstaendig — sonst waere die Vorschau dort kaputt.
  const { loadDocumentsFor } = await import('../../src/stores/documentStore.ts');
  const local = loadDocumentsFor({ tenantId: 'tenant-1', branchId: 'branch-a', userId: 'user-a', role: 'ADMIN' });
  ok(local.documents[0]?.filePath === fat, 'H der Primary liest den Inhalt weiterhin');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central ui parity r1: read isolation and identity: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R1_REMOTE_READ_ISOLATION_PROVED');
