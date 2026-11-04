// PC2-RECHERCHE C5 S4 — „Ist der Server weg, sagt der Client das" (remote-read.ts), jetzt auch SICHTBAR.
// Run: node test/pc2-reachability/primary-reachability.test.ts
//
// Befund (v0.8.97): PC2 schrieb Lesefehler nur in die Konsole (`setRemoteLoadFailureHandler` ohne Aufrufer); die
// Seiten zeigten still den alten Stand oder leere Listen. Bewiesen wird hier:
//   1. Jede Lesefrage meldet die Erreichbarkeit: Netz weg / 503 / 504 / unlesbar → „unreachable", 401/403 →
//      „signed_out" (Sitzung verworfen), jede Antwort des Primary — auch ein fachliches Nein — → „ok".
//   2. Gemeldet wird nur ein WECHSEL (kein Dauerfeuer bei jeder Frage), ein Fehler im Zuhörer stört das Lesen nie.
//   3. Die Leiste hängt NUR im Client-Modus in der App, zeigt den Zustand, bietet „Reload"/„Sign in" und ändert nichts.
import { readFileSync, existsSync } from 'node:fs';
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

// Ein Browser-Ersatz, damit `client-mode` unter node läuft.
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

const antwort = (status: number, body: unknown, lesbar = true) => (): Promise<Response> => Promise.resolve({
  status, ok: status >= 200 && status < 300,
  json: async () => { if (!lesbar) throw new Error('not json'); return body; },
} as unknown as Response);
const netzWeg = (): Promise<Response> => Promise.reject(new Error('ECONNREFUSED'));
async function lies(fetchFn: () => Promise<Response>): Promise<string> {
  try { await rr.remoteRead('products.list', {}, fetchFn as never); return 'ok'; }
  catch (e) { return (e as { code?: string }).code || 'error'; }
}

cm.enterClientMode('http://127.0.0.1:65500');
cm.setClientToken('a-token');
const meldungen: string[] = [];
const ab = rr.onPrimaryReachability((r) => meldungen.push(r.state + (r.state === 'ok' ? '' : ':' + r.code)));

// ── 1) die Zustände ──
ok(rr.primaryReachability().state === 'ok', 'START ohne Frage gilt der Primary als erreichbar (keine Leiste beim Start)');
ok(await lies(netzWeg) === rr.ERR_UNAVAILABLE && rr.primaryReachability().state === 'unreachable',
  `NETZ-WEG eine Frage ohne Netz meldet „unreachable" (${rr.primaryReachability().state})`);
ok(cm.clientConfig()?.token === 'a-token', 'NETZ-WEG …die Sitzung bleibt (kein Anmeldefehler)');
const seit = (rr.primaryReachability() as { since: number }).since;
ok(Number.isFinite(seit) && seit > 0, 'NETZ-WEG …mit dem Zeitpunkt, seit dem er fehlt');
ok(await lies(antwort(503, {})) === rr.ERR_UNAVAILABLE && rr.primaryReachability().state === 'unreachable', 'HTTP-503 ebenso „unreachable"');
ok(await lies(antwort(504, {})) === rr.ERR_UNAVAILABLE && rr.primaryReachability().state === 'unreachable', 'HTTP-504 ebenso „unreachable"');
ok(await lies(antwort(200, null, false)) === rr.ERR_UNAVAILABLE && rr.primaryReachability().state === 'unreachable', 'UNLESBAR eine unlesbare Antwort ebenso');
ok(await lies(antwort(200, { ok: true, value: { items: [] } })) === 'ok' && rr.primaryReachability().state === 'ok',
  'ZURUECK die nächste beantwortete Frage nimmt die Meldung zurück');
ok(await lies(antwort(200, { ok: false, error: 'RECORD_NOT_FOUND', message: 'nope' })) === 'RECORD_NOT_FOUND'
  && rr.primaryReachability().state === 'ok', 'NEIN ein fachliches Nein IST eine Antwort — erreichbar');
