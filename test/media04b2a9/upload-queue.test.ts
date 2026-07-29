// ════════════════════════════════════════════════════════════════════════════
// MOBILE-04B2A9-I1 — durable collection upload queue (pure logic + contract)
// Run: node test/media04b2a9/upload-queue.test.ts
//
// Evaluates the REAL browser module (mobile_upload_queue.js, included verbatim into MOBILE_HTML) in a
// sandbox with an in-memory store + a fake fetch, and proves: ids are minted once and stable across
// retry/reload, exactly one send per entry, the full /api/mobile/upload result contract, no deletion on
// an unknown result, stale `sending` recovery, and drain-stops-on-reauth. Plus a structural check that
// mobile_page.rs wires the collection uploader to /api/mobile/upload while repair/purchase stay on /sync/push.
// ════════════════════════════════════════════════════════════════════════════

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
let PASS = 0, FAIL = 0; const failures: string[] = [];
function ok(cond: unknown, msg: string): void { if (cond) PASS++; else { FAIL++; failures.push(msg); console.log(`  ✗ ${msg}`); } }

// ── load the real module into a sandbox global ───────────────────────────────
const src = readFileSync(join(repo, 'src-tauri/src/sync/mobile_upload_queue.js'), 'utf8');
const sandbox: any = {};
// eslint-disable-next-line no-new-func
new Function('self', src)(sandbox);
const Q = sandbox.MobileUploadQueue;

// deterministic id generator + an in-memory store (a faithful stand-in for the IndexedDB adapter).
function makeGen() { let n = 0; return () => `id-${++n}`; }
function makeStore() {
  const m = new Map<string, any>();
  return {
    _m: m,
    async get(id: string) { const e = m.get(id); return e ? JSON.parse(JSON.stringify(e)) : undefined; },
    async put(e: any) { m.set(e.uploadEventId, JSON.parse(JSON.stringify(e))); },
    async delete(id: string) { m.delete(id); },
    async getAll() { return [...m.values()].map((e) => JSON.parse(JSON.stringify(e))); },
  };
}
const NOW = () => '2026-07-29T00:00:00Z';

// ── §1 pure helpers ──────────────────────────────────────────────────────────
{
  ok(Q.stripDataUrl('data:image/jpeg;base64,AAAB') === 'AAAB', 'stripDataUrl removes the data-url prefix');
  ok(Q.stripDataUrl('RAWBASE64') === 'RAWBASE64', 'stripDataUrl leaves raw base64 untouched');
  for (const [s, exp] of [[201, 'done'], [200, 'done'], [409, 'conflict'], [401, 'reauth'], [403, 'reauth'], [413, 'rejected'], [422, 'rejected'], [503, 'retryable'], [0, 'retryable'], [500, 'retryable'], [999, 'retryable']] as [number, string][]) {
    ok(Q.classify(s) === exp, `classify(${s}) → ${exp}`);
  }
  const req = Q.buildRequest({ uploadEventId: 'ev', entityId: 'ent', metadata: { brand: 'Rolex' }, images: ['data:image/jpeg;base64,ZZ'] });
  ok(req.protocol_version === 1 && req.mode === 'collection' && req.upload_event_id === 'ev' && req.entity_id === 'ent', 'buildRequest maps protocol/mode/ids');
  ok(req.images.length === 1 && req.images[0].mime === 'image/jpeg' && req.images[0].data_base64 === 'ZZ', 'buildRequest strips the data-url in images');
  ok(req.metadata.brand === 'Rolex', 'buildRequest carries the validated metadata object');
}

