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
const ui = await import('../../src/core/bridge/client-commercial-request.ts');
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

const PURCHASE_FORM = 'src/components/client/ClientPurchaseForm.tsx';
const CONSIGN_FORM = 'src/components/client/ClientConsignmentForm.tsx';
const ORDER_FORM = 'src/components/client/ClientOrderForm.tsx';
const SHELL = 'src/components/startup/ClientShell.tsx';
const FORMS = [PURCHASE_FORM, CONSIGN_FORM, ORDER_FORM];

// ── 1) Kein Weg zur lokalen Datenbank — im ganzen Importbaum ──────────────
{
  const seen = new Set<string>();
  const offenders: string[] = [];
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(resolvePath(repo, file), 'utf8');
    const stripped = text.split(/\r?\n/).filter((l) => {
      const t = l.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    }).join('\n');
    if (/\bgetDatabase\b|\binitDatabase\b|useProductStore|useCustomerStore|useInvoiceStore|useOrderStore|usePurchaseStore|useConsignmentStore/.test(stripped)) {
      offenders.push(file);
    }
    for (const m of stripped.matchAll(/from '(@\/[^']+)'/g)) {
      const rel = 'src/' + m[1].slice(2);
      for (const cand of [rel, rel + '.ts', rel + '.tsx']) {
        if (existsSync(resolvePath(repo, cand)) && /\.(ts|tsx)$/.test(cand)) { visit(cand); break; }
      }
    }
    for (const m of stripped.matchAll(/from '(\.[^']+)'/g)) {
      const base = resolvePath(dirname(resolvePath(repo, file)), m[1]);
      for (const cand of [base, base + '.ts', base + '.tsx']) {
        if (existsSync(cand)) {
          if (/\.(ts|tsx)$/.test(cand)) visit(cand.slice(repo.length + 1).replace(/\\/g, '/'));
          break;
        }
      }
    }
  };
  for (const f of FORMS) visit(f);

  ok(seen.size > 5, `DBLESS der Importbaum wurde wirklich abgelaufen (${seen.size} Dateien)`);
  ok(offenders.length === 0,
    `DBLESS nirgends darin wird die lokale Datenbank oder ein Business-Store benutzt (${offenders.join(', ') || 'keine'})`);
  ok([...seen].every((f) => !f.startsWith('src/core/db/')),
    `DBLESS und keine Datei aus der Datenschicht ist dabei (${[...seen].filter((f) => f.startsWith('src/core/db/')).join(', ') || 'keine'})`);
  for (const f of FORMS) {
    ok(!/outbox|localStorage|indexedDB/i.test(code(f)), `DBLESS ${f} legt keinen eigenen Ausgangskorb an`);
    ok(/remoteRead/.test(src(f)), `DBLESS ${f} holt seine Daten aus der Fernquelle`);
    ok(/client-commercial-request/.test(src(f)), `WIRED ${f} fährt genau den Vertrag, der hier geprüft wird`);
    ok(/CommandSaveController/.test(code(f)), `WIRED ${f} benutzt den Wächter über die Kennungen`);
    ok(!/new CommandSaveAttempt\(/.test(code(f)),
      `WIRED ${f} erzeugt keine Kennung an der Oberfläche — das macht nur der Wächter`);
  }
}

// ── 2) Für einen Einkauf gibt es kein Änderungsformular ───────────────────
{
  const f = code(PURCHASE_FORM);
  ok(!/purchases\.update|purchaseId\?:|editing/.test(f),
    'SCOPE das Einkaufsformular kennt kein Ändern — den Vertrag gibt es im Haus nicht');
  const shell = code(SHELL);
  ok(!/data-client-edit-purchase/.test(shell),
    'SCOPE …und die Oberfläche bietet auch keinen Knopf dafür an');
  ok(/data-client-edit-consignment/.test(shell) && /data-client-edit-order/.test(shell),
    'SCOPE Kommission und Auftrag haben je einen Ändern-Knopf');
  // Und er hängt an einer GELESENEN Zeile, nicht an einem Eingabefeld.
  ok(/setEditConsignmentId\(s\(detail\.id\)\)/.test(shell) && /setEditOrderId\(s\(detail\.id\)\)/.test(shell),
    'SCOPE das Ändern beginnt an einer gelesenen Zeile — es gibt kein Feld für eine Kennung');
}