ok(await lies(antwort(401, {})) === rr.ERR_UNAUTHENTICATED && rr.primaryReachability().state === 'signed_out'
  && cm.clientConfig()?.token === null, 'ABGEMELDET 401 → „signed_out", die verbrauchte Sitzung ist weg');
cm.setClientToken('fresh');
ok(await lies(antwort(403, {})) === rr.ERR_UNAUTHENTICATED && rr.primaryReachability().state === 'signed_out', 'ABGEMELDET 403 ebenso');
cm.setClientToken('fresh2');
ok(await lies(antwort(200, { ok: true, value: {} })) === 'ok' && rr.primaryReachability().state === 'ok', 'ZURUECK nach neuer Anmeldung wieder erreichbar');

// ── 2) nur Wechsel, Zuhörerfehler stören nicht ──
ok(JSON.stringify(meldungen) === JSON.stringify(['unreachable:SERVER_UNAVAILABLE', 'ok', 'signed_out:NOT_AUTHENTICATED', 'ok']),
  `WECHSEL nur Zustandswechsel werden gemeldet, nicht jede Frage (${JSON.stringify(meldungen)})`);
const stoerer = rr.onPrimaryReachability(() => { throw new Error('Anzeige kaputt'); });
ok(await lies(netzWeg) === rr.ERR_UNAVAILABLE, 'STOERER ein Fehler im Zuhörer ändert das Ergebnis der Frage nicht');
ok(await lies(antwort(200, { ok: true, value: { x: 1 } })) === 'ok', 'STOERER …und das Lesen geht weiter');
stoerer(); ab();
const n = meldungen.length;
await lies(netzWeg);
ok(meldungen.length === n, 'ABMELDEN ein abgemeldeter Zuhörer hört nichts mehr');
await lies(antwort(200, { ok: true, value: {} }));

// ── 3) die Leiste ──
const app = src('src/App.tsx');
ok(/\{clientMode && <PrimaryReachabilityBar \/>\}/.test(app), 'APP die Leiste hängt NUR im Client-Modus (PC2) in der App');
ok(/import \{ PrimaryReachabilityBar \} from '@\/components\/shared\/PrimaryReachabilityBar'/.test(app), 'APP …aus der einen Komponente');
const bar = src('src/components/shared/PrimaryReachabilityBar.tsx');
ok(/onPrimaryReachability\(setR\)/.test(bar) && /primaryReachability\(\)/.test(bar), 'BAR die Leiste hört auf die Meldung von remoteRead und startet mit dem aktuellen Stand');
ok(/if \(r\.state === 'ok'\) return null;/.test(bar), 'BAR erreichbar → keine Leiste');
ok(/data-primary-unreachable=\{r\.state\}/.test(bar) && /role="alert"/.test(bar), 'BAR sonst eine Meldung mit Zustand (für Menschen und Tests)');
ok(/The main computer is not answering — what you see may be out of date/.test(bar) && /Signed out from the main computer/.test(bar),
  'BAR sie sagt, was los ist: nicht erreichbar (Daten evtl. veraltet) bzw. abgemeldet');
ok(/window\.location\.reload\(\)/.test(bar) && !/getDatabase|executeCommand|remoteRead\(|w\.ok\(/.test(bar),
  'BAR „Reload"/„Sign in" lädt nur neu — die Leiste liest, schreibt und bucht nichts');
const rrSrc = src('src/core/bridge/remote-read.ts');
ok((rrSrc.match(/melde\('unreachable', ERR_UNAVAILABLE\)/g) || []).length === 3 &&/melde\('signed_out', ERR_UNAUTHENTICATED\)/.test(rrSrc) && /melde\('ok'\)/.test(rrSrc),
  'QUELLE alle Ausfallwege von remoteRead melden (Netz, 503/504, unlesbar; 401/403), jede Antwort meldet „ok"');

console.log(`PC2 primary reachability: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('PC2_PRIMARY_REACHABILITY_VISIBLE_PROVED');
