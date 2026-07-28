// ════════════════════════════════════════════════════════════════════════════
// MOBILE-04B2A3 — canonical runtime-scope SSOT: evidence comparator + structural contract
// Run: node test/media04b2a3/runtime-scope.test.ts
//
// The Rust side owns the binding (proven by cargo tests in mobile_runtime_scope.rs / migrations.rs).
// Here we prove the JS half of the evidence contract: the pure comparator is fail-closed and exact,
// and the wiring/registration keep the pipeline inactive (evidence read registered; owner-configure
// command unregistered; the binding table is internal/never-synced).
// ════════════════════════════════════════════════════════════════════════════

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  runtimeScopeAvailable, runtimeBindingRevisionOf, type RuntimeScopeEvidence,
} from '../../src/core/media/runtime-scope-evidence.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
let PASS = 0, FAIL = 0; const failures: string[] = [];
function ok(cond: unknown, msg: string): void { if (cond) PASS++; else { FAIL++; failures.push(msg); console.log(`  ✗ ${msg}`); } }

const ACME_UUID = 'b2b1f6a4-3c2e-4f1a-9d7c-0a1b2c3d4e5f';
function evidence(over: Partial<RuntimeScopeEvidence> = {}): RuntimeScopeEvidence {
  return { tenantId: 'tenant-acme', branchId: ACME_UUID, serverInstanceId: 'install-1', bindingRevision: 1, configured: true, ...over };
}

// ── §1 comparator: available ONLY on configured + exact match (non-default tenant, UUID branch) ─
{
  const active = { tenantId: 'tenant-acme', branchId: ACME_UUID };
  ok(runtimeScopeAvailable(evidence(), active) === true, 'configured + exact match (non-default tenant, UUID branch) → available');
  // fail-closed cases
  ok(runtimeScopeAvailable(null, active) === false, 'no evidence → blocked');
  ok(runtimeScopeAvailable(evidence({ configured: false, tenantId: '', branchId: '' }), active) === false, 'unconfigured binding → blocked');
  ok(runtimeScopeAvailable(evidence(), null) === false, 'no active scope → blocked');
  ok(runtimeScopeAvailable(evidence({ tenantId: 'tenant-1' }), active) === false, 'tenant mismatch → blocked');
  ok(runtimeScopeAvailable(evidence({ branchId: 'branch-main' }), active) === false, 'branch mismatch → blocked');
  ok(runtimeScopeAvailable(evidence({ tenantId: '' }), active) === false, 'empty tenant identifier → blocked');
  ok(runtimeScopeAvailable(evidence({ branchId: '' }), active) === false, 'empty branch identifier → blocked');
  // the hardcoded seed constants are NOT a special case — only equality matters
  ok(runtimeScopeAvailable(evidence({ tenantId: 'tenant-1', branchId: 'branch-main' }), { tenantId: 'tenant-1', branchId: 'branch-main' }) === true, 'seed constants only pass by genuine equality, not by being hardcoded');
}

// ── §2 binding revision for fencing ─────────────────────────────────────────
{
  ok(runtimeBindingRevisionOf(null) === 0, 'no evidence → revision 0');
  ok(runtimeBindingRevisionOf(evidence({ configured: false })) === 0, 'unconfigured → revision 0');
  ok(runtimeBindingRevisionOf(evidence({ bindingRevision: 4 })) === 4, 'configured → its revision');
}

