// ════════════════════════════════════════════════════════════════════════════
// MOBILE-04B2A7-I1 — runtime scope evidence flows through the drain bridge into every command
// Run: node test/media04b2a7/bridge-scope.test.ts
//
// Proves the wiring the A7-P0 audit found missing: the six registered mutation commands now receive
// their exact (expectedBindingRevision, expectedTenantId, expectedBranchId), sourced ONLY from the
// freshly validated worker scope; without a binding there is no claim; a wrong tenant/branch/revision
// or a rebind fails closed; and nothing runs without an explicit trigger.
// ════════════════════════════════════════════════════════════════════════════

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createTauriMobileUploadBridge, drainMobileUploads, getMobileUploadDrainWorker,
  type MobileDrainDeps, type MobileUploadBridge, type DrainScope, type ClaimGrant,
} from '../../src/core/media/mobile-upload-drain.ts';
import type { RuntimeScopeEvidence } from '../../src/core/media/runtime-scope-evidence.ts';

const _here = dirname(fileURLToPath(import.meta.url));
let PASS = 0, FAIL = 0; const failures: string[] = [];
function ok(cond: unknown, msg: string): void { if (cond) PASS++; else { FAIL++; failures.push(msg); console.log(`  ✗ ${msg}`); } }
const TENANT = 'tenant-acme', BRANCH = 'b-uuid-1';
const scopeOf = (rev: number, t = TENANT, b = BRANCH): DrainScope => ({ expectedBindingRevision: rev, expectedTenantId: t, expectedBranchId: b });
const ev = (over: Partial<RuntimeScopeEvidence> = {}): RuntimeScopeEvidence =>
  ({ tenantId: TENANT, branchId: BRANCH, serverInstanceId: 'inst', bindingRevision: 1, configured: true, ...over });

// A deps factory whose claim records the scope it was handed and returns null (empty inbox), so the
// terminal saga never runs — we only observe the claim boundary. Unused deps are safe no-op stubs.
function makeDeps(over: Partial<MobileDrainDeps>, rec: { claimScope?: DrainScope; claims: number }): MobileDrainDeps {
  const bridge: MobileUploadBridge = {
    claim: async (_id, _lease, scope) => { rec.claims++; rec.claimScope = scope; return null; },
    prepareImage: async () => { throw new Error('unused'); },
    renew: async () => true, release: async () => true, markQuarantined: async () => true,
    markReady: async () => 'marked_ready',
  };
  return {
    bridge, claimantInstanceId: 'clm-1',
    readScopeEvidence: async () => ev(),
    currentScope: () => ({ tenantId: TENANT, branchId: BRANCH }),
    readReceipt: () => null, productExists: () => false,
    readProductMetadataHash: async () => null, readBoundBatch: async () => [],
    readGalleryManifest: async () => [], readSideEffectCounts: async () => ({ changelog: 0, audit: 0 }),
    deriveCreateBatchId: () => 'b', preparePreparedMedia: async () => [],
    createProduct: async () => ({ status: 'product_save_failed', errorCode: 'x' }) as never,
    verifyReady: async () => 'ready' as never,
    ...over,
  };
}

