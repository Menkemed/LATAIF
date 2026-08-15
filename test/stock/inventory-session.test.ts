// INVENTORY-SESSION — the worksheet of a stock-check run, against real SQLite.
//
// What matters is that an interrupted inventory comes back intact: same columns, same notes, days
// later, and that finishing it clears the run WITHOUT touching the observation history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  INVENTORY_SESSION_DDL, INVENTORY_SESSION_ITEMS_DDL,
  loadOpenSession, ensureOpenSession, persistSessionItems, closeSession, itemsNeedingHistory,
  type InventorySessionDb, type SessionItem,
} from '../../src/core/stock/inventory-session.ts';

/** The sql.js surface the core expects, backed by node:sqlite. */
function db(): InventorySessionDb & { close(): void } {
  const d = new DatabaseSync(':memory:');
  d.exec(`CREATE TABLE products (id TEXT PRIMARY KEY, sku TEXT)`);
  d.exec(INVENTORY_SESSION_DDL);
  d.exec(INVENTORY_SESSION_ITEMS_DDL);
  return {
    run: (sql, params = []) => d.prepare(sql).run(...(params as never[])),
    exec: (sql, params = []) => {
      const rows = d.prepare(sql).all(...(params as never[])) as Array<Record<string, unknown>>;
      if (rows.length === 0) return [];
      const columns = Object.keys(rows[0]);
      return [{ columns, values: rows.map(r => columns.map(c => r[c])) }];
    },
    close: () => d.close(),
  };
}
const product = (d: InventorySessionDb, id: string) => d.run(`INSERT INTO products (id, sku) VALUES (?, ?)`, [id, id]);
const ids = ['p1', 'p2', 'p3', 'p4'];
const seedProducts = (d: InventorySessionDb) => ids.forEach(i => product(d, i));
const item = (productId: string, status: SessionItem['status'], notes = ''): SessionItem => ({ productId, status, notes });

test('no session at the start — an untouched branch has an empty worksheet', () => {
  const d = db();
  try {
    assert.equal(loadOpenSession(d, 'branch-main'), null);
  } finally { d.close(); }
});

test('the worksheet survives being put down and picked up again', () => {
  const d = db();
  try {
    seedProducts(d);
    const sid = ensureOpenSession(d, 'branch-main', '2026-08-15T10:00:00Z', () => 'sess-1');
    persistSessionItems(d, sid, [item('p1', 'available', 'shop'), item('p2', 'not_available', 'sold??')], ids, '2026-08-15T10:05:00Z');

    // …days later, a fresh read: same columns, same notes
    const back = loadOpenSession(d, 'branch-main');
    assert.ok(back);
    assert.equal(back.sessionId, 'sess-1');
    const byId = new Map(back.items.map(i => [i.productId, i]));
    assert.equal(byId.get('p1')?.status, 'available');
    assert.equal(byId.get('p1')?.notes, 'shop');
    assert.equal(byId.get('p2')?.status, 'not_available');
    assert.equal(byId.get('p2')?.notes, 'sold??');
    assert.equal(back.items.length, 2, 'nothing else drifted in');
  } finally { d.close(); }
});

test('reopening returns the SAME session — a second open never starts a parallel run', () => {
  const d = db();
  try {
    const a = ensureOpenSession(d, 'branch-main', '2026-08-15T10:00:00Z', () => 'sess-1');
    const b = ensureOpenSession(d, 'branch-main', '2026-08-16T09:00:00Z', () => 'sess-2');
    assert.equal(a, b);
  } finally { d.close(); }
});

test('an item moved back to "To check" leaves the worksheet', () => {
  const d = db();
  try {
    seedProducts(d);
    const sid = ensureOpenSession(d, 'branch-main', '2026-08-15T10:00:00Z', () => 'sess-1');
    persistSessionItems(d, sid, [item('p1', 'available'), item('p2', 'available')], ids, '2026-08-15T10:05:00Z');
    persistSessionItems(d, sid, [item('p1', 'available')], ids, '2026-08-15T10:06:00Z');
    const back = loadOpenSession(d, 'branch-main');
    assert.deepEqual(back?.items.map(i => i.productId), ['p1']);
  } finally { d.close(); }
});

