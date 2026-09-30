// ════════════════════════════════════════════════════════════════════════════
// BUSINESS-DATE — das fachliche Datum eines Vorgangs, in der Maske wählbar.
//
// Ein Auftrag, ein Einkauf, eine Reparatur, eine Kommission, eine Übergabe (Approval) oder eine
// Fertigung wird manchmal erst nachträglich erfasst. Das Datum, an dem der Vorgang WIRKLICH war,
// wählt dann der Mensch; ohne Angabe gilt der heutige Tag. EINE Regel für alle: ein echter
// Kalendertag (JJJJ-MM-TT), nicht in der Zukunft (ein Tag Spielraum für die Zeitzone).
//
// Rein, ohne Datenbank und ohne Alias-Importe — Maske, Haus und Fernbefehl prüfen damit dasselbe.
// Das Telefon trägt dieselbe Regel in `src-tauri/src/sync/mobile_business_date.js` (dort kann kein
// Modul importiert werden); `test/business-date` hält beide Wert für Wert gleich.
// ════════════════════════════════════════════════════════════════════════════

const TAG = 86_400_000;

/** Der heutige Tag, wie die Masken ihn überall vorbelegen. */
export function todayIso(nowMs: number = Date.now()): string {
  return new Date(nowMs).toISOString().split('T')[0];
}

/** Der späteste Tag, den ein Datumsfeld anbietet (`max`). */
export function latestBusinessDate(nowMs: number = Date.now()): string {
  return todayIso(nowMs + TAG);
}

/** `null` = in Ordnung (leer heißt „heute"); sonst der Satz für den Menschen. */
export function businessDateIssue(value: unknown, label: string, nowMs: number = Date.now()): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return `${label} is not a valid date`;
  const t = Date.parse(value + 'T00:00:00.000Z');
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== value) return `${label} is not a valid date`;
  if (t > nowMs + TAG) return `${label} cannot be in the future`;
  return null;
}

/** Ein gültiger, nicht künftiger Tag im Format JJJJ-MM-TT (nichts anderes — z. B. kein Zeitstempel). */
export function isBusinessDate(value: unknown, nowMs: number = Date.now()): value is string {
  return typeof value === 'string' && value.length === 10 && businessDateIssue(value, 'date', nowMs) === null;
}

/**
 * Für Spalten, die einen Zeitpunkt tragen (`received_at`, `transferred_at`): heute → der Zeitpunkt
 * jetzt (wie bisher); ein anderer Tag → dieser Tag zur Mittagszeit (kein Verrutschen über Zeitzonen).
 */
export function businessTimestamp(date: string | undefined | null, nowIso: string): string {
  if (!date || date === nowIso.split('T')[0]) return nowIso;
  return `${date}T12:00:00.000Z`;
}
