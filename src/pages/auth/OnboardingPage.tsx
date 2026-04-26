import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { useAuthStore } from '@/stores/authStore';

interface OnboardingProps {
  onComplete: () => void;
}

export function OnboardingPage({ onComplete }: OnboardingProps) {
  const login = useAuthStore(s => s.login);
  const [step, setStep] = useState(1);
  const [companyName, setCompanyName] = useState('');
  const [branchName, setBranchName] = useState('Main Branch');
  const [country, setCountry] = useState('BH');
  const [currency, setCurrency] = useState('BHD');
  const [userName, setUserName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [vatRate, setVatRate] = useState('10');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleFinish() {
    if (!companyName || !userName || !email || !password) {
      setError('Please fill in all required fields.');
      return;
    }

    setError('');
    setBusy(true);
    try {
      setStatus('1/5 updating in-memory records…');
      const db = getDatabase();

      // Update tenant name
      db.run(`UPDATE tenants SET name = ?, slug = ? WHERE id = 'tenant-1'`,
        [companyName, companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-')]);

      // Update branch
      db.run(`UPDATE branches SET name = ?, country = ?, currency = ? WHERE id = 'branch-main'`,
        [branchName, country, currency]);

      // Update owner user
      const encoder = new TextEncoder();
      const data = encoder.encode(password + 'lataif_salt_2026');
      const hash = await crypto.subtle.digest('SHA-256', data);
      const hashHex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');

      db.run(`UPDATE users SET name = ?, email = ?, password_hash = ? WHERE id = 'user-owner'`,
        [userName, email, hashHex]);

      // Update settings
      const now = new Date().toISOString();
      db.run(`UPDATE settings SET value = ?, updated_at = ? WHERE branch_id = 'branch-main' AND key = 'company.name'`,
        [companyName, now]);
      db.run(`UPDATE settings SET value = ?, updated_at = ? WHERE branch_id = 'branch-main' AND key = 'vat.standard_rate'`,
        [vatRate, now]);
      db.run(`UPDATE settings SET value = ?, updated_at = ? WHERE branch_id = 'branch-main' AND key = 'vat.margin_rate'`,
        [vatRate, now]);

      // Mark onboarding done (upsert — tolerates re-runs)
      db.run(
        `INSERT INTO settings (branch_id, key, value, category, updated_at) VALUES ('branch-main', 'onboarding.done', '1', 'system', ?)
         ON CONFLICT(branch_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [now]
      );

      setStatus('2/5 writing DB to disk…');
      await saveDatabase();

      setStatus('3/5 verifying in-memory DB…');
      const verify = db.exec("SELECT value FROM settings WHERE branch_id = 'branch-main' AND key = 'onboarding.done'");
      const persisted = verify.length > 0 && verify[0].values.length > 0 && verify[0].values[0][0] === '1';
      if (!persisted) throw new Error('Verify failed: onboarding.done missing after save');

      setStatus('4/5 verifying disk persistence…');
      try {
        const { reloadDbFromDisk } = await import('@/core/db/database');
        const ok = await reloadDbFromDisk();
        if (!ok) throw new Error('reloadDbFromDisk returned false — file not written');
        const verify2 = getDatabase().exec("SELECT value FROM settings WHERE branch_id = 'branch-main' AND key = 'onboarding.done'");
        const onDisk = verify2.length > 0 && verify2[0].values.length > 0 && verify2[0].values[0][0] === '1';
        if (!onDisk) throw new Error('Disk verify failed: onboarding.done not in reloaded file');
      } catch (diskErr) {
        throw new Error('Disk-save verification failed: ' + (diskErr instanceof Error ? diskErr.message : String(diskErr)));
      }

      setStatus('5/5 signing in…');
      try {
        await login(email.trim(), password);
      } catch (loginErr) {
        throw new Error('Auto-login failed: ' + (loginErr instanceof Error ? loginErr.message : String(loginErr)));
      }

      localStorage.setItem('lataif_onboarded', '1');
      setStatus('Done — entering app…');
      onComplete();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('');
      setBusy(false);
    }
  }

  const countries = [
    { code: 'BH', name: 'Bahrain', currency: 'BHD' },
    { code: 'AE', name: 'UAE', currency: 'AED' },
    { code: 'SA', name: 'Saudi Arabia', currency: 'SAR' },
    { code: 'KW', name: 'Kuwait', currency: 'KWD' },
    { code: 'QA', name: 'Qatar', currency: 'QAR' },
    { code: 'OM', name: 'Oman', currency: 'OMR' },
    { code: 'US', name: 'United States', currency: 'USD' },
    { code: 'GB', name: 'United Kingdom', currency: 'GBP' },
    { code: 'DE', name: 'Germany', currency: 'EUR' },
  ];

  return (
    <div className="flex items-center justify-center" style={{ height: '100vh', width: '100vw', background: '#EFECE2' }}>
      <div className="animate-fade-in" style={{ width: 480 }}>

        {/* Logo */}
        <div className="text-center" style={{ marginBottom: 48 }}>
          <h1 className="font-display gold-gradient" style={{ fontSize: 36, letterSpacing: '0.3em', marginBottom: 8 }}>LATAIF</h1>
          <p style={{ fontSize: 12, color: '#6B7280', letterSpacing: '0.1em', textTransform: 'uppercase' }}>Setup Your Business</p>
        </div>

        <div className="rounded-xl" style={{ background: '#FFFFFF', border: '1px solid #E5E1D6', padding: '36px 32px' }}>

          {/* Step indicator */}
          <div className="flex items-center justify-center gap-2" style={{ marginBottom: 32 }}>
            {[1, 2, 3].map(s => (
              <div key={s} className="rounded-full" style={{
                width: s === step ? 24 : 8, height: 8, transition: 'all 0.3s',
                background: s <= step ? '#0F0F10' : '#D5D1C4',
              }} />
            ))}
          </div>

          {step === 1 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              <h2 style={{ fontSize: 18, color: '#0F0F10', fontWeight: 500 }}>Your Company</h2>
              <Input label="COMPANY NAME" value={companyName} onChange={e => setCompanyName(e.target.value)} placeholder="e.g. Al-Khalifa Luxury" autoFocus />
              <Input label="BRANCH NAME" value={branchName} onChange={e => setBranchName(e.target.value)} placeholder="e.g. Main Store" />
              <div>
                <span className="text-overline" style={{ marginBottom: 8 }}>COUNTRY</span>
                <div className="flex flex-wrap gap-2" style={{ marginTop: 8 }}>
                  {countries.map(c => (
                    <button key={c.code} onClick={() => { setCountry(c.code); setCurrency(c.currency); }}
                      className="cursor-pointer rounded transition-all" style={{
                        padding: '6px 12px', fontSize: 12,
                        border: `1px solid ${country === c.code ? '#0F0F10' : '#D5D1C4'}`,
                        color: country === c.code ? '#0F0F10' : '#6B7280',
                        background: country === c.code ? 'rgba(15,15,16,0.06)' : 'transparent',
                      }}>{c.name}</button>
                  ))}
                </div>
              </div>
              <div className="flex justify-end" style={{ marginTop: 8 }}>
                <Button variant="primary" onClick={() => setStep(2)} disabled={!companyName}>Next</Button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              <h2 style={{ fontSize: 18, color: '#0F0F10', fontWeight: 500 }}>Your Account</h2>
              <Input label="YOUR NAME" value={userName} onChange={e => setUserName(e.target.value)} placeholder="Full name" autoFocus />
              <Input label="EMAIL" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@company.com" />
              <Input label="PASSWORD" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Choose a password" />
              <div className="flex justify-between" style={{ marginTop: 8 }}>
                <Button variant="ghost" onClick={() => setStep(1)}>Back</Button>
                <Button variant="primary" onClick={() => setStep(3)} disabled={!userName || !email || !password}>Next</Button>
              </div>
            </div>
          )}

          {step === 3 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              <h2 style={{ fontSize: 18, color: '#0F0F10', fontWeight: 500 }}>Tax Settings</h2>
              <Input label="VAT RATE (%)" type="number" value={vatRate} onChange={e => setVatRate(e.target.value)} placeholder="10" />
              <div style={{ padding: '12px 14px', background: '#EFECE2', borderRadius: 8, border: '1px solid #E5E1D6' }}>
                <p style={{ fontSize: 12, color: '#6B7280', lineHeight: 1.6 }}>
                  Default tax scheme is Margin Scheme (VAT on profit only). You can change this anytime in Settings.
                </p>
              </div>

              {/* Summary */}
              <div style={{ borderTop: '1px solid #E5E1D6', paddingTop: 16 }}>
                <span className="text-overline" style={{ marginBottom: 12 }}>SUMMARY</span>
                <div style={{ marginTop: 12, fontSize: 13, color: '#4B5563' }}>
                  <div style={{ marginBottom: 4 }}><strong style={{ color: '#0F0F10' }}>{companyName}</strong> — {branchName}</div>
                  <div style={{ marginBottom: 4 }}>{userName} ({email})</div>
                  <div>{countries.find(c => c.code === country)?.name} — {currency} — VAT {vatRate}%</div>
                </div>
              </div>

              {status && <p style={{ fontSize: 12, color: '#6B7280' }}>{status}</p>}
              {error && (
                <div style={{ padding: '10px 14px', background: 'rgba(220,38,38,0.08)', borderRadius: 6, border: '1px solid rgba(220,38,38,0.2)' }}>
                  <p style={{ fontSize: 12, color: '#AA6E6E', wordBreak: 'break-word', whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>{error}</p>
                </div>
              )}

              <div className="flex justify-between" style={{ marginTop: 8 }}>
                <Button variant="ghost" onClick={() => setStep(2)} disabled={busy}>Back</Button>
                <Button variant="primary" onClick={handleFinish} disabled={busy}>{busy ? 'Working…' : 'Start Using LATAIF'}</Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
