// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R2C §7 — der vollständige Scan: wer greift direkt auf die Datenbank zu?
// Run: node --experimental-strip-types test/uiparity/r2c-direct-db-scan.test.ts
//
// Die frühere Zählung („vier Seiten, zwei Komponenten") war ZU KLEIN, und der Grund ist lehrreich:
// sie suchte nach dem Import von `core/db/database` und übersah damit jede Seite, die schlicht
// `query` aus `core/db/helpers` holt. Dieser Scan sucht nach dem, was zählt — dem Zugriff selbst.
//
// Die Regel dieses Gates:
//
//   • JEDE Stelle mit direktem Zugriff steht unten namentlich mit ihrer Einordnung.
//   • Eine neue Stelle, die niemand eingeordnet hat, macht das Gate rot. Keine stille Zunahme.
//   • Die Zahl der Abfragen je Stelle ist festgenagelt: wächst eine Fläche, fällt es auf.
//   • Was als `client-safe` gilt, darf keinen Lesezugriff mehr brauchen — dafür stehen die
//     eigenen Gates (R1/R2A/R2B/R2C).
//
// Was das Gate NICHT tut: so tun, als sei die Lesefläche schon vollständig geschlossen. Die
// Stellen mit `offen` unten brauchen auf einem Rechner ohne Datenbank noch eine lokale Datenbank
// zum LESEN. Sie sind hier gezählt, benannt und begrenzt — und bis sie null sind, wird der
// Vollständigkeits-Marker nicht vergeben.
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
  'pages/admin/RepairFlowTestPage.tsx': { art: 'maschine', abfragen: 122, grund: 'Entwicklerwerkzeug, schreibt Testfaelle' },
  'pages/settings/SettingsPage.tsx': { art: 'maschine', abfragen: 19, grund: 'Datenort, Sicherung, Aktualisierung, Wartung' },
  'pages/auth/OnboardingPage.tsx': { art: 'maschine', abfragen: 2, grund: 'Erstlauf einer neuen Datenbank' },
  'pages/reports/ReconciliationPage.tsx': { art: 'maschine', abfragen: 19, grund: 'Buchpruefung und -reparatur' },
  'pages/reports/BackfillPage.tsx': { art: 'maschine', abfragen: 3, grund: 'schreibt Hauptbuchzeilen nach' },
  'pages/settings/LedgerDebugPage.tsx': { art: 'maschine', abfragen: 1, grund: 'Rohsicht auf das Hauptbuch' },

  // ── Untätig auf einem Client: der Ausloeser kommt dort nie an. ──
  'components/sync/SyncDuplicateGuard.tsx': { art: 'inert', abfragen: 1, grund: 'haengt am Abgleich, und der ist im Client verweigert' },

  // ── Schreiben: gehoert zu den 40 geprueften Buchungen — diese sind keine davon. ──
  'components/products/StockCheckInventoryModal.tsx': { art: 'schreib-luecke', abfragen: 5, grund: 'Inventursitzung' },
  'pages/analytics/AnalyticsPage.tsx': { art: 'schreib-luecke', abfragen: 1, grund: 'Steuerzahlung eintragen; die Schaltflaeche fehlt im Client' },

  // ── OFFEN: normales Geschaeftslesen, das auf PC2 noch eine lokale Datenbank braucht. ──
  'pages/dashboard/Dashboard.tsx': { art: 'offen-lesen', abfragen: 1, grund: 'Monatsziel aus den Einstellungen' },
  'pages/invoices/InvoiceList.tsx': { art: 'offen-lesen', abfragen: 2, grund: 'Zahlungen und Zahl der offenen Rechnungen' },
  'pages/customers/CustomerDetail.tsx': { art: 'offen-lesen', abfragen: 3, grund: 'Zahlungen, Erstattungen, Gutschriften des Kunden' },
  'pages/orders/OrderDetail.tsx': { art: 'offen-lesen', abfragen: 3, grund: 'Einkaufsverknuepfung, Zahlungstopf, vereinbarter Preis' },
  'pages/orders/OrderList.tsx': { art: 'offen-lesen', abfragen: 1, grund: 'Summe der Anzahlungen je Auftrag' },
  'pages/purchases/PurchaseCreate.tsx': { art: 'offen-lesen', abfragen: 3, grund: 'Wareneingang und Auftragszeilen als Vorlage' },
  'pages/suppliers/SupplierDetail.tsx': { art: 'offen-lesen', abfragen: 5, grund: 'Zahlungen, Retouren, Ausgaben des Lieferanten' },
  'pages/watches/ProductDetail.tsx': { art: 'offen-lesen', abfragen: 8, grund: 'Verkaufs-, Einkaufs- und Fertigungshistorie eines Artikels' },
  'pages/watches/WatchList.tsx': { art: 'offen-lesen', abfragen: 2, grund: 'Mandant der Filiale' },
  'components/expenses/PaySupplierModal.tsx': { art: 'offen-lesen', abfragen: 3, grund: 'Belegnummern der verknuepften Vorgaenge' },
  'components/repairs/SettleGoldModal.tsx': { art: 'offen-lesen', abfragen: 1, grund: 'Goldbestand je Karat' },
  'components/shared/GlobalSearch.tsx': { art: 'offen-lesen', abfragen: 9, grund: 'die uebergreifende Suche' },
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
  const app = readFileSync(resolvePath(repo, 'src/App.tsx'), 'utf8');
  const maschine = Object.entries(KATALOG).filter(([, e]) => e.art === 'maschine').map(([f]) => f);
  const routen = ['SettingsPage', 'RepairFlowTestPage', 'ReconciliationPage', 'BackfillPage', 'LedgerDebugPage'];
  const fehlend = routen.filter((r) => !new RegExp(`clientMode \\? \\([\\s\\S]{0,400}\\) : <${r} />`).test(app));
  ok(fehlend.length === 0, `D jede Wartungsflaeche zeigt im Client den Hinweis (${fehlend.join(', ') || 'alle'})`);
  ok(maschine.length === 6, `D sechs Flaechen sind als Maschine eingeordnet (${maschine.length})`);
  // Der Erstlauf ist die sechste: er ist im Client gar nicht erreichbar.
  ok(/!clientMode && needsOnboarding/.test(app), 'D und der Erstlauf ist im Client unerreichbar');
}

// ── E — der Stand der Lesefläche, ehrlich gezählt ─────────────────────────
{
  const offen = Object.entries(KATALOG).filter(([, e]) => e.art === 'offen-lesen');
  const summe = offen.reduce((s, [, e]) => s + e.abfragen, 0);
  console.log(`\n  Offene Lesestellen: ${offen.length} Dateien, ${summe} Zugriffe`);
  for (const [f, e] of offen) console.log(`    · ${f} (${e.abfragen}) — ${e.grund}`);
  // Diese Zahl ist die Wahrheit ueber die Vollstaendigkeit. Sie darf nur SINKEN.
  ok(offen.length <= 12, `E die offenen Lesestellen werden nicht mehr (${offen.length})`);
  ok(summe <= 41, `E …und auch die Zahl ihrer Zugriffe nicht (${summe})`);
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central ui parity r2c: direct database scan: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
const restlos = Object.values(KATALOG).every((e) => e.art !== 'offen-lesen');
console.log(restlos
  ? 'CENTRAL_UI_R2C_NO_CLIENT_BUSINESS_DB_READ_PROVED'
  : 'CENTRAL_UI_R2C_DIRECT_DB_SCAN_COMPLETE_OPEN_READS_REMAIN');
