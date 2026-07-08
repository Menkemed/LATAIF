// ═══════════════════════════════════════════════════════════
// LATAIF — Pre-destructive Auto-Backup (D3)
// ═══════════════════════════════════════════════════════════
//
// Erstellt VOR jeder destruktiven Danger-Zone-Aktion automatisch einen lokalen
// Snapshot der DB-Dateien nach <appDataDir>/backups/pre_destructive_<timestamp>/.
// Schlägt das Backup fehl, MUSS die destruktive Aktion abbrechen (Aufrufer wirft weiter).
//
// Der IO-Teil ist über `BackupFsDeps` injizierbar → headless testbar (Node-fs-Adapter,
// synthetische Temp-Dateien) und fasst NIE echte App-Daten an. Kein Backup ins Repo.
//
// WAL/SHM-Hinweis: die eingebettete Sync-Server-DB (`lataif_sync_server.db`) läuft im
// WAL-Modus. Wir kopieren die Haupt-DB + `-wal` + `-shm` GEMEINSAM (soweit vorhanden) —
// zusammen ergeben sie einen wiederherstellbaren Satz, auch wenn der Snapshot nicht
// perfekt punkt-genau konsistent ist (bester verfügbarer Ansatz ohne Server-Stopp).

// Die zu sichernden Dateien (relativ zum appDataDir). lataif.db = Frontend-DB (SSOT);
// die drei sync_server-Dateien sind optional (nur vorhanden, wenn LAN-Sync lief).
export const BACKUP_SOURCE_FILES = [
  'lataif.db',
  'lataif_sync_server.db',
  'lataif_sync_server.db-wal',
  'lataif_sync_server.db-shm',
] as const;

export interface BackupFileEntry {
  name: string;
  srcPath: string;
  dstPath: string;
  size: number;
  sha256: string | null;
}

export interface BackupManifest {
  warning: string;
  action: string;
  timestamp: string;
  appVersion: string;
  backupDir: string;
  files: Array<{ name: string; originalPath: string; copiedPath: string; size: number; sha256: string | null }>;
}

export interface BackupResult {
  location: string;
  dir: string;
  manifestPath: string;
  files: BackupFileEntry[];
}

// Injizierbare IO-Abhängigkeiten (Produktion: Tauri; Test: Node-fs-Adapter).
export interface BackupFsDeps {
  appDataDir(): Promise<string>;
  join(...parts: string[]): Promise<string>;
  exists(path: string): Promise<boolean>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  mkdir(path: string, opts: { recursive: boolean }): Promise<void>;
  sha256(data: Uint8Array): Promise<string>;
  appVersion(): Promise<string>;
  nowIso(): string;
}

/** Reiner Manifest-Builder (testbar, keine IO). */
export function buildBackupManifest(input: {
  action: string;
  timestamp: string;
  appVersion: string;
  backupDir: string;
  files: BackupFileEntry[];
}): BackupManifest {
  return {
    warning: 'pre-destructive backup — automatically created before a destructive Settings action',
    action: input.action,
    timestamp: input.timestamp,
    appVersion: input.appVersion,
    backupDir: input.backupDir,
    files: input.files.map((f) => ({
      name: f.name,
      originalPath: f.srcPath,
      copiedPath: f.dstPath,
      size: f.size,
      sha256: f.sha256,
    })),
  };
}

/**
 * Führt den Pre-destructive-Backup über die injizierten IO-Deps aus.
 * Wirft bei JEDEM Fehler (Ordner/Copy/Manifest) → der Aufrufer bricht die destruktive
 * Aktion ab. Erfolg: kopierte Dateien + geschriebenes manifest.json, Rückgabe mit Pfad.
 */
export async function runPreDestructiveBackup(action: string, deps: BackupFsDeps): Promise<BackupResult> {
  const timestamp = deps.nowIso();
  const safeStamp = timestamp.replace(/[:.]/g, '-'); // Windows-taugliche Ordnernamen
  const appDir = await deps.appDataDir();
  const backupDir = await deps.join(appDir, 'backups', `pre_destructive_${safeStamp}`);
  await deps.mkdir(backupDir, { recursive: true });

  const files: BackupFileEntry[] = [];
  for (const name of BACKUP_SOURCE_FILES) {
    const srcPath = await deps.join(appDir, name);
    if (!(await deps.exists(srcPath))) continue; // -wal/-shm/sync-DB können fehlen
    const bytes = await deps.readFile(srcPath);
    const dstPath = await deps.join(backupDir, name);
    await deps.writeFile(dstPath, bytes); // Fehler hier → wirft → Abbruch
    let sha: string | null = null;
    try {
      sha = await deps.sha256(bytes);
    } catch {
      sha = null; // SHA nur „wenn praktikabel" — kein Grund zum Abbruch
    }
    files.push({ name, srcPath, dstPath, size: bytes.length, sha256: sha });
  }

  if (files.length === 0) {
    throw new Error('Pre-destructive backup: keine Quell-DB-Dateien gefunden — Aktion abgebrochen.');
  }

  const appVersion = await deps.appVersion().catch(() => '?');
  const manifest = buildBackupManifest({ action, timestamp, appVersion, backupDir, files });
  const manifestPath = await deps.join(backupDir, 'manifest.json');
  await deps.writeFile(manifestPath, new TextEncoder().encode(JSON.stringify(manifest, null, 2)));

  return { location: backupDir, dir: backupDir, manifestPath, files };
}

// ── Produktions-Wrapper (Tauri) ──

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as unknown as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Tauri-Backup vor einer destruktiven Aktion. Im Browser (Dev) NICHT verfügbar → wirft,
 * damit nie ohne Backup destruktiv gelöscht wird (die App ist der reale Einsatzort).
 */
export async function createPreDestructiveBackup(action: string): Promise<BackupResult> {
  if (!isTauri()) {
    throw new Error(
      'Auto-Backup ist nur in der Desktop-App verfügbar. Bitte „Download Backup" nutzen und destruktive Aktionen in der App ausführen.'
    );
  }
  const fs = await import('@tauri-apps/plugin-fs');
  const path = await import('@tauri-apps/api/path');
  const deps: BackupFsDeps = {
    appDataDir: () => path.appDataDir(),
    join: (...parts: string[]) => path.join(...parts),
    exists: (p: string) => fs.exists(p),
    readFile: async (p: string) => new Uint8Array(await fs.readFile(p)),
    writeFile: (p: string, d: Uint8Array) => fs.writeFile(p, d),
    mkdir: (p: string, o: { recursive: boolean }) => fs.mkdir(p, o),
    sha256: sha256Hex,
    appVersion: async () => {
      try {
        const { getVersion } = await import('@tauri-apps/api/app');
        return await getVersion();
      } catch {
        return '?';
      }
    },
    nowIso: () => new Date().toISOString(),
  };
  return runPreDestructiveBackup(action, deps);
}
