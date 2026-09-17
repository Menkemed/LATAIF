// ════════════════════════════════════════════════════════════════════════════
// PRE-G5 MOBILE CONSIGNMENT — die Befehlsseite des Telefons, ohne DOM und ohne Primary.
// Run: node test/preg5/mobile-consignment.test.ts
//
// Eine Kommission legt am Rechner mit EINEM Klick zwei Dinge an: den Artikel des Einlieferers und
// die Kommission daran — in einer Transaktion, mit Duplikatsfrage, Auszahlungsmodell und
// Medienweg. Das Telefon darf davon NICHTS nachbauen; es stellt denselben Auftrag.
//
// Geprueft wird:
//   §1 was ein Rumpf traegt — und was er nie tragen darf (Einstand, Menge, Herkunft, Nummer),
//   §2 die drei Auszahlungsmodelle und ihre Parameter, jeweils nur die eigenen,
//   §3 Aendern: nur Geaendertes, immer die Fassung, das Modell nur solange der Primary es erlaubt,
//   §4 Galerie: behaltene Bilder nach ihrer Medienkennung, neue nach ihrer Ablagekennung,
//   §5 Verkauf, Auszahlung, Ruecknahme — und der Fehlbetrag nur auf ausdrueckliche Antwort,
//   §6 AI: nur beschreibende Felder, nur leere,
//   §7 Verdrahtung und Vokabeln: eine Schreibsicherheit, ein Feldschema, die Woerter des Hauses.
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath, join } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (p: string): string => readFileSync(join(repo, p), 'utf8').replace(/\r\n/g, '\n');

let PASS = 0;
const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const groups: Array<[string, number]> = [];
let mark = 0;
const group = (name: string): void => { groups.push([name, PASS - mark]); mark = PASS; };
const J = (v: unknown): string => {
  if (Array.isArray(v)) return '[' + v.map(J).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v as object).sort()
      .map((k) => JSON.stringify(k) + ':' + J((v as Record<string, unknown>)[k])).join(',') + '}';
  }
  return JSON.stringify(v) ?? 'null';
};

// Beide Dateien woertlich — so, wie die Handy-Seite sie einbettet. Die Kommissionsseite BENUTZT
// den Auftraggeber der Reparaturseite; genau das wird hier mitbewiesen.
const sandbox: Record<string, unknown> = {};
new Function('self', src('src-tauri/src/sync/mobile_repair_commands.js'))(sandbox);
new Function('self', src('src-tauri/src/sync/mobile_consignment_commands.js'))(sandbox);
type Ergebnis = { ok: boolean; code?: string; body?: Record<string, unknown> };
interface Api {
  MAX_PHOTOS: number;
  PAYOUT_MODELS: string[]; PAYOUT_METHODS: string[]; PRODUCT_TEXT_FIELDS: string[];
  EDIT_FIELDS: string[]; AI_FIELDS: string[];
  payoutPart(form: Record<string, unknown>): { ok: boolean; code?: string; payout?: Record<string, unknown> };
  createBody(form: Record<string, unknown>, ids?: string[], opts?: { acknowledgeDuplicate?: boolean }): Ergebnis;
  editBody(con: Record<string, unknown>, form: Record<string, unknown>): Ergebnis;
  editHasChanges(body: Record<string, unknown>): boolean;
  galleryPlan(slots: unknown[]): Array<Record<string, string>>;
  galleryUnchanged(plan: Array<Record<string, string>>, mediaIds: string[]): boolean;
  galleryBody(productId: string, plan: unknown[]): Ergebnis;
  saleBody(con: Record<string, unknown>, form: Record<string, unknown>, opts?: { acknowledgeShortfall?: boolean }): Ergebnis;
  payoutBody(con: Record<string, unknown>, form: Record<string, unknown>): Ergebnis;
  returnBody(con: Record<string, unknown>): Ergebnis;
  applyAiSuggestions(form: Record<string, unknown>, s: unknown): number;
}
const M = sandbox.MobileConsignment as unknown as Api;

const KOMMISSION = {
  id: 'con-1', consignmentNumber: 'CON-2026-0007', consignorId: 'cust-1', productId: 'prod-1',
  agreedPrice: 500, minimumPrice: 450, expiryDate: '2026-12-31', notes: 'Karton dabei',
  payoutModel: 'percent', commissionRate: 20, excessSplitPct: null, payoutLocked: false,
  status: 'active', revision: 3,
};

