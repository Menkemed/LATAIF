// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R4B — die gemeinsame Schreibweiche.
// Run: node --experimental-strip-types test/uiparity/r4b-write-adapter.test.ts
//
// R3 hat den Befund gemacht: die gemeinsame Oberfläche erreichte KEINE der vierzig geprüften
// Fernbuchungen. Jede Schreibaktion rief direkt die Store-Aktion, und die holt als erstes
// `getDatabase()` — am Primary richtig, auf einem Rechner ohne Datenbank ein Fehler im Klick.
//
// Dieses Gate hält den neuen Vertrag fest:
//
//   §1  Der Weg ist derselbe wie beim Lesen: Formular → Vertrag → Anschluss.
//   §2  Keine zweite Geschäftslogik: die Weiche kennt weder Steuer noch Bestand noch Nummern.
//   §3  Eine klare asynchrone Grenze; `unknown` ist NIE ein Erfolg.
//   §4  Vier repräsentative Aktionen, ausschließlich über vorhandene geprüfte Namen.
//   §5  Eine Kennung je Absicht — dieselbe bei `unknown`, eine neue nach einem Urteil.
//   §6  Nicht migrierte Schreibaktionen fallen NICHT still in den lokalen Weg.
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    if (specifier === '@tauri-apps/api/core' || specifier === '@tauri-apps/api/event') {
      return { url: pathToFileURL(resolvePath(repo, 'test/bridge/_tauri-shim.ts')).href, shortCircuit: true };
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

const store = new Map<string, string>();
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

const { runSharedWrite, fehlertext, nichtAmClient, CLIENT_WRITE_UNSUPPORTED } =
  await import('../../src/core/data/shared-write.ts');
const { CommandSaveController } = await import('../../src/core/bridge/client-command-save.ts');
const { createPayload, updatePayload, CUSTOMER_EDITABLE, PRODUCT_UPDATE_FIELDS } =
  await import('../../src/core/data/write-payloads.ts');
const { enterClientMode, setClientToken, leaveClientMode } = await import('../../src/core/bridge/client-mode.ts');

// Der Wächter-Vertrag lässt sich nur prüfen, wenn dieses Fenster auch als Client eingerichtet
// ist: sonst antwortet jeder Versuch mit `not_executed`, bevor überhaupt etwas verschickt wird.
enterClientMode('http://127.0.0.1:9/');
setClientToken('test-token');

// ════════════════════════════════════════════════════════════════════════════
// §1/§2 — der Weg, und was NICHT darin steht
// ════════════════════════════════════════════════════════════════════════════
{
  const w = codeOf(src('src/core/data/shared-write.ts'));
  ok(!/SELECT |INSERT |UPDATE .*SET|getDatabase\(/i.test(w),
    '1 die Weiche fasst keine Datenbank an');
  ok(!/vat|VAT_10|invoice_number|stock_lots|posting|ledger/i.test(w),
    '2 …und kennt weder Steuer noch Nummernkreis noch Bestand noch Buchung');
  ok(/readsFromPrimary\(\)/.test(w), '1 sie entscheidet an derselben Weiche wie das Lesen');
  ok(/CommandSaveController/.test(w), '5 …und benutzt den VORHANDENEN Waechter, kein neues Kennungssystem');
  ok(!/newCommandId\(\)/.test(w), '5 …sie erzeugt selbst keine Kennung');
}

// ════════════════════════════════════════════════════════════════════════════
// §3 — die asynchrone Grenze, an beiden Anschlüssen
// ════════════════════════════════════════════════════════════════════════════
{
  // Am Primary: die vorhandene SYNCHRONE Domänenfunktion, in den asynchronen Vertrag gehoben.
  let lokalGerufen = 0, fernGerufen = 0;
  const r = await runSharedWrite<{ id: string }>(false, {
    local: () => { lokalGerufen++; return { id: 'k-1' }; },
    remote: () => { fernGerufen++; return {}; },
  }, null);
  ok(r.kind === 'ok' && r.value.id === 'k-1' && r.replayed === false,
    '3 am Primary laeuft die lokale Funktion und ihr Ergebnis ist das Ergebnis');
  ok(lokalGerufen === 1 && fernGerufen === 0,
    `3 …und der Fernweg wird dabei NICHT gebaut (${lokalGerufen}/${fernGerufen})`);
}
{
  // Ein Nein der lokalen Domäne sieht aus wie ein Nein der Ferne — dieselbe Anzeige, beide Male.
  const r = await runSharedWrite(false, {
    local: () => { const e = new Error('stock is gone'); (e as { code?: string }).code = 'NO_STOCK'; throw e; },
    remote: () => ({}),
  }, null);
  ok(r.kind === 'business_error' && r.code === 'NO_STOCK' && r.message === 'stock is gone',
    `3 eine geworfene Domaenen-Ausnahme wird zum fachlichen Nein (${r.kind}/${(r as { code?: string }).code})`);
}
{
  // Auf einem Client: der Fernweg, und NUR der.
  let lokalGerufen = 0;
  const gesendet: Array<Record<string, unknown>> = [];
  const r = await runSharedWrite<{ id: string }>(true, {
    local: () => { lokalGerufen++; return { id: 'nie' }; },
    remote: () => ({ firstName: 'Ada' }),
    shape: (v) => ({ id: String(v.customerId ?? '') }),
  }, { send: async (p) => { gesendet.push(p); return { kind: 'ok', value: { customerId: 'k-9' }, replayed: false }; } });
  ok(lokalGerufen === 0, '6 am Client wird die lokale Domaenenfunktion NIE gerufen');
  ok(gesendet.length === 1 && gesendet[0].firstName === 'Ada', '3 …der Rumpf geht genau einmal raus');
  ok(r.kind === 'ok' && r.value.id === 'k-9', '3 …und die Antwort des Primary ist das Ergebnis');
}
{
  // Die drei Nicht-Erfolge reisen unveraendert durch — vor allem `unknown`.
  for (const aus of [
    { kind: 'unknown', code: 'BRIDGE_TIMEOUT', message: 'no answer' },
    { kind: 'not_executed', code: 'NOT_AUTHENTICATED', message: 'signed out' },
    { kind: 'business_error', code: 'CUSTOMER_NOT_FOUND', message: 'no such customer' },
  ] as const) {
    let lokalGerufen = 0;
    const r = await runSharedWrite(true, {
      local: () => { lokalGerufen++; return {}; },
      remote: () => ({}),
    }, { send: async () => aus });
    ok(r.kind === aus.kind && (r as { code?: string }).code === aus.code, `3 ${aus.kind} bleibt ${aus.kind}`);
    ok(lokalGerufen === 0, `6 …und ${aus.kind} faellt NICHT auf die lokale Datenbank zurueck`);
  }
}
{
  // Der Text, den der Mensch liest: `unknown` sagt weder gespeichert noch nicht gespeichert.
  const t = fehlertext({ kind: 'unknown', code: 'BRIDGE_TIMEOUT', message: '' });
  ok(/not clear whether/i.test(t) && /again/i.test(t),
    `3 der offene Ausgang wird als offen benannt, nicht als Erfolg (${t.slice(0, 60)})`);
  ok(fehlertext({ kind: 'ok', value: null, replayed: false }) === '', '3 …und ein Erfolg hat keinen Fehlertext');
}
{
  const r = nichtAmClient('editing product images');
  ok(r.kind === 'business_error' && r.code === CLIENT_WRITE_UNSUPPORTED,
    '6 eine noch nicht migrierte Aktion meldet sich als Nein mit eigenem Code — nicht als stilles Nichts');
}

// ════════════════════════════════════════════════════════════════════════════
// §5 — eine Kennung je Absicht
// ════════════════════════════════════════════════════════════════════════════
{
  const c = new CommandSaveController<Record<string, unknown>>('customers.create');
  const a1 = c.beginAttempt();
  // Offener Ausgang: der Versuch bleibt offen, die Kennung bleibt dieselbe.
  await runSharedWrite(true, { local: () => ({}), remote: () => ({}) },
    { send: async () => ({ kind: 'unknown', code: 'BRIDGE_TIMEOUT', message: '' }) });
  const a2 = c.beginAttempt();
  ok(a1.commandId === a2.commandId, '5 nach einem offenen Ausgang bleibt es DIESELBE Kennung');
  ok(c.pendingAttempt()?.commandId === a1.commandId, '5 …und der Waechter weiss, dass sie offen ist');

  // Ein Erfolg beantwortet den Versuch — der nächste Klick ist ein neuer Vorsatz.
  await a2.send({}, (async () => ({
    ok: true, status: 200,
    json: async () => ({ ok: true, value: { customerId: 'k-1' } }),
  })) as never);
  ok(a2.isSettled(), '5 ein Erfolg beendet den Versuch');
  const a3 = c.beginAttempt();
  ok(a3.commandId !== a1.commandId, '5 …und der naechste bewusste Versuch bekommt eine NEUE Kennung');
  ok(c.pendingAttempt()?.commandId === a3.commandId, '5 …die jetzt die offene ist');
}
{
  // Ein endgültiges fachliches Nein beendet den Versuch ebenfalls.
  const c = new CommandSaveController<Record<string, unknown>>('invoices.create');
  const a = c.beginAttempt();
  await a.send({}, (async () => ({
    ok: false, status: 422,
    json: async () => ({ ok: false, error: 'NO_STOCK', message: 'gone' }),
  })) as never);
  ok(a.isSettled(), '5 ein eingefrorenes Nein beendet den Versuch');
  ok(c.beginAttempt().commandId !== a.commandId,
    '5 …und eine NEUE Entscheidung bekommt eine neue Kennung');
}
{
  // Ein beantworteter Versuch darf nie ein zweites Mal senden.
  const c = new CommandSaveController<Record<string, unknown>>('customers.create');
  const a = c.beginAttempt();
  await a.send({}, (async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: {} }) })) as never);
  let warf = false;
  try { await a.send({}); } catch { warf = true; }
  ok(warf, '5 derselbe beantwortete Versuch kann nicht erneut geschickt werden');
}

