// HOTFIX-v0.8.26-PRIMARY — pure, framework-free validation for sync-primary adoption.
//
// Split out from the modal so the client-side gate (both fields present) is node-testable
// without a React renderer. Contains NO secrets logic beyond shape checks; it never logs,
// hashes, or transmits the password.

export interface AdoptInputCheck {
  ok: boolean;
  /** User-facing message when !ok; null on success. */
  error: string | null;
}

/**
 * Validate the owner email + password BEFORE any invoke. A non-ok result must block the
 * adoption invoke and surface `error` prominently in the modal.
 */
export function validateAdoptInput(email: string, password: string): AdoptInputCheck {
  if (!email || !email.trim()) return { ok: false, error: 'Please enter the owner email.' };
  if (!password) return { ok: false, error: 'Please enter the owner password.' };
  return { ok: true, error: null };
}

/** Map a server/invoke error to a safe message — never surfaces a hash or secret. */
export function explainAdoptError(raw: string): string {
  const msg = raw || '';
  if (/OWNER|CREDENTIAL|PASSWORD|AUTH/i.test(msg)) return 'Owner authorization failed. Check the owner email and password.';
  if (/read_only|different installation|copied/i.test(msg)) return 'This server database belongs to a different installation and cannot be adopted here.';
  if (/NOT_CONFIRMED|confirmation/i.test(msg)) return 'Adoption confirmation failed. Please try again.';
  if (/already|not.*legacy|state/i.test(msg)) return 'This device is not awaiting adoption. No action needed.';
  // Generic fallback — deliberately does not echo the raw error (may contain internals).
  return 'Could not adopt this device as the sync primary. Please try again.';
}
