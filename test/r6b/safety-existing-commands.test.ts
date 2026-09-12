// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6B — die acht B-Einstiege, und die gefährlichen Stellen auf dem zweiten Rechner.
// Run: node test/r6b/safety-existing-commands.test.ts
//
//   §1 B-Umfang aus der R6A-SSOT eingefroren (8 Einstiege → 6 vorhandene Buchungen), jede angeschlossen.
//   §2 Primary zuerst: Abholen nur über den Hausübergang, Rückgabe nur aktiv, Datum eine Regel,
//      KI-Bestätigung ohne Feldöffnung — und die Rümpfe, wie die Fernbefehle sie annehmen.
//   §3 Inventur/Stock-Check ohne eigene Datenbank: kein Aufruf des lokalen Kerns, kein Schein-Erfolg.
//   §4 Import gesperrt.  §5 Abmelden auf dem Client ohne Datenbank.  §6 kein Schein-Erfolg.
//   §7 die 28 Löschknöpfe gesperrt und erklärt.  §8 Registry 108, Matrix 36/0/0/4 unverändert.
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
]);
const storage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};
let alerts = 0;
(globalThis as { localStorage?: unknown }).localStorage = storage;
(globalThis as { window?: unknown }).window = { localStorage: storage, alert: () => { alerts++; } };
const alsClient = (): void => { store.set('lataif_runtime_mode', 'client'); };
const alsPrimary = (): void => { store.delete('lataif_runtime_mode'); };

const initSqlJs = (await import('sql.js')).default;
const SQL = await initSqlJs({ locateFile: (f: string) => resolvePath(repo, 'node_modules/sql.js/dist', f) });

