// Consignment — das Payout-Modell eines BESTEHENDEN Items aendern.
// Run: node test/consignment/payout-model-edit.test.ts
//
// Teil A prueft die echte Sperrregel `payoutModelLock` gegen die realen Felder, die ein Verkauf
// bzw. eine Auszahlung hinterlaesst. Teil B prueft `buildPayoutPatch`: ein Modellwechsel schreibt
// IMMER den vollstaendigen Feldsatz, inklusive der ausdruecklichen `null` fuer das, was zum alten
// Modell gehoerte. Teil C faehrt beides gegen eine node:sqlite-Wegwerf-DB mit dem echten
// Spaltenlayout und der echten UPDATE-Form des Stores — inklusive der Gegenprobe, dass ein
// gesperrter Fall die historischen Zahlen unangetastet laesst.
import { DatabaseSync } from 'node:sqlite';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import type { Consignment } from '../../src/core/models/types.ts';

// Der Produktivcode adressiert seine Module wie im Bundler ueblich (`@/…`, ohne Endung). Damit die
// ECHTEN Dateien hier laufen — und nicht eine Kopie ihrer Logik —, loest dieser Test genau diese
// beiden Schreibweisen auf. Nur im Test; am Produktivcode aendert das nichts.
const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
const withTs = (p: string): string => (existsSync(p) ? p : existsSync(p + '.ts') ? p + '.ts' : p);
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    if (specifier.startsWith('@/')) {
      return { url: pathToFileURL(withTs(resolvePath(repo, 'src', specifier.slice(2)))).href, shortCircuit: true };
    }
    if (specifier.startsWith('.') && context.parentURL) {
      const p = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
      if (!existsSync(p) && existsSync(p + '.ts')) {
        return { url: pathToFileURL(p + '.ts').href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
} as never);

const {
  payoutModelLock, buildPayoutPatch, payoutFieldsFor, normalizePayoutModel,
  PayoutPatchError, PAYOUT_MODELS, PAYOUT_EDITABLE_SQL,
} = await import('../../src/core/consignment/payout-edit.ts');
const { computeConsignmentSale } = await import('../../src/core/consignment/economics.ts');

let pass = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) pass++; else { fails.push(m); console.log('  x ' + m); } };

/** Ein frisches, noch unbenutztes Consignment — der einzige Zustand, in dem geaendert werden darf. */
const free = (over: Partial<Consignment> = {}): Consignment => ({
  id: 'c-1', consignmentNumber: 'CON-2026-001', consignorId: 'cust-1', productId: 'p-1',
  agreedPrice: 1000, commissionRate: 15, commissionType: 'percent',
  payoutStatus: 'pending', payoutPaidAmount: 0,
  status: 'active', agreementDate: '2026-01-01',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
} as Consignment);

// ── A) Wann darf das Modell noch geaendert werden? ────────────────────────
ok(payoutModelLock(free()).locked === false, 'LOCK a fresh, unsold consignment may still change its model');
ok(payoutModelLock(free()).reason === null, 'LOCK …and gives no reason, because there is none');

// Alles, was ein Verkauf hinterlaesst (recordSale schreibt genau diese Felder).
for (const [what, over] of [
  ['an invoice', { invoiceId: 'inv-1' }],
  ['a sale price', { salePrice: 1200 }],
  ['a calculated commission', { commissionAmount: 180 }],
  ['a calculated payout', { payoutAmount: 1020 }],
] as Array<[string, Partial<Consignment>]>) {
  const l = payoutModelLock(free(over));
  ok(l.locked === true, `LOCK ${what} locks the payout model`);
  ok(typeof l.reason === 'string' && l.reason.length > 20, `LOCK …and says why (${what})`);
}

// Alles, was eine Auszahlung hinterlaesst.
ok(payoutModelLock(free({ payoutPaidAmount: 500 })).locked, 'LOCK a partial payout locks it');
ok(payoutModelLock(free({ payoutStatus: 'partial' })).locked, 'LOCK a partial payout status locks it');
ok(payoutModelLock(free({ payoutStatus: 'paid' })).locked, 'LOCK a completed payout locks it');
ok(payoutModelLock(free({ payoutStatus: 'returned' })).locked, 'LOCK a returned payout locks it');

// Der Lebenszyklus.
for (const status of ['sold', 'paid_out', 'returned', 'expired'] as const) {
  ok(payoutModelLock(free({ status })).locked, `LOCK status "${status}" locks the payout model`);
}

