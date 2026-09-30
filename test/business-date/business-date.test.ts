// ════════════════════════════════════════════════════════════════════════════
// BUSINESS-DATE — die EINE Regel für das wählbare Datum eines Vorgangs (Auftrag, Reparatur,
// Kommission, Approval-Übergabe, Fertigung): ein echter Kalendertag, nicht in der Zukunft.
// Die Wirkung je Modul steht in den Paritätstests (r5e, r5c, r5d, r6f).
// Run: node test/business-date/business-date.test.ts
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  businessDateIssue, businessTimestamp, isBusinessDate, latestBusinessDate, todayIso,
} from '../../src/core/utils/business-date.ts';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };

const NOW = Date.parse('2026-09-30T10:00:00.000Z');
ok(todayIso(NOW) === '2026-09-30' && latestBusinessDate(NOW) === '2026-10-01', 'HEUTE und der späteste wählbare Tag (morgen, für die Zeitzone)');
for (const leer of [undefined, null, '']) ok(businessDateIssue(leer, 'Order date', NOW) === null, `LEER (${String(leer)}) heißt „heute" — kein Fehler`);
ok(businessDateIssue('2026-09-30', 'Order date', NOW) === null && businessDateIssue('2026-08-15', 'Order date', NOW) === null
  && businessDateIssue('2019-01-01', 'Order date', NOW) === null, 'GÜLTIG heute und jeder frühere Tag');
ok(businessDateIssue('2026-10-01', 'Order date', NOW) === null, 'SPIELRAUM morgen ist erlaubt (Zeitzone)');
ok(businessDateIssue('2026-10-02', 'Order date', NOW) === 'Order date cannot be in the future'
  && businessDateIssue('2099-01-01', 'Received date', NOW) === 'Received date cannot be in the future', 'ZUKUNFT abgewiesen, mit dem Namen des Feldes');
for (const unsinn of ['2026-02-31', '2026-13-01', '30.09.2026', '2026-9-3', 'gestern', '2026-09-30T10:00:00.000Z', 20260930, {}]) {
  ok(businessDateIssue(unsinn, 'Order date', NOW) === 'Order date is not a valid date', `KEIN TAG ${JSON.stringify(unsinn)} → abgewiesen`);
}
ok(isBusinessDate('2026-08-15', NOW) && !isBusinessDate('2026-08-15T12:00:00.000Z', NOW) && !isBusinessDate('', NOW) && !isBusinessDate(undefined, NOW)
  && !isBusinessDate('2099-01-01', NOW), 'NUR ein Tag gilt als gewähltes Datum — kein Zeitstempel, nichts Leeres, nichts Künftiges');
const JETZT = '2026-09-30T10:00:00.000Z';
ok(businessTimestamp(undefined, JETZT) === JETZT && businessTimestamp('2026-09-30', JETZT) === JETZT, 'ZEITPUNKT ohne Wahl oder heute → jetzt (wie bisher)');
ok(businessTimestamp('2026-08-15', JETZT) === '2026-08-15T12:00:00.000Z', 'ZEITPUNKT ein früherer Tag → dieser Tag zur Mittagszeit (kein Verrutschen über Zeitzonen)');

