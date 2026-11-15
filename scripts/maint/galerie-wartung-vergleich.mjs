#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
// Nachweis nach der Owner-Wartung „überholte Galerie-Bearbeitungen“ (nur lesend).
//
//   node scripts/maint/galerie-wartung-vergleich.mjs --vorher <lataif.db der Sicherung> --nachher <KOPIE der lataif.db danach>
//
// Beide Dateien werden nur über TEMPORÄRE Kopien geöffnet. Erwartet (und geprüft):
//   • media_ingest_jobs: genau die zwei Jobs von `accepted` → `failed` / MEDIA_EDIT_PLAN_SUPERSEDED, Plan gleich;
//     sonst keine Zeile geändert, keine neu, keine weg;
//   • audit_log: +2 Zeilen `Media`/`media_ingest_jobs` (dazu höchstens die Bildabgleich-Zeilen der zwei Artikel);
//   • products: unverändert — erlaubt ist nur `image_description`/`image_embedding` der zwei Artikel (Bildabgleich);
//   • media_links/_objects/_variants/_blobs/_blob_generations: unverändert;
//   • sync_changelog: kein neuer Eintrag außer dem Bildabgleich der zwei Artikel.
// Ausgabe JSON; Exit 0 nur, wenn alles stimmt. Gedacht für den Vergleich DIREKT nach der Wartung, bevor
// wieder gearbeitet wird (spätere Geschäftsvorgänge erscheinen sonst als Abweichung).
// ════════════════════════════════════════════════════════════════════════════
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const JOBS = {
  'job-edit:gallery-edit:tenant-1:branch-main:753561c6-6dc4-4a18-8aba-d20047610e31:stock_image:eeba8daf-baa2-4521-9e29-9940dfc24822': 'TAG-WCH-004',
  'job-edit:gallery-edit:tenant-1:branch-main:b34529ca-7c4b-42bc-9a1e-57eb95548266:stock_image:fdbf065c-d042-4533-b2ff-e0095074345b': 'CAR-OGJ-001',
};
const PIDS = new Set(['753561c6-6dc4-4a18-8aba-d20047610e31', 'b34529ca-7c4b-42bc-9a1e-57eb95548266']);
const MEDIA_TABLES = ['media_links', 'media_objects', 'media_variants', 'media_blobs', 'media_blob_generations'];
const EMBED_COLS = new Set(['image_description', 'image_embedding']);

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
function oeffne(file, tmp, n) {
  if (!file || !existsSync(file)) throw new Error(`Datei fehlt: ${file}`);
  const t = join(tmp, `${n}.db`);
  copyFileSync(resolve(file), t);
  return new DatabaseSync(t, { readOnly: true });
}
const all = (db, sql, p = []) => db.prepare(sql).all(...p);
const byKey = (rows, k) => new Map(rows.map((r) => [String(r[k]), r]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const tmp = mkdtempSync(join(tmpdir(), 'lataif-vergleich-'));
let vorher, nachher;
try {
  vorher = oeffne(arg('vorher'), tmp, 'vorher');
  nachher = oeffne(arg('nachher'), tmp, 'nachher');
  const fehler = [];
  const info = {};

  // media_ingest_jobs
  const jv = byKey(all(vorher, 'SELECT * FROM media_ingest_jobs'), 'job_id');
  const jn = byKey(all(nachher, 'SELECT * FROM media_ingest_jobs'), 'job_id');
  if (jv.size !== jn.size) fehler.push(`media_ingest_jobs: Anzahl ${jv.size} → ${jn.size}`);
  for (const [id, a] of jv) {
    const b = jn.get(id);
    if (!b) { fehler.push(`Job fehlt: ${id}`); continue; }
    if (JOBS[id]) {
      if (!(a.state === 'accepted' && b.state === 'failed' && b.error_code === 'MEDIA_EDIT_PLAN_SUPERSEDED' && a.result_json === b.result_json && a.request_hash === b.request_hash)) {
        fehler.push(`${JOBS[id]}: erwartet accepted → failed/MEDIA_EDIT_PLAN_SUPERSEDED mit gleichem Plan (ist ${a.state} → ${b.state}/${b.error_code})`);
      }
    } else if (!same(a, b)) fehler.push(`anderer Job verändert: ${id}`);
  }
  info.jobs = Object.fromEntries(Object.entries(JOBS).map(([id, sku]) => [sku, `${jv.get(id)?.state} → ${jn.get(id)?.state}`]));

  // products
  const pv = byKey(all(vorher, 'SELECT * FROM products'), 'id');
  const pn = byKey(all(nachher, 'SELECT * FROM products'), 'id');
  if (pv.size !== pn.size) fehler.push(`products: Anzahl ${pv.size} → ${pn.size}`);
  let bildabgleich = 0;
  for (const [id, a] of pv) {
    const b = pn.get(id);
    if (!b) { fehler.push(`Artikel fehlt: ${id}`); continue; }
    const diff = Object.keys(a).filter((c) => !same(a[c], b[c]));
    if (diff.length === 0) continue;
    if (PIDS.has(id) && diff.every((c) => EMBED_COLS.has(c))) { bildabgleich++; continue; }
    fehler.push(`Artikel ${a.sku ?? id}: Spalten geändert ${diff.join(',')}`);
  }
  info.bildabgleichArtikel = bildabgleich;

  // Medien
  for (const t of MEDIA_TABLES) {
    if (!same(all(vorher, `SELECT * FROM ${t} ORDER BY rowid`), all(nachher, `SELECT * FROM ${t} ORDER BY rowid`))) fehler.push(`${t} verändert`);
  }

  // sync_changelog
  const maxV = Number(all(vorher, 'SELECT COALESCE(MAX(rowid),0) AS n FROM sync_changelog')[0].n);
  if (!same(all(vorher, 'SELECT * FROM sync_changelog ORDER BY rowid'), all(nachher, 'SELECT * FROM sync_changelog WHERE rowid <= ? ORDER BY rowid', [maxV]))) fehler.push('bestehende sync_changelog-Zeilen verändert');
  const neuCl = all(nachher, 'SELECT rowid, table_name, record_id, data FROM sync_changelog WHERE rowid > ?', [maxV]);
  for (const r of neuCl) {
    let keys = [];
    try { keys = Object.keys(JSON.parse(r.data ?? '{}')); } catch { keys = ['?']; }
    const nurBild = r.table_name === 'products' && PIDS.has(String(r.record_id)) && keys.every((k) => ['imageDescription', 'imageEmbedding', 'image_description', 'image_embedding', 'id'].includes(k));
    if (!nurBild) fehler.push(`neuer sync_changelog-Eintrag: ${r.table_name}/${r.record_id} (${keys.slice(0, 6).join(',')})`);
  }
  info.neueChangelogZeilen = neuCl.length;

  // audit_log
  const av = new Set(all(vorher, 'SELECT id FROM audit_log').map((r) => String(r.id)));
  const neuA = all(nachher, 'SELECT id, module, entity_type, entity_id, field_name FROM audit_log').filter((r) => !av.has(String(r.id)));
  const wartung = neuA.filter((r) => r.module === 'Media' && r.entity_type === 'media_ingest_jobs' && JOBS[r.entity_id]);
  const bild = neuA.filter((r) => r.entity_type === 'products' && PIDS.has(String(r.entity_id)) && ['imageDescription', 'imageEmbedding'].includes(String(r.field_name)));
  if (wartung.length !== 2) fehler.push(`Audit: ${wartung.length} Wartungszeilen statt 2`);
  if (neuA.length !== wartung.length + bild.length) fehler.push(`Audit: ${neuA.length - wartung.length - bild.length} unerwartete neue Zeilen`);
  info.audit = { wartung: wartung.length, bildabgleich: bild.length };

  const ok = fehler.length === 0;
  console.log(JSON.stringify({ ok, ...info, fehler: fehler.slice(0, 40), anzahlFehler: fehler.length }, null, 1));
  process.exitCode = ok ? 0 : 2;
} catch (e) {
  console.error(JSON.stringify({ ok: false, abbruch: String(e?.message ?? e) }));
  process.exitCode = 1;
} finally {
  try { vorher?.close(); } catch { /* zu */ }
  try { nachher?.close(); } catch { /* zu */ }
  rmSync(tmp, { recursive: true, force: true });
}
