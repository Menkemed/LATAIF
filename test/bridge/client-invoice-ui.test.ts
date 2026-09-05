// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-C3B — das Rechnungsformular des Clients: ohne Datenbank, ohne eigene Rechnung.
// Run: node test/bridge/client-invoice-ui.test.ts
//
// Drei Zusagen, die man einer Oberfläche nicht ansieht:
//
//   • Sie öffnet KEINE lokale Geschäftsdatenbank — auch nicht über drei Ecken. Geprüft wird der
//     ganze Importbaum, nicht die eine Datei.
//   • Sie schickt NICHTS Abgeleitetes. Was sie baut, wird hier gegen den echten Prüfer des Primary
//     gehalten: was durchgeht, ist genau die Auswahl eines Menschen.
//   • Eine Kennung gehört zum Vorsatz. Eine Zeitgrenze erzeugt keine zweite Rechnung — nicht durch
//     einen zweiten Klick und nicht durch einen automatischen Wiederholungsversuch.
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    // Der ECHTE Pruefer des Primary (`invoice-command`) zieht die Datenschicht mit; nur seine
    // Datenbankquelle wird gestellt. Das Client-Formular selbst kommt hier NIE vorbei — genau das
    // prueft Abschnitt 1.
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

const memory = new Map<string, string>();
const storage = {
  getItem: (k: string) => (memory.has(k) ? memory.get(k)! : null),
  setItem: (k: string, v: string) => { memory.set(k, String(v)); },
  removeItem: (k: string) => { memory.delete(k); },
};
(globalThis as { window?: unknown }).window = { localStorage: storage };
(globalThis as { localStorage?: unknown }).localStorage = storage;

const cm = await import('../../src/core/bridge/client-mode.ts');
const { remoteFormSource, customerLabel, productLabel } = await import('../../src/core/invoices/invoice-form-source.ts');
const { buildInvoiceRequest } = await import('../../src/core/invoices/invoice-request.ts');
const { InvoiceSaveController } = await import('../../src/core/bridge/client-invoice-save.ts');
const { parseInvoicePayload } = await import('../../src/core/bridge/invoice-command.ts');
const registry = await import('../../src/core/bridge/command-registry.ts');
await import('../../src/core/bridge/read-commands.ts');
await import('../../src/core/bridge/invoice-command.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
/** Derselbe Text ohne Kommentare: ein Satz, der etwas ERKLAERT, ist kein Aufruf. */
const code = (p: string): string => src(p)
  .split(/\r?\n/)
  .filter((l) => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')); })
  .join('\n');

const FORM = 'src/components/client/ClientInvoiceCreate.tsx';
const SOURCE = 'src/core/invoices/invoice-form-source.ts';

// ── 1) Kein Weg zur lokalen Datenbank — im ganzen Importbaum ──────────────
//
// Eine einzelne Datei zu greppen waere zu wenig: ein Import drei Ebenen tiefer wuerde die Datenbank
// genauso oeffnen. Deshalb wird der Baum abgelaufen.
{
  const seen = new Set<string>();
  const offenders: string[] = [];
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(resolvePath(repo, file), 'utf8');
    const code = text.split(/\r?\n/).filter((l) => {
      const t = l.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    }).join('\n');
    if (/\bgetDatabase\b|\binitDatabase\b|useProductStore|useCustomerStore|useInvoiceStore|useOrderStore|useEmployeeStore/.test(code)) {
      offenders.push(file);
    }
    for (const m of code.matchAll(/from '(@\/[^']+)'/g)) {
      const rel = 'src/' + m[1].slice(2);
      for (const cand of [rel, rel + '.ts', rel + '.tsx']) {
        if (existsSync(resolvePath(repo, cand)) && /\.(ts|tsx)$/.test(cand)) { visit(cand); break; }
      }
    }
  };
  visit(FORM);
  visit(SOURCE);

  ok(seen.size > 3, `DBLESS der Importbaum wurde wirklich abgelaufen (${seen.size} Dateien)`);
  ok(offenders.length === 0, `DBLESS nirgends darin wird die lokale Datenbank oder ein Business-Store benutzt (${offenders.join(', ') || 'keine'})`);
  ok([...seen].every((f) => !f.startsWith('src/core/db/')), `DBLESS und keine Datei aus der Datenschicht ist dabei (${[...seen].filter((f) => f.startsWith('src/core/db/')).join(', ') || 'keine'})`);

  const form = src(FORM);
  ok(!/outbox|localStorage|indexedDB/i.test(form), 'DBLESS das Formular legt auch keinen eigenen Ausgangskorb an');
  ok(/remoteFormSource|InvoiceFormSource/.test(form), 'DBLESS seine Daten kommen aus der Fernquelle');
}