// ── §2 enqueue persists BEFORE any send, with distinct minted ids ────────────
{
  const store = makeStore();
  const q = Q.createQueue({ store, fetchFn: async () => ({ status: 201 }), genId: makeGen(), now: NOW });
  await (async () => {
    const entry = await q.enqueue({ metadata: { brand: 'Rolex' }, images: ['data:image/jpeg;base64,AA'] });
    ok(entry.state === 'queued', 'enqueue → state queued');
    ok(entry.uploadEventId === 'id-1' && entry.entityId === 'id-2' && entry.uploadEventId !== entry.entityId, 'enqueue mints distinct uploadEventId + entityId');
    ok(store._m.has('id-1'), 'entry is persisted before any request');
    ok(store._m.get('id-1').images[0].startsWith('data:'), 'image bytes live in the store (not localStorage)');
  })();
}

// ── §3 stable ids across retry/reload; success deletes ───────────────────────
await (async () => {
  const store = makeStore();
  const bodies: any[] = [];
  let statuses = [503, 503, 201];
  const fetchFn = async (_url: string, opts: any) => { bodies.push(JSON.parse(opts.body)); return { status: statuses.shift() ?? 500 }; };
  const q = Q.createQueue({ store, fetchFn, genId: makeGen(), now: NOW });
  const e = await q.enqueue({ metadata: { brand: 'A' }, images: ['data:image/jpeg;base64,AA'] });
  const id = e.uploadEventId;
  let r = await q.drainEntry(id, 'tok'); ok(r.outcome === 'retryable', '503 → retryable');
  ok(store._m.get(id).state === 'retryable', 'entry kept as retryable after 503');
  // simulate a reload: stale-sending recovery is a no-op here (state is retryable), ids unchanged.
  await q.recoverStaleSending();
  r = await q.drainEntry(id, 'tok'); ok(r.outcome === 'retryable', 'second 503 → still retryable');
  r = await q.drainEntry(id, 'tok'); ok(r.outcome === 'done', 'finally 201 → done');
  ok(!store._m.has(id), 'success (201) deletes the durable entry');
  ok(bodies.every((b) => b.upload_event_id === id), 'the SAME upload_event_id is used on every retry (never a new id)');
  ok(bodies.length === 3, 'exactly one send per drainEntry call — no internal retry loop');
})();

// ── §4 result contract: replay/conflict/rejected/reauth/network/unknown ──────
async function outcomeFor(status: number) {
  const store = makeStore();
  const q = Q.createQueue({ store, fetchFn: async () => (status === -1 ? Promise.reject(new Error('net')) : { status }), genId: makeGen(), now: NOW });
  const e = await q.enqueue({ metadata: { brand: 'A' }, images: ['x'] });
  const r = await q.drainEntry(e.uploadEventId, 'tok');
  return { r, kept: store._m.has(e.uploadEventId), state: store._m.get(e.uploadEventId)?.state };
}
{
  const replay = await outcomeFor(200); ok(replay.r.outcome === 'done' && !replay.kept, 'replay-200 → done, entry deleted');
  const conflict = await outcomeFor(409); ok(conflict.r.outcome === 'conflict' && conflict.kept && conflict.state === 'conflict', '409 → permanent conflict, kept');
  const rej413 = await outcomeFor(413); ok(rej413.r.outcome === 'rejected' && rej413.kept && rej413.state === 'rejected', '413 → rejected, kept');
  const rej422 = await outcomeFor(422); ok(rej422.r.outcome === 'rejected' && rej422.kept && rej422.state === 'rejected', '422 → rejected, kept');
  const un401 = await outcomeFor(401); ok(un401.r.outcome === 'reauth' && un401.kept && un401.state === 'retryable', '401 → reauth, kept + retryable');
  const un403 = await outcomeFor(403); ok(un403.r.outcome === 'reauth' && un403.kept, '403 → reauth, kept');
  const net = await outcomeFor(-1); ok(net.r.outcome === 'retryable' && net.kept, 'network error → retryable, kept');
  const unknown = await outcomeFor(500); ok(unknown.r.outcome === 'retryable' && unknown.kept && unknown.state === 'retryable', 'unknown 500 → retryable, NEVER deleted');
}

