// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6D FINAL GATE — Registry-Diff, Idempotenz, Hauptbuch-Autorität, Buchhaltungs-Einordnung,
// SSOT-Arithmetik. Run: node test/r6d/final-gate.test.ts
//
//   §1 Registry 121 → 152: genau 28 Buchungen + 3 Auskünfte gegen den Stand VOR R6D (`f750517`), TS == Rust,
//      Rechte wie am Primary, Unbekanntes fail-closed
//   §2 Idempotenz: jede neue Buchung läuft durch die C3A-Maschine (durabler Nachweis in derselben Transaktion)
//   §3 Hauptbuch-Autorität: die Hausfolgen buchen streng, committen/speichern nie selbst; kein Rumpf nennt Buchungswerte
//   §4 Buchhaltungswerkzeuge bleiben Primary-only
//   §5 SSOT: 79 − 41 = 38, nur Geld/Steuer/Gold/Metall geschlossen
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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

const store = new Map<string, string>([['lataif_session', JSON.stringify({ branchId: 'branch-main', userId: 'user-test' })]]);
const storage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};
(globalThis as { localStorage?: unknown }).localStorage = storage;
(globalThis as { window?: unknown }).window = { localStorage: storage };

const registry = await import('../../src/core/bridge/command-registry.ts');
for (const m of ['read-commands', 'invoice-command', 'customer-commands', 'product-commands', 'invoice-lifecycle-commands',
  'commercial-commands', 'service-commands', 'financial-commands', 'return-commands', 'invoice-cancel-command',
  'lifecycle-commands', 'masterdata-commands', 'inventory-commands', 'store-read-commands',
  'money-commands', 'payables-commands', 'gold-commands', 'metal-commands',
  'offer-commands', 'invoice-flag-commands', 'sales-reversal-commands', 'message-commands',
  'purchase-lifecycle-commands', 'order-lifecycle-commands', 'consignment-lifecycle-commands', 'production-commands', 'office-commands']) {
  await import(`../../src/core/bridge/${m}.ts`);
}
const perms = await import('../../src/core/bridge/command-permissions.ts');
const readOps = await import('../../src/core/bridge/store-read-ops.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const marker = (m: string): void => { if (fails.length === 0) console.log(m); };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const vor = (p: string): string => execFileSync('git', ['show', `f750517:${p}`], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const codeOf = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const S = (v: unknown): string => JSON.stringify(v);

const R6D_MUT = ['tax.record_payment', 'banking.transfer', 'partners.record_tx', 'debts.create', 'debts.update', 'debts.record_payment',
  'expenses.create', 'expenses.update', 'expenses.record_payment', 'expenses.template_create', 'expenses.template_update',
  'purchases.record_payment', 'purchases.apply_credit', 'suppliers.pay', 'suppliers.apply_credit', 'suppliers.refund_credit',
  'gold.payables.settle', 'gold.customer_credits.settle', 'repairs.record_gold_usage', 'repairs.add_material',
  'orders.add_cost', 'orders.remove_cost', 'metals.create', 'metals.update_status', 'metals.set_spot_price',
  'scrap_trades.create', 'scrap_trades.update', 'scrap_trades.cancel'];
const R6D_READ = ['metals.spot_prices.get', 'debts.payments.get', 'suppliers.credits.get'];
// R6E — seither acht weitere Buchungen, alle HINTER den R6D-Namen (eigenes Gate: test/r6e).
const R6E_MUT = ['offers.create', 'offers.update', 'offers.set_status', 'offers.convert_to_invoice', 'invoices.set_butterfly', 'returns.cancel', 'transfers.undo_convert', 'customers.log_message'];
// R6F — seither vierzehn Buchungen, keine Auskunft, alle HINTER den R6E-Namen (eigenes Gate: test/r6f).
const R6F_MUT = ['purchases.return_to_supplier', 'purchases.cancel', 'purchases.dismiss_inbox', 'orders.cancel', 'orders.update_line_status', 'orders.mark_line_ordered', 'orders.update_line', 'consignments.return_after_sale', 'consignments.cancel_sale', 'production.create', 'tasks.create', 'tasks.update', 'documents.upload', 'documents.set_ocr'];
// POST-PARITY R7A (PP-2) — seither eine weitere Buchung HINTER den R6F-Namen: der Fertigungsabschluss.
const R7A_MUT = ['production.complete'];
// MEDIA-INBOX — die eine Buchung dieses Bundles: der Posteingang des Telefons.
const PREG5_MUT = ['purchase_inbox.create'];
const MODULES: Record<string, number> = { 'money-commands': 6, 'payables-commands': 10, 'gold-commands': 6, 'metal-commands': 6 };

// ══ §1 — Registry 121 → 152 ══════════════════════════════════════════════════
{
  const list = (t: string): string[] => [...(/export const ALLOWED_MUTATIONS: readonly string\[\] = \[([\s\S]*?)\];/.exec(t)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const vorher = list(vor('src/core/bridge/command-registry.ts'));
  const jetzt = [...registry.ALLOWED_MUTATIONS];
  ok(vorher.length === 52 && jetzt.length === 104 && S(jetzt.filter((o) => !vorher.includes(o))) === S([...R6D_MUT, ...R6E_MUT, ...R6F_MUT, ...R7A_MUT, ...PREG5_MUT]) && vorher.every((o) => jetzt.includes(o)),
    `REGISTRY Buchungen 52 → 80 (R6D) → 88 (R6E) → 102 (R6F) → 103 (R7A): GENAU die achtundzwanzig R6D-, acht R6E- und vierzehn R6F-Namen + eins aus R7A (production.complete), in dieser Reihenfolge, keine fällt weg (${jetzt.filter((o) => !vorher.includes(o)).length})`);
  const catalogue = (t: string): string[] => [...t.matchAll(/^export const OP_[A-Z_]+ = '([^']+)'/gm)].map((m) => m[1]);
  const readsVor = catalogue(vor('src/core/bridge/store-read-ops.ts'));
  const readsJetzt = [...readOps.STORE_READ_OPS];
  ok(S(readsJetzt.filter((o) => !readsVor.includes(o))) === S(R6D_READ) && readsJetzt.length === readsVor.length + 3,
    `REGISTRY Auskünfte: GENAU die drei R6D-Namen (${readsJetzt.filter((o) => !readsVor.includes(o)).join(',')})`);
  const rustOps = (t: string): string[] => {
    const l = /pub const REMOTE_OPS: &\[&str\] = &\[([\s\S]*?)\];/.exec(t)?.[1] ?? '';
    return (l.match(/OP_[A-Z_]+/g) ?? []).map((c) => new RegExp(`pub const ${c}: &str = "([^"]+)"`).exec(t)?.[1] ?? c);
  };
  const rVor = rustOps(vor('src-tauri/src/bridge.rs'));
  const rJetzt = rustOps(src('src-tauri/src/bridge.rs'));
  ok(rVor.length === 121 && rJetzt.length === 177 && S(rJetzt.filter((o) => !rVor.includes(o))) === S([...R6D_MUT, ...R6D_READ, ...R6E_MUT, ...R6F_MUT, ...R7A_MUT, 'products.duplicates.get', ...PREG5_MUT]),
    `REGISTRY Rust 121 → 152 (R6D) → 160 (R6E) → 174 (R6F) → 175 (R7A) → 176 (PRE-G5): GENAU diese einunddreißig, acht und vierzehn + eins aus R7A (production.complete), in dieser Reihenfolge (${rJetzt.filter((o) => !rVor.includes(o)).length})`);
  const known = registry.knownCommands();
  ok(known.length === 177 && S([...known].sort()) === S([...rJetzt].sort()), `REGISTRY der Renderer registriert GENAU die 177 Namen (PRE-G5), die Rust durchlässt (${known.length})`);
  for (const op of R6D_MUT) {
    const rule = (perms.OPERATION_PERMISSIONS as Record<string, unknown>)[op];
    const soll = op === 'orders.add_cost' || op === 'orders.remove_cost';
    ok(op in perms.OPERATION_PERMISSIONS && (soll ? (rule as { kind?: string })?.kind === 'isAdmin' : rule === null),
      `RECHT ${op}: ${soll ? 'perm.canManageOrders wie am Primary' : 'kein Tor (der Primary hat keins)'}`);
  }
  for (const op of R6D_READ) ok(op in perms.READ_PERMISSIONS && perms.READ_PERMISSIONS[op] === null, `RECHT ${op}: Auskunft ohne Tor, begrenzt durch die Filiale`);
  const r = await registry.executeCommand('expenses.delete', {}, { commandId: '00000001-0000-4000-8000-000000000000', tenantId: 't', branchId: 'branch-main', userId: 'u', role: 'ADMIN', op: 'expenses.delete', payloadHash: 'h' } as never);
  ok(r.kind === 'infrastructure_error' && r.code === 'BRIDGE_OP_NOT_REGISTERED', `FAILCLOSED ein unbekannter Name läuft nicht (${S(r)})`);
  for (const op of ['expenses.delete', 'debts.delete', 'gold.payables.delete', 'ledger.post', 'ledger.backfill', 'reconciliation.cancel', 'tax.delete_payment', 'metals.delete']) {
    let t = ''; try { registry.registerCommand(op, { kind: 'mutation', handler: () => ({}) }); } catch (e) { t = String(e); }
    ok(/refusing to register/.test(t) && !rJetzt.includes(op), `FAILCLOSED ${op} ist weder registrierbar noch in Rust`);
  }
}
marker('CENTRAL_UI_R6D_REGISTRY_152_AUDITED');

// ══ §2 — Idempotenz: jede Buchung durch die Maschine ═════════════════════════
{
  for (const [mod, anzahl] of Object.entries(MODULES)) {
    const code = codeOf(src(`src/core/bridge/${mod}.ts`));
    // Zwei Schreibweisen: `export function runX(deps, …)` oder `export const runX: Run = (deps, …) =>` über einen
    // gemeinsamen Lauf (`lauf`), der seinerseits runRemoteCommand ruft.
    const runs = [...code.matchAll(/export (?:async )?function (run[A-Z]\w*)\(deps|export const (run[A-Z]\w*): Run = \(deps/g)].map((m) => m[1] ?? m[2]);
    ok(runs.length >= anzahl, `IDEMPOTENT ${mod}: ${runs.length} Läufe für ${anzahl} Buchungen`);
    const laufStart = code.search(/function lauf\w*(<[^>]*>)?\(/);
    const laufOk = laufStart >= 0 && /runRemoteCommand\(deps, identity,/.test(code.slice(laufStart, code.indexOf('\n}', laufStart)));
    for (const fn of runs) {
      const a = code.search(new RegExp(`(function|const) ${fn}\\b`));
      const b = code.indexOf('\nexport ', a + 10);
      const body = code.slice(a, b < 0 ? undefined : b);
      ok(/runRemoteCommand\(deps, identity,/.test(body) || (laufOk && /lauf\w*\(deps, identity,/.test(body)),
        `IDEMPOTENT ${mod}.${fn} läuft durch runRemoteCommand (Kennung, durabler Nachweis)`);
    }
    ok((code.match(/registerCommand\(OP_[A-Z_]+, \{ kind: 'mutation',/g) ?? []).length === anzahl, `IDEMPOTENT ${mod} meldet jede Buchung einzeln an (${anzahl})`);
  }
}
marker('CENTRAL_UI_R6D_IDEMPOTENCY_PINNED');

// ══ §3 — Hauptbuch-Autorität ═════════════════════════════════════════════════
{
  const HOUSES = ['src/core/finance/money-house.ts', 'src/core/payables/payables-house.ts', 'src/core/gold/gold-settle.ts',
    'src/core/gold/gold-house.ts', 'src/core/metals/metal-house.ts', 'src/core/metals/scrap-house.ts'];
  for (const h of HOUSES) {
    const code = codeOf(src(h));
    ok(!/safePost\(/.test(code), `LEDGER ${h}: kein verschluckter Buchungsfehler (kein safePost)`);
    ok(!/run\(\s*'(BEGIN|COMMIT|ROLLBACK)'/.test(code) && !/saveDatabaseDurably/.test(code),
      `LEDGER ${h}: committet und speichert nie selbst — das tut die Klammer (runOnPrimary / runRemoteCommand)`);
    ok(/post[A-Z]\w*\(|reverseSource\(|reverseTransaction\(|watchLedgerPosts\(/.test(code) || h.endsWith('gold-house.ts'),
      `LEDGER ${h}: bucht über die vorhandenen Posting-Funktionen`);
  }
  for (const mod of Object.keys(MODULES)) {
    const code = src(`src/core/bridge/${mod}.ts`);
    ok(/the primary decides/.test(code) && /'revision'/.test(code) && /'branchId'/.test(code),
      `AUTORITÄT ${mod}: Filiale, Fassung und abgeleitete Werte stehen auf der Verbotsliste`);
    ok(/'(debit|credit|account|ledger)'/.test(code), `AUTORITÄT ${mod}: kein Rumpf nennt Konto, Soll oder Haben`);
  }
}
marker('CENTRAL_UI_R6D_LEDGER_AUTHORITY_PINNED');

// ══ §4 — Buchhaltungswerkzeuge bleiben Primary-only ══════════════════════════
{
  const app = src('src/App.tsx');
  for (const t of ['Ledger backfill', 'Ledger debug', 'Repair reconcile']) {
    ok(new RegExp(`PrimaryOnlyNotice title="${t}"`).test(app), `ACCOUNTING „${t}" ist ein Werkzeug des Primary (PrimaryOnlyNotice an der Route)`);
  }
  ok(/!readsFromPrimary\(\) && <Button/.test(src('src/pages/reports/ReconciliationPage.tsx')), 'ACCOUNTING der Storno der Abstimmung erscheint nur am Primary');
  ok(!registry.ALLOWED_MUTATIONS.some((o) => /backfill|ledger|reconcil/.test(o)), 'ACCOUNTING keine Fernbuchung für Nachbuchung, Hauptbuch oder Abstimmung');
}
marker('CENTRAL_UI_R6D_ACCOUNTING_CLASSIFICATION_PROVED');

// ══ §5 — SSOT: 79 − 41 = 38 ══════════════════════════════════════════════════
{
  const doc = src('docs/central-ui-parity.md');
  const a = doc.indexOf('### Write-Gap-SSOT');
  const zeilen = doc.slice(a, doc.indexOf('### Keine toten Knöpfe')).split(/\r?\n/).filter((l) => /^\| /.test(l) && !/^\| UI-Handlung|^\|---/.test(l)).map((l) => l.split('|').map((x) => x.trim()));
  const A = zeilen.filter((p) => p[5] === 'A');
  const r6c = A.filter((p) => /geschlossen \(R6C\)/.test(p[7] ?? ''));
  const r6d = A.filter((p) => /geschlossen \(R6D\)/.test(p[7] ?? ''));
  // R6E — seither sind weitere Zeilen geschlossen (eigenes Gate: test/r6e). Dieser Stand misst, was NACH R6D offen war.
  const offen = A.filter((p) => !/geschlossen \(R6[CD]\)/.test(p[7] ?? ''));
  ok(A.length === 95 && r6c.length === 16 && r6d.length === 41 && offen.length === 38,
    `SSOT A 95 · R6C 16 · R6D 41 · verbleibend 38 (${A.length}/${r6c.length}/${r6d.length}/${offen.length})`);
  const D = /^(Geld|Gold|Gold\/Geld|Steuer|Ausgaben|Buchung|Geld\/Buchung|Metall|Metall\/Bestand|Metall\/Geld|Filialeinstellung|Auftrag\/Gold|Auftrag\/Buchung|Reparatur\/Gold) ·/;
  ok(r6d.every((p) => D.test(p[8] ?? '')), 'SSOT geschlossen sind nur Zeilen der Domänen Geld, Steuer, Ausgaben, Buchung, Gold, Metall');
  ok(r6d.every((p) => { const m = /`([a-z_.]+)` \(R6D\)/.exec(p[6] ?? ''); return !!m && R6D_MUT.includes(m[1]); }), 'SSOT jede geschlossene Zeile nennt ihre R6D-Buchung');
  ok(R6D_MUT.every((op) => r6d.some((p) => (p[6] ?? '').includes('`' + op + '`'))), 'SSOT jede R6D-Buchung hat mindestens einen UI-Einstieg');
  ok(!offen.some((p) => D.test(p[8] ?? '')), `SSOT keine offene Zeile dieser Domänen bleibt zurück (${offen.filter((p) => D.test(p[8] ?? '')).map((p) => p[1]).join(', ') || 'keine'})`);
  const spaeter = offen.filter((p) => /Aufgabe|Dokument|Texterkennung|Inbox-Foto|Angebot|Produktion/.test(p[1]));
  // Angebote 6 (Titel mit „Angebot") · Aufgaben 2 · Dokument 1 · Texterkennung 1 · Inbox-Foto 1 · Produktion 1.
  ok(spaeter.length === 12, `SSOT Aufgaben, Dokumente, Inbox-Foto, Angebote, Produktion bleiben offen (${spaeter.length})`);
  ok(/### Stand der R6A-SSOT nach R6D/.test(doc) && /verbleibend\s+38/.test(doc) && /Registry\s+121 → 152/.test(doc), 'SSOT der Stand nach R6D ist fortgeschrieben');
}
marker('CENTRAL_UI_R6D_SSOT_UPDATED');

// ══ §6 — tax_payments: Sync nicht erforderlich (NOT REQUIRED) ════════════════
{
  const manifest = JSON.parse(src('src/core/sync/sync-business-schema.json')) as { tables: Record<string, unknown> };
  ok(!('tax_payments' in manifest.tables), 'SYNC tax_payments steht nicht im Sync-Manifest — der Sync-Server nimmt die Tabelle nicht an');
  ok(/"tax_payments"/.test(src('src-tauri/src/sync/sync_schema.rs')), 'SYNC der Rust-Vertrag führt tax_payments ausdrücklich als unbekannt (abgewiesen)');
  const { readdirSync } = await import('node:fs');
  const walk = (dir: string): string[] => readdirSync(resolvePath(repo, dir), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : /\.(ts|tsx)$/.test(e.name) ? [`${dir}/${e.name}`] : []));
  const dateien = walk('src').filter((p) => /tax_payments/.test(codeOf(src(p))));
  ok(!dateien.some((p) => /track(Insert|Update|Delete|Change)\(\s*'tax_payments'/.test(src(p))), 'SYNC kein Schreibweg meldet tax_payments an den Sync');
  const erlaubt = ['src/core/finance/money-house.ts', 'src/core/reports/analytics-snapshot.ts', 'src/core/reports/context.ts',
    'src/core/reports/reconciliation-snapshot.ts', 'src/core/ledger/backfill.ts', 'src/core/db/database.ts', 'src/core/sync/track.ts',
    // VAT-PERIOD-LOCK — der Periodenschutz liest „bezahlt = zu" am Primary (Hausprüfung jeder Rechnungsänderung).
    'src/core/tax/vat-period-lock.ts'];
  ok(dateien.every((p) => erlaubt.includes(p)),
    `SYNC jeder Leser und Schreiber sitzt am Primary (Hausfolge, Auswertung, Abgleich, Nachbuchung, Schema) (${dateien.filter((p) => !erlaubt.includes(p)).join(', ') || 'keine anderen'})`);
  ok(readOps.STORE_READ_OPS.includes('store.analytics.get') && !/tax_payments/.test(codeOf(src('src/pages/analytics/AnalyticsPage.tsx'))),
    'SYNC PC2 sieht die Steuerzahlungen nur über die Auskunft des Primary (store.analytics.get), die Seite fragt keine Tabelle');
}
marker('CENTRAL_UI_R6D_TAX_PAYMENT_SYNC_CONTRACT_PINNED');

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — r6d final gate: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R6D_FINAL_GATE_PROVED');
