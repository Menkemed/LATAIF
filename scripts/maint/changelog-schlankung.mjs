#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
// LATAIF — Weg A2: Offline-Wartung des Datenordners bei GESCHLOSSENER App. Vier getrennt ausführbare Aufgaben:
//
//   --stufe 1           historische Changelog-Einträge: `image_embedding` aus Artikel-Payloads (Primary + Server)
//   --stufe 2           historische Audit-Einträge: Embedding-Vektor → Kurznachweis {Dimension, Prüfsumme} (Primary)
//   --stufe 3           historische Changelog-Einträge: Inline-Fotos (`images` mit `data:`) — VORHER byte-genau als
//                       Dateien exportiert (Primary + Server)
//   --stufe verdichten  SQLite-Verdichtung beider Datenbanken (Inhalt und rowids bleiben byte-gleich)
//
//   pruefen          --daten <Datenordner> [--stufe …] [--erlaube-nur-primary <id,id>] [--nur-pfad <exe>]
//   ausfuehren       --daten <Datenordner> --stufe <…> --sicherung <E:\…\Name> --sicherung <F:\…\Name>
//                    --bestaetigen <Name> [--erlaube-nur-primary <id,id>] [--nur-pfad <exe>]
//   fortsetzen       --daten <Datenordner> [--nur-pfad <exe>]
//   freigeben        --daten <Datenordner> [--nur-pfad <exe>]   (liegengebliebene Sperre nach geprüftem Zustand entfernen)
//   nachweisen-audit --daten <Datenordner> --sicherung <Ordner einer Sicherung von VOR Stufe 2>  (nur lesend)
//
// WARTUNGSSPERRE: `ausfuehren` legt ZUERST `WARTUNG-LAEUFT.lock` im Datenordner exklusiv an; solange sie liegt,
// startet LATAIF nicht (src-tauri/src/maintenance_lock.rs) — also auch kein Server, kein PC2, kein Handy. Ab dem
// ersten Schreiben bleibt sie bei jedem Abbruch liegen; sie fällt nur nach bestandenem Gesamtnachweis
// (`ausfuehren`/`fortsetzen`), über `freigeben` nach geprüftem Zustand oder mit dem Zurückspielen des
// Sicherungssatzes (der Datenordner wird dabei ersetzt).
//
// Gemeinsamer Ablauf (jeder Schritt bricht VOR dem nächsten ab, wenn etwas nicht stimmt):
//   1. Sperre anlegen, dann: kein `lataif.exe` läuft; beide Datenbanken im EXCLUSIVE-Sperrmodus.
//   2. Sicherungsnachweis: zwei mit `manuelle-sicherung.mjs` erstellte, gleichnamige Sicherungen auf ZWEI
//      Laufwerken, byte-gleich mit beiden Datenbanken (samt -wal/-shm) → frisch, vollständig, zusammengehörig.
//   3. Identität und Folge: Cursor des Primary gehört zu GENAU diesem Server (Fingerabdruck aus
//      `sync_install_id.key`) und steht auf dessen Ende; kein eigener Eintrag ungesendet; Paare belegt.
//   4. Journal (`maintenance-logs/a2-<aufgabe>-<Zeit>.json`) mit Vorher-Prüfsummen und geplantem Nachher.
//   5. Primary: IMMER in einer KOPIE (umgewandelt bzw. verdichtet), dort nachgerechnet + integrity_check + mit
//      sql.js geladen wie in der App, dann per Umbenennen atomar eingesetzt (die App liest `lataif.db` roh und
//      kennt kein SQLite-Journal) → Journal.
//   6. Server: Änderung in EINER Transaktion an Ort und Stelle (nur über SQLite geöffnet; ein unterbrochenes
//      WAL verwirft SQLite selbst) bzw. Verdichtung in eine Kopie + atomarer Tausch → Journal.
//   7. Gesamtnachweis → Journal „abgeschlossen" → Sperre entfernt.
//
// Zwei SQLite-Transaktionen sind NICHT gemeinsam atomar. Deshalb ist jede Aufgabe idempotent und das Journal
// hält fest, wo der Lauf steht: bricht er ab, steht jede Datenbank für sich vollständig vorher ODER nachher.
// `fortsetzen` prüft genau das (und dass sonst nichts geschrieben wurde) und erledigt den Rest; passt etwas nicht,
// bleibt alles stehen → Sicherungssatz mit `manuelle-sicherung.mjs zurueckspielen` einspielen.
// Kein VACUUM beim normalen App-Start — nur hier, offline, auf Anweisung.
// ════════════════════════════════════════════════════════════════════════════
import { createHash } from 'node:crypto';
import {
  closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync,
  rmSync, statSync, writeFileSync, writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, parse, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { planSide, reconcileSides, RULE_EMBEDDING, RULE_INLINE_FOTOS } from '../../src/core/sync/changelog-slim.ts';
import { ownPushedCounts, provenOwnPrefix } from '../../src/core/sync/cursor-store.ts';
import { describeEmbedding } from '../../src/core/audit/audit-value.ts';

const PRIMARY = 'lataif.db';
const SERVER = 'lataif_sync_server.db';
const BEGLEITER = ['-wal', '-shm'];
const JOURNAL_DIR = 'maintenance-logs';
const FINGERPRINT_DOMAIN = 'lataif/server-identity/v1\0';
const SPERRE = 'WARTUNG-LAEUFT.lock';
const NEU = '.a2-neu';
const RULE_KEINE = { name: 'keine', table: '\u0000', key: '\u0000' };   // exakter Vergleich, nichts verschlankt
const EMBEDDING_FELDER = ['imageEmbedding', 'image_embedding'];

const AUFGABEN = {
  1: { id: '1', name: 'Stufe 1 — Embedding im Changelog', prefix: 'a2-stufe1-', art: 'changelog', regel: RULE_EMBEDDING },
  2: { id: '2', name: 'Stufe 2 — Embedding im Audit', prefix: 'a2-stufe2-', art: 'audit' },
  3: { id: '3', name: 'Stufe 3 — Inline-Fotos im Changelog', prefix: 'a2-stufe3-', art: 'changelog', regel: RULE_INLINE_FOTOS },
  verdichten: { id: 'verdichten', name: 'Verdichten', prefix: 'a2-verdichten-', art: 'verdichten' },
};
const PREFIXE = Object.values(AUFGABEN).map((a) => a.prefix);

class Abbruch extends Error {}
const fail = (msg) => { throw new Abbruch(msg); };

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const k = a.slice(2);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) fail(`Wert fehlt für --${k}`);
    i++;
    if (k === 'sicherung') (out.sicherung ??= []).push(v);
    else out[k] = v;
  }
  return out;
}
function aufgabeVon(o, standard) {
  const s = o.stufe ?? standard ?? fail('--stufe 1 | 2 | 3 | verdichten fehlt');
  return AUFGABEN[s] ?? fail(`unbekannte Stufe „${s}" — 1 | 2 | 3 | verdichten`);
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const fileSha = (p) => sha256(readFileSync(p));
const sqlPfad = (p) => p.split('\\').join('/').replace(/'/g, "''");

/** Wie `manuelle-sicherung.mjs`: läuft ein `lataif.exe` (bzw. genau `--nur-pfad`)? */
function laufendeApp(nurPfad) {
  const cmd = "Get-CimInstance Win32_Process -Filter \"Name='lataif.exe'\" | ForEach-Object { $_.ExecutablePath }";
  let raw = '';
  try {
    raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', windowsHide: true });
  } catch (e) { fail(`Prozessliste nicht lesbar (${e.message}) — aus Sicherheit Abbruch`); }
  const pfade = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!nurPfad) return pfade;
  const want = resolve(nurPfad).toLowerCase();
  return pfade.filter((p) => resolve(p).toLowerCase() === want);
}
function appMussZuSein(o) {
  const app = laufendeApp(o['nur-pfad']);
  if (app.length) fail(`App läuft (${app.join(', ')}) — erst schließen. Ohne App schreiben auch PC2 und Handy nicht.`);
}

/** Datenordner-Dateien beider Datenbanken (mit vorhandenen Begleitern) → SHA-256. */
function dbDateien(daten) {
  const out = {};
  for (const db of [PRIMARY, SERVER]) {
    for (const suffix of ['', ...BEGLEITER]) {
      const f = db + suffix;
      const p = join(daten, f);
      if (existsSync(p)) out[f] = fileSha(p);
    }
  }
  if (!out[PRIMARY] || !out[SERVER]) fail('Datenordner ohne beide Datenbanken');
  return out;
}
function groessen(daten) {
  const g = (f) => (existsSync(join(daten, f)) ? statSync(join(daten, f)).size : 0);
  return { [PRIMARY]: g(PRIMARY), [SERVER]: g(SERVER) + g(SERVER + '-wal') };
}

function serverFingerprint(daten) {
  const p = join(daten, 'sync_install_id.key');
  if (!existsSync(p)) fail('sync_install_id.key fehlt — Server-Identität nicht nachweisbar');
  const id = readFileSync(p, 'utf8').trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) fail('sync_install_id.key hat keine eindeutige Form — Abbruch');
  return sha256(Buffer.concat([Buffer.from(FINGERPRINT_DOMAIN, 'utf8'), Buffer.from(id, 'utf8')])).slice(0, 32);
}

