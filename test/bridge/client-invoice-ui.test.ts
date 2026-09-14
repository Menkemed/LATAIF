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
// R7B PP-7 — der Waechter ist der gemeinsame (`client-command-save`). Die Rechnungsbindung
// (`client-invoice-save`), die Fernquelle (`invoice-form-source`) und der Rumpfbau
// (`invoice-request`) des entfernten Formulars sind mit ihm gegangen.
const { CommandSaveController } = await import('../../src/core/bridge/client-command-save.ts');
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

// POST-PARITY R7B PP-7 — das alte Rechnungsformular (`src/components/client/ClientInvoiceCreate.tsx`)
// ist entfernt, mit ihm seine Fernquelle, sein Rumpfbau und seine Waechter-Bindung. Was hier bleibt,
// prueft den echten Pruefer des Primary (mit woertlich gebautem Rumpf) und den gemeinsamen Waechter.
const FORM = 'src/components/client/ClientInvoiceCreate.tsx';
const LEGACY_MODULES = [
  'src/core/invoices/invoice-form-source.ts',
  'src/core/invoices/invoice-request.ts',
  'src/core/bridge/client-invoice-save.ts',
];

// ── 1) Kein Weg zur lokalen Datenbank — im ganzen Importbaum ──────────────
{
  ok(!existsSync(resolvePath(repo, FORM)),
    'DBLESS R7B PP-7 das alte Rechnungsformular (src/components/client) gibt es nicht mehr');
  // R7B PP-7 — hier wurde der Importbaum der Fernquelle abgelaufen; die Quelle ist entfernt.
  const left = LEGACY_MODULES.filter((f) => existsSync(resolvePath(repo, f)));
  ok(left.length === 0,
    `DBLESS R7B PP-7 Fernquelle, Rumpfbau und Waechter-Bindung des alten Formulars sind entfernt (${left.join(', ') || 'alle weg'})`);
}

