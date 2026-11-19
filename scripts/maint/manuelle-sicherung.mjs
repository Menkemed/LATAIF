#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
// LATAIF — manuelle, geprüfte Vollsicherung bei GESCHLOSSENER App (E: und F:), Prüfen, Zurückspielen.
//
//   sichern        --quelle <Datenordner> --ziel <Ordner> [--ziel <Ordner> …] --name <Name>
//                  [--locator <data-location.json>] [--ruhe-sekunden 60] [--nur-pfad <exe>]
//   pruefen        --sicherung <Ordner>
//   zurueckspielen --sicherung <Ordner> --ziel <Datenordner> --beiseite <neuer Ordner> --bestaetigen <Name>
//                  [--nur-pfad <exe>]
//
// Regeln:
//   • Nie überschreiben: `<ziel>/<name>` darf nicht existieren; Dateien werden exklusiv angelegt (COPYFILE_EXCL).
//     Erst in `<name>.unfertig`, nach vollständiger Prüfung umbenannt — eine halbe Sicherung trägt nie den Namen.
//   • Nur bei geschlossener App: läuft ein `lataif.exe` (bzw. genau `--nur-pfad`), wird abgebrochen.
//   • Ruhe: alle Dateien der Quelle werden zweimal im Abstand von `--ruhe-sekunden` gehasht — gleich, sonst Abbruch.
//   • Vollständig: der GANZE Datenordner (beide Datenbanken samt -wal/-shm, alle Medien inkl. .ingest-journal,
//     Ablagen, Schlüssel) 1:1. Der Locator (`data-location.json`) liegt getrennt in `_locator/`.
//   • Geprüft: Manifest (Pfad, Größe, SHA-256) aus der Quelle; jede Zieldatei neu gelesen und verglichen; beide
//     Datenbanken per `PRAGMA integrity_check` auf einer TEMPORÄREN Kopie (die Sicherung selbst wird nie geöffnet);
//     die Quelle wird danach erneut gehasht (unverändert).
//   • Zurückspielen: nur eine fehlerfrei geprüfte Sicherung, nur mit `--bestaetigen <Name>`; der heutige Inhalt
//     wird ZUERST vollständig nach `--beiseite` kopiert und geprüft; danach ist der Datenordner exakt die
//     Sicherung. Der Locator wird NIE zurückgeschrieben.
// ════════════════════════════════════════════════════════════════════════════
import { createHash } from 'node:crypto';
import {
  constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{7,119}$/;
const DB_FILES = ['lataif.db', 'lataif_sync_server.db'];

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
    if (k === 'ziel') (out.ziel ??= []).push(v);
    else out[k] = v;
  }
  return out;
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Alle Dateien unter `root` (rekursiv, posix-relative Pfade). Verknüpfungen/Reparse-Punkte: Abbruch. */
function walk(root) {
  const out = [];
  const rec = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) fail(`Verknüpfung in der Quelle (nicht unterstützt): ${relative(root, p)}`);
      if (st.isDirectory()) rec(p);
      else if (st.isFile()) out.push(relative(root, p).split(sep).join('/'));
      else fail(`Unbekannter Eintrag: ${relative(root, p)}`);
    }
  };
  rec(root);
  return out;
}

function manifestOf(root) {
  return walk(root).map((file) => {
    const p = join(root, ...file.split('/'));
    return { file, bytes: statSync(p).size, sha256: sha256(p) };
  });
}

const key = (m) => m.map((e) => `${e.file}\t${e.bytes}\t${e.sha256}`).join('\n');

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

function sleep(sec) { execFileSync(process.execPath, ['-e', `setTimeout(()=>{}, ${Math.round(sec * 1000)})`]); }

