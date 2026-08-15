// ════════════════════════════════════════════════════════════════════════════
// INVENTORY-SESSION — the WORKING STATE of a stock-check run, so an inventory can be interrupted.
//
// The stock-check history (`stock_checks`, written through `/api/stock-checks`) is append-only and
// says what was OBSERVED. It deliberately answers "was this item seen on 15 August", never "am I
// still working through the shelf". Those are different questions, and the second one is why an
// operator who saved yesterday came back today to three empty columns.
//
// So the run gets its own state, next to the history and never instead of it:
//
//   • one OPEN session per branch — the inventory currently being worked through,
//   • one row per already-decided product, holding the column it sits in and its note,
//   • it survives Save, closing the window, and restarting the app: reopening restores exactly the
//     three columns as they were,
//   • only an explicit finish clears it. Nothing expires on its own, and no date rolls it over.
//
// Closing a session does NOT touch a single history row — the observations stay, the worksheet is
// what gets put away.
// ════════════════════════════════════════════════════════════════════════════

/** Table DDL — applied idempotently by the normal schema pass, like every other table. */
export const INVENTORY_SESSION_DDL = `CREATE TABLE IF NOT EXISTS inventory_sessions (
  session_id TEXT PRIMARY KEY,
  branch_id  TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open',
  started_at TEXT NOT NULL,
  closed_at  TEXT,
  updated_at TEXT NOT NULL
)`;

export const INVENTORY_SESSION_ITEMS_DDL = `CREATE TABLE IF NOT EXISTS inventory_session_items (
  session_id       TEXT NOT NULL,
  product_id       TEXT NOT NULL,
  status           TEXT NOT NULL,
  notes            TEXT,
  updated_at       TEXT NOT NULL,
  applied_check_id TEXT,
  PRIMARY KEY (session_id, product_id)
)`;

/**
 * `to_check` is a real, stored state, not the absence of one.
 *
 * An item the operator deliberately put BACK is different from an item nobody has touched: the
 * first carries a decision ("I looked at this and I am not calling it yet") with a time on it, and
 * that time is what stops an older phone check from quietly filling the card back in. Without the
 * row there is nothing to compare an incoming observation against.
 */
/**
 * BOOTSTRAP CUTOFF — the line under everything that existed before this feature did.
 *
 * An install that has been checking stock for months already carries a history. Without a floor,
 * the first inventory ever opened would treat all of it as the current working state and hand the
 * operator a hundred pre-filled cards to un-tick — the exact opposite of walking the shelf.
 *
 * So the first boot that reaches this schema pass writes the moment it happened, once, and never
 * again: `INSERT OR IGNORE` on a table that can only ever hold one row. Everything recorded before
 * that instant is history and nothing else; everything after it can belong to a run. It is written
 * here rather than derived later because it has to be fixed BEFORE the phone starts recording — a
 * value computed at the first open would be set after those checks and would exclude them, which is
 * precisely the workflow this whole feature exists to support.
 */
