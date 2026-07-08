// D2 atomic-persistence test — reiner Atomic-Write- + Stale-Guard- + Coalescer-Kern.
// Run: node test/d2/atomic-persist.test.ts
// Fährt den Kern über einen Node-fs/promises-Adapter gegen SYNTHETISCHE Temp-Dateien.
// Fasst NIE eine echte lataif.db an (spiegelt das test/f1/b1-Muster: pure Logik, headless).

import {
  mkdtemp, writeFile, readFile, stat, rename, rm, mkdir, access, readdir, utimes,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  atomicWrite,
  createSaveCoalescer,
  StaleWriteError,
  sqliteHeaderOk,
  sigEqual,
  type FsLike,
  type DiskSig,
} from '../../src/core/db/atomic-persist.ts';

let pass = 0;
const fail: string[] = [];
function check(cond: unknown, msg: string): void {
  if (cond) pass++;
  else fail.push(msg);
}
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function threw(fn: () => Promise<unknown>): Promise<unknown> {
  try { await fn(); return null; } catch (e) { return e ?? new Error('threw'); }
}
async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}
async function tmpFilesIn(dir: string, base: string): Promise<string[]> {
  const es = await readdir(dir);
  return es.filter((e) => e.startsWith(base + '.tmp-'));
}

// Node-fs/promises → FsLike. `overrides` injiziert Fehlerfälle (write/rename).
function nodeFs(overrides: Partial<FsLike> = {}): FsLike {
  const base: FsLike = {
    writeFile: (p, d) => writeFile(p, d),
    stat: async (p) => { const s = await stat(p); return { size: s.size, mtime: s.mtime }; },
    rename: (a, b) => rename(a, b),
    remove: (p) => rm(p, { force: true }),
    mkdir: (p, o) => mkdir(p, { recursive: o.recursive }).then(() => undefined),
  };
  return { ...base, ...overrides };
}

// 16-Byte-SQLite-Header ("SQLite format 3" + 0x00) + unterscheidbarer Payload.
function mkData(payload: string): Uint8Array {
  const prefix = new TextEncoder().encode('SQLite format 3'); // 15 Bytes
  const body = new TextEncoder().encode(payload);
  const out = new Uint8Array(16 + body.length);
  out.set(prefix, 0);
  out[15] = 0; // Null-Terminator
  out.set(body, 16);
  return out;
}
function eq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ── Unit: Header- und Signatur-Helfer ──
function testHelpers(): void {
  check(sqliteHeaderOk(mkData('x')) === true, 'H: valid SQLite header accepted');
  check(sqliteHeaderOk(new TextEncoder().encode('NOT a sqlite file...')) === false, 'H: non-SQLite rejected');
  // Byte 15 muss 0x00 sein — ein Space (0x20) an Stelle 15 ist KEIN gültiger Header:
  const spaced = new TextEncoder().encode('SQLite format 3 more'); // Byte 15 = ' '
  check(sqliteHeaderOk(spaced) === false, 'H: space instead of NUL at byte 15 rejected');
  check(sqliteHeaderOk(mkData('')) === true, 'H: bare 16-byte header is valid');

  check(sigEqual({ size: 10, mtimeMs: 5 }, { size: 10, mtimeMs: 5 }) === true, 'H: sigEqual same');
  check(sigEqual({ size: 10, mtimeMs: 5 }, { size: 11, mtimeMs: 5 }) === false, 'H: sigEqual size diff');
  check(sigEqual({ size: 10, mtimeMs: 5 }, { size: 10, mtimeMs: 9 }) === false, 'H: sigEqual mtime diff');
  check(sigEqual({ size: 10, mtimeMs: null }, { size: 10, mtimeMs: 9 }) === true, 'H: sigEqual null-mtime → size-only');
  check(sigEqual(null, { size: 10, mtimeMs: 5 }) === false, 'H: sigEqual null → false');
}

