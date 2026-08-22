// ════════════════════════════════════════════════════════════════════════════
// MOBILE-EDIT-S2-R1 — Fehlerklassifikation des Text-Edit-Zweigs im Mobile-Drain
// Run: node test/mobile-edit-failure/edit-failure-classification.test.ts
//
// Die Frage, die hier beantwortet wird, ist NICHT "wird der Fehler gemeldet", sondern: landet ein
// Job in dem Zustand, aus dem er wieder herauskommt — und nur dann? Zwei Klassen:
//
//   PERMANENT  — der Job kann durch Wiederholung nie erfolgreich werden (Ziel existiert nicht,
//                Payload malformed, verbotenes Feld, Bilder in einem Text-Edit). Er MUSS terminal
//                werden (`quarantined`) und darf danach nie wieder beansprucht werden.
//   TRANSIENT  — derselbe Job kann spaeter gelingen (Scope-Fence, Orchestrator wirft, Textedit noch
//                nicht verdrahtet). Er MUSS beanspruchbar bleiben und spaeter wirklich durchlaufen.
//
// Geprueft wird am ECHTEN `processMobileUploadClaim`/`drainMobileUploads` gegen eine Inbox, die den
// Rust-Zustandsvertrag nachbildet: nur `accepted` ist beanspruchbar, `mark*` gilt nur fuer den
// haltenden Claim-Token, und ein terminaler Zustand ist endgueltig. Damit ist "kein Endlos-Loop"
// eine Aussage ueber persistierten Zustand und Claim-Zaehler, nicht ueber einen Rueckgabewert.
//
// Der Create-Pfad ist in allen Faellen scharf gestellt: `createProduct` und `preparePreparedMedia`
// werfen und zaehlen mit. Wird einer von beiden auch nur beruehrt, faellt der Test.
// ════════════════════════════════════════════════════════════════════════════

import {
  processMobileUploadClaim, drainMobileUploads,
  mobileJobKindMarker,
  type ClaimGrant, type ClaimedImage, type DrainScope, type MobileDrainDeps,
  type MobileUploadBridge, type PreparedMediaItem, type ReadyResult,
} from '../../src/core/media/mobile-upload-drain.ts';

const TENANT = 'tenant-1', BRANCH = 'branch-1', USER = 'user-1';
const PRODUCT = 'prod-existing';

let PASS = 0, FAIL = 0;
const failures: string[] = [];
function ok(cond: unknown, msg: string): void { if (cond) PASS++; else { FAIL++; failures.push(msg); console.log(`  ✗ ${msg}`); } }

type State = 'accepted' | 'processing' | 'ready' | 'quarantined';
interface Row {
  uploadEventId: string; entityId: string; payloadHash: string; metadataJson: string;
  images: ClaimedImage[]; state: State; errorCode: string | null; productId: string | null;
  claimToken: string | null; claims: number;
}

/** Die Inbox, wie der Rust-Vertrag sie fuehrt: `accepted` ist beanspruchbar, ein Claim macht daraus
 *  `processing` mit frischem Token, und `ready`/`quarantined` sind ENDGUELTIG — ein terminaler Job
 *  wird nie wieder ausgeliefert. Genau diese Endgueltigkeit ist der Schutz vor dem Endlos-Loop. */
class Inbox implements MobileUploadBridge {
  rows: Row[] = [];
  prepareCalls = 0;
  private seq = 0;