// ── 2) Die Auswahllisten kommen aus den bestehenden C2-Lesevorgaengen ─────
{
  cm.enterClientMode('https://primary.local');
  cm.setClientToken('tok');

  const calls: Array<{ op: string; payload: unknown }> = [];
  const fakeFetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { op: string; payload: unknown };
    calls.push({ op: body.op, payload: body.payload });
    const items = body.op === 'customers.list'
      ? [{ id: 'c1', firstName: 'Ali', lastName: 'Hassan', company: 'Lataif', phone: '+973' }]
      : [{ id: 'p1', brand: 'Rolex', name: 'Datejust', sku: 'RLX-1', plannedSalePrice: 150, purchasePrice: 100, taxScheme: 'MARGIN', quantity: 1, stockStatus: 'in_stock' }];
    return { status: 200, ok: true, json: async () => ({ ok: true, value: { items } }) };
  }) as unknown as typeof fetch;

  // Die ECHTE Quelle, nur mit gestelltem Transport.
  const original = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = fakeFetch;
  const source = remoteFormSource();
  const customers = await source.searchCustomers('');
  const products = await source.searchProducts('');
  (globalThis as { fetch: typeof fetch }).fetch = original;

  ok(calls.map((c) => c.op).join(',') === 'customers.list,products.list',
    `READS genau die bestehenden Lesevorgaenge (${calls.map((c) => c.op).join(',')})`);
  ok(customers[0].label === 'Ali Hassan — Lataif', `READS der Kunde wird lesbar benannt (${customers[0].label})`);
  ok(products[0].label === 'Rolex Datejust' && products[0].taxScheme === 'MARGIN' && products[0].quantity === 1,
    `READS das Produkt bringt Schema und Menge mit (${JSON.stringify(products[0])})`);
  ok(!('purchasePrice' in products[0]),
    'READS …aber keine Einstandskosten — die gehen den Client nichts an');
  ok(customerLabel({ id: 'x' }) === 'x' && productLabel({ id: 'y' }) === 'y',
    'READS und ohne Namen bleibt wenigstens die Kennung stehen');

  // Kein neuer Lesebefehl war noetig.
  const reads = src('src/core/bridge/read-commands.ts');
  ok((reads.match(/^registerCommand\(/gm) || []).length === 6,
    'READS es sind weiterhin sechs Lesevorgaenge — das Formular brauchte keinen neuen');
}

// ── 3) Was das Formular schickt, ist genau das, was der Primary erlaubt ───
//
// Der stärkste verfügbare Beweis: der ECHTE Prüfer des Primary bekommt den Rumpf, den die
// Oberfläche baut. Kein abgeleiteter Wert kommt durch — nicht, weil es niemand hinschreibt,
// sondern weil er abgewiesen würde.
{
  const request = buildInvoiceRequest({
    customerId: 'c1',
    issuedDate: '2026-09-05',
    notes: '  ',
    lines: [{ productId: 'p1', quantity: 2.7, unitPrice: 150 }],
  });
  const keys = Object.keys(request).sort().join(',');
  ok(keys === 'customerId,issuedDate,lines', `REQUEST nur Auswahl, nichts Abgeleitetes (${keys})`);
  const lineKeys = Object.keys((request.lines as Array<Record<string, unknown>>)[0]).sort().join(',');
  ok(lineKeys === 'productId,quantity,scheme,unitPrice', `REQUEST auch in der Zeile (${lineKeys})`);
  ok((request.lines as Array<{ quantity: number }>)[0].quantity === 2, 'REQUEST eine Menge ist eine ganze Zahl');
  ok(!('notes' in request), 'REQUEST eine leere Notiz wird gar nicht erst mitgeschickt');
  ok((request.lines as Array<{ scheme: string }>)[0].scheme === 'auto',
    'REQUEST das Steuerschema entscheidet das Produkt, nicht der Client');

  // Und der echte Pruefer nimmt ihn an.
  const parsed = parseInvoicePayload(request);
  ok(parsed.customerId === 'c1' && parsed.lines[0].productId === 'p1' && parsed.lines[0].quantity === 2,
    'REQUEST der Pruefer des Primary nimmt genau diesen Rumpf an');

  // Ein Formular, das doch etwas Abgeleitetes mitschickte, kaeme nicht durch.
  for (const extra of ['grossAmount', 'invoiceNumber', 'branchId', 'numbering']) {
    let threw = false;
    try { parseInvoicePayload({ ...request, [extra]: 1 }); } catch { threw = true; }
    ok(threw, `REQUEST ${extra} wuerde abgewiesen`);
  }
}

