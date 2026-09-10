// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R4C §1/§2/§7/§10 — die vierzig Buchungen gegen den echten Quelltext.
// Run: node --experimental-strip-types test/uiparity/r4c-write-matrix.test.ts
//
// Die Matrix (`_r4c-write-matrix.ts`) ist die eine Quelle. Dieses Gate sorgt dafür, dass sie
// nicht zur Erzählung wird:
//
//   • genau vierzig Zeilen, eine je freigegebener Buchung — keine erfunden, keine vergessen;
//   • jede Zeile nennt eine Datei, die es gibt, und eine lokale Funktion, die dort wirklich steht;
//   • `verdrahtet` ist keine Behauptung: die Datei muss die Buchung über die gemeinsame Weiche
//     rufen, und die lokale Funktion darf im Speicherweg NUR im Primary-Anschluss stehen;
//   • `enger` heißt: NICHT verdrahtet — und der Grund steht dabei;
//   • die Registry bleibt bei 107. R4C fügt keine Buchung hinzu.
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
let PASS = 0; const fails: string[] = [];
const ok = (c: boolean, m: string) => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string) => readFileSync(resolvePath(repo, p), 'utf8');
const codeOf = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const { R4C_MATRIX } = await import('./_r4c-write-matrix.ts');

// ── §1 Die Matrix deckt sich mit der Freigabeliste ──────────────────────
const registry = src('src/core/bridge/command-registry.ts');
const erlaubt = [...(/export const ALLOWED_MUTATIONS: readonly string\[\] = \[([\s\S]*?)\];/
  .exec(registry)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);

ok(erlaubt.length === 40, `1 die Freigabeliste zaehlt vierzig Buchungen (${erlaubt.length})`);
ok(R4C_MATRIX.length === 40, `1 die Matrix zaehlt vierzig Zeilen (${R4C_MATRIX.length})`);
{
  const inMatrix = new Set(R4C_MATRIX.map((z) => z.op));
  const fehlend = erlaubt.filter((o) => !inMatrix.has(o));
  const erfunden = R4C_MATRIX.map((z) => z.op).filter((o) => !erlaubt.includes(o));
  ok(fehlend.length === 0, `1 keine Buchung fehlt in der Matrix (${fehlend.join(', ') || 'keine'})`);
  ok(erfunden.length === 0, `1 und keine Zeile erfindet einen Namen (${erfunden.join(', ') || 'keine'})`);
  ok(inMatrix.size === 40, `1 …jede genau einmal (${inMatrix.size})`);
}

// ── §1 Jede Zeile zeigt auf echten Quelltext ────────────────────────────
for (const z of R4C_MATRIX) {
  if (z.ort === '(keine)') {
    ok(z.paritaet === 'keine-ui', `1 ${z.op}: „(keine)" nur fuer eine fehlende Handlung`);
    continue;
  }
  const pfad = 'src/' + z.ort;
  ok(existsSync(resolvePath(repo, pfad)), `1 ${z.op}: die genannte Datei gibt es (${z.ort})`);
  if (!existsSync(resolvePath(repo, pfad))) continue;
  const s = codeOf(src(pfad));
  ok(new RegExp(`\\b${z.lokal}\\(`).test(s),
    `1 ${z.op}: ${z.lokal}() steht wirklich in ${z.ort.split('/').pop()}`);
}

// ── §2/§7 Die Einordnung ist vollstaendig und widerspruchsfrei ──────────
for (const z of R4C_MATRIX) {
  if (z.paritaet === 'enger') {
    ok(z.verdrahtet === false, `2 ${z.op}: „enger" heisst NICHT verdrahtet`);
    ok(z.luecke === 'B', `7 ${z.op}: „enger" ist Klasse B`);
    ok(z.grund.length > 60, `7 ${z.op}: der Grund ist ausformuliert (${z.grund.length} Zeichen)`);
  }
  if (z.paritaet === 'keine-ui') {
    ok(z.verdrahtet === false, `2 ${z.op}: ohne Handlung gibt es nichts zu verdrahten`);
    ok(z.luecke === null, `7 ${z.op}: keine Luecke in der Oberflaeche`);
  }
  if (z.verdrahtet) {
    ok(z.paritaet === 'exakt', `2 ${z.op}: verdrahtet wird nur, was exakt passt`);
    ok(z.luecke === null, `7 ${z.op}: eine verdrahtete Handlung hat keine Luecke`);
  }
}

// ── §3 „verdrahtet" ist im Quelltext nachweisbar ────────────────────────
const RUFT = (s: string, op: string) =>
  new RegExp(`(useSharedWrite<[^>]*>\\(|\\w+\\.(ok|save)(<[^>]*>)?\\()\\s*'${op.replace(/\./g, '\\.')}'`).test(s);
for (const z of R4C_MATRIX.filter((x) => x.verdrahtet)) {
  const s = codeOf(src('src/' + z.ort));
  ok(RUFT(s, z.op), `3 ${z.op}: ${z.ort.split('/').pop()} ruft die Buchung ueber die gemeinsame Weiche`);
  // Und die lokale Funktion steht im SPEICHERWEG nur im Primary-Anschluss. Ausserhalb darf sie
  // vorkommen — dann gehoert sie zu einer ANDEREN Handlung derselben Buchung, und die ist in der
  // Matrix als eigener Fall benannt (z. B. die Materialzeile einer Reparatur).
  const ohneAnschluss = s.replace(/local: [\s\S]*?(?=\n\s*remote:)/g, '');
  const imWeg = new RegExp(`\\w+\\.ok\\('${z.op.replace(/\./g, '\\.')}'[\\s\\S]{0,900}`).exec(ohneAnschluss)?.[0] ?? '';
  const frei = (imWeg.match(new RegExp(`\\b${z.lokal}\\(`, 'g')) || []).length;
  // `deletePayment`/`updatePayment` heissen in mehreren Stores gleich; gezaehlt wird nur, was
  // AUSSERHALB der Anschluesse steht — dort darf die Funktion nicht mehr aufgerufen werden.
  ok(frei === 0, `3 ${z.op}: ${z.lokal}() steht nur noch im Primary-Anschluss (${frei} frei)`);
}

// ── §3 Was NICHT verdrahtet ist, ruft die Buchung auch nicht ────────────
for (const z of R4C_MATRIX.filter((x) => !x.verdrahtet && x.ort !== '(keine)')) {
  const s = codeOf(src('src/' + z.ort));
  ok(!RUFT(s, z.op), `3 ${z.op}: nicht verdrahtet — und wird auch nicht heimlich gerufen`);
}

// ── §4 Der asynchrone Vertrag an jeder verdrahteten Stelle ──────────────
{
  const dateien = [...new Set(R4C_MATRIX.filter((z) => z.verdrahtet).map((z) => z.ort))];
  for (const f of dateien) {
    const s = codeOf(src('src/' + f));
    ok(/await \w+\.ok\(|await \w+\.save\(/.test(s), `4 ${f.split('/').pop()}: gespeichert wird mit await`);
    ok(/\w+\.busy/.test(s), `4 ${f.split('/').pop()}: …und der Knopf ist waehrenddessen gesperrt`);
    ok(/<WriteError text=|data-save-error/.test(s), `4 ${f.split('/').pop()}: …und der Ausgang wird angezeigt`);
    ok(!/isClientMode\(\)/.test(s), `4 …die Seite fragt nicht selbst nach der Betriebsart`);
  }
}

// ── §5 Fassungsbasierte Buchungen nennen die gesehene Fassung ───────────
{
  const REVISION_OPS = [...(src('src/core/bridge/lifecycle-commands.ts')
    + src('src/core/bridge/financial-commands.ts')
    + src('src/core/bridge/invoice-lifecycle-commands.ts')
    + src('src/core/bridge/service-commands.ts')
    + src('src/core/bridge/commercial-commands.ts')
    + src('src/core/bridge/return-commands.ts'))
    .matchAll(/onlyKnownFields\(raw, \[([^\]]*)\]\)/g)]
    .filter((m) => m[1].includes("'expectedRevision'")).length;
  ok(REVISION_OPS >= 15, `5 die meisten Geldbuchungen verlangen die gesehene Fassung (${REVISION_OPS})`);

  for (const z of R4C_MATRIX.filter((x) => x.verdrahtet)) {
    const s = codeOf(src('src/' + z.ort));
    const treffer = new RegExp(`\\w+\\.ok\\('${z.op.replace(/\./g, '\\.')}'[\\s\\S]{0,1200}`).exec(s)?.[0] ?? '';
    // Das Fenster reicht bewusst UEBER den Aufruf hinaus: das frische Lesen steht danach.
    const stelle = treffer.slice(0, 1200);
    if (!/expectedRevision/.test(stelle.slice(0, 700))) continue;
    // Zwei zulaessige Formen, und beide sagen dasselbe: entweder die Fassung steht direkt in
    // der Handlung, oder die Seite hat EINEN Helfer dafuer (`fassungVon`/`fassungOderNichts`) —
    // der ist bei mehreren Handlungen je Seite die ehrlichere Form, nicht die schwaechere.
    ok(/const fassung = \w+(\?)?\.revision;/.test(s) || /\?\.revision;/.test(s),
      `5 ${z.op}: die Fassung kommt aus dem gelesenen Datensatz, nicht aus der Luft`);
    ok(/if \(w\.remote && !fassung\)/.test(s) || /if \(w\.remote && !rev\)/.test(s),
      `5 ${z.op}: ohne gelesene Fassung wird am Client gar nicht erst geschickt`);
    ok(/load(Invoices|Orders|Consignments|Repairs|RepairLines|Transfers|SalesReturns|Payments)\(/.test(stelle),
      `5 ${z.op}: nach dem Erfolg wird frisch gelesen — die naechste Handlung braucht die NEUE Fassung`);
  }
  // Und die Fassung steht wirklich im gemeinsamen Lesestand.
  for (const [datei, name] of [
    ['src/stores/invoiceStore.ts', 'rowToInvoice'],
    ['src/stores/orderStore.ts', 'rowToOrder'],
    ['src/stores/consignmentStore.ts', 'rowToConsignment'],
    ['src/stores/repairStore.ts', 'rowToRepair'],
    ['src/stores/agentStore.ts', 'rowToTransfer'],
    ['src/stores/salesReturnStore.ts', 'rowToReturn'],
  ] as const) {
    const s = src(datei);
    const rumpf = s.slice(s.indexOf('function ' + name + '('), s.indexOf('function ' + name + '(') + 900);
    ok(/revision: row\.revision/.test(rumpf), `5 ${name}() reicht die Fassung durch`);
  }
}

// ── §8 Kein stiller lokaler Weg unter den nicht migrierten Handlungen ───
{
  const dateien = readdirSync(resolvePath(repo, 'src/stores')).filter((f) => f.endsWith('.ts'));
  let geprueft = 0; const ohne: string[] = [];
  for (const f of dateien) {
    const s = codeOf(src('src/stores/' + f));
    for (const m of s.matchAll(/^ {2}(create|update|delete|record|add|remove|cancel|convert|apply|edit|mark|insert)[A-Za-z0-9_]*: \(?[^\n]*\) => \{([\s\S]*?)\n {2}\},/gm)) {
      if (!/\bdb\.run\(|\bgetDatabase\(|\bquery\(/.test(m[2])) continue;
      geprueft++;
      if (!/getDatabase\(\)|withTransaction|beginLedgerTransaction|query\(/.test(m[2])) ohne.push(f + ':' + m[1]);
    }
  }
  ok(geprueft > 40, `8 der Riegel wurde an ${geprueft} schreibenden Store-Aktionen geprueft`);
  ok(ohne.length === 0, `8 keine schreibende Store-Aktion kommt ohne Datenbank aus (${ohne.join(', ') || 'keine'})`);
}

// ── §10 Die Registry bleibt, wie sie war ────────────────────────────────
{
  const ops = src('src/core/bridge/store-read-ops.ts');
  const parity = [...ops.matchAll(/export const OP_[A-Z_]+ = '([^']+)'/g)].length;
  ok(parity === 48, `10 achtundvierzig typisierte Auskuenfte (${parity})`);
  ok(erlaubt.length === 40, `10 vierzig Buchungen — R4C fuegt keine hinzu (${erlaubt.length})`);
  const rust = src('src-tauri/src/bridge.rs');
  const rustOps = [...(/pub const REMOTE_OPS: &\[&str\] = &\[([\s\S]*?)\];/.exec(rust)?.[1] ?? '')
    .matchAll(/OP_[A-Z_]+/g)].length;
  ok(rustOps === 107, `10 und Rust laesst dieselben 107 Namen durch (${rustOps})`);
}

// ── R5A — Auftrag → Rechnung: EINE Handlung, EINE Buchung ───────────────
{
  const z = R4C_MATRIX.find((x) => x.op === 'orders.convert_to_invoice');
  ok(!!z && z.verdrahtet === true && z.luecke === null,
    'R5A die Auftragsumwandlung ist geschlossen');
  // Die Rechnung dahinter wohnt jetzt in einer Domaenendatei — nicht mehr in der Komponente.
  const dom = codeOf(src('src/core/orders/order-payment-carryover.ts'));
  ok(/export function carryOverOrderPaymentsToInvoice\(/.test(dom),
    'R5A der Anzahlungsuebertrag ist eine Domaenenfunktion');
  ok(/markConvertedToInvoice\(orderId\)/.test(dom) && /recordPayment\(/.test(dom),
    'R5A …und er enthaelt den ganzen Vertrag: Umkehr, Anrechnung, Ueberschuss');
  // Beide Seiten rufen DIESELBE — kopiert ist nichts.
  for (const [datei, wer] of [
    ['src/pages/orders/OrderDetail.tsx', 'die Auftragsansicht'],
    ['src/core/bridge/financial-commands.ts', 'der Fernbefehl'],
  ] as const) {
    ok(/carryOverOrderPaymentsToInvoice\(/.test(codeOf(src(datei))),
      `R5A ${wer} ruft dieselbe Funktion`);
    ok(/order-payment-carryover/.test(src(datei)), `R5A …und importiert sie von dort`);
  }
  const ui = codeOf(src('src/pages/orders/OrderDetail.tsx'));
  ok(!/const poolRows = query\(/.test(ui),
    'R5A in der Oberflaeche steht keine Uebertragungsrechnung mehr');
  // Kein Nacheinander mehrerer Befehle fuer eine Handlung.
  const stelle = /if \(w\.remote\) \{\s*const fassung = order\.revision;[\s\S]{0,1600}?orders\.convert_to_invoice[\s\S]{0,600}?\n    \}/.exec(ui)?.[0] ?? '';
  ok(stelle.length > 100, 'R5A der Client-Weg der Umwandlung ist auffindbar');
  ok((stelle.match(/\w+\.(ok|save)(<[^>]*>)?\(/g) || []).length === 1,
    'R5A …und er schickt GENAU EINE Buchung, kein Nacheinander');

  // Die Kartenart der Anzahlung reist mit — gerechnet wird die Gebuehr im Haus.
  const lc = codeOf(src('src/core/bridge/lifecycle-commands.ts'));
  ok(/'note', 'cardBrand'\]/.test(lc), 'R5A die Anzahlung nimmt die Kartenart entgegen');
  ok(/CARD_BRANDS as readonly string\[\]/.test(lc),
    'R5A …geprueft gegen die Liste des Hauses');
  ok(!/computeCardFee|cardFeeRate/.test(lc),
    'R5A …und die Gebuehr rechnet der Fernbefehl NICHT selbst');
  const cf = src('src/core/finance/card-fees.ts');
  ok(/export const CARD_BRANDS = \['normal', 'amex'\] as const;/.test(cf)
    && /export type CardBrand = typeof CARD_BRANDS\[number\];/.test(cf),
    'R5A die Kartenarten sind ein WERT, aus dem der Typ folgt');
}

// ── R4C.4 — die Arbeitsarten: EINE Liste, zwei Leser ────────────────────
{
  const typen = src('src/core/models/types.ts');
  const treffer = /export const REPAIR_WORK_TYPES = \[([\s\S]*?)\] as const;/.exec(typen);
  ok(!!treffer, 'S die Arbeitsarten stehen als LISTE da, nicht nur als Typ');
  const werte = [...(treffer?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  ok(werte.length === 8 && werte.includes('service') && werte.includes('spare_part'),
    `S …und es sind die acht des Hauses (${werte.join(',')})`);
  ok(/export type RepairWorkType = typeof REPAIR_WORK_TYPES\[number\];/.test(typen),
    'S der Typ wird aus der Liste abgeleitet — nicht daneben gepflegt');

  const lc = codeOf(src('src/core/bridge/lifecycle-commands.ts'));
  ok(/const WORK_TYPES = REPAIR_WORK_TYPES;/.test(lc),
    'S der Fernbefehl liest dieselbe Liste');
  ok(!/const WORK_TYPES = \['/.test(lc),
    'S …und hat keine eigene mehr');
  ok(/import \{ REPAIR_WORK_TYPES \} from '@\/core\/models\/types';/.test(src('src/core/bridge/lifecycle-commands.ts')),
    'S …sie kommt aus der Quelle des Hauses');

  const ui = codeOf(src('src/pages/repairs/RepairDetail.tsx'));
  ok(/REPAIR_WORK_TYPES\.map\(/.test(ui),
    'S und die Maske zeichnet ihre Auswahl aus derselben Liste');
  ok(!/<option value="polishing">/.test(ui),
    'S …statt aus abgeschriebenen Eintraegen');
  // Kein Alias auf Verdacht: die alten Fernwoerter tauchen im Vertrag nicht mehr auf.
  for (const alt of ['labor', 'polish', 'diamond', 'parts']) {
    ok(!new RegExp(`WORK_TYPES[\\s\\S]{0,200}'${alt}'`).test(lc),
      `S kein Alias auf Verdacht: '${alt}' steht nicht mehr im Vertrag`);
  }
}

// ── R5A.1 — die Auftragspositionen erreichen den zweiten Rechner ────────
{
  const st = codeOf(src('src/stores/orderStore.ts'));
  ok(st.includes('export function rowToOrderLine('),
    'R5A.1 die Zeilen-Abbildung hat einen Namen — der Lesestand benutzt dieselbe');
  ok(st.includes('orderLines: zeilen.map(rowToOrderLine)'),
    'R5A.1 …und der gemeinsame Lesestand traegt die Positionen mit');
  ok(st.includes('if (readsFromPrimary()) return (get().orderLines'),
    'R5A.1 der Client nimmt sie von dort, der Primary bleibt bei seiner Datenbank');
  ok(st.includes('JOIN orders o ON o.id = ol.order_id') && st.includes('WHERE o.branch_id = ?'),
    'R5A.1 …und sie sind an die Filiale des Ausweises gebunden');
}

// ── R5A.2 — nach „abrechenbar": dieselbe Zeilenrechnung, und die Wahl reist mit ──
{
  const dom = codeOf(src('src/core/orders/order-invoice-lines.ts'));
  ok(/export function buildOrderInvoiceLines\(/.test(dom) && /vatEngine\.calculateNet\(/.test(dom),
    'R5A.2 die Rechnungszeilen eines Auftrags sind eine Domaenenfunktion');
  const ui = codeOf(src('src/pages/orders/OrderDetail.tsx'));
  const fc = codeOf(src('src/core/bridge/financial-commands.ts'));
  ok(/buildOrderInvoiceLines\(/.test(ui) && /buildOrderInvoiceLines\(/.test(fc),
    'R5A.2 Ansicht und Fernbefehl rufen DIESELBE');
  ok(!/for \(const ol of billableLines\)/.test(ui), 'R5A.2 …und in der Ansicht steht keine zweite');
  ok(!/net \* rate \/ 100/.test(fc), 'R5A.2 der Fernbefehl setzt die Steuer nicht mehr selbst obendrauf');
  ok(/'taxSchemes', 'specialMark', 'markComplete'\]/.test(fc), 'R5A.2 die Wahl der Dialoge ist Teil des Vertrags');
  ok(/TAX_SCHEMES as readonly unknown\[\]/.test(fc), 'R5A.2 …das Schema geprueft gegen die Liste des Hauses');
  ok(/export const TAX_SCHEMES = \['VAT_10', 'ZERO', 'MARGIN'\] as const;/.test(src('src/core/models/types.ts'))
    && /export type TaxSchemeCanonical = typeof TAX_SCHEMES\[number\];/.test(src('src/core/models/types.ts')),
    'R5A.2 die Steuerschemata sind ein WERT, aus dem der Typ folgt');
  ok(/req\.specialMark === true/.test(fc), 'R5A.2 die Nummernart erreicht die Rechnung');
  ok(/ORDER_LINES_CHANGED/.test(fc), 'R5A.2 eine andere als die gezeigte Zeilenmenge wird abgelehnt');
  ok(/ORDER_LINE_WITHOUT_PRODUCT/.test(fc), 'R5A.2 …und der Fernbefehl legt keinen Artikel an');
  ok(/taxSchemes,\s*specialMark: specialMark === true, markComplete: markCompleteOnConvert === true/.test(ui),
    'R5A.2 der Client schickt, was die Dialoge bestaetigt haben');
  ok(/converting an order without saved tax schemes/.test(ui),
    'R5A.2 der Altweg ist auf dem Client ein ausdrueckliches Nein, kein lokaler Schreibversuch');
  ok(/converting an order line that has no article yet/.test(ui), 'R5A.2 …ebenso eine Position ohne Artikel');
  ok(/markConvertedLinesDelivered\(/.test(ui) && /markConvertedLinesDelivered\(/.test(fc),
    'R5A.2 „abschliessen" laeuft ueber dieselbe Funktion');
  ok(/if \(r\.kind !== 'ok'\) setFehler\(fehlertext\(r\)\);/.test(codeOf(src('src/core/data/shared-write.ts'))),
    'R5A.2 auch `save` legt den Grund in die Anzeige — kein Ausgang verschwindet still');
}

// ── Der Stand, offen benannt ────────────────────────────────────────────
const verdrahtet = R4C_MATRIX.filter((z) => z.verdrahtet);
const offenExakt = R4C_MATRIX.filter((z) => z.paritaet === 'exakt' && !z.verdrahtet);
const luecken = R4C_MATRIX.filter((z) => z.luecke !== null);
const ohneUi = R4C_MATRIX.filter((z) => z.paritaet === 'keine-ui');
console.log(`\n  Stand: ${verdrahtet.length} verdrahtet · ${offenExakt.length} exakt aber offen · `
  + `${luecken.length} Luecken (Klasse B) · ${ohneUi.length} ohne Handlung`);
if (offenExakt.length > 0) console.log('  offen: ' + offenExakt.map((z) => z.op).join(', '));

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central ui parity r4c: 40 mutation matrix: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R4C_40_MUTATIONS_RECONCILED');
console.log('CENTRAL_UI_R4C_SEMANTIC_PARITY_CLASSIFIED');
console.log('CENTRAL_UI_R4C_ASYNC_WRITE_UI_PROVED');
console.log('CENTRAL_UI_R4C_REVISION_PATHS_PROVED');
console.log('CENTRAL_UI_R4C_REMAINING_WRITE_GAPS_EXACT');
console.log('CENTRAL_UI_R4C4_REPAIR_WORKTYPE_VOCABULARY_AUDITED');
console.log('CENTRAL_UI_R4C4_REPAIR_WORKTYPE_SSOT_PROVED');
console.log('CENTRAL_UI_R5A_CLASS_B_SCOPE_FROZEN');
console.log('CENTRAL_UI_R5A_ORDER_PAYMENT_SEMANTICS_AUDITED');
console.log('CENTRAL_UI_R5A_ATOMIC_ORDER_CONVERSION_PROVED');
console.log('CENTRAL_UI_R5A_SHARED_ORDER_PAYMENT_DOMAIN_PROVED');
console.log('CENTRAL_UI_R5A_MATRIX_UPDATED');
console.log('CENTRAL_UI_R5A1_CONVERSION_PRECOMMAND_BLOCKER_AUDITED');
console.log('CENTRAL_UI_R5A1_BILLABLE_LINE_PARITY_PROVED');
