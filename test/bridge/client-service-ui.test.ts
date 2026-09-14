// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-C3F — die Reparatur- und Transferformulare des Clients, ohne Datenbank.
// Run: node test/bridge/client-service-ui.test.ts
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
// Und der ECHTE Prüfer des Primary — keine Nachbildung.
const cmd = await import('../../src/core/bridge/service-commands.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const code = (p: string): string => src(p).split(/\r?\n/)
  .filter((l) => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')); })
  .join('\n');

// POST-PARITY R7B PP-7 — die alten Reparatur-/Transferformulare (`src/components/client/`), die
// Bereiche der alten Huelle und ihr Rumpfbau (`client-service-request.ts`) sind entfernt. Was hier
// bleibt, prueft den echten Pruefer des Primary (mit woertlich gebauten Ruempfen) und den Waechter.
const REQ = 'src/core/bridge/client-service-request.ts';
/** Der echte Pruefer nimmt den Rumpf an — ein Wurf ist ein roter Check, kein Absturz. */
const accepts = (f: () => unknown, m: string): void => {
  let why = '';
  try { f(); } catch (e) { why = String(e); }
  ok(why === '', `${m} (${why || 'ok'})`);
};

// ── 1) Kein Weg zur lokalen Datenbank — im ganzen Importbaum ──────────────
{
  ok(!existsSync(resolvePath(repo, 'src/components/client')),
    'DBLESS R7B PP-7 die alten Reparatur-/Transferformulare (src/components/client) gibt es nicht mehr');
  ok(!existsSync(resolvePath(repo, REQ)),
    'DBLESS R7B PP-7 ihr Rumpfbau (client-service-request) ist mit ihnen entfernt');
}

// ── 2) Was die Formulare schicken, hält der echte Prüfer aus ──────────────
{
  // R7B PP-7 — die Ruempfe stehen woertlich hier (vorher `repairCreateRequest`/`repairUpdateRequest`);
  // die Pruefungen am Rumpfbau selbst (Feldauswahl, Margen-Vorschau, Vollstaendigkeit) sind mit ihm
  // entfernt. Die Marge rechnet `repairMargin` — geprueft in service-parity.
  const body = {
    customerId: 'cust-1', issueDescription: 'Krone klemmt', repairType: 'internal', taxScheme: 'VAT_10',
    itemBrand: 'Rolex', itemModel: 'Submariner', estimatedCost: 40, chargeToCustomer: 100,
  };
  accepts(() => cmd.parseRepairCreate(body), 'REQUEST der echte Pruefer nimmt die Aufnahme an');
  accepts(() => cmd.parseRepairUpdate({ id: 'r1', expectedRevision: 5, chargeToCustomer: 150 }),
    'REQUEST …die Aenderung nur mit dem Unterschied und der gelesenen Fassung');
  accepts(() => cmd.parseRepairUpdate({ id: 'r1', expectedRevision: 5, estimatedCost: null }),
    'REQUEST …und ein geleertes Zahlenfeld als „kein Wert", nicht 0');
}

// ── 3) Der Transferrumpf: der Client nennt weder Agent noch Nummer ────────
{
  // R7B PP-7 — woertliche Ruempfe statt `transferCreateRequest`/`transferUpdateRequest`/
  // `transferReturnRequest`; die Pruefungen an deren Feldauswahl sind mit ihnen entfernt.
  const body = { customerId: 'cust-1', productId: 'p1', agentPrice: 500, settlementModel: 'full' };
  accepts(() => cmd.parseTransferCreate(body), 'REQUEST der echte Pruefer nimmt den Transfer an');
  accepts(() => cmd.parseTransferCreate({ ...body, settlementModel: 'split', excessSplitPct: 70 }),
    'REQUEST …auch mit Gewinnanteil bei „split"');
  accepts(() => cmd.parseTransferUpdate({ id: 't1', expectedRevision: 3, agentPrice: 600 }),
    'REQUEST …die Aenderung nur mit dem Unterschied');
  accepts(() => cmd.parseTransferReturn({ id: 't1', expectedRevision: 3 }),
    'REQUEST …und die Rueckgabe mit nichts als Kennung und Fassung');
}

// ── 4) Kein Verkauf, keine Abrechnung, kein Status — auch nicht als Knopf ─
{
  ok(!/data-client-edit-|DETAIL_OPS/.test(code('src/components/startup/ClientShell.tsx')),
    'SCOPE R7B PP-7 die Huelle hat keine alten Formulare und Aendern-Knoepfe mehr — nur noch die Anmeldung');
}

// ── 5) Eine Kennung pro Vorsatz ──────────────────────────────────────────
{
  cm.enterClientMode('https://primary.local');
  cm.setClientToken('tok');

  const controller = new CommandSaveController('transfers.mark_returned');
  const a = controller.beginAttempt();
  const timeout = await a.send({ id: 't1', expectedRevision: 3 }, (async () => ({
    status: 504, ok: false, json: async () => ({}),
  })) as never);
  ok(timeout.kind === 'unknown', `IDS eine Zeitgrenze ist ein offener Ausgang (${timeout.kind})`);
  ok(controller.beginAttempt().commandId === a.commandId,
    'IDS ein zweiter Klick benutzt DIESELBE Kennung — die Ware kommt nicht zweimal zurueck');

  const b = controller.beginAttempt();
  const done = await b.send({ id: 't1', expectedRevision: 3 }, (async () => ({
    status: 200, ok: true, json: async () => ({ ok: true, value: { transferId: 't1', replayed: true } }),
  })) as never);
  ok(done.kind === 'ok' && done.replayed === true, 'IDS …und bekommt das eingefrorene Ergebnis');
  ok(controller.beginAttempt().commandId !== b.commandId, 'IDS erst danach beginnt ein neuer Vorsatz');

  const rej = new CommandSaveController('repairs.update');
  const c = rej.beginAttempt();
  const no = await c.send({ id: 'r1', expectedRevision: 1 }, (async () => ({
    status: 409, ok: false, json: async () => ({ error: 'RECORD_CHANGED', message: 'stale' }),
  })) as never);
  ok(no.kind === 'business_error', 'IDS ein frozen Nein beendet den Versuch');
  ok(rej.beginAttempt().commandId !== c.commandId, 'IDS …und der naechste bewusste bekommt eine NEUE Kennung');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central c3f client service ui: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
