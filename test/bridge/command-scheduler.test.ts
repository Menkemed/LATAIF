// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-C1 — eine Reihenfolge für Geschäftsschreibvorgänge, und eine Warteschlange, die ein
// Scheitern übersteht.
// Run: node test/bridge/command-scheduler.test.ts
//
// Warum das überhaupt nötig ist: JavaScript ist einfädig, aber nicht unteilbar. Sobald eine
// Domänenfunktion `await` benutzt, kann eine zweite dazwischen loslaufen. Heute fällt das nicht
// auf, weil nur ein Mensch am Fenster Aufträge auslöst. Mit einem zweiten Rechner und dem
// Mobile-Drain treffen zwei gleichzeitig ein — und dann entscheidet die Reihenfolge, wer bei
// „Menge 1, zwei Verkäufe" gewinnt.
//
// Die zweite Eigenschaft ist die unauffällige: ein gescheiterter Auftrag darf die Kette nicht
// vergiften. Bliebe der Fehler in ihr, würde ein einziger fachlicher Konflikt jeden weiteren
// Auftrag abweisen — der Rechner stünde nach dem ersten „Bestand ist weg" still.
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
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

const { CommandScheduler, businessWriteScheduler, runExclusive, inExclusiveSlot } =
  await import('../../src/core/bridge/command-scheduler.ts');
const { executeCommand, registerCommand, knownCommands, BusinessError, OP_PROBE } =
  await import('../../src/core/bridge/command-registry.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
/** Läuft einen Baum ab und übergibt jede TypeScript-Datei mit ihrem Inhalt. */
function walk(dir: string, visit: (p: string, text: string) => void): void {
  for (const name of readdirSync(dir)) {
    const p = resolvePath(dir, name);
    if (statSync(p).isDirectory()) { walk(p, visit); continue; }
    if (!/\.(ts|tsx)$/.test(name)) continue;
    visit(p, readFileSync(p, 'utf8'));
  }
}

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── 1) Zwei gleichzeitig eintreffende Aufträge laufen nacheinander ─────────
{
  const s = new CommandScheduler();
  const order: string[] = [];
  let inside = 0, peakInside = 0;

  const job = (name: string, ms: number) => s.run(async () => {
    inside += 1;
    if (inside > peakInside) peakInside = inside;
    order.push(name + ':start');
    // Genau der Punkt, an dem sich ohne Reihung zwei Aufträge verschränken würden.
    await tick(ms);
    order.push(name + ':end');
    inside -= 1;
    return name;
  });

  // Beide im SELBEN Tick angenommen — so kommen sie über die Brücke auch an.
  const a = job('A', 20);
  const b = job('B', 1);
  const c = job('C', 1);
  const got = await Promise.all([a, b, c]);

  ok(got.join(',') === 'A,B,C', `SEQ jeder bekommt sein eigenes Ergebnis (${got.join(',')})`);
  ok(peakInside === 1, `SEQ nie mehr als EIN Auftrag aktiv (Spitze ${peakInside})`);
  ok(s.peakConcurrency() === 1, `SEQ …auch nach der Zählung der Warteschlange (${s.peakConcurrency()})`);
  ok(order.join(' ') === 'A:start A:end B:start B:end C:start C:end',
    `SEQ und die Reihenfolge ist die der Annahme, nicht die der Laufzeit (${order.join(' ')})`);
  // Ohne Reihung wäre B fertig, lange bevor A anfängt — das ist der Unterschied, der zählt.
  ok(order.indexOf('B:start') > order.indexOf('A:end'), 'SEQ B beginnt erst, wenn A fertig ist');
  ok(s.stats().depth === 0 && s.stats().running === false, 'SEQ danach ist die Kette leer');
}

// ── 2) Ein Scheitern erreicht seinen Aufrufer — und nur den ───────────────
{
  const s = new CommandScheduler();
  const order: string[] = [];

  const bad = s.run(async () => { order.push('bad'); await tick(5); throw new Error('STOCK_UNAVAILABLE'); });
  const good = s.run(async () => { order.push('good'); return 'ok'; });
  const later = s.run(() => { order.push('later'); return 'still here'; });

  let caught: string | null = null;
  try { await bad; } catch (e) { caught = (e as Error).message; }

  ok(caught === 'STOCK_UNAVAILABLE', `FAIL der Fehler geht an seinen Aufrufer (${caught})`);
  ok(await good === 'ok', 'FAIL der nächste läuft danach normal weiter');
  ok(await later === 'still here', 'FAIL …und der danach auch — die Kette ist nicht vergiftet');
  ok(order.join(',') === 'bad,good,later', `FAIL in unveränderter Reihenfolge (${order.join(',')})`);
  ok(s.stats().failed === 1 && s.stats().completed === 3,
    `FAIL genau einer ist gescheitert, drei sind durch (${s.stats().failed}/${s.stats().completed})`);
}

