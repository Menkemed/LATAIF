// ════════════════════════════════════════════════════════════════════════════
// MOBILE-QUEUE — Zurueckstellen mit Wartezeit statt sofortiger Wiederholung (Desktop-Drain)
// Run: node test/mobile-edit-queue/retry-backoff.test.ts
//
// Die AUSWAHL (Wartezeit, Reihenfolge je Artikel) liegt im Server und ist dort getestet
// (`mobile_upload_tests.rs`). Hier geht es um den Drain: Welche Pannen stellt er ZURUECK (mit Code),
// welche gibt er nur neutral zurueck, und macht derselbe Lauf mit dem naechsten berechtigten Auftrag
// weiter? Die Inbox unten bildet den Server-Vertrag nach: aeltester BERECHTIGTER Auftrag zuerst, ein
// wartender oder laufender Auftrag haelt seinen Artikel.
// ════════════════════════════════════════════════════════════════════════════

import {
  drainMobileUploads, createTauriMobileUploadBridge,
  type ClaimGrant, type ClaimedImage, type DrainScope, type MobileDrainDeps,
  type MobileUploadBridge, type PreparedMediaItem, type ReadyResult,
} from '../../src/core/media/mobile-upload-drain.ts';
import { readFileSync } from 'node:fs';

const TENANT = 'tenant-1', BRANCH = 'branch-1', USER = 'user-1';
let PASS = 0, FAIL = 0;
const failures: string[] = [];
function ok(cond: unknown, msg: string): void { if (cond) PASS++; else { FAIL++; failures.push(msg); console.log(`  ✗ ${msg}`); } }

type State = 'accepted' | 'processing' | 'ready' | 'quarantined';
interface Row { ev: string; product: string; metadataJson: string; images: ClaimedImage[]; state: State; code: string | null; token: string | null;
  claims: number; attempts: number; nextAt: number; lastError: string | null }
const BACKOFF = [30, 60, 120, 300, 900, 1800];

class Inbox implements MobileUploadBridge {
  rows: Row[] = []; now = 0; releases = 0; defers: Array<{ ev: string; code: string }> = [];
  private seq = 0;
  add(ev: string, product: string, metadata: unknown, images: ClaimedImage[] = []): Row {
    const r: Row = { ev, product, metadataJson: JSON.stringify(metadata), images, state: 'accepted', code: null, token: null, claims: 0, attempts: 0, nextAt: 0, lastError: null };
    this.rows.push(r); return r;
  }
  private held(ev: string, t: string): Row | null { const r = this.rows.find((x) => x.ev === ev); return r && r.state === 'processing' && r.token === t ? r : null; }
  async claim(claimantInstanceId: string): Promise<ClaimGrant | null> {
    const busy = new Set<string>();
    for (const r of this.rows) {
      if (r.state !== 'accepted' && r.state !== 'processing') continue;
      if (busy.has(r.product)) continue;
      if (r.state === 'accepted' && r.nextAt <= this.now) {
        r.state = 'processing'; r.token = `claim-${++this.seq}`; r.claims++;
        return { tenantId: TENANT, branchId: BRANCH, authenticatedUserId: USER, uploadEventId: r.ev, entityId: r.product, payloadHash: 'p'.repeat(64),
          mode: 'collection', metadataJson: r.metadataJson, claimToken: r.token, claimantInstanceId, leaseUntil: 'x', images: r.images };
      }
      busy.add(r.product);
    }
    return null;
  }
  async release(_u: string, ev: string, t: string): Promise<boolean> { const r = this.held(ev, t); if (!r) return false; this.releases++; r.state = 'accepted'; r.token = null; return true; }
  async defer(_u: string, ev: string, t: string, code: string): Promise<boolean> {
    const r = this.held(ev, t); if (!r) return false;
    r.state = 'accepted'; r.token = null; r.attempts++; r.lastError = code;
    r.nextAt = this.now + BACKOFF[Math.min(r.attempts, BACKOFF.length) - 1];
    this.defers.push({ ev, code }); return true;
  }
  async markQuarantined(_u: string, ev: string, t: string, code: string): Promise<boolean> { const r = this.held(ev, t); if (!r) return false; r.state = 'quarantined'; r.code = code; r.token = null; return true; }
  async markReady(_u: string, ev: string, t: string): Promise<ReadyResult> { const r = this.held(ev, t); if (!r) return 'rejected'; r.state = 'ready'; r.token = null; return 'marked_ready'; }
  async prepareImage(): Promise<never> { throw new Error('not used'); }
  async renew(): Promise<boolean> { return true; }
}

const img = (slot: number): ClaimedImage => ({ slot, primary: slot === 0, mime: 'image/jpeg', width: 800, height: 600, byteSize: 1000, contentHash: 'a'.repeat(64), storageKey: 'k' });
const HEX = 'd'.repeat(64);
const textEdit = (product: string) => ({ kind: 'text_edit', productId: product, patch: { notes: 'x' } });
const galleryEdit = (product: string) => ({ kind: 'gallery_edit', productId: product, galleryBaseline: HEX, order: [{ new: 0 }], remove: [] });