function integrity(dbFile, begleiter) {
  const tmp = mkdtempSync(join(tmpdir(), 'lataif-ic-'));
  try {
    const t = join(tmp, 'x.db');
    copyFileSync(dbFile, t);
    for (const suf of begleiter) if (existsSync(dbFile + suf)) copyFileSync(dbFile + suf, t + suf);
    const db = new DatabaseSync(t);
    const r = db.prepare('PRAGMA integrity_check').all().map((x) => Object.values(x)[0]).join(';');
    db.close();
    return r;
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

function innerhalb(a, b) {
  const ra = resolve(a).toLowerCase() + sep, rb = resolve(b).toLowerCase() + sep;
  return ra.startsWith(rb) || rb.startsWith(ra);
}

function wiederherstellungMd(name, quelle, mitLocator) {
  return `# Sicherung ${name}

Erstellt mit geschlossener App (manuelle-sicherung.mjs). Die Quelle \`${quelle}\` wurde nur gelesen.
\`Data/\` ist der vollständige Datenordner 1:1 (beide Datenbanken samt -wal/-shm, alle Medien inkl. \`.ingest-journal\`,
Ablagen, Schlüssel). Prüfsummen aller Dateien: \`MANIFEST-sha256.json\`.

**Enthält Geheimnisse** (\`openai.key\`, \`sync_jwt_secret.key\`, …). Nicht weitergeben, nicht hochladen.${mitLocator ? '\n`_locator/data-location.json` ist der Zeiger aus `%APPDATA%\\com.lataif.app\\` — NIE in einen Testordner kopieren.' : ''}

## Prüfen

    node scripts/maint/manuelle-sicherung.mjs pruefen --sicherung "<dieser Ordner>"

## Zurückspielen

1. LATAIF auf Primary und PC2 schließen.
2. \`node scripts/maint/manuelle-sicherung.mjs zurueckspielen --sicherung "<dieser Ordner>" --ziel "<Datenordner>" --beiseite "<neuer Ordner>" --bestaetigen ${name}\`
   (kopiert den heutigen Inhalt zuerst geprüft nach \`--beiseite\`, danach ist der Datenordner exakt diese Sicherung).
3. Den Locator nur zurücklegen, falls er in \`%APPDATA%\\com.lataif.app\\\` fehlt.
4. Erst die Primary-App starten und prüfen, danach PC2.
`;
}

function sichern(o) {
  const name = o.name ?? fail('--name fehlt');
  if (!NAME_RE.test(name)) fail(`Ungültiger Name: ${name}`);
  const quelle = resolve(o.quelle ?? fail('--quelle fehlt'));
  if (!existsSync(quelle) || !statSync(quelle).isDirectory()) fail(`Quelle fehlt: ${quelle}`);
  for (const f of DB_FILES) if (!existsSync(join(quelle, f))) fail(`Quelle ohne ${f}: ${quelle}`);
  const ziele = (o.ziel ?? []).map((z) => resolve(z));
  if (ziele.length === 0) fail('--ziel fehlt');
  for (const z of ziele) {
    if (!existsSync(z) || !statSync(z).isDirectory()) fail(`Zielordner fehlt: ${z}`);
    if (innerhalb(z, quelle)) fail(`Ziel und Quelle überlappen: ${z}`);
    if (existsSync(join(z, name)) || existsSync(join(z, `${name}.unfertig`))) fail(`Existiert bereits, wird nicht überschrieben: ${join(z, name)}`);
  }
  const locator = o.locator ? resolve(o.locator) : null;
  if (locator && !existsSync(locator)) fail(`Locator fehlt: ${locator}`);

  const app = laufendeApp(o['nur-pfad']);
  if (app.length) fail(`App läuft noch (${app.join(', ')}) — erst schließen`);
  const ruhe = Number(o['ruhe-sekunden'] ?? 60);
  const m1 = manifestOf(quelle);
  sleep(ruhe);
  const m2 = manifestOf(quelle);
  if (key(m1) !== key(m2)) fail(`Quelle nicht ruhig (in ${ruhe} s verändert) — Abbruch`);
  if (laufendeApp(o['nur-pfad']).length) fail('App wurde gestartet — Abbruch');

  const ic = {};
  for (const f of DB_FILES) {
    ic[f] = integrity(join(quelle, f), ['-wal', '-shm']);
    if (ic[f] !== 'ok') fail(`integrity_check ${f}: ${ic[f]}`);
  }
  const manifest = {
    name, erstellt: new Date().toISOString(), quelle, locator: locator ? 'data-location.json' : null,
    dateien: m2, anzahl: m2.length, medien: m2.filter((e) => e.file.startsWith('media/')).length,
    bytes: m2.reduce((s, e) => s + e.bytes, 0), integritaet: ic,
  };
  const ergebnis = [];
  for (const z of ziele) {
    const tmp = join(z, `${name}.unfertig`);
    mkdirSync(tmp);
    for (const e of m2) {
      const src = join(quelle, ...e.file.split('/'));
      const dst = join(tmp, 'Data', ...e.file.split('/'));
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst, constants.COPYFILE_EXCL);
    }
    if (locator) { mkdirSync(join(tmp, '_locator')); copyFileSync(locator, join(tmp, '_locator', 'data-location.json'), constants.COPYFILE_EXCL); }
    writeFileSync(join(tmp, 'MANIFEST-sha256.json'), JSON.stringify(manifest, null, 1), { flag: 'wx' });
    writeFileSync(join(tmp, 'WIEDERHERSTELLUNG.md'), wiederherstellungMd(name, quelle, !!locator), { flag: 'wx' });
    const gelesen = manifestOf(join(tmp, 'Data'));
    if (key(gelesen) !== key(m2)) fail(`Abweichung beim Zurücklesen in ${tmp} — Sicherung NICHT fertig`);
    for (const f of DB_FILES) {
      const r = integrity(join(tmp, 'Data', f), ['-wal', '-shm']);
      if (r !== 'ok') fail(`integrity_check der Kopie ${f}: ${r}`);
    }
    renameSync(tmp, join(z, name));
    ergebnis.push({ ziel: join(z, name), dateien: gelesen.length, ok: true });
  }
  const m3 = manifestOf(quelle);
  if (key(m3) !== key(m2)) fail('Quelle hat sich während der Sicherung verändert — Sicherungen nicht verwenden');
  return { ok: true, name, dateien: manifest.anzahl, medien: manifest.medien, bytes: manifest.bytes, integritaet: ic, ziele: ergebnis };
}

function pruefen(o) {
  const dir = resolve(o.sicherung ?? fail('--sicherung fehlt'));
  const mf = join(dir, 'MANIFEST-sha256.json');
  if (!existsSync(mf)) fail(`Kein Manifest: ${mf}`);
  const manifest = JSON.parse(readFileSync(mf, 'utf8'));
  const ist = manifestOf(join(dir, 'Data'));
  const soll = new Map(manifest.dateien.map((e) => [e.file, e]));
  const abw = [];
  for (const e of ist) {
    const s = soll.get(e.file);
    if (!s) abw.push(`zusätzlich: ${e.file}`);
    else if (s.sha256 !== e.sha256 || s.bytes !== e.bytes) abw.push(`verändert: ${e.file}`);
    soll.delete(e.file);
  }
  for (const f of soll.keys()) abw.push(`fehlt: ${f}`);
  const ic = {};
  for (const f of DB_FILES) ic[f] = existsSync(join(dir, 'Data', f)) ? integrity(join(dir, 'Data', f), ['-wal', '-shm']) : 'fehlt';
  const ok = abw.length === 0 && DB_FILES.every((f) => ic[f] === 'ok');
  return { ok, name: manifest.name, dateien: ist.length, abweichungen: abw.slice(0, 50), anzahlAbweichungen: abw.length, integritaet: ic };
}

function zurueckspielen(o) {
  const dir = resolve(o.sicherung ?? fail('--sicherung fehlt'));
  const ziel = resolve(o.ziel?.[0] ?? fail('--ziel fehlt'));
  const beiseite = resolve(o.beiseite ?? fail('--beiseite fehlt'));
  const p = pruefen({ sicherung: dir });
  if (!p.ok) fail(`Sicherung nicht fehlerfrei (${p.anzahlAbweichungen} Abweichungen) — nichts zurückgespielt`);
  if (o.bestaetigen !== p.name) fail(`--bestaetigen muss exakt der Sicherungsname sein (${p.name})`);
  if (!existsSync(ziel) || !statSync(ziel).isDirectory()) fail(`Datenordner fehlt: ${ziel}`);
  if (existsSync(beiseite)) fail(`--beiseite existiert bereits, wird nicht überschrieben: ${beiseite}`);
  if (innerhalb(beiseite, ziel) || innerhalb(dir, ziel)) fail('Ordner überlappen');
  const app = laufendeApp(o['nur-pfad']);
  if (app.length) fail(`App läuft noch (${app.join(', ')}) — erst schließen`);

  // 1) heutigen Stand vollständig beiseite legen und prüfen. `--beiseite` wird IMMER angelegt — auch wenn der
  //    Datenordner leer ist (z. B. Wiederherstellung auf einen neuen Rechner). Vorher entstand er erst mit der ersten
  //    kopierten Datei; bei einem leeren Ziel fehlte er, und die Prüfung brach mit ENOENT ab (nichts zurückgespielt).
  const heute = manifestOf(ziel);
  mkdirSync(beiseite, { recursive: true });
  for (const e of heute) {
    const dst = join(beiseite, ...e.file.split('/'));
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(join(ziel, ...e.file.split('/')), dst, constants.COPYFILE_EXCL);
  }
  if (key(manifestOf(beiseite)) !== key(heute)) fail('Beiseite-Kopie weicht ab — nichts zurückgespielt');
  // 2) Datenordner leeren (der Inhalt liegt geprüft in --beiseite) und die Sicherung einspielen
  for (const name of readdirSync(ziel)) rmSync(join(ziel, name), { recursive: true, force: true });
  const manifest = JSON.parse(readFileSync(join(dir, 'MANIFEST-sha256.json'), 'utf8'));
  for (const e of manifest.dateien) {
    const dst = join(ziel, ...e.file.split('/'));
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(join(dir, 'Data', ...e.file.split('/')), dst, constants.COPYFILE_EXCL);
  }
  const nachher = manifestOf(ziel);
  if (key(nachher) !== key(manifest.dateien)) fail('Datenordner weicht nach dem Einspielen ab — Inhalt von --beiseite zurücklegen');
  return { ok: true, name: p.name, dateien: nachher.length, beiseite, beiseiteDateien: heute.length, zielWarLeer: heute.length === 0, hinweis: 'Locator wurde nicht angefasst' };
}

try {
  const [mode, ...rest] = process.argv.slice(2);
  const o = args(rest);
  const r = mode === 'sichern' ? sichern(o) : mode === 'pruefen' ? pruefen(o) : mode === 'zurueckspielen' ? zurueckspielen(o) : fail('Modus: sichern | pruefen | zurueckspielen');
  console.log(JSON.stringify(r, null, 1));
  process.exit(r.ok ? 0 : 2);
} catch (e) {
  console.error(JSON.stringify({ ok: false, abbruch: e instanceof Abbruch ? e.message : String(e?.stack ?? e) }, null, 1));
  process.exit(1);
}