// ── 1) Normal save schreibt die finale Datei (+2 Temp-Nachweis/Cleanup) ──
async function testNormalAndTemp(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'lataif-d2-'));
  const finalPath = join(dir, 'lataif.db');
  const data1 = mkData('one');

  let wroteTo = '';
  const spyFs = nodeFs({ writeFile: async (p, d) => { wroteTo = String(p); return writeFile(p, d); } });
  const sig1 = await atomicWrite(spyFs, { dir, finalPath, tmpPath: finalPath + '.tmp-t-0', data: data1, baseline: null });

  const onDisk = new Uint8Array(await readFile(finalPath));
  check(eq(onDisk, data1), '1: final content matches written data');
  check(sqliteHeaderOk(onDisk), '1: final file has valid SQLite header');
  check(sig1.size === data1.length, '1: returned baseline sig size matches');
  // 2) Temp-Nachweis: geschrieben wurde in einen Temp-Pfad, NIE direkt final; danach kein Temp übrig.
  check(wroteTo.includes('.tmp-'), '2: write targeted a temp path');
  check(wroteTo !== finalPath, '2: never wrote the final path directly');
  check(!(await exists(wroteTo)), '2: temp gone after successful rename');
  check((await tmpFilesIn(dir, 'lataif.db')).length === 0, '2: no leftover temp files after success');

  // Zweiter, aufeinanderfolgender Save (eigene Baseline) darf NICHT als stale gelten.
  const data2 = mkData('two-longer');
  const sig2 = await atomicWrite(spyFs, { dir, finalPath, tmpPath: finalPath + '.tmp-t-1', data: data2, baseline: sig1 });
  check(eq(new Uint8Array(await readFile(finalPath)), data2), '2: sequential own save overwrites cleanly');
  check(sig2.size === data2.length, '2: second baseline sig updated');
}

// ── 3) Write-Fehler zerstört die finale DB nicht ──
async function testWriteErrorKeepsFinal(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'lataif-d2-'));
  const finalPath = join(dir, 'lataif.db');
  const good = mkData('good-existing');
  await writeFile(finalPath, good);
  const baseline = await nodeFs().stat(finalPath).then((s) => ({ size: s.size, mtimeMs: s.mtime ? s.mtime.getTime() : null } as DiskSig));

  const failWrite = nodeFs({ writeFile: async () => { throw new Error('simulated ENOSPC'); } });
  const e = await threw(() => atomicWrite(failWrite, { dir, finalPath, tmpPath: finalPath + '.tmp-e-0', data: mkData('new-bad'), baseline }));
  check(e instanceof Error, '3: write error propagates');
  check(eq(new Uint8Array(await readFile(finalPath)), good), '3: final DB intact after write error');
  check((await tmpFilesIn(dir, 'lataif.db')).length === 0, '3: temp cleaned after write error');
}

// ── 4) Rename/Replace-Fehler lässt die finale DB intakt ──
async function testRenameErrorKeepsFinal(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'lataif-d2-'));
  const finalPath = join(dir, 'lataif.db');
  const good = mkData('good-existing-2');
  await writeFile(finalPath, good);
  const baseline = await nodeFs().stat(finalPath).then((s) => ({ size: s.size, mtimeMs: s.mtime ? s.mtime.getTime() : null } as DiskSig));

  const failRename = nodeFs({ rename: async () => { throw new Error('simulated EPERM rename'); } });
  const e = await threw(() => atomicWrite(failRename, { dir, finalPath, tmpPath: finalPath + '.tmp-r-0', data: mkData('new-bad-2'), baseline }));
  check(e instanceof Error, '4: rename error propagates');
  check(eq(new Uint8Array(await readFile(finalPath)), good), '4: final DB intact after rename error');
  check((await tmpFilesIn(dir, 'lataif.db')).length === 0, '4: temp cleaned after rename error');
}

// ── 5) Stale-write: neuerer/fremder Disk-Stand wird NICHT überschrieben ──
async function testStaleWriteRefused(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'lataif-d2-'));
  const finalPath = join(dir, 'lataif.db');

  // (a) Größen-Divergenz (robust gegen mtime-Auflösung):
  const sigA = await atomicWrite(nodeFs(), { dir, finalPath, tmpPath: finalPath + '.tmp-s-0', data: mkData('v1'), baseline: null });
  const external = mkData('EXTERNAL-NEWER-DIFFERENT-SIZE');
  await writeFile(finalPath, external); // fremder Writer ändert die Datei (andere Größe)
  const eSize = await threw(() => atomicWrite(nodeFs(), { dir, finalPath, tmpPath: finalPath + '.tmp-s-1', data: mkData('ours-v2'), baseline: sigA }));
  check(eSize instanceof StaleWriteError, '5a: size-divergent external change refused (StaleWriteError)');
  check(eq(new Uint8Array(await readFile(finalPath)), external), '5a: newer external state preserved (not clobbered)');

  // (b) Gleiche Größe, aber neuere mtime (erzwungen via utimes → deterministisch):
  const dir2 = await mkdtemp(join(tmpdir(), 'lataif-d2-'));
  const fp2 = join(dir2, 'lataif.db');
  const sigB = await atomicWrite(nodeFs(), { dir: dir2, finalPath: fp2, tmpPath: fp2 + '.tmp-s-0', data: mkData('AAAA'), baseline: null });
  await writeFile(fp2, mkData('BBBB')); // gleiche Länge, anderer Inhalt
  const future = new Date((sigB.mtimeMs ?? 0) + 10000);
  await utimes(fp2, future, future); // mtime klar in die Zukunft → sicher != Baseline
  const eMtime = await threw(() => atomicWrite(nodeFs(), { dir: dir2, finalPath: fp2, tmpPath: fp2 + '.tmp-s-1', data: mkData('CCCC'), baseline: sigB }));
  check(eMtime instanceof StaleWriteError, '5b: same-size newer-mtime external change refused');
  check(eq(new Uint8Array(await readFile(fp2)), mkData('BBBB')), '5b: external same-size state preserved');
}

