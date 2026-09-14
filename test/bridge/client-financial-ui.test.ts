// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-C3G — die Geldknöpfe des Clients, ohne Datenbank.
// Run: node test/bridge/client-financial-ui.test.ts
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
const ui = await import('../../src/core/bridge/client-financial-request.ts');
// Und der ECHTE Prüfer des Primary.
const cmd = await import('../../src/core/bridge/financial-commands.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const code = (p: string): string => src(p).split(/\r?\n/)
  .filter((l) => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')); })
  .join('\n');

// POST-PARITY R7B PP-7 — die alten Geldknoepfe (`src/components/client/ClientInvoiceDetail.tsx`,
// `ClientOrderForm`, `ClientConsignmentForm`, `ClientTransferForm`) sind entfernt. Was hier bleibt,
// prueft den Vertrag (`client-financial-request`), den echten Pruefer des Primary und den Waechter.
const LEGACY = 'src/components/client';

// ── 1) Kein Weg zur lokalen Datenbank ────────────────────────────────────
{
  ok(!existsSync(resolvePath(repo, LEGACY)),
    'DBLESS R7B PP-7 die alten Client-Geldknoepfe (src/components/client) gibt es nicht mehr');
}

// ── 2) Ein Wächter je Vorsatz ────────────────────────────────────────────
{
  ok(!existsSync(resolvePath(repo, LEGACY + '/ClientInvoiceDetail.tsx')),
    'IDS R7B PP-7 die alte Rechnungsansicht mit ihren fuenf Waechtern ist entfernt (Waechter-Vertrag: Abschnitt 5)');
}

// ── 3) Was die Knöpfe schicken, hält der echte Prüfer aus ────────────────
{
  const credit = ui.applyCreditRequest('i1', 7, '50', ' zum Ausgleich ');
  cmd.parseApplyCredit(credit);
  ok(Object.keys(credit).sort().join(',') === 'amount,expectedRevision,invoiceId,note',
    `REQUEST Guthaben: nur Kennung, Betrag, Fassung, Notiz (${Object.keys(credit).join(',')})`);
  ok(credit.expectedRevision === 7 && credit.amount === 50, 'REQUEST …und zwar die gelesene Fassung');
  ok(!('note' in ui.applyCreditRequest('i1', 7, '50')), 'REQUEST eine leere Notiz reist nicht mit');

  const base = { amount: '40', method: 'cash', notes: '', receivedAt: '2026-09-11' };
  const patch = ui.updatePaymentRequest('i1', 'p1', 3, base, { ...base, amount: '60' });
  cmd.parseUpdatePayment(patch);
  ok(Object.keys(patch).sort().join(',') === 'amount,expectedRevision,invoiceId,paymentId',
    `REQUEST Berichtigung: nur der Unterschied (${Object.keys(patch).join(',')})`);
  ok(ui.changeCount(ui.updatePaymentRequest('i1', 'p1', 3, base, base)) === 0,
    'REQUEST ohne Aenderung gibt es nichts zu schicken');
  // Ein leerer Betrag wird gar nicht erst geschickt — der Primary wuerde ihn abweisen.
  ok(!('amount' in ui.updatePaymentRequest('i1', 'p1', 3, base, { ...base, amount: '' })),
    'REQUEST ein geleerter Betrag reist nicht mit');

  const del = ui.deletePaymentRequest('i1', 'p1', 3);
  cmd.parseDeletePayment(del);
  ok(Object.keys(del).sort().join(',') === 'expectedRevision,invoiceId,paymentId',
    'REQUEST Loeschen traegt nichts als die drei Kennungen');

  const conv = ui.convertOrderRequest('o1', 4);
  cmd.parseConvertOrder(conv);
  ok(Object.keys(conv).sort().join(',') === 'expectedRevision,orderId',
    'REQUEST Umwandlung: keine Auswahl von Positionen — die trifft der Primary');

  const payout = ui.recordPayoutRequest('c1', 5, '100', 'cash');
  cmd.parseRecordPayout(payout);
  ok(payout.amount === 100 && payout.method === 'cash', 'REQUEST Auszahlung mit ausdruecklichem Betrag');
  ok(!('reference' in payout), 'REQUEST eine leere Referenz reist nicht mit');

  const sold = ui.markSoldRequest('t1', 2, '400');
  cmd.parseMarkSold(sold);
  ok(!('acknowledgeBelowPrice' in sold), 'REQUEST ohne Bestaetigung reist keine mit');
  ok(ui.markSoldRequest('t1', 2, '400', '', true).acknowledgeBelowPrice === true,
    'REQUEST …mit ihr schon, und nur dann');

  const settle = ui.markSettledRequest('t1', 2, '250', 'bank');
  cmd.parseMarkSettled(settle);
  ok(settle.amount === 250 && settle.method === 'bank', 'REQUEST Abrechnung mit ausdruecklichem Betrag');
}

// ── 4) Klasse C taucht in keiner Oberfläche auf ──────────────────────────
{
  ok(!existsSync(resolvePath(repo, LEGACY + '/ClientTransferForm.tsx')),
    'SCOPE R7B PP-7 die alten Client-Oberflaechen, deren Klasse-C-Freiheit hier geprueft wurde, sind entfernt');
}

// ── 4b) Nach einer Geldaktion gilt die NEUE Fassung ──────────────────────
//
// Der Befund des Zwei-Instanzen-E2E galt den alten Formularen (sie trugen die beim Laden gelesene
// Fassung weiter). Die gemeinsame Oberflaeche laedt nach dem Erfolg frisch — geprueft in
// test/uiparity/r4c-write-matrix.test.ts §5.
{
  ok(!existsSync(resolvePath(repo, LEGACY + '/ClientConsignmentForm.tsx')),
    'REVISION R7B PP-7 die alten Formulare, deren Fassungs-Uebernahme hier geprueft wurde, sind entfernt');
}

// ── 5) Eine Kennung pro Vorsatz — am echten Wächter ──────────────────────
{
  cm.enterClientMode('https://primary.local');
  cm.setClientToken('tok');

  const ctl = new CommandSaveController('consignments.record_payout');
  const a = ctl.beginAttempt();
  const timeout = await a.send(ui.recordPayoutRequest('c1', 1, '100', 'cash'), (async () => ({
    status: 504, ok: false, json: async () => ({}),
  })) as never);
  ok(timeout.kind === 'unknown', `IDS eine Zeitgrenze ist ein offener Ausgang (${timeout.kind})`);
  ok(ctl.beginAttempt().commandId === a.commandId,
    'IDS ein zweiter Klick benutzt DIESELBE Kennung — es wird nicht zweimal ausgezahlt');
  const b = ctl.beginAttempt();
  const done = await b.send(ui.recordPayoutRequest('c1', 1, '100', 'cash'), (async () => ({
    status: 200, ok: true, json: async () => ({ ok: true, value: { payoutPaidAmount: 100, replayed: true } }),
  })) as never);
  ok(done.kind === 'ok' && done.replayed === true, 'IDS …und bekommt das eingefrorene Ergebnis');
  ok(ctl.beginAttempt().commandId !== b.commandId, 'IDS erst danach beginnt ein neuer Vorsatz');

  const rej = new CommandSaveController('invoices.delete_payment');
  const c = rej.beginAttempt();
  const no = await c.send(ui.deletePaymentRequest('i1', 'p1', 1), (async () => ({
    status: 409, ok: false, json: async () => ({ error: 'CREDIT_ALREADY_USED', message: 'nope' }),
  })) as never);
  ok(no.kind === 'business_error', 'IDS ein frozen Nein beendet den Versuch');
  ok(rej.beginAttempt().commandId !== c.commandId, 'IDS …und der naechste bewusste bekommt eine NEUE Kennung');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central c3g client financial ui: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
