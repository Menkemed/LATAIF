// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6E FINAL GATE — Registry-Diff, Idempotenz, Primary zuerst, Autorität, SSOT-Arithmetik, R6F offen.
// Run: node test/r6e/final-gate.test.ts
//
//   §1 Registry 152 → 160: genau 8 Buchungen, keine Auskunft, gegen den Stand VOR R6E (`c32e14a`), TS == Rust,
//      Rechte wie am Primary, Unbekanntes fail-closed
//   §2 Idempotenz: jede neue Buchung läuft durch die C3A-Maschine und ist einzeln angemeldet
//   §3 Primary zuerst: die Store-Aktionen des Primary sind Anschlüsse an die Hausfolgen; Hausfolgen buchen streng,
//      committen/rollen/speichern nie selbst; die Transfer-Rücknahme löscht keine Rechnung mehr
//   §4 Autorität: Verbotslisten, Owner-Regel des Retourenstornos, Bearbeitungsrecht des Angebots
//   §5 SSOT: 38 − 22 = 16, genau die eingefrorenen 22 Zeilen, Kategorien B/C/D/E unverändert
//   §6 R6F bleibt vollständig offen
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
const fin = await import('../../src/core/bridge/financial-commands.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
let seit = 0;
const marker = (m: string): void => { if (fails.length === seit) console.log(m); seit = fails.length; };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const BASE = 'c32e14a';
const vor = (p: string): string => execFileSync('git', ['show', `${BASE}:${p}`], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const codeOf = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const S = (v: unknown): string => JSON.stringify(v);

const R6E_MUT = ['offers.create', 'offers.update', 'offers.set_status', 'offers.convert_to_invoice',
  'invoices.set_butterfly', 'returns.cancel', 'transfers.undo_convert', 'customers.log_message'];
// Zwei vorhandene Buchungen sind erweitert, nicht neu: Zahlung beim Anlegen, Wahl der Sondernummer.
const ERWEITERT = ['invoices.create', 'invoices.record_payment'];
const MODULES: Record<string, number> = { 'offer-commands': 4, 'invoice-flag-commands': 1, 'sales-reversal-commands': 2, 'message-commands': 1 };
// R6F — seither vierzehn weitere Buchungen HINTER den R6E-Namen (eigenes Gate: test/r6f).
const R6F_MUT = ['purchases.return_to_supplier', 'purchases.cancel', 'purchases.dismiss_inbox', 'orders.cancel', 'orders.update_line_status', 'orders.mark_line_ordered', 'orders.update_line', 'consignments.return_after_sale', 'consignments.cancel_sale', 'production.create', 'tasks.create', 'tasks.update', 'documents.upload', 'documents.set_ocr'];
const R6F_OPS = ['purchases.return', 'purchases.cancel', 'purchases.inbox_dismiss', 'purchases.dismiss_inbox', 'orders.cancel',
  'orders.update_line_status', 'orders.line_status', 'orders.update_line', 'consignments.return_after_sale', 'consignments.cancel_sale',
  'production.create', 'tasks.create', 'tasks.update', 'documents.upload', 'documents.set_ocr'];
// POST-PARITY R7A (PP-2) — seither eine weitere Buchung HINTER den R6F-Namen: der Fertigungsabschluss.
const R7A_MUT = ['production.complete'];

// ══ §1 — Registry 152 → 160 ══════════════════════════════════════════════════
{
  const list = (t: string): string[] => [...(/export const ALLOWED_MUTATIONS: readonly string\[\] = \[([\s\S]*?)\];/.exec(t)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const vorher = list(vor('src/core/bridge/command-registry.ts'));
  const jetzt = [...registry.ALLOWED_MUTATIONS];
  ok(vorher.length === 80 && jetzt.length === 103 && S(jetzt.filter((o) => !vorher.includes(o))) === S([...R6E_MUT, ...R6F_MUT, ...R7A_MUT]) && vorher.every((o) => jetzt.includes(o)),
    `REGISTRY Buchungen 80 → 88 (R6E) → 102 (R6F) → 103 (R7A): GENAU die acht R6E- und vierzehn R6F-Namen + eins aus R7A (production.complete), in dieser Reihenfolge, keine fällt weg (${jetzt.filter((o) => !vorher.includes(o)).join(',')})`);
  const catalogue = (t: string): string[] => [...t.matchAll(/^export const OP_[A-Z_]+ = '([^']+)'/gm)].map((m) => m[1]);
  const readsVor = catalogue(vor('src/core/bridge/store-read-ops.ts'));
  const readsJetzt = [...readOps.STORE_READ_OPS];
  ok(S(readsJetzt) === S(readsVor), `REGISTRY Auskünfte unverändert — die Stornierbarkeit reist in store.sales_returns.get (${readsJetzt.length})`);
  const rustOps = (t: string): string[] => {
    const l = /pub const REMOTE_OPS: &\[&str\] = &\[([\s\S]*?)\];/.exec(t)?.[1] ?? '';
    return (l.match(/OP_[A-Z_]+/g) ?? []).map((c) => new RegExp(`pub const ${c}: &str = "([^"]+)"`).exec(t)?.[1] ?? c);
  };
  const rVor = rustOps(vor('src-tauri/src/bridge.rs'));
  const rJetzt = rustOps(src('src-tauri/src/bridge.rs'));
  ok(rVor.length === 152 && rJetzt.length === 176 && S(rJetzt.filter((o) => !rVor.includes(o))) === S([...R6E_MUT, ...R6F_MUT, ...R7A_MUT, 'products.duplicates.get']),
    `REGISTRY Rust 152 → 160 (R6E) → 174 (R6F) → 175 (R7A) → 176 (PRE-G5): GENAU diese acht und vierzehn + eins aus R7A (production.complete), in dieser Reihenfolge (${rJetzt.filter((o) => !rVor.includes(o)).join(',')})`);
  const known = registry.knownCommands();
  ok(known.length === 176 && S([...known].sort()) === S([...rJetzt].sort()), `REGISTRY der Renderer registriert GENAU die 176 Namen (PRE-G5), die Rust durchlässt (${known.length})`);
  const soll: Record<string, string | null> = {
    'offers.create': null, 'offers.update': 'permission:offers.edit', 'offers.set_status': null, 'offers.convert_to_invoice': null,
    'invoices.set_butterfly': 'isAdmin', 'returns.cancel': 'isOwner', 'transfers.undo_convert': null, 'customers.log_message': null,
  };
  for (const op of R6E_MUT) {
    const rule = (perms.OPERATION_PERMISSIONS as Record<string, { kind?: string; permission?: string } | null>)[op];
    const ist = rule === null ? null : rule?.kind === 'permission' ? `permission:${rule.permission}` : String(rule?.kind);
    ok(op in perms.OPERATION_PERMISSIONS && ist === soll[op], `RECHT ${op}: ${soll[op] ?? 'kein Tor'} wie am Primary (${ist})`);
  }
  for (const op of ERWEITERT) ok(vorher.includes(op) && jetzt.includes(op), `REGISTRY ${op} bleibt dieselbe Buchung (erweitert, nicht neu)`);
  const ident = { commandId: '00000001-0000-4000-8000-000000000000', tenantId: 't', branchId: 'branch-main', userId: 'u', role: 'ADMIN', payloadHash: 'h' };
  const r = await registry.executeCommand('invoices.delete', {}, { ...ident, op: 'invoices.delete' } as never);
  ok(r.kind === 'infrastructure_error' && r.code === 'BRIDGE_OP_NOT_REGISTERED', `FAILCLOSED ein unbekannter Name läuft nicht (${S(r)})`);
  for (const op of ['invoices.delete', 'invoices.set_special_mark', 'offers.delete', 'transfers.delete', 'returns.delete', 'credit_notes.delete', 'customers.delete_message']) {
    let t = ''; try { registry.registerCommand(op, { kind: 'mutation', handler: () => ({}) }); } catch (e) { t = String(e); }
    ok(/refusing to register/.test(t) && !rJetzt.includes(op), `FAILCLOSED ${op} ist weder registrierbar noch in Rust`);
  }
  const c3g = fin.C3G_PRIMARY_ONLY as readonly string[];
  ok(!c3g.includes('transfers.undo_convert') && c3g.includes('invoices.delete') && c3g.includes('invoices.set_special_mark') && c3g.includes('transfers.delete'),
    'FAILCLOSED die Klasse-C-Liste nennt Löschen und Sondermarke weiter — nur die Rücknahme der Umwandlung ist freigegeben');
}
marker('CENTRAL_UI_R6E_REGISTRY_160_AUDITED');

// ══ §2 — Idempotenz: jede Buchung durch die Maschine ═════════════════════════
{
  for (const [mod, anzahl] of Object.entries(MODULES)) {
    const code = codeOf(src(`src/core/bridge/${mod}.ts`));
    ok(/runRemoteCommand\(/.test(code), `IDEMPOTENT ${mod} läuft durch runRemoteCommand (Kennung, durabler Nachweis)`);
    ok((code.match(/registerCommand\(\s*OP_[A-Z_]+\s*,\s*\{\s*kind:\s*'mutation'/g) ?? []).length === anzahl, `IDEMPOTENT ${mod} meldet jede Buchung einzeln an (${anzahl})`);
  }
  for (const mod of ['invoice-command', 'invoice-lifecycle-commands']) {
    ok(/runRemoteCommand\(/.test(codeOf(src(`src/core/bridge/${mod}.ts`))), `IDEMPOTENT ${mod}: die erweiterte Buchung bleibt in der Maschine`);
  }
}
marker('CENTRAL_UI_R6E_IDEMPOTENCY_PINNED');

// ══ §3 — Primary zuerst: eine Hausfolge, zwei Anschlüsse ═════════════════════
{
  const HOUSES = ['src/core/offers/offer-house.ts', 'src/core/invoices/invoice-create-house.ts', 'src/core/invoices/invoice-payment-house.ts',
    'src/core/invoices/invoice-flag-house.ts', 'src/core/invoices/invoice-reversal.ts', 'src/core/returns/return-cancel-house.ts',
    'src/core/customers/message-house.ts'];
  // Die alten, synchronen Store-Aufrufe des Angebots haben einen eigenen Anschluss (`offerAction`) — er klammert nur,
  // wenn noch keine Klammer läuft; sonst gehört die Rücknahme der äußeren.
  const oh = codeOf(src('src/core/offers/offer-house.ts'));
  const oa = oh.slice(oh.indexOf('export function offerAction'), oh.indexOf('\n}', oh.indexOf('export function offerAction')) + 2);
  ok(/if \(inLedgerTransaction\(\)\) return fn\(ctx\);/.test(oa) && oa.indexOf('inLedgerTransaction()') < oa.indexOf('beginLedgerTransaction()'),
    'LEDGER offerAction öffnet nur eine eigene Klammer, wenn keine läuft (kein ROLLBACK über eine äußere Transaktion)');
  for (const h of HOUSES) {
    const code = h.endsWith('offer-house.ts') ? codeOf(src(h)).replace(oa, '') : codeOf(src(h));
    ok(!/safePost\(/.test(code), `LEDGER ${h}: kein verschluckter Buchungsfehler (kein safePost)`);
    ok(!/run\(\s*'(BEGIN|COMMIT|ROLLBACK)'/.test(code) && !/saveDatabaseDurably|rollbackLedgerTransaction\(|commitLedgerTransaction\(/.test(code),
      `LEDGER ${h}: committet, rollt und speichert nie selbst — das tut die Klammer (runOnPrimary / runRemoteCommand)`);
  }
  for (const h of ['src/core/offers/offer-house.ts', 'src/core/invoices/invoice-create-house.ts', 'src/core/invoices/invoice-payment-house.ts', 'src/core/invoices/invoice-reversal.ts']) {
    ok(/watchLedgerPosts\(/.test(codeOf(src(h))), `LEDGER ${h}: wacht über die Buchungen der alten Store-Schreiber`);
  }
  const stores: Array<[string, RegExp, string]> = [
    ['src/stores/offerStore.ts', /offers\/offer-house/, 'createOffer'],
    ['src/stores/invoiceStore.ts', /offers\/offer-house|offer-house/, 'createInvoiceFromOffer'],
    ['src/stores/salesReturnStore.ts', /return-cancel-house/, 'cancelReturn'],
    ['src/stores/customerMessageStore.ts', /message-house/, 'logMessage'],
  ];
  for (const [f, house, fn] of stores) ok(house.test(src(f)), `PRIMARY ${f.split('/').pop()}: ${fn} ist ein Anschluss an die Hausfolge`);
  const agent = codeOf(src('src/stores/agentStore.ts'));
  // Die Umsetzung, nicht die Typdeklaration im Interface (`(transferId: string, …)`).
  const undoAt = agent.search(/undoTransferInvoiceConvert: \(transferId, /);
  const undo = undoAt < 0 ? '' : agent.slice(undoAt, agent.indexOf('\n  },', undoAt));
  ok(undo.length > 0 && !/deleteInvoice\(/.test(undo), 'PRIMARY die Transfer-Rücknahme löscht keine Rechnung mehr');
  const th = codeOf(src('src/core/agents/transfer-house.ts'));
  ok(/undoTransferInvoiceConvert\(/.test(th) && /watchLedgerPosts\(/.test(th) && /reverseInvoiceInHouse\(/.test(undo)
    && /verkaufsforderungWiederStellen\(/.test(undo) && /function verkaufsforderungWiederStellen[\s\S]*?postAgentTransferSold\(/.test(agent),
    'PRIMARY Rücknahme = Rechnungsstorno + neu gebuchte Verkaufsforderung (transfer-house → Hausfunktion des agentStore)');
  const rev = codeOf(src('src/core/invoices/invoice-reversal.ts'));
  ok(/status:\s*'CANCELLED'/.test(rev) && !/deleteInvoice\(|DELETE FROM invoices/.test(rev), 'PRIMARY die Storno-Grundlage lässt den Beleg als CANCELLED stehen');
  const rc = codeOf(src('src/core/returns/return-cancel-house.ts'));
  ok(!/useAuthStore/.test(rc), 'PRIMARY der Retourenstorno fragt nicht die Anmeldung am Primary');
  const inv = codeOf(src('src/stores/invoiceStore.ts'));
  const cifo = inv.slice(inv.indexOf('createInvoiceFromOffer: ('), inv.indexOf('createDirectInvoice: ('));
  ok(cifo.length > 0 && !/INSERT INTO invoices|consumeLot\(|postInvoiceIssued\(/.test(cifo), 'PRIMARY Angebot → Rechnung ist kein zweiter Rechnungsweg mehr');
  ok(!/eventBus\.on\('offer\.(created|sent|accepted|rejected)'/.test(codeOf(src('src/core/automation/automation-handlers.ts'))),
    'PRIMARY die Folgen eines Angebots laufen in der Transaktion, nicht mehr über den Ereignisbus');
}
marker('CENTRAL_UI_R6E_PRIMARY_FIRST_PROVED');

// ══ §4 — Autorität ═══════════════════════════════════════════════════════════
{
  for (const mod of Object.keys(MODULES)) {
    const code = src(`src/core/bridge/${mod}.ts`);
    ok(/the primary decides/.test(code) && /'branchId'/.test(code) && /'createdBy'|'userId'/.test(code),
      `AUTORITÄT ${mod}: Filiale, Absender und abgeleitete Werte stehen auf der Verbotsliste`);
  }
  const off = src('src/core/bridge/offer-commands.ts') + src('src/core/offers/offer-rules.ts');
  ok(['offerNumber', 'total', 'subtotal', 'vatAmount', 'lineTotal', 'purchasePrice', 'invoiceNumber'].every((f) => off.includes(`'${f}'`)),
    'AUTORITÄT Angebot: Nummer, Summen, MwSt, Zeilensumme, Einstand und Rechnungsnummer entscheidet der Primary');
  const ic = src('src/core/bridge/invoice-command.ts');
  ok(['invoiceNumber', 'paidAmount', 'grossAmount', 'vatAmount', 'purchasePrice', 'specialMarkOnFinal'].every((f) => ic.includes(`'${f}'`)),
    'AUTORITÄT Anlegen: Nummer, Bezahltes, Summen, Einstand — und in der Zahlung keine Nummernwahl');
  ok(perms.roleMayRunOp('ADMIN', 'returns.cancel') && !perms.roleMayRunOp('MANAGER', 'returns.cancel') && !perms.roleMayRunOp('SALES', 'returns.cancel')
    && !perms.roleMayRunOp(undefined, 'returns.cancel'), 'AUTORITÄT returns.cancel nur für den Eigentümer (auch kein Manager, keine fehlende Rolle)');
  ok(perms.requiredPermissionLabel('returns.cancel') === 'the owner account', 'AUTORITÄT …und das Nein nennt das Recht');
  ok(perms.roleMayRunOp('ADMIN', 'offers.update') && !perms.roleMayRunOp('ACCOUNTANT', 'offers.update'), 'AUTORITÄT offers.update braucht offers.edit');
  ok(perms.roleMayRunOp('SALES', 'offers.set_status') && perms.roleMayRunOp('SALES', 'customers.log_message'),
    'AUTORITÄT ohne Tor am Primary auch ohne Tor aus der Ferne (nicht weniger als lokal)');
  ok(!perms.roleMayRunOp('SALES', 'invoices.set_butterfly') && perms.roleMayRunOp('MANAGER', 'invoices.set_butterfly'), 'AUTORITÄT Butterfly wie „Edit" (perm.canEditInvoices)');
}
marker('CENTRAL_UI_R6E_AUTHORITY_PROVED');

// ══ §5 — SSOT: 38 − 22 = 16 ══════════════════════════════════════════════════
const zeilenAus = (doc: string): string[][] => {
  const a = doc.indexOf('### Write-Gap-SSOT');
  return doc.slice(a, doc.indexOf('### Keine toten Knöpfe')).split(/\r?\n/).filter((l) => /^\| /.test(l) && !/^\| UI-Handlung|^\|---/.test(l)).map((l) => l.split('|').map((x) => x.trim()));
};
const FROZEN = ['Rechnung anlegen mit Zahlung > 0', 'Butterfly-Schalter', 'Schlusszahlung mit Sondernummer', 'Retoure stornieren',
  'Angebot speichern', 'Angebot senden', 'Angebot annehmen', 'Angebot ablehnen', 'Angebot → Rechnung', 'Position hinzufügen',
  'Positionspreis ändern', 'Position entfernen', 'Angebot anlegen', 'Senden (Liste)', 'Annehmen (Liste)', 'Ablehnen (Liste)',
  'Nachricht kopieren (Protokoll)', 'WhatsApp (Protokoll)', 'AI-Benachrichtigung (Protokoll)', 'AI-Benachrichtigung (Reparatur)',
  'Umwandlung rückgängig (Tabelle)', 'Umwandlung rückgängig (Detail)'];
const R6F_ROWS = ['Rückgabe an Lieferant', 'Einkauf stornieren', 'Inbox-Foto verwerfen', 'Auftrag stornieren (mit Geld)',
  'Zeilenstatus PENDING/ARRIVED/DELIVERED', 'Zeilenstatus zurück', 'Position bearbeiten', 'Beim Lieferanten bestellt', 'Produktion anlegen',
  'Rückgabe nach Verkauf', 'Verkauf stornieren', 'Artikel speichern mit Bildänderung', 'Aufgabe anlegen/ändern', 'Aufgabe erledigt',
  'Dokument hochladen', 'Texterkennung (OCR)'];
{
  const doc = src('docs/central-ui-parity.md');
  const zeilen = zeilenAus(doc);
  const A = zeilen.filter((p) => p[5] === 'A');
  const r6c = A.filter((p) => /geschlossen \(R6C\)/.test(p[7] ?? ''));
  const r6d = A.filter((p) => /geschlossen \(R6D\)/.test(p[7] ?? ''));
  const r6e = A.filter((p) => /geschlossen \(R6E\)/.test(p[7] ?? ''));
  // R6F — seither sind die restlichen Zeilen geschlossen (eigenes Gate: test/r6f). Gemessen wird, was NACH R6E offen war.
  const offen = A.filter((p) => !/geschlossen \(R6[CDE]\)/.test(p[7] ?? ''));
  ok(A.length === 95 && r6c.length === 16 && r6d.length === 41 && r6e.length === 22 && offen.length === 16,
    `SSOT A 95 · R6C 16 · R6D 41 · R6E 22 · verbleibend 16 (${A.length}/${r6c.length}/${r6d.length}/${r6e.length}/${offen.length})`);
  ok(S(r6e.map((p) => p[1]).sort()) === S([...FROZEN].sort()), `SSOT geschlossen sind GENAU die eingefrorenen 22 Zeilen (${r6e.map((p) => p[1]).filter((n) => !FROZEN.includes(n)).join(', ') || 'keine fremde'})`);
  const vorDoc = zeilenAus(vor('docs/central-ui-parity.md'));
  const offenVor = vorDoc.filter((p) => p[5] === 'A' && !/geschlossen/.test(p[7] ?? ''));
  ok(offenVor.length === 38 && FROZEN.every((n) => offenVor.some((p) => p[1] === n)), `SSOT vor R6E waren 38 offen, und alle 22 gehörten dazu (${offenVor.length})`);
  const erlaubt = [...R6E_MUT, ...ERWEITERT];
  ok(r6e.every((p) => { const m = /`([a-z_.]+)` \(R6E\)/.exec(p[6] ?? ''); return !!m && erlaubt.includes(m[1]); }), 'SSOT jede geschlossene Zeile nennt ihre R6E-Buchung');
  ok(R6E_MUT.every((op) => r6e.some((p) => (p[6] ?? '').includes('`' + op + '`'))), 'SSOT jede neue R6E-Buchung hat mindestens einen UI-Einstieg');
  for (const k of ['B', 'C', 'D', 'E']) {
    const jetzt = zeilen.filter((p) => p[5] === k).map((p) => p.join('|'));
    const damals = vorDoc.filter((p) => p[5] === k).map((p) => p.join('|'));
    ok(S(jetzt) === S(damals), `SSOT Kategorie ${k} unverändert — nichts aus C/D/E wurde zu A oder fern gemacht (${jetzt.length})`);
  }
  ok(/### Stand der R6A-SSOT nach R6E/.test(doc) && /verbleibend\s+16/.test(doc) && /Registry\s+152 → 160/.test(doc), 'SSOT der Stand nach R6E ist fortgeschrieben');
  marker('CENTRAL_UI_R6E_SCOPE_FROZEN');
}
marker('CENTRAL_UI_R6E_SSOT_UPDATED');

// ══ §6 — R6F bleibt vollständig offen ════════════════════════════════════════
{
  const offen = zeilenAus(src('docs/central-ui-parity.md')).filter((p) => p[5] === 'A' && !/geschlossen \(R6[CDE]\)/.test(p[7] ?? ''));
  ok(S(offen.map((p) => p[1]).sort()) === S([...R6F_ROWS].sort()), `R6F die 16 offenen Zeilen sind genau der R6F-Umfang (${offen.map((p) => p[1]).join(' · ')})`);
  const rust = src('src-tauri/src/bridge.rs');
  // R6F ist seither geschlossen (test/r6f). Geprüft bleibt: R6E hat keinen R6F-Namen vorgezogen — jeder steht HINTER den R6E-Namen.
  void R6F_OPS;
  for (const op of R6F_MUT) ok(registry.ALLOWED_MUTATIONS.indexOf(op) > registry.ALLOWED_MUTATIONS.indexOf('customers.log_message') && rust.includes(`"${op}"`),
    `R6F ${op} kam erst mit R6F (hinter den R6E-Namen)`);
}
marker('CENTRAL_UI_R6F_UNTOUCHED');

console.log(fails.length === 0 ? `PASS — r6e final gate: ${PASS} passed, 0 failed` : `FAIL — r6e final gate: ${PASS} passed, ${fails.length} failed`);
process.exit(fails.length === 0 ? 0 : 1);