// ══════════════════════════════════════════════════════════════════════════════
// §1 — Anlegen: was mitreist, und was der Primary allein bestimmt
// ══════════════════════════════════════════════════════════════════════════════
{
  const form = {
    consignorId: 'cust-1', categoryId: 'cat-watch', brand: 'Rolex', name: 'Datejust 36',
    condition: 'Excellent', sku: ' RLX-9 ', attributes: { year: 2019 }, scopeOfDelivery: ['Box', 'Papers'],
    agreedPrice: '500', minimumPrice: '450', expiryDate: '2026-12-31', notes: 'Karton dabei',
    payoutModel: 'percent', commissionRate: '20',
  };
  const r = M.createBody(form, ['a'.repeat(64)]) as Required<Ergebnis>;
  ok(r.ok, '§1 ein vollstaendiger Eingang wird angenommen');
  const b = r.body as Record<string, unknown>;
  const product = b.product as Record<string, unknown>;
  ok(b.consignorId === 'cust-1' && b.agreedPrice === 500 && b.minimumPrice === 450,
    `§1 Einlieferer und Betraege reisen als Zahlen (${J({ c: b.consignorId, a: b.agreedPrice, m: b.minimumPrice })})`);
  ok(product.categoryId === 'cat-watch' && product.brand === 'Rolex' && product.sku === 'RLX-9',
    `§1 der Artikel traegt Kategorie, Marke und die getippte SKU getrimmt (${J(product)})`);
  ok(J(product.attributes) === J({ year: 2019 }) && J(product.scopeOfDelivery) === J(['Box', 'Papers']),
    '§1 …die Merkmale der Kategorie und der Lieferumfang gehen mit');
  ok(J(b.stagingIds) === J(['a'.repeat(64)]), '§1 Bilder reisen als Ablagekennungen, nie als Bytes');
  ok(!('acknowledgeDuplicate' in b), '§1 die Duplikatsantwort reist NICHT vorsorglich mit');

  // Was der Primary selbst setzt, darf nirgends im Rumpf stehen.
  const verboten = ['purchasePrice', 'stockStatus', 'sourceType', 'quantity', 'consignmentNumber',
    'commissionAmount', 'payoutAmount', 'status', 'revision', 'branchId', 'tenantId', 'productId', 'images'];
  const text = J(b);
  const treffer = verboten.filter((f) => new RegExp(`"${f}"\\s*:`).test(text));
  ok(treffer.length === 0, `§1 kein Feld des Primary im Rumpf (${treffer.join(', ') || 'keins'})`);

  ok((M.createBody({ ...form, consignorId: '' }) as Ergebnis).code === 'CONSIGNOR_REQUIRED', '§1 ohne Einlieferer geht nichts hinaus');
  ok((M.createBody({ ...form, categoryId: '' }) as Ergebnis).code === 'CATEGORY_REQUIRED', '§1 ohne Kategorie auch nicht');
  ok((M.createBody({ ...form, agreedPrice: '0' }) as Ergebnis).code === 'AGREED_PRICE_REQUIRED', '§1 …und nicht ohne vereinbarten Preis');
  const viele = Array.from({ length: 12 }, (_, i) => String(i).padStart(64, '0'));
  const begrenzt = M.createBody(form, viele) as Required<Ergebnis>;
  ok((begrenzt.body.stagingIds as string[]).length === M.MAX_PHOTOS && M.MAX_PHOTOS === 8,
    `§1 hoechstens acht Bilder — dieselbe Zahl wie MAX_REMOTE_IMAGES (${(begrenzt.body.stagingIds as string[]).length})`);
  const bestaetigt = M.createBody(form, [], { acknowledgeDuplicate: true }) as Required<Ergebnis>;
  ok(bestaetigt.body.acknowledgeDuplicate === true, '§1 „Trotzdem anlegen" sagt es ausdruecklich');
}
group('§1 Anlegen');

