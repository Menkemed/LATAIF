// D4-B pure changelog logic test — replay / tombstone-wins / corrective baseline / compaction.
// Run: node test/d4/changelog-logic.test.ts
// Rein synthetische Change-Strukturen, KEINE echte SQLite-Datei. Stil test/d2 + test/d3.

import {
  replayChanges,
  liveRecords,
  tombstones,
  buildCorrectiveBaselinePlan,
  compactChangePlan,
  compareFinalStates,
  summarizePlan,
  plannedToChanges,
  maxId,
  recordKey,
  type Change,
  type AuthoritativeRecord,
} from '../../src/core/sync/d4-changelog.ts';

let pass = 0;
const fail: string[] = [];
function check(cond: unknown, msg: string): void {
  if (cond) pass++;
  else fail.push(msg);
}

// Kompakter Change-Builder.
function ch(id: number, action: 'insert' | 'update' | 'delete', record_id: string, data: Record<string, unknown> = {}, opts: { branch?: string; table?: string; tenant?: string } = {}): Change {
  return {
    id, tenant_id: opts.tenant ?? 't1', branch_id: opts.branch ?? 'b1',
    table_name: opts.table ?? 'products', record_id, action, data, created_at: 'T',
  };
}
function entry(state: ReturnType<typeof replayChanges>, r: { record_id: string; branch?: string; table?: string; tenant?: string }) {
  return state.get(recordKey({ tenant_id: r.tenant ?? 't1', branch_id: r.branch ?? 'b1', table_name: r.table ?? 'products', record_id: r.record_id }));
}

// ── 1. Full replay: insert → update → delete → tombstone/deleted ──
function test1(): void {
  const changes = [
    ch(1, 'insert', 'p1', { name: 'A' }),
    ch(2, 'update', 'p1', { name: 'A2' }),
    ch(3, 'delete', 'p1'),
  ];
  const st = replayChanges(changes);
  const e = entry(st, { record_id: 'p1' });
  check(e?.deleted === true && e?.data === null, '1: insert→update→delete → deleted tombstone');
  check(liveRecords(st).length === 0 && tombstones(st).length === 1, '1: 0 live, 1 tombstone');
}

// ── 2. Update mit NIEDRIGERER id als delete darf nicht resurrecten ──
function test2(): void {
  // Array-Reihenfolge „update nach delete", aber update.id (5) < delete.id (10) → id-geordnet: delete gewinnt.
  const changes = [
    ch(1, 'insert', 'p1', { v: 1 }),
    ch(10, 'delete', 'p1'),
    ch(5, 'update', 'p1', { v: 2 }), // niedrigere id → wird VOR dem delete angewandt
  ];
  const e = entry(replayChanges(changes), { record_id: 'p1' });
  check(e?.deleted === true, '2: lower-id update before delete → stays deleted (no resurrection)');
}

// ── 3. Neuer insert mit NEUER record_id nach altem delete → neues Produkt ──
function test3(): void {
  const changes = [
    ch(1, 'insert', 'pA', { n: 'A' }),
    ch(2, 'delete', 'pA'),
    ch(3, 'insert', 'pB', { n: 'B' }), // andere record_id
  ];
  const st = replayChanges(changes);
  check(entry(st, { record_id: 'pA' })?.deleted === true, '3: old pA stays deleted');
  const b = entry(st, { record_id: 'pB' });
  check(b?.deleted === false && (b?.data as { n?: string })?.n === 'B', '3: new pB is a live product');
}

// ── 4. Verwaister Alt-insert → Baseline erzeugt synthetic delete tombstone ──
function test4(): void {
  const changes = [
    ch(1, 'insert', 'orphan', { n: 'ghost' }), // gelöscht mit Alt-App → KEIN delete-Change existiert
    ch(2, 'insert', 'real', { n: 'keep' }),
  ];
  const auth: AuthoritativeRecord[] = [
    { tenant_id: 't1', branch_id: 'b1', table_name: 'products', record_id: 'real', data: { n: 'keep' } },
  ];
  const plan = buildCorrectiveBaselinePlan({ changes, authoritativeLiveRecords: auth });
  check(plan.syntheticDeletes.length === 1 && plan.syntheticDeletes[0].record_id === 'orphan', '4: synthetic delete for orphaned insert');
  check(plan.syntheticDeletes[0].action === 'delete' && plan.syntheticDeletes[0].reason === 'synthetic-delete', '4: tombstone action/reason correct');
  // 'real' is authoritative → NOT tombstoned
  check(!plan.syntheticDeletes.some((d) => d.record_id === 'real'), '4: authoritative record not tombstoned');
}