test('a decision outside the current filter is NOT wiped by a save', () => {
  const d = db();
  try {
    seedProducts(d);
    const sid = ensureOpenSession(d, 'branch-main', '2026-08-15T10:00:00Z', () => 'sess-1');
    persistSessionItems(d, sid, [item('p1', 'available'), item('p4', 'not_available')], ids, '2026-08-15T10:05:00Z');
    // the operator narrows the Collection to p1..p2 and saves again — p4 is off screen, not undone
    persistSessionItems(d, sid, [item('p1', 'not_available')], ['p1', 'p2'], '2026-08-15T11:00:00Z');
    const back = loadOpenSession(d, 'branch-main');
    const byId = new Map(back!.items.map(i => [i.productId, i]));
    assert.equal(byId.get('p1')?.status, 'not_available', 'the visible item was updated');
    assert.equal(byId.get('p4')?.status, 'not_available', 'the invisible one survived');
  } finally { d.close(); }
});

test('an item whose product is gone drops out instead of breaking the view', () => {
  const d = db();
  try {
    seedProducts(d);
    const sid = ensureOpenSession(d, 'branch-main', '2026-08-15T10:00:00Z', () => 'sess-1');
    persistSessionItems(d, sid, [item('p1', 'available'), item('p2', 'available')], ids, '2026-08-15T10:05:00Z');
    d.run(`DELETE FROM products WHERE id = ?`, ['p2']);
    const back = loadOpenSession(d, 'branch-main');
    assert.deepEqual(back?.items.map(i => i.productId), ['p1']);
  } finally { d.close(); }
});

test('finishing clears the run and the next open starts empty', () => {
  const d = db();
  try {
    seedProducts(d);
    const sid = ensureOpenSession(d, 'branch-main', '2026-08-15T10:00:00Z', () => 'sess-1');
    persistSessionItems(d, sid, [item('p1', 'available')], ids, '2026-08-15T10:05:00Z');
    closeSession(d, sid, '2026-08-15T12:00:00Z');
    assert.equal(loadOpenSession(d, 'branch-main'), null);
    // and a new run is a genuinely new session, not the closed one revived
    const next = ensureOpenSession(d, 'branch-main', '2026-08-16T08:00:00Z', () => 'sess-2');
    assert.equal(next, 'sess-2');
    assert.deepEqual(loadOpenSession(d, 'branch-main')?.items, []);
  } finally { d.close(); }
});

test('branches keep separate worksheets', () => {
  const d = db();
  try {
    seedProducts(d);
    const a = ensureOpenSession(d, 'branch-a', '2026-08-15T10:00:00Z', () => 'sess-a');
    ensureOpenSession(d, 'branch-b', '2026-08-15T10:00:00Z', () => 'sess-b');
    persistSessionItems(d, a, [item('p1', 'available')], ids, '2026-08-15T10:05:00Z');
    assert.equal(loadOpenSession(d, 'branch-a')?.items.length, 1);
    assert.equal(loadOpenSession(d, 'branch-b')?.items.length, 0);
  } finally { d.close(); }
});

// ── what still has to reach the history ──────────────────────────────────────
test('a second Save with nothing changed writes no history', () => {
  const saved = [item('p1', 'available', 'shop'), item('p2', 'not_available')];
  assert.deepEqual(itemsNeedingHistory(saved, saved), []);
});

test('a corrected verdict writes a NEW observation', () => {
  const before = [item('p1', 'available', 'shop')];
  const after = [item('p1', 'not_available', 'shop')];
  assert.deepEqual(itemsNeedingHistory(after, before).map(i => i.productId), ['p1']);
});

test('an edited note alone is enough to write again', () => {
  const before = [item('p1', 'available', 'shop')];
  const after = [item('p1', 'available', 'back office')];
  assert.deepEqual(itemsNeedingHistory(after, before).map(i => i.productId), ['p1']);
});

test('a newly decided item is written, the untouched ones are not', () => {
  const before = [item('p1', 'available')];
  const after = [item('p1', 'available'), item('p3', 'not_available')];
  assert.deepEqual(itemsNeedingHistory(after, before).map(i => i.productId), ['p3']);
});