// Grenzfaelle, die NICHT sperren duerfen — sonst waere ein normales Consignment nie editierbar.
ok(!payoutModelLock(free({ payoutPaidAmount: 0 })).locked, 'LOCK a zero payout is not a payout');
ok(!payoutModelLock(free({ minimumPrice: 800, notes: 'x' })).locked, 'LOCK unrelated fields do not lock it');
// …und ein Betrag 0 aus einem echten Verkauf ist sehr wohl gebucht.
ok(payoutModelLock(free({ commissionAmount: 0 })).locked, 'LOCK a booked commission of exactly 0 still locks it');

// Fail-closed.
ok(payoutModelLock(null).locked, 'LOCK a missing consignment is locked, not open');
ok(payoutModelLock(undefined).locked, 'LOCK …and so is an undefined one');

// ── B) Der Feldsatz eines Modells ─────────────────────────────────────────
const p1 = buildPayoutPatch({ model: 'percent', commissionRate: '20' });
ok(p1.commissionType === 'percent' && p1.commissionRate === 20, 'PATCH percent keeps its rate');
ok(p1.excessSplitPct === null, 'PATCH …and clears the split of a previous cost_split');

const p2 = buildPayoutPatch({ model: 'cost_split', commissionRate: '20', excessSplitPct: '60' });
ok(p2.commissionType === 'cost_split' && p2.excessSplitPct === 60, 'PATCH cost_split carries the shop share');
const p2d = buildPayoutPatch({ model: 'cost_split', excessSplitPct: '' });
ok(p2d.excessSplitPct === 50, 'PATCH …and defaults to 50 when none is given');

const p3 = buildPayoutPatch({ model: 'consignor_fixed', commissionRate: '20', excessSplitPct: '60' });
ok(p3.commissionType === 'consignor_fixed' && p3.excessSplitPct === null,
  'PATCH consignor_fixed drops the split — no parameter of another model survives');

// Jeder Patch nennt IMMER alle drei Spalten. Genau das macht den Wechsel atomar: es gibt keine
// Spalte, die ungeschrieben bleibt und den alten Vertrag weiterträgt.
for (const m of PAYOUT_MODELS) {
  const patch = buildPayoutPatch({ model: m, commissionRate: '15', excessSplitPct: '50' });
  const keys = Object.keys(patch).sort().join(',');
  ok(keys === 'commissionRate,commissionType,excessSplitPct', `PATCH ${m} writes the complete field set (${keys})`);
  ok(typeof patch.commissionRate === 'number', `PATCH ${m} leaves commission_rate a valid number (NOT NULL column)`);
}

// Validierung — dieselben Grenzen wie beim Anlegen.
const throws = (fn: () => unknown, label: string): void => {
  try { fn(); fails.push(label + ' — expected a rejection, got none'); console.log('  x ' + label); }
  catch (e) { if (e instanceof PayoutPatchError) pass++; else { fails.push(label + ' — wrong error: ' + String(e)); } }
};
throws(() => buildPayoutPatch({ model: 'percent', commissionRate: '' }), 'PATCH percent without a rate is rejected');
throws(() => buildPayoutPatch({ model: 'percent', commissionRate: '101' }), 'PATCH a rate above 100 is rejected');
throws(() => buildPayoutPatch({ model: 'percent', commissionRate: '-1' }), 'PATCH a negative rate is rejected');
throws(() => buildPayoutPatch({ model: 'cost_split', excessSplitPct: '0' }), 'PATCH a 0% shop share is rejected');
throws(() => buildPayoutPatch({ model: 'cost_split', excessSplitPct: '100' }), 'PATCH a 100% shop share is rejected');

// Legacy/Unbekanntes verhaelt sich wie die Oekonomie es tut — eine Wahrheit, nicht zwei.
ok(normalizePayoutModel('fixed') === 'percent', 'MODEL legacy "fixed" normalises to percent');
ok(normalizePayoutModel(undefined) === 'percent', 'MODEL an unset model is percent');
ok(payoutFieldsFor('percent').rate && !payoutFieldsFor('percent').split, 'FIELDS percent shows the rate only');
ok(payoutFieldsFor('cost_split').split && !payoutFieldsFor('cost_split').rate, 'FIELDS cost_split shows the split only');
ok(!payoutFieldsFor('consignor_fixed').rate && !payoutFieldsFor('consignor_fixed').split,
  'FIELDS consignor_fixed needs no extra parameter');

