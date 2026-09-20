// ════════════════════════════════════════════════════════════════════════════
// MEDIA-IDENTITY — Ausweisdokumente von Kunden und Lieferanten.
// Run: node test/media-identity/identity-documents.test.ts
//
// Bewiesen an echten Zeilen einer echten sql.js-Datenbank, über GENAU die Funktionen, die die
// Masken und die Fernbefehle rufen:
//
//   §1 Kunde: anlegen ohne Foto, anlegen mit Foto, austauschen, entfernen
//   §2 Fassung: jede Änderung genau EINE, und ein veralteter Stand wird abgewiesen
//   §3 Lieferant: eigenes Dokument, austauschen, entfernen
//   §4 Verknüpfte Identität: der Kunde führt, keine zweite Datei, kein stilles Ersetzen
//   §5 Grenzen: fremde Filiale, fehlender Datensatz, entferntes Dokument
//   §6 PC2: derselbe Weg über die Befehle, dieselbe Wirkung
//   §7 Telefon: Reparatur und Kommission legen einen Kunden mit Ausweisfoto an
//   §8 Einkauf: die Fassung wird eingefroren und bleibt es
//   §9 Keine Bytes: nirgends eine neue Daten-URL, nirgends eine geschriebene Spalte
//   §10 Der Kern bleibt unberührt: Artikel- und Reparaturmedien unverändert
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
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
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const { applyMediaSchema, MEDIA_ENTITY_SCOPE } = await import('../../src/core/db/media-schema.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { useCustomerStore } = await import('../../src/stores/customerStore.ts');
const { useSupplierStore } = await import('../../src/stores/supplierStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { usePurchaseStore } = await import('../../src/stores/purchaseStore.ts');
const media = await import('../../src/core/identity/identity-media.ts');
const custSave = await import('../../src/core/customers/customer-save.ts');
const mdSave = await import('../../src/core/masterdata/masterdata-save.ts');
const custCmd = await import('../../src/core/bridge/customer-commands.ts');
const mdCmd = await import('../../src/core/bridge/masterdata-commands.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const codeOf = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const NOW = '2026-09-20T10:00:00.000Z';

interface Db {
  run(sql: string, p?: unknown[]): unknown;
  exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
}
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const n = (db: Db, sql: string, p: unknown[] = []): number => Number(one(db, sql, p) ?? 0);
const s = (db: Db, sql: string, p: unknown[] = []): string => String(one(db, sql, p) ?? '');

function realMigrations(): string[] {
  const dbSrc = src('src/core/db/database.ts');
  const start = dbSrc.indexOf('const migrations: string[] = [');
  const end = dbSrc.indexOf('\n  ];', start);
  return [...dbSrc.slice(start, end).matchAll(/`([^`]*)`/g)].map((m) => m[1]);
}
const MIGRATIONS = realMigrations();

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
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES ('cat-w','branch-main','Uhren','w','#000',?,?)", [NOW, NOW]);
  for (const [id, first, branch] of [['cust-1', 'Ali', 'branch-main'], ['cust-2', 'Nora', 'branch-main'], ['cust-x', 'Fremd', 'branch-other']]) {
    db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level,
        preferences, customer_type, sales_stage, created_at, updated_at)
      VALUES (?,?,?,'Hassan','BH','en',0,'[]','collector','active',?,?)`, [id, branch, first, NOW, NOW]);
  }
  for (const [id, branch] of [['sup-1', 'branch-main'], ['sup-x', 'branch-other']]) {
    db.run('INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at) VALUES (?,?,?,1,?,?)',
      [id, branch, 'Lieferant ' + id, NOW, NOW]);
  }
  db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
      scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
      tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
    VALUES ('p1','branch-main','cat-w','Rolex','M','SKU-1',1,'Pre-Owned','[]',100,'BHD',150,'in_stock','VAT_10',0,'[]','{}','OWN',?,?)`, [NOW, NOW]);
  applyMediaSchema(db as never);
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  useCustomerStore.getState().loadCustomers();
  useSupplierStore.getState().loadSuppliers();
  useProductStore.getState().loadProducts();
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

const bild = (seed: number): Uint8Array => Uint8Array.from({ length: 64 }, (_, i) => (seed * 41 + i * 7) & 0xff);
const alsDataUrl = (b: Uint8Array): string => `data:image/jpeg;base64,${Buffer.from(b).toString('base64')}`;
const ablegen = (b: Uint8Array): string => stageForTest(b, OWNER);

/** Die Schreibweiche einer Maske am PRIMARY — genau das, was `runSharedWrite` lokal tut. */
function primaryWrite<T>(): { remote: boolean; save: (a: { local: () => T | Promise<T> }) => Promise<unknown> } {
  return {
    remote: false,
    save: async (a) => {
      try { return { kind: 'ok', value: await a.local(), replayed: false }; }
      catch (e) { return { kind: 'business_error', code: (e as { code?: string }).code ?? 'LOCAL_WRITE_REJECTED', message: String(e) }; }
    },
  };
}
const outKind = (r: unknown): string => (r as { kind?: string })?.kind ?? 'null';
const outCode = (r: unknown): string => (r as { code?: string })?.code ?? '';

const doc = (db: Db, type: 'customer' | 'supplier', id: string): string[] =>
  (db.exec(
    `SELECT media_id FROM media_links WHERE entity_type = ? AND entity_id = ? AND media_role = 'identity_document' AND deleted_at IS NULL ORDER BY sort_order`,
    [type, id],
  )[0]?.values ?? []).map((v) => String(v[0]));
const rev = (db: Db, table: string, id: string): number => n(db, `SELECT revision FROM ${table} WHERE id = ?`, [id]);
const objekte = (db: Db): number => n(db, 'SELECT COUNT(*) FROM media_objects');
const dateien = (db: Db): number => n(db, 'SELECT COUNT(*) FROM media_blob_generations');

// ── §0 Der Vertrag: Besitzertyp, Rolle, Klasse ──────────────────────────────────────────────
{
  ok(MEDIA_ENTITY_SCOPE.customer?.table === 'customers' && MEDIA_ENTITY_SCOPE.customer?.scope === 'branch',
    '§0 der Kunde ist ein Medienbesitzer — filialgebunden, wie der Datensatz selbst');
  ok(media.IDENTITY_MEDIA_ROLE === 'identity_document' && media.IDENTITY_MEDIA_CLASS === 'sensitive',
    '§0 Rolle `identity_document`, Klasse `sensitive` — keine Verschluesselung zusaetzlich zum Dateisystem');
}

// ── §1 Kunde: anlegen ohne Foto, anlegen mit Foto ───────────────────────────────────────────
{
  const db = freshDb();
  const ohne = await custSave.saveCustomerCreate(primaryWrite() as never, { firstName: 'Ohne', lastName: 'Foto' });
  ok(outKind(ohne) === 'ok', `§1 ein Kunde ohne Ausweisfoto wird angelegt (${outKind(ohne)} ${outCode(ohne)})`);
  const ohneId = (ohne as { value: { customerId: string } }).value.customerId;
  ok(doc(db, 'customer', ohneId).length === 0 && objekte(db) === 0,
    '§1 …und es entsteht kein Medium, keine Datei, keine Verknuepfung');

  const mit = await custSave.saveCustomerCreate(
    primaryWrite() as never, { firstName: 'Mit', lastName: 'Foto' }, { kind: 'set', dataUrl: alsDataUrl(bild(1)) },
  );
  ok(outKind(mit) === 'ok', `§1 ein Kunde MIT Ausweisfoto wird angelegt (${outKind(mit)} ${outCode(mit)})`);
  const mitId = (mit as { value: { customerId: string } }).value.customerId;
  const g = doc(db, 'customer', mitId);
  ok(g.length === 1, `§1 …genau EIN aktives Dokument (${g.length})`);
  ok(n(db, "SELECT COUNT(*) FROM media_objects WHERE security_class = 'sensitive'") === 1,
    '§1 …angelegt als `sensitive`, nicht als Galeriebild');
  const refDoc = media.identityDocumentRefFor('customer', mitId);
  ok(refDoc?.mediaId === g[0] && refDoc.key.endsWith('.jpg') && refDoc.generationNo >= 1 && refDoc.hash.length === 64,
    '§1 …die Auskunft nennt Medium, Fassung, Schluessel und Hash — keine Bytes');
  ok(useCustomerStore.getState().getCustomer(mitId)?.identity?.mediaId === g[0],
    '§1 …und der Kundendatensatz traegt die Referenz (Listen brauchen keine zweite Abfrage)');
}

// ── §2 Kunde: austauschen, entfernen, Fassung, veralteter Stand ─────────────────────────────
{
  const db = freshDb();
  const kunde = () => useCustomerStore.getState().getCustomer('cust-1')!;
  const r1 = await custSave.saveCustomerUpdate(primaryWrite() as never, kunde(), {}, { kind: 'set', dataUrl: alsDataUrl(bild(2)) });
  ok(outKind(r1) === 'ok' && doc(db, 'customer', 'cust-1').length === 1,
    `§2 hinzufuegen am bestehenden Kunden (${outKind(r1)} ${outCode(r1)})`);
  const rev1 = rev(db, 'customers', 'cust-1');
  ok(rev1 === 2, `§2 …und das ist GENAU eine Fassung mehr (1 → ${rev1})`);

  useCustomerStore.getState().loadCustomers();
  const erstes = doc(db, 'customer', 'cust-1')[0];
  const r2 = await custSave.saveCustomerUpdate(primaryWrite() as never, kunde(), {}, { kind: 'set', dataUrl: alsDataUrl(bild(3)) });
  const zweites = doc(db, 'customer', 'cust-1');
  ok(outKind(r2) === 'ok' && zweites.length === 1 && zweites[0] !== erstes,
    '§2 austauschen: wieder genau EIN aktives Dokument, und es ist ein anderes');
  ok(rev(db, 'customers', 'cust-1') === rev1 + 1,
    `§2 …ein Austausch ist EINE Fassung, nicht zwei (${rev1} → ${rev(db, 'customers', 'cust-1')})`);
  // Jede Aufnahme erzeugt zwei Dateien: das Bild und seine Vorschau.
  ok(objekte(db) === 2 && dateien(db) === 4,
    `§2 …das alte Medium bleibt als Zeile bestehen (${objekte(db)} Objekte, ${dateien(db)} Dateien) — nichts wird gelöscht`);

  useCustomerStore.getState().loadCustomers();
  const rev2 = rev(db, 'customers', 'cust-1');
  const r3 = await custSave.saveCustomerUpdate(primaryWrite() as never, kunde(), {}, { kind: 'remove' });
  ok(outKind(r3) === 'ok' && doc(db, 'customer', 'cust-1').length === 0,
    '§2 entfernen: kein aktives Dokument mehr');
  ok(rev(db, 'customers', 'cust-1') === rev2 + 1, '§2 …auch das ist genau eine Fassung');
  ok(media.identityDocumentRefFor('customer', 'cust-1') === null,
    '§2 …und die Auskunft nennt keines mehr (§11: entfernt heisst entfernt)');

  // Veralteter Stand: der Bildschirm hat Fassung 2 gesehen, die Zeile ist laengst weiter.
  useCustomerStore.getState().loadCustomers();
  const veraltet = { ...kunde(), revision: 2 };
  const r4 = await custSave.saveCustomerUpdate(primaryWrite() as never, veraltet, {}, { kind: 'set', dataUrl: alsDataUrl(bild(4)) });
  ok(outKind(r4) === 'business_error' && outCode(r4) === 'RECORD_CHANGED',
    `§2 ein veralteter Stand wird abgewiesen (${outKind(r4)} ${outCode(r4)})`);
  ok(doc(db, 'customer', 'cust-1').length === 0,
    '§2 …und es wurde NICHTS geschrieben (fail-closed)');
}

// ── §3 Lieferant: eigenes Dokument ──────────────────────────────────────────────────────────
{
  const db = freshDb();
  const neu = await mdSave.saveSupplierCreate(primaryWrite() as never, { name: 'Goldhandel', cprImage: alsDataUrl(bild(5)) } as never);
  ok(outKind(neu) === 'ok', `§3 ein Lieferant mit eigenem Ausweisfoto (${outKind(neu)} ${outCode(neu)})`);
  const sid = (neu as { value: { supplierId: string } }).value.supplierId;
  ok(doc(db, 'supplier', sid).length === 1, '§3 …als Medium, genau eines');
  ok(s(db, 'SELECT COALESCE(cpr_image, %s) FROM suppliers WHERE id = ?'.replace('%s', "''"), [sid]) === '',
    '§3 …und die alte Spalte `cpr_image` bleibt LEER (kein Base64 mehr in der Zeile)');

  useSupplierStore.getState().loadSuppliers();
  const basis = () => useSupplierStore.getState().getSupplier(sid)!;
  const erstes = doc(db, 'supplier', sid)[0];
  const r2 = await mdSave.saveSupplierUpdate(primaryWrite() as never, basis(), { ...basis(), cprImage: alsDataUrl(bild(6)) } as never);
  const zweites = doc(db, 'supplier', sid);
  ok(outKind(r2) === 'ok' && zweites.length === 1 && zweites[0] !== erstes, '§3 austauschen');
  useSupplierStore.getState().loadSuppliers();
  const rev1 = rev(db, 'suppliers', sid);
  const r3 = await mdSave.saveSupplierUpdate(primaryWrite() as never, basis(), { ...basis(), cprImage: null } as never);
  ok(outKind(r3) === 'ok' && doc(db, 'supplier', sid).length === 0, '§3 entfernen');
  ok(rev(db, 'suppliers', sid) === rev1 + 1, '§3 …je genau eine Fassung des Lieferanten');
}

// ── §4 Verknuepfte Identitaet: der Kunde fuehrt ─────────────────────────────────────────────
{
  const db = freshDb();
  // Der Kunde bekommt sein Dokument…
  const kunde = () => useCustomerStore.getState().getCustomer('cust-1')!;
  await custSave.saveCustomerUpdate(primaryWrite() as never, kunde(), {}, { kind: 'set', dataUrl: alsDataUrl(bild(7)) });
  useCustomerStore.getState().loadCustomers();
  const kundenDok = doc(db, 'customer', 'cust-1')[0];

  // …und ein Lieferant ist seine Lieferantenrolle.
  db.run("UPDATE suppliers SET linked_customer_id = 'cust-1' WHERE id = 'sup-1'");
  useSupplierStore.getState().loadSuppliers();

  const sicht = media.identityDocumentFor('supplier', 'sup-1');
  ok(sicht.ref?.mediaId === kundenDok && sicht.source.fromLinkedCustomer && sicht.source.ownerId === 'cust-1',
    '§4 der verknuepfte Lieferant zeigt das Dokument DES KUNDEN');
  ok(doc(db, 'supplier', 'sup-1').length === 0,
    '§4 …ohne eine eigene Verknuepfung (kein Spiegel)');
  ok(objekte(db) === 1 && dateien(db) === 2,
    `§4 …und ohne zweite Kopie: EIN Medium, nur Bild und Vorschau (${objekte(db)} Objekt, ${dateien(db)} Dateien)`);
  ok(useSupplierStore.getState().getSupplier('sup-1')?.identity?.fromLinkedCustomer === true,
    '§4 …die Auskunft sagt ausdruecklich, WESSEN Dokument es ist (Maske: „from linked customer")');

  // Ein Speichern am Lieferanten darf das Dokument des Kunden nicht still ersetzen.
  const basis = () => useSupplierStore.getState().getSupplier('sup-1')!;
  const versuch = await mdSave.saveSupplierUpdate(primaryWrite() as never, basis(), { ...basis(), cprImage: alsDataUrl(bild(8)) } as never);
  ok(outKind(versuch) === 'business_error' && outCode(versuch) === media.IDENTITY_FROM_LINKED_CUSTOMER,
    `§4 der Lieferant kann das Kundendokument NICHT still ersetzen (${outKind(versuch)} ${outCode(versuch)})`);
  ok(doc(db, 'customer', 'cust-1')[0] === kundenDok && doc(db, 'supplier', 'sup-1').length === 0,
    '§4 …und nichts wurde geschrieben — weder beim Kunden noch beim Lieferanten');
  const entfernen = await mdSave.saveSupplierUpdate(primaryWrite() as never, basis(), { ...basis(), cprImage: null } as never);
  ok(outKind(entfernen) === 'business_error' && outCode(entfernen) === media.IDENTITY_FROM_LINKED_CUSTOMER,
    '§4 …und entfernen ebenso wenig');

  // Tauscht der KUNDE aus, sieht der Lieferant beim naechsten Lesen das neue.
  useCustomerStore.getState().loadCustomers();
  const supplierRevVorher = rev(db, 'suppliers', 'sup-1');
  const kundeRevVorher = rev(db, 'customers', 'cust-1');
  await custSave.saveCustomerUpdate(primaryWrite() as never, kunde(), {}, { kind: 'set', dataUrl: alsDataUrl(bild(9)) });
  const neuesDok = doc(db, 'customer', 'cust-1')[0];
  ok(neuesDok !== kundenDok && media.identityDocumentFor('supplier', 'sup-1').ref?.mediaId === neuesDok,
    '§4 der Kunde tauscht aus → der verknuepfte Lieferant sieht beim naechsten Lesen das neue');
  ok(rev(db, 'customers', 'cust-1') === kundeRevVorher + 1 && rev(db, 'suppliers', 'sup-1') === supplierRevVorher,
    `§4 …und das revisioniert den KUNDEN, nicht den Lieferanten (Lieferant bleibt ${supplierRevVorher})`);
}

// ── §5 Grenzen ──────────────────────────────────────────────────────────────────────────────
{
  const db = freshDb();
  // Ein Kunde einer anderen Filiale: die Verknuepfung wird gar nicht erst geschrieben.
  const mediaId = await media.ingestIdentityPhoto(alsDataUrl(bild(10)), 'customer');
  let fremd = '';
  try { media.applyIdentityDocument('customer', 'cust-x', mediaId); } catch (e) { fremd = (e as { code?: string }).code ?? ''; }
  // Der Datensatz liegt in der anderen Filiale, das Medium in dieser: der Kern sagt genau das
  // (`MEDIA_LINK_SCOPE_MISMATCH`). Entscheidend ist, dass ueber die Filialgrenze NICHTS entsteht.
  ok(fremd === 'MEDIA_LINK_SCOPE_MISMATCH', `§5 ein Kunde einer anderen Filiale bekommt nichts (${fremd})`);
  ok(doc(db, 'customer', 'cust-x').length === 0, '§5 …und es wurde nichts geschrieben');

  let weg = '';
  try { media.applyIdentityDocument('customer', 'gibt-es-nicht', mediaId); } catch (e) { weg = (e as { code?: string }).code ?? ''; }
  ok(weg === media.IDENTITY_OWNER_NOT_FOUND, `§5 ein Datensatz, den es nicht gibt, ebenso (${weg})`);

  let fehlt = '';
  try { media.applyIdentityDocument('customer', 'cust-1', 'media-gibt-es-nicht'); } catch (e) { fehlt = (e as { code?: string }).code ?? ''; }
  ok(fehlt === media.IDENTITY_PHOTO_NOT_FOUND, `§5 ein Medium, das es nicht gibt, wird benannt (${fehlt})`);

  // Und ein entferntes Dokument ist kein aktuelles mehr — auch nicht in der Batchauflösung.
  media.applyIdentityDocument('customer', 'cust-1', mediaId);
  ok(media.identityDocumentRefFor('customer', 'cust-1')?.mediaId === mediaId, '§5 gesetzt');
  media.applyIdentityDocument('customer', 'cust-1', null);
  ok(media.identityDocumentRefFor('customer', 'cust-1') === null
    && (media.identityDocumentsFor('customer', ['cust-1']).get('cust-1') ?? null) === null,
    '§5 …entfernt heisst entfernt, einzeln wie in der Liste');
}

// ── §6 PC2: derselbe Weg ueber die Befehle ──────────────────────────────────────────────────
{
  const db = freshDb();
  const st = ablegen(bild(11));
  const r = await custCmd.runCustomerCreate(deps(db), identity('601', 'customers.create'), {
    firstName: 'Fern', lastName: 'Kunde', idPhotoStagingId: st,
  });
  ok(r.kind === 'ok', `§6 PC2 legt einen Kunden mit Ausweisfoto an (${r.kind} ${outCode(r)})`);
  const cid = (r as { value: { customerId: string } }).value.customerId;
  ok(doc(db, 'customer', cid).length === 1 && n(db, "SELECT COUNT(*) FROM media_objects WHERE security_class='sensitive'") === 1,
    '§6 …mit demselben Ergebnis wie am Primary: ein `sensitive` Medium, eine Verknuepfung');

  // Austauschen mit Stand — und ohne Stand wird es abgewiesen.
  const ohneStand = await custCmd.runCustomerUpdate(deps(db), identity('602', 'customers.update'), {
    id: cid, idPhotoStagingId: ablegen(bild(12)),
  }).catch((e) => e);
  ok((ohneStand as { code?: string }).code === 'CUSTOMER_PAYLOAD_INVALID',
    '§6 ein Dokumentwechsel OHNE genannten Stand wird abgewiesen');

  const vorher = doc(db, 'customer', cid)[0];
  const r2 = await custCmd.runCustomerUpdate(deps(db), identity('603', 'customers.update'), {
    id: cid, idPhotoStagingId: ablegen(bild(13)), expectedRevision: rev(db, 'customers', cid),
  });
  ok(r2.kind === 'ok' && doc(db, 'customer', cid)[0] !== vorher, `§6 …mit Stand geht es (${r2.kind} ${outCode(r2)})`);

  const r3 = await custCmd.runCustomerUpdate(deps(db), identity('604', 'customers.update'), {
    id: cid, idPhoto: null, expectedRevision: 1,
  });
  ok(r3.kind === 'rejected' && outCode(r3) === 'RECORD_CHANGED',
    `§6 ein veralteter Stand wird auch fern abgewiesen (${r3.kind} ${outCode(r3)})`);

  // Lieferant fern
  const sr = await mdCmd.runSupplierCreate(deps(db), identity('605', 'suppliers.create'), {
    name: 'Fernlieferant', cprImageStagingId: ablegen(bild(14)),
  });
  ok(sr.kind === 'ok', `§6 PC2 legt einen Lieferanten mit Ausweisfoto an (${sr.kind} ${outCode(sr)})`);
  const sid = (sr as { value: { supplierId: string } }).value.supplierId;
  ok(doc(db, 'supplier', sid).length === 1 && s(db, "SELECT COALESCE(cpr_image,'') FROM suppliers WHERE id = ?", [sid]) === '',
    '§6 …auch fern niemals in die Spalte');

  db.run('UPDATE suppliers SET linked_customer_id = ? WHERE id = ?', [cid, sid]);
  const sperre = await mdCmd.runSupplierUpdate(deps(db), identity('606', 'suppliers.update'), {
    id: sid, cprImageStagingId: ablegen(bild(15)), expectedRevision: rev(db, 'suppliers', sid),
  });
  ok(sperre.kind === 'rejected' && outCode(sperre) === media.IDENTITY_FROM_LINKED_CUSTOMER,
    `§6 …und die Verknuepfungsregel gilt fern genauso (${sperre.kind} ${outCode(sperre)})`);
}

// ── §7 Telefon: Reparatur und Kommission ────────────────────────────────────────────────────
{
  const rp = codeOf(src('src-tauri/src/sync/mobile_repair_ui.js'));
  const cn = codeOf(src('src-tauri/src/sync/mobile_consignment_ui.js'));
  for (const [name, js, feld] of [['Reparatur', rp, 'rpCustomerIdPhoto'], ['Kommission', cn, 'cnConsignorIdPhoto']] as const) {
    ok(js.includes(feld) && js.includes('resizePhoto('),
      `§7 ${name}: das Telefon nimmt ein Ausweisfoto auf und verkleinert es mit DEM vorhandenen Helfer`);
    ok(/stagePhoto\([A-Z]{2}\.idPhoto\)/.test(js) && js.includes('body.idPhotoStagingId = s.stagingId'),
      `§7 ${name}: erst in die Ablage, dann nur die Inhaltskennung im Auftrag — nie Bytes`);
    ok(/if \(!s\.ok\) \{[^}]*Nothing was created/.test(js),
      `§7 ${name}: scheitert die Ablage, wird GAR KEIN Kunde angelegt`);
  }
  for (const [name, html, feld] of [
    ['Reparatur', src('src-tauri/src/sync/mobile_repair.html'), 'rpCustomerIdPhoto'],
    ['Kommission', src('src-tauri/src/sync/mobile_consignment.html'), 'cnConsignorIdPhoto'],
  ] as const) {
    ok(html.includes(`id="${feld}"`) && html.includes('optional'),
      `§7 ${name}: das Feld steht in der Maske und ist ausdruecklich optional`);
  }
  ok(!rp.includes('rpCustomerIdEdit') && !cn.includes('cnConsignorIdEdit'),
    '§7 es gibt KEIN allgemeines Kunden-Bearbeiten am Telefon (nur Anlegen)');
}

// ── §8 Einkauf: die Fassung wird eingefroren ────────────────────────────────────────────────
{
  const db = freshDb();
  const supplier = () => useSupplierStore.getState().getSupplier('sup-1')!;
  await mdSave.saveSupplierUpdate(primaryWrite() as never, supplier(), { ...supplier(), cprImage: alsDataUrl(bild(20)) } as never);
  useSupplierStore.getState().loadSuppliers();
  const damals = media.identityDocumentRefFor('supplier', 'sup-1')!;

  const kauf = usePurchaseStore.getState().createPurchase({
    supplierId: 'sup-1', lines: [{ productId: 'p1', quantity: 1, unitPrice: 100 }],
  } as never);
  const snap = JSON.parse(s(db, 'SELECT supplier_snapshot FROM purchases WHERE id = ?', [kauf.id]) || '{}');
  ok(snap.identity && snap.identity.mediaId === damals.mediaId && snap.identity.generationNo === damals.generationNo
    && snap.identity.blobHash === damals.hash && snap.identity.ownerType === 'supplier' && snap.identity.ownerId === 'sup-1',
    '§8 der Einkauf friert Medium, Fassung, Hash und Besitzer ein');
  ok(!snap.cprImage && !String(s(db, 'SELECT supplier_snapshot FROM purchases WHERE id = ?', [kauf.id])).includes('data:'),
    '§8 …und KEINE Bytes im Beleg');

  // Der Lieferant tauscht spaeter aus — der alte Beleg bleibt, wie er war.
  useSupplierStore.getState().loadSuppliers();
  await mdSave.saveSupplierUpdate(primaryWrite() as never, supplier(), { ...supplier(), cprImage: alsDataUrl(bild(21)) } as never);
  const heute = media.identityDocumentRefFor('supplier', 'sup-1')!;
  const snap2 = JSON.parse(s(db, 'SELECT supplier_snapshot FROM purchases WHERE id = ?', [kauf.id]) || '{}');
  ok(heute.mediaId !== damals.mediaId, '§8 der Lieferant hat jetzt ein anderes Dokument');
  ok(snap2.identity.mediaId === damals.mediaId && snap2.identity.generationNo === damals.generationNo,
    '§8 …und der alte Einkauf zeigt weiterhin die DAMALIGE Fassung');
  ok(n(db, 'SELECT COUNT(*) FROM media_blob_generations WHERE stored_blob_hash = ?', [damals.hash]) === 1
    && n(db, 'SELECT COUNT(*) FROM media_objects') === 2,
    '§8 …die damalige Datei ist noch da (nichts wird geloescht, solange ein Beleg sie nennt)');

  // Altbestand: ein Lieferant, dessen Ausweis NIE im Medienspeicher lag, behaelt seinen Nachweis.
  db.run("UPDATE suppliers SET cpr_image = 'data:image/jpeg;base64,QUJD' WHERE id = 'sup-x'");
  db.run("UPDATE suppliers SET branch_id = 'branch-main' WHERE id = 'sup-x'");
  useSupplierStore.getState().loadSuppliers();
  const alt = usePurchaseStore.getState().createPurchase({
    supplierId: 'sup-x', lines: [{ productId: 'p1', quantity: 1, unitPrice: 50 }],
  } as never);
  const snapAlt = JSON.parse(s(db, 'SELECT supplier_snapshot FROM purchases WHERE id = ?', [alt.id]) || '{}');
  ok(!snapAlt.identity && snapAlt.cprImage === 'data:image/jpeg;base64,QUJD',
    '§8 ALTBESTAND: ohne Dokument im Medienspeicher bleibt der alte Abzug der Nachweis — kein Beleg ohne Nachweis');
}

// ── §9 Nirgends neue Bytes ──────────────────────────────────────────────────────────────────
{
  const db = freshDb();
  await custSave.saveCustomerCreate(primaryWrite() as never, { firstName: 'A', lastName: 'B' }, { kind: 'set', dataUrl: alsDataUrl(bild(30)) });
  await mdSave.saveSupplierCreate(primaryWrite() as never, { name: 'C', cprImage: alsDataUrl(bild(31)) } as never);
  ok(n(db, "SELECT COUNT(*) FROM suppliers WHERE COALESCE(cpr_image,'') LIKE 'data:%'") === 0,
    '§9 keine einzige neue Daten-URL in `suppliers.cpr_image`');
  ok(n(db, "SELECT COUNT(*) FROM purchases WHERE COALESCE(supplier_snapshot,'') LIKE '%data:%'") === 0,
    '§9 …und keine in einem neuen Einkaufsbeleg');

  const store = codeOf(src('src/stores/supplierStore.ts'));
  ok(!/INSERT INTO suppliers \([^)]*cpr_image/.test(store) && !/cprImage: 'cpr_image'/.test(store),
    '§9 der Lieferanten-Schreiber kennt die Spalte gar nicht mehr als Ziel');
  ok(/SELECT name, phone, email, address, cpr FROM suppliers/.test(codeOf(src('src/stores/purchaseStore.ts'))),
    '§9 der Einkauf liest die Bildspalte nicht mehr direkt (nur noch ueber den Altbestand-Helfer)');
}

// ── §10 Der Kern bleibt unberuehrt ──────────────────────────────────────────────────────────
{
  const db = freshDb();
  const repairMedia = await import('../../src/core/repairs/repair-media.ts');
  const productMedia = codeOf(src('src/core/media/product-media-resolver.ts'));
  ok(repairMedia.REPAIR_MEDIA_ROLE === 'gallery',
    '§10 die Reparatur behaelt Rolle `gallery` (Klasse `internal`) — nichts daran geaendert');
  ok(!productMedia.includes('identity_document'),
    '§10 der Artikel-Resolver weiss nichts von Ausweisdokumenten');
  const resolver = codeOf(src('src/core/media/owner-media-resolver.ts'));
  ok(/classes \?\? \['public', 'internal'\]/.test(resolver),
    '§10 `sensitive` kommt nur auf ausdrueckliche Nachfrage — eine Galerie bekommt nie ein Ausweisfoto');
  ok(/'highly_sensitive'/.test(resolver) && /filter\(\(c\) => c !== 'highly_sensitive'\)/.test(resolver),
    '§10 …und `highly_sensitive` wird weiterhin nie geliefert');
  const grant = src('src-tauri/src/sync/product_query.rs');
  ok(grant.includes("l.entity_type = 'customer' AND l.media_role = 'identity_document'")
    && grant.includes("o.security_class = 'sensitive' AND ?4 = 1"),
    '§10 das Tor der LAN-Route hat fuer das Ausweisdokument eine EIGENE Regel (Besitzer, Rolle, Klasse, Leserolle)');
  ok(/role_may_read_identity\(role, "supplier"\)/.test(grant),
    '§10 …und die Leserolle entscheidet mit (Verkauf sieht keinen Lieferantenausweis)');
  void db;
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — media identity documents: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('MEDIA_IDENTITY_DOCUMENTS_PROVED');
