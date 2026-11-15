// ════════════════════════════════════════════════════════════════════════════
// OWNER-WARTUNG — zwei überholte Handy-Galerie-Bearbeitungen kontrolliert abbrechen.
//
// Befund (Sicherungen 10.11. + 14.11.2026): zwei `media_ingest_jobs` stehen seit dem 25.08. bzw. 03.10.2026
// auf `accepted`. Beide wollten den Einkaufspreis leeren (NOT NULL) und scheiterten; die Handy-Aufträge sind
// `quarantined`; ein späterer Handy-Auftrag hat die Absicht jeweils erfolgreich umgesetzt. Die Wiederherstellung
// lässt die zwei bei jedem Start liegen (Ausgangsstand geändert) — sie blockieren damit den Embedding-Abgleich
// der zwei Artikel und die Bildmigration.
//
// Diese Funktion ist bewusst KEINE allgemeine Bereinigung: zugelassen sind ausschließlich die zwei unten fest
// eingetragenen Jobs. Jede Abweichung von dem, was der Befund belegt, weist ab (fail-closed, keine Mutation).
//
//   prüfen  → Job + Artikel exakt wie eingetragen · Zustand `accepted` · Plan lesbar und gehört zum Job ·
//             Ausgangsstand überholt und Plan nicht mehr anwendbar (dieselbe Rechnung wie applyEditBatch) ·
//             späterer erfolgreicher Auftrag für denselben Artikel vom selben Ausgangsstand · keine Bilddatei
//             und keine Änderung hängt mehr am Job (keine Temp-/Zielspalten, kein Objekt/Link/Generation der
//             neuen Bilder, kein Rust-Journal) → Fingerabdruck
//   abbrechen → nur mit dem Fingerabdruck der Prüfung, in EINER Transaktion: Job → `failed` +
//             `MEDIA_EDIT_PLAN_SUPERSEDED` (bedingtes UPDATE, genau eine Zeile) + eine Audit-Zeile.
//             `result_json` (der Plan) bleibt unverändert stehen. Kein Artikel, keine Medienzeile, kein
//             sync_changelog. Erneuter Aufruf: `already_closed`, schreibt nichts.
// ════════════════════════════════════════════════════════════════════════════
import { canonicalRole } from '../models/types.ts';
import { enterTransaction, leaveNestedTransaction, resetTransactionContext } from '../db/transaction-context.ts';
import { editRequestId, type StoredEditPlanView } from './coordinator.ts';
import { mediaIdFor } from './ids.ts';

export const EDIT_PLAN_SUPERSEDED = 'MEDIA_EDIT_PLAN_SUPERSEDED';

export interface SupersededEditPlanCase {
  sku: string;
  tenantId: string;
  branchId: string;
  jobId: string;
  ingestRequestId: string;
  /** `request_hash` = planHash des eingefrorenen Plans. */
  requestHash: string;
  productId: string;
  role: string;
  createdAt: string;
  /** Der spätere, erfolgreiche Handy-Auftrag für denselben Artikel. */
  supersededByIngestRequestId: string;
}

const T = 'tenant-1';
const B = 'branch-main';
const gid = (pid: string, ev: string) => `gallery-edit:${T}:${B}:${pid}:stock_image:${ev}`;

