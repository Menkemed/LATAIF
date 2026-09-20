// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R5C — Reparatur anlegen, ändern, abrechnen: dieselbe Wirkung auf beiden Seiten.
// Run: node test/r5c/repair-parity.test.ts
//
// Bewiesen an echten Zeilen einer echten sql.js-Datenbank, jeweils ZWEIMAL — einmal über den
// Anschluss der Maske am Primary (`repair-house`), einmal über den Fernbefehl mit genau dem Rumpf,
// den dieselbe Maske am zweiten Rechner baut (`repair-rules`):
//
//   §2 Anlegen: Kunden- UND Eigenreparatur (Artikel, Los, Platzhalter-Kunde, `in_repair`), alle
//      Felder der Maske inkl. Kategorie, Merkmale, Mitarbeiter, Fotos — Zeile für Zeile gleich.
//   §3 Ändern: Zahlwege, Kartenart, Kategorie, Merkmale, Fotos — gleiche Zeile, gleiche Buchungen.
//   §4 Abrechnen: eine oder mehrere Reparaturen desselben Kunden in EINE Rechnung, Dialogwahl.
//   §6 Atomar: ein Fehler mitten im Vorgang hinterlässt NICHTS — beim Anlegen und beim Abrechnen.
//   §8 Autorität: fremde Filiale/Kunde/Artikel/Los/Reparatur, abgerechnete Reparatur, gemischte
//      Kunden, falscher Status, und kein Betrag, keine Steuer, kein Bestand, kein Eigentum, keine
//      Buchung aus dem Rumpf.
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    // Gestellt wird nur die IPC-Grenze zu Rust (Zwischenablage) und die echte Testdatenbank.
    if (specifier === '@tauri-apps/api/core') {
      return { url: pathToFileURL(resolvePath(repo, 'test/bridge/_tauri-shim.ts')).href, shortCircuit: true };
    }
    if (specifier === '@/core/db/database' || specifier === '../db/database.ts') {
      return { url: pathToFileURL(resolvePath(repo, 'test/sync/_db-shim.ts')).href, shortCircuit: true };
    }
    if ((specifier === './database' || specifier === '../db/database') && context.parentURL) {
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

const store = new Map<string, string>([
  ['lataif_session', JSON.stringify({ branchId: 'branch-main', userId: 'user-test' })],
  ['lataif_sync_url', 'http://127.0.0.1:9/sync'],
  ['lataif_sync_token', 'test-token'],
]);
const storage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};
(globalThis as { localStorage?: unknown }).localStorage = storage;
(globalThis as { window?: unknown }).window = { localStorage: storage };

const initSqlJs = (await import('sql.js')).default;
const SQL = await initSqlJs({ locateFile: (f: string) => resolvePath(repo, 'node_modules/sql.js/dist', f) });

