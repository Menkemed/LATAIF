// M3 — Durable DB Flush Before Updater Relaunch regression tests.
// Fahren die ECHTE produktive Orchestrierung prepareAndInstallUpdate + createSingleFlight
// (src/core/updater/update-orchestration.ts) und — fuer den Persistenz-Nachweis — den ECHTEN
// Save-Coalescer createSaveCoalescer + das ECHTE atomicWrite (src/core/db/atomic-persist.ts)
// gegen eine node:sqlite-Throwaway-DB + Node-fs-Temp-Datei. KEINE zweite Update-Implementierung,
// KEINE Live-/%APPDATA%-DB. Kern: der Updater speichert den aktuellen Stand DURABEL, bevor er
// herunterlaedt/installiert und relaunchet; bei JEDEM Fehler (save/install/relaunch) bricht die
// Kette ab und der Fehler propagiert — kein Install nach Save-Fehler, kein Relaunch nach
// Install-Fehler, kein zweiter Relaunch-Versuch, kein Datenverlust.
// Run: node test/m3/updater-durable-flush.test.ts
import { DatabaseSync } from 'node:sqlite';
import { writeFile, rename, stat, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareAndInstallUpdate, createSingleFlight } from '../../src/core/updater/update-orchestration.ts';
import { createSaveCoalescer, atomicWrite, type FsLike } from '../../src/core/db/atomic-persist.ts';

let pass = 0; const fail: string[] = [];
const check = (c: unknown, m: string) => { if (c) pass++; else fail.push(m); };