// ── 6) Coalescing: mehrere Saves → LETZTER Stand persistiert, kein Stale-Regress ──
async function testCoalescing(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'lataif-d2-'));
  const finalPath = join(dir, 'lataif.db');
  let mem = mkData('m1');
  let baseline: DiskSig | null = null;
  let seq = 0;
  let persists = 0;
  const coalescer = createSaveCoalescer({
    snapshot: () => mem,
    persist: async (data) => {
      persists++;
      await delay(5);
      baseline = await atomicWrite(nodeFs(), { dir, finalPath, tmpPath: finalPath + '.tmp-c-' + seq++, data, baseline });
    },
    isReady: () => true,
  });

  const p1 = coalescer.requestSave(); // erfasst m1 synchron im ersten Drain-Tick
  mem = mkData('m2-final-state');      // Mutation, bevor der erste Persist fertig ist
  const p2 = coalescer.requestSave();  // koalesziert in denselben in-flight Drain
  await Promise.all([p1, p2]);
  await coalescer.flush();

  check(eq(new Uint8Array(await readFile(finalPath)), mkData('m2-final-state')), '6: coalesced saves persist the LAST state');
  check(coalescer.getLastError() == null, '6: no error after coalesced saves');
  check(coalescer.isDirty() === false, '6: not dirty after flush');
  check(persists >= 1 && persists <= 2, '6: coalesced into ≤2 persists (not one-per-call storm)');
}

// ── 7) flush() wartet + macht Fehler sichtbar; requestSave() rejectet nie ──
async function testFlushAndErrors(): Promise<void> {
  // 7a: flush wartet auf den pending Save.
  let done = 0;
  const slow = createSaveCoalescer({ snapshot: () => mkData('x'), persist: async () => { await delay(20); done++; } });
  slow.requestSave();
  await slow.flush();
  check(done === 1, '7a: flush awaited the pending save');
  check(slow.getLastError() == null, '7a: no error on clean flush');

  // 7b: flush() wirft den Persist-Fehler nach außen; getLastError() legt ihn offen.
  let onErrCount = 0;
  const boom = createSaveCoalescer({
    snapshot: () => mkData('y'),
    persist: async () => { throw new Error('simulated persist boom'); },
    onError: () => { onErrCount++; },
  });
  // requestSave() darf NICHT rejecten (Fire-and-Forget-Sicherheit — 241 Aufrufer im Code).
  let reqRejected = false;
  await boom.requestSave().catch(() => { reqRejected = true; });
  check(reqRejected === false, '7b: requestSave() does not reject on persist error');
  const fe = await threw(() => boom.flush());
  check(fe instanceof Error, '7b: flush() surfaces the persist error');
  check(boom.getLastError() != null, '7b: getLastError() exposes the error');
  check(onErrCount >= 1, '7b: onError hook fired');

  // 7c: Stale-Konflikt ist fatal → kein Endlos-Retry, aber via flush sichtbar.
  const staleCoalescer = createSaveCoalescer({
    snapshot: () => mkData('z'),
    persist: async () => { throw new StaleWriteError({ size: 1, mtimeMs: 1 }, { size: 2, mtimeMs: 2 }); },
    isFatal: (err) => err instanceof StaleWriteError,
  });
  await staleCoalescer.requestSave();
  check(staleCoalescer.isDirty() === false, '7c: stale conflict does not keep dirty (no spin)');
  const se = await threw(() => staleCoalescer.flush());
  check(se instanceof StaleWriteError, '7c: flush surfaces the stale conflict');
}

async function main(): Promise<void> {
  testHelpers();
  await testNormalAndTemp();
  await testWriteErrorKeepsFinal();
  await testRenameErrorKeepsFinal();
  await testStaleWriteRefused();
  await testCoalescing();
  await testFlushAndErrors();

  const total = pass + fail.length;
  console.log(`\nD2 atomic-persist: ${pass}/${total} checks passed`);
  if (fail.length) {
    console.log('FAILURES:');
    for (const f of fail) console.log('  ✗ ' + f);
    process.exit(1);
  }
  console.log('✓ all D2 persistence checks green');
}

main().catch((e) => { console.error('D2 test crashed:', e); process.exit(1); });