// ── C) Gegen das echte Spaltenlayout und die echte UPDATE-Form ────────────
const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE consignments (
    id TEXT PRIMARY KEY,
    agreed_price REAL NOT NULL,
    commission_rate REAL NOT NULL DEFAULT 15,
    commission_type TEXT DEFAULT 'percent',
    excess_split_pct INTEGER,
    commission_amount REAL,
    payout_amount REAL,
    payout_paid_amount REAL DEFAULT 0,
    payout_status TEXT DEFAULT 'pending',
    sale_price REAL,
    invoice_id TEXT,
    status TEXT DEFAULT 'active',
    notes TEXT,
    updated_at TEXT NOT NULL
  );
`);
const insert = (id: string, extra: Record<string, unknown> = {}): void => {
  const base: Record<string, unknown> = {
    id, agreed_price: 1000, commission_rate: 15, commission_type: 'percent', excess_split_pct: null,
    commission_amount: null, payout_amount: null, payout_paid_amount: 0, payout_status: 'pending',
    sale_price: null, invoice_id: null, status: 'active', notes: null, updated_at: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
  const keys = Object.keys(base);
  db.prepare(`INSERT INTO consignments (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map((k) => base[k] as string | number | null));
};
const read = (id: string): Record<string, unknown> =>
  db.prepare('SELECT * FROM consignments WHERE id = ?').get(id) as Record<string, unknown>;

