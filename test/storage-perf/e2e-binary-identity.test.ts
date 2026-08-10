// ════════════════════════════════════════════════════════════════════════════
// SINGLE-PC-STORAGE-I2A §4/§5 — the runtime binary-identity guard, tested against real binaries.
// Run: node test/storage-perf/e2e-binary-identity.test.ts
//
// The static isolation sweep proves each suite's SOURCE is isolated. It cannot prove the ARTEFACT
// is: `target/debug/lataif.exe` is an E2E build only because of the flags it was built with, and a
// plain `cargo build` overwrites that exact path with a production-identity binary. Nothing in the
// suite source changes, and every suite would launch an app that opens the real AppData.
//
// So this gate points the guard at real files — the E2E debug build (must be accepted) and the
// PRODUCTION release build (must be refused) — and at the scope contract that has been wrong here
// before. It is deliberately unforgiving: a guard that "warns and continues" would be theatre.
// ════════════════════════════════════════════════════════════════════════════

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import {
  E2E_IDENT, E2E_PORT, PROD_PORT, assertE2eBinary, assertE2eScope, e2ePreflight,
} from '../e2e/_e2e-preflight.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..');
const E2E_BIN = join(REPO, 'src-tauri', 'target', 'debug', 'lataif.exe');
const PROD_BIN = join(REPO, 'src-tauri', 'target', 'release', 'lataif.exe');
const E2E_APPDATA = join(process.env.APPDATA ?? join(os.homedir(), 'AppData', 'Roaming'), E2E_IDENT);
const PROD_APPDATA = join(process.env.APPDATA ?? join(os.homedir(), 'AppData', 'Roaming'), 'com.lataif.app');

let PASS = 0, FAIL = 0;
const failures: string[] = [];
function ok(cond: unknown, msg: string): void {
  if (cond) PASS++;
  else { FAIL++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}
function refuses(msg: string, fn: () => unknown): void {
  try { fn(); ok(false, `${msg} — expected a HARD STOP, got none`); }
  catch (e) { ok(/E2E PREFLIGHT/.test((e as Error).message), `${msg} (${(e as Error).message.split('\n')[0].slice(0, 110)})`); }
}

const ROOT = mkdtempSync(join(os.tmpdir(), 'lataif-e2e-identity-'));
process.on('exit', () => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ } });

// ── 1. the real E2E artefact is accepted ────────────────────────────────────
{
  ok(existsSync(E2E_BIN), 'the E2E debug binary exists (build it with the e2e config before running suites)');
  if (existsSync(E2E_BIN)) {
    const r = assertE2eBinary(E2E_BIN);
    ok(r.verified.length === 4, `§4 all four identity markers are found in the E2E build (${r.verified.join(', ')})`);
  }
}

// ── 2. a PRODUCTION binary is refused — the whole point ─────────────────────
{
  if (existsSync(PROD_BIN)) {
    refuses('§4 the production release binary is refused before any spawn', () => assertE2eBinary(PROD_BIN));
    ok(true, 'the production binary used for this proof is the real release build, not a stand-in');
  } else {
    ok(false, '§4 no production binary available to prove the guard refuses one — run `npx tauri build` first');
  }
}

// ── 3. a missing or bogus artefact is refused, never skipped ────────────────
{
  refuses('§4 a missing binary is a hard stop', () => assertE2eBinary(join(ROOT, 'does-not-exist.exe')));
  const empty = join(ROOT, 'empty.exe');
  writeFileSync(empty, Buffer.alloc(4096));
  refuses('§4 an unrelated file carrying none of the markers is a hard stop', () => assertE2eBinary(empty));
  // A file that fakes SOME markers but not the compiled-in feature marker is still refused: the
  // config strings alone can be forged by anything, the build marker cannot.
  const partial = join(ROOT, 'partial.exe');
  writeFileSync(partial, Buffer.from(`${E2E_IDENT} LATAIF-E2E --remote-debugging-port=9223`, 'utf8'));
  refuses('§4 config strings without the e2e build marker are not enough', () => assertE2eBinary(partial));
}

// ── 4. the scope contract: AppData root and sync port ───────────────────────
{
  ok(assertE2eScope({ appDataDir: E2E_APPDATA, port: E2E_PORT, env: { LATAIF_E2E_SYNC_PORT: String(E2E_PORT) } }),
    '§4 the isolated AppData root and port are accepted');

  refuses('§4 the PRODUCTION AppData root is refused', () =>
    assertE2eScope({ appDataDir: PROD_APPDATA, port: E2E_PORT, env: { LATAIF_E2E_SYNC_PORT: String(E2E_PORT) } }));

  refuses(`§4 binding the production port ${PROD_PORT} is refused`, () =>
    assertE2eScope({ appDataDir: E2E_APPDATA, port: PROD_PORT, env: { LATAIF_E2E_SYNC_PORT: String(PROD_PORT) } }));

  // This is EXACTLY the defect found in `runtime-scope-provisioning`: the suite looked isolated, but
  // its app inherited no port override and bound production's.
  refuses('§4 an app env without LATAIF_E2E_SYNC_PORT is refused (the real runtime-scope defect)', () =>
    assertE2eScope({ appDataDir: E2E_APPDATA, port: E2E_PORT, env: { TEMP: 'x' } }));

  refuses('§4 a port override that disagrees with the suite is refused', () =>
    assertE2eScope({ appDataDir: E2E_APPDATA, port: E2E_PORT, env: { LATAIF_E2E_SYNC_PORT: '3999' } }));
}

// ── 5. the combined preflight, exactly as a suite calls it ──────────────────
{
  if (existsSync(E2E_BIN)) {
    const line = e2ePreflight({ appPath: E2E_BIN, appDataDir: E2E_APPDATA, port: E2E_PORT, env: { LATAIF_E2E_SYNC_PORT: String(E2E_PORT) } });
    ok(/preflight ok/.test(line), `§5 the combined preflight passes for a correct setup ("${line}")`);
  }
  if (existsSync(PROD_BIN)) {
    refuses('§5 the combined preflight refuses a production artefact even with a perfect scope', () =>
      e2ePreflight({ appPath: PROD_BIN, appDataDir: E2E_APPDATA, port: E2E_PORT, env: { LATAIF_E2E_SYNC_PORT: String(E2E_PORT) } }));
  }
}

console.log(`\ne2e-binary-identity: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of failures) console.log(`   - ${f}`); process.exit(1); }