// ════════════════════════════════════════════════════════════════════════════
// §2 — die Feldlisten sind EINE Liste, nicht zwei
// ════════════════════════════════════════════════════════════════════════════
{
  const cust = src('src/core/bridge/customer-commands.ts');
  const prod = src('src/core/bridge/product-commands.ts');
  ok(/new Set<string>\(CUSTOMER_EDITABLE\)/.test(cust),
    '2 der Kundenbefehl liest die Feldliste aus der gemeinsamen Quelle');
  ok(/new Set<string>\(PRODUCT_CREATE_FIELDS\)/.test(prod) && /new Set<string>\(PRODUCT_UPDATE_FIELDS\)/.test(prod),
    '2 …und der Artikelbefehl ebenso');

  // Der Rumpf: leere Felder fahren beim Anlegen nicht mit …
  const anlegen = createPayload({ firstName: 'Ada', lastName: '', notes: undefined, preferences: [] }, CUSTOMER_EDITABLE);
  ok(JSON.stringify(anlegen) === '{"firstName":"Ada"}', `2 leere Felder fahren beim Anlegen nicht mit (${JSON.stringify(anlegen)})`);
  // … und beim Aendern faehrt NUR der Unterschied.
  const diff = updatePayload({ firstName: 'Ada', lastName: 'L', notes: 'alt' }, { firstName: 'Ada', lastName: 'Lovelace', notes: '' }, CUSTOMER_EDITABLE);
  ok(JSON.stringify(diff) === '{"lastName":"Lovelace","notes":null}',
    `2 beim Aendern faehrt nur der Unterschied — ein geleertes Feld als null (${JSON.stringify(diff)})`);
  const nichts = updatePayload({ brand: 'Zenith', attributes: { a: 1 } }, { brand: 'Zenith', attributes: { a: 1 } }, PRODUCT_UPDATE_FIELDS);
  ok(Object.keys(nichts).length === 0, '2 …und ohne Aenderung ist der Rumpf leer');
  // Eine verbotene Angabe kommt gar nicht erst in den Rumpf.
  const verboten = createPayload({ id: 'x', branchId: 'b', totalRevenue: 9, firstName: 'Ada' }, CUSTOMER_EDITABLE);
  ok(!('id' in verboten) && !('branchId' in verboten) && !('totalRevenue' in verboten),
    '2 Kennung, Filiale und Summen kommen nicht in den Rumpf');
}