const { setTestDatabase } = await import('../sync/_db-shim.ts');
const { tauriState, stageForTest } = await import('../bridge/_tauri-shim.ts');
const { COMMAND_LEDGER_DDL, COMMAND_LEDGER_INDEX } = await import('../../src/core/bridge/command-ledger.ts');
const { resetDurabilityStateForTest } = await import('../../src/core/bridge/durability-state.ts');
const { resetTransactionHealthForTest } = await import('../../src/core/db/transaction-health.ts');
const { installWriteGuard } = await import('../../src/core/db/write-guard.ts');
const { SKU_SEQUENCES_DDL } = await import('../../src/core/products/sku-sequence.ts');
const { ALLOWED_MUTATIONS } = await import('../../src/core/bridge/command-registry.ts');
await import('../../src/core/bridge/read-commands.ts');
await import('../../src/core/bridge/customer-commands.ts');
await import('../../src/core/bridge/product-commands.ts');
await import('../../src/core/bridge/invoice-lifecycle-commands.ts');
await import('../../src/core/bridge/return-commands.ts');
const life = await import('../../src/core/bridge/lifecycle-commands.ts');
const cmd = await import('../../src/core/bridge/service-commands.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const { applyMediaSchema } = await import('../../src/core/db/media-schema.ts');
const { useInvoiceStore } = await import('../../src/stores/invoiceStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { useCustomerStore } = await import('../../src/stores/customerStore.ts');
const { useRepairStore } = await import('../../src/stores/repairStore.ts');
const { useSupplierStore } = await import('../../src/stores/supplierStore.ts');
const house = await import('../../src/core/repairs/repair-house.ts');
const rules = await import('../../src/core/repairs/repair-rules.ts');
const { editBaselineRevision, shouldAdoptRecord } = await import('../../src/core/data/form-sync.ts');
const { R4C_MATRIX } = await import('../uiparity/_r4c-write-matrix.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const codeOf = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const NOW = '2026-09-10T10:00:00.000Z';

interface Db {
  run(sql: string, p?: unknown[]): unknown;
  exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
}
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const n = (db: Db, sql: string, p: unknown[] = []): number => Number(one(db, sql, p) ?? 0);
const s = (db: Db, sql: string, p: unknown[] = []): string => String(one(db, sql, p) ?? '');
function row(db: Db, sql: string, p: unknown[] = []): Record<string, unknown> {
  const r = db.exec(sql, p)[0];
  if (!r || r.values.length === 0) return {};
  return Object.fromEntries(r.columns.map((c, i) => [c, r.values[0][i]]));
}
const all = (db: Db, sql: string, p: unknown[] = []): string => JSON.stringify(db.exec(sql, p)[0]?.values ?? []);

function realMigrations(): string[] {
  const dbSrc = src('src/core/db/database.ts');
  const start = dbSrc.indexOf('const migrations: string[] = [');
  const end = dbSrc.indexOf('\n  ];', start);
  return [...dbSrc.slice(start, end).matchAll(/`([^`]*)`/g)].map((m) => m[1]);
}
const MIGRATIONS = realMigrations();

/** Eine Zeile anlegen, deren Pflichtspalten ohne Vorgabe sinnvoll gefüllt werden. */
function insert(db: Db, table: string, values: Record<string, unknown>): void {
  const info = db.exec(`PRAGMA table_info(${table})`)[0];
  const cols = info.values.map((v) => ({
    name: String(v[1]), type: String(v[2] ?? ''), notnull: Number(v[3]) === 1, dflt: v[4], pk: Number(v[5]) > 0,
  }));
  const data: Record<string, unknown> = { ...values };
  for (const c of cols) {
    if (!c.notnull || c.dflt !== null || c.pk || data[c.name] !== undefined) continue;
    data[c.name] = /INT|REAL|NUM/i.test(c.type) ? 0 : (/_at$|date/i.test(c.name) ? NOW : '');
  }
  const names = Object.keys(data).filter((k) => cols.some((c) => c.name === k));
  db.run(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`, names.map((k) => data[k]));
}

function reload(): void {
  useProductStore.getState().loadProducts();
  useProductStore.getState().loadCategories();
  useCustomerStore.getState().loadCustomers();
  useInvoiceStore.getState().loadInvoices();
  useRepairStore.getState().loadRepairs();
  useRepairStore.getState().loadRepairLines();
  useSupplierStore.getState().loadSuppliers();
}

function freshDb(): Db {
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  const db = new SQL.Database() as unknown as Db;
  db.run(src('src/core/db/schema.sql'));
  for (const stmt of MIGRATIONS) { try { db.run(stmt); } catch { /* schon da */ } }
  for (const stmt of A1_UPGRADE_SQL) { try { db.run(stmt); } catch { /* schon da */ } }
  db.run(COMMAND_LEDGER_DDL);
  db.run(COMMAND_LEDGER_INDEX);
  db.run(SKU_SEQUENCES_DDL);
  for (const [id, name] of [['branch-main', 'Haupt'], ['branch-other', 'Andere']]) {
    db.run('INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES (?,?,?,?,?)', [id, 'tenant-1', name, NOW, NOW]);
  }
  for (const [id, branch] of [['cat-w', 'branch-main'], ['cat-watch', 'branch-main'], ['cat-foreign', 'branch-other']]) {
    db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES (?,?,?,'w','#000',?,?)",
      [id, branch, id, NOW, NOW]);
  }
  for (const [id, first, branch] of [['cust-1', 'Ali', 'branch-main'], ['cust-2', 'Nora', 'branch-main'], ['cust-x', 'Fremd', 'branch-other']]) {
    db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level,
        preferences, customer_type, sales_stage, created_at, updated_at)
      VALUES (?,?,?,'Hassan','BH','en',0,'[]','collector','active',?,?)`, [id, branch, first, NOW, NOW]);
  }
  for (const [id, branch] of [['sup-1', 'branch-main'], ['sup-other', 'branch-other']]) {
    db.run('INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at) VALUES (?,?,?,1,?,?)',
      [id, branch, 'Werkstatt ' + id, NOW, NOW]);
  }
  for (const [id, branch, st] of [['emp-1', 'branch-main', 'active'], ['emp-gone', 'branch-main', 'inactive'], ['emp-x', 'branch-other', 'active']]) {
    insert(db, 'employees', { id, branch_id: branch, name: 'M ' + id, employment_status: st, created_at: NOW, updated_at: NOW });
  }
  applyMediaSchema(db as never);
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  for (const [id, branch, source, stock] of [
    ['p1', 'branch-main', 'OWN', 'in_stock'], ['p2', 'branch-main', 'OWN', 'in_stock'],
    ['p-cons', 'branch-main', 'CONSIGNMENT', 'consignment'], ['p-foreign', 'branch-other', 'OWN', 'in_stock'],
    ['svc-repair-branch-main', 'branch-main', 'OWN', 'in_stock'],
  ]) {
    db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
        scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
        tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
      VALUES (?,?,'cat-w','Rolex',?,?,1,'Pre-Owned','[]',100,'BHD',150,?,'VAT_10',0,'[]','{}',?,?,?)`,
    [id, branch, 'M ' + id, 'SKU-' + id, stock, source, NOW, NOW]);
    // Der Service-Artikel der Reparaturrechnung hat — wie im Haus — keine Lose.
    if (id.startsWith('svc-repair-')) continue;
    db.run(`INSERT INTO stock_lots (id, branch_id, product_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
      VALUES (?,?,?,100,1,1,'ACTIVE',?,?)`, ['lot-' + id, branch, id, NOW, NOW]);
  }
  reload();
  tauriState.reset();
  return db;
}

