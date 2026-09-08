// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R3 §1/§2 — was kann die GEMEINSAME Oberfläche eigentlich schreiben?
// Run: node --experimental-strip-types test/uiparity/r3-write-matrix.test.ts
//
// Die Lesefläche ist geschlossen (R2D). Diese Prüfung stellt die Gegenfrage, und die Antwort ist
// unangenehm:
//
//   Die vierzig geprüften Fernbuchungen sind vollständig gebaut, in TS wie in Rust registriert,
//   mit Rechten, Ledger und Exactly-once — und **die laufende Oberfläche auf PC2 erreicht keine
//   einzige davon.**
//
// Der Grund ist der Umbau selbst. Bis zur Parität war `ClientShell` die Oberfläche des Clients:
// eigene, schlanke Masken, die die Fernbuchungen über `CommandSaveController` aufriefen. Seit der
// Parität führt `ClientShell` nur noch zum Server und meldet an; danach läuft dieselbe Anwendung
// wie am Primary. Deren Stores schreiben aber in die LOKALE Datenbank — die es auf PC2 nicht gibt.
//
// Damit ist eine vorhandene Fähigkeit nicht „noch nicht gebaut", sondern **unerreichbar geworden**.
// Genau das soll dieses Gate festhalten, damit es niemand für einen Konstruktionsstand hält.
//
// Es ist bewusst so gebaut, dass es beim Verdrahten von selbst grüner wird: `ERREICHBAR` liest den
// echten Code (`mutateViaPrimary('…')`), nicht eine Liste.
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
let PASS = 0; const fails: string[] = [];
const ok = (c: boolean, m: string) => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string) => readFileSync(resolvePath(repo, p), 'utf8');

// ── Die vierzig, aus dem Code ────────────────────────────────────────────
const reg = src('src/core/bridge/command-registry.ts');
const a = reg.indexOf('ALLOWED_MUTATIONS: readonly string[] = [');
const body = reg.slice(reg.indexOf('[', a) + 1, reg.indexOf('\n];', a));
const MUTATIONEN = [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);

/**
 * Die Zuordnung: welche sichtbare Handlung der gemeinsamen Oberfläche MEINT diese Buchung.
 * `gleich` sagt, ob es fachlich dieselbe Handlung ist — nicht bloß eine ähnliche.
 */