// ══════════════════════════════════════════════════════════════════════════════
// §2 — Die drei Auszahlungsmodelle, jedes mit NUR seinen Parametern
// ══════════════════════════════════════════════════════════════════════════════
{
  const prozent = M.payoutPart({ payoutModel: 'percent', commissionRate: '20', excessSplitPct: '40' });
  ok(prozent.ok && J(prozent.payout) === J({ model: 'percent', commissionRate: 20 }),
    `§2 percent traegt den Satz — und NICHT den Anteil eines fremden Modells (${J(prozent.payout)})`);
  const fest = M.payoutPart({ payoutModel: 'consignor_fixed', commissionRate: '20', excessSplitPct: '40' });
  ok(fest.ok && J(fest.payout) === J({ model: 'consignor_fixed' }),
    `§2 consignor_fixed traegt gar keinen Parameter (${J(fest.payout)})`);
  const split = M.payoutPart({ payoutModel: 'cost_split', commissionRate: '20', excessSplitPct: '40' });
  ok(split.ok && J(split.payout) === J({ model: 'cost_split', excessSplitPct: 40 }),
    `§2 cost_split traegt den Shop-Anteil (${J(split.payout)})`);

  ok(M.payoutPart({ payoutModel: 'fixed' }).code === 'PAYOUT_MODEL_REQUIRED',
    '§2 das Altmodell `fixed` bietet das Telefon nicht an');
  ok(M.payoutPart({ payoutModel: 'percent', commissionRate: '' }).code === 'COMMISSION_RATE_REQUIRED',
    '§2 percent ohne Satz geht nicht hinaus');
  ok(M.payoutPart({ payoutModel: 'percent', commissionRate: '120' }).code === 'COMMISSION_RATE_REQUIRED',
    '§2 …und ein Satz ueber 100 auch nicht');
  for (const schlecht of ['0', '100', '']) {
    ok(M.payoutPart({ payoutModel: 'cost_split', excessSplitPct: schlecht }).code === 'SPLIT_REQUIRED',
      `§2 cost_split verlangt 1–99 Prozent (${schlecht || 'leer'})`);
  }
}
group('§2 Auszahlungsmodelle');

// ══════════════════════════════════════════════════════════════════════════════
// §3 — Aendern: nur Geaendertes, immer die Fassung
// ══════════════════════════════════════════════════════════════════════════════
{
  const unveraendert = M.editBody(KOMMISSION, {
    agreedPrice: '500', minimumPrice: '450', expiryDate: '2026-12-31', notes: 'Karton dabei',
  }) as Required<Ergebnis>;
  ok(!M.editHasChanges(unveraendert.body), `§3 nichts geaendert = kein Auftrag (${J(unveraendert.body)})`);

  const geaendert = M.editBody(KOMMISSION, {
    agreedPrice: '560', minimumPrice: '450', expiryDate: '2026-12-31', notes: 'Karton dabei',
  }) as Required<Ergebnis>;
  ok(J(Object.keys(geaendert.body).sort()) === J(['agreedPrice', 'expectedRevision', 'id']),
    `§3 nur das geaenderte Feld und die Fassung (${J(geaendert.body)})`);
  ok(geaendert.body.expectedRevision === 3, '§3 …und zwar die GELESENE Fassung');

  // Ein Feld, das die Maske nicht zeigt, wird nicht verglichen — sonst leerte es einen Wert.
  const ohneFeld = M.editBody(KOMMISSION, { agreedPrice: '560' }) as Required<Ergebnis>;
  ok(!('notes' in ohneFeld.body) && !('expiryDate' in ohneFeld.body),
    `§3 keine Phantomfelder aus dem gelesenen Stand (${J(ohneFeld.body)})`);

  const mitModell = M.editBody(KOMMISSION, { payoutModel: 'cost_split', excessSplitPct: '40' }) as Required<Ergebnis>;
  ok(J(mitModell.body.payout) === J({ model: 'cost_split', excessSplitPct: 40 }),
    `§3 ein geaendertes Auszahlungsmodell reist mit (${J(mitModell.body.payout)})`);
  const gleichesModell = M.editBody(KOMMISSION, { payoutModel: 'percent', commissionRate: '20' }) as Required<Ergebnis>;
  ok(!('payout' in gleichesModell.body), '§3 …ein unveraendertes nicht');

  const gesperrt = M.editBody({ ...KOMMISSION, payoutLocked: true }, {
    payoutModel: 'cost_split', excessSplitPct: '40', agreedPrice: '560',
  }) as Required<Ergebnis>;
  ok(!('payout' in gesperrt.body) && gesperrt.body.agreedPrice === 560,
    `§3 ist das Modell gesperrt, reist es nicht — der Rest schon (${J(gesperrt.body)})`);
}
group('§3 Aendern');

