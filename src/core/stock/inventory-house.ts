// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6C — die Inventur als EINE Hausfolge: für die Maske am Primary und für den
// Fernbefehl von PC2. Keine zweite Inventurlogik.
//
// Was eine Inventur in diesem Haus IST (auditiert, nicht angenommen):
//
//   • Ein Lauf je Filiale ist offen (`inventory_sessions`, Status 'open'). Er beginnt beim Öffnen der
//     Maske — bei der frühesten Beobachtung, die kein abgeschlossener Lauf erfasst hat, sonst jetzt.
//   • Gezählt wird nicht in Stück, sondern geurteilt: verfügbar / nicht verfügbar, mit Notiz. Ein
//     Urteil ist eine BEOBACHTUNG (`stock_checks`, anhängend, im Kern des Primary) und steht
//     zusätzlich im Arbeitsblatt des Laufs (`inventory_session_items`).
//   • Es gibt KEINEN Sollbestand, keine Differenz, keine Bestandsbuchung, kein Hauptbuch. Das
//     Abschließen legt nur das Arbeitsblatt weg; der Verlauf bleibt unberührt.
//
// Deshalb gibt es auch nichts, was ein Client „autoritativ vorgeben" könnte: Beginn, Fassung,
// Zuordnung der Beobachtungen und Zeitstempel bestimmt diese Datei, und die Kennung einer
// Beobachtung vergibt der Kern.
//
// Die Reihenfolge beim Speichern ist der Vertrag gegen den halben Zustand:
//
//   1. prüfen (Lauf offen, Fassung stimmt, Artikel in dieser Filiale und im Lauf, Urteil gültig);
//   2. die Beobachtungen schreiben — jede mit einer Anfragekennung, die der Kern wiedererkennt
//      (dieselbe Kennung → dieselbe Zeile, nie eine zweite);
//   3. ERST wenn alle stehen: das Arbeitsblatt in EINER Transaktion, Fassung hoch.
//
// Scheitert 2, bleibt das Arbeitsblatt, wie es war; die schon geschriebenen Beobachtungen sind echte
// Beobachtungen und werden bei der Wiederholung (gleiche Kennungen) nur wiedergefunden.
// ════════════════════════════════════════════════════════════════════════════
import {
  bootstrapAt, bumpSessionRevision, closeSession, ensureOpenSession, isDecided, itemsNeedingHistory,
  lastFinishedAt, loadOpenSession, mergeExternalChecks, persistSessionItems, runFloor, sessionRevision,
  startForNewRun, type InventorySessionDb, type SessionItem,
} from './inventory-session';
import {
  MAX_STOCK_CHECK_NOTES, isStockCheckStatus, type StockCheck, type StockCheckStatus,
} from './stock-check';

/** Ein fachliches Nein der Inventur — eingefroren, wenn es aus einem Fernauftrag kommt. */
export class InventoryRejected extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'InventoryRejected';
    this.code = code;
  }
}

/** Keine Antwort der Domäne: eine Beobachtung konnte nicht geschrieben werden. Wiederholbar. */
export class InventoryCheckFailed extends Error {
  readonly code = 'INVENTORY_CHECK_NOT_RECORDED';
  readonly failed: string[];
  constructor(failed: string[], cause: string) {
    super(`${failed.length} check${failed.length === 1 ? '' : 's'} could not be recorded (${cause})`);
    this.name = 'InventoryCheckFailed';
    this.failed = failed;
  }
}

export const INVENTORY_SESSION_NOT_OPEN = 'INVENTORY_SESSION_NOT_OPEN';
export const INVENTORY_SESSION_STALE = 'INVENTORY_SESSION_STALE';
export const INVENTORY_PRODUCT_NOT_IN_BRANCH = 'INVENTORY_PRODUCT_NOT_IN_BRANCH';
export const INVENTORY_PRODUCT_OUTSIDE_RUN = 'INVENTORY_PRODUCT_OUTSIDE_RUN';
export const INVENTORY_VERDICT_INVALID = 'INVENTORY_VERDICT_INVALID';
export const INVENTORY_NOTE_TOO_LONG = 'INVENTORY_NOTE_TOO_LONG';

