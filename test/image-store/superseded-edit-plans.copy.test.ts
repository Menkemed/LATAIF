// OWNER-WARTUNG — Prüflauf auf ISOLIERTEN KOPIEN echter Sicherungen (nicht im Repo, nicht produktiv).
//
//   SUPERSEDED_COPY_DB      = Pfad(e) zu DB-KOPIEN, durch ';' getrennt (die Datei wird nur gelesen und in
//                             sql.js im Speicher geöffnet; zurückgeschrieben wird nie)
//   SUPERSEDED_COPY_JOURNAL = Ordner `.ingest-journal` einer Sicherung (nur Verzeichnisliste)
//
// Ohne diese Variablen: übersprungen (der reguläre Lauf hat keine Sicherung). Benutzt die PRODUKTIONSLISTE
// der zwei Vorgänge und den echten Coordinator; Rust ist durch eine Attrappe vertreten, die jeden Aufruf
// mit einem Fehler beantwortet — der Abbruch braucht Rust nur für die Journal-Liste.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import initSqlJs from 'sql.js';
import { MediaDbCoordinator } from '../../src/core/media/coordinator.ts';
import { findProductsNeedingEmbedding } from '../../src/core/media/embedding-reconcile.ts';
import { assertMigrationPreconditions, type MigrationDb } from '../../src/core/media/image-store-migration.ts';
import {
  SUPERSEDED_EDIT_PLAN_CASES, EDIT_PLAN_SUPERSEDED, inspectSupersededEditPlan, closeSupersededEditPlan,
  type SupersededDeps, type SupersededDb,
} from '../../src/core/media/superseded-edit-plans.ts';
import type { MediaCommandGateway } from '../../src/core/media/gateway.ts';

