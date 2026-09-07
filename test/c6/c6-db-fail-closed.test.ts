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
  ok(/if \(!exists\) \{\s*\n\s*lastKnownDiskSig = null;[^\n]*\n\s*return \{ kind: 'missing' \};/.test(db),
    'FIRST-RUN …und nur der Fall "Datei existiert nicht" fuehrt dorthin');

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

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central c6 p1: existing database fails closed: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_C6_EXISTING_DB_LOAD_FAIL_CLOSED_PROVED');
