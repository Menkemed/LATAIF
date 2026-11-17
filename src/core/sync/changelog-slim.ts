// ════════════════════════════════════════════════════════════════════════════
// A2-STUFE-1 — historische Changelog-Einträge verschlanken: NUR `image_embedding` aus Artikel-Payloads.
// Reine Funktionen (kein DB-Zugriff) — genutzt vom Offline-Wartungswerkzeug
// `scripts/maint/changelog-schlankung.mjs` und von den Tests.
//
// Warum genau so:
//   • Eine Funktion für BEIDE Datenbanken (Primary `lataif.db`, Server `lataif_sync_server.db`): aus gleichen
//     Bytes werden gleiche Bytes. Der Cursor-Neuaufbau (`cursor-store.provenOwnPrefix`) vergleicht die Daten der
//     eigenen Einträge Zeichen für Zeichen mit dem Server — nach der Wartung müssen sie weiter gleich sein.
//   • Idempotent: f(f(x)) = f(x). Ein Abbruch zwischen beiden Datenbanken ist darum kein Zwischenzustand, der
//     verloren geht: der nächste Lauf rechnet für jede Seite dasselbe Ziel und erledigt nur, was noch fehlt.
//   • Byte-treu: nur, wenn `JSON.stringify(JSON.parse(data)) === data` (so schreibt die App jeden Eintrag) —
//     dann ist „ohne Schlüssel neu serialisiert" exakt „derselbe Text ohne dieses eine Feld". Jede andere Zeile
//     wird NICHT angefasst, sondern gemeldet (der Lauf bricht dann vor jedem Schreiben ab).
//   • Zeile, Nummer (id), Reihenfolge, Tabelle, Datensatz, Aktion und jedes andere Feld bleiben.
// ════════════════════════════════════════════════════════════════════════════

export const SLIM_TABLE = 'products';
export const SLIM_KEY = 'image_embedding';

export type SlimOutcome =
  | { kind: 'unchanged' }
  | { kind: 'slimmed'; data: string }
  | { kind: 'refused'; reason: 'not-json' | 'not-object' | 'not-byte-stable' };

/** Die Verschlankung EINES Eintrags. */
export function slimChangelogData(table: string, data: string): SlimOutcome {
  if (table !== SLIM_TABLE) return { kind: 'unchanged' };
  let o: unknown;
  try { o = JSON.parse(data); } catch { return { kind: 'refused', reason: 'not-json' }; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { kind: 'refused', reason: 'not-object' };
  if (!Object.prototype.hasOwnProperty.call(o, SLIM_KEY)) return { kind: 'unchanged' };
  if (JSON.stringify(o) !== data) return { kind: 'refused', reason: 'not-byte-stable' };
  const rest = { ...(o as Record<string, unknown>) };
  delete rest[SLIM_KEY];
  return { kind: 'slimmed', data: JSON.stringify(rest) };
}

/** Die Zielform eines Eintrags (verschlankt, sonst unverändert; abgelehnte bleiben, wie sie sind). */
export function slimForm(table: string, data: string): string {
  const r = slimChangelogData(table, data);
  return r.kind === 'slimmed' ? r.data : data;
}

export interface ChangelogRow { id: number; table_name: string; record_id: string; action: string; data: string; synced?: number | null }

export interface SidePlan {
  changes: Array<{ id: number; from: string; to: string }>;
  refused: Array<{ id: number; reason: string }>;
  rows: number;
  bytesBefore: number;
  bytesAfter: number;
}

/** Was auf EINER Seite zu tun ist. */
export function planSide(rows: readonly ChangelogRow[]): SidePlan {
  const out: SidePlan = { changes: [], refused: [], rows: rows.length, bytesBefore: 0, bytesAfter: 0 };
  for (const r of rows) {
    const s = slimChangelogData(r.table_name, r.data);
    out.bytesBefore += r.data.length;
    if (s.kind === 'slimmed') { out.changes.push({ id: r.id, from: r.data, to: s.data }); out.bytesAfter += s.data.length; }
    else { out.bytesAfter += r.data.length; if (s.kind === 'refused') out.refused.push({ id: r.id, reason: s.reason }); }
  }
  return out;
}

const keyOf = (r: ChangelogRow, form: (t: string, d: string) => string): string =>
  [r.table_name, r.record_id, r.action, form(r.table_name, r.data)].join('\u0000');

export interface Reconciliation {
  /** keine ungesendeten eigenen Einträge (Abbruchgrund). Nur-Primary-Einträge stehen getrennt in `primaryOnly`. */
  ok: boolean;
  problems: string[];
  /** eigene Einträge (Primary), die auf dem Server ihr Gegenstück haben */
  paired: number;
  /** Einträge, die nur der Server hat (Handy, andere Quelle) — erlaubt */
  serverOnly: number;
  /** gesendete eigene Einträge OHNE Gegenstück auf dem Server — schon bestehende Abweichung; der Aufrufer
   *  entscheidet (das Wartungswerkzeug verlangt dafür eine ausdrückliche Bestätigung genau dieser Nummern). */
  primaryOnly: Array<{ id: number; table: string; action: string }>;
}

/**
 * Passen Primary und Server zusammen? Verglichen wird die ZIELFORM (`slimForm`), damit ein Lauf, der nach
 * einem Abbruch eine Seite schon verschlankt vorfindet, dieselben Paare erkennt. Jeder eigene, gesendete
 * Eintrag des Primary braucht ein Gegenstück (gleiche Tabelle, Datensatz, Aktion, Daten) auf dem Server —
 * gezählt, nicht nur „gibt es". Ein ungesendeter eigener Eintrag (`synced` ≠ 1) ist ein Abbruchgrund.
 */
export function reconcileSides(primary: readonly ChangelogRow[], server: readonly ChangelogRow[]): Reconciliation {
  const problems: string[] = [];
  const left = new Map<string, number>();
  for (const s of server) { const k = keyOf(s, slimForm); left.set(k, (left.get(k) ?? 0) + 1); }
  let paired = 0;
  const primaryOnly: Reconciliation['primaryOnly'] = [];
  for (const p of primary) {
    if (p.synced !== undefined && p.synced !== null && Number(p.synced) !== 1) { problems.push(`primary #${p.id}: not yet sent (synced=${p.synced})`); continue; }
    const k = keyOf(p, slimForm);
    const n = left.get(k) ?? 0;
    if (n <= 0) { primaryOnly.push({ id: p.id, table: p.table_name, action: p.action }); continue; }
    left.set(k, n - 1);
    paired++;
  }
  let serverOnly = 0;
  for (const n of left.values()) serverOnly += n;
  return { ok: problems.length === 0, problems: problems.slice(0, 20), paired, serverOnly, primaryOnly };
}

/** Ist die Zeile auf dieser Seite schon in Zielform? (für den Wiederanlauf) */
export function isSlimmed(r: ChangelogRow): boolean {
  return slimForm(r.table_name, r.data) === r.data;
}
