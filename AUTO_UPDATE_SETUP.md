# LATAIF Auto-Update — Einmaliges Setup

Diese Anleitung muss **einmalig** befolgt werden, danach läuft jedes Update automatisch.

---

## 1. Signing-Keypair generieren (5 Min, einmalig)

Im PowerShell auf deinem Hauptrechner:

```powershell
cd C:\Users\Elias\Projects\lataif\desktop
npx tauri signer generate -w "$env:USERPROFILE\.tauri\lataif.key"
```

Das erzeugt **zwei Dateien**:
- `~/.tauri/lataif.key` — **Private Key** (geheim, NIE teilen, NIE in Git committen)
- `~/.tauri/lataif.key.pub` — **Public Key** (kommt in die App)

Es fragt nach einem **Passwort** für den Private Key — gib eines ein und merk es dir.

---

## 2. Public Key in die App backen

Inhalt von `~/.tauri/lataif.key.pub` kopieren:

```powershell
Get-Content "$env:USERPROFILE\.tauri\lataif.key.pub" -Raw
```

In `src-tauri/tauri.conf.json` den Platzhalter ersetzen:

```json
"plugins": {
  "updater": {
    "endpoints": [...],
    "pubkey": "HIER_DEN_PUBLIC_KEY_EINFÜGEN"
  }
}
```

---

## 3. GitHub-Repository anlegen (10 Min, einmalig)

1. Gehe zu https://github.com/new
2. Name: `lataif-desktop` (oder beliebig)
3. **Privat** wählen
4. „Create repository"
5. **Personal Access Token** generieren:
   - https://github.com/settings/tokens/new
   - Scope: `repo` (Full control of private repositories)
   - Expiration: 1 Jahr
   - Token kopieren

---

## 4. Endpoint-URL in `tauri.conf.json` anpassen

```json
"endpoints": [
  "https://github.com/DEIN-USERNAME/lataif-desktop/releases/latest/download/latest.json"
]
```

---

## 5. Environment-Variablen setzen (einmalig pro Rechner)

In PowerShell, **dauerhaft** für deinen User:

```powershell
# Private Key (für Build-Signaturen)
[System.Environment]::SetEnvironmentVariable(
  "TAURI_SIGNING_PRIVATE_KEY",
  (Get-Content "$env:USERPROFILE\.tauri\lataif.key" -Raw),
  "User"
)

# Passwort vom Private Key
[System.Environment]::SetEnvironmentVariable(
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  "DEIN_PASSWORT",
  "User"
)

# GitHub Token + Repo (für Auto-Upload)
[System.Environment]::SetEnvironmentVariable("GH_TOKEN", "ghp_xxxxxxxxxxxxxxxxxxxx", "User")
[System.Environment]::SetEnvironmentVariable("GITHUB_REPO", "DEIN-USERNAME/lataif-desktop", "User")
```

PowerShell **neu starten** damit die Variablen aktiv werden.

---

## 6. GitHub CLI installieren (für automatischen Upload)

```powershell
winget install --id GitHub.cli
gh auth login
```

Wähle: GitHub.com → HTTPS → Login with a web browser.

---

## 7. Erstes Release pushen

```powershell
cd C:\Users\Elias\Projects\lataif\desktop
git init
git remote add origin https://github.com/DEIN-USERNAME/lataif-desktop.git
git add .
git commit -m "Initial commit"
git push -u origin main

# Erstes Release erstellen
npm run release patch
```

Das Script:
1. Bumpt die Version (0.1.0 → 0.1.1)
2. Baut die App mit Signatur (~3-5 Min)
3. Erstellt `latest.json` Manifest
4. Lädt Installer + Signatur + Manifest zu GitHub Releases hoch

---

## 8. Existierende LATAIF-Installationen einmalig updaten

**Wichtig:** Alte Installationen können sich nicht selbst updaten — sie haben den Updater noch nicht eingebaut. Du musst die **neue Version mit Updater einmalig manuell** auf jeden Rechner installieren:

1. Alte LATAIF deinstallieren (Daten in `%APPDATA%/com.lataif.app/` bleiben erhalten)
2. Neuen Installer ausführen: `LATAIF_0.1.1_x64-setup.exe`
3. Daten erscheinen automatisch wieder

**Ab dieser Installation** läuft jedes weitere Update automatisch — der User sieht beim App-Start oben rechts ein „Update verfügbar"-Banner und klickt „Install".

---

## Tägliche Nutzung — Update veröffentlichen

```powershell
# Bug fixen, neues Feature, was auch immer
git add -A && git commit -m "Fixed something"

# Release machen
npm run release patch    # 0.1.1 → 0.1.2
# oder
npm run release minor    # 0.1.1 → 0.2.0
# oder
npm run release major    # 0.1.1 → 1.0.0
# oder
npm run release 1.5.3    # explizite Version
```

Das war's. Innerhalb der nächsten Stunde sehen alle laufenden LATAIF-Instanzen das Update.

---

## Troubleshooting

**„signature is not valid"**
- Public Key in `tauri.conf.json` stimmt nicht mit dem Private Key überein
- Lösung: nochmal `Get-Content ~/.tauri/lataif.key.pub` und exakt einsetzen

**„failed to fetch update manifest"**
- Endpoint-URL falsch oder Repo privat ohne Auth
- Lösung: Endpoint-URL prüfen, oder Repo public machen, oder Token in URL einbetten

**„no updater artifacts found"**
- `createUpdaterArtifacts: true` fehlt in `tauri.conf.json` unter `bundle`
- Lösung: ist bei dir bereits gesetzt, sollte funktionieren

**SmartScreen-Warnung „Nicht erkannte App"**
- Signatur-Zertifikat von Microsoft nicht anerkannt (du hast „nur" Tauri-Signatur, nicht Authenticode)
- Workaround: Beim ersten Start „Weitere Informationen" → „Trotzdem ausführen"
- Permanent-Fix: EV Code-Signing-Cert kaufen (~300-400 €/Jahr)

**Update-Banner erscheint nicht**
- Browser-Tab statt Tauri-Desktop? → Updater geht nur in Tauri
- Console öffnen (Ctrl+Shift+I), Logs prüfen

---

## Kostenüberblick

| Komponente | Kosten |
|---|---|
| GitHub Private Repo | 0 € |
| GitHub Releases (Hosting) | 0 € (bis 2 GB pro Datei) |
| Domain | 0 € (nicht nötig) |
| Signing-Cert | 0 € (Tauri-eigene Signatur reicht) |
| **Gesamt** | **0 €/Monat** |

Optional später:
- EV Code-Signing-Cert für Windows (entfernt SmartScreen-Warnung): ~300 €/Jahr