/** Eine Datenbank im EXCLUSIVE-Sperrmodus öffnen (die Sperre bleibt bis close()). */
function oeffneEine(pfad) {
  const db = new DatabaseSync(pfad);
  db.exec('PRAGMA locking_mode = EXCLUSIVE'); db.exec('BEGIN IMMEDIATE'); db.exec('COMMIT');
  return db;
}
/** Beide Datenbanken zum Schreiben öffnen. `p`/`s` werden beim Einsetzen einer Kopie neu geöffnet. */
function oeffnen(daten) {
  return {
    p: oeffneEine(join(daten, PRIMARY)),
    s: oeffneEine(join(daten, SERVER)),
    close() { try { this.p?.close(); } catch { /* */ } try { this.s?.close(); } catch { /* */ } this.p = null; this.s = null; },
  };
}

/** Ein SQLite-Rücksetz-Journal neben `lataif.db` hieße: ein früherer SQLite-Schreiber endete mitten in einer
 *  Transaktion. Die App (sql.js, rohe Datei) wertet es nicht aus — darum hier nie weiterarbeiten. */
function unsauber(daten) {
  return existsSync(join(daten, PRIMARY + '-journal')) ? [`${PRIMARY}-journal vorhanden — die Datei ist nicht sauber geschlossen`] : [];
}
const restKopien = (daten) => [PRIMARY, SERVER].map((f) => f + NEU).filter((f) => existsSync(join(daten, f)));

// ── Wartungssperre (gelesen von der App beim Start: src-tauri/src/maintenance_lock.rs) ─────────────────
function sperreLesen(daten) {
  const p = join(daten, SPERRE);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return { stand: 'unlesbar' }; }
}
function sperreAnlegen(daten, inhalt) {
  let fd;
  try { fd = openSync(join(daten, SPERRE), 'wx'); } catch (e) {
    if (e.code === 'EEXIST') fail('Wartungssperre liegt schon (laufender oder abgebrochener Lauf) — „fortsetzen" oder „freigeben"');
    throw e;
  }
  try { writeSync(fd, JSON.stringify(inhalt)); fsyncSync(fd); } finally { closeSync(fd); }
}
/** Inhalt ersetzen — die Sperrdatei existiert dabei in jedem Augenblick (Umbenennen über die alte). */
function sperreSetzen(daten, inhalt) {
  const p = join(daten, SPERRE);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(inhalt));
  const fd = openSync(tmp, 'r+'); fsyncSync(fd); closeSync(fd);
  renameSync(tmp, p);
}
function sperreEntfernen(daten) { rmSync(join(daten, SPERRE)); }

// ── Lesen, Prüfsummen ──────────────────────────────────────────────────────────────────────────────
const zeilenPrimary = (db) => db.prepare('SELECT id, table_name, record_id, action, data, synced FROM sync_changelog ORDER BY id').all()
  .map((r) => ({ ...r, id: Number(r.id), data: String(r.data ?? '') }));
const zeilenServer = (db) => db.prepare('SELECT id, table_name, record_id, action, data FROM sync_changelog ORDER BY id').all()
  .map((r) => ({ ...r, id: Number(r.id), data: String(r.data ?? '') }));

/** Prüfsumme über den ganzen Changelog einer Seite (Nummer, Tabelle, Datensatz, Aktion, Daten). */
function changelogDigest(rows) {
  const h = createHash('sha256');
  for (const r of rows) h.update(`${r.id}\u0000${r.table_name}\u0000${r.record_id}\u0000${r.action}\u0000${r.data}\u0001`);
  return h.digest('hex');
}
function geplantDigest(rows, plan) {
  const neu = new Map(plan.changes.map((c) => [c.id, c.to]));
  return changelogDigest(rows.map((r) => (neu.has(r.id) ? { ...r, data: neu.get(r.id) } : r)));
}

const tabellen = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
/** Prüfsumme über den ganzen Inhalt einer Tabelle — MIT rowid (eine Verdichtung, die rowids neu vergäbe, fiele auf). */
function tabelleDigest(db, t, ersetzen) {
  const h = createHash('sha256');
  try {
    for (const r of db.prepare(`SELECT rowid AS "__rowid__", * FROM "${t}" ORDER BY rowid`).iterate()) {
      h.update(JSON.stringify(ersetzen ? ersetzen(r) : r) + '\n');
    }
  } catch {
    // Tabelle ohne rowid: Zeilen sortiert
    for (const l of db.prepare(`SELECT * FROM "${t}"`).all().map((r) => JSON.stringify(ersetzen ? ersetzen(r) : r)).sort()) h.update(l + '\n');
  }
  return h.digest('hex');
}
/** Prüfsummen aller Tabellen (ohne `ausser`). */
function inhalt(db, ausser = []) {
  const out = {};
  for (const t of tabellen(db)) if (!ausser.includes(t)) out[t] = tabelleDigest(db, t);
  return out;
}
const gleich = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function integritaet(db, label) {
  const ic = Object.values(db.prepare('PRAGMA integrity_check').get())[0];
  if (ic !== 'ok') fail(`${label}: integrity_check ${ic}`);
}

/** Adapter: node:sqlite → die `exec`-Form, die `cursor-store` erwartet (sql.js). */
function sqlJsForm(db) {
  return {
    exec(sql) {
      const rows = db.prepare(sql).all();
      if (rows.length === 0) return [];
      const columns = Object.keys(rows[0]);
      return [{ columns, values: rows.map((r) => columns.map((c) => r[c])) }];
    },
  };
}
/** Wie weit der Cursor-Neuaufbau die Server-Historie als eigenen Ursprung belegen könnte. */
function eigenerAnfang(p, serverRows) {
  return provenOwnPrefix(serverRows.map((r) => ({ id: r.id, table_name: r.table_name, record_id: r.record_id, action: r.action, data: r.data })),
    ownPushedCounts(sqlJsForm(p))).count;
}

/** `--erlaube-nur-primary 1350,1352` → Menge der ausdrücklich bestätigten Nummern (leer = keine). */
function bestaetigteNurPrimary(o) {
  const raw = o?.['erlaube-nur-primary'];
  if (!raw) return [];
  const ids = String(raw).split(',').map((x) => x.trim()).filter(Boolean).map(Number);
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) fail('--erlaube-nur-primary: nur Nummern, durch Komma getrennt');
  return [...new Set(ids)].sort((a, b) => a - b);
}