// ════════════════════════════════════════════════════════════════════════════
// §4 — die vier Aktionen, und nur vorhandene Namen
// ════════════════════════════════════════════════════════════════════════════
const MIGRIERT: Array<[string, string, string, string]> = [
  ['src/pages/customers/CustomerList.tsx', 'customers.create', 'createCustomer', 'handleCreate'],
  ['src/pages/customers/CustomerDetail.tsx', 'customers.update', 'updateCustomer', 'handleSave'],
  ['src/pages/watches/ProductDetail.tsx', 'products.update', 'editProductTextDurably', 'handleSave'],
  ['src/pages/invoices/InvoiceCreate.tsx', 'invoices.create', 'createDirectInvoice', 'performSave'],
];
/** Der Rumpf EINER Funktion — von ihrem Namen bis zur naechsten Funktion derselben Ebene. */
function rumpfVon(s: string, name: string): string {
  const start = s.indexOf(`function ${name}(`);
  if (start < 0) return '';
  const rest = s.slice(start + 10);
  const ende = rest.search(/\n {2}(?:async )?function /);
  return ende < 0 ? rest : rest.slice(0, ende);
}
{
  const erlaubt = src('src/core/bridge/command-registry.ts');
  for (const [datei, op, lokal, fn] of MIGRIERT) {
    const s = codeOf(src(datei));
    ok(new RegExp(`useSharedWrite<[^>]*>\\('${op.replace('.', '\\.')}'\\)`).test(s),
      `4 ${datei.split('/').pop()} speichert ueber die gemeinsame Weiche (${op})`);
    ok(erlaubt.includes(`'${op}'`), `4 …und ${op} ist eine BEREITS freigegebene Buchung`);
    const rumpf = rumpfVon(s, fn);
    ok(rumpf.length > 100, `4 …der Speicherweg ${fn}() ist auffindbar (${rumpf.length})`);
    // Der lokale Anschluss ruft weiterhin die vorhandene Domaenenfunktion — nicht eine Kopie.
    ok(new RegExp(`local: (?:async )?\\(\\) =>[\\s\\S]{0,260}${lokal}\\(`).test(rumpf),
      `4 …und der Primary-Anschluss ruft weiterhin ${lokal}()`);
    // Und sie steht NUR dort: ohne den Anschluss kommt sie im ganzen Speicherweg nicht mehr vor.
    const ohneAnschluss = rumpf.replace(/local: [\s\S]*?(?=\n\s*remote:)/g, '');
    ok(!new RegExp(`\\b${lokal}\\(`).test(ohneAnschluss),
      `4 …und ${lokal}() steht im Speicherweg NUR im Primary-Anschluss`);
  }
}
{
  // Kein neuer Name: die Liste der Buchungen ist unveraendert vierzig.
  const erlaubt = src('src/core/bridge/command-registry.ts');
  const liste = /export const ALLOWED_MUTATIONS: readonly string\[\] = \[([\s\S]*?)\];/.exec(erlaubt)?.[1] ?? '';
  const namen = [...liste.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  ok(namen.length === 40, `4 die Liste der Buchungen zaehlt weiterhin genau vierzig (${namen.length})`);
  ok(!namen.includes('orders.convert_to_invoice_with_deposit'),
    '10 …und die Auftragsumwandlung hat KEINEN neuen halben Namen bekommen');
}
{
  // §10 — die Auftragsumwandlung wird ausdruecklich NICHT verdrahtet.
  for (const f of gehe('pages')) {
    const s = codeOf(src('src/' + f));
    ok(!/useSharedWrite<[^>]*>\('orders\.convert_to_invoice'\)/.test(s),
      `10 ${f} verdrahtet die Auftragsumwandlung nicht`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// §6 — was NICHT migriert ist, faellt nicht still in den lokalen Weg
// ════════════════════════════════════════════════════════════════════════════
function gehe(root: string): string[] {
  const out: string[] = [];
  (function w(d: string) {
    for (const e of readdirSync(resolvePath(repo, 'src/' + d), { withFileTypes: true })) {
      const p = d + '/' + e.name;
      if (e.isDirectory()) { w(p); continue; }
      if (/\.tsx?$/.test(e.name)) out.push(p);
    }
  })(root);
  return out;
}
{
  // Jede schreibende Store-Aktion holt als ERSTES die Datenbank. Auf einem Rechner ohne
  // Datenbank wirft `getDatabase()` — laut, nicht still. Genau das ist der harte Riegel unter
  // allem, was noch nicht migriert ist: es gibt keinen Weg, der leise nichts tut.
  const dateien = readdirSync(resolvePath(repo, 'src/stores')).filter((f) => f.endsWith('.ts'));
  let geprueft = 0; const ohne: string[] = [];
  for (const f of dateien) {
    const s = codeOf(src('src/stores/' + f));
    for (const m of s.matchAll(/^ {2}(create|update|delete|record|add|remove|cancel|convert|apply|edit|mark|insert)[A-Za-z0-9_]*: \(?[^\n]*\) => \{([\s\S]*?)\n {2}\},/gm)) {
      const koerper = m[2];
      // Nur Aktionen, die wirklich schreiben.
      if (!/\bdb\.run\(|\bgetDatabase\(|\bquery\(/.test(koerper)) continue;
      geprueft++;
      if (!/getDatabase\(\)|withTransaction|beginLedgerTransaction|query\(/.test(koerper)) ohne.push(f + ':' + m[1]);
    }
  }
  ok(geprueft > 40, `6 der Riegel wurde an ${geprueft} schreibenden Store-Aktionen geprueft`);
  ok(ohne.length === 0,
    `6 keine schreibende Store-Aktion kommt ohne Datenbank aus — auf einem Client wirft sie (${ohne.join(', ') || 'keine'})`);
}
{
  // Die migrierten Seiten duerfen auf dem Client-Weg nichts Lokales anfassen.
  for (const [datei] of MIGRIERT) {
    const s = codeOf(src(datei));
    ok(!/remote: \(\) => \{[\s\S]{0,400}(createCustomer|updateCustomer|createDirectInvoice|editProductTextDurably|editProductWithMedia|recordPayment)\(/.test(s),
      `6 ${datei.split('/').pop()}: der Fernweg baut nur einen Rumpf, er schreibt nichts lokal`);
  }
  // Der Bildweg und der Aenderungsweg der Rechnung sind ausdruecklich gesperrt, nicht still.
  const prod = codeOf(src('src/pages/watches/ProductDetail.tsx'));
  ok(/aendern\.remote[\s\S]{0,200}nichtAmClient\('editing product images'\)/.test(prod),
    '6 der Bildweg meldet sich am Client als nicht verfuegbar');
  const inv = codeOf(src('src/pages/invoices/InvoiceCreate.tsx'));
  ok(/anlegen\.remote && isEditMode[\s\S]{0,120}nichtAmClient/.test(inv),
    '6 das Aendern einer Rechnung ebenso');
  ok(/anlegen\.remote && paidAmount > 0[\s\S]{0,160}nichtAmClient/.test(inv),
    '6 …und eine Zahlung beim Anlegen ebenso — sie waere sonst Geld, das liegen bleibt');
}

// ════════════════════════════════════════════════════════════════════════════
// §9 — dieselben Masken, keine Client-Fassung
// ════════════════════════════════════════════════════════════════════════════
{
  const app = codeOf(src('src/App.tsx'));
  ok(/if \(!session\) \{[\s\S]{0,200}<ClientShell/.test(app),
    '9 die Client-Huelle fuehrt nur bis zur Anmeldung');
  // Nach der Anmeldung laeuft dieselbe Anwendung: keine Route zeigt ein Client-Formular.
  const clientForms = readdirSync(resolvePath(repo, 'src/components/client'))
    .filter((f) => /^Client[A-Z].*\.tsx$/.test(f)).map((f) => f.replace('.tsx', ''));
  let benutzt: string[] = [];
  for (const f of [...gehe('pages'), 'App.tsx']) {
    const s = codeOf(src('src/' + f));
    benutzt = benutzt.concat(clientForms.filter((c) => new RegExp('<' + c + '\\b').test(s)));
  }
  ok(benutzt.length === 0, `9 keine Seite zeichnet eine Client-Fassung eines Formulars (${benutzt.join(', ') || 'keine'})`);
  for (const [datei] of MIGRIERT) {
    ok(!/isClientMode\(\)/.test(codeOf(src(datei))),
      `9 ${datei.split('/').pop()} fragt nicht selbst nach der Betriebsart — der Unterschied liegt hinter der Weiche`);
  }
}

leaveClientMode();
console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central ui parity r4b: shared write adapter: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R4B_WRITE_CALLPATH_AUDITED');
console.log('CENTRAL_UI_R4B_SHARED_WRITE_ADAPTER_PROVED');
console.log('CENTRAL_UI_R4B_ASYNC_COMMAND_BOUNDARY_PROVED');
console.log('CENTRAL_UI_R4B_REPRESENTATIVE_WRITES_PROVED');
console.log('CENTRAL_UI_R4B_UI_COMMAND_IDEMPOTENCY_PROVED');
console.log('CENTRAL_UI_R4B_NO_CLIENT_LOCAL_WRITE_PROVED');
console.log('CENTRAL_UI_R4B_SHARED_FORM_PARITY_PROVED');
