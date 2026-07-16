// M4-A — Window Close & Shutdown Persistence regression tests.
// Fahren die ECHTE produktive Orchestrierung prepareAndCloseApplication + createSingleFlight
// (src/core/lifecycle/close-orchestration.ts) und — fuer den Persistenz-/Hintergrundwrite-Nachweis —
// den ECHTEN Save-Coalescer createSaveCoalescer + das ECHTE atomicWrite (src/core/db/atomic-persist.ts)
// gegen eine node:sqlite-Throwaway-DB + Node-fs-Temp-Datei. KEINE Live-/%APPDATA%-DB.
// Kern: Close schliesst NUR nach bestaetigter Persistenz; bei Flush-Fehler kein Close, kein Hard-Exit,
// Fehler sichtbar + Retry moeglich; Single-Flight gegen Doppelklick; Background-Writes werden vor dem
// Flush gestoppt; ein laufender Write wird durabel abgeschlossen, bevor das Fenster schliesst.
// Run: node test/m4/window-close-persistence.test.ts
import { DatabaseSync } from 'node:sqlite';
import { writeFile, rename, stat, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareAndCloseApplication, createSingleFlight, type CloseStatus } from '../../src/core/lifecycle/close-orchestration.ts';
import { createSaveCoalescer, atomicWrite, type FsLike } from '../../src/core/db/atomic-persist.ts';

let pass = 0; const fail: string[] = [];
const check = (c: unknown, m: string) => { if (c) pass++; else fail.push(m); };

// Baut Stub-Ops mit gemeinsamem Reihenfolge-Log + Zaehlern; einzelne Ops sind ueberschreibbar.
function makeOps(over: Partial<Record<string, unknown>> = {}) {
  const log: string[] = [];
  const statuses: (CloseStatus | null)[] = [];
  const counts = { stop: 0, wait: 0, flush: 0, close: 0, resume: 0 };
  const base = {
    log, statuses, counts,
    setStatus: (s: CloseStatus | null) => { statuses.push(s); log.push('status:' + (s ? s.kind : 'null')); },
    yieldToRender: async () => { log.push('yield'); },
    stopBackgroundWrites: () => { counts.stop++; log.push('stop'); },
    waitForPendingOperations: async () => { counts.wait++; log.push('wait'); },
    flushPendingDatabaseWrites: async () => { counts.flush++; log.push('flush'); },
    closeWindow: async () => { counts.close++; log.push('close'); },
    resumeBackgroundWrites: () => { counts.resume++; log.push('resume'); },
  };
  return Object.assign(base, over);
}

