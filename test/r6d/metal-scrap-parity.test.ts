// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6D — Edelmetall und Altgold: EINE Hausfolge je fachlicher Aktion, Primary und
// PC2 mit derselben Wirkung, jede Handlung ganz oder gar nicht.
// Run: node test/r6d/metal-scrap-parity.test.ts
//
// Gefahren werden die ECHTEN Hausfolgen, Stores, Buchungsfunktionen, die echte C3A-Maschine mit
// durablem Nachweis und das echte Schema. Gestellt sind nur das Speichern, die Zwischenablage und —
// im Client-Abschnitt — das Netz.
//
//   §1 Umfang       §2 metals.create (Primary zuerst)   §3 metals.create (fern, Parität, Fehler)
//   §4 metals.update_status   §5 metals.set_spot_price + Auskunft   §6 scrap_trades.create
//   §7 scrap_trades.update    §8 scrap_trades.cancel   §9 Fotos über die Ablage
//   §10 Client ohne Bücher    §11 Oberfläche
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    if (specifier === '@/core/db/database') {
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
const { COMMAND_LEDGER_DDL, COMMAND_LEDGER_INDEX, lookupCommand } = await import('../../src/core/bridge/command-ledger.ts');
const { resetDurabilityStateForTest } = await import('../../src/core/bridge/durability-state.ts');
const { resetTransactionHealthForTest } = await import('../../src/core/db/transaction-health.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const registry = await import('../../src/core/bridge/command-registry.ts');
// POST-PARITY R7B PP-12 — Node hat kein Tauri: der Belegbild-Normalisierer wird hier gestellt (JPEG,
// dieselben Bytes). Was der echte tut (≤ 100 000 B), prüfen `cargo test media::record_image` und der
// Zwei-Rechner-Lauf; hier zählt, DASS die Maske des Primary ihn ruft.
const recordImage = await import('../../src/core/media/record-image.ts');
let normalisiert = 0;
recordImage.setRecordImageNormalizer(async (dataBase64) => { normalisiert++; return { mime: 'image/jpeg', dataBase64, bytes: 0, width: 0, height: 0 }; });
const perms = await import('../../src/core/bridge/command-permissions.ts');
const readOps = await import('../../src/core/bridge/store-read-ops.ts');
const mc = await import('../../src/core/bridge/metal-commands.ts');
await import('../../src/core/bridge/store-read-commands.ts');
const house = await import('../../src/core/metals/metal-house.ts');
const scrap = await import('../../src/core/metals/scrap-house.ts');
const actions = await import('../../src/core/metals/metal-actions.ts');
const { useMetalStore } = await import('../../src/stores/metalStore.ts');
const { useScrapTradeStore } = await import('../../src/stores/scrapTradeStore.ts');
const { runSharedWrite } = await import('../../src/core/data/shared-write.ts');
const { CommandSaveController } = await import('../../src/core/bridge/client-command-save.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const marker = (m: string): void => { if (fails.length === 0) console.log(m); };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const codeOf = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const S = (v: unknown): string => JSON.stringify(v);
const NOW = '2026-09-13T10:00:00.000Z';

interface Db {
  run(sql: string, p?: unknown[]): unknown;
  exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
  export(): Uint8Array;
}
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const n = (db: Db, sql: string, p: unknown[] = []): number => Number(one(db, sql, p) ?? 0);
const rows = (db: Db, sql: string, p: unknown[] = []): Array<Record<string, unknown>> => {
  const r = db.exec(sql, p)[0];
  return r ? r.values.map((v) => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))) : [];
};

function realMigrations(): string[] {
  const dbSrc = src('src/core/db/database.ts');
  const start = dbSrc.indexOf('const migrations: string[] = [');
  const end = dbSrc.indexOf('\n  ];', start);
  return [...dbSrc.slice(start, end).matchAll(/`([^`]*)`/g)].map((m) => m[1]);
}
const MIGRATIONS = realMigrations();

/** Eine Zeile mit allen NOT-NULL-Spalten, damit ein Test nicht an einer Schema-Kleinigkeit scheitert. */
function insert(db: Db, table: string, values: Record<string, unknown>): void {
  const cols = rows(db, `PRAGMA table_info(${table})`);
  const data: Record<string, unknown> = { ...values };
  for (const c of cols) {
    const name = String(c.name);
    if (!c.notnull || c.dflt_value !== null || c.pk || data[name] !== undefined) continue;
    const t = String(c.type || '').toUpperCase();
    data[name] = /INT|REAL|NUM/.test(t) ? 0 : (/_at$|date/i.test(name) ? NOW : '');
  }
  const use = Object.keys(data).filter((k) => cols.some((c) => c.name === k));
  db.run(`INSERT INTO ${table} (${use.join(', ')}) VALUES (${use.map(() => '?').join(', ')})`, use.map((k) => data[k]));
}

function freshDb(): Db {
  const db = new SQL.Database() as unknown as Db;
  db.run(src('src/core/db/schema.sql'));
  for (const stmt of MIGRATIONS) { try { db.run(stmt); } catch { /* schon da */ } }
  for (const stmt of A1_UPGRADE_SQL) { try { db.run(stmt); } catch { /* schon da */ } }
  db.run(COMMAND_LEDGER_DDL);
  db.run(COMMAND_LEDGER_INDEX);
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-main','tenant-1','Haupt',?,?)", [NOW, NOW]);
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-other','tenant-1','Andere',?,?)", [NOW, NOW]);
  insert(db, 'customers', { id: 'c1', branch_id: 'branch-main', first_name: 'Maya', last_name: 'Main', created_at: NOW, updated_at: NOW });
  insert(db, 'customers', { id: 'c2', branch_id: 'branch-other', first_name: 'Otto', last_name: 'Other', created_at: NOW, updated_at: NOW });
  insert(db, 'suppliers', { id: 's1', branch_id: 'branch-main', name: 'Gold Dealer', active: 1, created_at: NOW, updated_at: NOW });
  insert(db, 'suppliers', { id: 's2', branch_id: 'branch-other', name: 'Foreign Dealer', active: 1, created_at: NOW, updated_at: NOW });
  const spot = (b: string, t: string, v: string) => db.run("INSERT INTO settings (branch_id, key, value, category, updated_at) VALUES (?, ?, ?, 'metals', ?)", [b, `spot_price.${t}`, v, NOW]);
  spot('branch-main', 'gold', '30'); spot('branch-main', 'silver', '0.5');
  spot('branch-other', 'gold', '99');
  setTestDatabase(db as never);
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  return db;
}

const ID = (k: number): string => `${String(k).padStart(8, '0')}-0000-4000-8000-000000000000`;
let seq = 0;
const nextId = (): string => ID(++seq);
const identity = (commandId: string, op: string, branchId = 'branch-main', hash = 'h') => ({
  commandId, tenantId: 'tenant-1', branchId, userId: 'user-test', role: 'ADMIN', op, payloadHash: hash,
});
function deps(db: Db) {
  return {
    db: db as never,
    begin: posting.beginLedgerTransaction,
    commit: posting.commitLedgerTransaction,
    rollback: posting.rollbackLedgerTransaction,
    durableSave: async () => { /* gestellt */ },
    now: () => NOW,
  };
}
async function fern(fn: () => Promise<{ kind: string; value?: unknown; replayed?: boolean; code?: string; frozen?: boolean }>) {
  try {
    const o = await fn();
    return o.kind === 'ok'
      ? { kind: 'ok' as const, value: o.value as Record<string, unknown>, replayed: o.replayed === true, code: '', frozen: false, message: '' }
      : { kind: 'rejected' as const, code: String(o.code), frozen: o.frozen === true, value: {} as Record<string, unknown>, replayed: false, message: '' };
  } catch (e) {
    return { kind: 'thrown' as const, code: String((e as { code?: unknown }).code ?? (e as Error).message), message: (e as Error).message, value: {} as Record<string, unknown>, replayed: false, frozen: false };
  }
}
function wirft(fn: () => unknown): string {
  try { fn(); return ''; } catch (e) { return String((e as { code?: unknown }).code ?? (e as Error).message); }
}
async function wirftAsync(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return ''; } catch (e) { return String((e as { code?: unknown }).code ?? (e as Error).message); }
}
function parseFails(fn: () => unknown): string {
  try { fn(); return ''; } catch (e) { return (e as Error).message; }
}

/** Ein Datenbank-Stellvertreter, der beim ersten passenden Schreiben wirft. */
function faulty(db: Db, pattern: RegExp) {
  const f = { armed: true };
  const proxy = new Proxy(db as object, {
    get(t, k) {
      if (k === 'run') {
        return (sql: string, p?: unknown[]) => {
          if (f.armed && pattern.test(sql)) throw new Error('INJECTED at ' + pattern);
          return (t as Db).run(sql, p);
        };
      }
      const v = (t as Record<string | symbol, unknown>)[k];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  }) as unknown as Db;
  setTestDatabase(proxy as never);
  return { db: proxy, f, restore: () => setTestDatabase(db as never) };
}

const ledgerRows = (db: Db, where = '1=1', p: unknown[] = []) =>
  rows(db, `SELECT account, direction, amount, source_module, source_id, transaction_id, reverses_entry_id FROM ledger_entries WHERE ${where}`, p);
const shape = (list: Array<Record<string, unknown>>): string =>
  list.map((e) => `${e.source_module}:${e.account}:${e.direction}:${Math.round(Number(e.amount) * 1000)}:${e.reverses_entry_id ? 'R' : 'O'}`).sort().join('|');
/** Jede Buchungstransaktion ist ausgeglichen: Σ Soll == Σ Haben (in Fils). */
function balanced(db: Db): boolean {
  return rows(db, `SELECT transaction_id,
      SUM(CASE WHEN direction = 'DEBIT' THEN ROUND(amount * 1000) ELSE 0 END) AS d,
      SUM(CASE WHEN direction = 'CREDIT' THEN ROUND(amount * 1000) ELSE 0 END) AS c
    FROM ledger_entries GROUP BY transaction_id`).every((r) => Number(r.d) === Number(r.c));
}
const net = (db: Db, account: string, module: string): number =>
  Math.round(n(db, `SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0) FROM ledger_entries WHERE account = ? AND source_module = ?`, [account, module]) * 1000);
const norm = (r: Record<string, unknown> | undefined, drop: RegExp): string =>
  S(Object.fromEntries(Object.entries(r ?? {}).filter(([k]) => !drop.test(k)).sort(([a], [b]) => a.localeCompare(b))));
const counts = (db: Db, ...tables: string[]): string => tables.map((t) => `${t}=${n(db, `SELECT COUNT(*) FROM ${t}`)}`).join(' ');

const METAL_OPS = ['metals.create', 'metals.update_status', 'metals.set_spot_price', 'scrap_trades.create', 'scrap_trades.update', 'scrap_trades.cancel'];
const METAL_IN = { metalType: 'gold', karat: '22K', weightGrams: 8, purchaseTotal: 50, supplierId: 's1', description: 'Bar', notes: 'n' } as const;
type TradeIn = Parameters<typeof scrap.createScrapTradeInHouse>[0];
const TRADE = (over: Partial<TradeIn> = {}): TradeIn => ({
  sellerName: 'Ali Seller', sellerPhone: '+973 1', buyerName: 'Gold Buyer', buyerPhone: '+973 2',
  tradeDate: '2026-09-13', notes: 'n',
  lines: [
    { weightGrams: 8, karat: '22K', purchasePrice: 100, salePrice: 130, notes: 'ring' },
    { weightGrams: 2, karat: '18K', purchasePrice: 20, salePrice: 25 },
  ],
  paymentsOut: [{ method: 'cash', amount: 100 }, { method: 'benefit', amount: 20 }],
  paymentsIn: [{ method: 'bank', amount: 155 }],
  ...over,
});

// ══ §1 — Umfang ═════════════════════════════════════════════════════════════
{
  ok(METAL_OPS.every((op) => registry.ALLOWED_MUTATIONS.includes(op)), 'SCOPE die sechs Metall-/Altgold-Aktionen sind namentlich freigegeben');
  ok(METAL_OPS.every((op) => registry.knownCommands().includes(op)), 'SCOPE und registriert (metal-commands.ts)');
  ok(METAL_OPS.every((op) => op in perms.OPERATION_PERMISSIONS && perms.OPERATION_PERMISSIONS[op] === null), 'SCOPE kein erfundenes Recht — die Masken des Primary haben kein Tor');
  ok(readOps.STORE_READ_OPS.includes('metals.spot_prices.get') && registry.knownCommands().includes('metals.spot_prices.get'), 'SCOPE die Spotpreis-Auskunft ist freigegeben und hat einen Handler');
  ok(S([...mc.METAL_SCRAP_OPS].sort()) === S([...METAL_OPS].sort()), 'SCOPE die Datei kennt genau diese sechs');
}
marker('CENTRAL_UI_R6D_METALS_SCOPE_PROVED');

// ══ §2 — metals.create, Primary zuerst ═════════════════════════════════════
{
  const db = freshDb();
  const r = await actions.createMetalOnPrimary({ ...METAL_IN });
  const m = rows(db, 'SELECT * FROM precious_metals')[0] ?? {};
  ok(Number(m.spot_price_at_purchase) === 30 && Number(m.current_spot_price) === 30 && Math.abs(Number(m.melt_value) - 8 * 0.916 * 30) < 1e-9,
    `CREATE Spot und Schmelzwert aus der Einstellung des Hauses (${m.spot_price_at_purchase} / ${m.melt_value})`);
  ok(m.status === 'in_stock' && m.branch_id === 'branch-main' && m.supplier_id === 's1' && m.supplier_name === 'Gold Dealer' && m.linked_expense_id === r.linkedExpenseId && !!r.linkedExpenseId,
    'CREATE am Lager, Filiale der Sitzung, Lieferantenname aus dem Stammsatz, Ausgabe verknüpft');
  const mv = rows(db, 'SELECT * FROM gold_movements')[0] ?? {};
  ok(n(db, 'SELECT COUNT(*) FROM gold_movements') === 1 && mv.direction === 'in' && Number(mv.weight_grams) === 8 && mv.karat === '22K'
    && mv.source_bucket === 'external' && mv.target_bucket === 'precious_metals' && mv.target_id === m.id && mv.source_id === 's1',
  'CREATE die Goldbewegung „in" gehört zur Handlung');
  const e = rows(db, 'SELECT * FROM expenses')[0] ?? {};
  ok(n(db, 'SELECT COUNT(*) FROM expenses') === 1 && Number(e.amount) === 50 && Number(e.paid_amount) === 0 && e.status === 'PENDING'
    && e.supplier_id === 's1' && e.related_module === 'metal' && e.related_entity_id === m.id && e.category === 'Inventory',
  'CREATE die Lieferantenschuld ist eine offene Ausgabe (payNow=false)');
  ok(shape(ledgerRows(db)) === 'EXPENSE:ACCOUNTS_PAYABLE:CREDIT:50000:O|EXPENSE:EXPENSES_OPERATING:DEBIT:50000:O' && balanced(db),
    `LEDGER DR EXPENSES_OPERATING / CR ACCOUNTS_PAYABLE 50, Quelle EXPENSE, ausgeglichen (${shape(ledgerRows(db))})`);
  ok(useMetalStore.getState().metals.some((x) => x.id === m.id && x.revision === Number(m.revision)), 'CREATE die Liste liest danach neu — mit Fassung');

  // Befunde, am Primary behoben
  ok(wirft(() => useMetalStore.getState().createMetal({ metalType: 'gold', karat: '22K', weightGrams: -1 })) === 'METAL_WEIGHT_INVALID'
    && n(db, 'SELECT COUNT(*) FROM precious_metals') === 1, 'PRIMARY ein negatives Gewicht wird abgewiesen (vorher ging es durch)');
  ok(wirft(() => useMetalStore.getState().createMetal({ metalType: 'silver', karat: '22K', weightGrams: 5 })) === 'METAL_KARAT_INVALID', 'PRIMARY die Feinheit gehört zur Metallart');
  ok(wirft(() => useMetalStore.getState().createMetal({ metalType: 'gold', karat: '22K', weightGrams: 5, purchaseTotal: -3 })) === 'METAL_AMOUNT_INVALID', 'PRIMARY kein negativer Kaufpreis');
  const z = useMetalStore.getState().createMetal({ metalType: 'platinum', karat: '950', weightGrams: 2, purchaseTotal: 0 });
  const zr = rows(db, 'SELECT purchase_total, spot_price_at_purchase, melt_value FROM precious_metals WHERE id = ?', [z.id])[0];
  ok(Number(zr.purchase_total) === 0 && zr.purchase_total !== null && zr.spot_price_at_purchase === null && zr.melt_value === null,
    'PRIMARY eine eingegebene 0 bleibt 0 (vorher NULL); ein unbekannter Spot bleibt leer wie bisher');
  ok(n(db, 'SELECT COUNT(*) FROM expenses') === 1 && n(db, "SELECT COUNT(*) FROM gold_movements") === 1, 'PRIMARY ohne Lieferant keine Schuld; Platin schreibt keine Goldbewegung');
}
marker('CENTRAL_UI_R6D_METAL_CREATE_PRIMARY_PROVED');

// ══ §3 — metals.create, fern: Parität, Wiederholung, Nein, Rücknahme ═════════
{
  // Parität: dieselben Zeilen, dieselbe Buchung
  const dbP = freshDb();
  await actions.createMetalOnPrimary({ ...METAL_IN });
  const p = { m: rows(dbP, 'SELECT * FROM precious_metals')[0], g: rows(dbP, 'SELECT * FROM gold_movements')[0], e: rows(dbP, 'SELECT * FROM expenses')[0], l: shape(ledgerRows(dbP)) };
  const dbC = freshDb();
  const idC = nextId();
  const rc = await fern(() => mc.runMetalCreate(deps(dbC), identity(idC, 'metals.create'), actions.metalCreateBody({ ...METAL_IN })));
  const c = { m: rows(dbC, 'SELECT * FROM precious_metals')[0], g: rows(dbC, 'SELECT * FROM gold_movements')[0], e: rows(dbC, 'SELECT * FROM expenses')[0], l: shape(ledgerRows(dbC)) };
  const dm = /^(id|created_at|updated_at|linked_expense_id)$/;
  ok(rc.kind === 'ok' && norm(p.m, dm) === norm(c.m, dm), `PARITY Metallzeile Primary == PC2${norm(p.m, dm) === norm(c.m, dm) ? '' : ` (${norm(p.m, dm)} / ${norm(c.m, dm)})`}`);
  const dg = /^(id|moved_at|target_id|notes)$/;
  ok(norm(p.g, dg) === norm(c.g, dg), 'PARITY Goldbewegung Primary == PC2');
  const de = /^(id|created_at|related_entity_id|description)$/;
  ok(norm(p.e, de) === norm(c.e, de), `PARITY Lieferantenschuld Primary == PC2${norm(p.e, de) === norm(c.e, de) ? '' : ` (${norm(p.e, de)} / ${norm(c.e, de)})`}`);
  ok(p.l === c.l && balanced(dbC), 'PARITY dieselbe Buchung (Konten, Richtung, Betrag, Quelle), ausgeglichen');
  ok(rc.value.metalId === c.m?.id && rc.value.status === 'in_stock' && rc.value.linkedExpenseId === c.m?.linked_expense_id
    && Number(rc.value.revision) === Number(c.m?.revision) && Number(rc.value.spotPriceAtPurchase) === 30, `RESULT klein, vom Primary gerechnet (${S(rc.value)})`);

  // Verlorene Antwort
  const again = await fern(() => mc.runMetalCreate(deps(dbC), identity(idC, 'metals.create'), actions.metalCreateBody({ ...METAL_IN })));
  ok(again.kind === 'ok' && again.replayed && again.value.metalId === rc.value.metalId
    && counts(dbC, 'precious_metals', 'gold_movements', 'expenses', 'ledger_entries') === 'precious_metals=1 gold_movements=1 expenses=1 ledger_entries=2',
  'LOST dieselbe Kennung: replayed, genau EINE Wirkung (Zeile, Bewegung, Schuld, Buchung)');

  // Verbotene, abgeleitete und unbekannte Felder
  for (const k of ['id', 'branchId', 'tenantId', 'userId', 'createdBy', 'revision', 'status', 'spotPriceAtPurchase', 'currentSpotPrice', 'meltValue', 'spot', 'linkedExpenseId', 'salePrice', 'paidAmount', 'paymentStatus', 'customerId', 'images', 'ledger', 'account', 'debit', 'credit']) {
    ok(/the primary decides/.test(parseFails(() => mc.parseMetalCreate({ ...METAL_IN, [k]: 1 }))), `PAYLOAD metals.create: ${k} gibt der Client nicht vor`);
  }
  ok(/unknown field/.test(parseFails(() => mc.parseMetalCreate({ ...METAL_IN, bogus: 1 }))), 'PAYLOAD ein unbekanntes Feld wird abgewiesen, nicht ignoriert');
  ok(/must be a number/.test(parseFails(() => mc.parseMetalCreate({ ...METAL_IN, weightGrams: '8' }))), 'PAYLOAD ein Gewicht ist eine Zahl');
  const pf = await fern(() => mc.runMetalCreate(deps(dbC), identity(nextId(), 'metals.create'), { ...METAL_IN, meltValue: 1 }));
  ok(pf.kind === 'thrown' && pf.code === 'METAL_PAYLOAD_INVALID' && n(dbC, 'SELECT COUNT(*) FROM precious_metals') === 1, 'PAYLOAD fern: ein Rumpffehler, nichts geschrieben');

  // Fachliche Neins — eingefroren, nichts geschrieben
  const before = counts(dbC, 'precious_metals', 'gold_movements', 'expenses', 'ledger_entries');
  for (const [body, code, what] of [
    [{ ...METAL_IN, supplierId: 's2' }, 'SUPPLIER_NOT_FOUND', 'ein Lieferant einer anderen Filiale'],
    [{ ...METAL_IN, supplierId: 'nope' }, 'SUPPLIER_NOT_FOUND', 'ein unbekannter Lieferant'],
    [{ ...METAL_IN, purchaseTotal: -1 }, 'METAL_AMOUNT_INVALID', 'ein negativer Kaufpreis'],
    [{ ...METAL_IN, purchasePricePerGram: -0.5 }, 'METAL_AMOUNT_INVALID', 'ein negativer Grammpreis'],
    [{ ...METAL_IN, weightGrams: 0 }, 'METAL_WEIGHT_INVALID', 'Gewicht 0'],
    [{ ...METAL_IN, weightGrams: -8 }, 'METAL_WEIGHT_INVALID', 'ein negatives Gewicht'],
    [{ ...METAL_IN, karat: '925' }, 'METAL_KARAT_INVALID', 'Silber-Feinheit an Gold'],
    [{ ...METAL_IN, metalType: 'copper' }, 'METAL_TYPE_INVALID', 'eine unbekannte Metallart'],
  ] as Array<[Record<string, unknown>, string, string]>) {
    const r = await fern(() => mc.runMetalCreate(deps(dbC), identity(nextId(), 'metals.create'), body));
    ok(r.kind === 'rejected' && r.frozen && r.code === code, `REJECT ${what} → ${code} (${r.kind} ${r.code})`);
  }
  ok(counts(dbC, 'precious_metals', 'gold_movements', 'expenses', 'ledger_entries') === before, 'REJECT kein Nein hat etwas geschrieben');
  const foreign = await fern(() => mc.runMetalCreate(deps(dbC), identity(nextId(), 'metals.create', 'branch-other'), actions.metalCreateBody({ ...METAL_IN, supplierId: undefined })));
  ok(foreign.kind === 'rejected' && foreign.code === 'BRANCH_MISMATCH' && counts(dbC, 'precious_metals') === 'precious_metals=1', 'REJECT ein Ausweis einer anderen Filiale legt nichts an');

  // Rücknahme an drei Stellen: nach der Zeile (Goldbewegung), in der Buchung (verschluckt!), bei der Verknüpfung
  for (const [pattern, what] of [
    [/INSERT INTO gold_movements/, 'die Goldbewegung scheitert'],
    [/INSERT INTO ledger_entries/, 'die A/P-Buchung scheitert (createExpense verschluckt sie — der Wächter nicht)'],
    [/UPDATE precious_metals SET linked_expense_id/, 'die Verknüpfung scheitert'],
  ] as Array<[RegExp, string]>) {
    const db = freshDb();
    const { db: bad, f, restore } = faulty(db, pattern);
    const id = nextId();
    const r = await fern(() => mc.runMetalCreate(deps(bad), identity(id, 'metals.create'), actions.metalCreateBody({ ...METAL_IN })));
    ok(r.kind === 'thrown' && counts(db, 'precious_metals', 'gold_movements', 'expenses', 'expense_payments', 'ledger_entries') === 'precious_metals=0 gold_movements=0 expenses=0 expense_payments=0 ledger_entries=0'
      && lookupCommand(db as never, identity(id, 'metals.create')).kind === 'fresh',
    `ATOMIC fern: ${what} → kein halber Zustand, die Kennung bleibt frei (${r.code})`);
    f.armed = false;
    const retry = await fern(() => mc.runMetalCreate(deps(bad), identity(id, 'metals.create'), actions.metalCreateBody({ ...METAL_IN })));
    ok(retry.kind === 'ok' && counts(db, 'precious_metals', 'expenses', 'ledger_entries') === 'precious_metals=1 expenses=1 ledger_entries=2', `ATOMIC dieselbe Kennung danach: genau eine Wirkung (${what})`);
    restore();
  }
  {
    const db = freshDb();
    const { f, restore } = faulty(db, /INSERT INTO ledger_entries/);
    const code = await wirftAsync(() => actions.createMetalOnPrimary({ ...METAL_IN }));
    ok(code !== '' && counts(db, 'precious_metals', 'gold_movements', 'expenses', 'ledger_entries') === 'precious_metals=0 gold_movements=0 expenses=0 ledger_entries=0',
      'ATOMIC Primary: scheitert die Buchung, gibt es auch kein Metall und keine Ausgabe (vorher: Metall ohne Schuld)');
    f.armed = false;
    const code2 = wirft(() => useMetalStore.getState().createMetal({ ...METAL_IN }));
    ok(code2 === '' && counts(db, 'precious_metals', 'expenses', 'ledger_entries') === 'precious_metals=1 expenses=1 ledger_entries=2', 'ATOMIC der alte synchrone Einstieg läuft durch dieselbe Folge');
    restore();
  }
}
marker('CENTRAL_UI_R6D_METAL_CREATE_REMOTE_PROVED');

// ══ §4 — metals.update_status ══════════════════════════════════════════════
{
  const db = freshDb();
  const mk = (karat = '21K', w = 10) => house.inOneTransaction(() => house.createMetalInHouse({ metalType: 'gold', karat, weightGrams: w }, 'branch-main')).metal;
  const m1 = mk();
  ok(m1.revision === 1, `REV ein Metall ohne Lieferant beginnt bei Fassung 1 (${m1.revision})`);
  const ledgerBefore = n(db, 'SELECT COUNT(*) FROM ledger_entries');
  const idS = nextId();
  const sell = await fern(() => mc.runMetalStatus(deps(db), identity(idS, 'metals.update_status'), actions.metalStatusBody(m1.id, 1, 'sold', 0)));
  const r1 = rows(db, 'SELECT status, sale_price, revision FROM precious_metals WHERE id = ?', [m1.id])[0];
  ok(sell.kind === 'ok' && r1.status === 'sold' && Number(r1.sale_price) === 0 && Number(r1.revision) === 2 && sell.value.revision === 2,
    `SELL Verkaufspreis 0 ist erlaubt (wie die Maske), Fassung hoch (${S(sell.value)})`);
  ok(n(db, 'SELECT COUNT(*) FROM ledger_entries') === ledgerBefore, 'SELL ein Verkauf bucht nichts — wie bisher (Befund, keine erfundene Erlösbuchung)');
  const rep = await fern(() => mc.runMetalStatus(deps(db), identity(idS, 'metals.update_status'), actions.metalStatusBody(m1.id, 1, 'sold', 0)));
  ok(rep.kind === 'ok' && rep.replayed && Number(one(db, 'SELECT revision FROM precious_metals WHERE id = ?', [m1.id])) === 2, 'LOST dieselbe Kennung: replayed, EIN Statuswechsel');
  const twice = await fern(() => mc.runMetalStatus(deps(db), identity(nextId(), 'metals.update_status'), actions.metalStatusBody(m1.id, 2, 'sold', 5)));
  ok(twice.kind === 'rejected' && twice.frozen && twice.code === 'METAL_NOT_IN_STOCK' && Number(one(db, 'SELECT sale_price FROM precious_metals WHERE id = ?', [m1.id])) === 0,
    'GUARD kein zweiter Verkauf (vorher möglich)');
  const melt1 = await fern(() => mc.runMetalStatus(deps(db), identity(nextId(), 'metals.update_status'), actions.metalStatusBody(m1.id, 2, 'melted')));
  ok(melt1.code === 'METAL_NOT_IN_STOCK' && one(db, 'SELECT status FROM precious_metals WHERE id = ?', [m1.id]) === 'sold', 'GUARD ein verkauftes Stück wird nicht eingeschmolzen (vorher möglich)');
  ok(wirft(() => useMetalStore.getState().updateMetal(m1.id, { status: 'melted', currentSpotPrice: 999, meltValue: 1 })) === 'METAL_NOT_IN_STOCK'
    && one(db, 'SELECT status FROM precious_metals WHERE id = ?', [m1.id]) === 'sold', 'GUARD auch der alte Store-Einstieg ist gesperrt');

  const m2 = mk('18K', 4);
  db.run("UPDATE precious_metals SET notes = 'changed elsewhere' WHERE id = ?", [m2.id]);   // eine Änderung dazwischen
  const stale = await fern(() => mc.runMetalStatus(deps(db), identity(nextId(), 'metals.update_status'), actions.metalStatusBody(m2.id, 1, 'sold', 20)));
  ok(stale.kind === 'rejected' && stale.code === 'RECORD_CHANGED' && one(db, 'SELECT status FROM precious_metals WHERE id = ?', [m2.id]) === 'in_stock', 'STALE eine veraltete Fassung: RECORD_CHANGED, nichts geändert');
  ok(await wirftAsync(() => actions.changeMetalStatusOnPrimary({ metalId: m2.id, status: 'sold', salePrice: 20, expectedRevision: 1 })) === 'RECORD_CHANGED', 'STALE die Maske am Primary prüft dieselbe Fassung');

  const m3 = mk('22K', 10);
  const melt = await fern(() => mc.runMetalStatus(deps(db), identity(nextId(), 'metals.update_status'), actions.metalStatusBody(m3.id, 1, 'melted')));
  const r3 = rows(db, 'SELECT status, current_spot_price, melt_value FROM precious_metals WHERE id = ?', [m3.id])[0];
  ok(melt.kind === 'ok' && r3.status === 'melted' && Number(r3.current_spot_price) === 30 && Math.abs(Number(r3.melt_value) - 10 * 0.916 * 30) < 1e-9,
    'MELT Spot und Schmelzwert friert das Haus aus SEINER Einstellung ein');
  for (const k of ['meltValue', 'currentSpotPrice', 'spot', 'revision', 'branchId']) {
    ok(/the primary decides/.test(parseFails(() => mc.parseMetalStatus({ metalId: 'x', expectedRevision: 1, status: 'melted', [k]: 1 }))), `PAYLOAD update_status: ${k} gibt der Client nicht vor`);
  }
  ok(/melting takes no sale price/.test(parseFails(() => mc.parseMetalStatus({ metalId: 'x', expectedRevision: 1, status: 'melted', salePrice: 3 }))), 'PAYLOAD Einschmelzen trägt keinen Preis');
  ok(/needs its sale price/.test(parseFails(() => mc.parseMetalStatus({ metalId: 'x', expectedRevision: 1, status: 'sold' }))), 'PAYLOAD ein Verkauf nennt seinen Preis');
  ok(/expectedRevision is required/.test(parseFails(() => mc.parseMetalStatus({ metalId: 'x', status: 'sold', salePrice: 1 }))), 'PAYLOAD ohne gesehene Fassung kein Statuswechsel');
  ok(/status is sold or melted/.test(parseFails(() => mc.parseMetalStatus({ metalId: 'x', expectedRevision: 1, status: 'in_stock' }))), 'PAYLOAD zurück ans Lager gibt es nicht');
  const m4 = mk();
  const neg = await fern(() => mc.runMetalStatus(deps(db), identity(nextId(), 'metals.update_status'), actions.metalStatusBody(m4.id, 1, 'sold', -5)));
  ok(neg.kind === 'rejected' && neg.code === 'METAL_SALE_PRICE_INVALID' && one(db, 'SELECT status FROM precious_metals WHERE id = ?', [m4.id]) === 'in_stock', 'REJECT ein negativer Verkaufspreis');
  insert(db, 'precious_metals', { id: 'mx', branch_id: 'branch-other', metal_type: 'gold', karat: '21K', weight_grams: 1, status: 'in_stock', created_at: NOW, updated_at: NOW });
  const fx = await fern(() => mc.runMetalStatus(deps(db), identity(nextId(), 'metals.update_status'), actions.metalStatusBody('mx', 1, 'sold', 1)));
  ok(fx.code === 'METAL_NOT_FOUND' && one(db, "SELECT status FROM precious_metals WHERE id = 'mx'") === 'in_stock', 'REJECT ein Metall einer anderen Filiale ist nicht vorhanden');

  // Parität Primary == PC2
  const dbP = freshDb(); const a = mk('21K', 3);
  await actions.changeMetalStatusOnPrimary({ metalId: a.id, status: 'sold', salePrice: 12.5, paymentMethod: 'bank', expectedRevision: 1 });
  const pRow = rows(dbP, 'SELECT * FROM precious_metals')[0];
  const pLedger = rows(dbP, "SELECT account, direction, amount FROM ledger_entries WHERE source_module = 'METAL_PAYMENT' ORDER BY account");
  const dbC = freshDb(); const b = mk('21K', 3);
  await fern(() => mc.runMetalStatus(deps(dbC), identity(nextId(), 'metals.update_status'), actions.metalStatusBody(b.id, 1, 'sold', 12.5, 'bank')));
  const cRow = rows(dbC, 'SELECT * FROM precious_metals')[0];
  const cLedger = rows(dbC, "SELECT account, direction, amount FROM ledger_entries WHERE source_module = 'METAL_PAYMENT' ORDER BY account");
  const d = /^(id|created_at|updated_at)$/;
  ok(norm(pRow, d) === norm(cRow, d), 'PARITY Verkauf Primary == PC2');
  ok(S(pLedger) === S(cLedger) && S(pLedger) === S([{ account: 'BANK', direction: 'DEBIT', amount: 12.5 }, { account: 'REVENUE', direction: 'CREDIT', amount: 12.5 }])
    && pRow.payment_status === 'PAID' && Number(pRow.paid_amount) === 12.5,
    `PARITY der Verkauf bucht das Geld: Soll Bank / Haben Erlös, bezahlt — auf beiden Rechnern gleich (${S(pLedger)})`);
  const ohne = await fern(() => mc.runMetalStatus(deps(dbC), identity(nextId(), 'metals.update_status'), actions.metalStatusBody(mk('21K', 3).id, 1, 'sold', 9)));
  ok(ohne.kind === 'rejected' && ohne.code === 'METAL_PAYMENT_METHOD_REQUIRED', `REJECT ein Verkauf mit Preis nennt den Zahlweg (${ohne.code})`);
  const dbP2 = freshDb(); const a2 = mk('22K', 3);
  await actions.changeMetalStatusOnPrimary({ metalId: a2.id, status: 'melted', expectedRevision: 1 });
  const pMelt = rows(dbP2, 'SELECT * FROM precious_metals')[0];
  const dbC2 = freshDb(); const b2 = mk('22K', 3);
  await fern(() => mc.runMetalStatus(deps(dbC2), identity(nextId(), 'metals.update_status'), actions.metalStatusBody(b2.id, 1, 'melted')));
  ok(norm(pMelt, d) === norm(rows(dbC2, 'SELECT * FROM precious_metals')[0], d), 'PARITY Einschmelzen Primary == PC2');
}
marker('CENTRAL_UI_R6D_METAL_STATUS_PROVED');

// ══ §5 — metals.set_spot_price + Auskunft ═══════════════════════════════════
{
  const db = freshDb();
  const idP = nextId();
  const r = await fern(() => mc.runSpotPrice(deps(db), identity(idP, 'metals.set_spot_price'), actions.spotPriceBody('gold', 42.5)));
  ok(r.kind === 'ok' && one(db, "SELECT value FROM settings WHERE branch_id = 'branch-main' AND key = 'spot_price.gold'") === '42.5' && r.value.price === 42.5, 'SPOT gesetzt, in der Filiale des Auftrags');
  ok(one(db, "SELECT value FROM settings WHERE branch_id = 'branch-other' AND key = 'spot_price.gold'") === '99', 'SPOT die andere Filiale bleibt unberührt');
  const rep = await fern(() => mc.runSpotPrice(deps(db), identity(idP, 'metals.set_spot_price'), actions.spotPriceBody('gold', 42.5)));
  ok(rep.kind === 'ok' && rep.replayed, 'LOST dieselbe Kennung: replayed');
  const neg = await fern(() => mc.runSpotPrice(deps(db), identity(nextId(), 'metals.set_spot_price'), actions.spotPriceBody('gold', -1)));
  ok(neg.kind === 'rejected' && neg.code === 'SPOT_PRICE_INVALID' && one(db, "SELECT value FROM settings WHERE branch_id = 'branch-main' AND key = 'spot_price.gold'") === '42.5', 'REJECT ein negativer Spotpreis');
  const cu = await fern(() => mc.runSpotPrice(deps(db), identity(nextId(), 'metals.set_spot_price'), actions.spotPriceBody('copper', 1)));
  ok(cu.kind === 'rejected' && cu.code === 'METAL_TYPE_INVALID', 'REJECT eine unbekannte Metallart');
  ok(/must be a number/.test(parseFails(() => mc.parseSpotPrice({ metalType: 'gold', price: '5' }))), 'PAYLOAD ein Preis ist eine Zahl');
  ok(/the primary decides branchId/.test(parseFails(() => mc.parseSpotPrice({ metalType: 'gold', price: 5, branchId: 'branch-other' }))), 'PAYLOAD die Filiale nennt nie der Client');
  const zero = await fern(() => mc.runSpotPrice(deps(db), identity(nextId(), 'metals.set_spot_price'), actions.spotPriceBody('silver', 0)));
  ok(zero.kind === 'ok' && one(db, "SELECT value FROM settings WHERE branch_id = 'branch-main' AND key = 'spot_price.silver'") === '0', 'SPOT ein geleertes Feld ist 0 — wie bisher');

  // Die Auskunft: Filiale aus dem geprüften Absender, nie aus dem Rumpf
  const read = (branchId: string, input: Record<string, unknown> = {}) => registry.executeCommand('metals.spot_prices.get',
    { actor: { tenantId: 'tenant-1', branchId, userId: 'u', role: 'ADMIN' }, input }, { tenantId: 'tenant-1', branchId, userId: 'u', role: 'ADMIN' } as never);
  const a = await read('branch-main');
  const b = await read('branch-other', { branchId: 'branch-main' });
  const da = (a as { value?: { data?: Record<string, number> } }).value?.data ?? {};
  const dbb = (b as { value?: { data?: Record<string, number> } }).value?.data ?? {};
  ok(a.kind === 'ok' && S(da) === S({ gold: 42.5, silver: 0, platinum: 0 }), `READ die Spotpreise der eigenen Filiale (${S(da)})`);
  ok(b.kind === 'ok' && dbb.gold === 99, 'READ eine andere Filiale bekommt IHRE Preise — auch wenn der Rumpf eine fremde nennt');

  // Die Anlage danach benutzt den Preis des Hauses
  const m = await fern(() => mc.runMetalCreate(deps(db), identity(nextId(), 'metals.create'), { metalType: 'gold', karat: '24K', weightGrams: 2 }));
  ok(Number(m.value.spotPriceAtPurchase) === 42.5 && Math.abs(Number(m.value.meltValue) - 85) < 1e-9, 'SPOT die nächste Anlage leitet aus dem NEUEN Preis ab');

  // Parität
  const dbP = freshDb(); await actions.setSpotPriceOnPrimary('platinum', 12.25);
  const dbC = freshDb(); await fern(() => mc.runSpotPrice(deps(dbC), identity(nextId(), 'metals.set_spot_price'), actions.spotPriceBody('platinum', 12.25)));
  const q = "SELECT branch_id, key, value, category FROM settings WHERE key = 'spot_price.platinum'";
  ok(S(rows(dbP, q)) === S(rows(dbC, q)) && rows(dbP, q).length === 1, 'PARITY Spotpreis Primary == PC2');
  useMetalStore.getState().setSpotPrice('platinum', 13);
  ok(one(dbC, "SELECT value FROM settings WHERE branch_id = 'branch-main' AND key = 'spot_price.platinum'") === '13' && useMetalStore.getState().getSpotPrice('platinum') === 13, 'SPOT der alte Store-Einstieg geht durch dieselbe Folge');
  ok(wirft(() => useMetalStore.getState().setSpotPrice('gold', -2)) === 'SPOT_PRICE_INVALID', 'SPOT auch dort kein negativer Preis');
}
marker('CENTRAL_UI_R6D_SPOT_PRICE_PROVED');

// ══ §6 — scrap_trades.create ═══════════════════════════════════════════════
{
  const dbP = freshDb();
  const pr = await actions.createScrapTradeOnPrimary(TRADE());
  const pT = rows(dbP, 'SELECT * FROM scrap_trades')[0] ?? {};
  ok(pr.tradeNumber === 'SGT-000001' && pT.status === 'completed' && Number(pT.version) === 1 && Number(pT.profit) === 35 && Number(pT.weight_grams) === 10 && pT.karat === 'mixed'
    && Number(pT.purchase_price) === 120 && Number(pT.sale_price) === 155, `CREATE Nummer, Summen, Status, Fassung vom Haus (${S(pr)})`);
  const expectLedger = 'SCRAP_TRADE:BANK:DEBIT:155000:O|SCRAP_TRADE:BENEFIT:CREDIT:20000:O|SCRAP_TRADE:CASH:CREDIT:100000:O|SCRAP_TRADE:REVENUE:CREDIT:35000:O';
  ok(shape(ledgerRows(dbP)) === expectLedger && balanced(dbP), `LEDGER DR Eingang je Split, CR Ausgang je Split, CR REVENUE Spread (${shape(ledgerRows(dbP))})`);
  ok(useScrapTradeStore.getState().trades.some((t) => t.id === pr.tradeId), 'CREATE die Liste liest danach neu');

  const dbC = freshDb();
  const idC = nextId();
  const rc = await fern(() => mc.runScrapCreate(deps(dbC), identity(idC, 'scrap_trades.create'), actions.scrapCreateBody(TRADE())));
  const cT = rows(dbC, 'SELECT * FROM scrap_trades')[0] ?? {};
  const dT = /^(id|created_at|updated_at)$/;
  ok(rc.kind === 'ok' && norm(pT, dT) === norm(cT, dT), `PARITY Kopf Primary == PC2${norm(pT, dT) === norm(cT, dT) ? '' : ` (${norm(pT, dT)} / ${norm(cT, dT)})`}`);
  const lines = (db: Db) => rows(db, 'SELECT * FROM scrap_trade_lines ORDER BY position').map((r) => norm(r, /^(id|scrap_trade_id|created_at)$/)).join('|');
  const pays = (db: Db) => rows(db, 'SELECT * FROM scrap_trade_payments ORDER BY direction, position').map((r) => norm(r, /^(id|scrap_trade_id|created_at)$/)).join('|');
  ok(lines(dbP) === lines(dbC) && pays(dbP) === pays(dbC) && n(dbC, 'SELECT COUNT(*) FROM scrap_trade_lines') === 2 && n(dbC, 'SELECT COUNT(*) FROM scrap_trade_payments') === 3,
    'PARITY Zeilen und Zahlungen Primary == PC2');
  ok(shape(ledgerRows(dbC)) === expectLedger && balanced(dbC), 'PARITY dieselbe Buchung, ausgeglichen');
  ok(S(Object.keys(rc.value).sort()) === S(['profit', 'replayed', 'status', 'tradeId', 'tradeNumber', 'version'].filter((k) => k !== 'replayed')) || S(Object.keys(rc.value).sort()) === S(['profit', 'status', 'tradeId', 'tradeNumber', 'version']),
    `RESULT klein (${S(rc.value)})`);
  const again = await fern(() => mc.runScrapCreate(deps(dbC), identity(idC, 'scrap_trades.create'), actions.scrapCreateBody(TRADE())));
  ok(again.kind === 'ok' && again.replayed && counts(dbC, 'scrap_trades', 'scrap_trade_lines', 'scrap_trade_payments', 'ledger_entries') === 'scrap_trades=1 scrap_trade_lines=2 scrap_trade_payments=3 ledger_entries=4',
    'LOST dieselbe Kennung: replayed, genau EIN Geschäft und EINE Buchung (vorher: zweiter Klick = zweites Geschäft)');

  // Verlust
  const loss = await fern(() => mc.runScrapCreate(deps(dbC), identity(nextId(), 'scrap_trades.create'), actions.scrapCreateBody(TRADE({
    lines: [{ weightGrams: 5, karat: '21K', purchasePrice: 100, salePrice: 90 }], paymentsOut: [{ method: 'cash', amount: 100 }], paymentsIn: [{ method: 'cash', amount: 90 }],
  }))));
  ok(loss.kind === 'ok' && shape(ledgerRows(dbC, 'source_id = ?', [loss.value.tradeId])) === 'SCRAP_TRADE:CASH:CREDIT:100000:O|SCRAP_TRADE:CASH:DEBIT:90000:O|SCRAP_TRADE:EXPENSES_OPERATING:DEBIT:10000:O' && balanced(dbC),
    'LEDGER Verlust: DR EXPENSES_OPERATING um den Spread');

  // Regeln der Maske jetzt im Haus — Primary UND fern
  const bad: Array<[Partial<TradeIn>, string, string]> = [
    [{ lines: [{ weightGrams: 0, karat: '22K', purchasePrice: 120, salePrice: 155 }] }, 'SCRAP_LINE_INVALID', 'Gewicht 0'],
    [{ lines: [{ weightGrams: 2, karat: '   ', purchasePrice: 120, salePrice: 155 }] }, 'SCRAP_LINE_INVALID', 'Feinheit leer'],
    [{ lines: [{ weightGrams: 2, karat: '22K', purchasePrice: -5, salePrice: 155 }, { weightGrams: 1, karat: '22K', purchasePrice: 125, salePrice: 0 }] }, 'SCRAP_LINE_INVALID', 'negativer Einkaufspreis'],
    [{ lines: [] }, 'SCRAP_LINES_REQUIRED', 'keine Zeile'],
    [{ paymentsOut: [{ method: 'cash', amount: 119 }] }, 'SCRAP_PAYMENT_MISMATCH', 'Auszahlung ≠ Einkauf'],
    [{ paymentsIn: [{ method: 'card' as never, amount: 155 }] }, 'SCRAP_PAYMENT_INVALID', 'unbekannte Zahlart'],
    [{ paymentsIn: [{ method: 'bank', amount: 160 }, { method: 'cash', amount: -5 }] }, 'SCRAP_PAYMENT_INVALID', 'negativer Split'],
    [{ sellerName: '  ' }, 'SCRAP_PARTY_REQUIRED', 'kein Verkäufer'],
    [{ buyerName: '' }, 'SCRAP_PARTY_REQUIRED', 'kein Käufer'],
    [{ tradeDate: 'yesterday' }, 'SCRAP_DATE_INVALID', 'kein Datum'],
    [{ sellerCustomerId: 'c2' }, 'CUSTOMER_NOT_FOUND', 'Kunde einer anderen Filiale'],
    [{ buyerSupplierId: 's2' }, 'SUPPLIER_NOT_FOUND', 'Lieferant einer anderen Filiale'],
  ];
  const beforeC = counts(dbC, 'scrap_trades', 'scrap_trade_lines', 'scrap_trade_payments', 'ledger_entries');
  for (const [over, code, what] of bad) {
    const r = await fern(() => mc.runScrapCreate(deps(dbC), identity(nextId(), 'scrap_trades.create'), actions.scrapCreateBody(TRADE(over))));
    ok(r.kind === 'rejected' && r.frozen && r.code === code, `REJECT fern ${what} → ${code} (${r.kind} ${r.code})`);
    ok(await wirftAsync(() => actions.createScrapTradeOnPrimary(TRADE(over))) === code, `REJECT Primary ${what} → ${code}`);
  }
  ok(counts(dbC, 'scrap_trades', 'scrap_trade_lines', 'scrap_trade_payments', 'ledger_entries') === beforeC, 'REJECT kein Nein hat etwas geschrieben');
  ok(wirft(() => useScrapTradeStore.getState().createTrade(TRADE({ lines: [{ weightGrams: 0, karat: '22K', purchasePrice: 120, salePrice: 155 }] }))) === 'SCRAP_LINE_INVALID',
    'PRIMARY auch der alte Store-Einstieg prüft je Zeile (vorher nur die Maske)');
  const linked = await fern(() => mc.runScrapCreate(deps(dbC), identity(nextId(), 'scrap_trades.create'), actions.scrapCreateBody(TRADE({ sellerCustomerId: 'c1', buyerSupplierId: 's1' }))));
  ok(linked.kind === 'ok' && one(dbC, 'SELECT seller_customer_id FROM scrap_trades WHERE id = ?', [linked.value.tradeId]) === 'c1', 'LINK Kunde und Lieferant DIESER Filiale werden verknüpft');

  // Verbotene Felder
  for (const k of ['id', 'branchId', 'userId', 'createdAt', 'status', 'version', 'revision', 'tradeNumber', 'weightGrams', 'karat', 'purchasePrice', 'salePrice', 'profit', 'paymentMethodPurchase', 'syncStatus', 'ledger', 'account', 'transactionId']) {
    ok(/the primary decides/.test(parseFails(() => mc.parseScrapCreate({ ...actions.scrapCreateBody(TRADE()), [k]: 1 }))), `PAYLOAD scrap_trades.create: ${k} gibt der Client nicht vor`);
  }
  const withLine = (extra: Record<string, unknown>) => { const b = actions.scrapCreateBody(TRADE()); (b.lines as Array<Record<string, unknown>>)[0] = { ...(b.lines as Array<Record<string, unknown>>)[0], ...extra }; return b; };
  ok(/the primary decides profit/.test(parseFails(() => mc.parseScrapCreate(withLine({ profit: 999 })))), 'PAYLOAD der Gewinn einer Zeile ist abgeleitet');
  ok(/staged bytes/.test(parseFails(() => mc.parseScrapCreate(withLine({ imagesPurchase: ['data:image/png;base64,AA'] })))), 'PAYLOAD Fotos reisen nie als Bytes im Auftrag');
  const withPay = (extra: Record<string, unknown>) => { const b = actions.scrapCreateBody(TRADE()); (b.paymentsIn as Array<Record<string, unknown>>)[0] = { ...(b.paymentsIn as Array<Record<string, unknown>>)[0], ...extra }; return b; };
  ok(/the primary decides direction/.test(parseFails(() => mc.parseScrapCreate(withPay({ direction: 'OUT' })))), 'PAYLOAD die Richtung eines Splits bestimmt seine Liste');
  ok(/unknown field/.test(parseFails(() => mc.parseScrapCreate({ ...actions.scrapCreateBody(TRADE()), bogus: 1 }))), 'PAYLOAD ein unbekanntes Feld wird abgewiesen');

  // Rücknahme
  for (const [pattern, what] of [
    [/INSERT INTO ledger_entries/, 'die Buchung scheitert'],
    [/INSERT INTO scrap_trade_payments/, 'die zweite Tabelle scheitert'],
  ] as Array<[RegExp, string]>) {
    const db = freshDb();
    const { db: badDb, f, restore } = faulty(db, pattern);
    const id = nextId();
    const r = await fern(() => mc.runScrapCreate(deps(badDb), identity(id, 'scrap_trades.create'), actions.scrapCreateBody(TRADE())));
    ok(r.kind === 'thrown' && counts(db, 'scrap_trades', 'scrap_trade_lines', 'scrap_trade_payments', 'ledger_entries') === 'scrap_trades=0 scrap_trade_lines=0 scrap_trade_payments=0 ledger_entries=0'
      && lookupCommand(db as never, identity(id, 'scrap_trades.create')).kind === 'fresh', `ATOMIC fern: ${what} → kein Geschäft ohne Buchung`);
    const code = await wirftAsync(() => actions.createScrapTradeOnPrimary(TRADE()));
    ok(code !== '' && counts(db, 'scrap_trades', 'ledger_entries') === 'scrap_trades=0 ledger_entries=0', `ATOMIC Primary: ${what} → nichts (vorher: Zeilen ohne Buchung)`);
    f.armed = false;
    restore();
  }
}
marker('CENTRAL_UI_R6D_SCRAP_CREATE_PROVED');

// ══ §7 — scrap_trades.update ═══════════════════════════════════════════════
{
  const EDIT = TRADE({
    lines: [{ weightGrams: 9, karat: '22K', purchasePrice: 110, salePrice: 150 }],
    paymentsOut: [{ method: 'cash', amount: 110 }], paymentsIn: [{ method: 'benefit', amount: 150 }], notes: 'edited',
  });
  const db = freshDb();
  const c = await fern(() => mc.runScrapCreate(deps(db), identity(nextId(), 'scrap_trades.create'), actions.scrapCreateBody(TRADE())));
  const tid = String(c.value.tradeId);
  const idU = nextId();
  const u = await fern(() => mc.runScrapUpdate(deps(db), identity(idU, 'scrap_trades.update'), actions.scrapUpdateBody(tid, 1, EDIT)));
  ok(u.kind === 'ok' && u.value.version === 2 && Number(u.value.profit) === 40 && Number(one(db, 'SELECT version FROM scrap_trades WHERE id = ?', [tid])) === 2
    && n(db, 'SELECT COUNT(*) FROM scrap_trade_lines WHERE scrap_trade_id = ?', [tid]) === 1, `UPDATE Fassung hoch, Zeilen ersetzt (${S(u.value)})`);
  ok(scrap.allUnreversedTransactionsFor(tid).length === 1 && n(db, 'SELECT COUNT(*) FROM ledger_entries WHERE reverses_entry_id IS NOT NULL') === 4,
    'UPDATE die alte Buchung ist vollständig umgekehrt, genau eine offene neue');
  ok(net(db, 'CASH', 'SCRAP_TRADE') === -110000 && net(db, 'BENEFIT', 'SCRAP_TRADE') === 150000 && net(db, 'BANK', 'SCRAP_TRADE') === 0 && net(db, 'REVENUE', 'SCRAP_TRADE') === -40000 && balanced(db),
    'LEDGER netto genau die neuen Beträge, jede Transaktion ausgeglichen');
  const ledgerN = n(db, 'SELECT COUNT(*) FROM ledger_entries');
  const rep = await fern(() => mc.runScrapUpdate(deps(db), identity(idU, 'scrap_trades.update'), actions.scrapUpdateBody(tid, 1, EDIT)));
  ok(rep.kind === 'ok' && rep.replayed && n(db, 'SELECT COUNT(*) FROM ledger_entries') === ledgerN && Number(one(db, 'SELECT version FROM scrap_trades WHERE id = ?', [tid])) === 2,
    'LOST dieselbe Kennung: replayed, keine zweite Umkehr, keine zweite Buchung');
  const stale = await fern(() => mc.runScrapUpdate(deps(db), identity(nextId(), 'scrap_trades.update'), actions.scrapUpdateBody(tid, 1, TRADE())));
  ok(stale.kind === 'rejected' && stale.code === 'RECORD_CHANGED' && n(db, 'SELECT COUNT(*) FROM ledger_entries') === ledgerN && one(db, 'SELECT notes FROM scrap_trades WHERE id = ?', [tid]) === 'edited',
    'STALE eine veraltete Fassung: RECORD_CHANGED, nichts geschrieben (vorher wurde die Fassung nur aus dem Zwischenspeicher hochgezählt)');
  ok(/expectedVersion is required/.test(parseFails(() => mc.parseScrapUpdate({ tradeId: tid, ...actions.scrapCreateBody(EDIT) }))), 'PAYLOAD ohne gesehene Fassung kein Ändern');

  // Rücknahme mitten in Umkehr + Neubuchung
  for (const [pattern, what] of [
    [/INSERT INTO scrap_trade_lines/, 'die neuen Zeilen scheitern'],
    [/INSERT INTO ledger_entries/, 'die Umkehr/Neubuchung scheitert'],
  ] as Array<[RegExp, string]>) {
    const before = { l: n(db, 'SELECT COUNT(*) FROM ledger_entries'), lines: n(db, 'SELECT COUNT(*) FROM scrap_trade_lines WHERE scrap_trade_id = ?', [tid]) };
    const { db: badDb, restore } = faulty(db, pattern);
    const id = nextId();
    const r = await fern(() => mc.runScrapUpdate(deps(badDb), identity(id, 'scrap_trades.update'), actions.scrapUpdateBody(tid, 2, TRADE())));
    restore();
    ok(r.kind === 'thrown' && n(db, 'SELECT COUNT(*) FROM ledger_entries') === before.l && Number(one(db, 'SELECT version FROM scrap_trades WHERE id = ?', [tid])) === 2
      && n(db, 'SELECT COUNT(*) FROM scrap_trade_lines WHERE scrap_trade_id = ?', [tid]) === before.lines && scrap.allUnreversedTransactionsFor(tid).length === 1
      && lookupCommand(db as never, identity(id, 'scrap_trades.update')).kind === 'fresh',
    `ATOMIC ${what} → alte Zeilen und alte Buchung stehen unverändert (vorher: umgekehrt ohne Neubuchung möglich)`);
  }

  // Primary: Store-Einstieg prüft jetzt die Fassung GEGEN die Zeile
  useScrapTradeStore.getState().loadTrades();
  db.run('UPDATE scrap_trades SET version = 3 WHERE id = ?', [tid]);   // eine Änderung dazwischen
  ok(wirft(() => useScrapTradeStore.getState().updateTrade(tid, TRADE())) === 'RECORD_CHANGED', 'STALE auch der alte Store-Einstieg überschreibt keine fremde Änderung');
  db.run('UPDATE scrap_trades SET version = 2 WHERE id = ?', [tid]);

  // Parität
  const twin = async (primary: boolean) => {
    const d = freshDb();
    const cr = primary ? await actions.createScrapTradeOnPrimary(TRADE()) : (await fern(() => mc.runScrapCreate(deps(d), identity(nextId(), 'scrap_trades.create'), actions.scrapCreateBody(TRADE())))).value;
    const id = String(cr.tradeId);
    if (primary) await actions.updateScrapTradeOnPrimary(id, 1, EDIT);
    else await fern(() => mc.runScrapUpdate(deps(d), identity(nextId(), 'scrap_trades.update'), actions.scrapUpdateBody(id, 1, EDIT)));
    return {
      t: norm(rows(d, 'SELECT * FROM scrap_trades')[0], /^(id|created_at|updated_at)$/),
      l: rows(d, 'SELECT * FROM scrap_trade_lines').map((r) => norm(r, /^(id|scrap_trade_id|created_at)$/)).join('|'),
      p: rows(d, 'SELECT * FROM scrap_trade_payments ORDER BY direction, position').map((r) => norm(r, /^(id|scrap_trade_id|created_at)$/)).join('|'),
      g: shape(ledgerRows(d)),
    };
  };
  const tp = await twin(true);
  const tc = await twin(false);
  ok(S(tp) === S(tc), `PARITY Ändern Primary == PC2 (Kopf, Zeilen, Zahlungen, Buchung samt Umkehr)${S(tp) === S(tc) ? '' : ` ${S(tp)} / ${S(tc)}`}`);
}
marker('CENTRAL_UI_R6D_SCRAP_UPDATE_PROVED');

// ══ §8 — scrap_trades.cancel ═══════════════════════════════════════════════
{
  const db = freshDb();
  const mkTrade = async () => String((await fern(() => mc.runScrapCreate(deps(db), identity(nextId(), 'scrap_trades.create'), actions.scrapCreateBody(TRADE())))).value.tradeId);
  const t1 = await mkTrade();
  const idX = nextId();
  const x = await fern(() => mc.runScrapCancel(deps(db), identity(idX, 'scrap_trades.cancel'), actions.scrapCancelBody(t1, 1)));
  ok(x.kind === 'ok' && x.value.status === 'cancelled' && x.value.version === 2 && one(db, 'SELECT status FROM scrap_trades WHERE id = ?', [t1]) === 'cancelled',
    'CANCEL storniert, Fassung hoch (vorher blieb sie stehen)');
  ok(scrap.allUnreversedTransactionsFor(t1).length === 0 && ['CASH', 'BANK', 'BENEFIT', 'REVENUE'].every((a) => net(db, a, 'SCRAP_TRADE') === 0) && balanced(db),
    'CANCEL jede Buchung umgekehrt — netto null, ausgeglichen');
  const rep = await fern(() => mc.runScrapCancel(deps(db), identity(idX, 'scrap_trades.cancel'), actions.scrapCancelBody(t1, 1)));
  ok(rep.kind === 'ok' && rep.replayed && n(db, 'SELECT COUNT(*) FROM ledger_entries WHERE reverses_entry_id IS NOT NULL') === 4, 'LOST dieselbe Kennung: replayed, EINE Umkehr');
  const twice = await fern(() => mc.runScrapCancel(deps(db), identity(nextId(), 'scrap_trades.cancel'), actions.scrapCancelBody(t1, 2)));
  ok(twice.kind === 'rejected' && twice.code === 'TRADE_CANCELLED', 'CANCEL ein storniertes Geschäft wird nicht noch einmal storniert');
  const upd = await fern(() => mc.runScrapUpdate(deps(db), identity(nextId(), 'scrap_trades.update'), actions.scrapUpdateBody(t1, 2, TRADE())));
  ok(upd.kind === 'rejected' && upd.code === 'TRADE_CANCELLED', 'CANCEL ein storniertes Geschäft wird nicht mehr geändert');

  const t2 = await mkTrade();
  const stale = await fern(() => mc.runScrapCancel(deps(db), identity(nextId(), 'scrap_trades.cancel'), actions.scrapCancelBody(t2, 7)));
  ok(stale.kind === 'rejected' && stale.code === 'RECORD_CHANGED' && one(db, 'SELECT status FROM scrap_trades WHERE id = ?', [t2]) === 'completed' && scrap.allUnreversedTransactionsFor(t2).length === 1,
    'STALE eine veraltete Fassung: nichts storniert, nichts umgekehrt');
  insert(db, 'scrap_trades', { id: 'tx-other', branch_id: 'branch-other', trade_number: 'SGT-000009', seller_name: 'a', buyer_name: 'b', weight_grams: 1, karat: '21K', purchase_price: 1, sale_price: 1, profit: 0, trade_date: '2026-09-13', created_at: NOW, updated_at: NOW, status: 'completed', version: 1 });
  const fx = await fern(() => mc.runScrapCancel(deps(db), identity(nextId(), 'scrap_trades.cancel'), actions.scrapCancelBody('tx-other', 1)));
  ok(fx.code === 'TRADE_NOT_FOUND' && one(db, "SELECT status FROM scrap_trades WHERE id = 'tx-other'") === 'completed', 'REJECT ein Geschäft einer anderen Filiale ist nicht vorhanden');

  // Der alte Befund: Status VOR der Umkehr. Jetzt: scheitert der Status, gibt es auch keine Umkehr — und ein zweiter Versuch geht.
  const { db: badDb, f, restore } = faulty(db, /UPDATE scrap_trades SET status = 'cancelled'/);
  const id = nextId();
  const r = await fern(() => mc.runScrapCancel(deps(badDb), identity(id, 'scrap_trades.cancel'), actions.scrapCancelBody(t2, 1)));
  ok(r.kind === 'thrown' && one(db, 'SELECT status FROM scrap_trades WHERE id = ?', [t2]) === 'completed' && scrap.allUnreversedTransactionsFor(t2).length === 1
    && Number(one(db, 'SELECT version FROM scrap_trades WHERE id = ?', [t2])) === 1, 'ATOMIC Umkehr und Status in EINER Transaktion: kein „storniert, aber gebucht" und kein „umgekehrt, aber aktiv"');
  const { f: f2, restore: restore2 } = (() => { restore(); return faulty(db, /INSERT INTO ledger_entries/); })();
  const r2 = await fern(() => mc.runScrapCancel(deps(db), identity(nextId(), 'scrap_trades.cancel'), actions.scrapCancelBody(t2, 1)));
  ok(r2.kind === 'thrown' && one(db, 'SELECT status FROM scrap_trades WHERE id = ?', [t2]) === 'completed', 'ATOMIC scheitert eine Umkehr, bleibt das Geschäft aktiv (vorher: storniert ohne Umkehr, kein zweiter Versuch)');
  f.armed = false; f2.armed = false; restore2();
  const retry = await fern(() => mc.runScrapCancel(deps(db), identity(id, 'scrap_trades.cancel'), actions.scrapCancelBody(t2, 1)));
  ok(retry.kind === 'ok' && one(db, 'SELECT status FROM scrap_trades WHERE id = ?', [t2]) === 'cancelled' && scrap.allUnreversedTransactionsFor(t2).length === 0, 'ATOMIC der zweite Versuch derselben Absicht gelingt');

  // Primary und Parität
  const dbP = freshDb();
  const pc = await actions.createScrapTradeOnPrimary(TRADE());
  await actions.cancelScrapTradeOnPrimary(pc.tradeId, 1);
  const dbC = freshDb();
  const cc = await fern(() => mc.runScrapCreate(deps(dbC), identity(nextId(), 'scrap_trades.create'), actions.scrapCreateBody(TRADE())));
  await fern(() => mc.runScrapCancel(deps(dbC), identity(nextId(), 'scrap_trades.cancel'), actions.scrapCancelBody(String(cc.value.tradeId), 1)));
  const d = /^(id|created_at|updated_at)$/;
  ok(norm(rows(dbP, 'SELECT * FROM scrap_trades')[0], d) === norm(rows(dbC, 'SELECT * FROM scrap_trades')[0], d) && shape(ledgerRows(dbP)) === shape(ledgerRows(dbC)),
    'PARITY Stornieren Primary == PC2');
  // (die zuletzt angelegte Datenbank ist die aktive — hier dbC)
  const t3 = String((await actions.createScrapTradeOnPrimary(TRADE())).tradeId);
  useScrapTradeStore.getState().loadTrades();
  useScrapTradeStore.getState().cancelTrade(t3);
  ok(one(dbC, 'SELECT status FROM scrap_trades WHERE id = ?', [t3]) === 'cancelled' && Number(one(dbC, 'SELECT version FROM scrap_trades WHERE id = ?', [t3])) === 2
    && useScrapTradeStore.getState().trades.find((t) => t.id === t3)?.status === 'cancelled', 'PRIMARY der alte Store-Einstieg: dieselbe Folge, Fassung hoch, Liste neu');
}
marker('CENTRAL_UI_R6D_SCRAP_CANCEL_PROVED');

// ══ §9 — Fotos über die vorhandene Ablage ═══════════════════════════════════
{
  const db = freshDb();
  const A = 'a'.repeat(64); const B = 'b'.repeat(64);
  const body = actions.scrapCreateBody(TRADE(), [{ purchase: [A], sale: [B] }, { purchase: [], sale: [] }]);
  ok(!/imagesPurchase|imagesSale|base64/.test(S(body)) && S((body.lines as Array<Record<string, unknown>>)[0].purchaseStagingIds) === S([A]), 'MEDIA der Rumpf nennt Kennungen, keine Bytes');
  const discarded: string[] = [];
  let owner: Record<string, string> = {};
  const r = await fern(() => mc.runScrapCreate(deps(db), identity(nextId(), 'scrap_trades.create'), body, {
    readStaged: async (id, o) => { owner = o as never; return { mime: 'image/jpeg', dataBase64: id === A ? 'QUFB' : 'QkJC' }; },
    discardStaged: async (id) => { discarded.push(id); },
  }));
  const l1 = rows(db, 'SELECT images_purchase, images_sale FROM scrap_trade_lines WHERE position = 1')[0];
  ok(r.kind === 'ok' && l1.images_purchase === S(['data:image/jpeg;base64,QUFB']) && l1.images_sale === S(['data:image/jpeg;base64,QkJC']),
    'MEDIA der Primary holt die Fotos INNERHALB des Auftrags und legt sie wie seine eigene Maske ab');
  ok(S(discarded.sort()) === S([A, B]) && owner.branchId === 'branch-main' && owner.userId === 'user-test', 'MEDIA nach dem Erfolg geräumt; die Ablage gehört der geprüften Identität');
  const idG = nextId();
  const gone = await fern(() => mc.runScrapCreate(deps(db), identity(idG, 'scrap_trades.create'), body, { readStaged: async () => { throw new Error('missing'); } }));
  ok(gone.kind === 'thrown' && gone.code === 'STAGED_IMAGE_GONE' && n(db, 'SELECT COUNT(*) FROM scrap_trades') === 1 && lookupCommand(db as never, identity(idG, 'scrap_trades.create')).kind === 'fresh',
    'MEDIA eine verschwundene Ablage legt nichts an und verbrennt die Kennung nicht');
  const four = actions.scrapCreateBody(TRADE(), [{ purchase: ['1', '2', '3', '4'].map((c) => c.repeat(64)), sale: [] }]);
  ok(/at most 3 photos/.test(parseFails(() => mc.parseScrapCreate(four))), 'MEDIA höchstens drei Fotos je Seite — dieselbe Zahl wie die Maske');
  ok(/content hash/.test(parseFails(() => mc.parseScrapCreate(actions.scrapCreateBody(TRADE(), [{ purchase: ['../etc/passwd'], sale: [] }])))), 'MEDIA eine Ablagekennung ist ein Inhaltshash, sonst nichts');
  const staged = await actions.stageScrapPhotos(TRADE({ lines: [{ weightGrams: 1, karat: '22K', purchasePrice: 120, salePrice: 155, imagesPurchase: ['data:image/png;base64,AA'], imagesSale: [] }] }),
    async (urls) => urls.map((_, i) => String(i + 1).repeat(64)));
  ok(S(staged) === S([{ purchase: ['1'.repeat(64)], sale: [] }]), 'MEDIA PC2 legt je Zeile und Seite in der Reihenfolge der Maske ab');
  // Primary: die Fotos der Maske gehen durch den EINEN Normalisierer (R7B PP-12) und landen als JPEG.
  const dbP = freshDb();
  const vorNorm = normalisiert;
  await actions.createScrapTradeOnPrimary(TRADE({ lines: [{ weightGrams: 1, karat: '22K', purchasePrice: 120, salePrice: 155, imagesPurchase: ['data:image/png;base64,AA'] }] }));
  ok(one(dbP, 'SELECT images_purchase FROM scrap_trade_lines') === S(['data:image/jpeg;base64,AA']) && normalisiert === vorNorm + 1,
    'MEDIA am Primary: das Foto der Maske ging durch den Normalisierer und liegt als JPEG-Daten-URL in der Zeile');
}
marker('CENTRAL_UI_R6D_SCRAP_MEDIA_PROVED');

// ══ §10 — Client ohne Bücher ════════════════════════════════════════════════
{
  const db = freshDb();
  const TABLES = ['precious_metals', 'gold_movements', 'expenses', 'scrap_trades', 'scrap_trade_lines', 'ledger_entries', 'settings', 'sync_changelog'];
  const vorher = counts(db, ...TABLES);
  store.set('lataif_runtime_mode', 'client');
  store.set('lataif_client_server_url', 'https://primary.local');
  store.set('lataif_client_token', 'tok');
  try {
    ok(wirft(() => house.createMetalInHouse({ ...METAL_IN }, 'branch-main')) === 'CLIENT_HAS_NO_BOOKS', 'CLIENT das Metallhaus verweigert den lokalen Griff');
    ok(wirft(() => useMetalStore.getState().createMetal({ ...METAL_IN })) === 'CLIENT_HAS_NO_BOOKS', 'CLIENT auch der alte Store-Einstieg');
    ok(wirft(() => house.setSpotPriceInHouse('gold', 5, 'branch-main')) === 'CLIENT_HAS_NO_BOOKS', 'CLIENT kein lokaler Spotpreis');
    ok(wirft(() => scrap.createScrapTradeInHouse(TRADE(), 'branch-main')) === 'CLIENT_HAS_NO_BOOKS' && wirft(() => scrap.cancelScrapTradeInHouse('x', 1, 'branch-main')) === 'CLIENT_HAS_NO_BOOKS',
      'CLIENT das Altgoldhaus ebenso');
    const calls: Array<Record<string, unknown>> = [];
    const fakeFetch = (async (_url: string, init: { body: string }) => {
      const b = JSON.parse(init.body) as Record<string, unknown>;
      calls.push(b);
      const value = b.op === 'metals.create' ? { metalId: 'm-remote', status: 'in_stock', revision: 2, replayed: false } : { tradeId: 't-remote', tradeNumber: 'SGT-000042', status: 'completed', version: 1, profit: 35, replayed: false };
      return new Response(JSON.stringify({ ok: true, value }), { status: 200 });
    }) as never;
    let lokal = false;
    const ctl = new CommandSaveController<Record<string, unknown>>('metals.create');
    const out = await runSharedWrite(true, { local: () => { lokal = true; return {}; }, remote: () => actions.metalCreateBody({ ...METAL_IN, supplierName: '', notes: undefined }) }, ctl.beginAttempt(), fakeFetch);
    const sent = calls.find((c) => c.op === 'metals.create');
    ok(out.kind === 'ok' && !lokal && (out as { value: Record<string, unknown> }).value.metalId === 'm-remote', 'CLIENT „Add Item" geht über die Brücke — die lokale Funktion läuft nicht');
    ok(!!sent && S(Object.keys(sent.payload as object).sort()) === S(['description', 'karat', 'metalType', 'purchaseTotal', 'supplierId', 'weightGrams']),
      `CLIENT der Rumpf trägt nur Eingaben, keine leeren Felder, keinen Spot/Schmelzwert (${S(sent?.payload)})`);
    const ctl2 = new CommandSaveController<Record<string, unknown>>('scrap_trades.create');
    const out2 = await runSharedWrite(true, { local: () => { lokal = true; return {}; }, remote: () => actions.scrapCreateBody(TRADE()) }, ctl2.beginAttempt(), fakeFetch);
    ok(out2.kind === 'ok' && !lokal && calls.some((c) => c.op === 'scrap_trades.create' && !('tradeNumber' in (c.payload as object))), 'CLIENT „Save Trade" ebenso — ohne Nummer, Summen oder Status');
    ok(counts(db, ...TABLES) === vorher && counts(db, 'precious_metals', 'scrap_trades', 'ledger_entries') === 'precious_metals=0 scrap_trades=0 ledger_entries=0',
      `CLIENT keine einzige lokale Zeile (${counts(db, ...TABLES)})`);
  } finally {
    store.delete('lataif_runtime_mode');
    store.delete('lataif_client_server_url');
    store.delete('lataif_client_token');
  }
}
marker('CENTRAL_UI_R6D_METALS_CLIENT_PROVED');

// ══ §11 — Oberfläche: jede Maske ein Anschluss ══════════════════════════════
{
  const ml = codeOf(src('src/pages/metals/MetalList.tsx'));
  ok(!/\bcreateMetal\(|\bupdateMetal\(|\bsetSpotPrice\(|getSpotPrice\(/.test(ml), 'UI MetalList ruft keinen Store-Schreibweg mehr direkt');
  ok(/w\.ok\('metals\.create'/.test(ml) && /w\.ok\('metals\.update_status'/.test(ml) && /w\.ok\('metals\.set_spot_price'/.test(ml), 'UI MetalList: Anlegen, Verkaufen/Einschmelzen, Spotpreis über die Weiche');
  ok(/onChange=\{e => setEntwurf/.test(ml) && /onBlur=\{e => \{[^}]*commitSpot\(type\)/.test(ml) && /e\.key === 'Enter'/.test(ml),
    'UI der Spotpreis wird beim Verlassen/Enter übernommen, nicht je Tastendruck');
  ok(/useSharedRead\('metals\.spot_prices\.get'/.test(ml), 'UI PC2 liest die Spotpreise über die neue Auskunft');
  ok(!/spotPriceAtPurchase|currentSpotPrice: spot|meltValue[,:]/.test(ml), 'UI die Maske schickt weder Spot noch Schmelzwert');
  for (const a of ['data-metal-new-open', 'data-metal-type', 'data-metal-karat', 'data-metal-weight', 'data-metal-purchase-total', 'data-metal-price-per-gram', 'data-metal-supplier',
    'data-metal-description', 'data-metal-notes', 'data-metal-save', 'data-metal-sell-open', 'data-metal-sell-price', 'data-metal-sell-confirm', 'data-metal-melt-open',
    'data-metal-melt-confirm', 'data-metal-spot-input']) {
    ok(ml.includes(a), `E2E ${a}`);
  }
  const sn = codeOf(src('src/pages/scrap-trades/ScrapTradeNew.tsx'));
  const sd = codeOf(src('src/pages/scrap-trades/ScrapTradeDetail.tsx'));
  const sf = codeOf(src('src/pages/scrap-trades/ScrapTradeForm.tsx'));
  ok(!/createTrade\(/.test(sn) && /'scrap_trades\.create'/.test(sn) && /laeuft\.current/.test(sn), 'UI Neues Geschäft: EINE Buchung, Riegel gegen den zweiten Klick');
  ok(!/updateTrade\(|cancelTrade\(/.test(sd) && /w\.ok\('scrap_trades\.update'/.test(sd) && /w\.ok\('scrap_trades\.cancel'/.test(sd) && /t\.version/.test(sd), 'UI Detail: Ändern und Stornieren über die Weiche, mit Fassung');
  for (const a of ['data-scrap-seller-name', 'data-scrap-seller-phone', 'data-scrap-trade-date', 'data-scrap-buyer-name', 'data-scrap-buyer-phone', 'data-scrap-notes', 'data-scrap-line',
    'data-scrap-line-weight', 'data-scrap-line-karat', 'data-scrap-line-purchase', 'data-scrap-line-sale', 'data-scrap-add-line', 'data-scrap-pay', 'data-scrap-pay-method',
    'data-scrap-pay-amount', 'data-scrap-pay-add', 'data-scrap-save']) {
    ok(sf.includes(a), `E2E ${a}`);
  }
  ok(sd.includes('data-scrap-edit-open') && sd.includes('data-scrap-cancel-open') && sd.includes('data-scrap-cancel-confirm'), 'E2E Detail: Bearbeiten, Stornieren, Bestätigen');
  const ac = codeOf(src('src/core/metals/metal-actions.ts'));
  ok((ac.match(/runOnPrimary\(/g) ?? []).length === 6, 'UI am Primary läuft jede der sechs Handlungen in der Schreibreihenfolge (runOnPrimary)');
  ok(/createMetalInHouse\(/.test(codeOf(src('src/stores/metalStore.ts'))) && /createScrapTradeInHouse\(/.test(codeOf(src('src/stores/scrapTradeStore.ts'))), 'ONE die Store-Einstiege rufen dieselbe Hausfolge');
  const sh = codeOf(src('src/core/metals/scrap-house.ts')) + codeOf(src('src/core/metals/metal-house.ts'));
  ok(!/saveDatabaseDurably|'BEGIN'|'COMMIT'|safePost/.test(sh.replace(/export function inOneTransaction[\s\S]*?\n}\n/, '')), 'HOUSE keine eigene Klammer, kein Speichern, kein Verschlucken');
  ok(!/trackInsert\('scrap|trackUpdate\('scrap/.test(sh), 'SYNC die Altgold-Tabellen werden weiterhin nicht synchronisiert (Befund, unverändert)');
}
marker('CENTRAL_UI_R6D_METALS_UI_PROVED');

// ══ Accounting-Gate — Metall: der vollständige Effekt von Kauf, Verkauf, Einschmelzen ════════════
{
  const { isCapitalizedExpenseCategory } = await import('../../src/core/models/types.ts');
  const db = freshDb();
  const saldo = (a: string): number => Math.round(n(db, "SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0) FROM ledger_entries WHERE account = ?", [a]) * 1000) / 1000;
  const bestand = (): number => n(db, "SELECT COALESCE(SUM(weight_grams), 0) FROM precious_metals WHERE status = 'in_stock' AND metal_type = 'gold'");
  // Kauf beim Lieferanten: 10 g 21K für 300.
  const buy = house.inOneTransaction(() => house.createMetalInHouse({ metalType: 'gold', karat: '21K', weightGrams: 10, purchaseTotal: 300, supplierId: 's1' }, 'branch-main'));
  const kat = String(one(db, 'SELECT category FROM expenses WHERE id = ?', [buy.linkedExpenseId]));
  ok(bestand() === 10 && kat === 'Inventory' && isCapitalizedExpenseCategory(kat)
    && saldo('EXPENSES_OPERATING') === 300 && saldo('ACCOUNTS_PAYABLE') === -300
    && saldo('CASH') === 0 && saldo('BANK') === 0 && saldo('REVENUE') === 0,
    `METAL-KAUF Bestand +10 g · Ausgabe „Inventory" (kapitalisiert = Wareneinsatz) 300 an Lieferanten-Verbindlichkeit · kein Geld · kein Erlös (${kat})`);
  // Verkauf für 450 bar: Geld herein, Erlös — vorher nur Status und Preis.
  house.inOneTransaction(() => house.changeMetalStatusInHouse({ metalId: buy.metal.id, status: 'sold', salePrice: 450, paymentMethod: 'cash', expectedRevision: buy.metal.revision }, 'branch-main'));
  const m = rows(db, 'SELECT status, sale_price, paid_amount, payment_status FROM precious_metals WHERE id = ?', [buy.metal.id])[0];
  ok(bestand() === 0 && m.status === 'sold' && m.payment_status === 'PAID' && Number(m.paid_amount) === 450
    && n(db, 'SELECT COUNT(*) FROM metal_payments WHERE metal_id = ?', [buy.metal.id]) === 1
    && saldo('CASH') === 450 && saldo('REVENUE') === -450,
    `METAL-VERKAUF Bestand −10 g · Kasse +450 · Erlös 450 (METAL_PAYMENT) · bezahlt (${S(m)})`);
  ok(saldo('REVENUE') * -1 - saldo('EXPENSES_OPERATING') === 150, 'METAL-ERGEBNIS Erlös 450 − Wareneinsatz 300 = Gewinn 150');
  // Einschmelzen bewegt kein Geld.
  const vorher = n(db, 'SELECT COUNT(*) FROM ledger_entries');
  const m2 = house.inOneTransaction(() => house.createMetalInHouse({ metalType: 'gold', karat: '22K', weightGrams: 4 }, 'branch-main')).metal;
  house.inOneTransaction(() => house.changeMetalStatusInHouse({ metalId: m2.id, status: 'melted', expectedRevision: m2.revision }, 'branch-main'));
  ok(n(db, 'SELECT COUNT(*) FROM ledger_entries') === vorher, 'METAL-SCHMELZEN keine Buchung — kein Geld bewegt');
  ok(balanced(db), 'METAL jede Buchung ausgeglichen');
}
marker('CENTRAL_UI_R6D_METAL_ACCOUNTING_CONTRACT_PINNED');

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — r6d metal + scrap parity: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R6D_METALS_SCRAP_PROVED');
