// ════════════════════════════════════════════════════════════════════════════
// POST-PARITY R7B / PP-12 — Bildwege und Frist nach der echten Speicherung.
//
//   §1 Aufnahmeprofil an EINER Stelle (Desktop 800 px / 0,7 — gemessen begründet; Handy 1600 / 0,85).
//   §2 EIN Normalisierer für Belegbilder: neu → durch den Normalisierer, gespeichert → unverändert.
//   §3 Verdrahtung: der aufnehmende Rechner rechnet (Primary vor der Klammer, PC2 vor dem Ablegen),
//      der Primary prüft beim Abholen; Artikelbilder bleiben im Medienspeicher.
//   §4 Die Frist der schreibenden Dokumentwege kennt die Datenbankgröße.
//
// Was der echte Normalisierer mit den Bytes tut (≤ 100 000 B, ≤ 1600 px, JPEG, idempotent), beweist
// `cargo test media::record_image`; hier wird ein gestellter benutzt und gezählt.
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const repo = process.cwd();
const src = (p: string): string => readFileSync(join(repo, p), 'utf8').replace(/\r\n/g, '\n');
const S = JSON.stringify;
let PASS = 0;
const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const marker = (m: string): void => { if (fails.length === 0) console.log(m); };
const walk = (dir: string): string[] => readdirSync(join(repo, dir)).flatMap((f) => {
  const p = `${dir}/${f}`;
  return statSync(join(repo, p)).isDirectory() ? walk(p) : [p];
});
/** Kommentare raus — eine Regel im Kommentar ist keine Verdrahtung. */
const code = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
/** Der Rumpf einer Funktion (vom Namen bis zur nächsten Deklaration auf Spalte 0). */
const fn = (c: string, name: string): string => {
  const a = c.search(new RegExp(`(export )?(async )?function ${name}\\b`));
  if (a < 0) return '';
  const rest = c.slice(a + 10);
  const b = rest.search(/\n(export |function |const |async function |\/\*\*)/);
  return c.slice(a, b < 0 ? undefined : a + 10 + b);
};

const rec = await import('../../src/core/media/record-image.ts');
const cap = await import('../../src/core/media/capture-profile.ts');

// ══ §1 — Aufnahmeprofil ══════════════════════════════════════════════════════
{
  ok(cap.CAPTURE_MAX_DIM === 800 && cap.CAPTURE_JPEG_QUALITY === 0.7,
    'PROFIL Desktop 800 px / 0,7 — unverändert (1600 px kostet am Primary ~1,6 s je Foto innerhalb der 20-s-Frist, Bench)');
  ok(S(cap.captureSize(4000, 3000)) === S({ width: 800, height: 600 }) && S(cap.captureSize(900, 1800)) === S({ width: 400, height: 800 })
    && S(cap.captureSize(640, 480)) === S({ width: 640, height: 480 }), 'PROFIL längste Seite ≤ 800, nie vergrößert');
  const mp = src('src-tauri/src/sync/mobile_page.rs');
  const uses = (mp.match(/resizePhoto\([^)]*\)/g) ?? []).filter((c) => !/maxDim/.test(c));
  ok(uses.length === 3 && uses.every((c) => /, 1600, 0\.85\)$/.test(c)), `PROFIL das Handy nimmt bewusst größer auf (KI-Vorlage, keine Brückenfrist) (${S(uses)})`);
  const iu = code(src('src/components/ui/ImageUpload.tsx'));
  ok(/import \{ captureImage \} from '@\/core\/media\/capture-profile'/.test(iu) && /await captureImage\(file\)/.test(iu) && !/compressImage|toDataURL/.test(iu),
    'PROFIL die EINE Auswahl des Desktops rechnet nicht selbst, sie nutzt das Profil');
  ok(/try \{\s*newImages\.push\(await captureImage\(file\)\);\s*\} catch \{\s*unreadable\+\+;/.test(iu) && /data-image-upload-skipped/.test(iu),
    'PROFIL eine unlesbare Datei wird übersprungen und genannt, die gültigen bleiben');
  const cp = code(src('src/core/media/capture-profile.ts'));
  ok(/fillStyle = '#FFFFFF'/.test(cp) && /toDataURL\('image\/jpeg', CAPTURE_JPEG_QUALITY\)/.test(cp), 'PROFIL Transparenz auf Weiß (wie der Normalisierer), JPEG');
  const users = walk('src').filter((f) => /\.tsx$/.test(f) && /<ImageUpload\b/.test(src(f)));
  // MEDIA-IDENTITY §3 — neun statt zehn: die Lieferantenmaske zeigt ihr Ausweisdokument jetzt über
  // `IdentityPhotoField` (ANSEHEN kommt dort über den geprüften Leser, nicht aus einer Spalte). Die
  // Auswahl einer Datei geht auch dort durch `captureImage` — dasselbe Profil, eine andere Hülle.
  ok(users.length === 9, `PROFIL neun Masken wählen Fotos über dieselbe Komponente (${users.length})`);
  const ipf = code(src('src/components/identity/IdentityPhotoField.tsx'));
  ok(/import \{ captureImage \} from '@\/core\/media\/capture-profile'/.test(ipf) && /await captureImage\(f\)/.test(ipf),
    'PROFIL …und die zehnte (das Ausweisdokument) nutzt dasselbe Aufnahmeprofil');
}
marker('POST_PARITY_PP12_ONE_CAPTURE_PROFILE');