// ══════════════════════════════════════════════════════════════════════════════
// §4 — Die Galerie: Identitaet, nicht Stelle
// ══════════════════════════════════════════════════════════════════════════════
{
  const plan = M.galleryPlan([
    { mediaId: 'm-1', src: '/api/media?key=k1' },
    { stagingId: 'b'.repeat(64) },
    { mediaId: 'm-2' },
  ]);
  ok(J(plan) === J([{ keep: 'm-1' }, { stagingId: 'b'.repeat(64) }, { keep: 'm-2' }]),
    `§4 behaltene Bilder nennen ihre MEDIENKENNUNG, neue ihre Ablagekennung (${J(plan)})`);
  ok(M.galleryUnchanged([{ keep: 'm-1' }, { keep: 'm-2' }], ['m-1', 'm-2']), '§4 dieselbe Folge = unveraendert');
  ok(!M.galleryUnchanged([{ keep: 'm-2' }, { keep: 'm-1' }], ['m-1', 'm-2']), '§4 eine andere Reihenfolge ist eine Aenderung');
  ok(!M.galleryUnchanged([{ keep: 'm-1' }], ['m-1', 'm-2']), '§4 ein entferntes Bild auch');
  const body = M.galleryBody('prod-1', plan) as Required<Ergebnis>;
  ok(J(Object.keys(body.body).sort()) === J(['gallery', 'id']),
    `§4 der Auftrag nennt genau Artikel und Galerie — kein Textfeld daneben (${J(Object.keys(body.body))})`);
  ok((M.galleryBody('', plan) as Ergebnis).code === 'PRODUCT_REQUIRED', '§4 ohne Artikel kein Galerieauftrag');
}
group('§4 Galerie');

// ══════════════════════════════════════════════════════════════════════════════
// §5 — Verkauf, Auszahlung, Ruecknahme
// ══════════════════════════════════════════════════════════════════════════════
{
  const verkauf = M.saleBody(KOMMISSION, { buyerId: 'cust-9', salePrice: '650', specialMark: false }) as Required<Ergebnis>;
  ok(verkauf.ok && verkauf.body.salePrice === 650 && verkauf.body.specialMark === false
    && verkauf.body.expectedRevision === 3 && !('acknowledgeShortfall' in verkauf.body),
    `§5 ein Verkauf nennt Kaeufer, Preis, Belegkreis und Fassung (${J(verkauf.body)})`);
  ok((M.saleBody(KOMMISSION, { buyerId: 'cust-1', salePrice: '650' }) as Ergebnis).code === 'BUYER_IS_CONSIGNOR',
    '§5 der Kaeufer darf nicht der Einlieferer sein — das waere eine Ruecknahme');
  ok((M.saleBody(KOMMISSION, { buyerId: 'cust-9', salePrice: '0' }) as Ergebnis).code === 'SALE_PRICE_REQUIRED',
    '§5 ohne Preis kein Verkauf');
  const bestaetigt = M.saleBody(KOMMISSION, { buyerId: 'cust-9', salePrice: '300' }, { acknowledgeShortfall: true }) as Required<Ergebnis>;
  ok(bestaetigt.body.acknowledgeShortfall === true,
    '§5 der Fehlbetrag wird erst NACH dem Nein des Primary ausdruecklich bestaetigt');
  // Kein Nachrechnen am Telefon: keine Abrechnung, kein Boden, keine Multiplikation mit einem Satz.
  const befehleOhneKommentar = src('src-tauri/src/sync/mobile_consignment_commands.js')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(!/floor/i.test(befehleOhneKommentar)
    && !/computeConsignmentSale|commissionAmount|payoutAmount/.test(befehleOhneKommentar)
    && !/\*\s*(rate|commissionRate|salePrice|agreedPrice|excessSplitPct)/i.test(befehleOhneKommentar),
    '§5 …das Telefon rechnet den Boden NICHT nach (keine zweite Abrechnung)');

  const auszahlung = M.payoutBody(KOMMISSION, { amount: '120.5', method: 'cash', reference: 'Beleg 7' }) as Required<Ergebnis>;
  ok(auszahlung.ok && auszahlung.body.amount === 120.5 && auszahlung.body.method === 'cash'
    && auszahlung.body.reference === 'Beleg 7' && auszahlung.body.expectedRevision === 3,
    `§5 eine Auszahlung nennt Betrag, Weg, Hinweis und Fassung (${J(auszahlung.body)})`);
  ok((M.payoutBody(KOMMISSION, { amount: '0', method: 'cash' }) as Ergebnis).code === 'AMOUNT_REQUIRED', '§5 kein Betrag, keine Auszahlung');
  ok((M.payoutBody(KOMMISSION, { amount: '10', method: 'erfunden' }) as Ergebnis).code === 'METHOD_REQUIRED', '§5 ein erfundener Zahlweg wird hier schon abgewiesen');

  const zurueck = M.returnBody(KOMMISSION) as Required<Ergebnis>;
  ok(J(Object.keys(zurueck.body).sort()) === J(['consignmentId', 'expectedRevision']),
    `§5 die Ruecknahme nennt genau Kommission und Fassung (${J(zurueck.body)})`);
}
group('§5 Handlungen');

