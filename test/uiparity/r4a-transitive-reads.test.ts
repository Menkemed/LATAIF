// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R4A §3 — die Lesefläche, die über KERNFUNKTIONEN geht.
// Run: node --experimental-strip-types test/uiparity/r4a-transitive-reads.test.ts
//
// Der Scan aus R2D zählte Abfragen IN Seiten und war damit zu eng: eine Seite liest auch, wenn
// sie `balanceOf`, `receivablesBreakdown`, `getStockAggregates` oder `creditPaidByExpense` ruft.
// Genau das hat der erste Zwei-App-Lauf gefunden — die Übersicht stürzte auf einem echten
// Rechner ohne Datenbank ab, und weil die Fehlergrenze danach stehen bleibt, sah JEDE weitere
// Fläche leer aus, ohne dass irgendwo etwas rot wurde.
//
// Dieses Gate ist die statische Hälfte der Antwort (die laufende Hälfte ist
// `test/e2e/r4a-route-crawl.e2e.mjs`, das jede Fläche wirklich zeichnet):
//
//   • Es sammelt die Namen ALLER exportierten Funktionen, die selbst die Datenbank anfassen.
//   • Es sucht deren Aufrufe in Seiten und Komponenten.
//   • Jede Fundstelle muss eingeordnet sein: entweder rein rechnend (kein Datenbankzugriff),
//     oder ein Aufruf innerhalb einer HANDLUNG (Klick), oder eine Maschinenfläche.
//   • Ein neuer Aufruf beim ZEICHNEN macht das Gate rot.
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
let PASS = 0; const fails: string[] = [];
const ok = (c: boolean, m: string) => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string) => readFileSync(resolvePath(repo, p), 'utf8');
const codeOf = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Die Kernmodule, die selbst zur Datenbank greifen. */
const KERN = [
  'core/ledger/queries.ts',
  'core/finance/receivables.ts',
  'core/lots/lot-queries.ts',
  'core/finance/expenseSettlement.ts',
  'core/audit/audit-log.ts',
  'core/reports/sales-metrics-loader.ts',
  'core/contacts/country-codes-store.ts',
  'core/media/product-image-export.ts',
];

