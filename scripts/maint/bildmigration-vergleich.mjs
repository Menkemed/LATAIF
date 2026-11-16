#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
// Nachweis nach der Owner-Wartung „Bildspeicher verkleinern" (nur lesend).
//
//   node scripts/maint/bildmigration-vergleich.mjs --vorher <lataif.db der Sicherung> --nachher <KOPIE der lataif.db danach>
//
// Beide Dateien werden nur über TEMPORÄRE Kopien geöffnet. Erwartet (und geprüft):
//   • products, media_links, media_objects, media_variants, sync_changelog, audit_log: Zeile für Zeile unverändert;
//   • media_blobs: nur `current_generation_no`/`updated_at` umgestellter Blobs geändert, keiner neu, keiner weg;
//   • media_blob_generations: jede alte Zeile noch da (nur `available` → `superseded` bei umgestellten Blobs),
//     neue Zeilen nur als Generation n+1 `available`, und jede neue Fassung kleiner als die alte;
//   • neue Hauptbilder ≤ 60 000 B, neue Vorschauen ≤ 10 000 B (die größte Klasse; die genaue Klasse prüft der Lauf);
//   • keine Generation gelöscht.
// Ausgabe JSON; Exit 0 nur, wenn alles stimmt. Gedacht für den Vergleich DIREKT nach der Migration, bevor wieder
// gearbeitet wird (spätere Geschäftsvorgänge erscheinen sonst als Abweichung).
// ════════════════════════════════════════════════════════════════════════════
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const UNVERAENDERT = ['products', 'media_links', 'media_objects', 'media_variants', 'sync_changelog', 'audit_log'];

function oeffnen(pfad, tmp, name) {
  const kopie = join(tmp, name);
  copyFileSync(pfad, kopie);
  return new DatabaseSync(kopie, { readOnly: true });
}
const alle = (db, sql, p = []) => db.prepare(sql).all(...p);
const hatTabelle = (db, t) => alle(db, "SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?", [t]).length > 0;
const tabellenHash = (db, t) => createHash('sha256').update(JSON.stringify(alle(db, `SELECT * FROM "${t}" ORDER BY rowid`))).digest('hex');

