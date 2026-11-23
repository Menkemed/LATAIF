// ═════════════════════════════════════════════════════════════════════
// KONFLIKT-RÜCKWEG der Artikelmaske — ungespeicherte Eingaben bleiben über den aktuellen Daten stehen.
// Beweist die reine Regel (`edit-pending.ts`) und ihre Verdrahtung in ProductDetail (Primary und PC2).
// Run: node test/product-models/edit-pending.test.ts
// ═════════════════════════════════════════════════════════════════════
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
const P = await import('../../src/core/products/edit-pending.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const S = (v: unknown): string => JSON.stringify(v);

// Ausgangsstand beim Öffnen der Maske
const basis = {
  form: { id: 'p1', brand: 'Cartier', name: 'Love Bracelet', plannedSalePrice: 4000, notes: '', scopeOfDelivery: ['Box'], updatedAt: 'T1', images: [], quantity: 1 },
  attrs: { size: '17', karat: '18K Yellow' },
};

// 1 nichts geändert
{
  const p = P.pendingEdits({ ...basis.form }, { ...basis.attrs }, basis);
  ok(S(p) === S({ fields: {}, attrs: {} }), 'E1 nichts geändert → nichts offen');
  const leer = P.pendingEdits({ ...basis.form, notes: undefined, brand: 'Cartier' }, { ...basis.attrs, extra: '' }, basis);
  ok(S(leer) === S({ fields: {}, attrs: {} }), 'E2 leer bleibt leer: "", null und undefined gelten als gleich');
  const nurTechnik = P.pendingEdits({ ...basis.form, images: ['data:x'], quantity: 5, updatedAt: 'T9', stockStatus: 'sold' }, { ...basis.attrs }, basis);
  ok(S(nurTechnik.fields) === '{}', 'E3 Bilder, Menge, Status und Stand sind keine Eingaben dieser Regel');
}

// 2 Eingabe + woanders ein ANDERES Feld geändert
{
  const form = { ...basis.form, plannedSalePrice: 4400 };
  const attrs = { ...basis.attrs, size: '18' };
  const frisch = { ...basis.form, notes: 'from PC2', updatedAt: 'T2' };
  const frischAttrs = { ...basis.attrs, diamond_weight: 0.5 };
  const p = P.pendingEdits(form, attrs, basis);
  ok(S(p) === S({ fields: { plannedSalePrice: 4400 }, attrs: { size: '18' } }), 'F1 offen: genau die Eingaben dieser Maske');
  const neu = P.rebaseOnFresh(frisch, frischAttrs, p);
  ok(neu.form.plannedSalePrice === 4400 && neu.form.notes === 'from PC2' && neu.form.updatedAt === 'T2',
    'F2 neu geladen: eigene Eingabe bleibt, die fremde Änderung (Notiz) und der neue Stand kommen frisch');
  ok(S(neu.attrs) === S({ size: '18', karat: '18K Yellow', diamond_weight: 0.5 }), 'F3 Merkmale: eigene Größe bleibt, ein woanders ergänztes Merkmal auch');
  const liste = P.pendingList(p, basis, frisch, frischAttrs);
  ok(liste.length === 2 && liste.every((e) => !e.changedElsewhere) && liste.find((e) => e.key === 'plannedSalePrice')?.now === 4000,
    'F4 Liste: zwei offene Eingaben, keine Überschneidung, mit aktuellem Wert');
}

// 3 Überschneidung: dasselbe Feld auch woanders geändert — ausdrücklich angezeigt
{
  const p = P.pendingEdits({ ...basis.form, plannedSalePrice: 4400 }, { ...basis.attrs }, basis);
  const frisch = { ...basis.form, plannedSalePrice: 4100, updatedAt: 'T3' };
  const liste = P.pendingList(p, basis, frisch, basis.attrs);
  ok(liste.length === 1 && liste[0].changedElsewhere && liste[0].mine === 4400 && liste[0].was === 4000 && liste[0].now === 4100,
    'U1 Überschneidung: Eingabe 4400, beim Öffnen 4000, jetzt 4100 — als „auch woanders geändert" markiert');
  ok(P.rebaseOnFresh(frisch, basis.attrs, p).form.plannedSalePrice === 4400, 'U2 die Maske zeigt die Eingabe (gespeichert erst auf den ausdrücklichen Klick)');
}

// 4 schon gespeichert / gelöscht / Listen
{
  const p = P.pendingEdits({ ...basis.form, plannedSalePrice: 4400 }, { ...basis.attrs }, basis);
  ok(P.pendingList(p, basis, { ...basis.form, plannedSalePrice: 4400, updatedAt: 'T4' }, basis.attrs).length === 0,
    'L1 steht schon so am Artikel (z. B. gerade gespeichert): nichts mehr offen');
  const weg = P.pendingEdits({ ...basis.form }, { karat: '18K Yellow' }, basis);
  ok(S(weg.attrs) === S({ size: undefined }) && !('size' in P.rebaseOnFresh(basis.form, basis.attrs, weg).attrs), 'L2 ein geleertes Merkmal wird nicht still wiederhergestellt');
  const umgestellt = P.pendingEdits({ ...basis.form, scopeOfDelivery: ['Papers', 'Box'] }, { ...basis.attrs }, basis);
  ok(S(Object.keys(umgestellt.fields)) === S(['scopeOfDelivery']), 'L3 Listenfelder werden verglichen (geänderter Lieferumfang ist offen)');
}

// 5 Verdrahtung in der Maske (Quelltext)
{
  const pd = readFileSync(resolvePath(repo, 'src/pages/watches/ProductDetail.tsx'), 'utf8').replace(/\r\n/g, '\n');
  ok(/STAND_KONFLIKT = new Set\(\[MEDIA_EDIT_GALLERY_BASELINE_CHANGED, 'PRODUCT_RECORD_CHANGED', 'PRODUCT_GALLERY_BASELINE_STALE'\]\)/.test(pd),
    'W1 Konflikte: Galerie am Primary, Standprüfung und veraltete Galerie am PC2');
  ok((pd.match(/konfliktRueckweg\(\);/g) ?? []).length === 3, 'W2 alle drei Konfliktstellen (Textweg PC2, Bildweg PC2, Galerie Primary) nehmen den Rückweg');
  ok((pd.match(/basis\.current = \{ form: \{ \.\.\.product \}/g) ?? []).length === 4, 'W3 Ausgangsstand: beim Öffnen (Knopf, ?edit=1) und nur nach Konflikt bzw. ausdrücklich gezeigter Überschneidung neu');
  ok((pd.match(/gesehenerStand\.current = product\.updatedAt;/g) ?? []).length === 3,
    'W4 die Standprüfung des PC2 rückt NUR beim Öffnen und nach einem gezeigten Konflikt vor — nie still beim Neuladen');
  ok(/rebaseOnFresh\(product as unknown as Record<string, unknown>, frischAttrs, eingaben\)/.test(pd) && /images: draftSeeded \? f\.images : product\.images/.test(pd),
    'W5 Neuladen während der Bearbeitung: aktuelle Daten + Eingaben; der Bildentwurf bleibt nach seiner eigenen Regel');
  ok(/if \(zweiterKlick\.current\) \{\s*zweiterKlick\.current = false;/.test(pd) && /!aendern\.remote && liste\.some\(\(e\) => e\.changedElsewhere\)/.test(pd),
    'W6 Primary: Überschneidung wird erst gezeigt, gespeichert erst auf den zweiten Klick');
  ok(/const frisch = !!warten && media !== warten\.alteDarstellung;/.test(pd) && /wartendeFotos\.current = \{ neu, alteDarstellung: media \}/.test(pd),
    'W7 neue Fotos warten auf die WIRKLICH neu geladene Galerie (nie auf der alten Darstellung angehängt)');
  ok(/data-edit-pending/.test(pd) && /also changed elsewhere, now/.test(pd), 'W8 sichtbarer Hinweis: offene Eingaben, aktueller Wert, Überschneidung');
}

console.log(`\nedit-pending: ${PASS} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
