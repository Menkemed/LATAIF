// ═══════════════════════════════════════════════════════════
// LATAIF — M6-B2A: LAN-Startorchestrierung (reiner Kern)
// ═══════════════════════════════════════════════════════════
//
// Reiner, Tauri-/sql.js-agnostischer Kern der LAN-Startentscheidung. KEINE Imports →
// laeuft headless im Test (injizierte Ops) und fasst nie echte Geraete/Server an.
//
// HINTERGRUND (M6-A4 §2, Option D):
// Frueher entschied `auto-lan.ts` die Rolle per Rennen:
//     3 s mDNS browsen  →  nichts gefunden  →  selbst Server werden
// Ein Discovery-Timeout ist aber von einem ausgeschalteten Host, traegem WLAN oder
// blockiertem mDNS nicht unterscheidbar. Zwei Geraete, die beim ausgeschalteten Host
// booten, wurden so zu zwei Servern — beide ueberzeugt, autoritativ zu sein.
//
// KANONISCHE REGEL:
// Discovery FINDET Server, sie WAEHLT keinen. Die Rolle steht in `primary_host_config`
// (Server-DB), gebunden an die Install-ID dieser Installation, und wird ausschliesslich
// durch eine ausdrueckliche Owner-Aktion gesetzt. Kein Zweig hier schreibt je eine Rolle.

/** Die effektive, serverseitig gehaltene Rolle (Rust: sync::primary::State). */
export type PrimaryState =
  | 'unconfigured'
  | 'primary'
  | 'client'
  | 'read_only'
  /** M6-B2A2: Legacy-Hinweis vorhanden, Owner-Adoption ausstehend. Kein Serverstart. */
  | 'legacy_adoption_required';

/** Injizierbare Seiteneffekte — damit die Startlogik headless testbar bleibt. */
export interface LanStartupOps {
  /** Startet den eingebetteten Server. Rust lehnt ab, wenn die Rolle nicht primary ist. */
  startServer(): Promise<unknown>;
  /** `selfToken` ist `null`, solange der Server nicht laeuft (siehe ServerStatus). */
  serverStatus(): Promise<{ url: string; selfToken?: string | null } | null>;
  discover(timeoutSecs: number): Promise<string[]>;
  currentSyncUrl(): string;
  setSync(url: string, token: string): void;
  startSync(): void;
  /**
   * POST-RELEASE-SERVER — optional. Called at most ONCE per boot when a persisted primary could
   * not auto-start its server after the bounded retry. The `code` is a stable token (see
   * `SERVER_ADDR_IN_USE_CODE`), never an OS-locale string. Lets the caller surface a visible
   * "auto-start failed" state instead of a silent CLIENT ONLY. Absent in headless tests.
   */
  reportAutostartFailure?(code: string): void;
  /** POST-RELEASE-SERVER — injectable delay (real setTimeout in prod, no-op in tests). */
  sleep?(ms: number): Promise<void>;
}

// POST-RELEASE-SERVER — the ONLY transient we retry: the outgoing instance has not yet released
// port 3001 after a relaunch. Structured Rust code (src-tauri/src/sync/mod.rs), not a heuristic.
export const SERVER_ADDR_IN_USE_CODE = 'SYNC_SERVER_ADDR_IN_USE';
/** At most 3 auto-start attempts per boot (1 initial + up to 2 retries). */
export const AUTOSTART_MAX_ATTEMPTS = 3;
/** Named backoff before each retry (ms). One entry per retry gap; last value reused if fewer. */
export const AUTOSTART_BACKOFF_MS = [400, 900];

function isTransientBindConflict(err: unknown): boolean {
  const msg = (err as { message?: string })?.message ?? String(err ?? '');
  return msg.includes(SERVER_ADDR_IN_USE_CODE);
}

function autostartErrorCode(err: unknown): string {
  return isTransientBindConflict(err) ? SERVER_ADDR_IN_USE_CODE : 'SYNC_SERVER_START_FAILED';
}

/**
 * KONFIGURIERTE Rolle → Startverhalten.
 *
 *   primary      → eingebetteten Server starten, Self-Token als Sync-Auth
 *   client       → nur Discovery; NIEMALS einen eigenen schreibenden Server starten
 *   read_only    → Server-DB gehoert zu einer anderen Installation → nichts anfassen
 *   unconfigured → nichts. Setup erforderlich.
 *
 * Der Rueckgabewert ist die unveraenderte Eingangsrolle: diese Funktion beobachtet und
 * startet, sie entscheidet nicht. Findet Discovery nichts oder scheitert der Serverstart,
 * bleibt die Rolle exakt wie sie war.
 */
export async function runLanStartup(
  state: PrimaryState,
  ops: LanStartupOps
): Promise<PrimaryState> {
  switch (state) {
    case 'primary': {
      // POST-RELEASE-SERVER — a persisted primary auto-starts its server on EVERY boot (this
      // branch), including after a backup-triggered relaunch. The one transient we saw in
      // production is the outgoing instance not having released port 3001 yet → `AddrInUse`.
      // We retry that specific, structured failure a bounded number of times (single cycle per
      // boot, sequential — never a parallel startServer). Any OTHER failure is permanent and is
      // NOT blindly retried. A first success ends the cycle immediately. On ultimate failure the
      // role stays 'primary' and we SURFACE it (no silent CLIENT ONLY).
      const sleep = ops.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      let lastErr: unknown = null;
      for (let attempt = 0; attempt < AUTOSTART_MAX_ATTEMPTS; attempt++) {
        try {
          await ops.startServer();
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          const isLast = attempt === AUTOSTART_MAX_ATTEMPTS - 1;
          if (!isTransientBindConflict(err) || isLast) break;
          await sleep(AUTOSTART_BACKOFF_MS[attempt] ?? AUTOSTART_BACKOFF_MS[AUTOSTART_BACKOFF_MS.length - 1]);
        }
      }
      if (lastErr) {
        // Rolle bleibt primary (kein stilles Demoten) — aber der Fehler wird SICHTBAR gemacht.
        console.warn('[LAN] primary server could not start:', lastErr);
        ops.reportAutostartFailure?.(autostartErrorCode(lastErr));
        return 'primary';
      }
      const s = await ops.serverStatus();
      if (s && s.url && s.selfToken) {
        ops.setSync(s.url, s.selfToken);
        ops.startSync();
      }
      return 'primary';
    }

    case 'client': {
      // Discovery ist reine Suche. Findet sie nichts, bleibt das Geraet Client und
      // arbeitet lokal weiter — es wird NIE selbst zum Server.
      if (!ops.currentSyncUrl()) {
        try {
          const found = await ops.discover(3);
          if (found.length > 0) ops.setSync(found[0], '');   // Token via Login
        } catch { /* mDNS aus/blockiert → weiterhin Client, nur offline */ }
      }
      ops.startSync();
      return 'client';
    }

    case 'read_only':
      console.warn('[LAN] INSTANCE_ID_MISMATCH — Server-DB gehoert zu einer anderen Installation.');
      return 'read_only';

    case 'legacy_adoption_required':
      // Ein Legacy-Hinweis sagt "dieses Geraet war Server" — das ist eine Spur, keine
      // Autorisierung. Bis der Owner adoptiert: KEIN Serverstart, kein Sync.
      console.warn('[LAN] Legacy-Serverrolle erkannt — Owner-Bestaetigung erforderlich (Einstellungen → Sync).');
      return 'legacy_adoption_required';

    default:
      return 'unconfigured';
  }
}
