// ════════════════════════════════════════════════════════════════════════════
// MOBILE-EDIT v0.8.48 — die Preissperre auf dem Handy ERKLAERT sich, statt zu verschwinden.
// Run: node test/mobile-price-eligibility/price-lock-display.test.ts
//
// Bis hierher verschwanden die drei Preisfelder bei einem gebundenen Artikel einfach. Das ist die
// schlechteste Variante: der Nutzer sieht weder den Preis noch einen Grund und haelt es fuer einen
// Fehler. Jetzt stehen sie sichtbar da, gesperrt, mit dem konkreten Grund daneben.
//
// Geprueft wird die ECHTE Funktion aus `src-tauri/src/sync/mobile_page.rs` — genau der Quelltext,
// der in `MOBILE_HTML` einbetoniert und ans Handy ausgeliefert wird — plus Quelltext-Waechter ueber
// die Stellen, die diese Anzeige tragen. Die Sperre selbst bleibt server-/coreseitig verbindlich:
// dass hier nichts freigeschaltet wird, ist Teil der Pruefung.
// ════════════════════════════════════════════════════════════════════════════
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
let PASS = 0, FAIL = 0; const failures: string[] = [];
function ok(cond: unknown, msg: string): void { if (cond) PASS++; else { FAIL++; failures.push(msg); console.log(`  x ${msg}`); } }

const pageSrc = readFileSync(join(repo, 'src-tauri/src/sync/mobile_page.rs'), 'utf8');

// ── die echte Hinweis-Funktion herausschneiden (klammergezaehlt, nicht geraten) ───────────────────
const START = 'const priceLockText = (function () {';
const start = pageSrc.indexOf(START);
ok(start >= 0, 'mobile_page.rs carries the price-lock hint builder');
let depth = 0, end = -1, seen = false;
for (let i = start; i < pageSrc.length; i++) {
  const ch = pageSrc[i];
  if (ch === '{') { depth++; seen = true; }
  else if (ch === '}') { depth--; if (seen && depth === 0) { end = pageSrc.indexOf(';', i) + 1; break; } }
}
const stmt = pageSrc.slice(start, end);
ok(/price_lock_reason/.test(stmt), 'the extracted builder reads the verdict the read contract sends');

const hint = (p: Record<string, unknown>): string =>
  new Function('p', `${stmt} return priceLockText;`)(p) as string;

// ── der konkrete Grund wird benannt, wenn er sicher bekannt ist ──────────────────────────────────
const invoice = hint({ price_editable: false, price_lock_reason: 'linked', price_lock_detail: 'Invoice' });
ok(invoice === '🔒 Price editing locked — linked to Invoice.', `an invoice is named as such (${invoice})`);
for (const [detail, expect] of [
  ['Purchase', '🔒 Price editing locked — linked to Purchase.'],
  ['Stock lot', '🔒 Price editing locked — linked to Stock lot.'],
  ['Consignment', '🔒 Price editing locked — linked to Consignment.'],
  ['Order', '🔒 Price editing locked — linked to Order.'],
  ['Repair', '🔒 Price editing locked — linked to Repair.'],
] as const) {
  const t = hint({ price_lock_reason: 'linked', price_lock_detail: detail });
  ok(t === expect, `${detail} reads as its own reason (${t})`);
}

// Fremde Ware ist kein Dokument, sondern eine Eigentumsfrage — und liest sich auch so.
const cons = hint({ price_lock_reason: 'not_own_stock', price_lock_detail: 'Consignment' });
ok(/consignment stock/.test(cons) && /consignor/.test(cons), `consigned stock explains the ownership (${cons})`);
const agent = hint({ price_lock_reason: 'not_own_stock', price_lock_detail: 'Agent' });
ok(/out with an agent/.test(agent), `agent stock explains where the piece is (${agent})`);

// ── kein erfundener Grund ────────────────────────────────────────────────────────────────────────
//
// Das ist der Kern: lieber "gesperrt" ohne Begruendung als eine falsche Begruendung. Ein Nutzer, dem
// eine Rechnung genannt wird, die es nicht gibt, sucht danach.
for (const p of [
  { price_lock_reason: 'unknown' },
  { price_lock_reason: 'unknown', price_lock_detail: null },
  { price_lock_reason: 'linked' },                       // Grund ohne Detail
  { price_lock_reason: 'not_own_stock' },                // Klasse ohne Detail
  { price_lock_reason: 'not_own_stock', price_lock_detail: 'SOMETHING_NEW' },
  { price_lock_reason: 'linked', price_lock_detail: 42 },  // kein Text -> keine Behauptung
  {},
] as Array<Record<string, unknown>>) {
  const t = hint(p);
  ok(t === '🔒 Price editing locked for this item.',
    `an uncertain reason stays generic instead of inventing one (${JSON.stringify(p)} -> ${t})`);
  ok(!/linked to/.test(t) && !/Invoice|Purchase|agent|consignor/.test(t),
    `…and names nothing at all (${JSON.stringify(p)})`);
}
ok(hint({ price_lock_reason: 'linked', price_lock_detail: 'Invoice' }).startsWith('🔒'),
  'every hint carries the lock symbol so it reads as a state, not an error');

// ── Quelltext-Waechter: sichtbar, gesperrt, und nichts freigeschaltet ────────────────────────────
ok(/'<div id="pePrices">'/.test(pageSrc), 'the price box is no longer hidden away');
ok(!/id="pePrices" class="hidden"/.test(pageSrc), 'and carries no hidden class any more');
ok(/id="pePriceLock"/.test(pageSrc), 'there is a place for the reason to be shown');
ok(!/pricesBox\.classList\.toggle\('hidden'/.test(pageSrc), 'eligibility no longer hides the whole box');
ok(/lockNote\.textContent = priceEditable \? '' : priceLockText;/.test(pageSrc),
  'the reason is shown exactly when the item is locked');
ok(/e\.disabled = !priceEditable;/.test(pageSrc), 'a locked price field is really disabled, not merely styled');

// Die Werte werden unabhaengig von der Sperre eingesetzt — gesperrt heisst "sichtbar, aber nicht
// aenderbar", nicht "leer".
const fillLine = pageSrc.split(/\r?\n/).find((l) => l.includes("for (const [id, col] of PRICE_FIELDS) { const e = $(id); if (e) e.value"));
ok(!!fillLine, 'the form fills the price fields from the item');
ok(!!fillLine && !fillLine.includes('priceEditable'), 'and does so whether or not they are editable');

// Der Schreibpfad bleibt unveraendert gesperrt: die Anzeige oeffnet nichts.
ok(/\/\/ Preise: nur wenn der Artikel sie ueberhaupt aendern darf[\s\S]{0,120}if \(priceEditable\) \{/.test(pageSrc),
  'the submit path still refuses to send prices for a locked item');
const submit = pageSrc.slice(pageSrc.indexOf('if (priceEditable) {'));
ok(/changed\[key\] = n;/.test(submit.slice(0, 900)), 'the price patch is built INSIDE that guard, not next to it');

console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — ${PASS} passed, ${FAIL} failed`);
if (FAIL) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
