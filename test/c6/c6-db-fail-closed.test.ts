// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-C6-P1 — eine vorhandene Datenbank, die sich nicht oeffnen laesst, darf NICHT durch
// eine frische ersetzt werden. Run: node test/c6/c6-db-fail-closed.test.ts
//
// Der Weg, um den es geht, hatte drei Stationen und an jeder ging etwas verloren:
//
//   1. `loadSavedDb` machte aus JEDEM Lesefehler ein `null`. Damit war "es gibt keine Datenbank"
//      und "ich komme nicht an sie heran" dieselbe Antwort.
//   2. `initDatabase` las `null` als Erstlauf und legte einen frischen, leeren Bestand an —
//      und selbst wenn die Bytes da waren, aber nicht zu oeffnen: derselbe frische Bestand.
//   3. Der naechste Speichervorgang schrieb genau diesen leeren Bestand an die Stelle der
//      vorhandenen Datei. Der Stale-Guard haelt ihn NICHT auf — das beweist §2 unten an der
//      echten Persistenzschicht.
//
// Station 3 ist die Negativkontrolle: sie zeigt, dass die Persistenz keinerlei Schutz bietet und
// der Riegel deshalb an Station 1/2 sitzen MUSS. Wird er dort entfernt, ist der Datenverlust die
// unmittelbare Folge.
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, writeFileSync, mkdtempSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(join(repo, p), 'utf8').replace(/\r\n/g, '\n');

let PASS = 0; const fails: string[] = [];
const ok = (c: boolean, m: string) => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };

// ── §1 — der Vertrag im echten Quelltext ───────────────────────────────────
{
  const db = read('src/core/db/database.ts');

  // Die drei Zustaende sind benannt, nicht erschlossen.
  ok(/export type LoadedDb =\s*\n\s*\| \{ kind: 'missing' \}\s*\n\s*\| \{ kind: 'bytes'; data: Uint8Array \}\s*\n\s*\| \{ kind: 'unreadable'; reason: string \};/.test(db),
    'LOAD es gibt drei unterscheidbare Antworten: fehlt, Bytes, unlesbar');
  ok(/export class DatabaseRecoveryRequiredError extends Error/.test(db)
    && /readonly code = 'DB_RECOVERY_REQUIRED'/.test(db),
    'LOAD und einen eigenen Fehler, den die Oberflaeche erkennen kann');

  // Eine Datei, die es gibt, die aber nicht lesbar ist → Ende, kein neuer Bestand.
  ok(/if \(saved\.kind === 'unreadable'\) \{\s*\n\s*throw new DatabaseRecoveryRequiredError\(saved\.reason\);\s*\n\s*\}/.test(db),
    'FAIL-CLOSED unlesbar heisst Abbruch, nicht Neuanlage');
  // Auch "Bytes da, aber nicht zu oeffnen" endet auf einem echten Rechner hier.
  ok(/db = null;\s*\n\s*if \(isTauri\(\)\) throw new DatabaseRecoveryRequiredError\(`open failed: \$\{String\(err\)\}`\);/.test(db),
    'FAIL-CLOSED …und ein nicht zu oeffnender Bestand ebenso');
  // Wir konnten nicht einmal fragen, ob es die Datei gibt → Abwesenheit ist unbewiesen.
  ok(/return \{ kind: 'unreadable', reason: `existence check failed: \$\{String\(err\)\}` \};/.test(db),
    'FAIL-CLOSED wer nicht fragen kann, darf Abwesenheit nicht annehmen');

  // Der Erstlauf bleibt, wie er war: NUR eine bewiesen fehlende Datei legt an.
  const elseBranch = db.slice(db.indexOf("  } else {\n    db = new SQL.Database();"), db.indexOf('void triggerStartupMediaRecoverySafe();'));
  ok(/if \(isTauri\(\)\) \{\s*\n\s*await seedCleanDatabase\(db\);/.test(elseBranch),
    'FIRST-RUN eine bewiesen fehlende Datei legt weiterhin den sauberen Bestand an');
  ok(/if \(r\.kind === 'missing'\) \{\s*\n\s*lastKnownDiskSig = null;[^\n]*\n\s*return \{ kind: 'missing' \};/.test(db)
    && /const r = await loadDbFile\(/.test(db),
    'FIRST-RUN …und nur der Fall "Datei existiert nicht" (R7C R4: entschieden von loadDbFile) fuehrt dorthin');

  // Die drei Zustaende teilen sich keinen Ausweg mehr.
  ok(db.indexOf("if (saved.kind === 'unreadable')") < db.indexOf("if (saved.kind === 'bytes')")
    && db.indexOf("if (saved.kind === 'bytes')") < db.indexOf("  } else {\n    db = new SQL.Database();"),
    'SEPARATION unlesbar, vorhanden und fehlend sind drei getrennte Wege');

  // Demodaten gibt es nur noch dort, wo nichts zu verlieren ist.
  const tauriFresh = /isTauri\(\)[^\n]*\n?[^\n]*seedFreshDatabase/.test(db);
  ok(!tauriFresh, 'BOUNDARY kein Demobestand auf einem echten Rechner');

  // Auch der Neuladeweg tauscht nur gegen echte Bytes.
  ok(/if \(saved\.kind !== 'bytes'\) return; \/\/ kein Beweis, kein Tausch/.test(db),
    'RELOAD ohne Bytes kein Tausch und keine neue Epoche');

  // Der Client bleibt unberuehrt: er kommt an diesen Weg gar nicht heran.
  const app = read('src/App.tsx');
  const beforeBoot = app.slice(0, app.indexOf('if (!pending) bootDatabase();'));
  ok(/if \(isClientMode\(\)\) \{/.test(beforeBoot) && !/initDatabase\(\)\s*\n/.test(beforeBoot),
    'CLIENT die Weiche kehrt vor dem Datenbankstart um — der Wiederherstellungsweg ist reine Primary-Sache');
  ok(!read('src/components/startup/ClientShell.tsx').includes('core/db/'),
    'CLIENT …und die Client-Oberflaeche kennt die Datenbankschicht nicht einmal');

  // Und die Oberflaeche sagt, was zu tun ist — ohne selbst etwas wiederherzustellen.
  ok(/DB_RECOVERY_REQUIRED/.test(app) && /Sicherung wieder her/.test(app),
    'UI der Benutzer bekommt den Wiederherstellungsweg gezeigt');
  ok(!/restoreBackup|autoRestore|bestBackup/i.test(app.slice(app.indexOf('DB_RECOVERY_REQUIRED') - 400, app.indexOf('DB_RECOVERY_REQUIRED') + 900)),
    'UI …und es wird nichts still wiederhergestellt');
}

// ── §2 — die Negativkontrolle an der ECHTEN Persistenzschicht ──────────────
//
// Ohne den Riegel oben stuende einem leeren Bestand nichts im Weg: der Stale-Guard laesst ihn
// durch, und `atomicWrite` ersetzt die vorhandene Datei. Genau das wird hier vorgefuehrt.
{
  const { atomicWrite, assertNotStale } = await import('../../src/core/db/atomic-persist.ts');

  const dir = mkdtempSync(join(tmpdir(), 'c6-faildb-'));
  const finalPath = join(dir, 'lataif.db');
  // Eine "echte" Datenbank: gueltiger SQLite-Kopf plus Nutzdaten.
  const header = Buffer.from('SQLite format 3\0', 'binary');
  const real = Buffer.concat([header, Buffer.alloc(4096, 0x41)]);
  writeFileSync(finalPath, real);
  // Und ein frischer, leerer Bestand — genau das, was der alte Weg angelegt haette.
  const empty = Buffer.concat([header, Buffer.alloc(64, 0)]);

  const fs = {
    exists: async (p: string) => existsSync(p),
    readFile: async (p: string) => new Uint8Array(readFileSync(p)),
    writeFile: async (p: string, d: Uint8Array) => { writeFileSync(p, Buffer.from(d)); },
    remove: async () => {},
    rename: async (a: string, b: string) => { writeFileSync(b, readFileSync(a)); },
    mkdir: async () => {},
    stat: async (p: string) => { const st = statSync(p); return { size: st.size, mtime: st.mtime }; },
  };

  // (a) Ohne Grundlinie — genau der Zustand nach einem fehlgeschlagenen Lesen — haelt der
  //     Stale-Guard gar nichts auf.
  let blocked = false;
  try { await assertNotStale(fs as never, finalPath, null); } catch { blocked = true; }
  ok(!blocked, 'NEGATIVKONTROLLE ohne Grundlinie prueft der Stale-Guard nichts');

  // (b) Und dann schreibt `atomicWrite` den leeren Bestand ueber die vorhandene Datei.
  await atomicWrite(fs as never, {
    dir, finalPath, tmpPath: finalPath + '.tmp', data: new Uint8Array(empty), baseline: null,
  });
  const after = readFileSync(finalPath);
  ok(after.length === empty.length && !after.equals(real),
    `NEGATIVKONTROLLE der leere Bestand ersetzt die vorhandene Datei (${real.length}B → ${after.length}B)`);
  ok(true, 'NEGATIVKONTROLLE also schuetzt die Persistenz NICHT — der Riegel muss beim Laden sitzen');
}

// ── §3 — POST-PARITY R7C R4: das ECHTE Lademodul an echten Dateien ─────────
//
// `loadDbFile` ist die Entscheidung fehlt / Bytes / unlesbar, die `loadSavedDb` am Primary trifft
// (mit Tauri plugin-fs; hier mit Node `fs` an einem Temp-Verzeichnis). `unreadable` endet in
// `initDatabase` VOR Schema, Migration oder Speichern im Wiederherstellungsweg (§1).
{
  const { loadDbFile } = await import('../../src/core/db/db-file-load.ts');
  const initSqlJs = (await import('sql.js')).default;
  const SQL = await initSqlJs({ locateFile: (f: string) => join(repo, 'node_modules/sql.js/dist', f) });
  const nodeFs = {
    exists: async (p: string) => existsSync(p),
    readFile: async (p: string) => new Uint8Array(readFileSync(p)),
    stat: async (p: string) => { const st = statSync(p); return { size: st.size, mtime: st.mtime }; },
  };
  const dir = mkdtempSync(join(tmpdir(), 'r7c-r4-'));

  // (a) Eine vorhandene 0-Byte-Datei: unlesbar, und sie bleibt, wie sie ist.
  const empty = join(dir, 'lataif-empty.db');
  writeFileSync(empty, new Uint8Array(0));
  const before = statSync(empty);
  const r0 = await loadDbFile(nodeFs, empty);
  const after = statSync(empty);
  ok(r0.kind === 'unreadable' && /0 bytes/.test((r0 as { reason: string }).reason),
    `R4 eine vorhandene 0-Byte-lataif.db ist unlesbar → DB_RECOVERY_REQUIRED, kein leerer Neuanfang (${JSON.stringify(r0)})`);
  ok(existsSync(empty) && after.size === 0 && after.mtimeMs === before.mtimeMs,
    'R4 …und die Datei bleibt unverändert (0 Byte, gleiche Änderungszeit — nichts neu erstellt, überschrieben, gelöscht)');

  // (b) Eine fehlende Datei — auch in einem noch nicht angelegten Ordner — erlaubt den Erststart.
  const r1 = await loadDbFile(nodeFs, join(dir, 'lataif.db'));
  const r2 = await loadDbFile(nodeFs, join(dir, 'noch-nicht-da', 'lataif.db'));
  ok(r1.kind === 'missing' && r2.kind === 'missing', 'R4 eine nachweislich fehlende Datei (auch ohne Ordner) → Erststart erlaubt');

  // (c) Ein gültiger Bestand bleibt lesbar, Byte für Byte.
  const good = new SQL.Database();
  good.run("CREATE TABLE t (a TEXT); INSERT INTO t VALUES ('bestand')");
  const goodBytes = good.export();
  const goodPath = join(dir, 'lataif-good.db');
  writeFileSync(goodPath, goodBytes);
  const r3 = await loadDbFile(nodeFs, goodPath);
  const reopened = r3.kind === 'bytes' ? new SQL.Database(r3.data) : null;
  ok(r3.kind === 'bytes' && r3.data.length === goodBytes.length && r3.sig?.size === goodBytes.length
    && String(reopened?.exec('SELECT a FROM t')[0]?.values[0][0]) === 'bestand',
    'R4 ein gültiger Bestand wird gelesen und bleibt lesbar (mit Stale-Guard-Grundlinie)');

  // (d) Ein Lesefehler ist kein Beweis für eine fehlende Datei.
  const deny = (msg: string) => ({ ...nodeFs, exists: async () => false, stat: async () => { throw new Error(msg); } });
  const rDenied = await loadDbFile(deny('failed to get metadata of path: Access is denied. (os error 5)'), goodPath);
  const rNotFoundWin = await loadDbFile(deny('failed to get metadata of path: The system cannot find the file specified. (os error 2)'), goodPath);
  const rNoPathWin = await loadDbFile(deny('The system cannot find the path specified. (os error 3)'), goodPath);
  ok(rDenied.kind === 'unreadable' && /absence not proven/.test((rDenied as { reason: string }).reason),
    'R4 „exists: nein" + Metadaten verweigert (os error 5) → unlesbar, KEIN Erststart');
  ok(rNotFoundWin.kind === 'missing' && rNoPathWin.kind === 'missing', 'R4 nur „nicht gefunden" (os error 2 / 3) gilt als fehlend');
  const rExistsThrows = await loadDbFile({ ...nodeFs, exists: async () => { throw new Error('forbidden path'); } }, goodPath);
  ok(rExistsThrows.kind === 'unreadable' && /existence check failed/.test((rExistsThrows as { reason: string }).reason),
    'R4 wer nicht fragen kann, darf Abwesenheit nicht annehmen');
  const rReadFails = await loadDbFile({ ...nodeFs, readFile: async () => { throw new Error('sharing violation (os error 32)'); } }, goodPath);
  ok(rReadFails.kind === 'unreadable', 'R4 eine vorhandene, nicht lesbare Datei → unlesbar');
  const rLateFound = await loadDbFile({ ...nodeFs, exists: async () => false }, goodPath);
  ok(rLateFound.kind === 'bytes', 'R4 sagt „exists" nein, findet die Nachfrage sie doch → sie wird gelesen, nicht ersetzt');

  // (e) Die Verdrahtung: loadSavedDb nutzt genau dieses Modul, und „unlesbar" endet vor dem Schema.
  const dbSrc = read('src/core/db/database.ts');
  ok(/const \{ loadDbFile \} = await import\('\.\/db-file-load'\);/.test(dbSrc)
    && dbSrc.indexOf("if (saved.kind === 'unreadable')") < dbSrc.indexOf('db.run(SCHEMA);'),
    'R4 loadSavedDb entscheidet über loadDbFile; initDatabase bricht bei „unlesbar" VOR Schema/Migration ab');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central c6 p1: existing database fails closed: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_C6_EXISTING_DB_LOAD_FAIL_CLOSED_PROVED');