// ══ §2 — EIN Normalisierer für Belegbilder ═══════════════════════════════════
{
  const calls: string[] = [];
  rec.setRecordImageNormalizer(async (b64, mime) => {
    calls.push(`${mime}:${b64}`);
    if (b64 === 'VEINY') throw new Error('MEDIA_IMAGE_DETAIL_INSUFFICIENT');
    return { mime: 'image/jpeg', dataBase64: `N${b64}`, bytes: 1, width: 1, height: 1 };
  });
  const alt = 'data:image/jpeg;base64,QUxU';
  const out = await rec.normalizeRecordImages(['data:image/png;base64,TkVV', alt, 'data:image/webp;base64,WlpY'], { keep: [alt] });
  ok(S(out) === S(['data:image/jpeg;base64,NTkVV', alt, 'data:image/jpeg;base64,NWlpY']), `NORMAL neu → durch den Normalisierer, gespeichert → unverändert, Reihenfolge bleibt (${S(out)})`);
  ok(S(calls) === S(['image/png:TkVV', 'image/webp:WlpY']), 'NORMAL das gespeicherte Foto wird nicht erneut gerechnet');
  let code1 = '';
  try { await rec.normalizeRecordImages(['https://example.com/x.jpg']); } catch (e) { code1 = (e as { code?: string }).code ?? ''; }
  ok(code1 === 'RECORD_IMAGE_NOT_A_PHOTO', `NORMAL keine Bild-Daten-URL → Nein (${code1})`);
  let err: { code?: string; message?: string } = {};
  try { await rec.normalizeRecordImages(['data:image/jpeg;base64,VEINY']); } catch (e) { err = e as never; }
  ok(err.code === 'MEDIA_IMAGE_DETAIL_INSUFFICIENT' && /closer photo/.test(err.message ?? ''), `NORMAL ein Nein des Normalisierers behält seinen Code und sagt, was zu tun ist (${err.code})`);
  ok(rec.recordImageCode('Error: MEDIA_IMAGE_TOO_LARGE') === 'MEDIA_IMAGE_TOO_LARGE' && rec.recordImageCode('boom') === 'RECORD_IMAGE_NOT_STORED', 'NORMAL Codes aus der Rust-Antwort');
  const spec = { brand: 'X', images: ['data:image/png;base64,QQ'] };
  const s2 = await rec.normalizeSpecImages(spec);
  ok(S(s2) === S({ brand: 'X', images: ['data:image/jpeg;base64,NQQ'] }) && spec.images[0] === 'data:image/png;base64,QQ', 'NORMAL Artikelentwurf: Fotos normalisiert, Eingabe unberührt');
  const leer = { brand: 'Y' };
  ok((await rec.normalizeSpecImages(leer)) === leer && (await rec.normalizeSpecImages(undefined)) === undefined, 'NORMAL Entwurf ohne Foto bleibt derselbe');
  ok((await rec.normalizeRecordImage(alt, alt)) === alt && (await rec.normalizeRecordImage('data:image/png;base64,QQ', alt)) === 'data:image/jpeg;base64,NQQ', 'NORMAL Ausweisbild: gespeichert bleibt, neu wird gerechnet');
  const bytes = Buffer.from('LATAIF-PP12');
  ok((await rec.sha256OfDataUrl(`data:image/jpeg;base64,${bytes.toString('base64')}`)) === createHash('sha256').update(bytes).digest('hex'),
    'NORMAL Kennung eines gespeicherten Fotos = SHA-256 seiner Bytes = die Kennung, die ihm die Ablage gäbe');
  ok(rec.RECORD_IMAGE_MAX_BYTES === 100_000 && rec.RECORD_IMAGE_MAX_DIM === 1600, 'NORMAL dieselbe Grenze wie das Hauptbild des Medienspeichers');
  rec.setRecordImageNormalizer(null);
}
marker('POST_PARITY_PP12_ONE_RECORD_NORMALIZER');

