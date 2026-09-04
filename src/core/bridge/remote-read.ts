// CENTRAL-C2 — wie der Client fragt.
//
// Ein Weg, eine Form: `POST /api/command` mit einem Namen aus der festen Liste und einer Eingabe.
// Kein SQL, keine Tabelle, kein Sortierausdruck. Die Antwort kommt aus dem Primary-Renderer und
// damit aus der aktuellen Geschäftsdatenbank — nicht aus der Datei auf der Platte, die ihr
// hinterherhinken kann.
//
// Was hier NICHT passiert: kein Zwischenspeichern, kein Ausweichen auf eine lokale Datenbank, kein
// Ausgangskorb. Ist der Server weg, sagt der Client das. Ein Client, der im Zweifel etwas Eigenes
// zeigt, ist schlimmer als einer, der nichts zeigt.

import { clientConfig, setClientToken } from './client-mode';

/** Der Server ist nicht erreichbar, die Sitzung ist abgelaufen, oder er weist ab. */
export class RemoteReadError extends Error {
  readonly code: string;
  /** `true`, wenn eine erneute Anmeldung hilft. */
  readonly needsAuth: boolean;
  constructor(code: string, message: string, needsAuth = false) {
    super(message);
    this.name = 'RemoteReadError';
    this.code = code;
    this.needsAuth = needsAuth;
  }
}

export const ERR_UNAVAILABLE = 'SERVER_UNAVAILABLE';
export const ERR_UNAUTHENTICATED = 'NOT_AUTHENTICATED';

type Fetcher = typeof fetch;

function cfg(): { url: string; token: string } {
  const c = clientConfig();
  if (!c) throw new RemoteReadError(ERR_UNAVAILABLE, 'no server configured for this client');
  if (!c.token) throw new RemoteReadError(ERR_UNAUTHENTICATED, 'not signed in', true);
  return { url: c.serverUrl, token: c.token };
}

/** Eine Kennung je Frage. Lesen wiederholt man gefahrlos; sie dient der Zuordnung, nicht der Idempotenz. */
function commandId(): string {
  const g = globalThis.crypto;
  if (g && typeof g.randomUUID === 'function') return g.randomUUID();
  // Ohne `randomUUID` (sehr alte Umgebung): aus echten Zufallsbytes bauen, nie aus `Math.random`.
  const b = new Uint8Array(16);
  g.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Stellt eine Lesefrage an den Primary. Wirft `RemoteReadError` — es gibt bewusst keinen
 * Rückgabewert „leer, weil offline": das wäre von „es gibt nichts" nicht zu unterscheiden.
 */
export async function remoteRead<T = unknown>(
  op: string,
  input: Record<string, unknown> = {},
  fetchFn: Fetcher = fetch,
): Promise<T> {
  const { url, token } = cfg();
  let res: Response;
  try {
    res = await fetchFn(`${url}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ op, commandId: commandId(), payload: input }),
    });
  } catch (e) {
    // Netz weg, Server aus, Adresse falsch — für den Benutzer ist das alles dasselbe.
    throw new RemoteReadError(ERR_UNAVAILABLE, `server not reachable: ${String(e)}`);
  }

  if (res.status === 401 || res.status === 403) {
    setClientToken(null);   // die Sitzung ist verbraucht; NICHT lokal ausweichen
    throw new RemoteReadError(ERR_UNAUTHENTICATED, 'the session is no longer valid', true);
  }
  if (res.status === 503 || res.status === 504) {
    throw new RemoteReadError(ERR_UNAVAILABLE, 'the primary is not answering right now');
  }

  let body: { ok?: boolean; value?: unknown; error?: string; message?: string };
  try {
    body = await res.json() as typeof body;
  } catch {
    throw new RemoteReadError(ERR_UNAVAILABLE, `unreadable answer (${res.status})`);
  }
  if (!res.ok || body.ok !== true) {
    throw new RemoteReadError(body.error || `HTTP_${res.status}`, body.message || 'the request was refused');
  }
  return body.value as T;
}

/** Anmelden und die Sitzung merken. Ohne Erfolg wird kein Geschäftsdatensatz gelesen. */
export async function clientLogin(email: string, password: string, fetchFn: Fetcher = fetch): Promise<void> {
  const c = clientConfig();
  if (!c) throw new RemoteReadError(ERR_UNAVAILABLE, 'no server configured for this client');
  let res: Response;
  try {
    res = await fetchFn(`${c.serverUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  } catch (e) {
    throw new RemoteReadError(ERR_UNAVAILABLE, `server not reachable: ${String(e)}`);
  }
  if (!res.ok) throw new RemoteReadError(ERR_UNAUTHENTICATED, 'wrong e-mail or password', true);
  const body = await res.json() as { token?: string };
  if (!body.token) throw new RemoteReadError(ERR_UNAUTHENTICATED, 'the server returned no session', true);
  setClientToken(body.token);
}
