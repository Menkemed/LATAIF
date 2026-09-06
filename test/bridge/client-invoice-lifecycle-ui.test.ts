// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-C3D — die Rechnungsansicht des Clients: ändern und bezahlen, ohne Datenbank.
// Run: node test/bridge/client-invoice-lifecycle-ui.test.ts
//
// Vier Zusagen:
//   • Sie öffnet KEINE lokale Geschäftsdatenbank — auch nicht drei Importe tief.
//   • Was sie schickt, hält der ECHTE Prüfer des Primary aus: die Auswahl eines Menschen, der
//     GESEHENE Stand und der Grund — keine Summe, kein Status, keine Nummer.
//   • Ändern und Bezahlen sind zwei Vorsätze mit zwei Wächtern. Eine Zeitgrenze beim Bezahlen
//     erzeugt keine zweite Zahlung, und sie fasst den Änderungsversuch nicht an.
//   • Ein fachliches Nein beendet den Versuch; ein offener Ausgang hält dieselbe Kennung.
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
const { parseInvoiceUpdate, parsePaymentPayload } =
  await import('../../src/core/bridge/invoice-lifecycle-commands.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const code = (p: string): string => src(p)
  .split(/\r?\n/)
  .filter((l) => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')); })
  .join('\n');

const VIEW = 'src/components/client/ClientInvoiceDetail.tsx';
const SHELL = 'src/components/startup/ClientShell.tsx';

// Der Rumpfbau der Ansicht — als reine Funktion prüfbar, ohne Browser.
const { buildUpdateRequest } = await import('../../src/components/client/client-invoice-request.ts');

// ── 1) Kein Weg zur lokalen Datenbank ─────────────────────────────────────
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
    if (/\bgetDatabase\b|\binitDatabase\b|useInvoiceStore|useProductStore|useCustomerStore/.test(stripped)) {
      offenders.push(file);
    }
    for (const m of stripped.matchAll(/from '(@\/[^']+)'/g)) {
      const rel = 'src/' + m[1].slice(2);
      for (const cand of [rel, rel + '.ts', rel + '.tsx']) {
        if (existsSync(resolvePath(repo, cand)) && /\.(ts|tsx)$/.test(cand)) { visit(cand); break; }
      }
    }
  };
  visit(VIEW);

  ok(seen.size > 2, `DBLESS der Importbaum wurde abgelaufen (${seen.size} Dateien)`);
  ok(offenders.length === 0,
    `DBLESS nirgends darin wird die lokale Datenbank oder ein Business-Store benutzt (${offenders.join(', ') || 'keine'})`);
  ok([...seen].every((f) => !f.startsWith('src/core/db/')), 'DBLESS und keine Datei aus der Datenschicht ist dabei');
  ok(!/outbox|localStorage|indexedDB/i.test(code(VIEW)), 'DBLESS die Ansicht legt keinen eigenen Ausgangskorb an');
  ok(/remoteRead/.test(src(VIEW)), 'DBLESS ihre Daten kommen aus der Fernquelle');
  ok(/'invoices\.get'/.test(src(VIEW)), 'DBLESS …aus dem bestehenden Lesebefehl');
}

