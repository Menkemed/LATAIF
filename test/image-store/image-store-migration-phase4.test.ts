// ════════════════════════════════════════════════════════════════════════════
// BILDSPEICHER Phase 4 — die Migration produktionsreif: Pakete im exklusiven Schreibplatz, sauberer Abbruch ohne
// verwaiste Dateien, keine Schachtelung in fremde Transaktionen, Bestandsübersicht ohne Doppelzählung, Owner-Pfad
// (Rolle vor jedem Paket), Wartungsmodus an/aus, Protokoll, Renderer-Riegel für Fernaufträge.
// Run: node test/image-store/image-store-migration-phase4.test.ts
//
// Echtes Medienschema (sql.js, alle Trigger), echter Coordinator; Rust durch einen deterministischen Ersatz.
// ════════════════════════════════════════════════════════════════════════════
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    if (specifier === '@/core/db/database' || ((specifier === './database' || specifier === '../db/database') && context.parentURL)) {
      return { url: pathToFileURL(resolvePath(repo, 'test/sync/_db-shim.ts')).href, shortCircuit: true };
    }
    if (specifier === '../auth/auth' && context.parentURL && context.parentURL.includes('/db/helpers')) {
      return { url: pathToFileURL(resolvePath(repo, 'test/sync/_auth-shim.ts')).href, shortCircuit: true };
    }
    if (specifier.startsWith('@/')) {
      const p = resolvePath(repo, 'src', specifier.slice(2));
      return { url: pathToFileURL(existsSync(p) ? p : p + '.ts').href, shortCircuit: true };
    }
    if (specifier.startsWith('.') && context.parentURL) {
      const p = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
      if (!existsSync(p) && existsSync(p + '.ts')) return { url: pathToFileURL(p + '.ts').href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
} as never);
const ls = new Map<string, string>([['lataif_session', JSON.stringify({ branchId: 'b1', userId: 'u1' })]]);
const storage = { getItem: (k: string) => ls.get(k) ?? null, setItem: (k: string, v: string) => { ls.set(k, String(v)); }, removeItem: (k: string) => { ls.delete(k); } };
(globalThis as { localStorage?: unknown }).localStorage = storage;
(globalThis as { window?: unknown }).window = { localStorage: storage };

const initSqlJs = (await import('sql.js')).default;
const { applyMediaSchema, MEDIA_ENTITY_SCOPE } = await import('../../src/core/db/media-schema.ts');
const { MediaDbCoordinator } = await import('../../src/core/media/coordinator.ts');
const eng = await import('../../src/core/media/image-store-migration.ts');
const wiring = await import('../../src/core/media/image-store-migration-wiring.ts');
const gate = await import('../../src/core/bridge/maintenance-gate.ts');
type MigrationDb = import('../../src/core/media/image-store-migration.ts').MigrationDb;
type RecompressArgs = import('../../src/core/media/image-store-migration.ts').RecompressArgs;
type RecompressOutcome = import('../../src/core/media/image-store-migration.ts').RecompressOutcome;

let PASS = 0, FAIL = 0;
const failures: string[] = [];
function ok(cond: unknown, msg: string): void { if (cond) PASS++; else { FAIL++; failures.push(msg); console.log(`  ✗ ${msg}`); } }
const pad64 = (s: string) => (s.toLowerCase().replace(/[^0-9a-f]/g, '0') + '0'.repeat(64)).slice(0, 64);
const key = (t: string, h: string) => `${t}/${h.slice(0, 2)}/${h}.jpg`;
const desc = (hash: string, size: number) => ({ hash, extension: 'jpg', content_kind: 'raster_image', mime_type: 'image/jpeg', byte_size: size, width: 1200, height: 900 });
function q(db: any, sql: string, p: unknown[] = []): any[] {
  const r = db.exec(sql, p); if (!r.length) return [];
  return r[0].values.map((v: unknown[]) => Object.fromEntries(r[0].columns.map((c: string, i: number) => [c, v[i]])));
}

