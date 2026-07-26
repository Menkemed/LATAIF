// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04A-3B2C4A (+R1) — durable mobile-upload inbox + exactly-once core.
// Run: node test/media04a3b2c4a/mobile-inbox.test.ts
//
// The InboxStore + staging are backed by REAL sql.js (a test-local durable table)
// and every crash is modeled by EXPORTing the DB and REOPENing a fresh Database
// with NO JS state — which proves ONLY that the state machine + persistence PORT
// are restart-capable (NOT productive acceptance / app path / updater-kill safety).
// A fake ProductCreatePort stands in for the durable createProductWithMedia
// contract (idempotent on the uploadEventKey). No base64 ever enters the record.
//
// R1 identity separation: entityId ≠ uploadEventId; retry key = tenant+event id;
// volatile receivedAt never affects identity; a missing uploadEventId is a typed
// activation block (the productive path has no real event id → activation blocked).
// ════════════════════════════════════════════════════════════════════════════

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import initSqlJs from 'sql.js';
import { createHash } from 'node:crypto';
import {
  acceptUpload, processInboxRecord, recoverInbox,
  validateUploadBatch, canonicalPayload, retryKey,
  MAX_UPLOAD_BATCH_IMAGES, MOBILE_INBOX_ACTIVATION,
  type InboxStore, type InboxRecord, type RawUploadSubmission,
  type ProductCreatePort, type UploadIdentity, type UploadManifest,
} from '../../src/core/media/mobile-inbox.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const WASM = join(repo, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');

let PASS = 0, FAIL = 0; const failures: string[] = [];
function ok(c: unknown, m: string): void { if (c) PASS++; else { FAIL++; failures.push(m); console.log(`  x ${m}`); } }

const sha = (b: Uint8Array) => createHash('sha256').update(Buffer.from(b)).digest('hex');
const shaStr = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(30);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  b[16] = (w >>> 24) & 0xff; b[17] = (w >>> 16) & 0xff; b[18] = (w >>> 8) & 0xff; b[19] = w & 0xff;
  b[20] = (h >>> 24) & 0xff; b[21] = (h >>> 16) & 0xff; b[22] = (h >>> 8) & 0xff; b[23] = h & 0xff;
  return b;
}
function jpeg(w: number, h: number, salt = 0): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, (h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff, 0x03, 0x00, 0x00, salt & 0xff]);
}

