// ════════════════════════════════════════════════════════════════════════════
// MOBILE-04B2A5-R1 §5 — RuntimeScopeDialog interaction against a MOCKED Tauri bridge.
// Run: node test/media04b2a5/dialog-interaction.test.ts
//
// No jsdom/testing-library is available and a real Tauri desktop smoke is not runnable headless, so
// this drives the dialog's REAL decision logic (runtime-scope-dialog-logic.ts — the exact functions
// the component uses) through the full owner flow against a mock bridge, asserting the secret
// lifecycle at every step. Honest token: MOBILE04B2A5_REAL_TAURI_DIALOG_SMOKE_BLOCKED.
// ════════════════════════════════════════════════════════════════════════════

import {
  branchesForTenant, isRebind, canConfigure, nextRevisionHint, sanitizeError,
} from '../../src/pages/settings/runtime-scope-dialog-logic.ts';
import type { RuntimeScopeOptions } from '../../src/core/sync/runtime-scope-provisioning.ts';

let PASS = 0, FAIL = 0; const failures: string[] = [];
function ok(c: unknown, m: string): void { if (c) PASS++; else { FAIL++; failures.push(m); console.log(`  ✗ ${m}`); } }

// ── mock Tauri bridge (models the owner-gated Rust commands) ──────────────────
const OWNER = { email: 'owner@x', password: 'good' };
const OPTIONS: RuntimeScopeOptions = {
  serverInstanceId: 'install-xyz-0001', configured: true,
  currentTenantId: 'tenant-1', currentBranchId: 'branch-main', currentBindingRevision: 3,
  eligibleTenants: [{ id: 'tenant-1', name: 'Main' }, { id: 'tenant-acme', name: 'Acme' }],
  eligibleBranches: [
    { id: 'branch-main', tenantId: 'tenant-1', name: 'HQ' },
    { id: 'b2b1f6a4-uuid', tenantId: 'tenant-acme', name: 'Acme HQ' },
  ],
};
let configureCalls = 0;
async function mockLoad(email: string, password: string): Promise<RuntimeScopeOptions> {
  if (email === OWNER.email && password === OWNER.password) return OPTIONS;
  throw new Error('MOBILE_OWNER_REQUIRED'); // Rust authorize_owner denial
}
async function mockConfigure(email: string, password: string, tenantId: string, branchId: string) {
  configureCalls++;
  if (email !== OWNER.email || password !== OWNER.password) throw new Error('MOBILE_OWNER_REQUIRED');
  const same = tenantId === OPTIONS.currentTenantId && branchId === OPTIONS.currentBranchId;
  return { tenantId, branchId, serverInstanceId: OPTIONS.serverInstanceId, bindingRevision: same ? 3 : 4, configured: true };
}

// ── a faithful state model of the dialog's two async handlers (same pure logic) ──
interface S { phase: 'auth' | 'configure' | 'done'; opts: RuntimeScopeOptions | null; email: string; password: string; tenantId: string; branchId: string; error: string | null; doneRevision: number | null }
function fresh(): S { return { phase: 'auth', opts: null, email: '', password: '', tenantId: '', branchId: '', error: null, doneRevision: null }; }
async function loadOptions(s: S) {
  if (!s.email.trim() || !s.password) return;
  s.error = null;
  try {
    const o = await mockLoad(s.email.trim(), s.password);
    s.opts = o; s.tenantId = o.currentTenantId ?? ''; s.branchId = o.currentBranchId ?? ''; s.phase = 'configure';
  } catch (e) { s.password = ''; s.error = sanitizeError(e); }
}
async function submit(s: S) {
  if (!canConfigure(s.opts, s.tenantId, s.branchId)) return;
  s.error = null;
  try {
    const ev = await mockConfigure(s.email.trim(), s.password, s.tenantId, s.branchId);
    s.password = ''; s.email = ''; s.doneRevision = ev.bindingRevision; s.phase = 'done';
  } catch (e) { s.password = ''; s.error = sanitizeError(e); }
}
function close(s: S) { s.password = ''; Object.assign(s, { ...fresh() }); }

