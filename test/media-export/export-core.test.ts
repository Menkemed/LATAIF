// MEDIA-CONSUMERS-EXPORT-I1 — pure export-image decode/mime contract.
// Drives the REAL dependency-free helpers from src/core/media/product-image-export-core.ts:
//   • extFromMime — only png/jpeg embeddable, everything else skipped (→ null)
//   • decodeImageDataUrl — legacy data-URL → bytes; missing/http/unsupported/corrupt → null
// The media-pipeline byte path (resolver+gateway) is proven by the runtime export smoke.
// Run: node test/media-export/export-core.test.ts
import { extFromMime, decodeImageDataUrl } from '../../src/core/media/product-image-export-core.ts';

let pass = 0; const fail: string[] = [];
const check = (c: unknown, m: string) => { if (c) pass++; else fail.push(m); };

// node base64 decoder (browser uses atob)
const dec = (b64: string): Uint8Array => new Uint8Array(Buffer.from(b64, 'base64'));

// ── extFromMime ───────────────────────────────────────────────────────────────
check(extFromMime('image/png') === 'png', 'png mime');
check(extFromMime('image/jpeg') === 'jpeg', 'jpeg mime');
check(extFromMime('image/jpg') === 'jpeg', 'jpg mime → jpeg');
check(extFromMime('IMAGE/PNG') === 'png', 'mime case-insensitive');
check(extFromMime('image/gif') === null, 'gif unsupported → null');
check(extFromMime('image/webp') === null, 'webp unsupported → null');
check(extFromMime('') === null, 'empty mime → null');

// ── decodeImageDataUrl ────────────────────────────────────────────────────────
// a tiny valid base64 payload ("AAECAw==" = bytes 0,1,2,3)
const pngUrl = 'data:image/png;base64,AAECAw==';
const jpgUrl = 'data:image/jpeg;base64,AAECAw==';
const okPng = decodeImageDataUrl(pngUrl, dec);
check(okPng !== null && okPng.extension === 'png', 'png data-url → decoded png');
check(okPng !== null && okPng.bytes.length === 4 && okPng.bytes[1] === 1, 'decoded bytes correct');
const okJpg = decodeImageDataUrl(jpgUrl, dec);
check(okJpg !== null && okJpg.extension === 'jpeg', 'jpeg data-url → decoded jpeg');
check(decodeImageDataUrl('data:image/jpg;base64,AAECAw==', dec)?.extension === 'jpeg', 'jpg data-url → jpeg');

// missing / non-embeddable → null (row kept, image skipped)
check(decodeImageDataUrl(undefined, dec) === null, 'undefined → null');
check(decodeImageDataUrl('', dec) === null, 'empty string → null');
check(decodeImageDataUrl('https://x/y.png', dec) === null, 'http url → null (not a data-url)');
check(decodeImageDataUrl('data:image/gif;base64,AAEC', dec) === null, 'unsupported mime data-url → null');
check(decodeImageDataUrl('data:text/plain;base64,AAEC', dec) === null, 'non-image data-url → null');
check(decodeImageDataUrl('data:image/png;base64,', dec) === null, 'empty payload → null');
// a decoder that throws must be swallowed → null (never aborts the export)
check(decodeImageDataUrl(pngUrl, () => { throw new Error('bad'); }) === null, 'throwing decoder → null (isolated)');
// a decoder that returns empty bytes → null
check(decodeImageDataUrl(pngUrl, () => new Uint8Array(0)) === null, 'empty bytes → null');

if (fail.length) { console.error('EXPORT-I1 export-core: FAILURES:'); for (const f of fail) console.error('  ✗ ' + f); process.exit(1); }
console.log(`EXPORT-I1 export-core: ${pass}/${pass} checks passed`);