async function main(): Promise<void> {
  const SQL = await initSqlJs({ locateFile: () => WASM });

  function schema(db: InstanceType<typeof SQL.Database>): void {
    db.run(`CREATE TABLE IF NOT EXISTS mobile_upload_inbox (
      tenant_id TEXT NOT NULL, upload_event_id TEXT NOT NULL, state TEXT NOT NULL,
      record_json TEXT NOT NULL, PRIMARY KEY (tenant_id, upload_event_id))`);
    db.run(`CREATE TABLE IF NOT EXISTS mobile_stage (ref TEXT PRIMARY KEY, bytes BLOB NOT NULL)`);
    db.run(`CREATE TABLE IF NOT EXISTS mobile_create_ledger (upload_event_key TEXT NOT NULL, tenant_id TEXT NOT NULL, product_id TEXT NOT NULL, PRIMARY KEY (upload_event_key, tenant_id))`);
  }
  function makeStore(db: InstanceType<typeof SQL.Database>): InboxStore & { all(): InboxRecord[] } {
    return {
      get(tenantId, uploadEventId) {
        const r = db.exec('SELECT record_json FROM mobile_upload_inbox WHERE tenant_id=? AND upload_event_id=?', [tenantId, uploadEventId]);
        if (r.length === 0 || r[0].values.length === 0) return null;
        return JSON.parse(r[0].values[0][0] as string) as InboxRecord;
      },
      put(rec) {
        db.run('INSERT INTO mobile_upload_inbox (tenant_id, upload_event_id, state, record_json) VALUES (?,?,?,?) ' +
          'ON CONFLICT(tenant_id, upload_event_id) DO UPDATE SET state=excluded.state, record_json=excluded.record_json',
          [rec.identity.tenantId, rec.identity.uploadEventId, rec.state, JSON.stringify(rec)]);
      },
      all() {
        const r = db.exec('SELECT record_json FROM mobile_upload_inbox');
        if (r.length === 0) return [];
        return r[0].values.map((v) => JSON.parse(v[0] as string) as InboxRecord);
      },
    };
  }
  const deps = (db: InstanceType<typeof SQL.Database>) => ({
    hashBytes: sha, hashString: shaStr, now: () => '2026-07-26T00:00:00.000Z',
    stageBytes: (bytes: Uint8Array, _mime: string) => {
      const ref = 'stage/' + sha(bytes);
      db.run('INSERT OR IGNORE INTO mobile_stage (ref, bytes) VALUES (?,?)', [ref, bytes]);
      return ref;
    },
  });
  function makeCreate(db: InstanceType<typeof SQL.Database>, opts: { throwOnCreate?: boolean; reserveBeforeThrow?: boolean } = {}) {
    let createCalls = 0;
    return {
      calls: () => createCalls,
      port: {
        productExistsFor(uploadEventKey: string, tenantId: string) {
          const r = db.exec('SELECT product_id FROM mobile_create_ledger WHERE upload_event_key=? AND tenant_id=?', [uploadEventKey, tenantId]);
          return r.length && r[0].values.length ? (r[0].values[0][0] as string) : null;
        },
        createProductWithMedia({ uploadEventKey, identity }: { uploadEventKey: string; identity: UploadIdentity; manifest: UploadManifest }) {
          createCalls++;
          const ex = db.exec('SELECT product_id FROM mobile_create_ledger WHERE upload_event_key=? AND tenant_id=?', [uploadEventKey, identity.tenantId]);
          if (ex.length && ex[0].values.length) return { productId: ex[0].values[0][0] as string };
          const pid = 'prod-' + shaStr(uploadEventKey).slice(0, 12);
          if (opts.reserveBeforeThrow) db.run('INSERT INTO mobile_create_ledger (upload_event_key, tenant_id, product_id) VALUES (?,?,?)', [uploadEventKey, identity.tenantId, pid]);
          if (opts.throwOnCreate) throw new Error('MEDIA_CREATE_PARTIAL_PUBLISH');
          if (!opts.reserveBeforeThrow) db.run('INSERT INTO mobile_create_ledger (upload_event_key, tenant_id, product_id) VALUES (?,?,?)', [uploadEventKey, identity.tenantId, pid]);
          return { productId: pid };
        },
      } as ProductCreatePort,
    };
  }
  const productCount = (db: InstanceType<typeof SQL.Database>) => {
    const r = db.exec('SELECT COUNT(*) FROM mobile_create_ledger'); return r.length ? (r[0].values[0][0] as number) : 0;
  };
  const reopen = (db: InstanceType<typeof SQL.Database>) => new SQL.Database(db.export());

  function sub(over: Partial<RawUploadSubmission> = {}, images = [jpeg(800, 600)]): RawUploadSubmission {
    return {
      identity: { tenantId: 'T1', branchId: 'B1', entityId: null, uploadEventId: 'E1', clientProtocolVersion: 'mobile-upload/1', targetOp: 'create_product', ...(over.identity as object) },
      product: over.product ?? { brand: 'Rolex', categoryId: 'cat-watch' },
      images: over.images ?? images.map((b) => ({ declaredMime: 'image/jpeg', bytes: b })),
    };
  }

  // ── activation boundary (R1) ────────────────────────────────────────────────
  ok(MOBILE_INBOX_ACTIVATION.activatable === false && MOBILE_INBOX_ACTIVATION.blockedReasons.includes('NO_STABLE_UPLOAD_EVENT_ID_IN_SYNC_PUSH_DTO'), 'productive activation is blocked (no real upload event id)');
  ok(MOBILE_INBOX_ACTIVATION.blockedReasons.includes('M6_SECOND_WRITER_CAS_NOT_RELEASED'), 'M6 second-writer dependency recorded in activation block');

  // ── R1: missing uploadEventId → typed activation block, no accept ───────────
  {
    const db = new SQL.Database(); schema(db);
    const out = acceptUpload(makeStore(db), sub({ identity: { tenantId: 'T1', branchId: 'B1', entityId: 'prod-X', uploadEventId: undefined, clientProtocolVersion: 'mobile-upload/1', targetOp: 'create_product' } as unknown as UploadIdentity }), deps(db));
    ok(!out.ok && out.state === 'quarantined' && out.errorCode === 'MEDIA_INBOX_ACTIVATION_BLOCKED_NO_EVENT_ID', 'missing uploadEventId → typed activation block');
    db.close();
  }

  // ── R1: retry key uses uploadEventId, NOT entityId; receivedAt excluded ──────
  ok(retryKey({ tenantId: 'T', branchId: 'B', uploadEventId: 'E' }) === '["T","B","E"]', 'retry key = tenant+branch+uploadEventId');
  ok(retryKey({ tenantId: 'T', branchId: 'B', uploadEventId: 'E1' }) !== retryKey({ tenantId: 'T', branchId: 'B', uploadEventId: 'E2' }), 'different event id → different retry key');
  {
    // productId/entityId ≠ event id: same product entity id under two event ids.
    const db = new SQL.Database(); schema(db); const store = makeStore(db); const c = makeCreate(db);
    const s1 = sub({ identity: { tenantId: 'T1', branchId: 'B1', entityId: 'prod-SAME', uploadEventId: 'EV-1', clientProtocolVersion: 'mobile-upload/1', targetOp: 'create_product' } as UploadIdentity });
    const s2 = sub({ identity: { tenantId: 'T1', branchId: 'B1', entityId: 'prod-SAME', uploadEventId: 'EV-2', clientProtocolVersion: 'mobile-upload/1', targetOp: 'create_product' } as UploadIdentity }, [jpeg(640, 480, 9)]);
    const a1 = acceptUpload(store, s1, deps(db));
    const a2 = acceptUpload(store, s2, deps(db));
    ok(a1.ok && a2.ok && a1.state === 'accepted' && a2.state === 'accepted', 'same entityId + NEW uploadEventId → separate legitimate ops (not a conflict)');
    ok(store.get('T1', 'EV-1')!.identity.entityId === 'prod-SAME' && store.get('T1', 'EV-1')!.identity.uploadEventId === 'EV-1', 'entityId and uploadEventId stored as distinct fields');
    db.close();
  }
  {
    // receivedAt (volatile) must NOT change retry identity or payload hash.
    const db = new SQL.Database(); schema(db); const store = makeStore(db);
    const first = acceptUpload(store, sub({ identity: { tenantId: 'T1', branchId: 'B1', entityId: null, uploadEventId: 'EV-T', clientProtocolVersion: 'mobile-upload/1', receivedAt: '2020-01-01T00:00:00Z', targetOp: 'create_product' } as UploadIdentity }), deps(db));
    const retry = acceptUpload(store, sub({ identity: { tenantId: 'T1', branchId: 'B1', entityId: null, uploadEventId: 'EV-T', clientProtocolVersion: 'mobile-upload/1', receivedAt: '2099-12-31T23:59:59Z', targetOp: 'create_product' } as UploadIdentity }), deps(db));
    ok(first.ok && retry.ok && retry.state === 'accepted' && retry.record.identity.payloadHash === first.record.identity.payloadHash, 'different receivedAt on retry → same payload hash + idempotent (no conflict)');
    ok(retry.record.identity.receivedAt === first.record.identity.receivedAt, 'first receivedAt preserved (retry does not overwrite the durable record)');
    db.close();
  }

  // ── validation gate ──────────────────────────────────────────────────────────
  ok(!validateUploadBatch([], sha).ok, 'empty batch → reject');
  ok(!validateUploadBatch(Array.from({ length: MAX_UPLOAD_BATCH_IMAGES + 1 }, () => ({ declaredMime: 'image/jpeg', bytes: jpeg(10, 10) })), sha).ok, 'over image-count cap → reject');
  ok(!validateUploadBatch([{ declaredMime: 'image/png', bytes: jpeg(10, 10) }], sha).ok, 'declared PNG but JPEG magic → mismatch reject');
  ok(!validateUploadBatch([{ declaredMime: 'image/gif', bytes: new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0]) }], sha).ok, 'GIF magic → unsupported reject');
  ok(!validateUploadBatch([{ declaredMime: 'image/png', bytes: png(8192, 8192) }], sha).ok, '8192² over pixel budget → reject');
  ok(validateUploadBatch([{ declaredMime: 'image/jpeg', bytes: jpeg(800, 600) }], sha).ok, 'valid JPEG within budget → ok');

  // ── durable accept + PERSISTENCE-PORT reopen (NOT productive acceptance) ─────
  {
    const db = new SQL.Database(); schema(db);
    const out = acceptUpload(makeStore(db), sub(), deps(db));
    ok(out.ok && out.state === 'accepted', 'valid upload → accepted (persistence-port level)');
    const db2 = reopen(db); const store2 = makeStore(db2);
    const rec = store2.get('T1', 'E1');
    ok(!!rec && rec.state === 'accepted' && rec.manifest.images.length === 1, 'accepted record survives persistence-port reopen (state machine restart-capable)');
    ok(!!rec && !!rec.manifest.images[0].stagingRef && !('bytes' in (rec.manifest.images[0] as object)), 'manifest holds staging ref + hash, NOT bytes');
    db.close(); db2.close();
  }

  // ── crash right after ACCEPTED → recovery creates exactly one product ────────
  {
    const db = new SQL.Database(); schema(db);
    acceptUpload(makeStore(db), sub(), deps(db));
    const db2 = reopen(db); const store2 = makeStore(db2); const c = makeCreate(db2);
    ok(productCount(db2) === 0, 'no product before recovery');
    const recovered = recoverInbox(store2, c.port, store2.all());
    ok(recovered.length === 1 && recovered[0].state === 'ready' && !!recovered[0].productId, 'recovery drives accepted → ready');
    ok(productCount(db2) === 1 && c.calls() === 1, 'exactly one product created on recovery');
    const db3 = reopen(db2); const store3 = makeStore(db3); const c3 = makeCreate(db3);
    recoverInbox(store3, c3.port, store3.all());
    ok(productCount(db3) === 1 && c3.calls() === 0, 're-recovery is a no-op (still exactly one product)');
    db.close(); db2.close(); db3.close();
  }

  // ── crash after PARTIAL media publish → existing create-recovery converges ───
  {
    const db = new SQL.Database(); schema(db);
    const store = makeStore(db); acceptUpload(store, sub(), deps(db));
    const cPartial = makeCreate(db, { throwOnCreate: true, reserveBeforeThrow: true });
    let threw = false;
    try { processInboxRecord(store, cPartial.port, store.get('T1', 'E1')!); } catch { threw = true; }
    ok(threw && productCount(db) === 1, 'partial publish threw but reserved exactly one product id');
    const db2 = reopen(db); const store2 = makeStore(db2); const c2 = makeCreate(db2);
    const rec = recoverInbox(store2, c2.port, store2.all())[0];
    ok(rec.state === 'ready' && c2.calls() === 0 && productCount(db2) === 1, 'recovery binds the reserved product (no 2nd product, no 2nd create call)');
    db.close(); db2.close();
  }

  // ── crash after product-save, before ready → recovery binds, no re-create ────
  {
    const db = new SQL.Database(); schema(db);
    const store = makeStore(db); acceptUpload(store, sub(), deps(db));
    const rec = store.get('T1', 'E1')!;
    db.run('INSERT INTO mobile_create_ledger (upload_event_key, tenant_id, product_id) VALUES (?,?,?)', ['E1', 'T1', 'prod-preexisting']);
    store.put({ ...rec, state: 'processing' });
    const db2 = reopen(db); const store2 = makeStore(db2); const c2 = makeCreate(db2);
    const out = recoverInbox(store2, c2.port, store2.all())[0];
    ok(out.state === 'ready' && out.productId === 'prod-preexisting' && c2.calls() === 0, 'existing product detected → ready without a second create');
    db.close(); db2.close();
  }

  // ── same event id + same payload → idempotent (one product) ─────────────────
  {
    const db = new SQL.Database(); schema(db);
    const store = makeStore(db); const c = makeCreate(db);
    acceptUpload(store, sub(), deps(db));
    processInboxRecord(store, c.port, store.get('T1', 'E1')!);
    const again = acceptUpload(store, sub(), deps(db));
    ok(again.ok && again.state === 'ready' && productCount(db) === 1 && c.calls() === 1, 'retry same event id+payload → same ready result, no 2nd product');
    db.close();
  }

  // ── same event id + different payload → conflict ────────────────────────────
  {
    const db = new SQL.Database(); schema(db);
    const store = makeStore(db); acceptUpload(store, sub(), deps(db));
    const diff = acceptUpload(store, sub({ product: { brand: 'Omega', categoryId: 'cat-watch' } }), deps(db));
    ok(!diff.ok && diff.state === 'conflict', 'same event id + different payload → typed conflict');
    db.close();
  }

  // ── two different event ids, IDENTICAL image → two valid jobs (no dedup) ─────
  {
    const db = new SQL.Database(); schema(db);
    const store = makeStore(db); const c = makeCreate(db);
    const img = jpeg(400, 300);
    acceptUpload(store, sub({ identity: { tenantId: 'T1', branchId: 'B1', entityId: null, uploadEventId: 'A', clientProtocolVersion: 'mobile-upload/1', targetOp: 'create_product' } as UploadIdentity, images: [{ declaredMime: 'image/jpeg', bytes: img }] }), deps(db));
    acceptUpload(store, sub({ identity: { tenantId: 'T1', branchId: 'B1', entityId: null, uploadEventId: 'B', clientProtocolVersion: 'mobile-upload/1', targetOp: 'create_product' } as UploadIdentity, images: [{ declaredMime: 'image/jpeg', bytes: img }] }), deps(db));
    processInboxRecord(store, c.port, store.get('T1', 'A')!);
    processInboxRecord(store, c.port, store.get('T1', 'B')!);
    ok(productCount(db) === 2, 'two event ids with identical image → two products (intentional duplicates allowed)');
    db.close();
  }

  // ── multiple images → order + primary stable ────────────────────────────────
  {
    const db = new SQL.Database(); schema(db);
    const store = makeStore(db);
    const imgs = [jpeg(100, 100, 1), jpeg(100, 100, 2), jpeg(100, 100, 3)];
    acceptUpload(store, sub({ images: imgs.map((b) => ({ declaredMime: 'image/jpeg', bytes: b })) }), deps(db));
    const rec = store.get('T1', 'E1')!;
    ok(rec.manifest.images.map((i) => i.index).join(',') === '0,1,2', 'image order preserved 0..N-1 (primary@0)');
    ok(rec.manifest.images[0].bytesHash === sha(imgs[0]), 'primary hash = first image');
    db.close();
  }

  // ── wrong tenant/branch → no access / fail closed ───────────────────────────
  {
    const db = new SQL.Database(); schema(db);
    const store = makeStore(db); acceptUpload(store, sub(), deps(db));
    ok(store.get('T2', 'E1') === null, 'wrong tenant → record not visible');
    const noScope = acceptUpload(store, sub({ identity: { tenantId: 'T1', branchId: '', entityId: null, uploadEventId: 'X', clientProtocolVersion: 'mobile-upload/1', targetOp: 'create_product' } as UploadIdentity }), deps(db));
    ok(!noScope.ok && noScope.state === 'quarantined', 'missing branch scope → quarantined (fail closed)');
    db.close();
  }

  // ── invalid inputs → no accept ──────────────────────────────────────────────
  {
    const db = new SQL.Database(); schema(db); const store = makeStore(db); const d = deps(db);
    ok(!acceptUpload(store, sub({ images: [{ declaredMime: 'image/png', bytes: png(8192, 8192) }] }), d).ok, 'over pixel budget → not accepted');
    ok(!acceptUpload(store, sub({ identity: { tenantId: 'T1', branchId: 'B1', entityId: null, uploadEventId: 'P', clientProtocolVersion: 'bogus/9', targetOp: 'create_product' } as UploadIdentity }), d).ok, 'unknown protocol → not accepted (not silently interpreted)');
    ok(!acceptUpload(store, sub({ images: [{ declaredMime: 'image/svg+xml', bytes: new TextEncoder().encode('<svg/>') }] }), d).ok, 'SVG/active content → not accepted');
    db.close();
  }

  // ── partial upload (receiving) → recovery quarantines, no product ───────────
  {
    const db = new SQL.Database(); schema(db); const store = makeStore(db);
    const partial: InboxRecord = { identity: { tenantId: 'T1', branchId: 'B1', entityId: null, uploadEventId: 'PART', clientProtocolVersion: 'mobile-upload/1', payloadHash: 'x', receivedAt: 'now', targetOp: 'create_product' }, manifest: { images: [], product: {} }, state: 'receiving' };
    store.put(partial);
    const db2 = reopen(db); const store2 = makeStore(db2); const c = makeCreate(db2);
    const out = recoverInbox(store2, c.port, store2.all())[0];
    ok(out.state === 'quarantined' && c.calls() === 0 && productCount(db2) === 0, 'receiving (partial) → quarantined, no processable job');
    db.close(); db2.close();
  }

  // ── no base64 in SQLite (inbox row) ─────────────────────────────────────────
  {
    const db = new SQL.Database(); schema(db);
    acceptUpload(makeStore(db), sub({ images: [{ declaredMime: 'image/jpeg', bytes: jpeg(640, 480) }] }), deps(db));
    const raw = db.exec('SELECT record_json FROM mobile_upload_inbox')[0].values[0][0] as string;
    const b64 = Buffer.from(jpeg(640, 480)).toString('base64');
    ok(!raw.includes(b64) && !raw.includes('data:image'), 'inbox record JSON contains no base64 / data URL');
    db.close();
  }

  // ── startup-recovery precedes new processing ────────────────────────────────
  {
    const db = new SQL.Database(); schema(db);
    const store = makeStore(db); acceptUpload(store, sub(), deps(db));
    const db2 = reopen(db); const store2 = makeStore(db2); const c = makeCreate(db2);
    recoverInbox(store2, c.port, store2.all());
    ok(store2.get('T1', 'E1')!.state === 'ready', 'startup recovery converged the old job before new uploads');
    const fresh = acceptUpload(store2, sub({ identity: { tenantId: 'T1', branchId: 'B1', entityId: null, uploadEventId: 'NEW', clientProtocolVersion: 'mobile-upload/1', targetOp: 'create_product' } as UploadIdentity }), deps(db2));
    ok(fresh.ok && fresh.state === 'accepted', 'new upload accepted after recovery');
    db.close(); db2.close();
  }

  // canonicalPayload determinism (retry → same hash) + volatile exclusion
  ok(canonicalPayload('mobile-upload/1', { b: 2, a: 1 }, ['h1', 'h2']) === canonicalPayload('mobile-upload/1', { a: 1, b: 2 }, ['h1', 'h2']), 'canonical payload is key-order stable (retry idempotent)');
  ok(canonicalPayload('mobile-upload/1', { a: 1 }, ['h1', 'h2']) !== canonicalPayload('mobile-upload/1', { a: 1 }, ['h2', 'h1']), 'image order change → different payload hash');

  console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — ${PASS} passed, ${FAIL} failed`);
  if (FAIL > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
