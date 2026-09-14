// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-C3E — die drei Handelsformulare des Clients, ohne Datenbank.
// Run: node test/bridge/client-commercial-ui.test.ts
//
// Vier Zusagen, die man einer Oberfläche nicht ansieht:
//
//   • Sie öffnen KEINE lokale Geschäftsdatenbank — auch nicht drei Importe tief.
//   • Was sie schicken, hält der ECHTE Prüfer des Primary aus: keine Summe, keine Nummer, kein
//     Rest, keine Marge — und beim Ändern nur das, was ein Mensch wirklich angefasst hat.
//   • Eine Kennung gehört zum VORSATZ. Eine Zeitgrenze erzeugt keinen zweiten Einkauf.
//   • Für einen Einkauf gibt es kein Änderungsformular, weil es im Haus keine Bearbeitung gibt.
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    // Der ECHTE Prüfer des Primary zieht die Datenschicht mit; nur seine Datenbankquelle wird
    // gestellt. Die Formulare selbst kommen hier NIE vorbei — genau das prüft Abschnitt 1.
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
      for (const cand of [p, p + '.ts', p + '.tsx']) {
        if (existsSync(cand)) return { url: pathToFileURL(cand).href, shortCircuit: true };
      }
      return { url: pathToFileURL(p + '.ts').href, shortCircuit: true };
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
const { CommandSaveController } = await import('../../src/core/bridge/client-command-save.ts');
// Und der ECHTE Prüfer des Primary — nicht eine Nachbildung davon.
const cmd = await import('../../src/core/bridge/commercial-commands.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
/** Derselbe Text ohne Kommentare: ein Satz, der etwas ERKLÄRT, ist kein Aufruf. */
const code = (p: string): string => src(p)
  .split(/\r?\n/)
  .filter((l) => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')); })
  .join('\n');

// POST-PARITY R7B PP-7 — die drei alten Handelsformulare (`src/components/client/Client{Purchase,
// Consignment,Order}Form.tsx`), die Bereiche der alten Huelle und ihr Rumpfbau
// (`client-commercial-request.ts`) sind entfernt. Was hier bleibt, prueft den echten Pruefer des
// Primary (mit woertlich gebauten Ruempfen) und den Waechter.
const REQ = 'src/core/bridge/client-commercial-request.ts';
/** Der echte Pruefer nimmt den Rumpf an — ein Wurf ist ein roter Check, kein Absturz. */
const accepts = (f: () => unknown, m: string): void => {
  let why = '';
  try { f(); } catch (e) { why = String(e); }
  ok(why === '', `${m} (${why || 'ok'})`);
};

// ── 1) Kein Weg zur lokalen Datenbank — im ganzen Importbaum ──────────────
{
  ok(!existsSync(resolvePath(repo, 'src/components/client')),
    'DBLESS R7B PP-7 die alten Handelsformulare (src/components/client) gibt es nicht mehr');
  ok(!existsSync(resolvePath(repo, REQ)),
    'DBLESS R7B PP-7 ihr Rumpfbau (client-commercial-request) ist mit ihnen entfernt');
}

// ── 2) Für einen Einkauf gibt es kein Änderungsformular ───────────────────
{
  // Die Zusage dahinter lebt weiter: es gibt im Haus keine Einkaufs-Bearbeitung, also auch keine
  // freigegebene Buchung dafuer.
  const { ALLOWED_MUTATIONS } = await import('../../src/core/bridge/command-registry.ts');
  ok(!ALLOWED_MUTATIONS.includes('purchases.update'),
    'SCOPE es gibt keine Einkaufs-Bearbeitung — den Vertrag gibt es im Haus nicht');
}

// ── 3) Was das Einkaufsformular schickt, hält der echte Prüfer aus ────────
{
  // R7B PP-7 — der Rumpf steht woertlich hier (vorher gebaut von `purchaseCreateRequest`); die
  // Pruefungen am Rumpfbau selbst (Zeilenfilter, Feldauswahl, Vorschau, Vollstaendigkeit) sind mit
  // ihm entfernt.
  const body = {
    supplierId: 'sup-1', taxScheme: 'VAT_10', purchaseDate: '2026-09-07', notes: 'zweiter Rechner',
    lines: [{ productId: 'p1', quantity: 2, unitPrice: 100 }],
    initialPayment: { amount: 50, method: 'bank' },
  };
  const parsed = cmd.parsePurchaseCreate(body);
  ok(parsed.lines.length === 1, `REQUEST die Position kommt beim echten Pruefer an (${parsed.lines.length})`);
  ok(parsed.initialPayment?.amount === 50, 'REQUEST die Anzahlung kommt an');

  // Ohne Zahlungsfeld keine Zahlung.
  const { initialPayment: _unused, ...noPay } = body;
  ok(!cmd.parsePurchaseCreate(noPay).initialPayment, 'REQUEST ohne Zahlungsfeld macht der Pruefer keine Zahlung daraus');
}

// ── 4) Kommission: anlegen und ändern ─────────────────────────────────────
{
  // R7B PP-7 — die Ruempfe stehen woertlich hier (vorher `consignmentCreateRequest`/
  // `consignmentUpdateRequest`); die Pruefungen an Modell-Aufteilung, Sperre und Unterschiedsbildung
  // des Rumpfbaus sind mit ihm entfernt.
  const body = {
    consignorId: 'cust-1', product: { brand: 'Patek', name: 'Nautilus', categoryId: 'cat-w' },
    agreedPrice: 1000, payout: { model: 'percent', commissionRate: 20 },
  };
  accepts(() => cmd.parseConsignmentCreate(body), 'REQUEST der echte Pruefer nimmt die Anlage an');

  // Ändern: nur der Unterschied, mit der gelesenen Fassung.
  accepts(() => cmd.parseConsignmentUpdate({ id: 'c1', expectedRevision: 7, notes: 'neu' }),
    'REQUEST der echte Pruefer nimmt die reine Notizaenderung an');
  accepts(() => cmd.parseConsignmentUpdate({
    id: 'c1', expectedRevision: 7, notes: 'neu', payout: { model: 'cost_split', excessSplitPct: 60 },
  }), 'PAYOUT …und ein offenes Modell vollstaendig');
}

// ── 5) Auftrag: anlegen und ändern ────────────────────────────────────────
{
  // R7B PP-7 — woertliche Ruempfe statt `orderCreateRequest`/`orderUpdateRequest`; die Pruefungen an
  // deren Feldauswahl (Kartenmarke, weggelassene Zahlungsart) sind mit ihnen entfernt.
  accepts(() => cmd.parseOrderCreate({
    customerId: 'cust-1', lines: [{ productId: 'p1', quantity: 2, unitPrice: 300 }],
    depositAmount: 200, paymentMethod: 'cash',
  }), 'REQUEST der echte Pruefer nimmt den Auftrag an');

  // Ändern: nur der Unterschied, und die Fassung.
  accepts(() => cmd.parseOrderUpdate({ id: 'o1', expectedRevision: 4, agreedPrice: 700 }),
    'REQUEST der echte Pruefer nimmt die Aenderung an (Zahl als Zahl, Fassung unveraendert)');

  // Ein geleertes Feld heißt „kein Wert", nicht 0 — der Unterschied ist Geld.
  accepts(() => cmd.parseOrderUpdate({ id: 'o1', expectedRevision: 4, supplierPrice: null }),
    'REQUEST …und ein geleertes Zahlenfeld als „kein Wert"');
}

// ── 6) Eine Kennung pro Vorsatz ───────────────────────────────────────────
{
  cm.enterClientMode('https://primary.local');
  cm.setClientToken('tok');

  const controller = new CommandSaveController('purchases.create');
  const a1 = controller.beginAttempt();
  // Zeitgrenze: der Ausgang ist offen, der Versuch bleibt es auch.
  const timeout = await a1.send({ x: 1 }, (async () => ({
    status: 504, ok: false, json: async () => ({}),
  })) as never);
  ok(timeout.kind === 'unknown', `IDS eine Zeitgrenze ist ein offener Ausgang (${timeout.kind})`);
  ok(controller.beginAttempt().commandId === a1.commandId,
    'IDS ein zweiter Klick benutzt DIESELBE Kennung — kein zweiter Einkauf');

  // Ein endgültiges fachliches Nein beendet den Versuch.
  const a2 = controller.beginAttempt();
  const no = await a2.send({ x: 1 }, (async () => ({
    status: 422, ok: false, json: async () => ({ error: 'PAYMENT_EXCEEDS_TOTAL', message: 'zu viel' }),
  })) as never);
  ok(no.kind === 'business_error', `IDS ein frozen Nein ist ein Nein (${no.kind})`);
  const a3 = controller.beginAttempt();
  ok(a3.commandId !== a2.commandId, 'IDS …und der nächste bewusste Versuch bekommt eine NEUE Kennung');

  // Erfolg ebenso.
  const okRes = await a3.send({ x: 1 }, (async () => ({
    status: 200, ok: true, json: async () => ({ ok: true, value: { purchaseId: 'p', replayed: false } }),
  })) as never);
  ok(okRes.kind === 'ok', 'IDS ein Erfolg beendet den Versuch');
  ok(controller.beginAttempt().commandId !== a3.commandId, 'IDS …und der nächste ist ein neuer');
}

// ── 7) Die Oberfläche kennt die Bereiche — und nur die Lesevorgänge ───────
{
  ok(!/DETAIL_OPS|data-client-area/.test(code('src/components/startup/ClientShell.tsx')),
    'SHELL R7B PP-7 die Huelle hat keine eigenen Bereiche mehr — nur noch die Anmeldung');
}

// ── 8) „Create anyway" ist ein neuer Vorsatz, kein zweiter Versuch ────────
//
// Der Primary hat auf die erste Kennung ein ENDGUELTIGES Nein gegeben; es steht in seinem
// Auftragsbuch. Dieselbe Kennung mit einem erweiterten Rumpf zu wiederholen waere gleich zweimal
// falsch: gleiche Kennung + andere Anfrage ist ein Kennungskonflikt, und der Vorgang liefe nie.
{
  // R7B PP-7 — woertliche Ruempfe statt `consignmentCreateRequest(d, ack)`; die Pruefungen am
  // Rumpfbau (Bestaetigung nur auf Wunsch, kein Formularzustand) sind mit ihm entfernt.
  const plain = {
    consignorId: 'cust-1', product: { brand: 'Patek', name: 'Nautilus', categoryId: 'cat-w' },
    agreedPrice: 1000, payout: { model: 'percent', commissionRate: 20 },
  };
  const confirmed = { ...plain, acknowledgeDuplicate: true };
  accepts(() => cmd.parseConsignmentCreate(confirmed), 'DUP der echte Pruefer nimmt die ausdrueckliche Bestaetigung an');

  // Der ganze Ablauf am echten Waechter: Nein → neuer Vorsatz → neue Kennung → derselbe Rumpf
  // plus Bestaetigung.
  const controller = new CommandSaveController('consignments.create');
  const a = controller.beginAttempt();
  const said = await a.send(plain, (async () => ({
    status: 422, ok: false,
    json: async () => ({ error: 'POSSIBLE_DUPLICATE', message: 'this looks like an item we already have' }),
  })) as never);
  ok(said.kind === 'business_error' && said.code === 'POSSIBLE_DUPLICATE',
    `DUP der Verdacht kommt als endgueltiges Nein an (${said.kind})`);
  ok(controller.pendingAttempt() === null, 'DUP …und beendet den Versuch — er ist beantwortet');

  controller.forget();
  const b = controller.beginAttempt();
  ok(b.commandId !== a.commandId, 'DUP „Create anyway" bekommt eine NEUE Kennung');
  let sentTo = null;
  const okRes = await b.send(confirmed, (async (_u, init) => {
    sentTo = JSON.parse(init.body);
    return { status: 200, ok: true, json: async () => ({ ok: true, value: { consignmentId: 'c1', replayed: false } }) };
  }) as never);
  ok(okRes.kind === 'ok', 'DUP …und geht damit durch');
  ok(sentTo.commandId === b.commandId && sentTo.commandId !== a.commandId,
    'DUP …unter genau dieser neuen Kennung');
  ok(sentTo.payload.acknowledgeDuplicate === true, 'DUP …mit der ausdruecklichen Bestaetigung im Rumpf');
  // R7B PP-7 — die Knopf-Pruefungen am alten Kommissionsformular sind mit ihm entfernt.
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central c3e client commercial ui: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
