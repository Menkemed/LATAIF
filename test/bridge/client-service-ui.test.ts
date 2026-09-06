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
const ui = await import('../../src/core/bridge/client-service-request.ts');
// Und der ECHTE Prüfer des Primary — keine Nachbildung.
const cmd = await import('../../src/core/bridge/service-commands.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const code = (p: string): string => src(p).split(/\r?\n/)
  .filter((l) => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')); })
  .join('\n');

const REPAIR_FORM = 'src/components/client/ClientRepairForm.tsx';
const TRANSFER_FORM = 'src/components/client/ClientTransferForm.tsx';
const SHELL = 'src/components/startup/ClientShell.tsx';
const FORMS = [REPAIR_FORM, TRANSFER_FORM];

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
    if (/\bgetDatabase\b|\binitDatabase\b|useRepairStore|useAgentStore|useProductStore|useCustomerStore/.test(stripped)) {
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

  ok(seen.size > 4, `DBLESS der Importbaum wurde wirklich abgelaufen (${seen.size} Dateien)`);
  ok(offenders.length === 0,
    `DBLESS nirgends darin wird die lokale Datenbank oder ein Business-Store benutzt (${offenders.join(', ') || 'keine'})`);
  ok([...seen].every((f) => !f.startsWith('src/core/db/')), 'DBLESS und keine Datei aus der Datenschicht');
  for (const f of FORMS) {
    ok(!/outbox|localStorage|indexedDB/i.test(code(f)), `DBLESS ${f} legt keinen eigenen Ausgangskorb an`);
    ok(/remoteRead/.test(src(f)), `DBLESS ${f} holt seine Daten aus der Fernquelle`);
    ok(/client-service-request/.test(src(f)), `WIRED ${f} faehrt genau den Vertrag, der hier geprueft wird`);
    ok(/CommandSaveController/.test(code(f)), `WIRED ${f} benutzt den Waechter ueber die Kennungen`);
    ok(!/new CommandSaveAttempt\(/.test(code(f)), `WIRED ${f} erzeugt keine Kennung selbst`);
  }
  // Zwei Vorsätze, zwei Wächter: ein offener Änderungsversuch darf nie als Rückgabe weiterlaufen.
  const tf = code(TRANSFER_FORM);
  ok(/const editController = useMemo/.test(tf) && /const returnController = useMemo/.test(tf),
    'WIRED aendern und zuruecknehmen haben je einen eigenen Waechter');
}

// ── 2) Was die Formulare schicken, hält der echte Prüfer aus ──────────────
{
  const d = {
    ...ui.EMPTY_REPAIR, customerId: 'cust-1', itemBrand: 'Rolex', itemModel: 'Submariner',
    issueDescription: 'Krone klemmt', estimatedCost: '40', chargeToCustomer: '100',
  };
  const body = ui.repairCreateRequest(d);
  cmd.parseRepairCreate(body);
  const keys = Object.keys(body).sort().join(',');
  ok(keys === 'chargeToCustomer,customerId,estimatedCost,issueDescription,itemBrand,itemModel,repairType,taxScheme',
    `REQUEST nur die Eingabe (${keys})`);
  ok(!('repairNumber' in body) && !('status' in body) && !('margin' in body) && !('voucherCode' in body),
    'REQUEST Nummer, Status, Marge und Gutscheincode bestimmt der Primary');

  // Die Marge ist eine ANZEIGE, kein Feld.
  ok(ui.previewMargin({ repairType: 'internal', estimatedCost: '40', actualCost: '', internalCost: '', chargeToCustomer: '100' }) === 60,
    'PREVIEW der Bildschirm rechnet 100 − 40 = 60…');
  ok(ui.previewMargin({ repairType: 'hybrid', estimatedCost: '40', actualCost: '', internalCost: '10', chargeToCustomer: '100' }) === 50,
    'PREVIEW …und bei „hybrid" zaehlen beide Kostenteile (100 − 50)');
  ok(!JSON.stringify(body).includes('margin'), 'PREVIEW …und schickt das Ergebnis NICHT mit');

  const base = { diagnosis: '', estimatedCost: '40', actualCost: '', internalCost: '40', chargeToCustomer: '100', repairType: 'internal', externalVendor: '', workshopSupplierId: '', estimatedReady: '', itemBrand: 'Rolex', itemModel: 'Submariner', itemSerial: '', notes: '' };
  const patch = ui.repairUpdateRequest('r1', 5, base, { ...base, chargeToCustomer: '150' });
  ok(Object.keys(patch).sort().join(',') === 'chargeToCustomer,expectedRevision,id',
    `REQUEST beim Aendern reist nur der Unterschied (${Object.keys(patch).join(',')})`);
  ok(patch.expectedRevision === 5, 'REQUEST …und genau die gelesene Fassung');
  cmd.parseRepairUpdate(patch);
  const cleared = ui.repairUpdateRequest('r1', 5, base, { ...base, actualCost: '' , estimatedCost: '' });
  ok(cleared.estimatedCost === null, 'REQUEST ein geleertes Zahlenfeld heisst „kein Wert", nicht 0');
  cmd.parseRepairUpdate(cleared);
  ok(ui.changeCount(ui.repairUpdateRequest('r1', 5, base, base)) === 0, 'FORM ohne Aenderung gibt es nichts zu schicken');
  ok(!ui.repairComplete({ ...ui.EMPTY_REPAIR, customerId: 'c' }), 'FORM ohne Problembeschreibung kein Speichern');
  ok(ui.repairComplete(d), 'FORM mit Kunde und Beschreibung schon');
}

// ── 3) Der Transferrumpf: der Client nennt weder Agent noch Nummer ────────
{
  const d = { ...ui.EMPTY_TRANSFER, customerId: 'cust-1', productId: 'p1', agentPrice: '500' };
  const body = ui.transferCreateRequest(d);
  cmd.parseTransferCreate(body);
  const keys = Object.keys(body).sort().join(',');
  ok(keys === 'agentPrice,customerId,productId,settlementModel', `REQUEST nur die Eingabe (${keys})`);
  ok(!JSON.stringify(body).includes('agentId') && !JSON.stringify(body).includes('transferNumber'),
    'REQUEST weder Agent noch Transfernummer — beides gehoert dem Primary');

  // Der Anteil reist nur mit SEINEM Modell.
  ok(!('excessSplitPct' in ui.transferCreateRequest({ ...d, settlementModel: 'full', excessSplitPct: '70' })),
    'REQUEST bei „full" reist kein Gewinnanteil mit');
  const split = ui.transferCreateRequest({ ...d, settlementModel: 'split', excessSplitPct: '70' });
  ok(split.excessSplitPct === 70, 'REQUEST bei „split" schon');
  cmd.parseTransferCreate(split);

  const base = { agentPrice: '500', minimumPrice: '', returnBy: '', notes: '' };
  const patch = ui.transferUpdateRequest('t1', 3, base, { ...base, agentPrice: '600' });
  ok(Object.keys(patch).sort().join(',') === 'agentPrice,expectedRevision,id',
    `REQUEST beim Aendern reist nur der Unterschied (${Object.keys(patch).join(',')})`);
  cmd.parseTransferUpdate(patch);

  const ret = ui.transferReturnRequest('t1', 3);
  ok(Object.keys(ret).sort().join(',') === 'expectedRevision,id',
    'REQUEST die Rueckgabe traegt nichts als Kennung und Fassung');
  cmd.parseTransferReturn(ret);
}

// ── 4) Kein Verkauf, keine Abrechnung, kein Status — auch nicht als Knopf ─
{
  const tf = code(TRANSFER_FORM);
  ok(!/mark_sold|markTransferSold|transfers\.delete|convert_to_invoice|mark_settled/.test(tf),
    'SCOPE das Transferformular bietet weder Verkauf noch Abrechnung noch Loeschen an');
  const rf = code(REPAIR_FORM);
  ok(!/repairs\.update_status|updateStatus|repairs\.delete/.test(rf),
    'SCOPE das Reparaturformular wechselt keinen Status — der bucht Verbindlichkeiten');
  ok(/data-client-repair-status/.test(rf), 'SCOPE …es ZEIGT ihn aber, statt ihn zu verschweigen');
  const shell = code(SHELL);
  ok(/data-client-edit-repair/.test(shell) && /data-client-edit-transfer/.test(shell),
    'SHELL beide haben einen Aendern-Knopf an einer gelesenen Zeile');
  ok(/setEditRepairId\(s\(detail\.id\)\)/.test(shell) && /setEditTransferId\(s\(detail\.id\)\)/.test(shell),
    'SHELL …und er beginnt an einer gelesenen Zeile, nicht an einem Eingabefeld');
  for (const op of ['repairs.list', 'repairs.get', 'transfers.list', 'transfers.get']) {
    ok(shell.includes(`'${op}'`), `SHELL der Bereich benutzt ${op}`);
  }
}

// ── 5) Eine Kennung pro Vorsatz ──────────────────────────────────────────
{
  cm.enterClientMode('https://primary.local');
  cm.setClientToken('tok');

  const controller = new CommandSaveController('transfers.mark_returned');
  const a = controller.beginAttempt();
  const timeout = await a.send(ui.transferReturnRequest('t1', 3), (async () => ({
    status: 504, ok: false, json: async () => ({}),
  })) as never);
  ok(timeout.kind === 'unknown', `IDS eine Zeitgrenze ist ein offener Ausgang (${timeout.kind})`);
  ok(controller.beginAttempt().commandId === a.commandId,
    'IDS ein zweiter Klick benutzt DIESELBE Kennung — die Ware kommt nicht zweimal zurueck');

  const b = controller.beginAttempt();
  const done = await b.send(ui.transferReturnRequest('t1', 3), (async () => ({
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
