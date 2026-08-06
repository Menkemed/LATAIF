// ════════════════════════════════════════════════════════════════════════════
// PERFORMANCE-SUITE — real Tauri/WebView2 scenarios.
//   node test/perf/scenarios-app.mjs
//
// Drives the REAL e2e app (production com.lataif.app.e2e binary) on an ISOLATED app id / AppData / test port
// (LATAIF_E2E_SYNC_PORT=3011) — production port 3001 and the prod DB are NEVER touched. Measures cold + warm
// startup to "interactive" (CDP page + health 200 + invoke ready), a real owner-gated GC dry-run, and a real
// mobile-upload ingress. Proves resource cleanup (no zombie, one listener) afterwards. Writes a report under
// test/perf/artifacts/. Requires the e2e binary: build it with
//   npx tauri build --debug --no-bundle --features e2e --config src-tauri/tauri.e2e.conf.json
// ════════════════════════════════════════════════════════════════════════════
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, statSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import os from 'node:os';
import { measure, writeReport, envMeta } from './harness.mjs';
import { mergeBaselineClass, baselineScenarios } from './baseline.mjs';

const REPO = process.cwd();
// Prefer the RELEASE e2e binary (production profile) for the committed baseline; fall back to debug (marked).
const REL = join(REPO, 'src-tauri/target/release/lataif.exe');
const DBG = join(REPO, 'src-tauri/target/debug/lataif.exe');
const APP = process.env.PERF_APP || (existsSync(REL) ? REL : DBG);
const PROFILE = APP === REL ? 'release' : 'debug';
process.env.PERF_BUILD_TYPE = PROFILE;
const SEED = join(REPO, existsSync(join(REPO, 'src-tauri/target/release/examples/e2e_scope_seed.exe')) ? 'src-tauri/target/release/examples/e2e_scope_seed.exe' : 'src-tauri/target/debug/examples/e2e_scope_seed.exe');
const sha256File = (p) => { try { return createHash('sha256').update(readFileSync(p)).digest('hex'); } catch { return null; } };
const IDENT = 'com.lataif.app.e2e', CDP = 9223, PORT = 3011, BASE = `http://127.0.0.1:${PORT}`;
const OWNER = 'admin@lataif.com', OWNER_PW = 'perf-' + Math.random().toString(36).slice(2);
const RA = process.env.APPDATA, LA = process.env.LOCALAPPDATA;
const ADD = join(RA, IDENT), WV = join(LA, IDENT), DB = join(ADD, 'lataif_sync_server.db');
const PROD_DB = join(RA, 'com.lataif.app', 'lataif_sync_server.db');
const RUN = join(os.tmpdir(), 'lataif-perf-app', 'r' + Date.now());
const runId = 'r' + Date.now().toString(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seed = (m, a) => execFileSync(SEED, [m, a ?? DB], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' }).trim();
const isoEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });
function killAll() { try { execFileSync('powershell', ['-NoProfile', '-Command', "Get-Process lataif -EA SilentlyContinue | Where-Object { $_.Path -like '*target\\debug*' } | Stop-Process -Force"], { stdio: 'ignore' }); } catch {} }
function procCount() { try { return parseInt(execFileSync('powershell', ['-NoProfile', '-Command', "(Get-Process lataif -EA SilentlyContinue | Where-Object { $_.Path -like '*target\\debug*' }).Count"], { encoding: 'utf8' }).trim() || '0', 10); } catch { return -1; } }
function listeners(port) { try { return parseInt(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-NetTCPConnection -State Listen -LocalPort ${port} -EA SilentlyContinue).Count`], { encoding: 'utf8' }).trim() || '0', 10); } catch { return -1; } }

async function page() { try { const l = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json(); return l.find((t) => t.type === 'page' && /tauri\.localhost/.test(t.url) && t.webSocketDebuggerUrl) || null; } catch { return null; } }
async function health() { try { return (await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; } }

class CDPc {
  constructor(u) { this.ws = new WebSocket(u); this.id = 0; this.p = new Map(); this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); }); this.ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && this.p.has(m.id)) { const { res, rej } = this.p.get(m.id); this.p.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } }); }
  send(a, p = {}) { return this.ready.then(() => { const id = ++this.id; return new Promise((res, rej) => { this.p.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method: a, params: p })); }); }); }
  ev(x) { return this.send('Runtime.evaluate', { expression: `(async()=>{ ${x} })()`, returnByValue: true, awaitPromise: true }).then((r) => r?.result?.value); }
  close() { try { this.ws.close(); } catch {} }
}
const invoke = (c, cmd, args) => c.ev(`try{const v=await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args || {})});return {ok:true,v};}catch(e){return {ok:false,e:String((e&&e.message)||e).slice(0,120)};}`);

/** Spawn the app and measure time until "interactive": CDP page up + health 200 + invoke bridge ready. */
async function startInteractive() {
  const proc = spawn(APP, [], { env: isoEnv(), stdio: 'ignore' });
  const end = Date.now() + 60000; let pg = null;
  while (Date.now() < end) { pg = await page(); if (pg) break; await sleep(80); }
  if (!pg) throw new Error('no CDP page');
  const c = new CDPc(pg.webSocketDebuggerUrl);
  while (Date.now() < end) { if (await c.ev('return !!(window.__TAURI_INTERNALS__&&window.__TAURI_INTERNALS__.invoke);').catch(() => false)) break; await sleep(80); }
  const he = Date.now() + 40000; while (Date.now() < he) { if (await health()) break; await sleep(120); }
  if (!(await health())) throw new Error('no health');
  return { proc, c };
}

async function main() {
  killAll(); rmSync(ADD, { recursive: true, force: true }); rmSync(WV, { recursive: true, force: true });
  mkdirSync(ADD, { recursive: true }); mkdirSync(join(RUN, 'tmp'), { recursive: true });
  // ISOLATION baseline: the PRODUCTION install (com.lataif.app) must be byte-identical before and after. We
  // fingerprint the prod server DB (sha256 + size + mtime) and the prod media-root file count. The e2e app
  // binds ONLY the isolated test port (LATAIF_E2E_SYNC_PORT=3011); it never binds production port 3001.
  const PROD_MEDIA = join(RA, 'com.lataif.app', 'media');
  const prodMediaFiles = (root) => { let n = 0; const walk = (p) => { if (!existsSync(p)) return; for (const e of readdirSync(p, { withFileTypes: true })) { const q = join(p, e.name); if (e.isDirectory()) walk(q); else n++; } }; walk(root); return n; };
  const prodSnap = () => ({ sha256: sha256File(PROD_DB), bytes: existsSync(PROD_DB) ? statSync(PROD_DB).size : 0, mtimeMs: existsSync(PROD_DB) ? statSync(PROD_DB).mtimeMs : 0, mediaFiles: prodMediaFiles(PROD_MEDIA) });
  const prodBeforeSnap = prodSnap();
  seed('seed-primary');
  const jpg = seed('jpeg', '1');
  const results = [];
  let handle = null;

  // ── cold start (fresh AppData) ──
  results.push(await measure('startup.cold', async () => { if (handle) { handle.c.close(); killAll(); await sleep(1200); } handle = await startInteractive(); return true; }, { reps: 3, warmup: 0, meta: { cold: true }, validate: (v) => v === true }));
  // ── warm start (AppData already populated; kill+respawn) ──
  results.push(await measure('startup.warm', async () => { handle.c.close(); killAll(); await sleep(1200); handle = await startInteractive(); return true; }, { reps: 7, warmup: 1, meta: { cold: false }, validate: (v) => v === true }));

  const c = handle.c;
  // ── real owner-gated GC dry-run over the running app ──
  results.push(await measure('app.gc.dry_run', async () => invoke(c, 'scan_unused_media', { email: OWNER, password: OWNER_PW }), { reps: 7, validate: (r) => r?.ok === true && r.v?.mediaRootPresent !== undefined }));
  // ── real mobile-upload ingress (HTTP POST to the isolated server) ──
  const token = (await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: OWNER, password: OWNER_PW }) })).json()).token;
  let ev = 0;
  results.push(await measure('app.mobile.ingress', async () => {
    ev++;
    const body = { protocol_version: 1, upload_event_id: `perf-${runId}-${ev}-1111-4111-8111-111111111111`.slice(0, 36), entity_id: `perfe-${runId}-${ev}-4111-8111-111111111111`.slice(0, 36), mode: 'collection', metadata: { brand: 'Perf', categoryId: 'cat-watch' }, images: [{ mime: 'image/jpeg', data_base64: jpg }] };
    const r = await fetch(`${BASE}/api/mobile/upload`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
    return r.status;
  }, { reps: 7, validate: (s) => s === 201 }));

  // ── resource / cleanup snapshot ──
  const dbBytes = existsSync(DB) ? statSync(DB).size : 0;
  const wal = existsSync(DB + '-wal') ? statSync(DB + '-wal').size : 0;
  c.close(); killAll(); await sleep(1500);
  const prodAfterSnap = prodSnap();
  const prodUnchanged = prodBeforeSnap.sha256 === prodAfterSnap.sha256 && prodBeforeSnap.bytes === prodAfterSnap.bytes
    && prodBeforeSnap.mtimeMs === prodAfterSnap.mtimeMs && prodBeforeSnap.mediaFiles === prodAfterSnap.mediaFiles;
  const cleanup = { procAfter: procCount(), listenersAfter3011: listeners(PORT), listeners3001: listeners(3001), e2eDbBytes: dbBytes, e2eWalBytes: wal };
  const isolation = {
    testPort: PORT, productionPort: 3001, e2eIdentifier: IDENT,
    e2eBoundProductionPort: false, // the e2e app is launched with LATAIF_E2E_SYNC_PORT=3011 only
    prodDbBefore: prodBeforeSnap, prodDbAfter: prodAfterSnap, prodUnchanged,
    note: '"untouched" = the production server DB (com.lataif.app) is byte-identical (sha256+size+mtime) and its media-root file count is unchanged; the e2e app binds only test port 3011.',
  };
  const extra = {
    build: { profile: PROFILE, appPath: 'src-tauri/target/' + PROFILE + '/lataif.exe', binarySha256: sha256File(APP), commit: (() => { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return 'unknown'; } })() },
    resource: cleanup, isolation,
  };
  const { jsonPath } = writeReport(runId, 'app-' + PROFILE, results, extra);

  // Commit the release-e2e-app baseline class (startup/GC/mobile) — separate from node + ui classes.
  if (PROFILE === 'release') {
    const env = envMeta();
    mergeBaselineClass('release_e2e_app', {
      buildProfile: 'release', features: ['e2e'], binarySha256: extra.build.binarySha256, commit: env.commit,
      sampleCount: null, note: 'startup.cold reps=3, startup.warm reps=7; app.gc.dry_run + app.mobile.ingress reps=7.',
      scenarios: baselineScenarios(results),
    }, { commit: env.commit, cpu: env.cpu, cpuCount: env.cpuCount, ramGB: env.totalRamGB, os: env.os, node: env.node });
  }

  const failed = results.filter((r) => r.fail > 0);
  console.log(`PERF app (${PROFILE}): ${results.length} scenarios, ${failed.length} with failures. binarySha256=${extra.build.binarySha256?.slice(0, 12)}…`);
  for (const r of results) console.log(`  ${r.name}: p50=${r.p50}ms p95=${r.p95 ?? '–'} n=${r.n} ok=${r.ok} fail=${r.fail} raw=[${(r.samples || []).map((x) => Math.round(x)).join(',')}]`);
  console.log(`  cleanup: procAfter=${cleanup.procAfter} listeners3011=${cleanup.listenersAfter3011} listeners3001=${cleanup.listeners3001}`);
  console.log(`  isolation: prodUnchanged=${prodUnchanged} (sha ${prodBeforeSnap.sha256?.slice(0, 8)}→${prodAfterSnap.sha256?.slice(0, 8)}, mediaFiles ${prodBeforeSnap.mediaFiles}→${prodAfterSnap.mediaFiles})`);
  console.log(`  json: ${jsonPath}`);
  const bad = failed.length || cleanup.procAfter !== 0 || cleanup.listenersAfter3011 !== 0 || !prodUnchanged;
  process.exit(bad ? 1 : 0);
}
main().catch((e) => { console.error('PERF APP ERROR:', e?.stack || e?.message || e); killAll(); process.exit(1); }).finally(() => { try { rmSync(RUN, { recursive: true, force: true }); } catch {} try { rmSync(ADD, { recursive: true, force: true }); } catch {} try { rmSync(WV, { recursive: true, force: true }); } catch {} });
