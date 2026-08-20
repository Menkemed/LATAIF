// ═══════════════════════════════════════════════════════════
// LATAIF — Pre-destructive Auto-Backup (D3)
// ═══════════════════════════════════════════════════════════
//
// Erstellt VOR jeder destruktiven Danger-Zone-Aktion automatisch einen lokalen
// Snapshot der DB-Dateien nach <backupsRoot>/pre_destructive_<timestamp>/.
//
// DATA-ROOT-I1 — `backupsRoot` ist der OWNER-KONFIGURIERTE Backup-Ort (dieselbe SSOT wie das
// regulaere Backup: `backup_location::resolve_root`), NICHT hart `<appDataDir>/backups`. Der alte
// harte Pfad war ein echter Bug: live zeigt die Backup-Location auf `E:\`, die Sicherung vor einem
// Factory Reset landete aber auf `C:` — an einem Ort, an dem der Owner sie nicht sucht, auf einem
// Laufwerk, das er beim Neuaufsetzen gerade platt macht.
//
// Quelle bleibt der aktive DATA ROOT; Ziel ist der davon getrennte BACKUP ROOT.
// Schlägt das Backup fehl, MUSS die destruktive Aktion abbrechen (Aufrufer wirft weiter).
//
// Der IO-Teil ist über `BackupFsDeps` injizierbar → headless testbar (Node-fs-Adapter,
// synthetische Temp-Dateien) und fasst NIE echte App-Daten an. Kein Backup ins Repo.
//
// WAL/SHM-Hinweis: die eingebettete Sync-Server-DB (`lataif_sync_server.db`) läuft im
// WAL-Modus. Wir kopieren die Haupt-DB + `-wal` + `-shm` GEMEINSAM (soweit vorhanden) —
// zusammen ergeben sie einen wiederherstellbaren Satz, auch wenn der Snapshot nicht
// perfekt punkt-genau konsistent ist (bester verfügbarer Ansatz ohne Server-Stopp).
//
// `runtime-paths` wird NUR im Tauri-Zweig geladen (dynamischer Import in
// `createPreDestructiveBackup`), wie die übrigen Tauri-Abhängigkeiten dieser Datei. Als
// statischer Top-Level-Import zog er die Tauri-Kette in jeden Importeur — auch in das
// headless-Gate `test/d3/safe-purge.test.ts`, das nur die injizierbaren reinen Funktionen
// braucht und daran mit ERR_MODULE_NOT_FOUND scheiterte.

// Die zu sichernden Dateien (relativ zum Data Root). lataif.db = Frontend-DB (SSOT);
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
  /** Der aktive Data Root — Quelle der zu sichernden Dateien. */
  dataRoot(): Promise<string>;
  /** Der konfigurierte Backup-Root — Ziel. Getrennte SSOT, kann auf einem anderen Laufwerk liegen. */
  backupsRoot(): Promise<string>;
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
 * Liest eine gerade geschriebene Kopie ZURÜCK und vergleicht sie mit dem, was sie sein soll.
 *
 * Vorher stand im Manifest die Prüfsumme der QUELLBYTES — sie sagte nichts darüber aus, ob am
 * Ziel dasselbe angekommen ist. Ein abgeschnittener Schreibvorgang (volle Platte, ausgehängtes
 * Laufwerk, stiller IO-Fehler) wäre erst beim Restore aufgefallen, also lange nachdem die
 * destruktive Aktion die Originale gelöscht hat. Genau dafür ist dieser Schritt da: das Backup
 * gilt erst als vorhanden, wenn die Kopie nachweislich am Ziel liegt.
 *
 * Fail-closed in jeder Richtung — fehlende Datei, Lesefehler, abweichende Größe, abweichender
 * Hash oder eine nicht verfügbare Hash-Funktion führen alle zum Abbruch. „Best effort" gibt es
 * hier nicht: ein nicht verifizierbares Backup ist kein Backup.
 *
 * @returns die Prüfsumme der ZURÜCKGELESENEN Bytes (identisch mit der der Quelle) fürs Manifest.
 */
