// M2 — Durable Mobile Sync Cursor regression tests.
// Fahren die ECHTE produktive Orchestrierung commitPulledBatch (src/core/sync/durable-cursor.ts)
// und den ECHTEN Save-Coalescer createSaveCoalescer + das ECHTE atomicWrite
// (src/core/db/atomic-persist.ts) gegen eine node:sqlite-Throwaway-DB + Node-fs-Temp-Datei.
// applyUpsert ist 1:1 aus sync-service.ts:273-304 gespiegelt (die APPLY-Detaillogik; die
// zu sichernde REIHENFOLGE apply→durable-save→cursor kommt aus der importierten commitPulledBatch —
// KEINE zweite Implementierung). Kern: der Cursor rueckt NUR nach bestaetigtem durablem Save vor;
// bei Save-/Apply-/Cursor-Fehler bleibt der Cursor alt → Re-Pull → kein Item-Verlust; Replay
// ist idempotent. KEINE Live-/%APPDATA%-DB.
// Run: node test/m2/mobile-sync-durable-cursor.test.ts
import { DatabaseSync } from 'node:sqlite';
import { writeFile, rename, stat, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitPulledBatch, applyChangesAtomic, SyncApplyError } from '../../src/core/sync/durable-cursor.ts';
import { createSaveCoalescer, atomicWrite, type FsLike } from '../../src/core/db/atomic-persist.ts';

let pass = 0; const fail: string[] = [];
const check = (c: unknown, m: string) => { if (c) pass++; else fail.push(m); };

