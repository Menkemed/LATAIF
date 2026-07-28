// ════════════════════════════════════════════════════════════════════════════
// MOBILE-04B2A6-I1 — scope-gated runtime activation wiring (structural + inertness contract)
// Run: node test/media04b2a6/activation-wiring.test.ts
//
// The behavioural proofs of the evidence-driven gate live in Rust (lib.rs mobile_runtime_gate_tests +
// mobile_runtime_scope.rs fence tests). Here we prove the ACTIVATION WIRING is exactly what the slice
// promised and NOTHING more:
//   * the 6 mutation commands are registered,
//   * the hard compile-time block constant is gone and the gate is now evidence-driven,
//   * every mutation runs the gate AFTER building the server-derived scope (fail-fast) and still calls
//     the *_fenced core (authoritative in-tx fence unchanged),
//   * no auto-start of the JS worker, no new mobile-v1 route, no processing without an explicit trigger.
// ════════════════════════════════════════════════════════════════════════════

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
let PASS = 0, FAIL = 0; const failures: string[] = [];
function ok(cond: unknown, msg: string): void { if (cond) PASS++; else { FAIL++; failures.push(msg); console.log(`  ✗ ${msg}`); } }

const lib = readFileSync(join(repo, 'src-tauri/src/lib.rs'), 'utf8');
const scope = readFileSync(join(repo, 'src-tauri/src/sync/mobile_runtime_scope.rs'), 'utf8');
const wiring = readFileSync(join(repo, 'src/core/media/mobile-upload-wiring.ts'), 'utf8');
const MUTATIONS = ['mobile_upload_claim', 'mobile_upload_prepare_image', 'mobile_upload_renew', 'mobile_upload_release', 'mobile_upload_mark_quarantined', 'mobile_upload_mark_ready'];

const hStart = lib.indexOf('generate_handler![');
const handler = lib.slice(hStart, lib.indexOf('finalize_application_shutdown', hStart) + 'finalize_application_shutdown'.length);

// ── §1 — registration: all six mutation commands are wired into generate_handler! ──────────────────
{
  for (const m of MUTATIONS) ok(new RegExp(`^\\s*${m},`, 'm').test(handler), `registered in generate_handler!: ${m}`);
  // and the two scope commands + read stay registered
  for (const m of ['mobile_runtime_scope_evidence', 'mobile_runtime_scope_options', 'mobile_runtime_scope_configure']) {
    ok(new RegExp(`^\\s*${m},`, 'm').test(handler), `still registered: ${m}`);
  }
}

// ── §2 — the gate is now evidence-driven; the hard compile-time block is gone ──────────────────────
{
  ok(!/MOBILE_RUNTIME_SCOPE_SOURCE_AVAILABLE/.test(lib), 'the hard block constant MOBILE_RUNTIME_SCOPE_SOURCE_AVAILABLE is removed');
  ok(!/MOBILE_RUNTIME_SCOPE_SOURCE_BLOCKED/.test(lib), 'the unconditional block error string is gone');
  const gate = lib.slice(lib.indexOf('fn mobile_runtime_gate('), lib.indexOf('fn mobile_runtime_gate(') + 500);
  ok(/conn:\s*&rusqlite::Connection/.test(gate) && /RuntimeScopeExpectation/.test(gate), 'gate takes a connection + the caller scope (evidence-driven)');
  ok(/fence_runtime_scope\(/.test(gate), 'gate delegates to the fresh-read exact-match fence');
}

// ── §3 — each mutation: gate runs AFTER building the server-derived scope, before the fenced core ──
{
  for (const w of MUTATIONS) {
    const body = lib.slice(lib.indexOf(`fn ${w}(`), lib.indexOf(`fn ${w}(`) + 1400);
    const iScope = body.indexOf('mobile_scope_expectation(install_id,');
    const iGate = body.indexOf('mobile_runtime_gate(&conn, &scope)?');
    const iFenced = body.search(/_fenced\(/);
    ok(iScope >= 0 && iGate >= 0 && iFenced >= 0, `${w}: builds scope, calls gate, calls fenced core`);
    ok(iScope < iGate && iGate < iFenced, `${w}: order is scope → gate → fenced mutation`);
    ok(!/mobile_runtime_gate\(\)\?/.test(body), `${w}: no legacy arg-less gate call remains`);
  }
}

// ── §4 — the authoritative in-tx fence is UNCHANGED (fence still inside the mutation's IMMEDIATE tx) ─
{
  const mup = readFileSync(join(repo, 'src-tauri/src/sync/mobile_upload.rs'), 'utf8');
  ok(/fn fence_scope\(/.test(mup) && /fence_scope\(&tx, scope\)/.test(mup), 'fence_scope still runs inside the mutation tx (fence_scope(&tx, scope))');
  ok(/pub fn fence_runtime_scope\(/.test(scope) && /ERR_RUNTIME_SCOPE_REVISION_CONFLICT/.test(scope), 'the SSOT fence core is intact with its typed conflict');
  ok(/TransactionBehavior::Immediate/.test(scope), 'owner rebind keeps the IMMEDIATE write contract');
}

// ── §5 — inertness: no auto-worker start, no mobile-v1 route, no processing without explicit trigger ─
{
  // the drain is only ever entered through the explicit trigger helpers — never on import/module load.
  ok(/export function triggerMobileUploadDrainPostAuth/.test(wiring), 'the worker is entered only via an explicit trigger function');
  ok(!/setInterval|setTimeout\(|addEventListener\(/.test(wiring), 'no timer/event auto-starts the worker at wiring load');
  // the drain still reads FRESH evidence and compares the current scope — no hardcoded activation.
  ok(/readScopeEvidence/.test(wiring) && /currentScope/.test(wiring), 'drain deps still gate on fresh scope evidence + the active scope');
  // no /sync/push (mobile-v1) route touched from this activation surface.
  ok(!/\/sync\/push|sync_push|mobile.?v1/i.test(wiring), 'no mobile-v1 / sync-push route introduced in the wiring');
  // the stale "configure command is unregistered" claim was corrected.
  ok(!/owner-configure command is unregistered/.test(wiring), 'the stale unregistered-configure comment is corrected');
}

console.log(`\nMOBILE-04B2A6-I1 activation-wiring: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
