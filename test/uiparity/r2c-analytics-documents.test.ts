// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R2C — die Auswertung und der Beleginhalt über das Netz.
// Run: node --experimental-strip-types test/uiparity/r2c-analytics-documents.test.ts
//
// Die Auswertungsseite war die letzte GESCHÄFTSfläche, die ihre Zahlen selbst in der Datenbank
// zusammenrechnete — rund fünfzig Abfragen, verteilt über die Seite. Auf einem Rechner ohne
// Datenbank fing jede einzelne ihren Fehler ab und lieferte eine leere Menge: die Seite zeigte
// überall NULL. Dieses Gate hält fest, was jetzt gilt:
//
//   A  Die Rechnung liegt in einer gemeinsamen, zustandsfreien Ladefunktion.
//   B  Über das Netz kommt EIN Ergebnis, nicht fünfzig Anfragen.
//   C  Die Zahlen stimmen — gegen von Hand gerechnete Erwartungen aus der Fixture.
//   D  Sie gehören der Filiale des Anfragenden. Der Mensch am Primary sitzt woanders.
//   E  Der Beleginhalt reist nur für genau den Beleg, den jemand öffnet, und nie über die
//      Filialgrenze.
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
 * Zwei Filialen mit ABSICHTLICH verschiedenen Zahlen, damit jede Verwechslung auffällt:
 *
 *   Filiale A — 1 Artikel im Bestand (EK 100 / VK 150), 1 abgeschlossene Rechnung über 200
 *               brutto, 1 angefangene über 90 brutto mit 30 bezahlt, 1 Einkauf mit 5 Vorsteuer,
 *               1 Beleg mit echtem Inhalt.
 *   Filiale B — 2 Artikel (EK 7 / VK 9 je Stueck), 1 abgeschlossene Rechnung über 500, sonst nichts.
 *   Filiale C — leer; dort sitzt der Mensch am Primary.
 */
let db: Db;
function fixture(): void {
  db = new SQL.Database() as unknown as Db;
  db.run(src('src/core/db/schema.sql'));
  for (const stmt of MIGRATIONS) { try { db.run(stmt); } catch { /* schon da */ } }
  for (const b of ['branch-a', 'branch-b', 'branch-c']) {
    db.run('INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES (?,?,?,?,?)', [b, 'tenant-1', 'Filiale ' + b, NOW, NOW]);
    db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, company, country, language,
        vip_level, preferences, customer_type, sales_stage, created_at, updated_at)
      VALUES (?,?,?,?,'','BH','en','NONE','[]','PRIVATE','active',?,?)`, ['cust-' + b, b, 'Kunde', b, NOW, NOW]);
    db.run(`INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?)`, ['cat-' + b, b, 'Kat', 'w', '#000', NOW, NOW]);
  }
  const produkt = (id: string, b: string, ek: number, vk: number) =>
    db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, condition, scope_of_delivery,
        purchase_price, purchase_currency, planned_sale_price, stock_status, tax_scheme, days_in_stock,
        quantity, images, attributes, source_type, created_at, updated_at)
      VALUES (?,?,?,'Zenith','Artikel',?, 'Pre-Owned','[]',?,'BHD',?,'in_stock','VAT_10',0,1,'[]','{}','OWN',?,?)`,
    [id, b, 'cat-' + b, 'SKU-' + id, ek, vk, NOW, NOW]);
  produkt('prod-a1', 'branch-a', 100, 150);
  produkt('prod-b1', 'branch-b', 7, 9);
  produkt('prod-b2', 'branch-b', 7, 9);

  const rechnung = (id: string, b: string, nr: string, status: string, net: number, vat: number, gross: number, paid: number) =>
    db.run(`INSERT INTO invoices (id, branch_id, invoice_number, customer_id, status, net_amount,
        vat_rate_snapshot, vat_amount, gross_amount, tax_scheme_snapshot, purchase_price_snapshot,
        sale_price_snapshot, margin_snapshot, paid_amount, created_at, updated_at)
      VALUES (?,?,?,?,?,?,10,?,?, 'VAT_10', 0, 0, 0, ?, ?, ?)`,
    [id, b, nr, 'cust-' + b, status, net, vat, gross, paid, NOW, NOW]);
  rechnung('inv-a1', 'branch-a', 'INV-A1', 'FINAL', 180, 20, 200, 200);
  rechnung('inv-a2', 'branch-a', 'INV-A2', 'PARTIAL', 82, 8, 90, 30);
  rechnung('inv-b1', 'branch-b', 'INV-B1', 'FINAL', 450, 50, 500, 500);

  db.run(`INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at)
    VALUES ('sup-a','branch-a','Lieferant A',1,?,?)`, [NOW, NOW]);
  db.run(`INSERT INTO purchases (id, branch_id, purchase_number, supplier_id, status,
      total_amount, paid_amount, remaining_amount, purchase_date, created_at, updated_at)
    VALUES ('pu-a','branch-a','PUR-A','sup-a','UNPAID',55,0,55,?,?,?)`, [NOW, NOW, NOW]);
  db.run(`INSERT INTO purchase_lines (id, purchase_id, product_id, quantity, unit_price, line_total,
      position, tax_scheme, vat_rate, vat_amount)
    VALUES ('pl-a','pu-a','prod-a1',1,50,55,0,'VAT_10',10,5)`);

  const inhalt = 'data:image/png;base64,' + 'A'.repeat(2048);
  db.run(`INSERT INTO documents (id, branch_id, file_name, file_path, file_type, file_size,
      doc_class, created_at) VALUES ('doc-a','branch-a','beleg.png',?,'image/png',2048,'other',?)`, [inhalt, NOW]);
  db.run(`INSERT INTO documents (id, branch_id, file_name, file_path, file_type, file_size,
      doc_class, created_at) VALUES ('doc-legacy','branch-a','alt.png','C:\\\\alt\\\\pfad\\\\alt.png','image/png',10,'other',?)`, [NOW]);

  setTestDatabase(db as never);
}

