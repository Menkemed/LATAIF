// Rückfragen („Wirklich …?") — im Design der App statt als Windows-Fenster.
//
// `window.confirm` wird beim Start ersetzt. Solange die Oberfläche steht, fragt `ConfirmHost`
// (src/components/shared/ConfirmHost.tsx) in einem eigenen Dialog der App. Nur vor dessen erstem
// Render bleibt der Weg über das Dialog-Plugin (Desktop) bzw. das Browserfenster.
//
// Hintergrund: Das Dialog-Plugin legt `window.confirm` auf `plugin:dialog|confirm`, den Befehl gibt
// es in 2.7 nicht mehr — jede Rückfrage wurde abgelehnt und der Knopf tat nichts (bis v0.8.61).
// Scheitert eine Rückfrage, gilt sie als „Cancel": lieber nichts tun, als ohne Rückfrage handeln.
import { confirm as nativeConfirm } from '@tauri-apps/plugin-dialog';

type Ask = (message: string) => Promise<boolean>;
let host: Ask | null = null;

/** Der Dialog der App meldet sich an (und beim Abbau wieder ab). */
export function registerConfirmHost(ask: Ask | null): void {
  host = ask;
}

export function installNativeConfirm(): void {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown; confirm: (m?: string) => unknown };
  const browserConfirm = typeof w.confirm === 'function' ? w.confirm.bind(window) : null;
  w.confirm = async (message?: string): Promise<boolean> => {
    const text = String(message ?? '');
    try {
      if (host) return await host(text);
      if (w.__TAURI_INTERNALS__) return await nativeConfirm(text, { title: 'LATAIF', kind: 'warning' });
      return browserConfirm ? Boolean(browserConfirm(text)) : false;
    } catch (err) {
      console.error('[confirm] dialog failed — treated as Cancel:', err);
      return false;
    }
  };
}