// Jedes der fünf Module benutzt dieselbe Regel — keine zweite Datumsprüfung.
for (const [f, was] of [
  ['src/core/orders/order-create.ts', 'Auftrag'], ['src/core/repairs/repair-rules.ts', 'Reparatur'], ['src/core/consignment/consignment-create.ts', 'Kommission'],
  ['src/core/agents/transfer-rules.ts', 'Approval'], ['src/core/production/production-house.ts', 'Fertigung'],
] as Array<[string, string]>) {
  ok(/businessDateIssue\(/.test(src(f)) && /business-date/.test(src(f)), `EINE REGEL ${was} prüft mit business-date`);
}
ok(/ALTER TABLE orders ADD COLUMN order_date TEXT/.test(src('src/core/db/database.ts')), 'AUFTRAG eigene Spalte order_date (alte Aufträge: leer → Tag der Erfassung)');

// ── Telefon: dieselbe Regel, wörtlich eingebettet (mobile_business_date.js) ──
{
  const telefon: Record<string, unknown> = {};
  new Function('self', src('src-tauri/src/sync/mobile_business_date.js'))(telefon);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const MBD = telefon.MobileBusinessDate as any;
  const WERTE: unknown[] = [undefined, null, '', '2026-09-30', '2026-10-01', '2026-10-02', '2026-08-15', '2019-01-01', '2099-01-01', '2024-02-29', '2025-02-29',
    '2026-02-31', '2026-13-01', '30.09.2026', '2026-9-3', 'gestern', '2026-09-30T10:00:00.000Z', ' 2026-09-30', 20260930, {}, true];
  for (const jetzt of [NOW, Date.parse('2026-12-31T23:30:00.000Z'), Date.parse('2024-02-29T00:00:00.000Z')]) {
    const anders = WERTE.filter((w) => MBD.businessDateIssue(w, 'Purchase date', jetzt) !== businessDateIssue(w, 'Purchase date', jetzt)
      || MBD.isBusinessDate(w, jetzt) !== isBusinessDate(w, jetzt));
    ok(anders.length === 0 && MBD.todayIso(jetzt) === todayIso(jetzt) && MBD.latestBusinessDate(jetzt) === latestBusinessDate(jetzt),
      `PARITÄT Telefon == Rechner/Primary für ${WERTE.length} Werte am ${todayIso(jetzt)} (abweichend: ${JSON.stringify(anders)})`);
  }
  ok(MBD.todayIso() === todayIso() && MBD.latestBusinessDate() === latestBusinessDate() && MBD.businessDateIssue('2099-01-01', 'X') === businessDateIssue('2099-01-01', 'X'),
    'PARITÄT auch ohne übergebene Uhr (die echte Uhr des Geräts)');
  ok(JSON.stringify(MBD.pickDate('', 'Received date', NOW)) === JSON.stringify({ ok: true, date: '2026-09-30' })
    && JSON.stringify(MBD.pickDate(undefined, 'Received date', NOW)) === JSON.stringify({ ok: true, date: '2026-09-30' }),
    'TELEFON leer heißt heute — und der Auftrag trägt den Tag ausgeschrieben');
  ok(JSON.stringify(MBD.pickDate('2026-08-15', 'Received date', NOW)) === JSON.stringify({ ok: true, date: '2026-08-15' }), 'TELEFON ein früherer Tag bleibt genau dieser Tag');
  const zukunft = MBD.pickDate('2026-10-02', 'Agreement date', NOW), unsinn = MBD.pickDate('2026-02-31', 'Agreement date', NOW);
  ok(!zukunft.ok && zukunft.message === 'Agreement date cannot be in the future' && !unsinn.ok && unsinn.message === 'Agreement date is not a valid date',
    'TELEFON Zukunft und kein Kalendertag → kein Auftrag, mit dem Satz der gemeinsamen Regel');
  const seite = src('src-tauri/src/sync/mobile_page.rs');
  ok(seite.indexOf('include_str!("mobile_business_date.js")') > 0
    && seite.indexOf('include_str!("mobile_business_date.js")') < seite.indexOf('include_str!("mobile_repair_commands.js")'), 'TELEFON die Regel ist in die Seite eingebettet, vor den Befehlen');
  ok(/MBD\.businessDateIssue\(draft\.purchaseDate, 'Purchase date'/.test(src('src-tauri/src/sync/mobile_purchase_commands.js'))
    && /MobileBusinessDate\.pickDate\(\$\('rpReceivedDate'\)\.value, 'Received date'\)/.test(src('src-tauri/src/sync/mobile_repair_ui.js'))
    && /MobileBusinessDate\.pickDate\(\$\('cnAgreementDate'\)\.value, 'Agreement date'\)/.test(src('src-tauri/src/sync/mobile_consignment_ui.js')),
    'TELEFON Einkauf, Reparatur und Kommission prüfen mit dieser einen Regel');
  // Keine zweite Datumsprüfung am Telefon: nur die Regel selbst kennt das Muster JJJJ-MM-TT.
  const eigene = ['mobile_purchase_commands.js', 'mobile_purchase_ui.js', 'mobile_repair_commands.js', 'mobile_repair_ui.js', 'mobile_consignment_commands.js', 'mobile_consignment_ui.js']
    .filter((f) => /\\d\{4\}-\\d\{2\}-\\d\{2\}|\[0-9\]\{4\}-\[0-9\]\{2\}/.test(src('src-tauri/src/sync/' + f)));
  ok(eigene.length === 0, `TELEFON keine eigene Datumsprüfung neben der Regel (${eigene.join(', ') || 'keine'})`);
  ok(/businessDateIssue\(input\.purchaseDate, 'Purchase date'\)/.test(src('src/core/purchases/purchase-create.ts')), 'EINE REGEL Einkauf prüft am Primary mit business-date');
}

console.log(`\nbusiness-date: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('BUSINESS_DATE_PROVED');
