// Auto LAN setup: on first boot, try to discover an existing sync server.
// If found → save URL as client. If not → become server and announce.
// Manual override in Settings always wins.

import { discoverLanServers, getServerStatus, startSyncServer } from './sync-server';
import { getSyncUrl, setSyncConfig, startAutoSync } from './sync-service';

const LAN_MODE_KEY = 'lataif_lan_mode';      // 'server' | 'client' | 'manual'
const LAN_SETUP_DONE_KEY = 'lataif_lan_setup_done';

export type LanMode = 'server' | 'client' | 'manual' | 'off';

export function getLanMode(): LanMode {
  return (localStorage.getItem(LAN_MODE_KEY) as LanMode) || 'off';
}

export function setLanMode(mode: LanMode) {
  localStorage.setItem(LAN_MODE_KEY, mode);
}

export async function autoLanSetup(): Promise<LanMode> {
  // Already configured manually? Skip.
  if (localStorage.getItem(LAN_SETUP_DONE_KEY) === '1') {
    const mode = getLanMode();
    // Re-start local server if we were a server last time. Self-Token wird
    // bei jedem Start frisch generiert, also auch hier neu in localStorage
    // ablegen — alter Token aus vorheriger Session ist abgelaufen/ungültig.
    if (mode === 'server') {
      try {
        await startSyncServer();
        const status = await getServerStatus();
        if (status && status.url && status.selfToken) {
          setSyncConfig(status.url, status.selfToken);
          startAutoSync();
        }
      } catch { /* ignore */ }
    }
    return mode;
  }

  // Fresh boot: look for a server on LAN
  try {
    const found = await discoverLanServers(3);
    if (found.length > 0) {
      // Become client
      setSyncConfig(found[0], '');  // token set later on login
      setLanMode('client');
      localStorage.setItem(LAN_SETUP_DONE_KEY, '1');
      return 'client';
    }
  } catch { /* not in Tauri or mDNS failed */ }

  // No server found → become server
  try {
    await startSyncServer();
    const status = await getServerStatus();
    if (status && status.running && status.url) {
      // Plan §LAN-Sync §Self-Token: bei Server-Mode liefert der Rust-Server
      // direkt einen JWT mit Owner-Claims mit. Damit ist isSyncConfigured()
      // sofort true und startAutoSync() greift — User muss sich nicht extra
      // einloggen damit Pull-Loop läuft.
      setSyncConfig(status.url, status.selfToken || '');
      setLanMode('server');
      localStorage.setItem(LAN_SETUP_DONE_KEY, '1');
      if (status.selfToken) startAutoSync();
      return 'server';
    }
  } catch (err) {
    console.warn('[LAN] Could not start embedded server:', err);
  }

  setLanMode('off');
  return 'off';
}

export function resetLanSetup() {
  localStorage.removeItem(LAN_SETUP_DONE_KEY);
  localStorage.removeItem(LAN_MODE_KEY);
}

export function currentSyncUrl(): string {
  return getSyncUrl();
}

export { startAutoSync };