// ── 3) Was das Einkaufsformular schickt, hält der echte Prüfer aus ────────
{
  const draft = {
    ...ui.EMPTY_PURCHASE, supplierId: 'sup-1', taxScheme: 'VAT_10',
    purchaseDate: '2026-09-07', notes: 'zweiter Rechner', paymentAmount: '50', paymentMethod: 'bank',
  };
  const lines = [
    { productId: 'p1', quantity: '2', unitPrice: '100' },
    { productId: '', quantity: '1', unitPrice: '' },              // leere Zeile: keine Position
    { productId: 'p2', quantity: '0', unitPrice: '5' },           // Menge 0: keine Position
  ];
  const body = ui.purchaseCreateRequest(draft, lines);
  const parsed = cmd.parsePurchaseCreate(body);
  ok(parsed.lines.length === 1, `REQUEST nur echte Positionen reisen mit (${parsed.lines.length})`);
  ok(parsed.initialPayment?.amount === 50, 'REQUEST die Anzahlung kommt an');
  const keys = Object.keys(body).sort().join(',');
  ok(keys === 'initialPayment,lines,notes,purchaseDate,supplierId,taxScheme',
    `REQUEST und NICHTS sonst — keine Summe, keine Nummer, keine Filiale (${keys})`);
  ok(!('totalAmount' in body) && !('purchaseNumber' in body) && !('branchId' in body),
    'REQUEST …ausdrücklich geprüft');

  // Ohne Zahlung reist auch kein Zahlungsfeld — ein leeres Feld ist keine Aussage.
  const noPay = ui.purchaseCreateRequest({ ...draft, paymentAmount: '' }, lines);
  ok(!('initialPayment' in noPay), 'REQUEST ein leeres Zahlungsfeld schickt keine Zahlung');

  // Die Vorschau ist eine Vorschau: sie steht nicht im Rumpf.
  ok(ui.previewTotal(lines) === 200, `PREVIEW der Bildschirm rechnet für die Anzeige (${ui.previewTotal(lines)})`);
  ok(!/agreedPrice|totalAmount/.test(JSON.stringify(body)), 'PREVIEW …und schickt das Ergebnis NICHT mit');

  ok(!ui.purchaseComplete({ ...draft, supplierId: '' }, lines), 'FORM ohne Lieferant kein Speichern');
  ok(!ui.purchaseComplete(draft, [{ productId: '', quantity: '1', unitPrice: '' }]), 'FORM ohne Position kein Speichern');
  ok(ui.purchaseComplete(draft, lines), 'FORM mit beidem schon');
}

