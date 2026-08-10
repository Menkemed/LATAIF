// ════════════════════════════════════════════════════════════════════════════
// SINGLE-PC-STORAGE-I2 §19 — every E2E suite is classified ISOLATED or BLOCKER.
// Run: node test/storage-perf/e2e-isolation-sweep.test.ts
//
// This is a STATIC gate, deliberately. Running the suites proves they passed on one machine on one
// day; reading them proves they *cannot* reach production at all. The failure this closes was real:
// `mobile-ingress-worker` hardcoded port 3001 and never set `LATAIF_E2E_SYNC_PORT`, so its app bound
// the PRODUCTION port — with production running the suite talked to the live server, and with
// production stopped it occupied the live port itself. Nothing in the suite looked wrong.
//
// The rule every suite must satisfy:
//   • it launches the app under the ISOLATED identifier (`com.lataif.app.e2e`), never `com.lataif.app`
//   • every spawned process gets `LATAIF_E2E_SYNC_PORT` in its environment
//   • port 3001 appears only inside a line that is explicitly ABOUT production staying untouched
//   • production AppData paths are read for verification only — never as a write target
//
// A new suite that forgets any of it fails HERE, before it can ever run against a customer's data.
// ════════════════════════════════════════════════════════════════════════════

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..');
const E2E_DIR = join(REPO, 'test', 'e2e');