/** Bestandsaufnahme des Abgleichs beider Seiten für eine Regel — reines Lesen. */
function lage(daten, dbs, erlaubtNurPrimary = [], regel = RULE_EMBEDDING) {
  const fp = serverFingerprint(daten);
  const cursor = dbs.p.prepare('SELECT server_fingerprint, last_sync_id FROM sync_cursor').all();
  const eigenerCursor = cursor.find((c) => c.server_fingerprint === fp) ?? null;
  const serverMax = Number(dbs.s.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM sync_changelog').get().m);
  const pRows = zeilenPrimary(dbs.p);
  const sRows = zeilenServer(dbs.s);
  const pPlan = planSide(pRows, regel);
  const sPlan = planSide(sRows, regel);
  const abgleich = reconcileSides(pRows, sRows, regel);
  const probleme = [];
  if (!eigenerCursor) probleme.push('Primary hat keinen Cursor für GENAU diesen Server (Fingerabdruck) — Zugehörigkeit nicht belegt');
  else if (Number(eigenerCursor.last_sync_id) !== serverMax) probleme.push(`Cursor ${eigenerCursor.last_sync_id} ≠ letzte Server-Nummer ${serverMax} — Abgleich nicht vollständig`);
  if (pPlan.refused.length || sPlan.refused.length) probleme.push(`nicht byte-treu umwandelbare Einträge: Primary ${pPlan.refused.length}, Server ${sPlan.refused.length}`);
  // Stufe 3: jedes Inline-Foto, das ein Eintrag verliert, muss der Export lesen können. Trägt `images` ein `data:` in einer
  // Form, die keine Liste von Foto-Texten ist, würde es entfernt, ohne exportiert zu sein — dann kein Lauf.
  if (regel.key === 'images') {
    const unlesbar = [...pPlan.changes, ...sPlan.changes].filter((c) => !fotosVollstaendigLesbar(JSON.parse(c.from).images)).map((c) => c.id);
    if (unlesbar.length) probleme.push(`Inline-Fotos in einer Form, die der Export nicht vollständig liest (Einträge #${unlesbar.slice(0, 20).join(', #')}) — Abbruch vor jedem Schreiben`);
  }
  if (!abgleich.ok) probleme.push(...abgleich.problems.map((x) => `Abgleich: ${x}`));
  // Schon bestehende Abweichung: gesendete eigene Einträge ohne Gegenstück auf dem Server. Sie werden nie
  // verändert (sonst Abbruch) und laufen nur durch, wenn der Owner GENAU diese Nummern bestätigt.
  const nurPrimary = abgleich.primaryOnly.map((x) => x.id).sort((a, b) => a - b);
  if (nurPrimary.length) {
    const geplant = new Set(pPlan.changes.map((c) => c.id));
    const betroffen = nurPrimary.filter((id) => geplant.has(id));
    if (betroffen.length) probleme.push(`Einträge ohne Server-Gegenstück würden verändert (#${betroffen.join(', #')}) — Abbruch`);
    if (JSON.stringify(nurPrimary) !== JSON.stringify(erlaubtNurPrimary)) {
      probleme.push(`Primary-Einträge ohne Server-Gegenstück: ${abgleich.primaryOnly.map((x) => `#${x.id} ${x.table}/${x.action}`).join(', ')}`
        + ` — nur mit --erlaube-nur-primary ${nurPrimary.join(',')} (genau diese Nummern)`);
    }
  } else if (erlaubtNurPrimary.length) {
    probleme.push('--erlaube-nur-primary angegeben, aber keine solche Abweichung vorhanden');
  }
  return {
    fp, cursor: eigenerCursor ? Number(eigenerCursor.last_sync_id) : null, serverMax, pRows, sRows, pPlan, sPlan, abgleich, probleme,
    eigenerAnfang: eigenerAnfang(dbs.p, sRows),
  };
}
/** Was Sync-Recovery sieht — vorher und nachher jeder Aufgabe gleich. */
function kennzahlen(daten, dbs) {
  const l = lage(daten, dbs, [], RULE_KEINE);
  return { cursor: l.cursor, serverMax: l.serverMax, gepaart: l.abgleich.paired, nurServer: l.abgleich.serverOnly,
    nurPrimary: l.abgleich.primaryOnly.map((x) => x.id), eigenerAnfang: l.eigenerAnfang, zeilenPrimary: l.pRows.length, zeilenServer: l.sRows.length };
}

const zahlen = (plan) => ({ zeilen: plan.rows, zuAendern: plan.changes.length, bytesVorher: plan.bytesBefore, bytesNachher: plan.bytesAfter });

// ── Stufe 3: geschützte Artikel ─────────────────────────────────────────────────────────────────
/** Artikel, deren HEUTIGES `images` noch Inline-Fotos trägt. Für Artikel wendet das Einspielen `images` an: ohne
 *  ihre späteren Einträge setzte ein Neuaufbau ein früheres `'[]'` über die heutigen Fotos — ihre Einträge bleiben. */
function inlineArtikelHeute(p) {
  return p.prepare("SELECT id FROM products WHERE images LIKE '%data:%' ORDER BY id").all().map((r) => String(r.id));
}
/** Die Regel einer Changelog-Aufgabe — für Stufe 3 mit den (im Journal festgehaltenen) geschützten Artikeln. */
function regelFuer(a, j) {
  if (a.id !== '3') return a.regel;
  const schutz = new Set(j?.geschuetzt ?? fail('Stufe 3 ohne Liste der geschützten Artikel'));
  return { ...a.regel, keepRecord: (id) => schutz.has(String(id)) };
}

// ── Stufe 2: Audit ───────────────────────────────────────────────────────────────────────────────
/** Ein gespeicherter Audit-Wert mit Embedding-Vektor → derselbe Kurznachweis wie bei neuen Einträgen (Weg A). */
function auditErsatz(v) {
  if (v === null || v === undefined) return v;
  const d = describeEmbedding(v);
  return d ? JSON.stringify(d) : v;
}
function auditSpalten(p) {
  return new Set(p.prepare("SELECT name FROM pragma_table_info('audit_log')").all().map((r) => r.name));
}
function auditPlan(p) {
  const sp = auditSpalten(p);
  if (!sp.has('field_name') || !sp.has('id')) return { zeilen: 0, changes: [], bytesVorher: 0, bytesNachher: 0 };
  const ph = EMBEDDING_FELDER.map(() => '?').join(',');
  const rows = p.prepare(`SELECT id, ${sp.has('old_value') ? 'old_value' : 'NULL AS old_value'}, ${sp.has('new_value') ? 'new_value' : 'NULL AS new_value'}
     FROM audit_log WHERE field_name IN (${ph}) ORDER BY rowid`).all(...EMBEDDING_FELDER);
  const changes = [];
  let vorher = 0, nachher = 0;
  for (const r of rows) {
    const o2 = auditErsatz(r.old_value), n2 = auditErsatz(r.new_value);
    if (o2 === r.old_value && n2 === r.new_value) continue;
    changes.push({ id: String(r.id), altFrom: r.old_value, altTo: o2, neuFrom: r.new_value, neuTo: n2 });
    vorher += String(r.old_value ?? '').length + String(r.new_value ?? '').length;
    nachher += String(o2 ?? '').length + String(n2 ?? '').length;
  }
  return { zeilen: rows.length, changes, bytesVorher: vorher, bytesNachher: nachher };
}
function auditDigestGeplant(p, plan) {
  const m = new Map(plan.changes.map((c) => [c.id, c]));
  const mitAlt = auditSpalten(p).has('old_value');
  return tabelleDigest(p, 'audit_log', (r) => (m.has(String(r.id))
    ? { ...r, ...(mitAlt ? { old_value: m.get(String(r.id)).altTo } : {}), new_value: m.get(String(r.id)).neuTo } : r));
}

// ── Stufe 3: Foto-Export ────────────────────────────────────────────────────────────────────────
const fotoListe = (images) => {
  let v = images;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return []; } }
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.startsWith('data:')) : [];
};
/** Liest der Export ALLE `data:` dieses Werts? (Jedes Vorkommen im Text muss ein Listeneintrag sein, der damit beginnt.) */
const fotosVollstaendigLesbar = (images) => {
  const text = typeof images === 'string' ? images : JSON.stringify(images ?? null);
  return fotoListe(images).length === text.split('data:').length - 1;
};
const ENDUNG = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic' };
/** Die Bytes, die eine Fotodatei trägt, und ob daraus exakt dieselbe data:-URL entsteht. */
function fotoDatei(u) {
  const komma = u.indexOf(',');
  const kopf = u.slice(0, komma + 1);
  const m = /^data:([^;,]*)((?:;[^;,]*)*);base64,$/.exec(kopf);
  if (m) {
    const bytes = Buffer.from(u.slice(komma + 1), 'base64');
    if (`${kopf}${bytes.toString('base64')}` === u) return { bytes, endung: ENDUNG[m[1].toLowerCase()] ?? 'bin', kopf };
  }
  return { bytes: Buffer.from(u, 'utf8'), endung: 'dataurl.txt', kopf: null };   // nicht kanonisch → wörtlich
}
const urlAusDatei = (bytes, kopf) => (kopf === null ? bytes.toString('utf8') : `${kopf}${bytes.toString('base64')}`);

