#!/usr/bin/env node
// Plan §Auto-Update — Release-Pipeline.
// Schritte: Version bumpen (package.json + tauri.conf.json + Cargo.toml) → Tauri-Build →
// Signatur-Check → latest.json generieren → an GitHub Releases hochladen.
//
// Voraussetzungen (einmalig):
//   1. Signing-Key generiert: `npx tauri signer generate -w "$env:USERPROFILE/.tauri/lataif.key"`
//   2. Public Key in src-tauri/tauri.conf.json bei plugins.updater.pubkey eingetragen
//   3. ENV-Variable TAURI_SIGNING_PRIVATE_KEY = Inhalt der lataif.key (oder Pfad)
//   4. ENV-Variable TAURI_SIGNING_PRIVATE_KEY_PASSWORD = Passwort vom Key (falls gesetzt)
//   5. GH_TOKEN mit `repo` scope (Personal Access Token von github.com/settings/tokens)
//   6. GITHUB_REPO=owner/repo (z.B. "lataif-bahrain/lataif-desktop")
//
// Verwendung:
//   node scripts/release.mjs patch     # 0.1.0 → 0.1.1
//   node scripts/release.mjs minor     # 0.1.0 → 0.2.0
//   node scripts/release.mjs major     # 0.1.0 → 1.0.0
//   node scripts/release.mjs 1.2.3     # explizite Version

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PKG = join(ROOT, 'package.json');
const TAURI_CONF = join(ROOT, 'src-tauri', 'tauri.conf.json');
const CARGO = join(ROOT, 'src-tauri', 'Cargo.toml');

function bumpVersion(current, kind) {
  const parts = current.split('.').map(Number);
  if (kind === 'patch') return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
  if (kind === 'minor') return `${parts[0]}.${parts[1] + 1}.0`;
  if (kind === 'major') return `${parts[0] + 1}.0.0`;
  if (/^\d+\.\d+\.\d+$/.test(kind)) return kind;
  throw new Error(`Unknown bump kind: ${kind} (use patch/minor/major or x.y.z)`);
}

function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function writeJson(path, data) { writeFileSync(path, JSON.stringify(data, null, 2) + '\n'); }

function updateCargoVersion(version) {
  const txt = readFileSync(CARGO, 'utf8');
  const updated = txt.replace(/^version = "[^"]+"/m, `version = "${version}"`);
  writeFileSync(CARGO, updated);
}

function sh(cmd, opts = {}) {
  console.log(`$ ${cmd}`);
  return execSync(cmd, { stdio: 'inherit', cwd: ROOT, ...opts });
}

function log(msg) { console.log(`\n▸ ${msg}\n`); }

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: node scripts/release.mjs <patch|minor|major|x.y.z>');
    process.exit(1);
  }

  const pkg = readJson(PKG);
  const tauriConf = readJson(TAURI_CONF);
  const oldVersion = tauriConf.version || pkg.version;
  const newVersion = bumpVersion(oldVersion, arg);

  log(`Release ${oldVersion} → ${newVersion}`);

  // 1. Version in allen drei Files setzen
  pkg.version = newVersion;
  tauriConf.version = newVersion;
  writeJson(PKG, pkg);
  writeJson(TAURI_CONF, tauriConf);
  updateCargoVersion(newVersion);
  log('Version in package.json + tauri.conf.json + Cargo.toml gebumpt.');

  // 2. Build
  log('Tauri-Build läuft… (3-5 Min)');
  sh('npx tauri build');

  // 3. Signaturen prüfen
  const bundleDir = join(ROOT, 'src-tauri', 'target', 'release', 'bundle');
  const nsisExe = join(bundleDir, 'nsis', `LATAIF_${newVersion}_x64-setup.exe`);
  const nsisSig = `${nsisExe}.sig`;
  if (!existsSync(nsisExe) || !existsSync(nsisSig)) {
    console.error(`✘ Bundle oder Signatur fehlt: ${nsisExe}.sig`);
    console.error('  Hast du TAURI_SIGNING_PRIVATE_KEY gesetzt?');
    process.exit(1);
  }

  // 4. latest.json bauen
  const sig = readFileSync(nsisSig, 'utf8').trim();
  const repo = process.env.GITHUB_REPO || 'lataif-bahrain/lataif-desktop';
  const downloadUrl = `https://github.com/${repo}/releases/download/v${newVersion}/LATAIF_${newVersion}_x64-setup.exe`;
  const latest = {
    version: newVersion,
    notes: process.env.RELEASE_NOTES || `LATAIF ${newVersion}`,
    pub_date: new Date().toISOString(),
    platforms: {
      'windows-x86_64': {
        signature: sig,
        url: downloadUrl,
      },
    },
  };
  const latestPath = join(bundleDir, 'latest.json');
  writeJson(latestPath, latest);
  log(`latest.json geschrieben: ${latestPath}`);

  // 5. GitHub Release direkt publishen — keine Draft-Bestaetigung mehr noetig.
  //    Updater sieht das Update sofort. Wenn man das Sicherheitsnetz zurueck will:
  //    `RELEASE_DRAFT=1 npm run release:patch` → erstellt wieder als Draft.
  const asDraft = process.env.RELEASE_DRAFT === '1';
  const draftFlag = asDraft ? '--draft' : '--latest';
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) {
    log(`GitHub-Release v${newVersion} ${asDraft ? 'als DRAFT' : 'LIVE'} hochladen…`);
    try {
      sh(`gh release create v${newVersion} "${nsisExe}" "${nsisSig}" "${latestPath}" --title "LATAIF v${newVersion}" --notes "Release v${newVersion}" ${draftFlag}`);
      if (asDraft) {
        log(`✔ Draft-Release: https://github.com/${repo}/releases`);
        console.log(`  → Manuell publishen wenn bereit.`);
      } else {
        log(`✔ Release LIVE: https://github.com/${repo}/releases/tag/v${newVersion}`);
        console.log(`  → Auto-Updater greift bei allen Usern beim naechsten App-Start.`);
      }
    } catch {
      console.error('GH-Release fehlgeschlagen. Lade die Dateien manuell hoch:');
      console.error('  ' + nsisExe);
      console.error('  ' + nsisSig);
      console.error('  ' + latestPath);
    }
  } else {
    console.log('\n⚠ GH_TOKEN nicht gesetzt — Bundles bitte manuell uploaden:');
    console.log('  Datei 1:', nsisExe);
    console.log('  Datei 2:', nsisSig);
    console.log('  Datei 3:', latestPath);
    console.log(`\n  → Erstelle ein Release auf https://github.com/${repo}/releases/new`);
    console.log(`  → Tag: v${newVersion}, alle 3 Dateien als Assets, „Publish".`);
  }

  log(`✔ Release ${newVersion} ${asDraft ? 'als Draft' : 'LIVE'} fertig.`);
}

main().catch(err => { console.error(err); process.exit(1); });