// ── §5 single-flight (double-click / parallel drain) ─────────────────────────
await (async () => {
  const store = makeStore();
  let calls = 0;
  const fetchFn = async () => { calls++; await new Promise((r) => setTimeout(r, 30)); return { status: 201 }; };
  const q = Q.createQueue({ store, fetchFn, genId: makeGen(), now: NOW });
  const e = await q.enqueue({ metadata: { brand: 'A' }, images: ['x'] });
  const [a, b] = await Promise.all([q.drainEntry(e.uploadEventId, 't'), q.drainEntry(e.uploadEventId, 't')]);
  ok(calls === 1, 'parallel drain of the same entry → exactly ONE send (single-flight)');
  ok([a.outcome, b.outcome].includes('busy') || [a.outcome, b.outcome].filter((o) => o === 'done').length === 1, 'the second concurrent drain does not create a second event');
})();

// ── §6 stale `sending` recovery on restart ───────────────────────────────────
await (async () => {
  const store = makeStore();
  const q = Q.createQueue({ store, fetchFn: async () => ({ status: 201 }), genId: makeGen(), now: NOW });
  const e = await q.enqueue({ metadata: { brand: 'A' }, images: ['x'] });
  const raw = store._m.get(e.uploadEventId); raw.state = 'sending'; store._m.set(e.uploadEventId, raw); // crash mid-send
  await q.recoverStaleSending();
  ok(store._m.get(e.uploadEventId).state === 'retryable', 'a stale `sending` recovers to retryable after restart');
  ok(store._m.get(e.uploadEventId).uploadEventId === e.uploadEventId, 'recovery keeps the same id');
})();

// ── §7 drainAll stops on reauth; pending counts non-terminal ─────────────────
await (async () => {
  const store = makeStore();
  const gen = makeGen();
  const q = Q.createQueue({ store, fetchFn: async () => ({ status: 401 }), genId: gen, now: NOW });
  await q.enqueue({ metadata: {}, images: ['x'] });
  await q.enqueue({ metadata: {}, images: ['y'] });
  const res = await q.drainAll('tok');
  ok(res.length === 1 && res[0].outcome === 'reauth', 'drainAll stops at the first reauth (no hammering)');
  ok((await q.pending()) === 2, 'both entries still pending after reauth');
})();

// ── §8 structural: mobile_page wires collection→/api/mobile/upload; repair/purchase unchanged ──
{
  const page = readFileSync(join(repo, 'src-tauri/src/sync/mobile_page.rs'), 'utf8');
  ok(/include_str!\("mobile_upload_queue\.js"\)/.test(page), 'the queue module is included into MOBILE_HTML');
  ok(/\/api\/mobile\/upload/.test(page), 'the page references /api/mobile/upload');
  ok(/MobileUploadQueue/.test(page), 'the collection handler uses the durable queue');
  // repair + purchase submit handlers still push their records via /sync/push (unchanged path). Anchor on
  // the ONCLICK handler (not the earlier HTML button id) and read to the end of that handler.
  const repair = page.slice(page.indexOf("rSaveBtn').onclick"), page.indexOf("bSaveBtn').onclick"));
  const purchase = page.slice(page.indexOf("bSaveBtn').onclick"), page.indexOf("bSaveBtn').onclick") + 2000);
  ok(/pushChanges\(/.test(repair) && /repairs/.test(repair), 'repair still uses pushChanges (/sync/push) — unchanged');
  ok(/pushChanges\(/.test(purchase) && /purchase_inbox/.test(purchase), 'purchase still uses pushChanges (/sync/push) — unchanged');
  // the collection handler must NOT push a products record anymore (it goes through the queue).
  const collection = page.slice(page.indexOf("cSaveBtn').onclick"), page.indexOf("rSaveBtn').onclick"));
  ok(/uploadQueue\.(enqueue|drainEntry)/.test(collection) && !/pushChanges\(/.test(collection), 'collection handler uses the queue, not pushChanges');
}

console.log(`\nMOBILE-04B2A9-I1 upload-queue: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