// ── 3) Ein synchroner Wurf bricht die Kette ebenfalls nicht ───────────────
{
  const s = new CommandScheduler();
  let caught = false;
  const boom = s.run(() => { throw new Error('sofort'); });
  try { await boom; } catch { caught = true; }
  const after = await s.run(() => 'weiter');
  ok(caught && after === 'weiter', 'FAIL auch ein sofortiger Wurf hält die Warteschlange nicht auf');
}

// ── 4) Es gibt genau EINE Warteschlange ───────────────────────────────────
{
  const a = await runExclusive(() => 'x');
  ok(a === 'x', 'ONE die Kurzform führt aus');
  ok(businessWriteScheduler.stats().completed >= 1, 'ONE …und zwar über die gemeinsame Warteschlange');
  const s = src('src/core/bridge/command-scheduler.ts');
  ok((s.match(/new CommandScheduler\(\)/g) || []).length === 1,
    'ONE im Produktcode wird genau eine angelegt — eine zweite waere eine zweite Reihenfolge');
  const others = src('src/core/bridge/command-registry.ts');
  ok(!/new CommandScheduler\(/.test(others), 'ONE und niemand baut sich eine eigene');
}

// ── 5) Die Auftragsliste: nur was registriert ist, läuft ──────────────────
{
  ok(knownCommands().join(',') === OP_PROBE, `REG C1 gibt genau eine Operation frei (${knownCommands().join(',')})`);

  const unknown = await executeCommand('invoiceStore.createInvoice', {});
  ok(unknown.kind === 'infrastructure_error' && unknown.code === 'BRIDGE_OP_NOT_REGISTERED',
    `REG ein fremder Name wird abgewiesen (${JSON.stringify(unknown)})`);

  const probe = await executeCommand(OP_PROBE, { echo: 'hallo' });
  ok(probe.kind === 'ok' && (probe.value as { echo?: unknown }).echo === 'hallo',
    `REG die Probe antwortet mit dem, was sie bekam (${JSON.stringify(probe)})`);
}

// ── 6) Die drei Ausgänge bleiben getrennt ─────────────────────────────────
//
// Ein fachliches Nein wiederholt man nicht, eine Störung schon. Deshalb dürfen sie nicht
// denselben Ausgang benutzen — und die Innereien einer Störung bleiben beim Betreiber.
{
  registerCommand('test.business', {
    kind: 'probe',
    handler: () => { throw new BusinessError('STOCK_UNAVAILABLE', 'nichts mehr da'); },
  });
  registerCommand('test.broken', {
    kind: 'probe',
    handler: () => { throw new Error('SELECT * FROM secrets failed at line 42'); },
  });

  const biz = await executeCommand('test.business', {});
  ok(biz.kind === 'business_error' && biz.code === 'STOCK_UNAVAILABLE' && biz.message === 'nichts mehr da',
    `OUT ein fachliches Nein bleibt ein fachliches Nein (${JSON.stringify(biz)})`);

  const broken = await executeCommand('test.broken', {});
  ok(broken.kind === 'infrastructure_error' && broken.code === 'BRIDGE_COMMAND_FAILED',
    `OUT eine Störung bekommt einen Code (${JSON.stringify(broken)})`);
  ok(!JSON.stringify(broken).includes('secrets'),
    'OUT …und keine Innereien reisen zum Aufrufer');

  // Und beides hält die Warteschlange am Leben.
  const after = await executeCommand(OP_PROBE, { echo: 1 });
  ok(after.kind === 'ok', 'OUT nach beiden Fehlern läuft der nächste Auftrag');
}

// ── 7) Verändernde Aufträge werden gereiht, lesende nicht ─────────────────
{
  let inside = 0, peak = 0;
  const busy = async () => { inside += 1; peak = Math.max(peak, inside); await tick(10); inside -= 1; return { ok: true }; };
  registerCommand('test.reads', { kind: 'read', handler: busy });
  await Promise.all([executeCommand('test.reads', {}), executeCommand('test.reads', {}), executeCommand('test.reads', {})]);
  ok(peak > 1, `READ Lesen darf gleichzeitig laufen — eine Liste haelt keinen Verkauf auf (Spitze ${peak})`);

  inside = 0; peak = 0;
  registerCommand('test.writes', { kind: 'probe', handler: busy });
  await Promise.all([executeCommand('test.writes', {}), executeCommand('test.writes', {}), executeCommand('test.writes', {})]);
  ok(peak === 1, `WRITE Schreiben nie (Spitze ${peak})`);
}

// ── 8) Mobile: Annahme bleibt parallel, die Buchung wird geordnet ─────────
//
// Das ist der Vertrag, der nicht kippen darf: mehrere Handys laden gleichzeitig hoch. Die
// ANNAHME (HTTP → Ablage → Rust-Eingang) läuft weiter nebeneinander; nur die endgültige
// Geschäftsbuchung des Drains reiht sich ein.
{
  const s = new CommandScheduler();
  let uploadsInFlight = 0, uploadPeak = 0;
  let commitsInFlight = 0, commitPeak = 0;
  const accepted: number[] = [];
  const committed: number[] = [];

  const acceptUpload = async (n: number) => {
    uploadsInFlight += 1; uploadPeak = Math.max(uploadPeak, uploadsInFlight);
    await tick(5);                       // Bytes schreiben, Eingang vermerken
    accepted.push(n);
    uploadsInFlight -= 1;
  };
  const commitBusiness = (n: number) => s.run(async () => {
    commitsInFlight += 1; commitPeak = Math.max(commitPeak, commitsInFlight);
    await tick(3);                       // Produkt + Medien in einem durablen Schritt
    committed.push(n);
    commitsInFlight -= 1;
  });

  // Fünf Handys gleichzeitig.
  await Promise.all([1, 2, 3, 4, 5].map(acceptUpload));
  ok(uploadPeak === 5, `MOBILE fuenf Uploads wurden gleichzeitig angenommen (Spitze ${uploadPeak})`);
  ok(accepted.length === 5, 'MOBILE …und alle fuenf sind angekommen');

  await Promise.all(accepted.map(commitBusiness));
  ok(commitPeak === 1, `MOBILE aber gebucht wird einer nach dem anderen (Spitze ${commitPeak})`);
  ok(committed.length === 5, 'MOBILE …und keiner geht dabei verloren');

  // Und am echten Code: der Eingang kennt die Bruecke nicht.
  const ingress = src('src-tauri/src/sync/mobile_upload.rs');
  ok(!/bridge::/.test(ingress), 'MOBILE der Rust-Eingang laeuft nicht ueber die Kommandobruecke');
  const routes = src('src-tauri/src/sync/routes.rs');
  ok(/\.route\("\/mobile\/upload", post\(mobile_upload_ingress\)\)/.test(routes),
    'MOBILE …und seine Route ist unveraendert');
  ok(!/mobile_upload_ingress[\s\S]{0,400}bridge/.test(routes), 'MOBILE kein Umweg ueber die Bruecke');
}

// ── 9) Die Verdrahtung im Renderer ────────────────────────────────────────
{
  const listener = src('src/core/bridge/bridge-listener.ts');
  // Erst zuhören, DANN bereit melden — umgekehrt gäbe es ein Fenster, in dem Rust sendet und
  // niemand horcht, und genau dieser Auftrag liefe in die Zeitgrenze.
  const listenAt = listener.indexOf('await w.listen(');
  const announceAt = listener.indexOf("await w.invoke('bridge_announce_ready')");
  ok(listenAt > 0 && announceAt > listenAt, 'WIRED zuerst zuhoeren, dann bereit melden');
  ok(/if \(generation !== null\) return;/.test(listener), 'WIRED eine Anmeldung pro Renderer-Leben');
  ok(/env\.generation !== generation/.test(listener), 'WIRED ein Auftrag aus einem anderen Leben wird verworfen');
  ok(/'bridge_reply'/.test(listener) && /generation: env\.generation/.test(listener),
    'WIRED jede Antwort traegt die Generation ihres Auftrags');

  const registry = src('src/core/bridge/command-registry.ts');
  const shared = registry.replace(/\s+/g, ' ');
  const readAt = shared.indexOf("if (spec.kind === 'read')");
  const sharedAt = shared.indexOf('businessWriteScheduler.runShared');
  const probeAt = shared.indexOf("else if (spec.kind === 'probe')");
  const exclusiveAt = shared.indexOf('await runExclusive(');
  ok(readAt > 0 && sharedAt > readAt && sharedAt < probeAt && exclusiveAt > probeAt,
    'WIRED Lesen laeuft in der geteilten Spur, alles andere ausschliesslich');
  // C1 gibt ausdrücklich keinen produktiven Schreibvorgang frei.
  for (const forbidden of ['createInvoice', 'createProduct', 'createPurchase', 'sellProduct', 'createConsignment']) {
    ok(!registry.includes(forbidden), `WIRED C1 registriert keinen produktiven Schreibvorgang (${forbidden})`);
  }
}

// ── 10) Die Schreiber, die es wirklich gibt ──────────────────────────────
//
// Der Zweck dieses Abschnitts ist nicht, 18.000 Zeilen umzubauen, sondern zu belegen, WO der
// Wickelpunkt liegt. Befund: Import, KI und die lokale Oberfläche schreiben alle über
// Store-Aktionen, und der Mobile-Drain tut es ebenfalls (`createProductWithMedia`). Damit deckt
// EIN Wickelpunkt — die Store-Aktion — fünf der sechs Quellen ab. Nur die Automatisierung
// schreibt daneben, mit eigenem SQL.
{
  const importPage = src('src/pages/settings/ImportPage.tsx');
  ok(/useProductStore\(\)/.test(importPage) && /createProduct\(/.test(importPage),
    'COVER der Excel-Import schreibt ueber eine Store-Aktion, nicht selbst');
  ok(!/db\.run\(/.test(importPage), 'COVER …und fuehrt kein eigenes SQL aus');

  const wiring = src('src/core/media/mobile-upload-wiring.ts');
  ok(/triggerMobileUploadDrainSafe|triggerMobileUploadDrainPostAuth|armMobileDrainPoller/.test(wiring),
    'COVER der Mobile-Drain hat einen benennbaren Einstieg');
  const drain = src('src/core/media/mobile-upload-drain.ts');
  ok(/createProductWithMedia/.test(drain), 'COVER …und bucht ueber dieselbe Store-Aktion wie die Oberflaeche');

  // Die eine Quelle, die NICHT ueber Store-Aktionen laeuft — offen benannt statt uebersehen.
  const auto = src('src/core/automation/automation-handlers.ts');
  const sweep = src('src/core/automation/daily-sweep.ts');
  ok(/db\.run\(/.test(auto) && /db\.run\(/.test(sweep),
    'COVER die Automatisierung schreibt mit eigenem SQL — sie braucht in C3 ihre eigene Reihung');
  ok(/export function initAutomation/.test(auto) && /export function runDailySweep/.test(sweep),
    'COVER …hat dafuer aber genau zwei Einstiege');

  // Und die Bruecke selbst ist schon drin.
  ok(/runExclusive/.test(src('src/core/bridge/command-registry.ts')),
    'COVER der Weg vom zweiten Rechner ist bereits gereiht');
}

// ── 11) Die Alt-Nummernkreise, genau gezählt ──────────────────────────────
//
// C1 fand hier vier produktive Aufrufstellen von `getNextNumber` — `MAX(Bestand des Jahres) + 1`,
// genau die Bauart, an der der Pull des Kollegen hängenblieb (`TRF-2026-00020` zweimal vergeben →
// UNIQUE → Batch-Rollback → Stillstand). C3A hat sie umgestellt. Was hier steht, ist deshalb
// nicht mehr „noch offen", sondern „nachweislich keine mehr" — und dieselbe Zählung fällt wieder
// auf, wenn jemand den alten Weg zurückholt.
{
  const helpers = src('src/core/db/helpers.ts');
  ok(/export function getNextNumber/.test(helpers), 'SEQ der Altweg existiert noch als Funktion…');

  // …aber ohne produktive Aufrufer. Kommentare zählen nicht mit.
  const callers: string[] = [];
  for (const dir of ['src/stores', 'src/core', 'src/pages', 'src/components']) {
    walk(resolvePath(repo, dir), (p, text) => {
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (t.startsWith('//') || t.startsWith('*')) continue;
        if (/getNextNumber\(/.test(line) && !/export function getNextNumber/.test(line)) {
          callers.push(p.slice(repo.length + 1).split('\\').join('/'));
        }
      }
    });
  }
  ok(callers.length === 0, `SEQ und KEINEN produktiven Aufrufer mehr (${[...new Set(callers)].join(', ') || 'keiner'})`);

  // Die vier Kreise stehen jetzt im durablen Zähler, mit ihrem alten Format.
  const legacy = src('src/core/db/legacy-sequences.ts');
  for (const [type, table, column] of [
    ['CON', 'consignments', 'consignment_number'],
    ['OFF', 'offers', 'offer_number'],
    ['ORD', 'orders', 'order_number'],
    ['REP', 'repairs', 'repair_number'],
  ]) {
    ok(legacy.includes(`docType: '${type}', table: '${table}', column: '${column}'`),
      `SEQ ${type} ist als durabler Kreis beschrieben (${table}.${column})`);
  }
  ok(/export const LEGACY_PADDING = 5;/.test(legacy), 'SEQ …fuenfstellig wie bisher');
  ok(!legacy.includes("docType: 'TRF'"), 'SEQ und der bereits migrierte Transfer bleibt bei sich');

  for (const [file, type] of [
    ['src/stores/consignmentStore.ts', 'CON'], ['src/stores/offerStore.ts', 'OFF'],
    ['src/stores/orderStore.ts', 'ORD'], ['src/stores/repairStore.ts', 'REP'],
  ]) {
    const t = src(file);
    ok(t.includes(`legacySpec('${type}')`) && t.includes(`getNextDocumentNumber('${type}')`),
      `SEQ ${file} zieht ${type} aus dem Zaehler`);
  }

  // Der Zähler selbst: erhöht ZUERST und liest danach — keine Lücke zwischen Lesen und Schreiben.
  const upd = helpers.indexOf('SET next_number = next_number + 1');
  const sel = helpers.indexOf('SELECT', upd);
  ok(upd > 0 && sel > upd, 'SEQ der durable Zaehler erhoeht vor dem Lesen');
  let durable = 0;
  walk(resolvePath(repo, 'src'), (_p, text) => {
    durable += (text.match(/getNextDocumentNumber\(/g) || []).length;
  });
  ok(durable >= 24, `SEQ und er ist der einzige Weg zu einer Belegnummer (${durable} Aufrufe)`);
}

// ── 12) Die Sperre ist eine Klasse PLUS eine namentliche Zulassung ────────
//
// Ein Verbot von fünf bekannten Namen hätte ein später hinzugefügtes `invoice.save` durchgelassen.
// Deshalb entscheidet zuerst die KLASSE — und seit C3B zusätzlich der NAME: freigegeben ist
// `invoices.create` und sonst nichts. Ein Schalter hätte in einem Zug alles mitgenommen.
{
  const { ALLOWED_MUTATIONS } = await import('../../src/core/bridge/command-registry.ts');
  ok(ALLOWED_MUTATIONS.length === 1 && ALLOWED_MUTATIONS[0] === 'invoices.create',
    `GATE genau ein veraendernder Name ist freigegeben (${ALLOWED_MUTATIONS.join(', ')})`);

  for (const name of ['invoice.save', 'sale.commit', 'irgendwas.ganz.neu']) {
    let threw: string | null = null;
    try {
      registerCommand(name, { kind: 'mutation', handler: () => ({ ok: true }) });
    } catch (e) { threw = (e as Error).message; }
    ok(threw !== null && /refusing to register/.test(threw),
      `GATE ein neuer Name mit Mutations-Klasse wird abgewiesen (${name}: ${threw ? 'refused' : 'ACCEPTED'})`);
    ok(!knownCommands().includes(name), `GATE …und ist nicht registriert (${name})`);
  }

  // Und der Riegel steht im Produktcode, nicht nur in diesem Test.
  const registry = src('src/core/bridge/command-registry.ts');
  ok(/if \(spec\.kind === 'mutation' && !ALLOWED_MUTATIONS\.includes\(op\)\)/.test(registry),
    'GATE der Riegel greift beim Registrieren');
  // Im PRODUKTCODE wird genau eine Operation registriert — die Testhelfer oben zaehlen nicht mit.
  const prod = registry.split(/\r?\n/).filter((l) => l.startsWith('registerCommand(')).length;
  ok(prod === 1, `GATE der Produktcode registriert genau eine Operation (${prod})`);
  ok(registry.includes('registerCommand(OP_PROBE, {'), 'GATE …und das ist die Probe');
}

// ── 13) Ein verlorener Antwortweg heisst NICHT „nicht passiert" ───────────
//
// Der gefährlichste Irrtum in dieser Schicht: 504 als „fehlgeschlagen" zu lesen. Der Auftrag war
// beim Renderer; der kann ihn ausgeführt UND gespeichert haben, und nur die Antwort ging verloren.
// Wer daraufhin wiederholt, bucht zweimal. Hier wird genau dieser Ablauf nachgestellt.
{
  const s = new CommandScheduler();
  let domainExecutions = 0;
  // Die „Buchung": zählt genau einmal hoch und ist danach dauerhaft.
  const commit = () => s.run(async () => { await tick(2); domainExecutions += 1; return { committed: true }; });

  // 1) Auftrag zugestellt, 2) Buchung läuft durch, 3) Antwort geht verloren.
  const result = await commit();
  ok(result.committed === true && domainExecutions === 1,
    `UNKNOWN die Buchung ist passiert (${domainExecutions}x)`);

  // Der Aufrufer draussen sieht davon nichts — er bekam eine Zeitgrenze.
  const seenByCaller = { ok: false, error: 'BRIDGE_TIMEOUT', outcome: 'unknown' };
  ok(seenByCaller.outcome === 'unknown',
    'UNKNOWN …aber der Client sieht nur, dass er es NICHT weiss');
  ok(seenByCaller.outcome !== 'not_executed',
    'UNKNOWN und ausdruecklich NICHT \"ist nicht passiert\"');

  // Eine blinde Wiederholung wuerde ein zweites Mal buchen — genau deshalb ist sie gesperrt.
  await commit();
  ok(domainExecutions === 2,
    `UNKNOWN eine blinde Wiederholung bucht wirklich ein zweites Mal (${domainExecutions}x) — deshalb`
    + ' bleibt jede veraendernde Fernoperation zu, bis der durable Nachweis steht');

  // Und das ist der Grund, warum C1 nichts Veraenderndes registrieren kann.
  let refused = false;
  try { registerCommand('sale.retryable', { kind: 'mutation', handler: () => ({ ok: true }) }); }
  catch { refused = true; }
  ok(refused, 'UNKNOWN …und genau das erzwingt die Registrierungssperre');
}

// ── 13) Wiedereintritt: der Auftrag, der sich selbst anstellt ─────────────
//
// Sobald ein Fernauftrag eine Store-Aktion ruft, die ihrerseits `runExclusive` benutzt (der
// Produktweg tut das), stellt sich das Haus hinter sich selbst an: der innere Platz wird erst
// frei, wenn der aeussere fertig ist — und der wartet auf den inneren. Ein Stillstand, der in
// keinem Fehlerprotokoll auftaucht, weil nichts scheitert; es geht nur nie weiter.
{
  let inner = 0;
  const before = businessWriteScheduler.peakConcurrency();
  const out = await Promise.race([
    runExclusive(async () => {
      // Genau der verschachtelte Aufruf, an dem es sich sonst verklemmt.
      return await runExclusive(() => { inner += 1; return 42; });
    }),
    new Promise((r) => setTimeout(() => r('DEADLOCK'), 3000)),
  ]);
  ok(out === 42, `REENTRY der verschachtelte Auftrag laeuft durch (${out})`);
  ok(inner === 1, `REENTRY genau einmal (${inner})`);
  ok(businessWriteScheduler.peakConcurrency() === Math.max(1, before),
    `REENTRY und die Zusage bleibt: hoechstens EIN Auftrag gleichzeitig (${businessWriteScheduler.peakConcurrency()})`);
  ok(!inExclusiveSlot(), 'REENTRY nach dem Auftrag ist der Platz wieder frei');

  // Auch wenn er scheitert, bleibt kein Flag stehen — sonst liefe der naechste Auftrag
  // ungeschuetzt an der Warteschlange vorbei.
  let threw = false;
  try { await runExclusive(() => { throw new Error('boom'); }); } catch { threw = true; }
  ok(threw && !inExclusiveSlot(), 'REENTRY und ein Fehler laesst den Platz nicht als belegt zurueck');

  // Und der Grund steht im Produktcode, nicht nur hier.
  const sched = src('src/core/bridge/command-scheduler.ts');
  ok(/if \(insideExclusive\) return Promise\.resolve\(\)\.then\(task\);/.test(sched),
    'REENTRY der verschachtelte Aufruf laeuft im selben Platz, nicht als zweiter');
}
console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central c1 bridge: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
console.log('CENTRAL_PRIMARY_COMMAND_SCHEDULER_PROVED');
console.log('CENTRAL_PRIMARY_MOBILE_SINGLE_WRITER_COMPAT_PROVED');
console.log('CENTRAL_PRIMARY_WRITER_COVERAGE_PROVED');
console.log('CENTRAL_LEGACY_DOCUMENT_SEQUENCE_SCOPE_PROVED');