async function main() {
  // 1) OPEN → auth phase, no secret yet.
  const s = fresh();
  ok(s.phase === 'auth' && s.password === '', 'opens in the auth phase with no secret');

  // 2) DENIED load (a normal user) → generic error, no options, secret cleared, still auth.
  s.email = 'clerk@x'; s.password = 'nope';
  await loadOptions(s);
  ok(s.error === 'Owner authorization failed.' && s.opts === null && s.phase === 'auth', 'a non-owner is denied with a generic message');
  ok(s.password === '', 'secret cleared after a failed auth');
  ok(!s.error.includes('nope'), 'error never contains the password');

  // 3) SUCCESSFUL owner load → options loaded, preset to the current binding.
  s.email = OWNER.email; s.password = OWNER.password;
  await loadOptions(s);
  ok(s.phase === 'configure' && !!s.opts, 'owner load moves to configure with server options');
  ok(s.tenantId === 'tenant-1' && s.branchId === 'branch-main', 'preset to the current binding');

  // 4) VALIDATION — cannot submit without a valid server-offered pair.
  ok(canConfigure(s.opts, 'tenant-acme', '') === false, 'no branch → cannot configure');
  ok(canConfigure(s.opts, 'tenant-acme', 'branch-main') === false, 'branch of the wrong tenant → cannot configure');
  ok(branchesForTenant(s.opts, 'tenant-acme').length === 1, 'only the tenant’s own branches are offered');

  // 5) REBIND detection + revision hint.
  s.tenantId = 'tenant-acme'; s.branchId = 'b2b1f6a4-uuid';
  ok(isRebind(s.opts, s.tenantId, s.branchId) === true, 'a different pair is a rebind');
  ok(nextRevisionHint(s.opts) === 4, 'rebind revision hint = current + 1');
  ok(canConfigure(s.opts, s.tenantId, s.branchId) === true, 'a valid non-default tenant + UUID branch can configure');

  // 6) CONFIGURE (rebind) success → done, revision bumped once, secret cleared.
  await submit(s);
  ok(s.phase === 'done' && s.doneRevision === 4, 'rebind succeeds, revision bumped exactly once');
  ok(s.password === '' && s.email === '', 'secret cleared on success');

  // 7) CLOSE → full reset, empty secret; REOPEN starts clean.
  close(s);
  ok(s.password === '' && s.phase === 'auth' && s.opts === null, 'close resets to a clean, secret-free auth state');

  // 8) CANCEL mid-flow also clears the secret.
  const s2 = fresh(); s2.email = OWNER.email; s2.password = OWNER.password; await loadOptions(s2);
  ok(s2.phase === 'configure', 'reopened + loaded');
  close(s2);
  ok(s2.password === '', 'cancel clears the secret');

  // 9) sanitizeError always returns one of the fixed, leak-free messages — never the raw error.
  const SAFE = ['Owner authorization failed.', 'Configuration rejected by the server.', 'Operation failed.'];
  ok(sanitizeError(new Error('MOBILE_OWNER_REQUIRED')) === 'Owner authorization failed.', 'auth errors are generic');
  ok(sanitizeError(new Error('MOBILE_SCOPE_BRANCH_UNKNOWN')) === 'Configuration rejected by the server.', 'scope errors are generic');
  for (const raw of ['bcrypt hash $2b$abcd', 'password=hunter2 leaked', 'DB error at /var/lib/x']) {
    const out = sanitizeError(new Error(raw));
    ok(SAFE.includes(out) && !/\$2b|hunter2|\/var|password=/i.test(out), `error "${raw.slice(0, 12)}…" is sanitized with no leak`);
  }

  console.log(`\nMOBILE-04B2A5-R1 dialog-interaction: ${PASS} passed, ${FAIL} failed (real Tauri desktop smoke BLOCKED — no headless Tauri/jsdom)`);
  if (FAIL > 0) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