(async () => {
  // ═══ 1. Erfolgsreihenfolge: durableSave → downloadAndInstall → relaunch ═══
  {
    const calls: string[] = [];
    await prepareAndInstallUpdate({
      durableSave: async () => { calls.push('save'); },
      downloadAndInstall: async () => { calls.push('download'); },
      relaunch: async () => { calls.push('relaunch'); },
    });
    check(calls.join(',') === 'save,download,relaunch', '1: exakte Reihenfolge save→download→relaunch');
  }

  // ═══ 2. Save noch pending → download/relaunch noch NICHT aufgerufen ═══
  {
    let downloadCalled = false, relaunchCalled = false, settled = false;
    let releaseSave: () => void = () => {};
    const gate = new Promise<void>(r => { releaseSave = r; });
    const p = prepareAndInstallUpdate({
      durableSave: () => gate,
      downloadAndInstall: async () => { downloadCalled = true; },
      relaunch: async () => { relaunchCalled = true; },
    });
    p.then(() => { settled = true; }, () => { settled = true; });
    await new Promise(r => setTimeout(r, 30));
    check(!downloadCalled, '2: downloadAndInstall NICHT aufgerufen solange Save pending');
    check(!relaunchCalled, '2: relaunch NICHT aufgerufen solange Save pending');
    check(!settled, '2: Orchestrierung noch nicht resolved (Save haengt)');
    releaseSave(); await p;
    check(downloadCalled && relaunchCalled, '2: nach Save-Freigabe laufen download+relaunch');
  }

  // ═══ 3. Save schlaegt fehl → download=0, relaunch=0, Fehler propagiert ═══
  {
    let downloadCount = 0, relaunchCount = 0, threw = false;
    try {
      await prepareAndInstallUpdate({
        durableSave: async () => { throw new Error('persist failed (injected)'); },
        downloadAndInstall: async () => { downloadCount++; },
        relaunch: async () => { relaunchCount++; },
      });
    } catch { threw = true; }
    check(threw, '3: Save-Fehler propagiert (nicht verschluckt)');
    check(downloadCount === 0, '3: downloadAndInstall = 0 Aufrufe');
    check(relaunchCount === 0, '3: relaunch = 0 Aufrufe');
  }

  // ═══ 4. Install schlaegt fehl → relaunch=0, Fehler propagiert (Save lief zuerst) ═══
  {
    let saved = false, relaunchCount = 0, threw = false;
    try {
      await prepareAndInstallUpdate({
        durableSave: async () => { saved = true; },
        downloadAndInstall: async () => { throw new Error('install failed (injected)'); },
        relaunch: async () => { relaunchCount++; },
      });
    } catch { threw = true; }
    check(saved, '4: durableSave lief vor dem Install');
    check(threw, '4: Install-Fehler propagiert');
    check(relaunchCount === 0, '4: relaunch = 0 Aufrufe');
  }

  // ═══ 5. Relaunch schlaegt fehl → Fehler propagiert, KEIN zweiter Relaunch-Versuch ═══
  {
    let relaunchCount = 0, threw = false;
    try {
      await prepareAndInstallUpdate({
        durableSave: async () => {},
        downloadAndInstall: async () => {},
        relaunch: async () => { relaunchCount++; throw new Error('relaunch failed (injected)'); },
      });
    } catch { threw = true; }
    check(threw, '5: Relaunch-Fehler propagiert');
    check(relaunchCount === 1, '5: genau EIN Relaunch-Versuch (kein Retry)');
  }

  // ═══ 6. Doppelklick → Single-Flight → KEINE zweite Kette ═══
  {
    let saveCount = 0, downloadCount = 0, relaunchCount = 0;
    let releaseSave: () => void = () => {};
    const gate = new Promise<void>(r => { releaseSave = r; });
    const runOnce = () => prepareAndInstallUpdate({
      durableSave: async () => { saveCount++; await gate; },
      downloadAndInstall: async () => { downloadCount++; },
      relaunch: async () => { relaunchCount++; },
    });
    const guarded = createSingleFlight(runOnce);
    const p1 = guarded();                       // erster Klick → Kette startet, haengt am Save-Gate
    await new Promise(r => setTimeout(r, 10));
    const p2 = guarded();                       // zweiter Klick WAEHREND des Laufs
    check(p1 === p2, '6: zweiter Aufruf liefert dasselbe Promise (Single-Flight)');
    check(saveCount === 1, '6: nur EIN durableSave trotz zwei Klicks');
    releaseSave();
    await p1; await p2;
    check(saveCount === 1 && downloadCount === 1 && relaunchCount === 1, '6: genau EINE save/download/relaunch-Kette');
    const p3 = guarded();                        // nach Abschluss → Guard frei → frischer Durchlauf moeglich
    await p3;
    check(saveCount === 2, '6: nach Abschluss ist ein bewusster Retry moeglich (Guard freigegeben)');
  }

  // ═══ 7. Aktive Ambient-Transaktion → durableSave wirft → Update blockiert ═══
  {
    // saveDatabaseDurably wirft bei aktiver Transaktion (database.ts:2788, M2). Hier mit exakt
    // dieser Guard nachgebildet: aktive Tx → wirft → kein Install/Relaunch.
    const durableSaveWithTxGuard = async () => {
      throw new Error('saveDatabaseDurably darf nicht innerhalb einer aktiven Transaktion aufgerufen werden');
    };
    let downloadCount = 0, relaunchCount = 0; let err: unknown = null;
    try {
      await prepareAndInstallUpdate({
        durableSave: durableSaveWithTxGuard,
        downloadAndInstall: async () => { downloadCount++; },
        relaunch: async () => { relaunchCount++; },
      });
    } catch (e) { err = e; }
    check(err instanceof Error, '7: Update blockiert bei aktiver Transaktion (wirft)');
    check(err instanceof Error && err.message.includes('aktiven Transaktion'), '7: Fehler nennt die aktive Transaktion');
    check(downloadCount === 0 && relaunchCount === 0, '7: kein Install, kein Relaunch bei aktiver Tx');
  }

  // ═══ 8. Vorhandener Save-Coalescer: Updater wartet auf Zustand INKL. aktueller Aenderung ═══
  {
    const mem = new DatabaseSync(':memory:');
    mem.exec('CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT)');
    let releaseA: () => void = () => {};
    const gateA = new Promise<void>(r => { releaseA = r; });
    let call = 0; const persisted: Array<Array<{ id: string }>> = [];
    const coalescer = createSaveCoalescer({
      snapshot: () => new TextEncoder().encode(JSON.stringify(mem.prepare('SELECT * FROM products ORDER BY id').all())),
      persist: async (data: Uint8Array) => { call++; if (call === 1) await gateA; persisted.push(JSON.parse(new TextDecoder().decode(data))); },
    });
    // Exakt der produktive saveDatabaseDurably-Vertrag: requestSave + getLastError-Throw.
    const durableSave = async () => { await coalescer.requestSave(); const e = coalescer.getLastError(); if (e) throw (e instanceof Error ? e : new Error(String(e))); };

    mem.prepare("INSERT INTO products (id,name) VALUES ('BEFORE','b')").run();
    const pA = coalescer.requestSave();          // Save A startet, haengt an gateA
    await new Promise(r => setTimeout(r, 10));
    mem.prepare("INSERT INTO products (id,name) VALUES ('DURING','d')").run(); // Aenderung waehrend Save A

    let installCalled = false, relaunchCalled = false;
    const pUpd = prepareAndInstallUpdate({
      durableSave,
      downloadAndInstall: async () => { installCalled = true; },
      relaunch: async () => { relaunchCalled = true; },
    });
    await new Promise(r => setTimeout(r, 10));
    check(!installCalled, '8: Installation NICHT gestartet, solange Persistenz noch laeuft');
    releaseA();
    await pA; await pUpd;
    check(installCalled && relaunchCalled, '8: Install+Relaunch erst nach vollstaendiger Persistenz');
    const last = persisted[persisted.length - 1] || [];
    check(last.some(r => r.id === 'DURING') && last.some(r => r.id === 'BEFORE'), '8: persistierter Stand enthaelt die aktuelle Aenderung (BEFORE+DURING)');
  }

  // ═══ 9. Tauri-Datei-Persistenznachweis: ECHTES atomicWrite auf Temp-Datei (kein %APPDATA%) ═══
  {
    const dir = join(tmpdir(), 'lataif-m3-' + process.pid);
    await mkdir(dir, { recursive: true });
    const fsAdapter: FsLike = {
      writeFile: (p, d) => writeFile(p, d),
      stat: async (p) => { const s = await stat(p); return { size: s.size, mtime: s.mtime }; },
      rename: (a, b) => rename(a, b),
      remove: (p) => rm(p, { force: true }),
      mkdir: (p, o) => mkdir(p, o).then(() => {}),
    };
    const seedPath = join(dir, 'seed.db');
    const sdb = new DatabaseSync(seedPath); sdb.exec("CREATE TABLE t (id TEXT); INSERT INTO t VALUES ('M3-MARKER')"); sdb.close();
    const goodBytes = new Uint8Array(await readFile(seedPath));
    const finalPath = join(dir, 'lataif.db');

    // Erfolg: durableSave via echtes atomicWrite → resolved ⇒ Datei geschrieben → erst dann Install/Relaunch.
    const calls: string[] = []; let sig: Awaited<ReturnType<typeof atomicWrite>> | null = null;
    await prepareAndInstallUpdate({
      durableSave: async () => { sig = await atomicWrite(fsAdapter, { dir, finalPath, tmpPath: join(dir, 'lataif.db.tmp'), data: goodBytes, baseline: null }); calls.push('save'); },
      downloadAndInstall: async () => { calls.push('download'); },
      relaunch: async () => { calls.push('relaunch'); },
    });
    check(calls.join(',') === 'save,download,relaunch', '9a: echte atomicWrite-Persistenz VOR download+relaunch');
    check(sig != null && sig.size === goodBytes.length, '9a: durableSave resolved ⇒ Persistenzpfad erfolgreich (Signatur korrekt)');
    check(new TextDecoder().decode(await readFile(finalPath)).includes('M3-MARKER'), '9a: finale DB-Datei enthaelt den aktuellen Stand');

    // Fehler: atomicWrite scheitert (rename) → durableSave wirft → kein download/relaunch, gute Datei bleibt.
    const failFs: FsLike = { ...fsAdapter, rename: async () => { throw new Error('rename failed (injected)'); } };
    let dCount = 0, rCount = 0, threw = false;
    try {
      await prepareAndInstallUpdate({
        durableSave: async () => { await atomicWrite(failFs, { dir, finalPath, tmpPath: join(dir, 'lataif.db.tmp2'), data: goodBytes, baseline: sig }); },
        downloadAndInstall: async () => { dCount++; },
        relaunch: async () => { rCount++; },
      });
    } catch { threw = true; }
    check(threw, '9b: Persistenz-Fehler (atomicWrite) propagiert');
    check(dCount === 0 && rCount === 0, '9b: kein download/relaunch bei Persistenz-Fehler');
    check(new TextDecoder().decode(await readFile(finalPath)).includes('M3-MARKER'), '9b: gute DB-Datei unveraendert nach fehlgeschlagenem Save');
    await rm(dir, { recursive: true, force: true });
  }

  const total = pass + fail.length;
  console.log(`\nM3 updater-durable-flush: ${pass}/${total} checks passed`);
  if (fail.length) { console.log('FAILURES:'); for (const f of fail) console.log('  X ' + f); process.exit(1); }
  console.log('OK — durableSave laeuft vor download+relaunch; Save-/Install-/Relaunch-Fehler → kein Weiterlauf; Single-Flight gegen Doppelklick; atomicWrite-Persistenzvertrag haelt.');
})();
