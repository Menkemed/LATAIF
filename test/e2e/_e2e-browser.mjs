// ════════════════════════════════════════════════════════════════════════════
// E2E-BROWSER — den kopflosen Test-Edge eines Laufs SCHLIESSEN, nicht beenden.
//
// `msedge.exe` startet den eigentlichen Browser als neuen Prozess und endet sofort (Exit 0). Das gestartete
// Kind ist danach weg: `killOwnChild` (PID + Startpfad, `_e2e-process.mjs`) greift ins Leere, und nach jedem
// Lauf blieb ein ganzer Edge-Baum stehen (21.10.2026: 132 Prozesse aus den Läufen eines Tages).
//
// Geschlossen wird der Browser deshalb über SEINE Debug-Verbindung (`Browser.close`): die Verbindung des
// Browsers, den dieser Lauf auf seinem eigenen Port mit seinem eigenen Profil gestartet hat — ihre Kennung gilt
// nur für genau diese Browser-Instanz. Kein Prozess wird hier nach Name, Befehlszeile oder PID beendet (R6C);
// die Prozessliste wird nur GELESEN, um zu beweisen, dass vom Profil dieses Laufs nichts mehr läuft.
// ════════════════════════════════════════════════════════════════════════════
import { execFileSync } from 'node:child_process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Die Browser-Verbindung des Edge auf diesem Debug-Port — '' wenn dort keiner antwortet. */
export async function edgeBrowserEndpoint(port) {
  try {
    const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    return String(v.webSocketDebuggerUrl || '');
  } catch { return ''; }
}

/**
 * Schließt den Browser hinter `wsUrl` und wartet, bis sein Debug-Port nicht mehr antwortet.
 * `true`: zu (oder nie gestartet). `false`: der Port antwortet nach `budgetMs` noch.
 */
export async function closeEdge(wsUrl, port, budgetMs = 10000) {
  if (!wsUrl) return true;
  await new Promise((res) => {
    let ws = null;
    const fertig = () => { try { ws?.close(); } catch { /* zu */ } res(); };
    const t = setTimeout(fertig, 5000);
    try {
      ws = new WebSocket(wsUrl);
      ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'Browser.close' })));
      ws.addEventListener('message', () => { clearTimeout(t); fertig(); });
      ws.addEventListener('close', () => { clearTimeout(t); res(); });
      ws.addEventListener('error', () => { clearTimeout(t); res(); });
    } catch { clearTimeout(t); res(); }
  });
  const end = Date.now() + budgetMs;
  while (Date.now() < end) {
    try { await fetch(`http://127.0.0.1:${port}/json/version`); } catch { return true; }
    await sleep(250);
  }
  return false;
}

/** Nur lesend: wie viele `msedge.exe` laufen mit genau diesem Profil? (-1: Liste nicht lesbar) */
export function edgeProfileProcesses(profileDir) {
  const dir = String(profileDir || '');
  if (!dir || /['`$*?[\]]/.test(dir)) return -1;
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `@(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${dir}*' }).Count`],
    { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return Number(out.trim());
  } catch { return -1; }
}

/** Wartet, bis kein Prozess dieses Profils mehr läuft; gibt den Rest zurück (0 = sauber). */
export async function waitEdgeProfileGone(profileDir, budgetMs = 10000) {
  const end = Date.now() + budgetMs;
  let rest = edgeProfileProcesses(profileDir);
  while (rest > 0 && Date.now() < end) { await sleep(250); rest = edgeProfileProcesses(profileDir); }
  return rest;
}