// ── 4) Kommission: anlegen und ändern ─────────────────────────────────────
{
  const d = {
    ...ui.EMPTY_CONSIGNMENT, consignorId: 'cust-1', brand: 'Patek', name: 'Nautilus',
    categoryId: 'cat-w', agreedPrice: '1000', payoutModel: 'percent', commissionRate: '20',
  };
  const body = ui.consignmentCreateRequest(d);
  cmd.parseConsignmentCreate(body);
  const keys = Object.keys(body).sort().join(',');
  ok(keys === 'agreedPrice,consignorId,payout,product', `REQUEST nur die Eingabe (${keys})`);
  ok(!JSON.stringify(body).includes('sku'), 'REQUEST die SKU steht nirgends — die vergibt der Primary');

  // Der Anteil eines Modells reist nur mit SEINEM Modell.
  ok(JSON.stringify(ui.payoutRequest({ payoutModel: 'percent', commissionRate: '20', excessSplitPct: '70' }))
    === JSON.stringify({ model: 'percent', commissionRate: 20 }),
  'PAYOUT bei „percent" reist kein Gewinnanteil mit');
  ok(JSON.stringify(ui.payoutRequest({ payoutModel: 'cost_split', commissionRate: '20', excessSplitPct: '70' }))
    === JSON.stringify({ model: 'cost_split', excessSplitPct: 70 }),
  'PAYOUT bei „cost_split" reist kein Prozentsatz mit');
  ok(JSON.stringify(ui.payoutRequest({ payoutModel: 'consignor_fixed', commissionRate: '20', excessSplitPct: '70' }))
    === JSON.stringify({ model: 'consignor_fixed' }),
  'PAYOUT bei „Agreed + Excess" reist gar kein Parameter mit');

  // Ändern: nur der Unterschied.
  const base = { agreedPrice: '1000', minimumPrice: '', expiryDate: '', notes: 'alt', payoutModel: 'percent', commissionRate: '20', excessSplitPct: '' };
  const now = { ...base, notes: 'neu' };
  const patch = ui.consignmentUpdateRequest('c1', 7, base, now, { payoutLocked: false });
  ok(Object.keys(patch).sort().join(',') === 'expectedRevision,id,notes',
    `REQUEST beim Ändern reist nur der Unterschied (${Object.keys(patch).join(',')})`);
  ok(patch.expectedRevision === 7, 'REQUEST …und zwar genau die gelesene Fassung, unverändert');
  cmd.parseConsignmentUpdate(patch);

  // Ein gesperrtes Modell wird nicht mitgeschickt — sonst scheiterte eine reine Notizänderung.
  const changedModel = { ...base, payoutModel: 'cost_split', excessSplitPct: '60', notes: 'neu' };
  const locked = ui.consignmentUpdateRequest('c1', 7, base, changedModel, { payoutLocked: true });
  ok(!('payout' in locked), 'PAYOUT ein gesperrtes Modell reist nicht mit');
  ok('notes' in locked, 'PAYOUT …aber die Notiz schon');
  const open = ui.consignmentUpdateRequest('c1', 7, base, changedModel, { payoutLocked: false });
  ok(JSON.stringify(open.payout) === JSON.stringify({ model: 'cost_split', excessSplitPct: 60 }),
    'PAYOUT ein offenes Modell reist vollständig mit');
  cmd.parseConsignmentUpdate(open);

  ok(ui.changeCount(ui.consignmentUpdateRequest('c1', 7, base, base, { payoutLocked: false })) === 0,
    'FORM ohne Änderung gibt es nichts zu schicken');
}

// ── 5) Auftrag: anlegen und ändern ────────────────────────────────────────
{
  const d = { ...ui.EMPTY_ORDER, customerId: 'cust-1', depositAmount: '200', paymentMethod: 'cash' };
  const lines = [{ productId: 'p1', quantity: '2', unitPrice: '300' }];
  const body = ui.orderCreateRequest(d, lines);
  cmd.parseOrderCreate(body);
  const keys = Object.keys(body).sort().join(',');
  ok(keys === 'customerId,depositAmount,lines,paymentMethod', `REQUEST nur die Eingabe (${keys})`);
  ok(!('agreedPrice' in body) && !('remainingAmount' in body) && !('expectedMargin' in body),
    'REQUEST Summe, Rest und Marge rechnet der Primary — sie stehen nicht im Rumpf');

  // Die Kartenmarke gehört zur Karte.
  const card = ui.orderCreateRequest({ ...d, paymentMethod: 'card', cardBrand: 'amex' }, lines);
  ok(card.cardBrand === 'amex', 'REQUEST bei Karte reist die Marke mit');
  ok(!('cardBrand' in ui.orderCreateRequest({ ...d, paymentMethod: 'cash', cardBrand: 'amex' }, lines)),
    'REQUEST bei Bargeld nicht');
  ok(!('paymentMethod' in ui.orderCreateRequest({ ...d, depositAmount: '' }, lines)),
    'REQUEST ohne Anzahlung reist auch keine Zahlungsart');

  // Ändern: nur der Unterschied, und die Fassung.
  const base = { agreedPrice: '600', depositAmount: '200', supplierName: '', supplierPrice: '', expectedDelivery: '', notes: '' };
  const patch = ui.orderUpdateRequest('o1', 4, base, { ...base, agreedPrice: '700' });
  ok(Object.keys(patch).sort().join(',') === 'agreedPrice,expectedRevision,id',
    `REQUEST beim Ändern reist nur der Unterschied (${Object.keys(patch).join(',')})`);
  ok(patch.agreedPrice === 700 && patch.expectedRevision === 4, 'REQUEST Zahl als Zahl, Fassung unverändert');
  cmd.parseOrderUpdate(patch);

  // Ein geleertes Feld heißt „kein Wert", nicht 0 — der Unterschied ist Geld.
  const cleared = ui.orderUpdateRequest('o1', 4, { ...base, supplierPrice: '400' }, { ...base, supplierPrice: '' });
  ok(cleared.supplierPrice === null, 'REQUEST ein geleertes Zahlenfeld heißt „kein Wert", nicht 0');
  cmd.parseOrderUpdate(cleared);
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
  const shell = code(SHELL);
  for (const op of ['purchases.list', 'consignments.list', 'orders.list',
    'purchases.get', 'consignments.get', 'orders.get']) {
    ok(shell.includes(`'${op}'`), `SHELL der Bereich benutzt ${op}`);
  }
  ok(!/getDatabase|useOrderStore|usePurchaseStore/.test(shell), 'SHELL und keine lokale Datenbank');
  // Kein Bereich ohne Lesevorgang bekommt eine Detailansicht — es wird nichts geraten.
  ok(/DETAIL_OPS/.test(shell) && /if \(!op\) return;/.test(shell),
    'SHELL ein Bereich ohne Lesevorgang hat keine Detailansicht');
}