  add(uploadEventId: string, metadata: unknown, images: ClaimedImage[] = []): Row {
    const row: Row = {
      uploadEventId, entityId: `job-${uploadEventId}`, payloadHash: 'p'.repeat(64),
      metadataJson: typeof metadata === 'string' ? metadata : JSON.stringify(metadata),
      images, state: 'accepted', errorCode: null, productId: null, claimToken: null, claims: 0,
    };
    this.rows.push(row);
    return row;
  }
  private held(uploadEventId: string, token: string): Row | null {
    const r = this.rows.find((x) => x.uploadEventId === uploadEventId);
    return r && r.state === 'processing' && r.claimToken === token ? r : null;
  }
  async claim(claimantInstanceId: string, _leaseSeconds: number, _scope: DrainScope): Promise<ClaimGrant | null> {
    const r = this.rows.find((x) => x.state === 'accepted');
    if (!r) return null;
    r.state = 'processing'; r.claimToken = `claim-${++this.seq}`; r.claims++;
    return {
      tenantId: TENANT, branchId: BRANCH, authenticatedUserId: USER,
      uploadEventId: r.uploadEventId, entityId: r.entityId, payloadHash: r.payloadHash,
      mode: 'collection', metadataJson: r.metadataJson, claimToken: r.claimToken,
      claimantInstanceId, leaseUntil: '2026-01-01T00:00:00Z', images: r.images,
    };
  }
  async release(_u: string, e: string, t: string, _s: DrainScope): Promise<boolean> {
    const r = this.held(e, t); if (!r) return false;
    r.state = 'accepted'; r.claimToken = null; return true;
  }
  async markQuarantined(_u: string, e: string, t: string, code: string, _s: DrainScope): Promise<boolean> {
    const r = this.held(e, t); if (!r) return false;
    r.state = 'quarantined'; r.errorCode = code; r.claimToken = null; return true;
  }
  async markReady(_u: string, e: string, t: string, _entityId: string, _ph: string, productId: string, _s: DrainScope): Promise<ReadyResult> {
    const r = this.held(e, t); if (!r) return 'rejected';
    r.state = 'ready'; r.productId = productId; r.claimToken = null; return 'marked_ready';
  }
  async prepareImage(): Promise<never> { this.prepareCalls++; throw new Error('the edit branch must never prepare an image'); }
  async renew(): Promise<boolean> { return true; }
}

interface Effects { creates: number; prepares: number; applies: number }

function depsFor(
  bridge: Inbox,
  effects: Effects,
  products: Set<string>,
  applyTextEdit?: MobileDrainDeps['applyTextEdit'],
): MobileDrainDeps {
  return {
    bridge,
    claimantInstanceId: 'instance-1',
    readScopeEvidence: async () => ({ tenantId: TENANT, branchId: BRANCH, serverInstanceId: 'srv-1', bindingRevision: 7, configured: true }),
    currentScope: () => ({ tenantId: TENANT, branchId: BRANCH }),
    readReceipt: () => null,
    productExists: (id) => products.has(id),
    readProductMetadataHash: async () => null,
    readBoundBatch: async () => [],
    readGalleryManifest: async () => [],
    readSideEffectCounts: async () => ({ changelog: 0, audit: 0 }),
    deriveCreateBatchId: () => 'batch-1',
    preparePreparedMedia: async (): Promise<PreparedMediaItem[]> => { effects.prepares++; throw new Error('the edit branch must never prepare media'); },
    createProduct: async () => { effects.creates++; throw new Error('the edit branch must never create a product'); },
    verifyReady: async () => 'ready',
    applyTextEdit,
  };
}

const editJob = (productId: string, patch: Record<string, unknown>) => ({ kind: 'text_edit', productId, patch });
const img = (slot: number): ClaimedImage => ({
  slot, primary: slot === 0, mime: 'image/jpeg', width: 800, height: 600,
  byteSize: 1234, contentHash: 'a'.repeat(64), storageKey: 'opaque-key',
});

