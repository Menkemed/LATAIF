// REPAIR-HOVER — reine Teile der großen Hover-Karte der Reparaturliste.
// Run: node test/repair-hover/repair-hover.test.ts
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const h = await import('../../src/core/repairs/repair-hover.ts');

let PASS = 0, FAIL = 0;
const ok = (c: unknown, m: string) => { if (c) PASS++; else { FAIL++; console.log('  ✗ ' + m); } };
const S = JSON.stringify;

// Felder: gespeicherte Werte, sonst null — nichts erfunden
ok(S(h.repairHoverFields({ itemBrand: 'Rolex', itemModel: 'Datejust 41', itemReference: '126334', itemSerial: 'E67041D8' }))
  === S({ brand: 'Rolex', model: 'Datejust 41', reference: '126334', serial: 'E67041D8' }), 'alle vier Felder aus der Reparatur');
ok(S(h.repairHoverFields({ itemBrand: '  ', itemModel: undefined, itemReference: null }))
  === S({ brand: null, model: null, reference: null, serial: null }), 'leere/fehlende Felder bleiben leer (nichts erfunden)');
ok(S(h.repairHoverFields({ itemBrand: 'Omega', itemAttributes: { reference_number: '327.10.43', serial_number: 82974107 } }))
  === S({ brand: 'Omega', model: null, reference: '327.10.43', serial: '82974107' }), 'Referenz/Seriennummer aus den gespeicherten Kategorie-Angaben, wenn das Feld fehlt');
ok(h.repairHoverFields({ itemReference: 'R1', itemAttributes: { reference_number: 'R2' } }).reference === 'R1', 'das Feld der Reparatur hat Vorrang');
ok(h.repairHoverFields({ itemAttributes: { serial_number: true as unknown as string } }).serial === null, 'kein Text → nichts');

// Titelbild: primär markiert, sonst erstes nach Reihenfolge; Fingerabdruck = Kennung + Inhalt
const ref = (id: string, prim: boolean, sort: number) => ({ mediaId: id, isPrimary: prim, sortOrder: sort, main: { storageKey: `t1/aa/${id}.jpg`, hash: 'h' + id, extension: 'jpg', mimeType: 'image/jpeg' } });
ok(h.pickRepairCover([]) === null, 'ohne Fotos kein Titelbild');
ok(h.pickRepairCover([ref('a', false, 2), ref('b', true, 1), ref('c', false, 0)])?.mediaId === 'b', 'das als erstes markierte Foto');
ok(h.pickRepairCover([ref('a', false, 2), ref('c', false, 0)])?.mediaId === 'c', 'sonst das erste nach Reihenfolge');
ok(h.repairCoverFingerprint(ref('a', true, 0)) === 'a|ha' && h.repairCoverFingerprint(ref('a', true, 0)) !== h.repairCoverFingerprint({ ...ref('a', true, 0), main: { ...ref('a', true, 0).main, hash: 'neu' } }),
  'Fingerabdruck ändert sich mit dem Inhalt');
ok(h.repairCoverCacheKey('rep-1') === 'repair-cover:rep-1', 'eigener Cache-Schlüssel (getrennt von Artikelkarten)');

// Lage: immer ganz im Fenster
const p1 = h.hoverCardPosition(100, 100, 1600, 900);
ok(p1.left === 118 && p1.top === 112, 'rechts unter dem Zeiger');
const p2 = h.hoverCardPosition(1500, 800, 1600, 900);
ok(p2.left === 1500 - 18 - 300 && p2.top === 900 - 440 - 8, 'am rechten/unteren Rand: links davon und hochgeschoben');

// Karte und Lader: Hauptbild, erst beim Zeigen, gemeinsamer Cache, beide Rechner
const card = readFileSync(join(repo, 'src/components/repairs/RepairHoverCard.tsx'), 'utf8');
const hook = readFileSync(join(repo, 'src/hooks/useRepairCoverImage.ts'), 'utf8');
const list = readFileSync(join(repo, 'src/pages/repairs/RepairList.tsx'), 'utf8');
ok(/const IMG = 280/.test(card) && /objectFit: 'contain'/.test(card), 'Bild ≈ 280 × 280, ganzes Bild (contain)');
ok(['Brand', 'Model', 'Reference', 'Serial number'].every((l) => card.includes(`'${l}'`)) && !/purchasePrice|Cost|customer/i.test(card.replace(/CollectionProductThumb|product=\{product\}/g, '')),
  'Inhalt ausschließlich Bild, Marke, Modell, Referenz, Seriennummer');
ok(/media_read_verified_raw|readVerifiedRaw/.test(hook) && /repairs\.get/.test(hook) && /\/api\/media\?key=/.test(hook) && /sharedCardImageCache/.test(hook),
  'Hauptbild über den geprüften Rohweg (Primary) bzw. /api/media (PC2), gemeinsamer RAM-Cache');
ok(!/loadRepairPhotos\(/.test(hook) && /pickRepairCover/.test(hook), 'nur EIN Bild, nie die ganze Galerie');
ok(/setTimeout\(\(\) => setHover/.test(list) && /createPortal\(/.test(list) && /pointerEvents: 'none'/.test(list), 'Liste: Karte nach kurzem Verweilen, als Portal, blockiert keine Klicks');
ok(!/UPDATE |INSERT |DELETE /.test(hook + card), 'nur lesend');

console.log(FAIL ? `\nFAIL — repair-hover: ${PASS} passed, ${FAIL} failed` : `\nPASS — repair-hover: ${PASS} passed, 0 failed`);
process.exit(FAIL ? 1 : 0);
