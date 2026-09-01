// SINGLE-PC-STORAGE-I2A §4/§5 — the ONE runtime guard every E2E suite passes through before it
// starts an app.
//
// ## The hazard this exists for
//
// `target/debug/lataif.exe` is only an E2E artefact because of HOW it was built:
//
//     npx tauri build --debug --no-bundle --features e2e --config src-tauri/tauri.e2e.conf.json
//
// A plain `cargo build` writes to the SAME path and produces a PRODUCTION-identity binary. Every
// suite would then launch an app that resolves `com.lataif.app` — the real AppData, the real
// database, the real media root. The suite source would still look perfect: the ports are right,
// the env is right, the paths are right. Only the artefact is wrong.
//
// Reading the source cannot catch that, so this reads the ARTEFACT. Three strings exist in a
// correctly built E2E binary and in no production build:
//
//   • `com.lataif.app.e2e`            — the isolated identifier from tauri.e2e.conf.json
//   • `LATAIF-E2E`                    — its productName
//   • `--remote-debugging-port=9223`  — its additionalBrowserArgs
//   • `LATAIF_E2E_BUILD_MARKER_V1`    — a static compiled in only under `--features e2e`
//
// The check is a HARD STOP. Not a warning, not a skip: a suite that cannot prove what it is about
// to launch must not launch it. Until now the only thing standing between a mis-built binary and a
// customer's database was the single-instance plugin noticing that production happened to be
// running — which is luck, not a guarantee.

