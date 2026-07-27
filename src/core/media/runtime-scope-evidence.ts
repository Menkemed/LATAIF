// MOBILE-04B2A3 — the JS half of the canonical runtime-scope evidence contract.
//
// Rust owns the SSOT (the owner-configured `mobile_runtime_scope` binding) and reports it as
// `RuntimeScopeEvidence`. JS NEVER treats its own active scope as the authority: it only supplies it
// as a comparison value. The mobile pipeline may run for a scope ONLY when Rust reports a configured
// binding AND that binding matches, byte-for-byte, the active auth/DB scope. Anything else — no
// binding, a tenant mismatch, a branch mismatch, or no active scope — is fail-closed.

/** The evidence Rust hands over (camelCase-serialised from the Rust struct). */
export interface RuntimeScopeEvidence {
  tenantId: string;
  branchId: string;
  serverInstanceId: string;
  bindingRevision: number;
  configured: boolean;
}

/** The active JS auth/DB scope, or null when unauthenticated / no DB. */
export interface ActiveScope {
  tenantId: string;
  branchId: string;
}

/**
 * True IFF the mobile pipeline is permitted to run for this scope: Rust reports a CONFIGURED binding
 * and it equals the active scope on BOTH tenant and branch. A missing binding, a partial/empty
 * identifier, or any mismatch yields false — the hardcoded seed constants are never a fallback.
 */
export function runtimeScopeAvailable(
  rust: RuntimeScopeEvidence | null | undefined,
  active: ActiveScope | null | undefined,
): boolean {
  if (!rust || !rust.configured) return false;
  if (!active) return false;
  if (!rust.tenantId || !rust.branchId) return false;
  return rust.tenantId === active.tenantId && rust.branchId === active.branchId;
}

/** The binding revision to fence workers on. 0 when unbound (so an unbound→bound transition, or any
 *  rebind, changes the fence value and abandons a worker keyed to the old revision). */
export function runtimeBindingRevisionOf(rust: RuntimeScopeEvidence | null | undefined): number {
  return rust && rust.configured ? rust.bindingRevision : 0;
}
