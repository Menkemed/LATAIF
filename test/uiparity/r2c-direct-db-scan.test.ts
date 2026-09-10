// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R2D §1/§10 — der vollständige Scan: wer greift direkt auf die Datenbank zu?
// Run: node --experimental-strip-types test/uiparity/r2c-direct-db-scan.test.ts
//
// Die Zählung vor R2C war zu klein, und der Grund war lehrreich: sie suchte nach dem Import von
// `core/db/database` und übersah damit jede Seite, die schlicht `query` aus `core/db/helpers`
// holt. Dieser Scan sucht nach dem, was zählt — dem Zugriff selbst.
//
// R2C fand so 21 Stellen, darunter zwölf, die für die normale Oberfläche LASEN und dafür eine
// lokale Datenbank brauchten. R2D hat diese zwölf geschlossen. Übrig bleiben nur noch drei
// Arten, und jede ist begründet:
//
//   • **Maschine** — wirkt dort, wo die Datenbank liegt (Einstellungen, Erstlauf, Prüfstand,
//     Entwicklerwerkzeug). Diese Flächen sagen im Client, wo sie zu bedienen sind.
//   • **Schreiblücke** — ein Geschäftsvorgang, der schreibt und (noch) nicht zu den vierzig
//     geprüften Buchungen gehört. Keine dieser Schaltflächen wird im Client angeboten.
//   • **untätig** — Code, dessen Auslöser einen Client nie erreicht.
//
// Die Regel dieses Gates bleibt: jede Fundstelle steht namentlich mit ihrer Einordnung, eine
// neue macht es rot, und die Zahl der Zugriffe je Stelle ist festgenagelt. Neu ist die härteste
// Zusage: **keine Fläche der gemeinsamen Oberfläche liest noch aus einer lokalen Datenbank.**
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
let PASS = 0; const fails: string[] = [];
const ok = (c: boolean, m: string) => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };

type Art = 'maschine' | 'inert' | 'schreib-luecke' | 'offen-lesen';
interface Eintrag { art: Art; abfragen: number; grund: string }

/**
 * Die vollständige Liste. `abfragen` zählt `query(` plus `getDatabase(` — die Zahl ist bewusst
 * hart, damit jede Veränderung an einer dieser Flächen hier vorbeikommt.
 */
const KATALOG: Record<string, Eintrag> = {
  // ── Maschine: wirkt dort, wo die Datenbank liegt. An der Route auf `Primary only`. ──
  'pages/admin/RepairFlowTestPage.tsx': { art: 'maschine', abfragen: 122, grund: 'Entwicklerwerkzeug, schreibt Testfaelle in die Datenbank' },
  'pages/settings/SettingsPage.tsx': { art: 'maschine', abfragen: 19, grund: 'Datenort, Sicherung, Aktualisierung, Wartung; die fachlichen Teile sind SCHREIBmasken' },
  'pages/auth/OnboardingPage.tsx': { art: 'maschine', abfragen: 2, grund: 'Erstlauf einer neuen Datenbank' },
  'pages/settings/LedgerDebugPage.tsx': { art: 'maschine', abfragen: 1, grund: 'Pruefstand, der Testbuchungen ins Hauptbuch schreibt' },

  // ── Untätig auf einem Client: der Ausloeser kommt dort nie an. ──
  'components/sync/SyncDuplicateGuard.tsx': { art: 'inert', abfragen: 1, grund: 'haengt am Abgleich, und der ist im Client verweigert' },

  // ── Schreiben: gehoert zu den 40 geprueften Buchungen — diese sind keine davon. ──
  'components/products/StockCheckInventoryModal.tsx': { art: 'schreib-luecke', abfragen: 5, grund: 'Inventursitzung' },
  'pages/analytics/AnalyticsPage.tsx': { art: 'schreib-luecke', abfragen: 1, grund: 'Steuerzahlung eintragen; die Schaltflaeche fehlt im Client' },
  // R5A — OrderDetail ist hier NICHT mehr: der Zahlungstopf wird in
  // `core/orders/order-payment-carryover` umgerechnet, die Ansicht fragt die Datenbank nicht mehr direkt.
  'pages/reports/BackfillPage.tsx': { art: 'schreib-luecke', abfragen: 3, grund: 'schreibt Hauptbuchzeilen nach; die Vorschau gehoert zum Schreibweg' },
};