export const INVENTORY_BOOTSTRAP_DDL = `CREATE TABLE IF NOT EXISTS inventory_bootstrap (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  at TEXT NOT NULL
)`;
/** Written once, with the same ISO-8601 shape the sessions use so the two are directly comparable. */
export const INVENTORY_BOOTSTRAP_SEED =
  `INSERT OR IGNORE INTO inventory_bootstrap (id, at) VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

export type SessionItemStatus = 'available' | 'not_available' | 'to_check';
export const DECIDED: readonly SessionItemStatus[] = ['available', 'not_available'];
export const isDecided = (s: SessionItemStatus): boolean => s !== 'to_check';

export interface SessionItem {
  productId: string;
  status: SessionItemStatus;
  notes: string;
  /** When this row last changed — the session's side of the merge comparison. */
  updatedAt?: string;
  /** The observation this row already accounts for. Folding it in twice is then impossible. */
  appliedCheckId?: string | null;
}

export interface OpenSession {
  sessionId: string;
  startedAt: string;
  items: SessionItem[];
}

/** The narrow database surface this needs — the real sql.js handle satisfies it. */
export interface InventorySessionDb {
  run(sql: string, params?: unknown[]): unknown;
  exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
}

function rows(db: InventorySessionDb, sql: string, params: unknown[] = []): unknown[][] {
  try {
    const r = db.exec(sql, params);
    return r.length === 0 ? [] : r[0].values;
  } catch {
    return [];
  }
}

const isStatus = (v: unknown): v is SessionItemStatus =>
  v === 'available' || v === 'not_available' || v === 'to_check';

/**
 * The branch's open session, or null when none is running.
 *
 * Items whose product no longer exists are dropped on the way out: a run started before an item was
 * sold must not resurrect it as a column entry, and must not crash the view either.
 */
export function loadOpenSession(db: InventorySessionDb, branchId: string): OpenSession | null {
  const head = rows(
    db,
    `SELECT session_id, started_at FROM inventory_sessions
      WHERE branch_id = ? AND status = 'open'
      ORDER BY started_at DESC LIMIT 1`,
    [branchId],
  );
  if (head.length === 0) return null;
  const sessionId = String(head[0][0]);
  const startedAt = String(head[0][1]);
  const items: SessionItem[] = [];
  for (const r of rows(
    db,
    `SELECT i.product_id, i.status, i.notes, i.updated_at, i.applied_check_id
       FROM inventory_session_items i
       JOIN products p ON p.id = i.product_id
      WHERE i.session_id = ?`,
    [sessionId],
  )) {
    if (!isStatus(r[1])) continue;
    items.push({
      productId: String(r[0]),
      status: r[1],
      notes: r[2] == null ? '' : String(r[2]),
      updatedAt: r[3] == null ? undefined : String(r[3]),
      appliedCheckId: r[4] == null ? null : String(r[4]),
    });
  }
  return { sessionId, startedAt, items };
}

/**
 * When this branch last finished an inventory, or null if it never has.
 *
 * Everything at or before that moment was walked in a run that has been put away, so it is history
 * and nothing else. It is the only thing standing between "pick up what the phone did" and "import
 * every verdict ever recorded", which is why a finish writes it and nothing else clears it.
 */
export function lastFinishedAt(db: InventorySessionDb, branchId: string): string | null {
  const r = rows(
    db,
    `SELECT closed_at FROM inventory_sessions
      WHERE branch_id = ? AND status = 'closed' AND closed_at IS NOT NULL
      ORDER BY closed_at DESC LIMIT 1`,
    [branchId],
  );
  return r.length === 0 ? null : String(r[0][0]);
}

/** The bootstrap instant, or null on a database old enough not to have one. */
export function bootstrapAt(db: InventorySessionDb): string | null {
  const r = rows(db, `SELECT at FROM inventory_bootstrap WHERE id = 1`);
  return r.length === 0 ? null : String(r[0][0]);
}

/**
 * The line an opening run may not reach under: the later of "when this install first knew about
 * inventories" and "when this branch last finished one".
 *
 * Two different jobs, one answer. The bootstrap keeps a pre-existing history out of the very first
 * run; the finished-run line keeps each later run out of the one before it. Whichever is later wins,
 * because a check has to clear both to belong to what is opening now.
 */
export function runFloor(lastFinished: string | null, bootstrap: string | null): string | null {
  if (!lastFinished) return bootstrap;
  if (!bootstrap) return lastFinished;
  return isAfter(lastFinished, bootstrap) ? lastFinished : bootstrap;
}

/**
 * When a run that nobody has opened yet should be considered to have STARTED.
 *
 * The workflow this exists for is "walk the shelf with the phone, sit down at the desktop
 * afterwards". Starting the run at the moment the dialog opens would put every one of those checks
 * before the boundary and show the operator a hundred untouched cards — the observations happened,
 * and the run they belong to is the one about to be opened.
 *
 * So the earliest observation that no finished run has accounted for is what opens it. Returns null
 * when there is nothing to pick up, and the caller starts the run at the present moment instead.
 */
export function startForNewRun(
  checks: readonly ExternalCheck[],
  floor: string | null,
): string | null {
  let earliest: string | null = null;
  for (const c of checks) {
    if (floor && !isAfter(c.checked_at, floor)) continue;
    if (earliest === null || isAfter(earliest, c.checked_at)) earliest = c.checked_at;
  }
  return earliest;
}

/** The open session for this branch, creating one when the operator decides their first item. */
export function ensureOpenSession(
  db: InventorySessionDb,
  branchId: string,
  nowIso: string,
  newId: () => string,
): string {
  const existing = rows(
    db,
    `SELECT session_id FROM inventory_sessions WHERE branch_id = ? AND status = 'open' ORDER BY started_at DESC LIMIT 1`,
    [branchId],
  );
  if (existing.length > 0) return String(existing[0][0]);
  const id = newId();
  db.run(
    `INSERT INTO inventory_sessions (session_id, branch_id, status, started_at, closed_at, updated_at)
     VALUES (?, ?, 'open', ?, NULL, ?)`,
    [id, branchId, nowIso, nowIso],
  );
  return id;
}

/**
 * Write the worksheet as it currently stands.
 *
 * `items` is the COMPLETE set of decided products for this session, so a product the operator moved
 * back to "To check" disappears here too — the worksheet mirrors the screen. Products outside the
 * caller's current filter are NOT part of `items` and must survive, which is why `keepProductIds`
 * exists: only rows the caller could actually see are eligible for removal.
 */
export function persistSessionItems(
  db: InventorySessionDb,
  sessionId: string,
  items: SessionItem[],
  visibleProductIds: string[],
  nowIso: string,
): void {
  // An item the operator took back is RECORDED as `to_check`, not deleted. Deleting it would make
  // it indistinguishable from an item nobody has touched, and the next merge would hand it straight
  // back from the phone check it was taken back from.
  const decided = new Set(items.map(i => i.productId));
  for (const id of visibleProductIds) {
    if (!decided.has(id)) {
      db.run(
        `INSERT INTO inventory_session_items (session_id, product_id, status, notes, updated_at, applied_check_id)
         VALUES (?, ?, 'to_check', NULL, ?, NULL)
         ON CONFLICT(session_id, product_id) DO UPDATE SET
           status = 'to_check', notes = NULL, updated_at = excluded.updated_at, applied_check_id = NULL`,
        [sessionId, id, nowIso],
      );
    }
  }
  for (const it of items) {
    db.run(
      `INSERT INTO inventory_session_items (session_id, product_id, status, notes, updated_at, applied_check_id)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, product_id) DO UPDATE SET
         status = excluded.status, notes = excluded.notes, updated_at = excluded.updated_at,
         applied_check_id = excluded.applied_check_id`,
      [sessionId, it.productId, it.status, it.notes || null, nowIso, it.appliedCheckId ?? null],
    );
  }
  db.run(`UPDATE inventory_sessions SET updated_at = ? WHERE session_id = ?`, [nowIso, sessionId]);
}

/**
 * Put the worksheet away. The session is marked closed and its item rows are dropped; the next open
 * therefore starts on a clean sheet. History rows are untouched — this removes the run, not the
 * record of what was seen.
 */
export function closeSession(db: InventorySessionDb, sessionId: string, nowIso: string): void {
  db.run(`DELETE FROM inventory_session_items WHERE session_id = ?`, [sessionId]);
  db.run(
    `UPDATE inventory_sessions SET status = 'closed', closed_at = ?, updated_at = ? WHERE session_id = ?`,
    [nowIso, nowIso, sessionId],
  );
}

/**
 * What still has to be written to the history.
 *
 * A second Save with nothing changed must write nothing, and re-deciding an item after it was saved
 * MUST write again — the history is append-only, so a corrected verdict is a new observation, not an
 * edit. Comparing the decision against what the worksheet last recorded gives both.
 */
/** The shape the merge needs from a stock check — the real `StockCheck` satisfies it. */
export interface ExternalCheck {
  check_id: string;
  product_id: string;
  status: 'available' | 'not_available';
  notes: string | null;
  checked_at: string;
}

export interface MergeResult {
  items: SessionItem[];
  /** Products whose working state the merge changed — empty means there is nothing to write. */
  changed: string[];
}

/**
 * Fold observations made elsewhere into the worksheet of the RUN that is currently open.
 *
 * A check made on the phone is an observation of the same shelf the desktop is walking, so it
 * belongs in the same three columns. Three rules keep that from becoming a mess:
 *
 *   • only checks from INSIDE this run count. `startedAt` is the boundary, which is what makes a
 *     new inventory start empty instead of inheriting every verdict ever recorded — the history is
 *     history, not a starting position.
 *   • an observation is folded in ONCE. `appliedCheckId` decides that by identity, not by clock,
 *     so a second open cannot resurrect a card the operator has since taken back, and two events
 *     sharing a timestamp cannot confuse it.
 *   • between two genuinely different observations the newer one wins. `>=` on the timestamp is
 *     deliberate: with the identity guard above already preventing repeats, the tie is better spent
 *     on the incoming observation than on dropping it.
 *
 * Nothing here writes history. It reads what was observed and decides what the worksheet shows.
 */
/**
 * Order two instants that were written by different machines in different formats.
 *
 * The session stamps `new Date().toISOString()` (…`Z`, milliseconds); the server stamps RFC3339
 * (…`+00:00`, nanoseconds). Those two sort differently as text — `+` sorts below `Z` — so comparing
 * the strings would silently drop every observation that shares a second with the session it belongs
 * to. Parsing gives a real order; the string comparison is only the fallback for a value that is not
 * a date at all.
 */
export function isAfter(a: string, b: string): boolean {
  const ta = Date.parse(a), tb = Date.parse(b);
  if (Number.isFinite(ta) && Number.isFinite(tb)) return ta > tb;
  return a > b;
}

export function atOrAfter(a: string, b: string): boolean {
  const ta = Date.parse(a), tb = Date.parse(b);
  if (Number.isFinite(ta) && Number.isFinite(tb)) return ta >= tb;
  return a >= b;
}

export function mergeExternalChecks(
  items: readonly SessionItem[],
  checks: readonly ExternalCheck[],
  startedAt: string,
): MergeResult {
  const by = new Map(items.map(i => [i.productId, i]));
  const changed: string[] = [];

  for (const c of checks) {
    // Before this run began → history, not working state.
    if (!atOrAfter(c.checked_at, startedAt)) continue;
    const cur = by.get(c.product_id);
    if (cur && cur.appliedCheckId === c.check_id) continue;          // already accounted for
    if (cur && cur.updatedAt && !atOrAfter(c.checked_at, cur.updatedAt)) continue;  // the session is newer
    const notes = c.notes == null ? '' : c.notes;
    if (cur && cur.status === c.status && cur.notes === notes && cur.appliedCheckId === c.check_id) continue;
    by.set(c.product_id, {
      productId: c.product_id,
      status: c.status,
      notes,
      updatedAt: c.checked_at,
      appliedCheckId: c.check_id,
    });
    changed.push(c.product_id);
  }
  return { items: [...by.values()], changed };
}

export function itemsNeedingHistory(draft: SessionItem[], persisted: SessionItem[]): SessionItem[] {
  const before = new Map(persisted.map(i => [i.productId, i]));
  return draft.filter(d => {
    const p = before.get(d.productId);
    return !p || p.status !== d.status || (p.notes || '') !== (d.notes || '');
  });
}