// ══════════════════════════════════════════════════════════════════════════════
// §6 — AI schlaegt vor, sie entscheidet nicht
// ══════════════════════════════════════════════════════════════════════════════
{
  const form: Record<string, unknown> = { brand: 'Rolex', name: '', condition: '', agreedPrice: '500', payoutModel: 'percent' };
  const gefuellt = M.applyAiSuggestions(form, {
    brand: 'Omega', name: 'Datejust 36', condition: 'Excellent',
    agreedPrice: 9999, payoutModel: 'cost_split', consignorId: 'fremd', sku: 'AI-1', commissionRate: 90,
  });
  ok(gefuellt === 2 && form.brand === 'Rolex' && form.name === 'Datejust 36' && form.condition === 'Excellent',
    `§6 nur LEERE Felder werden gefuellt, getippte bleiben (${gefuellt}, ${J(form)})`);
  ok(form.agreedPrice === '500' && form.payoutModel === 'percent' && !('consignorId' in form) && !('sku' in form)
    && !('commissionRate' in form),
    `§6 Preis, Auszahlungsmodell, Einlieferer und Nummer kann die AI NICHT bestimmen (${J(form)})`);
  ok(J(M.AI_FIELDS) === J(['brand', 'name', 'condition']),
    `§6 …weil sie genau drei beschreibende Felder anfassen darf (${J(M.AI_FIELDS)})`);
}
group('§6 AI-Leitplanken');