function depsFor(inbox: Inbox, over: Partial<MobileDrainDeps> = {}): MobileDrainDeps {
  return {
    bridge: inbox, claimantInstanceId: 'instance-1',
    readScopeEvidence: async () => ({ tenantId: TENANT, branchId: BRANCH, serverInstanceId: 'srv-1', bindingRevision: 7, configured: true }),
    currentScope: () => ({ tenantId: TENANT, branchId: BRANCH }),
    readReceipt: () => null, productExists: () => true,
    readProductMetadataHash: async () => null, readBoundBatch: async () => [], readGalleryManifest: async () => [],
    readSideEffectCounts: async () => ({ changelog: 0, audit: 0 }), deriveCreateBatchId: () => 'batch-1',
    preparePreparedMedia: async (g): Promise<PreparedMediaItem[]> => g.images.map((i) => ({ slot: i.slot, ingestRequestId: `r-${g.uploadEventId}`, prepared: {} as never })),
    createProduct: async () => { throw new Error('no create here'); },
    verifyReady: async () => 'ready',
    applyTextEdit: async () => ({ ok: true }),
    applyGalleryEdit: async () => ({ ok: true }),
    galleryEditApplied: () => false,
    readProductState: () => ({ categoryId: 'cat-x', attributes: {}, scopeOfDelivery: [] }),
    fieldSchema: () => ({ version: 1, categories: [{ id: 'cat-x', name: 'X', brandRequired: false, conditionOptions: [], scopeOptions: [], attributes: [] }] }),
    priceEditAllowed: () => true,
    ...over,
  };
}