/** Alle Inline-Fotos der geplanten Einträge beider Seiten byte-genau als Dateien (dedupliziert) + Verzeichnis. */
function fotosExportieren(daten, stempel, pPlan, sPlan) {
  const ordner = `a2-stufe3-fotos-${stempel}`;
  const dir = join(daten, JOURNAL_DIR, ordner);
  mkdirSync(dir, { recursive: true });
  const fotos = new Map();
  const zeilen = { primary: [], server: [] };
  for (const [seite, plan] of [['primary', pPlan], ['server', sPlan]]) {
    for (const c of plan.changes) {
      const hs = [];
      for (const u of fotoListe(JSON.parse(c.from).images)) {
        const h = sha256(Buffer.from(u, 'utf8'));
        if (!fotos.has(h)) {
          const f = fotoDatei(u);
          const datei = `${h}.${f.endung}`;
          const p = join(dir, datei);
          writeFileSync(p, f.bytes);
          const fd = openSync(p, 'r+'); fsyncSync(fd); closeSync(fd);
          fotos.set(h, { datei, kopf: f.kopf, bytes: f.bytes.length });
        }
        hs.push(h);
      }
      zeilen[seite].push({ id: c.id, fotos: hs });
    }
  }
  const index = { werkzeug: 'changelog-schlankung/3', fotos: Object.fromEntries(fotos), zeilen };
  writeFileSync(join(dir, 'index.json'), JSON.stringify(index));
  const fd = openSync(join(dir, 'index.json'), 'r+'); fsyncSync(fd); closeSync(fd);
  exportPruefen(daten, ordner);
  return { ordner, fotos: fotos.size, bytes: [...fotos.values()].reduce((s, f) => s + f.bytes, 0) };
}
/** Jede exportierte Datei ergibt wieder EXAKT die ursprüngliche data:-URL (Prüfsumme). */
function exportPruefen(daten, ordner) {
  const dir = join(daten, JOURNAL_DIR, ordner);
  if (!existsSync(join(dir, 'index.json'))) fail(`Foto-Export ${ordner} fehlt`);
  const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
  for (const [h, f] of Object.entries(index.fotos)) {
    const p = join(dir, f.datei);
    if (!existsSync(p)) fail(`Foto-Export: ${f.datei} fehlt`);
    if (sha256(Buffer.from(urlAusDatei(readFileSync(p), f.kopf), 'utf8')) !== h) fail(`Foto-Export: ${f.datei} ergibt nicht mehr das Original`);
  }
  return index;
}

// ── Journal ─────────────────────────────────────────────────────────────────────────────────
function journale(daten) {
  const dir = join(daten, JOURNAL_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => PREFIXE.some((p) => f.startsWith(p)) && f.endsWith('.json')).sort()
    .map((f) => ({ datei: join(dir, f), inhalt: JSON.parse(readFileSync(join(dir, f), 'utf8')) }));
}
function offenesJournal(daten) {
  return journale(daten).find((j) => j.inhalt.stand !== 'abgeschlossen') ?? null;
}
function journalSchreiben(datei, inhalt) {
  const tmp = `${datei}.tmp`;
  writeFileSync(tmp, JSON.stringify(inhalt, null, 1));
  const fd = openSync(tmp, 'r+'); fsyncSync(fd); closeSync(fd);
  renameSync(tmp, datei);           // ersetzt atomar — nie eine halbe Journal-Datei
}
const aufgabeDesJournals = (j) => AUFGABEN[j.aufgabe ?? '1'] ?? fail(`Journal mit unbekannter Aufgabe ${j.aufgabe}`);

// ── Sicherungsnachweis ──────────────────────────────────────────────────────────────────────
function sicherungenNachweisen(daten, sicherungen, name) {
  if (!Array.isArray(sicherungen) || sicherungen.length !== 2) fail('genau zwei --sicherung (E: und F:) angeben');
  const dirs = sicherungen.map((s) => resolve(s));
  const wurzeln = dirs.map((d) => parse(d).root.toLowerCase());
  if (wurzeln[0] === wurzeln[1]) fail('beide Sicherungen liegen auf demselben Laufwerk — E: UND F: verlangt');
  const heute = dbDateien(daten);
  const out = [];
  for (const d of dirs) {
    const mf = join(d, 'MANIFEST-sha256.json');
    if (!existsSync(mf)) fail(`keine geprüfte Sicherung (Manifest fehlt): ${d}`);
    const m = JSON.parse(readFileSync(mf, 'utf8'));
    if (m.name !== name) fail(`Sicherung ${d} heißt „${m.name}", --bestaetigen verlangt „${name}"`);
    const soll = new Map(m.dateien.map((e) => [e.file, e.sha256]));
    for (const f of [PRIMARY, SERVER, ...BEGLEITER.flatMap((b) => [PRIMARY + b, SERVER + b])]) {
      const jetzt = heute[f] ?? null;
      const imManifest = soll.get(f) ?? null;
      if (jetzt !== imManifest) fail(`${f}: Datenordner und Sicherung ${d} weichen ab — Sicherung nicht frisch oder nicht zusammengehörig`);
      if (imManifest && fileSha(join(d, 'Data', f)) !== imManifest) fail(`${f}: Kopie in ${d} weicht vom Manifest ab — Sicherung beschädigt`);
    }
    out.push({ ordner: d, name: m.name, erstellt: m.erstellt });
  }
  return { sicherungen: out, dateien: heute };
}
function sicherungenHaltenVorher(j) {
  for (const s of j.sicherungen) {
    const m = JSON.parse(readFileSync(join(s.ordner, 'MANIFEST-sha256.json'), 'utf8'));
    for (const [f, h] of Object.entries(j.dateienVorher)) {
      const e = m.dateien.find((x) => x.file === f);
      if (!e || e.sha256 !== h || fileSha(join(s.ordner, 'Data', f)) !== h) fail(`Sicherung ${s.ordner} hält den Vorher-Stand nicht mehr (${f}) — nicht fortsetzen`);
    }
  }
}