// ── 4) Der Speichervertrag am echten Knopf ────────────────────────────────
{
  const reply = (status: number, body: Record<string, unknown>): Response =>
    ({ status, ok: status >= 200 && status < 300, json: async () => body }) as unknown as Response;

  const ctl = new InvoiceSaveController();
  const first = ctl.beginAttempt();
  const id = first.commandId;
  const sent: string[] = [];
  const capture = (async (_u: string, init: { body: string }) => {
    sent.push((JSON.parse(init.body) as { commandId: string }).commandId);
    return reply(504, {});
  }) as unknown as typeof fetch;

  const pending = await first.send(buildInvoiceRequest({ customerId: 'c1', issuedDate: '2026-09-05', lines: [{ productId: 'p1', quantity: 1, unitPrice: 150 }] }), capture);
  ok(pending.kind === 'unknown', `SAVE die Zeitgrenze laesst den Ausgang offen (${JSON.stringify(pending)})`);

  // Der zweite Klick — genau der Moment, in dem eine Oberflaeche eine zweite Rechnung schreibt.
  const again = ctl.beginAttempt();
  ok(again.commandId === id, 'SAVE ein zweiter Klick benutzt DIESELBE Kennung');
  const settled = await again.send(buildInvoiceRequest({ customerId: 'c1', issuedDate: '2026-09-05', lines: [{ productId: 'p1', quantity: 1, unitPrice: 150 }] }),
    (async () => reply(200, { ok: true, value: { invoiceId: 'inv-1', invoiceNumber: 'PINV-2026-000001', grossAmount: 165, replayed: true } })) as unknown as typeof fetch);
  ok(settled.kind === 'ok' && settled.replayed === true && settled.invoiceNumber === 'PINV-2026-000001',
    `SAVE …und bekommt die eine Rechnung des Primary (${JSON.stringify(settled)})`);
  ok(ctl.beginAttempt().commandId !== id, 'SAVE erst danach beginnt ein neuer Vorsatz');

  // Ein fachliches Nein beendet den Versuch; der naechste bewusste Save ist ein neuer.
  // WICHTIG: der Primary schickt es als 409 — GENAU wie den Kennungskonflikt. Unterschieden werden
  // die beiden am Feld `outcome`, das nur die Bruecke setzt. Wer hier nur auf den Status schaut,
  // erzaehlt dem Benutzer bei „die Ware ist weg", er duerfe es gefahrlos nochmal versuchen.
  const ctl2 = new InvoiceSaveController();
  const a2 = ctl2.beginAttempt();
  const no = await a2.send({}, (async () => reply(409, { ok: false, error: 'STOCK_UNAVAILABLE', message: 'weg' })) as unknown as typeof fetch);
  ok(no.kind === 'business_error' && no.code === 'STOCK_UNAVAILABLE',
    `SAVE ein 409 OHNE outcome ist das fachliche Nein (${JSON.stringify(no)})`);
  ok(ctl2.beginAttempt().commandId !== a2.commandId,
    'SAVE eine abgelehnte Kennung wird NICHT wiederverwendet');

  const ctl3 = new InvoiceSaveController();
  const a3 = ctl3.beginAttempt();
  const clash = await a3.send({}, (async () => reply(409, { ok: false, error: 'BRIDGE_COMMAND_ID_CONFLICT', outcome: 'not_executed' })) as unknown as typeof fetch);
  ok(clash.kind === 'not_executed',
    `SAVE ein 409 MIT outcome ist der Kennungskonflikt — er lief nie (${JSON.stringify(clash)})`);

  // Und die Oberflaeche selbst haelt sich daran. Fuer die Verbote wird der Text OHNE Kommentare
  // gelesen: ein Satz, der erklaert, warum hier kein `new InvoiceSaveAttempt()` steht, ist kein
  // Aufruf — er wuerde die Pruefung sonst rot faerben, obwohl der Code richtig ist.
  const form = src(FORM);
  const formCode = code(FORM);
  ok(/controller\.beginAttempt\(\)/.test(formCode) && !/new InvoiceSaveAttempt\(/.test(formCode),
    'SAVE das Formular vergibt keine Kennung an der Wache vorbei');
  ok(/data-client-invoice-pending/.test(form) && /not known/.test(form),
    'SAVE es sagt dem Benutzer, dass der Ausgang offen ist');
  ok(/Retry the same order/.test(form), 'SAVE …und dass Wiederholen denselben Auftrag prueft');
  ok(/disabled=\{pending\}/.test(form), 'SAVE waehrend ein Ausgang offen ist, wird die Eingabe nicht veraendert');
  ok(/data-client-invoice-number/.test(form) && /outcome\.invoiceNumber/.test(form),
    'SAVE und angezeigt wird die Nummer des Primary, keine eigene');
  ok(!/setTimeout|setInterval/.test(formCode), 'SAVE es gibt keinen automatischen zweiten Versuch');
}

// ── 5) Die Zulassungsliste ist unveraendert ───────────────────────────────
{
  const known = registry.knownCommands();
  const reads = known.filter((o) => o.endsWith('.list') || o.endsWith('.get'));
  ok(known.length === 8 && reads.length === 6
    && known.includes('bridge.probe') && known.includes('invoices.create'),
    `REGISTRY 1 Probe + 6 Reads + 1 Mutation (${known.join(', ')})`);
  ok(registry.ALLOWED_MUTATIONS.length === 1,
    `REGISTRY das Formular hat keine zweite Mutation gebraucht (${registry.ALLOWED_MUTATIONS.join(', ')})`);
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central c3b client invoice ui: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
console.log('CENTRAL_C3B_CLIENT_INVOICE_DBLESS_PROVED');
console.log('CENTRAL_C3B_CLIENT_INVOICE_SAVE_UX_PROVED');