/** Die zwei — und nur diese zwei — zugelassenen Vorgänge (Befund vom 15.11.2026). */
export const SUPERSEDED_EDIT_PLAN_CASES: readonly SupersededEditPlanCase[] = Object.freeze([
  {
    sku: 'TAG-WCH-004', tenantId: T, branchId: B, role: 'stock_image',
    productId: '753561c6-6dc4-4a18-8aba-d20047610e31',
    jobId: `job-edit:${gid('753561c6-6dc4-4a18-8aba-d20047610e31', 'eeba8daf-baa2-4521-9e29-9940dfc24822')}`,
    ingestRequestId: `edit:${gid('753561c6-6dc4-4a18-8aba-d20047610e31', 'eeba8daf-baa2-4521-9e29-9940dfc24822')}`,
    requestHash: '0056ea5ddef22cf817a0b6b9057446a89ee67f4aa455804c47ac6a91c2a64a96',
    createdAt: '2026-08-25T19:11:19.098Z',
    supersededByIngestRequestId: `edit:${gid('753561c6-6dc4-4a18-8aba-d20047610e31', 'ffc71801-7d32-4921-b27f-49855020116f')}`,
  },
  {
    sku: 'CAR-OGJ-001', tenantId: T, branchId: B, role: 'stock_image',
    productId: 'b34529ca-7c4b-42bc-9a1e-57eb95548266',
    jobId: `job-edit:${gid('b34529ca-7c4b-42bc-9a1e-57eb95548266', 'fdbf065c-d042-4533-b2ff-e0095074345b')}`,
    ingestRequestId: `edit:${gid('b34529ca-7c4b-42bc-9a1e-57eb95548266', 'fdbf065c-d042-4533-b2ff-e0095074345b')}`,
    requestHash: 'ff7eb90bfe60ace93883939c5a763d0507272b1b42c4a3f6afcb969a3d4621e8',
    createdAt: '2026-10-03T10:51:27.807Z',
    supersededByIngestRequestId: `edit:${gid('b34529ca-7c4b-42bc-9a1e-57eb95548266', '9229cb35-9497-4614-89ea-04cf2e9a587a')}`,
  },
].map((c) => Object.freeze(c)));

export type SupersededRefusal =
  | 'SUPERSEDED_NOT_OWNER'
  | 'SUPERSEDED_NOT_ALLOWLISTED'
  | 'SUPERSEDED_JOB_MISSING'
  | 'SUPERSEDED_JOB_MISMATCH'
  | 'SUPERSEDED_PRODUCT_MISMATCH'
  | 'SUPERSEDED_STATE_CHANGED'
  | 'SUPERSEDED_PLAN_UNREADABLE'
  | 'SUPERSEDED_BASELINE_CURRENT'
  | 'SUPERSEDED_PLAN_STILL_APPLICABLE'
  | 'SUPERSEDED_NO_SUCCESSOR'
  | 'SUPERSEDED_PENDING_MEDIA'
  | 'SUPERSEDED_JOURNAL_PRESENT'
  | 'SUPERSEDED_FINGERPRINT_CHANGED'
  | 'SUPERSEDED_CAS_FAILED';

export interface SupersededEvidence {
  sku: string;
  productId: string;
  jobId: string;
  jobState: string;
  createdAt: string;
  galleryAtBaseline: boolean;
  galleryAtTarget: boolean;
  productAtBaseline: boolean | null;
  productAtTarget: boolean | null;
  successor: { ingestRequestId: string; state: string; completedAt: string | null };
  /** Anfrage-Kennungen der neuen Bilder im alten Plan (Rust-Journal geprüft: keins vorhanden). */
  newImageRequestIds: string[];
}

export type SupersededVerdict =
  | { status: 'closable'; jobId: string; fingerprint: string; evidence: SupersededEvidence }
  | { status: 'already_closed'; jobId: string; evidence: Pick<SupersededEvidence, 'sku' | 'productId' | 'jobId' | 'jobState'> & { errorCode: string; completedAt: string | null } }
  | { status: 'refused'; jobId: string; code: SupersededRefusal; detail: string };

export type SupersededCloseResult =
  | { status: 'closed'; jobId: string; auditId: string; closedAt: string; evidence: SupersededEvidence }
  | Exclude<SupersededVerdict, { status: 'closable' }>;

type Row = Record<string, unknown>;
export interface SupersededDb {
  run(sql: string, params?: unknown[] | Record<string, unknown>): void;
  exec(sql: string, params?: unknown[] | Record<string, unknown>): Array<{ columns: string[]; values: unknown[][] }>;
}

export interface SupersededDeps {
  db: SupersededDb;
  /** `MediaDbCoordinator.inspectStoredEditPlan` auf derselben DB — dieselbe Konvergenzrechnung wie die Anwendung. */
  inspect: (tenantId: string, ingestRequestId: string) => StoredEditPlanView | null;
  /** Rust, nur lesend: liegt für diese Anfrage noch ein Journal-Eintrag oder eine Temp-Datei? */
  journalPresent: (tenantScope: string, ingestRequestId: string) => Promise<boolean>;
  now?: () => string;
  /** Nur Tests: eine andere Liste zugelassener Vorgänge. Produktion: immer die zwei oben. */
  cases?: readonly SupersededEditPlanCase[];
}

