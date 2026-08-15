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
  session_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  status     TEXT NOT NULL,
  notes      TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, product_id)
)`;

export type SessionItemStatus = 'available' | 'not_available';

export interface SessionItem {
  productId: string;
  status: SessionItemStatus;
  notes: string;
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

const isStatus = (v: unknown): v is SessionItemStatus => v === 'available' || v === 'not_available';

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
    `SELECT i.product_id, i.status, i.notes
       FROM inventory_session_items i
       JOIN products p ON p.id = i.product_id
      WHERE i.session_id = ?`,
    [sessionId],
  )) {
    if (!isStatus(r[1])) continue;
    items.push({ productId: String(r[0]), status: r[1], notes: r[2] == null ? '' : String(r[2]) });
  }
  return { sessionId, startedAt, items };
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
  const decided = new Set(items.map(i => i.productId));
  for (const id of visibleProductIds) {
    if (!decided.has(id)) {
      db.run(`DELETE FROM inventory_session_items WHERE session_id = ? AND product_id = ?`, [sessionId, id]);
    }
  }
  for (const it of items) {
    db.run(
      `INSERT INTO inventory_session_items (session_id, product_id, status, notes, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id, product_id) DO UPDATE SET
         status = excluded.status, notes = excluded.notes, updated_at = excluded.updated_at`,
      [sessionId, it.productId, it.status, it.notes || null, nowIso],
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
export function itemsNeedingHistory(draft: SessionItem[], persisted: SessionItem[]): SessionItem[] {
  const before = new Map(persisted.map(i => [i.productId, i]));
  return draft.filter(d => {
    const p = before.get(d.productId);
    return !p || p.status !== d.status || (p.notes || '') !== (d.notes || '');
  });
}
