// M6-B0 — Save-before-Track Durability regression tests.
//
// DEFEKT (bestaetigt in M6-A5): die produktive Store-Reihenfolge ist
//     db.run(UPDATE ...)  ->  saveDatabase()  ->  trackChange(...)
// (z.B. productStore.ts:529-531). saveDatabase() wird NICHT awaited, aber
// createSaveCoalescer.drain() zog `snapshot()` (= db.export()) bisher SYNCHRON
// vor seinem ersten await. Der ERSTE durable Snapshot enthielt damit die
// Business-Zeile OHNE ihre Changelog-Zeile. Ein Crash vor dem zweiten Drain
// laesst die lokale Geschaeftsaenderung bestehen, waehrend der zugehoerige
// Sync-Change dauerhaft fehlt -> STILLER SYNC-PROPAGATION-VERLUST.
// (Die Business-Zeile geht NICHT verloren — nur ihre Weitergabe an andere Geraete.)
//
// FIX (M6-B0): drain() yieldet einmal (`await null`), BEVOR es den ersten Snapshot
// zieht. Der synchrone Mutations-Block (Business-Write + trackChange) laeuft damit
// immer vollstaendig durch, bevor exportiert wird. Zentral in atomic-persist.ts —
// keine der 102 Call-Sites muss angefasst werden und keine kuenftige kann es umgehen.
//
// Faehrt den ECHTEN createSaveCoalescer + das ECHTE atomicWrite gegen eine
// node:sqlite-Throwaway-DB + Node-fs-Temp-Datei. KEINE Live-/%APPDATA%-DB.
// Run: node test/m6b0/save-track-durability.test.ts
import { DatabaseSync } from 'node:sqlite';
import { writeFile, rename, stat, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSaveCoalescer, atomicWrite, type FsLike } from '../../src/core/db/atomic-persist.ts';

let pass = 0; const fail: string[] = [];
const check = (c: unknown, m: string) => { if (c) pass++; else fail.push(m); };

type Snap = { products: { id: string; brand: string }[]; changelog: { id: number; record_id: string }[]; audit: number };

/** In-Memory-DB (Business + Changelog + Audit, wie produktiv in EINER DB) + ECHTER Coalescer. */
function makeEnv(opts: { txActive?: () => boolean } = {}) {
  const mem = new DatabaseSync(':memory:');
  mem.exec(`
    CREATE TABLE products (id TEXT PRIMARY KEY, brand TEXT);
    CREATE TABLE sync_changelog (id INTEGER PRIMARY KEY AUTOINCREMENT, record_id TEXT, synced INTEGER DEFAULT 0);
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, entity_id TEXT);
    INSERT INTO products VALUES ('p1', 'ALT');
  `);

  const disk: Snap[] = [];   // jeder ABGESCHLOSSENE durable Write, in Reihenfolge
  let snapshots = 0;

  const takeSnapshot = (): Uint8Array => {
    snapshots++;
    const s: Snap = {
      products: mem.prepare('SELECT id, brand FROM products ORDER BY id').all() as any,
      changelog: mem.prepare('SELECT id, record_id FROM sync_changelog ORDER BY id').all() as any,
      audit: (mem.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as any).n,
    };
    return new TextEncoder().encode(JSON.stringify(s));
  };

  const saver = createSaveCoalescer({
    snapshot: takeSnapshot,
    // Persist ist async (wie der echte Disk-Write) und laeuft immer durch.
    // disk[0] ist damit exakt "der erste durable geschriebene Snapshot".
    persist: async (bytes) => {
      await Promise.resolve();
      disk.push(JSON.parse(new TextDecoder().decode(bytes)));
    },
    isReady: () => true,
  });

  // Produktives saveDatabase(): bei aktiver Tx NICHT exportieren (v0.8.6-Vertrag).
  const saveDatabase = () => {
    if (opts.txActive?.()) return Promise.resolve();
    return saver.requestSave();
  };

  return { mem, saver, disk, saveDatabase, snapshotCount: () => snapshots };
}

/** Alle anstehenden Drains/Persists auslaufen lassen. */
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

/** EXAKTE Spiegelung der produktiven Reihenfolge aus productStore.updateProduct (529-531). */
function updateProductProductionOrder(env: ReturnType<typeof makeEnv>, id: string, brand: string) {
  env.mem.exec(`UPDATE products SET brand = '${brand}' WHERE id = '${id}'`);   // 529 Business-Write
  env.saveDatabase();                                                           // 530 saveDatabase() — NICHT awaited
  // 531 trackUpdate() -> trackChange(): Changelog-Zeile + eigener saveDatabase()
  env.mem.exec(`INSERT INTO sync_changelog (record_id) VALUES ('${id}')`);
  env.saveDatabase();
  env.mem.exec(`INSERT INTO audit_log (entity_id) VALUES ('${id}')`);           // logAudit(), ohne eigenen Save
}

