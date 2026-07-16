// M6-B2A — LAN-Start: Discovery findet Server, sie WAEHLT keinen.
//
// Vorher entschied dieser Code die Rolle per Rennen:
//     3 s mDNS browsen  →  nichts gefunden  →  selbst Server werden
// Ein Discovery-Timeout ist aber von einem ausgeschalteten Host, einem traegen WLAN oder
// blockiertem mDNS nicht unterscheidbar. Zwei Geraete, die beim ausgeschalteten Host
// booten, wurden so zu zwei Servern — beide ueberzeugt, autoritativ zu sein (M6-A4 §2).
//
// Jetzt: die Rolle steht in `primary_host_config` in der Server-DB, gebunden an die
// Install-ID dieser Installation (Datei ausserhalb der DB). Nur eine ausdrueckliche
// Owner-Aktion setzt sie. Der Timeout kann nichts mehr schreiben.
//
// `lataif_lan_mode` bleibt nur noch als LESEQUELLE fuer die EINMALIGE Migration und als
// UI-Anzeige bestehen — es ist keine Autoritaetsquelle mehr.

import { discoverLanServers, getServerStatus, startSyncServer } from './sync-server';
import { getSyncUrl, setSyncConfig, startAutoSync } from './sync-service';
import { runLanStartup, type PrimaryState } from './lan-startup';

export { runLanStartup };
export type { PrimaryState, LanStartupOps } from './lan-startup';

const LAN_MODE_KEY = 'lataif_lan_mode';      // legacy: 'server' | 'client' | 'manual' | 'off'
const LAN_SETUP_DONE_KEY = 'lataif_lan_setup_done';

export type LanMode = 'server' | 'client' | 'manual' | 'off';

export interface PrimaryStatus {
  state: PrimaryState;
  mode: string;
  configured: boolean;
  mayWriteSync: boolean;
  shouldServe: boolean;
  installIdShort: string;
  instanceMatches: boolean | null;
}

export function getLanMode(): LanMode {
  return (localStorage.getItem(LAN_MODE_KEY) as LanMode) || 'off';
}

export function setLanMode(mode: LanMode) {
  localStorage.setItem(LAN_MODE_KEY, mode);
}

async function tauri() {
  try { return await import('@tauri-apps/api/core'); } catch { return null; }
}

/** Effektive Rolle vom Rust-Backend. null = nicht in Tauri. */
export async function getPrimaryStatus(): Promise<PrimaryStatus | null> {
  const t = await tauri();
  if (!t) return null;
  try { return (await t.invoke('primary_status')) as PrimaryStatus; } catch { return null; }
}

/**
 * Ausdrueckliche, OWNER-AUTORISIERTE Entscheidung. Der EINZIGE Weg, der je `primary`
 * schreibt — und er bindet immer an die Install-ID dieser Installation.
 *
 * M6-B2A1: Rust prueft die Owner-Credentials gegen den bcrypt-Hash in der Server-DB.
 * Diese UI kann die Autorisierung nicht ersetzen — sie sammelt sie nur ein. Ein direkter
 * `invoke` an dieser Seite vorbei scheitert an derselben Pruefung.
 * `configured_by` setzt Rust aus dem verifizierten Lookup; wir senden es NICHT.
 */
export async function configurePrimaryMode(
  mode: 'primary' | 'client',
  email: string,
  password: string
): Promise<void> {
  const t = await tauri();
  if (!t) throw new Error('Nur in der Desktop-App verfuegbar');
  await t.invoke('primary_configure', { mode, email, password });
}

/**
 * M6-B2A2 — Owner adoptiert eine erkannte Legacy-Serverrolle fuer DIESES Geraet.
 * Der einzige Weg von `legacy_adoption_required` zu `primary`. Rust prueft Credentials
 * und die woertliche Bestaetigung; diese Funktion sammelt sie nur ein.
 */
export const ADOPTION_CONFIRMATION = 'ADOPT_THIS_DEVICE_AS_LEGACY_PRIMARY';

export async function adoptLegacyPrimary(email: string, password: string): Promise<void> {
  const t = await tauri();
  if (!t) throw new Error('Nur in der Desktop-App verfuegbar');
  await t.invoke('primary_adopt_legacy', { email, password, confirmation: ADOPTION_CONFIRMATION });
}

/** Einmalige Uebernahme der Legacy-localStorage-Rolle. Idempotent (Rust entscheidet). */
async function migrateLegacyOnce(): Promise<void> {
  const t = await tauri();
  if (!t) return;
  try {
    await t.invoke('primary_migrate_legacy', {
      legacyMode: localStorage.getItem(LAN_MODE_KEY),
      setupDone: localStorage.getItem(LAN_SETUP_DONE_KEY) === '1',
    });
  } catch (err) {
    console.warn('[LAN] legacy migration skipped:', err);
  }
}

/** Produktiver Einstiegspunkt: Legacy einmalig migrieren, Rolle lesen, danach starten. */
export async function autoLanSetup(): Promise<PrimaryState> {
  await migrateLegacyOnce();

  const status = await getPrimaryStatus();
  if (!status) return 'unconfigured';   // kein Tauri (Browser-Dev) → kein LAN-Sync

  return runLanStartup(status.state, {
    startServer: () => startSyncServer(),
    serverStatus: () => getServerStatus(),
    discover: (t) => discoverLanServers(t),
    currentSyncUrl: () => getSyncUrl(),
    setSync: (url, token) => setSyncConfig(url, token),
    startSync: () => startAutoSync(),
  });
}

export function currentSyncUrl(): string {
  return getSyncUrl();
}

export { startAutoSync };
