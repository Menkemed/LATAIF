// Rückfragen („Wirklich …?") in der Desktop-App.
//
// Das Dialog-Plugin ersetzt `window.confirm` beim Start durch einen Aufruf von
// `plugin:dialog|confirm`. Diesen Befehl gibt es im Plugin (2.7) nicht mehr — es kennt nur noch
// `message` mit Knöpfen. Jede `await window.confirm(…)` wurde dadurch abgelehnt, bevor ein Fenster
// erschien: der Knopf tat scheinbar nichts (z. B. „Settle sale", „Delete payment"). Die E2E-Läufe
// ersetzen `window.confirm` selbst und sahen das nie.
//
// Hier wird `window.confirm` einmal beim Start auf die unterstützte Plugin-Funktion `confirm`
// gelegt (OK / Cancel, über `message`). Scheitert der Dialog trotzdem, gilt das als „Cancel":
// lieber nichts tun, als ohne Rückfrage handeln.
import { confirm as nativeConfirm } from '@tauri-apps/plugin-dialog';

export function installNativeConfirm(): void {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown; confirm: (m?: string) => unknown };
  if (!w.__TAURI_INTERNALS__) return;
  w.confirm = async (message?: string): Promise<boolean> => {
    try {
      return await nativeConfirm(String(message ?? ''), { title: 'LATAIF', kind: 'warning' });
    } catch (err) {
      console.error('[confirm] dialog failed — treated as Cancel:', err);
      return false;
    }
  };
}
