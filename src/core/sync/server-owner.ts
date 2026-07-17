// M6-B2A4 — server owner provisioning.
//
// Thin wrapper around LOCAL Tauri commands. There is deliberately no HTTP equivalent:
// before the first provisioning this machine cannot tell its owner from anyone else, so
// the only boundary available is local control of the OS and the running app.
//
// What this replaces: the embedded server DB used to ship `admin@lataif.com` / `admin` as
// a working owner, identical on every installation, with no way to change it. That
// constant satisfied the owner checks AND `/auth/login` — which returns an owner JWT and
// therefore unlocked `/sync/push` to anyone on the same Wi-Fi.
//
// This module never stores a password. It passes it to Rust and forgets it.

interface InvokeModule {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

async function tauri(): Promise<InvokeModule | null> {
  if (!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) return null;
  return (await import('@tauri-apps/api/core')) as unknown as InvokeModule;
}

export interface ServerOwnerStatus {
  provisioned: boolean;
  provisioningRequired: boolean;
  minPasswordLength: number;
  confirmationPhrase: string;
}

/** Read-only. Needs no credentials — whether setup is pending is not a secret. */
export async function getServerOwnerStatus(): Promise<ServerOwnerStatus | null> {
  const t = await tauri();
  if (!t) return null;
  try {
    return (await t.invoke('server_owner_status')) as ServerOwnerStatus;
  } catch {
    return null;
  }
}

/**
 * First provisioning. Rust checks the phrase, the length and the confirmation, and
 * refuses a second run — this page cannot replace any of that, it only collects.
 */
export async function provisionServerOwner(
  password: string,
  passwordConfirmation: string,
  confirmation: string
): Promise<void> {
  const t = await tauri();
  if (!t) throw new Error('Nur in der Desktop-App verfuegbar');
  await t.invoke('server_owner_provision', {
    password,
    passwordConfirmation,
    confirmation,
  });
}

/** Change an already-provisioned owner password. Requires the current one. */
export async function changeServerOwnerPassword(
  email: string,
  currentPassword: string,
  newPassword: string,
  newPasswordConfirmation: string
): Promise<void> {
  const t = await tauri();
  if (!t) throw new Error('Nur in der Desktop-App verfuegbar');
  await t.invoke('server_owner_change_password', {
    email,
    currentPassword,
    newPassword,
    newPasswordConfirmation,
  });
}
