// M5 — Refresh & Reload Persistence regression tests.
// Fahren die ECHTE produktive Orchestrierung prepareAndReloadApplication + createSingleFlight
// (src/core/lifecycle/reload-orchestration.ts) und — fuer Persistenz-/Sync-Nachweis — den ECHTEN
// Save-Coalescer createSaveCoalescer + das ECHTE atomicWrite (src/core/db/atomic-persist.ts)
// gegen node:sqlite-Throwaway-DB + Node-fs-Temp-Datei. KEINE Live-/%APPDATA%-DB.
// Kern: KEIN Reload solange Sync/Write laeuft oder der Stand nicht durabel ist; bei Save-Fehler
// kein Reload + sichtbar + Resume genau einmal + Retry; laufender Sync wird abgewartet und sein
// letzter Write landet im finalen durablen Save; Single-Flight gegen Doppel-F5; aktive Tx blockt.
// Run: node test/m5/reload-persistence.test.ts
import { DatabaseSync } from 'node:sqlite';
import { writeFile, rename, stat, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareAndReloadApplication, createSingleFlight, type ReloadStatus } from '../../src/core/lifecycle/reload-orchestration.ts';
import { createSaveCoalescer, atomicWrite, type FsLike } from '../../src/core/db/atomic-persist.ts';

let pass = 0; const fail: string[] = [];
const check = (c: unknown, m: string) => { if (c) pass++; else fail.push(m); };

// Stub-Ops mit gemeinsamem Reihenfolge-Log + Zaehlern; einzelne Ops ueberschreibbar.
function makeOps(over: Partial<Record<string, unknown>> = {}) {
  const log: string[] = [];
  const statuses: (ReloadStatus | null)[] = [];
  const counts = { pause: 0, wait: 0, save: 0, reload: 0, resume: 0 };
  const base = {
    log, statuses, counts,
    setStatus: (s: ReloadStatus | null) => { statuses.push(s); log.push('status:' + (s ? s.kind : 'null')); },
    yieldToRender: async () => { log.push('yield'); },
    pauseBackgroundWrites: () => { counts.pause++; log.push('pause'); },
    waitForPendingOperations: async () => { counts.wait++; log.push('wait'); },
    durableSave: async () => { counts.save++; log.push('save'); },
    reloadApplication: async () => { counts.reload++; log.push('reload'); },
    resumeBackgroundWrites: () => { counts.resume++; log.push('resume'); },
  };
  return Object.assign(base, over);
}

// Mirror des sync-service.ts M4-A1-Lifecycle-Zustandsautomaten (syncing/syncPaused/inFlightSync +
// startAutoSync-Doppel-Timer-Guard). syncNow behandelt Fehler intern → rejectet nie.
function makeSyncModel() {
  let syncing = false, paused = false, timerActive = false, startCount = 0;
  let inFlight: Promise<void> | null = null;
  function startAutoSync() { if (timerActive) return; timerActive = true; startCount++; }
  function pauseAutoSync() { paused = true; timerActive = false; }
  function resumeAutoSync() { paused = false; startAutoSync(); }
  function syncNow(work?: () => Promise<void>): Promise<void> {
    if (syncing || paused) return Promise.resolve();
    syncing = true;
    const run = (async () => {
      try { if (work) await work(); } catch { /* syncNow behandelt Fehler intern */ }
      finally { syncing = false; inFlight = null; }
    })();
    inFlight = run;
    return run;
  }
  async function waitForSyncIdle() { const p = inFlight; if (p) { try { await p; } catch { /* */ } } }
  return { syncNow, pauseAutoSync, waitForSyncIdle, startAutoSync, resumeAutoSync,
    get paused() { return paused; }, get timerActive() { return timerActive; }, get startCount() { return startCount; } };
}