import { existsSync, readFileSync, statSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';

/** The isolated identity every E2E app must run under. */
export const E2E_IDENT = 'com.lataif.app.e2e';
export const PROD_IDENT = 'com.lataif.app';
/** The production sync port. No E2E process may ever bind it. */
export const PROD_PORT = 3001;
export const E2E_PORT = 3011;

/** Markers that exist in a correctly built E2E binary and in no production build. */
const REQUIRED_MARKERS = [
  { name: 'isolated identifier', bytes: E2E_IDENT },
  { name: 'e2e productName', bytes: 'LATAIF-E2E' },
  { name: 'CDP browser args', bytes: '--remote-debugging-port=9223' },
  { name: 'e2e feature build marker', bytes: 'LATAIF_E2E_BUILD_MARKER_V1' },
];

export class E2eIdentityError extends Error {
  constructor(message) {
    super(`[E2E PREFLIGHT] ${message}`);
    this.name = 'E2eIdentityError';
  }
}

/**
 * Does this binary contain the marker? Searched as raw bytes, so it is independent of how the
 * linker laid the string out and needs no external tooling.
 */
function hasMarker(buf, s) {
  return buf.includes(Buffer.from(s, 'utf8'));
}

/**
 * Prove that `appPath` is the isolated E2E artefact. Throws — hard — otherwise.
 *
 * Returns the markers it found, so a suite can log what it verified rather than assert blindly.
 */
export function assertE2eBinary(appPath) {
  if (!existsSync(appPath)) {
    throw new E2eIdentityError(
      `${basename(appPath)} does not exist. Build it with:\n` +
        '  npx tauri build --debug --no-bundle --features e2e --config src-tauri/tauri.e2e.conf.json',
    );
  }
  const buf = readFileSync(appPath);
  const missing = REQUIRED_MARKERS.filter((m) => !hasMarker(buf, m.bytes)).map((m) => m.name);
  if (missing.length > 0) {
    throw new E2eIdentityError(
      `${basename(appPath)} is NOT an isolated E2E build — missing: ${missing.join(', ')}.\n` +
        'A plain `cargo build` overwrites this path with a PRODUCTION-identity binary, which would ' +
        'open the real AppData, the real database and the real media root.\n' +
        'Rebuild with:\n' +
        '  npx tauri build --debug --no-bundle --features e2e --config src-tauri/tauri.e2e.conf.json',
    );
  }
  return { verified: REQUIRED_MARKERS.map((m) => m.name), sizeBytes: statSync(appPath).size };
}

/**
 * Prove the suite's own isolation contract before anything is spawned: the AppData root it will
 * read and assert against must belong to the E2E identifier, and the sync port it exports must not
 * be production's.
 *
 * Both are cheap and both have been wrong in this repo before — `runtime-scope-provisioning` shipped
 * without `LATAIF_E2E_SYNC_PORT` at all, so its app bound 3001.
 */
export function assertE2eScope({ appDataDir, port, env }) {
  if (typeof appDataDir === 'string' && appDataDir.length > 0) {
    const tail = appDataDir.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
    if (tail !== E2E_IDENT) {
      throw new E2eIdentityError(`AppData root "${appDataDir}" is not the isolated ${E2E_IDENT} directory`);
    }
  }
  if (port !== undefined && Number(port) === PROD_PORT) {
    throw new E2eIdentityError(`port ${PROD_PORT} is the PRODUCTION sync port and may never be bound by a test`);
  }
  if (env) {
    const declared = env.LATAIF_E2E_SYNC_PORT;
    if (declared === undefined) {
      throw new E2eIdentityError(
        'the app environment does not export LATAIF_E2E_SYNC_PORT — the app would fall back to the production port',
      );
    }
    if (Number(declared) === PROD_PORT) {
      throw new E2eIdentityError(`LATAIF_E2E_SYNC_PORT is set to the production port ${PROD_PORT}`);
    }
    if (port !== undefined && Number(declared) !== Number(port)) {
      throw new E2eIdentityError(`LATAIF_E2E_SYNC_PORT (${declared}) disagrees with the suite's port (${port})`);
    }
  }
  return true;
}

/**
 * The single call a suite makes immediately before its first spawn. Verifies the artefact AND the
 * scope, and returns a one-line summary the suite can print.
 */
export function e2ePreflight({ appPath, appDataDir, port, env, firstRun = false }) {
  const bin = assertE2eBinary(appPath);
  assertE2eScope({ appDataDir, port, env });
  // DATA-ROOT-B1a — ein leeres Kontrollverzeichnis richtet sich nicht mehr von selbst ein: die App
  // fragt. Fuer eine Suite, deren Thema das nicht ist, wird die Installation vorher angelegt — mit
  // GENAU der Primitive, die auch der Knopf in der Oberflaeche aufruft. Eine Suite, die die Weiche
  // selbst pruefen will, setzt `firstRun: true` und bekommt ein wirklich leeres Verzeichnis.
  const seeded = firstRun ? null : preseedInstallation(appDataDir);
  const tail = firstRun ? ', first-run (no preseed)' : `, preseeded root ${seeded}`;
  return `e2e preflight ok — isolated binary (${bin.verified.length} markers), ${E2E_IDENT}, port ${port}${tail}`;
}

/**
 * Richte eine isolierte Installation ein, falls dort noch keine steht.
 *
 * Ruft das `examples/`-Werkzeug auf, das seinerseits `data_root::setup_new_installation` aufruft —
 * dieselbe Funktion wie die Oberflaeche. Kein von Hand geschriebener Locator, kein nachgebauter
 * Bootstrap, kein Schalter am ausgelieferten Programm.
 */
export function preseedInstallation(appDataDir) {
  assertE2eScope({ appDataDir });
  const existing = join(appDataDir, 'data-location.json');
  if (existsSync(existing)) {
    try { return JSON.parse(readFileSync(existing, 'utf8')).rootId; } catch { return 'unreadable'; }
  }
  const helper = join(process.cwd(), 'src-tauri/target/debug/examples/e2e_first_run_preseed.exe');
  if (!existsSync(helper)) {
    throw new E2eIdentityError(
      'the first-run preseed helper is missing — build it with:\n'
      + '  cargo build --manifest-path src-tauri/Cargo.toml --example e2e_first_run_preseed --features e2e'
    );
  }
  mkdirSync(appDataDir, { recursive: true });
  const out = execFileSync(helper, [appDataDir], { encoding: 'utf8' }).trim();
  if (!existsSync(existing)) throw new E2eIdentityError('the preseed helper produced no locator');
  return out;
}
