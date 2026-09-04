// CENTRAL-C2 — der zweite Rechner: eine Oberfläche ohne eigene Geschäftsdatenbank.
//
// Die entscheidende Zusage steht in einer Zeile: im Client-Modus wird `initDatabase()` **nicht**
// gerufen. Kein Datenort, keine `lataif.db`, keine Server-Datenbank, keine rootId. Was hier lokal
// liegt, ist ausschließlich, was zum Wiederverbinden nötig ist — Adresse und Sitzung. Keine
// Geschäftsdaten, auch nicht zwischengespeichert: ein Zwischenspeicher wäre eine zweite Wahrheit,
// und genau die soll es nicht mehr geben.
//
// Und es gibt keinen stillen Rückfall. Fällt der Server aus, sagt der Client das; er legt keine
// Datenbank an, um „wenigstens etwas" zu zeigen.

const KEY_MODE = 'lataif_runtime_mode';
const KEY_SERVER = 'lataif_client_server_url';
const KEY_TOKEN = 'lataif_client_token';

export type RuntimeMode = 'primary' | 'client';

/** Nur der Kontrollzustand, den ein Client zum Wiederverbinden braucht. Nie Geschäftsdaten. */
export interface ClientConfig {
  readonly serverUrl: string;
  readonly token: string | null;
}

function store(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

/**
 * In welchem Modus läuft dieses Fenster? Ohne ausdrückliche Wahl: `primary` — der bestehende
 * Rechner darf durch eine neue Datei nicht plötzlich sein Verhalten ändern.
 */
export function runtimeMode(): RuntimeMode {
  return store()?.getItem(KEY_MODE) === 'client' ? 'client' : 'primary';
}

export function isClientMode(): boolean {
  return runtimeMode() === 'client';
}

/** Die ausdrückliche Wahl „dieser Rechner ist eine Oberfläche an einem anderen Server". */
export function enterClientMode(serverUrl: string): void {
  const url = normalizeServerUrl(serverUrl);
  const s = store();
  if (!s) throw new Error('CLIENT_MODE_NO_STORAGE');
  s.setItem(KEY_MODE, 'client');
  s.setItem(KEY_SERVER, url);
}

/** Zurück zum eigenständigen Betrieb. Löscht nur Kontrollzustand — es gibt hier nichts anderes. */
export function leaveClientMode(): void {
  const s = store();
  if (!s) return;
  s.removeItem(KEY_MODE);
  s.removeItem(KEY_SERVER);
  s.removeItem(KEY_TOKEN);
}

export function clientConfig(): ClientConfig | null {
  const s = store();
  const url = s?.getItem(KEY_SERVER);
  if (!url) return null;
  return { serverUrl: url, token: s?.getItem(KEY_TOKEN) ?? null };
}

export function setClientToken(token: string | null): void {
  const s = store();
  if (!s) return;
  if (token) s.setItem(KEY_TOKEN, token);
  else s.removeItem(KEY_TOKEN);
}

/** `192.168.1.5:3001` und `http://…/` sollen dasselbe bedeuten — ohne Schrägstrich am Ende. */
export function normalizeServerUrl(raw: string): string {
  const t = raw.trim();
  if (t.length === 0) throw new Error('CLIENT_MODE_EMPTY_URL');
  const withScheme = /^https?:\/\//i.test(t) ? t : `http://${t}`;
  return withScheme.replace(/\/+$/, '');
}