(async () => {
  // ═══ 1. Erfolgreiche Reihenfolge: status → yield → pause → wait → save → reload ═══
  {
    const ops = makeOps();
    await prepareAndReloadApplication(ops as never);
    check(ops.log.join(',') === 'status:saving,yield,pause,wait,save,reload', '1: Reihenfolge status→yield→pause→wait→save→reload');
    check(ops.counts.reload === 1, '1: Reload genau einmal');
    check(ops.counts.resume === 0, '1: kein Resume bei Erfolg');
  }

  // ═══ 2. Durable Save pending → Reload = 0 ═══
  {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const ops = makeOps({ durableSave: async () => { ops0.counts.save++; ops0.log.push('save'); await gate; } });
    const ops0 = ops as ReturnType<typeof makeOps>;
    const p = prepareAndReloadApplication(ops as never);
    let settled = false; p.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((r) => setTimeout(r, 30));
    check(ops0.counts.reload === 0, '2: Reload NICHT aufgerufen solange durabler Save pending');
    check(!settled, '2: Orchestrierung noch nicht fertig');
    release(); await p;
    check(ops0.counts.reload === 1, '2: nach Save-Freigabe genau ein Reload');
  }

  // ═══ 3. Save-Fehler → Reload=0, Resume genau einmal, Retry moeglich ═══
  {
    let failNext = true;
    const ops = makeOps({ durableSave: async () => { ops0.counts.save++; ops0.log.push('save'); if (failNext) throw new Error('persist failed (injected)'); } });
    const ops0 = ops as ReturnType<typeof makeOps>;
    const guarded = createSingleFlight(() => prepareAndReloadApplication(ops as never));
    let threw = false;
    try { await guarded(); } catch { threw = true; }
    check(threw, '3: Save-Fehler propagiert');
    check(ops0.counts.reload === 0, '3: KEIN Reload bei Save-Fehler');
    check(ops0.counts.resume === 1, '3: Background-Betrieb genau einmal wieder aufgenommen');
    const last = ops0.statuses[ops0.statuses.length - 1];
    check(last != null && last.kind === 'error', '3: sichtbarer Fehlerstatus');
    failNext = false;                        // Fehler behoben
    await guarded();                          // Guard frei → frischer Versuch
    check(ops0.counts.reload === 1, '3: Retry nach Behebung → Reload erfolgreich');
  }

  // ═══ 4. Laufender Sync → Reload wartet; letzter Sync-Write im finalen durablen Save ═══
  {
    const sync = makeSyncModel();
    const mem = new DatabaseSync(':memory:');
    mem.exec('CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT)');
    const persisted: Array<Array<{ id: string }>> = [];
    const coalescer = createSaveCoalescer({
      snapshot: () => new TextEncoder().encode(JSON.stringify(mem.prepare('SELECT * FROM products ORDER BY id').all())),
      persist: async (data: Uint8Array) => { persisted.push(JSON.parse(new TextDecoder().decode(data))); },
    });
    const durableSave = async () => { await coalescer.requestSave(); const e = coalescer.getLastError(); if (e) throw (e instanceof Error ? e : new Error(String(e))); };
    let releaseSync: () => void = () => {};
    const gate = new Promise<void>((r) => { releaseSync = r; });
    const pSync = sync.syncNow(async () => {
      await gate;
      mem.prepare("INSERT INTO products (id,name) VALUES ('SYNCLAST','x')").run();
      coalescer.requestSave();               // wie saveDatabase() im Sync-Pfad (dirty)
    });
    let reloaded = false;
    const pReload = prepareAndReloadApplication({
      setStatus: () => {},
      pauseBackgroundWrites: () => sync.pauseAutoSync(),
      waitForPendingOperations: () => sync.waitForSyncIdle(),
      durableSave,
      reloadApplication: () => { reloaded = true; },
    });
    await new Promise((r) => setTimeout(r, 10));
    check(!reloaded && sync.paused, '4: Sync pausiert; Reload wartet (noch kein Reload)');
    releaseSync(); await pSync; await pReload;
    check(reloaded, '4: Reload erst nach Sync-Abschluss');
    const lastP = persisted[persisted.length - 1] || [];
    check(lastP.some((r) => r.id === 'SYNCLAST'), '4: letzter Sync-Write im finalen durablen Save');
  }

  // ═══ 5. Neuer Sync waehrend Pause → KEIN paralleler Lauf ═══
  {
    const sync = makeSyncModel();
    sync.pauseAutoSync();                     // Reload-Flow hat pausiert
    let ran = false;
    await sync.syncNow(async () => { ran = true; });
    check(!ran, '5: manueller syncNow waehrend Pause startet KEINEN Lauf');
  }

  // ═══ 6. Doppel-F5 → Single-Flight → genau EINE Save-/Reload-Kette ═══
  {
    let releaseSave: () => void = () => {};
    const gate = new Promise<void>((r) => { releaseSave = r; });
    const ops = makeOps({ durableSave: async () => { ops0.counts.save++; ops0.log.push('save'); await gate; } });
    const ops0 = ops as ReturnType<typeof makeOps>;
    const guarded = createSingleFlight(() => prepareAndReloadApplication(ops as never));
    const p1 = guarded();
    await new Promise((r) => setTimeout(r, 10));
    const p2 = guarded();                     // zweites F5 waehrend des Laufs
    check(p1 === p2, '6: zweiter Reload-Aufruf = dasselbe Promise (Single-Flight)');
    check(ops0.counts.save === 1, '6: nur EIN durableSave trotz zwei F5');
    releaseSave(); await p1; await p2;
    check(ops0.counts.reload === 1, '6: genau EIN Reload');
  }

  // ═══ 7. Reload-Fehler → Fehler sichtbar, KEIN zweiter automatischer Reload ═══
  {
    let reloadCount = 0, threw = false, saved = false;
    try {
      await prepareAndReloadApplication({
        setStatus: () => {},
        pauseBackgroundWrites: () => {},
        durableSave: async () => { saved = true; },
        reloadApplication: async () => { reloadCount++; throw new Error('reload failed (injected)'); },
      });
    } catch { threw = true; }
    check(saved, '7: durableSave lief vor dem Reload');
    check(threw, '7: Reload-Fehler propagiert');
    check(reloadCount === 1, '7: genau EIN Reload-Versuch (kein Auto-Retry)');
  }

  // ═══ 8. Aktive Ambient-Transaktion → durableSave wirft → KEIN Reload ═══
  {
    // saveDatabaseDurably wirft bei aktiver Transaktion (database.ts, M2). Hier nachgebildet.
    const durableSaveTxGuard = async () => { throw new Error('saveDatabaseDurably darf nicht innerhalb einer aktiven Transaktion aufgerufen werden'); };
    let reloadCount = 0; let err: unknown = null;
    try {
      await prepareAndReloadApplication({
        setStatus: () => {},
        pauseBackgroundWrites: () => {},
        durableSave: durableSaveTxGuard,
        reloadApplication: () => { reloadCount++; },
      });
    } catch (e) { err = e; }
    check(err instanceof Error && err.message.includes('aktiven Transaktion'), '8: aktive Tx blockt (Fehler nennt Transaktion)');
    check(reloadCount === 0, '8: KEIN Reload bei aktiver Transaktion');
  }

  // ═══ 9. Kein Reload vor Persistenzerfolg + Helper hat keinen Auto-Reload-Pfad ═══
  {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const ops = makeOps({ durableSave: async () => { ops0.counts.save++; await gate; } });
    const ops0 = ops as ReturnType<typeof makeOps>;
    const p = prepareAndReloadApplication(ops as never);
    await new Promise((r) => setTimeout(r, 20));
    check(ops0.counts.reload === 0, '9: langsamer Save → kein Reload vor Persistenzerfolg');
    release(); await p;
    check(ops0.counts.reload === 1, '9: Reload erst nach Persistenzerfolg');
    const src = prepareAndReloadApplication.toString() + createSingleFlight.toString();
    check(!/location\.reload|window\.location|setTimeout\([^,]*reload/.test(src), '9: Helper-Quelle enthaelt keinen eigenen location.reload-Pfad (nur injizierter)');
  }

  // ═══ 10. Tauri-Datei-Persistenznachweis: echtes atomicWrite als durableSave-Backend ═══
  {
    const dir = join(tmpdir(), 'lataif-m5-' + process.pid);
    await mkdir(dir, { recursive: true });
    const fsAdapter: FsLike = {
      writeFile: (p, d) => writeFile(p, d),
      stat: async (p) => { const s = await stat(p); return { size: s.size, mtime: s.mtime }; },
      rename: (a, b) => rename(a, b),
      remove: (p) => rm(p, { force: true }),
      mkdir: (p, o) => mkdir(p, o).then(() => {}),
    };
    const seedPath = join(dir, 'seed.db');
    const sdb = new DatabaseSync(seedPath); sdb.exec("CREATE TABLE t (id TEXT); INSERT INTO t VALUES ('M5-MARKER')"); sdb.close();
    const goodBytes = new Uint8Array(await readFile(seedPath));
    const finalPath = join(dir, 'lataif.db');
    const calls: string[] = [];
    await prepareAndReloadApplication({
      setStatus: () => {}, pauseBackgroundWrites: () => {},
      durableSave: async () => { await atomicWrite(fsAdapter, { dir, finalPath, tmpPath: join(dir, 'lataif.db.tmp'), data: goodBytes, baseline: null }); calls.push('save'); },
      reloadApplication: () => { calls.push('reload'); },
    });
    check(calls.join(',') === 'save,reload', '10: echte atomicWrite-Persistenz VOR reload');
    check(new TextDecoder().decode(await readFile(finalPath)).includes('M5-MARKER'), '10: finale DB-Datei enthaelt den Stand');
    // Fehler: atomicWrite (rename) scheitert → kein Reload, gute Datei bleibt
    const failFs: FsLike = { ...fsAdapter, rename: async () => { throw new Error('rename failed'); } };
    let rCount = 0, threw = false;
    try {
      await prepareAndReloadApplication({
        setStatus: () => {}, pauseBackgroundWrites: () => {},
        durableSave: async () => { await atomicWrite(failFs, { dir, finalPath, tmpPath: join(dir, 't2'), data: goodBytes, baseline: null }); },
        reloadApplication: () => { rCount++; },
      });
    } catch { threw = true; }
    check(threw && rCount === 0, '10: atomicWrite-Fehler → Fehler propagiert, KEIN Reload');
    check(new TextDecoder().decode(await readFile(finalPath)).includes('M5-MARKER'), '10: gute DB-Datei unveraendert nach fehlgeschlagenem Save');
    await rm(dir, { recursive: true, force: true });
  }

  const total = pass + fail.length;
  console.log(`\nM5 reload-persistence: ${pass}/${total} checks passed`);
  if (fail.length) { console.log('FAILURES:'); for (const f of fail) console.log('  X ' + f); process.exit(1); }
  console.log('OK — Reload nur nach durabler Persistenz; Sync pausiert+abgewartet, letzter Sync-Write im Save; Save-Fehler → kein Reload + Resume + Retry; Single-Flight gegen Doppel-F5; aktive Tx blockt; atomicWrite-Vertrag haelt.');
})();