// ── 2) Was sie schickt, erlaubt der Primary — und mehr nicht ──────────────
{
  const body = buildUpdateRequest({
    id: 'inv-1', expectedRevision: 7, reason: '  Preis korrigiert  ',
    customerId: 'cust-1',
    lines: [{ productId: 'p1', quantity: 2.9, unitPrice: 150 }],
    notes: '   ',
  });
  const keys = Object.keys(body).sort().join(',');
  ok(keys === 'customerId,expectedRevision,id,lines,reason',
    `REQUEST nur Auswahl, gesehene Fassung und Grund (${keys})`);
  ok(body.expectedRevision === 7, 'REQUEST …und zwar genau die gelesene Fassung, unveraendert');
  ok(body.reason === 'Preis korrigiert', 'REQUEST der Grund wird getrimmt, nicht erfunden');
  ok(!('notes' in body), 'REQUEST eine leere Notiz wird gar nicht erst mitgeschickt');
  const line = (body.lines as Array<Record<string, unknown>>)[0];
  ok(Object.keys(line).sort().join(',') === 'productId,quantity,unitPrice',
    `REQUEST auch in der Zeile (${Object.keys(line).join(',')})`);
  ok(line.quantity === 2, 'REQUEST eine Menge ist eine ganze Zahl');

  // Und der ECHTE Prüfer nimmt genau diesen Rumpf an.
  const parsed = parseInvoiceUpdate(body);
  ok(parsed.id === 'inv-1' && parsed.reason === 'Preis korrigiert' && parsed.body.lines[0].quantity === 2,
    'REQUEST der Pruefer des Primary nimmt ihn an');

  // Ein Rumpf, der doch etwas Abgeleitetes mitschickte, käme nicht durch.
  for (const extra of ['grossAmount', 'paidAmount', 'status', 'invoiceNumber', 'deltaPayment']) {
    let threw = false;
    try { parseInvoiceUpdate({ ...body, [extra]: 1 }); } catch { threw = true; }
    ok(threw, `REQUEST ${extra} wuerde abgewiesen`);
  }

  // Die Ansicht selbst rechnet nichts.
  const view = code(VIEW);
  ok(!/grossAmount\s*=|vatRate|\* 1\.1|netAmount\s*=/.test(view), 'REQUEST die Ansicht rechnet keine Summe');
  ok(/view\.grossAmount/.test(view) && /view\.openAmount/.test(view),
    'REQUEST sie ZEIGT nur, was der Primary gerechnet hat');
  ok(/expectedRevision: view\.revision/.test(view),
    'REQUEST und sie schickt genau die Fassung mit, die sie geladen hat');
}

// ── 3) Die Zahlung: nur Betrag und Art ────────────────────────────────────
{
  const view = code(VIEW);
  const sent = view.slice(view.indexOf('const pay = useCallback'), view.indexOf('if (loadError)'));
  ok(/invoiceId: view\.id/.test(sent) && /amount: Number\(amount\)/.test(sent) && /method,/.test(sent),
    'PAY der Auftrag traegt Rechnung, Betrag und Art');
  ok(!/status|paidAmount|paymentId|specialMark/.test(sent),
    'PAY …und nichts, was der Primary entscheidet');
  const p = parsePaymentPayload({ invoiceId: 'inv-1', amount: 25, method: 'cash' });
  ok(p.amount === 25 && p.method === 'cash', 'PAY der Pruefer des Primary nimmt ihn an');
  ok(/METHODS = \['cash', 'card', 'bank_transfer', 'benefit', 'other'\]/.test(view),
    'PAY die Auswahl zeigt genau die Zahlungsarten des Hauses');
  ok(!/'credit'/.test(view), 'PAY …und NICHT die Guthaben-Einloesung — die ist ein eigener Vorgang');
}

