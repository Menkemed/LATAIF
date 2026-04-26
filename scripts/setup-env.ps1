# LATAIF Auto-Update -- ENV Setup (einmal ausfuehren, dauerhaft gespeichert)
# Verwendung: powershell -ExecutionPolicy Bypass -File scripts\setup-env.ps1

$ErrorActionPreference = 'Stop'

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "  LATAIF Auto-Update -- Environment Setup" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host ""

# 1. Private Key pruefen
$keyPath = "$env:USERPROFILE\.tauri\lataif.key"
if (-not (Test-Path $keyPath)) {
    Write-Host "[X] Private Key nicht gefunden: $keyPath" -ForegroundColor Red
    Write-Host "    Bitte zuerst generieren mit:"
    Write-Host '    npx tauri signer generate --password "" -w "$env:USERPROFILE\.tauri\lataif.key"'
    exit 1
}

# 2. Private Key Inhalt lesen
$privateKey = Get-Content $keyPath -Raw
Write-Host "[OK] Private Key gefunden: $keyPath" -ForegroundColor Green

# 3. TAURI_SIGNING_PRIVATE_KEY setzen
[System.Environment]::SetEnvironmentVariable("TAURI_SIGNING_PRIVATE_KEY", $privateKey, "User")
Write-Host "[OK] ENV: TAURI_SIGNING_PRIVATE_KEY gesetzt (User-Scope)" -ForegroundColor Green

# 4. TAURI_SIGNING_PRIVATE_KEY_PASSWORD = leer (Key ohne Password generiert)
[System.Environment]::SetEnvironmentVariable("TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "", "User")
Write-Host "[OK] ENV: TAURI_SIGNING_PRIVATE_KEY_PASSWORD = leer" -ForegroundColor Green

Write-Host ""
Write-Host "==================================================" -ForegroundColor Yellow
Write-Host "  GITHUB-Konfiguration (von dir auszufuellen)" -ForegroundColor Yellow
Write-Host "==================================================" -ForegroundColor Yellow
Write-Host ""

# 5. GitHub-Daten abfragen
$ghUser = Read-Host "GitHub-Username (z.B. Menkemed) -- Enter fuer spaeter"
$fullRepo = ""
$repoName = ""
if ($ghUser) {
    $repoName = Read-Host "Repository-Name [LATAIF]"
    if (-not $repoName) { $repoName = "LATAIF" }
    $fullRepo = "$ghUser/$repoName"
    [System.Environment]::SetEnvironmentVariable("GITHUB_REPO", $fullRepo, "User")
    Write-Host "[OK] ENV: GITHUB_REPO = $fullRepo" -ForegroundColor Green

    Write-Host ""
    Write-Host "  Bitte erstelle einen Personal Access Token:" -ForegroundColor Cyan
    Write-Host "  -> https://github.com/settings/tokens/new"
    Write-Host "  -> Scope: repo (Full control of private repositories)"
    Write-Host "  -> Expiration: 1 year"
    Write-Host ""
    $ghToken = Read-Host "GitHub Personal Access Token (ghp_...)"
    if ($ghToken) {
        [System.Environment]::SetEnvironmentVariable("GH_TOKEN", $ghToken, "User")
        Write-Host "[OK] ENV: GH_TOKEN gesetzt" -ForegroundColor Green
    }

    # Endpoint URL automatisch in tauri.conf.json patchen
    $tauriConf = "$PSScriptRoot\..\src-tauri\tauri.conf.json"
    if (Test-Path $tauriConf) {
        $content = Get-Content $tauriConf -Raw
        $newUrl = "https://github.com/$fullRepo/releases/latest/download/latest.json"
        $patched = $content -replace 'https://github\.com/[^/]+/[^/]+/releases/latest/download/latest\.json', $newUrl
        Set-Content $tauriConf $patched -NoNewline
        Write-Host "[OK] tauri.conf.json Endpoint aktualisiert auf $newUrl" -ForegroundColor Green
    }
}

$repoDisplay = if ($repoName) { $repoName } else { 'LATAIF' }

Write-Host ""
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "  FERTIG. Naechste Schritte:" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "1. PowerShell SCHLIESSEN und neu oeffnen (fuer ENV-Vars)" -ForegroundColor Yellow
Write-Host ""
Write-Host "2. GitHub CLI installieren (fuer Auto-Upload):" -ForegroundColor Yellow
Write-Host "   winget install --id GitHub.cli"
Write-Host "   gh auth login"
Write-Host ""
Write-Host "3. Erstes Auto-Update-Release:" -ForegroundColor Yellow
Write-Host "   npm run release patch"
Write-Host "   -> Erzeugt Draft-Release auf GitHub"
Write-Host "   -> Publish via GitHub-Web-UI wenn bereit"
Write-Host ""
