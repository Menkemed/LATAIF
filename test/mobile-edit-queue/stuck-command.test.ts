// ════════════════════════════════════════════════════════════════════════════
// MOBILE-QUEUE — ein deterministisch ungueltiger Handy-Auftrag blockiert die Warteschlange nicht mehr.
// Run: node test/mobile-edit-queue/stuck-command.test.ts
//
// Der Fall aus dem Echtbetrieb (CAR-OGJ-001): Bild ersetzen + Jahr leeren + Einkaufspreis leeren. Der
// Desktop scheiterte bei jedem Versuch an `products.purchase_price NOT NULL`, hielt das fuer
// voruebergehend, gab den Auftrag zurueck — und weil immer der aelteste Auftrag zuerst kommt, kam
// kein spaeterer Handy-Auftrag mehr durch.
//
// Geprueft am ECHTEN `drainMobileUploads` gegen eine Inbox, die den Rust-Vertrag nachbildet: es wird
// immer der aelteste `accepted` Auftrag beansprucht, `release` macht ihn wieder `accepted`,
// `ready`/`quarantined` sind endgueltig.
// ════════════════════════════════════════════════════════════════════════════

import {
  drainMobileUploads, dbConstraintViolation,
  type ClaimGrant, type ClaimedImage, type DrainScope, type MobileDrainDeps,
  type MobileUploadBridge, type PreparedMediaItem, type ReadyResult,
} from '../../src/core/media/mobile-upload-drain.ts';
import { parseMobileProductPatch, ERR_PURCHASE_PRICE_REQUIRED } from '../../src/core/media/mobile-product-patch.ts';
import { parseMobileGalleryPlan } from '../../src/core/media/mobile-gallery-edit.ts';
import { readFileSync } from 'node:fs';

const TENANT = 'tenant-1', BRANCH = 'branch-1', USER = 'user-1';
const PRODUCT = 'b34529ca-car-ogj-001', OTHER = 'prod-other';
const HEX = 'd'.repeat(64);

let PASS = 0, FAIL = 0;
const failures: string[] = [];
function ok(cond: unknown, msg: string): void { if (cond) PASS++; else { FAIL++; failures.push(msg); console.log(`  ✗ ${msg}`); } }

type State = 'accepted' | 'processing' | 'ready' | 'quarantined';
interface Row { uploadEventId: string; metadataJson: string; images: ClaimedImage[]; state: State; errorCode: string | null; claimToken: string | null; claims: number }

class Inbox implements MobileUploadBridge {
  rows: Row[] = [];
  private seq = 0;
  add(uploadEventId: string, metadata: unknown, images: ClaimedImage[] = []): Row {
    const row: Row = { uploadEventId, metadataJson: JSON.stringify(metadata), images, state: 'accepted', errorCode: null, claimToken: null, claims: 0 };
    this.rows.push(row);
    return row;
  }
  private held(e: string, t: string): Row | null { const r = this.rows.find((x) => x.uploadEventId === e); return r && r.state === 'processing' && r.claimToken === t ? r : null; }
  async claim(claimantInstanceId: string, _l: number, _s: DrainScope): Promise<ClaimGrant | null> {
    const r = this.rows.find((x) => x.state === 'accepted');   // der AELTESTE zuerst — wie in Rust
    if (!r) return null;
    r.state = 'processing'; r.claimToken = `claim-${++this.seq}`; r.claims++;
    return { tenantId: TENANT, branchId: BRANCH, authenticatedUserId: USER, uploadEventId: r.uploadEventId, entityId: `job-${r.uploadEventId}`,
      payloadHash: 'p'.repeat(64), mode: 'collection', metadataJson: r.metadataJson, claimToken: r.claimToken, claimantInstanceId,
      leaseUntil: '2026-01-01T00:00:00Z', images: r.images };
  }
  async release(_u: string, e: string, t: string): Promise<boolean> { const r = this.held(e, t); if (!r) return false; r.state = 'accepted'; r.claimToken = null; return true; }
  async markQuarantined(_u: string, e: string, t: string, code: string): Promise<boolean> { const r = this.held(e, t); if (!r) return false; r.state = 'quarantined'; r.errorCode = code; r.claimToken = null; return true; }
  async markReady(_u: string, e: string, t: string): Promise<ReadyResult> { const r = this.held(e, t); if (!r) return 'rejected'; r.state = 'ready'; r.claimToken = null; return 'marked_ready'; }
  async prepareImage(): Promise<never> { throw new Error('not used'); }
  async renew(): Promise<boolean> { return true; }
}