// ── Schreiben ────────────────────────────────────────────────────────────────────────────────
function testabbruch(punkt) {
  if (process.env.LATAIF_A2_TESTABBRUCH === punkt) fail(`TESTABBRUCH ${punkt}`);
}
/** Changelog-Zeilen einer Seite in EINER Transaktion (Vergleich-und-Tausch je Zeile). */
function seiteUmwandeln(db, plan, label) {
  if (plan.changes.length === 0) return 0;
  const upd = db.prepare('UPDATE sync_changelog SET data = ? WHERE id = ? AND data = ?');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const c of plan.changes) {
      const r = upd.run(c.to, c.id, c.from);
      if (Number(r.changes) !== 1) fail(`${label} #${c.id}: Zeile nicht wie geplant vorgefunden — nichts übernommen`);
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* schon zurück */ }
    throw e;
  }
  return plan.changes.length;
}
function auditUmwandeln(db, plan) {
  if (plan.changes.length === 0) return;
  const mitAlt = auditSpalten(db).has('old_value');
  const upd = mitAlt
    ? db.prepare('UPDATE audit_log SET old_value = ?, new_value = ? WHERE id = ? AND old_value IS ? AND new_value IS ?')
    : db.prepare('UPDATE audit_log SET new_value = ? WHERE id = ? AND new_value IS ?');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const c of plan.changes) {
      const r = mitAlt ? upd.run(c.altTo, c.neuTo, c.id, c.altFrom, c.neuFrom) : upd.run(c.neuTo, c.id, c.neuFrom);
      if (Number(r.changes) !== 1) fail(`Audit ${c.id}: Zeile nicht wie geplant vorgefunden — nichts übernommen`);
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* */ }
    throw e;
  }
}

let SQLJS = null;
/** Lädt die Datei so, wie die App es tut (sql.js, ganze Datei in den Speicher) — und prüft sie dort. */
async function sqlJsLaedt(pfad, tabellenErwartet) {
  if (!SQLJS) SQLJS = await createRequire(import.meta.url)('sql.js')();
  const db = new SQLJS.Database(readFileSync(pfad));
  try {
    const ic = db.exec('PRAGMA integrity_check')[0]?.values?.[0]?.[0];
    if (ic !== 'ok') fail(`sql.js: integrity_check ${ic}`);
    const n = db.exec("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")[0].values[0][0];
    if (Number(n) !== tabellenErwartet) fail(`sql.js sieht ${n} statt ${tabellenErwartet} Tabellen`);
  } finally { db.close(); }
}
const syncDatei = (p) => { const fd = openSync(p, 'r+'); fsyncSync(fd); closeSync(fd); };

/**
 * Primary ersetzen: die neue Datei entsteht als KOPIE neben `lataif.db` (umgewandelt oder verdichtet), wird dort
 * nachgeprüft (Aufgabe + integrity_check + Laden mit sql.js wie in der App) und erst dann per Umbenennen atomar
 * eingesetzt. Die App lädt `lataif.db` roh und wertet kein SQLite-Rücksetz-Journal aus — so gibt es zu jedem
 * Zeitpunkt nur die ganze alte oder die ganze neue Datei.
 */
async function primaryErsetzen(daten, dbs, o, { verdichten, arbeit, pruefung }) {
  if (!verdichten && !arbeit) { pruefung(dbs.p); return; }   // nichts zu ändern → Datei bleibt unberührt
  const ziel = join(daten, PRIMARY);
  const neu = ziel + NEU;
  for (const f of [neu, neu + '-journal']) if (existsSync(f)) rmSync(f);
  const tabellenZahl = tabellen(dbs.p).length;
  if (verdichten) {
    dbs.p.exec(`VACUUM INTO '${sqlPfad(neu)}'`);
    dbs.p.close(); dbs.p = null;
  } else {
    dbs.p.close(); dbs.p = null;
    copyFileSync(ziel, neu);
  }
  const c = new DatabaseSync(neu);
  try {
    c.exec('PRAGMA locking_mode = EXCLUSIVE');
    if (arbeit) arbeit(c);
    pruefung(c);
    integritaet(c, 'Primary-Kopie');
  } finally { c.close(); }
  if (existsSync(neu + '-journal')) fail('Primary-Kopie nicht sauber geschlossen — nichts eingesetzt');
  await sqlJsLaedt(neu, tabellenZahl);
  syncDatei(neu);
  testabbruch('vor-tausch');
  appMussZuSein(o);
  renameSync(neu, ziel);                       // atomar: ganz alt ODER ganz neu
  dbs.p = oeffneEine(ziel);
  pruefung(dbs.p);
}
/** Server verdichten: Checkpoint, VACUUM INTO eine Kopie, dort nachgeprüft, dann atomar eingesetzt. */
function serverVerdichten(daten, dbs, o, pruefung) {
  const ziel = join(daten, SERVER);
  const neu = ziel + NEU;
  for (const f of [neu, ...BEGLEITER.map((b) => neu + b)]) if (existsSync(f)) rmSync(f);
  dbs.s.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  dbs.s.exec(`VACUUM INTO '${sqlPfad(neu)}'`);
  const c = new DatabaseSync(neu);
  try {
    pruefung(c);
    integritaet(c, 'Server-Kopie');
    c.exec('PRAGMA journal_mode = WAL');        // wie der Server die Datei führt
  } finally { c.close(); }
  for (const b of BEGLEITER) if (existsSync(neu + b)) rmSync(neu + b);
  syncDatei(neu);
  dbs.s.close(); dbs.s = null;
  for (const b of BEGLEITER) {
    const p = ziel + b;
    if (!existsSync(p)) continue;
    if (b === '-wal' && statSync(p).size !== 0) fail('Server-WAL nach dem Checkpoint nicht leer — nichts eingesetzt');
    rmSync(p);                                 // leer → gehört zur alten Datei, trägt nichts
  }
  testabbruch('vor-server-tausch');
  appMussZuSein(o);
  renameSync(neu, ziel);
  dbs.s = oeffneEine(ziel);
  pruefung(dbs.s);
}

// ── Aufgaben: Vorbereitung (Plan + Journal-Inhalt), Durchführung, Nachweis ───────────────────────
function vorbereiten(a, daten, dbs, o) {
  const kz = kennzahlen(daten, dbs);
  const basis = { kennzahlen: kz };
  if (a.art === 'changelog') {
    const geschuetzt = a.id === '3' ? inlineArtikelHeute(dbs.p) : [];
    const l = lage(daten, dbs, bestaetigteNurPrimary(o), regelFuer(a, { geschuetzt }));
    if (l.probleme.length) fail(`Vorbedingungen nicht erfüllt: ${l.probleme.join(' | ')}`);
    return { ...basis, fingerprint: l.fp, cursor: l.cursor, serverMax: l.serverMax, gepaart: l.abgleich.paired, eigenerAnfang: l.eigenerAnfang,
      nurPrimary: l.abgleich.primaryOnly.map((x) => x.id), geschuetzt,
      primary: { zeilen: l.pRows.length, letzteId: l.pRows[l.pRows.length - 1]?.id ?? 0, vorher: changelogDigest(l.pRows), nachher: geplantDigest(l.pRows, l.pPlan), ...zahlen(l.pPlan) },
      server: { zeilen: l.sRows.length, letzteId: l.sRows[l.sRows.length - 1]?.id ?? 0, vorher: changelogDigest(l.sRows), nachher: geplantDigest(l.sRows, l.sPlan), ...zahlen(l.sPlan) },
      primaryUnberuehrt: inhalt(dbs.p, ['sync_changelog']), serverUnberuehrt: inhalt(dbs.s, ['sync_changelog']) };
  }
  // Stufe 2 und Verdichten: der Abgleich muss sauber stehen (gleiche Bedingungen wie Stufe 1, ohne Änderungsplan).
  const l = lage(daten, dbs, bestaetigteNurPrimary(o), RULE_KEINE);
  if (l.probleme.length) fail(`Vorbedingungen nicht erfüllt: ${l.probleme.join(' | ')}`);
  if (a.art === 'audit') {
    const plan = auditPlan(dbs.p);
    return { ...basis, fingerprint: l.fp, nurPrimary: l.abgleich.primaryOnly.map((x) => x.id),
      audit: { zeilen: plan.zeilen, zuAendern: plan.changes.length, bytesVorher: plan.bytesVorher, bytesNachher: plan.bytesNachher,
        vorher: tabelleDigest(dbs.p, 'audit_log'), nachher: auditDigestGeplant(dbs.p, plan),
        // Nachvollziehbarkeit je Eintrag: welcher Original-Wert (SHA-256) welchen Kurznachweis ergab.
        eintraege: plan.changes.map((c) => ({ id: c.id, altSha: c.altFrom == null ? null : sha256(String(c.altFrom)), neuSha: c.neuFrom == null ? null : sha256(String(c.neuFrom)), neu: c.neuTo, alt: c.altTo })) },
      primaryUnberuehrt: inhalt(dbs.p, ['audit_log']), serverUnberuehrt: inhalt(dbs.s) };
  }
  integritaet(dbs.p, 'Primary'); integritaet(dbs.s, 'Server');
  return { ...basis, fingerprint: l.fp, nurPrimary: l.abgleich.primaryOnly.map((x) => x.id),
    primaryInhalt: inhalt(dbs.p), serverInhalt: inhalt(dbs.s), groessenVorher: groessen(daten) };
}