async function main() {
  // ── §1 the Tauri bridge spreads the scope triple into EVERY command's invoke payload ──
  {
    const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
    const invoker = async <T>(cmd: string, args?: Record<string, unknown>) => { calls.push({ cmd, args: args ?? {} }); return (cmd.includes('mark_ready') ? 'marked_ready' : null) as T; };
    const b = createTauriMobileUploadBridge(invoker);
    const sc = scopeOf(7);
    await b.claim('clm', 60, sc);
    await b.prepareImage('u', 'ev', 'tok', 0, TENANT, sc);
    await b.renew('u', 'ev', 'tok', 'clm', 60, sc);
    await b.release('u', 'ev', 'tok', sc);
    await b.markQuarantined('u', 'ev', 'tok', 'code', sc);
    await b.markReady('u', 'ev', 'tok', 'e', 'h', 'p', sc);
    const cmds = ['mobile_upload_claim', 'mobile_upload_prepare_image', 'mobile_upload_renew', 'mobile_upload_release', 'mobile_upload_mark_quarantined', 'mobile_upload_mark_ready'];
    for (const cmd of cmds) {
      const c = calls.find((x) => x.cmd === cmd)!;
      ok(c && c.args.expectedBindingRevision === 7 && c.args.expectedTenantId === TENANT && c.args.expectedBranchId === BRANCH, `${cmd} invoke carries exact scope args`);
    }
    // the base args survive alongside the spread scope (spot-check claim + mark_ready).
    const claimArgs = calls.find((x) => x.cmd === 'mobile_upload_claim')!.args;
    ok(claimArgs.claimantInstanceId === 'clm' && claimArgs.leaseSeconds === 60, 'claim keeps its base args next to the scope');
  }

  // ── §2 valid binding: the validated scope reaches the real claim command ──
  {
    const rec = { claims: 0 } as { claimScope?: DrainScope; claims: number };
    const out = await drainMobileUploads(makeDeps({}, rec));
    ok(rec.claims === 1, 'valid scope: exactly one claim invoked');
    ok(!!rec.claimScope && rec.claimScope.expectedBindingRevision === 1 && rec.claimScope.expectedTenantId === TENANT && rec.claimScope.expectedBranchId === BRANCH, 'claim received the fresh validated scope');
    ok(out.some((o) => o.code === 'idle'), 'empty inbox → idle (no side effects)');
  }

  // ── §3 fail-closed: no binding / unconfigured / wrong tenant / wrong branch → NO claim ──
  for (const [name, over] of [
    ['unconfigured', { readScopeEvidence: async () => ev({ configured: false, tenantId: '', branchId: '' }) }],
    ['no evidence', { readScopeEvidence: async () => null }],
    ['wrong tenant', { readScopeEvidence: async () => ev({ tenantId: 'tenant-other' }) }],
    ['wrong branch', { readScopeEvidence: async () => ev({ branchId: 'b-other' }) }],
    ['not authenticated', { currentScope: () => null }],
  ] as Array<[string, Partial<MobileDrainDeps>]>) {
    const rec = { claims: 0 } as { claimScope?: DrainScope; claims: number };
    const out = await drainMobileUploads(makeDeps(over, rec));
    ok(rec.claims === 0, `${name}: no claim invoked (fail closed)`);
    ok(out.every((o) => o.code === 'scope_blocked'), `${name}: reported scope_blocked`);
  }

  // ── §4 rebind fences the stale worker: minted at rev 1, evidence now rev 2 → tick blocks, no claim ──
  {
    let rev = 1;
    const rec = { claims: 0 } as { claimScope?: DrainScope; claims: number };
    const deps = makeDeps({ readScopeEvidence: async () => ev({ bindingRevision: rev }) }, rec);
    const worker = await getMobileUploadDrainWorker(deps, 1);
    ok(worker !== null && worker.bindingRevision === 1, 'worker minted for revision 1');
    rev = 2; // owner rebinds → fresh evidence advances
    const res = await worker!.tick();
    ok(res.some((o) => o.code === 'scope_blocked'), 'rebind (rev 1→2): stale worker tick is scope_blocked');
    ok(rec.claims === 0, 'rebind: stale worker never claims');
  }

  // ── §5 trigger-gated: building deps / minting a worker never processes until tick is called ──
  {
    const rec = { claims: 0 } as { claimScope?: DrainScope; claims: number };
    const deps = makeDeps({}, rec);
    await getMobileUploadDrainWorker(deps, 99); // create only
    ok(rec.claims === 0, 'creating the worker performs no claim without an explicit tick');
    // and with no available binding, no worker is created at all.
    const none = await getMobileUploadDrainWorker(makeDeps({ readScopeEvidence: async () => null }, rec), 100);
    ok(none === null, 'no binding → no worker object at all');
  }

  console.log(`\nMOBILE-04B2A7-I1 bridge-scope: ${PASS} passed, ${FAIL} failed`);
  if (FAIL > 0) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
}
void main();
// keep ClaimGrant import meaningful for type-only environments
export type { ClaimGrant };
