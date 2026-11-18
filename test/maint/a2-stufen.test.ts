// ════════════════════════════════════════════════════════════════════════════
// A2 — Stufe 2 (Audit-Embeddings), Stufe 3 (Inline-Fotos im Changelog) und Verdichtung, mit dem Werkzeug
// scripts/maint/changelog-schlankung.mjs — nur in Sandbox-Ordnern (%TEMP% = C: und ein temporärer Ordner auf
// dem Laufwerk des Repos), nie ein produktiver Pfad. Prozessprüfung auf eine nicht existierende Köder-exe
// beschränkt (`--nur-pfad`).
// Run: node test/maint/a2-stufen.test.ts
// ════════════════════════════════════════════════════════════════════════════
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import initSqlJs from 'sql.js';
import { describeEmbedding } from '../../src/core/audit/audit-value.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const TOOL = join(repo, 'scripts', 'maint', 'changelog-schlankung.mjs');
const BACKUP = join(repo, 'scripts', 'maint', 'manuelle-sicherung.mjs');
let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };

const boxC = mkdtempSync(join(tmpdir(), 'lataif-a2s-test-'));
const boxE = mkdtempSync(join(repo, '.tmp-a2-test-'));
if (parse(boxC).root.toLowerCase() === parse(boxE).root.toLowerCase()) { console.log('SKIP — Repo und %TEMP% liegen auf demselben Laufwerk'); process.exit(0); }
const DECOY = join(boxC, 'bin', 'lataif.exe');
const UUID = '6f1c2a8e-4b7d-4e2a-9c3f-1d2e3f4a5b6c';
const FP = createHash('sha256').update(Buffer.concat([Buffer.from('lataif/server-identity/v1\0'), Buffer.from(UUID)])).digest('hex').slice(0, 32);
const SQL = await initSqlJs({ locateFile: () => join(repo, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm') });

function run(script: string, args: string[], env: Record<string, string> = {}): { code: number; out: any } {
  try {
    const s = execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    return { code: 0, out: JSON.parse(s) };
  } catch (e: any) {
    const txt = String(e.stdout || '') || String(e.stderr || '');
    const ab = txt.startsWith('{') ? 0 : txt.indexOf('\n{') + 1;
    let out: any = null; try { out = JSON.parse(txt.slice(ab)); } catch { out = { raw: txt.slice(0, 400) }; }
    return { code: e.status ?? 1, out };
  }
}
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
function lese<T>(file: string, fn: (db: DatabaseSync) => T): T {
  const t = mkdtempSync(join(tmpdir(), 'lataif-a2s-lese-'));
  try {
    for (const s of ['', '-wal', '-shm']) if (existsSync(file + s)) copyFileSync(file + s, join(t, 'x.db' + s));
    const db = new DatabaseSync(join(t, 'x.db'));
    try { return fn(db); } finally { db.close(); }
  } finally { rmSync(t, { recursive: true, force: true }); }
}
const alle = (file: string, sql: string) => lese(file, (db) => JSON.stringify(db.prepare(sql).all()));
const vec = (seed: number, n = 300) => JSON.stringify(Array.from({ length: n }, (_, i) => Math.round(Math.sin(seed * 977 + i) * 1e8) / 1e8));
const foto = (seed: number) => 'data:image/jpeg;base64,' + Buffer.from(randomBytes(2000 + seed)).toString('base64');
const FOTO1 = foto(1), FOTO2 = foto(2), FOTO3 = foto(3);
const FOTO_KRUMM = 'data:image/png;base64,QUJD\nREVG';          // nicht kanonisch (Zeilenumbruch) → wörtlich exportiert

type Welt = { DATA: string; C: string; E: string };
function welt(tag: string): Welt {
  const DATA = join(boxC, tag, 'Data'); const C = join(boxC, tag, 'B'); const E = join(boxE, tag);
  for (const d of [DATA, C, E]) mkdirSync(d, { recursive: true });
  writeFileSync(join(DATA, 'sync_install_id.key'), UUID + '\n');
  const p = new DatabaseSync(join(DATA, 'lataif.db'));
  p.exec(`CREATE TABLE sync_changelog (id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT NOT NULL, record_id TEXT NOT NULL, branch_id TEXT,
            action TEXT NOT NULL, data TEXT, synced INTEGER DEFAULT 0, created_at TEXT);
          CREATE TABLE sync_cursor (server_fingerprint TEXT PRIMARY KEY, last_sync_id INTEGER NOT NULL, updated_at TEXT);
          CREATE TABLE products (id TEXT PRIMARY KEY, sku TEXT, images TEXT, image_embedding TEXT);
          CREATE TABLE audit_log (id TEXT PRIMARY KEY, branch_id TEXT, module TEXT, entity_type TEXT, entity_id TEXT, action_type TEXT,
            field_name TEXT, old_value TEXT, new_value TEXT, changed_by TEXT, changed_at TEXT);
          CREATE TABLE invoices (id TEXT PRIMARY KEY, invoice_number TEXT);
          CREATE TABLE invoice_lines (id TEXT PRIMARY KEY, invoice_id TEXT, line_total REAL);
          CREATE TABLE item_participations (id TEXT PRIMARY KEY, from_il_rowid INTEGER, to_il_rowid INTEGER);
          CREATE TABLE payments (id TEXT PRIMARY KEY, amount REAL);
          CREATE TABLE media_links (id TEXT PRIMARY KEY, entity_id TEXT, media_id TEXT);
          CREATE TABLE ballast (x BLOB);`);
  p.prepare('INSERT INTO products VALUES (?,?,?,?)').run('p1', 'SKU-1', '[]', vec(11));
  p.prepare('INSERT INTO products VALUES (?,?,?,?)').run('p2', 'SKU-2', '[]', vec(12));
  p.prepare('INSERT INTO products VALUES (?,?,?,?)').run('p3', 'SKU-3', JSON.stringify([FOTO3]), null);
  p.exec("INSERT INTO media_links VALUES ('m1','p1','media-1'), ('m2','p2','media-2')");
  p.exec("INSERT INTO invoices VALUES ('i1','SRINV-2026-000012'); INSERT INTO payments VALUES ('pay1', 25);");
  for (let i = 1; i <= 5; i++) p.prepare('INSERT INTO invoice_lines VALUES (?,?,?)').run(`il${i}`, 'i1', 10 * i);
  p.exec("DELETE FROM invoice_lines WHERE id = 'il2'");                                      // Lücke in den rowids
  p.exec("INSERT INTO item_participations VALUES ('ip1', 3, 5)");                            // verweist auf rowids
  const au = p.prepare('INSERT INTO audit_log VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  au.run('a1', 'branch-main', 'Product', 'products', 'p1', 'UPDATE', 'imageEmbedding', null, vec(11), 'user-owner', '2026-10-01T10:00:00.000Z');
  au.run('a2', 'branch-main', 'Product', 'products', 'p2', 'UPDATE', 'imageEmbedding', vec(1), vec(12), 'user-owner', '2026-10-02T10:00:00.000Z');
  au.run('a3', 'branch-main', 'Product', 'products', 'p1', 'UPDATE', 'imageDescription', null, 'A steel watch', 'user-owner', '2026-10-01T10:00:00.000Z');
  au.run('a4', 'branch-main', 'Sales', 'invoices', 'i1', 'UPDATE', 'invoice_number', 'RPINV-2026-000011', 'SRINV-2026-000012', 'user-owner', '2026-11-17T13:38:10.177Z');
  au.run('a5', 'branch-main', 'Product', 'products', 'p2', 'UPDATE', 'imageEmbedding', null, '{"__audit_embedding__":"vector","dims":3,"digest":"x"}', 'user-owner', '2026-11-18T10:00:00.000Z');
  const s = new DatabaseSync(join(DATA, 'lataif_sync_server.db'));
  s.exec(`PRAGMA journal_mode=WAL;
          CREATE TABLE sync_changelog (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, branch_id TEXT NOT NULL, table_name TEXT NOT NULL,
            record_id TEXT NOT NULL, action TEXT NOT NULL, data TEXT NOT NULL, user_id TEXT NOT NULL, created_at TEXT NOT NULL,
            record_revision INTEGER, operation_id TEXT, protocol_version INTEGER);
          CREATE TABLE mobile_upload_inbox (id TEXT PRIMARY KEY, state TEXT);
          INSERT INTO mobile_upload_inbox VALUES ('u1','done');
          CREATE TABLE ballast (x BLOB);`);
  const eigen = [
    ['products', 'p1', 'insert', JSON.stringify({ id: 'p1', sku: 'SKU-1', images: JSON.stringify([FOTO1]), planned_sale_price: 150, image_embedding: vec(1) })],
    ['products', 'p1', 'update', JSON.stringify({ id: 'p1', sku: 'SKU-1', images: JSON.stringify([FOTO1, FOTO2]), planned_sale_price: 160, image_embedding: vec(1) })],
    ['products', 'p2', 'insert', JSON.stringify({ id: 'p2', sku: 'SKU-2', images: JSON.stringify([FOTO_KRUMM]), image_embedding: null })],
    ['invoices', 'i1', 'insert', JSON.stringify({ id: 'i1', invoice_number: 'RPINV-2026-000011' })],
    ['products', 'p1', 'update', JSON.stringify({ id: 'p1', sku: 'SKU-1', images: '[]', planned_sale_price: 170 })],
    // Wie die 5 Altartikel im echten Bestand: HEUTE noch Inline-Fotos; dazwischen einmal `[]`.
    ['products', 'p3', 'insert', JSON.stringify({ id: 'p3', sku: 'SKU-3', images: JSON.stringify([FOTO3]) })],
    ['products', 'p3', 'update', JSON.stringify({ id: 'p3', sku: 'SKU-3', images: '[]' })],
    ['products', 'p3', 'update', JSON.stringify({ id: 'p3', sku: 'SKU-3', images: JSON.stringify([FOTO3]) })],
  ];
  const pIns = p.prepare("INSERT INTO sync_changelog (table_name, record_id, branch_id, action, data, synced, created_at) VALUES (?,?,'branch-main',?,?,1,'2026-11-01')");
  const sIns = s.prepare("INSERT INTO sync_changelog (tenant_id, branch_id, table_name, record_id, action, data, user_id, created_at) VALUES ('tenant-1','branch-main',?,?,?,?,'self-desktop','2026-11-01')");
  eigen.forEach((e, i) => {
    pIns.run(e[0], e[1], e[2], e[3]);
    sIns.run(e[0], e[1], e[2], e[3]);
    if (i === 1) sIns.run('products', 'p9', 'insert', JSON.stringify({ id: 'p9', sku: 'SKU-9', images: JSON.stringify([FOTO2]) }));   // fremd (Handy)
  });
  // Ballast → freie Seiten, damit Verdichten etwas zu tun hat.
  for (const db of [p, s]) { const b = db.prepare('INSERT INTO ballast VALUES (?)'); for (let i = 0; i < 60; i++) b.run(randomBytes(16000)); db.exec('DELETE FROM ballast'); }
  const max = Number((s.prepare('SELECT MAX(id) AS m FROM sync_changelog').get() as { m: number }).m);
  p.prepare('INSERT INTO sync_cursor VALUES (?,?,?)').run(FP, max, '2026-11-17T00:00:00.000Z');
  p.close(); s.close();
  return { DATA, C, E };
}
const sichern = (w: Welt, name: string) =>
  run(BACKUP, ['sichern', '--quelle', w.DATA, '--ziel', w.C, '--ziel', w.E, '--name', name, '--ruhe-sekunden', '1', '--nur-pfad', DECOY]);
const aus = (w: Welt, stufe: string, name: string, env: Record<string, string> = {}) =>
  run(TOOL, ['ausfuehren', '--stufe', stufe, '--daten', w.DATA, '--sicherung', join(w.C, name), '--sicherung', join(w.E, name), '--bestaetigen', name, '--nur-pfad', DECOY], env);
const weiter = (w: Welt) => run(TOOL, ['fortsetzen', '--daten', w.DATA, '--nur-pfad', DECOY]);
const pP = (w: Welt) => join(w.DATA, 'lataif.db');
const pS = (w: Welt) => join(w.DATA, 'lataif_sync_server.db');
const sperre = (w: Welt) => existsSync(join(w.DATA, 'WARTUNG-LAEUFT.lock'));
const cl = (file: string) => lese(file, (db) => db.prepare('SELECT id, table_name, record_id, action, data FROM sync_changelog ORDER BY id').all() as Array<Record<string, any>>);
const geschaeft = (w: Welt) => alle(pP(w), 'SELECT * FROM products ORDER BY id') + alle(pP(w), 'SELECT * FROM invoices') + alle(pP(w), 'SELECT * FROM payments')
  + alle(pP(w), 'SELECT * FROM media_links') + alle(pP(w), 'SELECT rowid AS r, * FROM invoice_lines ORDER BY rowid') + alle(pP(w), 'SELECT * FROM item_participations')
  + alle(pP(w), 'SELECT * FROM sync_cursor') + alle(pS(w), 'SELECT * FROM mobile_upload_inbox');

try {
  // ══ Stufe 2 — Audit ═══════════════════════════════════════════════════════════════════════
  {
    const W = welt('s2');
    const auditVor = alle(pP(W), 'SELECT * FROM audit_log ORDER BY id');
    const gVor = geschaeft(W), clVor = [cl(pP(W)), cl(pS(W))].map((x) => JSON.stringify(x)), srvVor = sha(pS(W));
    const pr = run(TOOL, ['pruefen', '--daten', W.DATA, '--nur-pfad', DECOY]);
    ok(pr.out.stufen?.[2]?.zuAendern === 2, `prüfen: 2 Audit-Einträge mit Vektor (${JSON.stringify(pr.out.stufen?.[2])})`);
    sichern(W, '2026-11-18_s2');
    const r = aus(W, '2', '2026-11-18_s2');
    ok(r.code === 0 && r.out.stand === 'abgeschlossen' && r.out.audit.geaendert === 2 && !sperre(W), `Stufe 2 ausgeführt (${JSON.stringify(r.out).slice(0, 180)})`);
    const nach = JSON.parse(alle(pP(W), 'SELECT * FROM audit_log ORDER BY id')) as Array<Record<string, any>>;
    const vor = JSON.parse(auditVor) as Array<Record<string, any>>;
    ok(nach.find((x) => x.id === 'a1')?.new_value === JSON.stringify(describeEmbedding(vec(11)))
      && nach.find((x) => x.id === 'a2')?.old_value === JSON.stringify(describeEmbedding(vec(1)))
      && nach.find((x) => x.id === 'a2')?.new_value === JSON.stringify(describeEmbedding(vec(12))),
    'Vektoren → genau der Kurznachweis der App (Dimension + Prüfsumme), alter und neuer Wert');
    ok(nach.every((x, i) => Object.keys(x).every((k) => k === 'old_value' || k === 'new_value' || x[k] === vor[i][k])),
      'Benutzer, Zeitpunkt, Änderungsart, Feld, Datensatz jedes Eintrags unverändert');
    ok(['a3', 'a4', 'a5'].every((id) => JSON.stringify(nach.find((x) => x.id === id)) === JSON.stringify(vor.find((x) => x.id === id))),
      'Einträge ohne Vektor (auch ein schon kurzer Nachweis) byte-gleich');
    ok(geschaeft(W) === gVor && JSON.stringify(cl(pP(W))) === clVor[0] && JSON.stringify(cl(pS(W))) === clVor[1] && sha(pS(W)) === srvVor,
      'Artikel, Embeddings, Rechnungen, Zahlungen, Medien, Changelog beider Seiten und die Server-Datei unverändert');
    const nw = run(TOOL, ['nachweisen-audit', '--daten', W.DATA, '--sicherung', join(W.E, '2026-11-18_s2'), '--nur-pfad', DECOY]);
    ok(nw.code === 0 && nw.out.ok && nw.out.ersetzteWerte === 3, `nachweisen-audit gegen die Sicherung: jeder Kurznachweis = Original (${JSON.stringify(nw.out)})`);
    { const p = new DatabaseSync(pP(W)); p.prepare("UPDATE audit_log SET new_value = ? WHERE id = 'a1'").run(JSON.stringify(describeEmbedding(vec(99)))); p.close(); }
    const nw2 = run(TOOL, ['nachweisen-audit', '--daten', W.DATA, '--sicherung', join(W.E, '2026-11-18_s2'), '--nur-pfad', DECOY]);
    ok(nw2.code !== 0 && /a1: new_value/.test(JSON.stringify(nw2.out.fehler)), 'nachweisen-audit erkennt einen nicht passenden Kurznachweis');
    // Abbruch vor dem Einsetzen → lataif.db unverändert, fortsetzen erledigt den Rest; danach doppelt = 0
    const X = welt('s2x');
    sichern(X, '2026-11-18_s2x');
    const vorX = sha(pP(X));
    const ra = aus(X, '2', '2026-11-18_s2x', { LATAIF_A2_TESTABBRUCH: 'vor-tausch' });
    ok(ra.code !== 0 && /vor-tausch/.test(String(ra.out.abbruch)) && sha(pP(X)) === vorX && sperre(X), 'Stufe 2 Abbruch vor dem Einsetzen: Datei unverändert, Sperre liegt');
    const rf = weiter(X);
    ok(rf.code === 0 && rf.out.fortgesetzt && !sperre(X) && rf.out.audit.geaendert === 2, 'fortsetzen: Stufe 2 abgeschlossen, Sperre entfernt');
    sichern(X, '2026-11-18_s2x2');
    const vorX2 = sha(pP(X));
    const rd = aus(X, '2', '2026-11-18_s2x2');
    ok(rd.code === 0 && rd.out.audit.geaendert === 0 && sha(pP(X)) === vorX2, 'Stufe 2 doppelt: 0 Änderungen, Datei byte-gleich');
  }

  // ══ Stufe 3 — Inline-Fotos ════════════════════════════════════════════════════════════════
  {
    const W = welt('s3');
    const pVor = cl(pP(W)), sVor = cl(pS(W)), gVor = geschaeft(W), auditVor = alle(pP(W), 'SELECT * FROM audit_log ORDER BY id');
    sichern(W, '2026-11-18_s3');
    const r = aus(W, '3', '2026-11-18_s3');
    ok(r.code === 0 && r.out.stand === 'abgeschlossen' && r.out.primary.geaendert === 3 && r.out.server.geaendert === 4 && r.out.export.fotos === 3,
      `Stufe 3 ausgeführt: Primary 3, Server 4 Einträge, 3 verschiedene Fotos exportiert (${JSON.stringify(r.out).slice(0, 220)})`);
    const pN = cl(pP(W)), sN = cl(pS(W));
    ok([...pN, ...sN].filter((x) => x.record_id !== 'p3').every((x) => !String(x.data).includes('data:')), 'kein Changelog-Eintrag (außer dem geschützten Artikel) trägt mehr ein Inline-Foto');
    const ohneImages = (d: string) => { const o = JSON.parse(d); if (o.id !== 'p3' && typeof o.images === 'string' && o.images.includes('data:')) delete o.images; return JSON.stringify(o); };
    ok(pVor.every((x, i) => pN[i].data === ohneImages(x.data) && pN[i].id === x.id) && sVor.every((x, i) => sN[i].data === ohneImages(x.data) && sN[i].id === x.id),
      'nur `images` mit Inline-Foto entfernt; Galerie-Marker `[]`, Embeddings und alle anderen Felder byte-gleich, Nummern gleich');
    ok(geschaeft(W) === gVor && alle(pP(W), 'SELECT * FROM audit_log ORDER BY id') === auditVor, 'Artikelbilder (images-Spalte), Medienverweise, Audit, Rechnungen unverändert');
    const dir = join(W.DATA, 'maintenance-logs', r.out.export.ordner);
    const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
    const zurueck = (h: string) => { const f = index.fotos[h]; const b = readFileSync(join(dir, f.datei)); return f.kopf === null ? b.toString('utf8') : f.kopf + b.toString('base64'); };
    ok([FOTO1, FOTO2, FOTO_KRUMM].every((u) => zurueck(createHash('sha256').update(u).digest('hex')) === u),
      'jedes exportierte Foto ergibt wieder exakt die ursprüngliche data:-URL (auch die nicht kanonische, wörtlich gesichert)');
    ok(readdirSync(dir).some((f) => f.endsWith('.jpg')) && readdirSync(dir).some((f) => f.endsWith('.dataurl.txt')),
      'Export als echte Bilddatei (.jpg) und — wo nötig — wörtlich (.dataurl.txt)');
    ok(index.zeilen.primary.length === 3 && index.zeilen.server.length === 4, 'Verzeichnis: welche Zeile welche Fotos trug (beide Seiten)');
    const p3vor = [pVor, sVor].map((x) => JSON.stringify(x.filter((r) => r.record_id === 'p3')));
    const p3nach = [pN, sN].map((x) => JSON.stringify(x.filter((r) => r.record_id === 'p3')));
    ok(p3vor[0] === p3nach[0] && p3vor[1] === p3nach[1] && p3nach[0].includes('data:'),
      'Artikel mit HEUTE noch Inline-Fotos: alle seine Einträge unverändert (ein Neuaufbau setzte sonst das frühere `[]` über die Fotos)');
    const jdir = join(W.DATA, 'maintenance-logs');
    const j3 = JSON.parse(readFileSync(join(jdir, readdirSync(jdir).find((f) => f.startsWith('a2-stufe3-') && f.endsWith('.json'))!), 'utf8'));
    ok(JSON.stringify(j3.geschuetzt) === JSON.stringify(['p3']) && !Object.keys(index.fotos).includes(createHash('sha256').update(FOTO3).digest('hex')),
      'geschützte Artikel im Journal festgehalten; ihre Fotos bleiben im Changelog (nicht exportiert, nicht entfernt)');
    // Abbruch nach dem Export → fortsetzen nutzt den Export weiter
    const X = welt('s3x');
    sichern(X, '2026-11-18_s3x');
    const vorX = [sha(pP(X)), sha(pS(X))];
    const ra = aus(X, '3', '2026-11-18_s3x', { LATAIF_A2_TESTABBRUCH: 'nach-export' });
    ok(ra.code !== 0 && sha(pP(X)) === vorX[0] && sha(pS(X)) === vorX[1] && sperre(X)
      && readdirSync(join(X.DATA, 'maintenance-logs')).some((f) => f.startsWith('a2-stufe3-fotos-')),
    'Abbruch nach dem Export: Datenbanken unverändert, Export liegt, Sperre liegt');
    const rf = weiter(X);
    ok(rf.code === 0 && rf.out.fortgesetzt && !sperre(X) && [...cl(pP(X)), ...cl(pS(X))].filter((x) => x.record_id !== 'p3').every((x) => !String(x.data).includes('data:')),
      'fortsetzen: Stufe 3 abgeschlossen mit dem vorhandenen Export');
  }

  // ══ Verdichten ═══════════════════════════════════════════════════════════════════════════
  {
    const W = welt('v');
    const gVor = geschaeft(W), clVor = [cl(pP(W)), cl(pS(W))].map((x) => JSON.stringify(x)), auditVor = alle(pP(W), 'SELECT * FROM audit_log ORDER BY id');
    const rowidsVor = alle(pP(W), 'SELECT rowid, id FROM invoice_lines ORDER BY rowid');
    const grVor = [statSync(pP(W)).size, statSync(pS(W)).size + (existsSync(pS(W) + '-wal') ? statSync(pS(W) + '-wal').size : 0)];
    sichern(W, '2026-11-18_v');
    const mf = JSON.parse(readFileSync(join(W.C, '2026-11-18_v', 'MANIFEST-sha256.json'), 'utf8'));
    const r = aus(W, 'verdichten', '2026-11-18_v');
    const grNach = [statSync(pP(W)).size, statSync(pS(W)).size];
    ok(r.code === 0 && r.out.stand === 'abgeschlossen' && !sperre(W), `Verdichten abgeschlossen (${JSON.stringify(r.out.groessen ?? r.out).slice(0, 200)})`);
    ok(grNach[0] < grVor[0] && grNach[1] < grVor[1], `beide Dateien kleiner (Primary ${grVor[0]} → ${grNach[0]}, Server ${grVor[1]} → ${grNach[1]})`);
    ok(geschaeft(W) === gVor && JSON.stringify(cl(pP(W))) === clVor[0] && JSON.stringify(cl(pS(W))) === clVor[1] && alle(pP(W), 'SELECT * FROM audit_log ORDER BY id') === auditVor,
      'Inhalt unverändert: Artikel, Embeddings, Rechnungen, Zahlungen, Medien, Audit, Changelog beider Seiten');
    ok(alle(pP(W), 'SELECT rowid, id FROM invoice_lines ORDER BY rowid') === rowidsVor, 'rowids der Rechnungszeilen unverändert (Partnerbeteiligungen verweisen darauf)');
    ok(lese(pS(W), (db) => (db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode) === 'wal', 'Server-Datei weiter im WAL-Modus');
    const sj = new SQL.Database(readFileSync(pP(W)));
    ok(sj.exec('PRAGMA integrity_check')[0].values[0][0] === 'ok' && sj.exec('SELECT COUNT(*) FROM products')[0].values[0][0] === 3, 'sql.js (wie die App) lädt den verdichteten Primary');
    sj.close();
    ok(!existsSync(pP(W) + '.a2-neu') && !existsSync(pS(W) + '.a2-neu') && !existsSync(pP(W) + '-journal'), 'keine Arbeitskopien oder Journale zurückgeblieben');
    const rz = run(BACKUP, ['zurueckspielen', '--sicherung', join(W.C, '2026-11-18_v'), '--ziel', W.DATA, '--beiseite', join(boxC, 'v-beiseite'), '--bestaetigen', '2026-11-18_v', '--nur-pfad', DECOY]);
    const soll = new Map((mf.dateien as Array<{ file: string; sha256: string }>).map((e) => [e.file, e.sha256]));
    ok(rz.code === 0 && sha(pP(W)) === soll.get('lataif.db') && sha(pS(W)) === soll.get('lataif_sync_server.db'), 'Zurückspielen: beide unverdichteten Dateien gemeinsam zurück');
    // Abbruch nach dem Primary (Primary verdichtet, Server nicht) → fortsetzen
    for (const punkt of ['nach-primary', 'vor-server-tausch', 'vor-tausch']) {
      const X = welt(`v-${punkt}`);
      const gX = geschaeft(X);
      sichern(X, `2026-11-18_v-${punkt}`);
      const ra = aus(X, 'verdichten', `2026-11-18_v-${punkt}`, { LATAIF_A2_TESTABBRUCH: punkt });
      ok(ra.code !== 0 && sperre(X) && geschaeft(X) === gX, `Verdichten Abbruch ${punkt}: Sperre liegt, Inhalt unverändert`);
      const rf = weiter(X);
      ok(rf.code === 0 && rf.out.fortgesetzt && !sperre(X) && geschaeft(X) === gX && !existsSync(pP(X) + '.a2-neu') && !existsSync(pS(X) + '.a2-neu'),
        `fortsetzen nach ${punkt}: abgeschlossen, Inhalt gleich, keine Reste`);
    }
  }

  // ══ Alle Aufgaben nacheinander (wie die Generalprobe), jede mit frischer Sicherung ═══════════
  {
    const W = welt('alle');
    const gVor = geschaeft(W);
    const groesseVor = statSync(pP(W)).size + statSync(pS(W)).size;
    for (const [stufe, name] of [['1', 'a1'], ['2', 'a2'], ['3', 'a3'], ['verdichten', 'a4']]) {
      sichern(W, `2026-11-18_${name}`);
      const r = aus(W, stufe, `2026-11-18_${name}`);
      ok(r.code === 0 && r.out.stand === 'abgeschlossen' && !sperre(W), `Kette: ${stufe} abgeschlossen (${String(r.out.abbruch ?? '').slice(0, 80)})`);
    }
    const pr = run(TOOL, ['pruefen', '--daten', W.DATA, '--nur-pfad', DECOY]);
    ok(pr.out.stufen[2].zuAendern === 0 && pr.out.stufen[3].primary.zuAendern === 0 && pr.out.primary.zuAendern === 0 && pr.out.gepaart === 8,
      'danach: nichts mehr zu tun, Paare unverändert');
    ok(geschaeft(W) === gVor && statSync(pP(W)).size + statSync(pS(W)).size < groesseVor, 'Geschäftsdaten gleich, zusammen kleiner');
  }
} finally {
  rmSync(boxC, { recursive: true, force: true });
  rmSync(boxE, { recursive: true, force: true });
}

console.log(fails.length ? `\nFAIL — a2-stufen: ${PASS} passed, ${fails.length} failed` : `\nPASS — a2-stufen: ${PASS} passed, 0 failed`);
process.exit(fails.length ? 1 : 0);
