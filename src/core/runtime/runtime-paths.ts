// ═══════════════════════════════════════════════════════════════════════════
// DATA-ROOT-I1 / B1 — the renderer's ONLY source of runtime paths.
//
// The renderer used to compute `appDataDir() + 'lataif.db'` itself, in three different files. That
// worked for exactly as long as the data root was guaranteed to be the AppData directory. The
// moment the root becomes configurable, a second implementation of "where is the data?" is a
// second answer waiting to disagree with the first — and the way it disagrees is that one side
// opens the real database while the other creates an empty one next to it.
//
// So there is no locator logic here. Rust resolves the data root once, at startup, before the
// webview exists, and this module asks it for the result. If Rust cannot resolve it, Rust never
// gets as far as showing a window — which means a renderer that receives paths can trust them.
//
// The result is cached for the lifetime of the window: the root cannot change while the app runs
// (a move is applied at boot, after a controlled relaunch), so re-asking would only add latency.
// ═══════════════════════════════════════════════════════════════════════════

export interface RuntimePaths {
  /** The active data root. Everything below lives inside it. */
  dataRoot: string;
  /** Stable id shared by the locator and the root's own marker. */
  rootId: string;
  /** The business database (sql.js persists to this exact file). */
  businessDb: string;
  /** The embedded LAN-sync server database. */
  syncServerDb: string;
  mediaRoot: string;
  mobileStagingRoot: string;
  /** The obfuscated OpenAI key file. */
  openaiKey: string;
  /**
   * The backups root — the owner-configured path when one is set, else `<dataRoot>/backups`.
   * NOT part of the data root by contract: it may sit on a different drive, and a data-root
   * change never rewrites it.
   */
  backupsRoot: string;
}

let cached: RuntimePaths | null = null;
let inFlight: Promise<RuntimePaths> | null = null;

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Resolve the runtime paths from the native side. Concurrent callers share one round trip.
 * Throws in the browser (dev) — there is no data root there, and silently inventing one is the
 * failure mode this whole slice exists to prevent.
 */
export async function getRuntimePaths(): Promise<RuntimePaths> {
  if (cached) return cached;
  if (!isTauri()) throw new Error('Runtime paths are only available inside the desktop app.');
  if (!inFlight) {
    inFlight = (async () => {
      const { invoke } = await import('@tauri-apps/api/core');
      const paths = (await invoke('get_runtime_paths')) as RuntimePaths;
      cached = paths;
      return paths;
    })().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

/** Test seam: drop the cache (never called in production). */
export function __resetRuntimePathsCache(): void {
  cached = null;
  inFlight = null;
}
