#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
// LATAIF — Weg A2, Stufe 1: historische Changelog-Einträge verschlanken (NUR `image_embedding` aus Artikel-
// Payloads), auf Primary (`lataif.db`) UND Server (`lataif_sync_server.db`) gleich — bei GESCHLOSSENER App.
//
//   pruefen     --daten <Datenordner> [--nur-pfad <exe>]
//   ausfuehren  --daten <Datenordner> --sicherung <E:\…\Name> --sicherung <F:\…\Name> --bestaetigen <Name>
//               [--erlaube-nur-primary <id,id>] [--nur-pfad <exe>]
//   fortsetzen  --daten <Datenordner> [--nur-pfad <exe>]
//   freigeben   --daten <Datenordner> [--nur-pfad <exe>]   (liegengebliebene Sperre nach geprüftem Zustand entfernen)
//
// WARTUNGSSPERRE: `ausfuehren` legt ZUERST `WARTUNG-LAEUFT.lock` im Datenordner exklusiv an; solange sie liegt,
// startet LATAIF nicht (src-tauri/src/maintenance_lock.rs) — also auch kein Server, kein PC2, kein Handy. Ab dem
// ersten Schreiben bleibt sie bei jedem Abbruch liegen; sie fällt nur nach bestandenem Gesamtnachweis
// (`ausfuehren`/`fortsetzen`), über `freigeben` nach geprüftem Zustand oder mit dem Zurückspielen des
// Sicherungssatzes (der Datenordner wird dabei ersetzt).
//
// Ablauf `ausfuehren` (jeder Schritt bricht VOR dem nächsten ab, wenn etwas nicht stimmt):
//   1. Exklusiv: kein `lataif.exe` läuft (ohne App kein Sync-Server → auch PC2 und Handy können nicht schreiben);
//      beide Datenbanken werden im EXCLUSIVE-Sperrmodus geöffnet und bis zum Ende gehalten.
//   2. Sicherungsnachweis: zwei mit `manuelle-sicherung.mjs` erstellte, gleichnamige Sicherungen auf ZWEI
//      verschiedenen Laufwerken; ihr Manifest UND ihre Kopien beider Datenbanken (samt -wal/-shm) sind
//      byte-gleich mit dem heutigen Datenordner → frisch, vollständig, zusammengehörig.
//   3. Identität und Folge: der Cursor des Primary gehört zu GENAU diesem Server (Fingerabdruck aus
//      `sync_install_id.key`, wie `install_id::public_fingerprint`) und steht auf dessen letzter Nummer; kein
//      eigener Eintrag ist ungesendet; jeder eigene Eintrag hat sein Gegenstück auf dem Server.
//   4. Journal (`maintenance-logs/a2-stufe1-<Zeit>.json`) mit Vorher-Prüfsummen und geplantem Nachher.
//   5. Primary: in einer KOPIE in EINER Transaktion umgewandelt (Vergleich-und-Tausch je Zeile:
//      `WHERE id = ? AND data = ?`), dort nachgerechnet + integrity_check, dann per Umbenennen atomar eingesetzt
//      (die App liest `lataif.db` roh und kennt kein SQLite-Journal) → Journal.
//   6. Server an Ort und Stelle in EINER Transaktion (nur über SQLite geöffnet; ein unterbrochenes WAL verwirft
//      SQLite selbst), Checkpoint → Journal. 7. Gesamtnachweis → Journal „abgeschlossen".
//
// Zwei SQLite-Transaktionen sind NICHT gemeinsam atomar. Deshalb ist die Umwandlung idempotent und das Journal
// hält fest, wo der Lauf steht: bricht er zwischen beiden Datenbanken ab (Absturz, Strom), stehen die
// Datenbanken je für sich vollständig vorher ODER nachher. `fortsetzen` prüft genau das (und dass sonst nichts
// geschrieben wurde) und erledigt den Rest; passt etwas nicht, bleibt alles stehen → Sicherungssatz mit
// `manuelle-sicherung.mjs zurueckspielen` einspielen (beide Datenbanken gemeinsam).
// Nicht angefasst: Zeilen, Nummern, Reihenfolge, alle anderen Felder, Inline-Bilder, Audit, Artikel (inkl.
// Embeddings), Rechnungen, Zahlungen, Buchungen. Kein VACUUM.
// ════════════════════════════════════════════════════════════════════════════
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, parse, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { planSide, reconcileSides, SLIM_KEY } from '../../src/core/sync/changelog-slim.ts';
import { ownPushedCounts, provenOwnPrefix } from '../../src/core/sync/cursor-store.ts';