const { setTestDatabase } = await import('../sync/_db-shim.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const { ALLOWED_MUTATIONS } = await import('../../src/core/bridge/command-registry.ts');
const invCmd = await import('../../src/core/bridge/invoice-lifecycle-commands.ts');
const life = await import('../../src/core/bridge/lifecycle-commands.ts');
const prodCmd = await import('../../src/core/bridge/product-commands.ts');
const { PRODUCT_UPDATE_FIELDS } = await import('../../src/core/data/write-payloads.ts');
const aiConfirm = await import('../../src/core/products/ai-confirm.ts');
const conRet = await import('../../src/core/consignment/consignment-return.ts');
const flow = await import('../../src/core/repairs/repair-status-flow.ts');
const primaryOnly = await import('../../src/core/data/primary-only.ts');
const stock = await import('../../src/core/stock/stock-check.ts');
const { issuedAtIso } = await import('../../src/core/invoices/issued-at.ts');
const { AuthService } = await import('../../src/core/auth/auth.ts');
const { R4C_MATRIX, R5F1_NEUE_BUCHUNGEN } = await import('../uiparity/_r4c-write-matrix.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
/** Ein Marker nur, wenn sein Abschnitt ohne einen einzigen Fehlschlag durchlief. */
let seit = 0;
const marker = (m: string): void => { if (fails.length === seit) console.log(m); seit = fails.length; };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const codeOf = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
const S = (v: unknown): string => JSON.stringify(v);
const NOW = '2026-09-12T10:00:00.000Z';
const wirft = (f: () => unknown): string => { try { f(); return ''; } catch (e) { return String((e as { code?: unknown }).code ?? '') + ' ' + String((e as Error).message ?? e); } };
async function wirftAsync(f: () => Promise<unknown>): Promise<string> {
  try { await f(); return ''; } catch (e) { return String((e as { code?: unknown }).code ?? '') + ' ' + String((e as Error).message ?? e); }
}
/** Der Körper einer Funktion (bis zur schließenden Klammer auf Einrückung `ind`). */
const koerper = (code: string, kopf: RegExp, ind = 2): string => {
  const m = kopf.exec(code); if (!m) return '';
  const rest = code.slice(m.index);
  const ende = rest.search(new RegExp(`\\n {${ind}}\\}`));
  return ende < 0 ? rest : rest.slice(0, ende + ind + 2);
};

// ══ §1 — der B-Umfang, aus der R6A-SSOT gelesen (nicht aus der Erinnerung) ══════
{
  const doc = src('docs/central-ui-parity.md');
  const r6a = doc.slice(doc.indexOf('### Write-Gap-SSOT'), doc.indexOf('### Keine toten Knöpfe'));
  const b = r6a.split('\n').filter((l) => /^\| /.test(l)).map((l) => l.split('|').map((x) => x.trim())).filter((p) => p[5] === 'B');
  const ops = b.map((p) => (p[6].match(/[a-z_]+\.[a-z_]+/) ?? [''])[0]).sort();
  ok(b.length === 8, `B-SCOPE die R6A-SSOT nennt genau acht B-Einstiege (${b.length})`);
  ok(S(ops) === S(['consignments.mark_returned', 'consignments.mark_returned', 'invoices.record_payment', 'invoices.record_payment',
    'invoices.update', 'orders.add_payment', 'products.update', 'repairs.update_status']),
  `B-SCOPE sechs vorhandene Buchungen, zwei davon doppelt (${ops.join(', ')})`);
  ok(ops.every((o) => ALLOWED_MUTATIONS.includes(o)), 'B-SCOPE jede davon steht bereits in der Registry — keine neue');
}
{
  // Rechnung ändern (Edit-Seite) → invoices.update
  const c = codeOf(src('src/pages/invoices/InvoiceCreate.tsx'));
  const save = koerper(c, /async function performSave\(/);
  ok(/useSharedWrite<.*?>\('invoices\.update'\)/.test(c) && /aendernRechnung\.save\(\{/.test(save), 'WIRE InvoiceCreate: das Ändern geht über `invoices.update`');
  ok(/local: \(\) => \{\s*editInvoiceFn\(invId,/.test(save) && (save.match(/editInvoiceFn\(/g) ?? []).length === 1,
    'WIRE InvoiceCreate: editInvoice läuft NUR im lokalen Anschluss');
  ok(/remote: \(\) => \(\{\s*id: invId,\s*expectedRevision: fassung,\s*reason,\s*customerId,/.test(save) && !/remote: \(\) => \(\{[^}]*deltaPayment/.test(save),
    'WIRE InvoiceCreate: der Rumpf nennt Rechnung, gesehene Fassung, Grund — und keine Zahlung');
  ok(/aendernRechnung\.remote && deltaPayment\)[\s\S]{0,120}nichtAmClient\('recording a payment while editing an invoice'\)/.test(save)
    && !/nichtAmClient\('editing an invoice'\)/.test(c),
  'WIRE InvoiceCreate: eine Zahlung im Ändern ist fern ein ehrliches Nein; das pauschale Nein ist weg');
}
{
  // InvoiceList: Zahlung + Nummernwahl → invoices.record_payment
  const c = codeOf(src('src/pages/invoices/InvoiceList.tsx'));
  ok((c.match(/w\.ok\('invoices\.record_payment'/g) ?? []).length === 2, 'WIRE InvoiceList: beide Einstiege fahren `invoices.record_payment`');
  ok((c.match(/recordPayment\(/g) ?? []).length === 2 && (c.match(/local: \(\) => \{ recordPayment\(/g) ?? []).length === 2,
    'WIRE InvoiceList: recordPayment läuft NUR in den lokalen Anschlüssen');
  ok(/if \(w\.remote && specialMark\) \{ alert\(fehlertext\(nichtAmClient\('the special number circle'\)\)\); return; \}/.test(c),
    'WIRE InvoiceList: der Sonderkreis ist fern ein ehrliches Nein (wie auf der Rechnungsseite)');
  ok(/remote: \(\) => \(\{ invoiceId, amount, method \}\)/.test(c) && /remote: \(\) => \(\{ invoiceId: p\.invoiceId, amount: p\.amount, method: p\.method \}\)/.test(c),
    'WIRE InvoiceList: die Rümpfe nennen Rechnung, Betrag, Weg — nichts sonst');
}
{
  // InvoiceDetail: Abholen → repairs.update_status
  const c = codeOf(src('src/pages/invoices/InvoiceDetail.tsx'));
  const f = koerper(c, /async function markRepairsPickedUp\(\)/);
  ok(/w\.ok\('repairs\.update_status'/.test(f) && /remote: \(\) => \(\{ repairId: r\.id, status: 'picked_up', expectedRevision: fassung \}\)/.test(f),
    'WIRE InvoiceDetail: „Mark as Picked Up" fährt je Reparatur `repairs.update_status` mit ihrer Fassung');
  ok((c.match(/updateRepairStatus\(/g) ?? []).length === 1 && /local: \(\) => \{ updateRepairStatus\(r\.id, 'picked_up'\)/.test(f),
    'WIRE InvoiceDetail: der Store-Aufruf steht NUR im lokalen Anschluss');
}
{
  // ProductDetail: KI-Bestätigung → products.update { aiConfirmedAt: true }
  const c = codeOf(src('src/pages/watches/ProductDetail.tsx'));
  ok(/useSharedWrite<[^>]*>\('products\.update'\)[\s\S]{0,40}/.test(c) && /bestaetigen\.save\(\{\s*local: \(\) => confirmAiIdentificationInHouse\(id\),\s*remote: \(\) => \(\{ id, aiConfirmedAt: true \}\)/.test(c),
    'WIRE ProductDetail: die Bestätigung geht über `products.update` — lokal dieselbe Hausfunktion');
  ok(!/\bupdateProduct\(/.test(c), 'WIRE ProductDetail: kein direkter updateProduct-Griff mehr');
}
{
  // OrderList → orders.add_payment
  const c = codeOf(src('src/pages/orders/OrderList.tsx'));
  ok(/w\.ok\('orders\.add_payment'/.test(c) && /remote: \(\) => \(\{ orderId, amount, method, expectedRevision: fassung, paidAt \}\)/.test(c),
    'WIRE OrderList: „Pay" fährt `orders.add_payment` mit der gesehenen Fassung');
  ok((c.match(/addPayment\(/g) ?? []).length === 1 && /local: \(\) => \{ addPayment\(\{ orderId, amount, paidAt, method \}\)/.test(c),
    'WIRE OrderList: addPayment NUR im lokalen Anschluss');
}
for (const f of ['src/pages/consignments/ConsignmentList.tsx', 'src/pages/consignors/ConsignorDetail.tsx']) {
  const c = codeOf(src(f));
  ok(/w\.save\('consignments\.mark_returned'/.test(c) && /remote: \(\) => consignmentReturnBody\(con\.id, Number\(fassung\)\)/.test(c),
    `WIRE ${f.split('/').pop()}: „Return" fährt \`consignments.mark_returned\` mit der gesehenen Fassung`);
  ok((c.match(/\bmarkReturned\(/g) ?? []).length === 1 && /local: \(\) => \{ assertConsignmentReturnable\(con\.status\); markReturned\(con\.id\);/.test(c),
    `WIRE ${f.split('/').pop()}: lokal zuerst dieselbe Regel, dann dieselbe Domänenfunktion`);
}
if (fails.length === 0) { console.log('CENTRAL_UI_R6B_CATEGORY_B_SCOPE_FROZEN'); console.log('CENTRAL_UI_R6B_EXISTING_COMMAND_ENTRYPOINTS_WIRED'); }
seit = fails.length;

// ══ §2 — Primary zuerst: die Verträge, und die Rümpfe so, wie die Fernbefehle sie annehmen ════════
{
  // Abholen: der Übergang des Hauses, nicht „jeder".
  ok(!flow.allowedRepairStatusTargets('in_progress', 'internal', 'CUSTOMER').includes('picked_up')
    && flow.allowedRepairStatusTargets('ready', 'internal', 'CUSTOMER').includes('picked_up')
    && !flow.allowedRepairStatusTargets('ready', 'internal', 'OWN').includes('picked_up'),
  'PRIMARY Abholen nur aus „ready" (Kunde) — eine Reparatur in Arbeit überspringt „ready" nicht mehr');
  const c = codeOf(src('src/pages/invoices/InvoiceDetail.tsx'));
  ok(/const pickupReady = pendingRepairs\.filter\(r => allowedRepairStatusTargets\(r\.status, r\.repairType, r\.repairScope\)\.includes\('picked_up'\)\)/.test(c)
    && /const canMarkRepairPickedUp = pickupReady\.length > 0 && isPaid;/.test(c),
  'PRIMARY die Rechnungsseite fragt dieselbe Regel wie Reparaturseite und Fernbefehl');
  const r = life.parseUpdateRepairStatus({ repairId: 'r1', status: 'picked_up', expectedRevision: 3 });
  ok(r.status === 'picked_up' && r.expectedRevision === 3, 'PRIMARY der Rumpf „picked_up + Fassung" ist der, den der Fernbefehl annimmt');
}
{
  // Kommission: nur aktiv, auf allen drei Wegen dieselbe Funktion.
  ok(conRet.consignmentReturnBlocker('active') === null && conRet.consignmentReturnBlocker('sold') === 'CONSIGNMENT_NOT_ACTIVE'
    && conRet.consignmentReturnBlocker('returned') === 'CONSIGNMENT_NOT_ACTIVE', 'PRIMARY Rückgabe nur einer aktiven Kommission');
  ok(/CONSIGNMENT_NOT_ACTIVE/.test(wirft(() => conRet.assertConsignmentReturnable('sold'))) && wirft(() => conRet.assertConsignmentReturnable('active')) === '',
    'PRIMARY der lokale Riegel wirft mit Code, bevor etwas geschrieben wird');
  const lc = codeOf(src('src/core/bridge/lifecycle-commands.ts'));
  ok(/consignmentReturnBlocker\(con\.status\)/.test(lc) && !/s\(con\.status\) !== 'active'/.test(lc), 'PRIMARY der Fernbefehl fragt DIESELBE Funktion');
  const body = conRet.consignmentReturnBody('c1', 4);
  const p = life.parseMarkConsignmentReturned(body);
  ok(p.consignmentId === 'c1' && p.expectedRevision === 4, 'PRIMARY der gemeinsame Rumpf ist der, den der Fernbefehl annimmt');
}
{
  // Rechnungsdatum: eine Regel.
  ok(issuedAtIso('2026-09-01') === '2026-09-01T00:00:00.000Z' && issuedAtIso('2026-09-01T00:00:00.000Z') === '2026-09-01T00:00:00.000Z'
    && issuedAtIso(undefined) === undefined, 'PRIMARY ein reines Datum wird Mitternacht UTC, ein ISO-Wert bleibt');
  const st = codeOf(src('src/stores/invoiceStore.ts'));
  const edit = koerper(st, /editInvoice: \(id, input\) => \{/);
  ok(/const issuedAt = issuedAtIso\(input\.issuedAt\);/.test(edit), 'PRIMARY editInvoice legt das Datum gleich ab, egal ob Maske oder Fernauftrag');
  // Der Rumpf der Edit-Seite ist einer, den `invoices.update` annimmt; eine Zahlung nicht.
  const req = invCmd.parseInvoiceUpdate({
    id: 'i1', expectedRevision: 2, reason: 'Tippfehler', customerId: 'cust-1',
    lines: [{ productId: 'p1', lotId: 'lot-1', quantity: 1, unitPrice: 200, scheme: 'VAT_10' }],
    notes: 'n', issuedDate: '2026-09-01', staffId: 'emp-1',
  });
  ok(req.id === 'i1' && req.expectedRevision === 2 && req.body.issuedDate === '2026-09-01' && req.body.lines[0].lotId === 'lot-1',
    'PRIMARY der Rumpf der Edit-Seite (mit Los, Datum, Mitarbeiter) passt auf `invoices.update`');
  ok(/payment is its own command/.test(wirft(() => invCmd.parseInvoiceUpdate({
    id: 'i1', expectedRevision: 2, reason: 'x', customerId: 'c', lines: [{ productId: 'p', quantity: 1, unitPrice: 1 }], deltaPayment: { amount: 1 },
  }))), 'PRIMARY eine Zahlung im Änderungsauftrag wird abgewiesen — deshalb fern ein ehrliches Nein');
}
{
  // Zahlung aus der Liste: derselbe Rumpf wie auf der Rechnung.
  const p = invCmd.parsePaymentPayload({ invoiceId: 'i1', amount: 50, method: 'cash' });
  ok(p.invoiceId === 'i1' && p.amount === 50 && p.method === 'cash', 'PRIMARY der Listen-Rumpf ist der der Rechnungsseite');
  ok(/unknown|specialMark|not allowed|field/i.test(wirft(() => invCmd.parsePaymentPayload({ invoiceId: 'i1', amount: 50, method: 'cash', specialMark: true }))),
    'PRIMARY der Sonderkreis ist kein Feld der Fernbuchung');
  const o = life.parseAddOrderPayment({ orderId: 'o1', amount: 10, method: 'cash', expectedRevision: 2, paidAt: '2026-09-12' });
  ok(o.orderId === 'o1' && o.expectedRevision === 2 && o.paidAt === '2026-09-12', 'PRIMARY der Auftrags-Rumpf der Liste passt auf `orders.add_payment`');
}
{
  // KI-Bestätigung: keine Feldöffnung.
  ok(!(PRODUCT_UPDATE_FIELDS as readonly string[]).includes('aiConfirmedAt'), 'PRIMARY `aiConfirmedAt` steht NICHT in der Feldliste — keine pauschale Öffnung');
  const r = prodCmd.parseProductUpdate({ id: 'p1', aiConfirmedAt: true });
  ok(r.confirmAi === true && S(r.fields) === '{}' && r.gallery === undefined, 'PRIMARY `aiConfirmedAt: true` ist eine Absicht, kein Wert');
  ok(/primary stamps the time/.test(wirft(() => prodCmd.parseProductUpdate({ id: 'p1', aiConfirmedAt: '2020-01-01T00:00:00Z' }))),
    'PRIMARY eine vom Client gewählte Zeit wird abgewiesen');
  ok(/send it alone/.test(wirft(() => prodCmd.parseProductUpdate({ id: 'p1', aiConfirmedAt: true, name: 'x' })))
    && /send it alone/.test(wirft(() => prodCmd.parseProductUpdate({ id: 'p1', aiConfirmedAt: true, gallery: [] }))),
  'PRIMARY die Absicht reist allein — kein Textfeld, keine Galerie daneben');
  const t = prodCmd.parseProductUpdate({ id: 'p1', name: 'Neu' });
  ok(t.confirmAi === undefined && t.fields.name === 'Neu', 'PRIMARY der normale Textweg bleibt unverändert');
  ok(aiConfirm.aiConfirmBlocker(undefined) === 'PRODUCT_NOT_FOUND' && aiConfirm.aiConfirmBlocker({ aiIdentifiedSnapshot: '' }) === 'AI_NOT_IDENTIFIED'
    && aiConfirm.aiConfirmBlocker({ aiIdentifiedSnapshot: '{"brand":"Rolex"}' }) === null, 'PRIMARY bestätigt wird nur, was die KI identifiziert hat');
  const pc = codeOf(src('src/core/bridge/product-commands.ts'));
  ok(/if \(confirmAi\) \{[\s\S]{0,200}confirmAiIdentificationInHouse\(id\)/.test(pc), 'PRIMARY der Fernbefehl ruft DIESELBE Hausfunktion');
}
{
  // Die Hausfunktion gegen eine echte Datenbank.
  const db = new SQL.Database() as unknown as { run(s: string, p?: unknown[]): unknown; exec(s: string, p?: unknown[]): Array<{ values: unknown[][] }> };
  db.run(src('src/core/db/schema.sql'));
  const dbSrc = src('src/core/db/database.ts');
  const start = dbSrc.indexOf('const migrations: string[] = [');
  for (const m of dbSrc.slice(start, dbSrc.indexOf('\n  ];', start)).matchAll(/`([^`]*)`/g)) { try { db.run(m[1]); } catch { /* schon da */ } }
  for (const stmt of A1_UPGRADE_SQL) { try { db.run(stmt); } catch { /* schon da */ } }
  db.run('INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES (?,?,?,?,?)', ['branch-main', 'tenant-1', 'Haupt', NOW, NOW]);
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES ('cat-w','branch-main','W','w','#000',?,?)", [NOW, NOW]);
  const art = (id: string, snap: string | null) => db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, condition, scope_of_delivery,
      purchase_price, purchase_currency, tax_scheme, stock_status, days_in_stock, images, attributes, source_type, ai_identified_snapshot, created_at, updated_at)
    VALUES (?, 'branch-main', 'cat-w', 'Tudor', ?, ?, 'New', '[]', 100, 'BHD', 'VAT_10', 'in_stock', 0, '[]', '{}', 'OWN', ?, ?, ?)`,
  [id, 'N ' + id, id.toUpperCase(), snap, NOW, NOW]);
  art('ai-1', '{"brand":"Tudor"}'); art('ai-0', null);
  setTestDatabase(db as never);
  alsPrimary();
  const eins = aiConfirm.confirmAiIdentificationInHouse('ai-1');
  const gelesen = String(db.exec('SELECT ai_confirmed_at FROM products WHERE id = ?', ['ai-1'])[0]?.values?.[0]?.[0] ?? '');
  ok(eins.aiConfirmedAt && gelesen === eins.aiConfirmedAt, `PRIMARY die Bestätigung steht in der Datenbank (${gelesen})`);
  const zwei = aiConfirm.confirmAiIdentificationInHouse('ai-1');
  ok(zwei.aiConfirmedAt === eins.aiConfirmedAt, 'PRIMARY ein zweites Bestätigen ändert nichts — der erste Stempel bleibt');
  ok(/AI_NOT_IDENTIFIED/.test(wirft(() => aiConfirm.confirmAiIdentificationInHouse('ai-0'))), 'PRIMARY ohne KI-Identifikation: ehrliches Nein');
  ok(/PRODUCT_NOT_FOUND/.test(wirft(() => aiConfirm.confirmAiIdentificationInHouse('gibt-es-nicht'))), 'PRIMARY unbekannter Artikel: ehrliches Nein');
  ok(String(db.exec('SELECT ai_confirmed_at FROM products WHERE id = ?', ['ai-0'])[0]?.values?.[0]?.[0] ?? '') === '', 'PRIMARY und nichts wurde geschrieben');
}
marker('CENTRAL_UI_R6B_PRIMARY_CONTRACTS_AUDITED');

// ══ §3 — Inventur und Stock-Check ohne eigene Datenbank ════════════════════════
{
  alsClient();
  ok(!stock.stockCheckAvailableHere(), 'INVENTUR auf dem Client ist der Stock-Check hier nicht verfügbar');
  const e1 = await wirftAsync(() => stock.recordStockCheck({ productId: 'p1', status: 'available', notes: null, requestId: 'r1' }));
  const e2 = await wirftAsync(() => stock.latestStockChecks(['p1']));
  const e3 = await wirftAsync(() => stock.listStockChecks('p1'));
  ok([e1, e2, e3].every((e) => e.startsWith(stock.STOCK_CHECK_PRIMARY_ONLY)),
    `INVENTUR schreiben, lesen, Verlauf — keiner fragt den Kern dieses Rechners (${[e1, e2, e3].map((e) => e.split(' ')[0]).join(',')})`);
  alsPrimary();
  ok(stock.stockCheckAvailableHere(), 'INVENTUR am Primary unverändert verfügbar');
  const m = codeOf(src('src/components/products/StockCheckInventoryModal.tsx'));
  const oeffnen = m.slice(m.indexOf('if (!open) return;'), m.indexOf('if (!open) return;') + 200);
  ok(/if \(!stockCheckAvailableHere\(\)\) return;/.test(oeffnen), 'INVENTUR das Öffnen beginnt auf dem Client KEINEN Lauf (vor jedem getDatabase)');
  const save = koerper(m, /const save = async \(\) => \{/);
  const finish = koerper(m, /const finishInventory = async \(\) => \{/);
  ok(save.indexOf('stockCheckAvailableHere()') > 0 && save.indexOf('stockCheckAvailableHere()') < save.indexOf('getDatabase()'),
    'INVENTUR Speichern: der Riegel steht vor jedem Datenbankgriff');
  ok(finish.indexOf('stockCheckAvailableHere()') > 0 && finish.indexOf('stockCheckAvailableHere()') < finish.indexOf('closeSession('),
    'INVENTUR Abschließen: kein „finished" ohne Wirkung');
  ok(/let sheetStored = true;/.test(save) && /sheetStored = false;/.test(save) && /if \(!sheetStored\) return;/.test(save),
    'INVENTUR am Primary: ein nicht gespeichertes Arbeitsblatt schließt die Maske nicht mehr weg (kein halber Erfolg)');
  ok(/data-primary-only="inventory"/.test(m), 'INVENTUR die Maske sagt es sichtbar');
  const p = codeOf(src('src/components/products/StockCheckPanel.tsx'));
  ok(/if \(!stockCheckAvailableHere\(\)\) \{\s*return \(\s*<div[^>]*data-primary-only="stock-check"/.test(p)
    && /const reload = useCallback\(async \(\) => \{\s*if \(!stockCheckAvailableHere\(\)\) \{ setLoaded\(true\); return; \}/.test(p),
  'INVENTUR der Einzel-Check zeigt auf dem Client einen Satz statt zweier Knöpfe und liest nichts');
  const w = codeOf(src('src/pages/watches/WatchList.tsx'));
  ok(/data-testid="open-inventory"\s*disabled=\{filtered\.length === 0 \|\| !stockCheckAvailableHere\(\)\}/.test(w), 'INVENTUR der Knopf in der Collection ist auf dem Client gesperrt und erklärt');
}
marker('CENTRAL_UI_R6B_INVENTORY_CLIENT_FAIL_CLOSED_PROVED');

// ══ §4 — Import ═══════════════════════════════════════════════════════════════
{
  const app = codeOf(src('src/App.tsx'));
  ok(/path="\/import" element=\{clientMode \? \(\s*<PrimaryOnlyNotice title="Import"/.test(app), 'IMPORT die Route zeigt auf dem Client die Primary-Notiz');
  const ip = codeOf(src('src/pages/settings/ImportPage.tsx'));
  const h = koerper(ip, /async function handleImport\(\)/);
  ok(h.indexOf('primaryOnlyLocked()') > 0 && h.indexOf('primaryOnlyLocked()') < h.indexOf('runProductImport('), 'IMPORT der Riegel steht vor Sicherung und Anlegen');
  const w = codeOf(src('src/pages/watches/WatchList.tsx'));
  ok(/disabled=\{primaryOnlyLocked\(\)\}[\s\S]{0,400}navigate\('\/import'\)/.test(w) && /data-primary-only=\{primaryOnlyLocked\(\) \? 'import' : undefined\}/.test(w),
    'IMPORT „Import Excel" ist auf dem Client gesperrt und erklärt');
}
marker('CENTRAL_UI_R6B_IMPORT_CLIENT_FAIL_CLOSED_PROVED');

// ══ §5 — Abmelden ═════════════════════════════════════════════════════════════
{
  // Auf dem Client: jede Berührung der Datenbank wäre ein Fehler — der Test macht sie laut.
  setTestDatabase(new Proxy({}, { get() { throw new Error('DB touched'); } }) as never);
  alsClient();
  store.set('lataif_client_token', 'tok'); store.set('lataif_client_server_url', 'http://127.0.0.1:3011');
  store.set('lataif_session', JSON.stringify({ token: 's1', branchId: 'branch-main', userId: 'u1' }));
  const a = new AuthService();
  ok(a.getSession() !== null, 'LOGOUT vorher: Sitzung aus dem Ausweis');
  const e = wirft(() => a.logout());
  ok(e === '' && a.getSession() === null && !store.has('lataif_session') && !store.has('lataif_client_token') && store.get('lataif_client_server_url') === 'http://127.0.0.1:3011',
    `LOGOUT auf dem Client: ohne Datenbank, Sitzung und Ausweis weg, die Serveradresse bleibt (${e || 'kein Fehler'})`);
  alsPrimary();
  const ac = codeOf(src('src/core/auth/auth.ts'));
  const lo = koerper(ac, /logout\(\): void \{/);
  ok(lo.indexOf('isClientMode()') < lo.indexOf('getDatabase()') && /DELETE FROM sessions WHERE token = \?/.test(lo),
    'LOGOUT am Primary unverändert: die Sitzung wird in der Datenbank beendet');
}
marker('CENTRAL_UI_R6B_CLIENT_LOGOUT_PROVED');

// ══ §6 — kein Schein-Erfolg ═══════════════════════════════════════════════════
{
  const m = codeOf(src('src/components/ai/MessagePreviewModal.tsx'));
  const log = koerper(m, /function log\(channel/);
  ok(log.indexOf('readsFromPrimary()') > 0 && log.indexOf('readsFromPrimary()') < log.indexOf('logMessage('),
    'FAKE auf dem Client wird das Protokoll nicht versucht, sondern gesagt');
  ok(/const eintrag = logMessage\(/.test(log) && /setLogNote\(eintrag \? '' : /.test(log) && /data-message-log-note/.test(m),
    'FAKE am Primary: ein gescheiterter Eintrag wird nicht verschwiegen');
}
marker('CENTRAL_UI_R6B_NO_FALSE_SUCCESS_PROVED');

// ══ §7 — die 28 Löschknöpfe ═══════════════════════════════════════════════════
{
  alsPrimary();
  alerts = 0;
  ok(S(primaryOnly.primaryOnlyDeleteProps()) === S({ disabled: false }) && primaryOnly.blockDeleteOnClient() === false && alerts === 0,
    'DELETE am Primary: dieselben Knöpfe, dieselbe Wirkung');
  alsClient();
  const p = primaryOnly.primaryOnlyDeleteProps();
  ok(p.disabled === true && p.title === primaryOnly.PRIMARY_ONLY_DELETE && p['data-primary-only'] === 'delete', 'DELETE auf dem Client: gesperrt, erklärt, markiert');
  ok(primaryOnly.blockDeleteOnClient() === true && alerts === 1, 'DELETE auf dem Client: der Riegel im Handler hält und sagt es');
  alsPrimary();
  // Datei → [Einstiege laut R6A, gesperrte Knöpfe, Riegel im Handler]
  const LISTE: Record<string, [number, number, number]> = {
    'pages/invoices/InvoiceDetail.tsx': [1, 1, 1], 'pages/credit-notes/CreditNoteDetail.tsx': [1, 1, 1],
    'pages/offers/OfferDetail.tsx': [1, 1, 1], 'pages/offers/OfferList.tsx': [1, 1, 1],
    'pages/customers/CustomerDetail.tsx': [1, 1, 1], 'pages/watches/WatchList.tsx': [1, 2, 1],
    'pages/watches/ProductDetail.tsx': [1, 1, 1], 'pages/suppliers/SupplierDetail.tsx': [1, 1, 1],
    'pages/orders/OrderDetail.tsx': [2, 2, 2], 'pages/repairs/RepairDetail.tsx': [1, 1, 1],
    'pages/production/ProductionPage.tsx': [1, 1, 1], 'pages/production/ProductionDetail.tsx': [1, 1, 1],
    'pages/consignments/ConsignmentDetail.tsx': [1, 1, 1], 'pages/agents/AgentList.tsx': [1, 1, 1],
    'components/agents/TransferTable.tsx': [1, 1, 1], 'pages/agents/TransferDetail.tsx': [1, 1, 1],
    'pages/metals/MetalList.tsx': [1, 1, 1], 'pages/scrap-trades/ScrapTradeDetail.tsx': [1, 1, 1],
    'pages/expenses/ExpenseList.tsx': [3, 3, 3], 'pages/partners/PartnersPage.tsx': [2, 2, 2],
    'pages/debts/DebtsPage.tsx': [1, 1, 1], 'pages/employees/EmployeeList.tsx': [1, 1, 1],
    'pages/tasks/TaskList.tsx': [1, 1, 1], 'pages/documents/DocumentList.tsx': [1, 2, 1],
  };
  let einstiege = 0;
  for (const [f, [e, props, riegel]] of Object.entries(LISTE)) {
    const c = codeOf(src('src/' + f));
    einstiege += e;
    const np = (c.match(/primaryOnlyDeleteProps\(\)/g) ?? []).length;
    const nr = (c.match(/blockDeleteOnClient\(\)/g) ?? []).length;
    ok(np === props && nr === riegel, `DELETE ${f}: ${props} gesperrte Knöpfe, ${riegel} Riegel (${np}/${nr})`);
  }
  ok(einstiege === 28, `DELETE genau die 28 Löschknöpfe aus R6A (${einstiege})`);
  const doc = src('docs/central-ui-parity.md');
  const r6a = doc.slice(doc.indexOf('### Write-Gap-SSOT'), doc.indexOf('### Keine toten Knöpfe'));
  const e28 = r6a.split('\n').filter((l) => /^\| /.test(l)).map((l) => l.split('|').map((x) => x.trim())).filter((p) => p[5] === 'E' && /Löschen/.test(p[8] ?? ''));
  ok(e28.length === 28, `DELETE die R6A-SSOT zählt dieselben 28 (${e28.length})`);
}
marker('CENTRAL_UI_R6B_UNSUPPORTED_DELETES_FAIL_CLOSED');

// ══ §8 — Registry und Matrix ══════════════════════════════════════════════════
{
  ok(ALLOWED_MUTATIONS.length === 41 && ALLOWED_MUTATIONS.at(-1) === 'invoices.cancel', `REGISTRY 41 Buchungen, die letzte bleibt invoices.cancel (${ALLOWED_MUTATIONS.length})`);
  const rs = src('src-tauri/src/bridge.rs');
  const block = rs.slice(rs.indexOf('pub const REMOTE_OPS'), rs.indexOf('];', rs.indexOf('pub const REMOTE_OPS')));
  const n = (block.match(/^\s+OP_[A-Z0-9_]+,/gm) ?? []).length;
  ok(n === 108, `REGISTRY Rust REMOTE_OPS = 108 (${n})`);
  const exakt = R4C_MATRIX.filter((z) => z.paritaet === 'exakt' && z.verdrahtet).length;
  const keineUi = R4C_MATRIX.filter((z) => z.paritaet === 'keine-ui').length;
  const enger = R4C_MATRIX.filter((z) => z.paritaet === 'enger').length;
  ok(R4C_MATRIX.length === 40 && exakt === 36 && enger === 0 && keineUi === 4 && R5F1_NEUE_BUCHUNGEN.length === 1,
    `MATRIX die ursprünglichen vierzig bleiben 36/0/0/4, invoices.cancel getrennt (${exakt}/${enger}/${keineUi})`);
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central ui parity r6b: safety + existing commands: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
