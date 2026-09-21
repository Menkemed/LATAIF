// ════════════════════════════════════════════════════════════════════════════
// POST-PARITY R7B / PP-12 — Fotos, die über den Abgleich hereinkommen (Handy-Reparatur, Einkaufs-Inbox,
// jede Bildspalte des Manifests): bei der Übernahme durch den EINEN Normalisierer, gespeicherte
// unverändert, unspeicherbare in die Quarantäne, Dokumente unberührt.
//
// Was der echte Normalisierer mit den Bytes tut (≤ 100 000 B, ≤ 1600 px, JPEG, idempotent), beweist
// `cargo test media::record_image`; hier wird ein gestellter benutzt und gezählt.
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repo = process.cwd();
const src = (p: string): string => readFileSync(join(repo, p), 'utf8').replace(/\r\n/g, '\n');
let PASS = 0;
const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const code = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const rec = await import('../../src/core/media/record-image.ts');
const pull = await import('../../src/core/sync/pulled-record-images.ts');

// Der gestellte Normalisierer: „BROKEN" ist ein kaputtes Bild (fester Code), „OFFLINE" ein nicht
// erreichbarer Normalisierer (kein Urteil), sonst eine kurze JPEG-Fassung, die ihre Herkunft trägt.
let calls = 0;
rec.setRecordImageNormalizer(async (b64) => {
  calls++;
  const raw = Buffer.from(b64, 'base64').toString('latin1');
  if (raw.startsWith('BROKEN')) throw new Error('MEDIA_IMAGE_DECODE_FAILED');
  if (raw.startsWith('OFFLINE')) throw new Error('invoke: command not found');
  return { mime: 'image/jpeg', dataBase64: Buffer.from('N:' + raw.slice(0, 12)).toString('base64'), bytes: 14, width: 1600, height: 1067 };
});
const url = (s: string, mime = 'image/jpeg') => `data:${mime};base64,` + Buffer.from(s).toString('base64');
const RAW1 = url('raw-phone-1-' + 'x'.repeat(400000));
const RAW2 = url('raw-phone-2-' + 'y'.repeat(400000));
const LEGACY = url('legacy-big-stored-photo-' + 'z'.repeat(300000), 'image/png');
const isNorm = (u: unknown) => typeof u === 'string' && Buffer.from(u.slice(u.indexOf(',') + 1), 'base64').toString().startsWith('N:');

// Was in der Datenbank steht (für `keep`).
const DB: Record<string, Record<string, Record<string, unknown>>> = {
  repairs: { 'r-old': { images: JSON.stringify([LEGACY]) } },
  suppliers: { 's-old': { cpr_image: LEGACY } },
  orders: { 'o-old': { custom_product_spec: JSON.stringify({ name: 'Ring', images: [LEGACY] }) } },
};
const stored = (t: string, id: string, c: string) => DB[t]?.[id]?.[c];
const ch = (table_name: string, record_id: string, action: string, data: Record<string, unknown> | string) =>
  ({ id: Math.floor(Math.random() * 1e9), table_name, record_id, action, data: typeof data === 'string' ? data : JSON.stringify(data) });

// ══ §1 — das Handy: Reparatur und Einkaufs-Inbox (Bildliste als JSON-Text, wie `mobile_page.rs` sie schickt) ══
{
  calls = 0;
  const cust = ch('customers', 'c1', 'insert', { id: 'c1', first_name: 'A' });
  const rep = ch('repairs', 'r1', 'insert', { id: 'r1', issue_description: 'x', images: JSON.stringify([RAW1]) });
  const inbox = ch('purchase_inbox', 'i1', 'insert', { id: 'i1', status: 'pending', images: JSON.stringify([RAW2]) });
  const p = await pull.prepareRecordImages([cust, rep, inbox], stored);
  const r = JSON.parse(p.changes[1].data as string), i = JSON.parse(p.changes[2].data as string);
  const ri = JSON.parse(r.images), ii = JSON.parse(i.images);
  ok(p.changes[0] === cust, 'HANDY die Kundenzeile bleibt dasselbe Objekt (keine Bildspalte)');
  ok(typeof r.images === 'string' && ri.length === 1 && isNorm(ri[0]), 'HANDY Reparaturfoto normalisiert, als JSON-Text wie gesendet');
  ok(typeof i.images === 'string' && ii.length === 1 && isNorm(ii[0]), 'HANDY Inbox-Foto normalisiert, als JSON-Text wie gesendet');
  ok(calls === 2 && p.normalized === 2 && p.rejected.size === 0, `HANDY genau zwei Normalisierungen, keine Ablehnung (${calls}/${p.normalized})`);
  ok(r.issue_description === 'x' && i.status === 'pending' && Object.keys(r).join() === 'id,issue_description,images', 'HANDY übrige Felder und ihre Reihenfolge unverändert');
}