interface Fx { prepares: number; galleryApplies: number; textApplies: number; applied: Set<string> }
const img = (slot: number): ClaimedImage => ({ slot, primary: slot === 0, mime: 'image/jpeg', width: 1200, height: 1600, byteSize: 400000, contentHash: 'a'.repeat(64), storageKey: 'k' });

function depsFor(inbox: Inbox, fx: Fx, over: Partial<MobileDrainDeps> = {}): MobileDrainDeps {
  return {
    bridge: inbox, claimantInstanceId: 'instance-1',
    readScopeEvidence: async () => ({ tenantId: TENANT, branchId: BRANCH, serverInstanceId: 'srv-1', bindingRevision: 7, configured: true }),
    currentScope: () => ({ tenantId: TENANT, branchId: BRANCH }),
    readReceipt: () => null,
    productExists: (id) => id === PRODUCT || id === OTHER,
    readProductMetadataHash: async () => null, readBoundBatch: async () => [], readGalleryManifest: async () => [],
    readSideEffectCounts: async () => ({ changelog: 0, audit: 0 }), deriveCreateBatchId: () => 'batch-1',
    preparePreparedMedia: async (grant): Promise<PreparedMediaItem[]> => { fx.prepares++; return grant.images.map((i) => ({ slot: i.slot, ingestRequestId: `req-${grant.uploadEventId}-${i.slot}`, prepared: {} as never })); },
    createProduct: async () => { throw new Error('no create in this test'); },
    verifyReady: async () => 'ready',
    applyTextEdit: async () => { fx.textApplies++; return { ok: true }; },
    applyGalleryEdit: async (grant) => { fx.galleryApplies++; fx.applied.add(grant.uploadEventId); return { ok: true }; },
    galleryEditApplied: (grant) => fx.applied.has(grant.uploadEventId),
    readProductState: () => ({ categoryId: 'cat-original-gold-jewelry', attributes: { year: 2024, karat: '18K Yellow', item_type: 'Bangle' }, scopeOfDelivery: [] }),
    fieldSchema: () => ({ version: 1, categories: [{ id: 'cat-original-gold-jewelry', name: 'Original Gold', brandRequired: true, conditionOptions: ['Pre-Owned'], scopeOptions: ['Box'],
      attributes: [{ key: 'year', label: 'Year', type: 'number', required: false }, { key: 'karat', label: 'Karat & Color', type: 'text', required: true }, { key: 'item_type', label: 'Item Type', type: 'text', required: true }] }] }),
    priceEditAllowed: () => true,
    ...over,
  };
}
const fresh = (): Fx => ({ prepares: 0, galleryApplies: 0, textApplies: 0, applied: new Set() });
// Der Auftrag aus dem Echtbetrieb, Feld fuer Feld.
const stuckJob = { kind: 'gallery_edit', productId: PRODUCT, galleryBaseline: HEX, order: [{ new: 0 }], remove: ['link-old'],
  patch: { attributes: { year: null }, purchasePrice: null } };

