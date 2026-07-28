// MOBILE-04B2A5(+R1) — the dedicated secure dialog for owner runtime-scope provisioning.
//
// Owner-gated end to end: the OPTIONS read is itself owner-authorized (R1), so the dialog first takes
// the owner credentials, loads the server's own options with them, then binds/rebinds with the same
// verified credentials. No window.prompt. Credentials live only in local component state between the
// auth step and submit, and are cleared on cancel, success, error, and unmount — never stored, never
// logged, never placed in the DOM error text (see sanitizeError).

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import {
  getRuntimeScopeOptions, configureRuntimeScope,
  type RuntimeScopeOptions,
} from '@/core/sync/runtime-scope-provisioning';
import { branchesForTenant, isRebind, canConfigure, nextRevisionHint, sanitizeError } from './runtime-scope-dialog-logic';

interface Props {
  open: boolean;
  onClose: () => void;
  onConfigured?: () => void;
}

const selectStyle: CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #E5E9EE',
  background: '#FFFFFF', color: '#0F0F10', fontSize: 14,
};
const labelStyle: CSSProperties = { fontSize: 12, fontWeight: 600, color: '#6B7280', marginBottom: 4, display: 'block' };

export function RuntimeScopeDialog({ open, onClose, onConfigured }: Props) {
  const [phase, setPhase] = useState<'auth' | 'configure' | 'done'>('auth');
  const [opts, setOpts] = useState<RuntimeScopeOptions | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneRevision, setDoneRevision] = useState<number | null>(null);

  // Secret lifecycle: any close/unmount/reopen resets to an empty password.
  const reset = useCallback(() => {
    setPhase('auth'); setOpts(null); setEmail(''); setPassword('');
    setTenantId(''); setBranchId(''); setBusy(false); setError(null); setDoneRevision(null);
  }, []);
  useEffect(() => { if (!open) reset(); }, [open, reset]);

  const loadOptions = async () => {
    if (!email.trim() || !password || busy) return;
    setBusy(true); setError(null);
    try {
      const o = await getRuntimeScopeOptions({ email: email.trim(), password });
      if (!o) { setError('Only available in the desktop app.'); return; }
      setOpts(o);
      setTenantId(o.currentTenantId ?? '');
      setBranchId(o.currentBranchId ?? '');
      setPhase('configure');
    } catch (e) {
      setPassword(''); // failed auth → forget the secret immediately
      setError(sanitizeError(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!canConfigure(opts, tenantId, branchId) || busy) return;
    setBusy(true); setError(null);
    try {
      const ev = await configureRuntimeScope({ email: email.trim(), password, tenantId, branchId });
      setPassword(''); setEmail(''); // forget the secret on success
      setDoneRevision(ev.bindingRevision);
      setPhase('done');
      onConfigured?.();
    } catch (e) {
      setPassword(''); // never keep a secret after a failed attempt
      setError(sanitizeError(e));
    } finally {
      setBusy(false);
    }
  };

  const close = () => { setPassword(''); onClose(); };

  const rebind = isRebind(opts, tenantId, branchId);
  const branches = branchesForTenant(opts, tenantId);

  return (
    <Modal open={open} onClose={close} title="Mobile upload scope" width={560}>
      {phase === 'auth' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 13, color: '#6B7280' }}>
            Configuring the mobile-upload scope is an owner action. Sign in with the server owner
            credentials to load the available tenants and branches.
          </div>
          <Input label="OWNER EMAIL" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
          <Input label="OWNER PASSWORD" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
          {error && <div style={{ color: '#B42318', fontSize: 13 }}>{error}</div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
            <Button variant="primary" onClick={loadOptions} disabled={!email.trim() || !password || busy}>
              {busy ? 'Authorizing…' : 'Load options'}
            </Button>
          </div>
        </div>
      )}

      {phase === 'configure' && opts && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ fontSize: 13, color: '#6B7280' }}>
            Server installation: <code>{opts.serverInstanceId.slice(0, 12)}…</code><br />
            {opts.configured
              ? <>Current binding: <b>{opts.currentTenantId}</b> / <b>{opts.currentBranchId}</b> (revision {opts.currentBindingRevision})</>
              : <>Not configured yet — the mobile pipeline stays disabled until a scope is bound.</>}
          </div>

          <div>
            <label style={labelStyle}>TENANT</label>
            <select style={selectStyle} value={tenantId} onChange={(e) => { setTenantId(e.target.value); setBranchId(''); }}>
              <option value="">Select a tenant…</option>
              {opts.eligibleTenants.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.id})</option>)}
            </select>
          </div>

          <div>
            <label style={labelStyle}>BRANCH</label>
            <select style={selectStyle} value={branchId} onChange={(e) => setBranchId(e.target.value)} disabled={!tenantId}>
              <option value="">Select a branch…</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.id})</option>)}
            </select>
          </div>

          {rebind && (
            <div style={{ background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 8, padding: 12, fontSize: 13, color: '#9A3412' }}>
              <b>Rebind warning.</b> This changes the binding from <b>{opts.currentTenantId}/{opts.currentBranchId}</b> to
              {' '}<b>{tenantId}/{branchId}</b>. The binding revision will increase to {nextRevisionHint(opts)}.
              Mobile processing stays disabled — this only sets the scope.
            </div>
          )}

          {error && <div style={{ color: '#B42318', fontSize: 13 }}>{error}</div>}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
            <Button variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
            <Button variant="primary" onClick={submit} disabled={!canConfigure(opts, tenantId, branchId) || busy}>
              {busy ? 'Saving…' : (rebind ? 'Rebind scope' : 'Bind scope')}
            </Button>
          </div>
        </div>
      )}

      {phase === 'done' && doneRevision !== null && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ color: '#067647', fontSize: 14 }}>
            Scope bound: <b>{tenantId}</b> / <b>{branchId}</b> (revision {doneRevision}).
          </div>
          <div style={{ fontSize: 13, color: '#6B7280' }}>
            Mobile processing remains disabled — no uploads are claimed by configuring the scope.
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button variant="secondary" onClick={close}>Close</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