// ══ §2 — gespeicherte Fotos bleiben Byte für Byte (das Echo des Primary, eine Ergänzung) ══
{
  calls = 0;
  const echo = ch('repairs', 'r-old', 'update', { id: 'r-old', images: JSON.stringify([LEGACY]) });
  const p = await pull.prepareRecordImages([echo], stored);
  ok(p.changes[0] === echo && calls === 0, 'ECHO eine Zeile mit ihrem gespeicherten Altbild (PNG, 300 KB) → unverändert, kein Normalisieren');
  calls = 0;
  const add = ch('repairs', 'r-old', 'update', { id: 'r-old', images: JSON.stringify([LEGACY, RAW1]) });
  const q = await pull.prepareRecordImages([add], stored);
  const imgs = JSON.parse(JSON.parse(q.changes[0].data as string).images);
  ok(imgs[0] === LEGACY && isNorm(imgs[1]) && calls === 1, 'ERGÄNZUNG das gespeicherte bleibt Byte für Byte, nur das neue geht durch den Normalisierer');
  calls = 0;
  const other = ch('repairs', 'r-new', 'insert', { id: 'r-new', images: JSON.stringify([LEGACY]) });
  const o = await pull.prepareRecordImages([other], stored);
  ok(isNorm(JSON.parse(JSON.parse(o.changes[0].data as string).images)[0]) && calls === 1, 'FREMDE ZEILE dasselbe Altbild in einer ANDEREN Zeile ist dort neu → normalisiert (kein Umweg über eine fremde Zeile)');
}

// ══ §3 — kein Umweg: unspeicherbar → Quarantäne; kein Foto → Quarantäne; Normalisierer weg → kein Urteil ══
{
  const broken = ch('repairs', 'r2', 'insert', { id: 'r2', images: JSON.stringify([url('BROKEN-bytes')]) });
  const good = ch('repairs', 'r3', 'insert', { id: 'r3', images: JSON.stringify([RAW1]) });
  const p = await pull.prepareRecordImages([broken, good], stored);
  ok(p.rejected.get(p.changes[0]) === 'MEDIA_IMAGE_DECODE_FAILED' && p.changes[0] === broken, 'ABLEHNUNG ein kaputtes Foto → Quarantänefall mit festem Code, die Änderung unverändert');
  ok(!p.rejected.has(p.changes[1]) && isNorm(JSON.parse(JSON.parse(p.changes[1].data as string).images)[0]), 'ABLEHNUNG die gültige Änderung daneben wird normal übernommen');
  const link = ch('purchase_inbox', 'i2', 'insert', { id: 'i2', images: JSON.stringify(['https://example.invalid/a.jpg']) });
  const l = await pull.prepareRecordImages([link], stored);
  ok(l.rejected.get(l.changes[0]) === 'RECORD_IMAGE_NOT_A_PHOTO', 'ABLEHNUNG ein Verweis statt eines Fotos → Quarantänefall');
  let threw = false;
  try { await pull.prepareRecordImages([ch('repairs', 'r4', 'insert', { id: 'r4', images: JSON.stringify([url('OFFLINE')]) })], stored); } catch { threw = true; }
  ok(threw, 'KEIN URTEIL ein nicht erreichbarer Normalisierer → der Stapel wird nicht übernommen (Stand bleibt, nächstes Abholen)');
  ok(pull.SYNC_RECORD_IMAGE_REJECTED === 'SYNC_RECORD_IMAGE_REJECTED', 'ABLEHNUNG der Quarantänecode');
}