function scan(root: string): Map<string, number> {
  const out = new Map<string, number>();
  (function walk(d: string) {
    for (const e of readdirSync(resolvePath(repo, d), { withFileTypes: true })) {
      const p = d + '/' + e.name;
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(ts|tsx)$/.test(e.name)) continue;
      const s = readFileSync(resolvePath(repo, p), 'utf8');
      // Kommentare zaehlen nicht — es geht um Zugriffe, nicht um Erzaehlung.
      const code = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const n = (code.match(/\bquery\(/g) ?? []).length + (code.match(/\bgetDatabase\(/g) ?? []).length;
      if (n > 0) out.set(p.replace(/^src\//, ''), n);
    }
  })(root);
  return out;
}

const gefunden = new Map<string, number>([...scan('src/pages'), ...scan('src/components')]);

// ── A — nichts Unbekanntes ────────────────────────────────────────────────
{
  const neu = [...gefunden.keys()].filter((f) => !(f in KATALOG));
  ok(neu.length === 0, `A jede Stelle mit direktem Zugriff ist eingeordnet (neu: ${neu.join(', ') || 'keine'})`);
  const weg = Object.keys(KATALOG).filter((f) => !gefunden.has(f));
  ok(weg.length === 0, `A und keine eingeordnete Stelle ist spurlos verschwunden (${weg.join(', ') || 'keine'})`);
}

// ── B — die Zahlen sind festgenagelt ──────────────────────────────────────
{
  const abweichend = [...gefunden.entries()]
    .filter(([f, n]) => KATALOG[f] && KATALOG[f].abfragen !== n)
    .map(([f, n]) => `${f}: ${n} statt ${KATALOG[f].abfragen}`);
  ok(abweichend.length === 0, `B die Zahl der Zugriffe je Stelle ist unveraendert (${abweichend.join('; ') || 'ok'})`);
}

// ── C — die Stores sind vollständig ───────────────────────────────────────
//
// Ein Store liest entweder ueber den gemeinsamen Weg (dann steht `hydrateFromPrimary` drin),
// oder er ist ausdruecklich keiner (dann steht er hier). Ein dritter Fall ist ein Versehen.
{
  const AUSNAHMEN: Record<string, string> = {
    'authStore.ts': 'Anmeldung — kein Geschaeftslesen',
    'customerMessageStore.ts': 'Nachrichten je Kunde; fern gar nicht erreichbar, faellt auf leer zurueck',
  };
  const dir = resolvePath(repo, 'src/stores');
  const offen: string[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.ts')) continue;
    const s = readFileSync(resolvePath(dir, f), 'utf8');
    const liest = /\bquery\(|\bgetDatabase\(/.test(s);
    const migriert = /hydrateFromPrimary\(|hydrateOneFromPrimary\(/.test(s);
    if (liest && !migriert && !(f in AUSNAHMEN)) offen.push(f);
  }
  ok(offen.length === 0, `C jeder lesende Store geht ueber den gemeinsamen Weg (offen: ${offen.join(', ') || 'keiner'})`);
}

// ── D — die Maschinenflächen sagen es auch ────────────────────────────────
{
  const maschine = Object.entries(KATALOG).filter(([, e]) => e.art === 'maschine').map(([f]) => f);
  ok(maschine.length === 4, `D vier Flaechen sind als Maschine eingeordnet (${maschine.length})`);
  const app = readFileSync(resolvePath(repo, 'src/App.tsx'), 'utf8');
  // Der Erstlauf ist die vierte: er ist im Client gar nicht erreichbar.
  ok(/!clientMode && needsOnboarding/.test(app), 'D und der Erstlauf ist im Client unerreichbar');
}

// ── E — der Stand der Lesefläche: keine offene mehr ──────────────────────
{
  const offen = Object.entries(KATALOG).filter(([, e]) => e.art === 'offen-lesen');
  ok(offen.length === 0,
    `E keine Flaeche der gemeinsamen Oberflaeche liest noch lokal (${offen.map(([f]) => f).join(', ') || 'keine'})`);

  // Und die Gegenprobe: was übrig ist, sagt es auch. Jede Maschinen-Fläche hat ihren Hinweis,
  // jede Schreiblücke ihre Bedingung — keine stille Schaltfläche, die im Client nichts täte.
  const app = readFileSync(resolvePath(repo, 'src/App.tsx'), 'utf8');
  for (const r of ['SettingsPage', 'RepairFlowTestPage', 'BackfillPage', 'LedgerDebugPage']) {
    ok(new RegExp(`clientMode \\? \\([\\s\\S]{0,400}\\) : <${r} />`).test(app), `E ${r} zeigt im Client den Hinweis`);
  }
  const recon = readFileSync(resolvePath(repo, 'src/pages/reports/ReconciliationPage.tsx'), 'utf8');
  ok(/!readsFromPrimary\(\) && <Button/.test(recon), 'E der Storno der Abstimmung erscheint nur am Hauptrechner');
  ok(!/clientMode \? \([\s\S]{0,300}\) : <ReconciliationPage \/>/.test(app),
    'E …die Abstimmung selbst ist aber keine Maschinenflaeche mehr');
  const analytics = readFileSync(resolvePath(repo, 'src/pages/analytics/AnalyticsPage.tsx'), 'utf8');
  ok(/!readsFromPrimary\(\) && \(/.test(analytics), 'E die Steuerzahlung wird im Client nicht angeboten');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central ui parity r2c: direct database scan: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
const restlos = Object.values(KATALOG).every((e) => e.art !== 'offen-lesen');
if (!restlos) { console.log('CENTRAL_UI_R2D_OPEN_READS_REMAIN'); process.exit(1); }
console.log('CENTRAL_UI_R2D_DIRECT_DB_INVENTORY_PINNED');
console.log('CENTRAL_UI_R2D_BUSINESS_SYSTEM_CLASSIFICATION_PROVED');
console.log('CENTRAL_UI_R2C_NO_CLIENT_BUSINESS_DB_READ_PROVED');
