// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-C6 — Auslieferungshärtung: was der ausgelieferte Rechner NICHT mehr tun darf.
// Run: node test/c6/c6-release-hardening.test.ts
//
// C6 fügt keine Geschäftsfunktion hinzu. Es schließt Wege:
//
//   1. Der Umfang bleibt eingefroren: 1 Probe + 18 Auskünfte + 40 Buchungen = 59.
//   2. Der alte Desktop-Abgleich ist im Client-Modus nicht versteckt, sondern verweigert —
//      an der Sache selbst, nicht in der Oberfläche. Kein Start, kein Zug, kein Schub, kein
//      Ausgangskorb, kein Wasserstand. Und im Primary-Modus unverändert alles wie bisher.
//   3. Die Webansicht führt nur eigenen Code aus: eine Richtlinie ohne fremde Skriptquelle.
//   4. Zwischen Test und Produktion liegt eine Übersetzungsgrenze, kein Schalter.
//   5. Der Auslieferungsvertrag ist genau ein Installer, und in der Konfiguration steht
//      kein Geheimnis, keine Entwicklungsadresse und kein Pfad von diesem Rechner.
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath, join } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    if (specifier === '@/core/db/database' || specifier === './database' || specifier === '../db/database') {
      return { url: pathToFileURL(resolvePath(repo, 'test/sync/_db-shim.ts')).href, shortCircuit: true };
    }
    if (specifier === '../auth/auth' && context.parentURL && context.parentURL.includes('/db/helpers')) {
      return { url: pathToFileURL(resolvePath(repo, 'test/sync/_auth-shim.ts')).href, shortCircuit: true };
    }
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

const store = new Map<string, string>([
  ['lataif_session', JSON.stringify({ branchId: 'branch-main', userId: 'user-test' })],
  ['lataif_sync_url', 'http://127.0.0.1:9/sync'],
  ['lataif_sync_token', 'test-token'],
]);
const storage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};
(globalThis as { localStorage?: unknown }).localStorage = storage;
(globalThis as { window?: unknown }).window = { localStorage: storage };

let PASS = 0; const fails: string[] = [];
const ok = (c: boolean, m: string) => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const read = (p: string) => readFileSync(join(repo, p), 'utf8');