async function durchfuehren(a, daten, dbs, j, datei, o) {
  if (a.art === 'changelog') {
    const l = lage(daten, dbs, j.nurPrimary ?? [], regelFuer(a, j));
    if (a.id === '3' && !j.export) {
      j.export = fotosExportieren(daten, j.begonnen.replace(/[:.]/g, '-'), l.pPlan, l.sPlan);
      journalSchreiben(datei, j);
      testabbruch('nach-export');
    }
    if (j.export) exportPruefen(daten, j.export.ordner);
    appMussZuSein(o);
    await primaryErsetzen(daten, dbs, o, {
      arbeit: l.pPlan.changes.length ? (c) => seiteUmwandeln(c, l.pPlan, 'Primary') : null,
      pruefung: (c) => seiteNachweisen(zeilenPrimary(c), j.primary, 'Primary'),
    });
    j.stand = 'primary-fertig'; journalSchreiben(datei, j);
    testabbruch('nach-primary');
    appMussZuSein(o);
    seiteUmwandeln(dbs.s, l.sPlan, 'Server');
    dbs.s.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    seiteNachweisen(zeilenServer(dbs.s), j.server, 'Server');
  } else if (a.art === 'audit') {
    const plan = auditPlan(dbs.p);
    appMussZuSein(o);
    await primaryErsetzen(daten, dbs, o, {
      arbeit: plan.changes.length ? (c) => auditUmwandeln(c, plan) : null,
      pruefung: (c) => { if (tabelleDigest(c, 'audit_log') !== j.audit.nachher) fail('Audit nach der Umwandlung nicht wie geplant — nichts eingesetzt'); },
    });
    j.stand = 'primary-fertig'; journalSchreiben(datei, j);
    testabbruch('nach-primary');
  } else {
    appMussZuSein(o);
    await primaryErsetzen(daten, dbs, o, {
      verdichten: true,
      pruefung: (c) => { if (!gleich(inhalt(c), j.primaryInhalt)) fail('Primary nach dem Verdichten inhaltlich verändert (Zeilen oder rowids) — nichts eingesetzt'); },
    });
    j.stand = 'primary-fertig'; journalSchreiben(datei, j);
    testabbruch('nach-primary');
    serverVerdichten(daten, dbs, o, (c) => { if (!gleich(inhalt(c), j.serverInhalt)) fail('Server nach dem Verdichten inhaltlich verändert — nichts eingesetzt'); });
  }
  j.stand = 'server-fertig'; journalSchreiben(datei, j);
  testabbruch('nach-server');
}

/** Nachher-Nachweis einer Changelog-Seite gegen das Journal. */
function seiteNachweisen(rows, journalSeite, label) {
  const d = changelogDigest(rows);
  if (d !== journalSeite.nachher) fail(`${label}: Changelog nach der Umwandlung nicht wie geplant — Lauf angehalten`);
  if (rows.length !== journalSeite.zeilen || rows[rows.length - 1]?.id !== journalSeite.letzteId) fail(`${label}: Zeilenzahl/Nummern verändert — Lauf angehalten`);
}

/** Gesamtnachweis einer Aufgabe — nach dem Lauf UND bei `freigeben`. */
function nachpruefen(a, daten, dbs, j) {
  if (!gleich(kennzahlen(daten, dbs), a.art === 'changelog' ? kennzahlenNachChangelog(j) : j.kennzahlen)) {
    fail('Abgleich-Kennzahlen (Cursor, Server-Ende, Paare, Cursor-Neuaufbau) verändert');
  }
  if (a.art === 'changelog') {
    const l = lage(daten, dbs, j.nurPrimary ?? [], regelFuer(a, j));
    if (l.probleme.length) fail(`nach dem Lauf: ${l.probleme.join(' | ')}`);
    seiteNachweisen(l.pRows, j.primary, 'Primary');
    seiteNachweisen(l.sRows, j.server, 'Server');
    if (l.pPlan.changes.length || l.sPlan.changes.length) fail('nach dem Lauf noch zu verschlankende Einträge — Lauf angehalten');
    if (l.abgleich.paired !== j.gepaart) fail('Primary und Server passen nach dem Lauf nicht mehr Byte für Byte zusammen');
    if (l.eigenerAnfang !== j.eigenerAnfang) fail(`Cursor-Neuaufbau würde anders entscheiden (${j.eigenerAnfang} → ${l.eigenerAnfang})`);
    if (l.cursor !== j.cursor || l.serverMax !== j.serverMax) fail('Cursor oder letzte Server-Nummer verändert');
    if (!gleich(inhalt(dbs.p, ['sync_changelog']), j.primaryUnberuehrt)) fail('Primary: Tabellen außer dem Changelog verändert');
    if (!gleich(inhalt(dbs.s, ['sync_changelog']), j.serverUnberuehrt)) fail('Server: Tabellen außer dem Changelog verändert');
    if (j.export) exportPruefen(daten, j.export.ordner);
  } else if (a.art === 'audit') {
    if (tabelleDigest(dbs.p, 'audit_log') !== j.audit.nachher) fail('Audit nicht wie geplant');
    if (auditPlan(dbs.p).changes.length) fail('Audit: noch Vektoren vorhanden');
    if (!gleich(inhalt(dbs.p, ['audit_log']), j.primaryUnberuehrt)) fail('Primary: Tabellen außer dem Audit verändert');
    if (!gleich(inhalt(dbs.s), j.serverUnberuehrt)) fail('Server verändert');
  } else {
    integritaet(dbs.p, 'Primary'); integritaet(dbs.s, 'Server');
    if (!gleich(inhalt(dbs.p), j.primaryInhalt)) fail('Primary inhaltlich verändert');
    if (!gleich(inhalt(dbs.s), j.serverInhalt)) fail('Server inhaltlich verändert');
  }
}
/** Stufe 1/3 ändern Changelog-Daten: die EXAKTE Paarung (ohne Regel) ist danach so wie geplant, die Zahlen bleiben. */
function kennzahlenNachChangelog(j) {
  return { ...j.kennzahlen, gepaart: j.gepaart, nurServer: j.kennzahlen.zeilenServer - j.gepaart, eigenerAnfang: j.eigenerAnfang };
}

