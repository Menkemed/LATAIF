import { useEffect, useState } from 'react';

/**
 * POST-PARITY R7B PP-12 — wie lange etwas schon läuft, in Sekunden (0, solange es nicht läuft).
 * Ein langer Dokumentweg zeigt damit „läuft seit …" statt eines stummen Knopfs.
 */
export function useElapsedSeconds(active: boolean): number {
  const [s, setS] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t0 = Date.now();
    const h = setInterval(() => setS(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => { clearInterval(h); setS(0); };
  }, [active]);
  return active ? s : 0;
}