/** Welche ihrer Ausfuhren fassen die Datenbank WIRKLICH an? */
function dbFunktionen(modul: string): string[] {
  const s = codeOf(src('src/' + modul));
  const out: string[] = [];
  const re = /export (?:async )?function (\w+)[\s\S]*?(?=\nexport |\n\/\*\*|$)/g;
  for (const m of s.matchAll(re)) {
    if (/\bquery\(|\bgetDatabase\(/.test(m[0])) out.push(m[1]);
  }
  return out;
}

const DB_FN = new Map<string, string>();
for (const m of KERN) for (const f of dbFunktionen(m)) DB_FN.set(f, m);

/**
 * Die eingeordneten Fundstellen. `beim` sagt, WANN der Aufruf passiert:
 *
 *   'handlung'  — erst auf Klick. Er kann auf einem Client scheitern; das ist eine SCHREIB-/
 *                 Handlungsluecke und in R4A ausdruecklich nicht Thema.
 *   'maschine'  — eine Flaeche, die ohnehin nur am Hauptrechner laeuft.
 */
const EINGEORDNET: Record<string, { beim: 'handlung' | 'maschine'; grund: string }> = {
  'pages/invoices/InvoiceCreate.tsx:getLotsWithPurchaseNumbers': { beim: 'handlung', grund: 'Losauswahl beim Hinzufuegen einer Zeile' },
  'pages/repairs/RepairList.tsx:getLotsWithPurchaseNumbers': { beim: 'handlung', grund: 'Losauswahl beim Anlegen' },
  'pages/settings/SettingsPage.tsx:useCountryCodesStore': { beim: 'maschine', grund: 'Einstellungen laufen nur am Hauptrechner' },
  'pages/settings/LedgerDebugPage.tsx:balanceOf': { beim: 'maschine', grund: 'Pruefstand' },
  'pages/settings/LedgerDebugPage.tsx:cashflow': { beim: 'maschine', grund: 'Pruefstand' },
  'pages/settings/LedgerDebugPage.tsx:revenueSnapshot': { beim: 'maschine', grund: 'Pruefstand' },
  'pages/settings/LedgerDebugPage.tsx:ledgerImbalance': { beim: 'maschine', grund: 'Pruefstand' },
  'pages/settings/LedgerDebugPage.tsx:findImbalancedTransactions': { beim: 'maschine', grund: 'Pruefstand' },
  'components/ui/PhoneInput.tsx:useCountryCodesStore': { beim: 'handlung', grund: 'eigene Landesvorwahlen; faellt ohne Datenbank auf die eingebauten zurueck' },
  'components/shared/HistoryPanel.tsx:getAuditForEntity': { beim: 'handlung', grund: 'der Verlauf oeffnet erst auf Klick' },
  'pages/watches/WatchList.tsx:getStockAggregates': { beim: 'handlung', grund: 'Ausfuhr nach Excel' },
  'pages/watches/WatchList.tsx:resolvePrimaryImageForExport': { beim: 'handlung', grund: 'Ausfuhr nach Excel' },
};

const dateien: string[] = [];
for (const root of ['pages', 'components']) {
  (function w(d: string) {
    for (const e of readdirSync(resolvePath(repo, 'src/' + d), { withFileTypes: true })) {
      const p = d + '/' + e.name;
      if (e.isDirectory()) { w(p); continue; }
      if (/\.(ts|tsx)$/.test(e.name)) dateien.push(p);
    }
  })(root);
}

// ── A — jede Fundstelle ist entweder weg oder eingeordnet ────────────────
{
  const offen: string[] = [];
  for (const f of dateien) {
    const s = codeOf(src('src/' + f));
    for (const [fn, modul] of DB_FN) {
      if (!new RegExp('\\b' + fn + '\\s*\\(').test(s)) continue;
      const schluessel = f + ':' + fn;
      if (!(schluessel in EINGEORDNET)) offen.push(`${schluessel} [${modul.replace('core/', '')}]`);
    }
  }
  ok(offen.length === 0,
    `A keine Seite ruft beim Zeichnen eine Datenbank-Kernfunktion (offen: ${offen.join(', ') || 'keine'})`);
}

// ── B — die Kernauskünfte gibt es, und sie sind benannt ──────────────────
{
  const ops = src('src/core/bridge/store-read-ops.ts');
  for (const name of ['ledger.balances.get', 'finance.receivables.get', 'inventory.lot_aggregates.get',
    'product.lots.get', 'expenses.credit_paid.get']) {
    ok(ops.includes(`'${name}'`), `B die Kernauskunft ${name} steht im Katalog`);
  }
  const domain = codeOf(src('src/core/data/domain-reads.ts'));
  ok(!/currentBranchId\(\)/.test(domain), 'B und keine von ihnen nimmt die Filiale aus der Primary-Sitzung');
  ok(/ctx\.branchId/.test(domain), 'B …sondern aus dem Ausweis der Anfrage');
  // Kopiert wird nichts: die Rechnungen bleiben in ihren Modulen.
  ok(!/SELECT /i.test(domain), 'B es steht keine eigene Abfrage darin — nur Aufrufe der vorhandenen Funktionen');
}

// ── C — die Forderungsaufstellung kennt jetzt eine Filiale ──────────────
{
  const r = src('src/core/finance/receivables.ts');
  ok(/export function receivablesBreakdown\(branchId\?: string\)/.test(r),
    'C die Forderungsaufstellung nimmt eine Filiale entgegen');
  const zaehler = (r.match(/branchId \? \[branchId\] : \[\]/g) || []).length;
  ok(zaehler === 4, `C …und gibt sie an alle vier Quellen weiter (${zaehler})`);
}

// ── D — der Nachlauf nach dem Anmelden gehört der Maschine ──────────────
{
  const a = src('src/stores/authStore.ts');
  ok(/function triggerMediaRecoveryPostAuth\(\): void \{[\s\S]{0,600}if \(readsFromPrimary\(\)\) return;/.test(a),
    'D Medien-Nachlauf und Telefon-Posteingang starten auf einem Client gar nicht erst');
  ok(/function branchesFor\(session: Session\)/.test(a),
    'D und die Filialliste faellt ohne Datenbank auf die Filiale des Ausweises zurueck');
}

// ── E — die Bestandsgetter nehmen die Zahlen entgegen ───────────────────
{
  const p = src('src/stores/productStore.ts');
  ok(/getStockValue: \(agg\?: Map<string, LotAggregate>\)/.test(p),
    'E der Bestandswert bekommt die Losezahlen als Parameter');
  ok(/getStockByCategory: \(agg\?: Map<string, LotAggregate>\)/.test(p),
    'E …und die Aufteilung nach Kategorie ebenso');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central ui parity r4a: transitive read surface: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R4A_TRANSITIVE_READ_SURFACE_AUDITED');
console.log('CENTRAL_UI_R4A_INDIRECT_DB_CRASH_REPRODUCED');
