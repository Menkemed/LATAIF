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

// POST-PARITY R7B PP-7 — die alte Client-Rechnungsansicht (`src/components/client/ClientInvoiceDetail.tsx`)
// samt ihrem Rumpfbau (`client-invoice-request.ts`, `buildUpdateRequest`) ist entfernt. Geaendert
// wird (und wurde) im Rechnungsformular der gemeinsamen Oberflaeche: `InvoiceCreate` → `invoices.update`.
const LEGACY = 'src/components/client';
const INVOICE_FORM = 'src/pages/invoices/InvoiceCreate.tsx';

// ── 1) Kein Weg zur lokalen Datenbank ─────────────────────────────────────
{
  ok(!existsSync(resolvePath(repo, LEGACY)),
    'DBLESS R7B PP-7 die alte Client-Rechnungsansicht (src/components/client) gibt es nicht mehr');
}

// ── 2) Was sie schickt, erlaubt der Primary — und mehr nicht ──────────────
{
  // Der lebende Aenderungsrumpf steht im Rechnungsformular (Fernanschluss von `invoices.update`).
  const form = code(INVOICE_FORM);
  const at = form.indexOf('aendernRechnung.save({');
  const remoteAt = form.indexOf('remote: () => ({', at);
  const remote = at > 0 && remoteAt > at ? form.slice(remoteAt, form.indexOf('});', remoteAt)) : '';
  ok(/^remote: \(\) => \(\{\s*id: invId,\s*expectedRevision: fassung,\s*reason,\s*customerId,\s*lines: /.test(remote),
    `REQUEST das Rechnungsformular schickt Kennung, gesehene Fassung, Grund und Auswahl (${remote.length} Zeichen)`);
  ok(/const fassung = editInvoice\.revision;/.test(form),
    'REQUEST …und zwar genau die Fassung, die es geladen hat');
  ok(remote.length > 0 && !/grossAmount|paidAmount|status|invoiceNumber|deltaPayment/.test(remote),
    'REQUEST …und nichts, was der Primary rechnet oder entscheidet');

  // Derselbe Rumpf, wie ihn das Formular baut — und der ECHTE Prüfer nimmt ihn an.
  const body = {
    id: 'inv-1', expectedRevision: 7, reason: 'Preis korrigiert', customerId: 'cust-1',
    lines: [{ productId: 'p1', lotId: null, quantity: 2, unitPrice: 150, scheme: 'MARGIN' }],
    notes: 'n', issuedDate: '2026-09-05', staffId: 'st-1',
  };
  const parsed = parseInvoiceUpdate(body);
  ok(parsed.id === 'inv-1' && parsed.expectedRevision === 7 && parsed.reason === 'Preis korrigiert'
    && parsed.body.lines[0].quantity === 2,
  'REQUEST der Pruefer des Primary nimmt ihn an');

  // Ein Rumpf, der doch etwas Abgeleitetes mitschickte, käme nicht durch.
  for (const extra of ['grossAmount', 'paidAmount', 'status', 'invoiceNumber', 'deltaPayment']) {
    let threw = false;
    try { parseInvoiceUpdate({ ...body, [extra]: 1 }); } catch { threw = true; }
    ok(threw, `REQUEST ${extra} wuerde abgewiesen`);
  }
}

// ── 3) Die Zahlung: nur Betrag und Art ────────────────────────────────────
{
  const p = parsePaymentPayload({ invoiceId: 'inv-1', amount: 25, method: 'cash' });
  ok(p.amount === 25 && p.method === 'cash', 'PAY der Pruefer des Primary nimmt ihn an');
  // R7B PP-7 — die Pruefungen am Zahlungsfeld der alten Ansicht sind mit ihr entfernt.
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
  ok(!existsSync(resolvePath(repo, LEGACY + '/ClientInvoiceDetail.tsx')),
    'UI R7B PP-7 die alte Rechnungsansicht mit ihren Waechtern und ihrem Platz in der Huelle ist entfernt');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central c3d client invoice lifecycle ui: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
console.log('CENTRAL_C3D_CLIENT_INVOICE_LIFECYCLE_UI_PROVED');
