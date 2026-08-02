// HOTFIX-v0.8.26-PRIMARY — in-app sync-primary adoption modal.
//
// Replaces the native confirm + prompt×2 chain in handleAdoptLegacy, which was silently broken
// in the production Tauri v2 / WebView2 build: the native confirm never showed and returned
// falsy, so the negated confirm gate bailed immediately and the
// `primary_adopt_legacy` invoke was never reached — the device stayed in `legacy_pending`
// (adopted_at=null) with no visible error, blocking the LAN server and mobile upload (P1).
//
// This React modal describes the primary-adoption decision, collects the owner email + a MASKED
// password, validates client-side BEFORE the invoke, single-flights the invoke, and surfaces
// load/error/success in the modal. It does NOT change the command, confirmation phrase, or the
// primary-adopt SSOT: it calls the same adoptLegacyPrimary(email, password) as before, which
// forwards the unchanged ADOPTION_CONFIRMATION to `primary_adopt_legacy`.
//
// Security: password values live only in local state, are cleared on cancel / success / unmount,
// are never logged, and never appear in a toast, error text, or the DOM after close.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { validateAdoptInput, explainAdoptError } from './primary-adopt-logic';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called exactly once after a successful adoption, so the caller can start the server and
   *  refresh the primary status. The password is already cleared by the time this fires. */
  onAdopted: () => void;
}

export function PrimaryAdoptDialog({ open, onClose, onAdopted }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => { setEmail(''); setPassword(''); setBusy(false); setError(null); }, []);
  // Clear secrets whenever the modal is not open (covers cancel + unmount).
  useEffect(() => { if (!open) reset(); }, [open, reset]);

  // Mounted flag so a late invoke result after unmount never updates UI (§4).
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const close = () => { reset(); onClose(); };

  async function submit() {
    if (busy) return; // single-flight: a double confirm-click never double-submits
    const check = validateAdoptInput(email, password);
    if (!check.ok) { setError(check.error); return; }
    setBusy(true);
    setError(null);
    try {
      const { adoptLegacyPrimary } = await import('@/core/sync/auto-lan');
      await adoptLegacyPrimary(email.trim(), password);
      if (!mounted.current) return;   // unmounted mid-invoke → discard, secrets already cleared
      reset();          // wipe the password from state before anything else
      onAdopted();      // caller starts the server + refreshes primary status
      onClose();
    } catch (err) {
      if (!mounted.current) return;   // late failure after unmount must not touch UI
      setError(explainAdoptError(String((err as { message?: string })?.message ?? err)));
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={close} title="Adopt this device as sync primary" width={480}>
      <div data-testid="primary-adopt-modal" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p style={{ fontSize: 13, color: '#4B5563', lineHeight: 1.5 }}>
          This device was a sync server before the update. Adopting it makes <strong>this installation</strong> the
          primary — other devices sync to it. Only do this if this is the real host; a copied server database must
          not be adopted here. Sign in with the server owner credentials to confirm.
        </p>
        <Input
          label="OWNER EMAIL"
          data-testid="adopt-email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => { setEmail(e.target.value); if (error) setError(null); }}
          disabled={busy}
        />
        <Input
          label="OWNER PASSWORD"
          data-testid="adopt-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => { setPassword(e.target.value); if (error) setError(null); }}
          disabled={busy}
          onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void submit(); }}
        />
        {error && (
          <div data-testid="adopt-error" style={{ color: '#B42318', fontSize: 13 }}>{error}</div>
        )}
        <div className="flex justify-end gap-2" style={{ marginTop: 4 }}>
          <Button variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
          <Button variant="primary" data-testid="adopt-confirm" onClick={() => void submit()} disabled={busy}>
            {busy ? 'Adopting…' : 'Adopt as sync primary'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