// ── §1 — der Umfang ist eingefroren ────────────────────────────────────────
{
  const reg = read('src/core/bridge/command-registry.ts').replace(/\r\n/g, '\n');
  const files = readdirSync(join(repo, 'src/core/bridge')).filter((f) => f.endsWith('.ts'));
  let reads = 0, mutations = 0, probes = 0;
  for (const f of files) {
    const s = read('src/core/bridge/' + f);
    reads += (s.match(/kind: 'read',/g) || []).length;
    mutations += (s.match(/kind: 'mutation',/g) || []).length;
    probes += (s.match(/kind: 'probe',/g) || []).length;
  }
  // CENTRAL-UI-PARITY — die 18 C2-Auskünfte sind um 25 Store-Auskünfte gewachsen, damit auf PC2
  // DIESELBE Oberfläche läuft. Die Zahl der BUCHUNGEN ist unverändert die Zusage, die zählt.
  // Gezaehlt wird hier der QUELLTEXT: die 18 C2-Auskuenfte stehen einzeln da, die 25
  // Store-Auskuenfte entstehen in einer Schleife ueber den Katalog — also 19 Fundstellen.
  // R1: fünf typisierte Auskünfte, jede einzeln registriert — deshalb 23 Fundstellen.
  const catalogue = (read('src/core/bridge/store-read-ops.ts').match(/^export const OP_[A-Z_]+ = '/gm) || []).length;
  ok(probes === 1 && reads === 60 && catalogue === 42 && mutations === 40,
    `SCOPE 1 Probe + 18 Auskünfte + 42 typisierte Auskünfte + 40 Buchungen (${probes}/${reads}/${catalogue}/${mutations})`);

  const a = reg.indexOf('ALLOWED_MUTATIONS: readonly string[] = [');
  const body = reg.slice(reg.indexOf('[', a) + 1, reg.indexOf('\n];', a));
  const allow = [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  ok(allow.length === 40, `SCOPE die Erlaubnisliste nennt genau 40 Buchungen (${allow.length})`);

  const bridge = read('src-tauri/src/bridge.rs').replace(/\r\n/g, '\n');
  const rustList = bridge.slice(bridge.indexOf('pub const REMOTE_OPS: &[&str] = &['));
  const rustOps = rustList.slice(0, rustList.indexOf('\n];')).split('\n').filter((l) => /^\s{4}OP_[A-Z0-9_]+,$/.test(l));
  ok(rustOps.length === 101, `SCOPE und Rust lässt genau dieselben 101 Namen durch (${rustOps.length})`);
}

// ── §2 — der alte Desktop-Abgleich ist im Client-Modus verweigert ──────────
{
  const sync = await import(pathToFileURL(join(repo, 'src/core/sync/sync-service.ts')).href) as {
    startAutoSync(): void; stopAutoSync(): void; pauseAutoSync(): void; syncNow(): Promise<void>;
    setSyncConfig(u: string, t: string): void; trackChange(t: string, r: string, a: 'insert', d: Record<string, unknown>): void;
    isSyncConfigured(): boolean;
  };
  const lan = await import(pathToFileURL(join(repo, 'src/core/sync/auto-lan.ts')).href) as {
    autoLanSetup(): Promise<string>;
  };

  // Ein Zähler auf allem, was ein Abgleich ANFASSEN müsste: Zeitgeber, Netz, Datenbank.
  const realSetInterval = globalThis.setInterval;
  const realFetch = globalThis.fetch;
  let timers = 0, requests = 0;
  (globalThis as { setInterval: unknown }).setInterval = ((...a: unknown[]) => {
    timers++; return (realSetInterval as unknown as (...x: unknown[]) => unknown)(...a);
  }) as never;
  (globalThis as { fetch: unknown }).fetch = (async () => { requests++; throw new Error('no network in this gate'); }) as never;

  // Der Client-Modus wird genau so gesetzt, wie ihn die Anwendung setzt.
  store.set('lataif_runtime_mode', 'client');
  const before = { url: store.get('lataif_sync_url'), token: store.get('lataif_sync_token') };

  sync.startAutoSync();
  ok(timers === 0, `CLIENT startAutoSync legt keinen Zeitgeber an (${timers})`);
  await sync.syncNow();
  ok(requests === 0, `CLIENT syncNow zieht und schiebt nichts (${requests} Anfragen)`);
  sync.setSyncConfig('http://192.168.1.99:3001', 'stolen');
  ok(store.get('lataif_sync_url') === before.url && store.get('lataif_sync_token') === before.token,
    'CLIENT setSyncConfig richtet keine Verbindung ein');
  // `trackChange` ist der Ausgangskorb. Ohne Datenbank würde der Zugriff werfen — er darf gar
  // nicht erst dorthin kommen.
  let threw = '';
  try { sync.trackChange('invoices', 'inv-1', 'insert', { id: 'inv-1' }); } catch (e) { threw = String(e); }
  ok(threw === '', `CLIENT trackChange legt keinen Ausgangskorb an und fasst keine Datenbank an (${threw})`);
  ok(await lan.autoLanSetup() === 'unconfigured', 'CLIENT autoLanSetup startet weder Server noch Suche');

  // Gegenprobe: am Primary ist nichts davon abgeschaltet.
  store.delete('lataif_runtime_mode');
  sync.setSyncConfig('http://127.0.0.1:9/sync', 'test-token');
  ok(store.get('lataif_sync_url') === 'http://127.0.0.1:9/sync', 'PRIMARY dieselbe Funktion richtet dort weiterhin ein');
  // Der Zeitgeber, ohne einen echten Zug auszuloesen: pausiert laeuft syncNow gar nicht erst an.
  sync.pauseAutoSync();
  sync.startAutoSync();
  ok(timers === 1, `PRIMARY …und der Zeitgeber läuft dort wie bisher (${timers})`);
  sync.stopAutoSync();

  (globalThis as { setInterval: unknown }).setInterval = realSetInterval as never;
  (globalThis as { fetch: unknown }).fetch = realFetch as never;

  // Und die Weiche davor: im Client-Modus wird die Datenbank gar nicht erst geöffnet.
  const app = read('src/App.tsx');
  const branch = app.slice(app.indexOf('if (isClientMode()) {'), app.indexOf('isFirstRunPending()'));
  ok(/setClientReady\(true\);/.test(branch) && /return \(\) =>/.test(branch) && !/initDatabase\(\)/.test(branch),
    'CLIENT die Weiche kehrt vor jedem Datenbankstart um');
  ok(app.indexOf('if (isClientMode()) {') < app.indexOf('if (!pending) bootDatabase();'),
    'CLIENT …und sie steht VOR dem Datenbankstart, nicht daneben');
}

// ── §3 — die Inhaltsrichtlinie der Webansicht ──────────────────────────────
{
  const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
  const csp: unknown = conf.app?.security?.csp;
  ok(typeof csp === 'string' && csp.length > 0, 'CSP es gibt überhaupt eine Richtlinie (nicht mehr null)');
  const s = String(csp);
  const dir = (name: string) => (s.split(';').map((x) => x.trim()).find((x) => x.startsWith(name + ' ')) || '');
  const script = dir('script-src');
  ok(/^script-src 'self'/.test(script), `CSP Skripte nur aus dem eigenen Bündel (${script})`);
  ok(!/https?:/.test(script), `CSP …keine fremde Skriptquelle (${script})`);
  ok(!/'unsafe-eval'/.test(script), `CSP …und kein 'unsafe-eval' (${script})`);
  ok(/'wasm-unsafe-eval'/.test(script), 'CSP …aber WASM, denn die Geschäftsdatenbank IST WASM');
  ok(dir('object-src') === "object-src 'none'", `CSP keine Plugins (${dir('object-src')})`);
  ok(dir('frame-src') === "frame-src 'none'" && dir('child-src') === "child-src 'none'",
    'CSP kein eingebetteter fremder Rahmen');
  ok(dir('base-uri') === "base-uri 'self'", 'CSP die Basisadresse lässt sich nicht umbiegen');
  ok(/^default-src 'self'/.test(s), 'CSP alles Übrige fällt auf das eigene Bündel zurück');
  // Und die Testkonfigurationen dürfen die Richtlinie nicht aufweichen — sonst prüfte der
  // E2E etwas anderes als das, was ausgeliefert wird.
  for (const f of ['tauri.e2e.conf.json', 'tauri.e2e-client.conf.json']) {
    const c = JSON.parse(read('src-tauri/' + f));
    ok(c.app?.security === undefined, `CSP ${f} überschreibt die Richtlinie nicht`);
  }
}

// ── §4 — Grenze zwischen Test und Produktion ───────────────────────────────
{
  const cargo = read('src-tauri/Cargo.toml');
  ok(/\[features\]\s*\ne2e = \[\]/.test(cargo.replace(/\r\n/g, '\n')), 'BOUNDARY es gibt genau ein Testmerkmal, und es ist leer');
  ok(!/default = \[[^\]]*e2e/.test(cargo), 'BOUNDARY …und es ist nicht voreingestellt');

  const rs: string[] = [];
  (function walk(d: string) {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith('.rs')) rs.push(p);
    }
  })(join(repo, 'src-tauri/src'));
  const offenders: string[] = [];
  for (const f of rs) {
    if (f.endsWith('_tests.rs') || f.endsWith('tests.rs')) continue;
    const lines = readFileSync(f, 'utf8').replace(/\r\n/g, '\n').split('\n');
    lines.forEach((line, i) => {
      if (!/LATAIF_E2E|E2E_BUILD_MARKER|__LATAIF_E2E__|e2e_support/.test(line)) return;
      const window = lines.slice(Math.max(0, i - 6), i + 1).join('\n');
      if (!/#\[cfg\(feature = "e2e"\)\]/.test(window)) {
        offenders.push(f.slice(repo.length + 1).replace(/\\/g, '/') + ':' + (i + 1));
      }
    });
  }
  ok(offenders.length === 0, `BOUNDARY jeder Test-Einstieg steht hinter dem Testmerkmal (offen: ${offenders.join(', ')})`);

  const prod = JSON.parse(read('src-tauri/tauri.conf.json'));
  ok(prod.identifier === 'com.lataif.app', `BOUNDARY die Produktionskennung ist unverändert (${prod.identifier})`);
  ok(!JSON.stringify(prod).includes('e2e'), 'BOUNDARY und die Produktionskonfiguration nennt keine Testkennung');

  // Demobenutzer mit bekannten Passwörtern dürfen auf einem echten Rechner nicht entstehen.
  const dbsrc = read('src/core/db/database.ts').replace(/\r\n/g, '\n');
  const calls = [...dbsrc.matchAll(/seedFreshDatabase\(db\)/g)].length;
  ok(calls === 2, `BOUNDARY der Demo-Startbestand wird an genau zwei Stellen gerufen (${calls})`);
  ok(/if \(isTauri\(\)\) throw new DatabaseRecoveryRequiredError\(/.test(dbsrc),
    'BOUNDARY …und der Wiederherstellungszweig legt auf einem echten Rechner gar nichts mehr an');
  ok(dbsrc.includes("VALUES ('user-owner', 'tenant-1', 'ali@lataif.com'") && dbsrc.includes('isTauri()'),
    'BOUNDARY …und die Demokonten bleiben dem Entwicklungsbrowser vorbehalten');
}

// ── §5 — Auslieferungsvertrag und Hygiene ──────────────────────────────────
{
  const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
  ok(JSON.stringify(conf.bundle?.targets) === '["nsis"]',
    `RELEASE genau ein Installer, kein MSI daneben (${JSON.stringify(conf.bundle?.targets)})`);
  ok(conf.bundle?.createUpdaterArtifacts === true, 'RELEASE die Aktualisierung bekommt ihre Signaturdatei');
  ok(conf.plugins?.updater?.pubkey && String(conf.plugins.updater.pubkey).length > 40,
    'RELEASE der öffentliche Schlüssel steht in der Konfiguration');
  const flat = JSON.stringify(conf);
  ok(!/[A-Za-z]:\\\\|\/Users\/|\/home\//.test(flat), 'RELEASE kein Pfad von diesem Rechner in der Konfiguration');
  ok(!/localhost:1420|127\.0\.0\.1:1420/.test(flat) || conf.build?.devUrl !== undefined,
    'RELEASE die Entwicklungsadresse steht nur im Entwicklungsfeld');
  ok(!/PRIVATE KEY|password|secret|token/i.test(flat), 'RELEASE und kein Geheimnis irgendwo darin');

  // Der Freigabeweg lädt genau die beiden Dateien hoch, die er baut.
  const rel = read('scripts/release.mjs');
  ok(/nsis/.test(rel) && !/\.msi/.test(rel), 'RELEASE das Freigabeskript kennt nur den NSIS-Installer');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central c6 release hardening: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