// ── EXACT mirror of sync-service.ts:273-304 (applyUpsert) ──
function applyUpsert(db: any, table: string, id: string, data: Record<string, unknown>) {
  const keys = Object.keys(data).filter(k => k !== 'id');
  if (keys.length === 0) return;
  const values = keys.map(k => { const v = data[k]; if (v === null || v === undefined) return null; return typeof v === 'object' ? JSON.stringify(v) : v; });
  const exists = (db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE id = ?`).get(id) as any).c > 0;
  if (exists) { const setClause = keys.map(k => `${k} = ?`).join(', '); db.prepare(`UPDATE ${table} SET ${setClause} WHERE id = ?`).run(...values, id); }
  else { const allKeys = ['id', ...keys]; db.prepare(`INSERT INTO ${table} (${allKeys.join(', ')}) VALUES (${allKeys.map(() => '?').join(', ')})`).run(id, ...values); }
}

type PersistMode = 'ok' | 'reject' | 'hang';
// In-Memory-DB + ECHTER Coalescer, dessen persist(=Disk-Write) steuerbar ist.
function makeEnv() {
  const mem = new DatabaseSync(':memory:');
  mem.exec('CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT, condition TEXT)');
  let disk: any[] = [];                 // zuletzt DURABEL persistierter Stand
  let persistCalls = 0;
  const ctl = { mode: 'ok' as PersistMode };
  const coalescer = createSaveCoalescer({
    snapshot: () => new TextEncoder().encode(JSON.stringify(mem.prepare('SELECT * FROM products ORDER BY id').all())),
    persist: async (data: Uint8Array) => {
      persistCalls++;
      if (ctl.mode === 'reject') throw new Error('disk write failed (injected)');
      if (ctl.mode === 'hang') return new Promise<void>(() => {}); // resolved nie
      disk = JSON.parse(new TextDecoder().decode(data));           // Write landet
    },
  });
  // mirror von database.saveDatabaseDurably: requestSave + getLastError-Throw, ECHTER Coalescer.
  const durableSave = async () => { await coalescer.requestSave(); const e = coalescer.getLastError(); if (e) throw (e instanceof Error ? e : new Error(String(e))); };
  return { mem, coalescer, durableSave, ctl, getDisk: () => disk, persistCalls: () => persistCalls };
}
const onDisk = (disk: any[], id: string) => disk.find(r => r.id === id) || null;
const change = (id: number, action: string, record_id: string, data: any) => ({ id, action, table_name: 'products', record_id, data: JSON.stringify(data) });
const freshMem = () => { const m = new DatabaseSync(':memory:'); m.exec('CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT, condition TEXT)'); return m; };
const memIds = (mem: any): string[] => (mem.prepare('SELECT id FROM products ORDER BY id').all() as any[]).map((r: any) => r.id);
// ECHTE sql.js-artige Transaktions-Ops (node:sqlite BEGIN/COMMIT/ROLLBACK) fuer applyChangesAtomic.
const atomicOps = (mem: any, failRecordId: string | null, calls: string[]) => ({
  begin: () => mem.exec('BEGIN'),
  applyChange: (c: any) => { calls.push(c.record_id); if (c.record_id === failRecordId) throw new Error('apply boom for ' + c.record_id); applyUpsert(mem, c.table_name, c.record_id, JSON.parse(c.data)); },
  commit: () => mem.exec('COMMIT'),
  rollback: () => mem.exec('ROLLBACK'),
});

(async () => {
  // ═══ 1. Erfolgreicher Save → Cursor wird vorgerueckt ═══
  {
    const env = makeEnv(); const cursor = { value: 0 };
    const changes = [change(21, 'insert', 'M1', { id: 'M1', name: '', condition: '' })];
    await commitPulledBatch({
      applyBatch: () => { for (const c of changes) applyUpsert(env.mem, 'products', c.record_id, JSON.parse(c.data)); },
      durableSave: env.durableSave,
      setCursor: () => { cursor.value = 21; },
    });
    check(cursor.value === 21, '1: Cursor nach erfolgreichem Save auf 21');
    check(onDisk(env.getDisk(), 'M1') !== null, '1: M1 durabel auf Disk');
  }

  // ═══ 2. Save noch nicht abgeschlossen (haengt) → Cursor bleibt alt ═══
  {
    const env = makeEnv(); const cursor = { value: 5 }; env.ctl.mode = 'hang';
    let settled = false;
    const p = commitPulledBatch({
      applyBatch: () => applyUpsert(env.mem, 'products', 'M2', { id: 'M2', name: 'x', condition: '' }),
      durableSave: env.durableSave,
      setCursor: () => { cursor.value = 21; },
    }).then(() => { settled = true; }, () => { settled = true; });
    await new Promise(r => setTimeout(r, 50));
    check(cursor.value === 5, '2: Cursor bleibt 5 waehrend Save pending');
    check(settled === false, '2: commitPulledBatch noch nicht resolved (Save haengt)');
    void p; // bewusst offen gelassen
  }

  // ═══ 3. Save rejects → Cursor bleibt alt + Fehler propagiert ═══
  {
    const env = makeEnv(); const cursor = { value: 5 }; env.ctl.mode = 'reject';
    let threw = false;
    try {
      await commitPulledBatch({
        applyBatch: () => applyUpsert(env.mem, 'products', 'M3', { id: 'M3', name: 'y', condition: '' }),
        durableSave: env.durableSave,
        setCursor: () => { cursor.value = 21; },
      });
    } catch { threw = true; }
    check(threw, '3: commitPulledBatch wirft bei Save-Fehler (Fehler nicht verschluckt)');
    check(cursor.value === 5, '3: Cursor bleibt 5 (kein Advance bei Save-Fehler)');
    check(onDisk(env.getDisk(), 'M3') === null, '3: M3 NICHT auf Disk');
  }

  // ═══ 4. Prozessende vor Save-Erfolg → Restart re-delivert → Item gespeichert ═══
  {
    const env = makeEnv(); const cursor = { value: 20 };
    const changes = [change(21, 'insert', 'M4', { id: 'M4', name: 'watch', condition: 'Pre-Owned' })];
    env.ctl.mode = 'reject'; // = Prozess stirbt vor durablem Write
    try { await commitPulledBatch({ applyBatch: () => { for (const c of changes) applyUpsert(env.mem, 'products', c.record_id, JSON.parse(c.data)); }, durableSave: env.durableSave, setCursor: () => { cursor.value = 21; } }); } catch { /* erwartet */ }
    check(cursor.value === 20, '4: nach Save-Fehler Cursor unveraendert (20)');
    check(onDisk(env.getDisk(), 'M4') === null, '4: M4 noch nicht durabel');
    const redelivered = changes.filter(c => c.id > cursor.value);
    check(redelivered.length === 1, '4: Server re-delivert die Change (Cursor war nicht vorgerueckt)');
    env.ctl.mode = 'ok';
    await commitPulledBatch({ applyBatch: () => { for (const c of redelivered) applyUpsert(env.mem, 'products', c.record_id, JSON.parse(c.data)); }, durableSave: env.durableSave, setCursor: () => { cursor.value = 21; } });
    check(onDisk(env.getDisk(), 'M4') !== null, '4: nach Re-Pull M4 durabel gespeichert → KEIN Verlust');
    check(cursor.value === 21, '4: Cursor jetzt auf 21');
  }

  // ═══ 5. Coalescing: Save A laeuft, Change B kommt hinzu → B resolved erst nach B-Persistenz ═══
  {
    const mem = new DatabaseSync(':memory:'); mem.exec('CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT, condition TEXT)');
    let releaseA: () => void = () => {}; const gateA = new Promise<void>(r => { releaseA = r; });
    let call = 0; const persisted: any[][] = [];
    const coalescer = createSaveCoalescer({
      snapshot: () => new TextEncoder().encode(JSON.stringify(mem.prepare('SELECT * FROM products ORDER BY id').all())),
      persist: async (data: Uint8Array) => { call++; if (call === 1) await gateA; persisted.push(JSON.parse(new TextDecoder().decode(data))); },
    });
    applyUpsert(mem, 'products', 'A', { id: 'A', name: 'a', condition: '' });
    const pA = coalescer.requestSave();                 // Save A startet, haengt an gateA
    await new Promise(r => setTimeout(r, 10));
    applyUpsert(mem, 'products', 'B', { id: 'B', name: 'b', condition: '' });
    const pB = coalescer.requestSave();                 // B fordert Save an, waehrend A laeuft
    let bResolved = false; pB.then(() => { bResolved = true; });
    await new Promise(r => setTimeout(r, 10));
    check(bResolved === false, '5: B-Caller noch nicht resolved, solange Save A haengt (B nicht in A enthalten)');
    releaseA();
    await pA; await pB;
    check(bResolved === true, '5: B resolved nach Freigabe');
    const last = persisted[persisted.length - 1] || [];
    check(last.some((r: any) => r.id === 'B') && last.some((r: any) => r.id === 'A'), '5: letzter persistierter Stand enthaelt A UND B');
  }

  // ═══ 6. Batch (21,22,23) → genau EIN finaler Cursor nach durablem Save ═══
  {
    const env = makeEnv(); const cursor = { value: 20 };
    const changes = [change(21, 'insert', 'P1', { id: 'P1', name: '1', condition: '' }), change(22, 'insert', 'P2', { id: 'P2', name: '2', condition: '' }), change(23, 'insert', 'P3', { id: 'P3', name: '3', condition: '' })];
    await commitPulledBatch({ applyBatch: () => { for (const c of changes) applyUpsert(env.mem, 'products', c.record_id, JSON.parse(c.data)); }, durableSave: env.durableSave, setCursor: () => { cursor.value = 23; } });
    check(cursor.value === 23, '6: Cursor genau auf 23 (letzte Batch-ID)');
    const d = env.getDisk();
    check(!!(onDisk(d, 'P1') && onDisk(d, 'P2') && onDisk(d, 'P3')), '6: alle 3 durabel');
  }

  // ═══ 7. Apply-Fehler (applyBatch wirft) → kein Save, kein Cursor-Advance ═══
  {
    const env = makeEnv(); const cursor = { value: 5 };
    let threw = false;
    try { await commitPulledBatch({ applyBatch: () => { throw new Error('apply boom'); }, durableSave: env.durableSave, setCursor: () => { cursor.value = 21; } }); } catch { threw = true; }
    check(threw, '7: commitPulledBatch wirft bei Apply-Fehler');
    check(cursor.value === 5, '7: Cursor bleibt 5 (kein Advance)');
    check(env.persistCalls() === 0, '7: kein Save-Versuch (durableSave nicht erreicht)');
  }

  // ═══ 8. Replay-Idempotenz je Operationstyp ═══
  {
    const env = makeEnv();
    applyUpsert(env.mem, 'products', 'R1', { id: 'R1', name: 'orig', condition: 'A' });
    applyUpsert(env.mem, 'products', 'R1', { id: 'R1', name: 'orig', condition: 'A' }); // Replay desselben Inserts
    check((env.mem.prepare("SELECT COUNT(*) AS c FROM products WHERE id='R1'").get() as any).c === 1, '8: doppelter Insert derselben ID → genau 1 Datensatz (Insert→Upsert idempotent)');
    env.mem.prepare('DELETE FROM products WHERE id = ?').run('R1');
    env.mem.prepare('DELETE FROM products WHERE id = ?').run('R1'); // Replay desselben Tombstones
    check((env.mem.prepare("SELECT COUNT(*) AS c FROM products WHERE id='R1'").get() as any).c === 0, '8: doppelter Delete → deterministisch abwesend, keine Doppelwirkung');
  }

  // ═══ 9. Tauri-Disk-Persistenzvertrag: ECHTES atomicWrite auf Temp-Datei (kein %APPDATA%) ═══
  {
    const dir = join(tmpdir(), 'lataif-m2-' + process.pid);
    await mkdir(dir, { recursive: true });
    const fsAdapter: FsLike = {
      writeFile: (p, d) => writeFile(p, d),
      stat: async (p) => { const s = await stat(p); return { size: s.size, mtime: s.mtime }; },
      rename: (a, b) => rename(a, b),
      remove: (p) => rm(p, { force: true }),
      mkdir: (p, o) => mkdir(p, o).then(() => {}),
    };
    const seedPath = join(dir, 'seed.db');
    const sdb = new DatabaseSync(seedPath); sdb.exec("CREATE TABLE t (id TEXT); INSERT INTO t VALUES ('MARKER-A')"); sdb.close();
    const goodBytes = new Uint8Array(await readFile(seedPath));
    const finalPath = join(dir, 'lataif.db');
    const sig = await atomicWrite(fsAdapter, { dir, finalPath, tmpPath: join(dir, 'lataif.db.tmp'), data: goodBytes, baseline: null });
    check(sig != null && sig.size === goodBytes.length, '9a: atomicWrite ok → Signatur mit korrekter Groesse');
    check(new TextDecoder().decode(await readFile(finalPath)).includes('MARKER-A'), '9a: finale Datei enthaelt den neuen Marker');
    const failFs: FsLike = { ...fsAdapter, rename: async () => { throw new Error('rename failed (injected)'); } };
    let awThrew = false;
    try { await atomicWrite(failFs, { dir, finalPath, tmpPath: join(dir, 'lataif.db.tmp2'), data: goodBytes, baseline: sig }); } catch { awThrew = true; }
    check(awThrew, '9b: atomicWrite rejects bei rename-Fehler');
    check(new TextDecoder().decode(await readFile(finalPath)).includes('MARKER-A'), '9b: finale Datei unveraendert (guter Stand erhalten)');
    const cursor = { value: 7 }; let cThrew = false;
    try { await commitPulledBatch({ applyBatch: () => {}, durableSave: async () => { await atomicWrite(failFs, { dir, finalPath, tmpPath: join(dir, 't3'), data: goodBytes, baseline: sig }); }, setCursor: () => { cursor.value = 21; } }); } catch { cThrew = true; }
    check(cThrew && cursor.value === 7, '9b: durableSave-Fehler → commitPulledBatch wirft, Cursor bleibt 7');
    await rm(dir, { recursive: true, force: true });
  }

  // ═══ M2-A: Batch-Failure-Safety (kein stiller per-Change-Skip) ═══════════════════════════

  // ═══ 10. Fehler in der Mitte → ROLLBACK, kein Skip, Abbruch nach dem Fehler ═══
  {
    const mem = freshMem();
    const batch = [change(21, 'insert', 'P1', { id: 'P1', name: '1' }), change(22, 'insert', 'P2', { id: 'P2', name: '2' }), change(23, 'insert', 'P3', { id: 'P3', name: '3' })];
    const calls: string[] = []; let err: any = null;
    try { applyChangesAtomic(batch as any, atomicOps(mem, 'P2', calls)); } catch (e) { err = e; }
    check(err instanceof SyncApplyError, '10: wirft SyncApplyError bei Fehler in der Mitte');
    check(err && err.recordId === 'P2', '10: Fehler zeigt die fehlgeschlagene Change (P2)');
    check(calls.join(',') === 'P1,P2', '10: nach P2-Fehler wird P3 NICHT mehr angewandt (Abbruch)');
    check(memIds(mem).length === 0, '10: ROLLBACK verwirft P1 → kein partieller Stand (0 Rows)');
  }

  // ═══ 11. Memory-Recovery: nach Fehler == letzter dauerhafter Stand ═══
  {
    const mem = freshMem();
    mem.exec("INSERT INTO products (id,name) VALUES ('X0','base')"); // letzter dauerhafter Stand (committed)
    const before = memIds(mem);
    const batch = [change(21, 'insert', 'P1', { id: 'P1', name: '1' }), change(22, 'insert', 'P2', { id: 'P2', name: '2' })];
    try { applyChangesAtomic(batch as any, atomicOps(mem, 'P2', [])); } catch { /* erwartet */ }
    check(JSON.stringify(memIds(mem)) === JSON.stringify(before), '11: Memory nach Fehler == letzter dauerhafter Stand (nur X0)');
  }

  // ═══ 12. Retry: Fehler behoben → alle drei durabel + Cursor auf 23 ═══
  {
    const env = makeEnv(); const cursor = { value: 20 };
    const batch = [change(21, 'insert', 'P1', { id: 'P1', name: '1', condition: '' }), change(22, 'insert', 'P2', { id: 'P2', name: '2', condition: '' }), change(23, 'insert', 'P3', { id: 'P3', name: '3', condition: '' })];
    try { await commitPulledBatch({ applyBatch: () => applyChangesAtomic(batch as any, atomicOps(env.mem, 'P2', [])), durableSave: env.durableSave, setCursor: () => { cursor.value = 23; } }); } catch { /* erwartet */ }
    check(cursor.value === 20 && memIds(env.mem).length === 0, '12: nach Fehler Cursor 20 + kein Teil-Batch im Memory');
    await commitPulledBatch({ applyBatch: () => applyChangesAtomic(batch as any, atomicOps(env.mem, null, [])), durableSave: env.durableSave, setCursor: () => { cursor.value = 23; } });
    check(cursor.value === 23, '12: Retry (Fehler behoben) → Cursor auf 23');
    const d = env.getDisk();
    check(!!(onDisk(d, 'P1') && onDisk(d, 'P2') && onDisk(d, 'P3')), '12: alle drei durabel');
  }

  // ═══ 13. Fehler beim ERSTEN Change → nichts angewandt, kein Save, kein Cursor ═══
  {
    const env = makeEnv(); const cursor = { value: 5 };
    const batch = [change(21, 'insert', 'P1', { id: 'P1', name: 'a' }), change(22, 'insert', 'P2', { id: 'P2', name: 'b' })];
    let threw = false;
    try { await commitPulledBatch({ applyBatch: () => applyChangesAtomic(batch as any, atomicOps(env.mem, 'P1', [])), durableSave: env.durableSave, setCursor: () => { cursor.value = 22; } }); } catch { threw = true; }
    check(threw, '13: wirft bei Fehler beim ersten Change');
    check(cursor.value === 5 && env.persistCalls() === 0, '13: kein Save, kein Cursor-Advance');
    check(memIds(env.mem).length === 0, '13: keine sichtbare Aenderung (0 Rows)');
  }

  // ═══ 14. Fehler beim LETZTEN Change → kein partiell dauerhafter Batch, Cursor bleibt ═══
  {
    const env = makeEnv(); const cursor = { value: 20 };
    const batch = [change(21, 'insert', 'P1', { id: 'P1', name: 'a' }), change(22, 'insert', 'P2', { id: 'P2', name: 'b' }), change(23, 'insert', 'P3', { id: 'P3', name: 'c' })];
    try { await commitPulledBatch({ applyBatch: () => applyChangesAtomic(batch as any, atomicOps(env.mem, 'P3', [])), durableSave: env.durableSave, setCursor: () => { cursor.value = 23; } }); } catch { /* erwartet */ }
    check(cursor.value === 20, '14: Cursor NICHT auf 23');
    check(memIds(env.mem).length === 0, '14: P1,P2 rolled back → kein partiell dauerhafter Batch');
    check(env.persistCalls() === 0, '14: kein durable Save');
  }

  // ═══ 15. Fehlerkontext: id/table/record/op + Original-Meldung, KEIN Payload ═══
  {
    const mem = freshMem();
    const batch = [change(99, 'update', 'REC-X', { id: 'REC-X', name: 'secret-should-not-appear' })];
    let err: any = null;
    try { applyChangesAtomic(batch as any, { begin: () => mem.exec('BEGIN'), applyChange: () => { throw new Error('sqlite: no such column'); }, commit: () => mem.exec('COMMIT'), rollback: () => mem.exec('ROLLBACK') }); } catch (e) { err = e; }
    check(err instanceof SyncApplyError, '15: SyncApplyError');
    check(err.changeId === 99 && err.table === 'products' && err.recordId === 'REC-X' && err.action === 'update', '15: Kontext id/table/record/op korrekt');
    check(String(err.message).includes('no such column'), '15: Original-Meldung enthalten');
    check(!String(err.message).includes('secret-should-not-appear'), '15: KEIN Payload in der Fehlermeldung');
  }

  // ═══ 16. Integration: applyBatch-Fehler → commitPulledBatch wirft, kein Save/Cursor ═══
  {
    const env = makeEnv(); const cursor = { value: 7 }; let threw = false;
    const batch = [change(21, 'insert', 'P1', { id: 'P1', name: 'a' }), change(22, 'insert', 'P2', { id: 'P2', name: 'b' })];
    try { await commitPulledBatch({ applyBatch: () => applyChangesAtomic(batch as any, atomicOps(env.mem, 'P2', [])), durableSave: env.durableSave, setCursor: () => { cursor.value = 22; } }); } catch { threw = true; }
    check(threw && cursor.value === 7 && env.persistCalls() === 0, '16: applyBatch-Fehler → wirft, kein durableSave, Cursor bleibt 7');
  }

  const total = pass + fail.length;
  console.log(`\nM2 mobile-sync-durable-cursor: ${pass}/${total} checks passed`);
  if (fail.length) { console.log('FAILURES:'); for (const f of fail) console.log('  X ' + f); process.exit(1); }
  console.log('OK — Cursor rueckt nur nach bestaetigtem durablem Save vor; Save-/Apply-/Cursor-Fehler → kein Verlust; Replay idempotent; atomicWrite-Vertrag haelt.');
})();
