// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-C2 — ein zweiter Rechner, der liest und sonst nichts.
// Run: node test/bridge/client-read-mode.test.ts
//
// Drei Zusagen, die alle drei kippen könnten, ohne dass es jemand merkt:
//
//   • Der Client legt **keine** Geschäftsdatenbank an. Nicht beim Start, nicht bei Netzverlust,
//     nicht „nur zum Zwischenspeichern". Täte er es, gäbe es zwei Wahrheiten — und genau das
//     sollte der ganze Umbau abschaffen.
//   • Gelesen wird aus der **Autorität**, nicht aus der Datei auf der Platte. Die hinkt hinterher:
//     `saveDatabase()` ist fire-and-forget mit über 200 Aufrufern.
//   • Lesen läuft **nicht mitten in einer Buchung**. Rechnungen und Einkäufe sind von außen
//     unteilbar (ihre Stores enthalten kein `await`), der Produktweg mit Medien ist es NICHT.
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

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
/** Derselbe Text ohne Kommentare: ein Satz, der etwas ERKLAERT, ist kein Aufruf. */
const code = (p: string): string => src(p)
  .split(/\r?\n/)
  .filter((l) => {
    const t = l.trim();
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
  })
  .join('\n');
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

// Ein Browser-Ersatz, damit `client-mode` unter node laeuft. Nur Schluessel und Werte, kein Zauber.
const memory = new Map<string, string>();
(globalThis as { window?: unknown }).window = {
  localStorage: {
    getItem: (k: string) => (memory.has(k) ? memory.get(k)! : null),
    setItem: (k: string, v: string) => { memory.set(k, String(v)); },
    removeItem: (k: string) => { memory.delete(k); },
  },
};

const cm = await import('../../src/core/bridge/client-mode.ts');
const rr = await import('../../src/core/bridge/remote-read.ts');
const { CommandScheduler } = await import('../../src/core/bridge/command-scheduler.ts');

// ── 1) Die Weiche: ohne Wahl bleibt alles wie es war ──────────────────────
{
  ok(cm.runtimeMode() === 'primary', 'MODE ohne ausdrueckliche Wahl ist dieser Rechner der Primary');
  ok(cm.isClientMode() === false, 'MODE …und kein Client');
  ok(cm.clientConfig() === null, 'MODE es ist kein Server hinterlegt');

  cm.enterClientMode('192.168.1.5:3001');
  ok(cm.isClientMode(), 'MODE nach der Wahl ist er Client');
  ok(cm.clientConfig()?.serverUrl === 'http://192.168.1.5:3001',
    `MODE die Adresse wird vervollstaendigt (${cm.clientConfig()?.serverUrl})`);
  cm.enterClientMode('https://pc1.local:3443/');
  ok(cm.clientConfig()?.serverUrl === 'https://pc1.local:3443',
    `MODE …und der Schraegstrich am Ende faellt weg (${cm.clientConfig()?.serverUrl})`);

  let threw = false;
  try { cm.enterClientMode('   '); } catch { threw = true; }
  ok(threw, 'MODE eine leere Adresse ist keine Adresse');

  cm.leaveClientMode();
  ok(!cm.isClientMode() && cm.clientConfig() === null, 'MODE und der Weg zurueck loescht den Kontrollzustand');
}

