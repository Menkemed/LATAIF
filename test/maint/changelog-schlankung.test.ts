// ════════════════════════════════════════════════════════════════════════════
// A2-STUFE-1 — Wartungswerkzeug scripts/maint/changelog-schlankung.mjs, nur in Sandbox-Ordnern
// (%TEMP% = C: und ein temporärer Ordner auf dem Laufwerk des Repos = E:, damit „zwei Laufwerke" echt geprüft
// wird). Kein produktiver Pfad. Die Prozessprüfung ist auf eine nicht existierende Köder-exe beschränkt
// (`--nur-pfad`), damit eine laufende echte App die Probe weder stört noch berührt.
// Run: node test/maint/changelog-schlankung.test.ts
// ════════════════════════════════════════════════════════════════════════════
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { ownPushedCounts, provenOwnPrefix } from '../../src/core/sync/cursor-store.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const TOOL = join(repo, 'scripts', 'maint', 'changelog-schlankung.mjs');
const BACKUP = join(repo, 'scripts', 'maint', 'manuelle-sicherung.mjs');
let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };

const boxC = mkdtempSync(join(tmpdir(), 'lataif-a2-test-'));
const boxE = mkdtempSync(join(repo, '.tmp-a2-test-'));
if (parse(boxC).root.toLowerCase() === parse(boxE).root.toLowerCase()) { console.log('SKIP — Repo und %TEMP% liegen auf demselben Laufwerk'); process.exit(0); }
const DECOY = join(boxC, 'bin', 'lataif.exe');
const UUID = 'e3b0c442-98fc-4c14-9afb-f4c8996fb924';
const FP = createHash('sha256').update(Buffer.concat([Buffer.from('lataif/server-identity/v1\0'), Buffer.from(UUID)])).digest('hex').slice(0, 32);

function run(script: string, args: string[], env: Record<string, string> = {}): { code: number; out: any } {
  try {
    const s = execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    return { code: 0, out: JSON.parse(s) };
  } catch (e: any) {
    const txt = String(e.stdout || '') || String(e.stderr || '');
    let out: any = null; try { out = JSON.parse(txt); } catch { out = { raw: txt.slice(0, 400) }; }
    return { code: e.status ?? 1, out };
  }
}
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
function treeHash(root: string): string {
  const h = createHash('sha256');
  const rec = (d: string, rel: string) => { for (const n of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(d, n.name); const r = `${rel}/${n.name}`;
    if (n.isDirectory()) rec(p, r); else { h.update(r); h.update(readFileSync(p)); }
  } };
  rec(root, '');
  return h.digest('hex');
}
/** Lesen nur über eine Kopie (ein Öffnen im Datenordner könnte -wal/-shm anlegen). */
function lese<T>(file: string, fn: (db: DatabaseSync) => T): T {
  const t = mkdtempSync(join(tmpdir(), 'lataif-a2-lese-'));
  try {
    for (const s of ['', '-wal', '-shm']) if (existsSync(file + s)) copyFileSync(file + s, join(t, 'x.db' + s));
    const db = new DatabaseSync(join(t, 'x.db'));
    try { return fn(db); } finally { db.close(); }
  } finally { rmSync(t, { recursive: true, force: true }); }
}
const cl = (file: string) => lese(file, (db) => db.prepare('SELECT id, table_name, record_id, action, data FROM sync_changelog ORDER BY id').all() as Array<Record<string, any>>);
const dump = (file: string, sql: string) => lese(file, (db) => JSON.stringify(db.prepare(sql).all()));

const vec = (seed: number, n = 400) => JSON.stringify(Array.from({ length: n }, (_, i) => Math.round(Math.sin(seed * 977 + i) * 1e8) / 1e8));
const INLINE = JSON.stringify(['data:image/jpeg;base64,' + 'QUJD'.repeat(500)]);