type Reply = { kind: string; value?: { data?: Record<string, unknown> }; code?: string };
const remoteRead = (op: string, payload: unknown, branchId: string) =>
  executeCommand(op, { actor: { tenantId: 'tenant-1', branchId, userId: 'user-' + branchId, role: 'ADMIN' }, input: payload },
    { tenantId: 'tenant-1', branchId, userId: 'user-' + branchId, role: 'ADMIN' } as never) as Promise<Reply>;

type Snap = { sales?: Record<string, number>; stock?: Record<string, number>; finance?: Record<string, number>; clients?: Record<string, number> };
const snapOf = (r: Reply) => (r.value?.data?.snapshot ?? null) as Snap | null;

fixture();
setPrimarySession('branch-c', 'user-c');   // der Mensch am Primary sitzt in einer DRITTEN Filiale

// ── A — die Rechnung liegt nicht mehr in der Seite ─────────────────────────
{
  const page = src('src/pages/analytics/AnalyticsPage.tsx');
  const mod = src('src/core/reports/analytics-snapshot.ts');
  // Geprüft wird der CODE, nicht die Prosa: die Kopfzeilen erzählen ja gerade davon, was hier
  // nicht mehr passiert. Ein Test, der über seinen eigenen Kommentar stolpert, prüft nichts.
  const codeOf = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/([^:])\/\/.*$/gm, '$1');
  const modCode = codeOf(mod);
  ok(!/\bqry\(/.test(codeOf(page)), 'A die Seite stellt keine eigene Abfrage mehr');
  ok(!/currentBranchId\(\)/.test(modCode), 'A und die gemeinsame Rechnung kennt keine Primary-Sitzung');
  ok(!/\buseState\b|\buseMemo\b|\buseEffect\b|zustand|\.setState\(|getState\(\)/.test(modCode),
    'A sie hat keinen Bildschirm- und keinen Speicherzustand');
  const abfragen = (mod.match(/\bqry\(/g) ?? []).length;
  ok(abfragen >= 45, `A die rund fuenfzig Abfragen sind vollstaendig mitgezogen (${abfragen})`);
  const ctxAbfragen = (mod.match(/ctx\.branchId/g) ?? []).length;
  ok(ctxAbfragen >= 4, `A und jede der vier Auswertungen nimmt ihre Filiale aus dem Ausweis (${ctxAbfragen})`);
}

// ── B — EIN Netzaufruf, nicht fünfzig ─────────────────────────────────────
{
  const storeSrc = src('src/stores/analyticsStore.ts');
  ok(/hydrateFromPrimary\('store\.analytics\.get'/.test(storeSrc), 'B der Bestand holt die Auswertung mit EINER benannten Auskunft');
  const aufrufe = (storeSrc.match(/hydrateFromPrimary\(|fetchFromPrimary\(/g) ?? []).length;
  ok(aufrufe === 2, `B genau zwei Fernwege: die Auswertung und der Steuerbericht auf Abruf (${aufrufe})`);
  const reply = await remoteRead('store.analytics.get', {}, 'branch-a');
  const s = snapOf(reply);
  ok(reply.kind === 'ok' && !!s, `B die Auskunft antwortet mit einem Ergebnis (${reply.kind} ${reply.code ?? ''})`);
  ok(!!s?.sales && !!s?.stock && !!s?.finance && !!s?.clients, 'B und zwar mit allen vier Bloecken auf einmal');
}

// ── C — die Zahlen stimmen, gegen die Fixture gerechnet ───────────────────
{
  const a = snapOf(await remoteRead('store.analytics.get', {}, 'branch-a'));
  const b = snapOf(await remoteRead('store.analytics.get', {}, 'branch-b'));

  // Verkauf: nur ABGESCHLOSSENE Rechnungen zaehlen.
  ok(a?.sales?.invoiceCount === 1 && a?.sales?.grossRevenue === 200,
    `C Verkauf A: eine Rechnung ueber 200 (${a?.sales?.invoiceCount} / ${a?.sales?.grossRevenue})`);
  ok(b?.sales?.invoiceCount === 1 && b?.sales?.grossRevenue === 500,
    `C Verkauf B: eine Rechnung ueber 500 (${b?.sales?.invoiceCount} / ${b?.sales?.grossRevenue})`);

  // Bestand: Stueckzahl, Einkaufs- und Verkaufswert.
  ok(a?.stock?.totalItems === 1 && a?.stock?.totalEK === 100 && a?.stock?.totalVK === 150,
    `C Bestand A: 1 Stueck, 100 EK, 150 VK (${a?.stock?.totalItems}/${a?.stock?.totalEK}/${a?.stock?.totalVK})`);
  ok(b?.stock?.totalItems === 2 && b?.stock?.totalEK === 14 && b?.stock?.totalVK === 18,
    `C Bestand B: 2 Stueck, 14 EK, 18 VK (${b?.stock?.totalItems}/${b?.stock?.totalEK}/${b?.stock?.totalVK})`);

  // Einkauf: die Vorsteuer kommt aus den Einkaufszeilen — nur A hat eine.
  ok(a?.finance?.totalInputVat === 5, `C Einkauf A: 5 Vorsteuer (${a?.finance?.totalInputVat})`);
  ok(b?.finance?.totalInputVat === 0, `C Einkauf B: keine (${b?.finance?.totalInputVat})`);

  // Forderungen: die angefangene Rechnung, 90 brutto minus 30 bezahlt.
  ok(a?.finance?.openCount === 1 && a?.finance?.openValue === 60,
    `C Forderungen A: eine offene ueber 60 (${a?.finance?.openCount} / ${a?.finance?.openValue})`);
  ok(b?.finance?.openCount === 0 && b?.finance?.openValue === 0,
    `C Forderungen B: keine (${b?.finance?.openCount} / ${b?.finance?.openValue})`);

  // Verbindlichkeiten: derselbe Einkauf, gesehen von der anderen Seite.
  const payA = (await remoteRead('store.payables.get', {}, 'branch-a')).value?.data?.payables as Array<{ sourceId?: string; outstanding?: number }> ?? [];
  const payB = (await remoteRead('store.payables.get', {}, 'branch-b')).value?.data?.payables as unknown[] ?? [];
  ok(payA.length === 1 && payA[0]?.sourceId === 'pu-a' && payA[0]?.outstanding === 55,
    `C Verbindlichkeiten A: der Einkauf ueber 55 (${payA.length})`);
  ok(payB.length === 0, `C Verbindlichkeiten B: keine (${payB.length})`);

  // Kunden: je Filiale genau einer.
  ok(a?.clients?.totalClients === 1 && b?.clients?.totalClients === 1,
    `C Kunden: je Filiale einer (${a?.clients?.totalClients} / ${b?.clients?.totalClients})`);
}

// ── D — Ausweis schlägt Sitzung und schlägt Rumpf ─────────────────────────
{
  for (const primary of ['branch-a', 'branch-b', 'branch-c']) {
    setPrimarySession(primary, 'user-' + primary);
    const a = snapOf(await remoteRead('store.analytics.get', {}, 'branch-a'));
    ok(a?.sales?.grossRevenue === 200, `D die Sitzung am Primary (${primary}) aendert die Auswertung fuer A nicht`);
  }
  setPrimarySession('branch-c', 'user-c');
  const gewuenscht = snapOf(await remoteRead('store.analytics.get', { branchId: 'branch-a', tenantId: 'tenant-1' }, 'branch-b'));
  ok(gewuenscht?.sales?.grossRevenue === 500,
    `D ein Filialwunsch im Rumpf holt nicht die Zahlen von A (${gewuenscht?.sales?.grossRevenue})`);

  // Der Steuerbericht folgt derselben Regel.
  const vatA = (await remoteRead('analytics.vat_export.get', {}, 'branch-a')).value?.data as { invoices?: unknown[]; lines?: unknown[] } | undefined;
  const vatB = (await remoteRead('analytics.vat_export.get', { branchId: 'branch-a' }, 'branch-b')).value?.data as { invoices?: Array<{ invoice_number?: string }> } | undefined;
  ok((vatA?.invoices ?? []).length === 1 && (vatA?.lines ?? []).length === 0,
    `D der Steuerbericht von A nennt seine eine abgeschlossene Rechnung (${(vatA?.invoices ?? []).length})`);
  ok((vatB?.invoices ?? []).every((r) => r.invoice_number !== 'INV-A1'),
    'D und der von B enthaelt keine Zeile aus A');
}

// ── E — der Beleginhalt: genannt, filialgebunden, und nur wenn es Inhalt IST ──
{
  const mine = await remoteRead('documents.content.get', { documentId: 'doc-a' }, 'branch-a');
  const content = (mine.value?.data as { content?: string } | undefined)?.content ?? '';
  ok(mine.kind === 'ok' && content.startsWith('data:image/png;base64,'),
    `E der eigene Beleg kommt mit Inhalt (${mine.kind})`);

  const foreign = await remoteRead('documents.content.get', { documentId: 'doc-a' }, 'branch-b');
  ok(foreign.kind !== 'ok', `E derselbe Beleg aus einer fremden Filiale: nicht da (${foreign.kind} ${foreign.code ?? ''})`);
  ok(!JSON.stringify(foreign).includes('base64'), 'E …und kein Byte davon steht in der Antwort');

  const ohneId = await remoteRead('documents.content.get', {}, 'branch-a');
  ok(ohneId.kind !== 'ok', `E ohne Kennung gibt es nichts (${ohneId.kind})`);

  // Alte Bestaende koennen einen echten Dateipfad im Feld haben. Der geht niemanden an.
  const legacy = await remoteRead('documents.content.get', { documentId: 'doc-legacy' }, 'branch-a');
  const legacyContent = (legacy.value?.data as { content?: string } | undefined)?.content ?? 'x';
  ok(legacyContent === '', 'E ein echter Dateipfad wird nicht als Inhalt ausgeliefert');
  ok(!JSON.stringify(legacy).includes('alt\\pfad'), 'E und er steht auch sonst nicht in der Antwort');

  // Die Liste bleibt ohne Inhalt — sonst waere der eigene Weg oben sinnlos.
  const liste = (await remoteRead('store.documents.get', {}, 'branch-a')).value?.data?.documents as Array<{ filePath?: string }> ?? [];
  ok(liste.length === 2 && liste.every((d) => d.filePath === ''), `E die Liste selbst traegt keinen Inhalt (${liste.length})`);
}

// ── F — kein Fernlesen fasst den Bildschirm des Primary an ────────────────
{
  const analytics = await import('../../src/stores/analyticsStore.ts');
  const documents = await import('../../src/stores/documentStore.ts');
  const hooks = [analytics.useAnalyticsStore, documents.useDocumentStore] as Array<{
    getState(): Record<string, unknown>; setState(p: Record<string, unknown>): void;
  }>;
  for (const h of hooks) h.setState({ __sentinel: 'NICHT ANFASSEN' });
  const vorher = hooks.map((h) => JSON.stringify(h.getState()));

  await remoteRead('store.analytics.get', {}, 'branch-a');
  await remoteRead('analytics.vat_export.get', {}, 'branch-a');
  await remoteRead('documents.content.get', { documentId: 'doc-a' }, 'branch-a');
  await remoteRead('store.documents.get', {}, 'branch-a');

  ok(hooks.every((h, i) => JSON.stringify(h.getState()) === vorher[i]),
    'F Auswertung, Steuerbericht und Beleg haben keinen einzigen Primary-Bestand veraendert');
  // Und der Bestand traegt weiterhin den Sentinel, nicht etwa ein Ergebnis.
  ok(analytics.useAnalyticsStore.getState().snapshot === null,
    'F insbesondere steht die Auswertung des Anfragenden NICHT im Bestand des Primary');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central ui parity r2c: analytics and document content: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R2C_ANALYTICS_SURFACE_AUDITED');
console.log('CENTRAL_UI_R2C_SHARED_ANALYTICS_LOADER_PROVED');
console.log('CENTRAL_UI_R2C_ANALYTICS_REMOTE_CONTRACT_PROVED');
console.log('CENTRAL_UI_R2C_ANALYTICS_SCOPE_PROVED');
console.log('CENTRAL_UI_R2C_DOCUMENT_CONTENT_PARITY_PROVED');
console.log('CENTRAL_UI_R2C_PRIMARY_STATE_ISOLATION_PROVED');
