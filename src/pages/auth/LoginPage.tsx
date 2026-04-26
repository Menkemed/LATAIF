import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useAuthStore } from '@/stores/authStore';

export function LoginPage() {
  const { login, loading, error } = useAuthStore();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    try {
      await login(email, password);
    } catch { /* error is set in store */ }
  }

  return (
    <div className="flex items-center justify-center" style={{ height: '100vh', width: '100vw', background: '#F2F7FA' }}>
      <div className="animate-fade-in" style={{ width: 400 }}>
        {/* Logo */}
        <div className="text-center" style={{ marginBottom: 56 }}>
          <h1 className="font-display gold-gradient" style={{ fontSize: 36, letterSpacing: '0.3em', marginBottom: 8 }}>
            LATAIF
          </h1>
          <p style={{ fontSize: 12, color: '#6B7280', letterSpacing: '0.15em', textTransform: 'uppercase' }}>
            Luxury Trading Operating System
          </p>
        </div>

        {/* Login Form */}
        <form onSubmit={handleLogin}>
          <div
            className="rounded-xl"
            style={{ background: '#FFFFFF', border: '1px solid #E5E9EE', padding: '36px 32px' }}
          >
            <div style={{ marginBottom: 28 }}>
              <label className="text-overline" style={{ marginBottom: 8 }}>EMAIL</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                className="w-full outline-none transition-colors duration-300"
                style={{
                  background: '#F2F7FA',
                  border: '1px solid #E5E9EE',
                  borderRadius: 6,
                  padding: '12px 14px',
                  marginTop: 8,
                  fontSize: 14,
                  color: '#0F0F10',
                }}
                onFocus={e => (e.currentTarget.style.borderColor = '#0F0F10')}
                onBlur={e => (e.currentTarget.style.borderColor = '#E5E9EE')}
                autoFocus
              />
            </div>

            <div style={{ marginBottom: 32 }}>
              <label className="text-overline" style={{ marginBottom: 8 }}>PASSWORD</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="w-full outline-none transition-colors duration-300"
                style={{
                  background: '#F2F7FA',
                  border: '1px solid #E5E9EE',
                  borderRadius: 6,
                  padding: '12px 14px',
                  marginTop: 8,
                  fontSize: 14,
                  color: '#0F0F10',
                }}
                onFocus={e => (e.currentTarget.style.borderColor = '#0F0F10')}
                onBlur={e => (e.currentTarget.style.borderColor = '#E5E9EE')}
              />
            </div>

            {error && (
              <div style={{ marginBottom: 20, padding: '10px 14px', background: 'rgba(220,38,38,0.08)', borderRadius: 6, border: '1px solid rgba(220,38,38,0.2)' }}>
                <p style={{ fontSize: 13, color: '#AA6E6E' }}>{error}</p>
              </div>
            )}

            <Button
              type="submit"
              variant="primary"
              fullWidth
              disabled={loading || !email || !password}
            >
              {loading ? 'Signing in...' : 'Sign In'}
            </Button>
          </div>
        </form>

        <div className="text-center" style={{ marginTop: 24 }}>
          <button
            onClick={async () => {
              if (!confirm('Reset database? This wipes all data on this device.')) return;
              const { resetDatabase } = await import('@/core/db/database');
              await resetDatabase(); localStorage.clear(); window.location.reload();
            }}
            className="cursor-pointer transition-colors"
            style={{ fontSize: 11, color: '#6B7280', background: 'none', border: 'none', textDecoration: 'underline' }}
            onMouseEnter={e => (e.currentTarget.style.color = '#AA6E6E')}
            onMouseLeave={e => (e.currentTarget.style.color = '#6B7280')}
          >
            Reset Database
          </button>
        </div>
      </div>
    </div>
  );
}