/** Eine kleine, aber echte Welt: Primary + Server mit gespiegelter Historie, ein fremder Server-Eintrag, Cursor am Ende. */
function welt(tag: string): { DATA: string; C: string; E: string } {
  const DATA = join(boxC, tag, 'Data'); const C = join(boxC, tag, 'B'); const E = join(boxE, tag);
  mkdirSync(DATA, { recursive: true }); mkdirSync(C, { recursive: true }); mkdirSync(E, { recursive: true });
  writeFileSync(join(DATA, 'sync_install_id.key'), UUID + '\n');
  const p = new DatabaseSync(join(DATA, 'lataif.db'));
  p.exec(`CREATE TABLE sync_changelog (id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT NOT NULL, record_id TEXT NOT NULL, branch_id TEXT,
            action TEXT NOT NULL, data TEXT, synced INTEGER DEFAULT 0, created_at TEXT);
          CREATE TABLE sync_cursor (server_fingerprint TEXT PRIMARY KEY, last_sync_id INTEGER NOT NULL, updated_at TEXT);
          CREATE TABLE products (id TEXT PRIMARY KEY, sku TEXT, images TEXT, image_embedding TEXT);
          CREATE TABLE audit_log (id TEXT PRIMARY KEY, field_name TEXT, new_value TEXT);
          CREATE TABLE invoices (id TEXT PRIMARY KEY, invoice_number TEXT);
          CREATE TABLE payments (id TEXT PRIMARY KEY, amount REAL);`);
  p.prepare('INSERT INTO products VALUES (?,?,?,?)').run('p1', 'SKU-1', '[]', vec(11));
  p.prepare('INSERT INTO products VALUES (?,?,?,?)').run('p2', 'SKU-2', INLINE, vec(12));
  p.prepare('INSERT INTO audit_log VALUES (?,?,?)').run('a1', 'imageEmbedding', vec(11));
  p.exec("INSERT INTO invoices VALUES ('i1','SRINV-2026-000012'); INSERT INTO payments VALUES ('pay1', 25);");
  const s = new DatabaseSync(join(DATA, 'lataif_sync_server.db'));
  s.exec(`PRAGMA journal_mode=WAL;
          CREATE TABLE sync_changelog (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, branch_id TEXT NOT NULL, table_name TEXT NOT NULL,
            record_id TEXT NOT NULL, action TEXT NOT NULL, data TEXT NOT NULL, user_id TEXT NOT NULL, created_at TEXT NOT NULL,
            record_revision INTEGER, operation_id TEXT, protocol_version INTEGER);`);
  const eigen = [
    ['products', 'p1', 'insert', JSON.stringify({ id: 'p1', sku: 'SKU-1', images: '[]', planned_sale_price: 150, image_embedding: vec(1) })],
    ['products', 'p1', 'update', JSON.stringify({ id: 'p1', sku: 'SKU-1', images: '[]', planned_sale_price: 160, image_embedding: vec(1) })],
    ['products', 'p2', 'insert', JSON.stringify({ id: 'p2', sku: 'SKU-2', images: INLINE, image_embedding: vec(2) })],
    ['products', 'p2', 'update', JSON.stringify({ id: 'p2', sku: 'SKU-2', images: INLINE, image_embedding: null })],
    ['invoices', 'i1', 'insert', JSON.stringify({ id: 'i1', invoice_number: 'RPINV-2026-000011' })],
    ['products', 'p1', 'update', JSON.stringify({ id: 'p1', sku: 'SKU-1', images: '[]', planned_sale_price: 170 })],   // Weg A: ohne Feld
  ];
  const pIns = p.prepare("INSERT INTO sync_changelog (table_name, record_id, branch_id, action, data, synced, created_at) VALUES (?,?,'branch-main',?,?,1,'2026-11-01')");
  const sIns = s.prepare("INSERT INTO sync_changelog (tenant_id, branch_id, table_name, record_id, action, data, user_id, created_at) VALUES ('tenant-1','branch-main',?,?,?,?,'self-desktop','2026-11-01')");
  eigen.forEach((e, i) => {
    pIns.run(e[0], e[1], e[2], e[3]);
    sIns.run(e[0], e[1], e[2], e[3]);
    if (i === 1) sIns.run('products', 'p9', 'insert', JSON.stringify({ id: 'p9', sku: 'SKU-9', image_embedding: vec(9) }));  // fremd (Handy)
  });
  const max = Number((s.prepare('SELECT MAX(id) AS m FROM sync_changelog').get() as { m: number }).m);
  p.prepare('INSERT INTO sync_cursor VALUES (?,?,?)').run(FP, max, '2026-11-17T00:00:00.000Z');
  p.close(); s.close();
  return { DATA, C, E };
}
const sichern = (w: { DATA: string; C: string; E: string }, name: string) =>
  run(BACKUP, ['sichern', '--quelle', w.DATA, '--ziel', w.C, '--ziel', w.E, '--name', name, '--ruhe-sekunden', '1', '--nur-pfad', DECOY]);