// ── §3 structural: Rust command surface + migration + internal classification ─
{
  const lib = readFileSync(join(repo, 'src-tauri/src/lib.rs'), 'utf8');
  const hStart = lib.indexOf('generate_handler![');
  const handler = lib.slice(hStart, lib.indexOf('finalize_application_shutdown', hStart) + 'finalize_application_shutdown'.length);
  ok(/^\s*mobile_runtime_scope_evidence,/m.test(handler), 'read-only evidence command IS registered');
  // A5 — the secure owner provisioning path IS now registered (options read + owner-gated configure),
  // but the 6 mobile MUTATION commands are still NOT (checked below).
  ok(/^\s*mobile_runtime_scope_options,/m.test(handler), 'A5: options read IS registered');
  ok(/^\s*mobile_runtime_scope_configure,/m.test(handler), 'A5: owner-gated configure IS registered');
  ok(/fn mobile_runtime_scope_configure\(/.test(lib) && /authorize_owner\(/.test(lib.slice(lib.indexOf('fn mobile_runtime_scope_configure('), lib.indexOf('fn mobile_runtime_scope_configure(') + 900)), 'configure is owner-gated (authorize_owner)');
  // R1 §1 — the OPTIONS read is ALSO owner-gated (not public just because the data has no secret).
  const optFn = lib.slice(lib.indexOf('fn mobile_runtime_scope_options('), lib.indexOf('fn mobile_runtime_scope_options(') + 700);
  ok(/email:\s*String/.test(optFn) && /authorize_owner\(/.test(optFn), 'R1: options read is owner-gated (authorize_owner)');
  for (const m of ['mobile_upload_claim', 'mobile_upload_prepare_image', 'mobile_upload_renew', 'mobile_upload_release', 'mobile_upload_mark_quarantined', 'mobile_upload_mark_ready']) {
    ok(!new RegExp(`^\\s*${m},`, 'm').test(handler), `A5: mutation command still unregistered: ${m}`);
  }
  // A5 §3/§6 — configure derives configured_by from the verified owner, never from the request body.
  const cfgFn = lib.slice(lib.indexOf('fn mobile_runtime_scope_configure('), lib.indexOf('fn mobile_runtime_scope_configure(') + 900);
  ok(!/configured_by/.test(cfgFn), 'configure command never reads configured_by from the request');

  // R1 §1 — the evidence READ command derives the install id server-side (open_config_db); its ONLY
  // parameter is Tauri state — no tenant/branch/install/revision/configured can be injected from JS.
  const evFn = lib.slice(lib.indexOf('fn mobile_runtime_scope_evidence('), lib.indexOf('fn mobile_runtime_scope_configure('));
  ok(!/tenant_id|branch_id|server_instance_id|install_id\s*:|binding_revision|configured\s*:/.test(evFn), 'read command takes no JS-supplied scope/install args');
  ok(/open_config_db\(&state\.server\)/.test(evFn) && /read_runtime_scope_evidence\(&conn, &install_id\)/.test(evFn), 'evidence uses the server-derived install id');

  // A4 §1/§3 — every internal mobile mutation wrapper builds the server-derived scope expectation and
  // calls the *_fenced core (which couples the fence INSIDE its own IMMEDIATE tx), not a pre-SELECT.
  for (const w of ['mobile_upload_claim', 'mobile_upload_prepare_image', 'mobile_upload_renew', 'mobile_upload_release', 'mobile_upload_mark_quarantined', 'mobile_upload_mark_ready']) {
    const body = lib.slice(lib.indexOf(`fn ${w}(`), lib.indexOf(`fn ${w}(`) + 1200);
    ok(/mobile_scope_expectation\(install_id,/.test(body) && /_fenced\(/.test(body), `${w} builds the scope expectation and calls the fenced core`);
  }
  // A4 — the fence is coupled inside the mutation's own IMMEDIATE transaction (the real protection is
  // in the core, not the wrapper); the rebind uses the same IMMEDIATE write contract.
  const mup = readFileSync(join(repo, 'src-tauri/src/sync/mobile_upload.rs'), 'utf8');
  ok(/fn fence_scope\(/.test(mup) && /fence_scope\(&tx, scope\)/.test(mup), 'fence runs inside the mutation tx (fence_scope(&tx, scope))');
  for (const f of ['claim_next_job_fenced', 'renew_claim_fenced', 'mark_retryable_fenced', 'mark_quarantined_claimed_fenced', 'mark_ready_fenced', 'claimed_image_for_prepare_fenced']) {
    ok(new RegExp(`pub fn ${f}\\(`).test(mup), `fenced core exists: ${f}`);
  }
  const scope = readFileSync(join(repo, 'src-tauri/src/sync/mobile_runtime_scope.rs'), 'utf8');
  ok(/pub fn fence_runtime_scope\(/.test(scope) && /MOBILE_RUNTIME_SCOPE_REVISION_CONFLICT/.test(scope), 'fence core exists with the typed conflict');
  ok(/TransactionBehavior::Immediate/.test(scope), 'the owner rebind uses the IMMEDIATE write contract');

  const migr = readFileSync(join(repo, 'src-tauri/src/sync/migrations.rs'), 'utf8');
  ok(/V0014_MOBILE_RUNTIME_SCOPE/.test(migr) && /version:\s*14/.test(migr) && /CREATE TABLE IF NOT EXISTS mobile_runtime_scope/.test(migr), 'v0014 migration creates mobile_runtime_scope');
  ok(/mobile_runtime_scope_one_active[\s\S]*?WHERE status = 'active'/.test(migr), 'partial unique index enforces exactly one active binding');

  // internal / never-synced in BOTH the Rust SSOT and the TS mirror
  const policy = readFileSync(join(repo, 'src-tauri/src/sync/sync_policy.rs'), 'utf8');
  const apply = readFileSync(join(repo, 'src/core/sync/apply-change.ts'), 'utf8');
  ok(/INTERNAL_TABLES[\s\S]*"mobile_runtime_scope"/.test(policy), 'Rust INTERNAL_TABLES lists mobile_runtime_scope');
  ok(/INTERNAL_TABLES[\s\S]*'mobile_runtime_scope'/.test(apply), 'TS INTERNAL_TABLES mirror lists mobile_runtime_scope');
}

// ── §4 A5: the secure dialog + wrapper — no window.prompt, no secret persistence/logging ──────────
{
  // strip comments so the "we deliberately avoid X" prose doesn't count as a usage of X.
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  const dlgRaw = readFileSync(join(repo, 'src/pages/settings/RuntimeScopeDialog.tsx'), 'utf8');
  const wrapRaw = readFileSync(join(repo, 'src/core/sync/runtime-scope-provisioning.ts'), 'utf8');
  const dlg = strip(dlgRaw), wrap = strip(wrapRaw), both = dlg + '\n' + wrap;
  // dedicated modal, not window.prompt/confirm as the protection layer
  ok(/<Modal/.test(dlg) && /type="password"/.test(dlg), 'a dedicated modal with a masked password input');
  ok(!/window\.prompt|window\.confirm/.test(dlg), 'no window.prompt/confirm in the scope dialog');
  // no credential persistence or logging anywhere in the dialog/wrapper (comments stripped)
  ok(!/localStorage|sessionStorage/.test(both), 'no credential persisted to storage');
  ok(!/console\.(log|info|warn|error)/.test(both), 'no console logging in the credential path');
  // the dialog binds ONLY against server-provided options + goes through the registered configure.
  ok(/getRuntimeScopeOptions\(/.test(dlg) && /configureRuntimeScope\(/.test(dlg), 'dialog uses server options + configure command');
  ok(/invoke\('mobile_runtime_scope_options'/.test(wrap) && /invoke\('mobile_runtime_scope_configure'/.test(wrap), 'wrapper calls the registered scope commands');
  // R1 §1 — the options wrapper forwards owner credentials (options is owner-gated).
  ok(/getRuntimeScopeOptions\(p:\s*\{\s*email/.test(wrap) || /email:\s*p\.email/.test(wrap), 'options wrapper forwards owner credentials');
  // rebind is surfaced (old→new + revision bump + processing stays disabled)
  ok(/Rebind/i.test(dlg) && /revision will increase/i.test(dlg) && /disabled/i.test(dlg), 'rebind warning shows old→new, revision bump, processing stays disabled');
  // R1 §4 — secret lifecycle: password cleared on close, failed auth, and success; reset on !open.
  ok(/setPassword\(''\)/.test(dlg), 'dialog clears the password from state');
  ok(/if\s*\(!open\)\s*reset\(\)/.test(dlg) && /setPassword\(''\)/.test(dlg), 'reset (on close/unmount/reopen) clears the secret');
  ok(/type="password"/.test(dlg), 'password field is masked');
  // the dialog is only reachable from the Settings owner path
  const settings = readFileSync(join(repo, 'src/pages/settings/SettingsPage.tsx'), 'utf8');
  ok(/RuntimeScopeDialog/.test(settings) && /!ownerSetupRequired/.test(settings), 'dialog wired into the authorized Settings owner path');
  // R1 §3 — the canonical audit sink (v0015) exists, is internal, and is written by configure.
  const migr2 = readFileSync(join(repo, 'src-tauri/src/sync/migrations.rs'), 'utf8');
  const policy2 = readFileSync(join(repo, 'src-tauri/src/sync/sync_policy.rs'), 'utf8');
  const apply2 = readFileSync(join(repo, 'src/core/sync/apply-change.ts'), 'utf8');
  const scope2 = readFileSync(join(repo, 'src-tauri/src/sync/mobile_runtime_scope.rs'), 'utf8');
  ok(/V0015_MOBILE_RUNTIME_SCOPE_AUDIT/.test(migr2) && /version:\s*15/.test(migr2) && /CREATE TABLE IF NOT EXISTS mobile_runtime_scope_audit/.test(migr2), 'v0015 canonical audit migration');
  ok(/INTERNAL_TABLES[\s\S]*"mobile_runtime_scope_audit"/.test(policy2) && /INTERNAL_TABLES[\s\S]*'mobile_runtime_scope_audit'/.test(apply2), 'audit sink is internal/never-synced in both SSOTs');
  ok(/INSERT INTO mobile_runtime_scope_audit/.test(scope2) && /verified_owner_id/.test(scope2), 'configure writes the canonical audit event with the verified owner');
}

console.log(`\nMOBILE-04B2A3 runtime-scope: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
