// MOBILE-04B2A5-R1 §4/§5 — the pure decision logic behind RuntimeScopeDialog, extracted so the real
// dialog behaviour (validation, rebind detection, error sanitisation) can be driven by an integration
// test against a mocked Tauri bridge without a DOM. The component imports these verbatim.

import type { RuntimeScopeOptions, ScopeBranch } from '@/core/sync/runtime-scope-provisioning';

/** The branches that belong to the selected tenant — the only ones the owner may pick. */
export function branchesForTenant(opts: RuntimeScopeOptions | null, tenantId: string): ScopeBranch[] {
  return (opts?.eligibleBranches ?? []).filter((b) => b.tenantId === tenantId);
}

/** True when the chosen (tenant, branch) differs from the current active binding. */
export function isRebind(opts: RuntimeScopeOptions | null, tenantId: string, branchId: string): boolean {
  return !!opts?.configured && (tenantId !== opts.currentTenantId || branchId !== opts.currentBranchId);
}

/** A configure may proceed only for a server-offered (tenant, branch) pair. */
export function canConfigure(opts: RuntimeScopeOptions | null, tenantId: string, branchId: string): boolean {
  return !!tenantId && !!branchId && branchesForTenant(opts, tenantId).some((b) => b.id === branchId);
}

/** The revision a rebind will produce (for the warning text). */
export function nextRevisionHint(opts: RuntimeScopeOptions | null): number {
  return (opts?.currentBindingRevision ?? 0) + 1;
}

/**
 * Map ANY backend error to a safe, generic message. Never echoes the credential, the raw payload, or
 * DB/internal details — a leaked server error must not reach the DOM.
 */
export function sanitizeError(raw: unknown): string {
  const msg = String((raw as Error)?.message ?? raw);
  if (/OWNER|CREDENTIAL|PASSWORD|PROVISION|AUTH/i.test(msg)) return 'Owner authorization failed.';
  if (/SCOPE|TENANT|BRANCH|REVISION|CONFLICT/i.test(msg)) return 'Configuration rejected by the server.';
  return 'Operation failed.';
}