const PRIMARY = 'lataif.db';
const SERVER = 'lataif_sync_server.db';
const BEGLEITER = ['-wal', '-shm'];
const JOURNAL_DIR = 'maintenance-logs';
const JOURNAL_PREFIX = 'a2-stufe1-';
const FINGERPRINT_DOMAIN = 'lataif/server-identity/v1\0';
const UNBERUEHRT = ['products', 'audit_log', 'invoices', 'invoice_lines', 'payments', 'ledger_entries', 'sync_cursor'];

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

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const fileSha = (p) => sha256(readFileSync(p));

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
/** Beide Datenbanken zum Schreiben öffnen. `p` wird beim Einsetzen der umgewandelten Kopie neu geöffnet. */
function oeffnen(daten) {
  return {
    p: oeffneEine(join(daten, PRIMARY)),
    s: oeffneEine(join(daten, SERVER)),
    close() { try { this.p?.close(); } catch { /* */ } try { this.s?.close(); } catch { /* */ } },
  };
}

/** Ein SQLite-Rücksetz-Journal neben `lataif.db` hieße: ein früherer SQLite-Schreiber endete mitten in einer
 *  Transaktion. Die App (sql.js, rohe Datei) wertet es nicht aus — darum hier nie weiterarbeiten. */
function unsauber(daten) {
  return existsSync(join(daten, PRIMARY + '-journal')) ? [`${PRIMARY}-journal vorhanden — die Datei ist nicht sauber geschlossen`] : [];
}
const NEU = '.a2-neu';

// ── Wartungssperre (gelesen von der App beim Start: src-tauri/src/maintenance_lock.rs) ─────────────────
// Liegt `WARTUNG-LAEUFT.lock` im Datenordner, startet LATAIF nicht (kein Server → auch PC2/Handy schreiben
// nicht). Angelegt wird sie exklusiv VOR jeder Prüfung; nach dem ersten Schreiben bleibt sie bei jedem Abbruch
// liegen und fällt erst nach bestandenem Gesamtnachweis (oder über `freigeben` nach geprüftem Zustand).
const SPERRE = 'WARTUNG-LAEUFT.lock';
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
/** Prüfsummen der Tabellen, die die Wartung NIE ändern darf (nur vorhandene). */
function unberuehrtDigests(db) {
  const out = {};
  for (const t of UNBERUEHRT) {
    const da = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    if (!da) continue;
    const h = createHash('sha256');
    for (const r of db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).iterate()) h.update(JSON.stringify(r) + '\n');
    out[t] = h.digest('hex');
  }
  return out;
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

