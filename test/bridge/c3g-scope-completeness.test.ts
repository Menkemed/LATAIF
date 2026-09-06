// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-C3G FINAL — die Einordnung, Aktion für Aktion. Und was danach offen bleibt.
// Run: node test/bridge/c3g-scope-completeness.test.ts
//
// Der Anlass: der C3G-Bericht sprach von „fünfundzwanzig auditierten Aktionen", zählte aber die
// ZEILEN einer Matrix, in der mehrere Zeilen mehrere Aktionen bündelten („Cancel sale / Return
// after sale / Delete"). Eine Zahl, die aus Sammelbegriffen entsteht, ist keine Zahl.
//
// Hier steht deshalb jede Aktion EINZELN, mit ihrer echten Domänenfunktion — und die Zahl wird
// aus der Liste gerechnet, nicht behauptet. Dass die Funktionen wirklich existieren, wird am
// Quelltext geprüft: eine Einordnung, die eine erfundene Funktion einordnet, ordnet nichts ein.
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    if (specifier === '@/core/db/database') {
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
(globalThis as { localStorage?: unknown }).localStorage = storage;
(globalThis as { window?: unknown }).window = { localStorage: storage };

const initSqlJs = (await import('sql.js')).default;
const SQL = await initSqlJs({ locateFile: (f: string) => resolvePath(repo, 'node_modules/sql.js/dist', f) });

const { setTestDatabase } = await import('../sync/_db-shim.ts');
const { COMMAND_LEDGER_DDL, COMMAND_LEDGER_INDEX } = await import('../../src/core/bridge/command-ledger.ts');
const { resetDurabilityStateForTest } = await import('../../src/core/bridge/durability-state.ts');
const { installWriteGuard } = await import('../../src/core/db/write-guard.ts');
const { SKU_SEQUENCES_DDL } = await import('../../src/core/products/sku-sequence.ts');
const fin = await import('../../src/core/bridge/financial-commands.ts');
const { runInvoiceCreate } = await import('../../src/core/bridge/invoice-command.ts');
const { ALLOWED_MUTATIONS, knownCommands } = await import('../../src/core/bridge/command-registry.ts');
await import('../../src/core/bridge/read-commands.ts');
await import('../../src/core/bridge/customer-commands.ts');
await import('../../src/core/bridge/product-commands.ts');
await import('../../src/core/bridge/invoice-lifecycle-commands.ts');
await import('../../src/core/bridge/return-commands.ts');
await import('../../src/core/bridge/lifecycle-commands.ts');
await import('../../src/core/bridge/commercial-commands.ts');
await import('../../src/core/bridge/service-commands.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const { useInvoiceStore } = await import('../../src/stores/invoiceStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const NOW = '2026-09-12T10:00:00.000Z';

// ── Die Liste. Jede Aktion EINMAL, mit ihrer echten Funktion ──────────────
type Klass = 'A_REMOTE' | 'B_REMOTE' | 'B_DEFERRED' | 'C_PRIMARY_ONLY';
interface Action {
  module: string;
  /** Was ein Mensch am Primary anklickt. */
  ui: string;
  /** Die Datei, in der die Domänenfunktion steht. */
  file: string;
  /** Der Name, unter dem sie dort steht — am Quelltext geprüft. */
  fn: string;
  klass: Klass;
  /** Bei A/B_REMOTE: der freigegebene Name. Sonst der Grund. */
  status: string;
}

const INV = 'src/stores/invoiceStore.ts';
const RET = 'src/stores/salesReturnStore.ts';
const ORD = 'src/stores/orderStore.ts';
const OPY = 'src/stores/orderPaymentStore.ts';
const CON = 'src/stores/consignmentStore.ts';
const REP = 'src/stores/repairStore.ts';
const AGT = 'src/stores/agentStore.ts';
const OTX = 'src/core/orders/order-invoice-tx.ts';

const ACTIONS: Action[] = [
  // ── Rechnung ────────────────────────────────────────────────────────────
  { module: 'invoice', ui: 'Apply store credit', file: INV, fn: 'applyCreditToInvoice', klass: 'A_REMOTE', status: 'invoices.apply_credit' },
  { module: 'invoice', ui: 'Correct a payment', file: INV, fn: 'updatePayment', klass: 'B_REMOTE', status: 'invoices.update_payment' },
  { module: 'invoice', ui: 'Remove a payment', file: INV, fn: 'deletePayment', klass: 'B_REMOTE', status: 'invoices.delete_payment' },
  { module: 'invoice', ui: 'Special mark', file: INV, fn: 'setSpecialMark', klass: 'C_PRIMARY_ONLY', status: 'waehlt bei Vollzahlung den Nummernkreis — steuerlicher Marker, kein Kassenvorgang' },
  { module: 'invoice', ui: 'Delete invoice', file: INV, fn: 'deleteInvoice', klass: 'C_PRIMARY_ONLY', status: 'zerstoerend: Beleg, Zeilen, Zahlungen, Lose, Buchungen' },
  { module: 'return', ui: 'Start a return', file: RET, fn: 'createReturn', klass: 'B_DEFERRED', status: 'C3H — Kette mit eigener Steuerurkunde' },
  { module: 'return', ui: 'Approve a return', file: RET, fn: 'approveReturn', klass: 'B_DEFERRED', status: 'C3H — erzeugt die Gutschrift' },
  { module: 'return', ui: 'Refund a return', file: RET, fn: 'refundReturn', klass: 'B_DEFERRED', status: 'C3H — Geld zurueck' },
  { module: 'return', ui: 'Record a refund payment', file: RET, fn: 'recordRefundPayment', klass: 'B_DEFERRED', status: 'C3H — Cash-Out mit Kartengebuehr' },
  { module: 'return', ui: 'Cancel a return', file: RET, fn: 'cancelReturn', klass: 'C_PRIMARY_ONLY', status: 'Storno einer Gutschrift — Recovery' },
  // ── Auftrag ─────────────────────────────────────────────────────────────
  { module: 'order', ui: 'Create final invoice', file: OTX, fn: 'convertOrderLinesToInvoiceTx', klass: 'B_REMOTE', status: 'orders.convert_to_invoice' },
  { module: 'order', ui: 'Advance order status', file: ORD, fn: 'updateStatus', klass: 'B_DEFERRED', status: 'C3H — bucht Lieferanten-Verbindlichkeiten; GATE fuer die Umwandlung' },
  { module: 'order', ui: 'Add an order payment', file: OPY, fn: 'addPayment', klass: 'B_DEFERRED', status: 'C3H — eigener Geldweg mit Ueberzahlungs-Guthaben' },
  { module: 'order', ui: 'Delete an order payment', file: OPY, fn: 'deletePayment', klass: 'B_DEFERRED', status: 'C3H — Storno des Geldwegs' },
  { module: 'order', ui: 'Cancel with money', file: ORD, fn: 'cancelOrderWithMoney', klass: 'C_PRIMARY_ONLY', status: 'Storno mit Rueckzahlung — Recovery' },
  { module: 'order', ui: 'Delete order', file: ORD, fn: 'deleteOrder', klass: 'C_PRIMARY_ONLY', status: 'zerstoerend' },
  // ── Kommission ──────────────────────────────────────────────────────────
  { module: 'consignment', ui: 'Record a partial payout', file: CON, fn: 'recordPartialPayout', klass: 'B_REMOTE', status: 'consignments.record_payout' },
  { module: 'consignment', ui: 'Mark paid out', file: CON, fn: 'markPaidOut', klass: 'B_REMOTE', status: 'consignments.record_payout (mit dem vollen Restbetrag)' },
  { module: 'consignment', ui: 'Record the sale', file: CON, fn: 'recordSale', klass: 'B_DEFERRED', status: 'C3H — erzeugt Rechnung UND Einkauf' },
  { module: 'consignment', ui: 'Item returned unsold', file: CON, fn: 'markReturned', klass: 'B_DEFERRED', status: 'C3H — Lebenszyklus ohne Geld, aber mit Artikelzustand' },
  { module: 'consignment', ui: 'Cancel the sale', file: CON, fn: 'cancelSale', klass: 'C_PRIMARY_ONLY', status: 'Storno von Rechnung und Einkauf — Recovery' },
  { module: 'consignment', ui: 'Returned after sale', file: CON, fn: 'markReturnedAfterSale', klass: 'C_PRIMARY_ONLY', status: 'Rueckabwicklung nach Verkauf — Recovery' },
  { module: 'consignment', ui: 'Delete consignment', file: CON, fn: 'deleteConsignment', klass: 'C_PRIMARY_ONLY', status: 'zerstoerend' },
  // ── Reparatur ───────────────────────────────────────────────────────────
  { module: 'repair', ui: 'Advance repair status', file: REP, fn: 'updateStatus', klass: 'B_DEFERRED', status: 'C3H — sechs Zweige, je eigene Buchung' },
  { module: 'repair', ui: 'Create the repair invoice', file: REP, fn: 'createCombinedRepairInvoice', klass: 'B_DEFERRED', status: 'C3H — zweiter Rechnungsweg' },
  { module: 'repair', ui: 'Add a work line', file: REP, fn: 'addRepairLine', klass: 'B_DEFERRED', status: 'C3H — Lieferanten-Verbindlichkeit' },
  { module: 'repair', ui: 'Edit a work line', file: REP, fn: 'updateRepairLine', klass: 'B_DEFERRED', status: 'C3H — dito' },
  { module: 'repair', ui: 'Cancel a work line', file: REP, fn: 'cancelRepairLine', klass: 'B_DEFERRED', status: 'C3H — loescht Zeile samt Verbindlichkeit' },
  { module: 'repair', ui: 'Delete repair', file: REP, fn: 'deleteRepair', klass: 'C_PRIMARY_ONLY', status: 'zerstoerend' },
  // ── Agenten-Transfer ────────────────────────────────────────────────────
  { module: 'transfer', ui: 'Mark sold', file: AGT, fn: 'markTransferSold', klass: 'B_REMOTE', status: 'transfers.mark_sold' },
  { module: 'transfer', ui: 'Settle', file: AGT, fn: 'markTransferSettled', klass: 'B_REMOTE', status: 'transfers.mark_settled' },
  { module: 'transfer', ui: 'Convert to invoice', file: AGT, fn: 'convertTransferToInvoice', klass: 'B_DEFERRED', status: 'C3H — dritter Rechnungsweg, an die Abrechnung gekoppelt' },
  { module: 'transfer', ui: 'Convert several to one invoice', file: AGT, fn: 'convertTransfersToInvoice', klass: 'B_DEFERRED', status: 'C3H — dito, gebuendelt' },
  { module: 'transfer', ui: 'Undo the conversion', file: AGT, fn: 'undoTransferInvoiceConvert', klass: 'C_PRIMARY_ONLY', status: 'Ruecknahme einer gebuchten Rechnung — Recovery' },
  { module: 'transfer', ui: 'Delete transfer', file: AGT, fn: 'deleteTransfer', klass: 'C_PRIMARY_ONLY', status: 'zerstoerend' },
];

// ── 1) Jede Aktion existiert wirklich, und genau einmal ──────────────────
{
  const keys = ACTIONS.map((a) => `${a.module}:${a.fn}`);
  ok(new Set(keys).size === keys.length,
    `LIST jede Aktion steht genau einmal darin (${keys.length} Zeilen, ${new Set(keys).size} verschieden)`);
  for (const a of ACTIONS) {
    const text = src(a.file);
    const found = new RegExp(`(^|\\n)\\s*(export function )?${a.fn}\\s*[:(]`).test(text);
    ok(found, `LIST ${a.module}.${a.fn} existiert wirklich in ${a.file}`);
  }
  const valid: Klass[] = ['A_REMOTE', 'B_REMOTE', 'B_DEFERRED', 'C_PRIMARY_ONLY'];
  ok(ACTIONS.every((a) => valid.includes(a.klass)), 'LIST jede Zeile traegt eine der vier Klassen');
  ok(ACTIONS.every((a) => a.status.trim().length > 0), 'LIST …und eine Begruendung oder einen Namen');
}

// ── 2) Die Zahlen kommen aus der Liste, nicht aus dem alten Bericht ──────
{
  const count = (k: Klass): number => ACTIONS.filter((a) => a.klass === k).length;
  const a = count('A_REMOTE'), b = count('B_REMOTE'), d = count('B_DEFERRED'), c = count('C_PRIMARY_ONLY');
  const total = ACTIONS.length;
  console.log(`  COUNTS A_REMOTE=${a} B_REMOTE=${b} B_DEFERRED=${d} C_PRIMARY_ONLY=${c} TOTAL=${total}`);
  ok(a + b + d + c === total, `COUNTS die vier Klassen decken die ganze Liste (${a}+${b}+${d}+${c}=${total})`);
  ok(total === 35, `COUNTS die genaue Aufloesung ergibt 35 Aktionen, nicht 25 (${total})`);
  ok(a === 1 && b === 7, `COUNTS 1 A_REMOTE und 7 B_REMOTE (${a}/${b})`);
  ok(d === 16, `COUNTS 16 B_DEFERRED (${d})`);
  ok(c === 11, `COUNTS 11 C_PRIMARY_ONLY (${c})`);

  // ACHT freigegebene UI-Aktionen, aber nur SIEBEN Operationsnamen: „Teilauszahlung" und „voll
  // auszahlen" sind derselbe Vertrag mit anderem Betrag. Die Zahl kommt aus der Liste.
  const remoteOps = new Set(ACTIONS.filter((x) => x.klass === 'A_REMOTE' || x.klass === 'B_REMOTE').map((x) => x.status.split(' ')[0]));
  ok(remoteOps.size === 7 && a + b === 8,
    `COUNTS acht freigegebene UI-Aktionen fahren sieben Operationsnamen — „Teilauszahlung" und
     „voll auszahlen" sind derselbe Vertrag mit anderem Betrag (${[...remoteOps].join(', ')})`);
  const c3g = ['invoices.apply_credit', 'invoices.update_payment', 'invoices.delete_payment',
    'orders.convert_to_invoice', 'consignments.record_payout', 'transfers.mark_sold', 'transfers.mark_settled'];
  ok(c3g.every((op) => (ALLOWED_MUTATIONS as readonly string[]).includes(op)),
    'COUNTS und alle sieben C3G-Namen stehen auf der Zulassungsliste');
  ok([...remoteOps].every((op) => c3g.includes(op)),
    'COUNTS …die Liste nennt keinen Namen, den es nicht gibt');
  // `transfers.mark_settled` erscheint in der Liste, weil es dieselben sieben sind.
  ok(c3g.length === 7 && new Set(c3g).size === 7, 'COUNTS genau sieben, ohne Dopplung');
}

// ── 3) Keine Klasse-C-Aktion ist registriert ─────────────────────────────
{
  const list = ALLOWED_MUTATIONS as readonly string[];
  ok(list.length === 40, `REGISTRY genau 40 Mutationen (${list.length}) — 24 aus C3G plus die 16 aus C3H`);
  const known = knownCommands();
  // CENTRAL-C3H hat die sechzehn `B_DEFERRED`-Aktionen freigeschaltet. Diese Datei bleibt der
  // Nachweis der KLASSIFIKATION — die Zahlen ziehen mit, die Einordnung nicht.
  ok(known.length === 59 && known.filter((o) => o.endsWith('.list') || o.endsWith('.get')).length === 18,
    `REGISTRY 1 Probe + 18 Reads + 40 Mutationen = 59 (${known.length})`);
  for (const a of ACTIONS.filter((x) => x.klass === 'C_PRIMARY_ONLY')) {
    // Kein Name dieser Aktion — in irgendeiner plausiblen Schreibweise — steht auf der Liste.
    const guesses = [
      `${a.module}s.${a.fn.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()}`,
      `${a.module}s.delete`, `${a.module}s.cancel`,
    ];
    ok(guesses.every((g) => !list.includes(g)),
      `REGISTRY ${a.module}.${a.fn} ist nicht registriert`);
  }
  // Die sechzehn Vertagten sind in C3H freigeschaltet worden — jede genau EINMAL und unter
  // genau EINEM Namen. Geprueft wird deshalb, dass fuer jede von ihnen ein Name auf der Liste
  // steht, und dass die Zahl der dabei benutzten Namen die erwartete ist.
  const C3H_NAME_OF: Record<string, string> = {
    'return.createReturn': 'returns.create',
    'return.approveReturn': 'returns.approve',
    'return.refundReturn': 'returns.refund',
    'return.recordRefundPayment': 'returns.record_refund_payment',
    'order.updateStatus': 'orders.update_status',
    'order.addPayment': 'orders.add_payment',
    'order.deletePayment': 'orders.delete_payment',
    'consignment.recordSale': 'consignments.record_sale',
    'consignment.markReturned': 'consignments.mark_returned',
    'repair.updateStatus': 'repairs.update_status',
    'repair.createCombinedRepairInvoice': 'repairs.create_invoice',
    'repair.addRepairLine': 'repairs.add_line',
    'repair.updateRepairLine': 'repairs.update_line',
    'repair.cancelRepairLine': 'repairs.cancel_line',
    'transfer.convertTransferToInvoice': 'transfers.convert_to_invoice',
    'transfer.convertTransfersToInvoice': 'transfers.convert_many_to_invoice',
  };
  const deferredKeys = ACTIONS.filter((x) => x.klass === 'B_DEFERRED').map((a) => `${a.module}.${a.fn}`);
  ok(deferredKeys.length === Object.keys(C3H_NAME_OF).length,
    `C3H die Abbildung deckt genau die sechzehn Vertagten (${deferredKeys.length}/${Object.keys(C3H_NAME_OF).length})`);
  for (const key of deferredKeys) {
    const name = C3H_NAME_OF[key];
    ok(!!name, `C3H ${key} hat einen Operationsnamen`);
    ok(!!name && list.includes(name), `C3H ${key} → ${name} steht auf der Liste`);
  }
  ok(new Set(Object.values(C3H_NAME_OF)).size === 16,
    'C3H sechzehn Aktionen, sechzehn Namen — keiner geteilt');
  ok((fin.C3G_PRIMARY_ONLY as readonly string[]).length === 10,
    'REGISTRY die Klasse-C-Liste steht als Konstante im Code');
}

// ── 4) Hängt ein freigegebener Weg an einer Klasse-C-Aktion? ─────────────
//
// Die Frage ist nicht rhetorisch: wenn ein Kassenvorgang eine Adminaktion braucht, ist er am
// zweiten Rechner nicht zu Ende zu bringen — und das wäre ein Loch, kein Feature.
{
  const invSrc = src(INV);
  // (a) Eine Vollzahlung braucht KEINE Sondermarke: `specialMarkOnFinal` ist ein optionaler
  //     Parameter, und der Fernweg lässt ihn weg.
  const lifecycle = src('src/core/bridge/invoice-lifecycle-commands.ts');
  ok(/recordPayment\(\s*\n?\s*req\.invoiceId, req\.amount, req\.method, req\.notes, undefined, req\.cardBrand,/.test(lifecycle.replace(/\r/g, '')),
    'DEP die Fernzahlung uebergibt KEINE Sondermarke — sie ist optional');
  ok(/specialMarkOnFinal\?: boolean|specialMarkOnFinal,/.test(invSrc),
    'DEP …und die Domaene behandelt sie als optional');
  ok(!/setSpecialMark\(/.test(src('src/core/bridge/financial-commands.ts')),
    'DEP kein freigegebener Geldweg ruft setSpecialMark');
  // (b) Auftrag→Rechnung, Auszahlung und Verkauf/Abrechnung rufen keine C-Aktion.
  const finSrc = src('src/core/bridge/financial-commands.ts');
  for (const fn of ['deleteInvoice', 'cancelOrderWithMoney', 'deleteOrder', 'cancelSale',
    'markReturnedAfterSale', 'deleteConsignment', 'deleteRepair', 'undoTransferInvoiceConvert',
    'deleteTransfer', 'cancelReturn']) {
    ok(!new RegExp(`\\b${fn}\\(`).test(finSrc), `DEP kein freigegebener Weg ruft ${fn}`);
  }
}

// ── 5) Und der Beweis am laufenden System: eine Vollzahlung geht ohne C ──
{
  const db = (() => {
    const d = new SQL.Database() as unknown as {
      run(sql: string, p?: unknown[]): unknown;
      exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
    };
    d.run(src('src/core/db/schema.sql'));
    const dbSrc = src('src/core/db/database.ts');
    const start = dbSrc.indexOf('const migrations: string[] = [');
    const end = dbSrc.indexOf('\n  ];', start);
    for (const m of [...dbSrc.slice(start, end).matchAll(/`([^`]*)`/g)]) { try { d.run(m[1]); } catch { /* */ } }
    for (const stmt of A1_UPGRADE_SQL) { try { d.run(stmt); } catch { /* */ } }
    d.run(COMMAND_LEDGER_DDL); d.run(COMMAND_LEDGER_INDEX); d.run(SKU_SEQUENCES_DDL);
    d.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-main','tenant-1','H',?,?)", [NOW, NOW]);
    d.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES ('cat-w','branch-main','W','w','#000',?,?)", [NOW, NOW]);
    d.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level,
        preferences, customer_type, sales_stage, created_at, updated_at)
      VALUES ('cust-1','branch-main','Ali','H','BH','en',0,'[]','collector','active',?,?)`, [NOW, NOW]);
    d.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
        scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
        tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
      VALUES ('p1','branch-main','cat-w','Rolex','M','SKU-1',3,'Pre-Owned','[]',100,'BHD',150,'in_stock','VAT_10',0,'[]','{}','OWN',?,?)`, [NOW, NOW]);
    d.run(`INSERT INTO stock_lots (id, branch_id, product_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
      VALUES ('lot-p1','branch-main','p1',100,3,3,'ACTIVE',?,?)`, [NOW, NOW]);
    setTestDatabase(d as never);
    installWriteGuard(d as never);
    useProductStore.getState().loadProducts();
    useInvoiceStore.getState().loadInvoices();
    return d;
  })();
  const n = (sql: string, p: unknown[] = []): number => Number(db.exec(sql, p)[0]?.values?.[0]?.[0] ?? 0);
  const s = (sql: string, p: unknown[] = []): string => String(db.exec(sql, p)[0]?.values?.[0]?.[0] ?? '');

  resetDurabilityStateForTest();
  const deps = {
    db: db as never,
    begin: posting.beginLedgerTransaction,
    commit: posting.commitLedgerTransaction,
    rollback: posting.rollbackLedgerTransaction,
    durableSave: async () => {},
    now: () => NOW,
  };
  const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-000000000000`;
  const identity = (x: string, op: string) => ({
    commandId: ID(x), tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test',
    op, payloadHash: 'h' + x,
  });
  const created = await runInvoiceCreate(deps, identity('1', 'invoices.create'), {
    customerId: 'cust-1', lines: [{ productId: 'p1', quantity: 1, unitPrice: 150 }],
  });
  const inv = (created as { value: { invoiceId: string } }).value.invoiceId;
  const gross = n('SELECT gross_amount FROM invoices WHERE id = ?', [inv]);
  ok(s('SELECT special_mark FROM invoices WHERE id = ?', [inv]) !== '1',
    'DEP-LIVE die Rechnung traegt KEINE Sondermarke');

  // Der ganze Kassenvorgang am zweiten Rechner: Guthaben anrechnen, Rest bezahlen.
  db.run(`INSERT INTO customer_credits (id, branch_id, customer_id, source_type, source_id, amount, used_amount, status, created_at)
    VALUES ('cr-1','branch-main','cust-1','manual','x',50,0,'OPEN',?)`, [NOW]);
  useInvoiceStore.getState().loadInvoices();
  const rev = n('SELECT revision FROM invoices WHERE id = ?', [inv]);
  const applied = await fin.runApplyCredit(deps, identity('2', 'invoices.apply_credit'),
    { invoiceId: inv, amount: 50, expectedRevision: rev });
  ok(applied.kind === 'ok', 'DEP-LIVE das Guthaben wird angerechnet');
  useInvoiceStore.getState().loadInvoices();
  const payId = useInvoiceStore.getState().recordPayment(inv, gross - 50, 'cash');
  ok(payId !== '', 'DEP-LIVE der Rest wird bezahlt');
  const after = db.exec('SELECT status, invoice_number, paid_amount FROM invoices WHERE id = ?', [inv])[0].values[0];
  ok(Math.abs(Number(after[2]) - gross) < 0.005, `DEP-LIVE die Rechnung ist voll bezahlt (${after[2]}/${gross})`);
  ok(String(after[0]) !== 'DRAFT', `DEP-LIVE …und abgeschlossen (${after[0]})`);
  ok(String(after[1]).length > 0, `DEP-LIVE mit einer Nummer aus dem regulaeren Kreis (${after[1]})`);
  ok(s('SELECT special_mark FROM invoices WHERE id = ?', [inv]) !== '1',
    'DEP-LIVE …ohne dass je eine Sondermarke gesetzt wurde — der Kassenvorgang haengt nicht an Klasse C');
}

// ── 6) Das offene Loch wird BENANNT, nicht kaschiert ─────────────────────
{
  const deferred = ACTIONS.filter((a) => a.klass === 'B_DEFERRED');
  ok(deferred.every((a) => a.status.startsWith('C3H')),
    'C3H jede vertagte Aktion nennt ihren Folge-Schnitt');
  // …und dieser Folge-Schnitt ist gebaut: jede von ihnen faehrt jetzt durch die Bruecke.
  const c3hSrc = src('src/core/bridge/lifecycle-commands.ts') + src('src/core/bridge/return-commands.ts');
  ok((c3hSrc.match(/registerCommand\(/g) ?? []).length === 16,
    'C3H sechzehn Anmeldungen — genau so viele wie vertagte Aktionen');
  // Die Lücke, die der Auftragsweg wirklich hat: PC2 kann einen Auftrag anlegen und wandeln,
  // aber nicht auf „angekommen" setzen — und ohne das ist nichts abrechenbar.
  const gate = deferred.find((a) => a.module === 'order' && a.fn === 'updateStatus');
  ok(!!gate && /GATE fuer die Umwandlung/.test(gate.status),
    'C3H die Abhaengigkeit der Umwandlung vom Auftragsstatus steht ausdruecklich in der Liste');
  const modules = new Set(deferred.map((a) => a.module));
  ok(modules.has('return') && modules.has('order') && modules.has('consignment')
    && modules.has('repair') && modules.has('transfer'),
  `C3H der Folge-Scope beruehrt alle fuenf Module (${[...modules].join(', ')})`);
  console.log('  C3H_REQUIRED_REMAINING_BUSINESS_ACTIONS:');
  for (const a of deferred) console.log(`    - ${a.module}.${a.fn} — ${a.ui} — ${a.status}`);
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central c3g scope completeness: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
