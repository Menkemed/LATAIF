// MOBILE-04B2A5 — secure owner runtime-scope provisioning (thin Tauri wrappers).
//
// The server owns the SSOT (`mobile_runtime_scope`). This module ONLY collects a choice + owner
// credentials in a dedicated dialog and forwards them to Rust; Rust re-validates the (tenant, branch)
// against its own DB and verifies the owner (bcrypt). The UI is NOT a security boundary.
//
// This module NEVER persists the password: it passes it to Rust and forgets it. No localStorage, no
// sessionStorage, no logging of any credential.

interface InvokeModule {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

async function tauri(): Promise<InvokeModule | null> {
  if (!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) return null;
  return (await import('@tauri-apps/api/core')) as unknown as InvokeModule;
}

export interface ScopeTenant { id: string; name: string }
export interface ScopeBranch { id: string; tenantId: string; name: string }

/** Server-derived options the owner dialog binds against — the install id, the current binding, and
 *  the server's OWN tenant/branch lists. Non-secret; needs no credentials. */
export interface RuntimeScopeOptions {
  serverInstanceId: string;
  configured: boolean;
  currentTenantId: string | null;
  currentBranchId: string | null;
  currentBindingRevision: number;
  eligibleTenants: ScopeTenant[];
  eligibleBranches: ScopeBranch[];
}

export interface RuntimeScopeEvidence {
  tenantId: string;
  branchId: string;
  serverInstanceId: string;
  bindingRevision: number;
  configured: boolean;
}

/**
 * Read the server-validated options. OWNER-GATED (R1): Rust verifies the owner (bcrypt) before
 * returning anything — reading the install's config options is an owner action even though the data
 * is not itself a secret. Returns null outside the desktop app. The password is forwarded and
 * forgotten here — never stored or logged.
 */
export async function getRuntimeScopeOptions(p: { email: string; password: string }): Promise<RuntimeScopeOptions | null> {
  const t = await tauri();
  if (!t) return null;
  return (await t.invoke('mobile_runtime_scope_options', { email: p.email, password: p.password })) as RuntimeScopeOptions;
}

/**
 * Configure (or rebind) the runtime scope. Rust verifies the owner (bcrypt via authorize_owner),
 * re-validates the (tenant, branch), and writes the binding in the transactional fence. The password
 * is forwarded and forgotten here — never stored or logged.
 */
export async function configureRuntimeScope(p: {
  email: string; password: string; tenantId: string; branchId: string;
}): Promise<RuntimeScopeEvidence> {
  const t = await tauri();
  if (!t) throw new Error('Nur in der Desktop-App verfuegbar');
  return (await t.invoke('mobile_runtime_scope_configure', {
    email: p.email,
    password: p.password,
    tenantId: p.tenantId,
    branchId: p.branchId,
  })) as RuntimeScopeEvidence;
}