// ── 4) Zwei Vorsätze, zwei Wächter ────────────────────────────────────────
{
  cm.enterClientMode('https://primary.local');
  cm.setClientToken('tok');
  const reply = (status: number, body: Record<string, unknown>): Response =>
    ({ status, ok: status >= 200 && status < 300, json: async () => body }) as unknown as Response;

  const editCtl = new CommandSaveController('invoices.update');
  const payCtl = new CommandSaveController('invoices.record_payment');

  const editAttempt = editCtl.beginAttempt();
  const editId = editAttempt.commandId;
  const sent: Array<{ op: string; commandId: string }> = [];
  const capture = (async (_u: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body) as { op: string; commandId: string });
    return reply(504, {});
  }) as unknown as typeof fetch;

  const editPending = await editAttempt.send({ id: 'inv-1' }, capture);
  ok(editPending.kind === 'unknown', 'SAVE die Zeitgrenze laesst den Ausgang offen');
  ok(editCtl.beginAttempt().commandId === editId, 'SAVE ein zweiter Klick benutzt DIESELBE Kennung');

  // Der Zahlungs-Wächter hat davon NICHTS mitbekommen.
  const payAttempt = payCtl.beginAttempt();
  ok(payAttempt.commandId !== editId, 'SAVE die Zahlung hat ihre eigene Kennung');
  const payPending = await payAttempt.send({ invoiceId: 'inv-1', amount: 5, method: 'cash' }, capture);
  ok(payPending.kind === 'unknown', 'SAVE …und ihren eigenen offenen Ausgang');
  ok(payCtl.beginAttempt().commandId === payAttempt.commandId,
    'SAVE eine Wiederholung der Zahlung benutzt DIESELBE Kennung');
  ok(editCtl.beginAttempt().commandId === editId,
    'SAVE …und der Aenderungsversuch bleibt davon unberuehrt');
  ok(sent.map((x) => x.op).join(',') === 'invoices.update,invoices.record_payment',
    `SAVE jeder Auftrag traegt seinen eigenen Namen (${sent.map((x) => x.op).join(',')})`);

  // Ein fachliches Nein beendet den Versuch; der naechste bewusste Klick ist ein neuer.
  const settled = await editCtl.beginAttempt().send({ id: 'inv-1' },
    (async () => reply(409, { ok: false, error: 'INVOICE_CHANGED', message: 'weg' })) as unknown as typeof fetch);
  ok(settled.kind === 'business_error' && settled.code === 'INVOICE_CHANGED',
    `SAVE ein 409 OHNE outcome ist das fachliche Nein (${JSON.stringify(settled)})`);
  ok(editCtl.beginAttempt().commandId !== editId, 'SAVE eine abgelehnte Kennung wird NICHT wiederverwendet');

  const clash = await payCtl.beginAttempt().send({ invoiceId: 'inv-1', amount: 5, method: 'cash' },
    (async () => reply(409, { ok: false, error: 'BRIDGE_COMMAND_ID_CONFLICT', outcome: 'not_executed' })) as unknown as typeof fetch);
  ok(clash.kind === 'not_executed', 'SAVE ein 409 MIT outcome ist der Kennungskonflikt');
}

// ── 5) Die Ansicht hält sich daran ────────────────────────────────────────
{
  const view = code(VIEW);
  ok(/editCtl\.beginAttempt\(\)/.test(view) && /payCtl\.beginAttempt\(\)/.test(view),
    'UI beide Wege gehen ueber ihren Waechter…');
  ok(!/new CommandSaveAttempt\(/.test(view), 'UI …und keiner vergibt eine Kennung daran vorbei');
  // Seit C3G sind es fuenf: aendern, bezahlen, Guthaben anrechnen, Zahlung berichtigen,
  // Zahlung zuruecknehmen. Die Zusage war nie „genau zwei", sondern EINER JE VORSATZ — und
  // dass keiner davon geteilt wird, ist der Punkt.
  const ctls = [...view.matchAll(/const (\w+) = useMemo\(\(\) => new CommandSaveController/g)].map((m) => m[1]);
  ok((view.match(/new CommandSaveController/g) || []).length === 5,
    `UI es sind fuenf Waechter — einer je Vorsatz (${ctls.join(', ')})`);
  ok(new Set(ctls).size === ctls.length, 'UI …und keiner wird doppelt benutzt');
  ok(!/setTimeout|setInterval/.test(view), 'UI es gibt keinen automatischen zweiten Versuch');
  ok(/disabled=\{editPending\}/.test(view) && /disabled=\{payPending\}/.test(view),
    'UI waehrend ein Ausgang offen ist, wird die Eingabe nicht veraendert');
  ok(/not known/.test(src(VIEW)), 'UI der offene Ausgang wird ausgesprochen');
  ok(/canEdit = reason\.trim\(\) !== ''/.test(view),
    'UI ohne Aenderungsgrund ist der Knopf aus — dieselbe Pflicht wie im Haus');
  ok(/setTick\(\(t\) => t \+ 1\)/.test(view),
    'UI nach einer Antwort wird neu geladen — der naechste Vorsatz fusst auf dem echten Stand');

  const shell = code(SHELL);
  ok(/ClientInvoiceDetail/.test(shell), 'SHELL die Ansicht haengt in der Schale');
  ok(/setOpenInvoiceId\(s\(detail\.id\)\)/.test(shell),
    'SHELL sie beginnt an einer GELESENEN Rechnung, nicht an einer eingetippten Kennung');
  ok(!/data-client-delete|deleteInvoice|deletePayment/.test(shell),
    'SHELL kein Loeschen — das steht auf keiner Zulassungsliste');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central c3d client invoice lifecycle ui: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
console.log('CENTRAL_C3D_CLIENT_INVOICE_LIFECYCLE_UI_PROVED');