/** Wie das Haus Beobachtungen liest und schreibt — der Kern des Primary (Tauri) oder im Test ein Ersatz. */
export interface InventoryCore {
  latest(productIds: readonly string[]): Promise<Record<string, StockCheck>>;
  record(p: { productId: string; status: StockCheckStatus; notes: string | null; userId?: string; requestId: string }): Promise<StockCheck>;
}

/** Die Transaktionsklammer: am Primary eine eigene, im Fernauftrag die des Auftrags (schon offen). */
export interface InventoryTx {
  run<T>(fn: () => T): T;
}

/** Im Fernauftrag ist die Transaktion bereits offen — die Klammer fügt nichts hinzu. */
export const INSIDE_COMMAND: InventoryTx = { run: (fn) => fn() };

export interface InventorySheet {
  sessionId: string | null;
  startedAt: string;
  revision: number;
  items: SessionItem[];
}

export interface VerdictInput {
  productId: string;
  status: StockCheckStatus;
  notes: string;
}

function ids(list: readonly string[]): string[] {
  return [...new Set(list)];
}

/** Welche der genannten Artikel zu DIESER Filiale gehören. Nur lesend. */
export function productsOfBranch(db: InventorySessionDb, branchId: string, wanted: readonly string[]): Set<string> {
  const found = new Set<string>();
  for (let i = 0; i < wanted.length; i += 400) {
    const chunk = wanted.slice(i, i + 400);
    const r = db.exec(`SELECT id FROM products WHERE branch_id = ? AND id IN (${chunk.map(() => '?').join(',')})`, [branchId, ...chunk]);
    for (const row of r[0]?.values ?? []) found.add(String(row[0]));
  }
  return found;
}

/**
 * Jeder genannte Artikel gehört zu DIESER Filiale — sonst ein Nein, bevor irgendetwas geschrieben wird.
 * Keine Höchstzahl: eine Inventur umfasst alle Artikel der Filiale, gelesen wird in Blöcken.
 */
export function assertProductsInBranch(db: InventorySessionDb, branchId: string, wanted: readonly string[]): void {
  const found = productsOfBranch(db, branchId, wanted);
  const missing = wanted.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new InventoryRejected(INVENTORY_PRODUCT_NOT_IN_BRANCH, `not an item of this branch: ${missing.slice(0, 3).join(', ')}`);
  }
}

/** Ein Urteil in seiner gültigen Form: nur die zwei Werte, Notiz getrimmt und begrenzt. */
export function normaliseVerdict(v: VerdictInput): VerdictInput {
  if (!isStockCheckStatus(v.status)) throw new InventoryRejected(INVENTORY_VERDICT_INVALID, 'a verdict is available or not_available');
  const notes = typeof v.notes === 'string' ? v.notes.trim() : '';
  if ([...notes].length > MAX_STOCK_CHECK_NOTES) {
    throw new InventoryRejected(INVENTORY_NOTE_TOO_LONG, `a note is longer than ${MAX_STOCK_CHECK_NOTES} characters`);
  }
  return { productId: v.productId, status: v.status, notes };
}

/** Das Arbeitsblatt, wie es in der Datenbank steht — ohne Lauf: `sessionId: null`. */
export function readSheet(db: InventorySessionDb, branchId: string): InventorySheet {
  const s = loadOpenSession(db, branchId);
  if (!s) return { sessionId: null, startedAt: '', revision: 0, items: [] };
  return { sessionId: s.sessionId, startedAt: s.startedAt, revision: s.revision, items: s.items };
}

