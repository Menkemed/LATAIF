// HOTFIX-v0.8.25-OWNER — in-app owner-provisioning modal.
//
// Replaces the native window.prompt×2 + window.confirm chain, which was silently
// broken in the production Tauri v2 / WebView2 build: window.confirm never showed
// and returned falsy, so `server_owner_provision` was never invoked and the owner
// stayed unprovisioned with no visible error (P1). This React modal collects the
// password + repeat + an explicit Confirm button, validates client-side BEFORE the
// invoke, single-flights the invoke, and surfaces load/error/success in the modal.
//
// Security: password values live only in local state, are cleared on cancel /
// success / unmount, are never logged, and never appear in a toast, error text, or
// the DOM after close. It changes NO Rust command, DB schema, or persistence path.

import { useCallback, useEffect, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { validateOwnerPassword, explainOwnerError } from './owner-provision-logic';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called exactly once after a successful provision, so the caller can refresh
   *  the owner status. The password is already cleared by the time this fires. */
  onProvisioned: () => void;
}

export function OwnerProvisionDialog({ open, onClose, onProvisioned }: Props) {
  const [minLen, setMinLen] = useState(12);
  const [phrase, setPhrase] = useState<string | null>(null);
  const [pw1, setPw1] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => { setPw1(''); setPw2(''); setBusy(false); setError(null); }, []);
  // Clear secrets whenever the modal is not open (covers cancel + unmount).
  useEffect(() => { if (!open) reset(); }, [open, reset]);

  // Load min length + the verbatim confirmation phrase when the modal opens.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    (async () => {
      const { getServerOwnerStatus } = await import('@/core/sync/server-owner');
      const s = await getServerOwnerStatus();
      if (!alive || !s) return;
      setMinLen(s.minPasswordLength);
      setPhrase(s.confirmationPhrase);
    })();
    return () => { alive = false; };
  }, [open]);

  const close = () => { reset(); onClose(); };

  async function submit() {
    if (busy) return; // single-flight: a double confirm-click never double-submits
    const check = validateOwnerPassword(pw1, pw2, minLen);
    if (!check.ok) { setError(check.error); return; }
    if (!phrase) { setError('Could not read server status. Please reopen and try again.'); return; }
    setBusy(true);
    setError(null);
    try {
      const { provisionServerOwner } = await import('@/core/sync/server-owner');
      await provisionServerOwner(pw1, pw2, phrase);
      reset();          // wipe the password from state before anything else
      onProvisioned();  // caller refreshes owner status
      onClose();
    } catch (err) {
      setError(explainOwnerError(String((err as { message?: string })?.message ?? err)));
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={close} title="Set server owner password" width={480}>
      <div data-testid="owner-provision-modal" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p style={{ fontSize: 13, color: '#4B5563', lineHeight: 1.5 }}>
          Choose a password for this machine&apos;s sync server owner (min {minLen} characters).
          It replaces the old shared default; other devices use it to sync to this machine.
          Keep it safe — it is the only way to change the sync role later.
        </p>
        <Input
          label="NEW OWNER PASSWORD"
          data-testid="owner-pw1"
          type="password"
          autoComplete="new-password"
          value={pw1}
          onChange={(e) => { setPw1(e.target.value); if (error) setError(null); }}
          disabled={busy}
        />
        <Input
          label="REPEAT PASSWORD"
          data-testid="owner-pw2"
          type="password"
          autoComplete="new-password"
          value={pw2}
          onChange={(e) => { setPw2(e.target.value); if (error) setError(null); }}
          disabled={busy}
          onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void submit(); }}
        />
        {error && (
          <div data-testid="owner-error" style={{ color: '#B42318', fontSize: 13 }}>{error}</div>
        )}
        <div className="flex justify-end gap-2" style={{ marginTop: 4 }}>
          <Button variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
          <Button variant="primary" data-testid="owner-confirm" onClick={() => void submit()} disabled={busy}>
            {busy ? 'Setting…' : 'Set owner password'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