async function main(): Promise<void> {
  // ── 1 Wiederholbare Panne von A: zurueckgestellt; B laeuft im SELBEN Lauf; A2 bleibt hinter A ──
  {
    const inbox = new Inbox();
    const a = inbox.add('ev-A', 'prod-A', galleryEdit('prod-A'), [img(0)]);
    const a2 = inbox.add('ev-A2', 'prod-A', textEdit('prod-A'));
    const b = inbox.add('ev-B', 'prod-B', textEdit('prod-B'));
    let calls = 0;
    const deps = depsFor(inbox, { applyGalleryEdit: async () => { calls++; return calls === 1 ? { ok: false, errorCode: 'database is locked' } : { ok: true }; } });
    await drainMobileUploads(deps, 25);
    ok(a.state === 'accepted' && a.attempts === 1 && a.lastError === 'database is locked', `DEFER A is set aside with its error, still retryable (${a.state} ${a.attempts} ${a.lastError})`);
    ok(inbox.defers.length === 1 && inbox.releases === 0, `DEFER through "defer", not a plain release (${inbox.defers.length}/${inbox.releases})`);
    ok(b.state === 'ready', `SAME-PASS the independent job B ran in the same pass (${b.state})`);
    ok(a2.state === 'accepted' && a2.claims === 0, `ORDER the later job of the same article stays behind A (${a2.state}, ${a2.claims} claims)`);
    ok(a.claims === 1, `NO-HOT-LOOP A was tried exactly once in this pass (${a.claims})`);
    await drainMobileUploads(deps, 25);                       // a poll before the wait is over
    ok(a.claims === 1 && a2.claims === 0, 'WAIT a poll before the backoff does not touch A (or A2)');
    inbox.now = 31;                                           // backoff over
    await drainMobileUploads(deps, 25);
    ok(a.state === 'ready' && a2.state === 'ready' && a.claims === 2, `RETRY after the wait A succeeds, then A2 runs (${a.state}, ${a2.state})`);
  }

  // ── 2 Welche Pannen werden zurueckgestellt, welche nur zurueckgegeben ──
  {
    const cases: Array<[string, unknown, ClaimedImage[], Partial<MobileDrainDeps>, string]> = [
      ['prepare unavailable (gallery)', galleryEdit('p'), [img(0)], { preparePreparedMedia: async () => { throw new Error('busy'); } }, 'prepare_unavailable'],
      ['text edit throws (DB locked)', textEdit('p'), [], { applyTextEdit: async () => { throw new Error('database is locked'); } }, 'database is locked'],
      ['text edit persist failure', textEdit('p'), [], { applyTextEdit: async () => ({ ok: false, errorCode: 'MEDIA_ORCH_DB_PERSIST_FAILED' }) }, 'MEDIA_ORCH_DB_PERSIST_FAILED'],
      ['gallery persist failure (backup/file)', galleryEdit('p'), [img(0)], { applyGalleryEdit: async () => ({ ok: false, errorCode: 'MEDIA_ORCH_DB_PERSIST_FAILED' }) }, 'MEDIA_ORCH_DB_PERSIST_FAILED'],
    ];
    for (const [what, meta, images, over, code] of cases) {
      const inbox = new Inbox(); const r = inbox.add('ev-1', 'p', meta, images);
      await drainMobileUploads(depsFor(inbox, over), 25);
      ok(r.state === 'accepted' && inbox.defers[0]?.code === code && r.nextAt === 30, `RETRYABLE ${what} → deferred 30 s with "${inbox.defers[0]?.code}"`);
    }
    // Neutral: die Bindung wechselt waehrend des Laufs → nur zurueckgeben, nicht zaehlen.
    const inbox = new Inbox(); const r = inbox.add('ev-1', 'p', textEdit('p'));
    let reads = 0;
    await drainMobileUploads(depsFor(inbox, {
      readScopeEvidence: async () => ({ tenantId: TENANT, branchId: BRANCH, serverInstanceId: 'srv-1', bindingRevision: (++reads > 2 ? 8 : 7), configured: true }),
    }), 1);
    ok(r.state === 'accepted' && r.attempts === 0 && inbox.releases === 1 && inbox.defers.length === 0, `NEUTRAL a scope fence is a plain release — no attempt counted (${r.attempts}/${inbox.releases})`);
  }

  // ── 3 Endgueltige Faelle wie seit v0.8.75 ──
  {
    const inbox = new Inbox();
    const t = inbox.add('ev-T', 'prod-T', { kind: 'text_edit', productId: 'prod-T', patch: { purchasePrice: null } });
    const n = inbox.add('ev-N', 'prod-T', textEdit('prod-T'));
    await drainMobileUploads(depsFor(inbox), 25);
    ok(t.state === 'quarantined' && t.code === 'MOBILE_EDIT_PURCHASE_PRICE_REQUIRED' && t.attempts === 0, `TERMINAL unchanged: quarantined, never deferred (${t.state} ${t.code})`);
    ok(n.state === 'ready', 'TERMINAL a terminal job holds nothing — the next job of the same article runs');
    const inbox2 = new Inbox();
    const c = inbox2.add('ev-C', 'p', textEdit('p'));
    await drainMobileUploads(depsFor(inbox2, { applyTextEdit: async () => { throw new Error('NOT NULL constraint failed: products.purchase_price'); } }), 25);
    ok(c.state === 'quarantined' && c.code === 'MOBILE_EDIT_DB_CONSTRAINT' && inbox2.defers.length === 0, 'TERMINAL a DB constraint stays terminal (v0.8.75)');
  }

  // ── 4 Die Verdrahtung: Tauri-Befehl, Bridge, Server-Fence ──
  {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    const bridge = createTauriMobileUploadBridge(async (cmd, args) => { calls.push([cmd, args]); return true as never; });
    const sc: DrainScope = { expectedBindingRevision: 7, expectedTenantId: TENANT, expectedBranchId: BRANCH };
    await bridge.defer!('u-1', 'ev-1', 'tok-1', 'prepare_unavailable', sc);
    ok(calls[0][0] === 'mobile_upload_defer' && JSON.stringify(calls[0][1]) === JSON.stringify({ originAuthenticatedUserId: 'u-1', uploadEventId: 'ev-1', claimToken: 'tok-1', errorCode: 'prepare_unavailable', ...sc }),
      'BRIDGE defer invokes mobile_upload_defer with the claim token, the code and the scope');
    const lib = readFileSync(new URL('../../src-tauri/src/lib.rs', import.meta.url), 'utf8');
    const handler = lib.slice(lib.indexOf('generate_handler!['));
    ok(/^\s*mobile_upload_defer,/m.test(handler), 'TAURI mobile_upload_defer is registered');
    const body = lib.slice(lib.indexOf('fn mobile_upload_defer('), lib.indexOf('fn mobile_upload_defer(') + 1400);
    const iScope = body.indexOf('mobile_scope_expectation(install_id,'), iGate = body.indexOf('mobile_runtime_gate(&conn, &scope)?'), iFenced = body.indexOf('mark_deferred_fenced(');
    ok(iScope >= 0 && iScope < iGate && iGate < iFenced, 'TAURI defer: scope → gate → fenced core (same guard as every mobile mutation)');
    ok(/chrono::Utc::now\(\)\.to_rfc3339\(\)/.test(body), 'TAURI the time is the host clock, never a value from the phone or the renderer');
    const wiring = readFileSync(new URL('../../src/core/media/mobile-upload-wiring.ts', import.meta.url), 'utf8');
    ok(/const DRAIN_POLL_INTERVAL_MS = 15_000;/.test(wiring), 'POLL the desktop still collects every 15 s — not more often');
  }
}

main()
  .catch((e) => { FAIL++; failures.push('harness: ' + ((e as { message?: string })?.message ?? String(e))); console.error(e); })
  .finally(() => {
    console.log(`\nMOBILE-QUEUE retry backoff (drain): ${PASS} passed, ${FAIL} failed`);
    if (FAIL > 0) { for (const f of failures) console.log('   - ' + f); process.exit(1); }
  });
