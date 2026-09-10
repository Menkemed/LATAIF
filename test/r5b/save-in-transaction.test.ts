// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R5B FINAL — nie ein Abbild aus einer offenen Transaktion.
// Run: node test/r5b/save-in-transaction.test.ts
//
// Gemessen im Zwei-Rechner-Lauf: eine Kommission vom zweiten Rechner scheiterte an ihrem Bild —
// und trotzdem stand danach ein Artikel „in Kommission" ohne Kommission in der Datenbank. Die
// Ursache war nicht der Anlageweg, sondern der Speicherdurchlauf: ein Speichern von VOR der
// Transaktion lief noch, als der Fernauftrag sein BEGIN setzte, und zog dann sein Abbild
// (`db.export()`). In sql.js beendet das die offene Transaktion STILL — alles danach lief ohne
// Klammer, und das ROLLBACK des Auftrags ging ins Leere.
//
// Hier wird die Regel am Kern bewiesen: solange eine Transaktion offen ist, wird NICHT exportiert;
// der Stand bleibt „schmutzig" und wird geschrieben, sobald sie vorbei ist.
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { createSaveCoalescer } = await import('../../src/core/db/atomic-persist.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };

// ── 1) Der Kern: ein Durchlauf, der während einer Transaktion ankommt ─────
{
  let tx = false;
  let snapshots = 0;
  const persisted: number[] = [];
  let release!: () => void;
  let firstPersist = true;
  const saver = createSaveCoalescer({
    snapshot: () => { snapshots += 1; if (tx) throw new Error('EXPORT IN OPEN TRANSACTION'); return new Uint8Array([snapshots]); },
    persist: async (data) => {
      if (firstPersist) { firstPersist = false; await new Promise<void>((r) => { release = r; }); }
      persisted.push(data[0]);
    },
    isReady: () => !tx,
  });

  // Ein Speichern von VOR der Transaktion läuft (sein Schreiben hängt noch) …
  const erster = saver.requestSave();
  await null; await null;
  // … eine weitere Änderung ausserhalb, dann beginnt eine Transaktion (ein Fernauftrag).
  void saver.requestSave();
  tx = true;
  release();
  await erster;
  ok(snapshots === 1, `KERN während der offenen Transaktion wird KEIN weiteres Abbild gezogen (${snapshots})`);
  ok(saver.isDirty(), 'KERN …der Stand bleibt als ungeschrieben markiert');

  // Die Transaktion ist vorbei (COMMIT) → der nächste Speicherpunkt schreibt den Stand.
  tx = false;
  await saver.requestSave();
  ok(snapshots === 2 && persisted.length === 2 && !saver.isDirty(),
    `KERN nach der Transaktion wird der Stand geschrieben (${snapshots}/${persisted.length})`);
}

// ── 2) Gegenprobe: ohne die Sperre zöge derselbe Ablauf das Abbild MITTEN in der Transaktion ──
{
  let tx = false;
  let exportInTx = 0;
  let release!: () => void;
  let firstPersist = true;
  const saver = createSaveCoalescer({
    snapshot: () => { if (tx) exportInTx += 1; return new Uint8Array([1]); },
    persist: async () => {
      if (firstPersist) { firstPersist = false; await new Promise<void>((r) => { release = r; }); }
    },
    isReady: () => true, // die alte Regel: nur „gibt es eine Datenbank?"
  });
  const erster = saver.requestSave();
  await null; await null;
  void saver.requestSave();
  tx = true;
  release();
  await erster;
  ok(exportInTx === 1, `CONTROL ohne die Sperre wird mitten in der Transaktion exportiert (${exportInTx}) — genau der gemessene Fehler`);
}

// ── 3) Die Regel sitzt an der EINEN Stelle, an der die Datenbank geschrieben wird ──
{
  const db = readFileSync(resolvePath(repo, 'src/core/db/database.ts'), 'utf8');
  ok(/isReady: \(\) => db !== null && !isTransactionActive\(\),/.test(db),
    'STELLE der Speicherdurchlauf der Geschäftsdatenbank exportiert nie aus einer offenen Transaktion');
  ok(/if \(saver\.isDirty\(\)\) throw new Error\('the durable save was deferred by an open transaction'\);/.test(db),
    'STELLE …und ein durables Speichern, das dadurch nicht schrieb, meldet sich nicht als durabel');
}

// ── 4) Kein fremder Schreibvorgang mitten in einer Transaktion ────────────
// Gemessen: der Zeitgeber-Sync schrieb neben der Warteschlange in die Datenbank, auch mitten in
// einen Fernauftrag hinein. Er läuft jetzt IM exklusiven Platz — und das Anwenden von Operationen
// verlässt seine Transaktionsebene wieder, statt den Zähler hängen zu lassen oder die Klammer eines
// anderen Vorgangs zurückzusetzen.
{
  const sync = readFileSync(resolvePath(repo, 'src/core/sync/sync-service.ts'), 'utf8');
  const lauf = sync.slice(sync.indexOf('export function syncNow'), sync.indexOf('// ── Auto-sync ──'));
  ok(/await runExclusive\(async \(\) => \{\s*const pushed = await pushChanges\(\);\s*const pulled = await pullChanges\(\);/.test(lauf),
    'SYNC Push, Pull und Operationen laufen im exklusiven Platz — nie zwischen den Phasen eines Fernauftrags');
  ok(/import \{ runExclusive \} from '\.\.\/bridge\/command-scheduler';/.test(sync), 'SYNC …über DIESELBE Warteschlange wie jede Buchung');
  const ops = readFileSync(resolvePath(repo, 'src/core/operations/service.ts'), 'utf8');
  const apply = ops.slice(ops.indexOf('function applyOneEnvelope'), ops.indexOf('/** Pull every accepted operation'));
  ok(/if \(leaveNestedTransaction\(\) && shouldCommit\) db\.run\('COMMIT'\);/.test(apply),
    'OPS das Anwenden verlässt seine Transaktionsebene auch bei Erfolg');
  ok(/if \(shouldCommit\) \{\s*try \{ db\.run\('ROLLBACK'\); \}[\s\S]{0,80}resetTransactionContext\(\);\s*\}/.test(apply),
    'OPS …und nur die äußerste Ebene rollt zurück und setzt den Zähler zurück');
}

// ── 5) Verhalten: der Zähler bleibt nach dem Anwenden ausgeglichen ────────
{
  const tc = await import('../../src/core/db/transaction-context.ts');
  tc.resetTransactionContext();
  // Dieselbe Folge wie im Anwenden: betreten, arbeiten, verlassen — einmal außen, einmal innen.
  const aussen = tc.enterTransaction();
  const innen = tc.enterTransaction();
  ok(aussen === true && innen === false, 'ZAEHLER außen ist äußerste Ebene, innen nicht');
  ok(tc.leaveNestedTransaction() === false && tc.isTransactionActive(), 'ZAEHLER die innere Ebene verlassen: die äußere bleibt offen');
  ok(tc.leaveNestedTransaction() === true && !tc.isTransactionActive(), 'ZAEHLER die äußere verlassen: nichts bleibt hängen');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central ui parity r5b: no export from an open transaction: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R5B_NO_EXPORT_IN_OPEN_TRANSACTION_PROVED');