(async () => {
  // ═══ 1. Erfolgreicher Close: Status → Stop → Flush → genau EIN Window-Close ═══
  {
    const ops = makeOps();
    await prepareAndCloseApplication(ops as never);
    check(ops.log.join(',') === 'status:saving,yield,stop,wait,flush,close', '1: Reihenfolge status→yield→stop→wait→flush→close');
    check(ops.counts.close === 1, '1: Window genau einmal geschlossen');
    check(ops.counts.resume === 0, '1: kein Resume bei Erfolg');
  }

  // ═══ 2. Flush pending → Window noch NICHT geschlossen ═══
  {
    let releaseFlush: () => void = () => {};
    const gate = new Promise<void>((r) => { releaseFlush = r; });
    const ops = makeOps({ flushPendingDatabaseWrites: async () => { ops0.counts.flush++; ops0.log.push('flush'); await gate; } });
    const ops0 = ops as ReturnType<typeof makeOps>;
    const p = prepareAndCloseApplication(ops as never);
    let settled = false; p.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((r) => setTimeout(r, 30));
    check(ops0.counts.close === 0, '2: Window NICHT geschlossen solange Flush pending');
    check(!settled, '2: Close-Orchestrierung noch nicht fertig');
    releaseFlush(); await p;
    check(ops0.counts.close === 1, '2: nach Flush-Freigabe genau ein Close');
  }

  // ═══ 3. Flush-Fehler → kein Close, Fehler propagiert, Status 'error', Resume, Retry frei ═══
  {
    const ops = makeOps({ flushPendingDatabaseWrites: async () => { throw new Error('persist failed (injected)'); } });
    let threw = false;
    try { await prepareAndCloseApplication(ops as never); } catch { threw = true; }
    check(threw, '3: Flush-Fehler propagiert');
    check(ops.counts.close === 0, '3: KEIN Window-Close bei Flush-Fehler (Regel A/B)');
    check(ops.counts.resume === 1, '3: Background-Betrieb wieder aufgenommen');
    const last = ops.statuses[ops.statuses.length - 1];
    check(last != null && last.kind === 'error' && last.message.includes('persist failed'), '3: sichtbarer Fehlerstatus');
  }

  // ═══ 4. Doppelklick → Single-Flight → genau EINE Flush-/Close-Kette ═══
  {
    let releaseFlush: () => void = () => {};
    const gate = new Promise<void>((r) => { releaseFlush = r; });
    const ops = makeOps({ flushPendingDatabaseWrites: async () => { ops0.counts.flush++; ops0.log.push('flush'); await gate; } });
    const ops0 = ops as ReturnType<typeof makeOps>;
    const guarded = createSingleFlight(() => prepareAndCloseApplication(ops as never));
    const p1 = guarded();
    await new Promise((r) => setTimeout(r, 10));
    const p2 = guarded();
    check(p1 === p2, '4: zweiter Close-Aufruf = dasselbe Promise (Single-Flight)');
    check(ops0.counts.flush === 1, '4: nur EINE Flush-Kette trotz zwei Klicks');
    releaseFlush(); await p1; await p2;
    check(ops0.counts.close === 1, '4: genau EIN Window-Close');
  }

  // ═══ 5. Fehler dann Retry → zweiter Close erfolgreich ═══
  {
    let failNext = true;
    const ops = makeOps({ flushPendingDatabaseWrites: async () => { ops0.counts.flush++; ops0.log.push('flush'); if (failNext) throw new Error('disk busy'); } });
    const ops0 = ops as ReturnType<typeof makeOps>;
    const guarded = createSingleFlight(() => prepareAndCloseApplication(ops as never));
    let threw = false;
    try { await guarded(); } catch { threw = true; }
    check(threw && ops0.counts.close === 0, '5: erster Close scheitert (kein Window-Close)');
    failNext = false;                       // Fehler behoben
    await guarded();                         // Guard nach Fehler frei → frischer Versuch
    check(ops0.counts.close === 1, '5: zweiter Close nach Behebung erfolgreich');
  }

  // ═══ 6. Hintergrundwrite laeuft (echter Coalescer) → Close wartet → Write durabel → dann Close ═══
  {
    const mem = new DatabaseSync(':memory:');
    mem.exec('CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT)');
    let releaseA: () => void = () => {};
    const gateA = new Promise<void>((r) => { releaseA = r; });
    let call = 0; const persisted: Array<Array<{ id: string }>> = [];
    const coalescer = createSaveCoalescer({
      snapshot: () => new TextEncoder().encode(JSON.stringify(mem.prepare('SELECT * FROM products ORDER BY id').all())),
      persist: async (data: Uint8Array) => { call++; if (call === 1) await gateA; persisted.push(JSON.parse(new TextDecoder().decode(data))); },
    });
    mem.prepare("INSERT INTO products (id,name) VALUES ('BEFORE','b')").run();
    const pA = coalescer.requestSave();     // Background-Write startet, haengt an gateA
    await new Promise((r) => setTimeout(r, 10));
    mem.prepare("INSERT INTO products (id,name) VALUES ('DURING','d')").run(); // Write waehrend Close-Vorbereitung
    coalescer.requestSave();                // wie das echte saveDatabase(): markiert den neuen Stand als angefordert (dirty)
    let closed = false;
    const pClose = prepareAndCloseApplication({
      setStatus: () => {},
      stopBackgroundWrites: () => {},
      // flushDatabase-Analog: wartet auf inFlight (den Background-Write) + flusht dirty + wirft bei Fehler.
      flushPendingDatabaseWrites: () => coalescer.flush(),
      closeWindow: async () => { closed = true; },
    });
    await new Promise((r) => setTimeout(r, 10));
    check(!closed, '6: Window NICHT geschlossen, solange der laufende Write nicht durabel ist');
    releaseA(); await pA; await pClose;
    check(closed, '6: Close erst nach durablem Abschluss des Writes');
    const last = persisted[persisted.length - 1] || [];
    check(last.some((r) => r.id === 'DURING') && last.some((r) => r.id === 'BEFORE'), '6: persistierter Stand enthaelt BEFORE+DURING (kein stiller Verlust)');
  }

  // ═══ 7. Neuer Write nach Close-Beginn: stopBackgroundWrites VOR dem Flush (keine neuen Writes) ═══
  {
    let stopped = false; let lateWriteApplied = false;
    const ops = makeOps({
      stopBackgroundWrites: () => { ops0.counts.stop++; ops0.log.push('stop'); stopped = true; },
      flushPendingDatabaseWrites: async () => {
        ops0.counts.flush++; ops0.log.push('flush');
        // Ein "Background-Writer", der die Stop-Sperre respektiert, schreibt jetzt NICHT mehr.
        if (!stopped) lateWriteApplied = true;
      },
    });
    const ops0 = ops as ReturnType<typeof makeOps>;
    await prepareAndCloseApplication(ops as never);
    check(ops0.log.indexOf('stop') < ops0.log.indexOf('flush'), '7: stopBackgroundWrites laeuft VOR dem Flush');
    check(!lateWriteApplied, '7: kein neuer Background-Write nach Close-Beginn');
  }

  // ═══ 8. Kein Hard-Exit: der Helper ruft NIE einen Prozess-Exit; kein Close vor Persistenzerfolg ═══
  {
    // langsamer Flush → kein Close, solange pending
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const slow = makeOps({ flushPendingDatabaseWrites: async () => { slow0.counts.flush++; await gate; } });
    const slow0 = slow as ReturnType<typeof makeOps>;
    const pSlow = prepareAndCloseApplication(slow as never);
    await new Promise((r) => setTimeout(r, 20));
    check(slow0.counts.close === 0, '8: langsamer Flush → kein closeWindow vor Persistenzerfolg');
    release(); await pSlow;
    check(slow0.counts.close === 1, '8: Close erst nach Persistenzerfolg');
    // Flush-Fehler → kein Close (der Helper enthaelt keinen process.exit-Pfad)
    const err = makeOps({ flushPendingDatabaseWrites: async () => { throw new Error('boom'); } });
    try { await prepareAndCloseApplication(err as never); } catch { /* erwartet */ }
    check(err.counts.close === 0, '8: Flush-Fehler → kein Close (und kein Hard-Exit im Helper)');
    const src = (prepareAndCloseApplication.toString() + createSingleFlight.toString());
    check(!/process\.exit|proc\.exit|\.exit\(/.test(src), '8: Helper-Quelle enthaelt keinen Prozess-Exit');
  }

  // ═══ 9. Regel E: Status 'saving' + Render-Turn VOR dem (blockierenden) Flush ═══
  {
    const ops = makeOps();
    await prepareAndCloseApplication(ops as never);
    const iSaving = ops.log.indexOf('status:saving');
    const iYield = ops.log.indexOf('yield');
    const iFlush = ops.log.indexOf('flush');
    check(iSaving === 0 && iYield > iSaving && iFlush > iYield, '9: setStatus(saving) → yieldToRender → erst dann Flush');
  }

  // ═══ 10. Tauri-Datei-Persistenznachweis: echtes atomicWrite als Flush-Backend ═══
  {
    const dir = join(tmpdir(), 'lataif-m4-' + process.pid);
    await mkdir(dir, { recursive: true });
    const fsAdapter: FsLike = {
      writeFile: (p, d) => writeFile(p, d),
      stat: async (p) => { const s = await stat(p); return { size: s.size, mtime: s.mtime }; },
      rename: (a, b) => rename(a, b),
      remove: (p) => rm(p, { force: true }),
      mkdir: (p, o) => mkdir(p, o).then(() => {}),
    };
    const seedPath = join(dir, 'seed.db');
    const sdb = new DatabaseSync(seedPath); sdb.exec("CREATE TABLE t (id TEXT); INSERT INTO t VALUES ('M4-MARKER')"); sdb.close();
    const goodBytes = new Uint8Array(await (await import('node:fs/promises')).readFile(seedPath));
    const finalPath = join(dir, 'lataif.db');
    let closed = false;
    await prepareAndCloseApplication({
      setStatus: () => {}, stopBackgroundWrites: () => {},
      flushPendingDatabaseWrites: async () => { await atomicWrite(fsAdapter, { dir, finalPath, tmpPath: join(dir, 'lataif.db.tmp'), data: goodBytes, baseline: null }); },
      closeWindow: async () => { closed = true; },
    });
    const onDisk = new TextDecoder().decode(await (await import('node:fs/promises')).readFile(finalPath));
    check(closed && onDisk.includes('M4-MARKER'), '10: echter atomicWrite-Flush → Datei persistent, dann Close');
    // Fehlerfall: atomicWrite (rename) scheitert → kein Close
    const failFs: FsLike = { ...fsAdapter, rename: async () => { throw new Error('rename failed'); } };
    let closed2 = false, threw = false;
    try {
      await prepareAndCloseApplication({
        setStatus: () => {}, stopBackgroundWrites: () => {},
        flushPendingDatabaseWrites: async () => { await atomicWrite(failFs, { dir, finalPath, tmpPath: join(dir, 't2'), data: goodBytes, baseline: null }); },
        closeWindow: async () => { closed2 = true; },
      });
    } catch { threw = true; }
    check(threw && !closed2, '10: atomicWrite-Fehler → Fehler propagiert, KEIN Close');
    await rm(dir, { recursive: true, force: true });
  }

  // ═══ M4-A1: Sync-Lifecycle (pause → wait-idle → flush → close) ═══════════════════════════
  // Modell des sync-service.ts M4-A1-Zustandsautomaten (syncing-Single-Flight + syncPaused +
  // inFlightSync + startAutoSync-Doppel-Timer-Guard). syncNow() behandelt Fehler INTERN und
  // rejectet nie — exakt wie die Produktion (1:1 gespiegelt, KEINE zweite Implementierung der
  // Orchestrierung: die kommt aus dem importierten prepareAndCloseApplication). Der echte
  // sync-service wird im Browser-Smoke gefahren.
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
        try { if (work) await work(); } catch { /* syncNow behandelt Fehler intern (setStatus error) */ }
        finally { syncing = false; inFlight = null; }
      })();
      inFlight = run;
      return run;
    }
    async function waitForSyncIdle() { const p = inFlight; if (p) { try { await p; } catch { /* */ } } }
    return { syncNow, pauseAutoSync, waitForSyncIdle, startAutoSync, resumeAutoSync,
      get paused() { return paused; }, get timerActive() { return timerActive; }, get startCount() { return startCount; } };
  }

  // ═══ 11. Laufender Sync → Close pausiert + wartet; Flush/Close erst nach Sync-Ende ═══
  {
    const sync = makeSyncModel();
    let releaseSync: () => void = () => {};
    const gate = new Promise<void>((r) => { releaseSync = r; });
    const pSync = sync.syncNow(async () => { await gate; });   // laufender Sync
    let flushed = false, closed = false;
    const pClose = prepareAndCloseApplication({
      setStatus: () => {},
      stopBackgroundWrites: () => sync.pauseAutoSync(),
      waitForPendingOperations: () => sync.waitForSyncIdle(),
      flushPendingDatabaseWrites: async () => { flushed = true; },
      closeWindow: async () => { closed = true; },
    });
    await new Promise((r) => setTimeout(r, 20));
    check(sync.paused, '11: Sync pausiert sobald der Close beginnt');
    check(!flushed && !closed, '11: Flush/Close warten auf den laufenden Sync');
    releaseSync(); await pSync; await pClose;
    check(flushed && closed, '11: nach Sync-Ende → Flush → Close');
  }

  // ═══ 12. Letzter Sync-Write landet im finalen Flush (echter Coalescer) ═══
  {
    const sync = makeSyncModel();
    const mem = new DatabaseSync(':memory:');
    mem.exec('CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT)');
    const persisted: Array<Array<{ id: string }>> = [];
    const coalescer = createSaveCoalescer({
      snapshot: () => new TextEncoder().encode(JSON.stringify(mem.prepare('SELECT * FROM products ORDER BY id').all())),
      persist: async (data: Uint8Array) => { persisted.push(JSON.parse(new TextDecoder().decode(data))); },
    });
    let releaseSync: () => void = () => {};
    const gate = new Promise<void>((r) => { releaseSync = r; });
    // laufender Sync schreibt seinen letzten Datensatz KURZ VOR Abschluss
    const pSync = sync.syncNow(async () => {
      await gate;
      mem.prepare("INSERT INTO products (id,name) VALUES ('SYNCLAST','x')").run();
      coalescer.requestSave();   // wie saveDatabase() im Sync-Pfad (dirty)
    });
    let closed = false;
    const pClose = prepareAndCloseApplication({
      setStatus: () => {},
      stopBackgroundWrites: () => sync.pauseAutoSync(),
      waitForPendingOperations: () => sync.waitForSyncIdle(),
      flushPendingDatabaseWrites: () => coalescer.flush(),
      closeWindow: async () => { closed = true; },
    });
    await new Promise((r) => setTimeout(r, 10));
    check(!closed, '12: Close wartet auf den laufenden Sync (noch kein Close)');
    releaseSync(); await pSync; await pClose;
    check(closed, '12: Close erst nach Sync-Abschluss');
    const last = persisted[persisted.length - 1] || [];
    check(last.some((r) => r.id === 'SYNCLAST'), '12: finaler Flush enthaelt den letzten Sync-Write');
  }

  // ═══ 13. Neuer manueller Sync waehrend Pause → KEIN paralleler Lauf ═══
  {
    const sync = makeSyncModel();
    sync.pauseAutoSync();                                  // Close hat pausiert
    let ran = false;
    await sync.syncNow(async () => { ran = true; });       // manueller Sync-Versuch
    check(!ran, '13: manueller syncNow waehrend Pause startet KEINEN Lauf');
  }

  // ═══ 14. Sync-Fehler (dokumentierter Vertrag): syncNow rejectet nie → Lauf beendet → Flush ═══
  {
    const sync = makeSyncModel();
    let releaseSync: () => void = () => {};
    const gate = new Promise<void>((r) => { releaseSync = r; });
    const pSync = sync.syncNow(async () => { await gate; throw new Error('sync work failed'); });
    let flushed = false, closed = false;
    const pClose = prepareAndCloseApplication({
      setStatus: () => {},
      stopBackgroundWrites: () => sync.pauseAutoSync(),
      waitForPendingOperations: () => sync.waitForSyncIdle(),
      flushPendingDatabaseWrites: async () => { flushed = true; },
      closeWindow: async () => { closed = true; },
    });
    await new Promise((r) => setTimeout(r, 10));
    check(!flushed, '14: Flush wartet auf den (intern fehlerhaften) Sync-Lauf');
    releaseSync(); await pSync; await pClose;
    check(flushed && closed, '14: Sync-Fehler intern behandelt → Lauf vollstaendig beendet VOR Flush → Flush+Close');
  }

  // ═══ 15. Resume nach fehlgeschlagenem Close → genau EIN Timer (kein doppeltes Intervall) ═══
  {
    const sync = makeSyncModel();
    sync.startAutoSync();
    check(sync.timerActive && sync.startCount === 1, '15: ein aktiver Timer nach startAutoSync');
    sync.pauseAutoSync();
    check(!sync.timerActive, '15: Pause deaktiviert den Timer');
    sync.resumeAutoSync();
    check(sync.timerActive && sync.startCount === 2, '15: Resume → genau ein Timer neu gestartet');
    sync.resumeAutoSync();
    check(sync.timerActive && sync.startCount === 2, '15: doppeltes Resume erzeugt KEINEN zweiten Timer');
  }

  // ═══ 16. M4-D: nativer Finalizer schlaegt VOR dem Exit fehl → error-Status, Resume, Retry frei ═══
  {
    // Der finale Schritt ist jetzt der native Close-Finalizer (invoke('finalize_application_shutdown')).
    // Im Erfolgsfall beendet Rust den Prozess (Promise loest nie auf). Schlaegt der invoke aber VOR
    // dem Exit fehl, gilt Regel A/B analog zum Flush-Fehler: sichtbarer Fehler, Background wieder
    // aufnehmen, App bleibt offen, erneuter Close moeglich (kein stiller Hang, kein Hard-Exit).
    let failNext = true;
    const ops = makeOps({
      closeWindow: async () => { ops0.counts.close++; ops0.log.push('close'); if (failNext) throw new Error('finalize failed (injected)'); },
    });
    const ops0 = ops as ReturnType<typeof makeOps>;
    const guarded = createSingleFlight(() => prepareAndCloseApplication(ops as never));
    let threw = false;
    try { await guarded(); } catch { threw = true; }
    check(threw, '16: Finalizer-Fehler propagiert');
    check(ops0.counts.resume === 1, '16: Background nach Finalizer-Fehler genau einmal wieder aufgenommen');
    const last = ops0.statuses[ops0.statuses.length - 1];
    check(last != null && last.kind === 'error' && last.message.includes('finalize failed'), '16: sichtbarer Fehlerstatus bei Finalizer-Fehler');
    failNext = false;                        // Ursache behoben
    await guarded();                          // Guard nach Fehler frei → erneuter Close erreicht den Finalizer
    check(ops0.counts.close === 2, '16: zweiter Close nach Behebung ruft den Finalizer erneut (Retry moeglich)');
  }

  // ═══ 17. M4-D: Erfolgsreihenfolge endet im nativen Finalizer (pause → wait-idle → flush → finalize) ═══
  {
    // Spiegelt das produktive App.tsx-Wiring: stopBackgroundWrites=pauseAutoSync,
    // waitForPendingOperations=waitForSyncIdle, flush, closeWindow=invoke('finalize_application_shutdown').
    const order: string[] = [];
    let finalized = 0;
    await prepareAndCloseApplication({
      setStatus: () => {},
      stopBackgroundWrites: () => { order.push('pause'); },
      waitForPendingOperations: async () => { order.push('wait'); },
      flushPendingDatabaseWrites: async () => { order.push('flush'); },
      closeWindow: async () => { order.push('finalize'); finalized++; },
    });
    check(order.join(',') === 'pause,wait,flush,finalize', '17: Reihenfolge pause → wait-idle → flush → nativer Finalizer');
    check(finalized === 1, '17: nativer Finalizer genau einmal (kein Doppel-Abschluss)');
  }

  // ═══ 18. M4-D: der alte fragile Abschluss ist aus dem produktiven Close-Wiring (App.tsx) entfernt ═══
  {
    // Beweist am echten Source: KEIN win.destroy(), KEIN proc.exit()/JS-Exit-Timer, kein plugin-process-
    // Import mehr — stattdessen der native Finalizer-invoke. Kommentare werden entfernt, damit
    // erklaerende "KEIN win.destroy()"-Hinweise nicht falsch-positiv matchen.
    const { readFile } = await import('node:fs/promises');
    const appSrc = await readFile(new URL('../../src/App.tsx', import.meta.url), 'utf8');
    const codeOnly = appSrc
      .replace(/\/\*[\s\S]*?\*\//g, '')          // Blockkommentare
      .replace(/(^|[^:])\/\/.*$/gm, '$1');       // Zeilenkommentare (":" -> URLs verschonen)
    check(/invoke\(\s*['"]finalize_application_shutdown['"]\s*\)/.test(codeOnly), '18: Close-Pfad ruft den nativen Finalizer finalize_application_shutdown');
    check(!/win\.destroy\s*\(/.test(codeOnly), '18: kein win.destroy() mehr im Close-Pfad');
    check(!/proc\.exit\s*\(/.test(codeOnly), '18: kein proc.exit() / JS-Exit-Timer mehr');
    check(!appSrc.includes('plugin-process'), '18: App.tsx importiert @tauri-apps/plugin-process nicht mehr (Exit-Pfad entfernt)');
  }

  const total = pass + fail.length;
  console.log(`\nM4-A/M4-D window-close-persistence: ${pass}/${total} checks passed`);
  if (fail.length) { console.log('FAILURES:'); for (const f of fail) console.log('  X ' + f); process.exit(1); }
  console.log('OK — Close nur nach bestaetigter Persistenz; Sync pausiert+abgewartet vor Flush; letzter Sync-Write im Flush; Flush-Fehler → kein Close/Hard-Exit + retrybar; Single-Flight; Resume ohne Doppel-Timer; UI vor Flush; M4-D: finaler Schritt = nativer Finalizer (kein win.destroy/proc.exit), Finalizer-Fehler retrybar.');
})();