// ══ §4 — jede Bildspalte, jede Form ══
{
  calls = 0;
  const prod = ch('products', 'p1', 'insert', { id: 'p1', images: [RAW1, RAW2] });
  const sup = ch('suppliers', 's1', 'insert', { id: 's1', cpr_image: RAW1 });
  const supEcho = ch('suppliers', 's-old', 'update', { id: 's-old', cpr_image: LEGACY });
  const metal = ch('precious_metals', 'm1', 'insert', { id: 'm1', images: JSON.stringify([RAW2]) });
  const ord = ch('orders', 'o1', 'insert', { id: 'o1', custom_product_spec: JSON.stringify({ name: 'Ring', sku: 'R-1', images: [RAW1] }) });
  const ordEcho = ch('orders', 'o-old', 'update', { id: 'o-old', custom_product_spec: JSON.stringify({ name: 'Ring', images: [LEGACY] }) });
  const p = await pull.prepareRecordImages([prod, sup, supEcho, metal, ord, ordEcho], stored);
  const d = p.changes.map((c) => JSON.parse(c.data as string));
  ok(Array.isArray(d[0].images) && d[0].images.every(isNorm), 'SPALTE products.images (echtes Feld) → normalisiert, bleibt ein Feld');
  ok(isNorm(d[1].cpr_image), 'SPALTE suppliers.cpr_image (ein Foto) → normalisiert');
  ok(p.changes[2] === supEcho, 'SPALTE suppliers.cpr_image gespeichert → unverändert');
  ok(isNorm(JSON.parse(d[3].images)[0]), 'SPALTE precious_metals.images → normalisiert');
  const spec = JSON.parse(d[4].custom_product_spec);
  ok(spec.name === 'Ring' && spec.sku === 'R-1' && isNorm(spec.images[0]), 'SPALTE orders.custom_product_spec.images → normalisiert, übrige Angaben unverändert');
  ok(p.changes[5] === ordEcho, 'SPALTE orders.custom_product_spec gespeichert → unverändert');
  ok(calls === 5, `SPALTE genau fünf neue Fotos gerechnet (${calls})`);
}

// ══ §5 — nicht hierher: Dokumente (Original der Texterkennung), Löschen, kaputte Nutzlast ══
{
  calls = 0;
  const doc = ch('documents', 'd1', 'insert', { id: 'd1', file_path: RAW1, file_type: 'image/jpeg' });
  const del = ch('repairs', 'r1', 'delete', '{}');
  const bad = ch('repairs', 'r5', 'insert', '{not json');
  const p = await pull.prepareRecordImages([doc, del, bad], stored);
  ok(p.changes[0] === doc && p.changes[1] === del && p.changes[2] === bad && calls === 0 && p.rejected.size === 0,
    'GRENZE Dokument-Original, Löschen und eine kaputte Nutzlast (die Übernahme weist sie selbst ab) bleiben unberührt');
}