// ── 2) Der Client oeffnet KEINE Geschaeftsdatenbank ───────────────────────
//
// Das ist die eine Zusage, die man nicht an einem Screenshot erkennt. Deshalb wird sie an der
// echten Startreihenfolge und an den Modulen selbst geprueft.
{
  const app = src('src/App.tsx');
  const clientAt = app.indexOf('if (isClientMode()) {');
  const firstRunAt = app.indexOf('isFirstRunPending().then(');
  const initAt = app.indexOf('    initDatabase()');
  ok(clientAt > 0 && clientAt < firstRunAt, 'DBLESS die Client-Weiche kommt VOR der Erstlauf-Frage');
  ok(clientAt < initAt, 'DBLESS …und vor jedem `initDatabase()`');
  ok(/if \(isClientMode\(\)\) \{[\s\S]{0,220}return \(\) => \{ cancelled = true; \};/.test(app),
    'DBLESS im Client-Modus kehrt der Start zurueck, ohne etwas zu oeffnen');
  ok(/if \(isClientMode\(\)\) return clientReady \? <ClientShell \/> : null;/.test(app),
    'DBLESS und gerendert wird die Leseoberflaeche, nicht die Anwendung');

  // Die Client-Module duerfen die Datenschicht gar nicht erst kennen.
  for (const f of ['src/core/bridge/client-mode.ts', 'src/core/bridge/remote-read.ts', 'src/components/startup/ClientShell.tsx']) {
    const t = code(f);
    ok(!/getDatabase|initDatabase|@\/core\/db\//.test(t), `DBLESS ${f} fasst die lokale Datenbank nicht an`);
  }
  // Kein Zwischenspeicher fuer Geschaeftsdaten, kein Ausgangskorb.
  const shell = src('src/components/startup/ClientShell.tsx');
  ok(!/outbox|queue|cache/i.test(shell), 'DBLESS die Oberflaeche kennt weder Ausgangskorb noch Zwischenspeicher');
  const mode = src('src/core/bridge/client-mode.ts');
  const keys = mode.match(/const KEY_[A-Z_]+ = '[^']+'/g) || [];
  ok(keys.length === 3, `DBLESS lokal liegen genau drei Kontrollwerte (${keys.length})`);
  ok(/lataif_runtime_mode|lataif_client_server_url|lataif_client_token/.test(mode),
    'DBLESS …Modus, Adresse, Sitzung — nichts Fachliches');
}

// ── 3) Gelesen wird aus der Autoritaet, nicht von der Platte ──────────────
{
  const reads = src('src/core/bridge/read-commands.ts');
  ok(/import \{ getDatabase \} from '@\/core\/db\/database'/.test(reads),
    'AUTH die Lesebefehle laufen auf der sql.js-Datenbank des Primary');
  ok(/kind: 'read'/.test(reads), 'AUTH …und sind als Lesevorgang ausgewiesen');
  const registered = (reads.match(/^registerCommand\(/gm) || []).length;
  ok(registered === 6, `AUTH sechs Leseoperationen (${registered})`);
  ok(!/kind: 'mutation'/.test(reads), 'AUTH und keine einzige veraendernde');

  // Und in Rust wird KEINE neue Leseroute auf die Datei gelegt.
  const routes = src('src-tauri/src/sync/routes.rs');
  const bridgeRs = src('src-tauri/src/bridge.rs');
  // Die Zulassungsliste selbst, nicht nur die Konstanten daneben: ein Name, der nur DEFINIERT ist,
  // erreicht den Renderer nicht.
  const allowList = bridgeRs.slice(
    bridgeRs.indexOf('pub const REMOTE_OPS'),
    bridgeRs.indexOf('];', bridgeRs.indexOf('pub const REMOTE_OPS')),
  );
  const ops = [
    ['products.list', 'OP_PRODUCTS_LIST'], ['products.get', 'OP_PRODUCTS_GET'],
    ['customers.list', 'OP_CUSTOMERS_LIST'], ['customers.get', 'OP_CUSTOMERS_GET'],
    ['invoices.list', 'OP_INVOICES_LIST'], ['invoices.get', 'OP_INVOICES_GET'],
  ];
  for (const [op, konst] of ops) {
    ok(bridgeRs.includes(`${konst}: &str = "${op}"`), `AUTH ${op} has a name in Rust`);
    ok(allowList.includes(konst), `AUTH …and stands on the allow list itself (${op})`);
  }
  ok(allowList.includes('OP_PROBE'), 'AUTH the probe is still on it');
  ok(!/fn products_list|fn customers_list|fn invoices_list/.test(routes),
    'AUTH es gibt keine neue Rust-Route, die die Datei liest');
  const dtoOnly = code('src/core/bridge/read-commands.ts').includes('SELECT *');
  ok(!dtoOnly, 'AUTH keine Abfrage holt einfach alle Spalten');
}

// ── 4) Der Client bestimmt nichts ─────────────────────────────────────────
{
  const reads = src('src/core/bridge/read-commands.ts');
  // Suchtext, Kennung und Obergrenze kommen gebunden in die Abfrage — nie in den SQL-Text.
  ok(/const like = `%\$\{q\.toLowerCase\(\)\}%`/.test(reads) && /LIKE \?/.test(reads),
    'INPUT der Suchtext ist ein Parameter, kein SQL');
  ok(/Math\.min\(Math\.floor\(raw\), MAX_ROWS\)/.test(reads), 'INPUT eine Obergrenze bleibt eine Obergrenze');
  ok(/allowed\.includes\(status\)/.test(reads), 'INPUT ein Status kommt aus einer festen Liste');
  ok(/id\.length > 64/.test(reads), 'INPUT eine Kennung ist begrenzt');
  ok(/BRANCH_REQUIRED/.test(reads), 'INPUT ohne Filiale aus dem geprueften Token wird nicht gelesen');
  // Der Client darf die Filiale NICHT selbst setzen: sie kommt aus `actor`, das die Route baut.
  ok(/\(p as Envelope \| null\)\?\.actor\?\.branchId/.test(reads),
    'INPUT die Filiale kommt aus dem Absender, nicht aus der Eingabe');
}

// ── 5) Lesen nie mitten in einer Buchung ──────────────────────────────────
//
// Der Befund, der diesen Abschnitt noetig macht: `invoiceStore` und `purchaseStore` enthalten KEIN
// `await` — ihre Wirkung passiert in einem Zug. `productStore` hat 21 `await`-Punkte, weil der
// Medienweg mehrphasig ist. Ein Lesen dazwischen saehe ein Produkt ohne seine Bilder.
{
  ok((src('src/stores/invoiceStore.ts').match(/await /g) || []).length === 0,
    'CONSISTENCY Rechnungen sind von aussen unteilbar');
  ok((src('src/stores/purchaseStore.ts').match(/await /g) || []).length === 0,
    'CONSISTENCY Einkaeufe auch');
  const productAwaits = (src('src/stores/productStore.ts').match(/await /g) || []).length;
  ok(productAwaits > 10, `CONSISTENCY der Produktweg mit Medien aber NICHT (${productAwaits} await-Punkte)`);

  const s = new CommandScheduler();
  const events: string[] = [];
  let writeActive = false;
  let readInsideWrite = 0;

  const write = () => s.run(async () => {
    writeActive = true;
    events.push('w:start');
    await tick(20);                 // genau die Luecke, die es beim Produktweg wirklich gibt
    events.push('w:end');
    writeActive = false;
  });
  const read = (n: number) => s.runShared(async () => {
    if (writeActive) readInsideWrite += 1;
    events.push(`r${n}:start`);
    await tick(10);
    events.push(`r${n}:end`);
  });

  const w = write();
  const r1 = read(1); const r2 = read(2); const r3 = read(3);
  await Promise.all([w, r1, r2, r3]);

  ok(readInsideWrite === 0, `CONSISTENCY kein Lesen begann waehrend der Buchung (${readInsideWrite})`);
  ok(events.indexOf('r1:start') > events.indexOf('w:end'),
    `CONSISTENCY …die Leser warten auf ihr Ende (${events.join(' ')})`);
  ok(s.peakConcurrentReaders() === 3,
    `CONSISTENCY untereinander laufen sie aber gleichzeitig (Spitze ${s.peakConcurrentReaders()})`);

  // Und umgekehrt: ein Schreiber wartet auf laufende Leser.
  const s2 = new CommandScheduler();
  let readersActive = 0;
  let writeDuringRead = 0;
  const slowRead = () => s2.runShared(async () => { readersActive += 1; await tick(20); readersActive -= 1; });
  const late = () => s2.run(async () => { if (readersActive > 0) writeDuringRead += 1; await tick(1); });
  const reads = [slowRead(), slowRead()];
  const later = late();
  await Promise.all([...reads, later]);
  ok(writeDuringRead === 0, `CONSISTENCY und eine Buchung beginnt nie waehrend eines Lesens (${writeDuringRead})`);

  const registry = src('src/core/bridge/command-registry.ts');
  ok(/kind === 'read'\s*\r?\n?\s*\? await businessWriteScheduler\.runShared/.test(registry),
    'CONSISTENCY die Lesebefehle nehmen wirklich diese Spur');
}

// ── 6) Nichts Veraenderndes, auch nicht spaeter ───────────────────────────
{
  const { registerCommand, knownCommands, REMOTE_MUTATIONS_ENABLED } =
    await import('../../src/core/bridge/command-registry.ts');

  ok(REMOTE_MUTATIONS_ENABLED === false, 'READONLY veraendernde Fernauftraege bleiben gesperrt');
  // Die Lesebefehle ziehen die ganze Datenschicht mit; hier zaehlt ihre Registrierung im Quelltext.
  const readSrc = code('src/core/bridge/read-commands.ts');
  const registeredReads = readSrc.split('\n').filter((l) => l.startsWith('registerCommand(')).length;
  const known = knownCommands();
  ok(known.length === 1 && known[0] === 'bridge.probe',
    `READONLY geladen ist zunaechst nur die Probe (${known.join(',')})`);
  ok(registeredReads === 6, `READONLY plus sechs Lesevorgaenge im Quelltext (${registeredReads})`);
  ok(!/registerCommand\('[a-z.]*(create|edit|delete|sell|import|save|update)/i.test(readSrc),
    'READONLY und kein Name klingt nach Veraenderung');

  for (const name of ['products.create', 'invoice.save', 'products.delete']) {
    let refused = false;
    try { registerCommand(name, { kind: 'mutation', handler: () => ({ ok: true }) }); } catch { refused = true; }
    ok(refused, `READONLY ${name} kann nicht registriert werden`);
  }

  // Die Oberflaeche bietet nichts an, was schreibt.
  const shell = src('src/components/startup/ClientShell.tsx');
  ok(!/products\.create|invoices\.create|customers\.create|\.update|\.delete/.test(shell),
    'READONLY die Client-Oberflaeche ruft keinen schreibenden Befehl');
  ok(/read-only/.test(shell), 'READONLY …und sagt selbst, dass sie nur liest');
}

// ── 7) Server weg: sagen, nicht erfinden ──────────────────────────────────
{
  cm.enterClientMode('http://127.0.0.1:65500');
  cm.setClientToken('a-token');

  // Kein Netz: `fetch` wirft.
  const dead = (): Promise<Response> => Promise.reject(new Error('ECONNREFUSED'));
  let caught: InstanceType<typeof rr.RemoteReadError> | null = null;
  try { await rr.remoteRead('products.list', {}, dead as never); }
  catch (e) { caught = e as InstanceType<typeof rr.RemoteReadError>; }
  ok(caught?.code === rr.ERR_UNAVAILABLE, `OFFLINE ein unerreichbarer Server heisst genau das (${caught?.code})`);
  ok(cm.clientConfig()?.token === 'a-token', 'OFFLINE die Sitzung bleibt — es war kein Anmeldefehler');

  // Abgelaufene Sitzung: die Sitzung wird verworfen, aber NICHT lokal ausgewichen.
  const unauthorized = (): Promise<Response> =>
    Promise.resolve({ status: 401, ok: false, json: async () => ({}) } as unknown as Response);
  let second: InstanceType<typeof rr.RemoteReadError> | null = null;
  try { await rr.remoteRead('products.list', {}, unauthorized as never); }
  catch (e) { second = e as InstanceType<typeof rr.RemoteReadError>; }
  ok(second?.code === rr.ERR_UNAUTHENTICATED && second?.needsAuth === true,
    `OFFLINE eine abgelaufene Sitzung verlangt eine neue Anmeldung (${second?.code})`);
  ok(cm.clientConfig()?.token === null, 'OFFLINE …und die alte wird weggeworfen');

  // Und der Weg zurueck: mit Antwort geht es weiter.
  cm.setClientToken('fresh');
  const good = (): Promise<Response> => Promise.resolve({
    status: 200, ok: true, json: async () => ({ ok: true, value: { items: [{ id: 'p1' }] } }),
  } as unknown as Response);
  const value = await rr.remoteRead<{ items: unknown[] }>('products.list', {}, good as never);
  ok(value.items.length === 1, 'OFFLINE nach der Wiederverbindung wird wieder gelesen');

  // Nirgends ein Ausweichen auf eine lokale Datenbank.
  const remote = src('src/core/bridge/remote-read.ts');
  ok(!/getDatabase|initDatabase|fallback/i.test(remote), 'OFFLINE es gibt keinen lokalen Ersatz');
  ok(/setClientToken\(null\)/.test(remote), 'OFFLINE eine verbrauchte Sitzung wird nicht weiterbenutzt');
  cm.leaveClientMode();
}

// ── 8) Der dritte Weg auf der Erstlauf-Weiche ─────────────────────────────
{
  const gate = src('src/components/startup/FirstRunGate.tsx');
  ok(/data-first-run-new/.test(gate) && /data-first-run-recover/.test(gate) && /data-first-run-connect/.test(gate),
    'GATE drei ausdrueckliche Wege: einrichten, wiederherstellen, verbinden');
  ok(/enterClientMode\(serverUrl\)/.test(gate), 'GATE der dritte merkt sich nur die Adresse');
  // Er darf NICHTS anlegen: kein setup, kein adopt in diesem Zweig.
  const panel = gate.slice(gate.indexOf('data-first-run-connect-panel'), gate.indexOf('data-first-run-connect-back'));
  ok(!/setUpNewInstallation|adoptDataLocation|initDatabase/.test(panel),
    'GATE …und richtet dabei nichts ein');
}

// ── 9) Medien nur ueber die angemeldete Route ─────────────────────────────
{
  const shell = src('src/components/startup/ClientShell.tsx');
  ok(/\$\{serverUrl\}\/api\/media\?key=\$\{encodeURIComponent\(key\)\}/.test(shell),
    'MEDIA Bilder kommen ueber die bestehende Medienroute');
  ok(/Authorization: `Bearer \$\{token\}`/.test(shell), 'MEDIA …mit der Anmeldung, nie ohne');
  ok(/if \(!res\.ok\) continue;/.test(shell), 'MEDIA ein fehlendes Bild bleibt ein fehlendes Bild');
  ok(/data-client-no-media/.test(shell), 'MEDIA …und wird als solches angezeigt');
  ok(!/file:\/\/|\\\\\\\\|smb:/.test(shell), 'MEDIA kein Pfad, keine Netzfreigabe');

  const reads = src('src/core/bridge/read-commands.ts');
  ok(/mediaKeys: mediaKeysFor\(/.test(reads), 'MEDIA der Primary nennt nur die Schluessel…');
  ok(!/base64|dataUrl|imageBytes/.test(reads), 'MEDIA …und schickt keine Bilddaten durch den Lesebefehl');
}

// ── 10) Der ECHTE Schreibweg, nicht nur der der Brücke ────────────────────
//
// Der Befund, der diesen Abschnitt nötig machte: die Leser-Schreiber-Ordnung schützte zunächst nur
// Aufträge, die durch `executeCommand` kamen. Ein Klick auf dem Primary rief `createProductWithMedia`
// direkt — an der Schranke vorbei. Genau dieser Weg ist mehrphasig, also war er der einzige, der
// sie gebraucht hätte.
//
// Der Umfang des Riegels folgt aus einer Zählung, nicht aus einem Gefühl: NUR `async` Aktionen
// können überhaupt unterbrochen werden, weil ein Lesevorgang erst an einem `await` drankommt. Von
// allen 28 Stores haben genau drei überhaupt `async` Aktionen, und nur vier davon fassen
// Geschäftsdaten an.
{
  const store = code('src/stores/productStore.ts');
  const docs = code('src/stores/documentStore.ts');

  for (const [file, text, name] of [
    ['productStore', store, 'createProductWithMedia'],
    ['productStore', store, 'editProductWithMedia'],
    ['productStore', store, 'editProductTextDurably'],
    ['documentStore', docs, 'uploadDocument'],
    ['documentStore', docs, 'extractOcr'],
  ]) {
    ok(new RegExp(`${name}: \\([^)]*\\) => runExclusive\\(async`).test(text),
      `REALWRITE ${file}.${name} betritt die Spur`);
    ok(!new RegExp(`${name}: async \\(`).test(text), `REALWRITE …und nicht mehr daran vorbei (${name})`);
  }

  // Und es gibt keinen weiteren mehrphasigen Geschaeftsschreiber, der uebersehen waere.
  let asyncActions = [];
  walk(resolvePath(repo, 'src/stores'), (p, text) => {
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s{2}([A-Za-z][A-Za-z0-9_]*): async \(/);
      if (m) asyncActions.push(p.slice(repo.length + 1).split('\\').join('/') + ':' + m[1]);
    }
  });
  ok(asyncActions.length === 1 && asyncActions[0].endsWith('authStore.ts:login'),
    `REALWRITE die einzige verbleibende async-Aktion ist die Anmeldung (${asyncActions.join(', ') || 'keine'})`);

  // Die Automatisierung schreibt eigenes SQL — aber SYNCHRON, also unteilbar.
  for (const f of ['src/core/automation/automation-handlers.ts', 'src/core/automation/daily-sweep.ts']) {
    ok((src(f).match(/await /g) || []).length === 0,
      `REALWRITE ${f} laeuft synchron durch — ein Lesen kann dort nicht hinein`);
  }
}

// ── 11) Der Ablauf, den §1 verlangt — an der echten Warteschlange ─────────
//
// Schreiber betritt die Spur → hält an einem kontrollierten Punkt → ein ECHTER Lesebefehl trifft
// ein → er darf sein SQL noch nicht ausführen → Schreiber endet → erst dann liest er, und sieht
// ausschließlich den Endzustand.
{
  const { registerCommand: reg, executeCommand: exec } =
    await import('../../src/core/bridge/command-registry.ts');
  const { businessWriteScheduler: lane, runExclusive: enter } =
    await import('../../src/core/bridge/command-scheduler.ts');

  const events = [];
  let phase = 'before';                 // der beobachtbare Zwischenzustand des Schreibers
  let readSawPhase = null;
  let release;
  const held = new Promise((r) => { release = r; });

  reg('test.c2read', {
    kind: 'read',
    handler: () => {
      events.push('read:sql');
      readSawPhase = phase;             // was der Lesevorgang WIRKLICH sieht
      return { phase };
    },
  });

  // 1./2. Der Schreiber betritt dieselbe Spur wie die echten Aktionen und haelt an.
  const writer = enter(async () => {
    events.push('write:start');
    phase = 'half';                     // Produkt geschrieben, Galerie noch nicht
    await held;                         // genau die Luecke, die der Medienweg wirklich hat
    phase = 'done';
    events.push('write:end');
  });

  await tick(5);
  ok(events.join(',') === 'write:start', `BARRIER der Schreiber haelt mitten drin (${events.join(',')})`);

  // 3./4. Der Lesebefehl trifft ein — und darf sein SQL NICHT ausfuehren.
  const read = exec('test.c2read', {});
  await tick(20);
  ok(!events.includes('read:sql'),
    `BARRIER der Lesebefehl wartet, statt den Zwischenzustand zu sehen (${events.join(',')})`);

  // 5./6. Der Schreiber endet, erst danach liest der Befehl — und sieht nur den Endzustand.
  release();
  const answer = await read;
  await writer;
  ok(events.join(',') === 'write:start,write:end,read:sql',
    `BARRIER die Reihenfolge stimmt (${events.join(',')})`);
  ok(readSawPhase === 'done', `BARRIER und gelesen wurde ausschliesslich der Endzustand (${readSawPhase})`);
  ok(answer.kind === 'ok' && answer.value.phase === 'done', 'BARRIER …auch in der Antwort an den Client');
  ok(lane.stats().depth === 0, 'BARRIER danach ist die Spur leer');
}

// ── 12) Die Zulassungsliste, Name für Name ────────────────────────────────
//
// Die frühere Rechnung „Produkte 3 + Kunden 2 + Rechnungen 2 = 7 Lesevorgänge" ging von einer
// eigenen Suchoperation aus. Die gibt es nicht: die Suche ist ein PARAMETER von `products.list`.
// Es sind sechs Lesevorgänge plus die Probe.
{
  const bridgeRs = src('src-tauri/src/bridge.rs');
  const list = bridgeRs.slice(
    bridgeRs.indexOf('pub const REMOTE_OPS'),
    bridgeRs.indexOf('];', bridgeRs.indexOf('pub const REMOTE_OPS')),
  );
  const names = (list.match(/OP_[A-Z_]+/g) || []).filter((n) => n !== 'REMOTE_OPS');
  const resolved = names.map((n) => {
    const m = bridgeRs.match(new RegExp(`${n}: &str = "([^"]+)"`));
    return m ? m[1] : `?${n}`;
  });

  const probes = resolved.filter((o) => o === 'bridge.probe');
  const reads = resolved.filter((o) => o.endsWith('.list') || o.endsWith('.get'));
  const mutations = resolved.filter((o) => !probes.includes(o) && !reads.includes(o));

  ok(resolved.length === 7, `ALLOWLIST sieben Namen insgesamt (${resolved.length}: ${resolved.join(', ')})`);
  ok(probes.length === 1, `ALLOWLIST genau eine Probe (${probes.length})`);
  ok(reads.length === 6, `ALLOWLIST genau sechs Lesevorgaenge (${reads.length}: ${reads.join(', ')})`);
  ok(mutations.length === 0, `ALLOWLIST und NULL veraendernde (${mutations.join(', ') || 'keine'})`);
  ok(resolved.join(',') === 'bridge.probe,products.list,products.get,customers.list,customers.get,invoices.list,invoices.get',
    `ALLOWLIST in dieser Reihenfolge (${resolved.join(',')})`);
  // Es gibt keine eigene Suchoperation — die Suche ist ein Parameter.
  ok(!resolved.some((o) => /search/.test(o)), 'ALLOWLIST keine eigene Suchoperation');
  ok(/searchOf\(p\)/.test(src('src/core/bridge/read-commands.ts')), 'ALLOWLIST …die Suche ist ein Parameter von products.list');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central c2 client read mode: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
console.log('CENTRAL_C2_CLIENT_DBLESS_STARTUP_PROVED');
console.log('CENTRAL_C2_READ_AUTHORITY_PROVED');
console.log('CENTRAL_C2_READ_WRITE_CONSISTENCY_PROVED');
console.log('CENTRAL_C2_CORE_READS_PROVED');
console.log('CENTRAL_C2_READ_ONLY_ENFORCEMENT_PROVED');
console.log('CENTRAL_C2_REMOTE_MEDIA_PROVED');
console.log('CENTRAL_C2_OFFLINE_FAIL_CLOSED_PROVED');
console.log('CENTRAL_C2_REAL_PRIMARY_WRITE_READ_BARRIER_PROVED');
console.log('CENTRAL_C2_REMOTE_OP_ALLOWLIST_EXACT_PROVED');