// ════════════════════════════════════════════════════════════════════════════
async function main(): Promise<void> {
  // ── PERMANENT 1: das Zielprodukt existiert nicht ──────────────────────────
  {
    const inbox = new Inbox(); const fx: Effects = { creates: 0, prepares: 0, applies: 0 };
    const row = inbox.add('ev-missing-target', editJob('prod-does-not-exist', { name: 'X' }));
    const deps = depsFor(inbox, fx, new Set([PRODUCT]), async () => { fx.applies++; return { ok: true }; });

    await drainMobileUploads(deps, 25);
    ok(row.state === 'quarantined', `PERMANENT missing target ends terminal (${row.state})`);
    ok(row.errorCode === 'MOBILE_UPLOAD_TARGET_CONFLICT', `PERMANENT …with a stable code (${row.errorCode})`);
    ok(row.claims === 1, `PERMANENT …claimed exactly once, no deferred loop (${row.claims})`);
    ok(fx.applies === 0, 'PERMANENT the text edit was never applied');
    ok(fx.creates === 0 && fx.prepares === 0 && inbox.prepareCalls === 0, 'PERMANENT no create and no media side effect');

    // Der eigentliche Loop-Beweis: weitere volle Drain-Durchlaeufe duerfen den Job nicht erneut anfassen.
    for (let i = 0; i < 3; i++) await drainMobileUploads(deps, 25);
    ok(row.claims === 1, `PERMANENT three further drains claim it never again (${row.claims})`);
    ok(row.state === 'quarantined' && row.errorCode === 'MOBILE_UPLOAD_TARGET_CONFLICT', 'PERMANENT …and the terminal verdict is unchanged');
    ok(row.productId === null, 'PERMANENT no product id was ever bound to the job');
  }

  // ── PERMANENT 2: malformed Payload (kein Patch-Objekt) ────────────────────
  {
    const inbox = new Inbox(); const fx: Effects = { creates: 0, prepares: 0, applies: 0 };
    const row = inbox.add('ev-malformed', { kind: 'text_edit', productId: PRODUCT, patch: 'not-an-object' });
    const deps = depsFor(inbox, fx, new Set([PRODUCT]), async () => { fx.applies++; return { ok: true }; });

    await drainMobileUploads(deps, 25);
    ok(row.state === 'quarantined', `PERMANENT malformed payload ends terminal (${row.state})`);
    ok(row.errorCode === 'MOBILE_EDIT_PATCH_INVALID', `PERMANENT …with a stable code (${row.errorCode})`);
    ok(row.claims === 1, `PERMANENT …claimed exactly once (${row.claims})`);
    ok(fx.applies === 0 && fx.creates === 0 && fx.prepares === 0, 'PERMANENT nothing applied, nothing created');
  }

  // ── PERMANENT 3: verbotenes Feld im Patch ─────────────────────────────────
  {
    const inbox = new Inbox(); const fx: Effects = { creates: 0, prepares: 0, applies: 0 };
    const row = inbox.add('ev-forbidden', editJob(PRODUCT, { name: 'Ok', sku: 'HACK-1' }));
    const deps = depsFor(inbox, fx, new Set([PRODUCT]), async () => { fx.applies++; return { ok: true }; });

    await drainMobileUploads(deps, 25);
    ok(row.state === 'quarantined', `PERMANENT a forbidden field ends terminal (${row.state})`);
    ok(row.errorCode === 'MOBILE_EDIT_PATCH_INVALID', `PERMANENT …with the same stable code (${row.errorCode})`);
    ok(fx.applies === 0, 'PERMANENT …and NOTHING was applied — not even the allowed half of the patch');
  }

  // ── PERMANENT 4: ein Text-Edit, der Bilder mitbringt ──────────────────────
  {
    const inbox = new Inbox(); const fx: Effects = { creates: 0, prepares: 0, applies: 0 };
    const row = inbox.add('ev-with-images', editJob(PRODUCT, { name: 'Ok' }), [img(0)]);
    const deps = depsFor(inbox, fx, new Set([PRODUCT]), async () => { fx.applies++; return { ok: true }; });

    await drainMobileUploads(deps, 25);
    ok(row.state === 'quarantined', `PERMANENT an edit carrying images ends terminal (${row.state})`);
    ok(row.errorCode === 'MOBILE_EDIT_GALLERY_NOT_SUPPORTED', `PERMANENT …named for what it is (${row.errorCode})`);
    ok(fx.applies === 0, 'PERMANENT …applied nothing — no half-executed job');
    ok(inbox.prepareCalls === 0 && fx.prepares === 0, 'PERMANENT …and never touched the image');
  }

  // ── TRANSIENT 1: der Textedit wirft, spaeter gelingt er ───────────────────
  {
    const inbox = new Inbox(); const fx: Effects = { creates: 0, prepares: 0, applies: 0 };
    const row = inbox.add('ev-throws', editJob(PRODUCT, { name: 'Neuer Name' }));
    let failing = true;
    const deps = depsFor(inbox, fx, new Set([PRODUCT]), async () => {
      fx.applies++;
      if (failing) throw new Error('DB_BUSY');
      return { ok: true };
    });

    // EIN Claim-Zyklus, nicht der volle Loop: der freigegebene Job ist sofort wieder beanspruchbar.
    const grant = await inbox.claim('instance-1', 60, { expectedBindingRevision: 7, expectedTenantId: TENANT, expectedBranchId: BRANCH });
    const out = await processMobileUploadClaim(grant as ClaimGrant, deps);
    ok(out.code === 'deferred', `TRANSIENT a throwing edit is deferred, not terminal (${out.code})`);
    ok(row.state === 'accepted', `TRANSIENT …the job is claimable again (${row.state})`);
    ok(row.errorCode === null, 'TRANSIENT …and carries no terminal verdict');
    ok(fx.applies === 1, 'TRANSIENT the edit was attempted once');

    failing = false;
    await drainMobileUploads(deps, 25);
    ok(row.state === 'ready', `TRANSIENT …and a later pass really processes it (${row.state})`);
    ok(row.productId === PRODUCT, `TRANSIENT …against the intended product (${row.productId})`);
    ok(fx.creates === 0 && fx.prepares === 0, 'TRANSIENT no create and no media side effect on the way');
  }

  // ── TRANSIENT 2: der Textedit meldet einen Konflikt, spaeter gelingt er ───
  {
    const inbox = new Inbox(); const fx: Effects = { creates: 0, prepares: 0, applies: 0 };
    const row = inbox.add('ev-conflict', editJob(PRODUCT, { brand: 'Rolex' }));
    let failing = true;
    const deps = depsFor(inbox, fx, new Set([PRODUCT]), async () => {
      fx.applies++;
      return failing ? { ok: false, errorCode: 'BASELINE_CHANGED' } : { ok: true };
    });

    const grant = await inbox.claim('instance-1', 60, { expectedBindingRevision: 7, expectedTenantId: TENANT, expectedBranchId: BRANCH });
    const out = await processMobileUploadClaim(grant as ClaimGrant, deps);
    ok(out.code === 'deferred' && out.detail === 'BASELINE_CHANGED', `TRANSIENT a baseline conflict defers and keeps its reason (${out.code}/${out.detail})`);
    ok(row.state === 'accepted' && row.errorCode === null, 'TRANSIENT …the job stays retryable');

    failing = false;
    await drainMobileUploads(deps, 25);
    ok(row.state === 'ready' && row.productId === PRODUCT, `TRANSIENT …and the retry succeeds (${row.state})`);
  }

  // ── TRANSIENT 3: der Textedit ist gar nicht verdrahtet ────────────────────
  {
    const inbox = new Inbox(); const fx: Effects = { creates: 0, prepares: 0, applies: 0 };
    const row = inbox.add('ev-unwired', editJob(PRODUCT, { notes: 'Kratzer am Glas' }));
    const unwired = depsFor(inbox, fx, new Set([PRODUCT]), undefined);

    const grant = await inbox.claim('instance-1', 60, { expectedBindingRevision: 7, expectedTenantId: TENANT, expectedBranchId: BRANCH });
    const out = await processMobileUploadClaim(grant as ClaimGrant, deps0(unwired));
    ok(out.code === 'deferred' && out.detail === 'edit_not_wired', `TRANSIENT an unwired edit defers (${out.code}/${out.detail})`);
    ok(row.state === 'accepted' && row.errorCode === null, 'TRANSIENT …and is NOT quarantined for a wiring gap');

    const wired = depsFor(inbox, fx, new Set([PRODUCT]), async () => { fx.applies++; return { ok: true }; });
    await drainMobileUploads(wired, 25);
    ok(row.state === 'ready' && row.productId === PRODUCT, `TRANSIENT …a wired run processes the very same job (${row.state})`);
    ok(fx.applies === 1, 'TRANSIENT …applied exactly once in total');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MOBILE-EDIT-S3 §18 — beim GALERIE-Edit ist ein Baseline-Konflikt TERMINAL
  //
  // Anders als beim Textedit: der Plan beschreibt eine Sicht, die es nicht mehr gibt. Ihn immer
  // wieder zu versuchen hiesse, eine veraltete Absicht gegen eine neuere Galerie zu fahren — im
  // schlimmsten Fall gegen ein Bild, das der Benutzer nie gesehen hat. Der Job wird deshalb
  // konfliktmarkiert; das Handy muss neu laden.
  // ══════════════════════════════════════════════════════════════════════════
  const galleryJob = (productId: string) => ({
    kind: 'gallery_edit', productId, galleryBaseline: 'a'.repeat(64),
    order: [{ keep: 'lnk-1' }], remove: [],
  });
  for (const code of ['MOBILE_GALLERY_BASELINE_CHANGED', 'MEDIA_EDIT_BASELINE_CHANGED', 'MOBILE_GALLERY_PLAN_INCOMPLETE', 'MOBILE_GALLERY_TOO_MANY_IMAGES']) {
    const inbox = new Inbox(); const fx: Effects = { creates: 0, prepares: 0, applies: 0 };
    const row = inbox.add(`ev-gallery-${code}`, galleryJob(PRODUCT));
    const deps = {
      ...depsFor(inbox, fx, new Set([PRODUCT]), async () => { fx.applies++; return { ok: true }; }),
      applyGalleryEdit: async () => { fx.applies++; return { ok: false, errorCode: code }; },
    };
    await drainMobileUploads(deps, 25);
    ok(row.state === 'quarantined', `GALLERY ${code} ends terminal (${row.state})`);
    ok(row.errorCode === code, `GALLERY …carrying its own code (${row.errorCode})`);
    ok(row.claims === 1, `GALLERY …claimed exactly once, no retry loop (${row.claims})`);
    ok(fx.creates === 0 && fx.prepares === 0, 'GALLERY …and no create or media side effect');
  }

  // Ein echter Hintergrundfehler bleibt dagegen wiederholbar — sonst waere die Unterscheidung wertlos.
  {
    const inbox = new Inbox(); const fx: Effects = { creates: 0, prepares: 0, applies: 0 };
    const row = inbox.add('ev-gallery-transient', galleryJob(PRODUCT));
    let failing = true;
    const deps = {
      ...depsFor(inbox, fx, new Set([PRODUCT]), async () => ({ ok: true })),
      applyGalleryEdit: async () => { fx.applies++; return failing ? { ok: false, errorCode: 'MEDIA_ORCH_DB_PERSIST_FAILED' } : { ok: true }; },
    };
    const grant = await inbox.claim('instance-1', 60, { expectedBindingRevision: 7, expectedTenantId: TENANT, expectedBranchId: BRANCH });
    const out = await processMobileUploadClaim(grant as ClaimGrant, deps);
    ok(out.code === 'deferred', `GALLERY a persist failure is deferred, not terminal (${out.code})`);
    ok(row.state === 'accepted' && row.errorCode === null, 'GALLERY …the job stays claimable');
    failing = false;
    await drainMobileUploads(deps, 25);
    ok(row.state === 'ready' && row.productId === PRODUCT, `GALLERY …and a later pass really applies it (${row.state})`);
  }

  // Ein Galerie-Job ohne Verdrahtung wird NICHT terminal — er wartet auf einen vollstaendigen Lauf.
  {
    const inbox = new Inbox(); const fx: Effects = { creates: 0, prepares: 0, applies: 0 };
    const row = inbox.add('ev-gallery-unwired', galleryJob(PRODUCT));
    const grant = await inbox.claim('instance-1', 60, { expectedBindingRevision: 7, expectedTenantId: TENANT, expectedBranchId: BRANCH });
    const out = await processMobileUploadClaim(grant as ClaimGrant, depsFor(inbox, fx, new Set([PRODUCT]), async () => ({ ok: true })));
    ok(out.code === 'deferred' && out.detail === 'gallery_edit_not_wired', `GALLERY an unwired gallery job defers (${out.detail})`);
    ok(row.state === 'accepted' && row.errorCode === null, 'GALLERY …and is not quarantined for a wiring gap');
  }

  // Ein malformter Galerie-Plan ist terminal — und wird NIE als Textedit oder Create missverstanden.
  {
    const inbox = new Inbox(); const fx: Effects = { creates: 0, prepares: 0, applies: 0 };
    const row = inbox.add('ev-gallery-malformed', { kind: 'gallery_edit', productId: PRODUCT, order: [], remove: [] });
    const deps = {
      ...depsFor(inbox, fx, new Set([PRODUCT]), async () => { fx.applies++; return { ok: true }; }),
      applyGalleryEdit: async () => { fx.applies++; return { ok: true }; },
    };
    await drainMobileUploads(deps, 25);
    ok(row.state === 'quarantined' && row.errorCode === 'MOBILE_GALLERY_PLAN_INVALID', `GALLERY a malformed plan is terminal (${row.errorCode})`);
    ok(fx.applies === 0, 'GALLERY …and nothing was applied');
    ok(fx.creates === 0, 'GALLERY …and above all no product was created');
  }

  // ── MOBILE-EDIT-S3 §2 — eine unbekannte Job-Art wird abgelehnt, nicht geraten ──
  //
  // Frueher waere so ein Job als Create durch den Manifest-Pfad gelaufen und nur deshalb gescheitert,
  // weil `kind` kein erlaubtes Create-Feld ist. Das ist Zufallsschutz. Jetzt hat der Fall einen
  // eigenen Zustand und einen eigenen Code.
  {
    const inbox = new Inbox(); const fx: Effects = { creates: 0, prepares: 0, applies: 0 };
    const row = inbox.add('ev-unknown-kind', { kind: 'gallery_wipe', productId: PRODUCT });
    const deps = {
      ...depsFor(inbox, fx, new Set([PRODUCT]), async () => { fx.applies++; return { ok: true }; }),
      applyGalleryEdit: async () => { fx.applies++; return { ok: true }; },
    };
    await drainMobileUploads(deps, 25);
    ok(row.state === 'quarantined' && row.errorCode === 'MOBILE_UNKNOWN_JOB_KIND',
      `UNKNOWN KIND terminal, with its own code (${row.state}/${row.errorCode})`);
    ok(row.claims === 1, `UNKNOWN KIND claimed exactly once (${row.claims})`);
    ok(fx.creates === 0 && fx.prepares === 0 && fx.applies === 0, 'UNKNOWN KIND nothing was created, prepared or applied');
  }
  ok(mobileJobKindMarker('{"brand":"Rolex"}') === 'create', 'MARKER a job without the field is a create — that is how every create arrives');
  ok(mobileJobKindMarker('{"kind":"text_edit"}') === 'text_edit', 'MARKER text_edit is exactly that');
  ok(mobileJobKindMarker('{"kind":"gallery_edit"}') === 'gallery_edit', 'MARKER gallery_edit is exactly that');
  for (const bad of ['{"kind":"gallery_wipe"}', '{"kind":42}', '{"kind":null}', 'not json']) {
    ok(mobileJobKindMarker(bad) === 'unknown', `MARKER ${bad} is unknown, never a create`);
  }

  // ── NEGATIVKONTROLLE: die Terminal-Pruefung ist nicht tautologisch ────────
  // Waeren die Zustandsuebergaenge oben wirkungslos, saehe ein transienter Job genauso aus wie ein
  // permanenter. Hier laeuft derselbe Job einmal gegen ein fehlendes und einmal gegen ein
  // vorhandenes Produkt — dasselbe Payload, gegenteiliger Endzustand.
  {
    const inbox = new Inbox(); const fx: Effects = { creates: 0, prepares: 0, applies: 0 };
    const gone = inbox.add('ev-control-gone', editJob('prod-gone', { name: 'A' }));
    const here = inbox.add('ev-control-here', editJob(PRODUCT, { name: 'A' }));
    const deps = depsFor(inbox, fx, new Set([PRODUCT]), async () => { fx.applies++; return { ok: true }; });

    await drainMobileUploads(deps, 25);
    ok(gone.state === 'quarantined' && here.state === 'ready', `CONTROL the same payload ends terminal or ready by target alone (${gone.state}/${here.state})`);
    ok(gone.claims === 1 && here.claims === 1, `CONTROL each was claimed exactly once (${gone.claims}/${here.claims})`);
    ok(fx.applies === 1, 'CONTROL exactly one of the two was applied');
    ok(fx.creates === 0 && fx.prepares === 0, 'CONTROL neither produced a create or media side effect');
  }
}

/** Der Deps-Satz OHNE `applyTextEdit` — `depsFor` mit `undefined` erzeugt ihn bereits, diese Huelle
 *  macht an der Aufrufstelle nur sichtbar, dass die Abhaengigkeit absichtlich fehlt. */
function deps0(d: MobileDrainDeps): MobileDrainDeps { return d; }

main()
  .catch((e) => { FAIL++; failures.push('harness: ' + ((e as { message?: string })?.message ?? String(e))); console.error(e); })
  .finally(() => {
    console.log(`\nMOBILE-EDIT-S2-R1 failure classification: ${PASS} passed, ${FAIL} failed`);
    if (FAIL > 0) { for (const f of failures) console.log('   - ' + f); process.exit(1); }
  });