const here = dirname(fileURLToPath(import.meta.url));
const WASM = join(here, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
const DBS = (process.env.SUPERSEDED_COPY_DB ?? '').split(';').map((s) => s.trim()).filter(Boolean);
const JOURNAL = process.env.SUPERSEDED_COPY_JOURNAL ?? '';

let PASS = 0, FAIL = 0;
const failures: string[] = [];
function ok(cond: unknown, msg: string): void {
  if (cond) PASS++;
  else { FAIL++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}
function q(db: any, sql: string, p: unknown[] = []): any[] {
  const r = db.exec(sql, p);
  if (!r.length) return [];
  return r[0].values.map((v: unknown[]) => Object.fromEntries(r[0].columns.map((c: string, i: number) => [c, v[i]])));
}
const h = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
function digest(db: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of ['products', 'media_links', 'media_objects', 'media_variants', 'media_blobs', 'media_blob_generations', 'sync_changelog']) {
    out[t] = h(JSON.stringify(q(db, `SELECT * FROM ${t} ORDER BY rowid`)));
  }
  return out;
}
const noRust = new Proxy({}, { get: () => async () => { throw new Error('NO_RUST_CALL_EXPECTED'); } }) as unknown as MediaCommandGateway;
const OWNER = { userId: 'user-owner', role: 'owner' };

async function main(): Promise<void> {
  if (DBS.length === 0 || !JOURNAL) { console.log('SUPERSEDED-EDIT-PLANS COPY: skipped (no isolated copy given)'); return; }
  const SQL = await initSqlJs({ locateFile: () => WASM });
  const journalNames = readdirSync(JOURNAL);
  for (const path of DBS) {
    console.log(`\n=== Kopie ${path.split(/[\\/]/).pop()}`);
    const db = new SQL.Database(readFileSync(path)); // im Speicher; die Datei bleibt unberührt
    const coord = new MediaDbCoordinator(db, noRust);
    const journalAsked: string[] = [];
    const deps: SupersededDeps = {
      db: db as SupersededDb, inspect: (t, r) => coord.inspectStoredEditPlan(t, r),
      journalPresent: async (t, rid) => { journalAsked.push(rid); return journalNames.some((n) => n.startsWith(`${t}__${rid}.`)); },
      now: () => '2026-11-15T12:00:00.000Z',
    };
    const ids = SUPERSEDED_EDIT_PLAN_CASES.map((c) => c.jobId);
    const pids = SUPERSEDED_EDIT_PLAN_CASES.map((c) => c.productId);

    // vorher
    ok(ids.every((id) => q(db, `SELECT state FROM media_ingest_jobs WHERE job_id = ?`, [id])[0]?.state === 'accepted'), 'vorher: beide Jobs accepted');
    const rec0 = await coord.recover();
    const act0 = SUPERSEDED_EDIT_PLAN_CASES.map((c) => `${c.sku}:${rec0.find((r) => r.ingestRequestId === c.ingestRequestId)?.action}`);
    console.log('  Wiederherstellung vorher:', act0.join(' · '));
    ok(act0.join() === 'TAG-WCH-004:left_pending_edit_product_changed,CAR-OGJ-001:left_pending_edit_baseline_changed', 'vorher: Wiederherstellung lässt beide liegen');
    const emb0 = findProductsNeedingEmbedding(db).map((s) => s.productId);
    ok(pids.every((p) => !emb0.includes(p)), `vorher: beide fehlen im Embedding-Abgleich (Kandidaten: ${emb0.length})`);
    let mig0 = '';
    try { assertMigrationPreconditions(db as MigrationDb); } catch (e) { mig0 = (e as Error).message; }
    ok(mig0 !== '', `vorher: Bildmigration blockiert (${mig0})`);

    // prüfen
    const d0 = digest(db);
    const audit0 = Number(q(db, `SELECT COUNT(*) AS n FROM audit_log`)[0].n);
    const others0 = h(JSON.stringify(q(db, `SELECT * FROM media_ingest_jobs WHERE job_id NOT IN (?, ?) ORDER BY rowid`, ids)));
    const plans0 = q(db, `SELECT job_id, result_json, request_hash FROM media_ingest_jobs WHERE job_id IN (?, ?) ORDER BY job_id`, ids);
    const fps: Record<string, string> = {};
    for (const c of SUPERSEDED_EDIT_PLAN_CASES) {
      const v = await inspectSupersededEditPlan(deps, c.jobId);
      ok(v.status === 'closable', `${c.sku}: erkannt (${v.status}${v.status === 'refused' ? ' ' + v.code : ''})`);
      if (v.status === 'closable') {
        fps[c.jobId] = v.fingerprint;
        const e = v.evidence;
        console.log(`  ${c.sku}: Galerie am Ausgangsstand=${e.galleryAtBaseline} am Ziel=${e.galleryAtTarget} · Artikel Ausgang=${e.productAtBaseline} Ziel=${e.productAtTarget} · Nachfolger ${e.successor.state} ${e.successor.completedAt} · neue Bilder ${e.newImageRequestIds.length} (Journal: keins)`);
      }
    }
    ok(journalAsked.length === 1 && journalAsked[0] === '9a3c99a61c1f7b1915248be48ce75a140c22fc9155c6e3c08d6118cb37fc499c', 'Rust-Journal nur für das eine neue Bild (CAR-OGJ-001) gefragt — nicht vorhanden');
    ok(JSON.stringify(digest(db)) === JSON.stringify(d0), 'Prüfen schreibt nichts');

    // Abweisung: anderer Job / kein Owner
    ok((await closeSupersededEditPlan(deps, `job-${SUPERSEDED_EDIT_PLAN_CASES[0].supersededByIngestRequestId}`, 'x', OWNER) as { code?: string }).code === 'SUPERSEDED_NOT_ALLOWLISTED', 'der Nachfolger-Job ist nicht abbrechbar');
    ok((await closeSupersededEditPlan(deps, ids[0], fps[ids[0]], { userId: 'x', role: 'sales' }) as { code?: string }).code === 'SUPERSEDED_NOT_OWNER', 'nur Owner');

    // abbrechen
    for (const c of SUPERSEDED_EDIT_PLAN_CASES) {
      const r = await closeSupersededEditPlan(deps, c.jobId, fps[c.jobId], OWNER);
      ok(r.status === 'closed', `${c.sku}: abgebrochen (${r.status})`);
    }
    const jobs1 = q(db, `SELECT job_id, state, error_code, completed_at, result_json, request_hash FROM media_ingest_jobs WHERE job_id IN (?, ?) ORDER BY job_id`, ids);
    ok(jobs1.every((j: any) => j.state === 'failed' && j.error_code === EDIT_PLAN_SUPERSEDED && j.completed_at), 'beide failed / MEDIA_EDIT_PLAN_SUPERSEDED');
    ok(jobs1.every((j: any, i: number) => j.result_json === plans0[i].result_json && j.request_hash === plans0[i].request_hash), 'gespeicherte Pläne unverändert');
    ok(JSON.stringify(digest(db)) === JSON.stringify(d0), 'Artikel, Medien, Zuordnungen, Generationen, sync_changelog unverändert');
    ok(h(JSON.stringify(q(db, `SELECT * FROM media_ingest_jobs WHERE job_id NOT IN (?, ?) ORDER BY rowid`, ids))) === others0, 'alle anderen Jobs unverändert');
    ok(Number(q(db, `SELECT COUNT(*) AS n FROM audit_log`)[0].n) === audit0 + 2 && q(db, `SELECT COUNT(*) AS n FROM audit_log WHERE module = 'Media' AND entity_type = 'media_ingest_jobs'`)[0].n === 2, 'genau zwei Audit-Zeilen');

    // erneut
    for (const c of SUPERSEDED_EDIT_PLAN_CASES) {
      ok((await closeSupersededEditPlan(deps, c.jobId, fps[c.jobId], OWNER)).status === 'already_closed', `${c.sku}: erneuter Aufruf already_closed`);
    }
    ok(Number(q(db, `SELECT COUNT(*) AS n FROM audit_log`)[0].n) === audit0 + 2 && JSON.stringify(digest(db)) === JSON.stringify(d0), 'erneuter Aufruf schreibt nichts');

    // Wirkung
    const rec1 = await coord.recover();
    ok(SUPERSEDED_EDIT_PLAN_CASES.every((c) => rec1.find((r) => r.ingestRequestId === c.ingestRequestId)?.action === 'noop_terminal_state'), 'Wiederherstellung: beide Endzustand');
    const emb1 = findProductsNeedingEmbedding(db).map((s) => s.productId);
    ok(pids.every((p) => emb1.includes(p)) && emb1.length === emb0.length + 2, `Embedding-Abgleich: beide wieder Kandidaten (${emb1.length}, vorher ${emb0.length})`);
    let mig1 = '';
    try { assertMigrationPreconditions(db as MigrationDb); } catch (e) { mig1 = (e as Error).message; }
    ok(mig1 === '', 'Bildmigration: keine Blockade mehr');
    db.close();
  }
  console.log(`\nSUPERSEDED-EDIT-PLANS COPY: ${PASS} passed, ${FAIL} failed`);
  if (FAIL > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