(async () => {
  // ── F1: der erste durable Snapshot enthaelt Business UND Changelog ──────────
  {
    const env = makeEnv();
    updateProductProductionOrder(env, 'p1', 'NEU');
    await settle();
    const first = env.disk[0];
    check(first !== undefined, '1: es gibt einen ersten durable Snapshot');
    check(first?.products[0].brand === 'NEU', '2: F1 erster Snapshot enthaelt die Business-Aenderung');
    check(first?.changelog.length === 1,
      '3: F1 erster Snapshot enthaelt die Changelog-Zeile (DEFEKT: war 0)');
    check(first?.changelog[0]?.record_id === 'p1', '4: F1 Changelog-Zeile zeigt auf den geaenderten Record');
    check(first?.audit === 1, '5: F1 erster Snapshot enthaelt auch den Audit-Eintrag');
  }

  // ── F2: Crash nach dem ersten durable Write → Neustart ──────────────────────
  {
    const env = makeEnv();
    updateProductProductionOrder(env, 'p1', 'NEU');
    await settle();
    // "Crash": kein weiterer Drain. Der zuletzt durable Stand ist alles, was bleibt.
    const afterRestart = env.disk[0];
    check(afterRestart.products[0].brand === 'NEU', '6: F2 nach Neustart ist die Business-Row da');
    check(afterRestart.changelog.length === 1,
      '7: F2 nach Neustart ist die Changelog-Row da → kein stiller Sync-Propagation-Verlust');
  }

  // ── F3: ungetrackter lokaler Write wird trotzdem gespeichert ────────────────
  {
    const env = makeEnv();
    env.mem.exec(`UPDATE products SET brand = 'NUR-LOKAL' WHERE id = 'p1'`);
    env.saveDatabase();                       // kein trackChange — bewusst nicht gesynct
    await settle();
    check(env.disk[0]?.products[0].brand === 'NUR-LOKAL', '8: F3 ungetrackter Write ist persistiert');
    check(env.disk[0]?.changelog.length === 0, '9: F3 erzeugt korrekt KEINE Changelog-Zeile');
  }

  // ── F4: mehrere getrackte Mutationen in EINEM Turn → ein coalesced Snapshot ─
  {
    const env = makeEnv();
    env.mem.exec(`INSERT INTO products VALUES ('p2', 'X'), ('p3', 'Y')`);
    updateProductProductionOrder(env, 'p1', 'A');
    updateProductProductionOrder(env, 'p2', 'B');
    updateProductProductionOrder(env, 'p3', 'C');
    await settle();
    const s = env.disk[0];
    check(s.changelog.length === 3, '10: F4 alle 3 Changelog-Zeilen im ersten Snapshot');
    check(s.products.find(p => p.id === 'p1')?.brand === 'A'
       && s.products.find(p => p.id === 'p2')?.brand === 'B'
       && s.products.find(p => p.id === 'p3')?.brand === 'C', '11: F4 keine Mutation fehlt');
    check(env.snapshotCount() === 1, '12: F4 coalesced — genau EIN Snapshot fuer 3 Mutationen');
  }

  // ── F5: kein Export innerhalb einer aktiven SQL.js-Transaktion ──────────────
  {
    let txOpen = true;
    const env = makeEnv({ txActive: () => txOpen });
    updateProductProductionOrder(env, 'p1', 'IN-TX');
    await settle();
    check(env.snapshotCount() === 0, '13: F5 bei aktiver Tx wird KEIN Snapshot gezogen');
    check(env.disk.length === 0, '14: F5 bei aktiver Tx wird nichts persistiert');
    // Aeusserstes COMMIT: Tx zu, dann genau ein Save (consumePendingSave-Vertrag)
    txOpen = false;
    env.saveDatabase();
    await settle();
    check(env.disk[0]?.products[0].brand === 'IN-TX' && env.disk[0]?.changelog.length === 1,
      '15: F5 nach COMMIT enthaelt der Snapshot Business UND Changelog');
  }

  // ── F6/F7/F8: Close / Reload / Updater — flush() liefert den vollen Stand ───
  {
    const env = makeEnv();
    updateProductProductionOrder(env, 'p1', 'CLOSE');
    // M4-D Close / M5 Reload / M3 Updater rufen alle flushDatabase() -> saver.flush()
    await env.saver.flush(10);
    const last = env.disk[env.disk.length - 1];
    check(last.products[0].brand === 'CLOSE', '16: F6/F7/F8 flush persistiert die Business-Aenderung');
    check(last.changelog.length === 1, '17: F6/F7/F8 flush persistiert die Changelog-Zeile mit');
    check(!env.saver.isDirty(), '18: F6/F7/F8 nach flush ist nichts mehr dirty');
  }

  // ── F9: Background-Writer (runDailySweep-Muster) ────────────────────────────
  {
    const env = makeEnv();
    // daily-sweep: UPDATE offers SET status='expired' + trackChange, in eigenem Turn
    await Promise.resolve();
    env.mem.exec(`UPDATE products SET brand = 'SWEEP' WHERE id = 'p1'`);
    env.saveDatabase();
    env.mem.exec(`INSERT INTO sync_changelog (record_id) VALUES ('p1')`);
    env.saveDatabase();
    await settle();
    check(env.disk[0]?.products[0].brand === 'SWEEP' && env.disk[0]?.changelog.length === 1,
      '19: F9 Background-Writer persistiert Business UND Changelog gemeinsam');
  }

  // ── F10: Sync-Apply erzeugt KEIN Echo ───────────────────────────────────────
  {
    const env = makeEnv();
    // pullChanges->applyUpsert schreibt NUR die Business-Zeile, ruft nie trackChange
    env.mem.exec(`UPDATE products SET brand = 'FROM-REMOTE' WHERE id = 'p1'`);
    env.saveDatabase();
    await settle();
    check(env.disk[0]?.products[0].brand === 'FROM-REMOTE', '20: F10 Remote-Apply ist persistiert');
    check(env.disk[0]?.changelog.length === 0, '21: F10 Remote-Apply erzeugt KEINEN Echo-Changelog-Eintrag');
  }

  // ── Persist-Fehler bleibt sichtbar (Coalescer-Vertrag unveraendert) ─────────
  {
    const mem = new DatabaseSync(':memory:');
    mem.exec(`CREATE TABLE products (id TEXT PRIMARY KEY, brand TEXT); INSERT INTO products VALUES ('p1','A');`);
    let seen: unknown = null;
    const saver = createSaveCoalescer({
      snapshot: () => new TextEncoder().encode('x'),
      persist: async () => { throw new Error('disk full'); },
      onError: (e) => { seen = e; },
    });
    await saver.requestSave();
    check(seen instanceof Error && (seen as Error).message === 'disk full', '22: Persist-Fehler wird weiterhin an onError gemeldet');
    check(saver.getLastError() !== null, '23: getLastError bleibt gesetzt');
    let threw = false;
    try { await saver.flush(3); } catch { threw = true; }
    check(threw, '24: flush() wirft den Persist-Fehler weiterhin nach aussen');
  }

  // ── atomicWrite-Vertrag unveraendert (echtes fs, Temp-Datei) ────────────────
  {
    const dir = join(tmpdir(), `lataif-m6b0-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const fsLike: FsLike = {
      writeFile: (p, d) => writeFile(p, d),
      stat: async (p) => { const s = await stat(p); return { size: s.size, mtime: s.mtime }; },
      rename: (a, b) => rename(a, b),
      remove: (p) => rm(p, { force: true }),
      mkdir: (p, o) => mkdir(p, o).then(() => undefined),
    };
    const header = new Uint8Array(20);
    header.set(new TextEncoder().encode('SQLite format 3'), 0);
    const finalPath = join(dir, 'x.db');
    const sig = await atomicWrite(fsLike, { dir, finalPath, tmpPath: `${finalPath}.tmp`, data: header, baseline: null });
    check(sig.size === 20, '25: atomicWrite schreibt weiterhin atomar (Temp->rename)');
    let rejected = false;
    try { await atomicWrite(fsLike, { dir, finalPath, tmpPath: `${finalPath}.tmp2`, data: new Uint8Array([1, 2, 3]), baseline: sig }); }
    catch { rejected = true; }
    check(rejected, '26: Nicht-SQLite-Puffer wird weiterhin abgelehnt');
    await rm(dir, { recursive: true, force: true });
  }

  const total = pass + fail.length;
  console.log(`\nM6-B0 save-track-durability: ${pass}/${total} checks passed`);
  if (fail.length) { console.log('FAILURES:'); for (const f of fail) console.log('  X ' + f); process.exit(1); }
  console.log('OK — der erste durable Snapshot enthaelt Business-Zeile UND Changelog-Zeile; coalescing, Tx-Schutz, flush, Fehlerpfad und atomicWrite unveraendert.');
})();