function assertOpenAt(db: InventorySessionDb, branchId: string, sessionId: string, expectedRevision: number): void {
  const s = loadOpenSession(db, branchId);
  if (!s || s.sessionId !== sessionId) {
    throw new InventoryRejected(INVENTORY_SESSION_NOT_OPEN, 'this inventory is not open (any more) — reopen it');
  }
  const now = sessionRevision(db, sessionId);
  if (now !== expectedRevision) {
    throw new InventoryRejected(INVENTORY_SESSION_STALE,
      `this inventory was changed elsewhere since you opened it (you saw ${expectedRevision}, it is now ${now}) — reopen it`);
  }
}

// ── Lauf beginnen ──────────────────────────────────────────────────────────

export interface StartRequest { branchId: string; productIds: readonly string[]; now: string; newId: () => string }
export interface StartResult { sheet: InventorySheet; latest: Record<string, StockCheck>; foldedIn: number; created: boolean }

/**
 * Das Öffnen der Maske BEGINNT eine Inventur (oder nimmt die offene auf) und legt Beobachtungen, die
 * während des Laufs anderswo gemacht wurden (Telefon), in das Arbeitsblatt — genau einmal je
 * Beobachtung. Dieselbe Regel wie bisher an der Maske des Primary, jetzt an EINER Stelle.
 */
export async function startInventory(db: InventorySessionDb, core: InventoryCore, tx: InventoryTx, req: StartRequest): Promise<StartResult> {
  const wanted = ids(req.productIds);
  assertProductsInBranch(db, req.branchId, wanted);
  // Lesen VOR jeder Wirkung: wo ein neuer Lauf beginnt, hängt davon ab, was schon beobachtet wurde.
  const latest = wanted.length ? await core.latest(wanted) : {};
  const external = Object.values(latest);
  return tx.run(() => {
    let s = loadOpenSession(db, req.branchId);
    let created = false;
    if (!s) {
      const floor = runFloor(lastFinishedAt(db, req.branchId), bootstrapAt(db));
      const begin = startForNewRun(external, floor) ?? req.now;
      const sid = ensureOpenSession(db, req.branchId, begin, req.newId);
      created = true;
      s = { sessionId: sid, startedAt: begin, revision: sessionRevision(db, sid), items: [] };
    }
    const merged = mergeExternalChecks(s.items, external, s.startedAt);
    if (merged.changed.length > 0) {
      persistSessionItems(db, s.sessionId, merged.items.filter((i) => isDecided(i.status)), [], req.now);
      bumpSessionRevision(db, s.sessionId);
    }
    return { sheet: readSheet(db, req.branchId), latest, foldedIn: merged.changed.length, created };
  });
}

// ── Arbeitsblatt speichern ─────────────────────────────────────────────────

export interface SaveRequest {
  branchId: string;
  sessionId: string;
  expectedRevision: number;
  /** Das Arbeitsblatt, wie die Maske es zeigt: nur entschiedene Karten. */
  items: readonly VerdictInput[];
  /** Was die Maske zeigt — nur darunter darf eine Karte „zurück auf offen" gelegt werden. */
  visibleProductIds: readonly string[];
  userId?: string;
  /** Die Anfragekennung je Artikel: dieselbe bei jeder Wiederholung DIESES Speicherns. */
  requestIdFor: (productId: string) => string;
  now: string;
}

export interface SaveResult { sheet: InventorySheet; recorded: Record<string, string>; unchanged: boolean }