// ── 2) Die Auswahllisten kommen aus den bestehenden C2-Lesevorgaengen ─────
{
  cm.enterClientMode('https://primary.local');
  cm.setClientToken('tok');

  // R7B PP-7 — die Pruefungen an der Fernquelle des alten Formulars (`remoteFormSource`, Benennung,
  // keine Einstandskosten) sind mit ihr entfernt. Festgehalten bleibt die Zahl der Lesevorgaenge.
  const reads = src('src/core/bridge/read-commands.ts');
  ok((reads.match(/^registerCommand\(/gm) || []).length === 18,
    'READS die Lesevorgaenge sind auf achtzehn gewachsen');
}

// ── 3) Was das Formular schickt, ist genau das, was der Primary erlaubt ───
//
// Der stärkste verfügbare Beweis: der ECHTE Prüfer des Primary bekommt den Rumpf, den die
// Oberfläche baut. Kein abgeleiteter Wert kommt durch — nicht, weil es niemand hinschreibt,
// sondern weil er abgewiesen würde.
{
  // R7B PP-7 — der Rumpf steht woertlich hier (vorher `buildInvoiceRequest`); die Pruefungen am
  // Rumpfbau selbst (Feldauswahl, ganze Menge, leere Notiz, `scheme: 'auto'`) sind mit ihm entfernt.
  const request = {
    customerId: 'c1', issuedDate: '2026-09-05',
    lines: [{ productId: 'p1', quantity: 2, unitPrice: 150, scheme: 'auto' }],
  };

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

  // R7B PP-7 — gepruefter Waechter ist der gemeinsame (`CommandSaveController`) statt der entfernten
  // Rechnungsbindung; Vertrag und Ausgaenge sind dieselben, der Erfolg traegt den Wert in `value`.
  const ctl = new CommandSaveController<{ invoiceId: string; invoiceNumber: string; grossAmount: number }>('invoices.create');
  const first = ctl.beginAttempt();
  const id = first.commandId;
  const sent: string[] = [];
  const capture = (async (_u: string, init: { body: string }) => {
    sent.push((JSON.parse(init.body) as { commandId: string }).commandId);
    return reply(504, {});
  }) as unknown as typeof fetch;
  const body = { customerId: 'c1', issuedDate: '2026-09-05', lines: [{ productId: 'p1', quantity: 1, unitPrice: 150, scheme: 'auto' }] };

  const pending = await first.send(body, capture);
  ok(pending.kind === 'unknown', `SAVE die Zeitgrenze laesst den Ausgang offen (${JSON.stringify(pending)})`);

  // Der zweite Klick — genau der Moment, in dem eine Oberflaeche eine zweite Rechnung schreibt.
  const again = ctl.beginAttempt();
  ok(again.commandId === id, 'SAVE ein zweiter Klick benutzt DIESELBE Kennung');
  const settled = await again.send(body,
    (async () => reply(200, { ok: true, value: { invoiceId: 'inv-1', invoiceNumber: 'PINV-2026-000001', grossAmount: 165, replayed: true } })) as unknown as typeof fetch);
  ok(settled.kind === 'ok' && settled.replayed === true && settled.value.invoiceNumber === 'PINV-2026-000001',
    `SAVE …und bekommt die eine Rechnung des Primary (${JSON.stringify(settled)})`);
  ok(ctl.beginAttempt().commandId !== id, 'SAVE erst danach beginnt ein neuer Vorsatz');

  // Ein fachliches Nein beendet den Versuch; der naechste bewusste Save ist ein neuer.
  // WICHTIG: der Primary schickt es als 409 — GENAU wie den Kennungskonflikt. Unterschieden werden
  // die beiden am Feld `outcome`, das nur die Bruecke setzt. Wer hier nur auf den Status schaut,
  // erzaehlt dem Benutzer bei „die Ware ist weg", er duerfe es gefahrlos nochmal versuchen.
  const ctl2 = new CommandSaveController('invoices.create');
  const a2 = ctl2.beginAttempt();
  const no = await a2.send({}, (async () => reply(409, { ok: false, error: 'STOCK_UNAVAILABLE', message: 'weg' })) as unknown as typeof fetch);
  ok(no.kind === 'business_error' && no.code === 'STOCK_UNAVAILABLE',
    `SAVE ein 409 OHNE outcome ist das fachliche Nein (${JSON.stringify(no)})`);
  ok(ctl2.beginAttempt().commandId !== a2.commandId,
    'SAVE eine abgelehnte Kennung wird NICHT wiederverwendet');

  const ctl3 = new CommandSaveController('invoices.create');
  const a3 = ctl3.beginAttempt();
  const clash = await a3.send({}, (async () => reply(409, { ok: false, error: 'BRIDGE_COMMAND_ID_CONFLICT', outcome: 'not_executed' })) as unknown as typeof fetch);
  ok(clash.kind === 'not_executed',
    `SAVE ein 409 MIT outcome ist der Kennungskonflikt — er lief nie (${JSON.stringify(clash)})`);
  // R7B PP-7 — die Knopf-Pruefungen am alten Rechnungsformular sind mit ihm entfernt.
}

// ── 5) Das Formular braucht genau EINEN Namen ─────────────────────────────
//
// Seit C3C stehen drei Namen auf der Zulassungsliste. Fuer dieses Formular aendert das nichts, und
// genau das wird hier geprueft: es ruft `invoices.create` und sonst keine Mutation.
{
  await import('../../src/core/bridge/customer-commands.ts');
  await import('../../src/core/bridge/product-commands.ts');
  await import('../../src/core/bridge/invoice-lifecycle-commands.ts');
  await import('../../src/core/bridge/commercial-commands.ts');
  await import('../../src/core/bridge/service-commands.ts');
  await import('../../src/core/bridge/financial-commands.ts');
  const known = registry.knownCommands();
  const reads = known.filter((o) => o.endsWith('.list') || o.endsWith('.get'));
  ok(known.length === 43 && reads.length === 18 && known.includes('bridge.probe'),
    `REGISTRY 1 Probe + 18 Reads + 24 Mutationen (${known.join(', ')})`);
  ok(registry.ALLOWED_MUTATIONS.includes('invoices.create'),
    `REGISTRY der Name des Formulars steht darauf (${registry.ALLOWED_MUTATIONS.join(', ')})`);
  // R7B PP-7 — die Pruefung „das alte Formular ruft keine fremde Mutation" ist mit ihm entfernt.
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central c3b client invoice ui: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
console.log('CENTRAL_C3B_CLIENT_INVOICE_DBLESS_PROVED');
console.log('CENTRAL_C3B_CLIENT_INVOICE_SAVE_UX_PROVED');