class Gw {
  jobs = new Map<string, any>(); files = new Set<string>(); sizes = new Map<string, number>();
  preset(t: string, req: string, main: any, thumb: any) { this.jobs.set(`${t}::${req}`, { main, thumb }); this.files.add(main.hash); this.files.add(thumb.hash); this.sizes.set(main.hash, main.size); this.sizes.set(thumb.hash, thumb.size); }
  async prepareStockImage(i: any) { const j = this.jobs.get(`${i.tenantScope}::${i.ingestRequestId}`); return { ingest_request_id: i.ingestRequestId, request_hash: i.requestHash, state: 'prepared', main_descriptor: desc(j.main.hash, j.main.size), thumbnail_descriptor: desc(j.thumb.hash, j.thumb.size) }; }
  async commitStockImage(i: any) { const j = this.jobs.get(`${i.tenantScope}::${i.ingestRequestId}`); return { state: 'published', main_descriptor: desc(j.main.hash, j.main.size), thumbnail_descriptor: desc(j.thumb.hash, j.thumb.size), main_storage_key: key(i.tenantScope, j.main.hash), thumbnail_storage_key: key(i.tenantScope, j.thumb.hash) }; }
  async abortStockImage(i: any) { return { ingest_request_id: i.ingestRequestId, state: 'aborted' }; }
  async readVerifiedMedia(i: any) { const n = this.sizes.get(i.hash) ?? 3; return { bytes: new Uint8Array(n), hash: i.hash, byte_size: n, mime_type: 'image/jpeg', extension: 'jpg' }; }
  async recoverMediaIngests() { return []; }
}

/** Ersatz für `media_recompress_stored`: deterministisch; jede veröffentlichte Datei wird gemerkt. */
function fakeRust(published: Set<string>) {
  const calls: RecompressArgs[] = [];
  const fn = async (a: RecompressArgs): Promise<RecompressOutcome> => {
    calls.push(a);
    const hash = pad64(`e${a.rendition === 'main' ? 'a' : 'b'}${a.sourceHash.slice(0, 20)}${a.maxBytes}`);
    const size = Math.floor(a.maxBytes * 0.7);
    const pub = a.publish && (a.publishOnlyBelow == null || size < a.publishOnlyBelow);
    if (pub) published.add(key(a.tenantScope, hash));
    return { rendition: a.rendition, source_hash: a.sourceHash, source_byte_size: 0, hash, byte_size: size, width: 900, height: 600,
      extension: 'jpg', content_kind: 'raster_image', mime_type: 'image/jpeg', storage_key: key(a.tenantScope, hash), published: pub };
  };
  return { fn, calls };
}