// ── 5. Autoritative Live-Records → baseline upserts ──
function test5(): void {
  const auth: AuthoritativeRecord[] = [
    { tenant_id: 't1', branch_id: 'b1', table_name: 'products', record_id: 'p1', data: { n: '1' } },
    { tenant_id: 't1', branch_id: 'b1', table_name: 'products', record_id: 'p2', data: { n: '2' } },
  ];
  const plan = buildCorrectiveBaselinePlan({ changes: [], authoritativeLiveRecords: auth });
  check(plan.baselineUpserts.length === 2, '5: one baseline upsert per authoritative record');
  check(plan.baselineUpserts.every((u) => u.action === 'insert' && u.reason === 'baseline-upsert'), '5: baseline upserts are insert/baseline-upsert');
  check(plan.syntheticDeletes.length === 0, '5: empty changelog → no synthetic deletes');
}

// ── 6. Compaction reduziert viele Updates auf finalen Zustand ──
function test6(): void {
  const changes = [
    ch(1, 'insert', 'p1', { v: 0 }),
    ch(2, 'update', 'p1', { v: 1 }),
    ch(3, 'update', 'p1', { v: 2 }),
    ch(4, 'update', 'p1', { v: 3 }),
  ];
  const plan = compactChangePlan(changes);
  check(plan.kept.length === 1, '6: 4 changes → 1 kept');
  check((plan.kept[0].data as { v?: number }).v === 3, '6: kept holds the final state');
  check(plan.archived.length === 3, '6: 3 archived');
}

// ── 7. Compaction behält delete tombstones ──
function test7(): void {
  const changes = [
    ch(1, 'insert', 'p1', { v: 0 }),
    ch(2, 'update', 'p1', { v: 1 }),
    ch(3, 'delete', 'p1'),
  ];
  const plan = compactChangePlan(changes);
  check(plan.kept.length === 1 && plan.kept[0].action === 'delete', '7: compaction keeps the delete tombstone');
  check(plan.archived.length === 2, '7: earlier insert+update archived');
}

// ── 8. Full replay vor/nach Compaction = gleicher finaler Zustand (Baseline korrigiert bewusst) ──
function test8(): void {
  const changes = [
    ch(1, 'insert', 'p1', { v: 0 }),
    ch(2, 'update', 'p1', { v: 9 }),
    ch(3, 'insert', 'p2', { v: 5 }),
    ch(4, 'delete', 'p2'),
    ch(5, 'insert', 'orphan', { v: 1 }),
  ];
  const before = replayChanges(changes);
  const compacted = compactChangePlan(changes);
  const after = replayChanges(compacted.kept);
  check(compareFinalStates(before, after).identical, '8a: compaction preserves final state exactly');

  // Baseline: orphan not authoritative → deliberately corrected live→deleted
  const auth: AuthoritativeRecord[] = [
    { tenant_id: 't1', branch_id: 'b1', table_name: 'products', record_id: 'p1', data: { v: 9 } },
  ];
  const plan = buildCorrectiveBaselinePlan({ changes, authoritativeLiveRecords: auth });
  const materialized = plannedToChanges([...plan.baselineUpserts, ...plan.syntheticDeletes], maxId(changes), 'T');
  const afterBaseline = replayChanges([...changes, ...materialized]);
  const diff = compareFinalStates(before, afterBaseline);
  const orphanFlip = diff.differences.find((d) => d.kind === 'liveness-changed' && d.after?.record_id === 'orphan');
  check(!!orphanFlip, '8b: baseline deliberately flips orphan live→deleted');
  check(entry(afterBaseline, { record_id: 'orphan' })?.deleted === true, '8b: orphan is deleted after baseline');
  check(entry(afterBaseline, { record_id: 'p1' })?.deleted === false, '8b: authoritative p1 stays live');
}

// ── 9. Idempotent: Baseline anwenden → neu berechnen → keine neuen synthetic deletes ──
function test9(): void {
  const changes = [
    ch(1, 'insert', 'orphan', { n: 'x' }),
    ch(2, 'insert', 'real', { n: 'y' }),
  ];
  const auth: AuthoritativeRecord[] = [
    { tenant_id: 't1', branch_id: 'b1', table_name: 'products', record_id: 'real', data: { n: 'y' } },
  ];
  const plan1 = buildCorrectiveBaselinePlan({ changes, authoritativeLiveRecords: auth });
  check(plan1.syntheticDeletes.length === 1, '9: first run tombstones the orphan');
  // apply plan (append to changelog) then recompute
  const applied = plannedToChanges([...plan1.baselineUpserts, ...plan1.syntheticDeletes], maxId(changes), 'T');
  const changes2 = [...changes, ...applied];
  const plan2 = buildCorrectiveBaselinePlan({ changes: changes2, authoritativeLiveRecords: auth });
  check(plan2.syntheticDeletes.length === 0, '9: second run produces NO new tombstones (idempotent)');
}