// ══════════════════════════════════════════════════════════════════════════════
// §7 — Verdrahtung und Vokabeln
// ══════════════════════════════════════════════════════════════════════════════
{
  const befehle = src('src-tauri/src/sync/mobile_consignment_commands.js');
  const ui = src('src-tauri/src/sync/mobile_consignment_ui.js');
  const seite = src('src-tauri/src/sync/mobile_page.rs');

  // EINE Schreibsicherheit: die Kommissionsmaske baut keinen zweiten Auftraggeber.
  ok(/MobileRepair\.createClient\(/.test(ui) && !/function createClient/.test(befehle),
    '§7 die Kommission benutzt den vorhandenen durablen Auftraggeber — keine zweite Schreibsicherheit');
  ok(!ui.includes('/api/sync/push') && !befehle.includes('/api/sync/push'),
    '§7 nichts geht ueber den Abgleichkanal — Kommissionen reisen als Befehl');
  ok(!/fetch\(\s*'\/api\/command'/.test(ui), '§7 …und die Oberflaeche spricht nie selbst mit `/api/command`');
  for (const op of ['consignments.list', 'consignments.get', 'consignments.create', 'consignments.update',
    'consignments.record_sale', 'consignments.record_payout', 'consignments.mark_returned',
    'products.get', 'products.update', 'customers.list', 'customers.create']) {
    ok(ui.includes(`'${op}'`), `§7 die Maske benutzt den vorhandenen Weg ${op}`);
  }
  for (const verboten of ['consignments.return_after_sale', 'consignments.cancel_sale', 'products.create']) {
    ok(!ui.includes(verboten), `§7 …und NICHT ${verboten} (bewusst nicht mobil)`);
  }

  // Das Feldschema ist dasselbe wie im Anlegeformular — keine zweite Feldliste.
  ok(/SCHEMA\.categories/.test(ui) && /catById\(/.test(ui) && /makeControl\(a, CN_ATTR_PREFIX\)/.test(ui)
    && /readAttr\(a, CN_ATTR_PREFIX\)/.test(ui) && /dependsSatisfied\(a, CN_ATTR_PREFIX\)/.test(ui),
    '§7 Kategorie und Merkmale kommen aus dem vorhandenen Feldschema (SSOT), nicht aus einer Kopie');
  ok(/aiApplyToForm\(data\.result \|\| \{\}, \{/.test(ui),
    '§7 die AI-Uebernahme ist die vorhandene — nur mit den Feldern DIESER Maske');
  ok(/const ROW_PREFIX = \{ 'attr_': 'row_', 'pea_': 'perow_', 'cna_': 'cnrow_' \};/.test(seite),
    '§7 der dritte Feldsatz hat seinen eigenen Zeilen-Prefix (sonst versteckte er fremde Zeilen)');
  ok(/include_str!\("mobile_consignment\.html"\)/.test(seite)
    && /include_str!\("mobile_consignment_commands\.js"\)/.test(seite)
    && /include_str!\("mobile_consignment_ui\.js"\)/.test(seite),
    '§7 alle drei Dateien sind in die Seite eingebettet');
  ok(seite.indexOf('mobile_consignment_commands.js') > seite.indexOf('mobile_repair_commands.js'),
    '§7 …und zwar NACH dem Auftraggeber, den sie benutzt');
  ok(/'consignHome', 'formConsign'/.test(seite) && /mode === 'consign'/.test(seite),
    '§7 der Vorfilter kennt die Betriebsart und ihre Schirme');

  // Die Vokabeln gehoeren dem Haus (Lehre aus R4C.4).
  const listeAus = (text: string, name: string): string[] => {
    const m = new RegExp(`export const ${name}[^=]*=\\s*\\[([\\s\\S]*?)\\]`).exec(text);
    return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
  };
  const hausModelle = listeAus(src('src/core/consignment/payout-edit.ts'), 'PAYOUT_MODELS');
  ok(hausModelle.length === 3 && J(M.PAYOUT_MODELS) === J(hausModelle),
    `§7 Auszahlungsmodelle == PAYOUT_MODELS des Hauses (${J(hausModelle)})`);
  const hausWege = listeAus(src('src/core/consignment/consignment-finance.ts'), 'CONSIGNMENT_PAYOUT_METHODS');
  ok(hausWege.length === 4 && J(M.PAYOUT_METHODS) === J(hausWege),
    `§7 Auszahlungswege == CONSIGNMENT_PAYOUT_METHODS (${J(hausWege)})`);

  // Die Registry bleibt, wie sie ist: kein neuer Name.
  const rust = src('src-tauri/src/bridge.rs');
  const liste = rust.slice(rust.indexOf('pub const REMOTE_OPS'), rust.indexOf('];', rust.indexOf('pub const REMOTE_OPS')));
  // PRE-G5 — genau EINE neue Auskunft: die Duplikatsfrage samt 'Copy details' aus der Autoritaet.
  ok((liste.match(/OP_[A-Z_]+/g) ?? []).length === 176, '§7 die Registry zaehlt 176 Namen (175 + products.duplicates.get)');
  ok(/OP_PRODUCTS_DUPLICATES_GET: &str = "products.duplicates.get"/.test(rust), '§7 …und Rust kennt sie namentlich');
  ok(ui.includes("'products.duplicates.get'"), '§7 die Maske fragt sie, statt Duplikate selbst zu suchen');
  const registry = src('src/core/bridge/command-registry.ts');
  for (const op of ['consignments.create', 'consignments.update', 'consignments.record_sale',
    'consignments.record_payout', 'consignments.mark_returned', 'products.update', 'customers.create']) {
    ok(registry.includes(`'${op}'`), `§7 ${op} stand schon in der Erlaubnisliste`);
  }
}
group('§7 Verdrahtung und Vokabeln');

// ══════════════════════════════════════════════════════════════════════════════
for (const [name, n] of groups) console.log(`  ${name}: ${n}`);
if (fails.length > 0) {
  console.log(`\nFAIL — preg5 mobile consignment: ${PASS} passed, ${fails.length} failed`);
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
console.log(`\nPASS — preg5 mobile consignment: ${PASS} passed, 0 failed`);
console.log('PRE_G5_MOBILE_CONSIGNMENT_UNIT_PROVED');