export function vergleiche(vorherPfad, nachherPfad) {
  const tmp = mkdtempSync(join(tmpdir(), 'bildmigration-vergleich-'));
  const fehler = [];
  let a, b;
  try {
    a = oeffnen(vorherPfad, tmp, 'vorher.db');
    b = oeffnen(nachherPfad, tmp, 'nachher.db');
    for (const t of UNVERAENDERT) {
      if (!hatTabelle(a, t) && !hatTabelle(b, t)) continue;
      if (tabellenHash(a, t) !== tabellenHash(b, t)) fehler.push(`${t}: verändert`);
    }
    const blobsA = new Map(alle(a, 'SELECT * FROM media_blobs').map((r) => [`${r.tenant_id}|${r.blob_id}`, r]));
    const blobsB = new Map(alle(b, 'SELECT * FROM media_blobs').map((r) => [`${r.tenant_id}|${r.blob_id}`, r]));
    if (blobsA.size !== blobsB.size) fehler.push(`media_blobs: Anzahl ${blobsA.size} → ${blobsB.size}`);
    let umgestellt = 0;
    for (const [k, ra] of blobsA) {
      const rb = blobsB.get(k);
      if (!rb) { fehler.push(`media_blobs ${k}: fehlt`); continue; }
      for (const c of Object.keys(ra)) {
        if (c === 'current_generation_no' || c === 'updated_at') continue;
        if (JSON.stringify(ra[c]) !== JSON.stringify(rb[c])) fehler.push(`media_blobs ${k}.${c}: verändert`);
      }
      if (rb.current_generation_no !== ra.current_generation_no) umgestellt++;
    }
    const genA = new Map(alle(a, 'SELECT * FROM media_blob_generations').map((r) => [`${r.tenant_id}|${r.blob_id}|${r.generation_no}`, r]));
    const genB = new Map(alle(b, 'SELECT * FROM media_blob_generations').map((r) => [`${r.tenant_id}|${r.blob_id}|${r.generation_no}`, r]));
    let neu = 0, ueberGrenze = 0, nichtKleiner = 0;
    const istVorschau = new Set(alle(b, `SELECT tenant_id || '|' || blob_id AS k FROM media_variants WHERE variant_type = 'thumbnail'`).map((r) => r.k));
    for (const [k, ra] of genA) {
      const rb = genB.get(k);
      if (!rb) { fehler.push(`media_blob_generations ${k}: gelöscht`); continue; }
      for (const c of Object.keys(ra)) {
        if (c === 'gen_status' || c === 'superseded_at') continue;
        if (JSON.stringify(ra[c]) !== JSON.stringify(rb[c])) fehler.push(`media_blob_generations ${k}.${c}: verändert`);
      }
      if (ra.gen_status !== rb.gen_status && !(ra.gen_status === 'available' && rb.gen_status === 'superseded')) fehler.push(`media_blob_generations ${k}: ${ra.gen_status} → ${rb.gen_status}`);
    }
    for (const [k, rb] of genB) {
      if (genA.has(k)) continue;
      neu++;
      const [t, blob, gen] = k.split('|');
      const vor = genA.get(`${t}|${blob}|${Number(gen) - 1}`);
      const blobB = blobsB.get(`${t}|${blob}`);
      if (rb.gen_status !== 'available' || !vor || blobB?.current_generation_no !== Number(gen)) fehler.push(`media_blob_generations ${k}: keine saubere Folgegeneration`);
      if (vor && Number(rb.byte_size) >= Number(vor.byte_size)) nichtKleiner++;
      const grenze = istVorschau.has(`${t}|${blob}`) ? 10_000 : 60_000;
      if (Number(rb.byte_size) > grenze) ueberGrenze++;
    }
    if (neu !== umgestellt) fehler.push(`neue Generationen ${neu} ≠ umgestellte Blobs ${umgestellt}`);
    if (ueberGrenze) fehler.push(`${ueberGrenze} neue Fassung(en) über 60 KB (Haupt) bzw. 10 KB (Vorschau)`);
    if (nichtKleiner) fehler.push(`${nichtKleiner} neue Fassung(en) nicht kleiner als die alte`);
    const summe = (db, sql) => Number(alle(db, sql)[0]?.s ?? 0);
    const aktuell = (db) => summe(db, `SELECT SUM(g.byte_size) AS s FROM media_blobs m JOIN media_blob_generations g ON g.tenant_id = m.tenant_id AND g.blob_id = m.blob_id AND g.generation_no = m.current_generation_no WHERE m.blob_status = 'present'`);
    return {
      ok: fehler.length === 0,
      umgestellt, neueGenerationen: neu,
      aktuelleBilddatenBytes: { vorher: aktuell(a), nachher: aktuell(b) },
      supersededBytes: summe(b, `SELECT SUM(byte_size) AS s FROM media_blob_generations WHERE gen_status = 'superseded'`),
      fehler: fehler.slice(0, 50), anzahlFehler: fehler.length,
    };
  } finally {
    try { a?.close(); } catch { /* zu */ }
    try { b?.close(); } catch { /* zu */ }
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  const vorher = arg('--vorher'), nachher = arg('--nachher');
  if (!vorher || !nachher || !existsSync(vorher) || !existsSync(nachher)) {
    console.error('Aufruf: node scripts/maint/bildmigration-vergleich.mjs --vorher <lataif.db der Sicherung> --nachher <Kopie der lataif.db danach>');
    process.exit(2);
  }
  const r = vergleiche(resolve(vorher), resolve(nachher));
  console.log(JSON.stringify(r, null, 1));
  process.exit(r.ok ? 0 : 1);
}
