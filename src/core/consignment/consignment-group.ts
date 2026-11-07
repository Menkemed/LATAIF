// ════════════════════════════════════════════════════════════════════════════
// MIXED INVOICE P5 (E12, Owner D-P5-1..3) — Kommissionsgruppe aus Einzelstücken.
//
// Eine Aufnahme mit Menge N legt N Kommissionen an (je ein Artikel, je eine eigene SKU) mit gemeinsamer
// `groupId`, Stücknummer `groupSeq` 1..N und der ursprünglichen Menge `groupQuantity`. Gebucht wird IMMER je
// Stück: Verkauf (eine Rechnungszeile je Stück), Auszahlung, Retoure, Cancel Sale und P4-Korrektur bleiben die
// vorhandenen Einzelwege. Diese Datei rechnet nur die ANZEIGE der Gruppe und die Auswahl der k Stücke eines
// Teilverkaufs — sie bucht nichts und entscheidet keine Regel.
// ════════════════════════════════════════════════════════════════════════════

export interface GroupPieceLike {
  id: string;
  status: string;
  groupId?: string | null;
  groupSeq?: number | null;
  groupQuantity?: number | null;
  consignmentNumber?: string;
  invoiceId?: string | null;
}

export interface ConsignmentGroupSummary<T extends GroupPieceLike> {
  groupId: string;
  /** die ursprüngliche Menge der Aufnahme */
  quantity: number;
  /** die Stücke, nach Stücknummer */
  pieces: T[];
  /** noch verkaufbar (aktiv, ohne Rechnung) */
  available: number;
  sold: number;
  returned: number;
  /** Zähler je Status, für die Anzeige („3 active · 2 sold") */
  byStatus: Record<string, number>;
}

/** Ein Stück ist verkaufbar, wenn es aktiv ist und an keiner Rechnung hängt — dieselbe Regel wie die Auswahl heute. */
export function isAvailablePiece(c: GroupPieceLike): boolean {
  return c.status === 'active' && !c.invoiceId;
}

const VERKAUFT = new Set(['sold', 'paid_out']);

function nachStueck<T extends GroupPieceLike>(a: T, b: T): number {
  const sa = a.groupSeq ?? Number.MAX_SAFE_INTEGER;
  const sb = b.groupSeq ?? Number.MAX_SAFE_INTEGER;
  if (sa !== sb) return sa - sb;
  return String(a.consignmentNumber ?? '').localeCompare(String(b.consignmentNumber ?? ''));
}

/** Die Zusammenfassung einer Gruppe aus ihren Stücken (beliebige Reihenfolge). */
export function summarizeGroup<T extends GroupPieceLike>(pieces: readonly T[]): ConsignmentGroupSummary<T> | null {
  const mit = pieces.filter((p) => !!p.groupId);
  if (mit.length === 0) return null;
  const sortiert = [...mit].sort(nachStueck);
  const byStatus: Record<string, number> = {};
  for (const p of sortiert) byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
  const menge = Math.max(sortiert.length, ...sortiert.map((p) => Number(p.groupQuantity) || 0));
  return {
    groupId: String(sortiert[0].groupId),
    quantity: menge,
    pieces: sortiert,
    available: sortiert.filter(isAvailablePiece).length,
    sold: sortiert.filter((p) => VERKAUFT.has(p.status)).length,
    returned: sortiert.filter((p) => p.status === 'returned').length,
    byStatus,
  };
}

/** Alle Gruppen einer Liste, nach Kennung. Stücke ohne Gruppe fehlen (sie sind Einzelkommissionen). */
export function groupsOf<T extends GroupPieceLike>(list: readonly T[]): Map<string, ConsignmentGroupSummary<T>> {
  const roh = new Map<string, T[]>();
  for (const c of list) {
    if (!c.groupId) continue;
    const l = roh.get(c.groupId) ?? [];
    l.push(c);
    roh.set(c.groupId, l);
  }
  const out = new Map<string, ConsignmentGroupSummary<T>>();
  for (const [id, l] of roh) {
    const s = summarizeGroup(l);
    if (s) out.set(id, s);
  }
  return out;
}

/**
 * Die k Stücke eines Teilverkaufs: die verfügbaren mit der kleinsten Stücknummer, ohne die schon gewählten.
 * Weniger verfügbar als verlangt ⇒ nur so viele, wie es gibt (die Maske zeigt die Grenze vorher an).
 */
export function pickAvailablePieces<T extends GroupPieceLike>(
  pieces: readonly T[], k: number, exclude: ReadonlySet<string> = new Set(),
): T[] {
  if (!(k > 0)) return [];
  return [...pieces].filter((p) => isAvailablePiece(p) && !exclude.has(p.id)).sort(nachStueck).slice(0, Math.floor(k));
}

/**
 * Die Auswahl eines Verkaufs mit Mengenwahl je Gruppe. `baseIds` ist die Auswahl, mit der der Dialog geöffnet wurde;
 * `groupK` nennt je Gruppe die gewünschte Stückzahl (fehlt sie, bleibt die Auswahl dieser Gruppe wie geöffnet).
 * Die ausdrücklich gewählten Stücke kommen zuerst, dann die verfügbaren mit der kleinsten Nummer; die Reihenfolge der
 * Auswahl (= Reihenfolge der Rechnungszeilen) bleibt erhalten, neue Stücke folgen ihrer Gruppe.
 */
export function expandGroupSelection<T extends GroupPieceLike>(
  baseIds: readonly string[], all: readonly T[], groupK: Readonly<Record<string, number>>,
): string[] {
  const byId = new Map(all.map((c) => [c.id, c]));
  const out: string[] = [];
  const erledigt = new Set<string>();
  for (const id of baseIds) {
    const c = byId.get(id);
    const gid = c?.groupId ?? null;
    if (!c || !gid || groupK[gid] === undefined) {
      if (!out.includes(id)) out.push(id);
      continue;
    }
    if (erledigt.has(gid)) continue;
    erledigt.add(gid);
    const stuecke = all.filter((x) => x.groupId === gid);
    const gewaehlt = baseIds.map((i) => byId.get(i)).filter((x): x is T => !!x && x.groupId === gid).sort(nachStueck);
    const weitere = pickAvailablePieces(stuecke, stuecke.length, new Set(gewaehlt.map((x) => x.id)));
    const k = Math.max(1, Math.floor(groupK[gid]));
    for (const x of [...gewaehlt, ...weitere].slice(0, k)) if (!out.includes(x.id)) out.push(x.id);
  }
  return out;
}

/** Die kurze Zeile einer Gruppe: „Group of 5 · 3 available · 2 sold". */
export function groupStatusLine(s: Pick<ConsignmentGroupSummary<GroupPieceLike>, 'quantity' | 'available' | 'byStatus'>): string {
  const teile = [`Group of ${s.quantity}`, `${s.available} available`];
  for (const [st, n] of Object.entries(s.byStatus)) {
    if (st === 'active') continue;
    teile.push(`${n} ${st.replace('_', ' ')}`);
  }
  return teile.join(' · ');
}

/** „piece 2 of 5" — für ein Stück einer Gruppe; eine Einzelkommission bekommt nichts. */
export function pieceLabel(c: Pick<GroupPieceLike, 'groupId' | 'groupSeq' | 'groupQuantity'>): string {
  if (!c.groupId) return '';
  return `piece ${c.groupSeq ?? '?'} of ${c.groupQuantity ?? '?'}`;
}