async function verifyWrittenCopy(
  deps: BackupFsDeps,
  name: string,
  dstPath: string,
  sourceBytes: Uint8Array
): Promise<string> {
  const fail = (why: string): never => {
    throw new Error(`Pre-destructive backup: Kopie „${name}" nicht verifizierbar (${why}) — Aktion abgebrochen.`);
  };

  let expected: string;
  try {
    expected = await deps.sha256(sourceBytes);
  } catch {
    return fail('Prüfsumme der Quelle nicht berechenbar');
  }

  let exists = false;
  try {
    exists = await deps.exists(dstPath);
  } catch {
    return fail('Zieldatei nicht prüfbar');
  }
  if (!exists) return fail('Zieldatei fehlt nach dem Schreiben');

  let written: Uint8Array;
  try {
    written = await deps.readFile(dstPath);
  } catch {
    return fail('Zieldatei nicht lesbar');
  }
  if (written.length !== sourceBytes.length) {
    return fail(`Größe weicht ab (${written.length} statt ${sourceBytes.length} Bytes)`);
  }

  let actual: string;
  try {
    actual = await deps.sha256(written);
  } catch {
    return fail('Prüfsumme der Kopie nicht berechenbar');
  }
  if (actual !== expected) return fail('Prüfsumme weicht ab');

  return actual;
}

/**
 * Führt den Pre-destructive-Backup über die injizierten IO-Deps aus.
 * Wirft bei JEDEM Fehler (Ordner/Copy/Verifikation/Manifest) → der Aufrufer bricht die
 * destruktive Aktion ab. Erfolg heißt: jede Kopie liegt nachweislich am Ziel (zurückgelesen,
 * Größe und Prüfsumme geprüft) und das manifest.json steht ebenso verifiziert daneben.
 */
export async function runPreDestructiveBackup(action: string, deps: BackupFsDeps): Promise<BackupResult> {
  const timestamp = deps.nowIso();
  const safeStamp = timestamp.replace(/[:.]/g, '-'); // Windows-taugliche Ordnernamen
  const dataDir = await deps.dataRoot();
  const backupsRoot = await deps.backupsRoot();
  const backupDir = await deps.join(backupsRoot, `pre_destructive_${safeStamp}`);
  await deps.mkdir(backupDir, { recursive: true });

  const files: BackupFileEntry[] = [];
  for (const name of BACKUP_SOURCE_FILES) {
    const srcPath = await deps.join(dataDir, name);
    if (!(await deps.exists(srcPath))) continue; // -wal/-shm/sync-DB können fehlen
    const bytes = await deps.readFile(srcPath);
    const dstPath = await deps.join(backupDir, name);
    await deps.writeFile(dstPath, bytes); // Fehler hier → wirft → Abbruch
    const sha = await verifyWrittenCopy(deps, name, dstPath, bytes);
    files.push({ name, srcPath, dstPath, size: bytes.length, sha256: sha });
  }

  if (files.length === 0) {
    throw new Error('Pre-destructive backup: keine Quell-DB-Dateien gefunden — Aktion abgebrochen.');
  }

  const appVersion = await deps.appVersion().catch(() => '?');
  const manifest = buildBackupManifest({ action, timestamp, appVersion, backupDir, files });
  const manifestPath = await deps.join(backupDir, 'manifest.json');
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  await deps.writeFile(manifestPath, manifestBytes);
  // Das Manifest gehört zum Backup: ohne lesbares Manifest ist der Restore blind.
  await verifyWrittenCopy(deps, 'manifest.json', manifestPath, manifestBytes);

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
  const { getRuntimePaths } = await import('../runtime/runtime-paths.ts');
  const deps: BackupFsDeps = {
    dataRoot: async () => (await getRuntimePaths()).dataRoot,
    backupsRoot: async () => (await getRuntimePaths()).backupsRoot,
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