async function world(SQL: any, n = 8) {
  const db = new SQL.Database();
  db.run(`CREATE TABLE tenants (id TEXT PRIMARY KEY)`); db.run(`CREATE TABLE branches (id TEXT PRIMARY KEY, tenant_id TEXT)`); db.run(`CREATE TABLE users (id TEXT PRIMARY KEY, tenant_id TEXT)`);
  for (const t of Object.values(MEDIA_ENTITY_SCOPE) as Array<{ table: string; idCol: string }>) db.run(`CREATE TABLE IF NOT EXISTS ${t.table} (id TEXT PRIMARY KEY, branch_id TEXT, tenant_id TEXT${t.idCol === 'id' ? '' : `, ${t.idCol} TEXT`})`);
  for (const c of ['images TEXT', 'category_id TEXT', 'image_hash TEXT', 'image_embedding TEXT', 'updated_at TEXT']) db.run(`ALTER TABLE products ADD COLUMN ${c}`);
  db.run(`ALTER TABLE repairs ADD COLUMN item_category_id TEXT`); db.run(`ALTER TABLE orders ADD COLUMN category_id TEXT`);
  db.run(`CREATE TABLE sync_changelog (id INTEGER PRIMARY KEY, table_name TEXT, record_id TEXT, data TEXT)`);
  db.run(`CREATE TABLE audit_log (id INTEGER PRIMARY KEY, entity_type TEXT, entity_id TEXT)`);
  db.run(`INSERT INTO tenants VALUES ('t1')`); db.run(`INSERT INTO branches VALUES ('b1','t1')`);
  applyMediaSchema(db);
  const gw = new Gw(); const coord = new MediaDbCoordinator(db, gw as never);
  let k = 0;
  const add = async (entityType: string, id: string, cat: string | null, mainSize: number, thumbSize: number, extra: Record<string, unknown> = {}) => {
    k++;
    if (entityType === 'product') db.run(`INSERT INTO products (id, branch_id, images, category_id, updated_at) VALUES (?, 'b1', '[]', ?, '2026-11-10')`, [id, cat]);
    if (entityType === 'customer') db.run(`INSERT INTO customers (id, branch_id) VALUES (?, 'b1')`, [id]);
    const req = `req-${id}`; const main = { hash: pad64(`a${k}a${id.length}`), size: mainSize }; const thumb = { hash: pad64(`b${k}b${id.length}`), size: thumbSize };
    gw.preset('t1', req, main, thumb);
    return coord.finalize({ tenantId: 't1', branchId: 'b1', entityType, entityId: id, scopeKind: 'branch', role: 'stock_image', ingestRequestId: req, requestHash: pad64(`c${k}`), isPrimary: true, sortOrder: 0, ...extra } as never);
  };
  for (let i = 0; i < n; i++) await add('product', `p-w${i}`, i % 2 ? 'cat-watch' : 'cat-gold-jewelry', 90_000, 16_000);
  await add('product', 'p-small', 'cat-watch', 40_000, 8_000);
  await add('customer', 'c1', null, 95_000, 19_000, { role: 'identity_document', securityClass: 'sensitive' });
  await add('product', 'p-old', 'cat-watch', 92_000, 18_000);
  db.run(`UPDATE media_links SET deleted_at = '2026-11-01' WHERE entity_id = 'p-old'`);
  return { db, gw };
}
const referencedKeys = (db: any) => new Set(q(db, `SELECT storage_key AS k FROM media_blob_generations`).map((r) => String(r.k)));