const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-000000000000`;
const ACTOR = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test', role: 'ADMIN' };
const OWNER = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test' };
const identity = (x: string, op: string, hash = 'h' + x) => ({ commandId: ID(x), ...ACTOR, op, payloadHash: hash });
const deps = (db: Db) => ({
  db: db as never,
  begin: posting.beginLedgerTransaction,
  commit: posting.commitLedgerTransaction,
  rollback: posting.rollbackLedgerTransaction,
  durableSave: async () => {},
  now: () => NOW,
});
const val = <T>(o: unknown): T => (o as { value: T }).value;
const code = (o: unknown): string => (o as { code?: string }).code ?? '';
const frozen = (o: unknown): boolean => (o as { frozen?: boolean }).frozen === true;
const rev = (db: Db, id: string): number => n(db, 'SELECT revision FROM repairs WHERE id = ?', [id]);

const bild = (seed: number): Uint8Array => Uint8Array.from({ length: 64 }, (_, i) => (seed * 37 + i * 11) & 0xff);
const alsDataUrl = (b: Uint8Array): string => `data:image/jpeg;base64,${Buffer.from(b).toString('base64')}`;
const ablegen = async (urls: string[]): Promise<string[]> =>
  urls.map((u) => stageForTest(Uint8Array.from(Buffer.from(u.split(',')[1], 'base64')), OWNER));

// ════════════════════════════════════════════════════════════════════════════
// MEDIA-REPAIR — die Fotos einer Reparatur im generischen Medienkern.
// Run: node test/media-repair/repair-photos.test.ts
//
//   §1 Anlegen mit zwei Fotos: Verknuepfungen statt Bytes, Reihenfolge, Zeile ohne Daten-URL
//   §2 Aendern: hinzufuegen, entfernen, austauschen — je EINE Fassung mehr
//   §3 Wiederholung und gleiche Bytes: kein zweites Objekt, keine zweite Datei
//   §4 Veralteter Stand in beide Richtungen (Primary ↔ Fernbefehl)
//   §5 Fremde Reparatur, fehlendes Medium → Nein
//   §6 Auskunft, Sicherung, Wiederherstellung, GC, kein Produkt-Embedding
// ════════════════════════════════════════════════════════════════════════════
const media = await import('../../src/core/repairs/repair-media.ts');
const rules2 = await import('../../src/core/repairs/repair-rules.ts');

const galerie = (db: Db, id: string): string[] =>
  (db.exec("SELECT media_id FROM media_links WHERE entity_type = 'repair' AND entity_id = ? AND deleted_at IS NULL ORDER BY sort_order", [id])[0]?.values ?? [])
    .map((v) => String(v[0]));
const objekte = (db: Db): number => n(db, 'SELECT COUNT(*) FROM media_objects');
const dateien = (db: Db): number => n(db, 'SELECT COUNT(*) FROM media_blob_generations');
const anlegen = (bilder: string[]) => house.createRepairOnPrimary({
  repairScope: 'CUSTOMER', customerId: 'cust-1', issueDescription: 'Glas', repairType: 'internal',
  estimatedCost: 10, chargeToCustomer: 40, images: bilder,
} as never);
const jetztStand = (id: string) => ({ ...(useRepairStore.getState().getRepair(id) as unknown as Record<string, unknown>) });

// ── §1 Anlegen mit zwei Fotos ───────────────────────────────────────────────────────────────
{
  const db = freshDb();
  const r = await anlegen([alsDataUrl(bild(1)), alsDataUrl(bild(2))]);
  const g = galerie(db, r.id);
  ok(g.length === 2, `§1 zwei Fotos haengen als Verknuepfungen an der Reparatur (${g.length})`);
  ok(s(db, 'SELECT images FROM repairs WHERE id = ?', [r.id]) === '[]',
    '§1 die Reparaturzeile haelt KEINE Bytes mehr (keine neue Daten-URL)');
  ok(all(db, 'SELECT sort_order, is_primary FROM media_links WHERE entity_id = ? AND deleted_at IS NULL ORDER BY sort_order', [r.id])
    === JSON.stringify([[0, 1], [1, 0]]), '§1 die Reihenfolge ist stabil, das erste Foto ist das Titelbild');
  ok(n(db, "SELECT COUNT(*) FROM media_objects WHERE security_class = 'internal'") === 2
    && s(db, 'SELECT entity_type FROM media_links WHERE entity_id = ?', [r.id]) === 'repair'
    && s(db, 'SELECT media_role FROM media_links WHERE entity_id = ?', [r.id]) === 'gallery',
    '§1 Besitzer `repair`, Rolle `gallery`, Klasse `internal`');
  const refs = media.repairPhotoRefs(r.id);
  ok(refs.length === 2 && refs[0].mediaId === g[0] && refs[0].main.storageKey.endsWith('.jpg') && refs[0].thumbnail !== null,
    '§1 die Auskunft nennt Referenzen (Schluessel + Vorschau), keine Bytes');

  // ── §2 Aendern: hinzufuegen, entfernen, austauschen ───────────────────────────────────────
  const rev1 = rev(db, r.id);
  await house.updateRepairOnPrimary(r.id, { ...jetztStand(r.id), images: [...g, alsDataUrl(bild(3))] } as never, rev1);
  const g2 = galerie(db, r.id);
  ok(g2.length === 3 && g2[0] === g[0] && g2[1] === g[1], `§2 hinzufuegen: das Neue kommt hinten an (${g2.length})`);
  ok(rev(db, r.id) === rev1 + 1, `§2 …und die Reparatur hat GENAU eine Fassung mehr (${rev1} → ${rev(db, r.id)})`);

  const rev2 = rev(db, r.id);
  await house.updateRepairOnPrimary(r.id, { ...jetztStand(r.id), images: [g2[0], g2[2]] } as never, rev2);
  const g3 = galerie(db, r.id);
  ok(JSON.stringify(g3) === JSON.stringify([g2[0], g2[2]]) && rev(db, r.id) === rev2 + 1,
    `§2 entfernen: das mittlere ist weg, der Rest rueckt auf, eine Fassung mehr (${JSON.stringify(g3)})`);
  ok(n(db, 'SELECT COUNT(*) FROM media_links WHERE entity_id = ? AND deleted_at IS NOT NULL', [r.id]) === 1,
    '§2 …die entfernte Verknuepfung bleibt als Nachweis stehen (keine Datei wird geloescht)');
  ok(objekte(db) === 3, '§2 …und das Medienobjekt selbst bleibt (GC-Vertrag, kein ad-hoc Loeschen)');

  const rev3 = rev(db, r.id);
  await house.updateRepairOnPrimary(r.id, { ...jetztStand(r.id), images: [g3[0], alsDataUrl(bild(4))] } as never, rev3);
  const g4 = galerie(db, r.id);
  ok(g4.length === 2 && g4[0] === g3[0] && g4[1] !== g3[1], '§2 austauschen: behalten bleibt, das andere ist ersetzt');
  ok(rev(db, r.id) === rev3 + 1, `§2 …EIN Austausch ist EINE Fassung, nicht zwei (${rev3} → ${rev(db, r.id)})`);

  // ── §3 Wiederholung und gleiche Bytes ────────────────────────────────────────────────────
  const vorher = { o: objekte(db), d: dateien(db), rev: rev(db, r.id) };
  await house.updateRepairOnPrimary(r.id, { ...jetztStand(r.id), images: g4 } as never, vorher.rev);
  ok(JSON.stringify(galerie(db, r.id)) === JSON.stringify(g4) && objekte(db) === vorher.o,
    '§3 dieselbe Galerie nochmal gespeichert → nichts Neues');
  const zwilling = await anlegen([alsDataUrl(bild(1))]);
  ok(galerie(db, zwilling.id)[0] === g[0] && objekte(db) === vorher.o,
    '§3 DIESELBEN Bytes in einer zweiten Reparatur → dasselbe Medium, kein zweites Objekt');
  ok(dateien(db) === vorher.d, '§3 …und keine zweite Datei im Speicher (Dedup nach Inhalt)');
  ok(galerie(db, r.id).length === 2, '§3 …die erste Reparatur behaelt ihre eigene Galerie');
}

// ── §4 Fernbefehl: Plan mit Kennungen, veralteter Stand in beide Richtungen ──────────────────
{
  const db = freshDb();
  const r = await anlegen([alsDataUrl(bild(1))]);
  const g = galerie(db, r.id);
  const gesehen = rev(db, r.id);
  const plan = await rules2.repairPhotoPlan([], [g[0], alsDataUrl(bild(5))], ablegen);
  ok(JSON.stringify(plan[0]) === JSON.stringify({ keep: g[0] }) && 'stagingId' in plan[1],
    `§4 der Plan nennt Kennung und Ablage, nie Bytes (${JSON.stringify(plan[0])})`);
  const body = rules2.repairEditBody(r.id, gesehen, {} as never, {} as never, plan);
  ok(!JSON.stringify(body).includes('base64'), '§4 …und im Rumpf stehen keine Bildbytes');
  const out = await cmd.runRepairUpdate(deps(db), identity('700', 'repairs.update'), body);
  ok(out.kind === 'ok', `§4 der Fernbefehl speichert (${JSON.stringify(out).slice(0, 160)})`);
  const g2 = galerie(db, r.id);
  ok(g2.length === 2 && g2[0] === g[0], '§4 …behalten blieb, das neue kam dazu');
  ok(s(db, 'SELECT images FROM repairs WHERE id = ?', [r.id]) === '[]', '§4 …und die Zeile bleibt ohne Bytes');

  let c = '';
  try { await house.updateRepairOnPrimary(r.id, { ...jetztStand(r.id), images: g2 } as never, gesehen); } catch (e) { c = (e as { code?: string }).code ?? ''; }
  ok(c === 'RECORD_CHANGED', `§4 Primary mit altem Stand nach der Fotoaenderung des PC2 → RECORD_CHANGED (${c})`);

  const jetzt = rev(db, r.id);
  await house.updateRepairOnPrimary(r.id, { ...jetztStand(r.id), images: [g2[0]] } as never, jetzt);
  const alt = await cmd.runRepairUpdate(deps(db), identity('701', 'repairs.update'),
    rules2.repairEditBody(r.id, jetzt, {} as never, {} as never, [{ keep: g2[0] }]));
  ok(alt.kind === 'rejected' && code(alt) === 'RECORD_CHANGED' && frozen(alt),
    `§4 …und PC2 mit altem Stand nach der Fotoaenderung des Primary → RECORD_CHANGED (${code(alt)})`);

  const wieder = await cmd.runRepairUpdate(deps(db), identity('700', 'repairs.update'), body);
  ok(wieder.kind === 'ok' && galerie(db, r.id).length === 1,
    '§4 dieselbe Auftragskennung erneut → Wiedergabe, keine zweite Verknuepfung');
}

// ── §5 Fremdes und Fehlendes ────────────────────────────────────────────────────────────────
{
  const db = freshDb();
  const r = await anlegen([alsDataUrl(bild(1))]);
  const fehlt = await cmd.runRepairUpdate(deps(db), identity('710', 'repairs.update'),
    { id: r.id, expectedRevision: rev(db, r.id), photos: [{ keep: 'media-gibt-es-nicht' }] });
  ok(fehlt.kind === 'rejected' && code(fehlt) === 'PHOTO_NOT_FOUND' && frozen(fehlt),
    `§5 ein Foto, das es nicht gibt, ist ein eingefrorenes Nein (${code(fehlt)})`);
  ok(galerie(db, r.id).length === 1, '§5 …und die Galerie ist unveraendert');
  insert(db, 'repairs', {
    id: 'rep-fremd', branch_id: 'branch-other', repair_number: 'REP-X-9', customer_id: 'cust-x', issue_description: 'x',
    status: 'received', received_at: NOW, voucher_code: 'FREMD999', charge_to_customer: 10, repair_scope: 'CUSTOMER',
    created_at: NOW, updated_at: NOW,
  });
  const fremd = await cmd.runRepairUpdate(deps(db), identity('711', 'repairs.update'),
    { id: 'rep-fremd', expectedRevision: 1, photos: [{ keep: galerie(db, r.id)[0] }] });
  ok(fremd.kind === 'rejected' && code(fremd) === 'REPAIR_NOT_FOUND',
    `§5 eine Reparatur einer anderen Filiale gibt es fuer diesen Auftrag nicht (${code(fremd)})`);
  ok(n(db, "SELECT COUNT(*) FROM media_links WHERE entity_id = 'rep-fremd'") === 0, '§5 …und es wurde nichts verknuepft');
}

// ── §6 Vertrag: Auskunft, Sicherung, Wiederherstellung, GC, kein Embedding ───────────────────
{
  const rc = codeOf(src('src/core/bridge/read-commands.ts'));
  ok(/mediaIds: fotos\.map\(\(f\) => f\.mediaId\)/.test(rc) && /mediaKeys: fotos\.map\(\(f\) => f\.main\.storageKey\)/.test(rc),
    'VERTRAG `repairs.get` nennt Kennungen und Schluessel');
  ok(/images: fotos\.length > 0 \? \[\] : repairImages\(found\[0\]\.images\)/.test(rc),
    'VERTRAG …die alte Spalte nur noch fuer Reparaturen ohne Verknuepfung (Altbestand, read-only)');
  const rr = codeOf(src('src/core/repairs/repair-rules.ts'));
  ok(!/images: i\.images as string\[\]/.test(rr), 'VERTRAG der Schreibsatz einer Aenderung traegt keine Bilder mehr');
  const reach = src('src-tauri/src/media/reachability.rs');
  ok(!/entity_type\s*=/.test(reach) && /media_links/.test(reach),
    'VERTRAG Sicherung/Umzug/GC fragen nur nach Verknuepfungen — ein Reparaturfoto zaehlt wie jedes andere');
  const grant = src('src-tauri/src/sync/product_query.rs');
  ok(/l\.entity_type = 'repair' AND l\.media_role = 'gallery'/.test(grant)
    && /FROM repairs r WHERE r\.id = l\.entity_id AND r\.branch_id = l\.branch_id/.test(grant),
    'VERTRAG `/api/media` kennt den Besitzer Reparatur — mit seiner Rolle und seiner Filiale');
  const ui = codeOf(src('src/core/repairs/repair-photo-view.ts'));
  ok(/gateway\.readVerifiedMedia/.test(ui) && /\/api\/media\?key=/.test(ui) && /URL\.createObjectURL/.test(ui),
    'VERTRAG Anzeige: gepruefte Bytes → Objekt-URL, auf beiden Rechnern');
  const mob = codeOf(src('src-tauri/src/sync/mobile_repair_ui.js'));
  ok(/rpBytesAlsDatenUrl/.test(mob) && /Authorization: 'Bearer '/.test(mob),
    'VERTRAG Telefon: Vorschau und KI holen die Bytes angemeldet, nie als gespeicherte Daten-URL');
  const mc = codeOf(src('src-tauri/src/sync/mobile_repair_commands.js'));
  ok(/typeof s\.keep === 'string'/.test(mc) && /p\.keep === ids\[i\]/.test(mc),
    'VERTRAG Telefon: „behalten" nennt die stabile Kennung, nicht die Position');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — media repair photos: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('MEDIA_REPAIR_OPERATIONAL_PROVED');