// ══ §3 — Verdrahtung ═════════════════════════════════════════════════════════
{
  // Rust: EIN Normalisierer (der des Artikelbilds), dieselben Eingangsgrenzen wie Handy und Ablage.
  const nz = src('src-tauri/src/media/normalize.rs');
  ok(/const MAIN_MAX_BYTES: usize = 100_000;/.test(nz) && /const THUMB_MAX_BYTES: usize = 20_000;/.test(nz) && /const MAIN_MAX_DIM: u32 = 1600;/.test(nz),
    'RUST Hauptbild ≤ 100 000 B (dezimal), Vorschau ≤ 20 000 B, 1600 px — die Grenzen des Hauses, unverändert');
  const ri = code(src('src-tauri/src/media/record_image.rs'));
  ok(/normalize_stock_image\(bytes, &record_image_limits\(\)\)/.test(ri) && /MAX_UPLOAD_IMAGE_BYTES, MAX_UPLOAD_IMAGE_DIM, MAX_UPLOAD_IMAGE_PIXELS/.test(ri),
    'RUST Belegbild = derselbe Normalisierer, dieselben Eingangsgrenzen wie /api/mobile/upload und die Ablage');
  ok(/pub const RECORD_IMAGE_MAX_BYTES: usize = 100_000;/.test(ri) && /\(0xE1\.\.=0xEF\)\.contains\(&marker\)/.test(ri) && /if let Some\(\(width, height\)\) = already_stored_form\(bytes\)/.test(ri),
    'RUST ein Foto in der gespeicherten Form (JPEG ≤ 100 000 B, ≤ 1600 px, ohne Metadaten-Segment) bleibt Byte für Byte');
  const lib = src('src-tauri/src/lib.rs');
  const handler = lib.slice(lib.indexOf('tauri::generate_handler!['));
  ok(/media_normalize_record_image,/.test(handler) && /staging_media_read_record,/.test(handler), 'RUST beide Befehle angemeldet');
  const cmds = lib.slice(lib.indexOf('async fn media_normalize_record_image'), lib.indexOf('fn staging_media_discard('));
  ok((cmds.match(/spawn_blocking\(move \|\| media::record_image::record_image_json\(&bytes\)\)/g) ?? []).length === 2,
    'RUST beide rechnen neben dem Hauptfaden, mit derselben Funktion');

  // Primary: der Normalisierer läuft VOR der Klammer (das Umrechnen hält die Schreibreihenfolge nicht auf).
  const rh = code(src('src/core/repairs/repair-house.ts'));
  // MEDIA-REPAIR — das Umrechnen UND die Aufnahme ins Medium laufen vor der Klammer; „behalten"
  // nennt jetzt die stabile Medienkennung statt der gespeicherten Daten-URL.
  ok(/const images = await normalizeRecordImages\(form\.images \?\? \[\]\);\s*const mediaIds = await ingestRepairPhotos\(images\);\s*return amPrimary\(\(\) => \{/.test(rh)
    && /const neu = await normalizeRecordImages\(wunsch\.filter\(\(x\) => x\.startsWith\('data:'\)\)\);/.test(rh)
    && /galleryMediaIds = await resolveRepairPhotoSlots\(/.test(rh),
  'PRIMARY Reparatur anlegen/ändern — vor der Klammer; die Galerie sind Medien, keine Bytes');
  const ma = code(src('src/core/metals/metal-actions.ts'));
  ok(/const photos = await withRecordScrapPhotos\(input, \[\]\);\s*return runOnPrimary\(/.test(ma)
    && /withRecordScrapPhotos\(input, storedScrapPhotos\(tradeId, localHouseBranch\(\)\)\);\s*return runOnPrimary\(/.test(ma),
  'PRIMARY Altgold anlegen/ändern — vor der Klammer; ändern behält die gespeicherten Fotos');
  const ms = code(src('src/core/masterdata/masterdata-save.ts'));
  const is = code(src('src/core/identity/identity-save.ts'));
  // MEDIA-IDENTITY §3/§6 — das Ausweisfoto geht nicht mehr durch den TS-Normalisierer in eine
  // Spalte, sondern durch den Medienkern: `ingestIdentityPhoto` → Rust normalisiert (JPEG,
  // ≤ 100 000 B, EXIF), prüft und veröffentlicht. Es bleibt bei EINEM Normalisierer, und der
  // Aufruf steht weiterhin VOR der Klammer.
  ok(!/normalizeRecordImage\(/.test(ms) && /await prepareIdentityPhoto\(/.test(ms)
    && !/local: async \(\) => \{/.test(ms), 'PRIMARY Ausweisfoto anlegen/ändern — vor der Klammer');
  ok(/await ingestIdentityPhoto\(intent\.dataUrl/.test(is),
    'PRIMARY …und zwar über den Medienkern, nicht über einen zweiten Rechenweg');
  ok(/normalizeSpecImages\(l\.newProduct\)[\s\S]*return runOnPrimary\(\(\) => createPurchaseInHouse\(/.test(code(src('src/core/purchases/purchase-house.ts'))), 'PRIMARY Einkauf „New Item"');
  const oh = code(src('src/core/orders/order-house.ts'));
  ok(/normalizeSpecImages\(input\.customProductSpec\);\s*return runOnPrimary\(\(\) => createOrderInHouse\(\{ \.\.\.input, lines, customProductSpec \}/.test(oh), 'PRIMARY Auftrag: neuer Artikel und Sonderstück-Entwurf');
  ok(/const ready = req\.newProduct \? \{ \.\.\.req, newProduct: await normalizeSpecImages\(req\.newProduct\) \} : req;\s*return runOnPrimary\(\(\) => updateOrderLineInHouse\(ready, branchId\)/.test(code(src('src/core/orders/order-lifecycle-house.ts'))),
    'PRIMARY Positionsdialog: neuer Artikel');

  // PC2: der aufnehmende Rechner rechnet vor dem Ablegen (derselbe Normalisierer, dieselbe Anwendung).
  const su = code(src('src/core/bridge/client-staging-upload.ts'));
  ok(/export async function stageRecordDataUrls\(/.test(su) && /ready = await normalizeRecordImages\(urls, \{ keep \}\);/.test(su) && /return stageDataUrls\(ready, fetchFn\);/.test(su),
    'PC2 Belegbilder: erst durch den Normalisierer, dann in die Ablage');
  const record: Array<[string, RegExp]> = [
    ['src/pages/repairs/RepairList.tsx', /stageRecordDataUrls\(form\.images \?\? \[\]\)/],
    ['src/pages/repairs/RepairDetail.tsx', /repairPhotoPlan\(repair\.images \?\? \[\], form\.images \?\? \[\], \(urls\) => stageRecordDataUrls\(urls\)\)/],
    ['src/pages/purchases/PurchaseCreate.tsx', /purchaseCreateBody\(input, stageRecordDataUrls\)/],
    ['src/pages/orders/OrderCreate.tsx', /orderCreateBody\(input, stageRecordDataUrls\)/],
    ['src/pages/orders/OrderDetail.tsx', /orderLineEditBody\(req, stageRecordDataUrls\)/],
    // MEDIA-IDENTITY §3 — dieselbe Ablage, nur an EINER Stelle für Kunde und Lieferant.
    ['src/core/identity/identity-save.ts', /stageRecordDataUrls\(\[intent\.dataUrl\]\)/],
    ['src/core/metals/metal-actions.ts', /stage \?\?= \(urls\) => stageRecordDataUrls\(urls, keep\)/],
  ];
  for (const [f, re] of record) ok(re.test(code(src(f))), `PC2 ${f}: Belegbilder über stageRecordDataUrls`);
  ok(/stageScrapPhotos\(values, undefined, t\.lines\.flatMap\(/.test(code(src('src/pages/scrap-trades/ScrapTradeDetail.tsx'))),
    'PC2 Altgold ändern: die gespeicherten Fotos reisen unverändert (keep)');
  const pipeline: Array<[string, RegExp]> = [
    ['src/pages/watches/WatchList.tsx', /stageDataUrls\(form\.images/], ['src/pages/watches/ProductDetail.tsx', /stageDataUrls\)/],
    ['src/pages/consignments/ConsignmentList.tsx', /stageDataUrls\(bilder\)/], ['src/pages/production/ProductionPage.tsx', /productionOutputBodies\(input\.outputs, stageDataUrls\)/],
  ];
  for (const [f, re] of pipeline) ok(re.test(code(src(f))) && !/stageRecordDataUrls/.test(code(src(f))), `MEDIENSPEICHER ${f}: roh (der Medienspeicher rechnet Hauptbild + Vorschau selbst)`);

  // Primary beim Abholen: jeder Belegbild-Eingang liest über den normalisierenden (prüfenden) Leser.
  const want: Array<[string, number]> = [
    ['src/core/bridge/service-commands.ts', 2], ['src/core/bridge/metal-commands.ts', 1], ['src/core/bridge/masterdata-commands.ts', 1],
    ['src/core/bridge/commercial-commands.ts', 2], ['src/core/bridge/order-lifecycle-commands.ts', 1],
  ];
  for (const [f, n] of want) {
    ok((code(src(f)).match(/\?\? invokeReadStagedRecord\b/g) ?? []).length === n, `ABHOLEN ${f}: ${n}× der prüfende Standardleser`);
  }
  const cc = code(src('src/core/bridge/commercial-commands.ts'));
  const mit = cc.slice(cc.indexOf('export async function mitFotos'), cc.indexOf('function num0'));
  ok(/readStagedAsRecordImages\(p\.stagingIds/.test(mit), 'ABHOLEN Entwurfsfotos (Einkauf/Auftrag) als Belegbilder');
  const mc = code(src('src/core/bridge/metal-commands.ts'));
  ok(/stored\.get\(id\) \?\? \(await readStagedAsRecordImages\(\[id\]/.test(mc) && /withPhotos\(req, identity, media, req\.tradeId\)/.test(mc),
    'ABHOLEN Altgold ändern: ein neu abgelegtes, schon gespeichertes Foto (gleicher SHA-256) bleibt die gespeicherte Fassung');
  const raw = walk('src').filter((f) => /\.ts$/.test(f) && /readStagedAsDataUrls\(/.test(code(src(f))) && !/remote-create-support\.ts$/.test(f));
  ok(S(raw.sort()) === S(['src/core/bridge/commercial-commands.ts', 'src/core/bridge/product-commands.ts', 'src/core/bridge/production-commands.ts']),
    `MEDIENSPEICHER roh gelesen wird nur für Artikel, Kommission, Fertigung (${S(raw)})`);
  const consign = fn(cc, 'runConsignmentCreate');
  ok(/readStagedAsDataUrls\(/.test(consign) && (cc.match(/readStagedAsDataUrls\(/g) ?? []).length === 1, 'MEDIENSPEICHER in commercial-commands nur die Kommission');
  const shim = src('test/bridge/_tauri-shim.ts');
  ok(/case 'staging_media_read_record'/.test(shim) && /case 'media_normalize_record_image'/.test(shim), 'TEST die IPC-Grenze kennt beide Befehle');
}
marker('POST_PARITY_PP12_RECORD_IMAGES_UNIFIED');

// ══ §4 — Frist nach der echten Speicherung ═══════════════════════════════════
{
  const br = src('src-tauri/src/bridge.rs');
  ok(/pub const SAVE_FLOOR_BYTES_PER_SEC: u64 = 4_000_000;/.test(br) && /pub const DOCUMENT_UPLOAD_GROWTH_COPIES: u64 = 2;/.test(br), 'FRIST Untergrenze 4 MB/s, Wachstum = 2 Kopien');
  const tf = br.slice(br.indexOf('pub fn timeout_for'), br.indexOf('pub enum BridgeError'));
  ok(/save_at_floor\(db_bytes\.saturating_add\(len \* DOCUMENT_UPLOAD_GROWTH_COPIES\)\)/.test(tf) && /\+ save_at_floor\(db_bytes\)/.test(tf),
    'FRIST Upload: Datenbank + Wachstum; Texterkennung: Datenbank');
  const contentArm = tf.slice(tf.indexOf('OP_DOCUMENTS_CONTENT_GET'), tf.indexOf('OP_DOCUMENTS_SET_OCR'));
  ok(!/save_at_floor/.test(contentArm) && /_ => DEFAULT_TIMEOUT,/.test(tf), 'FRIST Inhalt lesen speichert nichts; alles Normale bleibt 20 s');
  const rt = src('src-tauri/src/sync/routes.rs');
  ok(/let db_bytes = std::fs::metadata\(&state\.frontend_db_path\)\.map\(\|m\| m\.len\(\)\)\.unwrap_or\(0\);/.test(rt), 'FRIST die Größe der Datei, die das Speichern schreibt');
  const len = 33_488_896 + 40;
  const frist = (db: number): number => 20 + Math.floor(len * 10 * 1000 / 10_000_000) / 1000 + Math.floor((db + len * 2) * 1000 / 4_000_000) / 1000;
  const gemessen: Array<[number, number]> = [[69e6, 17.9], [136e6, 23.0], [203e6, 31.3]];
  const quoten = gemessen.map(([db, s]) => frist(db) / s);
  ok(quoten.every((q) => q >= 3), `FRIST die gemessenen Rundläufe liegen ≥ 3× unter der neuen Frist (${quoten.map((q) => q.toFixed(1)).join(' / ')}; vorher 3,0 / 2,3 / 1,7)`);
}
marker('POST_PARITY_PP12_DB_SIZE_DEADLINE');

console.log(`\npp12 images + deadline: ${PASS} passed, ${fails.length} failed`);
if (fails.length === 0) console.log('POST_PARITY_PP12_IMAGES_UNIT_PROVED');
process.exit(fails.length ? 1 : 0);