async function main(): Promise<void> {
  const SQL = await initSqlJs({ locateFile: (f: string) => join(repo, 'node_modules', 'sql.js', 'dist', f) });

  // ── §1 Bestandsübersicht: jede Datei genau einmal, Haupt-/Vorschaubild getrennt ──────────────
  { console.log('  … §1');
    const { db } = await world(SQL);
    const inv = eng.inventoryImageStore(db as MigrationDb);
    const plan = eng.planImageStoreMigration(db as MigrationDb);
    ok(inv.blobsPresent === 22 && inv.byRendition.main === 11 && inv.byRendition.thumbnail === 11, `§1 22 Dateien = 11 Haupt- + 11 Vorschaubilder (${JSON.stringify(inv.byRendition)})`);
    ok(inv.notLinked.main === 1 && inv.notLinked.thumbnail === 1, '§1 entferntes Foto: 1 Haupt- + 1 Vorschaubild nur noch historisch');
    ok(inv.decision.main.planned === plan.plans.filter((p) => p.rendition === 'main').length && inv.decision.thumbnail.planned === plan.plans.filter((p) => p.rendition === 'thumbnail').length, '§1 geplant je Fassung = Planung');
    ok(inv.decision.main.planned === 8 && inv.decision.main.already_small === 1 && inv.decision.main.excluded_security === 1, `§1 Hauptbilder: 8 über der Grenze, 1 klein, 1 Ausweis (${JSON.stringify(inv.decision.main)})`);
    ok(inv.balanced, '§1 Summen gehen auf: sichtbar + historisch = alle; geplant + übersprungen = sichtbar');
  }

  // ── §2 Pakete: jedes Paket im exklusiven Platz, endet gespeichert; Fortschritt zählt ─────────────
  { console.log('  … §2');
    const { db } = await world(SQL);
    const published = new Set<string>(); const r = fakeRust(published);
    let inside = false, entries = 0, saves = 0, savesOutside = 0; const progress: any[] = [];
    const rep = await eng.runImageStoreMigration({
      db: db as MigrationDb, recompress: r.fn, journal: () => {},
      saveDurably: async () => { saves++; if (!inside) savesOutside++; },
      exclusive: async (fn) => { entries++; inside = true; try { return await fn(); } finally { inside = false; } },
      progress: (p) => progress.push(p),
    }, { mode: 'apply', saveEvery: 4 });
    ok(rep.total === 16 && rep.plannedByRendition.main === 8 && rep.plannedByRendition.thumbnail === 8, `§2 Plan: 16 Bilder (8 Haupt, 8 Vorschau) (${rep.total})`);
    ok(rep.switched === 16 && rep.failed === 0 && !rep.stoppedEarly, `§2 alle umgestellt (${rep.switched})`);
    ok(entries === 1 + 4 && saves === 4 && savesOutside === 0, `§2 Planung + 4 Pakete à 4, jedes Paket im Platz gespeichert (Plätze ${entries}, Speichern ${saves}, außerhalb ${savesOutside})`);
    ok(progress.at(-1)?.done === 16 && progress.at(-1)?.total === 16 && progress.at(-1)?.running === false && progress.every((p, i) => i === 0 || p.done >= progress[i - 1].done), '§2 Fortschritt erledigt/gesamt steigt bis 16/16, am Ende „läuft nicht"');
    ok([...published].every((k) => referencedKeys(db).has(k)), '§2 jede veröffentlichte Datei hat ihre Generation (keine Waise)');
  }

  // ── §3 Abbruch mitten im Paket: angehalten zwischen zwei Bildern, Paket gespeichert, keine Waise ──────
  { console.log('  … §3');
    const { db } = await world(SQL);
    const published = new Set<string>(); const r = fakeRust(published);
    let saves = 0, sw = 0, savedAt = -1;
    const rep = await eng.runImageStoreMigration({
      db: db as MigrationDb, recompress: r.fn, saveDurably: async () => { saves++; savedAt = sw; },
      journal: (e) => { if (e.event === 'switched') sw++; },
    }, { mode: 'apply', saveEvery: 5, shouldStop: () => sw >= 3 });
    ok(rep.stoppedEarly && rep.switched === 3 && rep.stopCode === 'MIGRATION_STOP_REQUESTED', `§3 Abbruch nach 3 (${rep.switched}, ${rep.stopCode})`);
    ok(saves === 1 && savedAt === 3, '§3 das angefangene Paket wurde beim Abbruch gespeichert');
    ok(published.size === 3 && [...published].every((k) => referencedKeys(db).has(k)), `§3 genau 3 Dateien veröffentlicht, alle mit Generation (${published.size})`);
    const again = await eng.runImageStoreMigration({ db: db as MigrationDb, recompress: fakeRust(published).fn, saveDurably: async () => {}, journal: () => {} }, { mode: 'apply' });
    ok(again.total === 13 && again.switched === 13 && !again.stoppedEarly, `§3 Wiederaufnahme: die restlichen 13 (${again.total}/${again.switched})`);
  }

  // ── §4 Fremde Transaktion: nie geschachtelt, nichts veröffentlicht, sauberer Halt ───────────────────
  { console.log('  … §4');
    const { db } = await world(SQL);
    const published = new Set<string>(); const r = fakeRust(published);
    let sw = 0;
    const rep = await eng.runImageStoreMigration({
      db: db as MigrationDb, recompress: r.fn, saveDurably: async () => {}, journal: (e) => { if (e.event === 'switched') sw++; },
      transactionActive: () => sw >= 2,
    }, { mode: 'apply', saveEvery: 10 });
    ok(rep.stoppedEarly && rep.stopCode === 'MIGRATION_TRANSACTION_BUSY' && rep.switched === 2 && rep.failed === 0, `§4 Halt mit MIGRATION_TRANSACTION_BUSY nach 2, kein Fehler gezählt (${rep.stopCode})`);
    ok(r.calls.length === 2 && published.size === 2, `§4 für das wartende Bild wurde gar nichts erzeugt (${r.calls.length} Aufrufe)`);
    // Echte offene Transaktion ohne Kontext-Wissen: BEGIN scheitert → nicht zurückrollen (das wäre die fremde).
    const plan = eng.planImageStoreMigration(db as MigrationDb).plans[0];
    const out = await fakeRust(new Set()).fn({ tenantScope: plan.tenantId, sourceHash: plan.sourceHash, sourceExtension: 'jpg', rendition: plan.rendition, maxBytes: plan.targetBytes, publish: true, publishOnlyBelow: plan.currentBytes });
    db.run('BEGIN'); db.run(`INSERT INTO audit_log (entity_type, entity_id) VALUES ('fremd','x')`);
    let code = '';
    try { eng.switchBlobGeneration(db as MigrationDb, plan, out, '2026-11-16T00:00:00Z'); } catch (e) { code = (e as { code?: string }).code ?? ''; }
    ok(code === 'MIGRATION_TRANSACTION_BUSY', `§4 offene fremde Transaktion → MIGRATION_TRANSACTION_BUSY (${code})`);
    let committed = true; try { db.run('COMMIT'); } catch { committed = false; }
    ok(committed && q(db, `SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'fremd'`)[0].n === 1, '§4 die fremde Transaktion lebt weiter und wird normal abgeschlossen (nicht zurückgerollt)');
    ok(q(db, `SELECT current_generation_no AS g FROM media_blobs WHERE blob_id = ?`, [plan.blobId])[0].g === plan.currentGeneration, '§4 dieser Blob blieb auf seiner Generation');
  }

  // ── §5 Freigabe vor jedem Paket: Owner-Rolle weg → Halt, bisheriges gespeichert ─────────────────────
  { console.log('  … §5');
    const { db } = await world(SQL);
    let batches = 0, saves = 0; let thrown = '';
    try {
      await eng.runImageStoreMigration({
        db: db as MigrationDb, recompress: fakeRust(new Set()).fn, saveDurably: async () => { saves++; }, journal: () => {},
        exclusive: async (fn) => fn(),
        assertAllowed: () => { batches++; if (batches === 3) throw new Error('MIGRATION_NOT_OWNER'); },
      }, { mode: 'apply', saveEvery: 4 });
    } catch (e) { thrown = (e as Error).message; }
    const gen2 = q(db, `SELECT COUNT(*) AS n FROM media_blob_generations WHERE generation_no = 2`)[0].n;
    ok(thrown === 'MIGRATION_NOT_OWNER' && gen2 === 4 && saves === 1, `§5 Rolle vor dem 2. Paket weg: Halt, 1. Paket (4) gespeichert (${thrown}, ${gen2}, ${saves})`);
  }

  // ── §6 Verdrahtung: Owner, Pflichtangaben, Wartungsmodus an/aus, Protokoll, Doppelstart ───────────────
  { console.log('  … §6');
    const { db } = await world(SQL);
    const events: string[] = []; const logs: string[] = [];
    let role = 'ADMIN';
    const published = new Set<string>();
    let slow: (() => void) | null = null;
    const env = (over: Partial<import('../../src/core/media/image-store-migration-wiring.ts').MigrationEnv> = {}) => ({
      exclusive: async <T,>(fn: (l: { db: unknown; saveDurably(): Promise<void> }) => Promise<T>) => { events.push('slot'); return fn({ db, saveDurably: async () => { events.push('save'); } }); },
      recompress: fakeRust(published).fn,
      session: () => ({ userId: 'u1', role }),
      isClientMode: () => false,
      setMaintenance: async (on: boolean) => { events.push(on ? 'maint-on' : 'maint-off'); gate.setMaintenanceGate(on, 'test'); },
      waitForDrainIdle: async () => { events.push('drain-idle'); },
      appendLog: async (name: string, line: string) => { logs.push(`${name}:${line}`); },
      transactionActive: () => false,
      ...over,
    });
    role = 'SALES';
    let r = await wiring.runImageMigrationWith(env(), { mode: 'apply', reason: 'x', backupRef: '2026-11-16_vor-bildmigration' });
    ok(r.refused?.code === 'MIGRATION_NOT_OWNER' && events.length === 0, '§6 kein Owner → abgewiesen, nichts angefasst');
    role = 'ADMIN';
    r = await wiring.runImageMigrationWith(env(), { mode: 'apply', reason: 'x', backupRef: '' });
    ok(r.refused?.code === 'MIGRATION_NOTE_REQUIRED' && events.length === 0, '§6 ohne Sicherungsname → abgewiesen');
    r = await wiring.runImageMigrationWith(env({ isClientMode: () => true }), { mode: 'dry-run' });
    ok(r.refused?.code === 'MIGRATION_PRIMARY_ONLY', '§6 am zweiten Rechner → abgewiesen');

    r = await wiring.runImageMigrationWith(env(), { mode: 'apply', reason: 'Bildspeicher', backupRef: '2026-11-16_vor-bildmigration', saveEvery: 5 });
    ok(r.report?.switched === 16 && !r.refused, `§6 Lauf: 16 umgestellt (${r.report?.switched})`);
    ok(events[0] === 'maint-on' && events[1] === 'drain-idle' && events.at(-1) === 'maint-off' && !gate.maintenanceGateActive(), `§6 Wartungsmodus AN vor dem ersten Platz, AUS danach (${events.slice(0, 3).join(',')} … ${events.at(-1)})`);
    const name = r.logName ?? '';
    ok(/^img-mig-/.test(name) && logs.some((l) => l.startsWith(name) && l.includes('"event":"owner"') && l.includes('2026-11-16_vor-bildmigration'))
      && logs.filter((l) => l.includes('"event":"switched"')).length === 16 && logs.some((l) => l.includes('"event":"report"')), `§6 Protokoll: Owner-Zeile, 16 Umstellungen, Bericht (${logs.length} Zeilen)`);
    ok(logs.every((l) => !/@|password|Bildspeicher[^"]*"[^}]*customer/i.test(l)), '§6 Protokoll ohne Kennwörter oder E-Mails');

    // Rolle wechselt mitten im Lauf → sauberer Halt, Wartungsmodus aus
    const { db: db2 } = await world(SQL);
    events.length = 0; let slots = 0;
    r = await wiring.runImageMigrationWith(env({
      exclusive: async (fn) => { slots++; if (slots === 3) role = 'SALES'; return fn({ db: db2, saveDurably: async () => { events.push('save'); } }); },
    }), { mode: 'apply', reason: 'Bildspeicher', backupRef: '2026-11-16_vor-bildmigration', saveEvery: 4 });
    role = 'ADMIN';
    ok(r.refused?.code === 'MIGRATION_NOT_OWNER' && q(db2, `SELECT COUNT(*) AS n FROM media_blob_generations WHERE generation_no = 2`)[0].n === 4 && events.at(-1) === 'maint-off',
      `§6 Owner-Sitzung endet mitten im Lauf: Halt nach dem gespeicherten Paket, Wartungsmodus aus (${r.refused?.code})`);

    // Fehler im Platz → Wartungsmodus trotzdem aus
    events.length = 0;
    let threw = false;
    try { await wiring.runImageMigrationWith(env({ exclusive: async () => { throw new Error('MEDIA_ORCH_DB_INSTANCE_CHANGED'); } }), { mode: 'apply', reason: 'x', backupRef: '2026-11-16_vor-bildmigration' }); } catch { threw = true; }
    ok(threw && events.at(-1) === 'maint-off' && !gate.maintenanceGateActive(), '§6 Fehler im Lauf: Wartungsmodus wird trotzdem beendet');

    // Doppelstart
    const { db: db3 } = await world(SQL);
    const first = wiring.runImageMigrationWith(env({
      exclusive: async (fn) => { if (!slow) await new Promise<void>((res) => { slow = res; }); return fn({ db: db3, saveDurably: async () => {} }); },
    }), { mode: 'dry-run' });
    await new Promise((res) => setTimeout(res, 10));
    const second = await wiring.runImageMigrationWith(env(), { mode: 'dry-run' });
    ok(second.refused?.code === 'MIGRATION_ALREADY_RUNNING' && wiring.imageMigrationUiState().running, '§6 zweiter Start während eines Laufs → abgewiesen');
    slow!(); await first;
    ok(!wiring.imageMigrationUiState().running, '§6 danach läuft nichts mehr');
  }

  // ── §7 Renderer-Riegel: im Wartungsmodus kein verändernder Fernauftrag, Lesen bleibt ───────────────
  { console.log('  … §7');
    const reg = await import('../../src/core/bridge/command-registry.ts');
    let calls = 0;
    reg.registerCommand('tasks.create', { kind: 'mutation', handler: async () => { calls++; return { ok: true } as never; } });
    reg.registerCommand('test.maintenance.get', { kind: 'read', handler: async () => ({ ok: true }) as never });
    const actor = { commandId: '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b', tenantId: 't1', branchId: 'b1', userId: 'u1', payloadHash: 'h', role: 'ADMIN' };
    gate.setMaintenanceGate(true, 'test');
    const denied = await reg.executeCommand('tasks.create', { input: {} }, actor as never);
    const read = await reg.executeCommand('test.maintenance.get', {}, actor as never);
    gate.setMaintenanceGate(false);
    const allowed = await reg.executeCommand('tasks.create', { input: {} }, actor as never);
    ok(denied.kind === 'business_error' && (denied as { code: string }).code === 'MAINTENANCE_ACTIVE' && calls === 1, `§7 Wartung: Fernauftrag abgewiesen ohne Handler (${JSON.stringify(denied).slice(0, 80)})`);
    ok(read.kind === 'ok', '§7 Lesen bleibt im Wartungsmodus erlaubt');
    ok(allowed.kind === 'ok', '§7 nach der Wartung: derselbe Auftrag läuft wieder');
  }

  // ── §8 Nachweis-Skript (scripts/maint/bildmigration-vergleich.mjs): nur Generationen/Zeiger geändert ──────────
  {
    const { db } = await world(SQL);
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'bildmig-vgl-'));
    writeFileSync(join(dir, 'vorher.db'), Buffer.from(db.export()));
    await eng.runImageStoreMigration({ db: db as MigrationDb, recompress: fakeRust(new Set()).fn, saveDurably: async () => {}, journal: () => {} }, { mode: 'apply' });
    writeFileSync(join(dir, 'nachher.db'), Buffer.from(db.export()));
    const { vergleiche } = await import('../../scripts/maint/bildmigration-vergleich.mjs');
    const v = vergleiche(join(dir, 'vorher.db'), join(dir, 'nachher.db'));
    ok(v.ok && v.umgestellt === 16 && v.neueGenerationen === 16 && v.aktuelleBilddatenBytes.nachher < v.aktuelleBilddatenBytes.vorher, `§8 Nachweis ok: 16 umgestellt, aktuelle Bilddaten kleiner (${JSON.stringify(v).slice(0, 160)})`);
    db.run(`UPDATE products SET updated_at = '2026-11-17' WHERE id = 'p-w0'`);
    writeFileSync(join(dir, 'nachher.db'), Buffer.from(db.export()));
    const v2 = vergleiche(join(dir, 'vorher.db'), join(dir, 'nachher.db'));
    ok(!v2.ok && v2.fehler.some((f: string) => f.startsWith('products')), `§8 Gegenprobe: eine geänderte Artikelzeile wird gemeldet (${v2.fehler.join('; ')})`);
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${FAIL === 0 ? 'OK' : 'FAIL'} — image-store-migration phase 4: ${PASS} passed, ${FAIL} failed`);
  if (FAIL > 0) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
}
await main();