function abschluss(a, daten, dbs, j, datei) {
  nachpruefen(a, daten, dbs, j);
  j.stand = 'abgeschlossen';
  j.abgeschlossen = new Date().toISOString();
  if (a.art === 'verdichten') j.groessenNachher = groessen(daten);
  journalSchreiben(datei, j);
  const r = { ok: true, aufgabe: a.id, stand: j.stand, journal: datei };
  if (a.art === 'changelog') {
    r.primary = { geaendert: j.primary.zuAendern, bytesVorher: j.primary.bytesVorher, bytesNachher: j.primary.bytesNachher };
    r.server = { geaendert: j.server.zuAendern, bytesVorher: j.server.bytesVorher, bytesNachher: j.server.bytesNachher };
    if (j.export) r.export = j.export;
  } else if (a.art === 'audit') {
    r.audit = { geaendert: j.audit.zuAendern, bytesVorher: j.audit.bytesVorher, bytesNachher: j.audit.bytesNachher };
  } else {
    r.groessen = { vorher: j.groessenVorher, nachher: j.groessenNachher };
  }
  return r;
}

// ── Modi ────────────────────────────────────────────────────────────────────────────────────
/** `pruefen` liest NIE im Datenordner selbst (auch ein lesendes Öffnen einer WAL-Datenbank kann dort Begleit-
 *  dateien anlegen) — sondern auf einer temporären Kopie beider Datenbanken. */
function lesekopie(daten) {
  const tmp = mkdtempSync(join(tmpdir(), 'lataif-a2-'));
  for (const db of [PRIMARY, SERVER]) {
    for (const suffix of ['', ...BEGLEITER]) {
      const p = join(daten, db + suffix);
      if (existsSync(p)) copyFileSync(p, join(tmp, db + suffix));
    }
  }
  return tmp;
}
function pruefen(o) {
  const daten = resolve(o.daten ?? fail('--daten fehlt'));
  const a = aufgabeVon(o, '1');
  appMussZuSein(o);
  const kopie = lesekopie(daten);
  const p = new DatabaseSync(join(kopie, PRIMARY));
  const s = new DatabaseSync(join(kopie, SERVER));
  const dbs = { p, s, close: () => { try { p.close(); } catch { /* */ } try { s.close(); } catch { /* */ } rmSync(kopie, { recursive: true, force: true }); } };
  try {
    const geschuetzt = inlineArtikelHeute(dbs.p);
    const l = lage(daten, dbs, bestaetigteNurPrimary(o), a.art === 'changelog' ? regelFuer(a, { geschuetzt }) : RULE_KEINE);
    const sperre = sperreLesen(daten);
    const probleme = [...unsauber(daten), ...(sperre ? [`Wartungssperre liegt (${sperre.stand}) — „fortsetzen" oder „freigeben"`] : []), ...l.probleme];
    const ap = auditPlan(dbs.p);
    const l3 = a.id === '3' ? l : lage(daten, dbs, bestaetigteNurPrimary(o), regelFuer(AUFGABEN[3], { geschuetzt }));
    return {
      ok: probleme.length === 0, modus: 'pruefen', aufgabe: a.id, geschrieben: false,
      cursor: l.cursor, serverMax: l.serverMax, gepaart: l.abgleich.paired, nurServer: l.abgleich.serverOnly,
      nurPrimary: l.abgleich.primaryOnly, eigenerAnfang: l.eigenerAnfang, primary: zahlen(l.pPlan), server: zahlen(l.sPlan),
      stufen: {
        1: a.id === '1' ? { primary: zahlen(l.pPlan), server: zahlen(l.sPlan) } : null,
        2: { zeilen: ap.zeilen, zuAendern: ap.changes.length, bytesVorher: ap.bytesVorher, bytesNachher: ap.bytesNachher },
        3: { primary: zahlen(l3.pPlan), server: zahlen(l3.sPlan), geschuetzteArtikel: geschuetzt.length },
      },
      groessen: groessen(daten), offenesJournal: offenesJournal(daten)?.datei ?? null, restKopie: restKopien(daten).length > 0,
      sperre: sperre?.stand ?? null, probleme,
    };
  } finally { dbs.close(); }
}

async function ausfuehren(o) {
  const daten = resolve(o.daten ?? fail('--daten fehlt'));
  const a = aufgabeVon(o);
  const name = o.bestaetigen ?? fail('--bestaetigen <Sicherungsname> fehlt');
  if (!existsSync(join(daten, PRIMARY))) fail(`Datenordner ohne ${PRIMARY}: ${daten}`);
  if (sperreLesen(daten)) fail('Wartungssperre liegt schon (laufender oder abgebrochener Lauf) — „fortsetzen" oder „freigeben"');
  const offen = offenesJournal(daten);
  if (offen) fail(`offener Lauf ${offen.datei} (${offen.inhalt.stand}) — erst „fortsetzen" oder den Sicherungssatz zurückspielen`);
  for (const x of unsauber(daten)) fail(x);
  const rest = restKopien(daten);
  if (rest.length) fail(`${rest.join(', ')} liegt im Datenordner — Rest eines abgebrochenen Laufs ohne Journal; prüfen und entfernen`);
  const dateienBeiSperre = dbDateien(daten);
  // ZUERST sperren, DANN prüfen, ob eine App läuft: eine App, die zwischen beidem startet, wird erkannt —
  // jede spätere findet die Sperre und startet nicht.
  sperreAnlegen(daten, { werkzeug: 'changelog-schlankung/2', aufgabe: a.id, stand: 'vorbereitung', angelegt: new Date().toISOString(), dateien: dateienBeiSperre });
  testabbruch('nach-sperre');
  let dbs = null;
  let geschrieben = false;
  try {
    appMussZuSein(o);
    const nachweis = sicherungenNachweisen(daten, o.sicherung, name);   // VOR dem ersten Öffnen: Dateien unverändert
    if (!gleich(nachweis.dateien, dateienBeiSperre)) fail('Datenbankdateien seit dem Anlegen der Sperre verändert');
    dbs = oeffnen(daten);
    const plan = vorbereiten(a, daten, dbs, o);
    const j = { werkzeug: 'changelog-schlankung/2', aufgabe: a.id, stand: 'begonnen', begonnen: new Date().toISOString(),
      sicherungen: nachweis.sicherungen, dateienVorher: nachweis.dateien, ...plan };
    mkdirSync(join(daten, JOURNAL_DIR), { recursive: true });
    const datei = join(daten, JOURNAL_DIR, `${a.prefix}${j.begonnen.replace(/[:.]/g, '-')}.json`);
    journalSchreiben(datei, j);
    geschrieben = true;   // ab hier bleibt die Sperre bei JEDEM Abbruch liegen
    sperreSetzen(daten, { werkzeug: 'changelog-schlankung/2', aufgabe: a.id, stand: 'laeuft', angelegt: j.begonnen, journal: basename(datei) });
    await durchfuehren(a, daten, dbs, j, datei, o);
    const r = abschluss(a, daten, dbs, j, datei);
    dbs.close(); dbs = null;
    testabbruch('vor-freigabe');
    sperreEntfernen(daten);                 // erst nach bestandenem Gesamtnachweis
    return { ...r, sperre: 'entfernt' };
  } catch (e) {
    if (!geschrieben) {                     // nichts geschrieben → die eigene Sperre wieder weg
      try { dbs?.close(); } catch { /* */ }
      dbs = null;
      try { sperreEntfernen(daten); } catch { /* */ }
    }
    throw e;
  } finally { dbs?.close(); }
}

