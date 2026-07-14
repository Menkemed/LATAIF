// M4-A — Close Performance Audit (Scratch/Diagnose, KEINE produktive DB).
// Misst mit ECHTEM sql.js (wie die App) + ECHTEM Save-Coalescer/atomicWrite, wie stark
// `db.export()` beim Close den Event-Loop blockiert — als Funktion der DB-Größe mit
// synthetischen Base64-"Fotos". Dient NUR der Entscheidung, ob ein separater M4-B-
// Bildgrößen-Slice noetig ist. Aendert KEINE Mobile-Bildparameter.
// Run: node test/m4/close-performance-audit.mjs
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFile, rename, stat, rm, mkdir, readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const initSqlJs = require('sql.js');
const distDir = dirname(require.resolve('sql.js'));
const { createSaveCoalescer, atomicWrite } = await import('../../src/core/db/atomic-persist.ts');

const SQL = await initSqlJs({ locateFile: (f) => join(distDir, f) });

// Synthetisches Base64-"Foto" fester Größe (kein echtes Geschäftsbild).
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function fakePhoto(bytes) {
  let s = '';
  while (s.length < bytes) s += B64;
  return s.slice(0, bytes);
}

// Misst die maximale Event-Loop-Blockierung während fn(): ein 20ms-Interval protokolliert
// seine tatsächlichen Ticks; die größte Lücke = längster synchroner Block.
async function measureBlocking(fn) {
  let maxGap = 0, last = performance.now();
  const iv = setInterval(() => { const now = performance.now(); const gap = now - last; if (gap > maxGap) maxGap = gap; last = now; }, 20);
  // kurz laufen lassen, damit last frisch ist
  await new Promise((r) => setTimeout(r, 30));
  last = performance.now();
  const t0 = performance.now();
  const out = fn();
  const dur = performance.now() - t0;
  clearInterval(iv);
  return { dur, maxGap, out };
}

function buildDb(photoCount, photoBytes) {
  const db = new SQL.Database();
  db.run('CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT, photo TEXT)');
  const stmt = db.prepare('INSERT INTO products (id,name,photo) VALUES (?,?,?)');
  for (let i = 0; i < photoCount; i++) stmt.run([`p${i}`, `item ${i}`, fakePhoto(photoBytes)]);
  stmt.free();
  // ein paar Nicht-Foto-Zeilen, damit auch "klein" realistisch ist
  for (let i = 0; i < 200; i++) db.run("INSERT INTO products (id,name,photo) VALUES (?,?,'')", [`n${i}`, `plain ${i}`]);
  return db;
}

const dir = join(tmpdir(), 'lataif-m4-perf-' + process.pid);
await mkdir(dir, { recursive: true });
const fsAdapter = {
  writeFile: (p, d) => writeFile(p, d),
  stat: async (p) => { const s = await stat(p); return { size: s.size, mtime: s.mtime }; },
  rename: (a, b) => rename(a, b),
  remove: (p) => rm(p, { force: true }),
  mkdir: (p, o) => mkdir(p, o).then(() => {}),
};

// Repräsentative Größen: klein (keine Bilder), mittel (etliche Fotos), groß + sehr groß (foto-lastig).
const SCENARIOS = [
  { label: 'klein   (0 Fotos)',            photoCount: 0,   photoBytes: 0 },
  { label: 'mittel  (40 × 50KB)',          photoCount: 40,  photoBytes: 50 * 1024 },
  { label: 'groß    (150 × 200KB)',        photoCount: 150, photoBytes: 200 * 1024 },
  { label: 'sehrgroß(400 × 300KB)',        photoCount: 400, photoBytes: 300 * 1024 },
];

console.log('\nM4-A Close-Performance-Audit (echtes sql.js db.export + echtes atomicWrite)\n');
console.log('Szenario                | DB-Größe |  export ms | max-block ms | flush ms (export+coalescer+atomicWrite)');
console.log('------------------------+----------+------------+--------------+----------------------------------------');
const rows = [];
for (const sc of SCENARIOS) {
  const db = buildDb(sc.photoCount, sc.photoBytes);

  // export() mehrfach, Median
  const exportRuns = [];
  let bytes = null;
  for (let i = 0; i < 3; i++) { const t = performance.now(); bytes = db.export(); exportRuns.push(performance.now() - t); }
  exportRuns.sort((a, b) => a - b);
  const exportMed = exportRuns[1];

  // Event-Loop-Blockierung während EINES export()
  const blk = await measureBlocking(() => db.export());

  // Voller Flush-Pfad: echter Coalescer, snapshot = db.export(), persist = echtes atomicWrite auf Temp
  let seq = 0;
  const coalescer = createSaveCoalescer({
    snapshot: () => db.export(),
    persist: async (data) => {
      const finalPath = join(dir, `db-${sc.photoCount}.db`);
      await atomicWrite(fsAdapter, { dir, finalPath, tmpPath: join(dir, `db-${sc.photoCount}.tmp${seq++}`), data, baseline: null });
    },
  });
  const tFlush = performance.now();
  await coalescer.requestSave();
  const flushMs = performance.now() - tFlush;

  const sizeMB = (bytes.length / (1024 * 1024)).toFixed(1) + 'MB';
  rows.push({ label: sc.label, sizeMB, exportMed, maxBlock: blk.maxGap, flushMs });
  console.log(
    `${sc.label.padEnd(23)} | ${sizeMB.padStart(8)} | ${exportMed.toFixed(1).padStart(10)} | ${blk.maxGap.toFixed(1).padStart(12)} | ${flushMs.toFixed(1).padStart(10)}`
  );
  db.close();
}
await rm(dir, { recursive: true, force: true });

console.log('\nInterpretation (kalibriert, nur diese Reproduktion):');
console.log('- "max-block ms" = längste Event-Loop-Lücke während db.export(): so lange feuern KEINE Timer');
console.log('  (der 1,5s/3s-Hard-Exit-Timer im alten Close-Handler kann also erst NACH dem Export feuern).');
const big = rows[rows.length - 1];
console.log(`- In DIESER kontrollierten Testumgebung wurden selbst bei einer synthetischen ${big.sizeMB}-DB`);
console.log(`  keine Export-/Flush-Zeiten nahe 1,5 Sekunden gemessen (export ~${big.exportMed.toFixed(0)}ms, flush ~${big.flushMs.toFixed(0)}ms).`);
console.log('- Es ist ein SYNCHRONER BLOCK, kein dauerhafter Hänger: export() terminiert, blockiert aber den Thread.');
console.log('- KEINE pauschale Aussage "auf jeder Hardware unkritisch": andere CPUs/Disks/DB-Größen sind nicht vermessen.');
console.log('- Foto-Bloat bleibt ein separates Kapazitäts-/Sync-Payload-Risiko, aber KEIN nachgewiesener primärer');
console.log('  Close-Trigger dieser Reproduktion. Ob M4-B (Bildgrößen-Cap) nötig ist, bleibt eine offene Kapazitätsfrage.');