export async function saveInventory(db: InventorySessionDb, core: InventoryCore, tx: InventoryTx, req: SaveRequest): Promise<SaveResult> {
  const visible = ids(req.visibleProductIds);
  const visibleSet = new Set(visible);
  const seen = new Set<string>();
  const items = req.items.map((raw) => {
    const v = normaliseVerdict(raw);
    if (seen.has(v.productId)) throw new InventoryRejected(INVENTORY_VERDICT_INVALID, `one verdict per item (${v.productId})`);
    seen.add(v.productId);
    if (!visibleSet.has(v.productId)) {
      throw new InventoryRejected(INVENTORY_PRODUCT_OUTSIDE_RUN, `a verdict for an item that is not in this inventory: ${v.productId}`);
    }
    return v;
  });
  assertProductsInBranch(db, req.branchId, visible);
  assertOpenAt(db, req.branchId, req.sessionId, req.expectedRevision);

  const open = loadOpenSession(db, req.branchId)!;
  const persisted = open.items.filter((i) => isDecided(i.status));
  const before = new Map(persisted.map((i) => [i.productId, i]));
  const sheetItems: SessionItem[] = items.map((v) => ({ productId: v.productId, status: v.status, notes: v.notes }));
  const dirty = itemsNeedingHistory(sheetItems, persisted);
  const removed = persisted.filter((p) => !seen.has(p.productId) && visibleSet.has(p.productId));
  if (dirty.length === 0 && removed.length === 0) {
    return { sheet: readSheet(db, req.branchId), recorded: {}, unchanged: true };
  }

  // 2. Die Beobachtungen — jede mit ihrer wiedererkennbaren Anfragekennung.
  const recorded: Record<string, string> = {};
  const failed: string[] = [];
  let cause = '';
  for (const d of dirty) {
    try {
      const rec = await core.record({
        productId: d.productId,
        status: d.status as StockCheckStatus,
        notes: d.notes ? d.notes : null,
        userId: req.userId,
        requestId: req.requestIdFor(d.productId),
      });
      recorded[d.productId] = rec.check_id;
    } catch (e) {
      failed.push(d.productId);
      cause = e instanceof Error ? e.message : String(e);
    }
  }
  if (failed.length > 0) throw new InventoryCheckFailed(failed, cause);

  // 3. Erst jetzt das Arbeitsblatt — und die Fassung, gegen die geprüft wurde, noch einmal: am Primary
  //    kann zwischen den Beobachtungen ein anderer Auftrag gelaufen sein.
  return tx.run(() => {
    assertOpenAt(db, req.branchId, req.sessionId, req.expectedRevision);
    const keep: SessionItem[] = sheetItems.map((d) => ({
      ...d,
      appliedCheckId: recorded[d.productId] ?? before.get(d.productId)?.appliedCheckId ?? null,
    }));
    persistSessionItems(db, req.sessionId, keep, visible, req.now);
    bumpSessionRevision(db, req.sessionId);
    return { sheet: readSheet(db, req.branchId), recorded, unchanged: false };
  });
}

// ── Lauf abschließen ───────────────────────────────────────────────────────

export interface FinishRequest { branchId: string; sessionId: string; expectedRevision: number; now: string }

/** Legt das Arbeitsblatt weg. Kein Bestand, keine Buchung, der Verlauf bleibt — nur der Lauf endet. */
export function finishInventory(db: InventorySessionDb, tx: InventoryTx, req: FinishRequest): { finishedSessionId: string } {
  return tx.run(() => {
    assertOpenAt(db, req.branchId, req.sessionId, req.expectedRevision);
    closeSession(db, req.sessionId, req.now);
    bumpSessionRevision(db, req.sessionId);
    return { finishedSessionId: req.sessionId };
  });
}

// ── Einzel-Check am Artikel ────────────────────────────────────────────────

export interface SingleCheckRequest { branchId: string; productId: string; status: StockCheckStatus; notes: string; userId?: string; requestId: string }

/** Eine Beobachtung außerhalb eines Laufs (Artikelseite). Kein Arbeitsblatt, keine Bestandswirkung. */
export async function recordSingleCheck(db: InventorySessionDb, core: InventoryCore, req: SingleCheckRequest): Promise<StockCheck> {
  const v = normaliseVerdict({ productId: req.productId, status: req.status, notes: req.notes });
  assertProductsInBranch(db, req.branchId, [req.productId]);
  return core.record({ productId: v.productId, status: v.status, notes: v.notes || null, userId: req.userId, requestId: req.requestId });
}
