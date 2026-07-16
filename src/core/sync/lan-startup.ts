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
      try {
        await ops.startServer();
        const s = await ops.serverStatus();
        if (s && s.url && s.selfToken) {
          ops.setSync(s.url, s.selfToken);
          ops.startSync();
        }
      } catch (err) {
        // Port belegt, DB-Fehler o.ae. → Problem melden, aber NICHT die Rolle aendern.
        console.warn('[LAN] primary server could not start:', err);
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
