// Die Rückfrage der App („Wirklich …?") — ein Dialog im Design der App für jedes `await window.confirm(…)`.
// Einmal neben <App /> eingehängt; Fragen kommen der Reihe nach. Cancel, Esc und ein Klick daneben
// heißen „Nein". Esc schließt nur diese Rückfrage, nicht den Dialog darunter.
import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/Button';
import { registerConfirmHost } from '@/core/platform/native-confirm';

interface Frage { text: string; antwort: (ja: boolean) => void }

export function ConfirmHost() {
  const [queue, setQueue] = useState<Frage[]>([]);

  useEffect(() => {
    registerConfirmHost((text) => new Promise<boolean>((antwort) => setQueue((q) => [...q, { text, antwort }])));
    return () => registerConfirmHost(null);
  }, []);

  const current = queue[0];
  const answer = useCallback((ja: boolean) => {
    setQueue((q) => {
      q[0]?.antwort(ja);
      return q.slice(1);
    });
  }, []);

  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); answer(false); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [current, answer]);

  if (!current) return null;
  // Erste Zeile als Frage, der Rest als Erläuterung.
  const [frage, ...rest] = current.text.split('\n');
  const detail = rest.join('\n').trim();

  return createPortal(
    <div className="fixed inset-0 flex items-center justify-center" style={{ zIndex: 10000 }} data-app-confirm>
      <div className="absolute inset-0" style={{ background: 'rgba(15,15,16,0.45)', backdropFilter: 'blur(6px)' }}
        onClick={() => answer(false)} />
      <div className="relative animate-fade-in rounded-xl"
        style={{ width: 440, maxWidth: 'calc(100vw - 48px)', background: '#FFFFFF', border: '1px solid #E5E9EE', overflow: 'hidden' }}>
        <div style={{ padding: '20px 24px 8px' }}>
          <span className="text-overline" style={{ display: 'block', marginBottom: 8 }}>PLEASE CONFIRM</span>
          <h2 style={{ fontSize: 16, fontWeight: 500, color: '#0F0F10' }} data-app-confirm-text>{frage}</h2>
          {detail && (
            <p style={{ fontSize: 13, color: '#6B7280', marginTop: 8, whiteSpace: 'pre-line', lineHeight: 1.5 }}>{detail}</p>
          )}
        </div>
        <div className="flex justify-end gap-2" style={{ padding: '16px 24px 20px' }}>
          <Button variant="ghost" onClick={() => answer(false)} data-app-confirm-cancel>Cancel</Button>
          <Button variant="primary" autoFocus onClick={() => answer(true)} data-app-confirm-ok>OK</Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
