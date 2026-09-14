// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6F FINAL GATE — Registry-Diff, Idempotenz, Primary zuerst, Autorität, SSOT-Abschluss.
// Run: node test/r6f/final-gate.test.ts
//
//   §1 Registry 160 → 174: genau 14 Buchungen, keine Auskunft, gegen den Stand VOR R6F (`65075a3`), TS == Rust,
//      Rechte wie am Primary, Löschen und Unbekanntes fail-closed
//   §2 Idempotenz: jede neue Buchung läuft durch die C3A-Maschine und ist einzeln angemeldet
//   §3 Primary zuerst: Store-Aktionen sind Anschlüsse an die Hausfolgen; Hausfolgen buchen streng, committen/rollen/
//      speichern nie selbst; der Verkaufsstorno löscht keine Finanzbelege; „Auftrag löschen" bleibt Primary-only
//   §4 Autorität: Verbotslisten, Rechte-Tore wie die Masken
//   §5 SSOT: 16 − 16 = 0 offene A-Zeilen, genau die eingefrorenen 16; Kategorien B/C/D/E unverändert
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    if (specifier === '@tauri-apps/api/core') {
      return { url: pathToFileURL(resolvePath(repo, 'test/bridge/_tauri-shim.ts')).href, shortCircuit: true };
    }
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
let seit = 0;
const marker = (m: string): void => { if (fails.length === seit) console.log(m); seit = fails.length; };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const BASE = '65075a3';
const vor = (p: string): string => execFileSync('git', ['show', `${BASE}:${p}`], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const codeOf = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const S = (v: unknown): string => JSON.stringify(v);

const R6F_MUT = ['purchases.return_to_supplier', 'purchases.cancel', 'purchases.dismiss_inbox',
  'orders.cancel', 'orders.update_line_status', 'orders.mark_line_ordered', 'orders.update_line',
  'consignments.return_after_sale', 'consignments.cancel_sale',
  'production.create', 'tasks.create', 'tasks.update', 'documents.upload', 'documents.set_ocr'];
/** POST-PARITY R7A (PP-2): der Fertigungsabschluss — die eine Buchung, die nach R6F hinten angehängt wurde. */
const R7A_MUT = ['production.complete'];
const MODULES: Record<string, number> = {
  'purchase-lifecycle-commands': 3, 'order-lifecycle-commands': 4, 'consignment-lifecycle-commands': 2,
  'production-commands': 2, 'office-commands': 4,
};
const ADMIN_OPS = ['orders.cancel', 'orders.mark_line_ordered', 'orders.update_line', 'consignments.return_after_sale', 'consignments.cancel_sale'];
/** Die Hausfolge des Verkaufsstornos der Kommission — der eine Ort, der Rechnung, Einkauf, Kommittent und Bestand zurücknimmt. */
const CONSIGNMENT_HOUSE = readdirSync(resolvePath(repo, 'src/core/consignment'))
  .map((f) => `src/core/consignment/${f}`)
  .find((p) => /house\.ts$/.test(p) && /cancelSale|cancel_sale|CancelSale/.test(src(p)) && /reverseInvoiceInHouse\(/.test(src(p))) ?? '';

// ══ §1 — Registry 160 → 174 ══════════════════════════════════════════════════
{
  const list = (t: string): string[] => [...(/export const ALLOWED_MUTATIONS: readonly string\[\] = \[([\s\S]*?)\];/.exec(t)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const vorher = list(vor('src/core/bridge/command-registry.ts'));
  const jetzt = [...registry.ALLOWED_MUTATIONS];
  ok(vorher.length === 88 && jetzt.length === 103 && S(jetzt.filter((o) => !vorher.includes(o))) === S([...R6F_MUT, ...R7A_MUT]) && vorher.every((o) => jetzt.includes(o)),
    `REGISTRY Buchungen 88 → 102 (R6F) → 103 (R7A): GENAU die vierzehn R6F-Namen + eins aus R7A (production.complete), in dieser Reihenfolge, keine fällt weg (${jetzt.filter((o) => !vorher.includes(o)).join(',')})`);
  const catalogue = (t: string): string[] => [...t.matchAll(/^export const OP_[A-Z_]+ = '([^']+)'/gm)].map((m) => m[1]);
  ok(S([...readOps.STORE_READ_OPS]) === S(catalogue(vor('src/core/bridge/store-read-ops.ts'))),
    'REGISTRY Auskünfte unverändert — die Bildkennungen kommen schon über products.get, die Inbox über store.purchases.get');
  const rustOps = (t: string): string[] => {
    const l = /pub const REMOTE_OPS: &\[&str\] = &\[([\s\S]*?)\];/.exec(t)?.[1] ?? '';
    return (l.match(/OP_[A-Z_]+/g) ?? []).map((c) => new RegExp(`pub const ${c}: &str = "([^"]+)"`).exec(t)?.[1] ?? c);
  };
  const rVor = rustOps(vor('src-tauri/src/bridge.rs'));
  const rJetzt = rustOps(src('src-tauri/src/bridge.rs'));
  ok(rVor.length === 160 && rJetzt.length === 175 && S(rJetzt.filter((o) => !rVor.includes(o))) === S([...R6F_MUT, ...R7A_MUT]),
    `REGISTRY Rust 160 → 174 (R6F) → 175 (R7A): GENAU diese vierzehn + eins aus R7A (production.complete), in dieser Reihenfolge (${rJetzt.filter((o) => !rVor.includes(o)).join(',')})`);
  const known = registry.knownCommands();
  ok(known.length === 175 && S([...known].sort()) === S([...rJetzt].sort()), `REGISTRY der Renderer registriert GENAU die 175 Namen (R7A), die Rust durchlässt (${known.length})`);
  for (const op of R6F_MUT) {
    const rule = (perms.OPERATION_PERMISSIONS as Record<string, { kind?: string } | null>)[op];
    const soll = ADMIN_OPS.includes(op) ? 'isAdmin' : null;
    ok(op in perms.OPERATION_PERMISSIONS && (soll === null ? rule === null : rule?.kind === soll), `RECHT ${op}: ${soll ?? 'kein Tor'} wie die Maske`);
  }
  for (const op of R7A_MUT) {
    const rule = (perms.OPERATION_PERMISSIONS as Record<string, { kind?: string } | null>)[op];
    ok(op in perms.OPERATION_PERMISSIONS && rule === null, `RECHT ${op} (R7A): kein Tor wie production.create`);
  }
  const ident = { commandId: '00000001-0000-4000-8000-000000000000', tenantId: 't', branchId: 'branch-main', userId: 'u', role: 'ADMIN', payloadHash: 'h' };
  const r = await registry.executeCommand('orders.delete', {}, { ...ident, op: 'orders.delete' } as never);
  ok(r.kind === 'infrastructure_error' && r.code === 'BRIDGE_OP_NOT_REGISTERED', `FAILCLOSED „Auftrag löschen" läuft nicht fern (${S(r)})`);
  for (const op of ['orders.delete', 'consignments.delete', 'purchases.delete', 'purchases.update', 'production.delete', 'tasks.delete',
    'documents.delete', 'orders.cancel_with_money', 'consignments.mark_returned_after_sale', 'purchases.delete_return']) {
    let t = ''; try { registry.registerCommand(op, { kind: 'mutation', handler: () => ({}) }); } catch (e) { t = String(e); }
    ok(/refusing to register/.test(t) && !rJetzt.includes(op), `FAILCLOSED ${op} ist weder registrierbar noch in Rust`);
  }
}
marker('CENTRAL_UI_R6F_REGISTRY_174_AUDITED');

// ══ §2 — Idempotenz ══════════════════════════════════════════════════════════
{
  for (const [mod, anzahl] of Object.entries(MODULES)) {
    const code = codeOf(src(`src/core/bridge/${mod}.ts`));
    ok(/runRemoteCommand\(/.test(code), `IDEMPOTENT ${mod} läuft durch runRemoteCommand (Kennung, durabler Nachweis)`);
    ok((code.match(/registerCommand\(\s*OP_[A-Z_]+\s*,\s*\{\s*kind:\s*'mutation'/g) ?? []).length === anzahl, `IDEMPOTENT ${mod} meldet jede Buchung einzeln an (${anzahl})`);
  }
}
marker('CENTRAL_UI_R6F_IDEMPOTENCY_PINNED');

// ══ §3 — Primary zuerst ══════════════════════════════════════════════════════
{
  ok(CONSIGNMENT_HOUSE !== '', `PRIMARY die Hausfolge des Verkaufsstornos ist gefunden (${CONSIGNMENT_HOUSE})`);
  const HOUSES = ['src/core/purchases/purchase-lifecycle-house.ts', 'src/core/orders/order-lifecycle-house.ts', CONSIGNMENT_HOUSE,
    'src/core/production/production-house.ts', 'src/core/office/task-house.ts', 'src/core/office/document-house.ts'].filter(Boolean);
  for (const h of HOUSES) {
    const code = codeOf(src(h));
    ok(!/safePost\(/.test(code), `LEDGER ${h}: kein verschluckter Buchungsfehler (kein safePost)`);
    ok(!/run\(\s*'(BEGIN|COMMIT|ROLLBACK)'/.test(code) && !/saveDatabaseDurably|rollbackLedgerTransaction\(|commitLedgerTransaction\(/.test(code),
      `LEDGER ${h}: committet, rollt und speichert nie selbst — das tut die Klammer (runOnPrimary / runRemoteCommand)`);
  }
  const stores: Array<[string, RegExp, string]> = [
    ['src/stores/purchaseStore.ts', /purchase-lifecycle-house|purchase-house/, 'Rückgabe, Storno, Inbox'],
    ['src/stores/consignmentStore.ts', new RegExp(CONSIGNMENT_HOUSE.split('/').pop()!.replace('.ts', '')), 'Rückgabe nach Verkauf, Verkaufsstorno'],
    ['src/stores/productionStore.ts', /production-house/, 'Produktion anlegen'],
    ['src/stores/taskStore.ts', /task-house/, 'Aufgaben'],
    ['src/stores/documentStore.ts', /document-house/, 'Dokumente/Texterkennung'],
  ];
  for (const [f, house, was] of stores) ok(house.test(src(f)), `PRIMARY ${f.split('/').pop()}: ${was} ist ein Anschluss an die Hausfolge`);
  // Der Auftrag ist andersherum geschnitten: die Hausfolge (Klammer, Prüfungen, strenge Buchung) ruft die Store-Aktionen als
  // ihren Kern — EINE Umsetzung —, und die Maske ruft nur noch die Hausfolge (…OnPrimary), nie den Store direkt.
  const olh = codeOf(src('src/core/orders/order-lifecycle-house.ts'));
  const odc = codeOf(src('src/pages/orders/OrderDetail.tsx'));
  ok(/@\/stores\/orderStore/.test(olh) && /watchLedgerPosts\(/.test(olh)
    && ['cancelOrderOnPrimary', 'setOrderLineStatusOnPrimary', 'markOrderLineOrderedOnPrimary', 'updateOrderLineOnPrimary'].every((fn) => new RegExp(`local: \\(\\) => ${fn}\\(`).test(odc)),
  'PRIMARY Auftrag: die Maske ruft nur die Hausfolge; die Hausfolge wacht über die Buchungen des Store-Kerns');
  const kh = codeOf(src(CONSIGNMENT_HOUSE));
  ok(/reverseInvoiceInHouse\(/.test(kh) && /cancelPurchaseInHouse\(/.test(kh) && !/DELETE FROM (credit_notes|sales_returns|invoices|payments|customer_credits)\b/.test(kh),
    'PRIMARY der Verkaufsstorno nutzt die R6E-Storno-Grundlage und den Einkaufsstorno des Hauses — keine harte Löschung von Finanzbelegen');
  const od = src('src/pages/orders/OrderDetail.tsx');
  ok(/primaryOnlyDeleteProps\(\)/.test(od) && /blockDeleteOnClient\(\)/.test(od), 'PRIMARY „Auftrag löschen" bleibt am Primary (Kategorie E)');
  ok(!/nichtAmClient\('editing product images'\)/.test(src('src/pages/watches/ProductDetail.tsx')), 'PRIMARY der Bildweg ist auf PC2 nicht mehr gesperrt (products.update mit Galerie)');
}
marker('CENTRAL_UI_R6F_PRIMARY_FIRST_PROVED');

// ══ §4 — Autorität ═══════════════════════════════════════════════════════════
{
  for (const mod of Object.keys(MODULES)) {
    const code = src(`src/core/bridge/${mod}.ts`);
    ok(/the primary decides/.test(code) && /'branchId'/.test(code) && /'createdBy'|'created_by'|'userId'/.test(code) && /'revision'/.test(code),
      `AUTORITÄT ${mod}: Filiale, Absender, Fassung und abgeleitete Werte stehen auf der Verbotsliste`);
  }
  for (const op of ADMIN_OPS) ok(!perms.roleMayRunOp('SALES', op) && perms.roleMayRunOp('MANAGER', op) && perms.roleMayRunOp('ADMIN', op), `AUTORITÄT ${op} nur mit perm.canManage…`);
  for (const op of R6F_MUT.filter((o) => !ADMIN_OPS.includes(o))) ok(perms.roleMayRunOp('SALES', op), `AUTORITÄT ${op}: ohne Tor am Primary, ohne Tor aus der Ferne`);
}
marker('CENTRAL_UI_R6F_AUTHORITY_PROVED');

// ══ §5 — SSOT: 16 − 16 = 0 ═══════════════════════════════════════════════════
const zeilenAus = (doc: string): string[][] => {
  const a = doc.indexOf('### Write-Gap-SSOT');
  return doc.slice(a, doc.indexOf('### Keine toten Knöpfe')).split(/\r?\n/).filter((l) => /^\| /.test(l) && !/^\| UI-Handlung|^\|---/.test(l)).map((l) => l.split('|').map((x) => x.trim()));
};
const FROZEN = ['Rückgabe an Lieferant', 'Einkauf stornieren', 'Inbox-Foto verwerfen', 'Auftrag stornieren (mit Geld)',
  'Zeilenstatus PENDING/ARRIVED/DELIVERED', 'Zeilenstatus zurück', 'Position bearbeiten', 'Beim Lieferanten bestellt', 'Produktion anlegen',
  'Rückgabe nach Verkauf', 'Verkauf stornieren', 'Artikel speichern mit Bildänderung', 'Aufgabe anlegen/ändern', 'Aufgabe erledigt',
  'Dokument hochladen', 'Texterkennung (OCR)'];
{
  const doc = src('docs/central-ui-parity.md');
  const zeilen = zeilenAus(doc);
  const A = zeilen.filter((p) => p[5] === 'A');
  const n = (r: RegExp): number => A.filter((p) => r.test(p[7] ?? '')).length;
  const r6f = A.filter((p) => /geschlossen \(R6F\)/.test(p[7] ?? ''));
  const offen = A.filter((p) => !/geschlossen/.test(p[7] ?? ''));
  ok(A.length === 95 && n(/geschlossen \(R6C\)/) === 16 && n(/geschlossen \(R6D\)/) === 41 && n(/geschlossen \(R6E\)/) === 22 && r6f.length === 16 && offen.length === 0,
    `SSOT A 95 · R6C 16 · R6D 41 · R6E 22 · R6F 16 · verbleibend 0 (${A.length}/${r6f.length}/${offen.length})`);
  ok(S(r6f.map((p) => p[1]).sort()) === S([...FROZEN].sort()), `SSOT geschlossen sind GENAU die eingefrorenen 16 Zeilen (${r6f.map((p) => p[1]).filter((x) => !FROZEN.includes(x)).join(', ') || 'keine fremde'})`);
  const vorDoc = zeilenAus(vor('docs/central-ui-parity.md'));
  const offenVor = vorDoc.filter((p) => p[5] === 'A' && !/geschlossen/.test(p[7] ?? ''));
  ok(offenVor.length === 16 && S(offenVor.map((p) => p[1]).sort()) === S([...FROZEN].sort()), `SSOT vor R6F waren genau diese 16 offen (${offenVor.length})`);
  const erlaubt = [...R6F_MUT, 'products.update'];
  ok(r6f.every((p) => { const m = /`([a-z_.]+)` \(R6F\)/.exec(p[6] ?? ''); return !!m && erlaubt.includes(m[1]); }), 'SSOT jede geschlossene Zeile nennt ihre Buchung');
  ok(R6F_MUT.every((op) => r6f.some((p) => (p[6] ?? '').includes('`' + op + '`'))), 'SSOT jede neue R6F-Buchung hat mindestens einen UI-Einstieg');
  for (const k of ['B', 'C', 'D', 'E']) {
    const jetzt = zeilen.filter((p) => p[5] === k).map((p) => p.join('|'));
    const damals = vorDoc.filter((p) => p[5] === k).map((p) => p.join('|'));
    ok(S(jetzt) === S(damals) && !jetzt.some((z) => /geschlossen \(R6F\)/.test(z)), `SSOT Kategorie ${k} unverändert und nicht als geschlossen ausgegeben (${jetzt.length})`);
  }
  ok(/### Stand der R6A-SSOT nach R6F/.test(doc) && /verbleibend\s+0/.test(doc) && /Registry\s+160 → 174/.test(doc), 'SSOT der Stand nach R6F ist fortgeschrieben');
  marker('CENTRAL_UI_R6F_SCOPE_FROZEN');
}
marker('CENTRAL_UI_R6F_SSOT_UPDATED');

console.log(fails.length === 0 ? `PASS — r6f final gate: ${PASS} passed, 0 failed` : `FAIL — r6f final gate: ${PASS} passed, ${fails.length} failed`);
process.exit(fails.length === 0 ? 0 : 1);
