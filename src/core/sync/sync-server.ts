// Thin wrapper around Tauri commands that control the embedded LAN sync server.

interface InvokeModule {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

function isTauri(): boolean {
  return !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

async function tauri(): Promise<InvokeModule | null> {
  if (!isTauri()) return null;
  return (await import('@tauri-apps/api/core')) as unknown as InvokeModule;
}

export interface ServerStatus {
  running: boolean;
  port: number;
  ip: string;
  url: string;
  /** Plan §LAN-Sync §Self-Token: vom Rust-Server beim Start generiertes JWT
   *  mit Owner-Claims, damit der Desktop-Client direkt gegen seinen eigenen
   *  Server pullen kann (kein expliziter Login nötig). */
  selfToken?: string | null;
}

export async function startSyncServer(): Promise<string> {
  const t = await tauri();
  if (!t) throw new Error('Sync server only available in desktop app');
  return (await t.invoke('sync_server_start')) as string;
}

export async function stopSyncServer(): Promise<string> {
  const t = await tauri();
  if (!t) throw new Error('Sync server only available in desktop app');
  return (await t.invoke('sync_server_stop')) as string;
}

export async function getServerStatus(): Promise<ServerStatus | null> {
  const t = await tauri();
  if (!t) return null;
  return (await t.invoke('sync_server_status')) as ServerStatus;
}

export async function discoverLanServers(timeoutSecs = 3): Promise<string[]> {
  const t = await tauri();
  if (!t) return [];
  return (await t.invoke('discover_lan_servers', { timeoutSecs })) as string[];
}