let PASS = 0, FAIL = 0;
const failures: string[] = [];
function ok(cond: unknown, msg: string): void {
  if (cond) PASS++;
  else { FAIL++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}

const PROD_IDENT = 'com.lataif.app';
const E2E_IDENT = 'com.lataif.app.e2e';
const PROD_PORT = '3001';
const ISOLATED_PORT = '3011';

/** A line that mentions production only to assert it stayed untouched. Those are the GOOD uses. */
function isProductionGuardLine(line: string): boolean {
  return /prod|production/i.test(line);
}

interface Verdict {
  suite: string;
  isolated: boolean;
  reasons: string[];
}

const suites = readdirSync(E2E_DIR).filter((f) => f.endsWith('.e2e.mjs')).sort();
ok(suites.length >= 8, `the sweep found the E2E suites (${suites.length})`);

const verdicts: Verdict[] = [];

for (const name of suites) {
  const src = readFileSync(join(E2E_DIR, name), 'utf8');
  const lines = src.split('\n');
  const reasons: string[] = [];

  // Does this suite launch the desktop app at all? A pure HTTP/logic suite has nothing to isolate.
  const launchesApp = /target[\\/]debug[\\/]lataif\.exe|spawn\(APP/.test(src);

  if (launchesApp) {
    // ── 1. the isolated identifier, and never the bare production one as an app identifier ──
    ok(src.includes(E2E_IDENT), `${name}: launches under the isolated identifier ${E2E_IDENT}`);
    if (!src.includes(E2E_IDENT)) reasons.push('no isolated identifier');

    // A bare `com.lataif.app` occurrence is only acceptable inside a production-guard line (the
    // suites that assert the production DB was NOT touched legitimately name that path).
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      // Strip the e2e identifier first so its `com.lataif.app` prefix is not counted twice.
      const stripped = l.split(E2E_IDENT).join('«e2e»');
      if (stripped.includes(PROD_IDENT) && !isProductionGuardLine(l)) {
        reasons.push(`line ${i + 1} names the production identifier outside a production guard`);
      }
    }

    // ── 2. every spawned process carries the isolated sync port ──
    ok(src.includes('LATAIF_E2E_SYNC_PORT'), `${name}: passes LATAIF_E2E_SYNC_PORT to the app`);
    if (!src.includes('LATAIF_E2E_SYNC_PORT')) reasons.push('LATAIF_E2E_SYNC_PORT never set');

    // The env helper must be used for EVERY spawn of the app binary: a second spawn with a plain
    // `process.env` would silently fall back to the production port.
    const spawnsWithoutEnv = lines.filter((l) => /spawn\(APP/.test(l) && !/env:/.test(l));
    ok(spawnsWithoutEnv.length === 0, `${name}: every app spawn passes an explicit env (${spawnsWithoutEnv.length} without)`);
    if (spawnsWithoutEnv.length > 0) reasons.push('an app spawn has no explicit env');

    // ── 3. the isolated port is the one actually used ──
    ok(src.includes(ISOLATED_PORT), `${name}: uses the isolated sync port ${ISOLATED_PORT}`);
    if (!src.includes(ISOLATED_PORT)) reasons.push(`does not use port ${ISOLATED_PORT}`);

    // ── 4. SINGLE-PC-STORAGE-I2A §4/§5 — the RUNTIME guard, not just the right source ──
    //
    // Everything above reads the suite. None of it can tell whether the binary about to be spawned
    // is the E2E build: a plain `cargo build` overwrites that path with a production-identity
    // artefact and leaves the source untouched. So every suite must also route through the one
    // shared preflight, and it must do so BEFORE its spawn.
    ok(src.includes("_e2e-preflight.mjs"), `${name}: imports the shared runtime identity guard`);
    if (!src.includes('_e2e-preflight.mjs')) reasons.push('does not import the runtime identity guard');
    const guardAt = src.indexOf('e2ePreflight(');
    const spawnAt = src.indexOf('spawn(APP');
    ok(guardAt >= 0, `${name}: calls e2ePreflight()`);
    if (guardAt < 0) reasons.push('never calls e2ePreflight()');
    else if (spawnAt >= 0 && guardAt > spawnAt) reasons.push('calls e2ePreflight() AFTER spawning the app');
    ok(guardAt < 0 || spawnAt < 0 || guardAt < spawnAt, `${name}: the guard runs BEFORE the app is spawned`);
  }

  // ── 4. port 3001 may only appear in a production-guard line, in EVERY suite ──
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!new RegExp(`\\b${PROD_PORT}\\b`).test(l)) continue;
    if (isProductionGuardLine(l)) continue;
    reasons.push(`line ${i + 1} uses port ${PROD_PORT} outside a production guard`);
  }

  // ── 5. no suite may WRITE to a production path ──
  // A production path may be stat-ed or queried (integrity proof) but never written or removed.
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!/PROD_[A-Z_]*(DB|MEDIA|APPDATA|ROOT)/.test(l)) continue;
    if (/writeFileSync|rmSync|mkdirSync|renameSync|unlinkSync|appendFileSync|INSERT|UPDATE|DELETE/.test(l)) {
      reasons.push(`line ${i + 1} writes to a production path`);
    }
  }

  verdicts.push({ suite: name, isolated: reasons.length === 0, reasons });
}

for (const v of verdicts) {
  ok(v.isolated, `${v.suite}: ISOLATED${v.reasons.length ? ' — BLOCKER: ' + v.reasons.join('; ') : ''}`);
}

// ── the one suite the earlier review caught, asserted by name so a regression is unmistakable ──
{
  const src = readFileSync(join(E2E_DIR, 'mobile-ingress-worker.e2e.mjs'), 'utf8');
  ok(/const PORT = 3011/.test(src), '§20 mobile-ingress-worker binds the isolated port, not 3001');
  ok(/LATAIF_E2E_SYNC_PORT/.test(src), '§20 mobile-ingress-worker exports LATAIF_E2E_SYNC_PORT to its app');
  ok(/isoEnv|appEnv/.test(src), '§20 …through a single env helper, so no spawn can miss it');
}

const blockers = verdicts.filter((v) => !v.isolated);
console.log(`\ne2e-isolation-sweep: ${PASS} passed, ${FAIL} failed — ${verdicts.length - blockers.length}/${verdicts.length} suites ISOLATED`);
if (FAIL > 0) { for (const f of failures) console.log(`   - ${f}`); process.exit(1); }