const ausfuehren = (w: { DATA: string; C: string; E: string }, name: string, env: Record<string, string> = {}, sicherungen?: string[]) =>
  run(TOOL, ['ausfuehren', '--daten', w.DATA, ...(sicherungen ?? [join(w.C, name), join(w.E, name)]).flatMap((x) => ['--sicherung', x]),
    '--bestaetigen', name, '--nur-pfad', DECOY], env);
const pP = (w: { DATA: string }) => join(w.DATA, 'lataif.db');
const pS = (w: { DATA: string }) => join(w.DATA, 'lataif_sync_server.db');
const LOCK = (w: { DATA: string }) => join(w.DATA, 'WARTUNG-LAEUFT.lock');
const sperre = (w: { DATA: string }) => (existsSync(LOCK(w)) ? JSON.parse(readFileSync(LOCK(w), 'utf8')).stand : null);
const unberuehrt = (w: { DATA: string }) => dump(pP(w), 'SELECT * FROM products ORDER BY id') + dump(pP(w), 'SELECT * FROM audit_log')
  + dump(pP(w), 'SELECT * FROM invoices') + dump(pP(w), 'SELECT * FROM payments') + dump(pP(w), 'SELECT * FROM sync_cursor');
const ohne = (d: string) => { const o = JSON.parse(d); delete o.image_embedding; return JSON.stringify(o); };
function eigenerAnfang(w: { DATA: string }): number {
  const server = cl(pS(w)).map((r) => ({ id: Number(r.id), table_name: r.table_name, record_id: r.record_id, action: r.action, data: r.data }));
  const own = lese(pP(w), (db) => ownPushedCounts({ exec: (sql: string) => { const rows = db.prepare(sql).all() as Array<Record<string, unknown>>; return rows.length ? [{ columns: Object.keys(rows[0]), values: rows.map((r) => Object.values(r)) }] : []; } } as never));
  return provenOwnPrefix(server, own).count;
}

