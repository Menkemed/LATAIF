// ════════════════════════════════════════════════════════════════════════════
// LIST NAVIGATION UX (v0.8.98) — der Zustand einer Listenseite je Verlaufsschritt.
//
// Wer eine Liste verlässt (Eintrag öffnen), hinterlässt hier Suche, Filter, Sortierung und Scroll-Position — unter
// der Kennung genau DIESES Verlaufsschritts (Pfad + `location.key` des Routers). Zurück per „Back" (POP) findet die
// Liste ihn wieder; jede normale Navigation (Seitenleiste, Link, neuer Schritt) hat einen neuen Schlüssel und
// beginnt frisch. Nur im Arbeitsspeicher: nach einem Neustart der App ist alles leer. Keine Geschäftsdaten, keine
// Datenbank, kein Sync — Primary und PC2 verhalten sich gleich.
// ════════════════════════════════════════════════════════════════════════════

export interface ListNavSnapshot {
  /** Die gemerkten Werte der Seite (Suche, Filter, Sortierung, Ansicht) je Feldname. */
  values: Record<string, unknown>;
  /** Scroll-Position des Seiteninhalts in Pixeln. */
  scrollTop?: number;
}

/** Höchstens so viele Verlaufsschritte bleiben gemerkt (die ältesten fallen heraus). */
export const LIST_NAV_MAX_ENTRIES = 80;

const memory = new Map<string, ListNavSnapshot>();

/** Die Kennung eines Verlaufsschritts einer Seite. */
export function listNavId(pathname: string, key: string): string {
  return `${pathname}#${key}`;
}

/** Einen Teil des Zustands merken (zusammengeführt mit dem, was für diesen Schritt schon da ist). */
export function rememberListNav(id: string, patch: { values?: Record<string, unknown>; scrollTop?: number }): void {
  const before = memory.get(id);
  const next: ListNavSnapshot = {
    values: { ...(before?.values ?? {}), ...(patch.values ?? {}) },
    scrollTop: patch.scrollTop !== undefined ? patch.scrollTop : before?.scrollTop,
  };
  memory.delete(id);           // neu einreihen: zuletzt gemerkt = zuletzt entfernt
  memory.set(id, next);
  while (memory.size > LIST_NAV_MAX_ENTRIES) {
    const oldest = memory.keys().next().value;
    if (oldest === undefined) break;
    memory.delete(oldest);
  }
}

/** Was für diesen Schritt gemerkt ist (oder nichts). */
export function listNavSnapshot(id: string): ListNavSnapshot | undefined {
  return memory.get(id);
}

/** Ziel-Scrollposition auf das, was die Seite jetzt zulässt (0 … Inhalt − Fenster); nie negativ, nie über das Ende. */
export function clampScrollTop(target: number, scrollHeight: number, clientHeight: number): number {
  const max = Math.max(0, scrollHeight - clientHeight);
  if (!Number.isFinite(target) || target <= 0) return 0;
  return Math.min(target, max);
}

/** Nur für Tests: alles vergessen. */
export function resetListNavMemoryForTest(): void {
  memory.clear();
}
