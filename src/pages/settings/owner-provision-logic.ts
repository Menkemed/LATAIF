// HOTFIX-v0.8.25-OWNER — pure, framework-free validation for owner provisioning.
//
// Split out from the modal so the client-side gate (min length, match, non-empty)
// is node-testable without a React renderer. Contains NO secrets logic beyond
// shape checks; it never logs, hashes, or transmits the password.

export interface OwnerPasswordCheck {
  ok: boolean;
  /** User-facing message when !ok; null on success. */
  error: string | null;
}

/**
 * Validate the two entered passwords BEFORE any invoke. A non-ok result must
 * block the provisioning invoke and surface `error` prominently in the modal.
 */
export function validateOwnerPassword(pw1: string, pw2: string, minLen: number): OwnerPasswordCheck {
  if (!pw1) return { ok: false, error: 'Please enter a password.' };
  if (pw1.length < minLen) return { ok: false, error: `Password must be at least ${minLen} characters.` };
  if (pw1 !== pw2) return { ok: false, error: 'The two passwords do not match.' };
  return { ok: true, error: null };
}

/** Map a server/invoke error to a safe message — never surfaces a hash or secret. */
export function explainOwnerError(raw: string): string {
  const msg = raw || '';
  if (msg.includes('OWNER_ALREADY_PROVISIONED')) return 'This machine already has an owner password. Use "Change password" instead.';
  if (msg.includes('NOT_CONFIRMED')) return 'Confirmation failed. Please try again.';
  if (msg.includes('PROVISIONING_REQUIRED')) return 'Server setup is not ready yet. Please try again.';
  if (/password/i.test(msg) && /short|length|12/i.test(msg)) return 'Password must be at least 12 characters.';
  if (/match/i.test(msg)) return 'The two passwords do not match.';
  // Generic fallback — deliberately does not echo the raw error (may contain internals).
  return 'Could not set the owner password. Please try again.';
}