// ══ §6 — die Liste der Bildspalten gegen das Manifest, die Verdrahtung im Abholen ══
{
  const manifest = JSON.parse(src('src/core/sync/sync-business-schema.json')) as { tables: Record<string, { allowed_fields: string[] }> };
  // Bewusst NICHT normalisiert: das Dokument (Original + seine Vorschau) und die abgeleiteten
  // Beschreibungen/Kennungen eines Artikelbilds (kein Foto).
  const EXCLUDED = new Set(['documents.file_path', 'documents.thumbnail_path', 'documents.file_name', 'documents.file_type', 'documents.file_size',
    'products.image_description', 'products.image_embedding', 'products.image_hash']);
  const photoFields = Object.entries(manifest.tables).flatMap(([t, c]) => c.allowed_fields.filter((f) => /image|photo|picture/i.test(f)).map((f) => `${t}.${f}`));
  const covered = Object.entries(pull.PULLED_RECORD_IMAGE_COLUMNS).flatMap(([t, cols]) => cols.map((c) => `${t}.${c.column}`));
  const missing = photoFields.filter((f) => !EXCLUDED.has(f) && !covered.includes(f));
  ok(missing.length === 0, `MANIFEST jede Foto-Spalte ist abgedeckt (fehlt: ${missing.join(', ') || '—'})`);
  ok(covered.includes('orders.custom_product_spec') && covered.every((f) => { const [t, c] = f.split('.'); return manifest.tables[t]?.allowed_fields.includes(c); }),
    'MANIFEST jede abgedeckte Spalte steht im Manifest (Auftragsentwurf mit seinen Fotos eingeschlossen)');

  const svc = code(src('src/core/sync/sync-service.ts'));
  const pullBody = svc.slice(svc.indexOf('async function pullChanges'), svc.indexOf('\n}\n', svc.indexOf('async function pullChanges')));
  const iPrep = pullBody.indexOf('await prepareRecordImages(changes');
  const iCommit = pullBody.indexOf('await commitPulledBatch(');
  ok(iPrep > 0 && iCommit > iPrep && /changes = prepared\.changes;/.test(pullBody), 'ABHOLEN die Fotos werden VOR der Übernahme des Stapels vorbereitet, der Stapel ist der vorbereitete');
  ok(/applyChange: \(change\) => \{\s*const photo = prepared\.rejected\.get\(change\);\s*if \(photo\) \{\s*throw new SyncPoisonError\(SYNC_RECORD_IMAGE_REJECTED/.test(pullBody),
    'ABHOLEN ein abgelehntes Foto wird VOR `applySyncChange` zum Quarantänefall (onPoison derselben Transaktion)');
  const mod = code(src('src/core/sync/pulled-record-images.ts'));
  // MEDIA-LEGACY-SYNC — das Modul NENNT seither `documents`, aber nur, um die Datei eines vom
  // Medienkern geführten Belegs vor dem Überschreiben zu schützen. Durch den Normalisierer geht ein
  // Dokument weiterhin nie: in der Liste der normalisierten Bildspalten steht es nicht.
  ok(/normalizeRecordImages\(inc\.list, \{ keep \}\)/.test(mod) && !('documents' in pull.PULLED_RECORD_IMAGE_COLUMNS),
    'MODUL derselbe Normalisierer mit `keep`; kein Dokument in der Liste');
}

// ══ §7 — R7B-Review: ungültige Bildformen. Die Übernahme dahinter prüft nur die Transportform
//    (`validateBusinessPayload`), `applyUpsert` schreibt jedes Objekt als JSON-Text — ohne das Tor stünde
//    die Form wörtlich in der Zeile. Jetzt: Quarantäne; leere Felder und unveränderte Bestandswerte bleiben ══
{
  const { applySyncChange } = await import('../../src/core/sync/apply-change.ts');
  const initSqlJs = (await import('sql.js')).default;
  const SQL = await initSqlJs({ locateFile: () => join(repo, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm') });
  const sdb = new SQL.Database();
  sdb.run('CREATE TABLE repairs (id TEXT PRIMARY KEY, images TEXT)');
  applySyncChange(sdb as never, { table_name: 'repairs', record_id: 'rx', action: 'insert', data: JSON.stringify({ id: 'rx', images: { a: 'x' } }) } as never);
  ok(String(sdb.exec("SELECT images FROM repairs WHERE id='rx'")[0]?.values[0][0]) === '{"a":"x"}',
    'SCHREIBGRENZE ohne das Tor schreibt die Übernahme eine Objekt-„Bildliste" wörtlich (nur die Transportform wird geprüft)');
  sdb.close();

  calls = 0;
  const bad = [
    ch('repairs', 'rb1', 'insert', { id: 'rb1', images: [RAW1, 42] }),
    ch('repairs', 'rb2', 'insert', { id: 'rb2', images: JSON.stringify([RAW1, { x: 1 }]) }),
    ch('purchase_inbox', 'ib1', 'insert', { id: 'ib1', images: { a: RAW1 } }),
    ch('purchase_inbox', 'ib2', 'insert', { id: 'ib2', images: '{"a":1}' }),
    ch('products', 'pb1', 'insert', { id: 'pb1', images: RAW1 }),
    ch('precious_metals', 'mb1', 'insert', { id: 'mb1', images: 5 }),
    ch('suppliers', 'sb1', 'insert', { id: 'sb1', cpr_image: 42 }),
    ch('suppliers', 'sb2', 'insert', { id: 'sb2', cpr_image: [RAW1] }),
    ch('orders', 'ob1', 'insert', { id: 'ob1', custom_product_spec: JSON.stringify({ name: 'Ring', images: 'not-a-list' }) }),
    ch('orders', 'ob2', 'insert', { id: 'ob2', custom_product_spec: { name: 'Ring', images: [RAW1, 7] } }),
    ch('orders', 'ob3', 'insert', { id: 'ob3', custom_product_spec: JSON.stringify({ name: 'Ring', images: { a: RAW1 } }) }),
    ch('orders', 'ob4', 'insert', { id: 'ob4', custom_product_spec: '[1,2]' }),
  ];
  const p = await pull.prepareRecordImages(bad, stored);
  const miss = bad.filter((c, i) => p.changes[i] !== c || p.rejected.get(c) !== pull.RECORD_IMAGE_SHAPE_INVALID).map((c) => c.record_id);
  ok(miss.length === 0, `FORM gemischte Liste, Objekt statt Liste, Einzeltext statt Liste, Nicht-Text als Einzelfoto, Entwurf ohne gültige Fotoliste → Quarantänefall RECORD_IMAGE_SHAPE_INVALID, Änderung unverändert (abweichend: ${miss.join(',') || '—'})`);
  ok(calls === 0, 'FORM keine ungültige Form erreicht den Normalisierer oder die Zeile');

  calls = 0;
  const empty = [
    ch('repairs', 're1', 'insert', { id: 're1', images: null }),
    ch('repairs', 're2', 'insert', { id: 're2', images: '' }),
    ch('repairs', 're3', 'insert', { id: 're3', images: '[]' }),
    ch('products', 'pe1', 'insert', { id: 'pe1', images: [] }),
    ch('suppliers', 'se1', 'insert', { id: 'se1', cpr_image: null }),
    ch('suppliers', 'se2', 'insert', { id: 'se2', cpr_image: '' }),
    ch('orders', 'oe1', 'insert', { id: 'oe1', custom_product_spec: null }),
    ch('orders', 'oe2', 'insert', { id: 'oe2', custom_product_spec: JSON.stringify({ name: 'Ring' }) }),
    ch('orders', 'oe3', 'insert', { id: 'oe3', custom_product_spec: JSON.stringify({ name: 'Ring', images: [] }) }),
    ch('orders', 'oe4', 'insert', { id: 'oe4', custom_product_spec: '' }),
    ch('orders', 'oe5', 'insert', { id: 'oe5', custom_product_spec: JSON.stringify({ name: 'Ring', images: null }) }),
  ];
  const e = await pull.prepareRecordImages(empty, stored);
  ok(empty.every((c, i) => e.changes[i] === c) && e.rejected.size === 0 && calls === 0,
    'LEER gültige leere Felder (null, "", [], "[]", Entwurf ohne / mit leerer Fotoliste) bleiben unverändert, keine Ablehnung');

  calls = 0;
  DB.repairs['r-weird'] = { images: '{"legacy":true}' };
  DB.suppliers['s-weird'] = { cpr_image: 7 };
  DB.orders['o-weird'] = { custom_product_spec: 'Freitext-Entwurf ohne JSON' };
  const same = [
    ch('repairs', 'r-weird', 'update', { id: 'r-weird', images: '{"legacy":true}' }),
    ch('suppliers', 's-weird', 'update', { id: 's-weird', cpr_image: 7 }),
    ch('orders', 'o-weird', 'update', { id: 'o-weird', custom_product_spec: 'Freitext-Entwurf ohne JSON' }),
  ];
  const s = await pull.prepareRecordImages(same, stored);
  ok(same.every((c, i) => s.changes[i] === c) && s.rejected.size === 0 && calls === 0,
    'BESTAND ein unverändert zurückgespielter Altwert (auch in fremder Form) bleibt Byte für Byte, keine Ablehnung');
  const changedWeird = ch('repairs', 'r-weird', 'update', { id: 'r-weird', images: '{"legacy":false}' });
  const cw = await pull.prepareRecordImages([changedWeird], stored);
  ok(cw.rejected.get(changedWeird) === pull.RECORD_IMAGE_SHAPE_INVALID, 'BESTAND eine GEÄNDERTE ungültige Form in derselben Zeile → Quarantänefall');
}

rec.setRecordImageNormalizer(null);
if (fails.length) {
  console.log(`\nFAIL — r7b pp-12 pulled record images: ${PASS} passed, ${fails.length} failed`);
  process.exit(1);
}
console.log('POST_PARITY_PP12_PULLED_RECORD_IMAGES_PROVED');
console.log(`\nPASS — r7b pp-12 pulled record images: ${PASS} passed, 0 failed`);