// ── 10. Multi-table: products/customers/tasks getrennt ──
function test10(): void {
  const changes = [
    ch(1, 'insert', 'x', { n: 'p' }, { table: 'products' }),
    ch(2, 'insert', 'x', { n: 'c' }, { table: 'customers' }), // gleiche record_id, andere Tabelle
    ch(3, 'delete', 'x', {}, { table: 'tasks' }),
  ];
  const st = replayChanges(changes);
  check(entry(st, { record_id: 'x', table: 'products' })?.deleted === false, '10: products/x live');
  check(entry(st, { record_id: 'x', table: 'customers' })?.deleted === false, '10: customers/x live (separate)');
  check(entry(st, { record_id: 'x', table: 'tasks' })?.deleted === true, '10: tasks/x deleted (separate)');
  check(liveRecords(st).length === 2 && tombstones(st).length === 1, '10: tables not mixed');
}

// ── 11. Multi-branch: branch_id nicht vermischen ──
function test11(): void {
  const changes = [
    ch(1, 'insert', 'r1', { n: 'A' }, { branch: 'bA' }),
    ch(2, 'insert', 'r1', { n: 'B' }, { branch: 'bB' }), // gleiche record_id, andere Branch
  ];
  const st = replayChanges(changes);
  check(liveRecords(st).length === 2, '11: same record_id in 2 branches → 2 distinct records');
  // authoritative has only branch A → branch B is orphaned
  const auth: AuthoritativeRecord[] = [
    { tenant_id: 't1', branch_id: 'bA', table_name: 'products', record_id: 'r1', data: { n: 'A' } },
  ];
  const plan = buildCorrectiveBaselinePlan({ changes, authoritativeLiveRecords: auth });
  check(plan.syntheticDeletes.length === 1 && plan.syntheticDeletes[0].branch_id === 'bB', '11: only branch-B r1 tombstoned (branch not mixed)');
  check(plan.baselineUpserts.length === 1 && plan.baselineUpserts[0].branch_id === 'bA', '11: branch-A r1 kept as baseline');
}

// ── 12. Empty changelog / empty authoritative set → kein Crash, klare Summary ──
function test12(): void {
  const st = replayChanges([]);
  check(st.size === 0, '12: empty replay → empty state');
  const plan = buildCorrectiveBaselinePlan({ changes: [], authoritativeLiveRecords: [] });
  check(plan.baselineUpserts.length === 0 && plan.syntheticDeletes.length === 0, '12: empty inputs → empty plan');
  const comp = compactChangePlan([]);
  check(comp.kept.length === 0 && comp.archived.length === 0, '12: empty compaction');
  const sum = summarizePlan({ ...plan, ...comp });
  check(sum.tables === 0 && sum.liveRecords === 0 && sum.tombstones === 0 && sum.archivedChanges === 0, '12: empty summary counts all zero');
}

// ── summarizePlan counts (combined baseline + compaction) ──
function testSummary(): void {
  const changes = [
    ch(1, 'insert', 'p1', { v: 0 }),
    ch(2, 'update', 'p1', { v: 1 }),
    ch(3, 'insert', 'orphan', { v: 2 }),
    ch(4, 'insert', 'c1', { n: 'c' }, { table: 'customers' }),
  ];
  const auth: AuthoritativeRecord[] = [
    { tenant_id: 't1', branch_id: 'b1', table_name: 'products', record_id: 'p1', data: { v: 1 } },
    { tenant_id: 't1', branch_id: 'b1', table_name: 'customers', record_id: 'c1', data: { n: 'c' } },
  ];
  const baseline = buildCorrectiveBaselinePlan({ changes, authoritativeLiveRecords: auth });
  const comp = compactChangePlan(changes);
  const sum = summarizePlan({ ...baseline, ...comp });
  check(sum.baselineUpserts === 2, 'summary: 2 baseline upserts');
  check(sum.syntheticDeletes === 1, 'summary: 1 synthetic delete (orphan)');
  check(sum.tables === 2, 'summary: 2 tables (products, customers)');
  check(sum.archivedChanges === 1, 'summary: 1 archived (the superseded p1 update)');
  check(sum.keptChanges === 3, 'summary: 3 kept (p1 final, orphan, c1)');
}

function main(): void {
  test1(); test2(); test3(); test4(); test5(); test6();
  test7(); test8(); test9(); test10(); test11(); test12();
  testSummary();

  const total = pass + fail.length;
  console.log(`\nD4-B changelog-logic: ${pass}/${total} checks passed`);
  if (fail.length) {
    console.log('FAILURES:');
    for (const f of fail) console.log('  ✗ ' + f);
    process.exit(1);
  }
  console.log('✓ all D4-B pure-logic checks green');
}

main();