async function fortsetzen(o) {
  const daten = resolve(o.daten ?? fail('--daten fehlt'));
  appMussZuSein(o);
  const offen = offenesJournal(daten) ?? fail('kein offener Lauf');
  const j = offen.inhalt;
  const a = aufgabeDesJournals(j);
  for (const x of unsauber(daten)) fail(x);
  // Sofort (wieder) sperren — fehlte die Sperre, könnte inzwischen jemand gestartet haben; die Nachweise unten
  // erkennen jedes Schreiben, die Sperre verhindert jedes weitere.
  if (!sperreLesen(daten)) sperreAnlegen(daten, { werkzeug: 'changelog-schlankung/2', aufgabe: a.id, stand: 'laeuft', angelegt: new Date().toISOString(), journal: basename(offen.datei) });
  // Die Sicherungen des Laufs müssen unversehrt den VORHER-Stand halten — sie sind der Rückweg.
  sicherungenHaltenVorher(j);
  for (const f of restKopien(daten)) rmSync(join(daten, f));     // eine nicht eingesetzte Kopie trägt nichts
  const dbs = oeffnen(daten);
  try {
    // Jede Datenbank muss für sich VORHER oder NACHHER stehen — und sonst darf nichts geschrieben worden sein.
    if (a.art === 'changelog') {
      const l = lage(daten, dbs, j.nurPrimary ?? [], regelFuer(a, j));
      if (l.fp !== j.fingerprint || l.cursor !== j.cursor || l.serverMax !== j.serverMax) fail('Identität, Cursor oder Server-Nummer seit dem Abbruch verändert — Sicherungssatz zurückspielen');
      if (!gleich(inhalt(dbs.p, ['sync_changelog']), j.primaryUnberuehrt) || !gleich(inhalt(dbs.s, ['sync_changelog']), j.serverUnberuehrt)) {
        fail('seit dem Abbruch wurde geschrieben — Sicherungssatz zurückspielen');
      }
      for (const [rows, seite, label] of [[l.pRows, j.primary, 'Primary'], [l.sRows, j.server, 'Server']]) {
        const d = changelogDigest(rows);
        if (d !== seite.vorher && d !== seite.nachher) fail(`${label}: weder Vorher- noch Nachher-Stand — Sicherungssatz zurückspielen`);
      }
      if (l.probleme.length) fail(`Vorbedingungen nicht erfüllt: ${l.probleme.join(' | ')}`);
    } else if (a.art === 'audit') {
      const d = tabelleDigest(dbs.p, 'audit_log');
      if (d !== j.audit.vorher && d !== j.audit.nachher) fail('Audit: weder Vorher- noch Nachher-Stand — Sicherungssatz zurückspielen');
      if (!gleich(inhalt(dbs.p, ['audit_log']), j.primaryUnberuehrt) || !gleich(inhalt(dbs.s), j.serverUnberuehrt)) fail('seit dem Abbruch wurde geschrieben — Sicherungssatz zurückspielen');
    } else if (!gleich(inhalt(dbs.p), j.primaryInhalt) || !gleich(inhalt(dbs.s), j.serverInhalt)) {
      fail('seit dem Abbruch wurde geschrieben (oder eine Verdichtung hat Inhalte verändert) — Sicherungssatz zurückspielen');
    }
    await durchfuehren(a, daten, dbs, j, offen.datei, o);
    const r = abschluss(a, daten, dbs, j, offen.datei);
    dbs.close();
    testabbruch('vor-freigabe');
    sperreEntfernen(daten);                 // erst nach bestandenem Gesamtnachweis
    return { ...r, fortgesetzt: true, sperre: 'entfernt' };
  } finally { dbs.close(); }
}

/** Eine liegengebliebene Sperre nur nach geprüftem Zustand entfernen. */
function freigeben(o) {
  const daten = resolve(o.daten ?? fail('--daten fehlt'));
  appMussZuSein(o);
  const s = sperreLesen(daten) ?? fail('keine Wartungssperre vorhanden');
  if (offenesJournal(daten)) fail('offener Lauf — erst „fortsetzen" (oder den Sicherungssatz zurückspielen)');
  for (const x of unsauber(daten)) fail(x);
  if (restKopien(daten).length) fail('Rest-Kopie liegt im Datenordner — nicht freigeben');
  if (!s.journal) {
    // Der Lauf endete vor dem ersten Schreiben: die Dateien müssen exakt die beim Anlegen der Sperre sein.
    if (!s.dateien || !gleich(dbDateien(daten), s.dateien)) fail('Datenbankdateien weichen vom Stand beim Anlegen der Sperre ab — Sicherungssatz zurückspielen');
    sperreEntfernen(daten);
    return { ok: true, modus: 'freigeben', grund: 'Lauf endete vor dem ersten Schreiben; Dateien unverändert', sperre: 'entfernt' };
  }
  const j = journale(daten).find((x) => basename(x.datei) === s.journal) ?? fail('das Journal der Sperre fehlt — Sicherungssatz zurückspielen');
  if (j.inhalt.stand !== 'abgeschlossen') fail(`Journal steht auf „${j.inhalt.stand}" — erst „fortsetzen"`);
  const dbs = oeffnen(daten);
  try { nachpruefen(aufgabeDesJournals(j.inhalt), daten, dbs, j.inhalt); } finally { dbs.close(); }
  sperreEntfernen(daten);
  return { ok: true, modus: 'freigeben', grund: 'Lauf abgeschlossen und erneut nachgeprüft', sperre: 'entfernt' };
}

/** Stufe 2 nachvollziehen: jeder Kurznachweis im Audit entspricht genau dem Original in einer Sicherung von VORHER. */
function nachweisenAudit(o) {
  const daten = resolve(o.daten ?? fail('--daten fehlt'));
  const sich = resolve((o.sicherung ?? [])[0] ?? fail('--sicherung <Ordner der Sicherung von vor Stufe 2> fehlt'));
  const quelle = existsSync(join(sich, 'Data', PRIMARY)) ? join(sich, 'Data') : sich;
  const k1 = lesekopie(daten), k2 = lesekopie(quelle);
  const jetzt = new DatabaseSync(join(k1, PRIMARY)), vorher = new DatabaseSync(join(k2, PRIMARY));
  try {
    const ph = EMBEDDING_FELDER.map(() => '?').join(',');
    const alt = new Map(vorher.prepare(`SELECT * FROM audit_log WHERE field_name IN (${ph})`).all(...EMBEDDING_FELDER).map((r) => [String(r.id), r]));
    let ok = 0, ersetzt = 0; const fehler = [];
    for (const r of jetzt.prepare(`SELECT * FROM audit_log WHERE field_name IN (${ph})`).all(...EMBEDDING_FELDER)) {
      const a = alt.get(String(r.id));
      if (!a) { fehler.push(`${r.id}: fehlt in der Sicherung`); continue; }
      for (const k of Object.keys(r)) if (k !== 'old_value' && k !== 'new_value' && r[k] !== a[k]) fehler.push(`${r.id}: ${k} verändert`);
      for (const k of ['old_value', 'new_value']) {
        if (r[k] === a[k]) continue;
        if (auditErsatz(a[k]) === r[k]) ersetzt++;
        else fehler.push(`${r.id}: ${k} entspricht nicht dem Original`);
      }
      ok++;
    }
    return { ok: fehler.length === 0, modus: 'nachweisen-audit', eintraege: ok, ersetzteWerte: ersetzt, fehler: fehler.slice(0, 20) };
  } finally {
    jetzt.close(); vorher.close();
    rmSync(k1, { recursive: true, force: true }); rmSync(k2, { recursive: true, force: true });
  }
}

try {
  const [mode, ...rest] = process.argv.slice(2);
  const o = args(rest);
  const r = mode === 'pruefen' ? pruefen(o) : mode === 'ausfuehren' ? await ausfuehren(o) : mode === 'fortsetzen' ? await fortsetzen(o)
    : mode === 'freigeben' ? freigeben(o) : mode === 'nachweisen-audit' ? nachweisenAudit(o)
      : fail('Modus: pruefen | ausfuehren | fortsetzen | freigeben | nachweisen-audit');
  console.log(JSON.stringify(r, null, 1));
  // Nicht `process.exit()`: nach dem Laden von sql.js (WebAssembly) schließt libuv noch Handles — ein hartes Beenden
  // mittendrin bricht unter Windows mit einer Assertion ab. Der Prozess endet von selbst mit diesem Code.
  process.exitCode = r.ok ? 0 : 2;
} catch (e) {
  console.error(JSON.stringify({ ok: false, abbruch: e instanceof Abbruch ? e.message : String(e?.stack ?? e) }, null, 1));
  process.exitCode = 1;
}