// ── 8) „Create anyway" ist ein neuer Vorsatz, kein zweiter Versuch ────────
//
// Der Primary hat auf die erste Kennung ein ENDGUELTIGES Nein gegeben; es steht in seinem
// Auftragsbuch. Dieselbe Kennung mit einem erweiterten Rumpf zu wiederholen waere gleich zweimal
// falsch: gleiche Kennung + andere Anfrage ist ein Kennungskonflikt, und der Vorgang liefe nie.
{
  const d = {
    ...ui.EMPTY_CONSIGNMENT, consignorId: 'cust-1', brand: 'Patek', name: 'Nautilus',
    categoryId: 'cat-w', agreedPrice: '1000', payoutModel: 'percent', commissionRate: '20',
  };
  ok(!('acknowledgeDuplicate' in ui.consignmentCreateRequest(d)),
    'DUP der normale Anlageauftrag traegt KEINE Bestaetigung');
  const confirmed = ui.consignmentCreateRequest(d, true);
  ok(confirmed.acknowledgeDuplicate === true, 'DUP …der bestaetigte schon');
  cmd.parseConsignmentCreate(confirmed);
  ok(!('acknowledgeDuplicate' in ui.EMPTY_CONSIGNMENT),
    'DUP und sie ist kein FORMULARZUSTAND — sonst truege sie der naechste Versuch stillschweigend weiter');

  // Der ganze Ablauf am echten Waechter: Nein → neuer Vorsatz → neue Kennung → derselbe Rumpf
  // plus Bestaetigung.
  const controller = new CommandSaveController('consignments.create');
  const a = controller.beginAttempt();
  const said = await a.send(ui.consignmentCreateRequest(d), (async () => ({
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
  const okRes = await b.send(ui.consignmentCreateRequest(d, true), (async (_u, init) => {
    sentTo = JSON.parse(init.body);
    return { status: 200, ok: true, json: async () => ({ ok: true, value: { consignmentId: 'c1', replayed: false } }) };
  }) as never);
  ok(okRes.kind === 'ok', 'DUP …und geht damit durch');
  ok(sentTo.commandId === b.commandId && sentTo.commandId !== a.commandId,
    'DUP …unter genau dieser neuen Kennung');
  ok(sentTo.payload.acknowledgeDuplicate === true, 'DUP …mit der ausdruecklichen Bestaetigung im Rumpf');

  // Der Knopf tut, was draufsteht: er verwirft den alten Versuch UND schickt.
  const form = code(CONSIGN_FORM);
  ok(/const createAnyway = useCallback\(async \(\) => \{\s*\n\s*controller\.forget\(\);/.test(form),
    'DUP der Knopf verwirft den alten Versuch…');
  ok(/await send\(consignmentCreateRequest\(draft, true\)\);/.test(form),
    'DUP …und schickt selbst, statt auf einen zweiten Klick zu warten');
  ok(/data-client-consignment-anyway[^>]*onClick=\{\(\) => void createAnyway\(\)\}/.test(form),
    'DUP …und genau dieser Knopf haengt daran');
  ok(!/setAckDuplicate/.test(form), 'DUP es gibt keinen Formularzustand mehr, der sie weitertruege');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central c3e client commercial ui: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