export interface SupersededActor { userId: string | null; role: string | null | undefined }

function rows(db: SupersededDb, sql: string, params: unknown[] = []): Row[] {
  const r = db.exec(sql, params);
  if (!r.length) return [];
  return r[0].values.map((v) => Object.fromEntries(r[0].columns.map((c, i) => [c, v[i]])));
}

const s = (v: unknown): string | null => (v == null ? null : String(v));

function findCase(deps: SupersededDeps, jobId: string): SupersededEditPlanCase | null {
  return (deps.cases ?? SUPERSEDED_EDIT_PLAN_CASES).find((c) => c.jobId === jobId) ?? null;
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const refuse = (jobId: string, code: SupersededRefusal, detail: string): SupersededVerdict => ({ status: 'refused', jobId, code, detail });

/**
 * Der synchrone Teil der Prüfung (alles außer dem Rust-Journal). Liefert die Neu-Bild-Kennungen, damit der
 * Aufrufer das Journal VOR dem synchronen Abschnitt prüfen kann, und den Text für den Fingerabdruck.
 */
function inspectSync(deps: SupersededDeps, c: SupersededEditPlanCase):
  | { kind: 'verdict'; verdict: SupersededVerdict }
  | { kind: 'candidate'; evidence: SupersededEvidence; fingerprintText: string } {
  const view = deps.inspect(c.tenantId, c.ingestRequestId);
  if (!view) return { kind: 'verdict', verdict: refuse(c.jobId, 'SUPERSEDED_JOB_MISSING', 'job not found') };
  const j = view.job;

  // 1) exakte Kennung und Artikelzuordnung
  const idOk =
    s(j.tenant_id) === c.tenantId && s(j.job_id) === c.jobId && s(j.ingest_request_id) === c.ingestRequestId &&
    s(j.request_hash) === c.requestHash && s(j.scope_kind) === 'branch' && s(j.branch_id) === c.branchId &&
    s(j.requested_entity_type) === 'product' && s(j.requested_entity_id) === c.productId &&
    s(j.requested_role) === c.role && s(j.created_at) === c.createdAt;
  if (!idOk) return { kind: 'verdict', verdict: refuse(c.jobId, 'SUPERSEDED_JOB_MISMATCH', 'job identity differs from the recorded finding') };
  const prod = rows(deps.db, 'SELECT id, sku FROM products WHERE id = ?', [c.productId]);
  if (prod.length !== 1 || s(prod[0].sku) !== c.sku) {
    return { kind: 'verdict', verdict: refuse(c.jobId, 'SUPERSEDED_PRODUCT_MISMATCH', 'product missing or SKU differs') };
  }

  // 2) Zustand: nur `accepted` ist abbrechbar; der eigene Abbruch ist ein No-op
  const state = String(j.state);
  if (state === 'failed' && s(j.error_code) === EDIT_PLAN_SUPERSEDED) {
    return { kind: 'verdict', verdict: { status: 'already_closed', jobId: c.jobId, evidence: { sku: c.sku, productId: c.productId, jobId: c.jobId, jobState: state, errorCode: EDIT_PLAN_SUPERSEDED, completedAt: s(j.completed_at) } } };
  }
  if (state !== 'accepted') return { kind: 'verdict', verdict: refuse(c.jobId, 'SUPERSEDED_STATE_CHANGED', `job state is ${state}`) };

  // 3) der eingefrorene Plan gehört zu genau diesem Job
  const env = view.env;
  const conv = view.convergence;
  if (view.corrupt || !env || !conv) return { kind: 'verdict', verdict: refuse(c.jobId, 'SUPERSEDED_PLAN_UNREADABLE', 'result_json is not a readable edit plan') };
  const p = env.plan;
  if (editRequestId(p.batchId) !== c.ingestRequestId || p.planHash !== c.requestHash || p.entityType !== 'product' ||
      p.entityId !== c.productId || p.role !== c.role || p.tenantId !== c.tenantId || p.branchId !== c.branchId) {
    return { kind: 'verdict', verdict: refuse(c.jobId, 'SUPERSEDED_PLAN_UNREADABLE', 'plan does not belong to this job') };
  }

  // 4) Ausgangsstand überholt UND Plan nicht mehr anwendbar — die Rechnung von applyEditBatch
  if (conv.galleryAtBaseline) return { kind: 'verdict', verdict: refuse(c.jobId, 'SUPERSEDED_BASELINE_CURRENT', 'gallery is still at the plan baseline') };
  if (conv.wouldApply) return { kind: 'verdict', verdict: refuse(c.jobId, 'SUPERSEDED_PLAN_STILL_APPLICABLE', 'recovery would still apply this plan') };

  // 5) späterer, erfolgreicher Auftrag für denselben Artikel, vom selben Ausgangsstand aus
  const succ = deps.inspect(c.tenantId, c.supersededByIngestRequestId);
  const sj = succ?.job;
  const succOk = !!succ && !!sj && !succ.corrupt && !!succ.env && !!succ.convergence &&
    s(sj.state) === 'ready' && s(sj.completed_at) != null &&
    s(sj.scope_kind) === 'branch' && s(sj.branch_id) === c.branchId &&
    s(sj.requested_entity_type) === 'product' && s(sj.requested_entity_id) === c.productId && s(sj.requested_role) === c.role &&
    String(sj.created_at) > c.createdAt &&
    succ.env.plan.entityId === c.productId &&
    succ.convergence.baselineGallerySignature === conv.baselineGallerySignature;
  if (!succOk) return { kind: 'verdict', verdict: refuse(c.jobId, 'SUPERSEDED_NO_SUCCESSOR', 'no later successful edit from the same baseline') };

  // 6) nichts hängt mehr am alten Job
  if (j.source_temp_key != null || j.hq_temp_key != null || j.target_media_id != null || j.target_blob_id != null) {
    return { kind: 'verdict', verdict: refuse(c.jobId, 'SUPERSEDED_PENDING_MEDIA', 'job still references staged or target media') };
  }
  const newIds = p.target.filter((t) => t.source === 'new').map((t) => (t as { requestId: string }).requestId);
  for (const rid of newIds) {
    const mid = mediaIdFor(rid);
    const hit = rows(deps.db, `SELECT (SELECT COUNT(*) FROM media_objects WHERE media_id = ?) + (SELECT COUNT(*) FROM media_links WHERE media_id = ?) AS n`, [mid, mid]);
    if (Number(hit[0]?.n ?? 0) > 0) return { kind: 'verdict', verdict: refuse(c.jobId, 'SUPERSEDED_PENDING_MEDIA', 'a new image of the plan exists as media') };
  }
  for (const r of env.newRenditions ?? []) {
    for (const k of [r.main?.storage_key, r.thumbnail?.storage_key]) {
      if (!k) continue;
      const g = rows(deps.db, 'SELECT COUNT(*) AS n FROM media_blob_generations WHERE storage_key = ?', [k]);
      if (Number(g[0]?.n ?? 0) > 0) return { kind: 'verdict', verdict: refuse(c.jobId, 'SUPERSEDED_PENDING_MEDIA', 'a rendition of the plan is a stored generation') };
    }
  }

  const evidence: SupersededEvidence = {
    sku: c.sku, productId: c.productId, jobId: c.jobId, jobState: state, createdAt: c.createdAt,
    galleryAtBaseline: conv.galleryAtBaseline, galleryAtTarget: conv.galleryAtTarget,
    productAtBaseline: conv.productAtBaseline, productAtTarget: conv.productAtTarget,
    successor: { ingestRequestId: c.supersededByIngestRequestId, state: String(sj!.state), completedAt: s(sj!.completed_at) },
    newImageRequestIds: newIds,
  };
  // Fingerabdruck: der ganze Job (jede Spalte), die heutige Galerie, die Produktwerte der Plan-Spalten,
  // der Nachfolger. Ändert sich davon irgendetwas zwischen Prüfung und Abbruch, wird nicht geschrieben.
  const productCols = (p.productEdit?.set ?? []).map(([col]) => col);
  const productVals = productCols.length
    ? rows(deps.db, `SELECT ${productCols.join(', ')} FROM products WHERE id = ?`, [c.productId])[0] ?? null
    : null;
  const jobSorted = Object.fromEntries(Object.keys(j).sort().map((k) => [k, j[k] ?? null]));
  const fingerprintText = JSON.stringify({
    job: jobSorted, gallery: conv.currentGallerySignature, product: productVals,
    successor: { state: sj!.state ?? null, completed_at: sj!.completed_at ?? null, updated_at: sj!.updated_at ?? null, request_hash: sj!.request_hash ?? null },
  });
  return { kind: 'candidate', evidence, fingerprintText };
}

/** Prüfen (nur lesend). Für jeden nicht eingetragenen Job: `SUPERSEDED_NOT_ALLOWLISTED`. */
export async function inspectSupersededEditPlan(deps: SupersededDeps, jobId: string): Promise<SupersededVerdict> {
  const c = findCase(deps, jobId);
  if (!c) return refuse(jobId, 'SUPERSEDED_NOT_ALLOWLISTED', 'only the recorded jobs may be closed');
  const first = inspectSync(deps, c);
  if (first.kind === 'verdict') return first.verdict;
  for (const rid of first.evidence.newImageRequestIds) {
    if (await deps.journalPresent(c.tenantId, rid)) return refuse(c.jobId, 'SUPERSEDED_JOURNAL_PRESENT', 'Rust still holds a journal entry or temp file for a new image');
  }
  return { status: 'closable', jobId: c.jobId, fingerprint: await sha256Hex(first.fingerprintText), evidence: first.evidence };
}

/**
 * Abbrechen — nur der Owner, nur ein zugelassener Job, nur mit dem Fingerabdruck einer vorherigen Prüfung.
 * Der Aufrufer hält die Medien-Sperre + den DB-Lease und speichert danach durabel (einmal).
 */
export async function closeSupersededEditPlan(
  deps: SupersededDeps, jobId: string, expectedFingerprint: string, actor: SupersededActor,
  /** Owner-Angaben aus der Bestätigung (Grund, Name der geprüften Sicherung) — werden mitprotokolliert. */
  note?: { reason?: string; backupRef?: string },
): Promise<SupersededCloseResult> {
  if (canonicalRole(actor.role ?? undefined) !== 'ADMIN') {
    return { status: 'refused', jobId, code: 'SUPERSEDED_NOT_OWNER', detail: 'only the owner may close a superseded edit plan' };
  }
  // Rust-Journal zuerst (asynchron); danach läuft alles bis zum COMMIT synchron — nichts kann dazwischen schreiben.
  const pre = await inspectSupersededEditPlan(deps, jobId);
  if (pre.status !== 'closable') return pre;
  const c = findCase(deps, jobId)!;
  const again = inspectSync(deps, c);
  if (again.kind === 'verdict') return again.verdict as SupersededCloseResult; // inspectSync liefert nie `closable`
  const fp = await sha256Hex(again.fingerprintText);
  if (fp !== expectedFingerprint || fp !== pre.fingerprint) {
    return { status: 'refused', jobId, code: 'SUPERSEDED_FINGERPRINT_CHANGED', detail: 'the job or its surroundings changed since the check' };
  }
  // Ab hier synchron bis zum Ende der Transaktion.
  const recheck = inspectSync(deps, c);
  if (recheck.kind !== 'candidate' || recheck.fingerprintText !== again.fingerprintText) {
    return { status: 'refused', jobId, code: 'SUPERSEDED_FINGERPRINT_CHANGED', detail: 'the job changed during the close' };
  }
  const job = deps.inspect(c.tenantId, c.ingestRequestId)!.job;
  const now = deps.now ? deps.now() : new Date().toISOString();
  const auditId = `audit-media-maint-superseded:${c.jobId}`;
  const ownerNote = { ownerReason: note?.reason ?? null, backupRef: note?.backupRef ?? null };
  const detail = JSON.stringify({ reason: 'superseded', supersededBy: c.supersededByIngestRequestId, sku: c.sku, checkedFingerprint: fp, ...ownerNote });

  const outermost = enterTransaction();
  if (outermost) deps.db.run('BEGIN IMMEDIATE');
  try {
    deps.db.run(
      `UPDATE media_ingest_jobs
          SET state = 'failed', error_code = ?, error_detail_safe = ?, completed_at = ?, updated_at = ?
        WHERE tenant_id = ? AND job_id = ? AND ingest_request_id = ? AND state = 'accepted'
          AND request_hash = ? AND updated_at = ? AND attempt_count = ? AND result_json = ?`,
      [EDIT_PLAN_SUPERSEDED, detail, now, now, c.tenantId, c.jobId, c.ingestRequestId,
        c.requestHash, job.updated_at, job.attempt_count, job.result_json],
    );
    const changed = Number(rows(deps.db, 'SELECT changes() AS n')[0]?.n ?? 0);
    if (changed !== 1) throw Object.assign(new Error('SUPERSEDED_CAS_FAILED'), { code: 'SUPERSEDED_CAS_FAILED' });
    deps.db.run(
      `INSERT INTO audit_log (id, branch_id, module, entity_type, entity_id, action_type, field_name, old_value, new_value, changed_by, changed_at)
       VALUES (?, ?, 'Media', 'media_ingest_jobs', ?, 'STATUS_CHANGE', 'state', ?, ?, ?, ?)`,
      [auditId, c.branchId, c.jobId,
        JSON.stringify({ state: 'accepted', updated_at: job.updated_at }),
        JSON.stringify({ state: 'failed', error_code: EDIT_PLAN_SUPERSEDED, sku: c.sku, product_id: c.productId, superseded_by: c.supersededByIngestRequestId, reason: ownerNote.ownerReason, backup: ownerNote.backupRef }),
        actor.userId, now],
    );
    if (leaveNestedTransaction() && outermost) deps.db.run('COMMIT');
  } catch (e) {
    if (outermost) {
      resetTransactionContext();
      try { deps.db.run('ROLLBACK'); } catch { /* bereits zurückgerollt */ }
    }
    const code = (e as { code?: string })?.code;
    if (code === 'SUPERSEDED_CAS_FAILED') return { status: 'refused', jobId, code: 'SUPERSEDED_CAS_FAILED', detail: 'the job row changed' };
    throw e;
  }
  return { status: 'closed', jobId: c.jobId, auditId, closedAt: now, evidence: recheck.evidence };
}

// ── Nur lesend: Zustand für die einmalige Owner-Karte und die Nachkontrolle ─────────────────────

export interface SupersededCaseStatus {
  sku: string;
  productId: string;
  jobId: string;
  /** `missing`, wenn es den Job in dieser Datenbank nicht gibt (andere Installation). */
  jobState: string;
  /** Von DIESER Wartung abgebrochen (`failed` + MEDIA_EDIT_PLAN_SUPERSEDED). */
  closedByMaintenance: boolean;
  hasEmbedding: boolean;
  hasDescription: boolean;
}

/**
 * Für die Karte in „Data Repairs": sichtbar NUR, solange einer der zwei Jobs noch `accepted` ist oder
 * nach dem Abbruch das Embedding eines der zwei Artikel noch fehlt. Danach — und auf jeder Installation
 * ohne diese Jobs — erscheint nichts. Liest drei kleine Zeilen, schreibt nie.
 */
export function supersededEditPlansStatus(db: SupersededDb, cases: readonly SupersededEditPlanCase[] = SUPERSEDED_EDIT_PLAN_CASES): {
  cases: SupersededCaseStatus[];
  cardVisible: boolean;
} {
  const out: SupersededCaseStatus[] = cases.map((c) => {
    const j = rows(db, 'SELECT state, error_code FROM media_ingest_jobs WHERE tenant_id = ? AND job_id = ?', [c.tenantId, c.jobId])[0];
    const p = rows(db, `SELECT (image_embedding IS NOT NULL AND image_embedding <> '') AS emb, (image_description IS NOT NULL AND image_description <> '') AS des FROM products WHERE id = ?`, [c.productId])[0];
    const jobState = j ? String(j.state) : 'missing';
    return {
      sku: c.sku, productId: c.productId, jobId: c.jobId, jobState,
      closedByMaintenance: jobState === 'failed' && s(j?.error_code) === EDIT_PLAN_SUPERSEDED,
      hasEmbedding: Number(p?.emb ?? 0) === 1, hasDescription: Number(p?.des ?? 0) === 1,
    };
  });
  return { cases: out, cardVisible: out.some((x) => x.jobState === 'accepted' || (x.closedByMaintenance && !x.hasEmbedding)) };
}