async function main(): Promise<void> {
  // ── 1 Die Pruefung selbst ────────────────────────────────────────────────
  {
    const p = parseMobileProductPatch({ attributes: { year: null }, purchasePrice: null });
    ok(!p.ok && p.code === ERR_PURCHASE_PRICE_REQUIRED, `PATCH a cleared purchase price is refused with its own code (${!p.ok ? p.code : 'ok'})`);
    ok(parseMobileProductPatch({ attributes: { year: null }, purchasePrice: 0 }).ok, 'PATCH purchase price 0 + cleared year is fine');
    ok(parseMobileProductPatch({ plannedSalePrice: null, minSalePrice: null }).ok, 'PATCH sale and minimum price may still be cleared');
    ok(parseMobileProductPatch({ attributes: { year: null } }).ok, 'PATCH the year may be cleared');
    const g = parseMobileGalleryPlan(JSON.stringify(stuckJob));
    ok(!g.ok && g.code === ERR_PURCHASE_PRICE_REQUIRED, `PLAN the gallery job from the field keeps that code (${!g.ok ? g.code : 'ok'})`);
  }

  // ── 2 Der hängende Auftrag wird endgueltig, der naechste laeuft ──────────
  {
    const inbox = new Inbox(); const fx = fresh();
    const stuck = inbox.add('ev-stuck', stuckJob, [img(0)]);                     // aelter — wurde vor dem Fix angenommen
    const next = inbox.add('ev-next', { kind: 'text_edit', productId: OTHER, patch: { notes: 'valid' } });
    const later = inbox.add('ev-later', { kind: 'gallery_edit', productId: OTHER, galleryBaseline: HEX, order: [{ new: 0 }], remove: [] }, [img(0)]);
    await drainMobileUploads(depsFor(inbox, fx), 25);
    ok(stuck.state === 'quarantined' && stuck.errorCode === ERR_PURCHASE_PRICE_REQUIRED, `STUCK the invalid command ends terminal with a clear code (${stuck.state} ${stuck.errorCode})`);
    ok(stuck.claims === 1, `STUCK …claimed exactly once — no retry loop (${stuck.claims})`);
    ok(!fx.applied.has('ev-stuck'), 'STUCK …nothing of it was applied — no image, no field (atomic)');
    ok(next.state === 'ready' && later.state === 'ready', `QUEUE the following commands are processed in the SAME pass (${next.state}, ${later.state})`);
    for (let i = 0; i < 3; i++) await drainMobileUploads(depsFor(inbox, fx), 25);
    ok(stuck.claims === 1 && stuck.state === 'quarantined', 'STUCK further drains never pick it up again');
  }

  // ── 3 Absicherung: Regelverstoss der Datenbank endgueltig, Unbekanntes wiederholbar ──
  {
    ok(dbConstraintViolation('NOT NULL constraint failed: products.purchase_price') && dbConstraintViolation('CHECK constraint failed: x'),
      'CLASSIFY NOT NULL / CHECK violations are recognised');
    ok(!dbConstraintViolation('database is locked') && !dbConstraintViolation('MEDIA_ORCH_DB_PERSIST_FAILED') && !dbConstraintViolation(undefined),
      'CLASSIFY a locked database, a persist failure or nothing are NOT treated as permanent');

    const inbox = new Inbox(); const fx = fresh();
    const g = inbox.add('ev-g-null', { kind: 'gallery_edit', productId: OTHER, galleryBaseline: HEX, order: [{ new: 0 }], remove: [] }, [img(0)]);
    const n = inbox.add('ev-after', { kind: 'text_edit', productId: OTHER, patch: { notes: 'x' } });
    await drainMobileUploads(depsFor(inbox, fx, { applyGalleryEdit: async () => ({ ok: false, errorCode: 'NOT NULL constraint failed: products.purchase_price' }) }), 25);
    ok(g.state === 'quarantined' && g.errorCode === 'MOBILE_EDIT_DB_CONSTRAINT', `SAFETY-NET a DB constraint failure in a gallery edit is terminal (${g.state} ${g.errorCode})`);
    ok(n.state === 'ready', 'SAFETY-NET …and the next command still runs');

    const inbox2 = new Inbox(); const fx2 = fresh();
    const t = inbox2.add('ev-t-throw', { kind: 'text_edit', productId: OTHER, patch: { notes: 'x' } });
    await drainMobileUploads(depsFor(inbox2, fx2, { applyTextEdit: async () => { throw new Error('NOT NULL constraint failed: products.purchase_price'); } }), 25);
    ok(t.state === 'quarantined' && t.errorCode === 'MOBILE_EDIT_DB_CONSTRAINT', `SAFETY-NET a DB constraint thrown by a text edit is terminal (${t.state} ${t.errorCode})`);

    const inbox3 = new Inbox(); const fx3 = fresh();
    const c = inbox3.add('ev-t-code', { kind: 'text_edit', productId: OTHER, patch: { notes: 'x' } });
    await drainMobileUploads(depsFor(inbox3, fx3, { applyTextEdit: async () => ({ ok: false, errorCode: 'MOBILE_EDIT_PURCHASE_PRICE_REQUIRED' }) }), 25);
    ok(c.state === 'quarantined' && c.errorCode === ERR_PURCHASE_PRICE_REQUIRED, `SAFETY-NET the coordinator's purchase-price refusal is terminal (${c.errorCode})`);

    const inbox4 = new Inbox(); const fx4 = fresh();
    const l = inbox4.add('ev-locked', { kind: 'text_edit', productId: OTHER, patch: { notes: 'x' } });
    await drainMobileUploads(depsFor(inbox4, fx4, { applyTextEdit: async () => { throw new Error('database is locked'); } }), 1);
    ok(l.state === 'accepted' && l.errorCode === null, `TRANSIENT an unknown/locked error stays retryable (${l.state})`);
    const inbox5 = new Inbox(); const fx5 = fresh();
    const p = inbox5.add('ev-persist', { kind: 'gallery_edit', productId: OTHER, galleryBaseline: HEX, order: [{ new: 0 }], remove: [] }, [img(0)]);
    await drainMobileUploads(depsFor(inbox5, fx5, { applyGalleryEdit: async () => ({ ok: false, errorCode: 'MEDIA_ORCH_DB_PERSIST_FAILED' }) }), 1);
    ok(p.state === 'accepted', `TRANSIENT a persist failure of a gallery edit stays retryable (${p.state})`);
  }

  // ── 4 Angewandt, Bestaetigung verloren, Wiederholung → erledigt, kein falscher Konflikt ──
  {
    const inbox = new Inbox(); const fx = fresh();
    const row = inbox.add('ev-replay', { kind: 'gallery_edit', productId: OTHER, galleryBaseline: HEX, order: [{ new: 0 }], remove: ['link-old'] }, [img(0)]);
    let calls = 0;
    const deps = depsFor(inbox, fx, {
      // Erster Versuch: der Bildwechsel IST angewandt (Journal ready), danach scheitert die Sicherung.
      // Jeder weitere Versuch wuerde mit dem veralteten Handy-Stand im Konflikt enden.
      applyGalleryEdit: async (grant) => {
        calls++;
        if (calls === 1) { fx.applied.add(grant.uploadEventId); return { ok: false, errorCode: 'MEDIA_ORCH_DB_PERSIST_FAILED' }; }
        return { ok: false, errorCode: 'MOBILE_GALLERY_BASELINE_CHANGED' };
      },
    });
    await drainMobileUploads(deps, 25);
    ok(row.state === 'ready' && row.errorCode === null, `REPLAY the retried command ends READY, not as a false conflict (${row.state} ${row.errorCode})`);
    ok(calls === 1, `REPLAY …the edit was applied exactly once (${calls} apply call)`);
    ok(row.claims === 2, `REPLAY …second claim recognised it as done (${row.claims} claims)`);
  }

  // ── 5 Echter Konflikt bleibt Konflikt ────────────────────────────────────
  {
    const inbox = new Inbox(); const fx = fresh();
    const row = inbox.add('ev-conflict', { kind: 'gallery_edit', productId: OTHER, galleryBaseline: HEX, order: [{ new: 0 }], remove: ['link-old'] }, [img(0)]);
    await drainMobileUploads(depsFor(inbox, fx, { applyGalleryEdit: async () => ({ ok: false, errorCode: 'MOBILE_GALLERY_BASELINE_CHANGED' }) }), 25);
    ok(row.state === 'quarantined' && row.errorCode === 'MOBILE_GALLERY_BASELINE_CHANGED', `CONFLICT a command never applied, against a changed gallery, stays a conflict (${row.errorCode})`);
  }

  // ── 6 Handy: Pruefung vor dem Senden, Wartezeit passt zum 15-s-Abholen ───
  {
    const page = readFileSync(new URL('../../src-tauri/src/sync/mobile_page.rs', import.meta.url), 'utf8');
    ok(/if \(key === 'purchasePrice'\) return setText\('peMsg', 'Purchase price cannot be empty — enter 0 if there is no cost\.'\);/.test(page),
      'PHONE an empty purchase price is refused before sending, with the "enter 0" hint');
    ok(/const within = \(opts && opts\.timeoutMs\) \|\| 40000;/.test(page) && /const every = \(opts && opts\.intervalMs\) \|\| 1200;/.test(page),
      'PHONE the phone waits 40 s for the desktop (polling every 1.2 s unchanged)');
    const wiring = readFileSync(new URL('../../src/core/media/mobile-upload-wiring.ts', import.meta.url), 'utf8');
    ok(/const DRAIN_POLL_INTERVAL_MS = 15_000;/.test(wiring), 'DESKTOP the desktop still collects every 15 s — not more often');
    ok(40000 > 15000 * 2, 'TIMING 40 s covers two full collection rounds plus processing');
  }
}

main()
  .catch((e) => { FAIL++; failures.push('harness: ' + ((e as { message?: string })?.message ?? String(e))); console.error(e); })
  .finally(() => {
    console.log(`\nMOBILE-QUEUE stuck command: ${PASS} passed, ${FAIL} failed`);
    if (FAIL > 0) { for (const f of failures) console.log('   - ' + f); process.exit(1); }
    console.log('MOBILE_QUEUE_STUCK_COMMAND_FIX_READY');
  });