interface Zeile { ui: string; gleich: boolean; hinweis?: string }
const MATRIX: Record<string, Zeile> = {
  'invoices.create': { ui: 'InvoiceCreate — Rechnung anlegen', gleich: true },
  'invoices.update': { ui: 'InvoiceDetail — Rechnung bearbeiten', gleich: true },
  'invoices.record_payment': { ui: 'InvoiceDetail — Zahlung erfassen', gleich: true },
  'invoices.apply_credit': { ui: 'InvoiceDetail — Guthaben anrechnen', gleich: true },
  'invoices.update_payment': { ui: 'InvoiceDetail — Zahlung berichtigen', gleich: true },
  'invoices.delete_payment': { ui: 'InvoiceDetail — Zahlung loeschen', gleich: true },
  'customers.create': { ui: 'CustomerList/Detail — Kunde anlegen', gleich: true },
  'customers.update': { ui: 'CustomerDetail — Kunde bearbeiten', gleich: true },
  'products.create': { ui: 'WatchList — Artikel anlegen', gleich: false, hinweis: 'die Oberflaeche legt Artikel MIT Medien an (zweiphasig); die Buchung kennt nur die Stammdaten' },
  'products.update': { ui: 'ProductDetail — Artikel bearbeiten', gleich: false, hinweis: 'dasselbe: der Medienweg gehoert nicht zur Buchung' },
  'purchases.create': { ui: 'PurchaseCreate — Einkauf anlegen', gleich: true },
  'consignments.create': { ui: 'ConsignmentList — Kommission anlegen', gleich: true },
  'consignments.update': { ui: 'ConsignmentDetail — Kommission bearbeiten', gleich: true },
  'consignments.record_sale': { ui: 'ConsignmentDetail — Verkauf erfassen', gleich: true },
  'consignments.record_payout': { ui: 'ConsignmentDetail — Auszahlung erfassen', gleich: true },
  'consignments.mark_returned': { ui: 'ConsignmentDetail — zurueckgegeben', gleich: true },
  'orders.create': { ui: 'OrderCreate — Auftrag anlegen', gleich: true },
  'orders.update': { ui: 'OrderDetail — Auftrag bearbeiten', gleich: true },
  'orders.update_status': { ui: 'OrderDetail — Status setzen', gleich: true },
  'orders.add_payment': { ui: 'OrderDetail — Anzahlung erfassen', gleich: true },
  'orders.delete_payment': { ui: 'OrderDetail — Anzahlung loeschen', gleich: true },
  'orders.convert_to_invoice': {
    ui: 'OrderDetail — „Convert to invoice"',
    gleich: false,
    hinweis: 'die Buchung legt die Rechnung an und verknuepft die Zeilen; die Oberflaeche traegt DANACH den Anzahlungstopf ueber und teilt eine Ueberzahlung ab (carryOverOrderPaymentsToInvoice). Wer die Buchung allein aufruft, laesst Geld liegen',
  },
  'repairs.create': { ui: 'RepairList — Reparatur anlegen', gleich: true },
  'repairs.update': { ui: 'RepairDetail — Reparatur bearbeiten', gleich: true },
  'repairs.update_status': { ui: 'RepairDetail — Status setzen', gleich: true },
  'repairs.create_invoice': { ui: 'RepairDetail — Rechnung erzeugen', gleich: true },
  'repairs.add_line': { ui: 'RepairDetail — Arbeitszeile hinzufuegen', gleich: true },
  'repairs.update_line': { ui: 'RepairDetail — Arbeitszeile aendern', gleich: true },
  'repairs.cancel_line': { ui: 'RepairDetail — Arbeitszeile stornieren', gleich: true },
  'transfers.create': { ui: 'AgentList — Uebergabe anlegen', gleich: true },
  'transfers.update': { ui: 'TransferDetail — Uebergabe bearbeiten', gleich: true },
  'transfers.mark_returned': { ui: 'TransferDetail — zurueckerhalten', gleich: true },
  'transfers.mark_sold': { ui: 'TransferDetail — verkauft', gleich: true },
  'transfers.mark_settled': { ui: 'TransferDetail — abgerechnet', gleich: true },
  'transfers.convert_to_invoice': { ui: 'TransferDetail — in Rechnung wandeln', gleich: true },
  'transfers.convert_many_to_invoice': { ui: 'AgentList — mehrere wandeln', gleich: true },
  'returns.create': { ui: 'InvoiceDetail — Retoure anlegen', gleich: true },
  'returns.approve': { ui: 'ReturnDetail — Retoure genehmigen', gleich: true },
  'returns.refund': { ui: 'ReturnDetail — erstatten', gleich: true },
  'returns.record_refund_payment': { ui: 'ReturnDetail — Erstattung auszahlen', gleich: true },
};

// ── A — die Matrix ist vollständig ───────────────────────────────────────
{
  ok(MUTATIONEN.length === 40, `A vierzig Buchungen (${MUTATIONEN.length})`);
  const fehlend = MUTATIONEN.filter((m) => !(m in MATRIX));
  ok(fehlend.length === 0, `A jede ist einer sichtbaren Handlung zugeordnet (offen: ${fehlend.join(', ') || 'keine'})`);
  const erfunden = Object.keys(MATRIX).filter((m) => !MUTATIONEN.includes(m));
  ok(erfunden.length === 0, `A und keine erfundene steht in der Matrix (${erfunden.join(', ') || 'keine'})`);
}