/** Bestandsaufnahme beider Seiten — reines Lesen. */
function lage(daten, dbs, erlaubtNurPrimary = []) {
  const fp = serverFingerprint(daten);
  const cursor = dbs.p.prepare('SELECT server_fingerprint, last_sync_id FROM sync_cursor').all();
  const eigenerCursor = cursor.find((c) => c.server_fingerprint === fp) ?? null;
  const serverMax = Number(dbs.s.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM sync_changelog').get().m);
  const pRows = zeilenPrimary(dbs.p);
  const sRows = zeilenServer(dbs.s);
  const pPlan = planSide(pRows);
  const sPlan = planSide(sRows);
  const abgleich = reconcileSides(pRows, sRows);
  const probleme = [];
  if (!eigenerCursor) probleme.push('Primary hat keinen Cursor für GENAU diesen Server (Fingerabdruck) — Zugehörigkeit nicht belegt');
  else if (Number(eigenerCursor.last_sync_id) !== serverMax) probleme.push(`Cursor ${eigenerCursor.last_sync_id} ≠ letzte Server-Nummer ${serverMax} — Abgleich nicht vollständig`);
  if (pPlan.refused.length || sPlan.refused.length) probleme.push(`nicht byte-treu umwandelbare Einträge: Primary ${pPlan.refused.length}, Server ${sPlan.refused.length}`);
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

const zahlen = (plan) => ({ zeilen: plan.rows, zuAendern: plan.changes.length, bytesVorher: plan.bytesBefore, bytesNachher: plan.bytesAfter });

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
  appMussZuSein(o);
  const kopie = lesekopie(daten);
  const p = new DatabaseSync(join(kopie, PRIMARY));
  const s = new DatabaseSync(join(kopie, SERVER));
  const dbs = { p, s, close: () => { try { p.close(); } catch { /* */ } try { s.close(); } catch { /* */ } rmSync(kopie, { recursive: true, force: true }); } };
  try {
    const l = lage(daten, dbs, bestaetigteNurPrimary(o));
    const sperre = sperreLesen(daten);
    const probleme = [...unsauber(daten), ...(sperre ? [`Wartungssperre liegt (${sperre.stand}) — „fortsetzen" oder „freigeben"`] : []), ...l.probleme];
    return {
      ok: probleme.length === 0, modus: 'pruefen', geschrieben: false,
      cursor: l.cursor, serverMax: l.serverMax, gepaart: l.abgleich.paired, nurServer: l.abgleich.serverOnly,
      nurPrimary: l.abgleich.primaryOnly, eigenerAnfang: l.eigenerAnfang, primary: zahlen(l.pPlan), server: zahlen(l.sPlan),
      offenesJournal: offenesJournal(daten)?.datei ?? null, restKopie: existsSync(join(daten, PRIMARY + NEU)), sperre: sperre?.stand ?? null, probleme,
    };
  } finally { dbs.close(); }
}

// ── Journal ─────────────────────────────────────────────────────────────────────────────────
function journale(daten) {
  const dir = join(daten, JOURNAL_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.startsWith(JOURNAL_PREFIX) && f.endsWith('.json')).sort()
    .map((f) => ({ datei: join(dir, f), inhalt: JSON.parse(readFileSync(join(dir, f), 'utf8')) }));
}
function offenesJournal(daten) {
  return journale(daten).find((j) => j.inhalt.stand !== 'abgeschlossen') ?? null;
}
function journalSchreiben(datei, inhalt) {
  const tmp = `${datei}.tmp`;
  writeFileSync(tmp, JSON.stringify(inhalt, null, 1));
  renameSync(tmp, datei);           // ersetzt atomar — nie eine halbe Journal-Datei
}

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

// ── Eine Seite umwandeln ───────────────────────────────────────────────────────────────────
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
function testabbruch(punkt) {
  if (process.env.LATAIF_A2_TESTABBRUCH === punkt) fail(`TESTABBRUCH ${punkt}`);
}

/**
 * Primary: umwandeln in einer KOPIE, dort nachweisen (Changelog wie geplant, integrity_check), dann atomar
 * einsetzen (Umbenennen). Die App lädt `lataif.db` als rohe Datei (sql.js) und wertet kein SQLite-Rücksetz-
 * Journal aus — eine mitten in einer Transaktion abgebrochene Änderung IN der Datei könnte ihr eine halbe Datei
 * zeigen. So gibt es zu jedem Zeitpunkt nur die ganze alte oder die ganze neue Datei. (Der Server bleibt beim
 * Ändern an Ort und Stelle: er wird nur über SQLite geöffnet, das ein unterbrochenes WAL selbst verwirft.)
 */
function primaryUmwandeln(daten, dbs, plan, journalSeite, o) {
  if (plan.changes.length === 0) { seiteNachweisen(zeilenPrimary(dbs.p), journalSeite, 'Primary'); return; }
  const ziel = join(daten, PRIMARY);
  const neu = ziel + NEU;
  for (const f of [neu, neu + '-journal']) if (existsSync(f)) rmSync(f);
  dbs.p.close(); dbs.p = null;
  copyFileSync(ziel, neu);
  const c = new DatabaseSync(neu);
  try {
    c.exec('PRAGMA locking_mode = EXCLUSIVE');
    seiteUmwandeln(c, plan, 'Primary');
    seiteNachweisen(zeilenPrimary(c), journalSeite, 'Primary');
    const ic = Object.values(c.prepare('PRAGMA integrity_check').get())[0];
    if (ic !== 'ok') fail(`Primary-Kopie: integrity_check ${ic}`);
  } finally { c.close(); }
  if (existsSync(neu + '-journal')) fail('Primary-Kopie nicht sauber geschlossen — nichts eingesetzt');
  const fd = openSync(neu, 'r+'); fsyncSync(fd); closeSync(fd);
  testabbruch('vor-tausch');
  appMussZuSein(o);
  renameSync(neu, ziel);                       // atomar: ganz alt ODER ganz neu
  dbs.p = oeffneEine(ziel);
  seiteNachweisen(zeilenPrimary(dbs.p), journalSeite, 'Primary');
}

/** Nachher-Nachweis einer Seite gegen das Journal. */
function seiteNachweisen(rows, journalSeite, label) {
  const d = changelogDigest(rows);
  if (d !== journalSeite.nachher) fail(`${label}: Changelog nach der Umwandlung nicht wie geplant — Lauf angehalten`);
  if (rows.length !== journalSeite.zeilen || rows[rows.length - 1]?.id !== journalSeite.letzteId) fail(`${label}: Zeilenzahl/Nummern verändert — Lauf angehalten`);
}

function abschluss(daten, dbs, j, datei) {
  // Gesamtnachweis: beide Seiten in Zielform, eigene Einträge byte-gleich gepaart, sonst nichts verändert.
  const l = lage(daten, dbs, j.nurPrimary ?? []);
  if (l.probleme.length) fail(`nach dem Lauf: ${l.probleme.join(' | ')}`);
  seiteNachweisen(l.pRows, j.primary, 'Primary');
  seiteNachweisen(l.sRows, j.server, 'Server');
  if (l.pPlan.changes.length || l.sPlan.changes.length) fail('nach dem Lauf noch Einträge mit Vektor — Lauf angehalten');
  const exakt = reconcileSides(l.pRows, l.sRows);
  if (!exakt.ok || exakt.paired !== j.gepaart) fail('Primary und Server passen nach dem Lauf nicht mehr Byte für Byte zusammen');
  if (l.eigenerAnfang !== j.eigenerAnfang) fail(`Cursor-Neuaufbau würde anders entscheiden (${j.eigenerAnfang} → ${l.eigenerAnfang})`);
  if (l.cursor !== j.cursor || l.serverMax !== j.serverMax) fail('Cursor oder letzte Server-Nummer verändert');
  for (const [db, key] of [[dbs.p, 'primaryUnberuehrt'], [dbs.s, 'serverUnberuehrt']]) {
    if (JSON.stringify(unberuehrtDigests(db)) !== JSON.stringify(j[key])) fail(`unberührte Tabellen (${key}) verändert — Lauf angehalten`);
  }
  j.stand = 'abgeschlossen';
  j.abgeschlossen = new Date().toISOString();
  journalSchreiben(datei, j);
  return {
    ok: true, stand: j.stand, journal: datei,
    primary: { geaendert: j.primary.zuAendern, bytesVorher: j.primary.bytesVorher, bytesNachher: j.primary.bytesNachher },
    server: { geaendert: j.server.zuAendern, bytesVorher: j.server.bytesVorher, bytesNachher: j.server.bytesNachher },
    hinweis: 'Dateien werden erst durch Verdichten kleiner (nicht Teil dieses Laufs).',
  };
}

function ausfuehren(o) {
  const daten = resolve(o.daten ?? fail('--daten fehlt'));
  const name = o.bestaetigen ?? fail('--bestaetigen <Sicherungsname> fehlt');
  if (!existsSync(join(daten, PRIMARY))) fail(`Datenordner ohne ${PRIMARY}: ${daten}`);
  if (sperreLesen(daten)) fail('Wartungssperre liegt schon (laufender oder abgebrochener Lauf) — „fortsetzen" oder „freigeben"');
  const offen = offenesJournal(daten);
  if (offen) fail(`offener Lauf ${offen.datei} (${offen.inhalt.stand}) — erst „fortsetzen" oder den Sicherungssatz zurückspielen`);
  for (const x of unsauber(daten)) fail(x);
  if (existsSync(join(daten, PRIMARY + NEU))) fail(`${PRIMARY}${NEU} liegt im Datenordner — Rest eines abgebrochenen Laufs ohne Journal; prüfen und entfernen`);
  const dateienBeiSperre = dbDateien(daten);
  // ZUERST sperren, DANN prüfen, ob eine App läuft: eine App, die zwischen beidem startet, wird erkannt —
  // jede spätere findet die Sperre und startet nicht.
  sperreAnlegen(daten, { werkzeug: 'changelog-schlankung/1', stand: 'vorbereitung', angelegt: new Date().toISOString(), dateien: dateienBeiSperre });
  testabbruch('nach-sperre');
  let dbs = null;
  let geschrieben = false;
  try {
    appMussZuSein(o);
    const nachweis = sicherungenNachweisen(daten, o.sicherung, name);   // VOR dem ersten Öffnen: Dateien unverändert
    if (JSON.stringify(nachweis.dateien) !== JSON.stringify(dateienBeiSperre)) fail('Datenbankdateien seit dem Anlegen der Sperre verändert');
    dbs = oeffnen(daten);
    const l = lage(daten, dbs, bestaetigteNurPrimary(o));
    if (l.probleme.length) fail(`Vorbedingungen nicht erfüllt: ${l.probleme.join(' | ')}`);
    const j = {
      werkzeug: 'changelog-schlankung/1', schluessel: SLIM_KEY, stand: 'begonnen', begonnen: new Date().toISOString(),
      sicherungen: nachweis.sicherungen, dateienVorher: nachweis.dateien,
      fingerprint: l.fp, cursor: l.cursor, serverMax: l.serverMax, gepaart: l.abgleich.paired, eigenerAnfang: l.eigenerAnfang, nurPrimary: l.abgleich.primaryOnly.map((x) => x.id),
      primary: { zeilen: l.pRows.length, letzteId: l.pRows[l.pRows.length - 1]?.id ?? 0, vorher: changelogDigest(l.pRows), nachher: geplantDigest(l.pRows, l.pPlan), ...zahlen(l.pPlan) },
      server: { zeilen: l.sRows.length, letzteId: l.sRows[l.sRows.length - 1]?.id ?? 0, vorher: changelogDigest(l.sRows), nachher: geplantDigest(l.sRows, l.sPlan), ...zahlen(l.sPlan) },
      primaryUnberuehrt: unberuehrtDigests(dbs.p), serverUnberuehrt: unberuehrtDigests(dbs.s),
    };
    mkdirSync(join(daten, JOURNAL_DIR), { recursive: true });
    const datei = join(daten, JOURNAL_DIR, `${JOURNAL_PREFIX}${j.begonnen.replace(/[:.]/g, '-')}.json`);
    journalSchreiben(datei, j);
    geschrieben = true;   // ab hier bleibt die Sperre bei JEDEM Abbruch liegen
    sperreSetzen(daten, { werkzeug: 'changelog-schlankung/1', stand: 'laeuft', angelegt: j.begonnen, journal: basename(datei) });

    appMussZuSein(o);
    primaryUmwandeln(daten, dbs, l.pPlan, j.primary, o);
    j.stand = 'primary-fertig'; journalSchreiben(datei, j);
    testabbruch('nach-primary');

    appMussZuSein(o);
    seiteUmwandeln(dbs.s, l.sPlan, 'Server');
    dbs.s.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    seiteNachweisen(zeilenServer(dbs.s), j.server, 'Server');
    j.stand = 'server-fertig'; journalSchreiben(datei, j);
    testabbruch('nach-server');

    const r = abschluss(daten, dbs, j, datei);
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

/** Eine liegengebliebene Sperre nur nach geprüftem Zustand entfernen. */
function freigeben(o) {
  const daten = resolve(o.daten ?? fail('--daten fehlt'));
  appMussZuSein(o);
  const s = sperreLesen(daten) ?? fail('keine Wartungssperre vorhanden');
  if (offenesJournal(daten)) fail('offener Lauf — erst „fortsetzen" (oder den Sicherungssatz zurückspielen)');
  for (const x of unsauber(daten)) fail(x);
  if (existsSync(join(daten, PRIMARY + NEU))) fail(`${PRIMARY}${NEU} liegt im Datenordner — nicht freigeben`);
  if (!s.journal) {
    // Der Lauf endete vor dem ersten Schreiben: die Dateien müssen exakt die beim Anlegen der Sperre sein.
    if (!s.dateien || JSON.stringify(dbDateien(daten)) !== JSON.stringify(s.dateien)) {
      fail('Datenbankdateien weichen vom Stand beim Anlegen der Sperre ab — Sicherungssatz zurückspielen');
    }
    sperreEntfernen(daten);
    return { ok: true, modus: 'freigeben', grund: 'Lauf endete vor dem ersten Schreiben; Dateien unverändert', sperre: 'entfernt' };
  }
  const j = journale(daten).find((x) => basename(x.datei) === s.journal) ?? fail('das Journal der Sperre fehlt — Sicherungssatz zurückspielen');
  if (j.inhalt.stand !== 'abgeschlossen') fail(`Journal steht auf „${j.inhalt.stand}" — erst „fortsetzen"`);
  const dbs = oeffnen(daten);
  try {
    const l = lage(daten, dbs, j.inhalt.nurPrimary ?? []);
    if (l.probleme.length || l.pPlan.changes.length || l.sPlan.changes.length) fail(`Zustand nicht wie abgeschlossen: ${l.probleme.join(' | ') || 'noch Einträge mit Vektor'}`);
    seiteNachweisen(l.pRows, j.inhalt.primary, 'Primary');
    seiteNachweisen(l.sRows, j.inhalt.server, 'Server');
    if (l.cursor !== j.inhalt.cursor || l.serverMax !== j.inhalt.serverMax) fail('Cursor oder letzte Server-Nummer verändert');
    // Primary ↔ Server: dieselben Paare Byte für Byte, und der Cursor-Neuaufbau entschiede wie beim Abschluss.
    if (l.abgleich.paired !== j.inhalt.gepaart) fail(`Primary und Server passen nicht mehr zusammen (${j.inhalt.gepaart} → ${l.abgleich.paired} Paare)`);
    if (l.eigenerAnfang !== j.inhalt.eigenerAnfang) fail(`Cursor-Neuaufbau entschiede anders (${j.inhalt.eigenerAnfang} → ${l.eigenerAnfang})`);
    for (const [db, key] of [[dbs.p, 'primaryUnberuehrt'], [dbs.s, 'serverUnberuehrt']]) {
      if (JSON.stringify(unberuehrtDigests(db)) !== JSON.stringify(j.inhalt[key])) fail(`seit dem Abschluss wurde geschrieben (${key})`);
    }
  } finally { dbs.close(); }
  sperreEntfernen(daten);
  return { ok: true, modus: 'freigeben', grund: 'Lauf abgeschlossen und erneut nachgeprüft', sperre: 'entfernt' };
}

function fortsetzen(o) {
  const daten = resolve(o.daten ?? fail('--daten fehlt'));
  appMussZuSein(o);
  const offen = offenesJournal(daten) ?? fail('kein offener Lauf');
  const j = offen.inhalt;
  for (const x of unsauber(daten)) fail(x);
  // Sofort (wieder) sperren — fehlte die Sperre, könnte inzwischen jemand gestartet haben; die Nachweise unten
  // erkennen jedes Schreiben, die Sperre verhindert jedes weitere.
  if (!sperreLesen(daten)) sperreAnlegen(daten, { werkzeug: 'changelog-schlankung/1', stand: 'laeuft', angelegt: new Date().toISOString(), journal: basename(offen.datei) });
  // Die Sicherungen des Laufs müssen unversehrt den VORHER-Stand halten — sie sind der Rückweg.
  for (const s of j.sicherungen) {
    const m = JSON.parse(readFileSync(join(s.ordner, 'MANIFEST-sha256.json'), 'utf8'));
    for (const [f, h] of Object.entries(j.dateienVorher)) {
      const e = m.dateien.find((x) => x.file === f);
      if (!e || e.sha256 !== h || fileSha(join(s.ordner, 'Data', f)) !== h) fail(`Sicherung ${s.ordner} hält den Vorher-Stand nicht mehr (${f}) — nicht fortsetzen`);
    }
  }
  const dbs = oeffnen(daten);
  try {
    const l = lage(daten, dbs, j.nurPrimary ?? []);
    if (l.fp !== j.fingerprint || l.cursor !== j.cursor || l.serverMax !== j.serverMax) fail('Identität, Cursor oder Server-Nummer seit dem Abbruch verändert — Sicherungssatz zurückspielen');
    for (const [db, key] of [[dbs.p, 'primaryUnberuehrt'], [dbs.s, 'serverUnberuehrt']]) {
      if (JSON.stringify(unberuehrtDigests(db)) !== JSON.stringify(j[key])) fail(`seit dem Abbruch wurde geschrieben (${key}) — Sicherungssatz zurückspielen`);
    }
    for (const [rows, seite, label] of [[l.pRows, j.primary, 'Primary'], [l.sRows, j.server, 'Server']]) {
      const d = changelogDigest(rows);
      if (d !== seite.vorher && d !== seite.nachher) fail(`${label}: weder Vorher- noch Nachher-Stand — Sicherungssatz zurückspielen`);
    }
    if (l.probleme.length) fail(`Vorbedingungen nicht erfüllt: ${l.probleme.join(' | ')}`);
    appMussZuSein(o);
    primaryUmwandeln(daten, dbs, l.pPlan, j.primary, o);
    j.stand = 'primary-fertig'; journalSchreiben(offen.datei, j);
    appMussZuSein(o);
    seiteUmwandeln(dbs.s, l.sPlan, 'Server');
    dbs.s.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    seiteNachweisen(zeilenServer(dbs.s), j.server, 'Server');
    j.stand = 'server-fertig'; journalSchreiben(offen.datei, j);
    const r = abschluss(daten, dbs, j, offen.datei);
    dbs.close();
    testabbruch('vor-freigabe');
    sperreEntfernen(daten);                 // erst nach bestandenem Gesamtnachweis
    return { ...r, fortgesetzt: true, sperre: 'entfernt' };
  } finally { dbs.close(); }
}

try {
  const [mode, ...rest] = process.argv.slice(2);
  const o = args(rest);
  const r = mode === 'pruefen' ? pruefen(o) : mode === 'ausfuehren' ? ausfuehren(o) : mode === 'fortsetzen' ? fortsetzen(o)
    : mode === 'freigeben' ? freigeben(o) : fail('Modus: pruefen | ausfuehren | fortsetzen | freigeben');
  console.log(JSON.stringify(r, null, 1));
  process.exit(r.ok ? 0 : 2);
} catch (e) {
  console.error(JSON.stringify({ ok: false, abbruch: e instanceof Abbruch ? e.message : String(e?.stack ?? e) }, null, 1));
  process.exit(1);
}
