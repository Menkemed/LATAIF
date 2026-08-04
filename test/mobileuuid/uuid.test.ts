// ════════════════════════════════════════════════════════════════════════════
// MOBILE-UUID-I1 — the REAL upload-id generator on the served /mobile page is a CSPRNG UUID v4.
// Run: node test/mobileuuid/uuid.test.ts
//
// Extracts the verbatim `function uuid()` from src-tauri/src/sync/mobile_page.rs (the exact source that is
// concat!/include_str!-baked into MOBILE_HTML and wired as the queue's `genId`) and evaluates it under
// controlled crypto stubs. Proves: it delegates to crypto.randomUUID on secure origins; falls back to
// crypto.getRandomValues (valid v4, correct version/variant nibbles, unique) on a plain-HTTP LAN origin;
// NEVER uses Math.random; fails closed when no CSPRNG exists. Plus a source guard that no Math.random
// remains anywhere on the page and the queue is wired to this uuid.
// ════════════════════════════════════════════════════════════════════════════
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
let PASS = 0, FAIL = 0; const failures: string[] = [];
function ok(cond: unknown, msg: string): void { if (cond) PASS++; else { FAIL++; failures.push(msg); console.log(`  ✗ ${msg}`); } }

// ── extract the verbatim `function uuid() { … }` from mobile_page.rs (brace-matched) ─────────────
const pageSrc = readFileSync(join(repo, 'src-tauri/src/sync/mobile_page.rs'), 'utf8');
const start = pageSrc.indexOf('function uuid()');
ok(start >= 0, 'mobile_page.rs contains a function uuid()');
let depth = 0, end = -1, seenBrace = false;
for (let i = start; i < pageSrc.length; i++) {
  const ch = pageSrc[i];
  if (ch === '{') { depth++; seenBrace = true; }
  else if (ch === '}') { depth--; if (seenBrace && depth === 0) { end = i + 1; break; } }
}
const uuidSrc = pageSrc.slice(start, end);
ok(uuidSrc.length > 0 && /getRandomValues/.test(uuidSrc), 'extracted uuid() source references crypto.getRandomValues');

// ── source guards: no Math.random in the id function, none anywhere on the served page ───────────
ok(!/Math\.random/.test(uuidSrc), 'uuid() contains NO Math.random');
ok(!/Math\.random\s*\(/.test(pageSrc), 'the whole served mobile page makes NO Math.random() call');
ok(/randomUUID/.test(uuidSrc), 'uuid() prefers crypto.randomUUID');
ok(/genId:\s*uuid/.test(pageSrc), 'the durable upload queue is wired to this uuid() as genId');

// build a callable uuid() bound to a controllable `crypto` and `self` global.
function makeUuid(cryptoStub: unknown) {
  // eslint-disable-next-line no-new-func
  const factory = new Function('crypto', 'self', `${uuidSrc}; return uuid;`);
  return factory(cryptoStub, { crypto: cryptoStub }) as () => string;
}
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// ── §1 delegates to crypto.randomUUID when present (secure origin) ───────────────────────────────
{
  let called = 0;
  const stub = { randomUUID: () => { called++; return '11111111-2222-4333-8444-555555555555'; }, getRandomValues: () => { throw new Error('should not be used'); } };
  const u = makeUuid(stub);
  const v = u();
  ok(called === 1 && v === '11111111-2222-4333-8444-555555555555', 'uses crypto.randomUUID when available');
  ok(V4.test(v), 'randomUUID value is a valid v4 shape');
}

// ── §2 falls back to crypto.getRandomValues on a plain-HTTP LAN origin (no randomUUID) ───────────
{
  let filled = 0;
  const stub = { getRandomValues: (a: Uint8Array) => { filled++; return webcrypto.getRandomValues(a); } };
  const u = makeUuid(stub);
  const v = u();
  ok(filled === 1, 'uses crypto.getRandomValues when randomUUID is absent (HTTP LAN)');
  ok(V4.test(v), `getRandomValues fallback yields a valid UUID v4 (${v})`);
  ok(v[14] === '4', 'version nibble is 4');
  ok(['8', '9', 'a', 'b'].includes(v[19]), 'variant nibble is 8/9/a/b');
}

// ── §3 uniqueness across many calls (no collisions, not predictable Math.random) ─────────────────
{
  const stub = { getRandomValues: (a: Uint8Array) => webcrypto.getRandomValues(a) };
  const u = makeUuid(stub);
  const seen = new Set<string>();
  let allV4 = true;
  for (let i = 0; i < 2000; i++) { const v = u(); if (!V4.test(v)) allV4 = false; seen.add(v); }
  ok(allV4, 'all 2000 generated ids are valid v4');
  ok(seen.size === 2000, 'all 2000 generated ids are unique');
}

// ── §4 fails closed when NO CSPRNG exists (never a Math.random fallback) ──────────────────────────
{
  // neither crypto.randomUUID nor getRandomValues, and no self.crypto → must throw, not return a weak id.
  const u = makeUuid({});
  let threw = false; try { u(); } catch { threw = true; }
  ok(threw, 'uuid() fails closed (throws) when no secure RNG is available — no weak fallback');
}

console.log(`\nMOBILE-UUID-I1 uuid: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