// ── B — was die ALTE Client-Oberfläche erreichte ─────────────────────────
//
// Die Belege stehen in `src/components/client/*`: dort ruft jede Maske ihre Buchung beim Namen.
{
  const dir = resolvePath(repo, 'src/components/client');
  let alt = '';
  for (const f of readdirSync(dir)) if (/\.tsx?$/.test(f)) alt += readFileSync(resolvePath(dir, f), 'utf8');
  const erreichbarAlt = MUTATIONEN.filter((m) => alt.includes(`'${m}'`) || alt.includes(`"${m}"`));
  ok(erreichbarAlt.length >= 38,
    `B die alte Client-Oberflaeche erreichte ${erreichbarAlt.length} der vierzig Buchungen`);

  // …und sie ist seit der Paritaet nur noch VOR der Anmeldung zu sehen.
  const app = src('src/App.tsx');
  ok(/if \(!session\) \{[\s\S]{0,80}return <ClientShell/.test(app),
    'B seit der Paritaet erscheint sie nur noch ohne Sitzung — danach laeuft die normale Anwendung');
}

// ── C — was die GEMEINSAME Oberfläche heute erreicht ─────────────────────
//
// Gesucht wird der Schreibweg, nicht die Absicht: ein Aufruf des Fernbuchungswegs aus einem Store
// oder einer Seite. Solange es ihn nicht gibt, ist die Antwort null.
{
  let gemeinsam = '';
  for (const wurzel of ['src/stores', 'src/pages', 'src/components']) {
    (function walk(d: string) {
      for (const e of readdirSync(resolvePath(repo, d), { withFileTypes: true })) {
        const p = d + '/' + e.name;
        if (e.isDirectory()) { if (!p.endsWith('/client')) walk(p); continue; }
        if (!/\.(ts|tsx)$/.test(e.name)) continue;
        gemeinsam += readFileSync(resolvePath(repo, p), 'utf8');
      }
    })(wurzel);
  }
  const seam = existsSync(resolvePath(repo, 'src/core/data/primary-write.ts'));
  const erreichbar = seam
    ? MUTATIONEN.filter((m) => new RegExp(`mutateViaPrimary\\(\\s*'${m.replace('.', '\\.')}'`).test(gemeinsam))
    : [];

  console.log(`\n  Fernbuchungen, die die GEMEINSAME Oberflaeche erreicht: ${erreichbar.length} von ${MUTATIONEN.length}`);
  ok(erreichbar.length === 0 || erreichbar.length > 0, 'C (Zaehlung)');

  // Die Zusage, die hier zaehlt: es gibt KEINEN lokalen Schreibweg, der auf einem Client still
  // ins Leere liefe. Entweder die Buchung geht ueber die Bruecke — oder die Handlung wird gar
  // nicht angeboten. Solange die Bruecke fehlt, muss das ehrlich benannt sein.
  ok(!seam || erreichbar.length > 0,
    'C wenn es einen Schreibweg gibt, wird er auch benutzt');
}

// ── D — die vier zuletzt als „Lücke" geführten Handlungen, nachgeprüft ───
{
  const convert = MATRIX['orders.convert_to_invoice'];
  ok(convert.gleich === false && !!convert.hinweis,
    'D Auftrag→Rechnung: die vorhandene Buchung ist ENGER als die Handlung der Oberflaeche');
  const fin = src('src/core/bridge/financial-commands.ts');
  const seite = src('src/pages/orders/OrderDetail.tsx');
  ok(/carryOverOrderPaymentsToInvoice/.test(seite),
    'D die Oberflaeche traegt den Anzahlungstopf ueber…');
  ok(!/carryOverOrderPayments|converted_to_invoice/.test(fin.slice(fin.indexOf('function runConvertOrder'), fin.indexOf('// ── Einlieferer auszahlen'))),
    'D …die Buchung tut es nicht — dieselbe Kennung, zwei verschiedene Wirkungen');

  // Die anderen drei haben ueberhaupt keine passende Buchung.
  for (const [was, muster] of [
    ['Inventursitzung', /inventory|stock_check/i],
    ['Steuerzahlung', /tax_payment/i],
    ['Nachbuchung', /backfill/i],
  ] as Array<[string, RegExp]>) {
    ok(!MUTATIONEN.some((m) => muster.test(m)), `D fuer „${was}" gibt es keine Fernbuchung — echte Luecke`);
  }
}

// ── E — kein stiller Fehlschlag ──────────────────────────────────────────
//
// Was die gemeinsame Oberfläche heute auf einem Client tut, wenn jemand speichert: sie ruft
// `getDatabase()`, das wirft, und der Klick endet in einem Fehler. Das ist NICHT still — aber es
// ist auch nicht die Zusage aus §2 („sichtbar disabled/unsupported"). Solange die Brücke fehlt,
// wird das hier festgehalten statt beschönigt.
{
  const cust = src('src/stores/customerStore.ts');
  ok(/getDatabase\(\)/.test(cust) && !/mutateViaPrimary/.test(cust),
    'E ein Beispiel-Schreibweg der gemeinsamen Oberflaeche geht heute noch in die lokale Datenbank');
  ok(/if \(!db\) throw new Error\('Database not initialized'\)/.test(src('src/core/db/database.ts')),
    'E …und die wirft auf einem Client, statt still nichts zu tun');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central ui parity r3: write matrix: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R3_EXISTING_WRITE_CAPABILITIES_RECONCILED');
console.log('CENTRAL_UI_R3_WRITE_GAPS_ACCURATE');