try {
  // ── 1) prüfen: Plan, nichts geschrieben ─────────────────────────────────────────────────
  const A = welt('a');
  const vorA = treeHash(A.DATA);
  const pr = run(TOOL, ['pruefen', '--daten', A.DATA, '--nur-pfad', DECOY]);
  ok(pr.code === 0 && pr.out.ok && pr.out.primary.zuAendern === 4 && pr.out.server.zuAendern === 5 && pr.out.gepaart === 6 && pr.out.nurServer === 1,
    `prüfen: Primary 4, Server 5 (inkl. fremdem) zu verschlanken, 6 Paare, 1 nur Server (${JSON.stringify(pr.out).slice(0, 220)})`);
  ok(treeHash(A.DATA) === vorA, 'prüfen: Datenordner byte-gleich (liest nur eine Kopie)');

  // ── 2) Ablehnungen — jeweils nichts geschrieben ─────────────────────────────────────────
  ok(sichern(A, '2026-11-18_a2-test-a').code === 0, 'Sicherung a auf C: und E: erstellt');
  const vorA2 = treeHash(A.DATA);
  const r0 = run(TOOL, ['ausfuehren', '--daten', A.DATA, '--bestaetigen', '2026-11-18_a2-test-a', '--nur-pfad', DECOY]);
  ok(r0.code !== 0 && /zwei --sicherung/.test(r0.out.abbruch), 'ohne Sicherungen: abgelehnt');
  const r1 = ausfuehren(A, '2026-11-18_a2-test-a', {}, [join(A.C, '2026-11-18_a2-test-a'), join(A.C, '2026-11-18_a2-test-a')]);
  ok(r1.code !== 0 && /demselben Laufwerk/.test(r1.out.abbruch), 'zwei Sicherungen auf demselben Laufwerk: abgelehnt');
  const r2 = ausfuehren(A, 'falscher-name-xyz');
  ok(r2.code !== 0, 'falscher Bestätigungsname: abgelehnt');
  ok(treeHash(A.DATA) === vorA2, 'Ablehnungen: Datenordner unverändert');
  // Nach der Sicherung noch geschrieben → nicht mehr frisch.
  { const p = new DatabaseSync(pP(A)); p.exec("UPDATE payments SET amount = 26"); p.close(); }
  const r3 = ausfuehren(A, '2026-11-18_a2-test-a');
  ok(r3.code !== 0 && /weichen ab/.test(r3.out.abbruch), `Sicherung nicht mehr frisch: abgelehnt (${String(r3.out.abbruch).slice(0, 80)})`);
  ok(sperre(A) === null, 'Abbruch vor dem ersten Schreiben: die eigene Wartungssperre ist wieder entfernt');
  // Cursor nicht am Ende / ungesendeter eigener Eintrag → Vorbedingungen.
  const B = welt('b');
  { const p = new DatabaseSync(pP(B)); p.exec('UPDATE sync_cursor SET last_sync_id = last_sync_id - 1'); p.close(); }
  sichern(B, '2026-11-18_a2-test-b');
  const vorB = treeHash(B.DATA);
  const r4 = ausfuehren(B, '2026-11-18_a2-test-b');
  ok(r4.code !== 0 && /Cursor/.test(r4.out.abbruch) && treeHash(B.DATA) === vorB, 'Cursor nicht am Server-Ende: abgelehnt, nichts geschrieben');
  const C = welt('c');
  { const p = new DatabaseSync(pP(C)); p.exec("INSERT INTO sync_changelog (table_name, record_id, branch_id, action, data, synced, created_at) VALUES ('payments','pay2','branch-main','insert','{\"id\":\"pay2\"}',0,'x')"); p.close(); }
  sichern(C, '2026-11-18_a2-test-c');
  const vorC = treeHash(C.DATA);
  const r5 = ausfuehren(C, '2026-11-18_a2-test-c');
  ok(r5.code !== 0 && /not yet sent/.test(r5.out.abbruch) && treeHash(C.DATA) === vorC, 'ungesendeter eigener Eintrag: abgelehnt, nichts geschrieben');
  // Wie im echten Bestand (2 Bestandskorrekturen vom 20.10.): gesendet, aber nie auf dem Server angekommen.
  const D = welt('d');
  { const p = new DatabaseSync(pP(D)); p.exec("INSERT INTO sync_changelog (table_name, record_id, branch_id, action, data, synced, created_at) VALUES ('stock_adjustments','adj2','branch-main','insert','{\"id\":\"adj2\"}',1,'2026-10-20')"); p.close(); }
  const idD = 7;
  sichern(D, '2026-11-18_a2-test-d');
  const vorD = treeHash(D.DATA);
  const r5a = ausfuehren(D, '2026-11-18_a2-test-d');
  ok(r5a.code !== 0 && /ohne Server-Gegenstück/.test(r5a.out.abbruch) && treeHash(D.DATA) === vorD, 'Nur-Primary-Eintrag ohne Bestätigung: abgelehnt, nichts geschrieben');
  const mitFlag = (ids: string) => run(TOOL, ['ausfuehren', '--daten', D.DATA, '--sicherung', join(D.C, '2026-11-18_a2-test-d'), '--sicherung', join(D.E, '2026-11-18_a2-test-d'),
    '--bestaetigen', '2026-11-18_a2-test-d', '--erlaube-nur-primary', ids, '--nur-pfad', DECOY]);
  const r5b = mitFlag(`${idD},99`);
  ok(r5b.code !== 0 && treeHash(D.DATA) === vorD, 'Bestätigung mit falscher Nummernliste: abgelehnt, nichts geschrieben');
  const r5c = mitFlag(String(idD));
  ok(r5c.code === 0 && r5c.out.stand === 'abgeschlossen' && r5c.out.primary.geaendert === 4
    && cl(pP(D)).find((r) => Number(r.id) === idD)?.data === '{"id":"adj2"}',
  `Nur-Primary-Eintrag mit genau bestätigter Nummer: Lauf abgeschlossen, der Eintrag selbst unverändert (${String(r5c.out.abbruch ?? '').slice(0, 80)})`);

  // ── 3) Ausführen: beide Seiten, alles andere unverändert ───────────────────────────────
  const W = welt('w');
  const pVor = cl(pP(W)), sVor = cl(pS(W)), uVor = unberuehrt(W), anfangVor = eigenerAnfang(W);
  ok(sichern(W, '2026-11-18_a2-test-w').code === 0, 'Sicherung w erstellt');
  const mf = JSON.parse(readFileSync(join(W.C, '2026-11-18_a2-test-w', 'MANIFEST-sha256.json'), 'utf8'));
  const r6 = ausfuehren(W, '2026-11-18_a2-test-w');
  ok(r6.code === 0 && r6.out.ok && r6.out.stand === 'abgeschlossen' && r6.out.primary.geaendert === 4 && r6.out.server.geaendert === 5,
    `ausführen: abgeschlossen, Primary 4 / Server 5 Einträge (${JSON.stringify(r6.out).slice(0, 200)})`);
  const pNach = cl(pP(W)), sNach = cl(pS(W));
  ok(r6.out.sperre === 'entfernt' && sperre(W) === null, 'nach bestandenem Gesamtnachweis: Wartungssperre entfernt');
  ok(JSON.stringify(pNach.map((r) => [r.id, r.table_name, r.record_id, r.action])) === JSON.stringify(pVor.map((r) => [r.id, r.table_name, r.record_id, r.action]))
    && JSON.stringify(sNach.map((r) => [r.id, r.table_name, r.record_id, r.action])) === JSON.stringify(sVor.map((r) => [r.id, r.table_name, r.record_id, r.action])),
  'Zeilen, Nummern, Reihenfolge, Tabellen, Datensätze, Aktionen unverändert (beide Seiten)');
  ok([...pNach, ...sNach].every((r) => !String(r.data).includes('image_embedding')), 'kein Eintrag trägt mehr image_embedding');
  ok(pVor.every((r, i) => (r.table_name === 'products' && JSON.parse(r.data).image_embedding !== undefined ? pNach[i].data === ohne(r.data) : pNach[i].data === r.data))
    && sVor.every((r, i) => (r.table_name === 'products' && JSON.parse(r.data).image_embedding !== undefined ? sNach[i].data === ohne(r.data) : sNach[i].data === r.data)),
  'jedes andere Feld byte-gleich (nur der eine Schlüssel fehlt); Einträge ohne Vektor unverändert');
  ok(pNach.filter((r) => r.record_id === 'p2').every((r) => JSON.parse(r.data).images === INLINE), 'Inline-Bilder im Changelog unverändert');
  ok(unberuehrt(W) === uVor, 'Artikel (samt Embeddings), Audit, Rechnungen, Zahlungen, Cursor unverändert');
  ok(eigenerAnfang(W) === anfangVor && anfangVor === 2, `Cursor-Neuaufbau belegt denselben eigenen Anfang (${anfangVor})`);
  const pBytes = [pVor, pNach].map((x) => x.reduce((s, r) => s + String(r.data).length, 0));
  console.log(`  · Testwelt Primary-Changelog: ${pBytes[0]} → ${pBytes[1]} Bytes`);
  const journal = readdirSync(join(W.DATA, 'maintenance-logs')).filter((f) => f.startsWith('a2-stufe1-'));
  ok(journal.length === 1 && JSON.parse(readFileSync(join(W.DATA, 'maintenance-logs', journal[0]), 'utf8')).stand === 'abgeschlossen', 'Journal: abgeschlossen');

  // ── 4) Doppelt: frische Sicherung, zweiter Lauf ändert nichts ──────────────────────────
  ok(sichern(W, '2026-11-18_a2-test-w2').code === 0, 'Sicherung w2 erstellt');
  const dbVor = [sha(pP(W)), sha(pS(W))];
  const r7 = ausfuehren(W, '2026-11-18_a2-test-w2');
  ok(r7.code === 0 && r7.out.primary.geaendert === 0 && r7.out.server.geaendert === 0 && sha(pP(W)) === dbVor[0] && sha(pS(W)) === dbVor[1],
    'zweiter Lauf: 0 Änderungen, beide Datenbankdateien byte-gleich');

  // ── 5) Wiederherstellung als Satz ──────────────────────────────────────────────────────
  const rz = run(BACKUP, ['zurueckspielen', '--sicherung', join(W.C, '2026-11-18_a2-test-w'), '--ziel', W.DATA, '--beiseite', join(boxC, 'w-beiseite'),
    '--bestaetigen', '2026-11-18_a2-test-w', '--nur-pfad', DECOY]);
  const soll = new Map((mf.dateien as Array<{ file: string; sha256: string }>).map((e) => [e.file, e.sha256]));
  ok(rz.code === 0 && sha(pP(W)) === soll.get('lataif.db') && sha(pS(W)) === soll.get('lataif_sync_server.db'),
    'Zurückspielen: beide Datenbanken gemeinsam exakt auf dem Vorher-Stand');

  // ── 6) Abbruch zwischen beiden Datenbanken → fortsetzen ────────────────────────────────
  const X = welt('x');
  sichern(X, '2026-11-18_a2-test-x');
  const sVorX = cl(pS(X));
  const r8 = ausfuehren(X, '2026-11-18_a2-test-x', { LATAIF_A2_TESTABBRUCH: 'nach-primary' });
  ok(r8.code !== 0 && /TESTABBRUCH/.test(r8.out.abbruch), 'Abbruch nach dem Primary simuliert');
  ok(sperre(X) === 'laeuft', 'nach dem Abbruch liegt die Wartungssperre weiter (App würde nicht starten)');
  ok(JSON.stringify(cl(pP(X))) === JSON.stringify(pNach) && JSON.stringify(cl(pS(X))) === JSON.stringify(sVorX),
    'Zwischenstand: Primary vollständig nachher, Server vollständig vorher (je Datenbank atomar)');
  const r9 = ausfuehren(X, '2026-11-18_a2-test-x');
  ok(r9.code !== 0 && /Wartungssperre liegt|offener Lauf/.test(r9.out.abbruch), 'neuer Lauf verweigert, solange der offene nicht fortgesetzt ist');
  const fg1 = run(TOOL, ['freigeben', '--daten', X.DATA, '--nur-pfad', DECOY]);
  ok(fg1.code !== 0 && /offener Lauf/.test(fg1.out.abbruch) && sperre(X) === 'laeuft', 'freigeben verweigert, solange der Lauf offen ist — Sperre bleibt');
  const pr2 = run(TOOL, ['pruefen', '--daten', X.DATA, '--nur-pfad', DECOY]);
  ok(pr2.code !== 0 && pr2.out.sperre === 'laeuft' && /a2-stufe1-/.test(String(pr2.out.offenesJournal)) && pr2.out.gepaart === 6,
    'prüfen meldet Sperre und offenen Lauf; Paare auch im Zwischenstand erkannt');
  const r10 = run(TOOL, ['fortsetzen', '--daten', X.DATA, '--nur-pfad', DECOY]);
  ok(r10.code === 0 && r10.out.fortgesetzt && r10.out.stand === 'abgeschlossen', `fortsetzen: abgeschlossen (${JSON.stringify(r10.out).slice(0, 160)})`);
  ok(JSON.stringify(cl(pP(X))) === JSON.stringify(pNach) && JSON.stringify(cl(pS(X))) === JSON.stringify(sNach), 'Endstand identisch mit dem ununterbrochenen Lauf');
  ok(r10.out.sperre === 'entfernt' && sperre(X) === null, 'fortsetzen: Sperre erst nach dem Gesamtnachweis entfernt');

  ok(!existsSync(pP(X) + '.a2-neu') && !existsSync(pP(X) + '-journal') && !existsSync(pP(W) + '.a2-neu') && !existsSync(pP(W) + '-journal'),
    'keine Arbeitskopie und kein SQLite-Journal neben lataif.db zurückgeblieben');

  // ── 6b) Absturz VOR dem Einsetzen der Primary-Kopie: lataif.db ist byte-gleich der alte Stand ──
  const Z = welt('z');
  sichern(Z, '2026-11-18_a2-test-z');
  const mfZ = JSON.parse(readFileSync(join(Z.C, '2026-11-18_a2-test-z', 'MANIFEST-sha256.json'), 'utf8'));
  const sollZ = new Map((mfZ.dateien as Array<{ file: string; sha256: string }>).map((e) => [e.file, e.sha256]));
  const r12 = ausfuehren(Z, '2026-11-18_a2-test-z', { LATAIF_A2_TESTABBRUCH: 'vor-tausch' });
  ok(r12.code !== 0 && /TESTABBRUCH vor-tausch/.test(r12.out.abbruch) && sha(pP(Z)) === sollZ.get('lataif.db') && existsSync(pP(Z) + '.a2-neu'),
    'Absturz vor dem Einsetzen: lataif.db unverändert der alte Stand (die App sähe nie eine halbe Datei), Arbeitskopie liegt daneben');
  ok(sperre(Z) === 'laeuft', '…und die Wartungssperre liegt');
  const r13 = run(TOOL, ['fortsetzen', '--daten', Z.DATA, '--nur-pfad', DECOY]);
  ok(r13.code === 0 && r13.out.stand === 'abgeschlossen' && JSON.stringify(cl(pP(Z))) === JSON.stringify(pNach) && !existsSync(pP(Z) + '.a2-neu'),
    'fortsetzen nach Absturz vor dem Einsetzen: abgeschlossen, Endstand wie ununterbrochen, Arbeitskopie weg');
  ok(sperre(Z) === null, '…Sperre danach entfernt');

  // ── 7) Abbruch, danach wurde geschrieben → fortsetzen verweigert → Satz zurückspielen ───
  const Y = welt('y');
  sichern(Y, '2026-11-18_a2-test-y');
  const mfY = JSON.parse(readFileSync(join(Y.C, '2026-11-18_a2-test-y', 'MANIFEST-sha256.json'), 'utf8'));
  ausfuehren(Y, '2026-11-18_a2-test-y', { LATAIF_A2_TESTABBRUCH: 'nach-primary' });
  { const p = new DatabaseSync(pP(Y)); p.exec("UPDATE invoices SET invoice_number = 'SRINV-2026-000013'"); p.close(); }
  const vorY = treeHash(Y.DATA);
  const r11 = run(TOOL, ['fortsetzen', '--daten', Y.DATA, '--nur-pfad', DECOY]);
  ok(r11.code !== 0 && /geschrieben/.test(r11.out.abbruch) && treeHash(Y.DATA) === vorY && sperre(Y) === 'laeuft', 'nach Abbruch geschrieben: fortsetzen verweigert, nichts verändert, Sperre bleibt');
  const fg2 = run(TOOL, ['freigeben', '--daten', Y.DATA, '--nur-pfad', DECOY]);
  ok(fg2.code !== 0 && sperre(Y) === 'laeuft', 'freigeben ebenso verweigert — nur der Sicherungssatz hilft');
  const rz2 = run(BACKUP, ['zurueckspielen', '--sicherung', join(Y.E, '2026-11-18_a2-test-y'), '--ziel', Y.DATA, '--beiseite', join(boxC, 'y-beiseite'),
    '--bestaetigen', '2026-11-18_a2-test-y', '--nur-pfad', DECOY]);
  const sollY = new Map((mfY.dateien as Array<{ file: string; sha256: string }>).map((e) => [e.file, e.sha256]));
  ok(rz2.code === 0 && sha(pP(Y)) === sollY.get('lataif.db') && sha(pS(Y)) === sollY.get('lataif_sync_server.db'),
    'Rückweg: Sicherungssatz (von E:) eingespielt — beide Datenbanken auf dem Vorher-Stand');
  ok(sperre(Y) === null, 'Zurückspielen des Satzes nimmt auch die Sperre weg (Datenordner = Sicherung)');

  // ── 8) Absturz direkt nach dem Anlegen der Sperre (vor jedem Schreiben) → freigeben ──────
  const V = welt('v');
  sichern(V, '2026-11-18_a2-test-v');
  const vorV = [sha(pP(V)), sha(pS(V))];
  const r14 = ausfuehren(V, '2026-11-18_a2-test-v', { LATAIF_A2_TESTABBRUCH: 'nach-sperre' });
  ok(r14.code !== 0 && sperre(V) === 'vorbereitung' && !existsSync(join(V.DATA, 'maintenance-logs')) && sha(pP(V)) === vorV[0] && sha(pS(V)) === vorV[1],
    'Absturz nach dem Sperren: Sperre liegt, kein Journal, Datenbanken unverändert');
  ok(ausfuehren(V, '2026-11-18_a2-test-v').code !== 0 && sperre(V) === 'vorbereitung', 'neuer Lauf verweigert, solange die Sperre liegt');
  const fg3 = run(TOOL, ['freigeben', '--daten', V.DATA, '--nur-pfad', DECOY]);
  ok(fg3.code === 0 && sperre(V) === null, 'freigeben: Dateien wie beim Sperren → Sperre entfernt');
  ok(ausfuehren(V, '2026-11-18_a2-test-v').code === 0 && sperre(V) === null, 'danach läuft die Wartung normal durch');

  // ── 9) Absturz nach dem Gesamtnachweis, vor dem Entfernen der Sperre → freigeben ─────────
  const U = welt('u');
  sichern(U, '2026-11-18_a2-test-u');
  const r15 = ausfuehren(U, '2026-11-18_a2-test-u', { LATAIF_A2_TESTABBRUCH: 'vor-freigabe' });
  ok(r15.code !== 0 && sperre(U) === 'laeuft' && JSON.stringify(cl(pP(U))) === JSON.stringify(pNach), 'Absturz vor dem Entfernen: Lauf fertig, Sperre liegt noch');
  const fg4 = run(TOOL, ['freigeben', '--daten', U.DATA, '--nur-pfad', DECOY]);
  ok(fg4.code === 0 && sperre(U) === null, 'freigeben: abgeschlossenes Journal + Zustand erneut nachgeprüft → Sperre entfernt');

  // ── 10) Windows: ein fremder offener Griff auf lataif.db verhindert den Dateitausch → sicher angehalten ──
  const H = welt('h');
  sichern(H, '2026-11-18_a2-test-h');
  const vorH = sha(pP(H));
  const griff = new DatabaseSync(pP(H));               // wie ein anderer Prozess, der die Datei offen hält
  griff.prepare('SELECT COUNT(*) AS n FROM products').get();
  const r16 = ausfuehren(H, '2026-11-18_a2-test-h');
  griff.close();
  ok(r16.code !== 0 && /EPERM|EBUSY|EACCES|operation not permitted|resource busy/i.test(String(r16.out.abbruch)) && sha(pP(H)) === vorH && sperre(H) === 'laeuft',
    `Windows: Tausch scheitert am fremden Griff — lataif.db unverändert, Sperre liegt (${String(r16.out.abbruch).slice(0, 70)})`);
  const r17 = run(TOOL, ['fortsetzen', '--daten', H.DATA, '--nur-pfad', DECOY]);
  ok(r17.code === 0 && sperre(H) === null && JSON.stringify(cl(pP(H))) === JSON.stringify(pNach), 'Griff geschlossen → fortsetzen: abgeschlossen, Sperre entfernt');
} finally {
  rmSync(boxC, { recursive: true, force: true });
  rmSync(boxE, { recursive: true, force: true });
}

console.log(fails.length ? `\nFAIL — changelog-schlankung: ${PASS} passed, ${fails.length} failed` : `\nPASS — changelog-schlankung: ${PASS} passed, 0 failed`);
process.exit(fails.length ? 1 : 0);
