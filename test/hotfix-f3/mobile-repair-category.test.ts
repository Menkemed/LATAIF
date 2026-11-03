// ════════════════════════════════════════════════════════════════════════════
// HOTFIX F3 — Mobile Repair: die Kategorie (Watch, Gold …) aus der AI, nur eindeutig, nur bestehende IDs.
// Run: node test/hotfix-f3/mobile-repair-category.test.ts
//
//   §A Zuordnung der AI-Antwort: nur ein exakter Kategoriename → dessen ID; sonst nichts (lieber leer als falsch)
//   §B Formular: nur in eine LEERE Auswahl; die Kategorie reist beim Anlegen und Ändern mit (geändert = mitgesendet)
//   §C Vertrag und Maske: `itemCategory` im AI-Vertrag, Hinweis mit den Namen, unbekannte gespeicherte Kategorie bleibt
// Der echte Browser-Lauf steht in test/preg5/mobile-repair-page.e2e.mjs §F3.
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const S = (v: unknown): string => JSON.stringify(v);

const sandbox: Record<string, unknown> = {};
new Function('self', src('src-tauri/src/sync/mobile_repair_commands.js'))(sandbox);
const M = sandbox.MobileRepair as {
  applyAiSuggestions(form: Record<string, unknown>, s: unknown, cats?: unknown): number;
  aiCategoryId(s: unknown, cats: unknown): string | null;
  categoryHint(cats: unknown): string;
  createBody(form: Record<string, unknown>, ids?: string[]): Record<string, unknown>;
  editBody(repair: Record<string, unknown>, form: Record<string, unknown>, plan?: unknown): Record<string, unknown>;
};
const CATS = (JSON.parse(src('src-tauri/src/sync/mobile_field_schema.json')) as { categories: Array<{ id: string; name: string }> }).categories;

// ── §A Zuordnung ────────────────────────────────────────────────────────────────────────────────
{
  ok(M.aiCategoryId({ fields: { itemCategory: 'Watch' } }, CATS) === 'cat-watch', '§A „Watch" → cat-watch');
  ok(M.aiCategoryId({ itemCategory: '  branded   GOLD jewelry ' }, CATS) === 'cat-branded-gold-jewelry', '§A Gross/Klein und Leerzeichen egal');
  ok(M.aiCategoryId({ itemCategory: 'Gold' }, CATS) === null && M.aiCategoryId({ itemCategory: 'Ring' }, CATS) === null,
    '§A kein exakter Name (Gold, Ring) → keine Kategorie');
  ok(M.aiCategoryId({ itemCategory: null }, CATS) === null && M.aiCategoryId({}, CATS) === null && M.aiCategoryId({ itemCategory: 'Watch' }, []) === null,
    '§A ohne Antwort oder ohne Liste → keine Kategorie');
  ok(M.aiCategoryId({ itemCategory: 'Watch' }, [{ id: 'a', name: 'Watch' }, { id: 'b', name: 'watch' }]) === null, '§A zwei gleichnamige → mehrdeutig, keine');
  ok(M.aiCategoryId({ itemCategory: 'cat-watch' }, CATS) === null, '§A eine ID statt eines Namens wird nicht geglaubt');
  ok(M.categoryHint(CATS) === 'Categories: ' + CATS.map((c) => c.name).join(' | ') && M.categoryHint([]) === '', '§A Hinweis: „Categories: A | B | …"');
}

// ── §B Formular und Rümpfe ──────────────────────────────────────────────────────────────────────
{
  const f: Record<string, unknown> = {};
  const n = M.applyAiSuggestions(f, { fields: { itemBrand: 'Rolex', itemModel: 'Datejust', itemCategory: 'Watch' } }, CATS);
  ok(n === 3 && f.itemCategoryId === 'cat-watch' && f.itemBrand === 'Rolex', `§B leere Auswahl + eindeutige Antwort → gesetzt (${S(f)})`);
  const g: Record<string, unknown> = { itemCategoryId: 'cat-accessory' };
  M.applyAiSuggestions(g, { itemCategory: 'Watch' }, CATS);
  ok(g.itemCategoryId === 'cat-accessory', '§B eine gewählte Kategorie bleibt (die AI füllt nur Leeres)');
  const h: Record<string, unknown> = {};
  ok(M.applyAiSuggestions(h, { itemCategory: 'Gold' }, CATS) === 0 && !('itemCategoryId' in h), '§B unklar → nichts gesetzt');
  ok(M.applyAiSuggestions({}, { itemBrand: 'Omega' }) === 1, '§B ohne Kategorieliste wie bisher (alter Aufruf)');
  const body = M.createBody({ customerId: 'c-1', issueDescription: 'Krone lose', itemCategoryId: 'cat-watch' });
  ok(body.itemCategoryId === 'cat-watch', `§B Anlegen: die Kategorie reist mit (${S(body)})`);
  ok(!('itemCategoryId' in M.createBody({ customerId: 'c-1', issueDescription: 'x', itemCategoryId: '' })), '§B leer → nicht gesendet');
  const rep = { id: 'r-1', revision: 3, itemCategoryId: 'cat-watch', issueDescription: 'x' };
  ok(M.editBody(rep, { itemCategoryId: 'cat-gold-jewelry', issueDescription: 'x' }).itemCategoryId === 'cat-gold-jewelry'
    && !('itemCategoryId' in M.editBody(rep, { itemCategoryId: 'cat-watch', issueDescription: 'x' })),
    '§B Ändern: nur eine geänderte Kategorie reist mit');
}

// ── §C Vertrag und Maske ────────────────────────────────────────────────────────────────────────
{
  const c = JSON.parse(src('src/core/ai/identify-contract.json')) as { repair: { fields: string[]; systemPromptTemplate: string } };
  ok(c.repair.fields.includes('itemCategory') && /EXACTLY one of the names listed after \\?"Categories:\\?"/.test(c.repair.systemPromptTemplate),
    '§C AI-Vertrag: itemCategory, nur ein Name aus der Liste, sonst null');
  const html = src('src-tauri/src/sync/mobile_repair.html'); const ui = src('src-tauri/src/sync/mobile_repair_ui.js');
  ok(/<select id="rpCategory"><\/select>/.test(html) && /itemCategoryId: 'rpCategory'/.test(ui), '§C Maske: Kategorie-Auswahl im Formular');
  ok(/if \(id && !liste\.some\(\(c\) => c\.id === id\)\) sel\.appendChild/.test(ui),
    '§C eine gespeicherte Kategorie außerhalb der Liste bleibt wählbar (Speichern leert sie nicht)');
  ok(/MobileRepair\.categoryHint\(rpKategorieListe\(\)\)/.test(ui) && /applyAiSuggestions\(form, data\.result \|\| \{\}, rpKategorieListe\(\)\)/.test(ui),
    '§C AI-Aufruf: Namen als Hinweis, Zuordnung gegen dieselbe Liste');
  ok(!/'cat-repair-service/.test(src('src-tauri/src/sync/mobile_field_schema.json')), '§C „Repair Service" ist keine Warenkategorie (nicht in der Auswahl)');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — hotfix F3 mobile repair category: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('HOTFIX_F3_MOBILE_REPAIR_CATEGORY_PROVED');
