// MOBILE-CONTACT — Vorwahl und Ausweisnummer eines neuen Kunden: EINE Regel fuer jede Maske des Telefons
// (Einkauf, Reparatur, Kommission), dieselbe wie am Rechner.
//
// Geprueft wird an der Quelle: die Liste und die Regeln von `mobile_contact.js` gegen `country-codes.ts` /
// `contact-validate.ts` des Rechners; dass keine Maske eine eigene Kopie der Regeln fuehrt; dass Reparatur und
// Kommission die Felder zeigen und in `customers.create` legen; und dass ein alter, offener Auftrag beim Klaeren
// unveraendert hinausgeht (keine doppelte Vorwahl).

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cc from '../../src/core/contacts/country-codes.ts';
import * as cv from '../../src/core/contacts/contact-validate.ts';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (p: string) => readFileSync(join(repo, p), 'utf8');
const S = (v: unknown) => JSON.stringify(v);
let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string) => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };

// Woertlich geladen — so, wie die Handy-Seite die Dateien einbettet.
const sandbox: Record<string, unknown> = {};
for (const f of ['mobile_repair_commands.js', 'mobile_business_date.js', 'mobile_contact.js', 'mobile_purchase_commands.js']) {
  new Function('self', src('src-tauri/src/sync/' + f))(sandbox);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MC = sandbox.MobileContact as any, MP = sandbox.MobilePurchase as any, MR = sandbox.MobileRepair as any;

// ── 1 Dieselbe Liste und dieselben Regeln wie am Rechner ─────────────────────────────────────────
{
  const rechner = cc.COUNTRIES.map((c) => ({ iso: c.iso, dial: c.dial, label: c.label, flag: c.flag, example: c.example, maxLength: c.maxLength }));
  ok(S(MC.COUNTRIES) === S(rechner), 'PARITÄT die Vorwahlen des Telefons sind die des Rechners (country-codes.ts)');
  ok(MC.DEFAULT_ISO === cc.DEFAULT_COUNTRY.iso && MC.DEFAULT_ISO === 'BH', 'PARITÄT Bahrain ist vorgewählt, wie am Rechner');
  ok(MC.optionLabel(MC.countryOf('BH')) === '🇧🇭 +973', 'PARITÄT die Auswahl zeigt Flagge und Vorwahl');
  for (const s of ['', '+97336123456', '0097336123456', '36123456', '3612 3456', '+966512345678', '+12125551234', '+447700900123', '+4930123456', '+971501234567', 'abc']) {
    const t = cc.splitPhone(s), m = MC.splitPhone(s);
    ok(t.country.iso === m.iso && t.national === m.national && cc.joinPhone(t.country, t.national) === MC.joinPhone(m.iso, m.national),
      `PARITÄT „${s}" zerlegt und zusammengesetzt wie am Rechner (${m.iso} ${m.national})`);
    ok(cv.validatePhone(cc.joinPhone(t.country, t.national)).ok === (MC.phoneHint(m.iso, m.national) === ''),
      `PARITÄT Hinweis zu „${s}" wie am Rechner (${MC.phoneHint(m.iso, m.national) || 'keiner'})`);
  }
  for (const id of ['', '900123456', '90012345', '9001234', '9001234567', '900-123-456', 'P1234567', 'AB1', 'CR 12345']) {
    ok(cv.validateCpr(id).ok === (MC.personalIdHint(id) === ''), `PARITÄT Ausweisnummer „${id}" wie am Rechner (${MC.personalIdHint(id) || 'kein Hinweis'})`);
  }
}

// ── 2 Was in den Auftrag geht ────────────────────────────────────────────────────────────────────
{
  ok(S(MC.contactFields('BH', '', '')) === '{}', 'AUFTRAG leere Felder → nichts, nie ein „+973" allein');
  ok(S(MC.contactFields('BH', '   ', '   ')) === '{}', 'AUFTRAG nur Leerzeichen → nichts');
  ok(S(MC.contactFields('SA', '5 1234 5678', ' 900123456 ')) === S({ phone: '+966512345678', personalId: '900123456' }),
    'AUFTRAG Land + Nummer → E.164, die Ausweisnummer getrimmt');
  ok(S(MC.contactFields('BH', '3612-3456', '')) === S({ phone: '+97336123456' }), 'AUFTRAG nur die Nummer → nur phone');
  ok(S(MC.contactFields('KW', '', 'P1234567')) === S({ personalId: 'P1234567' }), 'AUFTRAG nur der Pass → nur personalId');
  // Eine Nummer mit Hinweis wird trotzdem gespeichert — der Hinweis ist weich wie am Rechner.
  ok(MC.phoneHint('BH', '12') !== '' && MC.contactFields('BH', '12', '').phone === '+97312', 'AUFTRAG ein Hinweis sperrt nie');
}

// ── 3 EINE Regel: keine Maske fuehrt eine eigene Kopie ───────────────────────────────────────────
{
  ok(MP.splitPhone === MC.splitPhone && MP.joinPhone === MC.joinPhone && MP.phoneHint === MC.phoneHint
    && MP.personalIdHint === MC.personalIdHint && MP.COUNTRIES === MC.COUNTRIES, 'EINE REGEL der Einkauf benutzt dieselben Funktionen');
  const dir = join(repo, 'src-tauri/src/sync');
  const kopien = readdirSync(dir).filter((f) => /\.(js|html)$/.test(f) && f !== 'mobile_contact.js')
    .filter((f) => /MOBILE_PREFIXES|function (splitPhone|joinPhone|phoneHint|personalIdHint)\b|dial: '\+973'/.test(readFileSync(join(dir, f), 'utf8')));
  ok(kopien.length === 0, `EINE REGEL keine zweite Vorwahl-Liste oder Prüfregel im Telefon (${kopien.join(', ') || 'keine'})`);
  const seite = src('src-tauri/src/sync/mobile_page.rs');
  const i = (f: string) => seite.indexOf('include_str!("' + f + '")');
  ok(i('mobile_contact.js') > 0 && i('mobile_contact.js') < i('mobile_purchase_commands.js') && i('mobile_contact.js') < i('mobile_repair_ui.js')
    && i('mobile_contact.js') < i('mobile_consignment_ui.js'), 'SEITE die Kontaktregel ist eingebettet, vor allen Masken');
  ok(/\.phone-row \{ display: flex;/.test(seite) && /\.phone-row input \{ flex: 1; min-width: 0; \}/.test(seite), 'SEITE Vorwahl und Nummer stehen in einer Zeile, die Nummer schrumpft');
}

// ── 4 Reparatur und Kommission: dieselben Felder, derselbe Auftrag ───────────────────────────────
for (const [name, html, ui, pre] of [
  ['Reparatur', src('src-tauri/src/sync/mobile_repair.html'), src('src-tauri/src/sync/mobile_repair_ui.js'), 'rpCustomer'],
  ['Kommission', src('src-tauri/src/sync/mobile_consignment.html'), src('src-tauri/src/sync/mobile_consignment_ui.js'), 'cnConsignor'],
] as const) {
  ok(new RegExp(`<select id="${pre}PhoneIso" aria-label="Country code"></select>`).test(html)
    && new RegExp(`<input id="${pre}Phone" type="text" inputmode="tel" placeholder="3612 3456" />`).test(html),
    `${name} MASKE Vorwahl-Auswahl neben der Nummer, Platzhalter wie am Rechner`);
  ok(new RegExp(`Personal ID \\(CPR / passport, optional\\)</label>\\s*<input id="${pre}PersonalId" type="text" placeholder="e\\.g\\. 900123456" />`).test(html),
    `${name} MASKE „Personal ID (CPR / passport)" mit dem Platzhalter des Rechners`);
  ok(html.includes(`id="${pre}PhoneHint" class="contact-hint"`) && html.includes(`id="${pre}PersonalIdHint" class="contact-hint"`), `${name} MASKE Platz fuer die weichen Hinweise`);
  ok(new RegExp(`MobileContact\\.COUNTRIES\\.forEach\\(\\(c\\) => \\$\\('${pre}PhoneIso'\\)\\.appendChild`).test(ui), `${name} UI die Auswahl kommt aus der gemeinsamen Liste`);
  ok(new RegExp(`Object\\.assign\\(body, MobileContact\\.contactFields\\(\\$\\('${pre}PhoneIso'\\)\\.value, \\$\\('${pre}Phone'\\)\\.value, \\$\\('${pre}PersonalId'\\)\\.value\\)\\)`).test(ui)
    && /'customers\.create', body\)/.test(ui), `${name} UI der Auftrag customers.create traegt die Felder aus der gemeinsamen Regel`);
  ok(!new RegExp(`textOrNull\\(\\$\\('${pre}Phone'\\)`).test(ui), `${name} UI keine alte Freitext-Nummer mehr`);
  ok(/Reset\(\);/.test(ui) && /MobileContact\.phoneHint\(iso, /.test(ui) && /MobileContact\.personalIdHint\(/.test(ui), `${name} UI Hinweise beim Tippen, Ruecksetzen nach dem Anlegen`);
}

// ── 5 Alter offener Auftrag: beim Klaeren unveraendert, keine doppelte Vorwahl ──────────────────
{
  const m = new Map<string, Record<string, unknown>>();
  const store = {
    async get(k: string) { return m.get(k) ?? null; },
    async put(e: Record<string, unknown>) { m.set(String(e.key), JSON.parse(JSON.stringify(e))); },
    async delete(k: string) { m.delete(k); },
    async getAll() { return [...m.values()]; },
  };
  const gesendet: Array<{ commandId: string; payload: unknown }> = [];
  let verlieren = true;
  const fetchFn = async (_url: string, init: { body: string }) => {
    const b = JSON.parse(init.body);
    gesendet.push({ commandId: b.commandId, payload: b.payload });
    if (verlieren) { verlieren = false; throw new Error('connection reset'); }
    return { status: 200, json: async () => ({ ok: true, value: { customerId: 'cust-alt', name: 'Alt Kunde' } }) };
  };
  let n = 0;
  const client = () => MR.createClient({ fetchFn, store, genId: () => 'cmd-' + (++n), token: () => 'jwt', now: () => '2026-10-21T00:00:00.000Z' });
  // So sah ein Auftrag VOR diesem Stand aus: die Nummer als freier Text.
  const alt = { firstName: 'Alt', lastName: 'Kunde', phone: '+973 3612 3456' };
  const erst = await client().mutate('customer:draft-alt', 'customers.create', alt);
  const liegt = m.get('customer:draft-alt') as { key: string; op: string; payload: unknown };
  const zweit = await client().mutate(liegt.key, liegt.op, liegt.payload, { clarify: true });
  ok(erst.kind === 'unresolved' && zweit.kind === 'ok' && gesendet.length === 2 && gesendet[1].commandId === gesendet[0].commandId
    && S(gesendet[1].payload) === S(alt), `ALTER AUFTRAG geht beim Klaeren Zeichen fuer Zeichen gleich hinaus (${S(gesendet[1] && gesendet[1].payload)})`);
  // Der Einkauf zerlegt einen alten Entwurf einmal — nie „+973" vor eine schon internationale Nummer.
  const p = MP.normalizePerson({ firstName: 'A', phone: '+966512345678' });
  ok(p.phoneIso === 'SA' && p.phone === '512345678' && MC.joinPhone(p.phoneIso, p.phone) === '+966512345678', 'ALTER ENTWURF Einkauf: keine doppelte Vorwahl');
}

console.log(`\nmobile-contact: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('MOBILE_CONTACT_PROVED');