/** Die UPDATE-Form des Stores: Feldliste aus dem Patch, eine Anweisung, ein Zeitpunkt. */
const COL: Record<string, string> = {
  commissionType: 'commission_type', commissionRate: 'commission_rate', excessSplitPct: 'excess_split_pct',
};
const applyPatch = (id: string, patch: Record<string, unknown>): void => {
  const keys = Object.keys(patch).filter((k) => COL[k]);
  db.prepare(`UPDATE consignments SET ${keys.map((k) => COL[k] + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...keys.map((k) => (patch[k] ?? null) as string | number | null), '2026-02-02T00:00:00.000Z', id);
};

// 1) percent → cost_split: Modell UND Parameter landen, in einer Anweisung.
insert('c-percent');
applyPatch('c-percent', buildPayoutPatch({ model: 'cost_split', excessSplitPct: '60' }));
{
  const r = read('c-percent');
  ok(r.commission_type === 'cost_split', 'DB percent → cost_split persists the model');
  ok(r.excess_split_pct === 60, `DB …and its shop share (${String(r.excess_split_pct)})`);
}

// 2) cost_split → consignor_fixed: der Parameter des alten Modells ist WEG, nicht bloss ignoriert.
applyPatch('c-percent', buildPayoutPatch({ model: 'consignor_fixed' }));
{
  const r = read('c-percent');
  ok(r.commission_type === 'consignor_fixed', 'DB cost_split → consignor_fixed persists the model');
  ok(r.excess_split_pct === null, 'DB …and the old shop share is cleared, not left behind');
}

// 3) Der gespeicherte Vertrag ist der, mit dem danach gerechnet wird — dieselbe SSOT-Oekonomie.
{
  const r = read('c-percent');
  const econ = computeConsignmentSale({
    commissionType: r.commission_type as Consignment['commissionType'],
    commissionRate: r.commission_rate as number,
    agreedPrice: r.agreed_price as number,
    excessSplitPct: (r.excess_split_pct as number | null) ?? undefined,
  }, 1200);
  ok(econ.payout === 1000 && econ.commission === 200,
    `ECON the reloaded contract pays the agreed price and keeps the excess (${econ.payout}/${econ.commission})`);
}

// 4) Ein zurueckgelesener cost_split rechnet mit SEINEM Anteil, nicht mit einem Standard.
insert('c-split', { commission_type: 'cost_split', excess_split_pct: 70 });
{
  const r = read('c-split');
  const econ = computeConsignmentSale({
    commissionType: r.commission_type as Consignment['commissionType'],
    commissionRate: r.commission_rate as number,
    agreedPrice: r.agreed_price as number,
    excessSplitPct: (r.excess_split_pct as number | null) ?? undefined,
  }, 1200);
  ok(econ.commission === 140 && econ.payout === 1060, `ECON a stored 70% split is used as stored (${econ.commission})`);
}

// 5) Ein historisch gebundener Fall: die Sperre greift, und die gebuchten Zahlen bleiben.
insert('c-sold', {
  commission_type: 'percent', commission_rate: 15, sale_price: 1200, invoice_id: 'inv-9',
  commission_amount: 180, payout_amount: 1020, payout_status: 'paid', payout_paid_amount: 1020, status: 'sold',
});
{
  const r = read('c-sold');
  const con = free({
    id: 'c-sold', salePrice: 1200, invoiceId: 'inv-9', commissionAmount: 180, payoutAmount: 1020,
    payoutStatus: 'paid', payoutPaidAmount: 1020, status: 'sold',
  });
  const lock = payoutModelLock(con);
  ok(lock.locked, 'HISTORY a sold + paid consignment is locked');
  // Der Store schreibt in diesem Fall NICHTS — genau das wird hier nachgestellt.
  if (!lock.locked) applyPatch('c-sold', buildPayoutPatch({ model: 'cost_split', excessSplitPct: '60' }));
  const after = read('c-sold');
  ok(after.commission_type === 'percent' && after.excess_split_pct === null,
    'HISTORY …so the model and its parameters stay exactly as booked');
  ok(after.commission_amount === 180 && after.payout_amount === 1020 && after.sale_price === 1200
    && after.payout_paid_amount === 1020 && after.invoice_id === 'inv-9',
    'HISTORY …and every booked amount is untouched');
  ok(after.updated_at === r.updated_at, 'HISTORY …the row was not even rewritten');
}

// 6) Die Sperre gilt NUR dem Payout — andere Felder bleiben editierbar.
{
  db.prepare('UPDATE consignments SET notes = ?, updated_at = ? WHERE id = ?')
    .run('post-sale note', '2026-03-03T00:00:00.000Z', 'c-sold');
  const after = read('c-sold');
  ok(after.notes === 'post-sale note', 'HISTORY an unrelated field is still editable while the payout is locked');
  ok(after.commission_type === 'percent' && after.commission_amount === 180,
    'HISTORY …and that edit changes nothing about the booked payout');
}

// ── D) Die Erlaubnis gilt IM schreibenden Update, nicht davor ─────────────
//
// Die Pruefung vor dem Schreiben beurteilt einen Zustand, der beim Schreiben ein anderer sein
// kann. Deshalb traegt das UPDATE dieselbe Bedingung in seiner WHERE-Klausel. Hier wird beides
// gegeneinander gehalten — und der gefaehrliche Ablauf einmal komplett durchgespielt.

/** Die WHERE-Bedingung des Stores, gegen dieselbe Zeile gefragt. */
const sqlSaysEditable = (id: string): boolean =>
  (db.prepare(`SELECT COUNT(*) c FROM consignments WHERE id = ? AND ${PAYOUT_EDITABLE_SQL}`)
    .get(id) as { c: number }).c === 1;

/** Das echte UPDATE des Stores — Bedingung inklusive. Gibt zurueck, ob die Zeile getroffen wurde. */
const guardedUpdate = (id: string, patch: { commissionType: string; commissionRate: number; excessSplitPct: number | null }): boolean => {
  const before = read(id);
  db.prepare(
    `UPDATE consignments SET commission_type = ?, commission_rate = ?, excess_split_pct = ?, updated_at = ?
      WHERE id = ? AND ${PAYOUT_EDITABLE_SQL}`
  ).run(patch.commissionType, patch.commissionRate, patch.excessSplitPct, '2026-04-04T00:00:00.000Z', id);
  const after = read(id);
  return after.commission_type === patch.commissionType && (after.excess_split_pct ?? null) === patch.excessSplitPct
    && after.updated_at !== before.updated_at;
};

// Beide Formulierungen derselben Regel muessen fuer JEDEN Fall dasselbe sagen. Sonst gaebe es zwei
// Wahrheiten, und die WHERE-Klausel waere nur Dekoration.
const cases: Array<[string, Partial<Consignment>, Record<string, unknown>]> = [
  ['free', {}, {}],
  ['invoiced', { invoiceId: 'inv-1' }, { invoice_id: 'inv-1' }],
  ['sold price', { salePrice: 1200 }, { sale_price: 1200 }],
  ['commission booked', { commissionAmount: 180 }, { commission_amount: 180 }],
  ['commission booked as 0', { commissionAmount: 0 }, { commission_amount: 0 }],
  ['payout booked', { payoutAmount: 1020 }, { payout_amount: 1020 }],
  ['partly paid', { payoutPaidAmount: 500 }, { payout_paid_amount: 500 }],
  ['zero paid', { payoutPaidAmount: 0 }, { payout_paid_amount: 0 }],
  ['payout partial', { payoutStatus: 'partial' }, { payout_status: 'partial' }],
  ['payout paid', { payoutStatus: 'paid' }, { payout_status: 'paid' }],
  ['payout returned', { payoutStatus: 'returned' }, { payout_status: 'returned' }],
  ['status sold', { status: 'sold' }, { status: 'sold' }],
  ['status paid_out', { status: 'paid_out' }, { status: 'paid_out' }],
  ['status returned', { status: 'returned' }, { status: 'returned' }],
  ['status expired', { status: 'expired' }, { status: 'expired' }],
];
cases.forEach(([label, tsOver, sqlOver], i) => {
  const id = 'agree-' + i;
  insert(id, sqlOver);
  const tsEditable = !payoutModelLock(free(tsOver)).locked;
  ok(sqlSaysEditable(id) === tsEditable,
    `AGREE the rule and the SQL condition agree on "${label}" (${tsEditable ? 'editable' : 'locked'})`);
});

// Der gefaehrliche Ablauf, komplett: Bildschirm offen → Vorpruefung sagt "frei" → INZWISCHEN wird
// verkauft und ausgezahlt → der alte Edit will speichern.
insert('c-stale');
const precheckSaidEditable = !payoutModelLock(free({ id: 'c-stale' })).locked;
ok(precheckSaidEditable, 'STALE the editor legitimately opened on a free consignment');
db.prepare(
  `UPDATE consignments SET invoice_id = ?, sale_price = ?, commission_amount = ?, payout_amount = ?,
     payout_status = ?, payout_paid_amount = ?, status = ?, updated_at = ? WHERE id = ?`
).run('inv-stale', 1200, 180, 1020, 'paid', 1020, 'sold', '2026-03-03T00:00:00.000Z', 'c-stale');
const booked = read('c-stale');
ok(!sqlSaysEditable('c-stale'), 'STALE …meanwhile the sale and the payout were recorded');
ok(guardedUpdate('c-stale', buildPayoutPatch({ model: 'cost_split', excessSplitPct: '60' })) === false,
  'STALE …and the stale save does NOT go through');
{
  const after = read('c-stale');
  ok(after.commission_type === 'percent' && after.excess_split_pct === null,
    'STALE …the payout model is exactly as it was when the amounts were booked');
  ok(after.commission_amount === booked.commission_amount && after.payout_amount === booked.payout_amount
    && after.sale_price === booked.sale_price && after.payout_paid_amount === booked.payout_paid_amount
    && after.invoice_id === booked.invoice_id,
    'STALE …and no booked amount moved');
  ok(after.updated_at === booked.updated_at, 'STALE …the row was not written at all');
}

// Und der gueltige Fall geht durch denselben Weg weiterhin durch.
insert('c-ok');
ok(guardedUpdate('c-ok', buildPayoutPatch({ model: 'cost_split', excessSplitPct: '60' })) === true,
  'STALE a free consignment still saves through the very same guarded update');

// ── E) …und der Store benutzt genau diesen Weg ────────────────────────────
//
// Alles oben waere wertlos, wenn der Store daneben ein nacktes UPDATE abschickte. Deshalb wird
// seine Quelle hier auf die drei Eigenschaften festgenagelt, die den Unterschied ausmachen.
{
  const src = readFileSync(resolvePath(repo, 'src/stores/consignmentStore.ts'), 'utf8');
  const from = src.indexOf('updateConsignmentPayoutModel: (id, input) => {');
  const to = src.indexOf('\n  markSold:', from);
  ok(from > 0 && to > from, 'STORE the payout action was located in the store');
  const fn = src.slice(from, to);
  ok(/SELECT \* FROM consignments WHERE id = \?/.test(fn) && /rowToConsignment/.test(fn),
    'STORE it checks the row it reads FROM THE DATABASE, not the loaded list');
  ok(!/getConsignment\(id\)/.test(fn), 'STORE …and not the in-memory copy, which can lag behind');
  ok(/WHERE id = \? AND \$\{PAYOUT_EDITABLE_SQL\}/.test(fn),
    'STORE the same condition rides along in the WHERE clause of the writing UPDATE');
  ok(/SELECT commission_type, excess_split_pct FROM consignments WHERE id = \?/.test(fn),
    'STORE it reads the row back instead of assuming the write landed');
  const saveAt = fn.indexOf('saveDatabase()');
  const throwAt = fn.lastIndexOf('throw new PayoutPatchError');
  ok(throwAt > 0 && saveAt > throwAt,
    'STORE nothing is persisted, tracked or reloaded before that read-back agreed');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — consignment payout model edit: ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
console.log('CONSIGNMENT_PAYOUT_MODEL_EXISTING_EDIT_PROVED');
